// Deterministic-verifier self-test: seeds a document with one of every sin and
// asserts each check catches it, then asserts a clean document passes.
// Network-free (skipNetwork) so it runs anywhere, fast.

import assert from 'node:assert/strict';
import { runVerify, findUnsourcedStats, findComplianceHits, extractUrls, extractThresholdLines } from './lib/verify.mjs';

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

// --- unit: proposed-threshold exemption (section AND marker, both required) --
// A proposed decision policy has no source to cite, so an acceptance contract
// that asks for a measurable decision rule can state one WITHOUT tripping the
// laundering gate — but only under two conjoined conditions, so the exemption
// never widens into "any number inside a heading is fine."
{
  const MARKER = '- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.';

  // [1] Unsourced factual statistic OUTSIDE any decision-rule section fails.
  assert.equal(
    findUnsourcedStats('## Summary\nRetention improved 61% after the change.\n').length, 1,
    'a bare statistic outside the section still fails',
  );

  // [2] Unsourced factual statistic INSIDE the section but WITHOUT the marker fails.
  const inSectionNoMarker = findUnsourcedStats('## Decision Rule\nRetention improved 61% in the pilot cohort.\n');
  assert.equal(inSectionNoMarker.length, 1, 'the section is not a blanket exemption');
  assert.ok(inSectionNoMarker[0].includes('61%'), 'the unmarked in-section stat is the offender');

  // [3] Marked threshold OUTSIDE a decision-rule section fails (marker alone is not enough).
  const markedOutside = findUnsourcedStats(`## Summary\n${MARKER}\n`);
  assert.equal(markedOutside.length, 1, 'the marker outside the section does not exempt');
  assert.ok(markedOutside[0].includes('40%'), 'the misplaced threshold is the offender');

  // [4] Marked threshold INSIDE the section passes.
  assert.equal(findUnsourcedStats(`## Decision Rule\n${MARKER}\n`).length, 0, 'section + marker exempts the threshold');
  assert.equal(findUnsourcedStats(`### Success Criteria\n${MARKER}\n`).length, 0, 'Success Criteria is an equivalent section at any heading level');

  // [4b] The block is BOUNDED, not terminal: a mid-document Decision Rule must
  // NOT exempt statistics in the sections that follow it (the reason we do not
  // copy the terminal Sources split).
  const bounded = findUnsourcedStats(
    `## Decision Rule\n${MARKER}\n\n## Implications\nRetention improved 61% in the observed cohort.\n`,
  );
  assert.equal(bounded.length, 1, 'a later section is still checked after the block closes');
  assert.ok(bounded[0].includes('61%') && !bounded[0].includes('40%'), 'the threshold is exempt, the later factual stat is not');

  // [5] Existing cited statistics and the terminal Sources behavior are unchanged.
  assert.equal(findUnsourcedStats(GOOD).length, 0, 'cited stats still pass');
  assert.equal(
    findUnsourcedStats('## Summary\nClean prose [1].\n\n## Sources\n1. A report showing 61% retention — https://example.com\n').length, 0,
    'stats inside the terminal Sources list are still not flagged',
  );

  // [6] Every stat shape (%, currency, multiplier, large number) behaves the
  // same way through the exemption: exempt when marked-in-section, flagged when not.
  const mixed = 'ship when CAC falls below $50, LTV to CAC exceeds 3x, and signups pass 10000';
  const mixedMarker = `- Proposed threshold (decision policy, not observed performance): ${mixed}.`;
  assert.equal(findUnsourcedStats(`## Success Criteria\n${mixedMarker}\n`).length, 0, 'currency, multiplier, and large-number thresholds all exempt when marked in-section');
  assert.equal(findUnsourcedStats(`## Success Criteria\nObserved ${mixed}.\n`).length, 1, 'the same shapes still fail when stated as observed facts without the marker');
  assert.equal(findUnsourcedStats(`## Notes\n${mixedMarker}\n`).length, 1, 'and still fail when marked but outside the section');
}

// --- unit: a nested qualifying sub-heading must not shrink the outer block ----
// Under `## Decision Rule` (H2), a nested `### Success Criteria` (H3) is still
// inside the H2 region, so a later H3 does NOT close the outer block. The old
// single-level tracker mis-closed here and false-flagged the second threshold.
{
  const nested = `## Decision Rule
### Success Criteria
- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.
### Rollback
- Proposed threshold (decision policy, not observed performance): revert if CAC exceeds $50.
`;
  assert.equal(findUnsourcedStats(nested).length, 0, 'both thresholds stay exempt inside the outer H2 block');
  // And the outer boundary still closes at an H2, not before it.
  const closesAtH2 = `${nested}## Implications\nObserved retention was 61%.\n`;
  const offenders = findUnsourcedStats(closesAtH2);
  assert.equal(offenders.length, 1, 'the section after the H2 boundary is checked again');
  assert.ok(offenders[0].includes('61%'), 'the later observed stat is the only offender');
}

// --- unit: the marker is EXACT — lookalikes are NOT exempt -------------------
// Each variant sits inside a real Decision Rule block, so ONLY the marker's
// exactness stops the exemption. Every one must still be flagged.
{
  const inRule = (line) => findUnsourcedStats(`## Decision Rule\n${line}\n`);
  assert.equal(inRule('- Proposed threshold (decision policy, not observed performance): retention exceeds 40%.').length, 0, 'the exact canonical marker is exempt');
  assert.equal(inRule('We note a Proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'embedded mid-line marker is not exempt');
  assert.equal(inRule('- proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'lowercase marker is not exempt');
  assert.equal(inRule('- Proposed threshold (decision policy not observed performance): retention 40%.').length, 1, 'comma-less marker is not exempt');
  assert.equal(inRule('Proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'bullet-less marker is not exempt');

  // Markdown emphasis around the marker renders identically, so it stays exempt
  // (the live smoke's closure repair bolded it). Emphasis never relaxes the
  // exact-match discipline, and it cannot substitute for the hyphen bullet.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):** retention exceeds 40%.').length, 0, 'a fully bolded marker is exempt');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)**: retention exceeds 40%.').length, 0, 'bold closing before the colon is exempt');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance):_ retention exceeds 40%.').length, 0, 'an italicized marker is exempt');
  assert.equal(inRule('- **proposed threshold (decision policy, not observed performance):** 40%.').length, 1, 'bold does not excuse lowercase');
  assert.equal(inRule('- **Proposed threshold (decision policy not observed performance):** 40%.').length, 1, 'bold does not excuse a missing comma');
  assert.equal(inRule('**- Proposed threshold (decision policy, not observed performance):** 40%.').length, 1, 'emphasis cannot stand in for the hyphen bullet');

  // Only a BALANCED wrapper around the whole marker is emphasis. Stray * or _
  // inside the words is corruption, not formatting, and must stay red — the gate
  // reads the raw line, never a globally stripped copy.
  assert.equal(inRule('- Pro*posed threshold (decision policy, not observed performance): 40%.').length, 1, 'a stray asterisk inside the phrase is not exempt');
  assert.equal(inRule('- Pro_po_sed threshold (decision policy, not observed performance): 40%.').length, 1, 'stray underscores inside the phrase are not exempt');
  assert.equal(inRule('- **Proposed threshold** (decision policy, not observed performance): 40%.').length, 1, 'emphasis closing mid-phrase does not wrap the marker');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):* 40%.').length, 1, 'an unbalanced wrapper (** opened, * closed) is not exempt');

  // The closing delimiter must hug the marker. A space between the colon and the
  // close (`): **`) is not a valid CommonMark closing run — it renders as literal
  // asterisks, not bold — so it must stay red. Whitespace before the colon is
  // still fine (the close hugs `)`), consistent with the plain marker.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance): ** retention 40%.').length, 1, 'a space between the colon and the closing ** is not valid emphasis');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance): _ retention 40%.').length, 1, 'the same spaced-closing hole is closed for single-char emphasis too');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)** : retention 40%.').length, 0, 'but a close that hugs the phrase with space only before the colon still renders as bold');

  // The after-colon close also needs a boundary AFTER it: `:**retention` is a run
  // preceded by punctuation and followed by an alphanumeric — not right-flanking,
  // so it renders literally and must stay red. A space or line end makes it valid.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):**retention 40%.').length, 1, 'no gap after the colon-inside close is not valid emphasis');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance):_retention 40%.').length, 1, 'the no-gap hole is closed for single-char emphasis too');
  // A line with no numeric token yields no offender either way, so probe the $
  // branch through the ledger: the entry appears only if the marker matched.
  assert.equal(extractThresholdLines('## Decision Rule\n- **Proposed threshold (decision policy, not observed performance):**\n').length, 1, 'the colon-inside close is valid at end of line (enters the ledger)');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)**:retention 40%.').length, 0, 'the before-colon close stays valid — a colon follows its closing run');
}

// --- unit: live-smoke reproduction — the closure repair bolded the marker -----
// Run 20260714-185050-d95g failed verify because rev5-6 wrapped the exact marker
// in bold. It renders identically, so the gate must exempt it AND the ledger must
// still bind it — to the RAW (bolded) line, matching the artifact byte-for-byte.
{
  const liveLine = '- **Proposed threshold (decision policy, not observed performance):** expand only if cost-per-qualified-opportunity (CPQO) falls at or below $1,200 and the pilot produces at least 8 qualified opportunities — both conditions must hold simultaneously.';
  const doc = `## Decision Rule\n\n${liveLine}\n\nThese are owner-approved policy constraints, not claims about the market.\n`;
  assert.equal(findUnsourcedStats(doc).length, 0, 'the bolded marker passes deterministic verification, as it did not in the live smoke');
  const [entry] = extractThresholdLines(doc);
  assert.ok(entry, 'the bolded marker still enters the threshold ledger for the auditor');
  assert.equal(entry.line, liveLine, 'the ledger binds the exact RAW line, emphasis intact');
  assert.deepEqual(entry.stats, ['$1,200'], 'the exempted threshold figure is captured through the emphasis');
}

// --- unit: the threshold ledger is exactly what the gate exempted -----------
{
  const doc = `## Summary
Observed retention was 61%.

## Decision Rule
- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.
### Rollback
- Proposed threshold (decision policy, not observed performance): revert if CAC exceeds $50 and signups fall below 10000.

## Sources
1. A report — https://example.com
`;
  const ledger = extractThresholdLines(doc);
  assert.equal(ledger.length, 2, 'one ledger entry per exempted marker line');
  assert.deepEqual(ledger.map((t) => t.id), ['T1', 'T2'], 'entries are stably numbered');
  // section names the exemption-granting block root, not a nested sub-heading:
  // both lines are exempt because they live under the same `## Decision Rule`.
  assert.equal(ledger[0].section, 'Decision Rule', 'the entry records the block that granted the exemption');
  assert.equal(ledger[1].section, 'Decision Rule', 'a nested `### Rollback` does not reassign the block root');
  assert.ok(ledger[0].stats.includes('40%'), 'the exempted numbers are handed to the auditor');
  assert.deepEqual(ledger[1].stats, ['$50', '10000'], 'currency and large-number thresholds are captured (years excluded)');
  // An observed stat outside any marker never enters the ledger — it is an offender instead.
  assert.equal(findUnsourcedStats(doc).some((s) => s.includes('61%')), true, 'the unmarked observed stat is still a gate offender, not a ledger entry');

  // The auditor must actually SEE the exempted lines it is required to judge.
  const { reviewPrompt: rp } = await import('./lib/prompts.mjs');
  const withLedger = rp({ goal: 'g', acceptanceContract: 'State thresholds honestly.', lane: 'research_memo', draft: doc, round: 1, priorFindings: [], answers: [], thresholds: ledger });
  assert.match(withLedger, /PROPOSED-THRESHOLD LEDGER TO ASSESS/, 'the reviewer is handed the threshold ledger');
  assert.match(withLedger, /T1 \[under "Decision Rule"\]/, 'each exempted line is enumerated for assessment');
  assert.match(withLedger, /"threshold_assessments"/, 'the required output shape includes threshold_assessments');
  const noLedger = rp({ goal: 'g', acceptanceContract: 'c', lane: 'research_memo', draft: 'no thresholds here', round: 1, priorFindings: [], answers: [], thresholds: [] });
  assert.match(noLedger, /PROPOSED-THRESHOLD LEDGER TO ASSESS: none\. Return an empty threshold_assessments array\./, 'an empty ledger still instructs an empty array, never silence');

  // Collision guard: two long marker lines that share a 177-char prefix AND the
  // same numeric tokens but diverge in meaning afterward must NOT hash alike. A
  // clipped preview would collapse them; the full stored line keeps them distinct.
  const { thresholdLineHash } = await import('./lib/verify.mjs');
  const shared = `- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40% after ${'x'.repeat(150)}`;
  const [entryShip] = extractThresholdLines(`## Decision Rule\n${shared} and we ship the launch.\n`);
  const [entryHalt] = extractThresholdLines(`## Decision Rule\n${shared} and we halt the launch.\n`);
  assert.ok(entryShip.line.length > 180, 'the ledger stores the full line, not a 180-char preview');
  assert.notEqual(entryShip.line, entryHalt.line, 'lines sharing a 177-char prefix are stored distinctly (opposite decisions)');
  assert.deepEqual(entryShip.stats, entryHalt.stats, 'their numeric tokens are identical — stats alone cannot disambiguate');
  assert.notEqual(thresholdLineHash(entryShip), thresholdLineHash(entryHalt), 'the binding hash distinguishes them by full text, not a shared prefix');
}

// --- integration: the marker line reaches the auditor through the whole loop --
// The P1 was a wiring gap. This drives runLoop end to end with a draft that
// carries a marker line and a codex adapter that delegates to the REAL
// normalizeReview: the engine must extract the ledger, hand it to the adapter,
// and the adapter's fail-closed coverage must be satisfied for the run to green.
{
  const { runLoop } = await import('./lib/engine.mjs');
  const { normalizeReview } = await import('./lib/adapters/codex.mjs');
  const DRAFT = '## Decision Rule\n\n- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.\n';
  const previousOffline = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1';

  // A codex adapter that assesses every extracted threshold as honest policy →
  // the run greens only because extraction and coverage actually connect.
  const events = [];
  let sawThresholds = null;
  const run = {
    id: 'threshold-wire', goal: 'g', acceptanceContract: 'State any decision rule honestly.',
    lane: 'freeform', depth: 'quick', ground: false,
    models: { maker: { model: 'm' }, reviewer: { model: 'r', effort: 'low' }, loop: { roundCap: 1 } },
  };
  let claudeCall = 0;
  const result = await runLoop(run, {
    emit: (type, data) => events.push({ type, ...data }),
    waitForAnswer: async () => 'Stop the run',
    adapters: {
      claude: async () => (++claudeCall === 1 ? { ok: true, text: '- plan', costUsd: 0 } : { ok: true, text: DRAFT, costUsd: 0 }),
      codex: async ({ claims, criteria, thresholds }) => {
        sawThresholds = thresholds;
        return normalizeReview(JSON.stringify({
          verdict: 'clean', findings: [], questions_for_human: [],
          claim_assessments: claims.map((c) => ({ marker: c.marker, decision: 'supported', evidence: 'ok' })),
          coverage_assessments: criteria.map((c) => ({ criterion_id: c.id, decision: 'met', evidence: 'ok' })),
          threshold_assessments: thresholds.map((t) => ({ id: t.id, decision: 'policy', evidence: 'a forward-looking rule, not a measurement' })),
        }), 0, claims, criteria, thresholds);
      },
    },
    hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ connected: false, mode: 'stub' }), publishArtifact: async () => null },
    signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
  });
  assert.ok(result.status === 'done' || result.status === 'done_with_findings', 'the loop completes with the threshold assessed');
  assert.equal(sawThresholds?.length, 1, 'the engine extracted the marker line and passed it to the auditor');
  assert.equal(sawThresholds[0].id, 'T1', 'the ledger id survives the hop into the adapter');
  const review = events.find((e) => e.type === 'review');
  assert.equal(review.thresholdAssessments[0].decision, 'policy', 'the sealed review event records the threshold verdict');
  assert.equal(review.thresholdAssessments[0].id, 'T1', 'the decision is bound to the ledger id');
  assert.match(review.thresholdAssessments[0].line, /Proposed threshold/, 'the engine binds the decision to the exempted line, not just an ordinal');
  assert.deepEqual(review.thresholdAssessments[0].stats, ['40%'], 'the bound entry carries the exempted numbers');

  if (previousOffline === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = previousOffline;
}

// --- production seal path: derivation + pack must not drop threshold decisions
// The earlier receipt-parity test hand-built evidence.rounds. This drives the
// REAL deriveEvidence (event → round) and buildEvidencePack (round → receipt),
// the exact path the server runs, so a dropped mapping cannot hide behind a
// hand-assembled fixture.
{
  const { deriveEvidence } = await import('./lib/evidence.mjs');
  const { bindThresholdAssessments } = await import('./lib/verify.mjs');
  const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');

  // bindThresholdAssessments unit: the auditor's id/decision joins the ledger line.
  const ledger = [{ id: 'T1', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }];
  const bound = bindThresholdAssessments(ledger, [{ id: 'T1', decision: 'policy', evidence: 'a rule' }]);
  assert.deepEqual(bound, [{ id: 'T1', decision: 'policy', evidence: 'a rule', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }], 'a decision is bound back to the exact ledger line');
  assert.equal(bindThresholdAssessments([], [{ id: 'T9', decision: 'observed', evidence: 'x' }])[0].line, null, 'a decision with no ledger entry keeps null fields, never a fabricated line');

  const boundEvent = bindThresholdAssessments(ledger, [{ id: 'T1', decision: 'policy', evidence: 'a forward-looking rule' }]);
  const events = [
    { type: 'review', round: 1, scope: 'round', rev: 1, verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', findings: [], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The memo states its rule as explicit policy.' }], thresholdAssessments: boundEvent },
    { type: 'revision', rev: 1, markdown: '## Decision Rule\n\n- Proposed threshold (…): 40%.\n' },
    { type: 'verify_result', pass: true, checks: [{ id: 'stats', status: 'pass', detail: 'ok' }] },
  ];
  const derived = deriveEvidence(events);
  // The exact P1 regression: the derived round must carry the decision AND its binding.
  assert.equal(derived.rounds[0].thresholdAssessments.length, 1, 'deriveEvidence carries threshold assessments off the review event');
  assert.deepEqual(derived.rounds[0].thresholdAssessments[0], { id: 'T1', decision: 'policy', evidence: 'a forward-looking rule', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }, 'the full binding survives derivation');

  const pack = buildEvidencePack({
    goal: 'Choose a launch motion.',
    acceptanceContract: 'State any decision rule as explicit policy.',
    lane: 'freeform',
    deliverable: '## Decision Rule\n\n- Proposed threshold (…): 40%.\n',
    evidence: derived,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    models: { maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' } },
    simulated: false,
    createdAt: 7,
  });
  const line = pack.session_log.find((l) => l.startsWith('threshold assessment '));
  assert.ok(line, 'a real (non-simulated) run seals the threshold decision through the production path');
  assert.match(line, /threshold assessment T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}/, 'the sealed entry binds the line and the rationale');
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
  const unbound = await runVerify(withDefinedH, 'research_memo', { skipNetwork: true });
  assert.equal(unbound.checks.find((c) => c.id === 'citations').status, 'fail', 'a prose-only [H1] is not receipt-bound evidence');
  const ok = await runVerify(withDefinedH, 'research_memo', { skipNetwork: true, groundingResults: [{ title: 'Community GTM playbook' }] });
  assert.equal(ok.checks.find((c) => c.id === 'citations').status, 'pass', 'defined [H1] resolves to the captured connector result');

  // A Sources entry must not vouch for itself: marker only in Sources, none in body.
  const srcOnly = GOOD + '\n[H2] Stray entry — nobody cites this\n';
  const cit2 = (await runVerify(srcOnly, 'research_memo', { skipNetwork: true })).checks.find((c) => c.id === 'citations');
  assert.equal(cit2.status, 'pass', 'unused Sources entries are not dangling markers');
}

