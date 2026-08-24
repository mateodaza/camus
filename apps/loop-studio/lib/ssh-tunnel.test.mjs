import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenSshConfig, buildSshArgv, connectionFingerprint, createTunnelManager, redactSshDiagnostics, validateSshTunnelConfig, advisoryHostKeyLookup, classifySshFailure } from './ssh-tunnel.mjs';
import { installTunnelLifecycle } from './tunnel-lifecycle.mjs';

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
  assert.throws(() => screenSshConfig(`${fakeConfig(40123)}\nlocalforward 127.0.0.1:4012 127.0.0.1:11434`, { localPort: 40123, connection }), /additional LocalForward/);
});

await test('diagnostics redact users, hosts, IPs, paths, and credentials with a bound', () => {
  const out = redactSshDiagnostics('alice@private.example 10.2.3.4 /Users/alice/.ssh/id_ed25519 Bearer sk-secret-123456789\n'.repeat(300));
  assert.ok(out.length <= 64 * 1024);
  assert.equal(out.includes('alice@private.example'), false);
  assert.equal(out.includes('10.2.3.4'), false);
  assert.equal(out.includes('sk-secret-123456789'), false);
  assert.equal(out.includes('private.example'), false);
  assert.equal(out.includes('id_ed25519'), false);
  assert.equal(out.includes('alice'), false);
});

await test('host-key lookup treats nonzero ssh-keygen exit as advisory when stdout has a hit', async () => {
  const result = await advisoryHostKeyLookup({ effective: { hostname: 'camus-gpu', userKnownHostsFile: '/tmp/known' }, execFileImpl: (file, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), 'camus-gpu ssh-ed25519 AAAA', '') });
  assert.equal(result.found, true);
});

function fakeHarness({ onSpawn, psOutput = '' } = {}) {
  let starts = 0;
  const children = [];
  const execFileImpl = (file, args, opts, cb) => {
    if (file === 'ssh-keygen') return cb(new Error('not in fixture'), '', '');
    if (file === 'ps') return cb(null, psOutput || 'fake-start', '');
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
  const evidence = [];
  let livenessProbes = 0;
  const manager = createTunnelManager({
    ...h,
    processOps: { alive: () => true },
    allocatePortImpl: async () => 40123,
    fetchImpl: async () => { livenessProbes += 1; return { ok: true, json: async () => ({ data: [] }) }; },
    onEvidence: (fact) => evidence.push(fact),
    tunnelDir: temp,
    lingerMs: 1,
  });
  const a = await manager.acquire(connection);
  const b = await manager.acquire(connection);
  assert.equal(h.starts, 1);
  assert.equal(livenessProbes, 2, 'every borrower freshly proves application liveness even when the child is shared');
  assert.equal(a.url, b.url);
  assert.equal(connectionFingerprint(connection), connectionFingerprint({ ...connection, localPort: 9999 }));
  const completeControls = ['config_validate', 'host_key_advisory', 'directive_screen', 'forward_only_argv', 'ownership', 'application_liveness', 'output_integrity'];
  const sharedAt = evidence.findIndex((fact) => fact.control === 'ownership' && fact.outcome === 'shared');
  assert.notEqual(sharedAt, -1);
  const sharedEvidence = evidence.slice(sharedAt - 4, sharedAt + 3);
  assert.deepEqual(new Set(sharedEvidence.map((fact) => fact.control)), new Set(completeControls), 'a shared lease emits a complete route for the new borrower');
  assert.equal(sharedEvidence.every((fact) => fact.connectionFingerprint === connectionFingerprint(connection)), true, 'all borrower evidence is bound to the exact SSH destination');
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
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40124, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'death'), lingerMs: 1 });
  const lease = await manager.acquire({ ...connection, name: 'death' });
  h.children[0].emit('exit', 255, null);
  await assert.rejects(Promise.race([lease.death.then((error) => Promise.reject(error)), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))]), (error) => error.code === 'tunnel');
  await lease.release();
});

