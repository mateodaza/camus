import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_EVAL_STANDINGS,
  canonicalCodeEvalJson,
  codeEvalCampaignIdentity,
  codeEvalCellIdentity,
  codeEvalExecutionIdentity,
  createCodeEvalCell,
  createCodeEvalReceipt,
  createUnknownCodeEvalReceipt,
  validateCodeEvalCampaign,
  validateCodeEvalCell,
  validateCodeEvalExecution,
  validateCodeEvalReceipt,
} from './code-eval-contract.mjs';

const hash = (character = 'a') => `sha256:${character.repeat(64)}`;
const fixture = (character = 'f') => `fixture1:${character.repeat(64)}`;
const qualification = (character = '1') => `qual1:${character.repeat(64)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function campaign({ executor = 'qwen_native', campaignId = 'qwen-native-smoke-v1' } = {}) {
  return {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1a',
    campaignId,
    campaignMode: 'native_smoke',
    standing: 'exploratory_only',
    case: {
      caseId: 'simple-bounded-parser-fix',
      caseVersion: 1,
      taskClass: 'simple',
      fixtureId: fixture('f'),
      fixtureTreeDigest: hash('1'),
      baseCommitDigest: hash('2'),
      taskSha256: hash('3'),
      acceptanceContractSha256: hash('4'),
      verifier: {
        kind: 'host_command',
        commandSha256: hash('5'),
        timeoutMs: 120_000,
        expectedBase: 'red',
        expectedReference: 'green',
      },
    },
    treatment: {
      maker: {
        backend: executor === 'qwen_native' ? 'dashscope_qwen' : 'xai_grok',
        provider: executor === 'qwen_native' ? 'alibaba' : 'xai',
        model: executor === 'qwen_native' ? 'qwen3-coder-plus' : 'grok-code-fast-1',
        effort: null,
        trainingOrg: executor === 'qwen_native' ? 'alibaba' : 'xai',
        transport: 'direct_https',
        connection: executor === 'qwen_native' ? 'dashscope-primary' : 'xai-primary',
        route: null,
      },
      reviewer: {
        backend: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        trainingOrg: 'openai',
      },
      executor,
    },
    controls: {
      maximumCells: 1,
      maximumProviderCallsPerCell: 6,
      maximumMakerCallsPerCell: 4,
      maximumReviewerCallsPerCell: 2,
      maximumSteps: 4,
      maximumActions: 16,
      maximumRepairs: 1,
      maximumRetries: 0,
      maximumTokensReserved: 100_000,
      wallTimeoutMs: 1_200_000,
      callTimeoutMs: 600_000,
      publish: false,
      commit: false,
      merge: false,
      push: false,
      automaticRouting: false,
    },
  };
}

function execution(c, { createdAt = '2026-08-29T12:00:00.000Z' } = {}) {
  const qwen = c.treatment.executor === 'qwen_native';
  return {
    schemaVersion: 1,
    campaignDigest: codeEvalCampaignIdentity(c),
    createdAt,
    runtime: {
      packageVersion: '0.4.9',
      treeDigest: hash('6'),
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: 'v22.20.0',
    },
    maker: {
      backendDefinitionDigest: hash('7'),
      qualificationFingerprint: qualification('8'),
      credentialRevision: hash('9'),
      connectionDefinitionDigest: hash('a'),
      expectedModel: c.treatment.maker.model,
      expectedRoute: c.treatment.maker.route === null ? null : clone(c.treatment.maker.route),
    },
    reviewer: {
      backendDefinitionDigest: hash('b'),
      qualificationFingerprint: `builtin1:${'c'.repeat(64)}`,
      credentialRevision: 'none',
      connectionDefinitionDigest: hash('d'),
      expectedModel: c.treatment.reviewer.model,
    },
    nativeHarness: {
      executor: c.treatment.executor,
      name: qwen ? 'qwen_code' : 'grok_build',
      version: '1.2.3',
      artifactDigest: hash('e'),
      parserVersion: 'native-parser-v1',
      outerSandboxPolicyDigest: hash('f'),
      credentialGatewayPolicyDigest: hash('0'),
    },
    verifierDigest: hash('1'),
    fixtureReadinessDigest: hash('2'),
  };
}

function observed(executionValue) {
  return {
    makerModel: executionValue.maker.expectedModel,
    reviewerModel: executionValue.reviewer.expectedModel,
    executor: executionValue.nativeHarness.executor,
    harnessArtifactDigest: executionValue.nativeHarness.artifactDigest,
    makerRoute: executionValue.maker.expectedRoute === null ? null : {
      requestEnforced: clone(executionValue.maker.expectedRoute),
      metadataObserved: [{ provider: executionValue.maker.expectedRoute.upstreamProvider.split('/')[0], attempt: 1 }],
    },
    identityStable: true,
    substitutionDetected: false,
    helperModelDetected: false,
    fallbackDetected: false,
  };
}

function successfulReceipt(c, e, overrides = {}) {
  const cell = createCodeEvalCell(c, e);
  return createCodeEvalReceipt({
    campaign: c,
    execution: e,
    cell,
    recordedAt: '2026-08-29T12:05:00.000Z',
    observedIdentity: overrides.observedIdentity ?? observed(e),
    outcome: overrides.outcome ?? {
      status: 'candidate_ready_for_acceptance',
      reasonCode: null,
      possibleBilling: true,
      candidateFingerprint: hash('3'),
    },
    quality: overrides.quality ?? {
      fixturePreflightPassed: true,
      candidateIntegrityPassed: true,
      containmentPassed: true,
      verificationPassed: true,
      reviewVerdict: 'APPROVED',
      humanInterventionDuringRun: false,
      mechanicalFloorPassed: true,
    },
    economics: overrides.economics ?? {
      providerCalls: 2,
      makerCalls: 1,
      reviewerCalls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      wallMs: 10_000,
      costUsd: null,
      currency: null,
      usageIncomplete: false,
    },
    custody: overrides.custody ?? {
      candidateBindingMatch: true,
      verificationBindingMatch: true,
      reviewBindingMatch: true,
    },
    artifacts: overrides.artifacts ?? { buildReportDigest: hash('4') },
  });
}

export const codeEvalContractFixtures = Object.freeze({ campaign, execution, observed, successfulReceipt });

test('campaign, execution, cell, and receipt identities are canonical and exact', () => {
  const c = campaign();
  const e = execution(c);
  const cell = createCodeEvalCell(c, e);
  const receipt = successfulReceipt(c, e);
  assert.match(codeEvalCampaignIdentity(c), /^campaign1:[a-f0-9]{64}$/);
  assert.match(codeEvalExecutionIdentity(e, c), /^execution1:[a-f0-9]{64}$/);
  assert.match(codeEvalCellIdentity(cell, c, e), /^cell1:[a-f0-9]{64}$/);
  assert.match(receipt.receiptId, /^codebench1:[a-f0-9]{64}$/);
  assert.equal(receipt.standing, 'execution_observed');
  assert.deepEqual(CODE_EVAL_STANDINGS, ['execution_observed', 'failed', 'unknown']);

  const reversed = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(canonicalCodeEvalJson(reversed), canonicalCodeEvalJson(c));
  assert.equal(codeEvalCampaignIdentity(reversed), codeEvalCampaignIdentity(c));
  validateCodeEvalCampaign(c);
  validateCodeEvalExecution(e, c);
  validateCodeEvalCell(cell, c, e);
  validateCodeEvalReceipt(receipt, c, e, cell);
});

test('every v1a schema refuses unknown fields and binding drift', () => {
  const c = campaign();
  const unknownCampaign = clone(c);
  unknownCampaign.routing = true;
  assert.throws(() => validateCodeEvalCampaign(unknownCampaign), /unknown field: routing/);

  const nestedUnknown = clone(c);
  nestedUnknown.treatment.maker.endpoint = 'https://secret.invalid';
  assert.throws(() => validateCodeEvalCampaign(nestedUnknown), /unknown field: endpoint/);

  const sameOrigin = clone(c);
  sameOrigin.treatment.reviewer.trainingOrg = sameOrigin.treatment.maker.trainingOrg;
  assert.throws(() => validateCodeEvalCampaign(sameOrigin), /must be independent/);

  const underReserved = clone(c);
  underReserved.controls.maximumTokensReserved = 32767;
  assert.throws(() => validateCodeEvalCampaign(underReserved), /32768/);

  const e = execution(c);
  const unknownExecution = clone(e);
  unknownExecution.nativeHarness.unpinnedHelper = true;
  assert.throws(() => validateCodeEvalExecution(unknownExecution, c), /unknown field: unpinnedHelper/);

  const cell = createCodeEvalCell(c, e);
  const unknownCell = { ...cell, repeat: 2 };
  assert.throws(() => validateCodeEvalCell(unknownCell, c, e), /unknown field: repeat/);

  const receipt = successfulReceipt(c, e);
  const unknownReceipt = clone(receipt);
  unknownReceipt.rawProviderBody = 'forbidden';
  assert.throws(() => validateCodeEvalReceipt(unknownReceipt, c, e, cell), /unknown field: rawProviderBody/);

  const changedExecution = execution(c, { createdAt: '2026-08-29T12:00:01.000Z' });
  assert.notEqual(codeEvalExecutionIdentity(changedExecution, c), codeEvalExecutionIdentity(e, c));
  assert.throws(() => validateCodeEvalReceipt(receipt, c, changedExecution, createCodeEvalCell(c, changedExecution)), /does not match/);
});

test('native harness name and exact maker/reviewer observations stay binding', () => {
  for (const executor of ['qwen_native', 'grok_native']) {
    const c = campaign({ executor, campaignId: `${executor}-smoke` });
    const e = execution(c);
    assert.doesNotThrow(() => validateCodeEvalExecution(e, c));
    const wrongHarness = clone(e);
    wrongHarness.nativeHarness.name = executor === 'qwen_native' ? 'grok_build' : 'qwen_code';
    assert.throws(() => validateCodeEvalExecution(wrongHarness, c), /nativeHarness.name/);
  }

  const c = campaign();
  const e = execution(c);
  const wrongReviewer = observed(e);
  wrongReviewer.reviewerModel = 'substituted-reviewer';
  assert.throws(() => successfulReceipt(c, e, { observedIdentity: wrongReviewer }), /stable identity/);
  const helper = observed(e);
  helper.helperModelDetected = true;
  assert.throws(() => successfulReceipt(c, e, { observedIdentity: helper }), /stable identity/);
});

test('an exact OpenRouter route is campaign identity and receipt evidence, with fallback derived from attempts', () => {
  const c = campaign();
  c.treatment.maker.provider = 'openrouter';
  c.treatment.maker.backend = 'openrouter_qwen';
  c.treatment.maker.connection = 'openrouter-primary';
  c.treatment.maker.route = { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false };
  const e = execution(c);
  assert.doesNotThrow(() => validateCodeEvalCampaign(c));
  assert.doesNotThrow(() => validateCodeEvalExecution(e, c));
  assert.deepEqual(successfulReceipt(c, e).assignment.requestedMaker.route, c.treatment.maker.route);

  const changed = clone(c);
  changed.treatment.maker.route.upstreamProvider = 'together/fp8';
  assert.notEqual(codeEvalCampaignIdentity(changed), codeEvalCampaignIdentity(c));

  const missing = clone(c);
  missing.treatment.maker.route = null;
  assert.throws(() => validateCodeEvalCampaign(missing), /treatment\.maker\.route/);
  const directRoute = campaign();
  directRoute.treatment.maker.route = clone(c.treatment.maker.route);
  assert.throws(() => validateCodeEvalCampaign(directRoute), /null unless provider is openrouter/);
  const driftedExecution = clone(e);
  driftedExecution.maker.expectedRoute.upstreamProvider = 'together/fp8';
  assert.throws(() => validateCodeEvalExecution(driftedExecution, c), /expectedRoute/);

  const fallback = observed(e);
  fallback.identityStable = false;
  fallback.fallbackDetected = true;
  fallback.makerRoute.metadataObserved[0].attempt = 2;
  assert.equal(successfulReceipt(c, e, { observedIdentity: fallback }).standing, 'failed');
  fallback.fallbackDetected = false;
  assert.throws(() => successfulReceipt(c, e, { observedIdentity: fallback }), /derived from the route observation/);

  const wrongCount = observed(e);
  wrongCount.makerRoute.metadataObserved.push({ provider: 'DeepInfra', attempt: 1 });
  wrongCount.identityStable = false;
  assert.throws(() => successfulReceipt(c, e, { observedIdentity: wrongCount }), /one observation per measured maker call/);
});

test('standing is derived conservatively from terminal, identity, quality, and all custody bindings', () => {
  const c = campaign();
  const e = execution(c);
  assert.equal(successfulReceipt(c, e).standing, 'execution_observed');

  const reviewDrift = successfulReceipt(c, e, {
    custody: {
      candidateBindingMatch: true,
      verificationBindingMatch: true,
      reviewBindingMatch: false,
    },
  });
  assert.equal(reviewDrift.standing, 'failed');

  const revisionRequested = successfulReceipt(c, e, {
    quality: {
      fixturePreflightPassed: true,
      candidateIntegrityPassed: true,
      containmentPassed: true,
      verificationPassed: true,
      reviewVerdict: 'REVISE',
      humanInterventionDuringRun: false,
      mechanicalFloorPassed: true,
    },
  });
  assert.equal(revisionRequested.standing, 'failed');

  const knownFailure = successfulReceipt(c, e, {
    outcome: {
      status: 'verification_failed',
      reasonCode: 'verifier_red',
      possibleBilling: true,
      candidateFingerprint: hash('3'),
    },
    quality: {
      fixturePreflightPassed: true,
      candidateIntegrityPassed: true,
      containmentPassed: true,
      verificationPassed: false,
      reviewVerdict: null,
      humanInterventionDuringRun: false,
      mechanicalFloorPassed: false,
    },
    custody: {
      candidateBindingMatch: true,
      verificationBindingMatch: true,
      reviewBindingMatch: null,
    },
  });
  assert.equal(knownFailure.standing, 'failed');

  assert.throws(() => successfulReceipt(c, e, {
    economics: {
      providerCalls: 6,
      makerCalls: 5,
      reviewerCalls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      wallMs: 10_000,
      costUsd: null,
      currency: null,
      usageIncomplete: false,
    },
  }), /maker-call bound/);

  const unknown = createUnknownCodeEvalReceipt({
    campaign: c,
    execution: e,
    recordedAt: '2026-08-29T12:06:00.000Z',
  });
  assert.equal(unknown.standing, 'unknown');

  const tampered = clone(successfulReceipt(c, e));
  tampered.receiptId = `codebench1:${'0'.repeat(64)}`;
  assert.throws(
    () => validateCodeEvalReceipt(tampered, c, e, createCodeEvalCell(c, e)),
    /canonical receipt payload/,
  );
});
