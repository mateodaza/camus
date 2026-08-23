// Managed OpenSSH local-forward transport (RFC §8).
//
// This module is deliberately transport-only. It owns an ssh -N -T child and
// exposes a short-lived local URL; it never accepts a command, copies files,
// or hands an SSH argv through from a caller. The manager is process-local and
// reference counted so doctor, qualification, and runtime all share one owner.

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, rename, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

const ALIAS_RE = /^[A-Za-z0-9._-]+$/;
const CONTROL_NO = new Set(['no', 'false', 'off', 'none']);
const HARDENING = Object.freeze([
  '-N', '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ClearAllForwardings=no',
  '-o', 'ForwardAgent=no',
  '-o', 'ForwardX11=no',
  '-o', 'PermitLocalCommand=no',
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'Tunnel=no',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ConnectTimeout=10',
]);

export const TUNNEL_CONTRACT_VERSION = 'ssh-tunnel-1';

export class TunnelError extends Error {
  constructor(message, code = 'tunnel') {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
  }
}

function text(value) { return String(value ?? ''); }
function normalizedBasePath(value) {
  if (value === undefined) return '/v1';
  if (typeof value !== 'string' || !value.startsWith('/') || /[?#\s]/.test(value)) {
    throw new TunnelError('ssh_tunnel.basePath must be an absolute URL path without query, fragment, or whitespace', 'config');
  }
  return value.replace(/\/$/, '') || '/';
}

export function validateSshTunnelConfig(connection = {}) {
  if (connection.kind !== 'ssh_tunnel') throw new TunnelError('connection kind must be ssh_tunnel', 'config');
  const allowed = new Set(['kind', 'name', 'sshHostAlias', 'remoteAddress', 'remotePort', 'basePath', 'why', 'anonymous', 'baseUrl']);
  const unknown = Object.keys(connection).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TunnelError(`ssh_tunnel config contains unsupported field(s): ${unknown.join(', ')}`, 'config');
  if (connection.baseUrl != null) throw new TunnelError('ssh_tunnel has no static baseUrl; the local port exists only at runtime', 'config');
  const alias = connection.sshHostAlias;
  if (typeof alias !== 'string' || !alias || alias.startsWith('-') || !ALIAS_RE.test(alias)) {
    throw new TunnelError('ssh_tunnel.sshHostAlias must match ^[A-Za-z0-9._-]+$ and must not begin with "-"', 'config');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(String(connection.remoteAddress || '').toLowerCase())) {
    throw new TunnelError('ssh_tunnel.remoteAddress must be remote loopback (localhost, 127.0.0.1, or ::1); forwarding to a third host is a pivot', 'config');
  }
  if (!Number.isInteger(connection.remotePort) || connection.remotePort < 1 || connection.remotePort > 65535) {
    throw new TunnelError('ssh_tunnel.remotePort must be an integer from 1 to 65535', 'config');
  }
  return {
    kind: 'ssh_tunnel',
    name: connection.name ?? null,
    sshHostAlias: alias,
    remoteAddress: String(connection.remoteAddress).toLowerCase(),
    remotePort: connection.remotePort,
    basePath: normalizedBasePath(connection.basePath),
  };
}

function forwardSpec(localPort, connection) {
  const remote = connection.remoteAddress === '::1' ? '[::1]' : connection.remoteAddress;
  return `127.0.0.1:${localPort}:${remote}:${connection.remotePort}`;
}

export function buildSshArgv(connection, localPort, { config = false } = {}) {
  const c = validateSshTunnelConfig(connection);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new TunnelError('localPort must be a kernel-assigned TCP port', 'config');
  const args = [...HARDENING, '-L', forwardSpec(localPort, c)];
  if (config) args.push('-G');
  args.push('--', c.sshHostAlias);
  return args;
}

export function stableConnectionIdentity(connection) {
  // Runtime lease metadata is deliberately excluded: the same named remote
  // connection must retain its qualification fingerprint across local ports.
  const c = validateSshTunnelConfig(Object.fromEntries(
    Object.entries(connection || {}).filter(([key]) => !['localPort', 'url', 'resolvedBaseUrl', 'tunnelLease', 'connectionDetails'].includes(key)),
  ));
  return {
    kind: c.kind,
    sshHostAlias: c.sshHostAlias,
    remoteAddress: c.remoteAddress,
    remotePort: c.remotePort,
    basePath: c.basePath,
  };
}

export function connectionFingerprint(connection) {
  return `ssh1:${createHash('sha256').update(JSON.stringify(stableConnectionIdentity(connection))).digest('hex')}`;
}

function expectedForwardLine(port, connection) {
  return `127.0.0.1:${port}:${connection.remoteAddress}:${connection.remotePort}`.toLowerCase();
}

export function screenSshConfig(raw, { localPort, connection } = {}) {
  const lines = text(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new TunnelError('ssh -G returned no effective configuration; refusing the tunnel', 'preflight');
  const parsed = new Map();
  for (const line of lines) {
    const i = line.search(/\s/);
    if (i < 0) continue;
    parsed.set(line.slice(0, i).toLowerCase(), line.slice(i).trim());
  }
  if (!parsed.get('hostname')) throw new TunnelError('ssh -G did not yield a hostname; refusing the tunnel', 'preflight');
  const local = [];
  const remote = [];
  const dynamic = [];
  for (const line of lines) {
    const m = /^(localforward|remoteforward|dynamicforward)\s+(.+)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'localforward') local.push(m[2].toLowerCase());
    else if (m[1].toLowerCase() === 'remoteforward') remote.push(m[2]);
    else dynamic.push(m[2]);
  }
  const canonicalForward = (line) => line.toLowerCase().replace(/[\[\]]/g, '').replace(/\s+/g, ' ');
  const wantedLocal = `127.0.0.1:${localPort}`;
  const wantedRemote = `${connection.remoteAddress}:${connection.remotePort}`;
  const extraLocal = local.filter((line) => {
    const normalized = canonicalForward(line);
    return !normalized.includes(wantedLocal) || !normalized.includes(wantedRemote);
  });
  if (extraLocal.length) throw new TunnelError('ssh config declares an additional LocalForward; move it off the Camus alias or use a dedicated alias', 'preflight');
  if (remote.length) throw new TunnelError('ssh config declares RemoteForward; managed inference allows local forwarding only', 'preflight');
  if (dynamic.length) throw new TunnelError('ssh config declares DynamicForward; managed inference allows local forwarding only', 'preflight');
  const value = (key) => parsed.get(key);
  if (value('permitlocalcommand') === 'yes') throw new TunnelError('ssh config enables PermitLocalCommand; move it off the Camus alias', 'preflight');
  if (value('forwardagent') === 'yes') throw new TunnelError('ssh config enables ForwardAgent; move it off the Camus alias', 'preflight');
  if (value('forwardx11') === 'yes') throw new TunnelError('ssh config enables ForwardX11; move it off the Camus alias', 'preflight');
  if (value('tunnel') && !CONTROL_NO.has(value('tunnel').toLowerCase())) throw new TunnelError('ssh config enables Tunnel; managed inference is not a tun device', 'preflight');
  if (value('clearallforwardings') === 'yes') throw new TunnelError('ssh config enables ClearAllForwardings; set it to no for the Camus alias', 'preflight');
  if (value('controlmaster') && !CONTROL_NO.has(value('controlmaster').toLowerCase())) throw new TunnelError('ssh config enables ControlMaster; managed tunnels do not use multiplexing', 'preflight');
  return {
    hostname: value('hostname'),
    hostKeyAlias: value('hostkeyalias') || null,
    userKnownHostsFile: value('userknownhostsfile') || null,
    globalKnownHostsFile: value('globalknownhostsfile') || null,
    proxyCommand: value('proxycommand') || null,
    proxyJump: value('proxyjump') || null,
    matchExec: value('match') || null,
    port: value('port') || '22',
  };
}

export async function advisoryHostKeyLookup({ execFileImpl = nodeExecFile, effective, port = 22 } = {}) {
  const host = effective?.hostKeyAlias || effective?.hostname;
  const files = [...new Set([
    ...(text(effective?.userKnownHostsFile).match(/\S+/g) || []),
    ...(text(effective?.globalKnownHostsFile).match(/\S+/g) || []),
  ])].filter((file) => file && file !== 'none');
  if (!host || !files.length) return { found: false, files, host };
  const lookup = port && Number(port) !== 22 ? `[${host}]:${port}` : host;
  for (const file of files) {
    try {
      const result = await new Promise((resolve) => execFileImpl('ssh-keygen', ['-F', lookup, '-f', file], { timeout: 3000 }, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
      if (!result.error && result.stdout.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#'))) {
        return { found: true, files, host, file };
      }
    } catch { /* advisory only */ }
  }
  return { found: false, files, host };
}

const REDACTION = [
  [/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)/g, '‹user›@‹host›'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '‹ip›'],
  [/(?:^|[\s=(])(?:[A-Za-z]:)?(?:\/|\\)[^\s)]+/g, '$1‹path›'],
  [/Bearer\s+[^\s]+/gi, 'Bearer ‹redacted›'],
  [/(?:sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,}/gi, '‹credential›'],
];

export function redactSshDiagnostics(stderr, { maxBytes = 64 * 1024 } = {}) {
  let out = text(stderr).slice(-maxBytes);
  for (const [pattern, replacement] of REDACTION) out = out.replace(pattern, replacement);
  return out.split(/\r?\n/).map((line) => line.slice(0, 512)).join('\n').slice(-maxBytes);
}

function defaultTunnelDir() { return process.env.STUDIO_TUNNEL_DIR || join(homedir(), '.camus', 'studio', 'tunnels'); }
function safeName(name) { return String(name || 'connection').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }

async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { const handle = await open(temp, 'r'); await handle.sync(); await handle.close(); } catch { /* best effort on platforms without fsync */ }
  await rename(temp, path);
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const port = server.address()?.port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function nonLoopbackForwardReachable(port) {
  const addresses = Object.values(networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === 'IPv4').map((item) => item.address);
  return Promise.all(addresses.map((host) => new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  }))).then((results) => results.some(Boolean));
}

