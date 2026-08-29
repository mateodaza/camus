// RFC §9.2 capability-probe EXECUTION for the loopback / direct_https words
// seats (docs/OPEN-MODEL-SEATS-RFC.md §9.2, §9.4, §9.1, §6.1). Slice C.
//
// capabilities.mjs is the storage/binding/validation floor: it records receipts
// and answers the §9.4 matrix but never touches the network. THIS module is the
// runner that sits above it — it drives real probes through the production
// openai-compat streaming adapter and the production reviewer `normalizeReview`
// path, reconciles the reported model identity, measures the context envelope,
// collects whatever server anchors the endpoint actually exposes, and hands the
// ACTUAL probe results to `writeReceipt`. It never invents an absent fact and it
// never redesigns the qual1 receipt contract.
//
// Fail-closed identity (§9.1): a non-null reported model outside the seat's
// expected-reported set is an infra refusal that kills the call BEFORE any draft
// or verdict is consumed — no receipt is written for a model nobody decided on.
// An absent reported model is an `asserted_pin`: the requested id is taken as a
// pin, since the endpoint offered nothing to confirm or contradict.
//
// Credential discipline (§9.2 component 15): auth.kind:none neither requires nor
// emits a bearer credential; auth.kind:env reads the key only from the
// environment. Provider error text is redacted of credential-shaped tokens
// before it ever lands in a result, a session line, or a log.
// CAMUS_CONTROL: studio.qualification.receipt_integrity

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { streamChatCompletion } from './adapters/openai-compat.mjs';
import { getSharedTunnelManager } from './ssh-tunnel.mjs';
import { normalizeReview } from './adapters/codex.mjs';
import {
  writeReceipt,
  invalidateReceipt,
  qualifySeat,
  readStoredReceipt,
  capabilityDiagnosticsDir,
  CAP_STATES,
  PROBE_SUITE_VERSION,
  SEAT_REQUIREMENTS,
  WORDS_SEATS,
} from './capabilities.mjs';
import { openRouterRouteIdentity } from './openrouter-route.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Slice D extends the Slice C runner to the managed ssh_tunnel transport. The
// tunnel manager supplies a runtime URL while the qualification key remains the
// stable alias/remote-port connection identity. Plaintext legacy_http remains
// excluded and never receives a durable qual1 receipt.
export const SUPPORTED_TRANSPORTS = Object.freeze(['loopback', 'direct_https', 'ssh_tunnel']);

function transportOf(entry) {
  return entry.transport || entry.connectionDetails?.kind || 'loopback';
}

export function isSupportedTransport(entry) {
  return SUPPORTED_TRANSPORTS.includes(transportOf(entry));
}

// The adapter/runtime contract version (§9.2 component 14): the revision of the
// openai-compat adapter + this runner that ran the probe. Bump when the probe
// wiring or the adapter contract changes so old receipts read as a visible
// adapter mismatch rather than silently matching under new behavior.
export const ADAPTER_CONTRACT_VERSION = 'oai-compat-runner-2';

// The version stamp carried by the ACTUAL review schema qualification exercises
// (checks/review.schema.json). Read at load so a schema change that bumps the
// stamp mechanically flows into NORMALIZER_VERSION below — there is no hand-kept
// string to forget. A schema with no `version` is a hard, fail-closed error: the
// receipt contract must not bind to an unversioned schema (§9.2 component 10).
const REVIEW_SCHEMA_PATH = join(__dirname, '..', 'checks', 'review.schema.json');
export const REVIEW_SCHEMA_VERSION = (() => {
  const v = JSON.parse(readFileSync(REVIEW_SCHEMA_PATH, 'utf8'))?.version;
  if (typeof v !== 'string' || !v) {
    throw new Error('checks/review.schema.json is missing its required "version" stamp — the structured-output receipt cannot bind to an unversioned schema');
  }
  return v;
})();

// The normalizer contract version (§9.2 component 10): a `normalizeReview`
// contract change re-opens the structured-output question, so it is bound into
// the receipt. The ACTUAL review schema version is folded in, so a change to the
// schema qualification exercises against — not merely a change to this file —
// also re-opens every structured-output receipt. Bump the literal prefix
// alongside a normalizeReview shape/criteria change.
export const NORMALIZER_VERSION = `normalize-review-1+${REVIEW_SCHEMA_VERSION}`;

// The prompt-envelope version + measured target per words seat (§9.2 component
// 11, §9.4 contextWindow row). `targetTokens` is the size the context probe must
// round-trip to demonstrate the window; it is a versioned lane constant, so an
// envelope change re-opens exactly the context question (bump `version`). Tests
// may override the measured size without touching the versioned constant.
export const PROMPT_ENVELOPES = Object.freeze({
  words_reviewer: Object.freeze({ version: 'words_reviewer-env-1', targetTokens: 8192 }),
  words_maker: Object.freeze({ version: 'words_maker-env-1', targetTokens: 8192 }),
});

// Every completion used for qualification is deliberately tiny: one sentence,
// one compact review object, or two context markers. Binding an explicit output
// ceiling prevents a large context-input probe from accidentally buying a large
// completion. Qwen 3 receives the smaller thinking budget through the existing
// adapter so its total cap still leaves room for the required visible answer.
export const QUALIFICATION_MAX_OUTPUT_TOKENS = 256;
export const QUALIFICATION_THINKING_TOKENS = 64;
const DECODING_KNOBS =
  `max_output_tokens=${QUALIFICATION_MAX_OUTPUT_TOKENS};thinking_tokens=${QUALIFICATION_THINKING_TOKENS}_when_supported`;

// A fixed miniature review prompt carrying the REAL normalized-review schema
// shape, so the structured-output probe exercises the production parser, not a
// toy. Expected claim/criterion/threshold sets are empty: the probe proves the
// endpoint can emit a schema-valid, self-consistent verdict at all.
const STRUCTURED_PROBE_PROMPT =
  'Capability probe. Reply with ONLY a JSON object matching the Camus review schema: ' +
  'keys verdict ("clean"|"revise"), findings ([]), questions_for_human ([]), ' +
  'claim_assessments ([]), coverage_assessments ([]), threshold_assessments ([]). ' +
  'There is nothing to review; return a clean verdict with empty arrays.';

const LIVENESS_PROBE_PROMPT =
  'Capability probe. Reply with a single short sentence so the stream produces deltas.';

// ---- secret redaction ------------------------------------------------------

