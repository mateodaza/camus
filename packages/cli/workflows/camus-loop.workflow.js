export const meta = {
  name: 'camus-loop',
  description: 'Run the Camus closed loop on one task: plan → implement → (codex-review ↔ fix)* → verify',
  whenToUse: 'Drive one task through the v2-lite Camus gate. Pass the task in args: a string, or {task, targetPath, posture?}. posture ∈ full(default)|oneshot — oneshot runs ONE review + ONE unreviewed fix and reports done_with_findings (never "review clean"); deterministic verify gates in every posture.',
  phases: [
    { title: 'Classify',  detail: 'Cheap model rates complexity → routes the think-model (trivial→Sonnet, else Opus).' },
    { title: 'Plan',      detail: 'Think model reads relevant files, writes a short plan. No code.' },
    { title: 'Implement', detail: 'Think model makes the change in a dedicated git worktree.' },
    { title: 'Review',    detail: 'Thin runner execs codex_review.sh, echoes raw gate JSON (judgment is Codex).' },
    { title: 'Fix',       detail: 'Think model fixes blocking findings in the same worktree.' },
    { title: 'Verify',    detail: 'Thin runner execs verify.sh; pass→DONE, can\'t-run→inconclusive (not failed).' },
  ],
}

// ── ARGUMENT NORMALIZATION — FIRST, BEFORE ANY args-DERIVED CONSTANT ───────────
// The runtime can hand `args` over as a JSON STRING. This block used to sit ~70 lines below
// the constants, so every args-derived value above it read a string: `args.roundCap` was
// undefined and ROUND_CAP silently fell back to 3. Live run 20260806-091643-9nbv passed
// roundCap: 2 in both Workflow calls and in its persisted state, and the loop still launched
// r3 (audit 2026-08-06). Nothing that reads `args` may appear above this.
// args may be a bare string or {task, targetPath}. A STRING that parses as a JSON object is
// unwrapped first (live dogfood 2026-06-12, the loop-side F33): some callers stringify the
// object, and without this the ENTIRE JSON became the task text — the branch slug read
// "posture-full-targetpath-…" and posture/targetPath silently dropped. A bare-string task that
// merely starts with "{" but isn't valid JSON keeps working unchanged (parse failure → string).
if (typeof args === 'string' && args.trim().startsWith('{')) {
  try { args = JSON.parse(args) } catch (_) { /* a bare-string task, not JSON — leave it */ }
}

// ── Constants ──────────────────────────────────────────────────────────────
// Review↔fix rounds. Default 3; caller may raise it for a known-large task (run feedback
// 2026-06-10: a 15-file task converged P1→P1→P2 but ran out of rounds at the cap). Bounded
// 1..10 so a bad value can't turn the loop into a runaway.
const ROUND_CAP = (() => {
  const v = (args && typeof args === 'object') ? args.roundCap : undefined
  return (Number.isInteger(v) && v >= 1 && v <= 10) ? v : 3
})()
const INFRA_RETRIES = 2          // extra reviewer attempts when ran:false (total 3 tries)
// WATCHDOG RE-ATTACH BUDGET (2026-06-11): a review that outlives its first chunk returns
// {pending, handle}; the loop re-attaches in bounded `await` chunks (~5-8 min each), so total
// review time is unbounded by any single tool call. 6 chunks ≈ 40+ min of live, event-emitting
// review — past that we abort the process rather than wait forever (idle deaths are killed
// SCRIPT-side much earlier; this cap only catches alive-but-endless).
const AWAIT_CAP = 6
const TOKEN_TARGET_K = 12        // soft per-agent token target; runtime agent caps are the real backstop

// Model routing. A cheap CLASSIFY pass (Phase 0) picks the THINK model by task tier, so a
// trivial change doesn't pay Opus latency/rate-limits while a hard one still gets the best
// model. The two runner agents (review/verify) stay cheap regardless — they only exec a
// script and echo JSON; the judgment lives in Codex (review) and verify.sh's exit code.
const TIER_MODEL = { trivial: 'sonnet', standard: 'opus', complex: 'opus' }
const MODEL_RUNNER = 'haiku'     // review-runner, verify-runner (no judgment to apply)
// The skill lives in ~/.claude/skills (installed), NOT committed to the repo, so
// the worktree checkout has no `.claude/skills/camus`. Always invoke the
// installed copy by absolute path; cwd is the worktree so the tools see the change.
const SKILL_SCRIPTS = '"$HOME/.claude/skills/camus/scripts"'
// review.sh is the BACKEND DISPATCHER (VELOCITY §2, 0.2.6): resolves CAMUS_REVIEWER (default
// codex → codex_review.sh verbatim, including the watchdog await/abort forms); unknown backends
// fail closed on the cross-vendor invariant. The loop never knows which vendor reviews — only
// that the gate JSON contract holds.
const REVIEW_CMD = `bash ${SKILL_SCRIPTS}/review.sh`
const VERIFY_CMD = `bash ${SKILL_SCRIPTS}/verify.sh`
// Appended to the gating-verify prompt (live smoke run-6, 2026-06-12, feat-side finding applied
// loop-wide): a thin verifier EDITED the code under verification to turn red green and relayed
// pass:true. verify.py now snapshots tracked-file porcelain before/after and reports any dirt as
// a RED integrity failure — the clause states that fact so the incentive to "help" dies.
const VERIFY_OATH = `A RED result is a SUCCESSFUL run of this command — return it verbatim and STOP.
Do NOT edit, stage, commit, or "fix" ANYTHING, and do NOT re-run after changing files: the script
snapshots the tree and reports any tracked-file change as tampering (RED), so remediation can never
turn this green — it only destroys the evidence a human needs.`
const PREP_CMD = `bash ${SKILL_SCRIPTS}/prep.sh`     // make a fresh worktree runnable before verify
const COMMIT_CMD = `bash ${SKILL_SCRIPTS}/commit.sh` // commit reviewed work so the branch isn't empty
// Gate-owned git MUTATIONS live in allowlisted scripts (live smoke run-5, 2026-06-12): the
// auto-mode classifier denies agent-typed `git -c core.hooksPath=/dev/null …` as a guardrail
// bypass — commit.sh was never denied because its flags live INSIDE an allowlisted script.
// wt.sh carries the same hookless discipline plus the camus branch/worktree guard.
const WT_CMD = `bash ${SKILL_SCRIPTS}/wt.sh`         // worktree create (implement) / attach / resolve (land)
const CONTAIN_CMD = `bash ${SKILL_SCRIPTS}/containment.sh`  // main-tree containment RECEIPT {ran,dirty,paths}
// (field soak 2026-06-13, finding 8): the containment check now reads `git status --porcelain`
// MECHANICALLY in-script and emits a {ran} receipt — the loop parses it instead of asking a thin
// agent to echo git stdout. The old "non-empty agent reply ⇒ breach" both false-bred breaches
// (a preamble/error/budget stub looked like dirt) AND false-cleared real leaks (an empty reply on
// agent failure looked like a clean tree). Now: ran:false ⇒ inconclusive, never a verdict.

// SHELL-SAFETY (verification audit 2026-06-13, the injection class): values that get inlined into
// a shell command the thin runner executes must not be able to expand $(…)/backticks. INSIDE
// double quotes bash STILL expands those (JSON.stringify only quotes, it does not neutralize), so:
//  - shellSafe(): reject the in-double-quote-dangerous set for PATH-shaped inputs (targetPath,
//    agent-returned worktree paths) — a real path never contains these, so rejection is the right
//    UX (a weird path is an error, not a value to sanitize).
//  - shq(): POSIX single-quote a FREE-TEXT value (the review task context) that legitimately
//    contains shell metacharacters and so cannot be rejected — nothing expands inside '…'.
const _SHELL_UNSAFE = ['$', '`', '"', '\\', '\n', '\r']
const shellSafe = (s) => typeof s === 'string' && s.length > 0 && !_SHELL_UNSAFE.some((c) => s.includes(c))
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

const TASK = typeof args === 'string' ? args : (args && args.task) || ''
const TARGET = (args && typeof args === 'object' && args.targetPath) || ''
// targetPath is inlined into REPO_CD's `cd "…"` (verification audit 2026-06-13): a path with
// $(…)/backticks would execute. A real path never carries shell-dangerous chars, so REFUSE the run
// rather than cd into an attacker-controlled expression. (Defense in depth — camus-feat also rejects
// before forwarding; this protects a direct camus-loop call too.)
if (TARGET && !shellSafe(TARGET)) {
  return { status: 'aborted', stage: 'args', task: TASK,
    note: 'targetPath contains shell-unsafe characters ($ ` " \\ or newline) — refusing to use it as a shell cd target. Pass a plain filesystem path.' }
}
// args.verifyCmd (field soak 2026-06-13, finding 3): a per-run verify override for HEADLESS runs
// where there is no interactive shell to `export CAMUS_VERIFY_CMD`. Inlined as an ENV-ASSIGNMENT
// PREFIX: CAMUS_VERIFY_CMD="<value>" cmd. SHELL-INJECTION GUARD (verification audit 2026-06-13):
// INSIDE double quotes bash STILL expands $(…) / `…` and honors \ and " — JSON.stringify does NOT
// neutralize them (the EXACT trap okHandle guards on the review-handle path). A value carrying any
// of $ ` " \ or a newline is REFUSED (dropped → auto-detect verify still gates; named loudly),
// which also closes the escalation where an LLM-grounded camus-plan verifyCmd reaches the gate as
// arbitrary code execution. The accepted value is still JSON-quoted as belt.
const _VERIFY_CMD_RAW = (args && typeof args === 'object' && typeof args.verifyCmd === 'string' && args.verifyCmd.trim()) ? args.verifyCmd : ''
const VERIFY_CMD_OVERRIDE = shellSafe(_VERIFY_CMD_RAW) ? _VERIFY_CMD_RAW : ''
if (_VERIFY_CMD_RAW && !VERIFY_CMD_OVERRIDE) log('⚠ Ignoring args.verifyCmd: it contains shell-unsafe characters ($ ` " \\ or newline). Falling back to auto-detected verify — bake the command into your repo\'s test script instead.')
// Passed as a FLAG, not as an environment-assignment prefix. `CAMUS_VERIFY_CMD=... verify.sh <wt>`
// is not a plain trusted-script call: it matches no allow rule, and a real Haiku runner handed it in
// auto mode refused outright — it read an env-var assignment in front of a trusted script as an
// attempt to inject a command into that script (isolated auto-mode preflight, 2026-08-06; the
// classifier seam the shell test cannot reach). The value is still chosen and quoted here, so what
// the runner may influence is unchanged.
const VERIFY_ARG = VERIFY_CMD_OVERRIDE ? ` --verify-cmd ${JSON.stringify(VERIFY_CMD_OVERRIDE)}` : ''
// REPO_CD (dogfood run-8 + field soak finding "garland", 2026-06-12/13): worktree identity and
// every repo-reading command must run at the GIT TOPLEVEL, not whatever cwd the runner inherited.
// A launch from a SUBDIRECTORY computed a different worktree home (the basename was the subdir,
// not the repo) and made the implement agent edit the main tree — a containment leak. The fix is
// to ALWAYS resolve and cd to `git rev-parse --show-toplevel` (of targetPath if given, else cwd),
// so it no longer matters which folder the run was launched from. FAIL-CLOSED on a non-repo / bad
// targetPath: the inner `(cd <t> && git rev-parse) || echo <sentinel>` yields a non-existent
// sentinel path, so the outer `cd "<sentinel>"` ERRORS and the `&&` short-circuits the whole
// command (verification audit 2026-06-13: a bare `cd ""` is a no-op exit 0, NOT fail-closed —
// the sentinel makes the failure real). In a `cmd1 && cmd2` list bash expands cmd2's words AFTER
// cmd1 runs, so the $(git rev-parse …) inside WT_DEST resolves at the toplevel, the entire point.
const REPO_CD = `cd "$( (cd ${TARGET ? JSON.stringify(TARGET) : '.'} && git rev-parse --show-toplevel) || echo /nonexistent/camus-not-a-repo )" && `
// Identity composability has TWO deliberately separate seams:
//   - idSalt: feat ownership. It salts identity AND enables the feat-only main-tree
//     containment contract (the parent checkout is a camus/feat-* branch).
//   - identitySalt: standalone custody. It salts identity and heartbeat only; it does NOT
//     impersonate a feat. Studio uses this so stop/resume returns to one worktree without
//     running a containment check whose preconditions a standalone main checkout cannot meet.
// Passing both is refused: one run cannot be both parent-feat-owned and standalone-owned.
// SHELL-SAFETY (verification audit round-2, 2026-06-13): both are caller args that flow into
// commands the thin runner executes — branchPrefix → BRANCH, inlined UNQUOTED into wt.sh
// create/resolve/attach (so a `;`/space/$() in it runs); either salt → HB_TOUCH's heartbeat
// path (where $(…) expands inside double quotes). These are STRUCTURED values,
// so enforce a strict allowlist (letters, digits, / _ -) and abort rather than sanitize. This makes
// BRANCH entirely safe-charset at every site, quoted or not.
const _ID_OK = /^[A-Za-z0-9/_-]+$/
const BRANCH_PREFIX = (args && typeof args === 'object' && args.branchPrefix) || 'camus/'
const FEAT_ID_SALT = (args && typeof args === 'object' && args.idSalt) || ''
const STANDALONE_ID_SALT = (args && typeof args === 'object' && args.identitySalt) || ''
const TRACE_ID = (args && typeof args === 'object' && typeof args.traceId === 'string') ? args.traceId : ''
if (FEAT_ID_SALT && STANDALONE_ID_SALT) {
  return { status: 'aborted', stage: 'args',
    note: 'Pass either idSalt (feat-owned) or identitySalt (standalone custody), never both.' }
}
const IDENTITY_SALT = FEAT_ID_SALT || STANDALONE_ID_SALT
const FEAT_SCOPED = Boolean(FEAT_ID_SALT)
if ((args && typeof args === 'object' && args.branchPrefix && !_ID_OK.test(String(args.branchPrefix)))
    || (FEAT_ID_SALT && !_ID_OK.test(String(FEAT_ID_SALT)))
    || (STANDALONE_ID_SALT && !_ID_OK.test(String(STANDALONE_ID_SALT)))
    || (TRACE_ID && !/^[A-Za-z0-9:._/-]+$/.test(TRACE_ID))) {
  return { status: 'aborted', stage: 'args',
    note: 'branchPrefix / idSalt / identitySalt / traceId contain characters outside their strict safe sets. Refusing a value that could become an unsafe branch, path, or receipt identity.' }
}
// HITL: policy governs when the loop PAUSES to ask a human vs. acting and LOGGING the decision.
//   autonomous       — never ask; every notable call is recorded in `decisions`, human reviews at merge.
//   ask_on_ambiguity — ask only on genuine ambiguity / divergent readings / irreversible calls. (default)
//   ask_on_major     — also ask on any non-trivial design decision (more interruptions).
// Safety-axis HITL (destructive/out-of-repo actions) is handled separately by auto mode's classifier.
const POLICY = (args && typeof args === 'object' && args.policy) || 'ask_on_ambiguity'
const ASK_ON = { autonomous: [], ask_on_ambiguity: ['ambiguous'], ask_on_major: ['ambiguous', 'design_decision'] }
// REVIEW POSTURE (VELOCITY-DIRECTION §1, 0.2.6): the cadence of the PROBABILISTIC review — never
// the gate's presence. Deterministic verify is unskippable in EVERY posture; that is the moat.
//   full    — review↔fix rounds up to roundCap (today's behavior; default).
//   oneshot — ONE review; blocking findings get ONE fix pass and NO re-review; verify decides.
//             Result is done_with_findings (resolution: fixed_unreviewed) — the phrase "review
//             clean" is reserved for an actual clean reviewer verdict in every posture.
// bookend/forward are 0.3 (they need the feat-level final-review machinery) — rejected LOUDLY
// rather than silently downgraded to something that exists.
const POSTURE = (() => {
  const v = (args && typeof args === 'object' && typeof args.posture === 'string' && args.posture) || 'full'
  if (v === 'full' || v === 'oneshot') return v
  throw new Error(`camus-loop: posture "${v}" is not available (full|oneshot today; bookend/forward land in 0.3 with the final-review machinery — docs/VELOCITY-DIRECTION.md §1)`)
})()
// On resume after a needs_human pause, the caller threads the human's answer back in. When present
// we do NOT re-ask (the call is made) and feed it into plan + implement as resolved guidance.
const HUMAN_ANSWER = (args && typeof args === 'object' && args.humanAnswer && String(args.humanAnswer)) || ''
// Deterministic platform truths from the feat's env doctor (optional — standalone runs have none).
// Injected into plan/implement/fix prompts so agents stop rediscovering environment quirks mid-run
// (smoke 2026-06-11: the fix path improvised GNU `timeout` on a darwin host). ADVISORY context,
// never a gate; bounded so a runaway doctor can't bloat every prompt. Comes from args → stable
// across a journal resume (same args ⇒ same prompts ⇒ cache replay holds).
const ENV_FACTS = (args && typeof args === 'object' && typeof args.envFacts === 'string' && args.envFacts.trim().slice(0, 1500)) || ''
const envFactsBlock = ENV_FACTS ? `\nEnvironment facts (deterministic preflight — trust these, do not re-probe):\n${ENV_FACTS}\n` : ''
// SIBLING-TASK CONTEXT (fixlet 2026-06-11): per-task codex review can't see the feat decomposition,
// so it flags sibling tasks' surfaces as "incomplete" and fix agents bleed across task lanes. The
// feat passes the OTHER tasks' briefs; the reviewer judges THIS diff against them and the fixer is
// told hands-off. Advisory + bounded; standalone loops have none. Cheap mitigation ahead of the
// 0.3-grade scope-bleed healing (HARNESS-DIRECTION item 6).
const SIBLINGS = (args && typeof args === 'object' && typeof args.siblingTasks === 'string' && args.siblingTasks.trim().slice(0, 1200)) || ''
const siblingsBlock = SIBLINGS ? `\n\n## Sibling tasks in this feat (owned ELSEWHERE — do not flag their scope as missing here, do not touch their files)\n${SIBLINGS}` : ''
if (!TASK) throw new Error('camus-loop: no task in args (pass a string or {task, targetPath})')

