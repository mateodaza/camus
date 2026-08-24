// Managed OpenSSH local-forward transport (RFC §8).
//
// This module is deliberately transport-only. It owns an ssh -N -T child and
// exposes a short-lived local URL; it never accepts a command, copies files,
// or hands an SSH argv through from a caller. The manager is process-local and
// reference counted so doctor, qualification, and runtime all share one owner.
// CAMUS_CONTROL: slice-d.config_validate
// CAMUS_CONTROL: slice-d.host_key_advisory
// CAMUS_CONTROL: slice-d.directive_screen
// CAMUS_CONTROL: slice-d.forward_only_argv
// CAMUS_CONTROL: slice-d.ownership
// CAMUS_CONTROL: slice-d.application_liveness
// CAMUS_CONTROL: slice-d.output_integrity

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, rename, open, appendFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { controlEvent, evaluateAction, humanDecision } from '../../../packages/cli/skills/camus/control-plane.mjs';

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

function tunnelControlAction(connection, identity) {
  return {
    schema_version: 1,
    action_class: 'studio.ssh.forward',
    target: { class: 'ssh_connection', id: `${connection.name}:${identity}` },
    impact: 'high',
    reversibility: 'bounded_rollback',
    external_side_effect: 'remote_access',
    data_sensitivity: 'internal',
    destination_trust: 'known',
    operator_policy: 'ask',
  };
}

function requireControlRoute(action, evidence, authorization, checkpoints) {
  const route = evaluateAction({ action, evidence, authorization, checkpoints });
  if (route.decision !== 'auto') {
    throw new TunnelError(`managed SSH control plane ${route.decision}: ${route.rule_ids.join(', ')}`, 'control_plane');
  }
  return route;
}

export const TUNNEL_CONTRACT_VERSION = 'ssh-tunnel-1';

export class TunnelError extends Error {
  constructor(message, code = 'tunnel', { failureClass = null, fix = null } = {}) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
    this.failureClass = failureClass;
    this.fix = fix;
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
  const endpoint = (token) => {
    const value = token.replace(/[\[\]]/g, '');
    const split = value.lastIndexOf(':');
    if (split <= 0) return null;
    return { host: value.slice(0, split).toLowerCase(), port: Number(value.slice(split + 1)) };
  };
  const expectedLocal = { host: '127.0.0.1', port: localPort };
  const expectedRemote = { host: String(connection.remoteAddress).toLowerCase(), port: connection.remotePort };
  const extraLocal = local.filter((line) => {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) return true;
    const bind = endpoint(tokens[0]);
    const destination = endpoint(tokens[1]);
    return !bind || !destination
      || bind.host !== expectedLocal.host || bind.port !== expectedLocal.port
      || destination.host !== expectedRemote.host || destination.port !== expectedRemote.port;
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
      if (result.stdout.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#'))) {
        return { found: true, files, host, file };
      }
    } catch { /* advisory only */ }
  }
  return { found: false, files, host };
}

export function redactSshDiagnostics(stderr, { maxBytes = 64 * 1024 } = {}) {
  const classify = (line) => classifySshFailure(line).failureClass;
  const lines = text(stderr).slice(-maxBytes).split(/\r?\n/).filter(Boolean).map(classify);
  return lines.join('\n').slice(-maxBytes);
}

