export const meta = {
  name: 'camus-feat',
  description: 'Run an ordered task list as ONE feature through the Camus M1 gate: preflight → feat branch → env+baseline → per-task v2-lite loop (merge on done) → env re-check + integration verify → report. Linear only (no DAG/parallel/bisection).',
  whenToUse: 'Drive a small ordered feat (2–3 tasks in M1) through v2-overnight M1. args = { feat: "<title>", tasks: ["task 1", "task 2", ...], targetPath?, policy?, answers?, posture? }. policy ∈ autonomous|ask_on_ambiguity(default)|ask_on_major controls when a task PAUSES for a human (status needs_human); on a resume after a pause, answers={ "<taskId>": "..." } threads the decision back in. posture ∈ full(default)|oneshot — review cadence (VELOCITY §1): absent, a classifier recommends and asking policies confirm a speed posture ONCE; oneshot tasks report done_with_findings, never review-clean. Reuses camus-loop per task with feat-scoped branch identity. Launch FROM the target repo (cwd = repo root). Run `npx camus-cli check` (or `bash install.sh --check` from the package) yourself first — gate-freshness is a human step.',
  phases: [
    { title: 'Preflight',    detail: 'Agent confirms the base working tree is CLEAN and reads any prior feat state (resume). Dirty → stop.' },
    { title: 'Feat branch',  detail: 'Agent cuts (or, on resume, checks out) camus/feat-<featId> from the current base branch.' },
    { title: 'Env+Baseline', detail: 'Agent runs env_check.py then verify.sh on the feat branch; stop on env_not_ready / base_red before any task.' },
    { title: 'Tasks',        detail: 'For each task in order: run the camus-loop gate with feat-scoped branch identity; on done → merge into the feat branch; first non-done HALTS the feat.' },
    { title: 'Integration',  detail: 'Agent re-runs env_check.py (tasks may add deps) then verify.sh on the merged feat branch.' },
    { title: 'Report',       detail: 'Agent writes the structured feat report out-of-tree; feat branch left for the human to merge.' },
  ],
}

// ── Constants ────────────────────────────────────────────────────────────────
// The skill lives in ~/.claude/skills (installed), invoked by absolute path. cwd is the
// target repo root for every agent (same assumption camus-loop makes for its worktrees).
const SKILL = '"$HOME/.claude/skills/camus/scripts"'
const ENV_CMD = `python3 ${SKILL}/env_check.py`     // [REPO] -> exit 0 ready, 1 prints what to fix
const VERIFY_CMD = `bash ${SKILL}/verify.sh`         // [DIR]  -> {pass,failures,checks} JSON
const MODEL_RUNNER = 'haiku'                         // thin shell runners — no judgment to apply

// ── Args: { feat, tasks: [...ordered], targetPath? } ─────────────────────────
// Tolerate a JSON-encoded string (some callers stringify args); parse it back to an object.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (_) { /* leave as string -> fails below */ } }
if (!A || typeof A !== 'object' || Array.isArray(A)) {
  throw new Error('camus-feat: args must be an object { feat, tasks: [...] } (got: ' + typeof args + ')')
}
const FEAT = String(A.feat || '').trim()
const TASKS = Array.isArray(A.tasks) ? A.tasks.map((t) => String(t).trim()).filter(Boolean) : []
const TARGET = (A.targetPath && String(A.targetPath)) || ''
// HITL: policy is threaded to every per-task loop (default ask_on_ambiguity). `answers` is an
// optional map { taskId: "human answer" } supplied on a RESUME after a needs_human pause — the
// matching task re-runs with that answer threaded back in. Neither enters featId (stable resume).
const POLICY = (A.policy && String(A.policy)) || 'ask_on_ambiguity'
const ANSWERS = (A.answers && typeof A.answers === 'object' && !Array.isArray(A.answers)) ? A.answers : {}
// Model overrides forwarded UNCHANGED to every per-task loop. `model` / `modelTier` are a SHARED
// CONTRACT with camus-loop — pass only when the caller set them (so the loop keeps its own
// defaults otherwise). Neither enters featId (they don't change the work's identity → stable resume).
const MODEL = (A.model != null && String(A.model)) || ''
const MODEL_TIER = (A.modelTier != null && String(A.modelTier)) || ''
const SKIP_PLAN = A.skipPlan === true   // opt-in; forwarded only when set (loop gates it to autonomous)
// Per-task review↔fix cap, forwarded UNCHANGED to every loop (the loop bounds it 1..10). Lets a
// caller give a known-large feat more rounds to converge. Omit → the loop's default (3).
const ROUND_CAP = Number.isInteger(A.roundCap) ? A.roundCap : null
// TOKEN BUDGET CEILING (0.2.5 item 4): a per-feat output-token cap, checked at every task
// BOUNDARY against the PERSISTED per-task totals (node.tokens survives resumes — the rollup is
// cross-run, not this turn's pool). Past the cap the feat halts needs_human ("spent ~N of M —
// raise budgetTokens or drop it to continue") instead of silently spending on. Honest-cost
// framing applies: tokens are an estimate-adjacent counter, never an invoice. Invalid → ignored.
const BUDGET_TOKENS = (typeof A.budgetTokens === 'number' && isFinite(A.budgetTokens) && A.budgetTokens > 0)
  ? Math.floor(A.budgetTokens) : null
// LAND list (run-5 fix 2026-06-11): taskIds whose worktree is ALREADY proven (review passed, or a
// human ACCEPTED a verify-clean needs_decision halt). Those tasks run the loop in land mode —
// commit → verify → merge, no re-plan/re-implement/re-review. The accept half of accept-vs-refine.
const LAND_TASKS = Array.isArray(A.land) ? A.land.map(String) : []
// REVIEW POSTURE (VELOCITY §1+§3, 0.2.6): explicit wins, no ask (rule 1) — absent, the classifier
// recommends and the policy decides whether to confirm (resolved after preflight, below).
// bookend/forward are 0.3 (feat-level final-review machinery) — rejected loudly, never downgraded.
const ARG_POSTURE = (() => {
  if (A.posture == null) return null
  const v = String(A.posture)
  if (v === 'full' || v === 'oneshot') return v
  throw new Error(`camus-feat: posture "${v}" is not available (full|oneshot today; bookend/forward land in 0.3 — docs/VELOCITY-DIRECTION.md §1)`)
})()
if (!FEAT) throw new Error('camus-feat: missing feat title (args.feat)')
if (!TASKS.length) throw new Error('camus-feat: args.tasks[] is empty')
// All feat-level git/env/verify run in the repo root (workflow cwd = $PWD).
// `targetPath` is a CODE-SCOPE HINT only: it is forwarded to camus-loop per task,
// but must never become the feat runner's cd/verify target. Baseline/integration
// guards require the repo root on a camus/feat-* branch; passing a relative subdir
// would both double-resolve the path after `cd` and fail the guard.
const REPO_ARG = '"$PWD"'

// Token telemetry, degradable: `budget` ships with workflows GA (Claude Code >= 2.1.154,
// doc-checked 2026-06-10). On an older runtime spentTok() is null and every token field/log
// fragment is simply omitted — the gate never crashes over telemetry.
const spentTok = () => {
  try { return (typeof budget === 'object' && budget && typeof budget.spent === 'function') ? budget.spent() : null }
  catch (_) { return null }
}

// ── Deterministic identity (FNV-1a; NO Math.random / Date — would break resume) ──
// These MUST mirror camus-loop's slugify/fnv1a exactly so the branch we compute
// here equals the branch the loop creates (idSalt = featId).
// Default truncation 24 for clean, readable branch names. taskIdentity() overrides to 40 to
// stay byte-identical with camus-loop's own slugify (it truncates at 40), so the task
// branch we precompute equals the branch the loop actually creates and merges target.
function slugify(s, max = 24) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'task'
}
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}
// featId = readable slug + a stable FNV-1a hash over the feat title + ordered task list
// (order-sensitive on purpose). The slug makes the feat branch human-scannable; the hash keeps
// it collision-resistant and resumable (re-running the same feat yields the same featId).
const featSlug = slugify(FEAT)
const featHash = fnv1a(FEAT + '\n---\n' + TASKS.join('\n')).slice(0, 6)
const featId = `${featSlug}-${featHash}`
const featBranch = `camus/feat-${featId}`
// Task branches live in a SIBLING namespace `camus/feat/<id>/...` (slash after `feat`), NOT
// `camus/feat-<id>/...`. Git stores `camus/feat-<id>` as a ref FILE, so a child ref `camus/feat-<id>/x`
// would need a directory of the same name — an illegal file-vs-directory ref collision that
// clobbers the feat branch. `camus/feat/<id>/` is a distinct dir entry under `camus/`, so the feat
// branch (file `camus/feat-<id>`) and task branches (dir `camus/feat/<id>/`) coexist cleanly.
const branchPrefix = `camus/feat/${featId}/`   // handed to camus-loop per task → camus/feat/<id>/<slug>-<id>

// FEAT-LEVEL HEARTBEAT (audit P2 2026-06-11): the loop touches ~/.camus/feats/<featId>.hb per
// task phase, but the feat's OWN long stretches — preflight, env doctors, baseline verify,
// merge, integration verify — ran dark, so status/watch could show a stale heartbeat while the
// runner was busy verifying. Same contract as the loop's HB_TOUCH; the mkdir keeps the FIRST
// touch (preflight, before any persist has created ~/.camus/feats) from failing silently.
// Wall-clock lives in the file's mtime, never in this script (Date is banned — resume determinism).
const HB_TOUCH = `(mkdir -p "$HOME/.camus/feats" && touch "$HOME/.camus/feats/${featId}.hb") 2>/dev/null; `

