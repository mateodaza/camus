// ── A RESUME MAY NOT REGRESS A STRONGER PARKED CANDIDATE ─────────────────────────────────
// Production run 20260807-080214-p27e. Studio displayed Verify. The durable status record said
// `phase: Implement, round: 2`. The worktree was clean at 5c62c3c with two review receipts and three
// parked WP9 commits. The resume re-entered the gate: Plan restarted with `expectedRound: 1`, the
// repeated planner preferred a "minimal scope" default and recommended DUPLICATING the packer's
// SourceFacesLeft list, and the implementer began reasoning toward deleting the live binding that
// commit bb58ce4 had deliberately introduced. A resume was one step from undoing an audited
// strengthening.
//
// The follow-up audit (2026-08-07) found three more holes in the first fix, each pinned here:
//   · the continuation never reached the UI (a scoped-out `meta` threw, the catch swallowed it,
//     and the client closed its stream at the stored terminal status before replay_end anyway)
//   · receipt COUNTING trusted filenames — one `ran:false` `-r99.json` yielded round 99 and
//     provenance `reviewed`
//   · the recorded branch was never enforced, and the moved-tip check compared HEAD with itself
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { deriveContinuation, continuationPresentation } = await import('./lib/continuation.mjs');
const { gatherContinuationEvidence, gitProbe } = await import('./lib/code-lane.mjs');
const { recoveryAction } = await import('./public/run-ui-policy.mjs');

// ── THE FIXTURE: the WP9 state, on disk ───────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'cls-resume-'));
const REPO = join(ROOT, 'game-repo');
mkdirSync(REPO, { recursive: true });
const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
g(REPO, 'init', '-q', '-b', 'main');
g(REPO, 'config', 'user.email', 't@e.com');
g(REPO, 'config', 'user.name', 't');

// THE STRONGER BINDING A FRESH PLANNER WOULD PREFER TO REPLACE. The live source reads the packer's
// own list; the weaker alternative a "minimal scope" plan reaches for is a local copy of it.
writeFileSync(join(REPO, 'MirrorCheck.cs'), [
  'public sealed class MirrorCheck {',
  '  // bb58ce4: bound to the real packer list, NOT a copy. Duplicating this list is the regression.',
  '  public MirrorCheck(Packer packer) { this.sourceFacesLeft = packer.SourceFacesLeft; }',
  '  private readonly IReadOnlyList<Face> sourceFacesLeft;',
  '}',
  '',
].join('\n'));
writeFileSync(join(REPO, 'probe.test.mjs'), "console.log('probe ok');\n");
g(REPO, 'add', '-A');
g(REPO, 'commit', '-qm', 'baseline');

const WT = join(ROOT, 'camus-wt-implement-only-wp9-author-the-rat-golem--1oriix');
const BRANCH = 'camus/implement-only-wp9-author-the-rat-golem--1oriix';
g(REPO, 'worktree', 'add', '-q', '-b', BRANCH, WT);
// THREE PARKED COMMITS, the last of them the audited strengthening.
for (const [file, body, msg] of [
  ['RatGolem.cs', 'public class RatGolem {}\n', 'feat: WP9 rat/golem monsters'],
  ['Wasp.cs', 'public class Wasp {}\n', 'feat: WP9 wasp'],
  ['MirrorCheck.cs', readFileSync(join(REPO, 'MirrorCheck.cs'), 'utf8').replace('// bb58ce4:', '// bb58ce4 (audited):'),
    'fix: bind mirror check to real packer SourceFacesLeft, not a copy'],
]) {
  writeFileSync(join(WT, file), body);
  g(WT, 'add', '-A');
  g(WT, 'commit', '-qm', msg);
}
const HEAD = g(WT, 'rev-parse', 'HEAD').stdout.trim();
assert.equal(g(WT, 'status', '--porcelain').stdout.trim(), '', 'the fixture worktree is clean, as the real one is');

