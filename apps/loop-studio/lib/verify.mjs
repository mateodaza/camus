// Deterministic verifier for marketing deliverables.
// Every check here is mechanical: it either passes or it fails with evidence.
// No model is consulted — this is the stage that cannot be sweet-talked.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;

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
const STAT_RE =
  /(\d+(\.\d+)?\s*%)|(\$\s?\d[\d,.]*)|(\b\d+(\.\d+)?x\b)|(\b\d[\d,.]*\s*(million|billion|bn|mm|m\b|k\b))|(\b\d{4,}\b)/gi;
const CITE_RE = /\[(H?\d+)\]|\]\(https?:\/\//;
const YEAR_RE = /^(19|20)\d{2}$/;
const RULE_HEADING = /^(#{1,6})\s+(?:decision rules?|success criteria)\b/i;
const ANY_HEADING = /^(#{1,6})\s+(.*)$/;
// The proposed-threshold marker is EXACT: a hyphen-bullet line, the precise
// phrase, the comma, and the colon — case-sensitive. Whitespace runs are the
// only tolerance. An embedded, lowercase, comma-less, or bullet-less lookalike
// is NOT a marker, so its numbers are audited like any other statistic.
//
// It MAY be wrapped in ONE balanced Markdown emphasis run (**, *, __, _) that
// opens right after the bullet and closes immediately before or after the colon
// — the bold form the live smoke produced renders identically to the plain
// marker. Emphasis is tolerated ONLY as that balanced wrapper: stray * or _
// inside the words ("- Pro*posed threshold …") is corruption, not emphasis, and
// stays red. The regex reads the RAW line (never a stripped copy), so it cannot
// be fooled by delimiters it did not pair, and the stored line stays byte-exact.
const THRESHOLD_PHRASE = 'Proposed threshold\\s+\\(decision policy,\\s+not observed performance\\)';
// The closing delimiter must hug the marker: immediately after `)` (before the
// colon) or immediately after the colon. A space before the closing run — `): **`
// — is not a valid CommonMark closing delimiter, so it renders as literal
// asterisks, not bold, and must stay red. Whitespace BEFORE the colon is fine;
// the plain marker already tolerates it.
//
// The after-colon close also needs a boundary AFTER it: `:**retention` is a run
// preceded by punctuation and followed by an alphanumeric, which is not
// right-flanking either — it renders literally, so require whitespace or line end
// after the delimiter. The before-colon close needs no such guard: a colon
// (punctuation) always follows it, which keeps it right-flanking.
const THRESHOLD_MARKER = new RegExp(
  `^-\\s+(?:(\\*\\*|__|\\*|_)${THRESHOLD_PHRASE}(?:\\1\\s*:|\\s*:\\1(?=\\s|$))|${THRESHOLD_PHRASE}\\s*:)`,
);
const isThresholdMarker = (line) => THRESHOLD_MARKER.test(line);
const clip = (s) => (s.length > 180 ? `${s.slice(0, 177)}…` : s);
const statTokens = (text) => [...text.matchAll(STAT_RE)].map((m) => m[0].trim()).filter((t) => !YEAR_RE.test(t));

// Single pass over the body so the citation gate and the proposed-threshold
// ledger can NEVER disagree about which lines were exempted: a line the gate
// skips is exactly a line the ledger hands the auditor to judge.
//
// Proposed-threshold exemption. A numeric line bypasses the citation
// requirement ONLY when BOTH hold: it sits inside a `## Decision Rule` /
// `## Success Criteria` block AND it carries the EXACT marker. A proposed
// decision policy is the author's own rule, not an observed statistic — it has
// no source to cite — so an acceptance contract that asks for a measurable
// decision rule stops fighting this gate. Both conditions are load-bearing: a
// factual statistic in the section WITHOUT the marker still fails, and a marked
// line OUTSIDE the section still fails. The block is BOUNDED — its heading until
// the next heading at OR ABOVE the entry level — unlike terminal Sources, so a
// mid-document Decision Rule can never exempt the sections after it, and a
// nested qualifying sub-heading never shrinks the outer boundary. This gate does
// not judge whether an exempt line is honest policy or a disguised statistic;
// the threshold ledger forces the independent auditor to make that call.
function scanStats(markdown) {
  const body = markdown
    .split(/^#{1,3}\s+Sources\s*$/im)[0] // Sources is TERMINAL — keep the prefix
    .replace(/```[\s\S]*?```/g, ''); // ignore code blocks

  const offenders = [];
  const thresholds = [];
  let blockLevel = 0; // 0 = outside any block; else the ENTRY heading level
  let section = null; // the heading text that opened the active block
  for (const rawLine of body.split('\n')) {
    const heading = rawLine.match(ANY_HEADING);
    if (heading) {
      const level = heading[1].length;
      const qualifies = RULE_HEADING.test(rawLine);
      if (blockLevel) {
        // Only a heading at or above the entry level closes the block; a deeper
        // heading stays nested and preserves the outer boundary.
        if (level <= blockLevel) {
          blockLevel = qualifies ? level : 0;
          section = qualifies ? heading[2].trim() : null;
        }
      } else if (qualifies) {
        blockLevel = level;
        section = heading[2].trim();
      }
      continue; // headings never carry countable stats
    }
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    if (blockLevel && isThresholdMarker(line)) {
      // Exempt from the citation gate — but sealed into the ledger so the
      // auditor must still label it policy vs disguised observed performance.
      // Store the FULL line, never a preview: it is both the auditor's judgment
      // context and the input to line_hash, so clipping it would truncate context
      // AND let two long lines that share a 177-char prefix hash to one binding.
      thresholds.push({ id: `T${thresholds.length + 1}`, section, line, stats: statTokens(line) });
      continue;
    }
    // Split the line into sentences; bare years are discarded individually so a
    // leading "In 2024, …" can't exempt the real stat that follows it.
    for (const raw of line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      const s = raw.trim();
      if (!s || CITE_RE.test(s)) continue;
      if (statTokens(s).length) offenders.push(clip(s));
    }
  }
  return { offenders, thresholds };
}

export function findUnsourcedStats(markdown) {
  return scanStats(markdown).offenders;
}

// The deterministic proposed-threshold ledger: every line the stat gate exempted
// (in-section AND exactly marked). The auditor must assess each one, so a
// statistic wearing the marker to dodge citation cannot pass silently.
export function extractThresholdLines(markdown) {
  return scanStats(markdown).thresholds;
}

// Bind each auditor threshold decision back to the exact ledger line it judged.
// The auditor returns only { id, decision, evidence }; joining it to the ledger
// carries WHAT was exempted (section, line, stats) into the emitted event, so
// the receipt records the line and not merely an ordinal + verdict. A decision
// with no matching ledger entry keeps null fields rather than inventing one.
export function bindThresholdAssessments(ledger = [], assessments = []) {
  const byId = new Map((ledger ?? []).map((t) => [t.id, t]));
  return (assessments ?? []).map((a) => {
    const entry = byId.get(a.id) ?? null;
    return {
      id: a.id,
      decision: a.decision,
      evidence: a.evidence,
      section: entry?.section ?? null,
      line: entry?.line ?? null,
      stats: entry?.stats ?? [],
    };
  });
}

// Deterministic custody hashes for a bound threshold assessment. thresholdLineHash
// binds the receipt entry to the exact exempted line; thresholdEvidenceHash binds
// the auditor's rationale. Shared by the normal and audit-replay seal paths so a
// receipt can never bind T1 to two different lines.
export function thresholdLineHash(a) {
  return a && a.line != null
    ? hashText(JSON.stringify({ section: a.section ?? null, line: a.line, stats: a.stats ?? [] }))
    : null;
}

export function thresholdEvidenceHash(a) {
  return a?.evidence ? hashText(a.evidence) : null;
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

export async function runVerify(markdown, lane = 'freeform', { onCheck, skipNetwork = false, groundingResults = [] } = {}) {
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
    emit({ id: 'structure', label: 'Structure', status: 'skip', detail: 'Freeform lane: no required sections.', evidence: [] });
  }

  // Resolve citation state before checking links. A receipt-captured Hivemind
  // result is checkable internal evidence even when the connector returns no
  // public URL; a prose-only [Hn] claim is not.
  const bodyOnly = markdown.split(/^#{1,3}\s+Sources\s*$/im)[0];
  const srcSection = markdown.split(/^#{1,3}\s+Sources\s*$/im)[1] ?? '';
  const hMarkers = [...new Set([...bodyOnly.matchAll(/\[H(\d+)\]/gi)].map((m) => m[1]))];
  const hDefined = new Set([...srcSection.matchAll(/\[H(\d+)\]/gi)].map((m) => m[1]));
  const hReceiptBound = hMarkers.filter((n) => hDefined.has(n) && groundingResults[Number(n) - 1]);
  const hasOnlyBoundInternalEvidence = hMarkers.length > 0 && hReceiptBound.length === hMarkers.length;

  // 2. Links resolve
  const urls = extractUrls(markdown);
  if (!urls.length) {
    emit({
      id: 'links',
      label: 'Links resolve',
      status: hasOnlyBoundInternalEvidence ? 'pass' : lane === 'freeform' ? 'warn' : 'fail',
      detail: hasOnlyBoundInternalEvidence
        ? `No public URL was returned; ${hReceiptBound.length} Hivemind citation(s) are bound to connector results captured in this receipt.`
        : lane === 'freeform'
          ? 'No external links were supplied; external source checking did not apply to this freeform run.'
          : 'No URLs found. A researched deliverable must cite live sources or receipt-bound internal evidence.',
      evidence: hasOnlyBoundInternalEvidence ? hReceiptBound.map((n) => `[H${n}]`) : [],
    });
  } else if (skipNetwork) {
    emit({ id: 'links', label: 'Links resolve', status: 'skip', detail: `${urls.length} URL(s) found; network check skipped.`, evidence: urls });
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
        ? `All ${results.length} link(s) unreachable. The network looks down; nothing could be verified (this is not evidence the links are dead).`
        : dead.length || unreachable.length
          ? [
              dead.length ? `${dead.length} of ${results.length} link(s) dead: ${dead.map((d) => `${d.url} (${d.status})`).join('; ')}` : '',
              unreachable.length ? `${unreachable.length} unreachable (could not verify): ${unreachable.map((d) => `${d.url} (${d.error})`).join('; ')}` : '',
            ].filter(Boolean).join(' · ')
          : blocked.length
            ? `${blocked.length} link(s) bot-blocked (${blocked.map((b) => `${b.url} → ${b.status}`).join('; ')}); the check can't verify them, open them yourself`
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
    label: 'Compliance phrases',
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
  const nMarkers = [...new Set([...bodyOnly.matchAll(/\[(\d+)\]/g)].map((m) => m[1]))];
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
    const dangling = [
      ...nMarkers.filter((n) => !entryUrls.has(n)).map((n) => `[${n}]`),
      ...hMarkers.filter((n) => !hDefined.has(n)).map((n) => `[H${n}]`),
    ];
    const urlless = nMarkers.filter((n) => entryUrls.has(n) && !entryUrls.get(n));
    const unboundInternal = hMarkers.filter((n) => hDefined.has(n) && !groundingResults[Number(n) - 1]);
    emit({
      id: 'citations',
      label: 'Citation markers map to evidence',
      status: dangling.length || urlless.length || unboundInternal.length ? 'fail' : 'pass',
      detail: dangling.length || urlless.length || unboundInternal.length
        ? [
            dangling.length ? `Marker(s) ${dangling.join(', ')} have no matching entry under Sources.` : '',
            urlless.length ? `Source entr${urlless.length > 1 ? 'ies' : 'y'} [${urlless.join('], [')}] carr${urlless.length > 1 ? 'y' : 'ies'} no URL; a citation must point at something checkable.` : '',
            unboundInternal.length ? `Hivemind marker(s) ${unboundInternal.map((n) => `[H${n}]`).join(', ')} have no matching connector result in the receipt.` : '',
          ].filter(Boolean).join(' · ')
        : `${nMarkers.length + hMarkers.length} citation marker(s) all resolve to public or receipt-bound evidence.`,
      evidence: [...dangling, ...urlless.map((n) => `[${n}] (no URL)`), ...unboundInternal.map((n) => `[H${n}] (not in receipt)`)],
    });
  } else {
    emit({ id: 'citations', label: 'Citation markers map to evidence', status: 'skip', detail: 'No [n] or [Hn] markers used.', evidence: [] });
  }

  const pass = checks.every((c) => c.status !== 'fail');
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  return { pass, warnings, skipped, checks };
}
