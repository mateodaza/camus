# Camus 0.4.1 candidate

Camus 0.4.1 turns the 0.4.0 kernel from a set of safe primitives into the default executable
architecture. It is not released yet; the next dogfood must validate this path before tag or npm
publication.

## What changes

- `camus start <spec.json>` initializes a feature with code, not an orchestration model.
- `camus run <featId>` uses durable Claude Code background sessions as makers in kernel-owned
  worktrees, adopts them after interruption, invokes independent review directly, and keeps every
  Git/verify/merge transition deterministic.
- The controller model appears only for semantic closure choices. Mechanical retries and state
  relays no longer consume model context.
- Background receipts prove session/model/transcript identity and available usage without copying
  prompts, diffs, transcript prose, credentials, or environment dumps into run state.
- `camus eval` reads an append-only local episode ledger and reports per-arm evidence by exact
  experiment generation and task class. `camus run --experiment` performs persistent,
  quality-gated sequential A/B assignment of complete model pairings for that declared task class.
- Legacy `/camus-feat` and `/camus-loop` stay installed as rollback surfaces for this candidate.

## Reading eval and A/B evidence

`camus eval` without a config is deliberately exploratory: it shows the exact observed segments
but cannot recover a generation's configured `qualityFloor` or `minimumTrials`, so it names no
leader. Supply the frozen config with `camus eval --config experiment.json`; repeat `--config` to
inspect several generations. `camus eval --experiment <id>` filters the report by experiment ID.

The text and `--json` forms use the same fail-closed ladder. `coverage_incomplete` includes every
configured arm, even arms at zero trials. `no_arm_clears_quality_floor` blocks promotion after
coverage. `exploratory_leader` is quality-first evidence but cannot route. Only `routing_leader`
sets `routingEligible:true`, and only for its exact `(id, configHash, taskClass)` segment.
`routingConfigured:true` says the frozen config requested route mode; it is not by itself route
eligibility. Mixed config hashes are reported as `mixed_generations` and never aggregated.
Top-level `segmented_only` likewise names no winner: consumers must inspect `segments[]`.
`episodes` is the ledger-row count in scope; `experimentEpisodes` is the subset with experiment
evidence.

Each arm also exposes native orchestration overhead. `medianModelWallMs` is the median measured
background maker/controller time, and `medianOrchestrationOverheadMs` is the median of each
episode's `max(0, wallMs - modelWallMs)` — the observed orchestration gap around that background
model work. The gap includes independent-review time as well as deterministic host control; it is
not a claim that every millisecond was kernel CPU time. An episode contributes to these medians only
when it carries both `wallMs` and `modelWallMs` and, when native coverage is declared, complete
background-session timing. An episode missing either side or declaring incomplete measurement is
counted in neither (never imputed as zero overhead), and impossible raw evidence where
`modelWallMs > wallMs` floors at zero instead of
reporting a negative overhead. Both fields are `null` when no episode supplies the required pair, so
absent timing evidence is never dressed up as measured coverage. The text report renders them as
`model=` and `overhead=`. They are reported evidence only: arm ranking stays quality-first, then
`medianWallMs`, then `medianOutputTokens`, and overhead never reorders arms.

## Release gate

Before release, run one fresh multi-task dogfood through `camus start` + `camus run` using Opus 4.8
as maker and Sol as reviewer. Interrupt and resume at least one background maker. Require:

1. no model call before the selected maker starts;
2. no duplicate maker after restart;
3. direct independent review and HEAD-bound verification for every landed task;
4. one eval episode per task with the requested/observed pairing and honest metric coverage;
5. at least 50% lower orchestration overhead than the last workflow-driven dogfood;
6. no push, publication, deployment, or main merge by the driver; and
7. full CLI/root/Studio tests and `git diff --check` green.

The current operator shell exposes `ANTHROPIC_API_KEY`, while Claude reports logged out when that
variable is absent. That is not acceptable evidence of subscription/account routing. Before the
dogfood, authenticate the CLI with the ambient API key removed and verify that
`claude auth status --json` still reports `loggedIn:true` and `authMethod:"claude.ai"`. The driver
performs the same scrub and proof itself and refuses to launch otherwise.

The A/B selector may report exploratory local evidence. It must not name a universal winner, call
an uncalibrated judge calibrated, or choose a faster arm that has not cleared the quality floor.

Native spend admission reserves `max(10,000, 25% of budgetTokens)` direct-output tokens before each
maker or fix launch. `camus run --direct-output-reserve 0` explicitly disables that admission
reserve. Claude background sessions do not expose a per-turn output cap, so an in-flight turn may
still overshoot; the post-receipt direct-output ceiling prevents subsequent model calls and records
the exact measured overage.
