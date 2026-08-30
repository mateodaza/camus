// Bounded Code Harness Eval v1a orchestration. This module is intentionally a
// thin evidence wrapper around the shared Build engine: one native smoke cell,
// no alternate agent protocol, no retry of uncertain work, and no authority to
// commit, publish, admit, route, compare, or name a winner.
import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareCodeExecution } from './code-seat-launch.mjs';
import { createCodeVerifier } from './code-seat-verify.mjs';
import { runCodeSeats } from './code-seats.mjs';
import { codeCredentialRevision, readCodeCheckpoint, codeRunStatus } from './code-run-state.mjs';
import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';
import { HARNESS_POLICY_VERSION, assertNativeHarnessArtifact, nativeHarnessReadiness, resolveNativeHarness } from './native-harness-policy.mjs';
import {
  canonicalCodeEvalJson, codeEvalCampaignIdentity, codeEvalCellIdentity,
  codeEvalExecutionIdentity, createCodeEvalCell, createCodeEvalReceipt,
  createUnknownCodeEvalReceipt, validateCodeEvalCampaign, validateCodeEvalExecution,
} from './code-eval-contract.mjs';
import {
  appendCodeEvalReceipt, codeEvalEvidencePaths, codeEvalStatus as persistedCodeEvalStatus,
  createCodeEvalInflightMarker, ensureCodeEvalEvidenceDir, loadCodeEvalReceipts,
  recoverAbandonedCodeEvalEvidenceLock, recoverCodeEvalCell, reserveCodeEvalCell,
} from './code-eval-ledger.mjs';
import {
  codeEvalFixturePath, codeEvalFixtureReadiness, loadCodeEvalFixture, materializeCodeEvalFixture,
} from './code-eval-fixture.mjs';

const execFile = promisify(execFileCallback);
const MAX_CAMPAIGN_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;

const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digestJson = value => sha256(canonicalCodeEvalJson(clone(value)));
const isSha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

async function loadJsonFile(path, maximum, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`${label} must be a bounded regular non-symlink file.`);
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`${label} must contain valid JSON; private contents were omitted.`); }
  return value;
}

function evidencePaths({ statePath, ledgerPath }) {
  const state = resolve(statePath), ledger = resolve(ledgerPath);
  if (basename(state) !== 'state.json' || basename(ledger) !== 'receipts.jsonl' || dirname(state) !== dirname(ledger)) {
    throw new Error('State and ledger must be sibling state.json and receipts.jsonl files in one dedicated private directory.');
  }
  const paths = codeEvalEvidencePaths(dirname(state));
  if (paths.ledger !== ledger) throw new Error('Ledger path does not match the dedicated evidence directory.');
  ensureCodeEvalEvidenceDir(paths);
  return { evidence: paths, state };
}

async function loadCampaign(campaignPath) {
  return validateCodeEvalCampaign(await loadJsonFile(resolve(campaignPath), MAX_CAMPAIGN_BYTES, 'Campaign'));
}

async function loadState(path, campaign) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES || (info.mode & 0o777) !== STUDIO_FILE_MODE) {
    throw new Error('Execution state must be a bounded private 0600 regular file.');
  }
  return validateCodeEvalExecution(await loadJsonFile(path, MAX_STATE_BYTES, 'Execution state'), campaign);
}

function writeState(path, execution) {
  studioAtomicWrite(path, `${JSON.stringify(execution, null, 2)}\n`, STUDIO_FILE_MODE);
}

function campaignPairing(campaign) {
  return {
    maker: {
      backend: campaign.treatment.maker.backend,
      model: campaign.treatment.maker.model,
      ...(campaign.treatment.maker.effort ? { effort: campaign.treatment.maker.effort } : {}),
      codeExecutor: campaign.treatment.executor,
    },
    reviewer: {
      backend: campaign.treatment.reviewer.backend,
      model: campaign.treatment.reviewer.model,
      ...(campaign.treatment.reviewer.effort ? { effort: campaign.treatment.reviewer.effort } : {}),
    },
  };
}

function assertSeatMatchesCampaign(actual, requested, role) {
  for (const key of role === 'maker'
    ? ['backend', 'provider', 'model', 'effort', 'trainingOrg', 'transport', 'connection']
    : ['backend', 'model', 'effort', 'trainingOrg']) {
    if ((actual?.[key] ?? null) !== (requested[key] ?? null)) throw new Error(`${role} seat drifted from the frozen smoke campaign; no model was called.`);
  }
}

function assertRouteMatchesCampaign(backend, requested) {
  const actualRoute = backend?.route ?? null;
  if (canonicalCodeEvalJson(actualRoute) !== canonicalCodeEvalJson(requested.route)) {
    throw new Error('maker upstream route drifted from the frozen smoke campaign; no model was called.');
  }
}

