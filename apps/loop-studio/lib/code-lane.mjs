// Build lane — the studio ignites the real camus code gate and watches its
// receipts. The claude process is only the igniter: progress comes from what
// the gate persists (~/.camus/reviews round verdicts, the idSalt heartbeat),
// and the terminal verdict comes from the gate's own returned report. Camus
// is crash-safe by design, so Stop here never loses work: the gate's state
// survives and a fresh re-invocation with the same args resumes it.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sessionLineFromEvent } from './adapters/claude.mjs';
import { getModels } from './models.mjs';

const HARD_TIMEOUT_MS = Number(process.env.CODE_LANE_TIMEOUT_MS || 90 * 60_000);
const IDLE_KILL_MS = Number(process.env.CODE_LANE_IDLE_MS || 8 * 60_000);
const REVIEWS_DIR = join(homedir(), '.camus', 'reviews');

export function gateInstalled() {
  return (
    existsSync(join(homedir(), '.claude', 'skills', 'camus', 'SKILL.md')) &&
    existsSync(join(homedir(), '.claude', 'workflows', 'camus-loop.workflow.js'))
  );
}

// Cheap, spend-free refusals before any model runs. The gate itself refuses
// more (unborn HEAD, dirty preflight, env checks) — those surface from its
// own report; these just save the user a spawn.
export async function validateBuildTarget(rawPath) {
  const path = rawPath?.trim().replace(/^~(?=\/|$)/, homedir());
  if (!path) return { ok: false, error: 'A build run needs the path to a git repository on this machine.' };
  if (/["'`$\\\n]/.test(path)) return { ok: false, error: 'The path contains shell-unsafe characters (quotes, $, backticks) — the gate refuses those.' };
  if (!existsSync(path)) return { ok: false, error: `No such directory: ${path}` };
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) return { ok: false, error: `${path} is not a directory.` };

  const git = (args) =>
    new Promise((resolve) => execFile('git', ['-C', path, ...args], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim())));
  if ((await git(['rev-parse', '--git-dir'])) === null) {
    return { ok: false, error: `${path} is not a git repository — the gate only works inside one.` };
  }
  if ((await git(['symbolic-ref', '-q', 'HEAD'])) === null) {
    return { ok: false, error: `${path} is on a detached HEAD — check out a branch first (the gate refuses detached HEADs).` };
  }
  const toplevel = await git(['rev-parse', '--show-toplevel']);
  return { ok: true, path, toplevel };
}

// The gate's answer comes back as prose wrapping a report object. Extract
// fail-closed: a run whose status we cannot read is NEVER done.
export function parseGateReport(text) {
  const statuses = ['done_with_findings', 'needs_human', 'needs_decision', 'review_unresolved', 'verify_failed', 'verify_inconclusive', 'infra_error', 'paused_by_user', 'aborted', 'done'];
  let report = null;
  // Prefer a parseable JSON object that carries a known status: try flat
  // objects first, then the greedy whole-text candidate.
  const candidates = [...(text.match(/\{[^{}]*\}/g) ?? []), ...(text.match(/\{[\s\S]*\}/) ?? [])];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && statuses.includes(obj.status)) { report = obj; break; }
    } catch { /* not this one */ }
  }
  if (!report) {
    // Statuses are ordered longest-first, so done_with_findings wins over
    // done. Camus prose wraps statuses in backticks or brackets and a status
    // can end the output — all of those count as boundaries.
    const found = statuses.find((st) => new RegExp(`(^|[\`"'\\s:{,(\\[])${st}($|[\`"'\\s,.;)\\]}])`).test(text));
    if (found) report = { status: found };
  }
  if (!report) return { status: 'infra_error', note: 'gate returned no readable status', raw: text.slice(0, 400) };
  // Pull the human question when the gate paused for one.
  if ((report.status === 'needs_human' || report.status === 'needs_decision') && !report.question) {
    const q = text.match(/"question"\s*:\s*"([^"]{10,400})"/) || text.match(/question[:\s]+["“]([^"”]{10,400})["”]/i);
    if (q) report.question = q[1];
  }
  return report;
}

