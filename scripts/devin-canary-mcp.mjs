// A one-tool, one-call compatibility broker. Not a general MCP server or a
// production workspace tool surface. The inference process never executes code.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export async function startDevinCanaryMcp({ verify }) {
  if (typeof verify !== 'function') throw new Error('A fixed verifier is required.');
  const capability = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${capability}`);
  const stats = { requests: 0, initialized: false, listed: false, verifyCalls: 0, verifyCompleted: false };
  let port, closed = false;
  const pending = new Set();
  const server = createServer(async (req, res) => {
    const incoming = Buffer.from(String(req.headers.authorization ?? ''));
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (closed || req.headers.host !== `127.0.0.1:${port}` || req.url !== '/mcp'
        || req.headers.origin !== undefined || incoming.length !== authorization.length
        || !timingSafeEqual(incoming, authorization)) { req.resume(); return send(403, {}); }
    if (++stats.requests > 64) { req.resume(); return send(429, {}); }
    if (req.method !== 'POST') { req.resume(); return send(405, {}); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return send(413, {});
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!message || message.jsonrpc !== '2.0' || Array.isArray(message) || typeof message.method !== 'string') return send(400, {});
      const id = message.id;
      if (id === undefined) {
        return message.method === 'notifications/initialized' && stats.initialized ? send(202) : send(400, {});
      }
      if (!(typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id))) return send(400, {});
      const result = value => send(200, { jsonrpc: '2.0', id, result: value });
      const error = () => send(200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Camus refused this bounded tool request.' } });
      if (message.method === 'initialize') {
        if (stats.initialized) return error();
        stats.initialized = true;
        const requested = message.params?.protocolVersion;
        return result({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'camus-canary', version: '1.0.0' } });
      }
      if (!stats.initialized) return error();
      if (message.method === 'ping') return result({});
      if (message.method === 'tools/list') {
        stats.listed = true;
        return result({ tools: [{ name: 'verify', description: 'Run the fixed acceptance.test.mjs once in a credential-free sandbox after the one approved edit. Takes no arguments. No shell, command, path or environment override is accepted.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
      }
      const argumentsValue = message.params?.arguments === undefined ? {} : message.params.arguments;
      if (message.method !== 'tools/call' || !stats.listed || message.params?.name !== 'verify'
          || !argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)
          || Object.keys(argumentsValue).length || Object.keys(message.params).some(k => !['name', 'arguments', '_meta'].includes(k))
          || stats.verifyCalls) return error();
      stats.verifyCalls++; // Consume before await: concurrent/replayed calls never execute twice.
      const operation = Promise.resolve().then(verify);
      pending.add(operation);
      try {
        const passed = await operation;
        stats.verifyCompleted = true;
        return result({ content: [{ type: 'text', text: passed === true ? 'Fixed acceptance tests passed.' : 'Fixed acceptance tests did not pass. Stop without repairs.' }], isError: passed !== true });
      } catch { return result({ content: [{ type: 'text', text: 'Bounded verification failed. Stop without retry.' }], isError: true }); }
      finally { pending.delete(operation); }
    } catch { if (!res.headersSent) send(400, {}); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  return {
    definition: { type: 'http', name: 'camus', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${capability}` }] },
    stats,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      const ended = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await ended;
    },
  };
}