function credentialRevision(backend, env) {
  const name = backend?.auth?.envVar ?? backend?.apiKeyEnv;
  if (!name) return 'none';
  if (typeof env[name] !== 'string' || !env[name]) throw new Error('A frozen seat credential is unavailable; no model was called.');
  return codeCredentialRevision(env[name]);
}

const RUNTIME_SEEDS = Object.freeze([
  'apps/loop-studio/code-build.mjs',
  'apps/loop-studio/code-eval.mjs',
  'apps/loop-studio/fixtures/code-eval-v1/simple-bounded-parser-fix/fixture.json',
  'apps/loop-studio/fixtures/code-eval-v1/balanced-job-event-scheduler/fixture.json',
  'apps/loop-studio/package.json',
  'apps/loop-studio/checks/models.json',
  'apps/loop-studio/checks/registry.json',
  'apps/loop-studio/checks/review.schema.json',
  'packages/cli/skills/camus/control-register.v1.json',
]);
const RUNTIME_SOURCE = /^(?:apps\/loop-studio\/|packages\/trust\/lib\/|packages\/cli\/skills\/camus\/)/;

async function runtimeFiles(root) {
  const manifestPath = join(root, 'manifest.json');
  try {
    const manifest = await loadJsonFile(manifestPath, MAX_STATE_BYTES, 'Packed runtime manifest');
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)
        || Object.keys(manifest).sort().join(',') !== 'files,schemaVersion') {
      throw new Error('Packed runtime manifest has an unsupported schema.');
    }
    const files = [...manifest.files];
    if (!files.length || new Set(files).size !== files.length
        || files.some(name => typeof name !== 'string' || !RUNTIME_SOURCE.test(name)
          || name.includes('..') || !/\.(?:mjs|json)$/.test(name) || name.endsWith('.test.mjs'))
        || canonicalCodeEvalJson(files) !== canonicalCodeEvalJson([...files].sort())) {
      throw new Error('Packed runtime manifest contains an invalid or non-canonical file list.');
    }
    return files;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Source checkouts do not carry the generated npm manifest. Reconstruct the
  // exact build-code-runtime import closure and public-data allowlist instead of
  // hashing only Studio/lib and missing cross-package policy/schema code.
  const pending = [...RUNTIME_SEEDS], copied = new Set();
  while (pending.length) {
    const name = pending.shift();
    if (copied.has(name)) continue;
    if (!RUNTIME_SOURCE.test(name) || name.includes('..') || !/\.(?:mjs|json)$/.test(name)
        || name.endsWith('.test.mjs')) throw new Error(`Runtime identity source outside the shipped allowlist: ${name}`);
    const path = join(root, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime identity source is not a regular file: ${name}`);
    copied.add(name);
    if (!name.endsWith('.mjs')) continue;
    const code = await readFile(path, 'utf8');
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      pending.push(relative(root, resolve(dirname(path), match[1])).split('\\').join('/'));
    }
  }
  return [...copied].sort();
}

export async function codeEvalRuntimeIdentity({ runtimeRoot = null, packagePath = null } = {}) {
  const root = resolve(runtimeRoot ?? fileURLToPath(new URL('../../../', import.meta.url)));
  const names = await runtimeFiles(root);
  const files = [];
  for (const name of names) {
    const path = join(root, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Frozen runtime file is not a regular file: ${name}`);
    files.push([name, sha256(await readFile(path))]);
  }
  let versionPath = packagePath ? resolve(packagePath) : join(root, 'packages', 'cli', 'package.json');
  try { await lstat(versionPath); } catch (error) {
    if (error?.code !== 'ENOENT' || packagePath) throw error;
    versionPath = resolve(root, '..', 'package.json');
  }
  const packageJson = await loadJsonFile(versionPath, 256 * 1024, 'Camus CLI package');
  return {
    packageVersion: String(packageJson.version),
    treeDigest: digestJson(files),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
  };
}

function assertFixtureMatchesCampaign(campaign, fixture, readiness) {
  const expected = {
    caseId: fixture.manifest.caseId,
    caseVersion: fixture.manifest.caseVersion,
    taskClass: fixture.manifest.taskClass,
    fixtureId: fixture.fixtureId,
    fixtureTreeDigest: fixture.baseTreeDigest,
    baseCommitDigest: fixture.baseTreeDigest,
    taskSha256: fixture.taskSha256,
    acceptanceContractSha256: fixture.acceptanceContractSha256,
    verifierDigest: fixture.verifierDigest,
    verifierTimeoutMs: fixture.manifest.verifier.timeoutMs,
  };
  const actual = {
    caseId: campaign.case.caseId,
    caseVersion: campaign.case.caseVersion,
    taskClass: campaign.case.taskClass,
    fixtureId: campaign.case.fixtureId,
    fixtureTreeDigest: campaign.case.fixtureTreeDigest,
    baseCommitDigest: campaign.case.baseCommitDigest,
    taskSha256: campaign.case.taskSha256,
    acceptanceContractSha256: campaign.case.acceptanceContractSha256,
    verifierDigest: campaign.case.verifier.commandSha256,
    verifierTimeoutMs: campaign.case.verifier.timeoutMs,
  };
  if (canonicalCodeEvalJson(actual) !== canonicalCodeEvalJson(expected) || readiness.ready !== true
      || readiness.fixtureId !== fixture.fixtureId || readiness.providerCallsMade !== 0) {
    throw new Error('Campaign fixture or verifier differs from the tracked base-red/reference-green fixture; no model was called.');
  }
}

