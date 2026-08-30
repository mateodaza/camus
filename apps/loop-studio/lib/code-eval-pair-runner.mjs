// Provider-free planning/status and explicitly authorized one-cell execution
// for the bounded v1b raw/native isolation pair. Both arms enter the same
// shared Build engine; this wrapper freezes identity, limits and custody only.
import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prepareCodeExecution } from './code-seat-launch.mjs';
import { createCodeVerifier } from './code-seat-verify.mjs';
import { CODE_SEATS_PROTOCOL_VERSION, runCodeSeats } from './code-seats.mjs';
import { codeCredentialRevision, codeRunStatus, readCodeCheckpoint } from './code-run-state.mjs';
import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';
import {
  HARNESS_POLICY_VERSION, assertNativeHarnessArtifact, nativeHarnessReadiness, resolveNativeHarness,
} from './native-harness-policy.mjs';
import { codeEvalCandidateIntegrity, codeEvalRuntimeIdentity } from './code-eval-runner.mjs';
import { codeOwnedProcessCleanupStatus, initializeCodeOwnedProcessRegistry,
  reconcileCodeOwnedProcessPrelaunch } from './code-owned-process-registry.mjs';
import {
  CODE_EVAL_PAIR_EXECUTION_PROTOCOL, CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION, CODE_EVAL_PAIR_SCHEDULER_VERSION,
  canonicalCodeEvalPairJson, codeEvalPairArmForCell, codeEvalPairCampaignIdentity,
  codeEvalPairCellIdentity, codeEvalPairExecutionIdentity, createCodeEvalPairCells,
  createCodeEvalPairReceipt, createUnknownCodeEvalPairReceipt, validateCodeEvalPairCampaign,
  validateCodeEvalPairExecution,
} from './code-eval-pair-contract.mjs';
import { scheduleCodeEvalPairCells } from './code-eval-pair-scheduler.mjs';
import {
  appendCodeEvalPairReceipt, codeEvalPairEvidencePaths, codeEvalPairStatus,
  ensureCodeEvalPairEvidenceDir, initializeCodeEvalPairEvidence, loadCodeEvalPairReceipts,
  recoverAbandonedCodeEvalPairEvidenceLock, recoverCodeEvalPairCell,
  reserveNextCodeEvalPairCell,
} from './code-eval-pair-ledger.mjs';
import {
  codeEvalFixturePath, codeEvalFixtureReadiness, loadCodeEvalFixture, materializeCodeEvalFixture,
} from './code-eval-fixture.mjs';

const execFile = promisify(execFileCallback);
const MAX_CAMPAIGN_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digestJson = value => sha256(canonicalCodeEvalPairJson(clone(value)));
const isSha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

async function loadJsonFile(path, maximum, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error(`${label} must be a bounded regular non-symlink file.`);
  }
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`${label} must contain valid JSON; private contents were omitted.`); }
}

function resolveEvidencePaths({ statePath, ledgerPath }) {
  const state = resolve(statePath), ledger = resolve(ledgerPath);
  if (basename(state) !== 'state.json' || basename(ledger) !== 'receipts.jsonl' || dirname(state) !== dirname(ledger)) {
    throw new Error('State and ledger must be sibling state.json and receipts.jsonl files in one dedicated private directory.');
  }
  const evidence = codeEvalPairEvidencePaths(dirname(state));
  if (evidence.ledger !== ledger) throw new Error('Ledger path does not match the dedicated evidence directory.');
  ensureCodeEvalPairEvidenceDir(evidence);
  return { evidence, state };
}

async function loadCampaign(path) {
  return validateCodeEvalPairCampaign(await loadJsonFile(resolve(path), MAX_CAMPAIGN_BYTES, 'Pair campaign'));
}

async function loadState(path, campaign) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES || (info.mode & 0o777) !== STUDIO_FILE_MODE) {
    throw new Error('Pair execution state must be a bounded private 0600 regular file.');
  }
  return validateCodeEvalPairExecution(await loadJsonFile(path, MAX_STATE_BYTES, 'Pair execution state'), campaign);
}

function pairingFor(campaign) {
  const nativeExecutor = campaign.pair.arms[1].makerExecutor;
  return {
    maker: { backend: campaign.pair.maker.backend, model: campaign.pair.maker.model,
      ...(campaign.pair.maker.effort ? { effort: campaign.pair.maker.effort } : {}), codeExecutor: nativeExecutor },
    reviewer: { backend: campaign.pair.reviewer.backend, model: campaign.pair.reviewer.model,
      ...(campaign.pair.reviewer.effort ? { effort: campaign.pair.reviewer.effort } : {}) },
  };
}

function assertSeat(actual, requested, role) {
  for (const key of role === 'maker'
    ? ['backend', 'provider', 'model', 'effort', 'trainingOrg', 'transport', 'connection']
    : ['backend', 'model', 'effort', 'trainingOrg']) {
    if ((actual?.[key] ?? null) !== (requested?.[key] ?? null)) {
      throw new Error(`${role} seat drifted from the frozen pair campaign; no model was called.`);
    }
  }
  const expectedSeatType = role === 'maker' ? 'words_maker' : 'words_reviewer';
  if (!/^(?:qual1|builtin1):[a-f0-9]{64}$/.test(actual?.qualification?.fingerprint ?? '')
      || actual?.qualification?.seatType !== expectedSeatType) {
    throw new Error(`${role} qualification is missing or invalid; no model was called.`);
  }
}

