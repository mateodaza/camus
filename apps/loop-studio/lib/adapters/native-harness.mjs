import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runNativeProcess } from '../native-process.mjs';
import { startNativeGateway } from '../native-gateway.mjs';
import { nativeHarnessPolicy, nativeHarnessEnvironment, resolveNativeHarness, assertNativeHarnessVersion,
  assertNativeHarnessArtifact, preflightNativeHarness, QWEN_NATIVE_EXECUTOR, GROK_NATIVE_EXECUTOR, HARNESS_POLICY_VERSION } from '../native-harness-policy.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const outputSchema = { type: 'object', additionalProperties: false, required: ['done', 'summary', 'decision'], properties: {
  done: { type: 'boolean' }, summary: { type: 'string' },
  decision: { type: ['object', 'null'], additionalProperties: false, required: ['action', 'reason'], properties: {
    action: { type: 'string', enum: ['human', 'stop', 'retry_verify', 'rebut'] }, reason: { type: 'string' } } },
} };
const prohibitedTool = /(?:web[_-]?(?:search|fetch)|mcp|search_tool|use_tool|subagent|task)/i;

export function validateNativeDecision(result) {
  if (!result || typeof result.done !== 'boolean' || typeof result.summary !== 'string' || Buffer.byteLength(result.summary) > 2000
      || !Object.hasOwn(result, 'decision')
      || result.decision !== null && (typeof result.decision !== 'object' || result.done
        || !['human', 'stop', 'retry_verify', 'rebut'].includes(result.decision.action)
        || typeof result.decision.reason !== 'string' || !result.decision.reason.trim() || result.decision.reason.length > 2000
        || Object.keys(result.decision).some(key => !['action', 'reason'].includes(key)))
      || Object.keys(result).some(key => !['done', 'summary', 'decision'].includes(key))) throw new Error('Invalid native final decision.');
  return result;
}

async function grokConfig({ policy, gateway, model }) {
  const home = join(policy.home, 'grok'); await mkdir(home, { recursive: true, mode: 0o700 });
  const table = JSON.stringify(model);
  await writeFile(join(home, 'config.toml'), `[cli]\nauto_update = false\n[session]\nload_envrc = false\n[models]\ndefault = ${table}\nallowed_models = [${table}]\nmax_retries = 0\n[model.${table}]\nmodel = ${table}\nbase_url = ${JSON.stringify(gateway.url)}\nenv_key = "CAMUS_NATIVE_GATEWAY_TOKEN"\napi_backend = "chat_completions"\nsupports_backend_search = false\nsupports_reasoning_effort = false\nmax_retries = 0\n`, { mode: 0o600 });
  return home;
}

function qwenArgs({ model, prompt, session }) {
  return ['--bare', '--safe-mode', '--auth-type', 'openai', '--model', model, '--approval-mode', 'yolo',
    '--max-session-turns', '32', '--max-tool-calls', '128', '--max-wall-time', '15m', '--output-format', 'stream-json',
    '--json-schema', JSON.stringify(outputSchema), ...(session.resumed ? ['--resume', session.sessionId] : ['--session-id', session.sessionId]), '-p', prompt];
}
function grokArgs({ policy, model, effort, prompt, session }) {
  return ['--cwd', policy.cwd, '--model', model, '--always-approve', '--tools', 'Bash,Read,Edit,Grep',
    '--disallowed-tools', 'MCPTool,WebFetch,WebSearch,Task', '--no-plan', '--no-subagents', '--disable-web-search', '--max-turns', '32',
    ...(effort ? ['--reasoning-effort', effort] : []), ...(session.resumed ? ['--resume', session.sessionId] : ['--session-id', session.sessionId]),
    '--output-format', 'streaming-json', '-p', prompt];
}

