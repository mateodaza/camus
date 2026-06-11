// Reproducible coverage for camus-plan.workflow.js. Loads the REAL workflow and drives it with
// stubbed runtime globals (agent / phase / log). Verifies: the clarify ask-gate (needs_human on a
// genuine ambiguity, policy thresholds, answers suppress the re-ask), the critique→revise loop and
// its cap, the emit contract (featArgs = {feat, tasks:[spec strings]}), and the readable-plan write.
//
//   node test_plan_workflow.js     # exit 0 = all pass, 1 = a failure
const fs = require('fs')
const path = require('path')
const PLAN = path.join(__dirname, 'workflows', 'camus-plan.workflow.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function load(p) {
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  return new AsyncFunction('args', 'agent', 'phase', 'log', 'workflow', 'budget', src)
}
const key = (label) => (label || '').split(':')[0]

function makeAgent(scripts, calls, capture) {
  return async (p, opts = {}) => {
    const label = opts.label || opts.phase || '?'
    calls.push(label)
    if (capture) {
      capture.prompts = capture.prompts || {}
      capture.prompts[label] = p
      if (label === 'emit') capture.emit = p     // the persist prompt embeds both files verbatim
    }
    const s = (label in scripts) ? scripts[label] : scripts[key(label)]
    return typeof s === 'function' ? s() : s
  }
}
async function run(args, scripts) {
  const calls = []
  const capture = {}
  const res = await load(PLAN)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async () => { throw new Error('plan must not call workflow') }, undefined)
  return { res, calls, prompts: capture.prompts || {}, emit: capture.emit || '' }
}

const J = (o) => JSON.stringify(o)
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')) } }

// Reusable stubs
const ground = { ground: { verifyCmd: 'pnpm type-check && pnpm test', stack: 'node/ts', conventions: ['c1'], relevantFiles: ['src/a.ts'], notes: '' } }
const clear = { clarify: { clarity: 'clear', ambiguities: [] } }
const ambiguous = { clarify: { clarity: 'ambiguous', ambiguities: [{ id: 'which-db', question: 'Which DB?', why: 'diverges', options: ['pg', 'sqlite'] }] } }
const designDecision = { clarify: { clarity: 'design_decision', ambiguities: [{ id: 'cache', question: 'Cache?', why: 'tradeoff' }] } }
const arch = { architect: { overview: 'o', contracts: [], dataFlow: 'd', sequence: ['add x', 'rename y', 'cleanup'], risks: [] } }
const goodPlan = {
  feat: 'Do the thing',
  orderingNote: 'additive first',
  tasks: [
    { title: 'T1', spec: 'detailed spec one', files: ['src/a.ts'], acceptance: 'tsc passes', rationale: 'r1' },
    { title: 'T2', spec: 'detailed spec two', files: ['src/b.ts'], acceptance: 'grep clean', rationale: 'r2' },
  ],
}
const decompose = { decompose: goodPlan }
const critiqueReady = { critique: { verdict: 'ready', score: 92, issues: [] } }
const emitOk = { emit: { written: true } }

