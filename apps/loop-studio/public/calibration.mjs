/* Blinded calibration: a small state machine plus a deliberately boring DOM view. */
const apiBase = typeof location === 'undefined' ? '' : (() => new URLSearchParams(location.search).get('api')?.replace(/\/$/, '') || localStorage.getItem('cls-api') || (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '' : 'http://localhost:1913'))();
const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;

export const emptyDraft = () => ({ authority: null, owner: null, delegatedBy: null, verdict: null, findingPresence: null });
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
export function labelFields(value = {}) { return { authority: value.authority || null, owner: clean(value.owner), delegatedBy: clean(value.delegatedBy), verdict: value.verdict || null, findingPresence: value.findingPresence || null }; }
export function canCommit(value) {
  const label = labelFields(value);
  return Boolean((label.authority === 'human' || (label.authority === 'expert_ai_proxy' && label.delegatedBy)) && label.owner && (label.verdict === 'APPROVED' || label.verdict === 'REVISE') && (label.findingPresence === 'clean' || label.findingPresence === 'findings') && !(label.verdict === 'REVISE' && label.findingPresence !== 'findings'));
}
export function navigationTarget(event, ordinal, total) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target?.tagName)) return null;
  if (event.key === 'ArrowLeft' && ordinal > 1) return ordinal - 1;
  if (event.key === 'ArrowRight' && ordinal < total) return ordinal + 1;
  return null;
}
function invariantGeneration(expected, response) { if (!response || response.generation !== expected) throw new Error('the workspace changed generation; reload before editing'); return response; }
function serverError(error) { return error instanceof Error ? error.message : String(error || 'request failed'); }

