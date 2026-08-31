# Camus 0.4.16 — a more reliable Flexible Build

Camus 0.4.16 hardens the experimental Flexible Build coding loop and makes its
operator surfaces more honest and usable. It does not admit a new reviewer,
enable automatic routing, or claim a best model or harness.

## What changed

- `camus build --inspect RUN_ID [--json]` authenticates the shared CLI/Studio
  checkpoint and returns a bounded, provider-free, read-only projection with one
  conservative next action. It cannot retry, extend a budget, accept, land, or
  mutate a run.
- File-action makers use a stricter structured protocol, bounded repository
  discovery, one safe missing-file read, explicit create semantics, and
  hash-bound focused replacement. Repeated mutation-free discovery parks instead
  of buying an unbounded sequence of identical turns.
- Known completed responses and writes remain recoverable without replay;
  uncertain provider work stays uncertain. Owned subprocesses and descendants
  are cleaned before terminal state is accepted.
- The landing page and Loop Studio now distinguish capability qualification,
  advisory Flexible Build, the admitted Claude → Codex proof gate, and the
  evidence threshold required before routing can change.
- Studio exposes the maker harness in the main Build flow, keeps comparison out
  of code mode, brings human questions fully into view on mobile, and improves
  focus, keyboard tabs, live status, contrast, touch targets, and small-screen
  overflow behavior.
- The web build moves to patched Next.js, Sharp, PostCSS, and NanoID versions;
  the production dependency audit reports no known vulnerabilities. Future
  release verification also rebuilds the public site and fails on high-severity
  production dependency advisories.

## Trust boundary

Flexible Build remains experimental and advisory. Maker and reviewer may be
selected independently, including same-model or same-provider pairs, but only
recorded identity evidence can earn an independence claim. A clean advisory
review never lands a candidate automatically. The production reviewer admission
registry and evidence-gated automatic routing remain unchanged.

## Verification

- Full root and CLI suite, including 672 workflow assertions.
- Full Loop Studio suite and trust-package suite.
- Production static landing build and hosted Studio asset sync.
- Desktop and 390px mobile checks for launch, Setup, Build, run, checkpoint, and
  revision navigation.
- npm payload dry run, production dependency audit, secret-pattern scan, and
  `git diff --check`.
- No provider calls were made for this UX/release pass.

## Upgrade

```sh
npm install -g camus-cli@0.4.16
camus install
camus check
```
