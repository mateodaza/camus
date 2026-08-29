import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodeEvalArgs } from '../code-eval.mjs';
import { loadCodeEvalFixture } from './code-eval-fixture.mjs';
import { codeEvalRuntimeIdentity, planCodeEval, recoverCodeEval, runCodeEval, statusCodeEval } from './code-eval-runner.mjs';
import { acquireCodeEvalEvidenceLock, codeEvalEvidencePaths, createCodeEvalInflightMarker, reserveCodeEvalCell } from './code-eval-ledger.mjs';
import { createCodeEvalCell } from './code-eval-contract.mjs';

const hex = character => character.repeat(64);

async function setup(t, executor = 'qwen_native') {
  const root = await mkdtemp(join(tmpdir(), 'camus-code-eval-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await loadCodeEvalFixture();
  const campaign = {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1a',
    campaignId: `${executor.replace('_native', '')}-simple-smoke-v1`,
    campaignMode: 'native_smoke',
    standing: 'exploratory_only',
    case: {
      caseId: fixture.manifest.caseId,
      caseVersion: 1,
      taskClass: 'simple',
      fixtureId: fixture.fixtureId,
      fixtureTreeDigest: fixture.baseTreeDigest,
      baseCommitDigest: fixture.baseTreeDigest,
      taskSha256: fixture.taskSha256,
      acceptanceContractSha256: fixture.acceptanceContractSha256,
      verifier: { kind: 'host_command', commandSha256: fixture.verifierDigest,
        timeoutMs: fixture.manifest.verifier.timeoutMs, expectedBase: 'red', expectedReference: 'green' },
    },
    treatment: {
      maker: { backend: 'fixture-maker', provider: 'dashscope', model: 'fixture-model', effort: null,
        trainingOrg: 'fixture-maker-org', transport: 'direct_https', connection: 'fixture-connection' },
      reviewer: { backend: 'fixture-reviewer', model: 'fixture-reviewer-model', effort: 'medium', trainingOrg: 'fixture-reviewer-org' },
      executor,
    },
    controls: {
      maximumCells: 1, maximumProviderCallsPerCell: 3, maximumMakerCallsPerCell: 2,
      maximumReviewerCallsPerCell: 1, maximumSteps: 4, maximumActions: 8,
      maximumRepairs: 0, maximumRetries: 0, maximumTokensReserved: 32768,
      wallTimeoutMs: 120000, callTimeoutMs: 60000,
      publish: false, commit: false, merge: false, push: false, automaticRouting: false,
    },
  };
  const campaignPath = join(root, 'campaign.json');
  const evidence = join(root, 'evidence');
  const statePath = join(evidence, 'state.json'), ledgerPath = join(evidence, 'receipts.jsonl');
  await writeFile(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
  const prepared = {
    models: {
      maker: { ...campaign.treatment.maker, qualification: { fingerprint: `qual1:${hex('1')}` }, codeExecutor: executor },
      reviewer: { ...campaign.treatment.reviewer, provider: 'openai', transport: 'vendor_managed', connection: null,
        qualification: { fingerprint: `builtin1:${hex('2')}` } },
      loop: {},
    },
    frozenBackends: {
      maker: { name: 'fixture-maker', kind: 'openai_compat', provider: 'dashscope', transport: 'direct_https',
        connection: 'fixture-connection', auth: { kind: 'none' }, baseUrl: 'https://synthetic.invalid/v1' },
      reviewer: { name: 'fixture-reviewer', kind: 'codex_cli', provider: 'openai', transport: 'vendor_managed', auth: { kind: 'none' } },
    },
    adapters: { maker: async () => {}, reviewer: async () => {}, nativeMaker: async () => {} },
    authorize: async () => {},
  };
  const freshPrepared = () => ({ models: structuredClone(prepared.models), frozenBackends: structuredClone(prepared.frozenBackends),
    adapters: prepared.adapters, authorize: prepared.authorize });
  const dependencies = {
    prepareExecution: async () => freshPrepared(),
    harnessReadiness: async () => ({ ready: true, status: 'ready', label: executor, requiredVersion: executor === 'qwen_native' ? '0.22.3' : '1.0.5' }),
    resolveHarness: async () => '/synthetic/private/harness',
    assertArtifact: async () => hex('3'),
    runtimeIdentity: async () => ({ packageVersion: '0.4.9', treeDigest: `sha256:${hex('4')}`,
      platform: 'darwin', architecture: 'arm64', nodeVersion: '22.0.0' }),
    env: {},
  };
  return { root, campaign, campaignPath, statePath, ledgerPath, dependencies, prepared, freshPrepared };
}

test('CLI makes live consent literal and keeps all other operations provider-free', () => {
  const common = ['--campaign', 'campaign.json', '--state', 'state.json', '--ledger', 'receipts.jsonl'];
  assert.equal(parseCodeEvalArgs(['fixture', '--json']).command, 'fixture');
  assert.throws(() => parseCodeEvalArgs(['fixture', '--allow-provider-calls']), /accepts only --json/);
  assert.equal(parseCodeEvalArgs(['plan', ...common]).command, 'plan');
  assert.throws(() => parseCodeEvalArgs(['run', ...common]), /allow-provider-calls/);
  assert.throws(() => parseCodeEvalArgs(['run', '--allow-provider-calls', '--max-cells', '2', ...common]), /max-cells 1/);
  assert.equal(parseCodeEvalArgs(['run', '--allow-provider-calls', '--max-cells', '1', ...common]).command, 'run');
  assert.throws(() => parseCodeEvalArgs(['status', '--allow-provider-calls', ...common]), /does not accept provider-call authority/);
  assert.throws(() => parseCodeEvalArgs(['recover', '--action', 'retry', ...common]), /seal-infra/);
});

test('runtime identity binds packaged cross-package policy and schema files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-code-eval-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = 'packages/cli/skills/camus/control-plane.mjs';
  const schema = 'apps/loop-studio/checks/review.schema.json';
  for (const name of [policy, schema]) await mkdir(join(root, name, '..'), { recursive: true });
  await writeFile(join(root, policy), 'export const policy = 1;\n');
  await writeFile(join(root, schema), '{"schema":1}\n');
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, files: [schema, policy].sort() })}\n`);
  const packagePath = join(root, 'package.json'); await writeFile(packagePath, '{"version":"9.8.7"}\n');
  const first = await codeEvalRuntimeIdentity({ runtimeRoot: root, packagePath });
  assert.equal(first.packageVersion, '9.8.7');
  await writeFile(join(root, schema), '{"schema":2}\n');
  const second = await codeEvalRuntimeIdentity({ runtimeRoot: root, packagePath });
  assert.notEqual(second.treeDigest, first.treeDigest);
});

test('plan/status are spend-free, private and idempotently freeze one exact cell', async t => {
  const item = await setup(t); let prepared = 0;
  const dependencies = { ...item.dependencies, prepareExecution: async () => { prepared++; return item.freshPrepared(); } };
  const planned = await planCodeEval(item, dependencies);
  assert.equal(planned.providerCallsMade, 0); assert.equal(planned.totalCells, 1);
  assert.equal(planned.claim, 'no_execution_claim'); assert.equal(prepared, 1);
  assert.equal((await stat(item.statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(item.root, 'evidence'))).mode & 0o777, 0o700);
  const status = await statusCodeEval(item); assert.equal(status.state, 'pending'); assert.equal(status.providerCallsMade, 0);
  const again = await planCodeEval(item, dependencies); assert.equal(again.executionDigest, planned.executionDigest); assert.equal(prepared, 2);
  assert.equal((await readFile(item.ledgerPath, 'utf8').catch(error => error.code)), 'ENOENT');
});

test('one fake shared-engine cell observes the marker first, seals once and never replays', async t => {
  const item = await setup(t); await planCodeEval(item, item.dependencies);
  let calls = 0;
  const fingerprint = hex('5');
  item.prepared.adapters.nativeMaker = async options => {
    assert.equal(options.maxModelCalls, 2, 'the maker receives only its frozen provider-call share');
    options.onNativeProgress({ responses: 2 });
  };
  item.prepared.adapters.reviewer = async () => {};
  const dependencies = {
    ...item.dependencies,
    createVerifier: () => async () => ({ ran: true, pass: true }),
    readCheckpoint: async () => ({ nativeSession: { executor: item.campaign.treatment.executor,
      model: item.campaign.treatment.maker.model, version: 'native-harness-isolation/v1',
      harnessVersion: item.campaign.treatment.executor === 'qwen_native' ? '0.22.3' : '1.0.5' } }),
    runSeats: async ({ repoPath, adapters }) => {
      calls++;
      await stat(join(item.root, 'evidence', 'inflight.json'));
      assert.match(await readFile(join(repoPath, 'src', 'bounded-parser.mjs'), 'utf8'), /parsed >= max/);
      assert.equal((await stat(join(repoPath, '.git'))).isDirectory(), true);
      await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null });
      assert.equal((await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null })).noModelCalled, true);
      await adapters.reviewer({});
      assert.equal((await adapters.reviewer({})).noModelCalled, true);
      return {
        status: 'needs_decision', completion: 'candidate_ready_for_acceptance',
        candidate: { fingerprint }, verificationBinding: fingerprint, reviewBinding: fingerprint,
        verification: { ran: true, pass: true }, review: { verdict: 'APPROVED' },
        seats: {
          maker: { observed: { identity: 'dashscope:fixture-model', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
          reviewer: { observed: { identity: 'openai:fixture-reviewer-model', usage: { input_tokens: 8, output_tokens: 2 } } },
        },
        usage: { calls: 3 },
      };
    },
  };
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.equal(result.standing, 'execution_observed'); assert.equal(result.outcome, 'candidate_ready_for_acceptance');
  assert.equal(calls, 1); await assert.rejects(stat(join(item.root, 'evidence', 'inflight.json')), { code: 'ENOENT' });
  const lines = (await readFile(item.ledgerPath, 'utf8')).trim().split('\n'); assert.equal(lines.length, 1);
  await assert.rejects(runCodeEval({ ...item, consent: true, maxCells: 1 }, dependencies), /can never replay/);
  assert.equal(calls, 1);
});

test('plain model labels cannot satisfy exact provider-qualified identity evidence', async t => {
  const item = await setup(t); await planCodeEval(item, item.dependencies);
  const fingerprint = hex('6');
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async (_fixture, path) => mkdir(path, { recursive: true, mode: 0o700 }),
    createVerifier: () => async () => ({ ran: true, pass: true }),
    readCheckpoint: async () => ({ nativeSession: { executor: item.campaign.treatment.executor,
      model: item.campaign.treatment.maker.model, version: 'native-harness-isolation/v1', harnessVersion: '0.22.3' } }),
    runSeats: async () => ({
      status: 'needs_decision', completion: 'candidate_ready_for_acceptance',
      candidate: { fingerprint }, verificationBinding: fingerprint, reviewBinding: fingerprint,
      verification: { ran: true, pass: true }, review: { verdict: 'APPROVED' },
      seats: {
        maker: { observed: { identity: 'fixture-model', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
        reviewer: { observed: { identity: 'openai:fixture-reviewer-model', usage: { input_tokens: 8, output_tokens: 2 } } },
      },
      usage: { calls: 2 },
    }),
  });
  assert.equal(result.standing, 'failed');
});

test('symlinked evidence artifact directories refuse before reservation or execution', async t => {
  const item = await setup(t); await planCodeEval(item, item.dependencies);
  const outside = join(item.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(item.root, 'evidence', 'sources'), 'dir');
  let materialized = false, executed = false;
  await assert.rejects(runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async () => { materialized = true; },
    runSeats: async () => { executed = true; },
  }), /sources must be a real private 0700 directory/);
  assert.equal(materialized, false); assert.equal(executed, false);
  await assert.rejects(stat(join(item.root, 'evidence', 'inflight.json')), { code: 'ENOENT' });
});

test('drift refuses before reservation and an unresolved marker recovers only as unknown', async t => {
  const drift = await setup(t); await planCodeEval(drift, drift.dependencies);
  await assert.rejects(runCodeEval({ ...drift, consent: true, maxCells: 1 }, { ...drift.dependencies,
    assertArtifact: async () => hex('9') }), /Execution state drifted before spend/);
  await assert.rejects(stat(join(drift.root, 'evidence', 'inflight.json')), { code: 'ENOENT' });

  const crashed = await setup(t, 'grok_native'); await planCodeEval(crashed, crashed.dependencies);
  const campaign = JSON.parse(await readFile(crashed.campaignPath, 'utf8'));
  const execution = JSON.parse(await readFile(crashed.statePath, 'utf8'));
  const cell = createCodeEvalCell(campaign, execution); const paths = codeEvalEvidencePaths(join(crashed.root, 'evidence'));
  reserveCodeEvalCell(paths, createCodeEvalInflightMarker({ campaign, execution, cell, buildRunId: 'crashed-run',
    supervisorIdentity: 'pid-999999', maximumProviderCallsReserved: 3 }), { campaign, execution, cell });
  await assert.rejects(recoverCodeEval({ ...crashed, action: 'seal-infra' }, { processesDead: async () => false }), /liveness is uncertain/);
  const recovered = await recoverCodeEval({ ...crashed, action: 'seal-infra' }, { processesDead: async () => true });
  assert.equal(recovered.standing, 'unknown'); assert.equal(recovered.outcome, 'interrupted_unknown'); assert.equal(recovered.providerCallsMade, 0);
  assert.equal((await statusCodeEval(crashed)).state, 'complete');

  const abandoned = await setup(t); await planCodeEval(abandoned, abandoned.dependencies);
  acquireCodeEvalEvidenceLock(codeEvalEvidencePaths(join(abandoned.root, 'evidence')), { owner: 'pid-999999' });
  const unlocked = await recoverCodeEval({ ...abandoned, action: 'seal-infra' }, { lockOwnerDead: async () => true });
  assert.equal(unlocked.action, 'stale_lock_cleared_no_attempt');
  assert.equal(unlocked.canAttempt, true);
});
