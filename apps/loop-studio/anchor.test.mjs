// ── THE GATE'S TRUST ANCHOR REACHES THE REAL IGNITER PROCESS ─────────────────────────
// `_guard.sh` anchors on $CAMUS_REPO_ROOT and `camus_anchor` no-ops when it is absent, and
// Studio never supplied one: the server has no such variable and runIgniterTurn only inherited
// process.env. So a Studio-launched gate ran every guarded script against whatever cwd the thin
// runner happened to hold — the condition behind WP7's refused worktree and WP9's unanchored
// verification. This spawns the REAL igniter seam with a stub `claude` on PATH that records the
// environment it was actually launched with, from a parent process whose own env has NO
// CAMUS_REPO_ROOT, and checks both the initial turn and the reattached one.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── THE STUB IGNITER (this same file, re-entered as a child of the child) ──────────────
// Recording the env from inside the process `spawn` actually created is the only honest check:
// a parent-side assertion on the options object would pass even if the spawn dropped it.
if (process.env.ANCHOR_STUB_ENV_FILE) {
  const argv = process.argv.slice(2);
  appendFileSync(process.env.ANCHOR_STUB_ENV_FILE,
    JSON.stringify({
      turn: argv.includes('--resume') ? 'reattach' : 'initial',
      CAMUS_REPO_ROOT: process.env.CAMUS_REPO_ROOT ?? null,
      CAMUS_CODEX_MODEL: process.env.CAMUS_CODEX_MODEL ?? null,
      cwd: process.cwd(),
    }) + '\n');
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (!argv.includes('--resume')) {
    // Turn one hands back the asynchronous "still running" shape so Studio reattaches.
    const pIdx = argv.indexOf('-p');
    const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? '') : '';
    const jsonStart = prompt.indexOf('{');
    const rawArgs = jsonStart >= 0 ? prompt.slice(jsonStart) : '{}';
    say({ type: 'system', subtype: 'init', session_id: SESSION });
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow',
      input: { name: 'camus-loop', args: JSON.parse(rawArgs) } }] } });
    say({ type: 'result', subtype: 'success', session_id: SESSION,
      result: 'the workflow is still running asynchronously' });
    process.exit(0);
  }
  // Turn two (the reattach) ends the run with a terminal report.
  say({ type: 'system', subtype: 'init', session_id: SESSION });
  say({ type: 'result', subtype: 'success', session_id: SESSION,
    result: JSON.stringify({ status: 'no_changes', note: 'anchor probe: nothing to do' }) });
  process.exit(0);
}

// ── THE HARNESS ───────────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'cls-anchor-'));
const ENV_FILE = join(ROOT, 'observed-env.jsonl');
writeFileSync(ENV_FILE, '');

// A production-shaped "game repo": a real checkout, reached through a path that is NOT its own
// canonical spelling. On macOS $TMPDIR is a symlink, so this is the ordinary case, not a corner
// one — and it is exactly where an un-canonicalized anchor and the guard's common-dir compare
// disagree. Studio is handed the symlinked spelling; the igniter must receive the real one.
const GAME = join(ROOT, 'CodenameWukongProbe');
mkdirSync(GAME, { recursive: true });
const git = (...a) => spawnSync('git', ['-C', GAME, ...a], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@e.com');
git('config', 'user.name', 't');
writeFileSync(join(GAME, 'Program.cs'), 'class P {}\n');
git('add', '-A');
git('commit', '-qm', 'init');
const CANONICAL = realpathSync(GAME);
// A subdirectory the run could plausibly name instead of the root — the anchor must still be
// the repository root, never the directory it was pointed at.
const SUBDIR = join(GAME, 'src');
mkdirSync(SUBDIR, { recursive: true });

const bin = join(ROOT, 'bin');
mkdirSync(bin, { recursive: true });
const stub = join(bin, 'claude');
writeFileSync(stub, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(import.meta.url))} "$@"\n`);
chmodSync(stub, 0o755);

// THE PARENT'S OWN ENVIRONMENT HAS NO ANCHOR. That is the Studio server's real state, and it is
// what made the whole thing a no-op: inheriting process.env inherits nothing.
delete process.env.CAMUS_REPO_ROOT;
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ANCHOR_STUB_ENV_FILE = ENV_FILE;
process.env.CAMUS_REVIEW_DIR = join(ROOT, 'reviews');
process.env.CAMUS_FEATS_DIR = join(ROOT, 'feats');
mkdirSync(process.env.CAMUS_REVIEW_DIR, { recursive: true });
mkdirSync(process.env.CAMUS_FEATS_DIR, { recursive: true });

const { runCodeLoop, resolveRepoAnchor } = await import('./lib/code-lane.mjs');

assert.equal(process.env.CAMUS_REPO_ROOT, undefined, 'the parent env genuinely lacks the anchor');

// The resolver itself, on the shapes a run record actually arrives in.
assert.equal(await resolveRepoAnchor({ targetToplevel: GAME }), CANONICAL,
  'a validated toplevel is canonicalized');
assert.equal(await resolveRepoAnchor({ targetPath: GAME }), CANONICAL,
  'a run with only a targetPath still resolves its repo root');
assert.equal(await resolveRepoAnchor({ targetPath: SUBDIR }), CANONICAL,
  'a subdirectory resolves to the REPOSITORY ROOT, not itself');
assert.equal(await resolveRepoAnchor({ targetPath: ROOT }), null,
  'a path outside any repository yields no anchor, never a guess');
assert.equal(await resolveRepoAnchor({}), null, 'a run naming no target yields no anchor');

const events = [];
const res = await runCodeLoop(
  { id: 'anchor-probe', goal: 'g', acceptanceContract: 'c', lane: 'build',
    targetPath: GAME, targetToplevel: GAME, idSalt: 'studio-anchor-probe',
    models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.6-terra', effort: 'medium' }, loop: { roundCap: 3 } } },
  { emit: (t, d) => events.push({ t, ...d }), waitForAnswer: async () => 'stop',
    signal: { aborted: false, addEventListener() {}, removeEventListener() {} } },
);

const observed = readFileSync(ENV_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const logs = events.filter((e) => e.t === 'log').map((e) => e.line).join('\n');

console.log('--- anchor proof ---');
console.log('canonical repo root :', CANONICAL);
console.log('igniter turns seen  :', observed.map((o) => o.turn).join(', '));
for (const o of observed) console.log(`  ${o.turn.padEnd(8)} CAMUS_REPO_ROOT=${o.CAMUS_REPO_ROOT}`);
console.log('outer status        :', res.status);

assert.ok(observed.length >= 2, `both the initial turn and a reattach must have run (saw ${observed.length})`);
assert.ok(observed.some((o) => o.turn === 'initial'), 'the initial igniter turn ran');
assert.ok(observed.some((o) => o.turn === 'reattach'), 'a reattached igniter turn ran');
for (const o of observed) {
  assert.equal(o.CAMUS_REPO_ROOT, CANONICAL,
    `the ${o.turn} igniter process must observe the canonical game-repo root as its trust anchor`);
}
// The reviewer pin still rides along — the anchor was added beside it, not over it.
assert.ok(observed.every((o) => o.CAMUS_CODEX_MODEL === 'gpt-5.6-terra'), 'the reviewer pin survives on every turn');
// And the operator can see which repository the gate was allowed to touch.
assert.match(logs, new RegExp(`CAMUS_REPO_ROOT=${CANONICAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  'the run log names the anchor it handed the gate');

console.log('anchor.test: all assertions passed');
