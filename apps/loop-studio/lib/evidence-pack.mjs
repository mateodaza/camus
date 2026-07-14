// Studio -> trust protocol integration. This module assembles the provider-
// independent evidence pack from facts already sealed by the run: the explicit
// acceptance contract, final artifact, model snapshot + recorded actuals,
// deterministic verification, human decisions, and raw status dimensions.
// It owns no presentation policy: the standing remains derived at render time.

import { createHash } from 'node:crypto';
import { seal } from '../../../packages/trust/lib/canonical.mjs';
import { validateEvidencePack } from '../../../packages/trust/lib/validate.mjs';
import { buildClaimLedger, claimAssessmentEvidenceHash } from './claims.mjs';
import { buildCoverageLedger, coverageAssessmentEvidenceHash } from './contract.mjs';

const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
const named = (provider, value) => `${provider}:${value || 'not-recorded'}`;
const providerOf = (value) => String(value).split(':')[0];

function actuals({ lane, evidence, models, simulated }) {
  const requestedExecutor = named('anthropic', models?.maker?.model);
  const requestedAuditor = named('openai', models?.reviewer?.model);
  if (simulated) {
    return {
      executor: { requested: requestedExecutor, resolved: requestedExecutor, actual: 'simulation:scripted-maker' },
      auditor: { requested: requestedAuditor, resolved: requestedAuditor, actual: 'simulation:scripted-auditor' },
      auditorEffort: 'scripted',
      session: ['rehearsal: scripted maker and auditor; no model calls ran'],
    };
  }

  const latestReview = (evidence?.rounds ?? []).filter((r) => r.reviewerModel).at(-1) ?? null;
  const gate = evidence?.gateReport ?? null;
  const initial = gate?.initialModel ?? null;
  const final = gate?.finalFixModel ?? gate?.model ?? initial;
  // Words calls are explicitly pinned on every adapter invocation. Build uses
  // the gate report instead: escalation means the final model may differ from
  // the run-start request, and that difference is exactly what must survive.
  const executorActual = lane === 'build'
    ? named('anthropic', final)
    : named('anthropic', models?.maker?.model);
  const auditorActual = latestReview?.reviewerModel
    ? named('openai', latestReview.reviewerModel)
    : 'unknown:not-recorded';
  const session = [];
  if (initial) session.push(`executor initial model: ${named('anthropic', initial)}`);
  if (final) session.push(`executor final model: ${named('anthropic', final)}`);
  if (latestReview?.reviewerEffort) session.push(`auditor actual effort: ${latestReview.reviewerEffort}`);
  if (evidence?.grounding) {
    session.push(`grounding ${evidence.grounding.mode || 'unknown'}: ${evidence.grounding.queried ? 'queried' : 'not queried'} (${evidence.grounding.queryCount || 0} observed tool calls)`);
    for (const query of evidence.grounding.queries ?? []) session.push(`hivemind query: ${query}`);
    for (const result of evidence.grounding.results ?? []) {
      session.push(`hivemind result: ${[result.title, result.author].filter(Boolean).join(' — ') || 'untitled'}; ref=${result.ref ?? 'none'}; excerpt_hash=${hashText(result.excerpt ?? '')}`);
    }
  }
  return {
    executor: { requested: requestedExecutor, resolved: requestedExecutor, actual: executorActual },
    auditor: { requested: requestedAuditor, resolved: requestedAuditor, actual: auditorActual },
    auditorEffort: latestReview?.reviewerEffort ?? null,
    session,
  };
}

function verificationChecks(evidence) {
  const latest = (evidence?.verify ?? []).at(-1) ?? null;
  if (!latest) return [];
  if (Array.isArray(latest.checks) && latest.checks.length) {
    return latest.checks.map((c) => ({ id: String(c.id), status: c.status, detail: c.detail ?? null }));
  }
  // The build gate exposes a head-bound summary rather than its internal test
  // list. Keep that provenance explicit instead of inventing check counts.
  return [{
    id: latest.source || 'verification-summary',
    status: latest.pass === true ? 'pass' : latest.pass === false ? 'fail' : 'warn',
    detail: latest.detail ?? (latest.commitSha ? `bound to ${latest.commitSha}` : null),
  }];
}