await test('unexpected death removes the dead record so the next acquire cannot share it', async () => {
  const h = fakeHarness();
  const ports = [40125, 40126];
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => ports.shift(), fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'reacquire'), lingerMs: 1 });
  const first = await manager.acquire({ ...connection, name: 'reacquire' });
  h.children[0].emit('exit', 255, null);
  const second = await manager.acquire({ ...connection, name: 'reacquire' });
  assert.notEqual(second.localPort, first.localPort);
  assert.equal(h.starts, 2);
  await second.release();
});

await test('sharing is per named connection; different names never alias the same child', async () => {
  const h = fakeHarness();
  let port = 40140;
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => port++, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'names'), lingerMs: 1 });
  const one = await manager.acquire({ ...connection, name: 'one' });
  const same = await manager.acquire({ ...connection, name: 'one' });
  const other = await manager.acquire({ ...connection, name: 'two' });
  assert.equal(h.starts, 2);
  assert.equal(one.localPort, same.localPort);
  assert.notEqual(one.localPort, other.localPort);
  await one.release(); await same.release(); await other.release();
});

await test('reacquiring during linger cancels teardown and preserves the active borrower', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40150, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'linger'), lingerMs: 25 });
  const first = await manager.acquire({ ...connection, name: 'linger' });
  await first.release();
  const second = await manager.acquire({ ...connection, name: 'linger' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.starts, 1);
  assert.equal(manager.active.size, 1);
  await second.release();
});

await test('force doctor-style sweep leaves an active manager-owned lease untouched', async () => {
  const dir = join(temp, 'active-managed');
  const h = fakeHarness();
  const killed = [];
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true, kill: async (_pid, signal) => killed.push(signal) }, allocatePortImpl: async () => 40205, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: dir, lingerMs: 1 });
  const lease = await manager.acquire({ ...connection, name: 'active-managed' });
  const result = await manager.startup({ force: true });
  assert.equal(result[0].action, 'active_managed');
  assert.deepEqual(killed, []);
  assert.equal(existsSync(join(dir, 'active-managed', 'lease.json')), true);
  await lease.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.active.size, 0);
});

await test('double release is idempotent and cannot consume another borrower reference', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40206, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'double-release'), lingerMs: 5 });
  const first = await manager.acquire({ ...connection, name: 'double-release' });
  const second = await manager.acquire({ ...connection, name: 'double-release' });
  await first.release();
  await first.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.active.size, 1);
  await second.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.active.size, 0);
});

await test('an acquire during active stop survives the old record completion', async () => {
  const h = fakeHarness();
  const killed = [];
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40207, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'stop-race'), lingerMs: 0 });
  const first = await manager.acquire({ ...connection, name: 'stop-race' });
  const oldChild = h.children[0];
  oldChild.kill = (signal) => { killed.push(signal); if (signal === 'SIGKILL') { oldChild.emit('exit', null, signal); } };
  await first.release();
  while (!killed.length) await new Promise((resolve) => setImmediate(resolve));
  const second = await manager.acquire({ ...connection, name: 'stop-race' });
  assert.equal(manager.active.size, 1);
  // The old child is still intentionally TERM-stubborn; bounded KILL ends it.
  await new Promise((resolve) => setTimeout(resolve, 1650));
  assert.equal(manager.active.size, 1);
  await second.release();
  await manager.close();
});

await test('orphan sweep requires PID start identity and leaves a reused PID alone', async () => {
  const dir = join(temp, 'reuse');
  mkdirSync(join(dir, 'old',), { recursive: true });
  writeFileSync(join(dir, 'old', 'lease.json'), JSON.stringify({ schemaVersion: 1, pid: process.pid, startIdentity: 'old-start', connection: 'old' }));
  const manager = createTunnelManager({ ...fakeHarness({ psOutput: 'new-start' }), tunnelDir: dir });
  const result = await manager.sweepOrphans();
  assert.equal(result[0].action, 'pid_reuse_left_alone');
  assert.equal(existsSync(join(dir, 'old', 'lease.json')), false, 'stale lease is cleared without touching the reused process');
});

