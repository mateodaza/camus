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
import { deriveEvidence, receiptCompleteness } from './lib/evidence.mjs';
import { buildEvidencePack } from './lib/evidence-pack.mjs';
import { buildAuditReplayPack, createAuditReplayExperiment, finalizeAuditReplayExperiment } from './lib/audit-replay.mjs';
import { createParallelExperiment, finalizeParallelExperiment, knowledgeSnapshotMatches, markParallelArmRunning, outcomeFromArmReport, sealKnowledgeSnapshot } from './lib/comparison.mjs';
import { validateExperimentRecord } from '../../packages/trust/lib/validate.mjs';
import { deriveStatusDimensions, deriveHeadline } from './lib/status-dims.mjs';
import { getModels, updateModels, modelsSummary, modelCatalog } from './lib/models.mjs';
import { reviewPrompt } from './lib/prompts.mjs';

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
  console.log(`  engine ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal, no model calls)' : ''}`);
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

const modelOfIdentity = (identity) => String(identity ?? '').split(':').slice(1).join(':');

const activeBuilds = new Set();

// Headlines are DERIVED at render from the sealed raw dimensions, never stored.
// null for a live or legacy run that has no dimensions yet. A rehearsal is its
// own visible tag — scripted rounds can never present as a trust standing, so
// the simulated flag outranks whatever the dimensions would read.
const headlineOf = (statuses, simulated = false) => {
  if (simulated) return 'rehearsal';
  try { return statuses ? deriveHeadline(statuses) : null; } catch { return null; }
};

// The headline rides OUTBOUND status events at serve time — live, catch-up, and
// disk replay alike — so the UI consumes the trust protocol's ONE derivation
// instead of re-deriving audit policy client-side (the advisory-audit P1: a UI
// copy of the rules claimed "verified" standing for a same-vendor audit).
// events.jsonl and report.json never store it: nothing may persist a headline
// in place of its dimensions.
const withHeadline = (ev) => (ev?.type === 'status' && ev.dimensions
  ? { ...ev, headline: headlineOf(ev.dimensions, ev.simulated === true) }
  : ev);
// Replayed receipt lines get the same serve-time decoration. Every line is
// parsed (no substring fast-path: a receipt re-serialized with different JSON
// spacing must not silently skip decoration); torn or non-JSON lines stream
// verbatim — fail-open on presentation, the receipt itself is untouched.
const decorateReplayLine = (l) => {
  try {
    const ev = JSON.parse(l);
    return ev?.type === 'status' ? JSON.stringify(withHeadline(ev)) : l;
  } catch { return l; }
};

async function startRun({
  goal,
  acceptanceContract,
  lane,
  depth,
  ground,
  targetPath = null,
  targetToplevel = null,
  idSalt = null,
  modelsSnapshot = null,
  frozenKnowledge = null,
  toolPolicy = null,
  publish = true,
  displayGoal = null,
  experimentContext = null,
  questionBroker = null,
  onComplete = null,
  reservationParentId = null,
}) {
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

  // Snapshot the model decisions ONCE at run creation — a settings edit mid-run
  // must never rewrite this run's manifest. This snapshot is the identity of
  // record (requested/resolved); the gate reports back the models it actually ran.
  const models = modelsSnapshot ? JSON.parse(JSON.stringify(modelsSnapshot)) : getModels();
  const run = { id, goal, displayGoal, acceptanceContract, lane, depth, ground, targetPath, idSalt: lane === 'build' ? (idSalt || `studio-${id}`) : null, status: 'running', startedAt: Date.now(), lastMarkdown: null, rev: 0, costUsd: 0, receiptsDegraded: false, models, frozenKnowledge, toolPolicy, publish, experimentContext };
  // The run exists on disk from second zero — a crash must not orphan it.
  writeFile(join(dir, 'run.json'), JSON.stringify({ id, goal, displayGoal, acceptanceContract, lane, depth, ground, targetPath, idSalt: run.idSalt, engine: ENGINE, models, knowledgeSnapshotId: frozenKnowledge?.snapshot_id ?? null, experimentContext, startedAt: run.startedAt }, null, 2))
    .catch((err) => console.error(`[receipts] failed to write run.json for ${id}: ${err.message}`));
  const state = { run, events: [], subscribers: new Set(), answer: null, abort: new AbortController(), writeChain: Promise.resolve() };
  runs.set(id, state);
  // A comparison parent reserves its child slots before any async retrieval or
  // directory setup. Replace one reservation with this live child atomically
  // when the child enters the run map, so another request cannot slip through
  // the ceiling between parent creation and arm creation.
  if (reservationParentId) {
    const parent = runs.get(reservationParentId);
    if (parent) parent.run.reservedChildSlots = Math.max(0, (parent.run.reservedChildSlots ?? 0) - 1);
  }

  // A failed receipt write must never be silent: receipts are the trust
  // story. Loud on the console, visible in the live feed, flagged in the
  // report (the flag survives even when the receipt file itself is the
  // thing that cannot be written).
  const persistFail = (what, err) => {
    console.error(`[receipts] failed to write ${what} for run ${id}: ${err.message}`);
    if (!run.receiptsDegraded) {
      run.receiptsDegraded = true;
      emit('log', { line: `⚠ receipts degraded: could not write ${what} (${err.code || err.message}); this run's paper trail is incomplete` });
    }
  };

  const emit = (type, data) => {
    const ev = { type, at: Date.now(), ...data };
    if (type === 'status') {
      run.status = data.status;
      // Ride the four orthogonal raw dimensions on the terminal status event,
      // derived from the evidence gathered so far. The headline is derived from
      // these at render, never sealed; report.json seals the same object below.
      try {
        run.statuses = deriveStatusDimensions({
          lane,
          status: data.status,
          evidence: deriveEvidence(state.events),
          published: !!(data.artifactPublished || data.artifactUrl),
          simulated: ENGINE === 'mock',
        });
        ev.dimensions = run.statuses;
        // Persist the raw rehearsal fact beside the dimensions. Without it a
        // fresh-server replay can only derive `unverified`, while Recents and
        // the page (which saw the earlier run event) correctly say rehearsal.
        // One receipt must not have two presentation labels.
        if (ENGINE === 'mock') ev.simulated = true;
      } catch { /* best-effort on the live event; the sealed report is authoritative */ }
    }
    state.events.push(ev);
    const line = JSON.stringify(ev);
    // Receipts must read in the order things happened — serialize appends.
    state.writeChain = state.writeChain
      .then(() => appendFile(join(dir, 'events.jsonl'), line + '\n'))
      .catch((err) => persistFail('events.jsonl', err));
    // Subscribers get the serve-time headline decoration; the persisted line
    // above stays headline-free (derived presentation, never sealed).
    const live = ev.type === 'status' ? JSON.stringify(withHeadline(ev)) : line;
    for (const res of state.subscribers) res.write(`data: ${live}\n\n`);
    if (type === 'revision') {
      run.lastMarkdown = data.markdown;
      run.rev = data.rev;
      writeFile(join(dir, `rev-${data.rev}.md`), data.markdown).catch((err) => persistFail(`rev-${data.rev}.md`, err));
    }
    if (type === 'cost') run.costUsd = data.costUsd;
    // Server-side status must reflect a pending question, not just the UI's.
    if (type === 'question') run.status = 'needs_human';
    if (type === 'question_answered' && run.status === 'needs_human') run.status = 'running';
  };
  state.emit = emit;

  const waitForAnswer = (question) => {
    const qid = `q-${state.events.filter((e) => e.type === 'question').length + 1}`;
    emit('question', { id: qid, ...question });
    if (questionBroker) {
      return questionBroker({ runId: id, armId: experimentContext?.armId ?? null, question })
        .then((answer) => {
          emit('question_answered', { id: qid });
          return answer;
        });
    }
    return new Promise((resolve) => {
      state.answer = { qid, resolve };
    });
  };

  const adapters =
    ENGINE === 'mock' ? (() => { const m = createMockAdapters(); return { claude: m.claude, codex: m.codex }; })()
      : { claude: runClaude, codex: runCodexReview };

  emit('run', { run: { id, goal: displayGoal ?? goal, acceptanceContract, lane, depth, ground, targetPath, engine: ENGINE, roundCap: models.loop.roundCap, experimentContext } });
  if (!gitOk) emit('log', { line: '⚠ git unavailable; codex reviews will run outside a git repo (different conditions than camus)' });

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
    // The receipt CARRIES the challenge trail, not just the final deliverable,
    // and tells the truth about its own completeness.
    const evidence = deriveEvidence(state.events);
    let { degraded: receiptsDegraded, note: receiptsNote } =
      receiptCompleteness({ lane, evidence, writeFailed: run.receiptsDegraded, status: run.status });
    // The dimensions rode the terminal status event (computed in emit); the
    // receipt seals the same object. Fall back to a fresh derivation only if a
    // run somehow ended without a status event. The headline is NEVER sealed.
    const statuses = run.statuses ?? deriveStatusDimensions({
      lane, status: run.status, evidence,
      published: !!(result?.artifactPublished || result?.artifactUrl),
      simulated: ENGINE === 'mock',
    });
    const endedAt = Date.now();
    let evidencePack = null;
    let evidencePackError = null;
    try {
      evidencePack = buildEvidencePack({
        goal,
        acceptanceContract,
        lane,
        targetPath,
        deliverable: run.lastMarkdown,
        evidence,
        statuses,
        models: run.models,
        makerActualModels: result?.makerActualModels ?? [],
        simulated: ENGINE === 'mock',
        createdAt: endedAt,
      });
    } catch (err) {
      evidencePackError = String(err.message || err);
      receiptsDegraded = true;
      receiptsNote = [receiptsNote, `the evidence pack could not be sealed: ${evidencePackError}`].filter(Boolean).join('; ');
    }
    // models is the run-start snapshot and is authoritative — it sits AFTER ...result
    // so a future result field named `models` can never overwrite the sealed pairing
    // (the same reason draft/deliverable are pinned after the spread). simulated is
    // pinned there too: a rehearsal receipt must SAY it is one, permanently.
    const reportObject = { id, goal, displayGoal, acceptanceContract, lane, depth, ground, targetPath, idSalt: run.idSalt, engine: ENGINE, ...result, models: run.models, simulated: ENGINE === 'mock', experimentContext, knowledgeSnapshotId: frozenKnowledge?.snapshot_id ?? null, draft: undefined, deliverable: run.lastMarkdown, evidence, evidencePack, evidencePackError, receiptsDegraded, receiptsNote, statuses, startedAt: run.startedAt, endedAt };
    const report = JSON.stringify(reportObject, null, 2);
    try {
      await writeFile(join(dir, 'report.json'), report);
    } catch (err) {
      // One retry, then say it plainly — a sealed-looking run with no report
      // would otherwise vanish from Recent runs with no explanation.
      await new Promise((r) => setTimeout(r, 500));
      await writeFile(join(dir, 'report.json'), report).catch((err2) => persistFail('report.json', err2));
    }
    try { await onComplete?.(reportObject); }
    catch (err) { console.error(`[comparison] completion hook failed for ${id}: ${err.message}`); }
    for (const res of state.subscribers) res.end();
    state.subscribers.clear();
  });

  return id;
}

