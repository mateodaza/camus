import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeSeats } from './code-seats.mjs';
import { readCodeCheckpoint, saveCodeCheckpoint } from './code-run-state.mjs';
import { nativeUsage } from './adapters/codex-native.mjs';
import { validateCodeExecutor } from './code-native-policy.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const session = { version: 'codex-native/v1', threadId: '01900000-0000-7000-8000-000000000001', policyHash: 'fixture', usageTotal: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, totalTokens: 15 } };
const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, total_tokens: 15 };
const done = () => ({ ok: true, definitiveTurnEnd: true, text: JSON.stringify({ actions: [], done: true, summary: 'Ready for host verification.' }), usage, nativeSession: session, modelActual: 'openai:fixture' });
async function fixture(t, nativeMaker, reviewer = async () => ({ ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-native-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, 'repo'), receiptsDir = join(root, 'run');
  await mkdir(repoPath); await mkdir(receiptsDir);
  await writeFile(join(repoPath, 'README.md'), 'Fixture repository.\n');
  git(repoPath, 'init', '-q'); git(repoPath, 'config', 'user.email', 'test@example.invalid'); git(repoPath, 'config', 'user.name', 'Test');
  git(repoPath, 'add', '.'); git(repoPath, 'commit', '-qm', 'base');
  const options = { repoPath, receiptsDir, task: 'Write answer.txt correctly and preserve the acceptance contract.',
    seats: { maker: { backend: 'codex', model: 'fixture', codeExecutor: 'codex_native' }, reviewer: { backend: 'claude', model: 'fixture-review' } },
    backendSnapshot: { maker: { kind: 'codex_cli', transport: 'vendor_managed', provider: 'openai' }, reviewer: { kind: 'claude_cli', transport: 'vendor_managed', provider: 'anthropic' } },
    adapters: { maker: () => { throw new Error('File-action fallback must never run.'); }, nativeMaker, reviewer },
    limits: { maxTokens: 1000000 },
  };
  return { options, run: more => runCodeSeats({ ...options, ...more }), checkpoint: () => readCodeCheckpoint(receiptsDir) };
}

test('native edits use a private clone, live accounting, host verification and fresh advisory review', async t => {
  let turns = 0, reviews = 0;
  const f = await fixture(t, async args => {
    turns++;
    if (turns === 2) { assert.equal(args.nativeSession.threadId, session.threadId); assert.match(args.prompt, /incorrect/); }
    args.onNativeSession(session);
    args.onNativeProgress({ usage, responses: 1, actions: 1 });
    await writeFile(join(args.worktree, 'answer.txt'), turns === 1 ? 'wrong' : 'correct');
    return done();
  }, async ({ prompt }) => { reviews++; assert.match(prompt, /Host-selected current changed files/); assert.match(prompt, /correct/); return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; });
  const verify = async ({ worktree }) => ({ ran: true, pass: await readFile(join(worktree, 'answer.txt'), 'utf8') === 'correct', exitCode: 1,
    diagnostics: { message: 'incorrect answer', classification: 'check_failure' } });
  verify.command = 'fixture'; verify.repeatable = true;
  const result = await f.run({ verify });
  assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
  assert.equal(turns, 2); assert.equal(reviews, 1); assert.equal(result.usage.repairs, 1);
  assert.equal(result.usage.observedTokens, 35); assert.equal(result.usage.accountedTokens, 35);
  assert.equal(result.usage.actions, 2); assert.equal(result.reviewBinding, result.candidate.fingerprint);
  assert.equal(git(result.candidate.worktree, 'rev-parse', '--git-common-dir'), '.git');
  assert.equal(git(f.options.repoPath, 'status', '--porcelain'), '');
});

test('completed native response survives stop/resume without replaying tools', async t => {
  const control = new AbortController(); let calls = 0;
  const f = await fixture(t, async args => { calls++; args.onNativeSession(session); await writeFile(join(args.worktree, 'answer.txt'), 'correct'); control.abort(); return done(); });
  const first = await f.run({ signal: control.signal });
  assert.equal(first.status, 'stopped');
  const resumed = await f.run({ resume: true });
  assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error); assert.equal(calls, 1);
});

test('definitive budget interruption preserves the same session and candidate for explicit continuation', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++; args.onNativeSession(session); await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return calls === 1 ? { ok: false, definitiveTurnEnd: true, interrupted: true, stopKind: 'budget', error: 'Native budget reached.', usage, nativeSession: session } : done();
  });
  const first = await f.run(); assert.equal(first.question.kind, 'budget');
  const resumed = await f.run({ resume: true });
  assert.equal(resumed.candidate.worktree, first.candidate.worktree);
  assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error);
});

