// Experimental advisory code seats.  This is deliberately a host-mediated
// protocol, not an agent shell: models receive only the repository material the
// host explicitly supplies and can request a small set of checked file actions.
// Nothing here commits, merges, pushes, or changes the source checkout.

import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const PROTOCOL_VERSION = 'code-seats/v1';
const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 12,
  maxActions: 32,
  maxActionsPerStep: 4,
  maxResponseBytes: 64 * 1024,
  maxContextBytes: 128 * 1024,
  maxReviewContextBytes: 512 * 1024,
  maxFileBytes: 128 * 1024,
  maxListEntries: 1_000,
  maxDiffBytes: 1024 * 1024,
  timeoutMs: 20 * 60_000,
});

const PRIVATE_COMPONENT = /^(?:\.git|\.camus|\.claude|\.codex|\.ssh|\.aws|\.azure|\.docker|credentials?|secrets?|passwords?)$/i;
const PRIVATE_FILE = /(?:^\.env(?:\.|$)|^\.(?:npmrc|netrc|pypirc|git-credentials)$|^auth\.json$|^id_(?:rsa|ed25519|ecdsa|dsa)$|\.(?:pem|key|p12|pfx)$|(?:^|[._-])(?:credential|secret|password|access[_-]?token)(?:[._-]|$))/i;
const KNOWN_SECRET_CONTENT = /(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:^|\n)\s*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:])/i;

export const CODE_SEATS_PROTOCOL_VERSION = PROTOCOL_VERSION;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function byteLength(value) { return Buffer.byteLength(String(value), 'utf8'); }
function boundedText(value, max = 800) {
  return String(value ?? '').replace(/[\0\r\n]+/g, ' ').slice(0, max);
}
function safeError(error) { return boundedText(error?.message ?? error ?? 'unknown error'); }
function isWithin(parent, child) {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
function event(onEvent, type, fields = {}) {
  try { onEvent?.({ type, ...fields, ...(fields.line ? { line: boundedText(fields.line) } : {}) }); } catch { /* UI callbacks cannot change a run */ }
}
function limitsFor(input = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(out, key) && Number.isInteger(value) && value > 0) out[key] = Math.min(value, 16 * 1024 * 1024);
  }
  return out;
}
async function git(cwd, args, options = {}) {
  try {
    const out = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: options.timeout ?? 20_000, maxBuffer: options.maxBuffer ?? 18 * 1024 * 1024 });
    return { ok: true, stdout: out.stdout, stderr: out.stderr };
  } catch (error) {
    return { ok: false, exitCode: Number.isInteger(error.code) ? error.code : null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: safeError(error) };
  }
}
function cleanSeat(seat, backend = {}) {
  const fingerprint = backend.connectionFingerprint ?? backend.fingerprint ?? null;
  return {
    backend: typeof seat?.backend === 'string' ? seat.backend : (backend.name ?? null),
    model: typeof seat?.model === 'string' ? seat.model : null,
    effort: typeof seat?.effort === 'string' ? seat.effort : null,
    provider: typeof backend.provider === 'string' ? backend.provider : null,
    kind: typeof backend.kind === 'string' ? backend.kind : null,
    connectionFingerprint: typeof fingerprint === 'string' && /^[a-z0-9:_-]{8,160}$/i.test(fingerprint) ? fingerprint : null,
    trainingOrg: typeof seat?.trainingOrg === 'string' && seat.trainingOrg !== 'unknown' ? seat.trainingOrg : null,
    lineageSource: typeof seat?.lineage?.source === 'string' && seat.lineage.source !== 'unknown' ? seat.lineage.source : null,
  };
}
function observedMaker(result, requested, previous = null) {
  const turn = {
    identity: result?.modelActual ?? null,
    reportedModel: result?.modelReported ?? null,
    evidence: result?.modelActualEvidence ?? null,
    usage: result?.usage ?? null,
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
  };
  return {
    requested,
    observed: {
      ...turn,
      // Keep observed per-turn usage rather than inventing a summed value from
      // heterogeneous providers. A null remains explicitly unmeasured.
      turns: [...(previous?.turns ?? []), turn],
    },
  };
}
function observedReviewer(result, requested) {
  return {
    requested,
    observed: {
      identity: result?.reviewerIdentity ?? null,
      reportedModel: result?.reviewerReportedModel ?? null,
      evidence: result?.reviewerActualEvidence ?? null,
      usage: result?.usage ?? null,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
    },
  };
}
function safeVerification(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.ran !== 'boolean' || ![true, false, null].includes(raw.pass)) {
    throw new Error('verifier returned an invalid result shape');
  }
  return {
    ran: raw.ran,
    pass: raw.pass,
    error: raw.error == null ? null : boundedText(raw.error, 1_000),
    exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : (Number.isFinite(raw.duration_ms) ? raw.duration_ms : null),
    outputBytes: Number.isInteger(raw.outputBytes) ? raw.outputBytes : null,
  };
}

