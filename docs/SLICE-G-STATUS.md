# Open Model Seats — Slice G status

**Status:** offline admission gate implemented; 0.4.6 shadow collection route implemented; formal
provider campaign and admission not started

**Date:** 2026-08-26

Slice G now has the evidence ledger and statistical decision machinery needed to compare Codex
with Grok, Qwen, Kimi-backed, or generic HTTP reviewer candidates. It intentionally cannot call a
provider or edit the production reviewer registry.

Camus 0.4.6 adds an intentionally weaker operational bridge: a Studio-configured HTTP model may
review the same real code candidate immediately before Codex. Its signed `trial1:` receipt,
availability, latency, usage, and verdict agreement become local experiment evidence. The
production dispatcher still rejects it, Codex remains the gate, shadow experiments are
explore-only, and the report names no shadow winner. This starts honest provider-backed learning;
it does not satisfy the formal repeated campaign below.

## Implemented offline gate

- A campaign schema freezes the baseline, candidates, corpus, prompt envelope, repeats, transports,
  and human-owned thresholds before outcomes exist.
- An append-only, content-addressed `bench1:` ledger preserves every attempt. Duplicate cells are
  refused; reruns must point to a prior attempt and remain in every denominator.
- The receipt schema accepts only bounded usage and decoding facts and rejects raw provider output,
  credentials, and broad diagnostic payloads.
- Summary statistics use exact Clopper–Pearson intervals, conservative paired difference intervals,
  an absolute false-positive margin, fixed-denominator containment with a rule-of-three upper bound,
  a conclusive-rate floor, and a paired 90% transport-equivalence interval.
- Derived evidence preserves per-cell outcome flakiness, cold/resident latency distributions,
  reported token coverage, provider-receipted cost (never an estimate), and decoding profiles.
- Any containment breach disqualifies. Underpowered evidence fails rather than inventing certainty.
  A passing result says only `eligible_for_human_admission` with `registryChanged: false`.
- Transport equivalence is an eligibility gate, not a dashboard-only statistic. An SSH arm without
  its predeclared direct/loopback equivalence pair refuses instead of being admitted on quality
  evidence from a different route.

Use `camus benchmark append` and `camus benchmark summarize` as documented in
`packages/cli/skills/camus/BENCHMARK.md`.

## Still required before admission

- Approve a publishable versioned defect/clean corpus and campaign budget.
- Run the current Codex baseline and each candidate through the real dispatcher and normalizer.
- Include kill, abort, model-alias/substitution, malformed output, and tunnel-failure cells.
- Segment quality, latency, token use, and containment by task class so a future orchestrator can
  route to the best qualified model for the scenario rather than one global winner.
- Submit any statistically eligible candidate to explicit human admission. Until then, production
  routing remains Claude → Codex and every other reviewer stays benchmark-disabled.
