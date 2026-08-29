import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeRouteObservation, qwenNativeArgs, validateNativeDecision } from './native-harness.mjs';

test('native decision is exact, bounded and fail closed', () => {
  assert.deepEqual(validateNativeDecision({ done: true, summary: 'ready', decision: null }), { done: true, summary: 'ready', decision: null });
  assert.deepEqual(validateNativeDecision({ done: false, summary: '', decision: { action: 'human', reason: 'Which target?' } }).decision.action, 'human');
  for (const bad of [null, {}, { done: true, summary: 'x', decision: { action: 'stop', reason: 'x' } },
    { done: false, summary: 'x', decision: { action: 'approve', reason: 'x' } }, { done: true, summary: 'x', decision: null, extra: true }]) {
    assert.throws(() => validateNativeDecision(bad), /Invalid native/);
  }
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
