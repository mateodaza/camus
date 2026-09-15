import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDevinWorkspace, DevinToolFeedback } from './devin-native-workspace.mjs';
import { runNativeProcess } from './native-process.mjs';
import { devinIsolatedEnvironment } from './devin-native-preflight.mjs';
import { createDevinFileHandlers, DEVIN_CLIENT_CAPABILITIES } from './devin-native-files.mjs';

async function nativePermission(workspace, options, id, path, input) {
  const tool = { toolCallId: id, kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': input.content === undefined ? 'edit' : 'write' },
    rawInput: { file_path: join(options.mirror, path), ...input } };
  const handlers = createDevinFileHandlers({ workspace, cwd: options.mirror, sessionId: () => 's',
    calls: new Map([[id, tool]]), permissions: new Set() });
  return handlers['session/request_permission']({ sessionId: 's', toolCall: { toolCallId: id }, options: [{ kind: 'allow_once', optionId: 'once' }] });
}

test('budget-denied tool requires unchanged checked state since that tool started', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true });
  const before = workspace.checkedStateHash();
  const tool = { toolCallId: 'denied-read', status: 'failed' };
  assert.equal((await workspace.reconcileBudgetDeniedTool(tool, before)).operation, 'host_budget_denial');
  await workspace.writeText({ path: 'src/a.mjs', content: 'changed', expectedSha256: (await workspace.readText('src/a.mjs')).sha256 });
  await assert.rejects(workspace.reconcileBudgetDeniedTool(tool, before), /prior effects/);
}));

for (const creation of [false, true]) test(`failed native ${creation ? 'creation' : 'edit'} with unchanged bytes revokes only its pending grant`, () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true });
  const path = creation ? 'nested/retry.mjs' : 'src/a.mjs';
  await nativePermission(workspace, options, 'failed', path, { content: 'new' });
  const receipt = await workspace.reconcileFailedNativeWrite({ toolCallId: 'failed', status: 'failed',
    _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: join(options.mirror, path) } });
  assert.equal(receipt.recovery, 'verified_no_effect');
  assert.equal(workspace.nativeWriteEvidence().writes[0].noEffectVerified, true);
  await workspace.inspect({ writersStopped: true });
  await nativePermission(workspace, options, 'corrected', path, { content: 'corrected' });
  if (creation) await mkdir(join(options.mirror, 'nested'), { recursive: true });
  await writeFile(join(options.mirror, path), 'corrected');
  await workspace.adopt({ writersStopped: true });
  assert.equal(await readFile(join(options.candidate, path), 'utf8'), 'corrected');
}));

for (const effect of ['partial', 'applied', 'extra', 'other-file', 'symlink']) test(`native failure with ${effect} effects is not recoverable`, () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true });
  await nativePermission(workspace, options, 'bad', 'src/a.mjs', { content: 'approved' });
  if (effect === 'partial' || effect === 'applied') await writeFile(join(options.mirror, 'src/a.mjs'), effect === 'partial' ? 'part' : 'approved');
  if (effect === 'extra') await writeFile(join(options.mirror, 'extra'), 'x');
  if (effect === 'other-file') await writeFile(join(options.mirror, 'test.mjs'), 'x');
  if (effect === 'symlink') { await rm(join(options.mirror, 'src/a.mjs')); await symlink(options.outside, join(options.mirror, 'src/a.mjs')); }
  await assert.rejects(workspace.reconcileFailedNativeWrite({ toolCallId: 'bad', status: 'failed',
    _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: join(options.mirror, 'src/a.mjs') } }));
  assert.equal(workspace.nativeWriteEvidence().writes[0].noEffectVerified, undefined);
  assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'old');
}));

