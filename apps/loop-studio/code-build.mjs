#!/usr/bin/env node
// The npm CLI and Studio Build use the same execution and seat-selection code.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareCodeSeats, codeModelChoices } from './lib/code-seat-launch.mjs';
import { createCodeVerifier } from './lib/code-seat-verify.mjs';
import { runCodeSeats, prepareCodeReceiptsDir } from './lib/code-seats.mjs';
import { studioAtomicWrite } from './lib/grandfather.mjs';

export const HELP = `camus build — independent maker/reviewer coding (experimental)

  camus build --models [--json]
  camus build --task "..." --contract "..." [--repo /path/to/repo]
      --maker <backend>:<model> --reviewer <backend>:<model>
      [--maker-effort low|medium|high|xhigh] [--reviewer-effort ...]
      [--verify "npm test"] [--json]
  Use --task-file and --contract-file for longer briefs.

Both roles use Studio's configured catalog, credentials and connections.
Unqualified tuples must be qualified in Studio first; there is no fallback.
Changes stay in a separate worktree. Review is advisory, not an admitted gate.
The command never commits, merges, pushes, or publishes. Inspect and accept
the candidate yourself. A missing --verify is explicitly not tested.
--verify executes your command locally with credential env scrubbed, NOT an
OS sandbox: run it only on projects/code you trust. Provider calls may cost.
Legacy camus run and /camus-feat retain their existing Claude/Codex gate.
`;

export function parseCodeBuildArgs(argv) {
  const flags = new Set(['help', 'models', 'json']);
  const valued = new Set(['task', 'task-file', 'contract', 'contract-file', 'repo', 'maker', 'reviewer', 'maker-effort', 'reviewer-effort', 'verify']);
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
  return options;
}

export function parseCodeSeat(value) {
  const colon = value.indexOf(':');
  if (colon < 1 || colon === value.length - 1) throw new Error('A seat must be backend:model.');
  return { backend: value.slice(0, colon), model: value.slice(colon + 1) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCodeBuildArgs(argv);
  if (options.help || argv.length === 0) { console.log(HELP); return 0; }
  if (options.models) {
    const catalog = codeModelChoices();
    if (options.json) console.log(JSON.stringify(catalog, null, 2));
    else for (const role of ['maker', 'reviewer']) {
      console.log(`${role}:`);
      for (const seat of catalog[role]) console.log(`  ${seat.backend}:${seat.model} — ${seat.available ? 'available (advisory code loop)' : 'qualify in Studio first'}`);
    }
    return 0;
  }
  const content = async (name) => options[`${name}-file`]
    ? readFile(resolve(options[`${name}-file`]), 'utf8') : options[name];
  const task = await content('task');
  const contract = await content('contract');
  if (typeof task !== 'string' || task.trim().length < 12 || typeof contract !== 'string' || contract.trim().length < 12) throw new Error('Provide a task and acceptance contract (at least 12 characters each).');
  if (task.length + contract.length > 50_000) throw new Error('The task and contract exceed 50,000 characters.');
  if (Boolean(options.maker) !== Boolean(options.reviewer)) throw new Error('Specify both --maker and --reviewer, or neither to use saved Studio choices.');
  if (!options.maker && (options['maker-effort'] || options['reviewer-effort'])) throw new Error('Effort overrides require explicit --maker and --reviewer.');
  const pairing = options.maker ? {
    maker: { ...parseCodeSeat(options.maker), ...(options['maker-effort'] ? { effort: options['maker-effort'] } : {}) },
    reviewer: { ...parseCodeSeat(options.reviewer), ...(options['reviewer-effort'] ? { effort: options['reviewer-effort'] } : {}) },
  } : null;
  let repoPath;
  try { repoPath = execFileSync('git', ['-C', resolve(options.repo || process.cwd()), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch { throw new Error('Choose a path inside an existing Git repository.'); }
  const prepared = await prepareCodeSeats({ pairing });
  const id = `code-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const receiptsDir = await prepareCodeReceiptsDir(join(process.env.STUDIO_RUNS_DIR || join(homedir(), '.camus', 'studio', 'code-runs'), id), repoPath);
  const startedAt = Date.now();
  const metadata = { id, codeMode: 'independent', lane: 'build', task, acceptanceContract: contract,
    targetPath: repoPath, models: prepared.models, startedAt, experimental: true, gating: false };
  studioAtomicWrite(join(receiptsDir, 'run.json'), JSON.stringify(metadata, null, 2), 0o600);
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
      verify: createCodeVerifier(options.verify, { receiptsDir }),
    });
    await writes;
    const report = { ...metadata, ...result, endedAt: Date.now(), receiptsDegraded: receiptError };
    studioAtomicWrite(join(receiptsDir, 'report.json'), JSON.stringify(report, null, 2), 0o600);
    if (options.json) console.log(JSON.stringify({ ...report, receiptPath: join(receiptsDir, 'report.json') }, null, 2));
    else {
      console.log(`Status: ${result.status}. Experimental advisory review; human acceptance required.`);
      if (result.candidate?.worktree) console.log(`Candidate: ${result.candidate.worktree}`);
      if (result.error) console.log(`Reason: ${result.error}`);
      console.log(`Receipt: ${join(receiptsDir, 'report.json')}`);
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
    console.error(`camus build: ${String(error.message || error).slice(0, 600)}`);
    process.exitCode = 1;
  });
}