function credentialRevision(backend, env) {
  const name = backend?.auth?.envVar ?? backend?.apiKeyEnv;
  if (!name) return 'none';
  if (typeof env[name] !== 'string' || !env[name]) throw new Error('A frozen seat credential is unavailable; no model was called.');
  return codeCredentialRevision(env[name]);
}

function assertFixture(campaign, fixture, readiness) {
  const expected = {
    caseId: fixture.manifest.caseId, caseVersion: fixture.manifest.caseVersion,
    taskClass: fixture.manifest.taskClass, fixtureId: fixture.fixtureId,
    fixtureTreeDigest: fixture.baseTreeDigest, baseCommitDigest: fixture.baseTreeDigest,
    taskSha256: fixture.taskSha256, acceptanceContractSha256: fixture.acceptanceContractSha256,
    verifierDigest: fixture.verifierDigest, verifierTimeoutMs: fixture.manifest.verifier.timeoutMs,
  };
  const actual = {
    caseId: campaign.case.caseId, caseVersion: campaign.case.caseVersion,
    taskClass: campaign.case.taskClass, fixtureId: campaign.case.fixtureId,
    fixtureTreeDigest: campaign.case.fixtureTreeDigest, baseCommitDigest: campaign.case.baseCommitDigest,
    taskSha256: campaign.case.taskSha256, acceptanceContractSha256: campaign.case.acceptanceContractSha256,
    verifierDigest: campaign.case.verifier.commandSha256, verifierTimeoutMs: campaign.case.verifier.timeoutMs,
  };
  if (canonicalCodeEvalPairJson(actual) !== canonicalCodeEvalPairJson(expected) || readiness.ready !== true
      || readiness.fixtureId !== fixture.fixtureId || readiness.providerCallsMade !== 0) {
    throw new Error('Pair campaign fixture or verifier differs from the tracked base-red/reference-green fixture; no model was called.');
  }
}

async function buildExecutionSnapshot(campaign, { createdAt = new Date().toISOString() } = {}, dependencies = {}) {
  const fixturePath = codeEvalFixturePath(campaign.case.caseId, dependencies.fixtureRoot);
  const fixture = await (dependencies.loadFixture ?? loadCodeEvalFixture)(fixturePath);
  const fixtureReadiness = await (dependencies.fixtureReadiness ?? codeEvalFixtureReadiness)(fixturePath);
  assertFixture(campaign, fixture, fixtureReadiness);
  const prepared = await (dependencies.prepareExecution ?? prepareCodeExecution)(pairingFor(campaign));
  assertSeat(prepared.models?.maker, campaign.pair.maker, 'maker');
  assertSeat(prepared.models?.reviewer, campaign.pair.reviewer, 'reviewer');
  const makerBackend = clone(prepared.frozenBackends.maker);
  const reviewerBackend = clone(prepared.frozenBackends.reviewer);
  if (canonicalCodeEvalPairJson(makerBackend?.route ?? null) !== canonicalCodeEvalPairJson(campaign.pair.maker.route)) {
    throw new Error('maker upstream route drifted from the frozen pair campaign; no model was called.');
  }
  const nativeExecutor = campaign.pair.arms[1].makerExecutor;
  if (prepared.models.maker.codeExecutor !== nativeExecutor) {
    throw new Error('Native harness binding drifted from the frozen pair campaign; no model was called.');
  }
  const readiness = await (dependencies.harnessReadiness ?? nativeHarnessReadiness)(nativeExecutor);
  if (readiness?.status !== 'ready' || readiness.ready !== true) {
    throw new Error(`${readiness?.label ?? 'Native harness'} is ${readiness?.status ?? 'unavailable'}; no model was called.`);
  }
  const harness = await (dependencies.resolveHarness ?? resolveNativeHarness)(nativeExecutor);
  const artifact = await (dependencies.assertArtifact ?? assertNativeHarnessArtifact)(nativeExecutor, harness);
  const runtime = await (dependencies.runtimeIdentity ?? codeEvalRuntimeIdentity)();
  const artifactDigest = `sha256:${artifact}`;
  const execution = {
    schemaVersion: 1, executionProtocol: CODE_EVAL_PAIR_EXECUTION_PROTOCOL,
    campaignDigest: codeEvalPairCampaignIdentity(campaign), createdAt, runtime,
    maker: {
      backendDefinitionDigest: digestJson(makerBackend),
      qualificationFingerprint: prepared.models.maker.qualification.fingerprint,
      qualificationSeatType: prepared.models.maker.qualification.seatType,
      credentialRevision: credentialRevision(makerBackend, dependencies.env ?? process.env),
      connectionDefinitionDigest: digestJson({ backend: makerBackend, connection: prepared.models.maker.connection ?? null }),
      expectedModel: campaign.pair.maker.model,
      expectedRoute: campaign.pair.maker.route === null ? null : clone(campaign.pair.maker.route),
    },
    reviewer: {
      backendDefinitionDigest: digestJson(reviewerBackend),
      qualificationFingerprint: prepared.models.reviewer.qualification.fingerprint,
      qualificationSeatType: prepared.models.reviewer.qualification.seatType,
      credentialRevision: credentialRevision(reviewerBackend, dependencies.env ?? process.env),
      connectionDefinitionDigest: digestJson({ backend: reviewerBackend, connection: prepared.models.reviewer.connection ?? null }),
      expectedModel: campaign.pair.reviewer.model,
    },
    schedulerVersion: CODE_EVAL_PAIR_SCHEDULER_VERSION,
    armExecutions: [
      { armId: 'raw', executor: 'file_actions', protocolVersion: CODE_EVAL_PAIR_RAW_PROTOCOL_VERSION,
        policyDigest: digestJson({ protocol: CODE_SEATS_PROTOCOL_VERSION,
          semanticPromptEnvelopeVersion: campaign.controls.semanticPromptEnvelopeVersion,
          maximumSteps: campaign.controls.maximumSteps, maximumActions: campaign.controls.maximumActions,
          runtime: runtime.treeDigest }) },
      { armId: 'native', executor: nativeExecutor, harness: {
        name: nativeExecutor === 'qwen_native' ? 'qwen_code' : 'grok_build',
        version: readiness.requiredVersion, artifactDigest, parserVersion: 'native-harness-v1',
        outerSandboxPolicyDigest: digestJson({ protocol: HARNESS_POLICY_VERSION, executor: nativeExecutor,
          artifactDigest, runtime: runtime.treeDigest }),
        credentialGatewayPolicyDigest: digestJson({ protocol: 'native-gateway/v1a',
          provider: campaign.pair.maker.provider, model: campaign.pair.maker.model,
          route: campaign.pair.maker.route, maximumCalls: campaign.controls.maximumMakerCallsPerCell,
          maximumTokens: campaign.controls.maximumTokensReserved, runtime: runtime.treeDigest }),
      } },
    ],
    verifierDigest: fixture.verifierDigest,
    fixtureReadinessDigest: digestJson(fixtureReadiness),
  };
  validateCodeEvalPairExecution(execution, campaign);
  return { execution, prepared, fixture, fixtureReadiness };
}

