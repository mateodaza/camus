import assert from 'node:assert/strict';
import { makerRequestBudget, openAiCompatMaker, streamChatCompletion } from './openai-compat.mjs';

await assert.rejects(
  streamChatCompletion({
    entry: {
      name: 'missing-key',
      transport: 'ssh_tunnel',
      apiKeyEnv: 'CAMUS_TEST_MISSING_KEY',
      auth: { kind: 'bearer' },
      // Deliberately invalid: missing credentials must be diagnosed before a
      // tunnel acquisition can validate or spawn anything.
      connectionDetails: { kind: 'ssh_tunnel', name: 'missing-key', sshHostAlias: '-invalid', remoteAddress: '127.0.0.1', remotePort: 11434 },
    },
    model: 'test', prompt: 'test', timeoutMs: 100,
  }),
  (error) => error.code === 'missing_key',
);

console.log('openai-compat.test.mjs: missing credential releases no tunnel');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'raw-secret-banner host.example 127.0.0.1:45555' });
try {
  await assert.rejects(
    streamChatCompletion({
      entry: { name: 'private-connection', transport: 'ssh_tunnel', connection: 'private-connection', auth: { kind: 'none' }, tunnelLease: {
        url: 'http://127.0.0.1:45555/v1', death: new Promise(() => {}), release: async () => {},
      } }, model: 'test', prompt: 'test', timeoutMs: 100,
    }),
    (error) => error.code === 'http' && error.message.includes('connection "private-connection"')
      && !error.message.includes('45555') && !error.message.includes('raw-secret-banner') && !error.message.includes('host.example'),
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai-compat.test.mjs: tunnel HTTP errors are private and lease-owned');

assert.deepEqual(makerRequestBudget('make', 'quick'), { timeoutMs: 240_000, maxTokens: 4_096, thinkingTokens: 1_024 });
assert.deepEqual(makerRequestBudget('make', 'standard'), { timeoutMs: 420_000, maxTokens: 6_144, thinkingTokens: 1_536 });
assert.deepEqual(makerRequestBudget('plan', 'unknown'), { timeoutMs: 90_000, maxTokens: 1_024, thinkingTokens: 256 });

let capturedBody = null;
globalThis.fetch = async (_url, options) => {
  capturedBody = JSON.parse(options.body);
  const frame = 'data: ' + JSON.stringify({
    model: 'bounded-model',
    choices: [{ delta: { content: 'bounded result' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  }) + '\n\ndata: [DONE]\n\n';
  return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }) };
};
try {
  const result = await streamChatCompletion({
    entry: { name: 'bounded', baseUrl: 'https://example.invalid/v1', auth: { kind: 'none' } },
    model: 'bounded-model', prompt: 'test', timeoutMs: 100, maxTokens: 1_234,
  });
  assert.equal(result.text, 'bounded result');
  assert.equal(capturedBody.max_tokens, 1_234, 'the production request carries the explicit completion ceiling');
  assert.equal(capturedBody.max_completion_tokens, undefined, 'ordinary compatibility targets keep the common max_tokens spelling');
  assert.equal(capturedBody.stream_options.include_usage, true, 'usage streaming remains enabled beside the ceiling');
  assert.equal(result.finishReason, 'length', 'the provider finish reason survives streaming for retry classification');

  await streamChatCompletion({
    entry: { name: 'dashscope-bounded', provider: 'dashscope', baseUrl: 'https://example.invalid/v1', auth: { kind: 'none' } },
    model: 'qwen3.8-test', prompt: 'test', timeoutMs: 100, maxTokens: 2_345, thinkingTokens: 512,
  });
  assert.equal(capturedBody.max_completion_tokens, 2_345, 'DashScope caps reasoning plus answer with max_completion_tokens');
  assert.equal(capturedBody.max_tokens, undefined, 'DashScope never receives the answer-only cap');
  assert.equal(capturedBody.enable_thinking, true, 'Qwen 3 reasoning remains explicitly enabled');
  assert.equal(capturedBody.thinking_budget, 512, 'Qwen 3 reasoning is bounded separately so answer tokens remain');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai-compat.test.mjs: quick/standard calls have explicit output and wall-clock budgets');

let openRouterRequest = null;
globalThis.fetch = async (_url, options) => {
  openRouterRequest = { headers: options.headers, body: JSON.parse(options.body) };
  const frame = [
    { model: 'qwen/qwen3.5', choices: [{ delta: { content: 'pinned' }, finish_reason: null }] },
    { model: 'qwen/qwen3.5', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 }, openrouter_metadata: {
      requested: 'qwen/qwen3.5', strategy: 'direct', attempt: 1,
      endpoints: { available: [{ provider: 'Alibaba', model: 'qwen/qwen3.5', selected: true }] },
    } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }) };
};
const openRouterEntry = { name: 'openrouter-qwen', provider: 'openrouter', baseUrl: 'https://openrouter.invalid/api/v1', auth: { kind: 'none' },
  route: { upstreamProvider: 'alibaba', allowFallbacks: false } };
try {
  const result = await streamChatCompletion({ entry: openRouterEntry, model: 'qwen/qwen3.5', prompt: 'test', timeoutMs: 100, maxTokens: 321 });
  assert.deepEqual(openRouterRequest.body.provider, { only: ['alibaba'], order: ['alibaba'], allow_fallbacks: false },
    'every OpenRouter completion is pinned to exactly one upstream with fallbacks disabled');
  assert.equal(openRouterRequest.headers['X-OpenRouter-Metadata'], 'enabled');
  assert.equal(openRouterRequest.body.max_tokens, 321);
  assert.deepEqual(result.openRouterRouteEvidence, { attempt: 1, strategy: 'direct', selectedProvider: 'Alibaba', requested: 'qwen/qwen3.5' });
  const maker = await openAiCompatMaker(openRouterEntry)({
    prompt: 'test', model: 'qwen/qwen3.5', toolPolicy: 'research',
  });
  assert.deepEqual(maker.routeObservation, {
    requestEnforced: { upstreamProvider: 'alibaba', allowFallbacks: false },
    metadataObserved: [{ provider: 'Alibaba', attempt: 1 }],
  }, 'the successful raw maker result preserves normalized verified OpenRouter route evidence');

  globalThis.fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    const frames = [
      { model: 'qwen/qwen3.5', choices: [{ delta: { content: 'partial' } }] },
      { model: 'qwen/qwen3.5', choices: [], error: { code: 'provider_error', message: 'untrusted provider detail' },
        openrouter_metadata: { requested: 'qwen/qwen3.5', strategy: 'direct', attempt: 1,
          endpoints: { available: [{ provider: 'Alibaba', selected: true }] } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    controller.enqueue(new TextEncoder().encode(frames)); controller.close();
  } }) });
  await assert.rejects(
    streamChatCompletion({ entry: openRouterEntry, model: 'qwen/qwen3.5', prompt: 'test', timeoutMs: 100 }),
    (error) => error.code === 'provider_stream' && /provider_error/.test(error.message)
      && !/untrusted provider detail/.test(error.message),
    'an HTTP-200 streaming error is explicit and its untrusted message stays private',
  );

  globalThis.fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    const frame = [
      { model: 'qwen/qwen3.5', choices: [{ delta: { content: 'complete' } }] },
      { model: 'qwen/qwen3.5', choices: [], openrouter_metadata: { requested: 'qwen/qwen3.5', strategy: 'direct', attempt: 1,
        endpoints: { available: [{ provider: 'Alibaba', selected: true }] } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    controller.enqueue(new TextEncoder().encode(frame)); controller.close();
  } }) });
  await assert.rejects(
    streamChatCompletion({ entry: openRouterEntry, model: 'qwen/qwen3.5', prompt: 'test', timeoutMs: 100 }),
    (error) => error.code === 'usage_missing',
    'a successful-looking OpenRouter stream without final usage evidence fails closed',
  );

  globalThis.fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"model":"qwen/qwen3.5","choices":[{"delta":{"content":"cached"}}]}\n\ndata: [DONE]\n\n'));
    controller.close();
  } }) });
  await assert.rejects(
    streamChatCompletion({ entry: openRouterEntry, model: 'qwen/qwen3.5', prompt: 'test', timeoutMs: 100 }),
    /omitted required routing metadata/,
    'cache hits and other responses without current route evidence fail closed',
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai-compat.test.mjs: OpenRouter calls pin and verify one exact upstream route');