const softBudget = `Soft budget: aim to stay under ~${TOKEN_TARGET_K}k tokens. Be terse; do not over-explore.`
const targetLine = TARGET ? `Target path (start here): ${TARGET}` : 'No target path given — discover the relevant files yourself.'

// Live token telemetry for the progress UI (run feedback 2026-06-10: surface spend like the
// harness does). budget.spent() is the TURN total (shared pool — under camus-feat it includes
// the feat's own spend); per-task deltas are computed by the feat. log()/result use ONLY —
// NEVER interpolate into an agent prompt, or resume cache-replay would miss on every run.
// `budget` ships with workflows GA (Claude Code >= 2.1.154, doc-checked 2026-06-10); degrade
// to silence on older runtimes — the gate must never crash over telemetry.
const spentTok = () => {
  try { return (typeof budget === 'object' && budget && typeof budget.spent === 'function') ? budget.spent() : null }
  catch (_) { return null }
}
const tokSuffix = () => {
  const s = spentTok()
  return s == null ? '' : ` — ~${Math.round(s / 1000)}k output tokens spent this turn`
}

// Deterministic worktree identity — computed here, never improvised by the agent.
// (Run-1 bug: the implement agent appended the repo path into git's commit-ish slot;
// we now hand it the exact command.)
// IMPORTANT: workflow scripts must be DETERMINISTIC so a resumed run replays identically —
// Math.random() and Date are banned (they break resume). The id is an FNV-1a hash of the
// task text: stable across a resume, distinct across different tasks. Re-running the SAME
// task collides on the branch/worktree on purpose — git fails loud; clean up or merge first.
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'
}
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}
// Salt makes the id feat-unique for a caller; empty salt preserves exact standalone hashing.
const RUN_ID = fnv1a(IDENTITY_SALT ? IDENTITY_SALT + '::' + TASK : TASK).slice(0, 6)
const SLUG = slugify(TASK)
const BRANCH = `${BRANCH_PREFIX}${SLUG}-${RUN_ID}`
const WT_NAME = `camus-wt-${SLUG}-${RUN_ID}`
// Worktrees live OUT of the project tree, under ~/.camus/worktrees/<repo>-<id>/ — NOT as
// siblings of the repo (run feedback 2026-06-10: per-task `../camus-wt-*` folders read as
// trash in the user's project dir; game-engine repos additionally must never host worktrees
// INSIDE the repo, asset importers scan the tree). ~/.camus is already the blessed mutable
// run-state home. $HOME and the repo name resolve in the implement agent's shell at the repo
// root; the target guard is location-independent (same git common-dir + basename coherence).
// DELIBERATE divergence from Claude Code's own `.claude/worktrees/<name>/` convention
// (code.claude.com/docs/en/worktrees, checked 2026-06-10): an IN-repo worktree dir shows as
// untracked and would trip camus-feat's clean-tree preflight unless every target repo
// gitignores it, and it puts a full project copy inside test-glob/backup-sync reach. Do not
// "fix" this back to the documented location without solving both.
// Parent = <basename>-<cksum of the absolute repo path>: basename alone collides across two
// repos both named "app"/"game" (review P2 2026-06-10); the cksum (POSIX, always present)
// makes the parent repo-unique while staying deterministic for the same repo.
// Keyed to the GIT TOPLEVEL, not `pwd` (field soak "garland" 2026-06-13): a subdir launch must
// resolve the SAME worktree home as a root launch — `git rev-parse --show-toplevel` is invariant
// across any cwd inside the repo, where `pwd -P` was not. (Migration: worktrees minted under the
// old pwd-keyed scheme won't match this path on resume — land-resolve simply recreates from the
// branch, the durable home; an in-flight feat spanning the upgrade may need a `git worktree prune`.)
const WT_PARENT_EXPR = `$HOME/.camus/worktrees/$(basename "$(git rev-parse --show-toplevel)")-$(git rev-parse --show-toplevel | cksum | cut -d' ' -f1)`
const WT_PARENT = `"${WT_PARENT_EXPR}"`
const WT_DEST = `"${WT_PARENT_EXPR}/${WT_NAME}"`

// HEARTBEAT (0.2.5 item 1 — "`running` must mean running"): under a feat or a custody-bound
// standalone run, every thin-runner command line and every think-phase prompt touches
// ~/.camus/feats/<identity>.hb FIRST,
// so that file's MTIME is a phase-boundary liveness signal status/watch read with NO transcript
// dependency (the 2026-06-11 smoke sat "state updated 19m ago" mid-task with no way to tell churn
// from death). Wall-clock lives in the FILE's mtime, never in this script — Date is banned here
// (resume determinism), which is exactly why the stamp is a side effect of the agents' shells.
// Standalone loops (no salt) skip it: the .hb name is feat identity.
const HB_TOUCH = IDENTITY_SALT ? `touch "$HOME/.camus/feats/${IDENTITY_SALT}.hb" 2>/dev/null; ` : ''

// ── GATE NONCE + DURABLE STATUS (field report 2026-08-04, a WP6 game run) ────
// RUN_ID is derived from the identity and the task, never from wall clock, so the
// nonce is stable across resumes (Date is banned in this script) and is a value
// this WORKFLOW computes — not one a thin runner can supply, retype, or drop.
// Hybrid-kernel runs bind the reviewer to the kernel attempt AND the deterministic task id.
// Legacy/direct callers omit traceId and keep the byte-stable historical nonce.
const GATE_NONCE = TRACE_ID ? `${TRACE_ID}:${RUN_ID}` : `${IDENTITY_SALT || 'camus'}:${RUN_ID}`
// The reviewer identity the CALLER decided (Studio passes its run-start snapshot).
// This script cannot read the environment, so an identity it must verify has to
// arrive as an argument. Absent (a direct camus-loop call), the model/backend
// checks are skipped rather than guessed — round, effort and nonce still bind.
const REVIEWER_MODEL = (args && typeof args === 'object' && typeof args.reviewerModel === 'string' && shellSafe(args.reviewerModel)) ? args.reviewerModel : ''
const REVIEWER_BACKEND = (args && typeof args === 'object' && typeof args.reviewerBackend === 'string' && shellSafe(args.reviewerBackend)) ? args.reviewerBackend : 'codex'
const STATUS_SCRIPT = `python3 ${SKILL_SCRIPTS}/status_record.py`
const REQUEST_SCRIPT = `python3 ${SKILL_SCRIPTS}/review_request.py`
// The heartbeat's mtime says "a phase started". It does NOT say which phase, in
// which worktree, at which requested round/effort — and a phase-entry touch went
// stale during a long Implement while files were being written, so Studio's
// watchdog killed live work and its UI showed "Igniting…" for ten minutes. This
// record is the durable answer, written mechanically as a command PREFIX exactly
// like HB_TOUCH: the values are inlined here by the orchestrator, so a runner
// that mangles the command it was given cannot change what gets recorded.
const statusWrite = (fields) => IDENTITY_SALT
  ? `${STATUS_SCRIPT} write --salt ${IDENTITY_SALT} --nonce ${JSON.stringify(GATE_NONCE)} ${fields} >/dev/null 2>&1; `
  : ''
const statusPhase = (phaseName, extra = '') => statusWrite(`--phase ${JSON.stringify(phaseName)}${extra ? ' ' + extra : ''}`)
// MID-PHASE LIVENESS IS THE HOST'S JOB, NOT THE MODEL'S. An earlier design asked
// the think agent to report progress after every file it changed; that
// instruction was never wired into any prompt, and reinstating it would buy
// continuous liveness with model-mediated bookkeeping — the same mistake as the
// per-phase status agents. Studio already derives liveness from signals it owns:
// the igniter's own event stream, worktree file mtimes, and growing review-watch
// events (see newestActivity in code-lane.mjs). If mid-phase liveness ever needs
// to be sharper, it gets sharper THERE, in the host, not by spending model turns.
//
// PHASE STAMPS RIDE EXISTING WORK — they never buy their own agent turn. The
// first cut spawned a dedicated runner per think phase, and a live WP6 run spent
// ~40k tokens on three of them before any review happened (2026-08-05): an agent
// turn costs its whole context, so a "thin" stamp is not thin. Now the stamp is
// one line inside a prompt an agent was already going to run, or is chained onto
// a phase's own shell command. Same best-effort observability, no extra turns.
const hbLine = (phaseName) => IDENTITY_SALT
  ? `\nFirst, run \`touch "$HOME/.camus/feats/${IDENTITY_SALT}.hb" 2>/dev/null; ${STATUS_SCRIPT} write --salt ${IDENTITY_SALT} --nonce ${JSON.stringify(GATE_NONCE)} --phase ${JSON.stringify(phaseName)} >/dev/null 2>&1\` (liveness heartbeat and phase marker — ignore any failure), then proceed.\n`
  : ''

// ── Schemas (only where the script needs structured fields) ──────────────────
const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tier', 'reason'],
  properties: {
    tier: { type: 'string', enum: ['trivial', 'standard', 'complex'] },
    reason: { type: 'string', description: 'one short sentence justifying the tier' },
  },
}
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'relevant_files', 'clarity'],
  properties: {
    plan: { type: 'string', description: 'Short ordered plan. What to change and why. No code.' },
    relevant_files: { type: 'array', items: { type: 'string' }, description: 'Files the change will touch.' },
    clarity: { type: 'string', enum: ['clear', 'design_decision', 'ambiguous'],
      description: 'clear = exactly one obvious correct implementation. design_decision = a real non-trivial design choice with tradeoffs exists, though a sensible default can be picked. ambiguous = genuinely under-specified, valid interpretations DIVERGE, the change is irreversible, OR the approach embeds a user-visible product tradeoff (data loss/alteration, external behavior or contract change) the task does not decide — product calls are human calls, must not be guessed.' },
    question: { type: 'string', description: 'If not clear: the single specific question/decision blocking a confident implementation. Else "".' },
    interpretations: { type: 'array', items: { type: 'string' }, description: 'If ambiguous: the divergent valid readings. Else [].' },
  },
}
const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worktree_path', 'branch', 'summary'],
  properties: {
    worktree_path: { type: 'string', description: 'Absolute path of the git worktree where the change was made.' },
    branch: { type: 'string', description: 'Branch name created for the worktree.' },
    summary: { type: 'string', description: 'One-paragraph summary of what was changed.' },
    files_changed: { type: 'array', items: { type: 'string' } },
    decisions: {
      type: 'array',
      description: 'Notable design decisions made while implementing — a chosen default for an unspecified case, a signature/API change, a tradeoff, an assumption. EMPTY if the change was wholly mechanical. This is the audit trail a human reviews at merge.',
      items: {
        type: 'object', additionalProperties: false, required: ['what', 'why'],
        properties: {
          what: { type: 'string', description: 'The decision made, concretely (e.g. "widened content: string → content?: unknown").' },
          why: { type: 'string', description: 'Why this choice.' },
          alternative: { type: 'string', description: 'A reasonable alternative not taken, if any.' },
        },
      },
    },
  },
}

// ── Helpers: the script — NOT an agent — parses the JSON the agents return ────
// Defensively extract the first balanced top-level JSON object from agent stdout.
function extractJsonObject(raw) {
  if (raw == null) return null
  let s = String(raw).trim()
  // strip ``` / ```json fences if the agent wrapped output despite instructions
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch (_) { return null } } }
  }
  return null
}

// Map any reviewer output to the gate contract. Anything we can't parse, or that
// lacks a boolean `ran`, is treated as an INFRA failure (ran:false) — same
// philosophy as adapter.py: never silently clean, never a rejection.
function asGate(raw, expected) {
  const infra = (error) => ({ ran: false, error, clean: false, blocking: [], nonblocking: [] })
  const g = extractJsonObject(raw)
  // A PENDING HANDLE IS NOT A RECEIPT. The review is still running; it carries no verdict, no
  // findings and no binding. Treating it as a completed review would let an empty `blocking`
  // read as CLEAN and send the loop straight to commit/verify (live run 20260806-110809-2r9j).
  // It is named separately from unparseable output so the caller can tell "still running" from
  // "broken runner", and so it can never satisfy the verdict path.
  if (g && g.pending === true) {
    return { ran: false, pending: true, handle: typeof g.handle === 'string' ? g.handle : null,
      error: 'the reviewer returned a PENDING handle, not a verdict — a pending review is never a receipt', clean: false, blocking: [], nonblocking: [] }
  }
  if (!g || typeof g.ran !== 'boolean') {
    return infra('reviewer output not parseable as gate JSON')
  }
  if (g.ran && g.clean !== true && !Array.isArray(g.blocking)) {
    return infra('gate JSON missing blocking[] on non-clean verdict')
  }
  if (!g.ran || !expected) return g

  // ── BINDING CHECK (field report 2026-08-04, a WP6 game run) ────────────────
  // The loop used to accept any parseable {ran, clean, blocking}. It asked for
  // round 2 at high effort; the thin runner's Bash call dropped `2 high`; the
  // reviewer defaulted to round 0 / medium; and this function said yes, because
  // nothing it checked disagreed with anything else it could see. A receipt can
  // only be trusted against values known INDEPENDENTLY of the receipt — which is
  // what `expected` is: computed by this workflow, inlined into the command, and
  // never round-tripped through an agent.
  const b = g.binding
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return infra('reviewer output carries no binding block, so the round/effort/model it actually ran cannot be confirmed. '
      + 'Reinstall the gate (camus install) — an unbindable review is infrastructure, not a verdict.')
  }
  const mismatches = []
  const want = (label, actual, wanted) => {
    if (wanted === null || wanted === undefined || wanted === '') return
    if (actual !== wanted) mismatches.push(`${label}: ran ${JSON.stringify(actual)}, requested ${JSON.stringify(wanted)}`)
  }
  want('round', b.round, expected.round)
  want('effort', b.effort, expected.effort)
  want('reviewer model', b.model, expected.reviewerModel)
  want('reviewer backend', b.backend, expected.backend)
  // Compare the worktree by BASENAME: the name carries the task slug and this
  // run's id, so it identifies the checkout, while full-path equality would
  // false-refuse wherever the path is reached through a symlink (/tmp on macOS).
  if (expected.worktreeName) {
    const ranName = typeof b.worktree === 'string' ? b.worktree.replace(/\/+$/, '').split('/').pop() : null
    want('worktree', ranName, expected.worktreeName)
  }
  // A missing nonce is a REFUSAL, not a pass: it means the review ran without
  // this gate run's identity, so nothing ties it to the work in front of us.
  if (!b.nonce) mismatches.push('gate nonce: the review recorded none, so it cannot be tied to this run')
  else want('gate nonce', b.nonce, expected.nonce)
  if (mismatches.length) {
    return infra(`reviewer ran a different review than the one requested — ${mismatches.join('; ')}. `
      + 'Treated as reviewer infrastructure failure; the round is retried and the loop does not advance.')
  }
  return g
}

