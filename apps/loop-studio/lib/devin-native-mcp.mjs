// Owned loopback-only tool bridge. Callers own each tool's schema validation,
// filesystem/command sandbox, deadline and cancellation. No arbitrary dispatch.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export async function startDevinMcp({ tools, maxCalls, onRefusal = () => {}, onCall = () => {} }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000 || !Array.isArray(tools) || !tools.length
      || tools.length > 8 || new Set(tools.map(tool => tool.name)).size !== tools.length
      || tools.some(tool => !/^[a-z_]{1,32}$/.test(tool.name) || typeof tool.invoke !== 'function'
        || typeof tool.description !== 'string' || !tool.inputSchema)) throw new Error('Invalid Devin tool bridge contract.');
  const registry = new Map(tools.map(tool => [tool.name, { ...tool, inputSchema: structuredClone(tool.inputSchema) }]));
  const auth = `Bearer ${randomBytes(32).toString('hex')}`, expected = Buffer.from(auth);
  let port, closed = false, calls = 0, initialized = false;
  const pending = new Set(), consumedIds = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    const received = Buffer.from(String(req.headers.authorization ?? ''));
    if (closed || req.headers.host !== `127.0.0.1:${port}` || req.url !== '/mcp' || req.headers.origin !== undefined
        || received.length !== expected.length || !timingSafeEqual(received, expected)) { req.resume(); return send(403, {}); }
    if (req.method !== 'POST') { req.resume(); return send(405, {}); }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 524288) { req.resume(); return send(413, {}); }
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') return send(400, {});
      if (message.id === undefined) return message.method === 'notifications/initialized' && initialized ? send(202) : send(400, {});
      if (!(Number.isSafeInteger(message.id) || typeof message.id === 'string' && message.id.length <= 128)) return send(400, {});
      const result = value => send(200, { jsonrpc: '2.0', id: message.id, result: value });
      const refuse = (code = 'invalid_dispatch', tool = null) => {
        onRefusal({ code, tool }); return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Camus tool request refused.' } });
      };
      if (message.method === 'initialize') {
        if (initialized) return refuse(); initialized = true;
        const version = message.params?.protocolVersion;
        return result({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(version) ? version : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'camus-native', version: '1' } });
      }
      if (!initialized) return refuse();
      if (message.method === 'ping') return result({});
      if (message.method === 'tools/list') return result({ tools: [...registry.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      const p = message.params, tool = registry.get(p?.name), args = p?.arguments ?? {};
      const id = `${typeof message.id}:${message.id}`;
      if (message.method !== 'tools/call' || !tool || !args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(p).some(key => !['name', 'arguments', '_meta'].includes(key))) return refuse('invalid_dispatch', tool?.name);
      if (closed) return refuse('bridge_closed', tool.name);
      if (consumedIds.has(id)) return refuse('duplicate_request', tool.name);
      if (calls >= maxCalls) return refuse('call_limit', tool.name);
      calls++; consumedIds.add(id); // Consume before await; never retry an effect.
      try { onCall({ tool: tool.name }); }
      catch { return refuse('action_limit', tool.name); }
      if (pending.size) {
        // No queue, deferred effect or reusable request id. Busy attempts still
        // consume allowance so polling cannot bypass the host action budget.
        return result({ content: [{ type: 'text', text: JSON.stringify({ operationCompleted: false,
          code: 'tool_busy', guidance: 'Nothing executed. Await the previous tool response, then use a new request id within the remaining budget. Send tools sequentially.' }) }], isError: false });
      }
      const operation = Promise.resolve().then(() => tool.invoke(args)); pending.add(operation);
      try {
        const output = await operation;
        if (typeof output !== 'string' || Buffer.byteLength(output) > 262144) throw new Error('Bounded output exceeded.');
        return result({ content: [{ type: 'text', text: output }], isError: false });
      } catch {
        onRefusal({ code: 'tool_execution_refused', tool: tool.name }); return result({ content: [{ type: 'text', text: 'Camus refused the tool operation; stop without replay.' }], isError: true });
      } finally { pending.delete(operation); }
    } catch { if (!res.headersSent) send(400, {}); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  return {
    definition: { name: 'camus', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: auth }] },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      const end = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await end;
    },
    stats: () => ({ calls, initialized, active: pending.size, closed }),
  };
}