// Semantic API methods make async/race behavior testable without a browser or a private workspace.
export function createCalibrationController({ api, view = {}, debounceMs = 350, now = () => Date.now() }) {
  const state = { generation: null, workspace: null, artifact: null, draft: emptyDraft(), draftRevision: 0, draftSidecarRevision: 0, activeMs: 0, activeStartedAt: null, dirty: false, timingDirty: false, saving: false, locked: false, visible: true, error: null, message: '', timer: null, savePromise: null, editVersion: 0, loadVersion: 0 };
  const currentActiveMs = () => !state.activeStartedAt || !state.visible ? state.activeMs : Math.min(MAX_ACTIVE_MS, state.activeMs + Math.max(0, now() - state.activeStartedAt));
  const emit = () => view.render?.({ ...state, draft: { ...state.draft }, readonly: Boolean(state.artifact?.committedLabel || state.artifact?.labelsFrozen || state.workspace?.labelsFrozen), canCommit: canCommit(state.draft), activeMs: currentActiveMs() });
  const message = (value, error = false) => { state.message = value; state.error = error ? value : null; emit(); };
  const consumeActive = () => { state.activeMs = currentActiveMs(); if (state.visible && state.activeStartedAt) state.activeStartedAt = now(); return state.activeMs; };
  const noteActive = () => { const before = state.activeMs; const value = consumeActive(); if (value > before) state.timingDirty = true; return value; };
  const readonly = () => Boolean(state.artifact?.committedLabel || state.artifact?.labelsFrozen || state.workspace?.labelsFrozen);
  const clearTimer = () => { if (state.timer) clearTimeout(state.timer); state.timer = null; };
  function applyArtifact(artifact) {
    invariantGeneration(state.generation, artifact); state.artifact = artifact; state.draft = labelFields(artifact.draft || emptyDraft());
    state.draftRevision = Number.isInteger(artifact.draftRevision) ? artifact.draftRevision : (artifact.draft?.revision || 0);
    state.activeMs = Math.max(0, Math.min(MAX_ACTIVE_MS, Number(artifact.draft?.activeMs) || 0)); state.activeStartedAt = state.visible && !readonly() ? now() : null; state.dirty = false; state.timingDirty = false;
  }
  async function loadArtifact(selector) { const version = ++state.loadVersion; const artifact = invariantGeneration(state.generation, await api.getArtifact(selector)); if (version !== state.loadVersion) return false; applyArtifact(artifact); emit(); return true; }
  async function flushDraft({ includeActive = false } = {}) {
    clearTimer(); if (includeActive) noteActive();
    if (readonly() || (!state.dirty && !state.timingDirty)) return state.savePromise || undefined; if (state.savePromise) return state.savePromise;
    state.savePromise = (async () => { state.saving = true; emit(); try {
      while ((state.dirty || state.timingDirty) && !readonly()) {
        const version = state.editVersion;
        state.timingDirty = false;
        const payload = { generation: state.generation, artifactSelector: state.artifact.ordinal, revision: state.draftRevision, ...labelFields(state.draft), activeMs: consumeActive() };
        const saved = await api.saveDraft(payload);
        // Do not apply returned draft values: an older response must not erase newer typing.
        if (saved?.generation !== undefined) invariantGeneration(state.generation, saved);
        state.draftRevision = Number.isInteger(saved?.draftRevision) ? saved.draftRevision : (saved?.draft?.revision ?? state.draftRevision + 1);
        state.draftSidecarRevision = Number.isInteger(saved?.draftSidecarRevision) ? saved.draftSidecarRevision : state.draftSidecarRevision;
        if (version === state.editVersion) state.dirty = false;
      }
      if (!state.dirty && !state.timingDirty) clearTimer();
      message('Draft saved privately');
    } catch (error) { state.dirty = true; message(`Draft not saved: ${serverError(error)}`, true); throw error; }
    finally { state.saving = false; state.savePromise = null; emit(); } })();
    return state.savePromise;
  }
  function scheduleDraft() { if (readonly() || state.locked) return; clearTimer(); message('Draft changes pending'); state.timer = setTimeout(() => { state.timer = null; void flushDraft().catch(() => {}); }, debounceMs); }
  function updateDraft(patch) { if (readonly() || state.locked) return false; state.draft = labelFields({ ...state.draft, ...patch }); if (state.draft.authority === 'human') state.draft.delegatedBy = null; state.dirty = true; state.editVersion += 1; scheduleDraft(); emit(); return true; }
  async function persistNavigation(selector) { const saved = await api.saveDraft({ generation: state.generation, navigateTo: selector, revision: state.draftSidecarRevision }); if (saved?.generation !== undefined) invariantGeneration(state.generation, saved); state.draftSidecarRevision = Number.isInteger(saved?.draftSidecarRevision) ? saved.draftSidecarRevision : state.draftSidecarRevision + 1; }
  async function select(selector, { persist = true } = {}) {
    if (!state.workspace?.prepared || state.locked || String(selector) === String(state.artifact?.ordinal)) return false;
    state.locked = true; message('Saving before navigation…'); try { await flushDraft({ includeActive: true }); if (persist) await persistNavigation(selector); await loadArtifact(selector); message(state.artifact.draft ? 'Draft recovered' : 'No draft yet'); return true; }
    catch (error) { message(`Stayed on this artifact: ${serverError(error)}`, true); return false; } finally { state.locked = false; emit(); }
  }
  async function refresh() {
    try {
      if (state.artifact) await flushDraft({ includeActive: true });
      const workspace = await api.getWorkspace();
      const generationChanged = state.generation !== null && state.generation !== workspace.generation;
      state.generation = workspace.generation; state.workspace = workspace; state.draftSidecarRevision = workspace.draftSidecarRevision || 0;
      // A workspace response is authoritative: never leave an old artifact on
      // screen while a fresh queue/generation is being resolved.
      if (generationChanged || !workspace.prepared) { state.artifact = null; state.draft = emptyDraft(); state.draftRevision = 0; state.activeMs = 0; state.activeStartedAt = null; }
      emit();
      if (workspace.prepared) { const selector = workspace.navigation?.currentArtifactId || workspace.artifacts.find((a) => !a.labeled)?.ordinal || workspace.artifacts[0]?.ordinal; if (selector != null) await loadArtifact(selector); }
      return workspace;
    }
    catch (error) { message(`Reload failed: ${serverError(error)}`, true); throw error; }
  }
  async function prepare() { state.locked = true; emit(); try { const workspace = invariantGeneration(state.generation, await api.prepare({ generation: state.generation, revision: state.workspace?.queueRevision ?? 0 })); state.workspace = workspace; state.draftSidecarRevision = workspace.draftSidecarRevision || 0; emit(); const selector = workspace.artifacts?.find((a) => !a.labeled)?.ordinal || workspace.artifacts?.[0]?.ordinal; if (selector != null) await loadArtifact(selector); } catch (error) { message(`Workspace not prepared: ${serverError(error)}`, true); } finally { state.locked = false; emit(); } }
  async function commit() {
    if (readonly() || state.locked) return false;
    if (!canCommit(state.draft)) { message('Choose authority, owner, verdict, and finding presence; proxy labels also need a human delegator.', true); return false; }
    state.locked = true; message('Saving before immutable commit…'); try {
      await flushDraft({ includeActive: true });
      const committed = await api.commitLabel({ generation: state.generation, artifactSelector: state.artifact.ordinal, revision: state.workspace.queueRevision, draftRevision: state.draftRevision, ...labelFields(state.draft) });
      // POST /label deliberately has no top-level generation. Its two safe views
      // each carry the binding, and status is a status view rather than a GET envelope.
      invariantGeneration(state.generation, committed?.artifact); invariantGeneration(state.generation, committed?.status);
      state.workspace = { ...committed.status, prepared: true };
      state.draftSidecarRevision = committed.status.draftSidecarRevision ?? state.draftSidecarRevision; applyArtifact(committed.artifact); message('Label committed; this artifact is immutable.'); return true;
    }
    catch (error) { message(`Label not committed: ${serverError(error)}`, true); return false; } finally { state.locked = false; emit(); }
  }
  async function disagreements() { if (!state.workspace?.disagreementsAvailable) return null; const result = invariantGeneration(state.generation, await api.getDisagreements()); view.disagreements?.(result); return result; }
  function setVisible(visible) { if (state.visible === visible) return; noteActive(); state.visible = visible; state.activeStartedAt = visible && state.artifact && !readonly() ? now() : null; emit(); }
  async function pauseAndFlush() { setVisible(false); try { await flushDraft({ includeActive: true }); return true; } catch { return false; } }
  return { refresh, prepare, select, updateDraft, scheduleDraft, flushDraft, commit, disagreements, setVisible, pauseAndFlush, hasPendingWork: () => Boolean(state.dirty || state.timingDirty || state.saving || state.locked), snapshot: () => ({ ...state, draft: { ...state.draft } }) };
}

