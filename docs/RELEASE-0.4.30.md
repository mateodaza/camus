# Camus 0.4.30 — continuous, bounded SWE recovery

Eligible failed SWE turns no longer require a human restart after every isolated
tool failure. CLI and Studio share the same recovery behavior. Flexible Build
remains advisory and public alpha.

## What changed

- After proven cleanup, a failed isolated tool turn can be discarded in full.
  Recovery revalidates the **last accepted candidate**, not the refused mirror.
  Eligibility is based on cleanup, pinned identity and custody evidence rather
  than individual native tool names or provider error categories.
- Fresh eligible failures can continue automatically in a new session within the
  existing recovery, call, action, step, token and active-time limits. Counters
  never reset. User stop, failed integrity checks and exhausted limits still stop
  dispatch; budget extensions and new authority remain human decisions.
- Recovery feedback directs remaining edits through checked Camus MCP reads and
  writes. Failed operations are not replayed, and partial writes are never
  labelled harmless or successful. Refused mirrors remain preserved and excluded.
- Fixed, redacted reconciliation labels distinguish changed targets, mismatched
  approved outputs, unexpected inventory, overlapping work and receipt failures.

The candidate still needs frozen verification and independent review. There is
no per-file salvage, automatic acceptance, publication, model default, billing,
admission or routing change.

## Evidence and limits

The reported Company Brain draft contained an empty `index.ts` where the write
approval expected nonempty bytes. Three other new modules matched their approval
hashes. Rejecting that draft was correct; why the native write truncated the file
is not established. This release fixes Camus recovery, not the upstream harness.

Full root/CLI and Studio suites passed locally. The final adapter/loop run passed
87 tests and diagnostic/workspace tests passed 51, with no failures or skips.
Five SWE SIGKILL/restart windows passed without replay or duplicate recovery
charges. The end-to-end offline test truncates a native file, discards that turn,
retains earlier accepted work, then completes through checked writes, frozen
verification and independent review. Packaged CLI parity also passed.

No live model call or new Company Brain completion is claimed. Unknown internal
SWE inference/token spend still requires explicit consent. The reviewed Devin
artifact remains `3000.10.21 (611c1cba)`; auto-updated binaries are not implicitly
accepted. Failures without an accepted snapshot, proven cleanup or valid custody
remain blocked.

## Upgrade and Company Brain continuation

```bash
npm install -g camus-cli@0.4.30
export CAMUS_DEVIN_BIN="$HOME/.local/share/devin/cli/_versions/3000.10.21/bin/devin"
camus --version
camus build --inspect code-1789435781661-50eb06c8 --json
```

Restart idle, long-lived Studio processes before using the new runtime. Do not
interrupt an active worker. Last read-only inspection: revision 186, unowned,
four calls and two recoveries consumed, accepted candidate intact. If the run
remains eligible and the existing six-call authorization remains in force:

```bash
camus build --resume code-1789435781661-50eb06c8 --max-calls 10 --json
```

Ten is the **cumulative** ceiling: four consumed plus six additional calls,
including reviewers. All other saved limits remain unchanged. Do not use
`--retry-uncertain`, import refused mirrors, edit checkpoints or extend budgets.

See [setup](SWE-SETUP.md) and
[contract evidence](SWE-CONTRACT-VALIDATION.md#continuous-isolated-turn-recovery-0430).
