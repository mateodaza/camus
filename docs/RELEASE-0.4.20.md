# Camus 0.4.20 — provable Grok completion and live CLI attachment

Camus 0.4.20 fixes two defects found in a real Grok subscription run: Grok
Build could complete inference and close while its `streaming-json` output omitted
the separate terminal frame Camus required, and Studio attached to a CLI-owned
run showed checkpoints without the run's safe model-progress trail.

## What changed

- The built-in `grok:grok-4.6` + `grok_native` maker now uses Grok Build's
  official ACP `session/prompt` completion boundary. Grok still owns its
  subscription-authenticated inference and context; Camus hosts every bounded
  filesystem and terminal tool. No `XAI_API_KEY`, API-credit fallback, provider
  substitution, or model substitution is introduced.
- Terminal states are explicit. A missing ACP completion is
  `terminal_missing` and remains uncertain. A received completion with missing
  or invalid receipt evidence is a distinct terminal diagnostic. The candidate
  remains inspectable, but review, automatic adoption, and replay are refused.
  Valid usage and model evidence observed before later validation fails is
  retained rather than collapsed to false zero.
- Native repair may tighten but never widen the saved model-call or action
  ceilings. Run-private OAuth copies are still removed on success and failure.
- Studio now relays only sanitized `progress` and `session` events from the
  shared event trail while a CLI worker owns the run. Checkpoints remain the
  authority, and attaching never starts a second worker or buys another model
  call.

## Evidence and standing

The ACP v4 transport has provider-free adapter, candidate-custody, accounting,
repair, CLI/Studio attachment, and fail-closed regression coverage. The earlier
verifier-green Grok cells exercised the retired subscription-headless transport;
their results remain historical and do not grant ACP v4 admission, routing,
reviewer closure, optimal-pairing, or quality standing. A future bounded live
smoke must receive fresh authorization.

## Verification

- Full native, evaluator, code-loop, crash-recovery, and CLI/Studio parity
  pretest, including the reproduced terminal and attachment defects.
- Full Loop Studio suite and root/CLI suite.
- npm payload dry run, secret-pattern scan, and `git diff --check`.
- No provider or subscription call was made while preparing this release.

## Upgrade

```sh
npm install -g camus-cli@0.4.20
camus install
camus check
```

Runs already terminal under an older version are not rewritten. Inspect their
preserved candidate and start a fresh run to use the ACP v4 policy.
