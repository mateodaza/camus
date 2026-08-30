import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtemp as mkdtempAsync, rm as rmAsync, writeFile } from 'node:fs/promises';

import { main as codeEvalMain } from '../code-eval.mjs';

import {
  CODE_EVAL_PAIR_EXECUTION_PROTOCOL,
  CODE_EVAL_PAIR_PROTOCOL,
  CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION,
  CODE_EVAL_PAIR_SCHEDULER_VERSION,
  codeEvalPairCampaignIdentity,
  createCodeEvalPairCell,
  createCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';
import { createCodeEvalPairSummary, summarizeCodeEvalPair } from './code-eval-pair-summary.mjs';
import {
  appendCodeEvalPairReceipt,
  codeEvalPairEvidencePaths,
  codeEvalPairStatus,
  initializeCodeEvalPairEvidence,
  reserveNextCodeEvalPairCell,
} from './code-eval-pair-ledger.mjs';

const hash = (character = 'a') => `sha256:${character.repeat(64)}`;
const clone = value => JSON.parse(JSON.stringify(value));

function campaign() {
  return {
    schemaVersion: 1,
    treatmentProtocol: CODE_EVAL_PAIR_PROTOCOL,
    campaignId: 'qwen-summary-pair-v1b',
    campaignMode: 'isolation_pair',
    standing: 'exploratory_only',
    case: {
      caseId: 'simple-bounded-parser-fix',
      caseVersion: 1,
      taskClass: 'simple',
      fixtureId: `fixture1:${'f'.repeat(64)}`,
      fixtureTreeDigest: hash('1'),
      baseCommitDigest: hash('2'),
      taskSha256: hash('3'),
      acceptanceContractSha256: hash('4'),
      verifier: {
        kind: 'host_command', commandSha256: hash('5'), timeoutMs: 120_000,
        expectedBase: 'red', expectedReference: 'green',
      },
    },
    pair: {
      pairId: 'qwen-summary-pair',
      maker: {
        backend: 'dashscope-qwen', provider: 'alibaba', model: 'qwen3-coder-plus',
        effort: null, trainingOrg: 'alibaba', transport: 'direct_https',
        connection: 'dashscope-primary', route: null,
      },
      reviewer: {
        backend: 'codex', model: 'gpt-5.6-sol', effort: 'high', trainingOrg: 'openai',
      },
      arms: [
        { armId: 'raw', makerExecutor: 'file_actions' },
        { armId: 'native', makerExecutor: 'qwen_native' },
      ],
    },
    controls: {
      repeatsPerArmCase: 1, maximumCells: 2,
      maximumProviderCallsPerCell: 3, maximumMakerCallsPerCell: 2,
      maximumReviewerCallsPerCell: 1, maximumSteps: 4, maximumActions: 8,
      maximumRepairs: 0, maximumRetries: 0, maximumTokensReserved: 32768,
      semanticPromptEnvelopeVersion: CODE_EVAL_PAIR_PROTOCOL,
      wallTimeoutMs: 120_000, callTimeoutMs: 60_000, idleTimeoutMs: 0,
      publish: false, commit: false, merge: false, push: false, automaticRouting: false,
    },
    claimPolicy: {
      pairedClaim: 'paired_observation', winnerClaim: 'forbidden',
      routingClaim: 'forbidden', admissionClaim: 'forbidden',
    },
  };
}

function execution(c) {
  return {
    schemaVersion: 1,
    executionProtocol: CODE_EVAL_PAIR_EXECUTION_PROTOCOL,
    campaignDigest: codeEvalPairCampaignIdentity(c),
    createdAt: '2026-08-30T12:00:00.000Z',
    runtime: {
      packageVersion: '0.4.12', treeDigest: hash('6'), platform: 'darwin',
      architecture: 'arm64', nodeVersion: '22.20.0',
    },
    maker: {
      backendDefinitionDigest: hash('7'), qualificationFingerprint: `qual1:${'8'.repeat(64)}`,
      qualificationSeatType: 'words_maker', credentialRevision: hash('9'),
      connectionDefinitionDigest: hash('a'), expectedModel: c.pair.maker.model,
      expectedRoute: null,
    },
    reviewer: {
      backendDefinitionDigest: hash('b'), qualificationFingerprint: `builtin1:${'c'.repeat(64)}`,
      qualificationSeatType: 'words_reviewer', credentialRevision: 'none',
      connectionDefinitionDigest: hash('d'), expectedModel: c.pair.reviewer.model,
    },
    schedulerVersion: CODE_EVAL_PAIR_SCHEDULER_VERSION,
    armExecutions: [
      {
        armId: 'raw', executor: 'file_actions',
        protocolVersion: CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION, policyDigest: hash('e'),
      },
      {
        armId: 'native', executor: 'qwen_native',
        harness: {
          name: 'qwen_code', version: '0.22.3', artifactDigest: hash('f'),
          parserVersion: 'native-harness-v1', outerSandboxPolicyDigest: hash('0'),
          credentialGatewayPolicyDigest: hash('1'),
        },
      },
    ],
    verifierDigest: c.case.verifier.commandSha256,
    fixtureReadinessDigest: hash('2'),
  };
}

function completeEconomics(armId, overrides = {}) {
  const native = armId === 'native';
  return {
    providerCalls: 2, makerCalls: 1, reviewerCalls: 1,
    makerInputTokens: native ? 140 : 100,
    makerCachedInputTokens: 0,
    makerOutputTokens: native ? 25 : 20,
    reviewerInputTokens: 40, reviewerCachedInputTokens: 0, reviewerOutputTokens: 10,
    wallMs: native ? 120 : 100, makerMs: native ? 60 : 40,
    verifierMs: 20, reviewerMs: 20, orchestrationMs: 20,
    rawProtocolSteps: native ? null : 1,
    rawFileActions: native ? null : 2,
    nativeProviderResponses: native ? 1 : null,
    nativeToolActions: native ? 2 : null,
    repairs: 0, retries: 0, incompleteSessions: 0,
    costUsd: null, currency: null, usageIncomplete: false,
    ...overrides,
  };
}

function nullEconomics() {
  return {
    providerCalls: null, makerCalls: null, reviewerCalls: null,
    makerInputTokens: null, makerCachedInputTokens: null, makerOutputTokens: null,
    reviewerInputTokens: null, reviewerCachedInputTokens: null, reviewerOutputTokens: null,
    wallMs: null, makerMs: null, verifierMs: null, reviewerMs: null,
    orchestrationMs: null, rawProtocolSteps: null, rawFileActions: null,
    nativeProviderResponses: null, nativeToolActions: null, repairs: null,
    retries: null, incompleteSessions: null, costUsd: null, currency: null,
    usageIncomplete: true,
  };
}

function receipt(c, e, armId, {
  identityComplete = true,
  mechanical = true,
  economics = completeEconomics(armId),
  recordedAt = armId === 'raw' ? '2026-08-30T12:05:00.000Z' : '2026-08-30T12:06:00.000Z',
} = {}) {
  const native = armId === 'native';
  const cell = createCodeEvalPairCell(c, e, armId);
  const identity = identityComplete ? {
    makerModel: c.pair.maker.model,
    reviewerModel: c.pair.reviewer.model,
    executor: native ? 'qwen_native' : 'file_actions',
    rawProtocolVersion: native ? null : CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION,
    nativeHarness: native ? {
      name: e.armExecutions[1].harness.name,
      version: e.armExecutions[1].harness.version,
      artifactDigest: e.armExecutions[1].harness.artifactDigest,
      sessionId: `session-${armId}`,
    } : null,
    makerRoute: null,
    qualificationBindingsMatch: true,
    connectionBindingsMatch: true,
    policyBindingMatch: true,
    identityStable: true,
    substitutionDetected: false,
    helperModelDetected: false,
    fallbackDetected: false,
  } : {
    makerModel: null, reviewerModel: null, executor: null,
    rawProtocolVersion: null, nativeHarness: null, makerRoute: null,
    qualificationBindingsMatch: null, connectionBindingsMatch: null,
    policyBindingMatch: null, identityStable: null, substitutionDetected: null,
    helperModelDetected: null, fallbackDetected: false,
  };
  const quality = mechanical ? {
    fixturePreflightPassed: true, candidateIntegrityPassed: true, containmentPassed: true,
    verificationRan: true, verificationPassed: true, verificationBindingMatch: true,
    reviewRan: identityComplete ? true : null,
    reviewVerdict: identityComplete ? 'APPROVED' : null,
    materialFindingCount: identityComplete ? 0 : null,
    reviewBindingMatch: identityComplete ? true : null,
    reviewerIndependent: true, reviewScreenStanding: 'independent_exact',
    humanInterventionDuringRun: false, mechanicalFloorPassed: true,
    screenFloorPassed: identityComplete ? true : null,
  } : {
    fixturePreflightPassed: true, candidateIntegrityPassed: true, containmentPassed: true,
    verificationRan: true, verificationPassed: false, verificationBindingMatch: true,
    reviewRan: false, reviewVerdict: null, materialFindingCount: null,
    reviewBindingMatch: null, reviewerIndependent: true,
    reviewScreenStanding: 'independent_exact', humanInterventionDuringRun: false,
    mechanicalFloorPassed: false, screenFloorPassed: false,
  };
  const outcome = {
    status: mechanical ? 'candidate_ready_for_acceptance' : 'verification_failed',
    buildStatus: mechanical ? 'needs_decision' : 'verify_failed',
    reasonCode: mechanical ? null : 'verifier_red',
    possibleBilling: true,
    modelCallsMade: economics.providerCalls,
    candidateDiffExists: true,
    candidateFingerprint: hash(native ? '3' : '4'),
    finalCandidateCurrent: true,
    repairs: 0, retries: 0, questions: 0, humanAnswers: 0,
  };
  return createCodeEvalPairReceipt({
    campaign: c,
    execution: e,
    cell,
    observedIdentity: identity,
    outcome,
    quality,
    economics,
    custody: {
      candidateBindingMatch: true,
      verificationBindingMatch: true,
      reviewBindingMatch: identityComplete && mechanical ? true : null,
      containmentStable: true,
      receiptsDegraded: false,
      processCleanupComplete: true,
    },
    artifacts: {
      sourceFixtureDigest: c.case.fixtureTreeDigest,
      initialCandidateDigest: hash('5'), finalCandidateDigest: hash('6'),
      diffDigest: hash('7'), verifierReceiptDigest: hash('8'),
      reviewerReceiptDigest: identityComplete && mechanical ? hash('9') : null,
      buildReportDigest: hash('a'), eventJournalDigest: hash('b'),
    },
    recordedAt,
  });
}

function world() {
  const c = campaign();
  return { campaign: c, execution: execution(c) };
}

function assertForbiddenClaims(summary) {
  assert.deepEqual(summary.claims, {
    pairedObservation: summary.standing === 'paired_observation',
    winner: 'forbidden',
    efficiency: 'forbidden',
    routing: 'forbidden',
    admission: 'forbidden',
    productionReadiness: 'forbidden',
  });
  assert(!['winner', 'best_model', 'best_harness', 'routing_eligible',
    'admission_eligible', 'production_ready'].includes(summary.standing));
}

test('zero and one receipt follow the bounded coverage truth table', () => {
  const item = world();
  const none = createCodeEvalPairSummary({ ...item, receipts: [] });
  assert.equal(none.standing, 'no_attempts');
  assert.deepEqual(none.coverage, {
    coverageScope: 'case_only', taskClassCoverage: false, totalCells: 2,
    attemptedCells: 0, pendingCells: 2, paired: false,
  });
  assert.equal(none.quality.isolationValid, null);
  assert.equal(none.economics.differences, null);
  assertForbiddenClaims(none);

  const one = createCodeEvalPairSummary({
    ...item,
    receipts: [receipt(item.campaign, item.execution, 'raw')],
  });
  assert.equal(one.standing, 'paired_coverage_incomplete');
  assert.equal(one.coverage.attemptedCells, 1);
  assert.equal(one.coverage.pendingCells, 1);
  assert.equal(one.coverage.paired, false);
  assert.equal(one.economics.differences, null);
  assertForbiddenClaims(one);
});

test('an exact two-arm assignment with incomplete observed identity is isolation-invalid', () => {
  const item = world();
  const receipts = ['raw', 'native'].map(armId => receipt(
    item.campaign, item.execution, armId, { identityComplete: false },
  ));
  const summary = createCodeEvalPairSummary({ ...item, receipts });
  assert.equal(summary.coverage.paired, true);
  assert.equal(summary.quality.isolationValid, false);
  assert.equal(summary.quality.bothMechanicalFloorsPassed, true,
    'identity failure is distinct from the mechanical floor');
  assert.equal(summary.standing, 'isolation_invalid');
  assert(summary.arms.every(arm => arm.identityStable === false));
  assertForbiddenClaims(summary);
});

test('a stable exact pair with either mechanical floor false cannot become a paired observation', () => {
  const item = world();
  const receipts = [
    receipt(item.campaign, item.execution, 'raw'),
    receipt(item.campaign, item.execution, 'native', { mechanical: false }),
  ];
  const summary = createCodeEvalPairSummary({ ...item, receipts });
  assert.equal(summary.quality.isolationValid, true);
  assert.equal(summary.quality.bothMechanicalFloorsPassed, false);
  assert.equal(summary.standing, 'mechanical_floor_not_met');
  assert.equal(summary.claims.pairedObservation, false);
  assert.equal(summary.economics.interpretation, 'diagnostic_only');
  assertForbiddenClaims(summary);
});

test('two exact stable mechanically green cells produce only a case-scoped paired observation', () => {
  const item = world();
  const summary = createCodeEvalPairSummary({
    ...item,
    receipts: ['native', 'raw'].map(armId => receipt(item.campaign, item.execution, armId)),
  });
  assert.equal(summary.standing, 'paired_observation');
  assert.equal(summary.coverage.coverageScope, 'case_only');
  assert.equal(summary.coverage.taskClassCoverage, false);
  assert.equal(summary.quality.isolationValid, true);
  assert.equal(summary.quality.bothMechanicalFloorsPassed, true);
  assert.equal(summary.economics.interpretation, 'paired_measurements_only');
  assert.equal(summary.economics.differences.direction, 'native_minus_raw');
  assert.equal(summary.economics.differences.values.wallMs, 20);
  assert.equal(summary.economics.differences.values.makerInputTokens, 40);
  assert.equal(summary.economics.comparableActionCounts, false);
  assertForbiddenClaims(summary);
});

test('null and incomplete economics remain null without blocking a quality-valid pair', () => {
  const item = world();
  const receipts = ['raw', 'native'].map(armId => receipt(
    item.campaign, item.execution, armId, { economics: nullEconomics() },
  ));
  const summary = createCodeEvalPairSummary({ ...item, receipts });
  assert.equal(summary.standing, 'paired_observation');
  assert.equal(summary.economics.interpretation, 'paired_measurements_only');
  assert(Object.values(summary.economics.differences.values).every(value => value === null));
  assert(summary.economics.differences.missingMeasurements.includes('providerCalls'));
  assert(summary.economics.differences.missingMeasurements.includes('costUsd'));
  assert(summary.arms.every(arm => arm.economics.usageIncomplete === true));
  assertForbiddenClaims(summary);
});

test('summary shape presents quality before economics at both pair and arm levels', () => {
  const item = world();
  const summary = createCodeEvalPairSummary({
    ...item,
    receipts: ['raw', 'native'].map(armId => receipt(item.campaign, item.execution, armId)),
  });
  const topKeys = Object.keys(summary);
  assert(topKeys.indexOf('quality') < topKeys.indexOf('economics'));
  for (const arm of summary.arms) {
    const keys = Object.keys(arm);
    assert(keys.indexOf('quality') < keys.indexOf('economics'));
  }
  assert.equal(summary.claims.efficiency, 'forbidden');
});

test('the provider-free summarize wrapper uses only injected context and receipt readers', async () => {
  const item = world();
  const receipts = ['raw', 'native'].map(armId => receipt(item.campaign, item.execution, armId));
  let contexts = 0, ledgers = 0;
  const result = await summarizeCodeEvalPair({ campaignPath: 'unused' }, {
    loadContext: async () => {
      contexts++;
      return { ...item, evidencePaths: { dir: '/unused' } };
    },
    loadReceipts: async () => { ledgers++; return clone(receipts); },
  });
  assert.equal(contexts, 1);
  assert.equal(ledgers, 1);
  assert.equal(result.standing, 'paired_observation');
  assert.equal(result.providerCallsMade, 0);
  assert.equal(result.providerCallsMadeThisInvocation, 0);
  assertForbiddenClaims(result);
});

test('default summarize reads a private read-only ledger without creating or removing a lock', async () => {
  const item = world();
  const parent = mkdtempSync(join(tmpdir(), 'camus-pair-summary-readonly-'));
  const evidencePaths = codeEvalPairEvidencePaths(join(parent, 'evidence'));
  const campaignPath = join(parent, 'campaign.json');
  const statePath = join(evidencePaths.dir, 'state.json');
  try {
    initializeCodeEvalPairEvidence(evidencePaths, item);
    writeFileSync(campaignPath, `${JSON.stringify(item.campaign)}\n`, { mode: 0o600 });
    writeFileSync(statePath, `${JSON.stringify(item.execution)}\n`, { mode: 0o600 });
    for (const [index, expectedArm] of ['first', 'second'].entries()) {
      const reserved = reserveNextCodeEvalPairCell(evidencePaths, {
        ...item,
        buildRunId: `summary-${expectedArm}`,
        supervisorIdentity: `pid-${process.pid}`,
        maximumProviderCallsReserved: item.campaign.controls.maximumProviderCallsPerCell,
        reservationNonce: String(index + 1).padStart(32, '0'),
        startedAt: `2026-08-30T12:0${index + 1}:00.000Z`,
      });
      const sealed = receipt(item.campaign, item.execution, reserved.cell.armId);
      appendCodeEvalPairReceipt(evidencePaths, sealed, item, {
        reservationNonce: reserved.marker.reservationNonce,
      });
      codeEvalPairStatus(evidencePaths, item);
    }
    assert.equal(existsSync(evidencePaths.lock), false);
    assert.equal(existsSync(evidencePaths.marker), false);

    const before = {
      entries: readdirSync(evidencePaths.dir).sort(),
      campaign: readFileSync(campaignPath, 'utf8'),
      state: readFileSync(statePath, 'utf8'),
      generation: readFileSync(evidencePaths.generation, 'utf8'),
      ledger: readFileSync(evidencePaths.ledger, 'utf8'),
    };
    chmodSync(campaignPath, 0o400);
    chmodSync(statePath, 0o400);
    chmodSync(evidencePaths.generation, 0o400);
    chmodSync(evidencePaths.ledger, 0o400);
    chmodSync(evidencePaths.dir, 0o500);

    const summary = await summarizeCodeEvalPair({
      campaignPath,
      statePath,
      ledgerPath: evidencePaths.ledger,
    });
    assert.equal(summary.standing, 'paired_observation');
    assert.equal(summary.providerCallsMadeThisInvocation, 0);
    assert.equal(existsSync(evidencePaths.lock), false);
    assert.equal(existsSync(evidencePaths.marker), false);
    assert.deepEqual(readdirSync(evidencePaths.dir).sort(), before.entries);
    assert.equal(readFileSync(campaignPath, 'utf8'), before.campaign);
    assert.equal(readFileSync(statePath, 'utf8'), before.state);
    assert.equal(readFileSync(evidencePaths.generation, 'utf8'), before.generation);
    assert.equal(readFileSync(evidencePaths.ledger, 'utf8'), before.ledger);
    assert.equal(statSync(evidencePaths.dir).mode & 0o777, 0o500);
    assert.equal(statSync(campaignPath).mode & 0o777, 0o400);
    assert.equal(statSync(statePath).mode & 0o777, 0o400);
    assert.equal(statSync(evidencePaths.generation).mode & 0o777, 0o400);
    assert.equal(statSync(evidencePaths.ledger).mode & 0o777, 0o400);
  } finally {
    if (existsSync(evidencePaths.dir)) {
      chmodSync(evidencePaths.dir, 0o700);
      if (existsSync(statePath)) chmodSync(statePath, 0o600);
      if (existsSync(evidencePaths.generation)) chmodSync(evidencePaths.generation, 0o600);
      if (existsSync(evidencePaths.ledger)) chmodSync(evidencePaths.ledger, 0o600);
    }
    if (existsSync(campaignPath)) chmodSync(campaignPath, 0o600);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('default summarize never creates a missing evidence directory', async () => {
  const item = world();
  const parent = mkdtempSync(join(tmpdir(), 'camus-pair-summary-missing-'));
  const campaignPath = join(parent, 'campaign.json');
  const missing = join(parent, 'missing-evidence');
  try {
    writeFileSync(campaignPath, `${JSON.stringify(item.campaign)}\n`, { mode: 0o600 });
    await assert.rejects(summarizeCodeEvalPair({
      campaignPath,
      statePath: join(missing, 'state.json'),
      ledgerPath: join(missing, 'receipts.jsonl'),
    }), /ENOENT|no such file/i);
    assert.equal(existsSync(missing), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('the public CLI dispatches a v1b summary without touching execution providers', async t => {
  const item = world();
  const root = await mkdtempAsync(join(tmpdir(), 'camus-code-pair-summary-cli-'));
  t.after(() => rmAsync(root, { recursive: true, force: true }));
  const campaignPath = join(root, 'campaign.json');
  await writeFile(campaignPath, `${JSON.stringify(item.campaign)}\n`);
  const output = [];
  const originalLog = console.log;
  console.log = value => output.push(String(value));
  try {
    const code = await codeEvalMain([
      'summarize', '--campaign', campaignPath,
      '--state', join(root, 'state.json'), '--ledger', join(root, 'receipts.jsonl'), '--json',
    ], {
      loadContext: async () => ({
        ...item,
        evidencePaths: { dir: root, generation: join(root, 'generation.json'),
          ledger: join(root, 'receipts.jsonl'), marker: join(root, 'inflight.json'),
          lock: join(root, 'evidence.lock') },
      }),
      loadReceipts: () => [],
    });
    assert.equal(code, 0);
  } finally { console.log = originalLog; }
  const summary = JSON.parse(output.join('\n'));
  assert.equal(summary.protocol, 'code-harness-eval-v1b-summary');
  assert.equal(summary.standing, 'no_attempts');
  assert.equal(summary.providerCallsMadeThisInvocation, 0);
});
