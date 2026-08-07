// Resolved run decisions. Precedence: run request > env override > local
// operator state > tracked checks/models.json defaults.
// There is deliberately NO fallback to account/CLI defaults — a model that
// isn't named here is a model nobody decided on. Resolved per call (not at
// import) so the studio's settings panel can change a decision between runs
// without a restart.
//
// Since the multi-model-seats slice (docs/MULTI-MODEL-SEATS.md) each seat is a
// BACKEND + MODEL pair: the built-in CLI backends (claude → anthropic,
// codex → openai) plus opt-in `openai_compat` entries declared under
// `backends` in the file. A seat without a backend field means the legacy
// pairing, so pre-seats files keep working unchanged.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The tracked file is a PUBLIC FALLBACK, not mutable operator state. Settings
// persist under ~/.camus so choosing a live dogfood pairing cannot dirty the
// repository or publish one person's expensive choice as the apparent default.
// STUDIO_MODELS_FILE remains the explicit embedding/test override and receives
// the same read/write semantics as the local operator file.
const defaultsPath = () => join(__dirname, '..', 'checks', 'models.json');
const operatorPath = () => join(homedir(), '.camus', 'studio', 'models.json');
const filePath = () => process.env.STUDIO_MODELS_FILE || operatorPath();

function readDecision() {
  const path = filePath();
  try {
    return {
      file: JSON.parse(readFileSync(path, 'utf8')),
      source: process.env.STUDIO_MODELS_FILE ? 'STUDIO_MODELS_FILE' : 'local operator state',
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return { file: JSON.parse(readFileSync(defaultsPath(), 'utf8')), source: 'checks/models.json defaults' };
  }
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// The built-in backends. Their auth, spawn contract, and fail-closed
// normalization are proven; everything else is an explicit config entry.
const BUILTIN_BACKENDS = {
  claude: { name: 'claude', kind: 'claude_cli', provider: 'anthropic', seats: ['maker', 'reviewer'], effort: false },
  codex: { name: 'codex', kind: 'codex_cli', provider: 'openai', seats: ['maker', 'reviewer'], effort: true },
};

function required(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`models.json is missing ${name} — every model must be an explicit decision`);
  }
  return value;
}

// An openai_compat entry is a decision someone wrote down, so a malformed one
// refuses to load rather than half-working. The API key itself never lives in
// config — only the NAME of the env var that holds it.
function validateCompatEntry(name, entry) {
  if (BUILTIN_BACKENDS[name]) throw new Error(`backends.${name} collides with a built-in backend name`);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`backends.${name}: names are lowercase alphanumeric/dash/underscore, max 32 chars`);
  if (entry?.kind !== 'openai_compat') throw new Error(`backends.${name}.kind must be "openai_compat" (the only configurable kind)`);
  required(entry.provider, `backends.${name}.provider`);
  if (entry.provider === 'unknown' || entry.provider.includes(':')) throw new Error(`backends.${name}.provider must be a plain provider name`);
  if (!/^https?:\/\//.test(entry.baseUrl || '')) throw new Error(`backends.${name}.baseUrl must be an http(s) URL`);
  required(entry.apiKeyEnv, `backends.${name}.apiKeyEnv`);
  if (!Array.isArray(entry.models) || !entry.models.length || entry.models.some((m) => typeof m !== 'string' || !m)) {
    throw new Error(`backends.${name}.models must be a non-empty list of model names — a declaration, never a probe`);
  }
  const seats = entry.seats ?? ['maker', 'reviewer'];
  if (!Array.isArray(seats) || !seats.length || seats.some((s) => !['maker', 'reviewer'].includes(s))) {
    throw new Error(`backends.${name}.seats may only name "maker" and/or "reviewer"`);
  }
  return {
    name,
    kind: 'openai_compat',
    provider: entry.provider,
    baseUrl: entry.baseUrl.replace(/\/$/, ''),
    apiKeyEnv: entry.apiKeyEnv,
    models: [...entry.models],
    seats,
    effort: false, // no configured backend honors a reasoning-effort knob yet
  };
}

function readFile() {
  return readDecision().file;
}

// Every backend a seat may name: built-ins plus the file's opt-in entries.
export function listBackends(file = readFile()) {
  const out = { ...BUILTIN_BACKENDS };
  for (const [name, entry] of Object.entries(file.backends ?? {})) {
    out[name] = validateCompatEntry(name, entry);
  }
  return out;
}

