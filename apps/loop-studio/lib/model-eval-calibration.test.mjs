import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadModelEvalCampaign, modelEvalCampaignHash } from './model-eval-campaign.mjs';
import { judgeCalibrationPaths, loadJudgeCalibration, summarizeJudgeCalibration } from './judge-calibration.mjs';
import {
  calibrationValueFromQueue,
  labelCalibrationArtifact,
  loadCalibrationQueue,
  persistCalibrationQueue,
  prepareCalibrationQueue,
  recordCalibrationJudgeRun,
  selectCalibrationArtifacts,
} from './model-eval-calibration.mjs';

const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const root = mkdtempSync(join(tmpdir(), 'camus-calibration-test-'));
const paths = {
  value: join(root, 'model-eval-judge-calibration.json'),
  queue: join(root, 'model-eval-calibration-queue.json'),
  artifactsDir: join(root, 'model-eval-calibration-artifacts'),
  receiptsDir: join(root, 'model-eval-calibration-receipts'),
};
const hash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const mode = (file) => statSync(file).mode & 0o777;

function fixtureReports() {
  const makers = campaign.candidates.slice(0, 4);
  return campaign.profiles.flatMap((profile) => makers.map((maker, makerIndex) => {
    const evaluationCase = profile.cases[makerIndex % profile.cases.length];
    const runId = `fixture-${profile.id}-${maker.id}`;
    const deliverable = `# ${profile.id} artifact ${makerIndex + 1}\n\nA deliberately anonymous calibration deliverable for ${evaluationCase.id}.`;
    return {
      id: runId,
      evaluationCampaignId: campaign.id,
      evaluationConfigHash: configHash,
      evaluationProfile: profile.id,
      evaluationCaseId: evaluationCase.id,
      simulated: false,
      answers: [],
      status: makerIndex % 2 ? 'done_with_findings' : 'verify_failed',
      goal: `Evaluate the ${profile.id} anonymous artifact.`,
      acceptanceContract: 'Return a useful artifact that satisfies the supplied goal.',
      lane: 'freeform',
      deliverable,
      models: { maker: { backend: maker.backend, model: maker.model } },
      evidence: { grounding: null },
      evidencePack: {
        goal: `Evaluate the ${profile.id} anonymous artifact.`,
        acceptance_contract: 'Return a useful artifact that satisfies the supplied goal.',
        artifact_id: hash(`evidence:${runId}`),
        artifact: {
          kind: 'research',
          deliverable_hash: hash(deliverable),
          claims: [],
          contract_coverage: [{ id: 'criterion-1', text: 'The artifact satisfies the supplied goal.', decision: 'met' }],
        },
      },
    };
  }));
}

