import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canCommit, createCalibrationController, navigationTarget } from './calibration.mjs';

const clone = (value) => structuredClone(value);
const baseWorkspace = () => ({
  prepared: true, generation: 'gen-1', queueRevision: 'queue-7', draftSidecarRevision: 0,
  totalArtifacts: 2, labeled: 0, humanLabels: 0, proxyLabels: 0, labelsFrozen: false,
  navigation: { currentArtifactId: 'a' }, eta: { available: false, sampleCount: 0 }, disagreementsAvailable: false,
  artifacts: [{ ordinal: 1, id: 'a', labeled: false }, { ordinal: 2, id: 'b', labeled: false }],
});
const artifact = (ordinal, draft = null) => ({ generation: 'gen-1', id: ordinal === 1 ? 'a' : 'b', ordinal, goal: `<goal ${ordinal}>`, acceptanceContract: '<contract>', deliverable: '<not html>', labelsFrozen: false, committedLabel: null, draft, draftRevision: draft?.revision ?? 0 });

function fixture() {
  const workspace = baseWorkspace(); const artifacts = new Map([[1, artifact(1)], [2, artifact(2)]]); const saves = []; const commits = [];
  let sidecarRevision = 0; let saveOverride = null;
  const api = {
    getWorkspace: async () => clone(workspace),
    getArtifact: async (selector) => clone(artifacts.get(Number(selector)) || artifacts.get(selector === 'a' ? 1 : 2)),
    saveDraft: async (body) => {
      saves.push(clone(body));
      if (saveOverride) return saveOverride(body);
      sidecarRevision += 1;
      if (body.navigateTo != null) { workspace.navigation.currentArtifactId = body.navigateTo === 2 ? 'b' : 'a'; return { saved: true, generation: 'gen-1', draftSidecarRevision: sidecarRevision }; }
      const prior = artifacts.get(body.artifactSelector); const draft = { authority: body.authority, owner: body.owner, delegatedBy: body.delegatedBy, verdict: body.verdict, findingPresence: body.findingPresence, activeMs: body.activeMs, revision: prior.draftRevision + 1 };
      artifacts.set(body.artifactSelector, artifact(body.artifactSelector, draft));
      return { saved: true, generation: 'gen-1', draft, draftRevision: draft.revision, draftSidecarRevision: sidecarRevision };
    },
    commitLabel: async (body) => {
      commits.push(clone(body)); const prior = artifacts.get(body.artifactSelector); const committed = { ...prior, committedLabel: { authority: body.authority, labeledBy: body.owner, delegatedBy: body.delegatedBy, verdict: body.verdict, findingPresence: body.findingPresence } };
      artifacts.set(body.artifactSelector, committed); workspace.labeled += 1; workspace.humanLabels += body.authority === 'human' ? 1 : 0; workspace.proxyLabels += body.authority === 'expert_ai_proxy' ? 1 : 0;
      const { prepared, ...status } = clone(workspace);
      return { artifact: clone(committed), queueRevision: 'queue-8', status: { ...status, queueRevision: 'queue-8', draftSidecarRevision: sidecarRevision } };
    },
    getDisagreements: async () => ({ generation: 'gen-1', available: true, rows: [] }),
  };
  return { api, workspace, saves, commits, artifacts, setSaveOverride: (fn) => { saveOverride = fn; } };
}