await test('corrupt lease is surfaced as inconclusive evidence and cleared', async () => {
  const dir = join(temp, 'corrupt');
  mkdirSync(join(dir, 'bad'), { recursive: true });
  writeFileSync(join(dir, 'bad', 'lease.json'), '{not-json');
  const evidence = [];
  const manager = createTunnelManager({ tunnelDir: dir, onEvidence: (fact) => evidence.push(fact) });
  const result = await manager.sweepOrphans();
  assert.equal(result[0].action, 'corrupt_inconclusive');
  assert.equal(evidence.at(-1).outcome, 'inconclusive');
  assert.equal(existsSync(join(dir, 'bad', 'lease.json')), false);
});

await test('application lifecycle hook is injectable, removable, and closes manager before server', async () => {
  const listeners = new Map();
  const proc = { on: (name, fn) => listeners.set(name, fn), off: (name) => listeners.delete(name) };
  const order = [];
  const manager = { close: async () => order.push('manager') };
  const server = { close: (cb) => { order.push('server'); cb(); } };
  let exitCode = null;
  const lifecycle = installTunnelLifecycle({ manager, server, processRef: proc, exit: (code) => { exitCode = code; } });
  await lifecycle.close('SIGTERM');
  assert.deepEqual(order, ['manager', 'server']);
  assert.equal(exitCode, 143);
  lifecycle.remove();
  assert.equal(listeners.size, 0);
});

await test('a local bind collision retries exactly once with a fresh port', async () => {
  const h = fakeHarness();
  const ports = [40130, 40131];
  let spawnCount = 0;
  const spawnImpl = (file, args, opts) => {
    spawnCount += 1;
    const child = h.spawnImpl(file, args, opts);
    if (spawnCount === 1) queueMicrotask(() => { child.stderr.emit('data', 'bind: Address already in use'); child.emit('exit', 255, null); });
    return child;
  };
  const manager = createTunnelManager({ ...h, spawnImpl, portOccupancyProbe: async (port) => port === 40130, processOps: { alive: () => true }, allocatePortImpl: async () => ports.shift(), fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'retry'), lingerMs: 1 });
  const lease = await manager.acquire({ ...connection, name: 'retry' });
  assert.equal(spawnCount, 2);
  assert.match(lease.url, /40131/);
  await lease.release();
});

await test('non-loopback listener reachability fails closed before application use', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, nonLoopbackProbe: async () => true, allocatePortImpl: async () => 40135, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'privacy-bind') });
  await assert.rejects(manager.acquire({ ...connection, name: 'privacy-bind' }), /non-loopback/);
});

await test('service-down and hung /models responses fail closed with bounded liveness', async () => {
  const h1 = fakeHarness();
  const down = createTunnelManager({ ...h1, processOps: { alive: () => true }, allocatePortImpl: async () => 40136, fetchImpl: async () => ({ ok: false, json: async () => ({}) }), tunnelDir: join(temp, 'down') });
  await assert.rejects(down.acquire({ ...connection, name: 'down' }), /did not answer/);
  const h2 = fakeHarness();
  const hung = createTunnelManager({ ...h2, processOps: { alive: () => true }, livenessTimeoutMs: 10, allocatePortImpl: async () => 40137, fetchImpl: async () => new Promise(() => {}), tunnelDir: join(temp, 'hung') });
  await assert.rejects(hung.acquire({ ...connection, name: 'hung' }), /did not answer/);
});

