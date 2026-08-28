// Judge lifecycle custody: synthetic queue, fake adapter injected by a Node loader.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { judgeCalibrationPaths } from './lib/judge-calibration.mjs';
import { labelCalibrationArtifact, loadCalibrationQueue, persistCalibrationQueue, prepareCalibrationQueue } from './lib/model-eval-calibration.mjs';

const here = new URL('.', import.meta.url).pathname;
const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const root = mkdtempSync(join(tmpdir(), 'cls-lifecycle-'));
const children = new Set();
process.env.STUDIO_GRANDFATHER_DIR = join(root, 'state');
process.env.STUDIO_RUNS_DIR = join(root, 'runs');
for (const name of ['STUDIO_JUDGE_CALIBRATION_FILE', 'STUDIO_JUDGE_CALIBRATION_QUEUE_FILE',
  'STUDIO_JUDGE_CALIBRATION_ARTIFACTS_DIR', 'STUDIO_JUDGE_CALIBRATION_RECEIPTS_DIR',
  'STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE']) delete process.env[name];
const loaderSource = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
export async function runCodexReview({ signal }) {
  appendFileSync(process.env.FAKE_CALLS, 'call\\n');
  writeFileSync(process.env.FAKE_STARTED, 'started\\n');
  if (process.env.FAKE_MODE === 'hold') await new Promise((resolve) => {
    const timer = setInterval(() => {}, 25);
    const poll = setInterval(() => { if (process.env.FAKE_RELEASE && existsSync(process.env.FAKE_RELEASE)) { clearInterval(timer); clearInterval(poll); resolve(); } }, 10);
    signal?.addEventListener('abort', () => { clearInterval(timer); clearInterval(poll); resolve(); }, { once: true });
  });
  if (process.env.FAKE_MODE === 'block') await new Promise((resolve) => { setInterval(() => {}, 25); });
  if (process.env.FAKE_MODE === 'abort') {
    await new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const timer = setInterval(() => {}, 25);
      signal?.addEventListener('abort', () => { clearInterval(timer); resolve(); }, { once: true });
    });
    return { ran: false, error: 'synthetic abort' };
  }
  if (process.env.FAKE_MODE === 'failure') return { ran: false, error: 'synthetic adapter failure' };
  return { ran: true, verdict: 'APPROVED', findings: [], reviewerIdentity: 'codex:synthetic', usage: null, durationMs: 1 };
}`;
const loader = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/lib/adapters/codex.mjs')) return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(loaderSource)}`)}, shortCircuit: true };
  return nextResolve(specifier, context);
}`)}`;

function reports() {
  const makers = campaign.candidates.slice(0, 4);
  return campaign.profiles.flatMap((profile) => makers.map((maker, i) => {
    const c = profile.cases[i % profile.cases.length];
    const id = `life-${profile.id}-${maker.id}`;
    const deliverable = `Synthetic lifecycle artifact ${id}`;
    return { id, evaluationCampaignId: campaign.id, evaluationConfigHash: configHash,
      evaluationProfile: profile.id, evaluationCaseId: c.id, simulated: false, answers: [],
      goal: 'Synthetic calibration goal', acceptanceContract: 'Synthetic acceptance contract', lane: 'freeform', deliverable,
      models: { maker: { backend: maker.backend, model: maker.model } }, evidence: { grounding: null },
      evidencePack: { goal: 'Synthetic calibration goal', acceptance_contract: 'Synthetic acceptance contract',
        artifact_id: `sha256:${'b'.repeat(64)}`, artifact: { kind: 'research', deliverable_hash: `sha256:${createHash('sha256').update(deliverable).digest('hex')}`, claims: [], contract_coverage: [] } },
    };
  }));
}

function setup(generation) {
  const paths = judgeCalibrationPaths(generation);
  const selected = prepareCalibrationQueue(campaign, configHash, reports(), { paths }).queue;
  for (const artifact of selected.artifacts) labelCalibrationArtifact(selected, artifact.ordinal, { verdict: 'APPROVED', findingPresence: 'clean', human: 'Mateo' });
  persistCalibrationQueue(selected, campaign, configHash, paths);
  return paths;
}