function execFilePromise(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => error
      ? reject(Object.assign(error, { stdout, stderr }))
      : resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function processStartIdentity(execFileImpl, pid) {
  if (!pid) return null;
  try {
    const result = await execFilePromise(execFileImpl, 'ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 });
    const value = result.stdout.trim();
    return value || null;
  } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function emit(onEvidence, fact) {
  try { onEvidence?.({ control_id: `slice-d.${fact.control}`, control_version: TUNNEL_CONTRACT_VERSION, ...fact }); } catch { /* evidence must never change transport control */ }
}

export function createTunnelManager({
  spawnImpl = nodeSpawn,
  execFileImpl = nodeExecFile,
  fetchImpl = fetch,
  tunnelDir = defaultTunnelDir(),
  lingerMs = 250,
  onEvidence,
  now = () => new Date().toISOString(),
  allocatePortImpl = allocatePort,
} = {}) {
  const active = new Map();
  const ensureDir = (name) => join(tunnelDir, safeName(name));

  async function diagnostics(name, stderr, event) {
    const dir = ensureDir(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'diagnostics.log');
    const redacted = redactSshDiagnostics(stderr);
    if (redacted) await writeFile(path, `${redacted}\n${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (process.env.STUDIO_TUNNEL_DEBUG === '1' && stderr) {
      await writeFile(join(dir, 'diagnostics.raw.log'), `${text(stderr).slice(-64 * 1024)}\n`, { mode: 0o600 });
    }
    return path;
  }

  async function sweepOrphans() {
    let dirs = [];
    try { dirs = await readdir(tunnelDir, { withFileTypes: true }); } catch { return []; }
    const swept = [];
    for (const item of dirs) {
      if (!item.isDirectory()) continue;
      const path = join(tunnelDir, item.name, 'lease.json');
      let lease;
      try { lease = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      const alive = processAlive(lease.pid);
      const current = alive ? await processStartIdentity(execFileImpl, lease.pid) : null;
      const same = alive && lease.startIdentity && current && lease.startIdentity === current;
      if (same) {
        try { process.kill(Number(lease.pid), 'SIGTERM'); } catch { /* already gone */ }
        emit(onEvidence, { control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'orphan_closed', connection: lease.connection });
        swept.push({ connection: lease.connection, action: 'closed' });
      } else if (alive && lease.startIdentity && current && lease.startIdentity !== current) {
        emit(onEvidence, { control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'pid_reuse_refused', connection: lease.connection });
        swept.push({ connection: lease.connection, action: 'pid_reuse_left_alone' });
      }
      try { await rm(path, { force: true }); } catch { /* best effort */ }
    }
    return swept;
  }

  async function preflight(connection, { localPort, signal } = {}) {
    const c = validateSshTunnelConfig(connection);
    const port = localPort ?? await allocatePortImpl();
    emit(onEvidence, { control: 'config_validate', checkpoint: 'input_screen', outcome: 'passed', connection: c.name });
    let version;
    try {
      const v = await execFilePromise(execFileImpl, 'ssh', ['-V'], { timeout: 3000, signal });
      version = (v.stderr || v.stdout).trim().split('\n')[0] || null;
    } catch (error) {
      emit(onEvidence, { control: 'ssh_version', checkpoint: 'input_screen', outcome: 'refused', connection: c.name, reason: 'ssh_unavailable' });
      throw new TunnelError('OpenSSH ssh(1) is not available; install a system OpenSSH client', 'preflight');
    }
    const configArgs = buildSshArgv(c, port, { config: true });
    let configOutput;
    try { configOutput = await execFilePromise(execFileImpl, 'ssh', configArgs, { timeout: 10_000, maxBuffer: 128 * 1024, signal }); }
    catch (error) {
      await diagnostics(c.name, error.stderr, { at: now(), event: 'ssh-g-failed' });
      emit(onEvidence, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'refused', connection: c.name, reason: 'ssh_g_failed' });
      throw new TunnelError('OpenSSH configuration evaluation failed; check the Camus SSH alias and its config', 'preflight');
    }
    let effective;
    try { effective = screenSshConfig(configOutput.stdout, { localPort: port, connection: c }); }
    catch (error) {
      await diagnostics(c.name, configOutput.stderr, { at: now(), event: 'directive-refused' });
      emit(onEvidence, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'refused', connection: c.name, reason: error.message });
      throw error;
    }
    emit(onEvidence, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'passed', connection: c.name, trustedProxy: Boolean(effective.proxyCommand || effective.proxyJump) });
    const hostKeys = await advisoryHostKeyLookup({ execFileImpl, effective, port: effective.port });
    emit(onEvidence, { control: 'host_key_advisory', checkpoint: 'input_screen', outcome: hostKeys.found ? 'hit' : 'miss', connection: c.name });
    return { connection: c, localPort: port, version, effective, hostKeys, argv: buildSshArgv(c, port) };
  }

  async function stop(record, reason = 'release') {
    if (record.timer) clearTimeout(record.timer);
    record.stopping = true;
    try { record.child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { record.child.kill('SIGKILL'); } catch {} resolve(); }, 1500);
      if (record.exited) { clearTimeout(timer); resolve(); }
      else record.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    try { await rm(join(ensureDir(record.connection.name), 'lease.json'), { force: true }); } catch {}
    emit(onEvidence, { control: 'teardown', checkpoint: 'action_authorization', outcome: 'released', connection: record.connection.name, reason });
    active.delete(record.key);
  }

  async function acquire(connection, { signal, discoveryPath } = {}) {
    const c = validateSshTunnelConfig(connection);
    const key = connectionFingerprint(c);
    const existing = active.get(key);
    if (existing && !existing.stopping) {
      existing.refs += 1;
      emit(onEvidence, { control: 'ownership', checkpoint: 'action_authorization', outcome: 'shared', connection: c.name, refs: existing.refs });
      return leaseFor(existing);
    }
    const info = await preflight(c, { signal });
    const child = spawnImpl('ssh', info.argv, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    if (!child || typeof child.once !== 'function') throw new TunnelError('OpenSSH did not produce an observable child process', 'tunnel');
    emit(onEvidence, { control: 'forward_only_argv', checkpoint: 'action_authorization', outcome: 'passed', connection: c.name, argvShape: 'hardened-local-forward' });
    const record = {
      key, connection: c, localPort: info.localPort, child, refs: 1, stderr: '', exited: false, stopping: false,
      death: null, timer: null,
    };
    record.death = new Promise((resolve, reject) => { record.rejectDeath = reject; record.resolveDeath = resolve; });
    child.stderr?.on?.('data', (chunk) => {
      record.stderr = `${record.stderr}${chunk}`.slice(-64 * 1024);
    });
    child.once('error', async (error) => {
      record.exited = true;
      record.resolveDeath(new TunnelError(`managed SSH tunnel failed to start (${error.code || 'spawn'})`, 'tunnel'));
    });
    child.once('exit', async (code, signalName) => {
      record.exited = true;
      const death = new TunnelError(`managed SSH tunnel exited (${code ?? signalName ?? 'unknown'})`, 'tunnel');
      record.resolveDeath(death);
      if (!record.stopping) {
        try { await diagnostics(c.name, record.stderr, { at: now(), event: 'unexpected-exit', code, signal: signalName }); } catch { /* bounded diagnostics are best effort */ }
        emit(onEvidence, { control: 'tunnel_death', checkpoint: 'output_screen', outcome: 'infrastructure_failed', connection: c.name, reason: 'tunnel_death' });
      }
    });
    const startIdentity = await processStartIdentity(execFileImpl, child.pid);
    const dir = ensureDir(c.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(dir, 'lease.json'), {
      schemaVersion: 1, pid: child.pid, startIdentity, localPort: record.localPort,
      connection: c.name, connectionFingerprint: key, ownerPid: process.pid, createdAt: now(),
    });
    emit(onEvidence, { control: 'authoritative_spawn', checkpoint: 'action_authorization', outcome: 'spawned', connection: c.name });
    active.set(key, record);
    emit(onEvidence, { control: 'ownership', checkpoint: 'action_authorization', outcome: 'leased', connection: c.name, refs: 1 });
    try {
      const path = discoveryPath || `${c.basePath}/models`.replace('//', '/');
      if (await nonLoopbackForwardReachable(record.localPort)) {
        throw new TunnelError('managed SSH forward is reachable on a non-loopback local address; refusing the tunnel', 'preflight');
      }
      const response = await fetchImpl(`http://127.0.0.1:${record.localPort}${path}`, { signal });
      if (!response) throw new Error('empty application response');
      emit(onEvidence, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'passed', connection: c.name });
    } catch (error) {
      if (record.exited) throw new TunnelError('managed SSH tunnel died before application liveness completed; no direct fallback is permitted', 'tunnel');
      try { await diagnostics(c.name, record.stderr, { at: now(), event: 'application-liveness-failed' }); } catch { /* best effort */ }
      await stop(record, 'application_liveness_failed');
      emit(onEvidence, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'inconclusive', connection: c.name });
      throw new TunnelError(`forwarded inference service did not answer ${c.basePath}/models`, 'tunnel');
    }
    return leaseFor(record);
  }

  function leaseFor(record) {
    return {
      connection: record.connection.name,
      connectionDetails: { ...record.connection },
      localPort: record.localPort,
      url: `http://127.0.0.1:${record.localPort}${record.connection.basePath}`,
      death: record.death,
      release: async () => {
        if (record.refs > 0) record.refs -= 1;
        if (record.refs > 0) return;
        record.timer = setTimeout(() => { stop(record).catch(() => {}); }, lingerMs);
      },
    };
  }

  async function close() {
    await Promise.all([...active.values()].map((record) => stop(record, 'manager_close')));
  }

  // Startup sweep is best-effort and intentionally does not block module
  // loading. Doctor also calls the same operation explicitly so its report can
  // name an orphan it closed.
  sweepOrphans().catch(() => {});
  return Object.freeze({ acquire, preflight, sweepOrphans, close, active });
}

let shared;
export function getSharedTunnelManager(options = {}) {
  if (!shared) shared = createTunnelManager(options);
  return shared;
}
export function resetSharedTunnelManager() {
  const current = shared;
  shared = null;
  return current?.close?.();
}
