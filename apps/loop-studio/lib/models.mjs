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
import { isIP } from 'node:net';
import { deriveLineageSource } from './identity.mjs';

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

function requiredDeclaration(value, name) {
  const declared = required(value, name);
  if (declared === 'unknown') throw new Error(`${name} must be declared for a connection-bearing backend; "unknown" is reserved for legacy entries`);
  return declared;
}

const CONFIG_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa'];
const ANONYMOUS_PREFIX = '$legacy:'; // invalid as an operator name, so it cannot collide

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(normalizedHost(hostname));
}

function parseHttpUrl(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be an http(s) URL`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must be an http(s) URL`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials; use an env-var name`);
  return url;
}

function cleanUrl(url) {
  const value = url.toString();
  return value.endsWith('/') && url.pathname === '/' && !url.search && !url.hash
    ? value.slice(0, -1)
    : value.replace(/\/$/, '');
}

function isInternalDnsName(hostname) {
  const host = normalizedHost(hostname);
  return !host.includes('.')
    || host === 'metadata.google.internal'
    || host === 'instance-data.ec2.internal'
    || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function publicHttpsUrl(value, label) {
  const url = parseHttpUrl(value, label);
  const host = normalizedHost(url.hostname);
  if (url.protocol !== 'https:') throw new Error(`${label} direct_https requires https://`);
  if (isIP(host)) throw new Error(`${label} direct_https refuses literal-IP hosts; use loopback or ssh_tunnel`);
  if (isLoopbackHost(host) || isInternalDnsName(host)) {
    throw new Error(`${label} direct_https refuses localhost/private/internal hosts; use loopback or ssh_tunnel`);
  }
  return url;
}

// Classify a pre-connection baseUrl without changing the file on disk. Only a
// public HTTPS DNS name earns direct_https; every other valid non-loopback URL
// retains the old direct-fetch behavior under the loudly named legacy_http
// transport. The grandfather sidecar decides whether that transport may run in
// Task 8 — classification itself has no side effects.
export function classifyConnectionUrl(value, label = 'baseUrl') {
  const url = parseHttpUrl(value, label);
  const host = normalizedHost(url.hostname);
  if (isLoopbackHost(host)) return { kind: 'loopback', baseUrl: cleanUrl(url) };
  if (url.protocol === 'https:' && !isIP(host) && !isInternalDnsName(host)) {
    return { kind: 'direct_https', baseUrl: cleanUrl(url) };
  }
  return { kind: 'legacy_http', baseUrl: cleanUrl(url) };
}

function connectionBaseUrl(name, entry) {
  const label = `connections.${name}`;
  if (entry?.kind === 'loopback') {
    let url;
    if (entry.baseUrl !== undefined) {
      url = parseHttpUrl(entry.baseUrl, `${label}.baseUrl`);
    } else {
      if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
        throw new Error(`${label}.port must be an integer from 1 to 65535 when baseUrl is absent`);
      }
      const basePath = entry.basePath ?? '';
      if (typeof basePath !== 'string' || (basePath && !basePath.startsWith('/')) || /[?#]/.test(basePath)) {
        throw new Error(`${label}.basePath must be an absolute URL path without query or fragment`);
      }
      url = new URL(`http://127.0.0.1:${entry.port}${basePath}`);
    }
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(`${label} loopback refuses non-loopback host "${normalizedHost(url.hostname)}"`);
    }
    return cleanUrl(url);
  }
  if (entry?.kind === 'direct_https') {
    return cleanUrl(publicHttpsUrl(entry.baseUrl, `${label}.baseUrl`));
  }
  if (entry?.kind === 'legacy_http') {
    return cleanUrl(parseHttpUrl(entry.baseUrl, `${label}.baseUrl`));
  }
  if (entry?.kind === 'ssh_tunnel') {
    if (!isLoopbackHost(entry.remoteAddress)) {
      throw new Error(`${label}.remoteAddress must be remote loopback (localhost, 127.0.0.1, or ::1); forwarding to a third host is a pivot`);
    }
    throw new Error(`${label}.kind ssh_tunnel is not yet supported; see ADR for the managed tunnel slice`);
  }
  if (entry?.kind === 'remote_executor') {
    throw new Error(`${label}.kind remote_executor is not yet supported; see ADR for remote execution`);
  }
  throw new Error(`${label}.kind must be loopback, direct_https, or legacy_http`);
}

