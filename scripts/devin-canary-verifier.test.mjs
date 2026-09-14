import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokSubscriptionPolicy } from '../apps/loop-studio/lib/adapters/grok-subscription.mjs';
import { verificationEnvironment } from '../apps/loop-studio/lib/code-seat-verify.mjs';
import { runNativeProcess } from '../apps/loop-studio/lib/native-process.mjs';
import { devinCanaryVerifierProfile } from './devin-canary-verifier.mjs';

test('host verifier runs frozen tests while denying writes, ancestor listing and private reads',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, async () => {
    const roots = [];
    try {
      for (const label of ['fixture', 'tools', 'private'])
        roots.push(await realpath(await mkdtemp(join(tmpdir(), `camus-devin-verify-${label}-`))));
      const [cwd, scratch, outside] = roots;
      const node = await realpath(process.execPath);
      const policy = await grokSubscriptionPolicy({ worktree: cwd, scratch, harness: node,
        artifactDigest: 'offline-fixture', model: 'none', deniedPaths: ['acceptance.test.mjs'] });
      const profile = devinCanaryVerifierProfile(policy);
      await writeFile(join(outside, 'secret'), 'synthetic');
      await writeFile(join(cwd, 'calc.mjs'), 'export const add=(a,b)=>a+b;');
      await writeFile(join(cwd, 'acceptance.test.mjs'), `import test from 'node:test';
import a from 'node:assert/strict'; import fs from 'node:fs'; import {add} from './calc.mjs';
test('sum and isolation',()=>{
 a.equal(add(2,3),5); a.equal(add(-4,3),-1); a.equal(add(0,0),0);
 const denied=e=>['EPERM','EACCES'].includes(e.code);
 for(const path of ['calc.mjs','acceptance.test.mjs','new-file']) a.throws(()=>fs.writeFileSync(path,'tamper'),denied);
 a.throws(()=>fs.readFileSync(${JSON.stringify(join(outside, 'secret'))}),denied);
 a.throws(()=>fs.readdirSync('/private/var/folders'),denied);
});`);
      const run = () => runNativeProcess({ command: '/usr/bin/sandbox-exec',
        args: ['-p', profile, node, '--test', 'acceptance.test.mjs'], cwd,
        env: verificationEnvironment({}, policy.toolHome), timeoutMs: 5000, maxBytes: 16384 });
      assert.equal((await run()).code, 0);
      await writeFile(join(cwd, 'calc.mjs'), 'export const add=(a,b)=>a-b;');
      assert.notEqual((await run()).code, 0);
    } finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
  });
