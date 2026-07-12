// Canonicalization before hashing (DIRECTION-0.3-TRUST-LAYER.md, adjustment 3).
//
// artifact_id = hash(normalized evidence bundle). Two bundles that mean the
// same thing must hash the same; any change of meaning must change the hash.
// Rules:
//   - object keys serialize in lexicographic order, recursively
//   - array order is preserved (it is meaning)
//   - strings are NFC-normalized and CRLF/CR line endings become LF
//   - numbers must be finite; -0 canonicalizes to 0
//   - undefined object values are dropped; undefined INSIDE an array throws
//     (a hole is ambiguous meaning, not absence)
//   - functions, symbols, and bigints throw — they are not evidence
//   - derived/presentation fields (artifact_id itself, headline) are excluded
//     from the hash: raw dimensions are permanent, headlines are disposable

import { createHash } from 'node:crypto';

const DERIVED_FIELDS = ['artifact_id', 'headline', 'derived'];

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
    if (value[key] === undefined) continue; // absent, not meaning
    out[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return out;
}

// Deterministic serialization: JSON.stringify preserves the insertion order
// we just established by sorted assembly, so the output is stable.
export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

export function computeArtifactId(bundle, { exclude = DERIVED_FIELDS } = {}) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new TypeError('computeArtifactId: the evidence bundle must be an object');
  }
  const stripped = {};
  for (const key of Object.keys(bundle)) {
    if (exclude.includes(key)) continue;
    stripped[key] = bundle[key];
  }
  return 'sha256:' + createHash('sha256').update(canonicalString(stripped), 'utf8').digest('hex');
}

// A prior green expires when the bundle changes — this is that check.
export function artifactMatches(bundle, artifactId) {
  return computeArtifactId(bundle) === artifactId;
}
