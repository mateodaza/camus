// Grok Build through the operator's Grok login. This path never reads
// XAI_API_KEY and never replaces Grok's subscription inference route with an
// API-credit gateway. ACP keeps filesystem and terminal authority in Camus:
// the authenticated Grok process owns context/inference while the host applies
// bounded, sandboxed tool requests to the candidate.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { CodexRpc } from '../codex-rpc.mjs';
import { runCodeOwnedProcess } from '../code-owned-process.mjs';
import { verificationEnvironment } from '../code-seat-verify.mjs';
import { normalizeReview } from './codex.mjs';
import { resolveNativeHarness, assertNativeHarnessArtifact, GROK_NATIVE_EXECUTOR } from '../native-harness-policy.mjs';

export const GROK_SUBSCRIPTION_POLICY_VERSION = 'grok-subscription-acp/v4';
export const GROK_SUBSCRIPTION_NATIVE_POLICY_VERSION = GROK_SUBSCRIPTION_POLICY_VERSION;
const REQUIRED_VERSION = '1.0.13';
const REQUIRED_AUTH_METHOD = 'cached_token';
const PRIVATE_COMPONENT = /^(?:\.git|\.env|\.npmrc|\.netrc|\.camus|\.claude|\.codex|\.qwen|\.grok|\.ssh|\.aws|\.azure)$/i;
const PRIVATE_FILE = /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|private[-_]?key)(?:$|[._-])/i;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const zeroUsage = () => ({ inputTokens: 0, cachedReadTokens: 0, outputTokens: 0, totalTokens: 0 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => JSON.stringify(String(value));
const within = (parent, child) => child === parent || child.startsWith(parent + sep);

function validateAuthBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_AUTH_BYTES) throw new Error('Grok login evidence is missing or oversized. Run `grok login`.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Grok login evidence is unreadable. Run `grok login`.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Grok login evidence is invalid. Run `grok login`.');
  if (!Object.keys(value).length) throw new Error('Grok OAuth login is unavailable. Run `grok login`; API keys are not accepted by this seat.');
}

async function privateRegular(path, label, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum || (info.mode & 0o077)) {
    throw new Error(`${label} must be a bounded private regular file.`);
  }
  return info;
}

export async function installGrokSubscriptionAuth(home, { source = join(homedir(), '.grok', 'auth.json') } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const target = join(home, 'auth.json');
  try {
    await privateRegular(target, 'Isolated Grok login', MAX_AUTH_BYTES);
    const current = await readFile(target); validateAuthBytes(current); return target;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let bytes;
  try { await privateRegular(source, 'Grok login', MAX_AUTH_BYTES); bytes = await readFile(source); }
  catch (error) {
    if (error?.message?.startsWith('Grok login must')) throw error;
    throw new Error('Grok OAuth login was not found. Run `grok login`; no API-key fallback was made.');
  }
  validateAuthBytes(bytes);
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return target;
}

export async function installGrokSubscriptionConfig(home, model, { hook = '' } = {}) {
  // ACP must not pause for an interactive approval UI that does not exist in
  // this headless process. This does not grant the harness direct tool access:
  // every operation still crosses the bounded Camus ACP host and Seatbelt.
  const text = `[cli]\nauto_update = false\nuse_leader = false\n[ui]\npermission_mode = "always-approve"\n[grok_com_config]\ndisable_api_key_auth = true\n[features]\ntitle_refresh = false\nturn_summary = false\nsession_recap = false\n[session]\nload_envrc = false\n[models]\ndefault = ${JSON.stringify(model)}\nallowed_models = [${JSON.stringify(model)}]\nmax_retries = 0\n${hook}`;
  const path = join(home, 'config.toml');
  try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await privateRegular(path, 'Isolated Grok configuration', 64 * 1024);
    if (await readFile(path, 'utf8') !== text) throw new Error('Isolated Grok subscription configuration changed; execution refused.');
  }
  return path;
}

