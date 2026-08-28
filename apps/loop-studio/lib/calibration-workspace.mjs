// Durable, blinded calibration WORKSPACE. This module is a thin, safe facade in
// front of the real calibration authority (model-eval-calibration.mjs +
// judge-calibration.mjs). It adds exactly what a browser needs and nothing the
// CLI does not already own:
//   - prepare/reuse the active-generation queue from STUDIO_RUNS_DIR reports
//   - allowlisted, blinded status/artifact views (never the raw queue/artifacts)
//   - a mutable private draft sidecar (never evidence) with resume + timing/ETA
//   - an explicit, immutable label commit that reuses the canonical validators
//   - read-only, post-freeze disagreement rows
//
// It NEVER calls a model, runs judges, publishes, grants admission, alters
// routing, or scans arbitrary paths. Every mutation binds to
// {generation, artifact, revision}, re-reads under a shared cross-process lock,
// rejects stale writes, and writes 0600 files under 0700 operator directories.
// The SAME lock + commit transaction is used by the CLI so a browser tab and a
// terminal cannot clobber each other.

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  existsSync, readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { judgeCalibrationPaths } from './judge-calibration.mjs';
import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';
import {
  calibrationQueueSummary,
  isCalibrationFrozen,
  labelCalibrationArtifact,
  loadCalibrationQueue,
  persistCalibrationQueue,
  prepareCalibrationQueue,
  resolveCalibrationArtifact,
} from './model-eval-calibration.mjs';
import { loadEvaluationReports } from './model-eval-summary.mjs';

const VERDICTS = new Set(['APPROVED', 'REVISE']);
const FINDING_PRESENCE = new Set(['clean', 'findings']);
const AUTHORITIES = new Set(['human', 'expert_ai_proxy']);
const SIDECAR_SCHEMA = 1;
const MAX_TIMING_SAMPLES = 50;
// A single label's active time is bounded so a hostile client cannot poison the
// median with Number.MAX_VALUE and turn every ETA into Infinity (which JSON then
// serializes as null while the response still claims to be available). One day
// is far beyond any honest per-label session.
const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;

// A bounded, path-free error the HTTP layer can forward verbatim. Any other
// thrown error is treated as a generic internal failure so filesystem messages
// (which contain absolute paths) never reach the browser.
export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.httpCode = code;
    this.expose = true;
  }
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// ---------------------------------------------------------------------------
// Generation + paths. The workspace only ever operates on the ACTIVE generation
// the server pins; a client-supplied generation must match it exactly. This is
// what keeps the feature from scanning arbitrary operator directories.
// ---------------------------------------------------------------------------

export function activeGenerationId(campaign) {
  return process.env.STUDIO_JUDGE_CALIBRATION_GENERATION ?? campaign.id;
}

export function resolveWorkspacePaths(campaign) {
  return judgeCalibrationPaths(activeGenerationId(campaign));
}

// The generation a sidecar (drafts/navigation/timing) is bound to. Callers reach
// the workspace with paths already pinned to a generation (the server pins the
// active one; the CLI pins its --generation flag), so the sidecar generation is
// the PATHS' generation, NOT the process-wide env/campaign default. Using the env
// default here would make a `--label --generation X` commit load a different
// generation's sidecar (treating X's draft/timing as stale and losing them).
function sidecarGeneration(campaign, paths) {
  return paths.generation ?? activeGenerationId(campaign);
}

// A generation binding is REQUIRED on every mutation and must equal the active
// one. A stale client that omits it (or names another generation) must not be
// able to commit a label, draft, navigation, or prepare against the wrong queue.
export function assertGenerationMatches(campaign, supplied) {
  if (typeof supplied !== 'string' || supplied === '') {
    throw new WorkspaceError(409, 'this request must name the active calibration generation; reload the workspace');
  }
  if (supplied !== activeGenerationId(campaign)) {
    throw new WorkspaceError(409, 'that generation is not the active calibration generation; reload the workspace');
  }
}

// A generation is frozen once paid judge execution has BEGUN, not only once a
// judge run has completed: a persisted attempt (a started/failed/aborted marker,
// written under the shared lock before the adapter is invoked) freezes labels
// just as a completed run does. This is what keeps labels immutable across a
// crash or failed attempt mid-execution.
export const isFrozen = isCalibrationFrozen;

