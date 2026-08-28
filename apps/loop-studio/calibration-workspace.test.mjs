// Blinded calibration workspace: HTTP contract + library invariants, hermetic.
// Spawns the real server (mock engine, ephemeral port) against isolated STUDIO_*
// directories and synthetic evaluation reports. Proves blinding, no model spend,
// draft-vs-label separation, exact retry / stale conflict, invalid-label refusal,
// human/proxy separation, frozen-generation refusal, persistence after reload,
// and CLI interoperability through the shared commit transaction.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { judgeCalibrationPaths } from './lib/judge-calibration.mjs';
import {
  loadCalibrationQueue,
  persistCalibrationQueue,
  recordCalibrationJudgeRun,
} from './lib/model-eval-calibration.mjs';
import { commitCalibrationLabel, loadWorkspaceSidecar, withCalibrationLock } from './lib/calibration-workspace.mjs';
import { holdTestCalibrationLock } from './calibration-test-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const GENERATION = 'workspace-test-gen';
const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const hash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const mode = (file) => statSync(file).mode & 0o777;

// Isolated STUDIO_* dirs. STUDIO_GRANDFATHER_DIR is the operator-state root that
// judge-calibration paths hang off; STUDIO_RUNS_DIR feeds prepare(). Both are
// throwaway temp dirs so the operator's real calibration state is never touched.
const grandfatherDir = mkdtempSync(join(tmpdir(), 'cls-cal-ws-state-'));
const runsDir = mkdtempSync(join(tmpdir(), 'cls-cal-ws-runs-'));
process.env.STUDIO_GRANDFATHER_DIR = grandfatherDir;
process.env.STUDIO_JUDGE_CALIBRATION_GENERATION = GENERATION;