await test('stderr classes are fixed presentation only and each handshake failure spawns once', async () => {
  for (const [name, stderr, failureClass] of [
    ['unknown', 'ssh: Could not resolve hostname secret.example: Name or service not known', 'unknown_host_key'],
    ['changed', '@@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@', 'host_key_changed'],
    ['auth', 'Permission denied (publickey,password).', 'authentication_refused'],
  ]) {
    const h = fakeHarness();
    const spawnImpl = (file, args, opts) => {
      const child = h.spawnImpl(file, args, opts);
      queueMicrotask(() => { child.stderr.emit('data', stderr); child.emit('exit', 255, null); });
      return child;
    };
    const manager = createTunnelManager({ ...h, spawnImpl, processOps: { alive: () => true }, portOccupancyProbe: async () => false, allocatePortImpl: async () => 40200, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, `class-${name}`) });
    await assert.rejects(manager.acquire({ ...connection, name }), (error) => error.code === 'tunnel' && error.failureClass === failureClass && typeof error.fix === 'string' && !error.message.includes('secret.example'));
    assert.equal(h.starts, 1);
    assert.equal(existsSync(join(temp, `class-${name}`, name, 'known_hosts')), false);
  }
  assert.equal(classifySshFailure('unknown banner with user@example.com 192.0.2.2 /home/user/.ssh/key').failureClass, 'ssh_diagnostic');
});

await test('fresh-port bind race is occupancy-probed, retries once, then refuses', async () => {
  const h = fakeHarness();
  const ports = [40210, 40211, 40212];
  const attemptedPorts = [];
  let spawnCount = 0;
  const spawnImpl = (file, args, opts) => {
    spawnCount += 1;
    attemptedPorts.push(portFrom(args));
    const child = h.spawnImpl(file, args, opts);
    queueMicrotask(() => { child.stderr.emit('data', 'untrusted banner without control meaning'); child.emit('exit', 255, null); });
    return child;
  };
  const manager = createTunnelManager({ ...h, spawnImpl, processOps: { alive: () => true }, portOccupancyProbe: async () => true, allocatePortImpl: async () => ports.shift(), fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'bind-refuse') });
  await assert.rejects(manager.acquire({ ...connection, name: 'bind-refuse' }), (error) => error.code === 'bind_collision' && error.failureClass === 'forward_bind_failed');
  assert.equal(spawnCount, 2);
  assert.equal(attemptedPorts.length, 2);
  assert.notEqual(attemptedPorts[0], attemptedPorts[1]);
});

await test('concurrent first acquires coalesce behind one in-flight transport', async () => {
  const h = fakeHarness();
  let releasePort;
  const barrier = new Promise((resolve) => { releasePort = resolve; });
  let allocations = 0;
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => {
    allocations += 1;
    if (allocations === 1) await barrier;
    return 40220;
  }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'concurrent') });
  const first = manager.acquire({ ...connection, name: 'concurrent' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = manager.acquire({ ...connection, name: 'concurrent' });
  releasePort();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.starts, 1);
  assert.equal(a.localPort, b.localPort);
  await a.release(); await b.release();
});

await test('timeout aborts a hung response body, not just fetch headers', async () => {
  const h = fakeHarness();
  let aborted = false;
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, livenessTimeoutMs: 10, allocatePortImpl: async () => 40230, fetchImpl: async (_url, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return { ok: true, json: () => new Promise(() => {}) };
  }, tunnelDir: join(temp, 'body-timeout') });
  await assert.rejects(manager.acquire({ ...connection, name: 'body-timeout' }), /did not answer/);
  assert.equal(aborted, true);
});

await test('liveness failure uses bounded TERM/KILL teardown and removes the lease', async () => {
  const h = fakeHarness();
  const killed = [];
  const spawnImpl = (file, args, opts) => {
    const child = h.spawnImpl(file, args, opts);
    child.kill = (signal) => { killed.push(signal); if (signal === 'SIGKILL') child.emit('exit', null, signal); };
    queueMicrotask(() => child.stderr.emit('data', 'service unavailable'));
    return child;
  };
  const dir = join(temp, 'stubborn');
  const manager = createTunnelManager({ ...h, spawnImpl, processOps: { alive: () => true }, allocatePortImpl: async () => 40235, fetchImpl: async () => ({ ok: false, json: async () => ({}) }), tunnelDir: dir });
  await assert.rejects(manager.acquire({ ...connection, name: 'stubborn' }), /did not answer/);
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(existsSync(join(dir, 'stubborn', 'lease.json')), false);
  assert.equal(manager.active.size, 0);
});

