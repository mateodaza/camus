import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm, symlink, link, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevinCanaryMirror } from './devin-canary-mirror.mjs';
import { devinIsolatedEnvironment } from '../apps/loop-studio/lib/devin-native-preflight.mjs';
import { runNativeProcess } from '../apps/loop-studio/lib/native-process.mjs';

async function fixture(fn) {
  const dirs = [];
  try {
    for (const name of ['candidate', 'mirror', 'auth', 'private'])
      dirs.push(await realpath(await mkdtemp(join(tmpdir(), `camus-devin-mirror-${name}-`))));
    const [candidate, mirror, root, outside] = dirs;
    await writeFile(join(candidate, 'calc.mjs'), 'export const add=(a,b)=>a-b;');
    await writeFile(join(candidate, 'acceptance.test.mjs'), '// immutable synthetic tests');
    await writeFile(join(candidate, '.env'), 'synthetic private canary');
    await writeFile(join(outside, 'secret.txt'), 'synthetic outside canary');
    await fn({ candidate, mirror, root, outside, harness: await realpath(process.execPath) });
  } finally { for (const dir of dirs) await rm(dir, { recursive: true }); }
}

test('mirror copies exactly the two fixture files and maps no other path', () => fixture(async options => {
  const result = await createDevinCanaryMirror(options);
  assert.deepEqual((await readdir(options.mirror)).sort(), ['acceptance.test.mjs', 'calc.mjs']);
  assert.equal(await readFile(join(options.mirror, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  assert.equal(result.mapPath('calc.mjs'), join(options.candidate, 'calc.mjs'));
  assert.equal(result.mapPath(join(options.mirror, 'calc.mjs')), join(options.candidate, 'calc.mjs'));
  for (const path of ['.env', '../calc.mjs', options.candidate, join(options.candidate, 'calc.mjs'), null])
    assert.throws(() => result.mapPath(path));
}));

test('mirror refuses populated/overlapping roots and linked or oversized files', () => fixture(async options => {
  await assert.rejects(createDevinCanaryMirror({ ...options, mirror: options.root }));
  const path = join(options.candidate, 'calc.mjs');
  await rm(path); await symlink(join(options.outside, 'secret.txt'), path);
  await assert.rejects(createDevinCanaryMirror(options));
  await rm(path); await link(join(options.outside, 'secret.txt'), path);
  await assert.rejects(createDevinCanaryMirror(options));
  await rm(path); await writeFile(path, 'x'.repeat(8193));
  await assert.rejects(createDevinCanaryMirror(options));
  assert.deepEqual(await readdir(options.mirror), []);
  await writeFile(path, 'small'); await writeFile(join(options.mirror, 'existing'), 'do not overwrite');
  await assert.rejects(createDevinCanaryMirror(options));
}));

test('real macOS mirror grants only the selected copy authority, never real candidate or frozen-test writes',
  { skip: process.platform !== 'darwin', timeout: 10000 }, () => fixture(async options => {
    const { profile } = await createDevinCanaryMirror(options);
    const { candidate, mirror, outside, root, harness } = options;
    const source = `const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);
for(const name of ['calc.mjs','acceptance.test.mjs']) {
 const copy=${JSON.stringify(mirror)}+'/'+name, actual=${JSON.stringify(candidate)}+'/'+name;
 a.ok(fs.readFileSync(copy).length); a.equal(fs.realpathSync.native(copy),copy);
 a.throws(()=>fs.readFileSync(actual),denied); a.throws(()=>fs.lstatSync(actual),denied);
 a.throws(()=>fs.writeFileSync(copy,'escape'),denied); a.throws(()=>fs.writeFileSync(actual,'escape'),denied);
}
a.throws(()=>fs.readFileSync(${JSON.stringify(join(candidate, '.env'))}),denied);
a.throws(()=>fs.readFileSync(${JSON.stringify(join(outside, 'secret.txt'))}),denied);
a.throws(()=>fs.writeFileSync(${JSON.stringify(join(mirror, 'new.mjs'))},'escape'),denied);
a.throws(()=>cp.execFileSync('/bin/sh',['-c','exit 0'],{stdio:'ignore'}));
console.log('mirror-isolation-ok');`;
    const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, harness, '-e', source],
      cwd: root, env: devinIsolatedEnvironment(root), timeoutMs: 5000, maxBytes: 2048 });
    assert.equal(result.code, 0); assert.match(result.stdout, /mirror-isolation-ok/);
  }));

test('native staging option permits only calc writes and still blocks the real candidate, tests and shell',
  { skip: process.platform !== 'darwin', timeout: 10000 }, () => fixture(async options => {
    const { profile } = await createDevinCanaryMirror({ ...options, nativeWritableFixture: true });
    const { candidate, mirror, outside, root, harness } = options;
    const source = `const f=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);
f.writeFileSync(${JSON.stringify(join(mirror, 'calc.mjs'))},'staged change');
a.equal(f.readFileSync(${JSON.stringify(join(mirror, 'calc.mjs'))},'utf8'),'staged change');
for(const path of ${JSON.stringify([join(candidate, 'calc.mjs'), join(mirror, 'acceptance.test.mjs'), join(mirror, 'new.mjs'), join(outside, 'secret.txt')])})
 a.throws(()=>f.writeFileSync(path,'escape'),denied);
a.throws(()=>f.readFileSync(${JSON.stringify(join(candidate, 'calc.mjs'))}),denied);
a.throws(()=>cp.execFileSync('/bin/sh',['-c','exit 0'],{stdio:'ignore'}));
console.log('native-staging-isolation-ok');`;
    const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, harness, '-e', source],
      cwd: root, env: devinIsolatedEnvironment(root), timeoutMs: 5000, maxBytes: 2048 });
    assert.equal(result.code, 0); assert.match(result.stdout, /native-staging-isolation-ok/);
    assert.equal(await readFile(join(candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));