async function buildExecutionSnapshot(campaign, { createdAt = new Date().toISOString() } = {}, dependencies = {}) {
  const fixturePath = codeEvalFixturePath(campaign.case.caseId, dependencies.fixtureRoot);
  const fixture = await (dependencies.loadFixture ?? loadCodeEvalFixture)(fixturePath);
  const fixtureReadiness = await (dependencies.fixtureReadiness ?? codeEvalFixtureReadiness)(fixturePath);
  assertFixtureMatchesCampaign(campaign, fixture, fixtureReadiness);
  const pairing = campaignPairing(campaign);
  const prepared = await (dependencies.prepareExecution ?? prepareCodeExecution)(pairing);
  assertSeatMatchesCampaign(prepared.models?.maker, campaign.treatment.maker, 'maker');
  assertSeatMatchesCampaign(prepared.models?.reviewer, campaign.treatment.reviewer, 'reviewer');
  const makerBackend = clone(prepared.frozenBackends.maker), reviewerBackend = clone(prepared.frozenBackends.reviewer);
  assertRouteMatchesCampaign(makerBackend, campaign.treatment.maker);
  if (prepared.models.maker.codeExecutor !== campaign.treatment.executor) throw new Error('Native executor drifted from the frozen campaign; no model was called.');
  for (const role of ['maker', 'reviewer']) if (!/^(?:qual1|builtin1):[a-f0-9]{64}$/.test(prepared.models[role]?.qualification?.fingerprint ?? '')) {
    throw new Error(`${role} qualification is missing or invalid; no model was called.`);
  }
  const readiness = await (dependencies.harnessReadiness ?? nativeHarnessReadiness)(campaign.treatment.executor);
  if (readiness?.status !== 'ready' || readiness.ready !== true) throw new Error(`${readiness?.label ?? 'Native harness'} is ${readiness?.status ?? 'unavailable'}; no model was called.`);
  const harness = await (dependencies.resolveHarness ?? resolveNativeHarness)(campaign.treatment.executor);
  const artifact = await (dependencies.assertArtifact ?? assertNativeHarnessArtifact)(campaign.treatment.executor, harness);
  const runtime = await (dependencies.runtimeIdentity ?? codeEvalRuntimeIdentity)();
  const artifactDigest = `sha256:${artifact}`;
  const execution = {
    schemaVersion: 1,
    campaignDigest: codeEvalCampaignIdentity(campaign),
    createdAt,
    runtime,
    maker: {
      backendDefinitionDigest: digestJson(makerBackend),
      qualificationFingerprint: prepared.models.maker.qualification.fingerprint,
      credentialRevision: credentialRevision(makerBackend, dependencies.env ?? process.env),
      connectionDefinitionDigest: digestJson({ backend: makerBackend, connection: prepared.models.maker.connection ?? null }),
      expectedModel: campaign.treatment.maker.model,
      expectedRoute: campaign.treatment.maker.route === null ? null : clone(campaign.treatment.maker.route),
    },
    reviewer: {
      backendDefinitionDigest: digestJson(reviewerBackend),
      qualificationFingerprint: prepared.models.reviewer.qualification.fingerprint,
      credentialRevision: credentialRevision(reviewerBackend, dependencies.env ?? process.env),
      connectionDefinitionDigest: digestJson({ backend: reviewerBackend, connection: prepared.models.reviewer.connection ?? null }),
      expectedModel: campaign.treatment.reviewer.model,
    },
    nativeHarness: {
      executor: campaign.treatment.executor,
      name: campaign.treatment.executor === 'qwen_native' ? 'qwen_code' : 'grok_build',
      version: readiness.requiredVersion,
      artifactDigest,
      parserVersion: 'native-harness-v1',
      outerSandboxPolicyDigest: digestJson({ protocol: HARNESS_POLICY_VERSION, executor: campaign.treatment.executor, artifactDigest, runtime: runtime.treeDigest }),
      credentialGatewayPolicyDigest: digestJson({ protocol: 'native-gateway/v1a', provider: campaign.treatment.maker.provider,
        model: campaign.treatment.maker.model, route: campaign.treatment.maker.route,
        maximumCalls: campaign.controls.maximumProviderCallsPerCell,
        maximumTokens: campaign.controls.maximumTokensReserved, runtime: runtime.treeDigest }),
    },
    verifierDigest: fixture.verifierDigest,
    fixtureReadinessDigest: digestJson(fixtureReadiness),
  };
  validateCodeEvalExecution(execution, campaign);
  return { execution, prepared, fixture, fixtureReadiness };
}

