# Camus 0.3.1

Camus 0.3.1 is the first public-alpha build proven through the complete
CodenameWukong Enemies feature (WP1–WP10). It keeps the 0.3 product promise and makes
that promise more dependable: bounded cross-vendor review, deterministic verification,
honest interrupted-run recovery, and receipts that fail closed when custody is uncertain.

## Highlights

- A pragmatic operator layer in the existing Camus skill: choose Studio or direct use,
  preserve the full acceptance contract, intervene only on material defects, and feed
  UX or efficiency observations into the retrospective.
- Hardened reviewer custody across detach, await, adoption, stop, and reattach paths,
  including process-group identity checks and explicit orphaned/unproven outcomes.
- Review fingerprints bind the candidate, task, and scope; unbound, stale, or malformed
  receipts cannot become a clean verdict.
- Bounded `oneshot` repair reports stay honest: a final unreviewed fix carries its
  findings and claimed resolutions instead of being described as reviewed.
- Studio Build recovery distinguishes verification-only handoff from a gate rerun,
  reconstructs eligible interrupted runs, and renders sealed lineage rather than a
  mutable report twin.
- Model seats are configurable and their executed identities are recorded. The Build
  gate retains the independent Claude-maker/Codex-reviewer contract.
- Expanded deterministic regressions for real process cleanup, resume classification,
  receipt admission, environment detection, UI recovery policy, and sealed evidence.

## Install or upgrade

```bash
npm install -g camus-cli@0.3.1
camus install
camus check
```

Camus requires authenticated Claude Code and Codex CLIs. It runs the target repository's
own build and test commands, so use it only on code you trust and never as root. Studio is
local-first and remains alpha; Hivemind integration is optional.

## Release posture

This release is intentionally public before Camus has external users. It is ready for
friends and collaborators to test on real work, but it is still a 0.x alpha. New features
should earn their way in through observed use; do not extend the harness merely to create
more dogfood.
