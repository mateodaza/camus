# Camus 0.4.2 recovery hotfix

Camus 0.4.2 is a bounded control-plane hotfix discovered by the first open-model Slice C dogfood.
It does not implement an open-model product slice. It makes the 0.4.1 native driver recover honestly
from three conditions that occurred during that run.

## What changes

- If a direct maker commits despite its no-commit contract, the kernel verifies that the recorded
  task base is an ancestor, converts the commit back into an uncommitted candidate with a mixed
  reset, preserves every file, and records the recovery. Diverged history still refuses.
- Direct review and watchdog-await host timeouts are 540 seconds. This safely exceeds the review
  runner's 480-second high-effort polling chunk, so a healthy review is not abandoned by its caller.
- Recovered envelopes around the same Claude background turn are identified by sealed session ID
  and transcript hash. Budget and eval metrics count the turn once; transcript or metric drift for
  a reused session fails closed. Existing 0.4.1 duplicate state is repaired on the next idempotent
  ingestion.
- An explicit higher `camus run <featId> --token-budget <n>` reopens only a native direct-output
  budget stop. It restores the exact safe checkpoint and sends an already-completed maker/fix to
  independent review rather than launching another maker. Other human stops remain closed, and a
  lower or still-insufficient ceiling refuses.

## Dogfood evidence

The Slice C task exposed all three failures without losing model work:

1. Opus 4.8 completed the initial candidate in one background session but committed it. The files
   were recovered into the task worktree and reviewed without launching another maker.
2. Sol high completed its review successfully after roughly five minutes, but the 180-second host
   wrapper timed out first. The completed review was subsequently adopted rather than rerun.
3. Re-adopting the initial maker produced two 0.4.1 recovery wrappers for the same sealed session,
   falsely doubling its 90,316 output tokens. The new accounting identity reduces that evidence to
   one billable model turn without weakening transcript or metric custody checks.
4. A later fix crossed its 300,000-token ceiling by 706 tokens and correctly stopped, but the native
   CLI exposed no supported way to apply the operator's higher budget. The recovery path now accepts
   that explicit decision and resumes at the pending review round without JSON surgery.

The recovery patch adds regression coverage for committed-maker normalization, duplicate-wrapper
repair, eval-metric deduplication, explicit budget-stop reopening, and the high-effort timeout
invariant. The full CLI suite, including 633 workflow assertions, passes, and `git diff --check` is
clean.

## Scope

This release changes deterministic recovery and accounting only. Slice C implementation remains in
its feature worktree and must still pass independent re-review, verification, and landing before it
can enter a product release.