const $ = (id) => document.getElementById(id);
const text = (node, value) => { node.textContent = value == null ? '' : String(value); };
const radios = (name, value) => document.querySelectorAll(`input[name="${name}"]`).forEach((input) => { input.checked = input.value === value; });
function domView() {
  let formKey = null;
  return { render(state) {
    const w = state.workspace; const artifact = state.artifact; text($('cal-status'), state.error || '');
    if (!w?.prepared) {
      $('cal-workspace').classList.add('hidden'); $('cal-empty').classList.remove('hidden');
      const prepareButton = $('cal-empty').querySelector('button');
      if (prepareButton) prepareButton.disabled = state.locked;
      else if (!state.locked) text($('cal-empty'), 'Calibration is not prepared for this generation.');
      return;
    }
    $('cal-empty').classList.add('hidden'); $('cal-workspace').classList.remove('hidden'); text($('cal-progress'), `${w.labeled}/${w.totalArtifacts} committed · ${w.humanLabels || 0} human · ${w.proxyLabels || 0} proxy · generation ${w.generation}`); text($('cal-eta'), w.eta?.available ? `Measured ETA · ${Math.round(w.eta.etaMs / 60000)} min (${w.eta.sampleCount} samples)` : 'ETA unavailable until measured timing exists.'); text($('cal-active-time'), `Active labeling time · ${Math.floor(state.activeMs / 1000)}s`);
    $('cal-nav').replaceChildren(...(w.artifacts || []).map((item) => { const button = document.createElement('button'); button.className = `cal-nav-item${item.labeled ? ' labeled' : ''}${String(item.ordinal) === String(artifact?.ordinal) ? ' selected' : ''}`; button.textContent = String(item.ordinal); button.disabled = state.locked; button.setAttribute('aria-label', `Artifact ${item.ordinal}${item.labeled ? ', labeled' : ''}`); button.onclick = () => controller.select(item.ordinal); return button; }));
    if (!artifact) return;
    $('cal-prev').disabled = state.locked || artifact.ordinal <= 1;
    $('cal-next').disabled = state.locked || artifact.ordinal >= w.totalArtifacts;
    text($('cal-meta'), `Artifact ${artifact.ordinal} · ${w.totalArtifacts} · ${artifact.labelsFrozen ? 'read-only / frozen' : artifact.committedLabel ? 'committed / immutable' : 'unlabeled'}`); text($('cal-goal'), artifact.goal); text($('cal-contract-text'), artifact.acceptanceContract); text($('cal-facts'), `Deterministic facts · ${String(artifact.deliverable || '').length.toLocaleString()} characters`); text($('cal-deliverable'), artifact.deliverable);
    const key = `${artifact.id}:${state.draftRevision}:${artifact.committedLabel ? 'committed' : 'draft'}`;
    if (key !== formKey) { formKey = key; $('cal-authority').value = state.draft.authority || ''; $('cal-owner').value = state.draft.owner || ''; $('cal-delegated').value = state.draft.delegatedBy || ''; radios('cal-verdict', state.draft.verdict); radios('cal-presence', state.draft.findingPresence); }
    $('cal-delegated-wrap').classList.toggle('hidden', state.draft.authority !== 'expert_ai_proxy'); const lockForm = state.readonly || state.locked; document.querySelectorAll('.cal-label input,.cal-label select').forEach((input) => { input.disabled = lockForm; }); $('cal-commit').disabled = lockForm || !state.canCommit; text($('cal-save-state'), state.error || state.message || (state.saving ? 'Saving…' : '')); $('cal-save-state').classList.toggle('bad', Boolean(state.error)); const committed = artifact.committedLabel; text($('cal-committed'), committed ? `Committed label · ${committed.authority} · ${committed.labeledBy} · ${committed.verdict} + ${committed.findingPresence}${committed.delegatedBy ? ` · delegated by ${committed.delegatedBy}` : ''}` : '');
  }, disagreements(result) { const box = $('cal-disagreements'); box.replaceChildren(); if (!result?.available) { box.classList.add('hidden'); return; } box.classList.remove('hidden'); const heading = document.createElement('h2'); heading.textContent = 'Read-only disagreements'; box.append(heading); for (const row of result.rows || []) { const line = document.createElement('p'); line.textContent = `Artifact ${row.ordinal}: ${row.human.authority} ${row.human.verdict}/${row.human.findingPresence}; judges ${row.judges.map((judge) => `${judge.seat || judge.judgeId} ${judge.verdict}/${judge.findingPresence}`).join(', ') || 'none'}`; box.append(line); } } };
}

