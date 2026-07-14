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

export function claudeToolSurface({ stage, hivemindEnabled = false, serverName = 'claude_ai_Hivemind_Staging', toolName }) {
  const builtins = stage === 'plan' ? '' : 'WebSearch,WebFetch';
  // Claude.ai connectors are deferred: ToolSearch must load the selected
  // managed tool before the model can call it. The exact selection keeps every
  // other connected service outside the model's tool surface.
  const mcpTools = hivemindEnabled ? `ToolSearch,${toolName || `mcp__${serverName}__knowledge_search`}` : '';
  const tools = [builtins, mcpTools].filter(Boolean).join(',');
  return { tools, allowed: tools };
}

// One stream-json line in, at most one human-readable session line out.
// Exported for tests.
export function sessionLineFromEvent(ev) {
  if (ev?.type !== 'assistant') return null;
  for (const item of ev.message?.content ?? []) {
    if (item.type === 'tool_use') {
      const input = item.input ?? {};
      const arg = input.query ?? input.url ?? input.prompt ?? input.command ?? input.file_path ?? input.path ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
      const name = item.name.replace(/^mcp__.+?__/, '');
      return `${name}: ${String(arg).slice(0, 110)}`;
    }
  }
  return null;
}

export async function runClaude({ prompt, stage = 'make', cwd, signal, onTick, onSession, model }) {
  const hm = stage === 'plan' ? { enabled: false } : viaClaude();
  const { tools, allowed } = claudeToolSurface({ stage, hivemindEnabled: hm.enabled, serverName: hm.serverName, toolName: hm.toolName });
  const maxTurns = stage === 'plan' ? '1' : stage === 'fix' ? '12' : '20';

  // The model is always named explicitly — never the CLI's configured default.
  // --tools RESTRICTS the built-in surface (plan: none; research: web plus
  // the selected Hivemind connector); --allowedTools pre-approves what
  // remains so headless runs don't stall on permissions.
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', maxTurns,
    '--model', model || getModels().maker.model,
    // --tools defines what EXISTS; --allowedTools only pre-approves that
    // surface. Omitting MCP from --tools made a connected Hivemind impossible
    // to call even though it was allowed (golden-run P1, 2026-07-14).
    '--tools', tools,
  ];
  if (hm.enabled) {
    // Managed Claude.ai connectors authenticate through Anthropic's proxy;
    // re-adding the raw endpoint under a local alias does not inherit OAuth.
    // An empty settings-source list excludes user/local/project MCP entries
    // while Claude.ai connectors remain available. --tools still exposes only
    // WebSearch/WebFetch/ToolSearch and the one selected Hivemind tool.
    args.push('--setting-sources', '');
  } else args.push('--strict-mcp-config');
  if (allowed) args.push('--allowedTools', allowed);

  const { exitCode, stdout, stderr, resultEvent, hivemindQueries, hivemindQueryTexts } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let lineBuf = '';
    let result = null;
    let hmQueries = 0;
    const hmQueryTexts = [];
    let done = false;
    const finish = (code) => {
      if (!done) { done = true; clearTimeout(t); clearInterval(tick); resolve({ exitCode: code, stdout: out, stderr: err, resultEvent: result, hivemindQueries: hmQueries, hivemindQueryTexts: hmQueryTexts }); }
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
          if (hm.enabled && ev.type === 'assistant') {
            for (const item of ev.message?.content ?? []) {
              if (item.type === 'tool_use' && item.name?.startsWith(`mcp__${hm.serverName}__`)) {
                hmQueries += 1;
                if (typeof item.input?.query === 'string') hmQueryTexts.push(item.input.query.slice(0, 300));
              }
            }
          }
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
  return {
    ok: true,
    error: null,
    text,
    costUsd: Number(data.total_cost_usd) || 0,
    // This proves the maker actually invoked the configured connector. It does
    // not claim that every returned chunk was relevant or correct; the [Hn]
    // citation gate remains responsible for that evidence-level judgement.
    hivemindQueried: hivemindQueries > 0,
    hivemindQueries,
    hivemindQueryTexts,
  };
}