function processProfile({ scratch, harness, worktree }) {
  const parents = new Set(['/']);
  for (const path of [scratch, harness]) {
    let current = resolve(path);
    while (current !== '/') { current = dirname(current); parents.add(current); }
  }
  return `(version 1)
(deny default)
(allow file-read*)
(deny file-read* (subpath ${quote(homedir())}) (subpath "/Users/Shared") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read-metadata ${[...parents].map(path => `(literal ${quote(path)})`).join(' ')})
(allow file-read-metadata (literal ${quote(worktree)}))
(allow file-read* (subpath ${quote(scratch)}) (literal ${quote(harness)}))
(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null"))
(allow process-exec (literal ${quote(harness)}))
(allow network-outbound)
(allow sysctl-read)
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(allow file-ioctl (regex #"^/dev/tty.*"))`;
}

function toolProfile({ worktree, scratch, deniedPaths }) {
  const denied = [...new Set(['.git', '.env', '.npmrc', '.netrc', '.camus', '.claude', '.codex', '.qwen', '.grok', '.ssh', '.aws', '.azure', ...deniedPaths])];
  return `(version 1)
(deny default)
(allow file-read*)
(deny file-read* (subpath ${quote(homedir())}) (subpath "/Users/Shared") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read* (subpath ${quote(worktree)}) (subpath ${quote(scratch)}))
${denied.map(path => `(deny file-read* (subpath ${quote(join(worktree, path))}))`).join('\n')}
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(allow file-ioctl (regex #"^/dev/tty.*"))
(allow file-write* (subpath ${quote(worktree)}) (subpath ${quote(scratch)}) (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null"))
${denied.map(path => `(deny file-write* (subpath ${quote(join(worktree, path))}))`).join('\n')}`;
}

export async function grokSubscriptionPolicy({ worktree, scratch, harness, artifactDigest, model, deniedPaths = [],
  platform = process.platform, architecture = process.arch }) {
  if (platform !== 'darwin' || architecture !== 'arm64') throw new Error('The reviewed Grok subscription seat currently requires macOS arm64.');
  const cwd = await realpath(worktree); await mkdir(scratch, { recursive: true, mode: 0o700 });
  const temp = await realpath(scratch); const binary = await realpath(harness);
  if (within(cwd, temp) || within(temp, cwd)) throw new Error('Grok subscription scratch and candidate must be separate.');
  for (const path of deniedPaths) {
    if (typeof path !== 'string' || !path || !within(cwd, resolve(cwd, path))) throw new Error('Invalid Grok subscription denied path.');
  }
  const home = join(temp, 'grok-home'), toolHome = join(temp, 'tool-home');
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(toolHome, { recursive: true, mode: 0o700 });
  const semantic = { version: GROK_SUBSCRIPTION_POLICY_VERSION, executor: GROK_NATIVE_EXECUTOR, cwd, temp, binary, artifactDigest,
    model, deniedPaths: [...deniedPaths].sort(), auth: 'grok_oauth_cached_token', inference: 'grok_subscription', tools: 'acp_host_sandboxed' };
  return { ...semantic, hash: hash(semantic), home, toolHome,
    processProfile: processProfile({ scratch: temp, harness: binary, worktree: cwd }), toolProfile: toolProfile({ worktree: cwd, scratch: temp, deniedPaths }) };
}

export function grokSubscriptionEnvironment(policy) {
  return Object.freeze({
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: policy.temp, TMPDIR: policy.temp,
    GROK_HOME: policy.home, CI: '1', NO_COLOR: '1', TERM: 'dumb', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0',
    GROK_DISABLE_API_KEY_AUTH: '1',
    GROK_TITLE_REFRESH: '0', GROK_TURN_SUMMARY: '0', GROK_SESSION_RECAP: '0', GROK_SUBAGENTS: '0', GROK_TOOL_SEARCH: '0',
    GROK_WEB_FETCH: '0', GROK_LSP_TOOLS: '0', GROK_CLI_CHAT_PROXY_BASE_URL: 'https://cli-chat-proxy.grok.com/v1',
    ...Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap(vendor => ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS', 'SESSIONS']
      .map(feature => [`GROK_${vendor}_${feature}_ENABLED`, '0']))),
  });
}

