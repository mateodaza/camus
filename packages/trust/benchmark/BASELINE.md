# Auditor baseline — first cut

Computed 2026-07-13 over 59 records / 70 findings.
Rates use the adjudicated subset only; unresolved findings are counted, never guessed.

## Corpus
- records: 59 (historical: 59)
- clean-verdict rounds (auditor said "patch is correct"): 19
- findings: 70 — by priority: P0: 2, P1: 49, P2: 19

## Adjudication coverage
- adjudicated: 32/70 (45.7%)
- unresolved (awaiting human/evidence): 38 (54.3%)

## Rates over the adjudicated subset
- confirmation rate: 29/32 (90.6%)
- rejection rate: 1/32 (3.1%)
- partially correct: 2/32 (6.3%)
- severity accuracy (confirmed, graded): 29/29 exact (100.0%), mean shift 0.00
- deterministic reproducibility (confirmed, assessed): 21/23 (91.3%)

## Confirmed findings by priority
- P0: 2
- P1: 19
- P2: 8

## Honest caveats
- Temporal rule (frozen): findings are judged against the exact artifact state that was audited — a later repair proves action, not the reviewer's mechanism.
- The adjudicated subset is evidence-selected (documented memory + repository archaeology), so the confirmation rate is biased toward findings that left traces — it is a floor of provenance, not an unbiased estimate. No marketing claims and no routing decisions from these numbers until representative adjudication plus known-clean and seeded controls exist.
- Historical rounds carry survivorship bias by construction; clean controls, seeded defects, and same-vendor baselines are still to be added as separate source-typed records.
- All records currently share one pairing (anthropic executor / openai auditor, models unrecorded in the era's receipts) — no cross-pairing comparison is possible yet.

