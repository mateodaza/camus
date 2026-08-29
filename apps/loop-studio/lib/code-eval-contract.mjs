// Spend-free Code Harness Eval v1a evidence contracts.
//
// This module deliberately models one native smoke cell only. It has no runner,
// provider, routing, admission, or comparison authority. Every accepted object is
// a closed schema so its content identity cannot silently omit treatment fields.

import { createHash } from 'node:crypto';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FIXTURE_ID = /^fixture1:[a-f0-9]{64}$/;
const CAMPAIGN_ID = /^campaign1:[a-f0-9]{64}$/;
const EXECUTION_ID = /^execution1:[a-f0-9]{64}$/;
const CELL_ID = /^cell1:[a-f0-9]{64}$/;
const RECEIPT_ID = /^codebench1:[a-f0-9]{64}$/;
const QUALIFICATION = /^(?:qual1|builtin1):[a-f0-9]{64}$/;
const REVISION = /^(?:(?:cred1|sha256):[a-f0-9]{64}|[a-f0-9]{64}|none)$/;
const ROUTE_SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,63})(?:\/[a-z0-9](?:[a-z0-9._-]{0,63}))*$/;
const OBSERVED_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9 ._()+\/-]{0,127}$/;

export const CODE_EVAL_STANDINGS = Object.freeze([
  'execution_observed',
  'failed',
  'unknown',
]);