// --- gate: internal evidence need not invent a public URL ------------------
{
  const internal = `## Summary
The captured playbook requires verification [H1].

## Key Findings
1. The captured playbook requires verification [H1].

## Sources
### Hivemind
[H1] Compliance playbook — Spencer Frank\n`;
  const withoutReceipt = await runVerify(internal, 'research_memo', { skipNetwork: true });
  assert.equal(withoutReceipt.checks.find((c) => c.id === 'links').status, 'fail', 'an internal-looking citation cannot self-certify');
  const withReceipt = await runVerify(internal, 'research_memo', { skipNetwork: true, groundingResults: [{ title: 'Compliance playbook', author: 'Spencer Frank', ref: null }] });
  assert.equal(withReceipt.checks.find((c) => c.id === 'links').status, 'pass', 'captured Hivemind evidence may honestly have no public URL');
  assert.match(withReceipt.checks.find((c) => c.id === 'links').detail, /captured in this receipt/, 'the green explains its evidence boundary');
  assert.equal(withReceipt.pass, true, 'receipt-bound internal evidence can pass the deterministic gate');
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
  const { claudeToolSurface, usageFromClaudeResult } = await import('./lib/adapters/claude.mjs');
  const { makePrompt, fixPrompt } = await import('./lib/prompts.mjs');

  const st = hivemindStatus();
  assert.equal(st.mode, 'claude', 'mode is claude');
  assert.ok(st.base.endsWith('/api/mcp'), 'base points at an /api/mcp endpoint');
  assert.deepEqual(viaClaude(), {
    enabled: true,
    url: st.base,
    serverName: 'claude_ai_Hivemind_Staging',
    toolName: 'mcp__claude_ai_Hivemind_Staging__knowledge_search',
  }, 'viaClaude exposes the managed connector wiring');
  const surface = claudeToolSurface({ stage: 'make', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging' });
  assert.match(surface.tools, /ToolSearch/, 'managed deferred tools can be loaded');
  assert.match(surface.tools, /mcp__claude_ai_Hivemind_Staging__knowledge_search/, 'only the selected managed Hivemind tool EXISTS in the restrictive surface');
  assert.equal(surface.allowed, surface.tools, 'every available maker tool is pre-approved for headless use');
  assert.deepEqual(claudeToolSurface({ stage: 'plan', hivemindEnabled: false }), { tools: '', allowed: '' }, 'planning remains tool-free');
  assert.deepEqual(claudeToolSurface({ stage: 'make', hivemindEnabled: false, toolPolicy: 'none' }), { tools: '', allowed: '' }, 'a frozen comparison arm has no live web or MCP retrieval surface');
  const hmOnly = claudeToolSurface({ stage: 'ground', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging', toolPolicy: 'hivemind_only' });
  assert.ok(!hmOnly.tools.includes('WebSearch') && hmOnly.tools.includes('knowledge_search'), 'the snapshot retriever can see Hivemind without opening general web tools');
  const webOnly = claudeToolSurface({ stage: 'make', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging', toolPolicy: 'web_only' });
  assert.equal(webOnly.tools, 'WebSearch,WebFetch', 'a snapshot-bound maker keeps web research but cannot re-query Hivemind');
  assert.deepEqual(usageFromClaudeResult({ modelUsage: { 'claude-sonnet-4-6': { inputTokens: 120, cacheReadInputTokens: 40, outputTokens: 30 } } }, 'sonnet'), {
    usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 },
    modelActual: 'anthropic:claude-sonnet-4-6',
  }, 'Claude result usage and actual model identity survive without inferring effort');
  assert.equal(usageFromClaudeResult({ usage: { input_tokens: 999, output_tokens: 999 }, modelUsage: { 'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 30 } } }, 'sonnet').usage.input_tokens, 120, 'aggregate and per-model usage are not double-counted');

  const marker = await searchKnowledge('anything', 4, () => {});
  assert.equal(marker, 'claude', 'retrieval is delegated, not performed');

  const mk = makePrompt({ goal: 'g', lane: 'research_memo', depth: 'quick', grounding: 'claude', answers: [] });
  assert.ok(mk.includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'make prompt loads the exact managed MCP tool');
  assert.ok(mk.includes('never fabricate'), 'make prompt forbids fabricated [Hn]');
  assert.ok(mk.includes('contract outranks generic length, source-count, and query-count'), 'the explicit trust contract wins over generic depth defaults');
  assert.ok(mk.includes('use fewer when the acceptance contract explicitly narrows'), 'managed grounding does not override a narrow query contract');
  const fx = fixPrompt({ goal: 'g', lane: 'research_memo', draft: 'd', findings: [], answers: [], viaClaude: true });
  assert.ok(fx.includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'fix prompt can reload the managed tool');

  const contract = 'Every material claim must trace to a live source.';
  const { planPrompt, reviewPrompt } = await import('./lib/prompts.mjs');
  for (const [name, prompt] of [
    ['plan', planPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', depth: 'quick' })],
    ['make', makePrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', depth: 'quick', grounding: null, answers: [] })],
    ['review', reviewPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', draft: 'd', round: 1, priorFindings: [], answers: [] })],
    ['fix', fixPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', draft: 'd', findings: [], answers: [], viaClaude: false })],
  ]) assert.ok(prompt.includes(contract), `${name} is constrained by the binding acceptance contract`);

  const { groundingPrompt } = await import('./lib/prompts.mjs');
  assert.ok(groundingPrompt({ goal: 'g', acceptanceContract: contract }).includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'the frozen retriever loads the deferred managed tool before searching');

  delete process.env.HIVEMIND_VIA_CLAUDE;
}

// --- via-Claude grounding freezes first; the artifact gets stable [Hn]s ----
{
  const { runLoop, boundedGroundingResults, normalizeDeliverable } = await import('./lib/engine.mjs');
  assert.deepEqual(boundedGroundingResults(Array.from({ length: 40 }, (_, id) => ({ id }))).map((r) => r.id), Array.from({ length: 32 }, (_, i) => i + 8), 'the auditor sees the newest fix-round sources when the evidence window fills');
  assert.equal(normalizeDeliverable('Fixed the citation.\n\n---\n\n## Summary\n\nClean.'), '## Summary\n\nClean.', 'change-note preambles never enter the artifact');
  assert.equal(normalizeDeliverable('## Summary\n\nKeep me.\n\n---\n\n## Sources'), '## Summary\n\nKeep me.\n\n---\n\n## Sources', 'a real document that uses a horizontal rule is preserved');
  assert.equal(normalizeDeliverable('---\ntitle: Memo\n---\n## Summary'), '---\ntitle: Memo\n---\n## Summary', 'frontmatter is preserved');
  const previousOffline = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1';
  for (const [queried, expected] of [[false, false], [true, true]]) {
    const events = [];
    const reviewerPrompts = [];
    const claudeCalls = [];
    const groundingQuestions = [];
    let persistedSnapshot = null;
    const run = {
      id: `ground-${queried}`, goal: 'g', acceptanceContract: 'State evidence honestly.',
      lane: 'freeform', depth: 'quick', ground: true,
      models: { maker: { model: 'maker' }, reviewer: { model: 'reviewer', effort: 'low' }, loop: { roundCap: 1 } },
    };
    const result = await runLoop(run, {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async (question) => {
        groundingQuestions.push(question);
        return question.kind === 'grounding' ? 'Continue ungrounded' : 'Stop the run';
      },
      adapters: {
        claude: async ({ stage, prompt, toolPolicy }) => {
          claudeCalls.push({ stage, prompt, toolPolicy });
          if (stage === 'plan') return { ok: true, text: '- plan', costUsd: 0 };
          if (stage === 'ground') return {
            ok: true, text: 'Snapshot ready.', costUsd: 0,
            modelActual: 'anthropic:multiple[retrieval-helper+maker]',
            hivemindQueried: queried, hivemindQueries: queried ? 2 : 0,
            hivemindQueryTexts: queried ? ['cohort evidence', 'launch gaps'] : [],
            hivemindResults: queried ? [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] : [],
          };
          return { ok: true, text: '## Notes\n\nA plain note.\n', costUsd: 0, modelActual: 'anthropic:maker' };
        },
        codex: async ({ prompt }) => { reviewerPrompts.push(prompt); return { ran: true, verdict: 'APPROVED', findings: [], blocking: [], nonblocking: [], questions: [] }; },
      },
      hivemind: {
        searchKnowledge: async () => 'claude',
        hivemindStatus: () => ({ connected: true, mode: 'claude' }),
        publishArtifact: async () => null,
      },
      signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
      persistKnowledgeSnapshot: async (snapshot) => { persistedSnapshot = snapshot; },
    });
    const groundDone = events.findLast((event) => event.type === 'stage' && event.name === 'ground' && event.status === 'done');
    assert.ok(result.status === 'done' || result.status === 'done_with_findings', 'the grounding probe completes the full loop');
    assert.equal(groundDone?.queried, expected, `grounding records actual connector use (${queried})`);
    assert.equal(groundDone?.connected, expected, 'configured-but-unused never wears a connected/grounded badge');
    assert.equal(groundDone?.itemCount, queried ? 1 : 0, 'the frozen stage reports the captured item count used by the UI');
    assert.equal(groundingQuestions.filter((question) => question.kind === 'grounding').length, queried ? 0 : 1, 'zero captured excerpts require an explicit human downgrade');
    if (!queried) assert.match(groundingQuestions.find((question) => question.kind === 'grounding')?.text ?? '', /without calling knowledge_search/, 'the checkpoint distinguishes no tool call from a queried empty result');
    assert.ok(persistedSnapshot?.snapshot_id, 'the single-run knowledge snapshot is sealed before drafting');
    assert.equal(claudeCalls.find((call) => call.stage === 'ground')?.toolPolicy, 'hivemind_only', 'retrieval can use Hivemind but not the web');
    assert.equal(claudeCalls.find((call) => call.stage === 'make')?.toolPolicy, 'web_only', 'drafting cannot re-query the frozen internal corpus');
    assert.deepEqual(result.makerActualModels, ['anthropic:maker'], 'retriever helpers stay in stage usage and never become the artifact executor actual');
    assert.ok(reviewerPrompts[0].includes(`Hivemind queried: ${queried ? 'yes' : 'no'}`), 'auditor receives adapter evidence, not maker self-attestation');
    if (queried) {
      assert.ok(claudeCalls.find((call) => call.stage === 'make')?.prompt.includes('[H1] Cohort playbook — A. Expert'), 'Camus, not the maker, assigns the stable artifact marker');
      assert.ok(reviewerPrompts[0].includes('"cohort evidence"'), 'auditor receives the observed query trail');
      assert.ok(reviewerPrompts[0].includes('Programs should sell progress, not content.'), 'auditor receives the bounded tool-result excerpt');
    }
  }
  if (previousOffline === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = previousOffline;
}

// --- normalizeReview: no path from broken reviewer output to a verdict -------
{
  const { normalizeReview, usageFromCodexEvent } = await import('./lib/adapters/codex.mjs');
  const infra = (raw, code, why) => assert.equal(normalizeReview(raw, code).ran, false, why);
  const rawReview = (overrides = {}) => JSON.stringify({
    verdict: 'clean', findings: [], questions_for_human: [], claim_assessments: [], coverage_assessments: [], threshold_assessments: [], ...overrides,
  });

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
  infra(rawReview(), 1, 'nonzero exit is infra even with valid JSON');
  infra(rawReview({ questions_for_human: 'not-an-array' }), 0, 'malformed questions fail closed instead of throwing');
  assert.deepEqual(
    usageFromCodexEvent(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } })),
    { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 },
    'Codex completion usage is captured as an observation',
  );
  assert.equal(usageFromCodexEvent('{"type":"turn.started"}'), null, 'non-completion events invent no usage');

  const clean = normalizeReview(rawReview({ findings: [{ severity: 'low', title: 'nit', detail: 'd', suggestion: 's' }], questions_for_human: ['', '  ', 'real?'] }), 0);
  assert.equal(clean.ran, true);
  assert.equal(clean.verdict, 'APPROVED', 'clean + low only approves');
  assert.equal(clean.nonblocking.length, 1, 'low is nonblocking');
  assert.deepEqual(clean.questions, ['real?'], 'blank questions filtered');

  const fenced = normalizeReview('```json\n{"verdict":"revise","findings":[{"severity":"medium","title":"t","detail":"d","suggestion":"s"}],"questions_for_human":[],"claim_assessments":[],"coverage_assessments":[],"threshold_assessments":[]}\n```', 0);
  assert.equal(fenced.ran, true, 'fenced JSON still parses');
  assert.equal(fenced.blocking.length, 1);

  const claims = [{ marker: '[1]', claim: 'Retention improved.', url: 'https://example.com/report' }];
  const assessed = normalizeReview(rawReview({
    claim_assessments: [{ marker: '[1]', decision: 'supported', evidence: 'The report states retention improved.' }],
  }), 0, claims);
  assert.equal(assessed.ran, true, 'exact claim coverage is accepted');
  assert.equal(assessed.claimAssessments[0].decision, 'supported');
  assert.equal(normalizeReview(rawReview(), 0, claims).ran, false, 'missing claim assessment coverage fails closed');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[2]', decision: 'supported', evidence: 'wrong source' }] }), 0, claims).ran, false, 'extra/wrong markers fail closed');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[1]', decision: 'unsupported', evidence: 'The source says the opposite.' }] }), 0, claims).ran, false, 'unsupported claim cannot wear a clean verdict');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[1]', decision: 'unchecked', evidence: 'The source could not be loaded.' }] }), 0, claims).ran, false, 'unchecked claim on clean needs a visible caveat');
  const unchecked = normalizeReview(rawReview({
    findings: [{ severity: 'low', title: 'Source could not be checked', detail: 'The cited page was unavailable.', suggestion: 'Recheck before publication.' }],
    claim_assessments: [{ marker: '[1]', decision: 'unchecked', evidence: 'The source could not be loaded.' }],
  }), 0, claims);
  assert.equal(unchecked.ran, true, 'unchecked is allowed only when its caveat survives the verdict');

  const criteria = [{ id: 'C1', text: 'Every claim is supported.' }];
  const covered = normalizeReview(rawReview({
    coverage_assessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'Every claim in the deliverable has a supporting assessment.' }],
  }), 0, [], criteria);
  assert.equal(covered.ran, true, 'exact acceptance-criterion coverage is accepted');
  assert.equal(normalizeReview(rawReview(), 0, [], criteria).ran, false, 'missing criterion coverage fails closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C2', decision: 'met', evidence: 'wrong criterion' }] }), 0, [], criteria).ran, false, 'wrong criterion ids fail closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'first' }, { criterion_id: 'C1', decision: 'met', evidence: 'second' }] }), 0, [], criteria).ran, false, 'duplicate criterion assessments fail closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The deliverable omits the required comparison.' }] }), 0, [], criteria).ran, false, 'unmet criterion cannot wear a clean verdict');
  const unmetCoverage = normalizeReview(rawReview({
    verdict: 'revise',
    findings: [{ severity: 'medium', title: 'Contract criterion unmet', detail: 'The required comparison is absent.', suggestion: 'Add it.' }],
    coverage_assessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The deliverable omits the required comparison.' }],
  }), 0, [], criteria);
  assert.equal(unmetCoverage.ran, true, 'unmet coverage is valid only as a blocking revise verdict');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'unclear', evidence: 'The deliverable does not provide enough evidence.' }] }), 0, [], criteria).ran, false, 'unclear criterion on clean needs a visible caveat');
  const unclearCoverage = normalizeReview(rawReview({
    findings: [{ severity: 'low', title: 'Coverage remains unclear', detail: 'The output lacks outcome evidence.', suggestion: 'Confirm before publication.' }],
    coverage_assessments: [{ criterion_id: 'C1', decision: 'unclear', evidence: 'The deliverable does not provide enough evidence.' }],
  }), 0, [], criteria);
  assert.equal(unclearCoverage.ran, true, 'unclear criterion survives only with its caveat');

  // Proposed-threshold ledger: the auditor MUST assess every exempted line, and
  // a line assessed `observed` (a statistic wearing the marker) can never pass.
  const thresholds = [{ id: 'T1', section: 'Decision Rule', line: '- Proposed threshold (…): proceed if retention exceeds 40%.', stats: ['40%'] }];
  const policyClean = normalizeReview(rawReview({
    threshold_assessments: [{ id: 'T1', decision: 'policy', evidence: 'A forward-looking rule the owner is setting, not a measurement.' }],
  }), 0, [], [], thresholds);
  assert.equal(policyClean.ran, true, 'a genuine proposed policy passes');
  assert.equal(policyClean.thresholdAssessments[0].decision, 'policy', 'the assessment is carried through');
  assert.equal(normalizeReview(rawReview(), 0, [], [], thresholds).ran, false, 'missing threshold assessment coverage fails closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T2', decision: 'policy', evidence: 'wrong id' }] }), 0, [], [], thresholds).ran, false, 'extra/wrong threshold ids fail closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: '61% is a measured baseline, not a policy.' }] }), 0, [], [], thresholds).ran, false, 'an observed threshold cannot wear a clean verdict');
  const laundered = normalizeReview(rawReview({
    verdict: 'revise',
    findings: [{ severity: 'high', title: 'Statistic disguised as policy', detail: 'The marker line states a measured 61%, not a proposed rule.', suggestion: 'Cite it or move it to findings.' }],
    threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: 'The number is presented as achieved performance.' }],
  }), 0, [], [], thresholds);
  assert.equal(laundered.ran, true, 'an observed threshold is valid only as a blocking revise verdict');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: 'measured' }, { id: 'T1', decision: 'policy', evidence: 'dup' }] }), 0, [], [], thresholds).ran, false, 'duplicate threshold assessments fail closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'maybe', evidence: 'x' }] }), 0, [], [], thresholds).ran, false, 'an unknown threshold decision fails closed');
}

