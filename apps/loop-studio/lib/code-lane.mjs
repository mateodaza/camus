// Build lane — the studio ignites the real camus code gate and watches its
// receipts. The claude process is only the igniter: progress comes from what
// the gate persists (~/.camus/reviews round verdicts, the idSalt heartbeat),
// and the terminal verdict comes from the gate's own returned report. Camus
// is crash-safe by design, so Stop here never loses work: the gate's state
// survives and a fresh re-invocation with the same args resumes it.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateEvidencePack } from '../../../packages/trust/lib/validate.mjs';
import { sessionLineFromEvent } from './adapters/claude.mjs';
import { createGateCustodyGuard } from './gate-custody.mjs';
import { getModels } from './models.mjs';

const HARD_TIMEOUT_MS = Number(process.env.CODE_LANE_TIMEOUT_MS || 90 * 60_000);
const IDLE_KILL_MS = Number(process.env.CODE_LANE_IDLE_MS || 8 * 60_000);
const ASYNC_AWAIT_TURNS = Number(process.env.CODE_LANE_ASYNC_AWAIT_TURNS || 6);
// How long Stop waits for a SIGTERM'd igniter to exit on its own before SIGKILL.
const ABORT_GRACE_MS = Number(process.env.CODE_LANE_ABORT_GRACE_MS || 5_000);
// MEASURED, never asserted. A refusal report may only claim preservation if a before/after
// comparison proves it (audit 2026-08-06: the report said the state was preserved while HEAD had
// moved to a fresh commit). Read-only; failures degrade to nulls, which read as "unknown".
export function worktreeSnapshot(worktree) {
  if (!worktree) return { worktree: null, branch: null, head: null, dirty: null };
  const run = (args) => {
    try { return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 10_000 }).trim(); }
    catch { return null; }
  };
  return {
    worktree,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: run(['rev-parse', 'HEAD']),
    dirty: (() => { const p = run(['status', '--porcelain']); return p === null ? null : p !== ''; })(),
  };
}
export function snapshotsAgree(a, b) {
  if (!a || !b) return false;
  for (const k of ['worktree', 'branch', 'head', 'dirty']) {
    if (a[k] === null || b[k] === null) return false;   // unknown is never agreement
    if (a[k] !== b[k]) return false;
  }
  return true;
}
// The gate's review artifacts. Overridable so a test can exercise the receipt-custody seam
// against its own throwaway directory instead of the operator's real one (the same reasoning as
// STUDIO_VERIFY_SCRIPT / CAMUS_FEATS_DIR). Production never sets it.
const REVIEWS_DIR = process.env.CAMUS_REVIEW_DIR || join(homedir(), '.camus', 'reviews');

export function gateSupportsStudio({ workflow, worktreeGate }) {
  return workflow.includes('const STANDALONE_ID_SALT') && worktreeGate.includes('create|ensure|attach|resolve');
}

export function gateInstalled() {
  const root = join(homedir(), '.claude');
  const skill = join(root, 'skills', 'camus', 'SKILL.md');
  const workflow = join(root, 'workflows', 'camus-loop.workflow.js');
  const worktreeGate = join(root, 'skills', 'camus', 'scripts', 'wt.sh');
  if (![skill, workflow, worktreeGate].every(existsSync)) return false;
  try {
    return gateSupportsStudio({ workflow: readFileSync(workflow, 'utf8'), worktreeGate: readFileSync(worktreeGate, 'utf8') });
  } catch {
    return false;
  }
}

export function gateArgsForRun(run, roundCap, humanAnswer = null) {
  const contract = typeof run.acceptanceContract === 'string' && run.acceptanceContract.trim()
    ? `\n\nAcceptance contract (binding):\n${run.acceptanceContract.trim()}`
    : '';
  const args = {
    task: `${run.goal}${contract}`,
    targetPath: run.targetPath,
    policy: 'ask_on_ambiguity',
    roundCap,
    identitySalt: run.idSalt,
  };
  // Pin the maker (executor) THROUGH the loop's JSON contract — the workflow uses
  // args.model as the think-model override. Pinning the outer `claude -p` would
  // pin only the igniter, not Camus's executor. Taken from the run-start snapshot.
  const maker = run.models?.maker?.model;
  if (typeof maker === 'string' && maker) args.model = maker;
  // The reviewer identity travels as an ARGUMENT because the workflow runtime
  // cannot read the environment: it needs the value to verify that the review
  // which ran is the review it asked for (field report 2026-08-04). CAMUS_CODEX_MODEL
  // still carries it to the script; this is the independent expectation.
  const reviewer = run.models?.reviewer?.model;
  if (typeof reviewer === 'string' && reviewer) args.reviewerModel = reviewer;
  args.reviewerBackend = 'codex';
  // Forward the pinned reviewer EFFORT so the displayed pairing is the executed
  // one: a run launched at low effort must review at low every round, not have
  // the loop's adaptive escalation quietly raise it (that would make Studio's
  // shown "low" a lie). Absent, the loop keeps its adaptive medium→high→xhigh
  // behavior for direct callers who chose not to pin.
  const effort = run.models?.reviewer?.effort;
  if (typeof effort === 'string' && effort) args.reviewerEffort = effort;
  // Per-run verify command snapshot: some repos need a host-scoped command
  // (a .NET solution behind a workload, a monorepo task runner). The gate accepts
  // args.verifyCmd, and Studio preserves whatever the run was launched with so a
  // resume verifies the same way the original did.
  if (typeof run.verifyCmd === 'string' && run.verifyCmd.trim()) args.verifyCmd = run.verifyCmd.trim();
  if (humanAnswer) args.humanAnswer = humanAnswer;
  return args;
}

const GATE_CUSTODY_PROMPT = `You are only the Camus Studio gate igniter. The /camus-loop invocation and every JSON argument are a binding custody contract. Start exactly one fresh camus-loop workflow. If it returns an asynchronous handle, resume only that same workflow run with the exact same args. Never start a second fresh workflow, alter or omit an arg, use another tool, inspect or repair the repository yourself, or work around an infra error. Return the workflow's terminal report verbatim; Studio owns every retry.`;

// The resumed session may come back with its DEFERRED TOOLS UNLOADED, so Workflow
// is not callable until it is rehydrated. Left to improvise, the model invents a
// discovery call the custody guard cannot distinguish from an escape, and the run
// dies mid-implement (WP6 dogfood 20260805-062823-zoi8: three files written, no
// review). So the recovery is SPELLED OUT here — one exact call, in the one form
// the guard permits — instead of being guessed. Anything else is still refused.
const GATE_AWAIT_PROMPT = `Your prior Camus Workflow call returned asynchronously. Do not start another workflow and do not answer with a progress summary.

If the Workflow tool is already available, immediately resume the prior handle.

If the Workflow tool is NOT loaded in this resumed session, recover it with EXACTLY this one call, once:
  ToolSearch with query "select:Workflow" and max_results 1
Do not vary that query, do not add other fields, do not search for anything else, and do not call ToolSearch a second time. Any other discovery call is a custody violation that kills this run.

Then use the prior Workflow handle to resume that exact same run with the original byte-equivalent args (same resumeFromRunId, same scriptPath, same args JSON). Keep resuming only that run until it returns its terminal report, then return that report verbatim.`;

const CLAUDE_AUTH_FAILURE_NOTE = 'Claude Code authentication failed before Camus could start. Run `claude auth login` in Terminal, then choose Resume the gate.';

// `claude auth status` can report logged-in while an expired/stale session gets
// a real 401 from inference. The stream is the authoritative signal. Keep this
// deliberately narrow: an auth failure gets an actionable diagnosis, while any
// other no-tool response still fails under the custody guard.
export function claudeAuthFailureNote(event) {
  if (!event || typeof event !== 'object') return null;
  const status = Number(event.error_status ?? event.api_error_status);
  const text = [
    event.error,
    event.result,
    ...(event.message?.content ?? []).map((item) => item?.text),
  ].filter((value) => typeof value === 'string').join(' ');
  if (status === 401 || /authentication_failed|failed to authenticate|invalid authentication credentials/i.test(text)) {
    return CLAUDE_AUTH_FAILURE_NOTE;
  }
  return null;
}

// Close-time precedence is part of the trust boundary. A real custody
// violation still wins, except for the narrower case where authentication
// prevented the very first Workflow call: there was no custody to violate yet,
// and hiding the 401 would send the user toward the wrong repair.
// A custody refusal SIGKILLs the igniter, which also ends the inner Workflow —
// so the run's state stops being resumable-in-place even though the WORK on disk
// (worktree, branch, files the implement phase already wrote) survives untouched.
// WP6 dogfood 20260805-062823-zoi8 lost three implemented files to a receipt that
// said only "gate custody refused", with no statement of what survived and no
// warning that plain Resume would re-run the same defect. This builds the honest
// recovery note: the specific reason, what is still on disk, the bound run
// identity, and whether retrying is actually safe. Pure, so it is directly
// testable and cannot drift from the guard.
export function custodyRefusalReport({ custodyError, workflowRunId = null, worktree = null, branch = null, phase = null, repeatable = true }) {
  const survived = worktree
    ? `The candidate worktree survives at ${worktree}${branch ? ` (branch ${branch})` : ''}${phase ? `, last phase ${phase}` : ''}; nothing there was reverted.`
    : 'Any worktree the gate already created survives on disk; nothing was reverted.';
  const anchor = workflowRunId
    ? `The inner workflow run ${workflowRunId} was killed with the igniter, so it cannot be resumed in place.`
    : 'No workflow run was bound before the refusal, so there is nothing to resume in place.';
  // Retrying the same shape usually reproduces a custody defect rather than
  // getting past it, so this refuses to recommend the generic Resume button.
  const guidance = repeatable
    ? 'Resume would start the same igniter shape and most likely repeat this refusal — inspect the surviving worktree and fix the custody path before retrying.'
    : 'Resume is safe to retry: this refusal was not caused by the igniter contract itself.';
  return { status: 'infra_error', note: `${custodyError}. ${anchor} ${survived} ${guidance}` };
}

export function gateProcessClose({ code, authFailureNote, custody }) {
  const snapshot = custody.snapshot();
  if (authFailureNote && snapshot.freshCalls === 0 && !snapshot.violation) {
    return { exitCode: -6, custodyError: null };
  }
  const custodyError = custody.finish();
  return { exitCode: custodyError ? -5 : (code ?? -1), custodyError };
}

// THE OUTER IGNITER'S BOUNDARY IS CALLER-SCOPED, NOT PROCESS-WIDE.
// Three measurements shaped this, in order:
//  1. `--allowedTools Workflow` is not a boundary at all: an igniter under it read a file with
//     Read and, once Read was denied, read the same file through Bash.
//  2. `--disallowedTools` does refuse before execution — but it is INHERITED by the workflow's own
//     agents. Production run 20260806-191749-6wxl reached the real Camus planner, which reported
//     "Bash is disabled; no Read/Grep/Glob or filesystem MCP tool is exposed": the outer boundary
//     starved the workflow it exists to protect. (An earlier probe suggested otherwise; its canary
//     string sat in the prompt, so the inner agent could echo it without running anything. Repeated
//     with a secret that only exists on disk, the inner agent reported itself blocked.)
//  3. A PreToolUse hook CAN tell the callers apart: a subagent's tool call carries `agent_id` and
//     `agent_type`, the outer main-loop agent's carries neither. Same tool name, different answer
//     depending on who asked — which is exactly the scope this needs.
// So the boundary is a hook, passed through `--settings` as inline JSON so it lives and dies with
// this igniter process and never touches the operator's own settings. Verified end to end with a
// secret readable only from disk: the outer Read was denied, the inner agent returned the secret.
// The custody guard downstream is unchanged and remains the second layer.
const IGNITER_GUARD_HOOK = fileURLToPath(new URL('./igniter-tool-guard.mjs', import.meta.url));

export function igniterGuardSettings(hookPath = IGNITER_GUARD_HOOK) {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}` }] }],
    },
  });
}

export function gateIgniterCliArgs(invocation) {
  return [
    '-p', invocation,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    '--settings', igniterGuardSettings(),
    // Do not narrow the process-wide built-in surface with --tools. Claude's
    // Workflow runtime inherits that surface, so "--tools Workflow" also
    // strips Bash/Read/Edit from camus-loop's child agents and makes the gate
    // fail before it can create its worktree. The system contract plus the
    // stream custody guard below constrain the OUTER igniter; the workflow
    // keeps the tools it needs to implement and verify.
    '--allowedTools', 'Workflow',
    '--append-system-prompt', GATE_CUSTODY_PROMPT,
  ];
}

export function gateIgniterResumeCliArgs(sessionId) {
  return [
    '-p', GATE_AWAIT_PROMPT,
    '--resume', sessionId,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    // The reattach turns need the boundary MORE than the first one: this is where an igniter
    // that has been waiting starts inventing work to do (run 20260806-164809-hiju, at Verify).
    '--settings', igniterGuardSettings(),
    '--allowedTools', 'Workflow',
    '--append-system-prompt', GATE_CUSTODY_PROMPT,
  ];
}

export function claudeSessionIdFromEvent(event) {
  const id = event?.type === 'system' && event?.subtype === 'init' ? event.session_id : null;
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

// Cheap, spend-free refusals before any model runs. The gate itself refuses
// more (unborn HEAD, dirty preflight, env checks) — those surface from its
// own report; these just save the user a spawn.
export async function validateBuildTarget(rawPath) {
  const path = rawPath?.trim().replace(/^~(?=\/|$)/, homedir());
  if (!path) return { ok: false, error: 'A build run needs the path to a git repository on this machine.' };
  if (/["'`$\\\n]/.test(path)) return { ok: false, error: 'The path contains shell-unsafe characters (quotes, $, backticks); the gate refuses those.' };
  if (!existsSync(path)) return { ok: false, error: `No such directory: ${path}` };
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) return { ok: false, error: `${path} is not a directory.` };

  const git = (args) =>
    new Promise((resolve) => execFile('git', ['-C', path, ...args], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim())));
  if ((await git(['rev-parse', '--git-dir'])) === null) {
    return { ok: false, error: `${path} is not a git repository; the gate only works inside one.` };
  }
  if ((await git(['symbolic-ref', '-q', 'HEAD'])) === null) {
    return { ok: false, error: `${path} is on a detached HEAD. Check out a branch first; the gate refuses detached HEADs.` };
  }
  const toplevel = await git(['rev-parse', '--show-toplevel']);
  return { ok: true, path, toplevel };
}

