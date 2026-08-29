import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokProtocolReducer, installGrokConfig, installQwenSystemPolicy, nativeCaughtFailure, normalizeNativeRouteObservation, qwenNativeArgs, validateNativeDecision } from './native-harness.mjs';

test('Qwen native system policy disables hidden provider retries and refuses drift', async t => {
  const home = await mkdtemp(join(tmpdir(), 'camus-qwen-policy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = await installQwenSystemPolicy(home);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    general: { enableAutoUpdate: false },
    privacy: { usageStatisticsEnabled: false },
    model: { generationConfig: { maxRetries: 0 } },
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await installQwenSystemPolicy(home), path, 'an exact resumed policy is idempotent');
  await writeFile(path, '{}\n', { mode: 0o600 });
  await assert.rejects(() => installQwenSystemPolicy(home), /system policy changed/);
});

test('Grok native config disables optional model side-calls and refuses drift', async t => {
  const home = await mkdtemp(join(tmpdir(), 'camus-grok-policy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = await installGrokConfig(home, { gatewayUrl: 'http://127.0.0.1:1926/v1', model: 'grok-fixture' });
  const text = await readFile(path, 'utf8');
  assert.match(text, /\[features\]\ntitle_refresh = false\nturn_summary = false\nsession_recap = false\n/);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:1926\/v1"/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await installGrokConfig(home, { gatewayUrl: 'http://127.0.0.1:1926/v1', model: 'grok-fixture' }), path);
  await writeFile(path, '[features]\ntitle_refresh = true\n', { mode: 0o600 });
  await assert.rejects(() => installGrokConfig(home, { gatewayUrl: 'http://127.0.0.1:1926/v1', model: 'grok-fixture' }), /configuration changed/);
});

test('native abort evidence preserves the local stop reason and kind', () => {
  assert.deepEqual(nativeCaughtFailure({ error: new Error('Native execution cancelled.'), stopReason: 'Native model-call budget exhausted.',
    stopKind: 'budget', dispatched: true, terminal: null }), {
    ok: false, error: 'Native model-call budget exhausted.', uncertain: true, noModelCalled: false,
    definitiveTurnEnd: false, stopKind: 'budget',
  });
  assert.equal(nativeCaughtFailure({ error: new Error('cancelled'), stopReason: 'Native execution cancelled.',
    stopKind: 'cancel', dispatched: true, terminal: null }).stopKind, 'cancel');
});

test('native decision is exact, bounded and fail closed', () => {
  assert.deepEqual(validateNativeDecision({ done: true, summary: 'ready', decision: null }), { done: true, summary: 'ready', decision: null });
  assert.deepEqual(validateNativeDecision({ done: false, summary: '', decision: { action: 'human', reason: 'Which target?' } }).decision.action, 'human');
  for (const bad of [null, {}, { done: true, summary: 'x', decision: { action: 'stop', reason: 'x' } },
    { done: false, summary: 'x', decision: { action: 'approve', reason: 'x' } }, { done: true, summary: 'x', decision: null, extra: true }]) {
    assert.throws(() => validateNativeDecision(bad), /Invalid native/);
  }
});

test('Grok protocol accepts pinned informational frames and joins chunked final JSON', () => {
  let actions = 0;
  const protocol = createGrokProtocolReducer({ onAction: () => { actions++; } });
  for (const frame of [
    { type: 'available_commands', tools: [], commands: [] },
    { type: 'thought', data: 'Inspecting the bounded parser.' },
    { type: 'plan', entries: [] },
    { type: 'text', data: 'I will inspect the file.' },
    { type: 'tool_call', toolCallId: 'call-1', toolName: 'read_file', rawInput: { path: 'src/a.mjs' } },
    { type: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
    { type: 'usage', stopReason: 'tool_calls', usage: { input_tokens: 10, output_tokens: 2 } },
    { type: 'text', data: '{"done":true,' },
    { type: 'text', data: '"summary":"ready","decision":null}' },
    { type: 'end', stopReason: 'end_turn', sessionId: '01900000-0000-7000-8000-000000000001' },
  ]) protocol.push(frame);
  assert.equal(actions, 1);
  assert.deepEqual(protocol.finish().result, { done: true, summary: 'ready', decision: null });
  assert.throws(() => protocol.push({ type: 'text', data: 'late' }), /after its terminal/);
});

test('Grok protocol records bounded error terminals and refuses unknown or prohibited frames', () => {
  const failed = createGrokProtocolReducer();
  failed.push({ type: 'error', message: 'rate limited' });
  failed.push({ type: 'end', stopReason: 'rate_limit', sessionId: '01900000-0000-7000-8000-000000000001' });
  assert.equal(failed.finish().reportedError, true);
  assert.throws(() => createGrokProtocolReducer().push({ type: 'future_unreviewed' }), /Unexpected Grok/);
  assert.throws(() => createGrokProtocolReducer().push({ type: 'tool_call', toolName: 'WebSearch' }), /unsupported tool/);
});

test('Qwen receives limits derived from the enclosing native turn', () => {
  const session = { resumed: false, sessionId: '01900000-0000-7000-8000-000000000001' };
  const args = qwenNativeArgs({ model: 'qwen-fixture', prompt: 'task', session,
    timeoutMs: 300000, maxModelCalls: 3, maxToolCalls: 8 });
  const value = name => args[args.indexOf(name) + 1];
  assert.equal(value('--max-session-turns'), '4');
  assert.equal(value('--max-tool-calls'), '8');
  assert.equal(value('--max-wall-time'), '295s', 'the harness stops before the outer provider timeout');
  assert.equal(qwenNativeArgs({ model: 'm', prompt: 'p', session, timeoutMs: 5000, maxModelCalls: 1, maxToolCalls: 0 })
    .includes('0'), true, 'zero remaining real tool calls still allows the exempt structured terminal');
  assert.throws(() => qwenNativeArgs({ model: 'm', prompt: 'p', session, timeoutMs: 1000, maxModelCalls: 1, maxToolCalls: 1 }), /bounded integer/);
});

test('native route evidence is bounded, normalized, and contains no raw router metadata', () => {
  assert.equal(normalizeNativeRouteObservation({ provider: 'alibaba' }, {}), null);
  const backend = { provider: 'openrouter', route: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false } };
  const observation = normalizeNativeRouteObservation(backend, {
    accountedCalls: 2,
    openRouterRouteEvidence: [
      { attempt: 1, strategy: 'direct', selectedProvider: 'DeepInfra', requested: 'private-model' },
      { attempt: 1, strategy: 'direct', selectedProvider: 'DeepInfra', raw: { forbidden: true } },
    ],
  });
  assert.deepEqual(observation, {
    requestEnforced: backend.route,
    metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }, { provider: 'DeepInfra', attempt: 1 }],
  });
  assert.equal(JSON.stringify(observation).includes('private-model'), false);
  assert.equal(JSON.stringify(observation).includes('forbidden'), false);
  assert.throws(() => normalizeNativeRouteObservation(backend, { accountedCalls: 1, openRouterRouteEvidence: [] }), /requires one bounded/);
  assert.throws(() => normalizeNativeRouteObservation(backend, {
    accountedCalls: 2, openRouterRouteEvidence: [{ attempt: 1, selectedProvider: 'DeepInfra' }],
  }), /requires one bounded/);
  assert.throws(() => normalizeNativeRouteObservation(backend, {
    accountedCalls: 1, openRouterRouteEvidence: [{ attempt: 1, selectedProvider: 'bad\nprovider' }],
  }), /observation 1 is invalid/);
});
