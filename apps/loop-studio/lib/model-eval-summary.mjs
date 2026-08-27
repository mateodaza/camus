// Read-only aggregation for sealed model-evaluation receipts. Results are
// grouped only inside one campaign generation and judge screen. This module
// reports evidence; it never chooses a model or changes routing defaults.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualityFloorPassed } from './comparison.mjs';

const median = (values) => {
  const rows = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2);
};

function usage(rows, key) {
  const values = (rows ?? []).map((row) => row?.usage?.[key]).filter((value) => Number.isInteger(value) && value >= 0);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function duration(rows) {
  const values = (rows ?? []).map((row) => row?.duration_ms).filter((value) => Number.isInteger(value) && value >= 0);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function sumKnown(values) {
  const observed = values.filter((value) => Number.isInteger(value) && value >= 0);
  return observed.length ? observed.reduce((total, value) => total + value, 0) : null;
}

function requestedSeat(report, role) {
  const seat = report?.models?.[role];
  return seat?.backend && seat?.model ? `${seat.backend}:${seat.model}` : null;
}

function actualIdentities(report, role) {
  if (role === 'maker') return (report?.makerActualModels ?? []).filter(Boolean);
  return (report?.evidence?.rounds ?? []).map((round) => round.reviewerIdentity).filter(Boolean);
}

function judgeForScreen(campaign, screen) {
  const requested = `${screen.reviewer.backend}:${screen.reviewer.model}`;
  return campaign.calibration.judges.find((judge) => `${judge.backend}:${judge.model}` === requested) ?? null;
}

function screenForReport(campaign, report) {
  const reviewer = report?.models?.reviewer;
  return campaign.independence.judgeScreens.find((screen) => (
    reviewer?.backend === screen.reviewer.backend
    && reviewer?.model === screen.reviewer.model
    && (reviewer?.effort ?? null) === (screen.reviewer.effort ?? null)
  )) ?? null;
}

export function summarizeEvaluationReports(campaign, configHash, reports, calibrationSummary, { profile = null, qualityFloor = qualityFloorPassed } = {}) {
  const groups = new Map();
  let ignored = 0;
  for (const report of reports) {
    if (!report || report.simulated === true || report.evaluationCampaignId !== campaign.id || report.evaluationConfigHash !== configHash) {
      ignored += 1;
      continue;
    }
    if (profile && report.evaluationProfile !== profile) continue;
    const candidate = campaign.candidates.find((entry) => requestedSeat(report, 'maker') === `${entry.backend}:${entry.model}`);
    const screen = screenForReport(campaign, report);
    const profileDef = campaign.profiles.find((entry) => entry.id === report.evaluationProfile);
    const caseDef = profileDef?.cases.find((entry) => entry.id === report.evaluationCaseId);
    if (!candidate || !screen || !profileDef || !caseDef || !screen.eligibleMakerProviders.includes(candidate.provider)) {
      ignored += 1;
      continue;
    }
    const key = `${profileDef.id}\u0000${screen.id}\u0000${candidate.id}`;
    if (!groups.has(key)) groups.set(key, { candidate, screen, profile: profileDef, rows: [] });
    const precheck = report.evidence?.verify?.find((entry) => entry.source === 'evaluation_case_precheck')?.pass ?? null;
    const humanInterventions = Array.isArray(report.answers) ? report.answers.length : 0;
    const floorPass = precheck === true && humanInterventions === 0 && qualityFloor(report.evidencePack);
    const makerRows = report.makerUsage ?? [];
    const reviewRows = report.evidence?.rounds ?? [];
    const latestReview = reviewRows.at(-1) ?? null;
    const findings = latestReview?.findings ?? [];
    const makerInputTokens = usage(makerRows, 'input_tokens');
    const makerOutputTokens = usage(makerRows, 'output_tokens');
    const reviewerInputTokens = usage(reviewRows, 'input_tokens');
    const reviewerOutputTokens = usage(reviewRows, 'output_tokens');
    groups.get(key).rows.push({
      runId: report.id,
      caseId: caseDef.id,
      status: report.status,
      precheck,
      floorPass,
      audit: report.statuses?.audit ?? null,
      reviewVerdict: latestReview?.verdict ?? null,
      findingCount: latestReview ? findings.length : null,
      materialFindingCount: findings.filter((finding) => ['medium', 'high'].includes(finding.severity)).length,
      humanInterventions,
      wallDurationMs: Number.isFinite(report.endedAt) && Number.isFinite(report.startedAt) ? report.endedAt - report.startedAt : null,
      makerDurationMs: duration(makerRows),
      reviewerDurationMs: duration(reviewRows),
      makerInputTokens,
      makerOutputTokens,
      reviewerInputTokens,
      reviewerOutputTokens,
      totalObservedTokens: sumKnown([makerInputTokens, makerOutputTokens, reviewerInputTokens, reviewerOutputTokens]),
      makerActuals: actualIdentities(report, 'maker'),
      reviewerActuals: actualIdentities(report, 'reviewer'),
    });
  }

  const calibrationById = new Map((calibrationSummary?.judges ?? []).map((judge) => [judge.id, judge]));
  const summaries = [...groups.values()].map(({ candidate, screen, profile: profileDef, rows }) => {
    const judge = judgeForScreen(campaign, screen);
    const judgeCalibration = judge ? calibrationById.get(judge.id) ?? null : null;
    const distinctCases = [...new Set(rows.map((row) => row.caseId))].sort();
    const requiredDistinctCases = Math.min(
      profileDef.cases.length,
      campaign.controls.minimumExplorationTrialsPerArm,
    );
    const reviewerCandidate = campaign.candidates.find((entry) => (
      entry.backend === screen.reviewer.backend && entry.model === screen.reviewer.model
    ));
    const reviewerProvider = reviewerCandidate?.provider
      ?? ({ claude: 'anthropic', codex: 'openai' }[screen.reviewer.backend] ?? screen.reviewer.backend);
    const expectedMakerIdentity = `${candidate.provider}:${candidate.model}`;
    const expectedReviewerIdentity = `${reviewerProvider}:${screen.reviewer.model}`;
    const identityStable = rows.length > 0
      && rows.every((row) => row.makerActuals.length > 0 && row.reviewerActuals.length > 0)
      && rows.every((row) => row.makerActuals.every((identity) => identity === expectedMakerIdentity))
      && rows.every((row) => row.reviewerActuals.every((identity) => identity === expectedReviewerIdentity));
    let recommendationStanding = 'routing_eligible';
    if (candidate.evidenceEligibility === 'exploratory_only') recommendationStanding = 'exploratory_only';
    else if (rows.length < campaign.controls.minimumExplorationTrialsPerArm || distinctCases.length < requiredDistinctCases) recommendationStanding = 'insufficient_exploration';
    else if (rows.some((row) => !row.floorPass)) recommendationStanding = 'quality_floor_not_met';
    else if (judgeCalibration?.standing !== 'calibrated') recommendationStanding = 'uncalibrated_judge';
    else if (!identityStable) recommendationStanding = 'identity_unstable';
    else if (rows.length < campaign.controls.minimumRoutingTrialsPerArm) recommendationStanding = 'insufficient_routing_trials';
    else if (distinctCases.length < profileDef.cases.length) recommendationStanding = 'incomplete_case_coverage';
    return {
      profile: profileDef.id,
      candidate: candidate.id,
      screen: screen.id,
      priorityTarget: candidate.priority.includes(profileDef.id),
      evidenceEligibility: candidate.evidenceEligibility,
      recommendationStanding,
      judgeCalibration: judgeCalibration?.standing ?? 'uncalibrated',
      identityStable,
      expectedMakerIdentity,
      expectedReviewerIdentity,
      trials: rows.length,
      distinctCases,
      requiredDistinctCases,
      qualityFloorPasses: rows.filter((row) => row.floorPass).length,
      deterministicPrecheckFailures: rows.filter((row) => row.precheck === false).length,
      trialsWithHumanIntervention: rows.filter((row) => row.humanInterventions > 0).length,
      reviewedTrials: rows.filter((row) => row.findingCount !== null).length,
      approvedTrials: rows.filter((row) => row.reviewVerdict === 'APPROVED').length,
      approvedWithLowOnlyTrials: rows.filter((row) => row.reviewVerdict === 'APPROVED' && row.materialFindingCount === 0).length,
      materialFindingTrials: rows.filter((row) => row.materialFindingCount > 0).length,
      trialsWithFindings: rows.filter((row) => (row.findingCount ?? 0) > 0).length,
      medianWallDurationMs: median(rows.map((row) => row.wallDurationMs)),
      medianMakerDurationMs: median(rows.map((row) => row.makerDurationMs)),
      medianReviewerDurationMs: median(rows.map((row) => row.reviewerDurationMs)),
      medianMakerInputTokens: median(rows.map((row) => row.makerInputTokens)),
      medianMakerOutputTokens: median(rows.map((row) => row.makerOutputTokens)),
      medianReviewerInputTokens: median(rows.map((row) => row.reviewerInputTokens)),
      medianReviewerOutputTokens: median(rows.map((row) => row.reviewerOutputTokens)),
      medianTotalObservedTokens: median(rows.map((row) => row.totalObservedTokens)),
      makerActuals: [...new Set(rows.flatMap((row) => row.makerActuals))].sort(),
      reviewerActuals: [...new Set(rows.flatMap((row) => row.reviewerActuals))].sort(),
      runs: rows,
    };
  }).sort((a, b) => a.profile.localeCompare(b.profile) || a.screen.localeCompare(b.screen) || a.candidate.localeCompare(b.candidate));

  return {
    campaignId: campaign.id,
    evaluationConfigHash: configHash,
    campaignStanding: campaign.standing,
    crossScreenRanking: calibrationSummary?.crossScreenRanking ?? 'refused_uncalibrated',
    ignoredReports: ignored,
    groups: summaries,
  };
}

export function loadEvaluationReports(runsDir) {
  const reports = [];
  let unreadableReports = 0;
  let entries = [];
  try { entries = readdirSync(runsDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { reports, unreadableReports };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { reports.push(JSON.parse(readFileSync(join(runsDir, entry.name, 'report.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') unreadableReports += 1; }
  }
  return { reports, unreadableReports };
}
