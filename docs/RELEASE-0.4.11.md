# Camus 0.4.11 — balanced smoke with mechanical integrity

Camus Code Harness Eval v1a now includes a deterministic balanced repair case
alongside its original simple parser case. This release also closes a trust gap:
a candidate can no longer earn a mechanically green receipt by changing the
fixture's tests or adding unrelated artifacts.

## What changed

- `camus code-eval fixture --case balanced-job-event-scheduler --json` checks a
  content-addressed job-event reducer and dependency scheduler. The base is
  deterministically red, the reviewed reference is green, and readiness makes
  zero provider calls.
- Campaign and cell contracts bind the selected case version and actual task
  class. The original simple case remains the default when `--case` is omitted.
- Before any candidate verifier runs, Camus checks the Git candidate against the
  fixture's declared `referenceFiles`. Changed tests, unexpected tracked,
  untracked or ignored artifacts, deletions, and non-regular or symlinked solution
  paths fail candidate integrity.
- The final receipt includes that mechanical result in its containment and
  quality floor. A passing test or approving reviewer cannot override a failed
  candidate-integrity check.
- Qwen/Grok's one-run gateway now enforces the authorized tool-action ceiling
  before execution. It withholds a provider response containing action N+1 while
  still accounting that provider call and its reported usage; the non-operative
  `structured_output` terminal does not consume an action.
- Both public fixtures ship in the isolated npm runtime; packaging tests execute
  their spend-free readiness checks from the packed CLI.

## Deliberate boundary

The evaluator is still v1a: one explicitly authorized `qwen_native` or
`grok_native` smoke per campaign. The balanced case supports one balanced-case
observation, not balanced-class coverage. Raw arms, matched raw/native pairs,
counterbalancing, summaries, winners, recommendations, admission, and automatic
routing remain unimplemented.

A contract-honest paired evaluator is the next bounded slice. It needs coordinated
campaign, scheduler, execution snapshot, ledger, marker, raw-call accounting,
receipt, recovery, and summary work; this release does not substitute separate
smokes or manual forensics for that evidence boundary.

## Verification

- Full root and CLI suite, including 672 workflow assertions and packaging-runtime
  isolation.
- Full Loop Studio suite.
- 30 focused Code Harness Eval contract, fixture, ledger, runner, crash, route,
  and candidate-integrity assertions.
- Both tracked fixture readiness checks: base red, reference green, zero provider
  calls.
- `git diff --check` clean.
- The optional installed-harness integration was rerun with the reviewed private
  Qwen Code 0.22.3 and Grok Build 1.0.5 artifacts: 2/2 passed through the isolated
  fake-provider gateway with zero real provider calls and zero skips. The second
  test proves a permitted Grok action can write while attempted action N+1 cannot
  mutate the disposable candidate.

## Upgrade

```sh
npm install -g camus-cli@0.4.11
camus code-eval fixture --case balanced-job-event-scheduler --json
```

For the legacy proof gate, also run `camus install && camus check`. Studio remains
checkout-based: fast-forward a clean checkout, restart its local server, and
reload the page.
