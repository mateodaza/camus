// Optional Devin native maker composition. Public launch/admission is separate.
// Existing login, scoped native edits, host MCP tools, no API substitution.
import { mkdir, mkdtemp, realpath, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareDevinContext } from '../devin-native-context.mjs';
import { createDevinWorkspace, isDevinVisiblePath, DevinToolFeedback } from '../devin-native-workspace.mjs';
import { runDevinProtocolTurn, devinObservedContract } from '../devin-native-turn.mjs';
import { startDevinMcp } from '../devin-native-mcp.mjs';
import { createDevinFileHandlers } from '../devin-native-files.mjs';
import { DEVIN_NATIVE_MODEL, DEVIN_NATIVE_DIGEST, publicDevinDiagnostic, parseDevinDecisionText, devinDiscardableStop } from '../devin-native-protocol.mjs';
import { CodexRpc } from '../codex-rpc.mjs';
import { runNativeProcess } from '../native-process.mjs';
import { grokSubscriptionPolicy } from './grok-subscription.mjs';
import { verificationEnvironment } from '../code-seat-verify.mjs';
import { devinBudgetSnapshot } from '../native-budget.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const exact = (args, keys) => {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== keys.length
      || Object.keys(args).some(key => !keys.includes(key))) throw new Error('Invalid native tool arguments.');
};

