import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCodeRun, saveCodeCheckpoint } from './code-run-state.mjs';
import { codeRunDirectory, inspectCodeRun, formatCodeInspection } from './code-session.mjs';
import { parseCodeBuildArgs } from '../code-build.mjs';
import { FILE_ACTION_POLICY, NATIVE_RECOVERY_POLICY } from './code-loop.mjs';
import { MAKER_PROGRESS_POLICY } from './code-context.mjs';

async function fixture(t, mutate = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-inspect-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = `code-inspect-${Math.random().toString(16).slice(2)}`;
  const dir = join(root, id), candidate = join(root, 'candidate');
  await mkdir(dir); await mkdir(candidate);
  const models = { maker: { backend: 'claude', model: 'maker' }, reviewer: { backend: 'codex', model: 'reviewer' } };
  const metadata = { id, codeMode: 'independent', targetPath: root, models };
  await writeFile(join(dir, 'run.json'), JSON.stringify(metadata), { mode: 0o600 });
  const state = {
    version: 2,
    runId: id,
    binding: 'binding',
    fileActionPolicy: FILE_ACTION_POLICY,
    makerProgressPolicy: MAKER_PROGRESS_POLICY,
    source: { repoPath: root, head: 'a'.repeat(40) },
    candidate: {
      worktree: candidate,
      branch: 'codex/inspect-fixture',
      head: 'a'.repeat(40),
      fingerprint: 'b'.repeat(64),
      diff: 'PRIVATE DIFF MUST NOT BE PROJECTED',
    },
    phase: 'make',
    status: 'running',
    limits: { maxCalls: 18, maxSteps: 14, maxTokens: 400000 },
    usage: { calls: 3, accountedTokens: 1234 },
    history: [],
    reads: [],
    created: [],
    attempts: [],
    seats: models,
    result: { seats: { maker: { requested: models.maker }, reviewer: { requested: models.reviewer } }, review: null, verification: null },
    reason: null,
    question: null,
  };
  mutate(state, metadata);
  await saveCodeCheckpoint(dir, state);
  await writeFile(join(candidate, 'sentinel.txt'), 'unchanged');
  return { root, id, dir, candidate, state };
}

test('inspection is one authenticated, bounded, read-only checkpoint projection', async (t) => {
  const f = await fixture(t);
  const before = {
    metadata: await readFile(join(f.dir, 'run.json')),
    checkpoint: await readFile(join(f.dir, 'code-checkpoint.json')),
    candidate: await readFile(join(f.candidate, 'sentinel.txt')),
    entries: await readdir(f.dir),
  };
  const inspection = await inspectCodeRun(f.dir);
  assert.equal(inspection.runId, f.id);
  assert.equal(inspection.interrupted, true);
  assert.equal(inspection.resumable, true);
  assert.equal(inspection.nextSafeAction.action, 'resume_candidate');
  assert.deepEqual(inspection.usage, { calls: 3, accountedTokens: 1234 });
  assert.deepEqual(inspection.limits, { maxSteps: 14, maxCalls: 18, maxTokens: 400000 });
  assert.equal(inspection.candidate.worktree, f.candidate);
  assert.equal(Object.hasOwn(inspection.candidate, 'diff'), false);
  assert.doesNotMatch(JSON.stringify(inspection), /PRIVATE DIFF|repoPath|targetPath|provider|task|contract/i);
  assert.match(formatCodeInspection(inspection), /Next: resume_candidate/);
  assert.deepEqual(await readFile(join(f.dir, 'run.json')), before.metadata);
  assert.deepEqual(await readFile(join(f.dir, 'code-checkpoint.json')), before.checkpoint);
  assert.deepEqual(await readFile(join(f.candidate, 'sentinel.txt')), before.candidate);
  assert.deepEqual(await readdir(f.dir), before.entries);

  const owner = await acquireCodeRun(f.dir);
  try {
    const active = await inspectCodeRun(f.dir);
    assert.equal(active.owned, true);
    assert.equal(active.interrupted, false);
    assert.equal(active.resumable, false);
    assert.equal(active.nextSafeAction.action, 'attach_or_status');
  } finally { await owner.release(); }
});

