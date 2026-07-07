// Camus Loop Studio — local server. Zero dependencies: Node stdlib http serves
// the UI, runs the loop, streams events over SSE, and writes receipts under
// runs/<id>/ (events.jsonl + every revision + report.json) so each run leaves
// a paper trail a skeptic can replay.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from './lib/engine.mjs';
import { runClaude } from './lib/adapters/claude.mjs';
import { runCodexReview } from './lib/adapters/codex.mjs';
import { createMockAdapters } from './lib/adapters/mock.mjs';
import * as hivemind from './lib/adapters/hivemind.mjs';
import { LANES } from './lib/verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const RUNS_DIR = join(__dirname, 'runs');
const PORT = Number(process.env.PORT || 1913); // Camus, b. 1913
const ENGINE = process.env.ENGINE === 'mock' ? 'mock' : 'live';

const runs = new Map(); // id -> { run, events, subscribers, answer, abort }

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

if (process.argv.includes('--doctor')) {
  const check = (cmd, args) =>
    new Promise((resolve) =>
      execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) =>
        resolve(err ? `MISSING (${err.code ?? err.message})` : String(stdout || stderr).trim().split('\n')[0]),
      ),
    );
  const [claudeV, codexV] = await Promise.all([check('claude', ['--version']), check('codex', ['--version'])]);
  const hm = hivemind.hivemindStatus();
  console.log(`camus-loop-studio doctor
  node     ${process.version}
  claude   ${claudeV}
  codex    ${codexV}
  hivemind ${hm.connected ? `connected (${hm.base})` : 'not connected — stub adapter (set HIVEMIND_API_URL + HIVEMIND_API_KEY)'}
  engine   ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal — no model calls)' : ''}`);
  const broken = ENGINE === 'live' && (claudeV.startsWith('MISSING') || codexV.startsWith('MISSING'));
  if (broken) console.log('\n  Live engine needs both CLIs on PATH. Rehearse with: npm run rehearse');
  process.exit(broken ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function newId() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

async function startRun({ goal, lane, depth, ground }) {
  const id = newId();
  const dir = join(RUNS_DIR, id);
  const scratchDir = join(dir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  // codex runs with cwd inside a git repo (same conditions camus reviews under)
  await new Promise((r) => spawn('git', ['init', '-q'], { cwd: scratchDir }).on('close', r));

  const run = { id, goal, lane, depth, ground, status: 'running', startedAt: Date.now(), lastMarkdown: null, rev: 0, costUsd: 0 };
  const state = { run, events: [], subscribers: new Set(), answer: null, abort: new AbortController(), writeChain: Promise.resolve() };
  runs.set(id, state);

  const emit = (type, data) => {
    const ev = { type, at: Date.now(), ...data };
    state.events.push(ev);
    const line = JSON.stringify(ev);
    // Receipts must read in the order things happened — serialize appends.
    state.writeChain = state.writeChain.then(() => appendFile(join(dir, 'events.jsonl'), line + '\n')).catch(() => {});
    for (const res of state.subscribers) res.write(`data: ${line}\n\n`);
    if (type === 'revision') {
      run.lastMarkdown = data.markdown;
      run.rev = data.rev;
      writeFile(join(dir, `rev-${data.rev}.md`), data.markdown).catch(() => {});
    }
    if (type === 'cost') run.costUsd = data.costUsd;
    if (type === 'status') run.status = data.status;
  };

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

  emit('run', { run: { id, goal, lane, depth, ground, engine: ENGINE, roundCap: process.env.ROUND_CAP || 3 } });

  runLoop(run, {
    emit,
    waitForAnswer,
    adapters,
    hivemind,
    signal: state.abort.signal,
    scratchDir,
    receiptsDir: dir,
  }).then(async (result) => {
    await state.writeChain; // receipt stream flushed before the report seals the run
    await writeFile(
      join(dir, 'report.json'),
      JSON.stringify(
        { id, goal, lane, depth, ground, engine: ENGINE, ...result, draft: undefined, deliverable: run.lastMarkdown, startedAt: run.startedAt, endedAt: Date.now() },
        null,
        2,
      ),
    ).catch(() => {});
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ---- API ----
    if (path === '/api/status' && req.method === 'GET') {
      return json(res, 200, {
        engine: ENGINE,
        hivemind: hivemind.hivemindStatus(),
        roundCap: Number(process.env.ROUND_CAP || 3),
        lanes: Object.fromEntries(Object.entries(LANES).map(([k, v]) => [k, v.label])),
      });
    }

    if (path === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      if (goal.length < 12) return json(res, 400, { error: 'Write the goal like you would brief a strategist — a sentence or two.' });
      const lane = LANES[body.lane] ? body.lane : 'freeform';
      const id = await startRun({ goal, lane, depth: body.depth === 'standard' ? 'standard' : 'quick', ground: !!body.ground });
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
          } catch { /* unfinished run without a report — skip */ }
        }
      }
      list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return json(res, 200, { runs: list.slice(0, 30) });
    }

    const m = path.match(/^\/api\/runs\/([\w-]+)\/(events|answer|stop|report)$/);
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
        const file = join(RUNS_DIR, id, 'events.jsonl');
        if (!existsSync(file)) { res.end(); return; }
        const stream = createReadStream(file, 'utf8');
        let buf = '';
        stream.on('data', (c) => {
          buf += c;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) if (l.trim()) res.write(`data: ${l}\n\n`);
        });
        stream.on('end', () => res.end());
        return;
      }

      if (action === 'answer' && req.method === 'POST') {
        if (!state?.answer) return json(res, 409, { error: 'no question is pending on this run' });
        const { answer } = await readBody(req);
        if (typeof answer !== 'string' || !answer.trim()) return json(res, 400, { error: 'answer is required' });
        const { qid, resolve } = state.answer;
        state.answer = null;
        state.events.push({ type: 'question_answered', id: qid, at: Date.now() });
        for (const sub of state.subscribers) sub.write(`data: ${JSON.stringify({ type: 'question_answered', id: qid })}\n\n`);
        resolve(answer.trim());
        return json(res, 200, { ok: true });
      }

      if (action === 'stop' && req.method === 'POST') {
        if (!state) return json(res, 404, { error: 'unknown run' });
        state.abort.abort();
        if (state.answer) { const { resolve } = state.answer; state.answer = null; resolve('Stop the run'); }
        return json(res, 200, { ok: true });
      }

      if (action === 'report' && req.method === 'GET') {
        try {
          return json(res, 200, JSON.parse(await readFile(join(RUNS_DIR, id, 'report.json'), 'utf8')));
        } catch {
          return json(res, 404, { error: 'no report yet' });
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

server.listen(PORT, () => {
  const hm = hivemind.hivemindStatus();
  console.log(`\n  Camus Loop Studio\n  http://localhost:${PORT}\n  engine: ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal)' : ''} · hivemind: ${hm.connected ? 'connected' : 'stub'} · receipts: ./runs/\n`);
  if (process.platform === 'darwin' && process.env.OPEN !== '0' && !process.env.CI) {
    spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' }).on('error', () => {});
  }
});