// Allowlisted artifact resolver for browser-facing selectors. ONLY public ordinal
// or content-id (sha256, full or prefix) forms resolve here; a private sourceRunId
// must never be a valid selector, or a caller who knows/guesses a run id could map
// a blinded artifact back to its source and defeat blinding. (The canonical
// resolveCalibrationArtifact intentionally also matches sourceRunId for the CLI;
// this feature must not.)
export function resolveWorkspaceArtifact(queue, selector) {
  if (typeof selector !== 'string'
      && !(typeof selector === 'number' && Number.isSafeInteger(selector) && selector > 0)) {
    throw new WorkspaceError(400, 'an artifact selector must be a public ordinal or content-id string');
  }
  const raw = String(selector ?? '').trim();
  if (raw === '') throw new WorkspaceError(400, 'an artifact selector is required');
  const isOrdinal = /^\d+$/.test(raw);
  const isContentId = /^sha256:[0-9a-f]{1,64}$/.test(raw);
  if (!isOrdinal && !isContentId) throw new WorkspaceError(400, 'unknown or ambiguous artifact selector');
  const ordinal = isOrdinal ? Number(raw) : null;
  const matches = queue.artifacts.filter((artifact) => (isOrdinal && artifact.ordinal === ordinal)
    || artifact.id === raw || (isContentId && artifact.id.startsWith(raw)));
  if (matches.length !== 1) throw new WorkspaceError(400, 'unknown or ambiguous artifact selector');
  return matches[0];
}

// ---------------------------------------------------------------------------
// Cross-process lock (server tabs AND the CLI share it). Node 18 has no core
// flock API, so use an OS-owned loopback TCP listener whose deterministic port
// is derived from the workspace queue path. The listener is held for precisely
// the mutation callback, and the OS releases it on SIGKILL/crash — no sentinel,
// TTL, unlink, PID-reuse inference, dependency, or Python runtime is involved.
//
// Different workspaces can hash to the same port (a bounded, fail-closed false
// contention only); an unrelated local listener produces the same bounded busy
// error. This is local-host locking only, never a distributed/multi-host lease.
// Operators should retry visible port contention; preserving evidence wins over
// liveness.
// ---------------------------------------------------------------------------

function lockPortFor(paths) {
  const digest = createHash('sha256').update(resolve(paths.queue), 'utf8').digest();
  return 20000 + (digest.readUInt32BE(0) % 30000);
}

