# Camus 0.4.22 — native SWE, independent review

SWE-2 High through Devin joins the optional coding-maker lineup in CLI and
Loop Studio. Choose your reviewer separately; saved defaults do not change.
Camus remains a public alpha and Flexible Build remains advisory: support for
an executor does not grant automatic acceptance, reviewer admission or routing.

## What ships

- `--maker devin:swe-2-high --maker-executor devin_native` and the same selection
  in Studio Flexible Build. Existing Devin account login; no API-key fallback.
- Explicit `--accept-devin-unmetered` / per-run Studio consent. Time and observed
  actions are bounded; internal SWE inference/token spend is unavailable.
- Pinned executable, isolated login/config, checked staged edits, host MCP tools,
  complete-turn/cleanup checks, candidate-bound verification and separate review.
- Fixed a supervised Codex launch that left stdin open and waited indefinitely
  for input. Nested verifier/native lifetime signals and IPC remain intact.
- Fixed native progress commentary contaminating completion JSON. Only the text
  after the last tool event can supply the final decision; malformed/ambiguous
  output, incomplete tools and unauthorized decisions still refuse.
- Private bounded terminal evidence and fixed-label refusal stages preserve
  useful diagnostics without putting provider response text in public errors.
- Pinned one admission-test model-cache fixture so the operator's changing model
  list cannot invalidate offline tests.

## Evidence and limits

The synthetic SWE → verification → Luna smoke passed. A ten-file snapshot of a
real private application package then passed a two-file change, 32 tests and
independent Luna medium review in 76 seconds, with six actions and no repairs or
retries in that successful run. Two earlier package attempts exposed the
completion-parsing defect; they remain failures in the evidence. Source projects
were not modified or published. This is not a universal model ranking.

Initial supported scope: macOS Apple Silicon, Devin CLI `3000.10.21 (611c1cba)`,
SWE-2 High, at most 512 prepared files / 8 MiB total / 1 MiB per file. No automatic
monorepo scoping, arbitrary dependency installation or file deletion. A vendor
promotion is not a guaranteed-zero-billing claim.

[Setup and CLI example](SWE-SETUP.md) · [Evidence-based recommendations](RECOMMENDED-MODEL-SETUP.md)

The proposed SDK, remote workers and automatic task routing are not part of this release.
