// Hivemind adapter — the seam where Myosin's knowledge plugs into the loop.
//
// Resolution order (checked per call, so env changes need only a restart):
//   1. MCP  — HIVEMIND_MCP_URL (+ HIVEMIND_API_KEY, an admin-issued hm_k_… key)
//             POST /api/mcp, stateless streamable HTTP, x-api-key auth.
//             knowledge_search is the stable grounding tool.
//   2. REST — HIVEMIND_API_URL (+ HIVEMIND_API_KEY), the pre-MCP fallback.
//   3. Stub — nothing configured; the UI shows "not connected" and runs
//             proceed ungrounded. Absence is visible, never silent.
//
// Artifact publish: the hive-mind MCP deliberately defers artifact tools
// (they need a conversation + streaming card an MCP request doesn't have),
// so publishArtifact uses REST when configured and otherwise reports
// honestly that the deliverable stayed local.

import { McpClient } from '../mcp-client.mjs';

const SEARCH_PATH = () => process.env.HIVEMIND_SEARCH_PATH || '/api/v1/knowledge/search';
const ARTIFACT_PATH = () => process.env.HIVEMIND_ARTIFACT_PATH || '/api/v1/artifacts';

function mcpUrl() {
  const raw = process.env.HIVEMIND_MCP_URL;
  if (!raw) return null;
  const u = new URL(raw);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/mcp';
  return u.toString();
}

function config() {
  const key = process.env.HIVEMIND_API_KEY || null;
  const mcp = mcpUrl();
  const rest = process.env.HIVEMIND_API_URL?.replace(/\/$/, '') || null;
  if (mcp && key) return { mode: 'mcp', base: mcp, key, rest };
  if (rest && key) return { mode: 'rest', base: rest, key, rest };
  return { mode: 'stub', base: null, key: null, rest: null };
}

let client = null;
let clientKey = null;
function mcpClient({ base, key }) {
  const id = `${base}|${key}`;
  if (!client || clientKey !== id) {
    client = new McpClient(base, { headers: { 'x-api-key': key }, name: 'camus-loop-studio' });
    clientKey = id;
  }
  return client;
}

export function hivemindStatus() {
  const c = config();
  return { connected: c.mode !== 'stub', mode: c.mode, base: c.base };
}

async function restCall(base, key, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hivemind ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function mapChunks(chunks, limit) {
  return (chunks ?? [])
    .slice(0, limit)
    .map((r) => ({
      title: [r.title, r.author].filter(Boolean).join(' — ') || 'Hivemind knowledge',
      text: String(r.content ?? r.text ?? '').slice(0, 1200),
      ref: r.chunk_id ?? r.notion_id ?? r.id ?? null,
      score: typeof r.score === 'number' ? r.score : null,
    }))
    .filter((r) => r.text);
}

// Returns grounding chunks or null when unavailable. Grounding is an
// enhancer, not a dependency — but its absence is always visible.
export async function searchKnowledge(query, limit = 4, log = () => {}) {
  const c = config();
  if (c.mode === 'stub') {
    log('Hivemind not connected — running ungrounded (stub adapter).');
    return null;
  }
  try {
    let chunks;
    if (c.mode === 'mcp') {
      const payload = await mcpClient(c).callTool('knowledge_search', { query, max_results: limit });
      if (payload?.success === false) throw new Error(payload.error?.message || 'knowledge_search reported failure');
      chunks = payload?.data?.chunks;
    } else {
      const data = await restCall(c.base, c.key, SEARCH_PATH(), { query, limit });
      chunks = data.results ?? data.chunks ?? data.items ?? data.data?.chunks;
    }
    const items = mapChunks(chunks, limit);
    log(
      items.length
        ? `Hivemind grounding via ${c.mode}: ${items.length} chunk(s) — ${items.map((i) => `“${i.title.slice(0, 40)}” ${i.score != null ? Math.round(i.score * 100) + '%' : ''}`).join('; ')}`
        : `Hivemind grounding via ${c.mode}: no chunks above threshold for “${query.slice(0, 60)}”.`,
    );
    return items.length ? items : null;
  } catch (err) {
    log(`Hivemind grounding unavailable (${c.mode}): ${err.message}`);
    return null;
  }
}

export async function publishArtifact({ title, markdown, runId }, log = () => {}) {
  const c = config();
  if (c.mode === 'stub') {
    log('Hivemind not connected — deliverable kept local only.');
    return null;
  }
  if (c.mode === 'mcp' && !c.rest) {
    log('Hivemind MCP has no artifact tool yet (deferred upstream) — deliverable kept local only.');
    return null;
  }
  try {
    const data = await restCall(c.rest ?? c.base, c.key, ARTIFACT_PATH(), {
      title,
      content: markdown,
      metadata: { source: 'camus-loop-studio', runId },
    });
    const url = data.url ?? data.artifact?.url ?? null;
    log(url ? `Published to Hivemind artifacts: ${url}` : 'Published to Hivemind artifacts.');
    return { url };
  } catch (err) {
    log(`Hivemind artifact publish failed: ${err.message}`);
    return null;
  }
}
