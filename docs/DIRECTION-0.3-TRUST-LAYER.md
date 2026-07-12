# 0.3 Direction — the trust layer (adopted 2026-07-12)

Decision: Camus 0.3 is not a better multi-agent orchestrator. Vendors are
commoditizing orchestration monthly; the durable product is the
provider-neutral trust layer that sits above their agents.

**Camus surrenders choreography, not custody.** Vendor systems may own agent
delegation, thread trees, and team UIs. Camus keeps the artifact, the state
transition, the verification, the audit invitation, the merge/publication
decision, and the receipt. Without custody, "verified" rests on a vendor's
self-reported state — which is the thing this product exists to refuse.

The moat, one sentence:

> Camus owns custody, evidence, calibration, and the decision boundary.
> Claude and GPT may own the workers.

Positioning line:

> Camus does not provide more agents. It provides an independent,
> evidence-bound answer to whether those agents' work should be trusted.

This document reroutes the *emphasis* of [ROADMAP-0.3.md](ROADMAP-0.3.md).
The trust machinery listed there survives intact (reviewer backend
abstraction, hard cross-vendor invariant, benchmark gate, canary, crash and
resume semantics, honest statuses, bounded loops, deterministic verification,
human decisions on P0). `bookend`/`forward` become audit-timing policies, not
the headline. Automatic routing waits for calibration data.

## Why (evidence, not vibes)

- The studio's first live gate ignition was misread because the reader parsed
  the executor's persuasive prose instead of a structured artifact — the
  sealed evidence pack is the generalized fix (fixed narrowly at 0bb392f).
- The studio audit found a citation false-green (an unrelated URL vouching
  for `[1]`) — the claims ledger is the generalized fix (fixed narrowly at
  179e0be).
- Self-preference research (arXiv:2604.22891): stronger models are not
  necessarily fairer judges; structured dimension-by-dimension judging cut
  measured self-preference ~31.5%. Independence must be *measured*, so the
  benchmark includes same-vendor baselines in both directions.
- Automated review recall is 20–32% per system (~40% union, arXiv:2603.23448):
  an independent auditor is a filter with a measured recall, never a
  guarantee. Marketing language stays calibrated; deterministic checks and
  sources arbitrate wherever possible.
- Spec-anchored auditing (arXiv:2604.26495): as models improve, audit quality
  bottlenecks on the acceptance properties they are asked to verify — the
  evidence pack carries the acceptance contract, not just the diff.

## Adjustment 1 — status is orthogonal dimensions, not one enum

Store dimensions; derive the headline. A flat enum flattens contradictions
("published but unverified") into lies.

```
execution:    pending | running | completed | interrupted | failed
verification: not_run | passed | passed_with_caveats | failed | infra_failed
audit:        not_run | independent_clean | independent_findings
              | advisory_clean | advisory_findings | infra_failed
publication:  not_published | published
```

Derived user-facing headlines:

```
verified
verified_with_findings
same_vendor_reviewed
unverified
needs_decision
published
```

Same-vendor pairing is only ever an explicitly labeled advisory mode; it
never earns the status of an independent audit.

## Adjustment 2 — schema before corpus, then curate immediately

The ~/.camus/reviews corpus (~25 real audited rounds) is the seed of the
calibration moat and it is aging. Curate it now — but after a short schema
spike, so the records don't need rework.

Each benchmark record:

- executor and auditor provider/model
- exact artifact or commit hash
- original findings
- human adjudication: confirmed | rejected | partially_correct | unresolved
- severity before and after adjudication
- whether a deterministic check could reproduce it
- repair outcome
- tokens, runtime, billing mode, estimated cost
- sensitive-data classification
- clean cases with no intended defect, where applicable

Curation rules: do NOT copy `~/.camus/reviews` wholesale — it may contain
proprietary code, secrets, user paths, personal research. The curation tool
redacts by default; raw diffs require explicit inclusion.

The 25 real rounds are a seed, not the benchmark. Add: known-clean artifacts
(false-positive rate), seeded P0/P1/P2 defects (recall by severity),
citation-mapping failures, infrastructure and malformed-receipt cases,
similar findings expressed differently, and same-vendor baselines in both
directions. Historical findings alone carry survivorship bias — they only
represent what the previous auditor already noticed.

## Adjustment 3 — custody generalizes beyond git