function publicPlan(campaign, execution, cell, state = null) {
  return {
    ok: true,
    protocol: 'code-harness-eval-v1a',
    campaignId: campaign.campaignId,
    campaignDigest: codeEvalCampaignIdentity(campaign),
    executionDigest: codeEvalExecutionIdentity(execution, campaign),
    cellId: codeEvalCellIdentity(cell, campaign, execution),
    executor: campaign.treatment.executor,
    route: campaign.treatment.maker.route === null ? null : clone(campaign.treatment.maker.route),
    totalCells: 1,
    providerCallsMade: 0,
    maximumRemainingProviderCalls: state?.canAttempt === false ? 0 : campaign.controls.maximumProviderCallsPerCell,
    maximumTokensReserved: campaign.controls.maximumTokensReserved,
    fixture: { caseId: campaign.case.caseId, taskClass: campaign.case.taskClass, base: 'red', reference: 'green' },
    standing: state?.standing ?? null,
    claim: state?.standing ?? 'no_execution_claim',
    dollarCost: null,
    note: 'One exact native smoke only. No comparison, winner, routing, admission, or production-readiness claim.',
  };
}

export async function planCodeEval({ campaignPath, statePath, ledgerPath }, dependencies = {}) {
  const campaign = await loadCampaign(campaignPath);
  const paths = evidencePaths({ statePath, ledgerPath });
  let existing = null;
  try { existing = await loadState(paths.state, campaign); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const snapshot = await buildExecutionSnapshot(campaign, { ...(existing ? { createdAt: existing.createdAt } : {}) }, dependencies);
  if (existing && canonicalCodeEvalJson(existing) !== canonicalCodeEvalJson(snapshot.execution)) {
    throw new Error('Existing execution state differs from current qualifications, credentials, runtime, harness, fixture, or verifier; no model was called.');
  }
  if (!existing) writeState(paths.state, snapshot.execution);
  const execution = existing ?? snapshot.execution;
  const cell = createCodeEvalCell(campaign, execution);
  const receipts = loadCodeEvalReceipts(paths.evidence, { campaign, execution, cell });
  if (receipts.length > 1) throw new Error('v1a permits only one receipt.');
  const state = persistedCodeEvalStatus(paths.evidence, { campaign, execution, cell });
  return publicPlan(campaign, execution, cell, state);
}

async function contextFor(pathsInput) {
  const campaign = await loadCampaign(pathsInput.campaignPath);
  const paths = evidencePaths(pathsInput);
  const execution = await loadState(paths.state, campaign);
  const cell = createCodeEvalCell(campaign, execution);
  return { campaign, paths, execution, cell };
}

export async function statusCodeEval(pathsInput) {
  const ctx = await contextFor(pathsInput);
  const state = persistedCodeEvalStatus(ctx.paths.evidence, ctx);
  const receipt = loadCodeEvalReceipts(ctx.paths.evidence, ctx)[0] ?? null;
  return { ...publicPlan(ctx.campaign, ctx.execution, ctx.cell, state), ...state,
    providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: receipt?.economics?.providerCalls ?? null };
}

async function git(args, options = {}) {
  await execFile('git', args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, ...options });
}