// Re-audit one already-sealed research artifact. This is a new receipt over the
// SAME artifact, not a new loop: no maker runs, no knowledge is re-queried, the
// source verification and human decisions remain bound, and no fallback is
// permitted if the frozen reviewer disappears.
async function startAuditReplay({ sourceId, sourceReport, reviewerModel, effort, catalog }) {
  const id = newId();
  const dir = join(RUNS_DIR, id);
  const scratchDir = join(dir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  await new Promise((resolve) => {
    const child = spawn('git', ['init', '-q'], { cwd: scratchDir });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
  });

  const sourcePack = sourceReport.evidencePack;
  const startedAt = Date.now();
  const experiment = createAuditReplayExperiment({
    sourceRunId: sourceId,
    sourcePack,
    sourceEvidence: sourceReport.evidence,
    sourceDeliverable: sourceReport.deliverable,
    reviewerModel,
    effort,
    catalog,
    createdAt: startedAt,
  });
  const sourceGoal = sourceReport.goal ?? sourcePack.goal;
  const sourceContract = sourceReport.acceptanceContract ?? sourcePack.acceptance_contract;
  const displayGoal = `Audit-only replay: ${sourceGoal}`;
  const run = {
    id,
    goal: sourceGoal,
    displayGoal,
    acceptanceContract: sourceContract,
    lane: 'audit_replay',
    depth: sourceReport.depth,
    ground: false,
    targetPath: null,
    status: 'running',
    startedAt,
    lastMarkdown: sourceReport.deliverable,
    rev: sourceReport.evidence?.revisions?.at(-1)?.rev ?? sourceReport.rev ?? 1,
    costUsd: 0,
    receiptsDegraded: false,
    sourceRunId: sourceId,
    experiment,
  };
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    id,
    goal: run.goal,
    displayGoal,
    acceptanceContract: run.acceptanceContract,
    lane: run.lane,
    engine: ENGINE,
    sourceRunId: sourceId,
    experiment,
    startedAt,
  }, null, 2));

  const state = { run, events: [], subscribers: new Set(), answer: null, abort: new AbortController(), writeChain: Promise.resolve() };
  runs.set(id, state);
  const persistFail = (what, err) => {
    console.error(`[receipts] failed to write ${what} for audit replay ${id}: ${err.message}`);
    run.receiptsDegraded = true;
  };
  const emit = (type, data) => {
    const ev = { type, at: Date.now(), ...data };
    if (type === 'status') {
      run.status = data.status;
      if (data.dimensions) {
        run.statuses = data.dimensions;
        ev.dimensions = data.dimensions;
      }
      if (ENGINE === 'mock') ev.simulated = true;
    }
    state.events.push(ev);
    const line = JSON.stringify(ev);
    state.writeChain = state.writeChain
      .then(() => appendFile(join(dir, 'events.jsonl'), line + '\n'))
      .catch((err) => persistFail('events.jsonl', err));
    const live = type === 'status' ? JSON.stringify(withHeadline(ev)) : line;
    for (const res of state.subscribers) res.write(`data: ${live}\n\n`);
    if (type === 'revision') writeFile(join(dir, `rev-${data.rev}.md`), data.markdown).catch((err) => persistFail(`rev-${data.rev}.md`, err));
    if (type === 'question') run.status = 'needs_human';
    if (type === 'question_answered' && run.status === 'needs_human') run.status = 'running';
  };
  state.emit = emit;
  const waitForAnswer = (text) => {
    const qid = `q-${state.events.filter((event) => event.type === 'question').length + 1}`;
    emit('question', { id: qid, kind: 'adjudication', text });
    return new Promise((resolve) => { state.answer = { qid, resolve }; });
  };

  emit('run', { run: { id, goal: displayGoal, acceptanceContract: run.acceptanceContract, lane: 'audit_replay', ground: false, engine: ENGINE, sourceRunId: sourceId } });
  emit('revision', { rev: run.rev, markdown: sourceReport.deliverable });
  emit('log', { line: `Artifact locked to ${sourcePack.artifact_id.slice(0, 19)}…; source receipt ${sourcePack.receipt_id.slice(0, 19)}…. No maker or retrieval will run.` });
  emit('log', { line: `Reviewer catalog frozen now; ${reviewerModel} at requested effort ${effort}, fallback none.` });

  void (async () => {
    let review = null;
    let evidencePack = null;
    let evidencePackError = null;
    let finalExperiment = experiment;
    const auditAnswers = [];
    try {
      const claims = (sourcePack.artifact.claims ?? []).map(({ decision, ...claim }) => claim);
      const criteria = (sourcePack.artifact.contract_coverage ?? []).map(({ decision, ...criterion }) => criterion);
      const contentAnswers = sourcePack.human_decisions
        .filter((decision) => decision.kind === 'decision')
        .map((decision) => ({ question: decision.question, answer: decision.answer }));
      const adapter = ENGINE === 'mock' ? createMockAdapters().codex : runCodexReview;
      emit('stage', { name: 'review', status: 'active', scope: 'audit_replay' });
      review = await adapter({
        model: reviewerModel,
        effort,
        prompt: reviewPrompt({
          goal: sourcePack.goal,
          acceptanceContract: sourcePack.acceptance_contract,
          lane: sourceReport.lane,
          draft: sourceReport.deliverable,
          round: 'audit replay',
          priorFindings: [],
          answers: contentAnswers,
          groundingEvidence: sourceReport.evidence?.grounding ?? null,
          claims,
          criteria,
          auditOnly: true,
        }),
        claims,
        criteria,
        auditOnly: true,
        cwd: scratchDir,
        signal: state.abort.signal,
        onTick: (line) => emit('log', { line }),
        onSession: (line) => emit('session', { actor: 'reviewer', line }),
        receiptDir: join(dir, 'review-audit-only'),
      });
      emit('review', {
        round: 'audit replay',
        scope: 'audit_replay',
        rev: run.rev,
        verdict: review.verdict,
        findings: review.findings ?? [],
        questions: review.questions ?? [],
        reviewerModel: review.reviewerModel ?? reviewerModel,
        reviewerEffort: review.reviewerEffort ?? effort,
        claimAssessments: review.claimAssessments ?? [],
        coverageAssessments: review.coverageAssessments ?? [],
      });
      for (const finding of review.findings ?? []) emit('finding', { round: 'audit replay', scope: 'audit_replay', rev: run.rev, ...finding });
      emit('stage', { name: 'review', status: 'done', scope: 'audit_replay', verdict: review.verdict });
      for (const question of review.questions ?? []) {
        const answer = await waitForAnswer(question);
        if (state.abort.signal.aborted) break;
        const decision = { question, answer, at: Date.now() };
        auditAnswers.push(decision);
        emit('answer', { kind: 'adjudication', question, answer });
      }

      evidencePack = buildAuditReplayPack({
        sourcePack,
        review,
        reviewerModel,
        effort,
        experimentId: experiment.experiment_id,
        auditAnswers,
        simulated: ENGINE === 'mock',
        createdAt: Date.now(),
      });
      finalExperiment = finalizeAuditReplayExperiment(experiment, {
        pack: evidencePack,
        review,
        stopped: state.abort.signal.aborted,
        simulated: ENGINE === 'mock',
      });
    } catch (err) {
      evidencePackError = String(err.message || err);
      review = review?.ran === false ? review : { ran: false, error: evidencePackError, verdict: 'ERROR', findings: [], questions: [], claimAssessments: [], coverageAssessments: [], usage: review?.usage ?? null, durationMs: review?.durationMs ?? null };
      try {
        evidencePack = buildAuditReplayPack({ sourcePack, review, reviewerModel, effort, experimentId: experiment.experiment_id, auditAnswers, simulated: ENGINE === 'mock', createdAt: Date.now() });
        finalExperiment = finalizeAuditReplayExperiment(experiment, { pack: evidencePack, review, stopped: state.abort.signal.aborted, simulated: ENGINE === 'mock' });
      } catch (sealErr) {
        evidencePackError = `${evidencePackError}; ${String(sealErr.message || sealErr)}`;
        finalExperiment = finalizeAuditReplayExperiment(experiment, {
          pack: null,
          review: { ...review, ran: false, error: evidencePackError },
          stopped: state.abort.signal.aborted,
          simulated: ENGINE === 'mock',
        });
      }
    }

    const flatStatus = state.abort.signal.aborted
      ? 'stopped'
      : review?.ran
        ? (review.verdict === 'APPROVED' && !(review.findings ?? []).length && !(review.questions ?? []).length ? 'done' : 'done_with_findings')
        : 'failed';
    const statuses = evidencePack?.statuses ?? { ...sourcePack.statuses, audit: 'infra_failed' };
    emit('status', { status: flatStatus, rev: run.rev, dimensions: statuses, sourceRunId: sourceId });
    await state.writeChain;
    const endedAt = Date.now();
    const report = {
      id,
      goal: sourceGoal,
      displayGoal,
      acceptanceContract: sourceContract,
      lane: 'audit_replay',
      depth: sourceReport.depth,
      ground: false,
      engine: ENGINE,
      status: flatStatus,
      sourceRunId: sourceId,
      simulated: ENGINE === 'mock',
      deliverable: sourceReport.deliverable,
      evidence: deriveEvidence(state.events),
      evidencePack,
      evidencePackError,
      experiment: finalExperiment,
      receiptsDegraded: run.receiptsDegraded || !evidencePack,
      receiptsNote: evidencePack ? null : evidencePackError,
      statuses,
      startedAt,
      endedAt,
    };
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2)).catch((err) => persistFail('report.json', err));
    for (const res of state.subscribers) res.end();
    state.subscribers.clear();
  })();

  return { id, goal: displayGoal };
}

