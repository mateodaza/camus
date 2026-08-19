// Hand-written runtime validators, zero-dep, mirroring the schema files.
// The .schema.json files are the canonical published spec; these enforce it
// at runtime, and the tests hold the two in agreement.

import { DIMENSIONS } from './status.mjs';
import { artifactMatches, receiptMatches } from './canonical.mjs';
import { experimentMatches } from './experiment.mjs';

const err = (path, why) => ({ ok: false, error: `${path}: ${why}` });
const OK = { ok: true };

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// DIMENSIONS.audit is the v2 enum (it broadened to carry declared_*). A status
// v1 block is a FROZEN published contract: its audit stays the six pre-declared
// values, so a v1 pack can never smuggle a declared_* value (§10.8.2/§10.8.4).
// This subset is local and frozen; it is the v1 audit floor, never re-derived
// from the broadened DIMENSIONS.audit.
const STATUS_V1_AUDIT = Object.freeze(['not_run', 'independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings', 'infra_failed']);

export function validateStatus(s, path = 'status') {
  if (!isObj(s)) return err(path, 'must be an object');
  if (![1, 2].includes(s.schemaVersion)) return err(path, 'schemaVersion must be 1 or 2');
  for (const dim of ['execution', 'verification', 'publication']) {
    if (!DIMENSIONS[dim].includes(s[dim])) return err(`${path}.${dim}`, `must be one of ${DIMENSIONS[dim].join('|')}`);
  }
  // v2 accepts the full DIMENSIONS.audit; v1 stays on the frozen six.
  const auditValues = s.schemaVersion === 2 ? DIMENSIONS.audit : STATUS_V1_AUDIT;
  if (!auditValues.includes(s.audit)) return err(`${path}.audit`, `must be one of ${auditValues.join('|')}`);
  const extra = Object.keys(s).filter((k) => !['schemaVersion', 'execution', 'verification', 'audit', 'publication'].includes(k));
  if (extra.length) return err(path, `unknown fields: ${extra.join(', ')}`);
  return OK;
}

const ROLE_KEYS = ['requested', 'resolved', 'actual'];
function validateRoleIdentity(r, path) {
  if (!isObj(r)) return err(path, 'must be an object');
  for (const k of ROLE_KEYS) {
    if (typeof r[k] !== 'string' || !r[k]) return err(`${path}.${k}`, 'must be a non-empty string');
  }
  return OK;
}

// Pairing v2 shape (§10.8.1, pairing-manifest.v2.schema.json). This block owns
// version/shape/enum/presence/nullability facts ONLY. It deliberately does NOT
// implement rule 7 (independence↔identity/shared_gateway consistency), the
// audit↔pairing cross-checks, builtin1 namespace selection, or the
// review_scope↔gate_scope equality — those are Task 6 semantics.
const SEAT_FIELDS = Object.freeze([
  'requested', 'resolved', 'actual', 'reported', 'actual_evidence',
  'executor_kind', 'training_org', 'model_family', 'lineage',
  'inference_operator', 'transport', 'connection', 'origin_confidence',
  'qualification',
]);
const SEAT_STRING_FIELDS = Object.freeze(['requested', 'resolved', 'actual', 'executor_kind', 'training_org', 'model_family', 'inference_operator']);
const ACTUAL_EVIDENCE = Object.freeze(['observed_api_response', 'observed_cli_event', 'asserted_pin', 'mapped_by_operator_docs', 'none']);
const LINEAGE_SOURCE = Object.freeze(['registry', 'operator_declared', 'unknown']);
const SEAT_TRANSPORT = Object.freeze(['loopback', 'direct_https', 'ssh_tunnel', 'vendor_managed', 'legacy_http']);
const ORIGIN_CONFIDENCE = Object.freeze(['verified_operator', 'operator_declared', 'unknown']);
const GATE_SCOPE = Object.freeze(['full', 'light', null]);
const QUAL_FINGERPRINT_RE = /^(?:qual1|builtin1):[0-9a-f]{64}$/;
const PAIRING_V2_INDEPENDENCE = Object.freeze(['cross_vendor', 'cross_vendor_declared', 'same_vendor_advisory', 'none']);
const REVIEW_SCOPE = Object.freeze(['full', 'light', null]);
// v2-only pairing top-level fields; their presence on a v1/v2 envelope's pairing
// is a half-upgrade the pack boundary refuses (§10.8.4).
const PAIRING_V2_ONLY_FIELDS = Object.freeze(['shared_gateway', 'review_scope']);
// v2-only seat parents: every sealed seat field a v1 role identity never had
// (SEAT_FIELDS minus the three v1 role keys). A v1-versioned pairing that grows
// ANY of these — including a lineage or qualification block whose descendants
// ride along with the parent — is a half-upgrade the pack boundary refuses.
const SEAT_V2_ONLY_FIELDS = Object.freeze(SEAT_FIELDS.filter((k) => !ROLE_KEYS.includes(k)));

// Pack-boundary-only legacy half-upgrade detection (§10.8.4): a v1-versioned
// pairing block that carries ANY v2-only field — top-level shared_gateway/
// review_scope OR a nested executor/auditor seat field. This is deliberately
// separate from the shipped v1 validatePairingManifest branch, which stays
// unchanged: the refusal lives only at the evidence-pack envelope boundary.
function detectLegacyPairingV2Fields(pairing) {
  const found = PAIRING_V2_ONLY_FIELDS.filter((k) => k in pairing);
  for (const role of ['executor', 'auditor']) {
    const seat = pairing[role];
    if (!isObj(seat)) continue;
    for (const k of SEAT_V2_ONLY_FIELDS) if (k in seat) found.push(`${role}.${k}`);
  }
  return found;
}

const strOrNull = (v) => v === null || typeof v === 'string';

