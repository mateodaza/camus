import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (value.schemaVersion !== 1) throw new Error('model evaluation campaign schemaVersion must be 1');
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
  }

  const profileIds = uniqueIds(value.profiles, 'profiles');
  const requiredProfiles = ['simple', 'balanced', 'difficult'];
  if (requiredProfiles.some((id) => !profileIds.has(id)) || profileIds.size !== requiredProfiles.length) {
    throw new Error('profiles must be exactly simple, balanced, and difficult');
  }
  for (const [index, profile] of value.profiles.entries()) {
    if (!['quick', 'standard'].includes(profile.depth)) throw new Error(`profiles[${index}].depth must be quick or standard`);
    if (!Number.isInteger(profile.wallBudgetMinutes) || profile.wallBudgetMinutes < 1 || profile.wallBudgetMinutes > 60) {
      throw new Error(`profiles[${index}].wallBudgetMinutes must be an integer from 1 to 60`);
    }
    nonempty(profile.goal, `profiles[${index}].goal`);
    nonempty(profile.acceptanceContract, `profiles[${index}].acceptanceContract`);
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

  if (!Array.isArray(value.initialSmokeOrder) || !value.initialSmokeOrder.length) throw new Error('initialSmokeOrder must be non-empty');
  for (const [index, trial] of value.initialSmokeOrder.entries()) {
    if (!profileIds.has(trial.profile)) throw new Error(`initialSmokeOrder[${index}] references an unknown profile`);
    if (!candidateIds.has(trial.maker)) throw new Error(`initialSmokeOrder[${index}] references an unknown maker`);
    if (!screenIds.has(trial.screen)) throw new Error(`initialSmokeOrder[${index}] references an unknown screen`);
    const screen = screenById.get(trial.screen);
    if (!screen.eligibleMakerProviders.includes(candidateProviders.get(trial.maker))) {
      throw new Error(`initialSmokeOrder[${index}] assigns maker ${trial.maker} to a non-independent screen`);
    }
  }

  return value;
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