export async function preflightGrokSubscriptionTools({ policy, sourcePath, receiptsDir, signal,
  commandRunner = runCodeOwnedProcess }) {
  if (!sourcePath || !receiptsDir) throw new Error('Grok subscription tool preflight requires private source and receipt roots.');
  const nonce = randomBytes(16).toString('hex');
  const sentinel = join(receiptsDir, `grok-subscription-private-${nonce}`);
  const candidateProbe = join(policy.cwd, `.camus-grok-subscription-${nonce}`);
  const gitHead = join(policy.cwd, '.git', 'HEAD');
  let gitAssertion = '';
  try { await lstat(gitHead); gitAssertion = `a.throws(()=>fs.readFileSync(${JSON.stringify(gitHead)}),denied);`; }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await writeFile(sentinel, 'synthetic private boundary probe', { flag: 'wx', mode: 0o600 });
  const probe = `const fs=require('fs'),net=require('net'),a=require('assert/strict'),{execFileSync}=require('child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);${gitAssertion}
a.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),denied);a.throws(()=>fs.readdirSync(${JSON.stringify(sourcePath)}),denied);
a.throws(()=>execFileSync('/bin/ps',['eww','-ax'],{stdio:['ignore','pipe','ignore']}));
const p=${JSON.stringify(candidateProbe)};fs.writeFileSync(p,'probe',{flag:'wx'});fs.unlinkSync(p);
const s=net.connect({host:'1.1.1.1',port:443});s.once('connect',()=>process.exit(3));s.once('error',e=>{try{a(denied(e));console.log('camus-grok-subscription-tools-v1')}catch{process.exit(4)}});setTimeout(()=>process.exit(5),2500).unref();`;
  try {
    let stdout = '';
    const result = await commandRunner({ runDir: receiptsDir, kind: 'grok_acp_preflight', command: '/usr/bin/sandbox-exec',
      args: ['-p', policy.toolProfile, process.execPath, '-e', probe], cwd: policy.cwd,
      env: verificationEnvironment(process.env, policy.toolHome), timeoutMs: 5000, signal,
      onStdout: chunk => { if (stdout.length < 4096) stdout += Buffer.from(chunk).toString('utf8').slice(0, 4096 - stdout.length); },
      onStderr: () => {} });
    if (result.code !== 0 || !stdout.includes('camus-grok-subscription-tools-v1')) {
      throw new Error('Grok subscription host-tool isolation preflight failed; no model was called.');
    }
  } finally {
    await unlink(sentinel).catch(() => {}); await unlink(candidateProbe).catch(() => {});
  }
}

function safeAbsolute(worktree, requested, deniedPaths, { allowMissing = true } = {}) {
  if (typeof requested !== 'string' || !requested || requested.length > 2048 || requested.includes('\0')) throw new Error('ACP path is invalid.');
  const absolute = resolve(worktree, isAbsolute(requested) ? relative(worktree, requested) : requested);
  if (!within(worktree, absolute)) throw new Error('ACP path escapes the candidate.');
  const rel = relative(worktree, absolute);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.some(part => part === '..' || PRIVATE_COMPONENT.test(part)) || PRIVATE_FILE.test(basename(rel))) throw new Error('ACP private path refused.');
  if (deniedPaths.some(path => within(resolve(worktree, path), absolute))) throw new Error('ACP protected source path refused.');
  return { absolute, rel, allowMissing };
}

async function assertNoSymlink(worktree, item) {
  let cursor = worktree;
  for (const part of item.rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('ACP symlink path refused.'); }
    catch (error) { if (error?.code === 'ENOENT' && item.allowMissing) return; throw error; }
  }
}