function protocolPrompt({ task, history = [], limits }) {
  const state = history.length ? `\nComplete host action history (do not assume omitted state):\n${JSON.stringify(history)}` : '';
  return `You are the maker in an EXPERIMENTAL ADVISORY code loop. You have no shell, tools, or filesystem access. The host owns an isolated git worktree and will perform only the JSON actions you request.\n\nTask:\n${task}\n\nReply with exactly one JSON object and no Markdown. Shape: {"actions":[...],"done":boolean,"summary":"short"}. Actions are: {"type":"list"}, {"type":"read","path":"relative/tracked-file"}, {"type":"write","path":"relative/file","content":"full UTF-8 file content","expected_sha256":"64 hex or null for a new file"}, {"type":"delete","path":"relative/file","expected_sha256":"64 hex"}.\n\nRules: use list before guessing filenames; reads are limited to the original tracked, safe source files; write full content only; every existing-file write/delete must repeat the exact sha256 returned by host; never request .git, .camus, symlinks, credentials, absolute paths, or traversal; finish with actions:[] and done:true. If the task cannot be completed safely, set done:true and explain in summary. Host limits: at most ${limits.maxActionsPerStep} actions per response, ${limits.maxFileBytes} bytes/file, ${limits.maxContextBytes} bytes/action observation. A refused oversized observation is not silently shortened.${state}`;
}

function reviewPrompt({ task, diff, reads, verification, independent }) {
  return `You are the reviewer in an EXPERIMENTAL ADVISORY code loop. You have no tools or filesystem access. Review only the complete host-supplied task, diff, read context, and deterministic verification result below. This review never approves, merges, or lands code.${independent ? '' : '\nThe maker and reviewer have the same declared origin; this is non-independent advisory evidence.'}\n\nTask:\n${task}\n\nComplete candidate diff:\n${diff}\n\nRelevant source read by the maker:\n${reads}\n\nHost verification (if any):\n${JSON.stringify(verification ?? null)}\n\nReturn ONLY JSON exactly matching: {"verdict":"clean"|"revise","findings":[{"severity":"high"|"medium"|"low","title":"..."}],"questions_for_human":[],"claim_assessments":[],"coverage_assessments":[],"threshold_assessments":[]}. A clean verdict must have no high/medium finding. Verification failures must be a high or medium finding and verdict revise.`;
}

function parseProtocol(text, limits) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('maker returned empty protocol output');
  if (byteLength(text) > limits.maxResponseBytes) throw new Error('maker protocol response exceeded the response limit');
  let message;
  try { message = JSON.parse(text); } catch { throw new Error('maker protocol output is not one JSON object'); }
  if (!message || typeof message !== 'object' || Array.isArray(message) || !Array.isArray(message.actions) || typeof message.done !== 'boolean') {
    throw new Error('maker protocol needs an actions array and boolean done');
  }
  if (message.actions.length > limits.maxActionsPerStep) throw new Error('maker requested too many actions in one response');
  if (message.done && message.actions.length) throw new Error('maker cannot combine done with actions');
  if (message.summary !== undefined && (typeof message.summary !== 'string' || byteLength(message.summary) > 2_000)) throw new Error('maker protocol summary is invalid');
  return message;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0') || isAbsolute(value)) throw new Error('path must be a bounded relative path');
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || PRIVATE_COMPONENT.test(part))) throw new Error(`unsafe path: ${boundedText(value, 180)}`);
  if (PRIVATE_FILE.test(basename(value))) throw new Error(`private credential path refused: ${boundedText(value, 180)}`);
  return parts.join('/');
}

