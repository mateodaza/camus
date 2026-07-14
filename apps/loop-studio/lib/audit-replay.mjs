// Audit-only replay: re-judge one immutable research artifact without paying to
// regenerate it. The source artifact projection is copied verbatim, new semantic
// judgments mint a new receipt, and the experiment manifest records the frozen
// model catalog, requested effort, overlap, usage, and failed outcomes.

import { createHash } from 'node:crypto';
import { canonicalString, seal } from '../../../packages/trust/lib/canonical.mjs';
import { sealExperiment } from '../../../packages/trust/lib/experiment.mjs';
import { validateEvidencePack, validateExperimentRecord } from '../../../packages/trust/lib/validate.mjs';
import { claimAssessmentEvidenceHash } from './claims.mjs';
import { coverageAssessmentEvidenceHash } from './contract.mjs';
import { thresholdLineHash, thresholdEvidenceHash } from './verify.mjs';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const hash = (value) => `sha256:${createHash('sha256').update(canonicalString(value), 'utf8').digest('hex')}`;
const hashText = (value) => `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const providerOf = (identity) => String(identity ?? '').split(':')[0] || null;
const modelOf = (identity) => String(identity ?? '').split(':').slice(1).join(':');

function familyOf(identity) {
  const provider = providerOf(identity);
  const model = modelOf(identity).toLowerCase();
  if (!provider || !model) return null;
  if (provider === 'openai') return model.match(/^gpt-(\d+)/)?.[0] ?? model.split(/[-/]/)[0];
  return model.split(/[-/]/)[0];
}

function usageOf(review) {
  const n = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  return {
    input_tokens: n(review?.usage?.input_tokens),
    cached_input_tokens: n(review?.usage?.cached_input_tokens),
    output_tokens: n(review?.usage?.output_tokens),
    duration_ms: n(review?.durationMs),
  };
}

export function knowledgeSnapshotId(evidence) {
  const grounding = evidence?.grounding;
  if (!grounding || (!(grounding.queries ?? []).length && !(grounding.results ?? []).length)) return null;
  return hash({
    mode: grounding.mode ?? null,
    queried: grounding.queried === true,
    queries: grounding.queries ?? [],
    results: (grounding.results ?? []).map((result) => ({
      query: result.query ?? null,
      title: result.title ?? null,
      author: result.author ?? null,
      ref: result.ref ?? null,
      score: result.score ?? null,
      excerpt: result.excerpt ?? null,
    })),
  });
}

export function createAuditReplayExperiment({ sourceRunId, sourcePack, sourceEvidence, sourceDeliverable, reviewerModel, effort, catalog, createdAt = Date.now() }) {
  if (sourcePack?.schemaVersion !== 2 || sourcePack?.artifact?.kind !== 'research') {
    throw new TypeError('audit-only replay currently requires a research evidence-pack v2');
  }
  const sourceValid = validateEvidencePack(sourcePack);
  if (!sourceValid.ok) throw new TypeError(`source evidence pack refused: ${sourceValid.error}`);
  if (typeof sourceDeliverable !== 'string' || !sourceDeliverable.trim()) {
    throw new TypeError('audit-only replay requires the source deliverable');
  }
  if (!HASH_RE.test(sourcePack.artifact.deliverable_hash ?? '') || hashText(sourceDeliverable) !== sourcePack.artifact.deliverable_hash) {
    throw new TypeError('source deliverable does not match the sealed artifact; refusing audit replay');
  }
  if (!catalog?.reviewer?.includes(reviewerModel)) throw new TypeError(`reviewer ${reviewerModel} is not in the frozen catalog`);
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new TypeError('effort must be low, medium, high, or xhigh');
  const snapshotId = knowledgeSnapshotId(sourceEvidence);
  const armProvider = providerOf(sourcePack.pairing.executor.actual) ?? 'unknown';
  const draft = {
    schemaVersion: 1,
    mode: 'audit_only_replay',
    created_at: createdAt,
    source: {
      run_id: sourceRunId,
      artifact_id: sourcePack.artifact_id,
      receipt_id: sourcePack.receipt_id,
    },
    manifest: {
      arm_id: 'audit-1',
      knowledge_snapshot_id: snapshotId,
      knowledge_privacy: snapshotId ? 'internal' : 'none',
      catalog: {
        resolved_at: createdAt,
        reviewer_source: catalog.reviewerSource,
        reviewer_models: [...catalog.reviewer],
      },
      reviewer: {
        requested: `openai:${reviewerModel}`,
        resolved: `openai:${reviewerModel}`,
      },
      effort: { requested: effort, semantics: 'requested_only' },
      fallback_policy: 'none',
    },
    outcome: {
      status: 'running',
      artifact_id: sourcePack.artifact_id,
      receipt_id: null,
      auditor_actual: null,
      effort_actual: null,
      judge_overlap: { arm_provider: armProvider, judge_provider: null, same_vendor: null, same_family: null },
      usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
      failure: null,
      confounded: false,
    },
  };
  const sealed = sealExperiment(draft);
  const valid = validateExperimentRecord(sealed);
  if (!valid.ok) throw new TypeError(`experiment manifest refused: ${valid.error}`);
  return sealed;
}

function actualAuditor(review, reviewerModel, simulated) {
  if (!review?.ran) return null;
  if (simulated) return 'simulation:scripted-auditor';
  return `openai:${review.reviewerModel || reviewerModel}`;
}

function auditState({ review, sourcePack, reviewerModel, simulated }) {
  const actual = actualAuditor(review, reviewerModel, simulated);
  const executorProvider = providerOf(sourcePack.pairing.executor.actual);
  const auditorProvider = providerOf(actual);
  if (simulated) return { audit: 'not_run', independence: 'none', actual };
  if (!review?.ran) return { audit: 'infra_failed', independence: 'none', actual: null };
  const sameVendor = executorProvider === auditorProvider;
  const caveats = review.verdict !== 'APPROVED'
    || (review.findings ?? []).length > 0
    || (review.questions ?? []).length > 0
    || (review.claimAssessments ?? []).some((item) => item.decision !== 'supported')
    || (review.coverageAssessments ?? []).some((item) => item.decision !== 'met');
  return {
    audit: sameVendor
      ? (caveats ? 'advisory_findings' : 'advisory_clean')
      : (caveats ? 'independent_findings' : 'independent_clean'),
    independence: sameVendor ? 'same_vendor_advisory' : 'cross_vendor',
    actual,
  };
}

export function buildAuditReplayPack({ sourcePack, review, reviewerModel, effort, experimentId, auditAnswers = [], simulated = false, createdAt = Date.now() }) {
  if (!HASH_RE.test(experimentId ?? '')) throw new TypeError('audit replay requires a sealed experiment_id');
  const sourceValid = validateEvidencePack(sourcePack);
  if (!sourceValid.ok) throw new TypeError(`source evidence pack refused: ${sourceValid.error}`);
  if (sourcePack.schemaVersion !== 2 || sourcePack.artifact.kind !== 'research') throw new TypeError('audit-only replay currently requires a research evidence-pack v2');

  const claimDecisions = new Map((simulated || !review?.ran ? [] : review.claimAssessments ?? []).map((item) => [item.marker, item.decision]));
  const coverageDecisions = new Map((simulated || !review?.ran ? [] : review.coverageAssessments ?? []).map((item) => [item.criterion_id, item.decision]));
  const artifact = clone(sourcePack.artifact);
  artifact.claims = (artifact.claims ?? []).map((claim) => ({ ...claim, decision: claimDecisions.get(claim.marker) ?? 'unchecked' }));
  artifact.contract_coverage = (artifact.contract_coverage ?? []).map((criterion) => ({ ...criterion, decision: coverageDecisions.get(criterion.id) ?? 'unclear' }));

  const state = auditState({ review, sourcePack, reviewerModel, simulated });
  const auditorIdentity = {
    requested: `openai:${reviewerModel}`,
    resolved: `openai:${reviewerModel}`,
    actual: state.actual ?? 'unknown:not-recorded',
  };
  const claimSession = (simulated || !review?.ran ? [] : review.claimAssessments ?? []).map((item) =>
    `audit replay claim ${item.marker}: ${item.decision}; evidence_hash=${claimAssessmentEvidenceHash(item) ?? 'none'}`,
  );
  const coverageSession = (simulated || !review?.ran ? [] : review.coverageAssessments ?? []).map((item) =>
    `audit replay coverage ${item.criterion_id}: ${item.decision}; evidence_hash=${coverageAssessmentEvidenceHash(item) ?? 'none'}`,
  );
  const thresholdSession = (simulated || !review?.ran ? [] : review.thresholdAssessments ?? []).map((item) =>
    `audit replay threshold ${item.id}: ${item.decision}; line_hash=${thresholdLineHash(item) ?? 'none'}; evidence_hash=${thresholdEvidenceHash(item) ?? 'none'}`,
  );
  const sessionLog = [
    ...(sourcePack.session_log ?? []),
    `audit replay experiment: ${experimentId}`,
    `parent receipt: ${sourcePack.receipt_id}`,
    `audit replay effort requested: ${effort}; actual: ${simulated && review?.ran ? 'scripted' : review?.effortActual ?? 'not reported'}`,
    ...claimSession,
    ...coverageSession,
    ...thresholdSession,
    ...(!review?.ran ? [`audit replay failure: ${review?.error || 'unknown'}`] : []),
  ];
  const sourceExecutorEconomics = sourcePack.economics.find((item) => item.role === 'executor');
  const executorEconomics = sourceExecutorEconomics
    ? clone(sourceExecutorEconomics)
    : {
        schemaVersion: 1,
        role: 'executor',
        ...clone(sourcePack.pairing.executor),
        effort: null, fallback: null, usage: null,
        billing_mode: 'unknown', estimated_cost_usd: null, duration_ms: null,
      };
  const pack = {
    schemaVersion: 2,
    goal: sourcePack.goal,
    acceptance_contract: sourcePack.acceptance_contract,
    artifact,
    verification: clone(sourcePack.verification),
    session_log: sessionLog,
    pairing: {
      schemaVersion: 1,
      executor: clone(sourcePack.pairing.executor),
      auditor: auditorIdentity,
      independence: state.independence,
    },
    statuses: { ...clone(sourcePack.statuses), audit: state.audit },
    human_decisions: [
      ...clone(sourcePack.human_decisions),
      ...auditAnswers.map((item) => ({
        schemaVersion: 1,
        kind: 'adjudication',
        question: String(item.question ?? ''),
        answer: String(item.answer ?? ''),
        at: Number.isInteger(item.at) ? item.at : createdAt,
      })),
    ],
    economics: [
      executorEconomics,
      {
        schemaVersion: 1,
        role: 'auditor',
        ...auditorIdentity,
        effort: review?.ran ? (simulated ? 'scripted' : (review.effortActual ?? null)) : null,
        fallback: null,
        usage: usageOf(review),
        billing_mode: 'unknown',
        estimated_cost_usd: null,
        duration_ms: usageOf(review).duration_ms,
      },
    ],
    created_at: createdAt,
  };
  const sealed = seal(pack);
  if (sealed.artifact_id !== sourcePack.artifact_id) throw new TypeError('audit replay changed artifact_id; refusing the receipt');
  const valid = validateEvidencePack(sealed);
  if (!valid.ok) throw new TypeError(`audit replay evidence pack refused: ${valid.error}`);
  return sealed;
}

export function finalizeAuditReplayExperiment(experiment, { pack = null, review, stopped = false, simulated = false }) {
  const actual = actualAuditor(review, modelOf(experiment.manifest.reviewer.resolved), simulated);
  const armIdentity = pack?.pairing?.executor?.actual ?? null;
  const armProvider = providerOf(armIdentity) ?? 'unknown';
  const judgeProvider = providerOf(actual);
  const sameVendor = judgeProvider ? armProvider === judgeProvider : null;
  const sameFamily = judgeProvider ? (sameVendor ? familyOf(armIdentity) === familyOf(actual) : false) : null;
  const status = stopped ? 'stopped' : review?.ran ? 'completed' : 'infra_failed';
  const failure = status === 'completed' ? null : {
    stage: 'audit',
    code: stopped ? 'stopped_by_human' : 'adapter_failure',
    detail: String(review?.error || (stopped ? 'stopped by human' : 'audit did not run')),
  };
  const outcome = {
    status,
    artifact_id: experiment.source.artifact_id,
    receipt_id: pack?.receipt_id ?? null,
    auditor_actual: actual,
    effort_actual: review?.ran ? (simulated ? 'scripted' : (review.effortActual ?? null)) : null,
    judge_overlap: { arm_provider: armProvider, judge_provider: judgeProvider, same_vendor: sameVendor, same_family: sameFamily },
    usage: usageOf(review),
    failure,
    confounded: actual !== null && actual !== experiment.manifest.reviewer.resolved,
  };
  const final = { ...experiment, outcome };
  const valid = validateExperimentRecord(final);
  if (!valid.ok) throw new TypeError(`experiment outcome refused: ${valid.error}`);
  return final;
}
