import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimCodeOwnedProcessLaunch,
  codeOwnedProcessCleanupStatus,
  createCodeOwnedProcessIntent,
  initializeCodeOwnedProcessRegistry,
  reconcileCodeOwnedProcessPrelaunch,
} from './code-owned-process-registry.mjs';
import { runCodeOwnedProcess } from './code-owned-process.mjs';
import { runNativeProcess } from './native-process.mjs';
import { createCodeVerifier } from './code-seat-verify.mjs';

const ownedProcessUrl = new URL('./code-owned-process.mjs', import.meta.url).href;

const waitFor = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw last instanceof Error ? last : new Error('timed out waiting for owned-process state');
};

const processBirth = pid => {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
};
const processAlive = pid => {
  const birth = processBirth(pid);
  if (!birth) return false;
  try {
    return !execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z');
  } catch { return false; }
};

// Codex reads non-TTY stdin as extra prompt context even with a prompt argument.
// Ordinary callers supply no stdin: both paths must expose immediate EOF,
// independently of IPC. Trusted nested supervisors opt into a lifetime pipe.
for (const supervised of [false, true]) for (const targetIpc of [false, true]) {
  test(`stdin reaches EOF with ${supervised ? 'supervised' : 'direct'} launch and IPC ${targetIpc ? 'on' : 'off'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'camus-owned-process-eof-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let stdout = '';
    const messages = [];
    const controller = new AbortController();
    // Bound the direct-path failure too; its caller normally owns the timer.
    const timer = setTimeout(() => controller.abort(), 5000);
    t.after(() => clearTimeout(timer));
    const result = await runCodeOwnedProcess({
      ...(supervised ? { runDir: root } : {}), kind: 'codex_reviewer',
      command: process.execPath, args: ['-e', `
        const input = require('node:fs').readFileSync(0, 'utf8');
        if (input !== '') process.exit(9);
        process.stdout.write('stdin-eof');
        if (process.send) process.send({ type: 'eof_confirmed' }, () => process.disconnect());
      `], cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 2000,
      signal: controller.signal, targetIpc,
      onStdout: chunk => { stdout += chunk; },
      onMessage: message => { messages.push(message); },
    });
    assert.equal(result.code, 0, 'EOF-dependent target must finish, not time out');
    assert.equal(stdout, 'stdin-eof');
    assert.deepEqual(messages, targetIpc ? [{ type: 'eof_confirmed' }] : []);
    if (supervised) {
      const cleanup = codeOwnedProcessCleanupStatus(root);
      assert.equal(cleanup.complete, true);
      assert.equal(cleanup.intents.length, 1);
      assert.equal(cleanup.intents[0].cleanup.reason, 'target_closed');
    }
  });
}

for (const targetIpc of [false, true]) {
  test(`explicit lifetime stdin stays open with IPC ${targetIpc ? 'on' : 'off'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'camus-owned-process-lifetime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let stdout = '';
    const result = await runCodeOwnedProcess({ runDir: root, kind: 'verifier',
      command: process.execPath, args: ['-e', `
        process.stdin.on('end', () => process.exit(9));
        process.stdin.resume();
        setTimeout(() => {
          process.stdout.write('lifetime-open');
          process.stdin.destroy();
          if (process.connected) process.disconnect();
        }, 100);
      `], cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 2000,
      targetIpc, stdinMode: 'lifetime', onStdout: chunk => { stdout += chunk; } });
    assert.equal(result.code, 0);
    assert.equal(stdout, 'lifetime-open');
    assert.equal(codeOwnedProcessCleanupStatus(root).complete, true);
  });
}

