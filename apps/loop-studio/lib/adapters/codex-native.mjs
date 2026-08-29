// Native coding tools, not the tool-less JSON file-action adapter. The outer
// Camus engine still owns the candidate, limits, verification and review.
import { CodexRpc } from '../codex-rpc.mjs';
import { nativePolicy, nativeArgs, nativeEnvironment, isolateNativeConfig, preflightNative,
  assertNativeConfig, assertNativeThread, NATIVE_POLICY_VERSION } from '../code-native-policy.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const zero = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });
export function nativeUsage(total, baseline = zero()) {
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']) {
    if (!Number.isSafeInteger(total?.[field]) || total[field] < 0 || total[field] < (baseline[field] ?? 0)) throw new Error('Invalid native usage counters.');
  }
  if (total.cachedInputTokens > total.inputTokens || total.totalTokens !== total.inputTokens + total.outputTokens) throw new Error('Inconsistent native usage counters.');
  return { input_tokens: total.inputTokens - baseline.inputTokens, cached_input_tokens: total.cachedInputTokens - baseline.cachedInputTokens,
    output_tokens: total.outputTokens - baseline.outputTokens, total_tokens: total.totalTokens - baseline.totalTokens };
}
const allowedItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'contextCompaction', 'plan', 'imageView']);
const outputSchema = { type: 'object', additionalProperties: false, required: ['done', 'summary', 'decision'], properties: {
  done: { type: 'boolean' }, summary: { type: 'string' },
  decision: { type: ['object', 'null'], additionalProperties: false, required: ['action', 'reason'], properties: {
    action: { type: 'string', enum: ['human', 'stop', 'retry_verify', 'rebut'] }, reason: { type: 'string' } } },
} };