async function safePath(worktree, path, { allowMissing = true } = {}) {
  const rel = safeRelativePath(path);
  const absolute = resolve(worktree, rel);
  if (!isWithin(worktree, absolute)) throw new Error('path escapes candidate worktree');
  let cursor = worktree;
  for (const part of rel.split('/')) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`symlink path refused: ${rel}`);
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) break;
      throw error;
    }
  }
  return { rel, absolute };
}

async function regularFile(path) {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}
async function currentText(path, limits) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('path is not a regular file');
  if (info.size > limits.maxFileBytes) throw new Error(`file exceeds ${limits.maxFileBytes} byte context limit; host did not truncate it`);
  const text = await readFile(path, 'utf8');
  if (byteLength(text) > limits.maxFileBytes) throw new Error(`file exceeds ${limits.maxFileBytes} byte context limit; host did not truncate it`);
  return text;
}

async function sourceTrackedFiles(worktree) {
  const listed = await git(worktree, ['ls-files', '-z']);
  if (!listed.ok) throw new Error(`cannot list tracked source: ${listed.error}`);
  const files = [];
  for (const raw of listed.stdout.split('\0')) {
    if (!raw) continue;
    try {
      const item = await safePath(worktree, raw, { allowMissing: false });
      if (await regularFile(item.absolute)) files.push(item.rel);
    } catch { /* unsafe tracked entries are intentionally unavailable to models */ }
  }
  return files.sort();
}

async function applyAction(action, state) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') throw new Error('action must be an object with a type');
  const { worktree, tracked, limits, reads } = state;
  if (action.type === 'list') {
    if (Object.keys(action).some((key) => !['type'].includes(key))) throw new Error('list action has unsupported fields');
    if (tracked.length > limits.maxListEntries) throw new Error(`tracked file list has ${tracked.length} entries, exceeding context limit; host did not truncate it`);
    const observation = { type: 'list', files: tracked };
    if (byteLength(JSON.stringify(observation)) > limits.maxContextBytes) throw new Error('tracked file list exceeds context limit; host did not truncate it');
    return observation;
  }
  if (!['read', 'write', 'delete'].includes(action.type)) throw new Error(`unsupported action type: ${boundedText(action.type)}`);
  const item = await safePath(worktree, action.path);
  if (action.type === 'read') {
    if (Object.keys(action).some((key) => !['type', 'path'].includes(key))) throw new Error('read action has unsupported fields');
    if (!tracked.includes(item.rel)) throw new Error('reads are limited to original tracked safe source files');
    const content = await currentText(item.absolute, limits);
    // This catches a few unambiguous credential formats in innocuously named
    // tracked files. It is deliberately not presented as universal scanning.
    if (KNOWN_SECRET_CONTENT.test(content)) throw new Error('recognized credential-shaped content refused without echoing it');
    const observation = { type: 'read', path: item.rel, sha256: sha256(content), content };
    if (byteLength(JSON.stringify(observation)) > limits.maxContextBytes) throw new Error('read observation exceeds context limit; host did not truncate it');
    reads.set(item.rel, content);
    return observation;
  }
  if (action.type === 'write') {
    if (Object.keys(action).some((key) => !['type', 'path', 'content', 'expected_sha256'].includes(key))) throw new Error('write action has unsupported fields');
    if (typeof action.content !== 'string' || byteLength(action.content) > limits.maxFileBytes) throw new Error('write content is missing or exceeds file limit');
    if (action.expected_sha256 !== null && (typeof action.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(action.expected_sha256))) throw new Error('write requires expected_sha256 or null for a new file');
    let exists = false;
    let before = null;
    try { before = await currentText(item.absolute, limits); exists = true; } catch (error) { if (error?.code !== 'ENOENT') { if (!String(error?.message).includes('no such file')) throw error; } }
    if (exists && action.expected_sha256 !== sha256(before)) throw new Error(`stale expected_sha256 for ${item.rel}`);
    if (!exists && action.expected_sha256 !== null) throw new Error(`new file ${item.rel} requires expected_sha256:null`);
    if (!exists) {
      const ignored = await git(worktree, ['check-ignore', '-q', '--', item.rel]);
      if (ignored.ok) throw new Error(`new file is git-ignored and cannot be candidate evidence: ${item.rel}`);
      if (ignored.exitCode !== 1) throw new Error(`cannot determine ignore status for ${item.rel}`);
    }
    await mkdir(dirname(item.absolute), { recursive: true });
    await writeFile(item.absolute, action.content, { encoding: 'utf8', mode: 0o600 });
    if (!exists) state.created.add(item.rel);
    return { type: 'write', path: item.rel, sha256: sha256(action.content), bytes: byteLength(action.content) };
  }
  if (Object.keys(action).some((key) => !['type', 'path', 'expected_sha256'].includes(key))) throw new Error('delete action has unsupported fields');
  if (typeof action.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(action.expected_sha256)) throw new Error('delete requires expected_sha256');
  const before = await currentText(item.absolute, limits);
  if (action.expected_sha256 !== sha256(before)) throw new Error(`stale expected_sha256 for ${item.rel}`);
  // unlink is intentionally imported lazily; delete never descends or follows a link.
  const { unlink } = await import('node:fs/promises');
  await unlink(item.absolute);
  state.created.delete(item.rel);
  return { type: 'delete', path: item.rel, sha256: sha256(before) };
}