assert.equal(canCommit({ authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' }), true);
assert.equal(canCommit({ authority: 'expert_ai_proxy', owner: 'proxy', verdict: 'REVISE', findingPresence: 'findings' }), false, 'proxy requires an explicit human delegator');
assert.equal(canCommit({ authority: 'expert_ai_proxy', owner: 'proxy', delegatedBy: 'Mateo', verdict: 'REVISE', findingPresence: 'findings' }), true);
assert.equal(canCommit({ authority: 'human', owner: 'Mateo', verdict: 'REVISE', findingPresence: 'clean' }), false);
assert.equal(navigationTarget({ key: 'ArrowRight', target: { tagName: 'ARTICLE' } }, 1, 2), 2);
assert.equal(navigationTarget({ key: 'ArrowLeft', target: { tagName: 'ARTICLE' } }, 1, 2), null);
for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) assert.equal(navigationTarget({ key: 'ArrowRight', target: { tagName } }, 1, 2), null);
assert.equal(navigationTarget({ key: 'Enter', target: { tagName: 'ARTICLE' } }, 1, 2), null, 'keyboard navigation never commits labels');
assert.equal(navigationTarget({ key: 'ArrowRight', target: { tagName: 'DIV', isContentEditable: true } }, 1, 2), null);

// Local typing is source-of-truth until its matching save succeeds; a response never re-renders stale fields over it.
{
  const f = fixture(); const c = createCalibrationController({ api: f.api, debounceMs: 60_000 }); await c.refresh();
  c.updateDraft({ owner: 'first' }); assert.equal(c.snapshot().draft.owner, 'first');
  let release; f.setSaveOverride(() => new Promise((resolve) => { release = resolve; }));
  const firstSave = c.flushDraft(); c.updateDraft({ owner: 'newer' });
  release({ generation: 'gen-1', draft: { owner: 'first', revision: 1 }, draftRevision: 1, draftSidecarRevision: 1 });
  // The controller serializes the second save with the returned revision and preserves the newer local text.
  f.setSaveOverride(null); await firstSave;
  assert.equal(c.snapshot().draft.owner, 'newer');
  assert.equal(f.saves.at(-1).owner, 'newer'); assert.equal(f.saves.at(-1).revision, 1);
}

// Every label field is sent on a draft save, including explicit null clearing values.
{
  const f = fixture(); const c = createCalibrationController({ api: f.api, debounceMs: 60_000 }); await c.refresh();
  c.updateDraft({ authority: 'human', owner: 'Mateo', verdict: 'APPROVED', findingPresence: 'clean' }); await c.flushDraft();
  c.updateDraft({ owner: '', verdict: null, findingPresence: null }); await c.flushDraft();
  const body = f.saves.at(-1); assert.equal(body.owner, null); assert.equal(body.verdict, null); assert.equal(body.findingPresence, null); assert.equal(body.delegatedBy, null);
}

// Navigation first flushes scratch, persists sidecar navigation separately, and remains put on a save error.
{
  const f = fixture(); const c = createCalibrationController({ api: f.api, debounceMs: 60_000 }); await c.refresh(); c.updateDraft({ owner: 'keep me' });
  f.setSaveOverride(async () => { throw new Error('offline'); }); assert.equal(await c.select(2), false); assert.equal(c.snapshot().artifact.ordinal, 1); assert.match(c.snapshot().error, /Stayed on this artifact/);
  f.setSaveOverride(null); assert.equal(await c.select(2), true); assert.equal(c.snapshot().artifact.ordinal, 2); assert.equal(f.saves.at(-1).navigateTo, 2); assert.equal(Object.hasOwn(f.saves.at(-1), 'artifactSelector'), false, 'navigation is a separate sidecar mutation');
}

// Commit is never implicit, flushes the newest scratch, and binds both queue and draft revisions.
{
  const f = fixture(); const c = createCalibrationController({ api: f.api, debounceMs: 60_000 }); await c.refresh();
  c.updateDraft({ authority: 'expert_ai_proxy', owner: 'model operator', verdict: 'REVISE', findingPresence: 'findings' }); assert.equal(await c.commit(), false); assert.equal(f.commits.length, 0);
  c.updateDraft({ delegatedBy: 'Mateo' }); assert.equal(await c.commit(), true); const body = f.commits[0];
  assert.deepEqual({ generation: body.generation, artifactSelector: body.artifactSelector, revision: body.revision, draftRevision: body.draftRevision }, { generation: 'gen-1', artifactSelector: 1, revision: 'queue-7', draftRevision: 1 });
  assert.equal(body.delegatedBy, 'Mateo'); assert.equal(c.snapshot().artifact.committedLabel.verdict, 'REVISE'); assert.equal(c.snapshot().workspace.prepared, true, 'label status is not a GET envelope, so the controller restores its prepared flag'); assert.equal(c.updateDraft({ owner: 'cannot edit' }), false);
  assert.equal(await c.select(2), true, 'a successful commit leaves the workspace navigable');
}

// A refreshed workspace always replaces the displayed artifact, even when the selector ordinal is unchanged.
{
  const f = fixture(); const c = createCalibrationController({ api: f.api, debounceMs: 60_000 }); await c.refresh();
  f.workspace.generation = 'gen-2'; f.workspace.navigation.currentArtifactId = 'a';
  f.artifacts.set(1, { ...artifact(1), generation: 'gen-2', goal: 'new generation goal' });
  await c.refresh(); assert.equal(c.snapshot().generation, 'gen-2'); assert.equal(c.snapshot().artifact.goal, 'new generation goal');
}

// Timing is captured only across visible intervals, then persisted at an explicit boundary.
{
  const f = fixture(); let clock = 100; const c = createCalibrationController({ api: f.api, debounceMs: 60_000, now: () => clock }); await c.refresh();
  clock = 850; c.setVisible(false); clock = 9_000; await c.pauseAndFlush();
  assert.equal(f.saves.at(-1).activeMs, 750, 'hidden time is not recorded');
  c.setVisible(true); clock = 10_200; await c.select(2);
  assert.equal(f.saves.at(-2).activeMs, 1_950, 'navigation is a timing persistence boundary before the separate nav write');
}

// The DOM adapter clears all radio choices and uses textContent for untrusted artifact fields.
const source = readFileSync(new URL('./calibration.mjs', import.meta.url), 'utf8');
assert.match(source, /input\.checked = input\.value === value/);
assert.match(source, /text\(\$\('cal-goal'\), artifact\.goal\)/);
assert.match(source, /text\(\$\('cal-deliverable'\), artifact\.deliverable\)/);
assert.doesNotMatch(source, /innerHTML/);
console.log('calibration frontend controller: behavioral contracts passed');
