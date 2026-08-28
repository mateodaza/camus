// The model cannot ask for shell execution. Only the operator's frozen verify
// command can run, with a bounded lifetime and no provider credential env.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticSecrets, verificationDiagnostics } from './code-diagnostics.mjs';
import { createHash } from 'node:crypto';
import { verificationChildPath } from './code-verify-child.mjs';

export function verificationEnvironment(parent, privateHome) {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  return {
    ...Object.fromEntries(allowed.filter((name) => typeof parent[name] === 'string').map((name) => [name, parent[name]])),
    HOME: privateHome, USERPROFILE: privateHome, TMPDIR: privateHome, TEMP: privateHome, TMP: privateHome,
    CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function createCodeVerifier(command, { receiptsDir, timeoutMs = 300_000, repeatable = false } = {}) {
  if (command == null || command === '') return null;
  if (typeof command !== 'string' || command.length > 4096 || command.includes('\0')) throw new Error('Invalid verification command.');
  if (process.platform === 'win32') throw new Error('Any-model local verification currently requires POSIX process-group cleanup. On Windows, omit --verify and verify the preserved candidate manually.');
  if (!receiptsDir || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new Error('Invalid verification limits.');
  const secrets = diagnosticSecrets();
  const verify = async ({ worktree, fingerprint, signal }) => {
    if (signal?.aborted) return { ran: false, pass: null, error: 'verification aborted' };
    await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    const privateHome = await mkdtemp(join(receiptsDir, 'verify-home-'));
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let killed = null;
      let outputBytes = 0;
      let error = null;
      let guarded = null;
      let output = Buffer.alloc(0);
      const child = spawn(process.execPath, [verificationChildPath, command, String(timeoutMs)], {
        cwd: worktree, detached: true,
        env: verificationEnvironment(process.env, privateHome), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const cleanupGroup = () => {
        if (!Number.isInteger(child.pid) || child.pid <= 0) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group already exited */ }
      };
      const terminate = (reason) => {
        if (killed) return;
        killed = reason;
        // Let the trusted supervisor clean its command's separate group. Its
        // own deadline and parent-pipe EOF cover abrupt parent termination.
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => terminate('verification timed out'), timeoutMs);
      const onAbort = () => terminate('verification aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // Bound memory before parsing; only the redacted envelope escapes here.
      const consume = (chunk) => { outputBytes += chunk.length; if (output.length < 32_768) output = Buffer.concat([output, chunk.subarray(0, 32_768 - output.length)]); if (outputBytes > 2_000_000) terminate('verification output limit exceeded'); };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('message', (message) => { if (message?.type === 'verification_exit') guarded = message; });
      child.on('error', () => { error = 'verification process could not start'; });
      // A successful shell can still leave background descendants (even ones
      // with redirected stdio). The verifier owns the whole process group and
      // releases it on normal exit too, not only on cancellation/timeouts.
      child.on('exit', cleanupGroup);
      child.on('close', (code) => {
        cleanupGroup();
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        code = guarded?.exitCode ?? code;
        const guardCode = guarded?.guardReason;
        const unavailable = [126, 127].includes(code);
        const guardError = !guarded ? 'verification supervisor result unavailable' : guardCode === 124 ? 'verification timed out' : guardCode === 125 ? 'verification output limit exceeded' : guardCode === 130 ? 'verification aborted' : guardCode ? 'verification process could not start' : null;
        resolve({ ran: !error, pass: killed || error || guardError || unavailable ? null : code === 0,
          exitCode: code, error: killed || error || guardError, duration_ms: Date.now() - startedAt,
          command, outputBytes, outputRetained: false,
          diagnostics: code !== 0 && !killed && !error && !guardError ? { ...verificationDiagnostics(output.toString('utf8'), { exitCode: code, incomplete: outputBytes > output.length, secrets, roots: [worktree, privateHome] }),
            commandHash: createHash('sha256').update(command).digest('hex'), candidateFingerprint: fingerprint ?? null } : null,
          isolation: 'credential-env-scrubbed; not an operating-system sandbox' });
      });
    });
  };
  verify.command = command;
  verify.repeatable = repeatable;
  return verify;
}
