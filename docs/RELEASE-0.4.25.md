# Camus 0.4.25 — visible native slice budgets

The reported SWE run got past 0.4.24's tool-boundary failures but exhausted a
native work slice during exploration. The shared maker prompt described a
bounded slice without stating the numeric allowance. This release addresses
that pacing gap without increasing limits or weakening incomplete-result rules.

## Changes

- Native coding maker prompts show this dispatch's action slice target, time
  limit and early wrap-up threshold. Full slices target wrap-up by 48 of 64
  accounted actions and 75% of the time limit. Smaller remaining run allowances
  produce smaller targets. Executor enforcement differs; pacing is not a new
  authority grant or a guarantee that every native executor has identical caps.
- SWE prompts explicitly explain native-event-plus-host-operation accounting.
  Internal inference calls/tokens remain unknown. Other native prompts describe
  their model-call target and host token allowance without promising a bill cap.
- SWE MCP results append a separate `camus_native_budget` block with counted
  actions, remaining time and early wrap-up guidance. Correctable/no-execution
  replies still consume allowance and receive current feedback. Existing tool
  result JSON is preserved; native ACP file/permission responses are unchanged.
- Valid partial completions use the existing checked `continue` path, with a
  concise progress handoff and recalculated remaining limits. Dispatch prompt
  hashes bind the numeric guidance without breaking logical saved-response binding.

## Scope and evidence

CLI and Studio package the same runtime. Shared prompt guidance applies to native
coding makers; live tool-response budget feedback is SWE-specific. File-actions,
words/marketing runs and reviewers are unchanged. No admission/routing changes,
post-abort model call, budget extension or uncertain replay are introduced.

Offline regressions exercise early action/time warnings, tiny and exhausted
allowances, double accounting, budget-bearing correction/busy replies, exact
dispatch hashes, valid partial completion and a subsequent smaller slice that
reaches verification/review. Packaging checks bind the shared budget module.

This is model-visible guidance, not enforced graceful completion. A model that
ignores it can still hit the hard boundary. The reported live failure is not
retroactively accepted, and no new paid SWE validation is claimed by this release.