;(async () => {
  // P1: clear request → full pipeline → planned, with the right featArgs contract.
  {
    const { res, calls } = await run({ request: 'build a thing' },
      { ...ground, ...clear, ...arch, ...decompose, ...critiqueReady, ...emitOk })
    ok('P1 clear → planned', res.status === 'planned', res.status)
    ok('P1 ran all phases', ['ground', 'clarify', 'architect', 'decompose', 'critique', 'emit'].every((l) => calls.some((c) => c === l || c.startsWith(l + ':'))), calls.join(','))
    ok('P1 featArgs = {feat, tasks:[spec strings]}', !!res.featArgs && res.featArgs.feat === 'Do the thing'
      && Array.isArray(res.featArgs.tasks) && res.featArgs.tasks.length === 2
      && res.featArgs.tasks[0].startsWith('detailed spec one'), J(res.featArgs))
    ok('P1 acceptance folded into the task spec the gate sees', res.featArgs.tasks[0].includes('tsc passes') && res.featArgs.tasks[0].includes('Acceptance criteria'))
    ok('P1 taskCount surfaced', res.taskCount === 2)
  }

  // P2: ambiguous + default policy (ask_on_ambiguity) → needs_human BEFORE architect.
  {
    const { res, calls } = await run({ request: 'vague thing' }, { ...ground, ...ambiguous })
    ok('P2 ambiguous → needs_human', res.status === 'needs_human', res.status)
    ok('P2 question surfaced with id', Array.isArray(res.questions) && res.questions[0] && res.questions[0].id === 'which-db')
    ok('P2 resumeWith scaffold present', !!(res.resumeWith && res.resumeWith.answers && ('which-db' in res.resumeWith.answers)))
    ok('P2 architect NOT reached', !calls.includes('architect'))
  }

  // P3: ambiguous but autonomous policy → never pauses → planned (defaults recorded).
  {
    const { res } = await run({ request: 'vague thing', policy: 'autonomous' },
      { ...ground, ...ambiguous, ...arch, ...decompose, ...critiqueReady, ...emitOk })
    ok('P3 autonomous proceeds → planned', res.status === 'planned', res.status)
  }

  // P4: design_decision under default policy → does NOT pause (only ambiguous pauses by default).
  {
    const { res, calls } = await run({ request: 'tradeoff thing' },
      { ...ground, ...designDecision, ...arch, ...decompose, ...critiqueReady, ...emitOk })
    ok('P4 design_decision + ask_on_ambiguity → planned', res.status === 'planned', res.status)
    ok('P4 architect reached (no pause)', calls.includes('architect'))
  }
  // P4b: design_decision under ask_on_major → pauses.
  {
    const { res } = await run({ request: 'tradeoff thing', policy: 'ask_on_major' }, { ...ground, ...designDecision })
    ok('P4b design_decision + ask_on_major → needs_human', res.status === 'needs_human', res.status)
  }

  // P5: answers provided on resume → ambiguity treated as decided → no re-ask → planned.
  {
    const stillClearWithAnswer = { clarify: { clarity: 'clear', ambiguities: [] } }
    const { res, calls } = await run({ request: 'vague thing', answers: { 'which-db': 'pg' } },
      { ...ground, ...stillClearWithAnswer, ...arch, ...decompose, ...critiqueReady, ...emitOk })
    ok('P5 answers → no re-ask → planned', res.status === 'planned', res.status)
    ok('P5 architect ran', calls.includes('architect'))
  }

  // P6: critique finds issues → revise once → second critique ready → planned (clean).
  {
    let critN = 0
    const critiqueThenReady = () => (++critN === 1
      ? { verdict: 'needs_revision', score: 60, issues: [{ taskIndex: 0, severity: 'major', problem: 'oversized', fix: 'split' }] }
      : { verdict: 'ready', score: 90, issues: [] })
    const revisedPlan = { decompose: goodPlan, revise: { ...goodPlan, tasks: [...goodPlan.tasks, { title: 'T3', spec: 's3', files: ['c.ts'], acceptance: 'ok' }] } }
    const { res, calls } = await run({ request: 'needs split' },
      { ...ground, ...clear, ...arch, decompose: revisedPlan.decompose, revise: revisedPlan.revise, critique: critiqueThenReady, ...emitOk })
    ok('P6 revise ran on needs_revision', calls.some((c) => c.startsWith('revise')))
    ok('P6 re-critique cleared → planned', res.status === 'planned', res.status)
    ok('P6 revised plan used (3 tasks)', res.taskCount === 3, String(res.taskCount))
  }

  // P7: critique never clears within the cap → planned_with_caveats, issues surfaced honestly.
  {
    const alwaysBad = { critique: { verdict: 'needs_revision', score: 40, issues: [{ taskIndex: -1, severity: 'major', problem: 'ordering unsafe', fix: 'reorder' }] } }
    const { res, calls } = await run({ request: 'stubborn' },
      { ...ground, ...clear, ...arch, ...decompose, ...alwaysBad, revise: goodPlan, ...emitOk })
    ok('P7 unresolved critique → planned_with_caveats', res.status === 'planned_with_caveats', res.status)
    ok('P7 remaining issues surfaced', Array.isArray(res.remainingIssues) && res.remainingIssues.length === 1)
    ok('P7 critique ran exactly CRITIQUE_CAP=2 times', calls.filter((c) => c.startsWith('critique')).length === 2, calls.join(','))
    ok('P7 no revise on the FINAL round (no void revision)', calls.filter((c) => c.startsWith('revise')).length === 1)
  }

  // P10 (Codex audit 2026-06-11): a critic that returns NOTHING (infra) must NOT pass as a clean
  // plan — the gate's own infra≠clean rule, applied to the planner.
  {
    const { res } = await run({ request: 'crit dies' },
      { ...ground, ...clear, ...arch, ...decompose, critique: null, ...emitOk })
    ok('P10 null critique → planned_with_caveats (NOT a clean planned)', res.status === 'planned_with_caveats', res.status)
    ok('P10 synthetic infra issue surfaced', Array.isArray(res.remainingIssues) && res.remainingIssues.length === 1
      && /did not run/.test(res.remainingIssues[0].problem || ''))
  }
  // P11: verdict needs_revision but EMPTY issues (malformed) → caveats, not a silent clean planned.
  {
    const malformed = { critique: { verdict: 'needs_revision', score: 50, issues: [] } }
    const { res } = await run({ request: 'malformed crit' },
      { ...ground, ...clear, ...arch, ...decompose, ...malformed, ...emitOk })
    ok('P11 needs_revision + empty issues → planned_with_caveats', res.status === 'planned_with_caveats', res.status)
    ok('P11 malformed-verdict caveat surfaced', res.remainingIssues.length === 1 && /malformed/.test(res.remainingIssues[0].problem || ''))
  }
  // P12: the plan files ARE the deliverable — a failed write must FAIL LOUD (aborted/stage:emit),
  // not return "planned" with nothing on disk.
  {
    const { res } = await run({ request: 'write fails' },
      { ...ground, ...clear, ...arch, ...decompose, ...critiqueReady, emit: { written: false } })
    ok('P12 emit written:false → aborted/emit', res.status === 'aborted' && res.stage === 'emit', res.status + '/' + res.stage)
  }
  {
    const { res } = await run({ request: 'write null' },
      { ...ground, ...clear, ...arch, ...decompose, ...critiqueReady, emit: null })
    ok('P12 emit null → aborted/emit', res.status === 'aborted' && res.stage === 'emit', res.status + '/' + res.stage)
  }

  // P8: the emit prompt embeds the runnable camus-feat command + the readable plan.
  {
    const { emit } = await run({ request: 'embed check' },
      { ...ground, ...clear, ...arch, ...decompose, ...critiqueReady, ...emitOk })
    ok('P8 emit writes the json plan path', emit.includes('.camus/plans/'))
    ok('P8 emit embeds a runnable /camus-feat command', emit.includes('/camus-feat {') && emit.includes('"detailed spec one"'))
    ok('P8 emit includes acceptance criteria in the readable plan', emit.includes('Acceptance:'))
  }

  // P9: missing request → throws (the one hard precondition).
  {
    let threw = false
    try { await run({}, {}) } catch (_) { threw = true }
    ok('P9 missing request throws', threw)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
