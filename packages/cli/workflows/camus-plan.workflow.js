export const meta = {
  name: 'camus-plan',
  description: 'Turn a raw coding request into a camus-feat-ready, quality-gated plan: ground in the repo → clarify (ask on real ambiguity) → architect → decompose to camus standards → adversarially critique → emit {feat, tasks}. Read-only on your repo; writes only a plan file. Optional pre-step before camus-feat.',
  whenToUse: 'Run BEFORE camus-feat when a request is vague or large and you want it reframed into a well-scoped ordered task list (the lesson from oversized tasks: smaller, clearer tasks converge in fewer review rounds). args = { request: "<what you want built>", targetPath?, policy?, model?, modelTier?, answers? }. policy ∈ autonomous|ask_on_ambiguity(default)|ask_on_major decides whether GENUINE ambiguities PAUSE for you (status needs_human) before planning continues; resume by re-running with answers:{ "<questionId>": "<your answer>" }. NEVER writes code — only a plan at ~/.camus/plans/<id>.json (+ a readable .md). Launch FROM the target repo (cwd = repo root).',
  phases: [
    { title: 'Ground',    detail: 'Agent explores the repo read-only: stack, the verify command, conventions, and the files this request will touch. The plan is grounded in reality, not assumptions.' },
    { title: 'Clarify',   detail: 'Agent judges whether the request is under-specified. Under an asking policy a genuine ambiguity PAUSES (needs_human) with questions; resume with answers.' },
    { title: 'Architect', detail: 'Agent designs the change: contracts, data flow, the safe ordering (additive → destructive → cleanup), and risks.' },
    { title: 'Decompose', detail: 'Agent splits it into an ORDERED camus-standard task list — right-sized, baseline-green between tasks, each with explicit acceptance criteria.' },
    { title: 'Critique',  detail: 'A fresh adversarial reviewer scores the plan against the rubric and flags oversized/ambiguous/unverifiable tasks; the planner revises until ready or the cap.' },
    { title: 'Emit',      detail: 'Agent writes the plan: ~/.camus/plans/<id>.json (the exact camus-feat args) + <id>.md (readable). You review, then run camus-feat with it.' },
  ],
}

// ── Constants ────────────────────────────────────────────────────────────────
const SKILL = '"$HOME/.claude/skills/camus/scripts"'   // (unused here; planning is read-only reasoning)
const MODEL_RUNNER = 'haiku'                             // thin file writer — no judgment to apply
const TIER_MODEL = { trivial: 'sonnet', standard: 'opus', complex: 'opus' }
const CRITIQUE_CAP = 2                                   // bounded plan-refine rounds (mirrors the gate's ROUND_CAP discipline)
const REPO_ARG = '"$PWD"'                                // all read-only exploration runs in the repo root

// ── Args: { request, targetPath?, policy?, model?, modelTier?, answers? } ─────
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (_) { A = { request: A } } }
if (!A || typeof A !== 'object' || Array.isArray(A)) {
  throw new Error('camus-plan: args must be { request } (got: ' + typeof args + ')')
}
const REQUEST = String(A.request || '').trim()
if (!REQUEST) throw new Error('camus-plan: missing args.request (the thing you want built)')
const TARGET = (A.targetPath && String(A.targetPath)) || ''
const POLICY = (A.policy && String(A.policy)) || 'ask_on_ambiguity'
const ASK_ON = { autonomous: [], ask_on_ambiguity: ['ambiguous'], ask_on_major: ['ambiguous', 'design_decision'] }
// answers: a map { questionId: "human answer" } supplied on a RESUME after a needs_human pause.
const ANSWERS = (A.answers && typeof A.answers === 'object' && !Array.isArray(A.answers)) ? A.answers : {}
const MODEL_OVERRIDE = (A.model != null && String(A.model)) || ''
const TIER_OVERRIDE = (A.modelTier && TIER_MODEL[A.modelTier]) ? A.modelTier : ''
// Planning is high-value reasoning — default to the top model; allow caller override.
const THINK = MODEL_OVERRIDE || TIER_MODEL[TIER_OVERRIDE || 'standard']