await test('close gates new acquires, drains an in-flight start, and leaves no child', async () => {
  const h = fakeHarness();
  let entered; const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release; const barrier = new Promise((resolve) => { release = resolve; });
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => { entered(); await barrier; return 40236; }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'close-drain') });
  const first = manager.acquire({ ...connection, name: 'close-drain' });
  await enteredPromise;
  const closing = manager.close();
  await assert.rejects(manager.acquire({ ...connection, name: 'after-close' }), (error) => error.code === 'closed');
  release();
  await Promise.allSettled([first, closing]);
  assert.equal(manager.active.size, 0);
  assert.equal(manager.inflight.size, 0);
});

await test('an aborted coalesced waiter rejects without cancelling the shared borrower', async () => {
  const h = fakeHarness();
  let release; const barrier = new Promise((resolve) => { release = resolve; });
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => { await barrier; return 40237; }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: join(temp, 'waiter-abort') });
  const first = manager.acquire({ ...connection, name: 'waiter-abort' });
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = manager.acquire({ ...connection, name: 'waiter-abort' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, (error) => error.code === 'aborted');
  release();
  const lease = await first;
  assert.equal(h.starts, 1);
  await lease.release();
});

await test('an aborted shared-lease revalidation preserves the existing borrower and reference count', async () => {
  const h = fakeHarness();
  let calls = 0;
  const manager = createTunnelManager({
    ...h,
    processOps: { alive: () => true },
    allocatePortImpl: async () => 40238,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      if (calls !== 2) return { ok: true, json: async () => ({ data: [] }) };
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true });
      });
    },
    tunnelDir: join(temp, 'shared-abort'),
    lingerMs: 1,
  });
  const first = await manager.acquire({ ...connection, name: 'shared-abort' });
  const controller = new AbortController();
  const second = manager.acquire({ ...connection, name: 'shared-abort' }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(second, (error) => error.code === 'aborted');
  assert.equal(h.starts, 1);
  assert.equal([...manager.active.values()][0].refs, 1, 'the failed borrower reservation is rolled back');
  const third = await manager.acquire({ ...connection, name: 'shared-abort' });
  assert.equal(h.starts, 1, 'the surviving owned child remains reusable');
  await third.release();
  await first.release();
});

await test('runtime root base path joins model URL without a double slash', async () => {
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40240, fetchImpl: async (url) => { assert.equal(url, 'http://127.0.0.1:40240/models'); return { ok: true, json: async () => ({ data: [] }) }; }, tunnelDir: join(temp, 'root-path') });
  const lease = await manager.acquire({ ...connection, name: 'root-path', basePath: '/' });
  assert.equal(lease.url, 'http://127.0.0.1:40240');
  await lease.release();
});

await test('pre-existing tunnel directories and evidence files are tightened', async () => {
  const dir = join(temp, 'modes');
  mkdirSync(join(dir, 'modes'), { recursive: true, mode: 0o777 });
  chmodSync(dir, 0o777); chmodSync(join(dir, 'modes'), 0o777);
  writeFileSync(join(dir, 'modes', 'events.jsonl'), 'old\n', { mode: 0o666 });
  chmodSync(join(dir, 'modes', 'events.jsonl'), 0o666);
  const h = fakeHarness();
  const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40250, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), tunnelDir: dir, lingerMs: 1 });
  const lease = await manager.acquire({ ...connection, name: 'modes' });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'modes')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'modes', 'events.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'modes', 'lease.json')).mode & 0o777, 0o600);
  await lease.release();
});

