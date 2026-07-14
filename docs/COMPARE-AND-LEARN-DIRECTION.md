# Compare & Learn — model-resilient direction (adopted 2026-07-14)

Status: adopted product direction. This is not a pivot away from the 0.3 trust
layer. It operationalizes steps 6–9 of
[DIRECTION-0.3-TRUST-LAYER.md](DIRECTION-0.3-TRUST-LAYER.md): shadow audits,
pairing, reverse pairing, and evidence-gated routing.

The strategic line:

> Vendor agents decide how to do the work. Camus determines which approach
> performs best, whether its output is trustworthy, and what the evidence
> justifies learning from it.

As frontier models become better orchestrators, Camus should not compete with
their internal choreography. Native orchestration becomes an executor black
box that produces useful variance. Camus stays above it and owns the stable
part: the acceptance contract, knowledge custody, artifact identity,
independent judgment, comparison, human decisions, and outcome history.

An orchestrator never awards itself independent verified standing. Its output
may pass deterministic checks, and its own vendor may provide advisory review,
but independent standing still requires an auditor outside that vendor.

## Product shape

Camus grows from a single executor/auditor loop into a local experiment and
trust layer with three modes:

1. **Standard** — one executor, one independent auditor, bounded repair, sealed
   receipt. This remains the default.
2. **Compare & Learn** — two or more arms receive the same contract and frozen
   knowledge, then independent judges compare their artifacts without seeing
   the arm identities.
3. **High Stakes** — stronger deterministic checks, dual-vendor judgment where
   useful, explicit human approval, and a fresh closure audit before
   publication or merge.

These are human-facing presets, not hidden policy. Developers may inspect and
configure the full manifest.

## The human remains in the loop

Camus removes babysitting, not authority. The human:

- defines the goal, acceptance contract, and permitted knowledge;
- approves expensive comparisons or high-risk execution;
- resolves ambiguous requirements, judge disagreement, and P0 findings;
- chooses among viable artifacts, including whether to synthesize them;
- authorizes publication or merge; and
- teaches Camus by adjudicating findings and recording real-world outcomes.

Camus may recommend a route after enough local evidence. It must not silently
rewrite the user's objective, widen the knowledge boundary, select a universal
winner from a small experiment, or publish on the human's behalf.

## Experiment contract

Every comparison starts from one sealed manifest. At minimum it records:

- `experiment_id` and stable `arm_id` values;
- goal and acceptance contract;
- `knowledge_snapshot_id` and privacy classification;
- executor capability requested;
- model catalog snapshot and resolution timestamp;
- model requested, resolved, and actually used;
- orchestration mode requested and actual, when the runtime reports it;
- effort requested and actual, when the runtime reports it;
- input, output, cache, latency, and billing observations available at runtime;
- explicit fallback policy;
- judge identity and judge–arm vendor/family overlap;
- artifact, receipt, and parent artifact identities; and
- every outcome, including infra failure, quality-floor failure, and human halt.

Effort is a requested control unless the provider proves what was applied.
Provider-specific labels are not assumed comparable. Usage actuals are the
common observation; economics remain unknown when billing semantics are not
provable.

## Temporal model availability

Model availability is temporal and may change during a rollout. The catalog is
therefore evidence, not a static enum.

1. Resolve each requested capability once when the manifest is created.
2. Store the catalog snapshot and resolution time.
3. Do not re-resolve separately for each arm.
4. If a resolved model disappears and fallback was not authorized, seal the
   arm with `actual: null` and `infra_failed`.
5. If an explicit fallback runs, preserve `resolved != actual` and mark the arm
   confounded for model-comparison claims.

Silent substitution is never permitted.

## Knowledge custody

Retrieval is frozen before parallel execution. A Hivemind or other private
knowledge query produces a normalized, hashed local snapshot; every arm reads
that same snapshot. Arms cannot re-query live knowledge unless retrieval itself
is the variable under test.

Snapshots follow the corpus privacy rule: private knowledge remains local,
redacted by default, and only approved aggregates may travel. A snapshot hash
proves common inputs without publishing the inputs.

## Evidence before comparison

