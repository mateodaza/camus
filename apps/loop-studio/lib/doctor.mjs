// Structured environment checks — one source of truth for `--doctor`, the
// /api/doctor endpoint, and the setup panel in the UI. Every failing check
// carries the exact fix a person can paste, because the audience for this
// app does not debug PATHs.

import { execFile } from 'node:child_process';
import { getModels, modelsSummary } from './models.mjs';
import { CLAUDE_HIVEMIND_DISPLAY, hivemindStatus } from './adapters/hivemind.mjs';
import { gateInstalled } from './code-lane.mjs';

const probe = (cmd, args, timeout = 20_000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve(err ? null : String(stdout || stderr).trim().split('\n')[0]),
    ),
  );

// Tri-state auth from a spend-free probe's output. null = the probe could not
// run (CLI missing, nonzero exit, timeout) — UNKNOWN, never guessed toward
// green. An explicit negation is checked FIRST: "Not logged in" printed with
// exit 0 must read false, not match the "logged in" substring (a false green
// here would put a reassuring chip in front of a run that will 401). And a
// probe that says logged-in still only proves a STORED session — a stale one
// can 401 at inference; the run stream stays the authoritative signal.
export const parseAuthProbe = (raw) => {
  if (raw == null) return null;
  // Structured claims first (claude can answer JSON), then explicit prose
  // negations, then prose sign-in — with REAL whitespace, so the bare
  // `loggedIn` JSON key can never satisfy the prose match on its own.
  if (/loggedIn"?\s*:\s*true/i.test(raw)) return true;
  if (/loggedIn"?\s*:\s*false/i.test(raw)) return false;
  if (/not\s+logged\s+in|logged\s+out|no\s+credentials/i.test(raw)) return false;
  if (/logged\s+in/i.test(raw)) return true;
  // Output with NO explicit claim either way (an error banner, help text, a
  // partial read) is unknown — an implicit false would be as invented as an
  // implicit green.
  return null;
};

// Managed Claude connectors need not use Studio's local alias. Match the exact
// configured endpoint, never a display name, so "claude.ai Hivemind Staging"
// is recognized without requiring a duplicate connector named `hivemind`.
export const hivemindListingHasEndpoint = (raw, endpoint) => {
  const wanted = String(endpoint || '').trim().replace(/\/$/, '');
  if (!wanted) return false;
  return String(raw || '').split('\n').some((line) => line.trim().replace(/\/$/, '').includes(wanted));
};

export const managedConnectorIsConnected = (raw) => /Status:\s*[^\n]*Connected/i.test(String(raw || ''));

// deep=true adds the slow managed-connector health round-trip.
export async function runDoctor({ deep = false, engine = 'live' } = {}) {
  const checks = [];
  const add = (id, label, ok, detail, fix = null, extra = {}) => checks.push({ id, label, ok, detail, fix, ...extra });

  add('node', 'Node.js', true, process.version, null);

  const [claudeV, codexV, gitV] = await Promise.all([
    probe('claude', ['--version']),
    probe('codex', ['--version']),
    probe('git', ['--version']),
  ]);

  // Installed is not signed-in: both CLIs expose spend-free auth probes.
  // Their SIGNED-OUT answers arrive with exit code 1 (claude prints
  // {"loggedIn": false, …}, codex prints "Not logged in") — so the output must
  // survive a nonzero exit, or the real signed-out state collapses into
  // "unknown" and the red preflight can never fire (live P1, 2026-07-14). A
  // nonzero exit with NO output (missing binary, timeout, crash) still ends up
  // null through the parser's no-claim rule.
  const fullProbe = (cmd, args, timeout = 20_000) =>
    new Promise((r) => execFile(cmd, args, { timeout }, (_err, so, se) => {
      const out = String(so || se || '').trim();
      r(out || null);
    }));
  const [claudeAuthRaw, codexAuthRaw] = await Promise.all([
    claudeV ? fullProbe('claude', ['auth', 'status']) : Promise.resolve(null),
    codexV ? fullProbe('codex', ['login', 'status']) : Promise.resolve(null),
  ]);
  const claudeAuthed = parseAuthProbe(claudeAuthRaw);
  const codexAuthed = parseAuthProbe(codexAuthRaw);

  // `auth` rides each CLI check structurally (true/false/null) so the launch
  // view's preflight chips consume the doctor's judgement instead of
  // re-parsing detail strings.
  add(
    'claude', 'Claude Code CLI', !!claudeV && claudeAuthed !== false,
    !claudeV ? 'not found on PATH; the maker cannot run'
      : claudeAuthed === false ? `${claudeV} installed, but not signed in`
      : `${claudeV}${claudeAuthed ? ' · signed in' : ''}`,
    !claudeV ? 'npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in'
      : claudeAuthed === false ? 'claude   # opens the sign-in flow' : null,
    { auth: claudeAuthed },
  );
  add(
    'codex', 'Codex CLI (the reviewer)', !!codexV && codexAuthed !== false,
    !codexV ? 'not found on PATH; nothing can review the drafts'
      : codexAuthed === false ? `${codexV} installed, but not signed in`
      : `${codexV}${codexAuthed ? ' · signed in' : ''}`,
    !codexV ? 'npm install -g @openai/codex   # then run `codex` once and sign in'
      : codexAuthed === false ? 'codex login' : null,
    { auth: codexAuthed },
  );
  add(
    'git', 'git', !!gitV,
    gitV ?? 'not found; reviews would run outside a git repo (different conditions than camus)',
    gitV ? null : 'xcode-select --install   # macOS; or install git from git-scm.com',
  );

  const gate = gateInstalled();
  add(
    'gate', 'Camus gate (Build lane)', gate,
    gate ? 'installed in ~/.claude with standalone custody support' : 'missing or too old. Build requires the identity-bound custody gate; the words lanes run without it.',
    gate ? null : 'npm install -g camus-cli && camus install   # or, from this repo: bash packages/cli/install.sh',
  );

  let models;
  try {
    models = getModels();
    let note = modelsSummary();
    try {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const cache = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, 'utf8'));
      const slugs = (cache.models ?? []).map((m) => m.slug).filter(Boolean);
      if (slugs.length && !slugs.includes(models.reviewer.model)) {
        note += `. Reviewer "${models.reviewer.model}" is not in codex's model cache (${slugs.slice(0, 3).join(', ')}…); a run may fail at review.`;
      }
    } catch { /* cache absent — cannot judge, stay quiet */ }
    add('models', 'Model decisions', true, note, null);
  } catch (err) {
    add('models', 'Model decisions', false, err.message, 'open Settings in the studio and pick the models');
  }

  const hm = hivemindStatus();
  if (hm.mode === 'claude' && deep) {
    // Probe ONLY the managed connector. `mcp list` health-checks every local
    // entry and their stderr may contain inline credentials; this targeted
    // command neither initializes nor exposes unrelated MCP configuration.
    const full = await fullProbe('claude', ['mcp', 'get', CLAUDE_HIVEMIND_DISPLAY], 30_000);
    const registered = managedConnectorIsConnected(full);
    add(
      'hivemind', 'Hivemind grounding (via Claude)', registered,
      registered ? `connected managed connector recognized · ${CLAUDE_HIVEMIND_DISPLAY}` : `Claude has no connected ${CLAUDE_HIVEMIND_DISPLAY} entry`,
      registered ? null : `open /mcp in Claude and connect Hivemind Staging (${hm.base})`,
    );
  } else {
    add(
      'hivemind', 'Hivemind grounding', hm.connected,
      hm.connected ? `${hm.mode}: ${hm.base}` : 'not connected. Myosin’s Hivemind (staging) is optional; runs proceed ungrounded.',
      hm.connected ? null : 'optional: HIVEMIND_VIA_CLAUDE=1 (Claude connector) or HIVEMIND_MCP_URL + HIVEMIND_API_KEY',
    );
  }

  const required = checks.filter((c) => !['hivemind', 'gate'].includes(c.id)); // both optional: words lanes run without them
  return {
    engine,
    ok: engine === 'mock' || required.every((c) => c.ok),
    checks,
  };
}
