// Deterministic-verifier self-test: seeds a document with one of every sin and
// asserts each check catches it, then asserts a clean document passes.
// Network-free (skipNetwork) so it runs anywhere, fast.

import assert from 'node:assert/strict';
import { runVerify, findUnsourcedStats, findComplianceHits, extractUrls } from './lib/verify.mjs';

const BAD = `## Summary
Community programs produce guaranteed returns for every launch. Apps with active communities retain 61% more of their monthly actives.

## Key Findings
1. Token ads are restricted on major platforms, so CAC is up 3x this cycle.

## Sources
1. Some report — https://example.com/report
`;

const GOOD = `## Summary
Community-led growth compounds where paid cannot. Retention differs by cohort origin [1].

## Key Findings
1. Platform ad policy restricts most token creative, raising acquisition costs [1].
2. Community-originated cohorts decay slower than airdrop cohorts [2].

## Sources
1. State of Crypto — https://a16zcrypto.com
2. Developer Report — https://www.developerreport.com
`;

// --- unit: unsourced stats -------------------------------------------------
{
  const offenders = findUnsourcedStats(BAD);
  assert.ok(offenders.some((s) => s.includes('61%')), 'catches uncited percentage');
  assert.ok(offenders.some((s) => s.includes('3x')), 'catches uncited multiple');
  assert.equal(findUnsourcedStats(GOOD).length, 0, 'cited stats pass');

  // Audit regression: a leading bare year must not exempt the stat behind it.
  assert.equal(findUnsourcedStats('In 2024, retention rose 61% across cohorts.').length, 1, 'year-first sentence still flagged');
  assert.equal(findUnsourcedStats('The program launched in 2024.').length, 0, 'bare year alone is not a claim');
  assert.equal(findUnsourcedStats('In 2024, retention rose 61% across cohorts [1].').length, 0, 'cited year-first stat passes');
}

// --- unit: compliance -------------------------------------------------------
{
  const hits = findComplianceHits(BAD);
  assert.ok(hits.some((h) => h.label === 'Guaranteed returns claim' && h.severity === 'fail'), 'catches guaranteed returns');
  assert.equal(findComplianceHits(GOOD).filter((h) => h.severity === 'fail').length, 0, 'clean copy passes compliance');
}

// --- unit: url extraction ----------------------------------------------------
{
  const urls = extractUrls(GOOD);
  assert.ok(urls.includes('https://a16zcrypto.com'), 'extracts bare source URLs');
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
}