let controller;
async function call(method, path, body, token) { const response = await fetch(`${apiBase}${path}`, { method, headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`); return data; }
async function boot() {
  let token; try { token = (await (await fetch(`${apiBase}/api/status`)).json()).token; } catch { return; }
  const api = { getWorkspace: () => call('GET', '/api/calibration/workspace', undefined, token), getArtifact: (selector) => call('GET', `/api/calibration/artifact?selector=${encodeURIComponent(selector)}`, undefined, token), saveDraft: (body) => call('POST', '/api/calibration/draft', body, token), prepare: (body) => call('POST', '/api/calibration/prepare', body, token), commitLabel: (body) => call('POST', '/api/calibration/label', body, token), getDisagreements: () => call('GET', '/api/calibration/disagreements', undefined, token) };
  controller = createCalibrationController({ api, view: domView() });
  const updateVisibility = () => controller.setVisible(document.visibilityState === 'visible' && !$('calibration').classList.contains('hidden'));
  updateVisibility();
  $('open-calibration').onclick = async () => { $('launch').classList.add('hidden'); $('runview').classList.add('hidden'); $('calibration').classList.remove('hidden'); updateVisibility(); try { await controller.refresh(); if (!controller.snapshot().workspace?.prepared) { const prep = document.createElement('button'); prep.className = 'primary'; prep.textContent = 'Prepare workspace'; prep.onclick = () => controller.prepare(); $('cal-empty').replaceChildren(document.createTextNode('No workspace yet. '), prep); } else await controller.disagreements(); } catch {} };
  $('close-calibration').onclick = async () => { if (!await controller.pauseAndFlush()) { controller.setVisible(true); return; } $('calibration').classList.add('hidden'); $('launch').classList.remove('hidden'); }; $('cal-commit').onclick = () => controller.commit(); $('cal-next-unlabeled').onclick = () => { const next = controller.snapshot().workspace?.artifacts.find((item) => !item.labeled); if (next) controller.select(next.ordinal); };
  $('cal-prev').onclick = () => controller.select(controller.snapshot().artifact.ordinal - 1);
  $('cal-next').onclick = () => controller.select(controller.snapshot().artifact.ordinal + 1);
  const update = (id, key) => $(id).addEventListener('input', () => controller.updateDraft({ [key]: $(id).value })); update('cal-authority', 'authority'); update('cal-owner', 'owner'); update('cal-delegated', 'delegatedBy'); document.querySelectorAll('input[name="cal-verdict"]').forEach((input) => input.addEventListener('change', () => controller.updateDraft({ verdict: input.value }))); document.querySelectorAll('input[name="cal-presence"]').forEach((input) => input.addEventListener('change', () => controller.updateDraft({ findingPresence: input.value })));
  $('calibration').addEventListener('keydown', (event) => { const target = navigationTarget(event, controller.snapshot().artifact?.ordinal, controller.snapshot().workspace?.totalArtifacts); if (target != null) { event.preventDefault(); controller.select(target); } }); document.addEventListener('visibilitychange', updateVisibility); addEventListener('beforeunload', (event) => { if (controller.hasPendingWork()) { event.preventDefault(); event.returnValue = ''; } });
}
if (typeof document !== 'undefined') boot();
