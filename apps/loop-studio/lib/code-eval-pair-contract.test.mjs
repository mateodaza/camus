import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_EVAL_PAIR_CELL_STANDINGS,
  canonicalCodeEvalPairJson,
  codeEvalPairArmForCell,
  codeEvalPairCampaignIdentity,
  codeEvalPairCellIdentity,
  codeEvalPairExecutionIdentity,
  codeEvalPairReceiptAssignment,
  createCodeEvalPairCell,
  createCodeEvalPairCells,
  createCodeEvalPairReceipt,
  createUnknownCodeEvalPairReceipt,
  validateCodeEvalPairCampaign,
  validateCodeEvalPairCell,
  validateCodeEvalPairExecution,
  validateCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';

const hash = (character = 'a') => `sha256:${character.repeat(64)}`;
const fixtureId = (character = 'f') => `fixture1:${character.repeat(64)}`;
const qualification = (character = '1') => `qual1:${character.repeat(64)}`;
const clone = value => JSON.parse(JSON.stringify(value));

function campaign({ nativeExecutor = 'qwen_native', sameOrigin = false } = {}) {
  return {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1b',
    campaignId: 'qwen-simple-raw-native-v1b',
    campaignMode: 'isolation_pair',
    standing: 'exploratory_only',
    case: {
      caseId: 'simple-bounded-parser-fix',
      caseVersion: 1,
      taskClass: 'simple',
      fixtureId: fixtureId(),
      fixtureTreeDigest: hash('1'),
      baseCommitDigest: hash('2'),
      taskSha256: hash('3'),
      acceptanceContractSha256: hash('4'),
      verifier: {
        kind: 'host_command',
        commandSha256: hash('5'),
        timeoutMs: 15_000,
        expectedBase: 'red',
        expectedReference: 'green',
      },
    },
    pair: {
      pairId: 'qwen-simple-pair',
      maker: {
        backend: 'openrouter_qwen',
        provider: 'openrouter',
        model: 'qwen/qwen3.8-max',
        effort: null,
        trainingOrg: 'alibaba',
        transport: 'direct_https',
        connection: 'openrouter-primary',
        route: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false },
      },
      reviewer: {
        backend: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        trainingOrg: sameOrigin ? 'alibaba' : 'openai',
      },
      arms: [
        { armId: 'raw', makerExecutor: 'file_actions' },
        { armId: 'native', makerExecutor: nativeExecutor },
      ],
    },
    controls: {
      repeatsPerArmCase: 1,
      maximumCells: 2,
      maximumProviderCallsPerCell: 3,
      maximumMakerCallsPerCell: 2,
      maximumReviewerCallsPerCell: 1,
      maximumSteps: 4,
      maximumActions: 8,
      maximumRepairs: 0,
      maximumRetries: 0,
      maximumTokensReserved: 32768,
      semanticPromptEnvelopeVersion: 'code-harness-eval-v1b',
      wallTimeoutMs: 120_000,
      callTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      publish: false,
      commit: false,
      merge: false,
      push: false,
      automaticRouting: false,
    },
    claimPolicy: {
      pairedClaim: 'paired_observation',
      winnerClaim: 'forbidden',
      routingClaim: 'forbidden',
      admissionClaim: 'forbidden',
    },
  };
}

function execution(c, { createdAt = '2026-08-30T12:00:00.000Z' } = {}) {
  const executor = c.pair.arms[1].makerExecutor;
  return {
    schemaVersion: 1,
    executionProtocol: 'code-harness-execution/v1b',
    campaignDigest: codeEvalPairCampaignIdentity(c),
    createdAt,
    runtime: {
      packageVersion: '0.4.11',
      treeDigest: hash('6'),
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '22.20.0',
    },
    maker: {
      backendDefinitionDigest: hash('7'),
      qualificationFingerprint: qualification('8'),
      qualificationSeatType: 'words_maker',
      credentialRevision: hash('9'),
      connectionDefinitionDigest: hash('a'),
      expectedModel: c.pair.maker.model,
      expectedRoute: clone(c.pair.maker.route),
    },
    reviewer: {
      backendDefinitionDigest: hash('b'),
      qualificationFingerprint: `builtin1:${'c'.repeat(64)}`,
      qualificationSeatType: 'words_reviewer',
      credentialRevision: 'none',
      connectionDefinitionDigest: hash('d'),
      expectedModel: c.pair.reviewer.model,
    },
    schedulerVersion: 'code-harness-scheduler/v1',
    armExecutions: [
      {
        armId: 'raw',
        executor: 'file_actions',
        protocolVersion: 'code-seats/v2',
        policyDigest: hash('e'),
      },
      {
        armId: 'native',
        executor,
        harness: {
          name: executor === 'qwen_native' ? 'qwen_code' : 'grok_build',
          version: executor === 'qwen_native' ? '0.22.3' : '1.0.5',
          artifactDigest: hash('f'),
          parserVersion: 'native-harness-v1',
          outerSandboxPolicyDigest: hash('0'),
          credentialGatewayPolicyDigest: hash('1'),
        },
      },
    ],
    verifierDigest: c.case.verifier.commandSha256,
    fixtureReadinessDigest: hash('2'),
  };
}

