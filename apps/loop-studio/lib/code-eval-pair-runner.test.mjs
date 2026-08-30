import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadCodeEvalFixtureForCase } from './code-eval-fixture.mjs';
import {
  loadCodeEvalPairContext, planCodeEvalPair, recoverCodeEvalPair, runCodeEvalPair, statusCodeEvalPair,
} from './code-eval-pair-runner.mjs';
import { reserveNextCodeEvalPairCell } from './code-eval-pair-ledger.mjs';
import {
  claimCodeOwnedProcessLaunch, codeOwnedProcessCleanupStatus, createCodeOwnedProcessIntent,
  initializeCodeOwnedProcessRegistry,
} from './code-owned-process-registry.mjs';

const hex = character => character.repeat(64);
const CREATED_AT = '2026-08-30T00:00:00.000Z';

async function setup(t, desiredFirst = null, { openRouter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'camus-code-pair-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await loadCodeEvalFixtureForCase('simple-bounded-parser-fix');
  const base = {
    schemaVersion: 1, treatmentProtocol: 'code-harness-eval-v1b', campaignId: 'pair-0',
    campaignMode: 'isolation_pair', standing: 'exploratory_only',
    case: {
      caseId: fixture.manifest.caseId, caseVersion: 1, taskClass: fixture.manifest.taskClass,
      fixtureId: fixture.fixtureId, fixtureTreeDigest: fixture.baseTreeDigest,
      baseCommitDigest: fixture.baseTreeDigest, taskSha256: fixture.taskSha256,
      acceptanceContractSha256: fixture.acceptanceContractSha256,
      verifier: { kind: 'host_command', commandSha256: fixture.verifierDigest,
        timeoutMs: fixture.manifest.verifier.timeoutMs, expectedBase: 'red', expectedReference: 'green' },
    },
    pair: {
      pairId: 'fixture-pair',
      maker: { backend: 'fixture-maker', provider: openRouter ? 'openrouter' : 'dashscope', model: 'fixture-model', effort: null,
        trainingOrg: 'fixture-maker-org', transport: 'direct_https', connection: 'fixture-connection',
        route: openRouter ? { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false } : null },
      reviewer: { backend: 'fixture-reviewer', model: 'fixture-reviewer-model', effort: 'medium',
        trainingOrg: 'fixture-reviewer-org' },
      arms: [{ armId: 'raw', makerExecutor: 'file_actions' },
        { armId: 'native', makerExecutor: 'qwen_native' }],
    },
    controls: {
      repeatsPerArmCase: 1, maximumCells: 2, maximumProviderCallsPerCell: 3,
      maximumMakerCallsPerCell: 2, maximumReviewerCallsPerCell: 1,
      maximumSteps: 4, maximumActions: 8, maximumRepairs: 0, maximumRetries: 0,
      maximumTokensReserved: 131072, semanticPromptEnvelopeVersion: 'code-harness-eval-v1b',
      wallTimeoutMs: 120000, callTimeoutMs: 60000, idleTimeoutMs: 0,
      publish: false, commit: false, merge: false, push: false, automaticRouting: false,
    },
    claimPolicy: { pairedClaim: 'paired_observation', winnerClaim: 'forbidden',
      routingClaim: 'forbidden', admissionClaim: 'forbidden' },
  };
  const preparedFor = campaign => ({
    models: {
      maker: { ...campaign.pair.maker, qualification: { fingerprint: `qual1:${hex('1')}`, seatType: 'words_maker' },
        codeExecutor: 'qwen_native' },
      reviewer: { ...campaign.pair.reviewer, provider: 'openai', transport: 'vendor_managed', connection: null,
        qualification: { fingerprint: `builtin1:${hex('2')}`, seatType: 'words_reviewer' } },
      loop: {},
    },
    frozenBackends: {
      maker: { name: 'fixture-maker', kind: 'openai_compat', provider: openRouter ? 'openrouter' : 'dashscope', transport: 'direct_https',
        connection: 'fixture-connection', auth: { kind: 'none' }, baseUrl: 'https://synthetic.invalid/v1',
        ...(openRouter ? { route: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false } } : {}) },
      reviewer: { name: 'fixture-reviewer', kind: 'codex_cli', provider: 'openai',
        transport: 'vendor_managed', auth: { kind: 'none' } },
    },
    adapters: { maker: async () => ({ ok: true }), reviewer: async () => ({ ran: true }),
      nativeMaker: async () => ({ ok: true }) }, authorize: async () => {},
  });
  const dependenciesFor = campaign => ({
    createdAt: CREATED_AT, prepareExecution: async () => preparedFor(campaign),
    harnessReadiness: async () => ({ ready: true, status: 'ready', label: 'qwen', requiredVersion: '0.22.3' }),
    resolveHarness: async () => '/synthetic/private/harness', assertArtifact: async () => hex('3'),
    runtimeIdentity: async () => ({ packageVersion: '0.4.9', treeDigest: `sha256:${hex('4')}`,
      platform: 'darwin', architecture: 'arm64', nodeVersion: '22.0.0' }), env: {},
  });
  for (let index = 0; index < 16; index++) {
    const campaign = structuredClone(base); campaign.campaignId = `pair-${index}`;
    const campaignPath = join(root, `campaign-${index}.json`);
    const evidence = join(root, `evidence-${index}`);
    const paths = { campaignPath, statePath: join(evidence, 'state.json'), ledgerPath: join(evidence, 'receipts.jsonl') };
    await writeFile(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    const dependencies = dependenciesFor(campaign);
    const plan = await planCodeEvalPair(paths, dependencies);
    if (!desiredFirst || plan.nextCell.armId === desiredFirst) {
      return { root, campaign, fixture, preparedFor, dependencies, plan, ...paths };
    }
  }
  throw new Error(`could not construct ${desiredFirst}-first schedule`);
}

function engineDependencies(item, observations) {
  const prepared = item.preparedFor(item.campaign);
  prepared.adapters.maker = async () => ({ ok: true,
    ...(item.campaign.pair.maker.route ? { routeObservation: {
      requestEnforced: structuredClone(item.campaign.pair.maker.route),
      metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }],
    } } : {}) });
  prepared.adapters.nativeMaker = async options => {
    options.onNativeProgress({ responses: 1, actions: 3 });
    return { ok: true };
  };
  prepared.adapters.reviewer = async () => ({ ran: true });
  return {
    ...item.dependencies,
    prepareExecution: async () => ({ ...prepared, models: structuredClone(prepared.models),
      frozenBackends: structuredClone(prepared.frozenBackends) }),
    createVerifier: () => Object.assign(async () => ({ ran: true, pass: true, durationMs: 0 }),
      { repeatable: true, command: 'synthetic verifier' }),
    readCheckpoint: async () => {
      const armId = observations.at(-1)?.executor === 'qwen_native' ? 'native' : 'raw';
      return armId === 'native' ? { nativeSession: { executor: 'qwen_native', model: 'fixture-model',
        version: 'native-harness-isolation/v3', harnessVersion: '0.22.3', sessionId: 'session-1' } } : {};
    },
    runStatus: async () => ({ owned: false }),
    runSeats: async ({ repoPath, receiptsDir, seats, adapters, verify, task, limits, authorize }) => {
      observations.push({ executor: seats.maker.codeExecutor, reviewerModel: seats.reviewer.model, task, limits,
        runId: receiptsDir.split('/').at(-1) });
      await authorize();
      await writeFile(join(repoPath, 'src', 'bounded-parser.mjs'), item.fixture.referenceFiles[0].content);
      if (seats.maker.codeExecutor === 'file_actions') await adapters.maker({});
      else await adapters.nativeMaker({ maxModelCalls: 99, onNativeProgress: () => null });
      const verification = await verify({ worktree: repoPath });
      await adapters.reviewer({});
      const fingerprint = seats.maker.codeExecutor === 'file_actions' ? hex('5') : hex('6');
      return {
        status: 'needs_decision', completion: 'candidate_ready_for_acceptance',
        candidate: { worktree: repoPath, fingerprint, diff: 'synthetic diff' },
        verificationBinding: fingerprint, reviewBinding: fingerprint, verification,
        review: { verdict: 'APPROVED', findings: [] },
        protocol: { version: 'code-seats/v2', steps: 1,
          actions: seats.maker.codeExecutor === 'file_actions' ? 1 : 3 },
        seats: {
          maker: { observed: { identity: `${item.campaign.pair.maker.provider}:fixture-model`,
            turns: [{ usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 }, durationMs: 0 }] } },
          reviewer: { observed: { identity: 'openai:fixture-reviewer-model',
            usage: { input_tokens: 8, cached_input_tokens: 1, output_tokens: 2 }, durationMs: 0 } },
        },
        usage: { calls: 2, repairs: 0, retries: 0, verificationMs: 0 }, question: null,
      };
    },
  };
}

