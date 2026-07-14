// Claude maker adapter — headless Claude Code (`claude -p`) as the drafting
// model. The tool surface is RESTRICTED with --tools (not just pre-approved
// with --allowedTools, which doesn't remove tools): research stages get
// WebSearch/WebFetch (+ hivemind MCP tools in via-claude mode), the plan
// stage gets no tools at all. The maker can read the web but cannot touch
// the machine — including reads.

import { spawn } from 'node:child_process';
import { getModels } from '../models.mjs';
import { viaClaude } from './hivemind.mjs';

const TIMEOUTS = { plan: 120_000, make: 540_000, fix: 420_000 };

function fail(error) {
  return { ok: false, error, text: null, costUsd: 0 };
}

// One stream-json line in, at most one human-readable session line out.
// Exported for tests.
export function sessionLineFromEvent(ev) {
  if (ev?.type !== 'assistant') return null;
  for (const item of ev.message?.content ?? []) {
    if (item.type === 'tool_use') {
      const input = item.input ?? {};
      const arg = input.query ?? input.url ?? input.prompt ?? input.command ?? input.file_path ?? input.path ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
      const name = item.name.replace(/^mcp__[^_]+__/, '');
      return `${name}: ${String(arg).slice(0, 110)}`;
    }
  }
  return null;
}

export async function runClaude({ prompt, stage = 'make', cwd, signal, onTick, onSession, model }) {
  const hm = stage === 'plan' ? { enabled: false } : viaClaude();
  const builtins = stage === 'plan' ? '' : 'WebSearch,WebFetch';
  const mcpTools = hm.enabled
    ? `mcp__${hm.serverName}__knowledge_search,mcp__${hm.serverName}__search,mcp__${hm.serverName}__fetch`
    : '';
  const allowed = [builtins, mcpTools].filter(Boolean).join(',');
  const maxTurns = stage === 'plan' ? '1' : stage === 'fix' ? '12' : '20';

  // The model is always named explicitly — never the CLI's configured default.
  // --tools RESTRICTS the built-in surface (plan: none; research: web only);
  // --allowedTools pre-approves what remains so headless runs don't stall on
  // permissions; --strict-mcp-config keeps MCP to exactly the server we
  // grant in via-claude mode (auth = the token from the human's one-time
  // interactive OAuth).
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', maxTurns,
    '--strict-mcp-config',
    '--model', model || getModels().maker.model,
    '--tools', builtins,
  ];
  if (hm.enabled) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [hm.serverName]: { type: 'http', url: hm.url } } }));
  }
  if (allowed) args.push('--allowedTools', allowed);

  const { exitCode, stdout, stderr, resultEvent } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let lineBuf = '';
    let result = null;
    let done = false;
    const finish = (code) => {
      if (!done) { done = true; clearTimeout(t); clearInterval(tick); resolve({ exitCode: code, stdout: out, stderr: err, resultEvent: result }); }
    };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, TIMEOUTS[stage] ?? 540_000);
    const tick = setInterval(() => onTick?.(stage === 'plan' ? 'planning…' : 'drafting — researching sources…'), 8000);
    child.stdout.on('data', (b) => {
      out += b;
      lineBuf += b;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') result = ev;
          const sess = sessionLineFromEvent(ev);
          if (sess) onSession?.(sess);
        } catch { /* partial or non-JSON line */ }
      }
    });
    child.stderr.on('data', (b) => { err += b; });
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish(-4); }, { once: true });
    child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });

  if (exitCode === -1) return fail(`failed to spawn claude (${stderr.trim() || 'unknown'}) — check the Claude Code CLI is installed and on PATH`);
  if (exitCode === -2) return fail(`claude ${stage} stage hit the ${Math.round((TIMEOUTS[stage] ?? 540_000) / 60000)} min timeout`);
  if (exitCode === -4) return fail('aborted by user');
  if (exitCode !== 0) return fail(`claude exited ${exitCode}: ${(stderr || stdout).slice(0, 300)}`);

  // stream-json: the terminal `result` event carries the final text; fall
  // back to whole-output parse for older CLIs that ignore the format flag.
  let data = resultEvent;
  if (!data) {
    try {
      data = JSON.parse(stdout);
    } catch {
      const start = stdout.indexOf('{');
      try { data = JSON.parse(stdout.slice(start)); } catch { return fail(`no result event and unparseable claude output: ${stdout.slice(0, 200)}`); }
    }
  }
  if (data.is_error) return fail(`claude reported an error: ${String(data.result).slice(0, 300)}`);
  const text = String(data.result ?? '').trim();
  if (!text) return fail('claude returned an empty result');
  return { ok: true, error: null, text, costUsd: Number(data.total_cost_usd) || 0 };
}
