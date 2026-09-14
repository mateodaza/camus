import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevinMcp } from './devin-native-mcp.mjs';

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
