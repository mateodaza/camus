export const meta = {
  name: 'camus-loop',
  description: 'Run the Camus closed loop on one task: plan → implement → (codex-review ↔ fix)* → verify',
  whenToUse: 'Drive one task through the v2-lite Camus gate. Pass the task in args: a string, or {task, targetPath}.',
  phases: [
    { title: 'Classify',  detail: 'Cheap model rates complexity → routes the think-model (trivial→Sonnet, else Opus).' },
    { title: 'Plan',      detail: 'Think model reads relevant files, writes a short plan. No code.' },
    { title: 'Implement', detail: 'Think model makes the change in a dedicated git worktree.' },
    { title: 'Review',    detail: 'Thin runner execs codex_review.sh, echoes raw gate JSON (judgment is Codex).' },
    { title: 'Fix',       detail: 'Think model fixes blocking findings in the same worktree.' },
    { title: 'Verify',    detail: 'Thin runner execs verify.sh; pass→DONE, can\'t-run→inconclusive (not failed).' },
  ],
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
const REVIEW_CMD = `bash ${SKILL_SCRIPTS}/codex_review.sh`
const VERIFY_CMD = `bash ${SKILL_SCRIPTS}/verify.sh`
const PREP_CMD = `bash ${SKILL_SCRIPTS}/prep.sh`     // make a fresh worktree runnable before verify
const COMMIT_CMD = `bash ${SKILL_SCRIPTS}/commit.sh` // commit reviewed work so the branch isn't empty

// args may be a bare string or {task, targetPath}
const TASK = typeof args === 'string' ? args : (args && args.task) || ''
const TARGET = (args && typeof args === 'object' && args.targetPath) || ''
// Identity composability: a caller (e.g. the M1 feat-runner) can feat-scope this task's branch
// and worktree by passing branchPrefix (default 'camus/') and idSalt (default '' = standalone).
const BRANCH_PREFIX = (args && typeof args === 'object' && args.branchPrefix) || 'camus/'
const ID_SALT = (args && typeof args === 'object' && args.idSalt) || ''
// HITL: policy governs when the loop PAUSES to ask a human vs. acting and LOGGING the decision.
//   autonomous       — never ask; every notable call is recorded in `decisions`, human reviews at merge.
//   ask_on_ambiguity — ask only on genuine ambiguity / divergent readings / irreversible calls. (default)
//   ask_on_major     — also ask on any non-trivial design decision (more interruptions).
// Safety-axis HITL (destructive/out-of-repo actions) is handled separately by auto mode's classifier.
const POLICY = (args && typeof args === 'object' && args.policy) || 'ask_on_ambiguity'
const ASK_ON = { autonomous: [], ask_on_ambiguity: ['ambiguous'], ask_on_major: ['ambiguous', 'design_decision'] }
// On resume after a needs_human pause, the caller threads the human's answer back in. When present
// we do NOT re-ask (the call is made) and feed it into plan + implement as resolved guidance.
const HUMAN_ANSWER = (args && typeof args === 'object' && args.humanAnswer && String(args.humanAnswer)) || ''
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
const RUN_ID = fnv1a(ID_SALT ? ID_SALT + '::' + TASK : TASK).slice(0, 6)
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
// makes the parent repo-unique while staying deterministic for the same checkout path.
const WT_PARENT_EXPR = `$HOME/.camus/worktrees/$(basename "$(pwd -P)")-$(pwd -P | cksum | cut -d' ' -f1)`
const WT_PARENT = `"${WT_PARENT_EXPR}"`
const WT_DEST = `"${WT_PARENT_EXPR}/${WT_NAME}"`

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
      description: 'clear = exactly one obvious correct implementation. design_decision = a real non-trivial design choice with tradeoffs exists, though a sensible default can be picked. ambiguous = genuinely under-specified, valid interpretations DIVERGE, or the change is irreversible — must not be guessed.' },
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
function asGate(raw) {
  const g = extractJsonObject(raw)
  if (!g || typeof g.ran !== 'boolean') {
    return { ran: false, error: 'reviewer output not parseable as gate JSON', clean: false, blocking: [], nonblocking: [] }
  }
  if (g.ran && g.clean !== true && !Array.isArray(g.blocking)) {
    return { ran: false, error: 'gate JSON missing blocking[] on non-clean verdict', clean: false, blocking: [], nonblocking: [] }
  }
  return g
}

