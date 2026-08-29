import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeGateway } from './native-gateway.mjs';
import { assertNativeHarnessArtifact, nativeHarnessPolicy, nativeHarnessEnvironment, nativeHarnessReadiness, preflightNativeHarness,
  QWEN_NATIVE_EXECUTOR, GROK_NATIVE_EXECUTOR } from './native-harness-policy.mjs';

test('native harness readiness is spend-free, bounded and path-private', async () => {
  const common = { platform: 'darwin', arch: 'arm64', nodeMajor: 22,
    resolveHarness: async () => '/private/operator/reviewed-harness', assertArtifact: async () => 'digest' };
  const ready = await nativeHarnessReadiness(QWEN_NATIVE_EXECUTOR, { ...common,
    runVersion: async () => ({ code: 0, stdout: '0.22.3\n' }) });
  assert.equal(ready.status, 'ready'); assert.equal(ready.ready, true);
  assert.doesNotMatch(JSON.stringify(ready), /private\/operator/);

  const missing = await nativeHarnessReadiness(GROK_NATIVE_EXECUTOR, { ...common,
    resolveHarness: async () => { throw new Error('secret path'); } });
  assert.equal(missing.status, 'missing'); assert.match(missing.remedy, /CAMUS_GROK_BUILD_BIN/);
  assert.doesNotMatch(JSON.stringify(missing), /secret path/);

  let unreviewedExecuted = false;
  const wrongDigest = await nativeHarnessReadiness(QWEN_NATIVE_EXECUTOR, { ...common,
    runVersion: async () => { unreviewedExecuted = true; return { code: 0, stdout: '0.22.3\n' }; },
    assertArtifact: async () => { throw new Error('private digest detail'); } });
  assert.equal(wrongDigest.status, 'wrong_digest'); assert.match(wrongDigest.remedy, /NATIVE-HARNESS-QUALIFICATION-1\.md/);
  assert.equal(unreviewedExecuted, false, 'an unreviewed local artifact is never executed');
  assert.doesNotMatch(JSON.stringify(wrongDigest), /private digest detail/);

  const wrongVersion = await nativeHarnessReadiness(GROK_NATIVE_EXECUTOR, { ...common,
    runVersion: async () => ({ code: 0, stdout: '1.0.4\n' }) });
  assert.equal(wrongVersion.status, 'wrong_version');

  let resolved = false;
  const unsupported = await nativeHarnessReadiness(QWEN_NATIVE_EXECUTOR, { ...common, platform: 'linux',
    resolveHarness: async () => { resolved = true; throw new Error('must not run'); } });
  assert.equal(unsupported.status, 'unsupported'); assert.equal(resolved, false);
  assert.equal(unsupported.remedy, null);
});

test('Qwen artifact pin refuses node_modules before readiness executes it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-qwen-artifact-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'node_modules', 'unreviewed'), { recursive: true });
  const entry = join(packageRoot, 'cli-entry.js');
  await writeFile(entry, '#!/usr/bin/env node\n');
  await writeFile(join(packageRoot, 'node_modules', 'unreviewed', 'index.js'), 'throw new Error("unreviewed")\n');
  await assert.rejects(
    assertNativeHarnessArtifact(QWEN_NATIVE_EXECUTOR, entry, { arch: 'arm64', nodeMajor: 22 }),
    /unreviewed dependencies/,
  );

  let executed = false;
  const result = await nativeHarnessReadiness(QWEN_NATIVE_EXECUTOR, {
    platform: 'darwin', arch: 'arm64', nodeMajor: 22,
    resolveHarness: async () => entry,
    assertArtifact: harness => assertNativeHarnessArtifact(QWEN_NATIVE_EXECUTOR, harness, { arch: 'arm64', nodeMajor: 22 }),
    runVersion: async () => { executed = true; return { code: 0, stdout: '0.22.3\n' }; },
  });
  assert.equal(result.status, 'wrong_digest');
  assert.equal(executed, false);
});

test('macOS outer sandbox admits only candidate, private scratch, runtime and gateway', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-native-isolation-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate'), scratch = join(root, 'scratch'), source = join(root, 'source'), receipts = join(root, 'receipts');
  for (const dir of [candidate, scratch, source, receipts, join(candidate, '.git')]) await mkdir(dir, { recursive: true });
  await writeFile(join(candidate, '.git', 'HEAD'), 'synthetic');
  await writeFile(join(candidate, 'operator-private.txt'), 'synthetic private source');
  const upstream = (await import('node:http')).createServer((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' },
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }, model: 'fixture-model', remainingTokens: 100 }); t.after(() => gateway.close());
  const policy = await nativeHarnessPolicy({ executor: QWEN_NATIVE_EXECUTOR, worktree: candidate, scratch, harness: process.execPath, artifactDigest: 'synthetic', gatewayPort: gateway.port,
    deniedPaths: ['operator-private.txt'] });
  const env = nativeHarnessEnvironment({ executor: QWEN_NATIVE_EXECUTOR, policy, gateway });
  assert.equal(Object.values(env).includes('synthetic-provider-secret'), false);
  await preflightNativeHarness({ policy, env, gateway, sourcePath: source, receiptsDir: receipts });
});
