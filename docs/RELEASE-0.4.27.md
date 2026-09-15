# Camus 0.4.27 — survivable SWE edit mistakes

CLI and Studio share these corrections to the optional SWE native maker.

- Native edit/write failures can continue only after serialized host checks prove
  the target unchanged and validate other staged files and inventory. A durable
  no-effect receipt retires the unused approval; the failed tool is never relabeled
  as a successful edit. Corrections stay within existing action/time budgets.
- Partial writes, unexpected files, overlapping work, broken containment and
  uncertain effects remain fatal. Failed reconciliation cancels queued work before
  another host operation can dispatch. No uncertain replay is introduced.
- Completed native decisions accept one JSON object, one JSON fence, or a bounded
  plain-text preamble followed by one complete JSON object. No missing fields are
  inferred; ambiguous/trailing content and unauthorized decisions remain refused.
  Normalization never reads tool outputs or pre-tool progress as a decision.
- No model, billing, admission, routing or default changes. Other native adapters
  were checked for the same blanket-abort issue and were not relaxed.

## Evidence

105 focused tests passed with zero skips, including real macOS sandbox checks,
multi-slice correction, failed-reconciliation queue cancellation, presentation
wrappers and wrapped unauthorized decisions. Packaged CLI runtime/parity passed;
the release workflow runs full root/CLI, Studio, landing, trust and package checks.

The fresh live recovery canary passed in **66.103 seconds**: one SWE-2 High prompt,
an intentional failed edit, host-verified no-effect recovery, corrected native
edit, native creation/readback, frozen verification and one GPT-5.6 Luna medium
approval with zero findings. Twelve actions, no retries/repairs, unchanged source.
43,342 accounted tokens include a 32,768-token SWE reservation; actual SWE spend
remains unknown. The previous formatting-failed canary remains recorded as failed.
The passing run returned JSON-only; tolerant formatting also passed against the
earlier captured response and end-to-end offline fixtures, not a fabricated live
normalization claim.

## Upgrade and resume the actual work

Install `camus-cli@0.4.27` and restart Studio or any long-lived workers. Preserve
older runs and draft mirrors. Start a **fresh isolated run**, using the existing
task, acceptance contract, frozen verifier, chosen maker/reviewer and authorized
budgets. Do not use uncertain replay or adopt an old draft directly. If authority
is exhausted, obtain a new bounded allowance rather than extending it silently.

This is a bounded compatibility fix, not a guarantee of large-project completion.
Do not repeat canaries or add Camus features as part of the task handoff unless a
new concrete blocker requires it. See [SWE setup](SWE-SETUP.md) and the full
[validation evidence](SWE-CONTRACT-VALIDATION.md).