for (const first of ['raw', 'native']) test(`${first}-first fake shared engine executes both scheduled arms once`, async t => {
  const item = await setup(t, first), observations = [];
  const dependencies = engineDependencies(item, observations);
  assert.equal(item.plan.maximumRemainingProviderCalls, 6);
  const firstResult = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.equal(firstResult.maximumRemainingProviderCalls, 3);
  const secondResult = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.deepEqual([firstResult.armId, secondResult.armId], [first, first === 'raw' ? 'native' : 'raw']);
  assert.deepEqual(observations.map(row => row.executor), [first === 'raw' ? 'file_actions' : 'qwen_native',
    first === 'raw' ? 'qwen_native' : 'file_actions']);
  assert.equal(new Set(observations.map(row => row.reviewerModel)).size, 1);
  assert.ok(observations.every(row => row.task.includes('Acceptance contract (binding)')));
  assert.ok(observations.every(row => row.limits.maxRepairs === 0 && row.limits.maxRetries === 0));
  assert.ok(observations.every(row => !/(?:^|-)(?:raw|native)(?:-|$)/.test(row.runId)));
  const receipts = (await readFile(item.ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 2);
  const raw = receipts.find(row => row.assignment.armId === 'raw');
  const native = receipts.find(row => row.assignment.armId === 'native');
  assert.equal(raw.standing, 'execution_observed'); assert.equal(native.standing, 'execution_observed');
  assert.deepEqual([raw.economics.providerCalls, raw.economics.makerCalls, raw.economics.reviewerCalls], [2, 1, 1]);
  assert.deepEqual([raw.economics.rawProtocolSteps, raw.economics.rawFileActions,
    raw.economics.nativeProviderResponses, raw.economics.nativeToolActions], [1, 1, null, null]);
  assert.deepEqual([native.economics.rawProtocolSteps, native.economics.rawFileActions,
    native.economics.nativeProviderResponses, native.economics.nativeToolActions], [null, null, 1, 3]);
  assert.deepEqual([native.economics.makerInputTokens, native.economics.makerCachedInputTokens,
    native.economics.makerOutputTokens], [10, 2, 4]);
  assert.equal((await statusCodeEvalPair(item)).state, 'complete');
  await assert.rejects(runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies), /can never replay/);
});