// Scrub credential-shaped tokens from provider error text. The known credential
// value (when auth.kind:env) is removed first by exact match, then generic
// bearer/sk-/authorization shapes so a provider that echoes an Authorization
// header or an API key in its error body cannot leak it upward.
export function redactProviderError(message, { secretValue } = {}) {
  let out = String(message ?? '');
  if (typeof secretValue === 'string' && secretValue.length >= 4) {
    out = out.split(secretValue).join('‹redacted-credential›');
  }
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer ‹redacted›')
    .replace(/\b(sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,}/gi, '$1-‹redacted›')
    .replace(/("?(?:authorization|api[_-]?key|token)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1‹redacted›');
  return out;
}

// The largest malformed-sample slice retained for diagnosis — bounded so a
// pathological reply can never fill the diagnostics sink.
const MALFORMED_SAMPLE_MAX = 4096;

// Retain the raw malformed structured-output reply locally (§9.2) so an operator
// can inspect why qualification failed. The sample is credential-scrubbed and
// length-bounded, and lands in the diagnostics sink — a sibling of the receipts
// dir — so it is NEVER part of the capability fingerprint. Best-effort: a write
// failure never blocks qualification. Returns the written path, or null.
async function persistMalformedSample({ entry, model, seatType, text, secretValue }) {
  try {
    const dir = capabilityDiagnosticsDir();
    await mkdir(dir, { recursive: true });
    const scrubbed = redactProviderError(String(text ?? ''), { secretValue }).slice(0, MALFORMED_SAMPLE_MAX);
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
    const file = join(dir, `malformed-structured-output-${safe(entry.name)}-${safe(model)}-${safe(seatType)}.txt`);
    await writeFile(file, scrubbed, { mode: 0o600 });
    return file;
  } catch {
    return null; // diagnostics are best-effort; failure never fails a qualification
  }
}

// ---- model-identity reconciliation (§9.1) ----------------------------------

// Reconcile the endpoint's reported model against what was requested, given the
// seat's declared expected-reported set (a config-declared mapping, e.g. an
// endpoint that serves "qwen2.5:7b" as "qwen2.5-7b-instruct"):
//   reported === null                 → asserted_pin (nothing to confirm)
//   expectedReported declared + hit   → mapped
//   no mapping + reported === requested → confirmed
//   otherwise                          → substituted (ok:false, fail closed)
export function reconcileModelIdentity({ requested, reported, expectedReported }) {
  if (reported == null || reported === '') {
    return { ok: true, mode: 'asserted_pin', requested, reported: null };
  }
  const mapped = Array.isArray(expectedReported) ? expectedReported.filter(Boolean) : [];
  if (mapped.length > 0) {
    // The requested id itself is always accepted, even with a mapping declared —
    // a provider that legitimately alternates between its requested id and a
    // documented alias qualifies at both (mirrors the runtime adapter, which
    // accepts `responseModel === model`).
    if (reported === requested) return { ok: true, mode: 'confirmed', requested, reported };
    if (mapped.includes(reported)) return { ok: true, mode: 'mapped', requested, reported };
    return {
      ok: false,
      mode: 'substituted',
      requested,
      reported,
      detail: `endpoint reported "${reported}", not in the declared expected-reported set [${mapped.join(', ')}] for "${requested}"`,
    };
  }
  if (reported === requested) return { ok: true, mode: 'confirmed', requested, reported };
  return {
    ok: false,
    mode: 'substituted',
    requested,
    reported,
    detail: `endpoint reported "${reported}" for requested "${requested}" — unexpected substitution`,
  };
}

// ---- server-anchor discovery (§9.2 component 9, informational per §9.3) -----

// The openai-compat base is conventionally `<root>/v1`; the server-class anchor
// endpoints (Ollama /api/show, llama.cpp /props, LM Studio /api/v0/models) live
// at the SERVER ROOT, not under /v1. Strip a trailing /v1[/…] so those probes hit
// the right host without assuming the operator wrote the base a particular way.
function serverRoot(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/i, '');
}

const jsonOrNull = async (res) => (res && res.ok ? res.json().catch(() => null) : null);

// Class-specific weight-identity anchors for the REQUESTED model. These are what
// makes model DRIFT under a stable served alias detectable (§9.2 component 9): an
// Ollama weight swap leaves /v1/models unchanged but changes the /api/show
// digest; llama.cpp exposes its build + loaded model path at /props; LM Studio
// exposes architecture + quantization at /api/v0/models. Every probe is
// best-effort and tolerant — a class that does not answer simply leaves its
// anchors `absent`. Returns the fields it could observe (only non-absent ones).
async function collectClassAnchors({ entry, fetchImpl, model, headers }) {
  const found = {};
  const root = serverRoot(entry.baseUrl);
  // Each class-anchor endpoint is probed SEQUENTIALLY, so a single shared
  // AbortSignal.timeout(5000) would cover the WHOLE sequence: a slow/unsupported
  // /api/show could burn the full budget and abort the later /props and
  // /api/v0/models before they are even attempted, recording available anchors as
  // absent. Give every request its own fresh 5s deadline instead.
  const opts = () => ({ signal: AbortSignal.timeout(5000), headers });

  // Ollama: POST /api/show { name } → { details.quantization_level, ... } and a
  // top-level or details digest that changes when the weights change.
  try {
    const res = await fetchImpl(`${root}/api/show`, {
      ...opts(), method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, model }),
    });
    const body = await jsonOrNull(res);
    if (body && typeof body === 'object') {
      const digest = body.digest ?? body.details?.digest ?? body.model_info?.['general.digest'];
      if (typeof digest === 'string' && digest) found.digest = digest;
      const quant = body.details?.quantization_level ?? body.model_info?.['general.quantization_level'];
      if (typeof quant === 'string' && quant) found.quantization = quant;
      const arch = body.details?.family ?? body.model_info?.['general.architecture'];
      if (typeof arch === 'string' && arch && found.architecture === undefined) found.architecture = arch;
      // Ollama exposes the loaded context under a per-architecture key
      // (`llama.context_length`, `qwen2.context_length`, …) in model_info: a
      // num_ctx change is a weight/config drift the receipt must bind (§9.2).
      const ctxKey = body.model_info && typeof body.model_info === 'object'
        ? Object.keys(body.model_info).find((k) => k.endsWith('.context_length'))
        : undefined;
      const ctx = ctxKey ? body.model_info[ctxKey] : undefined;
      if (Number.isFinite(ctx) && found.contextLength === undefined) found.contextLength = String(ctx);
    }
  } catch { /* not an Ollama endpoint, or unreachable — leave absent */ }

  // llama.cpp: GET /props → { build_info / system_info, default_generation_settings.{model,n_ctx} }.
  if (found.build === undefined) {
    try {
      const body = await jsonOrNull(await fetchImpl(`${root}/props`, opts()));
      if (body && typeof body === 'object') {
        const build = body.build_info ?? body.system_info;
        if (typeof build === 'string' && build) found.build = build;
        const loaded = body.default_generation_settings?.model ?? body.model_path;
        if (typeof loaded === 'string' && loaded && found.loadedModel === undefined) found.loadedModel = loaded;
        const nCtx = body.default_generation_settings?.n_ctx ?? body.n_ctx;
        if (Number.isFinite(nCtx) && found.contextLength === undefined) found.contextLength = String(nCtx);
      }
    } catch { /* not a llama.cpp endpoint — leave absent */ }
  }

  // LM Studio: GET /api/v0/models → richer per-model rows (arch + quantization +
  // max/loaded context).
  if (found.architecture === undefined || found.quantization === undefined
    || found.contextLength === undefined || found.loadedContextLength === undefined) {
    try {
      const body = await jsonOrNull(await fetchImpl(`${root}/api/v0/models`, opts()));
      const list = Array.isArray(body?.data) ? body.data : [];
      const match = list.find((m) => m?.id === model || m?.key === model);
      if (match) {
        if (typeof match.arch === 'string' && match.arch && found.architecture === undefined) found.architecture = match.arch;
        if (typeof match.quantization === 'string' && match.quantization && found.quantization === undefined) found.quantization = match.quantization;
        if (Number.isFinite(match.max_context_length) && found.contextLength === undefined) found.contextLength = String(match.max_context_length);
        if (Number.isFinite(match.loaded_context_length) && found.loadedContextLength === undefined) found.loadedContextLength = String(match.loaded_context_length);
      }
    } catch { /* not an LM Studio endpoint — leave absent */ }
  }
  return found;
}

