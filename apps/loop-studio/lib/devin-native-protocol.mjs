// Preparation for a native adapter, not catalog admission. In particular, ACP
// model selection and last-inference usage do not establish run-wide provenance.
export const DEVIN_NATIVE_EXECUTOR = 'devin_native';
export const DEVIN_NATIVE_MODEL = 'swe-2-high';
export const DEVIN_NATIVE_VERSION = '3000.10.21';
export const DEVIN_NATIVE_DIGEST = 'e7a86b3d4c8b198e1cbf0cab974b80d1a811f38251ceed28e28c5507ba3949b2';
export const DEVIN_NATIVE_PROTOCOL_VERSION = 'devin-acp-preflight/v1';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Fixed labels only: provider text, file paths, credentials and native arguments
// never enter a persisted diagnostic. These are clues, not root-cause verdicts.
export function classifyDevinToolFailure(tool) {
  const native = tool?._meta?.['cognition.ai/inferenceToolName'];
  const chunks = [tool?.rawOutput, tool?.rawOutput?.error, tool?.rawOutput?.message];
  for (const item of (Array.isArray(tool?.content) ? tool.content : []).slice(0, 32)) {
    chunks.push(item?.text, item?.content?.text);
  }
  const text = chunks.filter(value => typeof value === 'string').map(value => value.slice(0, 2048)).join('\n').slice(0, 8192);
  const categories = [
    ['permission_denied', /permission denied|operation not permitted|EACCES|EPERM/i],
    ['path_unavailable', /no such file|not found|does not exist|ENOENT/i],
    ['metadata_or_symlink', /metadata|canonicaliz|symlink|symbolic link|lstat/i],
    ['prior_read_required', /read.{0,50}(first|before)|not.{0,20}read/i],
    ['stale_file', /modified.{0,30}since|changed.{0,30}since|stale/i],
    ['permission_required', /approval required|permission required|requires.{0,20}approval/i],
    ['match_not_found', /old_string|no match|match.{0,20}not found/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return Object.freeze({ nativeTool: ['read', 'edit', 'write', 'exec'].includes(native) ? native : 'unreported',
    categories: Object.freeze(categories.length ? categories : ['unclassified']),
    textPresent: text.length > 0 });
}

export function assertDevinModelSelection(options, expected = DEVIN_NATIVE_MODEL) {
  if (expected !== DEVIN_NATIVE_MODEL || !Array.isArray(options)) throw new Error('Devin model selection is unproven.');
  const models = options.filter(option => record(option) && option.category === 'model');
  if (models.length !== 1 || models[0].currentValue !== expected) throw new Error('Devin exact model selection changed or is ambiguous.');
  return expected;
}

export function validateDevinSession(opened, expected = DEVIN_NATIVE_MODEL) {
  if (!record(opened) || !id(opened.sessionId)) throw new Error('Devin session identity is invalid.');
  assertDevinModelSelection(opened.configOptions, expected);
  if (opened.models !== undefined && opened.models !== null && opened.models.currentModelId !== expected)
    throw new Error('Devin model selection evidence conflicts.');
  if (opened.modes?.currentModeId !== 'autonomous') throw new Error('Devin sandbox mode is unproven.');
  return Object.freeze({ sessionId: opened.sessionId, modelSelected: expected, mode: 'autonomous',
    modelActual: null, actualModelEvidence: 'unobserved' });
}

// Diagnostics only. Do not feed these counters to the workflow's cumulative
// onNativeProgress ledger or replace its conservative token reservation.
export function inspectDevinUsage(update) {
  const meta = update?._meta;
  const input = meta?.['cognition.ai/inputTokens'], output = meta?.['cognition.ai/outputTokens'];
  const cached = meta?.['cognition.ai/cachedReadTokens'];
  return Object.freeze({ scope: 'unqualified_inference_notification', cumulative: false,
    decorated: record(meta) && Object.hasOwn(meta, 'cognition.ai/subagent_context'),
    countersValid: integer(input) && integer(output) && Number.isSafeInteger(input + output)
      && (cached === undefined || integer(cached) && cached <= input),
    runUsage: null, providerCalls: null });
}

export function createDevinProtocolObserver({ sessionId, model = DEVIN_NATIVE_MODEL, maxObservedTools = 20,
  maxTextBytes = 65536 } = {}) {
  if (!id(sessionId) || model !== DEVIN_NATIVE_MODEL || !Number.isSafeInteger(maxObservedTools)
      || maxObservedTools < 1 || maxObservedTools > 1000 || !Number.isSafeInteger(maxTextBytes)
      || maxTextBytes < 1 || maxTextBytes > 1048576) throw new Error('Invalid Devin observation contract.');
  let text = '', textBytes = 0, progressTextBytes = 0, usageNotifications = 0, decoratedUsageNotifications = 0, consumed = false, failed = false;
  const calls = new Map();
  const reject = message => { failed = true; throw new Error(message); };
  return {
    observe(method, params) {
      if (failed || consumed) return reject('Devin event arrived outside the active observation.');
      if (method !== 'session/update' && method !== '_cognition.ai/turn_stats') return;
      if (!record(params) || params.sessionId !== sessionId) return reject('Devin event crossed the session boundary.');
      // Statistics are not promoted to a billing ledger without a qualified
      // schema and exactly-once binding. Never persist arbitrary dimensions.
      if (method === '_cognition.ai/turn_stats') return;
      const update = params.update;
      if (!record(update) || typeof update.sessionUpdate !== 'string') return reject('Malformed Devin update.');
      if (update.sessionUpdate === 'config_option_update') {
        try { assertDevinModelSelection(update.configOptions, model); }
        catch { return reject('Devin model configuration changed.'); }
      } else if (update.sessionUpdate === 'current_mode_update' && update.currentModeId !== 'autonomous') {
        return reject('Devin execution mode changed.');
      } else if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return reject('Malformed Devin completion text.');
        textBytes += Buffer.byteLength(update.content.text);
        if (textBytes > maxTextBytes) return reject('Devin completion text limit exceeded.');
        text += update.content.text;
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        if (!id(update.toolCallId)) return reject('Devin tool identity is invalid.');
        const previous = calls.get(update.toolCallId);
        if (update.sessionUpdate === 'tool_call' && previous) return reject('Devin reused a tool identity.');
        if (update.sessionUpdate === 'tool_call_update' && !previous) return reject('Devin updated an unknown tool.');
        if (!previous && calls.size >= maxObservedTools) return reject('Devin observed tool limit exceeded.');
        const status = update.status ?? previous?.status ?? 'pending';
        if (!['pending', 'in_progress', 'completed', 'failed'].includes(status)) return reject('Devin tool status is invalid.');
        if (previous && ['completed', 'failed'].includes(previous.status) && status !== previous.status)
          return reject('Devin terminal tool status changed.');
        const base = { ...previous, status, kind: update.kind ?? previous?.kind,
          _meta: update._meta ?? previous?._meta };
        calls.set(update.toolCallId, { ...base, ...(status === 'failed'
          ? { failure: classifyDevinToolFailure({ ...base, ...update }) } : {}) });
        // ACP uses agent_message_chunk for progress as well as completion.
        // Only the uninterrupted text AFTER the last tool event can be a final
        // decision about that work. Never extract JSON from arbitrary prose or
        // reuse a decision emitted before a later tool action. The total byte
        // allowance above remains cumulative across all discarded progress.
        progressTextBytes += Buffer.byteLength(text);
        text = '';
      } else if (update.sessionUpdate === 'usage_update') {
        const usage = inspectDevinUsage(update);
        usageNotifications++;
        if (usage.decorated) decoratedUsageNotifications++;
      }
    },
    diagnostics() {
      return Object.freeze([...calls.values()].filter(call => call.failure).map(call => call.failure));
    },
    finish(response) {
      if (failed || consumed) return reject('Devin terminal observation is invalid or already consumed.');
      consumed = true;
      const terminalReceived = record(response) && typeof response.stopReason === 'string';
      return Object.freeze({ terminalReceived, stopReason: terminalReceived ? response.stopReason : null,
        endTurn: terminalReceived && response.stopReason === 'end_turn',
        completedTools: [...calls.values()].filter(call => call.status === 'completed').length,
        toolsComplete: [...calls.values()].every(call => call.status === 'completed'),
        observedTools: calls.size, text: text.trim(), progressTextBytes,
        completionTextPolicy: 'after-last-tool/v1', usageNotifications, decoratedUsageNotifications,
        usage: null, usageIncomplete: true, providerCalls: null, modelSelected: model, modelActual: null,
        // Observation alone never authorizes candidate adoption or admission.
        qualifiedCompletion: false });
    },
  };
}
