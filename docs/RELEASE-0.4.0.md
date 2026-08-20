# Camus 0.4.0

Camus 0.4.0 is the deterministic-control-plane release. It was earned by running the
approved Open Model Seats foundation through a twelve-task Camus dogfood feature, then
fixing the reliability and velocity defects that the run exposed.

## Highlights

- The Hybrid Kernel owns canonical feature state, compact task selection and dispatch,
  budgets, maker/reviewer evidence, Git custody, atomic recovery, and model-free task land.
  Models choose and judge semantic work; local code decides operational facts.
- `camus kernel integrate` validates every durable task merge receipt, rechecks the
  environment and budgets, and requires an untampered green bound to the exact feature
  HEAD before terminal status is written. Same-HEAD replay is instant; a clean descendant
  integration repair must re-earn proof and preserves the prior receipt in history.
- Terminal kernel integration refreshes the human-facing report from canonical state, so
  status and report cannot silently disagree after a hybrid run.
- Direct maker receipts preserve input, cache, output, cost, duration, model, and outcome as
  distinct upstream metrics. Direct output and legacy workflow totals are budgeted without
  adding unlike units into a fictitious total.
- Open Model Seats Slice A plus the B migration core has landed: derived model identity,
  registry-backed lineage, connection objects and legacy migration, pairing v2/status v2,
  evidence envelope 3, frozen canonical compatibility, and fail-closed validation.
- Loop Studio now isolates Claude routing variables, preserves legacy custom-provider
  identity as unknown until declared, exposes only connection and env-var names on read-only
  surfaces, and provides connection-first doctor diagnostics without leaking credential values.
- Risk-routed dogfood showed the velocity direction: Concise maker output reduced the large
  task's output/cost/time, while Concise plus low effort completed the bounded documentation
  task in under a minute. Independent reviewer effort remained high.

## Install or upgrade

```bash
npm install -g camus-cli@0.4.0
camus install
camus check
```

Camus requires authenticated Claude Code and Codex CLIs. It runs the target repository's
own build and test commands, so use it only on code you trust and never as root.

## Honest boundary and next slices

This release ships the trust and migration foundation, not the user-visible completion of
Open Model Seats. Slice C adds qualified direct/loopback Studio seats for Grok, Kimi, Qwen,
and local servers. Slice F adds generic CLI reviewer backends. Slice D adds the managed SSH
inference tunnel security core, followed by Slice E's Studio connection UX. No SSH or generic
open-model CLI backend is claimed in 0.4.0, and the provider-backed live matrix remains a
deliberate test for those implementation slices.
