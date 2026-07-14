// Item #1 of the 0.3 integration: Studio becomes a consumer of the trust
// protocol's orthogonal status model. The four RAW dimensions are derived HERE
// from concrete evidence — never from the legacy flat `status` — and sealed
// into the receipt. The headline is NOT sealed: deriveHeadline() computes it
// from the dimensions at render time, so a newer Camus recomputes headlines
// without rewriting historical evidence (packages/trust/lib/status.mjs is the
// one source of truth; the studio imports it rather than copying it).
//
// Two rules the live smoke made concrete:
//   - an audit is INDEPENDENT only when a READABLE camus_gate_review verdict
//     exists — an UNKNOWN/unreadable review is not_run, not an audit;
//   - verification is GREEN only when BOUND to the committed SHA — a green on
//     the wrong commit, or with no commit at all, verifies nothing here.

import { DIMENSIONS, validStatus, deriveHeadline } from '../../../packages/trust/lib/status.mjs';

export { deriveHeadline, DIMENSIONS };

export const STATUS_DIMS_VERSION = 1;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

// The independent audit, from the LATEST APPLICABLE round — selected FIRST,
// then interpreted. requireGateSource gates the build lane to the gate's own
// review receipts; the words lane's Codex rounds are independent by vendor
// without that tag. Only APPROVED|REVISE is a usable verdict: a round that ran
// but produced an unreadable/invalid verdict (UNKNOWN, or any other string)
// broke — it is infra_failed, and must NEVER fall back to an older clean round.
function auditFromReviews(rounds, { requireGateSource, expectedRev = null }) {
  const applicable = (rounds ?? []).filter((r) => !requireGateSource || r.source === 'camus_gate_review');
  if (!applicable.length) return 'not_run';
  const latest = applicable.at(-1);
  // Words artifacts are mutable markdown revisions. A verdict over rev N says
  // nothing about a verify-fix that produced rev N+1. Missing revision binding
  // on a new receipt fails closed; build has its separate commit-SHA binding.
  if (expectedRev !== null && latest.rev !== expectedRev) return 'not_run';
  const verdict = latest.verdict;
  // APPROVED means no blocking finding, not necessarily no finding. Low
  // findings and explicit unchecked claim assessments are still caveats on
  // the record and must derive verified_with_findings rather than the plain
  // verified headline.
  if (verdict === 'APPROVED') {
    const hasCaveats = (latest.findings ?? []).length > 0
      || (latest.claimAssessments ?? []).some((a) => a.decision !== 'supported')
      || (latest.coverageAssessments ?? []).some((a) => a.decision !== 'met');
    return hasCaveats ? 'independent_findings' : 'independent_clean';
  }
  if (verdict === 'REVISE') return 'independent_findings';
  return 'infra_failed'; // a round ran but its latest verdict is unreadable/invalid
}

// Verification from a single verify result. boundSha === null means no binding
// requirement (words: the deliverable itself is the artifact). A string means a
// CONCLUSIVE result — green OR red — counts only when it ran against exactly
// that committed SHA; the binding is validated BEFORE pass/fail is interpreted.
function verificationFrom(v, boundSha = null) {
  if (!v) return 'not_run';
  // A verification that ran but could not conclude is a broken step, not an
  // absent one — preserve the infra fact, whatever the SHA (verify_inconclusive).
  if (v.pass !== true && v.pass !== false) return 'infra_failed';
  // Bind first: a conclusive green OR red on the wrong or absent commit says
  // nothing about this artifact.
  if (boundSha !== null) {
    const bound = typeof v.commitSha === 'string' && SHA_RE.test(v.commitSha) && v.commitSha === boundSha;
    if (!bound) return 'not_run';
  }
  if (v.pass === false) return 'failed';
  return v.warnings || v.skipped ? 'passed_with_caveats' : 'passed';
}

// The verification and audit dimensions for a lane, from its evidence. This is
// the SHARED source of truth: both the sealed dimensions and evidence.mjs's
// receiptCompleteness() go through it, so a receipt can never claim complete
// while its permanent dimensions say the audit broke or verification never
// applied. Build binds verification to the committed SHA and gates the audit to
// camus_gate_review receipts; words binds verification to the deliverable.
export function verificationAndAudit(lane, evidence) {
  if (lane === 'build') {
    const gr = evidence?.gateReport ?? null;
    const committed = gr && (gr.commit_sha ?? gr.commit);
    const boundSha = typeof committed === 'string' && SHA_RE.test(committed) ? committed : '';
    const v = (evidence?.verify ?? []).find((x) => x.source === 'gate_report_status') ?? (evidence?.verify ?? []).at(-1) ?? null;
    return { verification: verificationFrom(v, boundSha), audit: auditFromReviews(evidence?.rounds, { requireGateSource: true }) };
  }
  return {
    verification: verificationFrom((evidence?.verify ?? []).at(-1) ?? null, null),
    audit: auditFromReviews(evidence?.rounds, {
      requireGateSource: false,
      expectedRev: (evidence?.revisions ?? []).at(-1)?.rev ?? null,
    }),
  };
}

export function deriveStatusDimensions({ lane, status, evidence, published = false, simulated = false }) {
  // execution is the run lifecycle — `stopped`/`failed` are the concrete signals
  // that a human aborted or the process died. This is the one dimension the
  // terminal status legitimately reports; verification and audit never are.
  const execution =
    status === 'stopped' ? 'interrupted'
      // no_changes is a run that RAN to its terminal conclusion (the gate proved
      // an empty diff) — completed lifecycle, with verification/audit/publication
      // saying honestly that nothing shipped. It is not a dead process.
      : ['done', 'done_with_findings', 'verify_failed', 'no_changes'].includes(status) ? 'completed'
        : 'failed';

  let { verification, audit } = verificationAndAudit(lane, evidence);
  // A rehearsal's scripted reviewer output can never earn audit standing
  // (2026-07-14 P1: a mock run sealed audit:independent_clean → "verified" —
  // the exact impersonation the trust thesis exists to prevent). The rounds
  // stay in the receipt as what they are, execution and the words lane's REAL
  // deterministic verification stay recorded, but audit seals not_run.
  if (simulated) audit = 'not_run';

  // Publication is only ever set by real publication evidence. Committing to a
  // gate branch is NOT publishing — the branch must be merged (build) or the
  // artifact pushed to Hivemind (words). The smoke reads not_published for
  // exactly this reason.
  const publication = published ? 'published' : 'not_published';

  const dims = { schemaVersion: STATUS_DIMS_VERSION, execution, verification, audit, publication };
  const { schemaVersion, ...forCheck } = dims;
  if (!validStatus(forCheck)) throw new TypeError(`deriveStatusDimensions produced invalid dimensions: ${JSON.stringify(dims)}`);
  return dims;
}
