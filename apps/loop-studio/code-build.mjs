#!/usr/bin/env node
// The npm CLI and Studio Build use the same execution and seat-selection code.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareCodeExecution, codeModelChoices } from './lib/code-seat-launch.mjs';
import { createCodeVerifier } from './lib/code-seat-verify.mjs';
import { runCodeSeats, prepareCodeReceiptsDir } from './lib/code-seats.mjs';
import { studioAtomicWrite } from './lib/grandfather.mjs';
import { codeRunStatus, readCodeCheckpoint, requestCodeStop } from './lib/code-run-state.mjs';
import { codeRunDirectory, readCodeRunMetadata, inspectCodeRun, formatCodeInspection } from './lib/code-session.mjs';
import { configureCodeBackend, qualifyCodeSeat } from './lib/code-setup.mjs';
import { redactCodeText, diagnosticSecrets } from './lib/code-diagnostics.mjs';
import { getSharedTunnelManager } from './lib/ssh-tunnel.mjs';
import { NATIVE_EXECUTORS, NATIVE_MIN_TOKEN_BUDGET, isNativeExecutor } from './lib/code-native-policy.mjs';

export const HELP = `camus build — independent maker/reviewer coding (experimental)

  camus build --models [--json]  # model qualification + spend-free native readiness
  camus build --task "..." --contract "..." [--repo /path/to/repo]
      --maker <backend>:<model> --reviewer <backend>:<model>
      [--maker-effort low|medium|high|xhigh] [--reviewer-effort ...]
      [--maker-executor file_actions|codex_native|qwen_native|grok_native]
      [--verify "npm test" --verify-repeatable] [--json]
      [--max-calls 32] [--max-steps 12] [--max-actions 32]
      [--max-repairs 2] [--max-retries 1] [--max-tokens 1000000]
      [--timeout-ms 1200000] [--call-timeout-ms 600000] [--idle-timeout-ms 0]
  camus build --status <run-id> [--json]
  camus build --inspect <run-id> [--json]
  camus build --stop <run-id>
  camus build --resume <run-id> [budget extensions] [--json]
      [--answer "..." --question <question-id>]
      [--retry-uncertain] [--retry-verification]
  camus build --setup /path/to/connection-backend.json [--replace]
  camus build --qualify <backend>:<model> --role maker|reviewer
      --allow-provider-calls
  Use --task-file and --contract-file for longer briefs.

Both roles use Studio's configured catalog, credentials and connections.
Setup uses Studio's connection/backend schema with env-var references, not keys.
Qualification requires explicit paid-call consent; models/status/inspect/setup are offline.
CLI and Studio share ~/.camus/studio/runs (or STUDIO_RUNS_DIR). Historical runs
without a checkpoint remain inspect-only. Inspect authenticates one bounded
read-only projection and never starts a worker, provider, verifier, or Git action.
Resume never changes the frozen pair,
contract or verifier. Budget extensions do not reset usage. --max-tokens is a
pre-call reservation budget, NOT a provider-enforced billing limit; missing usage
is conservatively reserved, not claimed as measured.
Changes stay in a separate worktree. Review is advisory, not an admitted gate.
The command never commits, merges, pushes, or publishes. Inspect and accept
the candidate yourself. A missing --verify is explicitly not tested.
--verify executes your command locally with credential env scrubbed, NOT an
OS sandbox: run it only on projects/code you trust. --verify-repeatable explicitly
authorizes repeated checks, including crash recovery. Without it, a second check
needs --retry-verification. --retry-uncertain can cause duplicate provider billing.
Provider calls may cost. Inactivity detection is off by default; silence alone
does not prove a long-running model is stuck.
Native execution is opt-in and maker-only. Codex Native uses the built-in Codex
backend and existing ChatGPT CLI login. Qwen Code/Grok Build use a qualified
OpenAI-compatible maker through a host-owned one-model credential gateway; the
real provider key never enters the harness. They currently require macOS and the
pinned CLI version. Every native executor requires --max-tokens of at least
${NATIVE_MIN_TOKEN_BUDGET} so the first conservative call reservation fits.
Tools cannot read Git/Camus private state or use arbitrary network. Completed
turns can resume; uncertain native writes cannot auto-replay.
Legacy camus run and /camus-feat retain their existing Claude/Codex gate.
`;

