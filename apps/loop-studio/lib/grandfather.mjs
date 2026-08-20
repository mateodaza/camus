// The §7 fail-closed grandfather sidecar (docs/OPEN-MODEL-SEATS-RFC.md §7,
// acceptance tests 5 + 14). Nothing in the running app imports this yet — it is
// purely additive; the production trigger that calls initGrandfather() is wired
// in Task 8. It does NOT import identity.mjs and never touches checks/models.json.
//
// The grandfather boundary is durable, one-time, and fail-closed. Two artifacts
// live under ~/.camus/studio so deletion is DETECTABLE:
//   - grandfather.json (0600): the versioned records file, written FIRST.
//   - grandfather.initialized (0600): the marker, written AFTER records.
// The inventory runs exactly once — only when NEITHER artifact exists. A
// records-present / marker-absent state is CRASH RECOVERY: validate the existing
// records and finish the marker, never a second inventory. Once the marker
// exists, initialization never runs again on this machine.
//
// Every mutation is atomic (temp file in the same dir, fsync, rename). Every
// record's marker is HMAC-SHA256(machineSalt, backendName‖url‖source‖why‖recordedAt)
// — SOURCE and WHY are inside the HMAC, so provenance cannot be edited without
// breaking the marker. The salt is a persisted per-machine secret; a record copied
// from another machine (different salt) fails its HMAC and refuses.
//
// Config is resolved PER CALL, never at import: STUDIO_GRANDFATHER_DIR overrides
// the directory so tests can point at a fixture. Zero new deps beyond
// node:crypto / node:fs (+ node:os / node:path for locations).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
// Unambiguous field joiner + a null sentinel so `why: null` cannot collide with
// any operator text and fields cannot be shifted across the HMAC boundary.
const SEP = '\x1f';
const NULL_WHY = '\0null';

// ---- per-call location resolution ------------------------------------------

function resolveDir() {
  return process.env.STUDIO_GRANDFATHER_DIR || join(homedir(), '.camus', 'studio');
}

function paths() {
  const dir = resolveDir();
  return {
    dir,
    json: join(dir, 'grandfather.json'),
    marker: join(dir, 'grandfather.initialized'),
    salt: join(dir, '.machine-salt'),
  };
}

function releaseVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

// ---- atomic write ----------------------------------------------------------

function atomicWrite(filePath, contents, mode) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.${basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd); // durability: the bytes hit disk before the rename
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, filePath); // atomic swap: readers see old or new, never a hybrid
  chmodSync(filePath, mode); // openSync mode is umask-masked; pin it exactly
}

// ---- per-machine salt ------------------------------------------------------

function readMachineSalt(p, { create = false } = {}) {
  if (existsSync(p.salt)) {
    const encoded = readFileSync(p.salt, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(encoded)) {
      throw new Error(
        'grandfather machine salt is invalid; restore ~/.camus/studio/.machine-salt before loading legacy_http backends'
      );
    }
    return Buffer.from(encoded, 'hex');
  }
  if (!create) {
    throw new Error(
      'grandfather machine salt is missing; restore ~/.camus/studio/.machine-salt before loading legacy_http backends'
    );
  }
  const salt = randomBytes(32);
  atomicWrite(p.salt, salt.toString('hex'), FILE_MODE);
  return salt;
}

// ---- record markers --------------------------------------------------------

// Length-prefixed canonical encoding: every field is prefixed with its UTF-8
// byte length, so no field's content (even one that itself contains SEP) can be
// shifted across a boundary into an adjacent field to forge an identical HMAC
// input. SOURCE is additionally pinned to a closed enum by validRecordShape.
function markerFor(salt, r) {
  const why = r.why === null || r.why === undefined ? NULL_WHY : r.why;
  const fields = [r.backendName, r.url, r.source, why, r.recordedAt];
  const msg = fields.map((f) => `${Buffer.byteLength(f, 'utf8')}${SEP}${f}`).join(SEP);
  return createHmac('sha256', salt).update(msg, 'utf8').digest('hex');
}

function hmacEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// The closed RFC source enum. Snapshot records carry why:null;
// operator_confirmation records MUST carry non-empty operator text.
const VALID_SOURCES = new Set(['snapshot', 'operator_confirmation']);

function validIdentityFields(backendName, url) {
  return (
    typeof backendName === 'string' &&
    backendName.trim().length > 0 &&
    typeof url === 'string' &&
    url.trim().length > 0
  );
}

function assertIdentityFields(backendName, url) {
  if (!validIdentityFields(backendName, url)) {
    throw new Error('grandfather backendName and url must be non-empty strings');
  }
}

function validRecordShape(r) {
  if (
    !r ||
    !validIdentityFields(r.backendName, r.url) ||
    typeof r.source !== 'string' ||
    typeof r.recordedAt !== 'string' ||
    r.recordedAt.length === 0 ||
    typeof r.marker !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(r.marker) ||
    !VALID_SOURCES.has(r.source)
  ) {
    return false;
  }
  // Confirmations require a recorded reason; only snapshots may have why:null.
  if (r.source === 'operator_confirmation') {
    return typeof r.why === 'string' && r.why.trim().length > 0;
  }
  return r.why === null;
}

