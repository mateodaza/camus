import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeDecision } from './native-harness.mjs';

test('native decision is exact, bounded and fail closed', () => {
  assert.deepEqual(validateNativeDecision({ done: true, summary: 'ready', decision: null }), { done: true, summary: 'ready', decision: null });
  assert.deepEqual(validateNativeDecision({ done: false, summary: '', decision: { action: 'human', reason: 'Which target?' } }).decision.action, 'human');
  for (const bad of [null, {}, { done: true, summary: 'x', decision: { action: 'stop', reason: 'x' } },
    { done: false, summary: 'x', decision: { action: 'approve', reason: 'x' } }, { done: true, summary: 'x', decision: null, extra: true }]) {
    assert.throws(() => validateNativeDecision(bad), /Invalid native/);
  }
});
