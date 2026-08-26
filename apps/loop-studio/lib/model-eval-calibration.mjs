// Local, blinded judge-calibration workflow. The tracked calibration JSON is
// only an empty public seed; human labels, artifact text, and judge receipts
// stay in private operator state under ~/.camus/studio (or the explicit test
// overrides). A judge cannot run until every selected artifact has a human
// label, and labels freeze once the first judge result exists.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { calibrationLabelAuthority, judgeCalibrationPaths, validateJudgeCalibration } from './judge-calibration.mjs';
import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const VERDICTS = new Set(['APPROVED', 'REVISE']);
const FINDING_PRESENCE = new Set(['clean', 'findings']);

const hashText = (value) => `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
const canonicalIso = (value) => {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
};

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requestedSeat(report, role) {
  const seat = report?.models?.[role];
  return seat?.backend && seat?.model ? `${seat.backend}:${seat.model}` : null;
}

function registeredCase(campaign, report) {
  const profile = campaign.profiles.find((entry) => entry.id === report?.evaluationProfile);
  const evaluationCase = profile?.cases.find((entry) => entry.id === report?.evaluationCaseId);
  return profile && evaluationCase ? { profile, evaluationCase } : null;
}

function eligibleArtifact(campaign, configHash, report) {
  if (!report || report.simulated === true || report.evaluationCampaignId !== campaign.id
      || report.evaluationConfigHash !== configHash || (report.answers ?? []).length) return null;
  const treatment = registeredCase(campaign, report);
  const makerKey = requestedSeat(report, 'maker');
  const candidate = campaign.candidates.find((entry) => `${entry.backend}:${entry.model}` === makerKey);
  const deliverable = typeof report.deliverable === 'string' ? report.deliverable : null;
  const deliverableHash = report.evidencePack?.artifact?.deliverable_hash;
  const sourceEvidenceArtifactId = report.evidencePack?.artifact_id;
  if (!treatment || !candidate || !deliverable?.trim() || !HASH.test(deliverableHash ?? '')
      || !HASH.test(sourceEvidenceArtifactId ?? '') || hashText(deliverable) !== deliverableHash
      || report.evidencePack?.artifact?.kind !== 'research') return null;
  const claims = (report.evidencePack.artifact.claims ?? []).map(({ decision, ...claim }) => claim);
  const criteria = (report.evidencePack.artifact.contract_coverage ?? []).map(({ decision, ...criterion }) => criterion);
  return {
    id: deliverableHash,
    sourceRunId: required(report.id, 'report.id'),
    sourceEvidenceArtifactId,
    profile: treatment.profile.id,
    caseId: treatment.evaluationCase.id,
    goal: required(report.goal ?? report.evidencePack.goal, 'report.goal'),
    acceptanceContract: required(report.acceptanceContract ?? report.evidencePack.acceptance_contract, 'report.acceptanceContract'),
    lane: report.lane ?? 'freeform',
    deliverable,
    claims,
    criteria,
    groundingEvidence: report.evidence?.grounding ?? null,
    makerKey, // selection only; removed before persistence
  };
}

function pickForProfile(campaign, profileId, rows, quota) {
  const profile = campaign.profiles.find((entry) => entry.id === profileId);
  const caseOrder = new Map(profile.cases.map((entry, index) => [entry.id, index]));
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.makerKey)) groups.set(row.makerKey, []);
    groups.get(row.makerKey).push(row);
  }
  const selected = [];
  const used = new Set();
  for (const [index, makerKey] of [...groups.keys()].sort().entries()) {
    if (selected.length >= quota) break;
    const candidates = groups.get(makerKey).sort((a, b) => (
      (caseOrder.get(a.caseId) ?? 999) - (caseOrder.get(b.caseId) ?? 999) || a.sourceRunId.localeCompare(b.sourceRunId)
    ));
    const desiredCase = profile.cases[index % profile.cases.length].id;
    const chosen = candidates.find((row) => row.caseId === desiredCase) ?? candidates[0];
    if (!used.has(chosen.id)) { selected.push(chosen); used.add(chosen.id); }
  }
  if (selected.length < quota) {
    for (const row of rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.sourceRunId.localeCompare(b.sourceRunId))) {
      if (selected.length >= quota) break;
      if (!used.has(row.id)) { selected.push(row); used.add(row.id); }
    }
  }
  return selected;
}

export function selectCalibrationArtifacts(campaign, configHash, reports, count = campaign.calibration.minimumHumanLabeledArtifacts) {
  const byContent = new Map();
  for (const report of reports) {
    const row = eligibleArtifact(campaign, configHash, report);
    if (row && !byContent.has(row.id)) byContent.set(row.id, row);
  }
  const eligible = [...byContent.values()];
  if (eligible.length < count) throw new Error(`calibration needs ${count} distinct active artifacts; only ${eligible.length} are eligible`);

  const profiles = campaign.profiles.map((profile) => profile.id);
  const base = Math.floor(count / profiles.length);
  let remainder = count % profiles.length;
  const selected = [];
  const used = new Set();
  for (const profileId of profiles) {
    const quota = base + (remainder-- > 0 ? 1 : 0);
    const rows = eligible.filter((row) => row.profile === profileId);
    for (const row of pickForProfile(campaign, profileId, rows, quota)) {
      if (!used.has(row.id)) { selected.push(row); used.add(row.id); }
    }
  }
  if (selected.length < count) {
    for (const row of eligible.sort((a, b) => a.profile.localeCompare(b.profile) || a.caseId.localeCompare(b.caseId) || a.sourceRunId.localeCompare(b.sourceRunId))) {
      if (selected.length >= count) break;
      if (!used.has(row.id)) { selected.push(row); used.add(row.id); }
    }
  }
  if (selected.length < count) throw new Error(`calibration selection could cover only ${selected.length}/${count} distinct artifacts`);
  return selected.slice(0, count).map(({ makerKey, ...row }, index) => ({ ...row, ordinal: index + 1 }));
}

function humanOwner(value) {
  const raw = required(value, 'human label owner').replace(/^human:/i, '').trim();
  if (/\b(ai|agent|bot|model|claude|codex|gpt|camus)\b/i.test(raw)) {
    throw new Error('the human label owner must identify a person, not an AI, agent, model, or Camus');
  }
  return `human:${raw}`;
}

function proxyOwner(value) {
  const raw = required(value, 'expert AI proxy').replace(/^expert_ai_proxy:/i, '').trim();
  return `expert_ai_proxy:${raw}`;
}

function artifactFileName(artifact) {
  return `${String(artifact.ordinal).padStart(2, '0')}-${artifact.id.slice(7, 19)}.md`;
}

function renderArtifact(artifact) {
  return `# Calibration Artifact ${String(artifact.ordinal).padStart(2, '0')}\n\n`+
    `Read this artifact without inspecting its source run or any model verdict. Judge only the goal, acceptance contract, and deliverable.\n\n`+
    `## Goal\n\n${artifact.goal}\n\n`+
    `## Acceptance Contract\n\n${artifact.acceptanceContract}\n\n`+
    `## Deliverable\n\n${artifact.deliverable}\n`;
}

