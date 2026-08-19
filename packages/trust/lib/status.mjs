// The orthogonal status model (DIRECTION-0.3-TRUST-LAYER.md, adjustment 1).
//
// Raw dimensions are stored PERMANENTLY in receipts; the headline is derived,
// disposable presentation — a newer Camus recomputes headlines from the same
// dimensions without rewriting historical evidence. Nothing may persist a
// headline in place of its dimensions.

export const DIMENSIONS = {
  execution: ['pending', 'running', 'completed', 'interrupted', 'failed'],
  verification: ['not_run', 'passed', 'passed_with_caveats', 'failed', 'infra_failed'],
  // declared_* seal when the governing audit round was cross-organization with
  // origin_confidence capping at operator_declared (§10 rule 4) — configured
  // cross-vendor, not attested. auditFromReviews derives them from the round's
  // recorded independence fact exactly as it derives advisory_* from same_vendor.
  audit: ['not_run', 'independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings', 'declared_clean', 'declared_findings', 'infra_failed'],
  publication: ['not_published', 'published'],
};

export const HEADLINES = [
  'verified',
  'verified_with_findings',
  'same_vendor_reviewed',
  'declared_cross_vendor_reviewed',
  'unverified',
  'needs_decision',
  'published',
];

// Locked display copy for the declared_cross_vendor_reviewed headline (§10.8.3).
// This string is pinned by test and must NEVER contain the bare words
// 'independent' or 'verified': configured cross-vendor standing is origin
// declared, not attested, and its wording may not launder into either word.
export const DECLARED_CROSS_VENDOR_REVIEWED_DISPLAY = 'cross-vendor as configured — origin declared, not attested';

// validStatus now admits the declared_* audit values because DIMENSIONS.audit
// broadened to the v2 enum (§10.8.2). This function only checks enum membership;
// STATUS-VERSION gating (a v1 pack may never carry a declared_* value) is
// enforced at the pack boundary in validate.mjs per the §10.8.4 matrix (Task 5),
// not here.
export function validStatus(d) {
  return (
    d && typeof d === 'object' &&
    DIMENSIONS.execution.includes(d.execution) &&
    DIMENSIONS.verification.includes(d.verification) &&
    DIMENSIONS.audit.includes(d.audit) &&
    DIMENSIONS.publication.includes(d.publication)
  );
}

// The derivation rules, in order. This comment is the protocol spec:
//
//  P.  published work is held to the FULL standard: it reads `published`
//      only when the unpublished derivation would read verified or
//      verified_with_findings; any lesser state that got published is a
//      loud `needs_decision` — "published but unverified" must never
//      flatten into either word alone.
//  1.  execution other than completed → unverified (nothing finished to
//      trust; the dimensions say why: pending, running, interrupted, failed).
//  2.  deterministic red under a clean review (verification=failed with
//      independent_clean, advisory_clean, or declared_clean) → needs_decision:
//      the judges disagree, and tests cannot be argued with, so a human settles
//      it. declared_clean joins the clean-review set exactly like advisory (§10.8.3).
//  3.  any infra_failed dimension → unverified — a broken step is never a
//      pass (fail-closed, the camus invariant).
//  4.  verification not passed/passed_with_caveats → unverified (not_run
//      or failed without a contradicting clean review).
//  5.  audit=not_run → unverified: this protocol's "verified" requires the
//      independent audit AND the deterministic green, not either alone.
//  6.  advisory audits (same vendor) → same_vendor_reviewed, always —
//      advisory never earns the standing of an independent audit.
//  6d. declared audits (configured cross-vendor, origin declared not attested)
//      → declared_cross_vendor_reviewed, always — a declared twin of rule 6:
//      configured standing never earns the standing of an attested independent
//      audit (§10.8.3).
//  7.  independent audit over a deterministic green:
//        passed + independent_clean            → verified
//        anything else (caveats or findings)   → verified_with_findings
export function deriveHeadline(d) {
  if (!validStatus(d)) {
    throw new TypeError(`deriveHeadline: invalid status dimensions: ${JSON.stringify(d)}`);
  }
  if (d.publication === 'published') {
    // Rule P, unchanged: only a would-be verified/verified_with_findings inner
    // headline reads `published`. A published declared_cross_vendor_reviewed
    // (like a published same_vendor_reviewed) falls to needs_decision here via
    // this inner-derivation guard — configured standing does not meet the
    // publication bar (§10.8.3).
    const inner = deriveHeadline({ ...d, publication: 'not_published' });
    return inner === 'verified' || inner === 'verified_with_findings' ? 'published' : 'needs_decision';
  }
  if (d.execution !== 'completed') return 'unverified';
  if (d.verification === 'failed' && (d.audit === 'independent_clean' || d.audit === 'advisory_clean' || d.audit === 'declared_clean')) {
    return 'needs_decision';
  }
  if (d.verification === 'infra_failed' || d.audit === 'infra_failed') return 'unverified';
  if (d.verification !== 'passed' && d.verification !== 'passed_with_caveats') return 'unverified';
  if (d.audit === 'not_run') return 'unverified';
  if (d.audit === 'advisory_clean' || d.audit === 'advisory_findings') return 'same_vendor_reviewed';
  if (d.audit === 'declared_clean' || d.audit === 'declared_findings') return 'declared_cross_vendor_reviewed';
  if (d.verification === 'passed' && d.audit === 'independent_clean') return 'verified';
  return 'verified_with_findings';
}

// Every combination, for exhaustive tests and documentation tables.
export function allCombinations() {
  const out = [];
  for (const execution of DIMENSIONS.execution)
    for (const verification of DIMENSIONS.verification)
      for (const audit of DIMENSIONS.audit)
        for (const publication of DIMENSIONS.publication)
          out.push({ execution, verification, audit, publication });
  return out;
}
