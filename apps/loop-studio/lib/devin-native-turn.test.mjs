import test from 'node:test';
import assert from 'node:assert/strict';
import { devinObservedContract, runDevinProtocolTurn } from './devin-native-turn.mjs';

const budget = () => ({ version: 'devin-observed/v1', maxPrompts: 1, maxObservedTools: 20,
  maxWallMs: 1000, billingUncertaintyAccepted: true });
function fixture(overrides = {}) {
  const log = []; let callbacks, rejectPending;
  const update = value => callbacks.onNotification('session/update', { sessionId: 's1', update: value });
  const options = { prompt: 'fixture', cwd: '/fixture', contract: budget(),
    beforePrompt: async () => { log.push('persist'); }, closeTools: async () => { log.push('tools-close'); },
    onToolRequest: async () => ({}),
    rpcFactory(value) {
      callbacks = value;
      return {
        fail() { log.push('fail'); rejectPending?.(new Error('stopped')); },
        async close() { log.push('close'); },
        async request(method, params) {
          log.push(method);
          if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'devin-browser' }] };
          if (method === 'session/new') {
            assert.deepEqual(params.mcpServers, []);
            return { sessionId: 's1', configOptions: [{ category: 'model', currentValue: 'swe-2-high' }], modes: { currentModeId: 'autonomous' } };
          }
          if (method === 'session/prompt') {
            assert(log.includes('persist'));
            if (overrides.prompt) return overrides.prompt({ update, callbacks, log, pending: () => new Promise((_, reject) => { rejectPending = reject; }) });
            update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending', kind: 'read' });
            await callbacks.onRequest('fs/read_text_file', { sessionId: 's1', path: 'a' });
            update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
            update({ sessionUpdate: 'usage_update', _meta: { 'cognition.ai/inputTokens': 10, 'cognition.ai/outputTokens': 1 } });
            return { stopReason: 'end_turn', usage: { totalTokens: 11 } };
          }
          throw new Error('unexpected RPC');
        },
      };
    },
  };
  return { options, log, callbacks: () => callbacks };
}

test('completed execution stays distinct from unknown billing and admission', async () => {
  const { options, log } = fixture(); const result = await runDevinProtocolTurn(options);
  assert.equal(result.execution, 'completed'); assert.equal(result.promptsSent, 1);
  assert.equal(result.observedTools, 1); assert.equal(result.providerCalls, null); assert.equal(result.runTokens, null);
  assert.equal(result.usageIncomplete, true); assert.equal(result.admissionGranted, false);
  assert.equal(result.adoptionAuthorized, false); assert.equal(result.modelActual, null);
  assert(log.indexOf('persist') < log.indexOf('session/prompt'));
  assert.deepEqual(log.slice(-2), ['tools-close', 'close']);
});

test('unfinished host operations cannot become completion even when cleanup is confirmed', async () => {
  const { options } = fixture();
  const result = await runDevinProtocolTurn({ ...options, closeTools: async () => ({ unfinishedAtTerminal: true }) });
  assert.equal(result.execution, 'uncertain'); assert.equal(result.reason, 'tool_boundary_refused');
  assert.equal(result.cleanupConfirmed, true, 'incomplete completion is not falsely reported as unproven cleanup');
});

test('host work finishing during native process shutdown cannot erase an incomplete terminal', async () => {
  const { options } = fixture();
  let running = true;
  const result = await runDevinProtocolTurn({ ...options,
    closeTools: async () => ({ unfinishedAtTerminal: running }),
    rpcFactory: callbacks => {
      const rpc = options.rpcFactory(callbacks);
      return { ...rpc, close: async () => { running = false; await rpc.close(); } };
    },
  });
  assert.equal(result.execution, 'uncertain');
  assert.equal(result.reason, 'tool_boundary_refused');
  assert.equal(result.cleanupConfirmed, true);
});