export function calibrationValueFromQueue(queue) {
  return {
    schemaVersion: 1,
    campaignId: queue.campaignId,
    standing: 'uncalibrated',
    labelPolicy: queue.labelPolicy,
    artifacts: queue.artifacts.filter((artifact) => artifact.humanLabel).map((artifact) => ({
      id: artifact.id,
      caseId: artifact.caseId,
      sourceRunId: artifact.sourceRunId,
      humanLabel: artifact.humanLabel,
    })),
    judgeRuns: queue.judgeRuns.map(({ artifactId, judgeId, sourceRunId, actualIdentity, verdict, findingPresence }) => ({
      artifactId, judgeId, sourceRunId, actualIdentity, verdict, findingPresence,
    })),
  };
}

export function validateCalibrationQueue(queue, campaign, configHash) {
  if (!queue || queue.schemaVersion !== 1) throw new Error('calibration queue schemaVersion must be 1');
  if (queue.campaignId !== campaign.id || queue.evaluationConfigHash !== configHash) throw new Error('calibration queue is stale for the active campaign generation');
  if (!canonicalIso(queue.createdAt)) throw new Error('calibration queue createdAt must be canonical ISO');
  if (!Array.isArray(queue.artifacts) || queue.artifacts.length < campaign.calibration.minimumHumanLabeledArtifacts) {
    throw new Error(`calibration queue needs at least ${campaign.calibration.minimumHumanLabeledArtifacts} artifacts`);
  }
  const ids = new Set();
  const runs = new Set();
  for (const [index, artifact] of queue.artifacts.entries()) {
    if (artifact.ordinal !== index + 1) throw new Error('calibration artifact ordinals must be consecutive');
    if (!HASH.test(artifact.id ?? '') || hashText(artifact.deliverable) !== artifact.id) throw new Error(`calibration artifact ${artifact.ordinal} content hash is invalid`);
    if (!HASH.test(artifact.sourceEvidenceArtifactId ?? '')) throw new Error(`calibration artifact ${artifact.ordinal} source evidence id is invalid`);
    required(artifact.sourceRunId, `artifacts[${index}].sourceRunId`);
    if (ids.has(artifact.id) || runs.has(artifact.sourceRunId)) throw new Error('calibration artifacts must have unique content and source runs');
    ids.add(artifact.id); runs.add(artifact.sourceRunId);
    registeredCase(campaign, { evaluationProfile: artifact.profile, evaluationCaseId: artifact.caseId })
      ?? (() => { throw new Error(`calibration artifact ${artifact.ordinal} case is not registered`); })();
    required(artifact.artifactFile, `artifacts[${index}].artifactFile`);
    for (const forbidden of ['maker', 'reviewer', 'models', 'priorVerdict']) {
      if (Object.prototype.hasOwnProperty.call(artifact, forbidden)) throw new Error(`calibration artifacts must stay blinded; ${forbidden} is forbidden`);
    }
    if (artifact.humanLabel) {
      if (!VERDICTS.has(artifact.humanLabel.verdict) || !FINDING_PRESENCE.has(artifact.humanLabel.findingPresence)) throw new Error(`artifacts[${index}].humanLabel is invalid`);
      if (artifact.humanLabel.verdict === 'REVISE' && artifact.humanLabel.findingPresence !== 'findings') throw new Error(`artifacts[${index}] cannot revise without findings`);
      const authority = calibrationLabelAuthority(artifact.humanLabel);
      if (authority === 'human' && !artifact.humanLabel.labeledBy?.startsWith('human:')) throw new Error(`artifacts[${index}].humanLabel needs a human owner`);
      if (authority === 'expert_ai_proxy' && (!artifact.humanLabel.labeledBy?.startsWith('expert_ai_proxy:') || !artifact.humanLabel.delegatedBy?.startsWith('human:'))) {
        throw new Error(`artifacts[${index}].humanLabel needs an honest proxy owner and human delegator`);
      }
      if (!['human', 'expert_ai_proxy'].includes(authority) || !canonicalIso(artifact.humanLabel.labeledAt)) throw new Error(`artifacts[${index}].humanLabel authority or time is invalid`);
    }
  }
  if (!Array.isArray(queue.judgeRuns) || !Array.isArray(queue.attempts)) throw new Error('calibration queue judgeRuns and attempts must be arrays');
  const judgeIds = new Set(campaign.calibration.judges.map((judge) => judge.id));
  const runKeys = new Set();
  for (const run of queue.judgeRuns) {
    const key = `${run.artifactId}\u0000${run.judgeId}`;
    if (!ids.has(run.artifactId) || !judgeIds.has(run.judgeId) || runKeys.has(key)) throw new Error('calibration judge run binding is invalid or duplicated');
    runKeys.add(key);
    if (!VERDICTS.has(run.verdict) || !FINDING_PRESENCE.has(run.findingPresence) || !required(run.actualIdentity, 'judge actual identity')) throw new Error('calibration judge run result is invalid');
    if (run.verdict === 'REVISE' && run.findingPresence !== 'findings') throw new Error('calibration judge cannot revise without findings');
    required(run.sourceRunId, 'judge sourceRunId');
    if (!canonicalIso(run.recordedAt)) throw new Error('calibration judge run recordedAt must be canonical ISO');
  }
  for (const attempt of queue.attempts) {
    if (!ids.has(attempt.artifactId) || !judgeIds.has(attempt.judgeId) || attempt.status !== 'infra_failed') throw new Error('calibration judge attempt binding is invalid');
    required(attempt.sourceRunId, 'judge attempt sourceRunId');
    required(attempt.error, 'judge attempt error');
    if (!canonicalIso(attempt.recordedAt)) throw new Error('calibration judge attempt recordedAt must be canonical ISO');
  }
  validateJudgeCalibration(calibrationValueFromQueue(queue), campaign);
  return queue;
}

