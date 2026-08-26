// Claude maker adapter — headless Claude Code (`claude -p`) as the drafting
// model. The tool surface is RESTRICTED with --tools (not just pre-approved
// with --allowedTools, which doesn't remove tools): research stages get
// WebSearch/WebFetch (+ hivemind MCP tools in via-claude mode), the plan
// stage gets no tools at all. The maker can read the web but cannot touch
// the machine — including reads.

import { spawn } from 'node:child_process';
import { getModels } from '../models.mjs';
import { viaClaude } from './hivemind.mjs';

const TIMEOUTS = { plan: 120_000, ground: 300_000, make: 540_000, fix: 420_000 };

function fail(error) {
  return { ok: false, error, text: null, costUsd: 0 };
}

// Claude's stream starts with a large `system/init` object. Taking the first N
// bytes on a non-zero exit therefore hides the terminal error — exactly the
// information an operator needs to distinguish model availability, auth, quota,
// and a CLI fault. Extract only known error-bearing fields, prefer the terminal
// result event, and redact credential-shaped text before it reaches events.jsonl.
// We intentionally do not fall back to assistant/user content because that can
// contain the private prompt or deliverable.
function redactClaudeDiagnostic(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer ‹redacted›')
    .replace(/\b(sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,}/gi, '$1-‹redacted›')
    .replace(/("?(?:authorization|api[_-]?key|token)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1‹redacted›');
}

function boundedDiagnostic(value, max = 600) {
  const text = redactClaudeDiagnostic(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const side = Math.floor((max - 3) / 2);
  return `${text.slice(0, side)}…${text.slice(-side)}`;
}

export function claudeFailureDiagnostic({ stderr = '', stdout = '', resultEvent = null } = {}) {
  const candidateFrom = (ev) => {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.trim()) return ev.result;
    if (ev.type === 'error') {
      if (typeof ev.error === 'string' && ev.error.trim()) return ev.error;
      if (typeof ev.error?.message === 'string' && ev.error.message.trim()) return ev.error.message;
      if (typeof ev.message === 'string' && ev.message.trim()) return ev.message;
    }
    return null;
  };

  const candidates = [candidateFrom(resultEvent), String(stderr).trim()].filter(Boolean);
  let lastEvent = null;
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]);
      lastEvent ??= event;
      const candidate = candidateFrom(event);
      if (candidate) candidates.push(candidate);
    } catch { /* non-JSON stream noise is not safe diagnostic content */ }
  }
  if (candidates.length) return boundedDiagnostic(candidates[0]);
  const eventLabel = lastEvent
    ? [lastEvent.type, lastEvent.subtype].filter((part) => typeof part === 'string' && part).join('/')
    : null;
  return eventLabel
    ? `no terminal error detail (last Claude event: ${boundedDiagnostic(eventLabel, 120)})`
    : 'no terminal error detail from Claude CLI';
}

// Redirect-isolation contract for EVERY headless Claude spawn (maker AND
// reviewer). A built-in claude seat is Camus's own decision, so the child must
// NOT inherit ambient routing/credential redirection from the operator's shell.
// We build a FRESH environment by DEFAULT-DENY: copy only a closed pass-set of
// names, then always assert host ownership of routing + memory. This scrubbed
// spawn is exactly what lets identity.mjs mark claude_cli redirect-isolation as
// proven (Task 9) — the pre-flip adapter spawned with no `env` option, so an
// inherited ANTHROPIC_BASE_URL could silently re-point the whole seat.
//
// Why a PASS-SET and not a denylist: a denylist has to enumerate every current
// AND future redirect knob — ANTHROPIC_BASE_URL (request-routing override) and
// ANTHROPIC_AUTH_TOKEN (gateway/proxy bearer auth) from
// https://code.claude.com/docs/en/env-vars and https://code.claude.com/docs/en/team,
// the whole *_BASE_URL / CLAUDE_CODE_USE_* provider family, ANTHROPIC_MODEL and
// the ANTHROPIC_DEFAULT_*_MODEL variants, HTTP(S)_PROXY, CLAUDE_CONFIG_DIR — and
// a single new CLI release adds one and silently re-opens the hole. Copying only
// known-safe names closes them all by construction, so we never inspect or log
// any value.
//
//   - ANTHROPIC_API_KEY is direct pay-per-use API auth and is deliberately NOT
//     forwarded. The built-in Claude backend is `vendor_managed`: it should use
//     the operator's Claude Code login (macOS Keychain through HOME), not let an
//     unrelated shell key silently override Max/subscription billing.
//     CLAUDE_CODE_OAUTH_TOKEN and its refresh/scopes companions are the
//     documented subscription automation credentials and remain the only auth
//     variables forwarded — never ANTHROPIC_AUTH_TOKEN, which points at a
//     gateway/proxy.
//   - CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is deliberately NOT forwarded or
//     injected. Current Claude Code treats it as provider-hosted mode and stops
//     consulting the macOS Keychain, so a valid claude.ai Max login becomes
//     "Not logged in". Camus owns routing through the closed env pass-set,
//     explicit --model, empty --setting-sources, and restricted --tools instead.
//   - CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 prevents creating/loading auto memory.
//     It is always overwritten to the literal "1", never inherited.
const CLAUDE_ENV_PASS_SET = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
];
export function claudeDirectEnv(parentEnv = process.env) {
  const out = {};
  for (const name of CLAUDE_ENV_PASS_SET) {
    const value = parentEnv[name];
    if (value !== undefined) out[name] = value; // presence-gated copy; value never examined
  }
  // Host-owned memory constant: overwrite/add unconditionally, never inherit.
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}

