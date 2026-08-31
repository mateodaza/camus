import { mkdir, realpath, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { scrubbedEnv } from './adapters/codex.mjs';
import { HARNESS_NATIVE_EXECUTORS, GROK_NATIVE_EXECUTOR, isHarnessNativeExecutor } from './native-harness-policy.mjs';
export { HARNESS_NATIVE_EXECUTORS, QWEN_NATIVE_EXECUTOR, GROK_NATIVE_EXECUTOR } from './native-harness-policy.mjs';

export const NATIVE_EXECUTOR = 'codex_native';
export const NATIVE_EXECUTORS = Object.freeze([NATIVE_EXECUTOR, ...HARNESS_NATIVE_EXECUTORS]);
export const isNativeExecutor = value => NATIVE_EXECUTORS.includes(value);
export const NATIVE_MIN_TOKEN_BUDGET = 32768;
export const NATIVE_POLICY_VERSION = 'codex-native/v1';
const disabled = ['apps', 'plugins', 'hooks', 'multi_agent', 'goals', 'memories', 'shell_snapshot',
  'skill_search', 'skill_mcp_dependency_install', 'remote_plugin', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation', 'unbounded_connection_retries',
  'remote_control', 'tool_suggest', 'auth_elicitation'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const toml = value => Array.isArray(value) ? `[${value.map(toml).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`
    : JSON.stringify(value);

export function validateCodeExecutor(seat, backend, role = 'maker') {
  const executor = seat?.codeExecutor;
  if (backend?.kind === 'grok_cli') {
    if (executor === undefined) return; // tool-less words maker/reviewer; Build injects grok_native before validation
    if (role === 'maker' && executor === GROK_NATIVE_EXECUTOR) return;
    if (role === 'reviewer' && (executor === undefined || executor === 'file_actions')) return;
    throw new Error('The built-in Grok maker uses grok_native with Grok subscription authentication; no API or file-actions fallback was made.');
  }
  if (executor === undefined || executor === 'file_actions') return;
  if (isHarnessNativeExecutor(executor)) {
    if (role !== 'maker' || backend?.kind !== 'openai_compat') throw new Error(`${executor} is available only for an explicitly qualified OpenAI-compatible maker; no fallback was made.`);
    return;
  }
  // Legacy built-in definitions omit transport; their identity facts derive
  // vendor_managed from the reserved name. Do not change old binding snapshots.
  const transport = backend?.transport ?? (backend?.name === 'codex' ? 'vendor_managed' : null);
  if (executor !== NATIVE_EXECUTOR || role !== 'maker' || seat.backend !== 'codex'
      || backend?.kind !== 'codex_cli' || backend.name && backend.name !== 'codex' || transport !== 'vendor_managed') {
    throw new Error('codex_native is available only for the built-in vendor-managed Codex maker; no fallback was made.');
  }
}

export async function nativePolicy({ worktree, scratch, deniedPaths = [], platform = process.platform }) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Native Codex requires a verified POSIX sandbox; this platform is unsupported.');
  const cwd = await realpath(worktree);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const temp = await realpath(scratch);
  if (temp === cwd || temp.startsWith(cwd + '/')) throw new Error('Native private scratch must be outside the candidate.');
  await mkdir(join(temp, 'home'), { recursive: true, mode: 0o700 });
  const node = await realpath(process.execPath);
  const readable = [...new Set([dirname(dirname(node)), '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/bin', '/System/Library/OpenSSL'])];
  // Git objects can contain protected files and old credentials. Read-only Git
  // is not a privacy boundary: only the host may inspect this clone's metadata.
  const filesystem = { ':minimal': 'read', [cwd]: 'write', [temp]: 'write', [join(cwd, '.git')]: 'deny' };
  for (const path of readable) filesystem[path] = 'read';
  for (const path of deniedPaths) {
    const absolute = resolve(cwd, path);
    if (!absolute.startsWith(cwd + '/')) throw new Error('Invalid native denied path.');
    filesystem[absolute] = 'deny';
  }
  for (const path of ['.env', '.npmrc', '.netrc', '.camus', '.claude', '.codex', '.ssh', '.aws', '.azure']) filesystem[join(cwd, path)] = 'deny';
  const config = {
    default_permissions: 'camus_native',
    'permissions.camus_native.filesystem': filesystem,
    'permissions.camus_native.network.enabled': false,
    approval_policy: 'never', model_provider: 'openai', model_providers: {},
    forced_login_method: 'chatgpt', mcp_servers: {}, notify: [],
    'analytics.enabled': false, 'otel.exporter': 'none', 'otel.trace_exporter': 'none',
    web_search: 'disabled', project_doc_max_bytes: 0,
    developer_instructions: '', instructions: '', allow_login_shell: false,
    projects: { [cwd]: { trust_level: 'untrusted' } },
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': { PATH: [dirname(node), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
      HOME: join(temp, 'home'), TMPDIR: temp, NPM_CONFIG_CACHE: join(temp, 'npm-cache'),
      CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', PYTHONDONTWRITEBYTECODE: '1',
      // Desktop configuration can inject a browser-client trust allowlist.
      // Tables merge: explicitly clear this known field rather than inheriting
      // trust or permitting arbitrary extra shell variables. Browser tools are
      // also disabled above; every other unexpected set entry still refuses.
      NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: '' },
    ...Object.fromEntries(disabled.map(name => [`features.${name}`, false])),
  };
  return { version: NATIVE_POLICY_VERSION, hash: hash({ cwd, config }), cwd, temp, node, config };
}