function appendOutput(state, chunk) {
  const value = Buffer.from(chunk); state.bytes += value.length;
  state.truncated ||= state.bytes > state.limit;
  state.output = Buffer.concat([state.output, value]);
  if (state.output.length > state.limit) state.output = state.output.subarray(state.output.length - state.limit);
}

export function createGrokAcpTools({ sessionId = () => null, worktree, scratch, receiptsDir, deniedPaths = [], signal,
  maxToolCalls, onProgress = () => {}, onTick = () => {}, profile, commandRunner = runCodeOwnedProcess }) {
  const terminals = new Map(); let actions = 0;
  const action = label => {
    if (actions >= maxToolCalls) throw new Error('Grok subscription tool-action budget exhausted.');
    actions++; const reason = onProgress({ usage: null, responses: 0, actions });
    if (reason) throw new Error(String(reason)); onTick(label);
  };
  const checkSession = params => { if (!sessionId() || params?.sessionId !== sessionId()) throw new Error('ACP session identity changed.'); };
  const safe = async (path, options) => { const item = safeAbsolute(worktree, path, deniedPaths, options); await assertNoSymlink(worktree, item); return item; };
  const activeTerminal = () => [...terminals.values()].some(state => !state.exitStatus);
  return {
    get actions() { return actions; },
    async handle(method, params) {
      checkSession(params);
      if (method === 'fs/read_text_file') {
        action('Grok subscription maker read a bounded candidate file.');
        if (activeTerminal()) throw new Error('ACP filesystem access refused while a terminal is active.');
        const item = await safe(params.path, { allowMissing: false }); const info = await lstat(item.absolute);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('ACP read requires a bounded regular file.');
        const body = await readFile(item.absolute, 'utf8');
        const line = params.line == null ? 1 : params.line, limit = params.limit == null ? null : params.limit;
        if (!Number.isSafeInteger(line) || line < 1 || limit != null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)) throw new Error('ACP read range is invalid.');
        const rows = body.split('\n'); return { content: rows.slice(line - 1, limit == null ? undefined : line - 1 + limit).join('\n') };
      }
      if (method === 'fs/write_text_file') {
        action('Grok subscription maker edited the candidate.');
        if (activeTerminal()) throw new Error('ACP filesystem access refused while a terminal is active.');
        if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > MAX_FILE_BYTES) throw new Error('ACP write exceeds the file limit.');
        const item = await safe(params.path, { allowMissing: true }); await mkdir(dirname(item.absolute), { recursive: true });
        await assertNoSymlink(worktree, item); await writeFile(item.absolute, params.content, 'utf8'); return {};
      }
      if (method === 'terminal/create') {
        action('Grok subscription maker ran a sandboxed command.');
        if (activeTerminal()) throw new Error('Only one ACP terminal may run at a time.');
        if (typeof params.command !== 'string' || !params.command || params.command.length > 1024
            || !Array.isArray(params.args ?? []) || params.args.length > 128 || (params.args ?? []).some(v => typeof v !== 'string' || v.length > 8192)
            || (params.env?.length ?? 0)) throw new Error('ACP terminal request is invalid.');
        const cwd = (await safe(params.cwd ?? worktree, { allowMissing: false })).absolute;
        if (!(await lstat(cwd)).isDirectory()) throw new Error('ACP terminal cwd is not a directory.');
        const limit = Math.min(MAX_OUTPUT_BYTES, Number.isSafeInteger(params.outputByteLimit) && params.outputByteLimit > 0 ? params.outputByteLimit : MAX_OUTPUT_BYTES);
        const control = new AbortController();
        const externalAbort = () => control.abort(new Error('Grok subscription terminal aborted.'));
        signal?.addEventListener('abort', externalAbort, { once: true });
        const state = { output: Buffer.alloc(0), bytes: 0, limit, truncated: false, exitStatus: null, control, promise: null };
        const terminalId = randomUUID(); terminals.set(terminalId, state);
        state.promise = commandRunner({ runDir: receiptsDir, kind: 'grok_acp_tool', command: '/usr/bin/sandbox-exec',
          args: ['-p', profile, params.command, ...(params.args ?? [])], cwd,
          env: verificationEnvironment(process.env, scratch), timeoutMs: 120_000, signal: control.signal,
          onStdout: chunk => appendOutput(state, chunk), onStderr: chunk => appendOutput(state, chunk) })
          .then(result => { state.exitStatus = { exitCode: result.code, signal: null }; })
          .catch(() => { state.exitStatus = { exitCode: 126, signal: null }; })
          .finally(() => signal?.removeEventListener('abort', externalAbort));
        return { terminalId };
      }
      if (method === 'terminal/output') {
        const state = terminals.get(params.terminalId); if (!state) throw new Error('Unknown ACP terminal.');
        return { output: state.output.toString('utf8'), truncated: state.truncated, exitStatus: state.exitStatus };
      }
      if (method === 'terminal/wait_for_exit') {
        const state = terminals.get(params.terminalId); if (!state) throw new Error('Unknown ACP terminal.');
        await state.promise; return state.exitStatus;
      }
      if (method === 'terminal/kill') {
        const state = terminals.get(params.terminalId); if (!state) throw new Error('Unknown ACP terminal.');
        state.control.abort(new Error('Grok subscription terminal killed.')); await state.promise; return {};
      }
      if (method === 'terminal/release') {
        const state = terminals.get(params.terminalId); if (!state) throw new Error('Unknown ACP terminal.');
        if (!state.exitStatus) throw new Error('Active ACP terminal cannot be released.'); terminals.delete(params.terminalId); return {};
      }
      throw new Error('Unsupported ACP authority.');
    },
    async cleanup() {
      for (const state of terminals.values()) state.control.abort(new Error('Grok subscription turn ended.'));
      await Promise.allSettled([...terminals.values()].map(state => state.promise)); terminals.clear();
    },
  };
}