const SALT = 'studio-20260806-110809-2r9j';
const PREFIX = 'camus-wt-implement-only-wp9-author-the-rat-golem--1oriix';

// r1 + r2 RECEIPTS, production-shaped: parseable, ran:true, naming THIS worktree, BOUND to this
// run's identity salt, round-coherent. Anything less no longer counts — that is the point.
const REVIEWS = join(ROOT, 'reviews');
mkdirSync(REVIEWS, { recursive: true });
const boundReceipt = (round, overrides = {}) => JSON.stringify({
  worktree: WT, worktree_canonical: WT, round, ran: true, reviewer_model: 'gpt-5.6-sol',
  codex_parsed: { findings: [{ priority: 2, title: `f${round}` }], overall_correctness: 'patch is incorrect' },
  binding: { gate_nonce: `${SALT}:x1y2`, round_requested: round, round_actual: round,
    effort_requested: 'low', effort_actual: 'low', reviewer_model: 'gpt-5.6-sol', reviewer_backend: 'codex', bound: true },
  ...overrides,
});
for (const round of [1, 2]) writeFileSync(join(REVIEWS, `${PREFIX}-r${round}.json`), boundReceipt(round));

// The durable status record the gate wrote, verbatim in shape — INCLUDING the branch.
const FEATS = join(ROOT, 'feats');
mkdirSync(FEATS, { recursive: true });
writeFileSync(join(FEATS, `${SALT}.status.json`), JSON.stringify({
  schema_version: 1, nonce: `${SALT}:x1y2`, phase: 'Implement', round: '2',
  worktree: WT, branch: BRANCH, effort: 'low',
  created_at: 1786000000, updated_at: 1786000900, last_progress_at: 1786000900,
}));
process.env.CAMUS_FEATS_DIR = FEATS;

const META = { id: '20260807-080214-p27e', lane: 'build', idSalt: SALT, targetPath: REPO, verifyCmd: 'node probe.test.mjs' };

// ── THE EVIDENCE, GATHERED FROM DISK ──────────────────────────────────────────────────────
const evidence = await gatherContinuationEvidence(META, { probe: gitProbe, reviewsDir: REVIEWS });
console.log('--- durable evidence ---');
console.log('status  :', evidence.status?.phase, 'round', evidence.status?.round, 'branch', evidence.status?.branch);
console.log('worktree:', evidence.worktree?.head?.slice(0, 12), 'dirty', evidence.worktree?.dirty, 'ahead', evidence.worktree?.commitsAhead, 'branch', evidence.worktree?.branch);
console.log('receipts:', evidence.receipts.map((r) => `r${r.round}`).join(','));

assert.equal(evidence.status?.phase, 'implement', 'the durable status is read, not guessed');
assert.equal(evidence.status?.round, 2, 'including its round');
assert.equal(evidence.status?.branch, BRANCH, 'and its recorded branch');
assert.equal(evidence.worktree?.head, HEAD, 'the worktree HEAD is measured');
assert.equal(evidence.worktree?.dirty, false, 'and its cleanliness');
assert.equal(evidence.worktree?.branch, BRANCH, 'and its live branch');
assert.equal(evidence.worktree?.commitsAhead, 3, 'three parked commits, as in the live run');
assert.deepEqual(evidence.receipts.map((r) => r.round), [1, 2], 'both bound receipts are admitted');
assert.equal(evidence.recordedSha, null, 'the WP9-era shape sealed no candidate sha — and says so');