const targetLine = TARGET ? `Start from this path: ${TARGET}` : 'No target path given — discover the relevant area yourself.'

// ── Deterministic plan identity (FNV-1a; NO Date/Math.random — they break resume) ──
function slugify(s, max = 40) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'plan'
}
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0 }
  return h.toString(36)
}
const PLAN_ID = `${slugify(REQUEST, 32)}-${fnv1a(REQUEST).slice(0, 6)}`
const PLAN_JSON = `~/.camus/plans/${PLAN_ID}.json`
const PLAN_MD = `~/.camus/plans/${PLAN_ID}.md`

// ── JSON helper: the SCRIPT parses agent stdout, never an agent (copied from camus-feat) ─
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

// ── Schemas ──────────────────────────────────────────────────────────────────
const REPO_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verifyCmd', 'stack', 'conventions', 'relevantFiles'],
  properties: {
    verifyCmd: { type: 'string', description: 'The repo\'s type-check + test command (e.g. "pnpm type-check && pnpm test"), or "" if undetectable.' },
    stack: { type: 'string', description: 'Language/framework/build tooling in one line.' },
    conventions: { type: 'array', items: { type: 'string' }, description: 'Patterns a new change must follow (error handling, file layout, naming, test style).' },
    relevantFiles: { type: 'array', items: { type: 'string' }, description: 'Existing files this request will touch or sit beside.' },
    notes: { type: 'string', description: 'Anything load-bearing for planning (gotchas, existing abstractions to reuse).' },
  },
}
const CLARITY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['clarity', 'ambiguities'],
  properties: {
    clarity: { type: 'string', enum: ['clear', 'design_decision', 'ambiguous'],
      description: 'clear = exactly one sensible build. design_decision = a real tradeoff exists but a default can be chosen. ambiguous = genuinely under-specified; valid readings DIVERGE; OR the approach embeds a user-visible product tradeoff (data loss/alteration, external behavior or contract change) the request does not decide — product calls are human calls; must not be guessed.' },
    ambiguities: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'question', 'why'],
        properties: {
          id: { type: 'string', description: 'short stable kebab-id for this question (the key the human answers under)' },
          question: { type: 'string', description: 'the single specific decision blocking a confident plan' },
          why: { type: 'string', description: 'why it matters / what diverges' },
          options: { type: 'array', items: { type: 'string' }, description: 'the divergent valid choices, if discrete' },
        },
      },
    },
  },
}
const ARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['overview', 'sequence'],
  properties: {
    overview: { type: 'string', description: 'One paragraph: the shape of the change and how it fits the existing code.' },
    contracts: { type: 'array', items: { type: 'string' }, description: 'Interfaces/types/signatures introduced or changed.' },
    dataFlow: { type: 'string', description: 'How data moves through the change.' },
    sequence: { type: 'array', items: { type: 'string' }, description: 'The safe order of operations: additive first, destructive/rename next, cleanup last (baseline must stay green between steps).' },
    risks: { type: 'array', items: { type: 'string' }, description: 'What could break; what to verify.' },
  },
}
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['feat', 'tasks'],
  properties: {
    feat: { type: 'string', description: 'Short feature title (becomes the camus-feat branch name).' },
    orderingNote: { type: 'string', description: 'Why the tasks are in this order (the additive→destructive→cleanup rationale).' },
    tasks: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'spec', 'files', 'acceptance'],
        properties: {
          title: { type: 'string', description: 'Short task title.' },
          spec: { type: 'string', description: 'SELF-CONTAINED implementation spec — detailed enough that an implementer never guesses. Names files, functions, signatures, behavior. This is the exact string handed to camus-feat as the task.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files this task creates/modifies/deletes. Right-sized: ideally ≤ ~8.' },
          acceptance: { type: 'string', description: 'Explicit, checkable done criteria (a grep result, a tsc pass, a specific behavior).' },
          rationale: { type: 'string', description: 'Why this task exists / why here in the order.' },
        },
      },
    },
  },
}
const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs_revision'], description: 'ready = every task meets the camus standard. needs_revision = at least one issue below.' },
    score: { type: 'number', description: '0–100 overall plan quality.' },
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['problem', 'fix'],
        properties: {
          taskIndex: { type: 'number', description: '0-based task this is about, or -1 for a plan-level issue (ordering, missing task).' },
          severity: { type: 'string', enum: ['major', 'minor'] },
          problem: { type: 'string', description: 'The concrete defect (oversized, ambiguous spec, unverifiable acceptance, unsafe ordering, missing step).' },
          fix: { type: 'string', description: 'The specific change to make.' },
        },
      },
    },
  },
}
const WRITTEN_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' } } }

