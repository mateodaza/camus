import assert from 'node:assert/strict';
import { streamChatCompletion } from './openai-compat.mjs';

await assert.rejects(
  streamChatCompletion({
    entry: {
      name: 'missing-key',
      transport: 'ssh_tunnel',
      apiKeyEnv: 'CAMUS_TEST_MISSING_KEY',
      auth: { kind: 'bearer' },
      // Deliberately invalid: missing credentials must be diagnosed before a
      // tunnel acquisition can validate or spawn anything.
      connectionDetails: { kind: 'ssh_tunnel', name: 'missing-key', sshHostAlias: '-invalid', remoteAddress: '127.0.0.1', remotePort: 11434 },
    },
    model: 'test', prompt: 'test', timeoutMs: 100,
  }),
  (error) => error.code === 'missing_key',
);

console.log('openai-compat.test.mjs: missing credential releases no tunnel');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'raw-secret-banner host.example 127.0.0.1:45555' });
try {
  await assert.rejects(
    streamChatCompletion({
      entry: { name: 'private-connection', transport: 'ssh_tunnel', connection: 'private-connection', auth: { kind: 'none' }, tunnelLease: {
        url: 'http://127.0.0.1:45555/v1', death: new Promise(() => {}), release: async () => {},
      } }, model: 'test', prompt: 'test', timeoutMs: 100,
    }),
    (error) => error.code === 'http' && error.message.includes('connection "private-connection"')
      && !error.message.includes('45555') && !error.message.includes('raw-secret-banner') && !error.message.includes('host.example'),
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai-compat.test.mjs: tunnel HTTP errors are private and lease-owned');
