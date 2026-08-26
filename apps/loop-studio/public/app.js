/* Camus Loop Studio front-end. No framework: one SSE stream in, DOM out.
   Loaded as an ES module (see index.html) so the pure banner policy is one
   shared file, importable here and by verify.test.mjs alike. */

import { comparisonBanner, doneBanner } from './banner.mjs';
import { effectiveStanding, runStory, standingPill, standingExplanation, recoveryPill } from './story.mjs';
import { groupRuns, armFacts, comparisonNote, shortHash } from './grouping.mjs';
import { gatePhaseStrip, gateRoundFact } from './gate-phase-policy.mjs';
import { verifySummary } from './run-ui-policy.mjs';
import { buildGateTerminalStage, documentActionsForLane, enginePillText, gateReportJson, lineageTrust, offersBuildRecovery, recoveryAction, replayRecoveryKind, terminalBannerClass, terminalFailureBanner } from './run-ui-policy.mjs';

// CAMUS_CONTROL: studio.qualification.explicit_consent

// Hosted-UI mode: when this page is served from a public origin, ?api=
// points it at the local studio server (persisted after the first visit).
// Same-origin (the normal local case) leaves API empty.
const API = (() => {
  const param = new URLSearchParams(location.search).get('api');
  if (param) localStorage.setItem('cls-api', param.replace(/\/$/, ''));
  const stored = localStorage.getItem('cls-api');
  if (stored) return stored;
  // Served from a public origin (camus.sh/studio): default to the local
  // studio server — the boot check says so plainly when it isn't running.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return local ? '' : 'http://localhost:1913';
})();

const $ = (id) => document.getElementById(id);
// Per-session capability token: /api/status hands it only to pages the
// browser allows to read it; every POST must carry it.
let TOKEN = '';
const postHeaders = () => ({ 'content-type': 'application/json', 'x-studio-token': TOKEN });
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------------------
// Minimal markdown renderer (escape first, then transform)
// ---------------------------------------------------------------------------

// Escapes run BEFORE any markup is built, so text can't break out of tags —
// and quotes are included so regex-matched URLs can't break out of href="…".
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s) {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<!\()\b(https?:\/\/[^\s<>)"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(H?\d+)\]/g, '<span class="cite">[$1]</span>');
}

function renderMd(md) {
  const lines = esc(md).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  let inCode = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) {
      flushPara(); flushList();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(raw); continue; }

    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    const oli = line.match(/^\s*(\d+)[.)]\s+(.*)/);

    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr/>'); }
    else if (line.startsWith('&gt;')) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.slice(4).trim())}</blockquote>`); }
    else if (li) { flushPara(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (oli) { flushPara(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(oli[2])}</li>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else para.push(line.trim());
  }
  flushPara(); flushList();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// The goal can be a paragraph. Show two lines, mark it clickable only when
// there is genuinely more to see, and let click or Enter open the rest.
function markGoalClamp() {
  const el = $('rungoal');
  if (!el.clientHeight) return;           // still hidden: nothing to measure yet
  if (el.classList.contains('open')) return;
  const truncated = el.scrollHeight - el.clientHeight > 1;
  el.classList.toggle('clamped', truncated);
  el.title = truncated ? 'Show the whole goal' : '';
}

// The run view is hidden when the goal is written, so measuring there reports
// zero for both heights and the affordance never appears. Observe instead: the
// callback fires when the element is actually laid out, and again on resize.
new ResizeObserver(markGoalClamp).observe($('rungoal'));

function setRunGoal(text) {
  const el = $('rungoal');
  el.textContent = text;
  el.dataset.goal = text;
  el.classList.remove('open');
  el.setAttribute('aria-expanded', 'false');
  markGoalClamp();
}

function toggleRunGoal() {
  const el = $('rungoal');
  if (!el.classList.contains('clamped')) return;
  const open = el.classList.toggle('open');
  el.setAttribute('aria-expanded', String(open));
  el.title = open ? 'Collapse the goal' : 'Show the whole goal';
}

const state = {
  lane: 'research_memo',
  // Depth is a run preference, set from Settings and remembered locally. It is
  // not part of the model decision record (checks/models.json).
  depth: ['quick', 'standard'].includes(localStorage.getItem('cls-depth')) ? localStorage.getItem('cls-depth') : 'quick',
  runId: null,
  es: null,
  revs: [],
  selectedRev: null,
  followRev: true,
  timerStart: null,
  timerHandle: null,
  stageEls: new Map(),
  reviewRounds: 0,
  sessionCount: 0,
};

function reflectEnginePill() {
  if (!state.serverEngine || !state.serverModels) return;
  $('pill-engine').textContent = enginePillText({
    engine: state.serverEngine,
    lane: state.lane,
    models: state.serverModels,
  });
}

function reflectDocumentActions(lane) {
  const actions = documentActionsForLane(lane);
  $('copy').classList.toggle('hidden', !actions.copyMarkdown);
  $('download').classList.toggle('hidden', !actions.downloadMarkdown);
}

function reflectLaneControls() {
  const build = state.lane === 'build';
  $('step-pairing-label').innerHTML = `<span class="step-n">3</span> ${build ? 'Review the Build gate, then run' : 'Choose maker and auditor, then run'}`;
  $('build-gate-note').classList.toggle('hidden', !build);
  if (build && state.serverModels) {
    $('build-gate-note').textContent = `Build gate: Claude ${state.serverModels.maker} implements → Codex ${state.serverModels.reviewer} reviews at the saved effort${state.serverModels.effort ? ` (${state.serverModels.effort})` : ''} every round — the value pinned in Settings, not adapted per round; the receipt records what actually ran. Change the saved models and effort in Settings.`;
  }
}

// Panel race control. panelIntent = the panel the USER last asked for
// ('setup' | 'settings' | null). userTouchedPanels distinguishes "never
// interacted" from "explicitly closed" — a null intent alone is ambiguous, and
// boot()'s auto-surface must fire only in the former. panelGen is a generation
// counter bumped on every user panel action: an async open captures it and bails
// if it changed, so a late response can never reopen a panel the user has since
// closed, switched, or reopened.
let panelIntent = null;
let userTouchedPanels = false;
let panelGen = 0;
function requestPanel(which) { // a user panel action; returns the new generation
  userTouchedPanels = true;
  panelIntent = which;
  return ++panelGen;
}

const STAGE_DEFS = {
  words: [
    ['plan', 'Plan'],
    ['ground', 'Ground'],
    ['make', 'Draft'],
    ['review', 'Review'],
    ['fix', 'Fix'],
    ['verify', 'Verify'],
    ['ship', 'Ship'],
  ],
  build: [
    ['gate', 'Gate'],
    ['review', 'Review'],
    ['ship', 'Ship'],
  ],
  // A verification-only recovery runs one phase. Not Gate, not Review, not Ship:
  // the candidate was already built and already reviewed by the source run.
  verify_recovery: [
    ['verify', 'Verify'],
  ],
  audit: [
    ['review', 'Re-audit'],
    ['ship', 'Receipt'],
  ],
  comparison: [
    ['ground', 'Freeze knowledge'],
    ['arms', 'Run arms'],
    ['ship', 'Seal experiment'],
  ],
};

// ---------------------------------------------------------------------------
// Launch view
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const s = await (await fetch(`${API}/api/status`)).json();
    state.serverEngine = s.engine;
    state.advisoryAcceptanceChars = s.advisoryAcceptanceChars ?? 2000;
    state.serverModels = s.models;
    TOKEN = s.token || '';
    const eng = $('pill-engine');
    reflectEnginePill();
    reflectLaneControls();
    eng.classList.add(s.engine === 'mock' ? 'warn' : 'ok');
    const hm = $('pill-hivemind');
    hm.textContent = !s.hivemind.connected
      ? 'hivemind: not connected'
      : s.hivemind.mode === 'claude'
        ? 'hivemind: via Claude MCP (no key)'
        : `hivemind: connected (${s.hivemind.mode})`;
    hm.classList.add(s.hivemind.connected ? 'ok' : 'warn');
    if (!s.hivemind.connected) {
      $('ground').disabled = true;
      $('ground-hint').textContent = 'Hivemind is Myosin’s private research knowledge (on staging today). To ground drafts in it: set HIVEMIND_VIA_CLAUDE=1 for Claude’s own connector, or HIVEMIND_MCP_URL + HIVEMIND_API_KEY. Setup has the details.';
    } else {
      $('ground').checked = true;
      $('ground-hint').textContent = s.hivemind.mode === 'claude'
        ? `Hivemind available: Claude can query ${s.hivemind.base} on its own connector auth; each run records whether it actually did.`
        : `Grounded in Hivemind: knowledge_search via ${s.hivemind.mode} at ${s.hivemind.base}.`;
    }
    const buildLane = $('lane-build');
    if (buildLane && s.gate && !s.gate.installed) {
      buildLane.classList.add('disabled');
      buildLane.title = 'The camus gate is not installed. Setup has the fix.';
    }
    if (s.engine !== 'mock') {
      // Live engine: quietly check the machine and surface the setup panel
      // only when something is actually missing. The same doctor pass feeds
      // the auth preflight chips — visible before a run spends anything.
      $('pill-claude-auth').classList.remove('hidden');
      $('pill-codex-auth').classList.remove('hidden');
      fetch(`${API}/api/doctor`).then((r) => r.json()).then((report) => {
        // Auto-surface only when the user has NEVER touched a panel — boot() also
        // runs after Save, and a user who opened then closed Setup during this
        // request left panelIntent null but userTouchedPanels true, so a null
        // intent alone must not reopen it.
        if (!report.ok && !userTouchedPanels) { panelIntent = 'setup'; renderSetup(report); }
        renderAuthPreflight(report);
      }).catch(() => renderAuthPreflight(null));
    }
  } catch {
    // Not cosmetic in hosted-UI mode: an unreachable local server is the
    // FIRST-RUN state — turn it into onboarding instead of a dead end.
    $('pill-engine').textContent = 'studio: not running on this machine yet';
    $('pill-engine').classList.add('warn');
    $('pill-hivemind').textContent = API ? `this page connects to ${API}` : 'local server';
    $('ground').disabled = true;
    renderInstall();
  }
  loadRecents();
}

// Auth preflight chips (live engine): the doctor's tri-state judgement,
// verbatim — signed in / not signed in / unknown. The chip never invents a
// green: a probe that could not run reads "unknown", and even a signed-in
// probe only proves a STORED session (a stale one can 401 at inference — the
// run stream stays the authoritative signal; the tooltip says so). The Build
// lane's target block gets a warning line when a CLI is PROVEN signed out,
// because that run will fail at the maker or the review — a warning, not a
// gate: the probes can be stale in either direction, so Run stays enabled.
function renderAuthPreflight(report) {
  const checkOf = (id) => report?.checks?.find((c) => c.id === id) ?? null;
  const probeName = { claude: 'claude auth status', codex: 'codex login status' };
  const signedOut = [];
  for (const id of ['claude', 'codex']) {
    const pill = $(`pill-${id}-auth`);
    if (!pill) continue;
    const check = checkOf(id);
    const auth = check ? check.auth : null;
    pill.textContent = `${id}: ${auth === true ? 'signed in' : auth === false ? 'not signed in' : 'unknown'}`;
    pill.classList.remove('ok', 'warn', 'bad');
    pill.classList.add(auth === true ? 'ok' : auth === false ? 'bad' : 'warn');
    pill.title = auth === true
      ? `Spend-free probe (${probeName[id]}): a session is stored. A stale session can still fail at inference; the run stream is the authoritative signal.`
      : auth === false
        ? `${check?.detail || 'Not signed in.'}${check?.fix ? ` Fix: ${check.fix}` : ''}`
        : (check?.detail || `Could not verify (${probeName[id]} did not answer). Setup has the details.`);
    if (auth === false) signedOut.push(id);
  }
  const note = $('preflight-note');
  if (!note) return;
  if (signedOut.length) {
    note.classList.remove('hidden');
    note.textContent = `Preflight: ${signedOut.join(' and ')} ${signedOut.length > 1 ? 'are' : 'is'} not signed in. A live gate run will fail at ${signedOut.includes('claude') ? 'the maker' : 'the review'}. Sign in first (fixes in Setup).`;
  } else {
    note.classList.add('hidden');
    note.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Install panel — shown when no local studio answers. Two paths: hand the
// setup to Claude Code with one copied prompt, or paste three commands.
// Auto-retries so the page springs to life the moment the server is up.
// ---------------------------------------------------------------------------

const CLAUDE_SETUP_PROMPT = `Set up Camus Loop Studio on my machine and start it:

1. If ~/camus does not exist: git clone --depth 1 https://github.com/mateodaza/camus.git ~/camus. Otherwise run git -C ~/camus pull.
2. Start the studio server and keep it running: node ~/camus/apps/loop-studio/server.mjs (it listens on http://localhost:1913).
3. Run node ~/camus/apps/loop-studio/server.mjs --doctor and fix anything it flags; it prints the exact commands (the Claude Code CLI and the Codex CLI must be installed and signed in once each).
4. When http://localhost:1913/api/status answers, tell me; the page at camus.sh/studio connects to it automatically.`;

const MANUAL_SETUP = `git clone --depth 1 https://github.com/mateodaza/camus.git ~/camus
node ~/camus/apps/loop-studio/server.mjs`;

let installRetry = null;

function copyButton(label, text) {
  const b = el('button', 'primary', label);
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed. Select it yourself.';
    }
    setTimeout(() => (b.textContent = label), 1600);
  };
  return b;
}

function renderInstall() {
  const box = $('setup-panel');
  box.innerHTML = '';

  box.appendChild(el('div', 'lbl', 'Get it running'));
  box.appendChild(el('p', 'install-note',
    'The studio runs on your machine; this page is only the glass. The hosted page never receives your credentials — the local server signs in to Claude, Codex, and Hivemind directly with your own logins.'));

  // Path 1: let Claude do it
  box.appendChild(el('div', 's-label install-head', 'Have Claude set it up'));
  box.appendChild(el('p', 'install-note', 'Copy this prompt into Claude Code (or the Claude app with terminal access) and it will install, start, and check everything:'));
  const promptPre = el('pre', 'install-block', CLAUDE_SETUP_PROMPT);
  box.appendChild(promptPre);
  box.appendChild(copyButton('Copy the prompt for Claude', CLAUDE_SETUP_PROMPT));

  // Path 2: by hand
  box.appendChild(el('div', 's-label install-head', 'Or run it yourself'));
  const cmdPre = el('pre', 'install-block', MANUAL_SETUP);
  box.appendChild(cmdPre);
  const row = el('div', 'panel-actions');
  row.appendChild(copyButton('Copy the commands', MANUAL_SETUP));
  row.appendChild(el('span', 'hint', 'needs Node ≥ 18. The in-page setup checks guide the rest once the server is up.'));
  box.appendChild(row);

  // The waiting line: this page keeps knocking until the server answers.
  const wait = el('div', 'install-wait');
  wait.appendChild(el('span', 'dot'));
  wait.appendChild(el('span', null, `waiting for the studio at ${API || 'http://localhost:1913'}. It connects by itself once the server answers; then you brief a goal and pick a lane below.`));
  box.appendChild(wait);

  setPanel('setup');

  clearInterval(installRetry);
  installRetry = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/status`);
      if (!res.ok) return;
      clearInterval(installRetry);
      setPanel(null);
      $('pill-engine').className = 'pill';
      $('pill-hivemind').className = 'pill';
      boot();
    } catch { /* keep knocking */ }
  }, 4000);
}

async function loadRecents() {
  try {
    const { runs } = await (await fetch(`${API}/api/runs`)).json();
    const box = $('recents');
    box.innerHTML = '';
    if (!runs.length) return;
    box.appendChild(el('h3', null, 'Recent runs'));
    // One label per row. A status pill AND a headline tag side by side made every
    // row ask the reader to reconcile two vocabularies; the derived standing
    // wins, and a row without one shows the loop's claim marked as a claim
    // rather than silently reading like a verdict.
    const recentRow = (r) => {
      const b = el('button', 'recent');
      const presentation = standingPill(r.status, r.headline);
      const pill = el('span', `pill ${presentation.className}`, presentation.label);
      pill.title = presentation.derived
        ? `Standing derived from the sealed receipt. The loop reported “${r.status.replace(/_/g, ' ')}”.`
        : presentation.claim
          ? 'Reported by the loop; no derived standing on this receipt.'
          : 'Current operational state; no terminal standing exists yet.';
      b.appendChild(pill);
      b.appendChild(el('span', 'g', r.goal));
      b.appendChild(el('span', 'mono muted', new Date(r.startedAt).toLocaleTimeString()));
      b.onclick = () => attach(r.id, r.goal);
      return b;
    };
    for (const entry of groupRuns(runs)) {
      box.appendChild(entry.kind === 'run' ? recentRow(entry.run) : auditComparisonCard(entry));
    }
  } catch { /* cosmetic */ }
}

// Audit replays of ONE artifact, shown as arms of a single comparison. The
// artifact hash is the grouping authority, so the card can state plainly that
// the arms judged identical bytes. It records the difference and stops there:
// no winner, no "high effort is better", because two runs are not a sample.
function auditComparisonCard(entry) {
  const card = el('div', 'audit-compare');
  const head = el('div', 'audit-compare-head');
  head.appendChild(el('span', 'trust-title', 'AUDIT COMPARISON'));
  head.appendChild(el('span', 'mono muted', `artifact ${shortHash(entry.artifactId)} · ${entry.arms.length} audit attempts on identical bytes`));
  card.appendChild(head);

  for (const arm of entry.arms) {
    const facts = armFacts(arm);
    const row = el('button', 'audit-arm');
    const presentation = standingPill(arm.status, arm.headline);
    row.appendChild(el('span', `pill ${presentation.className}`, presentation.label));
    row.appendChild(el('span', 'arm-effort', `requested ${facts.effortRequested}`));
    const cells = [
      facts.effortActual === 'not reported' ? 'actual not reported' : `actual ${facts.effortActual}`,
      facts.auditorActual ? `auditor ${facts.auditorActual}` : 'auditor not recorded',
      facts.findings === null ? 'findings not recorded' : `${facts.findings} finding${facts.findings === 1 ? '' : 's'}`,
      facts.outputTokens === null ? 'tokens not recorded' : `${facts.outputTokens.toLocaleString()} out`,
      facts.durationSeconds === null ? 'duration not recorded' : `${facts.durationSeconds}s`,
      facts.receipt ?? 'no receipt',
    ];
    row.appendChild(el('span', 'mono muted arm-facts', cells.join(' · ')));
    row.title = facts.receipt ? 'Open this receipt' : 'Open this audit trace';
    row.onclick = () => attach(arm.id, arm.goal);
    card.appendChild(row);
  }

  card.appendChild(el('div', 'audit-compare-note', comparisonNote(entry.arms)));
  return card;
}

// ---------------------------------------------------------------------------
// Setup panel — the doctor, rendered for people who don't debug PATHs
// ---------------------------------------------------------------------------

function renderSetup(report) {
  const box = $('setup-panel');
  box.innerHTML = '';
  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'lbl', report.ok ? 'Setup: this machine is ready. Brief a goal below.' : 'Setup: a few pieces are missing'));
  const again = el('button', 'ghost', 'Check again');
  again.onclick = () => openSetup(false);
  head.appendChild(again);
  const deep = el('button', 'ghost', 'Run deep checks (may spend tokens)');
  deep.onclick = () => openSetup(true);
  head.appendChild(deep);
  box.appendChild(head);
  for (const c of report.checks) {
    // A red ✕ means "this blocks you". Advisory rows (reported, not usable) and
    // absent OPTIONAL pieces are neither broken nor ready, so they read neutral —
    // otherwise "this machine is ready" sits above what looks like an error.
    const state = c.advisory || (c.optional && !c.ok) ? 'info' : c.ok ? 'ok' : 'miss';
    const row = el('div', `setup-row ${state}`);
    row.appendChild(el('span', 'ic', state === 'info' ? '·' : state === 'ok' ? '✓' : '✕'));
    row.appendChild(el('span', 's-label', c.label));
    row.appendChild(el('span', 's-detail', c.detail));
    box.appendChild(row);
    if (!c.ok && c.fix) {
      const fix = el('div', 'setup-fix');
      const code = el('code', null, c.fix);
      fix.appendChild(code);
      box.appendChild(fix);
    }
  }
  setPanel('setup');
}

async function openSetup(deep) {
  const gen = panelGen; // whatever the caller's user action set this to
  const stale = () => gen !== panelGen || panelIntent !== 'setup';
  try {
    // Deep qualification spends real tokens and writes receipts, so it is an
    // authorized POST carrying the session token; the shallow read stays a GET.
    const report = await (await (deep
      ? fetch(`${API}/api/doctor`, { method: 'POST', headers: postHeaders(), body: JSON.stringify({ deep: true }) })
      : fetch(`${API}/api/doctor`))).json();
    if (stale()) return; // the user switched, closed, or reopened while the deep check ran
    renderSetup(report);
  } catch {
    if (stale()) return;
    $('setup-panel').innerHTML = '';
    $('setup-panel').appendChild(el('div', 's-detail', 'The studio server is unreachable, so setup cannot be checked. Start it with: node server.mjs'));
    setPanel('setup');
  }
}

// One panel at a time, open INSTANTLY, and the button says which one is live.
// The old toggles waited for the doctor's slow connector probe before showing
// anything (a long blank pause that read as broken) and let both panels stack.
function setPanel(which) { // 'setup' | 'settings' | null
  for (const name of ['setup', 'settings']) {
    const open = which === name;
    $(`${name}-panel`).classList.toggle('hidden', !open);
    $(`open-${name}`).classList.toggle('active', open);
    $(`open-${name}`).setAttribute('aria-expanded', String(open));
  }
}

$('open-setup').addEventListener('click', () => {
  if (!$('setup-panel').classList.contains('hidden')) { requestPanel(null); setPanel(null); return; }
  requestPanel('setup');
  setPanel('setup');
  // Instant feedback, then the network-free report. Provider-backed checks are
  // a separate, plainly labelled click because they can spend tokens.
  const box = $('setup-panel');
  box.innerHTML = '';
  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'lbl', 'Setup'));
  box.appendChild(head);
  const wait = el('div', 'install-wait');
  wait.appendChild(el('span', 'dot'));
  wait.appendChild(el('span', null, 'checking this machine: CLI versions, sign-in, and local configuration…'));
  box.appendChild(wait);
  openSetup(false);
});

// ---------------------------------------------------------------------------
// Settings panel — the decision record, editable
// ---------------------------------------------------------------------------

// A <select> filled from the server's catalog: the machine's real options,
// with the current decision always selectable. (Compare & Learn still uses
// this legacy string shape; seat pickers use fillSeatPicker below.)
function fillPicker(sel, options, current) {
  sel.innerHTML = '';
  const list = options.includes(current) ? options : [current, ...options];
  for (const value of list) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = value;
    sel.appendChild(o);
  }
  sel.value = current;
}

// Seat pickers offer { backend, provider, model } entries from the server's
// seat catalog, grouped by backend. Option values are JSON so no separator
// can collide with a model name. Returns whether `current` was offerable —
// an unoffered current decision is NEVER injected as a selectable option.
function fillSeatPicker(sel, entries, current) {
  sel.innerHTML = '';
  const groups = new Map();
  for (const e of entries ?? []) {
    if (!groups.has(e.backend)) {
      const g = document.createElement('optgroup');
      g.label = `${e.backend} (${e.provider})`;
      groups.set(e.backend, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = JSON.stringify([e.backend, e.model]);
    o.disabled = e.admission?.qualified === false;
    o.textContent = o.disabled
      ? `${e.model} — ${e.admission?.status ?? 'unprobed'}`
      : e.model;
    if (e.admission?.warning) o.title = e.admission.warning;
    groups.get(e.backend).appendChild(o);
  }
  const wanted = JSON.stringify([current?.backend, current?.model]);
  const offered = [...sel.options].some((o) => o.value === wanted && !o.disabled);
  const firstEnabled = [...sel.options].find((o) => !o.disabled);
  sel.value = offered ? wanted : (firstEnabled?.value ?? '');
  return offered;
}
const seatOf = (sel) => {
  try {
    const [backend, model] = JSON.parse(sel.value);
    return { backend, model };
  } catch { return null; }
};
const seatEntry = (entries, seat) => (entries ?? []).find((e) => e.backend === seat?.backend && e.model === seat?.model) ?? null;

// The effort request only exists where the reviewer backend honors the knob
// (codex today); elsewhere the field disables and says so, and the receipt
// records no fabricated tier.
function reflectEffortField(seats) {
  const entry = seatEntry(seats?.reviewer, seatOf($('set-reviewer')));
  const honors = entry?.effort === true;
  $('set-effort').disabled = !honors;
  $('set-effort-note').textContent = honors ? '' : 'this backend takes no effort request; the receipt records none';
}

function appendSeatBadges(parent, badges = []) {
  const wrap = el('span', 'seat-badges');
  for (const badge of badges) {
    const chip = el('span', `seat-badge ${badge.kind ?? ''}`, badge.label);
    wrap.appendChild(chip);
  }
  parent.appendChild(wrap);
}

async function qualificationStream(response, onProgress) {
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.error || response.statusText);
  }
  if (!String(response.headers.get('content-type') || '').includes('text/event-stream')) {
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  const consume = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'progress') onProgress(payload);
    else if (event === 'result') result = payload;
    else if (event === 'error') throw new Error(payload.error || 'qualification failed');
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const match = buffer.match(/\r?\n\r?\n/);
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + match[0].length);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!result) throw new Error('qualification stream ended without a terminal result');
  return result;
}

function renderQualificationCatalog(config) {
  const box = $('qualification-list');
  box.innerHTML = '';
  const entries = [
    ...(config.seats?.maker ?? []).map((entry) => ({ ...entry, seatKey: 'maker' })),
    ...(config.seats?.reviewer ?? []).map((entry) => ({ ...entry, seatKey: 'reviewer' })),
  ].filter((entry) => entry.admission?.state !== 'builtin');
  if (!entries.length) {
    box.appendChild(el('div', 'hint', 'No configurable backends are declared yet. Use a template below as a local configuration starter.'));
    return;
  }
  for (const entry of entries) {
    const row = el('div', 'qualification-row');
    const head = el('div', 'qualification-head');
    head.appendChild(el('strong', null, `${entry.backend}:${entry.model} · ${entry.seatKey}`));
    head.appendChild(el('span', `qualification-status ${entry.admission?.status ?? 'unprobed'}`, entry.admission?.status ?? 'unprobed'));
    appendSeatBadges(head, entry.presentation?.badges ?? []);
    row.appendChild(head);
    row.appendChild(el('div', 'qualification-reason', entry.admission?.warning ?? 'No qualification record.'));
    const capabilities = entry.admission?.capabilities;
    if (capabilities && typeof capabilities === 'object') {
      const checklist = el('div', 'capability-checklist');
      for (const [name, result] of Object.entries(capabilities)) {
        const status = result?.status ?? result?.state ?? 'unprobed';
        checklist.appendChild(el('span', `capability-chip ${status}`, `${name}: ${status}`));
      }
      row.appendChild(checklist);
    }
    if (entry.admission?.expiresAt) {
      row.appendChild(el('div', 'diagnostics-path', `qualification expires ${entry.admission.expiresAt}`));
    }
    if (entry.admission?.qualifiable) {
      const button = el('button', 'ghost', entry.admission.qualified ? 'Re-qualify' : 'Qualify');
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = 'Probing this tuple…';
        $('settings-note').textContent = 'Qualification can spend provider tokens. Running only the selected tuple.';
        let liveChecklist = row.querySelector('.capability-checklist');
        if (!liveChecklist) {
          liveChecklist = el('div', 'capability-checklist');
          row.insertBefore(liveChecklist, button);
        }
        const liveChips = new Map();
        const showProgress = ({ phase, status, detail }) => {
          let chip = liveChips.get(phase);
          if (!chip) {
            chip = el('span', 'capability-chip unprobed', phase);
            liveChips.set(phase, chip);
            liveChecklist.appendChild(chip);
          }
          chip.className = `capability-chip ${status}`;
          chip.textContent = `${phase}: ${status}`;
          chip.title = detail || '';
        };
        try {
          const response = await fetch(`${API}/api/qualifications`, {
            method: 'POST', headers: postHeaders(),
            body: JSON.stringify({ seat: entry.seatKey, backend: entry.backend, model: entry.model, stream: true }),
          });
          const result = await qualificationStream(response, showProgress);
          $('settings-note').textContent = result.qualified
            ? `${entry.backend}:${entry.model} qualified for ${entry.seatKey}.`
            : `${entry.backend}:${entry.model} did not qualify: ${result.reason}${result.missing?.length ? ` (${result.missing.join(', ')})` : ''}. Redacted local diagnostics: ${result.diagnosticsPath ?? 'not recorded'}.`;
          await loadSettingsConfig();
          await refreshPairing();
        } catch (error) {
          $('settings-note').textContent = `qualification failed: ${error.message}`;
          button.disabled = false;
          button.textContent = entry.admission.qualified ? 'Re-qualify' : 'Qualify';
        }
      };
      row.appendChild(button);
    }
    box.appendChild(row);
  }
}

function declarationPayload(template) {
  return {
    connections: { [template.connection.name]: structuredClone(template.connection.value) },
    backends: { [template.backend.name]: structuredClone(template.backend.value) },
  };
}

function renderConnectionPreview() {
  const preview = $('connection-preview');
  try {
    const payload = JSON.parse($('connection-json').value);
    const connectionRows = Object.entries(payload?.connections ?? {});
    const backendRows = Object.entries(payload?.backends ?? {});
    if (connectionRows.length !== 1 || backendRows.length !== 1) throw new Error('declare exactly one connection and one backend');
    const [[connectionName, connection]] = connectionRows;
    const [[backendName, backend]] = backendRows;
    const auth = backend?.auth?.kind === 'env'
      ? `credential env name: ${backend.auth.envVar || 'missing'}`
      : backend?.auth?.kind === 'none' ? 'credential: none' : 'credential mode: missing';
    preview.textContent = [
      `connection ${connectionName} · requested transport ${connection?.kind ?? 'missing'}`,
      `backend ${backendName} · protocol ${backend?.protocol ?? 'missing'} · models ${(backend?.models ?? []).join(', ') || 'missing'}`,
      `${auth} · origin declaration ${backend?.trainingOrg ?? 'missing'}/${backend?.modelFamily ?? 'missing'}`,
      'lineage tier: derived by the server after validation; never granted by this JSON',
    ].join('\n');
    preview.classList.remove('failed');
  } catch (error) {
    preview.textContent = `not ready: ${error.message}`;
    preview.classList.add('failed');
  }
}

function openConnectionEditor(template) {
  $('connection-editor-title').textContent = `CONNECT · ${template.label.toUpperCase()}`;
  $('connection-json').value = JSON.stringify(declarationPayload(template), null, 2);
  $('replace-connection').checked = false;
  $('connection-note').textContent = 'Saving is local and spend-free. Qualification is the later provider call.';
  $('connection-editor').classList.remove('hidden');
  renderConnectionPreview();
  $('connection-json').focus();
}

function renderProviderTemplates(config) {
  const box = $('provider-templates');
  box.innerHTML = '';
  for (const template of config.templates ?? []) {
    const row = el('div', 'template-row');
    const head = el('div', 'template-head');
    head.appendChild(el('strong', null, template.label));
    head.appendChild(el('span', 'qualification-status', `${template.transport} · ${template.protocol}`));
    row.appendChild(head);
    if (template.note) row.appendChild(el('div', 'template-note', template.note));
    const payload = declarationPayload(template);
    const pre = el('pre', null, JSON.stringify(payload, null, 2));
    row.appendChild(pre);
    const copy = el('button', 'ghost', 'Copy declaration JSON');
    copy.onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy declaration JSON'; }, 1500);
    };
    row.appendChild(copy);
    const configure = el('button', 'ghost', 'Configure & save');
    configure.onclick = () => openConnectionEditor(template);
    row.appendChild(configure);
    if (template.docsUrl) {
      const docs = document.createElement('a');
      docs.href = template.docsUrl;
      docs.target = '_blank';
      docs.rel = 'noreferrer';
      docs.textContent = 'provider docs';
      docs.className = 'ghost';
      row.appendChild(docs);
    }
    box.appendChild(row);
  }
  $('planned-protocols').textContent = (config.plannedProtocols ?? [])
    .map((protocol) => `${protocol.label}: planned, not selectable`)
    .join(' · ');
}

$('connection-json').addEventListener('input', renderConnectionPreview);
$('close-connection-editor').addEventListener('click', () => $('connection-editor').classList.add('hidden'));
$('save-connection').addEventListener('click', async () => {
  const button = $('save-connection');
  button.disabled = true;
  $('connection-note').textContent = 'validating and saving locally…';
  try {
    const payload = JSON.parse($('connection-json').value);
    const response = await fetch(`${API}/api/connections`, {
      method: 'POST', headers: postHeaders(),
      body: JSON.stringify({ ...payload, replace: $('replace-connection').checked }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    $('connection-note').textContent = result.note;
    await loadSettingsConfig();
    await refreshPairing();
  } catch (error) {
    $('connection-note').textContent = `not saved: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

function renderSettingsConfig(c) {
  state.seats = c.seats ?? { maker: [], reviewer: [] };
  const makerOffered = fillSeatPicker($('set-maker'), state.seats.maker, { backend: c.maker.backend, model: c.maker.model });
  const reviewerOffered = fillSeatPicker($('set-reviewer'), state.seats.reviewer, { backend: c.reviewer.backend, model: c.reviewer.model });
  if (c.reviewer.effort) $('set-effort').value = c.reviewer.effort;
  reflectEffortField(state.seats);
  $('set-reviewer').onchange = () => reflectEffortField(state.seats);
  $('set-roundcap').value = c.loop.roundCap;
  $('set-depth').value = state.depth;
  const notes = ['Settings save to local operator state under ~/.camus; tracked public defaults stay unchanged.'];
  if (c.envOverrides.length) notes.push(`${c.envOverrides.join(', ')} set in the environment. Env wins over these fields this session.`);
  if (!makerOffered) notes.push(`current maker "${c.maker.backend}:${c.maker.model}" is not admitted on this machine — qualify it or pick an enabled option to save.`);
  if (!reviewerOffered) notes.push(`current reviewer "${c.reviewer.backend}:${c.reviewer.model}" is not admitted on this machine — qualify it or pick an enabled option to save.`);
  if (c.seats?.reviewerSource === 'fallback') notes.push('the codex list is a default: codex has no model cache to read on this machine, so those entries are not CLI-verified.');
  $('settings-env').textContent = notes.join(' ');
  renderQualificationCatalog(c);
  renderProviderTemplates(c);
}

async function loadSettingsConfig() {
  const response = await fetch(`${API}/api/config`);
  if (!response.ok) throw new Error(`config returned ${response.status}`);
  const config = await response.json();
  renderSettingsConfig(config);
  return config;
}

async function openSettings() {
  const panel = $('settings-panel');
  if (!panel.classList.contains('hidden')) { requestPanel(null); setPanel(null); return; }
  const gen = requestPanel('settings');
  try {
    const c = await loadSettingsConfig();
    if (gen !== panelGen || panelIntent !== 'settings') return; // switched, closed, or reopened while config loaded
    $('settings-note').textContent = '';
    setPanel('settings');
  } catch {
    $('settings-note').textContent = 'server unreachable';
  }
}

$('open-settings').addEventListener('click', openSettings);

// The step-3 pairing is DECIDED here: pickers default to the standing decision
// record and refill whenever Settings changes it; a value the user changes
// rides the run request as an explicit per-run pairing (recorded source
// "run request"). Untouched pickers send nothing, so the standing record and
// its provenance stay the decision of record. Failure is explicit — a pairing
// nobody can read must not look like a choice.
let pairingDirty = false;
let pairingPresentationRequest = 0;
async function reflectPairingNote(prefix = '') {
  const maker = seatEntry(state.seats?.maker, seatOf($('pair-maker')));
  const reviewer = seatEntry(state.seats?.reviewer, seatOf($('pair-reviewer')));
  const note = $('pairing-note');
  if (!maker || !reviewer) {
    note.textContent = 'One model makes the work. A different one tries to break it.';
    return;
  }
  const request = ++pairingPresentationRequest;
  const query = new URLSearchParams({
    makerBackend: maker.backend,
    makerModel: maker.model,
    reviewerBackend: reviewer.backend,
    reviewerModel: reviewer.model,
  });
  try {
    const response = await fetch(`${API}/api/pairing-presentation?${query}`);
    if (!response.ok) throw new Error(`presentation returned ${response.status}`);
    const presentation = await response.json();
    if (request !== pairingPresentationRequest) return;
    note.innerHTML = '';
    if (prefix) note.appendChild(document.createTextNode(prefix));
    note.appendChild(el('span', null, presentation.note));
    const facts = el('div', 'pairing-presentation-facts');
    facts.appendChild(el('strong', null, 'Maker '));
    appendSeatBadges(facts, presentation.makerBadges ?? []);
    facts.appendChild(el('strong', null, 'Auditor '));
    appendSeatBadges(facts, presentation.reviewerBadges ?? []);
    note.appendChild(facts);
  } catch {
    if (request !== pairingPresentationRequest) return;
    note.textContent = `${prefix}Pairing presentation unavailable: the local Studio server could not author its standing.`;
  }
}
async function refreshPairing() {
  try {
    const res = await fetch(`${API}/api/config`);
    if (!res.ok) throw new Error(`config returned ${res.status}`);
    const c = await res.json();
    state.seats = c.seats ?? { maker: [], reviewer: [] };
    const makerOffered = fillSeatPicker($('pair-maker'), state.seats.maker, { backend: c.maker.backend, model: c.maker.model });
    const reviewerOffered = fillSeatPicker($('pair-reviewer'), state.seats.reviewer, { backend: c.reviewer.backend, model: c.reviewer.model });
    // When the standing decision is not offerable, the picker shows a real
    // offerable pairing instead — and that DISPLAYED pairing is what the run
    // request must carry. Leaving pairingDirty false here made the POST omit
    // it, so the server executed the hidden stale record while the form
    // showed something else (audit P1, 2026-08-04).
    pairingDirty = !makerOffered || !reviewerOffered;
    let prefix = '';
    if (pairingDirty) {
      const missing = [
        !makerOffered && `maker "${c.maker.backend}:${c.maker.model}"`,
        !reviewerOffered && `reviewer "${c.reviewer.backend}:${c.reviewer.model}"`,
      ].filter(Boolean).join(' and ');
      prefix = `The saved ${missing} is not admitted on this machine, so the run uses exactly the pairing shown here (recorded as a run request). `;
    }
    await reflectPairingNote(prefix);
  } catch {
    $('pairing-note').textContent = 'pairing unavailable: the local studio server is unreachable';
  }
}
for (const id of ['pair-maker', 'pair-reviewer']) {
  $(id).addEventListener('change', () => { pairingDirty = true; void reflectPairingNote(); });
}
$('pairing-change').addEventListener('click', openSettings);
$('jump-recents').addEventListener('click', () => {
  // Compute the target rather than scrollIntoView: that derives its position
  // from viewport height and silently no-ops where the height is degenerate.
  // Instant, not smooth — smooth-scroll has bitten this app before, it is what
  // reduced-motion users get regardless, and a jump should just arrive.
  const recents = $('recents');
  const top = recents.getBoundingClientRect().top + window.scrollY - 12;
  window.scrollTo(0, Math.max(0, top));
  // A visual jump must also move the keyboard/screen-reader position. The
  // section is programmatically focusable without entering the normal tab order.
  recents.focus({ preventScroll: true });
});
refreshPairing();

// Depth applies immediately (it is a preference, not a saved decision) and the
// launch form says what will run.
function reflectDepth() {
  const note = $('depth-note');
  if (note) note.textContent = `${state.depth === 'standard' ? 'Standard' : 'Quick'}, from Settings. Change it there; it applies to the next run.`;
}
$('set-depth').addEventListener('change', () => {
  state.depth = $('set-depth').value === 'standard' ? 'standard' : 'quick';
  localStorage.setItem('cls-depth', state.depth);
  reflectDepth();
});
reflectDepth();

$('save-settings').addEventListener('click', async () => {
  $('settings-note').textContent = 'saving…';
  try {
    const res = await fetch(`${API}/api/config`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({
        maker: seatOf($('set-maker')),
        reviewer: seatOf($('set-reviewer')),
        // A disabled effort field means the chosen backend takes no effort
        // request — sending one anyway would record a knob nobody can turn.
        effort: $('set-effort').disabled ? undefined : $('set-effort').value,
        roundCap: Number($('set-roundcap').value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    $('settings-note').textContent = data.note || 'saved locally. Applies from the next run.';
    boot(); // pills reflect the new decisions
    refreshPairing(); // step 3 must not keep showing the superseded pairing
  } catch (err) {
    $('settings-note').textContent = `not saved: ${err.message}`;
  }
});

$('lanes').addEventListener('click', (e) => {
  const btn = e.target.closest('.lane');
  if (!btn || btn.classList.contains('disabled')) return;
  state.lane = btn.dataset.lane;
  document.querySelectorAll('.lane').forEach((l) => l.classList.toggle('selected', l === btn));
  $('target-wrap').classList.toggle('hidden', state.lane !== 'build');
  // Build runs the gate inside the target repo and never runs a grounding
  // stage, so offering Hivemind there would promise something that cannot
  // happen. The request below sends false for the same reason. The seat
  // pickers hide too: the gate owns its own model decisions.
  $('ground-field').classList.toggle('hidden', state.lane === 'build');
  $('publish-field').classList.toggle('hidden', state.lane === 'build');
  if (state.lane === 'build') $('publish-artifact').checked = false;
  $('pairing').classList.toggle('hidden', state.lane === 'build');
  $('pairing-note').classList.toggle('hidden', state.lane === 'build');
  if (state.lane === 'build') $('compare-panel').classList.add('hidden');
  reflectEnginePill();
  reflectLaneControls();
});

$('rungoal').addEventListener('click', toggleRunGoal);
$('rungoal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRunGoal(); }
});

$('open-compare').addEventListener('click', async () => {
  const panel = $('compare-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  if (state.lane === 'build') {
    $('form-error').textContent = 'Compare & Learn currently runs research arms, not two repository mutations.';
    return;
  }
  $('compare-note').textContent = 'loading the frozen catalog…';
  $('start-compare').disabled = false;
  panel.classList.remove('hidden');
  try {
    const res = await fetch(`${API}/api/config`);
    if (!res.ok) throw new Error('model catalog unavailable');
    const config = await res.json();
    const makers = config.catalog?.maker ?? [];
    if (makers.length < 2) throw new Error('this machine exposes fewer than two executor models');
    const makerA = makers.includes(config.maker.model) ? config.maker.model : makers[0];
    const makerB = makers.find((model) => model !== makerA);
    fillPicker($('compare-maker-a'), makers, makerA);
    fillPicker($('compare-maker-b'), makers, makerB);
    const reviewer = config.catalog.reviewer.includes(config.reviewer.model) ? config.reviewer.model : config.catalog.reviewer[0];
    fillPicker($('compare-reviewer'), config.catalog.reviewer, reviewer);
    $('compare-effort').value = config.reviewer.effort;
    $('compare-note').textContent = config.catalog.reviewerSource === 'fallback'
      ? 'The reviewer catalog is a conservative fallback because Codex has no readable cache.'
      : 'The catalog is read from this machine and freezes when you start.';
    $('start-compare').textContent = state.serverEngine === 'mock' ? 'Rehearse the comparison' : 'Approve two single-pass arms';
  } catch (err) {
    $('compare-note').textContent = String(err.message || err);
    $('start-compare').disabled = true;
  }
});

// Trust-contract clauses. They APPEND rather than replace, so a brief can
// compose several, and the textarea stays the source of truth — a clause the
// user then edits or deletes is simply gone, and the chip re-arms.
$('contract-presets').addEventListener('click', (event) => {
  const chip = event.target.closest('.preset');
  if (!chip) return;
  const box = $('acceptance-contract');
  const clause = chip.dataset.clause;
  if (box.value.includes(clause)) return; // already demanded; adding it twice says nothing new
  const existing = box.value.trim();
  const joiner = existing && !/[.!?]$/.test(existing) ? '. ' : ' ';
  box.value = existing ? `${existing}${joiner}${clause}` : clause;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  syncPresetChips();
});

// A chip is spent only while its exact clause is present, so deleting the text
// brings the chip back rather than stranding it.
function syncPresetChips() {
  const value = $('acceptance-contract').value;
  for (const chip of document.querySelectorAll('#contract-presets .preset')) {
    const used = value.includes(chip.dataset.clause);
    chip.classList.toggle('used', used);
    chip.setAttribute('aria-disabled', String(used));
  }
}
$('acceptance-contract').addEventListener('input', syncPresetChips);

// A live counter with a soft note past the advisory length. It never blocks, and
// Studio never compresses a trust contract on the operator's behalf.
function reflectContractLength() {
  const box = $('contract-count');
  if (!box) return;
  const n = $('acceptance-contract').value.length;
  const advisory = state.advisoryAcceptanceChars ?? 2000;
  box.textContent = n === 0
    ? ''
    : n > advisory
      ? `${n.toLocaleString()} characters. Long contracts are accepted in full; a long one takes more reviewer context per round, so keep every clause load-bearing.`
      : `${n.toLocaleString()} characters.`;
}
$('acceptance-contract').addEventListener('input', reflectContractLength);
reflectContractLength();

$('start-compare').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  const acceptanceContract = $('acceptance-contract').value.trim();
  const makerModels = [$('compare-maker-a').value, $('compare-maker-b').value];
  $('form-error').textContent = '';
  if (makerModels[0] === makerModels[1]) {
    $('compare-note').textContent = 'Choose two distinct executor models.';
    return;
  }
  if (state.serverEngine !== 'mock' && !confirm('Run two single-pass executor/auditor arms? Each gets one draft and one review, with no repair. Knowledge and model decisions will freeze now.')) return;
  $('start-compare').disabled = true;
  $('compare-note').textContent = 'freezing the manifest…';
  try {
    const res = await fetch(`${API}/api/comparisons`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({
        goal,
        acceptanceContract,
        lane: state.lane,
        depth: state.depth,
        ground: $('ground').checked,
        makerModels,
        reviewer: $('compare-reviewer').value,
        reviewerEffort: $('compare-effort').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    attach(data.id, data.goal);
  } catch (err) {
    $('compare-note').textContent = String(err.message || err);
  } finally {
    $('start-compare').disabled = false;
  }
});

$('start').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  const acceptanceContract = $('acceptance-contract').value.trim();
  $('form-error').textContent = '';
  $('start').disabled = true;
  try {
    // A pairing rides the request whenever the DISPLAYED pairing differs from
    // the standing record — the user changed a picker, or the record was not
    // offerable and the picker substituted a real option. Untouched, offerable
    // pickers send nothing, leaving the record and its provenance in charge.
    // Build never sends one — the gate owns its own model decisions and the
    // server refuses an override.
    const pairMaker = seatOf($('pair-maker'));
    const pairReviewer = seatOf($('pair-reviewer'));
    const pairing = pairingDirty && state.lane !== 'build' && pairMaker && pairReviewer
      ? { maker: pairMaker, reviewer: pairReviewer }
      : undefined;
    const res = await fetch(`${API}/api/runs`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ goal, acceptanceContract, lane: state.lane, depth: state.depth, ground: state.lane !== 'build' && $('ground').checked, publish: state.lane !== 'build' && $('publish-artifact').checked, targetPath: state.lane === 'build' ? $('target-path').value : undefined,
        // Only the Build lane verifies a repository, so the command only rides
        // that lane's request; empty means "detect the stack".
        verifyCmd: state.lane === 'build' && $('verify-cmd').value.trim() ? $('verify-cmd').value.trim() : undefined,
        pairing }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    attach(data.id, goal);
  } catch (err) {
    $('form-error').textContent = String(err.message || err);
  } finally {
    $('start').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Run view
// ---------------------------------------------------------------------------

function attach(id, goal) {
  state.runId = id;
  state.currentReport = null;
  state.revs = [];
  state.sessionCount = 0;
  // Replay-ness belongs to the stream being opened, not to the page. Without this
  // reset, opening a finished receipt from disk and then hitting Resume left the NEW
  // live run's question cards inert and labelled "session has since ended" — the live
  // loop was waiting on an answer the UI had already disabled (run 20260806-145411-hy1w).
  // Only a `replay_start` event from THIS stream may turn it back on.
  state.replaying = false;
  state.replayPendingQuestion = null;
  state.continuation = null;   // the server's answer belongs to the stream that sent it
  // Gate progress belongs to the stream too. It is merged across events, so without this a new
  // run's first frames rendered the PREVIOUS run's phase until the gate stamped its own
  // (live run 20260806-164809-hiju).
  gateProgressState = {};
  $('session-pre').textContent = '';
  $('session-toggle').textContent = 'Show the model’s work';
  state.selectedRev = null;
  state.followRev = true;
  state.reviewRounds = 0;
  $('launch').classList.add('hidden');
  $('runview').classList.remove('hidden');
  setRunGoal(goal || id);
  $('run-cost').textContent = ''; // don't carry the previous run's spend
  $('run-timer').textContent = '0:00';
  $('stop').classList.remove('hidden');
  $('audit-replay').classList.add('hidden');
  $('toggle-run-story').classList.add('hidden');
  $('toggle-run-story').setAttribute('aria-expanded', 'false');
  $('toggle-run-story').textContent = 'Run summary';
  $('download-report').textContent = 'Evidence pack';
  state.runStartAt = null;
  $('feed').innerHTML = '';
  $('revtabs').innerHTML = '';
  $('doc').innerHTML = '<div class="doc-empty">The deliverable appears here as the loop drafts it.</div>';
  document.getElementById('run-story-card')?.remove(); // a prior run's story must never head a new one
  state.simulated = false;
  { const sb = $('sim-banner'); sb.classList.add('hidden'); sb.textContent = ''; }
  setStatus('running');
  buildStages();
  startTimer(Date.now());

  state.es?.close();
  const es = new EventSource(`${API}/api/runs/${id}/events`);
  state.es = es;
  state.sawTerminal = false;
  let opened = false;
  let failedRetries = 0;
  es.onopen = () => {
    failedRetries = 0;
    // SSE auto-reconnect replays the whole stream — rebuild instead of append.
    if (opened) {
      state.revs = [];
      state.selectedRev = null;
      state.followRev = true;
      $('feed').innerHTML = '';
      $('revtabs').innerHTML = '';
      buildStages();
    }
    opened = true;
  };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; } // only parse errors are skippable
    handle(ev); // a renderer bug should surface in the console, not vanish
  };
  es.onerror = () => {
    // Live stream ends → terminal status closed us already. Anything else is
    // a lost connection, and pretending the run is still ticking is a lie.
    if (state.sawTerminal || es.readyState === EventSource.CLOSED) return;
    failedRetries += 1;
    if (failedRetries >= 3) {
      es.close();
      stopTimer();
      setStatus('disconnected');
      feed(el('div', 'banner meh', 'LOST THE STUDIO SERVER. The page can no longer see the run; restart the server and reopen it from Recent runs.'));
    }
  };
}

function comparisonRecoveryControl() {
  const sub = el('span', 'sub');
  const resume = el('button', 'resume-btn', 'Recover sealed arms');
  resume.onclick = async () => {
    resume.disabled = true;
    resume.textContent = 'recovering…';
    try {
      const res = await fetch(`${API}/api/runs/${state.runId}/resume`, { method: 'POST', headers: postHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      attach(data.id, data.goal);
    } catch (err) {
      resume.disabled = false;
      resume.textContent = `couldn't recover: ${String(err.message).slice(0, 72)}`;
    }
  };
  sub.appendChild(resume);
  sub.appendChild(document.createTextNode(' Recovery reads sealed child reports and marks interrupted arms failed. It never reruns models or retrieval.'));
  return sub;
}

function buildRecoveryControl(status, continuation = state.continuation ?? null) {
  const sub = el('span', 'sub');
  // The server's continuation classification wins when it exists: the same answer the resume route
  // will act on, so the button can never promise a phase the server refuses (run 20260807-080214-p27e).
  const action = recoveryAction(status, continuation);
  // A REFUSAL IS NOT A BUTTON. When the server's classification says no continuation is safe
  // without a human look, rendering a clickable resume would promise an action the route will 409 —
  // the text carries the reason instead, and nothing is clickable.
  if (action.canResume === false) {
    sub.appendChild(el('span', 'recovery-refused', ` ${action.button}.`));
    sub.appendChild(document.createTextNode(action.note));
    return sub;
  }
  // The command is EDITABLE here because the case that needs it most is a run
  // whose verification could not run on this host — including runs that started
  // before this field existed. Relaunching to supply one would redo the plan and
  // implement work the parked candidate already holds, so recovery takes it
  // directly. Left empty, the saved command carries forward untouched.
  const field = el('label', 'recovery-verify');
  field.appendChild(document.createTextNode('verification command '));
  const input = el('input', 'recovery-verify-input');
  input.type = 'text';
  input.id = 'recovery-verify-cmd';
  input.placeholder = 'empty = keep the saved command (auto-detect if none)';
  if (state.runVerifyCmd) input.value = state.runVerifyCmd;
  field.appendChild(input);

  const resume = el('button', 'resume-btn', action.button);
  resume.onclick = async () => {
    resume.disabled = true;
    resume.textContent = action.mode === 'verify_only' ? 'verifying…' : 'resuming…';
    try {
      const override = input.value.trim();
      const res = await fetch(`${API}/api/runs/${state.runId}/resume`, {
        method: 'POST',
        headers: postHeaders(),
        body: JSON.stringify(override ? { verifyCmd: override } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      attach(data.id, $('rungoal').dataset.goal || $('rungoal').textContent);
    } catch (err) {
      resume.disabled = false;
      resume.textContent = `couldn't ${action.mode === 'verify_only' ? 'verify' : 'resume'}: ${String(err.message).slice(0, 60)}`;
    }
  };
  sub.appendChild(field);
  sub.appendChild(resume);
  sub.appendChild(document.createTextNode(action.note));
  return sub;
}

$('session-toggle').addEventListener('click', () => {
  if (state.recoveryOf) return;          // nothing to reveal; the label says why
  const box = $('session');
  const open = box.classList.toggle('hidden');
  if (!state.recoveryOf) $('session-toggle').textContent = open ? `Show the model’s work (${state.sessionCount})` : 'Hide the model’s work';
  if (!open) box.scrollTop = box.scrollHeight;
});

$('back').addEventListener('click', () => {
  state.es?.close();
  stopTimer();
  $('runview').classList.add('hidden');
  $('launch').classList.remove('hidden');
  loadRecents();
});

$('stop').addEventListener('click', async () => {
  if (!confirm('Stop this run?')) return;
  // A confirmed-destructive action must confirm it took effect.
  try {
    const res = await fetch(`${API}/api/runs/${state.runId}/stop`, { method: 'POST', headers: postHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Couldn't stop the run: ${data.error || res.statusText}. If it's live, it may still be running.`);
    }
  } catch (err) {
    alert(`Couldn't reach the studio server to stop the run (${err.message}). If it's live, it is still running.`);
  }
});

$('copy').addEventListener('click', async () => {
  const md = current();
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md.markdown);
    $('copy').textContent = 'Copied';
  } catch {
    $('copy').textContent = 'Copy failed';
  }
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});

$('download-report').addEventListener('click', async () => {
  try {
    const res = await fetch(`${API}/api/runs/${state.runId}/report`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const report = await res.json();
    const payload = report.lane === 'comparison' ? report.experiment : report.evidencePack;
    if (!payload) throw new Error(report.evidencePackError || 'this run has no sealed evidence artifact');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = report.lane === 'comparison' ? `comparison-${state.runId}.json` : `run-${state.runId}-evidence-pack.json`;
    link.click();
  } catch (err) {
    $('download-report').textContent = 'no report yet';
    setTimeout(() => ($('download-report').textContent = state.runLane === 'comparison' ? 'Experiment' : 'Evidence pack'), 1500);
  }
});

const shortId = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
async function renderComparisonReceipt() {
  const runId = state.runId;
  document.getElementById('evidence-pack-card')?.remove();
  let report = null;
  for (let attempt = 0; attempt < 20 && !report; attempt++) {
    const res = await fetch(`${API}/api/runs/${runId}/report`).catch(() => null);
    if (res?.ok) report = await res.json();
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!report?.experiment || state.runId !== runId) return;
  state.currentReport = report;
  const experiment = report.experiment;
  const card = el('div', 'trust-card');
  card.id = 'evidence-pack-card';
  card.appendChild(el('div', 'trust-title', 'SEALED COMPARISON EXPERIMENT'));
  const rows = [
    ['experiment', shortId(experiment.experiment_id)],
    ['status', experiment.outcome.status.replace(/_/g, ' ')],
    ['knowledge', `${shortId(experiment.knowledge.snapshot_id)} · ${experiment.knowledge.mode} · ${experiment.knowledge.item_count} item${experiment.knowledge.item_count === 1 ? '' : 's'}`],
    ['fallback', experiment.manifest.fallback_policy],
    ['shared reviewer', experiment.manifest.reviewer.resolved],
    ['reviewer effort', `${experiment.manifest.reviewer_effort.requested} (requested)`],
  ];
  for (const [key, value] of rows) {
    const row = el('div', 'trust-row');
    row.append(el('span', 'trust-key', key), el('span', 'trust-value', value));
    card.appendChild(row);
  }
  for (const arm of experiment.outcome.arms) {
    const planned = experiment.manifest.arms.find((item) => item.arm_id === arm.arm_id);
    const row = el('div', 'comparison-card');
    row.appendChild(el('div', 'arm-head', `${arm.arm_id} · ${planned?.executor.resolved ?? 'unknown executor'}`));
    const terminalLabel = arm.status === 'quality_floor_failed' ? 'finished' : arm.status.replace(/_/g, ' ');
    row.appendChild(el('div', 'arm-meta', `${terminalLabel} · quality floor ${arm.quality_floor} · artifact ${shortId(arm.artifact_id) || 'none'} · receipt ${shortId(arm.receipt_id) || 'none'}`));
    if (arm.run_id) {
      const open = el('button', 'ghost', arm.receipt_id ? 'Open arm receipt' : 'Open arm trace');
      open.onclick = () => attach(arm.run_id, `${arm.arm_id} · ${planned?.executor.resolved ?? ''}`);
      row.appendChild(open);
    }
    card.appendChild(row);
  }
  card.appendChild(el('div', 'trust-contract', `contract: ${experiment.acceptance_contract}`));
  feed(card);
  const heading = experiment.outcome.status === 'completed'
    ? 'Parallel execution complete'
    : experiment.outcome.status === 'stopped'
      ? 'Parallel execution stopped'
      : 'Parallel experiment sealed with infrastructure failure';
  $('doc').innerHTML = renderMd(`# ${heading}

Every arm received the same sealed goal, acceptance contract, model-catalog decision and knowledge snapshot. Live retrieval and publication were disabled inside the arms.

This slice records execution evidence only. It does **not** declare a winner. Blinded cross-arm judging and human disagreement handling are the next protocol step.`);
}

// Layer 1 of the disclosure stack: a completed-run story for someone who will
// never open a receipt. It starts collapsed so the deliverable remains the focus;
// the toolbar reveals it on demand. Layers 2 and 3 (evidence card, raw trail)
// stay exactly where they are. Every sentence is derived by story.mjs from the
// sealed receipt — nothing here is written for the demo.
function renderRunStory(report, standing) {
  document.getElementById('run-story-card')?.remove();
  const story = runStory(report, standing);
  const card = el('div', `story-card hidden ${story.degraded ? 'degraded' : ''}`);
  card.id = 'run-story-card';
  card.appendChild(el('div', 'story-headline', story.headline));
  const body = el('div', 'story-body');
  for (const line of story.sentences) body.appendChild(el('p', null, line));
  card.appendChild(body);

  // The bridge from layer 1 to layer 2: the standing is a derivation, so it owes
  // the reader the dimensions it came from — and, when the loop's own claim
  // disagrees with them, says so instead of quietly preferring one.
  const why = standingExplanation(report, standing);
  const toggle = el('button', 'story-why', 'Why this standing?');
  const detail = el('div', 'story-why-detail hidden');
  detail.id = 'story-why-detail';
  toggle.setAttribute('aria-controls', detail.id);
  toggle.setAttribute('aria-expanded', 'false');
  for (const line of why.lines) detail.appendChild(el('p', null, line));
  if (why.gateClaim) {
    detail.appendChild(el('p', 'story-why-claim', why.disagrees
      ? `The loop reported “${why.gateClaim.replace(/_/g, ' ')}”, which these dimensions do not support. The receipt is authoritative, not the claim.`
      : `The loop reported “${why.gateClaim.replace(/_/g, ' ')}”, consistent with the dimensions above.`));
  }
  if (why.disagrees) card.classList.add('degraded');
  toggle.onclick = () => {
    const hidden = detail.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!hidden));
    toggle.textContent = hidden ? 'Why this standing?' : 'Hide the derivation';
  };
  card.appendChild(toggle);
  card.appendChild(detail);

  const rail = el('div', 'story-rail');
  for (const { beat, state: beatState } of story.timeline) {
    const step = el('span', `story-beat ${beatState}`, beat);
    step.title = { done: 'happened', skipped: 'did not apply to this run', failed: 'happened and did not pass', unknown: 'the receipt cannot say' }[beatState];
    rail.appendChild(step);
  }
  card.appendChild(rail);
  const doc = document.querySelector('.doc-wrap');
  doc?.insertBefore(card, doc.firstChild);

  const storyToggle = $('toggle-run-story');
  storyToggle.classList.remove('hidden');
  storyToggle.setAttribute('aria-expanded', 'false');
  storyToggle.textContent = 'Run summary';
  storyToggle.onclick = () => {
    const hidden = card.classList.toggle('hidden');
    storyToggle.setAttribute('aria-expanded', String(!hidden));
    storyToggle.textContent = hidden ? 'Run summary' : 'Hide summary';
  };
}

async function renderEvidenceReceipt(standing) {
  const runId = state.runId;
  document.getElementById('evidence-pack-card')?.remove();
  let report = null;
  // The terminal event is emitted just before report.json is sealed. Replays
  // resolve immediately; live runs get a bounded wait instead of a false
  // "missing pack" flash.
  for (let attempt = 0; attempt < 15 && !report; attempt++) {
    const res = await fetch(`${API}/api/runs/${runId}/report`).catch(() => null);
    if (res?.ok) report = await res.json();
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!report || state.runId !== runId) return;
  state.currentReport = report;
  // SEALED LINEAGE ONLY. Everything recovery-specific below (and the pill/banner
  // re-render) reads the pack's session_log, never report.recoveryOf — that twin is
  // editable without changing receipt_id. Disagreement is surfaced, not smoothed.
  const lineage = lineageTrust(report.evidencePack, report.recoveryOf);
  state.sealedLineage = lineage.trusted ? lineage.sealed : null;
  state.lineageMismatch = lineage.mismatched.length ? lineage : null;
  if (state.sealedLineage) {
    setStatus(report.status, standing, report.statuses ?? null);
    // Same for the terminal banner: it was rendered before the seal existed.
    const tb = document.getElementById('terminal-banner');
    if (tb && !state.simulated && ['done', 'done_with_findings'].includes(tb.dataset.status)) {
      const rb = doneBanner(tb.dataset.status, tb.dataset.headline || undefined, report.statuses ?? null, state.sealedLineage);
      tb.className = `banner ${rb.cls}`;
      tb.firstChild ? (tb.firstChild.textContent = rb.label) : tb.appendChild(document.createTextNode(rb.label));
    }
  }
  renderRunStory(report, standing);
  if (state.lineageMismatch) {
    const warn = el('div', 'trust-card degraded');
    warn.appendChild(el('div', 'trust-title', 'RECOVERY LINEAGE DISAGREES WITH THE SEAL'));
    warn.appendChild(el('div', 'trust-error',
      `${state.lineageMismatch.reason}. The sealed receipt is authoritative and is what is shown; the unsealed report fields are NOT displayed. A receipt whose report fields have been edited should be treated as tampered.`));
    feed(warn);
  }
  const pack = report.evidencePack;
  const card = el('div', `trust-card ${pack ? '' : 'degraded'}`);
  card.id = 'evidence-pack-card';
  card.appendChild(el('div', 'trust-title', pack ? 'SEALED EVIDENCE PACK' : 'EVIDENCE PACK NOT SEALED'));
  if (!pack) {
    card.appendChild(el('div', 'trust-error', report.evidencePackError || 'The report does not contain a pack.'));
    feed(card);
    return;
  }
  const nice = (s) => String(s || 'unknown').replace(/_/g, ' ');
  const auditorEconomics = pack.economics.find((e) => e.role === 'auditor');
  const billing = [...new Set(pack.economics.map((e) => e.billing_mode))].join(' + ');
  const estimated = pack.economics.some((e) => typeof e.estimated_cost_usd === 'number')
    ? `$${pack.economics.reduce((n, e) => n + (e.estimated_cost_usd || 0), 0).toFixed(2)} estimated`
    : 'cost not estimated';
  const claimCounts = (pack.artifact.claims ?? []).reduce((n, c) => {
    n[c.decision] = (n[c.decision] || 0) + 1;
    return n;
  }, {});
  const coverageCounts = (pack.artifact.contract_coverage ?? []).reduce((n, c) => {
    n[c.decision] = (n[c.decision] || 0) + 1;
    return n;
  }, {});
  // A zero-model run has no seats and no economics to show. Rendering the seat rows
  // and a billing line for it implied model spend that never happened.
  const modelFree = pack.pairing.executor.actual === 'none:no-model-run'
    && pack.pairing.auditor.actual === 'none:no-model-run';
  const rows = [
    ['standing (derived)', nice(standing)],
    ['artifact', shortId(pack.artifact_id)],
    ['receipt', shortId(pack.receipt_id)],
    ...(modelFree
      ? [['models', 'none — no maker or auditor ran, and no model calls were made']]
      : [
          ['executor actual', pack.pairing.executor.actual],
          ['auditor actual', pack.pairing.auditor.actual],
          ['auditor effort', auditorEconomics?.effort ?? 'not recorded'],
        ]),
    ...(state.sealedLineage ? [
      ['recovered from', state.sealedLineage.sourceRunId ?? 'not recorded'],
      ['source receipt', state.sealedLineage.sourceReceiptId ? shortId(state.sealedLineage.sourceReceiptId) : `none linked (${state.sealedLineage.sourceReceiptStatus ?? 'not checked'})`],
      ['source audit', state.sealedLineage.sourceAudit ? nice(state.sealedLineage.sourceAudit) : 'none recorded — nothing here is independently reviewed'],
      ['candidate sha', state.sealedLineage.parkedSha ? String(state.sealedLineage.parkedSha).slice(0, 12) : 'not recorded'],
      ['sha provenance', nice(state.sealedLineage.shaProvenance)],
      ['lineage', 'read from the sealed receipt (session log), not the report fields'],
    ] : []),
    ...(pack.artifact.kind === 'research'
      ? [['claim ledger', `${claimCounts.supported || 0} supported · ${claimCounts.unsupported || 0} unsupported · ${claimCounts.unchecked || 0} unchecked`]]
      : []),
    ...(Array.isArray(pack.artifact.contract_coverage)
      ? [['contract coverage', `${coverageCounts.met || 0} met · ${coverageCounts.unmet || 0} unmet · ${coverageCounts.unclear || 0} unclear`]]
      : []),
    ...(modelFree ? [] : [['economics', `billing ${billing} · ${estimated}`]]),
    ...(report.experiment ? [
      ['experiment', shortId(report.experiment.experiment_id)],
      ['parent receipt', shortId(report.experiment.source.receipt_id)],
      ['effort requested', report.experiment.manifest.effort.requested],
      ['effort actual', report.experiment.outcome.effort_actual ?? 'not reported'],
      ['audit usage', (() => {
        const usage = report.experiment.outcome.usage;
        const tokens = [usage.input_tokens, usage.output_tokens].every((value) => Number.isInteger(value))
          ? `${usage.input_tokens} in · ${usage.output_tokens} out`
          : 'tokens not reported';
        const duration = Number.isInteger(usage.duration_ms) ? ` · ${(usage.duration_ms / 1000).toFixed(1)}s` : '';
        return `${tokens}${duration}`;
      })()],
    ] : []),
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'trust-row');
    row.appendChild(el('span', 'trust-key', k));
    row.appendChild(el('span', 'trust-value', v));
    card.appendChild(row);
  }
  card.appendChild(el('div', 'trust-contract', `contract: ${pack.acceptance_contract}`));
  if (!report.receiptsDegraded
      && pack.schemaVersion === 2
      && pack.artifact.kind === 'research'
      && Array.isArray(pack.artifact.contract_coverage)
      && (!report.simulated || state.serverEngine === 'mock')) {
    $('audit-replay').classList.remove('hidden');
    $('audit-replay').textContent = report.simulated ? 'Rehearse re-audit' : 'Re-audit';
  }
  feed(card);
}

$('audit-replay').addEventListener('click', async () => {
  const card = document.getElementById('evidence-pack-card');
  if (!card || !state.currentReport?.evidencePack) return;
  const existing = card.querySelector('.audit-form');
  if (existing) { existing.remove(); return; }

  const form = el('div', 'audit-form');
  form.appendChild(el('div', 'trust-title', 'AUDIT-ONLY REPLAY'));
  form.appendChild(el('div', 'audit-note', 'Same artifact and verification. A new reviewer decision mints a new receipt; no maker or retrieval runs.'));
  const controls = el('div', 'audit-controls');
  const reviewer = document.createElement('select');
  reviewer.setAttribute('aria-label', 'Replay reviewer model');
  const effort = document.createElement('select');
  effort.setAttribute('aria-label', 'Replay reviewer effort');
  for (const value of ['low', 'medium', 'high', 'xhigh']) {
    const option = document.createElement('option'); option.value = value; option.textContent = `${value} effort`; effort.appendChild(option);
  }
  const run = el('button', 'primary audit-run', 'Run re-audit');
  const note = el('div', 'audit-note');
  controls.append(reviewer, effort, run);
  form.append(controls, note);
  card.appendChild(form);

  try {
    const configRes = await fetch(`${API}/api/config`);
    if (!configRes.ok) throw new Error('model catalog unavailable');
    const config = await configRes.json();
    for (const model of config.catalog.reviewer) {
      const option = document.createElement('option'); option.value = model; option.textContent = model; reviewer.appendChild(option);
    }
    reviewer.value = config.catalog.reviewer.includes(config.reviewer.model)
      ? config.reviewer.model
      : config.catalog.reviewer[0];
    effort.value = config.reviewer.effort;
  } catch (err) {
    note.textContent = `Cannot load the reviewer catalog: ${err.message}`;
    run.disabled = true;
  }

  run.onclick = async () => {
    run.disabled = true;
    note.textContent = 'Freezing the catalog and starting the audit…';
    try {
      const response = await fetch(`${API}/api/runs/${state.runId}/audit`, {
        method: 'POST',
        headers: postHeaders(),
        body: JSON.stringify({ reviewer: reviewer.value, effort: effort.value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      attach(data.id, data.goal);
    } catch (err) {
      note.textContent = String(err.message || err);
      run.disabled = false;
    }
  };
});

$('download').addEventListener('click', () => {
  const md = current();
  if (!md) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md.markdown], { type: 'text/markdown' }));
  a.download = `deliverable-rev${md.rev}.md`;
  a.click();
});

function current() {
  return state.revs.find((r) => r.rev === state.selectedRev) ?? state.revs[state.revs.length - 1];
}

function buildStages(lane) {
  const nav = $('stages');
  nav.innerHTML = '';
  state.stageEls.clear();
  const defs = STAGE_DEFS[lane] ?? (lane === 'audit_replay' ? STAGE_DEFS.audit : STAGE_DEFS.words);
  for (const [key, label] of defs) {
    const s = el('div', 'stage');
    s.appendChild(el('span', 'dot'));
    s.appendChild(el('span', null, label));
    s.appendChild(el('span', 'badge'));
    nav.appendChild(s);
    state.stageEls.set(key, s);
  }
}

function setStage(name, status, extra = {}) {
  const s = state.stageEls.get(name);
  if (!s) return;
  s.classList.remove('active', 'done', 'fail');
  if (status === 'active') s.classList.add('active');
  if (status === 'done') s.classList.add(extra.pass === false ? 'fail' : 'done');
  const badge = s.querySelector('.badge');
  if (name === 'review' && extra.round) badge.textContent = `r${extra.round}`;
  if (name === 'verify' && extra.pass != null) badge.textContent = extra.pass ? 'green' : 'red';
  if (name === 'ground') {
    // Distinguish "nothing configured" (stub) from "configured but degraded".
    badge.textContent = extra.frozen
      ? `${extra.itemCount ?? 0} frozen`
      : extra.via === 'claude'
      ? `claude ${extra.queried ? '✓' : '✕'}`
      : extra.connected === false
        ? (extra.mode && extra.mode !== 'stub' ? `${extra.mode} ✕` : 'stub')
        : '';
  }
}

// One label, not two. While a run is live there is no standing yet, so the flat
// status IS the honest answer. At the end the receipt's derived standing
// replaces it — a run bar reading "done with findings" beside a card reading
// "Verified with findings" made the user arbitrate between two vocabularies for
// the same run. An unrecognised or underivable standing falls back to the flat
// claim and is MARKED as a claim, never dressed up as a verdict.
// GATE_PHASES + gatePhaseStrip are the pure, single-source phase-strip policy —
// extracted to ./gate-phase-policy.mjs so the ordering is unit-testable and
// cannot drift by hand (2026-08-05, WP6 dogfood: a durable "plan" phase, missing
// from the strip, rendered after the last step). See that module for the audit
// of which phases Studio actually observes and why Worktree/Commit/Land are not
// in the strip.
let gateProgressState = {};
function renderGateProgress(next) {
  gateProgressState = { ...gateProgressState, ...next };
  const s = gateProgressState;
  let box = $('gate-progress');
  if (!box) {
    box = el('div', 'comparison-card');
    box.id = 'gate-progress';
    feed(box);
  }
  box.innerHTML = '';
  box.appendChild(el('div', 'trust-title', 'GATE PROGRESS'));
  const strip = el('div', 'arm-meta');
  strip.textContent = gatePhaseStrip(s.phase);
  box.appendChild(strip);
  const facts = [];
  { const rf = gateRoundFact(s); if (rf) facts.push(rf); }
  if (s.makerModel) facts.push(`maker ${s.makerModel}`);
  if (s.reviewerModel) facts.push(`reviewer ${s.reviewerModel}${s.reviewerEffort ? ` · ${s.reviewerEffort}` : ''}`);
  if (s.worktree) facts.push(`worktree ${String(s.worktree).split('/').pop()}`);
  else if (s.worktreePrefix) facts.push(`worktree ${s.worktreePrefix}`);
  if (facts.length) box.appendChild(el('div', 'arm-meta', facts.join(' · ')));
  // Liveness, named: WHICH signal is keeping the run alive and how close the
  // watchdog is. A run killed for idleness should never be a surprise.
  if (Number.isFinite(s.idleMs)) {
    const secs = Math.round(s.idleMs / 1000);
    const budget = Math.round((s.idleKillMs ?? 0) / 60000);
    box.appendChild(el('div', 'arm-meta', `last activity ${secs}s ago (${s.lastActivitySource ?? 'unknown'}) · watchdog ${budget} min`));
  }
  if (s.asyncReattach?.awaiting) {
    box.appendChild(el('div', 'arm-meta', `re-attaching to the same workflow (${s.asyncReattach.turn}/${s.asyncReattach.of})`));
  }
  if (s.unboundRounds) {
    box.appendChild(el('div', 'arm-meta', `${s.unboundRounds} review round(s) came from a gate that does not bind receipts; reinstall the gate for bound provenance`));
  }
}

function setStatus(status, headline, dimensions = null) {
  const p = $('run-status');
  // A recovery's derived standing stays `unverified` (no audit in THIS receipt), but
  // the pill is operational text, not a standing claim — so it reports what happened
  // and points at where the review evidence lives.
  const presentation = recoveryPill(dimensions, state.sealedLineage) ?? standingPill(status, headline);
  p.className = `pill ${presentation.className}`;
  p.textContent = presentation.label;
  p.title = presentation.title ?? (presentation.derived
    ? `Standing derived from the sealed receipt. The loop itself reported “${status.replace(/_/g, ' ')}”.`
    : presentation.claim
      ? 'Reported by the loop; not corroborated by a derived standing.'
      : 'Current operational state; no terminal standing exists yet.');
}

function startTimer(t0) {
  state.timerStart = t0;
  stopTimer();
  state.timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - state.timerStart) / 1000);
    $('run-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}
function stopTimer() { clearInterval(state.timerHandle); }

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

function feed(node) {
  const f = $('feed');
  const stick = f.scrollHeight - f.scrollTop - f.clientHeight < 80;
  f.appendChild(node);
  if (stick) f.scrollTop = f.scrollHeight;
}

function handle(ev) {
  switch (ev.type) {
    case 'run':
      if (ev.run?.goal) setRunGoal(ev.run.goal);
      {
        const pairing = $('run-pairing-view');
        const view = ev.run?.pairingView;
        pairing.innerHTML = '';
        pairing.classList.toggle('hidden', !view);
        if (view) {
          pairing.appendChild(el('strong', null, 'Frozen pairing · '));
          pairing.appendChild(el('span', null, view.note));
          const facts = el('div', 'pairing-presentation-facts');
          facts.appendChild(el('strong', null, 'Maker '));
          appendSeatBadges(facts, view.makerBadges ?? []);
          facts.appendChild(el('strong', null, 'Auditor '));
          appendSeatBadges(facts, view.reviewerBadges ?? []);
          pairing.appendChild(facts);
        }
      }
      if (ev.at) { state.runStartAt = ev.at; startTimer(ev.at); }
      state.runLane = ev.run?.lane;
      reflectDocumentActions(state.runLane);
      state.runTargetPath = ev.run?.targetPath ?? null;
      // Legacy runs predate this field; undefined means "none was in force", which
      // is what the recovery control should show — never a guessed command.
      state.runVerifyCmd = ev.run?.verifyCmd ?? null;
      // A verification-only recovery has exactly ONE phase. Showing the Build
      // lane's Gate/Review/Ship rail would imply work this run must never do.
      state.recoveryOf = ev.run?.recoveryOf ?? null;
      // Deliberately NOT stored: the run event's unsealed `recovery` object. Lineage is
      // read from the sealed pack only (see lineageTrust), so the mutable twin is never
      // in client state to be rendered by accident.
      state.sealedLineage = null;
      state.lineageMismatch = null;
      if (state.recoveryOf) {
        // No maker, no reviewer, no model turn — so there is no model work to show.
        const toggle = $('session-toggle');
        toggle.textContent = 'No model calls in this recovery';
        toggle.disabled = true;
        toggle.classList.add('inert');
        $('session').classList.add('hidden');
      }
      state.simulated = ev.run?.engine === 'mock';
      if (state.simulated) {
        const sb = $('sim-banner');
        // Static literal — no user input — so innerHTML is safe here.
        sb.innerHTML = '<b>REHEARSAL: SIMULATED.</b> A scripted demo of the loop. No models run, your brief is not processed, your target files and repository are not changed, and no model spend occurs. Studio saves a local simulation trace under runs/; every draft, verdict, branch, commit, and gate receipt shown is scripted and is not evidence of real work.';
        sb.classList.remove('hidden');
        $('run-cost').textContent = 'rehearsal · no real spend';
      }
      buildStages(state.recoveryOf ? 'verify_recovery' : ev.run?.lane);
      if (!['build', 'comparison'].includes(ev.run?.lane) && ev.run && !ev.run.ground) state.stageEls.get('ground')?.remove();
      if (ev.run?.lane === 'build') $('doc').innerHTML = '<div class="doc-empty">The gate works inside the target repo. The session below is the live view; its report lands here.</div>';
      if (ev.run?.lane === 'comparison') {
        $('doc').innerHTML = '<div class="doc-empty">Each arm keeps its own artifact and receipt. Open an arm card as it finishes. Camus will not name a winner until the separate blinded-comparison step exists.</div>';
        $('download-report').textContent = 'Experiment';
      }
      break;

    case 'stage':
      setStage(ev.name, ev.status, ev);
      break;

    // The gate's live state. Studio used to show "Igniting…" for ten minutes
    // while the gate classified, planned, built a worktree, wrote files and
    // started reviewing (field report 2026-08-04). This row is replaced in
    // place, so it reads as status rather than a scrolling log.
    case 'gate_phase':
      renderGateProgress({ phase: ev.phase });
      break;
    case 'gate_progress':
      renderGateProgress(ev);
      break;

    case 'knowledge_snapshot': {
      const c = el('div', 'comparison-card');
      c.appendChild(el('div', 'trust-title', 'FROZEN KNOWLEDGE'));
      c.appendChild(el('div', 'arm-meta', `${shortId(ev.snapshotId)} · ${ev.mode} · ${ev.itemCount} item${ev.itemCount === 1 ? '' : 's'} · ${ev.privacy}`));
      feed(c);
      break;
    }

    case 'comparison_manifest': {
      const c = el('div', 'comparison-card');
      c.appendChild(el('div', 'trust-title', 'SEALED PARALLEL MANIFEST'));
      c.appendChild(el('div', 'arm-meta', `experiment ${shortId(ev.experimentId)} · snapshot ${shortId(ev.snapshotId)} · fallback ${ev.fallbackPolicy}`));
      c.appendChild(el('div', 'arm-meta', ev.arms.map((arm) => `${arm.arm_id}: ${arm.executor.resolved}`).join(' · ')));
      feed(c);
      break;
    }

    case 'comparison_arm': {
      let c = document.querySelector(`[data-arm-id="${ev.armId}"]`);
      if (!c) {
        c = el('div', 'comparison-card');
        c.dataset.armId = ev.armId;
        const head = el('div', 'arm-head');
        head.appendChild(el('strong', null, `${ev.armId} · ${ev.model}`));
        head.appendChild(el('span', `pill status ${ev.status}`, ev.status.replace(/_/g, ' ')));
        c.appendChild(head);
        c.appendChild(el('div', 'arm-meta'));
        feed(c);
      }
      const status = c.querySelector('.pill');
      status.className = `pill status ${ev.status}`;
      status.textContent = ev.status.replace(/_/g, ' ');
      const usage = ev.usage;
      const tokens = usage && Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens)
        ? `${usage.input_tokens} in · ${usage.output_tokens} out`
        : 'tokens not reported';
      c.querySelector('.arm-meta').textContent = ev.status === 'running'
        ? `run ${ev.runId} · exact model decision frozen · no fallback`
        : `quality floor ${ev.qualityFloor} · artifact ${shortId(ev.artifactId) || 'none'} · receipt ${shortId(ev.receiptId) || 'none'} · ${tokens}`;
      if (ev.runId && !c.querySelector('button')) {
        const terminalLabel = ev.artifactId && ev.receiptId ? 'Open artifact & receipt' : 'Open arm trace';
        const open = el('button', 'ghost', ev.status === 'running' ? 'Watch this arm' : terminalLabel);
        open.onclick = () => attach(ev.runId, `${ev.armId} · ${ev.model}`);
        c.appendChild(open);
      }
      if (c.querySelector('button') && ev.status !== 'running') c.querySelector('button').textContent = ev.artifactId && ev.receiptId ? 'Open artifact & receipt' : 'Open arm trace';
      break;
    }

    case 'log':
      feed(el('div', 'logline', ev.line));
      break;

    case 'session': {
      state.sessionCount += 1;
      const pre = $('session-pre');
      const glyph = ev.actor === 'reviewer' ? 'r' : ev.actor === 'gate' ? 'g' : 'm';
      pre.appendChild(el('span', 'sm', `${glyph} · `));
      pre.appendChild(document.createTextNode(`${ev.line}\n`));
      while (pre.childNodes.length > 800) pre.removeChild(pre.firstChild);
      const box = $('session');
      if (!box.classList.contains('hidden')) box.scrollTop = box.scrollHeight;
      if (!state.recoveryOf && box.classList.contains('hidden')) $('session-toggle').textContent = `Show the model’s work (${state.sessionCount})`;
      break;
    }

    case 'plan': {
      feed(el('div', 'plancard', ev.text));
      break;
    }

    case 'round':
      feed(el('div', 'verdict', `— review round ${ev.round} of ${ev.cap} —`));
      break;

    case 'finding': {
      const c = el('div', `fcard ${ev.severity}`);
      const h = el('div', 'fhead');
      h.appendChild(el('span', 'sev', ev.severity.toUpperCase()));
      h.appendChild(el('span', 'ftitle', ev.title));
      c.appendChild(h);
      c.appendChild(el('div', 'fbody', ev.detail));
      const fix = el('div', 'fix');
      fix.innerHTML = `<b>fix →</b> `;
      fix.appendChild(document.createTextNode(ev.suggestion));
      c.appendChild(fix);
      feed(c);
      break;
    }

    case 'review': {
      const clean = ev.verdict === 'APPROVED';
      const revise = ev.verdict === 'REVISE';
      const reviewName = ev.scope === 'closure'
        ? `closure audit on rev ${ev.rev}`
        : ev.scope === 'audit_replay'
          ? `audit-only replay on rev ${ev.rev}`
          : `reviewer verdict, round ${ev.round}`;
      const v = el('div', `verdict ${clean ? 'approved' : revise ? 'revise' : ''}`,
        clean
          ? `✓ ${reviewName}: clean`
          : revise
            ? `✗ ${reviewName}: revise (${ev.findings.filter((f) => f.severity !== 'low').length} blocking)`
            : `? ${reviewName}: unreadable; the receipt will be marked incomplete`);
      feed(v);
      break;
    }

    case 'replay_start':
      // Everything that follows came off disk from a process that is gone. Its question
      // cards cannot be answered — the session token died with that process — so they
      // render disabled rather than inviting a click that always fails.
      state.replaying = true;
      // The continuation classification rides HERE, not only on replay_end: the stored terminal
      // status event closes this EventSource and renders the recovery control immediately, so a
      // classification arriving after the stored lines never reaches the page (audit 2026-08-07).
      if (ev.continuation) state.continuation = ev.continuation;
      break;

    case 'question': {
      setStatus('needs_human');
      const c = el('div', 'qcard');
      c.dataset.qid = ev.id;
      c.appendChild(el('div', 'qlabel', 'THE LOOP IS ASKING YOU'));
      c.appendChild(el('div', 'qtext', ev.text));
      if (ev.options?.length) {
        const opts = el('div', 'qopts');
        for (const o of ev.options) {
          const b = el('button', null, o);
          if (state.replaying) { b.disabled = true; b.classList.add('inert'); }
          else b.onclick = () => answer(ev.id, o, c);
          opts.appendChild(b);
        }
        c.appendChild(opts);
        if (state.replaying) {
          state.replayPendingQuestion = ev.id;
          c.appendChild(el('div', 'qstale', 'This question was asked by a Studio session that has since ended, so it can no longer be answered here. Recover the parked candidate below instead.'));
        }
      } else {
        const ta = el('textarea');
        ta.rows = 2;
        ta.placeholder = 'Your call. One or two lines is enough.';
        ta.setAttribute('aria-label', 'Your answer to the loop');
        const send = el('button', 'send', 'Answer');
        if (state.replaying) { ta.disabled = true; send.disabled = true; send.classList.add('inert'); }
        else send.onclick = () => ta.value.trim() && answer(ev.id, ta.value.trim(), c);
        c.appendChild(ta);
        c.appendChild(send);
      }
      feed(c);
      break;
    }

    case 'question_answered': {
      const c = document.querySelector(`[data-qid="${ev.id}"]`);
      if (c && !c.classList.contains('answered')) markAnswered(c, '');
      setStatus('running');
      break;
    }

    case 'answer': {
      feed(el('div', 'logline', `human decided: ${ev.answer}`));
      const card = [...document.querySelectorAll('.qcard.answered')].reverse()
        .find((c) => !c.querySelector('.qanswer'));
      if (card) card.appendChild(el('div', 'qanswer', `answered: ${ev.answer}`));
      break;
    }

    case 'revision': {
      const existing = state.revs.find((r) => r.rev === ev.rev);
      if (existing) { existing.markdown = ev.markdown; renderRev(); break; }
      state.revs.push({ rev: ev.rev, markdown: ev.markdown });
      const tabs = $('revtabs');
      const b = el('button', null, `rev ${ev.rev}`);
      b.onclick = () => { state.selectedRev = ev.rev; state.followRev = ev.rev === state.revs[state.revs.length - 1].rev; renderRev(); };
      tabs.appendChild(b);
      if (state.followRev) state.selectedRev = ev.rev;
      renderRev();
      feed(el('div', 'logline', `deliverable revision ${ev.rev} written`));
      break;
    }

    case 'verify_check': {
      const ic = { pass: '✓', fail: '✕', warn: '△', skip: '–' }[ev.status] || '·';
      const c = el('div', `vcheck ${ev.status}`);
      c.appendChild(el('span', 'ic', ic));
      const t = el('span');
      t.appendChild(el('span', null, ev.label + ' '));
      t.appendChild(el('span', 'vdetail', ev.detail));
      c.appendChild(t);
      feed(c);
      break;
    }

    case 'verify_result': {
      // Three states, from the shared policy: green / red / amber-inconclusive.
      const v = verifySummary(ev);
      feed(el('div', `vsummary ${v.cls}`, v.label));
      // Beside the source gate report, so the document does not leave a stale
      // verify_inconclusive standing alone as if it were the current verdict.
      if (state.recoveryOf && state.sourceGateMd) {
        const now = [
          '',
          '---',
          '',
          '## This recovery’s verification',
          '',
          `- result: ${ev.pass === true ? 'PASSED' : ev.pass === false ? 'FAILED' : 'inconclusive (no verdict)'}`,
          ev.commitSha ? `- bound to commit: ${ev.commitSha}` : '- bound to commit: not bound (no verdict recorded)',
          `- source: ${ev.source ?? 'unknown'} (host verifier; no model ran)`,
        ].join('\n');
        $('doc').innerHTML = renderMd(`${state.sourceGateMd}${now}`);
      }
      break;
    }

    case 'gate_report': {
      const r = ev.report ?? {};
      const sim = state.simulated;
      const commit = r.commit_sha ?? r.commit;
      // In a recovery this report is the SOURCE run's, restated — it is the state the
      // candidate was parked in, not the outcome of this run. Left labelled "Gate
      // report · verify_inconclusive" it looked like the current verdict even after
      // the recovery had gone green (audit 2026-08-05).
      // Labelling only — whether this run IS a recovery comes from the run event. Any
      // IDENTIFIER shown here prefers the sealed lineage; the unsealed twin is never
      // presented as authoritative provenance.
      const rec = state.recoveryOf ? { sourceRunId: state.sealedLineage?.sourceRunId ?? state.recoveryOf } : null;
      const md = [
        sim ? '## Gate report (SIMULATED)' : rec ? '## Source gate report (before this recovery)' : '## Gate report',
        '',
        sim ? '> Rehearsal only. No target repository was touched. Studio saved a local simulation trace; no gate branch, commit, or gate receipt exists.' : null,
        sim ? '' : null,
        rec ? `> This is the state the candidate was PARKED in by run ${rec.sourceRunId ?? 'unknown'} — not the result of this recovery. This run reruns no model or gate phases; it reruns deterministic verification only, against that parked candidate, and its result appears below.` : null,
        rec ? '' : null,
        `- status: ${r.status ?? 'unknown'}${sim ? ' (simulated)' : ''}${rec ? ' (as parked, before this recovery)' : ''}`,
        state.runTargetPath ? `- repository: ${state.runTargetPath}${sim ? ' (not modified)' : ''}` : null,
        r.worktree ? `- worktree: ${r.worktree}` : null,
        r.branch ? `- branch: ${r.branch}` : null,
        commit ? `- commit: ${commit}` : null,
        r.report ? `- receipts: ${r.report}` : null,
        r.question ? `- question: ${r.question}` : null,
        r.note ? `- note: ${r.note}` : null,
        '',
        '```',
        gateReportJson(r),
        '```',
      ].filter((l) => l !== null).join('\n');
      state.sourceGateMd = rec ? md : null;
      $('doc').innerHTML = renderMd(md);
      break;
    }

    case 'cost':
      $('run-cost').textContent = state.simulated
        ? 'rehearsal · no real spend'
        : ev.costUsd ? `claude $${ev.costUsd.toFixed(2)}` : '';
      break;

    case 'replay_end':
      if (ev.continuation) state.continuation = ev.continuation;
      // Disk replay finished. Without a terminal status the run crashed —
      // close the stream (or it reconnect-loops) and say what this is.
      state.sawTerminal = true;
      state.es?.close();
      stopTimer();
      if (!document.querySelector('.banner')) {
        setStatus('incomplete');
        // `parked` comes from the SERVER, computed by reconstructInterruptedParked — the
        // same rule the resume path enforces. The client deliberately does not re-derive
        // it: two classifiers meant the UI could offer an action resume would refuse.
        const recovery = replayRecoveryKind({ lane: state.runLane, empty: ev.empty, parked: ev.parked === true });
        const parkedInterruption = recovery === 'recover_parked_candidate';
        const interrupted = el('div', 'banner meh', ev.empty
          ? 'NO RECEIPTS. This run left no event stream.'
          : parkedInterruption
            ? 'INTERRUPTED WHILE AWAITING YOUR VERIFICATION DECISION. Studio stopped before the run could seal anything, so NO evidence pack and NO receipt were written for it. The candidate is committed and still parked exactly as it was; nothing was rejected, merged, or published. Its review verdict exists only in this run\u2019s local event trail below \u2014 replayable, but not sealed and not receipt-covered, so no reviewed standing can be claimed from it. Verify the candidate below: no model, planning, implementation, or review work will be rerun.'
            : 'REPLAY ENDED WITHOUT A VERDICT. The run was interrupted before it finished; the receipts stop here.');
        if (state.runLane === 'build') setStage('gate', 'idle');
        if (recovery === 'recover_comparison') interrupted.appendChild(comparisonRecoveryControl());
        // 'needs_decision' selects the verification-only copy from the shared policy.
        if (recovery === 'resume_build') interrupted.appendChild(buildRecoveryControl('incomplete'));
        if (parkedInterruption) interrupted.appendChild(buildRecoveryControl('needs_decision'));
        feed(interrupted);
      }
      break;

    case 'status': {
      state.sawTerminal = true;
      const terminalStanding = effectiveStanding(ev.headline, state.simulated);
      setStatus(ev.status, terminalStanding, ev.dimensions ?? null);
      stopTimer();
      $('stop').classList.add('hidden');
      if (state.runStartAt && ev.at) {
        const s = Math.max(0, Math.floor((ev.at - state.runStartAt) / 1000));
        $('run-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }
      state.es?.close(); // terminal — otherwise EventSource reconnects and replays forever
      if (state.runLane === 'build') {
        const gateStage = buildGateTerminalStage(ev.status);
        setStage('gate', gateStage === 'fail' ? 'done' : gateStage, { pass: gateStage !== 'fail' });
      }
      setStage('ship', ev.status.startsWith('done') ? 'done' : 'idle');
      const good = ev.status === 'done' || ev.status === 'done_with_findings';
      let cls = terminalBannerClass(ev.status, { simulated: state.simulated, good });
      // done/done_with_findings are ABSENT from this flat map on purpose: for a
      // real run their copy is owned by the headline policy below, and a flat
      // default here would be exactly the false-green a legacy event rides in on.
      let label = state.simulated
        ? (ev.status === 'stopped'
            ? 'REHEARSAL STOPPED. A simulation; nothing ran.'
            : 'REHEARSAL COMPLETE. A scripted simulation: no models or target-repository commands ran, and Studio saved only a local simulation trace. Not evidence, and no model spend.')
        : (ev.status === 'no_changes'
            ? 'NO CHANGES. The gate proved an empty diff: nothing shipped, nothing failed.'
            : terminalFailureBanner(ev.status, state.runLane) || ev.status);
      if (state.runLane === 'comparison') {
        const comparison = comparisonBanner(ev.status, state.simulated);
        cls = comparison.cls;
        label = comparison.label;
      }
      // EVERY real done* event enters the headline policy (banner.mjs) — the
      // trust protocol's one derivation, riding the event at serve time. That
      // includes events with NO dimensions/headline (legacy receipts): missing
      // evidence fails closed to an uncorroborated gate claim, never to
      // "reviewed and verified". The UI never re-derives audit policy.
      if (state.runLane !== 'comparison' && !state.simulated && good) {
        const b = doneBanner(ev.status, ev.headline, ev.dimensions, state.sealedLineage ?? null);
        cls = b.cls;
        label = b.label;
      }
      const b = el('div', `banner ${cls}`, label);
      // The banner renders on the terminal event, BEFORE the sealed pack is fetched, so
      // recovery copy cannot be trusted yet (the seal is the only lineage we honour).
      // Tag it so the report pass below can correct it once the seal is available —
      // fail closed first, upgrade only on sealed evidence.
      b.id = 'terminal-banner';
      b.dataset.status = ev.status;
      b.dataset.headline = ev.headline ?? '';
      if (offersBuildRecovery(ev.status, state.runLane)) {
        b.appendChild(buildRecoveryControl(ev.status));
      }
      if (ev.artifactUrl) {
        const sub = el('span', 'sub');
        const a = el('a', null, 'Published to Hivemind artifacts →');
        a.href = ev.artifactUrl;
        a.target = '_blank';
        sub.appendChild(a);
        b.appendChild(sub);
      } else if (ev.artifactPublished) {
        b.appendChild(el('span', 'sub', `published to Hivemind artifacts · receipts in runs/${state.runId}/`));
      } else if (good && state.runLane !== 'comparison') {
        b.appendChild(el('span', 'sub', state.simulated
          ? `local simulation trace (not evidence) in runs/${state.runId}/`
          : state.runLane === 'audit_replay'
            ? `same artifact · new receipt in runs/${state.runId}/`
            : `rev ${ev.rev} · receipts in runs/${state.runId}/`));
      }
      feed(b);
      // The four raw dimensions rode this terminal event. The one-word headline
      // (Recent runs) is derived from them at render, never stored — so it can
      // never drift from the evidence.
      if (ev.dimensions) {
        const nice = (s) => String(s).replace(/_/g, ' ');
        const d = ev.dimensions;
        feed(el('div', 'dims', `sealed dimensions · execution ${nice(d.execution)} · verification ${nice(d.verification)} · audit ${nice(d.audit)} · publication ${nice(d.publication)}`));
      }
      if (state.runLane === 'comparison') void renderComparisonReceipt();
      else void renderEvidenceReceipt(terminalStanding);
      break;
    }

    case 'error':
      feed(el('div', 'fcard high', ev.message.split('\n')[0]));
      break;
  }
}

function markAnswered(card, text) {
  card.classList.add('answered');
  // Idempotent: the POST response and the SSE `answer` event race, so guard
  // against a second "answered: …" line landing on the same card.
  if (text && !card.querySelector('.qanswer')) card.appendChild(el('div', 'qanswer', `answered: ${text}`));
}

async function answer(qid, text, card) {
  const showError = (msg) => {
    let e = card.querySelector('.qerr');
    if (!e) { e = el('div', 'qerr'); card.appendChild(e); }
    e.textContent = msg;
  };
  try {
    const res = await fetch(`${API}/api/runs/${state.runId}/answer`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ answer: text }),
    });
    if (res.ok) { markAnswered(card, text); return; }
    const data = await res.json().catch(() => ({}));
    showError(`Your answer didn't land: ${data.error || res.statusText}. Try again.`);
  } catch (err) {
    showError(`Couldn't reach the studio server (${err.message}) . The answer was not delivered; try again.`);
  }
}

function renderRev() {
  const r = current();
  if (!r) return;
  document.querySelectorAll('#revtabs button').forEach((b, i) => b.classList.toggle('selected', state.revs[i]?.rev === (state.selectedRev ?? r.rev)));
  $('doc').innerHTML = renderMd(r.markdown);
}

boot();