test('contained native edit and nested creation execute in the real sandbox, then adopt only approved bytes',
  { skip: process.platform !== 'darwin', timeout: 10000 }, () => fixture(async options => {
    const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true, deniedPaths: ['private'] });
    const run = async script => {
      const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', workspace.profile, options.harness, '-e', `try {${script}} catch(error) { console.log(error.stack); process.exit(1); }`],
        cwd: options.mirror, env: devinIsolatedEnvironment(options.root), timeoutMs: 5000, maxBytes: 3000 });
      if (result.code === 65) execFileSync('/usr/bin/sandbox-exec', ['-p', workspace.profile, options.harness, '-e', ''], { encoding: 'utf8' });
      assert.equal(result.code, 0, result.stdout);
    };
    await nativePermission(workspace, options, 'edit', 'src/a.mjs', { old_string: 'old', new_string: 'new' });
    await run(`const f=require('node:fs');f.writeFileSync('src/.a.tmp',f.readFileSync('src/a.mjs','utf8').replace('old','new'));f.renameSync('src/.a.tmp','src/a.mjs');`);
    await nativePermission(workspace, options, 'create', 'nested/created.mjs', { content: 'created' });
    await assert.rejects(readFile(join(options.mirror, 'nested/created.mjs')), { code: 'ENOENT' });
    await run(`const f=require('node:fs');f.mkdirSync('nested',{recursive:true});f.writeFileSync('nested/created.mjs','created');`);
    assert.equal((await workspace.readText('nested/created.mjs')).content, 'created');
    await run(`const f=require('node:fs'),a=require('node:assert/strict');
const denied=e=>['EPERM','EACCES'].includes(e.code);
for(const path of ['test.mjs','.env','.env.local','.Git','private',${JSON.stringify(join(options.candidate, 'src/a.mjs'))}])a.throws(()=>f.writeFileSync(path,'escape'),denied,path);
a.throws(()=>f.symlinkSync('src/a.mjs','sym'),denied);
a.throws(()=>f.linkSync('src/a.mjs','hard'),denied);
f.symlinkSync(${JSON.stringify(options.outside)},${JSON.stringify(join(options.root, 'outside-link'))});
a.throws(()=>f.renameSync(${JSON.stringify(join(options.root, 'outside-link'))},'moved-link'),denied);
a.throws(()=>require('node:child_process').execFileSync('/bin/sh',['-c','true'],{stdio:'ignore'}));`);
    const adoption = await workspace.adopt({ writersStopped: true });
    assert.deepEqual(adoption.changedPaths.sort(), ['nested/created.mjs', 'src/a.mjs']);
    assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'new');
    assert.equal(await readFile(join(options.candidate, 'nested/created.mjs'), 'utf8'), 'created');
    assert.equal(workspace.nativeWriteEvidence().writes.length, 2);
  }));

test('native permission is not a receipt: pending, mismatched, unapproved and extra changes refuse adoption', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true });
  await nativePermission(workspace, options, 'edit', 'src/a.mjs', { old_string: 'old', new_string: 'new' });
  await assert.rejects(workspace.inspect({ writersStopped: true }), e => e.code === 'native_write_pending');
  await writeFile(join(options.mirror, 'src/a.mjs'), 'wrong');
  await assert.rejects(workspace.adopt({ writersStopped: true }), /approved write/);
  assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'old');
  await writeFile(join(options.mirror, 'src/a.mjs'), 'new');
  await writeFile(join(options.mirror, 'unexpected.txt'), 'extra');
  await assert.rejects(workspace.inspect({ writersStopped: true }), /Unexpected/);
  await rm(join(options.mirror, 'unexpected.txt'));
  await writeFile(join(options.mirror, 'test.mjs'), 'unapproved');
  await assert.rejects(workspace.inspect({ writersStopped: true }), /approved write/);
}));

test('native writes bind exact replacements, projected size, sequential bases and host/delegated interoperability', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, containedNativeWrites: true, maxTotalBytes: 20 });
  await assert.rejects(nativePermission(workspace, options, 'missing', 'src/a.mjs', { old_string: 'absent', new_string: 'new' }), e => e.code === 'stale_file');
  await assert.rejects(nativePermission(workspace, options, 'huge', 'src/a.mjs', { content: 'x'.repeat(30) }), /total envelope/);
  await nativePermission(workspace, options, 'first', 'src/a.mjs', { content: 'aaa' });
  await assert.rejects(nativePermission(workspace, options, 'overlap', 'nested/new', { content: 'new' }), e => e.code === 'native_write_pending');
  await assert.rejects(workspace.writeDelegated({ path: 'src/a.mjs', content: 'wrong' }), /conflicts/);
  await workspace.writeDelegated({ path: 'src/a.mjs', content: 'aaa' });
  await assert.rejects(nativePermission(workspace, options, 'ambiguous', 'src/a.mjs', { old_string: 'a', new_string: 'b' }), e => e.code === 'stale_file');
  await nativePermission(workspace, options, 'all', 'src/a.mjs', { old_string: 'a', new_string: 'b', replace_all: true });
  await writeFile(join(options.mirror, 'src/a.mjs'), 'bbb');
  const read = await workspace.readText('src/a.mjs');
  await workspace.writeText({ path: 'src/a.mjs', content: 'host', expectedSha256: read.sha256 });
  await nativePermission(workspace, options, 'create', 'nested/new', { content: '' });
  await workspace.writeDelegated({ path: 'nested/new', content: '' });
  await workspace.adopt({ writersStopped: true });
  assert.equal(await readFile(join(options.candidate, 'src/a.mjs'), 'utf8'), 'host');
  assert.equal(await readFile(join(options.candidate, 'nested/new'), 'utf8'), '');
}));

