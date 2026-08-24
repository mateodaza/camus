// Focused mocked-protocol tests for the Slice C §9.2 capability-probe runner
// (docs/OPEN-MODEL-SEATS-RFC.md §9.2, §9.4, §9.1, §6.1). Hermetic: a real
// loopback HTTP server streams crafted SSE fixtures, and the probes run through
// the PRODUCTION openai-compat `streamChatCompletion` adapter and the PRODUCTION
// reviewer `normalizeReview` path — no network, no real provider, no mocks of
// the code under test. A temp STUDIO dir per suite holds the salt + receipts.
//
// No secret-shaped fixture is a literal beyond the obvious fake token, and the
// no-secret-artifacts test reads the raw receipt bytes AND the returned error to
// prove the credential value never lands on disk or in an error string.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deepQualifyModel,
  reconcileModelIdentity,
  redactProviderError,
  collectServerAnchors,
  seatQualification,
  qualifyUsedSeats,
  isSupportedTransport,
  expectedReportedFor,
} from './capability-probes.mjs';

const dirs = [];
const servers = [];
function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'capprobe-'));
  dirs.push(dir);
  process.env.STUDIO_GRANDFATHER_DIR = dir;
  delete process.env.STUDIO_CAPABILITY_DIR;
  delete process.env.STUDIO_CAPABILITY_TTL_DAYS;
  return dir;
}

// ---- crafted SSE plumbing --------------------------------------------------

const ev = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
// `promptTokens` mirrors a real endpoint's usage object (stream_options
// include_usage). The context probe now MEASURES the window from this reported
// usage rather than from a character count, so a compliant mock reports a prompt
// size that clears the probe's small test target.
function sseBody({ text = 'ok', model, done = true, promptTokens = 100000 }) {
  let s = '';
  if (model) s += ev({ model, choices: [{ delta: {} }] });
  for (const ch of String(text).match(/.{1,4}/g) ?? [text]) s += ev({ model, choices: [{ delta: { content: ch } }] });
  if (Number.isFinite(promptTokens)) s += ev({ model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 8 } });
  if (done) s += 'data: [DONE]\n\n';
  return s;
}

const REVIEW_JSON = JSON.stringify({
  verdict: 'clean', findings: [], questions_for_human: [],
  claim_assessments: [], coverage_assessments: [], threshold_assessments: [],
});

// A mock endpoint. `route(kind, req)` → { status, body, chunks?, model } where
// kind ∈ 'structured' | 'liveness' | 'context'. Records seen Authorization
// headers so keyless behavior is assertable.
function startServer(route) {
  const seenAuth = [];
  const seenUrls = [];
  const server = http.createServer((req, res) => {
    seenUrls.push(req.url);
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'served-alias', context_length: 32768 }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seenAuth.push(req.headers.authorization ?? null);
      const prompt = (() => { try { return JSON.parse(raw).messages[0].content; } catch { return ''; } })();
      const kind = /context envelope/.test(prompt) ? 'context'
        : /review schema/.test(prompt) ? 'structured' : 'liveness';
      const r = route(kind, { prompt, headers: req.headers }) || {};
      const status = r.status ?? 200;
      if (status !== 200) { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(r.body ?? 'error'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The context probe now requires BOTH the head and the tail MARKER to
      // round-trip, so a compliant mock endpoint echoes both back verbatim (unless
      // the route forces an explicit failure body). A truncating server is
      // simulated with a non-200 status instead.
      let bodyText = r.body ?? 'ok';
      if (kind === 'context' && r.chunks === undefined) {
        const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1];
        const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1];
        if (head && tail) bodyText = `${head} ${tail}`;
      }
      // The context probe measures the window from the endpoint's OWN reported
      // prompt usage, so a compliant mock reports usage DERIVED FROM THE ACTUAL
      // REQUEST rather than a fixed figure — this validates that the production
      // filler is genuinely large enough. A deliberately conservative chars/8
      // (pessimistic vs. real BPE) means an undersized filler would fail here.
      const promptTokens = kind === 'context' ? Math.floor(prompt.length / 8) : 100000;
      const chunks = r.chunks ?? [sseBody({ text: bodyText, model: r.model, done: r.done !== false, promptTokens })];
      for (const c of chunks) res.write(c);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, seenAuth, seenUrls, server });
    });
  });
}