// The camus standard rubric, shared by Decompose and Critique so they judge by the same bar.
const STANDARDS = `Camus task standards (what makes the gate converge fast — judge every task by these):
- RIGHT-SIZED: one coherent area, ideally ≤ ~8 files. A task touching many files / many concerns must be SPLIT (oversized tasks churn the review loop).
- SAFELY ORDERED: additive changes first, destructive/renames next, cleanup last — the repo's type-check+tests (the baseline) must stay GREEN between tasks, never red mid-feat.
- INDEPENDENTLY VERIFIABLE: each task states explicit acceptance criteria a verifier or a grep can check (e.g. "grep -ri X src/ returns 0 hits and tsc passes").
- SELF-CONTAINED SPEC: detailed enough that the implementer never guesses — names files, functions, signatures, behavior. Reuse existing abstractions named in the repo grounding.
- UNAMBIGUOUS: no open design decisions left inside a task; those are resolved at plan time.
- SOURCE-BOUND REFERENCES (field incident 2026-06-12): when a task depends on behavior in code the
  implementer CANNOT read at run time (another repo, an unmerged branch), the task must carry either
  literal code marked "paste the CURRENT version at launch" or an executable contract to port (an
  ACCEPT/REJECT test table) — NEVER an English walkthrough of that code. Prose detaches from its
  source the moment it is written; the source moves, the prose holds still, and the implementer
  faithfully builds the stale version. Flag any prose-of-unreadable-code as a blocking violation.`

// ── Phase 1: GROUND — explore the repo read-only ─────────────────────────────
phase('Ground')
const repo = await agent(
  `You are grounding a plan in a REAL repository (read-only — do NOT modify anything). cd ${REPO_ARG}.
Request to plan for: ${REQUEST}
${targetLine}

Explore only what you need to plan well:
- Detect the verify command (type-check + tests) — check package.json scripts / Makefile / the stack's convention. If env var CAMUS_VERIFY_CMD is set, that's authoritative.
- Identify the stack and the conventions a new change must follow (error handling, file layout, naming, test style).
- List the existing files this request will touch or sit beside, and any abstractions worth reusing.
Return the structured grounding. Be concrete; cite real file paths.`,
  { model: THINK, phase: 'Ground', label: 'ground', schema: REPO_SCHEMA }
)
if (!repo) return { status: 'aborted', stage: 'ground', request: REQUEST, note: 'Grounding agent returned nothing.' }
log(`Grounded: ${repo.relevantFiles.length} relevant file(s); verify="${repo.verifyCmd || '(undetected)'}".`)

// ── Phase 2: CLARIFY — ask only on a GENUINE ambiguity ───────────────────────
phase('Clarify')
const haveAnswers = Object.keys(ANSWERS).length > 0
const answersBlock = haveAnswers
  ? `\n\nThe human has ALREADY answered these — treat as DECIDED, do not re-ask:\n${JSON.stringify(ANSWERS, null, 2)}`
  : ''