export async function runNativeHarness({ executor, prompt, model, effort, backend, expectedReported, worktree, scratch, receiptsDir, sourcePath,
  deniedPaths = [], nativeSession = null, signal, timeoutMs = 600000, onNativeSession = () => {}, onNativeProgress = () => {}, onTick = () => {},
  maxModelCalls = 32, remainingTokens, gatewayFactory = startNativeGateway, processRunner = runNativeProcess }) {
  const startedAt = Date.now(); let gateway = null, dispatched = false, terminal = null, result = null, actions = 0, frames = 0;
  const local = new AbortController(); let stopReason = null;
  const stop = reason => { if (!stopReason) stopReason = String(reason); local.abort(new Error(stopReason)); };
  const externalAbort = () => stop('Native execution cancelled.');
  signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
  try {
    const harness = await resolveNativeHarness(executor);
    const artifactDigest = await assertNativeHarnessArtifact(executor, harness);
    gateway = await gatewayFactory({ entry: backend, model, expectedReported, signal: local.signal, maxCalls: maxModelCalls, remainingTokens,
      onTick, onProgress: progress => { const reason = onNativeProgress({ ...progress, actions }); if (reason) stop(reason); return reason; } });
    const policy = await nativeHarnessPolicy({ executor, worktree, scratch, harness, artifactDigest, gatewayPort: gateway.port, deniedPaths });
    const env = { ...nativeHarnessEnvironment({ executor, policy, gateway }) };
    if (executor === QWEN_NATIVE_EXECUTOR) Object.assign(env, { QWEN_HOME: join(policy.home, 'qwen'), QWEN_RUNTIME_DIR: join(policy.temp, 'runtime'),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: join(policy.home, 'qwen-system.json'), QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(policy.home, 'qwen-defaults.json'),
      QWEN_CODE_DISABLE_PRECONNECT: '1', QWEN_CODE_DISABLE_AUTO_UPDATE: '1', SEATBELT_PROFILE: 'permissive-open' });
    else {
      env.GROK_HOME = await grokConfig({ policy, gateway, model }); env.GROK_DISABLE_AUTOUPDATER = '1'; env.GROK_MEMORY = '0';
      env.GROK_SUBAGENTS = '0'; env.GROK_TOOL_SEARCH = '0'; env.GROK_WEB_FETCH = '0'; env.GROK_LSP_TOOLS = '0';
      for (const vendor of ['CLAUDE', 'CURSOR']) for (const feature of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) env[`GROK_${vendor}_${feature}_ENABLED`] = '0';
    }
    const harnessVersion = await assertNativeHarnessVersion({ executor, policy, env, signal: local.signal });
    await preflightNativeHarness({ policy, env, gateway, sourcePath, receiptsDir, signal: local.signal });
    if (stopReason) throw new Error(stopReason);
    if (nativeSession && (nativeSession.version !== HARNESS_POLICY_VERSION || nativeSession.executor !== executor
        || nativeSession.policyHash !== policy.hash || nativeSession.model !== model || nativeSession.harnessVersion !== harnessVersion
        || !uuid(nativeSession.sessionId))) throw new Error('Native harness session policy changed; start a new explicitly authorized run.');
    const session = { version: HARNESS_POLICY_VERSION, executor, policyHash: policy.hash, model, harnessVersion,
      sessionId: nativeSession?.sessionId ?? randomUUID(), resumed: Boolean(nativeSession) };
    onNativeSession({ ...session, resumed: undefined });
    const handle = frame => {
      frames++; if (frames > 100000) throw new Error('Native frame limit exceeded.');
      if (executor === QWEN_NATIVE_EXECUTOR) {
        if (!['system', 'stream_event', 'assistant', 'user', 'result'].includes(frame.type)) throw new Error('Unexpected Qwen Code protocol frame.');
        if (frame.session_id && frame.session_id !== session.sessionId) throw new Error('Qwen Code session identity changed.');
        if (frame.type === 'system' && (frame.subtype !== 'init' || frame.model !== model)) throw new Error('Qwen Code model identity changed.');
        if (frame.type === 'assistant' && frame.message?.model !== model) throw new Error('Qwen Code message model identity changed.');
        if (frame.type === 'assistant') for (const item of frame.message?.content ?? []) if (item?.type === 'tool_use') {
          if (prohibitedTool.test(item.name ?? '')) throw new Error('Qwen Code attempted an unsupported tool.');
          if (item.name !== 'structured_output') { actions++; onTick('Native maker used a sandboxed tool.'); }
        }
        if (frame.type === 'result') {
          if (terminal) throw new Error('Duplicate Qwen Code terminal.');
          terminal = frame; if (frame.subtype === 'success' && frame.is_error === false) result = validateNativeDecision(frame.structured_result);
        }
      } else {
        if (!['available_commands', 'usage', 'tool_call', 'tool_call_update', 'text', 'end'].includes(frame.type)) throw new Error('Unexpected Grok Build protocol frame.');
        if (frame.type === 'tool_call') {
          if (prohibitedTool.test(frame.toolName ?? frame.title ?? '')) throw new Error('Grok Build attempted an unsupported tool.');
          actions++; onTick('Native maker used a sandboxed tool.');
        }
        if (frame.type === 'text') {
          if (typeof frame.data !== 'string' || Buffer.byteLength(frame.data) > 65536) throw new Error('Grok Build completion exceeded the response limit.');
          if (result) throw new Error('Duplicate Grok Build completion.');
          result = validateNativeDecision(JSON.parse(frame.data));
        }
        if (frame.type === 'end') { if (terminal) throw new Error('Duplicate Grok Build terminal.'); terminal = frame; }
      }
      const reason = onNativeProgress({ usage: gateway.state.usageIncomplete ? null : gateway.state.usage, responses: gateway.state.calls, actions });
      if (reason) stop(reason);
    };
    dispatched = true;
    const args = executor === QWEN_NATIVE_EXECUTOR ? qwenArgs({ model, prompt, session }) : grokArgs({ policy, model, effort, prompt, session });
    const run = await processRunner({ command: '/usr/bin/sandbox-exec', args: ['-p', policy.profile, policy.harness, ...args], cwd: policy.cwd,
      env, timeoutMs, signal: local.signal, jsonl: true, onFrame: handle });
    const definitive = executor === QWEN_NATIVE_EXECUTOR
      ? terminal?.subtype === 'success' && terminal?.is_error === false
      : terminal?.stopReason === 'end_turn' && terminal?.sessionId === session.sessionId
        && terminal?.modelUsage && Object.keys(terminal.modelUsage).length === 1
        && Number.isSafeInteger(terminal.modelUsage[model]?.modelCalls)
        && terminal.modelUsage[model].modelCalls > 0;
    if (run.code !== 0 || !definitive || !result || stopReason || gateway.state.stopped) return { ok: false, interrupted: Boolean(terminal),
      uncertain: !terminal, definitiveTurnEnd: Boolean(terminal), error: stopReason ?? gateway.state.stopped ?? 'Native harness did not produce a successful terminal.',
      stopKind: stopReason ? 'budget' : 'failure', usage: gateway.state.usageIncomplete ? null : gateway.state.usage,
      usageIncomplete: gateway.state.usageIncomplete, nativeSession: { ...session, resumed: undefined } };
    if (!gateway.state.calls || !gateway.state.reportedModels.size) throw new Error('Native gateway did not observe model identity evidence.');
    return { ok: true, text: JSON.stringify({ actions: [], ...result }), usage: gateway.state.usageIncomplete ? null : gateway.state.usage,
      usageIncomplete: gateway.state.usageIncomplete, nativeSession: { ...session, resumed: undefined }, definitiveTurnEnd: true,
      modelActual: `${backend.provider}:${model}`, modelReported: [...gateway.state.reportedModels].join(','),
      modelActualEvidence: 'native_gateway_observed_response', durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 600), uncertain: dispatched && !terminal, noModelCalled: !dispatched,
      definitiveTurnEnd: Boolean(terminal), usage: gateway?.state.usageIncomplete ? null : gateway?.state.usage ?? null,
      usageIncomplete: gateway?.state.usageIncomplete ?? false, nativeSession };
  } finally {
    signal?.removeEventListener('abort', externalAbort); await gateway?.close();
  }
}

export const runNativeQwen = options => runNativeHarness({ ...options, executor: QWEN_NATIVE_EXECUTOR });
export const runNativeGrok = options => runNativeHarness({ ...options, executor: GROK_NATIVE_EXECUTOR });