function routeObservation(c) {
  return {
    requestEnforced: clone(c.pair.maker.route),
    metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }],
  };
}

function successfulReceipt(c, e, armId, overrides = {}) {
  const cell = createCodeEvalPairCell(c, e, armId);
  const native = armId === 'native';
  const quality = overrides.quality ?? {
    fixturePreflightPassed: true,
    candidateIntegrityPassed: true,
    containmentPassed: true,
    verificationRan: true,
    verificationPassed: true,
    verificationBindingMatch: true,
    reviewRan: true,
    reviewVerdict: 'APPROVED',
    materialFindingCount: 0,
    reviewBindingMatch: true,
    reviewerIndependent: c.pair.maker.trainingOrg !== c.pair.reviewer.trainingOrg,
    reviewScreenStanding: c.pair.maker.trainingOrg !== c.pair.reviewer.trainingOrg
      ? 'independent_exact' : 'same_origin_advisory',
    humanInterventionDuringRun: false,
    mechanicalFloorPassed: true,
    screenFloorPassed: c.pair.maker.trainingOrg !== c.pair.reviewer.trainingOrg,
  };
  return createCodeEvalPairReceipt({
    campaign: c,
    execution: e,
    cell,
    recordedAt: '2026-08-30T12:05:00.000Z',
    observedIdentity: overrides.observedIdentity ?? {
      makerModel: c.pair.maker.model,
      reviewerModel: c.pair.reviewer.model,
      executor: native ? c.pair.arms[1].makerExecutor : 'file_actions',
      rawProtocolVersion: native ? null : e.armExecutions[0].protocolVersion,
      nativeHarness: native ? {
        name: e.armExecutions[1].harness.name,
        version: e.armExecutions[1].harness.version,
        artifactDigest: e.armExecutions[1].harness.artifactDigest,
        sessionId: 'session-1234',
      } : null,
      makerRoute: routeObservation(c),
      qualificationBindingsMatch: true,
      connectionBindingsMatch: true,
      policyBindingMatch: true,
      identityStable: true,
      substitutionDetected: false,
      helperModelDetected: false,
      fallbackDetected: false,
    },
    outcome: overrides.outcome ?? {
      status: 'candidate_ready_for_acceptance',
      buildStatus: 'needs_decision',
      reasonCode: null,
      possibleBilling: true,
      modelCallsMade: 2,
      candidateDiffExists: true,
      candidateFingerprint: hash('3'),
      finalCandidateCurrent: true,
      repairs: 0,
      retries: 0,
      questions: 0,
      humanAnswers: 0,
    },
    quality,
    economics: overrides.economics ?? {
      providerCalls: 2,
      makerCalls: 1,
      reviewerCalls: 1,
      makerInputTokens: 100,
      makerCachedInputTokens: 0,
      makerOutputTokens: 20,
      reviewerInputTokens: 40,
      reviewerCachedInputTokens: 0,
      reviewerOutputTokens: 10,
      wallMs: 100,
      makerMs: 40,
      verifierMs: 20,
      reviewerMs: 20,
      orchestrationMs: 20,
      rawProtocolSteps: native ? null : 1,
      rawFileActions: native ? null : 2,
      nativeProviderResponses: native ? 1 : null,
      nativeToolActions: native ? 2 : null,
      repairs: 0,
      retries: 0,
      incompleteSessions: 0,
      costUsd: null,
      currency: null,
      usageIncomplete: false,
    },
    custody: overrides.custody ?? {
      candidateBindingMatch: true,
      verificationBindingMatch: true,
      reviewBindingMatch: true,
      containmentStable: true,
      receiptsDegraded: false,
      processCleanupComplete: true,
    },
    artifacts: overrides.artifacts ?? {
      sourceFixtureDigest: c.case.fixtureTreeDigest,
      initialCandidateDigest: hash('4'),
      finalCandidateDigest: hash('5'),
      diffDigest: hash('6'),
      verifierReceiptDigest: hash('7'),
      reviewerReceiptDigest: hash('8'),
      buildReportDigest: hash('9'),
      eventJournalDigest: hash('a'),
    },
  });
}

