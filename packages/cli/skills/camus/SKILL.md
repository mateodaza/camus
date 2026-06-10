---
name: camus
description: Run the Camus closed-loop on one task — discovery, plan, implement, then loop fix↔Codex-review until no P0/P1/P2 findings remain, then verify with type-check + tests. Manual-invoke only via /camus.
disable-model-invocation: true
---

# Camus — closed-loop task runner (v2-lite)

This skill is the **playbook**, not the engine. The engine is the pair of dynamic
workflows (`camus-loop` for one task, `camus-feat` for an ordered task list) installed
alongside it; this file holds the *standard that keeps it honest*.

See `CAMUS-SPEC.md` at the repo root for the full design and run-targets.
**Install:** run `./install.sh` from the `camus/` staging dir (copies skill + workflows
into `~/.claude`; `--check` detects source↔installed drift — run it before any auto/feat run).

## What this does

Given one task, run a bounded closed loop:

```
discovery → plan → implement → [ Codex review → fix ]*  → verify
                                  ↑ loop while priority<=2 findings, up to ROUND_CAP
```

- **Implementation** is done by Claude (cheap model for bulk work).
- **Review** is done by **Codex** (a different vendor) — this is deliberate, to
  sidestep self-preferential bias. Claude must NOT re-judge Codex's verdict.
- **Verification** is deterministic and **stack-agnostic**: `verify.sh` auto-detects the
  repo's build/test commands (node/python/rust/go/foundry/make) with zero per-project
  config, or honours `CAMUS_VERIFY_CMD` as an explicit override. If nothing is detected it
  fails loud (`no_verifier_detected`) — absence of a verifier is never a pass.

## Severity model (the gate)

Codex returns findings tagged `priority` 0–3. The loop blocks on **priority ≤ 2**.

| Priority | Meaning | Blocks the loop? |
|---|---|---|
| **P0** | Critical: breaks build/tests, data loss, security hole, wrong core logic, regression | Yes |
| **P1** | High: likely bug, missing error handling, broken contract, untested critical path | Yes |
| **P2** | Medium: correctness/maintainability risk, unhandled edge case, logic that will bite | Yes |
| **P3** | Nit: style, naming, cosmetic | No (recorded, never loops) |

**Exit conditions** (whichever comes first):
1. No findings with priority ≤ 2 → loop is clean → proceed to verify.
2. `rounds == ROUND_CAP` → stop, surface remaining P2s to the human. Never loop on a P3.

Defaults: `ROUND_CAP = 3`.

## Hard rules

1. **Bound everything.** Round cap on review/fix; soft token target per task; rely on the
   runtime's enforced 16-concurrent / 1,000-total agent caps as the outer backstop.
   (The `"use Nk tokens"` budget is model-respected, not a runtime kill-switch — do not
   trust it as the guarantee.)
2. **Infra failure ≠ findings.** If Codex fails to run (nonzero exit, empty/unparseable
   output, rate-limit, auth blip), that is `ran:false` — retry with backoff, and NEVER
   feed it into the fix loop as if it were a rejection, and NEVER treat it as clean.
   This is the #1 cause of runaway loops. The adapter enforces this; do not bypass it.
3. **Fresh reviewer each round.** Spawn a new Codex session per review (not `resume`) so it
   re-raises issues it might otherwise decline to repeat.
4. **Thin reviewer.** The reviewer's only job is to run Codex and return JSON. No Claude
   re-judgement of the verdict.
5. **Deterministic ground truth wins.** A clean Codex verdict does not ship code that fails
   `type-check`/`test`. Verification is the final, non-negotiable gate.
6. **Execution model.** The workflow script never runs shell/files. Reviewer and verifier
   *agents* run the commands (`scripts/codex_review.sh`, `scripts/verify.sh`) and return
   strict JSON; the script only evaluates the JSON and branches.

## How the pieces fit

- `review-prompt.md` — the cross-vendor audit persona + severity rubric handed to Codex.
- `sev.schema.json` — the Codex `--output-schema` (findings[] with priority 0–3 + verdict).
- `scripts/codex_review.sh` — reviewer agent runs this → normalized gate JSON.
- `scripts/verify.sh` — verifier agent runs this → `{pass, failures}` JSON.
- `scripts/adapter.py` — normalizes Codex output, enforces the infra guard, maps to/from
  v1's `APPROVED/REJECTED` contract. Pure stdlib; unit-tested in `scripts/test_adapter.py`.

## Run surface

- `/camus-loop <task>` — one task. Args: a string, or `{task, targetPath, model, modelTier,
  skipPlan, policy, humanAnswer, branchPrefix, idSalt}`.
- `/camus-feat` — an ordered task list as one feature: preflight → feat branch → env +
  baseline verify → per-task loop (merge on `done`) → env re-check + integration verify →
  report at `~/.camus/reports/<featId>.json`. Forwards `policy`/`model`/`modelTier`/`skipPlan`/`answers`.

## Shipped hardening (all live, all tested)

- **Target guard** (`_guard.sh`): every gate script binds to the caller's repo, `camus/*`
  branches, and `camus-wt-*` worktrees — fail-closed, 3 Codex review rounds, probe-verified.
- **Auto mode, zero-click**: `install.sh --auto-setup` installs a narrow scoped profile
  (egress trust for the Codex review + allow rules for the 5 gate scripts only). Proven
  live: full feat runs with zero permission prompts.
- **HITL policy dial**: `policy: autonomous | ask_on_ambiguity (default) | ask_on_major`.
  Plan phase rates clarity; `needs_human` halts the feat with a question; resume re-runs
  with the answer. Always-on **decisions log** lands in the report.
- **Model control**: classifier sets the floor (trivial→Sonnet, else Opus); `model`/`modelTier`
  args force it; reviewer-persistence escalation bumps the fix model on round ≥ 2 or a P0.
  `skipPlan` is opt-in and only effective under `autonomous` (never silently disables the ask-gate).
- **Codex audit trail**: every review round persists raw+parsed Codex output to
  `~/.camus/reviews/<wt>-r<round>.json` — a missing file means the binary never ran.
- **Auto-resume**: `resume_scan.py` finds interrupted (`running`, idle ≥ 30 min) feats and
  emits canonical `resumeArgs` verbatim.
- **Worktree dep-prep** (`prep.sh`): fresh worktrees install deps before verify; a toolchain
  that can't run returns `verify_inconclusive`, never `verify_failed`.

Target-B (VPS interactive) tooling remains **gated on G3** (subscription-auth-on-server ToS).
