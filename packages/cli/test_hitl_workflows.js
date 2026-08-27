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
  // Production workflows have no process/env authority. Shadow Node's global explicitly so a
  // test cannot accidentally make ambient state available to code that production cannot read.
  return new AsyncFunction('args', 'agent', 'phase', 'log', 'workflow', 'budget', 'process', src)
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
    if (capture && label === 'state') {
      capture.state = p   // the persist prompt embeds the state JSON (last write wins)
      ;(capture.states = capture.states || []).push(p)   // …and EVERY persist, for intermediate-state assertions
    }
    if (capture && label === 'args') capture.args = p
    const s = (label in scripts) ? scripts[label] : scripts[key(label)]
    const out = typeof s === 'function' ? s(p, opts) : s
    // A REAL reviewer publishes the binding of the invocation it actually ran
    // (round, effort, model, backend, nonce, worktree) on stdout, and asGate now
    // refuses a verdict without one. So the harness's reviewer echoes a FAITHFUL
    // binding parsed from the command the workflow composed — realistic fixtures,
    // not a weakened asGate. A fixture that sets its own `binding` (a break test)
    // is left exactly as written; a `pending` handle is not a verdict.
    if (key(label) === 'review') return bindReviewOutput(out, p)
    // A SCHEMA'd agent returns the validated OBJECT in production (agent(..., {schema})), not
    // text. Mirror that so fixtures can exercise the maker-resolutions path faithfully.
    if (opts.schema && typeof out === 'string' && out.trim().startsWith('{')) {
      try { return JSON.parse(out) } catch (_) { return out }
    }
    return out
  }
}
// Attach a faithful binding to a reviewer verdict, parsed from the workflow's own
// review command in the prompt. The values are what the gate would truly have run
// with, so asGate accepts them; a mismatch is only ever produced by a break-test
// fixture that supplies its own binding.
let lastStartBinding = null
function bindReviewOutput(out, prompt) {
  if (typeof out !== 'string') return out
  let g
  try { g = JSON.parse(out) } catch (_) { return out }
  if (!g || typeof g !== 'object' || g.pending === true || 'binding' in g) return out
  const round = Number((prompt.match(/CAMUS_REVIEW_ROUND=(\d+)/) || [])[1])
  const effort = (prompt.match(/CAMUS_REVIEW_EFFORT=(\w+)/) || [])[1] || null
  const nonce = (prompt.match(/CAMUS_GATE_NONCE="([^"]*)"/) || [])[1] || null
  const model = (prompt.match(/--model "([^"]*)"/) || [])[1] || null
  const backend = (prompt.match(/--backend "([^"]*)"/) || [])[1] || 'codex'
  let worktree = (prompt.match(/--worktree "([^"]*)"/) || [])[1] || null
  // An await prompt has no --model/--worktree: production's emit_outcome reconstructs both from
  // the round's meta.json, so the faithful fixture does the same rather than emitting a binding
  // the real gate would never produce (live seam 20260806-110809-2r9j).
  if (model === null && worktree === null && lastStartBinding) {
    return (() => {
      g.binding = { ...lastStartBinding, round: Number.isInteger(round) ? round : lastStartBinding.round,
        effort: effort || lastStartBinding.effort, nonce: nonce || lastStartBinding.nonce }
      return JSON.stringify(g)
    })()
  }
  // REVIEW-CONTRACT (rc1) fields, faithful to codex_review.sh: contract/transport are
  // constants; scope/origin/operator are carried from the command; connection and
  // qualification are DERIVED from the reviewer identity exactly as the script derives
  // them (vendor_managed = built-in codex with no pinned model; builtin1 = that alone).
  const contract = (prompt.match(/--contract (\S+)/) || [])[1] || 'rc1'
  const scope = (prompt.match(/--scope (\S+)/) || [])[1]
    || (prompt.match(/CAMUS_REVIEW_SCOPE=(\S+)/) || [])[1] || 'full'
  const origin = (prompt.match(/--origin (\S+)/) || [])[1]
    || (prompt.match(/CAMUS_REVIEW_ORIGIN=(\S+)/) || [])[1] || 'cli'
  const operator = (prompt.match(/--operator (\S+)/) || [])[1]
    || (prompt.match(/CAMUS_REVIEW_OPERATOR=(\S+)/) || [])[1] || 'cli'
  // A model can be pinned by MORE than --model: the user's CAMUS_CODEX_MODEL, a -m/--model OR a
  // `-c model=` config override folded into CAMUS_CODEX_ARGS, or the light-model ladder
  // (CAMUS_CODEX_LIGHT_MODEL, applied by codex_review.sh ONLY at medium effort); and a non-vendor
  // connection selector (--oss/--local-provider/`-c model_provider=`) takes the reviewer off the
  // vendor connection without pinning a model. The real gate derives its tier from the FINAL codex
  // args, so this faithful spy mirrors every lever — otherwise it would report vendor_managed/
  // builtin1 for a review the real gate ran as configured/qual1 (finding: configurable pins).
  // Actual reviewer inputs are exported explicitly in the workflow command. Read those values,
  // not this test process's environment, so the spy models the production child boundary.
  const codexArgs = (prompt.match(/CAMUS_CODEX_ARGS='([^']*)'/) || [])[1] || ''
  const lightModel = (prompt.match(/CAMUS_CODEX_LIGHT_MODEL='([^']*)'/) || [])[1] || ''
  const argTokens = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean) : [])
  const configAssignment = (token) => {
    if (token.startsWith('--config=')) return token.slice('--config='.length)
    if (token.startsWith('-c') && token !== '-c') return token.slice(2).replace(/^=/, '')
    return token
  }
  const hasModelFlag = (s) => argTokens(s).some((token) => token === '-m' || token === '--model'
    || token.startsWith('--model=') || (token.startsWith('-m') && token.length > 2)
    || configAssignment(token).startsWith('model=')
    || configAssignment(token).startsWith('model_catalog_json='))
  const nonvendorConn = (s) => argTokens(s).some((token) => {
    if (token === '--oss' || token === '--local-provider' || token.startsWith('--local-provider=')
      || token === '-p' || token === '--profile' || token.startsWith('--profile=')
      || (token.startsWith('-p') && token.length > 2)) return true
    const assignment = configAssignment(token)
    return assignment.startsWith('model_provider=') || assignment.startsWith('oss_provider=')
      || assignment.startsWith('model_providers.') || assignment.startsWith('openai_base_url=')
  })
  const modelPinned = !!model || hasModelFlag(codexArgs)
    || (effort === 'medium' && lightModel.trim() !== '')
  const requestedTransport = (prompt.match(/--transport (\S+)/) || [])[1] || 'cli-detached'
  const requestedConnection = (prompt.match(/--connection (\S+)/) || [])[1] || null
  const requestedQualification = (prompt.match(/--qualification (\S+)/) || [])[1] || null
  const connection = requestedConnection
    || ((!modelPinned && !nonvendorConn(codexArgs) && backend === 'codex') ? 'vendor_managed' : 'configured')
  const qualification = requestedQualification
    || ((backend === 'codex' && connection === 'vendor_managed') ? 'builtin1' : 'qual1')
  g.binding = {
    round: Number.isFinite(round) ? round : null, effort, model, backend, nonce, worktree,
    round_requested: Number.isFinite(round) ? round : null, effort_requested: effort,
    contract, scope, qualification, origin, operator, transport: requestedTransport, connection,
    // The HTTP dispatcher is the independent authority that adds this after an exact checked-in
    // admission match. The harness uses a deterministic well-shaped id; break fixtures may supply
    // their own binding to prove that a missing or malformed authority fails closed.
    ...(backend === 'http_openai_compat' ? { admission_id: `admit1:${'a'.repeat(64)}` } : {}),
  }
  lastStartBinding = g.binding      // what a later AWAIT reconstructs from meta.json
  return J(g)
}
async function runLoop(args, scripts, budget) {
  const calls = []
  const capture = {}
  const res = await load(LOOP)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async () => { throw new Error('loop must not call workflow') }, budget, undefined)
  return { res, calls, prompts: capture.prompts || {} }
}
async function runFeat(args, scripts, loopResults, budget) {
  const calls = []
  const capture = {}
  const loopArgs = []
  let li = 0
  const res = await load(FEAT)(args, makeAgent(scripts, calls, capture), () => {}, () => {},
    async (name, a) => { loopArgs.push(a); return loopResults[li++] }, budget, undefined)
  return {
    res, calls, loopArgs, workflowCalls: li,
    stateJSON: capture.state ? extractBraces(capture.state) : null,
    stateJSONs: (capture.states || []).map(extractBraces).filter(Boolean),
    argsJSON: capture.args ? extractBraces(capture.args) : null,
    prompts: capture.prompts || {},
  }
}