// Best-effort, tolerant collection of server-reported identity anchors for the
// REQUESTED model. Every anchor absent from the endpoint is recorded as the
// literal `absent` (never skipped, never invented, never borrowed from an
// unrelated model). Discovery is INFORMATIONAL only — it gates nothing; its sole
// output is the component-9 serialization bound into the receipt plus the
// §9.3 `discoveryStatus ∈ { listed | unlisted | discovery_unavailable }`:
//   listed                → the requested id appears in the endpoint's listing
//   unlisted              → the endpoint answered but does not list the id
//   discovery_unavailable → no /models, an error, or a timeout
// Alongside /v1/models, the class-specific weight anchors (Ollama digest +
// quantization, llama.cpp build, LM Studio architecture) are collected so a
// weight swap under a stable served alias changes component 9 and is detectable.
// Authenticated (auth.kind:env) endpoints receive their bearer so a private
// /models does not read as empty; keyless endpoints send no credential.
export async function collectServerAnchors({ entry, fetchImpl = fetch, model } = {}) {
  const anchors = {
    servedModel: 'absent', reportedContextLength: 'absent', loadedContextLength: 'absent', build: 'absent',
    digest: 'absent', quantization: 'absent', architecture: 'absent', loadedModel: 'absent',
  };
  let discoveryStatus = 'discovery_unavailable';
  const keyless = entry.auth?.kind === 'none';
  const apiKey = keyless ? null : process.env[entry.apiKeyEnv];
  const headers = keyless ? {} : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetchImpl(`${entry.baseUrl}/models`, { signal: AbortSignal.timeout(5000), headers });
    if (res && res.ok) {
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.data) ? body.data : [];
      // Bind ONLY the requested model's own row — never the first unrelated
      // model — so the durable receipt never records another model's facts.
      const match = list.find((m) => m?.id === model);
      if (match) {
        discoveryStatus = 'listed';
        anchors.servedModel = String(match.id);
        // vLLM (and other openai-compat servers) expose the served model's
        // underlying checkpoint identity on the /v1/models row: `root` is the
        // real model path/name behind a stable served alias, `parent` the base a
        // LoRA adapter was stacked on. Bind it as the loaded-model anchor so a
        // checkpoint swap under an unchanged served id AND context limit still
        // changes component 9 and voids the receipt — without it the drift would
        // be invisible. Prefer `root`; fall back to `parent`; only when it names
        // something OTHER than the served id itself (echoing the id adds nothing).
        const loaded = [match.root, match.parent].find((v) => typeof v === 'string' && v && v !== anchors.servedModel);
        if (loaded) anchors.loadedModel = String(loaded);
        const ctx = match.context_length ?? match.max_model_len ?? match.max_context_length;
        if (Number.isFinite(ctx)) anchors.reportedContextLength = String(ctx);
      } else {
        discoveryStatus = 'unlisted';
      }
      if (typeof body?.build === 'string' && body.build) anchors.build = body.build;
    }
  } catch {
    // An endpoint with no /models, an error, or a timeout is discovery_unavailable
    // — discovery is informational and never fails a qualification.
  }
  // Class-specific weight anchors are additive and never affect discoveryStatus:
  // a server that lists the model over /v1/models but exposes no /api/show still
  // reads `listed`, just with `digest=absent`.
  try {
    const cls = await collectClassAnchors({ entry, fetchImpl, model, headers });
    for (const [k, v] of Object.entries(cls)) {
      if (typeof v !== 'string' || !v) continue;
      // The /v1/models context length wins when present; a class-specific
      // context anchor only fills it when /v1 offered none.
      if (k === 'contextLength') {
        if (anchors.reportedContextLength === 'absent') anchors.reportedContextLength = v;
      } else {
        anchors[k] = v;
      }
    }
  } catch { /* every class probe already fails soft; this is a final backstop */ }

  // The fingerprint-bound component 9 carries only the OBSERVED identity anchors.
  // `discoveryStatus` is §9.3 INFORMATIONAL and is deliberately NOT serialized
  // into the hash: whether `/models` happened to list the id this instant must
  // never void a receipt, so it is returned alongside for advisory use only.
  const serialized =
    `servedModel=${anchors.servedModel};ctx=${anchors.reportedContextLength};loadedCtx=${anchors.loadedContextLength};build=${anchors.build};` +
    `digest=${anchors.digest};quant=${anchors.quantization};arch=${anchors.architecture};loaded=${anchors.loadedModel}`;
  return { serialized, anchors, discoveryStatus };
}

