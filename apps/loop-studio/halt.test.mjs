// ── RECEIPT-REFUSAL TERMINATION, PROVEN AGAINST REAL PROCESSES ────────────────────────
// A refused receipt used to set a flag and return from the poll: the Claude/workflow child kept
// running, Studio waited for it, and only then overrode the result — which is why a rejected WP9
// receipt was still followed by fix, verify and a commit (live run 20260806-110809-2r9j).
//
// This drives the REAL igniter seam (`runCodeLoop` spawning `claude` from PATH) through the REAL
// two-turn async shape:
//   turn 1  reads its own `-p` prompt, emits a custody-valid Workflow tool_use carrying exactly
//           the args it was handed, returns the "no readable status" async shape and closes
//           normally → one legitimate reattach;
//   turn 2  emits the bound Workflow resume, publishes a bound r1 then an INVALID r2, and would
//           — after eight seconds — write a mutation marker and emit later fix/commit/verify.
//           Its SIGTERM handler exits 0, so the refused child also returns the async shape, which
//           makes `!receiptViolation` the ONLY thing preventing a third turn.
//
// The detached reviewer is launched by THIS process, not by the fake Claude, so terminating the
// igniter cannot reach it: only `abortOwnedReviewers` can. That is what makes the cleanup
// assertion load-bearing (an earlier version launched it from the stub shell, where it died
// unaided and the assertion proved nothing).
//
// The fixture runs in its own Node process because code-lane.mjs captures CAMUS_REVIEW_DIR at
// module load, and this must never touch the operator's real ~/.camus/reviews.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── The fixture, run in the child process ────────────────────────────────────────────
if (process.env.CLS_HALT_CHILD === '1') {
  const ROOT = process.env.CLS_HALT_ROOT;
  const WT = join(ROOT, 'camus-wt-halt-probe');
  const { runCodeLoop } = await import(join(HERE, 'lib', 'code-lane.mjs'));
  const events = [];
  const res = await runCodeLoop(
    { id: 'halt-probe', goal: 'g', acceptanceContract: 'c', lane: 'build', targetPath: WT, idSalt: 'studio-halt-probe',
      models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.6-terra', effort: 'medium' }, loop: { roundCap: 3 } } },
    { emit: (t, d) => events.push({ t, ...d }), waitForAnswer: async () => 'Leave the candidate parked and stop here',
      signal: { aborted: false, addEventListener() {}, removeEventListener() {} } },
  );
  writeFileSync(join(ROOT, 'out.json'), JSON.stringify({
    status: res.status, report: res.report ?? null,
    logs: events.filter((e) => e.t === 'log').map((e) => e.line),
  }));
  process.exit(0);
}

// ── The harness ──────────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'cls-halt-'));
const REVIEWS = join(ROOT, 'reviews');
const WT = join(ROOT, 'camus-wt-halt-probe');
const MARKER = join(ROOT, 'MUTATED');
const TURNS = join(ROOT, 'igniter_turns');       // one line per real `claude` process
const PREFIX = 'camus-wt-halt-probe';
mkdirSync(REVIEWS, { recursive: true });
mkdirSync(WT, { recursive: true });
mkdirSync(join(ROOT, 'feats'), { recursive: true });
const git = (...a) => spawnSync('git', ['-C', WT, ...a], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@e.com');
git('config', 'user.name', 't');
writeFileSync(join(WT, 'a.txt'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'one');

const NONCE = 'studio-halt-probe:abc';
const MODEL = 'gpt-5.6-terra';
const EFFORT = 'medium';
const receipt = (round, bound) => JSON.stringify({
  worktree: WT, worktree_canonical: WT, round, ran: true, reviewer_model: MODEL, reviewer_effort: EFFORT,
  codex_parsed: { findings: [{ priority: 1, title: `f${round}`, code_location: 'a.txt:1' }], overall_correctness: 'patch is incorrect' },
  ...(bound ? { binding: { gate_nonce: NONCE, round_requested: round, round_actual: round, effort_requested: EFFORT, effort_actual: EFFORT, reviewer_model: MODEL, reviewer_backend: 'codex', bound: true } } : {}),
});

// ── The fake `claude`: a Node executable that derives the expected Workflow args from its own
// argv, so its tool calls satisfy the real custody guard byte-for-byte.
const bin = join(ROOT, 'bin');
mkdirSync(bin, { recursive: true });
const fake = join(bin, 'claude');
const SESSION = '3f9b1c2e-7a41-4d8b-9c05-6e2f1a8b4d77';
writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const ROOT = ${JSON.stringify(ROOT)};
const REVIEWS = ${JSON.stringify(REVIEWS)};
const PREFIX = ${JSON.stringify(PREFIX)};
const MARKER = ${JSON.stringify(MARKER)};
const SESSION = ${JSON.stringify(SESSION)};
const ARGS_FILE = ROOT + '/expected_args.json';
const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch { /* pipe gone */ } };
appendFileSync(ROOT + '/igniter_turns', 'turn\\n');
const argv = process.argv.slice(2);

if (!argv.includes('--resume')) {
  // TURN 1. The prompt is exactly \`/camus-loop <JSON>\`; that JSON IS the workflow args, so
  // echoing it back is precisely what a real Claude would call Workflow with.
  const pIdx = argv.indexOf('-p');
  const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? '') : '';
  const jsonStart = prompt.indexOf('{');
  const rawArgs = jsonStart >= 0 ? prompt.slice(jsonStart) : '{}';
  writeFileSync(ARGS_FILE, rawArgs);
  say({ type: 'system', subtype: 'init', session_id: SESSION });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow',
    input: { name: 'camus-loop', args: JSON.parse(rawArgs) } }] } });
  // No readable terminal status → exactly one legitimate reattach.
  say({ type: 'result', subtype: 'success', session_id: SESSION,
    result: 'the workflow is still running asynchronously' });
  process.exit(0);
}

