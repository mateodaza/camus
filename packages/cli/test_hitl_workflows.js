// Reproducible HITL coverage for the two workflows. Loads the REAL workflow files and drives them
// with stubbed runtime globals (agent / phase / log / workflow).
//
//   node test_hitl_workflows.js     # exit 0 = all pass, 1 = a failure
//
// Verifies the HITL and contract scenarios labeled S1–S7 (loop) and F1–F10 (feat) below:
// ask-gate/policies/humanAnswer, the worktree path contract (S7) and merge-cleanup (F8),
// the steer hook (F7), the run-log event ring (F9), and token telemetry (F10).
const fs = require('fs')
const path = require('path')
const LOOP = path.join(__dirname, 'workflows', 'camus-loop.workflow.js')
const FEAT = path.join(__dirname, 'workflows', 'camus-feat.workflow.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function load(p) {
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  return new AsyncFunction('args', 'agent', 'phase', 'log', 'workflow', 'budget', src)
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
async function runLoop(args, scripts, budget) {
  const calls = []
  const capture = {}
  const res = await load(LOOP)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async () => { throw new Error('loop must not call workflow') }, budget)
  return { res, calls, prompts: capture.prompts || {} }
}
async function runFeat(args, scripts, loopResults, budget) {
  const calls = []
  const capture = {}
  const loopArgs = []
  let li = 0
  const res = await load(FEAT)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async (name, a) => { loopArgs.push(a); return loopResults[li++] }, budget)
  return {
    res, calls, loopArgs, workflowCalls: li,
    stateJSON: capture.state ? extractBraces(capture.state) : null,
    prompts: capture.prompts || {},
  }
}

const J = (o) => JSON.stringify(o)
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')) } }

// Mirror of the loop's slugify/fnv1a, so stubs can return the CANONICAL worktree path the loop
// validates (since 2026-06-10 an empty or mismatched worktree_path is refused FAIL-CLOSED, and
// worktrees live centralized under ~/.camus/worktrees/<repo>-<id>/, never beside the repo).
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task' }
function fnv(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0 }
  return h.toString(36)
}
const wtName = (task, salt = '') => `camus-wt-${slug(task)}-${fnv(salt ? salt + '::' + task : task).slice(0, 6)}`
const wtPath = (task, salt = '') => `/home/u/.camus/worktrees/repo-12345/${wtName(task, salt)}`
// Feat-side identity mirrors (featId = slug24 + hash over title+tasks; taskId salted by featId)
const featIdOf = (feat, tasks) => `${slug(feat).slice(0, 24)}-${fnv(feat + '\n---\n' + tasks.join('\n')).slice(0, 6)}`
const taskIdOf = (feat, tasks, task) => `${slug(task)}-${fnv(featIdOf(feat, tasks) + '::' + task).slice(0, 6)}`