// --- claim ledger: citations become sealed candidates, not automatic proof --
{
  const { extractClaimCandidates, buildClaimLedger } = await import('./lib/claims.mjs');
  const { reviewPrompt } = await import('./lib/prompts.mjs');
  const doc = `## Recommendation

Retention improved after onboarding changed [1]. The same report also records lower churn [1].
Members value practical progress over content volume [H1].

## Sources
1. Cohort report — https://example.com/cohorts
[H1] Member interviews — Research team
`;
  const groundingResults = [{ excerpt: 'Members repeatedly asked for practical milestones.', retrievedAt: 123 }];
  const candidates = extractClaimCandidates(doc, { groundingResults });
  assert.equal(candidates.length, 2, 'reused markers produce one unambiguous ledger item');
  assert.match(candidates[0].claim, /Retention improved.*lower churn/, 'all claims bound to one marker stay together');
  assert.equal(candidates[0].url, 'https://example.com/cohorts', 'the public source URL is bound to the claim');
  assert.equal(candidates[0].evidence_hash, null, 'a live URL is not silently promoted into captured support');
  assert.match(candidates[1].evidence_hash, /^sha256:[0-9a-f]{64}$/, 'captured Hivemind evidence is content-bound');
  assert.equal(candidates[1].retrieved_at, 123, 'captured evidence keeps its retrieval time');
  assert.equal(candidates.every((c) => c.decision === 'unchecked'), true, 'citation extraction never decides entailment');
  const prompt = reviewPrompt({
    goal: 'Choose a strategy.', acceptanceContract: 'Every claim is supported.', lane: 'research_memo',
    draft: doc, round: 1, priorFindings: [], answers: [],
    groundingEvidence: { queried: true, queryCount: 1, queries: ['member value'], results: groundingResults },
    claims: candidates,
  });
  assert.match(prompt, /\[H1\].*source=receipt-bound Hivemind result \[R1\]/, 'the auditor gets an explicit H-marker to captured-result mapping');

  const ledger = buildClaimLedger(doc, {
    groundingResults,
    assessments: [
      { marker: '[1]', decision: 'unsupported', evidence: 'The report discusses activation, not retention.' },
      { marker: '[H1]', decision: 'supported', evidence: 'The captured excerpt directly states the preference.' },
    ],
  });
  assert.deepEqual(ledger.map((c) => c.decision), ['unsupported', 'supported'], 'only explicit auditor assessments populate decisions');
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
      claimAssessments: [],
      coverageAssessments: [],
      thresholdAssessments: [],
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
      codexQueue: [review('APPROVED'), review('APPROVED')],
      answerQueue: [],
    });
    const res = await h5.run();
    // Freeform drafts with no URLs verify green WITH caveats (links warn,
    // structure/citations skip) — and caveats are never hidden as plain done.
    assert.equal(res.status, 'done_with_findings', 'fixable red ends green-with-caveats');
    assert.equal(h5.published.length, 1, 'published exactly once');
    assert.equal(h5.prompts.codex.length, 2, 'a verify-fix triggers a fresh closure audit on the changed artifact');
    const closure = h5.events.find((e) => e.type === 'review' && e.scope === 'closure');
    assert.equal(closure.rev, 2, 'the closure audit binds to the repaired revision');
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
  const { sessionLineFromEvent, parseHivemindToolResult } = await import('./lib/adapters/claude.mjs');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'crypto ad policy' } }] } }),
    'WebSearch: crypto ad policy', 'claude tool_use becomes a session line');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude_ai_Hivemind_Staging__knowledge_search', input: { query: 'gtm' } }] } }),
    'knowledge_search: gtm', 'managed MCP prefix (including underscores) stripped');
  assert.equal(sessionLineFromEvent({ type: 'result', result: 'x' }), null, 'result events are not session lines');
  const hmResult = parseHivemindToolResult([{
    type: 'text',
    text: JSON.stringify({ success: true, data: { query: 'cohort evidence', chunks: [{ title: 'Cohort playbook', author: 'A. Expert', content: 'Programs should sell progress, not content.', chunk_id: 'chunk-1', score: 0.8 }] } }),
  }]);
  assert.deepEqual(hmResult, [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }], 'structured Hivemind tool results become bounded audit evidence');
  assert.deepEqual(parseHivemindToolResult([{ type: 'text', text: 'not-json' }]), [], 'malformed tool output never becomes invented evidence');

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

  // reviewer model and effort are independent decisions: their provenance must
  // not be conflated (an env model with a file effort, or the reverse).
  const base = getModels().reviewer;
  assert.equal(base.modelSource, 'checks/models.json', 'default reviewer model provenance is the file');
  assert.equal(base.effortSource, 'checks/models.json', 'default reviewer effort provenance is the file');
  process.env.CODEX_MODEL = 'probe-reviewer';
  let split = getModels().reviewer;
  assert.equal(split.modelSource, 'env:CODEX_MODEL', 'an env model names the env as the model source');
  assert.equal(split.effortSource, 'checks/models.json', 'effort still traces to the file when only the model is overridden');
  delete process.env.CODEX_MODEL;
  process.env.CODEX_EFFORT = 'high';
  split = getModels().reviewer;
  assert.equal(split.modelSource, 'checks/models.json', 'model still traces to the file when only the effort is overridden');
  assert.equal(split.effortSource, 'env:CODEX_EFFORT', 'an env effort names the env as the effort source');
  delete process.env.CODEX_EFFORT;
}

