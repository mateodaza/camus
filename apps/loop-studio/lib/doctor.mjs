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

// deep=true adds the slow checks (claude mcp list health round-trip).
export async function runDoctor({ deep = false, engine = 'live' } = {}) {
  const checks = [];
  const add = (id, label, ok, detail, fix = null) => checks.push({ id, label, ok, detail, fix });

  add('node', 'Node.js', true, process.version, null);

  const [claudeV, codexV, gitV] = await Promise.all([
    probe('claude', ['--version']),
    probe('codex', ['--version']),
    probe('git', ['--version']),
  ]);

  add(
    'claude', 'Claude Code CLI', !!claudeV,
    claudeV ?? 'not found on PATH — the maker cannot run',
    claudeV ? null : 'npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in',
  );
  add(
    'codex', 'Codex CLI (the reviewer)', !!codexV,
    codexV ?? 'not found on PATH — nothing can review the drafts',
    codexV ? null : 'npm install -g @openai/codex   # then run `codex` once and sign in',
  );
  add(
    'git', 'git', !!gitV,
    gitV ?? 'not found — reviews will run outside a git repo (different conditions than camus)',
    gitV ? null : 'xcode-select --install   # macOS; or install git from git-scm.com',
  );

  const gate = gateInstalled();
  add(
    'gate', 'Camus gate (Build lane)', gate,
    gate ? 'installed in ~/.claude — the Build lane can ignite it' : 'not installed — the Build lane stays off (words lanes work without it)',
    gate ? null : 'npm install -g camus-cli && camus install',
  );

  let models;
  try {
    models = getModels();
    add('models', 'Model decisions', true, modelsSummary(), null);
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
      hm.connected ? `${hm.mode}: ${hm.base}` : 'not connected — runs proceed ungrounded (optional)',
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
