import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getSharedTunnelManager } from './ssh-tunnel.mjs';

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
const aliases = (model, expected) => {
  const selected = expected && typeof expected === 'object' && !Array.isArray(expected) ? expected[model] : expected;
  return new Set([model, ...(typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : [])]);
};
const zero = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 });
const usageOf = value => {
  if (!value || typeof value !== 'object') return null;
  const input = value.prompt_tokens ?? value.input_tokens;
  const output = value.completion_tokens ?? value.output_tokens;
  const cached = value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? value.cached_input_tokens ?? 0;
  const total = value.total_tokens ?? (Number.isSafeInteger(input) && Number.isSafeInteger(output) ? input + output : null);
  if (![input, output, cached, total].every(v => Number.isSafeInteger(v) && v >= 0) || cached > input || total !== input + output) return null;
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: total };
};
const sumUsage = (a, b) => ({ input_tokens: a.input_tokens + b.input_tokens,
  cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  output_tokens: a.output_tokens + b.output_tokens, total_tokens: a.total_tokens + b.total_tokens });
const outputLimitFields = Object.freeze(['max_tokens', 'max_completion_tokens', 'max_output_tokens']);

function providerOutputLimitField(entry, model) {
  if (entry?.provider === 'dashscope' && /^qwen/i.test(model)) return 'max_completion_tokens';
  return 'max_tokens';
}

function requestedOutputLimit(body) {
  const values = outputLimitFields.filter(field => Object.hasOwn(body, field)).map(field => body[field]);
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Native completion limit must be a positive integer.');
  for (const field of ['n', 'best_of']) {
    if (Object.hasOwn(body, field) && body[field] !== 1) throw new Error('Native gateway permits exactly one generated choice.');
  }
  return values.length ? Math.min(...values) : null;
}

function inspectProviderBody(buffer, contentType, allowedModels) {
  const text = buffer.toString('utf8');
  const events = [];
  if (/text\/event-stream/i.test(contentType) || text.includes('\ndata:')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (!value || value === '[DONE]') continue;
      try { events.push(JSON.parse(value)); } catch { throw new Error('Provider returned malformed streaming evidence.'); }
    }
  } else {
    try { events.push(JSON.parse(text)); } catch { throw new Error('Provider returned malformed completion evidence.'); }
  }
  const reported = new Set(); let usage = null;
  for (const event of events) {
    if (typeof event?.model === 'string' && event.model) reported.add(event.model);
    if (event?.usage) usage = usageOf(event.usage) ?? usage;
  }
  if (!reported.size || [...reported].some(model => !allowedModels.has(model))) throw new Error('Provider model identity did not match the selected native seat.');
  return { reportedModels: [...reported], usage };
}

