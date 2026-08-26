import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvaluationChecks } from './evaluation-graders.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODEL_EVAL_CAMPAIGN = join(__dirname, '..', 'checks', 'model-eval-campaign.json');

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function uniqueIds(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${field} must be a non-empty array`);
  const ids = rows.map((row, index) => nonempty(row?.id, `${field}[${index}].id`));
  if (new Set(ids).size !== ids.length) throw new Error(`${field} ids must be unique`);
  return new Set(ids);
}

function seat(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  nonempty(value.backend, `${field}.backend`);
  nonempty(value.model, `${field}.model`);
}

export function validateModelEvalCampaign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model evaluation campaign must be an object');
  if (value.schemaVersion !== 2) throw new Error('model evaluation campaign schemaVersion must be 2');
  nonempty(value.id, 'id');
  if (value.standing !== 'exploratory_only') throw new Error('a new model evaluation campaign must start exploratory_only');

  const controls = value.controls;
  if (!controls || controls.iterationPolicy !== 'single_pass' || controls.toolPolicy !== 'none'
      || controls.publish !== false || controls.ground !== false) {
    throw new Error('campaign controls must pin single_pass, no tools, no publication, and no live grounding');
  }
  if (!Number.isInteger(controls.minimumExplorationTrialsPerArm) || controls.minimumExplorationTrialsPerArm < 1) {
    throw new Error('minimumExplorationTrialsPerArm must be a positive integer');
  }
  if (!Number.isInteger(controls.minimumRoutingTrialsPerArm) || controls.minimumRoutingTrialsPerArm < 5) {
    throw new Error('minimumRoutingTrialsPerArm must be at least 5');
  }
  if (!Array.isArray(controls.optimizationOrder) || controls.optimizationOrder[0] !== 'quality_floor_pass_rate') {
    throw new Error('quality_floor_pass_rate must be the first optimization criterion');
  }
  if (controls.qualityFloorAudit !== 'independent_clean') throw new Error('qualityFloorAudit must be independent_clean');

  const candidateIds = uniqueIds(value.candidates, 'candidates');
  const candidateProviders = new Map();
  for (const [index, candidate] of value.candidates.entries()) {
    seat(candidate, `candidates[${index}]`);
    candidateProviders.set(candidate.id, nonempty(candidate.provider, `candidates[${index}].provider`));
    if (!Array.isArray(candidate.priority) || !candidate.priority.length) throw new Error(`candidates[${index}].priority must be non-empty`);
    if (!['promotion_eligible', 'exploratory_only'].includes(candidate.evidenceEligibility)) {
      throw new Error(`candidates[${index}].evidenceEligibility must be promotion_eligible or exploratory_only`);
    }
    if (candidate.evidenceEligibility === 'exploratory_only') {
      nonempty(candidate.eligibilityReason, `candidates[${index}].eligibilityReason`);
    }
  }

  const profileIds = uniqueIds(value.profiles, 'profiles');
  const requiredProfiles = ['simple', 'balanced', 'difficult'];
  if (requiredProfiles.some((id) => !profileIds.has(id)) || profileIds.size !== requiredProfiles.length) {
    throw new Error('profiles must be exactly simple, balanced, and difficult');
  }
  const caseIds = new Set();
  const casesByProfile = new Map();
  for (const [index, profile] of value.profiles.entries()) {
    if (!['quick', 'standard'].includes(profile.depth)) throw new Error(`profiles[${index}].depth must be quick or standard`);
    if (!Number.isInteger(profile.wallBudgetMinutes) || profile.wallBudgetMinutes < 1 || profile.wallBudgetMinutes > 60) {
      throw new Error(`profiles[${index}].wallBudgetMinutes must be an integer from 1 to 60`);
    }
    const ids = uniqueIds(profile.cases, `profiles[${index}].cases`);
    if (ids.size < 3) throw new Error(`profiles[${index}].cases must contain at least 3 representative cases`);
    casesByProfile.set(profile.id, ids);
    for (const [caseIndex, evaluationCase] of profile.cases.entries()) {
      if (caseIds.has(evaluationCase.id)) throw new Error('evaluation case ids must be globally unique');
      caseIds.add(evaluationCase.id);
      nonempty(evaluationCase.description, `profiles[${index}].cases[${caseIndex}].description`);
      nonempty(evaluationCase.goal, `profiles[${index}].cases[${caseIndex}].goal`);
      nonempty(evaluationCase.acceptanceContract, `profiles[${index}].cases[${caseIndex}].acceptanceContract`);
      validateEvaluationChecks(evaluationCase.deterministicChecks, `profiles[${index}].cases[${caseIndex}].deterministicChecks`);
    }
  }
  for (const [index, candidate] of value.candidates.entries()) {
    if (candidate.priority.some((id) => !profileIds.has(id))) throw new Error(`candidates[${index}].priority references an unknown profile`);
  }

  const screens = value.independence?.judgeScreens;
  const screenIds = uniqueIds(screens, 'independence.judgeScreens');
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  for (const [index, screen] of screens.entries()) {
    seat(screen.reviewer, `independence.judgeScreens[${index}].reviewer`);
    if (!Array.isArray(screen.eligibleMakerProviders) || !screen.eligibleMakerProviders.length) {
      throw new Error(`independence.judgeScreens[${index}].eligibleMakerProviders must be non-empty`);
    }
  }

  const calibration = value.calibration;
  if (!calibration || calibration.status !== 'human_labels_required') {
    throw new Error('calibration.status must be human_labels_required');
  }
  if (!Number.isInteger(calibration.minimumHumanLabeledArtifacts) || calibration.minimumHumanLabeledArtifacts < 12) {
    throw new Error('calibration.minimumHumanLabeledArtifacts must be at least 12');
  }
  if (typeof calibration.minimumAgreement !== 'number' || calibration.minimumAgreement < 0.8 || calibration.minimumAgreement > 1) {
    throw new Error('calibration.minimumAgreement must be from 0.8 to 1');
  }
  const labelsFile = nonempty(calibration.labelsFile, 'calibration.labelsFile');
  if (!/^checks\/[A-Za-z0-9._-]+\.json$/.test(labelsFile)) {
    throw new Error('calibration.labelsFile must name a JSON file directly under checks/');
  }
  const calibrationJudgeIds = uniqueIds(calibration.judges, 'calibration.judges');
  const calibrationSeats = new Set();
  for (const [index, judge] of calibration.judges.entries()) {
    seat(judge, `calibration.judges[${index}]`);
    const judgeSeat = `${judge.backend}:${judge.model}`;
    if (calibrationSeats.has(judgeSeat)) throw new Error('calibration judge seats must be unique');
    calibrationSeats.add(judgeSeat);
  }
  for (const screen of screens) {
    if (!calibrationSeats.has(`${screen.reviewer.backend}:${screen.reviewer.model}`)) {
      throw new Error(`judge screen ${screen.id} reviewer is missing from calibration.judges`);
    }
  }
  if (!calibrationJudgeIds.has('gpt-luna')) throw new Error('calibration.judges must retain GPT Luna as a cost-sensitive judge candidate');

  if (!Array.isArray(value.initialSmokeOrder) || !value.initialSmokeOrder.length) throw new Error('initialSmokeOrder must be non-empty');
  for (const [index, trial] of value.initialSmokeOrder.entries()) {
    if (!profileIds.has(trial.profile)) throw new Error(`initialSmokeOrder[${index}] references an unknown profile`);
    if (!casesByProfile.get(trial.profile)?.has(trial.case)) throw new Error(`initialSmokeOrder[${index}] references an unknown case for profile ${trial.profile}`);
    if (!candidateIds.has(trial.maker)) throw new Error(`initialSmokeOrder[${index}] references an unknown maker`);
    if (!screenIds.has(trial.screen)) throw new Error(`initialSmokeOrder[${index}] references an unknown screen`);
    const screen = screenById.get(trial.screen);
    if (!screen.eligibleMakerProviders.includes(candidateProviders.get(trial.maker))) {
      throw new Error(`initialSmokeOrder[${index}] assigns maker ${trial.maker} to a non-independent screen`);
    }
  }

  return value;
}

export function findEvaluationCase(campaign, profileId, caseId) {
  const profile = campaign.profiles.find((entry) => entry.id === profileId) ?? null;
  const evaluationCase = profile?.cases.find((entry) => entry.id === caseId) ?? null;
  return profile && evaluationCase ? { profile, evaluationCase } : null;
}

export function loadModelEvalCampaign(path = DEFAULT_MODEL_EVAL_CAMPAIGN) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot read model evaluation campaign: ${error.message}`); }
  return validateModelEvalCampaign(value);
}

export function modelEvalCampaignHash(campaign) {
  validateModelEvalCampaign(campaign);
  return `sha256:${createHash('sha256').update(JSON.stringify(campaign), 'utf8').digest('hex')}`;
}