test('consent, one-cell bound and execution drift refuse before reservation', async t => {
  const item = await setup(t); let ran = false;
  const dependencies = { ...item.dependencies, runSeats: async () => { ran = true; } };
  await assert.rejects(runCodeEvalPair({ ...item, consent: false, maxCells: 1 }, dependencies), /fresh provider consent/);
  await assert.rejects(runCodeEvalPair({ ...item, consent: true, maxCells: 2 }, dependencies), /one-cell bound/);
  await assert.rejects(runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, {
    ...dependencies, runtimeIdentity: async () => ({ packageVersion: '0.4.9', treeDigest: `sha256:${hex('9')}`,
      platform: 'darwin', architecture: 'arm64', nodeVersion: '22.0.0' }),
  }), /drifted before spend/);
  assert.equal(ran, false);
  await assert.rejects(stat(join(item.statePath, '..', 'inflight.json')), { code: 'ENOENT' });
});

test('actual candidate integrity prevents verifier and reviewer standing', async t => {
  const item = await setup(t, 'raw'); let verifierRan = false, reviewerCalled = false;
  const prepared = item.preparedFor(item.campaign);
  prepared.adapters.maker = async () => ({ ok: true });
  prepared.adapters.reviewer = async () => { reviewerCalled = true; return { ran: true }; };
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies, prepareExecution: async () => ({ ...prepared, models: structuredClone(prepared.models),
      frozenBackends: structuredClone(prepared.frozenBackends) }),
    runStatus: async () => ({ owned: false }),
    createVerifier: () => Object.assign(async () => { verifierRan = true; return { ran: true, pass: true }; },
      { repeatable: true, command: 'synthetic verifier' }),
    readCheckpoint: async () => ({}),
    runSeats: async ({ repoPath, adapters, verify }) => {
      await adapters.maker({});
      await writeFile(join(repoPath, 'test', 'bounded-parser.test.mjs'), '/* weakened */\n');
      const verification = await verify({ worktree: repoPath });
      return { status: 'infra_error', candidate: { worktree: repoPath, fingerprint: hex('7'), diff: 'bad diff' },
        verification, review: null, protocol: { version: 'code-seats/v2', steps: 1, actions: 1 },
        seats: { maker: { observed: { identity: 'dashscope:fixture-model', turns: [{ usage: {
          input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, durationMs: 0 }] } } },
        usage: { calls: 1, repairs: 0, retries: 0, verificationMs: 0 }, question: null };
    },
  });
  assert.equal(result.standing, 'failed'); assert.equal(verifierRan, false); assert.equal(reviewerCalled, false);
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.quality.candidateIntegrityPassed, false);
  assert.equal(receipt.quality.verificationRan, false);
  assert.equal(receipt.quality.reviewRan, false);
  assert.equal(receipt.quality.mechanicalFloorPassed, false);
});

