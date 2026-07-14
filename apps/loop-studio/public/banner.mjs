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
export function doneBanner(status, headline, dimensions) {
  switch (headline) {
    case 'verified':
      return { cls: 'good', label: 'DONE — reviewed and verified.' };
    case 'verified_with_findings':
      // The green stands, but the caveats ride the banner itself — a plain
      // "reviewed and verified" here would hide what the receipt records.
      return { cls: 'good', label: 'DONE — verified, with findings or caveats on the record.' };
    case 'same_vendor_reviewed':
      return { cls: 'meh', label: 'DONE — same-vendor reviewed. The audit ran on the maker’s own vendor; advisory review never earns independent verified standing.' };
    case 'published':
      return { cls: 'good', label: 'DONE — verified and published.' };
    default: {
      // Unverified, needs_decision, a headline this UI does not know, or no
      // headline at all — the claim is named as a claim, with the reason.
      const claim = status === 'done_with_findings' ? 'DONE WITH FINDINGS' : 'DONE';
      const nice = (s) => String(s).replace(/_/g, ' ');
      const why = dimensions
        ? `: verification ${nice(dimensions.verification)}, audit ${nice(dimensions.audit)}`
        : ' — this receipt carries no status dimensions (a run from before the trust dimensions, or a torn receipt)';
      return { cls: 'meh', label: `${claim} (gate claim) — the receipt does not corroborate it${why}. Trust the receipts, not the word.` };
    }
  }
}
