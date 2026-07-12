#!/usr/bin/env node
// Regenerate benchmark/PENDING-ADJUDICATION.md from the record files on disk.
// Run after any adjudication batch; ingest-reviews.mjs uses the same generator
// on first seed. Records are the source of truth; the worksheet is disposable.
//
//   node worksheet.mjs [--records <dir>]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The frozen adjudication rules (2026-07-12) travel with the worksheet so a
// regeneration never sheds them.
export const WORKSHEET_HEADER = [
  '# Pending adjudication',
  '',
  '**Temporal rule (frozen 2026-07-12):** judge the finding against the exact',
  'artifact that was audited, using evidence available from that state or its',
  'history — not current HEAD. A later repair confirms that maintainers acted',
  'on something; it does not alone prove the reviewer’s original mechanism,',
  'location, or severity. Truth (`adjudication`), severity (`severity_after`),',
  'reproducibility (`deterministic_repro`), and repair (`repair_outcome`) are',
  'separate judgments.',
  '',
  '- `confirmed` — the claimed defect existed materially as described.',
  '- `partially_correct` — a real issue existed, but mechanism, scope, location,',
  '  or severity was materially wrong.',
  '- `rejected` — the audited artifact contradicts the finding.',
  '- `unresolved` — evidence is insufficient. Unresolved is a strength; never',
  '  force a label for corpus completeness.',
  '',
  'Clean-verdict rounds are auditor outputs, never known-clean controls.',
  'Mark records `sensitivity: "secret_redacted"` if anything sensitive survived scrubbing.',
  'Clean controls and seeded defects are separate records (source: clean_control / seeded_defect) — historical rounds alone carry survivorship bias.',
  '',
];

export function worksheetLines(records) {
  const lines = [...WORKSHEET_HEADER];
  for (const r of records) {
    const open = r.findings.filter((f) => f.adjudication === 'unresolved').length;
    const done = r.findings.length - open;
    lines.push(`- [${open === 0 && r.findings.length > 0 ? 'x' : ' '}] **${r.id}** — round ${r.artifact_ref.round}, verdict: ${r.verdict ?? 'unknown'}, ${r.findings.length} finding(s)${done ? ` (${done} adjudicated)` : ''}`);
    for (const f of r.findings) {
      const mark = f.adjudication === 'unresolved' ? ' ' : 'x';
      const label = f.adjudication === 'unresolved' ? '' : ` → ${f.adjudication}`;
      lines.push(`  - [${mark}] ${f.title}${f.priority != null ? ` (P${f.priority})` : ''}${label}`);
    }
  }
  return lines;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--records');
  const DIR = i >= 0 && args[i + 1] ? args[i + 1] : join(import.meta.dirname, 'benchmark', 'records');
  const records = [];
  for (const f of (await readdir(DIR)).filter((x) => x.endsWith('.json')).sort()) {
    records.push(JSON.parse(await readFile(join(DIR, f), 'utf8')));
  }
  const out = join(import.meta.dirname, 'benchmark', 'PENDING-ADJUDICATION.md');
  await writeFile(out, worksheetLines(records).join('\n') + '\n');
  const open = records.reduce((n, r) => n + r.findings.filter((f) => f.adjudication === 'unresolved').length, 0);
  console.log(`worksheet regenerated: ${records.length} records, ${open} findings still unresolved`);
}