export async function codeEvalCandidateIntegrity(fixture, sourcePath) {
  const allowed = new Set(fixture.referenceFiles.map(file => file.path));
  try {
    const options = { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' };
    const tracked = await execFile('git', ['-C', sourcePath, 'diff', '--name-only', '-z', 'HEAD', '--'], options);
    const untracked = await execFile('git', ['-C', sourcePath, 'ls-files', '--others', '--exclude-standard', '-z'], options);
    const ignored = await execFile('git', ['-C', sourcePath, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], options);
    const changed = [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
    if (ignored.stdout.split('\0').some(Boolean) || !changed.every(path => allowed.has(path))) return false;
    for (const path of changed) {
      const info = await lstat(join(sourcePath, path));
      if (!info.isFile() || info.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function materializeSource(fixture, path) {
  await materializeCodeEvalFixture(fixture, path);
  const privateHome = join(dirname(path), `${basename(path)}-git-home`);
  const emptyTemplate = join(privateHome, 'template');
  await mkdir(emptyTemplate, { recursive: true, mode: STUDIO_DIR_MODE });
  await chmod(privateHome, STUDIO_DIR_MODE); await chmod(emptyTemplate, STUDIO_DIR_MODE);
  // This repository is evaluator-owned, but Git can otherwise inherit global
  // templates, hooks, signing helpers and credentials. Keep even this local
  // setup inside a minimal, non-interactive environment.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: privateHome,
    XDG_CONFIG_HOME: join(privateHome, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    LANG: 'C',
    LC_ALL: 'C',
  };
  const guarded = ['-c', 'core.hooksPath=/dev/null'];
  await git([...guarded, 'init', '-q', `--template=${emptyTemplate}`, path], { env });
  await git([...guarded, '-C', path, 'add', '--', '.'], { env });
  await git([...guarded, '-C', path, '-c', 'user.name=Camus Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture base'], { env });
}

function verifierCommand(fixture) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [quote(process.execPath), ...fixture.manifest.verifier.argv.map(quote)].join(' ');
}

function limitsFrom(campaign) {
  const controls = campaign.controls;
  return {
    maxCalls: controls.maximumProviderCallsPerCell,
    maxSteps: controls.maximumSteps,
    maxActions: controls.maximumActions,
    maxRepairs: controls.maximumRepairs,
    maxRetries: controls.maximumRetries,
    maxTokens: controls.maximumTokensReserved,
    timeoutMs: controls.wallTimeoutMs,
    callTimeoutMs: controls.callTimeoutMs,
    idleTimeoutMs: 0,
  };
}

function boundedSeatAdapters(adapters, controls) {
  const calls = { maker: 0, reviewer: 0 };
  const nativeMaker = async options => {
    const remaining = controls.maximumMakerCallsPerCell - calls.maker;
    if (remaining < 1) return { ok: false, ran: false, noModelCalled: true,
      error: 'Frozen native maker provider-call bound is exhausted.' };
    let invocationResponses = 0;
    const onNativeProgress = options.onNativeProgress;
    return adapters.nativeMaker({ ...options,
      maxModelCalls: Math.min(remaining, Number.isSafeInteger(options.maxModelCalls) ? options.maxModelCalls : remaining),
      onNativeProgress(progress) {
        const responses = progress?.responses;
        if (Number.isSafeInteger(responses) && responses >= 0) {
          if (responses < invocationResponses) throw new Error('Native maker provider-call evidence regressed.');
          calls.maker += responses - invocationResponses;
          invocationResponses = responses;
          if (calls.maker > controls.maximumMakerCallsPerCell) return 'Frozen native maker provider-call bound was exceeded.';
        }
        return onNativeProgress?.(progress);
      },
    });
  };
  const reviewer = async options => {
    if (calls.reviewer >= controls.maximumReviewerCallsPerCell) return { ran: false, noModelCalled: true,
      error: 'Frozen reviewer provider-call bound is exhausted.' };
    calls.reviewer++;
    return adapters.reviewer(options);
  };
  return { adapters: { ...adapters, nativeMaker, reviewer }, calls };
}

async function ensurePrivateEvidenceChild(root, name) {
  const path = join(root, name);
  let created = false;
  try { await mkdir(path, { recursive: false, mode: STUDIO_DIR_MODE }); created = true; }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  if (created) await chmod(path, STUDIO_DIR_MODE);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== STUDIO_DIR_MODE) {
    throw new Error(`Code-eval ${name} must be a real private 0700 directory; no model was called.`);
  }
  return path;
}

function exactObservedIdentity(identity, provider, model) {
  return identity === `${provider}:${model}`;
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = value.input_tokens ?? value.inputTokens ?? value.prompt_tokens;
  const output = value.output_tokens ?? value.outputTokens ?? value.completion_tokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 ? { input, output } : null;
}

function usageTotals(result, checkpoint, roleCalls) {
  const makerTurns = result?.seats?.maker?.observed?.turns ?? [];
  const reviewerTurns = result?.seats?.reviewer?.observed ? [result.seats.reviewer.observed] : [];
  const roleUsages = {
    maker: makerTurns.map(turn => normalizedUsage(turn?.usage)),
    reviewer: reviewerTurns.map(turn => normalizedUsage(turn?.usage)),
  };
  // A native harness can end without a structured coding terminal after the
  // gateway has nevertheless measured every provider response. In that case
  // the pending response is the authoritative aggregate usage for that role;
  // do not turn the absence of a successful observed turn into synthetic zero.
  const pending = checkpoint?.pendingCall;
  if (['maker', 'reviewer'].includes(pending?.role) && roleUsages[pending.role].length === 0) {
    roleUsages[pending.role].push(normalizedUsage(pending?.response?.usage));
  }
  for (const role of ['maker', 'reviewer']) if (roleCalls[role] > 0 && roleUsages[role].length === 0) roleUsages[role].push(null);
  const usages = [...roleUsages.maker, ...roleUsages.reviewer];
  if (!usages.length || usages.some(value => value === null)) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: usages.reduce((sum, row) => sum + row.input, 0),
    outputTokens: usages.reduce((sum, row) => sum + row.output, 0),
  };
}

function outcomeFor(result, candidateCurrent) {
  if (result?.completion === 'candidate_ready_for_acceptance') return 'candidate_ready_for_acceptance';
  if (result?.status === 'verify_failed') return 'verification_failed';
  if (result?.status === 'review_unresolved') return 'review_unresolved';
  if (result?.status === 'needs_human') return 'needs_human';
  if (result?.status === 'needs_decision') return 'needs_decision';
  if (/budget/i.test(result?.error ?? '')) return 'budget_exhausted';
  if (!candidateCurrent || ['infra_error', 'stopped'].includes(result?.status)) return 'infrastructure_failed';
  return 'containment_refused';
}

const comparableProvider = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function routeObservationFrom(checkpoint) {
  return checkpoint?.nativeSession?.routeObservation
    ?? checkpoint?.pendingCall?.response?.routeObservation
    ?? null;
}

function assessRouteObservation(campaign, checkpoint, makerCalls) {
  const requested = campaign.treatment.maker.route;
  if (requested === null) return {
    observation: null, complete: true, stable: true, providerMismatch: false, fallbackDetected: false,
  };
  const observation = routeObservationFrom(checkpoint);
  const metadata = observation?.metadataObserved;
  const requestMatch = observation?.requestEnforced
    && canonicalCodeEvalJson(observation.requestEnforced) === canonicalCodeEvalJson(requested);
  const complete = requestMatch === true && Array.isArray(metadata) && metadata.length > 0
    && Number.isSafeInteger(makerCalls) && metadata.length === makerCalls;
  if (!complete) return {
    observation: null, complete: false, stable: false, providerMismatch: false, fallbackDetected: null,
  };
  const expectedBase = requested.upstreamProvider.split('/')[0];
  const providerMismatch = metadata.some(item =>
    comparableProvider(item?.provider) !== comparableProvider(expectedBase));
  const fallbackDetected = metadata.some(item => item?.attempt !== 1);
  return {
    observation, complete, providerMismatch, fallbackDetected,
    stable: !providerMismatch && !fallbackDetected,
  };
}

function receiptFromBuild({ campaign, execution, cell, prepared, fixtureReadiness, result, checkpoint,
  candidateIntegrity, reportDigest, startedAt, roleCalls }) {
  const candidateFingerprint = isSha(`sha256:${result?.candidate?.fingerprint ?? ''}`) ? `sha256:${result.candidate.fingerprint}` : null;
  const candidateCurrent = Boolean(candidateFingerprint && result.candidate?.snapshotStatus !== 'unverified_terminal');
  const candidateIntegrityPassed = candidateCurrent && candidateIntegrity === true;
  const makerRaw = result?.seats?.maker?.observed?.identity ?? null;
  const reviewerRaw = result?.seats?.reviewer?.observed?.identity ?? null;
  const makerExact = exactObservedIdentity(makerRaw, campaign.treatment.maker.provider, campaign.treatment.maker.model);
  const reviewerProvider = prepared.models.reviewer.provider;
  const reviewerExact = exactObservedIdentity(reviewerRaw, reviewerProvider, campaign.treatment.reviewer.model);
  const nativeSessionExact = checkpoint?.nativeSession?.executor === campaign.treatment.executor
    && checkpoint.nativeSession.model === campaign.treatment.maker.model
    && checkpoint.nativeSession.version === HARNESS_POLICY_VERSION
    && checkpoint.nativeSession.harnessVersion === execution.nativeHarness.version;
  const route = assessRouteObservation(campaign, checkpoint, roleCalls.maker);
  const identityStable = makerExact && reviewerExact && nativeSessionExact && route.stable;
  const modelIdentityObserved = Boolean(makerRaw || reviewerRaw);
  const modelSubstitution = modelIdentityObserved ? !(makerExact && reviewerExact) : null;
  const substitutionDetected = modelSubstitution === null && !route.providerMismatch
    ? null : Boolean(modelSubstitution || route.providerMismatch);
  const verificationBindingMatch = candidateCurrent && result?.verificationBinding === result.candidate.fingerprint;
  const reviewBindingMatch = candidateCurrent && result?.reviewBinding === result.candidate.fingerprint;
  const verificationPassed = result?.verification?.pass === true;
  const mechanicalFloorPassed = candidateIntegrityPassed && verificationBindingMatch && verificationPassed;
  const usage = usageTotals(result, checkpoint, roleCalls);
  const providerCalls = Number.isSafeInteger(result?.usage?.calls) ? result.usage.calls : null;
  const callsComplete = providerCalls !== null && providerCalls === roleCalls.maker + roleCalls.reviewer;
  const usageEvidenceIncomplete = checkpoint?.pendingCall?.response?.usageIncomplete === true
    || Number.isSafeInteger(checkpoint?.usage?.unmeasuredCalls) && checkpoint.usage.unmeasuredCalls > 0;
  const usageIncomplete = !callsComplete || usage.inputTokens === null || usage.outputTokens === null || usageEvidenceIncomplete;
  const outcome = outcomeFor(result, candidateCurrent);
  return createCodeEvalReceipt({
    campaign, execution, cell,
    observedIdentity: {
      makerModel: makerExact ? campaign.treatment.maker.model : null,
      reviewerModel: reviewerExact ? campaign.treatment.reviewer.model : null,
      executor: nativeSessionExact ? campaign.treatment.executor : null,
      harnessArtifactDigest: nativeSessionExact ? execution.nativeHarness.artifactDigest : null,
      makerRoute: route.observation,
      identityStable,
      substitutionDetected,
      helperModelDetected: nativeSessionExact ? false : null,
      fallbackDetected: route.fallbackDetected,
    },
    outcome: {
      status: outcome,
      reasonCode: typeof result?.status === 'string' ? result.status.replaceAll(/[^A-Za-z0-9._:@+-]/g, '_').slice(0, 128) : null,
      possibleBilling: providerCalls !== 0,
      candidateFingerprint,
    },
    quality: {
      fixturePreflightPassed: fixtureReadiness.ready === true,
      candidateIntegrityPassed,
      containmentPassed: candidateIntegrityPassed && !['infra_error', 'stopped'].includes(result?.status),
      verificationPassed: result?.verification?.ran === true ? result.verification.pass : null,
      reviewVerdict: ['APPROVED', 'REVISE'].includes(result?.review?.verdict) ? result.review.verdict : null,
      humanInterventionDuringRun: false,
      mechanicalFloorPassed,
    },
    economics: {
      providerCalls,
      makerCalls: callsComplete ? roleCalls.maker : null,
      reviewerCalls: callsComplete ? roleCalls.reviewer : null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      wallMs: Math.max(0, Date.now() - startedAt),
      costUsd: null,
      currency: null,
      usageIncomplete,
    },
    custody: { candidateBindingMatch: candidateCurrent, verificationBindingMatch, reviewBindingMatch },
    artifacts: { buildReportDigest: reportDigest },
  });
}

export async function runCodeEval({ campaignPath, statePath, ledgerPath, consent, maxCells }, dependencies = {}) {
  if (consent !== true || maxCells !== 1) throw new Error('v1a run requires fresh provider consent and an exact one-cell bound; no model was called.');
  const ctx = await contextFor({ campaignPath, statePath, ledgerPath });
  const before = persistedCodeEvalStatus(ctx.paths.evidence, ctx);
  if (!before.canAttempt) throw new Error('The native-smoke cell is complete or unresolved and can never replay.');
  const current = await buildExecutionSnapshot(ctx.campaign, { createdAt: ctx.execution.createdAt }, dependencies);
  if (canonicalCodeEvalJson(current.execution) !== canonicalCodeEvalJson(ctx.execution)) {
    throw new Error('Execution state drifted before spend; create a new campaign generation. No model was called.');
  }
  const sources = await ensurePrivateEvidenceChild(ctx.paths.evidence.dir, 'sources');
  const runs = await ensurePrivateEvidenceChild(ctx.paths.evidence.dir, 'runs');
  const runId = `codeeval-${codeEvalCellIdentity(ctx.cell, ctx.campaign, ctx.execution).slice(-16)}-${randomBytes(4).toString('hex')}`;
  const marker = createCodeEvalInflightMarker({
    ...ctx,
    buildRunId: runId,
    supervisorIdentity: `pid-${process.pid}`,
    maximumProviderCallsReserved: ctx.campaign.controls.maximumProviderCallsPerCell,
  });
  reserveCodeEvalCell(ctx.paths.evidence, marker, ctx);
  const startedAt = Date.now();
  const sourcePath = join(sources, runId), receiptsDir = join(runs, runId);
  let receipt;
  try {
    await (dependencies.materializeSource ?? materializeSource)(current.fixture, sourcePath);
    await mkdir(receiptsDir, { recursive: true, mode: STUDIO_DIR_MODE });
    const inspectCandidateIntegrity = dependencies.inspectCandidateIntegrity ?? codeEvalCandidateIntegrity;
    const baseVerify = (dependencies.createVerifier ?? createCodeVerifier)(verifierCommand(current.fixture), {
      receiptsDir, timeoutMs: current.fixture.manifest.verifier.timeoutMs, repeatable: true,
    });
    const verify = async options => {
      if (typeof options?.worktree !== 'string'
          || await inspectCandidateIntegrity(current.fixture, options.worktree) !== true) {
        return { ran: false, pass: null, error: 'Candidate changed files outside the fixture solution boundary.' };
      }
      return baseVerify(options);
    };
    verify.repeatable = baseVerify.repeatable;
    verify.command = baseVerify.command;
    const bounded = boundedSeatAdapters(current.prepared.adapters, ctx.campaign.controls);
    const result = await (dependencies.runSeats ?? runCodeSeats)({
      repoPath: sourcePath,
      task: `${current.fixture.manifest.task}\n\nAcceptance contract (binding):\n${current.fixture.manifest.acceptanceContract}`,
      seats: current.prepared.models,
      adapters: bounded.adapters,
      backendSnapshot: current.prepared.frozenBackends,
      receiptsDir,
      verify,
      limits: limitsFrom(ctx.campaign),
      authorize: current.prepared.authorize,
      onEvent: dependencies.onEvent,
    });
    const candidateIntegrity = typeof result?.candidate?.worktree === 'string'
      && await inspectCandidateIntegrity(current.fixture, result.candidate.worktree) === true;
    let checkpoint = null;
    try { checkpoint = await (dependencies.readCheckpoint ?? readCodeCheckpoint)(receiptsDir); } catch { /* normalized below as failed evidence */ }
    const report = { schemaVersion: 1, campaignDigest: ctx.execution.campaignDigest,
      executionDigest: codeEvalExecutionIdentity(ctx.execution, ctx.campaign),
      cellId: codeEvalCellIdentity(ctx.cell, ctx.campaign, ctx.execution), result, checkpoint, candidateIntegrity };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = join(receiptsDir, 'code-eval-build-report.json');
    studioAtomicWrite(reportPath, serialized, STUDIO_FILE_MODE);
    receipt = receiptFromBuild({ ...ctx, prepared: current.prepared, fixtureReadiness: current.fixtureReadiness,
      result, checkpoint, candidateIntegrity, reportDigest: sha256(serialized), startedAt, roleCalls: bounded.calls });
  } catch {
    // The marker existed before shared-engine entry. Any failure beyond it may
    // have incurred spend; preserve uncertainty instead of guessing or retrying.
    receipt = createUnknownCodeEvalReceipt({ ...ctx, reasonCode: 'run_infrastructure_unknown' });
  }
  appendCodeEvalReceipt(ctx.paths.evidence, receipt, ctx);
  // persisted status validates the fsynced receipt, then clears the stale marker.
  const after = persistedCodeEvalStatus(ctx.paths.evidence, ctx);
  return { ...publicPlan(ctx.campaign, ctx.execution, ctx.cell, after), ok: receipt.standing !== 'unknown',
    state: after.state, standing: receipt.standing, receiptId: receipt.receiptId, providerCallsMade: receipt.economics.providerCalls,
    outcome: receipt.outcome.status };
}

async function ownedProcessesDead(marker, paths) {
  const match = /^pid-(\d+)$/.exec(marker.supervisorIdentity);
  if (!match) return false;
  const pid = Number(match[1]);
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error?.code !== 'ESRCH') return false; }
  try {
    const status = await codeRunStatus(join(paths.dir, 'runs', marker.buildRunId));
    return status.owned === false;
  } catch (error) {
    // A crash immediately after marker fsync can precede Build checkpoint creation.
    return error?.code === 'ENOENT';
  }
}

function processIdentityDead(identity) {
  const match = /^pid-(\d+)$/.exec(identity ?? '');
  if (!match) return false;
  try { process.kill(Number(match[1]), 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

export async function recoverCodeEval({ campaignPath, statePath, ledgerPath, action }, dependencies = {}) {
  if (action !== 'seal-infra') throw new Error('v1a recovery supports only seal-infra and never calls a provider.');
  const ctx = await contextFor({ campaignPath, statePath, ledgerPath });
  const lockRecovery = await recoverAbandonedCodeEvalEvidenceLock(ctx.paths.evidence, {
    ownerDead: lock => (dependencies.lockOwnerDead ?? ((value) => processIdentityDead(value.owner)))(lock),
  });
  const before = persistedCodeEvalStatus(ctx.paths.evidence, ctx);
  if (before.state === 'pending') return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: null, action: lockRecovery.action === 'stale_lock_cleared' ? 'stale_lock_cleared_no_attempt' : 'nothing_to_recover',
    receiptId: null, standing: null, outcome: null, replayAllowed: false, canAttempt: true };
  if (before.state === 'complete') {
    const receipt = loadCodeEvalReceipts(ctx.paths.evidence, ctx)[0];
    return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
      observedProviderCalls: receipt?.economics?.providerCalls ?? null,
      action: before.staleMarkerCleared ? 'stale_marker_cleared' : 'already_terminal',
      receiptId: receipt.receiptId, standing: receipt.standing, outcome: receipt.outcome.status, replayAllowed: false };
  }
  const recovered = await recoverCodeEvalCell(ctx.paths.evidence, ctx, {
    processesDead: marker => (dependencies.processesDead ?? ownedProcessesDead)(marker, ctx.paths.evidence),
  });
  return { ok: true, providerCallsMade: 0, providerCallsMadeThisInvocation: 0,
    observedProviderCalls: recovered.receipt.economics.providerCalls,
    action: recovered.action, receiptId: recovered.receipt.receiptId,
    standing: recovered.receipt.standing, outcome: recovered.receipt.outcome.status, replayAllowed: false };
}
