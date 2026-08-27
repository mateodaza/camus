# Reviewer benchmark harness

The Slice G harness is deliberately split into evidence collection, statistical eligibility,
and human admission. The live runner ships a public synthetic corpus and can call providers only
through an explicit, bounded `run` command. Planning and status are spend-free. No command in the
harness can add its own production admission.

The contract is:

- `benchmark-campaign.v1.schema.json` freezes the baseline, candidates, corpus version, prompt
  envelope, repetitions, transports, and human-owned thresholds before outcomes exist.
- `benchmark-receipt.v2.schema.json` describes one current content-addressed attempt. Every v2
  receipt binds the complete frozen campaign digest and exact non-secret execution-state digest;
  kill receipts additionally bind their production probe, expected/observed refusal, and zero
  provider calls. Frozen v1 receipts remain readable, but v1 evidence cannot satisfy current
  admission. A rerun is a new receipt with a new repeat number and optional `rerunOf`; nothing is
  overwritten or discarded.
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

Freeze a campaign before spend:

```bash
camus benchmark plan \
  --candidate-backend xai --candidate-model grok-4.6 --candidate-effort medium \
  --baseline-model gpt-5.6-sol --baseline-effort high \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json

camus benchmark status \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json \
  --ledger ~/.camus/benchmarks/grok/receipts.jsonl

# Run the complete spend-free control matrix. This never loads a provider credential.
camus benchmark kill --max-cells 24 \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json \
  --ledger ~/.camus/benchmarks/grok/receipts.jsonl

# Exactly two attempted provider cells, each sealed before the next starts.
camus benchmark run --max-cells 2 \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json \
  --ledger ~/.camus/benchmarks/grok/receipts.jsonl
```

Immediately before a provider cell starts, the runner fsyncs an in-flight marker next to the
ledger. A crash can therefore never make the next invocation silently buy the same cell again.
If the receipt was already fsynced, status clears the stale marker idempotently. Otherwise, wait
for the bounded executor to end and explicitly close the unknown outcome as an infrastructure
failure before continuing:

```bash
camus benchmark recover --action seal-infra \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json \
  --ledger ~/.camus/benchmarks/grok/receipts.jsonl
```

`benchmark-corpus.v1.json` has 25 cases: 14 seeded defects, seven clean false-positive baits,
and four kill-path controls. The live runner owns the 420 provider-backed quality cells. The
separate `kill` command runs abort, identity substitution, malformed-output, and interrupted-
transport controls through the shipped watchdog, identity binder, and normalizer. It appends one
v2 receipt at a time, is safely resumable, and has no provider-call branch. Every kill path must
be green in addition to the quality and human-calibration bars before admission is eligible.

After `summarize` reports `eligible_for_human_admission`, `benchmark admission-proposal` validates
the summary by deriving it again from the supplied complete ledger, checks its campaign/execution
digests and exact `ledger1:` receipt-set digest, and validates a real-human calibration set. It
writes a proposal only. Admission
requires adding that exact `admit1:` entry to the checked-in registry through reviewed source
history. Entries expire within 90 days and bind profile, model, effort, origin, transport,
connection, the content-derived `qual1:` fingerprint, corpus, prompt, evidence summary, and the
exact human-calibration campaign plus its content digest. Calibration needs two distinct,
identity-stable judge models at the agreement bar;
two labels over one actual model cannot masquerade as independence.

That reviewed registry entry is necessary but not sufficient by itself. The production workflow
must also request the exact admitted model, profile backend, training organization, transport,
connection, and `qual1:` fingerprint. The dispatcher matches both sides, adds the `admit1:` id to
the executor environment, and the executor seals it into the returned binding. `camus-loop` refuses
an external verdict without that authority and `camus-feat` preserves the same route through
resume/start/await/abort. Private endpoints, tunnel configuration, and credentials stay outside
workflow state.

```bash
camus benchmark admission-proposal \
  --campaign ~/.camus/benchmarks/grok/campaign.json \
  --state ~/.camus/benchmarks/grok/state.json \
  --ledger ~/.camus/benchmarks/grok/receipts.jsonl \
  --summary ~/.camus/benchmarks/grok/summary.json \
  --human-calibration ~/.camus/studio/judge-calibration/<generation>/model-eval-judge-calibration.json \
  --approved-by "Your name" \
  --approved-at 2026-08-27T12:00:00.000Z \
  --expires-at 2026-09-26T12:00:00.000Z

# Only after the proposed entry has landed in the checked-in registry:
camus benchmark admission-activate --admission-id admit1:REPLACE_WITH_64_HEX
```

`admission-activate` is network-free. It exact-matches the packaged registry and private Studio
profile, then writes a `0600` machine-bound qualification authority whose HMAC includes an opaque
credential revision and the exact `admit1:` id. Credential rotation or admission-id substitution
therefore refuses before network use until a human explicitly activates the still-current
checked-in admission again; no secret enters the record.
