#!/usr/bin/env node
// Camus Loop Studio — local server. Zero dependencies: Node stdlib http serves
// the UI, runs the loop, streams events over SSE, and writes receipts under
// runs/<id>/ (events.jsonl + every revision + report.json) so each run leaves
// a paper trail a skeptic can replay.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from './lib/engine.mjs';
import { runCodeLoop, validateBuildTarget, gateInstalled } from './lib/code-lane.mjs';
import { runMockCodeLoop } from './lib/adapters/mock.mjs';
import { runClaude } from './lib/adapters/claude.mjs';
import { runCodexReview } from './lib/adapters/codex.mjs';
import { createMockAdapters } from './lib/adapters/mock.mjs';
import * as hivemind from './lib/adapters/hivemind.mjs';
import { LANES } from './lib/verify.mjs';
import { getModels, updateModels, modelsSummary } from './lib/models.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
// Receipts live here. Tests and embeddings override it so a run never writes
// into the product's real runs/ directory (STUDIO_RUNS_DIR).
const RUNS_DIR = process.env.STUDIO_RUNS_DIR || join(__dirname, 'runs');
const PORT = Number(process.env.PORT || 1913); // Camus, b. 1913
const ENGINE = process.env.ENGINE === 'mock' ? 'mock' : 'live';

const runs = new Map(); // id -> { run, events, subscribers, answer, abort }

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