// A runner that never executed the command still SAID something, and its words are the only
// evidence of what actually happened. Live run 20260806-145411-hy1w: auto mode denied the verify
// command, the thin runner replied in prose, asVerify threw that prose away for a generic
// "not parseable", and the loop reported a missing .NET toolchain in a worktree whose toolchain
// was fine — sending the operator after dependencies that were never involved. So: keep a BOUNDED
// verbatim tail, and distinguish "refused to run it" from "ran it and I couldn't read the output".
const RUNNER_TAIL_MAX = 1200
const runnerTail = (raw) => {
  const s = (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)).trim()
  return s.length > RUNNER_TAIL_MAX ? `…${s.slice(-RUNNER_TAIL_MAX)}` : s
}
// The runner is INSTRUCTED to prefix a refusal with RUNNER_COULD_NOT_EXECUTE. That marker is the
// reliable signal; the phrase list is the fallback for a runner that improvised instead (thin
// models do), matched only in the absence of parseable JSON, so it can never reclassify a real
// verdict. Either way this only picks the KIND — the tail travels verbatim regardless.
const RUNNER_REFUSAL_RE = /RUNNER_COULD_NOT_EXECUTE|\b(?:permission denied|not permitted|denied|blocked|refus\w+|rejected|requires approval|needs approval|not (?:allowed|approved|authorized)|(?:can ?not|cannot|couldn'?t|unable to|won'?t) (?:run|execute)|do(?:es)? not have (?:permission|access))\b/i
function asVerify(raw) {
  const v = extractJsonObject(raw)
  if (!v || typeof v.pass !== 'boolean') {
    const tail = runnerTail(raw)
    const refused = RUNNER_REFUSAL_RE.test(tail)
    return { pass: false, inconclusive: true,
      failures: [{ stage: 'verify', exit: -1,
        kind: refused ? 'runner_refused' : 'runner_unparseable',
        log_tail: tail
          ? `${refused
              ? 'the verification command was NOT executed — the runner was refused or denied'
              : 'the runner returned something other than verify JSON'}; its reply verbatim (tail): ${tail}`
          : (refused ? 'the runner refused the verification command and said nothing else'
                     : 'the runner returned NOTHING where verify JSON was expected') }] }
  }
  return v
}

// ── LAND MODE (run-5 fix 2026-06-11): land work that is ALREADY proven, without re-running the
// loop. The run-4/5 thrash: a review-clean, verify-clean diff sat staged in its worktree, and the
// only resume path re-entered plan→implement→review — where a flaky review infra_errored before
// ever committing. The loop's weakest link was landing code it had already proven correct.
// `land:true` goes straight to commit → prep → verify → done. Review is deliberately NOT re-run
// (it already passed, or a human accepted a verify-clean review_unresolved halt); deterministic
// verify remains the unskippable arbiter — landing is mechanical, shipping is still earned.
const LAND = !!(args && typeof args === 'object' && args.land === true)
// The sha the ORIGINAL proof certified (feat state's provenCommit, publish audit round-2):
// when the land's stage is empty, this is the only honest expectation for the bound verify.
const LAND_EXPECT = (LAND && args && typeof args.expectHead === 'string' && args.expectHead.trim()) ? args.expectHead.trim() : ''
if (LAND) {
  phase('Commit')
  // Resolve the EXISTING worktree at the same deterministic destination implement would have
  // created — with the same fail-closed path validation (audit F3: never cd/exec an unvalidated
  // path). No worktree → nothing to land → abort, never plan/implement under land.
  // Land-resolve via wt.sh's JSON {found,path} contract (audit 2026-06-13, item 6 — replaces the
  // brittle `cd && pwd` last-line pop(), which a trailing commentary line could poison). A
  // non-parseable reply or found:false routes to recreate-from-branch (itself fail-closed) — never
  // a silently-picked path.
  const wtRaw = await agent(
    `THIN land-path resolver. Run EXACTLY this one command and output its stdout VERBATIM (one JSON object — {found,path}); no fences, no commentary:
  ${HB_TOUCH}${REPO_CD}${WT_CMD} resolve ${JSON.stringify(BRANCH)} ${WT_DEST}`,
    { model: MODEL_RUNNER, phase: 'Commit', label: 'land-resolve' }
  )
  const wtJ = extractJsonObject(wtRaw)
  let wt = (wtJ && wtJ.found === true && typeof wtJ.path === 'string') ? wtJ.path.trim() : ''
  if (!wt || !wt.endsWith(WT_NAME) || !shellSafe(wt)) {   // shellSafe: no $()/backtick before it hits a shell
    // RECREATE FROM THE BRANCH (live smoke run-4, 2026-06-12): the work's durable home is the
    // BRANCH — the worktree was always just a checkout, and lanes legitimately remove it (the
    // noop path did here) while the proven commits survive. A missing checkout must not abort a
    // land. NOTE the deliberate contrast: attaching an existing branch is exactly what the
    // implement agent is FORBIDDEN to improvise (a fresh task needs a fresh base) and exactly
    // right here, where reusing the branch's commits IS the point. Hookless like every
    // gate-owned mutation.
    const reRaw = await agent(
      `THIN land-worktree recreator. The land worktree is missing but the task branch holds the proven work. Run EXACTLY this one command and output its stdout VERBATIM (one JSON object); no fences, no commentary:
  ${HB_TOUCH}${REPO_CD}${WT_CMD} attach ${JSON.stringify(BRANCH)} ${WT_DEST}`,
      { model: MODEL_RUNNER, phase: 'Commit', label: 'land-recreate' }
    )
    const reJ = extractJsonObject(reRaw)
    const re = (reJ && reJ.ok === true && typeof reJ.path === 'string') ? reJ.path.trim() : ''
    if (!re || !re.endsWith(WT_NAME) || !shellSafe(re)) {   // shellSafe: no $()/backtick before it hits a shell
      // Quote the script's error VERBATIM (run-5, 2026-06-12: a permission denial was reported
      // as "branch missing" because the failure text was discarded — the note must carry the
      // real cause, whatever it is).
      const why = (reJ && reJ.error) ? String(reJ.error) : 'unparseable recreate output'
      return { status: 'aborted', stage: 'land', task: TASK, branch: BRANCH, landed: false,
        note: `Land mode found no worktree at ${WT_DEST} AND the recreate from ${BRANCH} failed — wt.sh said: "${why}". The branch's commits are untouched (inspect: git log ${BRANCH}). Fix the named cause and re-run; if the branch genuinely holds no work, re-run WITHOUT land:true to do it through the full loop.` }
    }
    wt = re
    log(`Land mode: worktree was gone — recreated it from ${BRANCH} (the commits are the work; the checkout is scaffolding).`)
  }
  log(`Land mode: committing previously verified work in ${wt} — skipping plan/implement/review (deterministic verify still gates)${tokSuffix()}.`)
  const commitRaw = await agent(
    `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(wt)} ${JSON.stringify('chore(camus): land ' + SLUG)}`,
    { model: MODEL_RUNNER, phase: 'Commit', label: 'commit' }
  )
  const commitResult = extractJsonObject(commitRaw) || { committed: false, reason: 'unparseable' }
  const lrc = commitReceipt(commitResult)
  // The feat's recorded proof (args.expectHead), SHA-VALIDATED (audit 2026-07-06 — was bound raw). This is the
  // ONLY head an EMPTY stage (no fresh seal, no live tip) may bind to.
  const landExpectSha = asSha(LAND_EXPECT)
  // Fail CLOSED on anything with no certifiable head: a real failure, a committed:true with no sha, OR an empty
  // stage that named NO valid HEAD and has no recorded proof (Mateo's re-audit: commit.sh emits a sha even on
  // empty, so a sha-less empty is a relay contract violation — never a null-bound "legacy" done).
  if (lrc.kind === 'failed' || lrc.kind === 'noSha' || (lrc.kind === 'empty' && !landExpectSha)) {
    return { status: 'infra_error', task: TASK, worktree: wt, branch: BRANCH, rounds: 0, landed: true,
      error: `land commit failed: ${lrc.kind === 'noSha' ? 'committed:true but no valid sha (got ' + JSON.stringify(commitResult.sha) + ')' : (lrc.kind === 'empty' ? 'empty stage named no valid HEAD sha and there is no expectHead proof to bind the verify to' : (lrc.reason || 'unknown'))}`,
      note: 'Land mode could not obtain a certifiable commit (git error/identity/hook, unparseable output, a committed:true receipt with no valid git sha, or an empty stage with neither a HEAD sha nor a recorded proof — head-binding cannot certify an unnamed commit). Fix the cause and re-run with land:true — the worktree is untouched.' }
  }
  const landSha = lrc.kind === 'sealed' ? lrc.head : null
  log(landSha
    ? `Committed previously verified work (${landSha}) to ${BRANCH}.`
    : 'Land mode: stage was empty — the work was already committed on the branch; proceeding to verify.')
  // BINDING PRECEDENCE (publish audit round-2 P1 — the empty-stage land believed unbound
  // greens): fresh seal (this run's commit) > the ORIGINAL proof's sha (feat state, via
  // args.expectHead) > the live tip commit.sh read under trust (legacy states with no recorded
  // proof). The middle case is the auditor's scenario made fail-closed: a task-branch tip that
  // moved past the proof now FAILS the bound verify (head_mismatch names both shas) instead of
  // being believed and merged.
  // The empty-stage HEAD commit.sh read, now SHA-VALIDATED (audit 2026-07-06 — was trusted as any string).
  const liveTip = lrc.kind === 'priorHead' ? lrc.head : null
  const v = await prepAndVerify(wt, landSha || landExpectSha || liveTip)
  if (v.ok === 'inconclusive') {
    return { status: 'verify_inconclusive', task: TASK, worktree: wt, branch: BRANCH, rounds: 0, landed: true, failures: v.failures,
      commit_sha: (landSha || landExpectSha || liveTip), parkedSha: (landSha || landExpectSha || liveTip),
      note: 'Land mode committed, but deterministic verify could not RUN (env not ready — see failures). Fix the environment and re-run with land:true.' }
  }
  if (v.ok === 'pass') {
    return { status: 'done', task: TASK, worktree: wt, branch: BRANCH, commit_sha: landSha, rounds: 0, landed: true,
      summary: 'Landed previously verified work (land mode: commit → verify only).', decisions: [],
      note: 'Land mode: committed and deterministically verified — no re-plan/re-implement/re-review (the work was already proven). Ready to merge.' }
  }
  return { status: 'verify_failed', task: TASK, worktree: wt, branch: BRANCH, rounds: 0, landed: true, failures: v.failures,
    note: 'Land mode: deterministic verify did NOT pass — this worktree is not actually clean. Re-run WITHOUT land:true to fix it through the full loop.' }
}

// Parent-tree dirt BASELINE (re-soak 2026-06-14): containment.sh now reports UNTRACKED files too (an
// untracked leak breaks the merge), but the parent tree may legitimately hold un-ignored artifacts the
// feat's baseline-verify wrote BEFORE this task. So capture the dirt set ONCE at loop start (before any
// phase that could leak — classify is Phase 0) and treat ONLY dirt that appears AFTER as a breach
// (delta). Feat-scoped only; a standalone loop never runs containment. An inconclusive
// baseline → empty allowed-set: a real leak still fires, and we never manufacture a false clean.
const dirtLines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)
// RELAY-RECEIPT VALIDATION (PR2, 2026-06-29): containment.sh is mechanical, but the workflow reads its
// JSON through a thin Haiku runner that can HALLUCINATE a well-formed-but-contract-violating receipt —
// observed live emitting `paths` as an ARRAY of the repo root (echoed from its own
// `$(git rev-parse --show-toplevel)`), which dirtLines(String(array)) coerced into a fake dirt line → a
// FALSE breach on a clean tree. This applies the "stop trusting relays, read receipts" discipline to the
// containment receipt — the highest-stakes relay, since its hallucination directly fabricates a verdict (a
// false breach/clean). The relay doctrine: a relay is a transcription to cross-check, never a source of truth.
// Validate the receipt against containment.sh's contract and RETRY a malformed one; an unrecoverable receipt
// becomes {ran:false} ⇒ inconclusive (never a false breach, never a false clean).
const CONTAINMENT_TRIES = 3
// git porcelain v1: every line is "XY <path>" — two status columns (each ∈ space M A D R C U ? !) then a
// space. Validate RAW lines: the columns are position-significant (an unstaged edit is " M f", X=space), so
// trimming first (as dirtLines does) would reject a legitimate receipt and turn a real breach into a
// permanent inconclusive — exactly the kind of safety regression this check exists to prevent.
const PORCELAIN_LINE = /^[ MADRCU?!][ MADRCU?!] ./
function validContainmentReceipt(r) {
  if (!r || typeof r !== 'object') return false
  if (r.ran === false) return true                                   // an explicit unobtained answer is valid → inconclusive
  if (r.ran !== true || typeof r.paths !== 'string' || typeof r.dirty !== 'boolean') return false
  const lines = String(r.paths).split('\n').filter((l) => l.length > 0)
  if (r.dirty !== (lines.length > 0)) return false                   // dirty must agree with paths
  return lines.every((l) => PORCELAIN_LINE.test(l))                  // every dirt line must be real git porcelain
}
// COMMIT-RECEIPT → EXPECTED HEAD (relay audit 2026-06-29; centralized + hardened 2026-07-06 per Mateo's
// audit). commit.sh emits a real `git rev-parse HEAD` in BOTH the fresh-seal case ({committed:true, sha})
// AND the empty-stage case ({committed:false, reason:"empty", sha}: the work is a PRIOR commit at that HEAD).
// Every gating verify MUST bind to that sha, or a headless / fabricated {pass:true} relay is believed (the
// run-6 cover-up hole). A git object name is 40 (sha-1) or 64 (sha-256) hex — commit.sh never emits anything
// else, so anything else is a garbled/hallucinated relay. ONE helper now serves the normal, park, AND land
// paths (the earlier fix left land unbound and ignored the empty-stage sha, and its gate was too loose).
// function declarations (not const) so the LAND path — which runs BEFORE this line textually — can call
// them (hoisted; same reason prepAndVerify is a declaration). A const here is a temporal-dead-zone crash.
function asSha(s) { return (typeof s === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(s)) ? s : null }
function commitReceipt(r) {
  if (!r || typeof r !== 'object') return { kind: 'failed', reason: 'unparseable' }
  if (r.committed === true) { const head = asSha(r.sha); return head ? { kind: 'sealed', head } : { kind: 'noSha' } }
  if (r.reason === 'empty') { const head = asSha(r.sha); return head ? { kind: 'priorHead', head } : { kind: 'empty' } }
  return { kind: 'failed', reason: r.reason || 'unknown' }
}
async function runContainment(label, grp) {
  let last = null
  for (let attempt = 1; attempt <= CONTAINMENT_TRIES; attempt++) {
    const raw = await agent(
      `THIN containment runner. Run EXACTLY this one command and output its stdout VERBATIM as your entire reply (it is JSON — {ran,dirty,paths} or {ran,error}); no fences, no commentary:
  ${HB_TOUCH}${REPO_CD}${CONTAIN_CMD} "$(git rev-parse --show-toplevel)"`,
      { model: MODEL_RUNNER, phase: grp || 'Review', label }
    )
    const r = extractJsonObject(raw)
    if (validContainmentReceipt(r)) return r
    last = r
    log(`Containment receipt failed contract validation (${label}, attempt ${attempt}/${CONTAINMENT_TRIES}) — likely a hallucinated relay.`)
  }
  // Every retry produced a contract-violating receipt — treat as UNOBTAINED (inconclusive), never a verdict.
  return { ran: false, error: ('containment receipt failed contract validation after ' + CONTAINMENT_TRIES + ' tries (likely a hallucinated relay); last=' + JSON.stringify(last)).slice(0, 280) }
}
let containmentBaseline = new Set()
if (FEAT_SCOPED) {
  const b = await runContainment('containment:baseline', 'Classify')
  containmentBaseline = new Set((b && b.ran === true) ? dirtLines(b.paths) : [])
}

