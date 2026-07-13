// Build lane — the studio ignites the real camus code gate and watches its
// receipts. The claude process is only the igniter: progress comes from what
// the gate persists (~/.camus/reviews round verdicts, the idSalt heartbeat),
// and the terminal verdict comes from the gate's own returned report. Camus
// is crash-safe by design, so Stop here never loses work: the gate's state
// survives and a fresh re-invocation with the same args resumes it.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sessionLineFromEvent } from './adapters/claude.mjs';
import { createGateCustodyGuard } from './gate-custody.mjs';
import { getModels } from './models.mjs';

const HARD_TIMEOUT_MS = Number(process.env.CODE_LANE_TIMEOUT_MS || 90 * 60_000);
const IDLE_KILL_MS = Number(process.env.CODE_LANE_IDLE_MS || 8 * 60_000);
const REVIEWS_DIR = join(homedir(), '.camus', 'reviews');

export function gateSupportsStudio({ workflow, worktreeGate }) {
  return workflow.includes('const STANDALONE_ID_SALT') && worktreeGate.includes('create|ensure|attach|resolve');
}

export function gateInstalled() {
  const root = join(homedir(), '.claude');
  const skill = join(root, 'skills', 'camus', 'SKILL.md');
  const workflow = join(root, 'workflows', 'camus-loop.workflow.js');
  const worktreeGate = join(root, 'skills', 'camus', 'scripts', 'wt.sh');
  if (![skill, workflow, worktreeGate].every(existsSync)) return false;
  try {
    return gateSupportsStudio({ workflow: readFileSync(workflow, 'utf8'), worktreeGate: readFileSync(worktreeGate, 'utf8') });
  } catch {
    return false;
  }
}

export function gateArgsForRun(run, roundCap, humanAnswer = null) {
  const args = {
    task: run.goal,
    targetPath: run.targetPath,
    policy: 'ask_on_ambiguity',
    roundCap,
    identitySalt: run.idSalt,
  };
  if (humanAnswer) args.humanAnswer = humanAnswer;
  return args;
}

const GATE_CUSTODY_PROMPT = `You are only the Camus Studio gate igniter. The /camus-loop invocation and every JSON argument are a binding custody contract. Start exactly one fresh camus-loop workflow. If it returns an asynchronous handle, resume only that same workflow run with the exact same args. Never start a second fresh workflow, alter or omit an arg, use another tool, inspect or repair the repository yourself, or work around an infra error. Return the workflow's terminal report verbatim; Studio owns every retry.`;

