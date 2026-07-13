// A run's evidence trail, derived from its event stream, plus the honest
// judgement of whether the resulting receipt is complete. Pure — the server
// owns the I/O. This is what makes report.json a receipt a skeptic can read,
// not a summary that hides what was contested.

export function deriveEvidence(events) {
  const of = (t) => events.filter((e) => e.type === t);
  const reviews = of('review').map((r) => ({
    round: r.round,
    verdict: r.verdict,
    findings: (r.findings ?? []).map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, suggestion: f.suggestion })),
  }));
  // Words lane streams structured 'review' verdicts; the build lane streams
  // 'round' markers (its structured findings live in the gate's own receipts).
  const rounds = reviews.length ? reviews : of('round').map((r) => ({ round: r.round, verdict: null, findings: [] }));
  return {
    plan: of('plan').map((e) => e.text).pop() ?? null,
    rounds,
    findings: of('finding').map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, suggestion: f.suggestion })),
    revisions: of('revision').map((r) => ({ rev: r.rev, chars: (r.markdown ?? '').length })),
    verify: of('verify_result').map((v) => ({ pass: v.pass, warnings: v.warnings ?? 0, skipped: v.skipped ?? 0 })),
    humanDecisions: of('answer').map((a) => ({ kind: a.kind ?? 'decision', question: a.question, answer: a.answer })),
    gateReport: of('gate_report').map((e) => e.report).pop() ?? null,
  };
}

// Honest completeness → { degraded, note }. A write failure always degrades.
// A build ignition that produced no review round and no gate report has
// nothing to verify, whatever its status — claiming otherwise was the bug.
export function receiptCompleteness({ lane, evidence, writeFailed }) {
  if (writeFailed) return { degraded: true, note: 'a receipt file failed to write — this trail is incomplete' };
  if (lane === 'build' && !evidence.gateReport && evidence.rounds.length === 0) {
    return { degraded: true, note: 'the gate produced no review round and no report — there is nothing here to verify' };
  }
  return { degraded: false, note: null };
}