// Per-task identity, computed exactly as the loop will (ID_SALT=featId): taskId = <slug>-<id>.
// slug truncation MUST be 40 here to match camus-loop's slugify, so this precomputed
// branch is byte-identical to the one the loop creates (the id hash is truncation-independent).
function taskIdentity(task) {
  const id = fnv1a(featId + '::' + task).slice(0, 6)
  const taskId = `${slugify(task, 40)}-${id}`
  return { taskId, branch: `${branchPrefix}${taskId}` }
}

// ── Persistent state + report paths (OUTSIDE any worktree, per-user) ─────────
// Deliberately OUTSIDE ~/.claude: that dir is protected/config-adjacent, so auto mode prompts
// on writes there. ~/.camus is a plain user dir the classifier treats as ordinary local
// state (Codex review note 2026-06-09). The frozen gate (skill/workflow) still lives in ~/.claude;
// only mutable RUN state moved out.
const STATE_PATH = `~/.camus/feats/${featId}.json`
const REPORT_PATH = `~/.camus/reports/${featId}.json`

// LINEAR DAG: every node carries dependsOn:[] (always empty in M1; lets M2 add edges
// without migrating state). Strictly sequential execution regardless.
const taskNodes = TASKS.map((spec) => {
  const { taskId, branch } = taskIdentity(spec)
  return { taskId, spec, dependsOn: [], status: 'pending', branch, loopStatus: null }
})
// CANONICAL RESUME ARGS (Codex P1): an auto-resumer must reproduce the EXACT original invocation,
// not just feat+tasks — dropping targetPath/policy/model/modelTier/skipPlan/answers would silently
// change the run's behavior (e.g. ask_on_major → ask_on_ambiguity, lost overrides, lost human
// answers). Persist the full arg set verbatim; resume_scan.py emits this object unchanged. The
// argsVersion lets a resumer reject states written by an older format.
const resumeArgs = {
  argsVersion: 1,
  feat: FEAT,
  tasks: TASKS,
  policy: POLICY,
  ...(TARGET ? { targetPath: TARGET } : {}),
  ...(MODEL ? { model: MODEL } : {}),
  ...(MODEL_TIER ? { modelTier: MODEL_TIER } : {}),
  ...(SKIP_PLAN ? { skipPlan: true } : {}),
  ...(ROUND_CAP != null ? { roundCap: ROUND_CAP } : {}),
  ...(BUDGET_TOKENS != null ? { budgetTokens: BUDGET_TOKENS } : {}),
  ...(ARG_POSTURE ? { posture: ARG_POSTURE } : {}),   // explicit only — a RESOLVED posture carries via state.posture
  // land changes task behavior MATERIALLY (audit P1 2026-06-11): dropping it on a resume would
  // re-enter the full loop — the exact run-5 failure land exists to avoid. Snapshot, like answers.
  ...(LAND_TASKS.length ? { land: [...LAND_TASKS] } : {}),
  // SNAPSHOT, not the live object: the steer hook mutates ANSWERS mid-run, and resumeArgs must
  // stay the verbatim ORIGINAL invocation (review 2026-06-10: aliasing let steered answers
  // bleed into the persisted canonical args).
  ...(Object.keys(ANSWERS).length ? { answers: { ...ANSWERS } } : {}),
}
const state = {
  // `feat` (the title) is persisted so a watchdog/resumer can reconstruct the original args from
  // state alone: featId is a one-way deterministic hash of FEAT+tasks, so without the title the
  // feat can't be re-invoked. resume_scan.py reads exactly this field. (Feature 1: auto-resume.)
  featId, feat: FEAT, featBranch, base: null,
  resumeArgs,            // full canonical args for a faithful auto-resume (Codex P1)
  tasks: taskNodes,
  baseline: null, env: null, envRecheck: null, integration: null,
  status: 'running',
  // Run-log event ring — the `camus status` "last steps" feed (run feedback 2026-06-10: the
  // human watching a run wants the recent steps without a Claude session). seq is monotonic
  // across resumes (carried from prior state); the cap keeps the state file small.
  events: [], eventSeq: 0,
}
// A short, human-voiced summary of a task spec for the live narration + status feed (run feedback
// 2026-06-11: dumping the whole multi-paragraph spec made the view ugly). The complete spec stays
// on the task node; this is just the headline — the first clause, capped.
function brief(spec, max = 90) {
  const t = String(spec || '').replace(/\s+/g, ' ').trim()
  const dot = t.indexOf('. ')
  const cut = (dot > 12 && dot < max) ? dot : max
  return t.length > cut ? t.slice(0, cut).replace(/[\s,;(]+$/, '') + '…' : t
}
// A step-worthy event: lands in the progress UI (log) AND in the persisted run log (status.py).
// Persisted on the NEXT persistState call — the FIRST one fires when task 1 starts, so
// pre-task notes (resume/feat-branch/baseline) sit in memory through Env+Baseline; early
// finalize paths persist them via finalize → persistState.
function note(msg) {
  state.eventSeq++
  state.events.push({ seq: state.eventSeq, msg })
  if (state.events.length > 20) state.events.splice(0, state.events.length - 20)
  log(msg)
}

// ── JSON helpers — the SCRIPT parses agent stdout, never an agent (copied from
//    camus-loop so verify parsing is byte-identical). ───────────────────
function extractJsonObject(raw) {
  if (raw == null) return null
  let s = String(raw).trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
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
function asVerify(raw) {
  const v = extractJsonObject(raw)
  if (!v || typeof v.pass !== 'boolean') {
    return { pass: false, failures: [{ stage: 'verify', exit: -1, log_tail: 'verify output not parseable as {pass, failures}' }], inconclusive: true }
  }
  return v
}

// ── Schemas (only where the script branches on structured fields) ─────────────
const WRITTEN_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' } } }
const POSTURE_REC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posture', 'why'],
  properties: {
    posture: { type: 'string', enum: ['full', 'oneshot'],
      description: 'full = review↔fix rounds per task (conservative default — pick it whenever unsure, or when ANY task looks complex/cross-cutting). oneshot = one review + one unreviewed fix per task; only for a SMALL feat whose tasks are all clearly trivial/standard with small diffs.' },
    why: { type: 'string', description: 'One sentence naming the trade (e.g. "all 3 tasks trivial, small diffs → review calls 6→3, ~half the review wall-clock; deterministic verify unchanged").' },
  },
}
const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['clean', 'base', 'dirtyFiles', 'stateRaw'],
  properties: {
    clean: { type: 'boolean', description: 'true ONLY if `git status --porcelain` printed nothing' },
    base: { type: 'string', description: 'current branch name (the base the feat is cut from)' },
    dirtyFiles: { type: 'number', description: 'count of porcelain lines' },
    stateRaw: { type: 'string', description: 'exact contents of the prior feat state file, or "" if absent' },
  },
}
const FEATBRANCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'branch', 'created'],
  properties: {
    ok: { type: 'boolean' }, branch: { type: 'string' },
    created: { type: 'boolean', description: 'true if newly created, false if checked out on resume' },
    error: { type: 'string' },
  },
}
const ENV_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ready', 'exitCode', 'output'],
  properties: {
    ready: { type: 'boolean', description: 'true ONLY if env_check.py exited 0' },
    exitCode: { type: 'number' },
    output: { type: 'string', description: 'full stdout/stderr (lists what to fix when not ready)' },
  },
}
const MERGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  // The WHOLE verdict is required (audit P2 rounds 3–4): an omitted field is indistinguishable
  // from a negative answer, and `didCommit` would quietly read it as "no commit" → false noop.
  // Missing evidence must never become a verdict. A compliant runner ALWAYS emits every field
  // (null for a SHA it could not obtain); the contract guard below fails loud regardless.
  required: ['merged', 'committed', 'alreadyUpToDate', 'priorMergeCommit', 'before', 'after'],
  properties: {
    merged: { type: 'boolean', description: 'git exited 0 with NO conflict (includes the already-up-to-date case)' },
    committed: { type: 'boolean', description: 'a NEW merge commit was actually created (HEAD moved)' },
    alreadyUpToDate: { type: 'boolean', description: 'git printed "Already up to date." — the task branch added nothing' },
    before: { type: ['string', 'null'], description: 'HEAD SHA before the merge (null only possible when merged=false — a successful merge necessarily ran rev-parse)' },
    after: { type: ['string', 'null'], description: 'HEAD SHA after the merge (null only possible when merged=false — a successful merge necessarily ran rev-parse)' },
    priorMergeCommit: { type: ['string', 'null'], description: 'SHA of an EXISTING merge commit for this task already in feat history (empty/null if none) — disambiguates crash-after-merge from a genuinely empty branch' },
    conflict: { type: 'boolean' },
    error: { type: 'string', description: 'conflicting files / git error when merged=false' },
  },
}
const CLEANUP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['removed'],
  properties: {
    removed: { type: 'boolean', description: 'git worktree remove exited 0' },
    reason: { type: 'string', description: "git's refusal reason when removed=false" },
  },
}

// ── State + report persistence (agents do all file I/O; script supplies bytes) ─
async function persistState(phaseName) {
  await agent(
    `Persist Camus feat state. Create the directory ~/.camus/feats if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte — do NOT reformat, summarize, or add anything) to ${STATE_PATH} :

${JSON.stringify(state, null, 2)}

Return {written:true} once that file is on disk with exactly that content.`,
    { model: MODEL_RUNNER, phase: phaseName, label: 'state', schema: WRITTEN_SCHEMA }
  )
}