function envEntry(baseUrl) {
  return {
    name: 'testcompat', kind: 'openai_compat', provider: 'testprov',
    baseUrl, apiKeyEnv: 'CAP_TEST_KEY', transport: 'loopback',
    protocol: 'chat_completions', auth: { kind: 'env', envVar: 'CAP_TEST_KEY' },
  };
}

const SECRET = 'sk-fake-probe-secret-000111222';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok - ${name}`); }

// ---- pure-unit guards ------------------------------------------------------

await test('reconcileModelIdentity: confirmed / asserted_pin / mapped / substituted', () => {
  assert.equal(reconcileModelIdentity({ requested: 'm', reported: 'm' }).mode, 'confirmed');
  assert.equal(reconcileModelIdentity({ requested: 'm', reported: null }).mode, 'asserted_pin');
  const mapped = reconcileModelIdentity({ requested: 'm', reported: 'alias', expectedReported: ['alias'] });
  assert.equal(mapped.mode, 'mapped'); assert.equal(mapped.ok, true);
  const sub = reconcileModelIdentity({ requested: 'm', reported: 'other' });
  assert.equal(sub.ok, false); assert.equal(sub.mode, 'substituted');
  const subMapped = reconcileModelIdentity({ requested: 'm', reported: 'other', expectedReported: ['alias'] });
  assert.equal(subMapped.ok, false);
});

await test('redactProviderError scrubs the credential value and generic key shapes', () => {
  const msg = redactProviderError(`401 {"error":"bad key ${SECRET}","authorization":"Bearer ${SECRET}"}`, { secretValue: SECRET });
  assert.ok(!msg.includes(SECRET), 'the raw secret is gone');
  assert.match(redactProviderError('Authorization: Bearer abcd1234efgh'), /‹redacted›/);
});

await test('collectServerAnchors records absent anchors, never invents them', async () => {
  const { baseUrl } = await startServer(() => ({}));
  const withModels = await collectServerAnchors({ entry: envEntry(baseUrl), model: 'served-alias' });
  assert.match(withModels.serialized, /servedModel=served-alias/);
  assert.match(withModels.serialized, /ctx=32768/);
  assert.match(withModels.serialized, /build=absent/); // no build reported → absent, not skipped
});

// ---- happy path ------------------------------------------------------------

await test('happy path: reviewer qualifies through the real adapter + normalizeReview', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl, seenAuth } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' }
      : { body: 'CAMUS-CTX-OK echoed', model: 'served-alias' });
  const progress = [];
  const res = await deepQualifyModel({
    entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(res.qualified, true, res.reason);
  assert.equal(res.capabilities.structuredOutput, 'demonstrated');
  assert.equal(res.capabilities.streaming, 'demonstrated');
  assert.equal(res.capabilities.contextWindow.status, 'demonstrated');
  assert.equal(res.capabilities.toolCalling, 'not_applicable'); // words seat: never probed
  assert.equal(res.identity.mode, 'confirmed');
  assert.ok(seenAuth.every((a) => a === `Bearer ${SECRET}`), 'env auth sends the bearer from the environment');
  assert.equal(progress[0].phase, 'discovery');
  assert.ok(progress.some((event) => event.phase === 'streaming' && event.status === 'demonstrated'));
  assert.ok(progress.some((event) => event.phase === 'structuredOutput' && event.status === 'demonstrated'));
  assert.ok(progress.some((event) => event.phase === 'contextWindow' && event.status === 'demonstrated'));
  assert.equal(progress.at(-1).phase, 'qualification');
  assert.equal(progress.at(-1).status, 'demonstrated');
});

await test('happy path: words_maker qualifies with structuredOutput not_applicable', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer(() => ({ body: 'a short sentence.', model: 'served-alias' }));
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_maker', contextProbeTokens: 64 });
  assert.equal(res.qualified, true, res.reason);
  assert.equal(res.capabilities.structuredOutput, 'not_applicable');
  assert.equal(res.capabilities.contextWindow.status, 'demonstrated');
});

// ---- torn SSE / missing DONE tolerance -------------------------------------

await test('torn SSE with an unparseable frame and NO [DONE] still qualifies', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) => {
    if (kind === 'structured') {
      // a garbage frame the adapter must tolerate, the real verdict, and no [DONE]
      const chunks = [
        'data: {partial-json-never-parses\n\n',
        ev({ model: 'served-alias', choices: [{ delta: { content: REVIEW_JSON } }] }),
        // deliberately omit data:[DONE]
      ];
      return { chunks };
    }
    return { body: 'CAMUS-CTX-OK', model: 'served-alias' };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, true, res.reason);
  assert.equal(res.capabilities.structuredOutput, 'demonstrated');
});

// ---- malformed verdict -----------------------------------------------------

await test('malformed verdict fails structured-output and does not qualify (receipt written)', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: 'this is prose, not a verdict', model: 'served-alias' }
      : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false);
  assert.equal(res.capabilities.structuredOutput, 'failed');
  assert.ok(res.missing.includes('structuredOutput'));
  assert.ok(readdirSync(join(dir, 'capabilities')).length === 1, 'the actual failed result is still recorded durably');
});

// ---- small context ---------------------------------------------------------

await test('a context window below the envelope fails the context probe', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'context' ? { status: 400, body: 'context length exceeded' }
      : { body: REVIEW_JSON, model: 'served-alias' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false);
  assert.equal(res.capabilities.contextWindow.status, 'failed');
  assert.ok(res.missing.includes('contextWindow'));
});

await test('a silently LEFT-truncated window (only the tail marker survives) fails the context probe', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // Simulate a server that dropped the HEAD of the prompt (small runtime num_ctx):
  // it echoes only the surviving tail marker, yet reports a large declared window.
  const { baseUrl } = await startServer((kind, { prompt }) => {
    if (kind !== 'context') return { body: REVIEW_JSON, model: 'served-alias' };
    const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    // Big usage + big declared /models window — neither may rescue a lost head.
    return { chunks: [sseBody({ text: tail, model: 'served-alias', promptTokens: 100000 })], model: 'served-alias' };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false, 'a lost head marker must never qualify');
  assert.equal(res.capabilities.contextWindow.status, 'failed');
});

await test('a declared max context window does NOT substitute for measured usage', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // Both markers round-trip, but the endpoint reports NO usage. The declared
  // /models window (32768) must not stand in for a measured effective window.
  const { baseUrl } = await startServer((kind, { prompt }) => {
    if (kind !== 'context') return { body: REVIEW_JSON, model: 'served-alias' };
    const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    return { chunks: [sseBody({ text: `${head} ${tail}`, model: 'served-alias', promptTokens: NaN })], model: 'served-alias' };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false, 'unmeasured usage must fail closed, not trust the declared maximum');
  assert.equal(res.capabilities.contextWindow.status, 'failed');
});

await test('a liveness stream with NO content delta records streaming:failed durably (overwrites a stale receipt)', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // The maker liveness request answers with an EMPTY body (a model event but no
  // content delta). A clean return that produced no SSE delta is an ACTUAL failed
  // probe result: streaming is recorded `failed` and a receipt is durably written
  // — like a malformed structured-output or a failed context probe — so a
  // previously-demonstrated receipt cannot linger and keep admitting a backend
  // whose stream has regressed to empty/[DONE]-only output.
  const { baseUrl } = await startServer((kind) =>
    kind === 'context' ? { model: 'served-alias' } : { body: '', model: 'served-alias' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_maker', contextProbeTokens: 64 });
  assert.equal(res.qualified, false, 'no observed delta must not qualify');
  assert.equal(res.capabilities.streaming, 'failed', 'the failed streaming probe is recorded, not dropped');
  const capDir = join(dir, 'capabilities');
  assert.equal(existsSync(capDir) ? readdirSync(capDir).length : 0, 1, 'the failed streaming result is written durably so a stale demonstrated receipt cannot survive');
});

await test('the context probe adaptively grows to reach the envelope from below', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // A tokenizer that charges ~1 token per 20 chars — the initial conservative
  // filler estimate undershoots the target, so the probe MUST resize upward using
  // the endpoint's own reported usage until it clears the envelope.
  let maxContextUsage = 0;
  const { baseUrl } = await startServer((kind, { prompt }) => {
    if (kind !== 'context') return { body: REVIEW_JSON, model: 'served-alias' };
    const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    const promptTokens = Math.floor(prompt.length / 20);
    maxContextUsage = Math.max(maxContextUsage, promptTokens);
    return { chunks: [sseBody({ text: `${head} ${tail}`, model: 'served-alias', promptTokens })], model: 'served-alias' };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, true, res.reason);
  assert.equal(res.capabilities.contextWindow.status, 'demonstrated');
  assert.ok(res.capabilities.contextWindow.demonstratedAt >= 64, 'the demonstrated window clears the target');
  // Convergence from below keeps the crossing request modest, never a blind
  // multiple of the target (the old fixed-multiplier overshoot).
  assert.ok(maxContextUsage < 64 * 3, `the probe did not grossly overshoot the target (saw ${maxContextUsage})`);
});

// ---- wrong / silent model identity -----------------------------------------

await test('a mid-stream model substitution fails closed even when the LAST event reports the requested model', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // The structured probe reports an undeclared model on an early content event and
  // the requested model on a later one. Trusting the last value would erase the
  // substitution; reconciliation across ALL reported identities must reject it.
  const { baseUrl } = await startServer((kind) => {
    if (kind !== 'structured') return { body: 'CAMUS-CTX-OK', model: 'served-alias' };
    const chunks = [
      ev({ model: 'sneaky-other', choices: [{ delta: { content: '{"verdict":"clean",' } }] }),
      ev({ model: 'served-alias', choices: [{ delta: { content: '"findings":[],"questions_for_human":[],"claim_assessments":[],"coverage_assessments":[],"threshold_assessments":[]}' } }] }),
      'data: [DONE]\n\n',
    ];
    return { chunks };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false);
  assert.equal(res.reason, 'model_substituted');
  const capDir = join(dir, 'capabilities');
  assert.equal(existsSync(capDir) ? readdirSync(capDir).length : 0, 0, 'a mid-stream substitution writes no receipt');
});

await test('an unexpected substitution fails closed BEFORE a verdict is consumed — no receipt', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer(() => ({ body: REVIEW_JSON, model: 'sneaky-other-model' }));
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false);
  assert.equal(res.reason, 'model_substituted');
  assert.equal(res.identity.mode, 'substituted');
  const capDir = join(dir, 'capabilities');
  assert.equal(existsSync(capDir) ? readdirSync(capDir).length : 0, 0, 'a substituted model writes no receipt');
});

await test('a failed re-qualification revokes the older successful receipt', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  let mode = 'ok';
  const { baseUrl } = await startServer((kind) => {
    if (mode === 'unreachable' && kind === 'structured') return { status: 503, body: 'temporarily unavailable' };
    if (kind === 'structured') return { body: REVIEW_JSON, model: mode === 'substituted' ? 'wrong-model' : 'served-alias' };
    return { body: 'CAMUS-CTX-OK', model: 'served-alias' };
  });
  const entry = envEntry(baseUrl);
  const qualify = () => deepQualifyModel({ entry, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal((await qualify()).qualified, true, 'control earns the original receipt');
  const capDir = join(dir, 'capabilities');
  assert.equal(readdirSync(capDir).length, 1);

  mode = 'substituted';
  const substituted = await qualify();
  assert.equal(substituted.reason, 'model_substituted');
  assert.equal(readdirSync(capDir).length, 0, 'a substitution cannot leave the earlier demonstrated receipt active');
  assert.equal((await seatQualification({ entry, model: 'served-alias', seatType: 'words_reviewer' })).qualified, false);

  mode = 'ok';
  assert.equal((await qualify()).qualified, true, 'the tuple can earn a new receipt after the endpoint is repaired');
  mode = 'unreachable';
  const unreachable = await qualify();
  assert.equal(unreachable.reason, 'probe_unreachable');
  assert.equal(readdirSync(capDir).length, 0, 'an unreachable re-probe cannot preserve stale demonstrated evidence');
});

await test('a silent (absent) reported model is an asserted_pin and can qualify', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON } /* no model field */ : { body: 'CAMUS-CTX-OK' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.identity.mode, 'asserted_pin');
  assert.equal(res.qualified, true, res.reason);
});

await test('a declared expected-reported alias maps instead of substituting', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const res = await deepQualifyModel({
    entry: envEntry(baseUrl), model: 'qwen2.5:7b', seatType: 'words_reviewer',
    expectedReported: ['served-alias'], contextProbeTokens: 64,
  });
  assert.equal(res.identity.mode, 'mapped');
  assert.equal(res.qualified, true, res.reason);
});

// ---- keyless loopback ------------------------------------------------------

await test('keyless loopback (auth.kind none) qualifies with NO Authorization header', async () => {
  freshEnv();
  const { baseUrl, seenAuth } = await startServer((kind, { headers }) => {
    if (headers.authorization) return { status: 401, body: 'unexpected credential' };
    return kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' };
  });
  const entry = { ...envEntry(baseUrl), auth: { kind: 'none' }, apiKeyEnv: 'CAMUS_NO_AUTH' };
  const res = await deepQualifyModel({ entry, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, true, res.reason);
  assert.ok(seenAuth.every((a) => a == null), 'no bearer credential is ever emitted for a keyless seat');
});

// ---- expiry / drift handoff ------------------------------------------------

await test('the written receipt hands off to capabilities: expiry voids, a drift component voids', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, true, res.reason);

  const { validateReceiptAgainstInput, computeFingerprint } = await import('./capabilities.mjs');
  const input = {
    seatType: 'words_reviewer', backendName: 'testcompat', backendKind: 'openai_compat',
    connection: res.receipt.components.find((c) => c.name === 'connection').value,
    protocol: 'chat_completions', requestedModelId: 'served-alias',
    auth: { kind: 'env', envVarName: 'CAP_TEST_KEY', value: SECRET },
    serverAnchors: res.receipt.components.find((c) => c.name === 'serverAnchors').value,
    normalizerVersion: res.receipt.components.find((c) => c.name === 'normalizerVersion').value,
    promptEnvelopeVersion: res.receipt.components.find((c) => c.name === 'promptEnvelopeVersion').value,
    decodingKnobs: res.receipt.components.find((c) => c.name === 'decodingKnobs').value,
    executorVersion: 'none', adapterContractVersion: res.receipt.components.find((c) => c.name === 'adapterContractVersion').value,
    gateScope: 'n/a',
  };
  // live fingerprint matches → valid now, expired far in the future
  assert.equal(validateReceiptAgainstInput(res.receipt, input, { now: Date.parse(res.receipt.probedAt) + 1000 }).ok, true);
  const expired = validateReceiptAgainstInput(res.receipt, input, { now: Date.parse(res.receipt.expiresAt) + 1000 });
  assert.equal(expired.state, 'expired');
  // a drift on any bound component voids and names it
  const drift = validateReceiptAgainstInput(res.receipt, { ...input, adapterContractVersion: 'oai-compat-runner-999' }, { now: Date.parse(res.receipt.probedAt) + 1000 });
  assert.equal(drift.state, 'voided');
  assert.equal(drift.component, 'adapterContractVersion');
  // sanity: computeFingerprint reproduces the stored fingerprint
  assert.equal(computeFingerprint(input, { create: false }).fingerprint, res.receipt.fingerprint);
});

// ---- no-secret artifacts ---------------------------------------------------

await test('no-secret artifacts: the credential value never lands on disk or in error text', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // The provider echoes the credential in a 500 body; the runner must redact it.
  const { baseUrl } = await startServer((kind) =>
    kind === 'context' ? { status: 500, body: `boom leaked ${SECRET} in body` }
      : { body: REVIEW_JSON, model: 'served-alias' });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  // context failed but a receipt of the ACTUAL results was written
  assert.equal(res.capabilities.contextWindow.status, 'failed');
  const files = readdirSync(join(dir, 'capabilities'));
  assert.equal(files.length, 1);
  const bytes = readFileSync(join(dir, 'capabilities', files[0]), 'utf8');
  assert.ok(!bytes.includes(SECRET), 'the credential value is never written to the receipt');
  // and had an error surfaced anywhere, it would be redacted
  assert.ok(!JSON.stringify(res).includes(SECRET), 'no returned field leaks the credential');
});

// ---- run-admission gate (Slice C §9.2/§9.4) --------------------------------

await test('seatQualification admits a probed seat against live anchors and returns the accepted fingerprint', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const entry = envEntry(baseUrl);
  const probed = await deepQualifyModel({ entry, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(probed.qualified, true, probed.reason);

  // Admission re-collects live anchors and reconciles the fingerprint against
  // them; with the endpoint unchanged they match and it copies the fingerprint.
  const admit = await seatQualification({ entry, model: 'served-alias', seatType: 'words_reviewer' });
  assert.equal(admit.qualified, true, admit.reason);
  assert.equal(admit.fingerprint, probed.receipt.fingerprint, 'the run snapshot records the accepted fingerprint');
});

await test('seatQualification voids the receipt when live server anchors drift', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // First server: qualify with ctx=32768. deepQualifyModel and the receipt bind
  // that live anchor set.
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const entry = envEntry(baseUrl);
  const probed = await deepQualifyModel({ entry, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(probed.qualified, true, probed.reason);

  // A fetch stub standing in for a drifted server: same listing shape, changed
  // context length. Live admission must recompute the fingerprint from it and
  // void the receipt naming serverAnchors — no stale launch.
  const driftedFetch = async (url, opts) => {
    if (String(url).endsWith('/models') && (!opts || opts.method === undefined)) {
      return new Response(JSON.stringify({ data: [{ id: 'served-alias', context_length: 8192 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  const admit = await seatQualification({ entry, model: 'served-alias', seatType: 'words_reviewer', fetchImpl: driftedFetch });
  assert.equal(admit.qualified, false, 'a changed live anchor must not launch on the stale receipt');
  assert.equal(admit.component, 'serverAnchors');
  assert.equal(admit.fingerprint, undefined);
});

await test('seatQualification refuses a seat with no receipt (a seat may not launch unqualified)', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl, seenUrls } = await startServer((kind) => ({ body: kind === 'structured' ? REVIEW_JSON : 'ok', model: 'served-alias' }));
  const admit = await seatQualification({ entry: envEntry(baseUrl), model: 'never-probed', seatType: 'words_reviewer' });
  assert.equal(admit.qualified, false);
  assert.equal(admit.reason, 'missing');
  assert.equal(admit.fingerprint, undefined);
});

await test('managed ssh_tunnel is supported while legacy_http remains refused', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl, seenUrls } = await startServer((kind) => ({ body: kind === 'structured' ? REVIEW_JSON : 'ok', model: 'served-alias' }));
  const ssh = { ...envEntry('http://127.0.0.1:9/static'), transport: 'ssh_tunnel', connectionDetails: { kind: 'ssh_tunnel', name: 'gpu', sshHostAlias: 'gpu', remoteAddress: '127.0.0.1', remotePort: 11434, basePath: '/v1' } };
  assert.equal(isSupportedTransport(ssh), true);
  assert.equal(isSupportedTransport({ ...envEntry(baseUrl), transport: 'legacy_http' }), false);
  assert.equal(isSupportedTransport(envEntry(baseUrl)), true);
  let acquired = 0;
  const fakeManager = { acquire: async () => { acquired += 1; return { url: baseUrl, death: new Promise(() => {}), release: async () => {} }; } };
  const qualified = await deepQualifyModel({ entry: ssh, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64, tunnelManager: fakeManager });
  assert.equal(qualified.qualified, true, qualified.reason);
  assert.equal(acquired, 1);
  assert.ok(seenUrls.length > 0 && seenUrls.every((url) => !url?.includes('/static')), `qualification used runtime lease URL: ${seenUrls.join(', ')}`);
  const legacy = { ...envEntry(baseUrl), transport: 'legacy_http' };
  assert.equal((await seatQualification({ entry: legacy, model: 'served-alias', seatType: 'words_reviewer' })).reason, 'unsupported_transport');
});

await test('expectedReportedFor forwards a declared alias mapping from entry or seat', () => {
  assert.deepEqual(expectedReportedFor({ expectedReported: ['a'] }, null, 'm'), ['a']);
  assert.deepEqual(expectedReportedFor({ expectedReported: { m: ['x'] } }, null, 'm'), ['x']);
  assert.deepEqual(expectedReportedFor({}, { aliases: ['y'] }, 'm'), ['y']);
  assert.equal(expectedReportedFor({}, {}, 'm'), undefined);
});

// ---- declared backend × model coverage (not just the standing decision) ----

await test('qualifyUsedSeats qualifies every declared model × declared seat, not only the decided one', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'ok', model: 'served-alias' });
  // Two declared models, both seats offered; the standing decision names only
  // model-a as the maker. model-b (and every reviewer row) must still qualify.
  const entry = { ...envEntry(baseUrl), models: ['served-alias', 'other-model'], seats: ['maker', 'reviewer'] };
  const seatDecisions = { maker: { backend: entry.name, model: 'served-alias' }, reviewer: { backend: 'claude', model: 'x' } };
  const rows = await qualifyUsedSeats({ backends: [entry], seatDecisions, deep: true });
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'qual-testcompat-other-model-words_maker',
    'qual-testcompat-other-model-words_reviewer',
    'qual-testcompat-served-alias-words_maker',
    'qual-testcompat-served-alias-words_reviewer',
  ], 'both declared models are qualified for both declared seats — no alternate model is skipped');
});

// ---- transient discovery failure must not void a qualification -------------

await test('seatQualification survives a transient /models outage (discovery is informational)', async () => {
  freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  const { baseUrl } = await startServer((kind) =>
    kind === 'structured' ? { body: REVIEW_JSON, model: 'served-alias' } : { body: 'CAMUS-CTX-OK', model: 'served-alias' });
  const entry = envEntry(baseUrl);
  const probed = await deepQualifyModel({ entry, model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(probed.qualified, true, probed.reason);

  // At launch /models is unreachable: discovery collapses to discovery_unavailable.
  // The receipt's own recorded anchors are carried forward, so the working seat
  // still admits and copies its fingerprint rather than voiding on the outage.
  const outageFetch = async (url) => {
    if (String(url).endsWith('/models')) throw new Error('connection refused');
    return new Response('not found', { status: 404 });
  };
  const admit = await seatQualification({ entry, model: 'served-alias', seatType: 'words_reviewer', fetchImpl: outageFetch });
  assert.equal(admit.qualified, true, `a transient listing outage must not void: ${admit.reason}`);
  assert.equal(admit.fingerprint, probed.receipt.fingerprint);
});

// ---- context-probe substitution is fail-closed even when the envelope fails --

await test('a model swap on the LARGE context request fails closed with no receipt, even when the envelope fails', async () => {
  const dir = freshEnv();
  process.env.CAP_TEST_KEY = SECRET;
  // Liveness/structured answer as the requested model; the context request both
  // switches models AND fails the envelope (marker not echoed, tiny usage).
  const { baseUrl } = await startServer((kind) => {
    if (kind === 'context') return { chunks: [sseBody({ text: 'nope', model: 'sneaky-other', promptTokens: 1 })], model: 'sneaky-other' };
    return { body: REVIEW_JSON, model: 'served-alias' };
  });
  const res = await deepQualifyModel({ entry: envEntry(baseUrl), model: 'served-alias', seatType: 'words_reviewer', contextProbeTokens: 64 });
  assert.equal(res.qualified, false);
  assert.equal(res.reason, 'model_substituted');
  assert.equal(res.identity.mode, 'substituted');
  const capDir = join(dir, 'capabilities');
  assert.equal(existsSync(capDir) ? readdirSync(capDir).length : 0, 0, 'a substitution on the context probe writes no durable receipt');
});

for (const s of servers) s.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
delete process.env.CAP_TEST_KEY;
console.log(`\ncapability-probes.test.mjs: ${passed} tests passed`);