// ── RECEIPT HYGIENE: A FILENAME IS A CLAIM, NOT EVIDENCE ──────────────────────────────────
// The exact audit reproduction first: one hand-dropped `ran:false` file pushed round to 99 and
// provenance to `reviewed`. Every one of these must be left out of the count.
{
  const drop = (name, content) => writeFileSync(join(REVIEWS, name), content);
  drop(`${PREFIX}-r99.json`, boundReceipt(99, { ran: false }));                        // the repro
  drop(`${PREFIX}-r7.json`, '{ this is not json');                                      // invalid JSON
  drop(`${PREFIX}-r8.json`, boundReceipt(8, { worktree: '/somewhere/else', worktree_canonical: '/somewhere/else' })); // foreign worktree
  drop(`${PREFIX}-r9.json`, (() => { const o = JSON.parse(boundReceipt(9)); delete o.binding; return JSON.stringify(o); })()); // unbound
  drop(`${PREFIX}-r11.json`, boundReceipt(11, { binding: { gate_nonce: 'studio-someone-else:zz', round_actual: 11, bound: true } })); // wrong identity
  drop(`${PREFIX}-r12.json`, boundReceipt(4));                                          // filename says 12, body says 4
  // "merely touched after the commit": a valid receipt whose mtime is pushed into the future must
  // change NOTHING — mtimes are no longer collected at all.
  const now = Date.now() / 1000 + 9999;
  utimesSync(join(REVIEWS, `${PREFIX}-r2.json`), now, now);

  const hardened = await gatherContinuationEvidence(META, { probe: gitProbe, reviewsDir: REVIEWS });
  assert.deepEqual(hardened.receipts.map((r) => r.round), [1, 2],
    'only the two valid, bound, worktree-matching, round-coherent receipts are admitted');
  const p = deriveContinuation(hardened);
  assert.equal(p.round, 2, 'the round is 2 — a ran:false r99 filename cannot inflate it');
  assert.notEqual(p.provenance, 'reviewed', 'and nothing on this disk can fabricate reviewed provenance');
  assert.equal(p.provenance, 'fixed_unreviewed', 'the handoff fails closed to fixed_unreviewed');
}

// ── THE ONE ANSWER, on the clean evidence ─────────────────────────────────────────────────
const plan = deriveContinuation(evidence);
console.log('--- continuation ---');
console.log('action     :', plan.action, '| phase:', plan.phase, '| round:', plan.round, '| provenance:', plan.provenance);

assert.equal(plan.action, 'verify_only', 'the continuation is verification in place, never the gate');
assert.equal(plan.spawnsModels, false, 'no model turn — so no planner and no implementer can run');
assert.notEqual(plan.phase, 'plan', 'Plan is not the continuation');
assert.notEqual(plan.phase, 'implement', 'and neither is Implement');
assert.equal(plan.phase, 'verify', 'the continuation phase is Verify');
assert.equal(plan.round, 2, 'the round carries forward from durable evidence; it does not reset to 1');
// NEVER `reviewed` without an exact candidate-content binding — which no current receipt seals.
assert.equal(plan.provenance, 'fixed_unreviewed', 'legacy receipts fail closed to fixed_unreviewed');
assert.match(plan.reason, /not re-planning work that exists/, 'the reason states what it is refusing to do');
// HONESTY ABOUT THE ANCHOR: nothing recorded an earlier HEAD, so the reason must say this is an
// adopted clean HEAD — and must NOT claim tip movement was ruled out.
assert.match(plan.reason, /ADOPTED clean worktree HEAD/, 'the sha is named as adopted');
assert.match(plan.reason, /tip movement cannot be ruled out/, 'and the unknowable is stated, not waved away');

// HEAD and porcelain remain unchanged — deriving a continuation must not touch the repository.
assert.equal(g(WT, 'rev-parse', 'HEAD').stdout.trim(), HEAD, 'HEAD is unchanged by classification');
assert.equal(g(WT, 'status', '--porcelain').stdout.trim(), '', 'the worktree is still clean');
const mirror = g(WT, 'show', `${BRANCH}:MirrorCheck.cs`).stdout;
assert.match(mirror, /packer\.SourceFacesLeft/, 'the live binding survives');
assert.ok(!/new List<Face>\(packer\.SourceFacesLeft\)/.test(mirror), 'and was not replaced by a copy');