function writeFixtureReports() {
  const makers = campaign.candidates.slice(0, 4);
  const reports = campaign.profiles.flatMap((profile) => makers.map((maker, makerIndex) => {
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
  for (const report of reports) {
    const dir = join(runsDir, report.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  }
}

writeFixtureReports();
const paths = judgeCalibrationPaths(GENERATION);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: __dirname,
  env: {
    ...process.env,
    ENGINE: 'mock',
    OPEN: '0',
    PORT: '0',
    STUDIO_ALLOWED_ORIGIN: 'https://camus.sh',
    STUDIO_RUNS_DIR: runsDir,
    STUDIO_GRANDFATHER_DIR: grandfatherDir,
    STUDIO_JUDGE_CALIBRATION_GENERATION: GENERATION,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
let base = '';
for await (const chunk of server.stdout) {
  const m = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (m) { base = `http://${HOST}:${m[1]}`; break; }
}
assert.ok(base, 'server announced a port');

const ORIGIN = 'https://camus.sh';
let TOKEN = '';
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (err) { results.push(`  FAIL ${name}: ${err.stack || err.message}`); process.exitCode = 1; }
};
const api = (method, path, { token = TOKEN, body, origin = ORIGIN } = {}) => {
  const headers = { origin };
  if (token) headers['x-studio-token'] = token;
  const init = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  return fetch(`${base}${path}`, init);
};

try {
  const status = await (await fetch(`${base}/api/status`)).json();
  TOKEN = status.token;
  assert.ok(TOKEN, 'session token issued');

  await check('every workspace endpoint requires the session token (GET included)', async () => {
    assert.equal((await api('GET', '/api/calibration/workspace', { token: '' })).status, 401);
    assert.equal((await api('GET', '/api/calibration/workspace', { token: 'wrong' })).status, 401);
    assert.equal((await api('GET', '/api/calibration/artifact?selector=1', { token: '' })).status, 401);
    assert.equal((await api('POST', '/api/calibration/prepare', { token: '', body: {} })).status, 401);
  });

  await check('prepare selects a blinded queue, then reuse is idempotent', async () => {
    // A create binds to revision 0 (no queue exists yet); reuse binds to the
    // current queue revision. Both must name the active generation.
    const first = await api('POST', '/api/calibration/prepare', { body: { generation: GENERATION, revision: 0 } });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.totalArtifacts, 12);
    assert.equal(firstBody.labeled, 0);
    assert.equal(firstBody.labelsFrozen, false);

    const status = await (await api('GET', '/api/calibration/workspace')).json();
    const second = await api('POST', '/api/calibration/prepare', { body: { generation: GENERATION, revision: status.queueRevision } });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).created, false);
  });

  await check('files land 0600 under a 0700 operator dir, not in the project', async () => {
    assert.ok(paths.queue.startsWith(grandfatherDir), 'queue lives under the isolated operator dir');
    assert.equal(mode(paths.queue), 0o600);
    assert.equal(mode(paths.artifactsDir), 0o700);
    assert.equal(existsSync(join(__dirname, 'runs', 'judge-calibration')), false, 'no runtime state in the project tree');
  });

  await check('the blinded artifact view omits provenance, identity, and judge decisions', async () => {
    const r = await api('GET', '/api/calibration/artifact?selector=1');
    assert.equal(r.status, 200);
    const raw = await r.text();
    const view = JSON.parse(raw);
    // Allowlisted content the human needs.
    assert.ok(view.goal && view.acceptanceContract && view.deliverable);
    assert.equal(view.ordinal, 1);
    assert.match(view.id, /^sha256:[a-f0-9]{64}$/);
    // Forbidden fields never appear.
    for (const forbidden of ['sourceRunId', 'sourceEvidenceArtifactId', 'artifactFile', 'makerKey', 'models', 'maker', 'reviewer', 'groundingEvidence', 'claims', 'criteria', 'judgeRuns']) {
      assert.equal(Object.hasOwn(view, forbidden), false, `${forbidden} must not be exposed`);
    }
    assert.doesNotMatch(raw, /gpt-|claude-|grok-|qwen|sourceRunId|artifactFile|reviewerIdentity/i, 'no maker/judge identity leaks');
    assert.equal(view.committedLabel, null);
    assert.equal(view.draft, null);
  });

  await check('no model spend: prepare/label never create judge receipts or runs', async () => {
    assert.equal(existsSync(paths.receiptsDir), false, 'no receipts directory is created');
    const ws = await (await api('GET', '/api/calibration/workspace')).json();
    assert.equal(ws.labelsFrozen, false);
    assert.equal(ws.disagreementsAvailable, false);
  });

  await check('disagreements are unavailable before labels are committed and frozen', async () => {
    const r = await api('GET', '/api/calibration/disagreements');
    assert.equal(r.status, 409);
    assert.equal((await r.json()).available, false);
  });

  await check('draft autosave is a private sidecar, never a label', async () => {
    const save = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 1, verdict: 'APPROVED', findingPresence: 'clean', activeMs: 5000, revision: 0 },
    });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.draft.verdict, 'APPROVED');
    assert.equal(saved.draft.findingPresence, 'clean');
    assert.equal(saved.navigation.currentArtifactId, null, 'plain autosave never changes global navigation');

    const view = await (await api('GET', '/api/calibration/artifact?selector=1')).json();
    assert.equal(view.draft.verdict, 'APPROVED');
    assert.equal(view.committedLabel, null, 'a draft never becomes a committed label');
    const ws = await (await api('GET', '/api/calibration/workspace')).json();
    assert.equal(ws.labeled, 0, 'drafting labels nothing');
    assert.equal(ws.artifacts.find((a) => a.ordinal === 1).hasDraft, true);
  });

  await check('navigation has its own sidecar CAS and a draft cannot roll it back', async () => {
    const beforeNavigation = await (await api('GET', '/api/calibration/workspace')).json();
    const navigate = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, navigateTo: 2, revision: beforeNavigation.draftSidecarRevision },
    });
    assert.equal(navigate.status, 200);
    const navigated = await navigate.json();
    const artifact2 = (await (await api('GET', '/api/calibration/artifact?selector=2')).json()).id;
    assert.equal(navigated.navigation.currentArtifactId, artifact2);

    // A valid per-artifact revision from a different tab is enough to save that
    // draft, but it must not implicitly restore global navigation to artifact 10.
    const draft = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 10, verdict: 'APPROVED', findingPresence: 'clean', revision: 0 },
    });
    assert.equal(draft.status, 200);
    assert.equal((await draft.json()).navigation.currentArtifactId, artifact2);

    const staleNavigation = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, navigateTo: 3, revision: beforeNavigation.draftSidecarRevision },
    });
    assert.equal(staleNavigation.status, 409, 'stale sidecar navigation loses the race');

    const combined = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 11, verdict: 'APPROVED', findingPresence: 'clean', revision: 0, navigateTo: 3 },
    });
    assert.equal(combined.status, 400, 'a draft and navigation must carry separate bindings');
  });

  await check('empty draft fields stay empty', async () => {
    const save = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 2, authority: 'human', revision: 0 },
    });
    const saved = await save.json();
    assert.equal(saved.draft.authority, 'human');
    assert.equal(saved.draft.verdict, null);
    assert.equal(saved.draft.findingPresence, null);
    assert.equal(saved.draft.owner, null);
  });

  await check('a second draft write must carry the matching revision (no silent clobber)', async () => {
    // Every write — a first write included — must carry the matching per-artifact
    // draft revision; a fresh artifact starts at 0.
    const first = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 7, verdict: 'APPROVED', findingPresence: 'clean', revision: 0 },
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).draftRevision, 1);

    // A second write that omits the revision is rejected as a stale overwrite.
    const blind = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 7, verdict: 'REVISE', findingPresence: 'findings' },
    });
    assert.equal(blind.status, 409);
    assert.match((await blind.json()).error, /another tab/i);

    // A stale revision is rejected; the matching revision wins.
    const stale = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 7, verdict: 'REVISE', findingPresence: 'findings', revision: 0 },
    });
    assert.equal(stale.status, 409);
    const fresh = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 7, verdict: 'REVISE', findingPresence: 'findings', revision: 1 },
    });
    assert.equal(fresh.status, 200);
    const body = await fresh.json();
    assert.equal(body.draft.verdict, 'REVISE');
    assert.equal(body.draftRevision, 2);
  });

  await check('active-label timing is bounded; ETA never becomes Infinity', async () => {
    const huge = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 8, verdict: 'APPROVED', findingPresence: 'clean', activeMs: Number.MAX_VALUE, revision: 0 },
    });
    assert.equal(huge.status, 400);
    assert.match((await huge.json()).error, /activeMs/i);
    // The rejected sample never reached the sidecar, so the ETA stays finite.
    const ws = await (await api('GET', '/api/calibration/workspace')).json();
    if (ws.eta.available) assert.ok(Number.isFinite(ws.eta.etaMs), 'ETA must be finite when available');
  });

  await check('ETA stays unavailable until a measured sample exists', async () => {
    const before = await (await api('GET', '/api/calibration/workspace')).json();
    assert.equal(before.eta.available, false);
    assert.equal(before.eta.etaMs, null);
    assert.equal(before.eta.sampleCount, 0);
  });

  await check('invalid labels are refused with bounded errors', async () => {
    // A valid queue revision so these reach the semantic validators (an invalid
    // owner / a REVISE without findings), not the revision gate. None commit.
    const view1 = await (await api('GET', '/api/calibration/artifact?selector=1')).json();
    const rev1 = view1.queueRevision;
    const person = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'AI agent', verdict: 'APPROVED', findingPresence: 'clean', revision: rev1, draftRevision: view1.draftRevision },
    });
    assert.equal(person.status, 400);
    assert.match((await person.json()).error, /person/i);

    const revise = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'REVISE', findingPresence: 'clean', revision: rev1, draftRevision: view1.draftRevision },
    });
    assert.equal(revise.status, 400);

    const badVerdict = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'MAYBE', findingPresence: 'clean', revision: rev1, draftRevision: view1.draftRevision },
    });
    assert.equal(badVerdict.status, 400);

    const badGen = await api('POST', '/api/calibration/label', {
      body: { generation: 'some-other-gen', artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(badGen.status, 409);

    const badSelector = await api('GET', '/api/calibration/artifact?selector=nope');
    assert.equal(badSelector.status, 400);
  });

  await check('human and expert AI proxy stay separate, with no default owner', async () => {
    const noOwner = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 3, authority: 'human', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(noOwner.status, 400, 'no default human name');

    const proxyNoDelegate = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 3, authority: 'expert_ai_proxy', owner: 'codex', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(proxyNoDelegate.status, 400, 'a proxy needs a human delegator');

    const view3 = await (await api('GET', '/api/calibration/artifact?selector=3')).json();
    const rev3 = view3.queueRevision;
    const proxy = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 3, authority: 'expert_ai_proxy', owner: 'codex', delegatedBy: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: rev3, draftRevision: view3.draftRevision },
    });
    assert.equal(proxy.status, 200);
    const proxied = (await proxy.json()).artifact.committedLabel;
    assert.equal(proxied.authority, 'expert_ai_proxy');
    assert.equal(proxied.labeledBy, 'expert_ai_proxy:codex');
    assert.equal(proxied.delegatedBy, 'human:Mateo');
  });

  await check('committing a label is idempotent on retry, immutable on change', async () => {
    const view = await (await api('GET', '/api/calibration/artifact?selector=1')).json();
    const commit = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: view.queueRevision, draftRevision: view.draftRevision },
    });
    assert.equal(commit.status, 200);
    const committed = await commit.json();
    assert.equal(committed.idempotent, false);
    assert.equal(committed.artifact.committedLabel.labeledBy, 'human:Mateo');
    // The commit retired the draft and recorded a timing sample -> ETA available.
    assert.equal(committed.status.eta.available, true);
    assert.ok(committed.status.eta.etaMs > 0);
    assert.equal(committed.artifact.draft, null, 'the draft is retired once committed');

    const retry = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotent, true, 'exact retry is idempotent');

    const changed = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'REVISE', findingPresence: 'findings' },
    });
    assert.equal(changed.status, 409);
    assert.match((await changed.json()).error, /immutable/i);
  });

  await check('a new label binds the artifact draft revision so a stale tab cannot erase newer scratch', async () => {
    const tabA = await (await api('GET', '/api/calibration/artifact?selector=9')).json();
    const tabB = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 9, verdict: 'REVISE', findingPresence: 'findings', revision: tabA.draftRevision },
    });
    assert.equal(tabB.status, 200);
    const newerDraft = await tabB.json();
    assert.equal(newerDraft.draftRevision, tabA.draftRevision + 1);

    const staleCommit = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 9, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: tabA.queueRevision, draftRevision: tabA.draftRevision },
    });
    assert.equal(staleCommit.status, 409);
    const retained = await (await api('GET', '/api/calibration/artifact?selector=9')).json();
    assert.equal(retained.committedLabel, null);
    assert.equal(retained.draft.verdict, 'REVISE', 'the newer tab draft remains durable');

    const freshCommit = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 9, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: retained.queueRevision, draftRevision: retained.draftRevision },
    });
    assert.equal(freshCommit.status, 200);
    assert.equal((await freshCommit.json()).artifact.draft, null);
  });

  await check('an exact retry with an already-prefixed owner is still idempotent', async () => {
    // Artifact 1 stored "human:Mateo"; a retry that carries the prefixed owner must
    // canonicalize to the same value, not "human:human:Mateo".
    const human = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'human:Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(human.status, 200);
    assert.equal((await human.json()).idempotent, true, 'prefixed human owner retry is idempotent');

    // Artifact 3 stored an expert_ai_proxy label; prefixed proxy + delegator retry too.
    const proxy = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 3, authority: 'expert_ai_proxy', owner: 'expert_ai_proxy:codex', delegatedBy: 'human:Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal(proxy.status, 200);
    assert.equal((await proxy.json()).idempotent, true, 'prefixed proxy owner/delegator retry is idempotent');
  });

  await check('a draft is refused once its artifact carries a committed label', async () => {
    const r = await api('POST', '/api/calibration/draft', {
      body: { generation: GENERATION, artifactSelector: 1, verdict: 'REVISE' },
    });
    assert.equal(r.status, 409);
  });

  await check('a stale revision loses the race', async () => {
    const view = await (await api('GET', '/api/calibration/artifact?selector=4')).json();
    const staleRevision = 'q_0000000000000000';
    assert.notEqual(staleRevision, view.queueRevision);
    const stale = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 4, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: staleRevision, draftRevision: view.draftRevision },
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /changed since you loaded it/i);

    const fresh = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 4, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: view.queueRevision, draftRevision: view.draftRevision },
    });
    assert.equal(fresh.status, 200);
  });

  await check('drafts and labels persist across a reload', async () => {
    // Draft on an unlabeled artifact survives; committed labels survive.
    await api('POST', '/api/calibration/draft', { body: { generation: GENERATION, artifactSelector: 5, verdict: 'REVISE', findingPresence: 'findings', revision: 0 } });
    const view5 = await (await api('GET', '/api/calibration/artifact?selector=5')).json();
    assert.equal(view5.draft.verdict, 'REVISE');
    assert.equal(view5.committedLabel, null);
    const view1 = await (await api('GET', '/api/calibration/artifact?selector=1')).json();
    assert.equal(view1.committedLabel.verdict, 'APPROVED');
    // A fresh library read (a "reload" from cold state) sees the same durable file.
    const reloaded = loadCalibrationQueue(campaign, configHash, paths);
    assert.equal(reloaded.artifacts.find((a) => a.ordinal === 1).humanLabel.labeledBy, 'human:Mateo');
  });

  await check('CLI interoperability: the CLI shares the commit transaction and lock', async () => {
    // Label artifact 6 through the CLI's shared transaction, then read it back
    // over HTTP — proving the browser and terminal agree on one authority.
    execFileSync(process.execPath, ['model-calibrate.mjs', '--label', '--artifact', '6', '--verdict', 'approved', '--finding-presence', 'CLEAN', '--human', 'Mateo', '--generation', GENERATION], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: 'ignore',
    });
    const view = await (await api('GET', '/api/calibration/artifact?selector=6')).json();
    assert.equal(view.committedLabel.labeledBy, 'human:Mateo');
    // And an HTTP idempotent retry of the CLI's exact label succeeds.
    const retry = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 6, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal((await retry.json()).idempotent, true);
  });

  await check('library: an occupied Node lease fails closed instead of being stolen', async () => {
    const release = await holdTestCalibrationLock(paths);
    try {
      await assert.rejects(() => withCalibrationLock(paths, () => { throw new Error('must not enter'); }, { timeoutMs: 0 }), /workspace is busy/i);
    } finally {
      release();
    }
  });

  await check('frozen generation: disagreements unlock read-only; new labels refuse', async () => {
    // Finish labeling every artifact (some already labeled above), through HTTP.
    let queue = loadCalibrationQueue(campaign, configHash, paths);
    for (const artifact of queue.artifacts) {
      if (artifact.humanLabel) continue;
      const view = await (await api('GET', `/api/calibration/artifact?selector=${artifact.ordinal}`)).json();
      const r = await api('POST', '/api/calibration/label', {
        body: { generation: GENERATION, artifactSelector: artifact.ordinal, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean', revision: view.queueRevision, draftRevision: view.draftRevision },
      });
      assert.equal(r.status, 200, `labeled artifact ${artifact.ordinal}`);
    }
    // Record judge runs directly (no HTTP endpoint can spend) to freeze labels.
    queue = loadCalibrationQueue(campaign, configHash, paths);
    const judge = campaign.calibration.judges.find((j) => campaign.independence.judgeScreens.some((s) => `${s.reviewer.backend}:${s.reviewer.model}` === `${j.backend}:${j.model}`));
    for (const artifact of queue.artifacts) {
      recordCalibrationJudgeRun(queue, campaign, artifact.id, judge.id, {
        ran: true, verdict: 'APPROVED', findings: [], reviewerIdentity: `seat:${judge.id}`,
      }, { sourceRunId: `run-${judge.id}-${artifact.ordinal}` });
    }
    persistCalibrationQueue(queue, campaign, configHash, paths);

    const dis = await api('GET', '/api/calibration/disagreements');
    assert.equal(dis.status, 200);
    const body = await dis.json();
    assert.equal(body.available, true);
    assert.equal(body.rows.length, 12);
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /sourceRunId|reviewerIdentity|actualIdentity/i, 'disagreements omit receipts and raw identity');
    assert.ok(body.rows[0].judges.length >= 1);

    // A different label on a frozen, already-labeled artifact is refused.
    const changed = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'REVISE', findingPresence: 'findings' },
    });
    assert.equal(changed.status, 409);
    // An identical retry is still accepted even after freeze.
    const same = await api('POST', '/api/calibration/label', {
      body: { generation: GENERATION, artifactSelector: 1, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' },
    });
    assert.equal((await same.json()).idempotent, true);
  });

  await check('library: an unlabeled artifact cannot be labeled once judges have run', async () => {
    // Craft the frozen-with-unlabeled state directly: 11 labels + a judge run on
    // a labeled artifact + one still-open artifact, then prove commit refuses it.
    const frozenRoot = mkdtempSync(join(tmpdir(), 'cls-cal-ws-frozen-'));
    const frozenPaths = {
      value: join(frozenRoot, 'judge-calibration.json'),
      queue: join(frozenRoot, 'queue.json'),
      artifactsDir: join(frozenRoot, 'artifacts'),
      receiptsDir: join(frozenRoot, 'receipts'),
    };
    try {
      const queue = loadCalibrationQueue(campaign, configHash, paths); // reuse the fully-labeled queue shape
      // Rebuild under frozen paths with the last artifact unlabeled.
      const rebuilt = structuredClone(queue);
      rebuilt.evaluationConfigHash = configHash;
      rebuilt.judgeRuns = [];
      rebuilt.attempts = [];
      const open = rebuilt.artifacts[rebuilt.artifacts.length - 1];
      open.humanLabel = null;
      const judge = campaign.calibration.judges.find((j) => campaign.independence.judgeScreens.some((s) => `${s.reviewer.backend}:${s.reviewer.model}` === `${j.backend}:${j.model}`));
      const labeled = rebuilt.artifacts[0];
      rebuilt.judgeRuns.push({
        artifactId: labeled.id, judgeId: judge.id, sourceRunId: 'frozen-run',
        actualIdentity: `seat:${judge.id}`, verdict: labeled.humanLabel.verdict,
        findingPresence: labeled.humanLabel.findingPresence, findingCount: 0, usage: null, durationMs: null,
        recordedAt: '2026-08-26T13:00:00.000Z',
      });
      persistCalibrationQueue(rebuilt, campaign, configHash, frozenPaths);
      await assert.rejects(() => commitCalibrationLabel(campaign, configHash, frozenPaths, {
        selector: open.ordinal, authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean',
      }), /frozen/i);
    } finally {
      rmSync(frozenRoot, { recursive: true, force: true });
    }
  });

  await check('library: existing invalid or cross-generation sidecars fail closed and stay untouched', () => {
    const draftsRoot = mkdtempSync(join(tmpdir(), 'cls-cal-ws-drafts-'));
    const draftsFile = join(draftsRoot, 'drafts.json');
    const prior = process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE;
    process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE = draftsFile;
    try {
      const unsupported = {
        schemaVersion: 2, campaignId: campaign.id, evaluationConfigHash: configHash, generation: GENERATION,
        revision: 0, navigation: { currentArtifactId: null }, drafts: {}, timingSamples: [],
      };
      const wrongGeneration = {
        schemaVersion: 1, campaignId: campaign.id, evaluationConfigHash: configHash, generation: 'a-different-generation',
        revision: 0, navigation: { currentArtifactId: null }, drafts: {}, timingSamples: [],
      };
      const damagedDraft = {
        schemaVersion: 1, campaignId: campaign.id, evaluationConfigHash: configHash, generation: GENERATION,
        revision: 0, navigation: { currentArtifactId: null }, drafts: { damaged: 'not a draft record' }, timingSamples: [],
      };
      for (const value of ['{not json', JSON.stringify(unsupported), JSON.stringify(wrongGeneration), JSON.stringify(damagedDraft)]) {
        writeFileSync(draftsFile, value);
        const before = readFileSync(draftsFile, 'utf8');
        assert.throws(() => loadWorkspaceSidecar(paths, campaign, configHash, GENERATION), /sidecar.*repair/i);
        assert.equal(readFileSync(draftsFile, 'utf8'), before, 'a failed read never resets durable drafts');
      }
      process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE = draftsRoot;
      assert.throws(() => loadWorkspaceSidecar(paths, campaign, configHash, GENERATION), /sidecar.*repair/i, 'an existing unreadable sidecar path fails closed');
    } finally {
      if (prior === undefined) delete process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE;
      else process.env.STUDIO_JUDGE_CALIBRATION_DRAFTS_FILE = prior;
      rmSync(draftsRoot, { recursive: true, force: true });
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
} finally {
  server.kill('SIGKILL');
  rmSync(grandfatherDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
}

console.log(results.join('\n'));
if (process.exitCode) { console.error('\ncalibration-workspace: FAILED'); }
else console.log('\ncalibration-workspace: blinded workspace HTTP + library contracts passed');
