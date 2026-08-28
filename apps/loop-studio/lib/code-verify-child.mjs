// A small verifier supervisor, not an agent. Its deadline survives host death;
// EOF on the parent's pipe also kills its own command group. Never reads keys.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export const verificationChildPath = fileURLToPath(import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2], timeoutMs = Number(process.argv[3]);
  if (!command || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) process.exit(126);
  const child = spawn(command, [], { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let reason = null, bytes = 0;
  const cleanup = () => { if (Number.isInteger(child.pid) && child.pid > 0) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  const stop = (code) => { reason ??= code; cleanup(); };
  const timer = setTimeout(() => stop(124), timeoutMs);
  process.on('SIGTERM', () => stop(130)); process.on('SIGINT', () => stop(130));
  process.stdin.on('end', () => stop(130)); process.stdin.on('error', () => stop(130)); process.stdin.resume();
  const forward = (stream) => (chunk) => { bytes += chunk.length; if (bytes > 2_000_000) stop(125); else stream.write(chunk); };
  child.stdout.on('data', forward(process.stdout)); child.stderr.on('data', forward(process.stderr));
  child.on('error', () => { reason = 126; });
  child.on('exit', cleanup);
  child.on('close', (code) => {
    clearTimeout(timer); cleanup(); process.stdin.destroy();
    const exitCode = Number.isInteger(code) ? code : null;
    const result = { type: 'verification_exit', exitCode, guardReason: reason };
    if (process.send) process.send(result, () => { process.disconnect(); process.exitCode = reason ?? exitCode ?? 126; });
    else process.exitCode = reason ?? exitCode ?? 126;
  });
}
