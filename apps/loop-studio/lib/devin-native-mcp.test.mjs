import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevinMcp } from './devin-native-mcp.mjs';

test('overlap reports no execution, consumes budget and ids, and never queues or replays effects', { timeout: 5000 }, async () => {
  let release, started, invoked = 0, accounted = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const refusals = [];
  const broker = await startDevinMcp({ maxCalls: 3, onCall: () => accounted++, onRefusal: value => refusals.push(value),
    tools: [{ name: 'run_command', description: 'fixture', inputSchema: { type: 'object' }, invoke: async () => {
      invoked++; started(); await waiting; return 'ok';
    } }] });
  const post = async (id, method = 'tools/call', params = { name: 'run_command', arguments: {} }) =>
    (await fetch(broker.definition.url, { method: 'POST', headers: { authorization: broker.definition.headers[0].value },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
  try {
    await post(0, 'initialize', {});
    const first = post(1); await entered;
    const busy = await post(2, 'tools/call', { name: 'run_command', arguments: { secret: 'never-echo-this' } });
    assert.equal(busy.result.isError, false);
    assert.equal(JSON.parse(busy.result.content[0].text).code, 'tool_busy');
    assert.equal(JSON.parse(busy.result.content[0].text).operationCompleted, false);
    assert.doesNotMatch(JSON.stringify(busy), /never-echo-this/);
    assert.equal(invoked, 1); assert.equal(accounted, 2); assert.equal(refusals.length, 0);
    assert((await post(1)).error, 'duplicate active effect is still fatal');
    assert.equal(refusals.at(-1).code, 'duplicate_request');
    release(); await first;
    assert.equal(invoked, 1, 'busy requests were not queued');
    assert((await post(2)).error, 'a busy id is consumed forever');
    assert.equal(refusals.at(-1).code, 'duplicate_request');
    assert.equal((await post(3)).result.isError, false);
    assert.equal(invoked, 2); assert.equal(accounted, 3);
    assert((await post(4)).error); assert.equal(refusals.at(-1).code, 'call_limit');
  } finally { release(); await broker.close(); }
});

test('busy floods and progress callback refusal cannot bypass the action allowance', { timeout: 5000 }, async () => {
  for (const callbackFails of [false, true]) {
    let release, started, accounted = 0, invoked = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const refusals = [];
    const broker = await startDevinMcp({ maxCalls: 2, onRefusal: value => refusals.push(value),
      onCall: () => { if (++accounted === 2 && callbackFails) throw new Error('private'); },
      tools: [{ name: 'run_command', description: 'fixture', inputSchema: {}, invoke: async () => {
        invoked++; started(); await waiting; return 'ok';
      } }] });
    const post = async (id, method = 'tools/call') => (await fetch(broker.definition.url, { method: 'POST',
      headers: { authorization: broker.definition.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id, method,
        params: { name: 'run_command', arguments: {} } }) })).json();
    try {
      await post(0, 'initialize'); const first = post(1); await entered;
      const busy = await post(2);
      if (callbackFails) { assert(busy.error); assert.equal(refusals.at(-1).code, 'action_limit'); }
      else assert.equal(JSON.parse(busy.result.content[0].text).code, 'tool_busy');
      assert((await post(3)).error); assert.equal(refusals.at(-1).code, 'call_limit');
      assert.equal(invoked, 1); assert.equal(accounted, 2);
      release(); await first;
    } finally { release(); await broker.close(); }
  }
});

test('tool broker authenticates, validates dispatch, caps effects and refuses replay', async () => {
  let calls = 0, refusals = 0;
  const broker = await startDevinMcp({ maxCalls: 1, onRefusal: () => refusals++, tools: [{ name: 'test_tool', description: 'fixture',
    inputSchema: { type: 'object' }, invoke: async args => { assert.deepEqual(args, {}); calls++; return 'ok'; } }] });
  const post = async (id, method, params, headers = {}) => fetch(broker.definition.url, { method: 'POST',
    headers: { authorization: broker.definition.headers[0].value, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  try {
    assert.equal((await post(1, 'initialize', {}, { authorization: 'wrong' })).status, 403);
    assert.equal((await post(1, 'initialize', {}, { origin: 'https://outside.test' })).status, 403);
    assert((await (await post(1, 'tools/list', {})).json()).error);
    assert((await (await post(2, 'initialize', { protocolVersion: '2025-03-26' })).json()).result);
    assert.equal((await (await post(3, 'tools/list', {})).json()).result.tools.length, 1);
    assert((await (await post(4, 'tools/call', { name: 'arbitrary', arguments: {} })).json()).error);
    assert.equal(calls, 0);
    assert.equal((await (await post(5, 'tools/call', { name: 'test_tool', arguments: {} })).json()).result.isError, false);
    assert((await (await post(5, 'tools/call', { name: 'test_tool', arguments: {} })).json()).error);
    assert((await (await post(6, 'tools/call', { name: 'test_tool', arguments: {} })).json()).error);
    assert.equal(calls, 1); assert(refusals >= 3);
  } finally { await broker.close(); }
});

test('failed tools return fixed diagnostics, and do not regain effect allowance', async () => {
  let refusals = 0;
  const broker = await startDevinMcp({ maxCalls: 1, onRefusal: () => refusals++, tools: [{ name: 'fail', description: 'fixture',
    inputSchema: { type: 'object' }, invoke: async () => { throw new Error('synthetic-secret-must-not-escape'); } }] });
  const post = async (id, method, params) => (await fetch(broker.definition.url, { method: 'POST',
    headers: { authorization: broker.definition.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
  try {
    await post(1, 'initialize', {});
    const failed = await post(2, 'tools/call', { name: 'fail', arguments: {} });
    assert.equal(failed.result.isError, true); assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/);
    assert((await post(3, 'tools/call', { name: 'fail', arguments: {} })).error); assert.equal(refusals, 2);
  } finally { await broker.close(); }
});
