// Pure launch/run-view policy shared by the browser and deterministic tests.

export function enginePillText({ engine, lane, models = {}, codeMode = 'gate' }) {
  if (engine === 'mock') return 'engine: rehearsal (mock)';
  if (lane === 'build' && codeMode === 'independent') return 'engine: live · any-model candidate · advisory review';
  if (lane === 'build') {
    return `engine: live · build gate: ${models.maker} + ${models.reviewer} (effort ${models.effort} · pinned every round)`;
  }
  return `engine: live · ${models.maker} + ${models.reviewer}${models.effort ? ` (${models.effort})` : ''}`;
}

export function replayRecoveryKind({ lane, empty, parked = false }) {
  if (empty) return null;
  // A replay that ended on a PARKED verdict with the decision unanswered is an
  // interrupted verification decision, not a generic unfinished run: its candidate is
  // committed and reviewed, so it takes the verification-only lane. Offering a gate
  // resume here reran the model phases (production run 20260805-181917-f4b1).
  if (lane === 'build') return parked ? 'recover_parked_candidate' : 'resume_build';
  if (lane === 'comparison') return 'recover_comparison';
  return null;
}

export function documentActionsForLane(lane) {
  return {
    copyMarkdown: lane !== 'build',
    downloadMarkdown: lane !== 'build',
  };
}

export function buildGateTerminalStage(status) {
  if (status === 'done' || status === 'done_with_findings') return 'done';
  if (status === 'failed' || status === 'verify_failed') return 'fail';
  return 'idle';
}

export function terminalFailureBanner(status, lane) {
  if (status === 'verify_failed' && lane === 'build') {
    return 'BUILD NOT ACCEPTED. The gate ended red or with unresolved review findings. Nothing was merged, published, or released.';
  }
  if (status === 'verify_failed') return 'VERIFY FAILED. The result was not published.';
  if (status === 'failed') return 'FAILED. The loop refused to fake a green.';
  if (status === 'stopped') return 'STOPPED by human.';
  // needs_decision is NOT a failure: the candidate is parked and intact, waiting
  // on a person. It used to fall through to the raw enum string rendered red —
  // the same misreading as inconclusive-as-red, on the one state that most needs
  // to look actionable.
  if (status === 'needs_decision') {
    return lane === 'build'
      ? 'NEEDS A DECISION. The candidate is parked and nothing was rejected, merged, or published — deterministic verification could not reach a verdict here. Give it a verification command and resume, or leave it parked.'
      : 'NEEDS A DECISION. The run is waiting on a human; nothing was published.';
  }
  return null;
}

// Which terminal statuses offer Build recovery. This lived as an inline literal
// that omitted needs_decision — the state a real WP6 run actually ends in — so
// the operator reached the exact screen the recovery control exists for and
// found no control (field report 2026-08-05). Pure, so it is testable.
export const BUILD_RECOVERY_STATUSES = ['stopped', 'failed', 'verify_failed', 'needs_decision'];
export function offersBuildRecovery(status, lane) {
  return lane === 'build' && BUILD_RECOVERY_STATUSES.includes(status);
}

// ── SEALED LINEAGE IS THE ONLY LINEAGE THE UI MAY TRUST ────────────────────────
// `report.recoveryOf` is a mutable twin: editing it leaves receipt_id untouched, so
// rendering it as authoritative let a forged source run be presented under a valid
// receipt (audit 2026-08-05, proven by editing it to `forged-source`). The pack's
// session_log IS covered by receipt_id, so it is the source of truth here and the
// twin is only ever used to detect disagreement.
const LINEAGE_LINES = [
  ['sourceRunId', 'recovery of run: '],
  ['sourceReceiptStatus', 'recovery source receipt status: '],
  ['sourceReceiptId', 'recovery source receipt: '],
  ['sourceAudit', 'recovery source audit: '],
  ['parkedSha', 'recovery candidate: '],
  ['shaProvenance', 'recovery sha provenance: '],
];

export function sealedRecoveryLineage(pack) {
  const log = Array.isArray(pack?.session_log) ? pack.session_log : null;
  if (!log) return null;
  const out = {};
  for (const [key, prefix] of LINEAGE_LINES) {
    const line = log.find((l) => typeof l === 'string' && l.startsWith(prefix));
    if (line) out[key] = line.slice(prefix.length);
  }
  if (!('sourceRunId' in out)) return null;             // not a recovery receipt
  // Sentinels the sealer writes when a value was absent; they are not identifiers.
  if (out.sourceReceiptId && !out.sourceReceiptId.startsWith('sha256:')) out.sourceReceiptId = null;
  for (const k of ['sourceRunId', 'parkedSha', 'shaProvenance']) {
    if (out[k] === 'not recorded') out[k] = null;
  }
  if (out.sourceAudit === 'none recorded') out.sourceAudit = null;
  return out;
}