// Worktree cleanup, FAIL-SOFT (run feedback 2026-06-10: per-task `camus-wt-*` folders read as
// trash in the user's filesystem). Once a task's outcome is recorded (merged, or noop with an
// empty diff) the checkout adds nothing — git preserves the branch. SECURITY: the path comes
// from the loop's agent; only act when its basename is EXACTLY the deterministic
// camus-wt-<taskId> (a stricter analogue of the loop's F3 check — exact basename equality,
// not the loop's endsWith suffix match). Never halts the feat — a refusal, a missing path, or
// even a throwing cleanup agent just leaves the directory in place, exactly as before this
// step existed. Failed/paused tasks keep their worktree on purpose (debugging/resume artifact).
async function removeTaskWorktree(node, wtPath, n) {
  const expected = `camus-wt-${node.taskId}`
  if (!wtPath || typeof wtPath !== 'string' || wtPath.split('/').pop() !== expected) {
    if (wtPath) log(`Task ${n}: NOT removing worktree — unexpected path (${wtPath}); expected basename ${expected}.`)
    else log(`Task ${n}: loop reported no worktree path — skipping cleanup (a worktree may be left behind).`)
    return
  }
  let rm = null
  try {
    rm = await agent(
      `THIN git runner. cd ${REPO_ARG}. The Camus task worktree ${JSON.stringify(wtPath)} is no longer needed (its branch is preserved in git). Run EXACTLY this one command:
  git worktree remove ${JSON.stringify(wtPath)}
If git refuses (dirty, locked, or already gone): do NOT force and do NOT delete anything any other way (no rm -rf) — return removed=false with git's reason. Return {removed, reason}.`,
      { model: MODEL_RUNNER, phase: 'Tasks', label: `cleanup:${node.taskId}`, schema: CLEANUP_SCHEMA }
    )
  } catch (e) {
    rm = { removed: false, reason: `cleanup runner threw: ${String((e && e.message) || e)}` }
  }
  if (rm && rm.removed) note(`Task ${n}: removed worktree ${wtPath} (branch kept for audit).`)
  else note(`Task ${n}: worktree left at ${wtPath} (${(rm && rm.reason) || 'cleanup runner returned nothing'}).`)
}

async function finalize(status, extra = {}) {
  state.status = status
  // FEAT-LEVEL pauses must reach the BOARD (smoke 2026-06-12): the posture pause's question only
  // lived in the report, so status rendered a generic — and wrong-shaped — task-answers hint.
  // Persist the question + stage on the state itself; status.py renders the right ask and the
  // right resume shape per stage (posture | budget | steer | task).
  if (typeof extra.question === 'string' && extra.question) state.question = extra.question
  if (typeof extra.stage === 'string' && extra.stage) state.stage = extra.stage
  const report = {
    featId, feat: FEAT, featBranch, base: state.base, status,
    env: state.env, baseline: state.baseline, envRecheck: state.envRecheck, integration: state.integration,
    tasks: state.tasks.map((t) => ({
      taskId: t.taskId, spec: t.spec, dependsOn: t.dependsOn, status: t.status, branch: t.branch, loopStatus: t.loopStatus,
      decisions: t.decisions || [],
      // OPTIONAL loop telemetry — only emitted when the loop reported it (Feature 3).
      ...(t.tier != null ? { tier: t.tier } : {}),
      ...(t.model != null ? { model: t.model } : {}),
      ...(t.rounds != null ? { rounds: t.rounds } : {}),
      ...(t.planSkipped != null ? { planSkipped: t.planSkipped } : {}),
      ...(t.initialModel != null ? { initialModel: t.initialModel } : {}),
      ...(t.finalFixModel != null ? { finalFixModel: t.finalFixModel } : {}),
      ...(t.escalated != null ? { escalated: t.escalated } : {}),
      ...(t.tokens != null ? { tokens: t.tokens } : {}),
      ...(t.question ? { question: t.question, clarity: t.clarity || '' } : {}),
      ...(t.findingsDeferred != null ? { findingsDeferred: t.findingsDeferred } : {}),
      ...(Array.isArray(t.deferredFindings) && t.deferredFindings.length ? { deferredFindings: t.deferredFindings } : {}),
    })),
    // POSTURE VISIBILITY (VELOCITY §1 invariant): the report header always says which review
    // cadence ran — a speed posture must never silently impersonate the full gate.
    ...(state.posture ? { posture: state.posture } : {}),
    ...(state.postureDecision ? { postureDecision: state.postureDecision } : {}),
    // Output tokens spent across the whole turn (shared pool: feat overhead + every task loop).
    ...(spentTok() != null ? { totalOutputTokens: spentTok() } : {}),
    // Feat-level rollup of every decision the loop logged across tasks — the human's merge-time
    // audit trail ("what did the agent decide that I should sanity-check before merging?").
    decisions: state.tasks.flatMap((t) => (t.decisions || []).map((d) => ({ taskId: t.taskId, ...d }))),
    // dwf IS merged work (audit P3); mergedBranch = what the merge ACTUALLY consumed when the
    // loop's reported branch diverged from the deterministic one (P3 follow-up).
    merged: state.tasks.filter((t) => t.status === 'done' || t.status === 'done_with_findings').map((t) => t.mergedBranch || t.branch),
    featBranchToReview: featBranch,
    ...extra,
  }
  await agent(
    `Write the Camus feat REPORT. Create the directory ~/.camus/reports if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte) to ${REPORT_PATH} :

${JSON.stringify(report, null, 2)}

Return {written:true}.`,
    { model: MODEL_RUNNER, phase: 'Report', label: 'report', schema: WRITTEN_SCHEMA }
  )
  await persistState('Report')
  return report
}

// ── 1. PREFLIGHT — base tree must be CLEAN; read prior state for resume ────────
phase('Preflight')
const pf = await agent(
  `THIN preflight runner for a git repo. cd ${REPO_ARG}, then run and report (do NOT modify anything):
1. \`${HB_TOUCH}git rev-parse --abbrev-ref HEAD\`  -> base (the current branch name)
2. \`git status --porcelain\`           -> clean is true ONLY if this prints NOTHING; dirtyFiles = number of lines
3. \`cat ${STATE_PATH} 2>/dev/null || true\` -> stateRaw = the exact file contents, or "" if the file does not exist
Return {clean, base, dirtyFiles, stateRaw}.`,
  { model: MODEL_RUNNER, phase: 'Preflight', label: 'preflight', schema: PREFLIGHT_SCHEMA }
)
if (!pf) return finalize('infra_error', { stage: 'preflight', note: 'preflight agent returned nothing' })
state.base = pf.base || null
if (!pf.clean) {
  return finalize('dirty_tree', {
    note: `Base working tree has ${pf.dirtyFiles} uncommitted change(s). Commit or stash before running the feat — Camus will not run on a dirty tree.`,
  })
}
// Resume: carry forward tasks already marked done in the prior state (already merged into the
// feat branch, which persists in git) so we skip them.
// PROVEN_DECISION (audit P1 2026-06-11): land is authorized by PRIOR PERSISTED STATE, not by the
// caller's list alone. Only a task the previous run halted as `needs_decision` (review ran, didn't
// converge, deterministic verify GREEN) is proven enough to land — a worktree from a run killed
// pre-review must NOT skip codex review just because verify passes. An unproven land request
// downgrades LOUDLY to the full loop; standalone `camus-loop {land:true}` stays the manual
// override where the human takes responsibility directly.
const PROVEN_DECISION = new Set()
// PROVEN_READY (audit P2 2026-06-11): tasks the prior run persisted as `ready_to_merge` — the loop
// had returned done (review clean + committed + verify green) and only the merge was missing.
// FULLY proven, so they AUTO-land on resume (no land list needed): re-running the full loop would
// re-enter review for nothing and collide on the existing branch/worktree.
const PROVEN_READY = new Set()
const prior = pf.stateRaw ? extractJsonObject(pf.stateRaw) : null
if (prior && Array.isArray(prior.tasks)) {
  // Carry forward BOTH done AND noop. A done task is merged into the feat branch (persisted in git);
  // a noop task contributed nothing but its deterministic branch/worktree name is already taken —
  // re-running it would collide. Carrying noop (terminal for resume) avoids the collision and keeps
  // the done_with_noops accounting honest. Also preserve each carried task's logged decisions.
  const priorById = new Map(prior.tasks.filter((t) => t && t.taskId).map((t) => [t.taskId, t]))
  let carried = 0
  for (const node of state.tasks) {
    const p = priorById.get(node.taskId)
    if (p && p.status === 'needs_decision') PROVEN_DECISION.add(node.taskId)
    // merge_failed WITH a proven verdict joins the same lane (smoke 2026-06-12): the work is
    // committed + verified on the task branch and only the merge is missing — the merge agent's
    // refusal (e.g. a dirty main tree) is retryable once the human clears the cause. Without
    // this, the only resume was a full re-loop that collides on the existing branch/worktree.
    const provenButUnmerged = p && p.status === 'merge_failed'
      && (p.provenStatus === 'done' || p.provenStatus === 'done_with_findings')
    if (p && (p.status === 'ready_to_merge' || provenButUnmerged)) {
      PROVEN_READY.add(node.taskId)
      // Carry the crash-window stash (audit P1 2026-06-11) so the post-auto-land status can be
      // restored to the loop's REAL verdict — land mode itself only ever says plain done.
      if (p.provenStatus) node.provenStatus = p.provenStatus
      if (p.findingsDeferred != null) node.findingsDeferred = p.findingsDeferred
      if (Array.isArray(p.deferredFindings)) node.deferredFindings = p.deferredFindings
      if (Array.isArray(p.decisions) && p.decisions.length) node.decisions = p.decisions
    }
    if (p && (p.status === 'done' || p.status === 'noop' || p.status === 'done_with_findings')) {
      // done_with_findings is TERMINAL for camus (the posture's contract: the loop never
      // re-litigates the deferred findings) — carried exactly like done, findings included.
      node.status = p.status
      if (p.status === 'noop') node.noop = true
      if (Array.isArray(p.decisions)) node.decisions = p.decisions
      if (p.loopStatus) node.loopStatus = p.loopStatus
      if (p.tokens != null) node.tokens = p.tokens   // keep the real spend; a replayed delta would read ~0
      if (p.findingsDeferred != null) node.findingsDeferred = p.findingsDeferred
      if (Array.isArray(p.deferredFindings)) node.deferredFindings = p.deferredFindings
      if (p.mergedBranch) node.mergedBranch = p.mergedBranch   // keep the report truthful across resumes
      carried++
    }
  }
  // Carry the run log too, so `camus status` keeps one continuous "last steps" feed across resumes.
  if (Array.isArray(prior.events)) {
    state.events = prior.events.filter((e) => e && e.msg).slice(-20)
    state.eventSeq = Number(prior.eventSeq) || state.events.length
  }
  if (carried) note(`Resume: ${carried} task(s) already done/noop in ${STATE_PATH} — will skip.`)
}

