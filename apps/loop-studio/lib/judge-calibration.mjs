// Human labels are the authority for judge calibration. This module derives
// agreement from the raw artifact labels and constrained judge decisions; a
// configured string can never grade a judge up to calibrated standing.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_JUDGE_CALIBRATION = join(__dirname, '..', 'checks', 'model-eval-judge-calibration.json');
const VERDICTS = new Set(['APPROVED', 'REVISE']);
const FINDING_PRESENCE = new Set(['clean', 'findings']);
const ARTIFACT_ID = /^sha256:[a-f0-9]{64}$/;
const LABEL_AUTHORITIES = new Set(['human', 'expert_ai_proxy']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

export function calibrationLabelAuthority(label) {
  if (label?.authority) return label.authority;
  return label?.labeledBy?.startsWith('human:') ? 'human' : null;
}

export function judgeCalibrationPaths(generation = null) {
  const base = process.env.STUDIO_GRANDFATHER_DIR || join(homedir(), '.camus', 'studio');
  const requested = generation ?? process.env.STUDIO_JUDGE_CALIBRATION_GENERATION ?? null;
  if (requested !== null && (typeof requested !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requested))) {
    throw new Error('judge calibration generation must use 1-64 safe name characters');
  }
  const generationBase = requested ? join(base, 'judge-calibration', requested) : base;
  const value = process.env.STUDIO_JUDGE_CALIBRATION_FILE || join(generationBase, 'model-eval-judge-calibration.json');
  return {
    generation: requested,
    value,
    queue: process.env.STUDIO_JUDGE_CALIBRATION_QUEUE_FILE || join(generationBase, 'model-eval-calibration-queue.json'),
    artifactsDir: process.env.STUDIO_JUDGE_CALIBRATION_ARTIFACTS_DIR || join(generationBase, 'model-eval-calibration-artifacts'),
    receiptsDir: process.env.STUDIO_JUDGE_CALIBRATION_RECEIPTS_DIR || join(generationBase, 'model-eval-calibration-receipts'),
  };
}

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
    if (artifact.humanLabel.verdict === 'REVISE' && artifact.humanLabel.findingPresence !== 'findings') {
      throw new Error(`artifacts[${index}].humanLabel cannot revise without findings`);
    }
    const authority = calibrationLabelAuthority(artifact.humanLabel);
    if (!LABEL_AUTHORITIES.has(authority)) throw new Error(`artifacts[${index}].humanLabel.authority is invalid`);
    const labeledBy = nonempty(artifact.humanLabel?.labeledBy, `artifacts[${index}].humanLabel.labeledBy`);
    if (authority === 'human' && !labeledBy.startsWith('human:')) throw new Error(`artifacts[${index}].humanLabel human authority needs a human owner`);
    if (authority === 'expert_ai_proxy') {
      if (!labeledBy.startsWith('expert_ai_proxy:')) throw new Error(`artifacts[${index}].humanLabel proxy authority needs a proxy owner`);
      if (!nonempty(artifact.humanLabel?.delegatedBy, `artifacts[${index}].humanLabel.delegatedBy`).startsWith('human:')) {
        throw new Error(`artifacts[${index}].humanLabel proxy authority needs a human delegator`);
      }
    }
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
    if (run.verdict === 'REVISE' && run.findingPresence !== 'findings') {
      throw new Error(`judgeRuns[${index}] cannot revise without findings`);
    }
    nonempty(run.sourceRunId, `judgeRuns[${index}].sourceRunId`);
    nonempty(run.actualIdentity, `judgeRuns[${index}].actualIdentity`);
    const key = `${run.artifactId}\u0000${run.judgeId}`;
    if (runKeys.has(key)) throw new Error('judgeRuns may contain only one decision per artifact and judge');
    runKeys.add(key);
  }
  return value;
}