test('inspection derives fixed safe actions and only bounded review/verification standing', async (t) => {
  const question = await fixture(t, state => {
    state.status = 'needs_decision';
    state.question = { id: 'q_123', kind: 'judgment', text: 'Choose one output format for src/foo.js:12.\n\u001b[31mNo terminal control.\u001b[0m', candidateFingerprint: state.candidate.fingerprint };
  });
  const questionView = await inspectCodeRun(question.dir);
  assert.equal(questionView.nextSafeAction.action, 'answer_question');
  assert.doesNotMatch(questionView.question.text, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.match(questionView.question.text, /src\/foo\.js:12/);

  const modelChange = await fixture(t, state => {
    state.status = 'needs_decision';
    state.question = { id: 'q_model', kind: 'authority', text: 'Use a stronger closure model.',
      request: { type: 'model_change' }, candidateFingerprint: state.candidate.fingerprint };
  });
  const modelChangeView = await inspectCodeRun(modelChange.dir);
  assert.equal(modelChangeView.nextSafeAction.action, 'answer_authority_request');
  assert.deepEqual(modelChangeView.question.request, { type: 'model_change' });

  const staleQuestion = await fixture(t, state => {
    state.status = 'needs_decision';
    state.question = { id: 'q_stale', kind: 'judgment', text: 'A stale question.', candidateFingerprint: 'c'.repeat(64) };
  });
  assert.equal((await inspectCodeRun(staleQuestion.dir)).nextSafeAction.action, 'investigate_or_start_fresh');

  const unboundQuestion = await fixture(t, state => {
    state.status = 'needs_decision';
    state.question = { id: 'q_unbound', kind: 'judgment', text: 'An unbound question.' };
  });
  assert.equal((await inspectCodeRun(unboundQuestion.dir)).nextSafeAction.action, 'investigate_or_start_fresh');

  const complete = await fixture(t, state => {
    state.status = 'needs_decision'; state.phase = 'complete';
    state.result.review = { ran: true, verdict: 'APPROVED', findings: [{ severity: 'low', title: 'PRIVATE FINDING' }] };
    state.result.reviewBinding = state.candidate.fingerprint;
    state.result.verification = { ran: true, pass: true, exitCode: 0, diagnostics: { message: 'PRIVATE OUTPUT' } };
    state.result.verificationBinding = state.candidate.fingerprint;
  });
  const ready = await inspectCodeRun(complete.dir);
  assert.equal(ready.nextSafeAction.action, 'inspect_candidate_for_acceptance');
  assert.deepEqual(ready.review, { status: 'approved', verdict: 'APPROVED', candidateBound: true, findingCount: 1 });
  assert.deepEqual(ready.verification, { status: 'passed', ran: true, pass: true, candidateBound: true, exitCode: 0 });
  assert.doesNotMatch(JSON.stringify(ready), /PRIVATE FINDING|PRIVATE OUTPUT/);

  const contradictoryComplete = await fixture(t, state => {
    state.status = 'needs_decision'; state.phase = 'complete';
    state.question = { id: 'q_outstanding', kind: 'judgment', text: 'Still unanswered.', candidateFingerprint: state.candidate.fingerprint };
    state.result.review = { ran: true, verdict: 'APPROVED', findings: [] };
    state.result.reviewBinding = state.candidate.fingerprint;
  });
  await assert.rejects(inspectCodeRun(contradictoryComplete.dir), /checkpoint is incomplete/);

  for (const missingDiff of [undefined, '']) {
    const noCandidateChange = await fixture(t, state => {
      state.status = 'needs_decision'; state.phase = 'complete';
      state.candidate.diff = missingDiff;
      state.result.review = { ran: true, verdict: 'APPROVED', findings: [] };
      state.result.reviewBinding = state.candidate.fingerprint;
    });
    await assert.rejects(inspectCodeRun(noCandidateChange.dir), /checkpoint is incomplete/);
  }

  const uncertain = await fixture(t, state => {
    state.status = 'needs_decision';
    state.pendingCall = { role: 'maker', response: { uncertain: true, text: 'PRIVATE PROVIDER OUTPUT' } };
    state.question = { id: 'q_456', kind: 'uncertain_call', text: 'Explicit retry authority is absent.' };
  });
  const parked = await inspectCodeRun(uncertain.dir);
  assert.equal(parked.resumable, true, 'phase-level resumability stays honest');
  assert.equal(parked.nextSafeAction.action, 'investigate_or_start_fresh');
  assert.doesNotMatch(JSON.stringify(parked), /PRIVATE PROVIDER OUTPUT/);

  const uncertainJudgment = await fixture(t, state => {
    state.status = 'needs_decision';
    state.pendingCall = { role: 'maker' };
    state.question = { id: 'q_789', kind: 'judgment', text: 'A stale question must not outrank uncertain work.' };
  });
  assert.equal((await inspectCodeRun(uncertainJudgment.dir)).nextSafeAction.action, 'investigate_or_start_fresh');

  const refused = await fixture(t, state => { state.status = 'infra_error'; state.phase = 'refused'; });
  assert.equal((await inspectCodeRun(refused.dir)).nextSafeAction.action, 'investigate_or_start_fresh');

  const privateReason = await fixture(t, state => {
    state.status = 'infra_error'; state.phase = 'refused';
    state.reason = 'maker failed: HTTP 400 {"message":"PRIVATE_BODY_MARKER"}; PRIVATE_BODY_SUFFIX.';
  });
  const redactedReason = (await inspectCodeRun(privateReason.dir)).reason;
  assert.doesNotMatch(redactedReason, /PRIVATE_BODY_MARKER|PRIVATE_BODY_SUFFIX/);
  assert.equal(redactedReason, 'maker provider call failed; private provider details are omitted.');

  const privateReviewerReason = await fixture(t, state => {
    state.status = 'review_unresolved'; state.phase = 'refused';
    state.reason = 'reviewer failed: opaque PRIVATE_REVIEWER_OUTPUT without a body label';
  });
  assert.equal((await inspectCodeRun(privateReviewerReason.dir)).reason,
    'reviewer provider call failed; private provider details are omitted.');

  const privateNetwork = await fixture(t, state => {
    state.status = 'infra_error'; state.phase = 'refused';
    state.reason = 'connect ECONNREFUSED secret.internal:8443; getaddrinfo ENOTFOUND api.corp.internal; endpoint=[::1]:1234; path:[/private/operator/run.json]; UNC=\\\\server\\share\\run.json';
  });
  const redactedNetwork = (await inspectCodeRun(privateNetwork.dir)).reason;
  assert.doesNotMatch(redactedNetwork, /secret\.internal|api\.corp\.internal|::1|\/private\/operator|server\\share/);
  assert.match(redactedNetwork, /private-endpoint/); assert.match(redactedNetwork, /private-path/);
});

test('historical or current pre-checkpoint metadata-only runs inspect honestly and cannot resume', async (t) => {
  const f = await fixture(t);
  const metadata = JSON.parse(await readFile(join(f.dir, 'run.json'), 'utf8'));
  metadata.createdAt = Date.now();
  await writeFile(join(f.dir, 'run.json'), JSON.stringify(metadata), { mode: 0o600 });
  await rm(join(f.dir, 'code-checkpoint.json'));
  const legacy = await inspectCodeRun(f.dir);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.status, 'inspection_only');
  assert.equal(legacy.resumable, false);
  assert.equal(legacy.checkpoint, null);
  assert.equal(legacy.candidate, null);
  assert.equal(legacy.nextSafeAction.action, 'investigate_or_start_fresh');
  assert.match(legacy.reason, /historical|stopped before checkpoint/);
});

