# Reviewer benchmark harness

The Slice G harness is deliberately split into an offline evidence gate and a live campaign.
This release implements the offline gate. It makes no provider calls, admits no backend, and
does not ship a public defect corpus. Live runs begin only after the operator approves the
providers, spend, and publishable corpus.

The contract is:

- `benchmark-campaign.v1.schema.json` freezes the baseline, candidates, corpus version, prompt
  envelope, repetitions, transports, and human-owned thresholds before outcomes exist.
- `benchmark-receipt.v1.schema.json` describes one content-addressed attempt. A rerun is a new
  receipt with a new repeat number and optional `rerunOf`; nothing is overwritten or discarded.
- `benchmark_reviewers.py` appends receipts and derives a report from the full ledger.
- A passing row says `eligible_for_human_admission` and `registryChanged: false`. The harness
  cannot enable its own candidate.

The statistics follow RFC v6.1 §16: exact Clopper–Pearson 95% rate intervals; conservative
paired candidate-minus-baseline intervals for recall and false positives; an absolute FPR
margin that remains decidable when baseline FPR is zero; fixed-denominator containment with
the rule-of-three upper bound; and a paired 90% transport-equivalence interval. The paired
method factors discordance rate and conditional direction into exact binomial intervals and
combines them with Bonferroni coverage. It is intentionally conservative: inadequate sample
size widens the interval and refuses admission.

The derived report also keeps each arm/case cell visible: repeated-outcome flakiness,
cold/resident median and p90 latency, token-reporting coverage and totals, provider-receipted
cost (never an estimate), and every decoding profile used. Aggregate arm metrics do not erase
those cell-level distributions.

Transport is part of the candidate identity and its equivalence result gates eligibility. In
particular, an SSH candidate without a predeclared comparison against the corresponding
direct/loopback arm refuses; a quality pass on another route cannot be borrowed.

```bash
camus benchmark append \
  --campaign campaign.json \
  --ledger ~/.camus/benchmarks/<campaign>/receipts.jsonl \
  --receipt attempt.json

camus benchmark summarize \
  --campaign campaign.json \
  --ledger ~/.camus/benchmarks/<campaign>/receipts.jsonl \
  --out summary.json
```

The still-open live half must run the current Codex baseline and each candidate through the
real dispatcher/normalizer against the same versioned synthetic corpus. It must also inject
kill, abort, identity-alias, and tunnel-failure cells. No previous campaign can serve as the
baseline for a new corpus or prompt-envelope version.
