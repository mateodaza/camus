import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireCodeRun, readCodeCheckpoint, saveCodeCheckpoint, appendCodeEvent, codeStopRequested, digest, codeCredentialRevision, CODE_RUN_VERSION } from './code-run-state.mjs';
import { redactCodeText, diagnosticSecrets } from './code-diagnostics.mjs';

const TRANSIENT = /\b(?:429|502|503|504|ECONNRESET|ETIMEDOUT|rate.limit|temporarily unavailable)\b/i;
const TERMINAL = new Set(['complete', 'refused']);
const clone = (value) => JSON.parse(JSON.stringify(value));

function observedTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total = usage.total_tokens ?? usage.totalTokens;
  if (Number.isFinite(total) && total >= 0) return total;
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
  return Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? input + output : null;
}

export async function runProductiveCodeLoop(options, h) {
  let { repoPath, task, seats, adapters, backendSnapshot, verify = null, signal, receiptsDir,
    worktreeRoot, onEvent, resume = false, answer = null, retryUncertain = false, retryVerification = false, authorize = null } = options;
  let record, owner, heartbeat, timer, lastTick = Date.now(), writable = false;
  let limits;
  const abort = new AbortController();
  const stop = () => abort.abort(signal?.reason ?? new Error('explicit cancellation'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const cleanError = (error) => redactCodeText(error?.message ?? error, { secrets: diagnosticSecrets() }).slice(0, 1000);
  const emit = (type, fields = {}) => h.event(onEvent, type, fields);
  const persist = () => {
    record.usage.activeMs += Date.now() - lastTick; lastTick = Date.now();
    saveCodeCheckpoint(receiptsDir, record);
  };
  const log = async (type, data = {}) => {
    persist();
    await appendCodeEvent(receiptsDir, { type, runId: record.runId, revision: record.revision, ...data });
  };
  const finish = async (status, reason, phase = record?.phase) => {
    if (!record) return { status, error: reason, advisory: true, gating: false };
    record.status = status; record.reason = reason; record.phase = phase;
    let checkpointWriteFailed = false;
    if (writable) try { persist(); } catch { status = 'infra_error'; reason = 'Checkpoint could not be saved; inspect the last durable state before recovery.'; checkpointWriteFailed = true; }
    const result = clone(record.result);
    result.candidate = clone(record.candidate);
    if (['infra_error', 'stopped'].includes(status)) result.candidate = { ...result.candidate, diff: null, fingerprint: null, snapshotStatus: 'unverified_terminal' };
    const value = { ...result, status, error: reason, advisory: true, gating: false, runId: record.runId,
      receiptsDir, checkpointVersion: CODE_RUN_VERSION, resumable: !TERMINAL.has(phase),
      checkpointRevision: record.revision, stateUnchanged: !writable,
      question: record.question ?? null, usage: record.usage, limits: record.limits, attempts: record.attempts,
      checkpointWriteFailed,
      completion: phase === 'complete' ? 'candidate_ready_for_acceptance' : null };
    emit('terminal', { stage: 'code_seats', status, line: reason });
    return value;
  };
  const bind = () => digest({ task, seats: { maker: seats.maker, reviewer: seats.reviewer }, backends: backendSnapshot,
    verifier: verify?.command ?? null, repeatable: verify?.repeatable !== false,
    credentialRevisions: Object.fromEntries(Object.entries(backendSnapshot).map(([role, backend]) => {
      const name = backend?.auth?.envVar ?? backend?.apiKeyEnv;
      return [role, name ? codeCredentialRevision(process.env[name] ?? '') : null];
    })) });
  const question = (reason, kind = 'judgment') => {
    record.question = { id: digest({ runId: record.runId, kind, reason, candidate: record.candidate.fingerprint }), kind,
      text: cleanError(reason), candidateFingerprint: record.candidate.fingerprint };
    return finish('needs_decision', record.question.text);
  };
  const checkCandidate = async (message = 'Candidate drifted outside the recorded host action.') => {
    if (await realpath(record.candidate.worktree) !== resolve(record.candidate.worktree)) throw new Error('Candidate worktree path changed.');
    const top = await h.git(record.candidate.worktree, ['rev-parse', '--show-toplevel']);
    const common = await h.git(record.candidate.worktree, ['rev-parse', '--git-common-dir']);
    const sourceCommon = await h.git(record.source.repoPath, ['rev-parse', '--git-common-dir']);
    if (!top.ok || resolve(top.stdout.trim()) !== record.candidate.worktree || !common.ok || !sourceCommon.ok
        || await realpath(resolve(record.candidate.worktree, common.stdout.trim())) !== await realpath(resolve(record.source.repoPath, sourceCommon.stdout.trim()))) throw new Error('Candidate worktree ownership changed.');
    const actual = await h.candidate(record.candidate.worktree, limits);
    if (actual.head !== record.candidate.head || actual.branch !== record.candidate.branch || actual.fingerprint !== record.candidate.fingerprint) throw new Error(message);
  };
  const budgetReason = () => record.usage.calls >= limits.maxCalls ? 'model call budget exhausted'
    : record.usage.activeMs + Date.now() - lastTick >= limits.timeoutMs ? 'active time budget exhausted'
      : limits.maxTokens && record.usage.accountedTokens + limits.unknownTokenReserve > limits.maxTokens ? 'token budget lacks the next-call reservation' : null;
  const repeatedFailure = (kind, evidence) => {
    const attempt = `${kind}:${kind === 'verification' ? record.usage.verifications : record.usage.calls}`;
    if (record.lastFailureAttempt === attempt) return record.lastRepetition;
    const signature = digest({ kind, evidence });
    record.failureCounts ??= {};
    const occurrences = record.failureCounts[signature] = (record.failureCounts[signature] ?? 0) + 1;
    record.lastFailureAttempt = attempt;
    return record.lastRepetition = { signature, occurrences, repeated: occurrences > 1 };
  };
  const invalidateCandidateEvidence = () => {
    record.result.review = null; record.result.verification = null;
    record.result.reviewBinding = null; record.result.verificationBinding = null;
    record.verificationReady = false;
  };
  const call = async (role, prompt) => {
    if (record.pendingCall?.response && !record.pendingCall.response.uncertain) {
      if (record.pendingCall.role !== role || record.pendingCall.promptHash !== digest(prompt)) throw new Error('Saved response does not bind this role and context.');
      return record.pendingCall.response;
    }
    if (record.pendingCall) {
      if (!retryUncertain) return { uncertain: true };
      if (record.usage.retries >= limits.maxRetries) return { budget: 'uncertain-call retry allowance exhausted' };
      record.attempts.push({ id: record.pendingCall.id, role, outcome: 'uncertain', possibleDuplicateBilling: true });
      record.usage.retries++; record.pendingCall = null; await log('uncertain_retry_authorized');
    }
    const reason = budgetReason();
    if (reason) return { budget: reason };
    await checkCandidate();
    if (bind() !== record.binding) throw new Error('Credential or execution binding changed during this run.');
    const id = `${role}-${record.usage.calls + 1}`;
    record.pendingCall = { id, role, promptHash: digest(prompt), startedAt: Date.now() };
    record.usage.calls++; record.usage.accountedTokens += limits.unknownTokenReserve;
    await log('call_started', { id, role });
    const control = new AbortController();
    let idleTimer;
    const activity = () => { clearTimeout(idleTimer); if (limits.idleTimeoutMs) idleTimer = setTimeout(() => control.abort(new Error('provider inactivity timeout')), limits.idleTimeoutMs); };
    activity();
    const interrupted = () => control.abort(abort.signal.reason);
    abort.signal.addEventListener('abort', interrupted, { once: true });
    const timeout = setTimeout(() => control.abort(new Error('provider phase timeout')), limits.callTimeoutMs);
    let response;
    try {
      if (abort.signal.aborted) interrupted();
      const common = { prompt, model: seats[role].model, effort: seats[role].effort ?? null, cwd: record.scratch,
        signal: control.signal, expectedReported: seats[role].expectedReported,
        onTick: (line) => { activity(); emit('progress', { actor: role, line: cleanError(line) }); },
        onSession: (line) => { activity(); emit('session', { actor: role, line: cleanError(line) }); } };
      response = await adapters[role](role === 'maker' ? { ...common, stage: record.feedback ? 'fix' : 'make', toolPolicy: 'none' }
        : { ...common, claims: [], criteria: [], thresholds: [], receiptDir: join(receiptsDir, id) });
    } catch (error) { response = { ok: false, ran: false, error: cleanError(error) }; }
    finally { clearTimeout(timeout); clearTimeout(idleTimer); abort.signal.removeEventListener('abort', interrupted); }
    if (control.signal.aborted && !(role === 'maker' ? response?.ok : response?.ran)) response = { ok: false, ran: false, error: 'provider phase interrupted', uncertain: true };
    // All completed responses become durable BEFORE any returned file action.
    record.pendingCall.response = response ?? { ok: false, error: 'empty adapter result' };
    const tokens = observedTokens(response?.usage);
    if (tokens !== null) { record.usage.observedTokens += tokens; record.usage.accountedTokens += tokens - limits.unknownTokenReserve; }
    else record.usage.unmeasuredCalls++;
    const durationMs = Date.now() - record.pendingCall.startedAt;
    record.usage.modelMs += durationMs;
    record.attempts.push({ id, role, outcome: response?.uncertain ? 'uncertain' : role === 'maker' ? (response?.ok ? 'response' : 'infra') : (response?.ran ? 'response' : 'infra'), tokens, durationMs });
    await log('call_response_saved', { id, role, tokens });
    return record.pendingCall.response;
  };
  const failedCall = async (response, role) => {
    if (response.budget) return question(response.budget, 'budget');
    if (response.uncertain) return question('Provider completion is uncertain. Explicitly authorize a bounded retry or leave this candidate parked.', 'uncertain_call');
    if (TRANSIENT.test(response.error ?? '') && record.usage.retries < limits.maxRetries && !abort.signal.aborted) {
      record.usage.retries++; record.pendingCall = null;
      await log('transient_retry', { role });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return null;
    }
    record.pendingCall = null;
    return finish('infra_error', `${role} failed: ${cleanError(response.error ?? 'invalid provider response')}`);
  };
  try {
    if (abort.signal.aborted) return { status: 'stopped', advisory: true, error: 'code seats stopped before preflight' };
    if (!repoPath || typeof task !== 'string' || !task.trim()) throw new Error('repoPath and a non-empty task are required');
    if (typeof adapters?.maker !== 'function' || typeof adapters?.reviewer !== 'function') throw new Error('pre-resolved maker and reviewer adapters are required');
    seats = clone(seats); backendSnapshot = clone(backendSnapshot ?? { maker: adapters?.makerBackend ?? {}, reviewer: adapters?.reviewerBackend ?? {} });
    const source = await realpath(repoPath);
    const top = await h.git(source, ['rev-parse', '--show-toplevel']);
    if (!top.ok || resolve(top.stdout.trim()) !== source) throw new Error('repoPath must be the git repository root');
    receiptsDir = await h.privateReceiptsDir(receiptsDir, source);
    owner = await acquireCodeRun(receiptsDir);
    if (resume) {
      record = await readCodeCheckpoint(receiptsDir);
      if (record.source.repoPath !== source || record.binding !== bind()) throw new Error('Run contract, model, credential, connection, or verification binding changed; no model was called.');
      if (TERMINAL.has(record.phase)) throw new Error('This run is already closed; inspect its existing receipt. No model was called.');
      limits = { ...record.limits };
      for (const [key, value] of Object.entries(options.limits ?? {})) {
        h.limitsFor({ [key]: value });
        if (!['maxSteps', 'maxActions', 'maxCalls', 'maxRepairs', 'maxRetries', 'maxTokens', 'timeoutMs'].includes(key)
            || (value < limits[key] && !(key === 'maxTokens' && value === 0))) throw new Error('Resume permits only explicit budget extensions, not changed execution policy.');
        limits[key] = value;
      }
      record.limits = limits;
      const base = await h.git(source, ['rev-parse', 'HEAD']);
      if (!base.ok || base.stdout.trim() !== record.source.head) throw new Error('Source baseline changed; resume refused.');
      if (answer) {
        if (answer.id !== record.question?.id || typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 4000
            || record.question.candidateFingerprint !== record.candidate.fingerprint) throw new Error('Answer does not bind the outstanding question and candidate.');
        record.answer = { id: answer.id, text: answer.text }; record.question = null;
      } else if (record.question?.kind === 'judgment') return finish('needs_decision', record.question.text);
      else record.question = null;
      if (record.status !== 'running') record.usage.pausedMs += Math.max(0, Date.now() - record.updatedAt);
      else record.usage.unobservedWallMs = (record.usage.unobservedWallMs ?? 0) + Math.max(0, Date.now() - record.updatedAt);
      // Unknown time since a hard crash is visible, never counted as free certainty.
      if (record.status === 'running') record.usage.activeTimeIncomplete = true;
    } else {
      try { await readCodeCheckpoint(receiptsDir); throw new Error('Run already exists; use explicit resume.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      limits = h.limitsFor(options.limits);
      const dirty = await h.git(source, ['status', '--porcelain']);
      if (!dirty.ok || dirty.stdout.trim()) return { status: 'needs_decision', advisory: true, error: 'source checkout is dirty; advisory code seats refuse to pick a base' };
      const base = await h.git(source, ['rev-parse', 'HEAD']);
      if (!base.ok) throw new Error('source checkout has no HEAD');
      const root = worktreeRoot ? await h.prospectiveRealpath(worktreeRoot) : receiptsDir;
      if (h.isWithin(source, root)) throw new Error('worktreeRoot must be outside the source checkout');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const holder = await mkdtemp(join(root, 'candidate-'));
      const worktree = join(holder, 'worktree');
      const branch = `codex/code-seats-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
      record = { version: CODE_RUN_VERSION, runId: basename(receiptsDir), binding: bind(), task, seats,
        source: { repoPath: source, head: base.stdout.trim() }, candidate: { worktree, branch, head: base.stdout.trim() },
        phase: 'initialize', status: 'running', limits, usage: { calls: 0, steps: 0, actions: 0, repairs: 0, retries: 0, observedTokens: 0, accountedTokens: 0, unmeasuredCalls: 0, activeMs: 0, modelMs: 0, verificationMs: 0, pausedMs: 0 },
        attempts: [], history: [], created: [], reads: [], feedback: null, pendingCall: null, pendingAction: null,
        result: h.baseResult({ seats, adapters, backendSnapshot }), generation: owner.generation };
      writable = true;
      await log('initialized');
    }
    lastTick = Date.now();
    if (record.phase === 'initialize') {
      const existing = await h.git(record.candidate.worktree, ['rev-parse', 'HEAD']);
      if (!existing.ok) {
        const added = await h.git(source, ['worktree', 'add', '-b', record.candidate.branch, record.candidate.worktree, record.source.head]);
        if (!added.ok) throw new Error('Cannot create or recover the recorded candidate worktree.');
      } else if (existing.stdout.trim() !== record.source.head) throw new Error('Initialized worktree has unexpected HEAD.');
      record.candidate = await h.candidate(record.candidate.worktree, limits);
      record.tracked = await h.sourceTrackedFiles(record.candidate.worktree);
      record.scratch = await mkdtemp(join(receiptsDir, 'adapter-scratch-'));
      if (!(await h.git(record.scratch, ['init', '-q'])).ok) throw new Error('Cannot initialize private adapter scratch.');
      record.phase = 'make'; await log('worktree_ready');
    }
    const state = { worktree: record.candidate.worktree, tracked: record.tracked, limits,
      created: new Set(record.created), reads: new Map(record.reads) };
    const snapshot = async () => {
      record.candidate = await h.candidate(state.worktree, limits);
      record.created = [...state.created]; record.reads = [...state.reads];
      record.tracked = state.tracked;
    };
    // Recover a write interrupted between application and checkpoint publication.
    if (record.pendingAction) {
      const { action, otherFingerprint } = record.pendingAction;
      if (digest(await h.completeDiff(state.worktree, limits, action.path)) !== otherFingerprint) throw new Error('Unrelated candidate drift during interrupted action.');
      const path = await h.safePath(state.worktree, action.path);
      let text = null; try { text = await h.currentText(path.absolute, limits); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const current = text === null ? null : h.sha256(text);
      const desired = action.type === 'write' ? h.sha256(action.content) : null;
      if (current === desired) {
        if (action.type === 'write' && action.expected_sha256 === null) state.created.add(action.path);
        if (action.type === 'delete') { state.created.delete(action.path); state.tracked = state.tracked.filter((path) => path !== action.path); }
        if (action.type === 'write') state.reads.set(action.path, action.content); else state.reads.delete(action.path);
        invalidateCandidateEvidence();
        record.observations.push({ type: action.type, path: action.path, sha256: desired, recovered: true });
        record.actionIndex++; record.pendingAction = null; await h.ensureCreatedVisible(state); await snapshot();
      } else if (current !== action.expected_sha256) throw new Error('Interrupted action has unexpected file contents.');
    }
    await checkCandidate();
    if (authorize) await authorize();
    writable = true; record.generation = owner.generation; record.status = 'running'; record.reason = null;
    await log('worker_attached');
    const remaining = Math.max(1, limits.timeoutMs - record.usage.activeMs);
    timer = setTimeout(() => abort.abort(new Error('active time budget exhausted')), remaining);
    heartbeat = setInterval(() => { codeStopRequested(receiptsDir, record.generation).then((requested) => { if (requested) stop(); }).catch(() => abort.abort(new Error('stop request unavailable'))); }, 250);
    heartbeat.unref();
    while (true) {
      if (abort.signal.aborted) return finish('stopped', cleanError(abort.signal.reason ?? 'code seats stopped'));
      record.result.protocol = { version: 'code-seats/v2', steps: record.usage.steps, actions: record.usage.actions };
      record.result.source = record.source;
      if (record.phase === 'make') {
        if (!record.pendingCall?.response && record.usage.steps >= limits.maxSteps) return question('protocol step cap reached; extend the budget to continue', 'budget');
        let history = record.history;
        let prompt = h.protocolPrompt({ task, history, limits, feedback: record.feedback, questionAnswer: record.answer });
        if (Buffer.byteLength(prompt) > limits.maxContextBytes) {
          history = [{ capsule: true, currentCandidate: record.candidate.fingerprint, files: record.reads.map(([path, content]) => ({ path, sha256: h.sha256(content) })), created: record.created,
            note: 'Earlier observations remain in the private journal; re-read safe files for current contents. Contract and unresolved feedback follow unchanged.' }, ...record.history.slice(-1)];
          prompt = h.protocolPrompt({ task, history, limits, feedback: record.feedback, questionAnswer: record.answer });
          if (Buffer.byteLength(prompt) > limits.maxContextBytes) throw new Error('Complete required maker context exceeds limit; host did not truncate it');
        }
        emit('stage', { stage: record.feedback ? 'fix' : 'make', actor: 'maker' });
        const response = await call('maker', prompt);
        if (abort.signal.aborted) return finish('stopped', 'code seats stopped during maker turn');
        if (!response.ok) { const failed = await failedCall(response, 'maker'); if (failed) return failed; continue; }
        let message;
        try { message = h.parseProtocol(response.text, limits); }
        catch (error) {
          if (record.usage.retries >= limits.maxRetries) throw error;
          record.usage.retries++; record.pendingCall = null;
          record.history.push({ protocolError: cleanError(error), instruction: 'Return the exact bounded JSON protocol. No action from the invalid response was applied.' });
          await log('protocol_retry'); continue;
        }
        record.result.seats.maker = h.observedMaker(response, record.result.seats.maker.requested, record.result.seats.maker.observed);
        record.usage.steps++; record.pendingCall = null;
        if (message.decision) {
          const { action, reason } = message.decision;
          if (action === 'human') return question(reason);
          if (action === 'stop') return finish('stopped', cleanError(reason), 'refused');
          if (!record.feedback || record.usage.retries >= limits.maxRetries) return question('No remaining evidence-recheck allowance.', 'budget');
          if (action === 'retry_verify' && (record.feedback.kind !== 'verification' || verify?.repeatable === false)) return question('This verifier cannot be replayed under its current authorization.', 'authority');
          if (action === 'rebut' && record.feedback.kind !== 'review') throw new Error('Rebuttal is valid only for a reviewer finding.');
          record.usage.retries++; record.rebuttal = cleanError(reason); record.phase = action === 'rebut' ? 'review' : 'verify'; record.verificationReady = false;
        } else if (message.done) {
          if (record.feedback && record.candidate.fingerprint === record.feedback.candidateFingerprint) return finish(record.feedback.kind === 'verification' ? 'verify_failed' : 'review_unresolved', 'Maker offered no changed candidate or evidence-bound recovery.');
          record.phase = 'verify'; record.verificationReady = false;
        } else {
          if (!message.actions.length) throw new Error('maker sent neither actions nor done');
          record.actions = message.actions; record.actionIndex = 0; record.observations = []; record.phase = 'apply';
        }
        await log('maker_decision');
      } else if (record.phase === 'apply') {
        while (record.actionIndex < record.actions.length) {
          if (abort.signal.aborted) return finish('stopped', 'code seats stopped during host action');
          const action = record.actions[record.actionIndex];
          if (!record.pendingAction) {
            if (record.usage.actions >= limits.maxActions) return question('protocol action cap reached', 'budget');
            await checkCandidate(); record.usage.actions++;
            if (['write', 'delete'].includes(action.type)) {
              await h.applyAction(action, state, { validateOnly: true });
              record.pendingAction = { action, otherFingerprint: digest(await h.completeDiff(state.worktree, limits, action.path)) };
            }
            await log('action_started');
          }
          record.observations.push(await h.applyAction(action, state));
          if (['write', 'delete'].includes(action.type)) {
            invalidateCandidateEvidence();
          }
          await h.ensureCreatedVisible(state); await snapshot(); record.actionIndex++; record.pendingAction = null;
          await log('action_completed');
        }
        record.history.push({ step: record.usage.steps, actions: record.observations });
        // Durable history is bounded independently of the per-call context.
        if (Buffer.byteLength(JSON.stringify(record.history)) > 4 * 1024 * 1024) return question('Journal context budget exhausted; candidate preserved.', 'budget');
        record.phase = 'make'; await log('observations_saved');
      } else if (record.phase === 'verify') {
        await checkCandidate();
        if (!record.candidate.diff) return finish('needs_decision', 'maker completed without a candidate diff');
        if (verify) {
          if ((record.verifierInFlight || record.usage.verifications > 0) && !record.verificationReady && verify.repeatable === false && !retryVerification) return question('Additional verification is not authorized. Allow one replay explicitly, or leave the candidate parked.', 'authority');
          if (!record.verificationReady) {
            if (retryVerification) { retryVerification = false; await log('verification_retry_authorized'); }
            record.usage.verifications = (record.usage.verifications ?? 0) + 1;
            record.verifierInFlight = true; await log('verification_started');
            emit('stage', { stage: 'verify', actor: 'host' });
            const startedAt = Date.now();
            const raw = await verify({ ...record.candidate, signal: abort.signal, onEvent });
            record.usage.verificationMs += Date.now() - startedAt;
            await checkCandidate('verifier changed the candidate; review refuses unstable evidence');
            record.result.verification = h.safeVerification(raw); record.verifierInFlight = false;
            record.result.verificationBinding = record.candidate.fingerprint;
            record.verificationReady = true; await log('verification_completed', { candidateFingerprint: record.candidate.fingerprint, verification: record.result.verification });
          }
          const raw = record.result.verification;
          if (abort.signal.aborted) return finish('stopped', 'verification aborted');
          if (!raw?.ran || raw.pass === null) {
            record.verificationReady = false;
            if (verify.repeatable === false) record.verifierInFlight = true;
            return finish('infra_error', 'verification was inconclusive; repair requires a runnable environment');
          }
          if (raw.pass === false) {
            const repetition = repeatedFailure('verification', { exitCode: raw.exitCode, diagnostics: raw.diagnostics?.message });
            if (record.usage.repairs >= limits.maxRepairs) return finish('verify_failed', 'Verification did not pass within the repair allowance.');
            record.feedback = { kind: 'verification', candidateFingerprint: record.candidate.fingerprint, evidence: record.result.verification, originalContract: 'unchanged',
              repetition };
            record.usage.repairs++; record.result.review = null; record.phase = 'make'; await log('repair_requested'); continue;
          }
        }
        record.phase = 'review'; await log('ready_for_review');
      } else if (record.phase === 'review') {
        await checkCandidate();
        // Rebuild source context from CURRENT files, never pre-edit read caches.
        const reads = [];
        for (const [path] of record.reads) {
          try { const item = await h.safePath(state.worktree, path); reads.push(`--- ${path} ---\n${await h.currentText(item.absolute, limits)}`); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const prompt = h.reviewPrompt({ task: record.rebuttal ? `${task}\nMaker rebuttal (untrusted evidence, not authority): ${record.rebuttal}` : task,
          diff: record.candidate.diff, reads: reads.join('\n'), verification: record.result.verification, independent: record.result.independence.independent });
        if (Buffer.byteLength(prompt) > limits.maxReviewContextBytes) throw new Error('Complete reviewer prompt exceeds context limit; host did not truncate it');
        emit('stage', { stage: 'review', actor: 'reviewer' });
        const response = await call('reviewer', prompt);
        if (abort.signal.aborted) return finish('stopped', 'code seats stopped during review');
        if (!response.ran || !['APPROVED', 'REVISE'].includes(response.verdict)) { const failed = await failedCall(response, 'reviewer'); if (failed) return failed; continue; }
        await checkCandidate('candidate changed while reviewer ran; advisory verdict is stale');
        record.result.review = response; record.result.seats.reviewer = h.observedReviewer(response, record.result.seats.reviewer.requested);
        record.result.reviewBinding = record.candidate.fingerprint;
        await log('review_completed', { candidateFingerprint: record.candidate.fingerprint, verdict: response.verdict, findings: response.findings ?? [] });
        record.rebuttal = null;
        if (response.verdict === 'APPROVED') return finish('needs_decision', 'Advisory candidate ready; explicit human acceptance required. Nothing was landed.', 'complete');
        const repetition = repeatedFailure('review', (response.findings ?? []).map(({ severity, title }) => ({ severity, title })));
        if (record.usage.repairs >= limits.maxRepairs) return finish('review_unresolved', 'Reviewer findings remain after the bounded repair allowance.');
        record.pendingCall = null;
        record.feedback = { kind: 'review', candidateFingerprint: record.candidate.fingerprint, findings: response.findings ?? [], questions: response.questions ?? [],
          repetition };
        record.usage.repairs++; record.phase = 'make'; await log('repair_requested');
      } else throw new Error('Unknown coding checkpoint phase.');
    }
  } catch (error) {
    // Integrity/containment errors never buy another model turn automatically.
    return finish('infra_error', cleanError(error), record ? 'refused' : undefined);
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); signal?.removeEventListener('abort', stop);
    if (owner) await owner.release();
  }
}