The next foundational primitive is a claim–evidence ledger. A reachable link
does not prove that the source entails a claim. Each material claim should bind
to its source excerpt, captured evidence, verifier result, and auditor decision.
This lets a comparator grade groundedness and contract coverage rather than
rewarding persuasive prose.

The comparison objective is lexicographic:

1. satisfy the quality and safety floor;
2. among the arms that satisfy it, minimize token pressure, latency, and
   billing impact according to the user's policy.

A quality-per-token ratio is not the objective; cheap failure must not beat an
expensive valid result.

## Judgment and self-preference

Blinding removes explicit model labels but not correlated style or vendor
self-preference. Comparison receipts therefore record judge–arm vendor and
family overlap. The initial protocol uses independent, structured,
dimension-by-dimension judgment, with a second vendor or human when the risk or
disagreement warrants it.

Tests and captured source evidence settle what they can. Model disagreement
that survives the bounded protocol goes to the human. Camus does not create an
unbounded judge-of-judges loop.

## Statistical honesty

- Three trials per arm are exploratory. They may reveal obvious failures or
  large differences; they do not establish a universal model ranking.
- Keep failed and interrupted arms as first-class records. Dropping them would
  create survivorship bias.
- Report paired differences, uncertainty, overlap, and the tested task domain.
- Do not promote a route until the local corpus has adequate coverage and
  confidence for that task class.
- Local calibration is a prior for the next run, never a marketing claim that
  one model is generally best.

## Artifact lineage and closure

Audit-only replay mints a new `receipt_id` over the same `artifact_id`. It is the
cheapest first comparison feature and the cleanest effort experiment: identical
work, different independent audit configuration.

Selecting an existing arm preserves that artifact's identity. Synthesizing
multiple arms creates a new artifact and therefore a new `artifact_id`; every
prior audit expires by construction. The synthesized result must pass fresh
deterministic verification and an independent closure audit before it can earn
standing.

## Adaptive stopping

Parallel comparison should not always spend its maximum budget. Stop an arm
when it cannot recover to the quality floor, when repeated trials no longer
change the decision, or when the expected value of another trial falls below
its cost. Any early stop must be evidence-backed and visible in the receipt.

## Outcome feedback

Audit quality is not the final outcome. With explicit user consent, Camus should
record whether a selected artifact was accepted, published, merged, corrected,
or later failed. This outcome ledger closes the learning loop and lets routing
optimize for work that survives reality, not work that merely wins model votes.

## Implementation order

0. Keep the Shane demo path stable and preserve its known-good replay.
1. Add the claim–evidence ledger and contract-coverage checks. **Complete
   locally 2026-07-14:** final-revision claim and deterministic contract
   ledgers, explicit auditor decisions, rehearsal guards, exact-artifact
   closure, and the v2 artifact/receipt identity split.
2. Extend the trust schema with experiment, usage, judge-overlap, failure, and
   artifact-lineage fields. **Complete locally 2026-07-14:**
   `experiment.v1` freezes the catalog/configuration before execution, hashes
   the manifest independently of its outcome, records requested/resolved/actual
   identity and effort semantics, retains failures, and binds source artifact
   and receipt lineage.
3. Ship audit-only replay over an unchanged artifact. **Complete locally
   2026-07-14:** Studio re-audits a validated research pack with no maker,
   retrieval, or fallback; preserves `artifact_id`; mints a new `receipt_id`;
   records usage/overlap; and keeps rehearsals non-evidence.
4. Add parallel arms with frozen knowledge and no silent fallback.
5. Add blinded, structured, dual-vendor comparison with human disagreement
   handling.
6. Build the local calibration view, retaining failed arms and uncertainty.
7. Recommend routes only after the task class has enough local evidence.
8. Add outcome feedback and adaptive stopping.

The implementation must preserve the existing trust law at every step:
allowed mutations, evidence at every handoff, crash-safe resume, exact state
binding, and untrusted agents around state-changing commands.

## Non-goals

- replacing native orchestration;
- a global leaderboard inferred from tiny or private samples;
- treating requested effort as a proven reasoning budget;
- uploading private Hivemind snapshots by default;
- hiding failed arms or silent model substitution;
- self-modifying prompts or routing without inspectable evidence; or
- removing the human decision boundary.
