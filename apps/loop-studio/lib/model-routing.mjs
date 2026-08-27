// Evidence-gated, opt-in task-class routing. A route is derived from one exact
// campaign generation and the local admission catalog. Missing evidence never
// changes the operator's selected pairing.

import { createHash } from 'node:crypto';

const TASK_CLASSES = new Set(['simple', 'balanced', 'difficult']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const QUALIFICATION = /^(?:qual1|builtin1):[a-f0-9]{64}$/;

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function classifyTaskClass({ taskClass = null, lane = 'freeform', depth = 'standard' } = {}) {
  if (taskClass !== null) {
    if (!TASK_CLASSES.has(taskClass)) throw new Error('taskClass must be simple, balanced, or difficult');
    return { taskClass, source: 'explicit' };
  }
  if (lane === 'build') return { taskClass: null, source: 'build_gate_fixed' };
  if (depth === 'quick') return { taskClass: 'simple', source: 'depth_policy' };
  if (depth === 'deep') return { taskClass: 'difficult', source: 'depth_policy' };
  return { taskClass: 'balanced', source: 'depth_policy' };
}

function admitted(entries, backend, model) {
  return (entries ?? []).find((entry) => entry.backend === backend && entry.model === model
    && entry.admission?.qualified === true) ?? null;
}

function admissionEvidence(entry, expectedSeatType) {
  const fingerprint = entry?.admission?.fingerprint;
  if (typeof fingerprint !== 'string' || !QUALIFICATION.test(fingerprint)
      || entry?.admission?.seatType !== expectedSeatType) return null;
  return {
    fingerprint,
    seatType: entry.admission.seatType ?? null,
    expiresAt: entry.admission.expiresAt ?? null,
  };
}

function exactStrings(values, expected) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => value === expected);
}

function routeRank(group) {
  return [
    group.medianWallDurationMs === null ? 1 : 0,
    group.medianWallDurationMs ?? Number.MAX_SAFE_INTEGER,
    group.medianTotalObservedTokens === null ? 1 : 0,
    group.medianTotalObservedTokens ?? Number.MAX_SAFE_INTEGER,
    group.candidate,
    group.screen,
  ];
}

