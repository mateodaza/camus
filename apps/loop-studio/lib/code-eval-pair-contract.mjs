// Provider-free, closed evidence contracts for the deliberately bounded Code
// Harness Eval v1b pair: one case, one pair, one repeat and exactly two arms.
// Existing v1a objects are intentionally neither accepted nor reinterpreted.

import { createHash } from 'node:crypto';

export const CODE_EVAL_PAIR_PROTOCOL = 'code-harness-eval-v1b';
export const CODE_EVAL_PAIR_EXECUTION_PROTOCOL = 'code-harness-execution/v1b';
export const CODE_EVAL_PAIR_RECEIPT_PROTOCOL = 'code-harness-receipt/v1b';
export const CODE_EVAL_PAIR_SCHEDULER_VERSION = 'code-harness-scheduler/v1';
export const CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION = 'code-seats/v2';
export const CODE_EVAL_PAIR_MIN_TOKEN_BUDGET = 32768;

export const CODE_EVAL_PAIR_CELL_STANDINGS = Object.freeze([
  'execution_observed',
  'failed',
  'unknown',
]);

export const CODE_EVAL_PAIR_OUTCOMES = Object.freeze([
  'candidate_ready_for_acceptance',
  'verification_failed',
  'review_unresolved',
  'needs_human',
  'needs_decision',
  'budget_exhausted',
  'infrastructure_failed',
  'interrupted_unknown',
  'containment_refused',
]);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,127}$/;
const ROUTE_SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,63})(?:\/[a-z0-9](?:[a-z0-9._-]{0,63}))*$/;
const OBSERVED_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9 ._()+\/-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FIXTURE_ID = /^fixture1:[a-f0-9]{64}$/;
const CAMPAIGN_ID = /^campaign1:[a-f0-9]{64}$/;
const EXECUTION_ID = /^execution1:[a-f0-9]{64}$/;
const CELL_ID = /^cell1:[a-f0-9]{64}$/;
const RECEIPT_ID = /^codebench1:[a-f0-9]{64}$/;
const QUALIFICATION = /^(?:qual1|builtin1):[a-f0-9]{64}$/;
const REVISION = /^(?:(?:cred1|sha256):[a-f0-9]{64}|[a-f0-9]{64}|none)$/;
const EXECUTORS = new Set(['qwen_native', 'grok_native']);
const TRANSPORTS = new Set(['vendor_managed', 'loopback', 'direct_https', 'ssh_tunnel']);
const OUTCOMES = new Set(CODE_EVAL_PAIR_OUTCOMES);
const CELL_STANDINGS = new Set(CODE_EVAL_PAIR_CELL_STANDINGS);
const REVIEW_VERDICTS = new Set(['APPROVED', 'REVISE']);
const REVIEW_SCREEN_STANDINGS = new Set(['independent_exact', 'same_origin_advisory']);

function fail(path, message) {
  throw new Error(`${path} ${message}`);
}