// --- build lane: spend-free refusals + fail-closed report parsing ------------
{
  const {
    validateBuildTarget,
    parseGateReport,
    gateArgsForRun,
    gateIgniterCliArgs,
    gateSupportsStudio,
    claudeAuthFailureNote,
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
  // Live-fire P0 regression (2026-07-13 authenticated smoke): the gate returned
  // a REAL structured no_changes whose note contains the standalone word "done"
  // ("never a false done"). no_changes was missing from the recognized list, the
  // parseable report was discarded, and the prose fallback matched "done" —
  // Studio fabricated "DONE — reviewed and verified" with no verifier run.
  const liveNoop = parseGateReport('The loop halted. {"status":"no_changes","task":"t","worktree":"/w","branch":"camus/x","rounds":1,"note":"Review passed but the implement step produced no committable change (empty diff). no_changes, never a false done — nothing to merge."}');
  assert.equal(liveNoop.status, 'no_changes', 'the live smoke report parses to no_changes, never a prose-matched done');
  // Exhaustiveness has a second net: a structured status Studio does NOT know
  // must fail closed as infra — token parsing never overrides a parseable report.
  const unknownStructured = parseGateReport('{"status":"some_future_status","note":"work is done and everything verified"}');
  assert.equal(unknownStructured.status, 'infra_error', 'an unrecognized structured status is infra, never re-guessed from prose');
  assert.match(unknownStructured.note, /some_future_status/, 'the refusal names the unrecognized status');

  const boundArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1' }, 3);
  assert.equal(boundArgs.identitySalt, 'studio-run-1', 'Studio binds standalone custody with identitySalt');
  assert.equal('idSalt' in boundArgs, false, 'Studio never impersonates camus-feat ownership');
  assert.equal('model' in boundArgs, false, 'no maker snapshot → no model pin (nothing invented)');
  const pinnedArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1', models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.4' } } }, 3);
  assert.equal(pinnedArgs.model, 'opus', 'the maker is pinned THROUGH the /camus-loop contract from the run-start snapshot, not the outer igniter');
  const contractedArgs = gateArgsForRun({ goal: 't', acceptanceContract: 'Tests pass and the requested API remains compatible.', targetPath: '/tmp/repo', idSalt: 'studio-run-1' }, 3);
  assert.match(contractedArgs.task, /Acceptance contract \(binding\):/, 'the code gate receives the contract as part of its binding task');
  assert.match(contractedArgs.task, /requested API remains compatible/, 'the gate judges the exact user contract');
  const igniterArgs = gateIgniterCliArgs('/camus-loop {}');
  assert.equal(igniterArgs.includes('--tools'), false, 'process-wide tools stay inherited so camus-loop child agents retain Bash/Read/Edit');
  assert.deepEqual(igniterArgs.slice(igniterArgs.indexOf('--allowedTools'), igniterArgs.indexOf('--allowedTools') + 2), ['--allowedTools', 'Workflow'], 'only the outer Workflow call is pre-approved');
  assert.ok(igniterArgs.includes('--append-system-prompt'), 'outer igniter receives the custody contract as system policy');
  assert.equal(gateSupportsStudio({ workflow: 'const STANDALONE_ID_SALT = x', worktreeGate: 'create|ensure|attach|resolve' }), true, 'new installed gate advertises both custody capabilities');
  assert.equal(gateSupportsStudio({ workflow: 'const ID_SALT = x', worktreeGate: 'create|attach|resolve' }), false, 'older installed gate is refused instead of silently ignoring identitySalt');

  // Live-fire regression (2026-07-13): Claude's local auth status said logged
  // in while inference returned 401. Custody correctly refused the absent
  // Workflow call, but its generic message hid the only useful repair.
  const retry401 = claudeAuthFailureNote({ type: 'system', subtype: 'api_retry', error_status: 401, error: 'authentication_failed' });
  assert.match(retry401, /claude auth login/, 'a streamed 401 becomes an actionable reauthentication instruction');
  assert.equal(
    claudeAuthFailureNote({ type: 'result', api_error_status: 401, result: 'Invalid authentication credentials' }),
    retry401,
    'the terminal 401 produces the same stable user-facing diagnosis',
  );
  assert.equal(claudeAuthFailureNote({ type: 'system', subtype: 'api_retry', error_status: 429, error: 'rate_limited' }), null, 'non-auth failures still go through normal custody/error handling');
  assert.equal(claudeAuthFailureNote({ type: 'result', result: 'done' }), null, 'a normal result is never mislabeled as auth failure');

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
  const pinnedReview = reviewEventFromGateReceipt({ ran: true, reviewer_model: 'gpt-5.4', reviewer_effort: 'medium', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(pinnedReview.reviewerModel, 'gpt-5.4', 'a review that ran carries the reviewer model it was pinned to');
  // Live smoke P1 (2026-07-13): the snapshot requested one effort, the gate ran
  // another. The evidence seals the ACTUAL effort the audit recorded — never the
  // snapshot's requested value, never a default.
  assert.equal(pinnedReview.reviewerEffort, 'medium', 'a review that ran carries the effort it actually ran at');
  const unranPin = reviewEventFromGateReceipt({ ran: false, reviewer_model: 'gpt-5.4', reviewer_effort: 'medium', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(unranPin.reviewerModel, null, 'a review that did not run never claims a reviewer identity');
  assert.equal(unranPin.reviewerEffort, null, 'a review that did not run never claims an effort either');
  assert.equal(nestedReview.reviewerEffort, null, 'no ran:true envelope → effort stays null (nothing invented)');

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
  assert.equal(verifyEventFromGateReport({ status: 'no_changes' }), null, 'a genuine no-op never fabricates a verification result (nothing ran)');
}

// --- build lane: the outer igniter cannot fork or mutate custody ------------
{
  const { createGateCustodyGuard } = await import('./lib/gate-custody.mjs');
  const { gateProcessClose } = await import('./lib/code-lane.mjs');
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

  const authBeforeWorkflow = gateProcessClose({
    code: 0,
    authFailureNote: 'reauthenticate',
    custody: createGateCustodyGuard(expected),
  });
  assert.deepEqual(authBeforeWorkflow, { exitCode: -6, custodyError: null }, 'pre-workflow auth failure keeps its actionable diagnosis instead of becoming a custody symptom');

  const ordinaryNoWorkflow = gateProcessClose({ code: 0, authFailureNote: null, custody: createGateCustodyGuard(expected) });
  assert.equal(ordinaryNoWorkflow.exitCode, -5, 'ordinary prose/no-tool output remains a fail-closed custody error');
  assert.match(ordinaryNoWorkflow.custodyError, /without one fresh/, 'ordinary no-tool output still names the custody breach');

  const authenticatedWorkflow = createGateCustodyGuard(expected);
  authenticatedWorkflow.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  assert.deepEqual(
    gateProcessClose({ code: 0, authFailureNote: 'stale retry event', custody: authenticatedWorkflow }),
    { exitCode: 0, custodyError: null },
    'a workflow that actually started is not relabeled by an earlier retry event',
  );

  const authPlusViolation = createGateCustodyGuard(expected);
  authPlusViolation.inspect(tool('Bash', { command: 'git status' }));
  assert.equal(
    gateProcessClose({ code: 0, authFailureNote: 'reauthenticate', custody: authPlusViolation }).exitCode,
    -5,
    'a concrete custody violation outranks an authentication symptom',
  );
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
    { type: 'session', actor: 'maker', line: 'knowledge_search: cohort evidence' },
    { type: 'grounding_evidence', source: 'adapter_tool_result', results: [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] },
    { type: 'stage', name: 'ground', status: 'done', connected: true, queried: true, queries: 1, mode: 'claude' },
    { type: 'round', round: 1, cap: 3 },
    { type: 'finding', severity: 'high', title: 'no source', detail: 'd', suggestion: 's' },
    { type: 'revision', rev: 1, markdown: '# draft one' },
    { type: 'review', round: 1, rev: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'no source', detail: 'd', suggestion: 's' }] },
    { type: 'answer', kind: 'decision', question: 'q?', answer: 'a' },
    { type: 'revision', rev: 2, markdown: '# draft two, longer' },
    { type: 'review', round: 2, rev: 2, verdict: 'APPROVED', findings: [] },
    { type: 'verify_result', pass: true, warnings: 1, skipped: 0 },
  ];
  const wev = deriveEvidence(wordsEvents);
  assert.equal(wev.plan, 'the plan');
  assert.equal(wev.grounding.results[0].ref, 'chunk-1', 'bounded Hivemind result evidence survives in the receipt');
  assert.equal(wev.rounds.length, 2, 'both review rounds captured in the receipt');
  assert.equal(wev.rounds[0].findings[0].title, 'no source', 'findings ride their round — not dropped from the receipt');
  assert.equal(wev.findings.length, 1, 'flat findings list captured');
  assert.deepEqual(wev.revisions.map((r) => r.rev), [1, 2], 'the whole revision trail is on the receipt');
  assert.equal(wev.verify[0].pass, true, 'deterministic verify result captured');
  assert.equal(wev.humanDecisions[0].answer, 'a', 'the human decision is on the receipt');
  assert.equal(receiptCompleteness({ lane: 'research_memo', evidence: wev, writeFailed: false, status: 'done_with_findings' }).degraded, false, 'a full words receipt is not degraded');

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
  const words = deriveStatusDimensions({ lane: 'research_memo', status: 'done', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }] } });
  assert.equal(words.verification, 'passed', 'words verification binds to the deliverable, not a SHA');
  assert.equal(head(words), 'verified');

  const wordsWithCaveat = deriveStatusDimensions({ lane: 'research_memo', status: 'done_with_findings', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1, findings: [{ severity: 'low', title: 'Source unavailable' }], claimAssessments: [{ marker: '[1]', decision: 'unchecked' }] }], revisions: [{ rev: 1 }] } });
  assert.equal(wordsWithCaveat.audit, 'independent_findings', 'APPROVED with a low/unchecked caveat is not flattened into a clean audit');
  assert.equal(head(wordsWithCaveat), 'verified_with_findings', 'caveats stay visible in the derived standing');

  const unclearContract = deriveStatusDimensions({ lane: 'research_memo', status: 'done_with_findings', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1, findings: [{ severity: 'low', title: 'Contract evidence unclear' }], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'unclear' }] }], revisions: [{ rev: 1 }] } });
  assert.equal(unclearContract.audit, 'independent_findings', 'unclear acceptance coverage is a visible audit caveat');
  assert.equal(head(unclearContract), 'verified_with_findings', 'unclear coverage never derives plain verified');

  const staleWordsAudit = deriveStatusDimensions({ lane: 'research_memo', status: 'done', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }, { rev: 2 }] } });
  assert.equal(staleWordsAudit.audit, 'not_run', 'an audit of rev 1 never travels to a verify-fix that produced rev 2');
  assert.equal(head(staleWordsAudit), 'unverified', 'a final words artifact with only a stale audit cannot derive verified');

  // A REHEARSAL of the same shape can never impersonate that standing
  // (2026-07-14 P1: a mock receipt sealed audit:independent_clean → verified).
  // Scripted rounds stay in the receipt as events, execution and the words
  // lane's REAL deterministic verify stay recorded — but audit seals not_run.
  const rehearsal = deriveStatusDimensions({ lane: 'research_memo', status: 'done', simulated: true, evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }] } });
  assert.equal(rehearsal.audit, 'not_run', 'scripted APPROVED rounds seal audit not_run under simulation');
  assert.equal(rehearsal.verification, 'passed', 'the rehearsal deterministic verify is real and stays recorded');
  assert.equal(rehearsal.execution, 'completed', 'the rehearsal lifecycle stays honest');
  assert.notEqual(head(rehearsal), 'verified', 'a rehearsal never derives verified standing');

  // a genuine no-op ran to its conclusion: completed lifecycle, nothing
  // verified, nothing shipped — never a dead process, never a quiet green.
  const noop = deriveStatusDimensions({ lane: 'build', status: 'no_changes', evidence: buildEv({ verify: [], gateReport: { status: 'no_changes' } }) });
  assert.equal(noop.execution, 'completed', 'no_changes is a completed run, not a failed one');
  assert.equal(noop.verification, 'not_run', 'no_changes never claims a verification that did not run');

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

// --- auth preflight: the tri-state probe parser never invents a green --------
// The launch chips consume the doctor's judgement; this parser IS that
// judgement, so its honesty is load-bearing: unknown stays unknown, and an
// explicit "Not logged in" (even printed with exit 0) must never match the
// "logged in" substring into a false green — the chip would reassure a user
// straight into a 401.
{
  const { parseAuthProbe, hivemindListingHasEndpoint, managedConnectorIsConnected, runDoctor } = await import('./lib/doctor.mjs');
  assert.equal(parseAuthProbe(null), null, 'probe could not run → unknown, never guessed');
  assert.equal(parseAuthProbe('Logged in as mateo@example.com'), true, 'claude prose sign-in parses');
  assert.equal(parseAuthProbe('{"loggedIn": true, "method": "oauth"}'), true, 'claude JSON sign-in parses');
  assert.equal(parseAuthProbe('Logged in using ChatGPT'), true, 'codex prose sign-in parses');
  assert.equal(parseAuthProbe('Not logged in'), false, 'an explicit negation is FALSE, never a substring false-green');
  assert.equal(parseAuthProbe('not logged in (run codex login)'), false, 'negation wins whatever the casing/suffix');
  assert.equal(parseAuthProbe('Logged out'), false, 'logged-out phrasing is false');
  assert.equal(parseAuthProbe('{"loggedIn": false}'), false, 'JSON signed-out parses false');
  // Only EXPLICIT claims decide: anything else stays unknown — an implicit
  // false would be as invented as an implicit green (2026-07-14 review).
  assert.equal(parseAuthProbe('some unrelated banner text'), null, 'output with no explicit claim stays unknown');
  assert.equal(parseAuthProbe(''), null, 'empty output claims nothing');
  const stagingUrl = 'https://staging-hivemind.myosin.xyz/api/mcp';
  assert.equal(
    hivemindListingHasEndpoint(`claude.ai Hivemind Staging: ${stagingUrl} - Connected`, stagingUrl),
    true,
    'managed Hivemind Staging is recognized by exact endpoint, not a required local alias',
  );
  assert.equal(hivemindListingHasEndpoint('hivemind: https://wrong.example/api/mcp - Connected', stagingUrl), false, 'a matching display name at the wrong endpoint is refused');
  assert.equal(managedConnectorIsConnected('claude.ai Hivemind Staging:\n  Status: ✔ Connected'), true, 'targeted managed connector probe recognizes connected');
  assert.equal(managedConnectorIsConnected('claude.ai Hivemind Staging:\n  Status: ✘ Needs authentication'), false, 'targeted managed connector probe refuses signed-out');

  // Live P1 (2026-07-14): BOTH installed CLIs deliver their signed-out answer
  // with EXIT CODE 1 (claude: {"loggedIn": false,…}; codex: "Not logged in").
  // The probe used to discard nonzero-exit output, collapsing the real
  // signed-out state into "unknown" with ok:true and no fix — the red
  // preflight could never fire. Fake CLIs on PATH reproduce the exact shapes.
  {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const bin = mkdtempSync(join(tmpdir(), 'cls-fakebin-'));
    const fake = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    fake('claude', `case "$1" in --version) echo "1.0.0-fake"; exit 0 ;; auth) echo '{"loggedIn": false, "method": null}'; exit 1 ;; *) exit 1 ;; esac`);
    fake('codex', `case "$1" in --version) echo "0.0.0-fake"; exit 0 ;; login) echo "Not logged in"; exit 1 ;; *) exit 1 ;; esac`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const report = await runDoctor({});
      const claude = report.checks.find((c) => c.id === 'claude');
      const codex = report.checks.find((c) => c.id === 'codex');
      assert.equal(claude.auth, false, 'claude {"loggedIn": false} on exit 1 is a REAL signed-out, not unknown');
      assert.equal(claude.ok, false, 'a signed-out claude fails its check');
      assert.match(claude.fix ?? '', /sign-in|sign in/i, 'the fix names the sign-in flow');
      assert.equal(codex.auth, false, 'codex "Not logged in" on exit 1 is a REAL signed-out, not unknown');
      assert.equal(codex.ok, false, 'a signed-out codex fails its check');
      assert.equal(report.ok, false, 'a signed-out CLI fails the doctor report');
    } finally {
      process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    }
  }
}