export function summarizeJudgeCalibration(campaign, value) {
  validateJudgeCalibration(value, campaign);
  const artifacts = new Map(value.artifacts.map((artifact) => [artifact.id, artifact]));
  const humanArtifactIds = [...artifacts.keys()].filter((artifactId) => calibrationLabelAuthority(artifacts.get(artifactId).humanLabel) === 'human');
  const proxyArtifactIds = [...artifacts.keys()].filter((artifactId) => calibrationLabelAuthority(artifacts.get(artifactId).humanLabel) === 'expert_ai_proxy');
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
    const actualIdentities = [...new Set(artifactIds.map((artifactId) => runsByJudge.get(judgeId).get(artifactId).actualIdentity))].sort();
    const identityStable = actualIdentities.length === 1;
    return {
      count,
      actualIdentities,
      identityStable,
      verdictAgreement: count ? verdictMatches / count : null,
      findingPresenceAgreement: count ? findingMatches / count : null,
      jointAgreement,
      standing: count >= minimum && jointAgreement >= threshold && identityStable ? 'calibrated' : 'uncalibrated',
    };
  };
  const judges = campaign.calibration.judges.map((judge) => {
    const labeledArtifactIds = humanArtifactIds.filter((artifactId) => runsByJudge.get(judge.id).has(artifactId));
    const result = agreement(judge.id, labeledArtifactIds);
    return {
      id: judge.id,
      seat: `${judge.backend}:${judge.model}`,
      labeledArtifacts: result.count,
      actualIdentities: result.actualIdentities,
      identityStable: result.identityStable,
      verdictAgreement: result.verdictAgreement,
      findingPresenceAgreement: result.findingPresenceAgreement,
      jointAgreement: result.jointAgreement,
      standing: result.standing,
    };
  });
  const proxyJudges = campaign.calibration.judges.map((judge) => {
    const labeledArtifactIds = proxyArtifactIds.filter((artifactId) => runsByJudge.get(judge.id).has(artifactId));
    const result = agreement(judge.id, labeledArtifactIds);
    return {
      id: judge.id,
      seat: `${judge.backend}:${judge.model}`,
      proxyArtifacts: result.count,
      actualIdentities: result.actualIdentities,
      identityStable: result.identityStable,
      verdictAgreement: result.verdictAgreement,
      findingPresenceAgreement: result.findingPresenceAgreement,
      jointAgreement: result.jointAgreement,
      standing: result.standing === 'calibrated' ? 'provisional_aligned' : 'unscored',
    };
  });
  const judgeIdBySeat = new Map(campaign.calibration.judges.map((judge) => [`${judge.backend}:${judge.model}`, judge.id]));
  const screenJudgeIds = [...new Set(campaign.independence.judgeScreens.map((screen) => (
    judgeIdBySeat.get(`${screen.reviewer.backend}:${screen.reviewer.model}`)
  )))];
  const sharedArtifactIds = humanArtifactIds.filter((artifactId) => (
    screenJudgeIds.every((judgeId) => runsByJudge.get(judgeId).has(artifactId))
  ));
  const proxySharedArtifactIds = proxyArtifactIds.filter((artifactId) => (
    screenJudgeIds.every((judgeId) => runsByJudge.get(judgeId).has(artifactId))
  ));
  const screenAgreements = screenJudgeIds.map((judgeId) => agreement(judgeId, sharedArtifactIds));
  const screenActualIdentities = new Set(screenAgreements.flatMap((result) => result.actualIdentities));
  const screenJudgesCalibrated = screenJudgeIds.length >= 2
    && screenAgreements.every((result) => result.standing === 'calibrated')
    && screenActualIdentities.size >= 2;
  const proxyScreensAligned = screenJudgeIds.length >= 2 && screenJudgeIds.every((judgeId) => (
    agreement(judgeId, proxySharedArtifactIds).standing === 'calibrated'
  ));
  const sharedSet = new Set(sharedArtifactIds);
  const screenRuns = value.judgeRuns.filter((run) => (
    screenJudgeIds.includes(run.judgeId) && sharedSet.has(run.artifactId)
  )).map((run) => ({
    artifactId: run.artifactId,
    judgeId: run.judgeId,
    sourceRunId: run.sourceRunId,
    actualIdentity: run.actualIdentity,
  })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const calibrationDigest = digest(value);
  const screenEvidenceDigest = digest({
    campaignId: campaign.id,
    calibrationDigest,
    artifactIds: [...sharedArtifactIds].sort(),
    judgeIds: [...screenJudgeIds].sort(),
    runs: screenRuns,
  });
  return {
    campaignId: campaign.id,
    calibrationDigest,
    screenEvidenceDigest,
    minimumHumanLabeledArtifacts: minimum,
    minimumAgreement: threshold,
    humanLabeledArtifacts: humanArtifactIds.length,
    proxyLabeledArtifacts: proxyArtifactIds.length,
    sharedArtifacts: sharedArtifactIds.length,
    sharedArtifactIds: [...sharedArtifactIds].sort(),
    proxySharedArtifacts: proxySharedArtifactIds.length,
    judges,
    screenJudgeIds: [...screenJudgeIds].sort(),
    screenActualIdentities: [...screenActualIdentities].sort(),
    screenJudgeRunIds: [...new Set(screenRuns.map((run) => run.sourceRunId))].sort(),
    proxyJudges,
    crossScreenRanking: screenJudgesCalibrated ? 'eligible' : 'refused_uncalibrated',
    proxyCrossScreenComparison: proxyScreensAligned ? 'provisional_eligible' : 'refused_unscored',
  };
}

export function loadJudgeCalibration(campaign, path = null) {
  const operatorPath = judgeCalibrationPaths(
    process.env.STUDIO_JUDGE_CALIBRATION_GENERATION ?? campaign.id,
  ).value;
  const trackedSeed = join(__dirname, '..', campaign.calibration.labelsFile);
  const resolvedPath = path ?? (existsSync(operatorPath) ? operatorPath : trackedSeed);
  let value;
  try { value = JSON.parse(readFileSync(resolvedPath, 'utf8')); }
  catch (error) { throw new Error(`cannot read judge calibration: ${error.message}`); }
  return {
    value: validateJudgeCalibration(value, campaign),
    summary: summarizeJudgeCalibration(campaign, value),
    path: resolvedPath,
    source: resolvedPath === trackedSeed ? 'tracked_empty_seed' : 'local_operator_state',
  };
}
