// Structured environment checks — one source of truth for `--doctor`, the
// /api/doctor endpoint, and the setup panel in the UI. Every failing check
// carries the exact fix a person can paste, because the audience for this
// app does not debug PATHs.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getModels, modelsSummary, seatCatalog, listBackends } from './models.mjs';
import { CLAUDE_HIVEMIND_DISPLAY, hivemindStatus } from './adapters/hivemind.mjs';
import { gateInstalled } from './code-lane.mjs';

// A skill is a directory holding SKILL.md, whose YAML frontmatter names it.
// Only `name` is required; a directory without readable frontmatter still
// counts under its folder name rather than vanishing from the report.
const skillMeta = (text) => {
  const front = /^---\n([\s\S]*?)\n---/.exec(String(text || ''));
  if (!front) return null;
  const name = /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
  // `description:` may be inline or a YAML block scalar (`|`, `>`), in which
  // case the text starts on the following indented line.
  const desc = /^description:[ \t]*(\|-?|>-?)?[ \t]*(.*)$/m.exec(front[1]);
  let description = null;
  if (desc) {
    description = desc[1]
      ? front[1].slice(desc.index + desc[0].length).split('\n').map((l) => l.trim()).find(Boolean) ?? null
      : desc[2].trim() || null;
  }
  return name ? { name, description } : null;
};

const readSkillDir = (dir, scope) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent directory is not an error — most machines have none
  }
  const out = [];
  for (const entry of entries) {
    // Symlinks count: plugin and marketplace installs symlink skills into
    // ~/.claude/skills, and Dirent.isDirectory() is false for a symlink, which
    // silently hid most of them. readFileSync below follows the link.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let text = null;
    try {
      text = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue; // a directory without SKILL.md is not a skill
    }
    const meta = skillMeta(text);
    out.push({ name: meta?.name || entry.name, description: meta?.description ?? null, scope });
  }
  return out;
};

