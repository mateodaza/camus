// Regression coverage for the P1 calibration-workspace consistency boundaries.
// This file deliberately uses the real mock HTTP server and CLI, but creates only
// synthetic reports under isolated STUDIO_* directories. It never invokes a judge
// adapter or reads an operator queue/credential.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { judgeCalibrationPaths } from './lib/judge-calibration.mjs';
import { holdTestCalibrationLock } from './calibration-test-lock.mjs';
import {
  labelCalibrationArtifact,
  loadCalibrationQueue,
  persistCalibrationQueue,
  recordCalibrationJudgeFailure,
} from './lib/model-eval-calibration.mjs';
import {
  commitCalibrationLabel,
  loadWorkspaceSidecar,
  saveWorkspaceDraft,
  workspaceStatusView,
} from './lib/calibration-workspace.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const ACTIVE = 'regression-active-generation';
const OTHER = 'regression-other-generation';
const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const hash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const stateDir = mkdtempSync(join(tmpdir(), 'cls-cal-regression-state-'));
const runsDir = mkdtempSync(join(tmpdir(), 'cls-cal-regression-runs-'));

process.env.STUDIO_GRANDFATHER_DIR = stateDir;
process.env.STUDIO_JUDGE_CALIBRATION_GENERATION = ACTIVE;
const paths = judgeCalibrationPaths(ACTIVE);

function writeReports() {
  const makers = campaign.candidates.slice(0, 4);
  for (const profile of campaign.profiles) {
    for (const [index, maker] of makers.entries()) {
      const evaluationCase = profile.cases[index % profile.cases.length];
      const id = `regression-${profile.id}-${maker.id}`;
      const deliverable = `# ${profile.id} artifact ${index + 1}\n\nSynthetic blinded calibration content for ${evaluationCase.id}.`;
      const report = {
        id,
        evaluationCampaignId: campaign.id,
        evaluationConfigHash: configHash,
        evaluationProfile: profile.id,
        evaluationCaseId: evaluationCase.id,
        simulated: false,
        answers: [],
        status: index % 2 ? 'done_with_findings' : 'verify_failed',
        goal: `Evaluate anonymous ${profile.id} content.`,
        acceptanceContract: 'Return a useful artifact satisfying the supplied goal.',
        lane: 'freeform',
        deliverable,
        models: { maker: { backend: maker.backend, model: maker.model } },
        evidence: { grounding: null },
        evidencePack: {
          goal: `Evaluate anonymous ${profile.id} content.`,
          acceptance_contract: 'Return a useful artifact satisfying the supplied goal.',
          artifact_id: hash(`evidence:${id}`),
          artifact: {
            kind: 'research', deliverable_hash: hash(deliverable), claims: [],
            contract_coverage: [{ id: 'criterion-1', text: 'Goal is met.', decision: 'met' }],
          },
        },
      };
      const reportDir = join(runsDir, id);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report));
    }
  }
}

const waitFor = async (predicate, message, timeoutMs = 750) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(message);
};

const childExit = (child) => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

writeReports();
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: __dirname,
  env: {
    ...process.env,
    ENGINE: 'mock', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh',
    STUDIO_RUNS_DIR: runsDir, STUDIO_GRANDFATHER_DIR: stateDir,
    STUDIO_JUDGE_CALIBRATION_GENERATION: ACTIVE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[calibration-regression server] ${data}`));
let base = '';
for await (const chunk of server.stdout) {
  const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (match) { base = `http://${HOST}:${match[1]}`; break; }
}
assert.ok(base, 'mock server announced its port');

let token = '';
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (error) { results.push(`  FAIL ${name}: ${error.stack || error.message}`); process.exitCode = 1; }
};
const api = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { origin: 'https://camus.sh', 'x-studio-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const rejected = async (response, what) => {
  assert.ok([400, 409].includes(response.status), `${what} must reject (got ${response.status}: ${await response.text()})`);
};