// The gate's answer comes back as prose wrapping a report object. Extract
// fail-closed: a run whose status we cannot read is NEVER done.
// This list is the EXHAUSTIVE set of camus-loop terminal statuses (plus the
// pause statuses older gates emit). The live smoke's P0 came from a gap here:
// no_changes was missing, the parseable report was discarded, and the prose
// fallback matched the word "done" inside its own note "never a false done" —
// a fabricated green. Exhaustiveness is a contract, not an optimization.
const GATE_STATUSES = ['done_with_findings', 'needs_human', 'needs_decision', 'review_unresolved', 'verify_failed', 'verify_inconclusive', 'infra_error', 'paused_by_user', 'no_changes', 'aborted', 'done'];

export function parseGateReport(text) {
  const statuses = GATE_STATUSES;
  let report = null;
  let structuredUnknown = null; // a parseable report whose status Studio does not know
  // Prefer a parseable JSON object that carries a known status: try flat
  // objects first, then the greedy whole-text candidate.
  const candidates = [...(text.match(/\{[^{}]*\}/g) ?? []), ...(text.match(/\{[\s\S]*\}/) ?? [])];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && statuses.includes(obj.status)) { report = obj; break; }
      if (!structuredUnknown && obj && typeof obj.status === 'string' && obj.status) structuredUnknown = obj;
    } catch { /* not this one */ }
  }
  // A structured report Studio cannot classify is an INFRA fact, not license to
  // guess: token matching over the same text must never override it (the exact
  // P0 path — an unrecognized status falling through to a prose match).
  if (!report && structuredUnknown) {
    return { status: 'infra_error', note: `gate returned a structured status Studio does not recognize: "${structuredUnknown.status}"; refused fail-closed, never re-guessed from prose`, raw: text.slice(0, 400) };
  }
  if (!report) {
    // Statuses are ordered longest-first, so done_with_findings wins over
    // done. Camus prose wraps statuses in backticks or brackets and a status
    // can end the output — all of those count as boundaries.
    const found = statuses.find((st) => new RegExp(`(^|[\`"'\\s:{,(\\[])${st}($|[\`"'\\s,.;)\\]}])`).test(text));
    if (found) report = { status: found };
  }
  if (!report) return { status: 'infra_error', note: 'gate returned no readable status', raw: text.slice(0, 400) };
  // Pull the human question when the gate paused for one.
  if ((report.status === 'needs_human' || report.status === 'needs_decision') && !report.question) {
    const q = text.match(/"question"\s*:\s*"([^"]{10,400})"/) || text.match(/question[:\s]+["“]([^"”]{10,400})["”]/i);
    if (q) report.question = q[1];
  }
  return report;
}