function backendOf(name, backends, seatName) {
  const backend = backends[name];
  if (!backend) throw new Error(`models.json names unknown backend "${name}" for ${seatName} — declare it under backends or pick a built-in`);
  if (!backend.seats.includes(seatName)) throw new Error(`backend "${name}" does not offer the ${seatName} seat`);
  return backend;
}

export function getModels() {
  const decision = readDecision();
  const file = decision.file;
  const decisionSource = decision.source;
  const backends = listBackends(file);
  const rawCap = Number(process.env.ROUND_CAP ?? file.loop?.roundCap);

  // A seat without a backend field is the legacy pairing — the file predates
  // seat selection and its meaning was claude-writes / codex-reviews.
  const makerBackend = backendOf(file.maker?.backend || 'claude', backends, 'maker');
  const reviewerBackend = backendOf(file.reviewer?.backend || 'codex', backends, 'reviewer');

  // For a configurable backend the declared models list is authoritative, so
  // a hand-edited model outside it is a typo caught HERE — at load, where
  // doctor and /api/config surface it — not after a run has already started.
  // CLI backends stay advisory: claude accepts unlisted ids by design, and the
  // codex cache is live-rewritten, so hard-failing on it would race its writers.
  const assertDeclared = (backend, model, seatName) => {
    if (model && backend.kind === 'openai_compat' && !backend.models.includes(model)) {
      throw new Error(`models.json ${seatName}.model "${model}" is not in backend "${backend.name}"'s declared models list (${backend.models.join(', ')}) — fix the typo or declare the model`);
    }
  };
  assertDeclared(makerBackend, file.maker?.model, 'maker');
  assertDeclared(reviewerBackend, file.reviewer?.model, 'reviewer');

  // Env overrides are session decisions, but they are CLI-shaped: CLAUDE_MODEL
  // only means anything when the maker seat runs the claude backend, and
  // CODEX_MODEL/CODEX_EFFORT only when the reviewer seat runs codex. Applying
  // them to another backend would silently redirect a decision nobody made.
  const makerEnv = makerBackend.name === 'claude' ? process.env.CLAUDE_MODEL : undefined;
  const reviewerEnv = reviewerBackend.name === 'codex' ? process.env.CODEX_MODEL : undefined;
  const effortEnv = reviewerBackend.name === 'codex' ? process.env.CODEX_EFFORT : undefined;

  return {
    maker: {
      backend: makerBackend.name,
      provider: makerBackend.provider,
      model: makerEnv || required(file.maker?.model, 'maker.model'),
      source: makerEnv ? 'env:CLAUDE_MODEL' : decisionSource,
    },
    reviewer: {
      backend: reviewerBackend.name,
      provider: reviewerBackend.provider,
      model: reviewerEnv || required(file.reviewer?.model, 'reviewer.model'),
      // Effort is a requested knob only where the backend honors one (codex
      // today). Elsewhere it is null — a fabricated tier is not a decision.
      effort: reviewerBackend.effort ? (effortEnv || file.reviewer?.effort || 'medium') : null,
      // Model and effort are two decisions and can come from different places
      // (CODEX_MODEL env but effort from the file, or vice versa), so each names
      // its own provenance — a single conflated `source` would misattribute one.
      modelSource: reviewerEnv ? 'env:CODEX_MODEL' : decisionSource,
      effortSource: reviewerBackend.effort ? (effortEnv ? 'env:CODEX_EFFORT' : decisionSource) : 'not honored by this backend',
    },
    loop: {
      // NaN-proof: a typo'd cap must never skip the review loop.
      roundCap: Number.isFinite(rawCap) ? Math.min(6, Math.max(1, rawCap)) : 3,
      source: process.env.ROUND_CAP !== undefined ? 'env:ROUND_CAP' : decisionSource,
    },
  };
}

// The identity string receipts use everywhere: provider:model. A legacy
// snapshot (no provider recorded) falls back to the seat's historical
// provider — that IS what those snapshots meant when they were taken.
export const seatIdentity = (seat, legacyProvider) =>
  `${seat?.provider || legacyProvider}:${seat?.model || 'not-recorded'}`;

