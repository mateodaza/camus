// ── ONE AUTHORITATIVE CONTINUATION FOR A RESUMED BUILD RUN ───────────────────────────────
// Production run 20260807-080214-p27e: Studio displayed Verify, the durable status said
// `phase: Implement, round: 2`, the worktree was clean at 5c62c3c with two review receipts and
// three parked commits — and the resume re-entered the gate, which restarted Plan with
// `expectedRound: 1` and then Implement. The repeated planner preferred a "minimal scope" default
// and recommended duplicating the packer's SourceFacesLeft list; the implementer began reasoning
// toward removing the live binding that commit bb58ce4 had deliberately introduced
// ("fix: bind mirror check to real packer SourceFacesLeft, not a copy"). A resume was about to undo
// an audited strengthening because a fresh plan re-derived a weaker one.
//
// Three authorities disagreed: the UI's displayed phase, the durable status record, and whatever the
// re-entered workflow decided on its own. This module is the ONE answer, derived only from durable
// evidence — no models, no prose, nothing an agent can talk its way past. The server routes by it
// and the browser displays it, so presentation and execution cannot diverge again.
//
// DELIBERATELY NOT IN SCOPE: fresh runs. Nothing here runs unless a resume is being classified.

const SHA_RE = /^[0-9a-f]{7,40}$/i;

const sha = (v) => (typeof v === 'string' && SHA_RE.test(v.trim()) ? v.trim() : null);
const intOf = (v) => {
  if (Number.isInteger(v)) return v;
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) ? n : null;
};

// A resume may only do one of these. `gate` is the ONLY one that can re-plan, and it is reachable
// only when the evidence says nothing exists yet to protect.
export const CONTINUATION_ACTIONS = ['verify_only', 'gate', 'refuse'];

/**
 * Derive the single continuation answer for a resume.
 *
 * evidence = {
 *   status:      durable status record, normalized: { phase, round, worktree, nonce, branch } | null
 *   worktree:    measured on disk: { path, head, dirty, branch, commitsAhead } | null
 *   receipts:    VALIDATED review receipts for this worktree: [{ round, ran, clean }] — the
 *                gatherer only admits parseable, ran:true, worktree-matching, nonce-bound,
 *                round-coherent files, so a stray filename cannot inflate anything here
 *   recordedSha: the candidate sha a durable record actually sealed, or null when none was
 * }
 */
