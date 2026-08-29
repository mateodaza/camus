import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  codeEvalCampaignIdentity,
  createCodeEvalCell,
  createCodeEvalReceipt,
} from './code-eval-contract.mjs';
import {
  acquireCodeEvalEvidenceLock,
  appendCodeEvalReceipt,
  codeEvalEvidencePaths,
  codeEvalStatus,
  createCodeEvalInflightMarker,
  ensureCodeEvalEvidenceDir,
  loadCodeEvalInflightMarker,
  loadCodeEvalReceipts,
  recoverAbandonedCodeEvalEvidenceLock,
  recoverCodeEvalCell,
  reserveCodeEvalCell,
} from './code-eval-ledger.mjs';

const hash = (character = 'a') => `sha256:${character.repeat(64)}`;

function campaign() {
  return {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1a',
    campaignId: 'qwen-native-smoke-v1',
    campaignMode: 'native_smoke',
    standing: 'exploratory_only',
    case: {
      caseId: 'simple-parser-fix', caseVersion: 1, taskClass: 'simple',
      fixtureId: `fixture1:${'f'.repeat(64)}`,
      fixtureTreeDigest: hash('1'), baseCommitDigest: hash('2'),
      taskSha256: hash('3'), acceptanceContractSha256: hash('4'),
      verifier: {
        kind: 'host_command', commandSha256: hash('5'), timeoutMs: 120_000,
        expectedBase: 'red', expectedReference: 'green',
      },
    },
    treatment: {
      maker: {
        backend: 'dashscope_qwen', provider: 'alibaba', model: 'qwen3-coder-plus',
        effort: null, trainingOrg: 'alibaba', transport: 'direct_https',
        connection: 'dashscope-primary',
      },
      reviewer: {
        backend: 'codex', model: 'gpt-5.6-sol', effort: 'high', trainingOrg: 'openai',
      },
      executor: 'qwen_native',
    },
    controls: {
      maximumCells: 1, maximumProviderCallsPerCell: 6,
      maximumMakerCallsPerCell: 4, maximumReviewerCallsPerCell: 2,
      maximumSteps: 4, maximumActions: 16, maximumRepairs: 1, maximumRetries: 0,
      maximumTokensReserved: 100_000, wallTimeoutMs: 1_200_000,
      callTimeoutMs: 600_000, publish: false, commit: false, merge: false,
      push: false, automaticRouting: false,
    },
  };
}

function execution(c, createdAt = '2026-08-29T12:00:00.000Z') {
  return {
    schemaVersion: 1,
    campaignDigest: codeEvalCampaignIdentity(c),
    createdAt,
    runtime: {
      packageVersion: '0.4.9', treeDigest: hash('6'), platform: 'darwin',
      architecture: 'arm64', nodeVersion: 'v22.20.0',
    },
    maker: {
      backendDefinitionDigest: hash('7'), qualificationFingerprint: `qual1:${'8'.repeat(64)}`,
      credentialRevision: hash('9'), connectionDefinitionDigest: hash('a'),
      expectedModel: c.treatment.maker.model,
    },
    reviewer: {
      backendDefinitionDigest: hash('b'), qualificationFingerprint: `builtin1:${'c'.repeat(64)}`,
      credentialRevision: 'none', connectionDefinitionDigest: hash('d'),
      expectedModel: c.treatment.reviewer.model,
    },
    nativeHarness: {
      executor: 'qwen_native', name: 'qwen_code', version: '1.2.3', artifactDigest: hash('e'),
      parserVersion: 'native-parser-v1', outerSandboxPolicyDigest: hash('f'),
      credentialGatewayPolicyDigest: hash('0'),
    },
    verifierDigest: hash('1'),
    fixtureReadinessDigest: hash('2'),
  };
}

