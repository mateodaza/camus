// No inference: this module may initialize ACP and open a fresh empty session,
// but intentionally has no session/prompt, replay, or authenticate fallback.
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { CodexRpc } from './codex-rpc.mjs';
import { runNativeProcess } from './native-process.mjs';
import { DEVIN_NATIVE_DIGEST, DEVIN_NATIVE_MODEL, DEVIN_NATIVE_VERSION,
  DEVIN_NATIVE_PROTOCOL_VERSION, validateDevinSession } from './devin-native-protocol.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => JSON.stringify(String(value));
const within = (parent, child) => child === parent || child.startsWith(parent + sep);
const MAX_LOGIN_BYTES = 256 * 1024;

export function devinIsolatedEnvironment(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || resolve(root) !== root || root === '/')
    throw new Error('Invalid Devin private root.');
  return Object.freeze({ PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: join(root, 'tmp'),
    CI: '1', TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8', DEVIN_SANDBOX: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
}

export function devinIsolatedConfig() {
  return { agent: { model: DEVIN_NATIVE_MODEL }, auto_update: false, subagents_enabled: false,
    attribution: false, notify: 'never', proxy: { mode: 'off' },
    read_config_from: { cursor: false, windsurf: false, claude: false },
    permissions: { allow: [], ask: [], deny: [] } };
}

// The initial supported login route is the official self-serve endpoint set.
// Enterprise/custom endpoints need a separate explicit contract, not a silent
// redirect. Parse only the small observed credential schema; never log values.
export function validateDevinLogin(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_LOGIN_BYTES)
    throw new Error('Devin login is absent or oversized.');
  const values = new Map();
  const allowed = new Set(['windsurf_api_key', 'api_server_url', 'devin_webapp_host', 'devin_api_url']);
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/);
    if (!match || !allowed.has(match[1]) || values.has(match[1])) throw new Error('Devin login schema is unsupported.');
    let value;
    try { value = JSON.parse(match[2]); } catch { throw new Error('Devin login schema is unsupported.'); }
    values.set(match[1], value);
  }
  if (!values.get('windsurf_api_key')?.trim() || values.size !== 4
      || values.get('api_server_url') !== 'https://server.codeium.com'
      || values.get('devin_webapp_host') !== 'app.devin.ai'
      || values.get('devin_api_url') !== 'https://api.devin.ai')
    throw new Error('Devin official stored-login route is unproven.');
  return true;
}

export function renderDevinPreflightProfile({ root, harness, candidate, operatorHome = homedir(), candidateMetadata = false }) {
  if (typeof candidateMetadata !== 'boolean') throw new Error('Invalid Devin candidate metadata policy.');
  for (const path of [root, harness, candidate, operatorHome]) {
    if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || resolve(path) !== path)
      throw new Error('Invalid Devin isolation path.');
  }
  if (within(root, candidate) || within(candidate, root)) throw new Error('Devin candidate and credentials must be separate.');
  const parents = new Set(['/']);
  for (const path of [root, harness, candidate]) {
    let current = path;
    while (current !== '/') { current = dirname(current); parents.add(current); }
  }
  // The pinned CLI could not fetch team settings with network-outbound alone.
  // Both trustd lookup and TCP inbound permission were required in the isolated
  // no-prompt control. Do not use blanket mach-lookup/network* grants. This is
  // the authenticated process profile, never the model's terminal-tool profile.
  return `(version 1)
(deny default)
(allow file-read*)
(deny file-read* (subpath ${quote(operatorHome)}) (subpath "/Users/Shared") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read-metadata ${[...parents].map(path => `(literal ${quote(path)})`).join(' ')} (literal ${quote(candidate)}))
${candidateMetadata ? `(allow file-read-metadata (subpath ${quote(candidate)}))` : ''}
(allow file-read* (subpath ${quote(root)}) (literal ${quote(harness)}))
(deny file-read-data (subpath ${quote(candidate)}))
(allow file-write* (subpath ${quote(root)}) (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null"))
(allow process-exec (literal ${quote(harness)}))
(allow network-outbound)
(allow network-inbound (local tcp "*:*"))
(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(allow file-ioctl (regex #"^/dev/tty.*"))`;
}

