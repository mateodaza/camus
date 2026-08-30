import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codeEvalPairCampaignIdentity,
  createUnknownCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';
import {
  CODE_EVAL_PAIR_SCHEDULER_VERSION,
  codeEvalPairScheduleParity,
  codeEvalPairScheduleParityBit,
  nextCodeEvalPairCell,
  scheduleCodeEvalPairCells,
} from './code-eval-pair-scheduler.mjs';

const hash = character => `sha256:${character.repeat(64)}`;

function campaign() {
  return {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1b',
    campaignId: 'fixture-pair-v1b',
    campaignMode: 'isolation_pair',
    standing: 'exploratory_only',
    case: {
      caseId: 'fixture-case', caseVersion: 1, taskClass: 'simple',
      fixtureId: `fixture1:${'f'.repeat(64)}`,
      fixtureTreeDigest: hash('1'), baseCommitDigest: hash('2'),
      taskSha256: hash('3'), acceptanceContractSha256: hash('4'),
      verifier: {
        kind: 'host_command', commandSha256: hash('5'), timeoutMs: 15_000,
        expectedBase: 'red', expectedReference: 'green',
      },
    },
    pair: {
      pairId: 'fixture-pair',
      maker: {
        backend: 'fixture-maker', provider: 'fixture', model: 'fixture-model',
        effort: null, trainingOrg: 'fixture-maker-org', transport: 'direct_https',
        connection: 'fixture-connection', route: null,
      },
      reviewer: {
        backend: 'fixture-reviewer', model: 'fixture-reviewer-model', effort: 'medium',
        trainingOrg: 'fixture-reviewer-org',
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
      semanticPromptEnvelopeVersion: 'code-harness-eval-v1b',
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
    executionProtocol: 'code-harness-execution/v1b',
    campaignDigest: codeEvalPairCampaignIdentity(c),
    createdAt: '2026-08-30T12:00:00.000Z',
    runtime: {
      packageVersion: '0.4.11', treeDigest: hash('6'), platform: 'darwin',
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
      { armId: 'raw', executor: 'file_actions', protocolVersion: 'code-seats/v2', policyDigest: hash('e') },
      { armId: 'native', executor: 'qwen_native', harness: {
        name: 'qwen_code', version: '0.22.3', artifactDigest: hash('f'),
        parserVersion: 'native-harness-v1', outerSandboxPolicyDigest: hash('0'),
        credentialGatewayPolicyDigest: hash('1'),
      } },
    ],
    verifierDigest: c.case.verifier.commandSha256,
    fixtureReadinessDigest: hash('2'),
  };
}

test('scheduler parity has fixed NUL-delimited SHA-256 vectors', () => {
  const odd = codeEvalPairScheduleParityBit({
    campaignDigest: `campaign1:${'a'.repeat(64)}`,
    executionDigest: `execution1:${'b'.repeat(64)}`,
    pairId: 'pair-one',
    caseId: 'case-one',
    repeat: 1,
  });
  const even = codeEvalPairScheduleParityBit({
    campaignDigest: `campaign1:${'a'.repeat(64)}`,
    executionDigest: `execution1:${'b'.repeat(64)}`,
    pairId: 'pair-4',
    caseId: 'case-one',
    repeat: 1,
  });
  assert.equal(odd, 1);
  assert.equal(even, 0);
  assert.throws(() => codeEvalPairScheduleParityBit({
    campaignDigest: `campaign1:${'a'.repeat(64)}`,
    executionDigest: `execution1:${'b'.repeat(64)}`,
    pairId: 'pair-one',
    caseId: 'case-one',
    repeat: 2,
  }), /repeat must be exactly 1/);
});

test('the same generation schedules both arms once in stable counterbalanced order', () => {
  const c = campaign();
  const e = execution(c);
  const expected = codeEvalPairScheduleParity(c, e) === 0 ? ['raw', 'native'] : ['native', 'raw'];
  assert.deepEqual(scheduleCodeEvalPairCells(c, e).map(cell => cell.armId), expected);
  assert.deepEqual(scheduleCodeEvalPairCells(c, e), scheduleCodeEvalPairCells(c, e));
  assert.equal(new Set(scheduleCodeEvalPairCells(c, e).map(cell => cell.armId)).size, 2);
});

test('terminal receipts are skipped without reshuffling and unknown attempts are never replayed', () => {
  const c = campaign();
  const e = execution(c);
  const scheduled = scheduleCodeEvalPairCells(c, e);
  assert.equal(nextCodeEvalPairCell(c, e, []).armId, scheduled[0].armId);
  const first = createUnknownCodeEvalPairReceipt({
    campaign: c, execution: e, cell: scheduled[0], recordedAt: '2026-08-30T12:01:00.000Z',
  });
  assert.equal(nextCodeEvalPairCell(c, e, [first]).armId, scheduled[1].armId);
  const second = createUnknownCodeEvalPairReceipt({
    campaign: c, execution: e, cell: scheduled[1], recordedAt: '2026-08-30T12:02:00.000Z',
  });
  assert.equal(nextCodeEvalPairCell(c, e, [second, first]), null, 'ledger order cannot reshuffle or replay cells');
  assert.throws(() => nextCodeEvalPairCell(c, e, [first, first]), /duplicate receipt cell/);
});

