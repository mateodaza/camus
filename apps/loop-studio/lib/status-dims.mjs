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

// The independent audit, from readable review verdicts only. requireGateSource
// gates the build lane to the gate's own review receipts; the words lane's
// Codex rounds are independent by vendor without that tag.
function auditFromReviews(rounds, { requireGateSource }) {
  const readable = (rounds ?? []).filter(
    (r) => (!requireGateSource || r.source === 'camus_gate_review') && typeof r.verdict === 'string' && r.verdict !== 'UNKNOWN',
  );
  if (!readable.length) return 'not_run';
  return readable.at(-1).verdict === 'APPROVED' ? 'independent_clean' : 'independent_findings';
}

// Verification from a single verify result. boundSha === null means no binding
// requirement (words: the deliverable itself is the artifact). A string means
// the green counts only when the check ran against exactly that committed SHA.
function verificationFrom(v, boundSha = null) {
  if (!v) return 'not_run';
  if (v.pass === false) return 'failed';
  if (v.pass !== true) return 'not_run'; // null / inconclusive
  if (boundSha !== null) {
    const bound = typeof v.commitSha === 'string' && SHA_RE.test(v.commitSha) && v.commitSha === boundSha;
    if (!bound) return 'not_run'; // green, but not of the committed artifact
  }
  return v.warnings || v.skipped ? 'passed_with_caveats' : 'passed';
}

export function deriveStatusDimensions({ lane, status, evidence, published = false }) {
  const gr = evidence?.gateReport ?? null;

  // execution is the run lifecycle — `stopped`/`failed` are the concrete signals
  // that a human aborted or the process died. This is the one dimension the
  // terminal status legitimately reports; verification and audit never are.
  const execution =
    status === 'stopped' ? 'interrupted'
      : ['done', 'done_with_findings', 'verify_failed'].includes(status) ? 'completed'
        : 'failed';

  let verification, audit;
  if (lane === 'build') {
    const committed = gr && (gr.commit_sha ?? gr.commit);
    const boundSha = typeof committed === 'string' && SHA_RE.test(committed) ? committed : '';
    const v = (evidence?.verify ?? []).find((x) => x.source === 'gate_report_status') ?? (evidence?.verify ?? []).at(-1) ?? null;
    verification = verificationFrom(v, boundSha);
    audit = auditFromReviews(evidence?.rounds, { requireGateSource: true });
  } else {
    verification = verificationFrom((evidence?.verify ?? []).at(-1) ?? null, null);
    audit = auditFromReviews(evidence?.rounds, { requireGateSource: false });
  }

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