export async function inspectDevinAcp(rpc, { candidate, signal } = {}) {
  const checked = async (method, params) => {
    if (signal?.aborted) throw new Error('Devin preflight cancelled.');
    try { return await rpc.request(method, params, 25000); }
    catch { throw new Error(`Devin ${method} preflight failed; no model prompt was sent.`); }
  };
  const initialized = await checked('initialize', { protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'camus_devin_preflight', version: '1' } });
  if (initialized?.protocolVersion !== 1 || !Array.isArray(initialized.authMethods)
      || !initialized.authMethods.some(method => method?.id === 'devin-browser'))
    throw new Error('Devin supported ACP login capability is unavailable.');
  const session = validateDevinSession(await checked('session/new', { cwd: candidate, mcpServers: [] }));
  return { protocolVersion: 1, modelSelected: session.modelSelected, mode: session.mode,
    mcpHttpAdvertised: initialized.agentCapabilities?.mcpCapabilities?.http === true,
    mcpSseAdvertised: initialized.agentCapabilities?.mcpCapabilities?.sse === true,
    authMethodAdvertised: 'devin-browser', sessionOpened: true, promptsSent: 0,
    delegatedToolsProven: false, actualModelProven: false, runAccountingProven: false };
}

export async function runDevinNativePreflight({ binary, credentialSource, signal,
  rpcFactory = options => new CodexRpc(options) } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Devin native preflight currently requires macOS arm64.');
  if (signal?.aborted) throw new Error('Devin preflight cancelled before dispatch.');
  const started = Date.now();
  const requested = binary ?? process.env.CAMUS_DEVIN_BIN ?? join(homedir(), '.local/bin/devin');
  const harness = await realpath(requested);
  await access(harness, constants.X_OK);
  if (hash(await readFile(harness)) !== DEVIN_NATIVE_DIGEST) throw new Error('Devin artifact does not match the reviewed pin; no model was called.');
  const source = credentialSource ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'devin/credentials.toml');
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_LOGIN_BYTES
      || info.uid !== process.getuid() || (info.mode & 0o022) || await realpath(source) !== resolve(source))
    throw new Error('Devin login must be an owned, unlinked regular file without group/world writes.');
  const bytes = await readFile(source); validateDevinLogin(bytes);
  let root, candidate, rpc, aborted;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-preflight-')));
    candidate = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-empty-')));
    const env = devinIsolatedEnvironment(root);
    for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.TMPDIR,
      join(env.XDG_CONFIG_HOME, 'devin'), join(env.XDG_DATA_HOME, 'devin')]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(env.XDG_DATA_HOME, 'devin/credentials.toml'), bytes, { mode: 0o600, flag: 'wx' });
    const config = join(env.XDG_CONFIG_HOME, 'devin/config.json');
    await writeFile(config, JSON.stringify(devinIsolatedConfig()), { mode: 0o600, flag: 'wx' });
    await writeFile(join(env.XDG_CONFIG_HOME, 'devin/mcp_config.json'), '{"mcpServers":{}}', { mode: 0o600, flag: 'wx' });
    const profile = renderDevinPreflightProfile({ root, harness, candidate });
    const version = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, harness, '--version'],
      cwd: root, env, signal, timeoutMs: 10000, maxBytes: 16384 });
    if (version.code !== 0 || !/^devin 3000\.10\.21 \(611c1cba\)\s*$/.test(version.stdout?.trim() ?? ''))
      throw new Error(`Devin isolated executable/version preflight failed (exit ${Number.isInteger(version.code) ? version.code : 'unknown'}).`);
    rpc = rpcFactory({ command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, harness, '--config', config, '--sandbox', 'acp', '--model', DEVIN_NATIVE_MODEL],
      cwd: root, env, timeoutMs: 60000, protocol: 'jsonrpc2',
      // No native permissions or host tools are authorized during initialization.
      onRequest: () => { rpc.fail('Devin preflight requested tool authority.'); throw new Error('No preflight tool authority.'); } });
    aborted = () => rpc.fail('Devin preflight cancelled.');
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const result = await inspectDevinAcp(rpc, { candidate, signal });
    return { ...result, contractVersion: DEVIN_NATIVE_PROTOCOL_VERSION, harnessVersion: DEVIN_NATIVE_VERSION,
      artifactDigest: DEVIN_NATIVE_DIGEST, isolatedStoredLogin: true, sourceLoginPrivate: (info.mode & 0o077) === 0,
      completionRequestsSent: 0, inferenceEnvironmentOverridesInherited: false,
      elapsedMs: Date.now() - started, productionReady: false };
  } finally {
    if (aborted) signal?.removeEventListener('abort', aborted);
    // Do not delete scratch before proving its writer is stopped. A cleanup
    // failure remains a failure, never a successful readiness report.
    let cleanupProven = !rpc;
    try { await rpc?.close(); cleanupProven = true; }
    finally {
      bytes.fill(0);
      if (!cleanupProven || rpc && rpc.child?.exitCode === null && rpc.child?.signalCode === null)
        throw new Error('Devin preflight writer cleanup is unproven; private scratch retained.');
      if (root) await rm(root, { recursive: true });
      if (candidate) await rm(candidate, { recursive: true });
    }
  }
}
