// RFC §9.2 / §9.4 capability-qualification foundation for the loopback /
// direct_https words seats (docs/OPEN-MODEL-SEATS-RFC.md §9.2, §9.4, §6.1).
//
// Capability is a PROBE RESULT with a stored receipt, or it is `unprobed`. This
// module is the storage + binding + validation floor beneath any probe: it
// writes durable 0600 receipts, binds each to a versioned `qual1:` fingerprint
// over exactly the 16 ordered §9.2 components (never a bare lookup key), and
// answers the §9.4 per-seat requirement matrix. Probe EXECUTION and network I/O
// stay out — the caller runs the probe and hands the results in; this module
// records, reads, and validates.
//
// A receipt binds to a complete fingerprint, so validity at read time is a
// full recompute from LIVE seat-identity values: any component mismatch voids
// the receipt AND NAMES which component changed; expiry voids by date. The two
// time fields (probe date + TTL horizon) ride OUTSIDE the hash so that expiry is
// a comparison, never a hash break.
//
// Component 15 (credential/account revision) reuses the grandfather machine-salt
// discipline: for auth.kind:env it is HMAC-SHA256(machineSalt, name ‖ value)
// truncated to 16 hex; the value itself never appears in the receipt or a log.
// For auth.kind:none (keyless loopback) it is the literal `none`.
//
// Config is resolved PER CALL, never at import: STUDIO_CAPABILITY_DIR overrides
// the receipt directory; the salt rides the grandfather base so a single
// STUDIO_GRANDFATHER_DIR points salt + receipts at one fixture in tests.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadMachineSalt,
  studioAtomicWrite,
  STUDIO_FILE_MODE,
  STUDIO_DIR_MODE,
} from './grandfather.mjs';

// Length-prefixed field joiner, identical discipline to grandfather.markerFor:
// every field is prefixed with its UTF-8 byte length so no field's content can
// be shifted across a boundary to forge an identical serialization.
const SEP = '\x1f';

// The versioned fingerprint header (the `fp1:`/`qual1:` discipline). Bump when
// the canonical serialization or component set changes so an old receipt reads
// as a visible mismatch rather than silently matching under new rules.
const FP_VERSION = 'qual1';

// The probe-suite version (component 2): which probes ran and with which pass
// criteria. Bump when a probe's pass criteria change so stale receipts void.
export const PROBE_SUITE_VERSION = 'probes-1';

const RECEIPT_SCHEMA_VERSION = 1;
const DEFAULT_TTL_DAYS = 30;

// ---- the 16 §9.2 components, in order --------------------------------------
// Ordered names; each maps to exactly one raw string stored beside the hash.
// Renaming/reordering is a serialization change → bump FP_VERSION.
export const COMPONENT_NAMES = Object.freeze([
  'fingerprintFormatVersion', // 1
  'probeSuiteVersion', // 2
  'seatType', // 3
  'backend', // 4  name + kind
  'connection', // 5  kind + identity (host:port / full base URL)
  'protocol', // 6
  'requestedModelId', // 7
  'authMode', // 8  env-var NAME, or literal `none`
  'serverAnchors', // 9  absent anchors recorded as `absent`
  'normalizerVersion', // 10
  'promptEnvelopeVersion', // 11
  'decodingKnobs', // 12
  'executorVersion', // 13 `none` for http_client
  'adapterContractVersion', // 14
  'credentialRevision', // 15 HMAC(name‖value) | `none`
  'gateScope', // 16 `n/a` for words seats
]);

// ---- three-state capability vocabulary (§6.1) ------------------------------
export const CAP_STATES = Object.freeze({
  DEMONSTRATED: 'demonstrated',
  FAILED: 'failed',
  UNPROBED: 'unprobed',
  NOT_APPLICABLE: 'not_applicable',
});

// ---- §9.4 per-seat requirement matrix (data) -------------------------------
// All four seat rows are represented for completeness. Only the two words seats
// are ever exercised/probed here; gate_reviewer / agent_maker rows are inert
// placeholders honoring the no-CLI-reviewer scope (their toolCalling / gate
// semantics are owned by later slices and never consulted by this module).
export const SEAT_REQUIREMENTS = Object.freeze({
  words_reviewer: Object.freeze({
    structuredOutput: 'required',
    toolCalling: 'n/a',
    streaming: 'required',
    contextWindow: 'required',
  }),
  words_maker: Object.freeze({
    structuredOutput: 'n/a', // deliverable is markdown, judged by the reviewer seat
    toolCalling: 'n/a',
    streaming: 'required',
    contextWindow: 'required',
  }),
  // ---- inert placeholders (out of scope; never probed here) ----
  gate_reviewer: Object.freeze({
    structuredOutput: 'required',
    toolCalling: 'scope_dependent', // light=n/a, full=required (§9.4 note)
    streaming: 'required',
    contextWindow: 'required',
  }),
  agent_maker: Object.freeze({
    structuredOutput: 'required',
    toolCalling: 'required',
    streaming: 'required',
    contextWindow: 'required',
  }),
});