test('raw OpenRouter evidence survives the successful adapter result into its arm receipt', async t => {
  const item = await setup(t, 'raw', { openRouter: true });
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, engineDependencies(item, []));
  assert.equal(result.standing, 'execution_observed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.deepEqual(receipt.observedIdentity.makerRoute, {
    requestEnforced: item.campaign.pair.maker.route,
    metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }],
  });
  assert.equal(receipt.observedIdentity.fallbackDetected, false);
  assert.equal(receipt.economics.makerCalls, receipt.observedIdentity.makerRoute.metadataObserved.length);
});

for (const routeCase of [
  { name: 'missing', response: { ok: true }, mismatch: null, fallback: null, substitution: null },
  { name: 'request mismatch', response: { ok: true, routeObservation: {
    requestEnforced: { upstreamProvider: 'other/fp4', allowFallbacks: false },
    metadataObserved: [{ provider: 'Other', attempt: 1 }],
  } }, mismatch: true, fallback: null, substitution: true },
  { name: 'provider mismatch', response: { ok: true, routeObservation: {
    requestEnforced: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false },
    metadataObserved: [{ provider: 'OtherProvider', attempt: 1 }],
  } }, mismatch: true, fallback: false, substitution: true },
  { name: 'fallback', response: { ok: true, routeObservation: {
    requestEnforced: { upstreamProvider: 'deepinfra/fp4', allowFallbacks: false },
    metadataObserved: [{ provider: 'DeepInfra', attempt: 2 }],
  } }, mismatch: false, fallback: true, substitution: true },
]) test(`raw OpenRouter ${routeCase.name} evidence remains explicit and cannot earn stable identity`, async t => {
  const item = await setup(t, 'raw', { openRouter: true });
  const dependencies = engineDependencies(item, []);
  const prepare = dependencies.prepareExecution;
  dependencies.prepareExecution = async () => {
    const prepared = await prepare();
    prepared.adapters.maker = async () => structuredClone(routeCase.response);
    return prepared;
  };
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.equal(result.standing, 'failed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.observedIdentity.substitutionDetected, routeCase.substitution);
  assert.equal(receipt.observedIdentity.fallbackDetected, routeCase.fallback);
  assert.equal(receipt.observedIdentity.identityStable, false);
  if (routeCase.mismatch === true) assert.equal(receipt.observedIdentity.substitutionDetected, true);
});

test('native OpenRouter arm retains exact route and harness evidence from the native checkpoint', async t => {
  const item = await setup(t, 'native', { openRouter: true });
  const dependencies = engineDependencies(item, []);
  dependencies.readCheckpoint = async () => ({ nativeSession: {
    executor: 'qwen_native', model: 'fixture-model', version: 'native-harness-isolation/v3',
    harnessVersion: '0.22.3', sessionId: 'native-route-session', routeObservation: {
      requestEnforced: structuredClone(item.campaign.pair.maker.route),
      metadataObserved: [{ provider: 'DeepInfra', attempt: 1 }],
    },
  } });
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.equal(result.standing, 'execution_observed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.observedIdentity.executor, 'qwen_native');
  assert.equal(receipt.observedIdentity.nativeHarness.sessionId, 'native-route-session');
  assert.equal(receipt.observedIdentity.substitutionDetected, false);
  assert.equal(receipt.observedIdentity.fallbackDetected, false);
});

test('explicit pair maker and reviewer preflight refusals report zero provider calls and no inferred spend', async t => {
  const item = await setup(t, 'raw');
  const prepared = item.preparedFor(item.campaign);
  prepared.adapters.maker = async () => ({ ok: false, noModelCalled: true, error: 'maker preflight refused' });
  prepared.adapters.reviewer = async () => ({ ran: false, noModelCalled: true, error: 'reviewer preflight refused' });
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    prepareExecution: async () => ({ ...prepared, models: structuredClone(prepared.models),
      frozenBackends: structuredClone(prepared.frozenBackends) }),
    createVerifier: () => Object.assign(async () => ({ ran: false, pass: null }),
      { repeatable: true, command: 'synthetic verifier' }),
    readCheckpoint: async () => ({}), runStatus: async () => ({ owned: false }),
    runSeats: async ({ repoPath, adapters, authorize }) => {
      await authorize(); await adapters.maker({}); await adapters.reviewer({});
      return { status: 'infra_error', error: 'preflight refused',
        candidate: { worktree: repoPath, fingerprint: hex('8'), diff: '' },
        verification: { ran: false, pass: null }, review: null,
        protocol: { version: 'code-seats/v2', steps: 0, actions: 0 }, seats: {},
        usage: { calls: 0, repairs: 0, retries: 0, verificationMs: 0 }, question: null };
    },
  });
  assert.equal(result.providerCallsMade, 0);
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.deepEqual([receipt.economics.providerCalls, receipt.economics.makerCalls, receipt.economics.reviewerCalls], [0, 0, 0]);
  assert.equal(receipt.outcome.possibleBilling, false);
  assert.equal(receipt.observedIdentity.qualificationBindingsMatch, false);
  assert.equal(receipt.observedIdentity.connectionBindingsMatch, null);
  assert.equal(receipt.observedIdentity.substitutionDetected, null);
});