// SSH output is untrusted operator input. It can select only one of these
// fixed, redacted presentation classes; it never controls retry or spawning.
export function classifySshFailure(stderr) {
  const value = text(stderr);
  if (/remote host identification has changed|offending .*key|man-in-the-middle/i.test(value)) {
    return { failureClass: 'host_key_changed', fix: 'review the Camus SSH alias host key and remove only the stale entry you recognize' };
  }
  if (/could not resolve hostname|name or service not known|host key verification failed|known_hosts|no matching host key/i.test(value)) {
    return { failureClass: 'unknown_host_key', fix: 'run the named SSH alias interactively, verify its host, and confirm host trust' };
  }
  if (/permission denied|authentication failed|too many authentication failures|passphrase|password/i.test(value)) {
    return { failureClass: 'authentication_refused', fix: 'run the named SSH alias interactively and repair its BatchMode credential setup' };
  }
  if (/address already in use|bind .*failed|forwarding request failed|connect failed.*forward/i.test(value)) {
    return { failureClass: 'forward_bind_failed', fix: 'retry with a fresh local port; keep the SSH alias dedicated to Camus' };
  }
  if (/connection timed out|operation timed out|connection refused/i.test(value)) {
    return { failureClass: 'peer_unreachable', fix: 'verify the named SSH alias and that its remote inference service is listening' };
  }
  if (/warning|error|fatal|refused|failed/i.test(value)) {
    return { failureClass: 'ssh_failure', fix: 'run the named SSH alias interactively and review its fixed SSH configuration' };
  }
  return { failureClass: 'ssh_diagnostic', fix: 'run the named SSH alias interactively and review its fixed SSH configuration' };
}

function classifiedTunnelError(connectionName, stderr, code = 'tunnel', override = null) {
  const { failureClass, fix } = override || classifySshFailure(stderr);
  return new TunnelError(`managed SSH tunnel for connection "${connectionName}" failed (${failureClass})`, code, { failureClass, fix });
}

function defaultTunnelDir() { return process.env.STUDIO_TUNNEL_DIR || join(homedir(), '.camus', 'studio', 'tunnels'); }
function safeName(name) { return String(name || 'connection').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }
function joinRuntimePath(basePath, suffix) {
  return `${String(basePath || '/').replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`.replace(/^$/, '/');
}

async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  try { const handle = await open(temp, 'r'); await handle.sync(); await handle.close(); } catch { /* best effort on platforms without fsync */ }
  await rename(temp, path);
  await chmod(path, 0o600);
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

function localPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
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

