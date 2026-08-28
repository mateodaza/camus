// Round-three consistency regressions. Synthetic reports only; no judge/provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { judgeCalibrationPaths } from './lib/judge-calibration.mjs';
import { loadCalibrationQueue } from './lib/model-eval-calibration.mjs';
import { commitCalibrationLabel, loadWorkspaceSidecar, saveWorkspaceDraft, withCalibrationLock } from './lib/calibration-workspace.mjs';
import { holdTestCalibrationLock } from './calibration-test-lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const generationHint = `round3-${process.pid}-${Date.now()}`;
const stateDir = mkdtempSync(join(tmpdir(), 'cls-round3-state-'));
const runsDir = mkdtempSync(join(tmpdir(), 'cls-round3-runs-'));
const hash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function writeReports() {
  const makers = campaign.candidates.slice(0, 4);
  for (const profile of campaign.profiles) {
    for (const [index, maker] of makers.entries()) {
      const evaluationCase = profile.cases[index % profile.cases.length];
      const id = `round3-${profile.id}-${maker.id}`;
      const deliverable = `# ${profile.id} artifact ${index + 1}\n\nSynthetic round-three calibration content.`;
      const dir = join(runsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'report.json'), JSON.stringify({
        id, evaluationCampaignId: campaign.id, evaluationConfigHash: configHash,
        evaluationProfile: profile.id, evaluationCaseId: evaluationCase.id,
        simulated: false, answers: [], status: 'done',
        goal: `Evaluate anonymous ${profile.id} content.`,
        acceptanceContract: 'Return a useful artifact satisfying the supplied goal.',
        lane: 'freeform', deliverable,
        models: { maker: { backend: maker.backend, model: maker.model } },
        evidence: { grounding: null },
        evidencePack: {
          goal: `Evaluate anonymous ${profile.id} content.`,
          acceptance_contract: 'Return a useful artifact satisfying the supplied goal.',
          artifact_id: hash(`evidence:${id}`),
          artifact: { kind: 'research', deliverable_hash: hash(deliverable), claims: [],
            contract_coverage: [{ id: 'criterion-1', text: 'Goal is met.', decision: 'met' }] },
        },
      }));
    }
  }
}

writeReports();
process.env.STUDIO_GRANDFATHER_DIR = stateDir;
process.env.STUDIO_RUNS_DIR = runsDir;
process.env.STUDIO_JUDGE_CALIBRATION_GENERATION = generationHint;

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: here,
  env: { ...process.env, ENGINE: 'mock', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[round3] ${data}`));
let base = '';
for await (const chunk of server.stdout) {
  const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (match) { base = `http://127.0.0.1:${match[1]}`; break; }
}
assert.ok(base, 'server announced a port');

const ORIGIN = 'https://camus.sh';
let token = '';
const api = (method, path, { body, suppliedToken = token } = {}) => {
  const headers = { origin: ORIGIN };
  if (suppliedToken) headers['x-studio-token'] = suppliedToken;
  const init = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  return fetch(`${base}${path}`, init);
};

