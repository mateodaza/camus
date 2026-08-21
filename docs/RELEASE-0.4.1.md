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
- `camus eval` reads an append-only local episode ledger. `--experiment` performs persistent,
  quality-gated sequential A/B assignment of complete model pairings for a declared task class.
- Legacy `/camus-feat` and `/camus-loop` stay installed as rollback surfaces for this candidate.

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
