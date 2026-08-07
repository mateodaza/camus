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
import { thresholdLineHash, thresholdEvidenceHash } from './verify.mjs';

const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
const named = (provider, value) => `${provider}:${value || 'not-recorded'}`;
const providerOf = (value) => String(value).split(':')[0];

// A verification-only recovery runs NO model. Left to the legacy defaults below it
// sealed `anthropic:not-recorded` / `unknown:not-recorded`, which reads as "a run
// that used those vendors and lost the observation" — inventing provider provenance
// for a run that had none by construction (audit 2026-08-05). A zero-model run says
// so, in a token that names no vendor.
export const NO_MODEL_IDENTITY = 'none:no-model-run';
const isModelFreeRun = (models) => models?.recovery === true
  && (models?.maker ?? null) === null && (models?.reviewer ?? null) === null;

function actuals({ lane, evidence, models, makerActualModels = [], simulated }) {
  if (isModelFreeRun(models)) {
    return {
      executor: { requested: NO_MODEL_IDENTITY, resolved: NO_MODEL_IDENTITY, actual: NO_MODEL_IDENTITY },
      auditor: { requested: NO_MODEL_IDENTITY, resolved: NO_MODEL_IDENTITY, actual: NO_MODEL_IDENTITY },
      auditorEffort: null,
      session: ['no model seats: this run resolved no maker or auditor and made no model calls'],
    };
  }
  // A snapshot without providers predates seat selection; its meaning was
  // claude-writes / codex-reviews, so those defaults are the recorded truth
  // for legacy runs, not a guess about new ones (new snapshots always carry
  // providers).
  const requestedExecutor = named(models?.maker?.provider || 'anthropic', models?.maker?.model);
  const requestedAuditor = named(models?.reviewer?.provider || 'openai', models?.reviewer?.model);
  if (simulated) {
    const session = ['rehearsal: scripted maker and auditor; no model calls ran'];
    if (evidence?.grounding?.snapshotId) session.push(`frozen knowledge snapshot: ${evidence.grounding.snapshotId}`);
    return {
      executor: { requested: requestedExecutor, resolved: requestedExecutor, actual: 'simulation:scripted-maker' },
      auditor: { requested: requestedAuditor, resolved: requestedAuditor, actual: 'simulation:scripted-auditor' },
      auditorEffort: 'scripted',
      session,
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
    : makerActualModels.at(-1) ?? requestedExecutor;
  // The round's provider-qualified identity is the observation of record; a
  // pre-seats round without one was codex by construction. No identity at
  // all fails closed to unknown — never a guess.
  const auditorActual = latestReview?.reviewerIdentity
    ?? (latestReview?.reviewerModel ? named('openai', latestReview.reviewerModel) : 'unknown:not-recorded');
  const session = [];
  if (models?.maker?.backend) session.push(`executor seat: backend=${models.maker.backend}; decision source=${models.maker.source ?? 'not recorded'}`);
  if (models?.reviewer?.backend) session.push(`auditor seat: backend=${models.reviewer.backend}; decision source=${models.reviewer.modelSource ?? 'not recorded'}`);
  if (initial) session.push(`executor initial model: ${named('anthropic', initial)}`);
  if (final) session.push(`executor final model: ${named('anthropic', final)}`);
  if (latestReview?.reviewerEffort) session.push(`auditor actual effort: ${latestReview.reviewerEffort}`);
  if (evidence?.grounding) {
    if (evidence.grounding.snapshotId) session.push(`frozen knowledge snapshot: ${evidence.grounding.snapshotId}`);
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

const CHECK_STATUSES = ['pass', 'fail', 'warn', 'skip'];

function verificationChecks(evidence) {
  const latest = (evidence?.verify ?? []).at(-1) ?? null;
  if (!latest) return [];
  // Only entries that ARE checks. The gate's `failures` ride this same field (they carry
  // stage/kind, not id/status), so mapping them blindly produced `{id: "undefined",
  // status: undefined}` and the whole pack was REFUSED — a degraded receipt caused by
  // the report it was describing (caught by the restart test, 2026-08-05). Anything that
  // is not a check falls through to the head-bound summary below.
  const usable = Array.isArray(latest.checks)
    ? latest.checks.filter((c) => c && (typeof c.id === 'string' || typeof c.id === 'number') && CHECK_STATUSES.includes(c.status))
    : [];
  if (usable.length) {
    return usable.map((c) => ({ id: String(c.id), status: c.status, detail: c.detail ?? null }));
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
  makerActualModels = [],
  simulated = false,
  verifyCommand = null,
  recoveryOf = null,
  createdAt = Date.now(),
}) {
  const ids = actuals({ lane, evidence, models, makerActualModels, simulated });
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
  const thresholdAssessments = simulated ? [] : (finalReview?.thresholdAssessments ?? []);
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
  // Threshold decisions are sealed into the receipt exactly like claim/coverage
  // decisions: a laundered stat caught here (observed) changes the receipt. The
  // line_hash binds the ordinal T-id to the exact exempted {section, line, stats}
  // it judged, so the entry states WHAT it refers to, not just a verdict.
  const thresholdSession = thresholdAssessments.map((a) =>
    `threshold assessment ${a.id}: ${a.decision}; line_hash=${thresholdLineHash(a) ?? 'none'}; evidence_hash=${thresholdEvidenceHash(a) ?? 'none'}`,
  );
  // RECOVERY LINEAGE IS SEALED, not decoration. The UI named a source receipt that
  // existed only as a top-level report field, so editing the displayed lineage would
  // not have changed receipt_id — a claim about which receipt this one descends from,
  // outside the hash that is supposed to cover it (audit 2026-08-05). These lines ride
  // session_log, which receipt_id already covers, so no pack field is added.
  const recoverySession = recoveryOf
    ? [
        `recovery of run: ${recoveryOf.sourceRunId ?? 'not recorded'}`,
        `recovery source receipt: ${recoveryOf.sourceReceiptId ?? 'none sealed by the source run'}`,
        `recovery candidate: ${recoveryOf.parkedSha ?? 'not recorded'}`,
        `recovery sha provenance: ${recoveryOf.shaProvenance ?? 'not recorded'}`,
        // Sealed because the UI's "source review linked" wording is a claim ABOUT
        // ANOTHER RECEIPT. Read from the mutable report field it could be edited to
        // imply a review that was never sealed.
        `recovery source receipt status: ${recoveryOf.sourceReceiptStatus ?? 'not checked'}`,
        `recovery source audit: ${recoveryOf.sourceAudit ?? 'none recorded'}`,
      ]
    : [];

  const pack = {
    schemaVersion: 2,
    goal,
    acceptance_contract: acceptanceContract,
    artifact: lane === 'build'
      ? { kind: 'code', repo: targetPath, head, diff_hash: null, changed_files: null, deliverable_hash: null, claims: null, contract_coverage: null }
      : { kind: 'research', repo: null, head: null, diff_hash: null, changed_files: null, deliverable_hash: deliverable == null ? null : hashText(deliverable), claims, contract_coverage: contractCoverage },
    // A green is only as good as the command that produced it, so the explicit
    // per-run verify command is SEALED here (receipt_id covers it): a receipt that
    // says "verified" now also says what was run to earn that. null means no
    // explicit command was in force and verify.py auto-detected the stack — an
    // absence, never a claim about which checks it chose.
    verification: { command: verifyCommand == null ? null : String(verifyCommand), checks: verificationChecks(evidence) },
    session_log: [...ids.session, ...recoverySession, ...claimSession, ...coverageSession, ...thresholdSession],
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