test('hard-crash native writes never silently become an authorized candidate on retry', async t => {
  let calls = 0;
  const f = await fixture(t, async args => { calls++; await writeFile(join(args.worktree, 'answer.txt'), 'unfinished'); return { ok: false, uncertain: true, usage }; });
  const first = await f.run(); assert.equal(first.resumable, false); assert.equal(first.candidate.fingerprint, null);
  const checkpoint = await f.checkpoint(); checkpoint.phase = 'make'; checkpoint.status = 'running';
  saveCodeCheckpoint(f.options.receiptsDir, checkpoint); // force the actual crash window
  const resumed = await f.run({ resume: true, retryUncertain: true });
  assert.match(resumed.error, /automatic adoption or replay is refused/); assert.equal(calls, 1);
  assert.equal(resumed.candidate.fingerprint, null);
});

test('native live accounting charges separate model responses without double-counting usage', async t => {
  const f = await fixture(t, async args => {
    args.onNativeProgress({ usage, responses: 1, actions: 1 });
    args.onNativeProgress({ usage: { ...usage, total_tokens: 30 }, responses: 2, actions: 1 });
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return { ...done(), usage: { total_tokens: 30 } };
  });
  const result = await f.run();
  assert.equal(result.usage.calls, 3); assert.equal(result.usage.observedTokens, 35); assert.equal(result.usage.accountedTokens, 35);
});

test('native preflight failure records no model call and never falls back', async t => {
  const f = await fixture(t, async () => ({ ok: false, noModelCalled: true, error: 'Preflight failed.', usage: { total_tokens: 0 } }));
  const result = await f.run(); assert.equal(result.usage.calls, 0); assert.equal(result.usage.accountedTokens, 0); assert.match(result.error, /Preflight/);
});

test('cancellation before native generation does not reserve fictitious spend', async t => {
  const controller = new AbortController();
  const f = await fixture(t, async () => { controller.abort(); return { ok: false, noModelCalled: true, error: 'Cancelled during preflight.', usage: { total_tokens: 0 } }; });
  const result = await f.run({ signal: controller.signal }); assert.equal(result.status, 'stopped');
  assert.equal(result.usage.calls, 0); assert.equal(result.usage.accountedTokens, 0); assert.equal(result.usage.unmeasuredCalls, 0);
});

test('unverified native transport cleanup refuses replay and candidate adoption', async t => {
  const f = await fixture(t, async () => { throw new Error('Native process cleanup could not be verified.'); });
  const result = await f.run(); assert.equal(result.resumable, false); assert.equal(result.candidate.fingerprint, null);
  assert.match(result.error, /uncertain/);
});

test('native execution requires a positive budget and an exact supported backend', async t => {
  const f = await fixture(t, async () => { throw new Error('must not run'); });
  const result = await f.run({ limits: { maxTokens: 0 } }); assert.match(result.error, /positive token budget/);
  assert.throws(() => validateCodeExecutor({ backend: 'custom', codeExecutor: 'codex_native' }, { kind: 'codex_cli', transport: 'loopback' }), /built-in/);
  assert.throws(() => validateCodeExecutor({ backend: 'codex', codeExecutor: 'codex_native' }, { kind: 'codex_cli', transport: 'vendor_managed' }, 'reviewer'), /maker/);
  assert.doesNotThrow(() => validateCodeExecutor({ backend: 'custom', codeExecutor: 'qwen_native' }, { kind: 'openai_compat', transport: 'direct_https' }));
  assert.doesNotThrow(() => validateCodeExecutor({ backend: 'remote', codeExecutor: 'grok_native' }, { kind: 'openai_compat', transport: 'ssh_tunnel' }));
  assert.throws(() => validateCodeExecutor({ backend: 'claude', codeExecutor: 'qwen_native' }, { kind: 'claude_cli', transport: 'vendor_managed' }), /OpenAI-compatible/);
});

test('native usage keeps cached input separate and refuses regressions', () => {
  assert.deepEqual(nativeUsage(session.usageTotal), usage);
  assert.throws(() => nativeUsage({ ...session.usageTotal, cachedInputTokens: 20 }), /Inconsistent/);
  assert.throws(() => nativeUsage(session.usageTotal, { ...session.usageTotal, inputTokens: 11 }), /Invalid/);
});

test('native ignored output is refused rather than disappearing from the reviewed candidate', async t => {
  let reviews = 0;
  const f = await fixture(t, async args => {
    await writeFile(join(args.worktree, '.gitignore'), 'hidden.txt\n');
    await writeFile(join(args.worktree, 'hidden.txt'), 'not reviewed');
    return done();
  }, async () => { reviews++; throw new Error('must not review'); });
  const result = await f.run(); assert.match(result.error, /ignored files/);
  assert.equal(result.candidate.fingerprint, null); assert.equal(reviews, 0);
});

test('native protected source and Git identity changes cannot be adopted', async t => {
  for (const edit of [
    args => writeFile(join(args.worktree, '.env'), 'fixture-only'),
    args => { git(args.worktree, 'checkout', '-b', 'unexpected'); },
  ]) {
    const f = await fixture(t, async args => { await edit(args); return done(); });
    const result = await f.run(); assert.equal(result.status, 'infra_error'); assert.equal(result.candidate.fingerprint, null);
    assert.equal(result.completion, null);
  }
});
