# Camus 0.4.3 recovery and velocity correction

Camus 0.4.3 is a direct, bounded control-plane correction from the Slice C dogfood. It was
implemented outside Camus: the dogfood had already demonstrated that asking the same loop to repair
its own recovery path was the wrong cost boundary.

## What changes

- Native direct-output stops now carry a typed `stopKind`. Recovery accepts the published 0.4.1
  hard-ceiling reason and the 0.4.2 reserve reason, so an explicit higher `--token-budget` can
  restore the exact sealed checkpoint without JSON surgery.
- The inexpensive controller may decide `human` or `stop` even when the maker-output reserve is
  exhausted. The reserve still blocks an expensive maker/fix launch immediately before that
  launch; it no longer forces a budget increase merely to decide that no more work is worthwhile.
- `camus status` recognizes both direct-output stop forms and prints the supported higher-budget
  resume command. Non-round request artifacts no longer appear as fictitious review rounds, and a
  stale repo-level transcript cannot claim a run died while feature-bound state is fresh.

## Regression evidence

Focused kernel, driver, and status tests pin typed and legacy stop recognition, exact checkpoint
recovery, controller-before-reserve ordering, numeric-only review rounds, and truthful liveness
warnings. The full CLI suite remains the release gate.

## Scope

This release changes Camus recovery, decision ordering, and read-only observability only. It does
not implement or grade any open-model product contract. Slice C remains in its isolated feature
worktree and resumes from its already sealed round-11 review after this CLI is installed.