// Compare the twin against the seal. Any disagreement is reported loudly rather than
// resolved: the sealed values are still what gets rendered.
export function lineageTrust(pack, reportRecoveryOf) {
  const sealed = sealedRecoveryLineage(pack);
  if (!sealed) return { sealed: null, trusted: false, mismatched: [], reason: 'no sealed recovery lineage in this receipt' };
  const mismatched = [];
  if (reportRecoveryOf && typeof reportRecoveryOf === 'object') {
    for (const [key] of LINEAGE_LINES) {
      const twin = reportRecoveryOf[key] ?? null;
      const seal = sealed[key] ?? null;
      if (twin !== null && seal !== null && String(twin) !== String(seal)) mismatched.push(key);
    }
  }
  return {
    sealed,
    trusted: mismatched.length === 0,
    mismatched,
    reason: mismatched.length
      ? `the unsealed report fields disagree with the sealed receipt on: ${mismatched.join(', ')}`
      : null,
  };
}

// Two different actions share one control, and the copy has to say which one it is.
// A run that PARKED a candidate (needs_decision) takes the verification-only recovery
// lane: no models, no planning, no implementation, no review. Any other resumable
// build status re-enters the gate, which does rerun those phases. Calling both of
// them "Resume the gate" and promising "finished work skips" described neither.
// THE SERVER'S CONTINUATION CLASSIFICATION IS AUTHORITATIVE WHEN PRESENT.
// Deriving the mode from the terminal status alone was a second authority, and it disagreed with the
// durable evidence: over a clean committed candidate with two review rounds, the control offered
// "Resume the gate — reruns planning and implementation", and the resume did exactly that
// (run 20260807-080214-p27e). When the server sends a continuation, this renders it and nothing else.
export function recoveryAction(status, continuation = null) {
  const p = continuation?.presentation;
  if (p) {
    return {
      mode: continuation.action === 'verify_only' ? 'verify_only' : continuation.action,
      button: p.actionLabel ?? p.label,
      note: ` ${p.detail}`,
      phase: p.phase ?? null,
      round: p.round ?? null,
      canResume: p.canResume !== false,
      provenance: continuation.provenance ?? null,
    };
  }
  if (status === 'needs_decision') {
    return {
      mode: 'verify_only',
      button: 'Verify the parked candidate',
      note: ' Runs verification only; no models, planning, implementation, or review rerun.',
    };
  }
  return {
    mode: 'gate',
    button: 'Resume the gate',
    note: ' Re-enters the gate under the same custody identity, in the same worktree. The gate reruns its phases, including planning and implementation.',
  };
}

// needs_decision and no_changes are outcomes, not failures, so neither is red.
export function terminalBannerClass(status, { simulated = false, good = false } = {}) {
  if (simulated) return 'meh';
  if (good) return 'good';
  return ['stopped', 'no_changes', 'needs_decision'].includes(status) ? 'meh' : 'bad';
}

// Gate reports are already bounded by the local run receipt. Silently clipping
// their JSON hid the end of the final note/findings even though the report API
// retained it, so the run view renders the complete object.
export function gateReportJson(report) {
  return JSON.stringify(report ?? {}, null, 2);
}

// The deterministic gate has THREE outcomes, and the UI must not collapse them.
// `pass: null` means the checks could not RUN (missing toolchain, no tests, a
// timeout) — a WITHHELD verdict. Studio rendered it with `!ev.pass`, so an
// inconclusive run read "RED. Sending back for a fix." and a perfectly good
// candidate looked broken (WP6 dogfood 2026-08-05). Green / red / amber, and the
// amber copy says what actually happened to the candidate.
export function verifySummary({ pass, warnings = 0, skipped = 0 } = {}) {
  if (pass === true) {
    const caveats = (warnings || 0) + (skipped || 0);
    return {
      cls: 'pass',
      label: caveats
        ? `DETERMINISTIC GATE: GREEN, with caveats: ${warnings || 0} warning(s), ${skipped || 0} check(s) could not run`
        : 'DETERMINISTIC GATE: GREEN. Every check passed.',
    };
  }
  if (pass === false) {
    return { cls: 'fail', label: 'DETERMINISTIC GATE: RED. Sending back for a fix.' };
  }
  return {
    cls: 'inconclusive',
    label: 'DETERMINISTIC GATE: INCONCLUSIVE. Verification could not run, so the code is neither proven nor disproven. The candidate stays parked and nothing was rejected.',
  };
}
