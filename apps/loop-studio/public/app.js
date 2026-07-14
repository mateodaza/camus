/* Camus Loop Studio front-end. No framework: one SSE stream in, DOM out. */

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

const state = {
  lane: 'research_memo',
  depth: 'quick',
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
};

// ---------------------------------------------------------------------------
// Launch view
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const s = await (await fetch(`${API}/api/status`)).json();
    TOKEN = s.token || '';
    const eng = $('pill-engine');
    eng.textContent = s.engine === 'mock'
      ? 'engine: rehearsal (mock)'
      : `engine: live · ${s.models.maker} + ${s.models.reviewer} (${s.models.effort})`;
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
      $('ground-hint').textContent = 'Hivemind is Myosin’s private research knowledge (on staging today). To ground drafts in it: set HIVEMIND_VIA_CLAUDE=1 for Claude’s own connector, or HIVEMIND_MCP_URL + HIVEMIND_API_KEY — see Setup.';
    } else {
      $('ground').checked = true;
      $('ground-hint').textContent = s.hivemind.mode === 'claude'
        ? `Grounded in Hivemind — Claude queries ${s.hivemind.base} on its own connector auth.`
        : `Grounded in Hivemind — knowledge_search via ${s.hivemind.mode}: ${s.hivemind.base}.`;
    }
    const buildLane = $('lane-build');
    if (buildLane && s.gate && !s.gate.installed) {
      buildLane.classList.add('disabled');
      buildLane.title = 'The camus gate is not installed — see Setup';
    }
    if (s.engine !== 'mock') {
      // Live engine: quietly check the machine and surface the setup panel
      // only when something is actually missing.
      fetch(`${API}/api/doctor`).then((r) => r.json()).then((report) => {
        if (!report.ok) renderSetup(report);
      }).catch(() => {});
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

// ---------------------------------------------------------------------------
// Install panel — shown when no local studio answers. Two paths: hand the
// setup to Claude Code with one copied prompt, or paste three commands.
// Auto-retries so the page springs to life the moment the server is up.
// ---------------------------------------------------------------------------

const CLAUDE_SETUP_PROMPT = `Set up Camus Loop Studio on my machine and start it:

1. If ~/camus does not exist: git clone --depth 1 https://github.com/mateodaza/camus.git ~/camus — otherwise run git -C ~/camus pull.
2. Start the studio server and keep it running: node ~/camus/apps/loop-studio/server.mjs (it listens on http://localhost:1913).
3. Run node ~/camus/apps/loop-studio/server.mjs --doctor and fix anything it flags — it prints the exact commands (the Claude Code CLI and the Codex CLI must be installed and signed in once each).
4. When http://localhost:1913/api/status answers, tell me — the page at camus.sh/studio connects to it automatically.`;

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
      b.textContent = 'Copy failed — select it yourself';
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
    'The studio runs on your machine — this page is only the glass. One server, one command, and your keys never leave your laptop.'));

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
  row.appendChild(el('span', 'hint', 'needs Node ≥ 18 — the in-page setup checks guide the rest once the server is up'));
  box.appendChild(row);

  // The waiting line: this page keeps knocking until the server answers.
  const wait = el('div', 'install-wait');
  wait.appendChild(el('span', 'dot'));
  wait.appendChild(el('span', null, `waiting for the studio at ${API || 'http://localhost:1913'} — it connects by itself once the server answers, then you brief a goal and pick a lane below`));
  box.appendChild(wait);

  box.classList.remove('hidden');

  clearInterval(installRetry);
  installRetry = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/status`);
      if (!res.ok) return;
      clearInterval(installRetry);
      box.classList.add('hidden');
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
    for (const r of runs) {
      const b = el('button', 'recent');
      b.appendChild(el('span', `pill status ${r.status}`, r.status.replace(/_/g, ' ')));
      if (r.headline) b.appendChild(el('span', 'headline-tag', r.headline.replace(/_/g, ' ')));
      b.appendChild(el('span', 'g', r.goal));
      b.appendChild(el('span', 'mono muted', new Date(r.startedAt).toLocaleTimeString()));
      b.onclick = () => attach(r.id, r.goal);
      box.appendChild(b);
    }
  } catch { /* cosmetic */ }
}

// ---------------------------------------------------------------------------
// Setup panel — the doctor, rendered for people who don't debug PATHs
// ---------------------------------------------------------------------------

function renderSetup(report) {
  const box = $('setup-panel');
  box.innerHTML = '';
  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'lbl', report.ok ? 'Setup — this machine is ready; brief a goal below' : 'Setup — a few pieces are missing'));
  const again = el('button', 'ghost', 'Check again');
  again.onclick = () => openSetup(true);
  head.appendChild(again);
  box.appendChild(head);
  for (const c of report.checks) {
    const row = el('div', `setup-row ${c.ok ? 'ok' : 'miss'}`);
    row.appendChild(el('span', 'ic', c.ok ? '✓' : '✕'));
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
  box.classList.remove('hidden');
}

async function openSetup(deep) {
  try {
    const report = await (await fetch(`${API}/api/doctor${deep ? '?deep=1' : ''}`)).json();
    renderSetup(report);
  } catch {
    $('setup-panel').innerHTML = '';
    $('setup-panel').appendChild(el('div', 's-detail', 'The studio server is unreachable, so setup cannot be checked. Start it with: node server.mjs'));
    $('setup-panel').classList.remove('hidden');
  }
}

$('open-setup').addEventListener('click', () => {
  if (!$('setup-panel').classList.contains('hidden')) { $('setup-panel').classList.add('hidden'); return; }
  openSetup(true);
});

// ---------------------------------------------------------------------------
// Settings panel — the decision record, editable
// ---------------------------------------------------------------------------

async function openSettings() {
  const panel = $('settings-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  try {
    const c = await (await fetch(`${API}/api/config`)).json();
    $('set-maker').value = c.maker.model;
    $('set-reviewer').value = c.reviewer.model;
    $('set-effort').value = c.reviewer.effort;
    $('set-roundcap').value = c.loop.roundCap;
    $('settings-env').textContent = c.envOverrides.length
      ? `note: ${c.envOverrides.join(', ')} set in the environment — env wins over these fields this session`
      : '';
    $('settings-note').textContent = '';
    panel.classList.remove('hidden');
  } catch {
    $('settings-note').textContent = 'server unreachable';
  }
}

$('open-settings').addEventListener('click', openSettings);

$('save-settings').addEventListener('click', async () => {
  $('settings-note').textContent = 'saving…';
  try {
    const res = await fetch(`${API}/api/config`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({
        maker: $('set-maker').value,
        reviewer: $('set-reviewer').value,
        effort: $('set-effort').value,
        roundCap: Number($('set-roundcap').value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    $('settings-note').textContent = 'saved — applies from the next run';
    boot(); // pills reflect the new decisions
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
});

$('depth').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.depth = btn.dataset.v;
  document.querySelectorAll('#depth button').forEach((b) => b.classList.toggle('selected', b === btn));
});

$('start').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  $('form-error').textContent = '';
  $('start').disabled = true;
  try {
    const res = await fetch(`${API}/api/runs`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ goal, lane: state.lane, depth: state.depth, ground: $('ground').checked, targetPath: state.lane === 'build' ? $('target-path').value : undefined }),
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
  state.revs = [];
  state.sessionCount = 0;
  $('session-pre').textContent = '';
  $('session-toggle').textContent = 'Show the session';
  state.selectedRev = null;
  state.followRev = true;
  state.reviewRounds = 0;
  $('launch').classList.add('hidden');
  $('runview').classList.remove('hidden');
  $('rungoal').textContent = goal || id;
  $('run-cost').textContent = ''; // don't carry the previous run's spend
  $('run-timer').textContent = '0:00';
  $('stop').classList.remove('hidden');
  state.runStartAt = null;
  $('feed').innerHTML = '';
  $('revtabs').innerHTML = '';
  $('doc').innerHTML = '<div class="doc-empty">The deliverable appears here as the loop drafts it.</div>';
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
      feed(el('div', 'banner meh', 'LOST THE STUDIO SERVER — the page can no longer see the run. Restart the server and reopen this run from Recent runs.'));
    }
  };
}

$('session-toggle').addEventListener('click', () => {
  const box = $('session');
  const open = box.classList.toggle('hidden');
  $('session-toggle').textContent = open ? `Show the session (${state.sessionCount})` : 'Hide the session';
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
    const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `run-${state.runId}-evidence.json`;
    link.click();
  } catch (err) {
    $('download-report').textContent = 'no report yet';
    setTimeout(() => ($('download-report').textContent = 'Evidence'), 1500);
  }
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
  for (const [key, label] of STAGE_DEFS[lane === 'build' ? 'build' : 'words']) {
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
    badge.textContent = extra.via === 'claude'
      ? 'claude'
      : extra.connected === false
        ? (extra.mode && extra.mode !== 'stub' ? `${extra.mode} ✕` : 'stub')
        : '';
  }
}

function setStatus(status) {
  const p = $('run-status');
  p.className = `pill status ${status}`;
  p.textContent = status.replace(/_/g, ' ');
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
      if (ev.run?.goal) $('rungoal').textContent = ev.run.goal;
      if (ev.at) { state.runStartAt = ev.at; startTimer(ev.at); }
      state.runLane = ev.run?.lane;
      state.runTargetPath = ev.run?.targetPath ?? null;
      state.simulated = ev.run?.engine === 'mock';
      if (state.simulated) {
        const sb = $('sim-banner');
        // Static literal — no user input — so innerHTML is safe here.
        sb.innerHTML = '<b>REHEARSAL — SIMULATED.</b> A scripted demo of the loop. No models run, your brief is not processed, your target files and repository are not changed, and no model spend occurs. Studio saves a local simulation trace under runs/; every draft, verdict, branch, commit, and gate receipt shown is scripted and is not evidence of real work.';
        sb.classList.remove('hidden');
        $('run-cost').textContent = 'rehearsal · no real spend';
      }
      buildStages(ev.run?.lane);
      if (ev.run?.lane !== 'build' && ev.run && !ev.run.ground) state.stageEls.get('ground')?.remove();
      if (ev.run?.lane === 'build') $('doc').innerHTML = '<div class="doc-empty">The gate works inside the target repo — the session below is the live view; its report lands here.</div>';
      break;

    case 'stage':
      setStage(ev.name, ev.status, ev);
      break;

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
      if (box.classList.contains('hidden')) $('session-toggle').textContent = `Show the session (${state.sessionCount})`;
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
      const v = el('div', `verdict ${clean ? 'approved' : revise ? 'revise' : ''}`,
        clean
          ? `✓ reviewer verdict, round ${ev.round}: clean`
          : revise
            ? `✗ reviewer verdict, round ${ev.round}: revise (${ev.findings.filter((f) => f.severity !== 'low').length} blocking)`
            : `? reviewer verdict, round ${ev.round}: unreadable — receipt will be marked incomplete`);
      feed(v);
      break;
    }

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
          b.onclick = () => answer(ev.id, o, c);
          opts.appendChild(b);
        }
        c.appendChild(opts);
      } else {
        const ta = el('textarea');
        ta.rows = 2;
        ta.placeholder = 'Your call — one or two lines is enough.';
        ta.setAttribute('aria-label', 'Your answer to the loop');
        const send = el('button', 'send', 'Answer');
        send.onclick = () => ta.value.trim() && answer(ev.id, ta.value.trim(), c);
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
      const caveats = (ev.warnings || 0) + (ev.skipped || 0);
      const label = !ev.pass
        ? 'DETERMINISTIC GATE: RED — sending back for a fix'
        : caveats
          ? `DETERMINISTIC GATE: GREEN, with caveats — ${ev.warnings || 0} warning(s), ${ev.skipped || 0} check(s) could not run`
          : 'DETERMINISTIC GATE: GREEN — every check passed';
      feed(el('div', `vsummary ${ev.pass ? 'pass' : 'fail'}`, label));
      break;
    }

    case 'gate_report': {
      const r = ev.report ?? {};
      const sim = state.simulated;
      const commit = r.commit_sha ?? r.commit;
      const md = [
        sim ? '## Gate report — SIMULATED' : '## Gate report',
        '',
        sim ? '> Rehearsal only. No target repository was touched. Studio saved a local simulation trace; no gate branch, commit, or gate receipt exists.' : null,
        sim ? '' : null,
        `- status: ${r.status ?? 'unknown'}${sim ? ' (simulated)' : ''}`,
        state.runTargetPath ? `- repository: ${state.runTargetPath}${sim ? ' (not modified)' : ''}` : null,
        r.worktree ? `- worktree: ${r.worktree}` : null,
        r.branch ? `- branch: ${r.branch}` : null,
        commit ? `- commit: ${commit}` : null,
        r.report ? `- receipts: ${r.report}` : null,
        r.question ? `- question: ${r.question}` : null,
        r.note ? `- note: ${r.note}` : null,
        '',
        '```',
        JSON.stringify(r, null, 2).slice(0, 4000),
        '```',
      ].filter((l) => l !== null).join('\n');
      $('doc').innerHTML = renderMd(md);
      break;
    }

    case 'cost':
      $('run-cost').textContent = state.simulated
        ? 'rehearsal · no real spend'
        : ev.costUsd ? `claude $${ev.costUsd.toFixed(2)}` : '';
      break;

    case 'replay_end':
      // Disk replay finished. Without a terminal status the run crashed —
      // close the stream (or it reconnect-loops) and say what this is.
      state.sawTerminal = true;
      state.es?.close();
      stopTimer();
      if (!document.querySelector('.banner')) {
        setStatus('incomplete');
        feed(el('div', 'banner meh', ev.empty
          ? 'NO RECEIPTS — this run left no event stream.'
          : 'REPLAY ENDED WITHOUT A VERDICT — the run was interrupted before it finished; the receipts stop here.'));
      }
      break;

    case 'status': {
      state.sawTerminal = true;
      setStatus(ev.status);
      stopTimer();
      $('stop').classList.add('hidden');
      if (state.runStartAt && ev.at) {
        const s = Math.max(0, Math.floor((ev.at - state.runStartAt) / 1000));
        $('run-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }
      state.es?.close(); // terminal — otherwise EventSource reconnects and replays forever
      setStage('ship', ev.status.startsWith('done') ? 'done' : 'idle');
      const good = ev.status === 'done' || ev.status === 'done_with_findings';
      let cls = state.simulated ? 'meh' : good ? 'good' : ['stopped', 'no_changes'].includes(ev.status) ? 'meh' : 'bad';
      let label = state.simulated
        ? (ev.status === 'stopped'
            ? 'REHEARSAL STOPPED — a simulation; nothing ran.'
            : 'REHEARSAL COMPLETE — a scripted simulation. No models or target-repository commands ran; Studio saved only a local simulation trace. No real evidence or model spend.')
        : ({
            done: 'DONE — reviewed and verified.',
            done_with_findings: 'DONE WITH FINDINGS — green, with findings or caveats on the record.',
            no_changes: 'NO CHANGES — the gate proved an empty diff; nothing shipped, nothing failed.',
            verify_failed: 'VERIFY FAILED — shipped by human override, recorded as red.',
            failed: 'FAILED — the loop refused to fake a green.',
            stopped: 'STOPPED by human.',
          }[ev.status] || ev.status);
      // The verified claim answers to the trust protocol's ONE headline
      // derivation, riding the event at serve time (never sealed) — the UI does
      // not re-derive audit policy. A hand-rolled copy of the rules here let a
      // same-vendor advisory audit claim "verified"; protocol rule 6 says
      // advisory is its own standing, never verified. Anything the derivation
      // does not vouch for renders as a gate claim the receipt does not back.
      if (!state.simulated && good && ev.dimensions) {
        if (ev.headline === 'same_vendor_reviewed') {
          cls = 'meh';
          label = `${ev.status === 'done' ? 'DONE' : 'DONE WITH FINDINGS'} — same-vendor reviewed. The audit ran on the maker's own vendor; advisory review never earns independent verified standing.`;
        } else if (!['verified', 'verified_with_findings', 'published'].includes(ev.headline)) {
          cls = 'meh';
          const nice = (s) => String(s).replace(/_/g, ' ');
          label = `${ev.status === 'done' ? 'DONE (gate claim)' : 'DONE WITH FINDINGS (gate claim)'} — the receipt does not corroborate it: verification ${nice(ev.dimensions.verification)}, audit ${nice(ev.dimensions.audit)}. Trust the dimensions below, not the word.`;
        }
      }
      const b = el('div', `banner ${cls}`, label);
      if (state.runLane === 'build' && ['stopped', 'failed', 'verify_failed'].includes(ev.status)) {
        const sub = el('span', 'sub');
        const resume = el('button', 'resume-btn', 'Resume the gate');
        resume.onclick = async () => {
          resume.textContent = 'resuming…';
          try {
            const res = await fetch(`${API}/api/runs/${state.runId}/resume`, { method: 'POST', headers: postHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.statusText);
            attach(data.id, $('rungoal').textContent);
          } catch (err) {
            resume.textContent = `couldn't resume: ${String(err.message).slice(0, 60)}`;
          }
        };
        sub.appendChild(resume);
        sub.appendChild(document.createTextNode(' camus is crash-safe — finished work skips, proven work lands, only unproven work re-runs.'));
        b.appendChild(sub);
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
      } else if (good) {
        b.appendChild(el('span', 'sub', state.simulated
          ? `local simulation trace (not evidence) in runs/${state.runId}/`
          : `rev ${ev.rev} · receipts in runs/${state.runId}/`));
      }
      feed(b);
      // The four raw dimensions rode this terminal event. The one-word headline
      // (Recent runs) is derived from them at render, never stored — so it can
      // never drift from the evidence.
      if (ev.dimensions) {
        const nice = (s) => String(s).replace(/_/g, ' ');
        const d = ev.dimensions;
        feed(el('div', 'dims', `status dimensions — execution: ${nice(d.execution)} · verification: ${nice(d.verification)} · audit: ${nice(d.audit)} · publication: ${nice(d.publication)}`));
      }
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
    showError(`Couldn't reach the studio server (${err.message}) — the answer was not delivered. Try again.`);
  }
}

function renderRev() {
  const r = current();
  if (!r) return;
  document.querySelectorAll('#revtabs button').forEach((b, i) => b.classList.toggle('selected', state.revs[i]?.rev === (state.selectedRev ?? r.rev)));
  $('doc').innerHTML = renderMd(r.markdown);
}

boot();