test('advertised ACP filesystem channels create, read ranges, and edit through the checked writer', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true });
  const calls = new Map(), permissions = new Set();
  const handlers = createDevinFileHandlers({ workspace, cwd: options.mirror, sessionId: () => 's', calls, permissions });
  for (const [cap, method] of [['readTextFile', 'fs/read_text_file'], ['writeTextFile', 'fs/write_text_file']]) {
    assert.equal(DEVIN_CLIENT_CAPABILITIES.fs[cap], true); assert.equal(typeof handlers[method], 'function');
  }
  assert.equal(DEVIN_CLIENT_CAPABILITIES.terminal, false);
  const path = join(options.mirror, 'nested/new.txt'), params = { sessionId: 's', path };
  const tool = { toolCallId: 'new', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'write' },
    rawInput: { file_path: path, content: 'one\r\ntwo\r\nthree\n' } };
  calls.set('new', tool);
  const permission = { sessionId: 's', toolCall: { toolCallId: 'new' }, options: [{ kind: 'allow_once', optionId: 'once' }] };
  assert.equal((await handlers['session/request_permission'](permission)).outcome.optionId, 'once');
  await assert.rejects(readFile(path), { code: 'ENOENT' }, 'permission must not create a placeholder');
  await assert.rejects(handlers['session/request_permission'](permission), /refused/);
  assert.deepEqual(await handlers['fs/write_text_file']({ ...params, content: tool.rawInput.content }), {});
  assert.equal((await handlers['fs/read_text_file']({ ...params, line: 2, limit: 1 })).content, 'two\r\n');
  assert.equal((await handlers['fs/read_text_file']({ ...params, line: 3 })).content, 'three\n');
  assert.equal((await handlers['fs/read_text_file']({ ...params, line: 20 })).content, '');
  for (const patch of [{ line: 0 }, { limit: -1 }, { line: 1.5 }, { limit: 'all' }, { extra: true }])
    await assert.rejects(handlers['fs/read_text_file']({ ...params, ...patch }));
  await handlers['fs/write_text_file']({ ...params, content: 'changed' });
  await assert.rejects(handlers['fs/write_text_file']({ ...params, content: 'stale overwrite' }), e => e instanceof DevinToolFeedback);
  const read = await workspace.readText('nested/new.txt');
  await workspace.writeText({ path: 'nested/new.txt', content: 'MCP update', expectedSha256: read.sha256 });
  await assert.rejects(handlers['fs/write_text_file']({ ...params, content: 'stale again' }), e => e instanceof DevinToolFeedback);
  await handlers['fs/read_text_file'](params);
  await handlers['fs/write_text_file']({ ...params, content: 'final' });
  assert(workspace.listFiles().some(item => item.path === 'nested/new.txt'));
  const adopted = await workspace.adopt({ writersStopped: true });
  assert(adopted.changedPaths.includes('nested/new.txt'));
  assert.equal(await readFile(join(options.candidate, 'nested/new.txt'), 'utf8'), 'final');
}));

test('ACP creation checks protected paths, collisions, links, permissions and byte limits before writing', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true, deniedPaths: ['private'], maxTotalBytes: 12 });
  for (const path of ['.env', '.git/config', 'private/data', '../escape', 'test.mjs', 'SRC/A.MJS']) {
    await assert.rejects(workspace.writeDelegated({ path, content: 'x' }));
  }
  assert.throws(() => workspace.hostPath(join(options.candidate, 'src/a.mjs')));
  assert.throws(() => workspace.hostPath(options.mirror + '/src/../new.txt'));
  await symlink(options.outside, join(options.mirror, 'linked'));
  await assert.rejects(workspace.writeDelegated({ path: 'linked/secret', content: 'x' }));
  await assert.rejects(workspace.writeDelegated({ path: 'big.txt', content: 'xxxx' }), /byte envelope/);
  await assert.rejects(readFile(join(options.mirror, 'big.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(options.outside, 'secret'), 'utf8'), 'synthetic');
}));

