import { basename, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readFile, lstat } from 'node:fs/promises';
import { readCodeRunSnapshot } from './code-run-state.mjs';
import { redactCodeText, diagnosticSecrets } from './code-diagnostics.mjs';
import { FILE_ACTION_POLICY, NATIVE_RECOVERY_POLICY } from './code-loop.mjs';
import { MAKER_PROGRESS_POLICY } from './code-context.mjs';
import { isNativeExecutor } from './code-native-policy.mjs';

const USAGE_FIELDS = [
  'calls', 'rawProviderResponses', 'steps', 'actions', 'repairs', 'retries', 'recoveries',
  'observedTokens', 'accountedTokens', 'unmeasuredCalls', 'activeMs', 'modelMs',
  'verificationMs', 'pausedMs', 'verifications', 'unobservedWallMs',
];
const LIMIT_FIELDS = [
  'maxSteps', 'maxActions', 'maxActionsPerStep', 'maxResponseBytes',
  'maxContextBytes', 'maxReviewContextBytes', 'maxFileBytes', 'maxListEntries',
  'maxDiffBytes', 'timeoutMs', 'callTimeoutMs', 'idleTimeoutMs', 'maxCalls',
  'maxRepairs', 'maxRetries', 'maxRecoveries', 'maxTokens', 'unknownTokenReserve',
];
const HEX_ID = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;
const INSPECTABLE_STATUSES = new Set([
  'running', 'needs_decision', 'stopped', 'infra_error', 'verify_failed', 'review_unresolved',
]);
const INSPECTABLE_PHASES = new Set(['initialize', 'make', 'apply', 'verify', 'review', 'complete', 'refused']);