const clar = await agent(
  `Judge whether this request is specified well enough to plan a confident, correct implementation.
Request: ${REQUEST}
Repo grounding: ${JSON.stringify(repo)}${answersBlock}

Rate clarity honestly:
- "clear": exactly one sensible build.
- "design_decision": a real tradeoff exists, but a sensible default can be chosen and recorded.
- "ambiguous": genuinely under-specified — valid interpretations DIVERGE, a wrong guess is costly, OR the
  plausible approaches embed a USER-VISIBLE product tradeoff the request does not decide (e.g. silently
  dropping/altering user-facing data, changing an external behavior/contract). A product call is a human
  call (smoke 2026-06-11: a "clear"-looking improvement task burned three review rounds re-litigating
  tail-truncation data loss that one human line settles).
List ONLY genuine ambiguities (no busywork questions). Each gets a stable kebab id the human will answer under.${haveAnswers ? ' Since answers are provided, report "clear" unless a genuinely NEW divergence remains.' : ''}`,
  { model: THINK, phase: 'Clarify', label: 'clarify', schema: CLARITY_SCHEMA }
)
if (!clar) return { status: 'aborted', stage: 'clarify', request: REQUEST, note: 'Clarify agent returned nothing.' }

const askLevels = ASK_ON[POLICY] || ASK_ON.ask_on_ambiguity
const unresolved = (clar.ambiguities || []).filter((q) => q && q.id && !(q.id in ANSWERS))
if (unresolved.length && askLevels.includes(clar.clarity)) {
  log(`Pausing for a human decision: clarity=${clar.clarity}, ${unresolved.length} question(s).`)
  return {
    status: 'needs_human', request: REQUEST, clarity: clar.clarity, planId: PLAN_ID,
    questions: unresolved,
    resumeWith: { answers: unresolved.reduce((m, q) => (m[q.id] = '<your answer>', m), {}) },
    note: `Planning paused (policy ${POLICY}): the request is under-specified. Answer the question(s), then re-run camus-plan with the SAME request plus answers:{ "<id>": "<answer>" }. Decisions thread back into the plan.`,
  }
}
log(`Clarity=${clar.clarity}${haveAnswers ? ' (answers applied)' : ''}${clar.ambiguities && clar.ambiguities.length && !askLevels.includes(clar.clarity) ? ` — ${clar.ambiguities.length} open point(s) defaulted (recorded in the plan)` : ''}.`)

// ── Phase 3: ARCHITECT — design the change ───────────────────────────────────
phase('Architect')
const decisionGuidance = clar.clarity !== 'clear' && !haveAnswers
  ? `\nThere are open points we are NOT pausing for (policy ${POLICY}). Choose the most reasonable default for each and RECORD it in the overview/risks: ${JSON.stringify(clar.ambiguities)}`
  : (haveAnswers ? `\nHuman decisions to honor: ${JSON.stringify(ANSWERS)}` : '')
const arch = await agent(
  `Design the implementation for this request, grounded in the repo. Do NOT write code — design only.
Request: ${REQUEST}
Repo grounding: ${JSON.stringify(repo)}${decisionGuidance}

Produce a tight design: the overview, the contracts (interfaces/types/signatures), the data flow, the SAFE sequence
(additive first → destructive/renames → cleanup; the baseline type-check+tests must stay green between steps), and the risks.`,
  { model: THINK, phase: 'Architect', label: 'architect', schema: ARCH_SCHEMA }
)
if (!arch) return { status: 'aborted', stage: 'architect', request: REQUEST, note: 'Architect agent returned nothing.' }
log(`Architected: ${(arch.sequence || []).length} sequenced step(s).`)

// ── Phase 4: DECOMPOSE — to a camus-standard ordered task list ───────────────
phase('Decompose')
let plan = await agent(
  `Turn this design into an ORDERED camus-feat task list.
Request: ${REQUEST}
Design: ${JSON.stringify(arch)}
Repo grounding: ${JSON.stringify(repo)}

${STANDARDS}

Produce { feat, orderingNote, tasks[] }. Each task's "spec" is the EXACT, self-contained string camus-feat will hand to an
implementer — write it like the detailed specs an engineer would hand a junior: files, functions, signatures, behavior,
and the acceptance criteria. Prefer MORE, SMALLER tasks over a few large ones.`,
  { model: THINK, phase: 'Decompose', label: 'decompose', schema: PLAN_SCHEMA }
)
if (!plan) return { status: 'aborted', stage: 'decompose', request: REQUEST, note: 'Decompose agent returned nothing.' }
log(`Decomposed into ${plan.tasks.length} task(s). Critiquing…`)