await test('explicit raw debug warning names only the local tunnel directory and writes 0600 raw output', async () => {
  const previous = process.env.STUDIO_TUNNEL_DEBUG;
  process.env.STUDIO_TUNNEL_DEBUG = '1';
  const dir = join(temp, 'raw-root');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const h = fakeHarness();
    const fetchImpl = async () => { h.children[0]?.stderr.emit('data', 'alice@private.example 10.2.3.4 /Users/alice/.ssh/key'); return { ok: false, json: async () => ({}) }; };
    const manager = createTunnelManager({ ...h, processOps: { alive: () => true }, allocatePortImpl: async () => 40255, fetchImpl, tunnelDir: dir });
    const acquire = manager.acquire({ ...connection, name: 'raw-debug' });
    await assert.rejects(acquire);
  } finally {
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.STUDIO_TUNNEL_DEBUG;
    else process.env.STUDIO_TUNNEL_DEBUG = previous;
  }
  assert.ok(warnings.some((message) => message.includes(dir) && message.includes('raw SSH diagnostics')));
  assert.equal(statSync(join(dir, 'raw-debug', 'diagnostics.raw.log')).mode & 0o777, 0o600);
});

await test('matching orphan receives bounded TERM then KILL and durable evidence', async () => {
  const dir = join(temp, 'matching');
  mkdirSync(join(dir, 'old'), { recursive: true });
  writeFileSync(join(dir, 'old', 'lease.json'), JSON.stringify({ schemaVersion: 1, pid: 6000, startIdentity: 'same-start', connection: 'old' }));
  let alive = true; const killed = [];
  const h = fakeHarness({ psOutput: 'same-start' });
  const manager = createTunnelManager({ ...h, tunnelDir: dir, processOps: { alive: () => alive, kill: async (_pid, signal) => { killed.push(signal); if (signal === 'SIGKILL') alive = false; }, wait: async () => {} } });
  const result = await manager.sweepOrphans();
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(result[0].action, 'closed');
  assert.match(readFileSync(join(dir, 'old', 'events.jsonl'), 'utf8'), /orphan_closed/);
});

await test('startup sweep runs even when no tunnel is acquired', async () => {
  const dir = join(temp, 'startup-only');
  mkdirSync(join(dir, 'bad'), { recursive: true });
  writeFileSync(join(dir, 'bad', 'lease.json'), '{broken');
  const manager = createTunnelManager({ tunnelDir: dir });
  await manager.startup();
  assert.equal(existsSync(join(dir, 'bad', 'lease.json')), false);
});

await test('per-operation evidence subscription sees sweep and preflight on a shared manager', async () => {
  const evidence = [];
  const h = fakeHarness();
  const dir = join(temp, 'evidence-subscribe');
  mkdirSync(join(dir, 'bad'), { recursive: true });
  writeFileSync(join(dir, 'bad', 'lease.json'), '{broken');
  const manager = createTunnelManager({ ...h, tunnelDir: dir });
  const remove = manager.subscribe((fact) => evidence.push(fact));
  await manager.sweepOrphans();
  await manager.preflight({ ...connection, name: 'evidence-subscribe' }, { localPort: 40260 });
  remove();
  assert.ok(evidence.some((fact) => fact.control === 'config_validate'));
  assert.ok(evidence.some((fact) => fact.control === 'lease_sweep'));
  assert.ok(evidence.some((fact) => fact.control === 'directive_screen'));
});

await test('installed OpenSSH ClearAllForwardings regression probe is local and skip-safe', async () => {
  const run = (args) => new Promise((resolve) => execFile('ssh', args, { timeout: 3000 }, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
  const version = await run(['-V']);
  if (version.error) return;
  const result = await run(['-G', '-o', 'ClearAllForwardings=yes', '-L', '127.0.0.1:40123:127.0.0.1:11434', '--', 'camus-nonexistent']);
  assert.equal(result.error, null, result.error?.message || 'ssh -G failed');
  const forwards = result.stdout.split(/\r?\n/).filter((line) => /^localforward\s/i.test(line));
  assert.equal(forwards.length, 0);
});

rmSync(temp, { recursive: true, force: true });
console.log(`ssh-tunnel.test.mjs: ${passed} tests passed`);