async function ensureCreatedVisible(state) {
  for (const rel of state.created) {
    const ignored = await git(state.worktree, ['check-ignore', '-q', '--', rel]);
    if (ignored.ok) throw new Error(`model-created file became git-ignored and is not candidate evidence: ${rel}`);
    if (ignored.exitCode !== 1) throw new Error(`cannot determine ignore status for ${rel}`);
  }
}

async function completeDiff(worktree, limits) {
  const tracked = await git(worktree, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
  if (!tracked.ok) throw new Error(`cannot collect candidate diff: ${tracked.error}`);
  const untracked = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked.ok) throw new Error(`cannot list candidate files: ${untracked.error}`);
  let diff = tracked.stdout;
  for (const raw of untracked.stdout.split('\0')) {
    if (!raw) continue;
    const item = await safePath(worktree, raw, { allowMissing: false });
    if (!await regularFile(item.absolute)) throw new Error(`candidate contains non-regular untracked path: ${item.rel}`);
    const patch = await git(worktree, ['diff', '--binary', '--no-index', '--', '/dev/null', item.rel]);
    // git diff --no-index exits 1 when it finds a difference.
    if (!patch.ok && !patch.stdout) throw new Error(`cannot collect new-file diff: ${patch.error}`);
    diff += patch.stdout;
    if (byteLength(diff) > limits.maxDiffBytes) throw new Error(`candidate diff exceeds ${limits.maxDiffBytes} byte limit; host did not truncate it`);
  }
  if (byteLength(diff) > limits.maxDiffBytes) throw new Error(`candidate diff exceeds ${limits.maxDiffBytes} byte limit; host did not truncate it`);
  return diff;
}

async function candidate(worktree, limits) {
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  const branch = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok || !branch.ok) throw new Error('candidate worktree has no readable git identity');
  const diff = await completeDiff(worktree, limits);
  return { worktree, branch: branch.stdout.trim(), head: head.stdout.trim(), diff, fingerprint: sha256(`${head.stdout.trim()}\0${diff}`) };
}

function baseResult({ source = null, seats, adapters, backendSnapshot }) {
  const makerBackend = backendSnapshot?.maker ?? adapters?.makerBackend ?? {};
  const reviewerBackend = backendSnapshot?.reviewer ?? adapters?.reviewerBackend ?? {};
  const maker = cleanSeat(seats?.maker, makerBackend);
  const reviewer = cleanSeat(seats?.reviewer, reviewerBackend);
  const originKnown = Boolean(maker.trainingOrg && reviewer.trainingOrg && maker.lineageSource && reviewer.lineageSource);
  const independent = originKnown && maker.trainingOrg !== reviewer.trainingOrg;
  return {
    advisory: true,
    status: 'infra_error',
    source,
    candidate: null,
    seats: { maker: { requested: maker, observed: null }, reviewer: { requested: reviewer, observed: null } },
    independence: { independent, reason: !originKnown ? 'provenance_unknown' : (independent ? 'distinct_training_origins' : 'same_training_origin') },
    protocol: { version: PROTOCOL_VERSION, steps: 0, actions: 0 },
    review: null,
    verification: null,
    error: null,
  };
}

async function writeReceipt(receiptsDir, name, content) {
  if (!receiptsDir) return;
  await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  await writeFile(join(receiptsDir, name), content, { encoding: 'utf8', mode: 0o600 });
}