// ── 1b. POSTURE SELECTION (VELOCITY §3: classifier recommends, human confirms) ─
// Explicit wins, no ask (rule 1 — the user marking a desire IS the consent). Absent: a cheap
// classifier proposes over the task briefs. A `full` recommendation applies silently — it does
// not reduce review depth, and pausing to confirm the conservative default would be friction
// with no moat value (deliberate narrowing of the doc's rule 2: we confirm only SPEED postures).
// `oneshot` recommended: asking policies pause ONCE via the existing needs_human transport
// (resume passes posture explicitly → rule 1); autonomous applies it (rule 3 allows full|oneshot
// self-selection only) and the choice + rationale go on the record. When unsure → full, always.
// Resume coherence: a posture RESOLVED on a prior run (recommended/confirmed) carries forward
// from persisted state — re-recommending mid-feat could flip the cadence between resumes.
// resumeArgs stays the verbatim ORIGINAL invocation (only an EXPLICIT posture rides in it).
const PRIOR_POSTURE = (prior && (prior.posture === 'full' || prior.posture === 'oneshot')) ? prior.posture : null
let POSTURE = ARG_POSTURE || PRIOR_POSTURE
if (POSTURE) {
  log(`Posture: ${POSTURE} (${ARG_POSTURE ? 'explicit — used verbatim, never re-asked' : 'carried from the prior run'}).`)
} else {
  const rec = await agent(
    `Recommend a review POSTURE for ONE Camus feat run, from its task list alone.

Tasks:
${state.tasks.map((t, i) => `${i + 1}. ${brief(t.spec, 160)}`).join('\n')}

Rules (conservative by construction):
- ANY task that looks complex, cross-cutting, architectural, or ambiguous → "full". Speed
  postures are for work you are CONFIDENT about; uncertainty buys MORE review, not less.
- "oneshot" only when ALL tasks are clearly trivial/standard with small, well-scoped diffs.
- When unsure → "full".
- The why: ONE plain prose sentence, no trailing period, no identifiers or camelCase tokens
  (it is quoted verbatim to a human).`,
    { model: MODEL_RUNNER, phase: 'Preflight', label: 'posture-rec', schema: POSTURE_REC_SCHEMA }
  )
  const recommended = (rec && rec.posture === 'oneshot') ? 'oneshot' : 'full'
  // Strip any trailing period/space: the why is composed into sentences below, and a why that
  // arrives with its own period printed ".." in the field (smoke nit 2026-06-12).
  const why = ((rec && rec.why) || 'no rationale returned — defaulting conservative').replace(/[.\s]+$/, '')
  if (recommended === 'full') {
    POSTURE = 'full'
    log(`Posture: full (recommended default — ${why}).`)
  } else if (POLICY === 'autonomous') {
    POSTURE = 'oneshot'
    state.postureDecision = { posture: 'oneshot', source: 'classifier_autonomous', why }
    note(`Posture: ONESHOT (classifier recommendation, autonomous apply) — ${why}. On the record; deterministic verify unchanged.`)
  } else {
    note(`Posture recommendation: ONESHOT — pausing ONCE to confirm (a recommendation that silently reduced review depth would be the moat eroding itself).`)
    return finalize('needs_human', {
      stage: 'posture',
      question: `Recommended posture: oneshot — ${why}. Review cadence drops to ONE review + ONE unreviewed fix per task (results read done_with_findings, never review-clean; deterministic verify unchanged). Confirm or override.`,
      resumeWith: { posture: 'oneshot | full' },
      note: `The classifier recommends the ONESHOT posture for this feat (${why}). Re-run with posture:"oneshot" to take the speed trade, or posture:"full" for today's full review cadence — the explicit value is used verbatim and never re-asked.`,
    })
  }
}
state.posture = POSTURE
if (POSTURE !== 'full') note(`▶ Posture ${POSTURE.toUpperCase()} is ACTIVE for this run — review cadence reduced BY CHOICE; deterministic verify gates every task as always.`)

// ── 2. Cut (or resume) the feat branch from base ─────────────────────────────
phase('Feat branch')
const fb = await agent(
  `THIN git runner. cd ${REPO_ARG}. Idempotently put the repo's working tree ON the feat branch ${JSON.stringify(featBranch)}:
- If \`git rev-parse --verify --quiet ${JSON.stringify(featBranch)}\` succeeds (branch exists) -> \`git checkout ${JSON.stringify(featBranch)}\`, created=false (resume).
- Otherwise create it from the current base branch -> \`git checkout -b ${JSON.stringify(featBranch)}\`, created=true.
Do nothing else. Return {ok, branch, created, error}.`,
  { model: MODEL_RUNNER, phase: 'Feat branch', label: 'feat-branch', schema: FEATBRANCH_SCHEMA }
)
if (!fb || !fb.ok) return finalize('infra_error', { stage: 'feat_branch', note: (fb && fb.error) || 'could not create/checkout the feat branch' })
note(`Feat branch ${featBranch} ${fb.created ? 'created' : 'checked out (resume)'} from base ${state.base}.`)

// ── 3. ENV CHECK on the feat branch (fresh trees lack node_modules — mandatory) ─
phase('Env+Baseline')
const env = await agent(
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${ENV_CMD} ${REPO_ARG}
ready=true ONLY if it exits 0. Capture exitCode and the full stdout+stderr text in output (when not ready it lists what to fix, e.g. \`pnpm install\`). Do not interpret further.`,
  { model: MODEL_RUNNER, phase: 'Env+Baseline', label: 'env-check', schema: ENV_SCHEMA }
)
state.env = env ? { ready: !!env.ready, exitCode: env.exitCode, output: env.output, when: 'baseline' }
                : { ready: false, exitCode: -1, output: 'env agent returned nothing', when: 'baseline' }
// ENV FACTS (smoke 2026-06-11): lift the doctor's deterministic [env-facts] block and thread it
// into every task's loop, where it lands in the plan/implement/fix prompts — platform truths
// (darwin, GNU-timeout absence, codex version/auth) stop being rediscovered mid-run. ADVISORY
// only: an absent or garbled block degrades to '' and gates nothing. Bounded to keep prompts lean.
const factsMatch = String((state.env && state.env.output) || '').match(/\[env-facts\]\s*([\s\S]*?)\s*\[\/env-facts\]/)
const ENV_FACTS = factsMatch ? factsMatch[1].trim().slice(0, 1500) : ''
if (ENV_FACTS) log(`Env facts captured for agent prompts (${ENV_FACTS.split('\n').length} line(s)).`)
if (!state.env.ready) {
  return finalize('env_not_ready', {
    stage: 'baseline_env',
    note: 'Environment not ready on the feat branch — fix the issues below (e.g. run the project install), then re-run.',
    fix: state.env.output,
  })
}

// ── 4. BASELINE VERIFY — base must be green before any task ───────────────────
const baseRaw = await agent(
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_CMD} ${REPO_ARG}
Output the command's stdout VERBATIM as your entire reply (JSON {pass,failures,checks}). No fences, no commentary.`,
  { model: MODEL_RUNNER, phase: 'Env+Baseline', label: 'baseline-verify' }
)
const baseV = asVerify(baseRaw)
state.baseline = baseV
if (baseV.pass !== true) {
  // A verify that could NOT run (missing toolchain/deps, or a guard refusal) is infra/env — NOT a
  // red base. Surface it as env_not_ready so a setup issue never masquerades as broken base code.
  if (baseV.inconclusive) {
    return finalize('env_not_ready', {
      stage: 'baseline_verify',
      note: 'Baseline verify could NOT run (toolchain/deps missing, or the target guard refused) — env/infra, not code-red. Fix the environment and re-run.',
      failures: baseV.failures || [],
    })
  }
  return finalize('base_red', {
    stage: 'baseline_verify',
    note: 'Baseline verify FAILED on the freshly-cut feat branch — the base is red. Not running any task on red.',
    failures: baseV.failures || [],
  })
}
note(`Baseline green on ${featBranch}. Running ${state.tasks.length} task(s) strictly in order.`)

