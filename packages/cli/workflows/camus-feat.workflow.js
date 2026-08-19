export const meta = {
  name: 'camus-feat',
  description: 'Run an ordered task list as ONE feature through the Camus M1 gate: preflight → feat branch → env+baseline → per-task v2-lite loop (merge on done) → env re-check + integration verify → report. Linear only (no DAG/parallel/bisection).',
  whenToUse: 'Drive a small ordered feat (2–3 tasks in M1) through v2-overnight M1. args = { feat: "<title>", tasks: ["task 1", "task 2", ...], targetPath?, policy?, answers?, posture? }; for an existing large plan, { resumeFeatId: "<id>", posture? } mechanically loads its validated canonical args without retranscribing the task list. policy ∈ autonomous|ask_on_ambiguity(default)|ask_on_major controls when a task PAUSES for a human (status needs_human); on a resume after a pause, answers={ "<taskId>": "..." } threads the decision back in. posture ∈ full(default)|oneshot — review cadence (VELOCITY §1): absent, a classifier recommends and asking policies confirm a speed posture ONCE; oneshot tasks report done_with_findings, never review-clean. Reuses camus-loop per task with feat-scoped branch identity. Launch FROM the target repo (cwd = repo root). Run `npx camus-cli check` (or `bash install.sh --check` from the package) yourself first — gate-freshness is a human step.',
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
const MERGE_CMD = `bash ${SKILL}/merge.sh`           // <feat> <task> <msg> -> the merge contract JSON,
                                                     // computed in-script (hookless/unsigned inside the
                                                     // allowlisted script — run-5 classifier finding)
const MODEL_RUNNER = 'haiku'                         // thin shell runners — no judgment to apply
// Appended to every gating-verify prompt (live smoke run-6, 2026-06-12): the integration
// verifier EDITED the code under verification to turn red green, left the fix staged when the
// permission layer blocked its commit, and relayed pass:true — the gate certified a green the
// committed branch doesn't have. The prompt alone doesn't constrain (run-6's said "run EXACTLY");
// verify.py now snapshots tracked-file porcelain before/after and reports any dirt as a RED
// integrity failure, so this clause states a fact, not a plea: remediation can no longer
// produce a green.
const VERIFY_OATH = `A RED result is a SUCCESSFUL run of this command — return it verbatim and STOP.
Do NOT edit, stage, commit, or "fix" ANYTHING, and do NOT re-run after changing files: the script
snapshots the tree and reports any tracked-file change as tampering (RED), so remediation can never
turn this green — it only destroys the evidence a human needs.`

// ── Args: { feat, tasks: [...ordered], targetPath? } ─────────────────────────
// Tolerate a JSON-encoded string (some callers stringify args); parse it back to an object.
// STRICT JSON only, deliberately (live smoke run-3, 2026-06-12): a fresh session forwarded a
// JS-style literal (unquoted keys) verbatim and JSON.parse refused it. Auto-repairing keys with
// a quoting regex was considered and REJECTED — task strings legitimately contain `, word:`
// shapes ("…, acceptance: …") that a string-blind transform would corrupt INSIDE quotes,
// trading this loud error for silent arg mangling. The error teaches instead.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (_) { /* leave as string -> fails below */ } }
// LARGE-PLAN TRANSPORT (dogfood 2026-08-19): the slash-command mediator dropped a 12-task,
// 42 KB task array while translating `/camus-feat`, then spent minutes trying to reconstruct it.
// A small resumeFeatId crosses that LLM boundary reliably; a mechanical helper validates and reads
// the canonical args sidecar, after which explicit fields on this invocation (e.g. posture) win.
// The workflow still receives the complete task contracts before computing identity or dispatching.
if (A && typeof A === 'object' && !Array.isArray(A) && A.resumeFeatId != null) {
  const resumeFeatId = String(A.resumeFeatId)
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(resumeFeatId)) {
    throw new Error('camus-feat: resumeFeatId must be a lowercase alphanumeric/hyphen feat id')
  }
  const loaded = await agent(
    `THIN canonical-args loader. Run EXACTLY this one command and return its stdout VERBATIM as {raw}:\n  python3 ${SKILL}/resume_args.py ${JSON.stringify(resumeFeatId)}\nDo not inspect, summarize, or modify the JSON.`,
    { model: MODEL_RUNNER, phase: 'Preflight', label: 'args-load', schema: {
      type: 'object', additionalProperties: false, required: ['raw'],
      properties: { raw: { type: 'string', description: 'exact stdout from resume_args.py' } },
    } }
  )
  let loadedArgs = null
  try { loadedArgs = JSON.parse(loaded && loaded.raw) } catch (_) { /* loud refusal below */ }
  if (!loadedArgs || typeof loadedArgs !== 'object' || Array.isArray(loadedArgs)) {
    throw new Error(`camus-feat: could not load validated canonical args for resumeFeatId ${resumeFeatId}`)
  }
  const overrides = { ...A }
  delete overrides.resumeFeatId
  A = { ...loadedArgs, ...overrides }
}
if (!A || typeof A !== 'object' || Array.isArray(A)) {
  throw new Error('camus-feat: args must be an object { feat, tasks: [...] }'
    + (typeof args === 'string'
      ? ' — got a STRING that is not valid JSON. If your invocation stringifies args, use strict JSON (quoted keys: {"feat": "...", "tasks": ["..."]}), not a JS-style literal.'
      : ' (got: ' + typeof args + ')'))
}
const FEAT = String(A.feat || '').trim()
const TASKS = Array.isArray(A.tasks) ? A.tasks.map((t) => String(t).trim()).filter(Boolean) : []
const TARGET = (A.targetPath && String(A.targetPath)) || ''
// targetPath reaches the per-task loop's REPO_CD `cd "…"` (verification audit 2026-06-13): a path
// with $(…)/backticks would execute. A real path never carries these; refuse before forwarding
// poison downstream (the loop rejects it too — defense in depth).
if (TARGET && ['$', '`', '"', '\\', '\n', '\r'].some((c) => TARGET.includes(c))) {
  throw new Error('camus-feat: targetPath contains shell-unsafe characters ($ ` " \\ or newline) — pass a plain filesystem path.')
}
// args.verifyCmd (field soak 2026-06-13, finding 3): a per-run verify override for HEADLESS runs
// (no interactive shell to `export CAMUS_VERIFY_CMD`). Persisted in resumeArgs, forwarded to every
// per-task loop, and inlined as an ENV-ASSIGNMENT PREFIX: CAMUS_VERIFY_CMD="<value>" cmd.
// SHELL-INJECTION GUARD (verification audit 2026-06-13): INSIDE double quotes bash STILL expands
// $(…) / `…` and honors \ and " — JSON.stringify does NOT neutralize them. A value carrying any of
// $ ` " \ or a newline is REFUSED (dropped → auto-detect verify still gates; named loudly), which
// closes the escalation where an LLM-grounded camus-plan verifyCmd reaches the gate as code-exec.
const _VERIFY_CMD_RAW = (typeof A.verifyCmd === 'string' && A.verifyCmd.trim()) ? A.verifyCmd : ''
const _VERIFY_UNSAFE = ['$', '`', '"', '\\', '\n', '\r']
const VERIFY_CMD_OVERRIDE = (_VERIFY_CMD_RAW && !_VERIFY_UNSAFE.some((ch) => _VERIFY_CMD_RAW.includes(ch))) ? _VERIFY_CMD_RAW : ''
if (_VERIFY_CMD_RAW && !VERIFY_CMD_OVERRIDE) log('⚠ Ignoring args.verifyCmd: it contains shell-unsafe characters ($ ` " \\ or newline). Falling back to auto-detected verify — bake the command into your repo\'s test script instead.')
const VERIFY_ENV = VERIFY_CMD_OVERRIDE ? `CAMUS_VERIFY_CMD=${JSON.stringify(VERIFY_CMD_OVERRIDE)} ` : ''
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
// HUMAN STEERING — OPT-IN, default OFF (descoped from 0.2.7, 2026-06-14). `camus steer` is concurrent
// file-IPC between the human CLI and this workflow over a shared note file; six audit rounds shrank
// the race windows to ~single syscalls and made every failure mode fail-safe, but the read-then-act
// architecture guarantees residual windows. Rather than ship that surface promoted, steer is gated
// behind args.steer=true (experimental) so a normal run never touches the steer path. The race-free
// redesign (atomic claim → per-run private inbox; the durable-log pattern) lands default-ON in 0.3.
const STEER_ENABLED = A.steer === true
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
// All feat-level git/env/verify run at the GIT TOPLEVEL, resolved at command time — NOT the raw
// launch cwd (field soak "garland" 2026-06-13): a launch from a SUBDIRECTORY made `$PWD` the
// subdir, so baseline/integration verify ran against the subdir (wrong/no verifier) and identity
// diverged. `git rev-parse --show-toplevel` is invariant across any cwd inside the repo; a subdir
// launch now behaves identically to a root launch. Falls back to `$PWD` only when NOT in a repo,
// so the preflight's own NOT_A_REPO detection still fires cleanly.
// `targetPath` stays a CODE-SCOPE HINT forwarded to camus-loop per task — it must NOT become the
// feat runner's cd target (baseline/integration guards require the repo root on a camus/feat-* branch).
const REPO_ARG = '"$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"'