async function captureComparisonKnowledge({ goal, ground, retrieverModel, scratchDir, signal, emit }) {
  const none = () => sealKnowledgeSnapshot({
    query: goal,
    mode: 'none',
    items: [],
    retriever: { requested: null, resolved: null, actual: null },
  });
  if (!ground) return none();
  if (ENGINE === 'mock') {
    return sealKnowledgeSnapshot({
      query: goal,
      mode: 'simulation',
      items: [{
        query: goal,
        title: 'Scripted customer research snapshot',
        author: 'Camus rehearsal',
        ref: 'simulation-knowledge-1',
        score: null,
        excerpt: 'Customers respond better to concrete milestones and explicit tradeoffs than to broad promises.',
      }],
      retriever: { requested: `anthropic:${retrieverModel}`, resolved: `anthropic:${retrieverModel}`, actual: 'simulation:scripted-retriever' },
    });
  }

  const hm = hivemind.hivemindStatus();
  if (!hm.connected) throw new Error('Hivemind is not connected; choose an ungrounded comparison or fix Setup');
  if (hm.mode === 'claude') {
    const retrieval = await runClaude({
      model: retrieverModel,
      stage: 'ground',
      toolPolicy: 'hivemind_only',
      cwd: scratchDir,
      signal,
      onTick: (line) => emit('log', { line }),
      onSession: (line) => emit('session', { actor: 'retriever', line }),
      prompt: `Freeze a shared knowledge snapshot for parallel research arms. Use only the configured Hivemind knowledge_search tool. Run 2-4 focused queries for this goal, favoring evidence that can distinguish strategies and expose tradeoffs. Do not draft the answer.\n\nGOAL:\n${goal}\n\nAfter the tool calls, reply with one sentence saying the snapshot is ready.`,
    });
    if (!retrieval.ok) throw new Error(`knowledge retrieval failed: ${retrieval.error}`);
    if (!(retrieval.hivemindResults ?? []).length) throw new Error('the Hivemind retriever returned no captured result excerpts; no arms were started');
    return sealKnowledgeSnapshot({
      query: goal,
      mode: 'hivemind_claude',
      items: retrieval.hivemindResults,
      retriever: {
        requested: `anthropic:${retrieverModel}`,
        resolved: `anthropic:${retrieverModel}`,
        actual: retrieval.modelActual ?? `anthropic:${retrieverModel}`,
      },
    });
  }

  const items = await hivemind.searchKnowledge(goal, 8, (line) => emit('log', { line }));
  if (!Array.isArray(items) || !items.length) throw new Error(`Hivemind ${hm.mode} returned no frozen knowledge; no arms were started`);
  return sealKnowledgeSnapshot({
    query: goal,
    mode: hm.mode === 'mcp' ? 'hivemind_mcp' : 'hivemind_rest',
    items,
    retriever: {
      requested: `studio:hivemind_${hm.mode}`,
      resolved: `studio:hivemind_${hm.mode}`,
      actual: `studio:hivemind_${hm.mode}`,
    },
  });
}