function publicPlan(campaign, execution, state = null) {
  const cells = scheduleCodeEvalPairCells(campaign, execution);
  return {
    ok: true, protocol: campaign.treatmentProtocol, campaignId: campaign.campaignId,
    campaignDigest: codeEvalPairCampaignIdentity(campaign),
    executionDigest: codeEvalPairExecutionIdentity(execution, campaign),
    cells: cells.map(cell => ({ cellId: codeEvalPairCellIdentity(cell, campaign, execution), armId: cell.armId,
      executor: codeEvalPairArmForCell(campaign, execution, cell).makerExecutor })),
    totalCells: 2, providerCallsMade: 0,
    maximumRemainingProviderCalls: state?.canAttempt === false ? 0
      : campaign.controls.maximumProviderCallsPerCell
        * (Number.isSafeInteger(state?.pendingCells) ? state.pendingCells : campaign.controls.maximumCells),
    maximumTokensReserved: campaign.controls.maximumTokensReserved,
    fixture: { caseId: campaign.case.caseId, taskClass: campaign.case.taskClass, base: 'red', reference: 'green' },
    state: state?.state ?? null,
    nextCell: state?.nextCell ? { cellId: codeEvalPairCellIdentity(state.nextCell, campaign, execution), armId: state.nextCell.armId } : null,
    claim: 'paired_observation_only', dollarCost: null,
    note: 'Paired descriptive evidence only. No cross-model ranking, winner, routing, admission, or production-readiness claim.',
  };
}

export async function planCodeEvalPair({ campaignPath, statePath, ledgerPath }, dependencies = {}) {
  const campaign = await loadCampaign(campaignPath);
  const paths = resolveEvidencePaths({ statePath, ledgerPath });
  let existing = null;
  try { existing = await loadState(paths.state, campaign); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const snapshot = await buildExecutionSnapshot(campaign, { ...(existing ? { createdAt: existing.createdAt }
    : dependencies.createdAt ? { createdAt: dependencies.createdAt } : {}) }, dependencies);
  if (existing && canonicalCodeEvalPairJson(existing) !== canonicalCodeEvalPairJson(snapshot.execution)) {
    throw new Error('Existing pair execution state differs from current seats, credentials, runtime, harness, fixture, or verifier; no model was called.');
  }
  if (!existing) studioAtomicWrite(paths.state, `${JSON.stringify(snapshot.execution, null, 2)}\n`, STUDIO_FILE_MODE);
  const execution = existing ?? snapshot.execution;
  initializeCodeEvalPairEvidence(paths.evidence, { campaign, execution });
  const state = codeEvalPairStatus(paths.evidence, { campaign, execution });
  return publicPlan(campaign, execution, state);
}

export async function loadCodeEvalPairContext({ campaignPath, statePath, ledgerPath }, _dependencies = {}) {
  const campaign = await loadCampaign(campaignPath);
  const paths = resolveEvidencePaths({ statePath, ledgerPath });
  const execution = await loadState(paths.state, campaign);
  const cells = createCodeEvalPairCells(campaign, execution);
  return { campaign, execution, evidencePaths: paths.evidence, cells, paths };
}

export async function statusCodeEvalPair(pathsInput) {
  const ctx = await loadCodeEvalPairContext(pathsInput);
  const state = codeEvalPairStatus(ctx.evidencePaths, ctx);
  const receipts = loadCodeEvalPairReceipts(ctx.evidencePaths, ctx);
  const observed = receipts.map(receipt => receipt.economics.providerCalls);
  return { ...publicPlan(ctx.campaign, ctx.execution, state), ...state,
    providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: observed.every(Number.isSafeInteger) ? observed.reduce((sum, value) => sum + value, 0) : null };
}

async function git(args, options = {}) {
  await execFile('git', args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, ...options });
}

