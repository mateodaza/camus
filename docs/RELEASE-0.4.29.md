# Camus 0.4.29 — bounded SWE continuity

This maintenance release keeps correctable SWE tool choices from ending a run
without granting native command authority or accepting uncertain work. The engine
is shared by CLI and Studio. Flexible Build remains advisory and public alpha.

## Changes

- A denied native `exec` can be corrected through the existing checked MCP command
  path only after host-written denial policy, pinned binary and staged-state
  verification, with a durable no-effect receipt. Error text alone is not proof.
- Failed receipt persistence cancels execution while holding the host queue,
  preventing another queued operation from running without evidence.
- Narrowly eligible historical denied-exec refusals can explicitly resume from
  the last accepted candidate after cleanup, custody and fingerprint checks.
  The refused mirror is never adopted, imported or replayed.
- Resume accepts a smaller cumulative `--max-calls` ceiling, at least the calls
  already consumed. Reviewer calls count too; other budgets remain unchanged.

## Validation and limits

Full root/CLI and Studio suites passed locally. Targeted coverage includes 150
tests with no skips, additional real SIGKILL/restart recovery checks, and 82
native/loop/inspection regressions after the tighter call-cap change. Tests cover
two maker slices through verification/review, actual macOS child-process denial,
policy/artifact tampering, edit mistakes, unexpected native exec success, receipt
failure and budget stops. Packaged-runtime parity passed. No provider inference
was used and no fresh live SWE success or Company Brain completion is claimed.

The reviewed Devin artifact remains `3000.10.21 (611c1cba)`; an auto-updated
default executable is not implicitly accepted. Internal SWE inference/token spend
remains unknown and requires the existing explicit consent. No admission,
routing, model default, billing or publication permissions change.

## Upgrade and bounded continuation

```bash
npm install -g camus-cli@0.4.29
export CAMUS_DEVIN_BIN="$HOME/.local/share/devin/cli/_versions/3000.10.21/bin/devin"
camus --version
```

Restart Studio or other long-lived Camus processes before using the new runtime.
Keep an existing accepted candidate: inspect first, then explicitly resume only
when the run is eligible, unowned and authorized. For Company Brain's existing
seven-call remainder (three calls already consumed):

```bash
camus build --inspect code-1789435781661-50eb06c8 --json
camus build --resume code-1789435781661-50eb06c8 --max-calls 10 --json
```

Ten is the cumulative ceiling, not ten additional calls. Do not use
`--retry-uncertain`, import refused mirrors, change checkpoint state, or extend
budgets. Existing verification and independent review are still required.

See [the setup guide](SWE-SETUP.md) and
[contract evidence](SWE-CONTRACT-VALIDATION.md#denied-native-exec-and-continuity-hardening-0429).