export const codeEvalPairTestFixtures = Object.freeze({ campaign, execution, successfulReceipt });

test('bounded v1b canonically binds one shared pair and two arm-aware cells', () => {
  const c = campaign();
  const e = execution(c);
  validateCodeEvalPairCampaign(c);
  validateCodeEvalPairExecution(e, c);
  assert.match(codeEvalPairCampaignIdentity(c), /^campaign1:[a-f0-9]{64}$/);
  assert.match(codeEvalPairExecutionIdentity(e, c), /^execution1:[a-f0-9]{64}$/);
  assert.equal(codeEvalPairCampaignIdentity(Object.fromEntries(Object.entries(c).reverse())), codeEvalPairCampaignIdentity(c));
  assert.equal(canonicalCodeEvalPairJson(Object.fromEntries(Object.entries(c).reverse())), canonicalCodeEvalPairJson(c));

  const cells = createCodeEvalPairCells(c, e);
  assert.deepEqual(cells.map(cell => cell.armId), ['raw', 'native']);
  assert.deepEqual(cells.map(cell => cell.repeat), [1, 1]);
  assert.equal(Object.hasOwn(cells[0], 'executor'), false, 'executor resolves from the frozen arm rather than duplicating cell identity');
  for (const cell of cells) {
    validateCodeEvalPairCell(cell, c, e);
    assert.match(codeEvalPairCellIdentity(cell, c, e), /^cell1:[a-f0-9]{64}$/);
    const arm = codeEvalPairArmForCell(c, e, cell);
    assert.equal(arm.armId, cell.armId);
    assert.equal(codeEvalPairReceiptAssignment(c, e, cell).executor, arm.makerExecutor);
  }
  assert.notEqual(codeEvalPairCellIdentity(cells[0], c, e), codeEvalPairCellIdentity(cells[1], c, e));
});

test('every bounded campaign and execution layer is closed and isolation drift refuses', () => {
  const c = campaign();
  assert.throws(() => validateCodeEvalPairCampaign({ ...c, purpose: 'undeclared expansion' }), /unknown field: purpose/);
  const oneArm = clone(c); oneArm.pair.arms.pop();
  assert.throws(() => validateCodeEvalPairCampaign(oneArm), /exactly raw and native/);
  const reversed = clone(c); reversed.pair.arms.reverse();
  assert.throws(() => validateCodeEvalPairCampaign(reversed), /canonical raw\/file_actions arm/);
  const thirdCell = clone(c); thirdCell.controls.maximumCells = 3;
  assert.throws(() => validateCodeEvalPairCampaign(thirdCell), /exactly 2/);
  const repeat = clone(c); repeat.controls.repeatsPerArmCase = 2;
  assert.throws(() => validateCodeEvalPairCampaign(repeat), /exactly 1/);
  const winner = clone(c); winner.claimPolicy.winnerClaim = 'winner';
  assert.throws(() => validateCodeEvalPairCampaign(winner), /must be forbidden/);

  const e = execution(c);
  const rawSeat = clone(e); rawSeat.armExecutions[0].executor = 'qwen_native';
  assert.throws(() => validateCodeEvalPairExecution(rawSeat, c), /raw\/file_actions/);
  const wrongHarness = clone(e); wrongHarness.armExecutions[1].harness.name = 'grok_build';
  assert.throws(() => validateCodeEvalPairExecution(wrongHarness, c), /must be qwen_code/);
  const modelDrift = clone(e); modelDrift.maker.expectedModel = 'substituted';
  assert.throws(() => validateCodeEvalPairExecution(modelDrift, c), /shared campaign seat/);
  const routeDrift = clone(e); routeDrift.maker.expectedRoute.upstreamProvider = 'together/fp8';
  assert.throws(() => validateCodeEvalPairExecution(routeDrift, c), /shared campaign route/);
  const unknown = clone(e); unknown.armExecutions[0].prompt = 'unbound';
  assert.throws(() => validateCodeEvalPairExecution(unknown, c), /unknown field: prompt/);
});