// ── Phase 0: CLASSIFY complexity → route the think-model ─────────────────────
// Override reads are hoisted above the classifier because they decide whether it
// is worth running at all (see CLASSIFY_MOOT).
const MODEL_OVERRIDE = (args && typeof args === 'object' && typeof args.model === 'string' && args.model) || ''
const TIER_OVERRIDE = (args && typeof args === 'object' && TIER_MODEL[args.modelTier]) ? args.modelTier : ''
// Opt-in (default OFF). Only honored under policy:autonomous (see skip-plan block) so it can never
// silently disable ambiguity detection / the needs_human ask-gate on an asking policy.
const SKIP_PLAN_REQ = !!(args && typeof args === 'object' && args.skipPlan === true)
// Read from args directly: PINNED_EFFORT itself is declared later (beside
// pickReviewEffort, where it is used), so referencing it here would be a TDZ error.
const EFFORT_PINNED = !!(args && typeof args === 'object' && typeof args.reviewerEffort === 'string'
  && ['low', 'medium', 'high', 'xhigh'].includes(args.reviewerEffort.trim()))

// COST: the classifier is not free — a live WP6 run spent ~35k tokens and 103s on
// it (2026-08-05). Its tier only ever feeds three decisions: the think model, the
// review effort, and the trivial-task skip-plan. When the caller has already
// pinned the model AND the effort and did not ask for skip-plan, the tier cannot
// change ANY of them, so running it buys nothing but latency and spend. Studio
// always pins both, so its Build runs skip this entirely. A tier override makes it
// moot for the same reason. Ambiguity detection is unaffected: that lives in the
// PLAN phase's ask-gate, which still runs.
const CLASSIFY_MOOT = !!TIER_OVERRIDE || (!!MODEL_OVERRIDE && EFFORT_PINNED && !SKIP_PLAN_REQ)

// When the caller already supplied a BINDING acceptance contract (Studio always
// does), the plan's job is to route that contract into files — not to rediscover
// the requirements. A live run spent ~51.5k tokens and 21 tool calls re-surveying
// a repo whose 5,554-character contract already named the work (2026-08-05). This
// bounds the survey without touching the ask-gate: clarity is still assessed, and
// a genuinely ambiguous task still pauses.
const HAS_BINDING_CONTRACT = /\bAcceptance contract \(binding\):/.test(TASK)
const CONTRACT_SCOPED_PLAN = HAS_BINDING_CONTRACT
  ? `\nThe task above already carries a BINDING acceptance contract. Plan AGAINST it: it is the requirement set, so do not re-derive requirements or survey the wider repository. Open only the files the contract and task name, plus any file you must read to place a named change correctly. Prefer the smallest survey that lets you name the files and the order of work; a broad exploration here is wasted spend, not diligence. Clarity is still yours to judge honestly — a contract does not make an ambiguous task clear.\n`
  : ''
phase('Classify')
const cls = CLASSIFY_MOOT ? null : await agent(
  `You are a COMPLEXITY CLASSIFIER. Your ONE job is to read the task text below and return a tier.
Do NOT implement it, write or edit files, run commands, or touch the repo in any way — acting on the
task instead of labeling it is a CONTAINMENT VIOLATION (a classifier that "helpfully" did the task in
the main checkout once broke a real run — re-soak 2026-06-14). Judge from the text alone.

Classify the complexity of this ONE coding task. Reply with a tier:
- "trivial": a localized change of a few lines with obvious scope (a guard, a rename, a typo, a one-function fix).
- "standard": a normal change touching one area or file-set with clear intent.
- "complex": multi-file, ambiguous, architectural, or cross-cutting.

Task: ${TASK}`,
  // agentType:'Explore' is read-only (no Write/Edit/NotebookEdit) — removes the file-creation tools the
  // leak used. Capability removal, not prompt-trust (the prompt above is defense in depth). 0.3: replace
  // with a custom TOOLLESS classifier agent (airtight + cheap; ROADMAP-0.3 §8).
  { model: MODEL_RUNNER, phase: 'Classify', label: 'classify', schema: CLASSIFY_SCHEMA, agentType: 'Explore' }
)
// Override precedence (FEATURE 1a): explicit `model` > `modelTier` > classifier result.
// The overrides are read above; when they make the tier unusable the classifier is
// skipped outright and `classifiedTier` falls back to the neutral default.
const classifiedTier = (cls && TIER_MODEL[cls.tier]) ? cls.tier : 'standard'
const tier = TIER_OVERRIDE || classifiedTier
// PROVENANCE, not just a value. When the classifier is skipped, `classifiedTier`
// falls back to 'standard' so routing still works — but a report that shows only
// `tier: "standard"` claims a classification that never ran. These say where the
// routing tier actually came from, so a skipped run is legible as skipped.
const classificationSkipped = CLASSIFY_MOOT
const tierSource = TIER_OVERRIDE ? 'args.modelTier' : (CLASSIFY_MOOT ? 'neutral_default' : 'classifier')
const thinkModel = MODEL_OVERRIDE || TIER_MODEL[tier]
const modelSource = MODEL_OVERRIDE ? `args.model override ("${MODEL_OVERRIDE}")`
  : (TIER_OVERRIDE ? `args.modelTier override ("${TIER_OVERRIDE}")` : `classifier ("${classifiedTier}")`)
log(CLASSIFY_MOOT
  ? `Tier=${tier}, think model: ${thinkModel} via ${modelSource}. Classifier SKIPPED: the model${EFFORT_PINNED ? ' and review effort are' : ' is'} pinned by the caller, so a tier could not change any decision (runners: ${MODEL_RUNNER}).`
  : `Tier=${tier}, think model: ${thinkModel} via ${modelSource} (classifier said "${classifiedTier}"; runners: ${MODEL_RUNNER}).`)

// ── Phase 1: PLAN (think model) ──────────────────────────────────────────────
// FEATURE 2 — INSTRUMENTED SKIP-PLAN (opt-in, default OFF). Skips the expensive PLAN AGENT to save
// tokens on trivial tasks — but ONLY when the caller also set policy:autonomous. Rationale: the
// ask-gate (needs_human) lives in the plan phase, so skipping plan would skip ambiguity detection;
// under `autonomous` the ask-gate NEVER fires anyway (ASK_ON.autonomous = []), so skipping plan
// there costs ZERO HITL coverage. Under any ASKING policy the plan ALWAYS runs and the ask-gate
// stays intact — a "trivial" but under-specified task can still pause (Codex review 2026-06-09).
// `planSkipped` is instrumented onto the result + logged so savings/quality can be correlated.
const planSkipped = SKIP_PLAN_REQ && POLICY === 'autonomous' && tier === 'trivial'
phase('Plan')
let plan
if (planSkipped) {
  log('Plan SKIPPED (opt-in skipPlan + autonomous + trivial) — instrumented. Implement discovers files itself.')
  plan = {
    plan: TASK,                       // hand the task itself as the plan
    relevant_files: [],               // empty → implement agent discovers files itself
    clarity: 'clear',                 // autonomous never asks → no ambiguity detection is lost here
    question: '',
    interpretations: [],
  }
} else {
  if (SKIP_PLAN_REQ) {
    log(`skipPlan requested but NOT applied (requires policy=autonomous + trivial tier; have policy=${POLICY}, tier=${tier}) — running plan to keep the ask-gate intact.`)
  }
  log('Plan ran.')
  plan = await agent(
    `You are planning ONE Camus task. Do NOT write code in this phase.
${hbLine('Plan')}
Task: ${TASK}
${targetLine}${envFactsBlock}${HUMAN_ANSWER ? `\n\nA human has ALREADY answered the open question for this task — treat it as DECIDED, do not re-raise it:\n${HUMAN_ANSWER}` : ''}

Read only the files needed to understand the change. Produce a short, ordered plan
(what to change, in which files, and why) plus the list of files the change will touch.
${CONTRACT_SCOPED_PLAN}

Then assess CLARITY honestly:
- "clear": exactly one obvious correct implementation.
- "design_decision": a real non-trivial design choice with tradeoffs exists, though a sensible default can be chosen.
- "ambiguous": genuinely under-specified, valid interpretations diverge, the change is irreversible — OR the
  candidate approaches embed a USER-VISIBLE product tradeoff the task text does not decide (e.g. silently
  dropping or altering user-facing data, changing an external behavior/contract). A product call is a human
  call — must not be guessed. (Smoke 2026-06-11: "improve long-conversation handling" read as clear, then
  three review rounds re-litigated tail-truncation data loss that one human line settles.)
If not "clear", put the single blocking question in question (and, when ambiguous, the divergent readings in interpretations).${HUMAN_ANSWER ? ' Since the human already answered, report "clear" unless a genuinely NEW, different question arises.' : ''}
${softBudget}`,
    { model: thinkModel, phase: 'Plan', label: 'plan', schema: PLAN_SCHEMA }
  )
  if (!plan) return { status: 'aborted', stage: 'plan', task: TASK }
  log(`Plan ready — ${plan.relevant_files.length} file(s) in scope; clarity=${plan.clarity}.`)
}

// ── HITL ask-gate: pause BEFORE implementing if the policy says this clarity level warrants a
// human decision (and we don't already hold an answer). Asking before the work is cheaper than
// implementing, getting it wrong, and redoing it. autonomous never asks; the call is logged in
// `decisions` instead and reviewed at merge.
const askLevels = ASK_ON[POLICY] || ASK_ON.ask_on_ambiguity
if (!HUMAN_ANSWER && askLevels.includes(plan.clarity)) {
  log(`Pausing for a human decision: clarity=${plan.clarity}, policy=${POLICY}.`)
  return {
    status: 'needs_human', task: TASK, branch: BRANCH, clarity: plan.clarity,
    question: plan.question || 'The task is under-specified; a human decision is needed before implementing.',
    interpretations: plan.interpretations || [], plan: plan.plan,
    note: `Paused before implementing (policy ${POLICY}): the task needs a human decision. Answer the question and re-run — the answer is threaded back into this task, which then resumes from here.`,
  }
}

// ── Phase 2: IMPLEMENT (Haiku — cheap) in a dedicated worktree ───────────────
// Decision context: if we're proceeding on a non-"clear" task without asking (autonomous, or a
// clarity below the ask threshold), tell the implementer to pick the best reading AND log it; if a
// human already answered, implement per that answer and log it. Either way it lands in `decisions`.
const decisionGuidance = HUMAN_ANSWER
  ? `\nA human has DECIDED the open question — implement per this decision and record it in decisions:\n${HUMAN_ANSWER}\n`
  : (plan.clarity !== 'clear'
    ? `\nThis task has an unresolved point we are NOT pausing for (policy ${POLICY}). Pick the most reasonable interpretation, proceed, and RECORD that choice in decisions (what / why / alternative). Open point: ${plan.question || plan.clarity}\n`
    : '')
phase('Implement')
// A custody-bound standalone caller (Studio) owns one deterministic worktree across stop/resume.
// `ensure` creates it once, then returns that exact coherent worktree on replay. Feat-owned and
// ordinary standalone loops keep the stricter historical `create` behavior; their own state or
// the human resolves collisions explicitly.
const WT_CREATE_MODE = STANDALONE_ID_SALT ? 'ensure' : 'create'
const impl = await agent(
  `Implement ONE Camus task in an ISOLATED git worktree so review/verify can run against it cleanly.
${hbLine('Implement')}
Task: ${TASK}
${decisionGuidance}${envFactsBlock}
Approved plan:
${plan.plan}

Files in scope: ${plan.relevant_files.join(', ') || (planSkipped ? 'discover the files yourself' : '(discover from the plan)')}

Steps:
1. From the repo root, run EXACTLY this one command and NOTHING ELSE (it creates the branch/worktree
   once${STANDALONE_ID_SALT ? ', or returns the same custody-bound worktree on resume,' : ''} and prints ONE JSON object):
     ${REPO_CD}${WT_CMD} ${WT_CREATE_MODE} ${JSON.stringify(BRANCH)} ${WT_DEST} && ${statusWrite(`--phase Implement --branch ${JSON.stringify(BRANCH)} --worktree ${WT_DEST}`).replace(/; $/, '')}
   If the JSON says "ok": false, STOP IMMEDIATELY — do NOT improvise any git commands (no
   \`worktree add\`, no checkout: attaching a previous attempt's branch silently reuses its
   commits and corrupts the run — live smoke 2026-06-12). Return worktree_path "FAILED" with
   the JSON's COMPLETE "error" text as the summary.
2. Use the JSON's "path" value as worktree_path.
3. If the JSON says "reused": true, inspect and preserve the existing diff first: it is partial
   work from this exact custody identity, not disposable residue. Complete the task from there.
4. Make the change ONLY inside that worktree. Stay within the planned files unless the
   plan clearly requires touching an adjacent file.
5. Do NOT run type-check, tests, or codex review — later phases own that.
6. Return worktree_path (absolute), branch ("${BRANCH}"), and a one-paragraph summary.
7. Record any notable DECISIONS in decisions[{what, why, alternative}] — a chosen default for an
   unspecified case, a signature/API change, a tradeoff, an assumption. EMPTY if wholly mechanical.
${softBudget}`,
  { model: thinkModel, phase: 'Implement', label: 'implement', schema: IMPL_SCHEMA }
)
if (!impl) return { status: 'aborted', stage: 'implement', task: TASK, plan }
// SECURITY (audit F3): never trust the agent's returned path verbatim — it flows into
// cd/exec, and a hallucinated or injected value (/, $HOME, an attacker dir) would become a
// path-controlled exec primitive. Require it to end with the canonical worktree name we
// computed; otherwise refuse. Empty also refuses (fail closed): the centralized destination
// depends on $HOME + the repo basename, so the script has no deterministic absolute fallback.
const claimed = (impl && typeof impl.worktree_path === 'string') ? impl.worktree_path : ''
// Declared collision (smoke 2026-06-12): the agent followed the STOP instruction — the branch or
// worktree already exists from a previous attempt. Surface it as exactly that, not a vague abort:
// under a feat the resume lanes (ready_to_merge / proven merge_failed / the noop rescue) land the
// prior work; standalone, the human merges or deletes the branch.
if (claimed.startsWith('FAILED')) {
  // Disambiguate the collision before advising (git audit 2026-06-12, P2): `worktree add -b` is
  // NON-ATOMIC — a failing post-checkout hook or smudge filter can leave the BRANCH behind with
  // ZERO commits of its own. Telling the human "prior work exists, resume lands it" would wedge
  // them forever (the resume lanes land nothing). One deterministic probe tells the two apart.
  const cntRaw = await agent(
    `THIN git runner. Run EXACTLY this one command and output ONLY its stdout (a number, or git's error line verbatim); do NOT cd anywhere else:
  ${HB_TOUCH}${REPO_CD}git rev-list --count HEAD..${JSON.stringify(BRANCH)} --`,
    { model: MODEL_RUNNER, phase: 'Implement', label: 'collision-audit' }
  )
  const cntText = String(cntRaw == null ? '' : cntRaw).trim()
  const cnt = /^\d+$/.test(cntText) ? parseInt(cntText, 10) : null
  const residue = cnt === 0
  return { status: 'infra_error', task: TASK, branch: BRANCH, rounds: 0,
    error: `worktree/branch collision: ${claimed}`,
    collisionAuditOutput: cnt === null ? cntText.slice(0, 1000) : undefined,
    note: cnt === null
      ? `Implement could not create ${BRANCH} / its worktree — and Camus could not verify whether the colliding branch holds prior commits (collision-audit output was not a non-negative integer). Missing collision evidence must not become resume-lane advice. Inspect the branch/worktree, fix the git/audit issue, then re-run. Git's original error: ${(impl && impl.summary) || 'not captured'}`
      : residue
      ? `Implement could not create ${BRANCH} / its worktree — the branch exists but holds NO commits of its own: empty residue of a previously failed worktree add (or a name collision with one of your refs — git's error: ${(impl && impl.summary) || 'not captured'}). Delete it and re-run:\n  git branch -D ${BRANCH}`
      : `Implement could not create ${BRANCH} / its worktree — a previous attempt's work exists there (${cnt} commit(s)) (${(impl && impl.summary) || 'no git error captured'}). Under a feat, re-run with the SAME args: the resume lanes land proven prior work. Standalone: merge or delete the branch, then re-run.` }
}
if (!claimed || !claimed.endsWith(WT_NAME) || !shellSafe(claimed)) {   // shellSafe (verification audit): an agent-returned path with $()/backtick must never reach a shell
  return { status: 'aborted', stage: 'implement', task: TASK, plan,
    note: `Implement agent returned ${claimed ? `an unexpected worktree path (${claimed})` : 'no worktree path'}; expected an absolute path ending in "${WT_NAME}". Refusing to cd/exec into it.` }
}
const WT = claimed
// The terminal report describes the candidate that actually survived review and verification,
// not merely the first implementation attempt. A bounded fix can invalidate both the initial
// summary and its design decisions (WP10: the first candidate duplicated helpers; the reviewed
// candidate moved them into production). Each fix rewrites this complete narrative in the same
// model turn that edits the worktree, so honesty costs no extra agent call.
let candidateSummary = typeof impl.summary === 'string' ? impl.summary : ''
let candidateDecisions = Array.isArray(impl.decisions) ? impl.decisions : []
log(`Implemented in worktree ${WT} (branch ${BRANCH})${tokSuffix()}.`)

