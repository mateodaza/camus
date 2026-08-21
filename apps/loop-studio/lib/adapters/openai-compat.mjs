// openai_compat backend — any OpenAI-compatible chat-completions endpoint
// (Kimi/Moonshot, a local vLLM, etc.) in either seat. Opt-in only: an
// instance exists exactly when the active model decision file declares one under
// `backends` (docs/MULTI-MODEL-SEATS.md).
//
// Contract notes:
//   - streaming, so the idle watchdog and session lines observe real progress;
//   - kill paths: run-abort → request abort; idle silence and the hard
//     timeout both abort and fail closed;
//   - NO tools: every toolPolicy runs as `none` and the session line says so.
//     hivemind_only retrieval is impossible here and is an infra error;
//   - the API key comes only from process.env[entry.apiKeyEnv] and never
//     appears in receipts, session lines, or error text;
//   - reviewer output funnels through the SAME fail-closed normalizeReview as
//     codex — unparseable or inconsistent output is an infra error, never a
//     clean verdict;
//   - usage is an observation from the endpoint's own usage object (missing →
//     null, never invented); actual identity is the response `model` field
//     prefixed with the DECLARED provider, or null when the endpoint stays
//     silent.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeReview } from './codex.mjs';

const MAKER_TIMEOUTS = { plan: 120_000, ground: 300_000, make: 540_000, fix: 420_000 };
const REVIEW_TIMEOUT_MS = 600_000;
const IDLE_MS = () => Number(process.env.OPENAI_COMPAT_IDLE_MS || 120_000);