test('direct subprocess cancellation kills a wrapper and its output-holding descendant', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-direct-process-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, 'descendant.pid');
  const targetPath = join(root, 'descendant.mjs');
  await writeFile(targetPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runCodeOwnedProcess({ command: '/bin/sh',
    args: ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(targetPath)} & wait`],
    cwd: root, env: process.env, timeoutMs: 30_000, signal: controller.signal });
  const descendant = Number(await waitFor(async () => {
    try { return await readFile(pidPath, 'utf8'); } catch { return null; }
  }));
  t.after(() => { try { process.kill(descendant, 'SIGKILL'); } catch {} });
  assert.equal(processAlive(descendant), true);
  controller.abort();
  await running;
  assert.ok(Date.now() - startedAt < 2_000, 'cancellation does not wait for the descendant');
  await waitFor(() => !processAlive(descendant));
});

test('SIGKILL of evaluator with a noisy long-lived reviewer cleans target and descendant before terminal proof', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-owned-process-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, 'pids.json');
  const targetPath = join(root, 'fake-reviewer.mjs');
  await writeFile(targetPath, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ target: process.pid, descendant: descendant.pid }));
    setInterval(() => process.stdout.write('reviewing\\n'), 5);
  `);
  const workerSource = `
    import { runCodeOwnedProcess } from ${JSON.stringify(ownedProcessUrl)};
    await runCodeOwnedProcess({ runDir: ${JSON.stringify(root)}, kind: 'claude_reviewer',
      command: process.execPath, args: [${JSON.stringify(targetPath)}], cwd: ${JSON.stringify(root)}, timeoutMs: 60000 });
  `;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch {} });
  const pids = await waitFor(async () => JSON.parse(await readFile(pidPath, 'utf8')));
  const processIdentities = [pids.target, pids.descendant].map(pid => ({ pid, birth: processBirth(pid) }));
  t.after(() => {
    for (const identity of processIdentities) {
      try { if (identity.birth && processBirth(identity.pid) === identity.birth) process.kill(identity.pid, 'SIGKILL'); } catch {}
    }
  });
  const active = await waitFor(() => {
    const status = codeOwnedProcessCleanupStatus(root);
    return status.intents[0]?.state === 'active' ? status : null;
  });
  assert.equal(active.complete, false);
  assert.equal(processAlive(pids.target), true); assert.equal(processAlive(pids.descendant), true);

  // Closing the evaluator also closes the supervisor output pipes while the
  // target is still noisy. EPIPE/disconnect must enter cleanup, not bypass it.
  process.kill(worker.pid, 'SIGKILL');
  const terminal = await waitFor(() => {
    const status = codeOwnedProcessCleanupStatus(root);
    return status.complete ? status : null;
  }, 20_000);
  assert.equal(processAlive(pids.target), false);
  assert.equal(processAlive(pids.descendant), false);
  assert.equal(terminal.intents[0].cleanup.complete, true);
  assert.match(terminal.intents[0].cleanup.reason, /parent_(disconnect|output_closed)/);
});

test('recovery reconciles unclaimed and exact-dead-supervisor prelaunch intents but refuses live claims', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-owned-process-prelaunch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = initializeCodeOwnedProcessRegistry(root);
  assert.equal(paths.run, await realpath(root));

  createCodeOwnedProcessIntent(root, 'verifier');
  let status = reconcileCodeOwnedProcessPrelaunch(root);
  assert.equal(status.complete, true);
  assert.equal(status.intents[0].cleanup.reason, 'prelaunch_abandoned');

  const dead = createCodeOwnedProcessIntent(root, 'native_harness');
  assert.equal(claimCodeOwnedProcessLaunch(dead.path, 'supervisor', {
    pid: 999999999, birth: 'Mon Jan  1 00:00:00 2001',
  }), true);
  status = reconcileCodeOwnedProcessPrelaunch(root);
  assert.equal(status.complete, true);
  assert.equal(status.intents[1].cleanup.reason, 'prelaunch_supervisor_dead');

  const live = createCodeOwnedProcessIntent(root, 'codex_reviewer');
  assert.equal(claimCodeOwnedProcessLaunch(live.path, 'supervisor', {
    pid: process.pid, birth: processBirth(process.pid),
  }), true);
  status = reconcileCodeOwnedProcessPrelaunch(root);
  assert.equal(status.complete, false);
  assert.equal(status.reason, 'intent_cleanup_incomplete');
  assert.equal(status.intents[2].state, 'intent');
});

test('native harness and verifier paths both require terminal registered cleanup under a Build run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-owned-process-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  initializeCodeOwnedProcessRegistry(root);
  const native = await runNativeProcess({ command: process.execPath,
    args: ['-e', "process.stdout.write('native-ok')"], cwd: root, env: process.env,
    timeoutMs: 5000, ownedProcessDir: root });
  assert.equal(native.code, 0); assert.equal(native.stdout, 'native-ok');
  const verifier = createCodeVerifier(`${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
    { receiptsDir: root, timeoutMs: 5000, repeatable: true });
  const verified = await verifier({ worktree: root });
  assert.equal(verified.ran, true); assert.equal(verified.pass, true);
  const status = codeOwnedProcessCleanupStatus(root);
  assert.equal(status.complete, true);
  assert.deepEqual(status.intents.map(intent => intent.kind), ['native_harness_supervisor', 'verifier']);
  assert.ok(status.intents.every(intent => intent.cleanup.complete === true));
});