// ── 5. TASKS — sequential; reuse camus-loop; merge on done; halt on first non-done ─
phase('Tasks')
for (let i = 0; i < state.tasks.length; i++) {
  const node = state.tasks[i]
  const n = `${i + 1}/${state.tasks.length}`
  if (node.status === 'done' || node.status === 'noop' || node.status === 'done_with_findings') { log(`Task ${n} "${node.taskId}" already ${node.status} (resume) — skipping.`); continue }

  // ── BUDGET CEILING (0.2.5 item 4): checked at the BOUNDARY, against PERSISTED per-task totals
  // (cross-run — node.tokens survives resumes; this turn's overhead is not double-counted). Past
  // the cap: halt-and-ask. needs_human is NOT auto-resumable (F6), so a watchdog can't ping-pong
  // a budget halt; the human re-runs with a higher budgetTokens (or drops it) to continue.
  if (BUDGET_TOKENS != null) {
    const featSpent = state.tasks.reduce((a, t) => a + (typeof t.tokens === 'number' ? t.tokens : 0), 0)
    if (featSpent >= BUDGET_TOKENS) {
      note(`Token budget reached before task ${n}: ~${Math.round(featSpent / 1000)}k persisted output tokens ≥ budgetTokens=${BUDGET_TOKENS}.`)
      return finalize('needs_human', {
        stage: 'budget', haltedTask: node.taskId, spentTokens: featSpent, budgetTokens: BUDGET_TOKENS,
        question: `Token budget reached (~${Math.round(featSpent / 1000)}k of ${Math.round(BUDGET_TOKENS / 1000)}k, before task ${n}) — continue with a higher budgetTokens, or stop here?`,
        note: `Spent ~${Math.round(featSpent / 1000)}k of the ${Math.round(BUDGET_TOKENS / 1000)}k output-token budget (persisted across runs — an estimate, not an invoice). Continue / stop here? Earlier merged tasks stay on ${featBranch}. To continue: re-run with a HIGHER budgetTokens (or without it); the resume skips done tasks.`,
      })
    }
  }

  // ── HUMAN STEERING (`camus steer` → steer.py): a note at ~/.camus/steer/<featId>.json is
  // consumed at each task BOUNDARY — the clean, merged point where redirecting is safe. Live
  // mid-task injection is deliberately unsupported (the engine is a deterministic, resumable
  // script; the steer agent's result is journaled like any other, so replay stays exact).
  //   {pause:true}        → graceful resumable halt BEFORE this task starts
  //   {guidance:"..."}    → threads into THIS task exactly like a needs_human answer
  //   {answers:{id:".."}} → merged into the run's answer map (may target later tasks)
  // Steered answers live only for THIS run — they are NOT persisted into resumeArgs and do
  // not survive a pause/resume (re-steer or pass answers explicitly on the re-run).
  const steerRaw = await agent(
    `THIN steer-check runner. A human may have left a steering note for this Camus run. Run EXACTLY, in order:
1. \`${HB_TOUCH}cat ~/.camus/steer/${featId}.json 2>/dev/null || echo {}\` — capture the full output.
2. \`rm -f ~/.camus/steer/${featId}.json\` — consume it (a note applies ONCE). If rm is refused, continue anyway.
Return the captured output VERBATIM as your entire reply. No fences, no commentary.`,
    { model: MODEL_RUNNER, phase: 'Tasks', label: `steer:${node.taskId}` }
  )
  const steerParsed = extractJsonObject(steerRaw)
  // A PRESENT-but-unparseable note must not vanish silently (the rm already consumed it): the
  // no-note case is exactly "{}" from the `|| echo {}`, so anything else that fails to parse
  // was a real note the human wrote — surface it loudly (review 2026-06-10).
  if (steerParsed == null && steerRaw != null && String(steerRaw).trim() !== '{}') {
    // HALT, don't proceed (fixlet 2026-06-11 upgrade of the 2026-06-10 loud-log): a steer note is
    // a human countermand — silently dropping one and running on re-opens exactly what it was
    // written to prevent. The note is already consumed (the rm ran), so the halt message must say
    // nothing was applied and ask for a re-issue. needs_human → not auto-resumable.
    note(`Task ${n}: a steer note was PRESENT but UNPARSEABLE — halting; NOTHING was applied.`)
    return finalize('needs_human', {
      stage: 'steer', haltedTask: node.taskId,
      question: `A steer note before task ${n} was unparseable and was consumed UNAPPLIED — re-issue your guidance, then re-run.`,
      note: `A steer note was present but could not be parsed before task ${n} — it was consumed (deleted) and NOTHING was applied. Halting rather than running past your guidance. Re-issue it (\`camus steer ...\`) and re-run the feat with the SAME args to resume from here.`,
    })
  }
  const steer = steerParsed || {}
  if (steer.pause === true) {
    // RE-QUEUE the rest of the note before halting (audit P1 2026-06-11): steer merges compose
    // pause+answers into ONE note, but the cat/rm above already CONSUMED it — halting here would
    // silently drop the answers/guidance riding alongside the pause. Write the remainder (minus
    // pause) back to the steer path so the NEXT run's boundary check picks it up: pause fires
    // once, the payload survives the pause. Fail-soft but LOUD: a failed re-queue is named in
    // the halt note so the human knows to re-issue.
    const remainder = {}
    if (steer.answers && typeof steer.answers === 'object' && !Array.isArray(steer.answers)) remainder.answers = steer.answers
    if (typeof steer.guidance === 'string' && steer.guidance.trim()) remainder.guidance = steer.guidance.trim()
    let requeued = null
    if (Object.keys(remainder).length) {
      const rq = await agent(
        `Persist a Camus steer note. Create the directory ~/.camus/steer if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte) to ~/.camus/steer/${featId}.json :

${JSON.stringify(remainder, null, 2)}

Return {written:true} once that file is on disk with exactly that content.`,
        { model: MODEL_RUNNER, phase: 'Tasks', label: `steer-requeue:${node.taskId}`, schema: WRITTEN_SCHEMA }
      )
      requeued = !!(rq && rq.written)
      note(requeued
        ? `Task ${n}: the pause note also carried ${Object.keys(remainder).join('+')} — re-queued for the resume.`
        : `⚠ Task ${n}: the pause note carried ${Object.keys(remainder).join('+')} but the re-queue FAILED — re-issue it with \`camus steer\` before resuming.`)
    }
    note(`PAUSED by a human steer note before task ${n} ("${node.taskId}").`)
    return finalize('paused_by_user', {
      stage: 'task', haltedTask: node.taskId,
      note: `A human paused the run (camus steer --pause) before task ${n}. Earlier merged tasks remain on ${featBranch}. Re-run the feat with the SAME args to continue from here (resume carries done tasks forward).${requeued === true ? ' The answers/guidance that rode along with the pause were RE-QUEUED and will apply on the resume.' : (requeued === false ? ' WARNING: the answers/guidance riding with the pause could NOT be re-queued — re-issue them (`camus steer ...`) before resuming.' : '')} If the re-run immediately pauses again, the note could not be deleted — \`camus steer --clear --feat ${featId}\` first.`,
    })
  }
  if (steer.answers && typeof steer.answers === 'object' && !Array.isArray(steer.answers)) {
    Object.assign(ANSWERS, steer.answers)
    note(`Task ${n}: human steer answers merged (${Object.keys(steer.answers).join(', ')}).`)
  }
  if (typeof steer.guidance === 'string' && steer.guidance.trim()) {
    ANSWERS[node.taskId] = steer.guidance.trim()
    note(`Task ${n}: human steer guidance applied to this task.`)
  }

  // Land authorization (audit P1 2026-06-11): requested by the caller, AUTHORIZED by prior state —
  // plus AUTO-land for ready_to_merge (audit P2: died between commit and merge → fully proven; only
  // the merge was missing, so resuming the full loop would be pure churn + a worktree collision).
  const landRequested = LAND_TASKS.includes(node.taskId)
  const landResume = PROVEN_READY.has(node.taskId)
  const landAuthorized = landResume || (landRequested && PROVEN_DECISION.has(node.taskId))
  if (landRequested && !landAuthorized) {
    note(`⚠ Task ${n}: land requested but prior state is NOT needs_decision — running the FULL loop instead (land only executes an ACCEPT on a proven verify-clean halt; unproven work must pass review). Manual override: standalone camus-loop {land:true}.`)
  }
  node.status = 'running'
  note(landResume
    ? `▸ Task ${n} — ${brief(node.spec)} · LAND (resuming interrupted merge — loop had finished) → commit → verify → merge…`
    : (landAuthorized
      ? `▸ Task ${n} — ${brief(node.spec)} · LAND (accepted decision) → commit → verify → merge…`
      : `▸ Task ${n} — ${brief(node.spec)} · plan → implement → review → verify…`))
  await persistState('Tasks')   // persist 'running' NOW so `camus status` shows the live task
  // Per-task token telemetry (run feedback 2026-06-10): budget.spent() is the shared TURN
  // pool, so the delta around the loop call is this task's own spend. Values feed ONLY
  // logs/state/report — never an agent prompt that gates control flow. (On a resume the
  // numbers differ, so the thin state/report writers re-run instead of cache-replaying —
  // deliberate and cheap; identity/branch determinism is untouched.)
  const tokensBefore = spentTok()

  // The OTHER tasks' one-line briefs (+ live status: done siblings read differently than pending
  // ones), for the loop's review/fix prompts. Recomputed per task so statuses are current.
  const siblingBriefs = state.tasks.filter((t) => t.taskId !== node.taskId)
    .map((t) => `- ${t.taskId} [${t.status}]: ${brief(t.spec)}`).join('\n')

  // Reuse the PROVEN v2-lite loop verbatim (classify→plan→implement→codex-review↔fix→verify).
  // Feat-scope its identity so the task branch is namespaced under the feat, and its worktree
  // is cut from the CURRENT feat-branch HEAD (the main tree is on the feat branch).
  let res = null
  try {
    res = await workflow('camus-loop', {
      task: node.spec,
      branchPrefix,        // 'camus/feat/<featId>/'
      idSalt: featId,      // makes the loop's id hash feat-unique
      policy: POLICY,      // HITL posture, applied per task
      ...(MODEL ? { model: MODEL } : {}),            // feat-level model override (shared contract)
      ...(MODEL_TIER ? { modelTier: MODEL_TIER } : {}),
      ...(SKIP_PLAN ? { skipPlan: true } : {}),       // opt-in; loop honors only under policy:autonomous
      ...(ROUND_CAP != null ? { roundCap: ROUND_CAP } : {}),   // per-task review-round budget
      ...(landAuthorized ? { land: true } : {}),  // PROVEN accept decision → land; unproven → full loop
      ...(ANSWERS[node.taskId] ? { humanAnswer: String(ANSWERS[node.taskId]) } : {}),  // resume answer
      ...(ENV_FACTS ? { envFacts: ENV_FACTS } : {}),  // platform truths → loop agent prompts (advisory)
      ...(POSTURE !== 'full' ? { posture: POSTURE } : {}),  // review cadence (VELOCITY §1); full = loop default
      // SIBLING CONTEXT (fixlet 2026-06-11): the other tasks' briefs + statuses, so the per-task
      // reviewer stops flagging sibling scope as "incomplete" and fix agents stay in their lane.
      ...(siblingBriefs ? { siblingTasks: siblingBriefs } : {}),
      ...(TARGET ? { targetPath: TARGET } : {}),
    })
  } catch (e) {
    res = { status: 'infra_error', error: String((e && e.message) || e) }
  }
  node.loopStatus = (res && res.status) || 'unknown'
  const tokensAfter = spentTok()
  if (tokensBefore != null && tokensAfter != null) node.tokens = Math.max(0, tokensAfter - tokensBefore)

  if (res && res.status === 'no_changes') {
    // NO-OP RESCUE (live smoke run-2, 2026-06-12): "nothing to commit" is AMBIGUOUS — an empty
    // diff also happens when the implement agent improvised around a `worktree add -b` branch
    // collision by ATTACHING the existing task branch, whose tip already holds a prior run's
    // committed (and reviewed) work. That run laundered a proven extraction into a "noop" while
    // the feat reported done. Disambiguate with git, not vibes: commits on the task branch that
    // are NOT in feat history mean this is UNMERGED PROVEN WORK → re-enter this task as an
    // auto-land (same lane as ready_to_merge) instead of recording a no-op.
    const unmergedRaw = await agent(
      `THIN git runner. cd ${REPO_ARG}. Run EXACTLY this one command and output ONLY its stdout (a number, or an error line):
  ${HB_TOUCH}git rev-list --count ${JSON.stringify(featBranch)}..${JSON.stringify(node.branch)} --
If the branch does not exist git errors — output that error line verbatim.`,
      { model: MODEL_RUNNER, phase: 'Tasks', label: `noop-audit:${node.taskId}` }
    )
    const unmerged = parseInt(String(unmergedRaw == null ? '' : unmergedRaw).trim(), 10)
    if (Number.isInteger(unmerged) && unmerged > 0) {
      note(`⚠ Task ${n}: loop said no_changes BUT ${node.branch} holds ${unmerged} unmerged commit(s) — a prior run's proven work. Re-entering as AUTO-LAND, not a no-op.`)
      node.status = 'ready_to_merge'
      PROVEN_READY.add(node.taskId)
      await persistState('Tasks')
      i--   // re-enter THIS task: the landResume lane picks it up immediately
      continue
    }
    // A genuinely empty diff (no branch, or branch fully merged). Not a failure — flag as a
    // NO-OP and CONTINUE (don't merge an empty branch, don't halt the feat).
    node.status = 'noop'
    node.noop = true
    await persistState('Tasks')
    note(`Task ${n}: loop returned no_changes (nothing to commit; branch audit found no unmerged work) → recorded as NO-OP, continuing.`)
    await removeTaskWorktree(node, res.worktree, n)   // empty diff — the checkout adds nothing
    continue
  }

  if (res && res.status === 'needs_human') {
    // The loop PAUSED for a human decision before implementing (HITL ask-gate). Not a failure —
    // halt the feat and surface the question + context. Earlier merged tasks remain on the feat
    // branch; the user re-runs with answers:{<taskId>: "..."} and this task resumes with the answer.
    node.status = 'needs_human'
    node.question = res.question || ''
    node.clarity = res.clarity || ''
    await persistState('Tasks')
    note(`Task ${n}: loop PAUSED for a human decision (clarity=${res.clarity}). Halting feat to ask.`)
    return finalize('needs_human', {
      stage: 'task', haltedTask: node.taskId,
      question: res.question || '', clarity: res.clarity || '',
      interpretations: res.interpretations || [], plan: res.plan || '',
      resumeWith: { answers: { [node.taskId]: '<your answer here>' } },
      note: `Task ${n} needs a human decision before it can proceed (policy ${POLICY}). Answer the question, then re-run the feat with answers:{"${node.taskId}":"<your answer>"}. Tasks merged before this remain on ${featBranch}; this task resumes with your answer threaded in.`,
    })
  }

  // done_with_findings (VELOCITY §1, oneshot posture) is MERGEABLE: the work is committed and
  // deterministically green — the deferred review debt is the posture's contract, carried on
  // the node and surfaced at the feat level (never as a plain done).
  const mergeableStatus = res && (res.status === 'done' || res.status === 'done_with_findings')
  if (!mergeableStatus) {
    // Any non-done (review_unresolved / verify_failed / verify_inconclusive / infra_error /
    // aborted) -> HALT. M1 never builds later tasks on top of a non-done one.
    // A review_unresolved whose DETERMINISTIC verify is green is a DECISION POINT, not broken code:
    // persist it as a DISTINCT status (audit 2026-06-11 — it was persisted as `failed` and rendered
    // ✗, contradicting the "decision, not failure" note) so status.py shows it as a decision.
    const verifyCleanHalt = res && res.status === 'review_unresolved' && res.verifyClean === true
    node.status = verifyCleanHalt ? 'needs_decision' : 'failed'
    await persistState('Tasks')
    note(verifyCleanHalt
      ? `⚠ Task ${n} did not converge in review, BUT deterministic verify PASSES — a decision (accept vs refine), not a failure.`
      : `Task ${n} HALTED the feat — loop returned "${node.loopStatus}".`)
    return finalize('halted', {
      stage: 'task', haltedTask: node.taskId, haltReason: node.loopStatus, loopResult: res || null,
      ...(verifyCleanHalt ? { verifyCleanDecision: true } : {}),
      ...(res && res.oscillating ? { oscillating: true } : {}),
      note: verifyCleanHalt
        ? `Task ${n} review did not converge, BUT deterministic verify (type-check / lint / tests) PASSES on its worktree — the code is shippable by the deterministic gate. This is a DECISION, not a failure: ${res.oscillating ? 'the reviewer OSCILLATED (a finding returned after vanishing for a round — an unstable signal to distrust, not a stable disagreement). ' : ((res.stuck && res.stuck.length) ? 'a finding was re-raised after a fix (likely a stale re-flag). ' : '')}review the finding(s) in loopResult.blocking, then either ACCEPT (commit + merge ${node.branch} into ${featBranch} as-is) or REFINE (fix and re-run the feat). Tasks merged before this remain on ${featBranch}.`
        : `Task ${n} did not reach "done" (${node.loopStatus}). Per M1, later tasks are NOT run on top of a failed one. Tasks merged before this remain on ${featBranch}. Retry idiom after fixing the cause: re-invoke the feat FRESH with the SAME args — the deterministic featId resumes from persisted state (done tasks skip, this task re-runs against its intact worktree). Do NOT resume the workflow journal (resumeFromRunId) past a gate/env fix: completed-but-failed agent calls replay their cached failure without re-running anything.`,
    })
  }

  // READY_TO_MERGE (audit P2 2026-06-11): the loop just returned done — review clean, committed,
  // verify green. Persist that PROOF before attempting the merge, so a run that dies in the
  // commit→merge window resumes by LANDING mechanically (auto-land below) instead of re-running
  // the full loop — which would re-enter review AND collide on the existing branch/worktree.
  node.status = 'ready_to_merge'
  // CRASH-WINDOW DEBT CARRY (audit P1 2026-06-11): the loop's VERDICT — oneshot's
  // fixed-unreviewed findings, and its decisions — must ride in the same proof persist.
  // Auto-land re-runs the loop in land mode, which can only ever say plain `done` (it never
  // re-reviews); without this stash, a death between this persist and the post-merge one would
  // LAUNDER review debt into a clean-looking done on resume.
  // A LANDED result is mechanical (commit→verify only) — it must never overwrite the verdict
  // the original run stashed here; only a real loop run owns provenStatus.
  if (!res.landed) node.provenStatus = res.status
  if (res.status === 'done_with_findings') {
    node.findingsDeferred = res.findingsDeferred || (Array.isArray(res.findings) ? res.findings.length : 0)
    if (Array.isArray(res.findings)) node.deferredFindings = res.findings
  }
  if (Array.isArray(res.decisions) && res.decisions.length) node.decisions = res.decisions
  await persistState('Tasks')

  // Merge the loop's reported branch (cross-check against our deterministic one).
  const mergeBranch = res.branch || node.branch
  if (res.branch && res.branch !== node.branch) {
    log(`WARN: loop branch "${res.branch}" != expected "${node.branch}" — merging the loop's reported branch.`)
  }
  const mg = await agent(
    `THIN git merge runner. cd ${REPO_ARG}. Merge the completed task branch into the feat branch. Run EXACTLY, in order, and report what git actually did:
1. \`${HB_TOUCH}git checkout ${JSON.stringify(featBranch)}\`
2. \`git rev-parse HEAD\`  -> record as before
3. \`git merge --no-ff ${JSON.stringify(mergeBranch)} -m ${JSON.stringify('camus(feat): merge ' + node.taskId)}\`
4. \`git rev-parse HEAD\`  -> record as after
5. ONLY IF git printed "Already up to date.": \`git log ${JSON.stringify(featBranch)} --grep ${JSON.stringify('camus(feat): merge ' + node.taskId)} --format=%H -n 1\` -> record the SHA (or empty) as priorMergeCommit
Report:
- merged: true if git exited 0 with NO conflict (this INCLUDES the "Already up to date." case).
- committed: true ONLY if after != before (a NEW merge commit was really created). false if git printed "Already up to date." or HEAD did not move.
- alreadyUpToDate: true if git printed "Already up to date." (the task branch tip is already in feat history).
- priorMergeCommit: ALWAYS include this field — the step-5 SHA if one was found, else null (also null when step 5 did not apply). Omitting it is a contract violation. (Distinguishes "this task was ALREADY merged by a prior run" from "the branch never had anything to merge".)
- before, after: the two HEAD SHAs (null only if that step never ran).
ALWAYS include EVERY field above — booleans are always determinable; use null only for a SHA you could not obtain. An omitted field is a contract violation.
On a CONFLICT: run \`git merge --abort\`, set merged=false, conflict=true, put the conflicting files in error. Never touch the base branch (${JSON.stringify(state.base)}).
Return {merged, committed, alreadyUpToDate, priorMergeCommit, before, after, conflict, error}.`,
    { model: MODEL_RUNNER, phase: 'Tasks', label: `merge:${node.taskId}`, schema: MERGE_SCHEMA }
  )
  if (!mg || !mg.merged) {
    node.status = 'merge_failed'
    note(`Task ${n}: merging ${mergeBranch} into ${featBranch} FAILED (${(mg && mg.error) || 'unknown'}) — halting.`)
    await persistState('Tasks')
    return finalize('feat_integration_failed', {
      stage: 'merge', haltedTask: node.taskId,
      note: `Merging task ${node.taskId} into ${featBranch} failed (${(mg && mg.error) || 'unknown'}). Halting; earlier merges remain.`,
    })
  }
  // MERGE-VERDICT CONTRACT (audit P2 rounds 3–4): missing evidence must never become a verdict.
  // Runner omissions could silently misclassify: (a) committed/alreadyUpToDate absent →
  // didCommit defaults false → a FALSE noop; (b) already-up-to-date without the prior-merge-commit
  // check → crash-after-merge reads as an empty branch; (c) the required priorMergeCommit field
  // omitted even when not applicable → a schema-bypass silently reaches done. All fail LOUD instead:
  // the task stays ready_to_merge (still literally true: proven work, merge state unresolved) so a
  // re-run retries the idempotent merge with a fresh, contract-complete runner.
  // NOTE: we are past the `!mg.merged` halt, so merged===true here — and a SUCCESSFUL merge means
  // steps 2 and 4 (rev-parse before/after) necessarily ran, so missing OR null SHAs are equally
  // contradictory (audit P2 round 5: didCommit's `!before || !after` tolerance would otherwise
  // accept a SHA-less report as `done`).
  const shaMissing = (v) => typeof v !== 'string' || !v.trim()
  // CONSISTENCY (audit P2 rounds 6–7): a COMPLETE report can still contradict itself. The SHAs
  // are the ground truth: committed must mean HEAD moved, and alreadyUpToDate must mean HEAD did
  // not move. A flag that contradicts them is a runner misread, never a verdict.
  const headMoved = mg.before !== mg.after
  const contractGap = (mg.committed === undefined || mg.alreadyUpToDate === undefined)
    ? 'committed/alreadyUpToDate omitted from the merge report'
    : (shaMissing(mg.before) || shaMissing(mg.after))
      ? 'before/after SHAs missing from a successful merge report'
      : ((mg.committed !== headMoved) || (mg.alreadyUpToDate !== !headMoved))
        ? 'self-contradictory merge report (committed/alreadyUpToDate vs HEAD movement)'
        : (mg.priorMergeCommit === undefined
          ? (mg.alreadyUpToDate === true
            ? 'already-up-to-date reported without the prior-merge-commit check'
            : 'priorMergeCommit omitted from the merge report')
          : null)
  if (contractGap) {
    node.status = 'ready_to_merge'
    await persistState('Tasks')
    note(`Task ${n}: merge runner CONTRACT VIOLATION (${contractGap}) — ambiguous verdict, refusing to guess. Task stays ready_to_merge; re-run to retry the merge.`)
    return finalize('feat_integration_failed', {
      stage: 'merge', haltedTask: node.taskId,
      note: `The merge runner for ${node.taskId} returned an incomplete report (${contractGap}). Camus does not turn missing evidence into a verdict (noop/done). The task remains ready_to_merge; re-run the feat with the SAME args — the merge retries (idempotent) with a complete report.`,
    })
  }
  // FALSE-POSITIVE GUARD: the loop returned "done" but the merge added NO commit — the task
  // contributed nothing to the feat branch (scope overlap with an earlier task, or an empty
  // implement). Record it as a NO-OP, not a real merge, so the feat can never claim a plain
  // "done" while a task actually did nothing. This guard only ever DOWNGRADES the outcome
  // (done → done_with_noops); it can never turn a red feat green.
  const didCommit = mg.committed === true && mg.alreadyUpToDate !== true && (!mg.before || !mg.after || mg.before !== mg.after)
  if (!didCommit) {
    // CRASH-AFTER-MERGE resume (audit P2 2026-06-11): "already up to date" is AMBIGUOUS — it also
    // fires when a prior run merged this task and died before persisting `done`. The discriminator
    // is EVIDENCE: our deterministic merge-commit message for this taskId already in feat history
    // (step 5). THREE evidence states (the contract guard above removed the ambiguous third):
    // present → done; explicitly empty (''/null — the check RAN, found nothing) → no-op guard.
    const priorMerge = mg.alreadyUpToDate === true && typeof mg.priorMergeCommit === 'string' && mg.priorMergeCommit.trim()
    if (priorMerge) {
      // Crash-AFTER-merge variant of the same window (audit P1): the proof persist's
      // provenStatus is the loop's real verdict — restore it here too, or this evidence path
      // launders done_with_findings exactly like a plain land would.
      node.status = (node.provenStatus === 'done_with_findings') ? 'done_with_findings' : 'done'
      if (!(Array.isArray(node.decisions) && node.decisions.length && !(Array.isArray(res.decisions) && res.decisions.length))) {
        node.decisions = Array.isArray(res.decisions) ? res.decisions : []
      }
      // Same effective-branch truth as the normal commit path (audit P3, third lane): the prior
      // run's merge consumed mergeBranch — without this, merged[] falls back to the
      // deterministic node.branch on exactly this resume.
      if (mergeBranch !== node.branch) node.mergedBranch = mergeBranch
      await persistState('Tasks')
      note(`${node.status === 'done_with_findings' ? '◈' : '✓'} Task ${n} was ALREADY merged into ${featBranch} by a prior run that died before recording it (merge commit ${String(priorMerge).slice(0, 8)}) → recorded as ${node.status.toUpperCase()}, resuming.`)
      await removeTaskWorktree(node, res.worktree, n)   // merged — checkout no longer needed
      continue
    }
    node.status = 'noop'
    node.noop = true
    await persistState('Tasks')
    note(`Task ${n}: loop said "done" but the merge added NO commit (already-up-to-date, no prior merge commit for this task) → recorded as NO-OP, not a merge.`)
    await removeTaskWorktree(node, res.worktree, n)   // branch merged/empty — checkout no longer needed
    continue
  }
  // Final status: the loop's verdict — except on a LANDED resume, where land mode only knows
  // `done` and the truth lives in the proof persist's provenStatus (audit P1: never let a
  // mechanical land launder done_with_findings into done).
  const finalStatus = (res.landed && (node.provenStatus === 'done' || node.provenStatus === 'done_with_findings'))
    ? node.provenStatus : res.status
  node.status = finalStatus   // 'done', or 'done_with_findings' under oneshot (◈ on the board)
  // EFFECTIVE branch (audit P3 follow-up 2026-06-11): when the loop reported a different branch,
  // the merge above used IT (the WARN tolerance) — the report must name what was actually
  // merged, not the deterministic expectation. Stored only on mismatch; merged[] prefers it.
  if (mergeBranch !== node.branch) node.mergedBranch = mergeBranch
  if (finalStatus === 'done_with_findings' && Array.isArray(res.findings)) {
    node.findingsDeferred = res.findingsDeferred || res.findings.length
    node.deferredFindings = res.findings   // verbatim, for the report (live path; resume carries its own)
  }
  // Land returns decisions: [] — keep the crash-carried decisions rather than clobbering them.
  if (!(res.landed && Array.isArray(node.decisions) && node.decisions.length && !(Array.isArray(res.decisions) && res.decisions.length))) {
    node.decisions = Array.isArray(res.decisions) ? res.decisions : []   // audit trail for merge review
  }
  // OPTIONAL loop telemetry (shared contract with camus-loop; all may be absent). Surfaced
  // in the report + log line so the human sees which tier/model ran the task and how many
  // implement↔review rounds it took, without inventing UI.
  if (res.tier != null) node.tier = res.tier
  if (res.model != null) node.model = res.model
  if (res.rounds != null) node.rounds = res.rounds
  if (res.planSkipped != null) node.planSkipped = res.planSkipped
  // P3 escalation telemetry — surfaced so a Sonnet→Opus bump is visible in the report at merge time.
  if (res.initialModel != null) node.initialModel = res.initialModel
  if (res.finalFixModel != null) node.finalFixModel = res.finalFixModel
  if (res.escalated != null) node.escalated = res.escalated
  await persistState('Tasks')
  const tele = [
    node.model != null ? `model ${node.model}` : null,
    node.tier != null ? `tier ${node.tier}` : null,
    node.rounds != null ? `${node.rounds} round${node.rounds === 1 ? '' : 's'}` : null,
    node.tokens != null ? `~${Math.round(node.tokens / 1000)}k tokens` : null,
  ].filter(Boolean)
  note(`${node.status === 'done_with_findings' ? '◈' : '✓'} Task ${n} ${node.status} — ${brief(node.spec)} · merged ${mg.after ? String(mg.after).slice(0, 8) : '?'}${tele.length ? ` (${tele.join(' · ')})` : ''}${node.decisions.length ? ` · ${node.decisions.length} decision(s)` : ''}${node.findingsDeferred ? ` · ${node.findingsDeferred} finding(s) DEFERRED to you` : ''}`)
  await removeTaskWorktree(node, res.worktree, n)     // merged — the worktree is now just litter
}
note(`All tasks processed${spentTok() != null ? ` — ~${Math.round(spentTok() / 1000)}k output tokens spent this turn` : ''}.`)

