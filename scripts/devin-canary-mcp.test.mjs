import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevinCanaryMcp } from './devin-canary-mcp.mjs';
import { request as httpRequest } from 'node:http';

test('MCP canary authenticates, accepts only the fixed verifier and consumes one call before execution', { timeout: 5000 }, async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const broker = await startDevinCanaryMcp({ verify: async () => { calls++; await gate; return true; } });
  const headers = { authorization: broker.definition.headers[0].value, 'content-type': 'application/json' };
  let id = 0;
  const request = (method, params = {}, extra = {}) => fetch(broker.definition.url, { method: 'POST', headers: { ...headers, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  try {
    assert.equal((await request('initialize', {}, { authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await request('initialize', {}, { origin: 'https://outside.test' })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(broker.definition.url, { method: 'POST', headers: { ...headers, host: 'attacker.test' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(badHostStatus, 403);
    assert((await (await request('tools/list')).json()).error);
    assert.equal((await (await request('initialize', { protocolVersion: '2025-03-26' })).json()).result.protocolVersion, '2025-03-26');
    const list = await (await request('tools/list')).json(); assert.equal(list.result.tools.length, 1);
    for (const params of [{ name: 'exec', arguments: {} }, { name: 'verify', arguments: { command: 'arbitrary' } },
      { name: 'verify', arguments: {}, cwd: '/private' }]) assert((await (await request('tools/call', params)).json()).error);
    assert.equal(calls, 0);
    const first = request('tools/call', { name: 'verify' });
    const deadline = Date.now() + 1000;
    while (calls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(calls, 1);
    assert((await (await request('tools/call', { name: 'verify', arguments: {} })).json()).error);
    release(); assert.equal((await (await first).json()).result.isError, false); assert.equal(calls, 1);
    assert((await (await request('tools/call', { name: 'verify', arguments: {} })).json()).error);
  } finally { release(); await broker.close(); }
});
