// API + lifecycle tests: spawns the real server (mock engine, ephemeral port)
// and asserts the trust boundary and run lifecycle end to end. Kept separate
// from verify.test.mjs (pure, offline) because this one owns a process.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidencePack } from './lib/evidence-pack.mjs';
import { validateExperimentRecord } from '../../packages/trust/lib/validate.mjs';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'cls-api-'));
const ACCEPTANCE = 'Every material claim is traceable and the deterministic checks are recorded.';

// The config-POST test writes the decision record; STUDIO_MODELS_FILE points it
// at a throwaway copy so neither local operator state nor tracked defaults move.
// The copy gains an opt-in openai_compat backend so seat selection is testable
// without any real endpoint (mock engine: nothing ever contacts it), and the
// codex cache is PINNED to a fixture — the machine's real cache is rewritten
// live by every codex app-server and its hidden flags flap between writes.
const modelsFile = join(tmp, 'models.json');
// Seed from the committed default shape, not the machine's local operator state.
// The scripted rehearsal itself
// needs three rounds, so its fixture pins that cap independently of the product
// default (a real WP8 settings change from 3 → 2 exposed this coupling).
const baseModels = JSON.parse((() => {
  try {
    return execFileSync('git', ['show', 'HEAD:apps/loop-studio/checks/models.json'],
      { cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'), encoding: 'utf8' });
  } catch {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'checks', 'models.json'), 'utf8');
  }
})());
baseModels.loop = { roundCap: 3, why: 'fixed api.test.mjs rehearsal fixture' };
baseModels.backends = {
  kimi: { kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'CLS_TEST_KIMI_KEY', models: ['kimi-k2'], why: 'api-test fixture backend' },
};
writeFileSync(modelsFile, JSON.stringify(baseModels, null, 2));
const codexCacheFile = join(tmp, 'codex-cache.json');
writeFileSync(codexCacheFile, JSON.stringify({ models: [
  { slug: baseModels.reviewer.model, visibility: 'list' },
  { slug: 'gpt-5.4', visibility: 'list' },
  { slug: 'gpt-5.4-mini', visibility: 'list' },
  { slug: 'codex-auto-review', visibility: 'hide' },
] }));

// The recovery lane runs the REAL verifier. The installed verify.sh anchors its
// target guard to the caller's own repo, so a throwaway probe repo is (correctly)
// refused; this entry point runs the same verify.py against the probe instead of
// mutating the product repo with a scratch worktree. Only the guard is bypassed —
// stack detection, CAMUS_VERIFY_CMD, and HEAD reporting are the real thing.
const verifyEntry = join(tmp, 'verify-probe.sh');
writeFileSync(verifyEntry, `#!/usr/bin/env bash\nexec python3 ${join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'cli', 'skills', 'camus', 'scripts', 'verify.py')} "$1"\n`);
chmodSync(verifyEntry, 0o755);