try {
  const priorBase = process.env.STUDIO_GRANDFATHER_DIR;
  process.env.STUDIO_GRANDFATHER_DIR = root;
  const generated = judgeCalibrationPaths('human-v1');
  assert.equal(generated.generation, 'human-v1');
  assert.equal(generated.queue, join(root, 'judge-calibration', 'human-v1', 'model-eval-calibration-queue.json'));
  const active = judgeCalibrationPaths(campaign.id);
  assert.equal(active.queue, join(root, 'judge-calibration', campaign.id, 'model-eval-calibration-queue.json'));
  assert.throws(() => judgeCalibrationPaths('../escape'), /safe name characters/);
  if (priorBase === undefined) delete process.env.STUDIO_GRANDFATHER_DIR;
  else process.env.STUDIO_GRANDFATHER_DIR = priorBase;

  const reports = fixtureReports();
  const selected = selectCalibrationArtifacts(campaign, configHash, reports);
  assert.equal(selected.length, 12);
  for (const profile of campaign.profiles) {
    assert.equal(selected.filter((artifact) => artifact.profile === profile.id).length, 4, `${profile.id} contributes four artifacts`);
  }
  for (const artifact of selected) {
    for (const forbidden of ['makerKey', 'maker', 'reviewer', 'models', 'priorVerdict']) {
      assert.equal(Object.hasOwn(artifact, forbidden), false, `${forbidden} stays out of persisted artifact metadata`);
    }
  }

  const prepared = prepareCalibrationQueue(campaign, configHash, reports, {
    paths,
    createdAt: '2026-08-26T12:00:00.000Z',
  });
  assert.equal(prepared.created, true);
  assert.equal(prepareCalibrationQueue(campaign, configHash, reports, { paths }).created, false, 'preparation is idempotent');
  assert.equal(mode(paths.queue), 0o600);
  assert.equal(mode(paths.value), 0o600);
  assert.equal(mode(paths.artifactsDir), 0o700);

  const queue = loadCalibrationQueue(campaign, configHash, paths);
  for (const artifact of queue.artifacts) {
    const file = join(paths.artifactsDir, artifact.artifactFile);
    assert.equal(existsSync(file), true);
    assert.equal(mode(file), 0o600);
    const blinded = readFileSync(file, 'utf8');
    assert.doesNotMatch(blinded, /gpt-|claude-|grok-|qwen|APPROVED|REVISE/i, 'human view omits maker and prior-judge identity');
    assert.match(blinded, /## Goal[\s\S]+## Acceptance Contract[\s\S]+## Deliverable/);
  }

  assert.throws(() => recordCalibrationJudgeRun(queue, campaign, 1, 'gpt-sol', {
    ran: true, verdict: 'APPROVED', findings: [], reviewerIdentity: 'openai:gpt-5.6-sol',
  }, { sourceRunId: 'premature-judge' }), /every artifact needs a human label/);
  assert.throws(() => labelCalibrationArtifact(queue, 1, {
    verdict: 'APPROVED', findingPresence: 'clean', human: 'AI agent',
  }), /must identify a person/);
  assert.throws(() => labelCalibrationArtifact(queue, 1, {
    verdict: 'REVISE', findingPresence: 'clean', human: 'Mateo',
  }), /REVISE human label must record/);
  assert.throws(() => labelCalibrationArtifact(structuredClone(queue), 1, {
    verdict: 'APPROVED', findingPresence: 'clean', proxy: 'codex',
  }), /human label owner must be a non-empty string/);
  const proxyExample = structuredClone(queue);
  labelCalibrationArtifact(proxyExample, 1, {
    verdict: 'APPROVED', findingPresence: 'clean', proxy: 'codex', delegatedBy: 'Mateo',
    labeledAt: '2026-08-26T12:00:00.000Z',
  });
  assert.deepEqual(proxyExample.artifacts[0].humanLabel, {
    authority: 'expert_ai_proxy', verdict: 'APPROVED', findingPresence: 'clean',
    labeledBy: 'expert_ai_proxy:codex', delegatedBy: 'human:Mateo', labeledAt: '2026-08-26T12:00:00.000Z',
  });

  for (const artifact of queue.artifacts) {
    const revise = artifact.ordinal % 2 === 0;
    labelCalibrationArtifact(queue, artifact.ordinal, {
      verdict: revise ? 'REVISE' : 'APPROVED',
      findingPresence: revise ? 'findings' : 'clean',
      human: 'Mateo',
      labeledAt: `2026-08-26T12:${String(artifact.ordinal).padStart(2, '0')}:00.000Z`,
    });
  }
  persistCalibrationQueue(queue, campaign, configHash, paths);
  assert.equal(loadJudgeCalibration(campaign, paths.value).summary.humanLabeledArtifacts, 12);

  const screenSeats = new Set(campaign.independence.judgeScreens.map((screen) => `${screen.reviewer.backend}:${screen.reviewer.model}`));
  const activeJudges = campaign.calibration.judges.filter((judge) => screenSeats.has(`${judge.backend}:${judge.model}`));
  for (const judge of activeJudges) {
    for (const artifact of queue.artifacts) {
      const findings = artifact.humanLabel.findingPresence === 'findings' ? [{ severity: 'medium' }] : [];
      recordCalibrationJudgeRun(queue, campaign, artifact.id, judge.id, {
        ran: true,
        verdict: artifact.humanLabel.verdict,
        findings,
        reviewerIdentity: judge.id === 'opus-4-8'
          ? 'anthropic:multiple[claude-haiku-4-5-20251001+claude-opus-4-8]'
          : `openai:${judge.model}`,
        usage: { input_tokens: 100, output_tokens: 20 },
        durationMs: 1000,
      }, {
        sourceRunId: `judge-${judge.id}-${artifact.ordinal}`,
        recordedAt: `2026-08-26T13:${String(artifact.ordinal).padStart(2, '0')}:00.000Z`,
      });
    }
  }
  persistCalibrationQueue(queue, campaign, configHash, paths);

  const calibrated = loadJudgeCalibration(campaign, paths.value).summary;
  assert.equal(calibrated.crossScreenRanking, 'eligible');
  assert.match(calibrated.calibrationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(calibrated.screenEvidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calibrated.screenJudgeIds.length, 2);
  assert.equal(calibrated.screenActualIdentities.length, 2);
  assert.equal(calibrated.screenJudgeRunIds.length, 24);
  assert.equal(calibrated.judges.find((judge) => judge.id === 'gpt-luna').standing, 'uncalibrated');
  assert.equal(calibrated.judges.filter((judge) => judge.id !== 'gpt-luna').every((judge) => judge.standing === 'calibrated'), true);
  assert.throws(() => labelCalibrationArtifact(queue, 1, {
    verdict: 'REVISE', findingPresence: 'findings', human: 'Mateo',
  }), /labels are frozen/);

  const mixedIdentity = calibrationValueFromQueue(structuredClone(queue));
  mixedIdentity.judgeRuns.find((run) => run.judgeId === 'opus-4-8').actualIdentity = 'anthropic:claude-opus-4-8';
  assert.equal(summarizeJudgeCalibration(campaign, mixedIdentity).crossScreenRanking, 'refused_uncalibrated');
  const sameActualIdentity = calibrationValueFromQueue(structuredClone(queue));
  for (const run of sameActualIdentity.judgeRuns) run.actualIdentity = 'shared:same-actual-model';
  assert.equal(summarizeJudgeCalibration(campaign, sameActualIdentity).crossScreenRanking, 'refused_uncalibrated');
  const proxyOnly = calibrationValueFromQueue(structuredClone(queue));
  for (const artifact of proxyOnly.artifacts) {
    artifact.humanLabel = {
      ...artifact.humanLabel,
      authority: 'expert_ai_proxy',
      labeledBy: 'expert_ai_proxy:codex',
      delegatedBy: 'human:Mateo',
    };
  }
  const proxySummary = summarizeJudgeCalibration(campaign, proxyOnly);
  assert.equal(proxySummary.humanLabeledArtifacts, 0, 'proxy work never impersonates formal human ground truth');
  assert.equal(proxySummary.crossScreenRanking, 'refused_uncalibrated');
  assert.equal(proxySummary.proxyCrossScreenComparison, 'provisional_eligible');
  assert.throws(() => loadCalibrationQueue(campaign, hash('stale generation'), paths), /stale for the active campaign generation/);

  console.log('model-eval-calibration: privacy, human-label, identity, and agreement contracts passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
