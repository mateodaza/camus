// Hivemind adapter — the seam where Myosin's knowledge plugs into the loop.
//
// Today: REST against the Hivemind developer API when HIVEMIND_API_URL and
// HIVEMIND_API_KEY are set; a clearly-labeled stub otherwise (the UI shows a
// "not connected" pill and the loop simply runs ungrounded).
//
// When the Hivemind MCP server is live, replace the two exported functions'
// bodies with MCP calls — the engine only knows this interface:
//   searchKnowledge(query, limit) -> [{ title, text, ref }] | null
//   publishArtifact({ title, markdown, runId }) -> { url } | null

const BASE = process.env.HIVEMIND_API_URL?.replace(/\/$/, '');
const KEY = process.env.HIVEMIND_API_KEY;
const SEARCH_PATH = process.env.HIVEMIND_SEARCH_PATH || '/api/v1/knowledge/search';
const ARTIFACT_PATH = process.env.HIVEMIND_ARTIFACT_PATH || '/api/v1/artifacts';

export function hivemindStatus() {
  return BASE && KEY
    ? { connected: true, mode: 'rest', base: BASE }
    : { connected: false, mode: 'stub', base: null };
}

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hivemind ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Returns grounding chunks or null when unavailable. Never throws into the
// loop: grounding is an enhancer, not a dependency — but its absence is
// always visible, never silent.
export async function searchKnowledge(query, limit = 4, log = () => {}) {
  if (!BASE || !KEY) {
    log('Hivemind not connected — running ungrounded (stub adapter).');
    return null;
  }
  try {
    const data = await call(SEARCH_PATH, { query, limit });
    const items = (data.results ?? data.chunks ?? data.items ?? [])
      .slice(0, limit)
      .map((r) => ({
        title: r.title ?? r.source ?? 'Hivemind knowledge',
        text: (r.text ?? r.content ?? r.chunk ?? '').slice(0, 1200),
        ref: r.id ?? r.ref ?? null,
      }))
      .filter((r) => r.text);
    log(`Hivemind grounding: ${items.length} chunk(s) for “${query.slice(0, 60)}”.`);
    return items.length ? items : null;
  } catch (err) {
    log(`Hivemind grounding unavailable: ${err.message}`);
    return null;
  }
}

export async function publishArtifact({ title, markdown, runId }, log = () => {}) {
  if (!BASE || !KEY) {
    log('Hivemind not connected — deliverable kept local only.');
    return null;
  }
  try {
    const data = await call(ARTIFACT_PATH, {
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