// --- Studio evidence pack: explicit contract, identity split, honest spend --
{
  const { buildEvidencePack, shortEvidenceId } = await import('./lib/evidence-pack.mjs');
  const { buildAuditReplayPack, createAuditReplayExperiment, finalizeAuditReplayExperiment, knowledgeSnapshotId } = await import('./lib/audit-replay.mjs');
  const { validateEvidencePack, validateExperimentRecord } = await import('../../packages/trust/lib/validate.mjs');
  const base = {
    goal: 'Decide whether community or paid should lead the quarter.',
    acceptanceContract: 'Every material claim traces to a live URL and the recommendation states its tradeoffs.',
    lane: 'research_memo',
    deliverable: '# Memo\n\nUse community first.\n',
    evidence: {
      rounds: [{
        rev: 1,
        verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'high', findings: [],
        claimAssessments: [],
        coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The memo traces its material claim and states its recommendation.' }],
      }],
      revisions: [{ rev: 1, chars: 29 }],
      verify: [{ pass: true, checks: [{ id: 'links', status: 'pass', detail: '4 URLs checked' }] }],
      humanDecisions: [{ kind: 'decision', question: 'Which market?', answer: 'Base', at: 42 }],
      grounding: { mode: 'claude', connected: true, queried: true, queryCount: 1, queries: ['cohort evidence'], results: [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] },
      gateReport: null,
    },
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    models: { maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'high' } },
    createdAt: 100,
  };
  const pack = buildEvidencePack(base);
  assert.equal(validateEvidencePack(pack).ok, true, 'Studio output validates as the published evidence-pack schema');
  assert.equal(pack.schemaVersion, 2, 'structured acceptance coverage ships as evidence-pack v2, never as an in-place v1 mutation');
  assert.equal(pack.acceptance_contract, base.acceptanceContract, 'contract is explicit, never aliased from goal');
  assert.deepEqual(pack.artifact.contract_coverage.map((c) => [c.id, c.decision]), [['C1', 'met']], 'the final-revision coverage decision seals into the pack');
  assert.equal(pack.pairing.executor.actual, 'anthropic:sonnet', 'pinned maker is recorded');
  assert.equal(pack.pairing.auditor.actual, 'openai:gpt-5.4', 'auditor actual comes from the ran review');
  assert.equal(pack.pairing.independence, 'cross_vendor', 'different recorded providers earn cross-vendor standing');
  assert.equal(pack.economics.find((e) => e.role === 'auditor').effort, 'high', 'actual reviewer effort survives');
  assert.equal(pack.economics.every((e) => e.billing_mode === 'unknown' && e.estimated_cost_usd === null), true, 'billing and dollars stay unknown/null');
  assert.deepEqual(pack.verification.checks, [{ id: 'links', status: 'pass', detail: '4 URLs checked' }], 'deterministic checks survive');
  assert.equal(pack.human_decisions[0].at, 42, 'decision time survives into the ledger');
  assert.ok(pack.session_log.includes('hivemind query: cohort evidence'), 'grounding tool evidence is custody-bound in the sealed pack');
  assert.ok(pack.session_log.some((line) => line.includes('hivemind result: Cohort playbook — A. Expert') && line.includes('excerpt_hash=sha256:')), 'result metadata and content hash are custody-bound');
  assert.ok(pack.session_log.some((line) => line.startsWith('coverage assessment C1: met; evidence_hash=sha256:')), 'coverage rationale is custody-bound by hash');
  assert.equal(shortEvidenceId(pack.artifact_id).length, 12, 'the UI uses a short display ID while the pack keeps the full hash');
  assert.ok(!('headline' in pack), 'derived standing never persists in the pack');

  const changedContract = buildEvidencePack({ ...base, acceptanceContract: 'A materially different acceptance contract.' });
  assert.notEqual(changedContract.artifact_id, pack.artifact_id, 'changing the contract expires the artifact audit');
  const changedJudgment = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'independent_findings' } });
  assert.equal(changedJudgment.artifact_id, pack.artifact_id, 'changing judgment does not pretend the artifact changed');
  assert.notEqual(changedJudgment.receipt_id, pack.receipt_id, 'changing judgment mints a new receipt');
  const changedGrounding = buildEvidencePack({ ...base, evidence: { ...base.evidence, grounding: { ...base.evidence.grounding, queries: ['different query'] } } });
  assert.equal(changedGrounding.artifact_id, pack.artifact_id, 'runtime query evidence is receipt identity, not artifact identity');
  assert.notEqual(changedGrounding.receipt_id, pack.receipt_id, 'changing the grounding trail mints a new receipt');

  const coverageMet = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'independent_findings' } });
  const coverageUnmet = buildEvidencePack({
    ...base,
    statuses: { ...base.statuses, audit: 'independent_findings' },
    evidence: {
      ...base.evidence,
      rounds: [{
        ...base.evidence.rounds[0],
        coverageAssessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The memo omits the required tradeoff analysis.' }],
      }],
    },
  });
  assert.equal(coverageUnmet.artifact_id, coverageMet.artifact_id, 'coverage judgment changes do not pretend the artifact changed');
  assert.notEqual(coverageUnmet.receipt_id, coverageMet.receipt_id, 'coverage judgment changes mint a new receipt');

  const citedBase = {
    ...base,
    deliverable: `# Recommendation

Retention improved after onboarding changed [1].
Members asked for practical milestones [H1].

## Sources
1. Cohort report — https://example.com/cohorts
[H1] Member interviews — Research team
`,
    evidence: {
      ...base.evidence,
      revisions: [{ rev: 1, chars: 220 }],
      rounds: [{
        rev: 1,
        verdict: 'REVISE',
        reviewerModel: 'gpt-5.4',
        reviewerEffort: 'high',
        findings: [{ severity: 'low', title: 'A separate caveat remains.' }],
        claimAssessments: [
          { marker: '[1]', decision: 'supported', evidence: 'The report explicitly attributes the retention change to onboarding.' },
          { marker: '[H1]', decision: 'supported', evidence: 'The captured interview excerpt asks for practical milestones.' },
        ],
      }],
      grounding: {
        ...base.evidence.grounding,
        results: [{ ...base.evidence.grounding.results[0], retrievedAt: 88, excerpt: 'Members asked for practical milestones.' }],
      },
    },
    statuses: { ...base.statuses, audit: 'independent_findings' },
  };
  const cited = buildEvidencePack(citedBase);
  assert.equal(validateEvidencePack(cited).ok, true, 'a claim-bearing Studio pack validates');
  assert.deepEqual(cited.artifact.claims.map((c) => [c.marker, c.decision]), [['[1]', 'supported'], ['[H1]', 'supported']], 'the final-revision auditor decisions seal into the ledger');
  assert.equal(cited.artifact.claims[0].url, 'https://example.com/cohorts', 'public claims bind their exact source URL');
  assert.equal(cited.artifact.claims[0].evidence_hash, null, 'URL reachability alone is not captured support');
  assert.match(cited.artifact.claims[1].evidence_hash, /^sha256:[0-9a-f]{64}$/, 'Hivemind claims bind captured excerpt content');
  assert.equal(cited.artifact.claims[1].retrieved_at, 88, 'Hivemind claims bind evidence freshness');
  assert.equal(cited.session_log.filter((line) => line.startsWith('claim assessment ')).length, 2, 'assessment rationales are custody-bound by hash in the receipt');

  const changedAssessment = buildEvidencePack({
    ...citedBase,
    evidence: {
      ...citedBase.evidence,
      rounds: [{
        ...citedBase.evidence.rounds[0],
        claimAssessments: [
          { marker: '[1]', decision: 'unsupported', evidence: 'The report discusses activation, not retention.' },
          citedBase.evidence.rounds[0].claimAssessments[1],
        ],
      }],
    },
  });
  assert.equal(changedAssessment.artifact_id, cited.artifact_id, 'changing the auditor judgment does not pretend the artifact changed');
  assert.notEqual(changedAssessment.receipt_id, cited.receipt_id, 'changing the claim judgment mints a new receipt');

  // Threshold decisions seal into the receipt exactly like claim/coverage ones:
  // a laundering catch (policy → observed) is a judgment change, so it mints a
  // new receipt without pretending the immutable artifact changed. The bound
  // assessment carries the line it judged so the receipt records WHAT T1 refers to.
  const boundThreshold = (decision) => [{ id: 'T1', decision, evidence: `${decision} rationale`, section: 'Decision Rule', line: '- Proposed threshold (…): proceed if retention exceeds 40%.', stats: ['40%'] }];
  const thresholdBase = {
    ...citedBase,
    evidence: { ...citedBase.evidence, rounds: [{ ...citedBase.evidence.rounds[0], thresholdAssessments: boundThreshold('policy') }] },
  };
  const withThreshold = buildEvidencePack(thresholdBase);
  const thresholdLine = withThreshold.session_log.find((line) => line.startsWith('threshold assessment '));
  assert.ok(thresholdLine, 'threshold decisions seal into the receipt');
  assert.match(thresholdLine, /threshold assessment T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}/, 'the entry binds the exempted line AND the rationale by hash');
  const laundered = buildEvidencePack({
    ...thresholdBase,
    evidence: { ...thresholdBase.evidence, rounds: [{ ...thresholdBase.evidence.rounds[0], thresholdAssessments: boundThreshold('observed') }] },
  });
  assert.equal(laundered.artifact_id, withThreshold.artifact_id, 'a threshold verdict change does not pretend the artifact changed');
  assert.notEqual(laundered.receipt_id, withThreshold.receipt_id, 'changing the threshold judgment mints a new receipt');
  // Same decision, different exempted line → different receipt: the binding is real.
  const otherLine = buildEvidencePack({
    ...thresholdBase,
    evidence: { ...thresholdBase.evidence, rounds: [{ ...thresholdBase.evidence.rounds[0], thresholdAssessments: [{ ...boundThreshold('policy')[0], line: '- Proposed threshold (…): proceed if CAC falls below $50.', stats: ['$50'] }] }] },
  });
  assert.notEqual(otherLine.receipt_id, withThreshold.receipt_id, 'binding a policy verdict to a different line mints a different receipt');

  const citedRehearsal = buildEvidencePack({ ...citedBase, simulated: true, statuses: { ...citedBase.statuses, audit: 'not_run' } });
  assert.equal(citedRehearsal.artifact.claims.every((c) => c.decision === 'unchecked'), true, 'scripted rehearsal assessments never become evidence');
  assert.equal(citedRehearsal.artifact.contract_coverage.every((c) => c.decision === 'unclear'), true, 'scripted rehearsal coverage never becomes evidence');

  const rehearsal = buildEvidencePack({ ...base, simulated: true, statuses: { ...base.statuses, audit: 'not_run' } });
  assert.equal(rehearsal.pairing.executor.actual, 'simulation:scripted-maker');
  assert.equal(rehearsal.pairing.auditor.actual, 'simulation:scripted-auditor');
  assert.equal(rehearsal.pairing.independence, 'none', 'scripted rehearsal never claims independence');
  assert.equal(rehearsal.artifact.contract_coverage.every((c) => c.decision === 'unclear'), true, 'rehearsal contract coverage stays explicitly unclear');

  const buildPack = buildEvidencePack({
    ...base,
    lane: 'build',
    targetPath: '/tmp/demo-repo',
    deliverable: null,
    evidence: {
      rounds: [{ verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', findings: [] }],
      verify: [{ pass: true, commitSha: 'c92d002abc123', source: 'gate_report_status' }],
      humanDecisions: [],
      gateReport: { status: 'done', commit_sha: 'c92d002abc123', initialModel: 'sonnet', finalFixModel: 'opus' },
    },
  });
  assert.equal(validateEvidencePack(buildPack).ok, true, 'developer-role output validates as the same protocol pack');
  assert.deepEqual(buildPack.artifact, { kind: 'code', repo: '/tmp/demo-repo', head: 'c92d002abc123', diff_hash: null, changed_files: null, deliverable_hash: null, claims: null, contract_coverage: null }, 'the build artifact is bound to the gate-branch head without inventing structured coverage the gate does not emit yet');
  assert.equal(buildPack.pairing.executor.requested, 'anthropic:sonnet', 'the run-start maker decision survives');
  assert.equal(buildPack.pairing.executor.actual, 'anthropic:opus', 'the gate-reported final model records escalation honestly');
  assert.equal(buildPack.pairing.auditor.actual, 'openai:gpt-5.4', 'the code auditor actual is sealed');
  assert.match(buildPack.verification.checks[0].detail, /c92d002abc123/, 'build verification stays bound to the audited commit');
  assert.ok(buildPack.session_log.includes('executor initial model: anthropic:sonnet') && buildPack.session_log.includes('executor final model: anthropic:opus'), 'initial and final executor identities remain visible');

  const catalog = { reviewer: ['gpt-5.4', 'gpt-5.6-sol'], reviewerSource: 'codex_cache' };
  const experiment = createAuditReplayExperiment({
    sourceRunId: 'source-run',
    sourcePack: pack,
    sourceEvidence: base.evidence,
    sourceDeliverable: base.deliverable,
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    catalog,
    createdAt: 200,
  });
  assert.equal(validateExperimentRecord(experiment).ok, true, 'audit replay freezes a valid experiment manifest before execution');
  assert.throws(() => createAuditReplayExperiment({
    sourceRunId: 'source-run',
    sourcePack: pack,
    sourceEvidence: base.evidence,
    sourceDeliverable: '# Tampered memo\n',
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    catalog,
    createdAt: 200,
  }), /does not match the sealed artifact/, 'a changed report deliverable cannot ride the source artifact identity into a replay');
  assert.match(knowledgeSnapshotId(base.evidence), /^sha256:[0-9a-f]{64}$/, 'private grounding is represented by a local snapshot hash, not copied into the manifest');
  assert.deepEqual(experiment.manifest.reviewer, { requested: 'openai:gpt-5.6-sol', resolved: 'openai:gpt-5.6-sol' }, 'requested and resolved reviewer are frozen once with no fallback');

  const replayReview = {
    ran: true,
    verdict: 'APPROVED',
    findings: [],
    questions: [],
    reviewerModel: 'gpt-5.6-sol',
    reviewerEffort: 'xhigh',
    claimAssessments: [],
    coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The exact memo satisfies the criterion.' }],
    thresholdAssessments: [{ id: 'T1', decision: 'policy', evidence: 'A forward-looking rule, not a measurement.', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }],
    usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 120 },
    durationMs: 4200,
  };
  const replayPack = buildAuditReplayPack({
    sourcePack: pack,
    review: replayReview,
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    experimentId: experiment.experiment_id,
    createdAt: 201,
  });
  assert.equal(validateEvidencePack(replayPack).ok, true, 'audit-only replay seals as a normal evidence pack');
  assert.equal(replayPack.artifact_id, pack.artifact_id, 'audit-only replay preserves the exact source artifact identity');
  assert.notEqual(replayPack.receipt_id, pack.receipt_id, 'a new auditor/configuration mints a new receipt');
  assert.equal(replayPack.pairing.auditor.actual, 'openai:gpt-5.6-sol', 'the actual pinned replay reviewer survives');
  assert.equal(replayPack.economics.find((item) => item.role === 'auditor').effort, null, 'requested effort is not promoted into an actual when the runtime does not report one');
  assert.ok(replayPack.session_log.includes(`audit replay experiment: ${experiment.experiment_id}`), 'the receipt binds the frozen experiment manifest');
  assert.ok(replayPack.session_log.some((line) => /^audit replay threshold T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}$/.test(line)), 'the replay receipt seals the threshold decision bound to its line');

  const finalExperiment = finalizeAuditReplayExperiment(experiment, { pack: replayPack, review: replayReview });
  assert.equal(validateExperimentRecord(finalExperiment).ok, true, 'the completed arm validates');
  assert.equal(finalExperiment.outcome.artifact_id, pack.artifact_id, 'experiment outcome keeps the source artifact');
  assert.equal(finalExperiment.outcome.receipt_id, replayPack.receipt_id, 'experiment outcome points at the new receipt');
  assert.deepEqual(finalExperiment.outcome.judge_overlap, { arm_provider: 'anthropic', judge_provider: 'openai', same_vendor: false, same_family: false }, 'judge-to-arm vendor/family overlap is explicit');
  assert.equal(finalExperiment.manifest.effort.requested, 'xhigh', 'requested effort is frozen in the manifest');
  assert.equal(finalExperiment.outcome.effort_actual, null, 'actual effort stays unknown when Codex reports usage but not applied reasoning budget');
  assert.deepEqual(finalExperiment.outcome.usage, { input_tokens: 900, cached_input_tokens: 300, output_tokens: 120, duration_ms: 4200 }, 'actual usage observations survive');

  const replayRehearsal = buildAuditReplayPack({ ...({ sourcePack: pack, review: replayReview, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh', experimentId: experiment.experiment_id, createdAt: 202 }), simulated: true });
  assert.equal(replayRehearsal.artifact_id, pack.artifact_id, 'rehearsal re-audit still preserves the artifact');
  assert.equal(replayRehearsal.statuses.audit, 'not_run', 'scripted replay never earns audit standing');
  assert.equal(replayRehearsal.artifact.contract_coverage.every((criterion) => criterion.decision === 'unclear'), true, 'scripted replay coverage stays unclear');
  assert.equal(replayRehearsal.session_log.some((line) => line.startsWith('audit replay threshold ')), false, 'scripted replay never seals a threshold decision as evidence');

  const failedReview = { ran: false, error: 'model disappeared', verdict: 'ERROR', findings: [], questions: [], claimAssessments: [], coverageAssessments: [], durationMs: 50, usage: null };
  const failedPack = buildAuditReplayPack({ sourcePack: pack, review: failedReview, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh', experimentId: experiment.experiment_id, createdAt: 203 });
  const failedExperiment = finalizeAuditReplayExperiment(experiment, { pack: failedPack, review: failedReview });
  assert.equal(validateExperimentRecord(failedExperiment).ok, true, 'a vanished reviewer remains a valid failed arm instead of disappearing');
  assert.equal(failedExperiment.outcome.status, 'infra_failed');
  assert.equal(failedPack.statuses.audit, 'infra_failed', 'a failed audit is sealed as infra, never not_run or clean');

  const {
    createParallelExperiment,
    finalizeParallelExperiment,
    knowledgeSnapshotMatches,
    markParallelArmRunning,
    outcomeFromArmReport,
    sealKnowledgeSnapshot,
  } = await import('./lib/comparison.mjs');
  const snapshot = sealKnowledgeSnapshot({
    query: base.goal,
    mode: 'hivemind_claude',
    items: [{ query: base.goal, title: 'Frozen evidence', author: 'Researcher', ref: 'k-1', score: 0.8, excerpt: 'Concrete milestones outperform broad promises.' }],
    retriever: { requested: 'anthropic:sonnet', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    capturedAt: 300,
  });
  assert.equal(knowledgeSnapshotMatches(snapshot), true, 'the local knowledge payload is content-addressed');
  assert.equal(knowledgeSnapshotMatches({ ...snapshot, items: [{ ...snapshot.items[0], excerpt: 'tampered' }] }), false, 'a changed knowledge payload expires the snapshot');
  const parallel = createParallelExperiment({
    goal: base.goal,
    acceptanceContract: base.acceptanceContract,
    lane: 'research_memo',
    depth: 'quick',
    roundCap: 3,
    snapshot,
    makerModels: ['sonnet', 'opus'],
    reviewerModel: 'gpt-5.4',
    reviewerEffort: 'high',
    catalog: { maker: ['haiku', 'sonnet', 'opus'], reviewer: ['gpt-5.4'], reviewerSource: 'codex_cache' },
    createdAt: 300,
  });
  assert.equal(validateExperimentRecord(parallel).ok, true, 'parallel manifest validates before either executor runs');
  const runningParallel = markParallelArmRunning(parallel, 'arm-1', 'run-arm-1');
  assert.equal(runningParallel.outcome.arms[0].status, 'running', 'arm lifecycle is visible before completion');
  const goodOutcome = outcomeFromArmReport({
    experiment: runningParallel,
    armId: 'arm-1',
    runId: 'run-arm-1',
    report: {
      status: 'done',
      simulated: false,
      evidencePack: pack,
      makerActualModels: ['anthropic:sonnet'],
      makerUsage: [{ stage: 'make', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80 }, duration_ms: 2000 }],
    },
  });
  assert.equal(goodOutcome.status, 'completed', 'an independently clean, deterministic-green arm passes the quality floor');
  assert.deepEqual(goodOutcome.usage, { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80, duration_ms: 2000 }, 'executor usage is the common observed cost signal');
  const advisoryPack = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'advisory_clean' } });
  const advisoryOutcome = outcomeFromArmReport({
    experiment: runningParallel,
    armId: 'arm-1',
    runId: 'run-advisory',
    report: { status: 'done', simulated: false, evidencePack: advisoryPack, makerActualModels: ['anthropic:sonnet'], makerUsage: [] },
  });
  assert.equal(advisoryOutcome.status, 'quality_floor_failed', 'same-vendor advisory review is retained but never clears the comparison quality floor');
  const failedOutcome = outcomeFromArmReport({ experiment: runningParallel, armId: 'arm-2', runId: 'run-arm-2', report: { status: 'failed', error: 'model unavailable', evidencePack: null } });
  assert.equal(failedOutcome.status, 'infra_failed', 'a failed executor remains a first-class arm');
  const finalParallel = finalizeParallelExperiment(runningParallel, [goodOutcome, failedOutcome]);
  assert.equal(validateExperimentRecord(finalParallel).ok, true, JSON.stringify(validateExperimentRecord(finalParallel)));
  assert.deepEqual(finalParallel.outcome.arms.map((arm) => arm.status), ['completed', 'infra_failed'], 'finalization never drops the failed arm');
}

// --- banner policy: every real done* answers to the headline, fail-closed ----
// The pure mapping the UI renders from (public/banner.mjs). Two receipts bit
// us here: a legacy done with NO dimensions bypassed the old guard and kept
// "reviewed and verified" (P1 — several real runs/ receipts have that shape),
// and done + verified_with_findings hid its caveats behind the flat copy (P2).
{
  const { comparisonBanner, doneBanner } = await import('./public/banner.mjs');
  const verifiedLabel = 'DONE. Reviewed and verified.';

  // Missing evidence fails CLOSED — the legacy-receipt shape, both flat statuses.
  const legacy = doneBanner('done', undefined, undefined);
  assert.equal(legacy.cls, 'meh', 'legacy done (no dimensions) is never a green banner');
  assert.match(legacy.label, /gate claim/, 'legacy done renders as a claim, not a verdict');
  assert.match(legacy.label, /no status dimensions/, 'the reason names the missing evidence');
  assert.ok(!/reviewed and verified/i.test(legacy.label), 'legacy done never reads reviewed-and-verified');
  assert.match(doneBanner('done_with_findings', undefined, undefined).label, /^DONE WITH FINDINGS \(gate claim\)/, 'the downgrade names the exact claimed status');

  // A headline is presentation, never evidence: a recognized headline WITHOUT
  // the dimensions it claims to derive from (tampered/torn replay — no honest
  // server emits it) must not unlock any standing (2026-07-14 review, P2).
  for (const h of ['verified', 'verified_with_findings', 'same_vendor_reviewed', 'published']) {
    const tampered = doneBanner('done', h, undefined);
    assert.equal(tampered.cls, 'meh', `headline ${h} without dimensions never greens`);
    assert.match(tampered.label, /gate claim/, `headline ${h} without dimensions renders as a claim`);
  }

  // Each recognized standing owns its copy.
  assert.deepEqual(doneBanner('done', 'verified', { verification: 'passed', audit: 'independent_clean' }), { cls: 'good', label: verifiedLabel }, 'verified reads reviewed-and-verified');
  const vwf = doneBanner('done', 'verified_with_findings', { verification: 'passed', audit: 'independent_findings' });
  assert.equal(vwf.cls, 'good', 'verified_with_findings is still a green standing');
  assert.match(vwf.label, /findings or caveats/, 'the caveats ride the banner itself');
  assert.notEqual(vwf.label, verifiedLabel, 'done + verified_with_findings never hides its caveats behind the plain verified copy');
  const advisory = doneBanner('done', 'same_vendor_reviewed', { verification: 'passed', audit: 'advisory_clean' });
  assert.equal(advisory.cls, 'meh');
  assert.match(advisory.label, /Same-vendor reviewed/, 'advisory standing is named');
  assert.ok(!/reviewed and verified/i.test(advisory.label), 'advisory never claims verified standing');
  assert.match(doneBanner('done', 'published', { verification: 'passed', audit: 'independent_clean' }).label, /published/, 'published standing is named');

  // Anything else — unverified, needs_decision, a headline this UI does not
  // know — is an uncorroborated claim naming the dimensions when present.
  const unv = doneBanner('done', 'unverified', { verification: 'not_run', audit: 'independent_clean' });
  assert.equal(unv.cls, 'meh');
  assert.match(unv.label, /verification not run/, 'the downgrade names the verification dimension');
  assert.match(unv.label, /audit independent clean/, 'the downgrade names the audit dimension');
  assert.match(doneBanner('done', 'BANANA', { verification: 'passed', audit: 'independent_clean' }).label, /gate claim/, 'an unknown headline is a claim, never trusted');

  assert.match(comparisonBanner('done', true).label, /REHEARSAL COMPLETE/, 'a completed comparison rehearsal says complete');
  assert.match(comparisonBanner('failed', true).label, /REHEARSAL FAILED/, 'a recovered infra failure never wears rehearsal-complete copy');
  assert.match(comparisonBanner('failed', true).label, /no models or retrieval were rerun/, 'recovery copy names the no-rerun guarantee');
  assert.equal(comparisonBanner('failed', false).cls, 'bad', 'a live failed comparison is visibly red');
}

// --- model catalog: the picker only offers what codex itself lists -----------
// codex marks internal models `visibility: 'hide'` (e.g. codex-auto-review).
// Surfacing one would let a run decision be made that the normal codex UI
// withholds, so the catalog filters to listable slugs only.
{
  const { reviewerSlugsFromCache } = await import('./lib/models.mjs');
  const cache = { models: [
    { slug: 'gpt-5.4', visibility: 'list' },
    { slug: 'gpt-5.4-mini', visibility: 'list' },
    { slug: 'codex-auto-review', visibility: 'hide' },
    { slug: 'no-visibility-field' },
    { visibility: 'list' },
  ] };
  const slugs = reviewerSlugsFromCache(cache);
  assert.deepEqual(slugs, ['gpt-5.4', 'gpt-5.4-mini'], 'only listable slugs are offered');
  assert.ok(!slugs.includes('codex-auto-review'), 'a hidden internal model is never offered in the picker');
  assert.deepEqual(reviewerSlugsFromCache(null), [], 'no cache → no slugs');
  assert.deepEqual(reviewerSlugsFromCache({ models: 'nope' }), [], 'a malformed cache → no slugs');

  // The hole the review found: a hidden model set as the CURRENT reviewer (via
  // CODEX_MODEL) was unshifted back into the picker. It must stay unavailable.
  // Meaningful only when this machine's real cache lists codex-auto-review as
  // hidden; on a cacheless machine the fallback legitimately allows a current.
  const { modelCatalog } = await import('./lib/models.mjs');
  const prevEnv = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = 'codex-auto-review';
  const cat = modelCatalog();
  if (cat.reviewerSource === 'codex_cache') {
    assert.ok(!cat.reviewer.includes('codex-auto-review'), 'a hidden model set as the current reviewer is NOT made selectable');
    assert.equal(cat.reviewerCurrentAvailable, false, 'the hidden current reviewer is reported unavailable');
  }
  if (prevEnv === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = prevEnv;
}

// --- the rehearsal's final deliverable must not launder sources --------------
// A demo that ends on a laundered green would show Camus blessing the exact thing
// it exists to catch. These are the DETERMINISTIC guarantees (no uncited stat, no
// compliance failure, every citation resolves, required structure). The gate
// CANNOT judge claim-to-source entailment — that was verified by hand against the
// live pages (see mock.mjs), and is guarded here two ways: the memo must LABEL
// its strategic recommendation as an inference rather than pass it off as
// sourced, and its Sources must be exactly the hand-verified set, so any source
// change re-triggers manual entailment review.
{
  process.env.MOCK_SPEED = '0'; // no real sleeps in the test
  const { createMockAdapters } = await import('./lib/adapters/mock.mjs');
  const a = createMockAdapters();
  const ac = new AbortController();
  const call = (stage) => a.claude({ stage, signal: ac.signal, onTick() {}, onSession() {} });
  await call('make'); // REV1
  await call('fix');  // REV2
  await call('fix');  // REV3
  const finalRev = (await call('fix')).text; // REV4 — the approved, verified deliverable
  assert.equal(findUnsourcedStats(finalRev).length, 0, 'final deliverable: no uncited statistic');
  assert.equal(findComplianceHits(finalRev).filter((h) => h.severity === 'fail').length, 0, 'final deliverable: no compliance failure');
  const gate = await runVerify(finalRev, 'research_memo', { skipNetwork: true });
  assert.equal(gate.checks.find((c) => c.id === 'citations').status, 'pass', 'final deliverable: every citation resolves to a source');
  assert.equal(gate.checks.find((c) => c.id === 'stats').status, 'pass', 'final deliverable: passes stats-must-cite');
  assert.equal(gate.checks.find((c) => c.id === 'structure').status, 'pass', 'final deliverable: required sections present');
  // The strategic recommendation is LABELLED an inference, not passed off as sourced.
  assert.match(finalRev, /inference \(not a sourced fact\)/i, 'final deliverable labels its strategic recommendation an inference');
  assert.match(finalRev, /hypothesis to test|test against the client|test this against/i, 'final deliverable calls for validation against client data');
  // Sources are EXACTLY the hand-verified set — a change here must re-trigger entailment review.
  for (const url of [
    'wikipedia.org/wiki/Digital_marketing',
    'wikipedia.org/wiki/Customer_retention',
    'wikipedia.org/wiki/Network_effect',
    'wikipedia.org/wiki/Word-of-mouth_marketing',
    'wikipedia.org/wiki/Customer_acquisition_cost',
  ]) assert.ok(finalRev.includes(url), `final deliverable cites the verified source ${url}`);
  assert.ok(!finalRev.includes('does-not-exist-archive'), 'final deliverable carries no dead placeholder source');
  // The FIRST draft is where the plantable problems live — the loop catches them.
  const rev1 = (await createMockAdapters().claude({ stage: 'make', signal: ac.signal, onTick() {}, onSession() {} })).text;
  assert.ok(findUnsourcedStats(rev1).length > 0 || findComplianceHits(rev1).some((h) => h.severity === 'fail'), 'the rehearsal FIRST draft plants a real problem for the reviewer to catch');
}

// --- compliance wordlist describes itself honestly (no crypto vertical) ------
{
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('./checks/compliance.json', import.meta.url), 'utf8'));
  assert.ok(!/web3|crypto|token|airdrop|presale|onchain/i.test(cfg.description), 'the compliance wordlist describes itself generally, not as a crypto vertical');
  assert.ok(cfg.patterns.some((p) => p.label === 'Guaranteed returns claim' && p.severity === 'fail'), 'the general promissory-returns rule survives the generalization');
}

// --- contract-coverage ledger: deterministic criteria, auditor decides --------
// The next Compare & Learn primitive. Extraction must be a pure function of the
// contract (the same contract → the same criteria across arms, or coverage is not
// comparable); the auditor supplies met|unmet|unclear, defaulting to unclear.
{
  const { extractContractCriteria, applyCoverageAssessments, buildCoverageLedger } = await import('./lib/contract.mjs');
  const { reviewPrompt } = await import('./lib/prompts.mjs');

  const prose = 'Every material claim traces to a live source; the recommendation states assumptions and tradeoffs; no invented Hivemind evidence.';
  const c = extractContractCriteria(prose);
  assert.equal(c.length, 3, 'semicolon/sentence clauses split into criteria');
  assert.deepEqual(c.map((x) => x.id), ['C1', 'C2', 'C3'], 'ids are stable and ordered');
  assert.match(c[0].text, /traces to a live source/, 'the first clause is captured');
  assert.ok(!/[;.]$/.test(c[0].text), 'trailing punctuation is trimmed');
  // Comparability: identical contract text yields byte-identical criteria.
  assert.deepEqual(extractContractCriteria(prose), extractContractCriteria(prose), 'same contract → same criteria');
  const coveragePrompt = reviewPrompt({ goal: 'g', acceptanceContract: prose, lane: 'research_memo', draft: 'd', round: 1, priorFindings: [], answers: [], criteria: c });
  for (const criterion of c) assert.ok(coveragePrompt.includes(`- ${criterion.id} ${criterion.text}`), `review prompt carries the exact ${criterion.id} criterion`);
  assert.match(coveragePrompt, /"coverage_assessments"/, 'review output contract requires structured coverage assessments');

  const bullets = extractContractCriteria('- claims cite live sources\n- assumptions are stated\n- no fabricated evidence');
  assert.equal(bullets.length, 3, 'a bulleted contract splits per item');
  assert.deepEqual(bullets.map((x) => x.id), ['C1', 'C2', 'C3']);

  assert.deepEqual(extractContractCriteria(''), [], 'empty contract → no criteria');
  assert.deepEqual(extractContractCriteria('   '), [], 'whitespace-only contract → no criteria');
  assert.deepEqual(extractContractCriteria('Everything must be perfect.'), [{ id: 'C1', text: 'Everything must be perfect' }], 'a one-clause contract is one criterion');

  // Auditor decisions apply by id; absent/invalid default to unclear, never met.
  const ledger = buildCoverageLedger('A live source backs every claim; assumptions are stated.', {
    assessments: [{ criterion_id: 'C1', decision: 'met' }, { criterion_id: 'C2', decision: 'bogus' }],
  });
  assert.equal(ledger.find((x) => x.id === 'C1').decision, 'met', 'a valid met decision applies');
  assert.equal(ledger.find((x) => x.id === 'C2').decision, 'unclear', 'an invalid decision defaults to unclear');
  assert.ok(applyCoverageAssessments(c, []).every((x) => x.decision === 'unclear'), 'no assessments → every criterion unclear (never silently satisfied)');
  assert.equal(buildCoverageLedger('One rule: cite everything.', { assessments: [{ criterion_id: 'C1', decision: 'unmet' }] }).find((x) => x.id === 'C1').decision, 'unmet', 'a genuine miss is recorded as unmet');
}

// --- doctor: skills are reported, including symlinked installs ---------------
// Marketplace/plugin installs SYMLINK skills into ~/.claude/skills, and
// Dirent.isDirectory() is false for a symlink — that silently hid 23 of 26 real
// skills on the first pass. Report-only: the loop cannot invoke these yet.
{
  const { listSkills } = await import('./lib/doctor.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'skills-home-'));
  const store = mkdtempSync(join(tmpdir(), 'skills-store-'));
  const cwd = mkdtempSync(join(tmpdir(), 'skills-proj-'));
  mkdirSync(join(cwd, '.git'));
  const skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const write = (dir, name, front) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\nbody\n`);
  };
  write(skillsDir, 'plain', 'name: plain\ndescription: An inline description.');
  write(skillsDir, 'blocky', 'name: blocky\ndescription: |\n  A block scalar description.');
  write(store, 'linked', 'name: linked\ndescription: Installed via symlink.');
  symlinkSync(join(store, 'linked'), join(skillsDir, 'linked'));
  mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true }); // no SKILL.md

  const found = listSkills({ home, cwd });
  assert.deepEqual(found.map((s) => s.name), ['blocky', 'linked', 'plain'], 'symlinked skills are reported alongside real directories, sorted');
  assert.equal(found.find((s) => s.name === 'linked').description, 'Installed via symlink.', 'a symlinked skill resolves its metadata');
  assert.equal(found.find((s) => s.name === 'blocky').description, 'A block scalar description.', 'a YAML block scalar description is read, not captured as "|"');
  assert.ok(!found.some((s) => s.name === 'not-a-skill'), 'a directory without SKILL.md is not a skill');

  // Project skills shadow user skills of the same name, matching Claude Code.
  const projSkills = join(cwd, '.claude', 'skills');
  mkdirSync(projSkills, { recursive: true });
  write(projSkills, 'plain', 'name: plain\ndescription: Project override.');
  const shadowed = listSkills({ home, cwd });
  assert.equal(shadowed.filter((s) => s.name === 'plain').length, 1, 'a shadowed skill is not listed twice');
  assert.equal(shadowed.find((s) => s.name === 'plain').scope, 'project', 'the project copy wins');

  const nested = join(cwd, 'apps', 'studio');
  mkdirSync(nested, { recursive: true });
  assert.equal(listSkills({ home, cwd: nested }).find((s) => s.name === 'plain')?.scope, 'project', 'a server started below the git root still sees project skills');

  assert.deepEqual(listSkills({ home: mkdtempSync(join(tmpdir(), 'skills-empty-')), cwd: mkdtempSync(join(tmpdir(), 'skills-empty2-')) }), [], 'a machine with no skills reports none, never an error');

  for (const dir of [home, store, cwd]) rmSync(dir, { recursive: true, force: true });
}

// --- run story: derived from the receipt, fails closed, never inflates -------
// The story card is the most persuasive surface in the app, so its rules are
// pinned here the same way the done banner's are.
{
  const { runStory, STORY_BEATS } = await import('./public/story.mjs');

  const base = {
    goal: 'Decide the quarter.',
    ground: true,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published' },
    evidencePack: {
      receipt_id: 'sha256:' + 'a'.repeat(64),
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published' },
      pairing: { executor: { actual: 'anthropic:claude-sonnet-4-6' }, auditor: { actual: 'openai:gpt-5.6-sol' } },
    },
    evidence: {
      grounding: { mode: 'hivemind_claude', queried: true, frozen: true, results: [{}, {}, {}] },
      revisions: [{ rev: 1 }, { rev: 2 }],
      // The SAME finding re-raised across rounds is one issue, not three.
      rounds: [
        { round: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'Citations are misbound' }, { severity: 'medium', title: 'Recommendation outruns evidence' }] },
        { round: 2, verdict: 'REVISE', findings: [{ severity: 'high', title: 'Citations Are Misbound!' }] },
        { round: 3, verdict: 'APPROVED', findings: [{ severity: 'low', title: 'A nit' }] },
      ],
      verify: [{ pass: true }],
      humanDecisions: [{ kind: 'stuck', answer: 'One more round' }, { kind: 'stuck', answer: 'Accept and ship (with findings on record)' }],
    },
  };

  const told = runStory(base, 'verified_with_findings');
  const prose = told.sentences.join(' ');
  assert.equal(told.degraded, false, 'a corroborated receipt tells its story');
  assert.equal(told.headline, 'Verified with findings');
  assert.match(prose, /three Hivemind items were captured and frozen before drafting/i, 'the frozen evidence count comes from captured results');
  assert.match(prose, /two distinct blocking findings/i, 'repeats of one finding are counted once, never inflated to three');
  assert.match(prose, /re-raising what was not fixed/i, 'a genuinely repeated title may be described as re-raised');
  assert.match(prose, /from a different vendor/, 'independent audit standing is stated');
  assert.match(prose, /authorised one further round/i, 'the human decision is reported from the recorded answer');
  assert.match(prose, /accepted findings on the record/i, 'acceptance is reported without inventing that every remaining finding was accepted');
  assert.match(prose, /Nothing was published\./, 'publication standing is stated');
  assert.ok(told.sentences.every((s) => /^[A-Z]/.test(s)), 'every sentence is capitalised, including ones that open with a number word');
  assert.deepEqual(told.timeline.map((b) => b.beat), STORY_BEATS, 'all seven beats are present in order');
  assert.ok(told.timeline.every((b) => b.state === 'done'), 'a complete run lights every beat');

  // Fail closed: no dimensions means the receipt cannot corroborate any claim.
  const noDims = runStory({ goal: 'g', evidence: {} }, 'verified');
  assert.equal(noDims.degraded, true, 'a receipt without dimensions cannot tell its story');
  assert.match(noDims.sentences[0], /no status dimensions/i, 'it names why, instead of going quiet');
  assert.deepEqual(noDims.timeline.map((b) => b.beat), STORY_BEATS, 'the timeline still renders, as unknowns');

  // An unrecognised standing must not be narrated as if it were understood.
  const strange = runStory(base, 'gold_star');
  assert.equal(strange.degraded, true, 'an unknown standing degrades');
  assert.match(strange.sentences.at(-1), /does not recognise/i, 'and says so');

  // Same-vendor review may never read as independent.
  const advisory = {
    ...base,
    statuses: { ...base.statuses, audit: 'advisory_findings' },
    evidencePack: { ...base.evidencePack, statuses: { ...base.statuses, audit: 'advisory_findings' }, pairing: { executor: { actual: 'anthropic:claude-sonnet-4-6' }, auditor: { actual: 'anthropic:claude-opus-4-6' } } },
  };
  const advisoryProse = runStory(advisory, 'same_vendor_reviewed').sentences.join(' ');
  assert.ok(!/from a different vendor/.test(advisoryProse), 'a same-vendor audit never claims independence');
  assert.match(advisoryProse, /shared the maker’s vendor/, 'it names the limitation explicitly');
  assert.equal(runStory(advisory, 'same_vendor_reviewed').timeline.find((b) => b.beat === 'Independent challenge').state, 'skipped', 'same-vendor review never lights the independent-challenge beat');

  // Multiple rounds alone do not prove that a finding was re-raised.
  const freshEachRound = {
    ...base,
    evidence: {
      ...base.evidence,
      rounds: [
        { round: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'First issue' }] },
        { round: 2, verdict: 'REVISE', findings: [{ severity: 'medium', title: 'Different issue' }] },
      ],
    },
  };
  assert.ok(!/re-raising/.test(runStory(freshEachRound, 'verified_with_findings').sentences.join(' ')), 'different findings across rounds are not called repeats');

  // Audit-only replay must narrate the replay, not inherited maker work and
  // deterministic checks as if they ran again.
  const replay = {
    ...base,
    lane: 'audit_replay',
    sourceRunId: 'source-run',
    ground: false,
    evidence: {
      grounding: null,
      revisions: [{ rev: 2 }], // copied sealed artifact, not a replay draft
      rounds: [{ round: 'audit replay', verdict: 'APPROVED', findings: [] }],
      verify: [],
      humanDecisions: [],
    },
    evidencePack: {
      ...base.evidencePack,
      statuses: { ...base.statuses, audit: 'independent_clean' },
    },
  };
  const replayStory = runStory(replay, 'verified_with_findings');
  const replayProse = replayStory.sentences.join(' ');
  assert.match(replayProse, /replay ran no retrieval or drafting/i, 'replay names the work it deliberately did not repeat');
  assert.ok(!/Claude drafted/.test(replayProse), 'copied revisions never masquerade as replay maker work');
  assert.match(replayProse, /source artifact carried deterministic checks that passed with caveats; this replay did not rerun them/i, 'inherited verification is attributed to the source artifact');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Evidence frozen').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Draft').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Verification').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Independent challenge').state, 'done');

  // A failed verification is never softened into a pass.
  const failed = runStory({ ...base, statuses: { ...base.statuses, verification: 'failed' }, evidencePack: { ...base.evidencePack, statuses: { ...base.statuses, verification: 'failed' } } }, 'unverified');
  assert.match(failed.sentences.join(' '), /did not pass, so nothing here is verified/, 'a red verification is stated plainly');
  assert.equal(failed.timeline.find((b) => b.beat === 'Verification').state, 'failed', 'the beat shows failed, not done');

  // An ungrounded run says so rather than implying private evidence.
  const ungrounded = runStory({ ...base, ground: false, evidence: { ...base.evidence, grounding: null } }, 'verified_with_findings');
  assert.match(ungrounded.sentences.join(' '), /did not retrieve a private knowledge snapshot/, 'an ungrounded run is explicit without inventing open-web use');
  assert.equal(ungrounded.timeline.find((b) => b.beat === 'Evidence frozen').state, 'skipped', 'the beat is skipped, not falsely done');

  // Rehearsal is a first-class non-trust standing, never an unknown headline
  // and never an independent audit just because scripted rounds exist.
  const rehearsal = {
    ...base,
    engine: 'mock',
    simulated: true,
    statuses: { ...base.statuses, audit: 'not_run' },
    evidencePack: {
      ...base.evidencePack,
      statuses: { ...base.statuses, audit: 'not_run' },
      pairing: { executor: { actual: 'simulation:scripted-maker' }, auditor: { actual: 'simulation:scripted-reviewer' } },
    },
  };
  const rehearsalStory = runStory(rehearsal, 'rehearsal');
  assert.equal(rehearsalStory.degraded, false, 'rehearsal is recognised without promoting it');
  assert.equal(rehearsalStory.headline, 'Rehearsal');
  assert.match(rehearsalStory.sentences.join(' '), /no real model audit ran and it cannot earn verified standing/i);
  assert.equal(rehearsalStory.timeline.find((b) => b.beat === 'Independent challenge').state, 'skipped');
}

// --- one standing vocabulary, and the derivation behind it ------------------
// The run bar, Recents and the story card all read standings from story.mjs, so
// a receipt can never be worded three ways. An unrecognised standing has no
// label on purpose — callers must fail closed instead of printing a raw token.
{
  const { effectiveStanding, standingLabel, standingPill, standingExplanation } = await import('./public/story.mjs');

  assert.equal(standingLabel('verified_with_findings'), 'Verified with findings');
  assert.equal(standingLabel('same_vendor_reviewed'), 'Reviewed by the same vendor');
  assert.equal(standingLabel('gold_star'), null, 'an unrecognised standing has no label, so callers fail closed');
  assert.equal(standingLabel(undefined), null, 'a missing standing has no label');
  assert.equal(effectiveStanding(undefined, true), 'rehearsal', 'a legacy mock event cannot lose its rehearsal standing merely because it predates headline decoration');
  assert.equal(effectiveStanding('verified', true), 'rehearsal', 'the sealed simulation fact outranks any trust-like presentation headline');
  assert.equal(effectiveStanding('verified', false), 'verified', 'real runs keep the receipt-derived standing');
  assert.deepEqual(standingPill('done_with_findings', 'unverified'), {
    label: 'Not verified', className: 'standing danger', derived: true, claim: false,
  }, 'the receipt-backed label also owns its danger styling; it cannot inherit the gate claim’s success colour');
  assert.deepEqual(standingPill('running', undefined), {
    label: 'running', className: 'status running', derived: false, claim: false,
  }, 'a live operational state is honest without a terminal standing and is never mislabeled as an uncorroborated claim');
  assert.deepEqual(standingPill('done', undefined), {
    label: 'done', className: 'status done claim', derived: false, claim: true,
  }, 'a terminal gate claim without receipt standing stays visible but explicitly claim-styled');
  assert.equal(standingPill('done', 'rehearsal').className, 'standing rehearsal', 'a rehearsal has its own non-trust tone');

  const dims = (over = {}) => ({ schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published', ...over });

  const agreed = standingExplanation({ status: 'done_with_findings', statuses: dims() }, 'verified_with_findings');
  assert.equal(agreed.disagrees, false, 'a corroborated gate claim does not read as a conflict');
  assert.equal(agreed.standing, 'Verified with findings');
  assert.equal(agreed.gateClaim, 'done_with_findings', 'the loop’s own claim stays visible beside the standing');
  assert.equal(agreed.lines.length, 4, 'all four dimensions are explained');
  assert.match(agreed.lines.join(' '), /different vendor/, 'independent audit is named as such');

  // The case the trust layer exists for: the loop claims success, the receipt does not.
  const conflict = standingExplanation({ status: 'done', statuses: dims({ verification: 'failed', audit: 'not_run' }) }, 'unverified');
  assert.equal(conflict.disagrees, true, 'a success claim over a receipt that does not support it IS a conflict');
  assert.match(conflict.lines.join(' '), /did not pass/, 'the failing dimension is stated plainly');
  assert.match(conflict.lines.join(' '), /No independent review ran/, 'the missing audit is stated plainly');

  // Advisory standing is not a success, so a done claim over it still conflicts.
  assert.equal(standingExplanation({ status: 'done', statuses: dims({ audit: 'advisory_clean' }) }, 'same_vendor_reviewed').disagrees, true,
    'same-vendor review never satisfies a done claim');

  // A non-success claim over a non-success standing is agreement, not conflict.
  assert.equal(standingExplanation({ status: 'verify_failed', statuses: dims({ verification: 'failed' }) }, 'unverified').disagrees, false,
    'an honest red claim matching an unverified standing is not a conflict');

  assert.equal(standingExplanation({ status: 'verify_failed', statuses: dims() }, 'verified_with_findings').disagrees, true,
    'disagreement is detected in the other direction too: a red gate claim cannot silently wear a green standing');

  assert.equal(standingExplanation({
    status: 'done_with_findings',
    statuses: dims({ verification: 'passed', audit: 'independent_clean' }),
  }, 'verified').disagrees, true,
  'a clean derived standing cannot silently erase the gate’s narrower claim that findings remained');

  assert.equal(standingExplanation({ status: 'done', statuses: dims() }, 'verified_with_findings').disagrees, false,
    'plain done does not claim a caveat-free receipt, so recorded findings remain compatible');

  assert.equal(standingExplanation({ status: 'done', simulated: true, statuses: dims({ audit: 'not_run' }) }, 'rehearsal').disagrees, false,
    'a successfully completed rehearsal is not a contradiction; completion and non-evidence are orthogonal');

  // Unknown schema fails closed rather than explaining a standing it cannot derive.
  const legacy = standingExplanation({ status: 'done', statuses: { schemaVersion: 99, execution: 'completed' } }, 'verified');
  assert.equal(legacy.lines.length, 1, 'an unrecognised schema explains nothing');
  assert.match(legacy.lines[0], /cannot be derived from evidence/, 'and says why');

  // An unrecognised dimension VALUE is named, never silently dropped.
  const odd = standingExplanation({ status: 'done', statuses: dims({ audit: 'banana' }) }, 'verified');
  assert.match(odd.lines.join(' '), /does not recognise/, 'an unknown dimension value is surfaced');
  assert.equal(odd.lines.length, 4, 'and still occupies its slot');
}

// --- Recents grouping: the artifact hash is the ONLY grouping authority ------
{
  const { groupRuns, armFacts, comparisonNote, shortHash } = await import('./public/grouping.mjs');
  const A = 'sha256:' + 'a'.repeat(64);
  const B = 'sha256:' + 'b'.repeat(64);
  const replay = (id, artifactId, over = {}) => ({ id, lane: 'audit_replay', artifactId, status: 'done', headline: 'verified', startedAt: 100, goal: 'g', ...over });

  // Two replays of ONE artifact become a single comparison; a lone one does not.
  const grouped = groupRuns([replay('r1', A, { effortRequested: 'high', startedAt: 200 }), replay('r2', A, { effortRequested: 'low', startedAt: 100 }), replay('solo', B)]);
  assert.deepEqual(grouped.map((e) => e.kind), ['audit_comparison', 'run'], 'a pair groups; a single replay stays an ordinary row');
  assert.deepEqual(grouped[0].arms.map((a) => a.effortRequested), ['low', 'high'], 'arms read weakest to strongest requested effort, not by finish time');
  assert.equal(grouped[0].artifactId, A);
  assert.equal(grouped[0].arms.length, 2);

  // Similar goals, adjacent timestamps and matching models must NEVER group.
  const lookalikes = groupRuns([
    replay('x', A, { goal: 'same goal', startedAt: 500 }),
    replay('y', B, { goal: 'same goal', startedAt: 500 }),
  ]);
  assert.deepEqual(lookalikes.map((e) => e.kind), ['run', 'run'], 'identical goals and timestamps over DIFFERENT artifacts never group');

  // Non-replays and malformed hashes are never folded in.
  assert.deepEqual(groupRuns([
    replay('a', A), replay('b', A),
    { id: 'normal', lane: 'research_memo', artifactId: A, status: 'done', startedAt: 1 },
  ]).map((e) => e.kind), ['audit_comparison', 'run'], 'a normal run sharing the artifact is not an audit arm');
  assert.deepEqual(groupRuns([replay('m1', 'not-a-hash'), replay('m2', 'not-a-hash')]).map((e) => e.kind), ['run', 'run'], 'a malformed artifact id never becomes a grouping key');
  assert.deepEqual(groupRuns([replay('n1', null), replay('n2', null)]).map((e) => e.kind), ['run', 'run'], 'a missing artifact id never groups');

  // Failed and incomplete arms are RETAINED — a comparison is a record, not a highlight reel.
  const withFailure = groupRuns([replay('ok', A, { effortRequested: 'low' }), replay('bad', A, { effortRequested: 'high', status: 'failed', headline: 'unverified' })]);
  assert.equal(withFailure[0].arms.length, 2, 'a failed arm stays in the comparison');
  assert.ok(withFailure[0].arms.some((a) => a.status === 'failed'), 'and keeps its real status');

  // Unreported facts read as unreported — never zero, never inferred.
  const sparse = armFacts({ effortRequested: 'high' });
  assert.equal(sparse.effortActual, 'not reported', 'unapplied-effort is never invented from the request');
  assert.equal(sparse.outputTokens, null, 'missing tokens are null, not 0');
  assert.equal(sparse.durationSeconds, null, 'missing duration is null, not 0');
  assert.equal(sparse.findings, null, 'missing finding count is null, not 0');
  assert.equal(sparse.receipt, null, 'a missing receipt hash is null');
  const full = armFacts({ effortRequested: 'low', effortActual: 'low', auditorActual: 'openai:gpt-5.6-sol', outputTokens: 777, durationMs: 26040, findingCount: 0, receiptId: A });
  assert.equal(full.durationSeconds, 26, 'duration renders in seconds');
  assert.equal(full.findings, 0, 'a real zero findings is preserved, distinct from unrecorded');
  assert.equal(full.receipt, 'a'.repeat(12), 'the receipt hash is shortened for display');
  assert.equal(full.auditorActual, 'openai:gpt-5.6-sol');
  assert.equal(armFacts({ outputTokens: -1, durationMs: 1.5, findingCount: -2 }).outputTokens, null, 'invalid usage never renders as receipt fact');
  assert.equal(shortHash('nope'), null, 'a malformed hash has no short form');

  const matchedNote = comparisonNote([
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'low' },
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'high' },
  ]);
  assert.match(matchedNote, /assigned the same sealed artifact/, 'failed or incomplete attempts are never narrated as if they completed an audit');
  assert.match(matchedNote, /recorded auditor matches.*requested effort differs/i, 'an effort comparison is described only when the recorded auditor also matches');
  assert.doesNotMatch(matchedNote, /cost/i, 'tokens and time are usage, never silently promoted into economic cost');
  assert.match(comparisonNote([
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'low' },
    { auditorActual: 'openai:gpt-5.4', effortRequested: 'high' },
  ]), /not an effort-only comparison/i, 'same artifact with different auditors is grouped but named as confounded');
  assert.match(comparisonNote([{ effortRequested: 'low' }, { effortRequested: 'high' }]), /not proven to be an effort-only comparison/i, 'missing auditor identity fails closed');
}

console.log('verify.test: all assertions passed');