// ── THE RECORDED BRANCH IS ENFORCED, ON REAL GATHERED EVIDENCE ────────────────────────────
// A second on-disk fixture: the durable record says one branch, the worktree sits on another.
{
  const SALT2 = 'studio-branch-mismatch-probe';
  const WT2 = join(ROOT, 'camus-wt-branch-mismatch-probe');
  g(REPO, 'worktree', 'add', '-q', '-b', 'camus/branch-mismatch-probe', WT2);
  writeFileSync(join(WT2, 'x.cs'), 'class X {}\n');
  g(WT2, 'add', '-A');
  g(WT2, 'commit', '-qm', 'candidate');
  // The operator (or anything else) moved it off the recorded branch.
  g(WT2, 'checkout', '-q', '-b', 'other/branch');
  writeFileSync(join(FEATS, 'studio-branch-mismatch-probe.status.json'), JSON.stringify({
    schema_version: 1, nonce: `${SALT2}:aa`, phase: 'Implement', round: '1',
    worktree: WT2, branch: 'camus/branch-mismatch-probe', effort: 'low',
    created_at: 1786000000, updated_at: 1786000900, last_progress_at: 1786000900,
  }));
  const ev2 = await gatherContinuationEvidence({ id: 'bm', lane: 'build', idSalt: SALT2 }, { probe: gitProbe, reviewsDir: REVIEWS });
  assert.equal(ev2.status?.branch, 'camus/branch-mismatch-probe', 'the record names the gate\'s branch');
  assert.equal(ev2.worktree?.branch, 'other/branch', 'the measurement names the live one');
  const p2 = deriveContinuation(ev2);
  assert.equal(p2.action, 'refuse', 'a recorded/measured branch mismatch REFUSES on real gathered evidence');
  assert.match(p2.reason, /camus\/branch-mismatch-probe/, 'naming the recorded branch');
  assert.match(p2.reason, /other\/branch/, 'and the live one');
  assert.equal(continuationPresentation(p2).canResume, false, 'and is not presented as resumable');
}

// ── RECORDED-SHA HONESTY ──────────────────────────────────────────────────────────────────
{
  // A durably recorded candidate sha that disagrees with HEAD refuses — the REAL moved-tip check,
  // possible only because the sha comes from a record, not from measuring HEAD against itself.
  const moved = deriveContinuation({ ...evidence, recordedSha: 'a'.repeat(40) });
  assert.equal(moved.action, 'refuse', 'a moved tip is refused when a record exists to prove it');
  assert.match(moved.reason, /branch moved since it was parked/);
  // And when a record EXISTS and matches, the reason claims the record — not adoption.
  const sealed = deriveContinuation({ ...evidence, recordedSha: HEAD });
  assert.equal(sealed.action, 'verify_only');
  assert.match(sealed.reason, /durably recorded candidate/, 'a matching record is claimed as a record');
  assert.ok(!/cannot be ruled out/.test(sealed.reason), 'with no unknowability caveat, because none applies');
}

// ── THE UI SHOWS THE SAME ANSWER ──────────────────────────────────────────────────────────
const presentation = continuationPresentation(plan);
const shown = recoveryAction('incomplete', { ...plan, presentation });
assert.equal(shown.mode, 'verify_only', 'the control routes to the same lane the server will take');
assert.equal(shown.phase, plan.phase, 'the displayed phase IS the server\'s continuation phase');
assert.equal(shown.round, plan.round, 'and the displayed round is the same one');
assert.match(shown.button, /Verify/, 'the button offers verification');
assert.ok(!/planning|implementation/i.test(shown.button), 'never a gate rerun');
assert.match(shown.note, /No planning or implementation runs/, 'and says so explicitly');
assert.match(shown.note, /fixed_unreviewed/, 'and carries the unproven-review caveat');
assert.equal(recoveryAction('needs_decision', null).mode, 'verify_only', 'the legacy fallback survives');
assert.match(recoveryAction('incomplete', null).button, /Resume the gate/, 'and so does its gate wording');