export const CODE_EVAL_OUTCOMES = Object.freeze([
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
export const CODE_EVAL_MIN_TOKEN_BUDGET = 32768;

const STANDINGS = new Set(CODE_EVAL_STANDINGS);
const OUTCOMES = new Set(CODE_EVAL_OUTCOMES);
const EXECUTORS = new Set(['qwen_native', 'grok_native']);
const TRANSPORTS = new Set(['vendor_managed', 'loopback', 'direct_https', 'ssh_tunnel']);

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
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length) fail(path, `contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (missing.length) fail(path, `is missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  return value;
}

function string(value, path, { pattern = null, max = 256 } = {}) {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) {
    fail(path, `must be a non-empty trimmed string of at most ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function nullableString(value, path, options) {
  return value === null ? null : string(value, path, options);
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

function jsonShape(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(path, 'contains a non-canonical number');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonShape(entry, `${path}[${index}]`));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'contains a non-JSON value');
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail(`${path}.${key}`, 'must not be undefined');
    result[key] = jsonShape(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalCodeEvalJson(value) {
  return JSON.stringify(jsonShape(value));
}

function contentId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(canonicalCodeEvalJson(value), 'utf8').digest('hex')}`;
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

const comparableProvider = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function routeObservationStatus(value, campaignRoute) {
  if (value === null) return { complete: false, fallbackDetected: null, stable: false };
  const expectedBase = campaignRoute.upstreamProvider.split('/')[0];
  const providersMatch = value.metadataObserved.every(item =>
    comparableProvider(item.provider) === comparableProvider(expectedBase));
  const fallbackDetected = value.metadataObserved.some(item => item.attempt !== 1);
  return { complete: true, fallbackDetected, stable: providersMatch && !fallbackDetected };
}

function validateRouteObservation(value, campaignRoute, path) {
  if (value === null) return value;
  exactObject(value, path, ['requestEnforced', 'metadataObserved']);
  exactObject(value.requestEnforced, `${path}.requestEnforced`, ['upstreamProvider', 'allowFallbacks']);
  string(value.requestEnforced.upstreamProvider, `${path}.requestEnforced.upstreamProvider`, { pattern: ROUTE_SLUG, max: 128 });
  if (value.requestEnforced.allowFallbacks !== false) fail(`${path}.requestEnforced.allowFallbacks`, 'must be false');
  if (canonicalCodeEvalJson(value.requestEnforced) !== canonicalCodeEvalJson(campaignRoute)) {
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

function validateSeat(seat, path, { reviewer = false } = {}) {
  exactObject(seat, path, reviewer
    ? ['backend', 'model', 'effort', 'trainingOrg']
    : ['backend', 'provider', 'model', 'effort', 'trainingOrg', 'transport', 'connection', 'route']);
  string(seat.backend, `${path}.backend`, { pattern: SAFE_NAME, max: 64 });
  if (!reviewer) string(seat.provider, `${path}.provider`, { pattern: SAFE_NAME, max: 64 });
  string(seat.model, `${path}.model`, { pattern: MODEL_ID, max: 128 });
  nullableString(seat.effort, `${path}.effort`, { pattern: SAFE_NAME, max: 64 });
  string(seat.trainingOrg, `${path}.trainingOrg`, { pattern: SAFE_NAME, max: 64 });
  if (!reviewer) {
    enumValue(seat.transport, `${path}.transport`, TRANSPORTS);
    string(seat.connection, `${path}.connection`, { pattern: SAFE_NAME, max: 64 });
    validateRoute(seat.route, seat.provider, `${path}.route`);
  }
}

function validateCase(value) {
  exactObject(value, 'campaign.case', [
    'caseId', 'caseVersion', 'taskClass', 'fixtureId', 'fixtureTreeDigest',
    'baseCommitDigest', 'taskSha256', 'acceptanceContractSha256', 'verifier',
  ]);
  string(value.caseId, 'campaign.case.caseId', { pattern: SAFE_NAME, max: 64 });
  integer(value.caseVersion, 'campaign.case.caseVersion', { min: 1, max: 1_000_000 });
  if (value.taskClass !== 'simple') fail('campaign.case.taskClass', 'must be simple in v1a');
  string(value.fixtureId, 'campaign.case.fixtureId', { pattern: FIXTURE_ID, max: 73 });
  for (const field of ['fixtureTreeDigest', 'baseCommitDigest', 'taskSha256', 'acceptanceContractSha256']) {
    string(value[field], `campaign.case.${field}`, { pattern: SHA256, max: 71 });
  }
  exactObject(value.verifier, 'campaign.case.verifier', [
    'kind', 'commandSha256', 'timeoutMs', 'expectedBase', 'expectedReference',
  ]);
  if (value.verifier.kind !== 'host_command') fail('campaign.case.verifier.kind', 'must be host_command');
  string(value.verifier.commandSha256, 'campaign.case.verifier.commandSha256', { pattern: SHA256, max: 71 });
  integer(value.verifier.timeoutMs, 'campaign.case.verifier.timeoutMs', { min: 1, max: 3_600_000 });
  if (value.verifier.expectedBase !== 'red') fail('campaign.case.verifier.expectedBase', 'must be red');
  if (value.verifier.expectedReference !== 'green') fail('campaign.case.verifier.expectedReference', 'must be green');
}

function validateControls(value) {
  exactObject(value, 'campaign.controls', [
    'maximumCells', 'maximumProviderCallsPerCell', 'maximumMakerCallsPerCell',
    'maximumReviewerCallsPerCell', 'maximumSteps', 'maximumActions',
    'maximumRepairs', 'maximumRetries', 'maximumTokensReserved', 'wallTimeoutMs',
    'callTimeoutMs', 'publish', 'commit', 'merge', 'push', 'automaticRouting',
  ]);
  if (value.maximumCells !== 1) fail('campaign.controls.maximumCells', 'must be exactly 1 in v1a');
  integer(value.maximumProviderCallsPerCell, 'campaign.controls.maximumProviderCallsPerCell', { min: 1, max: 128 });
  integer(value.maximumMakerCallsPerCell, 'campaign.controls.maximumMakerCallsPerCell', { min: 1, max: 128 });
  integer(value.maximumReviewerCallsPerCell, 'campaign.controls.maximumReviewerCallsPerCell', { min: 1, max: 16 });
  if (value.maximumProviderCallsPerCell < value.maximumMakerCallsPerCell + value.maximumReviewerCallsPerCell) {
    fail('campaign.controls.maximumProviderCallsPerCell', 'must cover the maker and reviewer call bounds');
  }
  integer(value.maximumSteps, 'campaign.controls.maximumSteps', { min: 1, max: 128 });
  integer(value.maximumActions, 'campaign.controls.maximumActions', { min: 1, max: 1_024 });
  integer(value.maximumRepairs, 'campaign.controls.maximumRepairs', { min: 0, max: 16 });
  integer(value.maximumRetries, 'campaign.controls.maximumRetries', { min: 0, max: 16 });
  integer(value.maximumTokensReserved, 'campaign.controls.maximumTokensReserved', { min: CODE_EVAL_MIN_TOKEN_BUDGET, max: 100_000_000 });
  integer(value.wallTimeoutMs, 'campaign.controls.wallTimeoutMs', { min: 1, max: 86_400_000 });
  integer(value.callTimeoutMs, 'campaign.controls.callTimeoutMs', { min: 1, max: 3_600_000 });
  if (value.callTimeoutMs > value.wallTimeoutMs) fail('campaign.controls.callTimeoutMs', 'must not exceed wallTimeoutMs');
  for (const field of ['publish', 'commit', 'merge', 'push', 'automaticRouting']) {
    if (value[field] !== false) fail(`campaign.controls.${field}`, 'must be false');
  }
}

export function validateCodeEvalCampaign(value) {
  exactObject(value, 'campaign', [
    'schemaVersion', 'treatmentProtocol', 'campaignId', 'campaignMode', 'standing',
    'case', 'treatment', 'controls',
  ]);
  if (value.schemaVersion !== 1) fail('campaign.schemaVersion', 'must be 1');
  if (value.treatmentProtocol !== 'code-harness-eval-v1a') {
    fail('campaign.treatmentProtocol', 'must be code-harness-eval-v1a');
  }
  string(value.campaignId, 'campaign.campaignId', { pattern: SAFE_NAME, max: 64 });
  if (value.campaignMode !== 'native_smoke') fail('campaign.campaignMode', 'must be native_smoke');
  if (value.standing !== 'exploratory_only') fail('campaign.standing', 'must be exploratory_only');
  validateCase(value.case);
  exactObject(value.treatment, 'campaign.treatment', ['maker', 'reviewer', 'executor']);
  validateSeat(value.treatment.maker, 'campaign.treatment.maker');
  validateSeat(value.treatment.reviewer, 'campaign.treatment.reviewer', { reviewer: true });
  if (value.treatment.maker.trainingOrg === value.treatment.reviewer.trainingOrg) {
    fail('campaign.treatment.reviewer.trainingOrg', 'must be independent from the maker training organization in v1a');
  }
  enumValue(value.treatment.executor, 'campaign.treatment.executor', EXECUTORS);
  validateControls(value.controls);
  return value;
}

export function codeEvalCampaignIdentity(campaign) {
  validateCodeEvalCampaign(campaign);
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
    'backendDefinitionDigest', 'qualificationFingerprint', 'credentialRevision',
    'connectionDefinitionDigest', 'expectedModel', ...(maker ? ['expectedRoute'] : []),
  ]);
  string(value.backendDefinitionDigest, `${path}.backendDefinitionDigest`, { pattern: SHA256, max: 71 });
  string(value.qualificationFingerprint, `${path}.qualificationFingerprint`, { pattern: QUALIFICATION, max: 73 });
  string(value.credentialRevision, `${path}.credentialRevision`, { pattern: REVISION, max: 71 });
  string(value.connectionDefinitionDigest, `${path}.connectionDefinitionDigest`, { pattern: SHA256, max: 71 });
  string(value.expectedModel, `${path}.expectedModel`, { pattern: MODEL_ID, max: 128 });
  if (value.expectedModel !== campaignSeat.model) fail(`${path}.expectedModel`, 'must match the campaign seat');
  if (maker) {
    validateRoute(value.expectedRoute, campaignSeat.provider, `${path}.expectedRoute`);
    if (canonicalCodeEvalJson(value.expectedRoute) !== canonicalCodeEvalJson(campaignSeat.route)) {
      fail(`${path}.expectedRoute`, 'must match the campaign seat route');
    }
  }
}

function validateHarness(value, executor) {
  exactObject(value, 'execution.nativeHarness', [
    'executor', 'name', 'version', 'artifactDigest', 'parserVersion',
    'outerSandboxPolicyDigest', 'credentialGatewayPolicyDigest',
  ]);
  if (value.executor !== executor) fail('execution.nativeHarness.executor', 'must match the campaign executor');
  const expectedName = executor === 'qwen_native' ? 'qwen_code' : 'grok_build';
  if (value.name !== expectedName) fail('execution.nativeHarness.name', `must be ${expectedName}`);
  string(value.version, 'execution.nativeHarness.version', { pattern: SAFE_VALUE, max: 64 });
  string(value.artifactDigest, 'execution.nativeHarness.artifactDigest', { pattern: SHA256, max: 71 });
  string(value.parserVersion, 'execution.nativeHarness.parserVersion', { pattern: SAFE_VALUE, max: 64 });
  string(value.outerSandboxPolicyDigest, 'execution.nativeHarness.outerSandboxPolicyDigest', { pattern: SHA256, max: 71 });
  string(value.credentialGatewayPolicyDigest, 'execution.nativeHarness.credentialGatewayPolicyDigest', { pattern: SHA256, max: 71 });
}

export function validateCodeEvalExecution(value, campaign) {
  validateCodeEvalCampaign(campaign);
  exactObject(value, 'execution', [
    'schemaVersion', 'campaignDigest', 'createdAt', 'runtime', 'maker', 'reviewer',
    'nativeHarness', 'verifierDigest', 'fixtureReadinessDigest',
  ]);
  if (value.schemaVersion !== 1) fail('execution.schemaVersion', 'must be 1');
  const campaignDigest = codeEvalCampaignIdentity(campaign);
  string(value.campaignDigest, 'execution.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  if (value.campaignDigest !== campaignDigest) fail('execution.campaignDigest', 'does not match the campaign');
  canonicalIso(value.createdAt, 'execution.createdAt');
  validateRuntime(value.runtime);
  validateExecutionSeat(value.maker, 'execution.maker', campaign.treatment.maker, { maker: true });
  validateExecutionSeat(value.reviewer, 'execution.reviewer', campaign.treatment.reviewer);
  validateHarness(value.nativeHarness, campaign.treatment.executor);
  string(value.verifierDigest, 'execution.verifierDigest', { pattern: SHA256, max: 71 });
  string(value.fixtureReadinessDigest, 'execution.fixtureReadinessDigest', { pattern: SHA256, max: 71 });
  return value;
}

export function codeEvalExecutionIdentity(execution, campaign) {
  validateCodeEvalExecution(execution, campaign);
  return contentId('execution1', execution);
}

export function createCodeEvalCell(campaign, execution) {
  const campaignDigest = codeEvalCampaignIdentity(campaign);
  const executionDigest = codeEvalExecutionIdentity(execution, campaign);
  return {
    schemaVersion: 1,
    campaignDigest,
    executionDigest,
    taskClass: 'simple',
    caseId: campaign.case.caseId,
    executor: campaign.treatment.executor,
    ordinal: 1,
  };
}

export function validateCodeEvalCell(value, campaign, execution) {
  validateCodeEvalExecution(execution, campaign);
  exactObject(value, 'cell', [
    'schemaVersion', 'campaignDigest', 'executionDigest', 'taskClass', 'caseId',
    'executor', 'ordinal',
  ]);
  if (value.schemaVersion !== 1) fail('cell.schemaVersion', 'must be 1');
  string(value.campaignDigest, 'cell.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  string(value.executionDigest, 'cell.executionDigest', { pattern: EXECUTION_ID, max: 75 });
  if (value.campaignDigest !== codeEvalCampaignIdentity(campaign)) fail('cell.campaignDigest', 'does not match the campaign');
  if (value.executionDigest !== codeEvalExecutionIdentity(execution, campaign)) fail('cell.executionDigest', 'does not match the execution');
  if (value.taskClass !== 'simple') fail('cell.taskClass', 'must be simple in v1a');
  if (value.caseId !== campaign.case.caseId) fail('cell.caseId', 'must match the campaign case');
  if (value.executor !== campaign.treatment.executor) fail('cell.executor', 'must match the campaign executor');
  if (value.ordinal !== 1) fail('cell.ordinal', 'must be exactly 1 in v1a');
  return value;
}

export function codeEvalCellIdentity(cell, campaign, execution) {
  validateCodeEvalCell(cell, campaign, execution);
  return contentId('cell1', cell);
}

export function codeEvalReceiptAssignment(campaign, execution, cell) {
  validateCodeEvalCell(cell, campaign, execution);
  return {
    taskClass: cell.taskClass,
    caseId: cell.caseId,
    executor: cell.executor,
    requestedMaker: {
      backend: campaign.treatment.maker.backend,
      model: campaign.treatment.maker.model,
      route: campaign.treatment.maker.route === null ? null : { ...campaign.treatment.maker.route },
    },
    requestedReviewer: {
      backend: campaign.treatment.reviewer.backend,
      model: campaign.treatment.reviewer.model,
    },
    makerQualificationFingerprint: execution.maker.qualificationFingerprint,
    reviewerQualificationFingerprint: execution.reviewer.qualificationFingerprint,
    harnessArtifactDigest: execution.nativeHarness.artifactDigest,
    fixtureId: campaign.case.fixtureId,
    fixtureTreeDigest: campaign.case.fixtureTreeDigest,
    verifierDigest: execution.verifierDigest,
    controlsDigest: contentId('controls1', campaign.controls),
  };
}

function validateAssignment(value, expected) {
  exactObject(value, 'receipt.assignment', [
    'taskClass', 'caseId', 'executor', 'requestedMaker', 'requestedReviewer',
    'makerQualificationFingerprint', 'reviewerQualificationFingerprint',
    'harnessArtifactDigest', 'fixtureId', 'fixtureTreeDigest', 'verifierDigest',
    'controlsDigest',
  ]);
  exactObject(value.requestedMaker, 'receipt.assignment.requestedMaker', ['backend', 'model', 'route']);
  exactObject(value.requestedReviewer, 'receipt.assignment.requestedReviewer', ['backend', 'model']);
  if (canonicalCodeEvalJson(value) !== canonicalCodeEvalJson(expected)) {
    fail('receipt.assignment', 'does not match the frozen campaign, execution, and cell');
  }
}

function validateObservedIdentity(value, execution, campaign) {
  exactObject(value, 'receipt.observedIdentity', [
    'makerModel', 'reviewerModel', 'executor', 'harnessArtifactDigest',
    'makerRoute', 'identityStable', 'substitutionDetected', 'helperModelDetected', 'fallbackDetected',
  ]);
  nullableString(value.makerModel, 'receipt.observedIdentity.makerModel', { pattern: MODEL_ID, max: 128 });
  nullableString(value.reviewerModel, 'receipt.observedIdentity.reviewerModel', { pattern: MODEL_ID, max: 128 });
  nullableString(value.executor, 'receipt.observedIdentity.executor', { pattern: SAFE_NAME, max: 64 });
  nullableString(value.harnessArtifactDigest, 'receipt.observedIdentity.harnessArtifactDigest', { pattern: SHA256, max: 71 });
  if (campaign.treatment.maker.route === null) {
    if (value.makerRoute !== null) fail('receipt.observedIdentity.makerRoute', 'must be null for a non-OpenRouter campaign');
  } else {
    validateRouteObservation(value.makerRoute, campaign.treatment.maker.route, 'receipt.observedIdentity.makerRoute');
  }
  boolean(value.identityStable, 'receipt.observedIdentity.identityStable', { nullable: true });
  boolean(value.substitutionDetected, 'receipt.observedIdentity.substitutionDetected', { nullable: true });
  boolean(value.helperModelDetected, 'receipt.observedIdentity.helperModelDetected', { nullable: true });
  boolean(value.fallbackDetected, 'receipt.observedIdentity.fallbackDetected', { nullable: true });
  const routeStatus = campaign.treatment.maker.route === null
    ? { complete: true, fallbackDetected: false, stable: value.makerRoute === null }
    : routeObservationStatus(value.makerRoute, campaign.treatment.maker.route);
  if (value.fallbackDetected !== routeStatus.fallbackDetected) {
    fail('receipt.observedIdentity.fallbackDetected', 'must be derived from the route observation');
  }
  if (value.identityStable === true && (
    value.makerModel !== execution.maker.expectedModel
    || value.reviewerModel !== execution.reviewer.expectedModel
    || value.executor !== execution.nativeHarness.executor
    || value.harnessArtifactDigest !== execution.nativeHarness.artifactDigest
    || value.substitutionDetected !== false
    || value.helperModelDetected !== false
    || value.fallbackDetected !== false
    || !routeStatus.complete
    || !routeStatus.stable
  )) fail('receipt.observedIdentity', 'cannot claim stable identity with mismatched or incomplete observations');
}

function validateOutcome(value) {
  exactObject(value, 'receipt.outcome', [
    'status', 'reasonCode', 'possibleBilling', 'candidateFingerprint',
  ]);
  enumValue(value.status, 'receipt.outcome.status', OUTCOMES);
  nullableString(value.reasonCode, 'receipt.outcome.reasonCode', { pattern: SAFE_VALUE, max: 128 });
  boolean(value.possibleBilling, 'receipt.outcome.possibleBilling');
  nullableString(value.candidateFingerprint, 'receipt.outcome.candidateFingerprint', { pattern: SHA256, max: 71 });
}

function validateQuality(value) {
  exactObject(value, 'receipt.quality', [
    'fixturePreflightPassed', 'candidateIntegrityPassed', 'containmentPassed',
    'verificationPassed', 'reviewVerdict', 'humanInterventionDuringRun',
    'mechanicalFloorPassed',
  ]);
  boolean(value.fixturePreflightPassed, 'receipt.quality.fixturePreflightPassed', { nullable: true });
  boolean(value.candidateIntegrityPassed, 'receipt.quality.candidateIntegrityPassed', { nullable: true });
  boolean(value.containmentPassed, 'receipt.quality.containmentPassed', { nullable: true });
  boolean(value.verificationPassed, 'receipt.quality.verificationPassed', { nullable: true });
  enumValue(value.reviewVerdict, 'receipt.quality.reviewVerdict', new Set(['APPROVED', 'REVISE']), { nullable: true });
  boolean(value.humanInterventionDuringRun, 'receipt.quality.humanInterventionDuringRun', { nullable: true });
  boolean(value.mechanicalFloorPassed, 'receipt.quality.mechanicalFloorPassed', { nullable: true });
  if (value.mechanicalFloorPassed === true && (
    value.fixturePreflightPassed !== true || value.candidateIntegrityPassed !== true
    || value.containmentPassed !== true || value.verificationPassed !== true
    || value.humanInterventionDuringRun !== false
  )) fail('receipt.quality.mechanicalFloorPassed', 'cannot be true unless every mechanical prerequisite is true');
}

function validateEconomics(value, campaign) {
  exactObject(value, 'receipt.economics', [
    'providerCalls', 'makerCalls', 'reviewerCalls', 'inputTokens', 'outputTokens',
    'wallMs', 'costUsd', 'currency', 'usageIncomplete',
  ]);
  for (const field of ['providerCalls', 'makerCalls', 'reviewerCalls', 'inputTokens', 'outputTokens', 'wallMs']) {
    integer(value[field], `receipt.economics.${field}`, { min: 0, nullable: true });
  }
  finiteNumber(value.costUsd, 'receipt.economics.costUsd', { min: 0, nullable: true });
  nullableString(value.currency, 'receipt.economics.currency', { pattern: /^[A-Z]{3}$/, max: 3 });
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
  if ([value.providerCalls, value.makerCalls, value.reviewerCalls].every(entry => entry !== null)
      && value.providerCalls !== value.makerCalls + value.reviewerCalls) {
    fail('receipt.economics', 'providerCalls must equal makerCalls plus reviewerCalls when all are known');
  }
  if (value.usageIncomplete === false && [
    value.providerCalls, value.makerCalls, value.reviewerCalls,
    value.inputTokens, value.outputTokens, value.wallMs,
  ].some((entry) => entry === null)) fail('receipt.economics', 'complete usage cannot contain null measurements');
}

function validateCustody(value) {
  exactObject(value, 'receipt.custody', [
    'candidateBindingMatch', 'verificationBindingMatch', 'reviewBindingMatch',
  ]);
  for (const field of ['candidateBindingMatch', 'verificationBindingMatch', 'reviewBindingMatch']) {
    boolean(value[field], `receipt.custody.${field}`, { nullable: true });
  }
}

function validateArtifacts(value) {
  exactObject(value, 'receipt.artifacts', ['buildReportDigest']);
  nullableString(value.buildReportDigest, 'receipt.artifacts.buildReportDigest', { pattern: SHA256, max: 71 });
}

export function deriveCodeEvalStanding(receipt) {
  if (receipt.outcome.status === 'interrupted_unknown') return 'unknown';
  const observed = receipt.outcome.status === 'candidate_ready_for_acceptance'
    && receipt.observedIdentity.identityStable === true
    && receipt.quality.mechanicalFloorPassed === true
    && receipt.quality.reviewVerdict === 'APPROVED'
    && receipt.custody.candidateBindingMatch === true
    && receipt.custody.verificationBindingMatch === true
    && receipt.custody.reviewBindingMatch === true;
  return observed ? 'execution_observed' : 'failed';
}

function receiptPayload(receipt) {
  const { receiptId, ...payload } = receipt;
  return payload;
}

export function validateCodeEvalReceipt(receipt, campaign, execution, cell) {
  validateCodeEvalCell(cell, campaign, execution);
  exactObject(receipt, 'receipt', [
    'schemaVersion', 'receiptId', 'cellId', 'campaignDigest', 'executionDigest',
    'standing', 'assignment', 'observedIdentity', 'outcome', 'quality', 'economics',
    'custody', 'artifacts', 'recordedAt',
  ]);
  if (receipt.schemaVersion !== 1) fail('receipt.schemaVersion', 'must be 1');
  string(receipt.receiptId, 'receipt.receiptId', { pattern: RECEIPT_ID, max: 75 });
  string(receipt.cellId, 'receipt.cellId', { pattern: CELL_ID, max: 70 });
  string(receipt.campaignDigest, 'receipt.campaignDigest', { pattern: CAMPAIGN_ID, max: 74 });
  string(receipt.executionDigest, 'receipt.executionDigest', { pattern: EXECUTION_ID, max: 75 });
  if (receipt.cellId !== codeEvalCellIdentity(cell, campaign, execution)) fail('receipt.cellId', 'does not match the cell');
  if (receipt.campaignDigest !== cell.campaignDigest) fail('receipt.campaignDigest', 'does not match the cell');
  if (receipt.executionDigest !== cell.executionDigest) fail('receipt.executionDigest', 'does not match the cell');
  enumValue(receipt.standing, 'receipt.standing', STANDINGS);
  validateAssignment(receipt.assignment, codeEvalReceiptAssignment(campaign, execution, cell));
  validateObservedIdentity(receipt.observedIdentity, execution, campaign);
  validateOutcome(receipt.outcome);
  validateQuality(receipt.quality);
  validateEconomics(receipt.economics, campaign);
  if (campaign.treatment.maker.route !== null && receipt.observedIdentity.makerRoute !== null
      && receipt.economics.makerCalls !== null
      && receipt.observedIdentity.makerRoute.metadataObserved.length !== receipt.economics.makerCalls) {
    fail('receipt.observedIdentity.makerRoute.metadataObserved', 'must contain exactly one observation per measured maker call');
  }
  validateCustody(receipt.custody);
  validateArtifacts(receipt.artifacts);
  canonicalIso(receipt.recordedAt, 'receipt.recordedAt');
  const standing = deriveCodeEvalStanding(receipt);
  if (receipt.standing !== standing) fail('receipt.standing', `must be derived as ${standing}`);
  if (receipt.receiptId !== contentId('codebench1', receiptPayload(receipt))) {
    fail('receipt.receiptId', 'does not match the canonical receipt payload');
  }
  return receipt;
}

export function createCodeEvalReceipt({
  campaign,
  execution,
  cell = createCodeEvalCell(campaign, execution),
  observedIdentity,
  outcome,
  quality,
  economics,
  custody,
  artifacts,
  recordedAt = new Date().toISOString(),
}) {
  validateCodeEvalCell(cell, campaign, execution);
  const payload = {
    schemaVersion: 1,
    cellId: codeEvalCellIdentity(cell, campaign, execution),
    campaignDigest: cell.campaignDigest,
    executionDigest: cell.executionDigest,
    standing: null,
    assignment: codeEvalReceiptAssignment(campaign, execution, cell),
    observedIdentity,
    outcome,
    quality,
    economics,
    custody,
    artifacts,
    recordedAt,
  };
  payload.standing = deriveCodeEvalStanding(payload);
  const receipt = { ...payload, receiptId: contentId('codebench1', payload) };
  return validateCodeEvalReceipt(receipt, campaign, execution, cell);
}

export function createUnknownCodeEvalReceipt({
  campaign,
  execution,
  cell = createCodeEvalCell(campaign, execution),
  recordedAt = new Date().toISOString(),
  reasonCode = 'interrupted_unknown',
}) {
  return createCodeEvalReceipt({
    campaign,
    execution,
    cell,
    recordedAt,
    observedIdentity: {
      makerModel: null,
      reviewerModel: null,
      executor: null,
      harnessArtifactDigest: null,
      makerRoute: null,
      identityStable: null,
      substitutionDetected: null,
      helperModelDetected: null,
      fallbackDetected: campaign.treatment.maker.route === null ? false : null,
    },
    outcome: {
      status: 'interrupted_unknown',
      reasonCode,
      possibleBilling: true,
      candidateFingerprint: null,
    },
    quality: {
      fixturePreflightPassed: null,
      candidateIntegrityPassed: null,
      containmentPassed: null,
      verificationPassed: null,
      reviewVerdict: null,
      humanInterventionDuringRun: null,
      mechanicalFloorPassed: null,
    },
    economics: {
      providerCalls: null,
      makerCalls: null,
      reviewerCalls: null,
      inputTokens: null,
      outputTokens: null,
      wallMs: null,
      costUsd: null,
      currency: null,
      usageIncomplete: true,
    },
    custody: {
      candidateBindingMatch: null,
      verificationBindingMatch: null,
      reviewBindingMatch: null,
    },
    artifacts: { buildReportDigest: null },
  });
}

export const codeEvalIdPatterns = Object.freeze({
  campaign: CAMPAIGN_ID,
  execution: EXECUTION_ID,
  cell: CELL_ID,
  receipt: RECEIPT_ID,
});