function success(c, e) {
  return createCodeEvalReceipt({
    campaign: c,
    execution: e,
    recordedAt: '2026-08-29T12:05:00.000Z',
    observedIdentity: {
      makerModel: e.maker.expectedModel, reviewerModel: e.reviewer.expectedModel,
      executor: e.nativeHarness.executor, harnessArtifactDigest: e.nativeHarness.artifactDigest,
      identityStable: true, substitutionDetected: false, helperModelDetected: false,
      fallbackDetected: false,
    },
    outcome: {
      status: 'candidate_ready_for_acceptance', reasonCode: null, possibleBilling: true,
      candidateFingerprint: hash('3'),
    },
    quality: {
      fixturePreflightPassed: true, candidateIntegrityPassed: true, containmentPassed: true,
      verificationPassed: true, reviewVerdict: 'APPROVED', humanInterventionDuringRun: false,
      mechanicalFloorPassed: true,
    },
    economics: {
      providerCalls: 2, makerCalls: 1, reviewerCalls: 1, inputTokens: 1000,
      outputTokens: 200, wallMs: 10_000, costUsd: null, currency: null,
      usageIncomplete: false,
    },
    custody: {
      candidateBindingMatch: true, verificationBindingMatch: true, reviewBindingMatch: true,
    },
    artifacts: { buildReportDigest: hash('4') },
  });
}

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'camus-code-eval-'));
  const paths = codeEvalEvidencePaths(join(parent, 'private-evidence'));
  const c = campaign();
  const e = execution(c);
  const cell = createCodeEvalCell(c, e);
  const input = { campaign: c, execution: e, cell };
  return { parent, paths, c, e, cell, input };
}

function marker(input, overrides = {}) {
  return createCodeEvalInflightMarker({
    ...input,
    buildRunId: overrides.buildRunId ?? 'build-run-1',
    supervisorIdentity: overrides.supervisorIdentity ?? `pid-${process.pid}`,
    maximumProviderCallsReserved: 6,
    startedAt: overrides.startedAt ?? '2026-08-29T12:01:00.000Z',
  });
}