function compareRank(left, right) {
  const a = routeRank(left);
  const b = routeRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export function deriveAutomaticRoute({ campaign, summary, calibrationSummary, catalog, taskClass }) {
  if (!TASK_CLASSES.has(taskClass)) return { routed: false, reason: 'task_class_unavailable' };
  if (campaign.controls?.routingMode !== 'opt_in') return { routed: false, reason: 'routing_not_opt_in' };
  if (summary?.campaignId !== campaign.id
      || summary?.evaluationConfigHash !== digest(campaign)
      || calibrationSummary?.campaignId !== campaign.id) {
    return { routed: false, reason: 'evidence_generation_mismatch' };
  }
  if (calibrationSummary?.crossScreenRanking !== 'eligible') {
    return { routed: false, reason: 'human_calibration_incomplete' };
  }
  const minimumLabels = campaign.calibration?.minimumHumanLabeledArtifacts;
  const judgeIds = calibrationSummary.screenJudgeIds;
  const judgeActuals = calibrationSummary.screenActualIdentities;
  const judgeRunIds = calibrationSummary.screenJudgeRunIds;
  const calibrationReady = SHA256.test(calibrationSummary.calibrationDigest ?? '')
    && SHA256.test(calibrationSummary.screenEvidenceDigest ?? '')
    && Number.isInteger(minimumLabels) && minimumLabels > 0
    && calibrationSummary.sharedArtifacts >= minimumLabels
    && Array.isArray(calibrationSummary.sharedArtifactIds)
    && calibrationSummary.sharedArtifactIds.length === calibrationSummary.sharedArtifacts
    && Array.isArray(judgeIds) && new Set(judgeIds).size >= 2
    && Array.isArray(judgeActuals) && new Set(judgeActuals).size >= 2
    && Array.isArray(judgeRunIds)
    && new Set(judgeRunIds).size >= minimumLabels * new Set(judgeIds).size;
  if (!calibrationReady) return { routed: false, reason: 'human_calibration_incomplete' };
  const candidates = new Map(campaign.candidates.map((candidate) => [candidate.id, candidate]));
  const screens = new Map(campaign.independence.judgeScreens.map((screen) => [screen.id, screen]));
  const profiles = new Map(campaign.profiles.map((profile) => [profile.id, profile]));
  const eligible = [];
  for (const group of summary.groups ?? []) {
    if (group.profile !== taskClass || group.recommendationStanding !== 'routing_eligible') continue;
    const candidate = candidates.get(group.candidate);
    const screen = screens.get(group.screen);
    const profile = profiles.get(group.profile);
    if (!candidate || !screen || !profile || candidate.evidenceEligibility === 'exploratory_only'
        || !screen.eligibleMakerProviders.includes(candidate.provider)) continue;
    const minimumTrials = campaign.controls.minimumRoutingTrialsPerArm;
    const caseIds = profile.cases.map((entry) => entry.id).sort();
    const observedCases = Array.isArray(group.distinctCases) ? [...new Set(group.distinctCases)].sort() : [];
    const runs = Array.isArray(group.runs) ? group.runs : [];
    const reviewerCandidate = campaign.candidates.find((entry) => (
      entry.backend === screen.reviewer.backend && entry.model === screen.reviewer.model
    ));
    const reviewerProvider = reviewerCandidate?.provider
      ?? ({ claude: 'anthropic', codex: 'openai' }[screen.reviewer.backend] ?? screen.reviewer.backend);
    const expectedMakerIdentity = `${candidate.provider}:${candidate.model}`;
    const expectedReviewerIdentity = `${reviewerProvider}:${screen.reviewer.model}`;
    const runIds = runs.map((run) => run.runId);
    const completeEvidence = Number.isInteger(group.trials) && group.trials >= minimumTrials
      && group.trials === runs.length
      && group.qualityFloorPasses === group.trials
      && group.identityStable === true
      && group.judgeCalibration === 'calibrated'
      && JSON.stringify(observedCases) === JSON.stringify(caseIds)
      && runIds.every((runId) => typeof runId === 'string' && runId)
      && new Set(runIds).size === runIds.length
      && runs.every((run) => run.floorPass === true
        && exactStrings(run.makerActuals, expectedMakerIdentity)
        && exactStrings(run.reviewerActuals, expectedReviewerIdentity));
    if (!completeEvidence) continue;
    const maker = admitted(catalog?.maker, candidate.backend, candidate.model);
    const reviewer = admitted(catalog?.reviewer, screen.reviewer.backend, screen.reviewer.model);
    const makerAdmission = admissionEvidence(maker, 'words_maker');
    const reviewerAdmission = admissionEvidence(reviewer, 'words_reviewer');
    if (!maker || !reviewer || !makerAdmission || !reviewerAdmission) continue;
    eligible.push({ group, candidate, screen, maker, reviewer, makerAdmission, reviewerAdmission });
  }
  if (!eligible.length) return { routed: false, reason: 'no_admitted_evidence_eligible_pairing' };
  eligible.sort((left, right) => compareRank(left.group, right.group));
  const winner = eligible[0];
  const evidence = {
    campaignId: campaign.id,
    evaluationConfigHash: summary.evaluationConfigHash,
    taskClass,
    candidate: winner.candidate.id,
    screen: winner.screen.id,
    trials: winner.group.trials,
    distinctCases: winner.group.distinctCases,
    judgeCalibration: winner.group.judgeCalibration,
    identityStable: winner.group.identityStable,
    runIds: winner.group.runs.map((run) => run.runId).sort(),
    makerAdmission: winner.makerAdmission,
    reviewerAdmission: winner.reviewerAdmission,
    calibration: {
      digest: calibrationSummary.calibrationDigest,
      screenEvidenceDigest: calibrationSummary.screenEvidenceDigest,
      sharedArtifactIds: [...calibrationSummary.sharedArtifactIds].sort(),
      judgeIds: [...judgeIds].sort(),
      actualIdentities: [...judgeActuals].sort(),
      runIds: [...judgeRunIds].sort(),
    },
    medianWallDurationMs: winner.group.medianWallDurationMs,
    medianTotalObservedTokens: winner.group.medianTotalObservedTokens,
  };
  const evidenceDigest = digest(evidence);
  return {
    routed: true,
    routeId: `route1:${evidenceDigest.slice('sha256:'.length)}`,
    taskClass,
    maker: { backend: winner.maker.backend, model: winner.maker.model },
    reviewer: {
      backend: winner.reviewer.backend,
      model: winner.reviewer.model,
      effort: winner.screen.reviewer.effort ?? null,
    },
    evidence: { ...evidence, digest: evidenceDigest },
    alternatives: eligible.length,
  };
}
