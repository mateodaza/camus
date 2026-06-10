export const meta = {
  name: 'camus-feat',
  description: 'Run an ordered task list as ONE feature through the Camus M1 gate: preflight → feat branch → env+baseline → per-task v2-lite loop (merge on done) → env re-check + integration verify → report. Linear only (no DAG/parallel/bisection).',
  whenToUse: 'Drive a small ordered feat (2–3 tasks in M1) through v2-overnight M1. args = { feat: "<title>", tasks: ["task 1", "task 2", ...], targetPath?, policy?, answers? }. policy ∈ autonomous|ask_on_ambiguity(default)|ask_on_major controls when a task PAUSES for a human (status needs_human); on a resume after a pause, answers={ "<taskId>": "..." } threads the decision back in. Reuses camus-loop per task with feat-scoped branch identity. Launch FROM the target repo (cwd = repo root). Run `install.sh --check` yourself first — gate-freshness is a human step.',
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
if (!FEAT) throw new Error('camus-feat: missing feat title (args.feat)')
if (!TASKS.length) throw new Error('camus-feat: args.tasks[] is empty')
// All feat-level git/env/verify run in the repo root (workflow cwd = $PWD).
// `targetPath` is a CODE-SCOPE HINT only: it is forwarded to camus-loop per task,
// but must never become the feat runner's cd/verify target. Baseline/integration
// guards require the repo root on a camus/feat-* branch; passing a relative subdir
// would both double-resolve the path after `cd` and fail the guard.
const REPO_ARG = '"$PWD"'

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
  ...(Object.keys(ANSWERS).length ? { answers: ANSWERS } : {}),
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
  required: ['merged'],
  properties: {
    merged: { type: 'boolean', description: 'git exited 0 with NO conflict (includes the already-up-to-date case)' },
    committed: { type: 'boolean', description: 'a NEW merge commit was actually created (HEAD moved)' },
    alreadyUpToDate: { type: 'boolean', description: 'git printed "Already up to date." — the task branch added nothing' },
    before: { type: 'string', description: 'HEAD SHA before the merge' },
    after: { type: 'string', description: 'HEAD SHA after the merge' },
    conflict: { type: 'boolean' },
    error: { type: 'string', description: 'conflicting files / git error when merged=false' },
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

async function finalize(status, extra = {}) {
  state.status = status
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
      ...(t.question ? { question: t.question, clarity: t.clarity || '' } : {}),
    })),
    // Feat-level rollup of every decision the loop logged across tasks — the human's merge-time
    // audit trail ("what did the agent decide that I should sanity-check before merging?").
    decisions: state.tasks.flatMap((t) => (t.decisions || []).map((d) => ({ taskId: t.taskId, ...d }))),
    merged: state.tasks.filter((t) => t.status === 'done').map((t) => t.branch),
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
1. \`git rev-parse --abbrev-ref HEAD\`  -> base (the current branch name)
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
    if (p && (p.status === 'done' || p.status === 'noop')) {
      node.status = p.status
      if (p.status === 'noop') node.noop = true
      if (Array.isArray(p.decisions)) node.decisions = p.decisions
      if (p.loopStatus) node.loopStatus = p.loopStatus
      carried++
    }
  }
  if (carried) log(`Resume: ${carried} task(s) already done/noop in ${STATE_PATH} — will skip.`)
}

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
log(`Feat branch ${featBranch} ${fb.created ? 'created' : 'checked out (resume)'} from base ${state.base}.`)

// ── 3. ENV CHECK on the feat branch (fresh trees lack node_modules — mandatory) ─
phase('Env+Baseline')
const env = await agent(
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${ENV_CMD} ${REPO_ARG}
ready=true ONLY if it exits 0. Capture exitCode and the full stdout+stderr text in output (when not ready it lists what to fix, e.g. \`pnpm install\`). Do not interpret further.`,
  { model: MODEL_RUNNER, phase: 'Env+Baseline', label: 'env-check', schema: ENV_SCHEMA }
)
state.env = env ? { ready: !!env.ready, exitCode: env.exitCode, output: env.output, when: 'baseline' }
                : { ready: false, exitCode: -1, output: 'env agent returned nothing', when: 'baseline' }
if (!state.env.ready) {
  return finalize('env_not_ready', {
    stage: 'baseline_env',
    note: 'Environment not ready on the feat branch — fix the issues below (e.g. run the project install), then re-run.',
    fix: state.env.output,
  })
}

