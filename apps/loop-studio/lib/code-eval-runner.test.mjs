import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodeEvalArgs } from '../code-eval.mjs';
import { loadCodeEvalFixtureForCase } from './code-eval-fixture.mjs';
import { codeEvalRuntimeIdentity, planCodeEval, recoverCodeEval, runCodeEval, statusCodeEval } from './code-eval-runner.mjs';
import { acquireCodeEvalEvidenceLock, codeEvalEvidencePaths, createCodeEvalInflightMarker, reserveCodeEvalCell } from './code-eval-ledger.mjs';
import { createCodeEvalCell } from './code-eval-contract.mjs';
import { HARNESS_POLICY_VERSION } from './native-harness-policy.mjs';
import { GROK_SUBSCRIPTION_NATIVE_POLICY_VERSION } from './adapters/grok-subscription.mjs';

const hex = character => character.repeat(64);

async function setup(t, executor = 'qwen_native', {
  openRouter = false, caseId = 'simple-bounded-parser-fix',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'camus-code-eval-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await loadCodeEvalFixtureForCase(caseId);
  const campaign = {
    schemaVersion: 1,
    treatmentProtocol: 'code-harness-eval-v1a',
    campaignId: `${executor.replace('_native', '')}-${fixture.manifest.taskClass}-smoke-v1`,
    campaignMode: 'native_smoke',
    standing: 'exploratory_only',
    case: {
      caseId: fixture.manifest.caseId,
      caseVersion: 1,
      taskClass: fixture.manifest.taskClass,
      fixtureId: fixture.fixtureId,
      fixtureTreeDigest: fixture.baseTreeDigest,
      baseCommitDigest: fixture.baseTreeDigest,
      taskSha256: fixture.taskSha256,
      acceptanceContractSha256: fixture.acceptanceContractSha256,
      verifier: { kind: 'host_command', commandSha256: fixture.verifierDigest,
        timeoutMs: fixture.manifest.verifier.timeoutMs, expectedBase: 'red', expectedReference: 'green' },
    },
    treatment: {
      maker: { backend: 'fixture-maker', provider: openRouter ? 'openrouter' : 'dashscope', model: 'fixture-model', effort: null,
        trainingOrg: 'fixture-maker-org', transport: 'direct_https', connection: 'fixture-connection',
        route: openRouter ? { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false } : null },
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
      maker: { name: 'fixture-maker', kind: 'openai_compat', provider: openRouter ? 'openrouter' : 'dashscope', transport: 'direct_https',
        connection: 'fixture-connection', auth: { kind: 'none' }, baseUrl: 'https://synthetic.invalid/v1',
        ...(openRouter ? { route: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false } } : {}) },
      reviewer: { name: 'fixture-reviewer', kind: 'codex_cli', provider: 'openai', transport: 'vendor_managed', auth: { kind: 'none' } },
    },
    adapters: { maker: async () => {}, reviewer: async () => {}, nativeMaker: async () => {} },
    authorize: async () => {},
  };
  const freshPrepared = () => ({ models: structuredClone(prepared.models), frozenBackends: structuredClone(prepared.frozenBackends),
    adapters: prepared.adapters, authorize: prepared.authorize });
  const dependencies = {
    prepareExecution: async () => freshPrepared(),
    harnessReadiness: async () => ({ ready: true, status: 'ready', label: executor, requiredVersion: executor === 'qwen_native' ? '0.22.3' : '1.0.13' }),
    resolveHarness: async () => '/synthetic/private/harness',
    assertArtifact: async () => hex('3'),
    runtimeIdentity: async () => ({ packageVersion: '0.4.9', treeDigest: `sha256:${hex('4')}`,
      platform: 'darwin', architecture: 'arm64', nodeVersion: '22.0.0' }),
    env: {},
  };
  return { root, campaign, campaignPath, statePath, ledgerPath, dependencies, fixture, prepared, freshPrepared };
}