async function materializeSource(fixture, path) {
  await materializeCodeEvalFixture(fixture, path);
  const privateHome = join(dirname(path), `${basename(path)}-git-home`), emptyTemplate = join(privateHome, 'template');
  await mkdir(emptyTemplate, { recursive: true, mode: STUDIO_DIR_MODE });
  await chmod(privateHome, STUDIO_DIR_MODE); await chmod(emptyTemplate, STUDIO_DIR_MODE);
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: privateHome,
    XDG_CONFIG_HOME: join(privateHome, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z', LANG: 'C', LC_ALL: 'C' };
  const guarded = ['-c', 'core.hooksPath=/dev/null'];
  await git([...guarded, 'init', '-q', `--template=${emptyTemplate}`, path], { env });
  await git([...guarded, '-C', path, 'add', '--', '.'], { env });
  await git([...guarded, '-C', path, '-c', 'user.name=Camus Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture base'], { env });
}

async function ensurePrivateChild(root, name) {
  const path = join(root, name); let created = false;
  try { await mkdir(path, { recursive: false, mode: STUDIO_DIR_MODE }); created = true; }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  if (created) await chmod(path, STUDIO_DIR_MODE);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== STUDIO_DIR_MODE) {
    throw new Error(`Code-eval pair ${name} must be a real private 0700 directory; no model was called.`);
  }
  return path;
}

function limitsFrom(campaign) {
  const c = campaign.controls;
  return { maxCalls: c.maximumProviderCallsPerCell, maxSteps: c.maximumSteps, maxActions: c.maximumActions,
    maxRepairs: c.maximumRepairs, maxRetries: c.maximumRetries, maxTokens: c.maximumTokensReserved,
    timeoutMs: c.wallTimeoutMs, callTimeoutMs: c.callTimeoutMs, idleTimeoutMs: c.idleTimeoutMs };
}

function boundedAdapters(adapters, controls) {
  const calls = { maker: 0, reviewer: 0, makerPreflight: null, reviewerPreflight: null, rawRouteObservations: [] };
  const maker = async options => {
    if (calls.maker >= controls.maximumMakerCallsPerCell) return { ok: false, noModelCalled: true,
      error: 'Frozen raw maker provider-call bound is exhausted.' };
    calls.maker++;
    const result = await adapters.maker(options);
    calls.makerPreflight = result?.noModelCalled === true ? false : true;
    if (result?.noModelCalled === true) calls.maker--;
    else if (result?.routeObservation) calls.rawRouteObservations.push(clone(result.routeObservation));
    return result;
  };
  const nativeMaker = async options => {
    const remaining = controls.maximumMakerCallsPerCell - calls.maker;
    if (remaining < 1) return { ok: false, ran: false, noModelCalled: true,
      error: 'Frozen native maker provider-call bound is exhausted.' };
    let invocationResponses = 0;
    const onNativeProgress = options.onNativeProgress;
    const result = await adapters.nativeMaker({ ...options,
      maxModelCalls: Math.min(remaining, Number.isSafeInteger(options.maxModelCalls) ? options.maxModelCalls : remaining),
      onNativeProgress(progress) {
        const responses = progress?.responses;
        if (Number.isSafeInteger(responses) && responses >= 0) {
          if (responses < invocationResponses) throw new Error('Native maker provider-call evidence regressed.');
          calls.maker += responses - invocationResponses; invocationResponses = responses;
          if (calls.maker > controls.maximumMakerCallsPerCell) return 'Frozen native maker provider-call bound was exceeded.';
        }
        return onNativeProgress?.(progress);
      },
    });
    calls.makerPreflight = result?.noModelCalled === true ? false : true;
    return result;
  };
  const reviewer = async options => {
    if (calls.reviewer >= controls.maximumReviewerCallsPerCell) return { ran: false, noModelCalled: true,
      error: 'Frozen reviewer provider-call bound is exhausted.' };
    calls.reviewer++;
    const result = await adapters.reviewer(options);
    calls.reviewerPreflight = result?.noModelCalled === true ? false : true;
    if (result?.noModelCalled === true) calls.reviewer--;
    return result;
  };
  return { adapters: { ...adapters, maker, nativeMaker, reviewer }, calls };
}

function verifierCommand(fixture) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [quote(process.execPath), ...fixture.manifest.verifier.argv.map(quote)].join(' ');
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = value.input_tokens ?? value.inputTokens ?? value.prompt_tokens;
  const cached = value.cached_input_tokens ?? value.cachedInputTokens ?? value.prompt_tokens_details?.cached_tokens;
  const output = value.output_tokens ?? value.outputTokens ?? value.completion_tokens;
  return {
    input: Number.isSafeInteger(input) && input >= 0 ? input : null,
    cached: Number.isSafeInteger(cached) && cached >= 0 ? cached : null,
    output: Number.isSafeInteger(output) && output >= 0 ? output : null,
  };
}

function aggregateRole(result, checkpoint, role, calls) {
  const observed = role === 'maker' ? result?.seats?.maker?.observed?.turns ?? []
    : result?.seats?.reviewer?.observed ? [result.seats.reviewer.observed] : [];
  const usages = observed.map(turn => normalizedUsage(turn?.usage));
  const durations = observed.map(turn => Number.isFinite(turn?.durationMs) && turn.durationMs >= 0 ? Math.round(turn.durationMs) : null);
  const pending = checkpoint?.pendingCall;
  if (!usages.length && pending?.role === role) usages.push(normalizedUsage(pending?.response?.usage));
  if (!usages.length && calls > 0) usages.push(null);
  const total = field => usages.length && usages.every(row => row?.[field] !== null)
    ? usages.reduce((sum, row) => sum + row[field], 0) : null;
  return { input: total('input'), cached: total('cached'), output: total('output'),
    ms: durations.length && durations.every(Number.isSafeInteger) ? durations.reduce((sum, value) => sum + value, 0) : null };
}

const exactIdentity = (identity, provider, model) => identity === `${provider}:${model}`;
const safeReason = value => typeof value === 'string'
  ? value.replaceAll(/[^A-Za-z0-9._:@+-]/g, '_').slice(0, 128) || null : null;
