# Camus 0.4.33 — checked SWE work survives imperfect turn closure

This maintenance release makes long SWE runs more productive without weakening
the shared CLI/Studio containment boundary. Flexible Build remains advisory and
public alpha.

## Changes

- Preserve a non-empty, fully checked native mirror as a partial checkpoint when
  a clean SWE turn returns no final control text.
- Preserve checked partial work at a host time/action boundary only after the
  process is closed, the entire mirror inventory and exact bytes validate, every
  failed tool is proven no-effect, and no pending exec or unknown operation exists.
- Normalize those cases only to `done:false` and `decision.action:"continue"`
  under the unchanged signed contract. Never infer task completion, added budget,
  model/scope changes, verification, review, acceptance, merge, or publication.
- Redirect a no-change continuation toward one unfinished acceptance criterion
  instead of silently encouraging another broad discovery pass.
- Let historical clean `decision_json` refusals resume from their last accepted
  candidate through the existing ownership/binding/fingerprint checks. Their
  refused mirror remains discarded and unreplayed.

Uncertain effects, pending native exec, unsupported tools, byte or inventory
mismatches, unproven cleanup, malformed non-empty authority, and operator stops
remain fail-closed.

## Evidence

Offline adapter and full-loop regressions cover zero-text turns, deadline closure
with a pending contained read, the pending-exec negative control, no-progress
guidance, crash/resume progress binding, prior-candidate recovery, verification,
and independent review. Full root/CLI, Studio, packaging, and release CI remain
mandatory gates.

Read-only inspection of Company Brain run
`code-1789435781661-50eb06c8` at revision 809 confirms that 0.4.33 recognizes its
clean `decision_json` refusal as resumable from accepted fingerprint
`e7c226e2…`. This release did not modify or dispatch that run and makes no live
completion claim. Existing usage and authorization ceilings remain binding.

See [setup](SWE-SETUP.md) and
[contract evidence](SWE-CONTRACT-VALIDATION.md#verified-partial-checkpoints-0433).
