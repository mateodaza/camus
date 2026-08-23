import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenSshConfig, buildSshArgv, connectionFingerprint, createTunnelManager, redactSshDiagnostics, validateSshTunnelConfig } from './ssh-tunnel.mjs';

const connection = { name: 'gpu_lab', kind: 'ssh_tunnel', sshHostAlias: 'camus-gpu', remoteAddress: '127.0.0.1', remotePort: 11434, basePath: '/v1' };
const fakeConfig = (port) => `hostname camus-gpu\ncontrolmaster false\nclearallforwardings no\nforwardx11 no\npermitlocalcommand no\ntunnel false\nlocalforward [127.0.0.1]:${port} [127.0.0.1]:11434\nforwardagent no\nuserknownhostsfile /tmp/known_hosts\nglobalknownhostsfile none`;
const portFrom = (args) => Number(args.find((arg) => arg.startsWith('127.0.0.1:') && arg.includes(':11434'))?.split(':')[1]);
const temp = mkdtempSync(join(tmpdir(), 'camus-ssh-tunnel-'));

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; if (process.env.VERBOSE) console.log(`  ok - ${name}`); };

await test('strict alias, remote loopback, and port validation', () => {
  assert.throws(() => validateSshTunnelConfig({ ...connection, sshHostAlias: '-oProxyCommand=x' }), /sshHostAlias/);
  assert.throws(() => validateSshTunnelConfig({ ...connection, remoteAddress: '10.0.0.2' }), /pivot/);
  assert.throws(() => validateSshTunnelConfig({ ...connection, remotePort: 0 }), /remotePort/);
  assert.throws(() => validateSshTunnelConfig({ ...connection, command: 'uname' }), /unsupported field/);
});

await test('argv is an array, forward-only, and contains no remote command/copy flags', () => {
  const argv = buildSshArgv(connection, 40123);
  assert.deepEqual(argv.at(-2), '--');
  assert.equal(argv.at(-1), 'camus-gpu');
  assert.equal(argv.includes('-N'), true);
  assert.equal(argv.includes('-T'), true);
  assert.equal(argv.includes('-f'), false);
  assert.equal(argv.includes('-R'), false);
  assert.equal(argv.includes('-D'), false);
  assert.equal(argv.includes('scp'), false);
});

await test('-G directive screen refuses extra forwards and execution surfaces', () => {
  assert.doesNotThrow(() => screenSshConfig(fakeConfig(40123), { localPort: 40123, connection }));
  assert.throws(() => screenSshConfig(`${fakeConfig(40123)}\nremoteforward 9000 127.0.0.1:9000`, { localPort: 40123, connection }), /RemoteForward/);
  assert.throws(() => screenSshConfig(`${fakeConfig(40123)}\npermitlocalcommand yes`, { localPort: 40123, connection }), /PermitLocalCommand/);
  assert.throws(() => screenSshConfig(`${fakeConfig(40123)}\nlocalforward 127.0.0.1:5000 127.0.0.1:5000`, { localPort: 40123, connection }), /additional LocalForward/);
});

await test('diagnostics redact users, hosts, IPs, paths, and credentials with a bound', () => {
  const out = redactSshDiagnostics('alice@private.example 10.2.3.4 /Users/alice/.ssh/id_ed25519 Bearer sk-secret-123456789\n'.repeat(300));
  assert.ok(out.length <= 64 * 1024);
  assert.equal(out.includes('alice@private.example'), false);
  assert.equal(out.includes('10.2.3.4'), false);
  assert.equal(out.includes('sk-secret-123456789'), false);
});

function fakeHarness({ onSpawn, psOutput = '' } = {}) {
  let starts = 0;
  const children = [];
  const execFileImpl = (file, args, opts, cb) => {
    if (file === 'ssh-keygen') return cb(new Error('not in fixture'), '', '');
    if (file === 'ps') return cb(null, psOutput, '');
    if (args[0] === '-V') return cb(null, '', 'OpenSSH_10.5');
    const port = portFrom(args);
    cb(null, fakeConfig(port), '');
  };
  const spawnImpl = (file, args, opts) => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 5000 + starts;
    child.stderr = new EventEmitter();
    child.kill = (signal) => { onSpawn?.(child, signal); child.emit('exit', signal === 'SIGKILL' ? null : 0, signal === 'SIGKILL' ? 'SIGKILL' : null); };
    children.push(child);
    return child;
  };
  return { execFileImpl, spawnImpl, children, get starts() { return starts; } };
}

await test('preflight and lifecycle share one child, refcount release tears down, and lease excludes port fingerprint', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, allocatePortImpl: async () => 40123, fetchImpl: async () => ({ ok: true }), tunnelDir: temp, lingerMs: 1 });
  const a = await manager.acquire(connection);
  const b = await manager.acquire(connection);
  assert.equal(h.starts, 1);
  assert.equal(a.url, b.url);
  assert.equal(connectionFingerprint(connection), connectionFingerprint({ ...connection, localPort: 9999 }));
  const lease = JSON.parse(readFileSync(join(temp, 'gpu_lab', 'lease.json'), 'utf8'));
  assert.equal(lease.localPort, 40123);
  await a.release();
  assert.equal(h.children[0].exited, undefined);
  await b.release();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.children[0].listenerCount('exit'), 0);
});

await test('unexpected child death is named tunnel infrastructure failure and emits no fallback', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, allocatePortImpl: async () => 40124, fetchImpl: async () => ({ ok: true }), tunnelDir: join(temp, 'death'), lingerMs: 1 });
  const lease = await manager.acquire({ ...connection, name: 'death' });
  h.children[0].emit('exit', 255, null);
  await assert.rejects(Promise.race([lease.death.then((error) => Promise.reject(error)), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))]), (error) => error.code === 'tunnel');
  await lease.release();
});

await test('orphan sweep requires PID start identity and leaves a reused PID alone', async () => {
  const dir = join(temp, 'reuse');
  mkdirSync(join(dir, 'old',), { recursive: true });
  writeFileSync(join(dir, 'old', 'lease.json'), JSON.stringify({ pid: process.pid, startIdentity: 'old-start', connection: 'old' }));
  const manager = createTunnelManager({ ...fakeHarness({ psOutput: 'new-start' }), tunnelDir: dir });
  const result = await manager.sweepOrphans();
  assert.equal(result[0].action, 'pid_reuse_left_alone');
  assert.equal(existsSync(join(dir, 'old', 'lease.json')), false, 'stale lease is cleared without touching the reused process');
});

rmSync(temp, { recursive: true, force: true });
console.log(`ssh-tunnel.test.mjs: ${passed} tests passed`);