For code, custody is worktree, commit, HEAD binding, tests, controlled merge.
For research there may be no repository; the same abstraction is

```
artifact_id = hash(normalized evidence bundle)
```

The bundle: answer, claims ledger, sources, captured evidence, human
decisions, verifier results. Any modification creates a new artifact_id and
expires the prior audit. One architecture for both audiences:

```
Executor → sealed artifact → deterministic checks
         → independent audit → adjudication → publication receipt
```

The evidence pack includes the **human decisions ledger** (answers with their
kinds — a verdict without the calls a human made is missing provenance) and
the **economics** (below). The auditor receives the artifact in a clean,
read-only context — never the executor's self-summary. A green verdict binds
to the artifact hash.

## Adjustment 4 — record economics honestly

Per role, record: requested, resolved, and actually used model; effort level
and fallback; input/output/cache usage where available; billing mode
(subscription | usage_credits | api); estimated marginal cost, clearly marked
estimated. Do not invent precise dollars for subscription-backed runs — real
marginal cost may be zero while consuming rate limits or weekly credits.
Calibration compares quality, latency, token pressure, and billing impact,
not only dollars.

## Pairing manifest (exists early, even with one production pairing)

```json
{
  "executor": {
    "requested": "anthropic:balanced",
    "resolved": "anthropic:sonnet",
    "actual": "anthropic:sonnet"
  },
  "auditor": {
    "requested": "openai:balanced",
    "resolved": "openai:gpt-5.6-terra",
    "actual": "openai:gpt-5.6-terra"
  },
  "independence": "cross_vendor"
}
```

Capability profiles resolve aliases; no hardcoded model enums. Presets for
humans: Independent (recommended) · Reverse independent · Fast · Frontier ·
Custom. The auditor choice is the trust decision and leads the UI; the
executor choice is mostly cost/quality. Persist per workspace; both
identities always appear on the receipt. Candidate routine auditor:
gpt-5.6-terra, proven through shadow mode first — never pre-committed.

## The challenge protocol (bounded, no judge-of-judges)

1. Executor produces the artifact.
2. Deterministic sensors run.
3. Independent auditor produces structured findings (claim, priority, exact
   evidence location, violated acceptance property, impact, reproduction or
   falsification procedure, confidence).
4. Executor may rebut or repair with evidence.
5. A fresh, focused audit checks the disputed or changed area.
6. After the cap, disagreement goes to the human.

Tests, source evidence, and the human settle what models dispute. Multi-
auditor panels are exceptional (security, P0 history, high risk), never the
default.

## Adjudication rules (frozen 2026-07-12)

> Judge the finding against the exact artifact that was audited, using
> evidence available from that state or its history — not current HEAD.

A later repair confirms that maintainers acted on something; it does not
alone prove the reviewer's original mechanism, location, or severity. Truth,
severity, reproducibility, and repair are separate judgments.

- `confirmed` — the claimed defect existed materially as described.
- `partially_correct` — a real issue existed, but mechanism, scope, location,
  or severity was materially wrong.
- `rejected` — the audited artifact contradicts the finding.
- `unresolved` — evidence is insufficient. Unresolved is a strength.

Clean-verdict rounds are auditor outputs, never known-clean controls. The
baseline is an evidence-selected provenance floor: no marketing and no
routing decisions from it until representative adjudication plus known-clean
and seeded controls exist.

## Implementation order (revised, adopted)

0. ~~Studio pre-launch audit closure~~ — done at 179e0be.
1. Minimal benchmark and evidence-pack schemas.
2. Orthogonal status model, with migration from existing receipts.
3. Curate the aging review corpus immediately (schema-first, redacting).
4. Seal the existing Claude-executor → GPT-auditor path.
5. Surface the exact receipt and derived status in Studio.
6. Shadow audits, including same-vendor baselines (codex ≥0.144 makes the
   5.6 profiles reachable).
7. Pairing manifest + user presets.
8. GPT executor → Claude auditor (new plumbing, not a config inversion —
   the Studio Build lane's ignite-and-watch-receipts pattern is the
   prototype for executor-as-black-box).
9. Automated routing only after the scoreboard has enough evidence.

VELOCITY-DIRECTION's status semantics ship before any model picker.
"3.0" is the strategic label; the release stays semver 0.3.0.
