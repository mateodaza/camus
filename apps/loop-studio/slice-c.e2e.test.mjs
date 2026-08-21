// Hermetic Slice C acceptance: real Studio live engine + production HTTP
// adapters + a loopback OpenAI-compatible fixture. No vendor CLI and no
// external network. The only mocked boundary is the provider endpoint itself.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const temp = mkdtempSync(join(tmpdir(), 'camus-slice-c-e2e-'));
const runsDir = join(temp, 'runs');
const modelsFile = join(temp, 'models.json');
const studioState = join(temp, 'studio-state');
const requests = [];

const MAKER_MODEL = 'qwen3-coder';
const REVIEWER_MODEL = 'grok-local-auditor';
const ACCEPTANCE = 'The final deliverable explicitly states that the exact maker and auditor seats completed the run.';
const DRAFT = `# Exact-seat result

## Result

The exact declared maker and auditor seats completed this run, and the receipt records both qualifications without substitution.`;

const reviewJson = (coverage = false) => JSON.stringify({
  verdict: 'clean',
  findings: [],
  questions_for_human: [],
  claim_assessments: [],
  coverage_assessments: coverage
    ? [{ criterion_id: 'C1', decision: 'met', evidence: 'The Result section explicitly states that the exact declared maker and auditor seats completed the run.' }]
    : [],
  threshold_assessments: [],
});

const sse = (model, text, promptTokens) => [
  `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 16 } })}\n\n`,
  'data: [DONE]\n\n',
].join('');

const provider = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    requests.push({ method: 'GET', url: req.url, authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: MAKER_MODEL, context_length: 131072 },
      { id: REVIEWER_MODEL, context_length: 131072 },
    ] }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const prompt = String(body.messages?.[0]?.content ?? '');
    const model = body.model;
    requests.push({ method: 'POST', url: req.url, model, authorization: req.headers.authorization ?? null, prompt: prompt.slice(0, 100) });
    const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1];
    const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1];
    let text;
    if (head && tail) text = `${head} ${tail}`;
    else if (/^Capability probe\./.test(prompt) && /review schema/.test(prompt)) text = reviewJson(false);
    else if (/^Capability probe\./.test(prompt)) text = 'Streaming liveness demonstrated.';
    else if (model === REVIEWER_MODEL) text = reviewJson(true);
    else if (/planning a research deliverable/.test(prompt)) text = '- Confirm the exact seats\n- Produce a concise result\n- Preserve receipt evidence\n- Risk: identity substitution';
    else text = DRAFT;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(sse(model, text, head && tail ? 100_000 : 512));
  });
});

await new Promise((resolve) => provider.listen(0, HOST, resolve));
const providerPort = provider.address().port;
writeFileSync(modelsFile, `${JSON.stringify({
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  connections: {
    local_qwen: { kind: 'loopback', port: providerPort, basePath: '/v1' },
    local_grok: { kind: 'loopback', port: providerPort, basePath: '/v1' },
  },
  backends: {
    qwen_local: {
      kind: 'openai_compat', provider: 'local_alibaba', connection: 'local_qwen', protocol: 'chat_completions',
      trainingOrg: 'alibaba', modelFamily: 'qwen', derivedFrom: null, inferenceOperator: 'self_hosted',
      auth: { kind: 'none' }, models: [MAKER_MODEL], seats: ['maker'],
    },
    grok_local: {
      kind: 'openai_compat', provider: 'local_xai', connection: 'local_grok', protocol: 'chat_completions',
      trainingOrg: 'xai', modelFamily: 'grok', derivedFrom: null, inferenceOperator: 'self_hosted',
      auth: { kind: 'none' }, models: [REVIEWER_MODEL], seats: ['reviewer'],
    },
  },
}, null, 2)}\n`);

const studio = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh',
    STUDIO_RUNS_DIR: runsDir, STUDIO_MODELS_FILE: modelsFile,
    STUDIO_GRANDFATHER_DIR: studioState, STUDIO_CAPABILITY_DIR: join(studioState, 'capabilities'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
studio.stderr.on('data', (data) => process.stderr.write(`[slice-c studio] ${data}`));
let base = '';
for await (const chunk of studio.stdout) {
  const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (match) { base = `http://${HOST}:${match[1]}`; break; }
}
assert.ok(base, 'Studio announced its ephemeral port');

const post = (path, token, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': token },
  body: JSON.stringify(body),
});