async function startParallelComparison({ goal, acceptanceContract, lane, depth, ground, makerModels, reviewerModel, reviewerEffort, catalog, resumeExperiment = null, resumeSnapshot = null }) {
  const id = newId();
  const dir = join(RUNS_DIR, id);
  const scratchDir = join(dir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const startedAt = Date.now();
  const modelsAtStart = getModels();
  if (resumeExperiment) modelsAtStart.loop = { ...modelsAtStart.loop, roundCap: resumeExperiment.manifest.round_cap, source: 'resumed experiment manifest' };
  const run = {
    id,
    goal,
    displayGoal: `${resumeExperiment ? 'Recover' : 'Compare'} ${makerModels.join(' vs ')}: ${goal}`,
    acceptanceContract,
    lane: 'comparison',
    sourceLane: lane,
    depth,
    ground,
    status: 'running',
    startedAt,
    models: modelsAtStart,
    childRunIds: (resumeExperiment?.outcome?.arms ?? []).map((arm) => arm.run_id).filter(Boolean),
    experiment: resumeExperiment,
    reservedChildSlots: resumeExperiment ? 0 : makerModels.length,
  };
  const state = { run, events: [], subscribers: new Set(), answer: null, abort: new AbortController(), writeChain: Promise.resolve(), questionQueue: [] };
  runs.set(id, state);

  const persistFail = (what, err) => {
    console.error(`[receipts] failed to write ${what} for comparison ${id}: ${err.message}`);
    run.receiptsDegraded = true;
  };
  const emit = (type, data) => {
    const ev = { type, at: Date.now(), ...data };
    if (type === 'status') run.status = data.status;
    if (type === 'question') run.status = 'needs_human';
    if (type === 'question_answered') run.status = 'running';
    state.events.push(ev);
    const line = JSON.stringify(ev);
    state.writeChain = state.writeChain.then(() => appendFile(join(dir, 'events.jsonl'), `${line}\n`)).catch((err) => persistFail('events.jsonl', err));
    for (const res of state.subscribers) res.write(`data: ${line}\n\n`);
  };
  state.emit = emit;
  const persistStart = async () => writeFile(join(dir, 'run.json'), JSON.stringify({
    id,
    goal,
    displayGoal: run.displayGoal,
    acceptanceContract,
    lane: 'comparison',
    sourceLane: lane,
    depth,
    ground,
    engine: ENGINE,
    makerModels,
    reviewerModel,
    reviewerEffort,
    childRunIds: run.childRunIds,
    experiment: run.experiment,
    startedAt,
  }, null, 2));
  await persistStart();

  const pumpQuestions = () => {
    if (state.answer || !state.questionQueue.length) return;
    const next = state.questionQueue.shift();
    const qid = `q-${state.events.filter((event) => event.type === 'question').length + 1}`;
    emit('question', {
      id: qid,
      kind: next.question.kind,
      text: `${next.armId}: ${next.question.text}`,
      options: next.question.options,
      armId: next.armId,
      childRunId: next.runId,
    });
    state.answer = {
      qid,
      runId: next.runId,
      armId: next.armId,
      question: next.question,
      resolve: (answer) => {
        next.resolve(answer);
        queueMicrotask(pumpQuestions);
      },
    };
  };
  const questionBroker = ({ runId, armId, question }) => new Promise((resolve) => {
    state.questionQueue.push({ runId, armId, question, resolve });
    pumpQuestions();
  });

  emit('run', { run: { id, goal: run.displayGoal, acceptanceContract, lane: 'comparison', sourceLane: lane, depth, ground, engine: ENGINE, arms: makerModels } });
  emit('stage', { name: 'ground', status: 'active', scope: 'comparison' });

  void (async () => {
    let snapshot = null;
    let experiment = null;
    const outcomes = [];
    let terminalError = null;
    try {
      if (resumeExperiment) {
        if (!resumeSnapshot || !knowledgeSnapshotMatches(resumeSnapshot) || resumeSnapshot.snapshot_id !== resumeExperiment.knowledge.snapshot_id) {
          throw new Error('the original comparison knowledge snapshot is missing or no longer matches its sealed identity');
        }
        const validResume = validateExperimentRecord(resumeExperiment);
        if (!validResume.ok) throw new Error(`the original experiment cannot be resumed: ${validResume.error}`);
        snapshot = resumeSnapshot;
        experiment = resumeExperiment;
        emit('log', { line: 'Recovering the experiment from sealed child reports. Interrupted arms stay failed; no model or retrieval is rerun.' });
      } else {
        snapshot = await captureComparisonKnowledge({
          goal,
          ground,
          retrieverModel: makerModels[0],
          scratchDir,
          signal: state.abort.signal,
          emit,
        });
        experiment = createParallelExperiment({ goal, acceptanceContract, lane, depth, roundCap: modelsAtStart.loop.roundCap, snapshot, makerModels, reviewerModel, reviewerEffort, catalog, createdAt: startedAt });
      }
      await writeFile(join(dir, 'knowledge.json'), JSON.stringify(snapshot, null, 2));
      emit('knowledge_snapshot', { snapshotId: snapshot.snapshot_id, mode: snapshot.mode, itemCount: snapshot.items.length, privacy: snapshot.items.length ? 'internal' : 'none' });
      emit('stage', { name: 'ground', status: 'done', scope: 'comparison', snapshotId: snapshot.snapshot_id, itemCount: snapshot.items.length });
      run.experiment = experiment;
      await persistStart();
      emit('comparison_manifest', {
        experimentId: experiment.experiment_id,
        snapshotId: snapshot.snapshot_id,
        fallbackPolicy: 'none',
        arms: experiment.manifest.arms,
      });
      emit('stage', { name: 'arms', status: 'active', scope: 'comparison', count: experiment.manifest.arms.length });

      const tasks = experiment.manifest.arms.map(async (arm) => {
        const prior = experiment.outcome.arms.find((item) => item.arm_id === arm.arm_id);
        if (resumeExperiment) {
          if (prior?.run_id) {
            try {
              const priorReport = JSON.parse(await readFile(join(RUNS_DIR, prior.run_id, 'report.json'), 'utf8'));
              const recovered = outcomeFromArmReport({ experiment, armId: arm.arm_id, runId: prior.run_id, report: priorReport });
              emit('comparison_arm', { armId: arm.arm_id, runId: prior.run_id, model: modelOfIdentity(arm.executor.resolved), status: recovered.status, artifactId: recovered.artifact_id, receiptId: recovered.receipt_id, qualityFloor: recovered.quality_floor, usage: recovered.usage, recovered: true });
              return recovered;
            } catch { /* interrupted or torn child becomes explicit infra below */ }
          }
          const interrupted = {
            arm_id: arm.arm_id, run_id: prior?.run_id ?? null, status: 'infra_failed', artifact_id: null, receipt_id: null,
            executor_actual: null, auditor_actual: null, quality_floor: 'unknown',
            usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
            judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
            failure: { stage: 'execution', code: 'server_interrupted', detail: 'the child left no sealed report before the Studio server stopped; it was retained as failed and not silently rerun' }, confounded: false,
          };
          emit('comparison_arm', { armId: arm.arm_id, runId: interrupted.run_id, model: modelOfIdentity(arm.executor.resolved), status: interrupted.status, qualityFloor: interrupted.quality_floor, failure: interrupted.failure, recovered: true });
          return interrupted;
        }
        if (state.abort.signal.aborted) {
          return {
            arm_id: arm.arm_id, run_id: null, status: 'stopped', artifact_id: null, receipt_id: null,
            executor_actual: null, auditor_actual: null, quality_floor: 'unknown',
            usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
            judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
            failure: { stage: 'execution', code: 'stopped_by_human', detail: 'comparison stopped before the arm started' }, confounded: false,
          };
        }
        const maker = arm.executor.resolved.split(':').slice(1).join(':');
        let complete;
        const completion = new Promise((resolve) => { complete = resolve; });
        try {
          const childId = await startRun({
            goal,
            acceptanceContract,
            lane,
            depth,
            ground,
            modelsSnapshot: {
              maker: { model: maker, source: 'parallel experiment manifest' },
              reviewer: { model: reviewerModel, effort: reviewerEffort, modelSource: 'parallel experiment manifest', effortSource: 'parallel experiment manifest' },
              loop: { ...modelsAtStart.loop },
            },
            frozenKnowledge: snapshot,
            toolPolicy: 'none',
            publish: false,
            displayGoal: `${arm.arm_id} · ${maker}: ${goal}`,
            experimentContext: { experimentId: experiment.experiment_id, parentRunId: id, armId: arm.arm_id, knowledgeSnapshotId: snapshot.snapshot_id },
            questionBroker,
            onComplete: complete,
            reservationParentId: id,
          });
          run.childRunIds.push(childId);
          // The parent may have been stopped while startRun was preparing the
          // child directory. Do not let that narrow await window orphan a live
          // arm outside the parent's kill boundary.
          if (state.abort.signal.aborted) runs.get(childId)?.abort.abort();
          experiment = markParallelArmRunning(experiment, arm.arm_id, childId);
          run.experiment = experiment;
          await persistStart();
          emit('comparison_arm', { armId: arm.arm_id, runId: childId, model: maker, status: 'running' });
          const report = await completion;
          const outcome = outcomeFromArmReport({ experiment, armId: arm.arm_id, runId: childId, report });
          emit('comparison_arm', { armId: arm.arm_id, runId: childId, model: maker, status: outcome.status, artifactId: outcome.artifact_id, receiptId: outcome.receipt_id, qualityFloor: outcome.quality_floor, usage: outcome.usage });
          return outcome;
        } catch (err) {
          return {
            arm_id: arm.arm_id, run_id: null, status: state.abort.signal.aborted ? 'stopped' : 'infra_failed', artifact_id: null, receipt_id: null,
            executor_actual: null, auditor_actual: null, quality_floor: 'unknown',
            usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
            judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
            failure: { stage: 'execution', code: state.abort.signal.aborted ? 'stopped_by_human' : 'arm_start_failed', detail: String(err.message || err) }, confounded: false,
          };
        }
      });
      outcomes.push(...await Promise.all(tasks));
      run.childRunIds = [...new Set(outcomes.map((outcome) => outcome.run_id).filter(Boolean))];
      experiment = finalizeParallelExperiment(experiment, outcomes, { stopped: state.abort.signal.aborted });
    } catch (err) {
      terminalError = String(err.message || err);
      emit('error', { message: terminalError });
      if (!snapshot) {
        const hmMode = hivemind.hivemindStatus().mode;
        const mode = !ground ? 'none' : ENGINE === 'mock' ? 'simulation' : hmMode === 'claude' ? 'hivemind_claude' : hmMode === 'mcp' ? 'hivemind_mcp' : hmMode === 'rest' ? 'hivemind_rest' : 'none';
        const retriever = mode === 'none'
          ? { requested: null, resolved: null, actual: null }
          : mode === 'hivemind_claude'
            ? { requested: `anthropic:${makerModels[0]}`, resolved: `anthropic:${makerModels[0]}`, actual: null }
            : { requested: `studio:${mode}`, resolved: `studio:${mode}`, actual: null };
        snapshot = sealKnowledgeSnapshot({ query: goal, mode, items: [], retriever });
        await writeFile(join(dir, 'knowledge.json'), JSON.stringify(snapshot, null, 2)).catch((writeErr) => persistFail('knowledge.json', writeErr));
      }
      experiment ??= createParallelExperiment({ goal, acceptanceContract, lane, depth, roundCap: modelsAtStart.loop.roundCap, snapshot, makerModels, reviewerModel, reviewerEffort, catalog, createdAt: startedAt });
      const failed = experiment.manifest.arms.map((arm) => ({
        arm_id: arm.arm_id, run_id: null, status: state.abort.signal.aborted ? 'stopped' : 'infra_failed', artifact_id: null, receipt_id: null,
        executor_actual: null, auditor_actual: null, quality_floor: 'unknown',
        usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
        judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
        failure: { stage: 'knowledge', code: state.abort.signal.aborted ? 'stopped_by_human' : 'snapshot_failed', detail: terminalError }, confounded: false,
      }));
      experiment = finalizeParallelExperiment(experiment, failed, { stopped: state.abort.signal.aborted, infrastructureFailed: !state.abort.signal.aborted });
    }

    const status = state.abort.signal.aborted ? 'stopped' : experiment?.outcome.status === 'completed' ? 'done' : 'failed';
    emit('stage', { name: 'arms', status: 'done', scope: 'comparison' });
    emit('stage', { name: 'ship', status: 'done', scope: 'comparison' });
    emit('status', { status, experimentStatus: experiment?.outcome.status ?? 'infra_failed' });
    await state.writeChain;
    const report = {
      id,
      goal,
      displayGoal: run.displayGoal,
      acceptanceContract,
      lane: 'comparison',
      sourceLane: lane,
      depth,
      ground,
      engine: ENGINE,
      simulated: ENGINE === 'mock',
      status,
      experiment,
      knowledgeSnapshot: snapshot ? { snapshot_id: snapshot.snapshot_id, mode: snapshot.mode, item_count: snapshot.items.length } : null,
      childRunIds: run.childRunIds,
      error: terminalError,
      receiptsDegraded: run.receiptsDegraded === true || !experiment,
      startedAt,
      endedAt: Date.now(),
    };
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2)).catch((err) => persistFail('report.json', err));
    for (const res of state.subscribers) res.end();
    state.subscribers.clear();
  })();

  return { id, goal: run.displayGoal };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// .mjs must be real JS: the page loads as a module now (app.js imports the