async function reviewRoundsSince(t0) {
  try {
    const files = await readdir(REVIEWS_DIR);
    const rounds = [];
    for (const f of files) {
      const m = f.match(/-r(\d+)\.json$/);
      if (!m) continue;
      const st = await stat(join(REVIEWS_DIR, f)).catch(() => null);
      if (st && st.mtimeMs >= t0) rounds.push({ file: f, round: Number(m[1]), mtime: st.mtimeMs });
    }
    return rounds.sort((a, b) => a.mtime - b.mtime);
  } catch {
    return [];
  }
}

export async function runCodeLoop(run, ctx) {
  const { emit, waitForAnswer, signal } = ctx;
  const answers = [];
  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });
  const sess = (line) => emit('session', { actor: 'gate', line });

  async function ask(question) {
    const reply = await waitForAnswer(question);
    if (signal.aborted) throw new Error('stopped_by_human');
    answers.push({ kind: question.kind, question: question.text, answer: reply });
    emit('answer', { kind: question.kind, question: question.text, answer: reply });
    return reply;
  }

  const idSalt = run.idSalt || `studio-${run.id.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const hbPath = join(homedir(), '.camus', 'feats', `${idSalt}.hb`);
  const roundCap = getModels().loop.roundCap;

  // One gate invocation. Re-invoked fresh for resume — camus's own state
  // (deterministic identity via idSalt) continues where it left off.
  async function igniteGate(humanAnswer) {
    const args = { task: run.goal, targetPath: run.targetPath, policy: 'ask_on_ambiguity', roundCap, idSalt };
    if (humanAnswer) args.humanAnswer = humanAnswer;
    const invocation = `/camus-loop ${JSON.stringify(args)}`;
    log(humanAnswer ? 'Re-invoking the gate with your answer — it resumes from its own receipts.' : `Igniting the camus gate in ${run.targetPath}`);
    sess(`invocation: ${invocation.slice(0, 160)}`);

    const t0 = Date.now();
    const seenRounds = new Set();
    let wtPrefix = null; // first receipt names the worktree; later rounds must match
    let lastActivity = Date.now();

    const watcher = setInterval(async () => {
      // Round receipts are the gate's own truth — surface them as they land.
      // The studio enforces one gate at a time, and the first receipt binds
      // this run to its worktree so a stray file never cross-contaminates.
      for (const r of await reviewRoundsSince(t0)) {
        if (seenRounds.has(r.file)) continue;
        const prefix = r.file.replace(/-r\d+\.json$/, '');
        if (wtPrefix === null) wtPrefix = prefix;
        else if (prefix !== wtPrefix) continue;
        seenRounds.add(r.file);
        lastActivity = Date.now();
        let verdictNote = 'verdict recorded';
        try {
          const raw = JSON.parse(await readFile(join(REVIEWS_DIR, r.file), 'utf8'));
          const blocking = (raw.findings ?? []).filter((f) => Number(f.priority) <= 2).length;
          if (raw.overall_correctness === 'patch is correct') verdictNote = 'clean';
          else if (raw.overall_correctness === 'patch is incorrect') verdictNote = `revise (${blocking} blocking)`;
        } catch { /* receipt shape drift — stay honest */ }
        stage('review', 'done', { round: r.round });
        emit('round', { round: r.round, cap: roundCap });
        feedVerdict(r.round, verdictNote);
      }
      try {
        const hb = await stat(hbPath);
        if (hb.mtimeMs > lastActivity) lastActivity = hb.mtimeMs;
      } catch { /* heartbeat appears once the loop's thin runners start */ }
    }, 5000);
    const feedVerdict = (round, note) => log(`gate review round ${round}: ${note}`);

    const { exitCode, resultText } = await new Promise((resolve) => {
      const child = spawn(
        'claude',
        ['-p', invocation, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'],
        { cwd: run.targetPath, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let lineBuf = '';
      let result = null;
      let err = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(hardT);
        clearInterval(idleT);
        resolve({ exitCode: code, resultText: result ?? err });
      };
      const hardT = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, HARD_TIMEOUT_MS);
      const idleT = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_KILL_MS) { child.kill('SIGKILL'); finish(-3); }
      }, 30_000);
      child.stdout.on('data', (b) => {
        lastActivity = Date.now();
        lineBuf += b;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'result') result = String(ev.result ?? '');
            const s = sessionLineFromEvent(ev);
            if (s) sess(s);
          } catch { /* non-JSON noise */ }
        }
      });
      child.stderr.on('data', (b) => { err += b; lastActivity = Date.now(); });
      signal.addEventListener('abort', () => { child.kill('SIGTERM'); finish(-4); }, { once: true });
      child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
      child.on('close', (code) => finish(code ?? -1));
    });

    clearInterval(watcher);

    if (exitCode === -4) throw new Error('stopped_by_human');
    if (exitCode === -1) return { status: 'infra_error', note: `failed to spawn claude (${String(resultText).slice(0, 200)})` };
    if (exitCode === -2) return { status: 'infra_error', note: `the gate hit the studio's ${Math.round(HARD_TIMEOUT_MS / 60000)} min ceiling — its state is preserved; Resume continues it` };
    if (exitCode === -3) return { status: 'infra_error', note: `no gate activity for ${Math.round(IDLE_KILL_MS / 60000)} min (no receipts, no heartbeat, no output) — killed fail-closed; state is preserved` };
    if (exitCode !== 0) return { status: 'infra_error', note: `claude exited ${exitCode}: ${String(resultText).slice(0, 300)}` };
    return parseGateReport(String(resultText));
  }

  try {
    stage('gate', 'active');
    let report = await igniteGate();

    // The gate pauses for humans; the studio is where the human answers.
    while (report.status === 'needs_human' || report.status === 'needs_decision') {
      stage('gate', 'done');
      const answer = await ask({
        kind: 'decision',
        text: report.question || 'The gate paused for a decision — its report has the detail. What should it do?',
      });
      stage('gate', 'active');
      report = await igniteGate(answer);
    }

    const terminal = {
      done: 'done',
      done_with_findings: 'done_with_findings',
      review_unresolved: 'needs_human_offline',
      verify_failed: 'verify_failed',
      verify_inconclusive: 'verify_failed',
      infra_error: 'failed',
      aborted: 'failed',
      paused_by_user: 'stopped',
    }[report.status] ?? 'failed';

    stage('gate', 'done', { pass: terminal.startsWith('done') });
    emit('gate_report', { report });

    if (terminal === 'needs_human_offline') {
      // review_unresolved carries stuck findings the studio can't relitigate —
      // surface honestly and stop; the terminal report has the trail.
      log('The gate halted on stuck findings (review_unresolved) — read its report; accept or refine from a camus session.');
      emit('status', { status: 'verify_failed', rev: 0, costUsd: 0 });
      return { status: 'verify_failed', report, answers };
    }

    emit('status', { status: terminal, rev: 0, costUsd: 0, artifactPublished: false, artifactUrl: null });
    return { status: terminal, report, answers };
  } catch (err) {
    if (err.message === 'stopped_by_human' || signal.aborted) {
      log('Stopped. The gate is crash-safe: its receipts and worktree survive — Resume re-invokes it and it continues.');
      emit('status', { status: 'stopped', costUsd: 0 });
      return { status: 'stopped', answers };
    }
    emit('error', { message: String(err.stack || err) });
    emit('status', { status: 'failed', costUsd: 0 });
    return { status: 'failed', error: String(err), answers };
  }
}
