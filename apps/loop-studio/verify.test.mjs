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
  const { validateBuildTarget, parseGateReport } = await import('./lib/code-lane.mjs');
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
}

// --- gate: live link check (only when network is available) ------------------
if (process.env.TEST_NETWORK === '1') {
  const dead = GOOD + '\n3. Archive — https://github.com/Myosin-xyz/does-not-exist-archive\n';
  const res = await runVerify(dead.replace('[2]', '[2][3]').replace(/2\. Developer/, '2. Developer'), 'research_memo', {});
  const links = res.checks.find((c) => c.id === 'links');
  assert.equal(links.status, 'fail', 'dead link fails the gate');
}

console.log('verify.test: all assertions passed');
