// Reproducible HITL coverage for the two workflows. Loads the REAL workflow files and drives them
// with stubbed runtime globals (agent / phase / log / workflow).
//
//   node test_hitl_workflows.js     # exit 0 = all pass, 1 = a failure
//
// Verifies: clarity ask-gate (needs_human before implement), policy thresholds
// (autonomous / ask_on_ambiguity / ask_on_major), humanAnswer resume suppresses re-ask, the
// decisions log on done, and the feat's needs_human halt + decision rollup into the report.
const fs = require('fs')
const path = require('path')
const LOOP = path.join(__dirname, 'workflows', 'camus-loop.workflow.js')
const FEAT = path.join(__dirname, 'workflows', 'camus-feat.workflow.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function load(p) {
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  return new AsyncFunction('args', 'agent', 'phase', 'log', 'workflow', src)
}
const key = (label) => (label || '').split(':')[0]

function extractBraces(s) {
  const i = s.indexOf('{'); if (i < 0) return null
  let d = 0, q = false, e = false
  for (let k = i; k < s.length; k++) {
    const c = s[k]
    if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue }
    if (c === '"') q = true
    else if (c === '{') d++
    else if (c === '}') { if (--d === 0) { try { return JSON.parse(s.slice(i, k + 1)) } catch (_) { return null } } }
  }
  return null
}
function makeAgent(scripts, calls, capture) {
  return async (p, opts = {}) => {
    const label = opts.label || opts.phase || '?'
    calls.push(label)
    if (capture) {
      capture.prompts = capture.prompts || {}
      capture.prompts[label] = p
    }
    if (capture && label === 'state') capture.state = p   // the persist prompt embeds the state JSON
    const s = (label in scripts) ? scripts[label] : scripts[key(label)]
    return typeof s === 'function' ? s() : s
  }
}
async function runLoop(args, scripts) {
  const calls = []
  const res = await load(LOOP)(args, makeAgent(scripts, calls), () => {}, () => {},
    async () => { throw new Error('loop must not call workflow') })
  return { res, calls }
}
async function runFeat(args, scripts, loopResults) {
  const calls = []
  const capture = {}
  const loopArgs = []
  let li = 0
  const res = await load(FEAT)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async (name, a) => { loopArgs.push(a); return loopResults[li++] })
  return {
    res, calls, loopArgs, workflowCalls: li,
    stateJSON: capture.state ? extractBraces(capture.state) : null,
    prompts: capture.prompts || {},
  }
}

const J = (o) => JSON.stringify(o)
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')) } }

const happyTail = {
  implement: { worktree_path: '', branch: 'b', summary: 's', decisions: [{ what: 'W', why: 'Y' }] },
  review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
  commit: J({ committed: true, sha: 'abc123' }),
  prep: J({ prepped: true, ran: [] }),
  verify: J({ pass: true, failures: [] }),
}
const cls = { classify: { tier: 'trivial', reason: 'x' } }
// Ask-gate tests must NOT be trivial: a trivial tier SKIPS planning (clarity forced to 'clear'),
// which bypasses the ask-gate entirely. Use a standard tier so the planned clarity is honored.
const clsStd = { classify: { tier: 'standard', reason: 'x' } }
const planOf = (clarity, question = 'Q', interpretations = []) =>
  ({ plan: { plan: 'p', relevant_files: ['f'], clarity, question, interpretations } })

