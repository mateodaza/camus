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
    /(\d+(\.\d+)?\s*%)|(\$\s?\d[\d,.]*)|(\b\d+(\.\d+)?x\b)|(\b\d[\d,.]*\s*(million|billion|bn|mm|m\b|k\b))|(\b\d{4,}\b)/gi;
  const citeRe = /\[(H?\d+)\]|\]\(https?:\/\//;
  const yearRe = /^(19|20)\d{2}$/;

  const offenders = [];
  for (const s of sentences) {
    if (s.startsWith('#') || s.startsWith('>')) continue;
    if (citeRe.test(s)) continue;
    // Every numeric match counts; bare years are discarded individually so a
    // leading "In 2024, …" can't exempt the real stat that follows it.
    const stats = [...s.matchAll(statRe)].map((m) => m[0].trim()).filter((t) => !yearRe.test(t));
    if (!stats.length) continue;
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

// Classification, not a boolean: 'ok' (< 400), 'blocked' (401/403/429 — the
// site is up but refuses non-browser clients, so the check can't verify it
// either way), 'dead' (the server answered with any other ≥ 400 status),
// 'unreachable' (no answer at all — DNS failure, timeout, connection reset;
// still fails the gate, but honestly: "could not verify" is not "confirmed
// dead", and a fix pass must not delete good sources over a network blip).
async function checkUrl(url, timeoutMs = 8000) {
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      return res.status;
    } finally {
      clearTimeout(t);
    }
  };
  const errOf = (err) => (err.name === 'AbortError' ? 'timeout' : String(err.cause?.code || err.message));
  try {
    let status;
    try {
      status = await attempt('HEAD');
    } catch {
      status = 600; // some hosts reset HEAD connections — judge on GET below
    }
    // Many sites reject HEAD; retry with GET before judging.
    if (status >= 400) status = await attempt('GET');
    const cls = status < 400 ? 'ok' : [401, 403, 429].includes(status) ? 'blocked' : 'dead';
    return { url, status, class: cls };
  } catch (err) {
    return { url, status: 0, class: 'unreachable', error: errOf(err) };
  }
}

// All URLs get checked (a green that skipped inputs is not a green), with
// bounded concurrency so a link-heavy memo doesn't stampede the network.
async function checkUrls(urls, batch = 8) {
  const results = [];
  for (let i = 0; i < urls.length; i += batch) {
    results.push(...(await Promise.all(urls.slice(i, i + batch).map((u) => checkUrl(u)))));
  }
  return results;
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
    const results = await checkUrls(urls);
    const dead = results.filter((r) => r.class === 'dead');
    const unreachable = results.filter((r) => r.class === 'unreachable');
    const blocked = results.filter((r) => r.class === 'blocked');
    const networkDown = unreachable.length === results.length && results.length > 1;
    emit({
      id: 'links',
      label: 'Links resolve',
      status: dead.length || unreachable.length ? 'fail' : blocked.length ? 'warn' : 'pass',
      detail: networkDown
        ? `All ${results.length} link(s) unreachable — the network looks down; could not verify anything (this is not evidence the links are dead).`
        : dead.length || unreachable.length
          ? [
              dead.length ? `${dead.length} of ${results.length} link(s) dead: ${dead.map((d) => `${d.url} (${d.status})`).join('; ')}` : '',
              unreachable.length ? `${unreachable.length} unreachable (could not verify): ${unreachable.map((d) => `${d.url} (${d.error})`).join('; ')}` : '',
            ].filter(Boolean).join(' · ')
          : blocked.length
            ? `${blocked.length} link(s) bot-blocked (${blocked.map((b) => `${b.url} → ${b.status}`).join('; ')}) — the check can't verify them, open them yourself`
            : `All ${results.length} link(s) returned < 400`,
      evidence: [...dead, ...unreachable, ...blocked],
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

  // 5. Sources section sanity: every [n] and [Hn] marker used in the body must
  // map to an entry under ## Sources. Markers are collected from the body only,
  // so a Sources entry can't vouch for itself.
  const bodyOnly = markdown.split(/^#{1,3}\s+Sources\s*$/im)[0];
  const srcSection = markdown.split(/^#{1,3}\s+Sources\s*$/im)[1] ?? '';
  const nMarkers = [...new Set([...bodyOnly.matchAll(/\[(\d+)\]/g)].map((m) => m[1]))];
  const hMarkers = [...new Set([...bodyOnly.matchAll(/\[H(\d+)\]/gi)].map((m) => m[1]))];
  if (nMarkers.length || hMarkers.length) {
    // Parse entries structurally: entry number -> its line's URL (if any).
    // A used [n] must map to an entry that itself carries an http(s) URL —
    // an unrelated link elsewhere in the doc must never vouch for it.
    // [Hn] entries cite internal Hivemind knowledge and carry no URL.
    const entryUrls = new Map();
    for (const line of srcSection.split('\n')) {
      const num = line.match(/^\s*(?:\[?(\d+)\]?[.:)\]]\s|\[(\d+)\]\s)/);
      if (!num) continue;
      const url = line.match(/https?:\/\/[^\s<>)\]"']+/);
      entryUrls.set(num[1] || num[2], url ? url[0] : null);
    }
    const hDefined = new Set([...srcSection.matchAll(/\[H(\d+)\]/gi)].map((m) => m[1]));
    const dangling = [
      ...nMarkers.filter((n) => !entryUrls.has(n)).map((n) => `[${n}]`),
      ...hMarkers.filter((n) => !hDefined.has(n)).map((n) => `[H${n}]`),
    ];
    const urlless = nMarkers.filter((n) => entryUrls.has(n) && !entryUrls.get(n));
    emit({
      id: 'citations',
      label: 'Citation markers map to sourced URLs',
      status: dangling.length || urlless.length ? 'fail' : 'pass',
      detail: dangling.length || urlless.length
        ? [
            dangling.length ? `Marker(s) ${dangling.join(', ')} have no matching entry under Sources.` : '',
            urlless.length ? `Source entr${urlless.length > 1 ? 'ies' : 'y'} [${urlless.join('], [')}] carr${urlless.length > 1 ? 'y' : 'ies'} no URL — a citation must point at something checkable.` : '',
          ].filter(Boolean).join(' · ')
        : `${nMarkers.length + hMarkers.length} citation marker(s) all resolve to sourced entries.`,
      evidence: [...dangling, ...urlless.map((n) => `[${n}] (no URL)`)],
    });
  } else {
    emit({ id: 'citations', label: 'Citation markers map to sourced URLs', status: 'skip', detail: 'No [n] markers used.', evidence: [] });
  }

  const pass = checks.every((c) => c.status !== 'fail');
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  return { pass, warnings, skipped, checks };
}