test('inspection never recommends resume under an unsupported execution policy', async (t) => {
  const missingFilePolicy = await fixture(t, state => { delete state.fileActionPolicy; });
  const missing = await inspectCodeRun(missingFilePolicy.dir);
  assert.equal(missing.resumable, false); assert.equal(missing.nextSafeAction.action, 'investigate_or_start_fresh');

  const unknownFilePolicy = await fixture(t, state => { state.fileActionPolicy = 'future_file_policy'; });
  assert.equal((await inspectCodeRun(unknownFilePolicy.dir)).nextSafeAction.action, 'investigate_or_start_fresh');

  const legacyProgress = await fixture(t, state => { delete state.makerProgressPolicy; });
  assert.equal((await inspectCodeRun(legacyProgress.dir)).nextSafeAction.action, 'resume_candidate');

  const unknownProgress = await fixture(t, state => { state.makerProgressPolicy = 'future_progress_policy'; });
  const unknown = await inspectCodeRun(unknownProgress.dir);
  assert.equal(unknown.resumable, false); assert.equal(unknown.nextSafeAction.action, 'investigate_or_start_fresh');

  const nativeWithoutRecovery = await fixture(t, state => { state.seats.maker.codeExecutor = 'grok_native'; });
  assert.equal((await inspectCodeRun(nativeWithoutRecovery.dir)).resumable, false);

  const nativeRecovery = await fixture(t, state => {
    state.seats.maker.codeExecutor = 'grok_native'; state.nativeRecoveryPolicy = NATIVE_RECOVERY_POLICY;
    state.usage.recoveries = 1; state.limits.maxRecoveries = 4;
  });
  const recoverable = await inspectCodeRun(nativeRecovery.dir);
  assert.equal(recoverable.resumable, true); assert.equal(recoverable.usage.recoveries, 1);

  const nativeInFlight = await fixture(t, state => {
    state.seats.maker.codeExecutor = 'grok_native'; state.nativeRecoveryPolicy = NATIVE_RECOVERY_POLICY;
    state.nativeInFlight = true; state.pendingCall = { id: 'native-1', role: 'maker', native: true };
  });
  const unsafe = await inspectCodeRun(nativeInFlight.dir);
  assert.equal(unsafe.resumable, false); assert.equal(unsafe.nextSafeAction.action, 'investigate_or_start_fresh');
});