function exactObject(value, path, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object');
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  const unknown = actual.filter(key => !expected.includes(key));
  const missing = expected.filter(key => !actual.includes(key));
  if (unknown.length) fail(path, `contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (missing.length) fail(path, `is missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  return value;
}

function string(value, path, { pattern = null, max = 256, nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) {
    fail(path, `must be ${nullable ? 'null or ' : ''}a non-empty trimmed string of at most ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function boolean(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'boolean') fail(path, `must be ${nullable ? 'a boolean or null' : 'a boolean'}`);
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `must be ${nullable ? 'null or ' : ''}an integer from ${min} to ${max}`);
  }
  return value;
}

function finiteNumber(value, path, { min = 0, nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    fail(path, `must be ${nullable ? 'null or ' : ''}a finite number at least ${min}`);
  }
  return value;
}

function enumValue(value, path, allowed, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!allowed.has(value)) fail(path, `must be one of: ${[...allowed].join(', ')}`);
  return value;
}

function canonicalIso(value, path) {
  string(value, path, { max: 32 });
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) fail(path, 'must be a canonical ISO timestamp');
  return value;
}

function canonicalShape(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(path, 'contains a non-canonical number');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalShape(entry, `${path}[${index}]`));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'contains a non-JSON value');
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail(`${path}.${key}`, 'must not be undefined');
    result[key] = canonicalShape(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalCodeEvalPairJson(value) {
  return JSON.stringify(canonicalShape(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function contentId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(canonicalCodeEvalPairJson(value), 'utf8').digest('hex')}`;
}

function validateRoute(route, provider, path) {
  if (provider !== 'openrouter') {
    if (route !== null) fail(path, 'must be null unless provider is openrouter');
    return route;
  }
  exactObject(route, path, ['upstreamProvider', 'allowFallbacks']);
  string(route.upstreamProvider, `${path}.upstreamProvider`, { pattern: ROUTE_SLUG, max: 128 });
  if (route.allowFallbacks !== false) fail(`${path}.allowFallbacks`, 'must be false');
  return route;
}

function validateRouteObservation(value, campaignRoute, path) {
  if (value === null) return value;
  exactObject(value, path, ['requestEnforced', 'metadataObserved']);
  exactObject(value.requestEnforced, `${path}.requestEnforced`, ['upstreamProvider', 'allowFallbacks']);
  string(value.requestEnforced.upstreamProvider, `${path}.requestEnforced.upstreamProvider`, { pattern: ROUTE_SLUG, max: 128 });
  if (value.requestEnforced.allowFallbacks !== false) fail(`${path}.requestEnforced.allowFallbacks`, 'must be false');
  if (canonicalCodeEvalPairJson(value.requestEnforced) !== canonicalCodeEvalPairJson(campaignRoute)) {
    fail(`${path}.requestEnforced`, 'does not match the campaign route');
  }
  if (!Array.isArray(value.metadataObserved) || !value.metadataObserved.length || value.metadataObserved.length > 128) {
    fail(`${path}.metadataObserved`, 'must contain 1 to 128 bounded provider observations');
  }
  for (const [index, item] of value.metadataObserved.entries()) {
    const itemPath = `${path}.metadataObserved[${index}]`;
    exactObject(item, itemPath, ['provider', 'attempt']);
    string(item.provider, `${itemPath}.provider`, { pattern: OBSERVED_PROVIDER, max: 128 });
    integer(item.attempt, `${itemPath}.attempt`, { min: 1, max: 128 });
  }
  return value;
}

const comparableProvider = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function routeStatus(observation, route) {
  if (route === null) return { complete: observation === null, stable: observation === null, fallbackDetected: false };
  if (observation === null) return { complete: false, stable: false, fallbackDetected: null };
  const expected = route.upstreamProvider.split('/')[0];
  const providerMatch = observation.metadataObserved.every(item => comparableProvider(item.provider) === comparableProvider(expected));
  const fallbackDetected = observation.metadataObserved.some(item => item.attempt !== 1);
  return { complete: true, stable: providerMatch && !fallbackDetected, fallbackDetected };
}

function validateMakerSeat(value, path) {
  exactObject(value, path, [
    'backend', 'provider', 'model', 'effort', 'trainingOrg', 'transport', 'connection', 'route',
  ]);
  string(value.backend, `${path}.backend`, { pattern: SAFE_NAME, max: 64 });
  string(value.provider, `${path}.provider`, { pattern: SAFE_NAME, max: 64 });
  string(value.model, `${path}.model`, { pattern: MODEL_ID, max: 128 });
  string(value.effort, `${path}.effort`, { pattern: SAFE_NAME, max: 64, nullable: true });
  string(value.trainingOrg, `${path}.trainingOrg`, { pattern: SAFE_NAME, max: 64 });
  enumValue(value.transport, `${path}.transport`, TRANSPORTS);
  string(value.connection, `${path}.connection`, { pattern: SAFE_NAME, max: 64 });
  validateRoute(value.route, value.provider, `${path}.route`);
}

function validateReviewerSeat(value, path) {
  exactObject(value, path, ['backend', 'model', 'effort', 'trainingOrg']);
  string(value.backend, `${path}.backend`, { pattern: SAFE_NAME, max: 64 });
  string(value.model, `${path}.model`, { pattern: MODEL_ID, max: 128 });
  string(value.effort, `${path}.effort`, { pattern: SAFE_NAME, max: 64, nullable: true });
  string(value.trainingOrg, `${path}.trainingOrg`, { pattern: SAFE_NAME, max: 64 });
}

function validateCase(value, path = 'campaign.case') {
  exactObject(value, path, [
    'caseId', 'caseVersion', 'taskClass', 'fixtureId', 'fixtureTreeDigest',
    'baseCommitDigest', 'taskSha256', 'acceptanceContractSha256', 'verifier',
  ]);
  string(value.caseId, `${path}.caseId`, { pattern: SAFE_NAME, max: 64 });
  integer(value.caseVersion, `${path}.caseVersion`, { min: 1, max: 1_000_000 });
  enumValue(value.taskClass, `${path}.taskClass`, new Set(['simple', 'balanced', 'difficult']));
  string(value.fixtureId, `${path}.fixtureId`, { pattern: FIXTURE_ID, max: 73 });
  for (const field of ['fixtureTreeDigest', 'baseCommitDigest', 'taskSha256', 'acceptanceContractSha256']) {
    string(value[field], `${path}.${field}`, { pattern: SHA256, max: 71 });
  }
  exactObject(value.verifier, `${path}.verifier`, [
    'kind', 'commandSha256', 'timeoutMs', 'expectedBase', 'expectedReference',
  ]);
  if (value.verifier.kind !== 'host_command') fail(`${path}.verifier.kind`, 'must be host_command');
  string(value.verifier.commandSha256, `${path}.verifier.commandSha256`, { pattern: SHA256, max: 71 });
  integer(value.verifier.timeoutMs, `${path}.verifier.timeoutMs`, { min: 1, max: 3_600_000 });
  if (value.verifier.expectedBase !== 'red') fail(`${path}.verifier.expectedBase`, 'must be red');
  if (value.verifier.expectedReference !== 'green') fail(`${path}.verifier.expectedReference`, 'must be green');
}

function validatePair(value) {
  exactObject(value, 'campaign.pair', ['pairId', 'maker', 'reviewer', 'arms']);
  string(value.pairId, 'campaign.pair.pairId', { pattern: SAFE_NAME, max: 64 });
  validateMakerSeat(value.maker, 'campaign.pair.maker');
  validateReviewerSeat(value.reviewer, 'campaign.pair.reviewer');
  if (!Array.isArray(value.arms) || value.arms.length !== 2) fail('campaign.pair.arms', 'must contain exactly raw and native');
  for (const [index, arm] of value.arms.entries()) {
    exactObject(arm, `campaign.pair.arms[${index}]`, ['armId', 'makerExecutor']);
    string(arm.armId, `campaign.pair.arms[${index}].armId`, { pattern: SAFE_NAME, max: 64 });
    string(arm.makerExecutor, `campaign.pair.arms[${index}].makerExecutor`, { pattern: SAFE_NAME, max: 64 });
  }
  if (value.arms[0].armId !== 'raw' || value.arms[0].makerExecutor !== 'file_actions') {
    fail('campaign.pair.arms[0]', 'must be the canonical raw/file_actions arm');
  }
  if (value.arms[1].armId !== 'native' || !EXECUTORS.has(value.arms[1].makerExecutor)) {
    fail('campaign.pair.arms[1]', 'must be the canonical native qwen_native or grok_native arm');
  }
}

function validateControls(value) {
  exactObject(value, 'campaign.controls', [
    'repeatsPerArmCase', 'maximumCells', 'maximumProviderCallsPerCell',
    'maximumMakerCallsPerCell', 'maximumReviewerCallsPerCell', 'maximumSteps',
    'maximumActions', 'maximumRepairs', 'maximumRetries', 'maximumTokensReserved',
    'semanticPromptEnvelopeVersion', 'wallTimeoutMs', 'callTimeoutMs', 'idleTimeoutMs',
    'publish', 'commit', 'merge', 'push', 'automaticRouting',
  ]);
  if (value.repeatsPerArmCase !== 1) fail('campaign.controls.repeatsPerArmCase', 'must be exactly 1 in bounded v1b');
  if (value.maximumCells !== 2) fail('campaign.controls.maximumCells', 'must be exactly 2 in bounded v1b');
  integer(value.maximumProviderCallsPerCell, 'campaign.controls.maximumProviderCallsPerCell', { min: 1, max: 128 });
  integer(value.maximumMakerCallsPerCell, 'campaign.controls.maximumMakerCallsPerCell', { min: 1, max: 128 });
  integer(value.maximumReviewerCallsPerCell, 'campaign.controls.maximumReviewerCallsPerCell', { min: 1, max: 16 });
  if (value.maximumProviderCallsPerCell < value.maximumMakerCallsPerCell + value.maximumReviewerCallsPerCell) {
    fail('campaign.controls.maximumProviderCallsPerCell', 'must cover maker and reviewer call bounds');
  }
  integer(value.maximumSteps, 'campaign.controls.maximumSteps', { min: 1, max: 128 });
  integer(value.maximumActions, 'campaign.controls.maximumActions', { min: 1, max: 1_024 });
  integer(value.maximumRepairs, 'campaign.controls.maximumRepairs', { min: 0, max: 16 });
  integer(value.maximumRetries, 'campaign.controls.maximumRetries', { min: 0, max: 16 });
  integer(value.maximumTokensReserved, 'campaign.controls.maximumTokensReserved', { min: CODE_EVAL_PAIR_MIN_TOKEN_BUDGET, max: 100_000_000 });
  if (value.semanticPromptEnvelopeVersion !== CODE_EVAL_PAIR_PROTOCOL) {
    fail('campaign.controls.semanticPromptEnvelopeVersion', `must be ${CODE_EVAL_PAIR_PROTOCOL}`);
  }
  integer(value.wallTimeoutMs, 'campaign.controls.wallTimeoutMs', { min: 1, max: 86_400_000 });
  integer(value.callTimeoutMs, 'campaign.controls.callTimeoutMs', { min: 1, max: 3_600_000 });
  integer(value.idleTimeoutMs, 'campaign.controls.idleTimeoutMs', { min: 0, max: 3_600_000 });
  if (value.callTimeoutMs > value.wallTimeoutMs) fail('campaign.controls.callTimeoutMs', 'must not exceed wallTimeoutMs');
  for (const field of ['publish', 'commit', 'merge', 'push', 'automaticRouting']) {
    if (value[field] !== false) fail(`campaign.controls.${field}`, 'must be false');
  }
}

function validateClaimPolicy(value) {
  exactObject(value, 'campaign.claimPolicy', [
    'pairedClaim', 'winnerClaim', 'routingClaim', 'admissionClaim',
  ]);
  if (value.pairedClaim !== 'paired_observation') fail('campaign.claimPolicy.pairedClaim', 'must be paired_observation');
  for (const field of ['winnerClaim', 'routingClaim', 'admissionClaim']) {
    if (value[field] !== 'forbidden') fail(`campaign.claimPolicy.${field}`, 'must be forbidden');
  }
}

export function validateCodeEvalPairCampaign(value) {
  exactObject(value, 'campaign', [
    'schemaVersion', 'treatmentProtocol', 'campaignId', 'campaignMode', 'standing',
    'case', 'pair', 'controls', 'claimPolicy',
  ]);
  if (value.schemaVersion !== 1) fail('campaign.schemaVersion', 'must be 1');
  if (value.treatmentProtocol !== CODE_EVAL_PAIR_PROTOCOL) fail('campaign.treatmentProtocol', `must be ${CODE_EVAL_PAIR_PROTOCOL}`);
  string(value.campaignId, 'campaign.campaignId', { pattern: SAFE_NAME, max: 64 });
  if (value.campaignMode !== 'isolation_pair') fail('campaign.campaignMode', 'must be isolation_pair');
  if (value.standing !== 'exploratory_only') fail('campaign.standing', 'must be exploratory_only');
  validateCase(value.case);
  validatePair(value.pair);
  validateControls(value.controls);
  validateClaimPolicy(value.claimPolicy);
  return value;
}

export function codeEvalPairCampaignIdentity(campaign) {
  validateCodeEvalPairCampaign(campaign);
  return contentId('campaign1', campaign);
}

function validateRuntime(value) {
  exactObject(value, 'execution.runtime', [
    'packageVersion', 'treeDigest', 'platform', 'architecture', 'nodeVersion',
  ]);
  string(value.packageVersion, 'execution.runtime.packageVersion', { pattern: SAFE_VALUE, max: 64 });
  string(value.treeDigest, 'execution.runtime.treeDigest', { pattern: SHA256, max: 71 });
  string(value.platform, 'execution.runtime.platform', { pattern: SAFE_NAME, max: 32 });
  string(value.architecture, 'execution.runtime.architecture', { pattern: SAFE_NAME, max: 32 });
  string(value.nodeVersion, 'execution.runtime.nodeVersion', { pattern: SAFE_VALUE, max: 32 });
}

function validateExecutionSeat(value, path, campaignSeat, { maker = false } = {}) {
  exactObject(value, path, [
    'backendDefinitionDigest', 'qualificationFingerprint', 'qualificationSeatType',
    'credentialRevision', 'connectionDefinitionDigest', 'expectedModel',
    ...(maker ? ['expectedRoute'] : []),
  ]);
  string(value.backendDefinitionDigest, `${path}.backendDefinitionDigest`, { pattern: SHA256, max: 71 });
  string(value.qualificationFingerprint, `${path}.qualificationFingerprint`, { pattern: QUALIFICATION, max: 73 });
  if (value.qualificationSeatType !== (maker ? 'words_maker' : 'words_reviewer')) {
    fail(`${path}.qualificationSeatType`, `must be ${maker ? 'words_maker' : 'words_reviewer'}`);
  }
  string(value.credentialRevision, `${path}.credentialRevision`, { pattern: REVISION, max: 71 });
  string(value.connectionDefinitionDigest, `${path}.connectionDefinitionDigest`, { pattern: SHA256, max: 71 });
  string(value.expectedModel, `${path}.expectedModel`, { pattern: MODEL_ID, max: 128 });
  if (value.expectedModel !== campaignSeat.model) fail(`${path}.expectedModel`, 'must match the shared campaign seat');
  if (maker) {
    validateRoute(value.expectedRoute, campaignSeat.provider, `${path}.expectedRoute`);
    if (canonicalCodeEvalPairJson(value.expectedRoute) !== canonicalCodeEvalPairJson(campaignSeat.route)) {
      fail(`${path}.expectedRoute`, 'must match the shared campaign route');
    }
  }
}

function validateHarness(value, executor, path) {
  exactObject(value, path, [
    'name', 'version', 'artifactDigest', 'parserVersion', 'outerSandboxPolicyDigest',
    'credentialGatewayPolicyDigest',
  ]);
  const expectedName = executor === 'qwen_native' ? 'qwen_code' : 'grok_build';
  if (value.name !== expectedName) fail(`${path}.name`, `must be ${expectedName}`);
  string(value.version, `${path}.version`, { pattern: SAFE_VALUE, max: 64 });
  string(value.artifactDigest, `${path}.artifactDigest`, { pattern: SHA256, max: 71 });
  string(value.parserVersion, `${path}.parserVersion`, { pattern: SAFE_VALUE, max: 64 });
  string(value.outerSandboxPolicyDigest, `${path}.outerSandboxPolicyDigest`, { pattern: SHA256, max: 71 });
  string(value.credentialGatewayPolicyDigest, `${path}.credentialGatewayPolicyDigest`, { pattern: SHA256, max: 71 });
}

function validateArmExecutions(value, campaign) {
  if (!Array.isArray(value) || value.length !== 2) fail('execution.armExecutions', 'must contain exactly raw and native');
  const raw = value[0];
  exactObject(raw, 'execution.armExecutions[0]', ['armId', 'executor', 'protocolVersion', 'policyDigest']);
  if (raw.armId !== 'raw' || raw.executor !== 'file_actions') fail('execution.armExecutions[0]', 'must bind raw/file_actions');
  if (raw.protocolVersion !== CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION) {
    fail('execution.armExecutions[0].protocolVersion', `must be ${CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION}`);
  }
  string(raw.policyDigest, 'execution.armExecutions[0].policyDigest', { pattern: SHA256, max: 71 });

  const native = value[1];
  exactObject(native, 'execution.armExecutions[1]', ['armId', 'executor', 'harness']);
  if (native.armId !== 'native' || native.executor !== campaign.pair.arms[1].makerExecutor) {
    fail('execution.armExecutions[1]', 'must bind the campaign native executor');
  }
  validateHarness(native.harness, native.executor, 'execution.armExecutions[1].harness');
}

export function validateCodeEvalPairExecution(value, campaign) {
  validateCodeEvalPairCampaign(campaign);
  exactObject(value, 'execution', [
    'schemaVersion', 'executionProtocol', 'campaignDigest', 'createdAt', 'runtime',
    'maker', 'reviewer', 'schedulerVersion', 'armExecutions', 'verifierDigest',
    'fixtureReadinessDigest',
  ]);
  if (value.schemaVersion !== 1) fail('execution.schemaVersion', 'must be 1');
  if (value.executionProtocol !== CODE_EVAL_PAIR_EXECUTION_PROTOCOL) {
    fail('execution.executionProtocol', `must be ${CODE_EVAL_PAIR_EXECUTION_PROTOCOL}`);
  }
  string(value.campaignDigest, 'execution.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  if (value.campaignDigest !== codeEvalPairCampaignIdentity(campaign)) fail('execution.campaignDigest', 'does not match the campaign');
  canonicalIso(value.createdAt, 'execution.createdAt');
  validateRuntime(value.runtime);
  validateExecutionSeat(value.maker, 'execution.maker', campaign.pair.maker, { maker: true });
  validateExecutionSeat(value.reviewer, 'execution.reviewer', campaign.pair.reviewer);
  if (value.schedulerVersion !== CODE_EVAL_PAIR_SCHEDULER_VERSION) {
    fail('execution.schedulerVersion', `must be ${CODE_EVAL_PAIR_SCHEDULER_VERSION}`);
  }
  validateArmExecutions(value.armExecutions, campaign);
  string(value.verifierDigest, 'execution.verifierDigest', { pattern: SHA256, max: 71 });
  if (value.verifierDigest !== campaign.case.verifier.commandSha256) fail('execution.verifierDigest', 'must match the campaign verifier');
  string(value.fixtureReadinessDigest, 'execution.fixtureReadinessDigest', { pattern: SHA256, max: 71 });
  return value;
}

export function codeEvalPairExecutionIdentity(execution, campaign) {
  validateCodeEvalPairExecution(execution, campaign);
  return contentId('execution1', execution);
}

export function createCodeEvalPairCell(campaign, execution, armId) {
  validateCodeEvalPairExecution(execution, campaign);
  if (!['raw', 'native'].includes(armId)) fail('armId', 'must be raw or native');
  return {
    schemaVersion: 1,
    campaignDigest: codeEvalPairCampaignIdentity(campaign),
    executionDigest: codeEvalPairExecutionIdentity(execution, campaign),
    pairId: campaign.pair.pairId,
    taskClass: campaign.case.taskClass,
    caseId: campaign.case.caseId,
    armId,
    repeat: 1,
  };
}

export function createCodeEvalPairCells(campaign, execution) {
  return campaign.pair.arms.map(arm => createCodeEvalPairCell(campaign, execution, arm.armId));
}

export function validateCodeEvalPairCell(value, campaign, execution) {
  validateCodeEvalPairExecution(execution, campaign);
  exactObject(value, 'cell', [
    'schemaVersion', 'campaignDigest', 'executionDigest', 'pairId', 'taskClass',
    'caseId', 'armId', 'repeat',
  ]);
  if (value.schemaVersion !== 1) fail('cell.schemaVersion', 'must be 1');
  string(value.campaignDigest, 'cell.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  string(value.executionDigest, 'cell.executionDigest', { pattern: EXECUTION_ID, max: 75 });
  if (value.campaignDigest !== codeEvalPairCampaignIdentity(campaign)) fail('cell.campaignDigest', 'does not match the campaign');
  if (value.executionDigest !== codeEvalPairExecutionIdentity(execution, campaign)) fail('cell.executionDigest', 'does not match the execution');
  if (value.pairId !== campaign.pair.pairId) fail('cell.pairId', 'must match the campaign pair');
  if (value.taskClass !== campaign.case.taskClass) fail('cell.taskClass', 'must match the campaign case');
  if (value.caseId !== campaign.case.caseId) fail('cell.caseId', 'must match the campaign case');
  if (!campaign.pair.arms.some(arm => arm.armId === value.armId)) fail('cell.armId', 'must match a campaign arm');
  if (value.repeat !== 1) fail('cell.repeat', 'must be exactly 1 in bounded v1b');
  return value;
}

export function codeEvalPairCellIdentity(cell, campaign, execution) {
  validateCodeEvalPairCell(cell, campaign, execution);
  return contentId('cell1', cell);
}

export function codeEvalPairArmForCell(campaign, execution, cell) {
  validateCodeEvalPairCell(cell, campaign, execution);
  const campaignArm = campaign.pair.arms.find(arm => arm.armId === cell.armId);
  const armExecution = execution.armExecutions.find(arm => arm.armId === cell.armId);
  if (!campaignArm || !armExecution || campaignArm.makerExecutor !== armExecution.executor) {
    fail('cell.armId', 'does not resolve to one exact campaign/execution arm');
  }
  return Object.freeze({ ...clone(campaignArm), execution: clone(armExecution) });
}

export function codeEvalPairReceiptAssignment(campaign, execution, cell) {
  const arm = codeEvalPairArmForCell(campaign, execution, cell);
  return {
    pairId: cell.pairId,
    taskClass: cell.taskClass,
    caseId: cell.caseId,
    armId: cell.armId,
    repeat: cell.repeat,
    executor: arm.makerExecutor,
    requestedMaker: clone(campaign.pair.maker),
    requestedReviewer: clone(campaign.pair.reviewer),
    makerExecution: clone(execution.maker),
    reviewerExecution: clone(execution.reviewer),
    armExecution: clone(arm.execution),
    fixtureId: campaign.case.fixtureId,
    fixtureTreeDigest: campaign.case.fixtureTreeDigest,
    baseCommitDigest: campaign.case.baseCommitDigest,
    taskSha256: campaign.case.taskSha256,
    acceptanceContractSha256: campaign.case.acceptanceContractSha256,
    verifierDigest: execution.verifierDigest,
    controls: clone(campaign.controls),
  };
}

function validateAssignment(value, campaign, execution, cell) {
  exactObject(value, 'receipt.assignment', [
    'pairId', 'taskClass', 'caseId', 'armId', 'repeat', 'executor',
    'requestedMaker', 'requestedReviewer', 'makerExecution', 'reviewerExecution',
    'armExecution', 'fixtureId', 'fixtureTreeDigest', 'baseCommitDigest', 'taskSha256',
    'acceptanceContractSha256', 'verifierDigest', 'controls',
  ]);
  if (canonicalCodeEvalPairJson(value) !== canonicalCodeEvalPairJson(codeEvalPairReceiptAssignment(campaign, execution, cell))) {
    fail('receipt.assignment', 'does not exactly match the frozen campaign, execution and cell');
  }
}

function validateObservedHarness(value, expected, path) {
  if (value === null) return value;
  exactObject(value, path, ['name', 'version', 'artifactDigest', 'sessionId']);
  string(value.name, `${path}.name`, { pattern: SAFE_VALUE, max: 64 });
  string(value.version, `${path}.version`, { pattern: SAFE_VALUE, max: 64 });
  string(value.artifactDigest, `${path}.artifactDigest`, { pattern: SHA256, max: 71 });
  string(value.sessionId, `${path}.sessionId`, { pattern: SAFE_VALUE, max: 128 });
  if (value.name !== expected.name || value.version !== expected.version || value.artifactDigest !== expected.artifactDigest) {
    fail(path, 'does not match the frozen native harness');
  }
  return value;
}

function validateObservedIdentity(value, campaign, execution, cell) {
  exactObject(value, 'receipt.observedIdentity', [
    'makerModel', 'reviewerModel', 'executor', 'rawProtocolVersion', 'nativeHarness',
    'makerRoute', 'qualificationBindingsMatch', 'connectionBindingsMatch',
    'policyBindingMatch', 'identityStable', 'substitutionDetected',
    'helperModelDetected', 'fallbackDetected',
  ]);
  string(value.makerModel, 'receipt.observedIdentity.makerModel', { pattern: MODEL_ID, max: 128, nullable: true });
  string(value.reviewerModel, 'receipt.observedIdentity.reviewerModel', { pattern: MODEL_ID, max: 128, nullable: true });
  string(value.executor, 'receipt.observedIdentity.executor', { pattern: SAFE_NAME, max: 64, nullable: true });
  string(value.rawProtocolVersion, 'receipt.observedIdentity.rawProtocolVersion', { max: 64, nullable: true });
  const arm = codeEvalPairArmForCell(campaign, execution, cell);
  if (cell.armId === 'raw') {
    if (value.nativeHarness !== null) fail('receipt.observedIdentity.nativeHarness', 'must be null for the raw arm');
    if (value.rawProtocolVersion !== null && value.rawProtocolVersion !== arm.execution.protocolVersion) {
      fail('receipt.observedIdentity.rawProtocolVersion', 'does not match the frozen raw protocol');
    }
  } else {
    if (value.rawProtocolVersion !== null) fail('receipt.observedIdentity.rawProtocolVersion', 'must be null for the native arm');
    validateObservedHarness(value.nativeHarness, arm.execution.harness, 'receipt.observedIdentity.nativeHarness');
  }
  if (campaign.pair.maker.route === null) {
    if (value.makerRoute !== null) fail('receipt.observedIdentity.makerRoute', 'must be null for a non-OpenRouter campaign');
  } else validateRouteObservation(value.makerRoute, campaign.pair.maker.route, 'receipt.observedIdentity.makerRoute');
  for (const field of [
    'qualificationBindingsMatch', 'connectionBindingsMatch', 'policyBindingMatch',
    'identityStable', 'substitutionDetected', 'helperModelDetected', 'fallbackDetected',
  ]) boolean(value[field], `receipt.observedIdentity.${field}`, { nullable: true });
  const route = routeStatus(value.makerRoute, campaign.pair.maker.route);
  if (value.fallbackDetected !== route.fallbackDetected) {
    fail('receipt.observedIdentity.fallbackDetected', 'must be derived from route evidence');
  }
  const executorEvidence = cell.armId === 'raw'
    ? value.rawProtocolVersion === arm.execution.protocolVersion && value.nativeHarness === null
    : value.rawProtocolVersion === null && value.nativeHarness !== null;
  if (value.identityStable === true && (
    value.makerModel !== campaign.pair.maker.model
    || value.reviewerModel !== campaign.pair.reviewer.model
    || value.executor !== arm.makerExecutor
    || !executorEvidence
    || value.qualificationBindingsMatch !== true
    || value.connectionBindingsMatch !== true
    || value.policyBindingMatch !== true
    || value.substitutionDetected !== false
    || value.helperModelDetected !== false
    || value.fallbackDetected !== false
    || !route.complete
    || !route.stable
  )) fail('receipt.observedIdentity', 'cannot claim stable identity with mismatched or incomplete evidence');
}

function validateOutcome(value, campaign) {
  exactObject(value, 'receipt.outcome', [
    'status', 'buildStatus', 'reasonCode', 'possibleBilling', 'modelCallsMade',
    'candidateDiffExists', 'candidateFingerprint', 'finalCandidateCurrent',
    'repairs', 'retries', 'questions', 'humanAnswers',
  ]);
  enumValue(value.status, 'receipt.outcome.status', OUTCOMES);
  string(value.buildStatus, 'receipt.outcome.buildStatus', { pattern: SAFE_VALUE, max: 128, nullable: true });
  string(value.reasonCode, 'receipt.outcome.reasonCode', { pattern: SAFE_VALUE, max: 128, nullable: true });
  boolean(value.possibleBilling, 'receipt.outcome.possibleBilling');
  integer(value.modelCallsMade, 'receipt.outcome.modelCallsMade', { min: 0, max: campaign.controls.maximumProviderCallsPerCell, nullable: true });
  boolean(value.candidateDiffExists, 'receipt.outcome.candidateDiffExists', { nullable: true });
  string(value.candidateFingerprint, 'receipt.outcome.candidateFingerprint', { pattern: SHA256, max: 71, nullable: true });
  boolean(value.finalCandidateCurrent, 'receipt.outcome.finalCandidateCurrent', { nullable: true });
  for (const field of ['repairs', 'retries', 'questions', 'humanAnswers']) {
    integer(value[field], `receipt.outcome.${field}`, { min: 0, max: field === 'repairs'
      ? campaign.controls.maximumRepairs : field === 'retries' ? campaign.controls.maximumRetries : 1_024, nullable: true });
  }
  if (value.modelCallsMade === 0 && value.possibleBilling !== false) fail('receipt.outcome.possibleBilling', 'must be false when zero calls are known');
  if (value.modelCallsMade !== null && value.modelCallsMade > 0 && value.possibleBilling !== true) fail('receipt.outcome.possibleBilling', 'must be true when calls are known');
  if (value.finalCandidateCurrent === true && value.candidateFingerprint === null) {
    fail('receipt.outcome.finalCandidateCurrent', 'requires a candidate fingerprint');
  }
}

function triStateAll(values) {
  if (values.some(value => value === false)) return false;
  return values.every(value => value === true) ? true : null;
}

function expectedReviewerIndependence(campaign) {
  return campaign.pair.maker.trainingOrg !== campaign.pair.reviewer.trainingOrg;
}

function deriveMechanicalFloor(quality, outcome) {
  // An explicitly observed infrastructure/containment failure is mechanically
  // red. An interrupted_unknown receipt is different: the floor is unknown and
  // must not be silently converted into a known failure (or pass).
  const noInfrastructureUncertainty = outcome.status === 'interrupted_unknown'
    ? null
    : ['infrastructure_failed', 'containment_refused'].includes(outcome.status) ? false : true;
  return triStateAll([
    quality.fixturePreflightPassed,
    quality.candidateIntegrityPassed,
    quality.containmentPassed,
    quality.verificationRan,
    quality.verificationPassed,
    quality.verificationBindingMatch,
    outcome.candidateDiffExists,
    outcome.finalCandidateCurrent,
    quality.humanInterventionDuringRun === null ? null : !quality.humanInterventionDuringRun,
    noInfrastructureUncertainty,
  ]);
}

function deriveScreenFloor(quality, observedIdentity) {
  if (quality.mechanicalFloorPassed === false) return false;
  const approved = quality.reviewVerdict === null ? null : quality.reviewVerdict === 'APPROVED';
  const noMaterialFinding = quality.materialFindingCount === null ? null : quality.materialFindingCount === 0;
  return triStateAll([
    quality.mechanicalFloorPassed,
    quality.reviewRan,
    approved,
    noMaterialFinding,
    quality.reviewBindingMatch,
    quality.reviewerIndependent,
    quality.reviewScreenStanding === null ? null : quality.reviewScreenStanding === 'independent_exact',
    observedIdentity.identityStable,
  ]);
}

function validateQuality(value, campaign, outcome, observedIdentity) {
  exactObject(value, 'receipt.quality', [
    'fixturePreflightPassed', 'candidateIntegrityPassed', 'containmentPassed',
    'verificationRan', 'verificationPassed', 'verificationBindingMatch', 'reviewRan',
    'reviewVerdict', 'materialFindingCount', 'reviewBindingMatch', 'reviewerIndependent',
    'reviewScreenStanding', 'humanInterventionDuringRun', 'mechanicalFloorPassed',
    'screenFloorPassed',
  ]);
  for (const field of [
    'fixturePreflightPassed', 'candidateIntegrityPassed', 'containmentPassed',
    'verificationRan', 'verificationPassed', 'verificationBindingMatch', 'reviewRan',
    'reviewBindingMatch', 'humanInterventionDuringRun', 'mechanicalFloorPassed',
    'screenFloorPassed',
  ]) boolean(value[field], `receipt.quality.${field}`, { nullable: true });
  enumValue(value.reviewVerdict, 'receipt.quality.reviewVerdict', REVIEW_VERDICTS, { nullable: true });
  integer(value.materialFindingCount, 'receipt.quality.materialFindingCount', { min: 0, max: 1_024, nullable: true });
  boolean(value.reviewerIndependent, 'receipt.quality.reviewerIndependent');
  enumValue(value.reviewScreenStanding, 'receipt.quality.reviewScreenStanding', REVIEW_SCREEN_STANDINGS);
  const independent = expectedReviewerIndependence(campaign);
  if (value.reviewerIndependent !== independent) fail('receipt.quality.reviewerIndependent', 'must be derived from the shared campaign seats');
  if (value.reviewScreenStanding !== (independent ? 'independent_exact' : 'same_origin_advisory')) {
    fail('receipt.quality.reviewScreenStanding', 'must be derived from reviewer independence');
  }
  if (value.verificationRan === false && (value.verificationPassed !== null || value.verificationBindingMatch !== null)) {
    fail('receipt.quality.verificationRan', 'false verification cannot carry pass or binding evidence');
  }
  if (value.verificationRan === true && (value.verificationPassed === null || value.verificationBindingMatch === null)) {
    fail('receipt.quality.verificationRan', 'true verification requires pass and binding evidence');
  }
  if (value.reviewRan === false && (value.reviewVerdict !== null || value.materialFindingCount !== null || value.reviewBindingMatch !== null)) {
    fail('receipt.quality.reviewRan', 'false review cannot carry verdict, finding, or binding evidence');
  }
  if (value.reviewRan === true && (value.reviewVerdict === null || value.materialFindingCount === null || value.reviewBindingMatch === null)) {
    fail('receipt.quality.reviewRan', 'true review requires verdict, finding, and binding evidence');
  }
  const mechanical = deriveMechanicalFloor(value, outcome);
  if (value.mechanicalFloorPassed !== mechanical) fail('receipt.quality.mechanicalFloorPassed', `must be derived as ${mechanical}`);
  const screen = deriveScreenFloor(value, observedIdentity);
  if (value.screenFloorPassed !== screen) fail('receipt.quality.screenFloorPassed', `must be derived as ${screen}`);
}

const ECONOMIC_FIELDS = Object.freeze([
  'providerCalls', 'makerCalls', 'reviewerCalls',
  'makerInputTokens', 'makerCachedInputTokens', 'makerOutputTokens',
  'reviewerInputTokens', 'reviewerCachedInputTokens', 'reviewerOutputTokens',
  'wallMs', 'makerMs', 'verifierMs', 'reviewerMs', 'orchestrationMs',
  'rawProtocolSteps', 'rawFileActions', 'nativeProviderResponses', 'nativeToolActions',
  'repairs', 'retries', 'incompleteSessions', 'costUsd', 'currency', 'usageIncomplete',
]);

function validateEconomics(value, campaign, cell, outcome) {
  exactObject(value, 'receipt.economics', ECONOMIC_FIELDS);
  for (const field of ECONOMIC_FIELDS.filter(field => !['costUsd', 'currency', 'usageIncomplete'].includes(field))) {
    integer(value[field], `receipt.economics.${field}`, { min: 0, nullable: true });
  }
  finiteNumber(value.costUsd, 'receipt.economics.costUsd', { min: 0, nullable: true });
  string(value.currency, 'receipt.economics.currency', { pattern: /^[A-Z]{3}$/, max: 3, nullable: true });
  boolean(value.usageIncomplete, 'receipt.economics.usageIncomplete');
  if ((value.costUsd === null) !== (value.currency === null)) fail('receipt.economics', 'costUsd and currency must both be present or both be null');
  if (value.providerCalls !== null && value.providerCalls > campaign.controls.maximumProviderCallsPerCell) {
    fail('receipt.economics.providerCalls', 'exceeds the frozen provider-call bound');
  }
  if (value.makerCalls !== null && value.makerCalls > campaign.controls.maximumMakerCallsPerCell) {
    fail('receipt.economics.makerCalls', 'exceeds the frozen maker-call bound');
  }
  if (value.reviewerCalls !== null && value.reviewerCalls > campaign.controls.maximumReviewerCallsPerCell) {
    fail('receipt.economics.reviewerCalls', 'exceeds the frozen reviewer-call bound');
  }
  if ([value.providerCalls, value.makerCalls, value.reviewerCalls].every(item => item !== null)
      && value.providerCalls !== value.makerCalls + value.reviewerCalls) {
    fail('receipt.economics.providerCalls', 'must equal makerCalls plus reviewerCalls when complete');
  }
  if (outcome.modelCallsMade !== null && value.providerCalls !== null && outcome.modelCallsMade !== value.providerCalls) {
    fail('receipt.economics.providerCalls', 'must match outcome.modelCallsMade');
  }
  if (cell.armId === 'raw') {
    if (value.nativeProviderResponses !== null || value.nativeToolActions !== null) {
      fail('receipt.economics', 'native counters must be null for the raw arm');
    }
    if (value.makerCalls !== null && value.rawProtocolSteps !== null
        && value.rawProtocolSteps > value.makerCalls) {
      fail('receipt.economics.rawProtocolSteps', 'accepted raw protocol steps cannot exceed measured raw maker calls');
    }
  } else if (value.rawProtocolSteps !== null || value.rawFileActions !== null) {
    fail('receipt.economics', 'raw counters must be null for the native arm');
  } else if (value.makerCalls !== null && value.nativeProviderResponses !== null
      && value.makerCalls !== value.nativeProviderResponses) {
    fail('receipt.economics.nativeProviderResponses', 'must match measured native maker calls');
  }
  const tokenFields = [
    'providerCalls', 'makerCalls', 'reviewerCalls', 'makerInputTokens',
    'makerCachedInputTokens', 'makerOutputTokens', 'reviewerInputTokens',
    'reviewerCachedInputTokens', 'reviewerOutputTokens',
  ];
  if (value.usageIncomplete === false && tokenFields.some(field => value[field] === null)) {
    fail('receipt.economics.usageIncomplete', 'complete usage cannot contain null call or token measurements');
  }
  const timings = [value.wallMs, value.makerMs, value.verifierMs, value.reviewerMs];
  if (value.orchestrationMs !== null) {
    if (timings.some(item => item === null)) fail('receipt.economics.orchestrationMs', 'requires complete timing components');
    const expected = value.wallMs - value.makerMs - value.verifierMs - value.reviewerMs;
    if (expected < 0 || value.orchestrationMs !== expected) fail('receipt.economics.orchestrationMs', 'must be the non-negative derived timing remainder');
  }
}

function validateCustody(value) {
  exactObject(value, 'receipt.custody', [
    'candidateBindingMatch', 'verificationBindingMatch', 'reviewBindingMatch',
    'containmentStable', 'receiptsDegraded', 'processCleanupComplete',
  ]);
  for (const field of [
    'candidateBindingMatch', 'verificationBindingMatch', 'reviewBindingMatch',
    'containmentStable', 'receiptsDegraded', 'processCleanupComplete',
  ]) boolean(value[field], `receipt.custody.${field}`, { nullable: true });
}

function validateArtifacts(value, campaign) {
  exactObject(value, 'receipt.artifacts', [
    'sourceFixtureDigest', 'initialCandidateDigest', 'finalCandidateDigest', 'diffDigest',
    'verifierReceiptDigest', 'reviewerReceiptDigest', 'buildReportDigest', 'eventJournalDigest',
  ]);
  string(value.sourceFixtureDigest, 'receipt.artifacts.sourceFixtureDigest', { pattern: SHA256, max: 71 });
  if (value.sourceFixtureDigest !== campaign.case.fixtureTreeDigest) {
    fail('receipt.artifacts.sourceFixtureDigest', 'must match the campaign fixture tree');
  }
  for (const field of [
    'initialCandidateDigest', 'finalCandidateDigest', 'diffDigest', 'verifierReceiptDigest',
    'reviewerReceiptDigest', 'buildReportDigest', 'eventJournalDigest',
  ]) string(value[field], `receipt.artifacts.${field}`, { pattern: SHA256, max: 71, nullable: true });
}

export function deriveCodeEvalPairCellStanding(receipt) {
  if (receipt.outcome.status === 'interrupted_unknown') return 'unknown';
  const observed = receipt.outcome.status === 'candidate_ready_for_acceptance'
    && receipt.observedIdentity.identityStable === true
    && receipt.quality.mechanicalFloorPassed === true
    && receipt.quality.screenFloorPassed === true
    && receipt.custody.candidateBindingMatch === true
    && receipt.custody.verificationBindingMatch === true
    && receipt.custody.reviewBindingMatch === true
    && receipt.custody.containmentStable === true
    && receipt.custody.receiptsDegraded === false
    && receipt.custody.processCleanupComplete === true;
  return observed ? 'execution_observed' : 'failed';
}

function receiptPayload(receipt) {
  const { receiptId, ...payload } = receipt;
  return payload;
}

export function validateCodeEvalPairReceipt(receipt, campaign, execution, cell) {
  validateCodeEvalPairCell(cell, campaign, execution);
  exactObject(receipt, 'receipt', [
    'schemaVersion', 'receiptProtocol', 'receiptId', 'cellId', 'campaignDigest',
    'executionDigest', 'standing', 'assignment', 'observedIdentity', 'outcome',
    'quality', 'economics', 'custody', 'artifacts', 'recordedAt',
  ]);
  if (receipt.schemaVersion !== 1) fail('receipt.schemaVersion', 'must be 1');
  if (receipt.receiptProtocol !== CODE_EVAL_PAIR_RECEIPT_PROTOCOL) {
    fail('receipt.receiptProtocol', `must be ${CODE_EVAL_PAIR_RECEIPT_PROTOCOL}`);
  }
  string(receipt.receiptId, 'receipt.receiptId', { pattern: RECEIPT_ID, max: 75 });
  string(receipt.cellId, 'receipt.cellId', { pattern: CELL_ID, max: 70 });
  string(receipt.campaignDigest, 'receipt.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  string(receipt.executionDigest, 'receipt.executionDigest', { pattern: EXECUTION_ID, max: 75 });
  if (receipt.cellId !== codeEvalPairCellIdentity(cell, campaign, execution)) fail('receipt.cellId', 'does not match the cell');
  if (receipt.campaignDigest !== cell.campaignDigest) fail('receipt.campaignDigest', 'does not match the cell');
  if (receipt.executionDigest !== cell.executionDigest) fail('receipt.executionDigest', 'does not match the cell');
  enumValue(receipt.standing, 'receipt.standing', CELL_STANDINGS);
  validateAssignment(receipt.assignment, campaign, execution, cell);
  validateObservedIdentity(receipt.observedIdentity, campaign, execution, cell);
  validateOutcome(receipt.outcome, campaign);
  validateQuality(receipt.quality, campaign, receipt.outcome, receipt.observedIdentity);
  validateEconomics(receipt.economics, campaign, cell, receipt.outcome);
  if (campaign.pair.maker.route !== null && receipt.observedIdentity.makerRoute !== null
      && receipt.economics.makerCalls !== null
      && receipt.observedIdentity.makerRoute.metadataObserved.length !== receipt.economics.makerCalls) {
    fail('receipt.observedIdentity.makerRoute.metadataObserved', 'must contain exactly one observation per measured maker call');
  }
  validateCustody(receipt.custody);
  validateArtifacts(receipt.artifacts, campaign);
  if (receipt.quality.verificationBindingMatch !== receipt.custody.verificationBindingMatch
      || receipt.quality.reviewBindingMatch !== receipt.custody.reviewBindingMatch) {
    fail('receipt.custody', 'must agree with the corresponding quality binding evidence');
  }
  if (receipt.quality.mechanicalFloorPassed === true && (
    receipt.custody.candidateBindingMatch !== true
    || receipt.custody.containmentStable !== true
    || receipt.custody.receiptsDegraded !== false
    || receipt.custody.processCleanupComplete !== true
  )) fail('receipt.quality.mechanicalFloorPassed', 'cannot be true with incomplete custody evidence');
  if (receipt.quality.screenFloorPassed === true && (
    receipt.observedIdentity.identityStable !== true
    || receipt.observedIdentity.reviewerModel !== campaign.pair.reviewer.model
  )) fail('receipt.quality.screenFloorPassed', 'requires exact stable reviewer identity');
  canonicalIso(receipt.recordedAt, 'receipt.recordedAt');
  const standing = deriveCodeEvalPairCellStanding(receipt);
  if (receipt.standing !== standing) fail('receipt.standing', `must be derived as ${standing}`);
  if (receipt.receiptId !== contentId('codebench1', receiptPayload(receipt))) {
    fail('receipt.receiptId', 'does not match the canonical receipt payload');
  }
  return receipt;
}

export function createCodeEvalPairReceipt({
  campaign,
  execution,
  cell,
  observedIdentity,
  outcome,
  quality,
  economics,
  custody,
  artifacts,
  recordedAt = new Date().toISOString(),
}) {
  validateCodeEvalPairCell(cell, campaign, execution);
  const payload = {
    schemaVersion: 1,
    receiptProtocol: CODE_EVAL_PAIR_RECEIPT_PROTOCOL,
    cellId: codeEvalPairCellIdentity(cell, campaign, execution),
    campaignDigest: cell.campaignDigest,
    executionDigest: cell.executionDigest,
    standing: null,
    assignment: codeEvalPairReceiptAssignment(campaign, execution, cell),
    observedIdentity,
    outcome,
    quality,
    economics,
    custody,
    artifacts,
    recordedAt,
  };
  payload.standing = deriveCodeEvalPairCellStanding(payload);
  const receipt = { ...payload, receiptId: contentId('codebench1', payload) };
  return validateCodeEvalPairReceipt(receipt, campaign, execution, cell);
}

export function createUnknownCodeEvalPairReceipt({
  campaign,
  execution,
  cell,
  recordedAt = new Date().toISOString(),
  reasonCode = 'interrupted_unknown',
}) {
  validateCodeEvalPairCell(cell, campaign, execution);
  const independent = expectedReviewerIndependence(campaign);
  return createCodeEvalPairReceipt({
    campaign,
    execution,
    cell,
    recordedAt,
    observedIdentity: {
      makerModel: null,
      reviewerModel: null,
      executor: null,
      rawProtocolVersion: null,
      nativeHarness: null,
      makerRoute: null,
      qualificationBindingsMatch: null,
      connectionBindingsMatch: null,
      policyBindingMatch: null,
      identityStable: null,
      substitutionDetected: null,
      helperModelDetected: null,
      fallbackDetected: campaign.pair.maker.route === null ? false : null,
    },
    outcome: {
      status: 'interrupted_unknown',
      buildStatus: null,
      reasonCode,
      possibleBilling: true,
      modelCallsMade: null,
      candidateDiffExists: null,
      candidateFingerprint: null,
      finalCandidateCurrent: null,
      repairs: null,
      retries: null,
      questions: null,
      humanAnswers: null,
    },
    quality: {
      fixturePreflightPassed: null,
      candidateIntegrityPassed: null,
      containmentPassed: null,
      verificationRan: null,
      verificationPassed: null,
      verificationBindingMatch: null,
      reviewRan: null,
      reviewVerdict: null,
      materialFindingCount: null,
      reviewBindingMatch: null,
      reviewerIndependent: independent,
      reviewScreenStanding: independent ? 'independent_exact' : 'same_origin_advisory',
      humanInterventionDuringRun: null,
      mechanicalFloorPassed: null,
      screenFloorPassed: null,
    },
    economics: Object.fromEntries(ECONOMIC_FIELDS.map(field => [field, field === 'usageIncomplete' ? true : null])),
    custody: {
      candidateBindingMatch: null,
      verificationBindingMatch: null,
      reviewBindingMatch: null,
      containmentStable: null,
      receiptsDegraded: null,
      processCleanupComplete: null,
    },
    artifacts: {
      sourceFixtureDigest: campaign.case.fixtureTreeDigest,
      initialCandidateDigest: null,
      finalCandidateDigest: null,
      diffDigest: null,
      verifierReceiptDigest: null,
      reviewerReceiptDigest: null,
      buildReportDigest: null,
      eventJournalDigest: null,
    },
  });
}

export const codeEvalPairIdPatterns = Object.freeze({
  campaign: CAMPAIGN_ID,
  execution: EXECUTION_ID,
  cell: CELL_ID,
  receipt: RECEIPT_ID,
});
