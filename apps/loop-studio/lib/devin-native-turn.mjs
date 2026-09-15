// Shared ACP lifecycle for a future optional adapter. This does not open a CLI,
// grant filesystem authority, admit a seat, or satisfy Build's billing ledger.
// The adapter supplies an isolated RPC factory and separately bounded host tools.
import { createDevinProtocolObserver, validateDevinSession, DEVIN_NATIVE_MODEL, devinRpcFailure } from './devin-native-protocol.mjs';
import { DEVIN_CLIENT_CAPABILITIES } from './devin-native-files.mjs';
import { DevinToolFeedback } from './devin-native-workspace.mjs';

export function devinObservedContract(value) {
  const keys = ['version', 'maxPrompts', 'maxObservedTools', 'maxWallMs', 'billingUncertaintyAccepted'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value.version !== 'devin-observed/v1' || value.maxPrompts !== 1
      || !Number.isSafeInteger(value.maxObservedTools) || value.maxObservedTools < 1 || value.maxObservedTools > 1000
      || !Number.isSafeInteger(value.maxWallMs) || value.maxWallMs < 1 || value.maxWallMs > 1200000
      || value.billingUncertaintyAccepted !== true) throw new Error('Explicit observed-only Devin budget contract required.');
  return Object.freeze({ ...value });
}

