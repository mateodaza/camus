// Eligibility from an authenticated checkpoint, NOT filesystem authorization.
// Resume must still acquire ownership and re-check binding, source, custody and
// the exact accepted candidate fingerprint before retiring the refused call.
// A discarded isolated mirror is never reclassified as no-effect or adopted.
// Historical isolated tool failures need no retroactive success receipt: this path
// starts over ONLY from the previous accepted snapshot after proven cleanup.
import { DEVIN_NATIVE_DIGEST } from './devin-native-protocol.mjs';

export function canResumeDevinPriorCandidate(state) {
  const call = state?.pendingCall, response = call?.response, diagnostic = response?.diagnostic;
  const schemaRefusal = response?.failureCode === 'devin_native_refused'
    && diagnostic?.stage === 'decision_schema' && diagnostic.terminalReceived === true
    && diagnostic.protocolStage === 'completion' && diagnostic.stopReason === 'end_turn' && diagnostic.reason === null;
  // Tool labels are diagnostic, not custody evidence. A stopped isolated edit
  // may have partial effects in its mirror; that mirror is discarded wholesale.
  const isolatedToolRefusal = response?.failureCode === 'devin_native_incomplete'
    && diagnostic?.stage === 'native_turn' && diagnostic.reason === 'tool_failed'
    && diagnostic.protocolStage === 'prompt' && diagnostic.terminalReceived === false && diagnostic.stopReason === null
    && state.nativeSession?.artifactDigest === DEVIN_NATIVE_DIGEST && state.nativeSession.replayable === false;
  const restartablePhase = state?.phase === 'refused' && state.status === 'needs_decision'
    || state?.phase === 'make' && ['running', 'stopped'].includes(state.status)
      && response?.recoveryDisposition === 'discard_mirror_v1';
  return restartablePhase
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
    && response.stagedDraft?.adopted === false && response.stagedDraft.replayAllowed === false
    && typeof response.stagedDraft.path === 'string' && response.stagedDraft.path !== state.candidate.worktree
    && (schemaRefusal || isolatedToolRefusal)
    && diagnostic.cleanupConfirmed === true
    && diagnostic.rpcFailure === null && diagnostic.boundaryRefusal === null;
}