// ---- load + validate -------------------------------------------------------
// Returns { ok:true, data } or { ok:false, state } where state NAMES the failure
// ('missing' | 'unparseable' | 'wrong-version' | 'HMAC-broken').

function loadAndValidate(p, salt) {
  if (!existsSync(p.json)) return { ok: false, state: 'missing' };
  let raw;
  try {
    raw = readFileSync(p.json, 'utf8');
  } catch {
    return { ok: false, state: 'missing' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, state: 'unparseable' };
  }
  if (!data || data.schemaVersion !== 1) return { ok: false, state: 'wrong-version' };
  if (
    typeof data.initializedAt !== 'string' ||
    data.initializedAt.length === 0 ||
    (data.releaseVersion !== null && typeof data.releaseVersion !== 'string') ||
    !Array.isArray(data.records)
  ) {
    return { ok: false, state: 'unparseable' };
  }
  for (const r of data.records) {
    if (!validRecordShape(r)) return { ok: false, state: 'unparseable' };
    if (!hmacEq(markerFor(salt, r), r.marker)) return { ok: false, state: 'HMAC-broken' };
  }
  return { ok: true, data };
}

function writeGrandfatherJson(p, data) {
  atomicWrite(p.json, `${JSON.stringify(data, null, 2)}\n`, FILE_MODE);
}

function writeMarker(p, initializedAt, relVersion) {
  const marker = {
    initializedAt,
    releaseVersion: relVersion ?? null,
  };
  atomicWrite(p.marker, `${JSON.stringify(marker, null, 2)}\n`, FILE_MODE);
}

// ---- crash recovery --------------------------------------------------------
// records-present + marker-absent: VALIDATE existing records (schema + HMAC) and
// write the marker ONLY. Never re-runs the inventory, never inspects config. Any
// caller entering after a crash calls this first so the marker gets finished.

function finishMarkerIfRecovering(p, salt) {
  if (!existsSync(p.json) || existsSync(p.marker)) return { recovered: false };
  const loaded = loadAndValidate(p, salt);
  if (!loaded.ok) return { recovered: false, state: loaded.state };
  writeMarker(p, loaded.data.initializedAt, loaded.data.releaseVersion);
  return { recovered: true };
}

// ---- refusals --------------------------------------------------------------

function refuseState(state) {
  return {
    ok: false,
    reason: 'records_invalid',
    state,
    message:
      `grandfather records ${state} but initialization is complete — ` +
      'restore ~/.camus/studio/grandfather.json or re-confirm each legacy_http ' +
      'backend explicitly (confirmLegacy).',
  };
}

function refuseUnrecorded(entry) {
  return {
    ok: false,
    reason: 'unrecorded',
    message:
      `legacy_http backend "${entry.backendName}" (${entry.url}) has no grandfather ` +
      'record and refuses to load. Upgrade paths: (1) move the service to loopback ' +
      '(127.0.0.1), (2) front it with an ssh_tunnel connection, or (3) put it behind a ' +
      `real HTTPS endpoint. Or confirm it explicitly: confirmLegacy("${entry.backendName}", ` +
      `"${entry.url}", "<why>").`,
  };
}

// ---- public API ------------------------------------------------------------

/**
 * One-time inventory. Runs ONLY when NEITHER artifact exists: writes records
 * first (source:'snapshot', why:null), then the marker. Idempotent — a call when
 * either artifact already exists never re-snapshots and never inspects config; a
 * records-present/marker-absent state is finished via crash recovery instead.
 */
export function initGrandfather({ legacyEntries = [] } = {}) {
  const p = paths();

  // A completed initialization is a true no-op: do not inspect config and do
  // not mint a replacement salt if the persisted one has gone missing.
  if (existsSync(p.marker)) return { initialized: true, action: 'noop' };
  if (existsSync(p.json)) {
    // records present, marker absent -> crash recovery, NEVER a second inventory
    const salt = readMachineSalt(p);
    const res = finishMarkerIfRecovering(p, salt);
    return { initialized: res.recovered, action: 'recovered', state: res.state };
  }

  // neither artifact exists -> the one and only inventory
  if (!Array.isArray(legacyEntries)) {
    throw new Error('initGrandfather legacyEntries must be an array');
  }
  for (const entry of legacyEntries) {
    assertIdentityFields(entry?.backendName, entry?.url);
  }
  const salt = readMachineSalt(p, { create: true });
  const recordedAt = new Date().toISOString();
  const records = legacyEntries.map((e) => {
    const r = { backendName: e.backendName, url: e.url, source: 'snapshot', why: null, recordedAt };
    r.marker = markerFor(salt, r);
    return r;
  });
  const data = {
    schemaVersion: 1,
    initializedAt: recordedAt,
    releaseVersion: releaseVersion(),
    records,
  };
  writeGrandfatherJson(p, data); // records FIRST, atomically + fsync
  writeMarker(p, data.initializedAt, data.releaseVersion); // THEN the marker
  return { initialized: true, action: 'inventory', count: records.length };
}

