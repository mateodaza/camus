import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenNativeArgs, validateNativeDecision } from './native-harness.mjs';

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