export function persistCalibrationQueue(queue, campaign, configHash, paths = judgeCalibrationPaths()) {
  validateCalibrationQueue(queue, campaign, configHash);
  mkdirSync(paths.artifactsDir, { recursive: true, mode: STUDIO_DIR_MODE });
  chmodSync(paths.artifactsDir, STUDIO_DIR_MODE);
  for (const artifact of queue.artifacts) {
    studioAtomicWrite(join(paths.artifactsDir, artifact.artifactFile), renderArtifact(artifact), STUDIO_FILE_MODE);
  }
  studioAtomicWrite(paths.value, `${JSON.stringify(calibrationValueFromQueue(queue), null, 2)}\n`, STUDIO_FILE_MODE);
  studioAtomicWrite(paths.queue, `${JSON.stringify(queue, null, 2)}\n`, STUDIO_FILE_MODE);
  return queue;
}

export function prepareCalibrationQueue(campaign, configHash, reports, { paths = judgeCalibrationPaths(), createdAt = new Date().toISOString() } = {}) {
  if (existsSync(paths.queue)) return { queue: loadCalibrationQueue(campaign, configHash, paths), created: false, paths };
  if (existsSync(paths.value)) throw new Error(`local calibration value exists without its queue at ${paths.value}; restore or move it before preparing a new queue`);
  const artifacts = selectCalibrationArtifacts(campaign, configHash, reports).map((artifact) => ({
    ...artifact,
    artifactFile: artifactFileName(artifact),
    humanLabel: null,
  }));
  const queue = {
    schemaVersion: 1,
    campaignId: campaign.id,
    evaluationConfigHash: configHash,
    standing: 'collecting_human_labels',
    createdAt,
    labelPolicy: {
      verdicts: ['APPROVED', 'REVISE'],
      findingPresence: ['clean', 'findings'],
      rule: 'A human labels the blinded artifact before any judge runs. APPROVED may retain low caveats; REVISE requires at least one material finding. Judge output is never a human label.',
    },
    artifacts,
    judgeRuns: [],
    attempts: [],
  };
  persistCalibrationQueue(queue, campaign, configHash, paths);
  return { queue, created: true, paths };
}