function defaultProcessAlive(pid) {
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
  processOps = {},
  nonLoopbackProbe = nonLoopbackForwardReachable,
  portOccupancyProbe = localPortOccupied,
  livenessTimeoutMs = 5000,
} = {}) {
  const active = new Map();
  const inflight = new Map();
  const evidenceSubscribers = new Set();
  const processAlive = processOps.alive || defaultProcessAlive;
  const processKill = processOps.kill || ((pid, signal) => process.kill(Number(pid), signal));
  const processWait = processOps.wait || (async (pid, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && await processAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 25));
  });
  const startupSweep = { promise: null };
  let closing = false;
  let closePromise = null;
  const ensureDir = (name) => join(tunnelDir, safeName(name));
  const emitEvidence = (fact) => {
    emit(onEvidence, fact);
    for (const subscriber of evidenceSubscribers) emit(subscriber, fact);
  };
  // A connection name is presentation, not identity. Every operation-scoped
  // fact carries the immutable destination fingerprint so a concurrent run
  // cannot accept evidence from a same-named connection that points elsewhere.
  const emitConnectionEvidence = (connection, fact) => emitEvidence({
    ...fact,
    connection: connection.name,
    connectionFingerprint: connectionFingerprint(connection),
  });
  if (process.env.STUDIO_TUNNEL_DEBUG === '1') {
    console.warn(`Camus: raw SSH diagnostics are enabled; debug files may contain hostnames and usernames under ${tunnelDir}.`);
  }

  async function diagnostics(name, stderr, event) {
    const dir = ensureDir(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, 'diagnostics.log');
    const redacted = redactSshDiagnostics(stderr);
    await appendFile(path, `${redacted ? `${redacted}\n` : ''}${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    if (process.env.STUDIO_TUNNEL_DEBUG === '1' && stderr) {
      await writeFile(join(dir, 'diagnostics.raw.log'), `${text(stderr).slice(-64 * 1024)}\n`, { mode: 0o600 });
      await chmod(join(dir, 'diagnostics.raw.log'), 0o600);
      emitEvidence({ control: 'diagnostics', checkpoint: 'output_screen', outcome: 'raw_debug_enabled', connection: name });
    }
    return path;
  }
  async function lifecycleEvent(name, event) {
    const dir = ensureDir(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, 'events.jsonl');
    await appendFile(path, `${JSON.stringify({ at: now(), connection: name, ...event })}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async function sweepOrphans() {
    try { await mkdir(tunnelDir, { recursive: true, mode: 0o700 }); await chmod(tunnelDir, 0o700); } catch { /* a later acquire reports the usable failure */ }
    let dirs = [];
    try { dirs = await readdir(tunnelDir, { withFileTypes: true }); } catch { return []; }
    const swept = [];
    for (const item of dirs) {
      if (!item.isDirectory()) continue;
      const path = join(tunnelDir, item.name, 'lease.json');
      let lease;
      try { lease = JSON.parse(await readFile(path, 'utf8')); } catch { lease = null; }
      if (!lease || lease.schemaVersion !== 1 || !Number.isInteger(lease.pid) || typeof lease.startIdentity !== 'string' || !lease.startIdentity) {
        const connection = lease?.connection ?? item.name;
        await lifecycleEvent(connection, { event: 'lease_sweep', outcome: 'inconclusive', reason: 'corrupt_lease' });
        emitEvidence({ control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'inconclusive', connection, reason: 'corrupt_lease' });
        swept.push({ connection, action: 'corrupt_inconclusive' });
        try { await rm(path, { force: true }); } catch { /* leave evidence in control report */ }
        continue;
      }
      const alive = await processAlive(lease.pid);
      const current = alive ? await processStartIdentity(execFileImpl, lease.pid) : null;
      const same = alive && lease.startIdentity && current && lease.startIdentity === current;
      if (same) {
        const managed = [...active.values()].find((record) => !record.stopping
          && record.child.pid === lease.pid
          && record.startIdentity === lease.startIdentity
          && record.key === lease.connectionFingerprint);
        if (managed) {
          await lifecycleEvent(lease.connection, { event: 'lease_sweep', outcome: 'active_managed' });
          emitEvidence({ control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'active_managed', connection: lease.connection });
          swept.push({ connection: lease.connection, action: 'active_managed' });
          continue;
        }
        try { await processKill(lease.pid, 'SIGTERM'); await processWait(lease.pid, 1500); } catch { /* already gone */ }
        if (await processAlive(lease.pid)) {
          try { await processKill(lease.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        await lifecycleEvent(lease.connection, { event: 'lease_sweep', outcome: 'orphan_closed' });
        emitEvidence({ control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'orphan_closed', connection: lease.connection });
        swept.push({ connection: lease.connection, action: 'closed' });
      } else if (alive && lease.startIdentity && current && lease.startIdentity !== current) {
        await lifecycleEvent(lease.connection, { event: 'lease_sweep', outcome: 'pid_reuse_refused' });
        emitEvidence({ control: 'lease_sweep', checkpoint: 'action_authorization', outcome: 'pid_reuse_refused', connection: lease.connection });
        swept.push({ connection: lease.connection, action: 'pid_reuse_left_alone' });
      }
      try { await rm(path, { force: true }); } catch { /* best effort */ }
    }
    return swept;
  }

  async function preflight(connection, { localPort, signal } = {}) {
    const c = validateSshTunnelConfig(connection);
    const port = localPort ?? await allocatePortImpl();
    emitConnectionEvidence(c, { control: 'config_validate', checkpoint: 'input_screen', outcome: 'passed' });
    let version;
    try {
      const v = await execFilePromise(execFileImpl, 'ssh', ['-V'], { timeout: 3000, signal });
      version = (v.stderr || v.stdout).trim().split('\n')[0] || null;
    } catch (error) {
      emitConnectionEvidence(c, { control: 'ssh_version', checkpoint: 'input_screen', outcome: 'refused', reason: 'ssh_unavailable' });
      throw new TunnelError('OpenSSH ssh(1) is not available; install a system OpenSSH client', 'preflight');
    }
    const configArgs = buildSshArgv(c, port, { config: true });
    let configOutput;
    try { configOutput = await execFilePromise(execFileImpl, 'ssh', configArgs, { timeout: 10_000, maxBuffer: 128 * 1024, signal }); }
    catch (error) {
      await diagnostics(c.name, error.stderr, { at: now(), event: 'ssh-g-failed' });
      emitConnectionEvidence(c, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'refused', reason: 'ssh_g_failed' });
      throw new TunnelError('OpenSSH configuration evaluation failed; check the Camus SSH alias and its config', 'preflight');
    }
    let effective;
    try { effective = screenSshConfig(configOutput.stdout, { localPort: port, connection: c }); }
    catch (error) {
      await diagnostics(c.name, configOutput.stderr, { at: now(), event: 'directive-refused' });
      emitConnectionEvidence(c, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'refused', reason: 'configuration directive refused' });
      throw error;
    }
    emitConnectionEvidence(c, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'passed', trustedProxy: Boolean(effective.proxyCommand || effective.proxyJump) });
    const hostKeys = await advisoryHostKeyLookup({ execFileImpl, effective, port: effective.port });
    emitConnectionEvidence(c, { control: 'host_key_advisory', checkpoint: 'input_screen', outcome: hostKeys.found ? 'hit' : 'miss' });
    return { connection: c, localPort: port, version, effective, hostKeys, argv: buildSshArgv(c, port),
      steps: [
        { number: 1, id: 'ssh_version', outcome: 'passed', detail: 'OpenSSH available' },
        { number: 2, id: 'config_evaluation', outcome: 'passed', detail: 'effective configuration screened' },
        { number: 3, id: 'directive_screen', outcome: 'passed', detail: 'forward-only configuration' },
        { number: 4, id: 'host_key_advisory', outcome: hostKeys.found ? 'hit' : 'miss', detail: hostKeys.found ? 'known host entry found' : 'advisory miss; handshake remains authoritative' },
      ] };
  }

  async function stop(record, reason = 'release') {
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      if (record.timer) clearTimeout(record.timer);
      record.timer = null;
      record.stopping = true;
      try { record.child.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          try { record.child.kill('SIGKILL'); } catch { /* already gone */ }
          // The wait is bounded even for a fake or broken child that never
          // emits exit after SIGKILL; lease cleanup must not hang shutdown.
          setTimeout(finish, 50);
        }, 1500);
        if (record.exited) finish();
        else record.child.once('exit', finish);
      });
      try { await rm(join(ensureDir(record.connection.name), 'lease.json'), { force: true }); } catch {}
      emitConnectionEvidence(record.connection, { control: 'teardown', checkpoint: 'action_authorization', outcome: 'released', reason });
      try { await lifecycleEvent(record.connection.name, { event: 'teardown', reason }); } catch { /* evidence is best effort */ }
      if (active.get(record.key) === record) active.delete(record.key);
    })();
    return record.stopPromise;
  }

  async function cleanupFailedRecord(record) {
    await stop(record, 'acquire_failed');
  }

  async function proveApplicationLiveness(record, connection, { signal, discoveryPath } = {}) {
    if (signal?.aborted) throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
    if (await nonLoopbackProbe(record.localPort)) {
      throw new TunnelError('managed SSH forward is reachable on a non-loopback local address; refusing the tunnel', 'preflight');
    }
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let timeoutId;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      if (signal?.aborted) onCallerAbort();
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new TunnelError('forwarded /models request timed out', 'liveness_timeout'));
        }, livenessTimeoutMs);
      });
      const path = discoveryPath || joinRuntimePath(connection.basePath, 'models');
      const body = await Promise.race([(async () => {
        let response;
        try {
          response = await fetchImpl(`http://127.0.0.1:${record.localPort}${path}`, { signal: controller.signal });
        } catch (error) {
          if (callerAborted) throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
          if (timedOut) throw new TunnelError('forwarded /models request timed out', 'liveness_timeout');
          throw error;
        }
        if (!response || !response.ok || typeof response.json !== 'function') {
          throw new TunnelError('forwarded /models response was not a successful JSON response', 'liveness');
        }
        return response.json();
      })(), timeout]);
      if (!body || !Array.isArray(body.data)) {
        throw new TunnelError('forwarded /models response was not a parseable model list', 'liveness');
      }
      if (callerAborted) throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
      const currentStartIdentity = await processStartIdentity(execFileImpl, record.child.pid);
      if (record.exited || record.unusable || !(await processAlive(record.child.pid))
        || !currentStartIdentity || currentStartIdentity !== record.startIdentity) {
        throw new TunnelError('managed SSH tunnel exited or changed identity during application liveness; no direct fallback is permitted', 'tunnel');
      }
      return { path };
    } catch (error) {
      if (callerAborted || signal?.aborted) {
        throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  function emitCompleteLeaseEvidence(connection, { ownership, refs }) {
    emitConnectionEvidence(connection, { control: 'config_validate', checkpoint: 'input_screen', outcome: 'passed', reason: 'connection_schema_validated' });
    emitConnectionEvidence(connection, { control: 'host_key_advisory', checkpoint: 'input_screen', outcome: 'passed', reason: 'strict_handshake_succeeded' });
    emitConnectionEvidence(connection, { control: 'directive_screen', checkpoint: 'action_authorization', outcome: 'passed', reason: 'effective_ssh_configuration_screened' });
    emitConnectionEvidence(connection, { control: 'forward_only_argv', checkpoint: 'action_authorization', outcome: 'passed', reason: 'hardened_local_forward_argv', argvShape: 'hardened-local-forward' });
    emitConnectionEvidence(connection, { control: 'ownership', checkpoint: 'action_authorization', outcome: ownership, reason: 'manager_owns_spawn_and_teardown_contract', refs });
    emitConnectionEvidence(connection, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'passed', reason: 'forwarded_models_endpoint_answered' });
    emitConnectionEvidence(connection, { control: 'output_integrity', checkpoint: 'output_screen', outcome: 'passed', reason: 'live_forward_no_fallback' });
  }

  async function startAcquire(connection, { signal, discoveryPath, localPort } = {}) {
    const c = validateSshTunnelConfig(connection);
    const identity = connectionFingerprint(c);
    const key = `${c.name || ''}:${identity}`;
    const existing = active.get(key);
    if (existing && !existing.stopping) {
      const currentStartIdentity = existing.child?.pid
        ? await processStartIdentity(execFileImpl, existing.child.pid) : null;
      const reusable = existing.control && !existing.exited && !existing.unusable
        && await processAlive(existing.child?.pid)
        && currentStartIdentity === existing.startIdentity;
      if (!reusable) {
        existing.unusable = true;
        await stop(existing, 'stale_before_share');
      } else {
        // Reserve one reference while the fresh borrower proves the shared
        // process. This prevents a zero-ref linger timer from tearing it down
        // mid-probe, but the reservation is rolled back on every failure.
        if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
        existing.refs += 1;
        try {
          await proveApplicationLiveness(existing, c, { signal, discoveryPath });
          requireControlRoute(
            existing.control.action,
            existing.control.evidence,
            existing.control.authorization,
            ['input_screen', 'action_authorization', 'output_screen'],
          );
          emitCompleteLeaseEvidence(c, { ownership: 'shared', refs: existing.refs });
          try { await lifecycleEvent(c.name, { event: 'application_liveness', outcome: 'passed', shared: true }); } catch { /* evidence is best effort */ }
          return leaseFor(existing);
        } catch (error) {
          existing.refs = Math.max(0, existing.refs - 1);
          if (error?.code === 'aborted') {
            if (existing.refs === 0 && !existing.stopping) {
              existing.timer = setTimeout(() => { stop(existing).catch(() => {}); }, lingerMs);
            }
            throw error;
          }
          existing.unusable = true;
          emitConnectionEvidence(c, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'inconclusive', reason: 'shared_lease_revalidation_failed' });
          emitConnectionEvidence(c, { control: 'output_integrity', checkpoint: 'output_screen', outcome: 'infrastructure_failed', reason: 'shared_lease_revalidation_failed' });
          try { await diagnostics(c.name, existing.stderr, { at: now(), event: 'shared-application-liveness-failed' }); } catch { /* best effort */ }
          await stop(existing, 'shared_revalidation_failed');
          if (error instanceof TunnelError && error.code === 'preflight') throw error;
          throw new TunnelError(`forwarded inference service did not answer ${joinRuntimePath(c.basePath, 'models')}`, 'tunnel');
        }
      }
    }
    const info = await preflight(c, { signal, localPort });
    const controlAction = tunnelControlAction(c, identity);
    const controlAuthorization = humanDecision(controlAction, {
      decision: 'approve',
      reason: 'Operator configured this exact named SSH connection for managed forwarding.',
    });
    const controlEvidence = [
      controlEvent({
        controlId: 'slice-d.directive_screen', action: controlAction, outcome: 'passed',
        reasonCode: 'effective_ssh_configuration_screened', details: { connection: c.name },
      }),
      controlEvent({
        controlId: 'slice-d.forward_only_argv', action: controlAction, outcome: 'passed',
        reasonCode: 'hardened_local_forward_argv', details: { connection: c.name, argvShape: 'hardened-local-forward' },
      }),
      controlEvent({
        controlId: 'slice-d.ownership', action: controlAction, outcome: 'passed',
        reasonCode: 'manager_owns_spawn_and_teardown_contract', details: { connection: c.name },
      }),
    ];
    // Authorization is checked before OpenSSH is spawned. The later full check
    // includes application liveness and output integrity before a lease is
    // returned to any model adapter.
    requireControlRoute(controlAction, controlEvidence, controlAuthorization, ['action_authorization']);
    const child = spawnImpl('ssh', info.argv, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    if (!child || typeof child.once !== 'function') throw new TunnelError('OpenSSH did not produce an observable child process', 'tunnel');
    emitConnectionEvidence(c, { control: 'forward_only_argv', checkpoint: 'action_authorization', outcome: 'passed', argvShape: 'hardened-local-forward' });
    const record = {
      key, connection: c, localPort: info.localPort, child, refs: 1, stderr: '', exited: false, stopping: false,
      death: null, timer: null, startIdentity: null,
    };
    record.death = new Promise((resolve, reject) => { record.rejectDeath = reject; record.resolveDeath = resolve; });
    child.stderr?.on?.('data', (chunk) => {
      record.stderr = `${record.stderr}${chunk}`.slice(-64 * 1024);
    });
    child.once('error', async (error) => {
      record.exited = true;
      record.unusable = true;
      if (active.get(record.key) === record) active.delete(record.key);
      record.resolveDeath(classifiedTunnelError(c.name, error?.stderr, 'tunnel'));
    });
    child.once('exit', async (code, signalName) => {
      record.exited = true;
      record.unusable = true;
      if (active.get(record.key) === record) active.delete(record.key);
      const death = classifiedTunnelError(c.name, record.stderr, 'tunnel');
      record.resolveDeath(death);
      if (!record.stopping) {
        try { await diagnostics(c.name, record.stderr, { at: now(), event: 'unexpected-exit', code, signal: signalName }); } catch { /* bounded diagnostics are best effort */ }
        emitConnectionEvidence(c, { control: 'tunnel_death', checkpoint: 'output_screen', outcome: 'infrastructure_failed', reason: 'tunnel_death' });
        emitConnectionEvidence(c, { control: 'output_integrity', checkpoint: 'output_screen', outcome: 'infrastructure_failed', reason: 'tunnel_death_no_fallback' });
      }
    });
    const startIdentity = await processStartIdentity(execFileImpl, child.pid);
    if (!child.pid || !startIdentity || !(await processAlive(child.pid))) {
      await cleanupFailedRecord(record);
      throw new TunnelError(`managed SSH tunnel for connection "${c.name}" has no usable PID/start identity`, 'tunnel');
    }
    record.startIdentity = startIdentity;
    const dir = ensureDir(c.name);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeJsonAtomic(join(dir, 'lease.json'), {
        schemaVersion: 1, pid: child.pid, startIdentity, localPort: record.localPort,
        connection: c.name, connectionFingerprint: key, ownerPid: process.pid, createdAt: now(),
      });
    } catch (error) {
      await cleanupFailedRecord(record);
      throw error;
    }
    emitConnectionEvidence(c, { control: 'authoritative_spawn', checkpoint: 'action_authorization', outcome: 'spawned' });
    active.set(key, record);
    try { await lifecycleEvent(c.name, { event: 'lease_open' }); } catch { /* evidence is best effort */ }
    try {
      if (!(await processAlive(child.pid))) { record.exited = true; record.unusable = true; }
    } catch (error) {
      await cleanupFailedRecord(record);
      throw error;
    }
    if (record.exited || record.unusable) {
      const occupied = await portOccupancyProbe(record.localPort);
      await cleanupFailedRecord(record);
      if (occupied) throw classifiedTunnelError(c.name, record.stderr, 'bind_collision', { failureClass: 'forward_bind_failed', fix: 'retry with a fresh local port; keep the SSH alias dedicated to Camus' });
      throw classifiedTunnelError(c.name, record.stderr, 'tunnel');
    }
    emitConnectionEvidence(c, { control: 'ownership', checkpoint: 'action_authorization', outcome: 'leased', refs: 1 });
    try {
      await proveApplicationLiveness(record, c, { signal, discoveryPath });
      emitConnectionEvidence(c, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'passed' });
      // ssh was launched with StrictHostKeyChecking=yes. A successful
      // authoritative handshake is stronger than the earlier advisory lookup,
      // which may miss a configured alternate known-hosts file.
      emitConnectionEvidence(c, { control: 'host_key_advisory', checkpoint: 'input_screen', outcome: 'passed', reason: 'strict_handshake_succeeded' });
      try { await lifecycleEvent(c.name, { event: 'application_liveness', outcome: 'passed' }); } catch { /* evidence is best effort */ }
    } catch (error) {
      if (record.exited) {
        const occupied = await portOccupancyProbe(record.localPort);
        await cleanupFailedRecord(record);
        if (occupied) throw classifiedTunnelError(c.name, record.stderr, 'bind_collision', { failureClass: 'forward_bind_failed', fix: 'retry with a fresh local port; keep the SSH alias dedicated to Camus' });
        throw classifiedTunnelError(c.name, record.stderr, 'tunnel');
      }
      try { await diagnostics(c.name, record.stderr, { at: now(), event: 'application-liveness-failed' }); } catch { /* best effort */ }
      await cleanupFailedRecord(record);
      emitConnectionEvidence(c, { control: 'application_liveness', checkpoint: 'input_screen', outcome: 'inconclusive' });
      if (error instanceof TunnelError && error.code === 'aborted') throw error;
      if (error instanceof TunnelError && error.code === 'preflight') throw error;
      throw new TunnelError(`forwarded inference service did not answer ${joinRuntimePath(c.basePath, 'models')}`, 'tunnel');
    }
    controlEvidence.push(
      controlEvent({
        controlId: 'slice-d.config_validate', action: controlAction, outcome: 'passed',
        reasonCode: 'connection_schema_validated', details: { connection: c.name },
      }),
      controlEvent({
        controlId: 'slice-d.host_key_advisory', action: controlAction, outcome: 'passed',
        reasonCode: 'strict_handshake_succeeded', details: { connection: c.name },
      }),
      controlEvent({
        controlId: 'slice-d.application_liveness', action: controlAction, outcome: 'passed',
        reasonCode: 'forwarded_models_endpoint_answered', details: { connection: c.name },
      }),
      controlEvent({
        controlId: 'slice-d.output_integrity', action: controlAction, outcome: 'passed',
        reasonCode: 'live_forward_no_fallback', details: { connection: c.name },
      }),
    );
    try {
      requireControlRoute(controlAction, controlEvidence, controlAuthorization, ['input_screen', 'action_authorization', 'output_screen']);
    } catch (error) {
      await cleanupFailedRecord(record);
      throw error;
    }
    record.control = Object.freeze({
      action: controlAction,
      authorization: controlAuthorization,
      evidence: Object.freeze([...controlEvidence]),
    });
    emitConnectionEvidence(c, { control: 'output_integrity', checkpoint: 'output_screen', outcome: 'passed', reason: 'live_forward_no_fallback' });
    const steps = [...info.steps, { number: 5, id: 'authoritative_spawn', outcome: 'passed', detail: 'hardened foreground child' }, { number: 6, id: 'loopback_liveness', outcome: 'passed', detail: 'loopback-only listener and application response' }];
    return leaseFor(record, steps);
  }

  async function acquire(connection, options = {}) {
    if (closing) throw new TunnelError('managed SSH tunnel manager is closing', 'closed');
    if (!startupSweep.promise) startupSweep.promise = sweepOrphans();
    await startupSweep.promise;
    if (closing) throw new TunnelError('managed SSH tunnel manager is closing', 'closed');
    const c = validateSshTunnelConfig(connection);
    const key = `${c.name || ''}:${connectionFingerprint(c)}`;
    const pending = inflight.get(key);
    if (pending) {
      if (options.signal?.aborted) throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
      await new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => { if (done) return; done = true; options.signal?.removeEventListener('abort', onAbort); fn(value); };
        const onAbort = () => finish(reject, new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        pending.then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
      if (closing) throw new TunnelError('managed SSH tunnel manager is closing', 'closed');
      if (options.signal?.aborted) throw new TunnelError('managed SSH tunnel acquisition was aborted', 'aborted');
      return startAcquire(c, options);
    }
    const operation = (async () => {
      let last;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await startAcquire(c, options); }
        catch (error) {
          last = error;
          if (error?.code !== 'bind_collision' || attempt !== 0) throw error;
        }
      }
      throw last;
    })();
    inflight.set(key, operation);
    try { return await operation; }
    finally { if (inflight.get(key) === operation) inflight.delete(key); }
  }

  function leaseFor(record, steps = []) {
    let released = false;
    return {
      connection: record.connection.name,
      connectionDetails: { ...record.connection },
      localPort: record.localPort,
      url: `http://127.0.0.1:${record.localPort}${record.connection.basePath === '/' ? '' : record.connection.basePath}`,
      death: record.death,
      steps,
      release: async () => {
        if (released) return;
        released = true;
        if (record.timer) { clearTimeout(record.timer); record.timer = null; }
        if (record.refs > 0) record.refs -= 1;
        if (record.refs > 0) return;
        record.timer = setTimeout(() => { stop(record).catch(() => {}); }, lingerMs);
      },
    };
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      while (inflight.size) {
        await Promise.allSettled([...inflight.values()]);
        await Promise.all([...active.values()].map((record) => stop(record, 'manager_close')));
      }
      await Promise.all([...active.values()].map((record) => stop(record, 'manager_close')));
    })();
    return closePromise;
  }

  async function startup({ force = false } = {}) {
    if (force || !startupSweep.promise) startupSweep.promise = sweepOrphans();
    return startupSweep.promise;
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('evidence subscriber must be a function');
    evidenceSubscribers.add(callback);
    return () => evidenceSubscribers.delete(callback);
  }

  // Every first acquire waits for the complete sweep. Reusable-library imports
  // install no process handlers and cannot race orphan cleanup.
  return Object.freeze({ acquire, preflight, sweepOrphans, startup, subscribe, close, active, inflight });
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
