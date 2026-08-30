// Read-only, provider-free summary for the deliberately bounded v1b isolation
// pair. This module describes one exact same-case pair; it has no authority to
// rank models, infer task-class coverage, mutate routing, or admit a seat.

import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  codeEvalPairCampaignIdentity,
  codeEvalPairExecutionIdentity,
  validateCodeEvalPairCampaign,
  validateCodeEvalPairExecution,
  validateCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';
import { scheduleCodeEvalPairCells } from './code-eval-pair-scheduler.mjs';
import {
  codeEvalPairEvidencePaths,
  readCodeEvalPairReceiptsSnapshot,
} from './code-eval-pair-ledger.mjs';

const ARM_IDS = Object.freeze(['raw', 'native']);
const MAX_CAMPAIGN_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const DIFFERENCE_FIELDS = Object.freeze([
  'providerCalls', 'makerCalls', 'reviewerCalls',
  'makerInputTokens', 'makerCachedInputTokens', 'makerOutputTokens',
  'reviewerInputTokens', 'reviewerCachedInputTokens', 'reviewerOutputTokens',
  'wallMs', 'makerMs', 'verifierMs', 'reviewerMs', 'orchestrationMs',
  'repairs', 'retries', 'incompleteSessions',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadSummaryJson(path, maximum, label, { privateFile = false } = {}) {
  const info = await lstat(path);
  const mode = info.mode & 0o777;
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error(`${label} must be a bounded regular non-symlink file.`);
  }
  if (privateFile && ((mode & 0o400) === 0 || (mode & 0o077) !== 0)) {
    throw new Error(`${label} must be owner-readable and private.`);
  }
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error(`${label} exceeds its private storage limit.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} must contain valid JSON; private contents were omitted.`); }
}

async function loadReadOnlySummaryContext({ campaignPath, statePath, ledgerPath }) {
  const state = resolve(statePath), ledger = resolve(ledgerPath);
  if (basename(state) !== 'state.json' || basename(ledger) !== 'receipts.jsonl'
      || dirname(state) !== dirname(ledger)) {
    throw new Error('State and ledger must be sibling state.json and receipts.jsonl files in one dedicated private directory.');
  }
  const campaign = validateCodeEvalPairCampaign(await loadSummaryJson(
    resolve(campaignPath), MAX_CAMPAIGN_BYTES, 'Pair campaign',
  ));
  const execution = validateCodeEvalPairExecution(await loadSummaryJson(
    state, MAX_STATE_BYTES, 'Pair execution state', { privateFile: true },
  ), campaign);
  return { campaign, execution, evidencePaths: codeEvalPairEvidencePaths(dirname(state)) };
}

function validateCompleteInput(campaign, execution, receipts) {
  validateCodeEvalPairExecution(execution, campaign);
  if (!Array.isArray(receipts) || receipts.length > 2) {
    throw new Error('Pair summary receipts must be the bounded zero-to-two row ledger.');
  }
  const cells = scheduleCodeEvalPairCells(campaign, execution);
  const byCellId = new Map(cells.map(cell => [
    cell.armId,
    cell,
  ]));
  const byArm = new Map();
  for (const receipt of receipts) {
    const armId = receipt?.assignment?.armId;
    const cell = byCellId.get(armId);
    if (!cell) throw new Error('Pair summary receipt is outside the frozen raw/native roster.');
    validateCodeEvalPairReceipt(receipt, campaign, execution, cell);
    if (byArm.has(armId)) throw new Error(`Pair summary contains duplicate ${armId} evidence.`);
    byArm.set(armId, receipt);
  }
  return { cells, byArm };
}

function isolationStable(receipt) {
  if (!receipt) return null;
  const identity = receipt.observedIdentity;
  return identity.identityStable === true
    && identity.qualificationBindingsMatch === true
    && identity.connectionBindingsMatch === true
    && identity.policyBindingMatch === true
    && identity.substitutionDetected === false
    && identity.helperModelDetected === false
    && identity.fallbackDetected === false;
}

function armSummary(campaign, armId, receipt) {
  const executor = campaign.pair.arms.find(arm => arm.armId === armId).makerExecutor;
  if (!receipt) return {
    armId,
    executor,
    attempted: false,
    receiptId: null,
    cellStanding: null,
    outcome: null,
    identityStable: null,
    quality: {
      mechanicalFloorPassed: null,
      screenFloorPassed: null,
      reviewVerdict: null,
      materialFindingCount: null,
      reviewScreenStanding: null,
    },
    economics: null,
  };
  return {
    armId,
    executor,
    attempted: true,
    receiptId: receipt.receiptId,
    cellStanding: receipt.standing,
    outcome: receipt.outcome.status,
    identityStable: isolationStable(receipt),
    quality: {
      mechanicalFloorPassed: receipt.quality.mechanicalFloorPassed,
      screenFloorPassed: receipt.quality.screenFloorPassed,
      reviewVerdict: receipt.quality.reviewVerdict,
      materialFindingCount: receipt.quality.materialFindingCount,
      reviewScreenStanding: receipt.quality.reviewScreenStanding,
    },
    economics: clone(receipt.economics),
  };
}