// ── BUDGET RECHECK (audit P2 2026-06-11): the pre-task check can't see the FINAL task's spend —
// a last task blowing the cap would otherwise sail into integration and finish green without the
// promised halt. Same ceiling, one more boundary: after the last task, before integration. A
// resume with a raised budget skips done tasks and passes straight through here to integration.
if (BUDGET_TOKENS != null) {
  const featSpent = state.tasks.reduce((a, t) => a + (typeof t.tokens === 'number' ? t.tokens : 0), 0)
  if (featSpent >= BUDGET_TOKENS) {
    note(`Token budget reached AFTER the final task: ~${Math.round(featSpent / 1000)}k ≥ budgetTokens=${BUDGET_TOKENS} — halting before integration.`)
    return finalize('needs_human', {
      stage: 'budget', spentTokens: featSpent, budgetTokens: BUDGET_TOKENS,
      question: `Token budget reached (~${Math.round(featSpent / 1000)}k of ${Math.round(BUDGET_TOKENS / 1000)}k, after the final task) — integration verify has NOT run; continue with a higher budgetTokens?`,
      note: `Spent ~${Math.round(featSpent / 1000)}k of the ${Math.round(BUDGET_TOKENS / 1000)}k output-token budget (persisted across runs — an estimate, not an invoice). Every task is done/merged but integration verify has NOT run, so the feat is not "done" yet. Continue by re-running with a HIGHER budgetTokens (or without it) — done tasks skip straight to integration.`,
    })
  }
}