// ── CONTRADICTORY OR UNRELIABLE PROVENANCE REFUSES, NEVER RESTARTS PLAN ───────────────────
{
  const dirty = deriveContinuation({ ...evidence, worktree: { ...evidence.worktree, dirty: true } });
  assert.equal(dirty.action, 'refuse', 'a dirty worktree refuses');
  const gone = deriveContinuation({ ...evidence, worktree: null });
  assert.equal(gone.action, 'refuse', 'receipts with no worktree refuse');
  const empty = deriveContinuation({ status: evidence.status, worktree: null, receipts: [], recordedSha: null });
  assert.equal(empty.action, 'refuse', 'a status claiming progress with no artifacts refuses');
  assert.match(empty.reason, /contradicts itself/);
  // A SEALED terminal that parked a candidate over an empty disk is the same contradiction — the
  // browser negative control caught this shape being offered "Run the gate" (2026-08-07).
  const sealedGone = deriveContinuation({ status: null, worktree: null, receipts: [], recordedSha: null, sealedStatus: 'needs_decision' });
  assert.equal(sealedGone.action, 'refuse', 'a sealed needs_decision with nothing findable refuses');
  assert.match(sealedGone.reason, /candidate existed/);
  const sealedFresh = deriveContinuation({ status: null, worktree: null, receipts: [], recordedSha: null, sealedStatus: 'failed' });
  assert.equal(sealedFresh.action, 'gate', 'a sealed failure that never parked anything may still re-enter the gate');
  const noCommit = deriveContinuation({ ...evidence, worktree: { ...evidence.worktree, commitsAhead: 0 } });
  assert.equal(noCommit.action, 'refuse', 'receipts over an empty branch refuse');
  for (const r of [dirty, gone, empty, noCommit]) {
    const p = continuationPresentation(r);
    assert.equal(p.canResume, false, 'a refusal is not resumable');
    assert.notEqual(p.phase, 'plan', 'and never presents Plan as the next step');
  }
}

// ── FRESH RUNS ARE UNCHANGED ──────────────────────────────────────────────────────────────
{
  const fresh = deriveContinuation({ status: null, worktree: null, receipts: [], recordedSha: null });
  assert.equal(fresh.action, 'gate', 'with nothing built, the gate may run');
  assert.equal(fresh.phase, 'plan', 'starting at Plan');
  assert.equal(fresh.spawnsModels, true);
  const scaffolded = deriveContinuation({
    status: { phase: 'implement', round: null }, receipts: [],
    worktree: { path: '/w', head: 'b'.repeat(40), dirty: false, commitsAhead: 0 }, recordedSha: null,
  });
  assert.equal(scaffolded.action, 'gate', 'an empty branch may be planned');
}