// Parse the `k=v;k=v;…` serialized anchor form back into a field map.
function parseSerializedAnchors(serialized) {
  const out = {};
  for (const part of String(serialized).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

// The ONLY anchors whose live disappearance may fall back to the stored value:
// the §9.3 INFORMATIONAL model-discovery listing (`/v1/models`). A transient
// listing outage on the SAME server must not read as drift, so these carry
// forward. Every OTHER anchor is a positively OBSERVED weight/server-identity
// fact (Ollama digest/quantization, llama.cpp build/loaded model, LM Studio
// architecture, the loaded/runtime context) — none of it may be fabricated from
// a stale receipt.
const DISCOVERY_FALLBACK_ANCHORS = Object.freeze(new Set(['servedModel', 'ctx']));

// Reconcile the freshly collected launch anchors against the receipt's stored
// anchors, PER FIELD. A field observed live (value !== `absent`) is always kept
// as observed so genuine drift on it voids. A field that collapsed to `absent`
// this launch falls back to the stored value ONLY when it is an informational
// discovery-listing anchor; every weight/server-identity anchor that vanished
// stays `absent`, so it no longer matches the stored fingerprint and the receipt
// voids. That is the point: if the server at this URL is replaced and its anchor
// endpoints now 404 or time out, its digest/build/quantization/architecture/
// loaded-model observations genuinely disappear — restoring them (the old
// behavior) reproduced the old fingerprint and admitted the replacement server,
// inventing facts nobody observed at admission and defeating drift handoff.
function mergeAnchorsForGate(liveSerialized, storedSerialized) {
  if (storedSerialized === undefined) return liveSerialized;
  const stored = parseSerializedAnchors(storedSerialized);
  return String(liveSerialized).split(';').map((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return part;
    const key = part.slice(0, i);
    const liveVal = part.slice(i + 1);
    if (liveVal !== 'absent') return part; // observed live → compare as observed
    // Absent live: only the informational discovery listing may carry stored;
    // a vanished weight/identity anchor stays absent and voids (fail-closed).
    if (DISCOVERY_FALLBACK_ANCHORS.has(key) && key in stored) return `${key}=${stored[key]}`;
    return part;
  }).join(';');
}

// ---- connection identity (§9.2 component 5) --------------------------------

function connectionLabel(entry) {
  const kind = entry.transport || entry.connectionDetails?.kind || 'loopback';
  let connection;
  if (kind === 'loopback') {
    const url = new URL(entry.baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    connection = `loopback ${host}:${port}`;
  } else if (kind === 'direct_https') {
    connection = `direct_https ${entry.baseUrl}`;
  } else if (kind === 'ssh_tunnel') {
    const c = entry.connectionDetails || entry;
    connection = `ssh_tunnel ${c.sshHostAlias}:${c.remoteAddress}:${c.remotePort}${c.basePath || '/v1'}`;
  } else {
    connection = `${kind} ${entry.baseUrl}`;
  }
  return `${connection};route=${openRouterRouteIdentity(entry, 'qualification backend')}`;
}

// The full §9.2 seat-identity descriptor the fingerprint binds — assembled from
// the live backend entry + the versioned runner constants, so the probe (write)
// and the admission gate (read) derive the SAME 16 components for a tuple. The
// only network-derived component is `serverAnchors` (component 9): the probe
// passes what it observed; the admission gate passes what the stored receipt
// recorded, so it validates the operator-controlled axes and expiry without
// re-contacting the endpoint.
function expectedReportedIdentity(expectedReported) {
  const values = typeof expectedReported === 'string'
    ? [expectedReported]
    : Array.isArray(expectedReported) ? expectedReported : [];
  const normalized = [...new Set(values.filter((value) => typeof value === 'string' && value).sort())];
  return normalized.length ? JSON.stringify(normalized) : 'exact-requested-model-only';
}

function qualInput({ entry, model, seatType, serverAnchors, keyless, secretValue, expectedReported }) {
  const envelope = PROMPT_ENVELOPES[seatType];
  return {
    seatType,
    backendName: entry.name,
    backendKind: entry.kind,
    connection: connectionLabel(entry),
    protocol: entry.protocol || 'chat_completions',
    requestedModelId: model,
    probeSuiteVersion: PROBE_SUITE_VERSION,
    auth: keyless
      ? { kind: 'none' }
      : { kind: 'env', envVarName: entry.apiKeyEnv, value: secretValue },
    serverAnchors,
    normalizerVersion: NORMALIZER_VERSION,
    promptEnvelopeVersion: envelope.version,
    decodingKnobs: DECODING_KNOBS,
    executorVersion: 'none',
    // A declared reported-model alias changes which provider identity Camus is
    // willing to accept. Bind that policy into the existing versioned adapter
    // component so widening or narrowing it voids the old receipt instead of
    // silently reinterpreting old qualification evidence.
    adapterContractVersion: `${ADAPTER_CONTRACT_VERSION};expectedReported=${expectedReportedIdentity(expectedReported)}`,
    gateScope: 'n/a',
  };
}

// ---- the deep-qualification operation --------------------------------------

// Run one probe stream and return { ok, text, reported, error } — the identity
// reconciliation and result interpretation stay with the caller so a single
// stream serves streaming/liveness, structured-output, and context probes.
async function runStream({ entry, model, prompt, timeoutMs, streamImpl, secretValue }) {
  try {
    const { text, responseModel, reportedModels, usage, deltaCount } = await streamImpl({
      entry,
      model,
      prompt,
      timeoutMs,
      maxTokens: QUALIFICATION_MAX_OUTPUT_TOKENS,
      thinkingTokens: QUALIFICATION_THINKING_TOKENS,
    });
    return {
      ok: true,
      text: String(text ?? ''),
      reported: responseModel ?? null,
      // The count of non-empty SSE content deltas the adapter actually observed —
      // the only evidence streaming is live. A clean return with zero deltas
      // (empty body, [DONE]-only) must not demonstrate streaming.
      deltaCount: Number.isInteger(deltaCount) ? deltaCount : 0,
      // The FULL set of distinct non-null identities the stream reported, so the
      // caller reconciles fail-closed across all of them — a later requested-id
      // event must never erase an earlier undeclared one.
      reportedModels: Array.isArray(reportedModels)
        ? reportedModels
        : (responseModel ? [responseModel] : []),
      usage: usage ?? null,
    };
  } catch (err) {
    return { ok: false, error: { code: err.code || 'error', message: redactProviderError(err.message, { secretValue }) } };
  }
}

// Reconcile EVERY reported identity from a stream against the expected set,
// returning the first refusal or, if all pass, the reconciliation for the primary
// reported id. A single out-of-set event anywhere in the stream fails closed.
function reconcileAllReported({ requested, reportedModels, primary, expectedReported }) {
  for (const reported of reportedModels ?? []) {
    const r = reconcileModelIdentity({ requested, reported, expectedReported });
    if (!r.ok) return r;
  }
  return reconcileModelIdentity({ requested, reported: primary, expectedReported });
}

// The prompt-token count the endpoint actually charged for this probe, from its
// own usage object — the only honest token measurement available (a character
// count divided by four is not a token count: repeated filler compresses into
// multi-character tokens, so a materially smaller window can pass a char-based
// check). Returns { tokens, source } where source ∈ { provider_usage | absent }.
// When the endpoint reports no usage, the count is null and the caller treats the
// context probe as unmeasured rather than inventing a token figure.
function measuredPromptTokens(usage) {
  const n = usage?.prompt_tokens ?? usage?.input_tokens;
  if (Number.isInteger(n) && n >= 0) return { tokens: n, source: 'provider_usage' };
  return { tokens: null, source: 'absent' };
}

/**
 * The deep-qualification operation for one (seat, backend, model, connection)
 * tuple — the single entry point doctor `--deep` and the server both call.
 * Runs the real probes, reconciles identity, writes a durable receipt from the
 * ACTUAL results (except on an identity refusal, which fails closed with none),
 * and returns the §9.4 qualification outcome.
 *
 * Returns:
 *   { qualified, seatType, model, identity, capabilities, receipt?, reason, error? }
 */
async function deepQualifyModelInternal({
  entry,
  model,
  seatType,
  expectedReported,
  streamImpl = streamChatCompletion,
  fetchImpl = fetch,
  contextProbeTokens,
  probedAt,
  now = Date.now(),
  onProgress,
} = {}) {
  const progress = (phase, status, detail = null) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ phase, status, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }); } catch {}
  };
  if (!WORDS_SEATS.includes(seatType)) {
    throw new Error(`deepQualifyModel exercises only words seats (${WORDS_SEATS.join(', ')}); "${seatType}" is out of Slice C scope`);
  }
  const req = SEAT_REQUIREMENTS[seatType];
  const envelope = PROMPT_ENVELOPES[seatType];
  const keyless = entry.auth?.kind === 'none';
  const secretValue = keyless ? undefined : process.env[entry.apiKeyEnv];

  // §9.3 model-discovery status is INFORMATIONAL — it gates nothing — but it is
  // reported at qualification AND doctor time so a declared model missing from a
  // valid listing (`unlisted`) or one whose discovery endpoint is unavailable
  // (`discovery_unavailable`) has a visible per-model state instead of silently
  // reading identical to a `listed` model. It is threaded through every return
  // path, including fail-closed ones.
  let discoveryStatus = 'discovery_unavailable';
  const fail = (reason, extra = {}) => {
    progress('qualification', 'failed', reason);
    return { qualified: false, seatType, model, reason, receipt: null, discoveryStatus, ...extra };
  };

  // Anchors are gathered first and are purely informational; a failure here
  // never blocks qualification, it only leaves the anchors `absent`.
  progress('discovery', 'running', 'checking the declared model and server identity anchors');
  const collected = await collectServerAnchors({ entry, fetchImpl, model });
  const { serialized: serverAnchors, anchors } = collected;
  discoveryStatus = collected.discoveryStatus;
  progress('discovery', 'demonstrated', discoveryStatus);
  // Salt/credential-free tuple descriptor used only to locate and revoke a
  // stale receipt when a probe cannot honestly write a replacement result.
  const tuple = {
    seatType,
    backendName: entry.name,
    backendKind: entry.kind,
    connection: connectionLabel(entry),
    requestedModelId: model,
    gateScope: 'n/a',
  };
  const failAndInvalidate = (reason, extra = {}) => {
    invalidateReceipt(tuple);
    return fail(reason, extra);
  };

  // ---- streaming/liveness + (reviewer) structured-output probe -------------
  const isReviewer = seatType === 'words_reviewer';
  progress('streaming', 'running', 'testing one bounded streaming response');
  const live = await runStream({
    entry, model, streamImpl, secretValue,
    prompt: isReviewer ? STRUCTURED_PROBE_PROMPT : LIVENESS_PROBE_PROMPT,
    timeoutMs: 120_000,
  });
  if (!live.ok) {
    progress('streaming', 'failed', live.error?.code || 'probe unreachable');
    return failAndInvalidate('probe_unreachable', { error: live.error, identity: null });
  }

  // Identity is reconciled BEFORE the draft/verdict is consumed. An unexpected
  // substitution kills the call as an infra refusal and writes no receipt.
  const identity = reconcileAllReported({ requested: model, reportedModels: live.reportedModels, primary: live.reported, expectedReported });
  if (!identity.ok) {
    progress('modelIdentity', 'failed', 'reported identity did not match the declared mapping');
    return failAndInvalidate('model_substituted', { identity, error: { code: 'model_identity', message: identity.detail } });
  }
  progress('modelIdentity', 'demonstrated', identity.mode);

  const capabilities = {};
  const probeResults = {};

  // streaming/liveness: demonstrated ONLY when the liveness/structured stream
  // actually delivered at least one non-empty SSE content delta. A clean return
  // is not enough — the adapter returns cleanly for an empty body or a
  // [DONE]-only response, so trusting the return alone would admit "streaming"
  // for a backend that produced no delta, never exercising the very SSE-delta
  // arrival (feeding the idle watchdog) this capability certifies (§9.2). No
  // observed delta is an ACTUAL failed probe result: it is recorded durably as
  // `streaming: failed` and flows through to writeReceipt — exactly like a
  // malformed structured-output or a failed context probe. Early-returning with
  // no receipt (the old behavior) left a previously-demonstrated receipt intact
  // on disk, so a backend whose stream regressed to empty/[DONE]-only kept
  // passing launch admission until expiry. Overwriting with a `failed` receipt
  // closes that gap. The remaining probes need a live stream, so when streaming
  // is not demonstrated they are skipped and their rows fail closed.
  const streamingLive = live.deltaCount > 0;
  capabilities.streaming = streamingLive ? CAP_STATES.DEMONSTRATED : CAP_STATES.FAILED;
  progress('streaming', streamingLive ? 'demonstrated' : 'failed', streamingLive ? `${live.deltaCount} content delta(s)` : 'no content delta observed');

  // structured-output: only the reviewer seat exercises it, through the REAL
  // normalizeReview. Pass → demonstrated + the verdict recorded; malformed →
  // failed AND the raw sample is retained locally (bounded, credential-scrubbed)
  // for operator diagnosis, OUTSIDE the capability fingerprint. words_maker's row
  // is n/a and never probed.
  if (isReviewer && streamingLive) {
    const norm = normalizeReview(live.text, 0, [], [], []);
    if (norm.ran) {
      capabilities.structuredOutput = CAP_STATES.DEMONSTRATED;
      probeResults.normalizerVerdict = norm.verdict;
      progress('structuredOutput', 'demonstrated', 'review output matched the gate schema');
    } else {
      capabilities.structuredOutput = CAP_STATES.FAILED;
      progress('structuredOutput', 'failed', 'review output did not match the gate schema');
      // §9.2 requires the raw malformed structured-output sample be kept locally
      // so operators can see WHY qualification failed. Persist it best-effort to
      // the diagnostics sink; it never enters the receipt/fingerprint and its
      // absence never blocks qualification.
      await persistMalformedSample({ entry, model, seatType, text: live.text, secretValue });
    }
  } else if (isReviewer) {
    progress('structuredOutput', 'failed', 'skipped because streaming was not demonstrated');
  } else {
    progress('structuredOutput', 'not_applicable', 'maker seats do not emit reviewer verdicts');
  }

  // ---- context-envelope probe (measured, §9.4) -----------------------------
  // The near-envelope input must ROUND-TRIP end to end: TWO distinct markers
  // bracket the filler — one at the very START of the message (before the filler)
  // and one at the very END (after it) — and the response must echo BOTH. A single
  // trailing marker was insufficient: a server that silently LEFT-truncates an
  // oversized prompt (Ollama's small default num_ctx is the driving case,
  // §9.2:1329-1335) keeps the tail and could echo a trailing marker while never
  // having seen most of the envelope. Requiring a marker the model can only
  // reproduce by reading the HEAD of the message defeats left-truncation, and the
  // tail marker still defeats right-truncation; only a backend that ingested the
  // whole envelope holds both. A generic nonempty reply is NOT a pass.
  const targetTokens = Number.isFinite(contextProbeTokens) ? contextProbeTokens : envelope.targetTokens;
  const contextMarkerHead = `CAMUS-CTX-${targetTokens}-HEAD`;
  const contextMarkerTail = `CAMUS-CTX-${targetTokens}-TAIL`;
  // Filler is VARIED natural-language tokens, not a run of one character:
  // repeated single characters collapse into multi-character tokens, so a
  // char-count/4 estimate wildly overstates the token size and a materially
  // smaller window would still echo the trailing marker. The filler is
  // over-provisioned (well past target*4 chars) so that on any common tokenizer
  // the endpoint's OWN reported prompt-token usage clears the target — the probe
  // then measures the window from that usage, never from the character count.
  const fillerUnit = 'context envelope probe filler token sequence number ';
  const buildContextPrompt = (fillerChars) => {
    const filler = fillerUnit.repeat(Math.ceil(Math.max(1, fillerChars) / fillerUnit.length)).slice(0, Math.max(0, fillerChars));
    return 'Capability probe (context envelope). TWO one-line MARKERs bracket a long block of filler: ' +
      'MARKER-HEAD appears at the very START of this message (immediately below) and MARKER-TAIL at the very END. ' +
      'Read the ENTIRE message and reply with ONLY those two marker lines.\n' +
      `MARKER-HEAD: ${contextMarkerHead}\n` +
      filler +
      `\nMARKER-TAIL: ${contextMarkerTail}`;
  };
  // Adaptive sizing to the REQUIRED envelope (§9.4). A fixed multiplier
  // (formerly ~12 chars/target-token) over-provisions on common tokenizers: it
  // can push a production 8,192-token probe well past 8,192 tokens, so a backend
  // whose effective window MEETS the envelope but rejects the oversized request
  // is wrongly recorded `failed` — failing a much larger request is no evidence
  // of failure at the required size. Instead: start from a conservative
  // chars/token estimate (deliberately LOW so the first request lands at or below
  // target, never far above it), then converge UPWARD using the endpoint's OWN
  // reported prompt usage until it just clears the target, within a small,
  // bounded attempt count. Success is still judged solely against measured usage,
  // never the character count.
  const CONTEXT_MAX_ATTEMPTS = 5;
  const CONTEXT_START_CHARS_PER_TOKEN = 3.5; // low: converge up, don't overshoot
  // Clear the target by a SMALL margin, never a blind multiple: the next request
  // is sized to the remaining measured deficit + ~5%, so a backend that meets the
  // envelope but rejects a much larger prompt is not wrongly failed. A fixed 20%
  // growth pushed an 8,192-token probe toward ~9,830 tokens, disqualifying a
  // backend capable of the required window but not the oversized request.
  const CONTEXT_MARGIN = 1.05;
  let charsPerToken = CONTEXT_START_CHARS_PER_TOKEN;
  let ctx = null;
  let measured = { tokens: null, source: 'absent' };
  let roundTripped = false;
  // Skip the real context calls entirely when streaming was not demonstrated:
  // with no live stream the loop cannot pass, so the window fails closed below
  // without spending on probes that cannot succeed.
  for (let attempt = 0; streamingLive && attempt < CONTEXT_MAX_ATTEMPTS; attempt++) {
    progress('contextWindow', 'running', `bounded envelope attempt ${attempt + 1} of ${CONTEXT_MAX_ATTEMPTS}`);
    const fillerChars = Math.max(0, Math.round(targetTokens * charsPerToken));
    ctx = await runStream({ entry, model, streamImpl, secretValue, prompt: buildContextPrompt(fillerChars), timeoutMs: 120_000 });
    // Fail-closed identity is enforced on EVERY actual probe call, BEFORE the
    // probe's pass/fail is interpreted: a silent model swap on a context request
    // is the same infra refusal as one on the liveness request, even when the
    // envelope itself would fail. A wrong `model` here writes no receipt. A
    // request that errored (ctx.ok:false) reported no model and cannot be a
    // substitution, so it is left to fail the envelope below.
    if (ctx.ok) {
      const ctxIdentity = reconcileAllReported({ requested: model, reportedModels: ctx.reportedModels, primary: ctx.reported, expectedReported });
      if (!ctxIdentity.ok) return failAndInvalidate('model_substituted', { identity: ctxIdentity, error: { code: 'model_identity', message: ctxIdentity.detail } });
    }
    // Both the head and the tail marker must survive: the head defeats silent
    // left-truncation, the tail defeats right-truncation, and only an endpoint
    // that ingested the whole envelope can reproduce both.
    roundTripped = ctx.ok && ctx.text.includes(contextMarkerHead) && ctx.text.includes(contextMarkerTail);
    measured = measuredPromptTokens(ctx.usage);
    // An errored request cannot be resized into success, and an endpoint that
    // reports no usage leaves the window unmeasured — both fail closed below.
    if (!ctx.ok || measured.tokens == null) break;
    // Envelope reached: the endpoint's own usage cleared the target. Stop —
    // growing further would only push the request needlessly past the envelope.
    if (measured.tokens >= targetTokens) break;
    // Under target: size the NEXT request toward the remaining measured DEFICIT,
    // not a fixed multiple of the whole envelope. Estimate chars/token from what
    // this request actually cost (whole-prompt tokens over filler chars slightly
    // under-counts, so the added filler runs a touch large — helping clear the
    // target), add just enough to cover the tokens still missing, and apply a
    // small margin so the request lands just above the envelope rather than 20%
    // past it. Stop early if the estimate cannot grow the request, so a
    // hard-capped small window fails rather than spinning attempts.
    const observedRatio = fillerChars / Math.max(1, measured.tokens);
    const deficitTokens = targetTokens - measured.tokens;
    const nextFillerChars = Math.ceil((fillerChars + deficitTokens * observedRatio) * CONTEXT_MARGIN);
    if (!(nextFillerChars > fillerChars)) break;
    charsPerToken = nextFillerChars / targetTokens;
  }
  // The EFFECTIVE request window is measured from the endpoint's OWN prompt-token
  // usage — the only honest measurement of how large a prompt it actually
  // processed. A character count is never substituted for it, and neither is a
  // DECLARED maximum: `/models` (or Ollama `/api/show`) advertises a model's
  // nominal context length, which can be far larger than the loaded/runtime
  // num_ctx that actually serves the request, so a declared window is no evidence
  // the effective window reached the target. When the endpoint reports no usage
  // the window is UNMEASURED and the probe fails closed rather than trusting the
  // advertised maximum — precisely the small-context case the RFC targets.
  // `measured` above holds the FINAL attempt's usage from the adaptive loop.
  const usageMet = measured.tokens != null && measured.tokens >= targetTokens;
  // The declared window is retained only as INFORMATIONAL provenance on the
  // recorded receipt (`configured`), never as a gate.
  const declaredWindow = anchors.reportedContextLength !== 'absent' ? Number(anchors.reportedContextLength) : null;
  // The envelope is demonstrated when BOTH bracketing markers round-trip AND the
  // endpoint's own reported prompt usage reached the target. A smaller effective
  // window (usage short of target, absent usage, or a truncated-away marker at
  // either end) still fails.
  const envelopeMet = roundTripped && usageMet;
  if (envelopeMet) {
    // Identity was already reconciled fail-closed above, for the same context
    // response, so a demonstrated envelope is known to be the requested model.
    // The measured usage is the demonstrated figure — always present here.
    const demonstratedAt = measured.tokens;
    capabilities.contextWindow = {
      // `configured`/`source` come from the endpoint anchor when present; when
      // no endpoint window was reported AND no operator window was supplied,
      // both stay null rather than inventing an `operator` provenance the
      // durable receipt never received. This is the declared maximum, recorded
      // for provenance only — it did NOT gate the demonstration.
      status: CAP_STATES.DEMONSTRATED,
      configured: declaredWindow,
      source: declaredWindow != null ? 'endpoint' : null,
      demonstratedAt,
    };
    probeResults.contextDemonstratedAt = demonstratedAt;
    probeResults.contextMeasurementSource = measured.source;
    progress('contextWindow', 'demonstrated', `${measured.tokens} provider-reported prompt tokens`);
  } else {
    // A window below the lane envelope (truncation at either end, an http
    // context-length error, an empty round-trip, or usage short of / absent for
    // the target) fails the probe — recorded, not fatal.
    capabilities.contextWindow = { status: CAP_STATES.FAILED, configured: null, source: null, demonstratedAt: null };
    probeResults.contextMeasurementSource = measured.source;
    progress('contextWindow', 'failed', measured.tokens == null ? 'provider usage was absent' : `${measured.tokens} provider-reported prompt tokens`);
  }

  // ---- durable receipt from the ACTUAL results -----------------------------
  // Discovery is presentation/provenance only. Persist the observed status so
  // Studio can explain listed/unlisted/unavailable without re-contacting a
  // provider on every config GET; it never gates qualification.
  probeResults.discoveryStatus = discoveryStatus;
  const input = qualInput({ entry, model, seatType, serverAnchors, keyless, secretValue, expectedReported });

  let receipt;
  try {
    progress('receipt', 'running', 'writing the bounded local qualification receipt');
    receipt = writeReceipt(input, { capabilities, probeResults, probedAt });
  } catch (err) {
    progress('receipt', 'failed', 'the local qualification receipt could not be written');
    return fail('receipt_unwritable', { identity, error: { code: 'receipt', message: redactProviderError(err.message, { secretValue }) } });
  }
  progress('receipt', 'demonstrated', 'local receipt written');

  const outcome = qualifySeat(input, { now });
  progress('qualification', outcome.qualified ? 'demonstrated' : 'failed', outcome.reason);
  return {
    qualified: outcome.qualified,
    seatType,
    model,
    identity,
    capabilities: receipt.capabilities,
    receipt,
    reason: outcome.reason,
    missing: outcome.missing,
    anchors,
    discoveryStatus,
    req,
  };
}