export function deriveContinuation(evidence = {}) {
  const status = evidence.status ?? null;
  const wt = evidence.worktree ?? null;
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts.filter((r) => Number.isInteger(r?.round)) : [];
  const rounds = receipts.map((r) => r.round);
  const statusRound = intOf(status?.round);
  const reviewedRound = rounds.length ? Math.max(...rounds) : null;
  // The round NEVER goes backwards. It is the highest number any durable source attests to, so a
  // resume cannot present or execute `expectedRound: 1` over a round-2 history.
  const round = [statusRound, reviewedRound].filter((n) => Number.isInteger(n) && n > 0).reduce((a, b) => Math.max(a, b), 0) || null;

  const refuse = (reason) => ({
    action: 'refuse', phase: status?.phase ?? null, round, reason,
    provenance: null, spawnsModels: false,
    evidence: { statusPhase: status?.phase ?? null, statusRound, reviewedRound, dirty: wt?.dirty ?? null, head: wt?.head ?? null },
  });

  // ── NOTHING WAS BUILT: the gate may legitimately start over ─────────────────────────────
  // No worktree on disk, no receipts, no candidate commit. A run that died at Preflight or before
  // its first commit has nothing to regress, so re-entering the gate is the honest continuation and
  // Plan is where it belongs.
  const recordedSha = sha(evidence.recordedSha);
  const nothingBuilt = !wt && receipts.length === 0 && !recordedSha;
  if (nothingBuilt) {
    // …unless something durable claims work HAPPENED. Then the evidence contradicts itself and the
    // safe answer is to stop, not to guess which half is lying. Two claimants are checked: the
    // gate's own status record, and the run's sealed terminal status — a sealed needs_decision (or
    // any verified/parked terminal) means a candidate existed, so an empty disk is a contradiction.
    if (status?.phase && !['classify', 'plan', 'preflight'].includes(status.phase)) {
      return refuse(`the durable status says the gate reached ${status.phase}${statusRound ? ` (round ${statusRound})` : ''}, but no worktree, candidate commit or review receipt can be found — the evidence contradicts itself, so the run will not be restarted from Plan`);
    }
    const CLAIMS_CANDIDATE = ['needs_decision', 'verify_failed', 'verify_inconclusive', 'review_unresolved', 'done', 'done_with_findings'];
    if (CLAIMS_CANDIDATE.includes(evidence.sealedStatus)) {
      return refuse(`the run's sealed record ended ${evidence.sealedStatus}, which means a candidate existed, but no worktree, candidate commit or review receipt can be found now — the evidence contradicts itself, so the run will not be restarted from Plan`);
    }
    return {
      action: 'gate', phase: 'plan', round: null, reason: 'no worktree, candidate commit or review receipt exists, so nothing has been built that a fresh gate run could regress',
      provenance: null, spawnsModels: true,
      evidence: { statusPhase: status?.phase ?? null, statusRound, reviewedRound, dirty: null, head: null },
    };
  }

  // ── FROM HERE, WORK EXISTS. Plan and Implement are off the table. ───────────────────────
  if (!wt) {
    return refuse('review receipts or a candidate commit exist, but the worktree they belong to is gone — nothing can be verified in place and re-planning would rebuild work that already exists');
  }
  // THE RECORDED BRANCH IS ENFORCED. The durable status record names the branch the gate worked
  // on; a worktree measured on any other branch is not the candidate that history describes, and
  // continuing on it would verify — or re-plan — somebody else's checkout (audit 2026-08-07: a
  // recorded camus/wp9 with a live other/branch still classified verify_only).
  if (status?.branch && wt.branch && status.branch !== wt.branch) {
    return refuse(`the durable status record says the gate worked on branch ${status.branch}, but the worktree is on ${wt.branch} — this is not the recorded candidate, so no continuation is safe without a human look`);
  }
  if (wt.dirty) {
    return refuse(`the worktree ${wt.path} has uncommitted changes, so what is on disk is not the candidate any receipt describes — resolve or commit them by hand before resuming`);
  }
  const head = sha(wt.head);
  if (!head) {
    return refuse(`the worktree ${wt.path} has no readable HEAD, so there is no candidate to continue from`);
  }
  // A clean worktree whose HEAD is still the base commit means implementation never landed. With
  // receipts present that is contradictory; without them, nothing exists yet and the gate may run.
  const ahead = intOf(wt.commitsAhead);
  if (ahead === 0) {
    if (receipts.length) {
      return refuse(`${receipts.length} review receipt(s) exist for ${wt.path}, but its branch holds no commit of its own — the evidence contradicts itself`);
    }
    return {
      action: 'gate', phase: 'plan', round: null, reason: 'the worktree exists but holds no committed candidate, so there is nothing to regress',
      provenance: null, spawnsModels: true,
      evidence: { statusPhase: status?.phase ?? null, statusRound, reviewedRound, dirty: false, head },
    };
  }

  // A COMMITTED CANDIDATE WITH REVIEW HISTORY. The smallest honest remaining action is to establish
  // a deterministic verdict on what is already there and hand it back — never to re-plan it.
  //
  // THE MOVED-TIP CHECK IS ONLY AS REAL AS ITS RECORD. When a durable record sealed the candidate
  // sha, a HEAD that differs is refused. When nothing sealed one — the WP9-era shape — there is no
  // earlier HEAD to compare against, so the continuation says plainly that it is adopting the clean
  // worktree HEAD; it does NOT claim tip movement was ruled out. (The first draft compared the live
  // HEAD against a "final commit" measured from the same live HEAD, which can never disagree.)
  if (recordedSha && !head.startsWith(recordedSha) && !recordedSha.startsWith(head)) {
    return refuse(`the durably recorded candidate commit ${recordedSha.slice(0, 12)} is not the worktree's HEAD ${head.slice(0, 12)} — the branch moved since it was parked, so no continuation is safe without a human look`);
  }
  const anchor = recordedSha
    ? `the durably recorded candidate ${head.slice(0, 12)}`
    : `the ADOPTED clean worktree HEAD ${head.slice(0, 12)} (no earlier HEAD was recorded, so tip movement cannot be ruled out)`;

  if (receipts.length === 0) {
    // Committed work with no validated review receipt. Verification is still the smallest honest
    // step (it measures what exists); re-planning would discard a commit nobody has judged.
    return {
      action: 'verify_only', phase: 'verify', round,
      reason: `${wt.path} holds ${anchor} that no validated review receipt describes; the smallest honest continuation is to verify what exists and hand it back for a decision`,
      provenance: 'unreviewed', spawnsModels: false,
      evidence: { statusPhase: status?.phase ?? null, statusRound, reviewedRound, dirty: false, head, branch: wt.branch ?? null, recordedSha },
    };
  }

  // PROVENANCE FAILS CLOSED. `reviewed` would claim the commit under the HEAD is exactly what a
  // review receipt judged — and no current receipt binds candidate CONTENT (they bind the review
  // invocation: nonce, round, worktree, prompt fingerprint — not the resulting commit). File
  // mtimes cannot establish it either: a touch reorders them at will. So a continuation over
  // receipts is always handed back as fixed_unreviewed until a receipt seals an exact
  // candidate-content binding; the deterministic verify that follows is unaffected.
  return {
    action: 'verify_only', phase: 'verify', round,
    reason: `${wt.path} is clean at ${anchor} with ${receipts.length} validated review round(s) on record; no receipt binds this exact commit's content, so the handoff is fixed_unreviewed — the smallest honest continuation is deterministic verification, not re-planning work that exists`,
    provenance: 'fixed_unreviewed', spawnsModels: false,
    evidence: { statusPhase: status?.phase ?? null, statusRound, reviewedRound, dirty: false, head, branch: wt.branch ?? null, recordedSha },
  };
}

// What the operator is shown, derived from the SAME answer the server routes by. Presentation is a
// projection of the decision, never a second opinion about it.
export function continuationPresentation(plan) {
  if (!plan) return null;
  const round = Number.isInteger(plan.round) && plan.round > 0 ? plan.round : null;
  if (plan.action === 'refuse') {
    return {
      phase: plan.phase ?? null,
      label: 'Needs a human look',
      detail: plan.reason,
      actionLabel: null,
      round,
      canResume: false,
    };
  }
  if (plan.action === 'verify_only') {
    return {
      phase: 'verify',
      label: 'Verify the parked candidate',
      detail: plan.provenance === 'fixed_unreviewed'
        ? 'Runs the deterministic checks on the commit already in the worktree and hands it back. No receipt binds this exact commit\'s content, so the result is recorded as fixed_unreviewed — not review-clean. No planning or implementation runs.'
        : 'Runs the deterministic checks on the commit already in the worktree and hands it back. No planning or implementation runs.',
      actionLabel: 'Verify and hand back',
      round,
      canResume: true,
    };
  }
  return {
    phase: 'plan',
    label: 'Start the gate',
    detail: 'Nothing has been built yet, so this runs the full gate from planning.',
    actionLabel: 'Run the gate',
    round: null,
    canResume: true,
  };
}