test('missing authorization remains unknown qualification evidence, and budget questions plus only material findings are mapped exactly', async t => {
  const item = await setup(t, 'raw');
  const dependencies = engineDependencies(item, []);
  const runSeats = dependencies.runSeats;
  dependencies.runSeats = async args => {
    const result = await runSeats({ ...args, authorize: async () => {} });
    result.question = { kind: 'budget' };
    result.review.findings = [{ severity: 'low' }, { severity: 'medium' }, { severity: 'info' }];
    return result;
  };
  await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.observedIdentity.qualificationBindingsMatch, null);
  assert.equal(receipt.observedIdentity.identityStable, false);
  assert.equal(receipt.outcome.status, 'budget_exhausted');
  assert.equal(receipt.quality.materialFindingCount, 1);
});

test('missing cleanup observation remains null and cannot receive execution standing', async t => {
  const item = await setup(t, 'raw');
  const dependencies = engineDependencies(item, []);
  delete dependencies.runStatus;
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  assert.equal(result.standing, 'failed');
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.custody.processCleanupComplete, null);
  assert.equal(receipt.quality.containmentPassed, null);
  assert.equal(receipt.quality.mechanicalFloorPassed, null);
});

test('both cells traverse the real shared Build engine with only fake seat adapters', async t => {
  const item = await setup(t, 'raw');
  let rawTurns = 0, nativeTurns = 0, reviews = 0, verifications = 0;
  const baseFile = item.fixture.baseFiles.find(file => file.path === item.fixture.referenceFiles[0].path);
  const expectedSha = createHash('sha256').update(baseFile.content).digest('hex');
  const prepared = () => {
    const value = item.preparedFor(item.campaign);
    value.adapters.maker = async () => {
      rawTurns++;
      const body = rawTurns === 1
        ? { actions: [{ type: 'write', path: item.fixture.referenceFiles[0].path,
          content: item.fixture.referenceFiles[0].content, expected_sha256: expectedSha }], done: false,
          summary: 'apply bounded fixture solution' }
        : { actions: [], done: true, summary: 'candidate ready' };
      return { ok: true, text: JSON.stringify(body), modelActual: 'dashscope:fixture-model',
        modelReported: 'fixture-model', modelActualEvidence: 'observed_api_response', durationMs: 0,
        usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } };
    };
    value.adapters.nativeMaker = async options => {
      nativeTurns++;
      await writeFile(join(options.worktree, item.fixture.referenceFiles[0].path), item.fixture.referenceFiles[0].content);
      const nativeSession = { executor: 'qwen_native', model: 'fixture-model',
        version: 'native-harness-isolation/v3', harnessVersion: '0.22.3', sessionId: 'production-shaped-1' };
      options.onNativeSession(nativeSession); options.onNativeProgress({ responses: 1, actions: 1 });
      return { ok: true, definitiveTurnEnd: true, text: JSON.stringify({ actions: [], done: true, summary: 'candidate ready' }),
        modelActual: 'dashscope:fixture-model', modelReported: 'fixture-model',
        modelActualEvidence: 'native_gateway_observed_response', nativeSession, durationMs: 0,
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } };
    };
    value.adapters.reviewer = async () => {
      reviews++;
      return { ran: true, verdict: 'APPROVED', findings: [], questions: [],
        claimAssessments: [], coverageAssessments: [], thresholdAssessments: [],
        reviewerIdentity: 'openai:fixture-reviewer-model', durationMs: 0,
        usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 1 } };
    };
    return value;
  };
  const dependencies = {
    ...item.dependencies, prepareExecution: async () => prepared(),
    createVerifier: () => Object.assign(async ({ worktree }) => {
      verifications++;
      assert.equal(await readFile(join(worktree, item.fixture.referenceFiles[0].path), 'utf8'),
        item.fixture.referenceFiles[0].content);
      return { ran: true, pass: true, durationMs: 0 };
    }, { repeatable: true, command: 'synthetic verifier' }),
  };
  const raw = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  const native = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, dependencies);
  const receipts = (await readFile(item.ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual([raw.armId, native.armId], ['raw', 'native']);
  assert.deepEqual([raw.standing, native.standing], ['execution_observed', 'execution_observed'], JSON.stringify(receipts));
  assert.equal(rawTurns, 2); assert.equal(nativeTurns, 1);
  assert.equal(verifications, 2); assert.equal(reviews, 2);
  assert.deepEqual(receipts.map(row => row.economics.rawProtocolSteps), [2, null]);
  assert.deepEqual(receipts.map(row => row.economics.nativeProviderResponses), [null, 1]);
});

