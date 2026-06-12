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

// HEARTBEAT (0.2.5 item 1 — "`running` must mean running"): under a feat (ID_SALT = featId) every
// thin-runner command line and every think-phase prompt touches ~/.camus/feats/<featId>.hb FIRST,
// so that file's MTIME is a phase-boundary liveness signal status/watch read with NO transcript
// dependency (the 2026-06-11 smoke sat "state updated 19m ago" mid-task with no way to tell churn
// from death). Wall-clock lives in the FILE's mtime, never in this script — Date is banned here
// (resume determinism), which is exactly why the stamp is a side effect of the agents' shells.
// Standalone loops (no salt) skip it: the .hb name is feat identity.
const HB_TOUCH = ID_SALT ? `touch "$HOME/.camus/feats/${ID_SALT}.hb" 2>/dev/null; ` : ''
const HB_LINE = ID_SALT ? `\nFirst, run \`touch "$HOME/.camus/feats/${ID_SALT}.hb"\` (liveness heartbeat — ignore any failure), then proceed.\n` : ''

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
  ${HB_TOUCH}cd ${WT_DEST} && pwd
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
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(wt)} ${JSON.stringify('chore(camus): land ' + SLUG)}`,
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
${HB_LINE}
Task: ${TASK}
${targetLine}${envFactsBlock}${HUMAN_ANSWER ? `\n\nA human has ALREADY answered the open question for this task — treat it as DECIDED, do not re-raise it:\n${HUMAN_ANSWER}` : ''}

Read only the files needed to understand the change. Produce a short, ordered plan
(what to change, in which files, and why) plus the list of files the change will touch.

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
const impl = await agent(
  `Implement ONE Camus task in an ISOLATED git worktree so review/verify can run against it cleanly.
${HB_LINE}
Task: ${TASK}
${decisionGuidance}${envFactsBlock}
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