// The one qualification entry point for every transport. SSH gets a runtime
// URL only inside this wrapper; qual1's connection component remains the stable
// alias/remote-port identity assembled by connectionLabel above.
export async function deepQualifyModel({ tunnelManager, ...options } = {}) {
  const entry = options.entry;
  if (!isSupportedTransport(entry)) {
    throw new Error(`deepQualifyModel probes only ${SUPPORTED_TRANSPORTS.join('/')} transports; "${transportOf(entry)}" is unsupported and is never given a qual1 receipt`);
  }
  if (transportOf(entry) !== 'ssh_tunnel') return deepQualifyModelInternal(options);
  const manager = tunnelManager || getSharedTunnelManager();
  try { options.onProgress?.({ phase: 'transport', status: 'running', detail: 'opening the declared managed SSH tunnel' }); } catch {}
  let lease;
  try {
    lease = await manager.acquire(entry.connectionDetails || entry);
  } catch (error) {
    try { options.onProgress?.({ phase: 'transport', status: 'failed', detail: String(error?.code || 'tunnel_unavailable').slice(0, 120) }); } catch {}
    throw error;
  }
  try { options.onProgress?.({ phase: 'transport', status: 'demonstrated', detail: 'managed SSH tunnel is live' }); } catch {}
  const runtimeEntry = { ...entry, baseUrl: lease.url, tunnelLease: lease };
  try {
    return await deepQualifyModelInternal({ ...options, entry: runtimeEntry });
  } finally {
    await lease.release();
  }
}