test('raw and native receipts bind their exact arm while preserving role-separated measurements', () => {
  const c = campaign();
  const e = execution(c);
  for (const armId of ['raw', 'native']) {
    const receipt = successfulReceipt(c, e, armId);
    const cell = createCodeEvalPairCell(c, e, armId);
    validateCodeEvalPairReceipt(receipt, c, e, cell);
    assert.equal(receipt.standing, 'execution_observed');
    assert.equal(receipt.assignment.armId, armId);
    assert.equal(receipt.assignment.repeat, 1);
    assert.equal(receipt.quality.mechanicalFloorPassed, true);
    assert.equal(receipt.quality.screenFloorPassed, true);
    assert.equal(receipt.economics.makerCachedInputTokens, 0, 'observed zero remains an observed zero');
    if (armId === 'raw') {
      assert.equal(receipt.assignment.executor, 'file_actions');
      assert.equal(receipt.observedIdentity.nativeHarness, null);
      assert.equal(receipt.economics.nativeToolActions, null);
    } else {
      assert.equal(receipt.assignment.executor, 'qwen_native');
      assert.equal(receipt.observedIdentity.rawProtocolVersion, null);
      assert.equal(receipt.economics.rawFileActions, null);
    }
  }
  assert.deepEqual(CODE_EVAL_PAIR_CELL_STANDINGS, ['execution_observed', 'failed', 'unknown']);
});

test('a known paid raw response may authorize zero accepted protocol steps without collapsing the receipt to unknown', () => {
  const c = campaign();
  const e = execution(c);
  const base = successfulReceipt(c, e, 'raw');
  const receipt = successfulReceipt(c, e, 'raw', {
    outcome: { ...base.outcome, status: 'infrastructure_failed', buildStatus: 'infra_error' },
    quality: { ...base.quality, mechanicalFloorPassed: false, screenFloorPassed: false },
    economics: { ...base.economics, rawProtocolSteps: 0, rawFileActions: 0 },
  });
  assert.equal(receipt.standing, 'failed');
  assert.deepEqual([receipt.economics.providerCalls, receipt.economics.makerCalls,
    receipt.economics.rawProtocolSteps, receipt.economics.rawFileActions], [2, 1, 0, 0]);
  validateCodeEvalPairReceipt(receipt, c, e, createCodeEvalPairCell(c, e, 'raw'));

  const impossible = clone(receipt);
  impossible.economics.rawProtocolSteps = 2;
  assert.throws(() => validateCodeEvalPairReceipt(impossible, c, e, createCodeEvalPairCell(c, e, 'raw')),
    /steps cannot exceed measured raw maker calls/);
});

test('unknown evidence stays null and cannot be upgraded by an approving screen', () => {
  const c = campaign();
  const e = execution(c);
  for (const armId of ['raw', 'native']) {
    const cell = createCodeEvalPairCell(c, e, armId);
    const receipt = createUnknownCodeEvalPairReceipt({
      campaign: c,
      execution: e,
      cell,
      recordedAt: '2026-08-30T12:06:00.000Z',
    });
    assert.equal(receipt.standing, 'unknown');
    assert.equal(receipt.outcome.possibleBilling, true);
    assert.equal(receipt.outcome.modelCallsMade, null);
    assert.equal(receipt.economics.providerCalls, null);
    assert.equal(receipt.economics.makerInputTokens, null);
    assert.equal(receipt.economics.usageIncomplete, true);
    assert.equal(receipt.quality.mechanicalFloorPassed, null);
    assert.equal(receipt.observedIdentity.fallbackDetected, null);
    validateCodeEvalPairReceipt(receipt, c, e, cell);
  }

  const raw = successfulReceipt(c, e, 'raw');
  const tampered = clone(raw);
  tampered.assignment.armId = 'native';
  assert.throws(() => validateCodeEvalPairReceipt(tampered, c, e, createCodeEvalPairCell(c, e, 'raw')), /assignment/);

  const sameOrigin = campaign({ sameOrigin: true });
  const sameExecution = execution(sameOrigin);
  const advisory = successfulReceipt(sameOrigin, sameExecution, 'raw');
  assert.equal(advisory.quality.mechanicalFloorPassed, true);
  assert.equal(advisory.quality.screenFloorPassed, false);
  assert.equal(advisory.standing, 'failed');
});

test('an approving review cannot pass the screen when observed route identity is incomplete', () => {
  const c = campaign();
  const e = execution(c);
  const baseline = successfulReceipt(c, e, 'raw');
  const receipt = successfulReceipt(c, e, 'raw', {
    observedIdentity: {
      ...baseline.observedIdentity,
      makerRoute: null,
      identityStable: false,
      substitutionDetected: null,
      fallbackDetected: null,
    },
    quality: {
      ...baseline.quality,
      screenFloorPassed: false,
    },
  });
  assert.equal(receipt.quality.mechanicalFloorPassed, true);
  assert.equal(receipt.quality.reviewVerdict, 'APPROVED');
  assert.equal(receipt.quality.screenFloorPassed, false);
  assert.equal(receipt.standing, 'failed');
});