// The seats this module actually exercises/probes.
export const WORDS_SEATS = Object.freeze(['words_reviewer', 'words_maker']);

// The capability rows that carry into a receipt payload.
const CAP_ROWS = Object.freeze([
  'structuredOutput',
  'toolCalling',
  'streaming',
  'contextWindow',
]);

// ---- location resolution (per call) ----------------------------------------

function capabilitiesDir() {
  if (process.env.STUDIO_CAPABILITY_DIR) return process.env.STUDIO_CAPABILITY_DIR;
  const base = process.env.STUDIO_GRANDFATHER_DIR || join(homedir(), '.camus', 'studio');
  return join(base, 'capabilities');
}

function ttlDays() {
  const raw = process.env.STUDIO_CAPABILITY_TTL_DAYS;
  if (raw === undefined) return DEFAULT_TTL_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_DAYS;
  return n;
}

// ---- component derivation --------------------------------------------------

// Fail-closed: a component that cannot be produced throws. There is no
// `unavailable` sentinel — a receipt that cannot name every identity axis it
// binds to must not be written. `absent` (component 9) is an EXPLICIT recorded
// value, not a missing one.
function requireStr(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `capability fingerprint component "${name}" is unproducible (got ${
        value === undefined ? 'undefined' : JSON.stringify(value)
      }); fail-closed — no receipt is written`
    );
  }
  return value;
}

// Component 15. auth.kind:env → HMAC-SHA256(machineSalt, name ‖ value) → 16 hex.
// auth.kind:none → literal `none`. The raw credential value is used only to feed
// the HMAC and is never returned, stored, or logged.
//
// `create` gates machine-salt minting: a WRITE (first probe) may mint the salt
// (`create:true`), a READ never does (`create:false`) — a read of an env-auth
// seat whose salt was lost must REFUSE so the original salt can be restored,
// never silently mint a different salt and report credential drift.
function credentialRevision(auth, { create = true } = {}) {
  if (!auth || typeof auth !== 'object') {
    throw new Error('capability auth descriptor is required (kind: "env" | "none")');
  }
  if (auth.kind === 'none') return 'none';
  if (auth.kind === 'env') {
    const name = requireStr(auth.envVarName, 'auth.envVarName');
    if (typeof auth.value !== 'string' || auth.value.length === 0) {
      throw new Error('auth.kind:env requires a non-empty credential value to bind the revision');
    }
    const salt = loadMachineSalt({ create });
    // name ‖ value under the length-prefixed joiner so a rename OR a value change
    // both move the input; truncated to 16 hex per §9.2 component 15.
    const msg = [auth.envVarName, auth.value]
      .map((f) => `${Buffer.byteLength(f, 'utf8')}${SEP}${f}`)
      .join(SEP);
    return createHmac('sha256', salt).update(msg, 'utf8').digest('hex').slice(0, 16);
  }
  throw new Error(`unsupported auth.kind "${auth.kind}" (expected "env" or "none")`);
}

