// Hermetic API test for Slice E's fetch-streamed qualification UI contract.
// The only network peer is this process's loopback OpenAI-compatible fixture;
// no vendor credential or provider is reachable.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'camus-qualification-api-'));
const modelId = 'served-local-model';
const review = JSON.stringify({
  verdict: 'clean', findings: [], questions_for_human: [],
  claim_assessments: [], coverage_assessments: [], threshold_assessments: [],
});
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

const endpoint = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: modelId, context_length: 32768 }] }));
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    return res.end();
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const prompt = String(body.messages?.[0]?.content || '');
    let text = 'live';
    if (/review schema/.test(prompt)) text = review;
    if (/context envelope/.test(prompt)) {
      const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1];
      const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1];
      text = `${head} ${tail}`;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ model: modelId, choices: [{ delta: { content: text } }] }));
    res.write(event({ model: modelId, choices: [], usage: { prompt_tokens: 9000, completion_tokens: 8 } }));
    res.end('data: [DONE]\n\n');
  });
});

await new Promise((resolve, reject) => {
  endpoint.once('error', reject);
  endpoint.listen(0, HOST, resolve);
});
const endpointPort = endpoint.address().port;
const modelsFile = join(tmp, 'models.json');
writeFileSync(modelsFile, JSON.stringify({
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  connections: {
    local_fixture: { kind: 'loopback', port: endpointPort, basePath: '/v1', why: 'hermetic API fixture' },
  },
  backends: {
    local_fixture: {
      kind: 'openai_compat', provider: 'fixture', connection: 'local_fixture', protocol: 'chat_completions',
      trainingOrg: 'fixture', modelFamily: 'fixture', derivedFrom: null, inferenceOperator: 'self_hosted',
      auth: { kind: 'none' }, models: [modelId], seats: ['reviewer'], why: 'hermetic API fixture',
    },
  },
}, null, 2));
const codexCache = join(tmp, 'codex-cache.json');
writeFileSync(codexCache, JSON.stringify({ models: [{ slug: 'gpt-5.4-mini', visibility: 'list' }] }));

const studio = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    ENGINE: 'live', OPEN: '0', PORT: '0', STUDIO_MODELS_FILE: modelsFile,
    STUDIO_CODEX_CACHE_FILE: codexCache, STUDIO_RUNS_DIR: join(tmp, 'runs'),
    STUDIO_GRANDFATHER_DIR: join(tmp, 'state'),
    STUDIO_CAPABILITY_DIR: join(tmp, 'capabilities'),
    STUDIO_CONTROL_DIR: join(tmp, 'control-actions'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
studio.stderr.on('data', (data) => process.stderr.write(`[qualification-api server] ${data}`));

let base = '';
for await (const chunk of studio.stdout) {
  const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (match) { base = `http://${HOST}:${match[1]}`; break; }
}

try {
  assert.ok(base, 'Studio announced a port');
  const status = await (await fetch(`${base}/api/status`)).json();
  const response = await fetch(`${base}/api/qualifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-token': status.token },
    body: JSON.stringify({ seat: 'reviewer', backend: 'local_fixture', model: modelId, stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /event: progress/);
  assert.match(body, /"phase":"streaming","status":"demonstrated"/);
  const terminal = /event: result\ndata: ([^\n]+)/.exec(body);
  assert.ok(terminal, 'the stream has one terminal result');
  const result = JSON.parse(terminal[1]);
  assert.equal(result.qualified, true, result.reason);
  assert.equal(result.controlRoute.decision, 'auto');
  assert.equal(readdirSync(join(tmp, 'capabilities')).length, 1, 'qual1 receipt written');
  assert.equal(readdirSync(join(tmp, 'control-actions')).length, 1, 'human-bound control receipt written');
  console.log('qualification-api.test.mjs: streamed hermetic qualification passed');
} finally {
  studio.kill('SIGKILL');
  await once(studio, 'close').catch(() => {});
  await new Promise((resolve) => endpoint.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
}