test('a malformed paid raw response traverses the real shared Build engine and seals exact failed economics', async t => {
  const item = await setup(t, 'raw');
  let reviewerCalled = false, verifierCalled = false;
  const prepared = () => {
    const value = item.preparedFor(item.campaign);
    value.adapters.maker = async () => ({ ok: true, text: 'not bounded protocol JSON',
      modelActual: 'dashscope:fixture-model', modelReported: 'fixture-model',
      modelActualEvidence: 'observed_api_response', durationMs: 7,
      usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5 } });
    value.adapters.reviewer = async () => { reviewerCalled = true; return { ran: true }; };
    return value;
  };
  const result = await runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies, prepareExecution: async () => prepared(),
    createVerifier: () => Object.assign(async () => {
      verifierCalled = true; return { ran: true, pass: true, durationMs: 0 };
    }, { repeatable: true, command: 'synthetic verifier' }),
  });
  assert.equal(result.standing, 'failed');
  assert.notEqual(result.standing, 'unknown');
  assert.equal(result.providerCallsMade, 1);
  assert.equal(reviewerCalled, false); assert.equal(verifierCalled, false);
  const receipt = JSON.parse((await readFile(item.ledgerPath, 'utf8')).trim());
  assert.equal(receipt.standing, 'failed');
  assert.deepEqual([receipt.economics.providerCalls, receipt.economics.makerCalls,
    receipt.economics.reviewerCalls, receipt.economics.rawProtocolSteps,
    receipt.economics.rawFileActions], [1, 1, 0, 0, 0]);
  assert.deepEqual([receipt.economics.makerInputTokens, receipt.economics.makerCachedInputTokens,
    receipt.economics.makerOutputTokens], [11, 3, 5]);
  assert.equal(receipt.observedIdentity.makerModel, 'fixture-model');
  assert.equal(receipt.outcome.possibleBilling, true);
  assert.equal(receipt.outcome.modelCallsMade, 1);
});

test('context loader returns validated frozen pair state without provider authority', async t => {
  const item = await setup(t);
  const context = await loadCodeEvalPairContext(item);
  assert.equal(context.campaign.campaignId, item.campaign.campaignId);
  assert.equal(context.execution.executionProtocol, 'code-harness-execution/v1b');
  assert.equal(context.cells.length, 2);
  assert.equal(context.evidencePaths.ledger, item.ledgerPath);
});