const J = (o) => JSON.stringify(o)
// commit.sh emits a real 40-hex `git rev-parse HEAD`, and the commit-receipt gate now requires that shape;
// fixtures use deterministic 40-hex fake hashes (readable seed → per-char hex, zero-padded to 40).
const h40 = (seed) => { let x = ''; for (const c of String(seed)) x += c.charCodeAt(0).toString(16).padStart(2, '0'); return (x + '0'.repeat(40)).slice(0, 40) }
// A containment / parent-tree stub that models a leak APPEARING AFTER the loop-start baseline: the
// `:baseline` capture reads clean, the later leak-check reads dirty. Exercises the untracked-DELTA
// (re-soak 2026-06-14) — only dirt that is new vs the baseline is a breach.
const leakAfterBaseline = (paths) => (p, opts) => J(((opts && opts.label) || '').endsWith(':baseline')
  ? { ran: true, dirty: false, paths: '' }
  : { ran: true, dirty: true, paths })
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
  commit: J({ committed: true, sha: h40('abc123') }),
  prep: J({ prepped: true, ran: [] }),
  // head names the sha happyTail's commit stub seals — head-bound greens (publish audit P2).
  verify: J({ pass: true, failures: [], head: h40('abc123') }),
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
    ok('S1 terminal surfaces receipt-bound reviewer backend/effort',
      res.reviewerBackend === 'codex' && res.reviewerEffort === 'medium' && res.reviewerRound === 1,
      `${res.reviewerBackend}/${res.reviewerEffort}/r${res.reviewerRound}`)
    ok('S1 terminal says an unrecorded reviewer model is unrecorded (never inferred from maker)',
      res.reviewerModel === null && res.reviewerModelStatus === 'not_recorded'
        && /Reviewer receipt: backend codex; model not recorded; effort medium; round 1\./.test(res.note),
      `${JSON.stringify(res.reviewerModel)}/${res.reviewerModelStatus}/${res.note}`)
  }
  {
    const { res, calls, prompts } = await runLoop(
      { task: 't', reviewerBackend: 'codex', reviewerModel: 'gpt-5.4', reviewerEffort: 'low' },
      { ...cls, ...planOf('clear', ''), ...happyTail },
    )
    ok('S1 pinned reviewer identity is copied from the accepted binding into the terminal result',
      res.reviewerBackend === 'codex' && res.reviewerModel === 'gpt-5.4'
        && res.reviewerEffort === 'low' && res.reviewerModelStatus === 'recorded',
      `${res.reviewerBackend}/${res.reviewerModel}/${res.reviewerEffort}/${res.reviewerModelStatus}`)
    const reviewPrompt = Object.values(prompts).find((p) => typeof p === 'string' && p.includes('/review.sh')) || ''
    ok('S1 pinned reviewer model is exported to the ACTUAL review command',
      /CAMUS_CODEX_MODEL="gpt-5\.4"/.test(reviewPrompt), reviewPrompt.slice(0, 260))
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
  // The review returns a DIFFERENT finding each round (unique title+location) so the stuck-finding
  // early-stop (Fix 2026-06-11) does NOT fire — this isolates the roundCap behavior.
  const cleanVerify = { prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) }
  const varyBlock = () => {
    let r = 0
    return {
      ...cls, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
      // The FINAL round now gets one bounded fix (contract change 2026-08-06), so the run
      // reaches commit + verify instead of halting — the stub set must complete that path.
      commit: J({ committed: true, sha: h40('varyblk') }),
      verify: J({ pass: true, failures: [], head: h40('varyblk') }),
      review: () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 't' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) },
    }
  }
  {
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, varyBlock())
    ok('S8a roundCap:1 + unreviewed P1 → parked review_unresolved', res.status === 'review_unresolved' && res.verifyClean === true, res.status)
    ok('S8a exactly 1 review round ran', calls.filter((c) => c.startsWith('review')).length === 1, calls.filter((c) => c.startsWith('review')).join(','))
    ok('S8a the note says the fix was NOT re-reviewed', /UNREVIEWED/.test(res.note || ''), (res.note || '').slice(0, 120))
    ok('S8a and never claims review-clean', !/review-clean\b(?!.*NOT)/i.test(res.note || '') && /NOT review-clean/.test(res.note || ''), (res.note || '').slice(0, 160))
  }
  {
    // out-of-range cap (99) falls back to the default 3 — bounded so a bad value can't run away.
    const { res, calls } = await runLoop({ task: 't', roundCap: 99 }, varyBlock())
    ok('S8b out-of-range roundCap → default 3 rounds', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S8b → review_unresolved after the final unreviewed P1 fix', res.status === 'review_unresolved', res.status)
  }
  {
    let r = 0
    const p2 = varyBlock()
    p2.review = () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 2, title: 'low-' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) }
    const { res } = await runLoop({ task: 't', roundCap: 1 }, p2)
    ok('S8c full + P2-only final bounded fix remains done_with_findings', res.status === 'done_with_findings', res.status)
  }
  // S8e/S8f — FIXED EFFORT (displayed pairing = executed pairing). The review
  // label encodes the effort each round actually ran at ("review:rN codex·<effort>"),
  // so these prove a PINNED effort holds every round while an UNPINNED run keeps
  // the adaptive schedule. The task is COMPLEX and runs to the cap, the exact
  // conditions under which adaptive escalation would otherwise raise a pinned-low
  // run to high/xhigh.
  const effortsOf = (calls) => calls.filter((c) => c.startsWith('review:')).map((c) => (c.match(/codex·(\w+)/) || [])[1])
  {
    // Pinned low on a COMPLEX task: adaptive would go high (complex) then xhigh (P0),
    // but the pin holds low for all three rounds.
    const clsComplex = { classify: { tier: 'complex', reason: 'hard' } }
    const p0Block = () => {
      let r = 0
      return { ...clsComplex, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
        review: () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 0, title: 'crit' + r, code_location: 'a.ts:' + r }], nonblocking: [] }) } }
    }
    const { calls } = await runLoop({ task: 't', roundCap: 3, reviewerEffort: 'low' }, p0Block())
    const efs = effortsOf(calls)
    ok('S8e pinned low executes low EVERY round (displayed = executed)', efs.length === 3 && efs.every((e) => e === 'low'), efs.join(','))
    ok('S8e adaptive escalation did NOT leak a higher effort', !efs.includes('high') && !efs.includes('xhigh'), efs.join(','))
  }
  {
    // The SAME complex/P0 shape UNPINNED keeps the adaptive schedule: high (complex, r1)
    // then xhigh once a P0 finding is carried into the next round.
    const clsComplex = { classify: { tier: 'complex', reason: 'hard' } }
    const p0Block = () => {
      let r = 0
      return { ...clsComplex, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
        review: () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 0, title: 'crit' + r, code_location: 'a.ts:' + r }], nonblocking: [] }) } }
    }
    const { calls } = await runLoop({ task: 't', roundCap: 3 }, p0Block())
    const efs = effortsOf(calls)
    ok('S8f unpinned stays ADAPTIVE (high on complex, xhigh after a P0)', efs[0] === 'high' && efs.slice(1).includes('xhigh'), efs.join(','))
  }
  {
    // An invalid pin is ignored (not honored as a literal), and the run stays adaptive.
    const clsComplex = { classify: { tier: 'complex', reason: 'hard' } }
    const { calls } = await runLoop({ task: 't', roundCap: 1, reviewerEffort: 'ludicrous' }, {
      ...clsComplex, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
      review: J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'a:1' }], nonblocking: [] }),
    })
    ok('S8g an invalid reviewerEffort is ignored, not run as a literal', effortsOf(calls)[0] === 'high', effortsOf(calls).join(','))
  }
  // S11 — NORTH-STAR SPEND. A live WP6 run burned ~211k tokens and 10+ minutes
  // before the reviewer ever ran: ~40k on three "thin" status-stamp agents, ~35k
  // classifying a task whose model was already pinned, ~51.5k planning against a
  // contract that already stated the work (2026-08-05). An agent turn costs its
  // whole context, so the fix is to spend FEWER TURNS, not cheaper ones.
  {
    // Studio's shape: model AND review effort pinned. The tier cannot change any
    // decision, so the classifier must not run at all.
    const { calls, prompts } = await runLoop(
      { task: 't', model: 'opus', reviewerEffort: 'low' },
      { ...clsStd, ...planOf('clear', ''), ...happyTail },
    )
    ok('S11 classifier is SKIPPED when the model and effort are already pinned', !calls.includes('classify'), calls.join(','))
    ok('S11 …and no status-stamp agent turns are spawned', !calls.some((c) => c.startsWith('status:')), calls.join(','))
    ok('S11 the run still completes', calls.includes('implement') && calls.some((c) => c.startsWith('review')), calls.join(','))
  }
  {
    // The phase marker did not disappear — it rides the prompt the agent already
    // runs. Needs a custody identity, since that is what the status record keys on.
    const { calls, prompts } = await runLoop(
      { task: 't', model: 'opus', reviewerEffort: 'low', identitySalt: 'studio-run-1' },
      { ...clsStd, ...planOf('clear', ''), ...happyTail },
    )
    ok('S11 no status-stamp agent turns under a custody identity either', !calls.some((c) => c.startsWith('status:')), calls.join(','))
    ok('S11 the plan prompt still stamps its phase (no extra turn)',
      /status_record\.py write .*--phase "Plan"/.test(prompts.plan || ''), (prompts.plan || '').slice(0, 200))
    ok('S11 the implement prompt stamps Implement',
      /status_record\.py write .*--phase "Implement"/.test(prompts.implement || ''), (prompts.implement || '').slice(0, 200))
  }
  {
    // With NOTHING pinned, the classifier still runs — the saving must come from
    // it being moot, never from dropping a decision the caller relies on.
    const { res, calls } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S11 the classifier still runs when nothing is pinned', calls.includes('classify'), calls.join(','))
    ok('S11 a real classification reports its provenance as the classifier',
      res.tierSource === 'classifier' && res.classificationSkipped === false, `${res.tierSource}/${res.classificationSkipped}`)
  }
  {
    // PROVENANCE: a skipped classification must not report a tier as though one
    // was computed. Routing still uses the neutral default, but the report says so.
    const { res } = await runLoop({ task: 't', model: 'opus', reviewerEffort: 'low' }, { ...planOf('clear', ''), ...happyTail })
    ok('S11 a skipped classification is reported as skipped', res.classificationSkipped === true, String(res.classificationSkipped))
    ok('S11 …and names the tier as a neutral default, not a classifier verdict',
      res.tierSource === 'neutral_default' && res.tier === 'standard', `${res.tierSource}/${res.tier}`)
    const { res: tierRes } = await runLoop({ task: 't', modelTier: 'complex' }, { ...planOf('clear', ''), ...happyTail })
    ok('S11 an explicit tier is attributed to the caller, not to a classifier',
      tierRes.tierSource === 'args.modelTier' && tierRes.tier === 'complex', `${tierRes.tierSource}/${tierRes.tier}`)
  }
  {
    // A pinned model ALONE is not enough: without a pinned effort the tier still
    // drives review escalation, so the classifier must still run.
    const { calls } = await runLoop({ task: 't', model: 'opus' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S11 a pinned model alone does not skip classification (tier still drives review effort)', calls.includes('classify'), calls.join(','))
  }
  {
    // An explicit tier makes the classifier moot for the same reason.
    const { calls } = await runLoop({ task: 't', modelTier: 'complex' }, { ...planOf('clear', ''), ...happyTail })
    ok('S11 an explicit modelTier also skips the classifier', !calls.includes('classify'), calls.join(','))
  }
  {
    // A binding acceptance contract bounds the plan survey instead of re-deriving
    // requirements — the ask-gate is untouched.
    const withContract = 'do the thing\n\nAcceptance contract (binding):\nEvery public method keeps its signature.'
    const { prompts } = await runLoop({ task: withContract, model: 'opus', reviewerEffort: 'low' }, { ...planOf('clear', ''), ...happyTail })
    ok('S11 a binding contract scopes the plan instead of a broad repo survey',
      /Plan AGAINST it/.test(prompts.plan || '') && /do not re-derive requirements/.test(prompts.plan || ''), 'plan prompt')
    ok('S11 …and clarity judgement is explicitly preserved',
      /Clarity is still yours to judge/.test(prompts.plan || ''), 'plan prompt')
    const { prompts: plain } = await runLoop({ task: 't', model: 'opus', reviewerEffort: 'low' }, { ...planOf('clear', ''), ...happyTail })
    ok('S11 a task with no contract keeps the unscoped plan prompt', !/Plan AGAINST it/.test(plain.plan || ''), 'plain plan prompt')
  }
  {
    // The ask-gate still fires with everything pinned — spend cuts must never cost
    // ambiguity detection.
    const { res } = await runLoop({ task: 't', model: 'opus', reviewerEffort: 'low' }, { ...planOf('ambiguous', 'Which X?', ['a', 'b']) })
    ok('S11 ambiguity still pauses even with classification skipped', res.status === 'needs_human', res.status)
  }
  // S10: review_unresolved now CONSULTS deterministic verify before reporting, and a finding
  // re-raised after a fix STOPS early for a human decision (Fix 2026-06-11 — "deterministic ground
  // deterministic verification and unresolved review are separate axes; green tests do not
  // silently clear a contract finding).
  const stuckReview = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1' }], nonblocking: [] })
  const stuckBase = { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: stuckReview, fix: '', prep: J({ prepped: true, ran: [] }) }
  // Since the run-6 integrity work, the unresolved path PARKS FIRST (unconditionally) and then
  // verifies the parked commit — verify refuses uncommitted state, so the seal must precede the
  // ground-truth consult. Red attempts park too (protection, not a reward for green).
  const parkOk = { park: J({ committed: true, sha: h40('p4rk1234') }) }
  {
    // verify GREEN on a non-converged review → DECISION POINT (verifyClean:true), not a plain failure.
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, ...parkOk, verify: J({ pass: true, failures: [], head: h40('p4rk1234') }) })
    ok('S10a review_unresolved + verify GREEN → verifyClean true', res.status === 'review_unresolved' && res.verifyClean === true, res.status + '/' + res.verifyClean)
    ok('S10a verify actually ran on the halt (ground truth consulted)', calls.includes('verify'))
    ok('S10a park precedes verify (seal, then certify)', calls.indexOf('park') < calls.indexOf('verify'), calls.join(','))
    ok('S10a note frames it as a decision, not a pass', /DECIDE/.test(res.note || '') && !/shippable/.test(res.note || ''))
    ok('S10a stuck finding surfaced for the human', Array.isArray(res.stuck) && res.stuck.length === 1)
    ok('S10a stopped early (2 rounds, not roundCap 5)', calls.filter((c) => c.startsWith('review')).length === 2, String(calls.filter((c) => c.startsWith('review')).length))
  }
  {
    // verify RED → genuinely not done (verifyClean:false) — and the attempt is STILL parked
    // (run-6 reorder: the seal happens before the verdict exists; a red park beats uncommitted dirt).
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, ...parkOk, verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }) })
    ok('S10b review_unresolved + verify RED → verifyClean false', res.status === 'review_unresolved' && res.verifyClean === false, res.status + '/' + res.verifyClean)
    ok('S10b note says genuinely not done', /genuinely not done/.test(res.note || ''))
    ok('S10b red attempt parks too (sealed before the verdict; note names it red)', calls.includes('park') && (res.note || '').includes('parked as ' + h40('p4rk1234')) && /verify-red/.test(res.note || ''), res.note)
  }
  // S21 (0.2.5 item 2 + run-6 reorder): PARK seals the review-flagged worktree as a labeled
  // commit BEFORE verify, so proven work survives anything; land's empty-stage path finishes
  // from there on accept. The commit message carries no verify verdict (none exists yet) —
  // the NOTE carries it.
  {
    const { res, calls, prompts } = await runLoop({ task: 't', roundCap: 5 },
      { ...stuckBase, verify: J({ pass: true, failures: [], head: h40('p4rk1234') }), park: J({ committed: true, sha: h40('p4rk1234') }) })
    ok('S21 verify-clean halt parks a commit', calls.includes('park'), calls.join(','))
    ok('S21 park message is the labeled chore (no verdict claimed pre-verify)',
      !!prompts.park && prompts.park.includes('chore(camus): park') && prompts.park.includes('(review-flagged)') && !prompts.park.includes('verify-green'))
    ok('S21 parked sha surfaced on the halt', res.parkedSha === h40('p4rk1234'), res.parkedSha)
    ok('S21 note says the work is parked', (res.note || '').includes('PARKED as commit ' + h40('p4rk1234')))
  }
  {
    // a refused park now means verify CANNOT certify (uncommitted state) — the halt names the
    // blocker and reports verifyClean:null (no ground truth), never a fake green or red.
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 },
      { ...stuckBase, verify: J({ pass: true, failures: [] }), park: J({ committed: false, reason: 'git identity missing' }) })
    ok('S21b park failure → verifyClean null + blocker named', res.status === 'review_unresolved' && res.verifyClean === null && /Parking the work FAILED \(git identity missing\)/.test(res.note || ''), res.note)
    ok('S21b verify NOT run on the unsealed tree', !calls.includes('verify'), calls.join(','))
    ok('S21b no parkedSha claimed', !('parkedSha' in res))
  }
  // S11: confidence TREND (run feedback 2026-06-11) — a re-raised finding whose confidence FALLS
  // across rounds is flagged as likely-stale (lean ACCEPT); steady confidence leans REFINE.
  {
    let rr = 0
    const fallingConf = () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1', confidence_score: rr === 1 ? 0.9 : 0.8 }], nonblocking: [] }) }
    const { res } = await runLoop({ task: 't', roundCap: 5 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: fallingConf, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) })
    ok('S11a stuck finding carries a falling confidence trend', !!res.stuck && res.stuck[0].confidenceTrend && res.stuck[0].confidenceTrend.dir === 'falling', JSON.stringify(res.stuck && res.stuck[0] && res.stuck[0].confidenceTrend))
    ok('S11a verify-clean + falling conf → note leans ACCEPT', /LOST reviewer confidence|lean ACCEPT/.test(res.note || ''))
  }
  {
    let rr = 0
    const steadyConf = () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1', confidence_score: 0.9 }], nonblocking: [] }) }
    const { res } = await runLoop({ task: 't', roundCap: 5 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: steadyConf, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) })
    ok('S11b steady confidence → note leans REFINE', /HELD reviewer confidence|lean REFINE/.test(res.note || ''))
  }
  // S11c: MISSING confidence — no confidence_score on the findings must not crash; trend = flat,
  // and the note must NOT claim falling/rising (no false "lean ACCEPT/REFINE" from absent data).
  {
    const noConf = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1' }], nonblocking: [] })
    const { res } = await runLoop({ task: 't', roundCap: 5 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: noConf, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) })
    ok('S11c missing confidence → trend flat, still detected as stuck', !!res.stuck && res.stuck[0].confidenceTrend.dir === 'flat', JSON.stringify(res.stuck && res.stuck[0] && res.stuck[0].confidenceTrend))
    ok('S11c no falling-confidence claim from absent data', !/LOST reviewer confidence/.test(res.note || ''))
  }
  // S11d: identity robustness — a re-formatted title + a DRIFTED line number is still the SAME
  // finding (repeat detected); a wholly different finding is NOT (degrades to running more rounds).
  {
    let rr = 0
    const reworded = () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: rr === 1 ? 'Bad URL handling.' : 'bad   url  handling', code_location: rr === 1 ? 'a.ts:54' : 'a.ts:90' }], nonblocking: [] }) }
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: reworded, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) })
    ok('S11d re-worded title + drifted line → still the same finding (stuck at round 2)', !!res.stuck && calls.filter((c) => c.startsWith('review')).length === 2, String(calls.filter((c) => c.startsWith('review')).length))
  }
  {
    let rr = 0
    const allDifferent = () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'issue ' + rr, code_location: 'f' + rr + '.ts:1' }], nonblocking: [] }) }
    const { calls } = await runLoop({ task: 't', roundCap: 3 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: allDifferent, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: false, failures: [] }) })
    ok('S11d distinct findings each round → no false stuck, runs to cap (3)', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
  }
  // S11e: MULTIPLE repeated findings with DIFFERENT trends — each tracked independently; the falling
  // one drives the ACCEPT lean while the steady one is reported too.
  {
    let rr = 0
    const twoFindings = () => {
      rr++
      return J({ ran: true, clean: false, nonblocking: [], blocking: [
        { priority: 1, title: 'falling one', code_location: 'a.ts:1', confidence_score: rr === 1 ? 0.95 : 0.80 },
        { priority: 1, title: 'steady one', code_location: 'b.ts:1', confidence_score: 0.90 },
      ] })
    }
    const { res } = await runLoop({ task: 't', roundCap: 5 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: twoFindings, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) })
    const byTitle = Object.fromEntries((res.stuck || []).map((s) => [s.title, s.confidenceTrend.dir]))
    ok('S11e per-finding trends tracked independently', byTitle['falling one'] === 'falling' && byTitle['steady one'] === 'flat', JSON.stringify(byTitle))
    ok('S11e the falling finding drives the ACCEPT lean', /0.95→0.8|LOST reviewer confidence/.test(res.note || ''))
  }
  // S11f (audit 2026-06-11): UN-KEYABLE findings (no title AND no code_location) must NOT collapse
  // into one key and falsely trigger "stuck" — they're excluded from repeat-detection.
  {
    const emptyFindings = J({ ran: true, clean: false, blocking: [{ priority: 1 }], nonblocking: [] }) // no title / code_location
    const { res, calls } = await runLoop({ task: 't', roundCap: 3 },
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: emptyFindings, fix: '', prep: J({ prepped: true, ran: [] }), commit: J({ committed: true, sha: h40('s11f') }), verify: J({ pass: false, failures: [] }) })
    ok('S11f un-keyable findings do NOT falsely stuck → runs to cap (3)', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S11f un-keyable findings never falsely stuck, and a RED verify keeps its meaning', res.status === 'verify_failed' && !res.stuck, res.status + '/' + JSON.stringify(res.stuck || null))
  }
  // S12 (run-5 fix 2026-06-11): LAND MODE — commit already-proven work without re-running the loop.
  const landStubs = {
    'land-resolve': J({ found: true, path: wtPath('t') }),
    commit: J({ committed: true, sha: h40('land1') }),
    prep: J({ prepped: true, ran: [] }),
    verify: J({ pass: true, failures: [], head: h40('land1') }),
  }
  {
    const { res, calls } = await runLoop({ task: 't', land: true }, landStubs)
    ok('S12a land → done with sha, rounds 0, landed flag', res.status === 'done' && res.commit_sha === h40('land1') && res.rounds === 0 && res.landed === true, JSON.stringify({ s: res.status, sha: res.commit_sha }))
    ok('S12a land skips classify/plan/implement/review entirely',
      !calls.some((c) => /^(classify|plan|implement|review|fix)/.test(c)), calls.join(','))
    ok('S12a verify still ran (gate unskippable)', calls.includes('verify'))
  }
  {
    // Verify RED under land → verify_failed (deterministic gate still arbitrates landing).
    const { res } = await runLoop({ task: 't', land: true }, { ...landStubs, verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }) })
    ok('S12b land + verify red → verify_failed', res.status === 'verify_failed' && res.landed === true, res.status)
  }
  {
    // No existing worktree → nothing to land: abort, never plan/implement.
    const { res, calls } = await runLoop({ task: 't', land: true }, { ...landStubs, 'land-resolve': J({ found: false, path: null }) })
    ok('S12c land with no worktree → aborted stage land', res.status === 'aborted' && res.stage === 'land', res.status + '/' + res.stage)
    ok('S12c …and nothing else ran', !calls.some((c) => /^(classify|plan|implement|review|commit|prep|verify)/.test(c)), calls.join(','))
  }
  {
    // Already-committed worktree (empty stage) → proceed to verify, done with null sha (run died
    // after commit last time — the branch tip IS the landed work). Since publish audit round-2,
    // commit.sh names the live tip on empty and the verify is BOUND to it — the green must
    // certify that exact tip.
    const { res, calls } = await runLoop({ task: 't', land: true },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: h40('t1pl1ve') }), verify: J({ pass: true, failures: [], head: h40('t1pl1ve') }) })
    ok('S12d land + empty stage → still done (already committed)', res.status === 'done' && res.commit_sha === null, res.status + '/' + res.commit_sha)
    ok('S12d verify still ran', calls.includes('verify'))
    // F36a (publish audit round-2 P1): the empty-stage land no longer believes unbound greens.
    const noHead = await runLoop({ task: 't', land: true },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: h40('t1pl1ve') }), verify: J({ pass: true, failures: [] }) })
    ok('F36a empty-stage land + unnamed green → verify_failed (head_missing)',
      noHead.res.status === 'verify_failed' && JSON.stringify(noHead.res.failures || []).includes('head_missing'), noHead.res.status)
    // F36b: expectHead (the ORIGINAL proof) outranks the live tip — a task-branch tip that moved
    // past the proof fails CLOSED with both shas named, never believed and merged.
    const moved = await runLoop({ task: 't', land: true, expectHead: h40('pr00f') },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: h40('t1pmoved') }), verify: J({ pass: true, failures: [], head: h40('t1pmoved') }) })
    ok('F36b tip moved past the proven commit → verify_failed naming both shas',
      moved.res.status === 'verify_failed' && JSON.stringify(moved.res.failures || []).includes(h40('pr00f')) && JSON.stringify(moved.res.failures || []).includes(h40('t1pmoved')), moved.res.status)
    // …and a tip still AT the proof verifies green through the same binding.
    const held = await runLoop({ task: 't', land: true, expectHead: h40('pr00f') },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: h40('pr00f') }), verify: J({ pass: true, failures: [], head: h40('pr00f') }) })
    ok('F36b tip still at the proven commit → done', held.res.status === 'done', held.res.status)
    // F36c (Mateo re-audit 2026-07-06): an empty stage that names NO valid sha is a RELAY CONTRACT VIOLATION
    // (commit.sh emits a sha even on empty) — fail CLOSED, never a null-bound "legacy" done, UNLESS a recorded
    // proof (expectHead) exists to bind the verify to.
    const legacyNoSha = await runLoop({ task: 't', land: true }, { ...landStubs, commit: J({ committed: false, reason: 'empty' }) })
    ok('F36c empty + no sha + no proof → infra_error, NOT an unbound done', legacyNoSha.res.status === 'infra_error' && /land commit failed/.test(legacyNoSha.res.error || ''), legacyNoSha.res.status + ' ' + (legacyNoSha.res.error || '').slice(0, 40))
    const legacyWithProof = await runLoop({ task: 't', land: true, expectHead: h40('pr00f') },
      { ...landStubs, commit: J({ committed: false, reason: 'empty' }), verify: J({ pass: true, failures: [], head: h40('pr00f') }) })
    ok('F36c empty + no sha + valid expectHead → binds to the proof → done', legacyWithProof.res.status === 'done', legacyWithProof.res.status)
  }
  {
    // A real commit failure under land is still an INFRA error, never silently skipped.
    const { res } = await runLoop({ task: 't', land: true }, { ...landStubs, commit: J({ committed: false, reason: 'hook rejected' }) })
    ok('S12e land + commit failure → infra_error', res.status === 'infra_error' && /land commit failed/.test(res.error || ''), res.status)
  }
  {
    // A hallucinated resolver path (wrong suffix) is refused fail-closed (audit F3 discipline).
    const { res } = await runLoop({ task: 't', land: true }, { ...landStubs, 'land-resolve': J({ found: true, path: '/tmp/evil-dir' }) })
    ok('S12f land refuses an unvalidated worktree path', res.status === 'aborted' && res.stage === 'land', res.status)
  }
  // S27 (live smoke run-4, 2026-06-12): the work's durable home is the BRANCH — a missing land
  // worktree is recreated FROM the branch (the noop path legitimately removes checkouts while
  // the proven commits survive). Recreate-impossible stays an honest abort naming the branch.
  {
    const { res, calls, prompts } = await runLoop({ task: 't', land: true },
      { ...landStubs, 'land-resolve': J({ found: false, path: null }), 'land-recreate': J({ ok: true, path: wtPath('t') }) })
    ok('S27 missing worktree → recreated from the branch → landed done', res.status === 'done' && calls.includes('land-recreate'), res.status + ' ' + calls.join(','))
    // run-5 (2026-06-12): the mutation lives in the allowlisted wt.sh — agent-typed hookless git
    // is classifier-denied, so the prompt must carry NO raw git at all.
    ok('S27 recreate goes through wt.sh attach (no raw git in the prompt)', !!prompts['land-recreate'] && prompts['land-recreate'].includes('/wt.sh attach') && !prompts['land-recreate'].includes('git -c'), (prompts['land-recreate'] || '').slice(0, 160))
  }
  {
    const { res } = await runLoop({ task: 't', land: true },
      { ...landStubs, 'land-resolve': J({ found: false, path: null }), 'land-recreate': J({ ok: false, error: 'denied by the auto mode classifier: hooksPath bypass' }) })
    ok('S27b recreate failure carries the REAL cause verbatim', res.status === 'aborted' && /wt\.sh said: "denied by the auto mode classifier/.test(res.note || ''), res.note)
  }

  // S9: DYNAMIC review reasoning effort (run feedback 2026-06-11) — the orchestrator passes a
  // per-round effort (arg 4 of the review command) that scales with stakes. effortOf reads it
  // back from the captured review prompt. (medium|high|xhigh; 'high' is a substring of 'xhigh'
  // so the regex anchors on the round-number prefix.)
  // effortOf reads the effort from the review COMMAND (arg 4 in the captured prompt). The review
  // LABEL also carries it now (FEATURE 2026-06-11: surface codex + effort in the TUI, not just the
  // Haiku runner) — so the round-N review prompt is keyed by `review r<n> · codex/<effort>…`.
  const effortOf = (p) => (((p || '').match(/ \d+ (medium|high|xhigh)\b/) || [])[1] || null)
  const reviewLbl = (calls, round) => calls.find((c) => c.startsWith(`review:r${round} `)) || ''
  const blockP1 = { implement: happyTail.implement, review: J({ ran: true, clean: false, blocking: [{ priority: 1, note: 'x' }], nonblocking: [] }), fix: '' }
  const blockP0 = { implement: happyTail.implement, review: J({ ran: true, clean: false, blocking: [{ priority: 0, note: 'crit' }], nonblocking: [] }), fix: '' }
  const clsComplex = { classify: { tier: 'complex', reason: 'x' } }
  {
    // standard tier: cheap MEDIUM first pass → escalate to HIGH once a fix didn't clear (round≥2).
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    const l1 = reviewLbl(calls, 1), l2 = reviewLbl(calls, 2)
    ok('S9a label surfaces codex + effort (round1 medium)', /codex·medium/.test(l1), l1)
    ok('S9a label surfaces codex + effort (round2 high)', /codex·high/.test(l2), l2)
    ok('S9a effort reaches the command (medium→high)', effortOf(prompts[l1]) === 'medium' && effortOf(prompts[l2]) === 'high')
  }
  {
    // a P0 (critical) finding → next round jumps to XHIGH (maximum scrutiny).
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP0 })
    ok('S9b round1 medium (no prior findings yet)', effortOf(prompts[reviewLbl(calls, 1)]) === 'medium')
    ok('S9b round2 after a P0 → xhigh', effortOf(prompts[reviewLbl(calls, 2)]) === 'xhigh', reviewLbl(calls, 2))
  }
  {
    // complex tier → start deeper (HIGH) even on round 1.
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsComplex, ...planOf('clear', ''), ...blockP1 })
    ok('S9c complex tier → round1 effort high', effortOf(prompts[reviewLbl(calls, 1)]) === 'high', reviewLbl(calls, 1))
  }

  // S13 (smoke 2026-06-11): the reviewer prompt instructs an EFFORT-SIZED Bash tool timeout on the
  // FIRST call and forbids shell `timeout` wrappers — codex_review.sh has no internal deadline,
  // `codex exec` has no deadline flag, and the tool's 2-min default SIGTERM'd a high-effort round
  // mid-review (exit 143), after which the agent improvised GNU `timeout` (exit 127 on macOS).
  {
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    const p1 = prompts[reviewLbl(calls, 1)] || '', p2 = prompts[reviewLbl(calls, 2)] || ''
    ok('S13 medium round → 360000 ms tool timeout instructed', /timeout PARAMETER to 360000\b/.test(p1))
    ok('S13 high round → 600000 ms tool timeout instructed', /timeout PARAMETER to 600000\b/.test(p2))
    ok('S13 shell timeout wrappers forbidden', p1.includes('Do NOT wrap the command in `timeout`/`gtimeout`'))
  }

  // S14 (smoke 2026-06-11): deterministic env facts (args.envFacts, threaded by the feat) reach the
  // plan/implement/fix prompts — and ONLY those (the thin reviewer stays minimal). Absent → no block.
  {
    const FACTS = 'platform: darwin (macOS)\nGNU `timeout` is NOT on PATH — use the Bash tool timeout PARAMETER'
    const { calls, prompts } = await runLoop({ task: 't', envFacts: FACTS }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    ok('S14 facts in plan prompt', !!prompts.plan && prompts.plan.includes(FACTS))
    ok('S14 facts in implement prompt', !!prompts.implement && prompts.implement.includes(FACTS))
    ok('S14 facts in fix prompt', !!prompts['fix:r1'] && prompts['fix:r1'].includes(FACTS))
    ok('S14 thin reviewer NOT bloated with facts', !(prompts[reviewLbl(calls, 1)] || '').includes(FACTS))
  }
  {
    const { prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S14b no envFacts → no facts block in prompts', !!prompts.plan && !prompts.plan.includes('Environment facts'))
  }

  // S15 (0.2.5 item 5): OSCILLATION — a finding that appears r1, vanishes r2, RETURNS r3 stops the
  // loop early with oscillating:true ("the reviewer can't make up its mind"), instead of reading
  // the flip-flop as progress and churning to the cap. Distinct findings per round dodge the
  // consecutive-repeat (stuck) path; cap 5 proves the stop is the detector, not the cap.
  {
    let r15 = 0
    const seq = ['A', 'B', 'A']
    const osc = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
      review: () => { r15++; const t = seq[r15 - 1] || ('Z' + r15); return J({ ran: true, clean: false, blocking: [{ priority: 1, title: t, code_location: t.toLowerCase() + '.ts:1' }], nonblocking: [] }) },
    }
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, osc)
    ok('S15 returned-after-vanishing finding halts as oscillating', res.status === 'review_unresolved' && res.oscillating === true, res.status + '/' + res.oscillating)
    ok('S15 stopped at round 3 of cap 5 (detector, not cap)', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S15 note names the oscillation', /oscillat/i.test(res.note || ''))
    ok('S15 the returning finding surfaced for the human', Array.isArray(res.stuck) && res.stuck.length === 1 && res.stuck[0].title === 'A', JSON.stringify(res.stuck))
  }
  // S16 (fixlet 2026-06-11): NO FIX WITHOUT A CONFIRMATION ROUND — the final round's findings halt
  // the loop; a fix the loop can't re-review is never dispatched (it once landed unreviewed and the
  // halt report described an already-fixed worktree).
  {
    const { res, calls } = await runLoop({ task: 't', roundCap: 2 }, varyBlock())
    ok('S16 the FINAL round gets its own bounded fix (2 fixes for 2 rounds)', calls.filter((c) => c.startsWith('fix')).length === 2, calls.join(','))
    ok('S16 both review rounds ran — and NO third', calls.filter((c) => c.startsWith('review')).length === 2, calls.filter((c) => c.startsWith('review')).join(','))
    ok('S16 unreviewed P1 → review_unresolved (never mergeable)', res.status === 'review_unresolved' && res.verifyClean === true, res.status)
    ok('S16 the findings are recorded verbatim for the human', Array.isArray(res.findings) && res.findings.length === 1, JSON.stringify(res.findings || []).slice(0, 120))
  }
  // S17 (0.2.5 item 1): HEARTBEAT — under a feat (idSalt) every runner command and think prompt
  // touches ~/.camus/feats/<featId>.hb first, so its mtime is a phase-boundary liveness signal.
  // Standalone loops (no salt) must be byte-identical to before (no .hb anywhere).
  {
    const salt = 'feat123'
    const hb = `touch "$HOME/.camus/feats/${salt}.hb"`
    const stubs = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('abc') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('abc') }),
      containment: J({ ran: true, dirty: false, paths: '' }),
    }
    const { res, calls, prompts } = await runLoop({ task: 't', idSalt: salt }, stubs)
    ok('S17 review command carries the heartbeat touch', (prompts[reviewLbl(calls, 1)] || '').includes(hb))
    ok('S17 implement prompt carries the heartbeat line', !!prompts.implement && prompts.implement.includes(hb))
    ok('S17 verify command carries the heartbeat touch', !!prompts.verify && prompts.verify.includes(hb))
    ok('S17 commit command carries the heartbeat touch', !!prompts.commit && prompts.commit.includes(hb))
    ok('S17 → done unchanged', res.status === 'done', res.status)
  }
  {
    const { calls, prompts } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('S17b standalone (no idSalt) → no heartbeat anywhere', !(prompts[reviewLbl(calls, 1)] || '').includes('.hb') && !(prompts.implement || '').includes('.hb'))
  }
  // Studio needs stable custody without impersonating a feat. identitySalt binds the branch,
  // worktree and heartbeat, but deliberately skips feat-only main-tree containment and uses the
  // idempotent ensure lane so a replay returns to the same partial work.
  {
    const identity = 'studio-run-123'
    const hb = `touch "$HOME/.camus/feats/${identity}.hb"`
    const stubs = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', identity), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('studio') }), prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [], head: h40('studio') }),
      containment: J({ ran: true, dirty: true, paths: ' M should-not-run.ts' }),
    }
    const { res, calls, prompts } = await runLoop({ task: 't', identitySalt: identity }, stubs)
    ok('S17c identitySalt → deterministic salted worktree completes', res.status === 'done', res.status)
    ok('S17c identitySalt → implement uses idempotent ensure', (prompts.implement || '').includes('/wt.sh ensure'))
    ok('S17c identitySalt → heartbeat remains visible', (prompts.implement || '').includes(hb) && (prompts.verify || '').includes(hb))
    ok('S17c identitySalt is NOT feat containment', !calls.some((c) => c.startsWith('containment')), calls.join(','))
  }
  {
    const { res } = await runLoop({ task: 't', idSalt: 'feat123', identitySalt: 'studio123' }, {})
    ok('S17d feat idSalt + standalone identitySalt is refused as ambiguous custody', res.status === 'aborted' && res.stage === 'args', res.status + '/' + res.stage)
  }
  // S19 (fixlet 2026-06-11): SIBLING-TASK CONTEXT — the feat's other-task briefs reach the review
  // context AND the fix prompt as "owned elsewhere — don't flag / don't touch".
  {
    const SIB = '- other-task-abc [pending]: do the other thing'
    const { calls, prompts } = await runLoop({ task: 't', siblingTasks: SIB }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    ok('S19 review ctx carries sibling lanes', (prompts[reviewLbl(calls, 1)] || '').includes('owned ELSEWHERE'))
    ok('S19 fix prompt told hands-off siblings', !!prompts['fix:r1'] && prompts['fix:r1'].includes('owned ELSEWHERE'))
  }
  {
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    ok('S19b no siblings → no sibling block', !(prompts[reviewLbl(calls, 1)] || '').includes('owned ELSEWHERE'))
  }
  // S20 (smoke 2026-06-11): the ambiguity-pause threshold — the plan prompt must escalate
  // user-visible PRODUCT tradeoffs to "ambiguous" (the camello smoke's headline finding: a
  // clear-looking task burned three rounds on a data-loss call a human answers in one line).
  {
    const { prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S20 plan prompt escalates product tradeoffs to ambiguous', !!prompts.plan && /USER-VISIBLE product tradeoff/.test(prompts.plan))
  }

  // S22 (watchdog reviewer, 2026-06-11): a review outliving its first chunk returns
  // {pending, handle}; the loop re-attaches with thin `await` calls until the verdict lands.
  // Handles travel through agent stdout → validated against OUR layout before any exec.
  {
    const handle = `/home/u/.camus/reviews/${wtName('t')}-r1.watch`
    let r22 = 0
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, ...cleanVerify,
      commit: J({ committed: true, sha: h40('abc123') }), verify: J({ pass: true, failures: [], head: h40('abc123') }),
      review: () => { r22++; return r22 <= 2 ? J({ pending: true, handle, last_event_age: 12 }) : J({ ran: true, clean: true, blocking: [], nonblocking: [] }) },
    }
    const { res, calls, prompts } = await runLoop({ task: 't' }, stubs)
    ok('S22 pending → re-attach → clean verdict → done', res.status === 'done', res.status)
    ok('S22 await calls labeled and bounded', calls.some((c) => /await1$/.test(c)) && calls.some((c) => /await2$/.test(c)) && !calls.some((c) => /await3$/.test(c)), calls.join(','))
    const awaitP = prompts[calls.find((c) => /await1$/.test(c))] || ''
    ok('S22 await is a thin re-attach command with the handle', awaitP.includes(`await ${JSON.stringify(handle)}`) && awaitP.includes('timeout PARAMETER to 600000'))
  }
  {
    // a hallucinated/foreign handle is INFRA fail-closed — never interpolated into a command.
    const evil = { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ pending: true, handle: '/tmp/evil"; rm -rf /; "' }) }
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, evil)
    ok('S22b bad handle → infra, no await dispatched', res.status === 'infra_error' && !calls.some((c) => /await1$/.test(c)), res.status + ' ' + calls.join(','))
  }
  {
    // JSON.stringify does NOT escape $(...) inside double quotes — the charset allowlist is the
    // real injection guard (audit hardening 2026-06-11).
    const evil = { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ pending: true, handle: `/tmp/$(touch pwned)/x-r1.watch` }) }
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, evil)
    ok('S22b2 command-substitution handle rejected by charset', res.status === 'infra_error' && !calls.some((c) => /await1$/.test(c)), calls.join(','))
  }
  {
    // audit P2 2026-06-11: a CUSTOM CAMUS_REVIEW_DIR emits handles outside ~/.camus/reviews —
    // the loop must still re-attach (location authentication belongs to codex_review.sh).
    const handle = `/tmp/custom-audit-reviews/${wtName('t')}-r1.watch`
    let rc = 0
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, ...cleanVerify,
      commit: J({ committed: true, sha: h40('abc123') }), verify: J({ pass: true, failures: [], head: h40('abc123') }),
      review: () => { rc++; return rc === 1 ? J({ pending: true, handle, last_event_age: 4 }) : J({ ran: true, clean: true, blocking: [], nonblocking: [] }) },
    }
    const { res, calls } = await runLoop({ task: 't' }, stubs)
    ok('S22e custom review-dir handle re-attaches fine', res.status === 'done' && calls.some((c) => /await1$/.test(c)), res.status + ' ' + calls.join(','))
  }
  {
    // alive past the WHOLE watch budget → abort the detached process, round becomes infra.
    const handle = `/home/u/.camus/reviews/${wtName('t')}-r1.watch`
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ pending: true, handle, last_event_age: 3 }),
      'review-abort': J({ ran: false, error: 'codex review aborted (watch budget exhausted)', clean: false, blocking: [], nonblocking: [] }),
    }
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, stubs)
    ok('S22c watch budget exhausted → abort called, infra surfaced', res.status === 'infra_error' && calls.filter((c) => c.startsWith('review-abort')).length >= 1, res.status + ' aborts=' + calls.filter((c) => c.startsWith('review-abort')).length)
    ok('S22c exactly AWAIT_CAP awaits per attempt', calls.filter((c) => / await\d+$/.test(c)).length === 6 * 3, String(calls.filter((c) => / await\d+$/.test(c)).length))
  }
  {
    // codex-side usage from the watchdog surfaces in the round log (honest cost, log-only).
    const logs = []
    const fs2 = require('fs'); const path2 = require('path')
    const src = fs2.readFileSync(LOOP, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'phase', 'log', 'workflow', 'budget', src)
    const calls2 = []
    await fn({ task: 't' }, makeAgent({ ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [], usage: { input_tokens: 15655, output_tokens: 900, reasoning_output_tokens: 4000 } }),
      commit: J({ committed: true, sha: h40('abc123') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('abc123') }) }, calls2),
      () => {}, (m) => logs.push(m), async () => { throw new Error('no workflow') }, undefined)
    ok('S22d reviewer usage in the clean-round log', logs.some((m) => /reviewer ~16k in\/900 out \(4000 reasoning\)/.test(m)), logs.filter((m) => /CLEAN/.test(m)).join(' | '))
  }

  // S23 (VELOCITY §1, 0.2.6): ONESHOT posture — one review; blocking findings get ONE fix pass
  // and NO re-review; verify decides; the honest status is done_with_findings, never "review
  // clean". The deterministic floor is unskippable in every posture.
  {
    const { res, calls, prompts } = await runLoop({ task: 't', posture: 'oneshot' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S23a oneshot + clean review → plain done (clean is EARNED)', res.status === 'done', res.status)
    ok('S23a review command carries the light scope arg', / 1 medium light\b/.test(prompts[reviewLbl(calls, 1)] || ''), reviewLbl(calls, 1))
  }
  {
    const finding = { priority: 1, title: 'edge case', code_location: 'a.ts:1' }
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '',
      review: J({ ran: true, clean: false, blocking: [finding], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('one5h0t') }), ...cleanVerify, verify: J({ pass: true, failures: [], head: h40('one5h0t') }),
    }
    const { res, calls } = await runLoop({ task: 't', posture: 'oneshot', roundCap: 5 }, stubs)
    ok('S23b oneshot blocking → done_with_findings', res.status === 'done_with_findings', res.status)
    ok('S23b exactly ONE review + ONE fix (cap ignored)', calls.filter((c) => c.startsWith('review')).length === 1 && calls.filter((c) => c.startsWith('fix')).length === 1, calls.join(','))
    ok('S23b findings verbatim + honest resolution', res.findingsDeferred === 1 && res.resolution === 'fixed_unreviewed' && res.findings[0].title === 'edge case', JSON.stringify(res.findings))
    ok('S23b committed (merged-ready) + note says NOT review-clean', res.commit_sha === h40('one5h0t') && /NOT review-clean/.test(res.note || ''), res.note)
  }
  {
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '',
      review: J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'a:1' }], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('c') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }),
    }
    const { res } = await runLoop({ task: 't', posture: 'oneshot' }, stubs)
    ok('S23c oneshot + red verify → verify_failed (the floor holds)', res.status === 'verify_failed', res.status)
  }
  {
    let threw = null
    try { await runLoop({ task: 't', posture: 'bookend' }, { ...cls, ...happyTail }) } catch (e) { threw = String((e && e.message) || e) }
    ok('S23d bookend/forward rejected LOUDLY (0.3), never downgraded', !!threw && /0\.3/.test(threw), threw)
  }
  {
    const { calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    ok('S23e full posture → no light scope arg on the review command', !/ light\b/.test(prompts[reviewLbl(calls, 1)] || ''))
    // VELOCITY §2: reviews go through the backend DISPATCHER — the loop never names a vendor.
    ok('S23f review command routes through review.sh (backend dispatcher)', (prompts[reviewLbl(calls, 1)] || '').includes('/review.sh'), (prompts[reviewLbl(calls, 1)] || '').slice(0, 200))
  }
  // S23g (finding: workflow runtime has no process/env authority). Identity-affecting Codex
  // settings arrive through the run-start snapshot and the command explicitly exports them,
  // including empty values that isolate the child from a runner's ambient environment.
  {
    const { res, calls, prompts } = await runLoop(
      { task: 't', reviewerCodexArgs: '-c model_reasoning_effort=medium -m gpt-5.4' },
      { ...clsStd, ...planOf('clear', ''), ...happyTail },
    )
    const cmd = prompts[reviewLbl(calls, 1)] || ''
    ok('S23g explicit reviewerCodexArgs → expectation is qual1/configured', / --qualification qual1 /.test(cmd) && / --connection configured\b/.test(cmd), cmd.slice(0, 260))
    ok('S23g reviewerCodexArgs reaches the ACTUAL child environment', /CAMUS_CODEX_ARGS='-c model_reasoning_effort=medium -m gpt-5\.4'/.test(cmd), cmd.slice(0, 300))
    ok('S23g …and the review is ACCEPTED (loop reaches done, not infra drift)', res.status === 'done', res.status)
  }
  {
    const prev = process.env.CAMUS_CODEX_ARGS
    process.env.CAMUS_CODEX_ARGS = '-m ambient-must-not-leak'
    try {
      const { res, calls, prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
      const cmd = prompts[reviewLbl(calls, 1)] || ''
      ok('S23g production-no-process path ignores ambient reviewer args', /CAMUS_CODEX_ARGS=''/.test(cmd) && / --qualification builtin1 /.test(cmd) && / --connection vendor_managed\b/.test(cmd), cmd.slice(0, 300))
      ok('S23g isolated ambient path still reaches done', res.status === 'done', res.status)
    } finally {
      if (prev === undefined) delete process.env.CAMUS_CODEX_ARGS; else process.env.CAMUS_CODEX_ARGS = prev
    }
  }
  // S23h: reviewerLightModel is effort-gated (medium only) in codex_review.sh, so the
  // expectation MUST be per-round: qual1/configured on a medium round, builtin1/vendor_managed on
  // a high round — a single run-wide constant would drift on one of them.
  {
    // Default tier: round 1 medium (light model applies → configured); round 2 high (rnd>=2 →
    // high, so the light model is NOT appended → vendor_managed).
    const twoRounds = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '',
      review: (p) => J({ ran: true, clean: /CAMUS_REVIEW_ROUND=2/.test(p), blocking: /CAMUS_REVIEW_ROUND=2/.test(p) ? [] : [{ priority: 1, title: 'x', code_location: 'a:1' }], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('l1ghtm0') }), ...cleanVerify, verify: J({ pass: true, failures: [], head: h40('l1ghtm0') }),
    }
    const { res, calls, prompts } = await runLoop({ task: 't', roundCap: 3, reviewerLightModel: 'gpt-5.4-mini' }, twoRounds)
    const r1 = prompts[reviewLbl(calls, 1)] || '', r2 = prompts[reviewLbl(calls, 2)] || ''
    ok('S23h medium round → qual1/configured (light model applies)', / medium\b/.test(r1) && / --qualification qual1 /.test(r1) && / --connection configured\b/.test(r1), r1.slice(0, 200))
    ok('S23h high round → builtin1/vendor_managed (light model NOT applied)', / high\b/.test(r2) && / --qualification builtin1 /.test(r2) && / --connection vendor_managed\b/.test(r2), r2.slice(0, 200))
    ok('S23h light model reaches the explicit child environment', /CAMUS_CODEX_LIGHT_MODEL='gpt-5\.4-mini'/.test(r1), r1.slice(0, 260))
    ok('S23h both rounds ACCEPTED → reaches done', res.status === 'done', res.status)
  }

  // S23i (finding: a model pinned via codex's generic `-c model=` config override, or a non-vendor
  // connection selector like --oss, must ALSO make the workflow EXPECTATION qual1/configured — the
  // -m/--model detector alone missed both, so asGate would falsely refuse the valid review as drift).
  for (const bypass of [
    '-c model="o3"', '-mo3', '--config=model="o3"',
    '-c model_catalog_json="/tmp/camus-models.json"',
    '--oss --local-provider ollama', '--config=model_provider=ollama',
    '--profile local-review', '-plocal-review',
    '-c model_providers.camus_local.base_url="http://127.0.0.1:11434/v1"',
    '-copenai_base_url="http://127.0.0.1:11434/v1"',
  ]) {
    const { res, calls, prompts } = await runLoop({ task: 't', reviewerCodexArgs: bypass }, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    const cmd = prompts[reviewLbl(calls, 1)] || ''
    ok(`S23i reviewerCodexArgs='${bypass}' → expectation is qual1/configured`, / --qualification qual1 /.test(cmd) && / --connection configured\b/.test(cmd), cmd.slice(0, 260))
    ok(`S23i …and the review is ACCEPTED (loop reaches done, not infra drift) [${bypass}]`, res.status === 'done', res.status)
  }

  // S23j: an admitted OpenAI-compatible reviewer is a first-class workflow lane, not merely a
  // dispatcher implementation. Its exact public route + qualification travel through the child
  // environment, and the independently issued admit1 authority must come back in the binding.
  {
    const qualification = `qual1:${'b'.repeat(64)}`
    const external = {
      task: 't', reviewerBackend: 'http_openai_compat', reviewerModel: 'grok-4.6',
      reviewerProfileBackend: 'xai', reviewerTrainingOrg: 'xai',
      reviewerTransport: 'direct_https', reviewerConnection: 'xai-primary',
      reviewerQualification: qualification,
    }
    let missingThrew = null
    try {
      await runLoop({ ...external, reviewerQualification: undefined }, {})
    } catch (e) { missingThrew = String((e && e.message) || e) }
    ok('S23j external reviewer missing exact route metadata refuses before work starts',
      !!missingThrew && /requires exact/.test(missingThrew), missingThrew)

    const { res, calls, prompts } = await runLoop(external, { ...clsStd, ...planOf('clear', ''), ...happyTail })
    const cmd = prompts[reviewLbl(calls, 1)] || ''
    ok('S23j external reviewer request binds exact backend/model/route/qualification',
      cmd.includes('--backend "http_openai_compat"') && cmd.includes('--model "grok-4.6"')
      && cmd.includes('--transport direct_https') && cmd.includes('--connection xai-primary')
      && cmd.includes(`--qualification ${qualification}`), cmd.slice(0, 420))
    ok('S23j external reviewer child receives non-secret exact profile identity',
      cmd.includes('CAMUS_HTTP_REVIEW_PROFILE_BACKEND="xai"')
      && cmd.includes('CAMUS_HTTP_REVIEW_MODEL="grok-4.6"')
      && cmd.includes('CAMUS_HTTP_REVIEW_TRANSPORT="direct_https"')
      && cmd.includes('CAMUS_HTTP_REVIEW_CONNECTION="xai-primary"')
      && cmd.includes('CAMUS_REVIEWER_TRAINING_ORG="xai"')
      && cmd.includes(`CAMUS_REVIEW_QUALIFICATION="${qualification}"`), cmd.slice(-800))
    ok('S23j admitted external review reaches done and preserves exact admission provenance',
      res.status === 'done' && res.reviewerAdmissionId === `admit1:${'a'.repeat(64)}`,
      `${res.status}/${res.reviewerAdmissionId}`)

    const noAdmission = {
      ...clsStd, ...planOf('clear', ''), ...happyTail,
      review: (p) => {
        const gate = JSON.parse(bindReviewOutput(J({ ran: true, clean: true, blocking: [], nonblocking: [] }), p))
        delete gate.binding.admission_id
        return J(gate)
      },
    }
    const refused = await runLoop(external, noAdmission)
    ok('S23j external verdict without admit1 authority fails closed as reviewer infra',
      refused.res.status === 'infra_error' && /admission/.test(refused.res.error || ''),
      `${refused.res.status}/${refused.res.error}`)

    const handle = `/home/u/.camus/reviews/${wtName('t')}-r1.watch`
    let attached = 0
    const pendingThenClean = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, ...cleanVerify,
      commit: happyTail.commit, verify: happyTail.verify,
      review: () => (++attached === 1
        ? J({ pending: true, handle, last_event_age: 2 })
        : J({ ran: true, clean: true, blocking: [], nonblocking: [] })),
    }
    const awaited = await runLoop(external, pendingThenClean)
    const awaitLabel = awaited.calls.find((c) => /await1$/.test(c))
    const awaitCmd = awaited.prompts[awaitLabel] || ''
    ok('S23j external await preserves exact admitted route and effort', awaited.res.status === 'done'
      && awaitCmd.includes('CAMUS_REVIEWER="http_openai_compat"')
      && awaitCmd.includes('CAMUS_HTTP_REVIEW_PROFILE_BACKEND="xai"')
      && awaitCmd.includes('CAMUS_HTTP_REVIEW_CONNECTION="xai-primary"')
      && awaitCmd.includes('CAMUS_REVIEW_EFFORT=medium'), awaitCmd.slice(-650))

    const neverCompletes = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ pending: true, handle, last_event_age: 2 }),
      'review-abort': J({ ran: false, error: 'aborted', clean: false, blocking: [], nonblocking: [] }),
    }
    const aborted = await runLoop({ ...external, roundCap: 1 }, neverCompletes)
    const abortLabel = aborted.calls.find((c) => c.startsWith('review-abort'))
    const abortCmd = aborted.prompts[abortLabel] || ''
    ok('S23j external abort preserves exact admitted route and effort', aborted.res.status === 'infra_error'
      && abortCmd.includes('CAMUS_REVIEWER="http_openai_compat"')
      && abortCmd.includes('CAMUS_HTTP_REVIEW_MODEL="grok-4.6"')
      && abortCmd.includes('CAMUS_HTTP_REVIEW_TRANSPORT="direct_https"')
      && abortCmd.includes('CAMUS_REVIEW_EFFORT=medium'), abortCmd.slice(-650))
  }

  // S24 (smoke 2026-06-12): ONESHOT carries the fix agent's CLAIMED resolution per finding —
  // a reader must be able to tell addressed-unreviewed from untouched. Claims, never verdicts.
  {
    const finding = { priority: 1, title: 'edge case', code_location: 'a.ts:1' }
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ ran: true, clean: false, blocking: [finding], nonblocking: [] }),
      fix: { resolutions: [{ title: 'edge case', resolution: 're-exported the symbol from the original module' }] },
      commit: J({ committed: true, sha: h40('c1') }), ...cleanVerify, verify: J({ pass: true, failures: [], head: h40('c1') }),
    }
    const { res, prompts } = await runLoop({ task: 't', posture: 'oneshot' }, stubs)
    ok('S24 claimed resolution attached to the verbatim finding', res.status === 'done_with_findings' && res.findings[0].claimedResolution === 're-exported the symbol from the original module', JSON.stringify(res.findings))
    ok('S24 fix prompt demands per-finding resolutions under oneshot', !!prompts['fix:r1'] && prompts['fix:r1'].includes('return resolutions[]'))
  }
  {
    const { prompts } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...blockP1 })
    ok('S24b full posture fix prompt does NOT ask for resolution claims', !(prompts['fix:r1'] || '').includes('return resolutions[]'))
  }

  // S25 (smoke 2026-06-12, the headline): WORKTREE CONTAINMENT — under a feat (idSalt), the
  // main repo tree is checked after implement and after any fix; dirt = a leak, halted LOUDLY
  // at the phase that caused it. Standalone loops (user's own working style) are never checked.
  {
    const salt = 'feat123'
    const base25 = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('c1') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('c1') }),
    }
    const clean = await runLoop({ task: 't', idSalt: salt }, { ...base25, containment: J({ ran: true, dirty: false, paths: '' }) })
    ok('S25a clean main tree → done, containment checked', clean.res.status === 'done' && clean.calls.includes('containment:implement'), clean.res.status + ' ' + clean.calls.join(','))
    // git audit 2026-06-12: a merged submodule-pointer bump leaves permanent ` M sub` porcelain —
    // the guard must ignore submodule noise or every later task false-fires.
    ok('S25a2 containment ignores submodule noise', (clean.prompts['containment:implement'] || '').includes('/containment.sh'))
    const leaky = await runLoop({ task: 't', idSalt: salt }, { ...base25, containment: leakAfterBaseline(' M packages/x.ts') })
    ok('S25b implement leak → infra halt naming the phase', leaky.res.status === 'infra_error' && leaky.res.containment === 'implement', leaky.res.status + '/' + leaky.res.containment)
    ok('S25b note names the leaked paths + recovery', /packages\/x\.ts/.test(leaky.res.note) && /diff them against the task worktree/.test(leaky.res.note))
  }
  {
    // fix-phase containment: both breach and inconclusive terminals happen AFTER
    // accepted reviewer receipts, so both must preserve the latest bound identity.
    const salt = 'feat123'
    const runFixContainment = (finalReceipt) => {
      let calls = 0
      return runLoop({ task: 't', idSalt: salt, roundCap: 2 }, {
        ...clsStd, ...planOf('clear', ''),
        implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
        review: (() => { let r = 0; return () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 't' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) } })(),
        // calls: baseline (clean) → implement-check (clean) → fix-check (the control).
        fix: '', containment: () => (++calls <= 2 ? J({ ran: true, dirty: false, paths: '' }) : J(finalReceipt)),
        prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }),
      })
    }
    const breach = (await runFixContainment({ ran: true, dirty: true, paths: ' M lib/leaked.ts' })).res
    ok('S25c fix leak caught post-loop, named as the fix phase', breach.status === 'infra_error' && breach.containment === 'fix', breach.status + '/' + breach.containment)
    ok('S25c fix leak terminal preserves the latest receipt-bound reviewer identity',
      breach.reviewerBackend === 'codex' && breach.reviewerModel === null && breach.reviewerModelStatus === 'not_recorded'
        && breach.reviewerEffort === 'high' && breach.reviewerRound === 2,
      `${breach.reviewerBackend}/${JSON.stringify(breach.reviewerModel)}/${breach.reviewerEffort}/r${breach.reviewerRound}`)
    const inconclusive = (await runFixContainment({ ran: false, error: 'containment probe unavailable' })).res
    ok('S25c inconclusive fix containment is distinct from a breach',
      inconclusive.status === 'infra_error' && inconclusive.containment === 'fix_inconclusive',
      inconclusive.status + '/' + inconclusive.containment)
    ok('S25c inconclusive fix containment preserves the same reviewer provenance',
      inconclusive.reviewerBackend === 'codex' && inconclusive.reviewerModel === null
        && inconclusive.reviewerModelStatus === 'not_recorded' && inconclusive.reviewerEffort === 'high' && inconclusive.reviewerRound === 2,
      `${inconclusive.reviewerBackend}/${JSON.stringify(inconclusive.reviewerModel)}/${inconclusive.reviewerEffort}/r${inconclusive.reviewerRound}`)
  }
  {
    // standalone (no idSalt): even a would-be-dirty tree is never checked — not a breach.
    const { res, calls } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail, containment: J({ ran: true, dirty: true, paths: ' M anything.ts' }) })
    ok('S25d standalone loop → containment never runs', res.status === 'done' && !calls.some((c) => c.startsWith('containment')), calls.join(','))
  }
  // F55 (live re-soak 2026-06-14): the UNTRACKED-DELTA — the actual blocker. containment.sh now reports
  // untracked files (an untracked leak ABORTS the merge — how a classifier-leaked test file hard-failed
  // integration); the loop deltas against a baseline captured before any phase, so a NEW untracked leak
  // fires but pre-existing/baseline-verify artifacts don't cry wolf.
  {
    const salt = 'feat123'
    const base = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      commit: J({ committed: true, sha: h40('c1') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('c1') }),
    }
    // (a) an UNTRACKED file leaked after the baseline → breach (the exact finding)
    const r1 = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: leakAfterBaseline('?? packages/ai/src/__tests__/model-selector.test.ts') })
    ok('F55 untracked leak (the finding) → breach naming it', r1.res.status === 'infra_error' && r1.res.containment === 'implement' && /model-selector\.test\.ts/.test(r1.res.note || ''), r1.res.status + '/' + r1.res.containment)
    // (b) pre-existing dirt present at BOTH baseline and check → NOT re-flagged (delta ignores it)
    const r2 = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: J({ ran: true, dirty: true, paths: '?? local-scratch.txt' }) })
    ok('F55 pre-existing baseline dirt is NOT a breach (no cry-wolf)', r2.res.status === 'done', r2.res.status)
    // (c) mix: baseline has X; post-implement has X + new Y → breach names ONLY Y
    const mixed = (p, opts) => J(((opts && opts.label) || '').endsWith(':baseline')
      ? { ran: true, dirty: true, paths: '?? local-scratch.txt' }
      : { ran: true, dirty: true, paths: '?? local-scratch.txt\n?? leaked.ts' })
    const r3 = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: mixed })
    ok('F55 delta names ONLY the new dirt, not the pre-existing', r3.res.status === 'infra_error' && /leaked\.ts/.test(r3.res.note || '') && !/local-scratch/.test(r3.res.note || ''), r3.res.note)
  }

  // S26 (live smoke run-2, 2026-06-12): a worktree/branch COLLISION must be declared, not
  // improvised around — the implement prompt forbids alternative git commands, and a declared
  // FAILED path surfaces as a collision infra error pointing at the resume lanes.
  {
    const stubs = { ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: 'FAILED', branch: 'b', summary: "fatal: a branch named 'camus/x' already exists" },
      'collision-audit': '2' }
    const { res, prompts } = await runLoop({ task: 't' }, stubs)
    ok('S26 declared collision → infra_error naming the cause', res.status === 'infra_error' && /collision/.test(res.error || ''), res.status + ' ' + res.error)
    ok('S26 prior-work collision (commits>0) → resume-lane advice', /resume lanes land proven prior work/.test(res.note || '') && /2 commit/.test(res.note || ''), res.note)
    ok('S26 implement prompt forbids improvising around failures', !!prompts.implement && prompts.implement.includes('do NOT improvise any git commands'))
    ok('S26 worktree creation goes through wt.sh (no agent-typed hookless git — run-5 classifier denial)', !!prompts.implement && prompts.implement.includes('/wt.sh create') && !prompts.implement.includes('git -c core.hooksPath'))
  }
  {
    // git audit 2026-06-12 (P2): `worktree add -b` is NON-ATOMIC — a hook/smudge failure leaves an
    // EMPTY branch behind. The old advice ("resume lands prior work") would wedge forever; the
    // collision audit disambiguates and names the one-line cleanup.
    const stubs = { ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: 'FAILED', branch: 'b', summary: 'fatal: post-checkout hook failed' },
      'collision-audit': '0' }
    const { res } = await runLoop({ task: 't' }, stubs)
    ok('S26b empty-residue collision → branch -D advice, never the resume-lane lie', /empty residue/.test(res.note || '') && /git branch -D/.test(res.note || '') && !/resume lanes land proven/.test(res.note || ''), res.note)
  }
  {
    const stubs = { ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: 'FAILED', branch: 'b', summary: "fatal: a branch named 'camus/x' already exists" },
      'collision-audit': 'fatal: ambiguous argument' }
    const { res } = await runLoop({ task: 't' }, stubs)
    ok('S26c malformed collision-audit → inconclusive advice, never the resume-lane lie', res.status === 'infra_error' && /could not verify/.test(res.note || '') && !/resume lanes land proven/.test(res.note || '') && res.collisionAuditOutput === 'fatal: ambiguous argument', res.note)
  }

  // S7: worktree path contract (2026-06-10) — centralized out-of-tree home + fail-closed validation.
  {
    const { res, prompts } = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('S7a implement told to use ~/.camus/worktrees', !!prompts.implement && prompts.implement.includes('$HOME/.camus/worktrees/'))
    ok('S7a worktree created via wt.sh at the repo-unique home', !!prompts.implement && prompts.implement.includes('/wt.sh create'))
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

  // merge.sh's RECEIPT (run-6 cross-check) must echo the relay for a merge to count — the
  // harness mirrors that by deriving the receipt stub from the same object as the relay stub.
  const featMerge = { merged: true, committed: true, alreadyUpToDate: false, before: 'aaa', after: 'bbb', priorMergeCommit: null }
  const featBase = {
    preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: '', argsPresent: false },
    'fork-scan': J({ feats: [] }),          // no in-progress twin feat (0.2.7 item 8); fail-open if absent
    'parent-tree': J({ ran: true, dirty: false, paths: '' }), // clean main checkout at each task boundary (0.2.7 finding B)
    'steer': J({ read: true, note: null }), // steer_read.py sentinel: no note (0.2.7 item 7)
    'steer-consume': J({ consumed: true }), // a present note is consumed exactly-once (0.2.7 P2; apply gates on this)
    'feat-branch': { ok: true, branch: 'camus/feat-x', created: true },
    'env-check': { ready: true, exitCode: 0, output: 'ok' },
    'baseline-verify': J({ pass: true, failures: [] }),
    'env-recheck': { ready: true, exitCode: 0, output: 'ok' },
    'integration-verify': J({ pass: true, failures: [], head: featMerge.after }),   // a bound green must name the proven tip
    merge: featMerge,
    'merge-receipt': J(featMerge),
    'merge-head': featMerge.after,   // live branch tip sits exactly where the receipt says
    'noop-audit': '0',
    'self-audit': (p) => {
      const out = []
      let inBranches = false
      for (const line of String(p || '').split('\n')) {
        if (line.includes('Nothing else.')) { inBranches = true; continue }
        if (inBranches && line.trim().startsWith('Run `')) break
        if (inBranches && line.trim()) out.push(`${line.trim()} 0`)
      }
      return out.join('\n')
    },
    args: { written: true }, report: { written: true }, state: { written: true },
  }
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'needs_human', question: 'Pick A or B?', clarity: 'ambiguous', interpretations: ['A', 'B'], plan: 'p' }])
    ok('F1 feat halts needs_human', res && res.status === 'needs_human', res && res.status)
    ok('F1 question in report', res && res.question === 'Pick A or B?')
    ok('F1 resumeWith hint present', !!(res && res.resumeWith && res.resumeWith.answers))
  }
  // F33 (live smoke run-3, 2026-06-12): args arriving as a JS-style literal STRING (unquoted
  // keys — a fresh session forwarded the paste verbatim) must throw an error that TEACHES the
  // strict-JSON form. Stringified STRICT JSON keeps working. No silent key-quoting repair —
  // task strings contain `, word:` shapes a string-blind transform would corrupt.
  {
    let threw = null
    try { await runFeat('{ feat: "F", tasks: ["t"] }', featBase, []) } catch (e) { threw = String((e && e.message) || e) }
    ok('F33 JS-literal string args → teaching error', !!threw && /strict JSON/.test(threw) && /quoted keys/.test(threw), threw)
    const { res } = await runFeat(JSON.stringify({ feat: 'F', tasks: ['only task'] }), featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F33b stringified STRICT JSON args still work', res && res.status === 'done', res && res.status)
  }
  // F15 (smoke 2026-06-11): the feat lifts the env doctor's delimited [env-facts] block VERBATIM
  // and threads it to every task's loop as envFacts; no block (or a garbled one) → no key at all.
  {
    const FACTS = 'platform: darwin (macOS)\nGNU `timeout` is NOT on PATH'
    const featFacts = { ...featBase, 'env-check': { ready: true, exitCode: 0,
      output: `ok: environment ready.\n[env-facts]\n${FACTS}\n[/env-facts]` } }
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featFacts,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F15 env facts lifted and threaded to the loop', !!loopArgs[0] && loopArgs[0].envFacts === FACTS, JSON.stringify(loopArgs[0] && loopArgs[0].envFacts))
  }
  {
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F15b no facts block → no envFacts key forwarded', !!loopArgs[0] && !('envFacts' in loopArgs[0]), JSON.stringify(loopArgs[0] && loopArgs[0].envFacts))
  }
  // F16 (0.2.5 item 5): an oscillating loop halt is surfaced AS oscillating at the feat level —
  // the human's note must say "distrust the signal", not just "didn't converge".
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: true, oscillating: true, stuck: [{ title: 'flip' }], blocking: [{ priority: 1, title: 'flip' }] }])
    ok('F16 oscillating surfaced on the feat halt', res && res.oscillating === true)
    ok('F16 note names the oscillation, not just non-convergence', /OSCILLATED/.test((res && res.note) || ''))
  }
  // F17 (fixlet 2026-06-11): SIBLING BRIEFS — each task's loop gets the OTHER tasks (with live
  // status), never itself; single-task feats forward no key at all.
  {
    const sibFeat = 'SIB', sibTasks = ['task one', 'task two']
    const s1 = taskIdOf(sibFeat, sibTasks, 'task one'), s2 = taskIdOf(sibFeat, sibTasks, 'task two')
    const { loopArgs } = await runFeat({ feat: sibFeat, tasks: sibTasks }, featBase,
      [{ status: 'done', branch: 'x', decisions: [] }, { status: 'done', branch: 'y', decisions: [] }])
    ok('F17 task1 sees task2 as a sibling', !!loopArgs[0] && String(loopArgs[0].siblingTasks || '').includes(s2), JSON.stringify(loopArgs[0] && loopArgs[0].siblingTasks))
    ok('F17 task2 sees task1 with its LIVE status', !!loopArgs[1] && String(loopArgs[1].siblingTasks || '').includes(`${s1} [done]`), JSON.stringify(loopArgs[1] && loopArgs[1].siblingTasks))
    ok('F17 a task never lists itself', !!loopArgs[0] && !String(loopArgs[0].siblingTasks || '').includes(s1))
  }
  {
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F17b single-task feat → no siblingTasks key', !!loopArgs[0] && !('siblingTasks' in loopArgs[0]))
  }
  // F18 (0.2.5 item 4): TOKEN BUDGET CEILING — persisted cross-run spend ≥ budgetTokens halts
  // needs_human at the task boundary BEFORE dispatching the next loop; under budget proceeds.
  // resumeArgs must carry budgetTokens (the canonical-args discipline: a resumer that drops it
  // would silently un-cap the run).
  {
    const bFeat = 'B', bTasks = ['task one', 'task two']
    const b1 = taskIdOf(bFeat, bTasks, 'task one'), b2 = taskIdOf(bFeat, bTasks, 'task two')
    const bid = featIdOf(bFeat, bTasks)
    const prior = {
      featId: bid, feat: bFeat, featBranch: 'camus/feat-' + bid, status: 'halted',
      resumeArgs: { argsVersion: 1, feat: bFeat, tasks: bTasks, policy: 'ask_on_ambiguity', budgetTokens: 50000 },
      tasks: [
        { taskId: b1, spec: 'task one', dependsOn: [], status: 'done', branch: `camus/feat/${bid}/${b1}`, loopStatus: 'done', decisions: [], tokens: 90000 },
        { taskId: b2, spec: 'task two', dependsOn: [], status: 'pending', branch: `camus/feat/${bid}/${b2}`, loopStatus: null },
      ], events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const over = await runFeat({ feat: bFeat, tasks: bTasks, budgetTokens: 50000 }, featR, [])
    ok('F18 ceiling halts needs_human at the boundary', over.res && over.res.status === 'needs_human' && over.res.stage === 'budget', over.res && (over.res.status + '/' + over.res.stage))
    ok('F18 no loop dispatched past the cap', over.workflowCalls === 0, String(over.workflowCalls))
    ok('F18 spent vs budget surfaced for the human', over.res && over.res.spentTokens === 90000 && over.res.budgetTokens === 50000, over.res && JSON.stringify([over.res.spentTokens, over.res.budgetTokens]))
    ok('F18 resume args sidecar persists budgetTokens', !!over.argsJSON && over.argsJSON.budgetTokens === 50000, over.argsJSON && JSON.stringify(over.argsJSON))
    const under = await runFeat({ feat: bFeat, tasks: bTasks, budgetTokens: 200000 }, featR,
      [{ status: 'done', branch: `camus/feat/${bid}/${b2}`, decisions: [] }])
    ok('F18b under budget → the next task runs', under.workflowCalls === 1 && under.res && under.res.status === 'done', under.res && under.res.status)
  }
  // F21 (VELOCITY §3 rule 1): an EXPLICIT posture is used verbatim — no recommendation agent,
  // forwarded to every loop, persisted, loud in the report, carried in resumeArgs.
  {
    const { res, calls, loopArgs, stateJSON, argsJSON } = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F21 explicit posture → forwarded, no rec agent', !!loopArgs[0] && loopArgs[0].posture === 'oneshot' && !calls.includes('posture-rec'), JSON.stringify(loopArgs[0] && loopArgs[0].posture))
    ok('F21 posture persisted + in the report header', !!stateJSON && stateJSON.posture === 'oneshot' && res.posture === 'oneshot')
    ok('F21 resume args sidecar carries the EXPLICIT posture', !!argsJSON && argsJSON.posture === 'oneshot')
  }
  {
    let threw = null
    try { await runFeat({ feat: 'F', tasks: ['t'], posture: 'forward' }, featBase, []) } catch (e) { threw = String((e && e.message) || e) }
    ok('F21b forward/bookend rejected loudly at the feat too', !!threw && /0\.3/.test(threw), threw)
  }
  // F22 (VELOCITY §3 rules 2+3): posture absent → classifier recommends; oneshot under an asking
  // policy pauses ONCE; autonomous applies it ON THE RECORD; a full recommendation never asks.
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'posture-rec': { posture: 'oneshot', why: 'all tasks trivial, small diffs' } }, [])
    ok('F22 oneshot rec + asking policy → ONE confirm pause', res && res.status === 'needs_human' && res.stage === 'posture', res && (res.status + '/' + res.stage))
    ok('F22 nothing ran before the confirm', workflowCalls === 0, String(workflowCalls))
    ok('F22 the trade is named in the question', /all tasks trivial/.test((res && res.question) || ''))
  }
  {
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'], policy: 'autonomous' },
      { ...featBase, 'posture-rec': { posture: 'oneshot', why: 'all tasks trivial' } },
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F22b autonomous applies oneshot + records the decision', !!loopArgs[0] && loopArgs[0].posture === 'oneshot' && res && res.postureDecision && res.postureDecision.source === 'classifier_autonomous', res && JSON.stringify(res.postureDecision))
  }
  {
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'posture-rec': { posture: 'full', why: 'a task looks cross-cutting' } },
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F22c full rec → proceeds WITHOUT asking (no depth reduced)', res && res.status === 'done' && !!loopArgs[0] && !('posture' in loopArgs[0]), res && res.status)
  }
  // F23 (VELOCITY §1): a done_with_findings task MERGES; the feat ends done_with_findings with
  // the findings verbatim; resume treats it as terminal; the posture carries across resumes.
  {
    const finding = { priority: 2, title: 'deferred edge', code_location: 'b.ts:2' }
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featBase,
      [{ status: 'done_with_findings', branch: 'camus/feat/x/only', decisions: [], findings: [finding], findingsDeferred: 1, resolution: 'fixed_unreviewed', commit_sha: h40('c1') }])
    ok('F23 dwf task merges; feat ends done_with_findings', r1.res && r1.res.status === 'done_with_findings', r1.res && r1.res.status)
    ok('F23 findings verbatim in the report', JSON.stringify((r1.res && r1.res.deferredFindings) || []).includes('deferred edge'))
    ok('F23 node carries ◈-able status + count', !!r1.stateJSON && r1.stateJSON.tasks[0].status === 'done_with_findings' && r1.stateJSON.tasks[0].findingsDeferred === 1)
    ok('F23 note never reads as plain done', /NOT review-clean|never a plain done/i.test((r1.res && r1.res.note) || ''))
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(r1.stateJSON) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featResume, [])
    ok('F23b resume: dwf is TERMINAL for camus (skipped, never re-litigated)', r2.workflowCalls === 0 && r2.res && r2.res.status === 'done_with_findings', r2.res && r2.res.status)
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'] }, featResume, [])
    ok('F23c resolved posture carries from prior state (no re-recommendation)', r3.res && r3.res.posture === 'oneshot' && !r3.calls.includes('posture-rec'), r3.res && r3.res.posture)
    // P3 follow-up: the stub's res.branch differs from the deterministic node branch, so the
    // merge consumed res.branch — merged[] must name THAT (what actually merged), never the
    // deterministic expectation.
    ok('F23d merged list names the branch ACTUALLY merged (dwf included)', Array.isArray(r1.res.merged) && r1.res.merged.length === 1 && r1.res.merged[0] === 'camus/feat/x/only', JSON.stringify(r1.res && r1.res.merged))
  }
  {
    // Full posture cannot silently merge the final bounded repair when its P0/P1 finding has
    // not been independently re-reviewed. This is also a defense against an older loop runtime
    // returning done_with_findings instead of review_unresolved.
    const finding = { priority: 1, title: 'unreviewed trust break', code_location: 'gate.ts:7' }
    const r = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'full' }, featBase,
      [{ status: 'done_with_findings', branch: 'camus/feat/x/only', decisions: [], findings: [finding], findingsDeferred: 1, resolution: 'fixed_unreviewed', commit_sha: h40('p1park') }])
    ok('F23e full + unreviewed P1 halts before merge', r.res && r.res.status === 'halted' && r.res.haltReason === 'unreviewed_p0_p1', r.res && (r.res.status + '/' + r.res.haltReason))
    ok('F23e merge and integration never run', !r.calls.some((c) => c.startsWith('merge:')) && !r.calls.includes('integration-verify'), r.calls.join(','))
    ok('F23e proof parks as needs_decision with finding + sha', !!r.stateJSON && r.stateJSON.tasks[0].status === 'needs_decision' && r.stateJSON.tasks[0].provenCommit === h40('p1park') && r.stateJSON.tasks[0].deferredFindings[0].priority === 1, JSON.stringify(r.stateJSON && r.stateJSON.tasks[0]))
  }
  // F24 (audit P1 2026-06-11, the F14-style crash window for done_with_findings): the proof
  // persist carries the loop's REAL verdict, and BOTH resume lanes — auto-land and the
  // prior-merge-commit evidence path — restore it. Land mode only ever says plain done; without
  // the stash+restore, a death in the commit→merge window LAUNDERS review debt into done.
  {
    const finding = { priority: 1, title: 'laundered?', code_location: 'c.ts:3' }
    // (a) live run: the ready_to_merge MID-persist already carries provenStatus + findings.
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featBase,
      [{ status: 'done_with_findings', branch: 'camus/feat/x/only', decisions: [{ what: 'W', why: 'Y' }], findings: [finding], findingsDeferred: 1, resolution: 'fixed_unreviewed', commit_sha: h40('c1') }])
    const mid = (r1.stateJSONs || [])
      .find((s) => s && s.tasks && s.tasks[0] && s.tasks[0].status === 'ready_to_merge')
    ok('F24a proof persist stashes provenStatus + findings BEFORE the merge',
      !!mid && mid.tasks[0].provenStatus === 'done_with_findings' && mid.tasks[0].findingsDeferred === 1 && JSON.stringify(mid.tasks[0].deferredFindings).includes('laundered'),
      mid && JSON.stringify(mid.tasks[0]))
    ok('F24a …and the proof\'s sha (publish audit round-2: the auto-land binds verify to it)',
      !!mid && mid.tasks[0].provenCommit === h40('c1'), mid && mid.tasks[0].provenCommit)
    // (b) crash BEFORE the merge → resume auto-lands (land returns plain done) → verdict restored.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const prior = JSON.parse(JSON.stringify(r1.stateJSON))
    prior.status = 'running'
    prior.tasks[0] = { ...prior.tasks[0], status: 'ready_to_merge', provenStatus: 'done_with_findings', provenCommit: h40('pr00f'), findingsDeferred: 1, deferredFindings: [finding], decisions: [{ what: 'W', why: 'Y' }] }
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: h40('land1'), landed: true, decisions: [] }])
    ok('F24b auto-land restores done_with_findings (never laundered to done)',
      !!r2.stateJSON && r2.stateJSON.tasks[0].status === 'done_with_findings' && r2.res && r2.res.status === 'done_with_findings',
      r2.stateJSON && r2.stateJSON.tasks[0].status + '/' + (r2.res && r2.res.status))
    ok('F24b findings + decisions survive the land (empty land decisions do not clobber)',
      !!r2.stateJSON && r2.stateJSON.tasks[0].findingsDeferred === 1 && JSON.stringify(r2.res.deferredFindings || []).includes('laundered') && r2.stateJSON.tasks[0].decisions.length === 1,
      r2.stateJSON && JSON.stringify(r2.stateJSON.tasks[0]))
    ok('F24b auto-land carries expectHead = the proven sha (publish audit round-2)',
      !!(r2.loopArgs[0] && r2.loopArgs[0].land === true && r2.loopArgs[0].expectHead === h40('pr00f')), JSON.stringify(r2.loopArgs[0] && { land: r2.loopArgs[0].land, expectHead: r2.loopArgs[0].expectHead }))
    // (c) crash AFTER the merge → already-up-to-date + prior-merge-commit evidence → same restore.
    const upToDateMerge = { merged: true, committed: false, alreadyUpToDate: true, priorMergeCommit: 'deadbeef', before: 'aaa', after: 'aaa' }
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' },
      { ...featResume, merge: upToDateMerge, 'merge-receipt': J(upToDateMerge), 'merge-head': upToDateMerge.after, 'integration-verify': J({ pass: true, failures: [], head: upToDateMerge.after }) },
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: h40('land1'), landed: true, decisions: [] }])
    ok('F24c prior-merge evidence path restores done_with_findings too',
      !!r3.stateJSON && r3.stateJSON.tasks[0].status === 'done_with_findings' && r3.res && r3.res.status === 'done_with_findings',
      r3.stateJSON && r3.stateJSON.tasks[0].status + '/' + (r3.res && r3.res.status))
    ok('F24c merged[] names the actually-merged branch on this lane too (audit P3, third lane)',
      Array.isArray(r3.res.merged) && r3.res.merged[0] === 'camus/feat/x/only', JSON.stringify(r3.res && r3.res.merged))
  }

  // F25 (smoke 2026-06-12): merge_failed WITH a proven verdict joins the auto-land lane — the
  // work is committed+verified on the task branch; once the human clears the merge blocker, a
  // plain re-run lands it mechanically instead of re-looping into a branch collision.
  {
    const finding = { priority: 2, title: 'deferred edge', code_location: 'b.ts:2' }
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = {
      featId: fid, feat: 'F', featBranch: 'camus/feat-' + fid, status: 'feat_integration_failed',
      resumeArgs: { argsVersion: 1, feat: 'F', tasks: ['only task'], policy: 'ask_on_ambiguity', posture: 'oneshot' },
      tasks: [{ taskId: tid, spec: 'only task', dependsOn: [], status: 'merge_failed', branch: `camus/feat/${fid}/${tid}`,
        loopStatus: 'done_with_findings', provenStatus: 'done_with_findings', findingsDeferred: 1, deferredFindings: [finding], decisions: [{ what: 'W', why: 'Y' }] }],
      events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featR,
      [{ status: 'done', branch: `camus/feat/${fid}/${tid}`, commit_sha: h40('land1'), landed: true, decisions: [] }])
    ok('F25 proven merge_failed → auto-land forwarded', !!(r1.loopArgs[0] && r1.loopArgs[0].land === true), JSON.stringify(r1.loopArgs[0] && r1.loopArgs[0].land))
    ok('F25 verdict + findings restored through the land', r1.res && r1.res.status === 'done_with_findings' && JSON.stringify(r1.res.deferredFindings || []).includes('deferred edge'), r1.res && r1.res.status)
  }
  {
    // merge_failed WITHOUT a proven verdict (died pre-review) → full loop, exactly as before.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = {
      featId: fid, feat: 'F', featBranch: 'camus/feat-' + fid, status: 'feat_integration_failed',
      resumeArgs: { argsVersion: 1, feat: 'F', tasks: ['only task'], policy: 'ask_on_ambiguity' },
      tasks: [{ taskId: tid, spec: 'only task', dependsOn: [], status: 'merge_failed', branch: `camus/feat/${fid}/${tid}`, loopStatus: 'infra_error', decisions: [] }],
      events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'] }, featR, [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F25b unproven merge_failed → full loop (no land)', !!(r2.loopArgs[0] && !('land' in r2.loopArgs[0])) && r2.res && r2.res.status === 'done', JSON.stringify(r2.loopArgs[0]))
  }
  // F34 (live smoke run-4, 2026-06-12): a MECHANICALLY failed land (aborted/infra) must not
  // destroy the proof — the branch's commits didn't change. Downgrading to `failed` erased
  // ready_to_merge and sent the next resume into a full-loop branch collision.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = {
      featId: fid, feat: 'F', featBranch: 'camus/feat-' + fid, status: 'halted',
      resumeArgs: { argsVersion: 1, feat: 'F', tasks: ['only task'], policy: 'ask_on_ambiguity' },
      tasks: [{ taskId: tid, spec: 'only task', dependsOn: [], status: 'ready_to_merge', provenStatus: 'done_with_findings', branch: `camus/feat/${fid}/${tid}`, loopStatus: 'done_with_findings', decisions: [] }],
      events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const { res, stateJSON } = await runFeat({ feat: 'F', tasks: ['only task'] }, featR,
      [{ status: 'aborted', stage: 'land', landed: false, note: 'no worktree' }])
    ok('F34 failed land preserves ready_to_merge (the proof survives)', !!stateJSON && stateJSON.tasks[0].status === 'ready_to_merge', stateJSON && stateJSON.tasks[0].status)
    ok('F34 halt note says retry the land, not re-loop', res && res.status === 'halted' && !!stateJSON && (stateJSON.events || []).some((e) => /stays ready_to_merge/.test(e.msg || '')), res && res.status)
  }
  // F34b (resume audit 2026-06-29): a land whose RE-VERIFY goes red/inconclusive (landed:true) must ALSO keep
  // the ready_to_merge lane, not collapse to `failed` — which matches no resume lane and wedges the next
  // resume in a full-loop branch collision. The auto-land re-verifies before merging, so it never false-merges.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = {
      featId: fid, feat: 'F', featBranch: 'camus/feat-' + fid, status: 'halted',
      resumeArgs: { argsVersion: 1, feat: 'F', tasks: ['only task'], policy: 'ask_on_ambiguity' },
      tasks: [{ taskId: tid, spec: 'only task', dependsOn: [], status: 'ready_to_merge', provenStatus: 'done', provenCommit: h40('pr00f'), branch: `camus/feat/${fid}/${tid}`, loopStatus: 'done', decisions: [] }],
      events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const red = await runFeat({ feat: 'F', tasks: ['only task'] }, featR,
      [{ status: 'verify_failed', landed: true, failures: [{ stage: 'verify', log_tail: 'flaky' }] }])
    ok('F34b land re-verify RED keeps ready_to_merge (not collapsed to failed → no wedge)',
      !!red.stateJSON && red.stateJSON.tasks[0].status === 'ready_to_merge', red.stateJSON && red.stateJSON.tasks[0].status)
    ok('F34b halt event points at camus land', red.res && red.res.status === 'halted' && (red.stateJSON && (red.stateJSON.events || []).some((e) => /camus land/.test(e.msg || ''))), red.res && red.res.status)
    const inc = await runFeat({ feat: 'F', tasks: ['only task'] }, featR,
      [{ status: 'verify_inconclusive', landed: true, failures: [{ stage: 'verify', log_tail: 'env' }] }])
    ok('F34b land verify_inconclusive keeps ready_to_merge too', !!inc.stateJSON && inc.stateJSON.tasks[0].status === 'ready_to_merge', inc.stateJSON && inc.stateJSON.tasks[0].status)
  }

  // F26 (smoke 2026-06-12): feat-level pauses reach the BOARD — finalize persists question+stage
  // on the state; the rec-why's trailing period is stripped (no more "defensible.. Review").
  {
    const { res, stateJSON } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'posture-rec': { posture: 'oneshot', why: 'all tasks trivial.' } }, [])
    ok('F26 posture pause persists question + stage on the state', !!stateJSON && stateJSON.stage === 'posture' && /all tasks trivial/.test(stateJSON.question || ''), stateJSON && (stateJSON.stage + ' / ' + stateJSON.question))
    ok('F26 trailing period stripped — no doubled period anywhere', !/\.\./.test((res && res.question) || '') && !/\.\./.test((stateJSON && stateJSON.question) || ''), res && res.question)
  }
  {
    const bTasks = ['task one', 'task two']
    const b1 = taskIdOf('B', bTasks, 'task one'), bid = featIdOf('B', bTasks)
    const prior = {
      featId: bid, feat: 'B', featBranch: 'camus/feat-' + bid, status: 'halted',
      resumeArgs: { argsVersion: 1, feat: 'B', tasks: bTasks, policy: 'ask_on_ambiguity', budgetTokens: 50000 },
      tasks: [
        { taskId: b1, spec: 'task one', dependsOn: [], status: 'done', branch: 'x', loopStatus: 'done', decisions: [], tokens: 90000 },
        { taskId: taskIdOf('B', bTasks, 'task two'), spec: 'task two', dependsOn: [], status: 'pending', branch: 'y', loopStatus: null },
      ], events: [], eventSeq: 0,
    }
    const featR = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const { stateJSON } = await runFeat({ feat: 'B', tasks: bTasks, budgetTokens: 50000 }, featR, [])
    ok('F26b budget pause persists stage + question on the state', !!stateJSON && stateJSON.stage === 'budget' && /budget/i.test(stateJSON.question || ''), stateJSON && (stateJSON.stage + ' / ' + stateJSON.question))
  }

  // F29 (product question 2026-06-12): a non-git directory gets a CRISP refusal naming the
  // local-only entry fee — previously it flailed into a misleading dirty_tree halt.
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: false, base: 'NOT_A_REPO', dirtyFiles: 0, stateRaw: '' } }, [])
    ok('F29 non-git dir → not_a_git_repo, nothing runs', res && res.status === 'not_a_git_repo' && workflowCalls === 0, res && res.status)
    ok('F29 note names the local entry fee + no GitHub', /git init && git add -A/.test((res && res.note) || '') && /no GitHub/.test((res && res.note) || '') && /--allow-empty/.test((res && res.note) || ''), res && res.note)
  }
  // F30/F31 (git audit 2026-06-12): unborn repos (zero commits — worktree add infers --orphan,
  // the guard then refuses MID-loop after implement paid) and detached HEADs (the feat would cut
  // from the parked commit) are refused AT PREFLIGHT with the exact remedy.
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: false, base: 'UNBORN', dirtyFiles: 0, stateRaw: '' } }, [])
    ok('F30 unborn repo → refused with --allow-empty baseline recipe', res && res.status === 'unborn_repo' && workflowCalls === 0 && /--allow-empty/.test(res.note || ''), res && res.status)
  }
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: 'HEAD', dirtyFiles: 0, stateRaw: '' } }, [])
    ok('F31 detached HEAD → refused, names the checkout remedy', res && res.status === 'detached_head' && workflowCalls === 0 && /git checkout/.test(res.note || ''), res && res.status)
  }
  // F32 (git audit 2026-06-12): gate-owned git mutations run HOOKLESS and UNSIGNED — the merge
  // runner's commands carry the -c flags and the abort-on-ANY-failure instruction (a half-merge
  // left behind poisons every later run as dirty_tree).
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { prompts } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    const mp = prompts['merge:' + tid] || ''
    ok('F32 merge goes through merge.sh (no agent-typed git — run-5 classifier denial)', mp.includes('/merge.sh') && !mp.includes('git -c'), mp.slice(0, 160))
    ok('F32 thin runner transcribes, never re-judges', mp.includes('EXACTLY as the script computed them'))
    ok('F32 preflight porcelain ignores submodule noise', (prompts.preflight || '').includes('--ignore-submodules=all'))
  }

  // F27 (live smoke run-2, 2026-06-12): the NOOP RESCUE — "no_changes" with unmerged commits on
  // the task branch is a prior run's PROVEN work (a collision the agent improvised around),
  // never a no-op. The feat re-enters the task as an auto-land in the SAME run.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const r = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'noop-audit': '3' },
      [{ status: 'no_changes', worktree: wtPath('only task') },
       { status: 'done', branch: 'camus/feat/x/only', commit_sha: h40('land1'), landed: true, decisions: [] }])
    ok('F27 unmerged commits → rescue re-enters as auto-land', r.workflowCalls === 2 && !!(r.loopArgs[1] && r.loopArgs[1].land === true), 'calls=' + r.workflowCalls + ' land=' + JSON.stringify(r.loopArgs[1] && r.loopArgs[1].land))
    ok('F27 rescued task ends merged-done, feat done', !!r.stateJSON && r.stateJSON.tasks[0].status === 'done' && r.res && r.res.status === 'done', r.stateJSON && r.stateJSON.tasks[0].status)
    ok('F27 the rescue is loud in the run log', !!r.stateJSON && (r.stateJSON.events || []).some((e) => /unmerged commit\(s\) — a prior run's proven work/.test(e.msg || '')))
  }
  {
    // zero unmerged commits → a GENUINE no-op, exactly the old behavior.
    const r = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'noop-audit': '0' },
      [{ status: 'no_changes', worktree: wtPath('only task') }])
    ok('F27b genuinely empty → noop unchanged', r.workflowCalls === 1 && !!r.stateJSON && r.stateJSON.tasks[0].status === 'noop' && r.res && r.res.status === 'done_with_noops', r.res && r.res.status)
  }
  {
    // Missing evidence must not become a no-op: if the branch-count audit is malformed, halt before
    // the feat can report done_with_noops.
    const r = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'noop-audit': 'fatal: bad revision' },
      [{ status: 'no_changes', worktree: wtPath('only task') }])
    ok('F27c malformed noop-audit → infra halt, NOT noop/done', r.res && r.res.status === 'infra_error' && r.res.stage === 'noop_audit', r.res && (r.res.status + '/' + r.res.stage))
    ok('F27c integration never runs past missing noop evidence', !r.calls.includes('integration-verify'), r.calls.join(','))
  }
  // F28 (live smoke run-2): POSTFLIGHT SELF-AUDIT — positive evidence of unmerged commits on a
  // completed task's branch halts as self_audit_failed; the feat must never read done over it.
  {
    const over = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'self-audit': 'camus/feat/x/only 2' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F28 unmerged completed work → self_audit_failed, never done', over.res && over.res.status === 'self_audit_failed', over.res && over.res.status)
    ok('F28 violation named with branch + count', !!over.res && Array.isArray(over.res.violations) && over.res.violations[0].unmergedCommits === 2 && over.res.violations[0].branch === 'camus/feat/x/only', JSON.stringify(over.res && over.res.violations))
    ok('F28c remedy names camus land, never state surgery', /camus land/.test((over.res && over.res.note) || ''), over.res && over.res.note)
    const clean = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'self-audit': 'camus/feat/x/only 0' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F28b ancestry clean → done, audit logged', clean.res && clean.res.status === 'done', clean.res && clean.res.status)
  }
  {
    const bad = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'self-audit': 'I did not run git rev-list' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F28c malformed self-audit → infra halt, never done', bad.res && bad.res.status === 'infra_error' && bad.res.stage === 'self_audit', bad.res && (bad.res.status + '/' + bad.res.stage))
    ok('F28c integration never runs past missing self-audit evidence', !bad.calls.includes('integration-verify'), bad.calls.join(','))
  }

  // F18c (audit P2 2026-06-11): the FINAL task's spend must hit the ceiling too — recheck after
  // the last task, BEFORE integration, or a budget-blowing finale sails to a green "done".
  {
    let bc = 0
    const budgetStub = { spent: () => (bc++ === 0 ? 0 : 90000) }   // tokensBefore=0, after=90000
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'], budgetTokens: 50000 }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }], budgetStub)
    ok('F18c final-task overspend halts before integration', res && res.status === 'needs_human' && res.stage === 'budget', res && (res.status + '/' + res.stage))
    ok('F18c integration never ran past the cap', !calls.includes('env-recheck') && !calls.includes('integration-verify'), calls.join(','))
    ok('F18c note says tasks merged but integration unearned', /integration verify has NOT run/.test((res && res.note) || ''))
  }
  // F19 (audit P2 2026-06-11): the FEAT's own long stretches heartbeat too — env doctors,
  // baseline/integration verify, preflight, merge all touch ~/.camus/feats/<featId>.hb.
  {
    const fid = featIdOf('F', ['only task'])
    const hb = `feats/${fid}.hb`
    const { prompts } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    const tid = taskIdOf('F', ['only task'], 'only task')
    ok('F19 preflight heartbeats', (prompts.preflight || '').includes(hb))
    ok('F19 env doctor heartbeats', (prompts['env-check'] || '').includes(hb))
    ok('F19 baseline verify heartbeats', (prompts['baseline-verify'] || '').includes(hb))
    ok('F19 merge heartbeats', (prompts['merge:' + tid] || '').includes(hb))
    ok('F19 integration verify heartbeats', (prompts['integration-verify'] || '').includes(hb))
    ok('F19 feat baseline verify requests a 600000ms Bash-tool timeout', /timeout PARAMETER to 600000/.test(prompts['baseline-verify'] || ''))
    ok('F19 feat integration verify requests a 600000ms Bash-tool timeout', /timeout PARAMETER to 600000/.test(prompts['integration-verify'] || ''))
    ok('F19 verifier prompts forbid shell timeout wrappers', [prompts['baseline-verify'], prompts['integration-verify']].every((p) => /Do NOT wrap/.test(p || '') && /timeout.*gtimeout/.test(p || '')))
  }
  // F20 (audit P1 2026-06-11): a merged pause+answers note must NOT lose its payload — the
  // boundary check consumed the file, so the engine re-queues the remainder (minus pause)
  // before halting; a pause-only note re-queues nothing.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { res, calls, prompts } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: true, note: J({ pause: true, answers: { [tid]: 'use adapter B' } }) }), 'steer-requeue': { written: true } },
      [])
    ok('F20 pause still halts', res && res.status === 'paused_by_user', res && res.status)
    const rqLabel = 'steer-requeue:' + tid
    ok('F20 remainder re-queued', calls.includes(rqLabel), calls.join(','))
    ok('F20 re-queued note carries the answers, never the pause',
      !!prompts[rqLabel] && prompts[rqLabel].includes('use adapter B') && !prompts[rqLabel].includes('"pause"'), prompts[rqLabel])
    ok('F20 halt note says the payload survived', /RE-QUEUED/.test((res && res.note) || ''))
  }
  {
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: true, note: J({ pause: true }) }) }, [])
    ok('F20b pause-only note → no re-queue agent', res && res.status === 'paused_by_user' && !calls.some((c) => c.startsWith('steer-requeue')), calls.join(','))
  }
  {
    // F11: a verify-clean review_unresolved is surfaced as a DECISION, not a plain failure (2026-06-11).
    const { res, stateJSON } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: true, stuck: [{ title: 'same', code_location: 'a.ts:1' }], blocking: [{ priority: 1, title: 'same' }] }])
    ok('F11 feat halts on review_unresolved', res && res.status === 'halted', res && res.status)
    ok('F11 verify-clean halt flagged as a decision', res && res.verifyCleanDecision === true)
    ok('F11 note frames accept-vs-refine (not failure)', /ACCEPT|DECISION/.test((res && res.note) || ''))
    // audit 2026-06-11: the PERSISTED task status must NOT be `failed` (status.py would render ✗).
    ok('F11 persisted task status is needs_decision, NOT failed', !!stateJSON && stateJSON.tasks[0].status === 'needs_decision', stateJSON && stateJSON.tasks[0].status)
  }
  {
    // F13 (run-5 fix + audit P1 2026-06-11): land is the ACCEPT half of accept-vs-refine, and it is
    // authorized by PRIOR PROVEN STATE (needs_decision), never by the caller's list alone.
    const tid = taskIdOf('F', ['only task'], 'only task')
    // (a) FRESH feat + land request: NOT proven → full loop, land must NOT forward…
    const fresh = await runFeat({ feat: 'F', tasks: ['only task'], land: [tid] }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F13a unproven land request → full loop (no land flag)', !(fresh.loopArgs[0] && 'land' in fresh.loopArgs[0]), JSON.stringify(fresh.loopArgs[0] && fresh.loopArgs[0].land))
    ok('F13a downgrade is LOUD in the run log', !!fresh.stateJSON && (fresh.stateJSON.events || []).some((e) => /land requested but prior state is NOT needs_decision/.test(e.msg || '')))
    // …(b) and the canonical resumeArgs still carries the land list verbatim (audit P1: dropping it
    // on resume would re-enter the full loop — the exact run-5 failure mode).
    ok('F13b resume args sidecar persists land', !!fresh.argsJSON && JSON.stringify((fresh.argsJSON || {}).land) === JSON.stringify([tid]), JSON.stringify(fresh.argsJSON && fresh.argsJSON.land))
    // (c) Run 1 halts verify-clean → persisted as needs_decision (the PROOF — since the
    // park-first reorder, with the PARKED sha riding the same persist)…
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: true, stuck: [], blocking: [], parkedSha: h40('p4rk1234') }])
    ok('F13c prior halt persisted as needs_decision', !!r1.stateJSON && r1.stateJSON.tasks[0].status === 'needs_decision', r1.stateJSON && r1.stateJSON.tasks[0].status)
    ok('F37a needs_decision persist stashes provenCommit = the parked sha (publish audit round-3)',
      !!r1.stateJSON && r1.stateJSON.tasks[0].provenCommit === h40('p4rk1234'), r1.stateJSON && r1.stateJSON.tasks[0].provenCommit)
    // …(d) resume with land:[tid] → NOW authorized: land forwards, narration matches, feat lands+merges.
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(r1.stateJSON) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], land: [tid] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: h40('land1'), landed: true, decisions: [] }])
    ok('F13d proven needs_decision + land → land:true forwarded', !!(r2.loopArgs[0] && r2.loopArgs[0].land === true), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].land))
    ok('F37b accepted decision lands head-bound: expectHead = the parked sha, never the live tip',
      !!(r2.loopArgs[0] && r2.loopArgs[0].expectHead === h40('p4rk1234')), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].expectHead))
    // (f) the FAILED halt stashes the park too — `camus land --proven` flips it to
    // ready_to_merge preserving fields, and the auto-land lane hydrates the same anchor.
    const rRed = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: false, stuck: [], blocking: [], parkedSha: 'p4rkred1' }])
    ok('F37c failed halt stashes the parked sha for a later camus-land accept',
      !!rRed.stateJSON && rRed.stateJSON.tasks[0].status === 'failed' && rRed.stateJSON.tasks[0].provenCommit === 'p4rkred1',
      rRed.stateJSON && (rRed.stateJSON.tasks[0].status + '/' + rRed.stateJSON.tasks[0].provenCommit))
    ok('F13d landed task merges → feat done', r2.res && r2.res.status === 'done', r2.res && r2.res.status)
    // (e) audit P3: the live narration for a land task says what is actually happening.
    ok('F13e land narration says LAND → commit → verify → merge', !!r2.stateJSON && (r2.stateJSON.events || []).some((e) => /LAND \(accepted decision\) → commit → verify → merge/.test(e.msg || '')))
  }
  {
    // …and tasks NOT in the land list run the full loop (no land flag leaks).
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'], land: ['some-other-task'] }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F13f non-listed task gets NO land flag', !(loopArgs[0] && 'land' in loopArgs[0]))
  }
  {
    // F14 (audit P2 2026-06-11): the commit→merge death window. The loop's `done` proof must be
    // PERSISTED (ready_to_merge) BEFORE the merge runs, and a resume from that state AUTO-lands —
    // no land list — instead of re-running the full loop into a branch/worktree collision.
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: h40('c1'), decisions: [] }])
    const mid = (r1.stateJSONs || []).find((s) => s && s.tasks && s.tasks[0] && s.tasks[0].status === 'ready_to_merge')
    ok('F14a ready_to_merge persisted BEFORE the merge', !!mid, JSON.stringify((r1.stateJSONs || []).map((s) => s && s.tasks && s.tasks[0] && s.tasks[0].status)))
    ok('F14a final state is done (merge completed)', !!r1.stateJSON && r1.stateJSON.tasks[0].status === 'done')
    // Simulate the crash: resume from the INTERMEDIATE state (ready_to_merge), with NO land arg.
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14b ready_to_merge resume AUTO-lands (no land list needed)', !!(r2.loopArgs[0] && r2.loopArgs[0].land === true), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].land))
    ok('F14b narration says resuming interrupted merge', !!r2.stateJSON && (r2.stateJSON.events || []).some((e) => /LAND \(resuming interrupted merge/.test(e.msg || '')))
    ok('F14b feat completes done', r2.res && r2.res.status === 'done', r2.res && r2.res.status)
    // F14c (audit P2 round 2): crash AFTER a successful merge → resume auto-lands, the re-merge
    // reports already-up-to-date, and the EXISTING merge commit for this task is the evidence that
    // upgrades the outcome to DONE instead of the false noop.
    const crashedMerge = { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x', priorMergeCommit: 'deadbeef1234' }
    const featCrashed = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: crashedMerge, 'merge-receipt': J(crashedMerge), 'merge-head': crashedMerge.after,
      'integration-verify': J({ pass: true, failures: [], head: crashedMerge.after }),
    }
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'] }, featCrashed,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14c prior merge commit evidence → task DONE, not noop', !!r3.stateJSON && r3.stateJSON.tasks[0].status === 'done', r3.stateJSON && r3.stateJSON.tasks[0].status)
    ok('F14c feat done (no done_with_noops downgrade)', r3.res && r3.res.status === 'done', r3.res && r3.res.status)
    ok('F14c narration says already merged by a prior run', !!r3.stateJSON && (r3.stateJSON.events || []).some((e) => /ALREADY merged .* prior run/.test(e.msg || '')))
    // F14d: already-up-to-date WITHOUT the merge-commit evidence keeps the original no-op guard —
    // an empty/scope-overlapped branch must never upgrade itself to done.
    const emptyMerge = { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x', priorMergeCommit: '' }
    const featEmpty = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: emptyMerge, 'merge-receipt': J(emptyMerge), 'merge-head': emptyMerge.after,
      'integration-verify': J({ pass: true, failures: [], head: emptyMerge.after }),
    }
    const r4 = await runFeat({ feat: 'F', tasks: ['only task'] }, featEmpty,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14d no evidence → no-op guard intact', !!r4.stateJSON && r4.stateJSON.tasks[0].status === 'noop', r4.stateJSON && r4.stateJSON.tasks[0].status)
    // F14e (audit P2 round 3): the field OMITTED entirely (runner skipped the check / schema
    // bypass) is AMBIGUOUS, not "no evidence" — fail loud, never guess noop. The task stays
    // ready_to_merge so the resume retries the (idempotent) merge with the check.
    const featOmitted = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x' },   // no priorMergeCommit at all
    }
    const r5 = await runFeat({ feat: 'F', tasks: ['only task'] }, featOmitted,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14e omitted evidence check → halts loud, NOT noop', r5.res && r5.res.status === 'feat_integration_failed', r5.res && r5.res.status)
    ok('F14e task persisted as ready_to_merge (resume retries the merge)', !!r5.stateJSON && r5.stateJSON.tasks[0].status === 'ready_to_merge', r5.stateJSON && r5.stateJSON.tasks[0].status)
    // F14f (audit P2 round 4): the SAME class one field over — merged:true with committed/
    // alreadyUpToDate omitted must fail loud (didCommit would default false → false noop).
    const featNoVerdict = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: { merged: true, priorMergeCommit: null, before: 'x', after: 'x' },   // committed + alreadyUpToDate absent
    }
    const r6 = await runFeat({ feat: 'F', tasks: ['only task'] }, featNoVerdict,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14f merged:true with committed omitted → halts loud, NOT noop', r6.res && r6.res.status === 'feat_integration_failed', r6.res && r6.res.status)
    ok('F14f task persisted as ready_to_merge', !!r6.stateJSON && r6.stateJSON.tasks[0].status === 'ready_to_merge', r6.stateJSON && r6.stateJSON.tasks[0].status)
    // F14g (audit P2 round 5): the SHAs are evidence too — merged:true with before/after OMITTED
    // (or null: a successful merge necessarily ran rev-parse) must fail loud, not slide through
    // didCommit's `!before || !after` tolerance into a false done.
    const landDone = [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }]
    const resumePf = { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) }
    const r7 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: resumePf, merge: { merged: true, committed: true, alreadyUpToDate: false, priorMergeCommit: null } }, landDone)
    ok('F14g omitted SHAs → halts loud, NOT done', r7.res && r7.res.status === 'feat_integration_failed', r7.res && r7.res.status)
    ok('F14g task persisted as ready_to_merge', !!r7.stateJSON && r7.stateJSON.tasks[0].status === 'ready_to_merge', r7.stateJSON && r7.stateJSON.tasks[0].status)
    const r8 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: resumePf, merge: { merged: true, committed: true, alreadyUpToDate: false, priorMergeCommit: null, before: null, after: null } }, landDone)
    ok('F14g null SHAs on a successful merge → same loud halt', r8.res && r8.res.status === 'feat_integration_failed', r8.res && r8.res.status)
    // F14h (audit P2 round 6): COMPLETE but SELF-CONTRADICTORY — committed:true with unmoved HEAD
    // is impossible under the contract; it must halt loud, not slide through !didCommit into noop.
    const r9 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: resumePf, merge: { merged: true, committed: true, alreadyUpToDate: false, before: 'x', after: 'x', priorMergeCommit: null } }, landDone)
    ok('F14h committed:true with equal SHAs → halts loud, NOT noop', r9.res && r9.res.status === 'feat_integration_failed', r9.res && r9.res.status)
    ok('F14h task persisted as ready_to_merge', !!r9.stateJSON && r9.stateJSON.tasks[0].status === 'ready_to_merge', r9.stateJSON && r9.stateJSON.tasks[0].status)
    // F14i (audit P2 round 7): the inverse contradiction — no HEAD movement with
    // alreadyUpToDate:false — must not skip the prior-merge evidence check and become noop.
    const r10 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: resumePf, merge: { merged: true, committed: false, alreadyUpToDate: false, before: 'x', after: 'x', priorMergeCommit: null } }, landDone)
    ok('F14i committed:false + alreadyUpToDate:false with equal SHAs → halts loud, NOT noop', r10.res && r10.res.status === 'feat_integration_failed', r10.res && r10.res.status)
    ok('F14i task persisted as ready_to_merge', !!r10.stateJSON && r10.stateJSON.tasks[0].status === 'ready_to_merge', r10.stateJSON && r10.stateJSON.tasks[0].status)
    // F14j: even on a normal merge, priorMergeCommit is part of the required verdict contract
    // (null when not applicable). Schema bypass with the field omitted must not reach done.
    const r11 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: resumePf, merge: { merged: true, committed: true, alreadyUpToDate: false, before: 'x', after: 'y' } }, landDone)
    ok('F14j normal merge with priorMergeCommit omitted → halts loud, NOT done', r11.res && r11.res.status === 'feat_integration_failed', r11.res && r11.res.status)
    ok('F14j task persisted as ready_to_merge', !!r11.stateJSON && r11.stateJSON.tasks[0].status === 'ready_to_merge', r11.stateJSON && r11.stateJSON.tasks[0].status)
  }
  // F38 (live dogfood run-8, 2026-06-12): WT_DEST embeds $(pwd -P), so worktree identity was
  // cwd-SENSITIVE — two launches of the same feat from different shells resolved different
  // worktree homes, and the land lane looked where the worktree wasn't (the recreate was then
  // correctly refused: the branch lives in the original checkout). With targetPath, every
  // WT_DEST-bearing and repo-reading command now carries an explicit `cd <target> && ` prefix
  // (bash expands the next command's words AFTER the cd runs, so $(pwd -P) resolves at the
  // target). Without targetPath the prefix is empty — the rest of this suite is that pin.
  {
    const tp = '/some/repo'
    const cdp = `cd ${JSON.stringify(tp)} && `
    const r = await runLoop({ task: 't', targetPath: tp }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F38a implement worktree-create is cd-prefixed under targetPath',
      (r.prompts.implement || '').includes(cdp) && (r.prompts.implement || '').includes('/wt.sh create'), (r.prompts.implement || '').slice(460, 560))
    const r2 = await runLoop({ task: 't', land: true, targetPath: tp },
      { 'land-resolve': J({ found: true, path: wtPath('t') }), commit: J({ committed: true, sha: h40('land1') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('land1') }) })
    ok('F38b land-resolve is cd-prefixed under targetPath (identity resolves AT the target)',
      (r2.prompts['land-resolve'] || '').includes(cdp), (r2.prompts['land-resolve'] || '').slice(0, 200))
    ok('F38b …and still lands done', r2.res.status === 'done', r2.res.status)
    const r3 = await runLoop({ task: 't', land: true, targetPath: tp },
      { 'land-resolve': J({ found: false, path: null }), 'land-recreate': J({ ok: true, path: wtPath('t') }), commit: J({ committed: true, sha: h40('land1') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('land1') }) })
    ok('F38c land-recreate is cd-prefixed under targetPath',
      (r3.prompts['land-recreate'] || '').includes(cdp) && (r3.prompts['land-recreate'] || '').includes('/wt.sh attach'), (r3.prompts['land-recreate'] || '').slice(0, 200))
    ok('F38c …and the recreated land completes', r3.res.status === 'done', r3.res.status)
  }
  // F39 (live dogfood 2026-06-12, loop-side F33): a STRINGIFIED args object reached the loop and
  // the whole JSON became the task text — branch slug "posture-full-targetpath-…", posture and
  // targetPath silently dropped. JSON-looking strings are unwrapped; bare-string tasks unchanged.
  {
    const tp = '/some/repo'
    const r = await runLoop(JSON.stringify({ task: 't', targetPath: tp }), { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F39a stringified loop args are unwrapped (targetPath reaches REPO_CD)',
      r.res.status === 'done' && (r.prompts.implement || '').includes(`cd ${J(tp)} && `), r.res.status)
    ok('F39b the task text is the TASK, not the JSON blob',
      (r.prompts.classify || '').includes('Task: t') && !(r.prompts.classify || '').includes('targetPath'), (r.prompts.classify || '').slice(-120))
    const weird = '{not json, just a weird task title'
    const r2 = await runLoop(weird, { ...cls, ...planOf('clear', ''), ...happyTail,
      implement: { ...happyTail.implement, worktree_path: wtPath(weird) } })
    ok('F39c a bare-string task starting with "{" still works verbatim',
      r2.res.status === 'done' && (r2.prompts.classify || '').includes('{not json'), r2.res.status)
  }
  // F35 (live smoke run-6, 2026-06-12): the merge runner defected COHERENTLY — merge.sh said
  // CONFLICT, the agent hand-resolved it, committed under the normal merge message, and relayed
  // a contract-complete success. Ancestry can't catch a hand-merge (the self-audit passed), so
  // the relay is cross-checked against merge.sh's own receipt file: relay≠receipt → halt;
  // MISSING receipt → halt. A defecting relay is never a verdict.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const rogue = { merged: true, committed: true, alreadyUpToDate: false, before: 'aaa', after: 'bbb', priorMergeCommit: null }
    const truth = { merged: false, committed: false, alreadyUpToDate: false, before: 'aaa', after: 'aaa', error: 'merge conflict — aborted' }
    const r = await runFeat({ feat: 'F', tasks: ['only task'] }, { ...featBase, merge: rogue, 'merge-receipt': J(truth), 'merge-head': 'aaa' }, loopDone)
    ok('F35a relay≠receipt → halt at merge_receipt, never a verdict',
      r.res && r.res.status === 'feat_integration_failed' && r.res.stage === 'merge_receipt', r.res && (r.res.status + '/' + r.res.stage))
    ok('F35a task persisted ready_to_merge (the proof stands; the MERGE is unresolved)',
      !!r.stateJSON && r.stateJSON.tasks[0].status === 'ready_to_merge', r.stateJSON && r.stateJSON.tasks[0].status)
    ok('F35a note names the disagreeing fields + the RECEIPT-sourced reset target',
      /DISAGREES/.test(r.res.note || '') && /merged/.test(r.res.note || '') && /git reset --hard aaa/.test(r.res.note || ''), r.res && r.res.note)
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'] }, { ...featBase, merge: rogue, 'merge-receipt': 'MISSING' }, loopDone)
    ok('F35b NO receipt → same halt (fail-closed: maybe merge.sh never ran)',
      r2.res && r2.res.status === 'feat_integration_failed' && r2.res.stage === 'merge_receipt', r2.res && (r2.res.status + '/' + (r2.res && r2.res.stage)))
    ok('F35b no reset target offered from the UNTRUSTED relay', !/reset --hard/.test((r2.res && r2.res.note) || ''), r2.res && r2.res.note)
    ok('F35c merge prompt: conflict IS the verdict — no hand-resolution, receipt cross-check named',
      /merged:false/.test(r.prompts['merge:' + tid] || '') && /Do NOT resolve conflicts/.test(r.prompts['merge:' + tid] || '') && /receipt/.test(r.prompts['merge:' + tid] || ''))
    const happy = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase, loopDone)
    ok('F35d feat gating-verify prompts carry the tamper oath (baseline + integration)',
      /tampering/.test(happy.prompts['baseline-verify'] || '') && /tampering/.test(happy.prompts['integration-verify'] || ''))
    const lp = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F35e loop gating-verify prompt carries the tamper oath', /tampering/.test(lp.prompts.verify || ''))
    // F35f: HONEST relay of the conflict — but the live branch moved off the receipt's `before`.
    // This is run-6's hand-merge with a FAITHFUL relay: invisible to the relay compare, caught
    // only by checking the receipt against the REPO (receipt = source of truth, both directions).
    const honest = { merged: false, committed: false, alreadyUpToDate: false, before: 'aaa', after: 'aaa', error: 'merge conflict — aborted' }
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, merge: honest, 'merge-receipt': J(honest), 'merge-head': 'zzz' }, loopDone)
    ok('F35f honest conflict relay + moved HEAD → off-script mutation caught',
      r3.res && r3.res.status === 'feat_integration_failed' && r3.res.stage === 'merge_receipt' && /OFF-SCRIPT/.test(r3.res.note || ''), r3.res && (r3.res.status + '/' + r3.res.stage))
    ok('F35f reset target is the receipt before-SHA', /git reset --hard aaa/.test(r3.res.note || ''), r3.res && r3.res.note)
    // F35g: the live HEAD can't be read at all → fail closed (no confirmation, no verdict).
    const r4 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'merge-head': 'fatal: not a git repository' }, loopDone)
    ok('F35g unreadable live HEAD → fail-closed halt', r4.res && r4.res.status === 'feat_integration_failed' && r4.res.stage === 'merge_receipt' && /could not be read/.test(r4.res.note || ''), r4.res && (r4.res.status + '/' + r4.res.stage))
    // F35h/i: HEAD BINDING — the integration green must certify the last receipt-proven tip.
    const r5 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'integration-verify': J({ pass: true, failures: [], head: 'evil' }) }, loopDone)
    ok('F35h integration green on the WRONG head → refused (integration_integrity)',
      r5.res && r5.res.status === 'feat_integration_failed' && r5.res.stage === 'integration_integrity' && /evil/.test(r5.res.note || '') && /bbb/.test(r5.res.note || ''), r5.res && (r5.res.status + '/' + r5.res.stage))
    const r6 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'integration-verify': J({ pass: true, failures: [], head: 'bbb' }) }, loopDone)
    ok('F35i integration head matching the proven tip → done', r6.res && r6.res.status === 'done', r6.res && r6.res.status)
    // F35j: loop-side head binding — the final verify must certify the sha the commit gate sealed.
    const lpBad = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail, verify: J({ pass: true, failures: [], head: 'zzz' }) })
    ok('F35j loop verify green on the WRONG head → verify_failed with head_mismatch',
      lpBad.res.status === 'verify_failed' && JSON.stringify(lpBad.res.failures || []).includes('head_mismatch'), lpBad.res.status)
    const lpGood = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail, verify: J({ pass: true, failures: [], head: h40('abc123') }) })
    ok('F35j loop verify green on the sealed head → done', lpGood.res.status === 'done', lpGood.res.status)
    // F35k/l (publish audit P2): a sealed green with NO head is fail-CLOSED — accepting an
    // unnamed green re-opens the run-6 hole (a fabricated {pass:true} simply omits the field).
    const lpNoHead = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail, verify: J({ pass: true, failures: [] }) })
    ok('F35k loop GREEN without a head, sha sealed → verify_failed with head_missing',
      lpNoHead.res.status === 'verify_failed' && JSON.stringify(lpNoHead.res.failures || []).includes('head_missing'), lpNoHead.res.status)
    const r7 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'integration-verify': J({ pass: true, failures: [] }) }, loopDone)
    ok('F35l feat integration GREEN without a head, merges ran → refused (integration_integrity)',
      r7.res && r7.res.status === 'feat_integration_failed' && r7.res.stage === 'integration_integrity' && /without naming/.test(r7.res.note || ''), r7.res && (r7.res.status + '/' + r7.res.stage))
    // F35m (publish audit P1): priorMergeCommit is VERDICT-BEARING (the crash-after-merge
    // evidence) — a relay flipping the receipt's empty evidence to a fabricated sha would turn
    // a true no-op into done; it must halt as a receipt mismatch instead.
    const noopTruth = { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x', priorMergeCommit: '' }
    const fabricated = { ...noopTruth, priorMergeCommit: 'fabr1cated' }
    const r8 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, merge: fabricated, 'merge-receipt': J(noopTruth), 'merge-head': 'x' }, loopDone)
    ok('F35m fabricated priorMergeCommit vs receipt → halt, never done',
      r8.res && r8.res.status === 'feat_integration_failed' && r8.res.stage === 'merge_receipt' && /priorMergeCommit/.test(r8.res.note || ''), r8.res && (r8.res.status + '/' + r8.res.stage))
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

  // F4: model and reviewer run-start identity passthrough — forwarded UNCHANGED into each
  // per-task loop call. The loop cannot recover these values from a process environment.
  {
    const qualification = `qual1:${'c'.repeat(64)}`
    const { loopArgs, argsJSON } = await runFeat({ feat: 'F', tasks: ['only task'], model: 'opus', modelTier: 'high',
      reviewerModel: 'grok-4.6', reviewerBackend: 'http_openai_compat', reviewerEffort: 'high',
      reviewerCodexArgs: '--config=model_provider=proxy', reviewerLightModel: 'gpt-5.4-mini',
      reviewerProfileBackend: 'xai', reviewerTrainingOrg: 'xai', reviewerTransport: 'direct_https',
      reviewerConnection: 'xai-primary', reviewerQualification: qualification }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 model forwarded to loop', loopArgs.length === 1 && loopArgs[0].model === 'opus', J(loopArgs[0]))
    ok('F4 modelTier forwarded to loop', loopArgs[0] && loopArgs[0].modelTier === 'high')
    ok('F4 reviewer identity/settings forwarded to loop', loopArgs[0]
      && loopArgs[0].reviewerModel === 'grok-4.6' && loopArgs[0].reviewerBackend === 'http_openai_compat'
      && loopArgs[0].reviewerEffort === 'high'
      && loopArgs[0].reviewerCodexArgs === '--config=model_provider=proxy'
      && loopArgs[0].reviewerLightModel === 'gpt-5.4-mini'
      && loopArgs[0].reviewerProfileBackend === 'xai' && loopArgs[0].reviewerTrainingOrg === 'xai'
      && loopArgs[0].reviewerTransport === 'direct_https' && loopArgs[0].reviewerConnection === 'xai-primary'
      && loopArgs[0].reviewerQualification === qualification, J(loopArgs[0]))
    ok('F4 reviewer identity/settings persist in canonical resume args', argsJSON
      && argsJSON.reviewerBackend === 'http_openai_compat' && argsJSON.reviewerModel === 'grok-4.6'
      && argsJSON.reviewerProfileBackend === 'xai' && argsJSON.reviewerTrainingOrg === 'xai'
      && argsJSON.reviewerTransport === 'direct_https' && argsJSON.reviewerConnection === 'xai-primary'
      && argsJSON.reviewerQualification === qualification, J(argsJSON))
  }
  {
    // No override → loop call must NOT carry model/modelTier (loop keeps its own defaults).
    const { loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F4 no model/reviewer keys when unset', loopArgs[0] && !('model' in loopArgs[0]) && !('modelTier' in loopArgs[0])
      && !('reviewerModel' in loopArgs[0]) && !('reviewerBackend' in loopArgs[0])
      && !('reviewerEffort' in loopArgs[0]) && !('reviewerCodexArgs' in loopArgs[0])
      && !('reviewerLightModel' in loopArgs[0]) && !('reviewerProfileBackend' in loopArgs[0])
      && !('reviewerTrainingOrg' in loopArgs[0]) && !('reviewerTransport' in loopArgs[0])
      && !('reviewerConnection' in loopArgs[0]) && !('reviewerQualification' in loopArgs[0]))
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
    ok('F4 targetPath not used as preflight cwd', prompts.preflight && prompts.preflight.includes('git rev-parse --show-toplevel') && !prompts.preflight.includes('packages/ai/src'))
    ok('F4 targetPath not used as baseline verify target', prompts['baseline-verify'] && prompts['baseline-verify'].includes('git rev-parse --show-toplevel') && !prompts['baseline-verify'].includes('packages/ai/src'))
    ok('F4 targetPath not used as integration verify target', prompts['integration-verify'] && prompts['integration-verify'].includes('git rev-parse --show-toplevel') && !prompts['integration-verify'].includes('packages/ai/src'))
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
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: true, note: J({ pause: true }) }) }, [])
    ok('F7 pause note → paused_by_user before the loop', res && res.status === 'paused_by_user', res && res.status)
    ok('F7 loop never invoked on pause', workflowCalls === 0, 'workflowCalls=' + workflowCalls)
  }
  {
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: true, note: J({ guidance: 'use adapter B' }) }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7 guidance threaded as humanAnswer', !!loopArgs[0] && loopArgs[0].humanAnswer === 'use adapter B', J(loopArgs[0]))
    ok('F7 feat still done with guidance', res && res.status === 'done', res && res.status)
  }
  {
    // STEER OFF BY DEFAULT (descoped from 0.2.7, 2026-06-14): without steer:true the steer file-IPC
    // path is skipped ENTIRELY — no steer agent call, no humanAnswer, no claim surface — and the feat
    // runs normally. (The feature is opt-in via args.steer=true; see the F7/F50/F52/F53 pins.)
    const { res, loopArgs, calls } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7 steer OFF by default → no steer agent call', !calls.some((c) => c.startsWith('steer')), calls.join(','))
    ok('F7 steer off → no humanAnswer injected', !!loopArgs[0] && !('humanAnswer' in loopArgs[0]))
    ok('F7 steer off → run proceeds', res && res.status === 'done', res && res.status)
  }
  // F7d: pause → re-run with the SAME args resumes past the done task (the contract the
  // finalize note promises the user).
  {
    let steerCalls = 0
    const steerOnceThenPause = () => (++steerCalls === 1 ? J({ read: true, note: null }) : J({ read: true, note: J({ pause: true }) }))
    const r1 = await runFeat({ feat: 'P', tasks: ['a', 'b'], steer: true },
      { ...featBase, steer: steerOnceThenPause },
      [{ status: 'done', branch: 'camus/feat/x/a', decisions: [] }])
    ok('F7d task a done, paused before b', r1.res && r1.res.status === 'paused_by_user' && r1.workflowCalls === 1,
      r1.res && r1.res.status)
    const prior = r1.stateJSON
    ok('F7d paused state persisted (a=done)', !!prior && prior.status === 'paused_by_user' && prior.tasks[0].status === 'done')
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'P', tasks: ['a', 'b'], steer: true }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/b', decisions: [] }])
    ok('F7d re-run resumes: only task b runs', r2.workflowCalls === 1, 'workflowCalls=' + r2.workflowCalls)
    ok('F7d re-run completes', r2.res && r2.res.status === 'done', r2.res && r2.res.status)
  }
  // F7e: a steer answers-map can target a LATER task — a regression here makes
  // `camus steer --task` a silent no-op, the worst HITL failure mode.
  {
    const bId = taskIdOf('T2', ['a', 'b'], 'b')
    let sc = 0
    const steerNoteOnce = () => (++sc === 1 ? J({ read: true, note: J({ answers: { [bId]: 'pick B' } }) }) : J({ read: true, note: null }))
    const { loopArgs } = await runFeat({ feat: 'T2', tasks: ['a', 'b'], steer: true },
      { ...featBase, steer: steerNoteOnce },
      [{ status: 'done', branch: 'camus/feat/x/a', decisions: [] },
       { status: 'done', branch: 'camus/feat/x/b', decisions: [] }])
    ok('F7e first task NOT steered', !!loopArgs[0] && !('humanAnswer' in loopArgs[0]), J(loopArgs[0]))
    ok('F7e later task got the targeted answer', !!loopArgs[1] && loopArgs[1].humanAnswer === 'pick B', J(loopArgs[1]))
  }
  // F7f (fixlet 2026-06-11 UPGRADE of the 2026-06-10 loud-log): a PRESENT-but-unparseable steer
  // note now HALTS the feat — a human countermand was consumed without being applied, and running
  // past it re-opens exactly what it was written to prevent. needs_human → not auto-resumable.
  {
    const { res, stateJSON, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: true, note: 'totally not json' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7f garbage note surfaced in run log', !!stateJSON && stateJSON.events.some((e) => /UNPARSEABLE/.test(e.msg)))
    ok('F7f run HALTS for the human (no silent drop)', res && res.status === 'needs_human' && res.stage === 'steer', res && (res.status + '/' + res.stage))
    ok('F7f no task dispatched past the dropped guidance', workflowCalls === 0, String(workflowCalls))
    ok('F7f note says nothing was applied + how to resume', /NOTHING was applied/.test((res && res.note) || '') && /re-run/i.test((res && res.note) || ''))
  }

  // F50 (live re-soak 2026-06-14, finding A): the steer READ is now non-consuming, so a transient
  // thin-runner relay flake is RETRIED rather than halting an unattended feat. A garbage reply on
  // the first try, a valid sentinel on the retry → the feat PROCEEDS (the bug this fixes turned a
  // one-off haiku hiccup into a full halt). The split read/consume in steer_read.py guarantees the
  // retried read re-reads the same un-consumed note.
  {
    let sc = 0
    const flakeThenSentinel = () => (++sc === 1 ? 'oops budget preamble, no json here' : J({ read: true, note: null }))
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: flakeThenSentinel },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F50 steer relay flake is RETRIED (retry label present)', calls.some((c) => /^steer:.*:retry1$/.test(c)), calls.filter((c) => c.startsWith('steer')).join(','))
    ok('F50 one flake then a valid read → feat PROCEEDS (no false halt)', res && res.status === 'done', res && res.status)
    ok('F50 no-note read consumes nothing (no consume agent)', !calls.some((c) => c.startsWith('steer-consume')), calls.join(','))
  }
  // F50b: a PERSISTENT failure to obtain the steer state (no sentinel even after retries) is an
  // inconclusive halt — fail-closed, never a false countermand-drop, and NOTHING consumed.
  {
    const { res, calls, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: 'never valid json' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F50b persistent no-sentinel → needs_human inconclusive (stage steer)', res && res.status === 'needs_human' && res.stage === 'steer', res && (res.status + '/' + res.stage))
    ok('F50b retried before giving up', calls.some((c) => /^steer:.*:retry1$/.test(c)), calls.filter((c) => c.startsWith('steer')).join(','))
    ok('F50b nothing consumed (read-only check never deletes)', !calls.some((c) => c.startsWith('steer-consume')), calls.join(','))
    ok('F50b no task dispatched', workflowCalls === 0, String(workflowCalls))
    ok('F50b note says note is intact', /intact/.test((res && res.note) || ''))
  }

  // F51 (live re-soak 2026-06-14, finding B): the feat PROVES the main checkout is clean at each
  // task BOUNDARY (per-task work lives in isolated worktrees, so the parent tree should carry only
  // Camus's committed merges). A concurrent editor — typically the driver session — that dirtied the
  // parent tree is caught HERE, at the clean merge point, not later as a confusing integration anomaly.
  // Reuses containment.sh's {ran,dirty,paths} receipt; ran:false ⇒ inconclusive, never a clean pass.
  {
    const dirty = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'parent-tree': leakAfterBaseline(' M src/concurrent.ts') },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F51 dirty parent tree → needs_human at task_boundary', dirty.res && dirty.res.status === 'needs_human' && dirty.res.stage === 'task_boundary', dirty.res && (dirty.res.status + '/' + dirty.res.stage))
    ok('F51 halt names the dirty paths', /concurrent\.ts/.test((dirty.res && dirty.res.note) || '') && /concurrent\.ts/.test((dirty.res && dirty.res.dirtyPaths) || ''))
    ok('F51 no task dispatched past a dirty tree', dirty.workflowCalls === 0, String(dirty.workflowCalls))
    ok('F51 check routes through containment.sh (mechanical receipt)',
      Object.entries(dirty.prompts).some(([k, v]) => k.startsWith('parent-tree') && /\/containment\.sh/.test(v)))
    // inconclusive: a {ran:false} receipt is NOT read as clean (silent-leak closed)
    const ranFalse = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'parent-tree': J({ ran: false, error: 'not a git repository' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F51 {ran:false} → inconclusive halt, never clean', ranFalse.res && ranFalse.res.status === 'needs_human' && ranFalse.res.stage === 'task_boundary', ranFalse.res && (ranFalse.res.status + '/' + ranFalse.res.stage))
    ok('F51 inconclusive dispatches no task', ranFalse.workflowCalls === 0, String(ranFalse.workflowCalls))
    // non-JSON reply (a garbled runner) → inconclusive, NOT read as clean
    const noJson = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'parent-tree': 'here is the output: (no changes)' },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F51 non-JSON reply → inconclusive (cry-wolf/silent-clear both closed)', noJson.res && noJson.res.status === 'needs_human' && noJson.res.stage === 'task_boundary', noJson.res && (noJson.res.status + '/' + noJson.res.stage))
    // F51b (PR2, 2026-06-29): a RELAY hallucination on the parent-tree check — `paths` as an ARRAY — must be
    // rejected as inconclusive, NOT coerced into a false "concurrent editor" breach (which would set dirtyPaths).
    let pn = 0
    const phall = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'parent-tree': () => (++pn === 1 ? J({ ran: true, dirty: false, paths: '' })
                                                      : J({ ran: true, dirty: false, paths: ['/repo/root'] })) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F51b array-paths hallucination → inconclusive task_boundary, NOT a false breach',
      phall.res && phall.res.status === 'needs_human' && phall.res.stage === 'task_boundary'
        && /could not/i.test(phall.res.note || '') && !phall.res.dirtyPaths,
      phall.res && (phall.res.status + '/' + phall.res.stage + ' dirty=' + (phall.res.dirtyPaths || '∅')))
    // a TRANSIENT hallucination on the feat boundary check self-heals via retry (mirrors F40b; baseline=call#1,
    // boundary check=call#2). Without retry, call#2's array coerces to a fake dirt line → false breach; with
    // retry, attempt 2 reads clean → the task dispatches and the feat completes.
    let pr = 0
    const precov = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'parent-tree': () => { pr++; return J(pr === 2 ? { ran: true, dirty: false, paths: ['/repo/root'] }
                                                                    : { ran: true, dirty: false, paths: '' }) } },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F51b transient hallucination on the boundary check → retry recovers → done', precov.res && precov.res.status === 'done', precov.res && precov.res.status)
    // already-done tasks (resume) skip the boundary check — a dirty tree must not block a no-op resume
    const resumeDone = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0,
        stateRaw: J({ tasks: [{ taskId: taskIdOf('F', ['only task'], 'only task'), status: 'done', branch: 'camus/feat/x/only' }] }) },
        'parent-tree': J({ ran: true, dirty: true, paths: ' M unrelated.ts' }) },
      [])
    // The per-task boundary GUARD must not run for a done task; the once-per-feat dirt baseline
    // (parent-tree:baseline, captured after baseline-verify) is a separate step and may still run.
    ok('F51 resume skips the per-task boundary check for already-done tasks', !resumeDone.calls.some((c) => c.startsWith('parent-tree:') && c !== 'parent-tree:baseline'), resumeDone.calls.join(','))
  }

  // F52 (re-soak 2026-06-14, finding P2): the steer read and consume are TWO steps; a human running
  // `camus steer` BETWEEN them writes a NEWER note. The consume is SHA-GATED (--expect-sha), so it
  // REFUSES to delete the changed note (reason:'changed') — the newer note survives — and the feat
  // RE-READS and applies the CURRENT note, never the superseded one. (Old behavior: blind delete
  // applied the stale note and silently destroyed the new one.)
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    let rc = 0
    const reads = [
      J({ read: true, note: J({ guidance: 'OLD' }), sha: h40('shaA') }),
      J({ read: true, note: J({ guidance: 'NEW' }), sha: h40('shaB') }),   // the human's re-steer
    ]
    let cc = 0
    const consumes = [
      J({ consumed: false, reason: 'changed', sha: h40('shaB') }),  // 1st consume: note changed under us → nothing deleted
      J({ consumed: true }),                                   // 2nd consume (after re-read): matched → deleted
    ]
    const { res, loopArgs, calls, prompts } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: () => reads[Math.min(rc++, reads.length - 1)], 'steer-consume': () => consumes[Math.min(cc++, consumes.length - 1)] },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F52 sha-mismatch triggers a RE-READ', calls.some((c) => /:reread1/.test(c)), calls.filter((c) => c.startsWith('steer')).join(','))
    ok('F52 the NEWER note is applied (not the stale one)', !!loopArgs[0] && loopArgs[0].humanAnswer === 'NEW', J(loopArgs[0] && loopArgs[0].humanAnswer))
    ok('F52 the superseded note is NEVER applied', !(loopArgs[0] && loopArgs[0].humanAnswer === 'OLD'))
    ok('F52 consume is sha-gated (carries --expect-sha)', Object.entries(prompts).some(([k, v]) => k.startsWith('steer-consume') && /--expect-sha/.test(v)))
    ok('F52 → done', res && res.status === 'done', res && res.status)
  }
  // F52b: a note that keeps changing every time Camus reads it (a human editing in a tight loop)
  // must HALT named after the churn cap, never spin forever and never apply a half-written note.
  {
    const churning = J({ read: true, note: J({ guidance: 'moving target' }), sha: h40('sha-x') })
    const { res, calls, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: churning, 'steer-consume': J({ consumed: false, reason: 'changed', sha: h40('sha-y') }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F52b a note that never settles → needs_human (stage steer)', res && res.status === 'needs_human' && res.stage === 'steer', res && (res.status + '/' + res.stage))
    ok('F52b bounded — does not spin (re-reads then halts)', calls.filter((c) => c.startsWith('steer:')).length <= 5, String(calls.filter((c) => c.startsWith('steer:')).length))
    ok('F52b nothing dispatched, note says nothing applied', workflowCalls === 0 && /NOTHING was applied/.test((res && res.note) || ''), String(workflowCalls))
  }
  // F53 (re-soak 2026-06-14, finding P2a): a `camus steer --clear` BETWEEN read and consume makes the
  // sha-gated consume report reason:'absent' (the note vanished). A clear is a newer human action, so
  // it must be treated as changed-to-null — Camus must NOT apply the bytes it read earlier. Apply now
  // gates strictly on consumed:true, so 'absent' triggers a re-read → null → no-note → proceed UNAPPLIED.
  {
    let rc = 0
    const reads = [
      J({ read: true, note: J({ guidance: 'RETRACTED' }), sha: h40('shaA') }),
      J({ read: true, note: null, sha: null }),   // the human cleared it
    ]
    const { res, loopArgs, calls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: () => reads[Math.min(rc++, reads.length - 1)], 'steer-consume': J({ consumed: false, reason: 'absent' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F53 a cleared note triggers a RE-READ (treated as changed-to-null)', calls.some((c) => /:reread1/.test(c)), calls.filter((c) => c.startsWith('steer')).join(','))
    ok('F53 the retracted note is NEVER applied', !!loopArgs[0] && !('humanAnswer' in loopArgs[0]), J(loopArgs[0]))
    ok('F53 → done (proceeds as no-note after the clear)', res && res.status === 'done', res && res.status)
  }
  // F53b (finding P2b): a crashed prior consume can strand a note in a `.consuming` claim file.
  // steer_read recovers it on read when possible, but when a stranded claim AND a current note both
  // exist it halts loudly (read:false). The feat surfaces that reason and halts inconclusive — no
  // silent loss, nothing dispatched.
  {
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'], steer: true },
      { ...featBase, steer: J({ read: false, error: 'a previous consume crashed leaving a stranded steer claim (x.consuming) alongside a current note — resolve it before continuing' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F53b stranded-claim read:false → needs_human (stage steer)', res && res.status === 'needs_human' && res.stage === 'steer', res && (res.status + '/' + res.stage))
    ok('F53b the stranded-claim reason is surfaced to the human', /stranded steer claim/.test((res && res.note) || ''))
    ok('F53b nothing dispatched past the unresolved claim', workflowCalls === 0, String(workflowCalls))
  }
  // F54 (re-soak 2026-06-14, P2): steer is opt-in, so a steer-enabled run MUST persist steer:true in
  // the canonical resumeArgs — else a paused/crashed/auto-resumed run (resume_scan emits resumeArgs
  // verbatim) silently reverts to steering OFF. The default run must NOT carry steer.
  {
    const on = await runFeat({ feat: 'F', tasks: ['only task'], steer: true }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F54 steer:true persists in resume args sidecar', !!on.argsJSON && on.argsJSON.steer === true, on.argsJSON && J(on.argsJSON))
    const off = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F54 default run carries no steer in resume args sidecar', !!off.argsJSON && !('steer' in off.argsJSON), off.argsJSON && J(off.argsJSON))
  }

  // F55 (dogfood throughput 2026-08-19): a large immutable task contract is written once, while
  // every changing checkpoint/report stays compact. Failure to confirm the sidecar falls back to
  // inline canonical args so persistence optimization can never make a run unresumable.
  {
    const huge = 'Implement the bounded contract. ' + 'RFC acceptance detail '.repeat(1200)
    const compact = await runFeat({ feat: 'Large', tasks: [huge], posture: 'oneshot' }, featBase,
      [{ status: 'verify_failed', task: huge, blocking: [{ priority: 1, title: 'red' }], decisions: [] }])
    ok('F55 immutable args written exactly once', compact.calls.filter((c) => c === 'args').length === 1, compact.calls.join(','))
    ok('F55 checkpoint references args and omits duplicated contracts', !!compact.stateJSON
      && !('resumeArgs' in compact.stateJSON) && !!compact.stateJSON.resumeArgsRef
      && !('spec' in compact.stateJSON.tasks[0]) && compact.stateJSON.tasks[0].brief.length <= 161,
    compact.stateJSON && J(compact.stateJSON.tasks[0]))
    ok('F55 changing checkpoint remains small', JSON.stringify(compact.stateJSON).length < 12000,
      String(JSON.stringify(compact.stateJSON).length))
    ok('F55 report compacts task and loop-result contracts', !!compact.res
      && !('spec' in compact.res.tasks[0]) && !('task' in compact.res.loopResult)
      && compact.res.loopResult.taskBrief.length <= 161, compact.res && J(compact.res.loopResult))
    ok('F55 terminal state precedes report with no redundant trailing state write',
      compact.calls.lastIndexOf('state') < compact.calls.lastIndexOf('report'), compact.calls.slice(-5).join(','))

    const fallback = await runFeat({ feat: 'Fallback', tasks: [huge], posture: 'oneshot' },
      { ...featBase, args: { written: false } },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F55 sidecar refusal falls back to inline canonical args', !!fallback.stateJSON
      && fallback.stateJSON.resumeArgs && fallback.stateJSON.resumeArgs.tasks[0] === huge.trim(),
    fallback.stateJSON && Object.keys(fallback.stateJSON).join(','))
    ok('F55 a refused sidecar is attempted once, not at every checkpoint',
      fallback.calls.filter((c) => c === 'args').length === 1, fallback.calls.join(','))
  }

  // F60 (dogfood large-plan transport 2026-08-19): the caller can cross the slash-command
  // boundary with a small feat id; the workflow itself loads the validated canonical task list.
  {
    const canonical = { argsVersion: 1, feat: 'F', tasks: ['only task'], policy: 'autonomous', posture: 'full' }
    const fid = featIdOf(canonical.feat, canonical.tasks)
    const loaded = await runFeat({ resumeFeatId: fid, posture: 'oneshot' },
      { ...featBase, 'args-load': { raw: JSON.stringify(canonical) } },
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F60 compact resumeFeatId loads the full canonical task list', loaded.workflowCalls === 1
      && loaded.loopArgs[0].task === 'only task', J(loaded.loopArgs[0]))
    ok('F60 explicit invocation fields override loaded defaults', loaded.loopArgs[0].posture === 'oneshot'
      && loaded.argsJSON.posture === 'oneshot', J(loaded.argsJSON))
    ok('F60 loader routes through the validated mechanical helper',
      /resume_args\.py/.test(loaded.prompts['args-load'] || '') && (loaded.prompts['args-load'] || '').includes(fid),
    loaded.prompts['args-load'])
    let unsafe = null
    try { await runFeat({ resumeFeatId: '../escape' }, featBase, []) }
    catch (e) { unsafe = String((e && e.message) || e) }
    ok('F60 unsafe resumeFeatId refuses before any file read', !!unsafe && /lowercase alphanumeric/.test(unsafe), unsafe)
    let malformed = null
    try { await runFeat({ resumeFeatId: fid }, { ...featBase, 'args-load': { raw: '{bad' } }, []) }
    catch (e) { malformed = String((e && e.message) || e) }
    ok('F60 malformed loader output fails loud', !!malformed && /could not load validated canonical args/.test(malformed), malformed)
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

  // ── 0.2.7 batch (field soak 2026-06-13): the adversarial-audit fixes, each pinned ───────────
  // F40: CONTAINMENT is a 3-outcome RECEIPT (item 8/finding 8). The runner echoes containment.sh's
  // {ran,dirty,paths}; the loop must read it MECHANICALLY — ran:false (failure) ⇒ inconclusive,
  // NEVER a breach (the cry-wolf false-positive) and NEVER clean (the silent false-negative).
  {
    const salt = 'c027'
    const base = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      fix: '', commit: J({ committed: true, sha: h40('c1') }), prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [], head: h40('c1') }),
    }
    const clean = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: J({ ran: true, dirty: false, paths: '' }) })
    ok('F40 containment ran+clean → done', clean.res.status === 'done', clean.res.status)
    ok('F40 containment prompt routes through containment.sh (mechanical receipt)',
      (clean.prompts['containment:implement'] || '').includes('/containment.sh'))
    const breach = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: leakAfterBaseline(' M leaked.ts') })
    ok('F40 containment ran+dirty → breach naming paths', breach.res.status === 'infra_error' && breach.res.containment === 'implement' && /leaked\.ts/.test(breach.res.note || ''), breach.res.status + '/' + breach.res.containment)
    // the KEY fix — both failure shapes are INCONCLUSIVE, not a verdict:
    const noJson = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: 'Here is the output: (no changes)' })
    ok('F40 containment non-JSON reply → inconclusive, NOT a breach (cry-wolf closed)',
      noJson.res.status === 'infra_error' && noJson.res.containment === 'implement_inconclusive', noJson.res.status + '/' + noJson.res.containment)
    const ranFalse = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: J({ ran: false, error: 'not a git repository' }) })
    ok('F40 containment {ran:false} → inconclusive, NEVER clean (silent-leak closed)',
      ranFalse.res.status === 'infra_error' && ranFalse.res.containment === 'implement_inconclusive', ranFalse.res.status + '/' + ranFalse.res.containment)
    const empty = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: '' })
    ok('F40 containment empty reply → inconclusive (not read as clean)',
      empty.res.status === 'infra_error' && empty.res.containment === 'implement_inconclusive', empty.res.status)
  }

  // F40b (PR2, 2026-06-29): the RELAY itself can hallucinate a contract-violating receipt. The thin Haiku
  // runner echoed `paths` as an ARRAY of the repo root (from its own `$(git rev-parse --show-toplevel)`);
  // dirtLines(String(array)) coerced it into a fake dirt line → a FALSE breach on a clean tree. The
  // receipt-contract validator rejects non-porcelain paths and retries → inconclusive, never a false breach.
  {
    const salt = 'pr2'
    const base = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      fix: '', commit: J({ committed: true, sha: h40('c1') }), prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [], head: h40('c1') }),
    }
    // baseline reads the REAL clean receipt; later checks hallucinate `paths` as an ARRAY → must NOT breach.
    let hn = 0
    const halluc = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => (++hn === 1 ? J({ ran: true, dirty: false, paths: '' })
                                     : J({ ran: true, dirty: false, paths: ['/repo/root'] })) })
    ok('F40b array-paths hallucination → inconclusive, NOT a false breach',
      halluc.res.status === 'infra_error' && halluc.res.containment === 'implement_inconclusive'
        && /contract validation/i.test(halluc.res.note || ''),
      halluc.res.status + '/' + halluc.res.containment + ' note=' + (halluc.res.note || '').slice(0, 40))
    // a non-porcelain STRING (e.g. the bare repo path) is also rejected, not coerced into dirt:
    let sn = 0
    const strHalluc = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => (++sn === 1 ? J({ ran: true, dirty: false, paths: '' })
                                     : J({ ran: true, dirty: true, paths: '/repo/root' })) })
    ok('F40b non-porcelain string paths → inconclusive, NOT a breach',
      strHalluc.res.status === 'infra_error' && strHalluc.res.containment === 'implement_inconclusive',
      strHalluc.res.status + '/' + strHalluc.res.containment)
    // a TRANSIENT hallucination self-heals — put it on the implement CHECK (call #2), NOT the baseline, so it
    // actually locks the retry path: without retry, call #2's array coerces to a fake dirt line → breach; with
    // retry, attempt 2 reads the real clean receipt → done. (On the baseline it would pass either way.)
    let rn = 0
    const recov = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => { rn++; return J(rn === 2 ? { ran: true, dirty: false, paths: ['/repo/root'] }
                                                    : { ran: true, dirty: false, paths: '' }) } })
    ok('F40b transient hallucination on the CHECK → retry recovers → done (locks the retry path)', recov.res.status === 'done', recov.res.status)
    // a REAL unstaged-edit breach (" M f", X=space) still fires — validation must not reject legit porcelain:
    const realLeak = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: leakAfterBaseline(' M src/real-leak.ts') })
    ok('F40b real unstaged-edit leak still breaches (no over-rejection)',
      realLeak.res.status === 'infra_error' && realLeak.res.containment === 'implement' && /real-leak\.ts/.test(realLeak.res.note || ''),
      realLeak.res.status + '/' + realLeak.res.containment)
    // a STAGED edit "M  f" (X=M column) — proves the RAW-line regex accepts the X≠space shape, not just " M":
    const stagedLeak = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: leakAfterBaseline('M  src/staged.ts') })
    ok('F40b staged-edit leak (X=M column) still breaches — RAW regex accepts it',
      stagedLeak.res.status === 'infra_error' && stagedLeak.res.containment === 'implement' && /staged\.ts/.test(stagedLeak.res.note || ''),
      stagedLeak.res.status + '/' + stagedLeak.res.containment)
    // a RENAME "R  old -> new" (arrow-containing path) is real porcelain → must still breach:
    const renameLeak = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: leakAfterBaseline('R  old.ts -> new.ts') })
    ok('F40b rename receipt (R  a -> b) accepted as porcelain → breach',
      renameLeak.res.status === 'infra_error' && renameLeak.res.containment === 'implement' && /new\.ts/.test(renameLeak.res.note || ''),
      renameLeak.res.status + '/' + renameLeak.res.containment)
    // CONSISTENCY (the dangerous one): dirty:true but empty paths — WITHOUT the check this reads as CLEAN
    // (false-clean!); the validator rejects the self-contradiction → inconclusive. Locks a false-clean direction.
    let cn = 0
    const dirtyEmpty = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => (++cn === 1 ? J({ ran: true, dirty: false, paths: '' })
                                     : J({ ran: true, dirty: true, paths: '' })) })
    ok('F40b dirty:true + empty paths → inconclusive, NEVER a false clean',
      dirtyEmpty.res.status === 'infra_error' && dirtyEmpty.res.containment === 'implement_inconclusive',
      dirtyEmpty.res.status + '/' + dirtyEmpty.res.containment)
    // CONSISTENCY: dirty:false but real porcelain paths — a self-contradicting relay → inconclusive (don't guess):
    let cm = 0
    const cleanButDirty = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => (++cm === 1 ? J({ ran: true, dirty: false, paths: '' })
                                     : J({ ran: true, dirty: false, paths: ' M leaked.ts' })) })
    ok('F40b dirty:false + non-empty paths → inconclusive (self-contradiction distrusted)',
      cleanButDirty.res.status === 'infra_error' && cleanButDirty.res.containment === 'implement_inconclusive',
      cleanButDirty.res.status + '/' + cleanButDirty.res.containment)
    // MISSING FIELD: no `dirty` key → fails the typeof guard → inconclusive (the next-likeliest malformed shape):
    let mn = 0
    const missingDirty = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: () => (++mn === 1 ? J({ ran: true, dirty: false, paths: '' })
                                     : J({ ran: true, paths: ' M f.ts' })) })
    ok('F40b receipt missing `dirty` → inconclusive',
      missingDirty.res.status === 'infra_error' && missingDirty.res.containment === 'implement_inconclusive',
      missingDirty.res.status + '/' + missingDirty.res.containment)
    // BASELINE exhausts on a hallucination → empty allowed-set; a later REAL leak STILL fires. Baseline is the
    // one call whose failure is swallowed (→ empty set) rather than surfaced, so prove it fails SAFE:
    const badBaseline = await runLoop({ task: 't', idSalt: salt }, { ...base,
      containment: (p, opts) => J(((opts && opts.label) || '').endsWith(':baseline')
        ? { ran: true, dirty: false, paths: ['/repo/root'] }
        : { ran: true, dirty: true, paths: ' M real-leak.ts' }) })
    ok('F40b exhausted baseline → empty allowed-set, real later leak STILL breaches (fail-safe)',
      badBaseline.res.status === 'infra_error' && badBaseline.res.containment === 'implement' && /real-leak\.ts/.test(badBaseline.res.note || ''),
      badBaseline.res.status + '/' + badBaseline.res.containment)
  }

  // F40c (PR-relay audit 2026-06-29): the COMMIT relay has no receipt cross-check (unlike merge). A
  // committed:true WITHOUT a valid sha sets COMMIT_SHA=null → prepAndVerify's head-binding SKIPS (it only
  // runs `if (expectedHead && …)`) → a fabricated HEADLESS {pass:true} verify is believed as `done`,
  // reopening the run-6 cover-up hole through the commit relay. A committed:true must name a sha or it's infra.
  {
    const cbase = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t'), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      fix: '', prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [] }),   // HEADLESS green — the run-6 fabrication shape
    }
    const noSha = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true }) })
    ok('F40c commit committed:true + NO sha → infra_error, NOT a false done',
      noSha.res.status === 'infra_error' && /sha/i.test(noSha.res.error || ''), noSha.res.status + ' ' + (noSha.res.error || '').slice(0, 46))
    const emptySha = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true, sha: '' }) })
    ok('F40c commit committed:true + empty sha → infra_error', emptySha.res.status === 'infra_error', emptySha.res.status)
    const proseSha = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true, sha: 'the tree is committed' }) })
    ok('F40c commit committed:true + prose (spaces) sha → infra_error', proseSha.res.status === 'infra_error', proseSha.res.status)
    const arrSha = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true, sha: [h40('abc123')] }) })
    ok('F40c commit committed:true + array sha → infra_error', arrSha.res.status === 'infra_error', arrSha.res.status)
    // no over-rejection: a valid sha + a head-BOUND green → done
    const good = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true, sha: h40('abc123') }), verify: J({ pass: true, failures: [], head: h40('abc123') }) })
    ok('F40c commit valid sha + head-bound green → done', good.res.status === 'done' && good.res.commit_sha === h40('abc123'), good.res.status + '/' + good.res.commit_sha)
    // the gate makes head-binding non-optional: valid sha + a HEADLESS green → head_missing → verify_failed
    const headless = await runLoop({ task: 't' }, { ...cbase, commit: J({ committed: true, sha: h40('abc123') }), verify: J({ pass: true, failures: [] }) })
    ok('F40c valid sha + headless green → verify_failed (head-binding enforced, run-6 hole shut)', headless.res.status === 'verify_failed', headless.res.status)
  }

  // F40d (PR-relay audit): the PARK relay (review-unresolved path) has the same gate — a committed:true park
  // WITHOUT a valid sha must NOT bind an unbound green into a false verifyClean:true (which nudges a human to
  // accept unverified work). An empty stage is still legitimately unbound; only a garbled seal is a failure.
  {
    const stuckReview = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1' }], nonblocking: [] })
    const pbase = { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: stuckReview, fix: '', prep: J({ prepped: true, ran: [] }) }
    // valid park sha + head-bound green → verifyClean:true (S10a behavior preserved — no over-rejection):
    const okPark = await runLoop({ task: 't', roundCap: 2 }, { ...pbase, park: J({ committed: true, sha: h40('p4rk1234') }), verify: J({ pass: true, failures: [], head: h40('p4rk1234') }) })
    ok('F40d park valid sha + head-bound green → verifyClean:true (unchanged)', okPark.res.status === 'review_unresolved' && okPark.res.verifyClean === true, okPark.res.status + '/' + okPark.res.verifyClean)
    // committed:true park with NO sha → treated as park FAILURE (verifyClean null), never a false green:
    const badPark = await runLoop({ task: 't', roundCap: 2 }, { ...pbase, park: J({ committed: true }), verify: J({ pass: true, failures: [] }) })
    ok('F40d park committed:true + NO sha → verifyClean null (garbled seal ≠ shippable)',
      badPark.res.status === 'review_unresolved' && badPark.res.verifyClean !== true, badPark.res.status + '/' + badPark.res.verifyClean)
  }

  // F40e (Mateo's audit 2026-07-06): the LAND path had the SAME null-sha hole — committed:true with no sha
  // bound verify to null (head-binding skipped) → a headless green returned done, commit_sha:null. Now the
  // centralized commitReceipt gate makes a sealless land infra, never a false done.
  {
    const landBase = {
      'land-resolve': J({ found: true, path: wtPath('t') }),
      prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [] }),   // HEADLESS green
    }
    const landNoSha = await runLoop({ task: 't', land: true }, { ...landBase, commit: J({ committed: true }) })
    ok('F40e land committed:true + NO sha → infra_error, NOT a false done',
      landNoSha.res.status === 'infra_error' && /sha/i.test(landNoSha.res.error || ''), landNoSha.res.status + ' ' + (landNoSha.res.error || '').slice(0, 46))
    const landGood = await runLoop({ task: 't', land: true }, { ...landBase, commit: J({ committed: true, sha: h40('land1') }), verify: J({ pass: true, failures: [], head: h40('land1') }) })
    ok('F40e land valid sha + head-bound green → done (no over-rejection)', landGood.res.status === 'done' && landGood.res.commit_sha === h40('land1'), landGood.res.status)
  }

  // F40f (Mateo's audit 2026-07-06): the PARK path IGNORED commit.sh's empty-stage sha and verified UNBOUND —
  // a {committed:false, reason:"empty", sha:tip} + headless green returned verifyClean:true. Now it binds to
  // that tip (like the land path), so a headless green is head_missing (not verifyClean) and a bound green certifies.
  {
    const stuckReview = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1' }], nonblocking: [] })
    const pbase = { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: stuckReview, fix: '', prep: J({ prepped: true, ran: [] }) }
    const emptyHeadless = await runLoop({ task: 't', roundCap: 2 }, { ...pbase, park: J({ committed: false, reason: 'empty', sha: h40('tip1') }), verify: J({ pass: true, failures: [] }) })
    ok('F40f park empty-stage + HEADLESS green → NOT verifyClean:true (binds to the empty-stage tip)',
      emptyHeadless.res.status === 'review_unresolved' && emptyHeadless.res.verifyClean !== true, emptyHeadless.res.status + '/' + emptyHeadless.res.verifyClean)
    const emptyBound = await runLoop({ task: 't', roundCap: 2 }, { ...pbase, park: J({ committed: false, reason: 'empty', sha: h40('tip1') }), verify: J({ pass: true, failures: [], head: h40('tip1') }) })
    ok('F40f park empty-stage + tip-bound green → verifyClean:true (prior commit certified)',
      emptyBound.res.status === 'review_unresolved' && emptyBound.res.verifyClean === true, emptyBound.res.status + '/' + emptyBound.res.verifyClean)
  }

  // F40g (Mateo re-audit 2026-07-06): the NORMAL path's empty stage must be PROVEN by a sha too — an empty
  // stage with a valid HEAD sha is a benign no_changes, but a sha-less empty is a relay claiming "nothing to
  // do" without evidence (a potential silent work-drop) → infra, never a false noop.
  {
    const nbase = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t'), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }),
    }
    const emptyWithSha = await runLoop({ task: 't' }, { ...nbase, commit: J({ committed: false, reason: 'empty', sha: h40('tip1') }), 'noop-audit': '0' })
    ok('F40g normal empty + valid HEAD sha + zero unmerged → no_changes (benign, ancestry-confirmed)', emptyWithSha.res.status === 'no_changes', emptyWithSha.res.status)
    const emptyNoSha = await runLoop({ task: 't' }, { ...nbase, commit: J({ committed: false, reason: 'empty' }) })
    ok('F40g normal empty + NO sha → infra_error, NOT a false noop', emptyNoSha.res.status === 'infra_error' && /empty stage|no valid HEAD/i.test(emptyNoSha.res.error || ''), emptyNoSha.res.status + ' ' + (emptyNoSha.res.error || '').slice(0, 40))
  }

  // F56 (Studio live smoke 2026-07-13, P1): the STANDALONE loop's empty stage is ambiguous — the
  // implement agent may have committed the reviewed work itself, so "nothing staged" can mean "already
  // on the branch". The feat lane had the noop rescue (F27); the loop now audits ancestry the same way:
  // unmerged commits → proceed as committed at the branch tip (verify head-bound to it, full terminal
  // identity fields); zero → genuine no_changes; unreadable count → infra, never an unevidenced no-op.
  {
    const nbase = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t'), branch: 'b', summary: 's', decisions: [] },
      review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
      fix: '', prep: J({ prepped: true, ran: [] }),
    }
    const priorEmpty = { committed: false, reason: 'empty', sha: h40('tip1') }
    // unmerged commits on the branch → the no-op claim is REFUSED; verify binds to the prior tip and
    // the terminal is a normal done carrying commit_sha + the identity fields (what the receipt seals).
    const rescued = await runLoop({ task: 't' }, {
      ...nbase, commit: J(priorEmpty), 'noop-audit': '1',
      verify: J({ pass: true, failures: [], head: h40('tip1') }),
    })
    ok('F56a empty stage + unmerged commit → rescued as done at the prior tip (never a false noop)',
      rescued.res.status === 'done' && rescued.res.commit_sha === h40('tip1'), rescued.res.status + '/' + rescued.res.commit_sha)
    ok('F56a rescued terminal carries the full identity fields',
      typeof rescued.res.initialModel === 'string' && typeof rescued.res.finalFixModel === 'string' && typeof rescued.res.escalated === 'boolean', JSON.stringify({ i: rescued.res.initialModel, f: rescued.res.finalFixModel }))
    // the rescued verify is HEAD-BOUND to the prior tip: a headless green must not certify it.
    const rescuedHeadless = await runLoop({ task: 't' }, {
      ...nbase, commit: J(priorEmpty), 'noop-audit': '1',
      verify: J({ pass: true, failures: [] }),
    })
    ok('F56b rescued prior commit + HEADLESS green → verify_failed (head-binding enforced on the rescue)',
      rescuedHeadless.res.status === 'verify_failed', rescuedHeadless.res.status)
    // zero unmerged commits → a genuine no-op, now ancestry-evidenced (and it names its models too).
    const noop = await runLoop({ task: 't' }, { ...nbase, commit: J(priorEmpty), 'noop-audit': '0', verify: J({ pass: true, failures: [] }) })
    ok('F56c empty stage + zero unmerged → no_changes with identity fields',
      noop.res.status === 'no_changes' && typeof noop.res.initialModel === 'string', noop.res.status + '/' + noop.res.initialModel)
    // unreadable ancestry → infra, never a no-op without evidence (the feat lane's F27 discipline).
    const unread = await runLoop({ task: 't' }, { ...nbase, commit: J(priorEmpty), 'noop-audit': 'fatal: unknown revision', verify: J({ pass: true, failures: [] }) })
    ok('F56d empty stage + unreadable ancestry audit → infra_error (missing evidence is never a noop)',
      unread.res.status === 'infra_error' && unread.res.stage === 'noop_audit', unread.res.status + '/' + (unread.res.stage || ''))
  }

  // F41: MERGE NULL-RELAY recovery (item 2) — a dropped merge relay must NOT stamp merge_failed
  // when merge.sh's receipt proves the merge; and no-relay+no-receipt is inconclusive, not failed.
  {
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const proven = { merged: true, committed: true, alreadyUpToDate: false, before: 'aaa', after: 'bbb', priorMergeCommit: null }
    // relay dropped (mg null) BUT receipt proves success + live HEAD matches → merge succeeds
    const r = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, merge: null, 'merge-receipt': J(proven), 'merge-head': 'bbb' }, loopDone)
    ok('F41 null relay + proven receipt + matching HEAD → done (not a false merge_failed)', r.res && r.res.status === 'done', r.res && r.res.status)
    // relay dropped AND receipt missing → inconclusive ready_to_merge, NEVER definitive merge_failed
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, merge: null, 'merge-receipt': 'MISSING', 'merge-head': 'zzz' }, loopDone)
    ok('F41 null relay + no receipt → ready_to_merge inconclusive, not merge_failed',
      r2.res && r2.res.status === 'feat_integration_failed' && r2.res.stage === 'merge_receipt' && !!r2.stateJSON && r2.stateJSON.tasks[0].status === 'ready_to_merge', r2.res && (r2.res.status + '/' + r2.res.stage))
    // null relay + receipt says success but live HEAD moved off it → off-script mutation caught
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, merge: null, 'merge-receipt': J(proven), 'merge-head': 'zzz' }, loopDone)
    ok('F41 null relay + receipt vs moved HEAD → off-script halt', r3.res && r3.res.status === 'feat_integration_failed' && r3.res.stage === 'merge_receipt' && /OFF-SCRIPT/.test(r3.res.note || ''), r3.res && r3.res.stage)
  }

  // F42: ENV readiness DERIVED from exitCode (item 4) — a relay whose `ready` contradicts its
  // exitCode is a misread; halt loud, never advance on a contradicted env.
  {
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const ok1 = await runFeat({ feat: 'F', tasks: ['only task'] }, { ...featBase, 'env-check': { ready: true, exitCode: 0, output: 'ok' } }, loopDone)
    ok('F42 env ready:true exit:0 → proceeds (done)', ok1.res && ok1.res.status === 'done', ok1.res && ok1.res.status)
    const mism = await runFeat({ feat: 'F', tasks: ['only task'] }, { ...featBase, 'env-check': { ready: true, exitCode: 1, output: 'broken' } }, loopDone)
    ok('F42 env ready:true exit:1 (contradiction) → env_not_ready halt', mism.res && mism.res.status === 'env_not_ready', mism.res && mism.res.status)
    const red = await runFeat({ feat: 'F', tasks: ['only task'] }, { ...featBase, 'env-check': { ready: false, exitCode: 1, output: 'install' } }, loopDone)
    ok('F42 env ready:false exit:1 → normal env_not_ready', red.res && red.res.status === 'env_not_ready', red.res && red.res.status)
  }

  // F43: FORK DETECTION (item 8) — an in-progress feat with the SAME title but a DIFFERENT id halts
  // for a human; the current feat is excluded (normal resume never trips); allowFork bypasses.
  {
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const myId = featIdOf('Shared Title', ['only task'])
    const twin = { featId: 'shared-title-zz9999', title: 'Shared Title', status: 'running' }
    const fork = await runFeat({ feat: 'Shared Title', tasks: ['only task'] },
      { ...featBase, 'fork-scan': J({ feats: [twin] }) }, loopDone)
    ok('F43 same-title different-id in-progress → needs_human fork', fork.res && fork.res.status === 'needs_human' && fork.res.stage === 'fork', fork.res && (fork.res.status + '/' + fork.res.stage))
    ok('F43 fork note names the other branch', /shared-title-zz9999/.test((fork.res && fork.res.note) || ''))
    const readyTask = taskIdOf('Shared Title', ['only task'], 'only task')
    const readyPrior = { featId: myId, feat: 'Shared Title', status: 'running',
      tasks: [{ taskId: readyTask, status: 'ready_to_merge', provenStatus: 'done_with_findings',
        provenCommit: h40('ready'), branch: `camus/feat/${myId}/${readyTask}`, decisions: [] }] }
    const forkWithProof = await runFeat({ feat: 'Shared Title', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0,
        stateRaw: JSON.stringify(readyPrior), argsPresent: false }, 'fork-scan': J({ feats: [twin] }) }, loopDone)
    ok('F43 fork halt preserves the hydrated ready_to_merge lane, never serializes it pending',
      forkWithProof.stateJSON.tasks[0].status === 'ready_to_merge'
        && forkWithProof.stateJSON.tasks[0].provenStatus === 'done_with_findings',
    J(forkWithProof.stateJSON.tasks[0]))
    const mineDone = await runFeat({ feat: 'Shared Title', tasks: ['only task'] },
      { ...featBase, 'fork-scan': J({ feats: [{ featId: myId, title: 'Shared Title', status: 'running' }] }) }, loopDone)
    ok('F43 current featId excluded → no false fork (proceeds)', mineDone.res && mineDone.res.status === 'done', mineDone.res && mineDone.res.status)
    const doneTwin = await runFeat({ feat: 'Shared Title', tasks: ['only task'] },
      { ...featBase, 'fork-scan': J({ feats: [{ ...twin, status: 'done' }] }) }, loopDone)
    ok('F43 a DONE same-title feat is not a fork (terminal excluded)', doneTwin.res && doneTwin.res.status === 'done', doneTwin.res && doneTwin.res.status)
    const bypass = await runFeat({ feat: 'Shared Title', tasks: ['only task'], allowFork: true },
      { ...featBase, 'fork-scan': J({ feats: [twin] }) }, loopDone)
    ok('F43 allowFork:true bypasses (no scan, proceeds)', bypass.res && bypass.res.status === 'done', bypass.res && bypass.res.status)
  }

  // F44: BASE-FROM-CHECKOUT guard (item 9) — base on a camus/feat-* branch halts; allowFeatBase bypasses.
  {
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const onFeat = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: 'camus/feat-old', dirtyFiles: 0, stateRaw: '' } }, loopDone)
    ok('F44 base is a camus/feat-* branch → needs_human', onFeat.res && onFeat.res.status === 'needs_human' && onFeat.res.stage === 'base_is_feat_branch', onFeat.res && (onFeat.res.status + '/' + onFeat.res.stage))
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = { featId: fid, status: 'running', posture: 'oneshot',
      tasks: [{ taskId: tid, brief: 'only task', dependsOn: [], status: 'ready_to_merge',
        branch: `camus/feat/${fid}/${tid}`, loopStatus: 'done_with_findings',
        provenStatus: 'done_with_findings', provenCommit: h40('proof'), decisions: [{ what: 'accepted', why: 'evidence' }] }],
      events: [{ seq: 7, msg: 'proof persisted' }], eventSeq: 7 }
    const preserved = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: 'camus/feat-old', dirtyFiles: 0,
        stateRaw: JSON.stringify(prior), argsPresent: false } }, loopDone)
    ok('F44 early base guard preserves ready_to_merge proof instead of clobbering it pending',
      preserved.stateJSON.tasks[0].status === 'ready_to_merge'
        && preserved.stateJSON.tasks[0].provenStatus === 'done_with_findings'
        && preserved.stateJSON.tasks[0].provenCommit === h40('proof'), J(preserved.stateJSON.tasks[0]))
    ok('F44 early guard preserves prior decisions/events in state and report',
      preserved.stateJSON.eventSeq === 7 && preserved.res.tasks[0].status === 'ready_to_merge'
        && preserved.res.tasks[0].decisions[0].what === 'accepted', J(preserved.res.tasks[0]))
    const exactResume = { ...prior, featBranch: `camus/feat-${fid}`, base: 'main' }
    const resumed = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: `camus/feat-${fid}`, dirtyFiles: 0,
        stateRaw: JSON.stringify(exactResume), argsPresent: false } }, loopDone)
    ok('F44 exact feat branch + matching checkpoint → resumes instead of false stacking halt',
      resumed.res && resumed.res.status === 'done', resumed.res && (resumed.res.status + '/' + resumed.res.stage))
    ok('F44 exact resume restores original mainline base in state/report',
      resumed.stateJSON.base === 'main' && resumed.res.base === 'main',
      J({ state: resumed.stateJSON.base, report: resumed.res.base }))
    const legacySelf = { ...exactResume, base: `camus/feat-${fid}` }
    const recovered = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: `camus/feat-${fid}`, dirtyFiles: 0,
        stateRaw: JSON.stringify(legacySelf), argsPresent: false } }, loopDone)
    ok('F44 legacy self-overwritten base + exact identity → resumes for migration recovery',
      recovered.res && recovered.res.status === 'done',
      recovered.res && (recovered.res.status + '/' + recovered.res.stage))
    ok('F44 legacy recovery reports unknown base rather than inventing mainline provenance',
      recovered.stateJSON.base === null && recovered.res.base === null,
      J({ state: recovered.stateJSON.base, report: recovered.res.base }))
    const recoveredAgain = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: `camus/feat-${fid}`, dirtyFiles: 0,
        stateRaw: JSON.stringify(recovered.stateJSON), argsPresent: false } }, loopDone)
    ok('F44 normalized base:null checkpoint remains resumable after another interruption',
      recoveredAgain.res && recoveredAgain.res.status === 'done',
      recoveredAgain.res && (recoveredAgain.res.status + '/' + recoveredAgain.res.stage))
    ok('F44 repeated legacy resume keeps unknown base honest',
      recoveredAgain.stateJSON.base === null && recoveredAgain.res.base === null,
      J({ state: recoveredAgain.stateJSON.base, report: recoveredAgain.res.base }))
    const missingProof = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, preflight: { clean: true, base: `camus/feat-${fid}`, dirtyFiles: 0,
        stateRaw: '', argsPresent: false } }, loopDone)
    ok('F44 exact feat branch without matching checkpoint still refuses fail-closed',
      missingProof.res && missingProof.res.status === 'needs_human'
        && missingProof.res.stage === 'base_is_feat_branch',
      missingProof.res && (missingProof.res.status + '/' + missingProof.res.stage))
    const bypass = await runFeat({ feat: 'F', tasks: ['only task'], allowFeatBase: true },
      { ...featBase, preflight: { clean: true, base: 'camus/feat-old', dirtyFiles: 0, stateRaw: '' } }, loopDone)
    ok('F44 allowFeatBase:true bypasses (proceeds)', bypass.res && bypass.res.status === 'done', bypass.res && bypass.res.status)
  }

  // F45: args.verifyCmd (item 3) — a headless verify override is inlined as a JSON-quoted env
  // PREFIX on the feat verifiers and forwarded to every per-task loop.
  {
    const loopDone = [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }]
    const vc = 'pnpm type-check && pnpm test'
    const r = await runFeat({ feat: 'F', tasks: ['only task'], verifyCmd: vc }, featBase, loopDone)
    ok('F45 verifyCmd inlined as a JSON-quoted env prefix on baseline verify',
      (r.prompts['baseline-verify'] || '').includes(`CAMUS_VERIFY_CMD=${J(vc)} `), (r.prompts['baseline-verify'] || '').slice(0, 160))
    ok('F45 verifyCmd forwarded to the per-task loop', !!r.loopArgs[0] && r.loopArgs[0].verifyCmd === vc, J(r.loopArgs[0] && r.loopArgs[0].verifyCmd))
    const none = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase, loopDone)
    ok('F45 no verifyCmd → no env prefix (unchanged)', !(none.prompts['baseline-verify'] || '').includes('CAMUS_VERIFY_CMD='))
    // F45b (verification audit 2026-06-13): a shell-injection verifyCmd ($()/backtick/quote) is
    // REFUSED — dropped (no env prefix), never inlined where bash would expand it. JSON.stringify
    // does NOT neutralize $(…) inside double quotes; the charset guard does.
    for (const evil of ['true$(touch /tmp/PWN)', 'a `id` b', 'x" ; rm -rf / ; "y']) {
      const r2 = await runFeat({ feat: 'F', tasks: ['only task'], verifyCmd: evil }, featBase, loopDone)
      ok('F45b injection verifyCmd refused (no env prefix): ' + evil.slice(0, 18),
        !(r2.prompts['baseline-verify'] || '').includes('CAMUS_VERIFY_CMD=') && !(r2.loopArgs[0] && r2.loopArgs[0].verifyCmd),
        (r2.prompts['baseline-verify'] || '').slice(0, 120))
    }
    // F45c: the loop-side guard too (a stringified loop arg carrying an injection verifyCmd)
    const lp = await runLoop({ task: 't', verifyCmd: 'go$(whoami)' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F45c loop refuses injection verifyCmd (verify prompt has no env prefix)',
      lp.res.status === 'done' && !(lp.prompts.verify || '').includes('CAMUS_VERIFY_CMD='), lp.res.status)
  }

  // F46 (verification audit round-2, 2026-06-13): the SAME shell-expansion class on sibling paths.
  // (a) targetPath inlined into REPO_CD `cd "…"`; (b) an agent-returned worktree path that only
  // passed endsWith(WT_NAME); (c) the free-text task context inlined as a review.sh arg.
  {
    const evilPath = '/tmp/$(touch /tmp/PWN)/x'
    // (a) feat REFUSES an injection targetPath before forwarding (throws)
    let threw = false
    try {
      await runFeat({ feat: 'F', tasks: ['only task'], targetPath: evilPath }, featBase,
        [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    } catch (_) { threw = true }
    ok('F46a feat throws on a shell-unsafe targetPath (no forward)', threw)
    // (a') loop ABORTS on an injection targetPath rather than cd-ing into it
    const lt = await runLoop({ task: 't', targetPath: evilPath }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F46a loop aborts on a shell-unsafe targetPath', lt.res.status === 'aborted' && lt.res.stage === 'args', lt.res.status + '/' + lt.res.stage)
    // (b) an agent-returned worktree path with $() passes endsWith but is REFUSED by shellSafe
    const evilWt = '/tmp/$(touch /tmp/PWN)/' + wtName('t')
    const bad = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail,
      implement: { worktree_path: evilWt, branch: 'b', summary: 's', decisions: [] } })
    ok('F46b injection worktree path refused despite valid suffix', bad.res.status === 'aborted' && bad.res.stage === 'implement', bad.res.status + '/' + bad.res.stage)
    // (c) a task containing $() reaches review.sh SINGLE-QUOTED (inert), never $()-expandable.
    //     The whole stuck path runs; assert the review command wraps the ctx in '…' not "…$()…".
    const evilReview = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'a:1' }], nonblocking: [] })
    const rc = await runLoop({ task: 'fix the $(whoami) call', roundCap: 1, idSalt: 'inj1' },
      { ...clsStd, ...planOf('clear', ''),
        implement: { worktree_path: wtPath('fix the $(whoami) call', 'inj1'), branch: 'b', summary: 's', decisions: [] },
        review: evilReview, fix: '', containment: J({ ran: true, dirty: false, paths: '' }),
        park: J({ committed: true, sha: h40('p') }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: h40('p') }) })
    const reviewPrompt = rc.prompts[reviewLbl(rc.calls, 1)] || ''
    ok('F46c task text reaches review SINGLE-quoted (inert), not double-quoted',
      reviewPrompt.includes("'fix the $(whoami) call") && !reviewPrompt.includes('"fix the $(whoami) call'), reviewPrompt.slice(0, 200))
  }

  // F47 (verification audit round-2, 2026-06-13): the identity/branch args of the SAME class — found
  // by an INDEPENDENT auditor after the first round generalized "branches are computed/safe" (true
  // for feat, NOT for camus-loop's caller-supplied branchPrefix/idSalt, nor feat's agent-returned
  // mergeBranch).
  {
    const ab = await runLoop({ task: 't', branchPrefix: '$(touch /tmp/PWN)camus/' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F47a injection branchPrefix → loop aborts (stage:args)', ab.res.status === 'aborted' && ab.res.stage === 'args', ab.res.status + '/' + ab.res.stage)
    const semi = await runLoop({ task: 't', branchPrefix: 'a;id;camus/' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F47a2 branchPrefix with ; refused (unquoted word-split class)', semi.res.status === 'aborted' && semi.res.stage === 'args', semi.res.status)
    const as = await runLoop({ task: 't', idSalt: '$(touch /tmp/PWN)x' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F47b injection idSalt → loop aborts (stage:args)', as.res.status === 'aborted' && as.res.stage === 'args', as.res.status + '/' + as.res.stage)
    const ais = await runLoop({ task: 't', identitySalt: '$(touch /tmp/PWN)x' }, { ...cls, ...planOf('clear', ''), ...happyTail })
    ok('F47b2 injection identitySalt → loop aborts (stage:args)', ais.res.status === 'aborted' && ais.res.stage === 'args', ais.res.status + '/' + ais.res.stage)
    // feat: an agent-returned mergeBranch with $() is SINGLE-quoted in the merge command (inert)
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fr = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/$(whoami)', decisions: [] }])
    const mp = fr.prompts['merge:' + tid] || ''
    ok('F47c feat REJECTS an injection mergeBranch (never inlined; falls back to node.branch)',
      !mp.includes('$(whoami)'), mp.slice(0, 220))
  }

  // F48 (verification audit round-3, 2026-06-13): a state-FILE mergedBranch is untrusted — on resume
  // it is inlined into the postflight self-audit `git rev-list HEAD..<branch>` command. A poisoned
  // value must be DROPPED at load (→ falls back to the computed node.branch), never reach the shell.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fid = featIdOf('F', ['only task'])
    const prior = {
      featId: fid, feat: 'F', featBranch: 'camus/feat-' + fid, status: 'running',
      tasks: [{ taskId: tid, spec: 'only task', status: 'done', branch: 'camus/feat/x/only', mergedBranch: '$(touch /tmp/PWN)' }],
    }
    const resume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r = await runFeat({ feat: 'F', tasks: ['only task'] }, resume, [])
    const sa = r.prompts['self-audit'] || ''
    ok('F48 poisoned state mergedBranch dropped on load — never in the self-audit command',
      sa.length > 0 && !sa.includes('$(touch /tmp/PWN)'), sa.slice(0, 200))
  }

  // F49 (verification audit round-4, 2026-06-13): the LIVE twin of F48. A loop-RETURNED res.branch
  // is a relayed value; a mismatched one with $() was stored raw into node.mergedBranch and reached
  // the self-audit `git rev-list HEAD..<branch>` command. mergeBranch is now validated against the
  // camus-branch allowlist before any use — a non-camus ref falls back to the computed node.branch.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const r = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/$(id)', decisions: [] }])
    const sa = r.prompts['self-audit'] || ''
    ok('F49 live mismatched res.branch with $() never reaches the self-audit command',
      sa.length > 0 && !sa.includes('$(id)'), sa.slice(0, 200))
    // and the merge command never inlines it double-quoted either (shq + validation)
    const mp = r.prompts['merge:' + tid] || ''
    ok('F49 …nor double-quoted in the merge command', !mp.includes('"camus/feat/x/$(id)"'), mp.slice(0, 160))
  }

  // ── F52: PREP AND VERIFY ARE EMITTED AS PLAIN TRUSTED-SCRIPT COMMANDS ──────
  // Both scripts anchor `_guard.sh` at $PWD and a fresh runner process is not guaranteed to
  // start inside the target repository, so WP7 (20260805-181917-f4b1) got `target rejected by
  // camus_guard` after a clean review. That was first fixed by prefixing REPO_CD — and inside a
  // LINKED worktree `git rev-parse --show-toplevel` is the worktree itself, so WP9
  // (20260806-145411-hy1w) emitted `cd <wp8-worktree> && verify.sh <wp9-worktree>`, auto mode
  // denied the cross-worktree compound command, and the runner's prose refusal was read as a
  // missing toolchain. The anchoring now lives in the scripts (`camus_anchor`, off the
  // process-level CAMUS_REPO_ROOT), so what the runner is handed must be a PLAIN script call.
  // These assert the PRODUCTION command shape the workflow actually emits.
  {
    const { calls, prompts } = await runLoop({ task: 't', targetPath: '/some/target/repo' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('cwdanch') }), prep: J({ prepped: true, ran: [] }),
        verify: J({ pass: true, failures: [], head: h40('cwdanch') }) })
    const prepLbl = calls.find((c) => /prep/.test(c))
    const verifyLbl = calls.find((c) => /verify/.test(c))
    // The command LINE only — the surrounding prose legitimately mentions the word "cd".
    const cmdLine = (p) => ((p || '').split('\n').find((l) => /(prep|verify)\.sh /.test(l)) || '')
    const prepCmd = cmdLine(prompts[prepLbl])
    const verifyCmd = cmdLine(prompts[verifyLbl])
    ok('F52a the prep command carries NO cd of any kind', prepCmd !== '' && !/(^|[;&|\s])cd\s/.test(prepCmd), prepCmd)
    ok('F52b the verify command carries NO cd of any kind', verifyCmd !== '' && !/(^|[;&|\s])cd\s/.test(verifyCmd), verifyCmd)
    ok('F52c neither command mentions rev-parse --show-toplevel (the WP9 cross-worktree cd)',
      !/--show-toplevel/.test(prepCmd) && !/--show-toplevel/.test(verifyCmd), prepCmd + ' | ' + verifyCmd)
    ok('F52d each ends with the trusted script and the worktree as its ARGUMENT',
      /prep\.sh "/.test(prepCmd) && /verify\.sh "/.test(verifyCmd), prepCmd + ' | ' + verifyCmd)
    // Both runners are told to change nothing about the line — and the instruction states the
    // operational reason (what gets measured), not what a permission check would decide. A real
    // Haiku runner read the earlier "auto mode refuses to run" phrasing as coaching it past a
    // permission gate and refused the whole command (auto-mode preflight, 2026-08-06).
    ok('F52e both runners are told to add nothing and remove nothing',
      /adding nothing and removing nothing/.test(prompts[prepLbl] || '')
        && /Add NOTHING and remove nothing/.test(prompts[verifyLbl] || ''),
      (prompts[verifyLbl] || '').slice(0, 320))
    ok('F52e2 and neither prompt reasons about what auto mode will approve',
      !/auto mode/i.test(prompts[prepLbl] || '') && !/auto mode/i.test(prompts[verifyLbl] || ''),
      (prompts[verifyLbl] || '').slice(0, 320))
    ok('F52f the runner is told to REPORT a refusal rather than diagnose the repo',
      /RUNNER_COULD_NOT_EXECUTE/.test(prompts[prepLbl] || '') && /RUNNER_COULD_NOT_EXECUTE/.test(prompts[verifyLbl] || ''),
      'both thin runners must have a way to say "I never ran it"')
    ok('F52g the mechanical heartbeat/status prefixes are still inlined by the orchestrator',
      /verify\.sh /.test(verifyCmd), verifyCmd)
  }

  // ── F52h: A RUNNER THAT NEVER RAN THE COMMAND IS NOT AN ENVIRONMENT DIAGNOSIS ──
  // WP9 (20260806-145411-hy1w): Bash auto-mode denied the verify command, the Haiku runner
  // replied in prose, asVerify discarded it for a generic "not parseable", and the receipt told
  // the operator the .NET toolchain and dependencies were missing from a worktree nothing had
  // measured. The runner's own words are the only evidence of what happened.
  {
    const refusal = 'I could not run that command: permission to use Bash was denied for this path, so I did not execute the verification.'
    const { res } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('denied') }), prep: J({ prepped: true, ran: [] }),
        verify: refusal })
    const f = (res.failures || [])[0] || {}
    ok('F52h a refused verify ends inconclusive, never a code failure', res.status === 'verify_inconclusive', res.status)
    ok('F52i the kind is runner_refused', f.kind === 'runner_refused', JSON.stringify(res.failures))
    ok('F52j the runner\'s reply survives verbatim in the log tail',
      typeof f.log_tail === 'string' && f.log_tail.includes('permission to use Bash was denied'), String(f.log_tail).slice(0, 200))
    ok('F52k the note says NOTHING was measured', /NOTHING about this worktree/.test(res.note || ''), (res.note || '').slice(0, 220))
    // Not the WORD "toolchain" — the note legitimately says nothing about the toolchain was
    // measured. What must be absent is the fabricated DIAGNOSIS the live receipt carried.
    ok('F52l the note does NOT diagnose a missing toolchain or dependencies',
      !/toolchain\/deps missing/.test(res.note || '') && !/Fix the environment/.test(res.note || '')
        && !/env_check/.test(res.note || '') && !/no verifier detected/.test(res.note || ''),
      (res.note || '').slice(0, 260))
    ok('F52m the note hands over the exact command to re-run by hand',
      /verify\.sh/.test(res.note || ''), (res.note || '').slice(0, 300))
    // Output that simply did not parse is a DIFFERENT kind — and still not an env diagnosis.
    const { res: garble } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('garble') }), prep: J({ prepped: true, ran: [] }),
        verify: 'Sure! Here is a summary of what the tests did.' })
    const gf = (garble.failures || [])[0] || {}
    ok('F52n unparseable output is runner_unparseable, not runner_refused', gf.kind === 'runner_unparseable', JSON.stringify(garble.failures))
    ok('F52o and it too keeps the reply verbatim',
      String(gf.log_tail || '').includes('Here is a summary'), String(gf.log_tail || '').slice(0, 160))
    ok('F52p neither unparseable case claims a missing toolchain',
      !/toolchain\/deps missing/.test(garble.note || '') && !/Fix the environment/.test(garble.note || ''), (garble.note || '').slice(0, 200))
    // A long refusal is BOUNDED — a runner can emit an essay and it must not swallow the receipt.
    const long = 'permission denied. ' + 'x'.repeat(6000)
    const { res: big } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('longref') }), prep: J({ prepped: true, ran: [] }),
        verify: long })
    const bf = (big.failures || [])[0] || {}
    ok('F52q the raw tail is bounded', String(bf.log_tail || '').length < 1600, String(bf.log_tail || '').length)
    ok('F52r and it is a TAIL (the end of the reply survives)', /x{100}$/.test(String(bf.log_tail || '')), String(bf.log_tail || '').slice(-40))
    // A REAL verdict is untouched by any of this.
    const { res: good } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('realok') }), prep: J({ prepped: true, ran: [] }),
        verify: J({ pass: true, failures: [], head: h40('realok') }) })
    ok('F52s a real green verdict still parses and passes', good.status === 'done', good.status)
    // A prep runner that never ran gets the same honesty, not `missing_tool`.
    const { res: prepRef } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('prepref') }),
        prep: 'I was not allowed to run that command.',
        verify: J({ pass: true, failures: [], head: h40('prepref') }) })
    const pf = (prepRef.failures || [])[0] || {}
    ok('F52t a refused PREP is runner_refused, not missing_tool', pf.kind === 'runner_refused', JSON.stringify(prepRef.failures))
    ok('F52u and its note does not blame the package manager',
      !/package manager/.test(prepRef.note || ''), (prepRef.note || '').slice(0, 200))

    // ── F52v: "EXACTLY AS THE GATE WOULD" MUST INCLUDE THIS RUN'S VERIFIER ──
    // A .NET run carries args.verifyCmd, so the handed-over command needs the same override the
    // gate used. A bare verify.sh would auto-detect a DIFFERENT verifier and answer a different
    // question while claiming to reproduce the gate's own check.
    const { res: ov } = await runLoop({ task: 't', verifyCmd: 'dotnet test Wukong.sln' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('ovcmd') }), prep: J({ prepped: true, ran: [] }),
        verify: 'permission denied; I did not run it.' })
    ok('F52v the handed-over command carries the run\'s verifier override',
      /bash "\$HOME\/\.claude\/skills\/camus\/scripts\/verify\.sh" "[^"]*" --verify-cmd "dotnet test Wukong\.sln"/.test(ov.note || ''),
      (ov.note || '').slice(-260))
    ok('F52w and the "exactly as the gate would" claim is therefore true',
      /exactly as the gate would/.test(ov.note || '') && /--verify-cmd "dotnet test/.test(ov.note || ''),
      (ov.note || '').slice(-200))
    // NEVER as an env-assignment prefix: a real Haiku runner in auto mode refuses that shape.
    ok('F52w2 the override is never handed over as an env-assignment prefix',
      !/CAMUS_VERIFY_CMD=/.test(ov.note || ''), (ov.note || '').slice(-200))
    // With NO override the command stays bare — no empty flag, no invented verifier.
    ok('F52x a run with no override hands over a bare verify.sh',
      /(^|[^"])bash "\$HOME\/\.claude\/skills\/camus\/scripts\/verify\.sh"/.test(res.note || '')
        && !/--verify-cmd/.test(res.note || ''), (res.note || '').slice(-200))
  }

  // ── F53: A GUARD REFUSAL IS REPORTED AS A GUARD REFUSAL ────────────────────
  // Every prep failure was flattened to `missing_tool`, so a refused target produced
  // "dependency install failed; check the package manager / lockfile" — an install that
  // was never attempted, sending the operator after an uninvolved lockfile.
  {
    const refusal = 'target rejected by camus_guard (not a same-repo camus-wt-* worktree)'
    const { res } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('guardrf') }),
        prep: J({ prepped: false, ran: null, reason: 'guard_refused', log_tail: refusal }),
        verify: J({ pass: true, failures: [], head: h40('guardrf') }) })
    ok('F53a a refused prep still ends inconclusive, never a code failure', res.status === 'verify_inconclusive', res.status)
    ok('F53b the failure kind is guard_refused, not missing_tool',
      (res.failures || []).some((f) => f.kind === 'guard_refused'), JSON.stringify(res.failures))
    ok('F53c the verbatim guard reason survives into the receipt',
      (res.failures || []).some((f) => f.log_tail === refusal), JSON.stringify(res.failures))
    ok('F53d the note names the guard refusal', /target guard rejected the worktree/.test(res.note || ''), (res.note || '').slice(0, 200))
    ok('F53e the note does NOT blame a dependency install',
      !/dependency install failed/.test(res.note || '') && !/package manager/.test(res.note || ''), (res.note || '').slice(0, 200))
    ok('F53f the note says nothing was attempted', /NO dependency install and NO verification were attempted/.test(res.note || ''), (res.note || '').slice(0, 220))
    // A REAL dependency failure keeps its own (correct) diagnosis.
    const { res: dep } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: J({ ran: true, clean: true, blocking: [], nonblocking: [] }),
        commit: J({ committed: true, sha: h40('depfail') }),
        prep: J({ prepped: false, ran: null, log_tail: 'pnpm install exited 1' }),
        verify: J({ pass: true, failures: [], head: h40('depfail') }) })
    ok('F53g a real dep failure is still reported as one',
      (dep.failures || []).some((f) => f.kind === 'missing_tool') && /dependency install failed/.test(dep.note || ''),
      JSON.stringify(dep.failures) + ' | ' + (dep.note || '').slice(0, 120))
  }

  // ── F54: THE AWAIT CARRIES THE SAME IDENTITY AS THE START ──────────────────
  // A reattach that cannot prove the watch is its own gets declined by the adoption gate,
  // and the fresh path then overwrote a COMPLETED round and paid for a second reviewer
  // (production run 20260806-063400-vzqs: pid 45073 → 71857, meta.json left with no
  // gate_nonce and effort silently high). The await must present nonce, round and effort.
  {
    const { calls, prompts } = await runLoop({ task: 't', reviewerEffort: 'medium' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        // A pending handle forces the await path, then the round completes.
        review: [J({ pending: true, handle: '/tmp/camus-wt-x-r1.watch' }), J({ ran: true, clean: true, blocking: [], nonblocking: [] })],
        commit: J({ committed: true, sha: h40('awaitid') }), prep: J({ prepped: true, ran: [] }),
        verify: J({ pass: true, failures: [], head: h40('awaitid') }) })
    const awaitLbl = calls.find((c) => /await/.test(c))
    const p = prompts[awaitLbl] || ''
    ok('F54a the await presents the gate nonce', /CAMUS_GATE_NONCE=/.test(p), p.slice(0, 200))
    ok('F54b …the requested round', /CAMUS_REVIEW_ROUND=1\b/.test(p), p.slice(0, 200))
    ok('F54c …and the PINNED effort, not the adaptive schedule', /CAMUS_REVIEW_EFFORT=medium\b/.test(p), p.slice(0, 200))
    ok('F54d the await still runs the await form (never a fresh start)', / await "/.test(p), p.slice(0, 200))
  }

  // ── F55: THE FINAL ROUND GETS ONE BOUNDED SOLUTION PASS ────────────────────
  // The live WP8 run ended at 2/2 holding one NEW, concrete P1 (its coherent test never
  // advanced through cooldown expiry to count the second hit) and never attempted it, because
  // no confirmation round remained. The contract changed on purpose: one bounded fix, no extra
  // reviewer round, roundCap untouched, and honest fixed_unreviewed provenance.
  {
    let r = 0
    let fx = 0
    const { res, calls } = await runLoop({ task: 't', roundCap: 2 }, {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      // A REAL structured final-fix response, so the claimed resolution is mapped on.
      fix: () => {
        fx++
        return J({
          summary: fx === 1 ? 'Candidate after the first repair.' : 'Final candidate after the bounded repair.',
          decisions: fx === 1
            ? [{ what: 'First repair choice', why: 'Addressed round one' }]
            : [{ what: 'Final repair choice', why: 'Addressed the final finding' }],
          resolutions: [{ title: 'new-2', resolution: 'advanced the clock past cooldown expiry and asserted the second hit' }],
        })
      },
      // r1 raises a finding; r2 raises a DIFFERENT one (new, not a repeat, not oscillating).
      review: () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) },
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: true, sha: h40('f1na1f') }),
      verify: J({ pass: true, failures: [], head: h40('f1na1f') }),
    })
    const reviews = calls.filter((c) => c.startsWith('review'))
    const fixes = calls.filter((c) => c.startsWith('fix'))
    ok('F55a exactly TWO reviewer calls (roundCap honoured, no extra round)', reviews.length === 2, reviews.join(','))
    ok('F55b exactly TWO fix calls (r1 fix + the final bounded fix)', fixes.length === 2, fixes.join(','))
    ok('F55c the P1 candidate is parked with a head-bound green', res.status === 'review_unresolved' && res.verifyClean === true && res.parkedSha === h40('f1na1f'), res.status)
    ok('F55d …committed at the verified sha', res.commit_sha === h40('f1na1f'), String(res.commit_sha))
    ok('F55e provenance is fixed_unreviewed, never review-clean', /UNREVIEWED/.test(res.note || '') && /NOT review-clean/.test(res.note || ''), (res.note || '').slice(0, 140))
    ok('F55f …and explicitly NOT independent_clean', /NOT independent_clean/.test(res.note || ''), (res.note || '').slice(0, 140))
    ok('F55g the FINAL findings are recorded verbatim', Array.isArray(res.findings) && res.findings.some((f) => f.title === 'new-2'), JSON.stringify(res.findings || []).slice(0, 140))
    // The harness returns strings, so a schema-parsed object cannot arrive here; assert the
    // PRODUCTION wiring instead — the final bounded fix asks for the resolutions schema and the
    // sealed note points the reader at those claims.
    ok('F55h the maker\'s claimed resolution rides the final finding', Array.isArray(res.findings) && res.findings.some((f) => f.title === 'new-2' && /cooldown expiry/.test(String(f.claimedResolution || ''))), JSON.stringify(res.findings || []).slice(0, 200))
    ok('F55h1 …and the sealed resolution field says fixed_unreviewed', res.resolution === 'fixed_unreviewed', String(res.resolution))
    ok('F55h2 …and the note directs the human to those claimed resolutions', /claimed resolutions/.test(res.note || ''), (res.note || '').slice(0, 200))
    ok('F55h3 review_unresolved carries the FINAL post-fix summary', res.summary === 'Final candidate after the bounded repair.', String(res.summary))
    ok('F55h4 …and replaces superseded decisions', Array.isArray(res.decisions) && res.decisions.length === 1 && res.decisions[0].what === 'Final repair choice', JSON.stringify(res.decisions))
    ok('F55i no human pause preceded the solution attempt', !calls.some((c) => /ask|question/i.test(c)), calls.join(','))
    ok('F55j the note names the final-round case, not the oneshot posture', /FINAL-ROUND BOUNDED FIX/.test(res.note || ''), (res.note || '').slice(0, 90))
  }
  // RED and INCONCLUSIVE controls: the verdict keeps its own honest meaning, but the unreviewed
  // fix's findings, resolutions and provenance must survive into BOTH — and neither may read
  // review-clean or quietly drop what the reviewer found.
  for (const [label, verifyStub, wantStatus] of [
    ['red', J({ pass: false, failures: [{ stage: 'test', kind: 'assert' }] }), 'verify_failed'],
    ['inconclusive', J({ pass: false, inconclusive: true, failures: [{ stage: 'verify', kind: 'missing_tool' }] }), 'verify_inconclusive'],
  ]) {
    let rr = 0
    const { res } = await runLoop({ task: 't', roundCap: 2 }, {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-2', resolution: 'attempted the cooldown fix' }] }),
      review: () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-' + rr, code_location: 'f.ts:' + rr }], nonblocking: [] }) },
      prep: J({ prepped: true, ran: [] }), commit: J({ committed: true, sha: h40('ctrl' + label.slice(0, 2)) }),
      verify: verifyStub,
    })
    ok(`F55m ${label} verification keeps its own meaning`, res.status === wantStatus, res.status)
    ok(`F55n ${label} still carries the unreviewed findings`, Array.isArray(res.findings) && res.findings.some((f) => f.title === 'new-2'), JSON.stringify(res.findings || []).slice(0, 140))
    ok(`F55o ${label} still carries the claimed resolution`, Array.isArray(res.findings) && res.findings.some((f) => /cooldown/.test(String(f.claimedResolution || ''))), JSON.stringify(res.findings || []).slice(0, 160))
    ok(`F55p ${label} keeps the fixed_unreviewed provenance`, res.resolution === 'fixed_unreviewed', String(res.resolution))
    ok(`F55q ${label} never reads review-clean`, !/\breview[- ]clean\b/i.test(res.note || '') || /NOT review-clean/i.test(res.note || ''), (res.note || '').slice(0, 130))
  }

  // NO_CHANGES after an unreviewed fix: the copy must not claim the review passed, and the
  // findings must survive.
  {
    let rr = 0
    const { res } = await runLoop({ task: 't', roundCap: 2 }, {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-2', resolution: 'attempted the cooldown fix' }] }),
      review: () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-' + rr, code_location: 'f.ts:' + rr }], nonblocking: [] }) },
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: false, reason: 'empty', sha: h40('nochg1') }), 'noop-audit': '0',
      verify: J({ pass: true, failures: [], head: h40('nochg1') }),
    })
    ok('F55r no_changes after an unreviewed fix keeps its status', res.status === 'no_changes', res.status)
    ok('F55s …and never claims the review passed', !/^Review passed/.test(res.note || '') && /NOT review-clean/.test(res.note || ''), (res.note || '').slice(0, 150))
    ok('F55t …and still carries the findings', Array.isArray(res.findings) && res.findings.some((f) => f.title === 'new-2'), JSON.stringify(res.findings || []).slice(0, 130))
    ok('F55u …with the fixed_unreviewed provenance', res.resolution === 'fixed_unreviewed', String(res.resolution))
  }
  // A PRE-VERIFY infra failure (commit) must propagate the fields too — the fix ran, so its
  // findings are already owed to the reader even though no verdict exists.
  {
    let rr = 0
    const { res } = await runLoop({ task: 't', roundCap: 2 }, {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-2', resolution: 'attempted the cooldown fix' }] }),
      review: () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-' + rr, code_location: 'f.ts:' + rr }], nonblocking: [] }) },
      commit: 'not json at all',
    })
    ok('F55v a pre-verify infra failure still reports infra_error', res.status === 'infra_error', res.status)
    ok('F55w …and still carries the unreviewed findings', Array.isArray(res.findings) && res.findings.some((f) => f.title === 'new-2'), JSON.stringify(res.findings || []).slice(0, 130))
    ok('F55x …with the fixed_unreviewed provenance', res.resolution === 'fixed_unreviewed', String(res.resolution))
  }

  // ── F56: STRINGIFIED ARGS MUST HONOUR roundCap ─────────────────────────────
  // The runtime can hand args over as a JSON STRING. ROUND_CAP was computed before the
  // normalization block, so `args.roundCap` was undefined and the cap silently fell back to 3:
  // live run 20260806-091643-9nbv passed roundCap 2 everywhere and the loop still launched an
  // r3 watch. This passes args EXACTLY as the runtime does — stringified.
  {
    let rr = 0
    const { res, calls } = await runLoop(JSON.stringify({ task: 't', roundCap: 2 }), {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-2', resolution: 'advanced past cooldown expiry' }] }),
      review: () => { rr++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-' + rr, code_location: 'f.ts:' + rr }], nonblocking: [] }) },
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: true, sha: h40('str1ng') }),
      verify: J({ pass: true, failures: [], head: h40('str1ng') }),
    })
    const reviews = calls.filter((c) => c.startsWith('review'))
    ok('F56a stringified args honour roundCap:2 — exactly two reviewer calls', reviews.length === 2, reviews.join(','))
    ok('F56b NO third round is ever attempted (no r3 agent)', !calls.some((c) => /r3/.test(c)), calls.join(','))
    ok('F56c the final round still gets its ONE bounded fix', calls.filter((c) => c.startsWith('fix')).length === 2, calls.join(','))
    ok('F56d unreviewed P1 → review_unresolved', res.status === 'review_unresolved' && res.verifyClean === true, res.status)
    ok('F56e resolution is fixed_unreviewed', res.resolution === 'fixed_unreviewed', String(res.resolution))
    ok('F56f reviewedAfterFix is false', res.reviewedAfterFix === false, String(res.reviewedAfterFix))
    ok('F56g the note reports the honoured cap (2/2), not 3', /round 2\/2/.test(res.note || ''), (res.note || '').slice(0, 110))
    // The task itself must still survive the same normalization.
    ok('F56h the stringified task is still parsed', res.task === 't', String(res.task))
  }

  // ── F57: THE RUNNER BOUNDARY IS EXPLICIT ───────────────────────────────────
  // A thin runner improvised a six-minute Python poll and tried to parse the .watch DIRECTORY
  // as JSON; other rounds read stale artifacts. Each turned a healthy pending handle into an
  // infra retry. The instruction now names the boundary in both reviewer prompts.
  {
    const { calls, prompts } = await runLoop({ task: 't' },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
        review: [J({ pending: true, handle: '/tmp/camus-wt-x-r1.watch' }), J({ ran: true, clean: true, blocking: [], nonblocking: [] })],
        commit: J({ committed: true, sha: h40('bound1') }), prep: J({ prepped: true, ran: [] }),
        verify: J({ pass: true, failures: [], head: h40('bound1') }) })
    const start = prompts[calls.find((c) => /review:r1 codex/.test(c) && !/await/.test(c))] || ''
    const awaitP = prompts[calls.find((c) => /await/.test(c))] || ''
    for (const [label, p] of [['start', start], ['await', awaitP]]) {
      ok(`F57 ${label}: a pending handle is returned immediately`, /STOP AFTER THAT ONE COMMAND/.test(p), p.slice(0, 90))
      ok(`F57 ${label}: never inspect or parse the handle directory`, /NOT (look inside|inspect) the handle/i.test(p), p.slice(0, 90))
      ok(`F57 ${label}: never poll, sleep or loop`, /poll/.test(p) && /(sleep|loop)/.test(p), p.slice(0, 90))
      ok(`F57 ${label}: never run a second command`, /second\s+command/.test(p), p.slice(0, 90))
      ok(`F57 ${label}: the WORKFLOW owns reattachment`, /workflow (owns|will call you again)|this workflow will call you again/i.test(p), p.slice(0, 90))
    }
    ok('F57 the start names await as forbidden for the runner', /do NOT run \\`await\\`/.test(start) || /do NOT run `await`/.test(start), start.slice(0, 90))
  }

  // ── F58: CUSTODY ACROSS THE ASYNC REATTACH BOUNDARY ────────────────────────
  // Live run 20260806-110809-2r9j: r2 completed at the reviewer-process level (correct
  // gate_nonce and fp1: fingerprint in meta.json, exit 0, verdict produced), but the reattach
  // process emitted a receipt with NO binding block. The mixed bound/unbound guard refused it —
  // and the loop still ran fix, verify and a commit, then reported the round as preserved.
  {
    let rr = 0
    const { res, calls } = await runLoop(JSON.stringify({ task: 't', roundCap: 2 }), {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-2', resolution: 'repaired' }] }),
      review: () => {
        rr++
        // r1 bound with findings; r2 returns a PENDING handle (a separate process owns it);
        // the await then returns the completed, BOUND verdict.
        if (rr === 1) return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-1', code_location: 'f.ts:1' }], nonblocking: [] })
        if (rr === 2) return J({ pending: true, handle: '/tmp/camus-wt-x-r2.watch' })
        return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-2', code_location: 'f.ts:2' }], nonblocking: [] })
      },
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: true, sha: h40('cust0dy') }),
      verify: J({ pass: true, failures: [], head: h40('cust0dy') }),
    })
    const reviews = calls.filter((c) => c.startsWith('review') && !/await/.test(c))
    ok('F58a a pending r2 is re-attached, not re-reviewed', calls.some((c) => /await/.test(c)), calls.join(','))
    ok('F58b exactly two reviewer rounds under cap 2', reviews.length === 2, reviews.join(','))
    ok('F58c no third round', !calls.some((c) => /r3/.test(c)), calls.join(','))
    ok('F58d the completed BOUND await is accepted → commit + verify + P1 park', res.status === 'review_unresolved' && res.verifyClean === true, res.status)
    ok('F58e …at the verified head', res.commit_sha === h40('cust0dy'), String(res.commit_sha))
    ok('F58f …with fixed_unreviewed provenance', res.resolution === 'fixed_unreviewed', String(res.resolution))
  }
  // NEGATIVES: an unbound / tampered-nonce receipt must refuse AND leave everything untouched.
  for (const [label, second] of [
    ['missing binding', J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'f.ts:9' }], nonblocking: [], binding: null })],
    ['tampered nonce', J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'f.ts:9' }], nonblocking: [], binding: { round: 2, effort: 'high', model: 'gpt-5.6-sol', backend: 'codex', worktree: '/w/camus-wt-x', nonce: 'someone-elses-run' } })],
  ]) {
    let rr = 0
    const { res, calls } = await runLoop(JSON.stringify({ task: 't', roundCap: 2 }), {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      fix: J({ resolutions: [{ title: 'new-1', resolution: 'repaired' }] }),
      review: () => {
        rr++
        if (rr === 1) return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'new-1', code_location: 'f.ts:1' }], nonblocking: [] })
        return second
      },
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: true, sha: h40('shouldnt') }),
      verify: J({ pass: true, failures: [], head: h40('shouldnt') }),
    })
    ok(`F58g ${label}: the refused receipt ends the run as infra, not a verdict`, res.status === 'infra_error', res.status)
    ok(`F58h ${label}: NOTHING was committed`, res.committed === false && !res.commit_sha, `${res.committed}/${res.commit_sha}`)
    ok(`F58i ${label}: no commit agent ran at all`, !calls.some((c) => c.startsWith('commit')), calls.join(','))
    ok(`F58j ${label}: no verify ran on an unvalidated verdict`, !calls.some((c) => c.startsWith('verify')), calls.join(','))
    ok(`F58k ${label}: the round did NOT advance`, res.roundAdvanced === false, String(res.roundAdvanced))
    ok(`F58l ${label}: the report states the observed facts`, /OBSERVED THIS ROUND: fix dispatched=/.test(res.note || '') && /committed=false/.test(res.note || ''), (res.note || '').slice(-120))
    ok(`F58m ${label}: the refusal names the binding, not a code problem`, /binding|nonce/i.test(res.error || ''), String(res.error).slice(0, 90))
  }

  // A PENDING that outlives the await budget must end as infra — never as a clean verdict that
  // sends the loop to commit/verify (the shape that let an unvalidated round mutate the tree).
  {
    const { res, calls } = await runLoop(JSON.stringify({ task: 't', roundCap: 2 }), {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '',
      review: J({ pending: true, handle: '/tmp/camus-wt-x-r1.watch' }),   // never completes
      prep: J({ prepped: true, ran: [] }), commit: J({ committed: true, sha: h40('nope00') }),
      verify: J({ pass: true, failures: [], head: h40('nope00') }),
    })
    ok('F58n an unresolved pending is NOT a verdict', res.status === 'infra_error', res.status)
    ok('F58o …and never reads as clean', !/clean/i.test(res.status), res.status)
    ok('F58p …nothing was committed', res.committed === false && !res.commit_sha, `${res.committed}/${res.commit_sha}`)
    ok('F58q …no commit or verify agent ran', !calls.some((c) => c.startsWith('commit') || c.startsWith('verify')), calls.join(','))
    // After the await budget the loop aborts the watch, so the ABORT's output is what gets
    // judged — the contract is that a refusal is reported, never a verdict.
    ok('F58r …and an infra reason is reported, never a verdict', typeof res.error === 'string' && res.error.length > 0 && !/clean/i.test(res.error), String(res.error).slice(0, 80))
  }

  // ── F59: TERMINAL NARRATIVE FOLLOWS THE REVIEWED CANDIDATE ───────────────
  // WP10's first candidate duplicated production helpers. Review caught it, the bounded fix
  // moved those helpers into production, r2 passed, and deterministic verification was green —
  // but the terminal report still repeated the initial summary/decision. The existing fix turn
  // must replace that narrative; buying a separate summarizer would waste time and tokens.
  {
    let rr = 0
    const initial = {
      ...happyTail.implement,
      summary: 'Initial candidate duplicates production helpers in its tests.',
      decisions: [{ what: 'Duplicate helper behavior in tests', why: 'Fast first implementation' }],
    }
    const finalNarrative = {
      summary: 'Final candidate exposes the pure helpers from production and tests those exact implementations.',
      decisions: [{ what: 'Move pure helpers into Core', why: 'Tests now exercise production behavior directly' }],
    }
    const { res, prompts } = await runLoop({ task: 't', roundCap: 2 }, {
      ...clsStd, ...planOf('clear', ''), implement: initial,
      review: () => {
        rr++
        return rr === 1
          ? J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'Tests duplicate production logic', code_location: 'tests/f.cs:1' }], nonblocking: [] })
          : J({ ran: true, clean: true, blocking: [], nonblocking: [] })
      },
      fix: finalNarrative,
      prep: J({ prepped: true, ran: [] }),
      commit: J({ committed: true, sha: h40('narrative') }),
      verify: J({ pass: true, failures: [], head: h40('narrative') }),
    })
    ok('F59a the reviewed candidate reaches done', res.status === 'done', res.status)
    ok('F59b terminal summary is the POST-FIX summary', res.summary === finalNarrative.summary, String(res.summary))
    ok('F59c terminal decisions are the COMPLETE post-fix set', JSON.stringify(res.decisions) === JSON.stringify(finalNarrative.decisions), JSON.stringify(res.decisions))
    ok('F59d superseded summary and decisions do not survive', !/duplicates|Duplicate helper/.test(JSON.stringify({ summary: res.summary, decisions: res.decisions })), JSON.stringify(res))
    ok('F59e the fix sees the pre-fix narrative it must rewrite', /Initial candidate duplicates production helpers/.test(prompts['fix:r1'] || '') && /Duplicate helper behavior in tests/.test(prompts['fix:r1'] || ''), (prompts['fix:r1'] || '').slice(-500))
    ok('F59f the rewrite happens in the existing fix turn', /COMPLETE current candidate/.test(prompts['fix:r1'] || '') && /do not merely append/.test(prompts['fix:r1'] || ''), (prompts['fix:r1'] || '').slice(-500))
  }

  // A STUCK dispute still stops without a fix — the bounded pass is for NEW findings only.
  {
    const stuckSame = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'f.ts:1' }], nonblocking: [] })
    const { res, calls } = await runLoop({ task: 't', roundCap: 2 },
      { ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '', review: stuckSame,
        prep: J({ prepped: true, ran: [] }), commit: J({ committed: true, sha: h40('stuck1') }), verify: J({ pass: true, failures: [], head: h40('stuck1') }) })
    ok('F55k a REPEATED finding still halts for the human (no bounded fix)', res.status === 'review_unresolved', res.status)
    ok('F55l …with exactly one fix (the r1 attempt), never a second', calls.filter((c) => c.startsWith('fix')).length === 1, calls.join(','))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
