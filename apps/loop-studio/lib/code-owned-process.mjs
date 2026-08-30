import { spawn } from 'node:child_process';
import { createCodeOwnedProcessIntent, updateCodeOwnedProcessIntent } from './code-owned-process-registry.mjs';
import { codeOwnedProcessSupervisorPath } from './code-owned-process-supervisor.mjs';

// Run one target through the trusted supervisor. Target stdout/stderr and IPC
// are callbacks; credentials stay only in the inherited environment.
export async function runCodeOwnedProcess({ runDir, kind, command, args = [], cwd, env = process.env,
  timeoutMs, signal, targetIpc = false, onStdout = () => {}, onStderr = () => {}, onMessage = () => {} }) {
  // Existing non-Build adapter entry points remain plain direct subprocesses.
  // The shared Build engine always passes its private receipts directory and
  // therefore always takes the durable supervisor path below.
  if (!runDir) {
    // A CLI may be a shell/wrapper that launches the real model process. On POSIX, own a fresh
    // process group so cancellation reaches every descendant; killing only the wrapper leaves
    // its child holding stdout/stderr open and turns an idle stop into an unbounded wait.
    const ownsProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env,
      detached: ownsProcessGroup,
      stdio: targetIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
    if (targetIpc) child.on('message', onMessage);
    let spawnError = null;
    const abort = () => {
      if (ownsProcessGroup && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
      }
      try { child.kill('SIGKILL'); } catch { /* already terminal */ }
    };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const code = await new Promise(resolvePromise => {
      child.on('error', error => { spawnError = error; resolvePromise(126); });
      child.on('close', value => resolvePromise(Number.isInteger(value) ? value : 126));
    });
    signal?.removeEventListener('abort', abort);
    if (spawnError) throw spawnError;
    return { code, started: spawnError === null, intentId: null };
  }
  const owned = createCodeOwnedProcessIntent(runDir, kind);
  const supervisor = spawn(process.execPath, [codeOwnedProcessSupervisorPath, owned.path], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  supervisor.stdout.on('data', onStdout); supervisor.stderr.on('data', onStderr);
  let started = false, ready = false, launchSent = false, spawnError = null, cancelled = Boolean(signal?.aborted);
  const launch = () => {
    if (launchSent || !ready || spawnError || cancelled) return;
    launchSent = true;
    supervisor.send({ type: 'launch', command, args, cwd, timeoutMs, targetIpc });
  };
  supervisor.on('message', message => {
    if (message?.type === 'supervisor_ready') {
      ready = true;
      if (cancelled) supervisor.kill('SIGTERM');
      else launch();
    }
    else if (message?.type === 'target_started') started = true;
    else if (message?.type === 'target_message') onMessage(message.value);
  });
  // Never kill the supervisor before it has durably claimed the launch and
  // installed its cleanup handlers. An early abort waits for ready, then asks
  // that trusted process to attest the no-target terminal state.
  const abort = () => { cancelled = true; if (ready) supervisor.kill('SIGTERM'); };
  signal?.addEventListener('abort', abort, { once: true });
  const code = await new Promise(resolvePromise => {
    supervisor.on('error', error => { spawnError = error; resolvePromise(126); });
    supervisor.on('close', value => resolvePromise(Number.isInteger(value) ? value : 126));
  });
  signal?.removeEventListener('abort', abort);
  if (spawnError && !started) {
    try { updateCodeOwnedProcessIntent(owned.path, value => ({ ...value,
      state: 'cleaned',
      cleanup: { complete: true, reason: 'supervisor_spawn_failed', recordedAt: new Date().toISOString() } })); } catch {}
  }
  return { code, started, intentId: owned.intent.intentId };
}