// ── POSTFLIGHT SELF-AUDIT (live smoke run-2, 2026-06-12) ──────────────────────
// The gate must catch its own drops: run-2 reported done while a task's reviewed, committed
// work sat unmerged on its branch (a collision became a "noop"). Deterministic ancestry check —
// every completed task's branch must hold ZERO commits outside feat history (noop included:
// a no-op with unmerged commits is a contradiction). POSITIVE evidence (a count > 0) halts as
// self_audit_failed, never done; a branch the runner could not report is WARNED loudly but does
// not halt (an unreadable audit must not kill a good feat — the count lines are the evidence).
// This is the product absorbing the failure mode: the check a human (or the nearest Claude
// session) did by hand after the fact, now run by the gate before it reports anything.
const auditedTasks = state.tasks.filter((t) => t.status === 'done' || t.status === 'done_with_findings' || t.status === 'noop')
if (auditedTasks.length) {
  const auditRaw = await agent(
    `THIN git runner. cd ${REPO_ARG} (the tree is on the feat branch). For EACH branch listed below, run:
  git rev-list --count HEAD..<branch> --
Output EXACTLY one line per branch: <branch> <count>   (or: <branch> ERROR if git errors). Nothing else.
${auditedTasks.map((t) => '  ' + (t.mergedBranch || t.branch)).join('\n')}
Run \`${HB_TOUCH}true\` first (heartbeat; ignore failures).`,
    { model: MODEL_RUNNER, phase: 'Integration', label: 'self-audit' }
  )
  const counts = {}
  for (const line of String(auditRaw == null ? '' : auditRaw).split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\d+|ERROR)$/)
    if (m) counts[m[1]] = m[2]
  }
  const violations = []
  const unreadable = []
  for (const t of auditedTasks) {
    const b = t.mergedBranch || t.branch
    const c = counts[b]
    if (c === undefined || c === 'ERROR') unreadable.push(b)
    else if (parseInt(c, 10) > 0) violations.push({ taskId: t.taskId, status: t.status, branch: b, unmergedCommits: parseInt(c, 10) })
  }
  if (violations.length) {
    note(`✗ SELF-AUDIT FAILED: ${violations.length} task branch(es) hold commits NOT in feat history — work the gate reported on is not actually merged.`)
    return finalize('self_audit_failed', {
      stage: 'self_audit', violations,
      note: `The postflight self-audit found ${violations.length} completed task(s) whose branch holds commits NOT merged into ${featBranch}: ${violations.map((v) => `${v.taskId} (${v.status}, ${v.unmergedCommits} commit(s) on ${v.branch})`).join('; ')}. The feat must NOT read done. For each: if the work is proven (a prior run reviewed+verified it), flip the task to ready_to_merge and re-run — the auto-land lane merges it; otherwise re-run the task through the full loop after clearing the branch.`,
    })
  }
  if (unreadable.length) note(`⚠ Self-audit could not read ${unreadable.length} branch(es) (${unreadable.join(', ')}) — ancestry NOT verified for them.`)
  else log('Self-audit clean: every completed task branch is fully merged into feat history.')
}

