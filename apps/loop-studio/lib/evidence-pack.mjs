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
import { buildSeatIdentitySealed, qualificationForSeat, resolveSeatIdentityFacts } from './identity.mjs';

const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
const named = (provider, value) => `${provider}:${value || 'not-recorded'}`;
const providerOf = (value) => String(value).split(':')[0];

// The requested/resolved seat label. A built-in backend (claude/codex) is
// prefixed by the BACKEND name: the seat decision names the backend, and
// §10.8.4 rule 7 selects the builtin1 qualification namespace by exactly this
// claude|codex prefix (never executor_kind — a Codex custom-provider seat is
// codex_cli too and must seal qual1). A configurable backend uses its provider.
const seatLabel = (facts, model) => {
  const prefix = facts?.backend === 'claude' || facts?.backend === 'codex'
    ? facts.backend
    : (facts?.provider || 'unknown');
  return `${prefix}:${model || 'not-recorded'}`;
};
const vendorManagedBuiltin = (facts) =>
  (facts?.backend === 'claude' || facts?.backend === 'codex') && facts?.transport === 'vendor_managed';

// The evidence class behind a seat's `actual`: a built-in CLI seat is observed
// through CLI events, a configurable backend through its API response, and a
// scripted/no-model seat observed nothing.
const ACTUAL_EVIDENCE = new Set(['observed_api_response', 'observed_cli_event', 'asserted_pin', 'mapped_by_operator_docs']);
function actualEvidenceFor({ simulated, noModel, evidenceClass }) {
  if (simulated || noModel) return 'none';
  return ACTUAL_EVIDENCE.has(evidenceClass) ? evidenceClass : 'asserted_pin';
}

// A nonempty gateway:<name> inference_operator yields <name>; anything else null.
function gatewayName(inferenceOperator) {
  const m = /^gateway:(.+)$/.exec(inferenceOperator ?? '');
  return m ? m[1] : null;
}

const ORIGIN_FOR_LINEAGE = Object.freeze({
  registry: 'verified_operator',
  operator_declared: 'operator_declared',
  unknown: 'unknown',
});
const identityKnown = (facts) => facts
  && facts.trainingOrg !== 'unknown'
  && facts.modelFamily !== 'unknown'
  && facts.lineage?.source !== 'unknown';
const familyLineage = (facts) => new Set([facts?.modelFamily, facts?.lineage?.derivedFrom].filter(Boolean));
const setsIntersect = (left, right) => [...left].some((value) => right.has(value));

// §10.8.1 → pairing.independence. The governing round's fact (the 3-value engine
// vocabulary) maps EXPLICITLY and visibly to the sealed vocabulary so status-dims
// and the seal agree: same_vendor → same_vendor_advisory. A rehearsal claims
// nothing. A pre-seats/legacy round with no fact falls back to the audit standing
// (which status-dims derived from the same absent fact), keeping the two agreed.
function packIndependence({ roundIndependence, simulated, audit }) {
  if (simulated) return 'none';
  if (roundIndependence === 'cross_vendor') return 'cross_vendor';
  if (roundIndependence === 'cross_vendor_declared') return 'cross_vendor_declared';
  if (roundIndependence === 'same_vendor') return 'same_vendor_advisory';
  if (audit === 'independent_clean' || audit === 'independent_findings') return 'cross_vendor';
  if (audit === 'declared_clean' || audit === 'declared_findings') return 'cross_vendor_declared';
  if (audit === 'advisory_clean' || audit === 'advisory_findings') return 'same_vendor_advisory';
  return 'none';
}

// Envelope 2 can express only the original three-way pairing contract. A
// declared cross-organization pair therefore stays reviewed but advisory; it
// must never be squeezed into the stronger legacy cross_vendor label.
function legacyIndependence(independence) {
  if (independence === 'cross_vendor') return 'cross_vendor';
  if (independence === 'same_vendor_advisory' || independence === 'cross_vendor_declared') return 'same_vendor_advisory';
  return 'none';
}

function legacyStatuses(statuses, independence) {
  let audit = statuses?.audit;
  if (audit === 'declared_clean') audit = 'advisory_clean';
  if (audit === 'declared_findings') audit = 'advisory_findings';
  if (independence === 'same_vendor_advisory' && audit === 'independent_clean') audit = 'advisory_clean';
  if (independence === 'same_vendor_advisory' && audit === 'independent_findings') audit = 'advisory_findings';
  return { ...statuses, schemaVersion: 1, audit };
}