test('CLI makes live consent literal and keeps all other operations provider-free', () => {
  const common = ['--campaign', 'campaign.json', '--state', 'state.json', '--ledger', 'receipts.jsonl'];
  assert.equal(parseCodeEvalArgs(['fixture', '--json']).command, 'fixture');
  assert.equal(parseCodeEvalArgs(['fixture', '--case', 'balanced-job-event-scheduler', '--json']).case, 'balanced-job-event-scheduler');
  assert.throws(() => parseCodeEvalArgs(['fixture', '--allow-provider-calls']), /accepts only --case and --json/);
  assert.equal(parseCodeEvalArgs(['plan', ...common]).command, 'plan');
  assert.equal(parseCodeEvalArgs(['summarize', ...common]).command, 'summarize');
  assert.throws(() => parseCodeEvalArgs(['plan', '--case', 'balanced-job-event-scheduler', ...common]), /does not accept --case/);
  assert.throws(() => parseCodeEvalArgs(['run', ...common]), /allow-provider-calls/);
  assert.throws(() => parseCodeEvalArgs(['run', '--allow-provider-calls', '--max-cells', '2', ...common]), /max-cells 1/);
  assert.equal(parseCodeEvalArgs(['run', '--allow-provider-calls', '--max-cells', '1', ...common]).command, 'run');
  assert.throws(() => parseCodeEvalArgs(['status', '--allow-provider-calls', ...common]), /does not accept provider-call authority/);
  assert.throws(() => parseCodeEvalArgs(['summarize', '--max-cells', '1', ...common]), /does not accept provider-call authority/);
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
  assert.equal(planned.route, null);
  assert.equal(planned.claim, 'no_execution_claim'); assert.equal(prepared, 1);
  assert.equal((await stat(item.statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(item.root, 'evidence'))).mode & 0o777, 0o700);
  const status = await statusCodeEval(item); assert.equal(status.state, 'pending'); assert.equal(status.providerCallsMade, 0);
  const again = await planCodeEval(item, dependencies); assert.equal(again.executionDigest, planned.executionDigest); assert.equal(prepared, 2);
  assert.equal((await readFile(item.ledgerPath, 'utf8').catch(error => error.code)), 'ENOENT');
});

test('plan resolves and binds the balanced fixture selected by the campaign', async t => {
  const item = await setup(t, 'qwen_native', { caseId: 'balanced-job-event-scheduler' });
  const planned = await planCodeEval(item, item.dependencies);
  assert.deepEqual(planned.fixture, {
    caseId: 'balanced-job-event-scheduler',
    taskClass: 'balanced',
    base: 'red',
    reference: 'green',
  });
  assert.equal(planned.providerCallsMade, 0);
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
      model: item.campaign.treatment.maker.model, version: HARNESS_POLICY_VERSION,
      harnessVersion: item.campaign.treatment.executor === 'qwen_native' ? '0.22.3' : '1.0.13' } }),
    runSeats: async ({ repoPath, adapters }) => {
      calls++;
      await stat(join(item.root, 'evidence', 'inflight.json'));
      assert.match(await readFile(join(repoPath, 'src', 'bounded-parser.mjs'), 'utf8'), /parsed >= max/);
      await writeFile(join(repoPath, 'src', 'bounded-parser.mjs'), item.fixture.referenceFiles[0].content);
      assert.equal((await stat(join(repoPath, '.git'))).isDirectory(), true);
      await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null });
      assert.equal((await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null })).noModelCalled, true);
      await adapters.reviewer({});
      assert.equal((await adapters.reviewer({})).noModelCalled, true);
      return {
        status: 'needs_decision', completion: 'candidate_ready_for_acceptance',
        candidate: { worktree: repoPath, fingerprint }, verificationBinding: fingerprint, reviewBinding: fingerprint,
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

async function syntheticIdentityReceipt(item, seats) {
  await planCodeEval(item, item.dependencies);
  const fingerprint = hex('6');
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async (_fixture, path) => mkdir(path, { recursive: true, mode: 0o700 }),
    inspectCandidateIntegrity: async () => true,
    createVerifier: () => async () => ({ ran: true, pass: true }),
    readCheckpoint: async () => ({ nativeSession: { executor: item.campaign.treatment.executor,
      model: item.campaign.treatment.maker.model,
      version: item.prepared.frozenBackends.maker.kind === 'grok_cli'
        ? GROK_SUBSCRIPTION_NATIVE_POLICY_VERSION : HARNESS_POLICY_VERSION,
      harnessVersion: item.campaign.treatment.executor === 'grok_native' ? '1.0.13' : '0.22.3' } }),
    runSeats: async ({ repoPath }) => ({
      status: seats.reviewer?.observed ? 'needs_decision' : 'stopped', completion: 'candidate_ready_for_acceptance',
      candidate: seats.reviewer?.observed ? { worktree: repoPath, fingerprint } : null,
      verificationBinding: seats.reviewer?.observed ? fingerprint : null,
      reviewBinding: seats.reviewer?.observed ? fingerprint : null,
      verification: { ran: true, pass: true }, review: seats.reviewer?.observed ? { verdict: 'APPROVED' } : null,
      seats, usage: { calls: 2 },
    }),
  });
  return { result, receipt: JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim()) };
}

