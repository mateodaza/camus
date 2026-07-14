// Contract-coverage ledger for the acceptance contract. Like the claim ledger
// (claims.mjs), this module does NOT decide satisfaction. It deterministically
// splits the acceptance contract into stable, addressable criteria, then applies
// the independent auditor's explicit met | unmet | unclear decisions.
//
// Deterministic extraction is load-bearing for Compare & Learn: the SAME contract
// must yield the SAME criteria across arms, or coverage is not comparable. So the
// criteria are a pure function of the contract text (never the model's), and ids
// come from order — the same contract always produces the same ledger.

import { createHash } from 'node:crypto';

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const hashText = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;

// Split a freeform acceptance contract into criteria. Authors write contracts as
// a bulleted/numbered list OR as prose with sentence/semicolon-separated clauses;
// honor whichever they used. Empty or legacy (no-contract) runs yield no criteria,
// exactly as a draft with no citations yields no claim candidates.
export function extractContractCriteria(acceptanceContract) {
  const collapsed = normalize(acceptanceContract);
  if (!collapsed) return [];

  // Prefer explicit list structure when the author used one (≥2 list items).
  const listItems = String(acceptanceContract ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line))
    .map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ''));

  const parts = listItems.length >= 2
    ? listItems
    // Otherwise split prose on sentence boundaries and semicolons.
    : collapsed.split(/;\s*|(?<=[.!?])\s+(?=[A-Z0-9"'(])/);

  const criteria = [];
  const seen = new Set();
  for (const raw of parts) {
    const text = normalize(raw).replace(/[.;,\s]+$/, '').trim();
    if (text.length < 3) continue; // drop fragments and stray punctuation
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // a repeated clause is one criterion
    seen.add(key);
    criteria.push({ id: `C${criteria.length + 1}`, text });
  }
  return criteria;
}

// Apply the auditor's decisions to the extracted criteria. An absent, stale, or
// invalid decision is `unclear` — never silently satisfied. `met` is the only
// value that clears a criterion; `unmet` is a genuine miss (a blocking finding,
// enforced where the review is normalized); `unclear` is a caveat on the record.
export function applyCoverageAssessments(criteria, assessments = []) {
  const byId = new Map((assessments ?? []).map((a) => [a.criterion_id, a]));
  return (criteria ?? []).map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    decision: ['met', 'unmet', 'unclear'].includes(byId.get(criterion.id)?.decision)
      ? byId.get(criterion.id).decision
      : 'unclear',
  }));
}

export function buildCoverageLedger(acceptanceContract, { assessments = [] } = {}) {
  return applyCoverageAssessments(extractContractCriteria(acceptanceContract), assessments);
}

export const coverageAssessmentEvidenceHash = (assessment) => assessment?.evidence ? hashText(assessment.evidence) : null;
