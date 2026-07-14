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

export function validateStatus(s, path = 'status') {
  if (!isObj(s)) return err(path, 'must be an object');
  if (s.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
  for (const dim of ['execution', 'verification', 'audit', 'publication']) {
    if (!DIMENSIONS[dim].includes(s[dim])) return err(`${path}.${dim}`, `must be one of ${DIMENSIONS[dim].join('|')}`);
  }
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

export function validatePairingManifest(m, path = 'pairing') {
  if (!isObj(m)) return err(path, 'must be an object');
  if (m.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
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
  if (![1, 2].includes(p.schemaVersion)) return err(path, 'schemaVersion must be 1 or 2');
  const unknown = Object.keys(p).filter((k) => !PACK_FIELDS.includes(k));
  if (unknown.length) return err(path, `unknown field(s): ${unknown.join(', ')} — schema v${p.schemaVersion} does not know them; nothing enters or escapes a hash silently`);
  if (!/^sha256:[0-9a-f]{64}$/.test(p.artifact_id ?? '')) return err(`${path}.artifact_id`, 'must be sha256:<hex64>');
  if (!/^sha256:[0-9a-f]{64}$/.test(p.receipt_id ?? '')) return err(`${path}.receipt_id`, 'must be sha256:<hex64>');
  if (typeof p.goal !== 'string' || !p.goal) return err(`${path}.goal`, 'required');
  if (typeof p.acceptance_contract !== 'string' || !p.acceptance_contract) return err(`${path}.acceptance_contract`, 'required — audits bottleneck on it');
  if (!isObj(p.artifact) || !['code', 'research'].includes(p.artifact.kind)) return err(`${path}.artifact.kind`, 'must be code | research');
  if (p.schemaVersion === 1 && 'contract_coverage' in p.artifact) {
    return err(`${path}.artifact.contract_coverage`, 'requires evidence-pack schemaVersion 2');
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
      if (p.schemaVersion === 2) {
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
  if (p.schemaVersion === 2) {
    if (!('contract_coverage' in p.artifact)) return err(`${path}.artifact.contract_coverage`, 'required in evidence-pack v2');
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

export function validateExperimentRecord(r, path = 'experiment') {
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
