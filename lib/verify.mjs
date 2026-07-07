// Deterministic verifier for marketing deliverables.
// Every check here is mechanical: it either passes or it fails with evidence.
// No model is consulted — this is the stage that cannot be sweet-talked.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMPLIANCE = JSON.parse(
  readFileSync(join(__dirname, '..', 'checks', 'compliance.json'), 'utf8'),
);

export const LANES = {
  research_memo: {
    label: 'Research memo',
    requiredSections: ['Summary', 'Key Findings', 'Sources'],
  },
  competitor_teardown: {
    label: 'Competitor teardown',
    requiredSections: ['Overview', 'Positioning', 'Channels', 'What We Take', 'Sources'],
  },
  freeform: {
    label: 'Freeform',
    requiredSections: [],
  },
};

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

export function extractUrls(markdown) {
  const urls = new Set();
  // Markdown links [text](url) and bare URLs.
  const linkRe = /\]\((https?:\/\/[^\s)]+)\)/g;
  const bareRe = /(?<![(\]])\bhttps?:\/\/[^\s<>)\]"']+/g;
  let m;
  while ((m = linkRe.exec(markdown))) urls.add(m[1].replace(/[.,;:]+$/, ''));
  while ((m = bareRe.exec(markdown))) urls.add(m[0].replace(/[.,;:]+$/, ''));
  return [...urls];
}

function extractSections(markdown) {
  const sections = [];
  for (const line of markdown.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) sections.push(h[1].trim());
  }
  return sections;
}

// Sentences that carry a quantitative claim: numbers with %, $, x-multiples,
// "million/billion", or 4+ digit figures. Citation = [n] / [Hn] marker or an
// inline link inside the same sentence.
export function findUnsourcedStats(markdown) {
  const body = markdown
    .split(/^#{1,3}\s+Sources\s*$/im)[0] // claims inside the Sources list are the sources
    .replace(/```[\s\S]*?```/g, ''); // ignore code blocks

  const sentences = body
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const statRe =
    /(\d+(\.\d+)?\s*%)|(\$\s?\d[\d,.]*)|(\b\d+(\.\d+)?x\b)|(\b\d[\d,.]*\s*(million|billion|bn|mm|m\b|k\b))|(\b\d{4,}\b)/i;
  const citeRe = /\[(H?\d+)\]|\]\(https?:\/\//;
  const yearRe = /^\s*(19|20)\d{2}\s*$/;

  const offenders = [];
  for (const s of sentences) {
    if (s.startsWith('#') || s.startsWith('>')) continue;
    const stat = s.match(statRe);
    if (!stat) continue;
    if (yearRe.test(stat[0])) continue; // a bare year is not a claim
    if (citeRe.test(s)) continue;
    offenders.push(s.length > 180 ? s.slice(0, 177) + '…' : s);
  }
  return offenders;
}

export function findComplianceHits(markdown) {
  const hits = [];
  for (const { pattern, label, why, severity } of COMPLIANCE.patterns) {
    const re = new RegExp(pattern, 'gi');
    let m;
    while ((m = re.exec(markdown))) {
      const start = Math.max(0, m.index - 40);
      const excerpt = markdown.slice(start, m.index + m[0].length + 40).replace(/\n/g, ' ');
      hits.push({ label, why, severity, match: m[0], excerpt: `…${excerpt}…` });
    }
  }
  return hits;
}

async function checkUrl(url, timeoutMs = 8000) {
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'user-agent': 'camus-loop-studio/0.1 (link check)' },
      });
      return res.status;
    } finally {
      clearTimeout(t);
    }
  };
  try {
    let status = await attempt('HEAD');
    // Many sites reject HEAD; retry with GET before judging.
    if (status >= 400) status = await attempt('GET');
    return { url, status, ok: status < 400 };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.cause?.code || err.message) };
  }
}

// ---------------------------------------------------------------------------
// The gate. Returns { pass, checks: [{ id, label, status, detail, evidence }] }
// status: 'pass' | 'fail' | 'warn' | 'skip'
// ---------------------------------------------------------------------------

