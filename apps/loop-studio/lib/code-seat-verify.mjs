// The model cannot ask for shell execution. Only the operator's frozen verify
// command can run, with a bounded lifetime and no provider credential env.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticSecrets, verificationDiagnostics } from './code-diagnostics.mjs';
import { createHash } from 'node:crypto';
import { verificationChildPath } from './code-verify-child.mjs';
import { runCodeOwnedProcess } from './code-owned-process.mjs';

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
    let timer = null, onAbort = null;
    try {
      const startedAt = Date.now();
      let killed = null, outputBytes = 0, error = null, guarded = null, output = Buffer.alloc(0);
      const local = new AbortController();
      const terminate = reason => { if (!killed) { killed = reason; local.abort(new Error(reason)); } };
      timer = setTimeout(() => terminate('verification timed out'), timeoutMs);
      onAbort = () => terminate('verification aborted');
      signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
      const consume = chunk => {
        outputBytes += chunk.length;
        if (output.length < 32_768) output = Buffer.concat([output, chunk.subarray(0, 32_768 - output.length)]);
        if (outputBytes > 2_000_000) terminate('verification output limit exceeded');
      };
      let owned;
      try {
        owned = await runCodeOwnedProcess({ runDir: receiptsDir, kind: 'verifier', command: process.execPath,
          args: [verificationChildPath, command, String(timeoutMs)], cwd: worktree,
          env: verificationEnvironment(process.env, privateHome), timeoutMs: timeoutMs + 5000,
          signal: local.signal, targetIpc: true, onStdout: consume, onStderr: consume,
          onMessage: message => { if (message?.type === 'verification_exit') guarded = message; } });
      } catch { error = 'verification process could not start'; owned = { code: 126 }; }
      const code = guarded?.exitCode ?? owned.code;
      const guardCode = guarded?.guardReason;
      const unavailable = [126, 127].includes(code);
      const guardError = !guarded ? 'verification supervisor result unavailable' : guardCode === 124 ? 'verification timed out'
        : guardCode === 125 ? 'verification output limit exceeded' : guardCode === 130 ? 'verification aborted'
          : guardCode ? 'verification process could not start' : null;
      return { ran: !error, pass: killed || error || guardError || unavailable ? null : code === 0,
        exitCode: code, error: killed || error || guardError, duration_ms: Date.now() - startedAt,
        command, outputBytes, outputRetained: false,
        diagnostics: code !== 0 && !killed && !error && !guardError ? { ...verificationDiagnostics(output.toString('utf8'), { exitCode: code, incomplete: outputBytes > output.length, secrets, roots: [worktree, privateHome] }),
          commandHash: createHash('sha256').update(command).digest('hex'), candidateFingerprint: fingerprint ?? null } : null,
        isolation: 'credential-env-scrubbed; not an operating-system sandbox' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      await rm(privateHome, { recursive: true, force: true });
    }
  };
  verify.command = command;
  verify.repeatable = repeatable;
  return verify;
}