test('host-only sandbox denies direct native writes, including declared files',
  { skip: process.platform !== 'darwin', timeout: 10000 }, () => fixture(async options => {
    const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true });
    const script = `const f=require('node:fs'),a=require('node:assert/strict');
for(const path of ['src/a.mjs','new/b.mjs','extra'])a.throws(()=>f.writeFileSync(path,'tamper'),e=>['EPERM','EACCES'].includes(e.code));
console.log('host-owned');`;
    const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', workspace.profile, options.harness, '-e', script],
      cwd: options.mirror, env: devinIsolatedEnvironment(options.root), timeoutMs: 5000, maxBytes: 1024 });
    assert.equal(result.code, 0); assert.match(result.stdout, /host-owned/);
    assert.equal((await workspace.inspect({ writersStopped: true })).changes.length, 0);
  }));

test('delegated writes support predeclared creates, including intentional empty files, without refreshing stale bases', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true });
  await workspace.writeDelegated({ path: 'new/b.mjs', content: '' });
  assert.deepEqual((await workspace.inspect({ writersStopped: true })).changes.map(item => item.path), ['new/b.mjs']);
  await assert.rejects(workspace.writeDelegated({ path: 'new/b.mjs', content: 'unread' }), e => e instanceof DevinToolFeedback);
  await workspace.readText('new/b.mjs');
  await workspace.writeDelegated({ path: 'new/b.mjs', content: 'checked' });
  await workspace.adopt({ writersStopped: true });
  assert.equal(await readFile(join(options.candidate, 'new/b.mjs'), 'utf8'), 'checked');
  assert.throws(() => workspace.rememberWriteBase('new/b.mjs', null), /Invalid/);
}));

test('ACP handlers reject malformed and cross-session requests before creating files', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true });
  const handlers = createDevinFileHandlers({ workspace, cwd: options.mirror, sessionId: () => 's', calls: new Map(), permissions: new Set() });
  for (const params of [null, {}, { sessionId: 'other' }, { sessionId: 's', extra: true }, { sessionId: 's', content: 1 }]) {
    await assert.rejects(handlers['fs/write_text_file']({ path: join(options.mirror, 'bad.txt'), content: 'x', ...params }));
  }
  await assert.rejects(readFile(join(options.mirror, 'bad.txt')), { code: 'ENOENT' });
  assert.throws(() => workspace.rememberWriteBase('bad.txt', 'not-a-hash'), /Invalid/);
}));

test('cancelled delegated writes cannot create files', () => fixture(async options => {
  const control = new AbortController();
  const workspace = await createDevinWorkspace({ ...options, hostWritesOnly: true, signal: control.signal });
  control.abort();
  await assert.rejects(workspace.writeDelegated({ path: 'cancelled.txt', content: 'x' }), /cancelled/);
  await assert.rejects(readFile(join(options.mirror, 'cancelled.txt')), { code: 'ENOENT' });
}));

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

test('only host-proven no-write conflicts are recoverable; protection and integrity errors remain fatal', () => fixture(async options => {
  const workspace = await createDevinWorkspace({ ...options, deniedPaths: ['private'] });
  await assert.rejects(workspace.readText('missing.mjs'), e => e instanceof DevinToolFeedback && e.code === 'file_not_prepared');
  await assert.rejects(workspace.writeText({ path: 'src/a.mjs', content: 'not-written', expectedSha256: 'stale' }),
    e => e instanceof DevinToolFeedback && e.code === 'stale_file');
  assert.equal((await workspace.readText('src/a.mjs')).content, 'old');
  for (const path of ['.env', '../escape', 'private/key'])
    await assert.rejects(workspace.readText(path), e => !(e instanceof DevinToolFeedback));
  await assert.rejects(workspace.writeText({ path: 'test.mjs', content: 'not-written', expectedSha256: 'stale' }),
    e => !(e instanceof DevinToolFeedback));
  await rm(join(options.mirror, 'src/a.mjs'));
  await symlink(join(options.outside, 'secret'), join(options.mirror, 'src/a.mjs'));
  await assert.rejects(workspace.readText('src/a.mjs'), e => !(e instanceof DevinToolFeedback));
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
