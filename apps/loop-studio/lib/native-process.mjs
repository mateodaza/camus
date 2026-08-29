import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { nativeChildPath } from './code-native-child.mjs';

// One owned, bounded child process. The lifetime supervisor keeps stdin open as
// a parent-death signal while closing stdin to the actual headless harness.
// Callers receive parsed protocol frames, never raw stderr/provider bodies.
export async function runNativeProcess({ command, args = [], cwd, env, timeoutMs,
  signal, jsonl = false, maxBytes = 32 * 1024 * 1024, maxLineBytes = 16 * 1024 * 1024,
  onFrame = () => {}, onDiagnostic = () => {} }) {
  const child = spawn(process.execPath, [nativeChildPath, JSON.stringify({ command, args, cwd, timeoutMs, stdinMode: 'closed' })], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', buffer = '', bytes = 0, failed = null;
  const decoder = new StringDecoder('utf8');
  const refuse = message => { if (!failed) { failed = new Error(message); child.stdin.end(); } };
  const parseLines = chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) return refuse('Native output limit exceeded.');
    if (!jsonl) { stdout += decoder.write(chunk); if (Buffer.byteLength(stdout) > maxBytes) refuse('Native output limit exceeded.'); return; }
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > maxLineBytes) return refuse('Native protocol line limit exceeded.');
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { return refuse('Invalid native JSONL protocol message.'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return refuse('Invalid native JSONL protocol message.');
      try { onFrame(frame); } catch { return refuse('Native protocol validation failed.'); }
    }
  };
  child.stdout.on('data', parseLines);
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) refuse('Native output limit exceeded.'); else onDiagnostic(chunk.length); });
  child.on('error', () => refuse('Native executor could not start.'));
  const abort = () => { if (!failed) failed = new Error('Native execution cancelled.'); child.stdin.end(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const code = await new Promise(resolve => child.once('close', resolve));
  signal?.removeEventListener('abort', abort);
  if (jsonl && buffer.trim() && !failed) {
    let frame;
    try { frame = JSON.parse(buffer); } catch { failed = new Error('Invalid native JSONL protocol message.'); }
    if (frame) try { onFrame(frame); } catch { failed = new Error('Native protocol validation failed.'); }
  }
  if (code === 126) throw new Error('Native process cleanup could not be verified.');
  if (failed) throw failed;
  return { code: Number.isInteger(code) ? code : 1, stdout: jsonl ? null : stdout + decoder.end() };
}
