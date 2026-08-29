// Trusted lifetime supervisor. Parent EOF (including SIGKILL) kills the owned
// app-server and observed descendants, including separate tool process groups.
// No model prompt is an argv. This is not containment for malicious daemons.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export const nativeChildPath = fileURLToPath(import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { command, args, cwd, timeoutMs, stdinMode = 'pipe' } = JSON.parse(process.argv[2]);
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')
      || typeof cwd !== 'string' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000000
      || !['pipe', 'closed'].includes(stdinMode)) process.exit(126);
  const child = spawn(command, args, { cwd, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let ended = false, cleanupFailed = false;
  const descendants = new Map();
  const inspect = (pid, field) => {
    try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch (error) { if (error.status === 1 || error.code === 'ESRCH') return null; throw error; }
  };
  const identity = pid => inspect(pid, 'lstart');
  const children = pid => {
    try {
      return execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1);
    } catch (error) { if (error.status === 1 || error.code === 'ESRCH') return []; throw error; }
  };
  const signal = (pid, kind) => {
    try { process.kill(pid, kind); } catch (error) { if (error.code !== 'ESRCH') cleanupFailed = true; }
  };
  function collect(pid, stop = false) {
    // Inspect only descendants of this owned process, never command lines or
    // environment values. Freezing the parent closes the ordinary fork race.
    if (stop) signal(pid, 'SIGSTOP');
    for (const childPid of children(pid)) {
      const birth = identity(childPid);
      if (birth) descendants.set(childPid, birth);
      if (descendants.size > 256) throw new Error('Native process tracking limit exceeded.');
      collect(childPid, stop);
    }
  }
  function kill() {
    if (ended) return;
    ended = true;
    if (child.pid) {
      try { collect(child.pid, true); } catch { cleanupFailed = true; }
      for (const [pid, birth] of [...descendants].reverse()) {
        // A cached PID can be recycled during a long generation. Never signal a
        // new, unrelated process merely because it reused a descendant's number.
        try { if (identity(pid) === birth) signal(pid, 'SIGKILL'); } catch { cleanupFailed = true; }
      }
      signal(-child.pid, 'SIGKILL'); signal(child.pid, 'SIGKILL');
    }
  }
  const timer = setTimeout(kill, timeoutMs);
  // Keep EOF for the supervisor: forwarding it first can orphan a tool before
  // its app-server parent has been frozen and its descendants collected.
  if (stdinMode === 'pipe') process.stdin.pipe(child.stdin, { end: false });
  else child.stdin.end();
  const tracking = setInterval(() => { if (child.pid && !ended) try { collect(child.pid); } catch { cleanupFailed = true; kill(); } }, 500);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  process.stdin.on('end', kill); process.stdin.on('error', kill);
  child.stdin.on('error', () => {});
  process.stdout.on('error', kill); process.stderr.on('error', kill);
  process.on('SIGTERM', kill); process.on('SIGINT', kill);
  child.on('error', () => { kill(); process.exitCode = 1; });
  child.on('exit', kill);
  child.on('close', async code => {
    kill(); clearTimeout(timer); clearInterval(tracking); process.stdin.destroy();
    const deadline = Date.now() + 1000;
    for (const [pid, birth] of descendants) {
      try {
        while (identity(pid) === birth && !inspect(pid, 'stat')?.startsWith('Z')) {
          if (Date.now() >= deadline) { cleanupFailed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } catch { cleanupFailed = true; }
    }
    process.exitCode = cleanupFailed ? 126 : Number.isInteger(code) ? code : 1;
  });
}
