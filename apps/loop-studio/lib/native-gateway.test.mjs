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
  model: 'selected-model', expectedReported: ['served-alias'], remainingTokens: 100 });
  t.after(() => gateway.close());
  assert.equal((await fetch(`${gateway.url}/models`, { headers: { authorization: `Bearer ${gateway.capability}` } })).status, 200);
  assert.equal((await fetch(`${gateway.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}` } })).status, 404);
  assert.equal((await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'other', stream: true }) })).status, 400);
  const response = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'selected-model', stream: true, messages: [{ role: 'user', content: 'fixture' }] }) });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(secret));
  assert.deepEqual(requests, [{ url: '/v1/chat/completions', auth: `Bearer ${secret}`, body: {
    model: 'selected-model', stream: true, messages: [{ role: 'user', content: 'fixture' }],
    stream_options: { include_usage: true }, max_tokens: 100 } }]);
  assert.deepEqual(gateway.state.usage, { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, total_tokens: 7 });
  assert.deepEqual([...gateway.state.reportedModels], ['served-alias']);
});

test('provider evidence refuses missing, substituted, or inconsistent identity', () => {
  assert.throws(() => inspectNativeProviderBody(Buffer.from('{}'), 'application/json', new Set(['m'])), /identity/);
  assert.throws(() => inspectNativeProviderBody(Buffer.from(JSON.stringify({ model: 'other' })), 'application/json', new Set(['m'])), /identity/);
  assert.throws(() => inspectNativeProviderBody(Buffer.from('data: nope\n\n'), 'text/event-stream', new Set(['m'])), /malformed/);
});

test('OpenRouter native gateway pins every request and refuses missing or substituted route evidence', async t => {
  const entry = { name: 'openrouter-qwen', kind: 'openai_compat', provider: 'openrouter', auth: { kind: 'none' },
    baseUrl: 'https://openrouter.invalid/api/v1', route: { upstreamProvider: 'alibaba', allowFallbacks: false } };
  const requests = [];
  const responseFor = (provider = 'Alibaba', includeMetadata = true) => new Response([
    'data: {"model":"qwen/qwen3.5","choices":[{"delta":{"content":"ok"}}]}\n\n',
    `data: ${JSON.stringify({ model: 'qwen/qwen3.5', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      ...(includeMetadata ? { openrouter_metadata: { requested: 'qwen/qwen3.5', strategy: 'direct', attempt: 1,
        endpoints: { available: [{ provider, model: 'qwen/qwen3.5', selected: true }] } } } : {}) })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const gateway = await startNativeGateway({ entry, model: 'qwen/qwen3.5', remainingTokens: 20, fetchImpl: async (_url, options) => {
    requests.push({ headers: options.headers, body: JSON.parse(options.body) });
    return responseFor();
  } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'qwen/qwen3.5', stream: true, messages: [], provider: { only: ['attacker'] } }) });
  assert.equal((await request()).status, 200);
  assert.deepEqual(requests[0].body.provider, { only: ['alibaba'], order: ['alibaba'], allow_fallbacks: false });
  assert.equal(requests[0].headers['X-OpenRouter-Metadata'], 'enabled');
  assert.deepEqual(gateway.state.openRouterRouteEvidence, [{ attempt: 1, strategy: 'direct', selectedProvider: 'Alibaba', requested: 'qwen/qwen3.5' }]);

  assert.throws(
    () => inspectNativeProviderBody(Buffer.from('data: {"model":"qwen/qwen3.5"}\n\ndata: [DONE]\n\n'), 'text/event-stream', new Set(['qwen/qwen3.5']), entry),
    /omitted required routing metadata/,
  );
  assert.throws(
    () => inspectNativeProviderBody(Buffer.from(`data: ${JSON.stringify({ model: 'qwen/qwen3.5', openrouter_metadata: { strategy: 'direct', attempt: 1,
      endpoints: { available: [{ provider: 'Together', selected: true }] } } })}\n\ndata: [DONE]\n\n`), 'text/event-stream', new Set(['qwen/qwen3.5']), entry),
    /did not match the pinned route/,
  );
  assert.throws(
    () => inspectNativeProviderBody(Buffer.from(`data: ${JSON.stringify({ model: 'qwen/qwen3.5', openrouter_metadata: { strategy: 'direct', attempt: 2,
      endpoints: { available: [{ provider: 'Alibaba', selected: true }] } } })}\n\ndata: [DONE]\n\n`), 'text/event-stream', new Set(['qwen/qwen3.5']), entry),
    /single-attempt pinned route/,
  );
});

test('gateway close aborts an in-flight upstream request', async () => {
  let begin; const began = new Promise(resolve => { begin = resolve; }); let aborted = false;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 100, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      begin(); signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
  const pending = fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [] }) }).catch(() => null);
  await began; await gateway.close(); await pending; assert.equal(aborted, true);
});

test('gateway reserves a concurrent call slot exactly once', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', maxCalls: 1, remainingTokens: 100, fetchImpl: async () => {
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

test('gateway turns a local model-call refusal into one immediate harness stop', async t => {
  let upstreamCalls = 0; const stops = [];
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', maxCalls: 1, remainingTokens: 100, onStop: reason => stops.push(reason), fetchImpl: async () => {
      upstreamCalls++;
      return new Response('data: {"model":"m","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
  assert.equal((await request()).status, 200);
  const refused = await request(); assert.equal(refused.status, 429);
  assert.match(await refused.text(), /Native model-call budget exhausted/);
  assert.deepEqual(stops, ['Native model-call budget exhausted.']);
  assert.equal(upstreamCalls, 1, 'the refused request never reaches the provider');
  assert.equal((await request()).status, 429); assert.equal(stops.length, 1, 'the stop notification is idempotent');
});

test('gateway emits the provider-specific completion field and never widens a harness limit', async t => {
  const rows = [
    [{ provider: 'xai' }, 'grok-4.6', 'max_tokens'],
    [{ provider: 'dashscope' }, 'qwen3.8-27b', 'max_completion_tokens'],
    [{ provider: 'self_hosted' }, 'custom-model', 'max_tokens'],
  ];
  for (const [extra, model, field] of rows) {
    const bodies = [];
    const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1', ...extra },
      model, remainingTokens: 50, fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(`data: {"model":${JSON.stringify(model)},"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } });
      } });
    t.after(() => gateway.close());
    const response = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
      authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [], max_tokens: 9, max_completion_tokens: 7, max_output_tokens: 8 }) });
    assert.equal(response.status, 200);
    assert.equal(bodies[0][field], 7, `${extra.provider} uses its provider field and preserves the lowest requested limit`);
    for (const other of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      assert.equal(Object.hasOwn(bodies[0], other), other === field, `${extra.provider} strips ${other}`);
    }
  }
});