// ── 4. BASELINE VERIFY — base must be green before any task ───────────────────
const baseRaw = await agent(
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${VERIFY_CMD} ${REPO_ARG}
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
log(`Baseline green on ${featBranch}. Running ${state.tasks.length} task(s) strictly in order.`)

// ── 5. TASKS — sequential; reuse camus-loop; merge on done; halt on first non-done ─
phase('Tasks')
for (let i = 0; i < state.tasks.length; i++) {
  const node = state.tasks[i]
  const n = `${i + 1}/${state.tasks.length}`
  if (node.status === 'done' || node.status === 'noop') { log(`Task ${n} "${node.taskId}" already ${node.status} (resume) — skipping.`); continue }

  node.status = 'running'
  log(`Task ${n}: ${node.spec}  →  loop (branch ${node.branch}).`)

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
      ...(ANSWERS[node.taskId] ? { humanAnswer: String(ANSWERS[node.taskId]) } : {}),  // resume answer
      ...(TARGET ? { targetPath: TARGET } : {}),
    })
  } catch (e) {
    res = { status: 'infra_error', error: String((e && e.message) || e) }
  }
  node.loopStatus = (res && res.status) || 'unknown'

  if (res && res.status === 'no_changes') {
    // The loop committed nothing (empty implement, or the change was already present). Not a
    // failure — flag as a NO-OP and CONTINUE (don't merge an empty branch, don't halt the feat).
    node.status = 'noop'
    node.noop = true
    await persistState('Tasks')
    log(`Task ${n}: loop returned no_changes (nothing to commit) → recorded as NO-OP, continuing.`)
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
    log(`Task ${n}: loop PAUSED for a human decision (clarity=${res.clarity}). Halting feat to ask.`)
    return finalize('needs_human', {
      stage: 'task', haltedTask: node.taskId,
      question: res.question || '', clarity: res.clarity || '',
      interpretations: res.interpretations || [], plan: res.plan || '',
      resumeWith: { answers: { [node.taskId]: '<your answer here>' } },
      note: `Task ${n} needs a human decision before it can proceed (policy ${POLICY}). Answer the question, then re-run the feat with answers:{"${node.taskId}":"<your answer>"}. Tasks merged before this remain on ${featBranch}; this task resumes with your answer threaded in.`,
    })
  }

  if (!res || res.status !== 'done') {
    // Any non-done (review_unresolved / verify_failed / verify_inconclusive / infra_error /
    // aborted) -> mark failed and HALT. M1 never builds later tasks on top of a failed one.
    node.status = 'failed'
    await persistState('Tasks')
    log(`Task ${n} HALTED the feat — loop returned "${node.loopStatus}".`)
    return finalize('halted', {
      stage: 'task', haltedTask: node.taskId, haltReason: node.loopStatus, loopResult: res || null,
      note: `Task ${n} did not reach "done" (${node.loopStatus}). Per M1, later tasks are NOT run on top of a failed one. Tasks merged before this remain on ${featBranch}.`,
    })
  }

  // Merge the loop's reported branch (cross-check against our deterministic one).
  const mergeBranch = res.branch || node.branch
  if (res.branch && res.branch !== node.branch) {
    log(`WARN: loop branch "${res.branch}" != expected "${node.branch}" — merging the loop's reported branch.`)
  }
  const mg = await agent(
    `THIN git merge runner. cd ${REPO_ARG}. Merge the completed task branch into the feat branch. Run EXACTLY, in order, and report what git actually did:
1. \`git checkout ${JSON.stringify(featBranch)}\`
2. \`git rev-parse HEAD\`  -> record as before
3. \`git merge --no-ff ${JSON.stringify(mergeBranch)} -m ${JSON.stringify('camus(feat): merge ' + node.taskId)}\`
4. \`git rev-parse HEAD\`  -> record as after
Report:
- merged: true if git exited 0 with NO conflict (this INCLUDES the "Already up to date." case).
- committed: true ONLY if after != before (a NEW merge commit was really created). false if git printed "Already up to date." or HEAD did not move.
- alreadyUpToDate: true if git printed "Already up to date." (the task branch contributed nothing).
- before, after: the two HEAD SHAs.
On a CONFLICT: run \`git merge --abort\`, set merged=false, conflict=true, put the conflicting files in error. Never touch the base branch (${JSON.stringify(state.base)}).
Return {merged, committed, alreadyUpToDate, before, after, conflict, error}.`,
    { model: MODEL_RUNNER, phase: 'Tasks', label: `merge:${node.taskId}`, schema: MERGE_SCHEMA }
  )
  if (!mg || !mg.merged) {
    node.status = 'merge_failed'
    await persistState('Tasks')
    return finalize('feat_integration_failed', {
      stage: 'merge', haltedTask: node.taskId,
      note: `Merging task ${node.taskId} into ${featBranch} failed (${(mg && mg.error) || 'unknown'}). Halting; earlier merges remain.`,
    })
  }
  // FALSE-POSITIVE GUARD: the loop returned "done" but the merge added NO commit — the task
  // contributed nothing to the feat branch (scope overlap with an earlier task, or an empty
  // implement). Record it as a NO-OP, not a real merge, so the feat can never claim a plain
  // "done" while a task actually did nothing. This guard only ever DOWNGRADES the outcome
  // (done → done_with_noops); it can never turn a red feat green.
  const didCommit = mg.committed === true && mg.alreadyUpToDate !== true && (!mg.before || !mg.after || mg.before !== mg.after)
  if (!didCommit) {
    node.status = 'noop'
    node.noop = true
    await persistState('Tasks')
    log(`Task ${n}: loop said "done" but the merge added NO commit (already-up-to-date) → recorded as NO-OP, not a merge.`)
    continue
  }
  node.status = 'done'
  node.decisions = Array.isArray(res.decisions) ? res.decisions : []   // audit trail for merge review
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
  ].filter(Boolean)
  log(`Task ${n} done → merged ${mergeBranch} into ${featBranch} (commit ${mg.after ? String(mg.after).slice(0, 8) : '?'})${tele.length ? ` (${tele.join(' · ')})` : ''}${node.decisions.length ? ` · ${node.decisions.length} decision(s) logged` : ''}.`)
}

// ── 6. ENV RE-CHECK (tasks may have added deps) + FINAL INTEGRATION VERIFY ─────
phase('Integration')
const env2 = await agent(
  `THIN env doctor. cd ${REPO_ARG}, then run EXACTLY:  ${ENV_CMD} ${REPO_ARG}
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
  `THIN verifier. cd ${REPO_ARG}, then run EXACTLY:  ${VERIFY_CMD} ${REPO_ARG}
Output the command's stdout VERBATIM (JSON {pass,failures,checks}). No fences, no commentary.`,
  { model: MODEL_RUNNER, phase: 'Integration', label: 'integration-verify' }
)
const intV = asVerify(intRaw)
state.integration = intV
if (intV.pass === true) {
  const noopTasks = state.tasks.filter((t) => t.status === 'noop').map((t) => t.taskId)
  const realMerges = state.tasks.filter((t) => t.status === 'done').length
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
