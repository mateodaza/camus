// Pure Build-gate phase-strip policy — DOM-free so it is unit-testable and the
// browser (app.js) and the test share ONE source of truth for phase order.
//
// (This lives here rather than run-ui-policy.mjs only because run-ui-policy.mjs
// was inaccessible when this was written; it is the same kind of pure policy
// module and can be folded back in later.)
//
// The list is audited against the workflow's DURABLE status stamps (2026-08-05,
// WP6 dogfood), which are the only phases Studio reliably observes:
//   • statusStamp('Classify' | 'Plan' | 'Implement' | 'Verify') and
//     statusPhase('Review') → classify, plan, implement, review, verify.
//   • Plan was missing from the strip, so a durable "plan" fell to the unknown
//     fallback and rendered AFTER the last step — the drift this fixes.
//   • Worktree is NOT a distinct phase: the worktree-create command stamps
//     --phase Implement, so implementation IS the worktree step.
//   • Commit and Prep are Workflow-runtime phase() calls with no durable status
//     stamp, so Studio never observes them as the active phase.
//   • Land is omitted entirely: a Studio Build commits its reviewed candidate to
//     the branch and PARKS it — it never merges — so a "Land" step would be
//     untruthful for Studio's parked-candidate boundary (merge is camus-feat's
//     job, not camus-loop's). The parked commit shows in the terminal outcome,
//     not as a phase.
//   • Fix IS observed: the fix agent's phase reaches Studio through the session
//     stream, and while it was missing from this list it fell to the unknown
//     fallback and rendered as a raw lowercase "fix" after Verify (live run
//     20260806-164809-hiju). It sits between Review and Verify, where it runs.
export const GATE_PHASES = [
  ['igniting', 'Igniting'],
  ['classify', 'Classify'],
  ['plan', 'Plan'],
  ['implement', 'Implement'],
  ['review', 'Review'],
  ['fix', 'Fix'],
  ['verify', 'Verify'],
];

// Render the phase strip: known phases in order with the active one marked, and
// a phase the gate reports that is NOT known APPENDED at the end rather than
// dropped — a future/unstamped phase stays visible instead of vanishing. Pure,
// so the ordering and the unknown-phase fallback are directly testable.
export function gatePhaseStrip(activePhase, phases = GATE_PHASES) {
  const known = phases.some(([key]) => key === activePhase);
  const body = phases.map(([key, label]) => (key === activePhase ? `▸ ${label}` : label)).join('  ·  ');
  // An unknown phase is still LABELLED, not printed as the raw key. The keys are lowercase
  // internal tokens; showing one beside "Review · Verify" reads as a bug, which is how the
  // missing Fix phase surfaced. Kept visible, just spelled like the others.
  return body + (known || !activePhase ? '' : `  ·  ▸ ${phaseLabel(activePhase)}`);
}

// Title-case an unrecognised phase key for display. Deliberately dumb: one word, first letter up.
export function phaseLabel(key) {
  const k = String(key ?? '').trim();
  return k ? k[0].toUpperCase() + k.slice(1) : k;
}

// THE ROUND FACT. At the cap there is no next round to expect, and saying "round 2/2 · expecting
// r3" invited the reader to wait for a review that will never be requested (live run
// 20260806-164809-hiju). Pure so both the browser and the suite read the same rule.
export function gateRoundFact({ round, roundCap, expectedRound } = {}) {
  if (!Number.isInteger(expectedRound)) return null;
  const shown = Number.isInteger(round) ? round : null;
  const cap = Number.isInteger(roundCap) ? roundCap : null;
  const head = `round ${shown ?? '–'}/${cap ?? '?'}`;
  // At or past the cap the honest statement is that this is the last round, not a prediction.
  if (cap != null && shown != null && shown >= cap) return `${head} · round cap reached`;
  if (cap != null && expectedRound > cap) return `${head} · round cap reached`;
  return `${head} · expecting r${expectedRound}`;
}