const tri = values => values.some(value => value === false) ? false : values.every(value => value === true) ? true : null;

function routeEvidence(campaign, checkpoint, makerCalls, armId, rawObservations) {
  const requested = campaign.pair.maker.route;
  if (requested === null) return { observation: null, complete: true, stable: true, mismatch: false, fallback: false };
  let observation = checkpoint?.nativeSession?.routeObservation ?? checkpoint?.pendingCall?.response?.routeObservation ?? null;
  if (armId === 'raw' && Array.isArray(rawObservations) && rawObservations.length) {
    const request = rawObservations[0]?.requestEnforced ?? null;
    const sameRequest = rawObservations.every(item =>
      canonicalCodeEvalPairJson(item?.requestEnforced ?? null) === canonicalCodeEvalPairJson(request));
    observation = sameRequest ? { requestEnforced: clone(request),
      metadataObserved: rawObservations.flatMap(item => Array.isArray(item.metadataObserved) ? item.metadataObserved : []) } : null;
  }
  const metadata = observation?.metadataObserved;
  const requestObserved = observation?.requestEnforced != null;
  const requestMatches = requestObserved
    && canonicalCodeEvalPairJson(observation.requestEnforced) === canonicalCodeEvalPairJson(requested);
  if (requestObserved && !requestMatches) return { observation: null, complete: true, stable: false, mismatch: true, fallback: null };
  const complete = requestMatches && Array.isArray(metadata) && metadata.length === makerCalls && metadata.length > 0;
  if (!complete) return { observation: null, complete: false, stable: false, mismatch: null, fallback: null };
  const comparable = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const expected = requested.upstreamProvider.split('/')[0];
  const mismatch = metadata.some(item => comparable(item.provider) !== comparable(expected));
  const fallback = metadata.some(item => item.attempt !== 1);
  return { observation, complete: true, stable: !mismatch && !fallback, mismatch, fallback };
}

function outcomeStatus(result, candidateCurrent) {
  if (result?.question?.kind === 'budget') return 'budget_exhausted';
  if (result?.completion === 'candidate_ready_for_acceptance') return 'candidate_ready_for_acceptance';
  if (result?.status === 'verify_failed') return 'verification_failed';
  if (result?.status === 'review_unresolved') return 'review_unresolved';
  if (result?.status === 'needs_human') return 'needs_human';
  if (result?.status === 'needs_decision') return 'needs_decision';
  if (/budget/i.test(result?.error ?? '')) return 'budget_exhausted';
  if (!candidateCurrent || ['infra_error', 'stopped'].includes(result?.status)) return 'infrastructure_failed';
  return 'containment_refused';
}