// WORKTREE CONTAINMENT GUARD (smoke 2026-06-12): BOTH think-agents leaked draft edits into the
// MAIN repo tree (implement at 07:54, fix at 08:04 — caught two phases later as a confusing
// merge refusal). "Edit only in the worktree" was prompt text, not a guard. Under a feat the
// main tree is guaranteed CLEAN at task start (preflight demands it; merges commit), so ANY
// porcelain output mid-task is a breach — an agent leak, or a human editing mid-run, both
// merge-fatal. Halt LOUDLY at the phase that caused it; never auto-discard (the dirt could be
// the human's). Feat-scoped only (ID_SALT): a standalone loop on a deliberately-dirty repo is
// the user's own working style, not a breach. NOTE: a repo whose TESTS dirty the tree will trip
// this — that was always merge-fatal; now it fails early with the files named.
async function containmentLeak(phaseName) {
  const raw = await agent(
    `THIN containment check. Run EXACTLY this one command from the CURRENT directory (the repo root — do NOT cd) and output its stdout VERBATIM as your entire reply (it may be EMPTY — then reply with nothing):
  ${HB_TOUCH}git status --porcelain`,
    { model: MODEL_RUNNER, phase: 'Review', label: `containment:${phaseName}` }
  )
  const dirt = String(raw == null ? '' : raw).trim()
  return (!dirt || dirt === '(empty)') ? null : dirt
}
if (ID_SALT) {
  const leak = await containmentLeak('implement')
  if (leak) {
    return { status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH, rounds: 0, containment: 'implement',
      error: 'worktree containment breach: the implement agent leaked edits into the MAIN repo tree',
      note: `The implement phase modified the MAIN repo tree — it must only touch its worktree. Leaked paths:\n${leak}\nIf these are agent strays, diff them against the task worktree (${WT}) and discard; if they are YOUR mid-run edits, commit or stash them. Then re-run the feat with the SAME args. The worktree itself is untouched.` }
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
function pickReviewEffort(rnd, priorBlocking) {
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
const REVIEW_TIMEOUT_MS = { medium: 360000, high: 600000, xhigh: 600000 }

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
  ${HB_TOUCH}${REVIEW_CMD} ${JSON.stringify(WT)} ${JSON.stringify(REVIEW_TASK_CTX)} ${round} ${currentEffort}${POSTURE === 'oneshot' ? ' light' : ''}

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
function awaitPrompt(handle) {
  return `You are a THIN reviewer attendant. A Codex review is still RUNNING detached; your ONLY
job is to re-attach and return the script's stdout. Do NOT interpret, summarize, or reformat.

Run EXACTLY this one command:
  ${HB_TOUCH}${REVIEW_CMD} await ${JSON.stringify(handle)}

Set the Bash tool's timeout PARAMETER to 600000 for this call. Do NOT wrap the command in
\`timeout\`/\`gtimeout\`.

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
let infraAbort = null
// ONESHOT (VELOCITY §1): the single review's blocking findings, preserved VERBATIM for the
// honest report — they were fixed once and never re-reviewed, and the result must say so.
// Per-finding CLAIMED resolutions (smoke 2026-06-12, the spec's audit-P2(b) half we first
// shipped without): the fix agent reports what it did for each finding, so a report reader can
// tell "addressed-unreviewed" from "untouched" — claims, clearly labeled, never verdicts.
const FIX_RESOLUTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resolutions'],
  properties: {
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
      raw = await agent(awaitPrompt(pend.handle), {
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
    // NO FIX WITHOUT A CONFIRMATION ROUND (fixlet 2026-06-11): the loop once dispatched a fix on
    // its FINAL round; it landed with no round left to re-review it, so the halt report described
    // an already-fixed worktree and forced a full relaunch. If no round remains to confirm a fix,
    // don't spend it — halt with the findings and let the decision (or a higher roundCap) own it.
    log(`Round ${round}/${ROUND_CAP}: ${lastBlocking.length} blocking finding(s) on the FINAL round — NOT dispatching a fix the loop cannot re-review; halting for the decision.`)
    break
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
${HB_LINE}
Worktree: ${WT}
  cd ${JSON.stringify(WT)}
${envFactsBlock}${siblingsBlock}
Blocking findings (Codex, priority ≤ 2):
${JSON.stringify(lastBlocking, null, 2)}

Apply the minimal correct fix for each. Do not run review or verify — the loop owns that.${POSTURE === 'oneshot' ? `
Then return resolutions[]: for EACH finding (title VERBATIM), one sentence on what you changed
— or why no change was needed. Nobody re-reviews this fix (oneshot posture), so your claims
ship next to the findings in the report, clearly labeled as claims.` : ''}
${softBudget}`,
    { model: fixModel, phase: 'Fix', label: `fix:r${round}`, ...(POSTURE === 'oneshot' ? { schema: FIX_RESOLUTIONS_SCHEMA } : {}) }
  )
  if (POSTURE === 'oneshot') {
    oneshotResolutions = (fixOut && Array.isArray(fixOut.resolutions)) ? fixOut.resolutions : null
    break   // one repair, no re-review — the posture's whole contract
  }
}

// Post-fix containment (smoke 2026-06-12): the fix agent was the SECOND leaker — same guard,
// run once after the loop whenever any fix dispatched. Checked BEFORE the unresolved/commit
// paths on purpose: a leak poisons the NEXT task's merge even when this task halts.
if (ID_SALT && fixesRan) {
  const leak = await containmentLeak('fix')
  if (leak) {
    return { status: 'infra_error', task: TASK, worktree: WT, branch: BRANCH, rounds: round, containment: 'fix',
      error: 'worktree containment breach: the fix agent leaked edits into the MAIN repo tree',
      note: `The fix phase modified the MAIN repo tree — it must only touch its worktree. Leaked paths:\n${leak}\nIf these are agent strays, diff them against the task worktree (${WT}) and discard; if they are YOUR mid-run edits, commit or stash them. Then re-run the feat with the SAME args.` }
  }
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
  ${HB_TOUCH}${PREP_CMD} ${JSON.stringify(wt)}`,
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
  ${HB_TOUCH}${VERIFY_CMD} ${JSON.stringify(wt)}

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

// Oneshot's fixed-once findings are NOT "unresolved review" — they are the posture's contract,
// and the honest status for them is done_with_findings (set at the verify-pass return below),
// never review_unresolved (which is full posture's impasse machinery).
if (!reviewPassed && !oneshotFindings) {
  // The review did not converge (hit ROUND_CAP, or a finding survived a fix). Per camus's OWN rule
  // — "deterministic ground truth wins" — consult VERIFY before reporting (Fix 2026-06-11: a
  // probabilistic review was halting verify-clean, shippable code on a stale re-flag). A verify-clean
  // halt is a DECISION POINT, never a plain failure.
  const v = await prepAndVerify()
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
    tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
  }
  if (v.ok === 'pass') {
    // PARK (0.2.5 item 2 — kills the "trapped work" class): this worktree is verify-CLEAN but
    // uncommitted, and an uncommitted halt is the fragile state run-4/5 thrashed on (anything
    // that disturbs the worktree loses proven work). Commit it NOW as a labeled park so it
    // survives everything; land's empty-stage path already knows how to finish from a committed
    // worktree on accept. FAIL-SOFT: parking is protection, not a gate — a refused commit still
    // halts as before, with the failure named so the human knows the work is unparked.
    const parkRaw = await agent(
      `THIN commit runner. Run EXACTLY this one command and output its stdout VERBATIM (JSON {committed, sha}); no fences, no commentary:
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(WT)} ${JSON.stringify('chore(camus): park ' + SLUG + ' (review-flagged, verify-green)')}`,
      { model: MODEL_RUNNER, phase: 'Verify', label: 'park' }
    )
    const park = extractJsonObject(parkRaw) || { committed: false, reason: 'unparseable' }
    const parkedSha = park.committed === true ? (park.sha || null) : null
    const parkLine = park.committed === true
      ? ` The work is PARKED as commit ${parkedSha} on ${BRANCH} (review-flagged, verify-green) — it survives even if the worktree is lost.`
      : (park.reason === 'empty'
        ? ` The work was already committed on ${BRANCH} — nothing to park.`
        : ` ⚠ Parking the work FAILED (${park.reason || 'unknown'}) — the verify-clean diff is still UNCOMMITTED in the worktree; treat it gently until you accept or refine.`)
    log(park.committed === true
      ? `Parked verify-clean work as ${parkedSha} (review-flagged) — protected pending the accept/refine decision.`
      : `Park attempt: ${park.reason || 'failed'} — halt proceeds regardless.`)
    return { ...base, verifyClean: true, ...(parkedSha ? { parkedSha } : {}),
      note: `Review did not converge (${why}) — BUT deterministic verify (type-check / lint / tests) PASSES on this worktree. This is likely a STALE RE-FLAG or a judgment impasse, NOT broken code. The deterministic gate says the work is shippable.${parkLine} DECIDE: accept (commit + merge the worktree as-is) or refine (address the finding below).${confHint}` }
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
  ${HB_TOUCH}${COMMIT_CMD} ${JSON.stringify(WT)} ${JSON.stringify('chore(camus): ' + SLUG)}`,
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
  if (oneshotFindings) {
    // HONEST-REPORT SEMANTICS (VELOCITY §1 audit P2): `done` is reserved for review-clean. The
    // work is merged-ready and deterministically GREEN, but the single review's findings got ONE
    // unreviewed fix pass — the human reads them, severity-sorted and verbatim, before shipping.
    // Findings ride verbatim + each carries the fix agent's CLAIMED resolution when one matched
    // by title (smoke 2026-06-12: without these, a reader can't tell addressed-unreviewed from
    // untouched — the field is named claimedResolution because nobody verified it).
    const findingsOut = oneshotFindings.map((f) => {
      const m = (oneshotResolutions || []).find((r) => r && r.title === (f && f.title))
      return m ? { ...f, claimedResolution: m.resolution } : f
    })
    return {
      status: 'done_with_findings', task: TASK, worktree: WT, branch: BRANCH, commit_sha: COMMIT_SHA,
      rounds: round, summary: impl.summary, decisions: Array.isArray(impl.decisions) ? impl.decisions : [],
      findings: findingsOut, findingsDeferred: findingsOut.length, resolution: 'fixed_unreviewed',
      tier, model: fixModel, initialModel: thinkModel, finalFixModel: fixModel, escalated: fixModel !== thinkModel, planSkipped,
      note: `Oneshot posture: the single review found ${oneshotFindings.length} blocking finding(s); ONE fix pass ran and was NOT re-reviewed (the posture's contract). Deterministic verify PASSES and the change is committed. NOT review-clean — read the findings (verbatim in this result) before shipping.`,
    }
  }
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
