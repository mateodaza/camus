import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { nativeChildPath } from './code-native-child.mjs';

// Private stdio only. Never expose a network listener, raw stderr, account data,
// command output or arbitrary server error bodies to the UI/checkpoint.
export class CodexRpc {
  constructor({ command = 'codex', args, cwd, env, timeoutMs, onNotification = () => {}, onDiagnostic = () => {},
    onRequest = null, protocol = 'codex' }) {
    this.nextId = 1; this.pending = new Map(); this.incoming = new Set(); this.failure = null;
    this.onNotification = onNotification; this.onRequest = onRequest; this.protocol = protocol;
    this.child = spawn(process.execPath, [nativeChildPath, JSON.stringify({ command, args, cwd, timeoutMs })], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', bytes = 0;
    const decoder = new StringDecoder('utf8');
    this.closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdin.on('error', () => this.fail('Native transport closed.'));
    this.child.on('error', () => this.fail('Native executor could not start.'));
    this.child.on('close', () => this.fail('Native executor closed before completion.'));
    this.child.stderr.on('data', (chunk) => { onDiagnostic(chunk.toString('utf8')); bytes += chunk.length; if (bytes > 32 * 1024 * 1024) this.fail('Native output limit exceeded.'); });
    this.child.stdout.on('data', (chunk) => {
      bytes += chunk.length; buffer += decoder.write(chunk);
      if (bytes > 32 * 1024 * 1024 || Buffer.byteLength(buffer) > 16 * 1024 * 1024) return this.fail('Native output limit exceeded.');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.fail('Invalid native protocol message.'); break; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail('Invalid native protocol message.'); break; }
        if (message.id !== undefined && message.method) {
          // No approval, permission, external tool or human-input authority can
          // be obtained through an unexpected reverse RPC. ACP-native adapters
          // may install an explicit, bounded handler for the exact filesystem
          // and terminal methods they own; every other caller keeps this default.
          if (!this.onRequest) {
            this.send({ id: message.id, error: { code: -32601, message: 'Not authorized by Camus.' } });
            this.fail('Native executor requested unsupported authority.'); break;
          }
          const key = `${typeof message.id}:${String(message.id)}`;
          if (this.incoming.has(key)) { this.fail('Native executor reused a live request id.'); break; }
          this.incoming.add(key);
          Promise.resolve().then(() => this.onRequest(message.method, message.params ?? {}))
            .then(result => this.send({ id: message.id, result: result ?? {} }))
            .catch(() => this.send({ id: message.id, error: { code: -32000, message: 'Camus refused the bounded tool request.' } }))
            .finally(() => this.incoming.delete(key));
          continue;
        }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('Native protocol request failed.'));
          else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
          else { pending.reject(new Error('Invalid native protocol response.')); this.fail('Invalid native protocol response.'); }
        } else if (typeof message.method === 'string') {
          try { this.onNotification(message.method, message.params ?? {}); }
          catch { this.fail('Native notification validation failed.'); }
        } else this.fail('Invalid native protocol message.');
      }
    });
  }
  send(message) {
    const wire = this.protocol === 'jsonrpc2' ? { jsonrpc: '2.0', ...message } : message;
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(wire)}\n`);
  }
  request(method, params = {}, timeoutMs = 15000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native protocol request timed out.')); this.fail('Native protocol timed out.'); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(message) {
    if (this.failure) return;
    this.failure = new Error(message);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.failure); }
    this.pending.clear(); this.child.stdin.end();
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 1500);
    const code = await this.closed; clearTimeout(timer);
    if (code === 126) throw new Error('Native process cleanup could not be verified.');
  }
}