function safeText(value, max = 1000, roots = []) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Invalid coding inspection text.');
  return redactCodeText(value, { secrets: diagnosticSecrets(), roots })
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '<private-endpoint>')
    .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})\b/giu, '<private-endpoint>')
    .replace(/\b((?:endpoint|host|baseurl|url|connection)\s*[:=]\s*)[^\s,;]+/giu, '$1<private-endpoint>')
    .replace(/\b((?:connect\s+(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH)\s+|dial\s+(?:tcp\s+)?|getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\s+|(?:ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN)\s+))[^\s,;]+/giu, '$1<private-endpoint>')
    .replace(/(^|[\s("'=[{,:])\/(?:[^/\s"'<>:()\]]+\/?)+/gu, '$1<private-path>')
    .replace(/\b[a-z]:\\[^\s"'<>]+/giu, '<private-path>')
    .replace(/\\\\[^\s"'<>]+/gu, '<private-path>')
    .replace(/\b(?:(?:raw\s+)?(?:provider\s+)?(?:response|body|output)|stderr|stdout)\s*[:=][\s\S]*$/giu, '[redacted provider detail]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/giu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeReason(value, roots = []) {
  if (typeof value === 'string') {
    const providerFailure = value.match(/^\s*(maker|reviewer)\s+failed\s*:/iu);
    if (providerFailure) return `${providerFailure[1].toLowerCase()} provider call failed; private provider details are omitted.`;
  }
  return safeText(value, 1000, roots);
}

function safeLabel(value, name) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_:-]{0,79}$/i.test(value)) throw new Error(`Invalid coding inspection ${name}.`);
  return value;
}

function numericProjection(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid coding inspection counters.');
  const result = {};
  for (const field of fields) if (Object.hasOwn(source, field) && source[field] != null) {
    if (!Number.isFinite(source[field]) || source[field] < 0) throw new Error('Invalid coding inspection counter.');
    result[field] = source[field];
  }
  return result;
}

function candidateProjection(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.worktree !== 'string' || !isAbsolute(candidate.worktree)
      || candidate.worktree.length > 4096 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(candidate.worktree)
      || typeof candidate.branch !== 'string' || !candidate.branch || candidate.branch.length > 256
      || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(candidate.branch)
      || (candidate.head != null && !GIT_HEAD.test(candidate.head))
      || (candidate.fingerprint != null && !HEX_ID.test(candidate.fingerprint))) {
    throw new Error('Invalid coding inspection candidate identity.');
  }
  return {
    worktree: candidate.worktree,
    branch: candidate.branch,
    head: candidate.head ?? null,
    fingerprint: candidate.fingerprint ?? null,
    snapshotStatus: typeof candidate.snapshotStatus === 'string'
      ? safeLabel(candidate.snapshotStatus, 'candidate status') : null,
  };
}

function seatProjection(seat) {
  if (!seat || typeof seat !== 'object' || Array.isArray(seat)) throw new Error('Invalid coding inspection seat.');
  return {
    backend: safeLabel(seat.backend, 'seat backend'),
    model: safeText(seat.model, 200),
    ...(seat.effort ? { effort: safeLabel(seat.effort, 'seat effort') } : {}),
    ...(seat.codeExecutor ? { codeExecutor: safeLabel(seat.codeExecutor, 'seat executor') } : {}),
  };
}

function reviewProjection(state) {
  const review = state.result?.review;
  if (review == null) return { status: 'not_run', verdict: null, candidateBound: null, findingCount: null };
  const verdict = ['APPROVED', 'REVISE'].includes(review.verdict) ? review.verdict : null;
  const findingsValid = Array.isArray(review.findings) && review.findings.every(finding =>
    finding && typeof finding === 'object' && !Array.isArray(finding)
      && ['high', 'medium', 'low'].includes(finding.severity));
  const blocking = findingsValid && review.findings.some(finding => ['high', 'medium'].includes(finding.severity));
  const status = review.ran === true && findingsValid && verdict === 'APPROVED' && !blocking ? 'approved'
    : review.ran === true && findingsValid && verdict === 'REVISE' ? 'revise' : 'inconclusive';
  return {
    status,
    verdict,
    candidateBound: typeof state.candidate?.fingerprint === 'string'
      ? state.result?.reviewBinding === state.candidate.fingerprint : false,
    findingCount: findingsValid ? review.findings.length : null,
  };
}

function verificationProjection(state) {
  const verification = state.result?.verification;
  if (verification == null) return { status: 'not_run', ran: null, pass: null, candidateBound: null, exitCode: null };
  const pass = [true, false, null].includes(verification.pass) ? verification.pass : null;
  const ran = typeof verification.ran === 'boolean' ? verification.ran : null;
  const status = ran === true && pass === true ? 'passed'
    : ran === true && pass === false ? 'failed' : 'inconclusive';
  return {
    status,
    ran,
    pass,
    candidateBound: typeof state.candidate?.fingerprint === 'string'
      ? state.result?.verificationBinding === state.candidate.fingerprint : false,
    exitCode: Number.isInteger(verification.exitCode) ? verification.exitCode : null,
  };
}

function questionProjection(question, roots) {
  if (question == null) return null;
  if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(question.id)
      || typeof question.kind !== 'string' || typeof question.text !== 'string') {
    throw new Error('Invalid coding inspection question.');
  }
  let request = null;
  if (question.request != null) {
    if (!question.request || typeof question.request !== 'object' || Array.isArray(question.request)
        || !['budget_extension', 'model_change', 'contract_amendment', 'verification_replay'].includes(question.request.type)) {
      throw new Error('Invalid coding inspection authority request.');
    }
    request = { type: question.request.type };
    if (typeof question.request.cause === 'string') request.cause = safeText(question.request.cause, 300, roots);
  }
  return { id: question.id, kind: safeLabel(question.kind, 'question kind'), text: safeText(question.text, 1000, roots),
    ...(request ? { request } : {}) };
}

function hasUncertainWork(state) {
  return state.nativeInFlight === true
    || Boolean(state.pendingCall && (!state.pendingCall.response || state.pendingCall.response.uncertain === true))
    || Boolean(state.verifierInFlight && state.verificationReady !== true);
}

function nextSafeAction(state, { owned, resumable, question, questionBound, policyCompatible }) {
  if (owned) return {
    action: 'attach_or_status',
    reason: 'A worker owns this run. Observe or attach; do not start a second worker.',
  };
  const uncertain = hasUncertainWork(state);
  if (uncertain && question?.kind === 'uncertain_call' && questionBound && !state.nativeInFlight) return {
    action: 'authorize_uncertain_retry',
    reason: 'Explicitly authorize the bounded provider retry; duplicate billing remains possible.',
  };
  if (uncertain) return {
    action: 'investigate_or_start_fresh',
    reason: 'Recovery is not safely authorized from this evidence. Investigate the preserved run or start fresh without replaying uncertain work.',
  };
  if (!policyCompatible) return {
    action: 'investigate_or_start_fresh',
    reason: 'This checkpoint does not carry a supported execution policy. Inspect the preserved candidate or start fresh; do not reinterpret it under current rules.',
  };
  if (state.phase === 'complete') return {
    action: 'inspect_candidate_for_acceptance',
    reason: 'The advisory candidate is complete. Inspect its evidence; human acceptance remains a separate decision.',
  };
  if (state.phase === 'refused'
      || ['infra_error', 'verify_failed', 'review_unresolved', 'needs_decision'].includes(state.status)) {
    if ((question?.kind === 'judgment' || ['model_change', 'contract_amendment'].includes(question?.request?.type))
        && questionBound && !uncertain && state.phase !== 'refused'
        && !['infra_error', 'verify_failed', 'review_unresolved'].includes(state.status)) return {
      action: question?.kind === 'judgment' ? 'answer_question' : 'answer_authority_request',
      reason: 'Answer the exact durable authority request before resuming this candidate.',
    };
    return {
      action: 'investigate_or_start_fresh',
      reason: 'Recovery is not safely authorized from this evidence. Investigate the preserved run or start fresh without replaying uncertain work.',
    };
  }
  if ((question?.kind === 'judgment' || ['model_change', 'contract_amendment'].includes(question?.request?.type)) && questionBound) return {
    action: question?.kind === 'judgment' ? 'answer_question' : 'answer_authority_request',
    reason: 'Answer the exact durable authority request before resuming this candidate.',
  };
  if (question) return {
    action: 'investigate_or_start_fresh',
    reason: 'The durable question does not authorize a safe automatic continuation. Investigate this run or start fresh.',
  };
  if (resumable) return {
    action: 'resume_candidate',
    reason: 'The unowned checkpoint can safely continue the same candidate with its existing limits and evidence.',
  };
  return {
    action: 'investigate_or_start_fresh',
    reason: 'No safe automatic continuation is established. Investigate the preserved run or start fresh.',
  };
}

export const codeRunsRoot = () => resolve(process.env.STUDIO_RUNS_DIR || join(homedir(), '.camus', 'studio', 'runs'));
export function codeRunDirectory(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new Error('Run ID must contain only letters, numbers, underscores and hyphens.');
  return join(codeRunsRoot(), id);
}
export async function readCodeRunMetadata(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Run directory must be a private directory, not a symlink.');
  const path = join(dir, 'run.json');
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024) throw new Error('Invalid run metadata.');
  const meta = JSON.parse(await readFile(path, 'utf8'));
  if (meta.codeMode !== 'independent' || !isAbsolute(meta.targetPath ?? '') || !meta.models?.maker || !meta.models?.reviewer) throw new Error('Not an independent coding run.');
  return meta;
}

function legacyInspection(runId) {
  const reason = 'Run metadata exists, but no authenticated coding checkpoint is available; it may be historical or may have stopped before checkpoint creation.';
  return {
    schemaVersion: 1,
    runId,
    legacy: true,
    status: 'inspection_only',
    phase: null,
    owned: false,
    interrupted: false,
    resumable: false,
    checkpoint: null,
    candidate: null,
    usage: null,
    limits: null,
    review: { status: 'not_run', verdict: null, candidateBound: null, findingCount: null },
    verification: { status: 'not_run', ran: null, pass: null, candidateBound: null, exitCode: null },
    reason,
    question: null,
    nextSafeAction: {
      action: 'investigate_or_start_fresh',
      reason: 'This metadata-only run cannot be resumed. Inspect any preserved artifacts or start fresh.',
    },
  };
}

export async function inspectCodeRun(dir) {
  const runId = basename(dir);
  let metadata;
  try { metadata = await readCodeRunMetadata(dir); }
  catch { throw new Error('Run metadata is missing or invalid; inspection refused.'); }
  if (metadata.id !== runId) throw new Error('Run identity does not match its metadata; inspection refused.');

  let snapshot;
  try { snapshot = await readCodeRunSnapshot(dir); }
  catch (error) {
    let checkpointMissing = false;
    if (error?.code === 'ENOENT') {
      try { await lstat(join(dir, 'code-checkpoint.json')); }
      catch (check) {
        if (check?.code === 'ENOENT') checkpointMissing = true;
        else throw new Error('Coding checkpoint could not be authenticated; inspection refused.');
      }
    }
    if (checkpointMissing) return legacyInspection(runId);
    throw new Error('Coding checkpoint could not be authenticated; inspection refused.');
  }

  const { state, owned } = snapshot;
  if (state.runId !== runId || state.version !== 2) throw new Error('Run identity does not match its checkpoint; inspection refused.');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0
      || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0
      || typeof owned !== 'boolean') throw new Error('Coding checkpoint is incomplete; inspection refused.');
  if (!INSPECTABLE_STATUSES.has(state.status) || !INSPECTABLE_PHASES.has(state.phase)) {
    throw new Error('Coding checkpoint is incomplete; inspection refused.');
  }
  const status = state.status;
  const phase = state.phase;
  const interrupted = status === 'running' && !owned;
  const native = isNativeExecutor(state.seats?.maker?.codeExecutor);
  const policyCompatible = state.fileActionPolicy === FILE_ACTION_POLICY
    && (state.makerProgressPolicy === undefined || state.makerProgressPolicy === MAKER_PROGRESS_POLICY)
    && (!native || state.nativeRecoveryPolicy === NATIVE_RECOVERY_POLICY);
  const unsafeRecovery = state.nativeInFlight === true
    || Boolean(state.verifierInFlight && state.verificationReady !== true);
  const resumable = !owned && policyCompatible && !unsafeRecovery && !['complete', 'refused'].includes(phase);
  const textRoots = [dir, state.source?.repoPath, state.candidate?.worktree].filter(Boolean);
  const question = questionProjection(state.question, textRoots);
  const questionBound = question == null || (typeof state.question?.candidateFingerprint === 'string'
    && state.question.candidateFingerprint === state.candidate?.fingerprint);
  const usage = numericProjection(state.usage, USAGE_FIELDS);
  if (Object.hasOwn(state.usage, 'activeTimeIncomplete')) {
    if (typeof state.usage.activeTimeIncomplete !== 'boolean') throw new Error('Invalid coding inspection counter.');
    usage.activeTimeIncomplete = state.usage.activeTimeIncomplete;
  }
  const review = reviewProjection(state);
  const verification = verificationProjection(state);
  if (phase === 'complete' && (status !== 'needs_decision' || question !== null
      || typeof state.candidate?.diff !== 'string' || state.candidate.diff.length === 0 || hasUncertainWork(state)
      || review.status !== 'approved'
      || review.candidateBound !== true || !(
        verification.status === 'not_run'
        || (verification.status === 'passed' && verification.candidateBound === true)
      ))) throw new Error('Coding checkpoint is incomplete; inspection refused.');
  const projection = {
    schemaVersion: 1,
    runId,
    legacy: false,
    status,
    phase,
    owned,
    interrupted,
    resumable,
    checkpoint: { version: state.version, revision: state.revision, updatedAt: state.updatedAt },
    candidate: candidateProjection(state.candidate),
    seats: { maker: seatProjection(state.seats.maker), reviewer: seatProjection(state.seats.reviewer) },
    usage,
    limits: numericProjection(state.limits, LIMIT_FIELDS),
    review,
    verification,
    reason: safeReason(state.reason, textRoots),
    question,
  };
  projection.nextSafeAction = nextSafeAction(state, { owned, resumable, question, questionBound, policyCompatible });
  return projection;
}

export function formatCodeInspection(inspection) {
  const state = inspection.phase ? `${inspection.status} / ${inspection.phase}` : inspection.status;
  const ownership = inspection.owned ? 'active' : inspection.interrupted ? 'interrupted' : 'idle';
  const lines = [
    `Run: ${inspection.runId}`,
    `State: ${state}`,
    `Ownership: ${ownership}; resumable: ${inspection.resumable ? 'yes' : 'no'}`,
  ];
  if (inspection.checkpoint) lines.push(`Checkpoint: v${inspection.checkpoint.version} revision ${inspection.checkpoint.revision}; updated ${inspection.checkpoint.updatedAt}`);
  if (inspection.candidate) lines.push(`Candidate: ${inspection.candidate.worktree} (${inspection.candidate.branch} @ ${inspection.candidate.head?.slice(0, 12) ?? 'unrecorded'})`);
  if (inspection.usage) lines.push(`Usage: ${inspection.usage.calls ?? 'unknown'} calls; ${inspection.usage.steps ?? 'unknown'} steps; ${inspection.usage.actions ?? 'unknown'} actions; ${inspection.usage.recoveries ?? 0} recoveries; ${inspection.usage.accountedTokens ?? 'unknown'} accounted tokens`);
  lines.push(`Review: ${inspection.review.status}; verification: ${inspection.verification.status}`);
  if (inspection.question) lines.push(`Question ${inspection.question.id}: ${inspection.question.text}`);
  if (inspection.reason) lines.push(`Reason: ${inspection.reason}`);
  lines.push(`Next: ${inspection.nextSafeAction.action} — ${inspection.nextSafeAction.reason}`);
  return lines.join('\n');
}

export async function codeContinuation(dir) {
  try {
    const state = await inspectCodeRun(dir);
    return { mode: 'code_checkpoint', canResume: state.resumable, ...state,
      updatedAt: state.checkpoint?.updatedAt ?? null, revision: state.checkpoint?.revision ?? null,
      presentation: { title: state.owned ? 'Worker active' : state.resumable ? 'Continue the same candidate' : 'Inspect the preserved candidate',
        detail: state.owned ? 'Attach to this run; no second worker is started.' : state.reason ?? 'Recovery uses saved responses and file hashes; it does not restart planning.' } };
  } catch (error) {
    return { mode: 'code_checkpoint', canResume: false, legacy: error.code === 'ENOENT',
      presentation: { title: 'Inspection only', detail: error.code === 'ENOENT' ? 'This historical run has no authenticated checkpoint. Start a fresh run to use recovery.' : 'The saved checkpoint could not be authenticated. No recovery is authorized.' } };
  }
}
