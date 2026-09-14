// Optional Devin native maker composition. Public launch/admission is separate.
// Existing login, scoped native edits, host MCP tools, no API substitution.
import { mkdir, mkdtemp, realpath, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareDevinContext } from '../devin-native-context.mjs';
import { createDevinWorkspace, isDevinVisiblePath, DevinToolFeedback } from '../devin-native-workspace.mjs';
import { runDevinProtocolTurn, devinObservedContract } from '../devin-native-turn.mjs';
import { startDevinMcp } from '../devin-native-mcp.mjs';
import { assessDevinFilePermission, mergeDevinPermissionTool, selectDevinOneTimePermission } from '../devin-native-permission.mjs';
import { DEVIN_NATIVE_MODEL, DEVIN_NATIVE_DIGEST, publicDevinDiagnostic } from '../devin-native-protocol.mjs';
import { CodexRpc } from '../codex-rpc.mjs';
import { runNativeProcess } from '../native-process.mjs';
import { grokSubscriptionPolicy } from './grok-subscription.mjs';
import { verificationEnvironment } from '../code-seat-verify.mjs';

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
  let context, mirror, toolScratch, workspace, broker, outcome, adopted = false, active = false, sessionId, commandActive = false;
  const control = new AbortController(), calls = new Map(), permissions = new Set(), tasks = new Set();
  const abort = () => control.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const started = Date.now(); const timer = setTimeout(() => { localStopReason ??= 'deadline'; abort(); }, contract.maxWallMs);
  let closed = true, mutated = false;
  let nativeTools = 0, hostTools = 0;
  let refusalStage = 'preparation';
  let localStopReason = null, lastHostTool = null, boundaryRefusal = null;
  const refuseTool = detail => { boundaryRefusal ??= detail ?? null; localStopReason ??= 'tool_boundary_refused'; abort(); };
  const diagnostic = () => publicDevinDiagnostic({ ...outcome, stage: refusalStage, lastHostTool, boundaryRefusal,
    reason: outcome?.reason === 'cancelled' && localStopReason ? localStopReason : outcome?.reason });
  const reportActions = () => {
    // Deliberately conservative: ACP tool events and host executions both
    // consume allowance, even when they describe the same underlying action.
    const actions = nativeTools + hostTools;
    const reason = onNativeProgress({ usage: null, responses: 0, actions });
    if (reason || actions > contract.maxObservedTools) { localStopReason ??= 'observed_tool_limit'; abort(); throw new Error('Devin observed action allowance reached.'); }
  };
  const hostAction = ({ tool } = {}) => { if (tool) lastHostTool = tool; hostTools++; reportActions(); };
  try {
    context = await (dependencies.prepareContext ?? prepareDevinContext)({ signal: control.signal });
    mirror = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-workspace-')));
    toolScratch = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-tools-')));
    workspace = await createDevinWorkspace({ candidate: worktree, mirror, root: context.root, harness: context.harness,
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
      if (!active || control.signal.aborted || commandActive) throw new Error('Native tools are outside the active turn.');
      const pending = Promise.resolve().then(() => fn(args)); tasks.add(pending);
      try { return await pending; }
      catch (error) {
        if (!(error instanceof DevinToolFeedback) || control.signal.aborted) throw error;
        // The RPC succeeded in reporting a no-write conflict. This is not a
        // successful file operation or permission to retry an uncertain effect.
        return JSON.stringify({ operationCompleted: false, code: error.code, guidance: error.message });
      } finally { tasks.delete(pending); }
    };
    const relativePath = value => relative(mirror, workspace.mapPath(value));
    broker = await (dependencies.startBroker ?? startDevinMcp)({ maxCalls: contract.maxObservedTools, onRefusal: refuseTool, onCall: hostAction, tools: [
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
          commandActive = true;
          try {
            const result = await (dependencies.runProcess ?? runNativeProcess)({ command: '/usr/bin/sandbox-exec',
              args: ['-p', commandProfile, args.command, ...args.args], cwd: mirror,
              env: verificationEnvironment({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, toolsPolicy.toolHome), signal: control.signal,
              timeoutMs: Math.max(1, Math.min(60000, contract.maxWallMs - (Date.now() - started))), maxBytes: 32768 });
            return JSON.stringify({ exitCode: result.code, stdout: result.stdout });
          } finally { commandActive = false; }
        }) },
    ] });
    await context.configureMcp(broker.definition);
    await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    closed = false;
    refusalStage = 'native_turn';
    outcome = await runDevinProtocolTurn({ model, cwd: mirror, contract, signal: control.signal,
      prompt: `${prompt}\n\nCamus native tool policy: use native read/edit only for prepared existing files. Use camus MCP list_files (offset 0, then nextOffset) to discover the prepared inventory, and search/read_file/write_file/run_command for search, creation and tests. Discover these tools when needed. A tool response with operationCompleted:false made no change: follow its guidance within the existing budget; never treat it as a successful write. Native exec is blocked. Commands see read-only staging, no credentials or network. Use TMPDIR for temporary outputs. Request new authority rather than bypassing unavailable operations. Return the requested JSON decision without Markdown.`,
      rpcFactory: callbacks => (dependencies.rpcFactory ?? (value => new CodexRpc(value)))({ ...callbacks,
        command: '/usr/bin/sandbox-exec', args: ['-p', workspace.profile, context.harness, '--config', context.config, '--sandbox', 'acp', '--model', model],
        cwd: context.root, env: context.env, protocol: 'jsonrpc2' }),
      beforePrompt: async marker => {
        sessionId = marker.sessionId;
        const markerPath = join(receiptsDir, `devin-dispatch-${hash(sessionId)}.json`);
        const file = await open(markerPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ executor: 'devin_native', model, artifactDigest: context.digest,
            sessionId, manifestHash: workspace.manifestHash, promptHash: hash(prompt), contract }));
          await file.sync();
        } finally { await file.close(); }
        await onNativeSession({ executor: 'devin_native', sessionId, model, replayable: false, artifactDigest: context.digest });
        active = true;
      },
      onToolEvent(update) {
        const prior = calls.get(update.toolCallId);
        calls.set(update.toolCallId, { ...prior, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
          status: update.status ?? prior?.status ?? 'pending' });
      },
      onProgress({ observedTools }) {
        nativeTools = observedTools; reportActions();
        onTick(`Devin native: ${nativeTools + hostTools} accounted actions (native events plus host executions); inference usage unavailable.`);
      },
      onToolRequest: async (method, params) => {
        if (commandActive) {
          refuseTool({ code: 'native_command_overlap', tool: null });
          throw new Error('Concurrent native write/verification refused.');
        }
        if (method === 'fs/read_text_file') { hostAction(); return { content: (await workspace.readText(relativePath(params.path))).content }; }
        if (method !== 'session/request_permission') throw new Error('Native delegated write is unsupported; use checked MCP write_file.');
        const tool = mergeDevinPermissionTool(calls.get(params.toolCall?.toolCallId), params.toolCall);
        const target = workspace.mapPath(tool?.rawInput?.file_path, { writable: true });
        const assessment = await assessDevinFilePermission({ cwd: mirror, target, tool, maxInputBytes: 65536 });
        const result = selectDevinOneTimePermission({ expectedSessionId: sessionId, params, assessment, seen: permissions });
        if (result.outcome.outcome !== 'selected') throw new Error('Native edit permission refused.');
        return result;
      },
      closeTools: async () => { active = false; abort(); await broker.close(); await Promise.allSettled([...tasks]); },
    });
    closed = outcome.cleanupConfirmed;
    // Keep terminal evidence BEFORE parsing/adoption. This bounded private file
    // is never a success receipt or public diagnostic; it can include task text.
    // A malformed decision must not erase proof of how the native turn ended.
    refusalStage = 'terminal_evidence';
    await writeFile(join(receiptsDir, `devin-terminal-${sessionId ? hash(sessionId) : randomUUID()}.json`), JSON.stringify({
      ...outcome, artifactDigest: context.digest, modelSelected: model,
      diagnostic: diagnostic(),
      candidateAdopted: false, privateTaskContent: true,
    }), { flag: 'wx', mode: 0o600 });
    if (outcome.execution !== 'completed') {
      refusalStage = 'native_turn';
      return { ok: false, uncertain: outcome.promptsSent > 0,
        noModelCalled: outcome.promptsSent === 0, usage: null, usageIncomplete: true,
        stagedDraft: outcome.promptsSent > 0 && closed ? { path: mirror, adopted: false, replayAllowed: false } : null,
        diagnostic: diagnostic(), candidateQuiescent: false, failureCode: 'devin_native_incomplete',
        error: 'Devin native turn did not supply a complete contained result.' };
    }
    refusalStage = 'decision_json';
    let decision;
    try { decision = JSON.parse(outcome.text); } catch { throw new Error('Devin completion was not the required JSON decision.'); }
    refusalStage = 'decision_schema';
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
      adoption, artifactDigest: context.digest, modelSelected: model }), { flag: 'wx', mode: 0o600 });
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
    clearTimeout(timer); signal?.removeEventListener('abort', abort); active = false; abort();
    try { await broker?.close(); } catch { closed = false; }
    if (closed) {
      await context?.release({ writerStopped: true });
      // Preserve uncertain staged work outside the candidate for inspection.
      if (mirror && (!sessionId || adopted)) await rm(mirror, { recursive: true });
      if (toolScratch) await rm(toolScratch, { recursive: true });
    }
  }
}
