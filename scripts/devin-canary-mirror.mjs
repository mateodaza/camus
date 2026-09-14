// Disposable compatibility fixture only; not a production workspace projector.
import { lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { renderDevinPreflightProfile } from '../apps/loop-studio/lib/devin-native-preflight.mjs';

const files = Object.freeze(['calc.mjs', 'acceptance.test.mjs']);
const within = (a, b) => b === a || b.startsWith(a + sep);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createDevinCanaryMirror({ candidate, mirror, root, harness, nativeWritableFixture = false }) {
  if (typeof nativeWritableFixture !== 'boolean') throw new Error('Invalid native fixture policy.');
  for (const path of [candidate, mirror, root]) {
    if (typeof path !== 'string' || path === '/' || resolve(path) !== path
        || await realpath(path) !== path || !(await lstat(path)).isDirectory())
      throw new Error('Mirror requires canonical owned fixture directories.');
    const stat = await lstat(path);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077))
      throw new Error('Mirror directories must be private and owned.');
  }
  for (const [a, b] of [[candidate, mirror], [candidate, root], [mirror, root]])
    if (within(a, b) || within(b, a)) throw new Error('Mirror, candidate and authentication roots must be separate.');
  if ((await readdir(mirror)).length) throw new Error('Mirror must start empty.');
  // Validate both before copying either. No repository traversal or config copy.
  const snapshots = [];
  for (const name of files) {
    const path = join(candidate, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
        || info.size > 8192 || await realpath(path) !== path)
      throw new Error('Mirror source is not a bounded unlinked fixture.');
    const bytes = await readFile(path);
    if (bytes.length > 8192) throw new Error('Mirror source exceeded its envelope.');
    snapshots.push({ name, bytes });
  }
  for (const { name, bytes } of snapshots)
    await writeFile(join(mirror, name), bytes, { flag: 'wx', mode: 0o600 });
  const profile = renderDevinPreflightProfile({ root, harness, candidate: mirror, candidateMetadata: true })
    + `\n(allow file-read-data ${files.map(name => `(literal ${JSON.stringify(join(mirror, name))})`).join(' ')})`
    + (nativeWritableFixture ? `\n(allow file-write* (literal ${JSON.stringify(join(mirror, 'calc.mjs'))}))` : '')
    + `\n(deny file-read* file-write* (subpath ${JSON.stringify(candidate)}))`;
  return Object.freeze({ profile,
    manifest: Object.freeze(snapshots.map(({ name, bytes }) => Object.freeze({ name, hash: hash(bytes) }))),
    mapPath(path) {
      if (typeof path !== 'string') throw new Error('Invalid mirrored fixture path.');
      const resolved = resolve(mirror, path);
      const name = files.find(name => join(mirror, name) === resolved);
      if (!name) throw new Error('Path is not an approved mirrored fixture.');
      return join(candidate, name);
    },
  });
}
