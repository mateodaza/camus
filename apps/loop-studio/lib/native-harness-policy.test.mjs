import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeGateway } from './native-gateway.mjs';
import { nativeHarnessPolicy, nativeHarnessEnvironment, preflightNativeHarness, QWEN_NATIVE_EXECUTOR } from './native-harness-policy.mjs';

test('macOS outer sandbox admits only candidate, private scratch, runtime and gateway', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-native-isolation-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate'), scratch = join(root, 'scratch'), source = join(root, 'source'), receipts = join(root, 'receipts');
  for (const dir of [candidate, scratch, source, receipts, join(candidate, '.git')]) await mkdir(dir, { recursive: true });
  await writeFile(join(candidate, '.git', 'HEAD'), 'synthetic');
  await writeFile(join(candidate, 'operator-private.txt'), 'synthetic private source');
  const upstream = (await import('node:http')).createServer((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' },
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }, model: 'fixture-model' }); t.after(() => gateway.close());
  const policy = await nativeHarnessPolicy({ executor: QWEN_NATIVE_EXECUTOR, worktree: candidate, scratch, harness: process.execPath, artifactDigest: 'synthetic', gatewayPort: gateway.port,
    deniedPaths: ['operator-private.txt'] });
  const env = nativeHarnessEnvironment({ executor: QWEN_NATIVE_EXECUTOR, policy, gateway });
  assert.equal(Object.values(env).includes('synthetic-provider-secret'), false);
  await preflightNativeHarness({ policy, env, gateway, sourcePath: source, receiptsDir: receipts });
});
