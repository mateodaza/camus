# Camus 0.4.32 — routine SWE failures stay inside the turn

This maintenance release reduces avoidable whole-turn refusals in the shared
CLI/Studio Devin adapter. Flexible Build remains advisory and public alpha.

## Changes

- Generate the pinned CLI's `version: 1` config upfront. A real no-prompt session
  reproduced migration of the old unversioned config, which invalidated Camus's
  exact exec-denial proof despite unchanged permissions. The corrected session
  passes that same strict proof.
- Check post-session policy evidence before dispatching inference, so drift can
  refuse with zero model prompts rather than after minutes of work.
- Reconcile failed native reads only with a permitted target, no associated
  write grant, unchanged checked state and verified inventory/write evidence.
- Give previously admitted overlapping work up to five seconds to settle inside
  the existing deadline. Queue later host operations behind durable reconciliation;
  allow only already-granted writes to finish delegated I/O through the barrier.
- Distinguish policy/config/artifact and settlement failures using fixed public
  diagnostic labels. Never publish raw tool errors, prompts or credentials.

Uncertain writes, permission breaches, artifact drift, unproven cleanup and
missing receipts remain refused. No fallback, admission, billing, model-selection
or automatic acceptance policy changed. Failed mirrors are never imported.

## Evidence

The no-prompt check used the actual pinned CLI but requested no model inference.
Offline regressions cover migration, denied exec, failed read, native/host overlap,
delegated write completion, cancellation, and unsafe effects. A shared Build
campaign survives nine routine failures over three maker turns, detects a real
verification failure, repairs it and reaches a separate fixture reviewer, with
zero recoveries consumed. Full root/CLI, Studio, packaging and release CI remain
mandatory gates.

No live SWE completion or Company Brain completion is claimed. Native inference
spend remains unknown under the explicitly accepted observed-only contract.

## Company Brain continuation

```bash
npm install -g camus-cli@0.4.32
export CAMUS_DEVIN_BIN="$HOME/.local/share/devin/cli/_versions/3000.10.21/bin/devin"
camus --version
camus build --inspect code-1789435781661-50eb06c8 --json
```

Resume the original run from accepted fingerprint `e7c226e2…` only after ownership,
integrity and eligibility checks. Keep the original task, contract, verifier and
SWE-2 High / Opus 4.8 high pair. Do not import refused mirrors or start from zero.

The last read-only checkpoint was revision 616: 13/16 calls, 8/8 recoveries,
536/768 actions and about 87/120 active minutes. The three remaining calls alone
are not a credible completion budget for the recorded remaining scope. Request
one consolidated continuation authorization, including any required call,
recovery, action and time extensions; reserve capacity for verification, review
and repairs. Upgrading this package grants no additional spend or authority.

Restart only idle Studio processes. No commit, merge, push or publication of the
candidate without separate authority.

See [setup](SWE-SETUP.md) and
[contract evidence](SWE-CONTRACT-VALIDATION.md#routine-tool-failure-continuity-0432).
