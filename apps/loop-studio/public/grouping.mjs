// Recents grouping policy. Audit-only replays of ONE artifact belong together:
// shown as separate rows they read as unrelated runs, which is how a matched
// low-versus-high pair over identical bytes got lost among near-identical goals.
//
// THE ARTIFACT HASH IS THE ONLY GROUPING AUTHORITY. Not similar goals, not
// adjacent timestamps, not matching model names — those can coincide across runs
// that judged different bytes, and a group built on them would invite exactly
// the false comparison this card exists to make safe.

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

// A replay is groupable only if it is an audit replay AND carries a well-formed
// artifact hash. Anything else stays an ordinary row rather than being forced
// into a comparison it cannot support.
const groupable = (run) => run?.lane === 'audit_replay' && HASH_RE.test(run?.artifactId ?? '');

// Returns the Recents list with qualifying replays folded into group entries,
// in the original order (a group takes the position of its newest member).
// Groups need at least two arms: a lone replay is just a run.
export function groupRuns(runs = []) {
  const byArtifact = new Map();
  for (const run of runs) {
    if (!groupable(run)) continue;
    if (!byArtifact.has(run.artifactId)) byArtifact.set(run.artifactId, []);
    byArtifact.get(run.artifactId).push(run);
  }

  const grouped = new Set();
  for (const [artifactId, arms] of byArtifact) {
    if (arms.length < 2) continue; // one replay is not a comparison
    for (const arm of arms) grouped.add(arm.id);
    byArtifact.set(artifactId, arms);
  }

  const out = [];
  const emitted = new Set();
  for (const run of runs) {
    if (!grouped.has(run.id)) {
      out.push({ kind: 'run', run });
      continue;
    }
    if (emitted.has(run.artifactId)) continue; // the group already took its place
    emitted.add(run.artifactId);
    const arms = byArtifact.get(run.artifactId);
    out.push({
      kind: 'audit_comparison',
      artifactId: run.artifactId,
      // Every arm is retained, including failures and incompletes: dropping the
      // ones that did not finish would turn a record into a highlight reel.
      arms: [...arms].sort(armOrder),
      sourceRunId: arms.map((a) => a.sourceRunId).find(Boolean) ?? null,
      startedAt: Math.max(...arms.map((a) => a.startedAt || 0)),
    });
  }
  return out;
}

// Weakest-to-strongest requested effort, so the card reads as a progression
// rather than by accident of completion time. Unknown effort sorts last.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];
function armOrder(a, b) {
  const ai = EFFORT_ORDER.indexOf(a.effortRequested ?? '');
  const bi = EFFORT_ORDER.indexOf(b.effortRequested ?? '');
  if (ai !== bi) return (ai === -1 ? EFFORT_ORDER.length : ai) - (bi === -1 ? EFFORT_ORDER.length : bi);
  return (a.startedAt || 0) - (b.startedAt || 0);
}

export const shortHash = (hash) => (HASH_RE.test(hash ?? '') ? hash.slice(7, 19) : null);

// What an arm is allowed to say about itself. Anything the receipt did not
// record reads "not reported" — never a zero, never an inferred value.
export function armFacts(arm) {
  const whole = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
  const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
  const tokens = whole(arm?.outputTokens);
  const ms = whole(arm?.durationMs);
  const findings = whole(arm?.findingCount);
  return {
    effortRequested: arm?.effortRequested ?? 'not recorded',
    // Requested effort is not a proven reasoning budget; the runtime rarely
    // reports what it actually applied, and inventing it would be a lie.
    effortActual: arm?.effortActual ?? 'not reported',
    auditorActual: text(arm?.auditorActual),
    outputTokens: tokens,
    durationSeconds: ms === null ? null : Math.round(ms / 100) / 10,
    findings,
    receipt: shortHash(arm?.receiptId),
  };
}

// Artifact identity proves identical judged bytes; it does NOT prove the
// auditor or effort was the only other variable. State exactly what the arm
// records support, and call out confounding rather than hiding it.
export function comparisonNote(arms = []) {
  const facts = arms.map(armFacts);
  const auditors = facts.map((fact) => fact.auditorActual);
  const knownAuditors = auditors.every(Boolean);
  const sameAuditor = knownAuditors && new Set(auditors).size === 1;
  const efforts = new Set(facts.map((fact) => fact.effortRequested).filter((value) => value !== 'not recorded'));
  const effortSentence = sameAuditor && efforts.size > 1
    ? 'The recorded auditor matches across arms, while requested effort differs.'
    : sameAuditor
      ? 'The recorded auditor matches, but requested effort does not differ across every arm.'
      : knownAuditors
        ? 'Recorded auditors also differ, so this is not an effort-only comparison.'
        : 'Auditor identity is not fully recorded, so this is not proven to be an effort-only comparison.';
  return `Each arm was assigned the same sealed artifact for re-audit. ${effortSentence} Camus records usage, elapsed time, and findings without naming a winner; a handful of runs is not a significant sample, and requested effort is not proof of the reasoning actually applied.`;
}