// Map a live seat-identity descriptor to the ordered raw components. Every
// component is validated here; component 8 records the env-var NAME (never a
// value), and component 9 expects the caller to have already collapsed absent
// anchors to the literal `absent`.
function deriveComponents(input, { create = true } = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('capability input descriptor is required');
  }
  const auth = input.auth;
  const authMode = auth && auth.kind === 'env' ? requireStr(auth.envVarName, 'auth.envVarName') : 'none';

  const values = {
    fingerprintFormatVersion: FP_VERSION,
    probeSuiteVersion: requireStr(input.probeSuiteVersion ?? PROBE_SUITE_VERSION, 'probeSuiteVersion'),
    seatType: requireStr(input.seatType, 'seatType'),
    backend: `${requireStr(input.backendName, 'backendName')}${SEP}${requireStr(input.backendKind, 'backendKind')}`,
    connection: requireStr(input.connection, 'connection'),
    protocol: requireStr(input.protocol, 'protocol'),
    requestedModelId: requireStr(input.requestedModelId, 'requestedModelId'),
    authMode,
    serverAnchors: requireStr(input.serverAnchors, 'serverAnchors'),
    normalizerVersion: requireStr(input.normalizerVersion, 'normalizerVersion'),
    promptEnvelopeVersion: requireStr(input.promptEnvelopeVersion, 'promptEnvelopeVersion'),
    decodingKnobs: requireStr(input.decodingKnobs, 'decodingKnobs'),
    executorVersion: requireStr(input.executorVersion, 'executorVersion'),
    adapterContractVersion: requireStr(input.adapterContractVersion, 'adapterContractVersion'),
    credentialRevision: credentialRevision(auth, { create }),
    gateScope: requireStr(input.gateScope ?? 'n/a', 'gateScope'),
  };

  return COMPONENT_NAMES.map((name) => ({ name, value: requireStr(values[name], name) }));
}

// Canonical, length-prefixed, versioned serialization → sha-256 → `qual1:`hex.
function canonicalSerialize(components) {
  const body = components
    .map(({ name, value }) => {
      const nb = Buffer.byteLength(name, 'utf8');
      const vb = Buffer.byteLength(value, 'utf8');
      return `${nb}${SEP}${name}${SEP}${vb}${SEP}${value}`;
    })
    .join(SEP);
  // The header pins the encoding version INTO the hashed bytes, so a serialization
  // change cannot collide with an old fingerprint even at equal component values.
  return `${FP_VERSION}${SEP}${components.length}${SEP}${body}`;
}

// `create` propagates to the component-15 credential HMAC (see credentialRevision):
// default true (write / fresh computation may mint the machine salt); readReceipt
// passes false so a read never mints a salt.
export function computeFingerprint(input, { create = true } = {}) {
  const components = deriveComponents(input, { create });
  const digest = createHash('sha256').update(canonicalSerialize(components), 'utf8').digest('hex');
  return { fingerprint: `${FP_VERSION}:${digest}`, components };
}

// ---- receipt file location -------------------------------------------------
// The receipt is keyed by the §9.2 identity TUPLE the RFC pins — (seat type,
// backend, model, connection, gate scope) (RFC §9.2:1441-1444, "a receipt
// qualifies exactly one (seat type, backend, model, connection[, gate scope])
// tuple"). Each distinct tuple is its OWN durable qualification slot, so
// qualifying model B for a seat never overwrites model A's still-valid receipt;
// a picker can hold a live qualification per candidate model at once.
//
// The OTHER 11 §9.2 components (protocol, server anchors / model weights digest,
// normalizer, prompt envelope, decoding knobs, credential revision, …) are
// qualification FACTS that the fingerprint binds and read-time recompute
// validates: a change to any of them on the SAME tuple VOIDS the receipt and
// NAMES which component changed ("model digest changed: re-qualify",
// §9.2:1397-1400). A change to a KEY axis is a different qualification question
// entirely — its own slot — so it reads as `missing` (that model was never
// probed on this seat), which is a first-class §9.2 state ("missing, expired, or
// voided runs the probe"), not a silent loss of the prior receipt. The key is a
// length-prefixed sha-256 so the tuple yields a safe, collision-resistant
// filename and no field can be shifted across a boundary to alias two tuples.

// The 5 §9.2 key axes that locate a receipt (components 3, 4, 5, 7, 16); the
// remaining 11 are drift axes validated by fingerprint recompute.
const KEY_COMPONENTS = Object.freeze(['seatType', 'backend', 'connection', 'requestedModelId', 'gateScope']);

// The raw values of the 5 KEY axes, derived WITHOUT the component-15 credential
// HMAC. None of the key axes is the credential revision, so a receipt LOOKUP (and
// therefore a missing-receipt read) never touches the machine salt — a read of an
// unprobed seat must not mint salt state (§9.2 credential discipline).
function keyComponentValues(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('capability input descriptor is required');
  }
  return {
    seatType: requireStr(input.seatType, 'seatType'),
    backend: `${requireStr(input.backendName, 'backendName')}${SEP}${requireStr(input.backendKind, 'backendKind')}`,
    connection: requireStr(input.connection, 'connection'),
    requestedModelId: requireStr(input.requestedModelId, 'requestedModelId'),
    gateScope: requireStr(input.gateScope ?? 'n/a', 'gateScope'),
  };
}