function objectFrom(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PRIORITY_SEVERITY = Object.freeze({ 0: 'high', 1: 'high', 2: 'medium', 3: 'low' });

// Camus review files are envelopes: current gates persist the Codex verdict
// under codex_parsed, while older receipts may carry that object at the root
// or as stringified codex_raw. Normalize all known shapes once so the UI and
// sealed evidence cannot quietly disagree about what the auditor said.
export function reviewEventFromGateReceipt(raw, round) {
  const envelope = objectFrom(raw) ?? {};
  const parsed = objectFrom(envelope.codex_parsed)
    ?? objectFrom(envelope.codex_raw)
    ?? envelope;
  const rawVerdict = typeof parsed.overall_correctness === 'string' ? parsed.overall_correctness : null;
  const verdict = rawVerdict === 'patch is correct'
    ? 'APPROVED'
    : rawVerdict === 'patch is incorrect'
      ? 'REVISE'
      : 'UNKNOWN';
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map((finding) => {
    const priority = Number.isInteger(finding?.priority) ? finding.priority : null;
    return {
      severity: PRIORITY_SEVERITY[priority] ?? 'medium',
      priority,
      title: typeof finding?.title === 'string' ? finding.title : 'Untitled finding',
      detail: typeof finding?.detail === 'string' ? finding.detail : (typeof finding?.body === 'string' ? finding.body : ''),
      suggestion: typeof finding?.suggestion === 'string' ? finding.suggestion : '',
      location: typeof finding?.code_location === 'string' ? finding.code_location : null,
      confidence: typeof finding?.confidence_score === 'number' ? finding.confidence_score : null,
    };
  }) : [];
  return {
    round,
    verdict,
    rawVerdict,
    confidence: typeof parsed.overall_confidence_score === 'number' ? parsed.overall_confidence_score : null,
    explanation: typeof parsed.overall_explanation === 'string' ? parsed.overall_explanation : null,
    findings,
    source: 'camus_gate_review',
    // The reviewer's ACTUAL model and effort — only from a review that actually
    // ran (ran===true) carrying the recorded values. Unknown evidence never
    // becomes a claimed identity, and the snapshot's requested effort is never
    // substituted for the effort the gate really ran at (live smoke P1).
    reviewerModel: envelope.ran === true && typeof envelope.reviewer_model === 'string' && envelope.reviewer_model ? envelope.reviewer_model : null,
    reviewerEffort: envelope.ran === true && typeof envelope.reviewer_effort === 'string' && envelope.reviewer_effort ? envelope.reviewer_effort : null,
  };
}

// camus-loop numbers its review rounds from 1 through the frozen cap. The
// reviewer script itself defaults a missing round argument to 0 for direct or
// legacy invocations, so a global r0 audit beside the same worktree is not
// evidence from this gate run and must never enter Studio's timeline.
export function gateReviewRoundInRange(round, roundCap) {
  return Number.isInteger(round)
    && Number.isInteger(roundCap)
    && round >= 1
    && round <= roundCap;
}

// Which receipt this run is allowed to consume NEXT.
//
// Range alone was not enough (field report 2026-08-04, a WP6 game run): the
// gate requested round 2, its thin runner dropped the round argument, the
// reviewer script defaulted to r0, and the loop accepted that receipt as round
// 2. Studio's own timeline hid the r0 file and showed only r1, so the operator
// could not see the substitution either. Two rules now apply, and a violation
// is INFRA — it never advances the review loop:
//
//   1. SEQUENCE — only the next expected round is consumable. A repeat, a skip,
//      or an out-of-range round is refused, so a stray or re-run receipt can
//      never stand in for the round the gate actually asked for.
//   2. BINDING — when the receipt carries the reviewer's binding block, it must
//      say it ran the round it was asked for, in this worktree, under this
//      gate's nonce. A receipt whose own binding says `bound: false` is refused
//      outright.
//
// A receipt with NO binding comes from a gate installed before the binding
// existed. It stays consumable (a mid-flight run must be resumable) but is
// reported `unbound: true` so the caller can say plainly that this round's
// provenance rests on its filename alone. Pure, so the rule is directly
// testable and shared by the watcher and its regression test.
export function acceptGateReceipt({
  round,
  expectedRound,
  roundCap,
  binding = null,
  worktreeCanonical = null,
  runWorktree = null,
  nonce = null,
  // Studio's OWN run-start snapshot. Comparing requested-vs-actual *inside* the
  // receipt only proves the receipt is self-consistent — which the field failure
  // already was. These are the values Studio decided before the gate started.
  expectedEffort = null,
  expectedReviewerModel = null,
  // A gate that emits bindings must always emit one. Once this run has seen a
  // bound receipt (or knows its nonce), a later unbound receipt is a refusal,
  // not a legacy read.
  requireBinding = false,
} = {}) {
  const reject = (reason) => ({ accept: false, reason, unbound: false });
  if (!gateReviewRoundInRange(round, roundCap)) {
    return reject(`review receipt names round ${JSON.stringify(round)}, which is outside this run's rounds 1..${roundCap}`);
  }
  if (Number.isInteger(expectedRound) && round !== expectedRound) {
    return reject(`review receipt is round ${round} but this run expects round ${expectedRound} next; a receipt for another round is never consumed as this one`);
  }
  if (binding === null || binding === undefined) {
    // A newly installed gate always binds. So an unbound receipt is only ever a
    // pre-binding gate — readable, but it may not AUTHORIZE this run once we
    // know this gate does bind.
    if (requireBinding) {
      return reject('review receipt carries no binding block, but this run has already seen bound receipts from this gate; an unbound receipt cannot authorize a round');
    }
    return { accept: true, reason: null, unbound: true };
  }
  if (typeof binding !== 'object' || Array.isArray(binding)) {
    return reject('review receipt carries a malformed binding block');
  }
  if (binding.bound !== true) {
    return reject(`the reviewer's own binding reports the invocation was not bound (requested round ${JSON.stringify(binding.round_requested)} / effort ${JSON.stringify(binding.effort_requested)}, actual round ${JSON.stringify(binding.round_actual)} / effort ${JSON.stringify(binding.effort_actual)})`);
  }
  if (binding.round_requested !== round) {
    return reject(`review receipt is filed as round ${round} but its binding was requested for round ${JSON.stringify(binding.round_requested)}`);
  }
  // The nonce is only checked when this run HAS one — an older gate that never
  // emitted one must not be failed for a field it cannot produce.
  if (nonce && binding.gate_nonce && binding.gate_nonce !== nonce) {
    return reject(`review receipt belongs to gate run ${binding.gate_nonce}, not this one (${nonce})`);
  }
  if (runWorktree && worktreeCanonical && worktreeCanonical !== runWorktree) {
    return reject(`review receipt was produced in ${worktreeCanonical}, not this run's worktree ${runWorktree}`);
  }
  // Against STUDIO'S snapshot, not the receipt's own account of itself.
  if (expectedEffort && binding.effort_actual && binding.effort_actual !== expectedEffort) {
    return reject(`review ran at effort ${JSON.stringify(binding.effort_actual)} but this run requested ${JSON.stringify(expectedEffort)}`);
  }
  if (expectedReviewerModel && binding.reviewer_model && binding.reviewer_model !== expectedReviewerModel) {
    return reject(`review ran under reviewer ${JSON.stringify(binding.reviewer_model)} but this run pinned ${JSON.stringify(expectedReviewerModel)}`);
  }
  // A binding that omits the very fields Studio must check is not usable
  // provenance — fail closed rather than passing on absence.
  if (expectedReviewerModel && !binding.reviewer_model) {
    return reject('review receipt records no reviewer model, so it cannot be checked against this run\'s pinned reviewer');
  }
  if (nonce && !binding.gate_nonce) {
    return reject('review receipt records no gate nonce, so it cannot be tied to this run');
  }
  return { accept: true, reason: null, unbound: false };
}

// The gate's own phase, read from the session lines it already streams. Studio
// showed only "Igniting…" for ten minutes while the gate classified, planned,
// built a worktree, wrote three files and started reviewing (field report
// 2026-08-04). These markers are the gate's real commands, so the phase is
// observed rather than guessed; an unrecognized line leaves the phase alone.
export function gatePhaseFromSession(line) {
  const text = String(line ?? '');
  if (/\bwt\.sh\s+create\b/.test(text)) return 'worktree';
  if (/\b(review|codex_review)\.sh\b/.test(text)) return 'review';
  if (/\bverify\.(sh|py)\b/.test(text)) return 'verify';
  if (/\bcommit\.sh\b/.test(text)) return 'commit';
  if (/\bmerge\.sh\b|\bland\.py\b/.test(text)) return 'land';
  if (/\bprep\.(sh|py)\b|\bfeat_scan\.py\b/.test(text)) return 'classify';
  if (/^(Edit|Write|MultiEdit|NotebookEdit):/.test(text)) return 'implement';
  if (/\bsteer(_read)?\.py\b|\bstatus\.py\b/.test(text)) return null; // bookkeeping, not a phase
  return null;
}

// The newest trustworthy activity across every signal, with its source named.
// A single phase-entry `touch` of the heartbeat file is NOT continuous liveness:
// during a long Implement the heartbeat went stale while game files were being
// written, and the idle watchdog killed live work (field report 2026-08-04).
// Every entry here is evidence the gate is still doing something — stdout, a
// heartbeat, a growing review event stream, or changed files in the worktree.
export function newestActivity(signals) {
  let best = { at: 0, source: 'none' };
  for (const [source, at] of Object.entries(signals ?? {})) {
    if (Number.isFinite(at) && at > best.at) best = { at, source };
  }
  return best;
}

// A successful gate status is a contract: camus-loop only returns done after
// deterministic verify passes. Preserve that provenance instead of inventing
// check counts the outer Workflow does not expose.
export function verifyEventFromGateReport(report) {
  if (!report || typeof report !== 'object') return null;
  const pass = ['done', 'done_with_findings'].includes(report.status)
    ? true
    : report.status === 'verify_failed'
      ? false
      : report.status === 'verify_inconclusive'
        ? null
        : undefined;
  if (pass === undefined) return null;
  return {
    pass,
    warnings: null,
    skipped: null,
    source: 'gate_report_status',
    derived: true,
    commitSha: report.commit_sha ?? report.commit ?? null,
    detail: report.note ?? null,
  };
}

// The newest mtime under a directory, bounded so a large game repo cannot make
// the 5s liveness poll expensive. Skips VCS/dependency noise, which changes for
// reasons unrelated to the gate working. Returns 0 when nothing is readable.
export async function newestFileMtime(dir, { maxEntries = 400, maxDepth = 3, skip = /^(\.git|node_modules|\.venv|__pycache__|dist|build|target|Library|Temp|obj)$/ } = {}) {
  let newest = 0;
  let budget = maxEntries;
  const walk = async (path, depth) => {
    if (budget <= 0 || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      if (skip.test(entry.name)) continue;
      budget -= 1;
      const child = join(path, entry.name);
      const st = await stat(child).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (entry.isDirectory()) await walk(child, depth + 1);
    }
  };
  await walk(dir, 0);
  return newest;
}

// The gate's durable status record, written by status_record.py under the run's
// identity salt. This is what makes phase, worktree, branch, expected round and
// effort, and the gate nonce knowable BEFORE any review receipt exists — the gap
// that left Studio showing "Igniting…" and its watchdog blind (field report
// 2026-08-04).
export async function readGateStatus(idSalt, { feats = null } = {}) {
  if (!idSalt) return null;
  const dir = feats ?? process.env.CAMUS_FEATS_DIR ?? join(homedir(), '.camus', 'feats');
  try {
    const record = JSON.parse(await readFile(join(dir, `${idSalt}.status.json`), 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

// The run-state the watcher adopts from a durable status record. Exported so the
// mapping under test is the one the watcher calls — a test that re-derives it
// would pass while the wiring rotted (audit note 2026-08-04).
export function gateStateFromStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const worktree = typeof status.worktree === 'string' && status.worktree.trim() ? status.worktree : null;
  return {
    worktree,
    prefix: prefixFromWorktree(worktree),
    nonce: typeof status.nonce === 'string' && status.nonce.trim() ? status.nonce : null,
    phase: typeof status.phase === 'string' && status.phase.trim() ? status.phase.toLowerCase() : null,
    branch: typeof status.branch === 'string' && status.branch.trim() ? status.branch : null,
    progressAt: Number.isInteger(status.last_progress_at) ? status.last_progress_at * 1000 : 0,
    effort: typeof status.effort === 'string' && status.effort.trim() ? status.effort : null,
  };
}

// The worktree basename is the review-receipt prefix, so a status record makes
// the run's owned prefix knowable before the first receipt lands.
export const prefixFromWorktree = (worktree) =>
  typeof worktree === 'string' && worktree.trim()
    ? worktree.replace(/\/+$/, '').split('/').pop() || null
    : null;

// Does this pid still belong to the process the handle recorded? A pid is
// recycled after the process exits, so "the pid in an old handle is alive" is not
// evidence that OUR reviewer is alive — killing on that alone can kill an
// unrelated process. Require the observed start time to sit at/after the handle's
// timestamp and within a sane window of it.
export async function pidMatchesHandle(pid, startedAt, { probe = null } = {}) {
  if (!pidAlive(pid)) return false;
  if (!Number.isInteger(startedAt)) return false; // no recorded start → cannot claim identity
  const read = probe ?? (() => new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  }));
  const lstart = await read(pid);
  if (!lstart) return false;
  const started = Date.parse(lstart);
  if (!Number.isFinite(started)) return false;
  const handleMs = startedAt * 1000;
  // The handle is written IMMEDIATELY after spawn, so the process start sits at
  // or just before the handle timestamp. `ps` reports whole seconds; allow a
  // ±15s window and nothing more — a looser window (the first cut allowed +120s)
  // would let a process started two minutes later pass as ours.
  return Math.abs(started - handleMs) <= 15_000;
}

// Identity for a LEADERLESS group: any live member whose start time sits at or
// after the handle's recorded start (±15s ps granularity) was spawned by our
// leader, so the group is still the reviewer this handle describes. A group
// whose members all predate the handle is a reused pgid — a stranger.
export async function groupMatchesHandle(pgid, startedAt, { listPids = null, probe = null } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0 || !Number.isInteger(startedAt)) return false;
  // While the LEADER is alive, its own lstart is the only identity authority
  // (pidMatchesHandle) — a live pid==pgid process whose start mismatches the
  // handle is a RECYCLED pid wearing our number, and its group members are the
  // stranger's children, not ours. Member-based identity applies only once the
  // leader is dead: POSIX keeps a pid reserved while it remains the pgid of a
  // live group, so leaderless members can only be remnants of OUR group.
  if (pidAlive(pgid)) return false;
  const list = listPids ?? (() => new Promise((resolve) => {
    execFile('ps', ['-g', String(pgid), '-o', 'pid='], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0));
    });
  }));
  const members = await list(pgid);
  if (!Array.isArray(members) || !members.length) return false;
  for (const pid of members) {
    if (await pidMatchesHandle(pid, startedAt, probe ? { probe } : {})) return true;
    // Not started WITH the leader — but a child spawned LATER is still ours if it
    // began after our recorded start. Read its lstart directly for that laxer bound.
    const read = probe ?? ((p) => new Promise((resolve) => {
      execFile('ps', ['-p', String(p), '-o', 'lstart='], { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
    }));
    const lstart = await read(pid);
    const started = lstart ? Date.parse(lstart) : NaN;
    if (Number.isFinite(started) && started >= startedAt * 1000 - 15_000) return true;
  }
  return false;
}

// Every watch directory this run owns, with its live handle. A `.watch` dir is
// the gate's detached reviewer: handle.json carries the pid, and `review.sh
// abort <dir>` is the gate's own documented way to end it.
export async function ownedReviewWatches(prefix) {
  if (!prefix) return [];
  const out = [];
  let files;
  try {
    files = await readdir(REVIEWS_DIR);
  } catch {
    return [];
  }
  for (const name of files) {
    const m = name.match(/^(.*)-r(\d+)\.watch$/);
    if (!m || m[1] !== prefix) continue;
    const dir = join(REVIEWS_DIR, name);
    const handle = await readFile(join(dir, 'handle.json'), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
    const events = await stat(join(dir, 'events.jsonl')).catch(() => null);
    // A watch dir with an exit_code is a COMPLETED reviewer. Its recorded pid has
    // already been reaped and may since have been reused by an unrelated process,
    // so it must never be a termination target.
    const exitCode = await readFile(join(dir, 'exit_code'), 'utf8').then((t) => t.trim()).catch(() => null);
    out.push({
      dir,
      round: Number(m[2]),
      pid: Number.isInteger(handle?.pid) ? handle.pid : null,
      startedAt: Number.isInteger(handle?.started_at) ? handle.started_at : null,
      completed: exitCode !== null && exitCode !== '',
      eventsMtime: events ? events.mtimeMs : 0,
    });
  }
  return out;
}

// Is that pid still alive? signal 0 tests existence without touching it. A pid
// we are not permitted to signal (EPERM) is still ALIVE — treating it as gone
// would be exactly the false cleanup this guard exists to prevent.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// review_watch starts each reviewer with start_new_session, so the recorded pid is
// a PROCESS GROUP LEADER and codex's own children live in that group. Checking the
// leader alone declared victory while the group was still running — Studio said
// "ended 1/1 detached reviewer" over a live codex group (20260805-072933-jezu).
// A group is gone only when NO member remains. `ps -g` lists the whole group;
// falling back to the leader check keeps this honest where ps is unavailable.
export function processGroupAlive(pgid, { ps = null } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  const run = ps ?? ((id) => {
    try {
      return execFileSync('ps', ['-g', String(id), '-o', 'pid='], { encoding: 'utf8', timeout: 5_000 });
    } catch {
      return null; // ps failed or matched nothing
    }
  });
  const out = run(pgid);
  if (out === null || out === undefined) return pidAlive(pgid); // ps unusable → leader is all we know
  return String(out).split('\n').some((line) => /\d/.test(line));
}

// Stop must OWN the reviewer it started. The gate runs review detached, so
// killing Studio's igniter left a codex wrapper reparented to PID 1 while
// Studio sealed a clean `stopped` (field report 2026-08-04). Abort each owned
// watch through the gate's own abort form, then PROVE the pid is gone. What
// cannot be proven is reported as an orphan, never as a clean stop.
export async function abortOwnedReviewers(prefix, { timeoutMs = 20_000, scriptPath = null, matchPid = pidMatchesHandle, matchGroup = groupMatchesHandle, groupAlive = processGroupAlive } = {}) {
  const all = await ownedReviewWatches(prefix);
  const watches = [];
  for (const w of all) {
    if (w.completed) continue;            // finished reviewer: nothing of ours is running
    // Liveness is the GROUP, not the leader: codex children survive a leader
    // that exits first, and skipping such a group returned a false clean
    // (field report 2026-08-05).
    if (w.pid === null || !groupAlive(w.pid)) continue;
    // Only act on a group we can still IDENTIFY as the reviewer this handle
    // describes: the leader matching the handle, or — when the leader is gone —
    // a surviving member provably spawned at/after our start. An unverifiable
    // group is reported, never signalled.
    const mine = (await matchPid(w.pid, w.startedAt)) || (await matchGroup(w.pid, w.startedAt));
    watches.push({ ...w, identityVerified: mine });
  }
  if (!watches.length) return { attempted: [], orphans: [], clean: true };
  const script = scriptPath ?? join(homedir(), '.claude', 'skills', 'camus', 'scripts', 'review.sh');
  const attempted = [];
  for (const watch of watches) {
    let aborted = false;
    let note = null;
    // IDENTITY FIRST, always. `review.sh abort` terminates the pid its handle
    // records, so invoking it on an unverified handle is the same recycled-pid
    // hazard as signalling directly — a stranger could die. An unverified live
    // pid gets NO abort form, NO signal: it stays alive and is reported as an
    // orphan, which makes the stop clean:false rather than a false clean.
    if (!watch.identityVerified) {
      note = `pid ${watch.pid} is alive but could not be confirmed as this run's reviewer (recycled pid?); neither the abort form nor any signal was sent`;
      attempted.push({ ...watch, aborted: false, note, stillAlive: groupAlive(watch.pid) });
      continue;
    }
    if (existsSync(script)) {
      aborted = await new Promise((resolve) => {
        execFile('bash', [script, 'abort', watch.dir], { timeout: timeoutMs }, (err) => resolve(!err));
      });
      if (!aborted) note = 'the gate abort form failed or timed out';
    } else {
      note = `the gate abort script is not installed at ${script}`;
    }
    // The abort form is the polite path; a surviving verified pid still has to
    // die, and an unkillable one has to be REPORTED rather than quietly left.
    if (groupAlive(watch.pid)) {
      // Signal the GROUP (negative pid): the leader may already be gone, and
      // killing only it would leave codex's children running — the exact false
      // "ended 1/1" claim. Falls back to the leader pid where killpg fails.
      const signalGroup = (sig) => {
        try { process.kill(-watch.pid, sig); } catch {
          try { process.kill(watch.pid, sig); } catch { /* already gone or not ours */ }
        }
      };
      signalGroup('SIGTERM');
      const deadline = Date.now() + 3000;
      while (groupAlive(watch.pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (groupAlive(watch.pid)) {
        signalGroup('SIGKILL');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // Survival is judged on the whole GROUP: codex's children outlive a dead leader.
    attempted.push({ ...watch, aborted, note, stillAlive: groupAlive(watch.pid) });
  }
  const orphans = attempted.filter((a) => a.stillAlive);
  return { attempted, orphans, clean: orphans.length === 0 };
}

async function reviewRoundsSince(t0) {
  try {
    const files = await readdir(REVIEWS_DIR);
    const rounds = [];
    for (const f of files) {
      const m = f.match(/-r(\d+)\.json$/);
      if (!m) continue;
      const st = await stat(join(REVIEWS_DIR, f)).catch(() => null);
      if (st && st.mtimeMs >= t0) rounds.push({ file: f, round: Number(m[1]), mtime: st.mtimeMs });
    }
    return rounds.sort((a, b) => a.mtime - b.mtime);
  } catch {
    return [];
  }
}

// Classify a terminal gate report into a Studio outcome, and run the pragmatic
// decision flow when a review did not converge (north star, 2026-08-04). Pulled
// out of runCodeLoop so the Refine RE-ENTRY is directly testable: `igniteGate` is
// injected, so a test drives a Refine → new-report cycle without spawning claude.
// The Refine loop re-classifies each NEW report from the top — a Refine that
// returns another review_unresolved re-enters the decision, it does not fall
// through to a stale outcome (the exact field failure).
// Re-run deterministic verification against a parked candidate, HOST-SIDE: the
// gate's own verify.sh, with the run's verifyCmd snapshot when it has one. No
// agent and no model turn — a re-verify is a command, not a conversation.
// The verifier prints ONE json object on stdout, but its guard can print ahead of
// it and a shell can add noise, so the object is extracted rather than assumed to
// be the whole stream. Greedy first: the real result nests objects in
// failures/checks, which a brace-free pattern cannot match.
export function extractVerifyResult(text) {
  const s = String(text ?? '');
  for (const c of [...(s.match(/\{[\s\S]*\}/g) ?? []), ...(s.match(/\{[^{}]*\}/g) ?? [])]) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.pass === 'boolean') return obj;
    } catch { /* not this one */ }
  }
  return null;
}

// STOP OWNS THE VERIFIER. A `dotnet test` sweep runs for minutes; without this the
// verifier was started with execFile and no signal, so Stop only marked the run and
// then waited for the command to finish on its own — up to the 15-minute timeout,
// with test processes still churning inside the operator's worktree (audit
// 2026-08-05). So the verifier is its own process GROUP leader and Stop ends the
// group TERM→KILL, then proves nothing is left.
const VERIFY_TERM_GRACE_MS = Number(process.env.STUDIO_VERIFY_TERM_GRACE_MS || 3000);
const VERIFY_KILL_GRACE_MS = Number(process.env.STUDIO_VERIFY_KILL_GRACE_MS || 2000);

export const groupIsGone = (pgid) => {
  try { process.kill(-pgid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
};

export function makeCandidateVerifier({
  worktree, verifyCmd = null, scriptPath = null, timeoutMs = 900_000,
  signal = null, termGraceMs = VERIFY_TERM_GRACE_MS, killGraceMs = VERIFY_KILL_GRACE_MS,
  groupGone = groupIsGone,
} = {}) {
  return async () => {
    if (!worktree) return { ran: false, error: 'no parked worktree to verify' };
    // The installed gate script, unless an operator points elsewhere. The env hook
    // exists because the script's target guard is anchored to the CALLER's repo, so
    // a harness verifying a repo other than this one needs its own entry point.
    const script = scriptPath ?? process.env.STUDIO_VERIFY_SCRIPT
      ?? join(homedir(), '.claude', 'skills', 'camus', 'scripts', 'verify.sh');
    if (!existsSync(script)) return { ran: false, error: `the gate verify script is not installed at ${script}` };
    if (signal?.aborted) return { ran: false, stopped: true, error: 'stopped before verification started' };
    // ANCHOR THE GUARD AT THE TARGET, never weaken it. verify.sh's `_guard.sh` trusts
    // `CAMUS_REPO_ROOT` (falling back to $PWD) and refuses any target outside that
    // repo — so run from inside the worktree with the anchor set to it. The guard's
    // own rules then still apply in full: the branch must be `camus/*` and the
    // directory must be `camus-wt-<branch suffix>`. The host has already
    // canonicalized this path and checked it is the clean root of that worktree;
    // realpath here keeps the anchor and the target byte-identical.
    let anchor = worktree;
    try { anchor = realpathSync(worktree); } catch { /* keep as given; the guard will judge it */ }
    const env = { ...process.env, CAMUS_REPO_ROOT: anchor };
    if (verifyCmd) env.CAMUS_VERIFY_CMD = verifyCmd;

    // detached: the child leads its own group, so a signal to -pid reaches the whole
    // tree (bash → verify.py → dotnet/pnpm → their children). execFile's kill would
    // only have reached bash and orphaned the rest.
    const child = spawn('bash', [script, anchor], { env, cwd: anchor, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    let out = '';
    let stopped = false;
    child.stdout.on('data', (d) => { out += d; if (out.length > 8 * 1024 * 1024) out = out.slice(-8 * 1024 * 1024); });
    child.stderr.on('data', () => {});

    const signalGroup = (sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
    const closed = new Promise((resolve) => {
      child.on('error', (err) => resolve({ failed: err.message }));
      child.on('close', () => resolve({ failed: null }));
    });

    // A STOP RESOLVES ON ITS OWN, never on the child's close event. `close` fires only
    // once every stdio pipe is released, so a single surviving group member holds it
    // open indefinitely — a parent-only kill left this awaiting `close` for 5.5
    // minutes in a break-test. Stop is prompt, then PROVES the group is gone.
    const stoppedOutcome = async () => {
      stopped = true;
      signalGroup('SIGTERM');
      // TERM first, then KILL — and after KILL, POLL. Reaping is not instantaneous,
      // so a single immediate `groupGone` check right after the signal can report a
      // live group that is already dying, or (worse) let a genuinely surviving group
      // be reported without ever waiting. Bounded on both sides.
      const pollGone = async (budgetMs) => {
        const deadline = Date.now() + budgetMs;
        for (;;) {
          if (groupGone(pgid)) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      if (!await pollGone(termGraceMs)) {
        signalGroup('SIGKILL');
        await pollGone(killGraceMs);
      }
      const gone = groupGone(pgid);
      // Release our end of the pipes so a member that somehow survived cannot keep
      // Studio's event loop alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      return {
        ran: false, stopped: true, groupTerminated: gone, pgid,
        error: gone
          ? 'verification was stopped and its process group was terminated'
          : `verification was stopped but process group ${pgid} still has a live member`,
      };
    };
    let resolveAbort;
    const aborted = new Promise((r) => { resolveAbort = r; });
    const onAbort = () => resolveAbort('abort');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const killTimer = setTimeout(() => { resolveAbort('timeout'); }, timeoutMs);

    try {
      const race = await Promise.race([closed.then(() => 'closed'), aborted]);
      if (race !== 'closed') return await stoppedOutcome();
      const exit = await closed;
      if (stopped) return await stoppedOutcome();
      if (exit.failed) return { ran: false, error: `verify could not start: ${exit.failed}` };
      const parsed = extractVerifyResult(out);
      if (!parsed) return { ran: false, error: 'verify produced no readable {pass} result' };
      // inconclusive keeps pass:false in the gate contract but is NOT a red.
      return { ran: true, pass: parsed.inconclusive ? null : parsed.pass, raw: parsed };
    } finally {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

// ── VERIFICATION-ONLY RECOVERY ─────────────────────────────────────────────────
// A sealed needs_decision + verify_inconclusive run holds a candidate that is
// already committed and already reviewed; the ONLY thing missing is a verdict from
// checks that could not run on this host. Resuming it through the gate re-enters
// Plan and Implement unconditionally — burning model turns to redo proven work and
// putting the very candidate being recovered at risk (field report 2026-08-05, run
// 20260805-104802-rv4d resumed to `Verify → Plan → Implement`). The comment
// claiming "the gate skips finished work" was wrong about this path.
//
// So recovery is its own lane: the host verifier and nothing else. No igniter, no
// maker, no reviewer, no Workflow turn, no land.
//
// Pure so eligibility is testable without a server: decides from the SEALED source
// report alone whether a run is recoverable this way, and names the target.
// A sealed Studio receipt stores the gate's report under `report`, and evidence
// derivation keeps a copy at `evidence.gateReport`. An earlier version of this
// selector read a top-level `gateReport` that only its own test fixture had, so
// against the REAL WP6 receipt it returned "the gate ended unknown" and the run
// fell through to the gate (audit 2026-08-05). Read every place the gate report
// actually lives, in the order of authority.
export function gateReportOf(sourceReport) {
  for (const candidate of [sourceReport?.gateReport, sourceReport?.report, sourceReport?.evidence?.gateReport]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && typeof candidate.status === 'string') return candidate;
  }
  return null;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

// ── AN INTERRUPTED VERIFICATION DECISION IS STILL A PARKED CANDIDATE ───────────
// Studio can restart while the gate is waiting on the verification question. Then
// there is no terminal report.json at all — only the event trail — so every
// recovery check above (which reads a SEALED report) found nothing, the replay was
// labelled merely `incomplete`, and the one offered action re-entered the gate and
// reran the model phases (production run 20260805-181917-f4b1, review already clean
// at round 2). The trail holds everything needed: the gate's own verify_inconclusive
// report, and a verification question nobody answered.
//
// Pure over the event list, so the rule is testable without a server. It reconstructs
// a report-SHAPED object for the existing checks; it invents nothing — the gate report
// is used verbatim and no evidence pack is claimed, because none was sealed.
const TERMINAL_STATUSES = new Set(['done', 'done_with_findings', 'failed', 'verify_failed', 'stopped', 'no_changes', 'needs_decision']);

export function reconstructInterruptedParked(events, meta = {}) {
  if (!Array.isArray(events)) return null;
  if (meta.lane && meta.lane !== 'build') return null;
  let gate = null;
  let pendingQuestion = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // A run that reached ANY terminal status is not interrupted — it sealed, or it
    // is already handled by the sealed-report path.
    if (ev.type === 'status' && TERMINAL_STATUSES.has(ev.status)) return null;
    if (ev.type === 'gate_report' && ev.report && typeof ev.report === 'object') gate = ev.report;
    if (ev.type === 'question' && ev.kind === 'verify') pendingQuestion = ev.id ?? true;
    // An answered question means the decision flow moved on; it is no longer pending.
    if (ev.type === 'answer' || ev.type === 'question_answered') pendingQuestion = null;
  }
  if (!gate || gate.status !== 'verify_inconclusive') return null;
  if (!pendingQuestion) return null;
  return {
    ...meta,
    lane: 'build',
    // The state the run WAS in when the process died: parked, awaiting a decision.
    status: 'needs_decision',
    report: gate,
    // NOTHING was sealed, so there is no receipt and no review to link. Left explicit
    // so the validate-before-link path records that honestly instead of guessing.
    evidencePack: null,
    interruptedRecovery: true,
    pendingQuestionId: typeof pendingQuestion === 'string' ? pendingQuestion : null,
  };
}

export function recoveryTarget(sourceReport, { worktreeFallback = null } = {}) {
  const gate = gateReportOf(sourceReport);
  if (sourceReport?.lane !== 'build') return { eligible: false, reason: 'only Build runs park a candidate' };
  if (sourceReport?.status !== 'needs_decision') {
    return { eligible: false, reason: `the source run ended ${sourceReport?.status ?? 'unknown'}, not needs_decision` };
  }
  if (gate?.status !== 'verify_inconclusive') {
    return { eligible: false, reason: `the gate ended ${gate?.status ?? 'unknown'}, not verify_inconclusive` };
  }
  // FROM HERE THIS IS A PARKED CANDIDATE, whatever else fails. The flag is set the
  // moment the outer/nested statuses match — before the worktree and sha are even
  // looked at — because a later refusal must still forbid the caller from restarting
  // the gate. Setting it only on the deeper checks let a missing worktree fall
  // straight through into Plan/Implement (audit 2026-08-05).
  const parked = (reason) => ({ eligible: false, parkedCandidate: true, reason });
  const worktree = [gate.worktree, worktreeFallback].find((w) => typeof w === 'string' && w.trim()) ?? null;
  if (!worktree) return parked('the parked worktree is no longer recorded, so there is nothing to verify in place');
  // A sha the GATE sealed is authoritative. Older receipts sealed none at all (the
  // real WP6 receipt has no commit_sha or parkedSha anywhere), so those need the
  // adoption path below — which must never be described as sealed provenance.
  const sealedSha = [gate.parkedSha, gate.commit_sha, gate.commit].find((s) => typeof s === 'string' && SHA_RE.test(s.trim())) ?? null;
  // A SOURCE RECEIPT IS ONLY CLAIMED IF IT VALIDATES. Taking `receipt_id` on sight
  // would let a recovery seal a descendant link to a pack whose ids no longer describe
  // its own contents (audit 2026-08-05: the redacted fixture was exactly that shape).
  // An invalid or absent pack is recorded as such, never quietly linked.
  const sourcePack = sourceReport.evidencePack ?? null;
  const packCheck = sourcePack ? validateEvidencePack(sourcePack) : { ok: false, error: 'the source run sealed no evidence pack' };
  const sourceReceiptId = packCheck.ok ? (sourcePack.receipt_id ?? null) : null;
  const sourceAudit = packCheck.ok ? (sourcePack.statuses?.audit ?? null) : null;

  return {
    eligible: true,
    parkedCandidate: true,
    reason: null,
    sourceRunId: sourceReport.id ?? null,
    sourceReceiptId,
    // Why there is no linked receipt, when there is none — so the UI can say so
    // instead of implying a review that was never sealed.
    sourceReceiptStatus: packCheck.ok ? 'validated' : `unusable: ${packCheck.error}`,
    sourceAudit,
    sealedSha,
    needsAdoption: !sealedSha,
    worktree,
    branch: typeof gate.branch === 'string' && gate.branch.trim() ? gate.branch : null,
  };
}

// Default git probe. Injected in tests so the checks under test are the real ones.
export const gitProbe = {
  run: (args, cwd) => new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '').trim() });
    });
  }),
  realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
};

// THE GATE'S TRUST ANCHOR, RESOLVED BY STUDIO AND HANDED TO THE IGNITER EXPLICITLY.
// `_guard.sh` anchors on $CAMUS_REPO_ROOT and only falls back to $PWD, and `camus_anchor`
// no-ops entirely when the variable is absent — so a Studio-launched gate had NO anchor at
// all: the server never exported one, and runIgniterTurn only inherited process.env. Every
// guarded script was then judged against whatever cwd the runner happened to hold, which is
// how WP7's valid worktree got refused and what left WP9's verification unanchored. The
// canonical toplevel is the one thing Studio has already validated, so it is what we pass.
// Derived here (not just accepted from the caller) so a run record assembled by any path
// still arrives anchored; returns null when it cannot be established, and a null is never
// exported — an unset variable keeps the old $PWD fallback rather than pointing the guard
// at a path we could not confirm.
export async function resolveRepoAnchor(run, probe = gitProbe) {
  const claimed = typeof run?.targetToplevel === 'string' && run.targetToplevel.trim() ? run.targetToplevel.trim() : null;
  const from = claimed ?? (typeof run?.targetPath === 'string' && run.targetPath.trim() ? run.targetPath.trim() : null);
  if (!from) return null;
  const top = await probe.run(['rev-parse', '--show-toplevel'], from);
  if (!top.ok || !top.out) return null;
  // Canonicalize: on macOS a /tmp or symlinked checkout yields two spellings of one repo,
  // and the guard compares git common-dirs from whatever spelling it is handed.
  return probe.realpath(top.out) ?? top.out;
}

// ── DURABLE EVIDENCE FOR THE CONTINUATION DECISION ───────────────────────────────────────
// Everything deriveContinuation() needs, read from disk: the gate's own status record, the
// worktree's measured state, and the review receipts that exist for it. No model output is
// consulted — a resumed run's safety cannot depend on prose (run 20260807-080214-p27e).
export async function gatherContinuationEvidence(meta, { probe = gitProbe, reviewsDir = REVIEWS_DIR } = {}) {
  const statusRaw = await readGateStatus(meta?.idSalt).catch(() => null);
  const state = gateStateFromStatus(statusRaw);
  const status = state
    ? { ...state, round: Number.isInteger(Number.parseInt(statusRaw?.round, 10)) ? Number.parseInt(statusRaw.round, 10) : null }
    : null;

  // The worktree the run owns: the status record's, or the receipt's, whichever exists.
  const gate = gateReportOf(meta) ?? {};
  const candidatePath = [status?.worktree, gate.worktree, meta?.worktree].find((w) => typeof w === 'string' && w.trim()) ?? null;
  let worktree = null;
  if (candidatePath) {
    const canonical = probe.realpath(candidatePath);
    if (canonical) {
      const inside = await probe.run(['rev-parse', '--is-inside-work-tree'], canonical);
      if (inside.ok && inside.out === 'true') {
        const head = await probe.run(['rev-parse', 'HEAD'], canonical);
        const porcelain = await probe.run(['status', '--porcelain'], canonical);
        const branch = await probe.run(['rev-parse', '--abbrev-ref', 'HEAD'], canonical);
        // How many commits this branch holds that its upstream base does not. `main` is not assumed:
        // the count is against the merge-base with the default branch when one can be found, and
        // left null when it cannot — null means "unknown", never zero.
        let ahead = null;
        for (const base of ['main', 'master']) {
          const c = await probe.run(['rev-list', '--count', `${base}..HEAD`], canonical);
          if (c.ok && /^\d+$/.test(c.out)) { ahead = Number(c.out); break; }
        }
        worktree = {
          path: canonical,
          head: head.ok ? head.out : null,
          dirty: porcelain.ok ? porcelain.out.length > 0 : true,   // unreadable → treat as dirty
          branch: branch.ok ? branch.out : null,
          commitsAhead: ahead,
        };
      }
    }
  }

  // Review receipts — COUNTED ONLY WHEN THEY PROVE THEMSELVES. A filename match alone let a
  // single hand-dropped `<prefix>-r99.json` with `ran:false` push the continuation's round to 99
  // and its provenance to `reviewed` (audit 2026-08-07): ~/.camus/reviews is a shared directory an
  // agent can write into, so a name is a claim, not evidence. A receipt counts only when
  //   · it parses, and says ran:true,
  //   · its own recorded worktree canonicalizes to THIS run's worktree,
  //   · it is bound, and the binding's gate nonce belongs to this run's identity salt
  //     (nonces are `<idSalt>:<per-invocation suffix>`, so the prefix is the stable identity
  //     across reattachments while the suffix legitimately varies),
  //   · the round it claims is coherent: filename, body and binding all name the same number.
  // An unbound (legacy) or mismatched file is left out entirely — the continuation then leans on
  // the durable status record instead, which is fail-closed: fewer receipts can only make the
  // answer more conservative, never re-open Plan. File mtimes are NOT collected: a touch is not
  // evidence of anything, and the earlier draft ordered provenance by mtime.
  const prefix = prefixFromWorktree(worktree?.path ?? candidatePath);
  const saltPrefix = typeof meta?.idSalt === 'string' && meta.idSalt.trim() ? `${meta.idSalt}:` : null;
  const receipts = [];
  if (prefix && worktree?.path) {
    let files = [];
    try { files = await readdir(reviewsDir); } catch { files = []; }
    for (const name of files) {
      const m = name.match(/^(.*)-r(\d+)\.json$/);
      if (!m || m[1] !== prefix) continue;
      const fileRound = Number(m[2]);
      const body = await readFile(join(reviewsDir, name), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
      if (!body || typeof body !== 'object' || body.ran !== true) continue;
      const recordedWt = [body.worktree_canonical, body.worktree].find((w) => typeof w === 'string' && w.trim()) ?? null;
      if (!recordedWt || (probe.realpath(recordedWt) ?? recordedWt) !== worktree.path) continue;
      const binding = body.binding;
      if (!binding || typeof binding !== 'object') continue;
      const nonce = typeof binding.gate_nonce === 'string' ? binding.gate_nonce : (typeof binding.nonce === 'string' ? binding.nonce : null);
      if (!nonce || !saltPrefix || !nonce.startsWith(saltPrefix)) continue;
      const bodyRound = Number.parseInt(body.round, 10);
      const boundRound = Number.parseInt(binding.round_actual ?? binding.round, 10);
      if (bodyRound !== fileRound || (Number.isInteger(boundRound) && boundRound !== fileRound)) continue;
      receipts.push({
        round: fileRound,
        ran: true,
        clean: body?.codex_parsed?.overall_correctness === 'patch is correct',
      });
    }
  }

  // The durably RECORDED candidate sha, when one was sealed. This is what a moved-tip check can
  // honestly compare against; measuring "the final commit" from the live HEAD compares HEAD with
  // itself and can never fire (audit 2026-08-07 — the earlier moved-tip protection was synthetic).
  const recordedSha = [gate.parkedSha, gate.commit_sha, gate.commit]
    .find((v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v.trim())) ?? null;

  // What the run's own sealed record CLAIMS about itself. The classifier holds this against what
  // is actually findable: a sealed needs_decision definitionally parked a candidate, so an empty
  // disk under it is a contradiction, never a fresh start (browser negative control, 2026-08-07 —
  // a gone-worktree needs_decision fixture was offered "Run the gate").
  const sealedStatus = typeof meta?.status === 'string' && meta.status.trim() ? meta.status : null;

  return { status, worktree, receipts: receipts.sort((a, b) => a.round - b.round), recordedSha, sealedStatus };
}

// Turn what the receipt says into a target SAFE to verify, doing the git checks the
// receipt cannot make. For a legacy receipt with no sealed sha this ADOPTS the
// recorded worktree's current HEAD — but only when the worktree is genuinely the
// one recorded, on the branch recorded, and clean; and the result is labelled
// `adopted_clean_worktree_head`, never presented as something the source sealed.
export async function resolveRecoveryTarget(sourceReport, { worktreeFallback = null, git = gitProbe } = {}) {
  const base = recoveryTarget(sourceReport, { worktreeFallback });
  if (!base.eligible) return base;
  const { worktree, branch, sealedSha } = base;

  // `parkedCandidate` is load-bearing: it tells the caller this IS an outer
  // needs_decision over a nested verify_inconclusive, so a failure to establish a
  // safe target must be REFUSED out loud. Falling through to the gate here is the
  // original defect — it would re-plan and re-implement the parked work.
  const refuse = (reason) => ({ eligible: false, reason, parkedCandidate: true, target: base });
  const canonical = git.realpath(worktree);
  if (!canonical) return refuse(`the recorded worktree ${worktree} no longer exists on disk`);
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], canonical);
  if (!inside.ok || inside.out !== 'true') return refuse(`${canonical} is not a git work tree any more`);
  // The recorded path must BE the worktree root. A subdirectory (or a symlink into
  // an unrelated repo) would let a HEAD from somewhere else stand in for it.
  const top = await git.run(['rev-parse', '--show-toplevel'], canonical);
  const topCanonical = top.ok ? git.realpath(top.out) : null;
  if (!topCanonical || topCanonical !== canonical) {
    return refuse(`${canonical} is not the root of its git work tree (root is ${top.out || 'unknown'}), so its HEAD is not the parked candidate`);
  }
  const headSha = await git.run(['rev-parse', 'HEAD'], canonical);
  if (!headSha.ok || !SHA_RE.test(headSha.out)) return refuse(`${canonical} has no resolvable HEAD commit`);

  // CLEANLINESS APPLIES TO BOTH PATHS. This lived only in the adoption branch, so a
  // candidate whose sha the receipt DID seal could be verified with uncommitted edits
  // sitting on top of it — verifying something other than the commit that was reviewed
  // (found while testing the restart seam, 2026-08-05).
  const dirty = await git.run(['status', '--porcelain'], canonical);
  if (!dirty.ok) return refuse(`could not read the worktree's status, so its cleanliness is unknown`);
  if (dirty.out !== '') {
    return refuse(`the worktree has uncommitted changes, so its HEAD does not describe what is there; commit or discard them first (${dirty.out.split('\n').length} path(s) differ)`);
  }

  if (sealedSha) {
    // Nothing is adopted: the receipt named the commit, so the worktree must still
    // be sitting on it. If it moved, this is not the candidate that was sealed.
    if (headSha.out.toLowerCase() !== sealedSha.toLowerCase()) {
      return refuse(`the worktree is on ${headSha.out} but the receipt sealed ${sealedSha}; that is a different candidate`);
    }
    return { ...base, eligible: true, reason: null, parkedSha: sealedSha, shaProvenance: 'sealed_by_source', canonicalWorktree: canonical };
  }

  // ── LEGACY ADOPTION ────────────────────────────────────────────────────────
  const onBranch = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], canonical);
  if (branch) {
    if (!onBranch.ok || onBranch.out !== branch) {
      return refuse(`the worktree is on ${onBranch.out || 'an unknown ref'} but the receipt recorded branch ${branch}; refusing to adopt a HEAD from a different branch`);
    }
  } else if (!onBranch.ok || onBranch.out === 'HEAD') {
    return refuse('the receipt recorded no branch and the worktree is detached, so there is nothing to identify the candidate by');
  }
  return {
    ...base,
    eligible: true,
    reason: null,
    parkedSha: headSha.out,
    // The whole point of this field: a reader can tell that no receipt sealed this
    // sha — Studio adopted it from a clean worktree at recovery time.
    shaProvenance: 'adopted_clean_worktree_head',
    adoptedAt: null,
    canonicalWorktree: canonical,
    branchAtAdoption: onBranch.out,
  };
}

// The recovery executor. Same (run, ctx) shape as runCodeLoop so the server's lane
// dispatch is a one-line swap, but it never receives or reaches an adapter: the
// "zero model turns" guarantee is structural here, not a promise in a comment.
export async function runVerificationRecovery(run, ctx = {}) {
  const { emit, signal } = ctx;
  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });
  const target = run.recovery ?? {};
  const { parkedSha, worktree, canonicalWorktree = null, branch = null, sourceRunId = null, sourceReceiptId = null, sourceReceiptStatus = null, sourceAudit = null, shaProvenance = 'sealed_by_source' } = target;
  const verifyCandidate = ctx.verifyCandidate
    // Stop must reach the verifier: pass the run's abort signal down so the group is
    // terminated instead of merely awaited.
    ?? makeCandidateVerifier({ worktree: canonicalWorktree ?? worktree, verifyCmd: run.verifyCmd ?? null, signal });

  const base = {
    recoveryOf: { sourceRunId, sourceReceiptId, sourceReceiptStatus, sourceAudit, parkedSha, branch, verifyCmd: run.verifyCmd ?? null, shaProvenance },
    // The source receipt is untouched — this run seals a SECOND receipt that
    // references it. Nothing here rewrites what the original certified.
    gateReport: { status: 'verify_inconclusive', commit_sha: parkedSha, parkedSha, branch, worktree, recovered_from: sourceRunId },
    rounds: 0,
    landed: false,
  };

  // The artifact under verification, restated from what the SOURCE run sealed and
  // marked as recovered. Without it the evidence trail has no head to bind a
  // verdict to, so a bound green derived `verification: not_run` — a receipt that
  // understates is still a receipt that misreports.
  emit('gate_report', { report: base.gateReport });

  const reviewedClaim = sourceReceiptId && ['independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings'].includes(sourceAudit)
    ? `and its review is recorded in the source receipt (${sourceAudit})`
    : `and no reviewed standing is claimed for it here (source receipt: ${sourceReceiptStatus ?? 'not checked'})`;
  log(`Verification-only recovery of run ${sourceRunId ?? 'unknown'}: the candidate is already committed as ${parkedSha} ${reviewedClaim}. This run reruns no model or gate phases; it reruns deterministic verification only, against the parked worktree.`);
  if (run.verifyCmd) log(`Verification command: ${run.verifyCmd}`);
  else log('No explicit verification command; the verifier will auto-detect the stack, which is what returned inconclusive before.');

  stage('verify', 'active');
  const result = await verifyCandidate();
  // The server consumes the runner with a bare .then(): a rejection here is an
  // unhandled rejection that takes the whole process down (caught driving this for
  // real, 2026-08-05). runCodeLoop converts its own abort into a status, so this
  // does too — a Stop during recovery leaves the candidate parked, never a crash.
  if (signal?.aborted || result.stopped) {
    stage('verify', 'idle');
    // A CLEAN `stopped` IS A CLAIM ABOUT THE HOST, not just about this run: it says
    // nothing of ours is still executing in the operator's worktree. When the
    // verifier reports its group survived TERM and KILL, saying "stopped" would be
    // the same false-clean the reviewer lane was already fixed for. Name the orphan
    // instead and seal an infra failure.
    if (result.stopped === true && result.groupTerminated === false) {
      const note = `verification was stopped but process group ${result.pgid} survived TERM and KILL; processes may still be running inside the worktree`;
      log(`STOPPED, BUT NOT CLEAN: ${note}. Nothing was verified. Check that group before trusting the worktree's state.`);
      emit('status', { status: 'failed', rev: 0, costUsd: null, billingMode: 'unknown' });
      return { ...base, status: 'failed', parkedSha, orphanedPgid: result.pgid ?? null, recoveryNote: note };
    }
    log('Stopped during recovery. Nothing was verified, the verifier process group was terminated, and the candidate is exactly as it was.');
    emit('status', { status: 'stopped', rev: 0, costUsd: null, billingMode: 'unknown' });
    return { ...base, status: 'stopped', parkedSha, recoveryNote: 'stopped by human before a verdict; verifier process group terminated' };
  }

  const inconclusive = (line, note, failures = null) => {
    stage('verify', 'idle');
    log(line);
    emit('status', { status: 'needs_decision', rev: 0, costUsd: null, billingMode: 'unknown' });
    return { ...base, status: 'needs_decision', parkedSha, recoveryNote: note, failures: failures ?? undefined };
  };
  if (!result.ran) {
    return inconclusive(`Verification could not run: ${result.error}. The candidate stays parked exactly as it was.`, `verification could not run: ${result.error}`);
  }
  // CLASSIFY INCONCLUSIVE FIRST. A guard refusal or a missing toolchain carries no
  // verdict AND no HEAD — there was nothing to take a HEAD of. Demanding one first
  // replaced the real diagnosis ("target rejected by camus_guard", "no verifier
  // detected") with "the verifier reported no HEAD", which sends the operator after
  // the wrong problem. So the verifier's own failures are preserved verbatim and
  // HEAD binding is required only of a verdict — a green or a red.
  if (result.pass === null) {
    const failures = Array.isArray(result.raw?.failures) ? result.raw.failures : [];
    const why = failures.map((f) => [f.stage, f.kind, f.reason].filter(Boolean).join('/')).filter(Boolean).join(', ');
    return inconclusive(
      `Verification is inconclusive: it produced no verdict${why ? ` (${why})` : ''}. The candidate stays parked and nothing was rejected.`,
      `verification inconclusive${why ? `: ${why}` : ''}`,
      failures,
    );
  }
  // COMMIT-BOUND to the sha the ORIGINAL run sealed — not to whatever the verifier
  // happens to be sitting on. A recovery that certifies a different commit has
  // certified something other than the candidate it was asked about.
  const reportedHead = (typeof result.raw?.head === 'string' && result.raw.head) ? result.raw.head : null;
  if (!reportedHead) {
    return inconclusive('Verification returned a verdict but named no HEAD, so it cannot be bound to the parked candidate. Nothing is recorded.', 'a verdict arrived with no HEAD to bind it to');
  }
  if (reportedHead !== parkedSha) {
    return inconclusive(
      `Verification certified ${reportedHead}, but the sealed candidate is ${parkedSha}. That result belongs to a different commit and is discarded.`,
      `verifier HEAD ${reportedHead} does not match the sealed candidate ${parkedSha}`,
    );
  }

  emit('verify_result', {
    pass: result.pass, warnings: 0, skipped: 0,
    checks: result.raw?.failures ?? [], source: 'studio_reverify', commitSha: parkedSha,
  });
  if (result.pass === true) {
    stage('verify', 'done', { pass: true });
    log(`Deterministic verification PASSES on the parked candidate, bound to ${parkedSha}. This receipt covers that verification; the review evidence stays in the source receipt.`);
    emit('status', { status: 'done', rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
    return { ...base, status: 'done', parkedSha, verifiedOnRetry: true, verifiedSha: parkedSha };
  }
  if (result.pass === false) {
    stage('verify', 'done', { pass: false });
    log('Deterministic verification returns RED on the parked candidate. That is a real result and the candidate is preserved for a human look.');
    emit('status', { status: 'verify_failed', rev: 0, costUsd: null, billingMode: 'unknown' });
    return { ...base, status: 'verify_failed', parkedSha, failures: result.raw?.failures ?? [] };
  }
  return inconclusive('Verification is still inconclusive: the checks could not run here. The candidate stays parked.', 'the checks still could not run on this host');
}

export async function resolveGateTerminal(report, { emit, log, stage, ask, igniteGate, answers, refineCap = 1, verifyCandidate = null } = {}) {
  // An INCONCLUSIVE verification is a decision point with real options, not a
  // dead end. Studio used to return needs_decision immediately and render a
  // screen with no controls (WP6 dogfood 2026-08-05), so the operator had a
  // parked candidate and nothing to do about it. Every option here is either
  // deterministic or explicitly human-attested — none of them invents a green.
  const resolveInconclusive = async ({ parked, branch, note }) => {
    // BOUNDED re-asking. An unanswerable or unrecognised reply must not spin: a
    // caller that keeps sending something not on the menu (or nothing at all)
    // gets a few tries and then the safe default — the candidate stays parked.
    let offTheMenu = 0;
    // And bounded the same way for retries that produce nothing usable. A caller
    // that answers "Retry" automatically while verification keeps failing to
    // produce a bindable verdict would otherwise spin forever. Hitting the bound
    // costs a resume, never work: the candidate stays parked either way.
    let unusableRetries = 0;
    for (;;) {
      const canRetry = typeof verifyCandidate === 'function';
      const options = [
        ...(canRetry ? ['Retry verification with the configured command'] : []),
        'Record that I ran the checks myself and they passed',
        'Leave the candidate parked and stop here',
      ];
      const choice = await ask({
        kind: 'verify',
        text: `${note}\n\nThe candidate is parked${parked ? ` as commit ${parked}` : ''}${branch ? ` on ${branch}` : ''} and nothing was rejected. What should happen?`,
        options,
      });
      if (!options.includes(choice)) {
        offTheMenu += 1;
        if (offTheMenu > 3) {
          log('No usable answer after several prompts; leaving the candidate parked with verification honestly inconclusive.');
          emit('status', { status: 'needs_decision', rev: 0, costUsd: null, billingMode: 'unknown' });
          return { status: 'needs_decision', report, answers, parkedSha: parked };
        }
        log('That option is not available here; asking again. Nothing was verified or discarded.');
        continue;
      }
      if (choice.startsWith('Retry')) {
        log('Re-running deterministic verification against the parked candidate (host-side; no model turn).');
        stage('verify', 'active');
        const result = await verifyCandidate();
        const unusable = (line) => {
          stage('verify', 'idle');
          log(line);
          unusableRetries += 1;
          if (unusableRetries <= 5) return false;
          log('Verification has produced nothing usable several times over; leaving the candidate parked with verification honestly inconclusive.');
          emit('status', { status: 'needs_decision', rev: 0, costUsd: null, billingMode: 'unknown' });
          return true;
        };
        if (!result.ran) {
          // re-offer; never a fabricated verdict
          if (unusable(`Verification still could not run: ${result.error}. The candidate stays parked.`)) {
            return { status: 'needs_decision', report, answers, parkedSha: parked };
          }
          continue;
        }
        // INCONCLUSIVE IS CLASSIFIED FIRST: a guard refusal or a missing toolchain has
        // no verdict and no HEAD to report, so demanding a HEAD here would bury the
        // real diagnosis under "named no HEAD" and send the operator after the wrong
        // problem. The verifier's own failure kinds are what get reported.
        if (result.pass === null) {
          const why = (Array.isArray(result.raw?.failures) ? result.raw.failures : [])
            .map((f) => [f.stage, f.kind, f.reason].filter(Boolean).join('/')).filter(Boolean).join(', ');
          if (unusable(`Verification is still inconclusive${why ? `: ${why}` : ': the checks could not run here'}. The candidate stays parked.`)) {
            return { status: 'needs_decision', report, answers, parkedSha: parked };
          }
          continue;
        }
        // COMMIT-BOUND or it is worthless, and the SHA must come from the VERIFIER:
        // verify.py names the head it actually ran against. Substituting the parked
        // sha when the verifier reports none would assert that the parked commit was
        // checked on no evidence whatsoever — exactly the fabrication this lane
        // exists to prevent. A verdict with a missing head, or one that is not the
        // parked commit, stays inconclusive: nothing resolved, nothing lost.
        const reportedHead = (typeof result.raw?.head === 'string' && result.raw.head) ? result.raw.head : null;
        if (!reportedHead) {
          if (unusable('Verification returned a verdict but did not name the HEAD it certified, so it cannot be bound to the parked candidate. Nothing is recorded; the candidate stays parked.')) {
            return { status: 'needs_decision', report, answers, parkedSha: parked };
          }
          continue;
        }
        if (parked && reportedHead !== parked) {
          if (unusable(`Verification certified ${reportedHead}, which is not the parked candidate ${parked}. That result belongs to a different commit, so it is discarded and the candidate stays parked.`)) {
            return { status: 'needs_decision', report, answers, parkedSha: parked };
          }
          continue;
        }
        const boundSha = reportedHead;
        emit('verify_result', {
          pass: result.pass, warnings: 0, skipped: 0,
          checks: result.raw?.failures ?? [], source: 'studio_reverify', commitSha: boundSha,
        });
        if (result.pass === true) {
          stage('verify', 'done', { pass: true });
          // A candidate whose REVIEW was clean and whose verification now passes is
          // simply done. Only an unresolved review keeps the findings qualifier.
          const reviewUnresolved = report.status === 'review_unresolved'
            || (Array.isArray(report.blocking) && report.blocking.length > 0);
          const status = reviewUnresolved ? 'done_with_findings' : 'done';
          log(`Deterministic verification now PASSES on the parked candidate (bound to ${boundSha}). Resolving as ${status}.`);
          emit('status', { status, rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
          return { status, report, answers, parkedSha: parked, verifiedOnRetry: true, verifiedSha: boundSha, landed: false };
        }
        if (result.pass === false) {
          stage('verify', 'done', { pass: false });
          log('Deterministic verification now returns RED on the parked candidate. That is a real result, and the state is preserved.');
          emit('status', { status: 'verify_failed', rev: 0, costUsd: null, billingMode: 'unknown' });
          return { status: 'verify_failed', report, answers, parkedSha: parked };
        }
        if (unusable('Verification is still inconclusive: the checks could not run here. The candidate stays parked.')) {
          return { status: 'needs_decision', report, answers, parkedSha: parked };
        }
        continue;
      }
      if (choice.startsWith('Record')) {
        // HUMAN-ATTESTED, never machine-verified. That distinction is the point:
        // this records a person's claim and keeps deterministic verification
        // honestly inconclusive in the receipt.
        log('Recorded: a human ran the checks and reports them passing. This is human attestation, NOT a deterministic green — the receipt keeps verification inconclusive.');
        emit('status', { status: 'done_with_findings', rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
        return { status: 'done_with_findings', report, answers, parkedSha: parked, humanAttestedVerification: true, deterministicVerification: 'inconclusive', landed: false };
      }
      log('Left parked: the candidate survives with verification honestly inconclusive.');
      emit('status', { status: 'needs_decision', rev: 0, costUsd: null, billingMode: 'unknown' });
      return { status: 'needs_decision', report, answers, parkedSha: parked };
    }
  };
  let refines = 0;
  for (;;) {
    // GATE QUESTION — the gate paused for a human decision (needs_human /
    // needs_decision carry report.question). This is handled INSIDE the loop so
    // it applies to EVERY report, including one a Refine just returned: a
    // post-Refine needs_human must be answered and re-invoked, never classified
    // as failed (which the terminal map would otherwise do).
    if (report.status === 'needs_human' || report.status === 'needs_decision') {
      stage('gate', 'done');
      const answer = await ask({
        kind: 'decision',
        text: report.question || 'The gate paused for a decision; its report has the detail. What should it do?',
      });
      stage('gate', 'active');
      report = await igniteGate(answer);
      continue;
    }

    const terminal = {
      done: 'done',
      done_with_findings: 'done_with_findings',
      review_unresolved: 'needs_human_offline',
      verify_failed: 'verify_failed',
      // verify_inconclusive is NOT a red: the deterministic checks could not
      // RUN (env not ready), so there is no ground-truth verdict either way.
      // Reporting it as verify_failed would claim a failure the evidence does
      // not support — it is a human decision (→ interrupted), never a red.
      verify_inconclusive: 'needs_decision',
      infra_error: 'failed',
      aborted: 'failed',
      paused_by_user: 'stopped',
      // A genuine no-op keeps its own name. Mapping it to done would claim a
      // ship that never happened; mapping it to failed would claim a failure
      // that never happened. (Ancestry-rescued prior commits return done from
      // the gate itself, so a no_changes that reaches here is evidence-backed.)
      no_changes: 'no_changes',
    }[report.status] ?? 'failed';

    if (terminal === 'no_changes') stage('gate', 'idle');
    else stage('gate', 'done', { pass: terminal.startsWith('done') });
    const verify = verifyEventFromGateReport(report);
    if (verify) emit('verify_result', verify);
    emit('gate_report', { report });

    if (terminal === 'needs_human_offline') {
      // PRAGMATIC POSTURE. A non-converged review is not a failure when
      // deterministic verification passes: the gate has already PARKED a
      // verify-green commit, and reporting that as `verify_failed` threw away a
      // usable solution and sent the operator to a terminal. Deterministic
      // ground truth decides which of the three honest outcomes this is.
      const verifyClean = report.verifyClean;
      const parked = typeof report.parkedSha === 'string' && report.parkedSha ? report.parkedSha : null;
      const openRisks = Array.isArray(report.blocking) ? report.blocking : [];
      const riskLines = openRisks.slice(0, 5).map((f) => `• [P${f?.priority ?? '?'}] ${f?.title ?? 'untitled finding'}`);

      if (verifyClean === true) {
        // A candidate exists and the machine checks pass. Hand it over as a
        // solution that needs human review — never "clean", never "failed".
        log(`Deterministic verification PASSES and the review did not converge. A candidate is parked${parked ? ` as ${parked}` : ''} on ${report.branch ?? 'the task branch'}.`);
        if (riskLines.length) log(`Unresolved risk${riskLines.length === 1 ? '' : 's'} the reviewer still raises:\n${riskLines.join('\n')}`);
        // Refine is only offered while a round remains in the budget; past it,
        // the honest options are accept or leave parked.
        const canRefine = refines < refineCap;
        const options = [
          ...(canRefine ? ['Refine: run more review/fix rounds on the open findings'] : []),
          // Studio does not merge — "land" means keep the parked candidate for
          // the human's own final merge. Say that, don't imply a merge.
          'Accept the reviewed risk and keep the candidate parked for final human merge',
          'Leave it parked and stop here',
        ];
        const choice = await ask({
          kind: 'stuck',
          text: `${openRisks.length} reviewer finding(s) did not resolve, but the deterministic checks pass and the work is parked${parked ? ` as commit ${parked}` : ''}.\n\n${riskLines.join('\n') || 'See the report for detail.'}\n\nWhat should happen with this candidate?${canRefine ? '' : `\n\n(Refined ${refines} time(s) without converging; further refinement is no longer offered.)`}`,
          options,
        });
        // Enforce the cap on the ANSWER, not just by hiding the option: a
        // "Refine" that is not among the currently offered options (past the
        // cap, or any answer the run never offered) must NOT invoke the gate.
        // Re-ask instead — a re-ask costs no model turn, a stray igniteGate
        // would. `continue` re-runs this same classification and re-asks.
        if (!options.includes(choice)) {
          log(`That option is not available for this candidate${canRefine ? '' : ' (refinement is capped)'}; asking again. No gate round was spent.`);
          continue;
        }
        if (choice.startsWith('Refine')) {
          refines += 1;
          log(`Refining (${refines}/${refineCap}): re-invoking the gate on the parked candidate. Completed classify/plan/implement work is reused from its receipts; implementation is not restarted.`);
          stage('gate', 'active');
          report = await igniteGate(`Refine the unresolved findings on the parked candidate${parked ? ` (${parked})` : ''}. Do not restart implementation; continue from the existing worktree and address the open findings.`);
          continue; // re-classify the NEW report from the top of this loop
        }
        const accepted = choice.startsWith('Accept');
        // Both outcomes preserve the parked candidate; they differ in the
        // recorded human decision. Neither claims a merge — landed:false always.
        log(accepted
          ? 'Accepted on the record: the reviewed risk is the human\'s decision. The candidate stays parked on its branch for you to merge; Studio does not merge.'
          : 'Left parked: the candidate and its findings both survive on the branch. No decision was recorded on the risk.');
        emit('status', { status: 'done_with_findings', rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
        return { status: 'done_with_findings', report, answers, parkedSha: parked, accepted, landed: false };
      }
      if (verifyClean === false) {
        log('The review did not converge AND deterministic verification failed — the code is genuinely not done. Its state is preserved.');
        emit('status', { status: 'verify_failed', rev: 0, costUsd: null, billingMode: 'unknown' });
        return { status: 'verify_failed', report, answers };
      }
      return await resolveInconclusive({
        parked, branch: report.branch ?? null,
        note: 'The review did not converge AND deterministic verification could not run, so there is no ground truth either way.',
      });
    }

    if (terminal === 'needs_decision') {
      // A DIRECT verify_inconclusive: offer the same real options instead of a
      // screen with nothing on it.
      return await resolveInconclusive({
        parked: typeof report.parkedSha === 'string' && report.parkedSha ? report.parkedSha : null,
        branch: report.branch ?? null,
        note: 'Deterministic verification could not run, so the candidate is neither proven nor disproven.',
      });
    }
    emit('status', { status: terminal, rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
    return { status: terminal, report, answers };
  }
}

export async function runCodeLoop(run, ctx) {
  const { emit, waitForAnswer, signal } = ctx;
  const answers = [];
  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });
  const sess = (line) => emit('session', { actor: 'gate', line });

  async function ask(question) {
    const reply = await waitForAnswer(question);
    if (signal.aborted) throw new Error('stopped_by_human');
    answers.push({ kind: question.kind, question: question.text, answer: reply });
    emit('answer', { kind: question.kind, question: question.text, answer: reply });
    return reply;
  }

  // The worktree prefix this run owns, hoisted so Stop can find (and end) the
  // detached reviewers the gate started, even after igniteGate has returned.
  let ownedPrefix = null;
  // The gate's trust anchor for this run. `undefined` = not resolved yet; a string = the
  // canonical repo root every igniter turn exports as CAMUS_REPO_ROOT; `null` = could not be
  // established, in which case nothing is exported and the guard keeps its old $PWD fallback.
  let repoAnchor;
  // ACTIVE TERMINATION ON A REFUSED RECEIPT. Setting receiptViolation and returning from the
  // poll only recorded the refusal: the Claude/workflow child kept running, so Studio waited
  // for it to finish and merely overrode the result afterwards — which is why a rejected WP9
  // receipt was still followed by fix, verify and a commit (live run 20260806-110809-2r9j).
  // The turn that owns the child installs a terminator here; the poll calls it, and the turn
  // resolves with exitCode -5 so no later phase can run.
  let terminateIgniter = null;
  let receiptHalt = null;
  // The closure of the turn that was TERMINATED — captured per-turn from that child's own
  // 'close' event (see runIgniterTurn's `closed`), never a global that an earlier turn can set.
  let refusedTurnClosed = false;
  const idSalt = run.idSalt || `studio-${run.id.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const hbPath = join(homedir(), '.camus', 'feats', `${idSalt}.hb`);
  const roundCap = run.models?.loop?.roundCap ?? getModels().loop.roundCap;

  // One outer gate process per Studio attempt. A later human/resume attempt reuses the same
  // standalone custody identity; camus-loop's `ensure` lane returns its exact worktree.
  async function igniteGate(humanAnswer) {
    // identitySalt is intentionally NOT idSalt. idSalt means "owned by camus-feat" and enables
    // parent-tree containment whose precondition is a camus/feat-* parent checkout. Studio is a
    // standalone custodian: it needs one deterministic/resumable worktree + heartbeat without
    // impersonating a feat (the live smoke's first run failed containment, then an outer-agent
    // retry dropped the salt and forked a second worktree).
    // Resolve the anchor ONCE per run, before any turn can spawn, and say what it is: the
    // operator's unattended recipe exports CAMUS_REPO_ROOT by hand, and a Studio run has to be
    // just as explicit about which repository the gate scripts are allowed to touch.
    if (repoAnchor === undefined) {
      repoAnchor = await resolveRepoAnchor(run);
      log(repoAnchor
        ? `Trust anchor for the gate scripts: CAMUS_REPO_ROOT=${repoAnchor}`
        : 'Could not establish a repository root for this target, so the gate scripts fall back to their own working directory for the target guard.');
    }
    const args = gateArgsForRun({ ...run, idSalt }, roundCap, humanAnswer);
    const invocation = `/camus-loop ${JSON.stringify(args)}`;
    log(humanAnswer ? 'Re-invoking the gate with your answer; it resumes from its own receipts.' : `Igniting the camus gate in ${run.targetPath}`);
    sess(`invocation: ${invocation.slice(0, 160)}`);

    const t0 = Date.now();
    const seenRounds = new Set();
    const parseTries = new Map(); // review files caught mid-write are retried, not sealed
    const PARSE_RETRIES = 3;      // ~3 polls before a parse failure is treated as stable
    let wtPrefix = null; // first receipt names the worktree; later rounds must match
    let lastActivity = Date.now();
    let activitySource = 'ignition';
    // Sequence + identity state for receipt acceptance. expectedRound advances
    // ONLY on an accepted receipt, so a wrong-round file can never stand in for
    // the round the gate asked for.
    let expectedRound = 1;
    let runWorktreeCanonical = null;
    let runNonce = null;
    let receiptViolation = null;
    let unboundRounds = 0;
    let sawBoundReceipt = false;
    let phase = 'igniting';
    let asyncReattachState = null; // set when the workflow hands back an async handle
    let runBranch = null;
    let statusEffort = null;
    let signalsFromStatus = 0; // gate-reported progress (durable, not agent-relayed)
    const setPhase = (next) => {
      if (!next || next === phase) return;
      phase = next;
      emit('gate_phase', { phase, at: Date.now() });
    };

    const watcher = setInterval(async () => {
      // Round receipts are the gate's own truth — surface them as they land.
      // The studio enforces one gate at a time, and the first receipt binds
      // this run to its worktree so a stray file never cross-contaminates.
      // The gate's durable status arrives long before any receipt: it is what
      // makes the worktree, prefix, nonce and phase knowable during Classify,
      // Plan, Implement and an ACTIVE first review (field report 2026-08-04 —
      // all of these were invisible until a receipt landed).
      const gateState = gateStateFromStatus(await readGateStatus(idSalt));
      if (gateState) {
        runWorktreeCanonical ??= gateState.worktree;
        runNonce ??= gateState.nonce;
        if (gateState.prefix) { wtPrefix ??= gateState.prefix; ownedPrefix ??= gateState.prefix; }
        if (gateState.phase) setPhase(gateState.phase);
        runBranch ??= gateState.branch;
        if (gateState.progressAt) signalsFromStatus = gateState.progressAt;
        statusEffort = gateState.effort ?? statusEffort;
      }
      if (receiptViolation) return; // the loop is already halting on a custody refusal
      for (const r of await reviewRoundsSince(t0)) {
        if (seenRounds.has(r.file)) continue;
        // A receipt for a round this run is not waiting on is not "skipped
        // quietly" any more: out-of-range and out-of-sequence are both refused
        // below, and a refusal halts the loop instead of advancing it.
        const prefix = r.file.replace(/-r\d+\.json$/, '');
        if (wtPrefix === null) { wtPrefix = prefix; ownedPrefix = prefix; }
        else if (prefix !== wtPrefix) continue;
        // Parse BEFORE marking the file seen. A gate that writes the audit
        // non-atomically can be caught mid-write; a parse failure is retried on
        // later polls (bounded) so a transient truncated read never permanently
        // seals a valid audit as infra_failed. Only a STABLE failure emits an
        // UNKNOWN. (New gates write atomically via os.replace and never truncate.)
        let review;
        try {
          const raw = JSON.parse(await readFile(join(REVIEWS_DIR, r.file), 'utf8'));
          // CUSTODY BEFORE CONSUMPTION: decide whether this receipt is the one
          // this run is waiting for, and whether the reviewer's own binding says
          // it ran what was requested. A refusal is INFRA — the loop halts and
          // the gate is retried; it never advances the review sequence.
          const verdict = acceptGateReceipt({
            round: r.round,
            expectedRound,
            roundCap,
            binding: raw?.binding ?? null,
            worktreeCanonical: raw?.worktree_canonical ?? null,
            runWorktree: runWorktreeCanonical,
            nonce: runNonce,
            // Studio's OWN run-start decisions — not the receipt's self-report.
            expectedEffort: run.models?.reviewer?.effort ?? null,
            expectedReviewerModel: run.models?.reviewer?.model ?? null,
            // Once this gate has produced a bound receipt (or named its nonce),
            // an unbound one can no longer authorize a round.
            requireBinding: sawBoundReceipt || runNonce !== null,
          });
          if (!verdict.accept) {
            seenRounds.add(r.file);
            receiptViolation = verdict.reason;
            log(`⚠ review receipt refused: ${verdict.reason}`);
            // SIGNAL FIRST, MEASURE SECOND. worktreeSnapshot runs three synchronous git
            // commands with a 10s timeout each: putting it ahead of the terminator could leave
            // the child mutating for another 30 seconds while the log claimed an immediate
            // halt. The custody halt never waits behind state measurement — an unmeasured
            // report says "not measured", which is honest; a delayed halt is not.
            if (!receiptHalt) {
              receiptHalt = { reason: verdict.reason, at: Date.now(), before: null, worktree: gateState?.worktree ?? null };
              log('Halting the gate NOW: terminating the igniter turn so no fix, commit or verification can follow a refused receipt.');
              try { terminateIgniter?.(); } catch (err) { log(`Could not signal the igniter: ${err.message}`); }
              // Only now, with the signal already delivered, is it safe to spend time measuring.
              try { receiptHalt.before = worktreeSnapshot(receiptHalt.worktree); } catch { receiptHalt.before = null; }
            }
            return;
          }
          if (verdict.unbound) {
            unboundRounds += 1;
            log(`Review round ${r.round} came from a gate that does not bind its receipts; its round rests on the filename alone. Reinstall the gate (camus install) for bound receipts.`);
          }
          runWorktreeCanonical ??= raw?.worktree_canonical ?? null;
          runNonce ??= raw?.binding?.gate_nonce ?? null;
          if (!verdict.unbound) sawBoundReceipt = true;
          expectedRound = r.round + 1;
          review = reviewEventFromGateReceipt(raw, r.round);
          review.bound = verdict.unbound ? false : true;
          parseTries.delete(r.file);
        } catch (err) {
          const tries = (parseTries.get(r.file) ?? 0) + 1;
          parseTries.set(r.file, tries);
          if (tries < PARSE_RETRIES) continue; // still unseen — a later poll retries the (maybe mid-write) file
          review = {
            round: r.round, verdict: 'UNKNOWN', rawVerdict: null, confidence: null,
            explanation: `unreadable review receipt after ${tries} attempts: ${String(err.message).slice(0, 120)}`,
            findings: [], source: 'camus_gate_review',
          };
        }
        seenRounds.add(r.file);
        lastActivity = Date.now();
        stage('review', 'done', { round: r.round });
        emit('round', { round: r.round, cap: roundCap });
        const blocking = review.findings.filter((f) => f.priority === null || f.priority <= 2).length;
        const verdictNote = review.verdict === 'APPROVED' ? 'clean'
          : review.verdict === 'REVISE' ? `revise (${blocking} blocking)`
            : 'unreadable receipt';
        for (const finding of review.findings) emit('finding', finding);
        emit('review', review);
        feedVerdict(r.round, verdictNote);
      }
      // LIVENESS from every trustworthy signal, not one phase-entry touch.
      // The heartbeat is written when a phase STARTS, so a long Implement or a
      // long review left it stale while real work was happening and the idle
      // watchdog killed it (field report 2026-08-04). A growing review event
      // stream and changed files in the gate's worktree are both direct
      // evidence the gate is still working.
      const signals = { stdout: lastActivity };
      // The gate's own progress statement. Unlike the phase-entry heartbeat this
      // advances DURING a phase, which is what a long Implement needs.
      if (signalsFromStatus) signals.gate_status = signalsFromStatus;
      const hb = await stat(hbPath).catch(() => null);
      if (hb) signals.heartbeat = hb.mtimeMs;
      const watches = await ownedReviewWatches(wtPrefix);
      for (const watch of watches) {
        if (watch.eventsMtime) signals.review_events = Math.max(signals.review_events ?? 0, watch.eventsMtime);
      }
      // The gate's worktree is the Implement-phase signal: files being written
      // there is the activity the old watchdog could not see.
      if (runWorktreeCanonical || watches.length) {
        const wt = runWorktreeCanonical ?? join(REVIEWS_DIR, '..', 'worktrees');
        const mtime = await newestFileMtime(wt);
        if (mtime) signals.worktree_files = mtime;
      }
      const newest = newestActivity(signals);
      if (newest.at > lastActivity) {
        lastActivity = newest.at;
        activitySource = newest.source;
      }
      // Progress the operator can act on: where the gate is, what it is running
      // under, what the watchdog is about to do, and how fresh the evidence is.
      emit('gate_progress', {
        phase,
        round: expectedRound > 1 ? expectedRound - 1 : null,
        expectedRound,
        roundCap,
        worktree: runWorktreeCanonical,
        worktreePrefix: wtPrefix,
        branch: runBranch,
        gateEffort: statusEffort,
        reviewerModel: run.models?.reviewer?.model ?? null,
        reviewerEffort: run.models?.reviewer?.effort ?? null,
        makerModel: run.models?.maker?.model ?? null,
        lastActivityAt: lastActivity,
        lastActivitySource: activitySource,
        idleMs: Date.now() - lastActivity,
        idleKillMs: IDLE_KILL_MS,
        unboundRounds,
        asyncReattach: asyncReattachState,
      });
    }, 5000);
    const feedVerdict = (round, note) => log(`gate review round ${round}: ${note}`);

    const custody = createGateCustodyGuard(args);
    let custodyError = null;
    let authFailureNote = null;
    let claudeSessionId = null;

    const runIgniterTurn = (cliArgs) => new Promise((resolve) => {
      // Each igniter turn is a NEW claude process that may start with its
      // deferred tools unloaded, so it gets its own single Workflow-rehydration
      // budget. Reset here — at the one place every turn goes through — so an
      // await turn can never be starved by an earlier turn's lookup, while the
      // same-run and exact-args constraints stay global across all six turns.
      custody.beginTurn();
      // Pin the reviewer (auditor) for the gate's cross-vendor review via the
      // dedicated CAMUS_CODEX_MODEL channel, from the run-start snapshot.
      // codex_review.sh treats it as authoritative (appended last; refuses a
      // conflicting -m) so nothing silently overrides the recorded identity.
      const gateEnv = { ...process.env };
      const reviewerModel = run.models?.reviewer?.model;
      if (typeof reviewerModel === 'string' && reviewerModel) gateEnv.CAMUS_CODEX_MODEL = reviewerModel;
      // The trust anchor, on EVERY turn — the initial ignition and each reattach alike. It is
      // set here, at the one place all turns funnel through, precisely so a reattached turn
      // cannot run less anchored than the first one. Inheriting process.env is not enough: the
      // Studio server has no CAMUS_REPO_ROOT of its own, so without this line camus_anchor
      // no-ops and the guard is left measuring the runner's inherited cwd.
      if (repoAnchor) gateEnv.CAMUS_REPO_ROOT = repoAnchor;
      const child = spawn(
        'claude',
        cliArgs,
        { cwd: run.targetPath, stdio: ['ignore', 'pipe', 'pipe'], env: gateEnv },
      );
      let lineBuf = '';
      let result = null;
      let err = '';
      let done = false;
      // `closed` belongs to THIS child: only its own 'close' event sets it. A turn that had to be
      // force-resolved (the terminator's last-resort path, a hard timeout) resolves closed:false,
      // so a caller can never mistake "we stopped waiting" for "the process is gone".
      let thisChildClosed = false;
      // One log line per turn, however many times the stream repeats the refusal.
      let containedNoted = false;
      // 'exit' means THE PROCESS IS GONE; 'close' additionally waits for every stdio pipe to
      // close, and a detached reviewer that inherited stdout/stderr holds those open — so a
      // killed igniter could look un-closed for as long as its reviewer lived. Custody asks
      // whether the process is gone, so that is what is observed here (the 'close' handler still
      // owns the RESULT; this only records the fact).
      child.on('exit', () => { thisChildClosed = true; });
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(hardT);
        clearInterval(idleT);
        signal.removeEventListener('abort', onAbort);
        resolve({ exitCode: code, resultText: result ?? err, closed: thisChildClosed });
      };
      // STOP WAITS FOR THE IGNITER TO ACTUALLY EXIT. Resolving straight after
      // SIGTERM let reviewer cleanup and the sealed `stopped` result run while
      // the igniter was still dying — and a dying reattach can still launch or
      // hold a reviewer, so Studio reported "ended 1/1 detached reviewer" while a
      // codex process group was still alive (live run 20260805-072933-jezu).
      // Now: SIGTERM, wait for 'close' (the close handler calls finish), and
      // escalate to SIGKILL if it will not go. Only then does cleanup run.
      // The receipt poll's halt uses the SAME discipline as Stop: SIGTERM, wait for 'close',
      // escalate to SIGKILL. exitCode -5 marks a custody halt so no later phase runs.
      terminateIgniter = () => {
        if (done) return;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (done) return;                       // 'close' already landed → closed:true
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          // Give SIGKILL room to be reaped so the real 'close' can still resolve this turn with
          // closed:true; -5 is the last resort and deliberately reports closed:false.
          setTimeout(() => finish(-5), Math.max(1500, ABORT_GRACE_MS));
        }, ABORT_GRACE_MS);
      };
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (done) return;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          setTimeout(() => finish(-4), 500); // last resort: never hang Stop forever
        }, ABORT_GRACE_MS);
      };
      const hardT = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, HARD_TIMEOUT_MS);
      const idleT = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_KILL_MS) { child.kill('SIGKILL'); finish(-3); }
      }, 30_000);
      child.stdout.on('data', (b) => {
        lastActivity = Date.now();
        lineBuf += b;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            claudeSessionId ||= claudeSessionIdFromEvent(ev);
            authFailureNote ||= claudeAuthFailureNote(ev);
            const refused = custody.inspect(ev);
            if (refused) {
              custodyError = refused;
              child.kill('SIGKILL');
              finish(-5);
              break;
            }
            // A CONTAINED improvisation: the attempt was refused by the harness before it could
            // run, and the async workflow it belongs to is still bound and reattachable. Do NOT
            // kill — that is what destroyed wf_33300aac-c17. Let this process go and take the
            // reattachment back into the host's own hands below.
            if (custody.turnWasContained() && !containedNoted) {
              containedNoted = true;
              const last = custody.snapshot().contained.slice(-1)[0];
              log(`The gate's outer agent tried to use ${last?.tool ?? 'a forbidden tool'} instead of waiting on its own workflow. `
                + 'The attempt was refused before it could run and this turn is being discarded; '
                + `the bound workflow ${last?.afterRunId ?? ''} is untouched and Studio reattaches to it directly.`);
            }
            if (ev.type === 'result') result = String(ev.result ?? '');
            const s = sessionLineFromEvent(ev);
            if (s) {
              sess(s);
              // The gate's own commands name its phase; "Igniting…" for ten
              // minutes was Studio not reading what it already received.
              setPhase(gatePhaseFromSession(s));
            }
          } catch { /* non-JSON noise */ }
        }
      });
      child.stderr.on('data', (b) => { err += b; lastActivity = Date.now(); });
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
      child.on('close', (code) => {
        thisChildClosed = true;   // OBSERVED on THIS child, not inferred and not global.
        // An aborted igniter reports the STOP outcome, not whatever exit code a
        // SIGTERM produced — and it only lands here once the process is really
        // gone, which is the guarantee reviewer cleanup depends on.
        if (signal.aborted) return finish(-4);
        const closed = gateProcessClose({ code, authFailureNote, custody });
        custodyError ||= closed.custodyError;
        finish(closed.exitCode);
      });
    });

    // An igniter turn that improvised is DISCARDED, not read. Whatever an agent concluded while
    // reaching outside its contract is not evidence about the run — and the bound workflow is
    // still there, so the honest reading of that turn is "no answer yet", which is exactly the
    // shape that makes the host reattach. Captured immediately after each turn because the
    // per-process flag resets on the next one.
    const ASYNC_PENDING = { status: 'infra_error', note: 'gate returned no readable status' };
    let contained = false;
    const readTurn = (t) => {
      contained = custody.turnWasContained();
      if (contained) return { ...ASYNC_PENDING };
      return t.exitCode === 0 ? parseGateReport(String(t.resultText)) : null;
    };

    let turn = await runIgniterTurn(gateIgniterCliArgs(invocation));
    refusedTurnClosed = turn.closed === true;   // the turn a refusal would have terminated
    let report = readTurn(turn);
    let awaitTurns = 0;
    let asyncAwaitRequired = false;
    while (
      // A contained turn may have exited non-zero (an agent that improvised and then gave up);
      // the workflow it bound is still live, so the host is entitled to reattach either way.
      (turn.exitCode === 0 || contained)
      && report?.status === 'infra_error'
      && report.note === 'gate returned no readable status'
      && claudeSessionId
      && awaitTurns < ASYNC_AWAIT_TURNS
      // A REFUSED RECEIPT ENDS THE RUN. If the poll noticed the violation after the child had
      // already returned an async-shaped result, the terminator had nothing left to signal —
      // and without this guard Studio dispatched a fresh reattach turn on a run whose custody
      // was already refused (audit 2026-08-06).
      && !receiptViolation
    ) {
      asyncAwaitRequired = true;
      awaitTurns += 1;
      asyncReattachState = { awaiting: true, turn: awaitTurns, of: ASYNC_AWAIT_TURNS, sessionId: claudeSessionId?.slice(0, 8) ?? null };
      log(`The Camus workflow returned an asynchronous handle. Waiting on the same workflow (${awaitTurns}/${ASYNC_AWAIT_TURNS}); no second workflow will start.`);
      sess(`awaiting same workflow in Claude session ${claudeSessionId.slice(0, 8)}…`);
      turn = await runIgniterTurn(gateIgniterResumeCliArgs(claudeSessionId));
      refusedTurnClosed = turn.closed === true;   // a reattach turn replaces the earlier claim
      report = readTurn(turn);
    }

    if ((turn.exitCode === 0 || contained) && asyncAwaitRequired && report?.status !== 'infra_error' && !custody.snapshot().workflowRunId) {
      custodyError = 'gate custody refused: asynchronous workflow returned a terminal claim without a bound same-run Workflow resume';
      turn = { ...turn, exitCode: -5 };
    } else if (
      (turn.exitCode === 0 || contained)
      && asyncAwaitRequired
      && report?.status === 'infra_error'
      && report.note === 'gate returned no readable status'
      && awaitTurns >= ASYNC_AWAIT_TURNS
    ) {
      report = {
        status: 'infra_error',
        note: `the gate stayed asynchronous after ${ASYNC_AWAIT_TURNS} same-session waits; its state is preserved and no second workflow was started`,
      };
    }

    clearInterval(watcher);

    // A refused receipt is an INFRASTRUCTURE outcome: the gate is retried on the
    // same round, and the review loop never advances on evidence Studio could not
    // bind to the invocation it asked for.
    if (receiptViolation) {
      // THE SAME CLEANUP DISCIPLINE STOP USES. `haltedIgniter` previously meant only "a refusal
      // was recorded" — it proved nothing about the child closing or about detached reviewer
      // groups. The igniter's abort path waits for 'close', so by here the child is gone; the
      // reviewer groups it may have launched are not, so they are swept and PROVEN gone, twice
      // (a reviewer can be started while the igniter is dying).
      if (!ownedPrefix) {
        const late = gateStateFromStatus(await readGateStatus(idSalt).catch(() => null));
        if (late?.prefix) ownedPrefix = late.prefix;
      }
      const sweepOnce = () => (ownedPrefix
        ? abortOwnedReviewers(ownedPrefix).catch((e) => ({ attempted: [], orphans: [{ note: String(e.message || e), pid: null }], clean: false }))
        : Promise.resolve({ attempted: [], orphans: [], clean: true, note: 'no owned reviewer prefix was ever adopted' }));
      const sweepA = await sweepOnce();
      const sweepB = await sweepOnce();
      const cleanupClean = sweepA.clean === true && sweepB.clean === true;
      const orphans = [...(sweepA.orphans ?? []), ...(sweepB.orphans ?? [])];
      const closureProven = refusedTurnClosed === true;
      log(cleanupClean
        ? `Owned reviewer cleanup: clean (${(sweepA.attempted ?? []).length + (sweepB.attempted ?? []).length} attempted, no surviving group).`
        : `⚠ Owned reviewer cleanup could NOT be proven: ${orphans.length} orphan(s) — ${orphans.map((o) => o.pid ?? o.note ?? '?').join(', ')}.`);
      // NEVER claim preservation without proving it. Compare the snapshot taken at refusal with
      // one taken after confirmed shutdown; only agreement earns the word "unchanged".
      const after = worktreeSnapshot(receiptHalt?.worktree ?? null);
      const unchanged = snapshotsAgree(receiptHalt?.before ?? null, after);
      const where = after.worktree
        ? ` Worktree ${after.worktree}${after.branch ? ` on ${after.branch}` : ''}, HEAD ${after.head ?? 'unknown'}${after.dirty === null ? '' : after.dirty ? ' (uncommitted changes present)' : ' (clean)'}.`
        : ' No worktree was recorded, so nothing could be measured.';
      const verdict = unchanged
        ? ` MEASURED: worktree, branch, HEAD and cleanliness are identical to the moment the receipt was refused — nothing changed between refusal and confirmed shutdown.`
        : receiptHalt?.before
          ? ` MEASURED: the worktree CHANGED between refusal and shutdown (was HEAD ${receiptHalt.before.head ?? 'unknown'}${receiptHalt.before.dirty === null ? '' : receiptHalt.before.dirty ? ', dirty' : ', clean'}) — inspect it before resuming; do NOT assume it is preserved.`
          : ' NOT MEASURED: no snapshot was taken at refusal, so no preservation claim can be made.';
      const proven = closureProven && cleanupClean;
      return {
        status: 'infra_error',
        receiptViolation,
        // THREE DISTINCT FACTS, never collapsed: we asked, the child closed, the reviewers are gone.
        terminationAttempted: receiptHalt !== null,
        igniterClosed: closureProven,
        reviewerCleanupClean: cleanupClean,
        orphans,
        // Only true when BOTH closure and cleanup are proven. Anything less is a custody state.
        haltedIgniter: proven,
        ...(proven ? {} : { custody: 'orphaned_or_unproven' }),
        stateUnchanged: unchanged,
        stateBefore: receiptHalt?.before ?? null,
        stateAfter: after,
        note: proven
          ? `review receipt custody refused: ${receiptViolation}. The igniter was signalled immediately and its CLOSURE is confirmed, and the owned reviewer group(s) are proven gone, so no fix, commit or verification ran after the refusal.${where}${verdict} Resume re-runs the round.`
          : `review receipt custody refused: ${receiptViolation}. CUSTODY IS NOT PROVEN: termination was ${receiptHalt ? 'requested' : 'NOT requested'}, igniter closure ${closureProven ? 'confirmed' : 'NOT confirmed'}, owned reviewer cleanup ${cleanupClean ? 'clean' : `NOT proven (${orphans.length} orphan(s): ${orphans.map((o) => o.pid ?? o.note ?? '?').join(', ')})`}. Something of this run may still be executing — check before resuming.${where}${verdict}`,
      };
    }

    const { exitCode, resultText } = turn;
    if (exitCode === -4) throw new Error('stopped_by_human');
    if (exitCode === -6) return { status: 'infra_error', note: authFailureNote };
    if (exitCode === -5) {
      // Name what survived and whether retrying is safe, rather than a bare
      // refusal that reads like total loss (field report 2026-08-05).
      const live = gateStateFromStatus(await readGateStatus(idSalt).catch(() => null));
      return custodyRefusalReport({
        custodyError: custodyError || 'gate custody could not be established',
        workflowRunId: custody.snapshot().workflowRunId,
        worktree: live?.worktree ?? null,
        branch: live?.branch ?? null,
        phase: live?.phase ?? null,
      });
    }
    if (exitCode === -1) return { status: 'infra_error', note: `failed to spawn claude (${String(resultText).slice(0, 200)})` };
    if (exitCode === -2) return { status: 'infra_error', note: `the gate hit the studio's ${Math.round(HARD_TIMEOUT_MS / 60000)} min ceiling. Its state is preserved; Resume continues it` };
    if (exitCode === -3) return { status: 'infra_error', note: `no gate activity for ${Math.round(IDLE_KILL_MS / 60000)} min (no receipts, no heartbeat, no output); killed fail-closed, state preserved` };
    if (exitCode !== 0) return { status: 'infra_error', note: `claude exited ${exitCode}: ${String(resultText).slice(0, 300)}` };
    return report ?? parseGateReport(String(resultText));
  }

  try {
    stage('gate', 'active');
    const report = await igniteGate();
    // resolveGateTerminal owns the WHOLE terminal flow, including the gate's
    // human-question pause (needs_human / needs_decision) — handled inside its
    // loop so it applies uniformly to the first report and to any report a
    // Refine returns. Studio does not pre-drain questions here any more.
    // The re-verify path needs the parked worktree and this run's verifyCmd
    // snapshot; both come from the durable status record, so a resumed run gets
    // the same command the original was launched with.
    const live = gateStateFromStatus(await readGateStatus(idSalt).catch(() => null));
    const verifyCandidate = makeCandidateVerifier({
      worktree: live?.worktree ?? null,
      verifyCmd: run.verifyCmd ?? null,
    });
    return await resolveGateTerminal(report, { emit, log, stage, ask, igniteGate, answers, verifyCandidate });
  } catch (err) {
    if (err.message === 'stopped_by_human' || signal.aborted) {
      stage('gate', 'idle');
      // Stop OWNS the reviewer. The gate runs review detached, so killing the
      // igniter used to leave a codex wrapper reparented to PID 1 while Studio
      // sealed a clean `stopped` (field report 2026-08-04). End them through the
      // gate's own abort form and PROVE it before claiming a clean stop.
      // A stop can land before the watcher's poll ever adopted the prefix (an
      // early stop, or one during Implement) — the durable status record still
      // names the worktree, so re-read it rather than searching for nothing.
      if (!ownedPrefix) {
        const late = gateStateFromStatus(await readGateStatus(idSalt).catch(() => null));
        if (late?.prefix) ownedPrefix = late.prefix;
      }
      // The igniter has already CLOSED by now (its abort path waits for exit), so
      // no further reviewer can be launched by it after this point. One sweep is
      // still not enough: a reviewer may have been started while the igniter was
      // dying, so after the first pass we sweep AGAIN and merge anything new.
      // Without this, Stop reported a clean kill over a live codex group
      // (20260805-072933-jezu).
      const sweep = () => abortOwnedReviewers(ownedPrefix).catch((cleanupErr) => ({
        attempted: [], orphans: [{ note: String(cleanupErr.message || cleanupErr), pid: null }], clean: false,
      }));
      const first = await sweep();
      const second = await sweep();
      const seen = new Set(first.attempted.map((a) => a.dir));
      const cleanup = {
        attempted: [...first.attempted, ...second.attempted.filter((a) => !seen.has(a.dir))],
        orphans: [...first.orphans, ...second.orphans.filter((a) => !seen.has(a.dir))],
        clean: first.clean && second.clean,
      };
      if (second.attempted.some((a) => !seen.has(a.dir))) {
        log('Stop: a reviewer appeared while the gate was shutting down; the second sweep caught it.');
      }
      if (cleanup.attempted.length) {
        log(`Stop: ended ${cleanup.attempted.length - cleanup.orphans.length}/${cleanup.attempted.length} detached reviewer process(es) this run started.`);
      }
      if (!cleanup.clean) {
        // Unproven cleanup is NOT a clean stop. Name the survivors so a person
        // can end them, and report the infrastructure state honestly.
        const detail = cleanup.orphans.map((o) => `pid ${o.pid ?? 'unknown'}${o.note ? ` (${o.note})` : ''}`).join('; ');
        log(`⚠ Stop could not prove reviewer cleanup: ${detail}. Reporting an orphaned-reviewer infrastructure state rather than a clean stop.`);
        emit('error', { message: `stopped, but ${cleanup.orphans.length} detached reviewer process(es) survived: ${detail}` });
        emit('status', { status: 'failed', costUsd: null, billingMode: 'unknown' });
        return { status: 'failed', error: `orphaned reviewer process(es) after stop: ${detail}`, answers, orphanedReviewers: cleanup.orphans };
      }
      log('Stopped. The gate is crash-safe: its receipts and worktree survive, and Resume re-invokes it to continue.');
      emit('status', { status: 'stopped', costUsd: null, billingMode: 'unknown' });
      return { status: 'stopped', answers };
    }
    stage('gate', 'done', { pass: false });
    emit('error', { message: String(err.stack || err) });
    emit('status', { status: 'failed', costUsd: null, billingMode: 'unknown' });
    return { status: 'failed', error: String(err), answers };
  }
}
