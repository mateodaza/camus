import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startNativeGateway, inspectNativeProviderBody } from './native-gateway.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

test('gateway retains provider credential and enforces path, capability and exact model', async t => {
  const secret = 'synthetic-provider-secret-never-child-facing'; process.env.CAMUS_GATEWAY_TEST_KEY = secret;
  t.after(() => { delete process.env.CAMUS_GATEWAY_TEST_KEY; });
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ model: 'served-alias', choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ model: 'served-alias', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 } } })}\n\ndata: [DONE]\n\n`);
  });
  await listen(upstream); t.after(() => close(upstream));
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKeyEnv: 'CAMUS_GATEWAY_TEST_KEY', auth: { kind: 'env' } },
  model: 'selected-model', expectedReported: ['served-alias'] });
  t.after(() => gateway.close());
  assert.equal((await fetch(`${gateway.url}/models`, { headers: { authorization: `Bearer ${gateway.capability}` } })).status, 200);
  assert.equal((await fetch(`${gateway.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}` } })).status, 404);
  assert.equal((await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'other', stream: true }) })).status, 400);
  const response = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'selected-model', stream: true, messages: [{ role: 'user', content: 'fixture' }] }) });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(secret));
  assert.deepEqual(requests, [{ url: '/v1/chat/completions', auth: `Bearer ${secret}`, body: {
    model: 'selected-model', stream: true, messages: [{ role: 'user', content: 'fixture' }], stream_options: { include_usage: true } } }]);
  assert.deepEqual(gateway.state.usage, { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, total_tokens: 7 });
  assert.deepEqual([...gateway.state.reportedModels], ['served-alias']);
});

test('provider evidence refuses missing, substituted, or inconsistent identity', () => {
  assert.throws(() => inspectNativeProviderBody(Buffer.from('{}'), 'application/json', new Set(['m'])), /identity/);
  assert.throws(() => inspectNativeProviderBody(Buffer.from(JSON.stringify({ model: 'other' })), 'application/json', new Set(['m'])), /identity/);
  assert.throws(() => inspectNativeProviderBody(Buffer.from('data: nope\n\n'), 'text/event-stream', new Set(['m'])), /malformed/);
});

test('gateway close aborts an in-flight upstream request', async () => {
  let begin; const began = new Promise(resolve => { begin = resolve; }); let aborted = false;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      begin(); signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
  const pending = fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [] }) }).catch(() => null);
  await began; await gateway.close(); await pending; assert.equal(aborted, true);
});

test('gateway reserves a concurrent call slot exactly once', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', maxCalls: 1, fetchImpl: async () => {
      upstreamCalls++; await hold;
      return new Response('data: {"model":"m","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
  const first = request();
  while (upstreamCalls === 0) await new Promise(resolve => setImmediate(resolve));
  const second = await request(); assert.equal(second.status, 429); release();
  assert.equal((await first).status, 200); assert.equal(upstreamCalls, 1); assert.equal(gateway.state.calls, 1);
});