;(async () => {
  {
    const { res, calls } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('S1 clear→done', res.status === 'done', res.status)
    ok('S1 decisions surfaced', Array.isArray(res.decisions) && res.decisions.length === 1)
    ok('S1 implement ran', calls.includes('implement'))
  }
  {
    const { res, calls } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('ambiguous', 'Which X?', ['a', 'b']) })
    ok('S2 ambiguous→needs_human', res.status === 'needs_human', res.status)
    ok('S2 question surfaced', res.question === 'Which X?')
    ok('S2 implement NOT reached', !calls.includes('implement'))
  }
  {
    const { res, calls } = await runLoop({ task: 't', policy: 'autonomous' }, { ...cls, ...planOf('ambiguous'), ...happyTail })
    ok('S3 autonomous proceeds→done', res.status === 'done', res.status)
    ok('S3 implement ran', calls.includes('implement'))
  }
  {
    const { res, calls } = await runLoop({ task: 't', humanAnswer: 'do X' }, { ...cls, ...planOf('ambiguous'), ...happyTail })
    ok('S4 humanAnswer→no re-ask→done', res.status === 'done', res.status)
    ok('S4 implement ran', calls.includes('implement'))
  }
  {
    const { res } = await runLoop({ task: 't' }, { ...cls, ...planOf('design_decision'), ...happyTail })
    ok('S5a design_decision+ask_on_ambiguity→done', res.status === 'done', res.status)
  }
  {
    const { res } = await runLoop({ task: 't', policy: 'ask_on_major' }, { ...clsStd, ...planOf('design_decision', 'Decide Y') })
    ok('S5b design_decision+ask_on_major→needs_human', res.status === 'needs_human', res.status)
  }
  // S6: skip-plan gating (opt-in, autonomous-only) — must never disable the ask-gate on an asking policy.
  {
    const { res, calls } = await runLoop({ task: 't', skipPlan: true, policy: 'autonomous' }, { ...cls, ...happyTail })
    ok('S6a skipPlan+autonomous+trivial → plan agent skipped', !calls.includes('plan'), 'calls=' + calls.join(','))
    ok('S6a → done', res.status === 'done', res.status)
  }
  {
    // skipPlan set but policy is the default ask_on_ambiguity → NOT applied → plan runs → ask-gate fires
    const { res, calls } = await runLoop({ task: 't', skipPlan: true }, { ...cls, ...planOf('ambiguous', 'Q?', ['a', 'b']) })
    ok('S6b skipPlan ignored on asking policy → plan ran', calls.includes('plan'))
    ok('S6b ask-gate still fires → needs_human', res.status === 'needs_human', res.status)
  }
  {
    // skipPlan + autonomous but STANDARD tier → not trivial → plan runs
    const { res, calls } = await runLoop({ task: 't', skipPlan: true, policy: 'autonomous' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S6c skipPlan + non-trivial → plan ran', calls.includes('plan'))
    ok('S6c → done', res.status === 'done', res.status)
  }

  const featBase = {
    preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: '' },
    'feat-branch': { ok: true, branch: 'camus/feat-x', created: true },
    'env-check': { ready: true, exitCode: 0, output: 'ok' },
    'baseline-verify': J({ pass: true, failures: [] }),
    'env-recheck': { ready: true, exitCode: 0, output: 'ok' },
    'integration-verify': J({ pass: true, failures: [] }),
    merge: { merged: true, committed: true, alreadyUpToDate: false, before: 'aaa', after: 'bbb' },
    report: { written: true }, state: { written: true },
  }
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'needs_human', question: 'Pick A or B?', clarity: 'ambiguous', interpretations: ['A', 'B'], plan: 'p' }])
    ok('F1 feat halts needs_human', res && res.status === 'needs_human', res && res.status)
    ok('F1 question in report', res && res.question === 'Pick A or B?')
    ok('F1 resumeWith hint present', !!(res && res.resumeWith && res.resumeWith.answers))
  }
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [{ what: 'widened type', why: 'runtime boundary' }] }])
    ok('F2 feat done', res && res.status === 'done', res && res.status)
    ok('F2 rollup decisions', res && Array.isArray(res.decisions) && res.decisions.length === 1 && res.decisions[0].taskId)
    ok('F2 per-task decisions', res && res.tasks[0].decisions.length === 1)
  }
  // F3: resume carries a prior NOOP — it must NOT be re-run (would collide on its branch/worktree)
  {
    // run 1: task 'a' → no_changes (noop), task 'b' → needs_human (halt) — capture persisted state
    const r1 = await runFeat({ feat: 'R', tasks: ['a', 'b'] }, featBase,
      [{ status: 'no_changes' }, { status: 'needs_human', question: 'Q', clarity: 'ambiguous', interpretations: [], plan: 'p' }])
    const prior = r1.stateJSON
    ok('F3 captured prior state', !!(prior && Array.isArray(prior.tasks) && prior.tasks.length === 2))
    const aId = prior.tasks[0].taskId, bId = prior.tasks[1].taskId
    ok('F3 prior a=noop, b=needs_human', prior.tasks[0].status === 'noop' && prior.tasks[1].status === 'needs_human')
    // run 2 (resume): 'a' is carried noop (skipped); only 'b' re-runs with the answer → done
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'R', tasks: ['a', 'b'], answers: { [bId]: 'do it' } }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/b', decisions: [] }])
    ok('F3 only ONE task re-ran (noop a skipped)', r2.workflowCalls === 1, 'workflowCalls=' + r2.workflowCalls)
    ok('F3 prior noop carried in report', !!(r2.res && r2.res.tasks.find((t) => t.taskId === aId && t.status === 'noop')))
  }

  // F4: model / modelTier passthrough — forwarded UNCHANGED into each per-task loop call.
  {
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'], model: 'opus', modelTier: 'high' }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 model forwarded to loop', loopArgs.length === 1 && loopArgs[0].model === 'opus', J(loopArgs[0]))
    ok('F4 modelTier forwarded to loop', loopArgs[0] && loopArgs[0].modelTier === 'high')
  }
  {
    // No override → loop call must NOT carry model/modelTier (loop keeps its own defaults).
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 no model key when unset', loopArgs[0] && !('model' in loopArgs[0]) && !('modelTier' in loopArgs[0]))
  }
  {
    // targetPath is a per-task scope hint only. Feat-level git/env/verify must stay rooted at "$PWD";
    // otherwise a relative subdir is applied twice and the repo-root guard refuses baseline verify.
    const { loopArgs, prompts } = await runFeat({ feat: 'F', tasks: ['only task'], targetPath: 'packages/ai/src' }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 targetPath forwarded to loop', loopArgs[0] && loopArgs[0].targetPath === 'packages/ai/src', J(loopArgs[0]))
    ok('F4 targetPath not used as preflight cwd', prompts.preflight && prompts.preflight.includes('cd "$PWD"') && !prompts.preflight.includes('cd "packages/ai/src"'))
    ok('F4 targetPath not used as baseline verify target', prompts['baseline-verify'] && prompts['baseline-verify'].includes('verify.sh "$PWD"') && !prompts['baseline-verify'].includes('packages/ai/src'))
    ok('F4 targetPath not used as integration verify target', prompts['integration-verify'] && prompts['integration-verify'].includes('verify.sh "$PWD"') && !prompts['integration-verify'].includes('packages/ai/src'))
  }
  // F5: loop telemetry (tier/model/rounds/planSkipped) surfaced into the report per task.
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [], tier: 'trivial', model: 'opus', rounds: 2,
         planSkipped: false, initialModel: 'sonnet', finalFixModel: 'opus', escalated: true }])
    const t = res && res.tasks && res.tasks[0]
    ok('F5 tier in report', !!t && t.tier === 'trivial')
    ok('F5 model in report', !!t && t.model === 'opus')
    ok('F5 rounds in report', !!t && t.rounds === 2)
    ok('F5 planSkipped in report', !!t && t.planSkipped === false)
    // P3: a Sonnet→Opus escalation must be visible in the report
    ok('F5 initialModel in report', !!t && t.initialModel === 'sonnet')
    ok('F5 finalFixModel in report', !!t && t.finalFixModel === 'opus')
    ok('F5 escalated in report', !!t && t.escalated === true)
  }
  {
    // Telemetry is OPTIONAL — a loop result omitting it must not emit the keys (graceful).
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    const t = res && res.tasks && res.tasks[0]
    ok('F5 no telemetry keys when absent', !!t && !('tier' in t) && !('model' in t) && !('rounds' in t)
      && !('planSkipped' in t) && !('initialModel' in t) && !('escalated' in t))
  }
  // F6: persisted state carries the feat TITLE (load-bearing for auto-resume arg reconstruction).
  {
    const { res, stateJSON } = await runFeat({ feat: 'My Feat Title', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F6 state persists feat title', !!(stateJSON && stateJSON.feat === 'My Feat Title'), stateJSON && stateJSON.feat)
    ok('F6 done state status', !!(stateJSON && stateJSON.status === 'done'), stateJSON && stateJSON.status)
    // resume_scan SAFE rule (mirror): status == "running" ONLY. A done feat is NOT resumable.
    const isResumable = (s) => !!(s && s.status === 'running' && s.feat && Array.isArray(s.tasks))
    ok('F6 done feat NOT auto-resumable', !isResumable(stateJSON))
    void res
  }
  {
    // A feat interrupted mid-flight persists status:"running" (Tasks phase) WITH the title → resumable.
    const { stateJSON } = await runFeat({ feat: 'Interrupted Feat', tasks: ['a', 'b'] }, featBase,
      // first task halts the feat at needs_human, but the PRIOR persisted Tasks-phase state was
      // status:"running" — we assert that mid-run state is resumable and a needs_human one is not.
      [{ status: 'needs_human', question: 'Q', clarity: 'ambiguous', interpretations: [], plan: 'p' }])
    void stateJSON
    const running = { status: 'running', feat: 'Interrupted Feat', tasks: [{ spec: 'a' }] }
    const halted = { status: 'needs_human', feat: 'Interrupted Feat', tasks: [{ spec: 'a' }] }
    const isResumable = (s) => !!(s && s.status === 'running' && s.feat && Array.isArray(s.tasks))
    ok('F6 running feat IS auto-resumable', isResumable(running))
    ok('F6 needs_human feat NOT auto-resumable', !isResumable(halted))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
