import assert from 'node:assert/strict';
import { makerRequestBudget, streamChatCompletion } from './openai-compat.mjs';

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

assert.deepEqual(makerRequestBudget('make', 'quick'), { timeoutMs: 240_000, maxTokens: 4_096 });
assert.deepEqual(makerRequestBudget('make', 'standard'), { timeoutMs: 420_000, maxTokens: 6_144 });
assert.deepEqual(makerRequestBudget('plan', 'unknown'), { timeoutMs: 90_000, maxTokens: 1_024 });

let capturedBody = null;
globalThis.fetch = async (_url, options) => {
  capturedBody = JSON.parse(options.body);
  const frame = 'data: ' + JSON.stringify({
    model: 'bounded-model',
    choices: [{ delta: { content: 'bounded result' } }],
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

  await streamChatCompletion({
    entry: { name: 'dashscope-bounded', provider: 'dashscope', baseUrl: 'https://example.invalid/v1', auth: { kind: 'none' } },
    model: 'bounded-model', prompt: 'test', timeoutMs: 100, maxTokens: 2_345,
  });
  assert.equal(capturedBody.max_completion_tokens, 2_345, 'DashScope caps reasoning plus answer with max_completion_tokens');
  assert.equal(capturedBody.max_tokens, undefined, 'DashScope never receives the answer-only cap');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai-compat.test.mjs: quick/standard calls have explicit output and wall-clock budgets');