export function loadCalibrationQueue(campaign, configHash, paths = judgeCalibrationPaths()) {
  let queue;
  try { queue = JSON.parse(readFileSync(paths.queue, 'utf8')); }
  catch (error) { throw new Error(`cannot read calibration queue: ${error.message}`); }
  return validateCalibrationQueue(queue, campaign, configHash);
}

export function resolveCalibrationArtifact(queue, selector) {
  const raw = required(String(selector), 'artifact selector');
  const ordinal = /^\d+$/.test(raw) ? Number(raw) : null;
  const matches = queue.artifacts.filter((artifact) => artifact.ordinal === ordinal
    || artifact.id === raw || artifact.id.startsWith(raw) || artifact.sourceRunId === raw);
  if (matches.length !== 1) throw new Error(matches.length ? 'artifact selector is ambiguous' : `unknown calibration artifact ${raw}`);
  return matches[0];
}

export function labelCalibrationArtifact(queue, selector, { verdict, findingPresence, human = null, proxy = null, delegatedBy = null, labeledAt = new Date().toISOString() }) {
  if (queue.judgeRuns.length) throw new Error('human labels are frozen after the first judge run');
  const artifact = resolveCalibrationArtifact(queue, selector);
  const normalizedVerdict = String(verdict ?? '').toUpperCase();
  const normalizedPresence = String(findingPresence ?? '').toLowerCase();
  if (!VERDICTS.has(normalizedVerdict) || !FINDING_PRESENCE.has(normalizedPresence)) throw new Error('label needs verdict APPROVED|REVISE and findingPresence clean|findings');
  if (normalizedVerdict === 'REVISE' && normalizedPresence !== 'findings') throw new Error('a REVISE human label must record findingPresence findings');
  if (Boolean(human) === Boolean(proxy)) throw new Error('label needs exactly one human owner or expert AI proxy');
  const next = human
    ? { authority: 'human', verdict: normalizedVerdict, findingPresence: normalizedPresence, labeledBy: humanOwner(human), labeledAt }
    : {
      authority: 'expert_ai_proxy',
      verdict: normalizedVerdict,
      findingPresence: normalizedPresence,
      labeledBy: proxyOwner(proxy),
      delegatedBy: humanOwner(delegatedBy),
      labeledAt,
    };
  if (artifact.humanLabel) {
    const same = artifact.humanLabel.verdict === next.verdict && artifact.humanLabel.findingPresence === next.findingPresence && artifact.humanLabel.labeledBy === next.labeledBy;
    if (same) return queue;
    throw new Error('this artifact already has a different immutable human label');
  }
  artifact.humanLabel = next;
  return queue;
}