try {
  const status = await (await fetch(`${base}/api/status`)).json();
  const token = status.token;

  const before = await (await fetch(`${base}/api/config`)).json();
  const makerBefore = before.seats.maker.find((entry) => entry.backend === 'qwen_local' && entry.model === MAKER_MODEL);
  const reviewerBefore = before.seats.reviewer.find((entry) => entry.backend === 'grok_local' && entry.model === REVIEWER_MODEL);
  assert.equal(makerBefore.admission.qualified, false, 'declared maker starts disabled');
  assert.equal(reviewerBefore.admission.qualified, false, 'declared reviewer starts disabled');

  const refusedSave = await post('/api/config', token, { maker: { backend: 'qwen_local', model: MAKER_MODEL } });
  assert.equal(refusedSave.status, 400, 'config save refuses before qualification');
  const refusedRun = await post('/api/runs', token, {
    goal: 'Run the exact local open-model pairing and preserve its provenance.',
    acceptanceContract: ACCEPTANCE, lane: 'freeform',
    pairing: { maker: { backend: 'qwen_local', model: MAKER_MODEL }, reviewer: { backend: 'grok_local', model: REVIEWER_MODEL } },
  });
  assert.equal(refusedRun.status, 400, 'launch refuses before qualification');

  const makerQual = await (await post('/api/qualifications', token, { seat: 'maker', backend: 'qwen_local', model: MAKER_MODEL })).json();
  assert.equal(makerQual.qualified, true, makerQual.reason);
  const stillRefused = await post('/api/runs', token, {
    goal: 'Run the exact local open-model pairing and preserve its provenance.',
    acceptanceContract: ACCEPTANCE, lane: 'freeform',
    pairing: { maker: { backend: 'qwen_local', model: MAKER_MODEL }, reviewer: { backend: 'grok_local', model: REVIEWER_MODEL } },
  });
  assert.equal(stillRefused.status, 400, 'one seat receipt cannot admit the other seat');
  const reviewerQual = await (await post('/api/qualifications', token, { seat: 'reviewer', backend: 'grok_local', model: REVIEWER_MODEL })).json();
  assert.equal(reviewerQual.qualified, true, reviewerQual.reason);

  const after = await (await fetch(`${base}/api/config`)).json();
  const makerAfter = after.seats.maker.find((entry) => entry.backend === 'qwen_local' && entry.model === MAKER_MODEL);
  const reviewerAfter = after.seats.reviewer.find((entry) => entry.backend === 'grok_local' && entry.model === REVIEWER_MODEL);
  assert.equal(makerAfter.admission.qualified, true);
  assert.equal(reviewerAfter.admission.qualified, true);
  assert.match(makerAfter.admission.fingerprint, /^qual1:/);
  assert.match(reviewerAfter.admission.fingerprint, /^qual1:/);

  const saved = await post('/api/config', token, {
    maker: { backend: 'qwen_local', model: MAKER_MODEL },
    reviewer: { backend: 'grok_local', model: REVIEWER_MODEL },
  });
  assert.equal(saved.status, 200, 'only after both exact tuples qualify can the standing pairing save');

  const started = await post('/api/runs', token, {
    goal: 'Run the exact local open-model pairing and preserve its provenance.',
    acceptanceContract: ACCEPTANCE, lane: 'freeform', publish: false,
  });
  assert.equal(started.status, 201, `qualified standing pairing launches (${started.status}: ${await started.clone().text()})`);
  const { id } = await started.json();

  let report = null;
  for (let attempt = 0; attempt < 100 && !report; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(`${base}/api/runs/${id}/report`);
    if (response.ok) report = await response.json();
  }
  assert.ok(report, 'the real adapter loop sealed a report');
  assert.ok(['done', 'done_with_findings'].includes(report.status), report.error ?? report.status);
  assert.equal(report.publishRequested, false, 'publication remained explicitly off');
  assert.equal(report.receiptsDegraded, false, report.receiptsNote);

  const runMeta = JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8'));
  const makerFingerprint = runMeta.models.maker.qualification.fingerprint;
  const reviewerFingerprint = runMeta.models.reviewer.qualification.fingerprint;
  assert.equal(makerFingerprint, makerAfter.admission.fingerprint, 'maker receipt is frozen into the run snapshot unchanged');
  assert.equal(reviewerFingerprint, reviewerAfter.admission.fingerprint, 'reviewer receipt is frozen into the run snapshot unchanged');
  assert.equal(runMeta.models.maker.qualification.seatType, 'words_maker');
  assert.equal(runMeta.models.reviewer.qualification.seatType, 'words_reviewer');

  const eventLines = readFileSync(join(runsDir, id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const round = eventLines.find((event) => event.type === 'round');
  const review = eventLines.find((event) => event.type === 'review');
  assert.equal(round.qualifications.maker.fingerprint, makerFingerprint);
  assert.equal(round.qualifications.reviewer.fingerprint, reviewerFingerprint);
  assert.equal(review.executorQualification.fingerprint, makerFingerprint);
  assert.equal(review.auditorQualification.fingerprint, reviewerFingerprint);

  const pack = report.evidencePack;
  assert.equal(pack.schemaVersion, 3, 'the qualified observed run earns envelope 3');
  assert.equal(pack.pairing.schemaVersion, 2);
  assert.equal(pack.pairing.executor.qualification.fingerprint, makerFingerprint);
  assert.equal(pack.pairing.auditor.qualification.fingerprint, reviewerFingerprint);
  assert.equal(pack.pairing.executor.actual, `local_alibaba:${MAKER_MODEL}`);
  assert.equal(pack.pairing.auditor.actual, `local_xai:${REVIEWER_MODEL}`);
  assert.equal(pack.pairing.executor.reported, MAKER_MODEL);
  assert.equal(pack.pairing.auditor.reported, REVIEWER_MODEL);
  assert.equal(pack.pairing.executor.actual_evidence, 'observed_api_response');
  assert.equal(pack.pairing.auditor.actual_evidence, 'observed_api_response');
  assert.equal(pack.pairing.executor.lineage.source, 'operator_declared');
  assert.equal(pack.pairing.auditor.lineage.source, 'operator_declared');
  assert.equal(pack.pairing.independence, 'cross_vendor_declared');
  assert.equal(pack.statuses.audit, 'declared_clean');
  assert.ok(pack.artifact.contract_coverage.every((criterion) => criterion.decision === 'met'));
  assert.ok(requests.every((request) => request.authorization === null), 'keyless loopback never emits Authorization');
  assert.ok(requests.some((request) => request.method === 'POST' && request.model === MAKER_MODEL));
  assert.ok(requests.some((request) => request.method === 'POST' && request.model === REVIEWER_MODEL));
} finally {
  studio.kill('SIGKILL');
  await once(studio, 'close').catch(() => {});
  provider.close();
  await once(provider, 'close').catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}

console.log('slice-c.e2e.test: all assertions passed');