// pure banner policy), and browsers refuse module scripts served octet-stream.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

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
const MAX_ACCEPTANCE_CHARS = 2000;
let pendingAdmissionSlots = 0;

function activeSlotUsage() {
  return [...runs.values()]
    .filter((item) => ['running', 'needs_human'].includes(item.run.status))
    .reduce((total, item) => total + 1 + (item.run.reservedChildSlots ?? 0), 0);
}

// HTTP handlers interleave at each await. Hold a synchronous admission token
// across pre-registration I/O (mkdir/git init) so two requests cannot both
// observe spare capacity and then oversubscribe it before either enters runs.
function acquireAdmission(count) {
  const used = activeSlotUsage() + pendingAdmissionSlots;
  if (!Number.isInteger(count) || count < 1 || used + count > MAX_ACTIVE_RUNS) return { ok: false, used };
  pendingAdmissionSlots += count;
  let released = false;
  return {
    ok: true,
    used,
    release() {
      if (released) return;
      released = true;
      pendingAdmissionSlots = Math.max(0, pendingAdmissionSlots - count);
    },
  };
}

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
      return { code: 401, error: 'missing or wrong session token; reload the page' };
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
        // What the settings pickers may offer: the machine's real options,
        // with the current decision always present.
        catalog: modelCatalog(),
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
      // Validate model choices SERVER-SIDE against the offerable catalog: a value
      // the picker never offers (a hidden codex model like codex-auto-review, or
      // anything else off the list) must not be persistable, or it would slip
      // back into the picker as the current decision on the next load.
      const cat = modelCatalog();
      if (maker !== undefined && !cat.maker.includes(maker)) {
        return json(res, 400, { error: `maker "${maker}" is not an available model` });
      }
      if (reviewer !== undefined && !cat.reviewer.includes(reviewer)) {
        return json(res, 400, { error: `reviewer "${reviewer}" is not an available reviewer model (codex does not list it)` });
      }
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

    if (path === '/api/comparisons' && req.method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      const acceptanceContract = String(body.acceptanceContract || '').trim();
      if (goal.length < 12) return json(res, 400, { error: 'Write the goal like you would brief a strategist: a sentence or two.' });
      if (goal.length > MAX_GOAL_CHARS) return json(res, 400, { error: `That goal is ${goal.length} characters; keep it under ${MAX_GOAL_CHARS}.` });
      if (acceptanceContract.length < 12) return json(res, 400, { error: 'Say what must be true for you to trust the result. This contract is shared by every arm.' });
      if (acceptanceContract.length > MAX_ACCEPTANCE_CHARS) return json(res, 400, { error: `That trust contract is ${acceptanceContract.length} characters; keep it under ${MAX_ACCEPTANCE_CHARS}.` });
      const lane = LANES[body.lane] ? body.lane : 'freeform';
      if (lane === 'build') return json(res, 400, { error: 'parallel execution currently supports research lanes, not repository mutation' });
      const catalog = modelCatalog();
      const makerModels = Array.isArray(body.makerModels) ? body.makerModels.map((model) => String(model).trim()).filter(Boolean) : [];
      if (makerModels.length < 2 || makerModels.length > 3 || new Set(makerModels).size !== makerModels.length) return json(res, 400, { error: 'choose two or three distinct executor models' });
      const unavailableMaker = makerModels.find((model) => !catalog.maker.includes(model));
      if (unavailableMaker) return json(res, 400, { error: `maker "${unavailableMaker}" is not in the current Claude catalog; no substitution was made` });
      const reviewerModel = String(body.reviewer || getModels().reviewer.model).trim();
      const reviewerEffort = String(body.reviewerEffort || getModels().reviewer.effort).trim();
      if (!catalog.reviewer.includes(reviewerModel)) return json(res, 400, { error: `reviewer "${reviewerModel}" is not in the current Codex catalog; no substitution was made` });
      if (!['low', 'medium', 'high', 'xhigh'].includes(reviewerEffort)) return json(res, 400, { error: 'reviewer effort must be low, medium, high, or xhigh' });
      const requiredSlots = 1 + makerModels.length;
      const admission = acquireAdmission(requiredSlots);
      if (!admission.ok) return json(res, 429, { error: `this comparison needs ${requiredSlots} local run slots (${makerModels.length} arms plus its parent); ${admission.used} are already active or starting and the cap is ${MAX_ACTIVE_RUNS}` });
      try {
        const comparison = await startParallelComparison({
          goal,
          acceptanceContract,
          lane,
          depth: body.depth === 'standard' ? 'standard' : 'quick',
          ground: body.ground === true,
          makerModels,
          reviewerModel,
          reviewerEffort,
          catalog,
        });
        return json(res, 201, comparison);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      } finally {
        admission.release();
      }
    }

    if (path === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      const acceptanceContract = String(body.acceptanceContract || '').trim();
      if (goal.length < 12) return json(res, 400, { error: 'Write the goal like you would brief a strategist: a sentence or two.' });
      if (goal.length > MAX_GOAL_CHARS) return json(res, 400, { error: `That goal is ${goal.length} characters — keep it under ${MAX_GOAL_CHARS}; a brief is not a corpus.` });
      if (acceptanceContract.length < 12) return json(res, 400, { error: 'Say what must be true for you to trust the result. This is the audit contract, not a copy of the goal.' });
      if (acceptanceContract.length > MAX_ACCEPTANCE_CHARS) return json(res, 400, { error: `That trust contract is ${acceptanceContract.length} characters — keep it under ${MAX_ACCEPTANCE_CHARS}.` });
      const lane = body.lane === 'build' ? 'build' : LANES[body.lane] ? body.lane : 'freeform';

      let targetPath = null;
      let targetToplevel = null;
      if (lane === 'build') {
        if (ENGINE === 'mock') {
          targetPath = String(body.targetPath || '~/demo-repo').trim();
        } else {
          if (!gateInstalled()) {
            return json(res, 400, { error: 'The camus gate is missing or too old for Studio custody. Fix: npm i -g camus-cli && camus install (from this repo: bash packages/cli/install.sh), then check Setup.' });
          }
          const v = await validateBuildTarget(body.targetPath);
          if (!v.ok) return json(res, 400, { error: v.error });
          targetPath = v.path;
          if (activeBuilds.size > 0) {
            return json(res, 409, { error: 'A build run is already going; the studio runs one gate at a time.' });
          }
          targetToplevel = v.toplevel;
        }
      }
      const admission = acquireAdmission(1);
      if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting — the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}.` });
      try {
        if (targetToplevel) activeBuilds.add(targetToplevel);
        const id = await startRun({ goal, acceptanceContract, lane, depth: body.depth === 'standard' ? 'standard' : 'quick', ground: !!body.ground, targetPath, targetToplevel });
        return json(res, 201, { id });
      } catch (err) {
        if (targetToplevel) activeBuilds.delete(targetToplevel);
        throw err;
      } finally {
        admission.release();
      }
    }

    if (path === '/api/runs' && req.method === 'GET') {
      const list = [];
      for (const [id, s] of runs) list.push({ id, goal: s.run.displayGoal ?? s.run.goal, lane: s.run.lane, status: s.run.status, headline: headlineOf(s.run.statuses, ENGINE === 'mock'), startedAt: s.run.startedAt, live: true });
      if (existsSync(RUNS_DIR)) {
        for (const d of await readdir(RUNS_DIR)) {
          if (runs.has(d)) continue;
          try {
            const r = JSON.parse(await readFile(join(RUNS_DIR, d, 'report.json'), 'utf8'));
            // engine === 'mock' is the fallback for rehearsal receipts sealed
            // before `simulated` existed — they must read "rehearsal" too.
            list.push({ id: d, goal: r.displayGoal ?? r.goal, lane: r.lane, status: r.status, headline: headlineOf(r.statuses, r.simulated === true || r.engine === 'mock'), startedAt: r.startedAt, live: false });
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

    const m = path.match(/^\/api\/runs\/([\w-]+)\/(events|answer|stop|report|resume|audit)$/);
    if (m) {
      const [, id, action] = m;
      const state = runs.get(id);

      if (action === 'audit' && req.method === 'POST') {
        if (state && ['running', 'needs_human'].includes(state.run.status)) return json(res, 409, { error: 'the source run is still going; its artifact is not sealed yet' });
        let sourceReport;
        try {
          sourceReport = JSON.parse(await readFile(join(RUNS_DIR, id, 'report.json'), 'utf8'));
        } catch (err) {
          return err.code === 'ENOENT'
            ? json(res, 404, { error: 'the source run has no sealed report yet' })
            : json(res, 500, { error: `the source report is unreadable: ${err.message}` });
        }
        if (!sourceReport.evidencePack) return json(res, 400, { error: sourceReport.evidencePackError || 'the source run has no sealed evidence pack' });
        if (sourceReport.receiptsDegraded) return json(res, 400, { error: 'the source receipt is degraded; re-audit requires a complete source pack' });
        if (sourceReport.evidencePack.schemaVersion !== 2 || sourceReport.evidencePack.artifact?.kind !== 'research') {
          return json(res, 400, { error: 'audit-only replay currently supports research evidence-pack v2 artifacts' });
        }
        if (typeof sourceReport.deliverable !== 'string' || !sourceReport.deliverable.trim()) return json(res, 400, { error: 'the source report has no immutable deliverable to re-audit' });
        if (ENGINE !== 'mock' && (sourceReport.simulated === true || sourceReport.engine === 'mock')) return json(res, 400, { error: 'a live audit cannot promote a scripted rehearsal artifact; start from a live run' });

        const body = await readBody(req);
        const catalog = modelCatalog();
        const reviewerModel = String(body.reviewer || getModels().reviewer.model).trim();
        const effort = String(body.effort || getModels().reviewer.effort).trim();
        if (!catalog.reviewer.includes(reviewerModel)) return json(res, 400, { error: `reviewer "${reviewerModel}" is not in the current Codex catalog; no substitution was made` });
        if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) return json(res, 400, { error: 'effort must be low, medium, high, or xhigh' });
        const admission = acquireAdmission(1);
        if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}.` });
        try {
          const replay = await startAuditReplay({ sourceId: id, sourceReport, reviewerModel, effort, catalog });
          return json(res, 201, replay);
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) });
        } finally {
          admission.release();
        }
      }

      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (state) {
          for (const ev of state.events) res.write(`data: ${JSON.stringify(withHeadline(ev))}\n\n`);
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
          for (const l of lines) if (l.trim()) res.write(`data: ${decorateReplayLine(l)}\n\n`);
        });
        const finish = () => { res.write(`data: ${JSON.stringify({ type: 'replay_end' })}\n\n`); res.end(); };
        stream.on('end', finish);
        stream.on('error', finish); // a torn read must not crash the server
        return;
      }

      if (action === 'answer' && req.method === 'POST') {
        let answerState = state;
        let queued = null;
        if (state && !state.answer && state.run.experimentContext?.parentRunId) {
          const parent = runs.get(state.run.experimentContext.parentRunId);
          if (parent?.answer?.runId === id) answerState = parent;
          else {
            const index = parent?.questionQueue?.findIndex((item) => item.runId === id) ?? -1;
            if (index >= 0) queued = { parent, index, item: parent.questionQueue[index] };
          }
        }
        if (!answerState?.answer && !queued) return json(res, 409, { error: 'no question is pending on this run' });
        const { answer } = await readBody(req);
        if (typeof answer !== 'string' || !answer.trim()) return json(res, 400, { error: 'answer is required' });
        if (queued) {
          queued.parent.questionQueue.splice(queued.index, 1);
          queued.item.resolve(answer.trim());
          return json(res, 200, { ok: true });
        }
        const { qid, resolve, question, armId } = answerState.answer;
        answerState.answer = null;
        answerState.emit('question_answered', { id: qid }); // through emit → receipts + replay
        if (answerState.run.lane === 'comparison') {
          answerState.emit('answer', { kind: question?.kind ?? 'decision', question: question?.text ?? '', answer: answer.trim(), armId });
        }
        resolve(answer.trim());
        return json(res, 200, { ok: true });
      }

      if (action === 'stop' && req.method === 'POST') {
        if (!state) return json(res, 404, { error: 'unknown run' });
        state.abort.abort();
        if (state.run.experimentContext?.parentRunId) {
          const parent = runs.get(state.run.experimentContext.parentRunId);
          if (parent?.answer?.runId === id) {
            const { qid, resolve } = parent.answer;
            parent.answer = null;
            parent.emit('question_answered', { id: qid });
            resolve('Stop the run');
          } else {
            const index = parent?.questionQueue?.findIndex((item) => item.runId === id) ?? -1;
            if (index >= 0) {
              const [queued] = parent.questionQueue.splice(index, 1);
              queued.resolve('Stop the run');
            }
          }
        }
        for (const childId of state.run.childRunIds ?? []) runs.get(childId)?.abort.abort();
        for (const queued of state.questionQueue ?? []) queued.resolve('Stop the run');
        if (state.questionQueue) state.questionQueue.length = 0;
        if (state.answer) {
          const { qid, resolve } = state.answer;
          state.answer = null;
          state.emit('question_answered', { id: qid });
          resolve('Stop the run');
        }
        return json(res, 200, { ok: true });
      }

      if (action === 'resume' && req.method === 'POST') {
        let meta = state?.run;
        if (!meta) {
          try { meta = JSON.parse(await readFile(join(RUNS_DIR, id, 'report.json'), 'utf8')); }
          catch {
            try { meta = JSON.parse(await readFile(join(RUNS_DIR, id, 'run.json'), 'utf8')); }
            catch { return json(res, 404, { error: 'unknown run; nothing to resume' }); }
          }
        }
        if (state && ['running', 'needs_human'].includes(state.run.status)) {
          return json(res, 409, { error: 'that run is still going' });
        }
        if (meta.lane === 'comparison') {
          const experiment = meta.experiment;
          const valid = validateExperimentRecord(experiment);
          if (!valid.ok || experiment?.schemaVersion !== 2 || experiment?.mode !== 'parallel_execution') {
            return json(res, 400, { error: `this run has no recoverable parallel manifest${valid.ok ? '' : `: ${valid.error}`}` });
          }
          if (experiment.outcome.status !== 'running') {
            return json(res, 409, { error: 'this experiment already has a sealed terminal outcome; recovery never rewrites it' });
          }
          let snapshot;
          try { snapshot = JSON.parse(await readFile(join(RUNS_DIR, id, 'knowledge.json'), 'utf8')); }
          catch (err) {
            return json(res, 400, { error: `the original frozen knowledge snapshot is unavailable: ${err.message}` });
          }
          if (!knowledgeSnapshotMatches(snapshot) || snapshot.snapshot_id !== experiment.knowledge.snapshot_id) {
            return json(res, 400, { error: 'the original frozen knowledge snapshot no longer matches its sealed identity' });
          }
          const makers = experiment.manifest.arms.map((arm) => modelOfIdentity(arm.executor.resolved));
          const reviewer = modelOfIdentity(experiment.manifest.reviewer.resolved);
          const catalog = {
            maker: [...experiment.manifest.catalog.maker_models],
            reviewer: [...experiment.manifest.catalog.reviewer_models],
            reviewerSource: experiment.manifest.catalog.reviewer_source,
          };
          const admission = acquireAdmission(1);
          if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; recovery needs one parent slot and never reruns an arm` });
          try {
            const recovered = await startParallelComparison({
              goal: experiment.goal,
              acceptanceContract: experiment.acceptance_contract,
              lane: experiment.manifest.task.lane,
              depth: experiment.manifest.task.depth,
              ground: meta.ground === true,
              makerModels: makers,
              reviewerModel: reviewer,
              reviewerEffort: experiment.manifest.reviewer_effort.requested,
              catalog,
              resumeExperiment: experiment,
              resumeSnapshot: snapshot,
            });
            return json(res, 201, recovered);
          } finally {
            admission.release();
          }
        }
        // Build runs resume by re-invoking the gate with the SAME identity
        // (idSalt). The gate skips finished work and reruns only unproven work.
        if (meta.lane !== 'build') return json(res, 400, { error: 'only build runs and incomplete comparisons can resume' });
        if (!meta.idSalt) return json(res, 400, { error: 'this run predates resumable receipts. Start a fresh build run instead; the gate itself still skips finished work.' });
        if (ENGINE !== 'mock') {
          const v = await validateBuildTarget(meta.targetPath);
          if (!v.ok) return json(res, 400, { error: `the original target no longer validates: ${v.error}` });
          if (activeBuilds.size > 0) return json(res, 409, { error: 'a build run is already going; one gate at a time' });
          const admission = acquireAdmission(1);
          if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}` });
          try {
            activeBuilds.add(v.toplevel);
            const newId = await startRun({ goal: meta.goal, acceptanceContract: meta.acceptanceContract, lane: 'build', depth: 'quick', ground: false, targetPath: v.path, targetToplevel: v.toplevel, idSalt: meta.idSalt });
            return json(res, 201, { id: newId });
          } catch (err) {
            activeBuilds.delete(v.toplevel);
            throw err;
          } finally {
            admission.release();
          }
        }
        const admission = acquireAdmission(1);
        if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}` });
        try {
          const newId = await startRun({ goal: meta.goal, acceptanceContract: meta.acceptanceContract, lane: 'build', depth: 'quick', ground: false, targetPath: meta.targetPath, idSalt: meta.idSalt });
          return json(res, 201, { id: newId });
        } finally {
          admission.release();
        }
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
