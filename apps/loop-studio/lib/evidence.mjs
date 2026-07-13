// A run's evidence trail, derived from its event stream, plus the honest
// judgement of whether the resulting receipt is complete. Pure — the server
// owns the I/O. This is what makes report.json a receipt a skeptic can read,
// not a summary that hides what was contested.

import { verificationAndAudit } from './status-dims.mjs';

export function deriveEvidence(events) {
  const of = (t) => events.filter((e) => e.type === t);
  const reviews = of('review').map((r) => ({
    round: r.round,
    verdict: r.verdict,
    rawVerdict: r.rawVerdict ?? null,
    confidence: r.confidence ?? null,
    explanation: r.explanation ?? null,
    source: r.source ?? null,
    reviewerModel: r.reviewerModel ?? null,
    findings: (r.findings ?? []).map((f) => ({
      severity: f.severity,
      priority: f.priority ?? null,
      title: f.title,
      detail: f.detail,
      suggestion: f.suggestion,
      location: f.location ?? null,
      confidence: f.confidence ?? null,
    })),
  }));
  // Words lane streams structured 'review' verdicts; the build lane streams
  // 'round' markers (its structured findings live in the gate's own receipts).
  const rounds = reviews.length ? reviews : of('round').map((r) => ({ round: r.round, verdict: null, findings: [] }));
  return {
    plan: of('plan').map((e) => e.text).pop() ?? null,
    rounds,
    findings: of('finding').map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, suggestion: f.suggestion })),
    revisions: of('revision').map((r) => ({ rev: r.rev, chars: (r.markdown ?? '').length })),
    verify: of('verify_result').map((v) => ({
      pass: v.pass,
      warnings: v.warnings ?? null,
      skipped: v.skipped ?? null,
      source: v.source ?? null,
      derived: v.derived ?? false,
      commitSha: v.commitSha ?? null,
      detail: v.detail ?? null,
    })),
    humanDecisions: of('answer').map((a) => ({ kind: a.kind ?? 'decision', question: a.question, answer: a.answer })),
    gateReport: of('gate_report').map((e) => e.report).pop() ?? null,
  };
}

// Honest completeness → { degraded, note }. A write failure always degrades.
// A build ignition that produced no review round and no gate report has
// nothing to verify, whatever its status — claiming otherwise was the bug.
export function receiptCompleteness({ lane, evidence, writeFailed }) {
  if (writeFailed) return { degraded: true, note: 'a receipt file failed to write — this trail is incomplete' };
  if (lane === 'build') {
    if (!evidence.gateReport) {
      return { degraded: true, note: 'the gate produced no terminal report — there is nothing here to verify' };
    }
    if (['done', 'done_with_findings'].includes(evidence.gateReport.status)) {
      // Judge completeness by the SAME dimensions the receipt seals, so a
      // receipt can never read complete while its permanent dimensions say the
      // audit broke (infra_failed) or verification never applied (not_run).
      // This subsumes the latest-verdict and SHA-binding checks.
      const { verification, audit } = verificationAndAudit('build', evidence);
      const missing = [];
      if (audit !== 'independent_clean' && audit !== 'independent_findings') {
        missing.push('a usable independent review verdict');
      } else if (evidence.gateReport.status === 'done' && audit !== 'independent_clean') {
        missing.push('a final clean review verdict');
      }
      if (verification !== 'passed' && verification !== 'passed_with_caveats') {
        missing.push('a green verification bound to the committed SHA');
      }
      if (missing.length) {
        return { degraded: true, note: `the successful gate report is missing ${missing.join(', ')} — do not treat it as a complete receipt` };
      }
    }
    return { degraded: false, note: null };
  }
  if (lane !== 'build' && evidence.rounds.length === 0) {
    return { degraded: true, note: 'the run produced no independent review round — there is nothing here to verify' };
  }
  return { degraded: false, note: null };
}