// WORKTREE CONTAINMENT GUARD (smoke 2026-06-12): BOTH think-agents leaked draft edits into the
// MAIN repo tree (implement at 07:54, fix at 08:04 — caught two phases later as a confusing
// merge refusal). "Edit only in the worktree" was prompt text, not a guard. Under a feat the
// main tree is guaranteed CLEAN at task start (preflight demands it; merges commit), so ANY
// porcelain output mid-task is a breach — an agent leak, or a human editing mid-run, both
// merge-fatal. Halt LOUDLY at the phase that caused it; never auto-discard (the dirt could be
// the human's). Feat-scoped only: a standalone loop on a deliberately-dirty repo is
// the user's own working style, not a breach. NOTE: a repo whose TESTS dirty the tree will trip
// this — that was always merge-fatal; now it fails early with the files named.
// --ignore-submodules=all (git audit 2026-06-12, P2): a merged submodule-pointer bump leaves a
// PERMANENT ` M sub` in porcelain (merge never updates the submodule workdir) — without the flag
// every later task false-fires this guard and the feat wedges. Documented blind spot: an agent
// editing ONLY a submodule pointer in the main tree goes unseen here; the merge step still
// surfaces it.
// THREE-outcome containment (field soak 2026-06-13, finding 8): containment.sh reads
// `git status --porcelain` MECHANICALLY and emits {ran,dirty,paths}; the runner only echoes it.
// Returns: null (ran && clean) | {kind:'breach', paths} (ran && dirty) | {kind:'inconclusive', why}
// (the answer was NOT obtained — agent failure / budget / non-git / unparseable). The inconclusive
// case is the whole fix: the old code read a non-empty noisy reply as a confirmed breach (cry-wolf
// false-positive) AND an empty reply on agent failure as a clean tree (silent false-negative that
// let a real leak merge). Now neither failure can produce a verdict.
async function containmentLeak(phaseName) {
  const r = await runContainment(`containment:${phaseName}`, 'Review')
  if (!r || r.ran !== true) {
    return { kind: 'inconclusive', why: (r && r.error) || 'containment runner returned no parseable {ran} receipt' }
  }
  // DELTA (re-soak 2026-06-14): only dirt that appeared AFTER the loop-start baseline is a leak — so an
  // untracked file the gate leaked into the main tree fires, while pre-existing / baseline-verify
  // artifacts (already in the baseline) do not false-fire. r.dirty alone would cry wolf on the latter.
  const newDirt = dirtLines(r.paths).filter((l) => !containmentBaseline.has(l))
  if (newDirt.length) return { kind: 'breach', paths: newDirt.join('\n') }
  return null   // no NEW dirt vs the baseline → genuinely clean
}
if (FEAT_SCOPED) {
  const c = await containmentLeak('implement')
  if (c && c.kind === 'breach') {
    return { status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH, rounds: 0, containment: 'implement',
      error: 'worktree containment breach: the implement agent leaked edits into the MAIN repo tree',
      note: `The implement phase modified the MAIN repo tree — it must only touch its worktree. Leaked paths:\n${c.paths}\nIf these are agent strays, diff them against the task worktree (${WT}) and discard; if they are YOUR mid-run edits, commit or stash them. Then re-run the feat with the SAME args. The worktree itself is untouched.` }
  }
  if (c && c.kind === 'inconclusive') {
    return { status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH, rounds: 0, containment: 'implement_inconclusive',
      error: 'containment check could not run',
      note: `Camus could not OBTAIN the main-tree containment status after implement (${c.why}). This is NOT a breach and NOT a clean verdict — just an unverifiable check (a budget-killed or errored runner, or a non-git target). Nothing merged. Re-run the feat with the SAME args to re-check; the worktree (${WT}) is untouched.` }
  }
}

// ── Phase 3: REVIEW ↔ FIX loop (ROUND_CAP rounds) ────────────────────────────
// Reviewer is THIN: it runs the script and echoes raw stdout. No schema, no
// re-judging. The SCRIPT parses the JSON and branches.

// DYNAMIC REVIEW EFFORT (run feedback 2026-06-11): review IS the gate, so reasoning effort
// scales with stakes instead of a blunt constant. Cheap `medium` first pass (most reviews are
// simple → fast); escalate to `high` when the change is hard (complex tier, or a prior round
// did NOT clear), and to `xhigh` when it's CRITICAL (a P0 surfaced). Mirrors the model-escalation
// signals below; deterministic (round + finding-priority, no Date/random). The user can still
// force a constant effort via CAMUS_CODEX_ARGS (it wins inside codex_review.sh).
// A caller may PIN the review effort (Studio forwards its run-start snapshot as
// args.reviewerEffort). When pinned, every round runs at exactly that effort, so
// the effort Studio SHOWS is the effort that RUNS — adaptive escalation must not
// silently raise a run the operator chose to keep low. Unpinned, the adaptive
// medium→high→xhigh schedule stands for direct callers who did not choose.
const _EFFORTS = ['low', 'medium', 'high', 'xhigh']
const PINNED_EFFORT = (args && typeof args === 'object' && typeof args.reviewerEffort === 'string' && _EFFORTS.includes(args.reviewerEffort.trim()))
  ? args.reviewerEffort.trim()
  : ''
if (args && typeof args === 'object' && typeof args.reviewerEffort === 'string' && !PINNED_EFFORT) {
  log(`⚠ Ignoring args.reviewerEffort ${JSON.stringify(args.reviewerEffort)}: not one of ${_EFFORTS.join('|')}. Using the adaptive schedule.`)
}
function pickReviewEffort(rnd, priorBlocking) {
  if (PINNED_EFFORT) return PINNED_EFFORT                                // caller pinned → fixed every round
  if (priorBlocking.some((b) => b && b.priority === 0)) return 'xhigh'   // critical → maximum scrutiny
  if (tier === 'complex' || rnd >= 2) return 'high'                      // hard / persistent → deeper
  return 'medium'                                                         // default → fast
}
let currentEffort = 'medium'   // set per round below; read by reviewerPrompt

// REVIEWER DEADLINE (smoke 2026-06-11): codex_review.sh has NO internal timeout and `codex exec`
// has NO deadline flag, so the Bash tool's `timeout` PARAMETER is the only real bound — and the
// tool's 2-minute default SIGTERM'd a high-effort round mid-review (exit 143), after which the
// agent improvised a GNU `timeout 600` retry that exit-127'd on macOS. Effort-sized deadline,
// instructed on the FIRST call; shell `timeout` wrappers are forbidden in the prompt. 600000 is
// the tool's default ceiling (BASH_MAX_TIMEOUT_MS raises it); reviews that need MORE than that
// are the watchdog-reviewer design's job (docs/HARNESS-DIRECTION.md), not a bigger constant.
const REVIEW_TIMEOUT_MS = { low: 240000, medium: 360000, high: 600000, xhigh: 600000 }

// A human answer IS task contract — plan/implement already treat it as DECIDED. The reviewer
// must judge the diff against the same contract, or a human-overridden finding gets re-flagged
// every round and the loop deadlocks at the round cap on by-design behavior (run feedback
// 2026-06-11: onboarding best-effort guard re-flagged 3 rounds straight after the human decided it).
const REVIEW_TASK_CTX = (HUMAN_ANSWER
  ? `${TASK}\n\n## Human decision (binding — already DECIDED, do not flag behavior that conforms to it)\n${HUMAN_ANSWER}`
  : TASK) + siblingsBlock

function reviewerPrompt(attempt) {
  const backoff = attempt > 1
    ? `This is reviewer attempt ${attempt} after an infra failure. First run \`sleep ${attempt * 5}\` to back off, then proceed.\n`
    : ''
  return `You are a THIN reviewer. Your ONLY job is to run the Camus Codex review on
the worktree and return its stdout. Do NOT interpret, summarize, re-judge, or reformat.

${backoff}Run EXACTLY this one command (the worktree path is the argument — do NOT cd, do NOT add anything else):
  ${HB_TOUCH}${statusPhase('Review', `--round ${round} --effort ${currentEffort} --model ${JSON.stringify(REVIEWER_MODEL)} --backend ${JSON.stringify(REVIEWER_BACKEND)} --worktree ${JSON.stringify(WT)}`)}${REQUEST_SCRIPT} write --worktree ${JSON.stringify(WT)} --round ${round} --effort ${currentEffort} --nonce ${JSON.stringify(GATE_NONCE)} --model ${JSON.stringify(REVIEWER_MODEL)} --backend ${JSON.stringify(REVIEWER_BACKEND)} >/dev/null && CAMUS_GATE_NONCE=${JSON.stringify(GATE_NONCE)} CAMUS_REVIEW_ROUND=${round} CAMUS_REVIEW_EFFORT=${currentEffort} ${REVIEW_CMD} ${JSON.stringify(WT)} ${shq(REVIEW_TASK_CTX)} ${round} ${currentEffort}${POSTURE === 'oneshot' ? ' light' : ''}

The round and effort appear THREE times in that command on purpose: in a request file, in
environment variables, and as arguments. The reviewer refuses if they disagree, so retyping,
shortening, or "cleaning up" the command produces an infrastructure failure and a retry — not a
review. Copy it exactly.

STOP AFTER THAT ONE COMMAND. If its stdout is \`{"pending": true, "handle": "…"}\`, that IS your
answer: return it verbatim and finish. Do NOT look inside the handle directory, do NOT \`cat\`,
\`ls\`, \`head\` or parse any file in it (it is a directory of live artifacts, not JSON), do NOT
poll, sleep or loop waiting for it, do NOT run \`await\`, and do NOT run a second command of any
kind. THIS WORKFLOW owns re-attachment and will call you again with the await command when it is
time. (Live run 20260806-091643-9nbv: a runner improvised a six-minute Python poll that tried to
parse the .watch DIRECTORY as JSON, and other rounds read stale artifacts — every one of those
turned a healthy pending handle into an infra retry.)

Set the Bash tool's timeout PARAMETER to ${REVIEW_TIMEOUT_MS[currentEffort] || 600000} for this
call — the review legitimately runs for minutes and the 2-minute default kills it mid-flight.
Do NOT wrap the command in \`timeout\`/\`gtimeout\` (not portable; absent on macOS) — the tool
parameter is the only deadline.

Output the command's stdout VERBATIM as your entire reply — nothing before or after, no code
fences, no commentary. It is already JSON.`
}

// WATCHDOG plumbing (2026-06-11): codex now runs DETACHED (codex_review.sh start+await) and a
// long review comes back as {pending:true, handle:"<watch dir>"} — the loop re-attaches with
// thin `await` calls until a verdict lands or the budget runs out. The handle travels through
// an agent's stdout, so it is validated against OUR deterministic layout before it is ever
// interpolated into a command (audit F3 discipline: never cd/exec an unvalidated agent path).
// Two-layer handle validation, deliberately split (audit P2 2026-06-11): the LOOP owns the
// injection defense — a strict charset allowlist (no `$`/backticks/quotes/whitespace:
// JSON.stringify does NOT escape `$(…)` inside double quotes, so charset is the only real
// guard), absolute, no `..`, and bound to THIS round's deterministic suffix. LOCATION is the
// SCRIPT's job — codex_review.sh authenticates the handle against its own $CAMUS_REVIEW_DIR +
// meta.json, which the workflow cannot see (no env access here); hard-coding `/.camus/reviews/`
// silently broke re-attach/abort for every custom CAMUS_REVIEW_DIR run.
const okHandle = (h, rnd) => typeof h === 'string' && /^[A-Za-z0-9._\/-]+$/.test(h)
  && h.startsWith('/') && !h.includes('..') && h.endsWith(`-r${rnd}.watch`)
// The await carries the SAME identity as the start (nonce, round, effort). Without it a
// reattach could not prove the watch was its own, so the adoption gate declined and the
// normal fresh path overwrote a completed round (production run 20260806-063400-vzqs).
function awaitPrompt(handle, round, currentEffort) {
  return `You are a THIN reviewer attendant. A Codex review is still RUNNING detached; your ONLY
job is to re-attach and return the script's stdout. Do NOT interpret, summarize, or reformat.

Run EXACTLY this one command:
  ${HB_TOUCH}CAMUS_GATE_NONCE=${JSON.stringify(GATE_NONCE)} CAMUS_REVIEW_ROUND=${round} CAMUS_REVIEW_EFFORT=${currentEffort} ${REVIEW_CMD} await ${JSON.stringify(handle)}

Set the Bash tool's timeout PARAMETER to 600000 for this call. Do NOT wrap the command in
\`timeout\`/\`gtimeout\`.

STOP AFTER THAT ONE COMMAND. If its stdout is another \`{"pending": true, "handle": "…"}\`, return
it verbatim and finish — the review is still running and this workflow will call you again. Do
NOT inspect the handle directory, \`cat\`/parse its files, poll, sleep, loop, or run any second
command.

Output the command's stdout VERBATIM as your entire reply — nothing before or after, no code
fences, no commentary. It is already JSON.`
}
function abortPrompt(handle) {
  return `THIN runner. Run EXACTLY this one command and output its stdout VERBATIM (it is JSON);
no fences, no commentary:
  ${HB_TOUCH}${REVIEW_CMD} abort ${JSON.stringify(handle)}`
}
// Honest codex-side spend, when the watchdog captured turn.completed usage. Log-only.
const usageSuffix = (g) => (g && g.usage && typeof g.usage === 'object')
  ? ` · codex ~${Math.round(((g.usage.input_tokens || 0)) / 1000)}k in/${g.usage.output_tokens || 0} out${g.usage.reasoning_output_tokens ? ` (${g.usage.reasoning_output_tokens} reasoning)` : ''}`
  : ''

let round = 0
let reviewPassed = false
let lastBlocking = []
// OBSERVED, not asserted: set only where a commit actually lands, so a pre-commit terminal can
// report the truth about mutation instead of claiming preservation it never checked.
let committedShaObserved = ''
let infraAbort = null
// TERMINAL REVIEWER PROVENANCE (dogfood 2026-08-07): `model` below is the
// maker/fix model. A direct loop run previously omitted the reviewer receipt,
// which let the outer agent misreport that maker model as the reviewer model.
// Preserve only what the accepted, binding-checked gate actually recorded. In
// particular, null means the Codex wrapper did not record a concrete model; it
// must never be filled from the maker seat or a provider guess.
let reviewerReceipt = null
const reviewerReceiptFields = () => ({
  reviewerBackend: reviewerReceipt ? reviewerReceipt.backend : null,
  reviewerModel: reviewerReceipt ? reviewerReceipt.model : null,
  reviewerEffort: reviewerReceipt ? reviewerReceipt.effort : null,
  reviewerRound: reviewerReceipt ? reviewerReceipt.round : null,
  reviewerModelStatus: reviewerReceipt ? (reviewerReceipt.model ? 'recorded' : 'not_recorded') : 'not_run',
})
const reviewerReceiptNote = () => reviewerReceipt
  ? ` Reviewer receipt: backend ${reviewerReceipt.backend || 'not recorded'}; model ${reviewerReceipt.model || 'not recorded'}; effort ${reviewerReceipt.effort || 'not recorded'}; round ${reviewerReceipt.round}.`
  : ' Reviewer receipt: no completed review.'
