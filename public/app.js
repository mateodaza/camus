/* Camus Loop Studio front-end. No framework: one SSE stream in, DOM out. */

// Hosted-UI mode: when this page is served from a public origin, ?api=
// points it at the local studio server (persisted after the first visit).
// Same-origin (the normal local case) leaves API empty.
const API = (() => {
  const param = new URLSearchParams(location.search).get('api');
  if (param) localStorage.setItem('cls-api', param.replace(/\/$/, ''));
  return localStorage.getItem('cls-api') || '';
})();

const $ = (id) => document.getElementById(id);
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
};

const STAGE_DEFS = [
  ['plan', 'Plan'],
  ['ground', 'Ground'],
  ['make', 'Draft'],
  ['review', 'Review'],
  ['fix', 'Fix'],
  ['verify', 'Verify'],
  ['ship', 'Ship'],
];

// ---------------------------------------------------------------------------
// Launch view
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const s = await (await fetch(`${API}/api/status`)).json();
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
      $('ground-hint').textContent = 'HIVEMIND_VIA_CLAUDE=1 grounds drafts through Claude’s own Hivemind connector (no key); or set HIVEMIND_MCP_URL + HIVEMIND_API_KEY.';
    } else {
      $('ground').checked = true;
      $('ground-hint').textContent = s.hivemind.mode === 'claude'
        ? `Claude queries ${s.hivemind.base} itself, on its own connector auth`
        : `knowledge_search via ${s.hivemind.mode}: ${s.hivemind.base}`;
    }
  } catch {
    // Not cosmetic in hosted-UI mode: an unreachable local server would
    // otherwise look like a page that never finished loading.
    $('pill-engine').textContent = API ? `studio unreachable at ${API}` : 'studio server unreachable';
    $('pill-engine').classList.add('warn');
    $('pill-hivemind').textContent = 'start it with: node server.mjs';
    $('ground').disabled = true;
  }
  loadRecents();
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
      b.appendChild(el('span', 'g', r.goal));
      b.appendChild(el('span', 'mono muted', new Date(r.startedAt).toLocaleTimeString()));
      b.onclick = () => attach(r.id, r.goal);
      box.appendChild(b);
    }
  } catch { /* cosmetic */ }
}

$('lanes').addEventListener('click', (e) => {
  const btn = e.target.closest('.lane');
  if (!btn) return;
  state.lane = btn.dataset.lane;
  document.querySelectorAll('.lane').forEach((l) => l.classList.toggle('selected', l === btn));
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, lane: state.lane, depth: state.depth, ground: $('ground').checked }),
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
  state.selectedRev = null;
  state.followRev = true;
  state.reviewRounds = 0;
  $('launch').classList.add('hidden');
  $('runview').classList.remove('hidden');
  $('rungoal').textContent = goal || id;
  $('run-cost').textContent = ''; // don't carry the previous run's spend
  $('run-timer').textContent = '0:00';
  $('feed').innerHTML = '';
  $('revtabs').innerHTML = '';
  $('doc').innerHTML = '<div class="doc-empty">The deliverable appears here as the loop drafts it.</div>';
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
    const res = await fetch(`${API}/api/runs/${state.runId}/stop`, { method: 'POST' });
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

function buildStages() {
  const nav = $('stages');
  nav.innerHTML = '';
  state.stageEls.clear();
  for (const [key, label] of STAGE_DEFS) {
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
      if (ev.at) startTimer(ev.at);
      if (ev.run && !ev.run.ground) state.stageEls.get('ground')?.remove();
      break;

    case 'stage':
      setStage(ev.name, ev.status, ev);
      break;

    case 'log':
      feed(el('div', 'logline', ev.line));
      break;

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
      const v = el('div', `verdict ${ev.verdict === 'APPROVED' ? 'approved' : 'revise'}`,
        ev.verdict === 'APPROVED'
          ? `✓ reviewer verdict, round ${ev.round}: clean`
          : `✗ reviewer verdict, round ${ev.round}: revise (${ev.findings.filter((f) => f.severity !== 'low').length} blocking)`);
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

    case 'answer':
      feed(el('div', 'logline', `human decided: ${ev.answer}`));
      break;

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

    case 'verify_result':
      feed(el('div', `vsummary ${ev.pass ? 'pass' : 'fail'}`,
        ev.pass ? 'DETERMINISTIC GATE: GREEN — every check passed' : 'DETERMINISTIC GATE: RED — sending back for a fix'));
      break;

    case 'cost':
      $('run-cost').textContent = ev.costUsd ? `claude $${ev.costUsd.toFixed(2)}` : '';
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
      state.es?.close(); // terminal — otherwise EventSource reconnects and replays forever
      setStage('ship', ev.status.startsWith('done') ? 'done' : 'idle');
      const good = ev.status === 'done' || ev.status === 'done_with_findings';
      const cls = good ? 'good' : ev.status === 'stopped' ? 'meh' : 'bad';
      const label = {
        done: 'DONE — reviewed, verified, shipped.',
        done_with_findings: 'DONE WITH FINDINGS — verified green; accepted findings are on the record.',
        verify_failed: 'VERIFY FAILED — shipped by human override, recorded as red.',
        failed: 'FAILED — the loop refused to fake a green.',
        stopped: 'STOPPED by human.',
      }[ev.status] || ev.status;
      const b = el('div', `banner ${cls}`, label);
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
        b.appendChild(el('span', 'sub', `rev ${ev.rev} · receipts in runs/${state.runId}/`));
      }
      feed(b);
      break;
    }

    case 'error':
      feed(el('div', 'fcard high', ev.message.split('\n')[0]));
      break;
  }
}

function markAnswered(card, text) {
  card.classList.add('answered');
  if (text) card.appendChild(el('div', 'qanswer', `answered: ${text}`));
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
      headers: { 'content-type': 'application/json' },
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