export function recordCalibrationJudgeRun(queue, campaign, selector, judgeId, result, { sourceRunId, recordedAt = new Date().toISOString() }) {
  if (queue.artifacts.some((artifact) => !artifact.humanLabel)) throw new Error('every artifact needs a human label before any judge runs');
  const artifact = resolveCalibrationArtifact(queue, selector);
  if (!campaign.calibration.judges.some((judge) => judge.id === judgeId)) throw new Error(`unknown calibration judge ${judgeId}`);
  const existing = queue.judgeRuns.find((run) => run.artifactId === artifact.id && run.judgeId === judgeId);
  if (existing) return queue;
  if (!result?.ran || !VERDICTS.has(result.verdict) || !required(result.reviewerIdentity, 'judge actual identity')) throw new Error('only a completed normalized judge result can enter calibration');
  const findingPresence = (result.findings ?? []).length ? 'findings' : 'clean';
  if (result.verdict === 'REVISE' && findingPresence !== 'findings') throw new Error('a revising judge result must contain findings');
  queue.judgeRuns.push({
    artifactId: artifact.id,
    judgeId,
    sourceRunId: required(sourceRunId, 'judge sourceRunId'),
    actualIdentity: result.reviewerIdentity,
    verdict: result.verdict,
    findingPresence,
    findingCount: (result.findings ?? []).length,
    usage: result.usage ?? null,
    durationMs: result.durationMs ?? null,
    recordedAt,
  });
  return queue;
}

export function recordCalibrationJudgeFailure(queue, selector, judgeId, error, { sourceRunId, recordedAt = new Date().toISOString() }) {
  const artifact = resolveCalibrationArtifact(queue, selector);
  queue.attempts.push({ artifactId: artifact.id, judgeId, sourceRunId, status: 'infra_failed', error: String(error).slice(0, 500), recordedAt });
  return queue;
}

export function calibrationQueueSummary(queue, campaign) {
  const labels = queue.artifacts.filter((artifact) => artifact.humanLabel).length;
  const humanLabels = queue.artifacts.filter((artifact) => calibrationLabelAuthority(artifact.humanLabel) === 'human').length;
  const proxyLabels = queue.artifacts.filter((artifact) => calibrationLabelAuthority(artifact.humanLabel) === 'expert_ai_proxy').length;
  const judges = campaign.calibration.judges.map((judge) => ({
    id: judge.id,
    seat: `${judge.backend}:${judge.model}`,
    completed: queue.judgeRuns.filter((run) => run.judgeId === judge.id).length,
    remaining: queue.artifacts.length - queue.judgeRuns.filter((run) => run.judgeId === judge.id).length,
  }));
  return {
    campaignId: queue.campaignId,
    evaluationConfigHash: queue.evaluationConfigHash,
    queuePath: basename(judgeCalibrationPaths().queue),
    artifacts: queue.artifacts.length,
    labels,
    humanLabels,
    proxyLabels,
    pendingHumanLabels: queue.artifacts.length - labels,
    labelsFrozen: queue.judgeRuns.length > 0,
    judgeRuns: queue.judgeRuns.length,
    infraFailures: queue.attempts.filter((attempt) => attempt.status === 'infra_failed').length,
    judges,
  };
}