export function normalizeGrokSubscriptionUsage(total, baseline = zeroUsage()) {
  const value = source => ({
    inputTokens: source?.inputTokens ?? source?.input_tokens,
    cachedReadTokens: source?.cachedReadTokens ?? source?.cacheReadInputTokens ?? source?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: source?.cacheCreationTokens ?? source?.cacheCreationInputTokens ?? source?.cache_creation_input_tokens ?? 0,
    outputTokens: source?.outputTokens ?? source?.output_tokens,
    totalTokens: source?.totalTokens ?? source?.total_tokens,
  });
  const previous = value(baseline);
  const normalized = {
    ...value(total),
  };
  for (const field of Object.keys(normalized)) {
    if (!Number.isSafeInteger(normalized[field]) || normalized[field] < 0 || normalized[field] < previous[field]) throw new Error('Invalid Grok subscription usage counters.');
  }
  const consistent = ({ inputTokens, cachedReadTokens, cacheCreationTokens, outputTokens, totalTokens }) =>
    totalTokens === inputTokens + outputTokens && cachedReadTokens <= inputTokens
      || totalTokens === inputTokens + cachedReadTokens + cacheCreationTokens + outputTokens;
  if (!consistent(normalized) || !consistent(previous)) {
    throw new Error('Inconsistent Grok subscription usage counters.');
  }
  return { input_tokens: normalized.inputTokens - previous.inputTokens,
    cached_input_tokens: normalized.cachedReadTokens - previous.cachedReadTokens,
    output_tokens: normalized.outputTokens - previous.outputTokens,
    total_tokens: normalized.totalTokens - previous.totalTokens };
}