// The words seat type each declared backend seat key maps to.
const WORDS_SEAT_OF = Object.freeze({ maker: 'words_maker', reviewer: 'words_reviewer' });

// The operator-declared expected-reported alias mapping for one (backend, model).
// §6.2: normally exactly { requested id }; an operator-documented mapping endpoint
// declares the alias the endpoint serves under (e.g. Ollama serving "qwen2.5:7b"
// as "qwen2.5-7b-instruct"). Declared on the backend entry as either
// `expectedReported` (array applying to every model) or a `{ [model]: [...] }`
// map, or per-seat on the decision. Absent → undefined (only the requested id is
// accepted). The requested id itself is always accepted by reconciliation.
export function expectedReportedFor(entry, seat, model) {
  const out = [];
  const collect = (v) => {
    if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string' && x));
    else if (v && typeof v === 'object' && Array.isArray(v[model])) out.push(...v[model].filter((x) => typeof x === 'string' && x));
    else if (typeof v === 'string' && v) out.push(v);
  };
  collect(entry?.expectedReported);
  collect(seat?.expectedReported);
  if (Array.isArray(seat?.aliases)) collect(seat.aliases);
  return out.length ? [...new Set(out)] : undefined;
}

/**
 * The doctor/server surface: deep-qualify EVERY declared openai_compat backend ×
 * declared model × declared seat, NOT merely the models the standing seat
 * decision happens to name. A per-run pairing may select any declared backend and
 * any of its declared models for either words seat it offers (§6.2/§9.4); the
 * launch gate then demands a valid receipt for exactly that (seat, backend,
 * model) tuple. Qualifying only the currently-decided model would strand every
 * alternate model — and every unused-but-declared backend — with a missing
 * receipt whose only fix ("run the doctor deep probes") skipped it. So each
 * declared (backend, model) is qualified for each seat the backend's `seats`
 * declaration offers. `seatDecisions` is used only to forward a per-seat alias
 * mapping when a decision names this exact backend+model. Advisory: a probe
 * failure is reported per row, never thrown.
 */
