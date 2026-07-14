// Codex reviewer adapter. The spawn contract is ported from camus
// (skills/camus/scripts/codex_review.sh): `codex exec --json -s read-only
// --output-schema <schema> -o <last_file> "<prompt>"`, stdin ignored, verdict
// captured from the -o file, and — the part that matters — fail-closed
// normalization: unparseable, empty, or self-inconsistent output is an infra
// error, never a clean verdict.

import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from '../models.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'checks', 'review.schema.json');

const IDLE_KILL_MS = Number(process.env.REVIEW_IDLE_MS || 300_000);
const TOTAL_TIMEOUT_MS = { low: 420_000, medium: 600_000, high: 900_000 };

function infraError(error) {
  return { ran: false, error, verdict: 'ERROR', findings: [], questions: [] };
}

// Mirrors camus's normalize_codex guards, adapted to the content schema.
export function normalizeReview(raw, exitCode) {
  if (exitCode !== 0) return infraError(`codex exec exited ${exitCode}`);
  if (!raw || !raw.trim()) return infraError('empty codex output');
  let data;
  try {
    data = JSON.parse(raw.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, ''));
  } catch {
    return infraError(`unparseable codex output: ${raw.slice(0, 160)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return infraError('codex output is not a JSON object');
  }
  if (!['revise', 'clean'].includes(data.verdict)) {
    return infraError(`missing/invalid verdict: ${JSON.stringify(data.verdict)}`);
  }
  if (!Array.isArray(data.findings)) return infraError('findings is not an array');
  for (const f of data.findings) {
    if (!['high', 'medium', 'low'].includes(f?.severity) || !f?.title) {
      return infraError('finding has missing/invalid severity or title');
    }
  }
  const blocking = data.findings.filter((f) => f.severity !== 'low');
  // Consistency guards: a verdict may not contradict its own findings.
  if (data.verdict === 'revise' && blocking.length === 0 && !(data.questions_for_human?.length)) {
    return infraError("inconsistent: 'revise' with no blocking findings and no questions");
  }
  if (data.verdict === 'clean' && blocking.length > 0) {
    return infraError("inconsistent: 'clean' with blocking findings");
  }
  return {
    ran: true,
    error: null,
    verdict: data.verdict === 'clean' ? 'APPROVED' : 'REVISE',
    findings: data.findings,
    blocking,
    nonblocking: data.findings.filter((f) => f.severity === 'low'),
    questions: (data.questions_for_human ?? []).filter((q) => typeof q === 'string' && q.trim()),
  };
}

export async function runCodexReview({ prompt, cwd, effort, signal, onTick, onSession, receiptDir, model }) {
  effort ||= getModels().reviewer.effort;
  model ||= getModels().reviewer.model;
  // codex resolves -o against ITS cwd, not ours — the path must be absolute.
  const dir = resolve(receiptDir);
  await mkdir(dir, { recursive: true });
  const lastFile = join(dir, 'last.json');

  // Model and effort are always named explicitly — the account default is
  // never reachable (it isn't a decision anyone made).
  const args = ['exec', '--json', '-s', 'read-only', '-m', model, '-c', `model_reasoning_effort=${effort}`];
  if (process.env.CAMUS_CODEX_TIER) args.push('-c', `service_tier=${process.env.CAMUS_CODEX_TIER}`);
  for (const id of (process.env.CAMUS_CODEX_DISABLE_MCP || '').split(',').filter(Boolean)) {
    args.push('-c', `mcp_servers.${id.trim()}.enabled=false`);
  }
  args.push('--output-schema', SCHEMA_PATH, '-o', lastFile, prompt);

  let stderrTail = '';
  const exitCode = await new Promise((done_) => {
    const child = spawn('codex', args, { cwd: resolve(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(hardT); clearTimeout(idleT); done_(code); } };

    const hardT = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, TOTAL_TIMEOUT_MS[effort] ?? 600_000);
    let idleT = setTimeout(() => { child.kill('SIGKILL'); finish(-3); }, IDLE_KILL_MS);
    const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => { child.kill('SIGKILL'); finish(-3); }, IDLE_KILL_MS); };

    let lastTick = 0;
    let lineBuf = '';
    const onData = (buf) => {
      poke();
      lineBuf += buf;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const sess = sessionLineFromCodexEvent(line);
        if (sess) onSession?.(sess);
      }
      const now = Date.now();
      if (now - lastTick > 5000) {
        lastTick = now;
        const line = String(buf).split('\n').find((l) => l.trim());
        onTick?.(summarizeEvent(line));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { poke(); stderrTail = (stderrTail + b).slice(-400); });
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish(-4); }, { once: true });
    child.on('error', (e) => { stderrTail = `spawn error: ${e.code || e.message}`; finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });

  if (exitCode === -1) return infraError(`failed to spawn codex (${stderrTail || 'unknown'}) — check the codex CLI is installed and on PATH`);
  if (exitCode === -2) return infraError('codex review hit the hard timeout');
  if (exitCode === -3) return infraError(`codex went silent for ${Math.round(IDLE_KILL_MS / 60000)} min — killed (idle watchdog)`);
  if (exitCode === -4) return infraError('review aborted by user');

  // "codex wrote nothing" and "the verdict file can't be read" are different
  // diagnoses — both fail closed, but only one sends you debugging codex.
  let raw = '';
  let readError = null;
  try {
    raw = await readFile(lastFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') readError = err;
  }
  const norm = readError
    ? infraError(`verdict file exists but could not be read (${readError.code || readError.message})`)
    : normalizeReview(raw, exitCode);
  if (!norm.ran && stderrTail) norm.error += ` | codex stderr: ${stderrTail.trim().split('\n').pop()}`;
  // These are actual invocation facts, not requested defaults: the adapter
  // appended both explicitly to argv and a ran:true verdict proves that exact
  // invocation completed. They ride the review event into the sealed pack.
  if (norm.ran) {
    norm.reviewerModel = model;
    norm.reviewerEffort = effort;
  }
  return norm;
}

// One codex --json event in, at most one session line out. Exported for tests.
export function sessionLineFromCodexEvent(line) {
  try {
    const ev = JSON.parse(line);
    const t = ev.msg?.type || ev.type || '';
    if (t === 'turn.started') return 'turn started';
    if (t === 'turn.completed') {
      const u = ev.usage ?? {};
      return `turn done · ${u.input_tokens ?? '?'} in / ${u.output_tokens ?? '?'} out tokens`;
    }
    if (t === 'item.completed') {
      const item = ev.item ?? {};
      const text = String(item.summary ?? item.text ?? '').replace(/\s+/g, ' ').trim();
      if (item.type === 'reasoning') return text ? `reasoning: ${text.slice(0, 110)}` : 'reasoning…';
      if (item.type === 'agent_message') return `verdict drafted (${text.length} chars)`;
      return text ? `${item.type}: ${text.slice(0, 90)}` : null;
    }
    if (/error/i.test(t)) return `error: ${String(ev.message ?? t).slice(0, 120)}`;
    return null;
  } catch {
    return null;
  }
}

function summarizeEvent(line) {
  if (!line) return 'reviewer working…';
  try {
    const ev = JSON.parse(line);
    const t = ev.msg?.type || ev.type || '';
    if (/error/i.test(t)) return `reviewer event: ${t}`;
    if (/message|item|delta|reasoning/i.test(t)) return 'reviewer reading and drafting findings…';
    if (/tool|command|exec/i.test(t)) return 'reviewer checking evidence…';
    return 'reviewer working…';
  } catch {
    return 'reviewer working…';
  }
}
