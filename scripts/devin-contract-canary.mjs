// Fresh explicit authorization only. This script never replays an old canary.
import { open, mkdir, mkdtemp, realpath, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareCodeExecution } from '../apps/loop-studio/lib/code-seat-launch.mjs';
import { runCodeSeats, prepareCodeReceiptsDir } from '../apps/loop-studio/lib/code-seats.mjs';
import { createCodeVerifier } from '../apps/loop-studio/lib/code-seat-verify.mjs';
import { runNativeDevin } from '../apps/loop-studio/lib/adapters/devin-native.mjs';
import { CodexRpc } from '../apps/loop-studio/lib/codex-rpc.mjs';
import { startDevinMcp } from '../apps/loop-studio/lib/devin-native-mcp.mjs';

const id = process.argv[2]?.match(/^--authorize-id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/)?.[1];
if (!id || process.argv.length !== 4 || process.argv[3] !== '--accept-unknown-spend')
  throw new Error('Requires fresh explicit consent: --authorize-id=<uuid> --accept-unknown-spend. No prior authorization may be reused.');

const evidence = join(homedir(), '.camus', 'canaries', `devin-contract-${id}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const limits = { maxCalls: 2, maxSteps: 1, maxActions: 40, maxTokens: 131072, timeoutMs: 300000,
  callTimeoutMs: 300000, maxRetries: 0, maxRepairs: 0, maxRecoveries: 0, idleTimeoutMs: 0 };
const marker = await open(join(evidence, 'authorization-consumed.json'), 'wx', 0o600);
try {
  await marker.writeFile(JSON.stringify({ id, limits, maxSwePrompts: 1, maxLunaReviews: 1, billingUncertaintyAccepted: true,
    apiFallback: false, replay: false, publication: false,
    driverHash: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') }));
  await marker.sync();
} finally { await marker.close(); }

async function requireReviewerSubscription() {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 524288 || (stat.mode & 0o022))
    throw new Error('Reviewer subscription login cannot be verified.');
  const bytes = await readFile(path);
  try {
    const auth = JSON.parse(bytes.toString('utf8'));
    if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || !auth.tokens?.access_token)
      throw new Error('Reviewer requires subscription login without API fallback.');
  } finally { bytes.fill(0); }
}

let prompts = 0, reviews = 0;
const channels = { acpReads: 0, acpCreatedReads: 0, mcpCreatedReads: 0, acpCreates: 0, acpEdits: 0, mcpWriteAttempts: 0 };
const control = new AbortController(), started = Date.now();
const cancel = () => control.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const timer = setTimeout(() => control.abort(), limits.timeoutMs);
try {
  await requireReviewerSubscription();
  const prepared = await prepareCodeExecution({ maker: { backend: 'devin', model: 'swe-2-high',
    codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' },
    reviewer: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' } });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-contract-')));
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'calc.mjs'), 'export const add=(a,b)=>a-b;\n');
  await writeFile(join(source, 'README.md'), 'Synthetic fixture. Fix calc.mjs and create nested/label.mjs.\n');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', 'calc.mjs', 'README.md');
  git('-c', 'user.name=Canary Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable baseline');
  const verifierPath = join(root, 'verify.mjs');
  await writeFile(verifierPath, `import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const {add}=await import(pathToFileURL(join(process.cwd(),'calc.mjs')));
const {label}=await import(pathToFileURL(join(process.cwd(),'nested/label.mjs')));
assert.equal(add(2,3),5);assert.equal(add(-4,1),-3);assert.equal(label,'ready');console.log('canary verified');\n`, { mode: 0o600 });
  const receiptsDir = await prepareCodeReceiptsDir(join(evidence, 'run'), source);
  const verify = createCodeVerifier(`${process.execPath} ${verifierPath}`, { receiptsDir, timeoutMs: 15000, repeatable: false });
  const task = 'Fix calc.mjs to add its arguments using the native edit tool. Create nested/label.mjs exporting const label="ready" using the native write tool. Read back the created file through ACP or Camus read_file. Preserve README.md; no other paths may change. This canary tests native writes after checked permission, not an MCP-write workaround. No install, commits, network or publication. Return the requested JSON when ready; the host runs a frozen verifier and independent review.';
  const metadata = { id: 'run', codeMode: 'independent', lane: 'build', task, goal: task, acceptanceContract: task,
    targetPath: source, models: prepared.models, startedAt: started, experimental: true, gating: false,
    verifyCmd: `${process.execPath} ${verifierPath}`, verifyRepeatable: false, codeLimits: limits };
  await writeFile(join(receiptsDir, 'run.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
  const result = await runCodeSeats({ repoPath: source, receiptsDir, task, limits, verify,
    seats: prepared.models, backendSnapshot: prepared.frozenBackends, authorize: prepared.authorize, signal: control.signal,
    adapters: { ...prepared.adapters,
      nativeMaker: async options => {
        if (++prompts > 1) throw new Error('Canary maker allowance consumed.');
        return runNativeDevin(options, {
          startBroker: options => startDevinMcp({ ...options, tools: options.tools.map(tool => tool.name !== 'read_file' ? tool : { ...tool,
            invoke: async args => {
              const result = await tool.invoke(args);
              const value = JSON.parse(result);
              if (args.path === 'nested/label.mjs' && typeof value.content === 'string' && typeof value.sha256 === 'string') channels.mcpCreatedReads++;
              return result;
            } }), onCall: event => {
            if (event.tool === 'write_file') channels.mcpWriteAttempts++;
            options.onCall(event);
          } }),
          rpcFactory: callbacks => new CodexRpc({ ...callbacks,
          onRequest: async (method, params) => {
            const result = await callbacks.onRequest(method, params);
            if (method === 'fs/read_text_file') {
              channels.acpReads++;
              if (params.path.endsWith('/nested/label.mjs')) channels.acpCreatedReads++;
            }
            if (method === 'fs/write_text_file') {
              if (params.path.endsWith('/nested/label.mjs')) channels.acpCreates++;
              if (params.path.endsWith('/calc.mjs')) channels.acpEdits++;
            }
            return result;
          } }) });
      },
      reviewer: async options => {
        if (++reviews > 1) throw new Error('Canary review allowance consumed.');
        await requireReviewerSubscription(); return prepared.adapters.reviewer(options);
      },
    } });
  await writeFile(join(receiptsDir, 'report.json'), JSON.stringify({ ...metadata, ...result }), { flag: 'wx', mode: 0o600 });
  const nativeResults = (await readdir(receiptsDir)).filter(name => /^devin-result-[a-f0-9]{64}\.json$/.test(name));
  const writeEvidence = nativeResults.length === 1 ? JSON.parse(await readFile(join(receiptsDir, nativeResults[0]), 'utf8')).writeEvidence : null;
  const approvedPaths = new Set(writeEvidence?.writes?.map(item => item.path) ?? []);
  const sourceUnchanged = git('status', '--porcelain').trim() === '';
  const changed = result.candidate?.worktree ? [...new Set([
    execFileSync('git', ['-C', result.candidate.worktree, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8' }),
    execFileSync('git', ['-C', result.candidate.worktree, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }),
  ].join('\n').split('\n').filter(Boolean))].sort() : [];
  const passed = result.completion === 'candidate_ready_for_acceptance' && result.verification?.pass === true
    && result.review?.verdict === 'APPROVED' && prompts === 1 && reviews === 1 && sourceUnchanged
    && channels.acpCreatedReads + channels.mcpCreatedReads > 0 && channels.acpEdits === 0 && channels.mcpWriteAttempts === 0
    && writeEvidence?.policy === 'contained-native/v1' && writeEvidence.verifiedAfterCleanup === true
    && approvedPaths.has('calc.mjs') && approvedPaths.has('nested/label.mjs')
    && JSON.stringify(changed) === JSON.stringify(['calc.mjs', 'nested/label.mjs'])
    && result.usage.calls <= 2 && result.usage.actions <= 40 && result.usage.accountedTokens <= 131072 && Date.now() - started <= 300000;
  const summary = { id, passed, prompts, reviews, channels, writeEvidence, sourceUnchanged, changed, usage: result.usage,
    completion: result.completion, elapsedMs: Date.now() - started, liveEvidence: 'bounded_contained_native_canary_only',
    inferenceSpend: 'unknown', publication: false, replayAllowed: false };
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(summary)); process.exitCode = passed ? 0 : 2;
} catch {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ id, prompts, reviews, channels, elapsedMs: Date.now() - started,
    passed: false, replayAllowed: false, diagnostic: 'Canary failed; inspect private run evidence.' }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: false, prompts, reviews, replayAllowed: false })); process.exitCode = 2;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
