// Eligibility from an authenticated checkpoint, NOT filesystem authorization.
// Resume must still acquire ownership and re-check binding, source, custody and
// the exact accepted candidate fingerprint before retiring the refused call.
// This deliberately excludes native/protocol failures and adoption failures.
export function canResumeDevinPriorCandidate(state) {
  const call = state?.pendingCall, response = call?.response, diagnostic = response?.diagnostic;
  return state?.phase === 'refused' && state.status === 'needs_decision'
    && state.fileActionPolicy === 'create_replace_v1'
    && state.makerProgressPolicy === 'bounded_discovery_v1'
    && state.nativeRecoveryPolicy === 'quiescent_draft_v1'
    && state.seats?.maker?.backend === 'devin'
    && state.seats.maker.model === 'swe-2-high'
    && state.seats.maker.codeExecutor === 'devin_native'
    && state.seats.maker.observedBudgetConsent === 'devin-observed/v1'
    && state.nativeInFlight === true && !state.verifierInFlight
    && !state.pendingAction && !state.question
    && state.candidate?.snapshotStatus === 'verified_turn'
    && /^[a-f0-9]{64}$/.test(state.candidate.fingerprint ?? '')
    && Number.isSafeInteger(state.usage?.steps) && state.usage.steps > 0
    && call?.role === 'maker' && call.native === true
    && response?.ok === false && response.uncertain === true && response.noModelCalled === false
    && response.failureCode === 'devin_native_refused'
    && response.stagedDraft?.adopted === false && response.stagedDraft.replayAllowed === false
    && typeof response.stagedDraft.path === 'string' && response.stagedDraft.path !== state.candidate.worktree
    && diagnostic?.stage === 'decision_schema' && diagnostic.terminalReceived === true
    && diagnostic.cleanupConfirmed === true && diagnostic.protocolStage === 'completion'
    && diagnostic.stopReason === 'end_turn' && diagnostic.reason === null
    && diagnostic.rpcFailure === null && diagnostic.boundaryRefusal === null;
}
