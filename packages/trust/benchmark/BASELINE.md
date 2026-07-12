# Auditor baseline — first cut

Computed 2026-07-12 over 59 records / 70 findings.
Rates use the adjudicated subset only; unresolved findings are counted, never guessed.

## Corpus
- records: 59 (historical: 59)
- clean-verdict rounds (auditor said "patch is correct"): 19
- findings: 70 — by priority: P0: 2, P1: 49, P2: 19

## Adjudication coverage
- adjudicated: 11/70 (15.7%)
- unresolved (awaiting human/evidence): 59 (84.3%)

## Rates over the adjudicated subset
- confirmation rate: 10/11 (90.9%)
- rejection rate: 1/11 (9.1%)
- partially correct: 0/11 (0.0%)
- severity accuracy (confirmed, graded): 10/10 exact (100.0%), mean shift 0.00
- deterministic reproducibility (confirmed, assessed): 2/4 (50.0%)

## Confirmed findings by priority
- P0: 2
- P1: 7
- P2: 1

## Honest caveats
- The adjudicated subset is evidence-selected (documented memory + repository archaeology), so the confirmation rate is biased toward findings that left traces — it is a floor of provenance, not an unbiased estimate.
- Historical rounds carry survivorship bias by construction; clean controls, seeded defects, and same-vendor baselines are still to be added as separate source-typed records.
- All records currently share one pairing (anthropic executor / openai auditor, models unrecorded in the era's receipts) — no cross-pairing comparison is possible yet.