export function buildEvidencePack({
  goal,
  acceptanceContract,
  lane,
  targetPath = null,
  deliverable = null,
  evidence,
  statuses,
  models,
  simulated = false,
  createdAt = Date.now(),
}) {
  const ids = actuals({ lane, evidence, models, simulated });
  const audit = statuses?.audit;
  const independence = audit === 'independent_clean' || audit === 'independent_findings'
    ? 'cross_vendor'
    : audit === 'advisory_clean' || audit === 'advisory_findings'
      ? 'same_vendor_advisory'
      : 'none';

  // A cross-vendor claim must agree with the recorded actual providers. If an
  // audit dimension ever says independent while its actual identity is absent
  // or same-vendor, validation must fail and degrade the enclosing receipt.
  if (independence === 'cross_vendor' && (
    providerOf(ids.executor.actual) === 'unknown'
    || providerOf(ids.auditor.actual) === 'unknown'
    || providerOf(ids.executor.actual) === providerOf(ids.auditor.actual)
  )) {
    throw new TypeError('independent audit standing conflicts with the recorded executor/auditor providers');
  }

  const head = lane === 'build'
    ? (evidence?.gateReport?.commit_sha ?? evidence?.gateReport?.commit ?? null)
    : null;
  const finalRev = (evidence?.revisions ?? []).at(-1)?.rev ?? null;
  const finalReview = finalRev === null
    ? null
    : (evidence?.rounds ?? []).filter((r) => r.rev === finalRev).at(-1) ?? null;
  // Scripted reviewer decisions are presentation for the rehearsal arc, never
  // semantic evidence. A live final-revision audit may populate the decisions;
  // absent/stale assessment coverage remains explicitly unchecked.
  const claimAssessments = simulated ? [] : (finalReview?.claimAssessments ?? []);
  const coverageAssessments = simulated ? [] : (finalReview?.coverageAssessments ?? []);
  const claims = lane === 'build'
    ? null
    : buildClaimLedger(deliverable, {
        groundingResults: evidence?.grounding?.results ?? [],
        assessments: claimAssessments,
      });
  // The Studio words lanes emit structured coverage. The build gate already
  // receives the acceptance contract, but does not yet return per-criterion
  // assessments; null is more honest than manufacturing unclear decisions.
  const contractCoverage = lane === 'build'
    ? null
    : buildCoverageLedger(acceptanceContract, { assessments: coverageAssessments });
  const claimSession = claimAssessments.map((a) =>
    `claim assessment ${a.marker}: ${a.decision}; evidence_hash=${claimAssessmentEvidenceHash(a) ?? 'none'}`,
  );
  const coverageSession = coverageAssessments.map((a) =>
    `coverage assessment ${a.criterion_id}: ${a.decision}; evidence_hash=${coverageAssessmentEvidenceHash(a) ?? 'none'}`,
  );
  const pack = {
    schemaVersion: 2,
    goal,
    acceptance_contract: acceptanceContract,
    artifact: lane === 'build'
      ? { kind: 'code', repo: targetPath, head, diff_hash: null, changed_files: null, deliverable_hash: null, claims: null, contract_coverage: null }
      : { kind: 'research', repo: null, head: null, diff_hash: null, changed_files: null, deliverable_hash: deliverable == null ? null : hashText(deliverable), claims, contract_coverage: contractCoverage },
    verification: { command: null, checks: verificationChecks(evidence) },
    session_log: [...ids.session, ...claimSession, ...coverageSession],
    pairing: {
      schemaVersion: 1,
      executor: ids.executor,
      auditor: ids.auditor,
      independence,
    },
    statuses,
    human_decisions: (evidence?.humanDecisions ?? []).map((d) => ({
      schemaVersion: 1,
      kind: ['decision', 'infra', 'stuck', 'verify', 'adjudication'].includes(d.kind) ? d.kind : 'decision',
      question: String(d.question ?? ''),
      answer: String(d.answer ?? ''),
      at: Number.isInteger(d.at) ? d.at : createdAt,
    })),
    economics: [
      {
        schemaVersion: 1, role: 'executor', ...ids.executor,
        effort: null, fallback: null, usage: null,
        billing_mode: 'unknown', estimated_cost_usd: null, duration_ms: null,
      },
      {
        schemaVersion: 1, role: 'auditor', ...ids.auditor,
        effort: ids.auditorEffort, fallback: null, usage: null,
        billing_mode: 'unknown', estimated_cost_usd: null, duration_ms: null,
      },
    ],
    created_at: createdAt,
  };
  const sealed = seal(pack);
  const valid = validateEvidencePack(sealed);
  if (!valid.ok) throw new TypeError(`evidence pack refused: ${valid.error}`);
  return sealed;
}

export const shortEvidenceId = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