// A native harness sees only this one-run capability. The real provider secret
// remains in the host process; request headers are rebuilt from scratch and the
// selected model/path are enforced before any upstream traffic is possible.
export async function startNativeGateway({ entry, model, expectedReported, signal, maxCalls = 32, remainingTokens,
  onProgress = () => {}, onTick = () => {}, onStop = () => {}, fetchImpl = fetch, tunnelManager = getSharedTunnelManager() }) {
  if (!entry || entry.kind !== 'openai_compat') throw new Error('Native gateway requires a frozen OpenAI-compatible backend.');
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) throw new Error('Native gateway requires a positive model-call limit.');
  if (!Number.isSafeInteger(remainingTokens) || remainingTokens <= 0) throw new Error('Native gateway requires a positive remaining token budget.');
  const keyless = entry.auth?.kind === 'none';
  const providerKey = keyless ? null : process.env[entry.apiKeyEnv];
  if (!keyless && !providerKey) throw new Error(`backend "${entry.name}" needs ${entry.apiKeyEnv} set in the environment`);
  let lease = null;
  if (entry.transport === 'ssh_tunnel' || entry.connectionDetails?.kind === 'ssh_tunnel') lease = await tunnelManager.acquire(entry.connectionDetails || entry, { signal });
  const upstreamBase = String(lease?.url ?? entry.baseUrl ?? '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(upstreamBase)) { await lease?.release(); throw new Error('Native gateway backend URL is invalid.'); }
  const capability = `camus-gw-${randomBytes(32).toString('base64url')}`;
  const lifetime = new AbortController();
  const externalAbort = () => lifetime.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  const allowedModels = aliases(model, expectedReported);
  const state = { calls: 0, accountedCalls: 0, usage: zero(), usageIncomplete: false, reportedModels: new Set(), stopped: null,
    tokenBudget: remainingTokens, tokenAllowanceRemaining: remainingTokens };
  let stopNotified = false;
  const stopFor = reason => {
    state.stopped ??= String(reason);
    if (!stopNotified) {
      stopNotified = true;
      onStop(state.stopped);
    }
    return state.stopped;
  };
  let server;
  const close = async () => {
    lifetime.abort(); signal?.removeEventListener('abort', externalAbort);
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(() => resolve())); }
    if (lease) { await lease.release(); lease = null; }
  };
  const handler = async (req, res) => {
    const fail = (status, message = 'Native model gateway refused the request.') => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message } }));
    };
    try {
      if (!safeEqual(req.headers.authorization, `Bearer ${capability}`)) return fail(401);
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: entry.provider }] }));
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return fail(404);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_REQUEST_BYTES) return fail(413); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== model || body.stream !== true) return fail(400);
      let harnessLimit;
      try { harnessLimit = requestedOutputLimit(body); } catch { return fail(400); }
      // Check and reserve synchronously after the last request-body await. This
      // prevents concurrent requests from all observing the same call or token
      // allowance. The allowance caps generated completion tokens; provider-
      // reported input/total usage can still consume more than this reservation.
      if (state.stopped) { const reason = state.stopped; fail(429, reason); stopFor(reason); return; }
      if (state.calls >= maxCalls) { const reason = 'Native model-call budget exhausted.'; fail(429, reason); stopFor(reason); return; }
      if (state.tokenAllowanceRemaining <= 0) { const reason = 'Native token allowance exhausted.'; fail(429, reason); stopFor(reason); return; }
      const completionLimit = Math.min(state.tokenAllowanceRemaining, harnessLimit ?? state.tokenAllowanceRemaining);
      state.tokenAllowanceRemaining -= completionLimit;
      state.calls++;
      const limitField = providerOutputLimitField(entry, model);
      const upstreamBody = { ...body };
      for (const field of outputLimitFields) delete upstreamBody[field];
      upstreamBody.model = model; upstreamBody.stream = true;
      upstreamBody.stream_options = { include_usage: true };
      upstreamBody[limitField] = completionLimit;
      const upstream = await fetchImpl(`${upstreamBase}/chat/completions`, { method: 'POST', signal: lifetime.signal,
        headers: { ...(keyless ? {} : { authorization: `Bearer ${providerKey}` }), 'content-type': 'application/json' },
        body: JSON.stringify(upstreamBody) });
      if (!upstream.ok) {
        state.usageIncomplete = true; state.tokenAllowanceRemaining = 0;
        return fail(502, 'Native inference provider returned an HTTP error.');
      }
      const output = []; let outputBytes = 0;
      for await (const chunk of upstream.body) {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RESPONSE_BYTES) throw new Error('Native provider response limit exceeded.');
        output.push(Buffer.from(chunk)); onTick('Native provider stream active.');
      }
      const complete = Buffer.concat(output);
      if (providerKey && complete.includes(Buffer.from(providerKey))) throw new Error('Provider response contained credential material.');
      const contentType = upstream.headers.get('content-type') ?? 'text/event-stream';
      const evidence = inspectProviderBody(complete, contentType, allowedModels);
      for (const reported of evidence.reportedModels) state.reportedModels.add(reported);
      state.accountedCalls++;
      if (evidence.usage) {
        state.usage = sumUsage(state.usage, evidence.usage);
        // Replace the completion reservation with the provider's measured total.
        // Clamp at zero: input tokens can make total usage exceed the request-side
        // output cap, and that overshoot remains visible in state.usage.
        state.tokenAllowanceRemaining = Math.max(0, state.tokenAllowanceRemaining + completionLimit - evidence.usage.total_tokens);
      } else {
        // A lower harness completion request cannot turn missing total/input
        // usage into permission for another call. The remaining aggregate
        // allowance is unknown, so fail closed for this native turn.
        state.usageIncomplete = true; state.tokenAllowanceRemaining = 0;
      }
      const reason = onProgress({ usage: evidence.usage ? state.usage : null, responses: state.calls, actions: 0 });
      if (reason) state.stopped = String(reason);
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(complete);
    } catch {
      if (state.calls > state.accountedCalls) {
        state.usageIncomplete = true; state.tokenAllowanceRemaining = 0;
      }
      fail(502, 'Native model gateway could not validate the provider response.');
    }
  };
  try {
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    const abort = () => { state.stopped = 'Native execution cancelled.'; };
    signal?.addEventListener('abort', abort, { once: true });
    return { url: `http://127.0.0.1:${address.port}/v1`, port: address.port, capability, state,
      close: async () => { signal?.removeEventListener('abort', abort); await close(); } };
  } catch (error) { await close(); throw error; }
}

export const inspectNativeProviderBody = inspectProviderBody;