test('an immediate post-reservation crash has an exact empty registry and recovery seals only that cell', async t => {
  const item = await setup(t, 'raw');
  let enteredMaterialization;
  const materializationStarted = new Promise(resolvePromise => { enteredMaterialization = resolvePromise; });
  let releaseMaterialization;
  const pausedMaterialization = new Promise(resolvePromise => { releaseMaterialization = resolvePromise; });
  let providerCalled = false;
  const abandonedRun = runCodeEvalPair({ ...item, consent: true, maxCells: 1 }, {
    ...item.dependencies,
    materializeSource: async () => {
      enteredMaterialization();
      await pausedMaterialization;
      throw new Error('simulated evaluator crash immediately after reservation');
    },
    runSeats: async () => { providerCalled = true; throw new Error('provider execution must not start'); },
  }).catch(error => error);

  await materializationStarted;
  const ctx = await loadCodeEvalPairContext(item);
  const marker = JSON.parse(await readFile(ctx.evidencePaths.marker, 'utf8'));
  const runDir = join(ctx.evidencePaths.dir, 'runs', marker.buildRunId);
  const cleanup = codeOwnedProcessCleanupStatus(runDir);
  assert.equal(cleanup.complete, true);
  assert.deepEqual(cleanup.intents, []);

  const recovered = await recoverCodeEvalPair({ ...item, action: 'seal-infra' }, {
    processesDead: async observedMarker => {
      assert.equal(observedMarker.buildRunId, marker.buildRunId);
      assert.equal(codeOwnedProcessCleanupStatus(runDir).complete, true);
      return true;
    },
  });
  assert.equal(recovered.action, 'sealed_unknown');
  assert.equal(recovered.providerCallsMade, 0);
  assert.equal(recovered.providerCallsMadeThisInvocation, 0);
  assert.equal(providerCalled, false);

  const status = await statusCodeEvalPair(item);
  assert.equal(status.completedCells, 1);
  assert.equal(status.pendingCells, 1);
  assert.equal(status.inflightCellId, null);
  assert.equal(status.nextCell.armId, 'native');
  const receipts = (await readFile(item.ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].cellId, marker.cellId);
  assert.equal(receipts[0].standing, 'unknown');

  releaseMaterialization();
  const abandonedResult = await abandonedRun;
  assert.match(abandonedResult.message, /active reservation nonce/);
  assert.equal(providerCalled, false);
});

test('production recovery refuses a dead evaluator marker while an exact live prelaunch supervisor claim remains', async t => {
  const item = await setup(t, 'raw');
  const ctx = await loadCodeEvalPairContext(item);
  const buildRunId = 'recovery-live-prelaunch';
  const runDir = join(ctx.evidencePaths.dir, 'runs', buildRunId);
  await mkdir(runDir, { recursive: true });
  initializeCodeOwnedProcessRegistry(runDir);
  const intent = createCodeOwnedProcessIntent(runDir, 'claude_reviewer');
  const birth = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  claimCodeOwnedProcessLaunch(intent.path, 'supervisor', { pid: process.pid, birth });
  reserveNextCodeEvalPairCell(ctx.evidencePaths, { ...ctx, buildRunId,
    supervisorIdentity: 'pid-999999999', maximumProviderCallsReserved: 3 });

  await assert.rejects(recoverCodeEvalPair({ ...item, action: 'seal-infra' }), /liveness is uncertain/);
  const status = await statusCodeEvalPair(item);
  assert.equal(status.state, 'paused_inflight_unknown');
  assert.equal(status.canAttempt, false);
});

test('production recovery safely reconciles the crash-before-supervisor-ready window and only then seals unknown', async t => {
  const item = await setup(t, 'raw');
  const ctx = await loadCodeEvalPairContext(item);
  const buildRunId = 'recovery-unclaimed-prelaunch';
  const runDir = join(ctx.evidencePaths.dir, 'runs', buildRunId);
  await mkdir(runDir, { recursive: true });
  initializeCodeOwnedProcessRegistry(runDir);
  createCodeOwnedProcessIntent(runDir, 'verifier');
  reserveNextCodeEvalPairCell(ctx.evidencePaths, { ...ctx, buildRunId,
    supervisorIdentity: 'pid-999999999', maximumProviderCallsReserved: 3 });

  const recovered = await recoverCodeEvalPair({ ...item, action: 'seal-infra' });
  assert.equal(recovered.action, 'sealed_unknown');
  assert.equal(recovered.standing, 'unknown');
  const status = await statusCodeEvalPair(item);
  assert.equal(status.state, 'pending');
  assert.equal(status.canAttempt, true);
});
