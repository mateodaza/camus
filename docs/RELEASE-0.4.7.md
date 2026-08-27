# Camus 0.4.7 experimental admission and routing infrastructure

Camus 0.4.7 ships the machinery needed to measure, calibrate, and eventually admit external
reviewers without claiming that any external reviewer has earned production authority. Grok,
Qwen, and other configured OpenAI-compatible seats remain available for explicit shadow trials;
Codex remains the only production reviewer gate.

## What shipped

- A tracked 25-case corpus and resumable live campaign runner exercise the real Codex and
  OpenAI-compatible executors. Planning and status are spend-free, each paid attempt is bounded and
  durably sealed before the next starts, interrupted cells cannot be silently purchased twice, and
  no campaign command can admit its own candidate.
- Current `bench1:` receipts bind the frozen campaign and exact non-secret execution tuple. The
  report uses conservative intervals for validity, defect recall, false positives, containment,
  and transport equivalence; inadequate evidence refuses instead of rounding up to trust.
- A statistically eligible campaign can produce only an admission proposal. Production dispatch
  requires a reviewed, exact, expiring `admit1:` entry from the checked-in registry plus a private
  machine-bound activation for the current credential revision.
- External reviewer identity, qualification, transport, connection, and admission authority now
  survive native-driver and compatibility-workflow resume/start/await/abort paths. A verdict with
  substituted or missing authority fails closed.
- Studio has fresh calibration generations and an opt-in task-class router. A route needs complete
  per-class A/B evidence, deterministic quality floors, exact observed identities, two distinct
  human-calibrated judge screens, and currently qualified exact seats. The saved pairing remains
  the fallback whenever a gate is absent or stale.

## Deliberate release boundary

The tracked `reviewer-admissions.v1.json` registry contains zero entries. Automatic routing is off
by default and currently derives no active route. This release therefore makes no Grok admission,
model-ranking, or automatic-routing claim. The infrastructure is public so it can collect honest
evidence; it does not turn implementation or model agreement into authority.

The first frozen Grok 4.6 campaign has all 24 spend-free kill controls green. Four early quality
attempts were honestly retained as infrastructure outcomes. They exposed a synthetic-worktree
construction defect in the campaign harness; the production reviewer guard was not weakened. After
the harness adopted the real `camus/*` branch/path contract, one bounded Codex/Grok pair both
normalized and sealed successfully. The current ledger has 30 receipts and 414 quality cells still
pending, so it cannot support admission.

## Calibration finding

Twelve balanced 4/4/4 simple, balanced, and difficult artifacts were preserved as a separate
`expert_ai_proxy` rehearsal rather than represented as human labels. GPT-Sol reached 0.583 joint
agreement with those proxy labels and Opus 4.8 reached 0.417, both below the declared 0.80 floor.
That comparison is `refused_unscored`; it neither calibrates the judges nor activates routing. One
genuine human label remains one label, not a completed calibration set.

## Verification

- The provider-backed release smoke produced normalized, identity-bound Codex and Grok receipts
  after the synthetic-worktree correction, with zero infrastructure attempts in the pair.
- The full CLI/root and Loop Studio suites pass, including workflow, driver, campaign, admission,
  control-plane, routing, calibration, recovery, custody, and transport boundaries.
- The landing production build, npm package dry run, `git diff --check`, and credential-shape scan
  pass.

## Still pending

- The remaining 414 Grok campaign quality cells, any required transport-equivalence campaign, and
  an explicit decision to accept that spend.
- A proper human calibration workspace and at least 12 genuine blinded human labels, followed by
  two distinct registered judge screens meeting the agreement floor.
- A reviewed admission entry and private activation, but only if the complete evidence clears every
  declared bar.
- Any automatic task-class route. Camus will keep the saved pairing until sufficient A/B evidence
  exists and all route gates remain current.
- Deferred second-round Gemini/Kimi comparisons and Responses-protocol transport.
