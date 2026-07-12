// Canonicalization and the two identities (DIRECTION-0.3-TRUST-LAYER.md,
// adjustment 3, refined 2026-07-12):
//
//   artifact_id = hash(acceptance contract + produced artifact + inputs)
//   receipt_id  = hash(artifact_id + pairing + verification + audit
//                      + human decisions + economics + status dimensions)
//
// Changing an adjudication, a cost estimate, or the auditor creates a NEW
// RECEIPT without pretending the artifact changed. Changing code, claims,
// sources, or the acceptance contract changes artifact_id — which expires
// every audit bound to the old one.
//
// Identities are computed over EXPLICIT, SCHEMA-VERSIONED PROJECTIONS, not a
// broad "exclude derived fields" rule: a field this version does not know is
// an error, never silently unhashed. Future fields enter a hash by a
// deliberate projection change (and a version bump), or they fail loudly.

import { createHash } from 'node:crypto';

// --- canonical form ----------------------------------------------------------
// Rules: object keys sort lexicographically (key order is not meaning), array
// order is preserved (it is meaning), strings NFC-normalize and CRLF/CR
// become LF, numbers must be finite (-0 → 0), undefined object values are
// absence, undefined array elements are ambiguity and throw.

export function canonicalize(value, path = '$') {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (t === 'boolean') return value;
  if (t === 'undefined') throw new TypeError(`canonicalize: undefined at ${path} (drop it before canonicalizing)`);
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError(`canonicalize: ${t} at ${path} is not evidence`);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (v === undefined) throw new TypeError(`canonicalize: undefined array element at ${path}[${i}]`);
      return canonicalize(v, `${path}[${i}]`);
    });
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return out;
}

export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

// --- strict projection helper --------------------------------------------------
// pick() copies exactly the named fields and THROWS on any field it does not
// know about — the "unknown fields never silently unhashed" rule. `ignore`
// names fields that exist on the object but belong to the OTHER identity (or
// are derived), so their presence is expected and their exclusion deliberate.

function pick(obj, { take, ignore = [] }, path) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(`${path}: expected an object to project`);
  }
  const known = new Set([...take, ...ignore]);
  const unknown = Object.keys(obj).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new TypeError(
      `${path}: unknown field(s) ${unknown.join(', ')} — new fields enter a hash by a deliberate projection change, never silently`,
    );
  }
  const out = {};
  for (const k of take) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// --- artifact identity: what the work IS ---------------------------------------
// Covers: acceptance contract, goal, and the produced artifact (code refs or
// research deliverable + claims WITHOUT their audit decisions — a claim's
// text/marker/url/evidence are inputs; the decision about it is judgment and
// belongs to the receipt).

export const ARTIFACT_PROJECTION_VERSION = 1;

export function artifactProjection(pack) {
  const p = pick(pack, {
    take: ['schemaVersion', 'goal', 'acceptance_contract', 'artifact'],
    ignore: ['artifact_id', 'receipt_id', 'verification', 'session_log', 'pairing', 'statuses', 'human_decisions', 'economics', 'created_at'],
  }, 'artifactProjection(pack)');

  const a = pick(p.artifact, {
    take: ['kind', 'repo', 'head', 'diff_hash', 'changed_files', 'deliverable_hash', 'claims'],
    ignore: [],
  }, 'artifactProjection(pack.artifact)');

  if (Array.isArray(a.claims)) {
    a.claims = a.claims.map((c, i) =>
      pick(c, { take: ['claim', 'marker', 'url', 'evidence_hash', 'retrieved_at'], ignore: ['decision'] }, `artifactProjection(claims[${i}])`),
    );
  }
  return { projectionVersion: ARTIFACT_PROJECTION_VERSION, ...p, artifact: a };
}

export function computeArtifactId(pack) {
  return sha256(canonicalString(artifactProjection(pack)));
}

// --- receipt identity: what was JUDGED about the artifact ----------------------
// Covers: the artifact_id it binds to, pairing, verification, claim decisions,
// human decisions, economics, and the raw status dimensions.

export const RECEIPT_PROJECTION_VERSION = 1;

export function receiptProjection(pack) {
  if (!/^sha256:[0-9a-f]{64}$/.test(pack?.artifact_id ?? '')) {
    throw new TypeError('receiptProjection: pack.artifact_id must be set first — a receipt binds to an artifact');
  }
  const p = pick(pack, {
    take: ['schemaVersion', 'artifact_id', 'pairing', 'verification', 'human_decisions', 'economics', 'statuses', 'session_log'],
    ignore: ['receipt_id', 'goal', 'acceptance_contract', 'artifact', 'created_at'],
  }, 'receiptProjection(pack)');

  // Claim decisions are audit judgment: they live under artifact.claims for
  // locality but hash on the receipt side, keyed by marker.
  const claims = pack.artifact?.claims;
  const claimDecisions = Array.isArray(claims)
    ? claims.map((c) => ({ marker: c.marker, decision: c.decision ?? null }))
    : null;
  return { projectionVersion: RECEIPT_PROJECTION_VERSION, ...p, claim_decisions: claimDecisions };
}

export function computeReceiptId(pack) {
  return sha256(canonicalString(receiptProjection(pack)));
}

// --- expiry checks ---------------------------------------------------------------

export function artifactMatches(pack, artifactId) {
  return computeArtifactId(pack) === artifactId;
}

export function receiptMatches(pack, receiptId) {
  return computeReceiptId(pack) === receiptId;
}

// Seal a pack: compute both identities in the right order.
export function seal(pack) {
  const artifact_id = computeArtifactId(pack);
  const withArtifact = { ...pack, artifact_id };
  return { ...withArtifact, receipt_id: computeReceiptId(withArtifact) };
}