function receiptFromBuild({ campaign, execution, cell, prepared, fixtureReadiness, result, checkpoint,
  candidateIntegrity, processCleanupComplete, authorizationEvidence, reportDigest, startedAt, endedAt, roleCalls }) {
  const arm = codeEvalPairArmForCell(campaign, execution, cell);
  const candidateFingerprint = isSha(`sha256:${result?.candidate?.fingerprint ?? ''}`)
    ? `sha256:${result.candidate.fingerprint}` : null;
  const finalCandidateCurrent = Boolean(candidateFingerprint && result?.candidate?.snapshotStatus !== 'unverified_terminal'
    && candidateIntegrity === true);
  const makerExact = exactIdentity(result?.seats?.maker?.observed?.identity,
    campaign.pair.maker.provider, campaign.pair.maker.model);
  const reviewerExact = exactIdentity(result?.seats?.reviewer?.observed?.identity,
    prepared.models.reviewer.provider, campaign.pair.reviewer.model);
  const nativeSession = checkpoint?.nativeSession;
  const nativeExact = cell.armId === 'native' && nativeSession?.executor === arm.makerExecutor
    && nativeSession?.model === campaign.pair.maker.model && nativeSession?.version === HARNESS_POLICY_VERSION
    && nativeSession?.harnessVersion === arm.execution.harness.version
    && typeof nativeSession?.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(nativeSession.sessionId);
  const route = routeEvidence(campaign, checkpoint, roleCalls.maker, cell.armId, roleCalls.rawRouteObservations);
  const executorExact = cell.armId === 'raw' ? result?.protocol?.version === arm.execution.protocolVersion : nativeExact;
  const providerCalls = Number.isSafeInteger(result?.usage?.calls) ? result.usage.calls : null;
  const callsComplete = providerCalls !== null && providerCalls === roleCalls.maker + roleCalls.reviewer;
  const connectionEvidenceComplete = callsComplete && roleCalls.maker > 0 && roleCalls.reviewer > 0
    && Boolean(result?.seats?.maker?.observed?.identity && result?.seats?.reviewer?.observed?.identity);
  const connectionBindingsMatch = connectionEvidenceComplete ? makerExact && reviewerExact : null;
  const qualificationBindingsMatch = authorizationEvidence === false || roleCalls.makerPreflight === false
      || roleCalls.reviewerPreflight === false ? false
    : authorizationEvidence === true && roleCalls.makerPreflight === true && roleCalls.reviewerPreflight === true ? true : null;
  const identityStable = makerExact && reviewerExact && executorExact && route.stable
    && qualificationBindingsMatch === true && connectionBindingsMatch === true;
  const identityObserved = Boolean(result?.seats?.maker?.observed?.identity || result?.seats?.reviewer?.observed?.identity);
  const modelMismatch = identityObserved ? !(makerExact && reviewerExact) : null;
  const substitutionDetected = modelMismatch === true || route.mismatch === true || route.fallback === true ? true
    : modelMismatch === false && route.complete !== false ? false : null;
  const verificationRan = typeof result?.verification?.ran === 'boolean' ? result.verification.ran : null;
  const verificationPassed = verificationRan === true ? result.verification.pass : null;
  const verificationBindingMatch = verificationRan === true && candidateFingerprint
    ? result?.verificationBinding === result.candidate.fingerprint : null;
  const reviewVerdict = ['APPROVED', 'REVISE'].includes(result?.review?.verdict) ? result.review.verdict : null;
  const reviewRan = reviewVerdict ? true : result?.review === null ? false : null;
  const reviewBindingMatch = reviewRan === true && candidateFingerprint
    ? result?.reviewBinding === result.candidate.fingerprint : null;
  const materialFindingCount = reviewRan === true && Array.isArray(result?.review?.findings)
    ? result.review.findings.filter(finding => ['high', 'medium'].includes(finding?.severity)).length : null;
  const candidateDiffExists = typeof result?.candidate?.diff === 'string' ? result.candidate.diff.length > 0 : null;
  const status = outcomeStatus(result, finalCandidateCurrent);
  const candidateIntegrityPassed = candidateIntegrity === true && finalCandidateCurrent;
  const engineContained = candidateIntegrityPassed && !['infra_error', 'stopped'].includes(result?.status);
  const containmentPassed = !engineContained || processCleanupComplete === false ? false
    : processCleanupComplete === true ? true : null;
  const mechanicalFloorPassed = tri([fixtureReadiness.ready === true, candidateIntegrityPassed, containmentPassed,
    verificationRan, verificationPassed, verificationBindingMatch, candidateDiffExists, finalCandidateCurrent, true,
    !['infrastructure_failed', 'interrupted_unknown', 'containment_refused'].includes(status)]);
  const reviewerIndependent = campaign.pair.maker.trainingOrg !== campaign.pair.reviewer.trainingOrg;
  const screenFloorPassed = mechanicalFloorPassed === false ? false : tri([mechanicalFloorPassed, reviewRan,
    reviewVerdict === null ? null : reviewVerdict === 'APPROVED',
    materialFindingCount === null ? null : materialFindingCount === 0,
    reviewBindingMatch, reviewerIndependent, identityStable,
    reviewerIndependent ? true : false]);
  const maker = aggregateRole(result, checkpoint, 'maker', roleCalls.maker);
  const reviewer = aggregateRole(result, checkpoint, 'reviewer', roleCalls.reviewer);
  const usageEvidenceIncomplete = checkpoint?.pendingCall?.response?.usageIncomplete === true
    || (Number.isSafeInteger(checkpoint?.usage?.unmeasuredCalls) && checkpoint.usage.unmeasuredCalls > 0);
  const usageIncomplete = !callsComplete || [maker.input, maker.cached, maker.output,
    reviewer.input, reviewer.cached, reviewer.output].some(value => value === null) || usageEvidenceIncomplete;
  const wallMs = Math.max(0, endedAt - startedAt);
  const verifierMs = Number.isSafeInteger(result?.verification?.durationMs) && result.verification.durationMs >= 0
    ? result.verification.durationMs : Number.isSafeInteger(result?.usage?.verificationMs) ? result.usage.verificationMs : null;
  const orchestration = [maker.ms, verifierMs, reviewer.ms].every(Number.isSafeInteger)
    && wallMs >= maker.ms + verifierMs + reviewer.ms ? wallMs - maker.ms - verifierMs - reviewer.ms : null;
  const repairs = Number.isSafeInteger(result?.usage?.repairs) ? result.usage.repairs : null;
  const retries = Number.isSafeInteger(result?.usage?.retries) ? result.usage.retries : null;
  const questions = result?.question === null ? 0 : result?.question ? 1 : null;
  const nativeHarness = nativeExact ? { name: arm.execution.harness.name, version: arm.execution.harness.version,
    artifactDigest: arm.execution.harness.artifactDigest, sessionId: nativeSession.sessionId } : null;
  const outcome = {
    status, buildStatus: safeReason(result?.status), reasonCode: safeReason(result?.error ?? result?.status),
    possibleBilling: providerCalls === 0 ? false : true, modelCallsMade: callsComplete ? providerCalls : null,
    candidateDiffExists, candidateFingerprint, finalCandidateCurrent,
    repairs, retries, questions, humanAnswers: 0,
  };
  return createCodeEvalPairReceipt({ campaign, execution, cell,
    observedIdentity: {
      makerModel: makerExact ? campaign.pair.maker.model : null,
      reviewerModel: reviewerExact ? campaign.pair.reviewer.model : null,
      executor: executorExact ? arm.makerExecutor : null,
      rawProtocolVersion: cell.armId === 'raw' && executorExact ? arm.execution.protocolVersion : null,
      nativeHarness, makerRoute: route.observation,
      qualificationBindingsMatch, connectionBindingsMatch, policyBindingMatch: executorExact,
      identityStable, substitutionDetected, helperModelDetected: executorExact ? false : null,
      fallbackDetected: route.fallback,
    }, outcome,
    quality: {
      fixturePreflightPassed: fixtureReadiness.ready === true, candidateIntegrityPassed, containmentPassed,
      verificationRan, verificationPassed, verificationBindingMatch, reviewRan, reviewVerdict,
      materialFindingCount, reviewBindingMatch, reviewerIndependent,
      reviewScreenStanding: reviewerIndependent ? 'independent_exact' : 'same_origin_advisory',
      humanInterventionDuringRun: false, mechanicalFloorPassed, screenFloorPassed,
    },
    economics: {
      providerCalls: callsComplete ? providerCalls : null, makerCalls: callsComplete ? roleCalls.maker : null,
      reviewerCalls: callsComplete ? roleCalls.reviewer : null,
      makerInputTokens: maker.input, makerCachedInputTokens: maker.cached, makerOutputTokens: maker.output,
      reviewerInputTokens: reviewer.input, reviewerCachedInputTokens: reviewer.cached, reviewerOutputTokens: reviewer.output,
      wallMs, makerMs: maker.ms, verifierMs, reviewerMs: reviewer.ms, orchestrationMs: orchestration,
      rawProtocolSteps: cell.armId === 'raw' && Number.isSafeInteger(result?.protocol?.steps) ? result.protocol.steps : null,
      rawFileActions: cell.armId === 'raw' && Number.isSafeInteger(result?.protocol?.actions) ? result.protocol.actions : null,
      nativeProviderResponses: cell.armId === 'native' && callsComplete ? roleCalls.maker : null,
      nativeToolActions: cell.armId === 'native' && Number.isSafeInteger(result?.protocol?.actions) ? result.protocol.actions : null,
      repairs, retries,
      incompleteSessions: checkpoint?.nativeInFlight === true || checkpoint?.pendingCall ? 1 : 0,
      costUsd: null, currency: null, usageIncomplete,
    },
    custody: {
      candidateBindingMatch: finalCandidateCurrent, verificationBindingMatch, reviewBindingMatch,
      containmentStable: containmentPassed, receiptsDegraded: checkpoint === null,
      processCleanupComplete,
    },
    artifacts: {
      sourceFixtureDigest: campaign.case.fixtureTreeDigest,
      initialCandidateDigest: campaign.case.baseCommitDigest,
      finalCandidateDigest: candidateFingerprint,
      diffDigest: typeof result?.candidate?.diff === 'string' ? sha256(result.candidate.diff) : null,
      verifierReceiptDigest: result?.verification ? digestJson(result.verification) : null,
      reviewerReceiptDigest: result?.review ? digestJson(result.review) : null,
      buildReportDigest: reportDigest, eventJournalDigest: null,
    }, recordedAt: new Date(endedAt).toISOString() });
}