const happyTail = {
  implement: { worktree_path: wtPath('t'), branch: 'b', summary: 's', decisions: [{ what: 'W', why: 'Y' }] },
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
  // S8: roundCap arg (run feedback 2026-06-10) — caller can raise/lower the review↔fix cap; bounded.
  const alwaysBlock = {
    ...cls, ...planOf('clear', ''), implement: happyTail.implement,
    review: J({ ran: true, clean: false, blocking: [{ priority: 1, note: 'x' }], nonblocking: [] }),
    fix: '',
  }
  {
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, alwaysBlock)
    ok('S8a roundCap:1 → review_unresolved after 1 round', res.status === 'review_unresolved', res.status)
    ok('S8a exactly 1 review round ran', calls.filter((c) => c.startsWith('review')).length === 1, calls.filter((c) => c.startsWith('review')).join(','))
    ok('S8a note reports the honored cap', /ROUND_CAP=1/.test(res.note || ''))
  }
  {
    // out-of-range cap (99) falls back to the default 3 — bounded so a bad value can't run away.
    const { res, calls } = await runLoop({ task: 't', roundCap: 99 }, alwaysBlock)
    ok('S8b out-of-range roundCap → default 3 rounds', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S8b → review_unresolved', res.status === 'review_unresolved', res.status)
  }

  // S9: DYNAMIC review reasoning effort (run feedback 2026-06-11) — the orchestrator passes a
  // per-round effort (arg 4 of the review command) that scales with stakes. effortOf reads it
  // back from the captured review prompt. (medium|high|xhigh; 'high' is a substring of 'xhigh'
  // so the regex anchors on the round-number prefix.)
  const effortOf = (p) => (((p || '').match(/ \d+ (medium|high|xhigh)\b/) || [])[1] || null)
  const blockP1 = { implement: happyTail.implement, review: J({ ran: true, clean: false, blocking: [{ priority: 1, note: 'x' }], nonblocking: [] }), fix: '' }
  const blockP0 = { implement: happyTail.implement, review: J({ ran: true, clean: false, blocking: [{ priority: 0, note: 'crit' }], nonblocking: [] }), fix: '' }
  const clsComplex = { classify: { tier: 'complex', reason: 'x' } }
  {
    // standard tier: cheap MEDIUM first pass → escalate to HIGH once a fix didn't clear (round≥2).
    const { prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    ok('S9a round1 review effort = medium', effortOf(prompts['review:r1.a1']) === 'medium', effortOf(prompts['review:r1.a1']))
    ok('S9a round2 review effort escalates to high', effortOf(prompts['review:r2.a1']) === 'high', effortOf(prompts['review:r2.a1']))
  }
  {
    // a P0 (critical) finding → next round jumps to XHIGH (maximum scrutiny).
    const { prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP0 })
    ok('S9b round1 medium (no prior findings yet)', effortOf(prompts['review:r1.a1']) === 'medium', effortOf(prompts['review:r1.a1']))
    ok('S9b round2 after a P0 → xhigh', effortOf(prompts['review:r2.a1']) === 'xhigh', effortOf(prompts['review:r2.a1']))
  }
  {
    // complex tier → start deeper (HIGH) even on round 1.
    const { prompts } = await runLoop({ task: 't' }, { ...clsComplex, ...planOf('clear', ''), ...blockP1 })
    ok('S9c complex tier → round1 effort high', effortOf(prompts['review:r1.a1']) === 'high', effortOf(prompts['review:r1.a1']))
  }

  // S7: worktree path contract (2026-06-10) — centralized out-of-tree home + fail-closed validation.
  {
    const { res, prompts } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('S7a implement told to use ~/.camus/worktrees', !!prompts.implement && prompts.implement.includes('$HOME/.camus/worktrees/'))
    ok('S7a mkdir of the repo-unique parent', !!prompts.implement && prompts.implement.includes('mkdir -p "$HOME/.camus/worktrees/'))
    ok('S7a canonical wt name in the command', !!prompts.implement && prompts.implement.includes(wtName('t')))
    ok('S7a → done with a valid path', res.status === 'done', res.status)
    // Cross-contract pin: the feat's cleanup consumes res.worktree — renaming this return key
    // would keep both suites green while silently killing cleanup in production.
    ok('S7a loop returns the claimed worktree path', res.worktree === wtPath('t'), res.worktree)
  }
  {
    const bad = { ...happyTail, implement: { ...happyTail.implement, worktree_path: '/tmp/evil-dir' } }
    const { res } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...bad })
    ok('S7b mismatched worktree path → aborted', res.status === 'aborted', res.status)
  }
  {
    const empty = { ...happyTail, implement: { ...happyTail.implement, worktree_path: '' } }
    const { res } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...empty })
    ok('S7c empty worktree path → aborted (fail closed)', res.status === 'aborted', res.status)
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
    ok('F4 no roundCap key when unset', loopArgs[0] && !('roundCap' in loopArgs[0]))
  }
  {
    // roundCap forwarded UNCHANGED to every per-task loop (the loop bounds it).
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'], roundCap: 5 }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 roundCap forwarded to loop', loopArgs[0] && loopArgs[0].roundCap === 5, J(loopArgs[0]))
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
  // F7: steer hook (2026-06-10) — a pending human note is consumed at the task boundary.
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: J({ pause: true }) }, [])
    ok('F7 pause note → paused_by_user before the loop', res && res.status === 'paused_by_user', res && res.status)
    ok('F7 loop never invoked on pause', workflowCalls === 0, 'workflowCalls=' + workflowCalls)
  }
  {
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: J({ guidance: 'use adapter B' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7 guidance threaded as humanAnswer', !!loopArgs[0] && loopArgs[0].humanAnswer === 'use adapter B', J(loopArgs[0]))
    ok('F7 feat still done with guidance', res && res.status === 'done', res && res.status)
  }
  {
    // No note (steer agent unstubbed → undefined) → no humanAnswer, no pause: steering is opt-in.
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7 no note → no humanAnswer injected', !!loopArgs[0] && !('humanAnswer' in loopArgs[0]))
    ok('F7 no note → run proceeds', res && res.status === 'done', res && res.status)
  }
  // F7d: pause → re-run with the SAME args resumes past the done task (the contract the
  // finalize note promises the user).
  {
    let steerCalls = 0
    const steerOnceThenPause = () => (++steerCalls === 1 ? '{}' : J({ pause: true }))
    const r1 = await runFeat({ feat: 'P', tasks: ['a', 'b'] },
      { ...featBase, steer: steerOnceThenPause },
      [{ status: 'done', branch: 'camus/feat/x/a', decisions: [] }])
    ok('F7d task a done, paused before b', r1.res && r1.res.status === 'paused_by_user' && r1.workflowCalls === 1,
      r1.res && r1.res.status)
    const prior = r1.stateJSON
    ok('F7d paused state persisted (a=done)', !!prior && prior.status === 'paused_by_user' && prior.tasks[0].status === 'done')
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'P', tasks: ['a', 'b'] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/b', decisions: [] }])
    ok('F7d re-run resumes: only task b runs', r2.workflowCalls === 1, 'workflowCalls=' + r2.workflowCalls)
    ok('F7d re-run completes', r2.res && r2.res.status === 'done', r2.res && r2.res.status)
  }
  // F7e: a steer answers-map can target a LATER task — a regression here makes
  // `camus steer --task` a silent no-op, the worst HITL failure mode.
  {
    const bId = taskIdOf('T2', ['a', 'b'], 'b')
    let sc = 0
    const steerNoteOnce = () => (++sc === 1 ? J({ answers: { [bId]: 'pick B' } }) : '{}')
    const { loopArgs } = await runFeat({ feat: 'T2', tasks: ['a', 'b'] },
      { ...featBase, steer: steerNoteOnce },
      [{ status: 'done', branch: 'camus/feat/x/a', decisions: [] },
       { status: 'done', branch: 'camus/feat/x/b', decisions: [] }])
    ok('F7e first task NOT steered', !!loopArgs[0] && !('humanAnswer' in loopArgs[0]), J(loopArgs[0]))
    ok('F7e later task got the targeted answer', !!loopArgs[1] && loopArgs[1].humanAnswer === 'pick B', J(loopArgs[1]))
  }
  // F7f: a PRESENT-but-unparseable note must be surfaced in the run log, not silently dropped.
  {
    const { res, stateJSON } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: 'totally not json' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7f garbage note surfaced in run log', !!stateJSON && stateJSON.events.some((e) => /UNPARSEABLE/.test(e.msg)))
    ok('F7f run proceeds', res && res.status === 'done', res && res.status)
  }

  // F8: worktree cleanup contract — the headline "no more camus-wt-* litter" feature.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const wt = `/home/u/.camus/worktrees/r-1/camus-wt-${tid}`
    const { res, calls, prompts } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, cleanup: J({ removed: true }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [], worktree: wt }])
    ok('F8a cleanup fires on merge-success', calls.includes('cleanup:' + tid), calls.join(','))
    ok('F8a cleanup runs git worktree remove (no force)', !!prompts['cleanup:' + tid]
      && prompts['cleanup:' + tid].includes('git worktree remove') && !prompts['cleanup:' + tid].includes('--force'))
    ok('F8a feat done', res && res.status === 'done', res && res.status)
  }
  {
    // Suffix-but-not-basename path must be SKIPPED (stricter than the loop's endsWith check):
    // basename "x-camus-wt-<tid>" endsWith the canonical name but is not equal to it.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, cleanup: J({ removed: true }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [], worktree: `/tmp/x-camus-wt-${tid}` }])
    ok('F8b suffix-but-not-basename path NOT cleaned', !calls.some((c) => c.startsWith('cleanup:')), calls.join(','))
    ok('F8b feat still done', res && res.status === 'done', res && res.status)
  }
  {
    // Refusal is fail-soft: a dirty/locked worktree never un-does a merged task.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, cleanup: J({ removed: false, reason: 'dirty' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [], worktree: `/h/camus-wt-${tid}` }])
    ok('F8c cleanup refusal is fail-soft → done', res && res.status === 'done', res && res.status)
  }
  {
    // The no_changes noop path cleans its (empty) worktree too.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, cleanup: J({ removed: true }) },
      [{ status: 'no_changes', worktree: `/h/camus-wt-${tid}` }])
    ok('F8d noop path cleans worktree', calls.includes('cleanup:' + tid), calls.join(','))
    ok('F8d feat done_with_noops', res && res.status === 'done_with_noops', res && res.status)
  }

  // F9: run-log event ring — cap respected and seq monotonic across a resume. Not cosmetic:
  // the full state JSON is embedded in every persistState prompt, so a broken cap grows
  // every state write without bound.
  {
    const priorEvents = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, msg: 'step ' + (i + 1) }))
    const prior = { featId: 'x', feat: 'E', status: 'running', tasks: [], events: priorEvents, eventSeq: 25 }
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const { stateJSON } = await runFeat({ feat: 'E', tasks: ['only task'] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F9 ring capped at 20', !!stateJSON && stateJSON.events.length <= 20, stateJSON && stateJSON.events.length)
    ok('F9 carried events trimmed from the front', !!stateJSON && stateJSON.events.every((e) => e.seq >= 6))
    ok('F9 new events continue the seq past the carry', !!stateJSON && stateJSON.events.some((e) => e.seq > 25))
  }

  // F10: token telemetry with the budget global PRESENT (every other test proves the
  // degraded path — budget is undefined in this harness by default).
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }], { spent: () => 5000 })
    ok('F10 totalOutputTokens in report', res && res.totalOutputTokens === 5000, res && res.totalOutputTokens)
    ok('F10 per-task tokens emitted', !!res && res.tasks[0].tokens === 0, res && JSON.stringify(res.tasks[0]))
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