function tupleKey(input) {
  const vals = keyComponentValues(input);
  const msg = KEY_COMPONENTS.map((name) => {
    const v = vals[name];
    return `${Buffer.byteLength(v, 'utf8')}${SEP}${v}`;
  }).join(SEP);
  return createHash('sha256').update(msg, 'utf8').digest('hex');
}

function receiptPath(input) {
  return join(capabilitiesDir(), `${tupleKey(input)}.json`);
}

// ---- capability payload normalization --------------------------------------

function normalizeContextWindow(cw, defaultStatus = CAP_STATES.UNPROBED) {
  if (!cw || typeof cw !== 'object') {
    return { status: defaultStatus, configured: null, source: null, demonstratedAt: null };
  }
  const status = cw.status ?? defaultStatus;
  return {
    status,
    configured: cw.configured ?? null,
    source: cw.source ?? null, // 'operator' | 'endpoint' | null
    demonstratedAt: typeof cw.demonstratedAt === 'number' ? cw.demonstratedAt : null,
  };
}

// Three-state (+ not_applicable / contextWindow object) per §6.1. A row the §9.4
// seat matrix marks `n/a` is recorded as `not_applicable` UNCONDITIONALLY —
// n/a rows "are never probed" (§9.4:1443-1444), so any caller-supplied verdict on
// one is discarded rather than persisted: a durable receipt can never record a
// false capability (e.g. a words_maker `structuredOutput: demonstrated`, or either
// words seat's `toolCalling: demonstrated`) for a later reader. A row the contract
// DOES exercise takes the caller's verdict, defaulting to `unprobed` when omitted,
// so "nobody checked" is never distinguishable upward from "checked and passed".
function normalizeCapabilities(caps = {}, seatType) {
  const req = SEAT_REQUIREMENTS[seatType];
  const isNa = (row) => Boolean(req && req[row] === 'n/a');
  const rowValue = (row) => (isNa(row) ? CAP_STATES.NOT_APPLICABLE : caps[row] ?? CAP_STATES.UNPROBED);
  return {
    structuredOutput: rowValue('structuredOutput'),
    toolCalling: rowValue('toolCalling'),
    streaming: rowValue('streaming'),
    contextWindow: isNa('contextWindow')
      ? { status: CAP_STATES.NOT_APPLICABLE, configured: null, source: null, demonstratedAt: null }
      : normalizeContextWindow(caps.contextWindow, CAP_STATES.UNPROBED),
  };
}

// ---- write -----------------------------------------------------------------

/**
 * Write a durable 0600 capability receipt. Fingerprint + raw components are
 * derived from the live descriptor; the caller supplies the three-state
 * capability verdicts and per-probe results. probedAt + ttlDays ride OUTSIDE the
 * fingerprint. Returns the stored payload (never the credential value).
 */
export function writeReceipt(input, { capabilities = {}, probeResults = {}, probedAt } = {}) {
  // create:true — a first probe (write) is the only place allowed to mint the
  // machine salt for the component-15 credential HMAC.
  const { fingerprint, components } = computeFingerprint(input, { create: true });
  const nowIso = typeof probedAt === 'string' ? probedAt : new Date().toISOString();
  const days = ttlDays();
  const expiresAt = new Date(new Date(nowIso).getTime() + days * 86400000).toISOString();

  const payload = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    fingerprint,
    components, // every raw component stored beside the hash (§9.2)
    capabilities: normalizeCapabilities(capabilities, input.seatType),
    probeResults: {
      // each probe's RESULT, not just pass/fail (§9.2 payload, §6.1)
      contextDemonstratedAt: probeResults.contextDemonstratedAt ?? null,
      normalizerVerdict: probeResults.normalizerVerdict ?? null,
      toolTranscriptDigest: probeResults.toolTranscriptDigest ?? null,
    },
    probedAt: nowIso, // outside the hash
    ttlDays: days, // outside the hash
    expiresAt, // outside the hash
  };

  const dir = capabilitiesDir();
  mkdirSync(dir, { recursive: true, mode: STUDIO_DIR_MODE });
  studioAtomicWrite(receiptPath(input), `${JSON.stringify(payload, null, 2)}\n`, STUDIO_FILE_MODE);
  return payload;
}

// ---- read + validate -------------------------------------------------------