// Parent-tree containment RECEIPT (live re-soak 2026-06-14, finding B): containment.sh reads
// `git status --porcelain` MECHANICALLY in the MAIN checkout and emits {ran,dirty,paths} — the
// same script camus-loop uses to catch a worktree leak. The feat runs it at each task BOUNDARY so
// a concurrent editor (e.g. the driver session) that dirtied the parent tree is caught HERE, at the
// clean merge point, instead of surfacing later as a confusing integration-verify anomaly. A thin
// runner only echoes the receipt; ran:false ⇒ inconclusive (never a clean verdict).
const CONTAIN_CMD = `bash ${SKILL}/containment.sh`

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
// POSIX single-quote a value before inlining it into a command (verification audit round-2,
// 2026-06-13): nothing expands inside '…'. Used for the AGENT-RETURNED merge branch (res.branch) —
// JSON.stringify only double-quotes, where bash STILL expands $(…)/backticks.
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
// Reject the in-double-quote-dangerous set for path-shaped values that reach a shell (round-3:
// a persisted worktree path used in `git worktree remove`).
const _SHELL_UNSAFE = ['$', '`', '"', '\\', '\n', '\r']
const shellSafe = (s) => typeof s === 'string' && s.length > 0 && !_SHELL_UNSAFE.some((c) => s.includes(c))
// A legitimate camus branch ref — used to validate a state-FILE-loaded mergedBranch before it is
// inlined into the self-audit command (round-3: a poisoned ~/.camus state file is the doctrine's
// untrusted-state threat; a real value is always camus/feat/<id>/<slug>-<id>).
const _CAMUS_BRANCH_OK = /^camus\/[A-Za-z0-9/_-]+$/
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
const ARGS_REF = `${featId}.args.json`
const ARGS_PATH = `~/.camus/feats/${ARGS_REF}`
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
  // steering is opt-in (descoped 0.2.7) — a resume MUST keep it on, else a paused/crashed/auto-resumed
  // steer-enabled run would silently revert to steering OFF (resume_scan.py emits resumeArgs verbatim).
  ...(STEER_ENABLED ? { steer: true } : {}),
  ...(VERIFY_CMD_OVERRIDE ? { verifyCmd: VERIFY_CMD_OVERRIDE } : {}),   // headless verify override (finding 3)
  ...(ARG_POSTURE ? { posture: ARG_POSTURE } : {}),   // explicit only — a RESOLVED posture carries via state.posture
  // land changes task behavior MATERIALLY (audit P1 2026-06-11): dropping it on a resume would
  // re-enter the full loop — the exact run-5 failure land exists to avoid. Snapshot, like answers.
  ...(LAND_TASKS.length ? { land: [...LAND_TASKS] } : {}),
  // SNAPSHOT, not the live object: the steer hook mutates ANSWERS mid-run, and resumeArgs must
  // stay the verbatim ORIGINAL invocation (review 2026-06-10: aliasing let steered answers
  // bleed into the persisted canonical args).
  ...(Object.keys(ANSWERS).length ? { answers: { ...ANSWERS } } : {}),
}
// Canonical args can dwarf the changing run state (large RFC task lists routinely exceed 40 KB).
// Write them once per distinct invocation in a sibling sidecar, then checkpoint only a
// deterministic reference. FNV is a corruption/coherence check, not an authenticity boundary —
// both files live in the same operator-owned directory. resume_scan.py validates the reference,
// hash, schema, and feat identity before using it. Legacy inline resumeArgs remain readable.
const resumeArgsHash = `fnv1a32:${fnv1a(JSON.stringify(resumeArgs))}`
let argsSidecarAttempted = false
let argsSidecarReady = false
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
// Preflight can halt before the normal resume-hydration block (dirty tree, detached HEAD, or the
// common "you are still on the feat branch" guard). Keep the raw prior checkpoint available so
// finalize cannot replace proven task lanes with freshly-created pending nodes on those paths.
let priorStateForFinalize = ''
let priorHydrated = false
// A short, human-voiced summary of a task spec for the live narration + status feed (run feedback
// 2026-06-11: dumping the whole multi-paragraph spec made the view ugly). The complete spec stays
// on the task node; this is just the headline — the first clause, capped.
function brief(spec, max = 90) {
  const t = String(spec || '').replace(/\s+/g, ' ').trim()
  const dot = t.indexOf('. ')
  const cut = (dot > 12 && dot < max) ? dot : max
  return t.length > cut ? t.slice(0, cut).replace(/[\s,;(]+$/, '') + '…' : t
}

function compactTask(t) {
  const { spec, ...rest } = t
  return { ...rest, brief: brief(spec, 160) }
}

function compactLoopResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const { task, ...rest } = result
  return task == null ? result : { ...rest, taskBrief: brief(task, 160) }
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
// resolveEnv (field soak 2026-06-13, item 4): readiness is DERIVED from the mechanical exit code,
// NOT the agent's self-judged `ready` bool. Returns {state} on a coherent read (ready ⇔ exitCode===0),
// or {halt} when the relay's `ready` CONTRADICTS its `exitCode` (a misread — never advance on a
// contradicted env, the merge-receipt defection posture). Absent agent / non-numeric exitCode →
// ready:false (fail-closed → the caller's normal env_not_ready halt). `when` ∈ baseline|integration.
function resolveEnv(env, when) {
  if (!env) return { state: { ready: false, exitCode: -1, output: 'env agent returned nothing', when } }
  const exit0 = (typeof env.exitCode === 'number' && env.exitCode === 0)
  if (typeof env.ready === 'boolean' && env.ready !== exit0) {
    return { halt: { stage: when + '_env',
      note: `env-check relay self-contradicts: ready=${env.ready} but exitCode=${env.exitCode}. The exit code is ground truth; Camus refuses to guess readiness from a contradicted relay. Re-run.`,
      fix: env.output } }
  }
  return { state: { ready: exit0, exitCode: env.exitCode, output: env.output, when } }
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
  required: ['clean', 'base', 'dirtyFiles', 'stateRaw', 'argsPresent'],
  properties: {
    clean: { type: 'boolean', description: 'true ONLY if `git status --porcelain` printed nothing' },
    base: { type: 'string', description: 'current branch name (the base the feat is cut from)' },
    dirtyFiles: { type: 'number', description: 'count of porcelain lines' },
    stateRaw: { type: 'string', description: 'exact contents of the prior feat state file, or "" if absent' },
    argsPresent: { type: 'boolean', description: 'true only when the referenced resume-args sibling exists' },
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
async function ensureResumeArgsSidecar() {
  if (argsSidecarReady || argsSidecarAttempted) return argsSidecarReady
  argsSidecarAttempted = true
  try {
    const saved = await agent(
      `Persist canonical Camus feat resume args. Create the directory ~/.camus/feats if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte — do NOT reformat, summarize, or add anything) to ${ARGS_PATH} :

${JSON.stringify(resumeArgs, null, 2)}

Return {written:true} once that file is on disk with exactly that content.`,
      { model: MODEL_RUNNER, phase: 'Preflight', label: 'args', schema: WRITTEN_SCHEMA }
    )
    argsSidecarReady = !!(saved && saved.written === true)
  } catch (e) {
    argsSidecarReady = false
    log(`Resume-args sidecar write failed; retaining inline args in checkpoints (${String((e && e.message) || e)}).`)
  }
  if (!argsSidecarReady) log('Resume-args sidecar was not confirmed; retaining inline args in checkpoints.')
  return argsSidecarReady
}

function stateSnapshot() {
  const { resumeArgs: _inlineArgs, tasks, ...rest } = state
  return {
    ...rest,
    ...(argsSidecarReady
      ? { resumeArgsRef: ARGS_REF, resumeArgsHash }
      : { resumeArgs }),
    // The canonical task contracts already live in resumeArgs. Dynamic checkpoints only need the
    // stable task identity plus a readable headline and changing execution fields.
    tasks: tasks.map(compactTask),
  }
}

async function persistState(phaseName) {
  await ensureResumeArgsSidecar()
  const snapshot = stateSnapshot()
  await agent(
    `Persist Camus feat state. Create the directory ~/.camus/feats if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte — do NOT reformat, summarize, or add anything) to ${STATE_PATH} :

${JSON.stringify(snapshot, null, 2)}

Return {written:true} once that file is on disk with exactly that content.`,
    { model: MODEL_RUNNER, phase: phaseName, label: 'state', schema: WRITTEN_SCHEMA }
  )
}

function hydratePriorForEarlyFinalize() {
  if (priorHydrated) return
  priorHydrated = true
  const prior = priorStateForFinalize ? extractJsonObject(priorStateForFinalize) : null
  if (!prior || prior.featId !== featId || !Array.isArray(prior.tasks)) return
  const priorById = new Map(prior.tasks.filter((t) => t && t.taskId).map((t) => [t.taskId, t]))
  for (const node of state.tasks) {
    const old = priorById.get(node.taskId)
    if (!old) continue
    // Preserve execution evidence, but never let an out-of-tree state file replace the task
    // contract or computed branch identity used by this invocation.
    const { taskId: _taskId, spec: _spec, brief: _brief, dependsOn: _dependsOn,
      branch: _branch, mergedBranch, ...dynamic } = old
    Object.assign(node, dynamic)
    if (mergedBranch && _CAMUS_BRANCH_OK.test(String(mergedBranch))) node.mergedBranch = mergedBranch
  }
  if (Array.isArray(prior.events)) {
    state.events = prior.events.filter((e) => e && e.msg).slice(-20)
    state.eventSeq = Number(prior.eventSeq) || state.events.length
  }
  for (const key of ['baseline', 'env', 'envRecheck', 'integration']) {
    if (state[key] == null && prior[key] != null) state[key] = prior[key]
  }
  if (prior.posture === 'full' || prior.posture === 'oneshot') state.posture = prior.posture
  if (prior.postureDecision) state.postureDecision = prior.postureDecision
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
  // shellSafe (round-3): the path is inlined into `git worktree remove "…"` — the basename check
  // alone let /tmp/$(…)/camus-wt-<taskId> through (basename matches, $() expands). Skip cleanup on
  // any shell-unsafe path rather than rely on the upstream loop invariant; a left-behind worktree is benign.
  if (!wtPath || typeof wtPath !== 'string' || !shellSafe(wtPath) || wtPath.split('/').pop() !== expected) {
    if (wtPath) log(`Task ${n}: NOT removing worktree — unexpected or unsafe path (${wtPath}); expected basename ${expected}.`)
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
  hydratePriorForEarlyFinalize()
  state.status = status
  // FEAT-LEVEL pauses must reach the BOARD (smoke 2026-06-12): the posture pause's question only
  // lived in the report, so status rendered a generic — and wrong-shaped — task-answers hint.
  // Persist the question + stage on the state itself; status.py renders the right ask and the
  // right resume shape per stage (posture | budget | steer | task).
  if (typeof extra.question === 'string' && extra.question) state.question = extra.question
  if (typeof extra.stage === 'string' && extra.stage) state.stage = extra.stage
  // Persist the terminal state BEFORE the report. If report writing is interrupted, status/watch
  // must not claim the run is still active (the old report→state order produced exactly that split).
  await persistState('Report')
  const reportExtra = extra && extra.loopResult
    ? { ...extra, loopResult: compactLoopResult(extra.loopResult) }
    : extra
  const report = {
    featId, feat: FEAT, featBranch, base: state.base, status,
    env: state.env, baseline: state.baseline, envRecheck: state.envRecheck, integration: state.integration,
    tasks: state.tasks.map((t) => ({
      taskId: t.taskId, brief: brief(t.spec, 160), dependsOn: t.dependsOn, status: t.status, branch: t.branch, loopStatus: t.loopStatus,
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
    ...(argsSidecarReady ? { resumeArgsRef: ARGS_REF, resumeArgsHash } : {}),
    ...reportExtra,
  }
  await agent(
    `Write the Camus feat REPORT. Create the directory ~/.camus/reports if it does not exist, then write the following EXACT JSON (verbatim, byte-for-byte) to ${REPORT_PATH} :

${JSON.stringify(report, null, 2)}

Return {written:true}.`,
    { model: MODEL_RUNNER, phase: 'Report', label: 'report', schema: WRITTEN_SCHEMA }
  )
  return report
}

// ── 1. PREFLIGHT — base tree must be CLEAN; read prior state for resume ────────
phase('Preflight')
const pf = await agent(
  `THIN preflight runner for a git repo. cd ${REPO_ARG}, then run and report (do NOT modify anything):
1. \`${HB_TOUCH}git rev-parse --abbrev-ref HEAD\`  -> base (the current branch name).
   If this FAILS with "not a git repository", return base: "NOT_A_REPO" (clean: false, dirtyFiles: 0) and skip steps 1b-2.
1b. \`git rev-parse --verify -q HEAD >/dev/null\` — if THIS fails (a repo with ZERO commits), return base: "UNBORN" (clean: false, dirtyFiles: 0) and skip step 2.
2. \`git status --porcelain --ignore-submodules=all\`  -> clean is true ONLY if this prints NOTHING; dirtyFiles = number of lines
3. \`cat ${STATE_PATH} 2>/dev/null || true\` -> stateRaw = the exact file contents, or "" if the file does not exist
4. \`test -f ${ARGS_PATH}\` -> argsPresent = true only when it exits 0 (do NOT read the file)
Return {clean, base, dirtyFiles, stateRaw, argsPresent}.`,
  { model: MODEL_RUNNER, phase: 'Preflight', label: 'preflight', schema: PREFLIGHT_SCHEMA }
)
if (pf && typeof pf.stateRaw === 'string') priorStateForFinalize = pf.stateRaw
if (!pf) return finalize('infra_error', { stage: 'preflight', note: 'preflight agent returned nothing' })
// NOT A GIT REPO (product question 2026-06-12): without git there is no bounded diff for the
// cross-vendor reviewer, no isolation worktree, no merge-on-done rollback, no commit-backed
// resume, no self-audit — i.e. none of the properties that make a green run trustworthy.
// Refuse with the ten-second, fully-LOCAL entry fee named — previously this flailed into a
// misleading `dirty_tree` ("uncommitted changes" in a folder with no git at all).
if (pf.base === 'NOT_A_REPO') {
  return finalize('not_a_git_repo', {
    stage: 'preflight',
    note: `This directory is not a git repository, and the camus gate is built on git: the diff is what the cross-vendor reviewer judges, the worktree is the isolation, merge-on-done is the rollback, commits are the resume. Entry fee (~10 seconds, fully LOCAL — no GitHub, no remote, no account, nothing is ever pushed):\n  git init && git add -A && git commit --allow-empty -m "baseline"\nThen re-run the feat with the same args.`,
  })
}
// UNBORN repo (git audit 2026-06-12, P3): `git init` with zero commits — rev-parse prints "HEAD"
// to stdout while erroring, `worktree add` infers --orphan, and the guard then refuses mid-loop
// after implement already paid. Refuse up front; note that an empty dir's `git add -A && commit`
// produces exactly this state, so the recipe carries --allow-empty.
if (pf.base === 'UNBORN') {
  return finalize('unborn_repo', {
    stage: 'preflight',
    note: 'This repository has no commits yet — the gate needs a baseline commit to diff against, branch from, and roll back to. Make one (an empty dir needs --allow-empty):\n  git add -A && git commit --allow-empty -m "baseline"\nThen re-run the feat with the same args.',
  })
}
// DETACHED HEAD (git audit 2026-06-12, P3): rev-parse prints literal "HEAD" with rc=0, and the
// feat would silently cut its branch from the parked commit — every downstream "base" claim
// would be incoherent. A detached launch is almost always an accident (bisect, checkout <sha>);
// refusing is cheaper than a wrong baseline.
if (pf.base === 'HEAD') {
  return finalize('detached_head', {
    stage: 'preflight',
    note: 'HEAD is detached — the feat would be cut from the parked commit, not a branch. Check out the branch you mean to build on (e.g. `git checkout main`) and re-run.',
  })
}
state.base = pf.base || null
if (!pf.clean) {
  return finalize('dirty_tree', {
    note: `Base working tree has ${pf.dirtyFiles} uncommitted change(s). Commit or stash before running the feat — Camus will not run on a dirty tree. (If the lines name a SUBMODULE, the pointer is stale rather than edited: \`git submodule update --init\` clears it.)`,
  })
}
// BASE-FROM-CHECKOUT guard (field soak 2026-06-13, finding 9): launching while checked out on a
// leftover camus/feat-* branch silently cuts the new feat off it — inheriting unmerged, possibly
// unreviewed work as the baseline (and baseline-verify passes because the prior feat's commits are
// green). Same implicit-context family as the fork (finding 5): the base is the current branch,
// and forking it forks identity. Halt with a converging next step rather than build on a phantom base.
if (typeof pf.base === 'string' && /^camus\/feat[-/]/.test(pf.base) && A.allowFeatBase !== true) {
  return finalize('needs_human', {
    stage: 'base_is_feat_branch', question: `Base branch "${pf.base}" is a camus feat branch, not a mainline.`,
    note: `The current branch is "${pf.base}" — a camus feat branch, not a mainline. Cutting this feat from it would inherit its unmerged (possibly unreviewed) work as your baseline. Almost always this means a prior run left you on a feat branch: \`git checkout main\` (or your mainline) and re-run the feat with the SAME args. If you GENUINELY mean to stack on it, re-run with allowFeatBase:true.`,
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
// A compact prior state plus an existing sidecar proves that this invocation already sealed args.
// Avoid paying another large write on every manual resume. The scanner independently verifies the
// sidecar bytes before auto-resuming; a missing/corrupt sidecar therefore fails closed there.
if (prior && prior.resumeArgsRef === ARGS_REF && prior.resumeArgsHash === resumeArgsHash && pf.argsPresent === true) {
  argsSidecarAttempted = true
  argsSidecarReady = true
}
if (prior && Array.isArray(prior.tasks)) {
  // Carry forward BOTH done AND noop. A done task is merged into the feat branch (persisted in git);
  // a noop task contributed nothing but its deterministic branch/worktree name is already taken —
  // re-running it would collide. Carrying noop (terminal for resume) avoids the collision and keeps
  // the done_with_noops accounting honest. Also preserve each carried task's logged decisions.
  const priorById = new Map(prior.tasks.filter((t) => t && t.taskId).map((t) => [t.taskId, t]))
  let carried = 0
  for (const node of state.tasks) {
    const p = priorById.get(node.taskId)
    if (p && p.status === 'needs_decision') {
      PROVEN_DECISION.add(node.taskId)
      // The parked proof's sha (publish audit round-3): an ACCEPTED decision lands head-bound
      // to the park — the live-tip fallback is for legacy states only, never for a known proof.
      if (typeof p.provenCommit === 'string' && p.provenCommit) node.provenCommit = p.provenCommit
    }
    // merge_failed WITH a proven verdict joins the same lane (smoke 2026-06-12): the work is
    // committed + verified on the task branch and only the merge is missing — the merge agent's
    // refusal (e.g. a dirty main tree) is retryable once the human clears the cause. Without
    // this, the only resume was a full re-loop that collides on the existing branch/worktree.
    const provenButUnmerged = p && p.status === 'merge_failed'
      && (p.provenStatus === 'done' || p.provenStatus === 'done_with_findings')
    if (p && (p.status === 'ready_to_merge' || provenButUnmerged)) {
      PROVEN_READY.add(node.taskId)
      // Keep the serialized lane truthful too. PROVEN_READY controls dispatch below, but any
      // pre-task halt (fork/posture/env) persists state before dispatch; leaving this as the fresh
      // default `pending` erases the proof from status and blocks `camus land` recovery.
      node.status = 'ready_to_merge'
      // Carry the crash-window stash (audit P1 2026-06-11) so the post-auto-land status can be
      // restored to the loop's REAL verdict — land mode itself only ever says plain done.
      if (p.provenStatus) node.provenStatus = p.provenStatus
      // …and the proof's sha (publish audit round-2): the auto-land binds verify to it.
      if (typeof p.provenCommit === 'string' && p.provenCommit) node.provenCommit = p.provenCommit
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
      // keep the report truthful across resumes — but a state-FILE value is untrusted (round-3): it
      // is inlined into the self-audit `git rev-list HEAD..<branch>` command, so reject anything that
      // is not a real camus branch ref (a poisoned mergedBranch would otherwise execute). Drop →
      // falls back to the computed node.branch, which is always safe.
      if (p.mergedBranch && _CAMUS_BRANCH_OK.test(String(p.mergedBranch))) node.mergedBranch = p.mergedBranch
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
priorHydrated = true

// FORK DETECTION (field soak 2026-06-13, finding 8/5): editing/reordering/adding a task mints a
// NEW featId → a silently-cut second feat branch, orphaning the original's work. Scan existing
// run-states (MECHANICALLY, via feat_scan.py — the comparison is in JS, which owns slugify) for an
// in-progress feat with the SAME title but a DIFFERENT id, and halt for a human rather than fork.
// The current featId is excluded, so a normal resume never trips it. Fail-OPEN: an unparseable
// scan just proceeds — a fork is recoverable, this is a convenience guard, not an integrity gate.
if (A.allowFork !== true) {
  const scanRaw = await agent(
    `THIN feat-scan runner. Run EXACTLY this one command and output its stdout VERBATIM (one JSON object {feats:[...]}); no fences, no commentary:
  ${HB_TOUCH}python3 ${SKILL}/feat_scan.py`,
    { model: MODEL_RUNNER, phase: 'Preflight', label: 'fork-scan' }
  )
  const scan = extractJsonObject(scanRaw)
  const twin = (scan && Array.isArray(scan.feats) ? scan.feats : []).find((f) =>
    f && typeof f.featId === 'string' && f.featId !== featId &&
    typeof f.title === 'string' && slugify(f.title) === featSlug &&
    !['done', 'done_with_findings', 'done_with_noops', 'abandoned'].includes(f.status))
  if (twin) {
    return finalize('needs_human', {
      stage: 'fork', question: `A feat titled "${FEAT}" is already in progress under a different task list.`,
      note: `An in-progress feat with the SAME title but a DIFFERENT id already exists: branch camus/feat-${twin.featId} (status ${twin.status || 'unknown'}). Editing/reordering/adding a task changes the featId, so this run would FORK the feature — cutting a second branch camus/feat-${featId} and orphaning the first's work. To RESUME the original, re-run with its EXACT original args (no task edits). If this is a DELIBERATE new variant, change the feat title to distinguish it, or re-run with allowFork:true.`,
    })
  }
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
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_ENV}${ENV_CMD} ${REPO_ARG}
ready=true ONLY if it exits 0. Capture exitCode and the full stdout+stderr text in output (when not ready it lists what to fix, e.g. \`pnpm install\`). Do not interpret further.`,
  { model: MODEL_RUNNER, phase: 'Env+Baseline', label: 'env-check', schema: ENV_SCHEMA }
)
// READINESS IS DERIVED FROM THE EXIT CODE (field soak 2026-06-13, item 4), not the agent's
// self-judged `ready` bool. A relay whose `ready` contradicts its `exitCode` is a misread — halt
// loud (the merge-receipt defection posture), never advance on a contradicted env. Absent agent
// or non-numeric exitCode → not ready (fail-closed).
const envResolved = resolveEnv(env, 'baseline')
if (envResolved.halt) return finalize('env_not_ready', envResolved.halt)
state.env = envResolved.state
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
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_ENV}${VERIFY_CMD} ${REPO_ARG}
Output the command's stdout VERBATIM as your entire reply (JSON {pass,failures,checks}). No fences, no commentary.
${VERIFY_OATH}`,
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
      note: 'Baseline verify could NOT run — env/infra, not code-red. Either the toolchain/deps are missing (fix and re-run), or NO VERIFIER exists yet (a greenfield/empty repo): camus gates changes against YOUR tests, so bootstrap first — scaffold the project with one runnable test command (a plain Claude Code session is fine for step zero), commit it as the baseline, then run camus for every change after. A custom command also works: export CAMUS_VERIFY_CMD=\'<build && test>\'.',
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

// Parent-tree dirt BASELINE (re-soak 2026-06-14): containment.sh now reports UNTRACKED files too (an
// untracked leak breaks the merge). The baseline-verify just ran the verify command in the MAIN tree
// and may have left un-ignored artifacts — those are NOT a leak. Capture the dirt set here, once, so
// the boundary guard fires only on dirt that appears AFTER (delta), never on legit baseline artifacts.
const dirtLines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)
// RELAY-RECEIPT VALIDATION (PR2, 2026-06-29): same hardening as camus-loop's runContainment — the parent-
// tree receipt is echoed by a thin Haiku runner that can hallucinate a contract-violating object (`paths`
// as an ARRAY → dirtLines coerces a fake dirt line → a false "concurrent editor" breach on a clean tree).
// Validate against containment.sh's contract + retry; an unrecoverable receipt is {ran:false} ⇒
// inconclusive, never a verdict (the relay doctrine: cross-check the relay, never trust it as a source of truth).
const CONTAINMENT_TRIES = 3
// git porcelain "XY <path>" — two positional status columns then a space. Validate RAW lines (NOT trimmed):
// an unstaged edit is " M f" (X=space), so trimming first would reject a real receipt → false inconclusive.
const PORCELAIN_LINE = /^[ MADRCU?!][ MADRCU?!] ./
function validContainmentReceipt(r) {
  if (!r || typeof r !== 'object') return false
  if (r.ran === false) return true                                   // an explicit unobtained answer is valid → inconclusive
  if (r.ran !== true || typeof r.paths !== 'string' || typeof r.dirty !== 'boolean') return false
  const lines = String(r.paths).split('\n').filter((l) => l.length > 0)
  if (r.dirty !== (lines.length > 0)) return false                   // dirty must agree with paths
  return lines.every((l) => PORCELAIN_LINE.test(l))                  // every dirt line must be real git porcelain
}
async function featContainment(label) {
  let last = null
  for (let attempt = 1; attempt <= CONTAINMENT_TRIES; attempt++) {
    const raw = await agent(
      `THIN parent-tree containment runner. Run EXACTLY this one command and output its stdout VERBATIM as your entire reply (it is JSON — {ran,dirty,paths} or {ran,error}); no fences, no commentary:
  ${HB_TOUCH}${CONTAIN_CMD} ${REPO_ARG}`,
      { model: MODEL_RUNNER, phase: 'Tasks', label: `parent-tree:${label}` }
    )
    const r = extractJsonObject(raw)
    if (validContainmentReceipt(r)) return r
    last = r
    log(`Parent-tree containment receipt failed contract validation (parent-tree:${label}, attempt ${attempt}/${CONTAINMENT_TRIES}) — likely a hallucinated relay.`)
  }
  // Every retry produced a contract-violating receipt — treat as UNOBTAINED (inconclusive), never a verdict.
  return { ran: false, error: ('parent-tree containment receipt failed contract validation after ' + CONTAINMENT_TRIES + ' tries (likely a hallucinated relay); last=' + JSON.stringify(last)).slice(0, 280) }
}
const featDirtBaseline = await (async () => {
  const b = await featContainment('baseline')
  return new Set((b && b.ran === true) ? dirtLines(b.paths) : [])   // inconclusive → empty: a leak still fires
})()

// ── 5. TASKS — sequential; reuse camus-loop; merge on done; halt on first non-done ─
phase('Tasks')
// The branch tip certified by the LAST receipt-proven merge of THIS run — the integration
// verify is bound to it (head binding, design review 2026-06-12). Deliberately in-memory, never
// persisted: on a resume where no merges run, the feat branch may legitimately carry a HUMAN
// commit (e.g. a hand-reconciled integration fix) — binding across runs would false-alarm on
// exactly that; the integration report still NAMES the head it certified via verify's own
// `head` field.
let lastMergeHead = null
// THREE-outcome parent-tree containment (live re-soak 2026-06-14, finding B): containment.sh reads
// the MAIN checkout's `git status --porcelain` MECHANICALLY and emits {ran,dirty,paths}; the runner
// only echoes it. Returns null (ran && clean) | {kind:'breach', paths} | {kind:'inconclusive', why}.
async function parentTreeClean(label) {
  const r = await featContainment(label)
  if (!r || r.ran !== true) return { kind: 'inconclusive', why: (r && r.error) || 'containment runner returned no parseable {ran} receipt' }
  // DELTA vs the post-baseline-verify baseline: only dirt that appeared AFTER fires (re-soak 2026-06-14),
  // so an untracked leak / concurrent-editor change is caught while legit baseline artifacts are not.
  const newDirt = dirtLines(r.paths).filter((l) => !featDirtBaseline.has(l))
  if (newDirt.length) return { kind: 'breach', paths: newDirt.join('\n') }
  return null   // no NEW dirt vs the baseline → genuinely clean
}
for (let i = 0; i < state.tasks.length; i++) {
  const node = state.tasks[i]
  const n = `${i + 1}/${state.tasks.length}`
  if (node.status === 'done' || node.status === 'noop' || node.status === 'done_with_findings') { log(`Task ${n} "${node.taskId}" already ${node.status} (resume) — skipping.`); continue }

  // ── PARENT-TREE BOUNDARY GUARD (live re-soak 2026-06-14, finding B): before launching a task,
  // PROVE the main checkout is clean. The per-task work happens in an isolated worktree, so the
  // parent tree should carry ONLY Camus's own committed merges — never uncommitted edits. If it is
  // dirty here, a concurrent editor (typically the driver session) touched the repo Camus is mid-
  // feat on; running a task now would interleave that work with Camus's and corrupt the integration
  // picture. Catch it at the boundary — the clean, merged point — not later at integration. ran:false
  // is inconclusive (a budget-killed/errored runner or a non-git target), NOT a clean pass.
  const ptc = await parentTreeClean(node.taskId)
  if (ptc && ptc.kind === 'breach') {
    note(`Task ${n}: parent tree is DIRTY before launch — uncommitted changes Camus did not make. Halting.`)
    return finalize('needs_human', {
      stage: 'task_boundary', haltedTask: node.taskId, dirtyPaths: ptc.paths,
      question: `The main checkout has uncommitted changes Camus did not make (before task ${n}). A concurrent editor dirtied the parent tree — resolve it (commit/stash/discard), then re-run with the SAME args.`,
      note: `Parent-tree boundary check FAILED before task ${n}: the main checkout has uncommitted changes Camus did not author (Camus does per-task work in isolated worktrees; the parent tree should hold only Camus's committed merges). Most likely a concurrent editor — the driver session — touched the repo mid-feat. Camus halted rather than interleave that work with the task and corrupt integration. Clean the tree (commit/stash/discard the changes below), then re-run the feat with the SAME args; the resume skips done tasks.\nUncommitted paths:\n${ptc.paths || '(see git status)'}`,
    })
  }
  if (ptc && ptc.kind === 'inconclusive') {
    note(`Task ${n}: could not OBTAIN the parent-tree containment status (${ptc.why}) — halting inconclusive; nothing changed.`)
    return finalize('needs_human', {
      stage: 'task_boundary', haltedTask: node.taskId,
      question: `Camus could not read the parent-tree containment status before task ${n} (the check failed to run). Re-run the feat with the SAME args.`,
      note: `The parent-tree boundary check before task ${n} could not be OBTAINED (${ptc.why}) — this is NOT a breach and NOT a clean verdict, just an unverifiable check (a budget-killed/errored runner, or a non-git target). NOTHING changed. Re-run the feat with the SAME args to re-check.`,
    })
  }

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
  // Mechanical steer-read with a SENTINEL + RETRY + SHA-GATED CONSUME (field soak 2026-06-13 item 7;
  // read/consume SPLIT + retry, re-soak 2026-06-14 finding A; sha-gate, 2026-06-14 finding P2).
  // steer_read.py READS without consuming and emits {read,note,sha}; the sentinel tells "note state
  // obtained" (note null when absent) from "agent could not obtain it". Two failure modes are closed:
  //   (A) a transient relay flake on the READ is RETRIED safely (the read no longer consumes, so a
  //       re-read finds the same note — no loss), so ONE haiku hiccup no longer halts an unattended feat.
  //   (P2) a human can run `camus steer` BETWEEN the read and the consume; a blind delete would apply
  //       the OLD note and silently delete the NEW one. So consume is SHA-GATED (--expect-sha): it
  //       deletes ONLY the exact bytes we read. If the note changed under us, the newer note survives
  //       and we RE-READ + reprocess the current note (bounded), never applying a superseded one.
  // OPT-IN (descoped from 0.2.7): the steer file-IPC path runs ONLY when args.steer===true. A normal
  // run skips it entirely — no steer agent calls, no claim files, none of the read-then-act surface.
  let steer = {}
  if (STEER_ENABLED) {
  const STEER_READ_TRIES = 2     // retry a FLAKED read (no sentinel)
  const STEER_CHURN_TRIES = 3    // re-read when the note changed between read and consume
  let steerNoteRaw = null        // the (final) raw note text we actually CONSUMED + apply, if any
  for (let churn = 0; ; churn++) {
    let steerOuter = null
    for (let attempt = 1; attempt <= STEER_READ_TRIES && (!steerOuter || steerOuter.read !== true); attempt++) {
      const steerRaw = await agent(
        `THIN steer-check runner. Run EXACTLY this one command and output its stdout VERBATIM (one JSON object {read,note,sha}); no fences, no commentary:
  ${HB_TOUCH}python3 ${SKILL}/steer_read.py ${JSON.stringify(featId)}`,
        { model: MODEL_RUNNER, phase: 'Tasks', label: `steer:${node.taskId}${churn > 0 ? `:reread${churn}` : ''}${attempt > 1 ? `:retry${attempt - 1}` : ''}` }
      )
      steerOuter = extractJsonObject(steerRaw)
    }
    if (!steerOuter || steerOuter.read !== true) {
      // STILL no sentinel after retries → a persistent failure to obtain the steer state. This is NOT
      // a bad note — the read-only check never consumed anything, so a re-run re-reads any note intact.
      // A read:false carries a reason (e.g. a stranded claim from a crashed consume) — surface it.
      const why = (steerOuter && steerOuter.error) ? ` — ${steerOuter.error}` : ''
      note(`Task ${n}: could not READ the steer-note state after ${STEER_READ_TRIES} tries — halting inconclusive; nothing consumed.${why}`)
      return finalize('needs_human', {
        stage: 'steer', haltedTask: node.taskId,
        question: `Camus could not read the steer-note state before task ${n} (the check failed to run, ${STEER_READ_TRIES}×)${why}. Resolve it, then re-run the feat with the SAME args.`,
        note: `The steer-note check before task ${n} could not be OBTAINED after ${STEER_READ_TRIES} tries${why} — this is NOT a bad note, and NOTHING was consumed or applied. Resolve any reported issue (e.g. a stranded \`.consuming\` claim from a crashed run, or \`camus steer --clear\`), then re-run the feat with the SAME args; any pending \`camus steer\` note is intact.`,
      })
    }
    if (steerOuter.note == null) { steerNoteRaw = null; break }   // clean no-note → proceed
    const candidate = steerOuter.note
    // SHA-GATED CONSUME: delete ONLY the exact bytes we just read.
    const consRaw = await agent(
      `THIN steer-consume runner. Run EXACTLY this one command and output its stdout VERBATIM ({consumed,...}); no fences, no commentary:
  ${HB_TOUCH}python3 ${SKILL}/steer_read.py ${JSON.stringify(featId)} --consume --expect-sha ${shq(String(steerOuter.sha || ''))}`,
      { model: MODEL_RUNNER, phase: 'Tasks', label: `steer-consume:${node.taskId}${churn > 0 ? `:reread${churn}` : ''}` }
    )
    const cons = extractJsonObject(consRaw)
    if (cons && cons.consumed === true) {
      // We atomically deleted EXACTLY the bytes we read → safe to apply (a note applies once).
      steerNoteRaw = candidate
      break
    }
    // NOT confirmed-consumed. The note either CHANGED (human re-steered → reason:'changed'), was
    // CLEARED (human retracted → reason:'absent'; a clear is a newer human action, so treat it as
    // changed-to-null), or the consume could not be CONFIRMED (error / garbled relay). The consume is
    // sha-gated + crash-safe, so in none of these could it have clobbered a newer note. In ALL cases
    // we must NOT apply the bytes we read — RE-READ and act only on what is CURRENTLY pending: a clear
    // re-reads to null (no-note, proceed); a new note re-reads to that note. Bounded, then halt.
    if (churn < STEER_CHURN_TRIES) {
      note(`Task ${n}: steer note not confirmed-consumed (${(cons && (cons.reason || cons.error)) || 'no receipt'}) — re-reading the current note.`)
      continue
    }
    note(`Task ${n}: could not consume the steer note after ${STEER_CHURN_TRIES} re-reads — halting; nothing applied.`)
    return finalize('needs_human', {
      stage: 'steer', haltedTask: node.taskId,
      question: `Camus could not consume the steer note before task ${n} (it kept changing, or the consume could not be confirmed) — settle it (finish editing, or \`camus steer --clear\`), then re-run with the SAME args.`,
      note: `The steer note before task ${n} could not be consumed after ${STEER_CHURN_TRIES} re-reads — NOTHING was applied. Either it was being edited repeatedly or the consume could not be confirmed (so applying the bytes Camus first read would risk running past your latest intent). Settle it — finish editing, or \`camus steer --clear --feat ${featId}\` — then re-run the feat with the SAME args.`,
    })
  }
  const steerParsed = (typeof steerNoteRaw === 'string') ? extractJsonObject(steerNoteRaw) : null
  // A note FILE existed but its content is not parseable JSON — a real human note we can't read
  // (consume already cleared it, so the re-run won't re-halt on the same file). Halt for a re-issue.
  if (typeof steerNoteRaw === 'string' && steerParsed == null) {
    note(`Task ${n}: a steer note was PRESENT but UNPARSEABLE — consumed; NOTHING was applied.`)
    return finalize('needs_human', {
      stage: 'steer', haltedTask: node.taskId,
      question: `A steer note before task ${n} was unparseable and was consumed UNAPPLIED — re-issue your guidance, then re-run.`,
      note: `A steer note was present but could not be parsed before task ${n} — it was consumed and NOTHING was applied. Halting rather than running past your guidance. Re-issue it (\`camus steer ...\`) and re-run the feat with the SAME args to resume from here.`,
    })
  }
  steer = steerParsed || {}
  }  // end if (STEER_ENABLED)
  if (steer.pause === true) {
    // RE-QUEUE the rest of the note before halting (audit P1 2026-06-11): steer merges compose
    // pause+answers into ONE note, but the sha-gated consume above already DELETED the exact note we
    // applied — halting here would silently drop the answers/guidance riding alongside the pause. So
    // write the remainder (minus
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
      ...(VERIFY_CMD_OVERRIDE ? { verifyCmd: VERIFY_CMD_OVERRIDE } : {}),   // headless verify override (finding 3)
      // PROVEN accept decision → land; unproven → full loop. expectHead anchors the land's
      // verify to the sha the original proof certified (publish audit round-2): an empty-stage
      // land on a tip that moved past the proof fails CLOSED instead of being believed.
      ...(landAuthorized ? { land: true, ...(typeof node.provenCommit === 'string' && node.provenCommit ? { expectHead: node.provenCommit } : {}) } : {}),
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
    const unmergedText = String(unmergedRaw == null ? '' : unmergedRaw).trim()
    const unmerged = /^\d+$/.test(unmergedText) ? parseInt(unmergedText, 10) : null
    if (Number.isInteger(unmerged) && unmerged > 0) {
      note(`⚠ Task ${n}: loop said no_changes BUT ${node.branch} holds ${unmerged} unmerged commit(s) — a prior run's proven work. Re-entering as AUTO-LAND, not a no-op.`)
      node.status = 'ready_to_merge'
      PROVEN_READY.add(node.taskId)
      await persistState('Tasks')
      i--   // re-enter THIS task: the landResume lane picks it up immediately
      continue
    }
    if (unmerged === null) {
      node.status = 'failed'
      await persistState('Tasks')
      note(`Task ${n}: no_changes could not be disambiguated — branch ancestry audit returned no usable count, so refusing to record a no-op.`)
      return finalize('infra_error', {
        stage: 'noop_audit', haltedTask: node.taskId,
        noopAuditOutput: unmergedText.slice(0, 1000),
        note: `The loop returned no_changes, but Camus could not verify whether ${node.branch} still holds unmerged commits (noop-audit output was not a non-negative integer). Missing ancestry evidence must not become a no-op. Fix the git/audit issue and re-run the feat with the SAME args.`,
      })
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
    // A failed LAND attempt must not destroy the PROOF (live smoke run-4, 2026-06-12): an
    // aborted/infra land means the MECHANICAL step failed — the proven commits on the branch
    // didn't change. Downgrading to `failed` here erased ready_to_merge, so the next resume
    // re-looped into a branch collision instead of retrying the (fixable) land. Keep the lane.
    // Extended (resume audit 2026-06-29): a land whose RE-VERIFY goes red/inconclusive (both landed:true,
    // camus-loop:425/433) must ALSO keep the ready_to_merge lane, not collapse to `failed`. `failed` matches
    // NO resume carry lane (:573/:585/:596) → the next resume reverts the node to pending and re-enters the
    // FULL loop, colliding on the existing branch and re-halting forever with a note that (falsely) promises
    // the lanes will land it. The auto-land RE-VERIFIES before merging, so a persistent red can never false-
    // merge — it stays recoverable (retried each resume; `camus land <taskId>` is the manual escape), a
    // strict improvement over the wedge. A land result never parks, so provenCommit (:1160) is untouched.
    const landReVerifyFail = res && res.landed === true && (res.status === 'verify_failed' || res.status === 'verify_inconclusive')
    const landAbort = landAuthorized && res && (res.status === 'aborted' || res.status === 'infra_error' || landReVerifyFail)
    node.status = verifyCleanHalt ? 'needs_decision' : (landAbort ? 'ready_to_merge' : 'failed')
    // PARKED PROOF's sha rides the halt persist (publish audit round-3, 2026-06-12): the accept
    // lane (needs_decision → human accepts → land) and the `camus land --proven` lane (failed →
    // ready_to_merge) both end in a land whose verify must bind to the PARK, not the live tip —
    // without this stash, a task branch moved past the parked proof was believed and merged.
    // Same ownership rule as provenStatus: a land result never parks (res.parkedSha absent), so
    // a landAbort can never clobber the hydrated anchor.
    if (res && !res.landed && typeof res.parkedSha === 'string' && res.parkedSha) node.provenCommit = res.parkedSha
    await persistState('Tasks')
    note(verifyCleanHalt
      ? `⚠ Task ${n} did not converge in review, BUT deterministic verify PASSES — a decision (accept vs refine), not a failure.`
      : (landAbort
        ? `⚠ Task ${n}: the LAND attempt did not complete (${node.loopStatus}) — the task stays ready_to_merge (the proven commits on its branch are untouched). Fix the cause (a mechanical abort, or a flaky/env-drift verify) and re-run to retry the land, or run \`camus land ${node.taskId}\`.`
        : `Task ${n} HALTED the feat — loop returned "${node.loopStatus}".`))
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
  if (!res.landed) {
    node.provenStatus = res.status
    // PROVEN COMMIT (publish audit round-2, 2026-06-12): the sha this proof certifies. The
    // auto-land binds its verify to it (loop args.expectHead) — without the anchor, an
    // empty-stage land believes whatever tip the task branch carries, even one that moved
    // past the proof. Same ownership rule as provenStatus: a mechanical land never writes it.
    const proofSha = (typeof res.commit_sha === 'string' && res.commit_sha) ? res.commit_sha
      : ((typeof res.parkedSha === 'string' && res.parkedSha) ? res.parkedSha : null)
    if (proofSha) node.provenCommit = proofSha
  }
  if (res.status === 'done_with_findings') {
    node.findingsDeferred = res.findingsDeferred || (Array.isArray(res.findings) ? res.findings.length : 0)
    if (Array.isArray(res.findings)) node.deferredFindings = res.findings
  }
  if (Array.isArray(res.decisions) && res.decisions.length) node.decisions = res.decisions
  await persistState('Tasks')

  // Merge the loop's reported branch (cross-check against our deterministic one).
  let mergeBranch = res.branch || node.branch
  if (res.branch && res.branch !== node.branch) {
    log(`WARN: loop branch "${res.branch}" != expected "${node.branch}" — merging the loop's reported branch.`)
  }
  // res.branch is a RELAYED value (the loop's report) — validate it before it is inlined into ANY
  // shell command (verification audit round-4, 2026-06-13): round 2 shq'd it for merge.sh and round 3
  // allowlisted the resume-LOADED mergedBranch, but the LIVE assignment node.mergedBranch=mergeBranch
  // (below) stores it raw, and the self-audit later inlines `git rev-list HEAD..<mergedBranch>`. The
  // doctrine: never trust the relay "always returns the computed BRANCH". A non-camus ref is garbage
  // → fall back to the computed node.branch (always safe); a valid different ref keeps the tolerance.
  if (!_CAMUS_BRANCH_OK.test(String(mergeBranch))) {
    log(`WARN: merge branch "${mergeBranch}" is not a valid camus ref — using the computed ${node.branch} instead (never inlining an unvalidated branch into a command).`)
    mergeBranch = node.branch
  }
  // The merge CONTRACT is computed by merge.sh, never reported by an agent (live smoke run-5,
  // 2026-06-12): the script owns checkout/merge/abort-on-any-failure with the hookless+unsigned
  // flags INSIDE an allowlisted script — agent-typed `git -c core.hooksPath=…` is denied by the
  // auto-mode classifier as a guardrail bypass — and emits every contract field by construction.
  // The thin runner only transcribes; the schema and the consistency checks below stay as the
  // belt against mis-transcription.
  let mg = await agent(
    `THIN merge runner. cd ${REPO_ARG}. Run EXACTLY this one command (it performs the merge and prints ONE JSON object):
  ${HB_TOUCH}${MERGE_CMD} ${JSON.stringify(featBranch)} ${shq(mergeBranch)} ${JSON.stringify('camus(feat): merge ' + node.taskId)}
Return the printed JSON's fields EXACTLY as the script computed them — every field verbatim, no re-judging, no omissions.
If the JSON says merged:false (e.g. a conflict), that IS the verdict — return it AS-IS and STOP.
Do NOT resolve conflicts, do NOT run git merge/add/commit yourself, do NOT edit files: the script
already left the repo safely aborted, and your report is cross-checked against the script's own
receipt file — any divergence halts the whole feat as a contract violation.`,
    { model: MODEL_RUNNER, phase: 'Tasks', label: `merge:${node.taskId}`, schema: MERGE_SCHEMA }
  )
  // RECEIPT CROSS-CHECK (live smoke run-6 + design review, 2026-06-12). "Thin runner" cannot
  // mean "trusted to only run the script" — run-6's merge runner defected COHERENTLY: merge.sh
  // correctly reported a conflict, the runner hand-resolved it, committed under the normal merge
  // message, and relayed a contract-complete success. Ancestry can't catch that (the postflight
  // self-audit passed — a hand-merge satisfies rev-list like any merge). So the script leaves
  // PROOF and the orchestrator verifies it mechanically:
  //   1. merge.sh writes its verdict JSON to a receipt file at the single emission point; a
  //      stakeless reader echoes it back. The receipt — not the relay — is the source of truth.
  //   2. The receipt is checked against the REPO, not just the relay: if merge.sh said conflict
  //      but the live branch HEAD moved off the receipt's `before` (or, on success, off `after`),
  //      a runner mutated git off-script even though its relay was honest — invisible to the
  //      relay compare, and the lane that also closes the stale-receipt gap (an old receipt's
  //      SHAs can't match the live branch).
  //   3. Relay≠receipt is a defection, never a verdict.
  // Fail-closed throughout: a MISSING receipt halts (merge.sh never ran, or its receipt write
  // failed — stdout's receiptError says which), and an unreadable live HEAD halts too. This runs
  // BEFORE the merged:false lane so an honest-conflict relay still gets its repo-state check.
  // RECEIPT CROSS-CHECK + NULL-RELAY RECOVERY (run-6 + audit item 2, 2026-06-13). Read merge.sh's
  // receipt UNCONDITIONALLY — the script's proof outlives a lost relay. With a relay present the
  // receipt is the DEFECTION guard (relay≠receipt ⇒ halt). With a NULL relay (budget / API socket
  // drop mid-call) the receipt — cross-checked against the live repo HEAD — IS the verdict:
  // merge.sh is atomic and idempotent, so a dropped relay must NOT be stamped a definitive
  // merge_failed when the merge actually succeeded and left its receipt (the bug this fixes).
  const rcptRaw = await agent(
    `THIN receipt reader. Run EXACTLY this one command and output its stdout VERBATIM (one JSON object, or the word MISSING); no fences, no commentary:
  cat "\${CAMUS_MERGE_DIR:-$HOME/.camus/merges}/${node.taskId}.json" 2>/dev/null || echo MISSING`,
    { model: MODEL_RUNNER, phase: 'Tasks', label: `merge-receipt:${node.taskId}` }
  )
  const rcpt = extractJsonObject(rcptRaw)
  let liveHead = null
  let stateViolation = null
  let rcptDiff = []
  if (rcpt) {
    const liveRaw = await agent(
      `THIN git runner. cd ${REPO_ARG}. Run EXACTLY this one command and output ONLY its stdout (one commit SHA), no commentary:
  git rev-parse ${JSON.stringify(featBranch)}`,
      { model: MODEL_RUNNER, phase: 'Tasks', label: `merge-head:${node.taskId}` }
    )
    // Comparison value only (never a command arg) — screen out error lines, keep any
    // single-token SHA shape.
    const lh = String(liveRaw || '').trim()
    liveHead = /^[0-9a-z._-]{1,64}$/i.test(lh) ? lh : null
    const expectLive = rcpt.merged === true ? rcpt.after : rcpt.before
    stateViolation = !liveHead
      ? 'the live feat-branch HEAD could not be read to confirm the receipt'
      : (typeof expectLive === 'string' && expectLive && liveHead !== expectLive)
        ? `the live feat branch is at ${liveHead} but merge.sh's receipt says ${rcpt.merged === true ? `the merge ended at ${rcpt.after}` : `the aborted merge left ${rcpt.before}`} — the repo moved OFF-SCRIPT after the script's verdict`
        : null
    // relay-vs-receipt diff ONLY when a relay exists to compare (a null relay has nothing to diff).
    // priorMergeCommit included (publish audit P1): it is VERDICT-BEARING — the crash-after-merge
    // evidence path trusts it to upgrade already-up-to-date into done; uncompared, a relay flipping
    // null → a fabricated sha turns a true no-op into done while matching every other field.
    rcptDiff = mg ? ['merged', 'committed', 'before', 'after', 'alreadyUpToDate', 'priorMergeCommit'].filter((k) => rcpt[k] !== undefined && rcpt[k] !== mg[k]) : []
  }
  // CASE: neither a relay NOR a receipt — Camus cannot tell whether the merge ran. INCONCLUSIVE,
  // NEVER a definitive merge_failed: merge.sh is idempotent, so a re-run retries/confirms it.
  if (!mg && !rcpt) {
    node.status = 'ready_to_merge'
    await persistState('Tasks')
    note(`Task ${n}: merge relay LOST and merge.sh left NO receipt — inconclusive, not a failure. Re-run to retry.`)
    return finalize('feat_integration_failed', {
      stage: 'merge_receipt', haltedTask: node.taskId,
      note: `The merge runner for ${node.taskId} returned nothing AND no merge.sh receipt exists — Camus cannot tell whether the merge ran, so it will NOT stamp a definitive failure. merge.sh is atomic and idempotent: the task stays ready_to_merge; re-run the feat with the SAME args to retry/confirm the merge. (If this recurs, inspect \`git log -3 ${featBranch}\` and ~/.camus/merges/${node.taskId}.json.)`,
    })
  }
  // DEFECTION / INTEGRITY halt: a present relay with NO receipt, OR the repo moved off the
  // receipt, OR the relay disagrees with the receipt. (A null relay with a clean receipt skips
  // this — it is governed only by stateViolation, which is included here.)
  if ((mg && !rcpt) || stateViolation || rcptDiff.length) {
    node.status = 'ready_to_merge'   // the proven work stands; the MERGE is what's unresolved
    await persistState('Tasks')
    // Only a receipt-sourced SHA may be offered as a reset target — mg.* is the very report
    // that just failed the cross-check.
    const resetTo = rcpt && typeof (rcpt.merged === true ? rcpt.after : rcpt.before) === 'string' && (rcpt.merged === true ? rcpt.after : rcpt.before).trim()
      ? (rcpt.merged === true ? rcpt.after : rcpt.before) : null
    const what = !rcpt ? 'MISSING receipt' : (stateViolation ? 'REPO STATE off the receipt' : `RELAY MISMATCH (${rcptDiff.join(', ')})`)
    note(`Task ${n}: MERGE INTEGRITY — ${what}. The runner's report is not merge.sh's proven verdict; refusing it and halting.`)
    return finalize('feat_integration_failed', {
      stage: 'merge_receipt', haltedTask: node.taskId,
      note: `Merge integrity check for ${node.taskId} failed: ${!rcpt ? 'NO receipt from merge.sh (the script may never have run, or its receipt write failed — the runner transcript\'s receiptError says which)' : (stateViolation || `the runner's relay DISAGREES with merge.sh's own receipt on: ${rcptDiff.join(', ')}`)} — a defecting runner may have mutated the repo by hand. Inspect \`git log -3 ${featBranch}\`${resetTo ? `; if an unauthorized commit sits on top, \`git reset --hard ${resetTo}\` restores the receipt's proven HEAD` : ''}. Then re-run the feat with the SAME args — the task is still ready_to_merge and the merge retries idempotently.`,
    })
  }
  // The receipt is proven (against the repo, and against the relay when present) — bind the
  // integration head to the certified branch tip (head binding; see the integration phase).
  if (rcpt && typeof rcpt.after === 'string' && rcpt.after) lastMergeHead = rcpt.after
  // NULL-RELAY RECOVERY: the relay dropped mid-call but the receipt is proven — adopt it as the
  // verdict so the downstream merge logic (didCommit / priorMerge / finalStatus) works unchanged.
  if (!mg && rcpt) {
    mg = rcpt
    log(`Task ${n}: merge relay was lost mid-call, but merge.sh's receipt — cross-checked against the live HEAD ${liveHead} — proves the merge; adopting the receipt as the verdict.`)
  }
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
// self_audit_failed, never done; missing/ERROR evidence is infra, also never done. The count
// lines are the proof, and a green report without that proof is another false-green.
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
      note: `The postflight self-audit found ${violations.length} completed task(s) whose branch holds commits NOT merged into ${featBranch}: ${violations.map((v) => `${v.taskId} (${v.status}, ${v.unmergedCommits} commit(s) on ${v.branch})`).join('; ')}. The feat must NOT read done. For each: if the work is proven (a prior run reviewed+verified it), run \`camus land <taskId>\` and re-run — the auto-land lane merges it; otherwise re-run the task through the full loop after clearing the branch.`,
    })
  }
  if (unreadable.length) {
    note(`✗ SELF-AUDIT INCONCLUSIVE: could not read ${unreadable.length} completed task branch(es) — ancestry NOT verified, refusing to report done.`)
    return finalize('infra_error', {
      stage: 'self_audit', unreadableBranches: unreadable,
      selfAuditOutput: String(auditRaw == null ? '' : auditRaw).slice(0, 2000),
      note: `The postflight self-audit could not verify ancestry for ${unreadable.length} completed task branch(es): ${unreadable.join(', ')}. Missing ancestry evidence must not become a green feat. Fix the git/audit issue and re-run with the SAME args; done tasks skip and the self-audit retries before integration.`,
    })
  }
  else log('Self-audit clean: every completed task branch is fully merged into feat history.')
}

// ── 6. ENV RE-CHECK (tasks may have added deps) + FINAL INTEGRATION VERIFY ─────
phase('Integration')
const env2 = await agent(
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_ENV}${ENV_CMD} ${REPO_ARG}
ready=true ONLY if it exits 0. Capture exitCode and full stdout+stderr in output.`,
  { model: MODEL_RUNNER, phase: 'Integration', label: 'env-recheck', schema: ENV_SCHEMA }
)
// readiness derived from exitCode + contradiction-halt (field soak 2026-06-13, item 4) — same as baseline
const env2Resolved = resolveEnv(env2, 'integration')
if (env2Resolved.halt) return finalize('env_not_ready', env2Resolved.halt)
state.envRecheck = env2Resolved.state
if (!state.envRecheck.ready) {
  return finalize('env_not_ready', {
    stage: 'integration_env',
    note: 'Environment not ready on the merged feat branch (a task may have added deps). Fix env (e.g. install) and re-run.',
    fix: state.envRecheck.output,
  })
}
const intRaw = await agent(
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${HB_TOUCH}${VERIFY_ENV}${VERIFY_CMD} ${REPO_ARG}
Output the command's stdout VERBATIM (JSON {pass,failures,checks}). No fences, no commentary.
${VERIFY_OATH}`,
  { model: MODEL_RUNNER, phase: 'Integration', label: 'integration-verify' }
)
const intV = asVerify(intRaw)
state.integration = intV
// HEAD BINDING (design review 2026-06-12): a green must prove exactly what state it certified.
// verify.py names the HEAD it ran against; when merges ran THIS run, a GREEN must name the last
// receipt-proven branch tip — a different head means the branch moved between the proven merge
// and the verify (an off-script mutation, or a verifier certifying the wrong tree), and a green
// with NO head at all is fail-CLOSED (publish audit P2: accepting an unnamed green re-opens the
// run-6 hole — a fabricated {pass:true} relay simply omits the field). A no-merge resume has no
// in-run expectation (a human commit on the feat branch is legitimate there), and RED verdicts
// pass through un-bound: binding gates what may be BELIEVED, not what may be reported.
if (lastMergeHead && intV.pass === true) {
  const certified = (typeof intV.head === 'string' && intV.head) ? intV.head : null
  if (certified !== lastMergeHead) {
    return finalize('feat_integration_failed', {
      stage: 'integration_integrity',
      note: `Integration verify ${certified ? `certified HEAD ${certified}` : 'reported GREEN without naming the HEAD it certified'}, but the last receipt-proven merge left ${featBranch} at ${lastMergeHead} — ${certified ? 'the branch moved between the merge and the verify, so' : 'an unnamed green proves nothing about the merged state, so'} this verdict is refused. Inspect \`git log -3 ${featBranch}\`; if an unauthorized commit sits on top, \`git reset --hard ${lastMergeHead}\` restores the proven tip, then re-run the feat with the SAME args.`,
    })
  }
}
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