if (process.argv.includes('--doctor')) {
  const { runDoctor } = await import('./lib/doctor.mjs');
  const report = await runDoctor({ deep: true, engine: ENGINE });
  console.log('camus-loop-studio doctor');
  for (const c of report.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'MISS'}  ${c.label.padEnd(28)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`        fix: ${c.fix}`);
  }
  console.log(`  engine ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal — no model calls)' : ''}`);
  if (!report.ok) console.log('\n  Live engine is missing pieces. Rehearse meanwhile with: npm run rehearse');
  process.exit(report.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function newId() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

const activeBuilds = new Set();

async function startRun({ goal, lane, depth, ground, targetPath = null, targetToplevel = null, idSalt = null }) {
  const id = newId();
  const dir = join(RUNS_DIR, id);
  const scratchDir = join(dir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  // codex runs with cwd inside a git repo (same conditions camus reviews
  // under). A missing/failing git must not crash the server — degrade loudly.
  const gitOk = await new Promise((resolve) => {
    const child = spawn('git', ['init', '-q'], { cwd: scratchDir });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });

  const run = { id, goal, lane, depth, ground, targetPath, idSalt: lane === 'build' ? (idSalt || `studio-${id}`) : null, status: 'running', startedAt: Date.now(), lastMarkdown: null, rev: 0, costUsd: 0, receiptsDegraded: false };
  // The run exists on disk from second zero — a crash must not orphan it.
  writeFile(join(dir, 'run.json'), JSON.stringify({ id, goal, lane, depth, ground, targetPath, idSalt: run.idSalt, engine: ENGINE, startedAt: run.startedAt }, null, 2))
    .catch((err) => console.error(`[receipts] failed to write run.json for ${id}: ${err.message}`));
  const state = { run, events: [], subscribers: new Set(), answer: null, abort: new AbortController(), writeChain: Promise.resolve() };
  runs.set(id, state);

  // A failed receipt write must never be silent: receipts are the trust
  // story. Loud on the console, visible in the live feed, flagged in the
  // report (the flag survives even when the receipt file itself is the
  // thing that cannot be written).
  const persistFail = (what, err) => {
    console.error(`[receipts] failed to write ${what} for run ${id}: ${err.message}`);
    if (!run.receiptsDegraded) {
      run.receiptsDegraded = true;
      emit('log', { line: `⚠ receipts degraded — could not write ${what} (${err.code || err.message}); this run's paper trail is incomplete` });
    }
  };

  const emit = (type, data) => {
    const ev = { type, at: Date.now(), ...data };
    state.events.push(ev);
    const line = JSON.stringify(ev);
    // Receipts must read in the order things happened — serialize appends.
    state.writeChain = state.writeChain
      .then(() => appendFile(join(dir, 'events.jsonl'), line + '\n'))
      .catch((err) => persistFail('events.jsonl', err));
    for (const res of state.subscribers) res.write(`data: ${line}\n\n`);
    if (type === 'revision') {
      run.lastMarkdown = data.markdown;
      run.rev = data.rev;
      writeFile(join(dir, `rev-${data.rev}.md`), data.markdown).catch((err) => persistFail(`rev-${data.rev}.md`, err));
    }
    if (type === 'cost') run.costUsd = data.costUsd;
    if (type === 'status') run.status = data.status;
    // Server-side status must reflect a pending question, not just the UI's.
    if (type === 'question') run.status = 'needs_human';
    if (type === 'question_answered' && run.status === 'needs_human') run.status = 'running';
  };
  state.emit = emit;

  const waitForAnswer = (question) => {
    const qid = `q-${state.events.filter((e) => e.type === 'question').length + 1}`;
    emit('question', { id: qid, ...question });
    return new Promise((resolve) => {
      state.answer = { qid, resolve };
    });
  };

  const adapters =
    ENGINE === 'mock' ? (() => { const m = createMockAdapters(); return { claude: m.claude, codex: m.codex }; })()
      : { claude: runClaude, codex: runCodexReview };

  emit('run', { run: { id, goal, lane, depth, ground, targetPath, engine: ENGINE, roundCap: getModels().loop.roundCap } });
  if (!gitOk) emit('log', { line: '⚠ git unavailable — codex reviews will run outside a git repo (different conditions than camus)' });

  const runner = lane === 'build' ? (ENGINE === 'mock' ? runMockCodeLoop : runCodeLoop) : runLoop;
  runner(run, {
    emit,
    waitForAnswer,
    adapters,
    hivemind,
    signal: state.abort.signal,
    scratchDir,
    receiptsDir: dir,
  }).then(async (result) => {
    if (targetToplevel) activeBuilds.delete(targetToplevel);
    await state.writeChain; // receipt stream flushed before the report seals the run
    const report = JSON.stringify(
      { id, goal, lane, depth, ground, targetPath, idSalt: run.idSalt, engine: ENGINE, ...result, draft: undefined, deliverable: run.lastMarkdown, receiptsDegraded: run.receiptsDegraded, startedAt: run.startedAt, endedAt: Date.now() },
      null,
      2,
    );
    try {
      await writeFile(join(dir, 'report.json'), report);
    } catch (err) {
      // One retry, then say it plainly — a sealed-looking run with no report
      // would otherwise vanish from Recent runs with no explanation.
      await new Promise((r) => setTimeout(r, 500));
      await writeFile(join(dir, 'report.json'), report).catch((err2) => persistFail('report.json', err2));
    }
    for (const res of state.subscribers) res.end();
    state.subscribers.clear();
  });

  return id;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// The trust boundary. This server starts runs that spend money, so the API
// is AUTHORIZED, not just CORS-decorated — CORS headers only govern what a
// browser lets a page read; they never stop a request from executing.
//
// Layers (each independently sufficient against the drive-by-webpage class):
//   1. loopback bind by default (STUDIO_BIND to widen, explicitly)
//   2. Host allowlist (kills DNS-rebinding when loopback-bound)
//   3. Origin allowlist enforced BEFORE routing — a disallowed Origin gets
//      403, not merely "no CORS headers"
//   4. POST bodies must be application/json (no-cors requests cannot send it)
//   5. browser POSTs carry a per-session capability token, distributed only
//      via /api/status (which only allowed origins can read)
// Plus spend hygiene: goal-size cap and an active-run ceiling.
const BIND = process.env.STUDIO_BIND || '127.0.0.1';
const SESSION_TOKEN = randomBytes(16).toString('hex');
const MAX_ACTIVE_RUNS = Number(process.env.STUDIO_MAX_ACTIVE || 3);
const MAX_GOAL_CHARS = 2000;

// Hosted-UI default origins: camus.sh with and without www (the deployed
// studio UI — a decision, recorded here and in the README);
// STUDIO_ALLOWED_ORIGIN overrides (comma-separated for several).
const REMOTE_ORIGINS = (process.env.STUDIO_ALLOWED_ORIGIN || 'https://camus.sh,https://www.camus.sh')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

function actualPort() {
  return server.address()?.port ?? PORT;
}
function selfOrigins() {
  const p = actualPort();
  return [`http://localhost:${p}`, `http://127.0.0.1:${p}`];
}
function allowedOrigins() {
  return [...REMOTE_ORIGINS, ...selfOrigins()];
}

// Returns an error response spec when the request must not run.
function authorize(req) {
  const bindIsLoopback = ['127.0.0.1', 'localhost', '::1'].includes(BIND);
  const host = (req.headers.host || '').toLowerCase();
  if (bindIsLoopback && host && !host.startsWith('localhost:') && !host.startsWith('127.0.0.1:') && host !== 'localhost' && host !== '127.0.0.1') {
    return { code: 421, error: 'unrecognized Host header' }; // DNS rebinding
  }
  const origin = req.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    return { code: 403, error: 'origin not allowed' };
  }
  if (req.method === 'POST') {
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.startsWith('application/json')) {
      return { code: 415, error: 'POST bodies must be application/json' };
    }
    // Browser requests (they always carry Origin on POST) must present the
    // session token; non-browser local tools have machine access anyway.
    if (origin && req.headers['x-studio-token'] !== SESSION_TOKEN) {
      return { code: 401, error: 'missing or wrong session token — reload the page' };
    }
  }
  return null;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-studio-token',
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(Object.keys(cors).length ? 204 : 403, cors);
    return res.end();
  }
  const denied = authorize(req);
  if (denied) {
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    return json(res, denied.code, { error: denied.error });
  }
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  try {
    // ---- API ----
    if (path === '/api/doctor' && req.method === 'GET') {
      const { runDoctor } = await import('./lib/doctor.mjs');
      return json(res, 200, await runDoctor({ deep: url.searchParams.get('deep') === '1', engine: ENGINE }));
    }

    if (path === '/api/config' && req.method === 'GET') {
      const m = getModels();
      return json(res, 200, {
        maker: m.maker, reviewer: m.reviewer, loop: m.loop,
        envOverrides: ['CLAUDE_MODEL', 'CODEX_MODEL', 'CODEX_EFFORT', 'ROUND_CAP'].filter((k) => process.env[k] !== undefined),
      });
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const effort = body.effort;
      if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) {
        return json(res, 400, { error: 'effort must be low, medium, high, or xhigh' });
      }
      const roundCap = body.roundCap === undefined ? undefined : Number(body.roundCap);
      if (roundCap !== undefined && (!Number.isInteger(roundCap) || roundCap < 1 || roundCap > 6)) {
        return json(res, 400, { error: 'roundCap must be an integer from 1 to 6' });
      }
      const maker = body.maker?.trim() || undefined;
      const reviewer = body.reviewer?.trim() || undefined;
      const m = updateModels({ maker, reviewer, effort, roundCap });
      return json(res, 200, { maker: m.maker, reviewer: m.reviewer, loop: m.loop, note: 'applies from the next run' });
    }

    if (path === '/api/status' && req.method === 'GET') {
      return json(res, 200, {
        engine: ENGINE,
        token: SESSION_TOKEN,
        models: { maker: getModels().maker.model, reviewer: getModels().reviewer.model, effort: getModels().reviewer.effort },
        hivemind: hivemind.hivemindStatus(),
        gate: { installed: ENGINE === 'mock' ? true : gateInstalled() },
        roundCap: getModels().loop.roundCap,
        lanes: Object.fromEntries(Object.entries(LANES).map(([k, v]) => [k, v.label])),
      });
    }

    if (path === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      if (goal.length < 12) return json(res, 400, { error: 'Write the goal like you would brief a strategist — a sentence or two.' });
      if (goal.length > MAX_GOAL_CHARS) return json(res, 400, { error: `That goal is ${goal.length} characters — keep it under ${MAX_GOAL_CHARS}; a brief is not a corpus.` });
      const active = [...runs.values()].filter((s2) => ['running', 'needs_human'].includes(s2.run.status)).length;
      if (active >= MAX_ACTIVE_RUNS) return json(res, 429, { error: `${active} runs are already active — the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}.` });
      const lane = body.lane === 'build' ? 'build' : LANES[body.lane] ? body.lane : 'freeform';

      let targetPath = null;
      let targetToplevel = null;
      if (lane === 'build') {
        if (ENGINE === 'mock') {
          targetPath = String(body.targetPath || '~/demo-repo').trim();
        } else {
          if (!gateInstalled()) {
            return json(res, 400, { error: 'The camus gate is not installed on this machine. Fix: npm i -g camus-cli && camus install (then check Setup).' });
          }
          const v = await validateBuildTarget(body.targetPath);
          if (!v.ok) return json(res, 400, { error: v.error });
          targetPath = v.path;
          if (activeBuilds.size > 0) {
            return json(res, 409, { error: 'A build run is already going — the studio runs one gate at a time (its receipt watch is per-machine).' });
          }
          activeBuilds.add(v.toplevel);
          targetToplevel = v.toplevel;
        }
      }
      const id = await startRun({ goal, lane, depth: body.depth === 'standard' ? 'standard' : 'quick', ground: !!body.ground, targetPath, targetToplevel });
      return json(res, 201, { id });
    }

    if (path === '/api/runs' && req.method === 'GET') {
      const list = [];
      for (const [id, s] of runs) list.push({ id, goal: s.run.goal, lane: s.run.lane, status: s.run.status, startedAt: s.run.startedAt, live: true });
      if (existsSync(RUNS_DIR)) {
        for (const d of await readdir(RUNS_DIR)) {
          if (runs.has(d)) continue;
          try {
            const r = JSON.parse(await readFile(join(RUNS_DIR, d, 'report.json'), 'utf8'));
            list.push({ id: d, goal: r.goal, lane: r.lane, status: r.status, startedAt: r.startedAt, live: false });
          } catch {
            // No sealed report: if start metadata exists, this run was
            // interrupted — list it honestly instead of hiding it.
            try {
              const r = JSON.parse(await readFile(join(RUNS_DIR, d, 'run.json'), 'utf8'));
              list.push({ id: d, goal: r.goal, lane: r.lane, status: 'incomplete', startedAt: r.startedAt, live: false });
            } catch { /* neither file — not a run */ }
          }
        }
      }
      list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return json(res, 200, { runs: list.slice(0, 30) });
    }

    const m = path.match(/^\/api\/runs\/([\w-]+)\/(events|answer|stop|report|resume)$/);
    if (m) {
      const [, id, action] = m;
      const state = runs.get(id);

      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (state) {
          for (const ev of state.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          if (['running', 'needs_human'].includes(state.run.status) || state.answer) {
            state.subscribers.add(res);
            const ka = setInterval(() => res.write(': keepalive\n\n'), 20_000);
            req.on('close', () => { clearInterval(ka); state.subscribers.delete(res); });
          } else res.end();
          return;
        }
        // Finished run from a previous server session: replay the receipt.
        // The replay_end sentinel lets the client close instead of
        // auto-reconnecting forever on runs whose receipt has no terminal
        // status (e.g. the server crashed mid-run).
        const file = join(RUNS_DIR, id, 'events.jsonl');
        if (!existsSync(file)) { res.write(`data: ${JSON.stringify({ type: 'replay_end', empty: true })}\n\n`); res.end(); return; }
        const stream = createReadStream(file, 'utf8');
        let buf = '';
        stream.on('data', (c) => {
          buf += c;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) if (l.trim()) res.write(`data: ${l}\n\n`);
        });
        const finish = () => { res.write(`data: ${JSON.stringify({ type: 'replay_end' })}\n\n`); res.end(); };
        stream.on('end', finish);
        stream.on('error', finish); // a torn read must not crash the server
        return;
      }

      if (action === 'answer' && req.method === 'POST') {
        if (!state?.answer) return json(res, 409, { error: 'no question is pending on this run' });
        const { answer } = await readBody(req);
        if (typeof answer !== 'string' || !answer.trim()) return json(res, 400, { error: 'answer is required' });
        const { qid, resolve } = state.answer;
        state.answer = null;
        state.emit('question_answered', { id: qid }); // through emit → receipts + replay
        resolve(answer.trim());
        return json(res, 200, { ok: true });
      }

      if (action === 'stop' && req.method === 'POST') {
        if (!state) return json(res, 404, { error: 'unknown run' });
        state.abort.abort();
        if (state.answer) {
          const { qid, resolve } = state.answer;
          state.answer = null;
          state.emit('question_answered', { id: qid });
          resolve('Stop the run');
        }
        return json(res, 200, { ok: true });
      }

      if (action === 'resume' && req.method === 'POST') {
        // Build-lane only: camus is crash-safe, so a stopped/failed run
        // resumes by re-invoking the gate with the SAME identity (idSalt) —
        // finished work skips, proven work lands, only unproven work re-runs.
        let meta = state?.run;
        if (!meta) {
          try { meta = JSON.parse(await readFile(join(RUNS_DIR, id, 'report.json'), 'utf8')); }
          catch {
            try { meta = JSON.parse(await readFile(join(RUNS_DIR, id, 'run.json'), 'utf8')); }
            catch { return json(res, 404, { error: 'unknown run — nothing to resume' }); }
          }
        }
        if (meta.lane !== 'build') return json(res, 400, { error: 'only build runs resume through the gate' });
        if (!meta.idSalt) return json(res, 400, { error: 'this run predates resumable receipts — start a fresh build run instead (the gate itself still skips finished work)' });
        if (state && ['running', 'needs_human'].includes(state.run.status)) {
          return json(res, 409, { error: 'that run is still going' });
        }
        if (ENGINE !== 'mock') {
          const v = await validateBuildTarget(meta.targetPath);
          if (!v.ok) return json(res, 400, { error: `the original target no longer validates: ${v.error}` });
          if (activeBuilds.size > 0) return json(res, 409, { error: 'a build run is already going — one gate at a time' });
          activeBuilds.add(v.toplevel);
          const newId = await startRun({ goal: meta.goal, lane: 'build', depth: 'quick', ground: false, targetPath: v.path, targetToplevel: v.toplevel, idSalt: meta.idSalt });
          return json(res, 201, { id: newId });
        }
        const newId = await startRun({ goal: meta.goal, lane: 'build', depth: 'quick', ground: false, targetPath: meta.targetPath, idSalt: meta.idSalt });
        return json(res, 201, { id: newId });
      }

      if (action === 'report' && req.method === 'GET') {
        try {
          return json(res, 200, JSON.parse(await readFile(join(RUNS_DIR, id, 'report.json'), 'utf8')));
        } catch (err) {
          // Missing = still pending; unreadable/corrupt = data loss. Say which.
          return err.code === 'ENOENT'
            ? json(res, 404, { error: 'no report yet' })
            : json(res, 500, { error: `report exists but is unreadable: ${err.message}` });
        }
      }
    }

    // ---- Static ----
    if (req.method === 'GET') {
      const file = path === '/' ? 'index.html' : normalize(path).replace(/^([/\\])+/, '');
      const full = join(PUBLIC, file);
      if (full.startsWith(PUBLIC) && existsSync(full)) {
        res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
        createReadStream(full).pipe(res);
        return;
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — another studio server is probably running.`);
    console.error('  Stop it (or start this one on another port: PORT=1914 node server.mjs).\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, BIND, () => {
  const hm = hivemind.hivemindStatus();
  const p = actualPort();
  console.log(`\n  Camus Loop Studio\n  http://localhost:${p}\n  bind: ${BIND} · engine: ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal)' : ''} · hivemind: ${hm.connected ? 'connected' : 'stub'} · hosted origins: ${REMOTE_ORIGINS.join(', ')} · receipts: ./runs/\n`);
  if (process.platform === 'darwin' && process.env.OPEN !== '0' && !process.env.CI) {
    spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' }).on('error', () => {});
  }
});