function asVerify(raw) {
  const v = extractJsonObject(raw)
  if (!v || typeof v.pass !== 'boolean') {
    return { pass: false, failures: [{ stage: 'verify', exit: -1, log_tail: 'verify output not parseable as {pass, failures}' }], inconclusive: true }
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
if (LAND) {
  phase('Commit')
  // Resolve the EXISTING worktree at the same deterministic destination implement would have
  // created — with the same fail-closed path validation (audit F3: never cd/exec an unvalidated
  // path). No worktree → nothing to land → abort, never plan/implement under land.
  const wtRaw = await agent(
    `THIN land-path resolver. Run EXACTLY this one command and output ONLY its stdout (one absolute path), no commentary:
  cd ${WT_DEST} && pwd
If the cd fails (directory does not exist), output exactly: MISSING`,
    { model: MODEL_RUNNER, phase: 'Commit', label: 'land-resolve' }
  )
  const wt = String(wtRaw || '').trim().split('\n').pop().trim()
  if (!wt || wt === 'MISSING' || !wt.endsWith(WT_NAME)) {
    return { status: 'aborted', stage: 'land', task: TASK, branch: BRANCH, landed: false,
      note: `Land mode found no existing worktree at ${WT_DEST}${wt && wt !== 'MISSING' ? ` (resolver returned "${wt}")` : ''} — nothing to land. Land never plans/implements/reviews; re-run WITHOUT land:true to do the work.` }
  }
  log(`Land mode: committing previously verified work in ${wt} — skipping plan/implement/review (deterministic verify still gates)${tokSuffix()}.`)
  const commitRaw = await agent(
    `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${COMMIT_CMD} ${JSON.stringify(wt)} ${JSON.stringify('chore(camus): land ' + SLUG)}`,
    { model: MODEL_RUNNER, phase: 'Commit', label: 'commit' }
  )
  const commitResult = extractJsonObject(commitRaw) || { committed: false, reason: 'unparseable' }
  if (commitResult.committed !== true && commitResult.reason !== 'empty') {
    return { status: 'infra_error', task: TASK, worktree: wt, branch: BRANCH, rounds: 0, landed: true,
      error: `land commit failed: ${commitResult.reason || 'unknown'}`,
      note: 'Land mode could not commit the worktree (git error/identity/hook, or unparseable output). Fix the cause and re-run with land:true — the worktree is untouched.' }
  }
  const landSha = commitResult.committed === true ? (commitResult.sha || null) : null
  log(commitResult.committed === true
    ? `Committed previously verified work (${landSha}) to ${BRANCH}.`
    : 'Land mode: stage was empty — the work was already committed on the branch; proceeding to verify.')
  const v = await prepAndVerify(wt)
  if (v.ok === 'inconclusive') {
    return { status: 'verify_inconclusive', task: TASK, worktree: wt, branch: BRANCH, rounds: 0, landed: true, failures: v.failures,
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

// ── Phase 0: CLASSIFY complexity → route the think-model ─────────────────────
phase('Classify')
const cls = await agent(
  `Classify the complexity of this ONE coding task. Reply with a tier:
- "trivial": a localized change of a few lines with obvious scope (a guard, a rename, a typo, a one-function fix).
- "standard": a normal change touching one area or file-set with clear intent.
- "complex": multi-file, ambiguous, architectural, or cross-cutting.

Task: ${TASK}`,
  { model: MODEL_RUNNER, phase: 'Classify', label: 'classify', schema: CLASSIFY_SCHEMA }
)
// Override precedence (FEATURE 1a): explicit `model` > `modelTier` > classifier result.
//   args.model     — exact think-model string (e.g. 'opus'), used VERBATIM, forces nothing about tier.
//   args.modelTier — one of trivial|standard|complex, forces the tier (and thus its TIER_MODEL).
// The classifier still runs (its tier feeds skip-plan + escalation), but overrides win.
const MODEL_OVERRIDE = (args && typeof args === 'object' && typeof args.model === 'string' && args.model) || ''
const TIER_OVERRIDE = (args && typeof args === 'object' && TIER_MODEL[args.modelTier]) ? args.modelTier : ''
// Opt-in (default OFF). Only honored under policy:autonomous (see skip-plan block) so it can never
// silently disable ambiguity detection / the needs_human ask-gate on an asking policy.
const SKIP_PLAN_REQ = !!(args && typeof args === 'object' && args.skipPlan === true)
const classifiedTier = (cls && TIER_MODEL[cls.tier]) ? cls.tier : 'standard'
const tier = TIER_OVERRIDE || classifiedTier
const thinkModel = MODEL_OVERRIDE || TIER_MODEL[tier]
const modelSource = MODEL_OVERRIDE ? `args.model override ("${MODEL_OVERRIDE}")`
  : (TIER_OVERRIDE ? `args.modelTier override ("${TIER_OVERRIDE}")` : `classifier ("${classifiedTier}")`)
log(`Tier=${tier}, think model: ${thinkModel} via ${modelSource} (classifier said "${classifiedTier}"; runners: ${MODEL_RUNNER}).`)

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

Task: ${TASK}
${targetLine}${HUMAN_ANSWER ? `\n\nA human has ALREADY answered the open question for this task — treat it as DECIDED, do not re-raise it:\n${HUMAN_ANSWER}` : ''}

Read only the files needed to understand the change. Produce a short, ordered plan
(what to change, in which files, and why) plus the list of files the change will touch.

Then assess CLARITY honestly:
- "clear": exactly one obvious correct implementation.
- "design_decision": a real non-trivial design choice with tradeoffs exists, though a sensible default can be chosen.
- "ambiguous": genuinely under-specified, valid interpretations diverge, or the change is irreversible — must not be guessed.
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
const impl = await agent(
  `Implement ONE Camus task in an ISOLATED git worktree so review/verify can run against it cleanly.

Task: ${TASK}
${decisionGuidance}
Approved plan:
${plan.plan}

Files in scope: ${plan.relevant_files.join(', ') || (planSkipped ? 'discover the files yourself' : '(discover from the plan)')}

Steps:
1. From the repo root, run EXACTLY these two commands and NOTHING ELSE. Do NOT change any
   path or argument — the new branch is created from the current HEAD:
     mkdir -p ${WT_PARENT}
     git worktree add -b ${BRANCH} ${WT_DEST}
2. Get the worktree's ABSOLUTE path: run \`cd ${WT_DEST} && pwd\` and use its output as worktree_path.
3. Make the change ONLY inside that worktree. Stay within the planned files unless the
   plan clearly requires touching an adjacent file.
4. Do NOT run type-check, tests, or codex review — later phases own that.
5. Return worktree_path (absolute), branch ("${BRANCH}"), and a one-paragraph summary.
6. Record any notable DECISIONS in decisions[{what, why, alternative}] — a chosen default for an
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
if (!claimed || !claimed.endsWith(WT_NAME)) {
  return { status: 'aborted', stage: 'implement', task: TASK, plan,
    note: `Implement agent returned ${claimed ? `an unexpected worktree path (${claimed})` : 'no worktree path'}; expected an absolute path ending in "${WT_NAME}". Refusing to cd/exec into it.` }
}
const WT = claimed
log(`Implemented in worktree ${WT} (branch ${BRANCH})${tokSuffix()}.`)

// ── Phase 3: REVIEW ↔ FIX loop (ROUND_CAP rounds) ────────────────────────────
// Reviewer is THIN: it runs the script and echoes raw stdout. No schema, no
// re-judging. The SCRIPT parses the JSON and branches.

// DYNAMIC REVIEW EFFORT (run feedback 2026-06-11): review IS the gate, so reasoning effort
// scales with stakes instead of a blunt constant. Cheap `medium` first pass (most reviews are
// simple → fast); escalate to `high` when the change is hard (complex tier, or a prior round
// did NOT clear), and to `xhigh` when it's CRITICAL (a P0 surfaced). Mirrors the model-escalation
// signals below; deterministic (round + finding-priority, no Date/random). The user can still
// force a constant effort via CAMUS_CODEX_ARGS (it wins inside codex_review.sh).
function pickReviewEffort(rnd, priorBlocking) {
  if (priorBlocking.some((b) => b && b.priority === 0)) return 'xhigh'   // critical → maximum scrutiny
  if (tier === 'complex' || rnd >= 2) return 'high'                      // hard / persistent → deeper
  return 'medium'                                                         // default → fast
}
let currentEffort = 'medium'   // set per round below; read by reviewerPrompt

// A human answer IS task contract — plan/implement already treat it as DECIDED. The reviewer
// must judge the diff against the same contract, or a human-overridden finding gets re-flagged
// every round and the loop deadlocks at the round cap on by-design behavior (run feedback
// 2026-06-11: onboarding best-effort guard re-flagged 3 rounds straight after the human decided it).
const REVIEW_TASK_CTX = HUMAN_ANSWER
  ? `${TASK}\n\n## Human decision (binding — already DECIDED, do not flag behavior that conforms to it)\n${HUMAN_ANSWER}`
  : TASK

function reviewerPrompt(attempt) {
  const backoff = attempt > 1
    ? `This is reviewer attempt ${attempt} after an infra failure. First run \`sleep ${attempt * 5}\` to back off, then proceed.\n`
    : ''
  return `You are a THIN reviewer. Your ONLY job is to run the Camus Codex review on
the worktree and return its stdout. Do NOT interpret, summarize, re-judge, or reformat.

${backoff}Run EXACTLY this one command (the worktree path is the argument — do NOT cd, do NOT add anything else):
  ${REVIEW_CMD} ${JSON.stringify(WT)} ${JSON.stringify(REVIEW_TASK_CTX)} ${round} ${currentEffort}

Output the command's stdout VERBATIM as your entire reply — nothing before or after, no code
fences, no commentary. It is already JSON.`
}

let round = 0
let reviewPassed = false
let lastBlocking = []
let infraAbort = null

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
    const raw = await agent(reviewerPrompt(attempt), {
      model: MODEL_RUNNER, phase: 'Review',
      label: `review:r${round} codex·${currentEffort}${attempt > 1 ? ` retry${attempt}` : ''}`,
    })
    gate = asGate(raw)
    if (gate.ran) break
    log(`Round ${round}/${ROUND_CAP}: reviewer infra failure (${gate.error}) — attempt ${attempt}/${INFRA_RETRIES + 1}.`)
  }

  if (!gate.ran) {
    // Exhausted infra retries. NOT a rejection, NOT clean — stop and surface infra.
    infraAbort = gate.error
    break
  }

  // 3c: clean → done with review
  if (gate.clean === true) {
    reviewPassed = true
    log(`Round ${round}/${ROUND_CAP} (review effort: ${currentEffort}): CLEAN (no priority≤2 findings)${tokSuffix()}.`)
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
  const repeatedKeys = lastBlocking.map(findingKey).filter((k) => k && priorKeys.has(k))
  if (repeatedKeys.length && round >= 2) {
    stuckFindings = lastBlocking.filter((b) => repeatedKeys.includes(findingKey(b)))
      .map((b) => ({ ...b, confidenceTrend: confTrend(confHistory[findingKey(b)]) }))
    const falling = stuckFindings.filter((s) => s.confidenceTrend.dir === 'falling').length
    log(`Round ${round}/${ROUND_CAP}: ${stuckFindings.length} finding(s) survived a fix and were re-raised — stopping early for a human decision${falling ? ` (${falling} with FALLING reviewer confidence → likely stale)` : ''}.`)
    break
  }
  priorKeys = new Set(lastBlocking.map(findingKey).filter(Boolean))
  log(`Round ${round}/${ROUND_CAP} (review effort: ${currentEffort}): ${lastBlocking.length} blocking finding(s) — dispatching fix.`)
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
  await agent(
    `Fix the BLOCKING review findings below, in the EXISTING worktree. Do not refactor
beyond what each finding requires. Do not touch P3 nits.

Worktree: ${WT}
  cd ${JSON.stringify(WT)}

Blocking findings (Codex, priority ≤ 2):
${JSON.stringify(lastBlocking, null, 2)}

Apply the minimal correct fix for each. Do not run review or verify — the loop owns that.
${softBudget}`,
    { model: fixModel, phase: 'Fix', label: `fix:r${round}` }
  )
}

// Deterministic PREP + VERIFY (type-check / lint / tests) on the worktree. Returns a verdict
// {ok:'pass'|'fail'|'inconclusive', stage, failures} the caller maps to a status. Reused by BOTH
// the clean-review path (the final gate) AND the review_unresolved path — so a non-converged review
// is judged against deterministic ground truth before it's ever reported (Fix 2026-06-11).
// `wt` defaults to the implement-phase WT at CALL time (default params evaluate lazily, so the
// land path — where WT is never initialized — can pass its own resolved path without TDZ).
async function prepAndVerify(wt = WT) {
  phase('Prep')
  const prepRaw = await agent(
    `THIN prep runner. Run EXACTLY this one command and output its stdout VERBATIM as your entire reply
(JSON {prepped, ran, ...}); no fences, no commentary:
  ${PREP_CMD} ${JSON.stringify(wt)}`,
    { model: MODEL_RUNNER, phase: 'Prep', label: 'prep' }
  )
  const prepResult = extractJsonObject(prepRaw)
  if (!prepResult || prepResult.prepped !== true) {
    return { ok: 'inconclusive', stage: 'prep',
      failures: [{ stage: 'prep', kind: 'missing_tool',
        log_tail: (prepResult && (prepResult.log_tail || prepResult.error)) || 'worktree dependency install failed or unparseable' }] }
  }
  log(prepResult.ran ? `Prep: installed worktree deps (${prepResult.ran.join(' ')}).` : 'Prep: no dep install needed.')
  phase('Verify')
  const verifyRaw = await agent(
    `Run the Camus verification on the worktree and return its stdout JSON verbatim.

Run EXACTLY this one command (the worktree path is the argument — do NOT cd, do NOT add anything else):
  ${VERIFY_CMD} ${JSON.stringify(wt)}

Output the command's stdout VERBATIM as your entire reply (it is JSON {pass, failures}).
No fences, no commentary.`,
    { model: MODEL_RUNNER, phase: 'Verify', label: 'verify' }
  )
  const verify = asVerify(verifyRaw)
  if (verify.inconclusive) return { ok: 'inconclusive', stage: 'verify', failures: verify.failures || [] }
  return { ok: verify.pass === true ? 'pass' : 'fail', stage: 'verify', failures: verify.failures || [] }
}

if (infraAbort) {
  return {
    status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH,
    rounds: round, error: infraAbort,
    note: 'Codex reviewer never produced a usable verdict. Not a rejection and not clean — needs a human / infra check. Known causes of an EMPTY verdict with exit 0: codex blocking on an open stdin (fixed in codex_review.sh via </dev/null — re-run install.sh if your gate predates it) and a heavy ambient reasoning effort exhausting the output budget on a large diff (pin via CAMUS_CODEX_ARGS="-c model_reasoning_effort=medium"). Inspect ~/.camus/reviews/<wt>-r<round>.json and /tmp/camus_codex_err.log. AFTER fixing, retry by re-invoking the feat FRESH with the SAME args (deterministic featId resumes from state) — do NOT resume the workflow journal (resumeFromRunId): it replays this cached infra_error without re-running the reviewer.',
  }
}

if (!reviewPassed) {
  // The review did not converge (hit ROUND_CAP, or a finding survived a fix). Per camus's OWN rule
  // — "deterministic ground truth wins" — consult VERIFY before reporting (Fix 2026-06-11: a
  // probabilistic review was halting verify-clean, shippable code on a stale re-flag). A verify-clean
  // halt is a DECISION POINT, never a plain failure.
  const v = await prepAndVerify()
  const why = stuckFindings
    ? 'a finding was re-raised after a fix — stopped early rather than burning the rest of the rounds'
    : `reached ROUND_CAP=${ROUND_CAP} with blocking findings still present`
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
    tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
  }
  if (v.ok === 'pass') {
    return { ...base, verifyClean: true,
      note: `Review did not converge (${why}) — BUT deterministic verify (type-check / lint / tests) PASSES on this worktree. This is likely a STALE RE-FLAG or a judgment impasse, NOT broken code. The deterministic gate says the work is shippable. DECIDE: accept (commit + merge the worktree as-is) or refine (address the finding below).${confHint}` }
  }
  if (v.ok === 'inconclusive') {
    return { ...base, verifyClean: null, failures: v.failures,
      note: `Review did not converge (${why}); deterministic verify could NOT run (env not ready — ${v.stage}). Fix the environment to get the ground-truth verdict, then decide accept vs refine. Finding(s) below.${confHint}` }
  }
  return { ...base, verifyClean: false, failures: v.failures,
    note: `Review did not converge (${why}) AND deterministic verify did NOT pass — the code is genuinely not done. Finding(s) + verify failures below.` }
}

// ── Phase 3.4: COMMIT GATE — the reviewed change MUST land on the branch, or the merge ships
// nothing (run-2 bug: implement changed files but never committed → empty merge → false done).
// Review/fix run on the UNCOMMITTED tree so Codex sees the diff; only NOW, after review is clean,
// do we commit. No staged changes → no_changes (never a false done). `done` requires a commit_sha.
phase('Commit')
const commitRaw = await agent(
  `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${COMMIT_CMD} ${JSON.stringify(WT)} ${JSON.stringify('chore(camus): ' + SLUG)}`,
  { model: MODEL_RUNNER, phase: 'Commit', label: 'commit' }
)
const commitResult = extractJsonObject(commitRaw) || { committed: false, reason: 'unparseable' }
if (commitResult.committed !== true) {
  // Only a genuinely EMPTY diff is a benign no_changes. A failed commit (bad worktree, git
  // identity/error, failing hook) or unparseable output is an INFRA failure — never a harmless
  // no-op the feat can continue past. (Same infra-vs-findings discipline as the verifier.)
  if (commitResult.reason === 'empty') {
    return {
      status: 'no_changes', task: TASK, worktree: WT, branch: BRANCH, rounds: round,
      note: 'Review passed but the implement step produced no committable change (empty diff). no_changes, never a false done — nothing to merge.',
    }
  }
  return {
    status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH, rounds: round,
    error: `commit gate failed: ${commitResult.reason || 'unknown'}`,
    note: 'The commit step FAILED (bad worktree, git error/identity, failing hook, or unparseable output) — NOT an empty diff and NOT a benign no-op. Needs a human / infra check.',
  }
}
const COMMIT_SHA = commitResult.sha || null
log(`Committed reviewed work (${COMMIT_SHA}) to ${BRANCH}${tokSuffix()}.`)

// ── Phase 3.5 + 4: PREP + VERIFY (deterministic ground truth — final, non-negotiable gate) ─
// Runs after review passes + commit (review/fix don't need deps). A clean review does NOT override
// a failing verify; an env that can't run is verify_inconclusive (NOT code-red — the run-1 false
// negative was `turbo` missing in a fresh worktree).
const verdict = await prepAndVerify()
if (verdict.ok === 'inconclusive') {
  return {
    status: 'verify_inconclusive', task: TASK, worktree: WT, branch: BRANCH, rounds: round,
    failures: verdict.failures, tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
    note: verdict.stage === 'prep'
      ? 'Could not prepare the worktree to run (dependency install failed) — env not ready, NOT a code failure. Check the package manager / lockfile and re-run.'
      : 'Verification could not RUN (toolchain/deps missing in the worktree, or no verifier detected) — NOT a code failure. Fix the environment (install deps / correct node; see env_check) and re-run.',
  }
}
if (verdict.ok === 'pass') {
  return {
    status: 'done', task: TASK, worktree: WT, branch: BRANCH, commit_sha: COMMIT_SHA,
    rounds: round, summary: impl.summary, decisions: Array.isArray(impl.decisions) ? impl.decisions : [],
    tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
    note: 'Review clean, change committed, and verify passed. Worktree left in place for human merge/inspection (a camus-feat caller removes it after merging the branch).',
  }
}
return {
  status: 'verify_failed', task: TASK, worktree: WT, branch: BRANCH,
  rounds: round, failures: verdict.failures, tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
  note: 'Review was clean but deterministic verify ran and did not pass. Code is NOT done.',
}