async function privateReceiptsDir(requested, source) {
  const canonicalSource = await realpath(source);
  if (requested) {
    const path = await prospectiveRealpath(requested);
    if (isWithin(canonicalSource, path)) throw new Error('receiptsDir must be outside the source checkout');
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  // Text adapters may write a final-message file. Their durable private cwd is
  // never the candidate worktree, so adapter artifacts cannot enter its diff.
  const root = await prospectiveRealpath(join(homedir(), '.camus', 'studio', 'code-seats-receipts'));
  if (isWithin(canonicalSource, root)) throw new Error('default receiptsDir would be inside the source checkout');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, 'run-'));
}
export const prepareCodeReceiptsDir = privateReceiptsDir;

async function prospectiveRealpath(value) {
  const target = resolve(value);
  let parent = target;
  for (;;) {
    try {
      const real = await realpath(parent);
      return resolve(real, relative(parent, target));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

// All adapter/backend objects must be frozen by the caller before this function
// starts. This function never resolves config or adapters itself, preventing a
// settings edit during an await from changing the selected transport.
export async function runCodeSeats({
  repoPath, task, seats, adapters, backendSnapshot = null, verify = null, signal = null,
  limits: suppliedLimits = {}, worktreeRoot = null, receiptsDir = null, onEvent = null,
} = {}) {
  const limits = limitsFor(suppliedLimits);
  // Capture callable seats and requested identities synchronously.  The caller
  // has already resolved these against its frozen backend snapshot; later
  // settings edits (or an object mutation by a UI observer) cannot swap a
  // maker/reviewer midway through this run.
  const fixedAdapters = { maker: adapters?.maker, reviewer: adapters?.reviewer };
  const fixedSeats = { maker: { ...(seats?.maker ?? {}) }, reviewer: { ...(seats?.reviewer ?? {}) } };
  const fixedBackends = {
    maker: backendSnapshot?.maker ?? adapters?.makerBackend ?? {},
    reviewer: backendSnapshot?.reviewer ?? adapters?.reviewerBackend ?? {},
  };
  let source = null;
  let timeout = null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  timeout = setTimeout(() => controller.abort(new Error('code seats time limit exceeded')), limits.timeoutMs);
  const result = baseResult({ seats: fixedSeats, adapters: fixedAdapters, backendSnapshot: fixedBackends });
  const finish = async (status, error = null) => {
    result.status = status;
    result.error = error ? boundedText(error, 1_000) : null;
    // A refused host action, partial I/O, or interruption can occur after the
    // last snapshot. Preserve the worktree, but do not advertise its older diff
    // or fingerprint as a complete binding of the terminal candidate.
    if (result.candidate && ['infra_error', 'stopped'].includes(status)) {
      result.candidate = { ...result.candidate, diff: null, fingerprint: null, snapshotStatus: 'unverified_terminal' };
    }
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    event(onEvent, 'terminal', { stage: 'code_seats', status, line: result.error ?? status });
    return result;
  };
  try {
    if (controller.signal.aborted) return finish('stopped', 'code seats stopped before preflight');
    if (!repoPath || typeof task !== 'string' || !task.trim()) return finish('infra_error', 'repoPath and a non-empty task are required');
    if (typeof fixedAdapters.maker !== 'function' || typeof fixedAdapters.reviewer !== 'function') return finish('infra_error', 'pre-resolved maker and reviewer adapters are required');
    if (!fixedSeats.maker.model || !fixedSeats.reviewer.model) return finish('infra_error', 'both seats need explicit models');
    source = await realpath(repoPath);
    const top = await git(source, ['rev-parse', '--show-toplevel']);
    if (!top.ok || resolve(top.stdout.trim()) !== source) return finish('infra_error', 'repoPath must be the git repository root');
    const dirty = await git(source, ['status', '--porcelain']);
    if (!dirty.ok) return finish('infra_error', `cannot inspect source checkout: ${dirty.error}`);
    if (dirty.stdout.trim()) return finish('needs_decision', 'source checkout is dirty; advisory code seats refuse to pick a base');
    const base = await git(source, ['rev-parse', 'HEAD']);
    if (!base.ok) return finish('infra_error', 'source checkout has no HEAD');
    result.source = { repoPath: source, head: base.stdout.trim() };
    try { receiptsDir = await privateReceiptsDir(receiptsDir, source); }
    catch (error) { return finish('infra_error', `cannot prepare private receipts: ${safeError(error)}`); }
    result.receiptsDir = receiptsDir;
    const root = worktreeRoot ? await prospectiveRealpath(worktreeRoot) : tmpdir();
    if (isWithin(source, root)) return finish('infra_error', 'worktreeRoot must be outside the source checkout');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const holder = await mkdtemp(join(root, 'camus-code-seats-'));
    const worktree = join(holder, 'candidate');
    const branch = `codex/code-seats-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    event(onEvent, 'stage', { stage: 'worktree', actor: 'host', line: 'creating isolated candidate worktree' });
    const added = await git(source, ['worktree', 'add', '-b', branch, worktree, base.stdout.trim()]);
    if (!added.ok) return finish('infra_error', `cannot create isolated worktree: ${added.error}`);
    if (receiptsDir && isWithin(worktree, receiptsDir)) return finish('infra_error', 'receiptsDir must be outside the candidate worktree');
    result.candidate = await candidate(worktree, limits);
    const scratch = await mkdtemp(join(receiptsDir, 'adapter-scratch-'));
    const scratchGit = await git(scratch, ['init', '-q']);
    if (!scratchGit.ok) return finish('infra_error', `cannot initialize private adapter scratch: ${scratchGit.error}`);
    const tracked = await sourceTrackedFiles(worktree);
    const state = { worktree, tracked, limits, reads: new Map(), created: new Set() };
    const history = [];
    let actions = 0;
    let done = false;
    for (let step = 1; step <= limits.maxSteps; step += 1) {
      if (controller.signal.aborted) return finish('stopped', 'code seats stopped before another maker turn');
      result.protocol.steps = step;
      event(onEvent, 'stage', { stage: 'make', actor: 'maker', line: `protocol step ${step}` });
      const makerPrompt = protocolPrompt({ task: task.trim(), history, limits });
      if (byteLength(makerPrompt) > limits.maxContextBytes) return finish('infra_error', 'complete maker prompt exceeds context limit; host did not truncate it');
      let maker;
      try {
        maker = await fixedAdapters.maker({ prompt: makerPrompt, stage: 'make', model: fixedSeats.maker.model, effort: fixedSeats.maker.effort ?? null, cwd: scratch, signal: controller.signal, toolPolicy: 'none', expectedReported: fixedSeats.maker.expectedReported, onTick: (line) => event(onEvent, 'progress', { stage: 'make', actor: 'maker', line }), onSession: (line) => event(onEvent, 'session', { stage: 'make', actor: 'maker', line }) });
      } catch (error) { return finish(controller.signal.aborted ? 'stopped' : 'infra_error', `maker adapter failed: ${safeError(error)}`); }
      result.seats.maker = observedMaker(maker, result.seats.maker.requested, result.seats.maker.observed);
      if (controller.signal.aborted) return finish('stopped', 'code seats stopped during maker turn');
      if (!maker?.ok) return finish(controller.signal.aborted ? 'stopped' : 'infra_error', `maker failed: ${safeError(maker?.error)}`);
      try { await writeReceipt(receiptsDir, `maker-step-${step}.json`, maker.text); } catch (error) { return finish('infra_error', `cannot write private maker receipt: ${safeError(error)}`); }
      let message;
      try { message = parseProtocol(maker.text, limits); } catch (error) { return finish('infra_error', safeError(error)); }
      if (message.done) { done = true; break; }
      const observations = [];
      for (const action of message.actions) {
        if (controller.signal.aborted) return finish('stopped', 'code seats stopped during host action');
        if (++actions > limits.maxActions) return finish('needs_decision', 'protocol action cap reached; candidate requires a human');
        try {
          observations.push(await applyAction(action, state));
          await ensureCreatedVisible(state);
        }
        catch (error) { return finish('infra_error', `protocol action refused: ${safeError(error)}`); }
        // Preserve the exact latest candidate even if a later protocol action
        // is refused. It remains a human-inspectable worktree, never a landing.
        result.candidate = await candidate(worktree, limits);
      }
      result.protocol.actions = actions;
      history.push({ step, actions: observations });
      if (byteLength(JSON.stringify(history)) > limits.maxContextBytes) return finish('infra_error', 'complete host action history exceeds context limit; host did not truncate it');
      if (!message.actions.length) return finish('infra_error', 'maker sent neither actions nor done');
    }
    if (!done) return finish(controller.signal.aborted ? 'stopped' : 'needs_decision', 'protocol step cap reached; candidate requires a human');
    let beforeVerify;
    try { beforeVerify = await candidate(worktree, limits); result.candidate = beforeVerify; }
    catch (error) { return finish('infra_error', safeError(error)); }
    if (!beforeVerify.diff) return finish('needs_decision', 'maker completed without a candidate diff');
    if (typeof verify === 'function') {
      if (controller.signal.aborted) return finish('stopped', 'code seats stopped before verification');
      event(onEvent, 'stage', { stage: 'verify', actor: 'host', line: 'running explicit host verifier' });
      try { result.verification = safeVerification(await verify({ worktree, branch: beforeVerify.branch, head: beforeVerify.head, diff: beforeVerify.diff, signal: controller.signal, onEvent })); }
      catch (error) { return finish(controller.signal.aborted ? 'stopped' : 'infra_error', `verifier failed: ${safeError(error)}`); }
      let afterVerify;
      try { afterVerify = await candidate(worktree, limits); } catch (error) { return finish('infra_error', safeError(error)); }
      result.candidate = afterVerify;
      if (afterVerify.fingerprint !== beforeVerify.fingerprint) return finish('infra_error', 'verifier changed the candidate; advisory review refuses unstable evidence');
      if (controller.signal.aborted) return finish('stopped', 'code seats stopped during verification');
      if (!result.verification?.ran || result.verification.pass === null) return finish('infra_error', `verification was inconclusive: ${safeError(result.verification?.error)}`);
      if (result.verification.pass === false) return finish('verify_failed', result.verification.error ?? 'explicit verification did not pass');
    }
    const reads = [...state.reads.entries()].map(([path, content]) => `--- ${path} ---\n${content}`).join('\n');
    const reviewContext = `${result.candidate.diff}\n${reads}`;
    if (byteLength(reviewContext) > limits.maxReviewContextBytes) return finish('infra_error', 'complete diff plus maker-read source exceeds reviewer context limit; host did not truncate it');
    if (controller.signal.aborted) return finish('stopped', 'code seats stopped before review');
    event(onEvent, 'stage', { stage: 'review', actor: 'reviewer', line: 'reviewing complete candidate evidence' });
    const reviewerPrompt = reviewPrompt({ task: task.trim(), diff: result.candidate.diff, reads, verification: result.verification, independent: result.independence.independent });
    if (byteLength(reviewerPrompt) > limits.maxReviewContextBytes) return finish('infra_error', 'complete reviewer prompt exceeds context limit; host did not truncate it');
    let review;
    try {
      review = await fixedAdapters.reviewer({ prompt: reviewerPrompt, model: fixedSeats.reviewer.model, effort: fixedSeats.reviewer.effort ?? null, cwd: scratch, signal: controller.signal, claims: [], criteria: [], thresholds: [], receiptDir: join(receiptsDir, 'review'), expectedReported: fixedSeats.reviewer.expectedReported, onTick: (line) => event(onEvent, 'progress', { stage: 'review', actor: 'reviewer', line }), onSession: (line) => event(onEvent, 'session', { stage: 'review', actor: 'reviewer', line }) });
    } catch (error) { return finish(controller.signal.aborted ? 'stopped' : 'infra_error', `reviewer adapter failed: ${safeError(error)}`); }
    result.review = review;
    result.seats.reviewer = observedReviewer(review, result.seats.reviewer.requested);
    if (controller.signal.aborted) return finish('stopped', 'code seats stopped during review');
    if (review?.ran !== true || !['APPROVED', 'REVISE'].includes(review.verdict)) return finish('infra_error', `reviewer failed: ${safeError(review?.error)}`);
    let afterReview;
    try { afterReview = await candidate(worktree, limits); } catch (error) { return finish('infra_error', safeError(error)); }
    if (afterReview.fingerprint !== result.candidate.fingerprint) {
      result.candidate = afterReview;
      return finish('infra_error', 'candidate changed while reviewer ran; advisory verdict is stale');
    }
    // This is deliberately never "approved": clean is evidence a person may inspect.
    return finish(review.verdict === 'APPROVED' ? 'needs_decision' : 'review_unresolved', review.verdict === 'APPROVED' ? 'advisory review is clean; human decision required and no code was landed' : 'reviewer requested changes; human decision required');
  } catch (error) {
    return finish(controller.signal.aborted ? 'stopped' : 'infra_error', safeError(error));
  }
}

export const createCodeSeatsRun = runCodeSeats;