// ONESHOT (VELOCITY §1): the single review's blocking findings, preserved VERBATIM for the
// honest report — they were fixed once and never re-reviewed, and the result must say so.
// Per-finding CLAIMED resolutions (smoke 2026-06-12, the spec's audit-P2(b) half we first
// shipped without): the fix agent reports what it did for each finding, so a report reader can
// tell "addressed-unreviewed" from "untouched" — claims, clearly labeled, never verdicts.
const FIX_NARRATIVE_PROPERTIES = {
  summary: {
    type: 'string',
    description: 'One-paragraph summary of the COMPLETE current candidate after this fix, replacing the pre-fix summary.',
  },
  decisions: {
    type: 'array',
    description: 'The COMPLETE set of notable decisions that still apply after this fix. Remove superseded decisions; empty if wholly mechanical.',
    items: {
      type: 'object', additionalProperties: false, required: ['what', 'why'],
      properties: {
        what: { type: 'string' },
        why: { type: 'string' },
        alternative: { type: 'string' },
      },
    },
  },
}
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'decisions'],
  properties: FIX_NARRATIVE_PROPERTIES,
}
const FIX_RESOLUTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'decisions', 'resolutions'],
  properties: {
    ...FIX_NARRATIVE_PROPERTIES,
    resolutions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'resolution'],
        properties: {
          title: { type: 'string', description: 'the finding title, VERBATIM as given' },
          resolution: { type: 'string', description: 'one sentence: what you changed for it (or why no change was needed)' },
        },
      },
    },
  },
}
let oneshotFindings = null
// ONE SHARED RESULT-FIELD HELPER (audit 2026-08-06b). Once an UNREVIEWED bounded fix has run,
// its findings, the maker's claimed resolutions and `resolution: fixed_unreviewed` must survive
// into EVERY terminal outcome — a red verify stays red and an inconclusive stays inconclusive,
// but neither may drop the findings or read as review-clean. Divergent per-branch spreads are
// how one of those branches silently loses them, so every terminal reads this one function.
// Post-fix COPY must match the post-fix facts: after an unreviewed bounded fix there is no
// clean review to point at, so "Review passed" / "Review was clean" / "Committed reviewed work"
// are all false. One prefix, used by every terminal that can follow the fix.
const postFixLead = () => oneshotFindings
  ? `The final review round raised ${oneshotFindings.length} blocking finding(s) and ONE bounded fix ran for them WITHOUT re-review (NOT review-clean).`
  : null
const unreviewedFixFields = () => {
  if (!oneshotFindings) return {}
  const findings = oneshotFindings.map((f) => {
    const m = (oneshotResolutions || []).find((r) => r && r.title === (f && f.title))
    return m ? { ...f, claimedResolution: m.resolution } : f
  })
  return { findings, resolution: 'fixed_unreviewed', reviewedAfterFix: false }
}
// Set when the FINAL round's new findings get the one bounded fix (distinguishes that case
// from the oneshot posture in the sealed note; both share the fixed_unreviewed provenance).
let finalBoundedFix = false
let oneshotResolutions = null
let fixesRan = false
if (POSTURE === 'oneshot') {
  log(`Posture: ONESHOT — one review, one repair, verify decides${ROUND_CAP !== 3 ? ` (roundCap=${ROUND_CAP} is ignored under oneshot)` : ''}. Review scope: light (diff-primary).`)
}

