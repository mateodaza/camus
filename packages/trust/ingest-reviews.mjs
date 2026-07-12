#!/usr/bin/env node
// Redact-by-default corpus ingestion: turns ~/.camus/reviews round receipts
// into benchmark-record/v1 candidates awaiting human adjudication.
//
//   node ingest-reviews.mjs [--reviews-dir <dir>] [--out <dir>] [--include-raw]
//
// Defaults: reviews from ~/.camus/reviews, records to ./benchmark/records.
// Redaction is on unless --include-raw is passed (and even then secrets are
// scrubbed — --include-raw only preserves diff-like fields, which these
// receipts do not carry today). Adjudication fields are set to "unresolved":
// the human fills them; the tool never guesses truth.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { redactFinding, scrubText } from './lib/redact.mjs';
import { validateBenchmarkRecord } from './lib/validate.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const REVIEWS_DIR = opt('--reviews-dir', join(homedir(), '.camus', 'reviews'));
const OUT_DIR = opt('--out', join(import.meta.dirname, 'benchmark', 'records'));
const INCLUDE_RAW = flag('--include-raw');

if (!existsSync(REVIEWS_DIR)) {
  console.error(`no reviews directory at ${REVIEWS_DIR}`);
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });

const files = (await readdir(REVIEWS_DIR)).filter((f) => /-r\d+\.json$/.test(f));
const written = [];
const skipped = [];

for (const file of files.sort()) {
  let envelope;
  try {
    envelope = JSON.parse(await readFile(join(REVIEWS_DIR, file), 'utf8'));
  } catch (e) {
    skipped.push(`${file}: unreadable (${e.message.slice(0, 60)})`);
    continue;
  }
  // Receipts are audit envelopes: {ran_at, worktree, round, codex_exit, ran,
  // codex_raw (stringified verdict), codex_parsed}. Older/other shapes may be
  // the bare verdict — accept both, prefer the parsed form.
  let raw = envelope;
  if (envelope.codex_parsed && typeof envelope.codex_parsed === 'object') raw = envelope.codex_parsed;
  else if (typeof envelope.codex_raw === 'string') {
    try { raw = JSON.parse(envelope.codex_raw); }
    catch { skipped.push(`${file}: codex_raw unparseable`); continue; }
  }
  if (envelope.ran === false) {
    skipped.push(`${file}: reviewer did not run (infra round) — candidate for source=malformed_receipt, add manually if wanted`);
    continue;
  }
  const m = file.match(/^(.*)-r(\d+)\.json$/);
  const worktree = String(envelope.worktree ?? m[1]);
  const round = Number.isInteger(envelope.round) ? envelope.round : Number(m[2]);

  // Optional companion metadata from the watch dir.
  let meta = null;
  try {
    meta = JSON.parse(await readFile(join(REVIEWS_DIR, `${file.replace(/\.json$/, '')}.watch`, 'meta.json'), 'utf8'));
  } catch { /* absent on many rounds */ }

  const findings = (raw.findings ?? []).map((f) =>
    redactFinding(
      {
        title: String(f.title ?? 'untitled finding'),
        body: f.body != null ? String(f.body) : null,
        code_location: f.code_location != null ? String(f.code_location) : null,
        priority: Number.isInteger(f.priority) ? f.priority : null,
        confidence: typeof f.confidence_score === 'number' ? f.confidence_score : null,
        adjudication: 'unresolved',
        severity_before: Number.isInteger(f.priority) ? f.priority : null,
        severity_after: null,
        deterministic_repro: null,
        repair_outcome: null,
      },
      { includeRaw: INCLUDE_RAW },
    ),
  );

  const record = {
    schemaVersion: 1,
    id: basename(file, '.json'),
    source: 'historical',
    executor: { provider: 'anthropic', model: null, effort: null },
    auditor: { provider: 'openai', model: null, effort: meta?.effort ?? null },
    artifact_ref: { artifact_id: null, commit: null, worktree: scrubText(worktree), round },
    verdict: raw.overall_correctness != null ? String(raw.overall_correctness) : null,
    findings,
    economics: null,
    sensitivity: 'internal',
    is_clean_control: false,
    verdict_clean: raw.overall_correctness === 'patch is correct' ? true : raw.overall_correctness === 'patch is incorrect' ? false : null,
    notes: scrubText(`ingested ${new Date().toISOString().slice(0, 10)} from ${file}${Number.isInteger(envelope.ran_at) ? `; reviewed ${new Date(envelope.ran_at * 1000).toISOString().slice(0, 10)}` : ''}; adjudication pending`),
  };

  const v = validateBenchmarkRecord(record);
  if (!v.ok) {
    skipped.push(`${file}: ${v.error}`);
    continue;
  }
  await writeFile(join(OUT_DIR, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
  written.push(record);
}

// The adjudication worksheet — the human's half of curation.
const lines = [
  '# Pending adjudication',
  '',
  'For each finding: set `adjudication` (confirmed | rejected | partially_correct | unresolved),',
  '`severity_after`, `deterministic_repro`, and `repair_outcome` in the record file.',
  'Mark records `sensitivity: "secret_redacted"` if anything sensitive survived scrubbing.',
  'Clean controls and seeded defects are separate records (source: clean_control / seeded_defect) — historical rounds alone carry survivorship bias.',
  '',
];
for (const r of written) {
  lines.push(`- [ ] **${r.id}** — round ${r.artifact_ref.round}, verdict: ${r.verdict ?? 'unknown'}, ${r.findings.length} finding(s)`);
  for (const f of r.findings) lines.push(`  - [ ] ${f.title}${f.priority != null ? ` (P${f.priority})` : ''}`);
}
await writeFile(join(import.meta.dirname, 'benchmark', 'PENDING-ADJUDICATION.md'), lines.join('\n') + '\n');

console.log(`ingested ${written.length} record(s) → ${OUT_DIR}`);
console.log(`findings awaiting adjudication: ${written.reduce((n, r) => n + r.findings.length, 0)}`);
if (skipped.length) {
  console.log(`skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  - ${s}`);
}
console.log('worksheet: benchmark/PENDING-ADJUDICATION.md');
