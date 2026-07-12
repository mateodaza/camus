// API lifecycle tests: the real server, ephemeral port, mock engine.
// The trust boundary is asserted the way an attacker would probe it, and the
// lifecycle the way a browser drives it. Offline, no model calls.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Boot the server on an ephemeral port
// ---------------------------------------------------------------------------

const child = spawn('node', ['server.mjs'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '0', ENGINE: 'mock', OPEN: '0', MOCK_SPEED: '0.05', STUDIO_MAX_ACTIVE: '3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const port = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error(`server never printed its port: ${out}`)), 10_000);
  child.stdout.on('data', (b) => {
    out += b;
    const m = out.match(/http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
  child.on('exit', (c) => reject(new Error(`server exited early (${c}): ${out}`)));
});
const BASE = `http://127.0.0.1:${port}`;
const SELF = `http://localhost:${port}`;

const teardown = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', teardown);

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  // -------------------------------------------------------------------------
  // Trust boundary
  // -------------------------------------------------------------------------
  const status = await (await fetch(`${BASE}/api/status`)).json();
  assert.ok(status.token?.length >= 32, 'status hands out the session token');
  const TOKEN = status.token;

  // The reviewer's exact repro: a hostile origin starting a run.
  const evil = await post('/api/runs', {