export async function runCodeEvalPair({ campaignPath, statePath, ledgerPath, consent, maxCells }, dependencies = {}) {
  if (consent !== true || maxCells !== 1) {
    throw new Error('v1b pair run requires fresh provider consent and an exact one-cell bound; no model was called.');
  }
  const ctx = await loadCodeEvalPairContext({ campaignPath, statePath, ledgerPath });
  const before = codeEvalPairStatus(ctx.evidencePaths, ctx);
  if (!before.canAttempt) throw new Error('The next pair cell is complete or unresolved and can never replay.');
  const current = await buildExecutionSnapshot(ctx.campaign, { createdAt: ctx.execution.createdAt }, dependencies);
  if (canonicalCodeEvalPairJson(current.execution) !== canonicalCodeEvalPairJson(ctx.execution)) {
    throw new Error('Pair execution state drifted before spend; create a new campaign generation. No model was called.');
  }
  const sources = await ensurePrivateChild(ctx.evidencePaths.dir, 'sources');
  const runs = await ensurePrivateChild(ctx.evidencePaths.dir, 'runs');
  const runId = `codepair-${randomBytes(12).toString('hex')}`;
  const sourcePath = join(sources, runId), receiptsDir = join(runs, runId);
  // The durable cell marker must never name a run whose ownership registry does
  // not exist yet. Recovery can then prove the exact empty prelaunch state even
  // if this evaluator dies immediately after reservation.
  await mkdir(receiptsDir, { recursive: true, mode: STUDIO_DIR_MODE });
  initializeCodeOwnedProcessRegistry(receiptsDir);
  const reserved = reserveNextCodeEvalPairCell(ctx.evidencePaths, { ...ctx, buildRunId: runId,
    supervisorIdentity: `pid-${process.pid}`,
    maximumProviderCallsReserved: ctx.campaign.controls.maximumProviderCallsPerCell });
  const cell = reserved.cell, arm = codeEvalPairArmForCell(ctx.campaign, ctx.execution, cell);
  const startedAt = Date.now();
  let receipt;
  try {
    await (dependencies.materializeSource ?? materializeSource)(current.fixture, sourcePath);
    const inspectIntegrity = dependencies.inspectCandidateIntegrity ?? codeEvalCandidateIntegrity;
    const baseVerify = (dependencies.createVerifier ?? createCodeVerifier)(verifierCommand(current.fixture), {
      receiptsDir, timeoutMs: current.fixture.manifest.verifier.timeoutMs, repeatable: true });
    const verify = async options => {
      if (typeof options?.worktree !== 'string' || await inspectIntegrity(current.fixture, options.worktree) !== true) {
        return { ran: false, pass: null, error: 'Candidate changed files outside the fixture solution boundary.' };
      }
      return baseVerify(options);
    };
    verify.repeatable = baseVerify.repeatable; verify.command = baseVerify.command;
    const bounded = boundedAdapters(current.prepared.adapters, ctx.campaign.controls);
    let authorizationEvidence = null;
    const authorize = async () => {
      try {
        if (typeof current.prepared.authorize !== 'function') throw new Error('Frozen seat authorization is unavailable.');
        await current.prepared.authorize();
        authorizationEvidence = true;
      }
      catch (error) { authorizationEvidence = false; throw error; }
    };
    const seats = clone(current.prepared.models);
    seats.maker.codeExecutor = arm.makerExecutor;
    const result = await (dependencies.runSeats ?? runCodeSeats)({
      repoPath: sourcePath,
      task: `${current.fixture.manifest.task}\n\nAcceptance contract (binding):\n${current.fixture.manifest.acceptanceContract}`,
      seats, adapters: bounded.adapters, backendSnapshot: current.prepared.frozenBackends,
      receiptsDir, verify, limits: limitsFrom(ctx.campaign), authorize,
      onEvent: dependencies.onEvent,
    });
    const candidateIntegrity = typeof result?.candidate?.worktree === 'string'
      && await inspectIntegrity(current.fixture, result.candidate.worktree) === true;
    let checkpoint = null;
    try { checkpoint = await (dependencies.readCheckpoint ?? readCodeCheckpoint)(receiptsDir); } catch {}
    let processCleanupComplete = null;
    let processCleanupEvidence = null;
    try {
      const runStopped = (await (dependencies.runStatus ?? codeRunStatus)(receiptsDir)).owned === false;
      const ownedCleanup = await (dependencies.cleanupStatus ?? codeOwnedProcessCleanupStatus)(receiptsDir);
      processCleanupComplete = runStopped && ownedCleanup?.complete === true;
      processCleanupEvidence = {
        buildLeaseReleased: runStopped,
        registryComplete: ownedCleanup?.complete === true,
        registryReason: safeReason(ownedCleanup?.reason),
        registeredProcesses: Array.isArray(ownedCleanup?.intents) ? ownedCleanup.intents.length : null,
      };
    } catch {}
    const report = { schemaVersion: 1, campaignDigest: ctx.execution.campaignDigest,
      executionDigest: codeEvalPairExecutionIdentity(ctx.execution, ctx.campaign),
      cellId: codeEvalPairCellIdentity(cell, ctx.campaign, ctx.execution), armId: cell.armId,
      result, checkpoint, candidateIntegrity, authorizationEvidence, processCleanupEvidence };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    studioAtomicWrite(join(receiptsDir, 'code-eval-pair-build-report.json'), serialized, STUDIO_FILE_MODE);
    const endedAt = Date.now();
    receipt = receiptFromBuild({ ...ctx, cell, prepared: current.prepared,
      fixtureReadiness: current.fixtureReadiness, result, checkpoint, candidateIntegrity, processCleanupComplete,
      authorizationEvidence,
      reportDigest: sha256(serialized), startedAt, endedAt, roleCalls: bounded.calls });
  } catch {
    receipt = createUnknownCodeEvalPairReceipt({ campaign: ctx.campaign, execution: ctx.execution, cell,
      reasonCode: 'run_infrastructure_unknown' });
  }
  appendCodeEvalPairReceipt(ctx.evidencePaths, receipt, ctx, { reservationNonce: reserved.marker.reservationNonce });
  const after = codeEvalPairStatus(ctx.evidencePaths, ctx);
  return { ...publicPlan(ctx.campaign, ctx.execution, after), ok: receipt.standing !== 'unknown',
    standing: receipt.standing, receiptId: receipt.receiptId, armId: cell.armId,
    executor: arm.makerExecutor, providerCallsMade: receipt.economics.providerCalls,
    providerCallsMadeThisInvocation: receipt.economics.providerCalls, outcome: receipt.outcome.status };
}

