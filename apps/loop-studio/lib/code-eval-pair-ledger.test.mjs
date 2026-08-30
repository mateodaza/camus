import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CODE_EVAL_PAIR_EXECUTION_PROTOCOL,
  CODE_EVAL_PAIR_PROTOCOL,
  CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION,
  CODE_EVAL_PAIR_SCHEDULER_VERSION,
  codeEvalPairCampaignIdentity,
  codeEvalPairCellIdentity,
  createUnknownCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';
import { scheduleCodeEvalPairCells } from './code-eval-pair-scheduler.mjs';
import {
  acquireCodeEvalPairEvidenceLock,
  appendCodeEvalPairReceipt,
  codeEvalPairEvidencePaths,
  codeEvalPairStatus,
  ensureCodeEvalPairEvidenceDir,
  initializeCodeEvalPairEvidence,
  loadCodeEvalPairInflightMarker,
  loadCodeEvalPairReceipts,
  readCodeEvalPairReceiptsSnapshot,
  recoverAbandonedCodeEvalPairEvidenceLock,
  recoverCodeEvalPairCell,
  reserveNextCodeEvalPairCell,
} from './code-eval-pair-ledger.mjs';

const hash = (character = 'a') => `sha256:${character.repeat(64)}`;

function campaign() {
  return {
    schemaVersion: 1,
    treatmentProtocol: CODE_EVAL_PAIR_PROTOCOL,
    campaignId: 'qwen-raw-native-simple-v1',
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
        kind: 'host_command',
        commandSha256: hash('5'),
        timeoutMs: 120_000,
        expectedBase: 'red',
        expectedReference: 'green',
      },
    },
    pair: {
      pairId: 'qwen-raw-native',
      maker: {
        backend: 'dashscope-qwen',
        provider: 'alibaba',
        model: 'qwen3-coder-plus',
        effort: null,
        trainingOrg: 'alibaba',
        transport: 'direct_https',
        connection: 'dashscope-primary',
        route: null,
      },
      reviewer: {
        backend: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        trainingOrg: 'openai',
      },
      arms: [
        { armId: 'raw', makerExecutor: 'file_actions' },
        { armId: 'native', makerExecutor: 'qwen_native' },
      ],
    },
    controls: {
      repeatsPerArmCase: 1,
      maximumCells: 2,
      maximumProviderCallsPerCell: 6,
      maximumMakerCallsPerCell: 4,
      maximumReviewerCallsPerCell: 2,
      maximumSteps: 4,
      maximumActions: 16,
      maximumRepairs: 1,
      maximumRetries: 0,
      maximumTokensReserved: 100_000,
      semanticPromptEnvelopeVersion: CODE_EVAL_PAIR_PROTOCOL,
      wallTimeoutMs: 1_200_000,
      callTimeoutMs: 600_000,
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

function execution(c, createdAt = '2026-08-30T12:00:00.000Z') {
  return {
    schemaVersion: 1,
    executionProtocol: CODE_EVAL_PAIR_EXECUTION_PROTOCOL,
    campaignDigest: codeEvalPairCampaignIdentity(c),
    createdAt,
    runtime: {
      packageVersion: '0.4.12',
      treeDigest: hash('6'),
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: 'v22.20.0',
    },
    maker: {
      backendDefinitionDigest: hash('7'),
      qualificationFingerprint: `qual1:${'8'.repeat(64)}`,
      qualificationSeatType: 'words_maker',
      credentialRevision: hash('9'),
      connectionDefinitionDigest: hash('a'),
      expectedModel: c.pair.maker.model,
      expectedRoute: null,
    },
    reviewer: {
      backendDefinitionDigest: hash('b'),
      qualificationFingerprint: `builtin1:${'c'.repeat(64)}`,
      qualificationSeatType: 'words_reviewer',
      credentialRevision: 'none',
      connectionDefinitionDigest: hash('d'),
      expectedModel: c.pair.reviewer.model,
    },
    schedulerVersion: CODE_EVAL_PAIR_SCHEDULER_VERSION,
    armExecutions: [
      {
        armId: 'raw',
        executor: 'file_actions',
        protocolVersion: CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION,
        policyDigest: hash('e'),
      },
      {
        armId: 'native',
        executor: 'qwen_native',
        harness: {
          name: 'qwen_code',
          version: '0.22.3',
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

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'camus-code-eval-pair-'));
  const paths = codeEvalPairEvidencePaths(join(parent, 'fresh-pair-evidence'));
  const c = campaign();
  const e = execution(c);
  const input = { campaign: c, execution: e };
  return { parent, paths, c, e, input, schedule: scheduleCodeEvalPairCells(c, e) };
}

function reserve(state, suffix = '1') {
  return reserveNextCodeEvalPairCell(state.paths, {
    ...state.input,
    buildRunId: `build-run-${suffix}`,
    supervisorIdentity: `pid-${process.pid}`,
    maximumProviderCallsReserved: state.c.controls.maximumProviderCallsPerCell,
    reservationNonce: suffix.padStart(32, '0'),
    startedAt: `2026-08-30T12:0${suffix}:00.000Z`,
  });
}

function unknownFor(state, reserved, recordedAt = '2026-08-30T12:05:00.000Z') {
  return createUnknownCodeEvalPairReceipt({
    ...state.input,
    cell: reserved.cell,
    recordedAt,
  });
}

function appendUnknown(state, reserved, recordedAt) {
  const receipt = unknownFor(state, reserved, recordedAt);
  return appendCodeEvalPairReceipt(state.paths, receipt, state.input, {
    reservationNonce: reserved.marker.reservationNonce,
  });
}

test('a fresh private generation freezes the exact scheduled two-cell roster', () => {
  const state = setup();
  try {
    const generation = initializeCodeEvalPairEvidence(state.paths, state.input);
    assert.equal(generation.protocol, 'code-harness-pair-evidence/v1b');
    assert.deepEqual(generation.orderedCellIds, state.schedule.map(cell =>
      codeEvalPairCellIdentity(cell, state.c, state.e)));
    assert.equal(statSync(state.paths.dir).mode & 0o777, 0o700);
    assert.equal(statSync(state.paths.generation).mode & 0o777, 0o600);
    assert.deepEqual(readCodeEvalPairReceiptsSnapshot(state.paths, state.input), []);
    assert.equal(existsSync(state.paths.lock), false, 'snapshot reads never create the writer lease');
    assert.deepEqual(codeEvalPairStatus(state.paths, state.input), {
      state: 'pending', canAttempt: true, replayAllowed: false,
      staleMarkerCleared: false, totalCells: 2, completedCells: 0, pendingCells: 2,
      receiptIds: [], nextCell: state.schedule[0], inflightCell: null, inflightCellId: null,
    });
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('a read-only snapshot refuses a held writer lock without mutating it', () => {
  const state = setup();
  let lease;
  try {
    initializeCodeEvalPairEvidence(state.paths, state.input);
    lease = acquireCodeEvalPairEvidenceLock(state.paths);
    const lockBytes = readFileSync(state.paths.lock, 'utf8');
    assert.throws(
      () => readCodeEvalPairReceiptsSnapshot(state.paths, state.input),
      /snapshot refused while evidence is locked by a writer/,
    );
    assert.equal(existsSync(state.paths.lock), true);
    assert.equal(readFileSync(state.paths.lock, 'utf8'), lockBytes);
  } finally {
    if (lease && existsSync(state.paths.lock)) lease.release();
    rmSync(state.parent, { recursive: true, force: true });
  }
});

test('a read-only snapshot refuses a lock appearing during its read without mutating it', () => {
  const state = setup();
  let lease;
  let lockReads = 0;
  let lockBytes;
  try {
    initializeCodeEvalPairEvidence(state.paths, state.input);
    const racingPaths = { ...state.paths };
    Object.defineProperty(racingPaths, 'lock', {
      enumerable: true,
      get() {
        lockReads += 1;
        // First access validates path containment and the second performs the
        // pre-read check. Model a writer acquiring immediately afterward.
        if (lockReads === 3) {
          lease = acquireCodeEvalPairEvidenceLock(state.paths);
          lockBytes = readFileSync(state.paths.lock, 'utf8');
        }
        return state.paths.lock;
      },
    });
    assert.throws(
      () => readCodeEvalPairReceiptsSnapshot(racingPaths, state.input),
      /snapshot refused because evidence became locked during the read/,
    );
    assert.ok(lease, 'the race fixture acquired the writer lock during the snapshot');
    assert.equal(existsSync(state.paths.lock), true);
    assert.equal(readFileSync(state.paths.lock, 'utf8'), lockBytes);
  } finally {
    if (lease && existsSync(state.paths.lock)) lease.release();
    rmSync(state.parent, { recursive: true, force: true });
  }
});

test('legacy evidence without a v1b generation is never adopted in place', () => {
  const state = setup();
  try {
    ensureCodeEvalPairEvidenceDir(state.paths);
    writeFileSync(state.paths.ledger, '{}\n', { mode: 0o600 });
    chmodSync(state.paths.ledger, 0o600);
    assert.throws(
      () => initializeCodeEvalPairEvidence(state.paths, state.input),
      /fresh evidence directory/,
    );
    assert.equal(existsSync(state.paths.generation), false);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('reservation selects scheduled-next under one global lock and embeds its complete cell key', () => {
  const state = setup();
  try {
    const first = reserve(state, '1');
    assert.deepEqual(first.cell, state.schedule[0]);
    assert.deepEqual(first.marker.cell, first.cell);
    assert.equal(first.marker.cellId, codeEvalPairCellIdentity(first.cell, state.c, state.e));
    assert.equal(statSync(state.paths.marker).mode & 0o777, 0o600);
    assert.throws(() => reserve(state, '2'), /unresolved in-flight marker/);

    const wrongNonce = unknownFor(state, first);
    assert.throws(
      () => appendCodeEvalPairReceipt(state.paths, wrongNonce, state.input, { reservationNonce: 'f'.repeat(32) }),
      /active reservation nonce/,
    );
    appendUnknown(state, first);
    assert.equal(existsSync(state.paths.marker), true, 'receipt fsync precedes marker cleanup');
    const afterFirst = codeEvalPairStatus(state.paths, state.input);
    assert.equal(afterFirst.staleMarkerCleared, true);
    assert.deepEqual(afterFirst.nextCell, state.schedule[1]);

    const second = reserve(state, '2');
    assert.deepEqual(second.cell, state.schedule[1]);
    appendUnknown(state, second, '2026-08-30T12:06:00.000Z');
    const complete = codeEvalPairStatus(state.paths, state.input);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.completedCells, 2);
    assert.equal(complete.pendingCells, 0);
    assert.equal(loadCodeEvalPairReceipts(state.paths, state.input).length, 2);
    assert.throws(() => reserve(state, '3'), /two-cell roster already has terminal receipts/);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('the ledger refuses duplicate, third, out-of-order, out-of-roster, and partial rows', () => {
  const duplicate = setup();
  try {
    const first = reserve(duplicate, '1');
    const receipt = appendUnknown(duplicate, first);
    codeEvalPairStatus(duplicate.paths, duplicate.input);
    writeFileSync(duplicate.paths.ledger, `${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    chmodSync(duplicate.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalPairReceipts(duplicate.paths, duplicate.input), /duplicate receipt/);

    writeFileSync(duplicate.paths.ledger, `${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    chmodSync(duplicate.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalPairReceipts(duplicate.paths, duplicate.input), /exceeds the exact two-cell roster/);

    const outside = { ...receipt, cellId: `cell1:${'0'.repeat(64)}` };
    writeFileSync(duplicate.paths.ledger, `${JSON.stringify(outside)}\n`, { mode: 0o600 });
    chmodSync(duplicate.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalPairReceipts(duplicate.paths, duplicate.input), /outside the frozen two-cell roster/);

    const outOfOrder = createUnknownCodeEvalPairReceipt({
      ...duplicate.input,
      cell: duplicate.schedule[1],
      recordedAt: '2026-08-30T12:08:00.000Z',
    });
    writeFileSync(duplicate.paths.ledger, `${JSON.stringify(outOfOrder)}\n`, { mode: 0o600 });
    chmodSync(duplicate.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalPairReceipts(duplicate.paths, duplicate.input), /out of the frozen scheduled order/);

    writeFileSync(duplicate.paths.ledger, JSON.stringify(receipt), { mode: 0o600 });
    chmodSync(duplicate.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalPairReceipts(duplicate.paths, duplicate.input), /partial final line/);
  } finally { rmSync(duplicate.parent, { recursive: true, force: true }); }
});

test('marker validation binds the complete cell key rather than trusting cellId alone', () => {
  const state = setup();
  try {
    const reserved = reserve(state, '1');
    const tampered = JSON.parse(readFileSync(state.paths.marker, 'utf8'));
    tampered.cell.armId = tampered.cell.armId === 'raw' ? 'native' : 'raw';
    writeFileSync(state.paths.marker, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    chmodSync(state.paths.marker, 0o600);
    assert.throws(() => loadCodeEvalPairInflightMarker(state.paths, state.input), /marker|cell/i);
    assert.equal(reserved.marker.cellId, tampered.cellId, 'the attack preserved the old cellId');
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('marker-driven recovery refuses uncertain liveness, seals once, and never targets next-pending', async () => {
  const state = setup();
  try {
    const first = reserve(state, '1');
    await assert.rejects(
      recoverCodeEvalPairCell(state.paths, state.input, { processesDead: async () => false }),
      /liveness is uncertain/,
    );
    assert.equal(existsSync(state.paths.marker), true);
    assert.equal(loadCodeEvalPairReceipts(state.paths, state.input).length, 0);

    const recovered = await recoverCodeEvalPairCell(state.paths, state.input, {
      processesDead: async marker => marker.cellId === first.marker.cellId,
      recordedAt: '2026-08-30T12:07:00.000Z',
    });
    assert.equal(recovered.action, 'sealed_unknown');
    assert.equal(recovered.receipt.cellId, first.marker.cellId);
    assert.equal(existsSync(state.paths.marker), false);
    assert.equal((await recoverCodeEvalPairCell(state.paths, state.input)).action, 'nothing_to_recover');

    const status = codeEvalPairStatus(state.paths, state.input);
    assert.equal(status.state, 'pending');
    assert.deepEqual(status.nextCell, state.schedule[1]);
    assert.equal((await recoverCodeEvalPairCell(state.paths, state.input)).action, 'nothing_to_recover',
      'one receipt plus a pending cell is not an instruction to recover the pending cell');
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('a fsynced matching receipt wins over its stale marker without any liveness probe', async () => {
  const state = setup();
  try {
    const first = reserve(state, '1');
    appendUnknown(state, first);
    let probed = false;
    const recovered = await recoverCodeEvalPairCell(state.paths, state.input, {
      processesDead: async () => { probed = true; return false; },
    });
    assert.equal(recovered.action, 'stale_marker_cleared');
    assert.equal(probed, false);
    assert.equal(existsSync(state.paths.marker), false);
    assert.equal(codeEvalPairStatus(state.paths, state.input).state, 'pending');
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('recovery compares the entire marker after an out-of-lock liveness proof', async () => {
  const state = setup();
  try {
    reserve(state, '1');
    await assert.rejects(recoverCodeEvalPairCell(state.paths, state.input, {
      processesDead: async marker => {
        const replacement = { ...marker, reservationNonce: 'e'.repeat(32) };
        writeFileSync(state.paths.marker, `${JSON.stringify(replacement, null, 2)}\n`, { mode: 0o600 });
        chmodSync(state.paths.marker, 0o600);
        return true;
      },
    }), /marker changed during recovery/);
    assert.equal(loadCodeEvalPairReceipts(state.paths, state.input).length, 0);
    assert.equal(existsSync(state.paths.marker), true);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('only an explicit dead-owner proof clears the global evidence lease', async () => {
  const state = setup();
  try {
    acquireCodeEvalPairEvidenceLock(state.paths, { owner: 'pid-999999' });
    await assert.rejects(
      recoverAbandonedCodeEvalPairEvidenceLock(state.paths, { ownerDead: async () => false }),
      /liveness is uncertain/,
    );
    assert.equal(existsSync(state.paths.lock), true);
    const recovered = await recoverAbandonedCodeEvalPairEvidenceLock(state.paths, {
      ownerDead: async lock => lock.owner === 'pid-999999',
    });
    assert.equal(recovered.action, 'stale_lock_cleared');
    assert.equal(existsSync(state.paths.lock), false);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});