function waitForLock(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function listenForLock(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => { cleanup(); rejectListen(error); };
    const onListening = () => { cleanup(); resolveListen(); };
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function closeLock(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function withCalibrationLock(paths, fn, { timeoutMs = 4000 } = {}) {
  const port = lockPortFor(paths);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await listenForLock(server, port);
    } catch (error) {
      if (server.listening) await closeLock(server);
      if (error?.code !== 'EADDRINUSE') {
        throw new WorkspaceError(503, 'calibration locking is unavailable; retry the workspace');
      }
      if (Date.now() >= deadline) throw new WorkspaceError(503, 'the calibration workspace is busy; reload and retry');
      await waitForLock(20);
      continue;
    }
    try { return await fn(); }
    finally { await closeLock(server); }
  }
}

// ---------------------------------------------------------------------------
// Revision. The queue file has no stored counter, so the mutation revision is
// DERIVED from the mutable state (labels + judge-run bindings + frozen flag).
// A CLI label, a concurrent tab, or a judge run all change it, which is exactly
// what a stale browser write must be rejected against.
// ---------------------------------------------------------------------------

export function queueRevision(queue) {
  const material = {
    labels: queue.artifacts.map((a) => (a.humanLabel
      ? [a.ordinal, a.humanLabel.authority ?? null, a.humanLabel.verdict, a.humanLabel.findingPresence,
        a.humanLabel.labeledBy, a.humanLabel.delegatedBy ?? null]
      : [a.ordinal, null])),
    judgeRuns: queue.judgeRuns.map((r) => [r.artifactId, r.judgeId]).sort(),
    attempts: (queue.attempts ?? []).map((a) => [a.artifactId, a.judgeId, a.sourceRunId]).sort(),
    frozen: isFrozen(queue),
  };
  return `q_${createHash('sha256').update(canonical(material), 'utf8').digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Draft sidecar — a SEPARATE private file. Never evidence, never a label. Empty
// fields stay empty; only an explicit commit ever writes a canonical label.
// ---------------------------------------------------------------------------

function sidecarPath(paths) {
  return process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE
    || join(dirname(paths.queue), 'model-eval-calibration-drafts.json');
}

function defaultSidecar(campaign, configHash, generation) {
  return {
    schemaVersion: SIDECAR_SCHEMA,
    campaignId: campaign.id,
    evaluationConfigHash: configHash,
    generation: generation ?? null,
    revision: 0,
    navigation: { currentArtifactId: null },
    drafts: {},
    timingSamples: [],
  };
}

function normalizeDraftEntry(entry) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    verdict: VERDICTS.has(entry?.verdict) ? entry.verdict : null,
    findingPresence: FINDING_PRESENCE.has(entry?.findingPresence) ? entry.findingPresence : null,
    authority: AUTHORITIES.has(entry?.authority) ? entry.authority : null,
    owner: pick(entry?.owner),
    delegatedBy: pick(entry?.delegatedBy),
    activeMs: Number.isFinite(entry?.activeMs) && entry.activeMs >= 0 ? Math.min(Math.floor(entry.activeMs), MAX_ACTIVE_MS) : 0,
    revision: Number.isSafeInteger(entry?.revision) && entry.revision >= 0 ? entry.revision : 0,
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

function validStoredDraftEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.verdict !== undefined && entry.verdict !== null && !VERDICTS.has(entry.verdict)) return false;
  if (entry.findingPresence !== undefined && entry.findingPresence !== null && !FINDING_PRESENCE.has(entry.findingPresence)) return false;
  if (entry.authority !== undefined && entry.authority !== null && !AUTHORITIES.has(entry.authority)) return false;
  for (const key of ['owner', 'delegatedBy', 'updatedAt']) {
    if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'string') return false;
  }
  if (entry.activeMs !== undefined && (!Number.isSafeInteger(entry.activeMs) || entry.activeMs < 0 || entry.activeMs > MAX_ACTIVE_MS)) return false;
  return entry.revision === undefined || (Number.isSafeInteger(entry.revision) && entry.revision >= 0);
}

// Only a missing sidecar can initialize as fresh scratch. Existing durable
// sidecars are user work: malformed, unreadable, unsupported, or stale state must
// fail closed and remain untouched rather than being silently reset then replaced.
function loadSidecar(paths, campaign, configHash, generation) {
  const file = sidecarPath(paths);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultSidecar(campaign, configHash, generation);
    throw new WorkspaceError(409, 'the calibration draft sidecar cannot be read; repair it before editing');
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new WorkspaceError(409, 'the calibration draft sidecar is malformed; repair it before editing'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== SIDECAR_SCHEMA
      || value.campaignId !== campaign.id || value.evaluationConfigHash !== configHash
      || (value.generation ?? null) !== (generation ?? null)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !value.navigation || typeof value.navigation !== 'object' || Array.isArray(value.navigation)
      || !('currentArtifactId' in value.navigation)
      || (value.navigation.currentArtifactId !== null && typeof value.navigation.currentArtifactId !== 'string')
      || !value.drafts || typeof value.drafts !== 'object' || Array.isArray(value.drafts)
      || Object.values(value.drafts).some((entry) => !validStoredDraftEntry(entry))
      || !Array.isArray(value.timingSamples)
      || value.timingSamples.some((n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_ACTIVE_MS)) {
    throw new WorkspaceError(409, 'the calibration draft sidecar is unsupported or belongs to another generation; repair it before editing');
  }
  const drafts = {};
  for (const [id, entry] of Object.entries(value.drafts)) drafts[id] = normalizeDraftEntry(entry);
  return {
    schemaVersion: SIDECAR_SCHEMA,
    campaignId: campaign.id,
    evaluationConfigHash: configHash,
    generation: generation ?? null,
    revision: value.revision,
    navigation: { currentArtifactId: value.navigation.currentArtifactId },
    drafts,
    timingSamples: value.timingSamples.slice(-MAX_TIMING_SAMPLES),
  };
}

function saveSidecar(paths, sidecar) {
  studioAtomicWrite(sidecarPath(paths), `${JSON.stringify(sidecar, null, 2)}\n`, STUDIO_FILE_MODE);
  return sidecar;
}

export function loadWorkspaceSidecar(paths, campaign, configHash, generation) {
  return loadSidecar(paths, campaign, configHash, generation);
}

// ---------------------------------------------------------------------------
// Allowlisted, blinded views. These are built field-by-field; the raw queue and
// artifact objects are NEVER returned. Nothing here exposes sourceRunId,
// artifactFile, source-evidence ids, maker/reviewer identity, judge verdicts, or
// prior model decisions.
// ---------------------------------------------------------------------------

function medianMs(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function workspaceStatusView(queue, campaign, sidecar, generation) {
  const summary = calibrationQueueSummary(queue, campaign);
  const remainingUnlabeled = summary.pendingHumanLabels;
  const sampleCount = sidecar.timingSamples.length;
  const perLabelMs = medianMs(sidecar.timingSamples);
  // ETA is honest: unavailable until at least one measured sample exists.
  const eta = perLabelMs !== null && remainingUnlabeled > 0
    ? { available: true, remainingUnlabeled, sampleCount, perLabelMs, etaMs: remainingUnlabeled * perLabelMs }
    : { available: false, remainingUnlabeled, sampleCount, perLabelMs: null, etaMs: null };
  return {
    generation,
    campaignId: queue.campaignId,
    standing: queue.standing,
    totalArtifacts: summary.artifacts,
    labeled: summary.labels,
    humanLabels: summary.humanLabels,
    proxyLabels: summary.proxyLabels,
    pendingLabels: summary.pendingHumanLabels,
    // Frozen the instant judge execution BEGINS (a persisted attempt), not only
    // once a run completes — so a durable failed/aborted attempt reads as frozen.
    labelsFrozen: isFrozen(queue),
    labelPolicy: queue.labelPolicy,
    navigation: { currentArtifactId: sidecar.navigation.currentArtifactId },
    artifacts: queue.artifacts.map((a) => ({
      ordinal: a.ordinal,
      id: a.id,
      labeled: Boolean(a.humanLabel),
      authority: a.humanLabel?.authority ?? null,
      hasDraft: Boolean(sidecar.drafts[a.id] && draftHasContent(sidecar.drafts[a.id])),
    })),
    eta,
    queueRevision: queueRevision(queue),
    draftSidecarRevision: sidecar.revision,
    disagreementsAvailable: disagreementsUnlocked(queue),
  };
}

function draftHasContent(entry) {
  return Boolean(entry.verdict || entry.findingPresence || entry.authority || entry.owner || entry.delegatedBy);
}

function committedLabelView(label) {
  if (!label) return null;
  const view = {
    authority: label.authority,
    verdict: label.verdict,
    findingPresence: label.findingPresence,
    labeledBy: label.labeledBy,
    labeledAt: label.labeledAt,
  };
  if (label.delegatedBy) view.delegatedBy = label.delegatedBy;
  return view;
}

function draftView(entry, artifactId) {
  if (!entry) return null;
  return {
    artifactId,
    verdict: entry.verdict,
    findingPresence: entry.findingPresence,
    authority: entry.authority,
    owner: entry.owner,
    delegatedBy: entry.delegatedBy,
    activeMs: entry.activeMs,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
  };
}

export function blindedArtifactView(queue, artifact, sidecar, generation) {
  return {
    generation,
    ordinal: artifact.ordinal,
    id: artifact.id,
    caseId: artifact.caseId,
    profile: artifact.profile,
    lane: artifact.lane,
    goal: artifact.goal,
    acceptanceContract: artifact.acceptanceContract,
    deliverable: artifact.deliverable,
    labelsFrozen: isFrozen(queue),
    committedLabel: committedLabelView(artifact.humanLabel),
    draft: draftView(sidecar.drafts[artifact.id] ?? null, artifact.id),
    queueRevision: queueRevision(queue),
    draftRevision: sidecar.drafts[artifact.id]?.revision ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Disagreements — read-only, and only after every label is committed AND judges
// have run (labels are then frozen). It cannot mutate labels or upgrade standing.
// ---------------------------------------------------------------------------

export function disagreementsUnlocked(queue) {
  return queue.artifacts.length > 0
    && queue.artifacts.every((a) => a.humanLabel)
    && queue.judgeRuns.length > 0;
}

export function disagreementView(queue, campaign, generation) {
  if (!disagreementsUnlocked(queue)) {
    return { available: false, reason: 'disagreements unlock once every artifact is labeled and the judges have run' };
  }
  const seatByJudge = new Map(campaign.calibration.judges.map((j) => [j.id, `${j.backend}:${j.model}`]));
  const rows = queue.artifacts.map((artifact) => {
    const human = artifact.humanLabel;
    const judges = queue.judgeRuns
      .filter((run) => run.artifactId === artifact.id)
      .map((run) => ({
        judgeId: run.judgeId,
        seat: seatByJudge.get(run.judgeId) ?? null,
        verdict: run.verdict,
        findingPresence: run.findingPresence,
        verdictAgrees: run.verdict === human.verdict,
        findingPresenceAgrees: run.findingPresence === human.findingPresence,
      }))
      .sort((a, b) => a.judgeId.localeCompare(b.judgeId));
    return {
      ordinal: artifact.ordinal,
      id: artifact.id,
      human: { verdict: human.verdict, findingPresence: human.findingPresence, authority: human.authority },
      judges,
    };
  });
  return { available: true, generation, rows };
}

// ---------------------------------------------------------------------------
// Prepare / reuse (no model spend). Reads reports from STUDIO_RUNS_DIR only.
// ---------------------------------------------------------------------------

// Prepare/reuse the active-generation queue. Binds to the caller's revision under
// the shared lock so a stale client cannot create/overwrite a queue another writer
// (a concurrent HTTP prepare or the CLI) has already advanced. The bound revision
// is '0' while no queue exists yet (a create) and the current queue revision once
// it does (a reuse); either way it is compared under the lock after re-reading.
export async function prepareWorkspace(campaign, configHash, runsDir, paths, { expectedRevision } = {}) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    throw new WorkspaceError(409, 'reload the workspace before preparing; a prepare must bind to the current revision');
  }
  const { reports, unreadableReports } = loadEvaluationReports(runsDir);
  if (unreadableReports) {
    throw new WorkspaceError(409, 'some evaluation reports are unreadable; repair them before preparing calibration');
  }
  let result;
  try {
    result = await withCalibrationLock(paths, () => {
      const currentRevision = existsSync(paths.queue)
        ? queueRevision(loadQueueOrThrow(campaign, configHash, paths))
        : '0';
      if (String(expectedRevision) !== currentRevision) {
        throw new WorkspaceError(409, 'the workspace changed since you loaded it; reload before preparing');
      }
      return prepareCalibrationQueue(campaign, configHash, reports, { paths });
    });
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    // selection failures ("needs 12 distinct active artifacts…") are safe and useful.
    if (/calibration (needs|selection)/.test(error.message)) throw new WorkspaceError(409, error.message);
    throw new WorkspaceError(500, 'could not prepare the calibration workspace');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Draft autosave (mutable sidecar). Binds to {generation, artifact, revision}.
// Presence-only patch: a field absent from the patch is untouched; an explicit
// null clears it. Never writes a canonical label.
// ---------------------------------------------------------------------------

function loadQueueOrThrow(campaign, configHash, paths) {
  if (!existsSync(paths.queue)) throw new WorkspaceError(404, 'the calibration workspace is not prepared for the active generation');
  try {
    return loadCalibrationQueue(campaign, configHash, paths);
  } catch (error) {
    if (/stale for the active campaign generation/.test(error.message)) {
      throw new WorkspaceError(409, 'the calibration queue is stale for the active campaign; reload');
    }
    throw new WorkspaceError(500, 'the calibration queue could not be read');
  }
}

const OPTIONAL_STR = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new WorkspaceError(400, 'draft fields must be strings or null');
  return v.trim() ? v.trim() : null;
};

export async function saveWorkspaceDraft(campaign, configHash, paths, { selector, patch = {}, expectedRevision, navigate, activeMs }) {
  const hasSelector = selector !== undefined && selector !== null;
  const hasNavigation = navigate !== undefined && navigate !== null;
  if (!hasSelector && !hasNavigation) {
    throw new WorkspaceError(400, 'a draft or navigation save requires an explicit artifact target');
  }
  if (!hasSelector && (Object.keys(patch).length || activeMs !== undefined)) {
    throw new WorkspaceError(400, 'draft fields require an artifact selector; save navigation separately');
  }
  return await withCalibrationLock(paths, () => {
    const queue = loadQueueOrThrow(campaign, configHash, paths);
    const generation = sidecarGeneration(campaign, paths);
    const sidecar = loadSidecar(paths, campaign, configHash, generation);
    const hasExpected = expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== '';
    let artifact = null;
    if (selector !== undefined && selector !== null) {
      artifact = resolveWorkspaceArtifact(queue, selector);
    }
    if (artifact && navigate !== undefined && navigate !== null) {
      throw new WorkspaceError(400, 'save a draft and navigate in separate requests so each can carry its own revision');
    }
    let changed = false;

    if (artifact) {
      // A committed label is authoritative and immutable; the draft is inert scratch.
      if (artifact.humanLabel) throw new WorkspaceError(409, 'this artifact already has a committed label; drafts are read-only for it');
      const prior = sidecar.drafts[artifact.id] ?? normalizeDraftEntry({});
      // The {artifact, revision} binding is mandatory on EVERY draft write — a
      // first write included. An omitted or stale revision must not silently win
      // the race against a draft another tab already advanced (or created).
      if (!hasExpected || Number(expectedRevision) !== prior.revision) {
        throw new WorkspaceError(409, 'this draft changed in another tab; reload before editing');
      }

      const next = { ...prior };
      if (Object.hasOwn(patch, 'verdict')) next.verdict = patch.verdict == null ? null : (VERDICTS.has(patch.verdict) ? patch.verdict : throwBad('verdict must be APPROVED or REVISE'));
      if (Object.hasOwn(patch, 'findingPresence')) next.findingPresence = patch.findingPresence == null ? null : (FINDING_PRESENCE.has(patch.findingPresence) ? patch.findingPresence : throwBad('findingPresence must be clean or findings'));
      if (Object.hasOwn(patch, 'authority')) next.authority = patch.authority == null ? null : (AUTHORITIES.has(patch.authority) ? patch.authority : throwBad('authority must be human or expert_ai_proxy'));
      if (Object.hasOwn(patch, 'owner')) next.owner = OPTIONAL_STR(patch.owner);
      if (Object.hasOwn(patch, 'delegatedBy')) next.delegatedBy = OPTIONAL_STR(patch.delegatedBy);
      if (activeMs !== undefined) {
        const ms = Number(activeMs);
        if (!Number.isFinite(ms) || ms < 0) throw new WorkspaceError(400, 'activeMs must be a non-negative number');
        if (ms > MAX_ACTIVE_MS) throw new WorkspaceError(400, 'activeMs is implausibly large for a single label');
        next.activeMs = Math.floor(ms);
      }
      next.revision = prior.revision + 1;
      next.updatedAt = new Date().toISOString();
      sidecar.drafts[artifact.id] = next;
      changed = true;
    }

    if (navigate !== undefined && navigate !== null) {
      const target = resolveWorkspaceArtifact(queue, navigate);
      // Persisted navigation binds to the whole-sidecar revision so a stale tab
      // cannot silently roll navigation backward. Combined draft+navigate writes
      // are refused above because their per-artifact and sidecar revisions differ.
      if (!hasExpected || String(expectedRevision) !== String(sidecar.revision)) {
        throw new WorkspaceError(409, 'the workspace navigation changed in another tab; reload before editing');
      }
      sidecar.navigation.currentArtifactId = target.id;
      changed = true;
    }

    // Only a real mutation advances the sidecar revision and touches disk; an
    // empty request must not bump the counter (which would invalidate every open
    // tab's binding) or leave a footprint.
    if (changed) {
      sidecar.revision += 1;
      saveSidecar(paths, sidecar);
    }
    return { sidecar, artifact, queue };
  });
}

function throwBad(message) { throw new WorkspaceError(400, message); }

// ---------------------------------------------------------------------------
// Explicit, immutable label commit — the ONLY path that writes a canonical
// label. Reuses labelCalibrationArtifact + persistCalibrationQueue (the single
// scoring/label authority). Idempotent on an identical semantic retry; refuses a
// different label; frozen after judges run; stale writes rejected.
// ---------------------------------------------------------------------------

export async function commitCalibrationLabel(campaign, configHash, paths, {
  selector, authority, owner, delegatedBy, verdict, findingPresence,
  expectedRevision, expectedDraftRevision,
  requireExpectedRevision = false, requireExpectedDraftRevision = false,
}) {
  if (!AUTHORITIES.has(authority)) throw new WorkspaceError(400, 'authority must be human or expert_ai_proxy');
  if (typeof owner !== 'string' || !owner.trim()) throw new WorkspaceError(400, 'a label needs an explicit owner; there is no default');
  if (authority === 'expert_ai_proxy' && (typeof delegatedBy !== 'string' || !delegatedBy.trim())) {
    throw new WorkspaceError(400, 'an expert AI proxy label needs an explicit human delegator');
  }

  return await withCalibrationLock(paths, () => {
    const queue = loadQueueOrThrow(campaign, configHash, paths);
    const artifact = resolveWorkspaceArtifact(queue, selector);

    // Applying a NEW label: reject a stale client and a frozen generation. A
    // browser write MUST carry a matching revision (requireExpectedRevision); a
    // trusted terminal (CLI/library) already re-read fresh under this lock and may
    // omit it.
    const currentRevision = queueRevision(queue);
    const hasExpected = expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== '';
    if (!artifact.humanLabel && requireExpectedRevision && !hasExpected) {
      throw new WorkspaceError(409, 'the workspace changed since you loaded it; reload before committing');
    }
    if (!artifact.humanLabel && hasExpected && String(expectedRevision) !== currentRevision) {
      throw new WorkspaceError(409, 'the workspace changed since you loaded it; reload before committing');
    }
    // Validate existing scratch before committing immutable evidence. Otherwise
    // a corrupt sidecar would produce an error only AFTER the label was written.
    const sidecar = loadSidecar(paths, campaign, configHash, sidecarGeneration(campaign, paths));
    // New browser commits bind the artifact draft too, including the explicit
    // revision-0 absence. Otherwise tab A can erase tab B's newer scratch while
    // both still have the same queue revision. Exact canonical retries below are
    // deliberately exempt: they only complete durable cleanup for the same label.
    const currentDraftRevision = sidecar.drafts[artifact.id]?.revision ?? 0;
    const hasExpectedDraft = expectedDraftRevision !== undefined && expectedDraftRevision !== null && expectedDraftRevision !== '';
    if (!artifact.humanLabel && requireExpectedDraftRevision && (!hasExpectedDraft
      || !Number.isSafeInteger(Number(expectedDraftRevision))
      || Number(expectedDraftRevision) !== currentDraftRevision)) {
      throw new WorkspaceError(409, 'this draft changed in another tab; reload before committing');
    }
    let result;
    try {
      // Canonical authority owns validation, normalization, immutability, exact
      // retry and freeze. The workspace supplies only HTTP binding and storage.
      result = labelCalibrationArtifact(queue, artifact.id, {
        verdict,
        findingPresence,
        human: authority === 'human' ? owner : null,
        proxy: authority === 'expert_ai_proxy' ? owner : null,
        delegatedBy: authority === 'expert_ai_proxy' ? delegatedBy : null,
      });
    } catch (error) {
      if (/frozen/.test(error.message)) throw new WorkspaceError(409, 'labels are frozen for this generation; judges have already run');
      if (/different immutable/.test(error.message)) throw new WorkspaceError(409, 'this artifact already has a different committed label; existing labels are immutable');
      if (/must identify a person/.test(error.message)) throw new WorkspaceError(400, 'the human owner must be a person, not an AI, agent, model, or Camus');
      if (/REVISE/.test(error.message)) throw new WorkspaceError(400, 'a REVISE label must record findings');
      if (/exactly one|non-empty string/.test(error.message)) throw new WorkspaceError(400, 'a label needs exactly one explicit owner');
      throw new WorkspaceError(400, 'the label was rejected by the calibration validators');
    }
    if (!result.idempotent) persistCalibrationQueue(queue, campaign, configHash, paths);

    // Sidecar bookkeeping: retire this artifact's draft and record a timing
    // sample so ETA becomes available once real work has been measured. Bind to
    // the PATHS' generation (the CLI --generation flag, or the active generation)
    // so a `--label --generation X` commit retires X's draft, not the env default.
    // ALSO finish cleanup on exact retries: if the queue write succeeded but the
    // sidecar write failed, the retained draft is a recoverable pending cleanup.
    // Atomic sidecar replacement removes that draft and adds its sample together,
    // so a repeated retry cannot count the timing sample twice.
    const draft = sidecar.drafts[artifact.id];
    if (draft) {
      if (draft.activeMs > 0) sidecar.timingSamples = [...sidecar.timingSamples, draft.activeMs].slice(-MAX_TIMING_SAMPLES);
      delete sidecar.drafts[artifact.id];
      sidecar.revision += 1;
      saveSidecar(paths, sidecar);
    }
    return { queue, artifact, revision: queueRevision(queue), idempotent: result.idempotent };
  });
}