// The settings panel writes THROUGH this to local operator state (or the
// explicit STUDIO_MODELS_FILE override). The tracked defaults remain immutable.
// maker/reviewer accept either the legacy string (a model on the seat's current
// backend) or { backend, model }.
export function updateModels({ maker, reviewer, effort, roundCap }) {
  const file = readFile();
  const backends = listBackends(file);
  const stamp = `set from the studio settings panel, ${new Date().toISOString().slice(0, 10)}`;
  const asSeat = (value, current, seatName) => {
    if (value === undefined) return null;
    const next = typeof value === 'string'
      ? { backend: current?.backend || (seatName === 'maker' ? 'claude' : 'codex'), model: value }
      : { backend: required(value.backend, `${seatName}.backend`), model: required(value.model, `${seatName}.model`) };
    backendOf(next.backend, backends, seatName); // refuse an unknown backend at write time
    return next;
  };
  const nextMaker = asSeat(maker, file.maker, 'maker');
  if (nextMaker && (nextMaker.model !== file.maker.model || nextMaker.backend !== (file.maker.backend || 'claude'))) {
    file.maker = { backend: nextMaker.backend, model: nextMaker.model, why: stamp };
  }
  const nextReviewer = asSeat(reviewer, file.reviewer, 'reviewer');
  const reviewerChanged = nextReviewer && (nextReviewer.model !== file.reviewer.model || nextReviewer.backend !== (file.reviewer.backend || 'codex'));
  const effortChanged = effort && effort !== file.reviewer.effort;
  if (reviewerChanged || effortChanged) {
    file.reviewer = {
      backend: nextReviewer?.backend ?? (file.reviewer.backend || 'codex'),
      model: nextReviewer?.model ?? file.reviewer.model,
      effort: effort || file.reviewer.effort,
      why: stamp,
    };
  }
  if (roundCap && roundCap !== file.loop?.roundCap) {
    file.loop = { roundCap, why: stamp };
  }
  mkdirSync(dirname(filePath()), { recursive: true });
  writeFileSync(filePath(), JSON.stringify(file, null, 2) + '\n');
  return getModels();
}

export function modelsSummary() {
  const m = getModels();
  const effort = m.reviewer.effort ? ` (${m.reviewer.effort})` : '';
  return `maker ${m.maker.backend}:${m.maker.model} [${m.maker.provider}] · reviewer ${m.reviewer.backend}:${m.reviewer.model}${effort} [${m.reviewer.provider}] · rounds ${m.loop.roundCap}`;
}

// Codex marks internal models `visibility: 'hide'` in its cache (e.g.
// codex-auto-review, the reviewer codex runs for itself). Offer ONLY what codex
// itself lists — a picker must never surface a model the normal codex UI
// withholds, or a run decision could be made that codex never intended to be
// selectable. Pure so the filter is directly testable.
export function reviewerSlugsFromCache(cache) {
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .map((m) => m.slug);
}