// Pairing v1 named providers, not backends. Keep that published meaning for a
// compatibility envelope even though pairing v2 deliberately names the exact
// built-in backend (claude/codex) for builtin1 namespace validation.
function legacyRoleIdentity(identity, facts, model) {
  if (identity.requested === NO_MODEL_IDENTITY) return { ...identity };
  const requested = named(facts?.provider || providerOf(identity.requested) || 'unknown', model);
  return { requested, resolved: requested, actual: identity.actual };
}

// A verification-only recovery runs NO model. Left to the legacy defaults below it
// sealed `anthropic:not-recorded` / `unknown:not-recorded`, which reads as "a run
// that used those vendors and lost the observation" — inventing provider provenance
// for a run that had none by construction (audit 2026-08-05). A zero-model run says
// so, in a token that names no vendor.
export const NO_MODEL_IDENTITY = 'none:no-model-run';
const noModelQualification = () => ({
  // Envelope 3 requires the non-null qualification shape even when there was no
  // seat to qualify. This sentinel binds that absence only; it is never offered
  // by seat admission and makes no capability claim about a model.
  fingerprint: `qual1:${createHash('sha256').update(`no-model\0${NO_MODEL_IDENTITY}`, 'utf8').digest('hex')}`,
  gate_scope: null,
  contract_version: null,
});
const isModelFreeRun = (models) => models?.recovery === true
  && (models?.maker ?? null) === null && (models?.reviewer ?? null) === null;