// FEATURE 1b — REVIEWER-PERSISTENCE ESCALATION: when the cheap model keeps failing Codex review,
// bump the FIX agent to the top routed model (TIER_MODEL.complex). Trigger: round >= 2 (the first
// fix didn't clear review) OR any current blocking finding has priority 0. Monotonic. Only lifts
// trivial→opus (standard/complex already start there). If the caller PINNED an exact model via
// args.model we NEVER downgrade it — the pin may outrank opus (e.g. 'fable'). Deterministic
// (round + finding-priority based; no Date/random).
let fixModel = thinkModel
let escalationFired = false
// Fix 2026-06-11 (review_unresolved deadlock): track findings across rounds so a finding re-raised
// AFTER a fix (a stale re-flag or a genuine disagreement) STOPS the loop early for a human decision
// instead of churning to ROUND_CAP. Identity = code_location + title.
// Finding identity for repeat-detection + confidence trend. Deliberately tolerant-but-conservative
// (audit 2026-06-11): use the FILE only (line numbers DRIFT as the diff is edited → a raw
// code_location would reset the trend every round) + a NORMALIZED title (lowercased, punctuation
// and whitespace collapsed) so a re-format or a shifted line still matches. It does NOT fuzzy-merge
// different wordings: a heavy paraphrase mis-MISSES (→ a few more rounds, harmless) rather than
// falsely COLLAPSING two distinct issues (→ a lying trend). The signal is advisory, so a miss only
// costs a hint, never a gate decision.
function findingKey(b) {
  const file = String((b && b.code_location) || '').split(':')[0].trim().toLowerCase()
  const title = String((b && b.title) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  // UN-KEYABLE: no usable identity in EITHER field (audit 2026-06-11 — codex's schema allows empty
  // code_location/title, and two DIFFERENT empty-field findings would collapse to one key and
  // falsely trigger "stuck"). Return null → excluded from repeat-detection AND the confidence trend.
  if (!file && !title) return null
  return `${file || '?'}|${title || '?'}`
}
let priorKeys = new Set()
let stuckFindings = null
// OSCILLATION MEMORY (0.2.5 item 5): every keyable finding EVER seen this loop. `priorKeys` only
// holds the last round, so a finding that appears r1, VANISHES r2, and RETURNS r3 looked brand-new
// — the reviewer flip-flopping read as progress. A returned-after-vanishing finding (or, with it,
// an effective verdict flip on the same location) stops the loop with `oscillating: true`: "the
// reviewer can't make up its mind here" is a human decision, not three more rounds.
let allSeenKeys = new Set()
let oscillating = false
// Confidence TREND (run feedback 2026-06-11): track each finding's confidence_score across rounds.
// A finding whose confidence FALLS round-over-round is the reviewer losing conviction → most likely
// a stale re-flag (lean accept); steady/rising → a consistent disagreement (lean refine). Used ONLY
// to disambiguate the accept-vs-refine guidance on a halt — NEVER a hard auto-pass gate (the audit
// data showed a real P1 that started at 0.82 and rose to 0.92, so an absolute cut would misfire).
const confHistory = {}
function confTrend(series) {
  const xs = (series || []).filter((c) => typeof c === 'number')
  if (xs.length < 2) return { dir: 'flat', series: xs }
  const delta = xs[xs.length - 1] - xs[0]
  return { dir: delta < -0.03 ? 'falling' : (delta > 0.03 ? 'rising' : 'flat'), series: xs }
}

while (round < ROUND_CAP) {
  round++
  // Pick this round's review effort from the PRIOR round's findings + tier (lastBlocking is []
  // on round 1 → medium unless complex). Logged so the escalation is visible in the run.
  currentEffort = pickReviewEffort(round, lastBlocking)

  // 3a/3b: reviewer with bounded infra retries (ran:false ≠ rejection, ≠ clean)
  let gate = null
  for (let attempt = 1; attempt <= INFRA_RETRIES + 1; attempt++) {
    // Label surfaces the REAL reviewer (Codex + this round's effort), not just the thin Haiku
    // runner that shells out to it (run feedback 2026-06-11: the TUI only showed Haiku, hiding
    // that the review is cross-vendor Codex at a dynamic effort).
    let raw = await agent(reviewerPrompt(attempt), {
      model: MODEL_RUNNER, phase: 'Review',
      label: `review:r${round} codex·${currentEffort}${attempt > 1 ? ` retry${attempt}` : ''}`,
    })
    // WATCHDOG RE-ATTACH (2026-06-11): a long review outlives its first chunk and returns
    // {pending, handle} — keep re-attaching while codex is alive and talking. Each await is a
    // small, bounded call (the script kills on event-silence internally), so review depth is no
    // longer capped by any tool timeout. A bad/foreign handle is INFRA, fail closed.
    let pend = extractJsonObject(raw)
    let awaits = 0
    while (pend && pend.pending === true && awaits < AWAIT_CAP) {
      if (!okHandle(pend.handle, round)) { raw = null; pend = null; break }
      awaits++
      log(`Round ${round}/${ROUND_CAP}: review still running (event ${pend.last_event_age != null ? pend.last_event_age + 's' : '?'} ago) — re-attaching (${awaits}/${AWAIT_CAP}).`)
      raw = await agent(awaitPrompt(pend.handle, round, currentEffort), {
        model: MODEL_RUNNER, phase: 'Review',
        label: `review:r${round} codex·${currentEffort} await${awaits}`,
      })
      pend = extractJsonObject(raw)
    }
    if (pend && pend.pending === true) {
      // Alive past the whole watch budget — abort the process (never leave a detached codex
      // running unobserved) and let the infra path handle the round.
      log(`Round ${round}/${ROUND_CAP}: review still running after ${AWAIT_CAP} re-attach chunks — aborting it (watch budget).`)
      raw = okHandle(pend.handle, round)
        ? await agent(abortPrompt(pend.handle), { model: MODEL_RUNNER, phase: 'Review', label: `review-abort:r${round}` })
        : null
    }
    // The expectation is this workflow's own: computed here, inlined into the
    // command, never round-tripped through the runner that executed it.
    gate = asGate(raw, {
      round,
      effort: currentEffort,
      reviewerModel: REVIEWER_MODEL,
      backend: REVIEWER_BACKEND,
      worktreeName: WT_NAME,
      nonce: GATE_NONCE,
    })
    if (gate.ran) break
    log(`Round ${round}/${ROUND_CAP}: reviewer infra failure (${gate.error}) — attempt ${attempt}/${INFRA_RETRIES + 1}.`)
  }

  if (!gate.ran) {
    // Exhausted infra retries. NOT a rejection, NOT clean — stop and surface infra.
    infraAbort = gate.error
    break
  }

  const receiptBinding = gate.binding || {}
  reviewerReceipt = {
    backend: (typeof receiptBinding.backend === 'string' && receiptBinding.backend) ? receiptBinding.backend : null,
    model: (typeof receiptBinding.model === 'string' && receiptBinding.model) ? receiptBinding.model : null,
    effort: (typeof receiptBinding.effort === 'string' && receiptBinding.effort) ? receiptBinding.effort : null,
    round: Number.isInteger(receiptBinding.round) ? receiptBinding.round : null,
  }

  // 3c: clean → done with review
  if (gate.clean === true) {
    reviewPassed = true
    log(`Round ${round}/${ROUND_CAP} (review effort: ${currentEffort}): CLEAN (no priority≤2 findings)${usageSuffix(gate)}${tokSuffix()}.`)
    break
  }

  // 3d: blocking findings → fix in the SAME worktree, then loop
  lastBlocking = Array.isArray(gate.blocking) ? gate.blocking : []
  // Record each (KEYABLE) finding's confidence for the trend signal.
  for (const b of lastBlocking) {
    const k = findingKey(b)
    if (!k) continue
    ;(confHistory[k] = confHistory[k] || []).push(typeof (b && b.confidence_score) === 'number' ? b.confidence_score : null)
  }
  // Stop early if a KEYABLE finding survived a fix (re-raised after being addressed last round) — let
  // a human resolve stale-re-flag vs real disagreement instead of burning the remaining rounds. The
  // confidence trend is attached so the human (and the halt note) can lean accept vs refine.
  const keysNow = lastBlocking.map(findingKey).filter(Boolean)
  const repeatedKeys = keysNow.filter((k) => priorKeys.has(k))
  if (repeatedKeys.length && round >= 2) {
    stuckFindings = lastBlocking.filter((b) => repeatedKeys.includes(findingKey(b)))
      .map((b) => ({ ...b, confidenceTrend: confTrend(confHistory[findingKey(b)]) }))
    const falling = stuckFindings.filter((s) => s.confidenceTrend.dir === 'falling').length
    log(`Round ${round}/${ROUND_CAP}: ${stuckFindings.length} finding(s) survived a fix and were re-raised — stopping early for a human decision${falling ? ` (${falling} with FALLING reviewer confidence → likely stale)` : ''}.`)
    break
  }
  // OSCILLATION (0.2.5 item 5): seen before, NOT last round, back now — appears r1, vanishes r2,
  // returns r3 (needs round ≥ 3 by construction). Disjoint from `repeated` above (that requires
  // presence in the IMMEDIATELY prior round). Same early-stop discipline, different label: a
  // flip-flopping reviewer is an unstable signal the human should distrust, not re-litigate.
  const returnedKeys = keysNow.filter((k) => allSeenKeys.has(k) && !priorKeys.has(k))
  if (returnedKeys.length) {
    oscillating = true
    stuckFindings = lastBlocking.filter((b) => returnedKeys.includes(findingKey(b)))
      .map((b) => ({ ...b, confidenceTrend: confTrend(confHistory[findingKey(b)]) }))
    log(`Round ${round}/${ROUND_CAP}: ${returnedKeys.length} finding(s) RETURNED after vanishing for a round — the reviewer is oscillating; stopping for a human decision.`)
    break
  }
  keysNow.forEach((k) => allSeenKeys.add(k))
  priorKeys = new Set(keysNow)
  // ONESHOT (VELOCITY §1): one fix pass IS the posture's contract — the findings are preserved
  // verbatim and the result reads done_with_findings/fixed_unreviewed, so the unreviewed fix is
  // honest by construction (unlike full posture's final round, where an unconfirmable fix would
  // silently masquerade as handled — the guard below). Escalation still applies: a P0 deserves
  // the best fix model even when nobody re-reviews it.
  if (POSTURE === 'oneshot') {
    oneshotFindings = lastBlocking
    log(`Oneshot: ${lastBlocking.length} blocking finding(s)${usageSuffix(gate)} — ONE fix pass, NO re-review (result will read fixed_unreviewed; deterministic verify still gates).`)
  } else if (round >= ROUND_CAP) {
    // ONE FINAL BOUNDED SOLUTION PASS (north-star contract change, 2026-08-06). The old rule
    // refused to fix anything it could not re-review, so a final round that surfaced a NEW,
    // concrete, actionable finding halted with the defect intact — the live WP8 run ended at
    // 2/2 holding one specific P1 (the coherent test never advanced through cooldown expiry to
    // count the second hit) that nobody attempted. Not attempting a known, fixable defect is
    // not caution; it just hands the work back.
    //
    // Bounded and honest by construction: exactly ONE fix, no extra reviewer round, roundCap
    // untouched, and the result rides the SAME audited provenance as oneshot —
    // done_with_findings / fixed_unreviewed, never independent_clean and never review-clean.
    // Containment, commit/park and deterministic verification all still run afterwards, and a
    // red or inconclusive verify keeps its existing meaning. The stuck and oscillating cases
    // above have already broken out, so the findings reaching here are new by construction —
    // this never re-litigates a dispute, and no human pause precedes it (the human audits after).
    oneshotFindings = lastBlocking
    finalBoundedFix = true
    log(`Round ${round}/${ROUND_CAP}: ${lastBlocking.length} NEW blocking finding(s) on the FINAL round — running ONE bounded fix (no further review round; result will read fixed_unreviewed and deterministic verify still gates).`)
  }
  if (POSTURE !== 'oneshot') log(`Round ${round}/${ROUND_CAP} (review effort: ${currentEffort}): ${lastBlocking.length} blocking finding(s)${usageSuffix(gate)} — dispatching fix.`)
  // Escalate the FIX model if the cheap model is failing: round>=2 (first fix didn't clear review)
  // OR a priority-0 blocking finding is present. Monotonic, deterministic.
  if (!escalationFired && (round >= 2 || lastBlocking.some(b => b && b.priority === 0))) {
    escalationFired = true
    const why = round >= 2 ? `round ${round} (prior fix did not clear review)` : 'a priority-0 blocking finding'
    if (MODEL_OVERRIDE) {
      // Caller pinned an exact model — respect it, NEVER downgrade (it may outrank opus, e.g. 'fable').
      log(`Escalation triggered by ${why}, but model is pinned via args.model ("${MODEL_OVERRIDE}") — keeping it (no downgrade).`)
    } else if (TIER_MODEL.complex !== fixModel) {
      log(`Escalating FIX model ${fixModel} → ${TIER_MODEL.complex} due to ${why}.`)
      fixModel = TIER_MODEL.complex
    } else {
      log(`Escalation triggered by ${why} (already on ${fixModel}).`)
    }
  }
  fixesRan = true
  const fixOut = await agent(
    `Fix the BLOCKING review findings below, in the EXISTING worktree. Do not refactor
beyond what each finding requires. Do not touch P3 nits.
${hbLine('Fix')}
Worktree: ${WT}
  cd ${JSON.stringify(WT)}
${envFactsBlock}${siblingsBlock}
Blocking findings (Codex, priority ≤ 2):
${JSON.stringify(lastBlocking, null, 2)}

Pre-fix candidate summary:
${candidateSummary || '(none recorded)'}
Pre-fix decisions:
${JSON.stringify(candidateDecisions, null, 2)}

Apply the minimal correct fix for each. Do not run review or verify — the loop owns that.
Return a one-paragraph summary of the COMPLETE current candidate after the fix, plus the COMPLETE
decisions[] that still apply. Replace or remove any pre-fix statement/decision this fix made false;
do not merely append a fix note.${oneshotFindings ? `
Then return resolutions[]: for EACH finding (title VERBATIM), one sentence on what you changed
— or why no change was needed. Nobody re-reviews this fix, so your claims
ship next to the findings in the report, clearly labeled as claims.` : ''}
${softBudget}`,
    { model: fixModel, phase: 'Fix', label: `fix:r${round}`, schema: oneshotFindings ? FIX_RESOLUTIONS_SCHEMA : FIX_SCHEMA }
  )
  // Fail closed on narrative replacement: production schema validation requires both fields,
  // while this defensive check keeps legacy/direct runtimes from erasing a truthful prior value
  // if they return an unexpected shape.
  if (fixOut && typeof fixOut.summary === 'string' && fixOut.summary.trim()) {
    candidateSummary = fixOut.summary.trim()
  }
  if (fixOut && Array.isArray(fixOut.decisions)) candidateDecisions = fixOut.decisions
  // ONE repair, no re-review: the oneshot posture's whole contract, and the same shape for the
  // final-round bounded fix. Both record the maker's CLAIMED resolutions beside the findings
  // so a reader can tell addressed-unreviewed from untouched.
  if (oneshotFindings) {
    oneshotResolutions = (fixOut && Array.isArray(fixOut.resolutions)) ? fixOut.resolutions : null
    break
  }
}

// Post-fix containment (smoke 2026-06-12): the fix agent was the SECOND leaker — same guard,
// run once after the loop whenever any fix dispatched. Checked BEFORE the unresolved/commit
// paths on purpose: a leak poisons the NEXT task's merge even when this task halts.
if (FEAT_SCOPED && fixesRan) {
  const c = await containmentLeak('fix')
  if (c && c.kind === 'breach') {
    return { status: 'infra_error', ...unreviewedFixFields(), ...reviewerReceiptFields(), task: TASK, worktree: WT, branch: BRANCH, rounds: round, containment: 'fix',
      error: 'worktree containment breach: the fix agent leaked edits into the MAIN repo tree',
      note: `The fix phase modified the MAIN repo tree — it must only touch its worktree. Leaked paths:\n${c.paths}\nIf these are agent strays, diff them against the task worktree (${WT}) and discard; if they are YOUR mid-run edits, commit or stash them. Then re-run the feat with the SAME args.` }
  }
  if (c && c.kind === 'inconclusive') {
    return { status: 'infra_error', ...unreviewedFixFields(), ...reviewerReceiptFields(), task: TASK, worktree: WT, branch: BRANCH, rounds: round, containment: 'fix_inconclusive',
      error: 'containment check could not run',
      note: `Camus could not OBTAIN the main-tree containment status after the fix phase (${c.why}). This is NOT a breach and NOT a clean verdict — just an unverifiable check. Nothing merged. Re-run the feat with the SAME args to re-check; the worktree (${WT}) is untouched.` }
  }
}

// Deterministic PREP + VERIFY (type-check / lint / tests) on the worktree. Returns a verdict
// {ok:'pass'|'fail'|'inconclusive', stage, failures} the caller maps to a status. Reused by BOTH
// the clean-review path (the final gate) AND the review_unresolved path — so a non-converged review
// is judged against deterministic ground truth before it's ever reported (Fix 2026-06-11).
// `wt` defaults to the implement-phase WT at CALL time (default params evaluate lazily, so the
// land path — where WT is never initialized — can pass its own resolved path without TDZ).
async function prepAndVerify(wt = WT, expectedHead = null) {
  phase('Prep')
  // NO `cd` PREFIX HERE — deliberately, and this is the second half of a two-step history.
  // A fresh runner process is not guaranteed to start inside the target repository, and
  // `_guard.sh` anchors on $PWD when CAMUS_REPO_ROOT is unset, so these two calls once
  // refused a perfectly valid same-repo worktree (`target rejected by camus_guard`, WP7 run
  // 20260805-181917-f4b1). The first fix prefixed both with REPO_CD — and that made things
  // worse: inside a LINKED worktree `git rev-parse --show-toplevel` is the worktree itself,
  // so a run whose targetPath was the WP8 worktree emitted `cd <wp8> && verify.sh <wp9>`,
  // auto mode denied the cross-worktree compound command, and the runner's prose refusal was
  // mistaken for a missing toolchain (run 20260806-145411-hy1w). The command the allow-list
  // and the classifier are meant to see is a PLAIN trusted-script call, so the anchoring moved
  // where it belongs: `camus_anchor` inside the scripts, off the process-level CAMUS_REPO_ROOT.
  // The same-repository / branch / worktree guard is unchanged and still runs after it.
  const prepRaw = await agent(
    `THIN prep runner. Run EXACTLY this one command — verbatim, adding nothing and removing nothing;
the script finds the trusted repository root by itself — and output its stdout VERBATIM as your
entire reply (JSON {prepped, ran, ...}); no fences, no commentary:
  ${HB_TOUCH}${PREP_CMD} ${JSON.stringify(wt)}

If the command cannot be run at all (permission denied, not approved, blocked), do NOT paraphrase or
diagnose: reply with the single line  RUNNER_COULD_NOT_EXECUTE: <the refusal, verbatim>`,
    { model: MODEL_RUNNER, phase: 'Prep', label: 'prep' }
  )
  const prepResult = extractJsonObject(prepRaw)
  if (!prepResult || prepResult.prepped !== true) {
    // PRESERVE THE ACTUAL DIAGNOSIS. prep.sh reports WHY it refused, and a guard
    // refusal is not a dependency problem — flattening every prep failure to
    // `missing_tool` produced "dependency install failed; check the package manager"
    // for a target the guard rejected, sending the operator after a lockfile that was
    // never involved (real WP7 run, 2026-08-05).
    const reason = (prepResult && typeof prepResult.reason === 'string' && prepResult.reason) || null
    // A prep runner that never executed the command is the same class of failure as the verify
    // side, and deserves the same honest kind rather than `missing_tool` (run 20260806-145411-hy1w).
    if (!prepResult) {
      const tail = runnerTail(prepRaw)
      const refused = RUNNER_REFUSAL_RE.test(tail)
      return { ok: 'inconclusive', stage: 'prep',
        failures: [{ stage: 'prep', kind: refused ? 'runner_refused' : 'runner_unparseable',
          log_tail: tail
            ? `${refused ? 'the prep command was NOT executed — the runner was refused or denied' : 'the runner returned something other than prep JSON'}; its reply verbatim (tail): ${tail}`
            : 'the runner returned NOTHING where prep JSON was expected' }] }
    }
    return { ok: 'inconclusive', stage: 'prep',
      failures: [{ stage: 'prep', kind: (reason === 'guard_refused' || reason === 'anchor_refused') ? 'guard_refused' : 'missing_tool',
        reason,
        log_tail: (prepResult && (prepResult.log_tail || prepResult.error)) || 'worktree dependency install failed or unparseable' }] }
  }
  log(prepResult.ran ? `Prep: installed worktree deps (${prepResult.ran.join(' ')}).` : 'Prep: no dep install needed.')
  phase('Verify')
  const verifyRaw = await agent(
    `Run the Camus verification on the worktree and return its stdout JSON verbatim.

Run EXACTLY this one command, verbatim. The worktree path is the argument, and any verifier
override is already on the line. Add NOTHING and remove nothing — the script finds the trusted
repository root by itself, so a \`cd\` of your own would only change what gets measured:
  ${HB_TOUCH}${statusPhase('Verify')}${VERIFY_CMD} ${JSON.stringify(wt)}${VERIFY_ARG}

Output the command's stdout VERBATIM as your entire reply (it is JSON {pass, failures}).
No fences, no commentary.

If the command cannot be run at all (permission denied, not approved, blocked), do NOT paraphrase it
and do NOT diagnose the repository: reply with the single line
  RUNNER_COULD_NOT_EXECUTE: <the refusal, verbatim>
${VERIFY_OATH}`,
    { model: MODEL_RUNNER, phase: 'Verify', label: 'verify' }
  )
  const verify = asVerify(verifyRaw)
  // HEAD BINDING (design review 2026-06-12, run-6 follow-through): the porcelain snapshot can't
  // see edit→COMMIT→rerun — that leaves a clean tree, a green verdict, and a review-bypassing
  // commit on the branch. verify.py names the HEAD it certified; when the caller knows which sha
  // the gate sealed, a GREEN must name exactly that sha. A green with NO head is fail-CLOSED
  // (publish audit P2: accepting an unnamed green re-opens the run-6 hole — a fabricated
  // {pass:true} relay simply omits the field). REDs and inconclusives pass through un-bound:
  // binding gates what may be BELIEVED, not what may be reported.
  if (expectedHead && verify.pass === true) {
    const certified = (typeof verify.head === 'string' && verify.head) ? verify.head : null
    if (!certified) {
      return { ok: 'fail', stage: 'verify', failures: [{ stage: 'integrity', kind: 'head_missing',
        log_tail: `verify reported GREEN without naming the HEAD it certified — the gate sealed ${expectedHead}; an unnamed green proves nothing about it` }] }
    }
    if (certified !== expectedHead) {
      return { ok: 'fail', stage: 'verify', failures: [{ stage: 'integrity', kind: 'head_mismatch',
        log_tail: `verify certified HEAD ${certified} but the gate sealed ${expectedHead} — the branch moved between commit and verify` }] }
    }
  }
  if (verify.inconclusive) return { ok: 'inconclusive', stage: 'verify', failures: verify.failures || [] }
  return { ok: verify.pass === true ? 'pass' : 'fail', stage: 'verify', failures: verify.failures || [] }
}

if (infraAbort) {
  return {
    status: 'infra_error', ...unreviewedFixFields(), ...reviewerReceiptFields(), task: TASK, worktree: WT, branch: BRANCH,
    rounds: round, error: infraAbort,
    // EMPIRICAL, not asserted. A refused receipt must not have moved anything, and this report
    // must not CLAIM preservation it did not check: it states what actually happened this round
    // (whether a fix was dispatched, whether the work was committed) so a reader can tell a
    // genuinely untouched worktree from one a refused verdict already influenced. Live run
    // 20260806-110809-2r9j ended on an infra refusal whose report said the state was preserved
    // while HEAD had in fact moved to a fresh commit.
    roundAdvanced: false,
    fixDispatchedThisRound: fixesRan === true,
    committed: committedShaObserved.length > 0,
    ...(committedShaObserved ? { commit_sha: committedShaObserved } : {}),
    note: 'Codex reviewer never produced a usable verdict. Not a rejection and not clean — needs a human / infra check. Known causes of an EMPTY verdict with exit 0: codex blocking on an open stdin (fixed in codex_review.sh via </dev/null — re-run install.sh if your gate predates it) and a heavy ambient reasoning effort exhausting the output budget on a large diff (pin via CAMUS_CODEX_ARGS="-c model_reasoning_effort=medium"). Inspect ~/.camus/reviews/<wt>-r<round>.json and /tmp/camus_codex_err.log. AFTER fixing, retry by re-invoking the feat FRESH with the SAME args (deterministic featId resumes from state) — do NOT resume the workflow journal (resumeFromRunId): it replays this cached infra_error without re-running the reviewer.'
      + ` OBSERVED THIS ROUND: fix dispatched=${fixesRan === true}; committed=${committedShaObserved.length > 0}${committedShaObserved ? ` (${committedShaObserved})` : ''}. The refused verdict never advanced the round.`,
  }
}

// Oneshot's fixed-once findings are NOT "unresolved review" — they are the posture's contract,
// and the honest status for them is done_with_findings (set at the verify-pass return below),
// never review_unresolved (which is full posture's impasse machinery).
if (!reviewPassed && !oneshotFindings) {
  // The review did not converge (hit ROUND_CAP, or a finding survived a fix). Consult VERIFY before
  // reporting so the human receives both independent axes: deterministic checks and unresolved
  // review. A green test suite is necessary evidence, not proof that an untested contract finding is
  // stale or that the work is shippable. A verify-clean halt remains a DECISION POINT, never a pass.
  //
  // PARK FIRST, verify the park (run-6 integrity follow-through, 2026-06-12): verify now refuses
  // uncommitted state — a green over dirt certifies nothing — so the park (protection since the
  // 0.2.5 trapped-work fix) moves AHEAD of the verify and becomes unconditional: seal the diff as
  // a labeled commit, then let verify certify THAT sha, head-bound. Verify-red work parks too:
  // the branch is camus/*, never auto-merged from this status, and a red park still beats the
  // uncommitted thrash of runs 4–5. The park message no longer claims a verify verdict (it is
  // written before one exists); the NOTE carries the verdict.
  const parkRaw = await agent(
    `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(WT)} ${JSON.stringify('chore(camus): park ' + SLUG + ' (review-flagged)')}`,
    { model: MODEL_RUNNER, phase: 'Verify', label: 'park' }
  )
  const park = extractJsonObject(parkRaw) || { committed: false, reason: 'unparseable' }
  // Bind the park's verify to a real sha (relay audit; centralized 2026-07-06 per Mateo). A fresh seal binds
  // to its commit; an EMPTY stage means a prior commit already holds the work, so bind to THAT HEAD (commit.sh
  // emits it) — NEVER verify unbound (the earlier fix ignored the empty-stage sha, so a headless green read as
  // verifyClean:true). A committed:true without a valid sha, or a real commit failure, is a park FAILURE.
  const prc = commitReceipt(park)
  const parkedSha = prc.kind === 'sealed' ? prc.head : null           // a fresh seal we can name as "parked as <sha>"
  const parkBindHead = (prc.kind === 'sealed' || prc.kind === 'priorHead') ? prc.head : null   // what verify binds to
  const parkFailed = !parkBindHead                                     // no certifiable head (noSha / failed / unborn-empty)
  log(parkedSha
    ? `Parked the review-flagged attempt as ${parkedSha} — sealed before the ground-truth verify.`
    : (parkFailed ? `Park attempt FAILED (${prc.reason || 'no valid sha to bind the verify to'}) — the diff is not certifiably sealed; verify cannot bind to it.`
      : `Park: stage was empty — the work is already committed at ${parkBindHead}; verify will certify that HEAD.`))
  const why = oscillating
    ? 'a finding RETURNED after vanishing for a round — the reviewer is oscillating (an unstable signal, not a stable disagreement)'
    : (stuckFindings
      ? 'a finding was re-raised after a fix — stopped early rather than burning the rest of the rounds'
      : `reached ROUND_CAP=${ROUND_CAP} with blocking findings still present`)
  // Confidence-trend hint disambiguates accept-vs-refine (only as guidance, never a gate).
  const falling = (stuckFindings || []).filter((s) => s.confidenceTrend && s.confidenceTrend.dir === 'falling')
  const confHint = stuckFindings
    ? (falling.length
      ? ` The re-raised finding(s) LOST reviewer confidence across rounds (${falling.map((s) => s.confidenceTrend.series.join('→')).join('; ')}) — the reviewer is losing conviction, most likely a STALE RE-FLAG: lean ACCEPT.`
      : ` The re-raised finding(s) HELD reviewer confidence across rounds — a consistent disagreement, not erosion: lean REFINE.`)
    : ''
  const base = {
    status: 'review_unresolved', task: TASK, worktree: WT, branch: BRANCH, rounds: round,
    blocking: lastBlocking, stuck: stuckFindings || null,
    ...(oscillating ? { oscillating: true } : {}),
    ...reviewerReceiptFields(),
    tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
  }
  if (parkFailed) {
    // No seal → no certifiable state: verify would (rightly) refuse the uncommitted tree, and a
    // refusal must not masquerade as code-red. Halt with the blocker named instead.
    return { ...base, verifyClean: null,
      note: `Review did not converge (${why}). Parking the work FAILED (${park.reason || 'unknown'}) — the diff is UNCOMMITTED in the worktree, and verify will not certify uncommitted state (integrity invariant), so there is no ground-truth verdict. Treat the worktree gently; fix the commit blocker and re-run, or accept/refine manually. Finding(s) below.${confHint}` }
  }
  // Head-bound to the park when THIS run sealed it; an empty stage means a prior run's commit
  // already holds the work (no in-run expectation — the internal invariants still apply).
  const v = await prepAndVerify(WT, parkBindHead)
  if (v.ok === 'pass') {
    const parkLine = parkedSha
      ? ` The work is PARKED as commit ${parkedSha} on ${BRANCH} (review-flagged, verify-green) — it survives even if the worktree is lost.`
      : ` The work was already committed on ${BRANCH} — nothing to park.`
    return { ...base, verifyClean: true, ...(parkedSha ? { parkedSha } : {}),
      note: `Review did not converge (${why}) — deterministic verify (type-check / lint / tests) PASSES on this worktree, but those checks do not clear the unresolved finding or prove untested contract behavior.${parkLine} DECIDE: refine the finding, or explicitly accept the reviewed risk and land the parked commit.${confHint}` }
  }
  if (v.ok === 'inconclusive') {
    return { ...base, verifyClean: null, failures: v.failures, ...(parkedSha ? { parkedSha } : {}),
      note: `Review did not converge (${why}); deterministic verify could NOT run (env not ready — ${v.stage}). Fix the environment to get the ground-truth verdict, then decide accept vs refine.${parkedSha ? ` The attempt is parked as ${parkedSha} on ${BRANCH}.` : ''} Finding(s) below.${confHint}` }
  }
  return { ...base, verifyClean: false, failures: v.failures, ...(parkedSha ? { parkedSha } : {}),
    note: `Review did not converge (${why}) AND deterministic verify did NOT pass — the code is genuinely not done.${parkedSha ? ` The attempt is parked as ${parkedSha} on ${BRANCH} (review-flagged, verify-red).` : ''} Finding(s) + verify failures below.` }
}

// ── Phase 3.4: COMMIT GATE — the reviewed change MUST land on the branch, or the merge ships
// nothing (run-2 bug: implement changed files but never committed → empty merge → false done).
// Review/fix run on the UNCOMMITTED tree so Codex sees the diff; only NOW, after review is clean,
// do we commit. No staged changes → no_changes (never a false done). `done` requires a commit_sha.
phase('Commit')
const commitRaw = await agent(
  `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(WT)} ${JSON.stringify('chore(camus): ' + SLUG)}`,
  { model: MODEL_RUNNER, phase: 'Commit', label: 'commit' }
)
const commitResult = extractJsonObject(commitRaw) || { committed: false, reason: 'unparseable' }
const crc = commitReceipt(commitResult)
// An empty stage PROVEN by a real HEAD sha (priorHead) is AMBIGUOUS, not automatically a benign
// no_changes (Studio live smoke 2026-07-13): the implement agent may have COMMITTED the reviewed
// work itself, so the stage is empty precisely BECAUSE the branch tip already holds the change —
// recording that as a no-op launders real committed work into "nothing happened". Disambiguate with
// git, not vibes (camus-feat's noop rescue, applied to the standalone lane): commits on BRANCH that
// are NOT in the main tree's history mean the work IS committed → bind verify to that tip and take
// the normal terminal path with the full identity fields. Zero unmerged commits is a genuine no-op.
// An unreadable count must never become a no-op — missing ancestry evidence fails closed as infra.
// An empty stage with NO valid sha (kind 'empty') is NOT a trusted no-op either — commit.sh emits a
// sha even on empty, so a sha-less empty is a relay claiming "nothing to do" without evidence (could
// silently drop real work); it falls through to the infra branch below (Mateo's re-audit 2026-07-06).
let rescuedPriorCommit = false
if (crc.kind === 'priorHead') {
  const unmergedRaw = await agent(
    `THIN git runner. Run EXACTLY this one command and output ONLY its stdout (a number, or an error line):
  ${HB_TOUCH}${REPO_CD}git rev-list --count HEAD..${JSON.stringify(BRANCH)} --`,
    { model: MODEL_RUNNER, phase: 'Commit', label: 'noop-audit' }
  )
  const unmergedText = String(unmergedRaw == null ? '' : unmergedRaw).trim()
  const unmerged = /^\d+$/.test(unmergedText) ? parseInt(unmergedText, 10) : null
  if (unmerged === null) {
    return {
      status: 'infra_error', ...unreviewedFixFields(), ...reviewerReceiptFields(), task: TASK, worktree: WT, branch: BRANCH, rounds: round, stage: 'noop_audit',
      noopAuditOutput: unmergedText.slice(0, 1000),
      error: `empty stage at HEAD ${crc.head}, and the branch ancestry audit returned no usable count — cannot tell a benign no-op from already-committed work`,
      note: `The commit gate found an empty stage, but Camus could not verify whether ${BRANCH} holds unmerged commits (noop-audit output was not a non-negative integer). Missing ancestry evidence must not become a no-op. Fix the git/audit issue and re-run with the SAME args.`,
    }
  }
  if (unmerged === 0) {
    return {
      status: 'no_changes', task: TASK, worktree: WT, branch: BRANCH, rounds: round, ...unreviewedFixFields(), ...reviewerReceiptFields(),
      tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
      note: `${postFixLead() || 'Review passed'} The implement step produced no committable change (empty diff; the branch ancestry audit confirms zero unmerged commits). no_changes, never a false done — nothing to merge${oneshotFindings ? ', and the unreviewed findings below still stand' : ''}.`,
    }
  }
  rescuedPriorCommit = true
  log(`Empty stage BUT ${BRANCH} holds ${unmerged} unmerged commit(s) — the ${oneshotFindings ? 'work (including the unreviewed fix)' : 'reviewed work'} was already committed (at implement time). Proceeding as committed at ${crc.head}; verify binds to that tip.`)
}
// A committed:true MUST name a real git sha (commit.sh always emits one) — else the receipt is garbled/
// hallucinated and expectedHead would be null, silently disabling head-binding on the terminal success path
// (the run-6 cover-up hole). A failed commit is likewise infra. Fail CLOSED: a done must name the sha its
// verify certifies. (Same infra-vs-findings discipline as the verifier.) A rescued prior commit already
// carries its proven HEAD (crc.head IS the branch tip the ancestry audit certified), so it passes through.
if (!rescuedPriorCommit && crc.kind !== 'sealed') {
  return {
    status: 'infra_error', ...unreviewedFixFields(), ...reviewerReceiptFields(), task: TASK, worktree: WT, branch: BRANCH, rounds: round,
    error: crc.kind === 'noSha'
      ? `commit gate reported committed:true but named no valid sha (got: ${JSON.stringify(commitResult.sha)})`
      : crc.kind === 'empty'
        ? 'commit gate claimed an empty stage but named no valid HEAD sha — a relay reporting "nothing to do" without script evidence, not a trustworthy no-op'
        : `commit gate failed: ${crc.reason || 'unknown'}`,
    note: 'The commit step did not produce a certifiable seal (bad worktree, git error/identity, failing hook, unparseable output, a committed:true receipt with no valid git sha, or an empty stage that named no valid HEAD) — NOT a trustworthy no-op. A done must name the sha its verify certifies (head-binding); halted as infra, never a false done or a false noop. Re-run.',
  }
}
const COMMIT_SHA = crc.head
committedShaObserved = typeof COMMIT_SHA === 'string' ? COMMIT_SHA : ''
if (!rescuedPriorCommit) log(`Committed ${oneshotFindings ? 'UNREVIEWED-FIX' : 'reviewed'} work (${COMMIT_SHA}) to ${BRANCH}${tokSuffix()}.`)

// ── Phase 3.5 + 4: PREP + VERIFY (deterministic ground truth — final, non-negotiable gate) ─
// Runs after review passes + commit (review/fix don't need deps). A clean review does NOT override
// a failing verify; an env that can't run is verify_inconclusive (NOT code-red — the run-1 false
// negative was `turbo` missing in a fresh worktree). Head-bound to the sha the commit gate just
// sealed: the green must certify exactly that commit.
const verdict = await prepAndVerify(WT, COMMIT_SHA)
if (verdict.ok === 'inconclusive') {
  return {
    status: 'verify_inconclusive', task: TASK, worktree: WT, branch: BRANCH, rounds: round, ...unreviewedFixFields(), ...reviewerReceiptFields(),
    // The candidate SHA travels with an INCONCLUSIVE verdict too. Without it a
    // recovery re-verify has no commit to bind its green to, and the receipt
    // keeps reading infra_failed however the retry goes (field report 2026-08-05).
    commit_sha: COMMIT_SHA, parkedSha: COMMIT_SHA,
    failures: verdict.failures, tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
    // The note follows the REPORTED kind, never a guess about it. A guard refusal and a
    // failed dependency install need completely different human actions.
    note: (() => {
      const fs = verdict.failures || []
      const of = (...kinds) => fs.find((f) => kinds.includes(f?.kind))
      const guard = of('guard_refused')
      if (guard) return `Refused before anything ran: the target guard rejected the worktree, so NO dependency install and NO verification were attempted — this is not a code failure and not a dependency problem. The guard requires the target to be a camus-wt-* worktree of the SAME repository as the trusted working directory, with a name coherent with its camus/* branch. Verbatim: ${guard.log_tail || 'no detail reported'}`
      // The runner never ran the command. Naming the environment here would be a fabrication:
      // nothing in the worktree has been measured (run 20260806-145411-hy1w).
      const runner = of('runner_refused', 'runner_unparseable')
      // "Exactly as the gate would" has to be TRUE. A run carrying args.verifyCmd verifies through
      // that command, so handing over a bare verify.sh would auto-detect a different verifier and
      // silently answer a different question. The override rides along, in the same env-prefix form
      // the gate itself emits.
      if (runner) return `The verification command was never carried out, so NOTHING about this worktree's toolchain, dependencies or code has been measured — do not read this as an environment problem. ${runner.kind === 'runner_refused' ? 'The runner reports it was refused or denied permission to execute the command' : 'The runner replied with something other than the verifier\'s JSON'}. Re-run it yourself to get a real verdict, exactly as the gate would: bash "$HOME/.claude/skills/camus/scripts/verify.sh" ${JSON.stringify(WT)}${VERIFY_ARG}. Runner reply, verbatim: ${runner.log_tail || 'none captured'}`
      return verdict.stage === 'prep'
        ? 'Could not prepare the worktree to run (dependency install failed) — env not ready, NOT a code failure. Check the package manager / lockfile and re-run.'
        : 'Verification RAN but could not reach a verdict (toolchain/deps missing in the worktree, or no verifier detected) — NOT a code failure. Fix the environment (install deps / correct node; see env_check) and re-run.'
    })(),
  }
}
if (verdict.ok === 'pass') {
  if (oneshotFindings) {
    // HONEST-REPORT SEMANTICS (VELOCITY §1 audit P2): `done` is reserved for review-clean. The
    // work is merged-ready and deterministically GREEN, but the single review's findings got ONE
    // unreviewed fix pass — the human reads them, severity-sorted and verbatim, before shipping.
    // Findings ride verbatim + each carries the fix agent's CLAIMED resolution when one matched
    // by title (smoke 2026-06-12: without these, a reader can't tell addressed-unreviewed from
    // untouched — the field is named claimedResolution because nobody verified it).
    const findingsOut = unreviewedFixFields().findings
    const hasUnreviewedP0P1 = findingsOut.some((f) => Number.isInteger(f && f.priority) && f.priority <= 1)
    // FULL posture must not auto-upgrade a final unreviewed P0/P1 repair into a
    // mergeable result. The bounded fix was still worthwhile, and deterministic
    // verify still certifies its commit, but only another independent review (or
    // an explicit human accept) can clear that trust debt. Oneshot remains the
    // deliberately cheaper contract; P2-only debt in full remains mergeable.
    if (POSTURE === 'full' && finalBoundedFix && hasUnreviewedP0P1) {
      return {
        status: 'review_unresolved', task: TASK, worktree: WT, branch: BRANCH,
        commit_sha: COMMIT_SHA, parkedSha: COMMIT_SHA, verifyClean: true,
        blocking: findingsOut, ...unreviewedFixFields(), ...reviewerReceiptFields(),
        rounds: round, summary: candidateSummary, decisions: candidateDecisions,
        tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel,
        finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
        note: `FINAL-ROUND BOUNDED FIX: review round ${round}/${ROUND_CAP} raised ${findingsOut.length} NEW blocking finding(s), including unresolved P0/P1 risk. ONE bounded fix ran and deterministic verify PASSES on committed candidate ${COMMIT_SHA}, but the repair is UNREVIEWED: NOT review-clean and NOT independent_clean. Read the findings and maker's claimed resolutions below. Full posture therefore PARKS and HALTS; it does not return a mergeable result. Re-review the parked commit, or explicitly accept the reviewed risk.${reviewerReceiptNote()}`,
      }
    }
    return {
      status: 'done_with_findings', task: TASK, worktree: WT, branch: BRANCH, commit_sha: COMMIT_SHA, ...unreviewedFixFields(), ...reviewerReceiptFields(),
      rounds: round, summary: candidateSummary, decisions: candidateDecisions,
      findings: findingsOut, findingsDeferred: findingsOut.length, resolution: 'fixed_unreviewed',
      tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
      note: finalBoundedFix
        ? `FINAL-ROUND BOUNDED FIX: review round ${round}/${ROUND_CAP} raised ${oneshotFindings.length} NEW blocking finding(s) (not a repeat and not oscillating), and ONE bounded fix pass ran for them with NO further review round. Deterministic verify PASSES on the committed candidate and the work is parked. The fix is UNREVIEWED — this is done_with_findings / fixed_unreviewed, NOT review-clean and NOT independent_clean. Read the findings and the maker's claimed resolutions (verbatim in this result), then audit the parked candidate.${reviewerReceiptNote()}`
        : `Oneshot posture: the single review found ${oneshotFindings.length} blocking finding(s); ONE fix pass ran and was NOT re-reviewed (the posture's contract). Deterministic verify PASSES and the change is committed. NOT review-clean — read the findings (verbatim in this result) before shipping.${reviewerReceiptNote()}`,
    }
  }
  return {
    status: 'done', task: TASK, worktree: WT, branch: BRANCH, commit_sha: COMMIT_SHA,
    rounds: round, summary: candidateSummary, decisions: candidateDecisions,
    ...reviewerReceiptFields(),
    tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
    note: `Review clean, change committed, and verify passed. Worktree left in place for human merge/inspection (a camus-feat caller removes it after merging the branch).${reviewerReceiptNote()}`,
  }
}
return {
  status: 'verify_failed', task: TASK, worktree: WT, branch: BRANCH, ...unreviewedFixFields(), ...reviewerReceiptFields(),
  rounds: round, failures: verdict.failures, tier, tierSource, classificationSkipped, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
  note: `${postFixLead() || 'Review was clean'} Deterministic verify ran and did NOT pass. Code is NOT done${oneshotFindings ? '; the findings and the maker\'s claimed resolutions are recorded below, unreviewed' : ''}.`,
}
