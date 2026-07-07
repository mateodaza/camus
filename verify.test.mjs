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

// --- gate: live link check (only when network is available) ------------------
if (process.env.TEST_NETWORK === '1') {
  const dead = GOOD + '\n3. Archive — https://github.com/Myosin-xyz/does-not-exist-archive\n';
  const res = await runVerify(dead.replace('[2]', '[2][3]').replace(/2\. Developer/, '2. Developer'), 'research_memo', {});
  const links = res.checks.find((c) => c.id === 'links');
  assert.equal(links.status, 'fail', 'dead link fails the gate');
}

console.log('verify.test: all assertions passed');
