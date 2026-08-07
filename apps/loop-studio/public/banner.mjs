// The terminal banner policy for a REAL (non-simulated) `done` /
// `done_with_findings` event. Pure and DOM-free on purpose: the receipt cases
// that bit us — legacy runs with no dimensions, a flat status contradicting
// its headline, every recognized standing — pin directly in verify.test.mjs.
//
// The flat status is only the GATE'S CLAIM. Standing comes from the trust
// protocol's derived headline riding the event (decorated at serve time,
// never sealed). Missing evidence fails CLOSED: a `done` with no headline —
// including every pre-dimension receipt in runs/ — renders as an
// uncorroborated claim, never as "reviewed and verified".
export function doneBanner(status, headline, dimensions, recoveryOf = null) {
  const claim = status === 'done_with_findings' ? 'DONE WITH FINDINGS' : 'DONE';
  // A headline is disposable PRESENTATION derived from the dimensions — never
  // evidence on its own. No dimensions on the event means there is nothing the
  // headline could honestly have been derived from (no current server emits
  // that shape; a tampered or torn replay can), so it must not unlock any
  // standing: evidence first, then the word.
  if (!dimensions || typeof dimensions !== 'object') {
    return { cls: 'meh', label: `${claim} (gate claim). The receipt does not corroborate it: this receipt carries no status dimensions (a run from before the trust dimensions, or a torn receipt). Trust the receipts, not the word.` };
  }
  switch (headline) {
    case 'verified':
      return { cls: 'good', label: 'DONE. Reviewed and verified.' };
    case 'verified_with_findings':
      // The green stands, but the caveats ride the banner itself — a plain
      // "reviewed and verified" here would hide what the receipt records.
      return { cls: 'good', label: 'DONE. Verified, with findings or caveats on the record.' };
    case 'same_vendor_reviewed':
      return { cls: 'meh', label: 'DONE. Same-vendor reviewed: the audit ran on the maker’s own vendor, and advisory review never earns independent verified standing.' };
    case 'published':
      return { cls: 'good', label: 'DONE. Verified and published.' };
    default: {
      const nice = (s) => String(s).replace(/_/g, ' ');
      // A VERIFICATION-ONLY RECOVERY is this shape by construction: it ran no review,
      // so audit is honestly not_run, but its verification is a real commit-bound
      // green. Summarising that as "not verified" told the operator the opposite of
      // what happened (audit 2026-08-05). Say what this receipt proves, and where the
      // review evidence lives — without claiming this receipt inherited it.
      if (dimensions.verification === 'passed' && dimensions.audit === 'not_run' && recoveryOf) {
        const src = recoveryOf.sourceRunId ? ` (run ${recoveryOf.sourceRunId})` : '';
        const bound = recoveryOf.parkedSha ? `, bound to ${String(recoveryOf.parkedSha).slice(0, 12)}` : '';
        // A linked review needs a VALIDATED source receipt that records an audit. A
        // legacy source with no sealed pack has no review to point at, and implying
        // one would invent it.
        const linked = Boolean(recoveryOf.sourceReceiptId)
          && ['independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings'].includes(recoveryOf.sourceAudit);
        return {
          cls: 'good',
          label: linked
            ? `VERIFIED HERE. Deterministic verification passed on the parked candidate${bound}. No review ran in this recovery — the review evidence stays in the source run${src}, receipt ${String(recoveryOf.sourceReceiptId).replace(/^sha256:/, '').slice(0, 12)}, which this receipt links but does not absorb.`
            : `VERIFIED HERE. Deterministic verification passed on the parked candidate${bound}. No review ran in this recovery, and NO source review is available to link${src ? ` — the source run${src} sealed no validated receipt recording an audit` : ''}: nothing here has been independently reviewed.`,
        };
      }
      // Unverified, needs_decision, a headline this UI does not know, or no
      // headline at all — the claim is named as a claim, with the reason.
      return { cls: 'meh', label: `${claim} (gate claim). The receipt does not corroborate it: verification ${nice(dimensions.verification)}, audit ${nice(dimensions.audit)}. Trust the receipts, not the word.` };
    }
  }
}

// Parallel parents have experiment outcomes rather than trust standings. Keep
// their terminal wording pure too: a failed recovery must never inherit the
// success copy just because it ran under the rehearsal engine.
export function comparisonBanner(status, simulated) {
  if (simulated) {
    if (status === 'done') return { cls: 'meh', label: 'COMPARISON REHEARSAL COMPLETE. Both scripted arms used one frozen snapshot; their receipts remain simulation, not evidence.' };
    if (status === 'stopped') return { cls: 'meh', label: 'COMPARISON REHEARSAL STOPPED. Completed and interrupted scripted arms remain in the experiment receipt.' };
    return { cls: 'meh', label: 'COMPARISON REHEARSAL FAILED. Interrupted scripted arms remain visible; no models or retrieval were rerun.' };
  }
  if (status === 'done') return { cls: 'good', label: 'PARALLEL EXECUTION COMPLETE. Every arm is sealed, including failures. No winner has been declared.' };
  if (status === 'stopped') return { cls: 'meh', label: 'COMPARISON STOPPED by human. Completed and interrupted arms remain in the experiment receipt.' };
  return { cls: 'bad', label: 'COMPARISON FAILED. The experiment kept the failed arms instead of hiding them.' };
}
