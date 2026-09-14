import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDevinWorkspace } from './devin-native-workspace.mjs';
import { runNativeProcess } from './native-process.mjs';
import { devinIsolatedEnvironment } from './devin-native-preflight.mjs';

async function fixture(fn) {
  const dirs = [];
  try {
    for (const label of ['candidate', 'mirror', 'auth', 'outside'])
      dirs.push(await realpath(await mkdtemp(join(tmpdir(), `camus-devin-project-${label}-`))));
    const [candidate, mirror, root, outside] = dirs;
    await mkdir(join(candidate, 'src'));
    await writeFile(join(candidate, 'src/a.mjs'), 'old');
    await writeFile(join(candidate, 'test.mjs'), 'frozen');
    await writeFile(join(outside, 'secret'), 'synthetic');
    await fn({ candidate, mirror, root, outside, harness: await realpath(process.execPath),
      files: [{ path: 'src/a.mjs', mode: 'write' }, { path: 'test.mjs', mode: 'read' }, { path: 'new/b.mjs', mode: 'create' }] });
  } finally { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); }
}

test('explicit nested read/write/create manifest preserves the source and returns unadopted changes', () => fixture(async options => {
  const workspace = await createDevinWorkspace(options);
  assert.deepEqual(await readdir(options.mirror), ['new', 'src', 'test.mjs']);
  await assert.rejects(workspace.inspect(), /Stop all/);
  assert.throws(() => workspace.mapPath('test.mjs', { writable: true }));
  assert.throws(() => workspace.mapPath('../outside'));
  assert.equal(workspace.mapPath('src/a.mjs', { writable: true }), join(options.mirror, 'src/a.mjs'));
  await writeFile(join(options.mirror, 'src/a.mjs'), 'changed');
  await writeFile(join(options.mirror, 'new/b.mjs'), 'new');
  const result = await workspace.inspect({ writersStopped: true });
  assert.equal(result.adopted, false); assert.equal(result.candidateModified, false);
  assert.equal(result.changes.length, 2); assert.equal(result.changes[1].beforeHash, null);
  assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'old');
}));

test('unsafe, colliding, protected and oversized manifests fail before copying', () => fixture(async options => {
  for (const path of ['../escape', '/absolute', '.env', 'x/.GIT/config', 'x\\file', 'x//file', 'x/./file'])
    await assert.rejects(createDevinWorkspace({ ...options, files: [{ path, mode: 'create' }] }));
  for (const files of [[{ path: 'Foo', mode: 'create' }, { path: 'foo', mode: 'create' }],
    [{ path: 'x', mode: 'create' }, { path: 'x/y', mode: 'create' }]])
    await assert.rejects(createDevinWorkspace({ ...options, files }));
  await assert.rejects(createDevinWorkspace({ ...options, deniedPaths: ['src'] }));
  await assert.rejects(createDevinWorkspace({ ...options, maxFileBytes: 2 }));
  await assert.rejects(createDevinWorkspace({ ...options, maxTotalBytes: 2 }));
  await assert.rejects(createDevinWorkspace({ ...options, mirror: options.root }));
  assert.deepEqual(await readdir(options.mirror), []);
}));

test('symlink parents, symlink files and hard links cannot enter staging', () => fixture(async options => {
  await symlink(options.outside, join(options.candidate, 'linked'));
  await assert.rejects(createDevinWorkspace({ ...options, files: [{ path: 'linked/secret', mode: 'read' }] }));
  await symlink(join(options.outside, 'secret'), join(options.candidate, 'alias'));
  await assert.rejects(createDevinWorkspace({ ...options, files: [{ path: 'alias', mode: 'read' }] }));
  await link(join(options.outside, 'secret'), join(options.candidate, 'hard'));
  await assert.rejects(createDevinWorkspace({ ...options, files: [{ path: 'hard', mode: 'read' }] }));
  assert.deepEqual(await readdir(options.mirror), []);
}));