function loadPayload(input) {
  const path = receiptPath(input);
  if (!existsSync(path)) return { ok: false, state: 'missing' };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, state: 'missing' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, state: 'unparseable' };
  }
  if (!data || data.schemaVersion !== RECEIPT_SCHEMA_VERSION || typeof data.fingerprint !== 'string') {
    return { ok: false, state: 'unparseable' };
  }
  // A receipt is only trustworthy if it STILL carries its complete, correctly
  // ordered 16 raw components AND those components hash to the stored fingerprint.
  // A receipt whose `components` were deleted or altered while the fingerprint,
  // capabilities, and expiry were retained is corrupt/tampered, not a
  // qualification — reject it (name the fingerprint, since no single live
  // component is the culprit) rather than accept it on the fingerprint alone.
  if (!receiptComponentsIntact(data)) {
    return { ok: false, state: 'voided', component: 'fingerprint' };
  }
  return { ok: true, data };
}

// The stored raw component array must be present, complete (all 16), in the §9.2
// order with the exact names, every value a non-empty string, AND recompute to
// the stored fingerprint. This is the on-disk integrity gate that keeps the
// read/qualify path from trusting a fingerprint whose backing components no longer
// exist or no longer match it.
function receiptComponentsIntact(data) {
  const comps = data.components;
  if (!Array.isArray(comps) || comps.length !== COMPONENT_NAMES.length) return false;
  for (let i = 0; i < COMPONENT_NAMES.length; i++) {
    const c = comps[i];
    if (!c || typeof c !== 'object') return false;
    if (c.name !== COMPONENT_NAMES[i]) return false; // exact names, exact order
    if (typeof c.value !== 'string' || c.value.length === 0) return false;
  }
  const digest = createHash('sha256').update(canonicalSerialize(comps), 'utf8').digest('hex');
  return data.fingerprint === `${FP_VERSION}:${digest}`;
}

function firstChangedComponent(stored, live) {
  const storedByName = new Map((stored ?? []).map((c) => [c.name, c.value]));
  for (const { name, value } of live) {
    if (storedByName.get(name) !== value) return name;
  }
  // Fingerprint differs but no component-value diff found (e.g. stored raw
  // components were tampered to match live while the hash did not): name the
  // whole fingerprint so the void is still explicit.
  return 'fingerprint';
}

/**
 * Validate a receipt that the caller has already selected/accepted against the
 * current live descriptor. Unlike readReceipt(), this does not perform tuple
 * lookup: the presented receipt is the identity claim, so a mismatch on ANY of
 * the 16 components (including seat/backend/connection/model/gate scope) is a
 * void with the changed component named. This distinction lets independent
 * tuple slots coexist while preventing a previously accepted receipt from
 * being silently re-attributed after its live seat identity changes.
 */
export function validateReceiptAgainstInput(receipt, input, { now = Date.now() } = {}) {
  if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || typeof receipt.fingerprint !== 'string') {
    return { ok: false, state: 'unparseable' };
  }
  if (!receiptComponentsIntact(receipt)) {
    return { ok: false, state: 'voided', component: 'fingerprint' };
  }

  let live;
  try {
    live = computeFingerprint(input, { create: false });
  } catch (err) {
    return { ok: false, state: 'credential_unavailable', detail: err.message };
  }

  if (receipt.fingerprint !== live.fingerprint) {
    return { ok: false, state: 'voided', component: firstChangedComponent(receipt.components, live.components) };
  }
  const expMs = new Date(receipt.expiresAt).getTime();
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  if (!Number.isFinite(expMs) || nowMs >= expMs) {
    return { ok: false, state: 'expired', expiresAt: receipt.expiresAt };
  }
  return { ok: true, receipt };
}

/**
 * Read the receipt for a tuple and validate it against LIVE identity values.
 * Returns:
 *   { ok:true, receipt }
 *   { ok:false, state:'missing'|'unparseable' }
 *   { ok:false, state:'voided', component:<name> }   — a §9.2 component changed
 *   { ok:false, state:'expired', expiresAt }          — TTL horizon passed
 *   { ok:false, state:'credential_unavailable' }      — env-auth salt lost; refuse
 * `now` is injectable for hermetic expiry tests.
 *
 * The receipt is looked up and structurally validated FIRST; only when one is
 * actually present do we recompute the live fingerprint. That recompute runs with
 * create:false, so a read never mints a machine salt: a missing receipt needs no
 * credential HMAC at all, and a present env-auth receipt whose salt was lost
 * refuses (credential_unavailable) instead of silently deriving a different
 * revision and reporting spurious drift.
 */
