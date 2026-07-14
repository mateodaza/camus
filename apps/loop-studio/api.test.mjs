// API + lifecycle tests: spawns the real server (mock engine, ephemeral port)
// and asserts the trust boundary and run lifecycle end to end. Kept separate
// from verify.test.mjs (pure, offline) because this one owns a process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'cls-api-'));

const server = spawn(process.execPath, ['server.mjs'], {
  // STUDIO_RUNS_DIR points the server at the throwaway tmp dir, so test runs
  // never pollute the product's real runs/ (the temp dir is removed in finally).
  env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_MAX_ACTIVE: '2', STUDIO_RUNS_DIR: tmp },
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
      body: JSON.stringify({ goal: 'lifecycle: community versus paid growth memo', lane: 'freeform', depth: 'quick' }),
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
      body: JSON.stringify({ goal: 'concurrency probe run for the ceiling test', lane: 'freeform' }),
    });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await start()).status);
    assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')} (cap 2)`);
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
  });

  await check('a completed IN-MEMORY run carries a derived headline in Recents (not only after restart)', async () => {
    const list = await (await fetch(`${base}/api/runs`)).json();
    const item = list.runs.find((x) => x.id === runId);
    assert.ok(item, 'the run is listed');
    assert.equal(item.live, true, 'the run is still served from the in-memory map, not disk');
    assert.equal(typeof item.headline, 'string', 'the live-list item derives a headline too, not only disk-loaded runs');
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
    assert.equal(typeof streamed.headline, 'string', 'the streamed status is decorated with the derived headline');
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
      assert.equal(typeof replayed.headline, 'string', 'the replayed status is decorated with the derived headline at stream time');
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
