// Compare & Learn execution primitives. The parent freezes one knowledge
// snapshot and one model catalog before any executor starts. Every arm keeps
// its own ordinary evidence pack; the experiment record binds the common
// inputs and retains successful, failed and stopped outcomes together.

import { createHash } from 'node:crypto';
import { canonicalString } from '../../../packages/trust/lib/canonical.mjs';
import { sealExperiment } from '../../../packages/trust/lib/experiment.mjs';
import { validateEvidencePack, validateExperimentRecord } from '../../../packages/trust/lib/validate.mjs';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const sha256 = (value) => `sha256:${createHash('sha256').update(canonicalString(value), 'utf8').digest('hex')}`;
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

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function normalizeKnowledgeItems(items, limit = 32) {
  const out = [];
  const seen = new Set();
  for (const raw of items ?? []) {
    const item = {
      query: String(raw?.query ?? '').slice(0, 300),
      title: String(raw?.title ?? 'Untitled knowledge result').slice(0, 240),
      author: raw?.author == null ? null : String(raw.author).slice(0, 160),
      ref: raw?.ref == null ? null : String(raw.ref).slice(0, 240),
      score: typeof raw?.score === 'number' && Number.isFinite(raw.score) ? raw.score : null,
      excerpt: String(raw?.excerpt ?? raw?.text ?? '').slice(0, 1200),
    };
    if (!item.excerpt) continue;
    const key = canonicalString(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function sealKnowledgeSnapshot({ query, mode, items = [], retriever, capturedAt = Date.now() }) {
  const normalized = {
    schemaVersion: 1,
    captured_at: capturedAt,
    query: String(query ?? ''),
    mode,
    retriever: clone(retriever),
    items: normalizeKnowledgeItems(items),
  };
  return { ...normalized, snapshot_id: sha256(normalized) };
}

export function knowledgeSnapshotMatches(snapshot) {
  if (!HASH_RE.test(snapshot?.snapshot_id ?? '')) return false;
  const { snapshot_id, ...contents } = snapshot;
  return sha256(contents) === snapshot_id;
}

const emptyUsage = () => ({ input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null });
const pendingOutcome = (arm) => ({
  arm_id: arm.arm_id,
  run_id: null,
  status: 'pending',
  artifact_id: null,
  receipt_id: null,
  executor_actual: null,
  auditor_actual: null,
  quality_floor: 'unknown',
  usage: emptyUsage(),
  judge_overlap: { arm_provider: providerOf(arm.executor.resolved) ?? 'unknown', judge_provider: null, same_vendor: null, same_family: null },
  failure: null,
  confounded: false,
});

export function createParallelExperiment({ goal, acceptanceContract, lane, depth, roundCap, snapshot, makerModels, reviewerModel, reviewerEffort, catalog, createdAt = Date.now() }) {
  if (!knowledgeSnapshotMatches(snapshot)) throw new TypeError('knowledge snapshot identity does not match its contents');
  if (!Array.isArray(makerModels) || makerModels.length < 2 || new Set(makerModels).size !== makerModels.length) {
    throw new TypeError('parallel execution requires at least two distinct maker models');
  }
  for (const model of makerModels) if (!catalog?.maker?.includes(model)) throw new TypeError(`maker ${model} is not in the frozen catalog`);
  if (!catalog?.reviewer?.includes(reviewerModel)) throw new TypeError(`reviewer ${reviewerModel} is not in the frozen catalog`);
  if (!['low', 'medium', 'high', 'xhigh'].includes(reviewerEffort)) throw new TypeError('reviewer effort must be low, medium, high, or xhigh');
  const arms = makerModels.map((model, index) => ({
    arm_id: `arm-${index + 1}`,
    executor: { requested: `anthropic:${model}`, resolved: `anthropic:${model}` },
    orchestration: { requested: 'provider_native', semantics: 'opaque' },
    effort: { requested: null, semantics: 'not_configured' },
  }));
  const draft = {
    schemaVersion: 2,
    mode: 'parallel_execution',
    created_at: createdAt,
    goal,
    acceptance_contract: acceptanceContract,
    knowledge: {
      snapshot_id: snapshot.snapshot_id,
      privacy: snapshot.items.length ? 'internal' : 'none',
      mode: snapshot.mode,
      query: snapshot.query,
      item_count: snapshot.items.length,
      retriever: clone(snapshot.retriever),
    },
    manifest: {
      task: { lane, depth },
      catalog: {
        resolved_at: createdAt,
        maker_source: 'studio_catalog',
        maker_models: [...catalog.maker],
        reviewer_source: catalog.reviewerSource,
        reviewer_models: [...catalog.reviewer],
      },
      reviewer: { requested: `openai:${reviewerModel}`, resolved: `openai:${reviewerModel}` },
      reviewer_effort: { requested: reviewerEffort, semantics: 'requested_only' },
      round_cap: roundCap,
      fallback_policy: 'none',
      arms,
    },
    outcome: { status: 'running', arms: arms.map(pendingOutcome) },
  };
  const sealed = sealExperiment(draft);
  const valid = validateExperimentRecord(sealed);
  if (!valid.ok) throw new TypeError(`parallel experiment refused: ${valid.error}`);
  return sealed;
}

export function markParallelArmRunning(experiment, armId, runId) {
  const next = {
    ...experiment,
    outcome: {
      ...experiment.outcome,
      arms: experiment.outcome.arms.map((arm) => arm.arm_id === armId ? { ...arm, run_id: runId, status: 'running' } : arm),
    },
  };
  const valid = validateExperimentRecord(next);
  if (!valid.ok) throw new TypeError(`running arm refused: ${valid.error}`);
  return next;
}

function aggregateMakerUsage(report) {
  const rows = Array.isArray(report?.makerUsage) ? report.makerUsage : [];
  const sum = (key) => {
    const values = rows.map((row) => row?.usage?.[key]).filter((value) => Number.isInteger(value) && value >= 0);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const durations = rows.map((row) => row?.duration_ms).filter((value) => Number.isInteger(value) && value >= 0);
  return {
    input_tokens: sum('input_tokens'),
    cached_input_tokens: sum('cached_input_tokens'),
    output_tokens: sum('output_tokens'),
    duration_ms: durations.length ? durations.reduce((total, value) => total + value, 0) : null,
  };
}

export function qualityFloorPassed(pack) {
  if (!pack || !validateEvidencePack(pack).ok) return false;
  if (!['passed', 'passed_with_caveats'].includes(pack.statuses.verification)) return false;
  // A comparison is allowed to record same-vendor/advisory review, but that
  // review cannot clear the optimization floor. Otherwise an arm could award
  // itself the standing used to route future work.
  if (pack.statuses.audit !== 'independent_clean') return false;
  if (Array.isArray(pack.artifact.claims) && pack.artifact.claims.some((claim) => claim.decision !== 'supported')) return false;
  if (Array.isArray(pack.artifact.contract_coverage) && pack.artifact.contract_coverage.some((criterion) => criterion.decision !== 'met')) return false;
  return true;
}

export function outcomeFromArmReport({ experiment, armId, runId, report }) {
  const planned = experiment.manifest.arms.find((arm) => arm.arm_id === armId);
  if (!planned) throw new TypeError(`unknown arm ${armId}`);
  const pack = report?.evidencePack;
  const packValid = pack ? validateEvidencePack(pack) : { ok: false, error: 'missing evidence pack' };
  const stopped = report?.status === 'stopped';
  const infraFailed = !pack || !packValid.ok || report?.status === 'failed';
  const floorPassed = !stopped && !infraFailed && qualityFloorPassed(pack);
  const status = stopped ? 'stopped' : infraFailed ? 'infra_failed' : floorPassed ? 'completed' : 'quality_floor_failed';
  const executorActual = report?.simulated === true
    ? (packValid.ok ? pack.pairing.executor.actual : null)
    : report?.makerActualModels?.at(-1) ?? (packValid.ok ? pack.pairing.executor.actual : null);
  const auditorActual = packValid.ok ? pack.pairing.auditor.actual : null;
  const armProvider = providerOf(executorActual ?? planned.executor.resolved) ?? 'unknown';
  const judgeProvider = providerOf(auditorActual);
  const sameVendor = judgeProvider ? armProvider === judgeProvider : null;
  const sameFamily = judgeProvider ? (sameVendor ? familyOf(executorActual) === familyOf(auditorActual) : false) : null;
  const failure = ['infra_failed', 'stopped'].includes(status)
    ? {
        stage: stopped ? 'execution' : 'receipt',
        code: stopped ? 'stopped_by_human' : 'arm_failed',
        detail: String(report?.error || report?.evidencePackError || packValid.error || status),
      }
    : null;
  return {
    arm_id: armId,
    run_id: runId,
    status,
    artifact_id: packValid.ok ? pack.artifact_id : null,
    receipt_id: packValid.ok ? pack.receipt_id : null,
    executor_actual: executorActual,
    auditor_actual: auditorActual,
    quality_floor: floorPassed ? 'passed' : ['infra_failed', 'stopped'].includes(status) ? 'unknown' : 'failed',
    usage: aggregateMakerUsage(report),
    judge_overlap: { arm_provider: armProvider, judge_provider: judgeProvider, same_vendor: sameVendor, same_family: sameFamily },
    failure,
    confounded: executorActual !== null && executorActual !== planned.executor.resolved,
  };
}

export function finalizeParallelExperiment(experiment, outcomes, { stopped = false, infrastructureFailed = false } = {}) {
  const byId = new Map(outcomes.map((outcome) => [outcome.arm_id, outcome]));
  const arms = experiment.manifest.arms.map((arm) => byId.get(arm.arm_id) ?? pendingOutcome(arm));
  const allTerminal = arms.every((arm) => ['completed', 'quality_floor_failed', 'infra_failed', 'stopped'].includes(arm.status));
  const status = !allTerminal ? 'running' : stopped ? 'stopped' : infrastructureFailed || arms.every((arm) => arm.status === 'infra_failed') ? 'infra_failed' : 'completed';
  const final = { ...experiment, outcome: { status, arms } };
  const valid = validateExperimentRecord(final);
  if (!valid.ok) throw new TypeError(`parallel experiment outcome refused: ${valid.error}`);
  return final;
}
