// openai_compat backend — any OpenAI-compatible chat-completions endpoint
// (Kimi/Moonshot, a local vLLM, etc.) in either seat. Opt-in only: an
// instance exists exactly when checks/models.json declares one under
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

// One SSE stream in, { text, usage, responseModel } out — or a thrown Error
// whose .code says which kill path fired (abort | idle | timeout | http).
export async function streamChatCompletion({ entry, model, prompt, signal, timeoutMs, onDelta }) {
  const apiKey = process.env[entry.apiKeyEnv];
  if (!apiKey) {
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
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
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
      const err = new Error(`${entry.baseUrl} answered ${res.status}: ${body.slice(0, 200)}`);
      err.code = 'http';
      throw err;
    }

    let text = '';
    let usage = null;
    let responseModel = null;
    let buf = '';
    const decoder = new TextDecoder();
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let ev;
      try { ev = JSON.parse(payload); } catch { return; } // torn frame; the stream continues
      if (typeof ev.model === 'string' && ev.model) responseModel = ev.model;
      if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
      const delta = ev.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
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
    return { text, usage, responseModel };
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

// ---- maker seat -------------------------------------------------------------

export function openAiCompatMaker(entry) {
  return async function compatMaker({ prompt, stage = 'make', model, signal, onTick, onSession, toolPolicy = 'research' }) {
    const fail = (error) => ({ ok: false, error, text: null, costUsd: 0 });
    if (toolPolicy === 'hivemind_only') {
      return fail(`backend "${entry.name}" has no tools, so it cannot run Hivemind retrieval — grounded managed-connector runs need the claude backend in the maker seat`);
    }
    onSession?.(`tool surface: none (${entry.name} is a plain chat-completions backend; requested policy "${toolPolicy}" runs toolless)`);
    const tick = setInterval(() => onTick?.(stage === 'plan' ? 'planning…' : 'drafting (no tools; prompt and frozen grounding only)…'), 8000);
    const startedAt = Date.now();
    let lastReported = 0;
    try {
      const { text, usage, responseModel } = await streamChatCompletion({
        entry,
        model,
        prompt,
        signal,
        timeoutMs: MAKER_TIMEOUTS[stage] ?? 540_000,
        onDelta: (chars) => {
          if (chars - lastReported >= 2000) { lastReported = chars; onSession?.(`streaming: ${chars} chars received`); }
        },
      });
      const trimmed = String(text ?? '').trim();
      if (!trimmed) return fail(`${entry.name} returned an empty result`);
      return {
        ok: true,
        error: null,
        text: trimmed,
        costUsd: 0, // usage and time only; dollars are never invented
        usage: usageFrom(usage),
        durationMs: Date.now() - startedAt,
        modelActual: actualIdentity(entry, responseModel),
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
  return async function compatReviewer({ prompt, model, signal, onTick, onSession, receiptDir, claims = [], criteria = [], thresholds = [] }) {
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
      const { text, usage, responseModel } = await streamChatCompletion({
        entry,
        model,
        prompt,
        signal,
        timeoutMs: REVIEW_TIMEOUT_MS,
        onDelta: (chars) => {
          if (chars - lastReported >= 1000) { lastReported = chars; onSession?.(`streaming verdict: ${chars} chars`); }
        },
      });
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
        norm.reviewerIdentity = actualIdentity(entry, responseModel) ?? `${entry.provider}:${model}`;
      }
      return norm;
    } catch (err) {
      return infra(err.message);
    } finally {
      clearInterval(tick);
    }
  };
}