export async function runVerify(markdown, lane = 'freeform', { onCheck, skipNetwork = false } = {}) {
  const checks = [];
  const emit = (c) => {
    checks.push(c);
    onCheck?.(c);
  };

  // 1. Structure
  const laneDef = LANES[lane] ?? LANES.freeform;
  if (laneDef.requiredSections.length) {
    const present = extractSections(markdown).map((s) => s.toLowerCase());
    const missing = laneDef.requiredSections.filter(
      (s) => !present.some((p) => p.includes(s.toLowerCase())),
    );
    emit({
      id: 'structure',
      label: `Structure: ${laneDef.label} sections`,
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length
        ? `Missing required section(s): ${missing.join(', ')}`
        : `All required sections present (${laneDef.requiredSections.join(', ')})`,
      evidence: missing,
    });
  } else {
    emit({ id: 'structure', label: 'Structure', status: 'skip', detail: 'Freeform lane — no required sections.', evidence: [] });
  }

  // 2. Links resolve
  const urls = extractUrls(markdown);
  if (!urls.length) {
    emit({
      id: 'links',
      label: 'Links resolve',
      status: lane === 'freeform' ? 'warn' : 'fail',
      detail: 'No URLs found. A researched deliverable must cite live sources.',
      evidence: [],
    });
  } else if (skipNetwork) {
    emit({ id: 'links', label: 'Links resolve', status: 'skip', detail: `${urls.length} URL(s) found — network check skipped.`, evidence: urls });
  } else {
    const results = await Promise.all(urls.slice(0, 24).map((u) => checkUrl(u)));
    const dead = results.filter((r) => !r.ok);
    emit({
      id: 'links',
      label: 'Links resolve',
      status: dead.length ? 'fail' : 'pass',
      detail: dead.length
        ? `${dead.length} of ${results.length} link(s) dead: ${dead.map((d) => `${d.url} (${d.error || d.status})`).join('; ')}`
        : `All ${results.length} link(s) returned < 400`,
      evidence: dead,
    });
  }

  // 3. Every stat has a source
  const offenders = findUnsourcedStats(markdown);
  emit({
    id: 'stats',
    label: 'Quantitative claims cite sources',
    status: offenders.length ? 'fail' : 'pass',
    detail: offenders.length
      ? `${offenders.length} sentence(s) carry numbers with no [n] citation or inline link.`
      : 'Every quantitative claim carries a citation marker or inline link.',
    evidence: offenders,
  });

  // 4. Compliance wordlist
  const hits = findComplianceHits(markdown);
  const failing = hits.filter((h) => h.severity === 'fail');
  const warning = hits.filter((h) => h.severity === 'warn');
  emit({
    id: 'compliance',
    label: 'Web3 compliance phrases',
    status: failing.length ? 'fail' : warning.length ? 'warn' : 'pass',
    detail: failing.length
      ? `${failing.length} blocking phrase(s): ${failing.map((h) => `“${h.match}” (${h.label})`).join('; ')}`
      : warning.length
        ? `${warning.length} phrase(s) to eyeball: ${warning.map((h) => `“${h.match}” (${h.label})`).join('; ')}`
        : 'No flagged phrasing.',
    evidence: hits,
  });

  // 5. Sources section sanity: [n] markers must map to numbered sources.
  const markers = [...new Set([...markdown.matchAll(/\[(\d+)\]/g)].map((m) => m[1]))];
  if (markers.length) {
    const srcSection = markdown.split(/^#{1,3}\s+Sources\s*$/im)[1] ?? '';
    const defined = new Set([...srcSection.matchAll(/^\s*(?:\[?(\d+)\]?[.:)\]]\s|\[(\d+)\]\s)/gm)].map((m) => m[1] || m[2]));
    const dangling = markers.filter((n) => !defined.has(n));
    emit({
      id: 'citations',
      label: 'Citation markers map to Sources',
      status: dangling.length ? 'fail' : 'pass',
      detail: dangling.length
        ? `Marker(s) [${dangling.join('], [')}] have no matching entry under Sources.`
        : `${markers.length} citation marker(s) all resolve to Sources entries.`,
      evidence: dangling,
    });
  } else {
    emit({ id: 'citations', label: 'Citation markers map to Sources', status: 'skip', detail: 'No [n] markers used.', evidence: [] });
  }

  const pass = checks.every((c) => c.status !== 'fail');
  return { pass, checks };
}