try {
  token = (await (await fetch(`${base}/api/status`)).json()).token;
  const first = await (await api('GET', '/api/calibration/workspace')).json();
  assert.equal(first.prepared, false);
  assert.equal(first.generation, generationHint);
  assert.equal(first.queueRevision, 0);
  const generation = first.generation;
  const prepared = await api('POST', '/api/calibration/prepare', { body: { generation, revision: first.queueRevision } });
  assert.equal(prepared.status, 201);
  const preparedBody = await prepared.json();
  assert.equal(preparedBody.prepared, true);
  const paths = judgeCalibrationPaths(generation);
  const initialQueue = readFileSync(paths.queue);

  // A 200/saved response must never discard a missing-target draft. Non-scalar
  // JSON selectors must not be coerced into real artifact ordinals either.
  for (const body of [
    { generation, verdict: 'APPROVED', revision: 0 },
    { generation, revision: 0 },
    { generation, navigateTo: 1, verdict: 'APPROVED', revision: 0 },
  ]) {
    const response = await api('POST', '/api/calibration/draft', { body });
    assert.equal(response.status, 400);
    assert.notEqual((await response.json()).saved, true);
  }
  for (const selector of [[1], ['1'], {}, true, []]) {
    for (const [path, body] of [
      ['/api/calibration/draft', { generation, artifactSelector: selector, verdict: 'APPROVED', revision: 0 }],
      ['/api/calibration/draft', { generation, navigateTo: selector, revision: 0 }],
      ['/api/calibration/label', { generation, artifactSelector: selector, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: preparedBody.queueRevision }],
    ]) assert.equal((await api('POST', path, { body })).status, 400);
  }
  assert.deepEqual(readFileSync(paths.queue), initialQueue);
  assert.equal((await (await api('GET', '/api/calibration/workspace')).json()).draftSidecarRevision, 0);

  // A normal draft write must not move shared navigation. A combined draft/nav
  // write is rejected, so a stale tab cannot clobber navigation after tab B moves.
  const tabB = await api('POST', '/api/calibration/draft', {
    body: { generation, navigateTo: 2, revision: 0 },
  });
  assert.equal(tabB.status, 200);
  const navAfterB = (await (await api('GET', '/api/calibration/workspace')).json()).navigation.currentArtifactId;
  assert.ok(navAfterB);
  const staleTabA = await api('POST', '/api/calibration/draft', {
    body: { generation, artifactSelector: 1, verdict: 'APPROVED', findingPresence: 'clean', revision: 0, navigateTo: 1 },
  });
  assert.notEqual(staleTabA.status, 200);
  const navAfterA = (await (await api('GET', '/api/calibration/workspace')).json()).navigation.currentArtifactId;
  assert.equal(navAfterA, navAfterB);

  const release = await holdTestCalibrationLock(paths);
  await assert.rejects(() => withCalibrationLock(paths, () => assert.fail('entered an occupied Node lease'), { timeoutMs: 40 }), /busy/i);
  release();

  // Kill a real JS holder inside the critical section. The OS must release its
  // loopback lease immediately; no filesystem sentinel exists to steal or clean.
  const lockHolder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withCalibrationLock } from './lib/calibration-workspace.mjs';
    await withCalibrationLock(${JSON.stringify({ queue: paths.queue })}, async () => {
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    });
  `], { cwd: here, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const holderExited = new Promise((resolve) => lockHolder.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder did not acquire the lock')), 4000);
      lockHolder.once('error', (error) => { clearTimeout(timer); reject(error); });
      lockHolder.stdout.once('data', (data) => {
        clearTimeout(timer);
        if (!String(data).includes('locked')) reject(new Error('unexpected holder output'));
        else resolve();
      });
    });
    await assert.rejects(() => withCalibrationLock(paths, () => assert.fail('entered held lock'), { timeoutMs: 0 }), /busy/i);
    lockHolder.kill('SIGKILL');
    assert.equal((await holderExited).signal, 'SIGKILL');
    assert.equal(await withCalibrationLock(paths, () => 'recovered'), 'recovered');
  } finally {
    if (lockHolder.exitCode === null && lockHolder.signalCode === null) lockHolder.kill('SIGKILL');
    await holderExited;
  }

  const sidecar = process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE
    || join(dirname(paths.queue), 'model-eval-calibration-drafts.json');
  const draftBody = { generation, artifactSelector: 3, verdict: 'APPROVED', findingPresence: 'clean', revision: 0 };
  writeFileSync(sidecar, '{not-json');
  const corruptBefore = readFileSync(sidecar);
  const corrupt = await api('POST', '/api/calibration/draft', { body: draftBody });
  assert.notEqual(corrupt.status, 200);
  assert.deepEqual(readFileSync(sidecar), corruptBefore);
  const queueBeforeRefusedCommit = readFileSync(paths.queue);
  const corruptLabel = await api('POST', '/api/calibration/label', {
    body: {
      generation, artifactSelector: 3, authority: 'human', owner: 'Mateo',
      verdict: 'APPROVED', findingPresence: 'clean', revision: preparedBody.queueRevision,
    },
  });
  assert.equal(corruptLabel.status, 409);
  assert.deepEqual(readFileSync(paths.queue), queueBeforeRefusedCommit,
    'sidecar refusal happens before the canonical label is committed');
  assert.deepEqual(readFileSync(sidecar), corruptBefore);
  writeFileSync(sidecar, JSON.stringify({ schemaVersion: 999 }));
  const unsupportedBefore = readFileSync(sidecar);
  const unsupported = await api('POST', '/api/calibration/draft', { body: draftBody });
  assert.notEqual(unsupported.status, 200);
  assert.deepEqual(readFileSync(sidecar), unsupportedBefore);
  rmSync(sidecar);
  const initialized = await api('POST', '/api/calibration/draft', { body: draftBody });
  assert.equal(initialized.status, 200);
  assert.ok(existsSync(sidecar), 'missing sidecar can be initialized');
  rmSync(sidecar);
  mkdirSync(sidecar);
  const unreadable = await api('POST', '/api/calibration/draft', { body: draftBody });
  assert.notEqual(unreadable.status, 200);
  assert.equal(statSync(sidecar).isDirectory(), true);
  rmSync(sidecar, { recursive: true });

  execFileSync(process.execPath, ['model-calibrate.mjs', '--label', '--artifact', '4',
    '--verdict', 'approved', '--finding-presence', 'CLEAN', '--human', 'Mateo'], {
    cwd: here, env: process.env, stdio: 'pipe',
  });
  const queue = loadCalibrationQueue(campaign, configHash, paths);
  assert.equal(queue.artifacts.find((artifact) => artifact.ordinal === 4).humanLabel.verdict, 'APPROVED');
  assert.equal(queue.artifacts.find((artifact) => artifact.ordinal === 4).humanLabel.findingPresence, 'clean');

  // Inject a real sidecar rename failure after canonical persistence. An exact
  // semantic retry must finish cleanup and count its timing sample exactly once.
  await saveWorkspaceDraft(campaign, configHash, paths, {
    selector: 8, expectedRevision: 0, patch: { verdict: 'APPROVED' }, activeMs: 4200,
  });
  const commit = { selector: 8, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' };
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (target === sidecar) { const error = new Error('synthetic sidecar write failure'); error.code = 'EIO'; throw error; }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    await assert.rejects(() => commitCalibrationLabel(campaign, configHash, paths, commit), /synthetic sidecar write failure/);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const committedQueue = loadCalibrationQueue(campaign, configHash, paths);
  const committedArtifact = committedQueue.artifacts.find((artifact) => artifact.ordinal === 8);
  assert.equal(committedArtifact.humanLabel.verdict, 'APPROVED');
  assert.ok(loadWorkspaceSidecar(paths, campaign, configHash, generation).drafts[committedArtifact.id]);
  assert.equal((await commitCalibrationLabel(campaign, configHash, paths, commit)).idempotent, true);
  const cleaned = loadWorkspaceSidecar(paths, campaign, configHash, generation);
  assert.equal(cleaned.drafts[committedArtifact.id], undefined);
  assert.deepEqual(cleaned.timingSamples, [4200]);
  assert.equal((await commitCalibrationLabel(campaign, configHash, paths, commit)).idempotent, true);
  assert.deepEqual(loadWorkspaceSidecar(paths, campaign, configHash, generation).timingSamples, [4200]);

  const goodSidecar = readFileSync(sidecar, 'utf8');
  try {
    for (const value of [1e308, 86_400_001, -1]) {
      const damaged = JSON.stringify({ ...JSON.parse(goodSidecar), timingSamples: [value] });
      writeFileSync(sidecar, damaged);
      const response = await api('GET', '/api/calibration/workspace');
      assert.equal(response.status, 409, 'invalid durable timing refuses instead of exposing a contradictory ETA');
      assert.equal(readFileSync(sidecar, 'utf8'), damaged, 'bad timing data is not silently replaced');
    }
    writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(goodSidecar), timingSamples: [86_400_000] }));
    const bounded = await (await api('GET', '/api/calibration/workspace')).json();
    assert.equal(bounded.eta.available, true);
    assert.ok(Number.isFinite(bounded.eta.etaMs));
  } finally { writeFileSync(sidecar, goodSidecar); }
  console.log('calibration-workspace-round3: contracts passed');
} finally {
  server.kill('SIGKILL');
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
}
