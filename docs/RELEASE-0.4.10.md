# Camus 0.4.10 — bounded native-harness evidence

Camus can now run one explicitly authorized Qwen Code or Grok Build smoke through
the production Any-model Build engine and preserve the result as append-only
evidence. The new `camus code-eval` v1a path is deliberately narrower than a
general benchmark: it cannot compare models, name a winner, change routing or
admission, accept a candidate, commit, merge, push, or publish.

## What changed

- `camus code-eval fixture`, `plan`, `status`, `run`, and `recover` separate
  provider-free preparation from paid execution. A run requires fresh literal
  consent, an exact one-cell limit, frozen provider-call/token/action/time bounds,
  and a new campaign generation after any terminal or uncertain attempt.
- The tracked parser fixture binds its red base, green reference, task,
  acceptance contract, verifier, and tree digest. Private state binds the runtime,
  model/provider route, qualification and credential revisions, reviewer, native
  artifact, isolation policy, and gateway policy before spend.
- Receipts are append-only and content-addressed. Interrupted cells retain
  conservative billing uncertainty and can be sealed without another provider
  call; a stale marker or failed cell can never become permission to replay.
- OpenRouter experiments bind the exact upstream provider and fallback policy to
  both the request and observed response. Provider-qualified model IDs such as
  `qwen/qwen3.8-max` remain exact identities instead of being normalized away.
- Native Qwen Code now receives a private, drift-refusing zero-retry policy.
  Native Grok Build accepts only its pinned protocol and documented reasoning
  usage shapes, disables supported optional title/summary side calls, counts its
  unavoidable initial-title request, and preserves exact local stop reasons.
- Native makers receive a bounded host-observed tracked-file inventory and are
  told not to spend turns probing blocked `.git` or hidden root metadata. The
  sandbox boundary is unchanged: provider credentials, Git metadata, Camus
  receipts, arbitrary network, and protected paths remain unavailable.

## Evidence—not promotion

- On the simple bounded-parser fixture, raw Qwen3.8 Max produced the exact fix,
  passed deterministic verification, and received an independent Luna approval.
  The matched Qwen Code cell produced the same fix but failed to reach a
  definitive native terminal within its frozen budget. For this one task class,
  raw actions were faster and used fewer tokens; this is not a universal ranking.
- The first Grok Build cells exposed Camus stream/accounting defects. After those
  repairs, the final bounded Grok cell made the canonical one-line fix and its
  preserved candidate passes the verifier, but the harness exhausted its frozen
  turns before emitting a definitive terminal. Its receipt therefore remains
  failed, Luna was not called, and the candidate was not adopted.
- Failed and missing trials stay in the denominator. Manual forensic verification
  can explain a result but cannot upgrade its formal standing.

The detailed receipts, limitations, and current manual recommendations are in
[Recommended model and harness setup](RECOMMENDED-MODEL-SETUP.md).

## Deliberate boundaries

Qwen/Grok native makers remain experimental and macOS-arm64-only. Raw
`file_actions` remains the default. This release admits no external production
reviewer, activates no automatic task route, and claims no optimal model or
harness combination. Every Any-model candidate still requires human acceptance.

The next evidence slice adds a balanced deterministic fixture and matched
raw-versus-native repetitions. Difficult-task comparisons and automatic routing
remain downstream of repeated, task-class-specific, human-calibrated evidence.

## Verification

- Full Loop Studio regression suite.
- Root/CLI suite, including 672 workflow assertions and the control-plane,
  reviewer, recovery, and packaging-runtime gates.
- Provider-free pinned Qwen Code/Grok Build integration through the production
  isolation gateway.
- Extracted npm-package compatibility checks and `npm pack --dry-run`.

## Upgrade

```sh
npm install -g camus-cli@0.4.10
camus code-eval --help
```

For the legacy proof gate, also run `camus install && camus check`. Studio remains
checkout-based: fast-forward a clean checkout, restart its local server, and
reload the page.