export function claudeToolSurface({ stage, hivemindEnabled = false, serverName = 'claude_ai_Hivemind_Staging', toolName, toolPolicy = 'research' }) {
  const builtins = stage === 'plan' || !['research', 'web_only'].includes(toolPolicy) ? '' : 'WebSearch,WebFetch';
  // Claude.ai connectors are deferred: ToolSearch must load the selected
  // managed tool before the model can call it. The exact selection keeps every
  // other connected service outside the model's tool surface.
  const mcpTools = hivemindEnabled && toolPolicy !== 'web_only'
    ? `ToolSearch,${toolName || `mcp__${serverName}__knowledge_search`}`
    : '';
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

// Parse only the structured result shape returned by Hivemind. The auditor
// receives bounded excerpts; the full CLI stream remains ephemeral and is
// never dumped into Studio's receipts wholesale.
export function parseHivemindToolResult(content, query = '') {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
      : '';
  if (!text) return [];
  try {
    const payload = JSON.parse(text);
    const chunks = payload?.data?.chunks ?? payload?.chunks ?? payload?.results ?? [];
    return (Array.isArray(chunks) ? chunks : []).slice(0, 4).map((chunk) => ({
      query: String(payload?.data?.query ?? payload?.query ?? query).slice(0, 300),
      title: String(chunk?.title ?? 'Untitled Hivemind result').slice(0, 240),
      author: chunk?.author == null ? null : String(chunk.author).slice(0, 160),
      ref: chunk?.chunk_id ?? chunk?.notion_id ?? chunk?.id ?? null,
      score: typeof chunk?.score === 'number' ? chunk.score : null,
      excerpt: String(chunk?.content ?? chunk?.text ?? '').slice(0, 1200),
    })).filter((item) => item.excerpt);
  } catch {
    return [];
  }
}

export async function runClaude({ prompt, stage = 'make', cwd, signal, onTick, onSession, model, toolPolicy = 'research' }) {
  const configuredHm = stage === 'plan' || ['none', 'web_only'].includes(toolPolicy) ? { enabled: false } : viaClaude();
  const hm = toolPolicy === 'hivemind_only' && !configuredHm.enabled ? { enabled: false } : configuredHm;
  const { tools, allowed } = claudeToolSurface({ stage, hivemindEnabled: hm.enabled, serverName: hm.serverName, toolName: hm.toolName, toolPolicy });
  const maxTurns = stage === 'plan' ? '1' : stage === 'ground' ? '8' : stage === 'fix' ? '12' : '20';

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
  // --setting-sources '' (empty user/project/local sources,
  // https://code.claude.com/docs/en/cli-usage) is UNCONDITIONAL now: the seat
  // never reads the operator's settings, whether or not Hivemind is on. When
  // Hivemind is off we ALSO keep --strict-mcp-config to exclude any other MCP
  // config; with Hivemind on, an empty settings-source list already excludes
  // user/local/project MCP entries while Claude.ai connectors stay available,
  // and --tools still exposes only WebSearch/WebFetch/ToolSearch and the one
  // selected Hivemind tool. Managed Claude.ai connectors authenticate through
  // Anthropic's proxy; re-adding the raw endpoint under a local alias does not
  // inherit OAuth.
  args.push('--setting-sources', '');
  if (!hm.enabled) args.push('--strict-mcp-config');
  if (allowed) args.push('--allowedTools', allowed);

  const startedAt = Date.now();
  const { exitCode, stdout, stderr, resultEvent, hivemindQueries, hivemindQueryTexts, hivemindResults } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: claudeDirectEnv() });
    let out = '';
    let err = '';
    let lineBuf = '';
    let result = null;
    let hmQueries = 0;
    const hmQueryTexts = [];
    const hmToolUses = new Map();
    const hmResults = [];
    let done = false;
    const finish = (code) => {
      if (!done) { done = true; clearTimeout(t); clearInterval(tick); resolve({ exitCode: code, stdout: out, stderr: err, resultEvent: result, hivemindQueries: hmQueries, hivemindQueryTexts: hmQueryTexts, hivemindResults: hmResults }); }
    };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, TIMEOUTS[stage] ?? 540_000);
    const tick = setInterval(() => onTick?.(stage === 'plan' ? 'planning…' : stage === 'ground' ? 'freezing the knowledge snapshot…' : 'drafting — researching sources…'), 8000);
    child.stdout.on('data', (b) => {
      if (done) return; // an aborted/terminal run must not receive late session lines
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
                const query = typeof item.input?.query === 'string' ? item.input.query.slice(0, 300) : '';
                if (query) hmQueryTexts.push(query);
                if (item.id) hmToolUses.set(item.id, query);
              }
            }
          }
          if (hm.enabled && ev.type === 'user') {
            for (const item of ev.message?.content ?? []) {
              if (item.type !== 'tool_result' || !hmToolUses.has(item.tool_use_id)) continue;
              hmResults.push(...parseHivemindToolResult(item.content, hmToolUses.get(item.tool_use_id)));
            }
          }
          const sess = sessionLineFromEvent(ev);
          if (sess) onSession?.(sess);
        } catch { /* partial or non-JSON line */ }
      }
    });
    child.stderr.on('data', (b) => { if (!done) err += b; });
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish(-4); }, { once: true });
    child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });

  if (exitCode === -1) return fail(`failed to spawn claude (${stderr.trim() || 'unknown'}) — check the Claude Code CLI is installed and on PATH`);
  if (exitCode === -2) return fail(`claude ${stage} stage hit the ${Math.round((TIMEOUTS[stage] ?? 540_000) / 60000)} min timeout`);
  if (exitCode === -4) return fail('aborted by user');
  if (exitCode !== 0) return fail(`claude exited ${exitCode}: ${claudeFailureDiagnostic({ stderr, stdout, resultEvent })}`);

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
  if (data.is_error) return fail(`claude reported an error: ${boundedDiagnostic(data.result)}`);
  const text = String(data.result ?? '').trim();
  if (!text) return fail('claude returned an empty result');
  const observed = usageFromClaudeResult(data, model);
  return {
    ok: true,
    error: null,
    text,
    costUsd: Number(data.total_cost_usd) || 0,
    usage: observed.usage,
    durationMs: Date.now() - startedAt,
    modelActual: observed.modelActual,
    modelActualEvidence: observed.modelActualEvidence,
    // This proves the maker actually invoked the configured connector. It does
    // not claim that every returned chunk was relevant or correct; the [Hn]
    // citation gate remains responsible for that evidence-level judgement.
    hivemindQueried: hivemindQueries > 0,
    hivemindQueries,
    hivemindQueryTexts,
    hivemindResults,
  };
}

