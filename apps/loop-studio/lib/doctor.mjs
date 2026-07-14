// Structured environment checks — one source of truth for `--doctor`, the
// /api/doctor endpoint, and the setup panel in the UI. Every failing check
// carries the exact fix a person can paste, because the audience for this
// app does not debug PATHs.

import { execFile } from 'node:child_process';
import { getModels, modelsSummary } from './models.mjs';
import { hivemindStatus } from './adapters/hivemind.mjs';
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
  return /logged\s+in/i.test(raw);
};

// deep=true adds the slow checks (claude mcp list health round-trip).
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
  const fullProbe = (cmd, args) =>
    new Promise((r) => execFile(cmd, args, { timeout: 20_000 }, (err, so, se) => r(err ? null : String(so || se).trim())));
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
    !claudeV ? 'not found on PATH — the maker cannot run'
      : claudeAuthed === false ? `${claudeV} installed, but not signed in`
      : `${claudeV}${claudeAuthed ? ' · signed in' : ''}`,
    !claudeV ? 'npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in'
      : claudeAuthed === false ? 'claude   # opens the sign-in flow' : null,
    { auth: claudeAuthed },
  );
  add(
    'codex', 'Codex CLI (the reviewer)', !!codexV && codexAuthed !== false,
    !codexV ? 'not found on PATH — nothing can review the drafts'
      : codexAuthed === false ? `${codexV} installed, but not signed in`
      : `${codexV}${codexAuthed ? ' · signed in' : ''}`,
    !codexV ? 'npm install -g @openai/codex   # then run `codex` once and sign in'
      : codexAuthed === false ? 'codex login' : null,
    { auth: codexAuthed },
  );
  add(
    'git', 'git', !!gitV,
    gitV ?? 'not found — reviews will run outside a git repo (different conditions than camus)',
    gitV ? null : 'xcode-select --install   # macOS; or install git from git-scm.com',
  );

  const gate = gateInstalled();
  add(
    'gate', 'Camus gate (Build lane)', gate,
    gate ? 'installed in ~/.claude with standalone custody support' : 'missing or too old — Build requires the identity-bound custody gate (the words lanes run without it)',
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
        note += ` — reviewer "${models.reviewer.model}" is not in codex's model cache (${slugs.slice(0, 3).join(', ')}…); a run may fail at review`;
      }
    } catch { /* cache absent — cannot judge, stay quiet */ }
    add('models', 'Model decisions', true, note, null);
  } catch (err) {
    add('models', 'Model decisions', false, err.message, 'open Settings in the studio and pick the models');
  }

  const hm = hivemindStatus();
  if (hm.mode === 'claude' && deep) {
    const list = await probe('claude', ['mcp', 'list'], 45_000);
    // probe returns first line only; ask again for the full listing
    const full = await new Promise((resolve) =>
      execFile('claude', ['mcp', 'list'], { timeout: 45_000 }, (_e, stdout) => resolve(String(stdout || ''))),
    );
    const registered = /^hivemind:/m.test(full);
    add(
      'hivemind', 'Hivemind grounding (via Claude)', registered,
      registered ? `"hivemind" registered · ${hm.base}` : 'no MCP server named "hivemind" in claude mcp list',
      registered ? null : `claude mcp add --transport http hivemind ${hm.base}   # then authenticate it via /mcp in a claude session`,
    );
    void list;
  } else {
    add(
      'hivemind', 'Hivemind grounding', hm.connected,
      hm.connected ? `${hm.mode}: ${hm.base}` : 'not connected — Myosin’s Hivemind (staging) is optional; runs proceed ungrounded',
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
