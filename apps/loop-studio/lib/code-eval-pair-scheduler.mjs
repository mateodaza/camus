// Stable two-cell scheduler for the bounded Code Harness Eval v1b pair.

import { createHash } from 'node:crypto';
import {
  CODE_EVAL_PAIR_SCHEDULER_VERSION,
  codeEvalPairCampaignIdentity,
  codeEvalPairCellIdentity,
  codeEvalPairExecutionIdentity,
  codeEvalPairIdPatterns,
  createCodeEvalPairCells,
  validateCodeEvalPairCampaign,
  validateCodeEvalPairExecution,
  validateCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';

export { CODE_EVAL_PAIR_SCHEDULER_VERSION };

export function codeEvalPairScheduleParityBit({
  campaignDigest,
  executionDigest,
  pairId,
  caseId,
  repeat,
}) {
  if (!codeEvalPairIdPatterns.campaign.test(campaignDigest ?? '')) throw new Error('scheduler campaignDigest is invalid');
  if (!codeEvalPairIdPatterns.execution.test(executionDigest ?? '')) throw new Error('scheduler executionDigest is invalid');
  for (const [name, value] of [['pairId', pairId], ['caseId', caseId]]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`scheduler ${name} is invalid`);
  }
  if (repeat !== 1) throw new Error('scheduler repeat must be exactly 1 in bounded v1b');
  const key = [campaignDigest, executionDigest, pairId, caseId, String(repeat)].join('\0');
  return createHash('sha256').update(key, 'utf8').digest()[0] & 1;
}

export function codeEvalPairScheduleParity(campaign, execution) {
  validateCodeEvalPairCampaign(campaign);
  validateCodeEvalPairExecution(execution, campaign);
  return codeEvalPairScheduleParityBit({
    campaignDigest: codeEvalPairCampaignIdentity(campaign),
    executionDigest: codeEvalPairExecutionIdentity(execution, campaign),
    pairId: campaign.pair.pairId,
    caseId: campaign.case.caseId,
    repeat: 1,
  });
}

export function scheduleCodeEvalPairCells(campaign, execution) {
  const cells = createCodeEvalPairCells(campaign, execution);
  return codeEvalPairScheduleParity(campaign, execution) === 0 ? cells : [cells[1], cells[0]];
}

export function nextCodeEvalPairCell(campaign, execution, receipts = []) {
  if (!Array.isArray(receipts)) throw new Error('scheduler receipts must be an array');
  const cells = scheduleCodeEvalPairCells(campaign, execution);
  const byId = new Map(cells.map(cell => [codeEvalPairCellIdentity(cell, campaign, execution), cell]));
  const seen = new Set();
  for (const receipt of receipts) {
    const cell = byId.get(receipt?.cellId);
    if (!cell) throw new Error('scheduler receipt does not belong to this bounded pair');
    validateCodeEvalPairReceipt(receipt, campaign, execution, cell);
    if (seen.has(receipt.cellId)) throw new Error(`scheduler duplicate receipt cell ${receipt.cellId}`);
    seen.add(receipt.cellId);
  }
  return cells.find(cell => !seen.has(codeEvalPairCellIdentity(cell, campaign, execution))) ?? null;
}