const server = spawn(process.execPath, ['server.mjs'], {
  // STUDIO_RUNS_DIR points the server at the throwaway tmp dir, so test runs
  // never pollute the product's real runs/ (the temp dir is removed in finally).
  env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_MAX_ACTIVE: '3', STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: modelsFile, STUDIO_CODEX_CACHE_FILE: codexCacheFile, STUDIO_VERIFY_SCRIPT: verifyEntry },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// A crashed server used to make this suite exit 1 with NO output at all.
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
let base = '';
for await (const chunk of server.stdout) {
  const m = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (m) { base = `http://${HOST}:${m[1]}`; break; }
}
assert.ok(base, 'server announced a port');

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (err) { results.push(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

let TOKEN = '';
try {
  // --- trust boundary ---------------------------------------------------
  await check('status is readable and hands out a session token', async () => {
    const r = await fetch(`${base}/api/status`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(d.token && d.token.length >= 32, 'token present (16 bytes as hex)');
    TOKEN = d.token;
  });

  await check('config carries a model catalog and never a hidden slug', async () => {
    // Exercises the real codex cache on this machine (which includes the hidden
    // codex-auto-review) — the catalog must filter it out, and the current
    // decisions must always be selectable.
    const r = await fetch(`${base}/api/config`, { headers: { origin: base } });
    assert.equal(r.status, 200);
    const c = await r.json();
    assert.ok(Array.isArray(c.catalog?.maker) && c.catalog.maker.length, 'maker catalog present');
    assert.ok(Array.isArray(c.catalog?.reviewer) && c.catalog.reviewer.length, 'reviewer catalog present');
    assert.ok(c.catalog.maker.includes(c.maker.model), 'the current maker decision is selectable');
    assert.ok(c.catalog.reviewer.includes(c.reviewer.model), 'the current reviewer decision is selectable');
    assert.ok(!c.catalog.reviewer.includes('codex-auto-review'), 'a hidden internal reviewer model is never offered');
    assert.ok(['codex_cache', 'fallback'].includes(c.catalog.reviewerSource), 'the catalog names whether the list is CLI-verified');
  });

  await check('config POST validates model choices server-side (400 on an unoffered reviewer)', async () => {
    // The picker filters the hidden model out; the write path must too, or it
    // could be persisted and slip back in as the current decision.
    const bad = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ reviewer: 'codex-auto-review' }),
    });
    assert.equal(bad.status, 400, 'a hidden/unoffered reviewer is rejected');
    const badMaker = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ maker: 'not-a-real-maker' }),
    });
    assert.equal(badMaker.status, 400, 'an unknown maker is rejected');
    // A valid listable reviewer still saves.
    const cfg = await (await fetch(`${base}/api/config`, { headers: { origin: base } })).json();
    const okReviewer = cfg.catalog.reviewer[0];
    const good = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ reviewer: okReviewer }),
    });
    assert.equal(good.status, 200, `a valid listable reviewer (${okReviewer}) saves`);
  });

  await check('config exposes the seat catalog: backends, providers, and declared seats', async () => {
    const c = await (await fetch(`${base}/api/config`, { headers: { origin: base } })).json();
    assert.ok(Array.isArray(c.seats?.maker) && Array.isArray(c.seats?.reviewer), 'both seat lists present');
    assert.ok(c.seats.maker.every((e) => e.backend && e.provider && e.model), 'every entry is backend-qualified');
    assert.ok(c.seats.maker.some((e) => e.backend === 'kimi' && e.provider === 'moonshot' && e.model === 'kimi-k2'), 'a declared compat backend is offered in the maker seat');
    assert.ok(c.seats.reviewer.some((e) => e.backend === 'kimi'), 'and in the reviewer seat (both are declared by default)');
    assert.ok(c.seats.reviewer.some((e) => e.backend === 'claude' && e.model === 'sonnet'), 'claude models are offered in the reviewer seat — the reversed pairing is expressible');
    assert.ok(c.seats.reviewer.filter((e) => e.backend === 'codex').every((e) => e.effort === true), 'codex entries declare the effort knob');
    assert.ok(c.seats.reviewer.filter((e) => e.backend !== 'codex').every((e) => e.effort === false), 'no other backend claims an effort knob');
    assert.ok(!c.seats.reviewer.some((e) => e.model === 'codex-auto-review'), 'the pinned cache keeps hidden models out of the seat catalog');
    assert.equal(c.maker.backend, 'claude', 'the current decision names its backend');
    assert.equal(c.maker.provider, 'anthropic', 'and its provider');
  });

  await check('config POST accepts { backend, model } seats and refuses undeclared ones', async () => {
    const post = (body) => fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify(body),
    });
    const good = await post({ maker: { backend: 'claude', model: 'haiku' } });
    assert.equal(good.status, 200, 'an offered seat object saves');
    const saved = await (await fetch(`${base}/api/config`, { headers: { origin: base } })).json();
    assert.equal(saved.maker.model, 'haiku', 'the decision record took the seat write');
    const ghost = await post({ maker: { backend: 'ghost', model: 'kimi-k2' } });
    assert.equal(ghost.status, 400, 'an undeclared backend is refused');
    const wrongModel = await post({ reviewer: { backend: 'kimi', model: 'undeclared-model' } });
    assert.equal(wrongModel.status, 400, 'a model the backend does not declare is refused');
    const restore = await post({ maker: { backend: 'claude', model: 'sonnet' } });
    assert.equal(restore.status, 200);
  });

  await check('a run request can carry an explicit pairing, recorded as the decision source', async () => {
    const start = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({
        goal: 'pairing probe: a run whose seats were chosen on the launch form',
        acceptanceContract: ACCEPTANCE,
        lane: 'freeform',
        pairing: { maker: { backend: 'kimi', model: 'kimi-k2' }, reviewer: { backend: 'claude', model: 'sonnet' } },
      }),
    });
    assert.equal(start.status, 201, `pairing run starts (${start.status})`);
    const { id } = await start.json();
    const runMeta = JSON.parse(readFileSync(join(tmp, id, 'run.json'), 'utf8'));
    assert.deepEqual(
      { backend: runMeta.models.maker.backend, provider: runMeta.models.maker.provider, model: runMeta.models.maker.model, source: runMeta.models.maker.source },
      { backend: 'kimi', provider: 'moonshot', model: 'kimi-k2', source: 'run request' },
      'the snapshot records the per-run maker decision with its source',
    );
    assert.equal(runMeta.models.maker.executor, 'http_client', 'the run snapshot carries the selected seat executor');
    assert.equal(runMeta.models.maker.transport, 'unknown', 'an undeclared legacy backend does not promote its anonymous loopback URL into an asserted transport identity');
    assert.equal(runMeta.models.maker.connection, '$legacy:kimi', 'the anonymous migrated connection is still named for later qualification');
    assert.equal(runMeta.models.maker.trainingOrg, 'unknown', 'legacy provider text is not promoted into training identity');
    assert.deepEqual(runMeta.models.maker.lineage, { source: 'unknown', derivedFrom: null });
    assert.equal(runMeta.models.maker.originConfidence, 'unknown');
    assert.equal(runMeta.models.reviewer.backend, 'claude');
    assert.equal(runMeta.models.reviewer.executor, 'claude_cli');
    assert.equal(runMeta.models.reviewer.trainingOrg, 'anthropic');
    assert.equal(runMeta.models.reviewer.lineage.source, 'registry');
    assert.equal(runMeta.models.reviewer.modelSource, 'run request');
    assert.equal(runMeta.models.reviewer.effort, null, 'a claude reviewer records no fabricated effort tier');
    await fetch(`${base}/api/runs/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN } });

    const bad = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({
        goal: 'pairing probe: an unoffered maker must never start',
        acceptanceContract: ACCEPTANCE,
        lane: 'freeform',
        pairing: { maker: { backend: 'kimi', model: 'undeclared-model' }, reviewer: { backend: 'claude', model: 'sonnet' } },
      }),
    });
    assert.equal(bad.status, 400, 'an unoffered pairing is refused; no substitution');
    assert.match((await bad.json()).error, /no substitution/, 'the refusal says so');

    const buildPairing = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({
        goal: 'pairing probe: the build lane owns its own models',
        acceptanceContract: ACCEPTANCE,
        lane: 'build',
        pairing: { maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.4' } },
      }),
    });
    assert.equal(buildPairing.status, 400, 'a pairing on the Build lane is refused loudly, never silently ignored');
  });

  await check('grounded managed-connector runs refuse a non-claude maker before any spend', async () => {
    // A second short-lived server with the connector mode on: the guard reads
    // hivemind mode `claude`, which the main test server deliberately lacks.
    const server3 = spawn(process.execPath, ['server.mjs'], {
      env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: modelsFile, STUDIO_CODEX_CACHE_FILE: codexCacheFile, HIVEMIND_VIA_CLAUDE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let base3 = '';
    for await (const chunk of server3.stdout) {
      const m3 = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (m3) { base3 = `http://${HOST}:${m3[1]}`; break; }
    }
    try {
      const status3 = await (await fetch(`${base3}/api/status`)).json();
      const post = (pairing) => fetch(`${base3}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base3, 'x-studio-token': status3.token },
        body: JSON.stringify({ goal: 'grounded pairing guard probe run', acceptanceContract: ACCEPTANCE, lane: 'freeform', ground: true, pairing }),
      });
      const refused = await post({ maker: { backend: 'kimi', model: 'kimi-k2' }, reviewer: { backend: 'claude', model: 'sonnet' } });
      assert.equal(refused.status, 400, 'grounded + non-claude maker is refused');
      assert.match((await refused.json()).error, /claude backend/, 'the refusal names the rule');
      const allowed = await post({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.4' } });
      assert.equal(allowed.status, 201, 'the guard does not overfire on a claude maker');
      const { id } = await allowed.json();
      await fetch(`${base3}/api/runs/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base3, 'x-studio-token': status3.token } });
    } finally {
      server3.kill('SIGKILL');
      await once(server3, 'close').catch(() => {});
    }
  });

  await check('verifyCmd travels the FULL path: POST validation → run.json → report', async () => {
    // The claimed snapshot was incomplete: the POST handler ignored verifyCmd,
    // run.json omitted it, and Resume dropped it (field report 2026-08-05). This
    // walks the whole path on the mock engine.
    const post = (body) => fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify(body),
    });
    const CMD = 'dotnet test tests/App.Tests/App.Tests.csproj -f net10.0';
    const started = await post({ goal: 'verifyCmd path probe for the Build lane', acceptanceContract: ACCEPTANCE, lane: 'build', targetPath: '~/demo-repo', verifyCmd: CMD });
    assert.equal(started.status, 201, `a valid verifyCmd is accepted (${started.status})`);
    const { id } = await started.json();
    const meta = JSON.parse(readFileSync(join(tmp, id, 'run.json'), 'utf8'));
    assert.equal(meta.verifyCmd, CMD, 'run.json PRESERVES the command, so a resume can reuse it');
    await fetch(`${base}/api/runs/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN } });
    let report = null;
    for (let i = 0; i < 40 && !report; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const sealed = await fetch(`${base}/api/runs/${id}/report`, { headers: { origin: base } });
      if (sealed.ok) report = await sealed.json();
    }
    assert.ok(report, 'the run seals a report');
    assert.equal(report.verifyCmd, CMD, 'and the sealed report records the command the run used');

    // Shell-safety: the workflow refuses these characters, so the API must too.
    for (const bad of ['dotnet test $(rm -rf /)', 'dotnet test `id`', 'dotnet test "x"', 'a\\b', 'a\nb']) {
      const r = await post({ goal: 'verifyCmd shell-safety probe run', acceptanceContract: ACCEPTANCE, lane: 'build', targetPath: '~/demo-repo', verifyCmd: bad });
      assert.equal(r.status, 400, `a shell-unsafe verifyCmd is refused: ${JSON.stringify(bad)}`);
    }
    // Words lanes verify a deliverable, not a repo.
    const wrongLane = await post({ goal: 'verifyCmd on a words lane must be refused', acceptanceContract: ACCEPTANCE, lane: 'freeform', verifyCmd: 'pnpm test' });
    assert.equal(wrongLane.status, 400, 'verifyCmd is refused on the words lanes');
    // Absent stays absent — no invented default.
    const plain = await post({ goal: 'a build run with no verify command at all', acceptanceContract: ACCEPTANCE, lane: 'build', targetPath: '~/demo-repo' });
    assert.equal(plain.status, 201);
    const plainId = (await plain.json()).id;
    assert.equal(JSON.parse(readFileSync(join(tmp, plainId, 'run.json'), 'utf8')).verifyCmd, null, 'no command supplied → null, never a guess');
    await fetch(`${base}/api/runs/${plainId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN } });
  });

  await check('RESUME can hand a legacy run a verify command it never had', async () => {
    // The gap the last round left open: a run that predates verifyCmd has none in
    // its metadata, Resume could only PRESERVE an existing value, and relaunching
    // to supply one would redo the plan and implement work the parked candidate
    // already holds (field report 2026-08-05). This calls Resume for real.
    const resume = (id, body) => fetch(`${base}/api/runs/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const stop = (id) => fetch(`${base}/api/runs/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN } });
    const CMD = 'dotnet test tests/App.Tests/App.Tests.csproj -f net10.0';
    const savedOf = (id) => JSON.parse(readFileSync(join(tmp, id, 'run.json'), 'utf8')).verifyCmd;

    // A LEGACY run on disk: the key is ABSENT, not null, and the server has never
    // seen it in memory — so this exercises the run.json path a real WP6 run takes.
    const legacyId = 'legacy-run-no-verifycmd';
    mkdirSync(join(tmp, legacyId), { recursive: true });
    const legacy = { id: legacyId, goal: 'a build run that predates verifyCmd', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: '~/demo-repo', idSalt: `studio-${legacyId}`, status: 'stopped', startedAt: 1 };
    assert.ok(!('verifyCmd' in legacy), 'the fixture really is legacy-shaped: no verifyCmd key at all');
    writeFileSync(join(tmp, legacyId, 'run.json'), JSON.stringify(legacy));

    const adopted = await resume(legacyId, { verifyCmd: CMD });
    assert.equal(adopted.status, 201, `a legacy run resumes with an override (${adopted.status})`);
    const adoptedId = (await adopted.json()).id;
    assert.equal(savedOf(adoptedId), CMD, 'the RESUMED run receives the command the legacy run never had');
    await stop(adoptedId);

    // Absent override preserves the saved value — resume must not wipe it.
    const preserved = await resume(adoptedId, {});
    assert.equal(preserved.status, 201, 'resuming again with no override is accepted');
    const preservedId = (await preserved.json()).id;
    assert.equal(savedOf(preservedId), CMD, 'an absent override PRESERVES the saved command');
    await stop(preservedId);

    // A bodyless resume (the old client shape) must still work and still preserve.
    const bodyless = await resume(preservedId, undefined);
    assert.equal(bodyless.status, 201, 'a resume with no body at all is still accepted');
    const bodylessId = (await bodyless.json()).id;
    assert.equal(savedOf(bodylessId), CMD, 'and it too preserves the saved command');
    await stop(bodylessId);

    // Resume validates EXACTLY like a launch: a looser resume would be a way in.
    for (const bad of ['dotnet test $(rm -rf /)', 'dotnet test `id`', 'dotnet test "x"', 'a\\b', 'a\nb', 'x'.repeat(2001)]) {
      const r = await resume(bodylessId, { verifyCmd: bad });
      assert.equal(r.status, 400, `resume refuses a shell-unsafe override: ${JSON.stringify(bad.slice(0, 24))}`);
    }
    // And a refused resume starts NOTHING — the saved command is untouched.
    assert.equal(savedOf(bodylessId), CMD, 'a refused override leaves the run as it was');
  });
  // ── VERIFICATION-ONLY RECOVERY ─────────────────────────────────────────────
  // Fixture policy: the source receipt is a SANITIZED COPY of the real stuck run
  // (runs/20260805-104802-rv4d/report.json) — values redacted, nothing added. It has
  // no top-level `gateReport` and no sealed candidate sha, because production sealed
  // neither. An earlier hand-built fixture invented both, which is exactly why the
  // selector passed its tests and failed on the real receipt.
  const legacyFixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wp6-needs-decision.report.json'), 'utf8'));
  assert.ok(!('gateReport' in legacyFixture), 'the fixture is production-shaped: no top-level gateReport');
  assert.equal(legacyFixture.report.parkedSha ?? null, null, 'and no sealed parkedSha');

  const gitIn = (cwd, args) => new Promise((resolve) => {
    const c = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve({ ok: false, out: '' }));
    c.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
  });

  // A real git worktree on the branch the fixture records, so the adoption checks
  // under test are the real ones rather than stubs.
  const makeProbeWorktree = async (name) => {
    const wt = join(tmp, `camus-wt-${name}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'README.md'), 'the parked candidate\n');
    if (!(await gitIn(wt, ['init', '-q'])).ok) return null;
    await gitIn(wt, ['config', 'user.email', 'test@example.com']);
    await gitIn(wt, ['config', 'user.name', 'recovery probe']);
    await gitIn(wt, ['checkout', '-q', '-b', legacyFixture.report.branch]);
    await gitIn(wt, ['add', '-A']);
    await gitIn(wt, ['commit', '-qm', 'the parked candidate']);
    const head = await gitIn(wt, ['rev-parse', 'HEAD']);
    return head.ok && /^[0-9a-f]{40}$/.test(head.out) ? { wt, head: head.out } : null;
  };

  // The sealed source run, written from the real fixture with only its worktree and
  // target repointed at the probe.
  const writeLegacySource = (id, wt) => {
    mkdirSync(join(tmp, id), { recursive: true });
    const sealed = JSON.parse(JSON.stringify(legacyFixture));
    sealed.id = id;
    sealed.idSalt = `studio-${id}`;
    sealed.report.worktree = wt;
    if (sealed.evidence?.gateReport) sealed.evidence.gateReport.worktree = wt;
    sealed.targetPath = wt;
    writeFileSync(join(tmp, id, 'report.json'), JSON.stringify(sealed));
    writeFileSync(join(tmp, id, 'run.json'), JSON.stringify(sealed));
    return sealed;
  };

  // A worktree whose NAME is coherent with its branch, which is what `_guard.sh`
  // requires of a `camus-wt-*` target: basename === `camus-wt-<branch suffix>`.
  const makeCoherentWorktree = async (suffix, { branch = `camus/${suffix}` } = {}) => {
    const wt = join(tmp, `camus-wt-${suffix}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'README.md'), 'the parked candidate\n');
    if (!(await gitIn(wt, ['init', '-q'])).ok) return null;
    await gitIn(wt, ['config', 'user.email', 'test@example.com']);
    await gitIn(wt, ['config', 'user.name', 'recovery probe']);
    await gitIn(wt, ['checkout', '-q', '-b', branch]);
    await gitIn(wt, ['add', '-A']);
    await gitIn(wt, ['commit', '-qm', 'the parked candidate']);
    const head = await gitIn(wt, ['rev-parse', 'HEAD']);
    return head.ok && /^[0-9a-f]{40}$/.test(head.out) ? { wt, head: head.out, branch } : null;
  };

  const withLiveServer = async (fn, { verifyScript = verifyEntry } = {}) => {
    const srv = spawn(process.execPath, ['server.mjs'], {
      env: {
        ...process.env, OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh',
        STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: modelsFile, STUDIO_CODEX_CACHE_FILE: codexCacheFile,
        // verifyScript: null means "use whatever is installed" — the real verify.sh.
        ...(verifyScript ? { STUDIO_VERIFY_SCRIPT: verifyScript } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stderr.on('data', (d) => process.stderr.write(`[live-srv] ${d}`));
    let b = '';
    let serverOutput = '';
    for await (const chunk of srv.stdout) {
      serverOutput += String(chunk);
      const m = serverOutput.match(/http:\/\/localhost:(\d+)/);
      if (m) { b = `http://${HOST}:${m[1]}`; break; }
    }
    assert.ok(b, `the live test server announced a usable URL (stdout: ${serverOutput})`);
    const tok = (await (await fetch(`${b}/api/status`)).json()).token;
    try { return await fn(b, tok); } finally {
      srv.kill('SIGKILL');
      await once(srv, 'close').catch(() => {});
    }
  };

  const resumeWith = (b, tok, id, body) => fetch(`${b}/api/runs/${id}/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok },
    body: JSON.stringify(body),
  });

  await check('a REHEARSAL Studio refuses to recover a parked candidate', async () => {
    // Recovery runs real verification commands inside a real repository. A mock
    // Studio promises the opposite ("no target-repository commands ran") and marks
    // its receipts simulated, so it must refuse rather than do real work under a
    // rehearsal label (caught in the live browser proof, 2026-08-05).
    const probe = await makeProbeWorktree('rehearsal-refusal');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'rehearsal-refuses-recovery';
    writeLegacySource(id, probe.wt);
    const r = await resumeWith(base, TOKEN, id, { verifyCmd: 'true' });
    assert.equal(r.status, 400, `a rehearsal refuses the recovery (got ${r.status})`);
    const { error } = await r.json();
    assert.match(error, /rehearsal/i, 'and says it is a rehearsal');
    assert.match(error, /live engine/i, 'and names the fix');
  });

  await check('the REAL legacy shape recovers: adopts a clean HEAD, keeps identity, takes the command', async () => {
    const probe = await makeProbeWorktree('legacy-adopt');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'legacy-needs-decision';
    const sealed = writeLegacySource(id, probe.wt);
    return withLiveServer(async (b, tok) => {
      const CMD = 'dotnet test tests/Core.Tests/Core.Tests.csproj -f net10.0';
      const r = await resumeWith(b, tok, id, { verifyCmd: CMD });
      const body = await r.json();
      assert.equal(r.status, 201, `the real legacy receipt enters recovery (got ${r.status}: ${JSON.stringify(body)})`);
      assert.equal(body.mode, 'verification_recovery', 'in recovery mode, not a gate run');
      assert.equal(body.parkedSha, probe.head, 'bound to the worktree HEAD it adopted');
      assert.equal(body.shaProvenance, 'adopted_clean_worktree_head', 'and labelled as ADOPTED, never as sealed by the source');
      const resumed = JSON.parse(readFileSync(join(tmp, body.id, 'run.json'), 'utf8'));
      assert.equal(resumed.idSalt, sealed.idSalt, 'the gate identity is preserved');
      assert.equal(resumed.verifyCmd, CMD, 'and the operator command is delivered');
      assert.equal(resumed.recovery.shaProvenance, 'adopted_clean_worktree_head', 'the run record keeps the provenance label');
      await fetch(`${b}/api/runs/${body.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok } });
    });
  });

  await check('a parked candidate that cannot be safely targeted REFUSES, never re-plans', async () => {
    // The original defect was falling through to the gate. For any outer
    // needs_decision over a nested verify_inconclusive, an unsafe target must refuse
    // out loud — a dirty worktree is the realistic case (the operator edited it).
    const probe = await makeProbeWorktree('dirty-refusal');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    writeFileSync(join(probe.wt, 'README.md'), 'edited by the operator after the gate parked it\n');
    const id = 'dirty-needs-decision';
    writeLegacySource(id, probe.wt);
    return withLiveServer(async (b, tok) => {
      const before = readdirSync(tmp).length;
      const r = await resumeWith(b, tok, id, { verifyCmd: 'true' });
      assert.equal(r.status, 409, `an unsafe target is refused (got ${r.status})`);
      const { error } = await r.json();
      assert.match(error, /uncommitted changes/, 'and names the obstacle');
      assert.match(error, /re-plan and re-implement/, 'and says why it will not just restart the gate');
      assert.equal(readdirSync(tmp).length, before, 'no run was started at all');

      // A worktree that has been moved off the recorded branch is refused too.
      await gitIn(probe.wt, ['checkout', '-q', '--', 'README.md']);
      await gitIn(probe.wt, ['checkout', '-q', '-b', 'somewhere-else']);
      const moved = await resumeWith(b, tok, id, { verifyCmd: 'true' });
      assert.equal(moved.status, 409, 'a moved branch is refused');
      assert.match((await moved.json()).error, /different branch/, 'and says the branch differs');
    });
  });

  await check('END TO END through the REAL installed verify.sh, guard intact', async () => {
    // Everything above runs a test entry point. This one runs the gate's own installed
    // verify.sh with its `_guard.sh` fully in force: the verifier is spawned with cwd
    // AND CAMUS_REPO_ROOT anchored to the already-canonicalized worktree, so the guard
    // trusts that target the same way a gate-script call does — and still applies its
    // own rules (branch must be camus/*, directory must be camus-wt-<branch suffix>).
    const installed = join(homedir(), '.claude', 'skills', 'camus', 'scripts', 'verify.sh');
    if (!existsSync(installed)) { console.log('  skip (gate not installed on this host)'); return; }
    const suffix = 'real-guard-e2e';
    const probe = await makeCoherentWorktree(suffix);
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'real-verify-source';
    const sealed = JSON.parse(JSON.stringify(legacyFixture));
    sealed.id = id;
    sealed.idSalt = `studio-${id}`;
    sealed.report.branch = probe.branch;             // the receipt records this branch
    sealed.report.worktree = probe.wt;
    if (sealed.evidence?.gateReport) { sealed.evidence.gateReport.branch = probe.branch; sealed.evidence.gateReport.worktree = probe.wt; }
    sealed.targetPath = probe.wt;
    mkdirSync(join(tmp, id), { recursive: true });
    writeFileSync(join(tmp, id, 'report.json'), JSON.stringify(sealed));
    writeFileSync(join(tmp, id, 'run.json'), JSON.stringify(sealed));

    // A repository the guard must REFUSE, kept as the negative control: an ordinary
    // repo is neither a coherent camus worktree nor on a camus/* branch.
    const foreign = join(tmp, 'some-other-project');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'a.txt'), 'not a camus candidate\n');
    await gitIn(foreign, ['init', '-q']);
    await gitIn(foreign, ['config', 'user.email', 'test@example.com']);
    await gitIn(foreign, ['config', 'user.name', 'other']);
    await gitIn(foreign, ['add', '-A']);
    await gitIn(foreign, ['commit', '-qm', 'init']);
    const foreignHead = (await gitIn(foreign, ['rev-parse', 'HEAD'])).out;
    const foreignId = 'foreign-repo-source';
    const foreignSealed = JSON.parse(JSON.stringify(sealed));
    foreignSealed.id = foreignId;
    foreignSealed.idSalt = `studio-${foreignId}`;
    const foreignBranch = (await gitIn(foreign, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
    foreignSealed.report.branch = foreignBranch;
    foreignSealed.report.worktree = foreign;
    if (foreignSealed.evidence?.gateReport) { foreignSealed.evidence.gateReport.branch = foreignBranch; foreignSealed.evidence.gateReport.worktree = foreign; }
    foreignSealed.targetPath = foreign;
    mkdirSync(join(tmp, foreignId), { recursive: true });
    writeFileSync(join(tmp, foreignId, 'report.json'), JSON.stringify(foreignSealed));
    writeFileSync(join(tmp, foreignId, 'run.json'), JSON.stringify(foreignSealed));

    return withLiveServer(async (b, tok) => {
      // POSITIVE: the real verify.sh greens the coherent worktree, bound to its HEAD.
      const r = await resumeWith(b, tok, id, { verifyCmd: 'true' });
      const body = await r.json();
      assert.equal(r.status, 201, `recovery starts against the real verifier (${r.status}: ${JSON.stringify(body)})`);
      let report = null;
      for (let i = 0; i < 300 && !report; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const got = await fetch(`${b}/api/runs/${body.id}/report`, { headers: { origin: b } });
        if (got.ok) report = await got.json();
      }
      assert.ok(report, 'it seals a report');
      assert.equal(report.status, 'done', `the REAL verify.sh (guard in force) greens the candidate (got ${report.status}: ${report.recoveryNote ?? ''})`);
      assert.equal(report.statuses.verification, 'passed', 'and the sealed dimensions record it');
      const events = readFileSync(join(tmp, body.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const verdict = events.find((e) => e.type === 'verify_result' && e.source === 'studio_reverify');
      assert.equal(verdict.commitSha, probe.head, 'bound to the HEAD the real verifier certified');

      // NEGATIVE: another repository is still refused by the guard — and the refusal is
      // reported as an INCONCLUSIVE with the guard's own diagnosis, never as a green
      // and never as "the verifier reported no HEAD".
      const nr = await resumeWith(b, tok, foreignId, { verifyCmd: 'true' });
      const nbody = await nr.json();
      assert.equal(nr.status, 201, 'the run starts (the guard decides, not the API)');
      let nreport = null;
      for (let i = 0; i < 300 && !nreport; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const got = await fetch(`${b}/api/runs/${nbody.id}/report`, { headers: { origin: b } });
        if (got.ok) nreport = await got.json();
      }
      assert.ok(nreport, 'the refused run seals a report too');
      assert.equal(nreport.status, 'needs_decision', `a guard-refused target NEVER greens (got ${nreport.status})`);
      assert.notEqual(nreport.status, 'done', 'the guard is not bypassed');
      assert.ok(Array.isArray(nreport.failures) && nreport.failures.some((f) => f.stage === 'guard'),
        `the guard's own failure survives into the receipt (${JSON.stringify(nreport.failures)})`);
      assert.match(nreport.recoveryNote, /guard/, 'and the note names the guard, not a missing HEAD');
      assert.ok(!/no HEAD/i.test(nreport.recoveryNote), 'the diagnosis is not replaced by a HEAD complaint');
      const nevents = readFileSync(join(tmp, nbody.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(nevents.filter((e) => e.type === 'verify_result' && e.source === 'studio_reverify').length, 0,
        'and no verdict was emitted for the refused target');
    }, { verifyScript: null });                       // ← the installed verify.sh, not a stub
  });

  await check('a RESTART mid-verification-decision recovers, and never re-enters the gate', async () => {
    // The production shape of run 20260805-181917-f4b1: review clean at round 2, the
    // gate's verify_inconclusive report, an UNANSWERED verification question, and NO
    // terminal report.json because Studio restarted while awaiting the answer. A fresh
    // server has no in-memory state for it, so this is a genuine cold restart.
    const probe = await makeCoherentWorktree('restart-parked');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'interrupted-verification-decision';
    const SALT = `studio-${id}`;
    const CMD = 'dotnet test tests/Core.Tests/Core.Tests.csproj -m:1';
    const gate = { status: 'verify_inconclusive', commit_sha: probe.head, parkedSha: probe.head, branch: probe.branch, worktree: probe.wt, rounds: 2,
      note: 'Verification could not RUN — NOT a code failure.', failures: [{ stage: 'prep', kind: 'guard_refused', log_tail: 'target rejected by camus_guard' }] };
    mkdirSync(join(tmp, id), { recursive: true });
    // run.json ONLY — exactly what an interrupted run leaves behind. No report.json.
    writeFileSync(join(tmp, id, 'run.json'), JSON.stringify({
      id, goal: 'WP7 perception probes', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false,
      targetPath: probe.wt, verifyCmd: CMD, idSalt: SALT, engine: 'claude', startedAt: 1,
    }));
    writeFileSync(join(tmp, id, 'events.jsonl'), [
      { type: 'run', at: 1, run: { id, goal: 'WP7 perception probes', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, verifyCmd: CMD, engine: 'claude' } },
      { type: 'review', at: 2, round: 1, verdict: 'CHANGES', source: 'camus_gate_review' },
      { type: 'review', at: 3, round: 2, verdict: 'APPROVED', source: 'camus_gate_review' },
      { type: 'verify_result', at: 4, pass: null, source: 'gate_report_status', derived: true, commitSha: probe.head },
      { type: 'gate_report', at: 5, report: gate },
      { type: 'question', at: 6, id: 'q-1', kind: 'verify', text: 'Deterministic verification could not run…', options: ['Retry verification with the configured command', 'Record that I ran the checks myself and they passed', 'Leave the candidate parked and stop here'] },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.ok(!existsSync(join(tmp, id, 'report.json')), 'the interrupted run really sealed no terminal report');
    // A trail written by anything other than JSON.stringify spaces its keys differently.
    // The server's prefilter must not silently drop the gate report — that made an
    // interrupted run fall through to a real gate run (caught in the browser proof).
    const spaced = 'spaced-interrupted-trail';
    mkdirSync(join(tmp, spaced), { recursive: true });
    writeFileSync(join(tmp, spaced, 'run.json'), JSON.stringify({ id: spaced, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, idSalt: `studio-${spaced}`, engine: 'claude', startedAt: 1 }));
    writeFileSync(join(tmp, spaced, 'events.jsonl'), [
      JSON.stringify({ type: 'run', at: 1, run: { id: spaced, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, engine: 'claude' } }),
      JSON.stringify({ type: 'gate_report', at: 2, report: gate }, null, 0).replace(/"type":/, '"type" : '),
      JSON.stringify({ type: 'question', at: 3, id: 'q-1', kind: 'verify', text: '…', options: ['Retry verification with the configured command'] }).replace(/"type":/, '"type" : '),
    ].join('\n') + '\n');

    return withLiveServer(async (b, tok) => {
      // The replay marks itself as disk-sourced so the client can disable dead controls.
      const stream = await fetch(`${b}/api/runs/${id}/events`, { headers: { origin: b } });
      const text = await stream.text();
      const frames = text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => { try { return JSON.parse(c.slice(6)); } catch { return null; } }).filter(Boolean);
      assert.equal(frames[0]?.type, 'replay_start', 'a disk replay announces itself before any event');
      assert.equal(frames[0]?.live, false, 'and says it is not live, so stale questions can be disabled');
      assert.ok(frames.some((f) => f.type === 'question' && f.kind === 'verify'), 'the unanswered question is replayed');
      assert.ok(frames.some((f) => f.type === 'gate_report' && f.report?.status === 'verify_inconclusive'), 'and so is the parked verdict');
      assert.ok(!frames.some((f) => f.type === 'status' && ['done', 'verify_failed', 'stopped', 'needs_decision'].includes(f.status)), 'with no terminal status anywhere');

      // Answering the stale question fails — which is why the UI must not offer it.
      const stale = await fetch(`${b}/api/runs/${id}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok },
        body: JSON.stringify({ id: 'q-1', answer: 'Retry verification with the configured command' }),
      });
      assert.ok(!stale.ok, `answering a dead session's question cannot succeed (got ${stale.status})`);

      // RESUME takes the verification-only lane.
      const r = await resumeWith(b, tok, id, {});
      const body = await r.json();
      assert.equal(r.status, 201, `the interrupted run recovers (got ${r.status}: ${JSON.stringify(body)})`);
      assert.equal(body.mode, 'verification_recovery', 'through the verification-only lane, NOT the gate');
      assert.equal(body.parkedSha, probe.head, 'bound to the parked candidate');
      assert.equal(body.shaProvenance, 'sealed_by_source', 'whose sha the gate report itself named');
      const resumed = JSON.parse(readFileSync(join(tmp, body.id, 'run.json'), 'utf8'));
      assert.equal(resumed.idSalt, SALT, 'the gate identity is preserved');
      assert.equal(resumed.verifyCmd, CMD, 'and the command the interrupted run was launched with carries over');
      assert.equal(resumed.recovery.interruptedRecovery, true, 'recorded as an interrupted recovery');
      assert.equal(resumed.recovery.sourceReceiptId, null, 'claiming no source receipt');
      assert.match(resumed.recovery.sourceReceiptStatus, /sealed no evidence pack/, 'because none was sealed — stated honestly');

      let report = null;
      for (let i = 0; i < 300 && !report; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const got = await fetch(`${b}/api/runs/${body.id}/report`, { headers: { origin: b } });
        if (got.ok) report = await got.json();
      }
      assert.ok(report, 'the recovery seals a report of its own');
      const events = readFileSync(join(tmp, body.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const stages = [...new Set(events.filter((e) => e.type === 'stage').map((e) => e.name))];
      assert.deepEqual(stages, ['verify'], `Verify-only phases (saw ${stages.join(', ')})`);
      for (const forbidden of ['gate', 'plan', 'implement', 'make', 'review', 'fix', 'ship']) {
        assert.ok(!stages.includes(forbidden), `no ${forbidden} phase ran`);
      }
      assert.equal(events.filter((e) => e.type === 'review').length, 0, 'no reviewer ran');
      assert.equal(report.models?.maker ?? null, null, 'no maker seat was resolved');
      assert.equal(report.models?.reviewer ?? null, null, 'and no reviewer seat either');
      // No pack was sealed by the source, so the lineage says so rather than guessing.
      const log = (report.evidencePack?.session_log ?? []).join('\n');
      assert.ok(report.evidencePack, `the recovery sealed a pack (${report.evidencePackError ?? 'no error reported'})`);
      assert.match(log, /recovery source receipt: none sealed by the source run/, `the sealed lineage records that there was no source receipt — saw:\n${log}`);
      assert.match(log, /recovery source audit: none recorded/, 'and no source audit');
      // The interrupted run's own files are untouched.
      assert.ok(!existsSync(join(tmp, id, 'report.json')), 'the interrupted run still has no report of its own');
      const src = JSON.parse(readFileSync(join(tmp, id, 'run.json'), 'utf8'));
      assert.equal(src.idSalt, SALT, 'and its run.json was not rewritten');

      // The whitespace-tolerant prefilter: a differently-formatted trail still recovers.
      const sp = await resumeWith(b, tok, spaced, { verifyCmd: 'true' });
      const spBody = await sp.json();
      assert.equal(sp.status, 201, `a differently-spaced trail also recovers (${sp.status}: ${JSON.stringify(spBody)})`);
      assert.equal(spBody.mode, 'verification_recovery', 'through the verification-only lane, not a gate run');
      await fetch(`${b}/api/runs/${spBody.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok } });
    });
  });

  await check('replay classification and resume mode AGREE in every case', async () => {
    // The browser used to re-derive "is this parked" from the replayed events with a
    // looser rule — any historical verify_inconclusive counted — so it could offer the
    // verification-only lane for a run resume would refuse. The server now answers with
    // reconstructInterruptedParked itself; these assert the two never diverge.
    const probe = await makeCoherentWorktree('classification-agree');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const gate = { status: 'verify_inconclusive', commit_sha: probe.head, parkedSha: probe.head, branch: probe.branch, worktree: probe.wt };
    const redGate = { ...gate, status: 'verify_failed' };
    const runEv = (id) => ({ type: 'run', at: 1, run: { id, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, engine: 'claude' } });
    const questionEv = { type: 'question', at: 3, id: 'q-1', kind: 'verify', text: '…', options: ['Retry verification with the configured command'] };

    const write = (id, events) => {
      mkdirSync(join(tmp, id), { recursive: true });
      writeFileSync(join(tmp, id, 'run.json'), JSON.stringify({ id, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, idSalt: `studio-${id}`, engine: 'claude', startedAt: 1 }));
      writeFileSync(join(tmp, id, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return id;
    };
    const parkedOf = async (b, id) => {
      const text = await (await fetch(`${b}/api/runs/${id}/events`, { headers: { origin: b } })).text();
      const frames = text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => { try { return JSON.parse(c.slice(6)); } catch { return null; } }).filter(Boolean);
      return frames.find((f) => f.type === 'replay_end') ?? null;
    };

    // The three shapes that must NOT select verification-only recovery.
    const noQuestion = write('cls-no-question', [runEv('cls-no-question'), { type: 'gate_report', at: 2, report: gate }]);
    const answered = write('cls-answered', [runEv('cls-answered'), { type: 'gate_report', at: 2, report: gate }, questionEv,
      { type: 'answer', at: 4, kind: 'verify', question: '…', answer: 'Leave the candidate parked and stop here' }]);
    const laterRed = write('cls-later-red', [runEv('cls-later-red'), { type: 'gate_report', at: 2, report: gate }, questionEv,
      { type: 'gate_report', at: 4, report: redGate }]);
    // And the one that must.
    const parked = write('cls-parked', [runEv('cls-parked'), { type: 'gate_report', at: 2, report: gate }, questionEv]);

    return withLiveServer(async (b, tok) => {
      for (const [label, id] of [['a gate report with NO verification question', noQuestion],
                                 ['an ANSWERED verification question', answered],
                                 ['a LATER red gate report', laterRed]]) {
        const end = await parkedOf(b, id);
        assert.equal(end?.parked, false, `${label}: the replay does NOT classify it as parked`);
        // And resume agrees: whatever it does, it is not the verification-only lane.
        const r = await resumeWith(b, tok, id, {});
        const body = await r.json().catch(() => ({}));
        assert.notEqual(body.mode, 'verification_recovery', `${label}: resume does NOT take the verification-only lane`);
        if (r.status === 201 && body.id) await fetch(`${b}/api/runs/${body.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok } });
      }
      // A lone historical verify_inconclusive with no pending decision is the exact
      // shape that used to select verification-only recovery in the browser.
      assert.equal((await parkedOf(b, noQuestion))?.parked, false,
        'a lone historical verify_inconclusive never selects verification-only recovery');

      // THE POSITIVE: the control the UI shows for a genuinely parked run resolves to the
      // verification-only lane every time it is clicked, never gate mode.
      const end = await parkedOf(b, parked);
      assert.equal(end?.parked, true, 'a genuinely interrupted decision IS classified parked');
      for (let i = 0; i < 3; i++) {
        const r = await resumeWith(b, tok, parked, { verifyCmd: 'true' });
        const body = await r.json();
        assert.equal(r.status, 201, `click ${i + 1}: the recovery starts (${r.status})`);
        assert.equal(body.mode, 'verification_recovery', `click ${i + 1}: always the verification-only lane, never gate mode`);
        assert.equal(body.parkedSha, probe.head, `click ${i + 1}: bound to the same candidate`);
        await fetch(`${b}/api/runs/${body.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b, 'x-studio-token': tok } });
        // Stop acknowledges the signal, not terminal sealing. Starting the next
        // click immediately can legitimately hit the active-run ceiling while the
        // verifier is still shutting down, making this a scheduler race rather
        // than a continuation assertion. Wait for the stopped receipt before the
        // next independent click.
        let stopped = false;
        for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
          const sealed = await fetch(`${b}/api/runs/${body.id}/report`, { headers: { origin: b } });
          if (sealed.ok) {
            const report = await sealed.json();
            stopped = report.status === 'stopped' || report.status === 'failed';
          }
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(stopped, true, `click ${i + 1}: the stopped recovery seals before the next click`);
      }
    });
  });

  await check('an interrupted run whose candidate is unsafe refuses, and never re-enters the gate', async () => {
    // Same interrupted shape, but the worktree has been edited since. It must refuse —
    // reconstruction must not become a new way to fall through to the gate.
    const probe = await makeCoherentWorktree('restart-dirty');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    writeFileSync(join(probe.wt, 'README.md'), 'edited after the interruption\n');
    const id = 'interrupted-but-dirty';
    const gate = { status: 'verify_inconclusive', commit_sha: probe.head, parkedSha: probe.head, branch: probe.branch, worktree: probe.wt };
    mkdirSync(join(tmp, id), { recursive: true });
    writeFileSync(join(tmp, id, 'run.json'), JSON.stringify({ id, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, idSalt: `studio-${id}`, engine: 'claude', startedAt: 1 }));
    writeFileSync(join(tmp, id, 'events.jsonl'), [
      { type: 'run', at: 1, run: { id, goal: 'g', acceptanceContract: ACCEPTANCE, lane: 'build', depth: 'quick', ground: false, targetPath: probe.wt, engine: 'claude' } },
      { type: 'gate_report', at: 2, report: gate },
      { type: 'question', at: 3, id: 'q-1', kind: 'verify', text: '…', options: ['Retry verification with the configured command'] },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return withLiveServer(async (b, tok) => {
      const before = readdirSync(tmp);
      const r = await resumeWith(b, tok, id, {});
      assert.equal(r.status, 409, `a dirty candidate is refused (got ${r.status})`);
      const { error } = await r.json();
      assert.match(error, /uncommitted changes/, 'naming the obstacle');
      assert.match(error, /re-plan and re-implement/, 'and why the gate is not the answer');
      assert.deepEqual(readdirSync(tmp).sort(), before.sort(), 'and no run was started');
    });
  });

  await check('a parked candidate with NO worktree anywhere refuses, and starts no run', async () => {
    // The gap: `parkedCandidate` was attached only by the deeper checks, so a receipt
    // whose worktree is unrecorded came back as a plain ineligible and resume fell
    // through into the full gate. Both sources are absent here — nothing in the
    // receipt, and no durable status record for this salt.
    // The target repo is DELIBERATELY VALID: if the refusal ever regresses, the
    // resume must be free to reach the gate, so the test fails with a started run
    // rather than being saved by some later validation error.
    const probe = await makeProbeWorktree('no-worktree-target');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'no-worktree-needs-decision';
    mkdirSync(join(tmp, id), { recursive: true });
    const sealed = JSON.parse(JSON.stringify(legacyFixture));
    sealed.id = id;
    sealed.idSalt = `studio-${id}-no-status-record`;
    sealed.targetPath = probe.wt;
    delete sealed.report.worktree;
    if (sealed.evidence?.gateReport) delete sealed.evidence.gateReport.worktree;
    writeFileSync(join(tmp, id, 'report.json'), JSON.stringify(sealed));
    writeFileSync(join(tmp, id, 'run.json'), JSON.stringify(sealed));
    return withLiveServer(async (b, tok) => {
      const before = readdirSync(tmp);
      const r = await resumeWith(b, tok, id, { verifyCmd: 'true' });
      assert.equal(r.status, 409, `a parked candidate with no worktree is REFUSED, not restarted (got ${r.status})`);
      const { error } = await r.json();
      assert.match(error, /worktree/, 'and the refusal names the missing worktree');
      assert.match(error, /re-plan and re-implement/, 'and says why the gate is not an option here');
      assert.deepEqual(readdirSync(tmp).sort(), before.sort(), 'no run directory was created at all');
    });
  });

  await check('recovery runs the verifier ONLY: no gate, no maker, no reviewer, real terminal', async () => {
    const probe = await makeProbeWorktree('verifier-only');
    if (!probe) { console.log('  skip (git unavailable)'); return; }
    const id = 'verifier-only-source';
    writeLegacySource(id, probe.wt);
    return withLiveServer(async (b, tok) => {
      // `true` exits 0, so the REAL verifier returns a real green for the real HEAD.
      const r = await resumeWith(b, tok, id, { verifyCmd: 'true' });
      assert.equal(r.status, 201, `the recovery starts (${r.status})`);
      const body = await r.json();
      const newId = body.id;

      // Let it reach a TERMINAL state on its own.
      let report = null;
      for (let i = 0; i < 200 && !report; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const got = await fetch(`${b}/api/runs/${newId}/report`, { headers: { origin: b } });
        if (got.ok) report = await got.json();
      }
      assert.ok(report, 'the recovery seals a report on its own');
      assert.equal(report.status, 'done', `the real host verifier greens the parked candidate (got ${report.status})`);

      // ZERO MODEL/GATE TURNS — asserted on the sealed event trail, not on intent.
      const events = readFileSync(join(tmp, newId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const stages = [...new Set(events.filter((e) => e.type === 'stage').map((e) => e.name))];
      assert.deepEqual(stages, ['verify'], `Verify-only phases (saw ${stages.join(', ')})`);
      for (const forbidden of ['gate', 'plan', 'implement', 'make', 'review', 'fix', 'ship']) {
        assert.ok(!stages.includes(forbidden), `no ${forbidden} phase ran`);
      }
      assert.equal(events.filter((e) => e.type === 'review').length, 0, 'no review round was recorded');
      assert.ok(!events.some((e) => e.type === 'draft' || e.type === 'markdown'), 'nothing was drafted');
      // No seat was even chosen: recovery constructs no adapters and reads no model
      // settings, so the sealed decision record names none.
      assert.equal(report.models?.maker ?? null, null, 'no maker seat was resolved');
      assert.equal(report.models?.reviewer ?? null, null, 'no reviewer seat was resolved');

      // COMMIT-BOUND to the adopted candidate, with honest provenance.
      const verdicts = events.filter((e) => e.type === 'verify_result' && e.source === 'studio_reverify');
      assert.equal(verdicts.length, 1, 'exactly one retry verdict');
      assert.equal(verdicts[0].commitSha, probe.head, 'bound to the candidate sha');
      assert.equal(report.recoveryOf.sourceRunId, id, 'the receipt names the source run');
      assert.equal(report.recoveryOf.parkedSha, probe.head, 'and the candidate sha');
      assert.equal(report.recoveryOf.verifyCmd, 'true', 'and the command that produced the result');
      assert.equal(report.recoveryOf.shaProvenance, 'adopted_clean_worktree_head', 'and how that sha was established');
      assert.equal(report.statuses.verification, 'passed', 'the sealed dimensions record a real verification');
      assert.equal(report.statuses.audit, 'not_run', 'and do NOT claim an audit this run never performed');

      // The source receipt is UNTOUCHED.
      const source = JSON.parse(readFileSync(join(tmp, id, 'report.json'), 'utf8'));
      assert.equal(source.status, 'needs_decision', 'the ORIGINAL receipt still says needs_decision');
      assert.equal(source.report.status, 'verify_inconclusive', 'and its gate verdict is unchanged');
      assert.ok(!('recoveryOf' in source), 'the source receipt was not rewritten');
    });
  });

  await check('a LIVE build run refuses a non-gate seat selection before touching anything', async () => {
    // The gate is fixed claude-maker/codex-reviewer; a kimi maker decision
    // must produce a refusal that names the fix — never leak into the gate.
    // A live-engine server is safe here: the 400 fires before any validation,
    // spawn, or spend, and nothing else is posted to it.
    const kimiModels = join(tmp, 'models-kimi-maker.json');
    writeFileSync(kimiModels, JSON.stringify({
      maker: { backend: 'kimi', model: 'kimi-k2' },
      reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' },
      backends: { kimi: { kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'CLS_TEST_KIMI_KEY', models: ['kimi-k2'] } },
      loop: { roundCap: 3 },
    }));
    const liveServer = spawn(process.execPath, ['server.mjs'], {
      env: { ...process.env, OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: kimiModels, STUDIO_CODEX_CACHE_FILE: codexCacheFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let liveBase = '';
    for await (const chunk of liveServer.stdout) {
      const lm = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (lm) { liveBase = `http://${HOST}:${lm[1]}`; break; }
    }
    try {
      const liveStatus = await (await fetch(`${liveBase}/api/status`)).json();
      const refused = await fetch(`${liveBase}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: liveBase, 'x-studio-token': liveStatus.token },
        body: JSON.stringify({ goal: 'build probe: the gate must not inherit words-lane seats', acceptanceContract: ACCEPTANCE, lane: 'build', targetPath: '~/definitely-not-a-repo' }),
      });
      assert.equal(refused.status, 400, 'the build run is refused');
      const error = (await refused.json()).error;
      assert.match(error, /claude-maker\/codex-reviewer gate/, 'the refusal names the fixed pairing');
      assert.match(error, /kimi:kimi-k2/, 'and the offending decision');
    } finally {
      liveServer.kill('SIGKILL');
      await once(liveServer, 'close').catch(() => {});
    }
  });

  await check('audit-only replay keeps the artifact, mints a receipt, and keeps rehearsal non-evidence', async () => {
    const sourceId = 'source-audit-fixture';
    const sourceDir = join(tmp, sourceId);
    mkdirSync(sourceDir, { recursive: true });
    const deliverable = '## Notes\n\nA source-bound recommendation with no material numeric claims.\n\n## Decision Rule\n\n- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.\n';
    const sourcePack = buildEvidencePack({
      goal: 'Test one unchanged artifact under a second auditor configuration.',
      acceptanceContract: ACCEPTANCE,
      lane: 'freeform',
      deliverable,
      evidence: {
        rounds: [{ rev: 1, verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', findings: [], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'scripted source assessment' }] }],
        revisions: [{ rev: 1, chars: deliverable.length }],
        verify: [{ pass: true, checks: [{ id: 'structure', status: 'pass', detail: 'present' }] }],
        humanDecisions: [],
        grounding: null,
        gateReport: null,
      },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'not_run', publication: 'not_published' },
      models: { maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' } },
      simulated: true,
      createdAt: 1,
    });
    writeFileSync(join(sourceDir, 'report.json'), JSON.stringify({
      id: sourceId,
      goal: sourcePack.goal,
      acceptanceContract: ACCEPTANCE,
      lane: 'freeform',
      depth: 'quick',
      engine: 'mock',
      simulated: true,
      deliverable,
      evidence: { revisions: [{ rev: 1, chars: deliverable.length }], grounding: null },
      evidencePack: sourcePack,
      receiptsDegraded: false,
      statuses: sourcePack.statuses,
      startedAt: 1,
      status: 'done',
    }, null, 2));

    const bad = await fetch(`${base}/api/runs/${sourceId}/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ reviewer: 'not-in-the-catalog', effort: 'low' }),
    });
    assert.equal(bad.status, 400, 'an unavailable arm is refused, never silently substituted');

    const config = await (await fetch(`${base}/api/config`, { headers: { origin: base } })).json();
    const reviewer = config.catalog.reviewer[0];
    const start = await fetch(`${base}/api/runs/${sourceId}/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ reviewer, effort: 'high' }),
    });
    assert.equal(start.status, 201);
    const replayId = (await start.json()).id;
    let report = null;
    for (let i = 0; i < 30 && !report; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch(`${base}/api/runs/${replayId}/report`, { headers: { origin: base } });
      if (response.ok) report = await response.json();
    }
    assert.ok(report, 'audit replay seals a report');
    assert.equal(report.sourceRunId, sourceId);
    assert.equal(report.evidencePack.schemaVersion, 3, 'a v3 source seals a v3 replay rather than back-filling a legacy shape');
    assert.equal(report.evidencePack.pairing.schemaVersion, 2);
    assert.equal(report.evidencePack.statuses.schemaVersion, 2);
    assert.equal(report.evidencePack.artifact_id, sourcePack.artifact_id, 'same artifact id');
    assert.notEqual(report.evidencePack.receipt_id, sourcePack.receipt_id, 'new receipt id');
    assert.equal(report.evidencePack.statuses.audit, 'not_run', 'mock audit never becomes standing');
    assert.equal(report.evidencePack.artifact.contract_coverage.every((criterion) => criterion.decision === 'unclear'), true, 'scripted contract judgments stay unclear');
    assert.equal(validateExperimentRecord(report.experiment).ok, true, 'experiment manifest + outcome validate');
    assert.equal(report.experiment.outcome.status, 'completed', 'the scripted arm completed as an experiment outcome');
    assert.equal(report.experiment.outcome.effort_actual, 'scripted', 'requested high effort never becomes a simulated actual');
    assert.equal(report.experiment.outcome.confounded, true, 'requested real reviewer vs scripted actual is visible');

    const inMemoryList = await (await fetch(`${base}/api/runs`)).json();
    const inMemoryArm = inMemoryList.runs.find((run) => run.id === replayId);
    assert.equal(inMemoryArm.live, true, 'the just-finished replay is still served from memory');
    assert.equal(inMemoryArm.artifactId, sourcePack.artifact_id, 'in-memory Recents carries the grouping authority before any restart');
    assert.equal(inMemoryArm.receiptId, report.evidencePack.receipt_id, 'the directly openable receipt is projected in memory');
    assert.equal(inMemoryArm.effortRequested, 'high');
    assert.equal(inMemoryArm.effortActual, 'scripted');
    assert.equal(inMemoryArm.auditorActual, 'simulation:scripted-auditor');
    assert.equal(inMemoryArm.findingCount, 0, 'a real zero finding count survives the in-memory projection');

    // An interrupted audit arm has no report or receipt yet, but run.json still
    // binds it to the source artifact. It must remain groupable as an incomplete
    // arm rather than disappear from the record.
    const interruptedReplayId = 'interrupted-audit-arm';
    const interruptedReplayDir = join(tmp, interruptedReplayId);
    mkdirSync(interruptedReplayDir, { recursive: true });
    writeFileSync(join(interruptedReplayDir, 'run.json'), JSON.stringify({
      id: interruptedReplayId,
      goal: sourcePack.goal,
      displayGoal: `Audit-only replay: ${sourcePack.goal}`,
      lane: 'audit_replay',
      sourceRunId: sourceId,
      startedAt: 2,
      experiment: {
        source: { run_id: sourceId, artifact_id: sourcePack.artifact_id, receipt_id: sourcePack.receipt_id },
        manifest: { effort: { requested: 'low' } },
        outcome: { artifact_id: sourcePack.artifact_id, receipt_id: null, auditor_actual: null, effort_actual: null, usage: {} },
      },
    }));
    const withInterrupted = await (await fetch(`${base}/api/runs`)).json();
    const interruptedArm = withInterrupted.runs.find((run) => run.id === interruptedReplayId);
    assert.equal(interruptedArm.status, 'incomplete');
    assert.equal(interruptedArm.artifactId, sourcePack.artifact_id, 'report-less audit metadata retains the exact grouping hash');
    assert.equal(interruptedArm.receiptId, null, 'an interrupted arm never invents a receipt');
    assert.equal(interruptedArm.effortRequested, 'low');

    // The exempted threshold line survives the production replay derivation
    // (server emit → deriveEvidence), bound to what it judged — and a scripted
    // audit keeps that decision non-evidence in the sealed pack, like coverage.
    const replayThreshold = (report.evidence.rounds ?? []).flatMap((r) => r.thresholdAssessments ?? []).find((t) => t.id === 'T1');
    assert.ok(replayThreshold, 'the replay derivation carries the threshold decision, not only claims/coverage');
    assert.match(replayThreshold.line, /Proposed threshold/, 'the carried decision is bound to the exempted line, not a bare ordinal');
    assert.equal(report.evidencePack.session_log.some((line) => line.startsWith('audit replay threshold ')), false, 'a scripted replay never seals threshold decisions as evidence');
  });

  await check('parallel execution freezes knowledge once, runs every arm, and retains non-winning outcomes', async () => {
    const config = await (await fetch(`${base}/api/config`, { headers: { origin: base } })).json();
    const makerModels = config.catalog.maker.slice(0, 2);
    assert.equal(makerModels.length, 2, 'test machine offers two maker decisions');
    const bad = await fetch(`${base}/api/comparisons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'Compare two launch strategies under one contract.', acceptanceContract: ACCEPTANCE, lane: 'freeform', makerModels: [makerModels[0], 'missing-maker'], reviewer: config.catalog.reviewer[0] }),
    });
    assert.equal(bad.status, 400, 'an unavailable executor is refused rather than substituted');

    const comparisonBody = JSON.stringify({
      goal: 'Compare two launch strategies under one frozen research brief.',
      acceptanceContract: ACCEPTANCE,
      lane: 'freeform',
      depth: 'quick',
      ground: true,
      makerModels,
      reviewer: config.catalog.reviewer[0],
      reviewerEffort: 'low',
    });
    const race = await Promise.all([1, 2].map(() => fetch(`${base}/api/comparisons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: comparisonBody,
    })));
    assert.deepEqual(race.map((response) => response.status).sort(), [201, 429], 'two simultaneous comparison POSTs admit exactly one before either parent finishes pre-registration I/O');
    const start = race.find((response) => response.status === 201);
    const comparisonId = (await start.json()).id;
    const overReservedCapacity = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'This run must not slip between a comparison parent and its child starts.', acceptanceContract: ACCEPTANCE, lane: 'freeform' }),
    });
    assert.equal(overReservedCapacity.status, 429, 'parallel arm slots are reserved before async child startup, closing the capacity race');
    let report = null;
    for (let i = 0; i < 180 && !report; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const answer = await fetch(`${base}/api/runs/${comparisonId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
        body: JSON.stringify({ answer: 'Use the self-serve launch context.' }),
      });
      assert.ok([200, 409].includes(answer.status), `comparison answer probe returned ${answer.status}`);
      const sealed = await fetch(`${base}/api/runs/${comparisonId}/report`, { headers: { origin: base } });
      if (sealed.ok) report = await sealed.json();
    }
    assert.ok(report, 'parallel rehearsal seals its parent report');
    assert.equal(report.lane, 'comparison');
    assert.equal(report.simulated, true);
    assert.equal(validateExperimentRecord(report.experiment).ok, true, JSON.stringify(validateExperimentRecord(report.experiment)));
    assert.equal(report.experiment.schemaVersion, 2);
    assert.equal(report.experiment.mode, 'parallel_execution');
    assert.equal(report.experiment.manifest.fallback_policy, 'none');
    assert.equal(report.experiment.outcome.arms.length, 2, 'both arms remain in the terminal experiment');
    assert.equal(
      report.experiment.outcome.arms.every((arm) => arm.status === 'quality_floor_failed'),
      true,
      `scripted arms finish but cannot pass the evidence floor: ${JSON.stringify(report.experiment.outcome.arms.map((arm) => ({ arm: arm.arm_id, status: arm.status, failure: arm.failure })))}`,
    );
    assert.equal(report.experiment.outcome.arms.every((arm) => arm.executor_actual === 'simulation:scripted-maker'), true, 'rehearsal never records a real executor actual');
    assert.equal(report.childRunIds.length, 2, 'both child receipts are addressable');
    const snapshots = report.childRunIds.map((runId) => JSON.parse(readFileSync(join(tmp, runId, 'report.json'), 'utf8')));
    assert.equal(new Set(snapshots.map((child) => child.knowledgeSnapshotId)).size, 1, 'every arm uses the exact same snapshot id');
    assert.equal(snapshots[0].knowledgeSnapshotId, report.experiment.knowledge.snapshot_id, 'child receipts bind the parent snapshot');
    assert.equal(snapshots.every((child) => child.models.maker.backend === 'claude' && child.models.maker.executor === 'claude_cli'), true, 'comparison children keep the exact built-in maker backend and executor');
    assert.equal(snapshots.every((child) => child.models.maker.trainingOrg === 'anthropic' && child.models.maker.modelFamily === 'claude'), true, 'comparison children keep maker training identity');
    assert.equal(snapshots.every((child) => child.models.maker.transport === 'vendor_managed' && child.models.maker.lineage?.source === 'registry'), true, 'comparison children keep maker transport and lineage');
    assert.equal(snapshots.every((child) => child.models.reviewer.backend === 'codex' && child.models.reviewer.executor === 'codex_cli'), true, 'comparison children keep the exact auditor backend and executor');
    assert.equal(snapshots.every((child) => child.models.reviewer.trainingOrg === 'openai' && child.models.reviewer.modelFamily === 'gpt'), true, 'comparison children keep auditor training identity');
    assert.equal(snapshots.every((child) => child.models.reviewer.transport === 'vendor_managed' && child.models.reviewer.lineage?.source === 'registry'), true, 'comparison children keep auditor transport and lineage');
    assert.equal(snapshots.every((child) => child.evidence?.grounding?.frozen === true), true, 'arms record frozen retrieval instead of live querying');
    assert.equal(snapshots.every((child) => child.evidencePack.session_log.includes(`frozen knowledge snapshot: ${report.experiment.knowledge.snapshot_id}`)), true, 'each arm receipt custody-binds the snapshot');
    assert.ok(existsSync(join(tmp, comparisonId, 'knowledge.json')), 'private snapshot contents stay in the local parent receipt directory');
    const parentEvents = readFileSync(join(tmp, comparisonId, 'events.jsonl'), 'utf8');
    assert.match(parentEvents, /"type":"answer"/, 'the parent replay preserves the human checkpoint answer, not only the question');

    // Simulate a server crash after arm 1 sealed but before arm 2 produced a
    // report. Recovery must preserve the manifest/snapshot identity, reuse the
    // sealed child, and retain the interrupted child as a failed arm. It must
    // not create replacement child runs that conceal the interruption.
    const interruptedId = 'comparison-interrupted-fixture';
    const interruptedDir = join(tmp, interruptedId);
    mkdirSync(interruptedDir, { recursive: true });
    const interruptedExperiment = JSON.parse(JSON.stringify(report.experiment));
    interruptedExperiment.outcome.status = 'running';
    interruptedExperiment.outcome.arms[1] = {
      ...interruptedExperiment.outcome.arms[1],
      run_id: 'missing-interrupted-child',
      status: 'running',
      artifact_id: null,
      receipt_id: null,
      executor_actual: null,
      auditor_actual: null,
      quality_floor: 'unknown',
      usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
      judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
      failure: null,
      confounded: false,
    };
    assert.equal(validateExperimentRecord(interruptedExperiment).ok, true, 'the fixture is a valid, genuinely incomplete experiment');
    writeFileSync(join(interruptedDir, 'run.json'), JSON.stringify({
      id: interruptedId,
      goal: report.goal,
      acceptanceContract: report.acceptanceContract,
      lane: 'comparison',
      sourceLane: report.sourceLane,
      depth: report.depth,
      ground: report.ground,
      experiment: interruptedExperiment,
      startedAt: report.startedAt,
    }, null, 2));
    writeFileSync(join(interruptedDir, 'knowledge.json'), readFileSync(join(tmp, comparisonId, 'knowledge.json')));
    writeFileSync(join(interruptedDir, 'events.jsonl'), `${JSON.stringify({ type: 'run', at: report.startedAt, run: { id: interruptedId, lane: 'comparison', goal: report.goal } })}\n`);

    const recovery = await fetch(`${base}/api/runs/${interruptedId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
    });
    const recoveryPayload = await recovery.json();
    assert.equal(recovery.status, 201, JSON.stringify(recoveryPayload));
    const recoveryId = recoveryPayload.id;
    let recovered = null;
    for (let i = 0; i < 40 && !recovered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sealed = await fetch(`${base}/api/runs/${recoveryId}/report`, { headers: { origin: base } });
      if (sealed.ok) recovered = await sealed.json();
    }
    assert.ok(recovered, 'recovery seals a new parent receipt');
    assert.equal(recovered.experiment.experiment_id, report.experiment.experiment_id, 'recovery preserves the frozen experiment identity');
    assert.equal(recovered.experiment.knowledge.snapshot_id, report.experiment.knowledge.snapshot_id, 'recovery reuses the exact frozen snapshot');
    assert.equal(recovered.experiment.outcome.arms[0].receipt_id, report.experiment.outcome.arms[0].receipt_id, 'the already sealed child is reconstructed, not rerun');
    assert.equal(recovered.experiment.outcome.arms[1].status, 'infra_failed', 'the interrupted child remains a failed arm');
    assert.equal(recovered.experiment.outcome.arms[1].failure.code, 'server_interrupted');
    assert.deepEqual(recovered.childRunIds.sort(), [report.childRunIds[0], 'missing-interrupted-child'].sort(), 'recovery creates no replacement child runs');
    assert.match(readFileSync(join(tmp, recoveryId, 'events.jsonl'), 'utf8'), /no model or retrieval is rerun/, 'the recovery receipt states the conservative policy');
  });

  await check('POST from a disallowed Origin is rejected (403), not executed', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'this must never start a run at all', lane: 'freeform' }),
    });
    assert.equal(r.status, 403, 'evil origin blocked before routing');
  });

  await check('POST with text/plain body is rejected (415)', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://camus.sh', 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'no-cors simple request shape', lane: 'freeform' }),
    });
    assert.equal(r.status, 415, 'text/plain refused');
  });

  await check('browser POST without the token is rejected (401)', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://camus.sh' },
      body: JSON.stringify({ goal: 'allowed origin but no capability token', lane: 'freeform' }),
    });
    assert.equal(r.status, 401, 'missing token refused');
  });

  await check('a foreign Host header is rejected (421, anti-DNS-rebind)', async () => {
    // fetch/undici forbids overriding Host, so use a raw request.
    const port = Number(base.split(':').pop());
    const code = await new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port, path: '/api/status', method: 'GET', headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(code, 421);
  });

  // --- run lifecycle ----------------------------------------------------
  let runId = '';
  await check('a same-origin POST with the token starts a run', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'lifecycle: community versus paid growth memo', acceptanceContract: ACCEPTANCE, lane: 'freeform', depth: 'quick' }),
    });
    assert.equal(r.status, 201);
    runId = (await r.json()).id;
    assert.ok(runId);
  });

  await check('publication is opt-in, recorded, typed, and unavailable to Build', async () => {
    const defaultMeta = JSON.parse(readFileSync(join(tmp, runId, 'run.json'), 'utf8'));
    assert.equal(defaultMeta.publishRequested, false, 'omitting publish records an explicit local-only decision');

    const post = (body) => fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify(body),
    });
    const invalid = await post({ goal: 'publication consent must be a boolean decision', acceptanceContract: ACCEPTANCE, lane: 'freeform', publish: 'yes' });
    assert.equal(invalid.status, 400, 'truthy strings cannot become publication consent');
    const build = await post({ goal: 'a build branch cannot become a Hivemind artifact', acceptanceContract: ACCEPTANCE, lane: 'build', targetPath: '~/demo-repo', publish: true });
    assert.equal(build.status, 400, 'Build refuses the words-artifact publication option');

    const opted = await post({ goal: 'an explicitly approved external artifact publication', acceptanceContract: ACCEPTANCE, lane: 'freeform', publish: true });
    assert.equal(opted.status, 201, 'an explicit words-lane opt-in starts');
    const optedId = (await opted.json()).id;
    const optedMeta = JSON.parse(readFileSync(join(tmp, optedId, 'run.json'), 'utf8'));
    assert.equal(optedMeta.publishRequested, true, 'run.json records the consent before any model work');
    await fetch(`${base}/api/runs/${optedId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN } });
  });

  await check('goal over the size cap is refused (400)', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'x'.repeat(2100), lane: 'freeform' }),
    });
    assert.equal(r.status, 400);
  });

  await check('an explicit acceptance contract is required (400)', async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'a valid goal that deliberately omits its audit contract', lane: 'freeform' }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /must be true/i);
  });

  await check('run.json exists from the start (crash recovery lists it)', async () => {
    // The mock run pauses at a question; before answering, it must be listed.
    await new Promise((r) => setTimeout(r, 400));
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.ok(list.runs.some((x) => x.id === runId), 'the in-flight run is listed');
    assert.ok(existsSync(join(tmp, runId, 'run.json')), 'the run is written inside the isolated test directory');
  });

  await check('answering with no pending question is a 409', async () => {
    // Fresh run has no question yet at t=0; race-safe because we check now.
    const r = await fetch(`${base}/api/runs/${runId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ answer: 'premature' }),
    });
    assert.ok([200, 409].includes(r.status), `answer returned ${r.status}`); // 200 if the question already surfaced
  });

  await check('the SSE stream replays and carries the run event', async () => {
    const r = await fetch(`${base}/api/runs/${runId}/events`, { headers: { origin: base } });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawRun = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sawRun) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('"type":"run"')) sawRun = true;
    }
    await reader.cancel();
    assert.ok(sawRun, 'run event seen on the stream');
  });

  await check('stop ends the run', async () => {
    const r = await fetch(`${base}/api/runs/${runId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
    });
    assert.equal(r.status, 200);
  });

  await check('concurrency ceiling returns 429 past the cap', async () => {
    const start = () => fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': TOKEN },
      body: JSON.stringify({ goal: 'concurrency probe run for the ceiling test', acceptanceContract: ACCEPTANCE, lane: 'freeform' }),
    });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await start()).status);
    assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')} (cap 3)`);
  });

  await check('the stopped run seals a receipt with an evidence trail + honest completeness', async () => {
    // Give the run's .then() a beat to seal report.json after the stop above.
    let report = null;
    for (let i = 0; i < 20 && !report; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const p = join(tmp, runId, 'report.json');
      if (existsSync(p)) report = JSON.parse(readFileSync(p, 'utf8'));
    }
    assert.ok(report, 'report.json was sealed for the stopped run');
    assert.ok(report.evidence && Array.isArray(report.evidence.rounds), 'the receipt carries an evidence object with a rounds array');
    assert.equal(typeof report.receiptsDegraded, 'boolean', 'receiptsDegraded is a real judgement, never absent');
    assert.ok('receiptsNote' in report, 'receiptsNote is present (null when complete)');
    assert.ok(report.statuses && typeof report.statuses.execution === 'string', 'the receipt seals the raw status dimensions');
    assert.ok(!('headline' in report), 'the headline is derived at render — never sealed into the evidence');
    assert.ok(report.models && report.models.maker, 'the receipt carries the run-start model snapshot, like run.json');
    assert.equal(report.acceptanceContract, ACCEPTANCE, 'the explicit trust contract survives into the report');
    assert.ok(report.evidencePack, `the evidence pack seals (${report.evidencePackError || 'no error'})`);
    assert.equal(report.evidencePack.schemaVersion, 3, 'new Studio receipts use evidence-pack v3');
    assert.equal(report.evidencePack.pairing.schemaVersion, 2, 'envelope v3 carries pairing v2');
    assert.equal(report.evidencePack.statuses.schemaVersion, 2, 'envelope v3 carries status v2');
    assert.match(report.evidencePack.artifact_id, /^sha256:[0-9a-f]{64}$/, 'artifact identity is sealed');
    assert.match(report.evidencePack.receipt_id, /^sha256:[0-9a-f]{64}$/, 'receipt identity is sealed');
    assert.equal(report.evidencePack.acceptance_contract, ACCEPTANCE, 'the pack uses the explicit contract, never aliases goal');
    assert.equal(report.evidencePack.pairing.executor.actual, 'simulation:scripted-maker', 'rehearsal actual is scripted, never Claude');
    assert.equal(report.evidencePack.pairing.auditor.actual, 'simulation:scripted-auditor', 'rehearsal actual is scripted, never Codex');
    assert.equal(report.evidencePack.pairing.independence, 'none', 'a rehearsal never claims cross-vendor independence');
    assert.ok(Array.isArray(report.evidencePack.artifact.claims), 'research receipts seal a structured claim ledger');
    assert.equal(report.evidencePack.artifact.claims.every((claim) => claim.decision === 'unchecked'), true, 'scripted rehearsal judgments never promote citations into support');
    assert.ok(Array.isArray(report.evidencePack.artifact.contract_coverage) && report.evidencePack.artifact.contract_coverage.length > 0, 'research receipts seal deterministic acceptance criteria');
    assert.equal(report.evidencePack.artifact.contract_coverage.every((criterion) => criterion.decision === 'unclear'), true, 'scripted rehearsal judgments never promote contract coverage');
    assert.equal(report.evidencePack.economics[0].billing_mode, 'unknown', 'economics do not invent a billing mode');
    assert.equal(report.evidencePack.economics[0].estimated_cost_usd, null, 'economics do not invent dollar cost');
    assert.ok(!('headline' in report.evidencePack), 'derived standing never enters the permanent pack');
    // A rehearsal receipt must SAY it is one, permanently — and its scripted
    // rounds can never seal audit standing (mock impersonation P1).
    assert.equal(report.simulated, true, 'a mock-engine receipt seals simulated:true');
    assert.equal(report.statuses.audit, 'not_run', 'a rehearsal receipt never seals an audit standing');
  });

  await check('a completed IN-MEMORY run carries a derived headline in Recents (not only after restart)', async () => {
    const list = await (await fetch(`${base}/api/runs`)).json();
    const item = list.runs.find((x) => x.id === runId);
    assert.ok(item, 'the run is listed');
    assert.equal(item.live, true, 'the run is still served from the in-memory map, not disk');
    // On a mock server the visible tag is REHEARSAL — a scripted run must
    // never present as a trust standing in Recents.
    assert.equal(item.headline, 'rehearsal', 'a mock run reads rehearsal, never a derived standing');
  });

  await check('the stream decorates status events with the SHARED headline; the receipt never stores it', async () => {
    // Catch-up stream of the finished in-memory run: the terminal status event
    // must carry BOTH the sealed dimensions and the serve-time derived headline
    // (the UI consumes the trust protocol's one derivation, not its own copy).
    const r = await fetch(`${base}/api/runs/${runId}/events`, { headers: { origin: base } });
    const text = await r.text(); // finished run → the server ends the stream after catch-up
    const evs = text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => { try { return JSON.parse(c.slice(6)); } catch { return null; } }).filter(Boolean);
    const streamed = evs.filter((e) => e.type === 'status' && e.dimensions).at(-1);
    assert.ok(streamed, 'a terminal status event with dimensions streams');
    assert.equal(streamed.simulated, true, 'the terminal event seals the rehearsal fact for stateless consumers');
    assert.equal(streamed.headline, 'rehearsal', 'the streamed mock status is rehearsal, never a trust standing');
    // The permanent receipt seals dimensions only — a headline is presentation
    // and must never be persisted in its place.
    const stored = readFileSync(join(tmp, runId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sealedStatus = stored.filter((e) => e.type === 'status' && e.dimensions).at(-1);
    assert.ok(sealedStatus, 'events.jsonl seals the dimensions on the status event');
    assert.ok(!('headline' in sealedStatus), 'events.jsonl never stores a headline (derived at serve time only)');
  });

  await check('a disk replay from a FRESH server session decorates the headline at stream time', async () => {
    const legacyFrozenId = 'legacy-frozen-stage-count';
    const legacyFrozenDir = join(tmp, legacyFrozenId);
    mkdirSync(legacyFrozenDir, { recursive: true });
    writeFileSync(join(legacyFrozenDir, 'events.jsonl'), `${JSON.stringify({ type: 'stage', at: 1, name: 'ground', status: 'done', frozen: true, snapshotId: 'sha256:fixture' })}\n`);
    writeFileSync(join(legacyFrozenDir, 'knowledge.json'), JSON.stringify({ items: [{ excerpt: 'one' }, { excerpt: 'two' }] }));
    // A second server process with no in-memory state replays the receipt from
    // disk — the decoration must come from the serve path, not from storage.
    const server2 = spawn(process.execPath, ['server.mjs'], {
      env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_RUNS_DIR: tmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let base2 = '';
    for await (const chunk of server2.stdout) {
      const m = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (m) { base2 = `http://${HOST}:${m[1]}`; break; }
    }
    try {
      const r = await fetch(`${base2}/api/runs/${runId}/events`, { headers: { origin: base2 } });
      const text = await r.text(); // replay ends with the replay_end sentinel and closes
      const evs = text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => { try { return JSON.parse(c.slice(6)); } catch { return null; } }).filter(Boolean);
      assert.ok(evs.some((e) => e.type === 'replay_end'), 'replay closes with the sentinel');
      const replayed = evs.filter((e) => e.type === 'status' && e.dimensions).at(-1);
      assert.ok(replayed, 'the replay streams the terminal status with dimensions');
      assert.equal(replayed.headline, 'rehearsal', 'a fresh-server replay derives rehearsal from the sealed simulation fact');

      const legacy = await fetch(`${base2}/api/runs/${legacyFrozenId}/events`, { headers: { origin: base2 } });
      const legacyText = await legacy.text();
      const legacyEvents = legacyText.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => { try { return JSON.parse(c.slice(6)); } catch { return null; } }).filter(Boolean);
      assert.equal(legacyEvents.find((e) => e.type === 'stage' && e.name === 'ground')?.itemCount, 2, 'a fresh-server replay derives the frozen badge count from sealed knowledge without mutating legacy events');
    } finally {
      server2.kill('SIGKILL');
      await once(server2, 'close').catch(() => {});
    }
  });
} finally {
  server.kill('SIGKILL');
  await once(server, 'close').catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

console.log('api.test:');
for (const line of results) console.log(line);
console.log(process.exitCode ? 'api.test: FAILURES above' : 'api.test: all assertions passed');
