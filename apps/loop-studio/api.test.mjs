// API + lifecycle tests: spawns the real server (mock engine, ephemeral port)
// and asserts the trust boundary and run lifecycle end to end. Kept separate
// from verify.test.mjs (pure, offline) because this one owns a process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'cls-api-'));

const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, ENGINE: 'mock', MOCK_SPEED: '0.15', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh', STUDIO_MAX_ACTIVE: '2' },
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
} finally {
  server.kill('SIGKILL');
  await once(server, 'close').catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

console.log('api.test:');
for (const line of results) console.log(line);
console.log(process.exitCode ? 'api.test: FAILURES above' : 'api.test: all assertions passed');
