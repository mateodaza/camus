// A run's evidence trail, derived from its event stream, plus the honest
// judgement of whether the resulting receipt is complete. Pure — the server
// owns the I/O. This is what makes report.json a receipt a skeptic can read,
// not a summary that hides what was contested.

import { verificationAndAudit } from './status-dims.mjs';

export function deriveEvidence(events) {
  const of = (t) => events.filter((e) => e.type === t);
  const ground = of('stage').filter((e) => e.name === 'ground' && e.status === 'done').at(-1) ?? null;
  const groundingQueries = of('session')
    .filter((e) => ['maker', 'retriever'].includes(e.actor) && String(e.line || '').startsWith('knowledge_search: '))
    .map((e) => String(e.line).slice('knowledge_search: '.length));
  const groundingEvents = of('grounding_evidence');
  const groundingResults = groundingEvents.flatMap((e) => (e.results ?? []).map((r) => ({
    ...r,
    retrievedAt: Number.isInteger(r.retrievedAt) ? r.retrievedAt : Number.isInteger(e.at) ? e.at : null,
  })));
  const resultQueries = [...new Set(groundingResults.map((result) => result.query).filter(Boolean))];
  const reviews = of('review').map((r) => ({
    round: r.round,
    scope: r.scope ?? 'round',
    rev: Number.isInteger(r.rev) ? r.rev : null,
    verdict: r.verdict,
    rawVerdict: r.rawVerdict ?? null,
    confidence: r.confidence ?? null,
    explanation: r.explanation ?? null,
    source: r.source ?? null,
    reviewerModel: r.reviewerModel ?? null,
    reviewerEffort: r.reviewerEffort ?? null,
    // Seat-selection facts (docs/MULTI-MODEL-SEATS.md). Absent on receipts
    // sealed before seats existed — those rounds were cross-vendor by
    // construction, and the audit derivation treats the absence that way.
    reviewerBackend: r.reviewerBackend ?? null,
    reviewerIdentity: r.reviewerIdentity ?? null,
    independence: r.independence ?? null,
    at: Number.isInteger(r.at) ? r.at : null,
    claimAssessments: (r.claimAssessments ?? []).map((a) => ({
      marker: a.marker,
      decision: a.decision,
      evidence: a.evidence,
    })),
    coverageAssessments: (r.coverageAssessments ?? []).map((a) => ({
      criterion_id: a.criterion_id,
      decision: a.decision,
      evidence: a.evidence,
    })),
    thresholdAssessments: (r.thresholdAssessments ?? []).map((a) => ({
      id: a.id,
      decision: a.decision,
      evidence: a.evidence,
      section: a.section ?? null,
      line: a.line ?? null,
      stats: Array.isArray(a.stats) ? a.stats : [],
    })),
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
    grounding: ground ? {
      mode: ground.mode ?? null,
      connected: ground.connected === true,
      queried: ground.queried === true,
      queryCount: Number.isInteger(ground.queries) ? ground.queries : groundingQueries.length,
      queries: groundingQueries.length ? groundingQueries : resultQueries,
      results: groundingResults,
      snapshotId: ground.snapshotId ?? groundingEvents.map((event) => event.snapshotId).find(Boolean) ?? null,
      frozen: ground.frozen === true,
    } : null,
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
      checks: Array.isArray(v.checks) ? v.checks.map((c) => ({
        id: c.id,
        status: c.status,
        detail: c.detail ?? null,
      })) : null,
    })),
    humanDecisions: of('answer').map((a) => ({ kind: a.kind ?? 'decision', question: a.question, answer: a.answer, at: a.at })),
    gateReport: of('gate_report').map((e) => e.report).pop() ?? null,
  };
}

// Honest completeness → { degraded, note }. A write failure always degrades.
// A build ignition that produced no review round and no gate report has
// nothing to verify, whatever its status — claiming otherwise was the bug.
export function receiptCompleteness({ lane, evidence, writeFailed, status = null }) {
  if (writeFailed) return { degraded: true, note: 'a receipt file failed to write; this trail is incomplete' };
  if (lane === 'build') {
    if (!evidence.gateReport) {
      return { degraded: true, note: 'the gate produced no terminal report; there is nothing here to verify' };
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
        return { degraded: true, note: `the successful gate report is missing ${missing.join(', ')}; do not treat it as a complete receipt` };
      }
    }
    return { degraded: false, note: null };
  }
  if (lane !== 'build') {
    if (evidence.rounds.length === 0) {
      return { degraded: true, note: 'the run produced no independent review round; there is nothing here to verify' };
    }
    if (['done', 'done_with_findings'].includes(status)) {
      const { verification, audit } = verificationAndAudit(lane, evidence);
      const missing = [];
      // A same-vendor pairing seals an ADVISORY audit — the trail is complete
      // and the downgrade lives in the standing (same_vendor_reviewed), not in
      // a degraded receipt. Only a broken or absent audit degrades here.
      if (!['independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings'].includes(audit)) missing.push('a usable audit bound to the final revision');
      if (!['passed', 'passed_with_caveats'].includes(verification)) missing.push('a conclusive deterministic verification');
      if (missing.length) return { degraded: true, note: `the successful words run is missing ${missing.join(', ')}; do not treat it as a complete receipt` };
    }
  }
  return { degraded: false, note: null };
}