// ── Phase 5: CRITIQUE — adversarial review of the plan, bounded refine loop ──
phase('Critique')
let critique = null
let critiqueInfra = false   // the critic produced nothing — plan is UNVERIFIED, never "clean"
for (let round = 1; round <= CRITIQUE_CAP; round++) {
  // Fresh reviewer each round (independence), judging by the SAME standards as Decompose.
  critique = await agent(
    `You are an adversarial PLAN reviewer. Find what is wrong with this plan; do not praise it.
Request: ${REQUEST}
Repo grounding: ${JSON.stringify(repo)}
Plan: ${JSON.stringify(plan)}

${STANDARDS}

Flag every task that violates a standard (oversized, ambiguous/under-specified spec, unverifiable acceptance, unsafe
ordering, or a missing step). verdict="ready" ONLY if every task meets the bar. Be specific: name the taskIndex and the fix.`,
    { model: THINK, phase: 'Critique', label: `critique:r${round}`, schema: CRITIQUE_SCHEMA }
  )
  if (!critique) {
    // INFRA: the critic returned nothing. NOT a clean verdict — never claim a verified-clean plan
    // off a failed critique (the gate's own infra≠findings discipline). Surfaced as a caveat below.
    critiqueInfra = true
    log(`Critique round ${round}/${CRITIQUE_CAP}: critic returned nothing (infra) — plan NOT verified clean.`)
    break
  }
  if (critique.verdict === 'ready') {
    log(`Critique round ${round}/${CRITIQUE_CAP}: READY${critique.score != null ? ` (score ${critique.score})` : ''}.`)
    break
  }
  // verdict is needs_revision. Empty issues = a MALFORMED verdict (says revise, names nothing) —
  // can't revise on it and can't trust it as clean; surface it as a caveat rather than pass it as ready.
  if (!(critique.issues || []).length) {
    log(`Critique round ${round}/${CRITIQUE_CAP}: needs_revision but NO issues listed (malformed) — surfacing as a caveat.`)
    break
  }
  log(`Critique round ${round}/${CRITIQUE_CAP}: ${critique.issues.length} issue(s) — revising.`)
  if (round === CRITIQUE_CAP) break   // last round: surface the remaining issues, don't revise into the void
  const revised = await agent(
    `Revise the plan to fix EVERY issue below. Keep the camus standards. Return the full revised { feat, orderingNote, tasks[] }.
Current plan: ${JSON.stringify(plan)}
Issues to fix: ${JSON.stringify(critique.issues)}

${STANDARDS}`,
    { model: THINK, phase: 'Critique', label: `revise:r${round}`, schema: PLAN_SCHEMA }
  )
  if (revised) plan = revised
}
// Caveats, computed honestly. A "ready" verdict ⇒ none. An infra/malformed critique ⇒ the plan was
// NOT verified clean ⇒ emit a SYNTHETIC issue so the result is planned_with_caveats — never a silent
// clean "planned" off a critique that did not actually run (the gate's infra≠clean rule, applied here).
let remainingIssues = []
if (critiqueInfra || !critique) {
  remainingIssues = [{ taskIndex: -1, severity: 'major',
    problem: 'Plan critique did not run (critic returned nothing) — the plan was NOT checked against the camus standards.',
    fix: 'Re-run camus-plan, or review the plan manually before trusting it.' }]
} else if (critique.verdict !== 'ready') {
  remainingIssues = (critique.issues || []).length ? critique.issues
    : [{ taskIndex: -1, severity: 'major',
        problem: 'Critic returned needs_revision but listed no issues (malformed verdict) — plan quality unverified.',
        fix: 'Re-run camus-plan, or review the plan manually before trusting it.' }]
}