function parseConnection(name, entry, { anonymous = false } = {}) {
  if (!anonymous && !CONFIG_NAME.test(name)) {
    throw new Error(`connections.${name}: names are lowercase alphanumeric/dash/underscore, max 32 chars`);
  }
  const baseUrl = connectionBaseUrl(name, entry);
  return { name, kind: entry.kind, baseUrl, anonymous };
}

export function anonymousConnectionName(backendName) {
  return `${ANONYMOUS_PREFIX}${backendName}`;
}

// Includes deterministic anonymous connections for legacy bare-baseUrl
// backends. Callers receive one normalized connection vocabulary, while the
// source file remains byte-identical until an explicit settings write.
export function parseConnections(file = {}) {
  if (file.connections !== undefined && (file.connections === null || typeof file.connections !== 'object' || Array.isArray(file.connections))) {
    throw new Error('models.json connections must be an object keyed by connection name');
  }
  const out = {};
  for (const [name, entry] of Object.entries(file.connections ?? {})) {
    out[name] = parseConnection(name, entry);
  }
  for (const [backendName, entry] of Object.entries(file.backends ?? {})) {
    if (entry?.connection === undefined && entry?.baseUrl !== undefined) {
      const name = anonymousConnectionName(backendName);
      out[name] = parseConnection(name, classifyConnectionUrl(entry.baseUrl, `backends.${backendName}.baseUrl`), { anonymous: true });
    }
  }
  return out;
}

function validateBackendCommon(name, entry) {
  if (BUILTIN_BACKENDS[name]) throw new Error(`backends.${name} collides with a built-in backend name`);
  if (!CONFIG_NAME.test(name)) throw new Error(`backends.${name}: names are lowercase alphanumeric/dash/underscore, max 32 chars`);
  if (entry?.kind !== 'openai_compat') throw new Error(`backends.${name}.kind must be "openai_compat" (the only configurable kind)`);
  required(entry.provider, `backends.${name}.provider`);
  if (entry.provider === 'unknown' || entry.provider.includes(':')) throw new Error(`backends.${name}.provider must be a plain provider name`);
  if (!Array.isArray(entry.models) || !entry.models.length || entry.models.some((m) => typeof m !== 'string' || !m)) {
    throw new Error(`backends.${name}.models must be a non-empty list of model names — a declaration, never a probe`);
  }
  const seats = entry.seats ?? ['maker', 'reviewer'];
  if (!Array.isArray(seats) || !seats.length || seats.some((s) => !['maker', 'reviewer'].includes(s))) {
    throw new Error(`backends.${name}.seats may only name "maker" and/or "reviewer"`);
  }
  return { seats };
}

