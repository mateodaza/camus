// Minimal MCP client over Streamable HTTP — zero dependencies, enough protocol
// for what the loop needs: initialize once, then tools/call. Handles servers
// that answer with plain JSON or with an SSE-framed body, and carries the
// mcp-session-id header when the server issues one.

const PROTOCOL_VERSION = '2025-03-26';

export class McpClient {
  constructor(url, { headers = {}, name = 'camus-loop-studio', timeoutMs = 30_000 } = {}) {
    this.url = url;
    this.extraHeaders = headers;
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSION; // replaced by the negotiated version after initialize
    this.initialized = null; // promise, so concurrent callers share one handshake
    this.nextId = 1;
  }

  async rpc(method, params, { notification = false } = {}) {
    const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    if (!notification) body.id = this.nextId++;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': this.protocolVersion,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(t);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (notification) {
      if (!res.ok && res.status !== 202) throw new Error(`MCP ${method} -> ${res.status}`);
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${method} -> ${res.status} ${text.slice(0, 200)}`);
    }

    const ctype = res.headers.get('content-type') || '';
    let msg;
    if (ctype.includes('text/event-stream')) {
      // The response body is a short SSE stream; the answer to our request is
      // the event whose JSON-RPC id matches.
      const raw = await res.text();
      for (const block of raw.split('\n\n')) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === body.id) { msg = parsed; break; }
        } catch { /* keep scanning frames */ }
      }
      if (!msg) throw new Error(`MCP ${method}: no matching response frame in SSE body`);
    } else {
      msg = await res.json();
    }

    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async initialize() {
    this.initialized ??= (async () => {
      const result = await this.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.name, version: '0.1.0' },
      });
      // Post-init requests must carry the version the server negotiated.
      if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
      await this.rpc('notifications/initialized', {}, { notification: true }).catch(() => {});
      return result;
    })();
    return this.initialized;
  }

  async listTools() {
    await this.initialize();
    const r = await this.rpc('tools/list', {});
    return r.tools ?? [];
  }

  // Returns the tool's payload, unwrapping the MCP content envelope: prefers
  // structuredContent, then JSON-parses text content, then falls back to the
  // raw text. Throws on isError results — a failed tool call is never data.
  async callTool(name, args) {
    await this.initialize();
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.isError) {
      const text = (r.content ?? []).map((c) => c.text ?? '').join(' ');
      throw new Error(`MCP tool ${name} errored: ${text.slice(0, 300)}`);
    }
    if (r.structuredContent !== undefined) return r.structuredContent;
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }
}