// --- gate: structure + citations, network skipped ----------------------------
{
  const bad = await runVerify(BAD, 'research_memo', { skipNetwork: true });
  assert.equal(bad.pass, false, 'bad doc fails the gate');
  const byId = Object.fromEntries(bad.checks.map((c) => [c.id, c]));
  assert.equal(byId.stats.status, 'fail', 'stats check fails');
  assert.equal(byId.compliance.status, 'fail', 'compliance check fails');

  const missingSources = await runVerify(GOOD.replace(/## Sources[\s\S]*$/, ''), 'research_memo', { skipNetwork: true });
  const ms = Object.fromEntries(missingSources.checks.map((c) => [c.id, c]));
  assert.equal(ms.structure.status, 'fail', 'missing Sources section fails structure');
  assert.equal(ms.citations.status, 'fail', 'dangling [n] markers fail');

  const good = await runVerify(GOOD, 'research_memo', { skipNetwork: true });
  assert.equal(good.pass, true, `clean doc passes the gate (got: ${JSON.stringify(good.checks.filter((c) => c.status === 'fail'))})`);
}

// --- gate: [Hn] markers must map to Hivemind entries under Sources ----------
{
  const withDanglingH = GOOD.replace('slower than airdrop cohorts [2]', 'slower than airdrop cohorts [2][H1]');
  const bad = await runVerify(withDanglingH, 'research_memo', { skipNetwork: true });
  const cit = bad.checks.find((c) => c.id === 'citations');
  assert.equal(cit.status, 'fail', 'dangling [H1] fails');
  assert.ok(cit.detail.includes('[H1]'), 'dangling detail names the H marker');

  const withDefinedH = withDanglingH + '\n### Hivemind\n[H1] Community GTM playbook — Myosin network\n';
  const ok = await runVerify(withDefinedH, 'research_memo', { skipNetwork: true });
  assert.equal(ok.checks.find((c) => c.id === 'citations').status, 'pass', 'defined [H1] resolves');

  // A Sources entry must not vouch for itself: marker only in Sources, none in body.
  const srcOnly = GOOD + '\n[H2] Stray entry — nobody cites this\n';
  const cit2 = (await runVerify(srcOnly, 'research_memo', { skipNetwork: true })).checks.find((c) => c.id === 'citations');
  assert.equal(cit2.status, 'pass', 'unused Sources entries are not dangling markers');
}

// --- audit regression: a citation must bind to a checked URL -----------------
{
  const doc = `## Summary
Retention improved 61% [1]. Unrelated reading: https://example.com

## Key Findings
1. See above [1].

## Sources
1. Internal memo, Q3 planning meeting
`;
  const res = await runVerify(doc, 'freeform', { skipNetwork: true });
  const cit = res.checks.find((c) => c.id === 'citations');
  assert.equal(cit.status, 'fail', 'a source entry without a URL fails — an unrelated link cannot vouch for [1]');
  assert.ok(cit.detail.includes('no URL'), 'the reason names the missing URL');
  assert.equal(res.pass, false, 'the gate is red');
}

// --- gate: link classification against a local HTTP fixture ------------------
// No external network: an in-process server plays the four personalities the
// checker must distinguish — healthy, bot-blocked, dead, and HEAD-hostile.
{
  const { createServer } = await import('node:http');
  const fixture = createServer((req, res) => {
    if (req.url === '/ok') return res.writeHead(200).end('fine');
    if (req.url === '/blocked') return res.writeHead(403).end('bots go away');
    if (req.url === '/dead') return res.writeHead(404).end('gone');
    if (req.url === '/head405') {
      if (req.method === 'HEAD') return res.writeHead(405).end();
      return res.writeHead(200).end('GET works');
    }
    res.writeHead(500).end();
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const doc = (paths) => `Notes.\n\n${paths.map((p) => `- ${base}${p}`).join('\n')}\n`;
  const linksCheck = async (paths) =>
    (await runVerify(doc(paths), 'freeform', {})).checks.find((c) => c.id === 'links');

  const healthy = await linksCheck(['/ok', '/head405']);
  assert.equal(healthy.status, 'pass', 'HEAD 405 falls back to GET and passes');

  const blocked = await linksCheck(['/ok', '/blocked']);
  assert.equal(blocked.status, 'warn', '403 warns instead of failing');
  assert.ok(blocked.detail.includes('403'), 'warn detail names the status');

  const dead = await linksCheck(['/ok', '/dead']);
  assert.equal(dead.status, 'fail', '404 fails the gate');
  assert.ok(dead.detail.includes('404'), 'fail detail names the status');

  const deadBeatsBlocked = await linksCheck(['/blocked', '/dead']);
  assert.equal(deadBeatsBlocked.status, 'fail', 'a dead link outranks a blocked one');

  fixture.close();
}

// --- hivemind MCP adapter against a local fixture ----------------------------
// The fixture mirrors the hive-mind /api/mcp contract: stateless streamable
// HTTP, x-api-key auth, every response SSE-framed, knowledge_search results
// JSON-stringified into content[0].text.
{
  const { createServer } = await import('node:http');
  const CHUNKS = [
    { chunk_id: 'c-1', title: 'Onchain GTM Stack', author: 'Tridog', content: 'Build community first, then raise capital.', score: 0.8, relevance: '80%' },
    { chunk_id: 'c-2', title: 'Founder-led Marketing', author: 'Greg', content: 'In crypto, narrative is market share.', score: 0.5, relevance: '50%' },
  ];
  const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
  const fixture = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/mcp') return res.writeHead(405).end();
    if (req.headers['x-api-key'] !== 'hm_k_test') return res.writeHead(401).end('{"error":"unauthorized"}');
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.method === 'notifications/initialized') return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (msg.method === 'initialize') {
      return res.end(sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'hivemind', version: '0.1.0' } } }));
    }
    if (msg.method === 'tools/call' && msg.params.name === 'knowledge_search') {
      const payload = { success: true, data: { chunks: CHUNKS, total_results: 2, query: msg.params.arguments.query } };
      return res.end(sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }));
    }
    res.end(sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fixture.address().port}`;

  process.env.HIVEMIND_MCP_URL = origin; // bare origin — adapter must append /api/mcp
  process.env.HIVEMIND_API_KEY = 'hm_k_test';
  const { searchKnowledge, hivemindStatus } = await import('./lib/adapters/hivemind.mjs');

  assert.deepEqual(hivemindStatus(), { connected: true, mode: 'mcp', base: `${origin}/api/mcp` }, 'status reports mcp mode');
  const logs = [];
  const items = await searchKnowledge('community vs paid', 4, (l) => logs.push(l));
  assert.equal(items.length, 2, 'maps both chunks');
  assert.equal(items[0].title, 'Onchain GTM Stack — Tridog', 'title carries author');
  assert.equal(items[0].ref, 'c-1', 'ref is chunk_id');
  assert.equal(items[0].score, 0.8, 'score preserved');
  assert.ok(logs[0].includes('via mcp'), 'log names the transport');

  // Wrong key → adapter degrades to ungrounded, never throws into the loop.
  process.env.HIVEMIND_API_KEY = 'hm_k_wrong';
  const denied = await searchKnowledge('anything', 4, () => {});
  assert.equal(denied, null, '401 degrades to ungrounded');

  delete process.env.HIVEMIND_MCP_URL;
  delete process.env.HIVEMIND_API_KEY;
  fixture.close();
}

// --- hivemind via-claude mode: no key, grounding delegated to the maker ------
{
  process.env.HIVEMIND_VIA_CLAUDE = '1';
  const { searchKnowledge, hivemindStatus, viaClaude } = await import('./lib/adapters/hivemind.mjs');
  const { makePrompt, fixPrompt } = await import('./lib/prompts.mjs');

  const st = hivemindStatus();
  assert.equal(st.mode, 'claude', 'mode is claude');
  assert.ok(st.base.endsWith('/api/mcp'), 'base points at an /api/mcp endpoint');
  assert.deepEqual(viaClaude(), { enabled: true, url: st.base, serverName: 'hivemind' }, 'viaClaude exposes the wiring');

  const marker = await searchKnowledge('anything', 4, () => {});
  assert.equal(marker, 'claude', 'retrieval is delegated, not performed');

  const mk = makePrompt({ goal: 'g', lane: 'research_memo', depth: 'quick', grounding: 'claude', answers: [] });
  assert.ok(mk.includes('mcp__hivemind__knowledge_search'), 'make prompt names the MCP tool');
  assert.ok(mk.includes('never fabricate'), 'make prompt forbids fabricated [Hn]');
  const fx = fixPrompt({ goal: 'g', lane: 'research_memo', draft: 'd', findings: [], answers: [], viaClaude: true });
  assert.ok(fx.includes('mcp__hivemind__knowledge_search'), 'fix prompt keeps the tool available');

  delete process.env.HIVEMIND_VIA_CLAUDE;
}

// --- normalizeReview: no path from broken reviewer output to a verdict -------
{
  const { normalizeReview } = await import('./lib/adapters/codex.mjs');
  const infra = (raw, code, why) => assert.equal(normalizeReview(raw, code).ran, false, why);

  infra('', 0, 'empty output is infra');
  infra('not json', 0, 'unparseable is infra');
  infra('[]', 0, 'non-object is infra');
  infra('{"verdict":"approve","findings":[],"questions_for_human":[]}', 0, 'unknown verdict is infra');
  infra(JSON.stringify({ verdict: 'clean', findings: [{ severity: 'high', title: 'x', detail: 'd', suggestion: 's' }], questions_for_human: [] }), 0,
    'clean-with-blocking is infra, never APPROVED');
  infra(JSON.stringify({ verdict: 'revise', findings: [], questions_for_human: [] }), 0,
    'revise with nothing actionable is infra');
  infra(JSON.stringify({ verdict: 'revise', findings: [{ severity: 'critical', title: 'x', detail: 'd', suggestion: 's' }], questions_for_human: [] }), 0,
    'unknown severity is infra');
  infra(JSON.stringify({ verdict: 'clean', findings: [], questions_for_human: [] }), 1, 'nonzero exit is infra even with valid JSON');

  const clean = normalizeReview(JSON.stringify({ verdict: 'clean', findings: [{ severity: 'low', title: 'nit', detail: 'd', suggestion: 's' }], questions_for_human: ['', '  ', 'real?'] }), 0);
  assert.equal(clean.ran, true);
  assert.equal(clean.verdict, 'APPROVED', 'clean + low only approves');
  assert.equal(clean.nonblocking.length, 1, 'low is nonblocking');
  assert.deepEqual(clean.questions, ['real?'], 'blank questions filtered');

  const fenced = normalizeReview('```json\n{"verdict":"revise","findings":[{"severity":"medium","title":"t","detail":"d","suggestion":"s"}],"questions_for_human":[]}\n```', 0);
  assert.equal(fenced.ran, true, 'fenced JSON still parses');
  assert.equal(fenced.blocking.length, 1);
}

// --- engine harness: stop rules, containment, and answer integrity -----------
{
  const { runLoop } = await import('./lib/engine.mjs');

  // Drafts verify offline: freeform lane, no URLs (warn, not fail).
  const CLEAN_DRAFT = 'Notes.\n\nCommunity first, paid second.\n';
  const BAD_DRAFT = 'Notes.\n\nRetention rose 61% across cohorts.\n'; // uncited stat → deterministic fail

  function harness({ claudeQueue, codexQueue, answerQueue, abortOnAsk = false }) {
    const events = [];
    const prompts = { claude: [], codex: [] };
    const published = [];
    const abort = new AbortController();
    const review = (verdict, findings = [], questions = []) => ({
      ran: true, error: null,
      verdict, findings,
      blocking: findings.filter((f) => f.severity !== 'low'),
      nonblocking: findings.filter((f) => f.severity === 'low'),
      questions,
    });
    const ctx = {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async (q) => {
        events.push({ type: '_asked', kind: q.kind, options: q.options ?? null });
        if (abortOnAsk) abort.abort();
        const next = answerQueue.shift();
        if (next === undefined) throw new Error(`no scripted answer for: ${q.text}`);
        return next;
      },
      adapters: {
        claude: async ({ prompt }) => {
          prompts.claude.push(prompt);
          const next = claudeQueue.shift();
          if (next === undefined) throw new Error('claude called more times than scripted');
          return { ok: true, error: null, text: next, costUsd: 0 };
        },
        codex: async ({ prompt }) => {
          prompts.codex.push(prompt);
          const next = codexQueue.shift();
          if (next === undefined) throw new Error('codex called more times than scripted');
          return next;
        },
      },
      hivemind: {
        searchKnowledge: async () => null,
        publishArtifact: async (a) => { published.push(a); return { published: true, url: null }; },
        hivemindStatus: () => ({ connected: false, mode: 'stub', base: null }),
      },
      signal: abort.signal,
      scratchDir: '.',
      receiptsDir: 'runs/_engine-test',
    };
    const run = { id: 'engine-test', goal: 'test goal', lane: 'freeform', depth: 'quick', ground: false };
    return { run: () => runLoop(run, ctx), events, prompts, published, review, abort };
  }

  const f = (severity, title) => ({ severity, title, detail: 'd', suggestion: 's' });
  const review = harness({ claudeQueue: [], codexQueue: [], answerQueue: [] }).review;

  // --- Case A: verify containment (approve r1, bad draft, ship-anyway) ---
  {
    const h4 = harness({
      claudeQueue: ['- plan', BAD_DRAFT, BAD_DRAFT], // plan, make, ONE verify-fix (still bad)
      codexQueue: [review('APPROVED')],
      answerQueue: ['Ship anyway (recorded as verify_failed)'],
    });
    const res = await h4.run();
    assert.equal(res.status, 'verify_failed', 'ship-anyway records verify_failed');
    assert.equal(h4.published.length, 0, 'a red is never published');
    const verifyAsk = h4.events.find((e) => e.type === '_asked' && e.kind === 'verify');
    assert.ok(verifyAsk, 'verify override question asked');
    assert.equal(h4.prompts.claude.length, 3, 'exactly one verify-fix pass before the human (budget=1)');
    assert.ok(res.answers.some((a) => a.kind === 'verify' && a.answer.startsWith('Ship anyway')), 'override recorded with kind');
    assert.ok(!h4.events.some((e) => e.type === 'status' && (e.status === 'done' || e.status === 'done_with_findings')), 'no green status ever emitted');
  }

  // --- Case B: verify fail → fix succeeds → done, publish exactly once ---
  {
    const h5 = harness({
      claudeQueue: ['- plan', BAD_DRAFT, CLEAN_DRAFT],
      codexQueue: [review('APPROVED')],
      answerQueue: [],
    });
    const res = await h5.run();
    // Freeform drafts with no URLs verify green WITH caveats (links warn,
    // structure/citations skip) — and caveats are never hidden as plain done.
    assert.equal(res.status, 'done_with_findings', 'fixable red ends green-with-caveats');
    assert.equal(h5.published.length, 1, 'published exactly once');
  }

  // --- Case C: done_with_findings lanes ---
  {
    // C1: APPROVED with a low finding → done_with_findings
    const h6 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT],
      codexQueue: [review('APPROVED', [f('low', 'nit')])],
      answerQueue: [],
    });
    assert.equal((await h6.run()).status, 'done_with_findings', 'approved-with-lows is not a plain done');

    // C2: stuck (same title twice) → accept → done_with_findings
    const h7 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'Retention figure has no source.')]),
        review('REVISE', [f('high', 'retention figure has NO source')]), // case/punct differ — same key
      ],
      answerQueue: ['Accept and ship (with findings on record)'],
    });
    const res7 = await h7.run();
    assert.equal(res7.status, 'done_with_findings', 'stuck-accept is done_with_findings');
    const stuckAsk = h7.events.find((e) => e.type === '_asked' && e.kind === 'stuck');
    assert.ok(stuckAsk, 'stuck card fired on normalized-title repeat');

    // C3: fresh titles every round → round cap card at ROUND_CAP, accept
    const h8 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'A')]),
        review('REVISE', [f('high', 'B')]),
        review('REVISE', [f('high', 'C')]),
      ],
      answerQueue: ['Accept and ship (with findings on record)'],
    });
    const res8 = await h8.run();
    assert.equal(res8.status, 'done_with_findings', 'cap-accept is done_with_findings');
    assert.equal(h8.prompts.codex.length, 3, 'review ran exactly ROUND_CAP times');
    const capAsk = h8.events.filter((e) => e.type === '_asked' && e.kind === 'stuck');
    assert.equal(capAsk.length, 1, 'exactly one human prompt on the final round (no double-fire)');
    assert.equal(capAsk[0].options.length, 2, 'final-round card offers no "one more round"');
  }

  // --- Case D: oscillation A → B → A halts ---
  {
    const h9 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'A')]),
        review('REVISE', [f('high', 'B')]),
        review('REVISE', [f('high', 'A')]), // returns after vanishing
      ],
      answerQueue: ['Stop the run'],
    });
    const res9 = await h9.run();
    assert.equal(res9.status, 'stopped', 'human stopped at the oscillation card');
    assert.ok(h9.events.some((e) => e.type === '_asked' && e.kind === 'stuck'), 'oscillating finding halts');
  }

  // --- Case E: answer threading + process/content separation ---
  {
    const h10 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'Unanchored')], ['Base-first or multichain?']),
        review('APPROVED'),
      ],
      answerQueue: ['Base-first.'],
    });
    const res10 = await h10.run();
    assert.equal(res10.status, 'done_with_findings'); // freeform caveats, as above
    const fixPromptText = h10.prompts.claude[2]; // plan, make, fix
    assert.ok(fixPromptText.includes('Base-first.'), 'decision lands in the fix prompt');
    assert.ok(h10.prompts.codex[1].includes('Base-first.'), 'decision lands in the next review prompt');
    assert.ok(h10.prompts.codex[1].includes('do NOT re-raise'), 'reviewer told decisions are settled');
    assert.deepEqual(res10.answers.map((a) => a.kind), ['decision'], 'only the decision recorded');
  }

  // --- Case F: Stop during a pending question → stopped, nothing recorded, nothing published ---
  {
    const h11 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT],
      codexQueue: [review('APPROVED', [], ['Which audience?'])], // clean verdict + lingering question
      answerQueue: ['Stop the run'], // what the /stop handler resolves with
      abortOnAsk: true, // abort() fires before the answer resolves, like the real handler
    });
    const res11 = await h11.run();
    assert.equal(res11.status, 'stopped', 'stop during a question stops the run');
    assert.equal(h11.published.length, 0, 'nothing published after stop');
    assert.equal(res11.answers.length, 0, 'no fabricated decision in the receipts');
  }
}

// --- session-line parsers + runtime config resolution -------------------------
{
  const { sessionLineFromEvent } = await import('./lib/adapters/claude.mjs');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'crypto ad policy' } }] } }),
    'WebSearch: crypto ad policy', 'claude tool_use becomes a session line');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__hivemind__knowledge_search', input: { query: 'gtm' } }] } }),
    'knowledge_search: gtm', 'mcp prefix stripped');
  assert.equal(sessionLineFromEvent({ type: 'result', result: 'x' }), null, 'result events are not session lines');

  const { sessionLineFromCodexEvent } = await import('./lib/adapters/codex.mjs');
  assert.equal(
    sessionLineFromCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', summary: 'checking the claim' } })),
    'reasoning: checking the claim', 'codex reasoning surfaces');
  assert.ok(
    sessionLineFromCodexEvent(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })).includes('10 in / 2 out'),
    'token usage surfaces');
  assert.equal(sessionLineFromCodexEvent('not json'), null, 'garbage lines are silent');

  const { getModels } = await import('./lib/models.mjs');
  const m = getModels();
  assert.ok(m.maker.model && m.reviewer.model, 'models resolve from the decision record');
  assert.ok(m.loop.roundCap >= 1 && m.loop.roundCap <= 6, 'round cap resolves in range');
  process.env.ROUND_CAP = 'three';
  assert.equal(getModels().loop.roundCap, 3, 'NaN cap falls back to 3, never skips review');
  delete process.env.ROUND_CAP;
}

// --- build lane: spend-free refusals + fail-closed report parsing ------------
{
  const {
    validateBuildTarget,
    parseGateReport,
    gateArgsForRun,
    gateIgniterCliArgs,
    gateSupportsStudio,
    reviewEventFromGateReceipt,
    verifyEventFromGateReport,
  } = await import('./lib/code-lane.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');

  assert.equal((await validateBuildTarget('')).ok, false, 'empty path refused');
  assert.equal((await validateBuildTarget('~/no/such/dir-9x7q')).ok, false, 'missing dir refused');
  assert.ok((await validateBuildTarget('/tmp/evil"; rm -rf /')).error.includes('shell-unsafe'), 'shell-unsafe path refused');

  const plain = mkdtempSync(join(tmpdir(), 'cls-plain-'));
  assert.ok((await validateBuildTarget(plain)).error.includes('not a git repository'), 'non-git dir refused');

  const repo = mkdtempSync(join(tmpdir(), 'cls-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const good = await validateBuildTarget(repo);
  assert.equal(good.ok, true, 'clean git repo accepted');
  assert.ok(good.toplevel, 'toplevel resolved for the concurrency guard');

  execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
  assert.ok((await validateBuildTarget(repo)).error.includes('detached'), 'detached HEAD refused');
  rmSync(plain, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });

  // Report parsing: a run whose status we cannot read is NEVER done.
  assert.equal(parseGateReport('{"status":"done","commit":"a1f9c2e"}').status, 'done', 'clean JSON report parses');
  assert.equal(parseGateReport('The loop finished: status "done_with_findings", branch camus-wt-x.').status, 'done_with_findings', 'prose-wrapped status parses');
  assert.equal(parseGateReport('I made it work and everything looks great!').status, 'infra_error', 'no readable status is infra, never done');
  assert.equal(parseGateReport('').status, 'infra_error', 'empty output is infra');
  const q = parseGateReport('Paused. {"status":"needs_human","question":"Two callers expect different shapes. Which contract should win?"}');
  assert.equal(q.status, 'needs_human');
  assert.ok(q.question.includes('Which contract'), 'question extracted for the card');
  // done_with_findings must not be shadowed by its 'done' suffix
  assert.equal(parseGateReport('status: done_with_findings').status, 'done_with_findings', 'longest status wins');
  // Live-fire regression (2026-07-12): camus wraps statuses in backticks —
  // the studio misread a real green as infra_error until this passed.
  assert.equal(
    parseGateReport('**The Camus loop closed green: `done` — review clean in 1 round, deterministic verify passed.** The gated change sits on branch `camus/greet-x`.').status,
    'done', 'backtick-wrapped status parses (the real gate output shape)');
  assert.equal(parseGateReport('halted: [needs_human]').status, 'needs_human', 'bracket-wrapped status parses');

  const boundArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1' }, 3);
  assert.equal(boundArgs.identitySalt, 'studio-run-1', 'Studio binds standalone custody with identitySalt');
  assert.equal('idSalt' in boundArgs, false, 'Studio never impersonates camus-feat ownership');
  assert.equal('model' in boundArgs, false, 'no maker snapshot → no model pin (nothing invented)');
  const pinnedArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1', models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.4' } } }, 3);
  assert.equal(pinnedArgs.model, 'opus', 'the maker is pinned THROUGH the /camus-loop contract from the run-start snapshot, not the outer igniter');
  const igniterArgs = gateIgniterCliArgs('/camus-loop {}');
  assert.equal(igniterArgs.includes('--tools'), false, 'process-wide tools stay inherited so camus-loop child agents retain Bash/Read/Edit');
  assert.deepEqual(igniterArgs.slice(igniterArgs.indexOf('--allowedTools'), igniterArgs.indexOf('--allowedTools') + 2), ['--allowedTools', 'Workflow'], 'only the outer Workflow call is pre-approved');
  assert.ok(igniterArgs.includes('--append-system-prompt'), 'outer igniter receives the custody contract as system policy');
  assert.equal(gateSupportsStudio({ workflow: 'const STANDALONE_ID_SALT = x', worktreeGate: 'create|ensure|attach|resolve' }), true, 'new installed gate advertises both custody capabilities');
  assert.equal(gateSupportsStudio({ workflow: 'const ID_SALT = x', worktreeGate: 'create|attach|resolve' }), false, 'older installed gate is refused instead of silently ignoring identitySalt');

  // Live-fire regression (2026-07-13): gate reviews are envelopes. Reading
  // only root fields made a clean audit look like an unspecified revision and
  // let report.json claim completeness without carrying the verdict.
  const nestedReview = reviewEventFromGateReceipt({
    codex_parsed: {
      overall_correctness: 'patch is correct',
      overall_confidence_score: 0.99,
      overall_explanation: 'The patch and tests are correct.',
      findings: [],
    },
  }, 1);
  assert.equal(nestedReview.verdict, 'APPROVED', 'nested clean verdict normalizes for the UI and evidence');
  assert.equal(nestedReview.confidence, 0.99, 'review confidence survives normalization');
  assert.equal(nestedReview.source, 'camus_gate_review', 'review provenance is explicit');
  assert.equal(nestedReview.reviewerModel, null, 'no ran:true pin → reviewer model stays null (nothing invented)');
  const pinnedReview = reviewEventFromGateReceipt({ ran: true, reviewer_model: 'gpt-5.4', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(pinnedReview.reviewerModel, 'gpt-5.4', 'a review that ran carries the reviewer model it was pinned to');
  const unranPin = reviewEventFromGateReceipt({ ran: false, reviewer_model: 'gpt-5.4', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(unranPin.reviewerModel, null, 'a review that did not run never claims a reviewer identity');

  const nestedFinding = reviewEventFromGateReceipt({ codex_parsed: JSON.stringify({
    overall_correctness: 'patch is incorrect',
    findings: [{ priority: 1, title: 'Unsafe fallback', body: 'The fallback bypasses custody.', code_location: 'lib/x.mjs:9', confidence_score: 0.91 }],
  }) }, 2);
  assert.equal(nestedFinding.verdict, 'REVISE', 'stringified nested verdict also normalizes');
  assert.equal(nestedFinding.findings[0].severity, 'high', 'gate priority maps to Studio severity');
  assert.equal(nestedFinding.findings[0].detail, 'The fallback bypasses custody.', 'Codex body becomes receipt detail');

  const derivedVerify = verifyEventFromGateReport({ status: 'done', commit_sha: 'c92d002521e09bab', note: 'verify passed' });
  assert.equal(derivedVerify.pass, true, 'done carries the gate contract that deterministic verify passed');
  assert.equal(derivedVerify.source, 'gate_report_status', 'derived verification names its source');
  assert.equal(derivedVerify.warnings, null, 'unknown check counts stay unknown rather than becoming zero');
  assert.equal(verifyEventFromGateReport({ status: 'infra_error' }), null, 'infra does not fabricate a verification result');
}

// --- build lane: the outer igniter cannot fork or mutate custody ------------
{
  const { createGateCustodyGuard } = await import('./lib/gate-custody.mjs');
  const expected = { task: 't', targetPath: '/tmp/repo', policy: 'ask_on_ambiguity', roundCap: 3, identitySalt: 'studio-run-1' };
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

  const good = createGateCustodyGuard(expected);
  assert.equal(good.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ identitySalt: 'studio-run-1', roundCap: 3, policy: 'ask_on_ambiguity', targetPath: '/tmp/repo', task: 't' }) })), null, 'one fresh workflow with equivalent JSON args is accepted');
  assert.equal(good.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify(expected) })), null, 'same async workflow may resume with the same args');
  assert.equal(good.finish(), null, 'one bound workflow produces a valid custody trail');

  const dropped = createGateCustodyGuard(expected);
  assert.match(dropped.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ ...expected, identitySalt: undefined }) })), /args changed/, 'dropping identitySalt is refused before a second worktree can be trusted');

  const forked = createGateCustodyGuard(expected);
  forked.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  assert.match(forked.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) })), /second fresh/, 'a second fresh workflow is a custody breach even with identical args');

  const historical = createGateCustodyGuard(expected);
  historical.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  historical.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_old.js', resumeFromRunId: 'wf_old', args: JSON.stringify(expected) }));
  assert.match(historical.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ task: 't', targetPath: '/tmp/repo', policy: 'ask_on_ambiguity', roundCap: 3 }) })), /args changed/, 'the exact live-smoke failure — a fresh unsalted retry after resume — is stopped');

  const switched = createGateCustodyGuard(expected);
  switched.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  switched.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_a.js', resumeFromRunId: 'wf_a', args: JSON.stringify(expected) }));
  assert.match(switched.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_b.js', resumeFromRunId: 'wf_b', args: JSON.stringify(expected) })), /switched run identity/, 'resume cannot jump to another workflow run');

  const escaped = createGateCustodyGuard(expected);
  assert.match(escaped.inspect(tool('Bash', { command: 'git status' })), /non-Workflow/, 'the igniter cannot inspect or repair the repo itself');
  assert.match(createGateCustodyGuard(expected).finish(), /without one fresh/, 'prose without a workflow never becomes a gate result');
}

// --- gate: live link check (only when network is available) ------------------
if (process.env.TEST_NETWORK === '1') {
  const dead = GOOD + '\n3. Archive — https://github.com/Myosin-xyz/does-not-exist-archive\n';
  const res = await runVerify(dead.replace('[2]', '[2][3]').replace(/2\. Developer/, '2. Developer'), 'research_memo', {});
  const links = res.checks.find((c) => c.id === 'links');
  assert.equal(links.status, 'fail', 'dead link fails the gate');
}

// --- rehearsal honesty: no spend and no fabricated gate evidence ------------
{
  const previousMockSpeed = process.env.MOCK_SPEED;
  process.env.MOCK_SPEED = '0';
  const { createMockAdapters, runMockCodeLoop } = await import('./lib/adapters/mock.mjs');
  const adapters = createMockAdapters();
  const noop = () => {};
  const plan = await adapters.claude({ stage: 'plan', onTick: noop, onSession: noop });
  const draft = await adapters.claude({ stage: 'make', onTick: noop, onSession: noop });
  assert.equal(plan.costUsd, 0, 'rehearsal planning reports zero model spend');
  assert.equal(draft.costUsd, 0, 'rehearsal drafting reports zero model spend');

  const events = [];
  const result = await runMockCodeLoop(
    { goal: 'exercise the scripted build rehearsal', targetPath: '/tmp/real-looking-repository' },
    {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async () => 'Return an empty embedding set.',
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.report.simulated, true, 'gate report is explicitly simulated');
  assert.equal(result.report.branch, null, 'rehearsal invents no branch identifier');
  assert.equal(result.report.commit, null, 'rehearsal invents no commit identifier');
  assert.equal(result.report.report, null, 'rehearsal invents no gate receipt path');
  assert.ok(result.report.note.includes('local simulation trace'), 'report distinguishes the local trace from gate evidence');
  assert.equal(result.costUsd, 0, 'sealed rehearsal report records zero model spend');
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'done' && e.costUsd === 0), 'terminal rehearsal status keeps spend at zero');
  if (previousMockSpeed === undefined) delete process.env.MOCK_SPEED;
  else process.env.MOCK_SPEED = previousMockSpeed;
}

// --- evidence trail + honest receipt completeness ---------------------------
// The receipt must CARRY what was contested (findings, rounds, revisions,
// human decisions) and tell the truth about its own gaps.
{
  const { deriveEvidence, receiptCompleteness } = await import('./lib/evidence.mjs');

  const wordsEvents = [
    { type: 'plan', text: 'the plan' },
    { type: 'round', round: 1, cap: 3 },
    { type: 'finding', severity: 'high', title: 'no source', detail: 'd', suggestion: 's' },
    { type: 'review', round: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'no source', detail: 'd', suggestion: 's' }] },
    { type: 'revision', rev: 1, markdown: '# draft one' },
    { type: 'answer', kind: 'decision', question: 'q?', answer: 'a' },
    { type: 'review', round: 2, verdict: 'APPROVED', findings: [] },
    { type: 'revision', rev: 2, markdown: '# draft two, longer' },
    { type: 'verify_result', pass: true, warnings: 1, skipped: 0 },
  ];
  const wev = deriveEvidence(wordsEvents);
  assert.equal(wev.plan, 'the plan');
  assert.equal(wev.rounds.length, 2, 'both review rounds captured in the receipt');
  assert.equal(wev.rounds[0].findings[0].title, 'no source', 'findings ride their round — not dropped from the receipt');
  assert.equal(wev.findings.length, 1, 'flat findings list captured');
  assert.deepEqual(wev.revisions.map((r) => r.rev), [1, 2], 'the whole revision trail is on the receipt');
  assert.equal(wev.verify[0].pass, true, 'deterministic verify result captured');
  assert.equal(wev.humanDecisions[0].answer, 'a', 'the human decision is on the receipt');
  assert.equal(receiptCompleteness({ lane: 'research_memo', evidence: wev, writeFailed: false }).degraded, false, 'a full words receipt is not degraded');

  // Developer-role P0: a build ignition that produced no round and no gate
  // report must NOT claim a trustworthy receipt.
  const empty = deriveEvidence([{ type: 'log', line: 'Igniting the camus gate' }, { type: 'status', status: 'stopped' }]);
  assert.equal(empty.gateReport, null);
  assert.equal(empty.rounds.length, 0);
  const emptyC = receiptCompleteness({ lane: 'build', evidence: empty, writeFailed: false });
  assert.equal(emptyC.degraded, true, 'a gate ignition with no round and no report is degraded, not clean');
  assert.match(emptyC.note, /nothing here to verify/);
  const emptyWordsC = receiptCompleteness({ lane: 'research_memo', evidence: empty, writeFailed: false });
  assert.equal(emptyWordsC.degraded, true, 'a words run with no independent review round is also degraded');

  // A successful build receipt needs the structured independent verdict,
  // verification result, and bound commit — terminal prose alone is not proof.
  const incompleteDone = deriveEvidence([
    { type: 'round', round: 1, cap: 3 },
    { type: 'gate_report', report: { status: 'done', branch: 'x', commit_sha: 'c92d002521e09bab' } },
  ]);
  const incompleteDoneC = receiptCompleteness({ lane: 'build', evidence: incompleteDone, writeFailed: false });
  assert.equal(incompleteDoneC.degraded, true, 'done without the structured audit and verify evidence is degraded');
  assert.match(incompleteDoneC.note, /independent review verdict/);
  assert.match(incompleteDoneC.note, /green verification bound/);

  const good = deriveEvidence([
    { type: 'round', round: 1, cap: 3 },
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', confidence: 0.99, source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, warnings: null, skipped: null, source: 'gate_report_status', derived: true, commitSha: 'c92d002521e09bab' },
    { type: 'gate_report', report: { status: 'done', branch: 'x', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(good.rounds[0].rawVerdict, 'patch is correct', 'raw auditor semantics survive evidence derivation');
  assert.equal(good.verify[0].warnings, null, 'unknown verification counts survive as null');
  assert.equal(receiptCompleteness({ lane: 'build', evidence: good, writeFailed: false }).degraded, false, 'a fully bound build receipt is complete');

  // Completeness must agree with the sealed dimensions (audit found these): a
  // receipt cannot read complete while the dimensions say the audit broke or
  // verification never applied.
  const atu = deriveEvidence([
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', source: 'camus_gate_review', findings: [] },
    { type: 'review', round: 2, verdict: 'UNKNOWN', rawVerdict: null, source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, source: 'gate_report_status', commitSha: 'c92d002521e09bab' },
    { type: 'gate_report', report: { status: 'done', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(receiptCompleteness({ lane: 'build', evidence: atu, writeFailed: false }).degraded, true, 'APPROVED then UNKNOWN is a broken audit — the receipt is not complete');

  const wrongSha = deriveEvidence([
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, source: 'gate_report_status', commitSha: 'deadbeef00000000' },
    { type: 'gate_report', report: { status: 'done', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(receiptCompleteness({ lane: 'build', evidence: wrongSha, writeFailed: false }).degraded, true, 'a green bound to the wrong SHA never applied — the receipt is not complete');

  assert.equal(receiptCompleteness({ lane: 'research_memo', evidence: wev, writeFailed: true }).degraded, true, 'a receipt write failure always degrades');
}

// --- item #1: orthogonal status dimensions, derived from concrete evidence ---
// Dimensions come from evidence, never the flat status; the headline is derived
// (deriveHeadline), never sealed. Each guardrail contradiction is pinned here.
{
  const { deriveStatusDimensions, deriveHeadline } = await import('./lib/status-dims.mjs');
  const head = (d) => deriveHeadline({ execution: d.execution, verification: d.verification, audit: d.audit, publication: d.publication });
  const buildEv = (over) => ({ gateReport: { status: 'done', commit_sha: 'c92d002abc123' }, verify: [{ pass: true, commitSha: 'c92d002abc123', source: 'gate_report_status' }], rounds: [{ verdict: 'APPROVED', source: 'camus_gate_review' }], revisions: [], ...over });

  // The smoke's true state: green + independent-clean + bound SHA, branch NOT merged.
  const smoke = deriveStatusDimensions({ lane: 'build', status: 'done', published: false, evidence: buildEv() });
  assert.equal(smoke.publication, 'not_published', 'a committed-but-unmerged branch is NOT published');
  assert.equal(head(smoke), 'verified', 'green + independent-clean + bound SHA reads verified (but not published)');

  // done WITHOUT review evidence — audit is not_run, never inferred from `done`.
  const noReview = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [] }) });
  assert.equal(noReview.audit, 'not_run', 'done without a readable review is not an audit');
  assert.equal(head(noReview), 'unverified', 'a done build with no audit is unverified, not verified');

  // green verification on the WRONG commit verifies nothing here.
  const wrongCommit = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ verify: [{ pass: true, commitSha: 'deadbeef012', source: 'gate_report_status' }] }) });
  assert.equal(wrongCommit.verification, 'not_run', 'a green on the wrong commit is not verification of this work');
  assert.equal(head(wrongCommit), 'unverified');

  // an UNKNOWN (unreadable) review verdict is not an audit.
  const unreadable = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'UNKNOWN', source: 'camus_gate_review' }] }) });
  assert.equal(unreadable.audit, 'infra_failed', 'a review round that ran but produced an unreadable verdict is a broken audit, not an absent one');
  assert.equal(head(unreadable), 'unverified');

  // deterministic red under a clean review → a human settles it.
  const disagree = deriveStatusDimensions({ lane: 'build', status: 'verify_failed', evidence: buildEv({ gateReport: { status: 'verify_failed', commit_sha: 'c92d002abc123' }, verify: [{ pass: false, commitSha: 'c92d002abc123', source: 'gate_report_status' }] }) });
  assert.equal(head(disagree), 'needs_decision', 'tests red but reviewer clean → needs_decision');

  // published-but-unverified is a loud needs_decision, never a quiet pass.
  const pubUnverified = deriveStatusDimensions({ lane: 'build', status: 'done', published: true, evidence: buildEv({ verify: [], rounds: [] }) });
  assert.equal(head(pubUnverified), 'needs_decision', 'published-but-unverified never flattens to a pass');

  // words lane: no commit SHA — the deliverable itself is the artifact.
  const words = deriveStatusDimensions({ lane: 'research_memo', status: 'done', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED' }], revisions: [{ rev: 1 }] } });
  assert.equal(words.verification, 'passed', 'words verification binds to the deliverable, not a SHA');
  assert.equal(head(words), 'verified');

  // an interrupted run is unverified, whatever else is present.
  const stopped = deriveStatusDimensions({ lane: 'build', status: 'stopped', evidence: { gateReport: null, verify: [], rounds: [], revisions: [] } });
  assert.equal(stopped.execution, 'interrupted');
  assert.equal(head(stopped), 'unverified');

  // P1: only the LATEST applicable verdict counts, and only APPROVED|REVISE — a
  // bogus verdict is not a findings audit, and an unreadable latest round never
  // falls back to an older clean one.
  const banana = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'BANANA', source: 'camus_gate_review' }] }) });
  assert.equal(banana.audit, 'infra_failed', 'a bogus verdict is a broken audit, not independent_findings');
  assert.equal(head(banana), 'unverified', 'a malformed latest verdict cannot verify');
  const approvedThenUnknown = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'APPROVED', source: 'camus_gate_review' }, { verdict: 'UNKNOWN', source: 'camus_gate_review' }] }) });
  assert.notEqual(approvedThenUnknown.audit, 'independent_clean', 'an unreadable latest round must not resurrect an older clean verdict');
  assert.equal(head(approvedThenUnknown), 'unverified', 'APPROVED then UNKNOWN is not verified');

  // P1: SHA binding is validated before a RED result is interpreted.
  const redWrongCommit = deriveStatusDimensions({ lane: 'build', status: 'verify_failed', evidence: buildEv({ gateReport: { status: 'verify_failed', commit_sha: 'c92d002abc123' }, verify: [{ pass: false, commitSha: 'deadbeef012', source: 'gate_report_status' }] }) });
  assert.equal(redWrongCommit.verification, 'not_run', 'a red on the wrong commit is not attributed to this artifact');
  assert.equal(head(redWrongCommit), 'unverified', 'a wrong-SHA red does not force needs_decision on this work');

  // P2: an inconclusive verification broke — infra_failed, not not_run.
  const inconclusive = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ gateReport: { status: 'verify_inconclusive', commit_sha: 'c92d002abc123' }, verify: [{ pass: null, commitSha: 'c92d002abc123', source: 'gate_report_status' }] }) });
  assert.equal(inconclusive.verification, 'infra_failed', 'verify_inconclusive is a broken step, distinct from not_run');
  assert.equal(head(inconclusive), 'unverified');
}

// --- P1: the research lane executes the run-start SNAPSHOT, not live getModels
// The snapshot models are values NOT in checks/models.json, so if the adapters
// receive them the engine is honoring run.models — not re-resolving mid-run.
{
  const { runLoop } = await import('./lib/engine.mjs');
  const prev = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1'; // verify skips the network in this test
  const calls = [];
  const adapters = {
    claude: async ({ model }) => { calls.push({ role: 'maker', model }); return { ok: true, error: null, text: '## Notes\n\nA plain note with no claims.\n', costUsd: 0 }; },
    codex: async ({ model, effort }) => { calls.push({ role: 'reviewer', model, effort }); return { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: [], nonblocking: [], questions: [] }; },
  };
  const run = { goal: 'g', lane: 'freeform', ground: false, models: { maker: { model: 'SNAPSHOT-MAKER' }, reviewer: { model: 'SNAPSHOT-REVIEWER', effort: 'high' }, loop: { roundCap: 1 } } };
  const ctx = {
    emit: () => {}, waitForAnswer: async () => 'ok', adapters,
    hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ mode: 'stub' }) },
    signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
  };
  await runLoop(run, ctx);
  if (prev === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = prev;
  const maker = calls.find((c) => c.role === 'maker');
  const reviewer = calls.find((c) => c.role === 'reviewer');
  assert.equal(maker?.model, 'SNAPSHOT-MAKER', 'the maker adapter runs the snapshot model, not a live getModels()');
  assert.equal(reviewer?.model, 'SNAPSHOT-REVIEWER', 'the reviewer adapter runs the snapshot model');
  assert.equal(reviewer?.effort, 'high', 'the reviewer effort comes from the snapshot, not a live read');
}

console.log('verify.test: all assertions passed');
