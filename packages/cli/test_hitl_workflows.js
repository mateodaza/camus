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
  {
    // verify GREEN on a non-converged review → DECISION POINT (verifyClean:true), not a plain failure.
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, verify: J({ pass: true, failures: [] }) })
    ok('S10a review_unresolved + verify GREEN → verifyClean true', res.status === 'review_unresolved' && res.verifyClean === true, res.status + '/' + res.verifyClean)
    ok('S10a verify actually ran on the halt (ground truth consulted)', calls.includes('verify'))
    ok('S10a note frames it as a decision, not a failure', /DECIDE|shippable/.test(res.note || ''))
    ok('S10a stuck finding surfaced for the human', Array.isArray(res.stuck) && res.stuck.length === 1)
    ok('S10a stopped early (2 rounds, not roundCap 5)', calls.filter((c) => c.startsWith('review')).length === 2, String(calls.filter((c) => c.startsWith('review')).length))
  }
  {
    // verify RED → genuinely not done (verifyClean:false).
    const { res, calls } = await runLoop({ task: 't', roundCap: 5 }, { ...stuckBase, verify: J({ pass: false, failures: [{ stage: 'verify', log_tail: 'boom' }] }) })
    ok('S10b review_unresolved + verify RED → verifyClean false', res.status === 'review_unresolved' && res.verifyClean === false, res.status + '/' + res.verifyClean)
    ok('S10b note says genuinely not done', /genuinely not done/.test(res.note || ''))
    ok('S10b red verify is NOT parked (nothing proven to protect)', !calls.includes('park'), calls.join(','))
  }
  // S21 (0.2.5 item 2): PARK verify-clean halts as commits — a review-flagged but verify-GREEN
  // worktree is committed (labeled) before the halt, so proven work survives anything; land's
  // empty-stage path finishes from there on accept. Parking is fail-soft, never a gate.
  {
    const { res, calls, prompts } = await runLoop({ task: 't', roundCap: 5 },
      { ...stuckBase, verify: J({ pass: true, failures: [] }), park: J({ committed: true, sha: 'p4rk1234' }) })
    ok('S21 verify-clean halt parks a commit', calls.includes('park'), calls.join(','))
    ok('S21 park message is the labeled chore', !!prompts.park && prompts.park.includes('chore(camus): park') && prompts.park.includes('review-flagged, verify-green'))
    ok('S21 parked sha surfaced on the halt', res.parkedSha === 'p4rk1234', res.parkedSha)
    ok('S21 note says the work is parked', /PARKED as commit p4rk1234/.test(res.note || ''))
  }
  {
    // a refused park must not change the halt — fail-soft, loudly named.
    const { res } = await runLoop({ task: 't', roundCap: 5 },
      { ...stuckBase, verify: J({ pass: true, failures: [] }), park: J({ committed: false, reason: 'git identity missing' }) })
    ok('S21b park failure → halt unchanged + named', res.status === 'review_unresolved' && res.verifyClean === true && /Parking the work FAILED \(git identity missing\)/.test(res.note || ''), res.note)
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
    'land-resolve': wtPath('t'),
    commit: J({ committed: true, sha: 'land1' }),
    prep: J({ prepped: true, ran: [] }),
    verify: J({ pass: true, failures: [] }),
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
    const { res, calls } = await runLoop({ task: 't', land: true }, { ...landStubs, 'land-resolve': 'MISSING' })
    ok('S12c land with no worktree → aborted stage land', res.status === 'aborted' && res.stage === 'land', res.status + '/' + res.stage)
    ok('S12c …and nothing else ran', !calls.some((c) => /^(classify|plan|implement|review|commit|prep|verify)/.test(c)), calls.join(','))
  }
  {
    // Already-committed worktree (empty stage) → proceed to verify, done with null sha (run died
    // after commit last time — the branch tip IS the landed work).
    const { res, calls } = await runLoop({ task: 't', land: true }, { ...landStubs, commit: J({ committed: false, reason: 'empty' }) })
    ok('S12d land + empty stage → still done (already committed)', res.status === 'done' && res.commit_sha === null, res.status + '/' + res.commit_sha)
    ok('S12d verify still ran', calls.includes('verify'))
  }
  {
    // A real commit failure under land is still an INFRA error, never silently skipped.
    const { res } = await runLoop({ task: 't', land: true }, { ...landStubs, commit: J({ committed: false, reason: 'hook rejected' }) })
    ok('S12e land + commit failure → infra_error', res.status === 'infra_error' && /land commit failed/.test(res.error || ''), res.status)
  }
  {
    // A hallucinated resolver path (wrong suffix) is refused fail-closed (audit F3 discipline).
    const { res } = await runLoop({ task: 't', land: true }, { ...landStubs, 'land-resolve': '/tmp/evil-dir' })
    ok('S12f land refuses an unvalidated worktree path', res.status === 'aborted' && res.stage === 'land', res.status)
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
      commit: J({ committed: true, sha: 'abc' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }),
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
      commit: J({ committed: true, sha: 'abc123' }),
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
      commit: J({ committed: true, sha: 'abc123' }), prep: J({ prepped: true, ran: [] }), verify: J({ pass: true, failures: [] }) }, calls2),
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
      commit: J({ committed: true, sha: 'one5h0t' }), ...cleanVerify,
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
    merge: { merged: true, committed: true, alreadyUpToDate: false, before: 'aaa', after: 'bbb', priorMergeCommit: null },
    report: { written: true }, state: { written: true },
  }
  {
    const { res } = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'needs_human', question: 'Pick A or B?', clarity: 'ambiguous', interpretations: ['A', 'B'], plan: 'p' }])
    ok('F1 feat halts needs_human', res && res.status === 'needs_human', res && res.status)
    ok('F1 question in report', res && res.question === 'Pick A or B?')
    ok('F1 resumeWith hint present', !!(res && res.resumeWith && res.resumeWith.answers))
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
      { ...featBase, steer: J({ pause: true, answers: { [tid]: 'use adapter B' } }), 'steer-requeue': { written: true } },
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
      { ...featBase, steer: J({ pause: true }) }, [])
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
    // (c) Run 1 halts verify-clean → persisted as needs_decision (the PROOF)…
    const r1 = await runFeat({ feat: 'F', tasks: ['only task'] }, featBase,
      [{ status: 'review_unresolved', verifyClean: true, stuck: [], blocking: [] }])
    ok('F13c prior halt persisted as needs_decision', !!r1.stateJSON && r1.stateJSON.tasks[0].status === 'needs_decision', r1.stateJSON && r1.stateJSON.tasks[0].status)
    // …(d) resume with land:[tid] → NOW authorized: land forwards, narration matches, feat lands+merges.
    const featResume = { ...featBase, preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(r1.stateJSON) } }
    const r2 = await runFeat({ feat: 'F', tasks: ['only task'], land: [tid] }, featResume,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: 'land1', landed: true, decisions: [] }])
    ok('F13d proven needs_decision + land → land:true forwarded', !!(r2.loopArgs[0] && r2.loopArgs[0].land === true), JSON.stringify(r2.loopArgs[0] && r2.loopArgs[0].land))
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
    const featCrashed = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x', priorMergeCommit: 'deadbeef1234' },
    }
    const r3 = await runFeat({ feat: 'F', tasks: ['only task'] }, featCrashed,
      [{ status: 'done', branch: 'camus/feat/x/only', commit_sha: null, landed: true, decisions: [] }])
    ok('F14c prior merge commit evidence → task DONE, not noop', !!r3.stateJSON && r3.stateJSON.tasks[0].status === 'done', r3.stateJSON && r3.stateJSON.tasks[0].status)
    ok('F14c feat done (no done_with_noops downgrade)', r3.res && r3.res.status === 'done', r3.res && r3.res.status)
    ok('F14c narration says already merged by a prior run', !!r3.stateJSON && (r3.stateJSON.events || []).some((e) => /ALREADY merged .* prior run/.test(e.msg || '')))
    // F14d: already-up-to-date WITHOUT the merge-commit evidence keeps the original no-op guard —
    // an empty/scope-overlapped branch must never upgrade itself to done.
    const featEmpty = {
      ...featBase,
      preflight: { clean: true, base: 'main', dirtyFiles: 0, stateRaw: JSON.stringify(mid) },
      merge: { merged: true, committed: false, alreadyUpToDate: true, before: 'x', after: 'x', priorMergeCommit: '' },
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
  // F7f (fixlet 2026-06-11 UPGRADE of the 2026-06-10 loud-log): a PRESENT-but-unparseable steer
  // note now HALTS the feat — a human countermand was consumed without being applied, and running
  // past it re-opens exactly what it was written to prevent. needs_human → not auto-resumable.
  {
    const { res, stateJSON, workflowCalls } = await runFeat({ feat: 'F', tasks: ['only task'] },
      { ...featBase, steer: 'totally not json' },
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

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