export async function runDevinProtocolTurn({ prompt, cwd, contract: inputContract, model = DEVIN_NATIVE_MODEL,
  nativeSession = null, signal, rpcFactory, beforePrompt, onToolRequest, closeTools, onProgress = () => {}, onToolEvent = () => {} }) {
  const contract = devinObservedContract(inputContract);
  if (model !== DEVIN_NATIVE_MODEL || nativeSession !== null || typeof prompt !== 'string' || !prompt.trim()
      || Buffer.byteLength(prompt) > 262144 || typeof cwd !== 'string' || !cwd.startsWith('/')
      || [rpcFactory, beforePrompt, onToolRequest, closeTools, onProgress, onToolEvent].some(fn => typeof fn !== 'function'))
    throw new Error('Invalid fresh Devin turn dependencies or selection; no replay or substitution.');
  let rpc, session, observer, dispatched = false, stopped = null, toolCount = 0, hostCount = 0;
  let observation = null, closeConfirmed = false, toolsClosed = false;
  let protocolStage = 'initialize', rpcFailure = null;
  const active = new Set(), control = new AbortController(), started = Date.now();
  const stop = reason => {
    if (stopped) return;
    stopped = reason; control.abort(); rpc?.fail('Devin bounded turn stopped.');
  };
  const abort = () => stop('cancelled');
  const remaining = () => Math.max(1, contract.maxWallMs - (Date.now() - started));
  const timer = setTimeout(() => stop('deadline'), contract.maxWallMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (stopped) throw new Error('Cancelled before start.');
    rpc = rpcFactory({
      signal: control.signal, timeoutMs: remaining(),
      onNotification(method, params) {
        if (!observer || stopped || observation) return;
        try {
          observer.observe(method, params);
          const update = params?.update;
          if (!dispatched && method === 'session/update'
              && ['tool_call', 'tool_call_update', 'agent_message_chunk'].includes(update?.sessionUpdate)) {
            stop('pre_dispatch_activity'); return;
          }
          if (method === 'session/update' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) onToolEvent(update);
          if (method === 'session/update' && update?.sessionUpdate === 'tool_call') {
            toolCount++;
            onProgress({ observedTools: toolCount, providerCalls: null, runTokens: null });
            if (toolCount >= contract.maxObservedTools) stop('observed_tool_limit');
          }
          if (method === 'session/update' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)
              && update.status === 'failed') stop('tool_failed');
        } catch { stop('protocol_refused'); }
      },
      async onRequest(method, params) {
        if (!dispatched || stopped || observation || params?.sessionId !== session?.sessionId
            || !['session/request_permission', 'fs/read_text_file', 'fs/write_text_file'].includes(method)
            || ++hostCount > contract.maxObservedTools) {
          stop('tool_boundary_refused'); throw new Error('Devin host authority refused.');
        }
        const pending = Promise.resolve().then(() => onToolRequest(method, params, { signal: control.signal }));
        active.add(pending);
        try { return await pending; }
        catch (error) {
          if (error instanceof DevinToolFeedback) throw error; // proven no-effect conflict, never provider prose
          stop('tool_boundary_refused'); throw new Error('Devin host authority refused.');
        }
        finally { active.delete(pending); }
      },
    });
    const initialized = await rpc.request('initialize', { protocolVersion: 1,
      clientCapabilities: DEVIN_CLIENT_CAPABILITIES,
      clientInfo: { name: 'camus_devin', version: '1' } }, Math.min(25000, remaining()));
    if (initialized?.protocolVersion !== 1 || !initialized.authMethods?.some(item => item.id === 'devin-browser'))
      throw new Error('Unsupported ACP authentication.');
    // MCP belongs in private native config, never an unadvertised ACP transport.
    protocolStage = 'session';
    session = validateDevinSession(await rpc.request('session/new', { cwd, mcpServers: [] }, Math.min(25000, remaining())));
    observer = createDevinProtocolObserver({ sessionId: session.sessionId, maxObservedTools: contract.maxObservedTools });
    // Caller must persist a one-shot dispatch marker before acknowledging this.
    // A crash after the marker remains uncertain and is never replayed here.
    protocolStage = 'dispatch';
    await beforePrompt({ sessionId: session.sessionId, modelSelected: model, contract, signal: control.signal });
    if (stopped || Date.now() - started >= contract.maxWallMs) throw new Error('Stopped before prompt.');
    dispatched = true;
    protocolStage = 'prompt';
    const result = await rpc.request('session/prompt', { sessionId: session.sessionId,
      prompt: [{ type: 'text', text: prompt }] }, remaining());
    if (active.size) stop('tool_boundary_refused');
    if (stopped) throw new Error('Stopped prompt.');
    protocolStage = 'completion';
    observation = observer.finish(result);
  } catch (error) {
    rpcFailure = devinRpcFailure(error);
    if (!stopped) stop(dispatched ? 'native_turn_failed' : 'preflight_refused');
  }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); control.abort();
    // Snapshot/drain host work immediately. Waiting for native process exit
    // first could hide a command that was still running at the terminal reply.
    const toolsCleanup = (async () => {
      try {
        const closedTools = await closeTools();
        if (closedTools?.unfinishedAtTerminal === true) stop('tool_boundary_refused');
        await Promise.allSettled([...active]);
        return true;
      } catch { return false; }
    })();
    try { await rpc?.close(); closeConfirmed = true; } catch { closeConfirmed = false; }
    // Never inspect/adopt while a verifier or delegated file request still runs.
    // Host tools must honor cancellation and their own deadlines.
    toolsClosed = await toolsCleanup;
  }
  const cleanupConfirmed = closeConfirmed && toolsClosed;
  const completed = !stopped && cleanupConfirmed && observation?.endTurn === true && observation.toolsComplete;
  return Object.freeze({ execution: completed ? 'completed' : dispatched ? 'uncertain' : 'not_started',
    reason: completed ? null : !cleanupConfirmed ? 'cleanup_unproven' : stopped ?? 'incomplete_terminal',
    promptsSent: dispatched ? 1 : 0, observedTools: toolCount, hostRequests: hostCount,
    terminalReceived: observation?.terminalReceived === true, endTurn: observation?.endTurn === true,
    protocolStage, rpcFailure, stopReason: ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(observation?.stopReason) ? observation.stopReason : null,
    toolFailures: observer?.diagnostics() ?? [],
    cleanupConfirmed, durationMs: Date.now() - started,
    modelSelected: model, modelActual: null, providerCalls: null, runTokens: null, usageIncomplete: true,
    usageNotifications: observation?.usageNotifications ?? null,
    completionTextPolicy: observation?.completionTextPolicy ?? null,
    progressTextBytes: observation?.progressTextBytes ?? null,
    text: observation?.text ?? '', admissionGranted: false, adoptionAuthorized: false,
    // Kept separate from completion; never return a fabricated normal usage object.
    accounting: 'unavailable', budgetContract: contract });
}
