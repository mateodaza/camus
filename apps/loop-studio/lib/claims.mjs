// Claim–evidence ledger for research artifacts. This module does not decide
// entailment. It deterministically maps cited claims to their source markers,
// then applies the independent auditor's explicit supported | unsupported |
// unchecked decisions. A reachable URL is never promoted into support.

import { createHash } from 'node:crypto';

const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function splitDocument(markdown) {
  const text = String(markdown ?? '');
  const match = /^#{1,3}\s+Sources\s*$/im.exec(text);
  if (!match) return { body: text, sources: '' };
  return { body: text.slice(0, match.index), sources: text.slice(match.index + match[0].length) };
}

function sourceMap(sources) {
  const out = new Map();
  for (const line of sources.split('\n')) {
    const publicMarker = line.match(/^\s*(?:[-*]\s*)?(?:\[?(\d+)\]?[.:)\]]\s|\[(\d+)\]\s)/);
    const internalMarker = line.match(/^\s*(?:[-*]\s*)?\[H(\d+)\]\s/i);
    if (internalMarker) {
      out.set(`[H${internalMarker[1]}]`, { url: null, internalIndex: Number(internalMarker[1]) - 1 });
      continue;
    }
    if (!publicMarker) continue;
    const marker = `[${publicMarker[1] || publicMarker[2]}]`;
    const url = line.match(/https?:\/\/[^\s<>)\]"']+/)?.[0] ?? null;
    out.set(marker, { url, internalIndex: null });
  }
  return out;
}

// One candidate per source marker. Reusing [1] for two sentences produces one
// ledger entry containing both claims, so the decision cannot ambiguously bind
// to only one of them.
export function extractClaimCandidates(markdown, { groundingResults = [] } = {}) {
  const { body, sources } = splitDocument(markdown);
  const sourcesByMarker = sourceMap(sources);
  const grouped = new Map();
  const withoutCode = body.replace(/```[\s\S]*?```/g, '');

  for (const line of withoutCode.split('\n')) {
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) continue;
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
    for (const sentence of sentences) {
      const markers = [...new Set([...sentence.matchAll(/\[(H?\d+)\]/gi)].map((m) => `[${m[1].toUpperCase()}]`))];
      if (!markers.length) continue;
      const claim = normalize(sentence
        .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/\[(?:H?\d+)\]/gi, '')
        .replace(/\*\*|__/g, ''));
      if (!claim) continue;
      for (const marker of markers) {
        if (!grouped.has(marker)) grouped.set(marker, []);
        if (!grouped.get(marker).includes(claim)) grouped.get(marker).push(claim);
      }
    }
  }

  return [...grouped].map(([marker, claims]) => {
    const source = sourcesByMarker.get(marker) ?? { url: null, internalIndex: null };
    const internal = source.internalIndex === null ? null : groundingResults[source.internalIndex] ?? null;
    return {
      claim: claims.join(' / '),
      marker,
      url: source.url,
      evidence_hash: internal?.excerpt ? hashText(internal.excerpt) : null,
      retrieved_at: Number.isInteger(internal?.retrievedAt) ? internal.retrievedAt : null,
      decision: 'unchecked',
    };
  });
}

export function applyClaimAssessments(candidates, assessments = []) {
  const byMarker = new Map((assessments ?? []).map((a) => [a.marker, a]));
  return (candidates ?? []).map((candidate) => ({
    ...candidate,
    decision: ['supported', 'unsupported', 'unchecked'].includes(byMarker.get(candidate.marker)?.decision)
      ? byMarker.get(candidate.marker).decision
      : 'unchecked',
  }));
}

export function buildClaimLedger(markdown, { groundingResults = [], assessments = [] } = {}) {
  return applyClaimAssessments(extractClaimCandidates(markdown, { groundingResults }), assessments);
}

export const claimAssessmentEvidenceHash = (assessment) => assessment?.evidence ? hashText(assessment.evidence) : null;
