// Human labels are the authority for judge calibration. This module derives
// agreement from the raw artifact labels and constrained judge decisions; a
// configured string can never grade a judge up to calibrated standing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_JUDGE_CALIBRATION = join(__dirname, '..', 'checks', 'model-eval-judge-calibration.json');
const VERDICTS = new Set(['APPROVED', 'REVISE']);
const FINDING_PRESENCE = new Set(['clean', 'findings']);
const ARTIFACT_ID = /^sha256:[a-f0-9]{64}$/;

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function unique(rows, key, field) {
  if (!Array.isArray(rows)) throw new Error(`${field} must be an array`);
  const values = rows.map((row, index) => nonempty(row?.[key], `${field}[${index}].${key}`));
  if (new Set(values).size !== values.length) throw new Error(`${field}.${key} values must be unique`);
}

export function validateJudgeCalibration(value, campaign) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('judge calibration must be an object');
  if (value.schemaVersion !== 1) throw new Error('judge calibration schemaVersion must be 1');
  if (value.campaignId !== campaign.id) throw new Error('judge calibration campaignId does not match the active campaign');
  if (value.standing !== 'uncalibrated') throw new Error('judge calibration standing is derived; the file must remain uncalibrated');
  unique(value.artifacts, 'id', 'artifacts');
  const profileCases = new Set(campaign.profiles.flatMap((profile) => profile.cases.map((evaluationCase) => evaluationCase.id)));
  const artifacts = new Map();
  for (const [index, artifact] of value.artifacts.entries()) {
    if (!profileCases.has(artifact.caseId)) throw new Error(`artifacts[${index}].caseId is not registered`);
    if (!ARTIFACT_ID.test(artifact.id)) throw new Error(`artifacts[${index}].id must be a sha256 content id`);
    nonempty(artifact.sourceRunId, `artifacts[${index}].sourceRunId`);
    if (!VERDICTS.has(artifact.humanLabel?.verdict)) throw new Error(`artifacts[${index}].humanLabel.verdict is invalid`);
    if (!FINDING_PRESENCE.has(artifact.humanLabel?.findingPresence)) throw new Error(`artifacts[${index}].humanLabel.findingPresence is invalid`);
    nonempty(artifact.humanLabel?.labeledBy, `artifacts[${index}].humanLabel.labeledBy`);
    const labeledAt = nonempty(artifact.humanLabel?.labeledAt, `artifacts[${index}].humanLabel.labeledAt`);
    const labelDate = new Date(labeledAt);
    if (Number.isNaN(labelDate.valueOf()) || labelDate.toISOString() !== labeledAt) {
      throw new Error(`artifacts[${index}].humanLabel.labeledAt must be a canonical ISO timestamp`);
    }
    artifacts.set(artifact.id, artifact);
  }
  if (!Array.isArray(value.judgeRuns)) throw new Error('judgeRuns must be an array');
  const judgeIds = new Set(campaign.calibration.judges.map((judge) => judge.id));
  const runKeys = new Set();
  for (const [index, run] of value.judgeRuns.entries()) {
    if (!artifacts.has(run.artifactId)) throw new Error(`judgeRuns[${index}].artifactId is unknown`);
    if (!judgeIds.has(run.judgeId)) throw new Error(`judgeRuns[${index}].judgeId is not registered`);
    if (!VERDICTS.has(run.verdict)) throw new Error(`judgeRuns[${index}].verdict is invalid`);
    if (!FINDING_PRESENCE.has(run.findingPresence)) throw new Error(`judgeRuns[${index}].findingPresence is invalid`);
    nonempty(run.sourceRunId, `judgeRuns[${index}].sourceRunId`);
    const key = `${run.artifactId}\u0000${run.judgeId}`;
    if (runKeys.has(key)) throw new Error('judgeRuns may contain only one decision per artifact and judge');
    runKeys.add(key);
  }
  return value;
}

export function summarizeJudgeCalibration(campaign, value) {
  validateJudgeCalibration(value, campaign);
  const artifacts = new Map(value.artifacts.map((artifact) => [artifact.id, artifact]));
  const runsByJudge = new Map(campaign.calibration.judges.map((judge) => [judge.id, new Map()]));
  for (const run of value.judgeRuns) runsByJudge.get(run.judgeId).set(run.artifactId, run);
  const minimum = campaign.calibration.minimumHumanLabeledArtifacts;
  const threshold = campaign.calibration.minimumAgreement;
  const agreement = (judgeId, artifactIds) => {
    let verdictMatches = 0;
    let findingMatches = 0;
    let jointMatches = 0;
    for (const artifactId of artifactIds) {
      const human = artifacts.get(artifactId).humanLabel;
      const observed = runsByJudge.get(judgeId).get(artifactId);
      const verdictMatch = observed.verdict === human.verdict;
      const findingMatch = observed.findingPresence === human.findingPresence;
      if (verdictMatch) verdictMatches += 1;
      if (findingMatch) findingMatches += 1;
      if (verdictMatch && findingMatch) jointMatches += 1;
    }
    const count = artifactIds.length;
    const jointAgreement = count ? jointMatches / count : null;
    return {
      count,
      verdictAgreement: count ? verdictMatches / count : null,
      findingPresenceAgreement: count ? findingMatches / count : null,
      jointAgreement,
      standing: count >= minimum && jointAgreement >= threshold ? 'calibrated' : 'uncalibrated',
    };
  };
  const judges = campaign.calibration.judges.map((judge) => {
    const labeledArtifactIds = [...artifacts.keys()].filter((artifactId) => runsByJudge.get(judge.id).has(artifactId));
    const result = agreement(judge.id, labeledArtifactIds);
    return {
      id: judge.id,
      seat: `${judge.backend}:${judge.model}`,
      labeledArtifacts: result.count,
      verdictAgreement: result.verdictAgreement,
      findingPresenceAgreement: result.findingPresenceAgreement,
      jointAgreement: result.jointAgreement,
      standing: result.standing,
    };
  });
  const judgeIdBySeat = new Map(campaign.calibration.judges.map((judge) => [`${judge.backend}:${judge.model}`, judge.id]));
  const screenJudgeIds = [...new Set(campaign.independence.judgeScreens.map((screen) => (
    judgeIdBySeat.get(`${screen.reviewer.backend}:${screen.reviewer.model}`)
  )))];
  const sharedArtifactIds = [...artifacts.keys()].filter((artifactId) => (
    screenJudgeIds.every((judgeId) => runsByJudge.get(judgeId).has(artifactId))
  ));
  const screenJudgesCalibrated = screenJudgeIds.length >= 2 && screenJudgeIds.every((judgeId) => (
    agreement(judgeId, sharedArtifactIds).standing === 'calibrated'
  ));
  return {
    campaignId: campaign.id,
    minimumHumanLabeledArtifacts: minimum,
    minimumAgreement: threshold,
    humanLabeledArtifacts: artifacts.size,
    sharedArtifacts: sharedArtifactIds.length,
    judges,
    crossScreenRanking: screenJudgesCalibrated ? 'eligible' : 'refused_uncalibrated',
  };
}

export function loadJudgeCalibration(campaign, path = join(__dirname, '..', campaign.calibration.labelsFile)) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot read judge calibration: ${error.message}`); }
  return { value: validateJudgeCalibration(value, campaign), summary: summarizeJudgeCalibration(campaign, value) };
}
