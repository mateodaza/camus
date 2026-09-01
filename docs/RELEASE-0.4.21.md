# Camus 0.4.21 — resilient native work and bounded metacognition

Camus 0.4.21 addresses the failure exposed by a real long-running Grok Build
candidate: useful native work no longer has to become a non-resumable dead end
solely because its final model receipt was unavailable after the harness stopped.

## What changed

- Native work runs in bounded model/action/time slices. A maker can return the
  typed `continue` decision when useful work remains; Camus reuses a trusted
  session only inside the original limits.
- When a native turn is uncertain but the adapter proves all candidate writers
  and gateways are closed, Camus validates paths and Git custody, fingerprints
  the filesystem as an **untrusted recovery draft**, discards the hidden session,
  and continues from that draft in a fresh session. It does not replay the
  uncertain turn or promote it to completion.
- Cleanup that cannot be proven remains fail-closed and inspection-only. Grok
  ACP cleanup errors can no longer be suppressed beneath an apparently normal
  result.
- `maxRecoveries` is a separate, visible allowance. Calls, actions, tokens,
  active time, per-call time, repairs, and retries retain their existing global
  accounting. Studio and CLI can extend the relevant totals without resetting
  usage.
- Makers have a bounded metacognitive decision vocabulary: continue, request
  budget, request a model/harness change, request an append-only contract
  amendment, ask an irreducible human question, recheck evidence, rebut, or stop.
- A human-authorized pair change re-qualifies the requested seats and rebinds
  the exact candidate. File-action custody may move only to file-action custody;
  native custody may move only to native custody. Incompatible transitions stop
  before another model call and require an explicitly migrated child run.
- Human contract amendments are append-only, bound to the outstanding question
  and candidate fingerprint, and carried into every later maker and reviewer
  prompt. The original contract is never silently rewritten.

## Trust boundary

Metacognition recommends; deterministic code authorizes. No model can expand its
own spend, time, tools, model route, contract, verification replay, publication,
or repository authority. Review remains advisory and final adoption remains a
separate human action.

Older native checkpoints do not acquire the new recovery interpretation. Only
new checkpoints carrying `quiescent_draft_v1` may use it; hard-crash/in-flight
state without a live adapter cleanup receipt remains parked.

## Verification

- Full Loop Studio suite: native adapters and cleanup, evaluator contracts,
  productive loop, authenticated inspection, crash recovery, and HTTP parity.
- Full root and CLI suite, including the packed-runtime isolation check and 672
  workflow assertions.
- Studio/CLI model-change continuation through the same preserved candidate,
  using only mocked provider adapters.
- Production web build, npm payload dry run, secret-pattern scan, syntax checks,
  and `git diff --check`.
- No provider, API-credit, or subscription call was made for this release.

## Upgrade

```bash
npm install -g camus-cli@0.4.21
camus install
camus check
camus build --models
```

The public alpha still makes no model-admission, automatic-routing, quality, or
cost-optimality claim from this infrastructure release.