test('missing, symlinked, malformed, oversized, unsupported and incomplete artifacts fail closed', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-inspect-invalid-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(inspectCodeRun(join(root, 'missing')), error => {
    assert.equal(error.message, 'Run metadata is missing or invalid; inspection refused.'); return true;
  });

  const metadataLink = await fixture(t);
  const metadataTarget = join(metadataLink.root, 'metadata-target.json');
  await writeFile(metadataTarget, await readFile(join(metadataLink.dir, 'run.json')));
  await rm(join(metadataLink.dir, 'run.json'));
  await symlink(metadataTarget, join(metadataLink.dir, 'run.json'));
  await assert.rejects(inspectCodeRun(metadataLink.dir), /Run metadata is missing or invalid/);

  const checkpointLink = await fixture(t);
  const checkpointTarget = join(checkpointLink.root, 'checkpoint-target.json');
  await writeFile(checkpointTarget, await readFile(join(checkpointLink.dir, 'code-checkpoint.json')));
  await rm(join(checkpointLink.dir, 'code-checkpoint.json'));
  await symlink(checkpointTarget, join(checkpointLink.dir, 'code-checkpoint.json'));
  await assert.rejects(inspectCodeRun(checkpointLink.dir), /could not be authenticated/);

  const malformed = await fixture(t);
  await writeFile(join(malformed.dir, 'code-checkpoint.json'), '{"secret":"sk-private-never-echoed"');
  await assert.rejects(inspectCodeRun(malformed.dir), error => {
    assert.equal(error.message, 'Coding checkpoint could not be authenticated; inspection refused.');
    assert.doesNotMatch(error.message, /sk-private|\//); return true;
  });

  const tampered = await fixture(t);
  const envelope = JSON.parse(await readFile(join(tampered.dir, 'code-checkpoint.json'), 'utf8'));
  envelope.mac = `${envelope.mac[0] === '0' ? '1' : '0'}${envelope.mac.slice(1)}`;
  await writeFile(join(tampered.dir, 'code-checkpoint.json'), JSON.stringify(envelope));
  await assert.rejects(inspectCodeRun(tampered.dir), error => {
    assert.equal(error.message, 'Coding checkpoint could not be authenticated; inspection refused.');
    assert.doesNotMatch(error.message, /binding|candidate|\//); return true;
  });

  const oversized = await fixture(t);
  await writeFile(join(oversized.dir, 'code-checkpoint.json'), Buffer.alloc(24 * 1024 * 1024 + 1));
  await assert.rejects(inspectCodeRun(oversized.dir), /could not be authenticated/);

  const unsupported = await fixture(t, state => { state.version = 3; });
  await assert.rejects(inspectCodeRun(unsupported.dir), /could not be authenticated/);

  const incomplete = await fixture(t, state => { delete state.result.seats; });
  await assert.rejects(inspectCodeRun(incomplete.dir), /could not be authenticated/);

  const unknownStatus = await fixture(t, state => { state.status = 'accepted'; });
  await assert.rejects(inspectCodeRun(unknownStatus.dir), /checkpoint is incomplete/);

  const incompleteComplete = await fixture(t, state => { state.status = 'needs_decision'; state.phase = 'complete'; });
  await assert.rejects(inspectCodeRun(incompleteComplete.dir), /checkpoint is incomplete/);

  const uncertainComplete = await fixture(t, state => {
    state.status = 'needs_decision'; state.phase = 'complete';
    state.result.review = { ran: true, verdict: 'APPROVED', findings: [] };
    state.result.reviewBinding = state.candidate.fingerprint;
    state.pendingCall = { id: 'maker-uncertain', role: 'maker' };
  });
  await assert.rejects(inspectCodeRun(uncertainComplete.dir), /checkpoint is incomplete/);

  const contradictoryComplete = await fixture(t, state => {
    state.status = 'needs_decision'; state.phase = 'complete';
    state.result.review = { ran: true, verdict: 'APPROVED', findings: [{ severity: 'high', title: 'Blocking' }] };
    state.result.reviewBinding = state.candidate.fingerprint;
  });
  await assert.rejects(inspectCodeRun(contradictoryComplete.dir), /checkpoint is incomplete/);
});

test('inspect parser is exact, exclusive, and keeps the existing run-id boundary', () => {
  assert.deepEqual(parseCodeBuildArgs(['--inspect', 'code-123', '--json']), { inspect: 'code-123', json: true });
  for (const args of [
    ['--inspect', 'code-123', '--status', 'code-123'],
    ['--inspect', 'code-123', '--task', 'unexpected'],
    ['--inspect', 'code-123', '--max-calls', '1'],
    ['--inspect', 'code-123', '--models'],
  ]) assert.throws(() => parseCodeBuildArgs(args), /one build operation|offline read-only operation/);
  assert.throws(() => codeRunDirectory('../private'), /letters, numbers, underscores and hyphens/);
});