try {
  token = (await (await fetch(`${base}/api/status`)).json()).token;
  assert.ok(token, 'session token issued');

  await check('CLI --prepare joins the HTTP prepare lock before it can create a queue', async () => {
    // The child-only preload marks the first relevant operation. A fixed CLI must
    // attempt the shared lock before checking the queue; the current CLI exposes
    // its unlocked queue check instead. This is a positive interleaving barrier,
    // not an absence-of-a-file timing guess.
    mkdirSync(dirname(paths.queue), { recursive: true, mode: 0o700 });
    const lockPort = 20000 + (createHash('sha256').update(resolve(paths.queue), 'utf8').digest().readUInt32BE(0) % 30000);
    const probeDir = mkdtempSync(join(tmpdir(), 'cls-cal-regression-lock-probe-'));
    const preload = join(probeDir, 'probe.cjs');
    writeFileSync(preload, String.raw`
const net = require('node:net');
const { join } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const port = Number(process.env.CAL_REGRESSION_LOCK_PORT);
const signals = process.env.CAL_REGRESSION_SIGNAL_DIR;
const { writeFileSync } = require('node:fs');
const mark = (name) => { try { writeFileSync(join(signals, name), '1'); } catch {} };
const createServer = net.createServer;
net.createServer = function patchedCreateServer(...args) {
  const server = createServer.apply(this, args);
  const listen = server.listen;
  server.listen = function patchedListen(options, ...rest) {
    if (options?.port === port) mark('cli-lock-attempt');
    return listen.call(this, options, ...rest);
  };
  return server;
};
syncBuiltinESMExports();
`);
    const release = await holdTestCalibrationLock(paths);
    const httpPrepare = api('POST', '/api/calibration/prepare', { generation: ACTIVE, revision: 0 });
    const cli = spawn(process.execPath, ['--require', preload, 'model-calibrate.mjs', '--prepare', '--runs', runsDir, '--generation', ACTIVE], {
      cwd: __dirname,
      env: {
        ...process.env, STUDIO_GRANDFATHER_DIR: stateDir, STUDIO_JUDGE_CALIBRATION_GENERATION: ACTIVE,
        CAL_REGRESSION_LOCK_PORT: String(lockPort), CAL_REGRESSION_SIGNAL_DIR: probeDir,
      },
      stdio: 'ignore',
    });
    let gateError;
    try {
      await waitFor(
        () => existsSync(join(probeDir, 'cli-lock-attempt')),
        'CLI did not attempt the shared Node lock',
        4000,
      );
      assert.equal(existsSync(join(probeDir, 'cli-lock-attempt')), true, 'CLI prepare must acquire the shared Node lock before queue inspection');
      assert.equal(existsSync(paths.queue), false, 'no CLI queue mutation may pass the held shared lock');
    } catch (error) {
      gateError = error;
    } finally {
      release();
    }
    // Always drain both participants before surfacing the gate assertion: this
    // keeps a red regression from leaking a child process or pending HTTP work.
    const [httpOutcome, cliOutcome] = await Promise.allSettled([httpPrepare, childExit(cli)]);
    rmSync(probeDir, { recursive: true, force: true });
    if (gateError) throw gateError;
    assert.equal(httpOutcome.status, 'fulfilled', 'HTTP prepare settled after the gate release');
    assert.equal(cliOutcome.status, 'fulfilled', 'CLI prepare settled after the gate release');
    const http = httpOutcome.value;
    const cliResult = cliOutcome.value;
    // If the CLI wins immediately after release, HTTP's create binding can safely
    // become stale; it must refuse rather than overwrite the just-created queue.
    assert.ok([200, 201, 409].includes(http.status), `HTTP prepare completes or safely refuses stale create (got ${http.status})`);
    assert.equal(cliResult.code, 0, 'CLI completes after the gate is released');
  });

  await check('browser prepare requires an exact active generation and create/reuse revision binding', async () => {
    await rejected(await api('POST', '/api/calibration/prepare', {}), 'prepare without generation/revision');
    await rejected(await api('POST', '/api/calibration/prepare', { generation: OTHER, revision: 0 }), 'cross-generation prepare');
    const status = await (await api('GET', '/api/calibration/workspace')).json();
    await rejected(await api('POST', '/api/calibration/prepare', { generation: ACTIVE, revision: 'stale-binding' }), 'stale prepare');
    const exact = await api('POST', '/api/calibration/prepare', { generation: ACTIVE, revision: status.queueRevision });
    assert.equal(exact.status, 200, 'an exact prepare retry remains idempotent');
  });

  await check('browser draft and navigation mutations require exact generation and sidecar revisions', async () => {
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, artifactSelector: 1, verdict: 'APPROVED', findingPresence: 'clean',
    }), 'draft without revision');
    const first = await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, artifactSelector: 1, verdict: 'APPROVED', findingPresence: 'clean', revision: 0,
    });
    assert.equal(first.status, 200);
    const saved = await first.json();
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, artifactSelector: 1, verdict: 'REVISE', findingPresence: 'findings', revision: 0,
    }), 'stale draft revision');
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: OTHER, artifactSelector: 2, verdict: 'APPROVED', findingPresence: 'clean', revision: 0,
    }), 'cross-generation draft');
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, navigateTo: 2,
    }), 'navigation without revision');
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: OTHER, navigateTo: 2, revision: saved.draftSidecarRevision,
    }), 'cross-generation navigation');
    const navigate = await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, navigateTo: 2, revision: saved.draftSidecarRevision,
    });
    assert.equal(navigate.status, 200, 'current sidecar revision permits navigation');
  });

  await check('new browser labels require queue and artifact-draft revisions; exact semantic retries stay accepted', async () => {
    const view = await (await api('GET', '/api/calibration/artifact?selector=3')).json();
    const committed = await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: 3, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: view.queueRevision, draftRevision: view.draftRevision,
    });
    assert.equal(committed.status, 200);
    const retry = await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: 3, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean',
    });
    assert.equal(retry.status, 200, 'an exact idempotent retry is never rejected for a stale/missing token');
    assert.equal((await retry.json()).idempotent, true);
    const next = await (await api('GET', '/api/calibration/artifact?selector=4')).json();
    await rejected(await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: 4, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean',
    }), 'new label without revision');
    await rejected(await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: 4, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: next.queueRevision,
    }), 'new label without draft revision');
    await rejected(await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: 5, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: 'stale-binding',
    }), 'stale label revision');
    await rejected(await api('POST', '/api/calibration/label', {
      generation: OTHER, artifactSelector: 6, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: next.queueRevision,
    }), 'cross-generation label');
  });

  await check('browser artifact selectors never accept private sourceRunId values', async () => {
    const queue = loadCalibrationQueue(campaign, configHash, paths);
    const source = queue.artifacts[6].sourceRunId;
    await rejected(await api('GET', `/api/calibration/artifact?selector=${encodeURIComponent(source)}`), 'sourceRunId artifact read');
    const sidecarRevision = (await (await api('GET', '/api/calibration/workspace')).json()).draftSidecarRevision;
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, artifactSelector: source, verdict: 'APPROVED', findingPresence: 'clean', revision: 0,
    }), 'sourceRunId draft');
    await rejected(await api('POST', '/api/calibration/draft', {
      generation: ACTIVE, navigateTo: source, revision: sidecarRevision,
    }), 'sourceRunId navigation');
    const queueRevision = (await (await api('GET', '/api/calibration/workspace')).json()).queueRevision;
    await rejected(await api('POST', '/api/calibration/label', {
      generation: ACTIVE, artifactSelector: source, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: queueRevision,
    }), 'sourceRunId label');
  });

  await check('CLI --generation retires the draft and timing in that generation, not env/default generation', async () => {
    const cliGeneration = 'regression-cli-nondefault';
    const cliPaths = judgeCalibrationPaths(cliGeneration);
    execFileSync(process.execPath, ['model-calibrate.mjs', '--prepare', '--runs', runsDir, '--generation', cliGeneration], {
      cwd: __dirname,
      env: { ...process.env, STUDIO_GRANDFATHER_DIR: stateDir, STUDIO_JUDGE_CALIBRATION_GENERATION: ACTIVE },
      stdio: 'ignore',
    });
    const prior = process.env.STUDIO_JUDGE_CALIBRATION_GENERATION;
    process.env.STUDIO_JUDGE_CALIBRATION_GENERATION = cliGeneration;
    try {
      await saveWorkspaceDraft(campaign, configHash, cliPaths, {
        selector: 1, patch: { verdict: 'APPROVED', findingPresence: 'clean' }, expectedRevision: 0, activeMs: 1234,
      });
    } finally {
      process.env.STUDIO_JUDGE_CALIBRATION_GENERATION = prior;
    }
    execFileSync(process.execPath, ['model-calibrate.mjs', '--label', '--artifact', '1', '--verdict', 'APPROVED', '--finding-presence', 'clean', '--human', 'Mateo', '--generation', cliGeneration], {
      cwd: __dirname,
      env: { ...process.env, STUDIO_GRANDFATHER_DIR: stateDir, STUDIO_JUDGE_CALIBRATION_GENERATION: ACTIVE },
      stdio: 'ignore',
    });
    const sidecar = loadWorkspaceSidecar(cliPaths, campaign, configHash, cliGeneration);
    assert.equal(Object.keys(sidecar.drafts).length, 0, 'CLI commits retire the draft stored for --generation');
    assert.deepEqual(sidecar.timingSamples, [1234], 'CLI commits retain the timing sample in --generation');
  });

  await check('a persisted failed/aborted judge execution freezes labels after restart and appears frozen in status', async () => {
    // This is the durable failure/restart boundary: an adapter that fails or is
    // aborted has already begun a paid judge execution, so its persisted attempt
    // must freeze the generation just as an eventual result does.
    const freezePaths = judgeCalibrationPaths('regression-freeze-failure');
    const activeQueue = loadCalibrationQueue(campaign, configHash, paths);
    const frozen = structuredClone(activeQueue);
    frozen.judgeRuns = [];
    frozen.attempts = [];
    for (const artifact of frozen.artifacts) artifact.humanLabel = null;
    for (const artifact of frozen.artifacts.slice(0, -1)) {
      labelCalibrationArtifact(frozen, artifact.ordinal, {
        verdict: 'APPROVED', findingPresence: 'clean', human: 'Mateo', labeledAt: '2026-08-28T00:00:00.000Z',
      });
    }
    const judge = campaign.calibration.judges[0];
    recordCalibrationJudgeFailure(frozen, frozen.artifacts[0].id, judge.id, 'aborted after adapter start', {
      sourceRunId: 'synthetic-aborted-judge-attempt', recordedAt: '2026-08-28T00:00:01.000Z',
    });
    persistCalibrationQueue(frozen, campaign, configHash, freezePaths);
    const restarted = loadCalibrationQueue(campaign, configHash, freezePaths);
    const view = workspaceStatusView(restarted, campaign, loadWorkspaceSidecar(freezePaths, campaign, configHash, 'regression-freeze-failure'), 'regression-freeze-failure');
    assert.equal(view.labelsFrozen, true, 'a durable execution attempt is visible as a frozen generation after restart');
    await assert.rejects(() => commitCalibrationLabel(campaign, configHash, freezePaths, {
      selector: restarted.artifacts.at(-1).ordinal, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: view.queueRevision,
    }), /frozen/i, 'a durable execution attempt rejects later label commits');
  });

  // In-flight lifecycle acceptance design (intentionally not fabricated here):
  // factor the CLI judge loop into an injectable runner and pass it a fake adapter
  // that (1) records it has been entered, then blocks on a parent-controlled gate.
  // Before opening the gate, restart/read the queue in a second process and assert
  // status.labelsFrozen plus label/draft/prepare refusal. Then resolve as success,
  // failure, and AbortError in separate cases; SIGKILL the runner while blocked and
  // restart again. Every case must retain the same durable freeze marker. The
  // current CLI imports concrete adapters and exposes no lifecycle seam, so adding
  // a fake provider or attempting a real call here would make this regression
  // non-hermetic rather than test the persistence contract.
} finally {
  server.kill('SIGKILL');
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
}

console.log(results.join('\n'));
if (process.exitCode) console.error('\ncalibration-workspace-regression: FAILED');
else console.log('\ncalibration-workspace-regression: P1 contracts passed');
