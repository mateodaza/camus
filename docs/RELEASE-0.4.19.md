# Camus 0.4.19 — Studio/CLI Grok parity

Camus 0.4.19 fixes a Studio admission mismatch for the built-in Grok
subscription seat introduced in 0.4.18. The CLI and Studio Flexible Build now
apply the same shared vendor-managed built-in classification, so a qualified
`grok:grok-4.6` selection can launch through either surface.

## What changed

- Studio's control plane uses the shared built-in backend registry instead of a
  separate Claude/Codex allowlist.
- The words-lane launch boundary uses the same predicate, avoiding a second
  inconsistent classification.
- Studio run snapshots preserve the seat's `grok_subscription` billing
  authority instead of dropping it during explicit per-run selection.
- A configurable backend cannot earn built-in standing by copying the
  `vendor_managed` transport or a `builtin1:` fingerprint.

The execution contract is otherwise unchanged. Built-in Grok still uses Grok
Build's authenticated subscription path, never falls back to `XAI_API_KEY`, and
remains experimental, advisory, and ineligible for automatic routing or gate
admission.

## Verification

- Full Loop Studio suite.
- Full root and CLI suite, including the packed-runtime isolation check and 672
  workflow assertions.
- HTTP regressions for Studio Flexible Build and explicit words-lane Grok
  launches.
- Positive built-in Grok admission and negative forged-built-in controls.
- `git diff --check`.

No provider call or paid smoke was needed: the defect occurred at Studio's
pre-dispatch admission boundary.

## Upgrade

```sh
npm install -g camus-cli@0.4.19
camus install
camus check
```
