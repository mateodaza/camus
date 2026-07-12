// Hand-written runtime validators, zero-dep, mirroring the schema files.
// The .schema.json files are the canonical published spec; these enforce it
// at runtime, and the tests hold the two in agreement.

import { DIMENSIONS } from './status.mjs';

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

export function validateEvidencePack(p, path = 'evidence_pack') {
  if (!isObj(p)) return err(path, 'must be an object');
  if (p.schemaVersion !== 1) return err(path, 'schemaVersion must be 1');
  if (!/^sha256:[0-9a-f]{64}$/.test(p.artifact_id ?? '')) return err(`${path}.artifact_id`, 'must be sha256:<hex64>');
  if (typeof p.goal !== 'string' || !p.goal) return err(`${path}.goal`, 'required');
  if (typeof p.acceptance_contract !== 'string' || !p.acceptance_contract) return err(`${path}.acceptance_contract`, 'required — audits bottleneck on it');
  if (!isObj(p.artifact) || !['code', 'research'].includes(p.artifact.kind)) return err(`${path}.artifact.kind`, 'must be code | research');
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