export async function runNativeDevin(options, dependencies = {}) {
  const { model, backend, prompt, worktree, receiptsDir, sourceFiles, deniedPaths = [], signal,
    observedBudget, nativeSession = null, onNativeSession = () => {}, onNativeProgress = () => {}, onTick = () => {} } = options;
  // This adapter cannot be reached by a words seat or a different backend, and
  // an ordinary numeric token budget is never interpreted as uncertainty consent.
  if (model !== DEVIN_NATIVE_MODEL || backend?.name !== 'devin' || backend?.kind !== 'devin_cli' || nativeSession !== null)
    return { ok: false, noModelCalled: true, error: 'Explicit fresh Devin native maker selection required.', usage: null };
  const contract = devinObservedContract(observedBudget);
  if (!Array.isArray(sourceFiles) || !sourceFiles.length || !receiptsDir) throw new Error('Devin needs a host-prepared source inventory and private receipt directory.');
  let context, mirror, toolScratch, workspace, broker, outcome, adopted = false, active = false, sessionId;
  let localStopReason = null, lastHostTool = null, boundaryRefusal = null, reconciliationFailure = null;
  const budgetDeniedTools = new Map(), toolStartHashes = new Map();
  const settlementWaiters = new Set(), settlingIds = new Set();
  let reconciling = 0, reconciliationTail = Promise.resolve();
  const wakeSettlement = () => { for (const wake of settlementWaiters) wake(); };
  const control = new AbortController(), calls = new Map(), permissions = new Set(), tasks = new Set();
  const abort = () => control.abort();
  const parentAbort = () => {
    if (['provider phase timeout', 'active time budget exhausted'].includes(signal?.reason?.message)) localStopReason ??= 'deadline';
    abort();
  };
  signal?.addEventListener('abort', parentAbort, { once: true }); if (signal?.aborted) parentAbort();
  const started = Date.now(); const timer = setTimeout(() => { localStopReason ??= 'deadline'; abort(); }, contract.maxWallMs);
  let closed = true, mutated = false;
  let nativeTools = 0, hostTools = 0;
  let refusalStage = 'preparation';
  const refuseTool = detail => {
    // A host counter refusing the next operation is a budget stop, not an
    // authority breach. All other broker refusals remain fail-closed boundaries.
    if (['call_limit', 'action_limit'].includes(detail?.code)) localStopReason ??= 'observed_tool_limit';
    else { boundaryRefusal ??= detail ?? null; localStopReason ??= 'tool_boundary_refused'; }
    abort();
  };
  const diagnostic = () => publicDevinDiagnostic({ ...outcome, stage: refusalStage, lastHostTool, boundaryRefusal, reconciliationFailure,
    reason: outcome?.reason === 'cancelled' && localStopReason ? localStopReason : outcome?.reason });
  const reportActions = () => {
    // Deliberately conservative: ACP tool events and host executions both
    // consume allowance, even when they describe the same underlying action.
    const actions = nativeTools + hostTools;
    const reason = onNativeProgress({ usage: null, responses: 0, actions });
    if (reason || actions > contract.maxObservedTools) { localStopReason ??= 'observed_tool_limit'; abort(); throw new Error('Devin observed action allowance reached.'); }
  };
  const hostAction = ({ tool } = {}) => { if (tool) lastHostTool = tool; hostTools++; reportActions(); };
  const budgetSnapshot = () => devinBudgetSnapshot({ maximumActions: contract.maxObservedTools,
    usedActions: nativeTools + hostTools, maximumMs: contract.maxWallMs, elapsedMs: Date.now() - started });
  const wrapUpError = () => {
    const error = new DevinToolFeedback('slice_wrap_up');
    error.message += ` Host budget: ${JSON.stringify(budgetSnapshot())}`;
    return error;
  };
  let hostTail = Promise.resolve(), queued = 0;
  const serializeHost = async (fn, { settlement = false } = {}) => {
    if (!active || control.signal.aborted || queued >= 8) {
      if (!control.signal.aborted) refuseTool({ code: 'host_operation_refused', tool: null });
      throw new Error('Native host queue refused.');
    }
    queued++;
    // Queue later work behind the evidence barrier without spending another
    // model action on a synthetic busy error. It receives no authority yet.
    while (reconciling && !settlement) await reconciliationTail;
    const operation = hostTail.then(async () => {
      if (!active || control.signal.aborted) throw new Error('Native host operation cancelled before dispatch.');
      try {
        const result = await fn();
        if (control.signal.aborted) throw new Error('Native host operation cancelled before acknowledgement.');
        return result;
      }
      catch (error) {
        if (!(error instanceof DevinToolFeedback) && !control.signal.aborted) refuseTool({ code: 'host_operation_refused', tool: null });
        throw error;
      }
    });
    hostTail = operation.catch(() => {}); tasks.add(operation);
    try { return await operation; }
    finally { queued--; tasks.delete(operation); wakeSettlement(); }
  };
  const waitForSettlement = async () => {
    const deadline = Math.min(started + contract.maxWallMs, Date.now() + 5000);
    while (tasks.size || [...settlingIds].some(id => !['completed', 'failed'].includes(calls.get(id)?.status))) {
      if (control.signal.aborted) throw new Error('Settlement cancelled.');
      if (Date.now() >= deadline) throw Object.assign(new Error('Native operations did not settle.'), { reconciliationCode: 'settlement_timeout' });
      await new Promise(resolve => {
        let timer;
        const wake = () => { clearTimeout(timer); settlementWaiters.delete(wake); control.signal.removeEventListener('abort', wake); resolve(); };
        settlementWaiters.add(wake); control.signal.addEventListener('abort', wake, { once: true });
        timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
      });
    }
  };
  try {
    context = await (dependencies.prepareContext ?? prepareDevinContext)({ signal: control.signal });
    mirror = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-workspace-')));
    toolScratch = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-tools-')));
    workspace = await createDevinWorkspace({ candidate: worktree, mirror, root: context.root, harness: context.harness,
      containedNativeWrites: true, signal: control.signal,
      files: sourceFiles.filter(path => isDevinVisiblePath(path) && !deniedPaths.some(denied => path === denied || path.startsWith(denied + '/')))
        .map(path => ({ path, mode: 'write' })), deniedPaths });
    const toolsPolicy = await grokSubscriptionPolicy({ worktree: mirror, scratch: toolScratch, harness: context.harness,
      artifactDigest: DEVIN_NATIVE_DIGEST, model, deniedPaths });
    const parents = new Set();
    for (const root of [mirror, toolScratch]) for (let p = dirname(root); ; p = dirname(p)) { parents.add(p); if (p === dirname(p)) break; }
    const commandProfile = toolsPolicy.toolProfile
      + `\n(allow file-read-metadata ${[...parents].map(path => `(literal ${JSON.stringify(path)})`).join(' ')})`
      + `\n(deny file-write* (subpath ${JSON.stringify(mirror)}))`;
    const runTool = fn => async args => {
      try { return await serializeHost(() => {
        if (budgetSnapshot().wrapUp) throw wrapUpError();
        return fn(args);
      }); }
      catch (error) {
        if (!(error instanceof DevinToolFeedback) || control.signal.aborted) throw error;
        // The RPC succeeded in reporting a no-write conflict. This is not a
        // successful file operation or permission to retry an uncertain effect.
        return JSON.stringify({ operationCompleted: false, code: error.code, guidance: error.message });
      }
    };
    const fileHandlers = createDevinFileHandlers({ workspace, cwd: mirror, sessionId: () => sessionId, calls, permissions,
      beforeOperation: async ({ method, path, tool }) => {
        if (!budgetSnapshot().wrapUp) return;
        // A permission already returned can still finish its delegated I/O.
        const pending = workspace.nativeWriteEvidence().writes.some(item => item.path === path && !item.noEffectVerified
          && !['completed', 'failed'].includes(calls.get(item.toolCallId)?.status));
        if (method !== 'session/request_permission' && pending) return;
        const matching = [...calls.values()].filter(call => !['completed', 'failed'].includes(call.status)
          && (tool ? call.toolCallId === tool.toolCallId : call.rawInput?.file_path === join(mirror, path)));
        if (matching.length === 1 && toolStartHashes.has(matching[0].toolCallId))
          budgetDeniedTools.set(matching[0].toolCallId, toolStartHashes.get(matching[0].toolCallId));
        throw wrapUpError();
      },
      onWriteApproved: async receipt => {
        const file = await open(join(receiptsDir, `devin-write-${hash(sessionId)}-${hash(receipt.toolCallId)}.json`), 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ ...receipt, sessionId, artifactDigest: context.digest,
            policy: 'contained-native/v1', approvalOnly: true }));
          await file.sync();
        } finally { await file.close(); }
      } });
    broker = await (dependencies.startBroker ?? startDevinMcp)({ maxCalls: contract.maxObservedTools,
      onRefusal: refuseTool, onCall: hostAction, getBudget: budgetSnapshot, tools: [
      { name: 'list_files', description: 'List prepared file paths and write permissions, 100 per page. Start at offset 0. Includes host-created files.',
        inputSchema: schema({ offset: { type: 'integer', minimum: 0, maximum: 4096 } }),
        invoke: runTool(async args => {
          exact(args, ['offset']);
          if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 4096) throw new Error('Invalid inventory offset.');
          const files = workspace.listFiles();
          return JSON.stringify({ files: files.slice(args.offset, args.offset + 100),
            nextOffset: args.offset + 100 < files.length ? args.offset + 100 : null });
        }) },
      { name: 'read_file', description: 'Read a prepared UTF-8 file and its SHA-256.', inputSchema: schema({ path: string }),
        invoke: runTool(async args => { exact(args, ['path']); return JSON.stringify(await workspace.readText(args.path)); }) },
      { name: 'search', description: 'Literal text search over prepared files; bounded results, no shell or regex.', inputSchema: schema({ query: string }),
        invoke: runTool(async args => {
          exact(args, ['query']); if (typeof args.query !== 'string' || !args.query || args.query.length > 256) throw new Error('Invalid search.');
          const matches = [];
          for (const item of workspace.listFiles()) {
            const text = (await workspace.readText(item.path)).content;
            for (const [line, value] of text.split('\n').entries()) if (value.includes(args.query)) {
              matches.push({ path: item.path, line: line + 1, text: value.slice(0, 200) });
              if (matches.length >= 30) return JSON.stringify({ matches, truncated: true });
            }
          }
          return JSON.stringify({ matches, truncated: false });
        }) },
      { name: 'write_file', description: 'Create a safe relative file with expectedSha256:null, or replace a recently read file with its current hash. No deletion.',
        inputSchema: schema({ path: string, content: string, expectedSha256: { type: ['string', 'null'] } }),
        invoke: runTool(async args => { exact(args, ['path', 'content', 'expectedSha256']); return JSON.stringify(await workspace.writeText(args)); }) },
      { name: 'run_command', description: 'Run an absolute executable path with a separate args array, e.g. command:"/usr/bin/env", args:["pnpm","test"]. Send tools sequentially. Credential-free, network-denied sandbox; workspace is read-only. Put test output in TMPDIR. No install, git mutation, or shell changes to source.',
        inputSchema: schema({ command: string, args: { type: 'array', items: string } }),
        invoke: runTool(async args => {
          try { exact(args, ['command', 'args']); }
          catch { throw new DevinToolFeedback('invalid_command'); }
          if (typeof args.command !== 'string' || !/^\/[A-Za-z0-9_./+-]{1,1024}$/.test(args.command)
              || !Array.isArray(args.args) || args.args.length > 100
              || args.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
              || Buffer.byteLength(JSON.stringify(args)) > 16384) throw new DevinToolFeedback('invalid_command');
          await workspace.verifyNativeWrites();
          if (workspace.nativeWriteEvidence().writes.some(item => !item.noEffectVerified && calls.get(item.toolCallId)?.status !== 'completed'))
            throw new DevinToolFeedback('native_write_pending');
          const result = await (dependencies.runProcess ?? runNativeProcess)({ command: '/usr/bin/sandbox-exec',
              args: ['-p', commandProfile, args.command, ...args.args], cwd: mirror,
              env: verificationEnvironment({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, toolsPolicy.toolHome), signal: control.signal,
              timeoutMs: Math.max(1, Math.min(60000, contract.maxWallMs - (Date.now() - started))), maxBytes: 32768 });
          await workspace.verifyNativeWrites();
          return JSON.stringify({ exitCode: result.code, stdout: result.stdout });
        }) },
    ] });
    await context.configureMcp(broker.definition);
    await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    closed = false;
    refusalStage = 'native_turn';
    const toolPolicy = 'Camus native tool policy: native edit/write tools may write only the isolated staging workspace after a checked one-time permission. Each permission binds the exact expected file content; Camus checks the result before adoption. ACP file delegation and checked Camus MCP tools are also supported. Complete each approved native write before another write or command. Direct native exec is blocked. Use camus MCP list_files (offset 0, then nextOffset), search/read_file/write_file/run_command for discovery and tests. Host-proven no-effect conflicts provide correction guidance, never successful-write claims. Commands see read-only staging, no credentials or network. Use TMPDIR for temporary outputs. Request new authority rather than bypassing unavailable operations. Return the requested JSON decision without Markdown.';
    const recoveryPolicy = 'A failed tool is not a successful operation. Camus may let you continue after proving no effect. Native exec is denied by host policy: if it is refused and the turn remains active, use the Camus MCP run_command tool instead, with an absolute command and a separate args array. Do not request changes to permission settings or repeat native exec. After a no-effect edit/write failure, read the target and make a corrected call with a new ID within the remaining budget. Never assume a failed operation applied, bypass checks, or replay an uncertain operation.';
    const dispatchPrompt = `${prompt}\n\nHost-observed SWE budget snapshot before protocol setup: ${JSON.stringify(budgetSnapshot())}\nHost MCP responses include a separate camus_native_budget block. Follow wrapUp guidance before exhaustion; stop tool use and return the requested final JSON. Native events plus host operations share the allowance; internal inference spend remains unknown.\n\n${toolPolicy}\n${recoveryPolicy}`;
    outcome = await runDevinProtocolTurn({ model, cwd: mirror, contract, signal: control.signal,
      prompt: dispatchPrompt,
      rpcFactory: callbacks => {
        callbacks.signal.addEventListener('abort', abort, { once: true });
        return (dependencies.rpcFactory ?? (value => new CodexRpc(value)))({ ...callbacks,
        command: '/usr/bin/sandbox-exec', args: ['-p', workspace.profile, context.harness, '--config', context.config, '--sandbox', 'acp', '--model', model],
        cwd: context.root, env: context.env, protocol: 'jsonrpc2', maxInboundRequests: Math.min(1000, contract.maxObservedTools + 1),
        requestError: error => error instanceof DevinToolFeedback ? { code: -32002, message: error.message }
          : { code: -32000, message: 'Camus refused the bounded tool request.' } });
      },
      beforePrompt: async marker => {
        // Check the real post-session configuration before any completion can
        // be billed. A CLI migration must not first surface after a failed exec.
        try { await context.verifyExecDenial(); }
        catch (error) { reconciliationFailure = error?.reconciliationCode ?? 'state_verification_failed'; throw error; }
        sessionId = marker.sessionId;
        const markerPath = join(receiptsDir, `devin-dispatch-${hash(sessionId)}.json`);
        const file = await open(markerPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ executor: 'devin_native', model, artifactDigest: context.digest,
            sessionId, manifestHash: workspace.manifestHash, promptHash: hash(prompt), dispatchPromptHash: hash(dispatchPrompt), contract }));
          await file.sync();
        } finally { await file.close(); }
        await onNativeSession({ executor: 'devin_native', sessionId, model, replayable: false, artifactDigest: context.digest });
        active = true;
      },
      onToolEvent(update) {
        const prior = calls.get(update.toolCallId);
        if (!prior && update.sessionUpdate === 'tool_call') toolStartHashes.set(update.toolCallId, workspace.checkedStateHash());
        calls.set(update.toolCallId, { ...prior, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
          status: update.status ?? prior?.status ?? 'pending' });
        const current = calls.get(update.toolCallId);
        if (current?._meta?.['cognition.ai/inferenceToolName'] === 'exec' && current.status === 'completed')
          refuseTool({ code: 'native_exec_unexpected_completion', tool: null });
        wakeSettlement();
      },
      onToolFailure(update) {
        const tool = calls.get(update.toolCallId);
        const kind = tool?._meta?.['cognition.ai/inferenceToolName'];
        const budgetDenied = budgetDeniedTools.has(update.toolCallId);
        if (!budgetDenied && !['read', 'edit', 'write', 'exec'].includes(kind)) { reconciliationFailure = 'unsupported_tool'; return null; }
        if (!budgetDenied && kind !== 'exec' && typeof tool.rawInput?.file_path !== 'string') { reconciliationFailure = 'missing_target'; return null; }
        // Reserve a barrier synchronously, before any later host request can
        // start. Existing host work and already-granted native writes may drain;
        // no new write/command authority is admitted while effects are checked.
        if (!reconciling) for (const call of calls.values())
          if (!['completed', 'failed'].includes(call.status)) settlingIds.add(call.toolCallId);
        reconciling++;
        const operation = reconciliationTail.then(async () => {
          try { await waitForSettlement(); }
          catch (error) {
            reconciliationFailure = error?.reconciliationCode ?? 'state_verification_failed';
            localStopReason ??= 'tool_failed'; abort(); return null;
          }
          return serializeHost(async () => {
            let receipt;
            try {
              if (budgetDenied) receipt = await workspace.reconcileBudgetDeniedTool(tool, budgetDeniedTools.get(update.toolCallId));
              else if (kind === 'exec') {
                const denial = await context.verifyExecDenial();
                if (denial?.policy !== 'native-exec-denied/v1' || denial.artifactDigest !== context.digest
                    || !/^[a-f0-9]{64}$/.test(denial.configHash ?? '')) throw new Error('Native exec denial is unbound.');
                receipt = { ...await workspace.reconcileDeniedNativeExec(tool), denial };
              } else if (kind === 'read') receipt = await workspace.reconcileFailedNativeRead(tool, toolStartHashes.get(update.toolCallId));
              else receipt = await workspace.reconcileFailedNativeWrite(tool);
            }
            catch (error) {
              // Cancel inside the queue, before any later host dispatch.
              reconciliationFailure = error?.reconciliationCode ?? 'state_verification_failed';
              localStopReason ??= 'tool_failed'; abort(); return null;
            }
            try {
              const file = await open(join(receiptsDir, `devin-no-effect-${hash(sessionId)}-${hash(update.toolCallId)}.json`), 'wx', 0o600);
              try {
                await file.writeFile(JSON.stringify({ ...receipt, sessionId, artifactDigest: context.digest,
                  policy: 'contained-native/v1', operationCompleted: false }));
                await file.sync();
              } finally { await file.close(); }
            } catch {
              // Persistence failure cancels before acknowledging no effect.
              reconciliationFailure = 'receipt_persistence_failed';
              localStopReason ??= 'tool_failed'; abort(); return null;
            }
            return receipt;
          }, { settlement: true });
        }).finally(() => { if (--reconciling === 0) settlingIds.clear(); });
        reconciliationTail = operation.catch(() => {});
        return operation;
      },
      onProgress({ observedTools }) {
        nativeTools = observedTools; reportActions();
        onTick(`Devin native: ${nativeTools + hostTools} accounted actions (native events plus host executions); inference usage unavailable.`);
      },
      onToolRequest: async (method, params) => {
        try {
          if (!Object.hasOwn(fileHandlers, method)) throw new Error('Unsupported ACP host method.');
          hostAction();
          // Do not deadlock an earlier granted write whose completion requires
          // delegated ACP I/O. This exception cannot issue a new permission.
          const settlement = reconciling > 0 && ['fs/read_text_file', 'fs/write_text_file'].includes(method)
            && workspace.nativeWriteEvidence().writes.some(item => settlingIds.has(item.toolCallId)
              && !item.noEffectVerified && join(mirror, item.path) === params.path
              && !['completed', 'failed'].includes(calls.get(item.toolCallId)?.status));
          return await serializeHost(() => fileHandlers[method](params), { settlement });
        } catch (error) {
          if (!(error instanceof DevinToolFeedback) && !control.signal.aborted) refuseTool({ code: 'host_operation_refused', tool: null });
          throw error;
        }
      },
      closeTools: async () => {
        const unfinished = tasks.size > 0 || broker.stats().active > 0;
        active = false; abort(); await broker.close(); await Promise.allSettled([...tasks]);
        return { unfinishedAtTerminal: unfinished };
      },
    });
    closed = outcome.cleanupConfirmed;
    // Keep terminal evidence BEFORE parsing/adoption. This bounded private file
    // is never a success receipt or public diagnostic; it can include task text.
    // A malformed decision must not erase proof of how the native turn ended.
    refusalStage = 'terminal_evidence';
    await writeFile(join(receiptsDir, `devin-terminal-${sessionId ? hash(sessionId) : randomUUID()}.json`), JSON.stringify({
      ...outcome, artifactDigest: context.digest, modelSelected: model,
      writeEvidence: workspace.nativeWriteEvidence(),
      diagnostic: diagnostic(),
      candidateAdopted: false, privateTaskContent: true,
    }), { flag: 'wx', mode: 0o600 });
    if (outcome.execution !== 'completed') {
      refusalStage = 'native_turn';
      const detail = diagnostic();
      return { ok: false, uncertain: outcome.promptsSent > 0,
        noModelCalled: outcome.promptsSent === 0, usage: null, usageIncomplete: true,
        stagedDraft: outcome.promptsSent > 0 && closed ? { path: mirror, adopted: false, replayAllowed: false } : null,
        diagnostic: detail, candidateQuiescent: false, failureCode: 'devin_native_incomplete',
        ...(closed && detail.cleanupConfirmed && devinDiscardableStop(detail.reason)
          && detail.rpcFailure === null && detail.boundaryRefusal === null
          ? { recoveryDisposition: 'discard_mirror_v1' } : {}),
        error: 'Devin native turn did not supply a complete contained result.' };
    }
    refusalStage = 'decision_json';
    let decision, decisionNormalizations;
    try { ({ value: decision, normalizations: decisionNormalizations } = parseDevinDecisionText(outcome.text)); }
    catch { throw new Error('Devin completion was not the required JSON decision.'); }
    refusalStage = 'decision_schema';
    // Summary is descriptive metadata, never execution/acceptance authority.
    // Normalize absence only; malformed supplied values still fail validation.
    if (!Object.hasOwn(decision, 'summary')) {
      decision = { ...decision, summary: '' };
      decisionNormalizations = [...decisionNormalizations, 'missing_summary_defaulted_empty'];
    }
    if (typeof decision?.done !== 'boolean' || typeof decision.summary !== 'string' || Buffer.byteLength(decision.summary) > 2000
        || !Object.hasOwn(decision, 'decision') || Object.keys(decision).some(key => !['done', 'summary', 'decision'].includes(key)))
      throw new Error('Devin decision schema is invalid.');
    refusalStage = 'decision_authority';
    if (decision.decision !== null && (!decision.decision || typeof decision.decision !== 'object' || Array.isArray(decision.decision)
        || decision.done || Object.keys(decision.decision).some(key => !['action', 'reason'].includes(key))
        || !['continue', 'request_budget', 'request_model', 'amend_contract', 'human', 'stop', 'retry_verify', 'rebut'].includes(decision.decision.action)
        || typeof decision.decision.reason !== 'string' || !decision.decision.reason.trim() || decision.decision.reason.length > 2000))
      throw new Error('Devin decision authority is invalid.');
    // The engine revalidates the final decision and owns verification/review.
    refusalStage = 'staged_adoption';
    mutated = true;
    const adoption = await workspace.adopt({ writersStopped: true }); adopted = true;
    refusalStage = 'result_receipt';
    await writeFile(join(receiptsDir, `devin-result-${hash(sessionId)}.json`), JSON.stringify({ ...outcome, text: undefined,
      adoption, decisionNormalizations, writeEvidence: { ...workspace.nativeWriteEvidence(), verifiedAfterCleanup: true },
      artifactDigest: context.digest, modelSelected: model }), { flag: 'wx', mode: 0o600 });
    return { ok: true, definitiveTurnEnd: true, candidateQuiescent: true, text: JSON.stringify({ actions: [], ...decision }),
      usage: null, usageIncomplete: true, modelActual: null, modelReported: model, modelActualEvidence: 'selection_only',
      observedBudget: contract, durationMs: outcome.durationMs };
  } catch {
    return { ok: false, noModelCalled: !sessionId, uncertain: !!sessionId || mutated,
      usage: null, usageIncomplete: true, candidateQuiescent: false, failureCode: 'devin_native_refused',
      stagedDraft: sessionId && closed && !adopted ? { path: mirror, adopted: false, replayAllowed: false } : null,
      diagnostic: diagnostic(),
      error: `Devin native ${refusalStage} refused. No fallback or replay.` };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', parentAbort); active = false; abort();
    try { await broker?.close(); } catch { closed = false; }
    if (closed) {
      await context?.release({ writerStopped: true });
      // Preserve uncertain staged work outside the candidate for inspection.
      if (mirror && (!sessionId || adopted)) await rm(mirror, { recursive: true });
      if (toolScratch) await rm(toolScratch, { recursive: true });
    }
  }
}