function modelReceipt(promptResult, model) {
  const candidates = [promptResult?.modelUsage, promptResult?._meta?.modelUsage, promptResult?._meta?.model_usage,
    promptResult?._meta?.usage?.modelUsage,
    promptResult?._meta?.['x.ai/modelUsage']].filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const observed = candidates[0], keys = observed ? Object.keys(observed) : [];
  const accepted = model === 'grok-4.6' ? new Set(['grok-4.6', 'grok-4.6-build']) : new Set([model]);
  if (!observed || keys.length !== 1 || !accepted.has(keys[0])) throw new Error('Grok subscription model identity receipt is unavailable or changed.');
  const reported = keys[0];
  const calls = observed[reported]?.modelCalls ?? observed[reported]?.model_calls;
  if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Grok subscription model-call receipt is unavailable.');
  return { calls, reported };
}

function acpArgs({ model, effort, maxModelCalls }) {
  return ['--no-auto-update', '--model', model, '--reasoning-effort', effort ?? 'medium', '--always-approve', '--no-plan', '--no-subagents', '--no-memory', '--disable-web-search',
    '--max-turns', String(maxModelCalls), 'agent', '--no-leader', 'stdio'];
}

export async function runGrokSubscriptionTurn({ prompt, model, effort = 'medium', worktree, scratch, receiptsDir, sourcePath = null, deniedPaths = [], nativeSession = null,
  signal, timeoutMs = 600000, maxModelCalls = 32, maxToolCalls = 0, tools = false, onNativeSession = () => {}, onNativeProgress = () => {},
  onTick = () => {}, rpcFactory = options => new CodexRpc(options), resolveHarness = resolveNativeHarness,
  assertArtifact = assertNativeHarnessArtifact, installAuth = installGrokSubscriptionAuth,
  preflightTools = preflightGrokSubscriptionTools, createPolicy = grokSubscriptionPolicy }) {
  const startedAt = Date.now(); let rpc = null, dispatched = false, ended = false, session = nativeSession, toolsHost = null, policy = null;
  let textByMessage = new Map(), lastMessage = null, stopReason = null, terminalUsage = null, terminalStopReason = null;
  try {
    if (!model || !Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) throw new Error('Grok subscription execution requires explicit bounded model and tool limits.');
    if (signal?.aborted) throw new Error('Grok subscription execution cancelled before preflight.');
    const harness = await resolveHarness(GROK_NATIVE_EXECUTOR); const artifactDigest = await assertArtifact(GROK_NATIVE_EXECUTOR, harness);
    policy = await createPolicy({ worktree, scratch, harness, artifactDigest, model, deniedPaths });
    if (tools) await preflightTools({ policy, sourcePath, receiptsDir, signal });
    await installAuth(policy.home); await installGrokSubscriptionConfig(policy.home, model);
    if (session && (session.version !== GROK_SUBSCRIPTION_POLICY_VERSION || session.policyHash !== policy.hash
        || session.model !== model || !Number.isSafeInteger(session.maximumModelCalls) || session.maximumModelCalls < 1
        || maxModelCalls > session.maximumModelCalls || !Number.isSafeInteger(session.maximumActions) || session.maximumActions < 0
        || maxToolCalls > session.maximumActions
        || session.harnessVersion !== REQUIRED_VERSION || typeof session.sessionId !== 'string')) {
      throw new Error('Grok subscription session policy changed; start a new explicitly authorized run.');
    }
    let activeSessionId = session?.sessionId ?? null;
    toolsHost = tools ? createGrokAcpTools({ sessionId: () => activeSessionId, worktree: policy.cwd, scratch: policy.toolHome,
      receiptsDir, deniedPaths, signal, maxToolCalls, onProgress: onNativeProgress, onTick, profile: policy.toolProfile }) : null;
    const notify = (method, params) => {
      if (!['session/update', '_x.ai/session/update'].includes(method) || !activeSessionId || params?.sessionId !== activeSessionId) return;
      const update = params.update;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Invalid Grok ACP message chunk.');
        const id = typeof update.messageId === 'string' && update.messageId ? update.messageId : 'default';
        const next = (textByMessage.get(id) ?? '') + update.content.text;
        if (Buffer.byteLength(next) > 65536) throw new Error('Grok subscription completion exceeded the response limit.');
        textByMessage.set(id, next); lastMessage = id;
      }
      if (update?.sessionUpdate === 'tool_call') onTick('Grok subscription maker requested a bounded host tool.');
      if (update?.sessionUpdate === 'turn_completed') {
        if (terminalUsage !== null) throw new Error('Grok subscription emitted duplicate terminal usage.');
        terminalUsage = update.usage;
      }
    };
    rpc = rpcFactory({ command: '/usr/bin/sandbox-exec', args: ['-p', policy.processProfile, policy.binary, ...acpArgs({ model, effort, maxModelCalls })],
      cwd: policy.temp, env: grokSubscriptionEnvironment(policy), timeoutMs: timeoutMs + 30000, protocol: 'jsonrpc2', onNotification: notify,
      onRequest: toolsHost ? (method, params) => toolsHost.handle(method, params) : null });
    const init = await rpc.request('initialize', { protocolVersion: 1,
      clientCapabilities: tools ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true } : {},
      clientInfo: { name: 'camus_grok_subscription', version: '1' } });
    if (init?.protocolVersion !== 1 || init?.agentInfo?.version && init.agentInfo.version !== REQUIRED_VERSION) throw new Error('Grok ACP version changed.');
    const authIds = new Set((init?.authMethods ?? []).map(item => item?.id));
    const methodId = authIds.has(REQUIRED_AUTH_METHOD) ? REQUIRED_AUTH_METHOD : null;
    if (!methodId) throw new Error('Grok cached subscription authentication is unavailable; run `grok login`, and API-key fallback remains refused.');
    await rpc.request('authenticate', { methodId, _meta: { headless: true } }, 30000);
    const opened = session
      ? await rpc.request('session/load', { sessionId: session.sessionId, cwd: policy.cwd, mcpServers: [], _meta: { yoloMode: true } }, 30000)
      : await rpc.request('session/new', { cwd: policy.cwd, mcpServers: [], maxTurns: maxModelCalls, _meta: { yoloMode: true } }, 30000);
    activeSessionId = session?.sessionId ?? opened?.sessionId;
    if (typeof activeSessionId !== 'string' || !activeSessionId || activeSessionId.length > 256) throw new Error('Grok ACP session identity is invalid.');
    if (opened?.models && opened.models.currentModelId !== model) throw new Error('Grok ACP selected a different model; substitution refused.');
    session = { version: GROK_SUBSCRIPTION_POLICY_VERSION, executor: GROK_NATIVE_EXECUTOR, policyHash: policy.hash, model,
      harnessVersion: REQUIRED_VERSION, sessionId: activeSessionId, maximumModelCalls: maxModelCalls,
      maximumActions: maxToolCalls,
      billingAuthority: 'grok_subscription', authMethod: methodId };
    onNativeSession(session); dispatched = true;
    const response = await rpc.request('session/prompt', { sessionId: activeSessionId, prompt: [{ type: 'text', text: prompt }] }, timeoutMs);
    ended = true; terminalStopReason = response?.stopReason ?? null;
    if (response?.stopReason !== 'end_turn') throw new Error(`Grok subscription turn stopped as ${response?.stopReason ?? 'unknown'}.`);
    const receipt = modelReceipt({ modelUsage: terminalUsage?.modelUsage }, model);
    const usage = normalizeGrokSubscriptionUsage(terminalUsage);
    if (receipt.calls > maxModelCalls) throw new Error('Grok subscription model-call receipt exceeded the frozen bound.');
    const progressReason = onNativeProgress({ usage, responses: receipt.calls, actions: toolsHost?.actions ?? 0 });
    if (progressReason) { stopReason = String(progressReason); throw new Error(stopReason); }
    const text = String(textByMessage.get(lastMessage) ?? '').trim();
    if (!text) throw new Error('Grok subscription returned no final message.');
    return { ok: true, text, usage, nativeSession: session, definitiveTurnEnd: true, modelActual: `xai:${model}`, modelReported: receipt.reported,
      modelActualEvidence: 'observed_cli_event', billingAuthority: 'grok_subscription', authMethod: methodId, durationMs: Date.now() - startedAt };
  } catch (error) {
    let usage = null, receipt = null;
    try { if (terminalUsage) usage = normalizeGrokSubscriptionUsage(terminalUsage); } catch { /* invalid evidence stays unmeasured */ }
    try { if (terminalUsage) receipt = modelReceipt({ modelUsage: terminalUsage.modelUsage }, model); } catch { /* identity stays unobserved */ }
    const failureCode = !dispatched ? 'preflight_refused'
      : !ended ? 'terminal_missing'
        : terminalUsage === null ? 'terminal_receipt_missing'
          : terminalStopReason !== 'end_turn' ? 'terminal_non_success' : 'terminal_validation_failed';
    return { ok: false, error: String(stopReason ?? error?.message ?? error).slice(0, 600), failureCode,
      uncertain: dispatched && !ended, noModelCalled: !dispatched, definitiveTurnEnd: ended, usage, nativeSession: session,
      ...(receipt ? { modelActual: `xai:${model}`, modelReported: receipt.reported, modelActualEvidence: 'observed_cli_event' } : {}),
      billingAuthority: 'grok_subscription' };
  } finally {
    await toolsHost?.cleanup().catch(() => {}); await rpc?.close().catch(() => {});
    if (policy) await unlink(join(policy.home, 'auth.json')).catch(error => {
      if (error?.code !== 'ENOENT') throw new Error('The isolated Grok login copy could not be removed; execution refused.');
    });
  }
}