test('plain model labels cannot satisfy exact provider-qualified identity evidence', async t => {
  const item = await setup(t);
  const { result, receipt } = await syntheticIdentityReceipt(item, {
    maker: { observed: { identity: 'fixture-model', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
    reviewer: { observed: { identity: 'openai:fixture-reviewer-model', usage: { input_tokens: 8, output_tokens: 2 } } },
  });
  assert.equal(result.standing, 'failed');
  assert.equal(receipt.observedIdentity.substitutionDetected, true);
});

test('an absent reviewer identity remains unknown rather than becoming a false substitution', async t => {
  const item = await setup(t);
  const { result, receipt } = await syntheticIdentityReceipt(item, {
    maker: { observed: { identity: 'dashscope:fixture-model', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
    reviewer: { observed: null },
  });
  assert.equal(result.standing, 'failed');
  assert.equal(receipt.observedIdentity.makerModel, 'fixture-model');
  assert.equal(receipt.observedIdentity.reviewerModel, null);
  assert.equal(receipt.observedIdentity.substitutionDetected, null);
});

test('subscription Grok receipts bind the ACP policy rather than the API-gateway policy', async t => {
  const item = await setup(t, 'grok_native');
  const maker = { backend: 'grok', provider: 'xai', model: 'grok-4.6', effort: 'medium', trainingOrg: 'xai',
    transport: 'vendor_managed', connection: null, route: null };
  item.campaign.treatment.maker = maker;
  item.prepared.models.maker = { ...maker, codeExecutor: 'grok_native',
    qualification: { fingerprint: `builtin1:${hex('7')}` } };
  item.prepared.frozenBackends.maker = { name: 'grok', kind: 'grok_cli', provider: 'xai',
    transport: 'vendor_managed', connection: null, auth: { kind: 'none' } };
  await writeFile(item.campaignPath, `${JSON.stringify(item.campaign, null, 2)}\n`);
  const { result, receipt } = await syntheticIdentityReceipt(item, {
    maker: { observed: { identity: 'xai:grok-4.6', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
    reviewer: { observed: { identity: 'openai:fixture-reviewer-model', usage: { input_tokens: 8, output_tokens: 2 } } },
  });
  assert.equal(result.standing, 'execution_observed');
  assert.equal(receipt.observedIdentity.executor, 'grok_native');
  assert.equal(receipt.observedIdentity.identityStable, true);
  assert.equal(receipt.observedIdentity.substitutionDetected, false);
});

test('OpenRouter route is bound before spend and normalized evidence reaches the receipt', async t => {
  const drift = await setup(t, 'qwen_native', { openRouter: true });
  const planned = await planCodeEval(drift, drift.dependencies);
  assert.deepEqual(planned.route, drift.campaign.treatment.maker.route);
  let executed = false;
  await assert.rejects(runCodeEval({ ...drift, consent: true, maxCells: 1 }, {
    ...drift.dependencies,
    prepareExecution: async () => {
      const prepared = drift.freshPrepared();
      prepared.frozenBackends.maker.route.upstreamProvider = 'together/fp8';
      return prepared;
    },
    runSeats: async () => { executed = true; },
  }), /maker upstream route drifted/);
  assert.equal(executed, false);
  await assert.rejects(stat(join(drift.root, 'evidence', 'inflight.json')), { code: 'ENOENT' });

  const item = await setup(t, 'qwen_native', { openRouter: true });
  await planCodeEval(item, item.dependencies);
  const fingerprint = hex('7');
  item.prepared.adapters.nativeMaker = async options => {
    options.onNativeProgress({ responses: 1 });
    return { ok: true };
  };
  item.prepared.adapters.reviewer = async () => ({ ok: true });
  const routeObservation = {
    requestEnforced: structuredClone(item.campaign.treatment.maker.route),
    metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }],
  };
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async (_fixture, path) => mkdir(path, { recursive: true, mode: 0o700 }),
    inspectCandidateIntegrity: async () => true,
    createVerifier: () => async () => ({ ran: true, pass: true }),
    readCheckpoint: async () => ({ nativeSession: { executor: item.campaign.treatment.executor,
      model: item.campaign.treatment.maker.model, version: HARNESS_POLICY_VERSION, harnessVersion: '0.22.3',
      routeObservation } }),
    runSeats: async ({ repoPath, adapters }) => {
      await adapters.nativeMaker({ onNativeProgress: () => null });
      await adapters.reviewer({});
      return {
        status: 'needs_decision', completion: 'candidate_ready_for_acceptance',
        candidate: { worktree: repoPath, fingerprint }, verificationBinding: fingerprint, reviewBinding: fingerprint,
        verification: { ran: true, pass: true }, review: { verdict: 'APPROVED' },
        seats: {
          maker: { observed: { identity: 'openrouter:fixture-model', turns: [{ usage: { input_tokens: 10, output_tokens: 4 } }] } },
          reviewer: { observed: { identity: 'openai:fixture-reviewer-model', usage: { input_tokens: 8, output_tokens: 2 } } },
        },
        usage: { calls: 2 },
      };
    },
  });
  assert.equal(result.standing, 'execution_observed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.deepEqual(receipt.assignment.requestedMaker.route, item.campaign.treatment.maker.route);
  assert.deepEqual(receipt.observedIdentity.makerRoute, routeObservation);
  assert.equal(receipt.observedIdentity.fallbackDetected, false);
  assert.equal(JSON.stringify(receipt.observedIdentity.makerRoute).includes('raw'), false);
});

test('the production shared engine checks the actual candidate before verifier and reviewer standing', async t => {
  const item = await setup(t); await planCodeEval(item, item.dependencies);
  const measured = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, total_tokens: 14 };
  let verifierRan = false, reviewerRan = false;
  item.prepared.adapters.nativeMaker = async options => {
    await writeFile(join(options.worktree, 'test', 'bounded-parser.test.mjs'), '/* weakened by candidate */\n');
    const nativeSession = { executor: item.campaign.treatment.executor,
      model: item.campaign.treatment.maker.model, version: HARNESS_POLICY_VERSION, harnessVersion: '0.22.3' };
    options.onNativeSession(nativeSession);
    options.onNativeProgress({ usage: measured, responses: 1, actions: 1 });
    return { ok: true, definitiveTurnEnd: true, usage: measured, nativeSession,
      text: JSON.stringify({ actions: [], done: true, summary: 'candidate ready' }),
      modelActual: 'dashscope:fixture-model', modelReported: 'fixture-model',
      modelActualEvidence: 'native_gateway_observed_response' };
  };
  item.prepared.adapters.reviewer = async () => { reviewerRan = true; return {
    ran: true, verdict: 'APPROVED', findings: [], usage: { input_tokens: 8, output_tokens: 2 },
    reviewerIdentity: 'openai:fixture-reviewer-model',
  }; };
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    createVerifier: () => Object.assign(async () => { verifierRan = true; return { ran: true, pass: true }; },
      { repeatable: true, command: 'synthetic verifier' }),
  });
  assert.equal(result.standing, 'failed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(verifierRan, false);
  assert.equal(reviewerRan, false);
  assert.equal(receipt.quality.candidateIntegrityPassed, false);
  assert.equal(receipt.quality.verificationPassed, null);
  assert.equal(receipt.quality.reviewVerdict, null);
  assert.equal(receipt.quality.mechanicalFloorPassed, false);
});

test('an uncertain native terminal preserves complete gateway usage instead of sealing false zero', async t => {
  const item = await setup(t); await planCodeEval(item, item.dependencies);
  const measured = { input_tokens: 21286, cached_input_tokens: 0, output_tokens: 647, total_tokens: 21933 };
  item.prepared.adapters.nativeMaker = async options => {
    options.onNativeProgress({ usage: measured, responses: 2, actions: 4 });
    return { ok: false, uncertain: true, usage: measured, usageIncomplete: false };
  };
  const result = await runCodeEval({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async (_fixture, path) => mkdir(path, { recursive: true, mode: 0o700 }),
    runSeats: async ({ adapters }) => {
      await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null });
      return { status: 'needs_decision', error: 'Native turn outcome is uncertain.',
        candidate: { fingerprint: null, snapshotStatus: 'unverified_terminal' }, seats: {},
        usage: { calls: 2, unmeasuredCalls: 0 } };
    },
    readCheckpoint: async () => ({
      nativeSession: { executor: item.campaign.treatment.executor, model: item.campaign.treatment.maker.model,
        version: HARNESS_POLICY_VERSION, harnessVersion: '0.22.3' },
      pendingCall: { role: 'maker', response: { uncertain: true, usage: measured, usageIncomplete: false } },
      usage: { calls: 2, unmeasuredCalls: 0 },
    }),
  });
  assert.equal(result.standing, 'failed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.economics.providerCalls, 2);
  assert.equal(receipt.economics.makerCalls, 2); assert.equal(receipt.economics.reviewerCalls, 0);
  assert.equal(receipt.economics.inputTokens, 21286); assert.equal(receipt.economics.outputTokens, 647);
  assert.equal(receipt.economics.usageIncomplete, false, 'coding uncertainty does not erase complete cost evidence');
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
