// Shared preparation for the optional Devin executor. This is NOT admission or
// adoption: callers provide an explicit file manifest and stop every writer
// before inspecting the staged result. No repository/config discovery occurs.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { renderDevinPreflightProfile } from './devin-native-preflight.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (a, b) => b === a || b.startsWith(a + sep);
const protectedPart = value => /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.camus|\.claude|\.codex|\.qwen|\.grok|\.devin|\.ssh|\.aws|\.azure|node_modules)$/i.test(value);
// Constructed only by host checks BEFORE an effect. Never classify provider prose
// or arbitrary filesystem/permission errors as recoverable.
export class DevinToolFeedback extends Error {
  constructor(code) {
    super(code === 'invalid_command'
      ? 'Nothing executed. Supply exactly command (an absolute executable path using letters, digits, _, ., /, + or -) and args (at most 100 strings without NUL); total JSON at most 16384 bytes. Example: {"command":"/usr/bin/env","args":["pnpm","test"]}. Do not put a shell command line in command. The read-only, network-denied sandbox still applies.'
      : code === 'stale_file' ? 'Read the file again and use its current hash.' : 'Use list_files to choose a prepared file.');
    if (!['stale_file', 'file_not_prepared', 'invalid_command'].includes(code)) throw new Error('Invalid Devin feedback.');
    this.code = code;
  }
}
function fileName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.normalize('NFC')
      || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..' || protectedPart(part)))
    throw new Error('Devin manifest contains an unsafe or protected path.');
  return value;
}
export function isDevinVisiblePath(value) {
  try { fileName(value); return true; } catch { return false; }
}
async function ownedRoot(path, privateRoot) {
  if (typeof path !== 'string' || path === '/' || resolve(path) !== path || await realpath(path) !== path)
    throw new Error('Devin workspace roots must be canonical.');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & (privateRoot ? 0o077 : 0o022)))
    throw new Error('Devin workspace root ownership or permissions are unsafe.');
}
async function readBounded(root, name, maxBytes, absent = false) {
  const parts = name.split('/');
  for (let n = 1; n < parts.length; n++) {
    try {
      const stat = await lstat(join(root, ...parts.slice(0, n)));
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022))
        throw new Error('Linked or unsafe workspace parent refused.');
    } catch (error) { if (absent && error.code === 'ENOENT') return null; throw error; }
  }
  const path = join(root, name);
  let handle;
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.uid !== process.getuid()
        || (initial.mode & 0o022) || initial.size > maxBytes) throw new Error('Unsafe workspace file.');
    // O_NONBLOCK also protects against replacement with a FIFO between lstat
    // and open. It has no effect on regular-file reads.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > maxBytes
        || before.ino !== initial.ino || before.dev !== initial.dev || (before.mode & 0o022)
        || await realpath(path) !== path) throw new Error('Unsafe workspace file.');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || !named.isFile() || named.nlink !== 1
        || named.ino !== before.ino || named.dev !== before.dev)
      throw new Error('Workspace file changed during snapshot.');
    return bytes.subarray(0, size);
  } catch (error) { if (absent && error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

export async function createDevinWorkspace({ candidate, mirror, root, harness, files, deniedPaths = [],
  maxFiles = 512, maxFileBytes = 1048576, maxTotalBytes = 8388608 }) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 4096
      || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 4194304
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 67108864
      || !Array.isArray(files) || !files.length || files.length > maxFiles || !Array.isArray(deniedPaths))
    throw new Error('Invalid bounded Devin workspace manifest.');
  await ownedRoot(candidate, false); await ownedRoot(mirror, true); await ownedRoot(root, true);
  for (const [a, b] of [[candidate, mirror], [candidate, root], [mirror, root]])
    if (within(a, b) || within(b, a)) throw new Error('Devin workspace and authentication roots overlap.');
  if ((await readdir(mirror)).length) throw new Error('Devin staging must start empty.');
  // Protected names are refused outright; caller-supplied denied paths may also
  // name protected names, and are checked as prefixes without exposing content.
  const denied = deniedPaths.map(path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
        || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid denied path.');
    return path.toLowerCase();
  });
  const paths = new Set(), snapshots = [], dirs = new Set([mirror]);
  let total = 0;
  for (const entry of files) {
    if (!entry || Object.keys(entry).some(key => !['path', 'mode'].includes(key))
        || !['read', 'write', 'create'].includes(entry.mode)) throw new Error('Invalid Devin manifest entry.');
    const name = fileName(entry.path), lower = name.toLowerCase();
    if (denied.some(path => lower === path || lower.startsWith(path + '/'))
        || [...paths].some(path => lower === path || lower.startsWith(path + '/') || path.startsWith(lower + '/')))
      throw new Error('Conflicting or denied Devin manifest path.');
    paths.add(lower);
    const bytes = await readBounded(candidate, name, maxFileBytes, entry.mode === 'create');
    if (entry.mode === 'create' && bytes !== null) throw new Error('Create path already exists.');
    total += bytes?.length ?? 0;
    if (total > maxTotalBytes) throw new Error('Devin workspace exceeds the byte envelope.');
    snapshots.push({ path: name, mode: entry.mode, beforeHash: bytes === null ? null : hash(bytes), bytes,
      fileMode: bytes === null ? 0o600 : 0o600 | ((await lstat(join(candidate, name))).mode & 0o111) });
    for (let path = dirname(join(mirror, name)); within(mirror, path); path = dirname(path)) {
      dirs.add(path); if (path === mirror) break;
    }
  }
  // All source entries pass validation before copying any content.
  for (const item of snapshots) {
    await mkdir(dirname(join(mirror, item.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(mirror, item.path), item.bytes ?? Buffer.alloc(0), { flag: 'wx', mode: item.fileMode });
  }
  const manifest = snapshots.map(({ path, mode, beforeHash }) => Object.freeze({ path, mode, beforeHash }));
  const writable = snapshots.filter(item => item.mode !== 'read');
  const literals = paths => paths.map(path => `(literal ${JSON.stringify(path)})`).join(' ');
  const profile = renderDevinPreflightProfile({ root, harness, candidate: mirror, candidateMetadata: true })
    + `\n(allow file-read-data ${literals([...dirs, ...snapshots.map(item => join(mirror, item.path))])})`
    + (writable.length ? `\n(allow file-write* ${literals(writable.map(item => join(mirror, item.path)))})` : '')
    + `\n(deny file-read* file-write* (subpath ${JSON.stringify(candidate)}))`;
  let adopted = false;
  const workspace = { profile, manifest: Object.freeze(manifest), manifestHash: hash(JSON.stringify(manifest)),
    listFiles() { return snapshots.map(item => ({ path: item.path, writable: item.mode !== 'read' })); },
    async readText(value) {
      const name = fileName(value), item = snapshots.find(item => item.path === name);
      if (denied.some(path => name.toLowerCase() === path || name.toLowerCase().startsWith(path + '/')))
        throw new Error('Devin read path is denied.');
      if (!item) throw new DevinToolFeedback('file_not_prepared');
      const bytes = await readBounded(mirror, name, maxFileBytes);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new Error('Devin text tools refuse non-UTF-8 files.');
      return { content: text, sha256: hash(bytes) };
    },
    async writeText({ path, content, expectedSha256 }) {
      const name = fileName(path), lower = name.toLowerCase();
      if (adopted || typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes)
        throw new Error('Invalid Devin text write.');
      let item = snapshots.find(item => item.path === name);
      if (!item) {
        if (expectedSha256 !== null || snapshots.length >= maxFiles
            || denied.some(path => lower === path || lower.startsWith(path + '/'))
            || [...paths].some(path => lower === path || lower.startsWith(path + '/') || path.startsWith(lower + '/'))
            || await readBounded(candidate, name, maxFileBytes, true) !== null)
          throw new Error('Devin creation is not an unused permitted path.');
        await mkdir(dirname(join(mirror, name)), { recursive: true, mode: 0o700 });
        if (await realpath(dirname(join(mirror, name))) !== dirname(join(mirror, name))) throw new Error('Linked staged parent refused.');
        await writeFile(join(mirror, name), content, { flag: 'wx', mode: 0o600 });
        item = { path: name, mode: 'create', beforeHash: null, explicitCreation: true };
        snapshots.push(item); paths.add(lower);
        for (let path = dirname(join(mirror, name)); within(mirror, path); path = dirname(path)) {
          dirs.add(path); if (path === mirror) break;
        }
      } else {
        const before = await readBounded(mirror, name, maxFileBytes);
        if (item.mode === 'read') throw new Error('Devin write is read-only.');
        if (hash(before) !== expectedSha256) throw new DevinToolFeedback('stale_file');
        await writeFile(join(mirror, name), content);
      }
      return { sha256: hash(Buffer.from(content)) };
    },
    mapPath(value, { writable = false } = {}) {
      if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid Devin workspace path.');
      const target = resolve(mirror, value), item = snapshots.find(item => join(mirror, item.path) === target);
      if (!item || writable && item.mode === 'read') throw new Error('Devin path is not authorized.');
      return target;
    },
    async inspect({ writersStopped = false } = {}) {
      if (writersStopped !== true) throw new Error('Stop all staging writers before inspection.');
      // Read every staged entry, rejecting extra entries before returning changes.
      const expected = new Set(snapshots.map(item => join(mirror, item.path)));
      const walk = async path => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory() && dirs.has(child)) await walk(child);
          else if (!entry.isFile() || !expected.has(child)) throw new Error('Unexpected staged file or link.');
        }
      };
      await walk(mirror);
      const changes = []; let bytesTotal = 0;
      for (const item of snapshots) {
        const baseline = await readBounded(candidate, item.path, maxFileBytes, item.mode === 'create');
        if ((baseline === null ? null : hash(baseline)) !== item.beforeHash) throw new Error('Source candidate drifted.');
        const bytes = await readBounded(mirror, item.path, maxFileBytes);
        bytesTotal += bytes.length;
        if (bytesTotal > maxTotalBytes) throw new Error('Staged byte envelope exceeded.');
        const afterHash = hash(bytes);
        if (item.mode === 'read' && afterHash !== item.beforeHash) throw new Error('Read-only input changed.');
        if (item.mode !== 'read' && afterHash !== item.beforeHash
            && !(item.mode === 'create' && !item.explicitCreation && bytes.length === 0))
          changes.push({ path: item.path, beforeHash: item.beforeHash, afterHash, bytes });
      }
      return { manifestHash: hash(JSON.stringify(manifest)), changes, candidateModified: false, adopted: false };
    },
    async adopt({ writersStopped = false } = {}) {
      if (adopted) throw new Error('Staged changes already consumed.');
      const inspected = await workspace.inspect({ writersStopped });
      adopted = true; // A partial host failure is never automatically replayed.
      for (const change of inspected.changes) {
        const target = join(candidate, change.path);
        const parent = dirname(target);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        if (await realpath(parent) !== parent) throw new Error('Candidate parent changed.');
        if (change.beforeHash === null) await writeFile(target, change.bytes, { flag: 'wx', mode: 0o600 });
        else {
          const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > maxFileBytes
                || hash(await handle.readFile()) !== change.beforeHash) throw new Error('Candidate changed before staged adoption.');
            await handle.truncate(0);
            for (let written = 0; written < change.bytes.length;) {
              const next = await handle.write(change.bytes, written, change.bytes.length - written, written);
              if (!next.bytesWritten) throw new Error('Incomplete candidate write.');
              written += next.bytesWritten;
            }
            await handle.sync();
          } finally { await handle.close(); }
        }
      }
      return { changedPaths: inspected.changes.map(change => change.path), stagedAdopted: true,
        userAcceptanceGranted: false, manifestHash: inspected.manifestHash };
    },
  };
  return Object.freeze(workspace);
}
