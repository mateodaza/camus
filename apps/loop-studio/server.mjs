#!/usr/bin/env node
// Camus Loop Studio — local server. Zero dependencies: Node stdlib http serves
// the UI, runs the loop, streams events over SSE, and writes receipts under
// runs/<id>/ (events.jsonl + every revision + report.json) so each run leaves
// a paper trail a skeptic can replay.
// CAMUS_CONTROL: studio.run.acceptance_contract
// CAMUS_CONTROL: studio.run.seat_admission
// CAMUS_CONTROL: studio.run.dispatch_authorization
// CAMUS_CONTROL: studio.run.output_standing
// CAMUS_CONTROL: studio.publish.lane_eligibility
// CAMUS_CONTROL: studio.publish.explicit_consent
// CAMUS_CONTROL: studio.qualification.exact_tuple

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from './lib/engine.mjs';
import { runIndependentCodeLoop } from './lib/independent-code-lane.mjs';
import { prepareCodeReceiptsDir } from './lib/code-seats.mjs';
import { prepareCodeSeats } from './lib/code-seat-launch.mjs';
import { runCodeLoop, runVerificationRecovery, resolveRecoveryTarget, recoveryTarget, reconstructInterruptedParked, readGateStatus, gateStateFromStatus, validateBuildTarget, gateInstalled, gatherContinuationEvidence } from './lib/code-lane.mjs';
import { deriveContinuation, continuationPresentation } from './lib/continuation.mjs';
import { runMockCodeLoop } from './lib/adapters/mock.mjs';
import { runClaude } from './lib/adapters/claude.mjs';
import { runCodexReview } from './lib/adapters/codex.mjs';
import { createMockAdapters } from './lib/adapters/mock.mjs';
import { resolveSeatAdapters } from './lib/adapters/registry.mjs';
import * as hivemind from './lib/adapters/hivemind.mjs';
import { LANES, extractThresholdLines, bindThresholdAssessments } from './lib/verify.mjs';
import { deriveEvidence, receiptCompleteness } from './lib/evidence.mjs';
import { buildEvidencePack } from './lib/evidence-pack.mjs';
import { buildAuditReplayPack, createAuditReplayExperiment, finalizeAuditReplayExperiment } from './lib/audit-replay.mjs';
import { createParallelExperiment, finalizeParallelExperiment, knowledgeSnapshotMatches, markParallelArmRunning, outcomeFromArmReport, sealKnowledgeSnapshot } from './lib/comparison.mjs';
import { validateExperimentRecord } from '../../packages/trust/lib/validate.mjs';
import { deriveStatusDimensions, deriveHeadline } from './lib/status-dims.mjs';
import { getModels, updateModels, saveConnectionBackend, modelsSummary, modelCatalog, seatCatalog, seatOffered, groundingNeedsClaudeMaker, gateModels, listConnections, listBackends, EFFORTS } from './lib/models.mjs';
import { deepQualifyModel, expectedReportedFor, redactProviderError, seatQualification, storedSeatQualification } from './lib/capability-probes.mjs';
import { capabilityDiagnosticsDir } from './lib/capabilities.mjs';
import { admissionCatalog, admittedSeat, pairingPresentation, isQualifiableTransport } from './lib/admission.mjs';
import { confirmClaudeRoute } from './lib/grandfather.mjs';
import { reviewPrompt } from './lib/prompts.mjs';
import { connectionFingerprint, getSharedTunnelManager } from './lib/ssh-tunnel.mjs';
import { installTunnelLifecycle } from './lib/tunnel-lifecycle.mjs';
import { createQualificationControl, createStudioControlPlane } from './lib/control-plane.mjs';
import { findEvaluationCase, loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { loadEvaluationReports, summarizeEvaluationReports } from './lib/model-eval-summary.mjs';
import { loadJudgeCalibration } from './lib/judge-calibration.mjs';
import { classifyTaskClass, deriveAutomaticRoute } from './lib/model-routing.mjs';
import {
  activeGenerationId,
  assertGenerationMatches,
  blindedArtifactView,
  commitCalibrationLabel,
  disagreementView,
  loadWorkspaceSidecar,
  prepareWorkspace,
  resolveWorkspaceArtifact,
  resolveWorkspacePaths,
  saveWorkspaceDraft,
  WorkspaceError,
  workspaceStatusView,
} from './lib/calibration-workspace.mjs';
import { loadCalibrationQueue, resolveCalibrationArtifact } from './lib/model-eval-calibration.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
// Receipts live here. Tests and embeddings override it so a run never writes
// into the product's real runs/ directory (STUDIO_RUNS_DIR).
const RUNS_DIR = process.env.STUDIO_RUNS_DIR || join(__dirname, 'runs');
const PORT = Number(process.env.PORT || 1913); // Camus, b. 1913
const ENGINE = process.env.ENGINE === 'mock' ? 'mock' : 'live';
const MODEL_EVAL_CAMPAIGN = loadModelEvalCampaign();
const MODEL_EVAL_CAMPAIGN_HASH = modelEvalCampaignHash(MODEL_EVAL_CAMPAIGN);

function automaticRouteDecision({ taskClass = null, lane = 'freeform', depth = 'standard' } = {}) {
  const classification = classifyTaskClass({ taskClass, lane, depth });
  if (!classification.taskClass) return { routed: false, reason: classification.source, classification };
  try {
    const calibration = loadJudgeCalibration(MODEL_EVAL_CAMPAIGN).summary;
    const { reports, unreadableReports } = loadEvaluationReports(RUNS_DIR);
    if (unreadableReports) return { routed: false, reason: 'evaluation_reports_unreadable', classification, unreadableReports };
    const summary = summarizeEvaluationReports(
      MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, reports, calibration,
      { profile: classification.taskClass },
    );
    return {
      ...deriveAutomaticRoute({
        campaign: MODEL_EVAL_CAMPAIGN, summary, calibrationSummary: calibration,
        catalog: admissionCatalog(), taskClass: classification.taskClass,
      }),
      classification,
    };
  } catch (error) {
    return {
      routed: false, reason: 'routing_evidence_unavailable', classification,
      errorClass: error?.constructor?.name ?? 'Error',
    };
  }
}

const runs = new Map(); // id -> { run, events, subscribers, answer, abort }

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

const confirmClaudeRouteIndex = process.argv.indexOf('--confirm-claude-route');
if (confirmClaudeRouteIndex !== -1) {
  const why = process.argv[confirmClaudeRouteIndex + 1];
  try {
    // Load the real configuration first so §7 performs its one-time complete
    // legacy inventory before this action appends anything to the shared,
    // machine-bound confirmation store. The action must never initialize an
    // empty sidecar that silently omits legacy entries from the same config.
    getModels();
    const result = confirmClaudeRoute(why);
    console.log(`recorded Claude direct-route confirmation at ${result.record.recordedAt}`);
    process.exit(0);
  } catch (error) {
    console.error(`could not confirm Claude's direct route: ${error.message || error}`);
    process.exit(2);
  }
}

if (process.argv.includes('--doctor')) {
  const { runDoctor } = await import('./lib/doctor.mjs');
  const deep = process.argv.includes('--deep');
  const report = await runDoctor({ deep, engine: ENGINE });
  console.log('camus-loop-studio doctor');
  console.log(`  mode   ${deep ? 'deep (provider-backed checks may spend tokens)' : 'shallow (network-free; pass --deep explicitly for provider-backed checks)'}`);
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

// Freeze the complete seat decision at run admission. Both direct runs and
// comparison arms use this one projection so a child cannot lose the lineage,
// transport, or operator facts that determined its review standing.
const snapshotSeat = (entry, model) => ({
  backend: entry.backend,
  provider: entry.provider,
  model,
  executor: entry.executor,
  transport: entry.transport,
  connection: entry.connection ?? null,
  protocol: entry.protocol,
  trainingOrg: entry.trainingOrg,
  modelFamily: entry.modelFamily,
  inferenceOperator: entry.inferenceOperator,
  lineage: { source: entry.lineage.source, derivedFrom: entry.lineage.derivedFrom ?? null },
  originConfidence: entry.originConfidence,
  // A seat/backend-level expected-reported alias mapping (§6.2) rides the
  // snapshot so the runtime adapter reconciles the same declared alias that
  // deep-doctor qualification accepted; dropping it here would make a qualified
  // mapping endpoint fail closed on its first production call.
  ...(entry.expectedReported !== undefined ? { expectedReported: entry.expectedReported } : {}),
  ...(entry.qualification ? { qualification: { ...entry.qualification } } : {}),
});

const activeBuilds = new Set();

// Headlines are DERIVED at render from the sealed raw dimensions, never stored.
// null for a live or legacy run that has no dimensions yet. A rehearsal is its
// own visible tag — scripted rounds can never present as a trust standing, so
// the simulated flag outranks whatever the dimensions would read.
const headlineOf = (statuses, simulated = false) => {
  if (simulated) return 'rehearsal';
  try { return statuses ? deriveHeadline(statuses) : null; } catch { return null; }
};

// Audit-only replays carry the small, non-content facts Recents needs to show
// them as arms over ONE artifact. This works for sealed reports, in-memory
// runs, and interrupted run.json metadata: a failed/report-less arm remains
// part of the record instead of disappearing until restart (or forever).
const auditArmFields = (r) => {
  if (r?.lane !== 'audit_replay') return {};
  const outcome = r.experiment?.outcome ?? null;
  const manifest = r.experiment?.manifest ?? null;
  return {
    artifactId: r.evidencePack?.artifact_id ?? outcome?.artifact_id ?? r.experiment?.source?.artifact_id ?? null,
    receiptId: r.evidencePack?.receipt_id ?? outcome?.receipt_id ?? null,
    sourceRunId: r.sourceRunId ?? r.experiment?.source?.run_id ?? null,
    effortRequested: manifest?.effort?.requested ?? null,
    effortActual: outcome?.effort_actual ?? null,
    auditorActual: r.evidencePack?.pairing?.auditor?.actual ?? outcome?.auditor_actual ?? null,
    outputTokens: outcome?.usage?.output_tokens ?? null,
    durationMs: outcome?.usage?.duration_ms ?? null,
    findingCount: (r.evidence?.rounds ?? []).at(-1)?.findings?.length ?? null,
  };
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
const decorateReplayLine = (l, { knowledgeItemCount = null } = {}) => {
  try {
    const ev = JSON.parse(l);
    if (ev?.type === 'status') return JSON.stringify(withHeadline(ev));
    // Older frozen-run events predate itemCount on the stage event. Derive the
    // display badge from the separately sealed local knowledge snapshot at
    // serve time; never rewrite the receipt to repair presentation.
    if (ev?.type === 'stage' && ev.name === 'ground' && ev.status === 'done' && ev.frozen === true
      && !Number.isInteger(ev.itemCount) && Number.isInteger(knowledgeItemCount)) {
      return JSON.stringify({ ...ev, itemCount: knowledgeItemCount });
    }
    return l;
  } catch { return l; }
};

// Per-run verify command. Some repos cannot be verified by auto-detection (a .NET
// solution whose mobile heads need workloads this host lacks, a monorepo task
// runner), so the operator supplies the host-scoped command. ONE definition, used
// by both fresh launches and resumes: a resume that validated more loosely than a
// launch would be a way in. Shell-unsafe values are REFUSED, never sanitized —
// those characters reach a shell. The acceptance contract stays uncapped; this is
// a command, not prose. Returns {ok:true, verifyCmd} | {ok:false, error}.
function parseVerifyCmd(raw, lane) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, verifyCmd: null };
  if (typeof raw !== 'string') return { ok: false, error: 'verifyCmd must be a string' };
  const candidate = raw.trim();
  if (candidate.length > 2000) return { ok: false, error: `that verify command is ${candidate.length} characters; keep it under 2000` };
  if (/[$`"\\\n\r]/.test(candidate)) {
    return { ok: false, error: 'verifyCmd cannot contain $ ` " \\ or newlines — those expand in a shell. Put a complex command in a script and call that.' };
  }
  if (lane !== 'build') return { ok: false, error: 'verifyCmd applies to the Build lane; the words lanes verify their deliverable, not a repository' };
  return { ok: true, verifyCmd: candidate };
}

// The persisted event trail for a run whose process is gone. Bounded read: only the
// types the reconstruction needs, so a 200k-line trail costs one pass and no parse of
// the heavy session lines.
async function readRunEvents(id) {
  try {
    const text = await readFile(join(RUNS_DIR, id, 'events.jsonl'), 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      // Whitespace-TOLERANT: Studio writes these with JSON.stringify (no spaces), but a
      // trail written by anything else formats them differently, and a prefilter that
      // silently drops the gate report means an interrupted run quietly falls through to
      // the gate. Caught by a fixture written with python's json.dumps, 2026-08-05.
      if (!/"type"\s*:\s*"(status|gate_report|question|answer|question_answered)"/.test(line)) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line */ }
    }
    return out;
  } catch { return []; }
}

async function startRun({
  goal,
  acceptanceContract,
  lane,
  depth,
  ground,
  targetPath = null,
  targetToplevel = null,
  verifyCmd = null,
  idSalt = null,
  recovery = null,
  codeMode = 'gate',
  modelsSnapshot = null,
  frozenBackends = null,
  pairingView = null,
  frozenKnowledge = null,
  toolPolicy = null,
  publish = false,
  iterationPolicy = 'iterative',
  evaluationProfile = null,
  evaluationCaseId = null,
  evaluationChecks = null,
  evaluationPlanPolicy = null,
  evaluationCampaignId = null,
  evaluationConfigHash = null,
  displayGoal = null,
  experimentContext = null,
  modelRouting = null,
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
  // A recovery reads NO model settings: it runs no model, and a seat configuration
  // that fails to load must not block recovering a parked candidate. The empty
  // decision record is also the honest one to seal — no seat was chosen.
  const models = recovery
    ? { maker: null, reviewer: null, loop: { roundCap: 0 }, recovery: true }
    : modelsSnapshot ? JSON.parse(JSON.stringify(modelsSnapshot)) : getModels();
  if (!['iterative', 'single_pass'].includes(iterationPolicy)) throw new Error('iterationPolicy must be iterative or single_pass');
  if (iterationPolicy === 'single_pass' && publish === true) throw new Error('single-pass evaluation cannot publish');
  const publishRequested = publish === true;
  const controlPlane = createStudioControlPlane({
    id, goal, acceptanceContract, lane, depth, ground, targetPath, targetToplevel, verifyCmd,
    models, recovery, publishRequested, codeMode,
  });
  const run = { id, goal, displayGoal, acceptanceContract, lane, codeMode, depth, ground, targetPath, targetToplevel, verifyCmd, recovery, idSalt: lane === 'build' ? (idSalt || `studio-${id}`) : null, status: 'running', startedAt: Date.now(), lastMarkdown: null, rev: 0, costUsd: 0, receiptsDegraded: false, models, pairingView, frozenKnowledge, toolPolicy, publish: publishRequested, iterationPolicy, evaluationProfile, evaluationCaseId, evaluationChecks, evaluationPlanPolicy, evaluationCampaignId, evaluationConfigHash, experimentContext, modelRouting, controlPlane };
  // The run exists on disk from second zero — a crash must not orphan it.
  const runMetadata = () => ({ id, goal, displayGoal, acceptanceContract, lane, codeMode, depth, ground, targetPath, targetToplevel, verifyCmd, recovery, idSalt: run.idSalt, engine: ENGINE, models, pairingView, publishRequested, iterationPolicy, evaluationProfile, evaluationCaseId, evaluationChecks, evaluationPlanPolicy, evaluationCampaignId, evaluationConfigHash, knowledgeSnapshotId: run.frozenKnowledge?.snapshot_id ?? null, experimentContext, modelRouting, startedAt: run.startedAt });
  await writeFile(join(dir, 'run.json'), JSON.stringify(runMetadata(), null, 2))
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
  controlPlane.attach(emit);

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

  // Seat resolution honors THIS run's snapshot (docs/MULTI-MODEL-SEATS.md):
  // the engine receives maker/reviewer functions for exactly the backends the
  // snapshot names, never a vendor assumption. Mock stays fully scripted.
  // A RECOVERY CONSTRUCTS NO ADAPTERS AT ALL. Passing seats it never calls made the
  // independence claim a promise rather than a property, and it meant a broken or
  // unavailable seat configuration could stop an operator from recovering a parked
  // candidate that needs no model (audit 2026-08-05). Recovery must work when the
  // model lane does not.
  const adapters = recovery ? null
    : ENGINE === 'mock' ? (() => { const m = createMockAdapters(); return { maker: m.maker, reviewer: m.reviewer }; })()
      : resolveSeatAdapters(models, frozenBackends);

  // Managed-SSH facts are already emitted by the transport. Bind both the name
  // and immutable destination fingerprint from the exact backend objects frozen
  // at admission. A same-named connection edited during another run therefore
  // cannot bleed its facts into this receipt.
  const runSshConnections = new Set(
    [frozenBackends?.maker, frozenBackends?.reviewer]
      .map((backend) => backend?.connectionDetails)
      .filter((connection) => connection?.kind === 'ssh_tunnel')
      .map((connection) => JSON.stringify([connection.name, connectionFingerprint(connection)])),
  );
  const removeTunnelSubscription = runSshConnections.size
    ? getSharedTunnelManager().subscribe((fact) => {
      const factKey = JSON.stringify([fact?.connection, fact?.connectionFingerprint]);
      if (runSshConnections.has(factKey)) controlPlane.recordSshFact(fact);
    })
    : null;

  emit('run', { run: { id, goal: displayGoal ?? goal, acceptanceContract, lane, codeMode, depth, ground, targetPath, verifyCmd, publishRequested, pairingView, modelRouting, recoveryOf: recovery?.sourceRunId ?? null, recovery: recovery ? { sourceRunId: recovery.sourceRunId ?? null, sourceReceiptId: recovery.sourceReceiptId ?? null, parkedSha: recovery.parkedSha ?? null, shaProvenance: recovery.shaProvenance ?? null } : null, engine: ENGINE, roundCap: iterationPolicy === 'single_pass' ? 1 : models.loop.roundCap, iterationPolicy, evaluationProfile, evaluationCaseId, evaluationPlanPolicy, evaluationCampaignId, evaluationConfigHash, experimentContext } });
  if (!gitOk) emit('log', { line: '⚠ git unavailable; codex reviews will run outside a git repo (different conditions than camus)' });

  // A recovery runs the host verifier and NOTHING else — including under the mock
  // engine, because a simulated recovery would fabricate a verdict about a real
  // parked commit. That is the one place rehearsal must not substitute.
  const runner = recovery
    ? runVerificationRecovery
    : lane === 'build' ? (codeMode === 'independent' ? runIndependentCodeLoop : ENGINE === 'mock' ? runMockCodeLoop : runCodeLoop) : runLoop;
  runner(run, {
    emit,
    waitForAnswer,
    adapters,
    hivemind,
    signal: state.abort.signal,
    scratchDir,
    receiptsDir: dir,
    persistKnowledgeSnapshot: async (snapshot) => {
      run.frozenKnowledge = snapshot;
      try {
        await writeFile(join(dir, 'knowledge.json'), JSON.stringify(snapshot, null, 2));
        await writeFile(join(dir, 'run.json'), JSON.stringify(runMetadata(), null, 2));
      } catch (err) {
        persistFail('knowledge snapshot', err);
      }
    },
  }).then(async (result) => {
    removeTunnelSubscription?.();
    if (targetToplevel) activeBuilds.delete(targetToplevel);
    await state.writeChain; // receipt stream flushed before the report seals the run
    // The receipt CARRIES the challenge trail, not just the final deliverable,
    // and tells the truth about its own completeness.
    const evidence = deriveEvidence(state.events);
    let { degraded: receiptsDegraded, note: receiptsNote } =
      codeMode === 'independent' && lane === 'build'
        ? { degraded: run.receiptsDegraded, note: 'Experimental code receipt. No admitted gate evidence pack or automatic acceptance is claimed.' }
        : receiptCompleteness({ lane, evidence, writeFailed: run.receiptsDegraded, status: run.status });
    // The dimensions rode the terminal status event (computed in emit); the
    // receipt seals the same object. Fall back to a fresh derivation only if a
    // run somehow ended without a status event. The headline is NEVER sealed.
    const statuses = run.statuses ?? deriveStatusDimensions({
      lane, status: run.status, evidence,
      published: !!(result?.artifactPublished || result?.artifactUrl),
      simulated: ENGINE === 'mock',
    });
    const terminalControlRoute = controlPlane.finishRun({ statuses, status: run.status });
    if (terminalControlRoute.decision !== 'auto') {
      receiptsDegraded = true;
      receiptsNote = [receiptsNote, `the control plane ended ${terminalControlRoute.decision}: ${terminalControlRoute.rule_ids.join(', ')}`].filter(Boolean).join('; ');
    }
    await state.writeChain;
    const endedAt = Date.now();
    let evidencePack = null;
    let evidencePackError = null;
    try {
      evidencePack = codeMode === 'independent' && lane === 'build' ? null : buildEvidencePack({
        goal,
        acceptanceContract,
        lane,
        targetPath,
        deliverable: run.lastMarkdown,
        evidence,
        statuses,
        models: run.models,
        makerActualModels: result?.makerActualModels ?? [],
        makerActualEvidence: result?.makerActualEvidence ?? null,
        makerReportedModel: result?.makerReportedModel ?? null,
        simulated: ENGINE === 'mock',
        verifyCommand: verifyCmd ?? null,
        recoveryOf: result?.recoveryOf ?? null,
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
    const reportObject = { id, goal, displayGoal, acceptanceContract, lane, depth, ground, targetPath, verifyCmd, publishRequested, iterationPolicy, evaluationProfile, evaluationCaseId, evaluationPlanPolicy, evaluationCampaignId, evaluationConfigHash, idSalt: run.idSalt, engine: ENGINE, ...result, models: run.models, simulated: ENGINE === 'mock', experimentContext, modelRouting, knowledgeSnapshotId: run.frozenKnowledge?.snapshot_id ?? null, draft: undefined, deliverable: run.lastMarkdown, evidence, evidencePack, evidencePackError, controlPlane: controlPlane.receipt(), controlRoute: terminalControlRoute, receiptsDegraded, receiptsNote, statuses, startedAt: run.startedAt, endedAt };
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
      // The threshold ledger is a pure function of the sealed deliverable text
      // (already bound by deliverable_hash), so it re-derives deterministically
      // at replay rather than needing its own sealed field.
      const thresholds = extractThresholdLines(sourceReport.deliverable ?? '');
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
          thresholds,
          auditOnly: true,
        }),
        claims,
        criteria,
        thresholds,
        auditOnly: true,
        cwd: scratchDir,
        signal: state.abort.signal,
        onTick: (line) => emit('log', { line }),
        onSession: (line) => emit('session', { actor: 'reviewer', line }),
        receiptDir: join(dir, 'review-audit-only'),
      });
      // Bind the auditor's threshold verdicts to the lines they judged ONCE, so
      // the streamed event and the sealed replay pack share the same binding.
      if (review?.ran) review.thresholdAssessments = bindThresholdAssessments(thresholds, review.thresholdAssessments);
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
        thresholdAssessments: review.thresholdAssessments ?? [],
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
    try {
      await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
      // Keep only the Recents projection in memory. The full private report
      // stays on disk, while a just-finished replay groups identically before
      // and after a server restart.
      run.auditArm = auditArmFields(report);
    } catch (err) {
      persistFail('report.json', err);
    }
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

async function startParallelComparison({ goal, acceptanceContract, lane, depth, ground, makerModels, reviewerModel, reviewerEffort, catalog, evaluationProfile = null, evaluationCaseId = null, evaluationChecks = null, evaluationPlanPolicy = null, evaluationCampaignId = null, evaluationConfigHash = null, resumeExperiment = null, resumeSnapshot = null }) {
  const id = newId();
  const dir = join(RUNS_DIR, id);
  const scratchDir = join(dir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const startedAt = Date.now();
  const modelsAtStart = getModels();
  const comparisonIterationPolicy = resumeExperiment?.manifest.round_cap === 1 ? 'single_pass'
    : resumeExperiment ? 'iterative'
      : 'single_pass';
  modelsAtStart.loop = {
    ...modelsAtStart.loop,
    roundCap: resumeExperiment?.manifest.round_cap ?? 1,
    source: resumeExperiment ? 'resumed experiment manifest' : 'single-pass comparison policy',
  };
  const run = {
    id,
    goal,
    displayGoal: `${resumeExperiment ? 'Recover' : 'Compare'} ${makerModels.join(' vs ')}: ${goal}`,
    acceptanceContract,
    lane: 'comparison',
    sourceLane: lane,
    depth,
    ground,
    iterationPolicy: comparisonIterationPolicy,
    evaluationProfile,
    evaluationCaseId,
    evaluationPlanPolicy,
    evaluationCampaignId,
    evaluationConfigHash,
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
    iterationPolicy: comparisonIterationPolicy,
    evaluationProfile,
    evaluationCaseId,
    evaluationPlanPolicy,
    evaluationCampaignId,
    evaluationConfigHash,
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

  emit('run', { run: { id, goal: run.displayGoal, acceptanceContract, lane: 'comparison', sourceLane: lane, depth, ground, engine: ENGINE, arms: makerModels, roundCap: modelsAtStart.loop.roundCap, iterationPolicy: comparisonIterationPolicy, evaluationProfile, evaluationCaseId, evaluationPlanPolicy, evaluationCampaignId, evaluationConfigHash } });
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
        experiment = createParallelExperiment({ goal, acceptanceContract, lane, depth, roundCap: 1, snapshot, makerModels, reviewerModel, reviewerEffort, catalog, createdAt: startedAt });
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
        const seats = seatCatalog();
        const makerEntry = seats.maker.find((entry) => entry.backend === 'claude' && entry.model === maker);
        const reviewerEntry = seats.reviewer.find((entry) => entry.backend === 'codex' && entry.model === reviewerModel);
        if (!makerEntry || !reviewerEntry) {
          throw new Error('parallel experiment manifest references a built-in seat that is no longer available');
        }
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
              maker: { ...snapshotSeat(makerEntry, maker), source: 'parallel experiment manifest' },
              reviewer: { ...snapshotSeat(reviewerEntry, reviewerModel), effort: reviewerEffort, modelSource: 'parallel experiment manifest', effortSource: 'parallel experiment manifest' },
              loop: { ...modelsAtStart.loop },
            },
            frozenKnowledge: snapshot,
            toolPolicy: 'none',
            publish: false,
            iterationPolicy: 'single_pass',
            evaluationProfile,
            evaluationCaseId,
            evaluationChecks,
            evaluationPlanPolicy,
            evaluationCampaignId,
            evaluationConfigHash,
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
      experiment ??= createParallelExperiment({ goal, acceptanceContract, lane, depth, roundCap: 1, snapshot, makerModels, reviewerModel, reviewerEffort, catalog, createdAt: startedAt });
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
      iterationPolicy: comparisonIterationPolicy,
      evaluationProfile,
      evaluationCaseId,
      evaluationPlanPolicy,
      evaluationCampaignId,
      evaluationConfigHash,
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
const EVALUATION_PROFILES = new Set(MODEL_EVAL_CAMPAIGN.profiles.map((profile) => profile.id));
function evaluationBinding(body, evaluationProfile, { goal, acceptanceContract, lane, depth, ground }) {
  const suppliedId = body.evaluationCampaignId == null ? null : String(body.evaluationCampaignId).trim();
  const suppliedHash = body.evaluationConfigHash == null ? null : String(body.evaluationConfigHash).trim();
  const suppliedCaseId = body.evaluationCaseId == null ? null : String(body.evaluationCaseId).trim();
  if (!evaluationProfile) {
    return suppliedId === null && suppliedHash === null && suppliedCaseId === null
      ? { ok: true, id: null, hash: null, caseId: null, checks: null, planPolicy: null }
      : { ok: false, error: 'evaluation campaign or case identity requires an evaluationProfile' };
  }
  if (suppliedId !== MODEL_EVAL_CAMPAIGN.id || suppliedHash !== MODEL_EVAL_CAMPAIGN_HASH) {
    return { ok: false, error: 'the evaluation campaign id or config hash is stale; reload the tracked campaign before spending' };
  }
  const treatment = findEvaluationCase(MODEL_EVAL_CAMPAIGN, evaluationProfile, suppliedCaseId);
  if (!treatment || goal !== treatment.evaluationCase.goal || acceptanceContract !== treatment.evaluationCase.acceptanceContract
      || lane !== 'freeform' || depth !== treatment.profile.depth || ground !== MODEL_EVAL_CAMPAIGN.controls.ground) {
    return { ok: false, error: 'the evaluation case, goal, contract, lane, depth, or grounding differs from the registered treatment' };
  }
  return { ok: true, id: suppliedId, hash: suppliedHash, caseId: suppliedCaseId, checks: treatment.evaluationCase.deterministicChecks, planPolicy: treatment.profile.planPolicy };
}
// The acceptance contract is deliberately NOT length-capped. A 2,000-char
// rejection forced operators to compress or weaken the very thing the auditor is
// held to (field report 2026-08-04, a real game task whose contract was longer
// than the cap). The request body limit still bounds abuse, and the UI shows a
// live counter with a non-blocking note; Studio never edits a trust contract on
// the user's behalf. ADVISORY_ACCEPTANCE_CHARS only drives that soft note.
const ADVISORY_ACCEPTANCE_CHARS = 2000;
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

// The private calibration workspace is stricter than the rest of the API: every
// endpoint — GET included — must carry the per-session token, because a bare
// cross-origin GET drive-by (no Origin, no token) must never read a blinded
// artifact, a draft, or disagreement data. Host/Origin are already enforced by
// authorize() upstream; this adds the token on top for GET and POST alike.
function calibrationTokenOk(req) {
  return req.headers['x-studio-token'] === SESSION_TOKEN;
}
function sendWorkspaceError(res, err) {
  if (err instanceof WorkspaceError) return json(res, err.httpCode, { error: err.message });
  // Never forward a raw error (it can contain absolute paths / receipts).
  return json(res, 500, { error: 'calibration workspace error' });
}
// Re-read the active-generation queue for a read-only endpoint, mapping the
// unprepared/stale cases to bounded, path-free errors.
function loadWorkspaceQueueOrError(paths) {
  if (!existsSync(paths.queue)) throw new WorkspaceError(404, 'the calibration workspace is not prepared for the active generation');
  try {
    return loadCalibrationQueue(MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, paths);
  } catch (error) {
    if (/stale for the active campaign generation/.test(error.message)) {
      throw new WorkspaceError(409, 'the calibration queue is stale for the active campaign; reload');
    }
    throw new WorkspaceError(500, 'the calibration queue could not be read');
  }
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
      // A GET is reachable from an unauthenticated cross-origin drive-by
      // (a bare `<img>`/navigation carries no Origin, so CORS never blocks the
      // request from executing). It must therefore run ONLY the network-free
      // shallow doctor — never the deep §9.2 qualification, which fires real,
      // spending streaming probes and writes durable receipts. Deep probing is a
      // POST guarded by the per-session token (authorize()), so `?deep=1` on a GET
      // is deliberately ignored here.
      const { runDoctor } = await import('./lib/doctor.mjs');
      return json(res, 200, await runDoctor({ deep: false, engine: ENGINE }));
    }

    if (path === '/api/doctor' && req.method === 'POST') {
      // Deep qualification spends money (8K-token streaming probes) and mutates
      // durable state (receipts), so it is authorized: a browser POST is refused
      // by authorize() unless it carries the session token. runDoctor itself
      // skips the spending §9.2 qualification under the mock engine (its
      // "rehearsal, no model calls" contract), while still running the cheap deep
      // connection/backend reachability probes.
      const { runDoctor } = await import('./lib/doctor.mjs');
      const body = await readBody(req);
      return json(res, 200, await runDoctor({ deep: body?.deep === true, engine: ENGINE }));
    }

    if (path === '/api/qualifications' && req.method === 'POST') {
      // One explicit tuple per action: bounded spend, no surprise "qualify all"
      // fan-out. Rehearsal promises no model calls, so qualification is available
      // only from the live Studio process.
      if (ENGINE === 'mock') {
        return json(res, 409, { error: 'Qualification is unavailable in rehearsal because rehearsal makes no model calls. Start live Studio, then qualify the tuple.' });
      }
      const body = await readBody(req);
      const seatKey = body?.seat;
      const backendName = typeof body?.backend === 'string' ? body.backend.trim() : '';
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      const stream = body?.stream === true;
      const unknown = Object.keys(body ?? {}).filter((key) => !['seat', 'backend', 'model', 'stream'].includes(key));
      if (unknown.length || ![undefined, true, false].includes(body?.stream)
        || !['maker', 'reviewer'].includes(seatKey) || !backendName || !model) {
        return json(res, 400, { error: 'qualification requires exactly { seat: maker|reviewer, backend, model, stream?: boolean }' });
      }
      const declared = seatCatalog();
      const catalogEntry = (declared[seatKey] ?? []).find((entry) => entry.backend === backendName && entry.model === model);
      if (!catalogEntry) {
        return json(res, 400, { error: `${seatKey} "${backendName}:${model}" is not a declared seat tuple; nothing was probed` });
      }
      const backend = listBackends()[backendName];
      if (!backend || backend.kind !== 'openai_compat' || !isQualifiableTransport(backend.transport)) {
        return json(res, 400, { error: `${backendName}:${model} is not a supported managed chat-completions backend` });
      }
      const seatType = seatKey === 'maker' ? 'words_maker' : 'words_reviewer';
      const expectedReported = expectedReportedFor(backend, catalogEntry, model);
      const qualificationControl = createQualificationControl({
        seat: seatKey, backend: backendName, model,
        connection: backend.connection || backend.connectionDetails?.name || null,
        transport: backend.transport,
      });
      let finishAttempted = false;
      const finishControl = (input) => {
        finishAttempted = true;
        return qualificationControl.finish(input);
      };
      const shapeResult = (result, governed) => {
        const refreshed = admissionCatalog();
        const status = (refreshed[seatKey] ?? []).find((entry) => entry.backend === backendName && entry.model === model) ?? null;
        return {
          qualified: result.qualified,
          reason: result.reason,
          missing: result.missing ?? [],
          discoveryStatus: result.discoveryStatus ?? 'discovery_unavailable',
          identity: result.identity ?? null,
          capabilities: result.capabilities ?? null,
          admission: status?.admission ?? null,
          // Path only. Raw provider diagnostics remain a bounded, redacted local
          // file the operator chooses to open; they are never streamed to the page.
          diagnosticsPath: capabilityDiagnosticsDir(),
          controlRoute: governed.route,
        };
      };
      if (!stream) {
        try {
          const result = await deepQualifyModel({ entry: backend, model, seatType, expectedReported });
          const governed = finishControl({ result });
          return json(res, 200, shapeResult(result, governed));
        } catch (error) {
          let governed = null;
          if (!finishAttempted) {
            try { governed = finishControl({ error }); } catch {}
          }
          return json(res, 502, {
            error: redactProviderError(error?.message || 'qualification failed'),
            controlRoute: governed?.route ?? null,
          });
        }
      }

      // A fetch-streamed SSE response preserves POST authorization and the exact
      // tuple body while showing progress from the real probe operation. No raw
      // provider output or stderr crosses this boundary.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const send = (event, payload) => {
        if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      try {
        const result = await deepQualifyModel({
          entry: backend, model, seatType, expectedReported,
          onProgress: (progress) => send('progress', progress),
        });
        const governed = finishControl({ result });
        send('result', shapeResult(result, governed));
      } catch (error) {
        let governed = null;
        if (!finishAttempted) {
          try { governed = finishControl({ error }); } catch {}
        }
        send('error', {
          error: redactProviderError(error?.message || 'qualification failed'),
          controlRoute: governed?.route ?? null,
        });
      }
      return res.end();
    }

    if (path === '/api/connections' && req.method === 'POST') {
      const body = await readBody(req);
      const allowed = new Set(['connections', 'backends', 'replace']);
      const unknown = Object.keys(body ?? {}).filter((key) => !allowed.has(key));
      if (unknown.length) return json(res, 400, { error: `connection declaration has unknown fields: ${unknown.join(', ')}` });
      const connectionRows = body?.connections && typeof body.connections === 'object' && !Array.isArray(body.connections)
        ? Object.entries(body.connections) : [];
      const backendRows = body?.backends && typeof body.backends === 'object' && !Array.isArray(body.backends)
        ? Object.entries(body.backends) : [];
      if (connectionRows.length !== 1 || backendRows.length !== 1 || ![undefined, true, false].includes(body.replace)) {
        return json(res, 400, { error: 'save exactly one { connections: {name: declaration}, backends: {name: declaration} }; replace must be boolean' });
      }
      const [[connectionName, connection]] = connectionRows;
      const [[backendName, backend]] = backendRows;
      try {
        const saved = saveConnectionBackend({
          connectionName, connection, backendName, backend, replace: body.replace === true,
        });
        return json(res, 200, {
          saved,
          note: `${backendName} is declared locally but not trusted yet. Qualify each exact maker/reviewer tuple before selection.`,
        });
      } catch (error) {
        return json(res, /already exists/.test(String(error?.message)) ? 409 : 400, {
          error: String(error?.message || 'connection declaration was refused').slice(0, 500),
        });
      }
    }

    if (path === '/api/pairing-presentation' && req.method === 'GET') {
      const seats = admissionCatalog();
      const maker = (seats.maker ?? []).find((entry) =>
        entry.backend === url.searchParams.get('makerBackend') && entry.model === url.searchParams.get('makerModel'));
      const reviewer = (seats.reviewer ?? []).find((entry) =>
        entry.backend === url.searchParams.get('reviewerBackend') && entry.model === url.searchParams.get('reviewerModel'));
      return json(res, 200, pairingPresentation({ maker, reviewer }));
    }

    if (path === '/api/evaluation-campaign' && req.method === 'GET') {
      // Public local configuration only: no credentials, qualification
      // receipts, operator choices, or run artifacts enter this document.
      return json(res, 200, { ...MODEL_EVAL_CAMPAIGN, configHash: MODEL_EVAL_CAMPAIGN_HASH });
    }

    if (path === '/api/model-routing' && req.method === 'GET') {
      const requestedClass = url.searchParams.get('taskClass');
      const lane = url.searchParams.get('lane') || 'freeform';
      const depth = url.searchParams.get('depth') || 'standard';
      try {
        return json(res, 200, automaticRouteDecision({
          taskClass: requestedClass || null, lane, depth,
        }));
      } catch (error) {
        return json(res, 400, { error: String(error?.message || error).slice(0, 500) });
      }
    }

    if (path === '/api/config' && req.method === 'GET') {
      const m = getModels();
      const seats = admissionCatalog();
      const currentMaker = (seats.maker ?? []).find((entry) => entry.backend === m.maker.backend && entry.model === m.maker.model);
      const currentReviewer = (seats.reviewer ?? []).find((entry) => entry.backend === m.reviewer.backend && entry.model === m.reviewer.model);
      return json(res, 200, {
        maker: m.maker, reviewer: m.reviewer, loop: m.loop,
        // What the settings pickers may offer: the machine's real options,
        // with the current decision always present. `catalog` is the legacy
        // claude/codex shape Compare & Learn and audit replay still freeze;
        // `seats` is the full backend-qualified catalog for seat selection; its
        // per-backend entries carry the env-var NAME (never the value) and the
        // identity facts each seat seals. `connections` is the normalized endpoint
        // vocabulary (name, kind, baseUrl) — also values-never, per §11.2.
        catalog: modelCatalog(),
        seats,
        templates: seats.templates,
        plannedProtocols: seats.plannedProtocols,
        evaluationCampaign: {
          id: MODEL_EVAL_CAMPAIGN.id,
          configHash: MODEL_EVAL_CAMPAIGN_HASH,
          standing: MODEL_EVAL_CAMPAIGN.standing,
          routingMode: MODEL_EVAL_CAMPAIGN.controls.routingMode,
          minimumRoutingTrialsPerArm: MODEL_EVAL_CAMPAIGN.controls.minimumRoutingTrialsPerArm,
          profiles: MODEL_EVAL_CAMPAIGN.profiles.map(({ id, depth, planPolicy, wallBudgetMinutes, description, cases }) => ({
            id, depth, planPolicy, wallBudgetMinutes, description,
            cases: cases.map((evaluationCase) => ({
              id: evaluationCase.id,
              description: evaluationCase.description,
              deterministicCheckCount: evaluationCase.deterministicChecks.length,
            })),
          })),
        },
        pairingPresentation: pairingPresentation({ maker: currentMaker, reviewer: currentReviewer }),
        connections: listConnections(),
        envOverrides: ['CLAUDE_MODEL', 'CODEX_MODEL', 'CODEX_EFFORT', 'ROUND_CAP'].filter((k) => process.env[k] !== undefined),
      });
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const effort = body.effort;
      if (effort && !EFFORTS.includes(effort)) {
        return json(res, 400, { error: 'effort must be low, medium, high, or xhigh' });
      }
      const roundCap = body.roundCap === undefined ? undefined : Number(body.roundCap);
      if (roundCap !== undefined && (!Number.isInteger(roundCap) || roundCap < 1 || roundCap > 6)) {
        return json(res, 400, { error: 'roundCap must be an integer from 1 to 6' });
      }
      // A seat choice arrives as { backend, model } (the seat picker) or as a
      // bare model string, which keeps its legacy meaning: a model on the
      // seat's CURRENT backend. Validate SERVER-SIDE against the seat catalog:
      // a value the picker never offers (a hidden codex model like
      // codex-auto-review, an undeclared backend, anything off the list) must
      // not be persistable, or it would slip back into the picker as the
      // current decision on the next load.
      const seats = admissionCatalog();
      const current = getModels();
      const normalizeSeat = (value, seatName) => {
        if (value === undefined) return { seat: undefined };
        if (typeof value === 'string') {
          const model = value.trim();
          return model ? { seat: { backend: current[seatName].backend, model } } : { seat: undefined };
        }
        if (!value || typeof value !== 'object' || typeof value.backend !== 'string' || typeof value.model !== 'string') {
          return { error: `${seatName} must be a model string or { backend, model }` };
        }
        return { seat: { backend: value.backend.trim(), model: value.model.trim() } };
      };
      const maker = normalizeSeat(body.maker, 'maker');
      if (maker.error) return json(res, 400, { error: maker.error });
      const reviewer = normalizeSeat(body.reviewer, 'reviewer');
      if (reviewer.error) return json(res, 400, { error: reviewer.error });
      if (maker.seat && !seatOffered(seats.maker, maker.seat.backend, maker.seat.model)) {
        return json(res, 400, { error: `maker "${maker.seat.backend}:${maker.seat.model}" is not an available seat option` });
      }
      if (reviewer.seat && !seatOffered(seats.reviewer, reviewer.seat.backend, reviewer.seat.model)) {
        return json(res, 400, { error: `reviewer "${reviewer.seat.backend}:${reviewer.seat.model}" is not an available seat option (the backend does not list it)` });
      }
      const m = updateModels({ maker: maker.seat, reviewer: reviewer.seat, effort, roundCap });
      return json(res, 200, { maker: m.maker, reviewer: m.reviewer, loop: m.loop, note: 'saved to local operator state; applies from the next run' });
    }

    if (path === '/api/status' && req.method === 'GET') {
      return json(res, 200, {
        engine: ENGINE,
        token: SESSION_TOKEN,
        models: { maker: getModels().maker.model, reviewer: getModels().reviewer.model, effort: getModels().reviewer.effort },
        hivemind: hivemind.hivemindStatus(),
        gate: { installed: ENGINE === 'mock' ? true : gateInstalled() },
        roundCap: getModels().loop.roundCap,
        // Advisory only: the UI shows a counter and a soft note past this, and
        // never blocks or truncates a trust contract.
        advisoryAcceptanceChars: ADVISORY_ACCEPTANCE_CHARS,
        lanes: Object.fromEntries(Object.entries(LANES).map(([k, v]) => [k, v.label])),
      });
    }

    // ---- Blinded calibration workspace (private; token required on GET+POST) --
    // Nothing here calls a model, runs judges, publishes, grants admission, alters
    // routing, or scans arbitrary paths. It operates ONLY on the active generation.
    if (path.startsWith('/api/calibration/')) {
      if (!calibrationTokenOk(req)) {
        return json(res, 401, { error: 'missing or wrong session token; reload the page' });
      }
      const generation = activeGenerationId(MODEL_EVAL_CAMPAIGN);
      const paths = resolveWorkspacePaths(MODEL_EVAL_CAMPAIGN);
      try {
        if (path === '/api/calibration/prepare' && req.method === 'POST') {
          const body = await readBody(req);
          // Prepare is a mutation: it must name the active generation and bind to
          // the current revision ('0' for a create, the queue revision for reuse),
          // so a stale/cross-generation client cannot create or clobber a queue.
          assertGenerationMatches(MODEL_EVAL_CAMPAIGN, body.generation);
          const result = await prepareWorkspace(MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, RUNS_DIR, paths, { expectedRevision: body.revision });
          const sidecar = loadWorkspaceSidecar(paths, MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, generation);
          return json(res, result.created ? 201 : 200, {
            prepared: true,
            created: result.created,
            ...workspaceStatusView(result.queue, MODEL_EVAL_CAMPAIGN, sidecar, generation),
          });
        }

        if (path === '/api/calibration/workspace' && req.method === 'GET') {
          // Bootstrap is read-only and token protected like the prepared view.
          // The browser must discover these bindings, not guess host environment
          // settings or call prepare with an implicit/default generation.
          if (!existsSync(paths.queue)) {
            return json(res, 200, {
              prepared: false,
              generation,
              campaignId: MODEL_EVAL_CAMPAIGN.id,
              queueRevision: 0,
              draftSidecarRevision: 0,
              totalArtifacts: 0,
              labeled: 0,
              labelsFrozen: false,
              disagreementsAvailable: false,
            });
          }
          const queue = loadWorkspaceQueueOrError(paths);
          const sidecar = loadWorkspaceSidecar(paths, MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, generation);
          return json(res, 200, { prepared: true, ...workspaceStatusView(queue, MODEL_EVAL_CAMPAIGN, sidecar, generation) });
        }

        if (path === '/api/calibration/artifact' && req.method === 'GET') {
          const queue = loadWorkspaceQueueOrError(paths);
          const selector = url.searchParams.get('selector');
          if (selector == null || selector === '') throw new WorkspaceError(400, 'an artifact selector is required');
          // Allowlisted resolver: a browser selector is only a public ordinal or
          // content id, never a private sourceRunId (which would defeat blinding).
          const artifact = resolveWorkspaceArtifact(queue, selector);
          const sidecar = loadWorkspaceSidecar(paths, MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, generation);
          return json(res, 200, blindedArtifactView(queue, artifact, sidecar, generation));
        }

        if (path === '/api/calibration/draft' && req.method === 'POST') {
          const body = await readBody(req);
          assertGenerationMatches(MODEL_EVAL_CAMPAIGN, body.generation);
          const patch = {};
          for (const key of ['verdict', 'findingPresence', 'authority', 'owner', 'delegatedBy']) {
            if (Object.hasOwn(body, key)) patch[key] = body[key];
          }
          const { sidecar, artifact } = await saveWorkspaceDraft(MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, paths, {
            selector: body.artifactSelector,
            patch,
            expectedRevision: body.revision,
            navigate: body.navigateTo,
            activeMs: body.activeMs,
          });
          const queue = loadWorkspaceQueueOrError(paths);
          const view = artifact
            ? blindedArtifactView(queue, resolveCalibrationArtifact(queue, artifact.id), sidecar, generation)
            : null;
          return json(res, 200, {
            saved: true,
            draft: view?.draft ?? null,
            navigation: { currentArtifactId: sidecar.navigation.currentArtifactId },
            draftRevision: view?.draftRevision ?? null,
            draftSidecarRevision: sidecar.revision,
          });
        }

        if (path === '/api/calibration/label' && req.method === 'POST') {
          const body = await readBody(req);
          assertGenerationMatches(MODEL_EVAL_CAMPAIGN, body.generation);
          const result = await commitCalibrationLabel(MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, paths, {
            selector: body.artifactSelector,
            authority: body.authority,
            owner: body.owner,
            delegatedBy: body.delegatedBy,
            verdict: body.verdict,
            findingPresence: body.findingPresence,
            expectedRevision: body.revision,
            expectedDraftRevision: body.draftRevision,
            // A browser NEW label must bind to the queue revision; an idempotent
            // retry is exempt (it short-circuits before the revision check).
            requireExpectedRevision: true,
            requireExpectedDraftRevision: true,
          });
          const sidecar = loadWorkspaceSidecar(paths, MODEL_EVAL_CAMPAIGN, MODEL_EVAL_CAMPAIGN_HASH, generation);
          const fresh = resolveCalibrationArtifact(result.queue, result.artifact.id);
          return json(res, 200, {
            committed: true,
            idempotent: result.idempotent,
            artifact: blindedArtifactView(result.queue, fresh, sidecar, generation),
            queueRevision: result.revision,
            status: workspaceStatusView(result.queue, MODEL_EVAL_CAMPAIGN, sidecar, generation),
          });
        }

        if (path === '/api/calibration/disagreements' && req.method === 'GET') {
          const queue = loadWorkspaceQueueOrError(paths);
          const view = disagreementView(queue, MODEL_EVAL_CAMPAIGN, generation);
          return json(res, view.available ? 200 : 409, view);
        }

        return json(res, 404, { error: 'not found' });
      } catch (err) {
        return sendWorkspaceError(res, err);
      }
    }

    if (path === '/api/comparisons' && req.method === 'POST') {
      const body = await readBody(req);
      const goal = String(body.goal || '').trim();
      const acceptanceContract = String(body.acceptanceContract || '').trim();
      if (goal.length < 12) return json(res, 400, { error: 'Write the goal like you would brief a strategist: a sentence or two.' });
      if (goal.length > MAX_GOAL_CHARS) return json(res, 400, { error: `That goal is ${goal.length} characters; keep it under ${MAX_GOAL_CHARS}.` });
      if (acceptanceContract.length < 12) return json(res, 400, { error: 'Say what must be true for you to trust the result. This contract is shared by every arm.' });
      const lane = LANES[body.lane] ? body.lane : 'freeform';
      if (lane === 'build') return json(res, 400, { error: 'parallel execution currently supports research lanes, not repository mutation' });
      const evaluationProfile = body.evaluationProfile == null ? null : String(body.evaluationProfile).trim();
      if (evaluationProfile !== null && !EVALUATION_PROFILES.has(evaluationProfile)) {
        return json(res, 400, { error: 'evaluationProfile must be simple, balanced, or difficult' });
      }
      const depth = body.depth === 'standard' ? 'standard' : 'quick';
      const ground = body.ground === true;
      const evaluation = evaluationBinding(body, evaluationProfile, { goal, acceptanceContract, lane, depth, ground });
      if (!evaluation.ok) return json(res, 400, { error: evaluation.error });
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
          depth,
          ground,
          makerModels,
          reviewerModel,
          reviewerEffort,
          catalog,
          evaluationProfile,
          evaluationCaseId: evaluation.caseId,
          evaluationChecks: evaluation.checks,
          evaluationPlanPolicy: evaluation.planPolicy,
          evaluationCampaignId: evaluation.id,
          evaluationConfigHash: evaluation.hash,
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
      if (body.publish !== undefined && typeof body.publish !== 'boolean') {
        return json(res, 400, { error: 'publish must be true or false; external publication is never inferred' });
      }
      const lane = body.lane === 'build' ? 'build' : LANES[body.lane] ? body.lane : 'freeform';
      const codeMode = body.codeMode ?? 'gate';
      if (!['gate', 'independent'].includes(codeMode) || (body.codeMode !== undefined && lane !== 'build')) {
        return json(res, 400, { error: 'codeMode must be gate or independent, and applies only to Build.' });
      }
      const independentBuild = lane === 'build' && codeMode === 'independent';
      if (independentBuild && ENGINE === 'mock') return json(res, 400, { error: 'Any-model Build needs the live engine and a real isolated Git candidate; rehearsal does not execute it.' });
      const evaluationProfile = body.evaluationProfile == null ? null : String(body.evaluationProfile).trim();
      if (evaluationProfile !== null && !EVALUATION_PROFILES.has(evaluationProfile)) {
        return json(res, 400, { error: 'evaluationProfile must be simple, balanced, or difficult' });
      }
      const depth = body.depth === 'standard' ? 'standard' : 'quick';
      const ground = body.ground === true;
      const evaluation = evaluationBinding(body, evaluationProfile, { goal, acceptanceContract, lane, depth, ground });
      if (!evaluation.ok) return json(res, 400, { error: evaluation.error });
      const iterationPolicy = body.iterationPolicy == null
        ? (evaluationProfile ? 'single_pass' : 'iterative')
        : String(body.iterationPolicy).trim();
      if (!['iterative', 'single_pass'].includes(iterationPolicy)) {
        return json(res, 400, { error: 'iterationPolicy must be iterative or single_pass' });
      }
      if (evaluationProfile && iterationPolicy !== 'single_pass') {
        return json(res, 400, { error: 'an evaluationProfile requires iterationPolicy single_pass' });
      }
      if (iterationPolicy === 'single_pass' && body.publish === true) {
        return json(res, 400, { error: 'single-pass evaluation never publishes; run an ordinary loop for publication' });
      }
      if (lane === 'build' && iterationPolicy === 'single_pass') {
        return json(res, 400, { error: 'single-pass evaluation currently measures words lanes; Build uses the CLI eval ledger over real tasks' });
      }
      if (lane === 'build' && body.publish === true) {
        return json(res, 400, { error: 'Build produces a local branch; Hivemind artifact publication applies only to words lanes' });
      }

      const routingMode = body.modelRouting == null ? 'selected' : String(body.modelRouting).trim();
      if (!['selected', 'automatic'].includes(routingMode)) {
        return json(res, 400, { error: 'modelRouting must be selected or automatic' });
      }
      if (lane === 'build' && routingMode === 'automatic') return json(res, 400, { error: 'Build pairings are selected explicitly; code routing has not been calibrated.' });
      if (routingMode === 'automatic' && body.pairing !== undefined) {
        return json(res, 400, { error: 'choose either an explicit pairing or automatic model routing, not both' });
      }
      if (routingMode === 'automatic' && evaluationProfile) {
        return json(res, 400, { error: 'evaluation runs freeze their treatment pairing and cannot use automatic routing' });
      }

      // Per-run pairing (docs/MULTI-MODEL-SEATS.md): explicit seat choices for
      // THIS run, validated against the same catalog the picker reads, with
      // `run request` recorded as the decision source. Absent → the standing
      // decision record. Build runs the camus gate's own pairing, so an
      // override there is refused loudly rather than silently ignored.
      let modelsSnapshot = null;
      // The backend objects the launch gate qualifies, captured BEFORE any
      // network await and handed to the engine so the run resolves adapters
      // against the EXACT objects qualification validated — never a live reload a
      // concurrent /api/config edit could have swapped (RFC §9.2). Stays null for
      // build/mock/CLI-only launches, which fall back to the live registry.
      let frozenBackends = null;
      // Safe server-authored presentation frozen from the SAME seat snapshot as
      // execution. Never re-read mutable config after the live qualification
      // awaits, or the run banner could describe a newer pairing than the one
      // whose backend objects and fingerprints are actually running.
      let pairingView = null;
      let modelRouting = null;
      if (routingMode === 'automatic') {
        let decision;
        try {
          decision = automaticRouteDecision({
            taskClass: body.taskClass == null ? null : String(body.taskClass).trim(),
            lane, depth,
          });
        } catch (error) {
          return json(res, 400, { error: String(error?.message || error).slice(0, 500) });
        }
        modelRouting = { mode: 'automatic', applied: decision.routed === true, ...decision };
        if (decision.routed === true) {
          const seats = admissionCatalog();
          const makerEntry = admittedSeat(seats.maker, decision.maker.backend, decision.maker.model);
          const reviewerEntry = admittedSeat(seats.reviewer, decision.reviewer.backend, decision.reviewer.model);
          if (!makerEntry || !reviewerEntry
              || makerEntry.admission?.fingerprint !== decision.evidence?.makerAdmission?.fingerprint
              || reviewerEntry.admission?.fingerprint !== decision.evidence?.reviewerAdmission?.fingerprint) {
            modelRouting = { ...modelRouting, applied: false, routed: false, reason: 'route_admission_changed' };
          } else {
            const standing = getModels();
            const effort = reviewerEntry.effort ? (decision.reviewer.effort ?? 'medium') : null;
            modelsSnapshot = {
              maker: { ...snapshotSeat(makerEntry, decision.maker.model), source: 'automatic task-class route' },
              reviewer: {
                ...snapshotSeat(reviewerEntry, decision.reviewer.model), effort,
                modelSource: 'automatic task-class route',
                effortSource: reviewerEntry.effort ? 'automatic task-class route' : 'not honored by this backend',
              },
              loop: { ...standing.loop },
            };
          }
        }
      }
      if (body.pairing !== undefined && !independentBuild) {
        if (lane === 'build') return json(res, 400, { error: 'the Build lane runs the camus gate with its own model decisions; per-run pairing applies to the words lanes' });
        const p = body.pairing;
        const seatOf = (raw, seatName) => {
          if (!raw || typeof raw !== 'object' || typeof raw.backend !== 'string' || typeof raw.model !== 'string' || !raw.backend.trim() || !raw.model.trim()) {
            return { error: `pairing.${seatName} must be { backend, model }` };
          }
          return { backend: raw.backend.trim(), model: raw.model.trim() };
        };
        const makerSeat = seatOf(p.maker, 'maker');
        if (makerSeat.error) return json(res, 400, { error: makerSeat.error });
        const reviewerSeat = seatOf(p.reviewer, 'reviewer');
        if (reviewerSeat.error) return json(res, 400, { error: reviewerSeat.error });
        const seats = admissionCatalog();
        const makerEntry = admittedSeat(seats.maker, makerSeat.backend, makerSeat.model);
        if (!makerEntry) {
          const declared = seats.maker.find((e) => e.backend === makerSeat.backend && e.model === makerSeat.model);
          return json(res, 400, { error: declared
            ? `maker "${makerSeat.backend}:${makerSeat.model}" is declared but not qualified for this exact seat tuple (${declared.admission?.reason}); no substitution was made`
            : `maker "${makerSeat.backend}:${makerSeat.model}" is not an offered seat option; no substitution was made` });
        }
        const reviewerEntry = admittedSeat(seats.reviewer, reviewerSeat.backend, reviewerSeat.model);
        if (!reviewerEntry) {
          const declared = seats.reviewer.find((e) => e.backend === reviewerSeat.backend && e.model === reviewerSeat.model);
          return json(res, 400, { error: declared
            ? `reviewer "${reviewerSeat.backend}:${reviewerSeat.model}" is declared but not qualified for this exact seat tuple (${declared.admission?.reason}); no substitution was made`
            : `reviewer "${reviewerSeat.backend}:${reviewerSeat.model}" is not an offered seat option; no substitution was made` });
        }
        const requestedEffort = p.reviewer?.effort;
        if (requestedEffort !== undefined && !EFFORTS.includes(requestedEffort)) {
          return json(res, 400, { error: 'pairing.reviewer.effort must be low, medium, high, or xhigh' });
        }
        const standing = getModels();
        // Effort only exists where the backend honors the knob. Unrequested,
        // it inherits the standing decision when the backend matches, else the
        // same recorded default getModels() has always used.
        const effort = !reviewerEntry.effort ? null
          : requestedEffort ?? (standing.reviewer.backend === reviewerSeat.backend ? standing.reviewer.effort : 'medium');
        const effortSource = !reviewerEntry.effort ? 'not honored by this backend'
          : requestedEffort !== undefined ? 'run request'
            : standing.reviewer.backend === reviewerSeat.backend ? standing.reviewer.effortSource : 'seat default (medium)';
        modelsSnapshot = {
          maker: { ...snapshotSeat(makerEntry, makerSeat.model), source: 'run request' },
          reviewer: { ...snapshotSeat(reviewerEntry, reviewerSeat.model), effort, modelSource: 'run request', effortSource },
          loop: { ...standing.loop },
        };
      }
      // Grounded managed-connector runs retrieve inside the maker adapter, so
      // the maker seat must run the claude backend — whichever way the pairing
      // was decided. Refused here, before any spend.
      if (lane !== 'build' && groundingNeedsClaudeMaker({
        ground: body.ground === true,
        hivemindMode: hivemind.hivemindStatus().mode,
        makerBackend: (modelsSnapshot ?? getModels()).maker.backend,
      })) {
        return json(res, 400, { error: 'Grounded runs retrieve through the managed Claude connector, so the maker seat must run the claude backend. Run ungrounded or change the pairing.' });
      }

      const parsedVerify = parseVerifyCmd(body.verifyCmd, lane);
      if (!parsedVerify.ok) return json(res, 400, { error: parsedVerify.error });
      const verifyCmd = parsedVerify.verifyCmd;

      let targetPath = null;
      let targetToplevel = null;
      if (lane === 'build') {
        if (ENGINE === 'mock') {
          targetPath = String(body.targetPath || '~/demo-repo').trim();
        } else {
          // The gate's pairing is fixed; the words-lane seat selection must
          // never leak into it. Snapshot the gate-compatible decision NOW so a
          // settings write during target validation cannot swap it either.
          const gate = independentBuild ? null : gateModels();
          if (gate && !gate.ok) return json(res, 400, { error: gate.error });
          if (gate) modelsSnapshot = gate.models;
          if (!independentBuild && !gateInstalled()) {
            return json(res, 400, { error: 'The camus gate is missing or too old for Studio custody. Fix: npm i -g camus-cli && camus install (from this repo: bash packages/cli/install.sh), then check Setup.' });
          }
          const v = await validateBuildTarget(body.targetPath);
          if (!v.ok) return json(res, 400, { error: v.error });
          targetPath = independentBuild ? v.toplevel : v.path;
          if (activeBuilds.size > 0) {
            return json(res, 409, { error: 'A build run is already going; the studio runs one gate at a time.' });
          }
          targetToplevel = v.toplevel;
          if (independentBuild) {
            try {
              // Validate before startRun creates metadata. A symlinked runs
              // directory must not put Camus internals into the target repo.
              await prepareCodeReceiptsDir(RUNS_DIR, targetPath);
              const prepared = await prepareCodeSeats({ pairing: body.pairing ?? null });
              modelsSnapshot = prepared.models;
              frozenBackends = prepared.frozenBackends;
              pairingView = prepared.pairingView;
            } catch (error) {
              return json(res, 400, { error: String(error.message || error).slice(0, 600) });
            }
          }
        }
      }
      // Slice C launch gate (RFC §9.2/§9.4, docs:2627-2629): a configurable
      // openai_compat seat may not launch without a VALID qual1 receipt for the
      // run's seat type. The accepted fingerprint is copied into the run snapshot
      // so the round events and sealed pairing carry it unchanged. Built-in CLI
      // seats (claude/codex) use builtin1. Rehearsals validate stored custom-seat
      // receipts without making the live anchor request.
      if (lane !== 'build') {
        // Freeze the EXACT decision we are about to qualify BEFORE any network
        // await. A concurrent settings write must never swap the standing
        // backend/model out from under the receipts we attach here: if we
        // re-read getModels() after the probes, an old seat's fingerprint could
        // be pinned by seat key onto a newly selected configurable backend that
        // was never qualified, and downstream only checks the fingerprint is
        // syntactically qual1 — so the swapped-in backend would launch
        // unqualified. Materialize once, then qualify and attach against this
        // single frozen snapshot, which also rides into run.models unchanged and
        // resolves the run's adapters (resolveSeatAdapters keys off it).
        const standing = modelsSnapshot ?? getModels();
        const hasConfigurableSeat =
          (standing.maker.backend !== 'claude' && standing.maker.backend !== 'codex') ||
          (standing.reviewer.backend !== 'claude' && standing.reviewer.backend !== 'codex');
        if (hasConfigurableSeat && !modelsSnapshot) {
          const s = standing;
          modelsSnapshot = {
            maker: { ...snapshotSeat(s.maker, s.maker.model), source: s.maker.source },
            reviewer: { ...snapshotSeat(s.reviewer, s.reviewer.model), effort: s.reviewer.effort, modelSource: s.reviewer.modelSource, effortSource: s.reviewer.effortSource },
            loop: { ...s.loop },
          };
        }
        const effective = modelsSnapshot ?? standing;
        const backendsByName = listBackends();
        const seatSpecs = [['maker', 'words_maker', effective.maker], ['reviewer', 'words_reviewer', effective.reviewer]];
        const accepted = {};
        for (const [seatKey, seatType, seat] of seatSpecs) {
          if (seat.backend === 'claude' || seat.backend === 'codex') continue;
          const entry = backendsByName[seat.backend];
          if (!entry || entry.kind !== 'openai_compat') {
            return json(res, 400, { error: `the ${seatKey} seat "${seat.backend}:${seat.model}" is not a qualifiable openai_compat backend and cannot launch` });
          }
          // A rehearsal launches no real model, so it validates the stored tuple
          // without contacting the endpoint. Live Studio re-observes all
          // currently available server anchors immediately before execution.
          const q = ENGINE === 'mock'
            ? storedSeatQualification({ entry, model: seat.model, seatType })
            : await seatQualification({ entry, model: seat.model, seatType });
          if (!q.qualified) {
            return json(res, 400, { error: `${seat.backend}:${seat.model} has no valid ${seatType} qualification (${q.reason}${q.component ? `: ${q.component}` : ''}${q.missing?.length ? ` [${q.missing.join(', ')}]` : ''}). Run \`--doctor\` deep probes (or the connect flow) to qualify it, then retry.` });
          }
          accepted[seatKey] = q.fingerprint;
        }
        for (const [seatKey, fingerprint] of Object.entries(accepted)) {
          modelsSnapshot[seatKey] = {
            ...modelsSnapshot[seatKey],
            qualification: { fingerprint, seatType: seatKey === 'maker' ? 'words_maker' : 'words_reviewer' },
          };
        }
        // Freeze the SAME backend objects just qualified (from the pre-await
        // snapshot `backendsByName`) so the engine resolves its adapters against
        // them, not a live reload a concurrent config edit could have changed
        // under an unchanged name. Only the configurable seats need it; a
        // claude/codex seat resolves identically either way.
        frozenBackends = {
          maker: backendsByName[effective.maker.backend] ?? null,
          reviewer: backendsByName[effective.reviewer.backend] ?? null,
        };
        pairingView = pairingPresentation({ maker: effective.maker, reviewer: effective.reviewer });
      }

      const admission = acquireAdmission(1);
      if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting — the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}.` });
      try {
        // Qualification can await an endpoint. Recheck after that await before
        // reserving a repository, not only during initial target validation.
        if (targetToplevel && activeBuilds.size > 0) return json(res, 409, { error: 'A build run is already going; wait for its terminal receipt.' });
        if (targetToplevel) activeBuilds.add(targetToplevel);
        const id = await startRun({
          goal, acceptanceContract, lane, codeMode,
          depth,
          ground, targetPath, targetToplevel, modelsSnapshot, frozenBackends, pairingView, verifyCmd,
          publish: body.publish === true,
          iterationPolicy,
          evaluationProfile,
          evaluationCaseId: evaluation.caseId,
          evaluationChecks: evaluation.checks,
          evaluationPlanPolicy: evaluation.planPolicy,
          evaluationCampaignId: evaluation.id,
          evaluationConfigHash: evaluation.hash,
          modelRouting,
          // Fair evaluation arms receive no live tools. The frozen brief is the
          // complete input for every maker, including built-in Claude.
          toolPolicy: iterationPolicy === 'single_pass' ? 'none' : null,
        });
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
      for (const [id, s] of runs) list.push({
        id, goal: s.run.displayGoal ?? s.run.goal, lane: s.run.lane, status: s.run.status,
        headline: headlineOf(s.run.statuses, ENGINE === 'mock'), startedAt: s.run.startedAt, live: true,
        ...auditArmFields(s.run), ...(s.run.auditArm ?? {}),
      });
      if (existsSync(RUNS_DIR)) {
        for (const d of await readdir(RUNS_DIR)) {
          if (runs.has(d)) continue;
          try {
            const r = JSON.parse(await readFile(join(RUNS_DIR, d, 'report.json'), 'utf8'));
            // engine === 'mock' is the fallback for rehearsal receipts sealed
            // before `simulated` existed — they must read "rehearsal" too.
            list.push({ id: d, goal: r.displayGoal ?? r.goal, lane: r.lane, status: r.status, headline: headlineOf(r.statuses, r.simulated === true || r.engine === 'mock'), startedAt: r.startedAt, live: false, ...auditArmFields(r) });
          } catch {
            // No sealed report: if start metadata exists, this run was
            // interrupted — list it honestly instead of hiding it.
            try {
              const r = JSON.parse(await readFile(join(RUNS_DIR, d, 'run.json'), 'utf8'));
              list.push({ id: d, goal: r.displayGoal ?? r.goal, lane: r.lane, status: 'incomplete', startedAt: r.startedAt, live: false, ...auditArmFields(r) });
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
        if (![2, 3].includes(sourceReport.evidencePack.schemaVersion) || sourceReport.evidencePack.artifact?.kind !== 'research') {
          return json(res, 400, { error: 'audit-only replay supports research evidence-pack v2 or v3 artifacts' });
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
        // A DISK REPLAY IS NOT A LIVE RUN. Its question cards belong to a session whose
        // token died with the old process, so answering them cannot succeed — the client
        // needs to know before it renders them (field report 2026-08-05: a restart left
        // live-looking buttons that always failed).
        // EVERYTHING THE BROWSER NEEDS TO RENDER THE RECOVERY CONTROL IS COMPUTED *BEFORE* THE
        // FIRST STORED LINE STREAMS, and delivered on replay_start. The stored terminal `status`
        // event closes the client's EventSource and renders the control right then — replay_end
        // arrives after the close, so anything riding only on it never reaches the page. And the
        // first shipped version never delivered it at all: `meta` was declared inside the
        // parkedReplay try-block and referenced outside it, so the continuation try threw a
        // ReferenceError, swallowed it, and every live replay ended `continuation: null` while the
        // regression suite asserted against source regexes instead of the wire (audit 2026-08-07).
        let meta = null;
        for (const f of ['report.json', 'run.json']) {
          try { meta = JSON.parse(await readFile(join(RUNS_DIR, id, f), 'utf8')); break; } catch { /* next */ }
        }
        let knowledgeItemCount = null;
        try {
          const knowledge = JSON.parse(await readFile(join(RUNS_DIR, id, 'knowledge.json'), 'utf8'));
          if (Array.isArray(knowledge.items)) knowledgeItemCount = knowledge.items.length;
        } catch { /* legacy or ungrounded run */ }
        // THE RECOVERY KIND IS DECIDED HERE, by the same function the resume path uses.
        // The browser previously re-derived it from the replayed events with a looser
        // rule — any historical verify_inconclusive counted — so a run that later went
        // red, or whose question was answered, could still be offered the
        // verification-only lane while resume itself (correctly) refused it. One
        // classifier, one answer (audit 2026-08-05).
        let parkedReplay = false;
        try {
          parkedReplay = Boolean(reconstructInterruptedParked(await readRunEvents(id), meta ?? {}));
        } catch { parkedReplay = false; }
        // THE BROWSER IS HANDED THE SAME ANSWER THE RESUME ROUTE WILL ACT ON — the recovery
        // control used to derive its own mode from the run's terminal status, which is how the UI
        // could offer "Resume the gate — reruns planning and implementation" over a clean committed
        // candidate (run 20260807-080214-p27e). Presentation is a projection of the decision.
        let continuation = null;
        try {
          const plan = deriveContinuation(await gatherContinuationEvidence(meta ?? {}));
          continuation = { ...plan, presentation: continuationPresentation(plan) };
        } catch { continuation = null; }
        res.write(`data: ${JSON.stringify({ type: 'replay_start', live: false, continuation })}\n\n`);
        const stream = createReadStream(file, 'utf8');
        let buf = '';
        stream.on('data', (c) => {
          buf += c;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) if (l.trim()) res.write(`data: ${decorateReplayLine(l, { knowledgeItemCount })}\n\n`);
        });
        // replay_end still carries it as a belt for clients that outlive the stored stream.
        const finish = () => { res.write(`data: ${JSON.stringify({ type: 'replay_end', parked: parkedReplay, continuation })}\n\n`); res.end(); };
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
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        if (!body || typeof body !== 'object') body = {};
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
          let recoveryEvaluation = { profile: null, caseId: null, checks: null, planPolicy: null, id: null, hash: null };
          if (meta.evaluationProfile) {
            if (meta.evaluationCampaignId !== MODEL_EVAL_CAMPAIGN.id || meta.evaluationConfigHash !== MODEL_EVAL_CAMPAIGN_HASH) {
              return json(res, 409, { error: 'this evaluation comparison belongs to an older campaign generation and cannot be resumed under a changed treatment' });
            }
            const treatment = findEvaluationCase(MODEL_EVAL_CAMPAIGN, meta.evaluationProfile, meta.evaluationCaseId);
            if (!treatment) return json(res, 409, { error: 'the evaluation case sealed by this comparison is no longer registered' });
            recoveryEvaluation = {
              profile: meta.evaluationProfile,
              caseId: meta.evaluationCaseId,
              checks: treatment.evaluationCase.deterministicChecks,
              planPolicy: treatment.profile.planPolicy,
              id: meta.evaluationCampaignId,
              hash: meta.evaluationConfigHash,
            };
          }
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
              evaluationProfile: recoveryEvaluation.profile,
              evaluationCaseId: recoveryEvaluation.caseId,
              evaluationChecks: recoveryEvaluation.checks,
              evaluationPlanPolicy: recoveryEvaluation.planPolicy,
              evaluationCampaignId: recoveryEvaluation.id,
              evaluationConfigHash: recoveryEvaluation.hash,
              resumeExperiment: experiment,
              resumeSnapshot: snapshot,
            });
            return json(res, 201, recovered);
          } finally {
            admission.release();
          }
        }
        // Build runs resume by re-invoking the gate with the SAME custody identity
        // (idSalt), so it reuses the same worktree. It does NOT skip phases: the gate
        // re-enters Plan and Implement every time, which is precisely why a run that
        // already parked a candidate takes the recovery path below instead.
        if (meta.lane !== 'build') return json(res, 400, { error: 'only build runs and incomplete comparisons can resume' });
        if (meta.codeMode === 'independent') return json(res, 409, { error: 'This experimental candidate requires inspection and explicit human acceptance. It cannot resume through the legacy gate or silently rerun models. Its worktree and receipt are preserved.' });
        if (!meta.idSalt) return json(res, 400, { error: 'this run predates resumable receipts. Start a fresh build run instead.' });
        // A run that started before verifyCmd existed — or one whose auto-detected
        // verification turned out to be wrong for this host — must be able to
        // acquire the command WITHOUT relaunching, since relaunching would redo the
        // plan and implement work the candidate already holds. An override supplied
        // here is validated by the same rule as a fresh launch; absent, the saved
        // value carries forward untouched.
        const resumeVerify = parseVerifyCmd(body.verifyCmd, 'build');
        if (!resumeVerify.ok) return json(res, 400, { error: resumeVerify.error });
        const resumeVerifyCmd = resumeVerify.verifyCmd ?? meta.verifyCmd ?? null;

        // A PARKED CANDIDATE IS NOT RESTARTED. When the source run sealed
        // needs_decision over a verify_inconclusive gate report, its candidate is
        // already committed and already reviewed — the only thing missing is a
        // verdict. Re-entering the gate re-plans and re-implements it (field report
        // 2026-08-05: `Verify → Plan → Implement` on run 20260805-104802-rv4d), so
        // this routes to the verification-only recovery lane instead: host verifier,
        // zero model turns, bound to the sha the original sealed. The source receipt
        // is untouched; the recovery seals its own that references it.
        const liveWorktree = gateStateFromStatus(await readGateStatus(meta.idSalt).catch(() => null))?.worktree ?? null;
        // A run interrupted while awaiting the verification question sealed no terminal
        // report, so the sealed-report checks find nothing and the old behaviour fell
        // through to the gate. Rebuild the parked state from the event trail first; the
        // SAME safety checks then apply to it (worktree identity, branch, clean HEAD,
        // sha binding) and it claims no source receipt, because none was sealed.
        let source = meta;
        if (!recoveryTarget(meta, { worktreeFallback: liveWorktree }).parkedCandidate) {
          const rebuilt = reconstructInterruptedParked(await readRunEvents(id), meta);
          if (rebuilt) source = rebuilt;
        }
        // ── ONE AUTHORITATIVE CONTINUATION, DERIVED FROM DURABLE EVIDENCE ────────────────
        // Run 20260807-080214-p27e: the UI said Verify, the durable status said Implement round 2,
        // the worktree was clean at 5c62c3c with two receipts and three parked commits — and the
        // resume re-entered the gate, which restarted Plan at round 1 and began reasoning its way
        // toward undoing an audited fix. Whatever the sealed report does or does not say, a resume
        // asks THIS first, and the browser is handed the same answer it routes by.
        const contEvidence = await gatherContinuationEvidence(meta);
        const continuation = deriveContinuation(contEvidence);
        if (continuation.action === 'refuse') {
          // The refusal keeps saying WHY restarting is not the fallback: re-entering the gate would
          // re-plan and re-implement work that already exists, which is the harm being prevented.
          return json(res, 409, {
            error: `This run will not be restarted through the gate — that would re-plan and re-implement work that already exists. ${continuation.reason}.`,
            continuation: { ...continuation, presentation: continuationPresentation(continuation) },
          });
        }
        // Committed work with review history may never be re-planned, whatever the sealed report
        // looks like. The verification-only lane runs zero model turns, so the parked candidate
        // cannot be redesigned by a fresh plan.
        // Committed work with review history may never be re-planned, whatever the sealed report
        // looks like. The verification-only lane runs zero model turns, so the parked candidate
        // cannot be redesigned by a fresh plan.
        //
        // When the classifier says continue-in-place but the sealed report never carried the
        // needs_decision/verify_inconclusive pair the recovery lane keys on, ONLY that precondition
        // is waived: the request is re-derived with the durable evidence standing in for it, and
        // resolveRecoveryTarget still applies every one of its own safety checks — worktree
        // identity, worktree root, clean tree, recorded branch, sha binding. An earlier draft of
        // this built the target by hand instead and silently skipped the branch check, which
        // api.test's moved-branch case caught.
        let target = await resolveRecoveryTarget(source, { worktreeFallback: liveWorktree });
        if (continuation.action === 'verify_only' && !target.eligible) {
          const wtPath = contEvidence.worktree?.path ?? liveWorktree;
          const adoptedSource = {
            ...source,
            status: 'needs_decision',
            // NO SHA IS SUPPLIED. Handing one in makes resolveRecoveryTarget take its
            // "the receipt sealed this commit" path, which skips the recorded-branch check and
            // would label the result `sealed_by_source` when nothing sealed anything. Leaving it
            // absent routes through LEGACY ADOPTION, which checks the branch and labels the sha
            // `adopted_clean_worktree_head` — honest, and the check api.test's moved-branch case
            // depends on.
            report: {
              ...(source.report ?? {}),
              status: 'verify_inconclusive',
              worktree: wtPath,
              // THE RECORDED BRANCH TRAVELS INTO ADOPTION. Without it, resolveRecoveryTarget's
              // legacy-adoption path had no branch to hold this worktree against on exactly the
              // stopped-run shape that reaches this fallback, so its branch check silently never
              // ran (audit 2026-08-07). The durable status record is the authority; the sealed
              // report's own branch is the fallback.
              branch: contEvidence.status?.branch ?? source.report?.branch ?? undefined,
              parkedSha: undefined,
              commit_sha: undefined,
              commit: undefined,
            },
          };
          const adopted = await resolveRecoveryTarget(adoptedSource, { worktreeFallback: liveWorktree });
          if (adopted.eligible) target = { ...adopted, continuationProvenance: continuation.provenance };
        }
        // NEVER FALL THROUGH ON A PARKED CANDIDATE. When the receipt IS an outer
        // needs_decision over a nested verify_inconclusive but no safe target can be
        // established, the answer is an explicit refusal naming the obstacle — not a
        // gate run that re-plans and re-implements the parked work.
        if (!target.eligible && target.parkedCandidate) {
          return json(res, 409, { error: `This run parked a candidate, so it will not be restarted through the gate — that would re-plan and re-implement work that already exists. Recovery cannot proceed because ${target.reason}. Fix that and resume again, or inspect the worktree by hand.` });
        }
        // A REHEARSAL MUST NOT DO THIS. Recovery deliberately ignores ENGINE so it
        // can never fabricate a verdict about a real commit — but that means a mock
        // Studio would run real verification commands inside a real repository while
        // the UI labels the result a rehearsal. Both halves of that are wrong, so a
        // rehearsal refuses the recovery outright instead.
        if (target.eligible && ENGINE === 'mock') {
          return json(res, 400, { error: 'This Studio is running in rehearsal (mock) mode, and recovering a parked candidate runs real verification commands inside your repository. Restart Studio with the live engine to recover it.' });
        }
        if (target.eligible) {
          const admission = acquireAdmission(1);
          if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}` });
          try {
            const newId = await startRun({
              goal: meta.goal, acceptanceContract: meta.acceptanceContract, lane: 'build',
              depth: 'quick', ground: false, targetPath: meta.targetPath, idSalt: meta.idSalt,
              verifyCmd: resumeVerifyCmd, recovery: { ...target, interruptedRecovery: source.interruptedRecovery === true },
            });
            return json(res, 201, { id: newId, mode: 'verification_recovery', parkedSha: target.parkedSha, shaProvenance: target.shaProvenance });
          } finally {
            admission.release();
          }
        }
        if (ENGINE !== 'mock') {
          // THE GATE FALL-THROUGH IS NOW GUARDED. It re-plans and re-implements, so it is reachable
          // only when the continuation classifier said nothing exists yet to regress. Reaching it
          // with a committed candidate is the exact defect of run 20260807-080214-p27e.
          if (continuation.action !== 'gate') {
            return json(res, 409, {
              error: `This run holds work a fresh gate run would re-plan (${continuation.reason}), so it will not be restarted through the gate.`,
              continuation: { ...continuation, presentation: continuationPresentation(continuation) },
            });
          }
          // Not recoverable in place (no parked candidate, or it ended some other
          // way), so this re-enters the fixed gate — same rule as a fresh build.
          // The gate resumes the same custody identity; it does NOT skip phases.
          const gate = gateModels();
          if (!gate.ok) return json(res, 400, { error: gate.error });
          const v = await validateBuildTarget(meta.targetPath);
          if (!v.ok) return json(res, 400, { error: `the original target no longer validates: ${v.error}` });
          if (activeBuilds.size > 0) return json(res, 409, { error: 'a build run is already going; one gate at a time' });
          const admission = acquireAdmission(1);
          if (!admission.ok) return json(res, 429, { error: `${admission.used} runs are already active or starting; the studio caps concurrent runs at ${MAX_ACTIVE_RUNS}` });
          try {
            activeBuilds.add(v.toplevel);
            const newId = await startRun({ goal: meta.goal, acceptanceContract: meta.acceptanceContract, lane: 'build', depth: 'quick', ground: false, targetPath: v.path, targetToplevel: v.toplevel, idSalt: meta.idSalt, modelsSnapshot: gate.models, verifyCmd: resumeVerifyCmd });
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
          const newId = await startRun({ goal: meta.goal, acceptanceContract: meta.acceptanceContract, lane: 'build', depth: 'quick', ground: false, targetPath: meta.targetPath, idSalt: meta.idSalt, verifyCmd: resumeVerifyCmd });
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

// The server owns the process-local tunnel manager. Handlers are installed by
// this application boundary (never by the reusable manager module) and are
// removable/testable through closeStudioResources().
export async function closeStudioResources() {
  await getSharedTunnelManager().close();
}
const tunnelLifecycle = installTunnelLifecycle({ manager: getSharedTunnelManager(), server });

// Startup orphan cleanup is part of readiness, even when this Studio process
// has not yet admitted a tunnel. The manager remains a library with no import-
// time signal handlers; this application boundary owns the awaited sweep.
const startupSweep = await getSharedTunnelManager().startup();
for (const result of startupSweep) {
  if (result.action === 'closed') console.warn(`Camus: closed orphaned SSH tunnel for connection "${result.connection}" during startup.`);
  if (result.action === 'corrupt_inconclusive') console.warn(`Camus: could not conclusively inspect the local SSH lease for connection "${result.connection}" during startup.`);
}
server.listen(PORT, BIND, () => {
  const hm = hivemind.hivemindStatus();
  const p = actualPort();
  console.log(`\n  Camus Loop Studio\n  http://localhost:${p}\n  bind: ${BIND} · engine: ${ENGINE}${ENGINE === 'mock' ? ' (rehearsal)' : ''} · hivemind: ${hm.connected ? 'connected' : 'stub'} · hosted origins: ${REMOTE_ORIGINS.join(', ')} · receipts: ./runs/\n`);
  if (process.platform === 'darwin' && process.env.OPEN !== '0' && !process.env.CI) {
    spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' }).on('error', () => {});
  }
});
