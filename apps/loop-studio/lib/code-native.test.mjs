import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeSeats } from './code-seats.mjs';
import { nativeTrackedInventory } from './code-loop.mjs';
import { readCodeCheckpoint, saveCodeCheckpoint, digest } from './code-run-state.mjs';
import { nativeUsage } from './adapters/codex-native.mjs';
import { validateCodeExecutor } from './code-native-policy.mjs';
import { DEVIN_CODE_BACKEND } from './devin-code-seat.mjs';
import { codeRunStatus } from './code-run-state.mjs';
import { inspectCodeRun } from './code-session.mjs';
import { canResumeDevinPriorCandidate } from './code-native-prior-candidate.mjs';
import { DEVIN_NATIVE_DIGEST } from './devin-native-protocol.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const session = { version: 'codex-native/v1', threadId: '01900000-0000-7000-8000-000000000001', policyHash: 'fixture', usageTotal: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, totalTokens: 15 } };
const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, total_tokens: 15 };
const done = () => ({ ok: true, definitiveTurnEnd: true, text: JSON.stringify({ actions: [], done: true, summary: 'Ready for host verification.' }), usage, nativeSession: session, modelActual: 'openai:fixture' });

test('native tracked inventory is byte-bounded and reports omitted paths', () => {
  const tracked = Array.from({ length: 1000 }, (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(500)}`);
  const inventory = nativeTrackedInventory({ tracked });
  assert.ok(Buffer.byteLength(inventory) < 17 * 1024);
  assert.match(inventory, /\(\d+ of 1000\)/);
  assert.doesNotMatch(inventory, /0999-/);
});

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

test('SWE unknown inference usage reaches verification/review; later turns include created files without session replay', async t => {
  let turns = 0, reviews = 0;
  const f = await fixture(t, async args => {
    assert.equal(args.nativeSession, null);
    assert.equal(args.observedBudget.version, 'devin-observed/v1');
    assert.equal(args.observedBudget.billingUncertaintyAccepted, true);
    assert.equal(args.observedBudget.maxPrompts, 1);
    const allowance = turns === 0 ? 64 : 22;
    assert.equal(args.maxToolCalls, allowance);
    assert.match(args.prompt, new RegExp(`Action slice allowance/target: ${allowance};`));
    assert.match(args.prompt, /native tool events PLUS host operations/);
    assert.doesNotMatch(args.prompt, /Model-call slice target:/);
    assert.equal((await f.checkpoint()).pendingCall.dispatchPromptHash, digest(args.prompt));
    assert(args.sourceFiles.includes('README.md'));
    if (++turns === 2) assert(args.sourceFiles.includes('answer.txt'));
    args.onNativeSession({ executor: 'devin_native', sessionId: `s${turns}`, replayable: false });
    args.onNativeProgress({ usage: null, responses: 0, actions: turns === 1 ? 48 : 2 });
    await writeFile(join(args.worktree, 'answer.txt'), turns === 1 ? 'draft' : 'correct');
    return { ...done(), usage: null, usageIncomplete: true, nativeSession: undefined, modelActual: null,
      modelReported: 'swe-2-high', text: JSON.stringify({ actions: [], done: turns === 2, summary: 'Bounded progress.',
        decision: turns === 2 ? null : { action: 'continue', reason: 'Finish the saved draft.' } }) };
  }, async () => { reviews++; return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; });
  f.options.seats.maker = { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' };
  f.options.backendSnapshot.maker = DEVIN_CODE_BACKEND;
  f.options.limits.maxActions = 70;
  const verify = async ({ worktree }) => ({ ran: true, pass: (await readFile(join(worktree, 'answer.txt'), 'utf8')) === 'correct', exitCode: 0 });
  verify.command = 'offline fixture'; verify.repeatable = true;
  const result = await f.run({ verify });
  assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
  assert.equal(turns, 2); assert.equal(reviews, 1); assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.unmeasuredCalls, 2); assert.equal(result.usage.observedTokens, 5);
  assert.equal(result.budgetSemantics.internalModelCalls, null); assert.equal(result.budgetSemantics.totalInferenceTokens, null);
  assert.equal(git(f.options.repoPath, 'status', '--porcelain'), '');
});

test('SWE refuses missing consent before any maker and preserves uncertainty without automatic recovery', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: false, uncertain: true, candidateQuiescent: false, usage: null,
    failureCode: 'devin_native_incomplete', diagnostic: { stage: 'native_turn', reason: 'tool_failed', cleanupConfirmed: true } }; });
  f.options.seats.maker = { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native' };
  f.options.backendSnapshot.maker = DEVIN_CODE_BACKEND;
  assert.match((await f.run()).error, /SWE requires/); assert.equal(turns, 0);
  f.options.seats.maker.observedBudgetConsent = 'devin-observed/v1';
  const result = await f.run();
  assert.equal(turns, 1); assert.equal(result.resumable, false); assert.match(result.error, /uncertain/);
  assert.match(result.error, /devin_native_incomplete \(tool_failed\)/);
  assert.equal(result.review, null);
});

for (const mode of ['resume', 'drift', 'source_drift', 'ignored', 'authority', 'recovery_budget', 'call_budget', 'exec_resume', 'exec_cleanup', 'tight_call_cap', 'below_spent_cap']) test(`SWE refusal retains the accepted candidate: ${mode}`, async t => {
  let turns = 0, reviews = 0, verifies = 0;
  const f = await fixture(t, async args => {
    turns++;
    assert.equal(args.nativeSession, null);
    args.onNativeSession({ executor: 'devin_native', sessionId: `s${turns}`, replayable: false, artifactDigest: DEVIN_NATIVE_DIGEST });
    if (turns === 2) return { ok: false, uncertain: true, noModelCalled: false, usage: null,
      candidateQuiescent: false, failureCode: mode.startsWith('exec') ? 'devin_native_incomplete' : 'devin_native_refused',
      stagedDraft: { path: join(f.options.receiptsDir, 'refused-mirror'), adopted: false, replayAllowed: false },
      diagnostic: mode.startsWith('exec') ? { stage: 'native_turn', reason: 'tool_failed', terminalReceived: false,
        cleanupConfirmed: mode !== 'exec_cleanup', protocolStage: 'prompt', stopReason: null, rpcFailure: null, boundaryRefusal: null,
        toolFailures: [{ nativeTool: 'exec', categories: ['permission_denied'] }] }
        : { stage: 'decision_schema', terminalReceived: true, cleanupConfirmed: true,
        protocolStage: 'completion', stopReason: 'end_turn', reason: null, rpcFailure: null, boundaryRefusal: null } };
    if (turns === 3) {
      assert.equal(await readFile(join(args.worktree, 'answer.txt'), 'utf8'), 'accepted turn 1');
      assert.match(args.prompt, /later refused turn was NOT adopted/);
      assert.equal((await f.checkpoint()).retiredNativeCalls[0].id, 'maker-2');
    }
    await writeFile(join(args.worktree, 'answer.txt'), turns === 1 ? 'accepted turn 1' : 'finished');
    return { ...done(), nativeSession: undefined, text: JSON.stringify({ actions: [], done: turns === 3, summary: 'Progress',
      decision: turns === 1 ? { action: 'continue', reason: 'Finish task' } : null }) };
  }, async () => { reviews++; return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; });
  f.options.seats.maker = { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' };
  f.options.backendSnapshot.maker = DEVIN_CODE_BACKEND;
  f.options.limits.maxRecoveries = mode === 'recovery_budget' ? 0 : 1;
  f.options.limits.maxCalls = mode === 'call_budget' ? 2 : 4;
  const verify = async ({ worktree }) => { verifies++; return { ran: true, pass: await readFile(join(worktree, 'answer.txt'), 'utf8') === 'finished', exitCode: 0 }; };
  verify.command = 'offline fixture'; verify.repeatable = true; f.options.verify = verify;
  const first = await f.run();
  assert.equal(turns, 2); assert.equal(first.completion, null); assert.equal(reviews, 0); assert.equal(verifies, 0);
  const checkpoint = await f.checkpoint();
  assert.equal(checkpoint.candidate.snapshotStatus, 'verified_turn');
  if (mode === 'exec_cleanup') {
    assert.equal(first.resumable, false);
    const refused = await f.run({ resume: true });
    assert.match(refused.error, /already closed/); assert.equal(turns, 2);
    assert.equal((await f.checkpoint()).revision, checkpoint.revision);
    return;
  }
  if (mode === 'exec_resume') {
    for (const mutate of [s => { s.nativeSession.artifactDigest = 'unknown'; },
      s => { s.nativeSession.replayable = true; }, s => { s.pendingCall.response.diagnostic.rpcFailure = 'request_timeout'; },
      s => { s.pendingCall.response.diagnostic.toolFailures.push({ nativeTool: 'write', categories: ['unclassified'] }); }]) {
      const invalid = structuredClone(checkpoint); mutate(invalid); assert.equal(canResumeDevinPriorCandidate(invalid), false);
    }
  }
  assert.equal(first.resumable, true); assert.equal(first.candidate.fingerprint, checkpoint.candidate.fingerprint);
  if (mode === 'resume') {
    for (const mutate of [
      s => { s.pendingCall.response.diagnostic.cleanupConfirmed = false; },
      s => { s.pendingCall.response.diagnostic.stage = 'native_turn'; },
      s => { s.pendingCall.response.diagnostic.stage = 'staged_adoption'; },
      s => { s.pendingCall.response.diagnostic.stage = 'result_receipt'; },
      s => { s.pendingCall.response.diagnostic.stopReason = 'max_tokens'; },
      s => { s.pendingCall.response.diagnostic.boundaryRefusal = 'unsafe_tool'; },
      s => { s.pendingCall.response.diagnostic.terminalReceived = false; },
      s => { s.pendingCall.response.stagedDraft.adopted = true; },
      s => { s.pendingCall.response.stagedDraft = null; },
      s => { s.pendingCall.response = null; },
      s => { s.candidate.snapshotStatus = 'untrusted_recovery'; },
      s => { s.candidate.fingerprint = null; },
      s => { s.usage.steps = 0; },
      s => { s.nativeRecoveryPolicy = 'unknown'; },
      s => { s.makerProgressPolicy = 'unknown'; },
      s => { s.seats.maker.codeExecutor = 'grok_native'; },
      s => { s.seats.maker.observedBudgetConsent = null; },
      s => { s.verifierInFlight = true; },
      s => { s.pendingAction = {}; },
      s => { s.question = {}; },
    ]) {
      const invalid = structuredClone(checkpoint); mutate(invalid);
      assert.equal(canResumeDevinPriorCandidate(invalid), false, mutate.toString());
    }
  }
  await writeFile(join(f.options.receiptsDir, 'refused-mirror'), 'NEVER ADOPT THIS');
  await writeFile(join(f.options.receiptsDir, 'run.json'), JSON.stringify({ id: checkpoint.runId, codeMode: 'independent', targetPath: f.options.repoPath, models: f.options.seats }));
  assert.equal((await codeRunStatus(f.options.receiptsDir)).resumable, true);
  const inspection = await inspectCodeRun(f.options.receiptsDir);
  assert.equal(inspection.resumable, true); assert.equal(inspection.nextSafeAction.action, 'resume_candidate');
  assert.match(inspection.nextSafeAction.reason, /neither adopted nor replayed/);
  if (mode === 'drift') await writeFile(join(checkpoint.candidate.worktree, 'answer.txt'), 'external drift');
  if (mode === 'source_drift') {
    await writeFile(join(f.options.repoPath, 'README.md'), 'different baseline');
    git(f.options.repoPath, 'add', '.'); git(f.options.repoPath, 'commit', '-qm', 'external baseline change');
  }
  if (mode === 'ignored') {
    await writeFile(join(checkpoint.candidate.worktree, '.git/info/exclude'), 'untracked.cache\n');
    await writeFile(join(checkpoint.candidate.worktree, 'untracked.cache'), 'outside snapshot');
  }
  if (mode === 'tight_call_cap' || mode === 'below_spent_cap') {
    const capped = await f.run({ resume: true, limits: { maxCalls: mode === 'tight_call_cap' ? 3 : 1 } });
    if (mode === 'below_spent_cap') {
      assert.equal(capped.stateUnchanged, true); assert.equal(turns, 2);
      assert.equal((await f.checkpoint()).revision, checkpoint.revision);
    } else {
      assert.equal(turns, 3); assert.equal(reviews, 0, 'review also consumes a dispatch: no fourth call escapes the human cap');
      assert.equal(capped.usage.calls, 3); assert.equal(capped.limits.maxCalls, 3); assert.equal(capped.question.kind, 'budget');
      assert.equal(capped.completion, null); assert.equal(capped.usage.recoveries, 1);
      const finished = await f.run({ resume: true, limits: { maxCalls: 4 } });
      assert.equal(turns, 3, 'an explicit extra review allowance never replays the maker');
      assert.equal(reviews, 1); assert.equal(finished.completion, 'candidate_ready_for_acceptance', finished.error);
    }
    return;
  }
  const resumed = await f.run({ resume: true, ...(mode === 'authority' ? { retryUncertain: true } : {}) });
  if (['drift', 'source_drift', 'ignored', 'authority'].includes(mode)) {
    assert.equal(turns, 2); assert.equal(resumed.stateUnchanged, true);
    assert.equal((await f.checkpoint()).revision, checkpoint.revision);
    assert.match(resumed.error, { drift: /drift/, source_drift: /Source baseline changed/, ignored: /ignored output/, authority: /cannot replay/ }[mode]);
  } else if (mode.endsWith('budget')) {
    assert.equal(turns, 2); assert.equal(resumed.question.kind, 'budget');
    assert.equal(resumed.usage.calls, 2);
    const finished = await f.run({ resume: true, limits: { maxCalls: 4, maxRecoveries: 1 } });
    assert.equal(finished.completion, 'candidate_ready_for_acceptance', finished.error);
    assert.equal(finished.usage.recoveries, 1);
  } else {
    assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error);
    assert.equal(resumed.usage.calls, 4); assert.equal(resumed.usage.retries, 0); assert.equal(resumed.usage.recoveries, 1);
    assert.equal(reviews, 1); assert.equal(verifies, 1);
    const final = await f.checkpoint();
    assert.equal(final.retiredNativeCalls[0].response.uncertain, true);
    assert.equal(final.retiredNativeCalls[0].disposition, mode === 'exec_resume' ? 'discarded_incomplete_turn' : 'discarded_schema_turn');
  }
  assert.equal(await readFile(join(f.options.receiptsDir, 'refused-mirror'), 'utf8'), 'NEVER ADOPT THIS');
  assert.equal(git(f.options.repoPath, 'status', '--porcelain'), '');
});

test('native edits use a private clone, live accounting, host verification and fresh advisory review', async t => {
  let turns = 0, reviews = 0; const remaining = [];
  const f = await fixture(t, async args => {
    turns++; remaining.push(args.remainingTokens);
    if (turns === 1) {
      assert.match(args.prompt, new RegExp(`Action slice allowance/target: ${args.maxToolCalls};`));
      assert.match(args.prompt, new RegExp(`Model-call slice target: ${args.maxModelCalls};`));
      assert.match(args.prompt, new RegExp(`Dispatch time limit: ${args.timeoutMs} ms`));
      assert.match(args.prompt, /Host-observed tracked candidate paths \(1\): \["README\.md"\]/);
      assert.match(args.prompt, /do not use broad `ls -la` or `find \.` discovery/);
    }
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
  assert.deepEqual(remaining, [1000000, 999985], 'each native turn receives the remaining run budget before its reservation');
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

test('a quiescent uncertain native draft continues in a fresh session without human replay approval', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++;
    if (calls === 1) {
      args.onNativeSession(session);
      args.onNativeProgress({ usage, responses: 1, actions: 1 });
      await writeFile(join(args.worktree, 'answer.txt'), 'partial');
      return { ok: false, uncertain: true, candidateQuiescent: true, failureCode: 'terminal_missing',
        error: 'Final receipt unavailable.', usage, nativeSession: session };
    }
    assert.equal(args.nativeSession, null, 'uncertain hidden harness state is not resumed');
    assert.match(args.prompt, /quiescent draft/i);
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return done();
  });
  const result = await f.run();
  assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
  assert.equal(calls, 2); assert.equal(result.usage.recoveries, 1);
  assert.equal(await readFile(join(result.candidate.worktree, 'answer.txt'), 'utf8'), 'correct');
});

test('native recovery allowance parks a quiescent draft and an explicit extension continues it', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++;
    if (calls === 1) {
      await writeFile(join(args.worktree, 'answer.txt'), 'partial');
      return { ok: false, uncertain: true, candidateQuiescent: true,
        error: 'Slice ended without a receipt.', usage };
    }
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return done();
  });
  const parked = await f.run({ limits: { maxTokens: 1000000, maxRecoveries: 1 } });
  assert.equal(parked.question.kind, 'budget');
  assert.equal(parked.question.request.type, 'budget_extension');
  assert.match(parked.error, /recovery allowance exhausted/);
  assert.equal(parked.resumable, true); assert.equal(calls, 1);
  const resumed = await f.run({ resume: true, limits: { maxRecoveries: 2 } });
  assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error);
  assert.equal(calls, 2);
});

test('native metacognitive continue reuses a trusted session while model-change authority stays durable', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++;
    if (calls === 1) {
      args.onNativeSession(session); await writeFile(join(args.worktree, 'answer.txt'), 'partial');
      return { ...done(), text: JSON.stringify({ actions: [], done: false, summary: 'More work remains.',
        decision: { action: 'continue', reason: 'Complete the implementation and run the focused check.' } }) };
    }
    assert.equal(args.nativeSession.threadId, session.threadId);
    if (calls === 2) return { ...done(), text: JSON.stringify({ actions: [], done: false, summary: 'Need another harness.',
      decision: { action: 'request_model', reason: 'This task now needs a model with visual inspection.' } }) };
    await writeFile(join(args.worktree, 'answer.txt'), 'correct'); return done();
  });
  const asked = await f.run();
  assert.equal(asked.question.kind, 'authority');
  assert.equal(asked.question.request.type, 'model_change');
  assert.equal(calls, 2);
  const waiting = await f.run({ resume: true });
  assert.equal(waiting.question.id, asked.question.id); assert.equal(calls, 2);
  const resumed = await f.run({ resume: true, answer: { id: asked.question.id,
    text: 'Continue with the existing model; visual inspection is not required.' } });
  assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error);
  assert.equal(calls, 3);
});

test('a human-authorized model amendment rebinds the preserved native candidate and starts a fresh session', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++;
    if (calls === 1) {
      args.onNativeSession(session); await writeFile(join(args.worktree, 'answer.txt'), 'partial');
      return { ...done(), text: JSON.stringify({ actions: [], done: false, summary: 'Escalation recommended.',
        decision: { action: 'request_model', reason: 'Use the stronger qualified maker for closure.' } }) };
    }
    assert.equal(args.model, 'fixture-next'); assert.equal(args.nativeSession, null);
    await writeFile(join(args.worktree, 'answer.txt'), 'correct'); return done();
  });
  const asked = await f.run();
  const seats = { ...f.options.seats, maker: { ...f.options.seats.maker, model: 'fixture-next' } };
  const result = await f.run({ resume: true, seats, backendSnapshot: f.options.backendSnapshot,
    priorBackendSnapshot: f.options.backendSnapshot,
    seatAmendment: { questionId: asked.question.id },
    answer: { id: asked.question.id, text: 'Approved for closure on this candidate.' } });
  assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
  assert.equal(result.seats.maker.requested.model, 'fixture-next'); assert.equal(calls, 2);
  const checkpoint = await f.checkpoint();
  assert.equal(checkpoint.authorityAmendments.length, 1);
  assert.equal(checkpoint.authorityAmendments[0].candidateFingerprint, asked.candidate.fingerprint);
});

test('a model amendment cannot silently cross native and file-action candidate custody', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++; await writeFile(join(args.worktree, 'answer.txt'), 'partial');
    return { ...done(), text: JSON.stringify({ actions: [], done: false, summary: 'Change harness.',
      decision: { action: 'request_model', reason: 'Try file actions.' } }) };
  });
  const asked = await f.run();
  const seats = { ...f.options.seats, maker: { backend: 'codex', model: 'fixture-next', codeExecutor: 'file_actions' } };
  const result = await f.run({ resume: true, seats, backendSnapshot: f.options.backendSnapshot,
    priorBackendSnapshot: f.options.backendSnapshot, seatAmendment: { questionId: asked.question.id },
    answer: { id: asked.question.id, text: 'Approved.' } });
  assert.equal(result.status, 'infra_error'); assert.match(result.error, /candidate-custody boundary/);
  assert.equal(result.stateUnchanged, true); assert.equal(calls, 1);
});

test('a human-authorized contract amendment is append-only, bound to the candidate, and visible to closure', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++;
    if (calls === 1) {
      await writeFile(join(args.worktree, 'answer.txt'), 'partial');
      return { ...done(), text: JSON.stringify({ actions: [], done: false, summary: 'One acceptance detail is missing.',
        decision: { action: 'amend_contract', reason: 'Specify whether the answer needs a trailing newline.' } }) };
    }
    assert.match(args.prompt, /Human-authorized contract amendment \(append-only\):/);
    assert.match(args.prompt, /A trailing newline is required/);
    await writeFile(join(args.worktree, 'answer.txt'), 'correct\n'); return done();
  });
  const asked = await f.run();
  assert.equal(asked.question.request.type, 'contract_amendment');
  const result = await f.run({ resume: true, answer: { id: asked.question.id, text: 'A trailing newline is required.' } });
  assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
  const checkpoint = await f.checkpoint();
  assert.equal(checkpoint.authorityAmendments[0].type, 'contract_amendment');
  assert.match(checkpoint.task, /append-only/); assert.equal(calls, 2);
});

test('hard-crash native writes never silently become an authorized candidate on retry', async t => {
  let calls = 0;
  const f = await fixture(t, async args => {
    calls++; args.onNativeProgress({ usage, responses: 1, actions: 1 });
    await writeFile(join(args.worktree, 'answer.txt'), 'unfinished');
    return { ok: false, uncertain: true, usage };
  });
  const first = await f.run(); assert.equal(first.resumable, false); assert.equal(first.candidate.fingerprint, null);
  assert.equal(first.usage.accountedTokens, usage.total_tokens, 'known provider usage stays measured despite an uncertain coding terminal');
  assert.equal(first.usage.unmeasuredCalls, 0);
  const checkpoint = await f.checkpoint(); checkpoint.phase = 'make'; checkpoint.status = 'running';
  // Reconstruct the exact crash window after measured progress was persisted
  // but before any completed response was durably recorded.
  delete checkpoint.pendingCall.response;
  checkpoint.pendingCall.progress.reservationRestored = false;
  saveCodeCheckpoint(f.options.receiptsDir, checkpoint); // force the actual crash window
  const resumed = await f.run({ resume: true, retryUncertain: true });
  assert.match(resumed.error, /automatic adoption or replay is refused/); assert.equal(calls, 1);
  assert.equal(resumed.candidate.fingerprint, null);
  assert.equal(resumed.usage.accountedTokens, usage.total_tokens + checkpoint.limits.unknownTokenReserve);
  assert.equal(resumed.usage.unmeasuredCalls, 1);
  const sealed = await f.checkpoint();
  assert.equal(sealed.phase, 'refused');
  assert.equal(sealed.usage.accountedTokens, resumed.usage.accountedTokens);
  assert.equal(sealed.pendingCall.progress.reservationRestored, true);
});

test('a definitive native completion with a missing receipt preserves the candidate and names the diagnostic without replay', async t => {
  let calls = 0, reviews = 0;
  const f = await fixture(t, async args => {
    calls++; await writeFile(join(args.worktree, 'answer.txt'), 'candidate');
    return { ok: false, definitiveTurnEnd: true, uncertain: false, failureCode: 'terminal_receipt_missing',
      error: 'Grok subscription model-call receipt is unavailable.', usage: null };
  }, async () => { reviews++; return { ran: true, verdict: 'APPROVED', findings: [] }; });
  const result = await f.run();
  assert.equal(result.status, 'needs_decision'); assert.equal(calls, 1); assert.equal(reviews, 0);
  assert.match(result.error, /Native diagnostic: terminal_receipt_missing/);
  assert.ok(result.candidate.fingerprint, 'the closed-turn candidate remains inspectable');
  assert.equal(await readFile(join(result.candidate.worktree, 'answer.txt'), 'utf8'), 'candidate');
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

test('native live usage replaces the reservation instead of exhausting the advertised minimum', async t => {
  let stopReason;
  const measured = { input_tokens: 0, output_tokens: 1, cached_input_tokens: 0, total_tokens: 1 };
  const f = await fixture(t, async args => {
    stopReason = args.onNativeProgress({ usage: measured, responses: 1, actions: 0 });
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return { ...done(), usage: measured };
  });
  const result = await f.run({ limits: { maxTokens: 32768 } });
  assert.equal(stopReason, null, 'measured usage does not stack on the in-flight 32768 reservation');
  assert.equal(result.question.kind, 'budget', 'the next reviewer call still needs a fresh reservation');
  assert.equal(result.usage.accountedTokens, 1);
});

test('the one allowed native model response is not retroactively rejected at the call cap', async t => {
  let stopReason;
  const measured = { input_tokens: 0, output_tokens: 1, cached_input_tokens: 0, total_tokens: 1 };
  const f = await fixture(t, async args => {
    stopReason = args.onNativeProgress({ usage: measured, responses: 1, actions: 0 });
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return { ...done(), usage: measured };
  });
  const result = await f.run({ limits: { maxCalls: 1, maxTokens: 100000 } });
  assert.equal(stopReason, null);
  assert.equal(result.question.kind, 'budget', 'a second reviewer call is refused before dispatch');
  assert.equal(result.usage.calls, 1);
});

test('native missing usage retains the full conservative reservation', async t => {
  const f = await fixture(t, async args => {
    args.onNativeProgress({ usage: null, responses: 1, actions: 0 });
    await writeFile(join(args.worktree, 'answer.txt'), 'correct');
    return { ok: true, definitiveTurnEnd: true,
      text: JSON.stringify({ actions: [], done: true, summary: 'Ready.' }), nativeSession: session };
  });
  const result = await f.run({ limits: { maxTokens: 32768 } });
  assert.equal(result.question.kind, 'budget');
  assert.equal(result.usage.accountedTokens, 32768);
  assert.equal(result.usage.unmeasuredCalls, 1);
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
  const result = await f.run({ limits: { maxTokens: 0 } }); assert.match(result.error, /at least 32768/);
  const tooSmall = await f.run({ limits: { maxTokens: 32767 } }); assert.match(tooSmall.error, /at least 32768/);
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
