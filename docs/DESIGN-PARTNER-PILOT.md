# Camus design-partner pilot

Camus is a public alpha. The pilot asks one narrow question: **can the product
help someone reach a useful, human-accepted result with stronger evidence and
less avoidable supervision than their current workflow?**

The pilot is not an admission campaign, a universal model ranking, or permission
to turn on automatic routing. One run can show what happened in that run. Only
repeated, matched evidence can support broader reliability or comparative claims.

## Bring one bounded task

Choose real work in one of three task classes:

- **Simple:** a local, clearly specified change with a fast deterministic check.
- **Balanced:** a multi-file or research task with a bounded corpus and explicit
  acceptance contract.
- **Difficult:** broad or high-stakes work that should first be decomposed and
  given explicit review, cost, and recovery boundaries.

Before any provider spend, freeze the Camus version and commit, task class,
acceptance contract, allowed knowledge and tools, exact maker/reviewer/provider/
harness tuple, verifier, budgets, and expected human checkpoints. Do not silently
substitute a model or extend a stopped run.

## What the partner provides

The public [pilot request](https://github.com/mateodaza/camus/issues/new?template=design-partner.yml)
asks only for the task, acceptance conditions, setup, learning goal, and hard
boundaries. It does not ask for a name, company, email, budget, private source,
or raw run artifact. GitHub already provides a reply channel.

Private task material stays in the operator-selected local workflow. Never paste
credentials, private source, raw diagnostics, local paths, or an unreviewed
receipt into a public issue.

## Session scorecard

Camus and the maintainer should derive mechanical facts from the authenticated
run rather than asking the partner to reconstruct them.

| Area | Record |
| --- | --- |
| Frozen context | Version/commit, task class, exact seats and executors, surface, contract, verifier, limits, expected checkpoints |
| Outcome | Terminal status, candidate produced, containment, verification and binding, review and binding, independence standing |
| Loop behavior | Calls, actions, repairs, retries, recovery events, active and paused time, model/verifier/reviewer time |
| Usage | Reported tokens and cost only where coverage is known; missing billing remains `unknown`, never zero |
| Human judgment | Accepted, accepted after human edits, rejected, or pending; legitimate checkpoints; avoidable interruptions; operator rescue |
| Value | Biggest useful moment, biggest friction, and voluntary yes/maybe/no repeat intent |

Every value is marked `observed`, `human_labeled`, or `unknown`. Failures, safe
halts, and assisted attempts remain in the cohort; they are never removed to
improve the result.

## Cohort evidence

Across the first design partners, report:

- activation: partners who reach one valid run;
- human-accepted outcome rate, retaining every failure and safe halt;
- autonomous accepted-outcome rate, excluding operator rescue;
- avoidable-interruption and operator-rescue rates;
- median active time by task class, with paused time separate;
- repairs and retries per attempt; and
- token/cost medians only alongside their coverage percentage.

No hidden telemetry is required. A public summary is voluntary, redacted, and
aggregate. It excludes source, diffs, prompts, raw diagnostics, local paths,
credentials, and raw receipts.

The first useful go-to-market evidence is not a flattering quote. It is a small,
complete cohort showing where Camus produced accepted work, where it stopped
safely, how often a human was truly needed, and whether partners chose to use it
again.