test('gateway refuses multiplicative completion fields before provider dispatch', async t => {
  let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 100, fetchImpl: async () => { upstreamCalls++; throw new Error('must not dispatch'); } });
  t.after(() => gateway.close());
  for (const body of [{ n: 2 }, { best_of: 2 }, { n: 0 }, { best_of: null }]) {
    const response = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
      authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [], ...body }) });
    assert.equal(response.status, 400);
  }
  assert.equal(upstreamCalls, 0);
});

test('gateway accounts multiple calls against one aggregate completion allowance', async t => {
  const limits = [], usages = [[1, 2], [2, 5]];
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 10, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); limits.push(body.max_tokens);
      const [input, output] = usages.shift(); const total = input + output;
      return new Response(`data: {"model":"m","usage":{"prompt_tokens":${input},"completion_tokens":${output},"total_tokens":${total}}}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = limit => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [], ...(limit ? { max_tokens: limit } : {}) }) });
  assert.equal((await request(4)).status, 200);
  assert.equal(gateway.state.tokenAllowanceRemaining, 7, 'unused completion reservation is replaced by measured total usage');
  assert.equal((await request()).status, 200);
  assert.deepEqual(limits, [4, 7]);
  assert.equal(gateway.state.tokenAllowanceRemaining, 0);
  assert.equal((await request()).status, 429); assert.equal(limits.length, 2, 'zero allowance refuses before provider dispatch');
});

test('gateway reserves completion allowance synchronously across concurrent calls', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 5, fetchImpl: async () => {
      upstreamCalls++; await hold;
      return new Response('data: {"model":"m","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
  const first = request(); while (!upstreamCalls) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request()).status, 429); assert.equal(upstreamCalls, 1);
  release(); assert.equal((await first).status, 200);
});

test('input usage can honestly exceed the output cap and exhaust later calls', async t => {
  let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 5, fetchImpl: async (_url, options) => {
      upstreamCalls++; assert.equal(JSON.parse(options.body).max_tokens, 5);
      return new Response('data: {"model":"m","usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [] }) });
  assert.equal((await request()).status, 200);
  assert.equal(gateway.state.usage.total_tokens, 11); assert.equal(gateway.state.tokenAllowanceRemaining, 0);
  assert.equal((await request()).status, 429); assert.equal(upstreamCalls, 1);
});

test('upstream failure after a lower completion reservation exhausts unknown allowance', async t => {
  let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 100, fetchImpl: async () => { upstreamCalls++; return new Response('failure', { status: 500 }); } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [], max_tokens: 10 }) });
  assert.equal((await request()).status, 502); assert.equal(gateway.state.tokenAllowanceRemaining, 0);
  assert.equal((await request()).status, 429); assert.equal(upstreamCalls, 1);
});

test('missing usage after a lower completion reservation blocks another provider call', async t => {
  let upstreamCalls = 0;
  const gateway = await startNativeGateway({ entry: { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' }, baseUrl: 'http://127.0.0.1:9/v1' },
    model: 'm', remainingTokens: 100, fetchImpl: async () => {
      upstreamCalls++;
      return new Response('data: {"model":"m","choices":[]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => gateway.close());
  const request = () => fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${gateway.capability}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', stream: true, messages: [], max_tokens: 10 }) });
  assert.equal((await request()).status, 200); assert.equal(gateway.state.usageIncomplete, true);
  assert.equal(gateway.state.tokenAllowanceRemaining, 0);
  assert.equal((await request()).status, 429); assert.equal(upstreamCalls, 1);
});