export const nativeArgs = policy => ['app-server', '--stdio', ...Object.entries(policy.config).flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`])];
export const nativeEnvironment = () => {
  const env = scrubbedEnv();
  // No ambient proxy may redirect authenticated native traffic. Saved CLI
  // authentication remains in its normal store; nothing is copied into a repo.
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  return env;
};

export function assertNativeThread(thread, { policy, model, session = null }) {
  // workspaceWrite reports ADDITIONAL writable roots: cwd is implicitly
  // writable. Some versions also include cwd explicitly. Normalize that one
  // representation difference, never an extra root or a missing scratch root.
  const roots = thread?.sandbox?.writableRoots;
  const effectiveRoots = Array.isArray(roots) && roots.every(root => typeof root === 'string')
    ? [...new Set([thread.cwd, ...roots])].sort() : null;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(thread?.thread?.id ?? '')
      || session && thread.thread.id !== session.threadId || thread.model !== model
      || thread.modelProvider !== 'openai' || thread.cwd !== policy.cwd || thread.approvalPolicy !== 'never'
      || thread.activePermissionProfile?.id !== 'camus_native' || thread.activePermissionProfile.extends != null
      || thread.sandbox?.type !== 'workspaceWrite' || thread.sandbox.networkAccess !== false
      || thread.sandbox.excludeTmpdirEnvVar !== true || thread.sandbox.excludeSlashTmp !== true
      || !isDeepStrictEqual(effectiveRoots, [policy.cwd, policy.temp].sort())
      || (thread.instructionSources?.length ?? 0)) throw new Error('Native thread did not honor its frozen execution contract.');
}

// Called before thread creation or generation. An override that did not take
// effect is an infrastructure failure, never a reason to relax the policy.
export function assertNativeConfig(config, { allowMcpDiscovery = false, policy } = {}) {
  const officialRoute = (value, expected) => value == null || typeof value === 'string' && value.replace(/\/$/, '') === expected;
  const checks = { approval: config?.approval_policy === 'never', provider: config?.model_provider === 'openai',
    login: config?.forced_login_method === 'chatgpt', web: config?.web_search === 'disabled',
    mcp: allowMcpDiscovery || Object.values(config?.mcp_servers ?? {}).every(server => server.enabled === false),
    providers: !config?.model_providers?.openai,
    features: disabled.every(name => config?.features?.[name] === false),
    instructions: config?.project_doc_max_bytes === 0 && config?.instructions === '' && config?.developer_instructions === ''
      && !config?.model_instructions_file && !config?.experimental_compact_prompt_file && !config?.compact_prompt && !config?.model_catalog_json,
    telemetry: config?.analytics?.enabled === false && config?.otel?.exporter === 'none' && config?.otel?.trace_exporter === 'none',
    notify: !(config?.notify?.length), route: officialRoute(config?.openai_base_url, 'https://api.openai.com/v1')
      && officialRoute(config?.chatgpt_base_url, 'https://chatgpt.com/backend-api') };
  if (policy) {
    const profile = config?.permissions?.camus_native;
    // Config tables merge. Any inherited widening, including shell env entries
    // or a profile extension, must fail closed before a thread can run.
    const fs = Object.fromEntries(Object.entries(profile?.filesystem ?? {}).filter(([, v]) => v !== null));
    const network = Object.fromEntries(Object.entries(profile?.network ?? {}).filter(([, v]) => v !== null));
    checks.permissions = config.default_permissions === 'camus_native' && !profile?.extends && !profile?.workspace_roots
      && isDeepStrictEqual(fs, policy.config['permissions.camus_native.filesystem'])
      && isDeepStrictEqual(network, { enabled: false });
    const shell = config?.shell_environment_policy;
    checks.shell = config?.allow_login_shell === false && shell?.inherit === 'none' && !shell?.experimental_use_profile
      && isDeepStrictEqual(shell?.set, policy.config['shell_environment_policy.set']);
  }
  const failed = Object.keys(checks).filter(key => !checks[key]);
  if (failed.length) throw new Error(`Native effective configuration is not isolated (${failed.join(', ')}); no model was called.`);
}

export async function isolateNativeConfig(rpc, policy) {
  await rpc.request('initialize', { clientInfo: { name: 'camus_native_preflight', version: '1' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized', params: {} });
  const read = await rpc.request('config/read', { includeLayers: false, cwd: policy.cwd });
  assertNativeConfig(read?.config, { allowMcpDiscovery: true, policy });
  const config = { ...policy.config };
  config.mcp_servers = Object.fromEntries(Object.keys(read.config.mcp_servers ?? {}).sort().map(name => [name, { enabled: false }]));
  return { ...policy, config, hash: hash({ cwd: policy.cwd, config }) };
}

export async function preflightNative(rpc, policy, { sourcePath, receiptsDir }) {
  await rpc.request('initialize', { clientInfo: { name: 'camus_native', version: '1' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized', params: {} });
  const read = await rpc.request('config/read', { includeLayers: false, cwd: policy.cwd });
  assertNativeConfig(read?.config, { policy });
  // Synthetic probes only. No credential files or environment values are read.
  const nonce = randomBytes(16).toString('hex');
  const sentinel = join(receiptsDir, `native-private-boundary-probe-${nonce}`);
  await writeFile(sentinel, 'synthetic boundary probe', { mode: 0o600, flag: 'wx' });
  const candidateProbe = join(policy.cwd, `.camus-native-probe-${nonce}`);
  const probe = `const fs=require('fs'),net=require('net'),a=require('assert/strict');
const denied=e=>['EPERM','EACCES'].includes(e.code);
a.throws(()=>fs.readFileSync('.git/HEAD'),denied);const p=${JSON.stringify(candidateProbe)};fs.writeFileSync(p,'probe',{flag:'wx'});fs.unlinkSync(p);
a.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),denied);
a.throws(()=>fs.readdirSync(${JSON.stringify(sourcePath)}),denied);
a.throws(()=>fs.writeFileSync('.git/camus-native-probe','no'),denied);
const s=net.connect({host:'1.1.1.1',port:443});s.once('connect',()=>process.exit(2));s.once('error',e=>{a(['EPERM','EACCES'].includes(e.code));console.log('camus-native-sandbox-v1')});setTimeout(()=>process.exit(3),2500).unref();`;
  try {
    const check = await rpc.request('command/exec', { command: [policy.node, '-e', probe], cwd: policy.cwd,
      permissionProfile: 'camus_native', timeoutMs: 5000, outputBytesCap: 1024 });
    if (check?.exitCode !== 0 || !check.stdout?.includes('camus-native-sandbox-v1')) throw new Error('Native sandbox preflight failed; no model was called.');
  } finally {
    await unlink(sentinel).catch(() => {});
    await unlink(candidateProbe).catch(() => {});
  }
}