function actuals({ lane, evidence, models, makerActualModels = [], simulated, makerFacts, reviewerFacts }) {
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
  const requestedExecutor = seatLabel(makerFacts, models?.maker?.model);
  const requestedAuditor = seatLabel(reviewerFacts, models?.reviewer?.model);
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
  // `actual` is the OBSERVED identity, provider-qualified (anthropic/openai/…) —
  // distinct from requested/resolved, which name the seat DECISION (backend-
  // prefixed for a built-in). With no observation the fallback is the provider-
  // qualified requested model, never the backend-prefixed decision label.
  const executorActual = lane === 'build'
    ? named('anthropic', final)
    : makerActualModels.at(-1) ?? named(makerFacts?.provider || 'anthropic', models?.maker?.model);
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
  makerActualEvidence = null,
  makerReportedModel = null,
  simulated = false,
  verifyCommand = null,
  recoveryOf = null,
  createdAt = Date.now(),
}) {
  const noModel = isModelFreeRun(models);
  // Both seats are read through the ONE resolver engine.mjs used to derive the
  // round's independence fact, so the seal can never disagree with the round
  // about a seat's lineage. A no-model recovery has no seats — its identity
  // fields are honestly unknown, and its qualification is a non-seat sentinel
  // over that absence so the required shape makes no model-capability claim.
  const makerFacts = noModel ? null : resolveSeatIdentityFacts(models?.maker, { backend: 'claude', provider: 'anthropic' });
  const reviewerFacts = noModel ? null : resolveSeatIdentityFacts(models?.reviewer, { backend: 'codex', provider: 'openai' });
  const ids = actuals({ lane, evidence, models, makerActualModels, simulated, makerFacts, reviewerFacts });

  // The governing audit round — the one whose reviewerIdentity became the
  // auditor.actual — supplies the independence fact, the accepted qualification,
  // and the scope it ran at (all recorded by engine.mjs's reviewPairingFacts).
  const auditRound = (evidence?.rounds ?? []).filter((r) => r.reviewerModel || r.independence).at(-1) ?? null;
  const audit = statuses?.audit;
  const independence = packIndependence({ roundIndependence: auditRound?.independence ?? null, simulated, audit });
  const reviewScope = auditRound?.review_scope ?? null;
  const reviewContractVersion = auditRound?.qualification?.contract_version
    ?? auditRound?.review_contract_version
    ?? models?.reviewer?.qualification?.contract_version
    ?? null;
  const executorQualification = noModel ? noModelQualification() : qualificationForSeat({
    backend: makerFacts?.backend,
    transport: makerFacts?.transport,
    accepted: models?.maker?.qualification ?? null,
  });
  const auditorQualification = noModel ? noModelQualification() : qualificationForSeat({
    backend: reviewerFacts?.backend,
    transport: reviewerFacts?.transport,
    accepted: auditRound?.qualification ?? models?.reviewer?.qualification ?? null,
    gateScope: reviewScope,
    contractVersion: reviewContractVersion,
  });
  const makerEvidenceClass = makerActualEvidence ?? evidence?.gateReport?.modelActualEvidence ?? null;
  const auditorEvidenceClass = auditRound?.reviewerActualEvidence ?? null;
  const customObservationReady = (facts, evidenceClass) =>
    noModel || simulated || vendorManagedBuiltin(facts) || ACTUAL_EVIDENCE.has(evidenceClass);
  // Slice A publishes v3 for runs whose new evidence is genuinely available.
  // Two pre-existing paths do not have that evidence yet: configurable seats
  // before slice-C qual1/adapter observation plumbing, and the build gate before
  // slice-F scope + review-contract binding. They stay readable and runnable on
  // the frozen v2 envelope instead of inventing trust or failing the run.
  const gateBindingReady = lane !== 'build' || noModel
    || (['full', 'light'].includes(reviewScope) && typeof reviewContractVersion === 'string' && reviewContractVersion.length > 0);
  const produceV3 = executorQualification !== null
    && auditorQualification !== null
    && customObservationReady(makerFacts, makerEvidenceClass)
    && customObservationReady(reviewerFacts, auditorEvidenceClass)
    && gateBindingReady;

  // §10 rule-7 seal-time guard, mirroring the validator's semantic cross-checks
  // (Task 6). It throws — deriving from recorded facts — rather than adjusting,
  // so a run whose recorded lineage contradicts its independence claim degrades
  // its receipt here, before validateEvidencePack runs the same rules again.
  if (produceV3) for (const [role, facts] of [['executor', makerFacts], ['auditor', reviewerFacts]]) {
    if (!facts) continue;
    const expected = ORIGIN_FOR_LINEAGE[facts.lineage?.source];
    if (facts.originConfidence !== expected) {
      throw new TypeError(`${role} lineage.source ${facts.lineage?.source} requires origin_confidence ${expected}`);
    }
  }
  if (produceV3 && ['independent_clean', 'independent_findings'].includes(audit) && independence !== 'cross_vendor') {
    throw new TypeError('independent audit standing conflicts with the recorded pairing independence');
  }
  if (produceV3 && ['declared_clean', 'declared_findings'].includes(audit) && independence !== 'cross_vendor_declared') {
    throw new TypeError('declared audit standing conflicts with the recorded pairing independence');
  }
  if (produceV3 && ['advisory_clean', 'advisory_findings'].includes(audit) && independence !== 'same_vendor_advisory') {
    throw new TypeError('advisory audit standing conflicts with the recorded pairing independence');
  }
  if (produceV3 && independence === 'cross_vendor') {
    const ep = providerOf(ids.executor.actual);
    const ap = providerOf(ids.auditor.actual);
    if (['unknown', 'none'].includes(ep) || ['unknown', 'none'].includes(ap) || ep === ap) {
      throw new TypeError('cross_vendor conflicts with the recorded executor/auditor actual providers');
    }
    if (makerFacts?.originConfidence !== 'verified_operator' || reviewerFacts?.originConfidence !== 'verified_operator') {
      throw new TypeError('cross_vendor requires both seats at verified_operator origin_confidence');
    }
    if (!identityKnown(makerFacts) || !identityKnown(reviewerFacts)) throw new TypeError('cross_vendor requires known training_org, model_family, and lineage.source on both seats');
    if (makerFacts.trainingOrg === reviewerFacts.trainingOrg) throw new TypeError('cross_vendor requires two known, different training organizations');
    if (setsIntersect(familyLineage(makerFacts), familyLineage(reviewerFacts))) throw new TypeError('cross_vendor requires disjoint family-lineage sets');
  }
  if (produceV3 && independence === 'cross_vendor_declared') {
    if (!identityKnown(makerFacts) || !identityKnown(reviewerFacts)) throw new TypeError('cross_vendor_declared requires known training_org, model_family, and lineage.source on both seats');
    if (makerFacts?.trainingOrg === reviewerFacts?.trainingOrg) throw new TypeError('cross_vendor_declared requires different training organizations');
    const anyDeclared = makerFacts?.originConfidence === 'operator_declared' || reviewerFacts?.originConfidence === 'operator_declared';
    if (!anyDeclared) throw new TypeError('cross_vendor_declared requires at least one operator_declared seat');
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

  // §10.8.1 pairing v2: each seat seals its full identity — training lineage,
  // transport, and the qualification it ran under — as a seatIdentitySealed
  // record. The executor's qualification arrives through the run snapshot, the
  // auditor's through the governing round event (two mechanical channels). The
  // scope the round ran at (review_scope) rides the round's binding channel,
  // sourced INDEPENDENTLY of the qualification block so the §10.8.4 cross-check
  // compares two channels no single writer controls.
  const executorSeat = produceV3 ? buildSeatIdentitySealed({
    requested: ids.executor.requested,
    resolved: ids.executor.resolved,
    actual: ids.executor.actual,
    reported: makerReportedModel ?? evidence?.gateReport?.reportedModel ?? null,
    actualEvidence: actualEvidenceFor({ simulated, noModel, evidenceClass: makerEvidenceClass }),
    executorKind: makerFacts?.executor ?? 'none',
    trainingOrg: makerFacts?.trainingOrg ?? 'unknown',
    modelFamily: makerFacts?.modelFamily ?? 'unknown',
    lineage: { source: makerFacts?.lineage?.source ?? 'unknown', derivedFrom: makerFacts?.lineage?.derivedFrom ?? null },
    inferenceOperator: makerFacts?.inferenceOperator ?? 'unknown',
    transport: makerFacts?.transport ?? 'vendor_managed',
    connection: makerFacts?.connection ?? null,
    originConfidence: makerFacts?.originConfidence ?? 'unknown',
    qualification: executorQualification,
  }) : null;
  const auditorSeat = produceV3 ? buildSeatIdentitySealed({
    requested: ids.auditor.requested,
    resolved: ids.auditor.resolved,
    actual: ids.auditor.actual,
    reported: auditRound?.reviewerReportedModel ?? null,
    actualEvidence: actualEvidenceFor({ simulated, noModel, evidenceClass: auditorEvidenceClass }),
    executorKind: reviewerFacts?.executor ?? 'none',
    trainingOrg: reviewerFacts?.trainingOrg ?? 'unknown',
    modelFamily: reviewerFacts?.modelFamily ?? 'unknown',
    lineage: { source: reviewerFacts?.lineage?.source ?? 'unknown', derivedFrom: reviewerFacts?.lineage?.derivedFrom ?? null },
    inferenceOperator: reviewerFacts?.inferenceOperator ?? 'unknown',
    transport: reviewerFacts?.transport ?? 'vendor_managed',
    connection: reviewerFacts?.connection ?? null,
    originConfidence: reviewerFacts?.originConfidence ?? 'unknown',
    qualification: auditorQualification,
  }) : null;
  const execGateway = gatewayName(makerFacts?.inferenceOperator);
  const sharedGateway = execGateway !== null && execGateway === gatewayName(reviewerFacts?.inferenceOperator) ? execGateway : null;
  const legacyPairingIndependence = legacyIndependence(independence);
  const executorRole = produceV3 ? ids.executor : legacyRoleIdentity(ids.executor, makerFacts, models?.maker?.model);
  const auditorRole = produceV3 ? ids.auditor : legacyRoleIdentity(ids.auditor, reviewerFacts, models?.reviewer?.model);
  if (!produceV3 && legacyPairingIndependence === 'cross_vendor') {
    const ep = providerOf(executorRole.actual);
    const ap = providerOf(auditorRole.actual);
    if (['unknown', 'none'].includes(ep) || ['unknown', 'none'].includes(ap) || ep === ap) {
      throw new TypeError('independent audit standing conflicts with the recorded executor/auditor providers');
    }
  }
  const compatibilitySession = produceV3 ? [] : [
    'compatibility envelope v2: v3 admission, observation, or review-binding evidence was unavailable; no qualification or identity upgrade was sealed',
  ];

  const pack = {
    schemaVersion: produceV3 ? 3 : 2,
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
    session_log: [...ids.session, ...compatibilitySession, ...recoverySession, ...claimSession, ...coverageSession, ...thresholdSession],
    pairing: produceV3 ? {
      schemaVersion: 2,
      executor: executorSeat,
      auditor: auditorSeat,
      independence,
      shared_gateway: sharedGateway,
      review_scope: reviewScope,
    } : {
      schemaVersion: 1,
      executor: executorRole,
      auditor: auditorRole,
      independence: legacyPairingIndependence,
    },
    // Envelope 3 requires a status v2 interior; deriveStatusDimensions already
    // stamps STATUS_DIMS_VERSION 2, and re-stamping here keeps the envelope and
    // its interior in lockstep whatever the caller passed (§10.8.4).
    statuses: produceV3
      ? { ...statuses, schemaVersion: 2 }
      : legacyStatuses(statuses, legacyPairingIndependence),
    human_decisions: (evidence?.humanDecisions ?? []).map((d) => ({
      schemaVersion: 1,
      kind: ['decision', 'infra', 'stuck', 'verify', 'adjudication'].includes(d.kind) ? d.kind : 'decision',
      question: String(d.question ?? ''),
      answer: String(d.answer ?? ''),
      at: Number.isInteger(d.at) ? d.at : createdAt,
    })),
    economics: [
      {
        schemaVersion: 1, role: 'executor', ...executorRole,
        effort: null, fallback: null, usage: null,
        billing_mode: 'unknown', estimated_cost_usd: null, duration_ms: null,
      },
      {
        schemaVersion: 1, role: 'auditor', ...auditorRole,
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