// ── Phase 6: EMIT — write the plan (camus-feat args + readable .md) ───────────
phase('Emit')
// The camus-feat args are EXACTLY {feat, tasks:[spec strings]} — runnable verbatim. The per-task
// acceptance criteria are FOLDED INTO the spec string so they reach the gate: camus-loop's review
// already judges "does this change accomplish the task", and now it judges against an EXPLICIT,
// checkable bar (the planning rigor flows DOWN into the gate as data — not a pipeline re-run).
const featArgs = {
  feat: plan.feat,
  tasks: plan.tasks.map((t) => (t.acceptance && String(t.acceptance).trim())
    ? `${t.spec}\n\nAcceptance criteria — the change is only DONE when this holds (the reviewer must judge against it): ${t.acceptance}`
    : t.spec),
  ...(TARGET ? { targetPath: TARGET } : {}),
}
const planDoc = {
  planId: PLAN_ID,
  request: REQUEST,
  feat: plan.feat,
  orderingNote: plan.orderingNote || '',
  verifyCmd: repo.verifyCmd || '',
  clarity: clar.clarity,
  decisions: haveAnswers ? ANSWERS : {},
  openPointsDefaulted: (clar.clarity !== 'clear' && !haveAnswers) ? (clar.ambiguities || []) : [],
  remainingIssues,                 // critique issues still open after the cap (honest, never hidden)
  tasks: plan.tasks,               // full rich tasks (title/spec/files/acceptance/rationale)
  featArgs,                        // the exact object to pass to camus-feat
}
// Human-readable markdown — built by the script (deterministic), written verbatim by a thin agent.
const md = [
  `# Plan — ${plan.feat}`,
  ``,
  `> Request: ${REQUEST}`,
  ``,
  `Verify: \`${repo.verifyCmd || '(detect at run time)'}\` · clarity: ${clar.clarity}` + (remainingIssues.length ? ` · ⚠ ${remainingIssues.length} critique issue(s) left open` : ` · critique: ready`),
  plan.orderingNote ? `\nOrdering: ${plan.orderingNote}` : '',
  ...plan.tasks.map((t, i) => [
    ``,
    `## ${i + 1}. ${t.title}`,
    `**Files:** ${(t.files || []).join(', ') || '(discovered at implement time)'}`,
    `**Acceptance:** ${t.acceptance}`,
    t.rationale ? `**Why:** ${t.rationale}` : '',
    ``,
    t.spec,
  ].filter(Boolean).join('\n')),
  ``,
  `---`,
  `Run it:`,
  '```',
  `/camus-feat ${JSON.stringify(featArgs)}`,
  '```',
].filter((x) => x !== '').join('\n')

const emitRes = await agent(
  `Persist the Camus plan. Create directory ~/.camus/plans if missing, then write these TWO files EXACTLY (verbatim, byte-for-byte — do not reformat):

1) ${PLAN_JSON} :
${JSON.stringify(planDoc, null, 2)}

2) ${PLAN_MD} :
${md}

Return {written:true} once both files are on disk.`,
  { model: MODEL_RUNNER, phase: 'Emit', label: 'emit', schema: WRITTEN_SCHEMA }
)
// The plan files ARE the deliverable — a failed write must FAIL LOUD, not return "planned" with
// nothing on disk (Codex audit 2026-06-11). Never trust the write happened without confirmation.
if (!emitRes || emitRes.written !== true) {
  return { status: 'aborted', stage: 'emit', request: REQUEST, planId: PLAN_ID,
    note: `Plan files were NOT written to ${PLAN_JSON} (writer returned ${emitRes ? 'written:false' : 'nothing'}). The plan is the deliverable and nothing was saved — re-run camus-plan.` }
}

log(`Plan written → ${PLAN_JSON} (${plan.tasks.length} task(s)${remainingIssues.length ? `, ${remainingIssues.length} open critique issue(s)` : ''}).`)
return {
  status: remainingIssues.length ? 'planned_with_caveats' : 'planned',
  planId: PLAN_ID, planPath: PLAN_JSON, readablePath: PLAN_MD,
  feat: plan.feat, taskCount: plan.tasks.length,
  featArgs,                        // hand straight to camus-feat
  remainingIssues,
  note: `Plan ready at ${PLAN_JSON} (readable: ${PLAN_MD}). REVIEW it, edit if needed, then run camus-feat with featArgs.${remainingIssues.length ? ` NOTE: ${remainingIssues.length} critique issue(s) remained open after ${CRITIQUE_CAP} rounds — see remainingIssues before trusting the plan.` : ''}`,
}