test('special files are rejected without opening a blocking stream', { skip: process.platform === 'win32', timeout: 2000 }, () => fixture(async options => {
  execFileSync('/usr/bin/mkfifo', [join(options.candidate, 'pipe')]);
  await assert.rejects(createDevinWorkspace({ ...options, files: [{ path: 'pipe', mode: 'read' }] }), /Unsafe/);
  assert.deepEqual(await readdir(options.mirror), []);
}));

test('inspection rejects source drift, frozen edits, extra files, deletion and size growth', () => fixture(async options => {
  const workspace = await createDevinWorkspace(options), inspect = () => workspace.inspect({ writersStopped: true });
  await writeFile(join(options.candidate, 'src/a.mjs'), 'drift'); await assert.rejects(inspect(), /drifted/);
  await writeFile(join(options.candidate, 'src/a.mjs'), 'old');
  await writeFile(join(options.mirror, 'test.mjs'), 'tampered'); await assert.rejects(inspect(), /Read-only/);
  await writeFile(join(options.mirror, 'test.mjs'), 'frozen');
  await writeFile(join(options.mirror, 'extra'), 'extra'); await assert.rejects(inspect(), /Unexpected/);
  await rm(join(options.mirror, 'extra'));
  await writeFile(join(options.mirror, 'src/a.mjs'), 'x'.repeat(1048577)); await assert.rejects(inspect(), /Unsafe/);
  await rm(join(options.mirror, 'src/a.mjs')); await assert.rejects(inspect());
}));

test('checked host creation and adoption require current hashes and stopped writers', () => fixture(async options => {
  const workspace = await createDevinWorkspace(options);
  const before = await workspace.readText('src/a.mjs');
  await assert.rejects(workspace.writeText({ path: 'src/a.mjs', content: 'new', expectedSha256: 'wrong' }));
  await workspace.writeText({ path: 'src/a.mjs', content: 'new', expectedSha256: before.sha256 });
  await workspace.writeText({ path: 'another/new.mjs', content: '', expectedSha256: null });
  await assert.rejects(workspace.writeText({ path: 'another/new.mjs', content: 'overwrite', expectedSha256: null }));
  await assert.rejects(workspace.writeText({ path: '.env', content: 'secret', expectedSha256: null }));
  await assert.rejects(workspace.adopt());
  const result = await workspace.adopt({ writersStopped: true });
  assert.equal(result.stagedAdopted, true); assert.equal(result.userAcceptanceGranted, false);
  assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'new');
  assert.equal(await readFile(join(options.candidate, 'another/new.mjs'), 'utf8'), '');
  await assert.rejects(workspace.adopt({ writersStopped: true }), /already consumed/);
}));

test('real native staging sandbox allows only declared files, denies source, private files and fork',
  { skip: process.platform !== 'darwin', timeout: 10000 }, () => fixture(async options => {
    const workspace = await createDevinWorkspace(options);
    const script = `const f=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);
a.equal(f.readFileSync('test.mjs','utf8'),'frozen'); a.ok(f.readdirSync('.').includes('src'));
f.writeFileSync('src/a.mjs','changed'); f.writeFileSync('new/b.mjs','created');
for(const path of ['test.mjs','extra',${JSON.stringify(join(options.candidate, 'src/a.mjs'))}]) a.throws(()=>f.writeFileSync(path,'tamper'),denied);
for(const path of ${JSON.stringify([join(options.candidate, 'src/a.mjs'), join(options.outside, 'secret')])}) a.throws(()=>f.readFileSync(path),denied);
a.throws(()=>cp.execFileSync('/bin/sh',['-c','exit 0'],{stdio:'ignore'}));
console.log('isolated');`;
    const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec',
      args: ['-p', workspace.profile, options.harness, '-e', script], cwd: options.mirror,
      env: devinIsolatedEnvironment(options.root), timeoutMs: 5000, maxBytes: 2048 });
    assert.equal(result.code, 0); assert.match(result.stdout, /isolated/);
    assert.equal((await workspace.inspect({ writersStopped: true })).changes.length, 2);
  }));