// ── 6. ENV RE-CHECK (tasks may have added deps) + FINAL INTEGRATION VERIFY ─────
phase('Integration')
const env2 = await agent(
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${ENV_CMD} ${REPO_ARG}
ready=true ONLY if it exits 0. Capture exitCode and full stdout+stderr in output.`,
  { model: MODEL_RUNNER, phase: 'Integration', label: 'env-recheck', schema: ENV_SCHEMA }
)
state.envRecheck = env2 ? { ready: !!env2.ready, exitCode: env2.exitCode, output: env2.output, when: 'integration' }
                        : { ready: false, exitCode: -1, output: 'env agent returned nothing', when: 'integration' }
if (!state.envRecheck.ready) {
  return finalize('env_not_ready', {
    stage: 'integration_env',
    note: 'Environment not ready on the merged feat branch (a task may have added deps). Fix env (e.g. install) and re-run.',
    fix: state.envRecheck.output,
  })
}
const intRaw = await agent(
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_CMD} ${REPO_ARG}
Output the command's stdout VERBATIM (JSON {pass,failures,checks}). No fences, no commentary.`,
  { model: MODEL_RUNNER, phase: 'Integration', label: 'integration-verify' }
)
const intV = asVerify(intRaw)
state.integration = intV
if (intV.pass === true) {
  const noopTasks = state.tasks.filter((t) => t.status === 'noop').map((t) => t.taskId)
  const realMerges = state.tasks.filter((t) => t.status === 'done' || t.status === 'done_with_findings').length
  // REVIEW DEBT FIRST (VELOCITY §1 invariant: "no posture may report plain done while deferring
  // risk"). Any task that merged with fixed-unreviewed findings makes the FEAT done_with_findings
  // — integration verify being green is the floor, not the review. Stronger caveat than noops,
  // so it wins when both apply (the note still names the noops).
  const dwfTasks = state.tasks.filter((t) => t.status === 'done_with_findings')
  if (dwfTasks.length) {
    return finalize('done_with_findings', {
      realMerges,
      ...(noopTasks.length ? { noopTasks } : {}),
      deferredFindings: dwfTasks.map((t) => ({ taskId: t.taskId, findings: t.deferredFindings || [], resolution: 'fixed_unreviewed' })),
      note: `Integration verify is GREEN on ${featBranch} and every task merged — but ${dwfTasks.length} task(s) carry review findings that were fixed ONCE and NEVER re-reviewed (${state.posture || 'oneshot'} posture contract). The findings are verbatim in this report under deferredFindings — read them before shipping.${noopTasks.length ? ` Also: ${noopTasks.length} task(s) were no-ops.` : ''} NOT review-clean; never a plain done.`,
    })
  }
  if (noopTasks.length) {
    // Integration is green, but at least one task claimed "done" while adding no commit. Never
    // report a plain "done" in that case — surface the no-op(s) so a feat can't look complete
    // when a task actually did nothing.
    return finalize('done_with_noops', {
      noopTasks, realMerges,
      note: `Integration verify is GREEN on ${featBranch} (${realMerges} task(s) merged real commits), but ${noopTasks.length} task(s) claimed "done" while adding NO commit (no-op — likely scope overlap with an earlier task, or an empty implement). NOT reported as a plain "done": review the no-op task(s) before trusting the feat. Left for human merge.`,
    })
  }
  return finalize('done', {
    note: `All ${state.tasks.length} task(s) merged real commits and integration verify is GREEN on ${featBranch}. Left for human merge.`,
  })
}
if (intV.inconclusive) {
  return finalize('env_not_ready', {
    stage: 'integration_verify',
    note: 'Integration verify could NOT run (toolchain/deps) — not code-red. Fix env and re-run.',
    failures: intV.failures || [],
  })
}
// Baseline was green, integration is red -> the merged feat broke something.
return finalize('feat_integration_failed', {
  stage: 'integration_verify',
  note: 'Baseline was green but the merged feat fails integration verify. The feat branch is NOT shippable as-is.',
  failures: intV.failures || [],
})
