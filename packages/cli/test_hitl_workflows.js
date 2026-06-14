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
    if (capture && label === 'state') {
      capture.state = p   // the persist prompt embeds the state JSON (last write wins)
      ;(capture.states = capture.states || []).push(p)   // …and EVERY persist, for intermediate-state assertions
    }
    const s = (label in scripts) ? scripts[label] : scripts[key(label)]
    return typeof s === 'function' ? s(p, opts) : s
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
    stateJSONs: (capture.states || []).map(extractBraces).filter(Boolean),
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
  // head names the sha happyTail's commit stub seals — head-bound greens (publish audit P2).
  verify: J({ pass: true, failures: [], head: 'abc123' }),
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
  // The review returns a DIFFERENT finding each round (unique title+location) so the stuck-finding
  // early-stop (Fix 2026-06-11) does NOT fire — this isolates the roundCap behavior.
  const cleanVerify = { prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) }
  const varyBlock = () => {
    let r = 0
    return {
      ...cls, ...planOf('clear', ''), implement: happyTail.implement, fix: '', ...cleanVerify,
      review: () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 't' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) },
    }
  }
  {
    const { res, calls } = await runLoop({ task: 't', roundCap: 1 }, varyBlock())
    ok('S8a roundCap:1 → review_unresolved after 1 round', res.status === 'review_unresolved', res.status)
    ok('S8a exactly 1 review round ran', calls.filter((c) => c.startsWith('review')).length === 1, calls.filter((c) => c.startsWith('review')).join(','))
    ok('S8a note reports the honored cap', /ROUND_CAP=1/.test(res.note || ''))
  }
  {
    // out-of-range cap (99) falls back to the default 3 — bounded so a bad value can't run away.
    const { res, calls } = await runLoop({ task: 't', roundCap: 99 }, varyBlock())
    ok('S8b out-of-range roundCap → default 3 rounds', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S8b → review_unresolved', res.status === 'review_unresolved', res.status)
  }
  // S10: review_unresolved now CONSULTS deterministic verify before reporting, and a finding
  // re-raised after a fix STOPS early for a human decision (Fix 2026-06-11 — "deterministic ground
  // truth wins"; a probabilistic review was halting verify-clean shippable code).
  const stuckReview = J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'same', code_location: 'a.ts:1' }], nonblocking: [] })
  const stuckBase = { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: stuckReview, fix: '', prep: J({ prepped: true, ran: [] }) }
  // Since the run-6 integrity work, the unresolved path PARKS FIRST (unconditionally) and then
  // verifies the parked commit — verify refuses uncommitted state, so the seal must precede the
  // ground-truth consult. Red attempts park too (protection, not a reward for green).
  const parkOk = { park: J({ committed: true, sha: 'p4rk1234' }) }
  {
    // verify GREEN on a non-converged review → DECISION POINT (verifyClean:true), not a plain failure.
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, ...parkOk, verify: J({ pass: true, failures: [], head: 'p4rk1234' }) })
    ok('S10a review_unresolved + verify GREEN → verifyClean true', res.status === 'review_unresolved' && res.verifyClean === true, res.status + '/' + res.verifyClean)
    ok('S10a verify actually ran on the halt (ground truth consulted)', calls.includes('verify'))
    ok('S10a park precedes verify (seal, then certify)', calls.indexOf('park') < calls.indexOf('verify'), calls.join(','))
    ok('S10a note frames it as a decision, not a failure', /DECIDE|shippable/.test(res.note || ''))
    ok('S10a stuck finding surfaced for the human', Array.isArray(res.stuck) && res.stuck.length === 1)
    ok('S10a stopped early (2 rounds, not roundCap 5)', calls.filter((c) => c.startsWith('review')).length === 2, String(calls.filter((c) => c.startsWith('review')).length))
  }
  {
    // verify RED → genuinely not done (verifyClean:false) — and the attempt is STILL parked
    // (run-6 reorder: the seal happens before the verdict exists; a red park beats uncommitted dirt).
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, ...parkOk, verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }) })
    ok('S10b review_unresolved + verify RED → verifyClean false', res.status === 'review_unresolved' && res.verifyClean === false, res.status + '/' + res.verifyClean)
    ok('S10b note says genuinely not done', /genuinely not done/.test(res.note || ''))
    ok('S10b red attempt parks too (sealed before the verdict; note names it red)', calls.includes('park') && /parked as p4rk1234 .*verify-red/.test(res.note || ''), res.note)
  }
  // S21 (0.2.5 item 2 + run-6 reorder): PARK seals the review-flagged worktree as a labeled
  // commit BEFORE verify, so proven work survives anything; land's empty-stage path finishes
  // from there on accept. The commit message carries no verify verdict (none exists yet) —
  // the NOTE carries it.
  {
    const { res, calls, prompts } = await runLoop({ task: 't', roundCap: 5 },
      { ...stuckBase, verify: J({ pass: true, failures: [], head: 'p4rk1234' }), park: J({ committed: true, sha: 'p4rk1234' }) })
    ok('S21 verify-clean halt parks a commit', calls.includes('park'), calls.join(','))
    ok('S21 park message is the labeled chore (no verdict claimed pre-verify)',
      !!prompts.park && prompts.park.includes('chore(camus): park') && prompts.park.includes('(review-flagged)') && !prompts.park.includes('verify-green'))
    ok('S21 parked sha surfaced on the halt', res.parkedSha === 'p4rk1234', res.parkedSha)
    ok('S21 note says the work is parked', /PARKED as commit p4rk1234/.test(res.note || ''))
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
      { ...cls, ...planOf('clear', ''), implement: happyTail.implement, review: emptyFindings, fix: '', prep: J({ prepped: true, ran: [] }), verify: J({ pass: false, failures: [] }) })
    ok('S11f un-keyable findings do NOT falsely stuck → runs to cap (3)', calls.filter((c) => c.startsWith('review')).length === 3, String(calls.filter((c) => c.startsWith('review')).length))
    ok('S11f → review_unresolved (not a stuck early-stop)', res.status === 'review_unresolved' && !res.stuck)
  }
  // S12 (run-5 fix 2026-06-11): LAND MODE — commit already-proven work without re-running the loop.
  const landStubs = {
    'land-resolve': J({ found: true, path: wtPath('t') }),
    commit: J({ committed: true, sha: 'land1' }),
    prep: J({ prepped: true, ran: [] }),
    verify: J({ pass: true, failures: [], head: 'land1' }),
  }
  {
    const { res, calls } = await runLoop({ task: 't', land: true }, landStubs)
    ok('S12a land → done with sha, rounds 0, landed flag', res.status === 'done' && res.commit_sha === 'land1' && res.rounds === 0 && res.landed === true, JSON.stringify({ s: res.status, sha: res.commit_sha }))
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
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: 't1pl1ve' }), verify: J({ pass: true, failures: [], head: 't1pl1ve' }) })
    ok('S12d land + empty stage → still done (already committed)', res.status === 'done' && res.commit_sha === null, res.status + '/' + res.commit_sha)
    ok('S12d verify still ran', calls.includes('verify'))
    // F36a (publish audit round-2 P1): the empty-stage land no longer believes unbound greens.
    const noHead = await runLoop({ task: 't', land: true },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: 't1pl1ve' }), verify: J({ pass: true, failures: [] }) })
    ok('F36a empty-stage land + unnamed green → verify_failed (head_missing)',
      noHead.res.status === 'verify_failed' && JSON.stringify(noHead.res.failures || []).includes('head_missing'), noHead.res.status)
    // F36b: expectHead (the ORIGINAL proof) outranks the live tip — a task-branch tip that moved
    // past the proof fails CLOSED with both shas named, never believed and merged.
    const moved = await runLoop({ task: 't', land: true, expectHead: 'pr00f' },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: 't1pmoved' }), verify: J({ pass: true, failures: [], head: 't1pmoved' }) })
    ok('F36b tip moved past the proven commit → verify_failed naming both shas',
      moved.res.status === 'verify_failed' && JSON.stringify(moved.res.failures || []).includes('pr00f') && JSON.stringify(moved.res.failures || []).includes('t1pmoved'), moved.res.status)
    // …and a tip still AT the proof verifies green through the same binding.
    const held = await runLoop({ task: 't', land: true, expectHead: 'pr00f' },
      { ...landStubs, commit: J({ committed: false, reason: 'empty', sha: 'pr00f' }), verify: J({ pass: true, failures: [], head: 'pr00f' }) })
    ok('F36b tip still at the proven commit → done', held.res.status === 'done', held.res.status)
    // Legacy gate shape (no sha on empty, no recorded proof) stays unbound — never a regression
    // for old states; verify's internal invariants still apply.
    const legacy = await runLoop({ task: 't', land: true }, { ...landStubs, commit: J({ committed: false, reason: 'empty' }) })
    ok('F36c legacy empty (no sha, no proof) → unbound, still done', legacy.res.status === 'done', legacy.res.status)
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
    ok('S16 fix dispatched only when a round remains to confirm it', calls.filter((c) => c.startsWith('fix')).length === 1, calls.join(','))
    ok('S16 both review rounds ran', calls.filter((c) => c.startsWith('review')).length === 2)
    ok('S16 → review_unresolved', res.status === 'review_unresolved', res.status)
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
      commit: J({ committed: true, sha: 'abc' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'abc' }),
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
      commit: J({ committed: true, sha: 'abc123' }), verify: J({ pass: true, failures: [], head: 'abc123' }),
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
      commit: J({ committed: true, sha: 'abc123' }), verify: J({ pass: true, failures: [], head: 'abc123' }),
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
      commit: J({ committed: true, sha: 'abc123' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'abc123' }) }, calls2),
      () => {}, (m) => logs.push(m), async () => { throw new Error('no workflow') }, undefined)
    ok('S22d codex usage in the clean-round log', logs.some((m) => /codex ~16k in\/900 out \(4000 reasoning\)/.test(m)), logs.filter((m) => /CLEAN/.test(m)).join(' | '))
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
      commit: J({ committed: true, sha: 'one5h0t' }), ...cleanVerify, verify: J({ pass: true, failures: [], head: 'one5h0t' }),
    }
    const { res, calls } = await runLoop({ task: 't', posture: 'oneshot', roundCap: 5 }, stubs)
    ok('S23b oneshot blocking → done_with_findings', res.status === 'done_with_findings', res.status)
    ok('S23b exactly ONE review + ONE fix (cap ignored)', calls.filter((c) => c.startsWith('review')).length === 1 && calls.filter((c) => c.startsWith('fix')).length === 1, calls.join(','))
    ok('S23b findings verbatim + honest resolution', res.findingsDeferred === 1 && res.resolution === 'fixed_unreviewed' && res.findings[0].title === 'edge case', JSON.stringify(res.findings))
    ok('S23b committed (merged-ready) + note says NOT review-clean', res.commit_sha === 'one5h0t' && /NOT review-clean/.test(res.note || ''), res.note)
  }
  {
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement, fix: '',
      review: J({ ran: true, clean: false, blocking: [{ priority: 1, title: 'x', code_location: 'a:1' }], nonblocking: [] }),
      commit: J({ committed: true, sha: 'c' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }),
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

  // S24 (smoke 2026-06-12): ONESHOT carries the fix agent's CLAIMED resolution per finding —
  // a reader must be able to tell addressed-unreviewed from untouched. Claims, never verdicts.
  {
    const finding = { priority: 1, title: 'edge case', code_location: 'a.ts:1' }
    const stubs = {
      ...clsStd, ...planOf('clear', ''), implement: happyTail.implement,
      review: J({ ran: true, clean: false, blocking: [finding], nonblocking: [] }),
      fix: { resolutions: [{ title: 'edge case', resolution: 're-exported the symbol from the original module' }] },
      commit: J({ committed: true, sha: 'c1' }), ...cleanVerify, verify: J({ pass: true, failures: [], head: 'c1' }),
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
      commit: J({ committed: true, sha: 'c1' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'c1' }),
    }
    const clean = await runLoop({ task: 't', idSalt: salt }, { ...base25, containment: J({ ran: true, dirty: false, paths: '' }) })
    ok('S25a clean main tree → done, containment checked', clean.res.status === 'done' && clean.calls.includes('containment:implement'), clean.res.status + ' ' + clean.calls.join(','))
    // git audit 2026-06-12: a merged submodule-pointer bump leaves permanent ` M sub` porcelain —
    // the guard must ignore submodule noise or every later task false-fires.
    ok('S25a2 containment ignores submodule noise', (clean.prompts['containment:implement'] || '').includes('/containment.sh'))
    const leaky = await runLoop({ task: 't', idSalt: salt }, { ...base25, containment: J({ ran: true, dirty: true, paths: ' M packages/x.ts' }) })
    ok('S25b implement leak → infra halt naming the phase', leaky.res.status === 'infra_error' && leaky.res.containment === 'implement', leaky.res.status + '/' + leaky.res.containment)
    ok('S25b note names the leaked paths + recovery', /packages\/x\.ts/.test(leaky.res.note) && /diff them against the task worktree/.test(leaky.res.note))
  }
  {
    // fix-phase leak: clean after implement, dirty after the fix ran (full posture, cap 2).
    const salt = 'feat123'
    let c25 = 0
    const stubs = {
      ...clsStd, ...planOf('clear', ''),
      implement: { worktree_path: wtPath('t', salt), branch: 'b', summary: 's', decisions: [] },
      review: (() => { let r = 0; return () => { r++; return J({ ran: true, clean: false, blocking: [{ priority: 1, title: 't' + r, code_location: 'f.ts:' + r }], nonblocking: [] }) } })(),
      fix: '', containment: () => (++c25 === 1 ? J({ ran: true, dirty: false, paths: '' }) : J({ ran: true, dirty: true, paths: ' M lib/leaked.ts' })),
      prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }),
    }
    const { res } = await runLoop({ task: 't', idSalt: salt, roundCap: 2 }, stubs)
    ok('S25c fix leak caught post-loop, named as the fix phase', res.status === 'infra_error' && res.containment === 'fix', res.status + '/' + res.containment)
  }
  {
    // standalone (no idSalt): even a would-be-dirty tree is never checked — not a breach.
    const { res, calls } = await runLoop({ task: 't' }, { ...clsStd, ...planOf('clear', ''), ...happyTail, containment: J({ ran: true, dirty: true, paths: ' M anything.ts' }) })
    ok('S25d standalone loop → containment never runs', res.status === 'done' && !calls.some((c) => c.startsWith('containment')), calls.join(','))
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
    preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: '' },
    'fork-scan': J({ feats: [] }),          // no in-progress twin feat (0.2.7 item 8); fail-open if absent
    'steer': J({ read: true, note: null }), // steer_read.py sentinel: no note (0.2.7 item 7)
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
    report: { written: true }, state: { written: true },
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
    ok('F18 resumeArgs persists budgetTokens', !!over.stateJSON && over.stateJSON.resumeArgs.budgetTokens === 50000, over.stateJSON && JSON.stringify(over.stateJSON.resumeArgs))
    const under = await runFeat({ feat: bFeat, tasks: bTasks, budgetTokens: 200000 }, featR,
      [{ status: 'done', branch: `camus/feat/${bid}/${b2}`, decisions: [] }])
    ok('F18b under budget → the next task runs', under.workflowCalls === 1 && under.res && under.res.status === 'done', under.res && under.res.status)
  }
  // F21 (VELOCITY §3 rule 1): an EXPLICIT posture is used verbatim — no recommendation agent,
  // forwarded to every loop, persisted, loud in the report, carried in resumeArgs.
  {
    const { res, calls, loopArgs, stateJSON } = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featBase,
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F21 explicit posture → forwarded, no rec agent', !!loopArgs[0] && loopArgs[0].posture === 'oneshot' && !calls.includes('posture-rec'), JSON.stringify(loopArgs[0] && loopArgs[0].posture))
    ok('F21 posture persisted + in the report header', !!stateJSON && stateJSON.posture === 'oneshot' && res.posture === 'oneshot')
    ok('F21 resumeArgs carries the EXPLICIT posture', !!stateJSON && stateJSON.resumeArgs.posture === 'oneshot')
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
      [{ status: 'done_with_findings', branch: 'camus/feat/x/only', decisions: [], findings: [finding], findingsDeferred: 1, resolution: 'fixed_unreviewed', commit_sha: 'c1' }])
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
  // F24 (audit P1 2026-06-11, the F14-style crash window for done_with_findings): the proof
  // persist carries the loop's REAL verdict, and BOTH resume lanes — auto-land and the
  // prior-merge-commit evidence path — restore it. Land mode only ever says plain done; without
  // the stash+restore, a death in the commit→merge window LAUNDERS review debt into done.
  {
    const finding = { priority: 1, title: 'laundered?', code_location: 'c.ts:3' }
    // (a) live run: the ready_to_merge MID-persist already carries provenStatus + findings.
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featBase,
      [{ status: 'done_with_findings', branch: 'camus/feat/x/only', decisions: [{ what: 'W', why: 'Y' }], findings: [finding], findingsDeferred: 1, resolution: 'fixed_unreviewed', commit_sha: 'c1' }])
    const mid = (r1.stateJSONs || [])
      .find((s) => s && s.tasks && s.tasks[0] && s.tasks[0].status === 'ready_to_merge')
    ok('F24a proof persist stashes provenStatus + findings BEFORE the merge',
      !!mid && mid.tasks[0].provenStatus === 'done_with_findings' && mid.tasks[0].findingsDeferred === 1 && JSON.stringify(mid.tasks[0].deferredFindings).includes('laundered'),
      mid && JSON.stringify(mid.tasks[0]))
    ok('F24a …and the proof\'s sha (publish audit round-2: the auto-land binds verify to it)',
      !!mid && mid.tasks[0].provenCommit === 'c1', mid && mid.tasks[0].provenCommit)
    // (b) crash BEFORE the merge → resume auto-lands (land returns plain done) → verdict restored.
    const tid = taskIdOf('F', ['only task'], 'only task')
    const prior = JSON.parse(JSON.stringify(r1.stateJSON))
    prior.status = 'running'
    prior.tasks[0] = { ...prior.tasks[0], status: 'ready_to_merge', provenStatus: 'done_with_findings', provenCommit: 'pr00f', findingsDeferred: 1, deferredFindings: [finding], decisions: [{ what: 'W', why: 'Y' }] }
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(prior) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: 'land1', landed: true, decisions: [] }])
    ok('F24b auto-land restores done_with_findings (never laundered to done)',
      !!r2.stateJSON && r2.stateJSON.tasks[0].status === 'done_with_findings' && r2.res && r2.res.status === 'done_with_findings',
      r2.stateJSON && r2.stateJSON.tasks[0].status + '/' + (r2.res && r2.res.status))
    ok('F24b findings + decisions survive the land (empty land decisions do not clobber)',
      !!r2.stateJSON && r2.stateJSON.tasks[0].findingsDeferred === 1 && JSON.stringify(r2.res.deferredFindings || []).includes('laundered') && r2.stateJSON.tasks[0].decisions.length === 1,
      r2.stateJSON && JSON.stringify(r2.stateJSON.tasks[0]))
    ok('F24b auto-land carries expectHead = the proven sha (publish audit round-2)',
      !!(r2.loopArgs[0] && r2.loopArgs[0].land === true && r2.loopArgs[0].expectHead === 'pr00f'), JSON.stringify(r2.loopArgs[0] && { land: r2.loopArgs[0].land, expectHead: r2.loopArgs[0].expectHead }))
    // (c) crash AFTER the merge → already-up-to-date + prior-merge-commit evidence → same restore.
    const upToDateMerge = { merged: true, committed: false, alreadyUpToDate: true, priorMergeCommit: 'deadbeef', before: 'aaa', after: 'aaa' }
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'], posture: 'oneshot' },
      { ...featResume, merge: upToDateMerge, 'merge-receipt': J(upToDateMerge), 'merge-head': upToDateMerge.after, 'integration-verify': J({ pass: true, failures: [], head: upToDateMerge.after }) },
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: 'land1', landed: true, decisions: [] }])
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
      [{ status: 'done', branch: `camus/feat/${fid}/${tid}`, commit_sha: 'land1', landed: true, decisions: [] }])
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
       { status: 'done', branch: 'camus/feat/x/only', commit_sha: 'land1', landed: true, decisions: [] }])
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
      { ...featBase, 'self-audit': 'b 2' },
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F28 unmerged completed work → self_audit_failed, never done', over.res && over.res.status === 'self_audit_failed', over.res && over.res.status)
    ok('F28 violation named with branch + count', !!over.res && Array.isArray(over.res.violations) && over.res.violations[0].unmergedCommits === 2 && over.res.violations[0].branch === 'b', JSON.stringify(over.res && over.res.violations))
    ok('F28c remedy names camus land, never state surgery', /camus land/.test((over.res && over.res.note) || ''), over.res && over.res.note)
    const clean = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'self-audit': 'b 0' },
      [{ status: 'done', branch: 'b', decisions: [] }])
    ok('F28b ancestry clean → done, audit logged', clean.res && clean.res.status === 'done', clean.res && clean.res.status)
  }
  {
    const bad = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, 'self-audit': 'I did not run git rev-list' },
      [{ status: 'done', branch: 'b', decisions: [] }])
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
  }
  // F20 (audit P1 2026-06-11): a merged pause+answers note must NOT lose its payload — the
  // boundary check consumed the file, so the engine re-queues the remainder (minus pause)
  // before halting; a pause-only note re-queues nothing.
  {
    const tid = taskIdOf('F', ['only task'], 'only task')
    const { res, calls, prompts } = await runFeat({ feat: 'F', tasks: ['only task'] },
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
    const { res, calls } = await runFeat({ feat: 'F', tasks: ['only task'] },
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
    ok('F13b resumeArgs persists land', !!fresh.stateJSON && JSON.stringify((fresh.stateJSON.resumeArgs || {}).land) === JSON.stringify([tid]), JSON.stringify(fresh.stateJSON && fresh.stateJSON.resumeArgs && fresh.stateJSON.resumeArgs.land))
    // (c) Run 1 halts verify-clean → persisted as needs_decision (the PROOF — since the
    // park-first reorder, with the PARKED sha riding the same persist)…
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: true, stuck: [], blocking: [], parkedSha: 'p4rk1234' }])
    ok('F13c prior halt persisted as needs_decision', !!r1.stateJSON && r1.stateJSON.tasks[0].status === 'needs_decision', r1.stateJSON && r1.stateJSON.tasks[0].status)
    ok('F37a needs_decision persist stashes provenCommit = the parked sha (publish audit round-3)',
      !!r1.stateJSON && r1.stateJSON.tasks[0].provenCommit === 'p4rk1234', r1.stateJSON && r1.stateJSON.tasks[0].provenCommit)
    // …(d) resume with land:[tid] → NOW authorized: land forwards, narration matches, feat lands+merges.
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(r1.stateJSON) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], land: [tid] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: 'land1', landed: true, decisions: [] }])
    ok('F13d proven needs_decision + land → land:true forwarded', !!(r2.loopArgs[0] && r2.loopArgs[0].land === true), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].land))
    ok('F37b accepted decision lands head-bound: expectHead = the parked sha, never the live tip',
      !!(r2.loopArgs[0] && r2.loopArgs[0].expectHead === 'p4rk1234'), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].expectHead))
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
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: 'c1', decisions: [] }])
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
      { 'land-resolve': J({ found: true, path: wtPath('t') }), commit: J({ committed: true, sha: 'land1' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'land1' }) })
    ok('F38b land-resolve is cd-prefixed under targetPath (identity resolves AT the target)',
      (r2.prompts['land-resolve'] || '').includes(cdp), (r2.prompts['land-resolve'] || '').slice(0, 200))
    ok('F38b …and still lands done', r2.res.status === 'done', r2.res.status)
    const r3 = await runLoop({ task: 't', land: true, targetPath: tp },
      { 'land-resolve': J({ found: false, path: null }), 'land-recreate': J({ ok: true, path: wtPath('t') }), commit: J({ committed: true, sha: 'land1' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'land1' }) })
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
    const lpGood = await runLoop({ task: 't' }, { ...cls, ...planOf('clear', ''), ...happyTail, verify: J({ pass: true, failures: [], head: 'abc123' }) })
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
    const { res, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: J({ read: true, note: J({ pause: true }) }) }, [])
    ok('F7 pause note → paused_by_user before the loop', res && res.status === 'paused_by_user', res && res.status)
    ok('F7 loop never invoked on pause', workflowCalls === 0, 'workflowCalls=' + workflowCalls)
  }
  {
    const { res, loopArgs } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: J({ read: true, note: J({ guidance: 'use adapter B' }) }) },
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
    const steerOnceThenPause = () => (++steerCalls === 1 ? J({ read: true, note: null }) : J({ read: true, note: J({ pause: true }) }))
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
    const steerNoteOnce = () => (++sc === 1 ? J({ read: true, note: J({ answers: { [bId]: 'pick B' } }) }) : J({ read: true, note: null }))
    const { loopArgs } = await runFeat({ feat: 'T2', tasks: ['a', 'b'] },
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
    const { res, stateJSON, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: J({ read: true, note: 'totally not json' }) },
      [{ status: 'done', branch: 'camus/feat/x/only', decisions: [] }])
    ok('F7f garbage note surfaced in run log', !!stateJSON && stateJSON.events.some((e) => /UNPARSEABLE/.test(e.msg)))
    ok('F7f run HALTS for the human (no silent drop)', res && res.status === 'needs_human' && res.stage === 'steer', res && (res.status + '/' + res.stage))
    ok('F7f no task dispatched past the dropped guidance', workflowCalls === 0, String(workflowCalls))
    ok('F7f note says nothing was applied + how to resume', /NOTHING was applied/.test((res && res.note) || '') && /re-run/i.test((res && res.note) || ''))
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
      fix: '', commit: J({ committed: true, sha: 'c1' }), prep: J({ prepped: true, ran: [] }),
      verify: J({ pass: true, failures: [], head: 'c1' }),
    }
    const clean = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: J({ ran: true, dirty: false, paths: '' }) })
    ok('F40 containment ran+clean → done', clean.res.status === 'done', clean.res.status)
    ok('F40 containment prompt routes through containment.sh (mechanical receipt)',
      (clean.prompts['containment:implement'] || '').includes('/containment.sh'))
    const breach = await runLoop({ task: 't', idSalt: salt }, { ...base, containment: J({ ran: true, dirty: true, paths: ' M leaked.ts' }) })
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
        park: J({ committed: true, sha: 'p' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [], head: 'p' }) })
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
    // feat: an agent-returned mergeBranch with $() is SINGLE-quoted in the merge command (inert)
    const tid = taskIdOf('F', ['only task'], 'only task')
    const fr = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'done', branch: 'camus/feat/x/$(whoami)', decisions: [] }])
    const mp = fr.prompts['merge:' + tid] || ''
    ok('F47c feat single-quotes an agent-returned mergeBranch (no $()-expand)',
      mp.includes("'camus/feat/x/$(whoami)'") && !mp.includes('"camus/feat/x/$(whoami)"'), mp.slice(0, 220))
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

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