/**
 * Consult the sidecar for a legacy-shaped entry. With the marker present, a
 * missing/unparseable/wrong-version/HMAC-broken grandfather.json refuses EVERY
 * legacy_http entry with the state named; a legacy-shaped entry not in the records
 * refuses naming the three upgrade paths + the confirmation action; a matching
 * valid record loads. Finishes the marker first if entering after a crash.
 */
export function consult(entry) {
  const p = paths();

  assertIdentityFields(entry?.backendName, entry?.url);

  // No records means there is nothing to authenticate and, critically, no
  // reason to create a new machine salt merely by consulting the gate.
  if (!existsSync(p.json)) return refuseState('missing');

  const salt = readMachineSalt(p);

  const recovery = finishMarkerIfRecovering(p, salt); // finish after a valid crash-window file

  if (!existsSync(p.marker)) {
    // no marker and recovery did not (could not) finish it -> not initialized
    return refuseState(recovery.state ?? 'missing');
  }

  const loaded = loadAndValidate(p, salt);
  if (!loaded.ok) return refuseState(loaded.state);

  // Prefer the most recent matching record so an explicit operator confirmation
  // remains the returned provenance even if the entry was originally snapshotted.
  let rec = null;
  for (let i = loaded.data.records.length - 1; i >= 0; i--) {
    const candidate = loaded.data.records[i];
    if (candidate.backendName === entry.backendName && candidate.url === entry.url) {
      rec = candidate;
      break;
    }
  }
  if (!rec) return refuseUnrecorded(entry);

  return { ok: true, record: rec };
}

/**
 * The ONLY post-marker mint path. Appends a source:'operator_confirmation' record carrying
 * the operator's `why` (REQUIRED, non-empty), with a fresh recordedAt + marker,
 * via an atomic rewrite. `why` is mandatory: confirmation records exist to record
 * operator justification, so a missing/null/empty/whitespace-only reason throws.
 *
 * This is the per-entry recovery path the refusal messages promise. If the marker
 * is present but grandfather.json is missing/unparseable/wrong-version/HMAC-broken,
 * re-confirming rebuilds a FRESH records file seeded with this explicit
 * confirmation (the operator re-confirms each legacy backend they still trust);
 * only a wholly-uninitialized machine (no marker) still throws.
 */
export function confirmLegacy(backendName, url, why) {
  const p = paths();

  assertIdentityFields(backendName, url);

  if (typeof why !== 'string' || why.trim().length === 0) {
    throw new Error(
      'confirmLegacy requires a non-empty reason (why) recording the operator justification'
    );
  }

  if (!existsSync(p.marker) && !existsSync(p.json)) {
    throw new Error('grandfather not initialized; cannot confirm a legacy backend');
  }
  const salt = readMachineSalt(p);
  finishMarkerIfRecovering(p, salt);
  if (!existsSync(p.marker)) {
    throw new Error('grandfather not initialized; cannot confirm a legacy backend');
  }

  // Per-entry recovery: when the records file is unreadable, start from a fresh
  // records set so re-confirming each trusted backend rebuilds the sidecar,
  // rather than dead-ending on a corrupt file that only a full restore could fix.
  const loaded = loadAndValidate(p, salt);
  const data = loaded.ok
    ? loaded.data
    : {
        schemaVersion: 1,
        initializedAt: new Date().toISOString(),
        releaseVersion: releaseVersion(),
        records: [],
      };

  const r = {
    backendName,
    url,
    source: 'operator_confirmation',
    why,
    recordedAt: new Date().toISOString(),
  };
  r.marker = markerFor(salt, r);
  data.records = [...data.records, r];
  writeGrandfatherJson(p, data);
  return { ok: true, record: r };
}

// The §9.1 interim confirmation uses the same machine-bound, HMAC-protected
// record machinery as §7 instead of inventing a weaker trust store. The
// reserved backend name cannot collide with a models.json backend name (which
// must match CONFIG_NAME), and the fixed URL names the exact route the operator
// is confirming: direct Anthropic, not an ambient gateway or base-URL override.
const CLAUDE_DIRECT_ROUTE = Object.freeze({
  backendName: '@builtin/claude_cli',
  url: 'https://api.anthropic.com',
});

/**
 * Record the explicit human action: "confirm Claude's active route is direct
 * Anthropic, with no base-URL override in this environment". `why` remains
 * mandatory through confirmLegacy(), and is covered by the record HMAC.
 */
export function confirmClaudeRoute(why) {
  return confirmLegacy(CLAUDE_DIRECT_ROUTE.backendName, CLAUDE_DIRECT_ROUTE.url, why);
}

/**
 * Read the optional confirmation without turning absent/broken evidence into a
 * Studio outage. Any missing, malformed, wrong-machine, or HMAC-broken sidecar
 * simply supplies no declaration and therefore fails lineage toward `unknown`.
 */
export function consultClaudeRoute() {
  try {
    return consult(CLAUDE_DIRECT_ROUTE);
  } catch {
    return { ok: false, reason: 'confirmation_unavailable' };
  }
}
