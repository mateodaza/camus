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
const protectedNames = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.camus|\.claude|\.codex|\.qwen|\.grok|\.devin|\.ssh|\.aws|\.azure|node_modules)$/i;
const protectedPart = value => protectedNames.test(value);
const protectedPartRegex = () => protectedNames.source.slice(1, -1).replace(/\(\?:/g, '(')
  .replace(/[a-z]/gi, char => `[${char.toLowerCase()}${char.toUpperCase()}]`);
// Constructed only by host checks BEFORE an effect. Never classify provider prose
// or arbitrary filesystem/permission errors as recoverable.
export class DevinToolFeedback extends Error {
  constructor(code) {
    super(code === 'slice_wrap_up'
      ? 'Camus slice is wrapping up. This NEW host operation was not executed. Stop requesting tools and return the final JSON now: done:false, summary, decision:{action:"continue",reason:"remaining work and next step"} if work remains. No extra calls, actions or time are granted.'
      : code === 'invalid_command'
      ? 'Nothing executed. Supply exactly command (an absolute executable path using letters, digits, _, ., /, + or -) and args (at most 100 strings without NUL); total JSON at most 16384 bytes. Example: {"command":"/usr/bin/env","args":["pnpm","test"]}. Do not put a shell command line in command. The read-only, network-denied sandbox still applies.'
      : code === 'native_write_pending' ? 'Wait for the approved native write to complete before another write or command.'
      : code === 'stale_file' ? 'Read the file again and use its current hash.' : 'Use list_files to choose a prepared file.');
    if (!['stale_file', 'file_not_prepared', 'invalid_command', 'native_write_pending', 'slice_wrap_up'].includes(code)) throw new Error('Invalid Devin feedback.');
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
  hostWritesOnly = false, containedNativeWrites = false, signal, maxFiles = 512, maxFileBytes = 1048576, maxTotalBytes = 8388608 }) {
  if (typeof hostWritesOnly !== 'boolean' || typeof containedNativeWrites !== 'boolean' || hostWritesOnly && containedNativeWrites
      || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 4096
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
  const rePath = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // SBPL #"..." regex literals preserve regex backslashes, unlike ordinary
  // Scheme strings. Do not double them as JSON would for a plain string.
  const sbRegex = value => '#' + JSON.stringify(value).replace(/\\\\/g, '\\');
  const casePath = value => [...rePath(value)].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char).join('');
  const deniedPatterns = [...deniedPaths, ...snapshots.filter(item => item.mode === 'read').map(item => item.path)]
    .map(path => `(regex ${sbRegex('^' + rePath(mirror) + '/' + casePath(path) + '(/|$)')})`).join(' ');
  const protectedPattern = '^' + rePath(mirror) + '/(.*/)?' + protectedPartRegex() + '(/|$)';
  const profile = renderDevinPreflightProfile({ root, harness, candidate: mirror, candidateMetadata: true })
    + `\n(allow file-read-data ${literals([...dirs, ...snapshots.map(item => join(mirror, item.path))])})`
    + (writable.length ? `\n(allow file-write* ${literals(writable.map(item => join(mirror, item.path)))})` : '')
    + (hostWritesOnly ? `\n(deny file-write* (subpath ${JSON.stringify(mirror)}))` : '')
    + (containedNativeWrites ? `\n(allow file-read-data file-write* (subpath ${JSON.stringify(mirror)}))
(deny file-write* (literal ${JSON.stringify(mirror)}) ${deniedPatterns})
(deny file-read* file-write* (regex ${sbRegex(protectedPattern)}))
(deny file-link)
(deny file-write-create (require-all (subpath ${JSON.stringify(mirror)}) (require-not (require-any (vnode-type REGULAR-FILE) (vnode-type DIRECTORY)))))` : '')
    + `\n(deny file-read* file-write* (subpath ${JSON.stringify(candidate)}))`;
  let adopted = false;
  const readHashes = new Map();
  const acceptedHashes = new Map(snapshots.map(item => [item.path, hash(item.bytes ?? Buffer.alloc(0))]));
  const nativeWrites = [], nativeLatest = new Map();
  const checkedName = value => {
    const name = fileName(value), lower = name.toLowerCase();
    if (denied.some(path => lower === path || lower.startsWith(path + '/'))) throw new Error('Devin path is denied.');
    return name;
  };
  const register = name => {
    const item = { path: name, mode: 'create', beforeHash: null, explicitCreation: true };
    snapshots.push(item); paths.add(name.toLowerCase());
    for (let path = dirname(join(mirror, name)); within(mirror, path); path = dirname(path)) {
      dirs.add(path); if (path === mirror) break;
    }
    return item;
  };
  const verifyInventory = async () => {
    const expected = new Set(snapshots.map(item => join(mirror, item.path)));
    const walk = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory() && dirs.has(child)) await walk(child);
        else if (!entry.isFile() || !expected.has(child)) throw Object.assign(new Error('Unexpected staged file or link.'), { reconciliationCode: 'inventory_mismatch' });
      }
    };
    await walk(mirror);
  };
  const workspace = { profile, containedNativeWrites, manifest: Object.freeze(manifest), manifestHash: hash(JSON.stringify(manifest)),
    nativeWriteEvidence() { return { policy: containedNativeWrites ? 'contained-native/v1' : 'host-or-legacy',
      writes: nativeWrites.map(item => ({ ...item })) }; },
    checkedStateHash() { return hash(JSON.stringify(snapshots.map(item => [item.path, acceptedHashes.get(item.path)]))); },
    async reconcileBudgetDeniedTool(tool, beforeHash) {
      if (!containedNativeWrites || adopted || signal?.aborted || tool?.status !== 'failed') throw new Error('Budget denial is not reconcilable.');
      // Caller must hold a host-created, pre-effect refusal record for this ID.
      await workspace.verifyNativeWrites(); await verifyInventory(); await workspace.verifyNativeWrites();
      if (typeof beforeHash !== 'string' || beforeHash !== workspace.checkedStateHash()) throw new Error('Budget-denied tool has prior effects.');
      if (signal?.aborted) throw new Error('Budget reconciliation cancelled.');
      return Object.freeze({ toolCallId: tool.toolCallId, recovery: 'verified_no_effect', operation: 'host_budget_denial',
        checkedStateHash: beforeHash });
    },
    async reconcileDeniedNativeExec(tool) {
      if (!containedNativeWrites || adopted || signal?.aborted || tool?.status !== 'failed'
          || tool?._meta?.['cognition.ai/inferenceToolName'] !== 'exec')
        throw new Error('Native execution failure is not reconcilable.');
      // This workspace's host-authored SBPL denies process-fork and allows
      // process-exec only for the initial pinned harness. Native shell commands
      // cannot start. The adapter additionally verifies the exact deny config.
      // Do not use error strings or mere unchanged target bytes as that proof.
      await workspace.verifyNativeWrites();
      await verifyInventory();
      await workspace.verifyNativeWrites();
      if (signal?.aborted) throw new Error('Native failure reconciliation cancelled.');
      return Object.freeze({ toolCallId: tool.toolCallId, recovery: 'verified_no_effect',
        operation: 'exec', executionPrevented: true, profileHash: hash(profile),
        checkedStateHash: hash(JSON.stringify(snapshots.map(item => [item.path, acceptedHashes.get(item.path)]))) });
    },
    async reconcileFailedNativeWrite(tool) {
      // A failed terminal event is not proof of no effect. The caller serializes
      // this check with host work and refuses overlapping native operations.
      if (!containedNativeWrites || adopted || signal?.aborted || tool?.status !== 'failed'
          || !['edit', 'write'].includes(tool?._meta?.['cognition.ai/inferenceToolName']))
        throw new Error('Native failure is not reconcilable.');
      const name = workspace.hostPath(tool.rawInput?.file_path);
      const grant = nativeWrites.find(item => item.toolCallId === tool.toolCallId);
      if (grant && (grant.path !== name || nativeLatest.get(name) !== grant || grant.noEffectVerified))
        throw new Error('Native failure grant is not current.');
      // Only the exact pre-write state is recoverable. Even a fully applied
      // output reported as failed is not silently promoted to a successful edit.
      const state = await workspace.writeState(name);
      if (state.sha256 !== (grant ? grant.beforeHash : acceptedHashes.get(name) ?? null))
        throw Object.assign(new Error('Failed native write has uncertain effects.'), { reconciliationCode: 'target_changed' });
      await workspace.verifyNativeWrites({ allowPendingPath: grant ? name : null });
      await verifyInventory();
      if ((await workspace.writeState(name)).sha256 !== state.sha256)
        throw new Error('Failed native write changed during reconciliation.');
      if (signal?.aborted) throw new Error('Native failure reconciliation cancelled.');
      if (grant) {
        acceptedHashes.set(name, grant.beforeHash);
        nativeLatest.delete(name);
        readHashes.delete(name);
        grant.noEffectVerified = true;
        if (grant.beforeHash === null) {
          // An approved but never-created file must not become a phantom input.
          const index = snapshots.findIndex(item => item.path === name);
          snapshots.splice(index, 1); paths.delete(name.toLowerCase()); acceptedHashes.delete(name);
        }
      }
      return Object.freeze({ toolCallId: tool.toolCallId, recovery: 'verified_no_effect', path: name,
        unchangedHash: state.sha256,
        checkedStateHash: hash(JSON.stringify(snapshots.map(item => [item.path, acceptedHashes.get(item.path)]))) });
    },
    async verifyNativeWrites({ allowPendingPath = null } = {}) {
      if (!containedNativeWrites) return;
      let totalBytes = 0;
      for (const item of snapshots) {
        const bytes = await readBounded(mirror, item.path, maxFileBytes, item.explicitCreation === true);
        totalBytes += bytes?.length ?? 0;
        const actual = bytes === null ? null : hash(bytes), expected = acceptedHashes.get(item.path);
        if (actual !== expected) {
          const pending = nativeLatest.get(item.path);
          if (pending && actual === pending.beforeHash) {
            if (allowPendingPath === item.path) continue;
            throw new DevinToolFeedback('native_write_pending');
          }
          throw Object.assign(new Error('Staged content does not match an approved write.'), { reconciliationCode: 'approved_write_mismatch' });
        }
      }
      if (totalBytes > maxTotalBytes) throw new Error('Staged byte envelope exceeded.');
    },
    async authorizeNativeWrite(tool, state) {
      if (!containedNativeWrites) return;
      if (signal?.aborted) throw new Error('Native write cancelled before permission.');
      await workspace.verifyNativeWrites();
      const name = checkedName(tool.rawInput.file_path.slice(mirror.length + 1));
      const current = await workspace.writeState(name);
      if (state.target !== current.target || state.sha256 !== current.sha256) throw new Error('Native write base changed.');
      const input = tool.rawInput, kind = tool._meta['cognition.ai/inferenceToolName'];
      let content = input.content;
      if (kind === 'edit') {
        const before = (await workspace.readText(name)).content;
        const parts = before.split(input.old_string);
        if (parts.length === 1 || !input.replace_all && parts.length !== 2) throw new DevinToolFeedback('stale_file');
        content = parts.join(input.new_string);
      }
      if (typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes) throw new Error('Native write exceeds file envelope.');
      let projected = Buffer.byteLength(content);
      for (const item of snapshots) if (item.path !== name) projected += (await readBounded(mirror, item.path, maxFileBytes)).length;
      if (projected > maxTotalBytes) throw new Error('Native write exceeds total envelope.');
      if (!snapshots.some(item => item.path === name)) register(name);
      const receipt = { toolCallId: tool.toolCallId, path: name, beforeHash: current.sha256, afterHash: hash(Buffer.from(content)) };
      nativeWrites.push(receipt); nativeLatest.set(name, receipt); acceptedHashes.set(name, receipt.afterHash);
      readHashes.set(name, current.sha256);
      return Object.freeze({ ...receipt });
    },
    hostPath(value) {
      if (typeof value !== 'string' || resolve(value) !== value || !value.startsWith(mirror + sep))
        throw new Error('Devin delegated path is outside staging.');
      return checkedName(value.slice(mirror.length + 1));
    },
    async writeState(value) {
      const name = checkedName(value), lower = name.toLowerCase(), item = snapshots.find(item => item.path === name);
      if (adopted || item?.mode === 'read') throw new Error('Devin write is not authorized.');
      if (!item && (snapshots.length >= maxFiles
          || [...paths].some(path => lower === path || lower.startsWith(path + '/') || path.startsWith(lower + '/'))
          || await readBounded(candidate, name, maxFileBytes, true) !== null))
        throw new Error('Devin creation is not an unused permitted path.');
      const bytes = await readBounded(mirror, name, maxFileBytes, !item || containedNativeWrites && item.explicitCreation === true);
      if (!item && bytes !== null) throw new Error('Untracked staged file refused.');
      return { target: join(mirror, name), sha256: bytes === null ? null : hash(bytes) };
    },
    async writeDelegated({ path, content }) {
      if (!hostWritesOnly && !containedNativeWrites) throw new Error('Delegated writes require a checked write policy.');
      const name = checkedName(path), state = await workspace.writeState(name);
      const item = snapshots.find(item => item.path === name);
      // ACP has no expected-hash field. Bind to the last checked read, or the
      // original snapshot for a first write. Never silently refresh a stale base.
      const initialHash = item?.mode === 'create' && !item.explicitCreation ? hash(Buffer.alloc(0)) : item?.beforeHash ?? null;
      const expectedSha256 = readHashes.has(name) ? readHashes.get(name) : initialHash;
      if (expectedSha256 !== state.sha256) throw new DevinToolFeedback('stale_file');
      return workspace.writeText({ path: name, content, expectedSha256 });
    },
    rememberWriteBase(path, sha256) {
      if (adopted || (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))))
        throw new Error('Invalid delegated write base.');
      readHashes.set(checkedName(path), sha256);
    },
    listFiles() { return snapshots.map(item => ({ path: item.path, writable: item.mode !== 'read' })); },
    async readText(value) {
      const name = fileName(value), item = snapshots.find(item => item.path === name);
      if (denied.some(path => name.toLowerCase() === path || name.toLowerCase().startsWith(path + '/')))
        throw new Error('Devin read path is denied.');
      if (!item) throw new DevinToolFeedback('file_not_prepared');
      const bytes = await readBounded(mirror, name, maxFileBytes, containedNativeWrites && item.explicitCreation === true);
      if (bytes === null) throw new DevinToolFeedback('file_not_prepared');
      if (containedNativeWrites && hash(bytes) !== acceptedHashes.get(name)
          && hash(bytes) !== nativeLatest.get(name)?.beforeHash) throw new Error('Unapproved staged read.');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new Error('Devin text tools refuse non-UTF-8 files.');
      readHashes.set(name, hash(bytes));
      return { content: text, sha256: hash(bytes) };
    },
    async writeText({ path, content, expectedSha256 }) {
      const name = fileName(path), lower = name.toLowerCase();
      if (adopted || typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes)
        throw new Error('Invalid Devin text write.');
      await workspace.writeState(name);
      if (containedNativeWrites) {
        await workspace.verifyNativeWrites({ allowPendingPath: name });
        const grant = nativeLatest.get(name), state = await workspace.writeState(name);
        if (grant && state.sha256 !== acceptedHashes.get(name) && hash(Buffer.from(content)) !== grant.afterHash)
          throw new Error('Delegated write conflicts with the approved native operation.');
      }
      // Both transport paths share the byte envelope before performing effects.
      let projectedBytes = Buffer.byteLength(content);
      for (const existing of snapshots) if (existing.path !== name)
        projectedBytes += (await readBounded(mirror, existing.path, maxFileBytes)).length;
      if (projectedBytes > maxTotalBytes) throw new Error('Staged byte envelope exceeded.');
      if (signal?.aborted) throw new Error('Devin write cancelled before effects.');
      let item = snapshots.find(item => item.path === name);
      if (!item || containedNativeWrites && item.explicitCreation === true && await readBounded(mirror, name, maxFileBytes, true) === null) {
        if (expectedSha256 !== null || !item && (snapshots.length >= maxFiles
            || denied.some(path => lower === path || lower.startsWith(path + '/'))
            || [...paths].some(path => lower === path || lower.startsWith(path + '/') || path.startsWith(lower + '/'))
            || await readBounded(candidate, name, maxFileBytes, true) !== null))
          throw new Error('Devin creation is not an unused permitted path.');
        await mkdir(dirname(join(mirror, name)), { recursive: true, mode: 0o700 });
        if (await realpath(dirname(join(mirror, name))) !== dirname(join(mirror, name))) throw new Error('Linked staged parent refused.');
        if (signal?.aborted) throw new Error('Devin write cancelled before effects.');
        await writeFile(join(mirror, name), content, { flag: 'wx', mode: 0o600 });
        item ??= register(name);
      } else {
        const before = await readBounded(mirror, name, maxFileBytes);
        if (item.mode === 'read') throw new Error('Devin write is read-only.');
        if (hash(before) !== expectedSha256) throw new DevinToolFeedback('stale_file');
        if (signal?.aborted) throw new Error('Devin write cancelled before effects.');
        await writeFile(join(mirror, name), content);
        if (item.mode === 'create') item.explicitCreation = true;
      }
      readHashes.delete(name);
      if (containedNativeWrites) acceptedHashes.set(name, hash(Buffer.from(content)));
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
      await workspace.verifyNativeWrites();
      // Read every staged entry, rejecting extra entries before returning changes.
      await verifyInventory();
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