// ---- reviewer seat ------------------------------------------------------------
// Claude in the reviewer seat: one toolless turn over the review prompt, and
// the SAME fail-closed normalizeReview as codex — unparseable, incomplete, or
// self-inconsistent output is an infra error, never a clean verdict. No MCP,
// no web, no repo access: the reviewer judges the draft it was handed.
export async function runClaudeReview({ prompt, model, cwd, signal, onTick, onSession, receiptDir, claims = [], criteria = [], thresholds = [] }) {
  const { normalizeReview } = await import('./codex.mjs');
  const infra = (error) => ({
    ran: false, error, verdict: 'ERROR', findings: [], questions: [],
    claimAssessments: [], coverageAssessments: [], thresholdAssessments: [],
    usage: null, durationMs: Date.now() - startedAt,
  });
  const startedAt = Date.now();
  if (!model) return infra('claude reviewer needs an explicit model — the CLI default is not a decision');

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '1',
    '--model', model,
    '--tools', '', // the reviewer seat is toolless: judge the draft, touch nothing
    '--setting-sources', '', // no user/project/local settings (cli-usage), same as the maker seat
    '--strict-mcp-config',
  ];

  // Same idle contract as the codex reviewer: stream-json emits events as the
  // turn progresses, so output-silence beyond the window is a hung call, not a
  // thinking one — killed, and an infra error, never a wait until the hard cap.
  const idleKillMs = Number(process.env.REVIEW_IDLE_MS || 300_000);
  const { exitCode, stdout, stderr, resultEvent } = await new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: claudeDirectEnv() });
    let out = '';
    let err = '';
    let lineBuf = '';
    let result = null;
    let done = false;
    const finish = (code) => {
      if (!done) { done = true; clearTimeout(t); clearTimeout(idleT); clearInterval(tick); resolvePromise({ exitCode: code, stdout: out, stderr: err, resultEvent: result }); }
    };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, 480_000);
    let idleT = setTimeout(() => { child.kill('SIGKILL'); finish(-3); }, idleKillMs);
    const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => { child.kill('SIGKILL'); finish(-3); }, idleKillMs); };
    const tick = setInterval(() => onTick?.('reviewer reading and drafting findings…'), 8000);
    child.stdout.on('data', (b) => {
      if (done) return;
      poke();
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
    child.stderr.on('data', (b) => { if (!done) { poke(); err += b; } });
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish(-4); }, { once: true });
    child.on('error', (e) => { err += `spawn error: ${e.code || e.message}`; finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });

  if (exitCode === -1) return infra(`failed to spawn claude (${stderr.trim() || 'unknown'}) — check the Claude Code CLI is installed and on PATH`);
  if (exitCode === -2) return infra('claude review hit the 8 min hard timeout');
  if (exitCode === -3) return infra(`claude went silent for ${Math.round(idleKillMs / 60000)} min — killed (idle watchdog)`);
  if (exitCode === -4) return infra('review aborted by user');
  if (exitCode !== 0) return infra(`claude exited ${exitCode}: ${claudeFailureDiagnostic({ stderr, stdout, resultEvent })}`);

  let data = resultEvent;
  if (!data) {
    try { data = JSON.parse(stdout); } catch { return infra(`no result event and unparseable claude output: ${stdout.slice(0, 200)}`); }
  }
  if (data.is_error) return infra(`claude reported an error: ${boundedDiagnostic(data.result)}`);
  const text = String(data.result ?? '').trim();
  onSession?.(`verdict drafted (${text.length} chars)`);
  // The raw verdict lands beside the run like codex's -o file, so a skeptic
  // can re-read exactly what the reviewer said before normalization.
  if (receiptDir) {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { resolve: resolvePath, join: joinPath } = await import('node:path');
      const dir = resolvePath(receiptDir);
      await mkdir(dir, { recursive: true });
      await writeFile(joinPath(dir, 'last.json'), text);
    } catch { /* receipts degrade loudly at the server layer; the verdict still normalizes */ }
  }
  const norm = normalizeReview(text, 0, claims, criteria, thresholds);
  const observed = usageFromClaudeResult(data, model);
  norm.usage = observed.usage;
  norm.durationMs = Date.now() - startedAt;
  if (norm.ran) {
    norm.reviewerModel = model;
    norm.reviewerEffort = null; // claude exposes no reasoning-effort request — never a fabricated tier
    norm.reviewerIdentity = observed.modelActual ?? `anthropic:${model}`;
    norm.reviewerActualEvidence = observed.modelActualEvidence;
  }
  return norm;
}