test('missing uncertainty consent, claimed hard token caps, replay and model substitution refuse before RPC', async () => {
  for (const contract of [null, { ...budget(), billingUncertaintyAccepted: false }, { ...budget(), maxTokens: 100 }, { ...budget(), maxPrompts: 2 }])
    assert.throws(() => devinObservedContract(contract));
  for (const override of [{ nativeSession: {} }, { model: 'other' }]) {
    const { options, log } = fixture(); await assert.rejects(runDevinProtocolTurn({ ...options, ...override })); assert.deepEqual(log, []);
  }
});

test('durable marker failure and prior cancellation send no prompt', async () => {
  for (const override of [{ beforePrompt: async () => { throw new Error('disk'); } }, { signal: AbortSignal.abort() }]) {
    const { options, log } = fixture(); const result = await runDevinProtocolTurn({ ...options, ...override });
    assert.equal(result.promptsSent, 0); assert.equal(result.execution, 'not_started');
    assert(!log.includes('session/prompt')); assert.equal(result.cleanupConfirmed, true);
  }
});

test('unsolicited tool activity before prompt dispatch is refused', async () => {
  const context = fixture();
  const result = await runDevinProtocolTurn({ ...context.options, beforePrompt: async () => {
    context.callbacks().onNotification('session/update', { sessionId: 's1', update: {
      sessionUpdate: 'tool_call', toolCallId: 'unexpected', status: 'pending', kind: 'read',
    } });
  } });
  assert.equal(result.reason, 'pre_dispatch_activity'); assert.equal(result.promptsSent, 0);
  assert(!context.log.includes('session/prompt'));
});

test('tool failure, cross-session traffic and incomplete terminal cannot become success', async () => {
  const cases = [
    ({ update }) => { update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'failed' }); return { stopReason: 'end_turn' }; },
    ({ callbacks }) => { callbacks.onNotification('session/update', { sessionId: 'wrong', update: {} }); return { stopReason: 'end_turn' }; },
    () => ({ stopReason: 'cancelled' }),
    ({ update }) => { update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'pending' }); return { stopReason: 'end_turn' }; },
  ];
  for (const prompt of cases) {
    const { options } = fixture({ prompt }); const result = await runDevinProtocolTurn(options);
    assert.equal(result.execution, 'uncertain'); assert.equal(result.cleanupConfirmed, true);
  }
});

test('tool cap and deadline cancel with no replay', async () => {
  const capped = fixture({ prompt: ({ update }) => {
    update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'completed' }); return { stopReason: 'end_turn' };
  } });
  assert.equal((await runDevinProtocolTurn({ ...capped.options, contract: { ...budget(), maxObservedTools: 1 } })).reason, 'observed_tool_limit');
  const timed = fixture({ prompt: ({ pending }) => pending() });
  const result = await runDevinProtocolTurn({ ...timed.options, contract: { ...budget(), maxWallMs: 20 } });
  assert.equal(result.reason, 'deadline'); assert.equal(timed.log.filter(x => x === 'session/prompt').length, 1);
});

test('host shell requests and host cleanup failure refuse safely', async () => {
  const fixture1 = fixture({ prompt: async ({ callbacks }) => {
    await callbacks.onRequest('terminal/create', { sessionId: 's1' }); return { stopReason: 'end_turn' };
  } });
  assert.equal((await runDevinProtocolTurn(fixture1.options)).reason, 'tool_boundary_refused');
  const { options } = fixture();
  const result = await runDevinProtocolTurn({ ...options, closeTools: async () => { throw new Error('unproven'); } });
  assert.equal(result.reason, 'cleanup_unproven'); assert.equal(result.execution, 'uncertain');
});

test('transport failures retain only known fixed labels, not exception content', async () => {
  for (const [message, label] of [['Native executor closed before completion.', 'executor_closed'],
    ['Native protocol request failed.', 'request_rejected'], ['provider-secret', null]]) {
    const { options } = fixture({ prompt: () => { throw new Error(message); } });
    const result = await runDevinProtocolTurn(options);
    assert.equal(result.rpcFailure, label); assert.equal(result.reason, 'native_turn_failed');
    assert.equal(result.protocolStage, 'prompt'); assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
  }
});