export function readReceipt(input, { now = Date.now() } = {}) {
  const loaded = loadPayload(input); // salt-free lookup + on-disk integrity
  if (!loaded.ok) return loaded; // missing/unparseable/corrupt → no credential HMAC
  return validateReceiptAgainstInput(loaded.data, input, { now });
}

// ---- §9.4 seat qualification -----------------------------------------------

function requirementsFor(seatType) {
  const req = SEAT_REQUIREMENTS[seatType];
  if (!req) throw new Error(`unknown seat type "${seatType}"`);
  return req;
}

function rowStatus(caps, row) {
  if (row === 'contextWindow') return caps?.contextWindow?.status ?? CAP_STATES.UNPROBED;
  return caps?.[row] ?? CAP_STATES.UNPROBED;
}

// A required row is satisfied only when it is `demonstrated` AND carries the
// probe evidence §9.2 mandates for it (§9.2:1390-1393): the context window a
// measured `demonstratedAt` size, structured output a normalizer verdict, tool
// calling a transcript digest. Streaming/liveness has no stored result artifact,
// so `demonstrated` alone satisfies it. A `demonstrated` status with null
// evidence is an unsupported claim and must NOT seat a model — capability
// verdicts and probe results ride outside the fingerprint, so a tampered or
// half-written receipt cannot be caught by hash recompute; this gate is the
// backstop.
function rowSatisfied(row, caps, probeResults) {
  if (rowStatus(caps, row) !== CAP_STATES.DEMONSTRATED) return false;
  if (row === 'contextWindow') return typeof caps?.contextWindow?.demonstratedAt === 'number';
  if (row === 'structuredOutput') {
    return typeof probeResults?.normalizerVerdict === 'string' && probeResults.normalizerVerdict.length > 0;
  }
  if (row === 'toolCalling') {
    return typeof probeResults?.toolTranscriptDigest === 'string' && probeResults.toolTranscriptDigest.length > 0;
  }
  return true; // streaming/liveness: no stored result artifact (§9.2)
}

/**
 * §9.4 check: a seat is qualified only when EVERY `required` row is
 * `demonstrated` on a valid (fingerprint-matching, unexpired) receipt for the
 * exact (seatType, backend, model, connection) tuple. `n/a` rows never block;
 * a missing/voided/expired receipt is ineligible with the fix named.
 *
 * Scope: only the two words seats are exercised. Calling this for the inert
 * gate_reviewer / agent_maker placeholders throws — their qualification is a
 * later slice's job and their toolCalling row is scope-dependent, so this
 * module must never silently answer for them.
 */
export function qualifySeat(input, opts = {}) {
  const seatType = requireStr(input.seatType, 'seatType');
  if (!WORDS_SEATS.includes(seatType)) {
    throw new Error(
      `qualifySeat only exercises words seats (${WORDS_SEATS.join(', ')}); "${seatType}" is an inert §9.4 placeholder handled by a later slice`
    );
  }
  const req = requirementsFor(seatType);

  // A catalog/snapshot that already carries an accepted receipt must validate
  // THAT receipt, rather than looking up a new tuple and losing provenance as a
  // generic `missing` result when a key identity axis changed.
  const read = opts.acceptedReceipt
    ? validateReceiptAgainstInput(opts.acceptedReceipt, input, opts)
    : readReceipt(input, opts);
  if (!read.ok) {
    return {
      qualified: false,
      reason: read.state, // 'missing' | 'voided' | 'expired' | 'unparseable'
      component: read.component, // present on 'voided'
      missing: [],
      fix:
        read.state === 'voided'
          ? `capability component "${read.component}" changed — re-qualify ${seatType} for this backend/model/connection`
          : `capability receipt ${read.state} — run the ${seatType} probes at launch preflight`,
    };
  }

  const caps = read.receipt.capabilities;
  const probeResults = read.receipt.probeResults || {};
  const missing = [];
  for (const row of CAP_ROWS) {
    if (req[row] !== 'required') continue; // n/a / scope_dependent rows never block a words seat
    if (!rowSatisfied(row, caps, probeResults)) missing.push(row);
  }

  if (missing.length > 0) {
    return {
      qualified: false,
      reason: 'requirements_unmet',
      missing,
      fix: `required capability rows not demonstrated with probe evidence for ${seatType}: ${missing.join(', ')}`,
    };
  }
  return { qualified: true, reason: 'demonstrated', missing: [], receipt: read.receipt };
}