function codexModels() {
  let models = ['gpt-5.4', 'gpt-5.4-mini'];
  let source = 'fallback';
  try {
    // STUDIO_CODEX_CACHE_FILE pins the cache for tests: the real file is
    // live-rewritten by every codex app-server on the machine (ChatGPT app,
    // IDE extensions), so an assertion against it races those writers.
    const cachePath = process.env.STUDIO_CODEX_CACHE_FILE || join(homedir(), '.codex', 'models_cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    const slugs = reviewerSlugsFromCache(cache);
    if (slugs.length) { models = slugs; source = 'codex_cache'; }
  } catch { /* cache absent or unreadable: the conservative fallback stands */ }
  return { models, source };
}

// The pickable model lists for the settings panel. Makers are the Claude CLI's
// stable aliases; reviewers come from codex's own cache when it exists (the
// machine's real, listable options) and a small curated fallback otherwise —
// deliberately conservative, since with no cache we cannot confirm what the
// installed CLI will accept. `reviewerSource` tells a caller whether the list is
// CLI-verified or a best-effort default, and the server validates writes against
// these lists so a value that is not offerable can never be saved.
//
// This LEGACY shape (claude makers + codex reviewers, bare model strings) still
// feeds Compare & Learn and audit-only replay, whose frozen experiment schemas
// pin those exact catalogs. Seat selection for single runs uses seatCatalog().
export function modelCatalog() {
  const m = getModels();
  // Maker has no model cache to check claude against, so a configured maker is a
  // real decision, never a hidden one — surface it if it is not a known alias.
  // Only a CLAUDE-backend maker decision belongs in this catalog; a compat or
  // codex maker decision is not a claude alias and must not be offered as one.
  const makerAliases = ['haiku', 'sonnet', 'opus'];
  const maker = m.maker.backend !== 'claude' || makerAliases.includes(m.maker.model)
    ? [...makerAliases]
    : [m.maker.model, ...makerAliases];

  const codex = codexModels();
  let reviewer = codex.models;
  const reviewerSource = codex.source;

  // A current reviewer that codex's cache does NOT list — a hidden model like
  // codex-auto-review set via CODEX_MODEL, or one dropped from the cache — must
  // NEVER become selectable just by being the current decision (that was the
  // hole: the current value was unshifted back into the picker unconditionally).
  // Report it as current-but-unavailable instead. With no cache we cannot judge
  // availability, so the fallback still allows the current decision through.
  // A non-codex reviewer decision is simply not this catalog's business.
  const reviewerIsCodex = m.reviewer.backend === 'codex';
  const reviewerCurrentAvailable = !reviewerIsCodex || reviewer.includes(m.reviewer.model) || reviewerSource === 'fallback';
  if (reviewerIsCodex && reviewerSource === 'fallback' && !reviewer.includes(m.reviewer.model)) {
    reviewer = [m.reviewer.model, ...reviewer];
  }
  return { maker, reviewer, reviewerSource, reviewerCurrent: reviewerIsCodex ? m.reviewer.model : reviewer[0], reviewerCurrentAvailable };
}

// The seat catalog: every { backend, provider, model } a seat may run, with
// the source of each list named. This is what the settings panel, the launch
// form, and the run-request validator consume — the picker and the engine
// read the same truth, so the UI cannot express a state the engine refuses.
export function seatCatalog() {
  const decision = readDecision();
  const file = decision.file;
  const backends = listBackends(file);
  const codex = codexModels();
  const makerAliases = ['haiku', 'sonnet', 'opus'];

  const entriesFor = (seatName) => {
    const out = [];
    for (const backend of Object.values(backends)) {
      if (!backend.seats.includes(seatName)) continue;
      const models = backend.name === 'claude' ? makerAliases
        : backend.name === 'codex' ? codex.models
          : backend.models;
      const source = backend.name === 'claude' ? 'builtin_alias'
        : backend.name === 'codex' ? codex.source
          : decision.source;
      for (const model of models) {
        out.push({ backend: backend.name, provider: backend.provider, model, source, effort: backend.effort });
      }
    }
    return out;
  };

  return {
    maker: entriesFor('maker'),
    reviewer: entriesFor('reviewer'),
    reviewerSource: codex.source,
    backends: Object.values(backends).map((b) => ({ name: b.name, kind: b.kind, provider: b.provider, seats: b.seats, effort: b.effort })),
  };
}

// True when {backend, model} appears in the seat's catalog. The server uses
// this on every write path (config save, run request) so an unofferable pair
// can never become a decision.
export function seatOffered(catalogEntries, backend, model) {
  return catalogEntries.some((entry) => entry.backend === backend && entry.model === model);
}

// Grounding through the managed Claude connector runs retrieval inside the
// maker adapter, so the maker seat must be the claude backend there. Pure so
// the guard is testable and the server + engine share one judgement.
export function groundingNeedsClaudeMaker({ ground, hivemindMode, makerBackend }) {
  return ground === true && hivemindMode === 'claude' && makerBackend !== 'claude';
}

// The Build lane's decision record. The camus gate is a FIXED claude-maker /
// codex-reviewer pairing — code-lane forwards these model names straight into
// `claude --model` and CAMUS_CODEX_MODEL — so a words-lane seat selection must
// never leak into it (audit P1, 2026-08-04: a reversed pair sent gpt-5.6-sol
// to Claude and sonnet to codex). A build run either gets a gate-compatible
// snapshot or a refusal that names the fix; there is no silent substitution.
export function gateModels() {
  const m = getModels();
  if (m.maker.backend !== 'claude' || m.reviewer.backend !== 'codex') {
    return {
      ok: false,
      error: `The Build lane runs the fixed claude-maker/codex-reviewer gate, but the current decisions are maker ${m.maker.backend}:${m.maker.model} and reviewer ${m.reviewer.backend}:${m.reviewer.model}. Pick a claude maker and a codex reviewer in Settings before a build run.`,
    };
  }
  return { ok: true, models: m };
}