// Claude's result event has changed shape across CLI versions. Keep only
// non-negative observed counters and the actual model identity when the event
// names it. A successful explicitly pinned call falls back to that pin; no
// usage or effort is inferred from price or latency.
export function usageFromClaudeResult(data, requestedModel = null) {
  const rows = [];
  if (data?.modelUsage && typeof data.modelUsage === 'object') {
    for (const [model, usage] of Object.entries(data.modelUsage)) if (usage && typeof usage === 'object') rows.push({ model, usage });
  }
  // modelUsage is the per-model breakdown of the same call. Prefer it over
  // the aggregate usage object; summing both would double-count one request.
  if (!rows.length && data?.usage && typeof data.usage === 'object') rows.push({ model: data.model ?? null, usage: data.usage });
  const number = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  const read = (usage, snake, camel) => number(usage?.[snake] ?? usage?.[camel]);
  const sum = (snake, camel) => {
    const values = rows.map((row) => read(row.usage, snake, camel)).filter((value) => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const models = [...new Set(rows.map((row) => row.model).filter((value) => typeof value === 'string' && value))];
  const observedModel = models.length > 0 || Boolean(typeof data?.model === 'string' && data.model);
  const actualModel = models.length === 1
    ? models[0]
    : models.length > 1
      ? `multiple[${models.sort().join('+')}]`
      : (typeof data?.model === 'string' && data.model ? data.model : requestedModel);
  return {
    usage: {
      input_tokens: sum('input_tokens', 'inputTokens'),
      cached_input_tokens: sum('cache_read_input_tokens', 'cacheReadInputTokens'),
      output_tokens: sum('output_tokens', 'outputTokens'),
    },
    modelActual: actualModel ? `anthropic:${actualModel}` : null,
    modelActualEvidence: observedModel ? 'observed_cli_event' : 'asserted_pin',
  };
}