test('a missing evidence root is created 0700, while an existing 0755 root is refused unchanged', () => {
  const first = setup();
  try {
    ensureCodeEvalEvidenceDir(first.paths);
    assert.equal(statSync(first.paths.dir).mode & 0o777, 0o700);
  } finally { rmSync(first.parent, { recursive: true, force: true }); }

  const parent = mkdtempSync(join(tmpdir(), 'camus-code-eval-public-'));
  const root = join(parent, 'not-private');
  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o755);
  try {
    assert.throws(() => ensureCodeEvalEvidenceDir(codeEvalEvidencePaths(root)), /already be 0700/);
    assert.equal(statSync(root).mode & 0o777, 0o755, 'the caller-owned mode must remain unchanged');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('only explicit dead-owner recovery can clear an abandoned evidence lease', async () => {
  const state = setup();
  try {
    acquireCodeEvalEvidenceLock(state.paths, { owner: 'pid-999999' });
    await assert.rejects(
      recoverAbandonedCodeEvalEvidenceLock(state.paths, { ownerDead: async () => false }),
      /liveness is uncertain/,
    );
    assert.equal(existsSync(state.paths.lock), true);
    const recovered = await recoverAbandonedCodeEvalEvidenceLock(state.paths, {
      ownerDead: async lock => lock.owner === 'pid-999999',
    });
    assert.equal(recovered.action, 'stale_lock_cleared');
    assert.equal(existsSync(state.paths.lock), false);
    assert.equal(codeEvalStatus(state.paths, state.input).state, 'pending');
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('the exclusive sibling lease permits one writer and is visible across processes', () => {
  const state = setup();
  try {
    const lease = acquireCodeEvalEvidenceLock(state.paths);
    assert.equal(statSync(state.paths.lock).mode & 0o777, 0o600);
    assert.throws(() => acquireCodeEvalEvidenceLock(state.paths), /locked by another writer/);

    const moduleUrl = new URL('./code-eval-ledger.mjs', import.meta.url).href;
    const child = `
      import { codeEvalEvidencePaths, acquireCodeEvalEvidenceLock } from ${JSON.stringify(moduleUrl)};
      try {
        const lease = acquireCodeEvalEvidenceLock(codeEvalEvidencePaths(process.argv[1]));
        lease.release();
        process.exit(0);
      } catch { process.exit(23); }
    `;
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', child, state.paths.dir]);
    assert.equal(blocked.status, 23, 'the competing process must lose without stealing');
    lease.release();
    const afterRelease = spawnSync(process.execPath, ['--input-type=module', '-e', child, state.paths.dir]);
    assert.equal(afterRelease.status, 0, afterRelease.stderr?.toString());
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('reservation is private, atomic, and an unresolved marker can never replay', () => {
  const state = setup();
  try {
    const reserved = reserveCodeEvalCell(state.paths, marker(state.input), state.input);
    assert.equal(reserved.cellId, marker(state.input).cellId);
    assert.equal(statSync(state.paths.marker).mode & 0o777, 0o600);
    assert.equal(existsSync(state.paths.lock), false, 'the bounded writer lease is released');
    assert.deepEqual(codeEvalStatus(state.paths, state.input), {
      state: 'paused_inflight_unknown', standing: 'unknown', canAttempt: false,
      replayAllowed: false, staleMarkerCleared: false, cellId: reserved.cellId, receiptId: null,
    });
    assert.throws(
      () => reserveCodeEvalCell(state.paths, marker(state.input, { buildRunId: 'build-run-2' }), state.input),
      /unresolved in-flight marker/,
    );
    const malformed = { ...reserved, unexpected: true };
    writeFileSync(state.paths.marker, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    chmodSync(state.paths.marker, 0o600);
    assert.throws(() => loadCodeEvalInflightMarker(state.paths, state.input), /unknown field: unexpected/);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('recovery refuses uncertain liveness, then seals one unknown receipt without replay', async () => {
  const state = setup();
  try {
    reserveCodeEvalCell(state.paths, marker(state.input), state.input);
    await assert.rejects(
      recoverCodeEvalCell(state.paths, state.input, { processesDead: async () => false }),
      /liveness is uncertain/,
    );
    assert.equal(existsSync(state.paths.marker), true);
    assert.equal(loadCodeEvalReceipts(state.paths, state.input).length, 0);

    const result = await recoverCodeEvalCell(state.paths, state.input, {
      processesDead: async (value) => value.supervisorIdentity === `pid-${process.pid}`,
      recordedAt: '2026-08-29T12:07:00.000Z',
    });
    assert.equal(result.action, 'sealed_unknown');
    assert.equal(result.receipt.standing, 'unknown');
    assert.equal(existsSync(state.paths.marker), false);
    assert.equal(statSync(state.paths.ledger).mode & 0o777, 0o600);
    assert.equal(loadCodeEvalReceipts(state.paths, state.input).length, 1);
    const terminal = codeEvalStatus(state.paths, state.input);
    assert.equal(terminal.state, 'complete');
    assert.equal(terminal.standing, 'unknown');
    assert.equal(terminal.canAttempt, false);
    assert.throws(() => reserveCodeEvalCell(state.paths, marker(state.input), state.input), /can never replay/);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('a fsynced receipt wins over a stale marker and duplicate appends refuse', () => {
  const state = setup();
  try {
    reserveCodeEvalCell(state.paths, marker(state.input), state.input);
    const receipt = success(state.c, state.e);
    appendCodeEvalReceipt(state.paths, receipt, state.input);
    assert.equal(existsSync(state.paths.marker), true, 'simulate crash before marker clear');
    const status = codeEvalStatus(state.paths, state.input);
    assert.equal(status.state, 'complete');
    assert.equal(status.standing, 'execution_observed');
    assert.equal(status.staleMarkerCleared, true);
    assert.equal(existsSync(state.paths.marker), false);
    assert.throws(() => appendCodeEvalReceipt(state.paths, receipt, state.input), /duplicate receipt/);
    assert.equal(readFileSync(state.paths.ledger, 'utf8').trim().split('\n').length, 1);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});

test('mixed generations and partial JSONL fail closed before further evidence', () => {
  const state = setup();
  try {
    ensureCodeEvalEvidenceDir(state.paths);
    const otherExecution = execution(state.c, '2026-08-29T12:00:01.000Z');
    const otherReceipt = success(state.c, otherExecution);
    writeFileSync(state.paths.ledger, `${JSON.stringify(otherReceipt)}\n`, { mode: 0o600 });
    chmodSync(state.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalReceipts(state.paths, state.input), /mixed-generation/);

    writeFileSync(state.paths.ledger, JSON.stringify(success(state.c, state.e)), { mode: 0o600 });
    chmodSync(state.paths.ledger, 0o600);
    assert.throws(() => loadCodeEvalReceipts(state.paths, state.input), /partial final line/);
  } finally { rmSync(state.parent, { recursive: true, force: true }); }
});
