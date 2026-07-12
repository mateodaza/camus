#!/usr/bin/env node
// The first auditor baseline: computed from adjudicated benchmark records.
// Rates are reported over the ADJUDICATED subset only — unresolved findings
// are counted, never guessed into a denominator.
//
//   node baseline.mjs [--records <dir>] [--out <file>]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DIR = opt('--records', join(import.meta.dirname, 'benchmark', 'records'));
const OUT = opt('--out', join(import.meta.dirname, 'benchmark', 'BASELINE.md'));

const records = [];
for (const f of (await readdir(DIR)).filter((x) => x.endsWith('.json'))) {
  records.push(JSON.parse(await readFile(join(DIR, f), 'utf8')));
}

const findings = records.flatMap((r) => r.findings.map((f) => ({ ...f, record: r.id, source: r.source })));
const by = (xs, fn) => xs.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] ?? 0) + 1), m), {});

const adjudicated = findings.filter((f) => f.adjudication !== 'unresolved');
const confirmed = findings.filter((f) => f.adjudication === 'confirmed');
const rejected = findings.filter((f) => f.adjudication === 'rejected');
const partial = findings.filter((f) => f.adjudication === 'partially_correct');
const unresolved = findings.filter((f) => f.adjudication === 'unresolved');

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

// Severity accuracy: among confirmed findings with a post-adjudication
// severity, how often the auditor's grade stood, and the mean shift.
const graded = confirmed.filter((f) => Number.isInteger(f.severity_before) && Number.isInteger(f.severity_after));
const exact = graded.filter((f) => f.severity_before === f.severity_after);
const meanShift = graded.length
  ? (graded.reduce((s, f) => s + (f.severity_after - f.severity_before), 0) / graded.length).toFixed(2)
  : '—';

// Deterministic reproducibility among confirmed (nulls = not assessed).
const reproAssessed = confirmed.filter((f) => typeof f.deterministic_repro === 'boolean');
const reproTrue = reproAssessed.filter((f) => f.deterministic_repro);

const cleanVerdictRecords = records.filter((r) => r.verdict_clean === true);

const lines = [
  '# Auditor baseline — first cut',
  '',
  `Computed ${new Date().toISOString().slice(0, 10)} over ${records.length} records / ${findings.length} findings.`,
  'Rates use the adjudicated subset only; unresolved findings are counted, never guessed.',
  '',
  '## Corpus',
  `- records: ${records.length} (${Object.entries(by(records, (r) => r.source)).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
  `- clean-verdict rounds (auditor said "patch is correct"): ${cleanVerdictRecords.length}`,
  `- findings: ${findings.length} — by priority: ${Object.entries(by(findings.filter((f) => f.priority != null), (f) => `P${f.priority}`)).sort().map(([k, v]) => `${k}: ${v}`).join(', ')}`,
  '',
  '## Adjudication coverage',
  `- adjudicated: ${adjudicated.length}/${findings.length} (${pct(adjudicated.length, findings.length)})`,
  `- unresolved (awaiting human/evidence): ${unresolved.length} (${pct(unresolved.length, findings.length)})`,
  '',
  '## Rates over the adjudicated subset',
  `- confirmation rate: ${confirmed.length}/${adjudicated.length} (${pct(confirmed.length, adjudicated.length)})`,
  `- rejection rate: ${rejected.length}/${adjudicated.length} (${pct(rejected.length, adjudicated.length)})`,
  `- partially correct: ${partial.length}/${adjudicated.length} (${pct(partial.length, adjudicated.length)})`,
  `- severity accuracy (confirmed, graded): ${exact.length}/${graded.length} exact (${pct(exact.length, graded.length)}), mean shift ${meanShift}`,
  `- deterministic reproducibility (confirmed, assessed): ${reproTrue.length}/${reproAssessed.length} (${pct(reproTrue.length, reproAssessed.length)})`,
  '',
  '## Confirmed findings by priority',
  ...Object.entries(by(confirmed.filter((f) => f.priority != null), (f) => `P${f.priority}`)).sort().map(([k, v]) => `- ${k}: ${v}`),
  '',
  '## Honest caveats',
  '- Temporal rule (frozen): findings are judged against the exact artifact state that was audited — a later repair proves action, not the reviewer\'s mechanism.',
  '- The adjudicated subset is evidence-selected (documented memory + repository archaeology), so the confirmation rate is biased toward findings that left traces — it is a floor of provenance, not an unbiased estimate. No marketing claims and no routing decisions from these numbers until representative adjudication plus known-clean and seeded controls exist.',
  '- Historical rounds carry survivorship bias by construction; clean controls, seeded defects, and same-vendor baselines are still to be added as separate source-typed records.',
  '- All records currently share one pairing (anthropic executor / openai auditor, models unrecorded in the era\'s receipts) — no cross-pairing comparison is possible yet.',
  '',
];
const md = lines.join('\n');
await writeFile(OUT, md + '\n');
console.log(md);
console.log(`written: ${OUT}`);