function child(paths, mode, calls, started, release = '') {
  const env = { ...process.env, NODE_OPTIONS: `--experimental-loader=${loader}`, FAKE_MODE: mode, FAKE_CALLS: calls, FAKE_STARTED: started, FAKE_RELEASE: release };
  const proc = spawn(process.execPath, ['model-calibrate.mjs', '--run-judge', '--judge', 'gpt-sol', '--artifact', '1', '--generation', paths.generation], { cwd: here, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  return proc;
}

function waitFor(path, timeout = 3000) {
  const until = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => existsSync(path) ? resolve() : Date.now() >= until ? reject(new Error(`timeout waiting for ${path}`)) : setTimeout(tick, 10);
    tick();
  });
}

function exited(proc, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeout);
    proc.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

try {
  const successPaths = setup(`life-success-${process.pid}`);
  const calls = join(root, 'success.calls'); const started = join(root, 'success.started'); const release = join(root, 'success.release');
  const first = child(successPaths, 'hold', calls, started, release); const firstExit = exited(first); await waitFor(started);
  const pending = loadCalibrationQueue(campaign, configHash, successPaths);
  assert.equal(pending.attempts.find((attempt) => attempt.artifactId === pending.artifacts[0].id).status, 'started');
  const second = child(successPaths, 'hold', calls, join(root, 'success.started.2'), release); const secondExit = exited(second);
  const secondResult = await secondExit;
  assert.notEqual(secondResult.code, 0, 'overlapping judge refuses the reserved cell');
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'same artifact/judge receives one paid call');
  writeFileSync(release, 'release\n');
  assert.equal((await firstExit).code, 0);
  assert.equal(loadCalibrationQueue(campaign, configHash, successPaths).judgeRuns.length, 1);

  for (const mode of ['failure', 'block']) {
    const paths = setup(`life-${mode}-${process.pid}`);
    const callsFile = join(root, `${mode}.calls`); const startedFile = join(root, `${mode}.started`);
    const proc = child(paths, mode, callsFile, startedFile); await waitFor(startedFile);
    const procExit = exited(proc);
    if (mode === 'block') proc.kill('SIGKILL'); else await procExit;
    if (mode === 'block') { const result = await procExit; assert.equal(result.signal, 'SIGKILL'); }
    const queue = loadCalibrationQueue(campaign, configHash, paths);
    assert.ok(queue.attempts.some((attempt) => attempt.artifactId === queue.artifacts[0].id), `${mode} leaves a durable freeze marker`);
    assert.equal(queue.judgeRuns.length, 0);
  }

  const abortPaths = setup(`life-abort-${process.pid}`);
  const abortCalls = join(root, 'abort.calls'); const abortStarted = join(root, 'abort.started');
  const abortProc = child(abortPaths, 'abort', abortCalls, abortStarted); const abortExit = exited(abortProc); await waitFor(abortStarted);
  abortProc.kill('SIGTERM');
  const abortResult = await abortExit;
  assert.notEqual(abortResult.code, 0);
  const aborted = loadCalibrationQueue(campaign, configHash, abortPaths);
  assert.ok(aborted.attempts.some((attempt) => attempt.status === 'infra_failed'));
  assert.equal(aborted.judgeRuns.length, 0);

  const canonicalPaths = setup(`life-label-${process.pid}`);
  const queue = loadCalibrationQueue(campaign, configHash, canonicalPaths);
  queue.attempts.push({ artifactId: queue.artifacts[0].id, judgeId: 'gpt-sol', sourceRunId: 'synthetic-attempt', status: 'infra_failed', error: 'synthetic', recordedAt: new Date().toISOString() });
  // A NEW label is refused after an attempt; an exact already-committed label
  // remains retryable, which is also what repairs interrupted sidecar cleanup.
  delete queue.artifacts[1].humanLabel;
  assert.throws(() => labelCalibrationArtifact(queue, 2, { verdict: 'APPROVED', findingPresence: 'clean', human: 'Mateo' }), /frozen|attempt|judge/i);
  labelCalibrationArtifact(queue, 1, { verdict: 'approved', findingPresence: 'CLEAN', human: 'Mateo' });
  assert.equal(queue.artifacts[0].humanLabel.verdict, 'APPROVED');
  assert.equal(queue.artifacts[0].humanLabel.findingPresence, 'clean');
  assert.doesNotThrow(() => labelCalibrationArtifact(queue, 1, { verdict: 'APPROVED', findingPresence: 'clean', human: 'Mateo' }));
  console.log('calibration-workspace-lifecycle: contracts passed');
} finally {
  for (const proc of children) proc.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
