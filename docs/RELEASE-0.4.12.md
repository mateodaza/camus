# Camus 0.4.12 — bounded raw/native harness isolation

Camus Code Harness Eval v1b can now run one exact model and fixture through two
isolated execution arms: raw API file actions and the model's native coding
harness. The pair is deliberately small, counterbalanced, crash-safe, and unable
to turn an observation into a winner, admission, or routing decision.

## What changed

- A closed v1b campaign binds exactly one case, one model/provider/connection,
  one native executor and artifact, one reviewer screen, one verifier, one
  repeat, and two arms. Unknown fields and contract drift fail closed.
- Scheduling uses Git SHA parity to counterbalance raw-first and native-first
  order. Each invocation may run at most the next cell and requires fresh
  explicit provider consent; planning, status, recovery, fixture inspection, and
  summary remain provider-free.
- Raw execution uses the shared Build engine's file-action path. Native execution
  uses the corresponding `qwen_native` or `grok_native` path. Both receive the
  same frozen task, acceptance contract, worktree boundary, verifier, reviewer,
  and resource ceilings.
- The append-only ledger and global in-flight marker bind the complete cell and
  authorization nonce. A valid fsynced receipt wins over a stale marker; an
  uncertain paid cell is sealed unknown and never replayed automatically.
- Every Build subprocess is registered before launch and supervised outside the
  worker. Recovery requires the Build lease to be released and every durable
  process intent to prove terminal cleanup of the exact target and observed
  descendants. Incomplete ownership evidence refuses recovery.
- Provider wrappers distinguish a preflight refusal that made no model call from
  an uncertain or measured call, so reservations and accounting remain honest.
  A paid raw response that fails protocol parsing retains its call, token, and
  observed-identity evidence while recording zero accepted protocol steps.
  OpenRouter observations retain the exact requested upstream, observed provider,
  attempt number, and fallback status.
- Candidate integrity now checks the actual worktree returned by Build before
  verification or a final receipt, closing the remaining v1a handoff gap.
- `camus code-eval summarize` reports coverage, quality floors, reviewer-screen
  standing, and paired economics only within the exact case. Quality precedes
  economics. It cannot name a winner, recommend a harness, alter routing or
  admission, land Git work, publish, or write operator settings.

## Deliberate boundary

This release ships experimental evidence infrastructure, not a model or harness
recommendation. One pair is one case-scoped observation. There is no cross-case
ranking, automatic task-class routing, external reviewer admission, provider
fallback, or hidden retry. A live Qwen or Grok pair still needs fresh consent for
each of its two cells after installation.

Studio shares the execution and custody engine but intentionally has no live-pair
campaign UI or ambient provider authorization. The operator path is the CLI.

## Verification

- Full root and CLI suite, including 672 workflow assertions and packed-runtime
  isolation.
- Full Loop Studio suite, including 80 Code Harness Eval and owned-process tests.
- Focused raw/native route, no-model-call, containment, reviewer, budget,
  scheduler, ledger, recovery, and summary regressions.
- `git diff --check` clean.
- No provider calls were made while implementing or verifying this release.

## Upgrade

```sh
npm install -g camus-cli@0.4.12
camus code-eval --help
```

For the legacy proof gate, also run `camus install && camus check`. Studio remains
checkout-based: fast-forward a clean checkout, restart its local server, and
reload the page.