// Skills visible to Claude Code in this environment. REPORT-ONLY: the maker
// runs with a restricted `--tools` surface that has no Skill tool, and managed
// grounding passes `--setting-sources ''`, so a loop cannot invoke any of these
// today. They are surfaced for orientation only — reporting them as usable
// would advertise capability the loop does not have.
export function listSkills({ home = homedir(), cwd = process.cwd() } = {}) {
  const found = new Map();
  for (const skill of readSkillDir(join(home, '.claude', 'skills'), 'user')) found.set(skill.name, skill);
  // Studio normally starts from apps/loop-studio, while Claude's project
  // settings live at the repository root. Walk only to the nearest git root;
  // checking cwd alone made real project skills disappear from the report.
  const start = resolve(cwd);
  let projectRoot = start;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { projectRoot = dir; break; }
    if (dirname(dir) === dir) break;
  }
  // Project skills shadow user skills of the same name, matching Claude Code.
  for (const skill of readSkillDir(join(projectRoot, '.claude', 'skills'), 'project')) found.set(skill.name, skill);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

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

  // The seat decisions drive which CLIs a run will actually spawn. A broken
  // decision record leaves them null; the models check below reports the error
  // and every CLI stays required (fail closed toward "needed").
  const hm = hivemindStatus();
  let seatDecisions = null;
  try { seatDecisions = getModels(); } catch { /* reported by the models check */ }
  const claudeUsed = !seatDecisions
    || seatDecisions.maker.backend === 'claude'
    || seatDecisions.reviewer.backend === 'claude'
    || hm.mode === 'claude'; // managed-connector retrieval spawns claude regardless of seats
  const codexUsed = !seatDecisions
    || seatDecisions.maker.backend === 'codex'
    || seatDecisions.reviewer.backend === 'codex';

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
  // A CLI backend no current seat decision uses stays visible but optional:
  // its absence must not block the runs the decisions actually describe.
  const unusedNote = ' · not used by the current seat decisions (the Build lane still needs it)';
  add(
    'claude', 'Claude CLI backend', !!claudeV && claudeAuthed !== false,
    (!claudeV ? 'not found on PATH; the claude backend cannot run'
      : claudeAuthed === false ? `${claudeV} installed, but not signed in`
      : `${claudeV}${claudeAuthed ? ' · signed in' : ''}`) + (claudeUsed ? '' : unusedNote),
    !claudeV ? 'npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in'
      : claudeAuthed === false ? 'claude   # opens the sign-in flow' : null,
    { auth: claudeAuthed, ...(claudeUsed ? {} : { optional: true }) },
  );
  add(
    'codex', 'Codex CLI backend', !!codexV && codexAuthed !== false,
    (!codexV ? 'not found on PATH; the codex backend cannot run'
      : codexAuthed === false ? `${codexV} installed, but not signed in`
      : `${codexV}${codexAuthed ? ' · signed in' : ''}`) + (codexUsed ? '' : unusedNote),
    !codexV ? 'npm install -g @openai/codex   # then run `codex` once and sign in'
      : codexAuthed === false ? 'codex login' : null,
    { auth: codexAuthed, ...(codexUsed ? {} : { optional: true }) },
  );

  // Opt-in openai_compat backends: each declared entry gets its own check.
  // Required exactly when a seat decision names it; the key itself is only
  // ever read from the environment, never printed.
  try {
    for (const backend of Object.values(listBackends())) {
      if (backend.kind !== 'openai_compat') continue;
      const used = seatDecisions && (seatDecisions.maker.backend === backend.name || seatDecisions.reviewer.backend === backend.name);
      const keyPresent = !!process.env[backend.apiKeyEnv];
      let reach = null; // null = not probed (deep only), true/false = probed
      if (deep && keyPresent) {
        reach = await fetch(`${backend.baseUrl}/models`, {
          headers: { authorization: `Bearer ${process.env[backend.apiKeyEnv]}` },
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.ok, () => false);
      }
      add(
        `backend-${backend.name}`, `Backend "${backend.name}" (${backend.provider})`,
        keyPresent && reach !== false,
        `${backend.baseUrl} · ${backend.models.length} declared model${backend.models.length === 1 ? '' : 's'} · ${keyPresent ? `${backend.apiKeyEnv} set` : `${backend.apiKeyEnv} NOT set`}${reach === true ? ' · endpoint reachable' : reach === false ? ' · endpoint unreachable' : ''}${used ? '' : ' · not used by the current seat decisions'}`,
        keyPresent ? null : `export ${backend.apiKeyEnv}=…   # the key never enters config or receipts`,
        used ? {} : { optional: true },
      );
    }
  } catch (err) {
    add('backends', 'Configured backends', false, err.message, 'fix the backends entry in checks/models.json');
  }
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
    { optional: true },
  );

  try {
    const models = seatDecisions ?? getModels();
    let note = modelsSummary();
    note += `. Sources: maker ${models.maker.source}, reviewer ${models.reviewer.modelSource}.`;
    if (models.reviewer.backend === 'codex') {
      try {
        const { readFileSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const cache = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, 'utf8'));
        const slugs = (cache.models ?? []).map((m) => m.slug).filter(Boolean);
        if (slugs.length && !slugs.includes(models.reviewer.model)) {
          note += ` Reviewer "${models.reviewer.model}" is not in codex's model cache (${slugs.slice(0, 3).join(', ')}…); a run may fail at review.`;
        }
      } catch { /* cache absent — cannot judge, stay quiet */ }
    }
    add('models', 'Model decisions', true, note, null);
  } catch (err) {
    add('models', 'Model decisions', false, err.message, 'open Settings in the studio and pick the models');
  }

  // The seat catalog, as the pickers and the run-request validator see it —
  // the doctor states what may sit in each seat so a decision is checkable
  // before anything runs. Advisory: an empty compat list is a config question,
  // never a gate on the runs the current decisions describe.
  try {
    const seats = seatCatalog();
    const summarize = (entries) => {
      const byBackend = new Map();
      for (const entry of entries) {
        if (!byBackend.has(entry.backend)) byBackend.set(entry.backend, []);
        byBackend.get(entry.backend).push(entry.model);
      }
      return [...byBackend.entries()].map(([backend, models]) =>
        `${backend}(${models.length <= 3 ? models.join(', ') : `${models.length} models`})`).join(' · ');
    };
    add('catalog', 'Seat catalog', true,
      `maker: ${summarize(seats.maker)}; reviewer: ${summarize(seats.reviewer)} — reviewer list ${seats.reviewerSource === 'codex_cache' ? 'CLI-verified from the codex cache' : 'a conservative fallback'}`,
      null, { advisory: true, seats });
  } catch (err) {
    add('catalog', 'Seat catalog', false, err.message, 'fix the backends entry in checks/models.json', { advisory: true });
  }
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
      { optional: true },
    );
  } else {
    add(
      'hivemind', 'Hivemind grounding', hm.connected,
      hm.connected ? `${hm.mode}: ${hm.base}` : 'not connected. Myosin’s Hivemind (staging) is optional; runs proceed ungrounded.',
      hm.connected ? null : 'optional: HIVEMIND_VIA_CLAUDE=1 (Claude connector) or HIVEMIND_MCP_URL + HIVEMIND_API_KEY',
      { optional: true },
    );
  }

  const skills = listSkills();
  add(
    'skills', 'Skills in this environment', true,
    skills.length
      ? `${skills.length} found (${skills.slice(0, 3).map((s) => s.name).join(', ')}${skills.length > 3 ? ', …' : ''}). Listed for reference: loops run with a restricted tool surface and cannot invoke them yet.`
      : 'none found. Loops do not use skills yet.',
    null,
    { skills, advisory: true },
  );

  // A check is required unless it says otherwise: hivemind/gate are optional
  // (words lanes run without them), skills and the catalog are informational,
  // and a CLI or backend no current seat decision uses must not gate the runs
  // the decisions actually describe.
  const required = checks.filter((c) => !c.optional && !c.advisory);
  return {
    engine,
    ok: engine === 'mock' || required.every((c) => c.ok),
    checks,
  };
}