// The exact validator shipped before connection objects. Kept as a named,
// exported compatibility boundary so dual-write tests exercise the real old
// requirements rather than a test-only approximation.
export function validateLegacyCompatEntry(name, entry) {
  const { seats } = validateBackendCommon(name, entry);
  if (!/^https?:\/\//.test(entry.baseUrl || '')) throw new Error(`backends.${name}.baseUrl must be an http(s) URL`);
  required(entry.apiKeyEnv, `backends.${name}.apiKeyEnv`);
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

function authForBackend(name, entry) {
  const auth = entry.auth;
  if (auth && Object.keys(auth).some((key) => !['kind', 'envVar'].includes(key))) {
    throw new Error(`backends.${name}.auth may contain only kind and an env-var NAME; credential values are forbidden`);
  }
  if (auth?.kind === 'none') {
    if (Object.hasOwn(auth, 'envVar')) throw new Error(`backends.${name}.auth.kind "none" must not name an env var`);
    return { auth: { kind: 'none' }, apiKeyEnv: 'CAMUS_NO_AUTH' };
  }
  if (auth?.kind === 'env') {
    if (!ENV_NAME.test(auth.envVar || '')) {
      throw new Error(`backends.${name}.auth.envVar must be an env-var NAME, never a credential value`);
    }
    return { auth: { kind: 'env', envVar: auth.envVar }, apiKeyEnv: auth.envVar };
  }
  throw new Error(`backends.${name}.auth.kind must be "env" or "none"`);
}

function validateConnectionBackend(name, entry, connection) {
  const { seats } = validateBackendCommon(name, entry);
  const trainingOrg = requiredDeclaration(entry.trainingOrg, `backends.${name}.trainingOrg`);
  const modelFamily = requiredDeclaration(entry.modelFamily, `backends.${name}.modelFamily`);
  if (entry.protocol !== 'chat_completions') {
    throw new Error(`backends.${name}.protocol must be "chat_completions" until another protocol adapter ships`);
  }
  if (!Object.hasOwn(entry, 'derivedFrom')) {
    throw new Error(`models.json is missing backends.${name}.derivedFrom — declare a model-family name or null`);
  }
  if (entry.derivedFrom !== null && (typeof entry.derivedFrom !== 'string' || !entry.derivedFrom)) {
    throw new Error(`backends.${name}.derivedFrom must be a non-empty model-family name or null`);
  }
  const auth = authForBackend(name, entry);
  if (entry.baseUrl !== undefined) {
    const configuredUrl = cleanUrl(parseHttpUrl(entry.baseUrl, `backends.${name}.baseUrl`));
    if (configuredUrl !== connection.baseUrl) {
      throw new Error(`backends.${name}.baseUrl conflicts with connections.${connection.name}.baseUrl — remove it or make the declarations match`);
    }
  }
  if (entry.apiKeyEnv !== undefined) {
    if (!ENV_NAME.test(entry.apiKeyEnv)) {
      throw new Error(`backends.${name}.apiKeyEnv must be an env-var NAME, never a credential value`);
    }
    if (entry.apiKeyEnv !== auth.apiKeyEnv) {
      throw new Error(`backends.${name}.apiKeyEnv conflicts with backends.${name}.auth.envVar — remove it or make the declarations match`);
    }
  }
  const configuredLineage = entry.lineage && typeof entry.lineage === 'object' ? entry.lineage : null;
  const declared = { org: trainingOrg, family: modelFamily, derivedFrom: entry.derivedFrom ?? null };
  if (configuredLineage && Object.hasOwn(configuredLineage, 'source')) declared.source = configuredLineage.source;
  const endpointHost = normalizedHost(new URL(connection.baseUrl).hostname);
  const lineageSources = Object.fromEntries(entry.models.map((modelId) => [
    modelId,
    deriveLineageSource({
      connectionKind: connection.kind,
      endpointHost,
      modelId,
      declared,
    }),
  ]));
  return {
    name,
    kind: 'openai_compat',
    provider: entry.provider,
    baseUrl: connection.baseUrl,
    apiKeyEnv: auth.apiKeyEnv,
    models: [...entry.models],
    seats,
    effort: false,
    connection: connection.name,
    connectionDetails: { ...connection },
    transport: connection.kind,
    protocol: entry.protocol,
    trainingOrg,
    modelFamily,
    derivedFrom: entry.derivedFrom ?? null,
    inferenceOperator: entry.inferenceOperator ?? 'unknown',
    auth: auth.auth,
    lineageSources,
  };
}

// An openai_compat entry is a decision someone wrote down, so a malformed one
// refuses to load rather than half-working. The API key itself never lives in
// config — only the NAME of the env var that holds it.
function validateCompatEntry(name, entry, connections) {
  if (entry?.connection !== undefined) {
    const connectionName = required(entry.connection, `backends.${name}.connection`);
    const connection = Object.hasOwn(connections, connectionName) ? connections[connectionName] : undefined;
    if (!connection) {
      throw new Error(`backends.${name} names undeclared connection "${connectionName}" — declare it under top-level connections or fix the backend reference`);
    }
    return validateConnectionBackend(name, entry, connection);
  }
  const legacy = validateLegacyCompatEntry(name, entry);
  const connection = connections[anonymousConnectionName(name)];
  return { ...legacy, connection: connection.name, connectionDetails: { ...connection }, anonymousConnection: true };
}

function connectionForWrite(name, entry) {
  const normalized = parseConnection(name, entry);
  let out;
  if (entry.kind === 'loopback' && entry.baseUrl === undefined) {
    out = { kind: 'loopback', port: entry.port };
    if (entry.basePath !== undefined) out.basePath = entry.basePath;
  } else {
    out = { kind: entry.kind, baseUrl: normalized.baseUrl };
  }
  if (typeof entry.why === 'string' && entry.why) out.why = entry.why;
  return out;
}

function connectionBackendForWrite(name, entry, connections) {
  const normalized = validateCompatEntry(name, entry, connections);
  const out = {
    kind: 'openai_compat',
    provider: normalized.provider,
    connection: normalized.connection,
    protocol: normalized.protocol,
    trainingOrg: normalized.trainingOrg,
    modelFamily: normalized.modelFamily,
    auth: normalized.auth,
    models: normalized.models,
    seats: normalized.seats,
    // Complete legacy surface: this is deliberately redundant so rolling back
    // the reader cannot make one new entry take every backend down.
    baseUrl: normalized.baseUrl,
    apiKeyEnv: normalized.apiKeyEnv,
  };
  if (entry.derivedFrom !== undefined) out.derivedFrom = entry.derivedFrom;
  if (entry.inferenceOperator !== undefined) out.inferenceOperator = entry.inferenceOperator;
  if (typeof entry.why === 'string' && entry.why) out.why = entry.why;
  validateLegacyCompatEntry(name, out);
  return out;
}

function readFile() {
  return readDecision().file;
}

// Every backend a seat may name: built-ins plus the file's opt-in entries.
export function listBackends(file = readFile()) {
  const connections = parseConnections(file);
  const out = { ...BUILTIN_BACKENDS };
  for (const [name, entry] of Object.entries(file.backends ?? {})) {
    out[name] = validateCompatEntry(name, entry, connections);
  }
  return out;
}

function backendOf(name, backends, seatName) {
  const backend = Object.hasOwn(backends, name) ? backends[name] : undefined;
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
// backend) or { backend, model }. `connections` is a full replacement when
// supplied; `backends` is a keyed patch. Omitting both preserves old backend
// entries exactly instead of silently upgrading them on an ordinary save.
export function updateModels({ maker, reviewer, effort, roundCap, connections: connectionEdits, backends: backendEdits }) {
  const file = readFile();
  if (connectionEdits !== undefined) {
    if (connectionEdits === null || typeof connectionEdits !== 'object' || Array.isArray(connectionEdits)) {
      throw new Error('models.json connections must be an object keyed by connection name');
    }
    file.connections = Object.fromEntries(
      Object.entries(connectionEdits).map(([name, entry]) => [name, connectionForWrite(name, entry)]),
    );
  }
  if (backendEdits !== undefined) {
    if (backendEdits === null || typeof backendEdits !== 'object' || Array.isArray(backendEdits)) {
      throw new Error('models.json backends must be an object keyed by backend name');
    }
    file.backends = { ...(file.backends ?? {}), ...backendEdits };
  }

  const connectionBearingEdit = connectionEdits !== undefined || backendEdits !== undefined;
  if (connectionBearingEdit && file.backends && Object.values(file.backends).some((entry) => entry?.connection !== undefined)) {
    const parsedConnections = parseConnections(file);
    const explicitlyEdited = new Set(Object.keys(backendEdits ?? {}));
    for (const [name, entry] of Object.entries(file.backends)) {
      if (entry?.connection === undefined) continue;
      if (connectionEdits === undefined && !explicitlyEdited.has(name)) continue;
      // Changing the referenced connection intentionally changes the derived
      // rollback URL. A separately supplied backend edit, however, must not be
      // allowed to smuggle a conflicting legacy field past the validator.
      const candidate = connectionEdits !== undefined && !explicitlyEdited.has(name)
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'baseUrl'))
        : entry;
      file.backends[name] = connectionBackendForWrite(name, candidate, parsedConnections);
    }
  }

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
  return [...new Set(models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .map((m) => m.slug))];
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