function measuredDifference(raw, native, field) {
  const left = raw?.economics?.[field], right = native?.economics?.[field];
  return typeof left === 'number' && Number.isFinite(left)
    && typeof right === 'number' && Number.isFinite(right)
    ? right - left : null;
}

function differences(raw, native) {
  const values = Object.fromEntries(DIFFERENCE_FIELDS.map(field => [field,
    measuredDifference(raw, native, field),
  ]));
  const sameCurrency = typeof raw?.economics?.currency === 'string'
    && raw.economics.currency === native?.economics?.currency;
  values.costUsd = sameCurrency ? measuredDifference(raw, native, 'costUsd') : null;
  return {
    direction: 'native_minus_raw',
    currency: sameCurrency ? raw.economics.currency : null,
    values,
    missingMeasurements: Object.entries(values).filter(([, value]) => value === null).map(([field]) => field),
  };
}

function standingFor(receipts, raw, native) {
  if (receipts.length === 0) return 'no_attempts';
  if (receipts.length === 1) return 'paired_coverage_incomplete';
  if (isolationStable(raw) !== true || isolationStable(native) !== true) return 'isolation_invalid';
  if (raw.quality.mechanicalFloorPassed !== true || native.quality.mechanicalFloorPassed !== true) {
    return 'mechanical_floor_not_met';
  }
  return 'paired_observation';
}

export function createCodeEvalPairSummary({ campaign, execution, receipts }) {
  const { byArm } = validateCompleteInput(campaign, execution, receipts);
  const raw = byArm.get('raw') ?? null;
  const native = byArm.get('native') ?? null;
  const standing = standingFor(receipts, raw, native);
  const mechanicalPair = raw?.quality.mechanicalFloorPassed === true
    && native?.quality.mechanicalFloorPassed === true;
  const arms = ARM_IDS.map(armId => armSummary(campaign, armId, byArm.get(armId) ?? null));
  return {
    ok: true,
    protocol: 'code-harness-eval-v1b-summary',
    campaignId: campaign.campaignId,
    campaignDigest: codeEvalPairCampaignIdentity(campaign),
    executionDigest: codeEvalPairExecutionIdentity(execution, campaign),
    pairId: campaign.pair.pairId,
    taskClass: campaign.case.taskClass,
    caseId: campaign.case.caseId,
    standing,
    coverage: {
      coverageScope: 'case_only',
      taskClassCoverage: false,
      totalCells: 2,
      attemptedCells: receipts.length,
      pendingCells: 2 - receipts.length,
      paired: receipts.length === 2,
    },
    quality: {
      isolationValid: receipts.length === 2 ? isolationStable(raw) && isolationStable(native) : null,
      bothMechanicalFloorsPassed: receipts.length === 2 ? mechanicalPair : null,
      bothScreenFloorsPassed: receipts.length === 2
        ? raw.quality.screenFloorPassed === true && native.quality.screenFloorPassed === true : null,
      reviewer: clone(campaign.pair.reviewer),
      screenEvidenceIsProvisional: true,
    },
    arms,
    economics: {
      interpretation: mechanicalPair ? 'paired_measurements_only' : 'diagnostic_only',
      comparableActionCounts: false,
      differences: receipts.length === 2 ? differences(raw, native) : null,
    },
    claims: {
      pairedObservation: standing === 'paired_observation',
      winner: 'forbidden',
      efficiency: 'forbidden',
      routing: 'forbidden',
      admission: 'forbidden',
      productionReadiness: 'forbidden',
    },
    providerCallsMade: 0,
    providerCallsMadeThisInvocation: 0,
  };
}

export async function summarizeCodeEvalPair(paths, dependencies = {}) {
  const context = await (dependencies.loadContext ?? loadReadOnlySummaryContext)(paths, dependencies);
  const receipts = await (dependencies.loadReceipts ?? readCodeEvalPairReceiptsSnapshot)(
    context.evidencePaths,
    { campaign: context.campaign, execution: context.execution },
  );
  return createCodeEvalPairSummary({
    campaign: context.campaign,
    execution: context.execution,
    receipts,
  });
}
