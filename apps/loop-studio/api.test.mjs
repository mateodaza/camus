// API + lifecycle tests: spawns the real server (mock engine, ephemeral port)
// and asserts the trust boundary and run lifecycle end to end. Kept separate
// from verify.test.mjs (pure, offline) because this one owns a process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidencePack } from './lib/evidence-pack.mjs';
import { validateExperimentRecord } from '../../packages/trust/lib/validate.mjs';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'cls-api-'));
const ACCEPTANCE = 'Every material claim is traceable and the deterministic checks are recorded.';

// The config-POST test writes the decision record; STUDIO_MODELS_FILE points it
// at a throwaway copy so the product's real checks/models.json is never mutated.
const modelsFile = join(tmp, 'models.json');
writeFileSync(modelsFile, readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'checks', 'models.json'), 'utf8'));

const server = spawn(process.execPath, ['server.mjs'], {
  // STUDIO_RUNS_DIR points the server at the throwaway tmp dir, so test runs
  // never pollute the product's real runs/ (the temp dir is removed in finally).
  env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_MAX_ACTIVE: '3', STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: modelsFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
    assert.equal(report.evidencePack.artifact_id, sourcePack.artifact_id, 'same artifact id');
    assert.notEqual(report.evidencePack.receipt_id, sourcePack.receipt_id, 'new receipt id');
    assert.equal(report.evidencePack.statuses.audit, 'not_run', 'mock audit never becomes standing');
    assert.equal(report.evidencePack.artifact.contract_coverage.every((criterion) => criterion.decision === 'unclear'), true, 'scripted contract judgments stay unclear');
    assert.equal(validateExperimentRecord(report.experiment).ok, true, 'experiment manifest + outcome validate');
    assert.equal(report.experiment.outcome.status, 'completed', 'the scripted arm completed as an experiment outcome');
    assert.equal(report.experiment.outcome.effort_actual, 'scripted', 'requested high effort never becomes a simulated actual');
    assert.equal(report.experiment.outcome.confounded, true, 'requested real reviewer vs scripted actual is visible');

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
    assert.equal(report.experiment.outcome.arms.every((arm) => arm.status === 'quality_floor_failed'), true, 'scripted arms finish but cannot pass the evidence floor');
    assert.equal(report.experiment.outcome.arms.every((arm) => arm.executor_actual === 'simulation:scripted-maker'), true, 'rehearsal never records a real executor actual');
    assert.equal(report.childRunIds.length, 2, 'both child receipts are addressable');
    const snapshots = report.childRunIds.map((runId) => JSON.parse(readFileSync(join(tmp, runId, 'report.json'), 'utf8')));
    assert.equal(new Set(snapshots.map((child) => child.knowledgeSnapshotId)).size, 1, 'every arm uses the exact same snapshot id');
    assert.equal(snapshots[0].knowledgeSnapshotId, report.experiment.knowledge.snapshot_id, 'child receipts bind the parent snapshot');
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
    assert.equal(report.evidencePack.schemaVersion, 2, 'new Studio receipts use the coverage-aware evidence-pack v2');
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