function processIdentityDead(identity) {
  const match = /^pid-(\d+)$/.exec(identity ?? '');
  if (!match) return false;
  try { process.kill(Number(match[1]), 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function ownedProcessesDead(marker, paths) {
  if (!processIdentityDead(marker.supervisorIdentity)) return false;
  const runDir = join(paths.dir, 'runs', marker.buildRunId);
  let buildReleased = false;
  try { buildReleased = (await codeRunStatus(runDir)).owned === false; }
  catch (error) { buildReleased = error?.code === 'ENOENT'; }
  if (!buildReleased) return false;
  const cleanup = reconcileCodeOwnedProcessPrelaunch(runDir);
  return cleanup.complete === true;
}

export async function recoverCodeEvalPair({ campaignPath, statePath, ledgerPath, action }, dependencies = {}) {
  if (action !== 'seal-infra') throw new Error('v1b pair recovery supports only seal-infra and never calls a provider.');
  const ctx = await loadCodeEvalPairContext({ campaignPath, statePath, ledgerPath });
  const lock = await recoverAbandonedCodeEvalPairEvidenceLock(ctx.evidencePaths, {
    ownerDead: value => (dependencies.lockOwnerDead ?? (item => processIdentityDead(item.owner)))(value) });
  const before = codeEvalPairStatus(ctx.evidencePaths, ctx);
  if (before.state === 'pending') return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: null, action: lock.action === 'stale_lock_cleared' ? 'stale_lock_cleared_no_attempt' : 'nothing_to_recover',
    receiptId: null, standing: null, outcome: null, replayAllowed: false, canAttempt: true };
  if (before.state === 'complete') {
    return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0, observedProviderCalls: null,
      action: before.staleMarkerCleared ? 'stale_marker_cleared' : 'already_terminal',
      receiptId: null, standing: null, outcome: null, replayAllowed: false };
  }
  const recovered = await recoverCodeEvalPairCell(ctx.evidencePaths, ctx, {
    processesDead: marker => (dependencies.processesDead ?? ownedProcessesDead)(marker, ctx.evidencePaths) });
  return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: recovered.receipt?.economics?.providerCalls ?? null,
    action: recovered.action, receiptId: recovered.receipt?.receiptId ?? null,
    standing: recovered.receipt?.standing ?? null, outcome: recovered.receipt?.outcome?.status ?? null,
    replayAllowed: false };
}