export function parseCodeBuildArgs(argv) {
  const flags = new Set(['help', 'models', 'json', 'replace', 'allow-provider-calls', 'verify-repeatable', 'retry-uncertain', 'retry-verification']);
  const valued = new Set(['task', 'task-file', 'contract', 'contract-file', 'repo', 'maker', 'reviewer', 'maker-effort', 'reviewer-effort', 'maker-executor', 'verify',
    'status', 'inspect', 'stop', 'resume', 'answer', 'question', 'setup', 'qualify', 'role', ...Object.keys(LIMIT_FLAGS)]);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h') { options.help = true; continue; }
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || (!flags.has(name) && !valued.has(name))) throw new Error(`Unknown build option: ${argv[i]}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (flags.has(name)) options[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      options[name] = value;
    }
  }
  for (const key of ['task', 'contract']) if (options[key] && options[`${key}-file`]) throw new Error(`Choose --${key} OR --${key}-file.`);
  if (['models', 'setup', 'qualify', 'status', 'inspect', 'stop', 'resume'].filter((key) => options[key]).length > 1) throw new Error('Choose one build operation.');
  if (options.inspect && Object.keys(options).some((key) => !['inspect', 'json'].includes(key))) {
    throw new Error('--inspect is an offline read-only operation and may be combined only with --json.');
  }
  if (Boolean(options.answer) !== Boolean(options.question) || (options.answer || options['retry-uncertain'] || options['retry-verification']) && !options.resume) throw new Error('Answers/retry authorization require --resume; an answer also requires --question.');
  if (options.resume && ['task', 'task-file', 'contract', 'contract-file', 'repo', 'maker', 'reviewer', 'maker-effort', 'reviewer-effort', 'maker-executor', 'verify', 'verify-repeatable'].some((key) => options[key])) throw new Error('Resume cannot change the frozen contract, repository, pair, executor or verifier.');
  if (options['maker-executor']) {
    if (!['file_actions', ...NATIVE_EXECUTORS].includes(options['maker-executor'])) throw new Error(`--maker-executor must be file_actions, ${NATIVE_EXECUTORS.join(', ')}.`);
    if (['models', 'setup', 'qualify', 'status', 'inspect', 'stop'].some(key => options[key]) || !options.maker || !options.reviewer) throw new Error('--maker-executor requires a new build with explicit --maker and --reviewer.');
    if (isNativeExecutor(options['maker-executor']) && (!/^\d+$/.test(options['max-tokens'] ?? '') || Number(options['max-tokens']) < NATIVE_MIN_TOKEN_BUDGET)) {
      throw new Error(`Native execution requires --max-tokens of at least ${NATIVE_MIN_TOKEN_BUDGET} so the first call reservation fits.`);
    }
  }
  return options;
}

const LIMIT_FLAGS = { 'max-calls': 'maxCalls', 'max-steps': 'maxSteps', 'max-actions': 'maxActions', 'max-repairs': 'maxRepairs', 'max-retries': 'maxRetries', 'max-tokens': 'maxTokens', 'timeout-ms': 'timeoutMs', 'call-timeout-ms': 'callTimeoutMs', 'idle-timeout-ms': 'idleTimeoutMs' };
export function parseCodeLimits(options) {
  const limits = {};
  for (const [flag, key] of Object.entries(LIMIT_FLAGS)) if (options[flag] !== undefined) {
    if (!/^\d+$/.test(options[flag])) throw new Error(`--${flag} needs a nonnegative integer.`);
    limits[key] = Number(options[flag]);
  }
  return limits;
}

export function parseCodeSeat(value) {
  const colon = value.indexOf(':');
  if (colon < 1 || colon === value.length - 1) throw new Error('A seat must be backend:model.');
  return { backend: value.slice(0, colon), model: value.slice(colon + 1) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCodeBuildArgs(argv);
  if (options.help || argv.length === 0) { console.log(HELP); return 0; }
  if (options.inspect) {
    const result = await inspectCodeRun(codeRunDirectory(options.inspect));
    console.log(options.json ? JSON.stringify(result, null, 2) : formatCodeInspection(result));
    return 0;
  }
  if (options.setup) {
    const raw = await readFile(resolve(options.setup), 'utf8');
    if (raw.length > 256_000) throw new Error('Setup file too large.');
    let config;
    try { config = JSON.parse(raw); } catch { throw new Error('Setup file must contain valid JSON; its private contents were omitted.'); }
    console.log(JSON.stringify(configureCodeBackend(config, { replace: options.replace === true }), null, 2)); return 0;
  }
  if (options.qualify) {
    const result = await qualifyCodeSeat({ ...parseCodeSeat(options.qualify), role: options.role, consent: options['allow-provider-calls'] === true,
      onProgress: (event) => { if (!options.json) console.error(`Qualification: ${redactCodeText(event.phase ?? event.stage ?? 'working')}`); } });
    console.log(JSON.stringify(result, null, 2)); return result.qualified ? 0 : 1;
  }
  if (options.status || options.stop) {
    const dir = codeRunDirectory(options.status || options.stop);
    await readCodeRunMetadata(dir);
    const result = options.stop ? await requestCodeStop(dir) : await codeRunStatus(dir);
    console.log(JSON.stringify(result, null, 2)); return 0;
  }
  if (options.models) {
    const catalog = await codeModelChoices();
    if (options.json) console.log(JSON.stringify(catalog, null, 2));
    else {
      console.log('native harnesses (offline; no model call):');
      for (const harness of Object.values(catalog.nativeHarnesses)) {
        console.log(`  ${harness.executor} — ${harness.status}: ${harness.detail}`);
        if (harness.remedy) console.log(`    fix: ${harness.remedy}`);
      }
      for (const role of ['maker', 'reviewer']) {
        console.log(`${role}:`);
        for (const seat of catalog[role]) console.log(`  ${seat.backend}:${seat.model} — model ${seat.modelQualification.qualified ? 'qualified' : `not qualified (${seat.modelQualification.status})`}${seat.codeExecutors.some(executor => executor !== 'file_actions') ? `; ready executors ${seat.codeExecutors.join(', ')}` : ''}`);
      }
    }
    return 0;
  }
  const content = async (name) => options[`${name}-file`]
    ? readFile(resolve(options[`${name}-file`]), 'utf8') : options[name];
  const existingDir = options.resume ? codeRunDirectory(options.resume) : null;
  const existing = existingDir ? await readCodeRunMetadata(existingDir) : null;
  if (existingDir) await readCodeCheckpoint(existingDir); // no backfilled legacy checkpoint
  const task = existing ? existing.goal ?? existing.task : await content('task');
  const contract = existing ? existing.acceptanceContract : await content('contract');
  if (typeof task !== 'string' || task.trim().length < 12 || typeof contract !== 'string' || contract.trim().length < 12) throw new Error('Provide a task and acceptance contract (at least 12 characters each).');
  if (task.length + contract.length > 50_000) throw new Error('The task and contract exceed 50,000 characters.');
  if (Boolean(options.maker) !== Boolean(options.reviewer)) throw new Error('Specify both --maker and --reviewer, or neither to use saved Studio choices.');
  if (!options.maker && (options['maker-effort'] || options['reviewer-effort'])) throw new Error('Effort overrides require explicit --maker and --reviewer.');
  const pairing = existing ? existing.models : options.maker ? {
    maker: { ...parseCodeSeat(options.maker), ...(options['maker-effort'] ? { effort: options['maker-effort'] } : {}), ...(options['maker-executor'] ? { codeExecutor: options['maker-executor'] } : {}) },
    reviewer: { ...parseCodeSeat(options.reviewer), ...(options['reviewer-effort'] ? { effort: options['reviewer-effort'] } : {}) },
  } : null;
  let repoPath;
  try { repoPath = execFileSync('git', ['-C', resolve(existing?.targetPath || options.repo || process.cwd()), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { throw new Error('Choose a path inside an existing Git repository.'); }
  const prepared = await prepareCodeExecution(pairing, { preserveAbsentEffort: Boolean(existing) });
  const limits = parseCodeLimits(options);
  if (!existing && isNativeExecutor(prepared.models.maker.codeExecutor)
      && (options['max-tokens'] === undefined || limits.maxTokens < NATIVE_MIN_TOKEN_BUDGET)) {
    throw new Error(`Native execution requires --max-tokens of at least ${NATIVE_MIN_TOKEN_BUDGET} so the first call reservation fits.`);
  }
  const id = options.resume || `code-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const receiptsDir = await prepareCodeReceiptsDir(codeRunDirectory(id), repoPath);
  const metadata = existing || { id, codeMode: 'independent', lane: 'build', task, goal: task, acceptanceContract: contract,
    targetPath: repoPath, models: prepared.models, startedAt: Date.now(), experimental: true, gating: false,
    verifyCmd: options.verify ?? null, verifyRepeatable: options['verify-repeatable'] === true, codeLimits: limits };
  if (!existing) studioAtomicWrite(join(receiptsDir, 'run.json'), JSON.stringify(metadata, null, 2), 0o600);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let writes = Promise.resolve();
  let receiptError = false;
  const onEvent = (event) => {
    writes = writes.then(() => appendFile(join(receiptsDir, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, { mode: 0o600 }))
      .catch(() => { receiptError = true; });
    if (!options.json && event?.stage) console.error(`camus build: ${event.stage}`);
  };
  try {
    const result = await runCodeSeats({
      repoPath: metadata.targetPath, task: `${task}\n\nAcceptance contract (binding):\n${contract}`,
      seats: prepared.models, adapters: prepared.adapters, backendSnapshot: prepared.frozenBackends,
      receiptsDir, signal: controller.signal, onEvent,
      verify: createCodeVerifier(metadata.verifyCmd, { receiptsDir, repeatable: metadata.verifyRepeatable === true }),
      limits, resume: Boolean(existing), authorize: prepared.authorize,
      answer: options.answer ? { id: options.question, text: options.answer } : null,
      retryUncertain: options['retry-uncertain'] === true, retryVerification: options['retry-verification'] === true,
    });
    await writes;
    const report = { ...metadata, ...result, endedAt: Date.now(), receiptsDegraded: receiptError };
    const serialized = JSON.stringify(report, null, 2);
    const timestampedReport = join(receiptsDir, `report-${Date.now()}.json`);
    const canonicalReport = join(receiptsDir, 'report.json');
    studioAtomicWrite(timestampedReport, serialized, 0o600);
    if (!result.stateUnchanged) studioAtomicWrite(canonicalReport, serialized, 0o600);
    const receiptPath = result.stateUnchanged ? timestampedReport : canonicalReport;
    if (options.json) console.log(JSON.stringify({ ...report, receiptPath }, null, 2));
    else {
      console.log(`Run: ${id}`);
      console.log(`Status: ${result.status}. Experimental advisory review; human acceptance required.`);
      if (result.candidate?.worktree) console.log(`Candidate: ${result.candidate.worktree}`);
      if (result.error) console.log(`Reason: ${result.error}`);
      if (result.question) console.log(`Question ${result.question.id}: ${result.question.text}`);
      if (result.resumable) console.log(`Continue: camus build --resume ${id} (same candidate; current usage retained)`);
      console.log(`Receipt: ${receiptPath}`);
    }
    // A human checkpoint is not an unattended/CI success.
    return ['needs_human', 'needs_decision'].includes(result.status) ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    // Provider adapters redact their own errors. Do not print raw response bodies
    // or a stack trace carrying local state on this boundary.
    console.error(`camus build: ${redactCodeText(error.message || error, { secrets: diagnosticSecrets() }).slice(0, 600)}`);
    process.exitCode = 1;
  }).finally(() => getSharedTunnelManager().close());
}