export function gateIgniterCliArgs(invocation) {
  return [
    '-p', invocation,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    // Do not narrow the process-wide built-in surface with --tools. Claude's
    // Workflow runtime inherits that surface, so "--tools Workflow" also
    // strips Bash/Read/Edit from camus-loop's child agents and makes the gate
    // fail before it can create its worktree. The system contract plus the
    // stream custody guard below constrain the OUTER igniter; the workflow
    // keeps the tools it needs to implement and verify.
    '--allowedTools', 'Workflow',
    '--append-system-prompt', GATE_CUSTODY_PROMPT,
  ];
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

function objectFrom(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PRIORITY_SEVERITY = Object.freeze({ 0: 'high', 1: 'high', 2: 'medium', 3: 'low' });

// Camus review files are envelopes: current gates persist the Codex verdict
// under codex_parsed, while older receipts may carry that object at the root
// or as stringified codex_raw. Normalize all known shapes once so the UI and
// sealed evidence cannot quietly disagree about what the auditor said.
export function reviewEventFromGateReceipt(raw, round) {
  const envelope = objectFrom(raw) ?? {};
  const parsed = objectFrom(envelope.codex_parsed)
    ?? objectFrom(envelope.codex_raw)
    ?? envelope;
  const rawVerdict = typeof parsed.overall_correctness === 'string' ? parsed.overall_correctness : null;
  const verdict = rawVerdict === 'patch is correct'
    ? 'APPROVED'
    : rawVerdict === 'patch is incorrect'
      ? 'REVISE'
      : 'UNKNOWN';
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map((finding) => {
    const priority = Number.isInteger(finding?.priority) ? finding.priority : null;
    return {
      severity: PRIORITY_SEVERITY[priority] ?? 'medium',
      priority,
      title: typeof finding?.title === 'string' ? finding.title : 'Untitled finding',
      detail: typeof finding?.detail === 'string' ? finding.detail : (typeof finding?.body === 'string' ? finding.body : ''),
      suggestion: typeof finding?.suggestion === 'string' ? finding.suggestion : '',
      location: typeof finding?.code_location === 'string' ? finding.code_location : null,
      confidence: typeof finding?.confidence_score === 'number' ? finding.confidence_score : null,
    };
  }) : [];
  return {
    round,
    verdict,
    rawVerdict,
    confidence: typeof parsed.overall_confidence_score === 'number' ? parsed.overall_confidence_score : null,
    explanation: typeof parsed.overall_explanation === 'string' ? parsed.overall_explanation : null,
    findings,
    source: 'camus_gate_review',
  };
}

// A successful gate status is a contract: camus-loop only returns done after
// deterministic verify passes. Preserve that provenance instead of inventing
// check counts the outer Workflow does not expose.
export function verifyEventFromGateReport(report) {
  if (!report || typeof report !== 'object') return null;
  const pass = ['done', 'done_with_findings'].includes(report.status)
    ? true
    : report.status === 'verify_failed'
      ? false
      : report.status === 'verify_inconclusive'
        ? null
        : undefined;
  if (pass === undefined) return null;
  return {
    pass,
    warnings: null,
    skipped: null,
    source: 'gate_report_status',
    derived: true,
    commitSha: report.commit_sha ?? report.commit ?? null,
    detail: report.note ?? null,
  };
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

  // One outer gate process per Studio attempt. A later human/resume attempt reuses the same
  // standalone custody identity; camus-loop's `ensure` lane returns its exact worktree.
  async function igniteGate(humanAnswer) {
    // identitySalt is intentionally NOT idSalt. idSalt means "owned by camus-feat" and enables
    // parent-tree containment whose precondition is a camus/feat-* parent checkout. Studio is a
    // standalone custodian: it needs one deterministic/resumable worktree + heartbeat without
    // impersonating a feat (the live smoke's first run failed containment, then an outer-agent
    // retry dropped the salt and forked a second worktree).
    const args = gateArgsForRun({ ...run, idSalt }, roundCap, humanAnswer);
    const invocation = `/camus-loop ${JSON.stringify(args)}`;
    log(humanAnswer ? 'Re-invoking the gate with your answer — it resumes from its own receipts.' : `Igniting the camus gate in ${run.targetPath}`);
    sess(`invocation: ${invocation.slice(0, 160)}`);

    const t0 = Date.now();
    const seenRounds = new Set();
    const parseTries = new Map(); // review files caught mid-write are retried, not sealed
    const PARSE_RETRIES = 3;      // ~3 polls before a parse failure is treated as stable
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
        // Parse BEFORE marking the file seen. A gate that writes the audit
        // non-atomically can be caught mid-write; a parse failure is retried on
        // later polls (bounded) so a transient truncated read never permanently
        // seals a valid audit as infra_failed. Only a STABLE failure emits an
        // UNKNOWN. (New gates write atomically via os.replace and never truncate.)
        let review;
        try {
          const raw = JSON.parse(await readFile(join(REVIEWS_DIR, r.file), 'utf8'));
          review = reviewEventFromGateReceipt(raw, r.round);
          parseTries.delete(r.file);
        } catch (err) {
          const tries = (parseTries.get(r.file) ?? 0) + 1;
          parseTries.set(r.file, tries);
          if (tries < PARSE_RETRIES) continue; // still unseen — a later poll retries the (maybe mid-write) file
          review = {
            round: r.round, verdict: 'UNKNOWN', rawVerdict: null, confidence: null,
            explanation: `unreadable review receipt after ${tries} attempts: ${String(err.message).slice(0, 120)}`,
            findings: [], source: 'camus_gate_review',
          };
        }
        seenRounds.add(r.file);
        lastActivity = Date.now();
        stage('review', 'done', { round: r.round });
        emit('round', { round: r.round, cap: roundCap });
        const blocking = review.findings.filter((f) => f.priority === null || f.priority <= 2).length;
        const verdictNote = review.verdict === 'APPROVED' ? 'clean'
          : review.verdict === 'REVISE' ? `revise (${blocking} blocking)`
            : 'unreadable receipt';
        for (const finding of review.findings) emit('finding', finding);
        emit('review', review);
        feedVerdict(r.round, verdictNote);
      }
      try {
        const hb = await stat(hbPath);
        if (hb.mtimeMs > lastActivity) lastActivity = hb.mtimeMs;
      } catch { /* heartbeat appears once the loop's thin runners start */ }
    }, 5000);
    const feedVerdict = (round, note) => log(`gate review round ${round}: ${note}`);

    const custody = createGateCustodyGuard(args);
    let custodyError = null;
    const { exitCode, resultText } = await new Promise((resolve) => {
      const child = spawn(
        'claude',
        gateIgniterCliArgs(invocation),
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
            const refused = custody.inspect(ev);
            if (refused) {
              custodyError = refused;
              child.kill('SIGKILL');
              finish(-5);
              break;
            }
            if (ev.type === 'result') result = String(ev.result ?? '');
            const s = sessionLineFromEvent(ev);
            if (s) sess(s);
          } catch { /* non-JSON noise */ }
        }
      });
      child.stderr.on('data', (b) => { err += b; lastActivity = Date.now(); });
      signal.addEventListener('abort', () => { child.kill('SIGTERM'); finish(-4); }, { once: true });
      child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
      child.on('close', (code) => {
        custodyError ||= custody.finish();
        finish(custodyError ? -5 : (code ?? -1));
      });
    });

    clearInterval(watcher);

    if (exitCode === -4) throw new Error('stopped_by_human');
    if (exitCode === -5) return { status: 'infra_error', note: custodyError || 'gate custody could not be established' };
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
    const verify = verifyEventFromGateReport(report);
    if (verify) emit('verify_result', verify);
    emit('gate_report', { report });

    if (terminal === 'needs_human_offline') {
      // review_unresolved carries stuck findings the studio can't relitigate —
      // surface honestly and stop; the terminal report has the trail.
      log('The gate halted on stuck findings (review_unresolved) — read its report; accept or refine from a camus session.');
      emit('status', { status: 'verify_failed', rev: 0, costUsd: null, billingMode: 'unknown' });
      return { status: 'verify_failed', report, answers };
    }

    emit('status', { status: terminal, rev: 0, costUsd: null, billingMode: 'unknown', artifactPublished: false, artifactUrl: null });
    return { status: terminal, report, answers };
  } catch (err) {
    if (err.message === 'stopped_by_human' || signal.aborted) {
      log('Stopped. The gate is crash-safe: its receipts and worktree survive — Resume re-invokes it and it continues.');
      emit('status', { status: 'stopped', costUsd: null, billingMode: 'unknown' });
      return { status: 'stopped', answers };
    }
    emit('error', { message: String(err.stack || err) });
    emit('status', { status: 'failed', costUsd: null, billingMode: 'unknown' });
    return { status: 'failed', error: String(err), answers };
  }
}
