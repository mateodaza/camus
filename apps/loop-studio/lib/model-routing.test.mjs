import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { classifyTaskClass, deriveAutomaticRoute } from './model-routing.mjs';

const campaignHash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;

const campaign = {
  id: 'campaign-v1',
  controls: { routingMode: 'opt_in', minimumRoutingTrialsPerArm: 10 },
  calibration: { minimumHumanLabeledArtifacts: 12 },
  profiles: [{ id: 'simple', cases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
  candidates: [
    { id: 'fast', provider: 'xai', backend: 'xai', model: 'grok', evidenceEligibility: 'promotion_eligible' },
    { id: 'slow', provider: 'anthropic', backend: 'claude', model: 'opus', evidenceEligibility: 'promotion_eligible' },
  ],
  independence: { judgeScreens: [{
    id: 'sol', reviewer: { backend: 'codex', model: 'sol', effort: 'high' },
    eligibleMakerProviders: ['xai', 'anthropic'],
  }] },
};
const catalog = {
  maker: [
    { backend: 'xai', model: 'grok', admission: { qualified: true, fingerprint: `qual1:${'a'.repeat(64)}`, seatType: 'words_maker' } },
    { backend: 'claude', model: 'opus', admission: { qualified: true, fingerprint: `builtin1:${'b'.repeat(64)}`, seatType: 'words_maker' } },
  ],
  reviewer: [{ backend: 'codex', model: 'sol', admission: { qualified: true, fingerprint: `builtin1:${'c'.repeat(64)}`, seatType: 'words_reviewer' } }],
};
const group = (candidate, wall, standing = 'routing_eligible') => {
  const provider = candidate === 'fast' ? 'xai' : 'anthropic';
  const model = candidate === 'fast' ? 'grok' : 'opus';
  return ({
  profile: 'simple', candidate, screen: 'sol', recommendationStanding: standing,
  trials: 10, distinctCases: ['a', 'b', 'c'], qualityFloorPasses: 10,
  judgeCalibration: 'calibrated', identityStable: true,
  medianWallDurationMs: wall, medianTotalObservedTokens: 100,
  runs: Array.from({ length: 10 }, (_, index) => ({
    runId: `${candidate}-run-${index + 1}`, caseId: ['a', 'b', 'c'][index % 3],
    floorPass: true, makerActuals: [`${provider}:${model}`], reviewerActuals: ['openai:sol'],
  })),
  });
};
const summary = {
  campaignId: campaign.id, evaluationConfigHash: campaignHash(campaign),
  groups: [group('slow', 200), group('fast', 100)],
};
const calibrationSummary = {
  campaignId: campaign.id,
  crossScreenRanking: 'eligible',
  calibrationDigest: `sha256:${'a'.repeat(64)}`,
  screenEvidenceDigest: `sha256:${'b'.repeat(64)}`,
  sharedArtifacts: 12,
  sharedArtifactIds: Array.from({ length: 12 }, (_, index) => `sha256:${String(index).padStart(64, '0')}`),
  screenJudgeIds: ['judge-a', 'judge-b'],
  screenActualIdentities: ['openai:sol', 'anthropic:opus'],
  screenJudgeRunIds: Array.from({ length: 24 }, (_, index) => `judge-run-${index + 1}`),
};

assert.deepEqual(classifyTaskClass({ depth: 'quick' }), { taskClass: 'simple', source: 'depth_policy' });
assert.deepEqual(classifyTaskClass({ depth: 'deep' }), { taskClass: 'difficult', source: 'depth_policy' });
assert.deepEqual(classifyTaskClass({ lane: 'build' }), { taskClass: null, source: 'build_gate_fixed' });
assert.deepEqual(classifyTaskClass({ taskClass: 'balanced', depth: 'quick' }), { taskClass: 'balanced', source: 'explicit' });

const route = deriveAutomaticRoute({ campaign, summary, calibrationSummary, catalog, taskClass: 'simple' });
assert.equal(route.routed, true);
assert.deepEqual(route.maker, { backend: 'xai', model: 'grok' });
assert.match(route.routeId, /^route1:[a-f0-9]{64}$/);
assert.equal(route.evidence.trials, 10);
assert.equal(route.evidence.runIds.length, 10);
assert.equal(route.evidence.calibration.runIds.length, 24);
assert.equal(route.evidence.makerAdmission.fingerprint, `qual1:${'a'.repeat(64)}`);

assert.equal(deriveAutomaticRoute({
  campaign, summary: { ...summary, evaluationConfigHash: 'sha256:stale' },
  calibrationSummary, catalog, taskClass: 'simple',
}).reason, 'evidence_generation_mismatch');
assert.equal(deriveAutomaticRoute({
  campaign, summary, calibrationSummary: { ...calibrationSummary, campaignId: 'other' },
  catalog, taskClass: 'simple',
}).reason, 'evidence_generation_mismatch');

assert.equal(deriveAutomaticRoute({
  campaign, summary,
  calibrationSummary: { campaignId: campaign.id, crossScreenRanking: 'refused_uncalibrated' },
  catalog, taskClass: 'simple',
}).reason, 'human_calibration_incomplete');
assert.equal(deriveAutomaticRoute({
  campaign, summary, calibrationSummary: { ...calibrationSummary, calibrationDigest: null },
  catalog, taskClass: 'simple',
}).reason, 'human_calibration_incomplete');
assert.equal(deriveAutomaticRoute({
  campaign, summary: { ...summary, groups: [group('fast', 100, 'quality_floor_not_met')] },
  calibrationSummary, catalog, taskClass: 'simple',
}).reason, 'no_admitted_evidence_eligible_pairing');
assert.equal(deriveAutomaticRoute({
  campaign, summary, calibrationSummary,
  catalog: { ...catalog, maker: catalog.maker.filter((entry) => entry.backend !== 'xai') },
  taskClass: 'simple',
}).maker.model, 'opus');

const wrongSeatCatalog = structuredClone(catalog);
wrongSeatCatalog.maker[0].admission.seatType = 'words_reviewer';
assert.equal(deriveAutomaticRoute({
  campaign, summary: { ...summary, groups: [group('fast', 100)] }, calibrationSummary,
  catalog: wrongSeatCatalog, taskClass: 'simple',
}).reason, 'no_admitted_evidence_eligible_pairing');

const substituted = group('fast', 100);
substituted.runs = substituted.runs.map((run) => ({ ...run, makerActuals: ['xai:substituted'] }));
assert.equal(deriveAutomaticRoute({
  campaign, summary: { ...summary, groups: [substituted] }, calibrationSummary,
  catalog, taskClass: 'simple',
}).reason, 'no_admitted_evidence_eligible_pairing');

const rotatedCatalog = structuredClone(catalog);
rotatedCatalog.maker[0].admission.fingerprint = `qual1:${'d'.repeat(64)}`;
assert.notEqual(deriveAutomaticRoute({
  campaign, summary, calibrationSummary, catalog: rotatedCatalog, taskClass: 'simple',
}).routeId, route.routeId);

console.log('model-routing: opt-in classification, calibration, admission, and evidence gates passed');