export async function runNativeCodex({ prompt, model, effort, worktree, scratch, receiptsDir, sourcePath,
  deniedPaths, nativeSession = null, signal, timeoutMs = 600000, onNativeSession = () => {}, onNativeProgress = () => {},
  onTick = () => {}, rpcFactory = options => new CodexRpc(options), environment = nativeEnvironment() }) {
  const startedAt = Date.now();
  let rpc, discovery, session = nativeSession, turnId = null, dispatched = false, ended = false, terminal = null, text = '',
    stopReason = null, stopKind = null, usage = null, responses = 0, actions = 0, previousTotal = -1, latestTotal = nativeSession?.usageTotal ?? zero();
  let finish, interruptTimer;
  const completion = new Promise(resolve => { finish = resolve; });
  const interrupt = (reason, kind = 'refused') => {
    if (stopReason) return;
    stopReason = reason; stopKind = kind;
    if (turnId && rpc) void rpc.request('turn/interrupt', { threadId: session.threadId, turnId }, 3000).catch(() => {});
    interruptTimer = setTimeout(() => { rpc?.fail('Native turn interrupted without a completion receipt.'); finish(); }, 4000);
  };
  const onAbort = () => interrupt('Native execution cancelled.', 'cancel');
  const notify = (method, p) => {
    if (!session || p.threadId && p.threadId !== session.threadId) return;
    if (method === 'model/rerouted') return interrupt('Native model substitution refused.');
    if (method === 'turn/started' && dispatched) {
      if (!uuid(p.turn?.id) || turnId && turnId !== p.turn.id) return interrupt('Native turn identity changed.');
      turnId = p.turn.id; session = { ...session, turnId }; onNativeSession(session);
      if (stopReason) void rpc.request('turn/interrupt', { threadId: session.threadId, turnId }, 3000).catch(() => {});
    }
    if (p.turnId && turnId && p.turnId !== turnId) return;
    if (method === 'thread/tokenUsage/updated' && dispatched && turnId && p.turnId === turnId) {
      usage = nativeUsage(p.tokenUsage?.total, nativeSession?.usageTotal ?? zero());
      latestTotal = p.tokenUsage.total;
      if (usage.total_tokens > previousTotal && usage.total_tokens > 0) { responses++; previousTotal = usage.total_tokens; }
      session = { ...session, usageTotal: latestTotal }; onNativeSession(session);
      const reason = onNativeProgress({ usage, responses, actions });
      if (reason) interrupt(reason, 'budget');
      onTick('Native maker usage recorded.');
    }
    if (dispatched && (method === 'item/started' || method === 'item/completed')) {
      if (!allowedItems.has(p.item?.type)) return interrupt('Native executor attempted an unsupported tool.');
      if (method === 'item/started' && ['commandExecution', 'fileChange'].includes(p.item.type)) {
        actions++; const reason = onNativeProgress({ usage, responses, actions }); if (reason) interrupt(reason, 'budget');
        onTick(p.item.type === 'fileChange' ? 'Native maker editing candidate.' : 'Native maker running a sandboxed command.');
      }
      if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        if (typeof p.item.text !== 'string' || Buffer.byteLength(p.item.text) > 65536) return interrupt('Native completion exceeded the response limit.');
        text = p.item.text;
      }
    }
    if (method === 'turn/completed' && dispatched) {
      if (!turnId || p.turn?.id !== turnId || !['completed', 'interrupted', 'failed'].includes(p.turn.status)) return interrupt('Invalid native completion identity.');
      terminal = p.turn.status; ended = true; finish();
    }
  };
  try {
    if (signal?.aborted) return { ok: false, noModelCalled: true, error: 'Native execution cancelled before preflight.', usage: nativeUsage(zero()) };
    let policy = await nativePolicy({ worktree, scratch, deniedPaths });
    const connection = p => rpcFactory({ args: nativeArgs(p), cwd: p.cwd, env: environment, timeoutMs: timeoutMs + 30000, onNotification: notify });
    discovery = connection(policy);
    policy = await isolateNativeConfig(discovery, policy); await discovery.close(); discovery = null;
    if (session && (session.policyHash !== policy.hash || session.version !== NATIVE_POLICY_VERSION || !uuid(session.threadId))) throw new Error('Native session policy changed; start a new explicitly authorized run.');
    rpc = connection(policy);
    await preflightNative(rpc, policy, { sourcePath, receiptsDir });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (account?.account?.type !== 'chatgpt' || account.requiresOpenaiAuth !== true) throw new Error('Native Codex requires the existing ChatGPT CLI login; no API-key fallback.');
    if (signal?.aborted) throw new Error('Native execution cancelled before generation.');
    const thread = await rpc.request(session ? 'thread/resume' : 'thread/start', {
      ...(session ? { threadId: session.threadId } : {}), model, modelProvider: 'openai', cwd: policy.cwd,
      approvalPolicy: 'never', config: policy.config,
    });
    assertNativeThread(thread, { policy, model, session });
    const effective = await rpc.request('config/read', { includeLayers: false, cwd: policy.cwd });
    assertNativeConfig(effective?.config, { policy });
    session = { version: NATIVE_POLICY_VERSION, threadId: thread.thread.id, policyHash: policy.hash, usageTotal: latestTotal };
    onNativeSession(session); // durable reference before any generation
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (stopReason) throw new Error('Native execution cancelled before generation.');
    dispatched = true;
    const start = await rpc.request('turn/start', { threadId: session.threadId, model, effort, cwd: policy.cwd,
      approvalPolicy: 'never', input: [{ type: 'text', text: prompt }], outputSchema });
    if (!uuid(start?.turn?.id) || turnId && turnId !== start.turn.id) throw new Error('Invalid native turn-start receipt.');
    turnId = start.turn.id; session = { ...session, turnId }; onNativeSession(session);
    await Promise.race([completion, rpc.closed]);
    if (!ended || !usage) return { ok: false, uncertain: true, error: stopReason ?? 'Native completion or usage receipt unavailable.', usage, nativeSession: session };
    if (terminal !== 'completed' || stopReason) return { ok: false, interrupted: true, definitiveTurnEnd: true,
      error: stopReason ?? 'Native turn did not complete.', stopKind: stopKind ?? 'failure', usage, nativeSession: session, usageIncomplete: terminal !== 'completed' };
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('Native final decision was not valid JSON.'); }
    if (!result || typeof result.done !== 'boolean' || typeof result.summary !== 'string'
        || !Object.hasOwn(result, 'decision')
        || result.decision !== null && (typeof result.decision !== 'object' || result.done
          || !['human', 'stop', 'retry_verify', 'rebut'].includes(result.decision.action)
          || typeof result.decision.reason !== 'string' || !result.decision.reason.trim()
          || Object.keys(result.decision).some(k => !['action', 'reason'].includes(k)))
        || Object.keys(result).some(k => !['done', 'summary', 'decision'].includes(k))) throw new Error('Invalid native final decision.');
    return { ok: true, text: JSON.stringify({ actions: [], ...result }), usage, nativeSession: session, definitiveTurnEnd: true,
      modelActual: `openai:${model}`, modelReported: thread.model, modelActualEvidence: 'native_thread_configuration',
      durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 600), uncertain: dispatched && !ended, noModelCalled: !dispatched,
      definitiveTurnEnd: ended, usage: dispatched ? usage : nativeUsage(zero()), nativeSession: session };
  } finally {
    clearTimeout(interruptTimer); signal?.removeEventListener('abort', onAbort);
    if (rpc) await rpc.close(); if (discovery) await discovery.close();
  }
}