// ── THE REAL WIRE: THE CLASSIFICATION REACHES THE BROWSER BEFORE IT CAN RENDER ────────────
// The first fix was asserted with source regexes and never actually arrived: `meta` was scoped
// inside another try-block, the ReferenceError was swallowed, and every live replay ended
// `continuation: null` — and the client had already closed at the stored terminal status anyway.
// So this spawns the REAL server and reads the REAL SSE stream.
{
  const RUNS = join(ROOT, 'runs');
  const RUN_ID = 'sse-continuation-probe';
  mkdirSync(join(RUNS, RUN_ID), { recursive: true });
  const meta = {
    id: RUN_ID, lane: 'build', idSalt: SALT, targetPath: REPO, verifyCmd: 'node probe.test.mjs',
    goal: 'WP9 probe', acceptanceContract: 'c', status: 'incomplete', report: { worktree: WT },
  };
  writeFileSync(join(RUNS, RUN_ID, 'report.json'), JSON.stringify(meta));
  writeFileSync(join(RUNS, RUN_ID, 'run.json'), JSON.stringify(meta));
  // The stored stream ends with the terminal status event — the exact frame the browser closes on.
  writeFileSync(join(RUNS, RUN_ID, 'events.jsonl'), [
    JSON.stringify({ type: 'run', run: { id: RUN_ID, goal: 'WP9 probe', lane: 'build', engine: 'live' } }),
    JSON.stringify({ type: 'log', line: 'Igniting the camus gate' }),
    JSON.stringify({ type: 'status', status: 'needs_decision', headline: null, at: 1786000902000 }),
    '',
  ].join('\n'));

  const srv = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, OPEN: '0', PORT: '0', ENGINE: 'live', STUDIO_RUNS_DIR: RUNS,
      CAMUS_FEATS_DIR: FEATS, CAMUS_REVIEW_DIR: REVIEWS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let base = '';
  let serverOutput = '';
  for await (const chunk of srv.stdout) {
    // stdout is a byte stream, not a line protocol: the URL can be split across
    // chunks (observed as `http://local` + `host:<port>` in the registered suite).
    serverOutput += String(chunk);
    const m = serverOutput.match(/http:\/\/localhost:(\d+)/);
    if (m) { base = `http://127.0.0.1:${m[1]}`; break; }
  }
  try {
    assert.ok(base, `the probe server announced a usable URL (stdout: ${serverOutput})`);
    const res = await fetch(`${base}/api/runs/${RUN_ID}/events`, { headers: { origin: base } });
    const text = await res.text();
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
    const startIdx = frames.findIndex((f) => f.type === 'replay_start');
    const statusIdx = frames.findIndex((f) => f.type === 'status');
    const start = frames[startIdx];
    console.log('--- SSE wire ---');
    console.log('frames        :', frames.map((f) => f.type).join(' → '));
    console.log('continuation  :', start?.continuation?.action, '/', start?.continuation?.presentation?.actionLabel);
    assert.ok(startIdx >= 0 && statusIdx > startIdx, 'replay_start precedes the stored terminal status frame');
    assert.ok(start.continuation, 'the classification is ON THE WIRE, not null');
    assert.equal(start.continuation.action, 'verify_only', 'and it is the verify-in-place answer');
    assert.equal(start.continuation.round, 2, 'carrying round 2, not 1');
    assert.equal(start.continuation.provenance, 'fixed_unreviewed', 'with fail-closed provenance');
    assert.equal(start.continuation.presentation?.actionLabel, 'Verify and hand back',
      'and the label the browser will put on the button');
    const end = frames.find((f) => f.type === 'replay_end');
    assert.ok(end?.continuation, 'replay_end still carries it as the belt');
  } finally {
    srv.kill('SIGKILL');
    await once(srv, 'close').catch(() => {});
  }
}

// ── THE CLIENT CONSUMES IT WHERE IT CAN STILL ACT ─────────────────────────────────────────
// The stored terminal status event closes the EventSource and renders the recovery control, so the
// classification must be consumed from replay_start. Pinned on the shipped source alongside the
// wire test above — the wire proves arrival, this proves the arrival point is used.
{
  const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  const replayStart = (app.match(/case 'replay_start':[\s\S]*?break;/) || [''])[0];
  assert.match(replayStart, /state\.continuation = ev\.continuation/, 'replay_start is where the client takes it');
  assert.match(app, /recoveryAction\(status, continuation\)/, 'and the control renders that answer');
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(server, /type: 'replay_start', live: false, continuation/, 'the server sends it on replay_start');
  const resumeBody = server.slice(server.indexOf('const contEvidence = await gatherContinuationEvidence(meta)'));
  assert.match(resumeBody, /continuation\.action === 'refuse'/, 'the resume route honours a refusal');
  assert.match(resumeBody, /continuation\.action !== 'gate'/, 'and guards the gate fall-through');
  assert.match(resumeBody, /branch: contEvidence\.status\?\.branch/, 'adoption carries the recorded branch into the target checks');
}

console.log('resume.test: all assertions passed');