function validateSeatIdentitySealed(seat, path) {
  const shape = exactFields(seat, SEAT_FIELDS, path);
  if (!shape.ok) return shape;
  const missing = SEAT_FIELDS.filter((k) => !(k in seat));
  if (missing.length) return err(path, `missing required field(s): ${missing.join(', ')}`);
  for (const k of SEAT_STRING_FIELDS) {
    if (typeof seat[k] !== 'string' || !seat[k]) return err(`${path}.${k}`, 'must be a non-empty string');
  }
  if (!strOrNull(seat.reported)) return err(`${path}.reported`, 'must be a string or null');
  if (!ACTUAL_EVIDENCE.includes(seat.actual_evidence)) return err(`${path}.actual_evidence`, `must be one of ${ACTUAL_EVIDENCE.join('|')}`);
  const lineage = seat.lineage;
  const lineageShape = exactFields(lineage, ['source', 'derived_from'], `${path}.lineage`);
  if (!lineageShape.ok) return lineageShape;
  for (const k of ['source', 'derived_from']) if (!(k in lineage)) return err(`${path}.lineage`, `missing required field: ${k}`);
  if (!LINEAGE_SOURCE.includes(lineage.source)) return err(`${path}.lineage.source`, `must be one of ${LINEAGE_SOURCE.join('|')}`);
  if (!strOrNull(lineage.derived_from)) return err(`${path}.lineage.derived_from`, 'must be a string or null');
  if (!SEAT_TRANSPORT.includes(seat.transport)) return err(`${path}.transport`, `must be one of ${SEAT_TRANSPORT.join('|')}`);
  if (!strOrNull(seat.connection)) return err(`${path}.connection`, 'must be a string or null');
  if (!ORIGIN_CONFIDENCE.includes(seat.origin_confidence)) return err(`${path}.origin_confidence`, `must be one of ${ORIGIN_CONFIDENCE.join('|')}`);
  // qualification is ALWAYS present and non-null: a receipt names which admission
  // evidence stood behind the seat.
  const q = seat.qualification;
  if (!isObj(q)) return err(`${path}.qualification`, 'must be a non-null object (always present)');
  const qShape = exactFields(q, ['fingerprint', 'gate_scope', 'contract_version'], `${path}.qualification`);
  if (!qShape.ok) return qShape;
  for (const k of ['fingerprint', 'gate_scope', 'contract_version']) if (!(k in q)) return err(`${path}.qualification`, `missing required field: ${k}`);
  if (typeof q.fingerprint !== 'string' || !QUAL_FINGERPRINT_RE.test(q.fingerprint)) return err(`${path}.qualification.fingerprint`, 'must match qual1:<hex64> or builtin1:<hex64>');
  if (!GATE_SCOPE.includes(q.gate_scope)) return err(`${path}.qualification.gate_scope`, 'must be full | light | null');
  if (!strOrNull(q.contract_version)) return err(`${path}.qualification.contract_version`, 'must be a string or null');
  return OK;
}

function validatePairingManifestV2(m, path) {
  const rootShape = exactFields(m, ['schemaVersion', 'executor', 'auditor', 'independence', 'shared_gateway', 'review_scope'], path);
  if (!rootShape.ok) return rootShape;
  for (const k of ['schemaVersion', 'executor', 'auditor', 'independence', 'shared_gateway', 'review_scope']) {
    if (!(k in m)) return err(path, `missing required field: ${k}`);
  }
  for (const role of ['executor', 'auditor']) {
    const r = validateSeatIdentitySealed(m[role], `${path}.${role}`);
    if (!r.ok) return r;
  }
  if (!PAIRING_V2_INDEPENDENCE.includes(m.independence)) return err(`${path}.independence`, `must be one of ${PAIRING_V2_INDEPENDENCE.join('|')}`);
  if (!strOrNull(m.shared_gateway)) return err(`${path}.shared_gateway`, 'must be a string or null');
  if (!REVIEW_SCOPE.includes(m.review_scope)) return err(`${path}.review_scope`, 'must be full | light | null');
  return OK;
}

export function validatePairingManifest(m, path = 'pairing') {
  if (!isObj(m)) return err(path, 'must be an object');
  if (m.schemaVersion === 2) return validatePairingManifestV2(m, path);
  if (m.schemaVersion !== 1) return err(path, 'schemaVersion must be 1 or 2');
  for (const role of ['executor', 'auditor']) {
    const r = validateRoleIdentity(m[role], `${path}.${role}`);
    if (!r.ok) return r;
  }
  if (!['cross_vendor', 'same_vendor_advisory', 'none'].includes(m.independence)) {
    return err(`${path}.independence`, 'must be cross_vendor | same_vendor_advisory | none');
  }
  // Independence must agree with the identities: same provider on both sides
  // can never claim cross_vendor.
  const provider = (s) => String(s).split(':')[0];
  if (m.independence === 'cross_vendor' && provider(m.executor.actual) === provider(m.auditor.actual)) {
    return err(`${path}.independence`, `cross_vendor claimed but both roles run ${provider(m.executor.actual)}`);
  }
  return OK;
}

