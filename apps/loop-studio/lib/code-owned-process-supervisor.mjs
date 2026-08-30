// Trusted process-group supervisor. Only the private intent path is visible in
// argv; target argv arrives over IPC after supervisor-ready evidence is durable.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { claimCodeOwnedProcessLaunch, readCodeOwnedProcessIntent, updateCodeOwnedProcessIntent } from './code-owned-process-registry.mjs';

export const codeOwnedProcessSupervisorPath = fileURLToPath(import.meta.url);
const PROCESS_INSPECTION_TIMEOUT_MS = 5000;

const inspect = (pid, field) => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`],
      { encoding: 'utf8', timeout: PROCESS_INSPECTION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch (error) {
      if (error.status === 1 || error.code === 'ESRCH') return null;
      lastError = error;
    }
  }
  throw lastError;
};
const identity = pid => inspect(pid, 'lstart');
const children = pid => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return execFileSync('/usr/bin/pgrep', ['-P', String(pid)],
      { encoding: 'utf8', timeout: PROCESS_INSPECTION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/).map(Number).filter(value => Number.isSafeInteger(value) && value > 1); }
    catch (error) {
      if (error.status === 1 || error.code === 'ESRCH') return [];
      lastError = error;
    }
  }
  throw lastError;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const intentPath = resolve(process.argv[2] ?? '');
  const processIdentity = { pid: process.pid, birth: identity(process.pid) };
  try {
    readCodeOwnedProcessIntent(intentPath);
    if (!claimCodeOwnedProcessLaunch(intentPath, 'supervisor', processIdentity)) process.exit(126);
  } catch { process.exit(126); }
  let child = null, ended = false, cleanupFailed = false, targetExit = null, timer = null, pendingMessages = 0;
  const descendants = new Map();
  try {
    updateCodeOwnedProcessIntent(intentPath, value => ({ ...value, state: 'supervisor_ready', supervisor: processIdentity }));
  } catch { process.exit(126); }
  const signal = (pid, kind) => { try { process.kill(pid, kind); } catch (error) { if (error.code !== 'ESRCH') cleanupFailed = true; } };
  const collect = (pid, stop = false) => {
    if (stop) signal(pid, 'SIGSTOP');
    for (const candidate of children(pid)) {
      const birth = identity(candidate);
      if (birth) descendants.set(candidate, birth);
      if (descendants.size > 256) throw new Error('owned descendant limit exceeded');
      collect(candidate, stop);
    }
  };
  const kill = () => {
    if (ended) return; ended = true;
    if (child?.pid) {
      try { collect(child.pid, true); } catch { cleanupFailed = true; }
      for (const [pid, birth] of [...descendants].reverse()) {
        try { if (identity(pid) === birth) signal(pid, 'SIGKILL'); } catch { cleanupFailed = true; }
      }
      signal(-child.pid, 'SIGKILL'); signal(child.pid, 'SIGKILL');
    }
  };
  const finish = async reason => {
    kill(); clearTimeout(timer); clearInterval(tracking);
    const messageDeadline = Date.now() + 500;
    while (pendingMessages > 0 && Date.now() < messageDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
    }
    const deadline = Date.now() + 2000;
    for (const [pid, birth] of descendants) {
      try {
        while (identity(pid) === birth && !inspect(pid, 'stat')?.startsWith('Z')) {
          if (Date.now() >= deadline) { cleanupFailed = true; break; }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
        }
      } catch { cleanupFailed = true; }
    }
    try {
      if (!cleanupFailed) updateCodeOwnedProcessIntent(intentPath, value => ({ ...value, state: 'cleaned',
        cleanup: { complete: true, reason, recordedAt: new Date().toISOString() } }));
    } catch { cleanupFailed = true; }
    process.exitCode = cleanupFailed ? 126 : Number.isInteger(targetExit) ? targetExit : reason === 'no_target' ? 125 : 1;
    process.disconnect?.();
  };
  const tracking = setInterval(() => { if (child?.pid && !ended) try { collect(child.pid); } catch { cleanupFailed = true; kill(); } }, 100);
  tracking.unref();
  let finishing = false;
  const requestFinish = reason => { if (!finishing) { finishing = true; finish(reason); } };
  process.stdout.on('error', () => requestFinish(child ? 'parent_output_closed' : 'no_target'));
  process.stderr.on('error', () => requestFinish(child ? 'parent_output_closed' : 'no_target'));
  process.on('disconnect', () => requestFinish(child ? 'parent_disconnect' : 'no_target'));
  process.on('SIGTERM', () => requestFinish(child ? 'supervisor_terminated' : 'no_target'));
  process.on('SIGINT', () => requestFinish(child ? 'supervisor_interrupted' : 'no_target'));
  process.on('message', message => {
    if (child || !message || message.type !== 'launch' || typeof message.command !== 'string'
        || !Array.isArray(message.args) || message.args.some(arg => typeof arg !== 'string')
        || typeof message.cwd !== 'string' || !Number.isSafeInteger(message.timeoutMs)
        || message.timeoutMs < 1 || message.timeoutMs > 90_000_000 || typeof message.targetIpc !== 'boolean') {
      requestFinish('invalid_launch'); return;
    }
    child = spawn(message.command, message.args, { cwd: message.cwd, env: process.env, detached: true,
      stdio: message.targetIpc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    // Capture descendants before the first forwarded byte can encounter a
    // closed parent pipe and make a noisy target exit between periodic scans.
    let firstOutputTracked = false;
    const trackFirstOutput = () => {
      if (firstOutputTracked || ended) return;
      firstOutputTracked = true;
      try { collect(child.pid); } catch { /* periodic and final cleanup retry and prove custody */ }
    };
    child.stdout.on('data', trackFirstOutput); child.stderr.on('data', trackFirstOutput);
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.on('message', value => {
      if (!process.send) return;
      pendingMessages++;
      process.send({ type: 'target_message', value }, () => { pendingMessages--; });
    });
    child.on('error', () => { targetExit = 126; requestFinish('target_spawn_failed'); });
    child.on('close', code => { targetExit = Number.isInteger(code) ? code : 1; requestFinish('target_closed'); });
    const birth = identity(child.pid);
    if (birth) descendants.set(child.pid, birth);
    try { updateCodeOwnedProcessIntent(intentPath, value => ({ ...value, state: 'active', target: { pid: child.pid, birth } })); }
    catch { cleanupFailed = true; requestFinish('registry_update_failed'); return; }
    timer = setTimeout(() => requestFinish('target_timeout'), message.timeoutMs);
    process.send?.({ type: 'target_started', pid: child.pid });
  });
  process.send?.({ type: 'supervisor_ready' });
}