// Scrub credential-shaped tokens from provider-supplied error text BEFORE it is
// placed in an Error the engine will retry on and persist to events.jsonl /
// session output. The exact key value is removed first by literal match, then
// generic bearer/sk-/authorization shapes, so an endpoint that echoes the
// Authorization header or the API key in its error body cannot leak it upward.
// Kept in the production adapter (not only the capability probes) because both
// compat seats return this message unchanged. Mirrors
// capability-probes.redactProviderError.
function redactSecret(message, secretValue) {
  let out = String(message ?? '');
  if (typeof secretValue === 'string' && secretValue.length >= 4) {
    out = out.split(secretValue).join('‹redacted-credential›');
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer ‹redacted›')
    .replace(/\b(sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,}/gi, '$1-‹redacted›')
    .replace(/("?(?:authorization|api[_-]?key|token)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1‹redacted›');
}

// One SSE stream in, { text, usage, responseModel } out — or a thrown Error
// whose .code says which kill path fired (abort | idle | timeout | http).
export async function streamChatCompletion({ entry, model, prompt, signal, timeoutMs, onDelta }) {
  // auth.kind:none (keyless loopback, e.g. a bare Ollama) neither requires nor
  // emits a bearer credential — no env var is read and no Authorization header
  // is sent. Every other backend reads its key ONLY from the environment.
  const keyless = entry.auth?.kind === 'none';
  const apiKey = keyless ? null : process.env[entry.apiKeyEnv];
  if (!keyless && !apiKey) {
    const err = new Error(`backend "${entry.name}" needs ${entry.apiKeyEnv} set in the environment`);
    err.code = 'missing_key';
    throw err;
  }

  const controller = new AbortController();
  let killedBy = null;
  const kill = (code) => { if (!killedBy) { killedBy = code; controller.abort(); } };
  const onAbort = () => kill('abort');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) kill('abort');
  const hardT = setTimeout(() => kill('timeout'), timeoutMs);
  let idleT = setTimeout(() => kill('idle'), IDLE_MS());
  const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => kill('idle'), IDLE_MS()); };

  try {
    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(keyless ? {} : { authorization: `Bearer ${apiKey}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        // Tolerated when the endpoint ignores it; usage stays null then.
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Redact any echoed credential from the endpoint's error body before it is
      // sealed into the Error the engine retries on and writes to session output.
      const err = new Error(`${entry.baseUrl} answered ${res.status}: ${redactSecret(body, apiKey).slice(0, 200)}`);
      err.code = 'http';
      throw err;
    }

    let text = '';
    let usage = null;
    let responseModel = null;
    // The number of NON-EMPTY content deltas actually observed on the wire. This
    // is the only honest evidence that SSE deltas arrived and fed the idle
    // watchdog — an empty body or a [DONE]-only response returns cleanly yet
    // produces none, so a clean return alone must never stand in for streaming
    // (RFC §9.2 streaming capability). The capability probe admits streaming only
    // when this is > 0.
    let deltaCount = 0;
    // EVERY distinct non-null reported identity is retained, not just the final
    // one: a stream that reports an undeclared model on an early content event and
    // the requested model on a later event must NOT be reconcilable to the last
    // value — that would erase the unexpected identity and let a substituted model
    // slip a draft or verdict through. The caller reconciles fail-closed across
    // the whole set (§9.1), so any single out-of-set event kills the call.
    const reportedModels = [];
    const seenModels = new Set();
    let buf = '';
    const decoder = new TextDecoder();
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let ev;
      try { ev = JSON.parse(payload); } catch { return; } // torn frame; the stream continues
      if (typeof ev.model === 'string' && ev.model) {
        responseModel = ev.model;
        if (!seenModels.has(ev.model)) { seenModels.add(ev.model); reportedModels.push(ev.model); }
      }
      if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
      const delta = ev.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        deltaCount += 1;
        onDelta?.(text.length);
      }
    };
    for await (const chunk of res.body) {
      poke();
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handleLine(line);
    }
    handleLine(buf);
    // Provider output is untrusted too: a gateway can answer HTTP 200 while
    // echoing its Authorization header in a malformed verdict or draft. Scrub
    // only after the complete stream is assembled so a credential split across
    // SSE deltas is still removed, and do it before any consumer can normalize,
    // log, or persist the text.
    return { text: redactSecret(text, apiKey), usage, responseModel, reportedModels, deltaCount };
  } catch (err) {
    if (killedBy === 'abort') { const e = new Error('aborted by user'); e.code = 'abort'; throw e; }
    if (killedBy === 'idle') { const e = new Error(`${entry.name} went silent for ${Math.round(IDLE_MS() / 60000)} min — killed (idle watchdog)`); e.code = 'idle'; throw e; }
    if (killedBy === 'timeout') { const e = new Error(`${entry.name} hit the hard timeout`); e.code = 'timeout'; throw e; }
    throw err;
  } finally {
    clearTimeout(hardT);
    clearTimeout(idleT);
    signal?.removeEventListener('abort', onAbort);
  }
}

const usageFrom = (usage) => {
  const value = (key) => Number.isInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
  return {
    input_tokens: value('prompt_tokens'),
    cached_input_tokens: Number.isInteger(usage?.prompt_tokens_details?.cached_tokens) && usage.prompt_tokens_details.cached_tokens >= 0
      ? usage.prompt_tokens_details.cached_tokens
      : null,
    output_tokens: value('completion_tokens'),
  };
};

const actualIdentity = (entry, responseModel) => responseModel ? `${entry.provider}:${responseModel}` : null;

// The identity that is SEALED as actual, given the reconciled evidence class.
// For an operator-documented mapping the reported alias names the endpoint's
// served label but is NOT the actual model: the actual is the operator-mapped
// (requested) id, and the alias lives only in `reported`
// (docs/OPEN-MODEL-SEATS-RFC.md §5.2:576-579). Every other class seals the
// reported value (or null → the caller's requested-id fallback).
const sealedActualIdentity = (entry, model, responseModel, evidence) =>
  evidence === 'mapped_by_operator_docs'
    ? `${entry.provider}:${model}`
    : actualIdentity(entry, responseModel);

// Normalize operator-declared expected-reported mappings into the flat alias
// array reconciliation needs, for the ONE requested model. Each declaration may
// arrive as an array (aliases applying to every model), a `{ [model]: [...] }`
// map (per-model aliases), or a bare string. Anything else contributes nothing.
// Multiple sources (backend-level and seat-level) are UNIONED, exactly as
// capability-probes.expectedReportedFor unions them at qualification time — a
// seat-level mapping augments the backend mapping, it never replaces it. Passing
// them separately here (rather than nullish-selecting one) keeps runtime
// reconciliation accepting the SAME alias set a receipt was earned against.
function normalizeExpectedReported(...sources) {
  const model = sources.pop();
  const out = [];
  const collect = (v) => {
    if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string' && x));
    else if (v && typeof v === 'object' && Array.isArray(v[model])) out.push(...v[model].filter((x) => typeof x === 'string' && x));
    else if (typeof v === 'string' && v) out.push(v);
  };
  for (const s of sources) collect(s);
  return [...new Set(out)];
}

// §9.1 evidence class for the reconciled identity, so the consumer can seal the
// right provenance (docs/OPEN-MODEL-SEATS-RFC.md §9.1):
//   reported echoes the requested id          → observed_api_response
//   reported matches a declared alias mapping  → mapped_by_operator_docs
//   endpoint stayed silent (no reported model) → asserted_pin
// A substituted model never reaches here — assertReportedIdentity throws first.
function reportedEvidenceClass(model, responseModel, aliases) {
  if (responseModel == null || responseModel === '') return 'asserted_pin';
  if (responseModel === model) return 'observed_api_response';
  if (aliases.includes(responseModel)) return 'mapped_by_operator_docs';
  return 'observed_api_response';
}

// §6.2 / §9.1 fail-closed identity reconciliation, enforced on EVERY production
// call (not only the qualification probe): the response `model` field is the
// reported identity, and a non-null reported model outside the seat's
// expected-reported set is an infra refusal that KILLS the call before any draft
// or verdict is consumed — the run never proceeds on a model nobody decided on
// (docs/OPEN-MODEL-SEATS-RFC.md §6.2:1300-1303). An absent (null) reported model
// is an asserted pin: the endpoint offered nothing to confirm or contradict, so
// the requested id stands. `aliases` is the normalized operator-declared mapping;
// absent it, only the requested id is accepted.
// `reportedModels` is the FULL set of distinct non-null identities the stream
// reported, not merely the last. Every one must be in the expected set: a single
// out-of-set event anywhere in the stream is a substitution that kills the call,
// even if a later event reports the requested id (which would otherwise erase the
// earlier unexpected identity).
function assertReportedIdentity(entry, model, reportedModels, aliases) {
  const reported = Array.isArray(reportedModels)
    ? reportedModels
    : (reportedModels == null || reportedModels === '' ? [] : [reportedModels]);
  for (const rm of reported) {
    if (rm == null || rm === '') continue;
    if (rm === model || aliases.includes(rm)) continue;
    const err = new Error(
      `${entry.name} served model "${rm}", not the requested "${model}"${
        aliases.length ? ` or a declared alias [${aliases.join(', ')}]` : ''
      } — refusing to consume output from a substituted model`,
    );
    err.code = 'model_identity';
    throw err;
  }
}

// ---- maker seat -------------------------------------------------------------

export function openAiCompatMaker(entry) {
  return async function compatMaker({ prompt, stage = 'make', model, signal, onTick, onSession, toolPolicy = 'research', expectedReported }) {
    const fail = (error) => ({ ok: false, error, text: null, costUsd: 0 });
    if (toolPolicy === 'hivemind_only') {
      return fail(`backend "${entry.name}" has no tools, so it cannot run Hivemind retrieval — grounded managed-connector runs need the claude backend in the maker seat`);
    }
    onSession?.(`tool surface: none (${entry.name} is a plain chat-completions backend; requested policy "${toolPolicy}" runs toolless)`);
    const tick = setInterval(() => onTick?.(stage === 'plan' ? 'planning…' : 'drafting (no tools; prompt and frozen grounding only)…'), 8000);
    const startedAt = Date.now();
    let lastReported = 0;
    try {
      const { text, usage, responseModel, reportedModels } = await streamChatCompletion({
        entry,
        model,
        prompt,
        signal,
        timeoutMs: MAKER_TIMEOUTS[stage] ?? 540_000,
        onDelta: (chars) => {
          if (chars - lastReported >= 2000) { lastReported = chars; onSession?.(`streaming: ${chars} chars received`); }
        },
      });
      // Reconcile identity BEFORE the draft is consumed: a substituted model
      // kills the call as an infra error rather than producing a deliverable.
      // The declared alias set falls back to the backend entry when the caller
      // passes none, so a mapping endpoint is honored without per-call threading.
      // Every reported identity across the stream is checked, not just the last.
      const aliases = normalizeExpectedReported(entry.expectedReported, expectedReported, model);
      assertReportedIdentity(entry, model, reportedModels ?? responseModel, aliases);
      const evidence = reportedEvidenceClass(model, responseModel, aliases);
      const trimmed = String(text ?? '').trim();
      if (!trimmed) return fail(`${entry.name} returned an empty result`);
      return {
        ok: true,
        error: null,
        text: trimmed,
        costUsd: 0, // usage and time only; dollars are never invented
        usage: usageFrom(usage),
        durationMs: Date.now() - startedAt,
        modelActual: sealedActualIdentity(entry, model, responseModel, evidence),
        // §9.1 identity evidence the engine seals: the raw reported id and its
        // evidence class (observed_api_response / mapped_by_operator_docs /
        // asserted_pin) so a configurable seat is observation-eligible.
        modelReported: responseModel ?? null,
        modelActualEvidence: evidence,
        hivemindQueried: false,
        hivemindQueries: 0,
        hivemindQueryTexts: [],
        hivemindResults: [],
      };
    } catch (err) {
      return fail(err.message);
    } finally {
      clearInterval(tick);
    }
  };
}

// ---- reviewer seat ------------------------------------------------------------

export function openAiCompatReviewer(entry) {
  return async function compatReviewer({ prompt, model, signal, onTick, onSession, receiptDir, claims = [], criteria = [], thresholds = [], expectedReported }) {
    const infra = (error) => ({
      ran: false, error, verdict: 'ERROR', findings: [], questions: [],
      claimAssessments: [], coverageAssessments: [], thresholdAssessments: [],
      usage: null, durationMs: Date.now() - startedAt,
    });
    const tick = setInterval(() => onTick?.('reviewer reading and drafting findings…'), 8000);
    const startedAt = Date.now();
    try {
      onSession?.('turn started');
      let lastReported = 0;
      const { text, usage, responseModel, reportedModels } = await streamChatCompletion({
        entry,
        model,
        prompt,
        signal,
        timeoutMs: REVIEW_TIMEOUT_MS,
        onDelta: (chars) => {
          if (chars - lastReported >= 1000) { lastReported = chars; onSession?.(`streaming verdict: ${chars} chars`); }
        },
      });
      // Reconcile identity BEFORE the verdict is written or normalized: a
      // substituted reviewer model is an infra refusal, never a clean verdict.
      // Every reported identity across the stream is checked, not just the last.
      const aliases = normalizeExpectedReported(entry.expectedReported, expectedReported, model);
      assertReportedIdentity(entry, model, reportedModels ?? responseModel, aliases);
      const evidence = reportedEvidenceClass(model, responseModel, aliases);
      onSession?.(`verdict drafted (${String(text ?? '').length} chars)`);
      // The raw verdict lands beside the run like codex's -o file, so a
      // skeptic can re-read exactly what the endpoint said.
      if (receiptDir) {
        try {
          const dir = resolve(receiptDir);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'last.json'), String(text ?? ''));
        } catch { /* receipts degrade loudly at the server layer; the verdict still normalizes */ }
      }
      const norm = normalizeReview(String(text ?? ''), 0, claims, criteria, thresholds);
      norm.usage = usageFrom(usage);
      norm.durationMs = Date.now() - startedAt;
      if (norm.ran) {
        norm.reviewerModel = model;
        norm.reviewerEffort = null; // no effort knob on this backend — never a fabricated tier
        norm.reviewerIdentity = sealedActualIdentity(entry, model, responseModel, evidence) ?? `${entry.provider}:${model}`;
        // §9.1 reviewer identity evidence the engine seals into the pairing.
        norm.reviewerReportedModel = responseModel ?? null;
        norm.reviewerActualEvidence = evidence;
      }
      return norm;
    } catch (err) {
      return infra(err.message);
    } finally {
      clearInterval(tick);
    }
  };
}