export async function qualifyUsedSeats({
  backends, seatDecisions, deep, streamImpl, fetchImpl, onTupleStart, onTupleFinish,
} = {}) {
  const rows = [];
  if (!deep) return rows;
  for (const entry of backends ?? []) {
    if (entry.kind !== 'openai_compat') continue;
    // Legacy HTTP remains out of qualification scope; managed SSH is probed
    // through its runtime lease by deepQualifyModel.
    if (!isSupportedTransport(entry)) continue;
    const keyless = entry.auth?.kind === 'none';
    if (!keyless && !process.env[entry.apiKeyEnv]) continue; // no key → the backend check already says so
    const models = Array.isArray(entry.models) ? entry.models : [];
    const seatKeys = Array.isArray(entry.seats) && entry.seats.length ? entry.seats : ['maker', 'reviewer'];
    for (const model of models) {
      for (const seatKey of seatKeys) {
        const seatType = WORDS_SEAT_OF[seatKey];
        if (!seatType) continue;
        // Forward an operator-declared expected-reported alias mapping. The
        // per-seat portion applies only when a standing decision names THIS exact
        // backend+model+seat; the entry-level mapping always applies.
        const decided = seatKey === 'maker' ? seatDecisions?.maker : seatDecisions?.reviewer;
        const seatForAlias = decided?.backend === entry.name && decided?.model === model ? decided : null;
        const expectedReported = expectedReportedFor(entry, seatForAlias, model);
        const id = `qual-${entry.name}-${model}-${seatType}`;
        const label = `Qualification "${entry.name}" · ${model} · ${seatType}`;
        let tupleControl = null;
        let finishAttempted = false;
        try {
          tupleControl = await onTupleStart?.({ entry, model, seatKey, seatType });
          const res = await deepQualifyModel({ entry, model, seatType, expectedReported, streamImpl, fetchImpl });
          finishAttempted = true;
          await onTupleFinish?.(tupleControl, { result: res, entry, model, seatKey, seatType });
          rows.push({
            id,
            label,
            backend: entry.name,
            model,
            seatType,
            connection: entry.connection || entry.connectionDetails?.name || null,
            ok: res.qualified,
            // §9.3 discovery status is appended as informational context on every
            // row (qualified or not); it never changes `ok`.
            detail: res.qualified
              ? `${model} qualified (identity ${res.identity?.mode}, discovery ${res.discoveryStatus})`
              : `${model} not qualified: ${res.reason}${res.missing?.length ? ` [${res.missing.join(', ')}]` : ''} (discovery ${res.discoveryStatus})${res.error ? ` — ${res.error.message}` : ''}`,
            discoveryStatus: res.discoveryStatus,
            capabilities: res.capabilities ?? null,
            fix: res.qualified ? null : 'run the words-seat probes and fix the failing capability before launch',
            advisory: true,
          });
        } catch (err) {
          if (tupleControl && !finishAttempted) {
            try {
              finishAttempted = true;
              await onTupleFinish?.(tupleControl, { error: err, entry, model, seatKey, seatType });
            } catch {}
          }
          rows.push({ id, label, ok: false, detail: redactProviderError(err.message), fix: null, advisory: true });
        }
      }
    }
  }
  return rows;
}

