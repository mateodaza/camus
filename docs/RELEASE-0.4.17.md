# Camus 0.4.17 — Grok Build on your subscription

Camus 0.4.17 adds a true subscription-backed Grok Build maker path. Selecting
the built-in `grok:grok-4.6` seat with `grok_native` preserves Grok Build's own
authenticated inference route and consumes the operator's Grok subscription
allowance. It does not use `XAI_API_KEY`, spend xAI API credits, or silently fall
back to an API-backed seat.

## What changed

- The built-in Grok seat launches the reviewed Grok Build 1.0.13 macOS-arm64
  artifact, bound to SHA-256
  `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`.
- Grok keeps its native model loop and subscription authentication. Camus keeps
  candidate custody, bounded read/edit/search/list tools, call and action limits,
  deterministic verification, independent review, and the human checkpoint.
- The worker receives no xAI API key. Configured `xai:*` seats remain a separate,
  explicit API-credit path through Camus's exact-model gateway.
- Run-private OAuth state is removed after success and failure. Hook command
  paths are safely quoted, hook input is bounded, and repair/resume can tighten
  but never widen the original call or action limits.
- Sealed receipts bind the exact `grok_subscription` billing authority and
  subscription policy. Missing identity evidence remains unknown instead of
  being mislabeled as detected substitution.

## Evidence and standing

Three bounded simple-task subscription runs produced the exact intended patch,
passed the trusted verifier, used exactly three Grok calls and four guarded
actions, and recorded no API-key fallback. The latest run measured 13,597 tokens
and 14.7 seconds of maker time.

The selected GPT-5.6 Luna reviewer did not return within the five-minute cell in
those runs. Camus therefore makes no end-to-end approval, reviewer-admission,
automatic-routing, cross-task ranking, or best-model claim. The subscription
seat remains experimental and advisory; a human must inspect and accept its
candidate.

## Verification

- Full root and CLI suite, including 672 workflow assertions.
- Full Loop Studio suite and trust-package suite.
- Native-harness suite: 66 passed with three intentional opt-in skips.
- Targeted evaluator/native regression suite: 55 passed.
- npm payload dry run: 125 files, including the subscription adapter.
- Secret-pattern scan, OAuth scratch cleanup check, and `git diff --check`.

## Upgrade

```sh
npm install -g camus-cli@0.4.17
camus install
camus check
```