// Native subscription makers use Grok Build's official ACP completion boundary.
// The older streaming-json path could close after a valid final inference without
// emitting its separate `end` frame, leaving Camus unable to prove the turn.
export const runNativeGrokSubscription = options => runGrokSubscriptionTurn({ ...options, tools: true });

async function withPrivateScratch(root, prefix, callback) {
  if (typeof root !== 'string' || !root) throw new Error('Grok subscription execution requires a private receipt directory.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(root, prefix));
  try { return await callback(scratch); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

export const runGrokSubscriptionMaker = options => withPrivateScratch(options.ownedProcessDir ?? dirname(options.cwd), 'grok-maker-', scratch =>
  runGrokSubscriptionTurn({ ...options, worktree: options.cwd, scratch, receiptsDir: options.ownedProcessDir ?? dirname(options.cwd),
    tools: false, maxToolCalls: 0, maxModelCalls: 1 }));

export async function runGrokSubscriptionReview(options) {
  const startedAt = Date.now();
  const root = options.ownedProcessDir ?? options.receiptDir;
  const result = await withPrivateScratch(root, 'grok-review-', scratch => runGrokSubscriptionTurn({ ...options,
    worktree: options.cwd, scratch, receiptsDir: root, tools: false, maxToolCalls: 0, maxModelCalls: 1 }));
  if (!result.ok) return { ran: false, error: result.error, verdict: 'ERROR', findings: [], questions: [], claimAssessments: [],
    coverageAssessments: [], thresholdAssessments: [], usage: result.usage, durationMs: Date.now() - startedAt };
  const normalized = normalizeReview(result.text, 0, options.claims ?? [], options.criteria ?? [], options.thresholds ?? []);
  normalized.usage = result.usage; normalized.durationMs = result.durationMs;
  if (normalized.ran) {
    normalized.reviewerModel = options.model; normalized.reviewerEffort = options.effort ?? 'medium';
    normalized.reviewerIdentity = result.modelActual; normalized.reviewerReportedModel = result.modelReported;
    normalized.reviewerActualEvidence = result.modelActualEvidence;
  }
  return normalized;
}
