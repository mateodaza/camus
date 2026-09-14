# Camus 0.4.23 — explain native failures, recover no-write conflicts

This maintenance release hardens the optional SWE/Devin coding maker. CLI and
Studio share the corrected runtime; no default, reviewer admission, billing
authority, native-recovery permission or model routing changes.

## Fixes

- Persist bounded, private terminal evidence for incomplete turns as well as
  completed ones. Missing terminals, protocol refusals, tool failures, host-policy
  refusals and unproven cleanup no longer collapse into an unexplained adapter error.
- Expose allowlisted reason, stage, cleanup, terminal and tool-failure diagnostics
  through CLI inspection and Studio status. Raw provider text, paths and arguments
  are not promoted into these fields. Evidence files remain private and are not
  approval receipts.
- Add paginated `list_files` discovery. Listings and search include host-created
  files, not only the initial frozen inventory.
- Return explicit `operationCompleted:false` guidance for a safe unprepared-file
  lookup or a stale hash detected before writing. The model can correct these
  within the current turn and budget. Protected/denied paths, symlink/integrity
  failures, read-only writes, arbitrary native failures and uncertain effects
  still stop execution; provider prose cannot authorize recovery.
- Wait longer for npm's accepted-package processing, without republishing or
  weakening commit/provenance checks.

## Evidence and honest limits

The reported 0.4.22 cross-project run stopped after about 36 seconds, nine accounted
actions and no implementation changes or review. Its diagnostic reason was lost
before persistence. This release fixes that evidence loss; it does **not** claim
to reconstruct the original trigger or retroactively complete that run.

Offline regressions cover incomplete outcomes, private evidence permissions,
diagnostic redaction, storage collision, unproven cleanup, no-write correction,
protected paths, new-file discovery and CLI/Studio projection parity. No paid SWE
rerun was performed for this release. The successful 0.4.22 package smoke remains
prior bounded evidence, not whole-project reliability qualification.

Update before starting a **fresh** bounded task. Historical uncertain runs remain
inspection-only; do not replay them or increase budgets to bypass a refusal.
SWE still requires macOS Apple Silicon, the pinned Devin artifact and explicit
unknown-spend consent. See [SWE setup](SWE-SETUP.md).