// TURN 2: the reattach child. Its resume call is bound to one fixed run id.
const expectedArgs = JSON.parse(readFileSync(ARGS_FILE, 'utf8'));
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow',
  input: { scriptPath: '/tmp/camus-loop-wf_test.js', resumeFromRunId: 'wf_test', args: expectedArgs } }] } });
writeFileSync(REVIEWS + '/' + PREFIX + '-r1.json', ${JSON.stringify(receipt(1, true))});
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'round 1 receipt published (bound)' }] } });
// A SIGTERM handler that exits 0: the refused child then returns the async shape as well, so
// \`!receiptViolation\` is the ONLY thing standing between the refusal and a third turn.
process.on('SIGTERM', () => {
  say({ type: 'result', subtype: 'success', session_id: SESSION,
    result: 'the workflow is still running asynchronously' });
  process.exit(0);
});
setTimeout(() => {
  writeFileSync(REVIEWS + '/' + PREFIX + '-r2.json', ${JSON.stringify(receipt(2, false))});
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'round 2 receipt published (UNBOUND)' }] } });
  // THE MUTATION WINDOW. A correct halt closes this process before any of it runs.
  setTimeout(() => {
    writeFileSync(MARKER, 'mutated');
    for (const p of ['fix', 'commit', 'verify']) {
      say({ type: 'assistant', message: { content: [{ type: 'text', text: 'phase: ' + p }] } });
    }
    say({ type: 'result', subtype: 'success', result: JSON.stringify({ status: 'done', commit_sha: 'deadbeef' }) });
    process.exit(0);
  }, 8000);
}, 600);
`);
chmodSync(fake, 0o755);

// ── A detached reviewer owned by this worktree prefix, launched by THIS process ────────
const reviewer = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
reviewer.unref();
const reviewerPid = reviewer.pid;
const watchDir = join(REVIEWS, `${PREFIX}-r2.watch`);
mkdirSync(watchDir, { recursive: true });
writeFileSync(join(watchDir, 'handle.json'), JSON.stringify({
  pid: reviewerPid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex', 'exec'], cwd: WT,
}));
// The watch also needs the meta.json the gate writes at start: review.sh authenticates a handle
// against it before it will act, so a watch without one is refused and cleanup could never prove
// the kill. Production shape: this worktree, round 2, the pinned effort/model, the gate nonce,
// the scope, and a valid versioned input fingerprint.
writeFileSync(join(watchDir, 'meta.json'), JSON.stringify({
  target_dir: WT,
  round: '2',
  effort: EFFORT,
  scope: 'full',
  reviewer_model: MODEL,
  gate_nonce: NONCE,
  input_fingerprint: `fp1:${'a1b2c3d4'.repeat(8)}`,
}, null, 2));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  // ASYNCHRONOUS on purpose. spawnSync blocks this thread, so the parent could not run timers or
  // reap anything while the fixture ran — and the reviewer it launched is this process's own
  // child, whose exit must be observable here for the cleanup assertion to be meaningful.
  const child = await new Promise((resolve) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        CLS_HALT_CHILD: '1',
        CLS_HALT_ROOT: ROOT,
        PATH: `${bin}:${process.env.PATH}`,
        CAMUS_REVIEW_DIR: REVIEWS,           // captured at module load → separate process
        CAMUS_FEATS_DIR: join(ROOT, 'feats'),
        CODE_LANE_ABORT_GRACE_MS: '800',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    c.stderr.on('data', (b) => { stderr += b; });
    c.stdout.on('data', () => {});
    const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 180_000);
    c.on('close', () => { clearTimeout(kill); resolve({ stderr }); });
  });

  const out = existsSync(join(ROOT, 'out.json')) ? JSON.parse(readFileSync(join(ROOT, 'out.json'), 'utf8')) : null;
  assert.ok(out, `the fixture produced a result (stderr: ${String(child.stderr).slice(-500)})`);
  const rep = out.report ?? {};
  const logs = (out.logs ?? []).join('\n');
  const turns = existsSync(TURNS) ? readFileSync(TURNS, 'utf8').trim().split('\n').filter(Boolean).length : 0;

  // ── CUSTODY: the refusal is recorded, and every claim it makes is proven ────────────
  assert.equal(out.status, 'failed', 'the outer result is failed');
  assert.equal(rep.status, 'infra_error', 'the gate report is an infra_error, not a verdict');
  assert.match(String(rep.receiptViolation), /binding/,
    `refused for the binding — report was ${JSON.stringify(rep).slice(0, 300)} | logs: ${logs.slice(-300)}`);
  assert.equal(rep.terminationAttempted, true, 'termination was requested');
  assert.equal(rep.igniterClosed, true, "the REFUSED turn's child (turn two) is observed closed");
  assert.equal(rep.reviewerCleanupClean, true, 'owned reviewer cleanup is proven clean');
  assert.equal(rep.haltedIgniter, true, 'so the halt may be claimed');
  assert.equal(rep.custody, undefined, 'and no custody-unproven state is reported');

  // ── THE MUTATION NEVER HAPPENED ────────────────────────────────────────────────────
  assert.equal(existsSync(MARKER), false, 'the delayed mutation marker was never written');
  assert.ok(!/phase: (fix|commit|verify)/.test(logs), `no post-refusal phase ran (logs: ${logs.slice(-200)})`);
  assert.ok(!rep.commit_sha, 'nothing was committed');

  // ── EXACTLY TWO CLAUDE PROCESSES: one fresh turn, one legitimate reattach, no third ──
  assert.equal(turns, 2, `exactly two real igniter processes ran, never a third (saw ${turns})`);

  // ── THE INDEPENDENTLY LAUNCHED REVIEWER GROUP IS GONE ──────────────────────────────
  assert.ok(reviewerPid > 0, 'the harness really started a detached reviewer');
  for (let i = 0; i < 40 && alive(reviewerPid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(reviewerPid), false,
    `the reviewer process group was terminated by the refusal cleanup (pid ${reviewerPid})`);

  console.log('halt.test: all assertions passed');
} finally {
  // Never leak the reviewer, even when an assertion above throws.
  if (reviewerPid && alive(reviewerPid)) {
    try { process.kill(-reviewerPid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(reviewerPid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
