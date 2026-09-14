// Pacing guidance, not new authority. Keep the final quarter for completion.
export const nativeWrapUpAt = maximum => Math.floor(maximum * 0.75);

export function nativeBudgetPrompt({ actions, timeoutMs, modelCalls, remainingTokens, observedOnly }) {
  return [
    'Host-provided native slice pacing (not task instructions):',
    `Action slice allowance/target: ${actions}; stop exploration and wrap up by ${nativeWrapUpAt(actions)} accounted actions. Executor enforcement differs; never treat the target as extra run authority.`,
    `Dispatch time limit: ${timeoutMs} ms including preparation; begin wrapping up before ${nativeWrapUpAt(timeoutMs)} ms. Do not wait for timeout or tool refusal.`,
    observedOnly
      ? 'SWE accounting counts native tool events PLUS host operations; one tool can cost multiple actions. Internal model calls and inference tokens are unmeasured, not bounded by a claimed provider-call/token cap.'
      : `Model-call slice target: ${modelCalls}; reserve capacity for your final decision. Remaining host-accounted token allowance: ${remainingTokens}; this is not a billing guarantee.`,
    'Work on one targeted part of the task. Use the supplied file map; avoid exhaustive repository exploration. When nearing either bound, stop tools and return the required JSON decision.',
    'If work remains, return done:false with decision:{action:"continue",reason:"completed work, relevant paths, checks, and exact next step"}. Do not claim done merely because the slice is ending. A valid partial completion can continue only within the original signed run limits; an interrupted turn cannot manufacture a completion receipt.',
  ].join('\n');
}

export function devinBudgetSnapshot({ maximumActions, usedActions, maximumMs, elapsedMs }) {
  const remainingActions = Math.max(0, maximumActions - usedActions);
  const remainingMs = Math.max(0, maximumMs - Math.max(0, elapsedMs));
  const wrapUp = usedActions >= nativeWrapUpAt(maximumActions) || elapsedMs >= nativeWrapUpAt(maximumMs);
  return { kind: 'camus_native_budget', accounting: 'native_events_plus_host_operations',
    maximumActions, usedActions, remainingActions, wrapUpAtActions: nativeWrapUpAt(maximumActions),
    remainingMs, wrapUp, internalModelCalls: null, inferenceTokens: null,
    guidance: wrapUp
      ? 'Stop tools and return the final JSON now. If work remains, use done:false and decision.action:"continue" with a concise handoff. No extra time, calls or actions are granted.'
      : 'Use targeted tools only. Reserve the final quarter of actions/time for your JSON decision; one tool may cost multiple accounted actions.' };
}