export function validateHumanDecision(d, path = 'human_decision') {
  if (!isObj(d)) return err(path, 'must be an object');
  if (d.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
  if (!['decision', 'infra', 'stuck', 'verify', 'adjudication'].includes(d.kind)) return err(`${path}.kind`, 'unknown kind');
  if (typeof d.question !== 'string' || typeof d.answer !== 'string') return err(path, 'question and answer must be strings');
  if (!Number.isInteger(d.at)) return err(`${path}.at`, 'must be epoch ms');
  return OK;
}

export function validateEconomics(e, path = 'economics') {
  if (!isObj(e)) return err(path, 'must be an object');
  if (e.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
  if (!['executor', 'auditor'].includes(e.role)) return err(`${path}.role`, 'must be executor | auditor');
  for (const k of ROLE_KEYS) if (typeof e[k] !== 'string') return err(`${path}.${k}`, 'must be a string');
  if (!['subscription', 'usage_credits', 'api', 'unknown'].includes(e.billing_mode)) return err(`${path}.billing_mode`, 'unknown billing mode');
  if (e.estimated_cost_usd !== null && e.estimated_cost_usd !== undefined && typeof e.estimated_cost_usd !== 'number') {
    return err(`${path}.estimated_cost_usd`, 'must be a number or null (and always an estimate)');
  }
  return OK;
}

const PACK_FIELDS = ['schemaVersion', 'artifact_id', 'receipt_id', 'goal', 'acceptance_contract', 'artifact', 'verification', 'session_log', 'pairing', 'statuses', 'human_decisions', 'economics', 'created_at'];

export function validateEvidencePack(p, path = 'evidence_pack') {
  if (!isObj(p)) return err(path, 'must be an object');
  if (![1, 2, 3].includes(p.schemaVersion)) return err(path, 'schemaVersion must be 1, 2, or 3');
  const unknown = Object.keys(p).filter((k) => !PACK_FIELDS.includes(k));
  if (unknown.length) return err(path, `unknown field(s): ${unknown.join(', ')} — schema v${p.schemaVersion} does not know them; nothing enters or escapes a hash silently`);
  // §10.8.4 cross-version matrix: an envelope admits EXACTLY its published
  // interior versions (1/1/1, 2/1/1, 3/2/2). Mixed, half-upgraded, missing, and
  // future interior versions fail closed here, before any interior shape runs.
  const expectedInteriorVersion = p.schemaVersion === 3 ? 2 : 1;
  if (!isObj(p.pairing)) return err(`${path}.pairing`, 'must be an object');
  if (!isObj(p.statuses)) return err(`${path}.statuses`, 'must be an object');
  if (p.pairing.schemaVersion !== expectedInteriorVersion) return err(`${path}.pairing.schemaVersion`, `evidence-pack v${p.schemaVersion} requires pairing schemaVersion ${expectedInteriorVersion}`);
  if (p.statuses.schemaVersion !== expectedInteriorVersion) return err(`${path}.statuses.schemaVersion`, `evidence-pack v${p.schemaVersion} requires statuses schemaVersion ${expectedInteriorVersion}`);
  // Half-upgraded legacy envelope: a v1-versioned pairing block that carries ANY
  // v2-only field — top-level shared_gateway/review_scope OR a nested
  // executor/auditor seat field (lineage/qualification descendants ride along
  // with their parent) — refuses even though its version reads 1 (§10.8.4).
  if (p.schemaVersion !== 3) {
    const v2Only = detectLegacyPairingV2Fields(p.pairing);
    if (v2Only.length) return err(`${path}.pairing`, `evidence-pack v${p.schemaVersion} pairing cannot carry v2-only field(s): ${v2Only.join(', ')} (half-upgraded)`);
  }
  // Envelopes 2 and 3 share the coverage-aware artifact shape; envelope 1 does not.
  const usesV2Artifact = p.schemaVersion === 2 || p.schemaVersion === 3;
  if (!/^sha256:[0-9a-f]{64}$/.test(p.artifact_id ?? '')) return err(`${path}.artifact_id`, 'must be sha256:<hex64>');
  if (!/^sha256:[0-9a-f]{64}$/.test(p.receipt_id ?? '')) return err(`${path}.receipt_id`, 'must be sha256:<hex64>');
  if (typeof p.goal !== 'string' || !p.goal) return err(`${path}.goal`, 'required');
  if (typeof p.acceptance_contract !== 'string' || !p.acceptance_contract) return err(`${path}.acceptance_contract`, 'required — audits bottleneck on it');
  if (!isObj(p.artifact) || !['code', 'research'].includes(p.artifact.kind)) return err(`${path}.artifact.kind`, 'must be code | research');
  if (!usesV2Artifact && 'contract_coverage' in p.artifact) {
    return err(`${path}.artifact.contract_coverage`, 'requires evidence-pack schemaVersion 2 or 3');
  }
  if (p.artifact.claims !== null && p.artifact.claims !== undefined) {
    if (!Array.isArray(p.artifact.claims)) return err(`${path}.artifact.claims`, 'must be an array or null');
    const markers = new Set();
    for (const [i, c] of p.artifact.claims.entries()) {
      const cp = `${path}.artifact.claims[${i}]`;
      if (!isObj(c)) return err(cp, 'must be an object');
      const known = ['claim', 'marker', 'url', 'evidence_hash', 'retrieved_at', 'decision'];
      const extra = Object.keys(c).filter((k) => !known.includes(k));
      if (extra.length) return err(cp, `unknown fields: ${extra.join(', ')}`);
      if (usesV2Artifact) {
        const missing = known.filter((k) => !(k in c));
        if (missing.length) return err(cp, `missing required fields: ${missing.join(', ')}`);
      }
      if (typeof c.claim !== 'string' || !c.claim) return err(`${cp}.claim`, 'required');
      if (typeof c.marker !== 'string' || !/^\[(?:H)?\d+\]$/i.test(c.marker)) return err(`${cp}.marker`, 'must be [n] or [Hn]');
      if (markers.has(c.marker)) return err(`${cp}.marker`, 'must be unique within the ledger');
      markers.add(c.marker);
      if (c.url !== null && c.url !== undefined && (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url))) return err(`${cp}.url`, 'must be an http(s) URL or null');
      if (c.evidence_hash !== null && c.evidence_hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(c.evidence_hash)) return err(`${cp}.evidence_hash`, 'must be sha256:<hex64> or null');
      if (c.retrieved_at !== null && c.retrieved_at !== undefined && !Number.isInteger(c.retrieved_at)) return err(`${cp}.retrieved_at`, 'must be epoch ms or null');
      if (!['supported', 'unsupported', 'unchecked', null].includes(c.decision)) return err(`${cp}.decision`, 'must be supported | unsupported | unchecked | null');
    }
  }
  if (usesV2Artifact) {
    if (!('contract_coverage' in p.artifact)) return err(`${path}.artifact.contract_coverage`, 'required in evidence-pack v2 or v3');
    const coverage = p.artifact.contract_coverage;
    if (coverage !== null && !Array.isArray(coverage)) return err(`${path}.artifact.contract_coverage`, 'must be an array or null');
    if (p.artifact.kind === 'research' && (!Array.isArray(coverage) || coverage.length === 0)) {
      return err(`${path}.artifact.contract_coverage`, 'research artifacts require at least one extracted acceptance criterion');
    }
    if (Array.isArray(coverage)) {
      for (const [i, c] of coverage.entries()) {
        const cp = `${path}.artifact.contract_coverage[${i}]`;
        if (!isObj(c)) return err(cp, 'must be an object');
        const known = ['id', 'text', 'decision'];
        const extra = Object.keys(c).filter((k) => !known.includes(k));
        if (extra.length) return err(cp, `unknown fields: ${extra.join(', ')}`);
        if (c.id !== `C${i + 1}`) return err(`${cp}.id`, `must be C${i + 1}; criteria stay in deterministic order`);
        if (typeof c.text !== 'string' || !c.text) return err(`${cp}.text`, 'required');
        if (!['met', 'unmet', 'unclear'].includes(c.decision)) return err(`${cp}.decision`, 'must be met | unmet | unclear');
      }
    }
  }
  if (!isObj(p.verification) || !Array.isArray(p.verification.checks)) return err(`${path}.verification.checks`, 'required array');
  for (const [i, c] of p.verification.checks.entries()) {
    if (!isObj(c) || typeof c.id !== 'string' || !['pass', 'fail', 'warn', 'skip'].includes(c.status)) {
      return err(`${path}.verification.checks[${i}]`, 'each check needs id + status pass|fail|warn|skip');
    }
  }
  const pm = validatePairingManifest(p.pairing, `${path}.pairing`);
  if (!pm.ok) return pm;
  const st = validateStatus(p.statuses, `${path}.statuses`);
  if (!st.ok) return st;
  if (p.schemaVersion === 2 && ['independent_clean', 'advisory_clean'].includes(p.statuses.audit)) {
    if (Array.isArray(p.artifact.claims) && p.artifact.claims.some((c) => c.decision !== 'supported')) {
      return err(`${path}.statuses.audit`, 'clean audit conflicts with unsupported or unchecked claim decisions');
    }
    if (Array.isArray(p.artifact.contract_coverage) && p.artifact.contract_coverage.some((c) => c.decision !== 'met')) {
      return err(`${path}.statuses.audit`, 'clean audit conflicts with unmet or unclear acceptance criteria');
    }
  }
  if (!Array.isArray(p.human_decisions)) return err(`${path}.human_decisions`, 'required array (the ledger may be empty, never absent)');
  for (const [i, d] of p.human_decisions.entries()) {
    const r = validateHumanDecision(d, `${path}.human_decisions[${i}]`);
    if (!r.ok) return r;
  }
  if (!Array.isArray(p.economics)) return err(`${path}.economics`, 'required array');
  for (const [i, e] of p.economics.entries()) {
    const r = validateEconomics(e, `${path}.economics[${i}]`);
    if (!r.ok) return r;
  }
  if (!Number.isInteger(p.created_at)) return err(`${path}.created_at`, 'must be epoch ms');
  // Shape-valid hashes are not enough: a pack copied and edited after sealing
  // must fail validation even if both identity strings still look like SHA-256.
  // Run this only after the structural checks so projection errors become a
  // validator result rather than an uncaught exception.
  try {
    if (!artifactMatches(p, p.artifact_id)) return err(`${path}.artifact_id`, 'does not match the sealed artifact contents');
    if (!receiptMatches(p, p.receipt_id)) return err(`${path}.receipt_id`, 'does not match the sealed receipt contents');
  } catch (e) {
    return err(path, `identity projection failed: ${e.message}`);
  }
  return OK;
}

export function validateBenchmarkRecord(r, path = 'benchmark_record') {
  if (!isObj(r)) return err(path, 'must be an object');
  if (r.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
  if (typeof r.id !== 'string' || !r.id) return err(`${path}.id`, 'required');
  if (!['historical', 'seeded_defect', 'clean_control', 'citation_failure', 'malformed_receipt', 'paraphrase_variant'].includes(r.source)) {
    return err(`${path}.source`, 'unknown source');
  }
  for (const role of ['executor', 'auditor']) {
    if (!isObj(r[role]) || !('provider' in r[role])) return err(`${path}.${role}`, 'needs at least a provider (null allowed when unknown)');
  }
  if (!isObj(r.artifact_ref)) return err(`${path}.artifact_ref`, 'required object');
  if (!Array.isArray(r.findings)) return err(`${path}.findings`, 'required array');
  for (const [i, f] of r.findings.entries()) {
    if (!isObj(f) || typeof f.title !== 'string') return err(`${path}.findings[${i}].title`, 'required');
    if (!['confirmed', 'rejected', 'partially_correct', 'unresolved'].includes(f.adjudication)) {
      return err(`${path}.findings[${i}].adjudication`, 'must be confirmed | rejected | partially_correct | unresolved');
    }
  }
  if (!['public', 'internal', 'secret_redacted'].includes(r.sensitivity)) return err(`${path}.sensitivity`, 'unknown sensitivity');
  if (typeof r.is_clean_control !== 'boolean') return err(`${path}.is_clean_control`, 'must be boolean');
  if (r.is_clean_control && r.findings.some((f) => f.adjudication === 'confirmed')) {
    return err(path, 'a clean control cannot carry confirmed findings');
  }
  return OK;
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const nullOrNonNegativeInt = (value) => value === null || (Number.isInteger(value) && value >= 0);

function validateAuditExperimentV1(r, path = 'experiment') {
  if (!isObj(r)) return err(path, 'must be an object');
  const rootFields = ['schemaVersion', 'experiment_id', 'mode', 'created_at', 'source', 'manifest', 'outcome'];
  const rootExtra = Object.keys(r).filter((key) => !rootFields.includes(key));
  if (rootExtra.length) return err(path, `unknown fields: ${rootExtra.join(', ')}`);
  if (r.schemaVersion !== 1) return err(`${path}.schemaVersion`, 'must be 1');
  if (!HASH_RE.test(r.experiment_id ?? '')) return err(`${path}.experiment_id`, 'must be sha256:<hex64>');
  if (r.mode !== 'audit_only_replay') return err(`${path}.mode`, 'must be audit_only_replay');
  if (!Number.isInteger(r.created_at)) return err(`${path}.created_at`, 'must be epoch ms');

  if (!isObj(r.source)) return err(`${path}.source`, 'must be an object');
  const sourceFields = ['run_id', 'artifact_id', 'receipt_id'];
  const sourceExtra = Object.keys(r.source).filter((key) => !sourceFields.includes(key));
  if (sourceExtra.length) return err(`${path}.source`, `unknown fields: ${sourceExtra.join(', ')}`);
  if (typeof r.source.run_id !== 'string' || !r.source.run_id) return err(`${path}.source.run_id`, 'required');
  for (const key of ['artifact_id', 'receipt_id']) if (!HASH_RE.test(r.source[key] ?? '')) return err(`${path}.source.${key}`, 'must be sha256:<hex64>');

  if (!isObj(r.manifest)) return err(`${path}.manifest`, 'must be an object');
  const manifestFields = ['arm_id', 'knowledge_snapshot_id', 'knowledge_privacy', 'catalog', 'reviewer', 'effort', 'fallback_policy'];
  const manifestExtra = Object.keys(r.manifest).filter((key) => !manifestFields.includes(key));
  if (manifestExtra.length) return err(`${path}.manifest`, `unknown fields: ${manifestExtra.join(', ')}`);
  if (typeof r.manifest.arm_id !== 'string' || !r.manifest.arm_id) return err(`${path}.manifest.arm_id`, 'required');
  if (r.manifest.knowledge_snapshot_id !== null && !HASH_RE.test(r.manifest.knowledge_snapshot_id ?? '')) return err(`${path}.manifest.knowledge_snapshot_id`, 'must be sha256:<hex64> or null');
  if (!['none', 'internal', 'secret_redacted'].includes(r.manifest.knowledge_privacy)) return err(`${path}.manifest.knowledge_privacy`, 'unknown privacy class');
  if (r.manifest.fallback_policy !== 'none') return err(`${path}.manifest.fallback_policy`, 'v1 permits no fallback');

  const catalog = r.manifest.catalog;
  if (!isObj(catalog)) return err(`${path}.manifest.catalog`, 'must be an object');
  const catalogFields = ['resolved_at', 'reviewer_source', 'reviewer_models'];
  const catalogExtra = Object.keys(catalog).filter((key) => !catalogFields.includes(key));
  if (catalogExtra.length) return err(`${path}.manifest.catalog`, `unknown fields: ${catalogExtra.join(', ')}`);
  if (!Number.isInteger(catalog.resolved_at)) return err(`${path}.manifest.catalog.resolved_at`, 'must be epoch ms');
  if (!['codex_cache', 'fallback'].includes(catalog.reviewer_source)) return err(`${path}.manifest.catalog.reviewer_source`, 'must be codex_cache | fallback');
  if (!Array.isArray(catalog.reviewer_models) || !catalog.reviewer_models.length || catalog.reviewer_models.some((model) => typeof model !== 'string' || !model)) return err(`${path}.manifest.catalog.reviewer_models`, 'must be a non-empty string array');

  const reviewer = r.manifest.reviewer;
  if (!isObj(reviewer) || typeof reviewer.requested !== 'string' || !reviewer.requested || typeof reviewer.resolved !== 'string' || !reviewer.resolved) return err(`${path}.manifest.reviewer`, 'requested and resolved are required');
  if (reviewer.requested !== reviewer.resolved) return err(`${path}.manifest.reviewer`, 'fallback is none, so requested must equal resolved');
  if (!catalog.reviewer_models.includes(reviewer.resolved.split(':').at(-1))) return err(`${path}.manifest.reviewer.resolved`, 'must appear in the frozen catalog');
  const effort = r.manifest.effort;
  if (!isObj(effort) || !['low', 'medium', 'high', 'xhigh'].includes(effort.requested) || effort.semantics !== 'requested_only') return err(`${path}.manifest.effort`, 'needs requested low|medium|high|xhigh and semantics requested_only');

  const outcome = r.outcome;
  if (!isObj(outcome)) return err(`${path}.outcome`, 'must be an object');
  const outcomeFields = ['status', 'artifact_id', 'receipt_id', 'auditor_actual', 'effort_actual', 'judge_overlap', 'usage', 'failure', 'confounded'];
  const outcomeExtra = Object.keys(outcome).filter((key) => !outcomeFields.includes(key));
  if (outcomeExtra.length) return err(`${path}.outcome`, `unknown fields: ${outcomeExtra.join(', ')}`);
  if (!['running', 'completed', 'infra_failed', 'stopped'].includes(outcome.status)) return err(`${path}.outcome.status`, 'unknown status');
  if (outcome.artifact_id !== r.source.artifact_id) return err(`${path}.outcome.artifact_id`, 'audit-only replay must preserve the source artifact_id');
  if (outcome.receipt_id !== null && !HASH_RE.test(outcome.receipt_id ?? '')) return err(`${path}.outcome.receipt_id`, 'must be sha256:<hex64> or null');
  if (outcome.auditor_actual !== null && (typeof outcome.auditor_actual !== 'string' || !outcome.auditor_actual)) return err(`${path}.outcome.auditor_actual`, 'must be a non-empty string or null');
  if (outcome.effort_actual !== null && (typeof outcome.effort_actual !== 'string' || !outcome.effort_actual)) return err(`${path}.outcome.effort_actual`, 'must be a non-empty string or null');
  if (typeof outcome.confounded !== 'boolean') return err(`${path}.outcome.confounded`, 'must be boolean');

  const overlap = outcome.judge_overlap;
  if (!isObj(overlap) || typeof overlap.arm_provider !== 'string' || !overlap.arm_provider) return err(`${path}.outcome.judge_overlap`, 'arm_provider is required');
  const overlapFields = ['arm_provider', 'judge_provider', 'same_vendor', 'same_family'];
  const overlapExtra = Object.keys(overlap).filter((key) => !overlapFields.includes(key));
  if (overlapExtra.length) return err(`${path}.outcome.judge_overlap`, `unknown fields: ${overlapExtra.join(', ')}`);
  if (overlap.judge_provider !== null && (typeof overlap.judge_provider !== 'string' || !overlap.judge_provider)) return err(`${path}.outcome.judge_overlap.judge_provider`, 'must be a string or null');
  for (const key of ['same_vendor', 'same_family']) if (overlap[key] !== null && typeof overlap[key] !== 'boolean') return err(`${path}.outcome.judge_overlap.${key}`, 'must be boolean or null');

  const usage = outcome.usage;
  if (!isObj(usage)) return err(`${path}.outcome.usage`, 'must be an object');
  const usageFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'duration_ms'];
  const usageExtra = Object.keys(usage).filter((key) => !usageFields.includes(key));
  if (usageExtra.length) return err(`${path}.outcome.usage`, `unknown fields: ${usageExtra.join(', ')}`);
  for (const key of usageFields) if (!nullOrNonNegativeInt(usage[key])) return err(`${path}.outcome.usage.${key}`, 'must be a non-negative integer or null');

  if (outcome.status === 'completed') {
    if (!HASH_RE.test(outcome.receipt_id ?? '')) return err(`${path}.outcome.receipt_id`, 'completed arms require a sealed receipt');
    if (outcome.receipt_id === r.source.receipt_id) return err(`${path}.outcome.receipt_id`, 'audit replay must mint a new receipt');
    if (!outcome.auditor_actual) return err(`${path}.outcome`, 'completed arms require an actual auditor');
    if (outcome.failure !== null) return err(`${path}.outcome.failure`, 'completed arms cannot carry a failure');
    const substituted = outcome.auditor_actual !== reviewer.resolved;
    if (outcome.confounded !== substituted) return err(`${path}.outcome.confounded`, 'must say whether resolved and actual auditor identities differ');
  } else if (['infra_failed', 'stopped'].includes(outcome.status)) {
    if (!isObj(outcome.failure) || typeof outcome.failure.stage !== 'string' || typeof outcome.failure.code !== 'string' || typeof outcome.failure.detail !== 'string') return err(`${path}.outcome.failure`, 'failed/stopped arms require stage, code, and detail');
    const failureFields = ['stage', 'code', 'detail'];
    const failureExtra = Object.keys(outcome.failure).filter((key) => !failureFields.includes(key));
    if (failureExtra.length) return err(`${path}.outcome.failure`, `unknown fields: ${failureExtra.join(', ')}`);
  } else if (outcome.failure !== null) {
    return err(`${path}.outcome.failure`, 'running arms cannot carry a failure');
  } else if (outcome.receipt_id !== null || outcome.auditor_actual !== null || outcome.effort_actual !== null) {
    return err(`${path}.outcome`, 'running arms cannot claim outcome identities yet');
  }

  try {
    if (!experimentMatches(r)) return err(`${path}.experiment_id`, 'does not match the frozen manifest');
  } catch (e) {
    return err(path, `manifest projection failed: ${e.message}`);
  }
  return OK;
}

const exactFields = (value, fields, path) => {
  if (!isObj(value)) return err(path, 'must be an object');
  const extra = Object.keys(value).filter((key) => !fields.includes(key));
  return extra.length ? err(path, `unknown fields: ${extra.join(', ')}`) : OK;
};

const validateIdentityDecision = (value, path) => {
  const shape = exactFields(value, ['requested', 'resolved'], path);
  if (!shape.ok) return shape;
  if (typeof value.requested !== 'string' || !value.requested || typeof value.resolved !== 'string' || !value.resolved) {
    return err(path, 'requested and resolved are required');
  }
  if (value.requested !== value.resolved) return err(path, 'fallback is none, so requested must equal resolved');
  return OK;
};

function validateParallelExperimentV2(r, path) {
  const rootFields = ['schemaVersion', 'experiment_id', 'mode', 'created_at', 'goal', 'acceptance_contract', 'knowledge', 'manifest', 'outcome'];
  const rootShape = exactFields(r, rootFields, path);
  if (!rootShape.ok) return rootShape;
  if (!HASH_RE.test(r.experiment_id ?? '')) return err(`${path}.experiment_id`, 'must be sha256:<hex64>');
  if (r.mode !== 'parallel_execution') return err(`${path}.mode`, 'must be parallel_execution');
  if (!Number.isInteger(r.created_at)) return err(`${path}.created_at`, 'must be epoch ms');
  if (typeof r.goal !== 'string' || !r.goal) return err(`${path}.goal`, 'required');
  if (typeof r.acceptance_contract !== 'string' || !r.acceptance_contract) return err(`${path}.acceptance_contract`, 'required');

  const knowledge = r.knowledge;
  const knowledgeShape = exactFields(knowledge, ['snapshot_id', 'privacy', 'mode', 'query', 'item_count', 'retriever'], `${path}.knowledge`);
  if (!knowledgeShape.ok) return knowledgeShape;
  if (!HASH_RE.test(knowledge.snapshot_id ?? '')) return err(`${path}.knowledge.snapshot_id`, 'must be sha256:<hex64>');
  if (!['none', 'internal', 'secret_redacted'].includes(knowledge.privacy)) return err(`${path}.knowledge.privacy`, 'unknown privacy class');
  if (!['none', 'hivemind_mcp', 'hivemind_rest', 'hivemind_claude', 'simulation'].includes(knowledge.mode)) return err(`${path}.knowledge.mode`, 'unknown knowledge mode');
  if (typeof knowledge.query !== 'string') return err(`${path}.knowledge.query`, 'must be a string');
  if (!Number.isInteger(knowledge.item_count) || knowledge.item_count < 0) return err(`${path}.knowledge.item_count`, 'must be a non-negative integer');
  const retrieverShape = exactFields(knowledge.retriever, ['requested', 'resolved', 'actual'], `${path}.knowledge.retriever`);
  if (!retrieverShape.ok) return retrieverShape;
  for (const key of ['requested', 'resolved', 'actual']) {
    if (knowledge.retriever[key] !== null && (typeof knowledge.retriever[key] !== 'string' || !knowledge.retriever[key])) return err(`${path}.knowledge.retriever.${key}`, 'must be a non-empty string or null');
  }
  if ((knowledge.retriever.requested === null) !== (knowledge.retriever.resolved === null)) return err(`${path}.knowledge.retriever`, 'requested and resolved must both be null or both be set');
  if (knowledge.retriever.requested !== knowledge.retriever.resolved) return err(`${path}.knowledge.retriever`, 'fallback is none, so requested must equal resolved');
  if (knowledge.mode === 'none' && (knowledge.item_count !== 0 || knowledge.retriever.actual !== null)) return err(`${path}.knowledge`, 'none mode cannot claim items or an actual retriever');

  const manifest = r.manifest;
  const manifestShape = exactFields(manifest, ['task', 'catalog', 'reviewer', 'reviewer_effort', 'round_cap', 'fallback_policy', 'arms'], `${path}.manifest`);
  if (!manifestShape.ok) return manifestShape;
  if (manifest.fallback_policy !== 'none') return err(`${path}.manifest.fallback_policy`, 'v2 permits no fallback');
  const taskShape = exactFields(manifest.task, ['lane', 'depth'], `${path}.manifest.task`);
  if (!taskShape.ok) return taskShape;
  if (!['research_memo', 'competitor_teardown', 'freeform'].includes(manifest.task.lane)) return err(`${path}.manifest.task.lane`, 'unknown research lane');
  if (!['quick', 'standard'].includes(manifest.task.depth)) return err(`${path}.manifest.task.depth`, 'must be quick | standard');
  if (!Number.isInteger(manifest.round_cap) || manifest.round_cap < 1 || manifest.round_cap > 6) return err(`${path}.manifest.round_cap`, 'must be an integer from 1 to 6');
  const catalog = manifest.catalog;
  const catalogShape = exactFields(catalog, ['resolved_at', 'maker_source', 'maker_models', 'reviewer_source', 'reviewer_models'], `${path}.manifest.catalog`);
  if (!catalogShape.ok) return catalogShape;
  if (!Number.isInteger(catalog.resolved_at)) return err(`${path}.manifest.catalog.resolved_at`, 'must be epoch ms');
  if (catalog.maker_source !== 'studio_catalog') return err(`${path}.manifest.catalog.maker_source`, 'must be studio_catalog');
  if (!['codex_cache', 'fallback'].includes(catalog.reviewer_source)) return err(`${path}.manifest.catalog.reviewer_source`, 'must be codex_cache | fallback');
  for (const key of ['maker_models', 'reviewer_models']) {
    if (!Array.isArray(catalog[key]) || !catalog[key].length || catalog[key].some((model) => typeof model !== 'string' || !model) || new Set(catalog[key]).size !== catalog[key].length) {
      return err(`${path}.manifest.catalog.${key}`, 'must be a non-empty unique string array');
    }
  }
  const reviewerValid = validateIdentityDecision(manifest.reviewer, `${path}.manifest.reviewer`);
  if (!reviewerValid.ok) return reviewerValid;
  if (!catalog.reviewer_models.includes(manifest.reviewer.resolved.split(':').slice(1).join(':'))) return err(`${path}.manifest.reviewer.resolved`, 'must appear in the frozen reviewer catalog');
  const reviewerEffortShape = exactFields(manifest.reviewer_effort, ['requested', 'semantics'], `${path}.manifest.reviewer_effort`);
  if (!reviewerEffortShape.ok) return reviewerEffortShape;
  if (!['low', 'medium', 'high', 'xhigh'].includes(manifest.reviewer_effort.requested) || manifest.reviewer_effort.semantics !== 'requested_only') return err(`${path}.manifest.reviewer_effort`, 'needs requested low|medium|high|xhigh and semantics requested_only');
  if (!Array.isArray(manifest.arms) || manifest.arms.length < 2) return err(`${path}.manifest.arms`, 'requires at least two arms');
  const armIds = new Set();
  for (const [index, arm] of manifest.arms.entries()) {
    const armPath = `${path}.manifest.arms[${index}]`;
    const armShape = exactFields(arm, ['arm_id', 'executor', 'orchestration', 'effort'], armPath);
    if (!armShape.ok) return armShape;
    if (typeof arm.arm_id !== 'string' || !arm.arm_id || armIds.has(arm.arm_id)) return err(`${armPath}.arm_id`, 'must be a unique non-empty string');
    armIds.add(arm.arm_id);
    const executorValid = validateIdentityDecision(arm.executor, `${armPath}.executor`);
    if (!executorValid.ok) return executorValid;
    if (!catalog.maker_models.includes(arm.executor.resolved.split(':').slice(1).join(':'))) return err(`${armPath}.executor.resolved`, 'must appear in the frozen maker catalog');
    const orchestrationShape = exactFields(arm.orchestration, ['requested', 'semantics'], `${armPath}.orchestration`);
    if (!orchestrationShape.ok) return orchestrationShape;
    if (arm.orchestration.requested !== 'provider_native' || arm.orchestration.semantics !== 'opaque') return err(`${armPath}.orchestration`, 'must be provider_native with opaque semantics');
    const effortShape = exactFields(arm.effort, ['requested', 'semantics'], `${armPath}.effort`);
    if (!effortShape.ok) return effortShape;
    if (arm.effort.requested !== null || arm.effort.semantics !== 'not_configured') return err(`${armPath}.effort`, 'executor effort is not configured in v2');
  }

  const outcome = r.outcome;
  const outcomeShape = exactFields(outcome, ['status', 'arms'], `${path}.outcome`);
  if (!outcomeShape.ok) return outcomeShape;
  if (!['running', 'completed', 'stopped', 'infra_failed'].includes(outcome.status)) return err(`${path}.outcome.status`, 'unknown status');
  if (!Array.isArray(outcome.arms) || outcome.arms.length !== manifest.arms.length) return err(`${path}.outcome.arms`, 'must cover every manifest arm exactly once');
  const outcomeIds = new Set();
  for (const [index, arm] of outcome.arms.entries()) {
    const armPath = `${path}.outcome.arms[${index}]`;
    const fields = ['arm_id', 'run_id', 'status', 'artifact_id', 'receipt_id', 'executor_actual', 'auditor_actual', 'quality_floor', 'usage', 'judge_overlap', 'failure', 'confounded'];
    const armShape = exactFields(arm, fields, armPath);
    if (!armShape.ok) return armShape;
    if (!armIds.has(arm.arm_id) || outcomeIds.has(arm.arm_id)) return err(`${armPath}.arm_id`, 'must identify one manifest arm exactly once');
    outcomeIds.add(arm.arm_id);
    if (arm.run_id !== null && (typeof arm.run_id !== 'string' || !arm.run_id)) return err(`${armPath}.run_id`, 'must be a string or null');
    if (!['pending', 'running', 'completed', 'quality_floor_failed', 'infra_failed', 'stopped'].includes(arm.status)) return err(`${armPath}.status`, 'unknown status');
    for (const key of ['artifact_id', 'receipt_id']) if (arm[key] !== null && !HASH_RE.test(arm[key])) return err(`${armPath}.${key}`, 'must be sha256:<hex64> or null');
    for (const key of ['executor_actual', 'auditor_actual']) if (arm[key] !== null && (typeof arm[key] !== 'string' || !arm[key])) return err(`${armPath}.${key}`, 'must be a string or null');
    if (!['unknown', 'passed', 'failed'].includes(arm.quality_floor)) return err(`${armPath}.quality_floor`, 'unknown value');
    const usageShape = exactFields(arm.usage, ['input_tokens', 'cached_input_tokens', 'output_tokens', 'duration_ms'], `${armPath}.usage`);
    if (!usageShape.ok) return usageShape;
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'duration_ms']) if (!nullOrNonNegativeInt(arm.usage[key])) return err(`${armPath}.usage.${key}`, 'must be a non-negative integer or null');
    const overlap = arm.judge_overlap;
    const overlapShape = exactFields(overlap, ['arm_provider', 'judge_provider', 'same_vendor', 'same_family'], `${armPath}.judge_overlap`);
    if (!overlapShape.ok) return overlapShape;
    if (typeof overlap.arm_provider !== 'string' || !overlap.arm_provider) return err(`${armPath}.judge_overlap.arm_provider`, 'required');
    if (overlap.judge_provider !== null && (typeof overlap.judge_provider !== 'string' || !overlap.judge_provider)) return err(`${armPath}.judge_overlap.judge_provider`, 'must be a string or null');
    for (const key of ['same_vendor', 'same_family']) if (overlap[key] !== null && typeof overlap[key] !== 'boolean') return err(`${armPath}.judge_overlap.${key}`, 'must be boolean or null');
    if (typeof arm.confounded !== 'boolean') return err(`${armPath}.confounded`, 'must be boolean');
    const planned = manifest.arms.find((item) => item.arm_id === arm.arm_id);
    const substituted = arm.executor_actual !== null && arm.executor_actual !== planned.executor.resolved;
    if (arm.confounded !== substituted) return err(`${armPath}.confounded`, 'must say whether resolved and actual executor identities differ');
    const terminal = ['completed', 'quality_floor_failed', 'infra_failed', 'stopped'].includes(arm.status);
    if (['completed', 'quality_floor_failed'].includes(arm.status)) {
      if (!arm.run_id || !HASH_RE.test(arm.artifact_id ?? '') || !HASH_RE.test(arm.receipt_id ?? '') || !arm.executor_actual || !arm.auditor_actual) return err(armPath, 'completed arms require run, artifact, receipt, executor and auditor identities');
      if (arm.failure !== null) return err(`${armPath}.failure`, 'completed arms cannot carry a failure');
      if (arm.quality_floor !== (arm.status === 'completed' ? 'passed' : 'failed')) return err(`${armPath}.quality_floor`, 'must agree with the terminal arm status');
    } else if (['infra_failed', 'stopped'].includes(arm.status)) {
      if (!isObj(arm.failure) || typeof arm.failure.stage !== 'string' || typeof arm.failure.code !== 'string' || typeof arm.failure.detail !== 'string') return err(`${armPath}.failure`, 'failed/stopped arms require stage, code and detail');
      const failureShape = exactFields(arm.failure, ['stage', 'code', 'detail'], `${armPath}.failure`);
      if (!failureShape.ok) return failureShape;
      if (arm.quality_floor !== 'unknown') return err(`${armPath}.quality_floor`, 'failed/stopped arms have unknown quality');
    } else {
      if (arm.failure !== null || arm.artifact_id !== null || arm.receipt_id !== null || arm.executor_actual !== null || arm.auditor_actual !== null || arm.quality_floor !== 'unknown') return err(armPath, 'pending/running arms cannot claim terminal evidence');
    }
    if (!terminal && outcome.status !== 'running') return err(`${path}.outcome.status`, 'only a running experiment may contain non-terminal arms');
  }
  if (outcome.status === 'running' && outcome.arms.every((arm) => ['completed', 'quality_floor_failed', 'infra_failed', 'stopped'].includes(arm.status))) return err(`${path}.outcome.status`, 'all arms are terminal; experiment cannot remain running');
  if (outcome.status !== 'running' && outcome.arms.some((arm) => ['pending', 'running'].includes(arm.status))) return err(`${path}.outcome.status`, 'terminal experiment cannot contain active arms');

  try {
    if (!experimentMatches(r)) return err(`${path}.experiment_id`, 'does not match the frozen manifest');
  } catch (e) {
    return err(path, `manifest projection failed: ${e.message}`);
  }
  return OK;
}

export function validateExperimentRecord(r, path = 'experiment') {
  if (!isObj(r)) return err(path, 'must be an object');
  if (r.schemaVersion === 2) return validateParallelExperimentV2(r, path);
  return validateAuditExperimentV1(r, path);
}
