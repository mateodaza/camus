// The model cannot ask for shell execution. Only the operator's frozen verify
// command can run, with a bounded lifetime and no provider credential env.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function verificationEnvironment(parent, privateHome) {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  return {
    ...Object.fromEntries(allowed.filter((name) => typeof parent[name] === 'string').map((name) => [name, parent[name]])),
    HOME: privateHome, USERPROFILE: privateHome, TMPDIR: privateHome, TEMP: privateHome, TMP: privateHome,
    CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function createCodeVerifier(command, { receiptsDir, timeoutMs = 300_000 } = {}) {
  if (command == null || command === '') return null;
  if (typeof command !== 'string' || command.length > 4096 || command.includes('\0')) throw new Error('Invalid verification command.');
  if (process.platform === 'win32') throw new Error('Any-model local verification currently requires POSIX process-group cleanup. On Windows, omit --verify and verify the preserved candidate manually.');
  if (!receiptsDir || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new Error('Invalid verification limits.');
  return async ({ worktree, signal }) => {
    if (signal?.aborted) return { ran: false, pass: null, error: 'verification aborted' };
    await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    const privateHome = await mkdtemp(join(receiptsDir, 'verify-home-'));
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let killed = null;
      let outputBytes = 0;
      let error = null;
      const child = spawn(command, [], {
        cwd: worktree, shell: true, detached: true,
        env: verificationEnvironment(process.env, privateHome), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cleanupGroup = () => {
        if (!Number.isInteger(child.pid) || child.pid <= 0) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group already exited */ }
      };
      const terminate = (reason) => {
        if (killed) return;
        killed = reason;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const timer = setTimeout(() => terminate('verification timed out'), timeoutMs);
      const onAbort = () => terminate('verification aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // Candidate-controlled output can contain credentials or excessive data.
      // Count it, never send it to a provider or persist it as trusted prose.
      const consume = (chunk) => { outputBytes += chunk.length; if (outputBytes > 2_000_000) terminate('verification output limit exceeded'); };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('error', () => { error = 'verification process could not start'; });
      // A successful shell can still leave background descendants (even ones
      // with redirected stdio). The verifier owns the whole process group and
      // releases it on normal exit too, not only on cancellation/timeouts.
      child.on('exit', cleanupGroup);
      child.on('close', (code) => {
        cleanupGroup();
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        resolve({ ran: !error, pass: killed || error ? null : code === 0,
          exitCode: code, error: killed || error, duration_ms: Date.now() - startedAt,
          command, outputBytes, outputRetained: false,
          isolation: 'credential-env-scrubbed; not an operating-system sandbox' });
      });
    });
  };
}
