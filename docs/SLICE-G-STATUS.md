# Open Model Seats — Slice G status

**Status:** formal campaign runner, human admission gate, and dormant workflow activation lane
released in 0.4.7; first Grok campaign frozen and bounded smoke proven end to end; no external
reviewer admitted

**Date:** 2026-08-27

Slice G now has the evidence ledger, statistical decision machinery, a publishable 25-case
synthetic corpus, and a resumable live runner. The runner calls the real Codex and configurable
HTTP review executors, counterbalances baseline/candidate order, and seals every attempted cell
before starting the next. `--max-cells` bounds spend and a restart schedules only missing cells.
It cannot admit its own candidate.

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
- The current v2 receipt schema binds the complete frozen campaign and exact non-secret execution
  tuple by digest. It accepts only bounded usage, decoding facts, and explicit mechanical control
  evidence; it rejects raw provider output, credentials, and broad diagnostic payloads. Shipped v1
  receipts remain readable, but v1 evidence cannot earn current admission.
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

## Live campaign state

The first campaign is frozen locally as `slice-g-grok-4-6-v1`: Grok 4.6 at medium effort versus
the pinned GPT-Sol baseline at high effort. Its corpus digest is
`corpus1:fa0a74f96dabe1e4ed138eff9a981caea818b1d28d5f97e1ee55d1f91399c67d`.
Planning made no provider call. The complete matrix contains 420 paid quality cells and 24
mechanical kill-path cells. On 2026-08-27, all 24 mechanical cells passed and were sealed as v2
receipts: three repetitions of abort, model-identity substitution, malformed output, and transport
interruption for both arms. After the stronger campaign/execution digest binding was added, the
zero-cost controls were regenerated; the earlier ledger remains locally preserved as
`receipts.pre-v2-binding.jsonl`. The command reported `providerCallsMade: 0`; the current ledger has
30 v2 receipts under one exact evidence envelope, 414 quality cells pending, no kill cells pending,
and no in-flight paid cell. Four early quality attempts sealed as infrastructure rather than
inventing verdicts. They exposed a harness defect: synthetic fixtures were ordinary repositories,
while both production reviewers correctly require coherent `camus/*` task worktrees. The harness
now materializes that production shape without weakening the guard, its regression passes, and a
bounded post-fix Codex/Grok pair both produced normalized sealed verdicts with zero infrastructure
attempts. Further campaign spend remains a separate human-owned decision, and judge calibration is
still below its admission bar.

The checked-in `reviewer-admissions.v1.json` registry is empty. A statistically eligible result
can only produce an admission proposal. Production dispatch requires a reviewed, content-addressed,
human-owned, expiring exact-tuple entry; a `trial1:` shadow can never satisfy it.
The entry also content-addresses the exact `qual1:` fingerprint. A network-free post-merge
activation writes its private machine-HMAC authority with the exact `admit1:` id and an opaque
credential revision, so admission substitution or credential rotation refuses before network use
until explicitly reactivated.

The compatibility workflows now carry that exact external reviewer route from `camus-feat`
resume state through `camus-loop` start, await, and abort. A returned verdict is accepted only when
its binding includes the dispatcher-issued `admit1:` authority, and terminal results preserve that
exact admission id. Private endpoint, tunnel, and credential material remains host-side. Because
the registry is empty, this is a dormant fail-closed activation path—not an admission by code.
The preferred native `camus run` driver carries the same exact route, manages direct/loopback/SSH
endpoint custody from the private Studio profile, and requires the same admission authority in its
durable review receipt. Route-mode CLI experiments may name an external gate only with that full
admission tuple; observations must match its qualification/transport/connection and carry an
`admit1:` id before they can become routing evidence.

Studio's routing campaign is now v6. Automatic task-class routing is opt-in and falls back to the
saved pairing unless all of these hold for one exact generation/class: ten trials per pairing,
all registered cases represented, every quality floor green, exact requested and observed
identities, two human-calibrated judge screens resolving to distinct actual model identities, and
currently qualified exact seats. Each `route1:` binds the exact campaign hash, source run IDs,
qualification fingerprints, and calibration evidence digest. At present it correctly says
`human_calibration_incomplete`; no route has been activated.

The first v6 calibration rehearsal also exposed an operator-experience gap. Twelve fresh blinded
artifacts were generated with exact 4/4/4 simple, balanced, and difficult coverage. Mateo supplied
one genuine human label; a separate generation preserved twelve Codex judgments as
`expert_ai_proxy` rather than laundering them into human evidence. Both registered screens ran all
twelve proxy artifacts with stable identities and no infrastructure failures, but neither met the
0.80 joint-agreement bar (GPT-Sol 0.583; Opus 4.8 0.417). The comparison therefore remains
`refused_unscored` and cannot authorize admission.

### Calibration workspace follow-up

Before asking operators for another formal twelve-label pass, Studio should provide a dedicated
blinded calibration workspace: one artifact at a time, a pinned contract checklist, keyboard and
batch navigation, autosave/resume, progress and estimated remaining effort, disagreement review,
and a continuously visible `human` versus `expert_ai_proxy` authority indicator. It may use code
graders to precompute mechanical checklist facts, but it must not let a judge preselect the human
verdict or silently convert proxy work into human evidence. This is a velocity/quality feature, not
a relaxation of the admission gate.

## Still required before admission

- Review/approve the tracked synthetic corpus and the 420-call first-campaign budget.
- Run the current Codex baseline and Grok candidate through the real dispatcher and normalizer in
  bounded cells.
- Re-run the mechanical controls after any relevant watchdog, identity, normalizer, or transport-
  custody change; the current campaign's required 24 controls are green.
- Collect a fresh v6 blinded set, have Mateo label at least 12 artifacts, then run the registered
  judges. Existing expert-AI proxy labels remain honestly non-human and cannot be upgraded in place.
- Submit any statistically eligible candidate plus that human calibration to explicit reviewed
  admission. Until then, production routing remains Claude → Codex and every other CLI reviewer
  stays benchmark-disabled.
