# Camus 0.3.2

Camus 0.3.2 is a bounded public-alpha trust and consent patch earned through
real dogfooding after 0.3.1. It does not add provider architecture or new game
features. It makes existing terminal claims, local settings, and external side
effects match what actually executes.

## Highlights

- Every terminal reached after an accepted review receipt carries the bound
  reviewer backend, model (or explicit `not_recorded`), effort, and round.
  This includes post-fix containment breach and inconclusive exits.
- Loop Studio keeps completed words artifacts local unless the launch form's
  explicit Hivemind publication checkbox is enabled. The decision is recorded
  before model work in `run.json` and the final report.
- Human review decisions now say **Accept result**, not **Accept and ship**;
  accepting findings does not imply permission for an external side effect.
- Tracked `checks/models.json` is a pragmatic public fallback: Sonnet maker,
  `gpt-5.4-mini` reviewer at low effort, and two rounds. Settings writes mutable
  operator choices to `~/.camus/studio/models.json`, keeping repositories clean
  and preventing one operator's expensive pairing from becoming the public default.
- Studio's isolated verification launcher binds the port it advertises, and its
  deterministic/API suites no longer inherit mutable review-round settings.

## Install or upgrade

```bash
npm install -g camus-cli@0.3.2
camus install
camus check
```

Camus requires authenticated Claude Code and Codex CLIs. It runs the target
repository's own build and test commands, so use it only on code you trust and
never as root.

## Honest remaining gap

The Studio UI, rehearsal, recovery, receipts, reversed seat selection, and
same-vendor advisory standing are covered. A provider-backed Studio words run
was not repeated for this patch; that remains a live test gap, not a reason to
reopen executor architecture.