/**
 * The RUN-ADMISSION gate (Slice C, §9.2/§9.4, docs:2627-2629). Network-free: a
 * configurable openai_compat seat may not launch without a VALID qual1 receipt
 * for the run's seat type, and the accepted fingerprint is returned so the run
 * snapshot can record it and the round events + sealed pairing carry it unchanged.
 *
 * It locates the durable receipt for the (seat, backend, model, connection) tuple
 * by its key axes, then validates it against the LIVE operator-controlled identity
 * (connection, protocol, auth, versions, model) AND the LIVE server anchors —
 * re-collected here — plus expiry and the §9.4 required rows. Recomputing the
 * fingerprint from live values is the contract (docs §9.2:1397-1400): any
 * component mismatch — a changed Ollama digest/quant/context, a swapped loaded
 * model, a new server build — voids the receipt and names the component, exactly
 * as an expired or out-of-scope receipt refuses launch. Anchor discovery is
 * best-effort: an endpoint that never exposed anchors qualified with `absent`
 * and still reads `absent` live, so it continues to match.
 *
 * Returns { qualified, fingerprint?, seatType, reason, component?, missing? }.
 */
export async function seatQualification({ entry, model, seatType, expectedReported = expectedReportedFor(entry, null, model),
  fetchImpl = fetch, now = Date.now(), tunnelManager } = {}) {
  if (!WORDS_SEATS.includes(seatType)) {
    return { qualified: false, seatType, reason: 'out_of_scope_seat' };
  }
  if (entry?.kind !== 'openai_compat') {
    return { qualified: false, seatType, reason: 'not_configurable_backend' };
  }
  if (!isSupportedTransport(entry)) {
    return { qualified: false, seatType, reason: 'unsupported_transport' };
  }
  if (transportOf(entry) === 'ssh_tunnel' && !entry.tunnelLease) {
    const manager = tunnelManager || getSharedTunnelManager();
    let lease;
    try { lease = await manager.acquire(entry.connectionDetails || entry); }
    catch (error) { return { qualified: false, seatType, reason: 'tunnel', detail: error.message }; }
    try {
      return await seatQualification({ entry: { ...entry, baseUrl: lease.url, tunnelLease: lease }, model, seatType, expectedReported,
        fetchImpl, now, tunnelManager: manager });
    } finally { await lease.release(); }
  }
  const keyless = entry.auth?.kind === 'none';
  const secretValue = keyless ? undefined : process.env[entry.apiKeyEnv];
  if (!keyless && !secretValue) {
    return { qualified: false, seatType, reason: 'missing_credential' };
  }

  // Locate the stored receipt by its key axes (server anchors are irrelevant to
  // the tuple key), then reconcile the fingerprint against the anchors as they
  // are NOW — re-probed live — so weight/server drift under a stable served
  // alias voids the receipt instead of launching on a stale one.
  const lookup = qualInput({ entry, model, seatType, serverAnchors: 'lookup', keyless, secretValue, expectedReported });
  const stored = readStoredReceipt(lookup);
  if (!stored.ok) {
    return { qualified: false, seatType, reason: stored.state, component: stored.component };
  }
  const { serialized: liveAnchors } = await collectServerAnchors({ entry, fetchImpl, model });
  // §9.3: model discovery is INFORMATIONAL, but drift detection is per-anchor, not
  // all-or-nothing. Any anchor ACTUALLY OBSERVED live this launch is compared as
  // observed — including the class-specific weight anchors (Ollama /api/show
  // digest, llama.cpp /props build, LM Studio /api/v0/models arch) that are
  // collected INDEPENDENTLY of /v1/models. So an Ollama digest that changes while
  // /models is unreachable is still real, observed drift and still voids.
  // Only an anchor that collapsed to `absent` this launch — a transient
  // discovery/class-probe outage — falls back to the receipt's stored value, so a
  // working seat is never stranded on a listing hiccup. Wholesale-replacing the
  // freshly observed set with the stored one (the old behavior) discarded those
  // independent observations and let genuine digest drift slip through.
  const storedAnchors = stored.data.components.find((c) => c.name === 'serverAnchors')?.value;
  const anchorsForGate = mergeAnchorsForGate(liveAnchors, storedAnchors);
  const liveInput = qualInput({ entry, model, seatType, serverAnchors: anchorsForGate, keyless, secretValue, expectedReported });

  let outcome;
  try {
    outcome = qualifySeat(liveInput, { acceptedReceipt: stored.data, now });
  } catch (err) {
    return { qualified: false, seatType, reason: 'unqualifiable', detail: err.message };
  }
  return {
    qualified: outcome.qualified,
    fingerprint: outcome.qualified ? stored.data.fingerprint : undefined,
    seatType,
    reason: outcome.reason,
    component: outcome.component,
    missing: outcome.missing,
  };
}

/**
 * Network-free presentation/config-save gate for one declared words-seat tuple.
 * It validates the durable receipt against every CURRENT operator-controlled
 * input (backend/model/connection/protocol/auth/version/credential revision) and
 * expiry, using the receipt's own stored server anchors. Launch admission still
 * calls seatQualification() to re-observe available anchors immediately before
 * execution. This split keeps /api/config side-effect-free while ensuring a
 * picker never enables a tuple whose local decision no longer matches its
 * receipt.
 */
export function storedSeatQualification({ entry, model, seatType,
  expectedReported = expectedReportedFor(entry, null, model), now = Date.now() } = {}) {
  if (!WORDS_SEATS.includes(seatType)) {
    return { qualified: false, seatType, reason: 'out_of_scope_seat' };
  }
  if (entry?.kind !== 'openai_compat') {
    return { qualified: false, seatType, reason: 'not_configurable_backend' };
  }
  if (!isSupportedTransport(entry)) {
    return { qualified: false, seatType, reason: 'unsupported_transport' };
  }
  const keyless = entry.auth?.kind === 'none';
  const secretValue = keyless ? undefined : process.env[entry.apiKeyEnv];
  if (!keyless && !secretValue) {
    return { qualified: false, seatType, reason: 'missing_credential' };
  }
  const lookup = qualInput({ entry, model, seatType, serverAnchors: 'lookup', keyless, secretValue, expectedReported });
  const stored = readStoredReceipt(lookup);
  if (!stored.ok) {
    return { qualified: false, seatType, reason: stored.state, component: stored.component };
  }
  const storedAnchors = stored.data.components.find((c) => c.name === 'serverAnchors')?.value;
  if (typeof storedAnchors !== 'string' || !storedAnchors) {
    return { qualified: false, seatType, reason: 'voided', component: 'serverAnchors' };
  }
  const liveInput = qualInput({ entry, model, seatType, serverAnchors: storedAnchors, keyless, secretValue, expectedReported });
  let outcome;
  try {
    outcome = qualifySeat(liveInput, { acceptedReceipt: stored.data, now });
  } catch (err) {
    return { qualified: false, seatType, reason: 'unqualifiable', detail: err.message };
  }
  return {
    qualified: outcome.qualified,
    fingerprint: outcome.qualified ? stored.data.fingerprint : undefined,
    seatType,
    reason: outcome.reason,
    component: outcome.component,
    missing: outcome.missing,
    receipt: stored.data,
  };
}
