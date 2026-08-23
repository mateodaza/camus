---
name: camus
description: Run the Camus closed-loop on one task — discovery, plan, implement, then loop fix↔Codex-review until no P0/P1/P2 findings remain, then verify with type-check + tests. Manual-invoke only via /camus.
disable-model-invocation: true
---

# Camus — closed-loop task runner

This skill is the **playbook**, not the engine. The engine is the pair of dynamic
workflows (`camus-loop` for one task, `camus-feat` for an ordered task list) installed
alongside it; this file holds the *standard that keeps it honest*.

See `CAMUS-SPEC.md` at the repo root for the full design and run-targets.
**Install:** `npx camus-cli install` (from a repo checkout: `./install.sh` in `packages/cli/`) —
copies skill + workflows into `~/.claude`; `npx camus-cli check` detects source↔installed
drift — run it before any auto/feat run.

## What this does

Given one task, run a bounded closed loop:

```
discovery → plan → implement → [ Codex review → fix ]*  → verify
                                  ↑ loop while priority<=2 findings, up to ROUND_CAP
```

- **Implementation** is done by Claude (cheap model for bulk work).
- **Review** is done by **Codex** (a competitor) — this is deliberate, to
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

## review_unresolved is a decision, not always a failure (2026-06-11)

When review doesn't converge, the loop **consults deterministic verify before reporting** so the
human sees both independent axes. A green suite is necessary evidence, but it does not clear an
unresolved finding or prove untested contract behavior. Two behaviors:
- **Verify is run on a non-converged review.** A `review_unresolved` carries `verifyClean`:
  `true` (type-check/lint/tests pass → a DECISION POINT: accept the worktree as-is, or refine),
  `false` (genuinely not done), or `null` (verify couldn't run). camus-feat surfaces a verify-clean
  halt as a decision, never a plain failure.
- **A finding re-raised after a fix STOPS the loop early.** Same `code_location + title` in two
  consecutive rounds (a fix was dispatched between) → stop and surface it (`stuck`) for a human to
  resolve *stale-re-flag vs real disagreement*, instead of burning the rest of `roundCap`.
- **Confidence trend disambiguates accept-vs-refine.** Each finding's `confidence_score` is tracked
  across rounds; a re-raised finding whose confidence FALLS (the reviewer losing conviction) → most
  likely a stale re-flag → the halt leans ACCEPT; steady/rising → a consistent disagreement → leans
  REFINE. Guidance only — never a hard auto-pass gate (a real P1 was observed starting at 0.82 and
  rising to 0.92, so an absolute confidence cut would misfire).
- **ACCEPT executes via land mode** (run-5 fix: the loop's weakest link was landing code it had
  already proven — resume re-entered plan→implement→review and a flaky review infra_errored before
  ever committing an already-clean staged diff). Re-run the feat with `land: ["<taskId>"]` (or the
  loop with `land: true`): it resolves the EXISTING worktree and goes straight to
  commit → prep → verify → merge. No re-plan/re-implement/re-review; deterministic verify remains
  the unskippable arbiter (verify red under land → `verify_failed`, never a silent ship). An
  already-committed worktree (empty stage) proceeds to verify rather than failing.
  REFINE = re-run normally with `answers:{<taskId>:"…"}`.
- **The commit→merge death window auto-recovers** (audit P2): the feat persists `ready_to_merge`
  the moment the loop returns done (review clean + committed + verify green) and BEFORE the merge
  runs. A resume that finds a task in `ready_to_merge` AUTO-lands it — no `land` list needed —
  because the work is fully proven and only the merge was missing; re-running the full loop there
  would re-enter review for nothing and collide on the existing branch/worktree. The post-merge
  half of the window is covered too: if the crash hit AFTER the merge landed (before `done`
  persisted), the resume's re-merge reports already-up-to-date and the merge runner checks feat
  history for this task's deterministic merge-commit message — evidence found → recorded DONE;
  check ran and found nothing (explicit null/empty) → the original no-op guard stands (an empty
  branch never upgrades itself). An INCOMPLETE or SELF-CONTRADICTORY merge report — verdict
  fields (`committed`/`alreadyUpToDate`) omitted, before/after SHAs missing (required non-null
  on a successful merge), flags contradicting HEAD movement (the SHAs are ground truth), or the
  evidence check omitted — fails loud (`feat_integration_failed`, task stays `ready_to_merge`
  for an idempotent merge retry): missing or contradictory evidence is an infra condition,
  never a verdict (noop or done).
- **Land is authorized by prior state, not by the request** (audit P1): the feat forwards
  `land` ONLY for a task whose persisted prior status is `needs_decision` — proof that review ran
  and deterministic verify was green. An unproven land request downgrades LOUDLY to the full loop
  (a worktree from a run killed pre-review must never skip codex review just because verify
  passes). Standalone `camus-loop {land:true}` is the deliberate manual override — the human
  invoking it directly takes the reviewer's place. `land` is part of the canonical `resumeArgs`
  (dropping it on a resume would re-enter the full loop — the exact failure land exists to avoid).

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

- `review-prompt.md` — the adversarial audit persona + severity rubric handed to Codex.
- `REVIEW-CONTRACT.md` — the versioned (rc1) agreement for what a review carries: contract
  version, scope (full/light), reviewer qualification (builtin1/qual1), and
  origin/operator/transport/connection provenance. `asGate` compares every field against
  workflow-computed expectations and refuses drift; terminal provenance comes only from an
  accepted binding. The hardened `builtin1` tier also excludes user/project/system/managed
  configuration and custom model catalogs; managed hosts fail closed unless the run explicitly
  requests a configurable (`qual1`) reviewer.
- `sev.schema.json` — the Codex `--output-schema` (findings[] with priority 0–3 + verdict).
- `scripts/codex_review.sh` — reviewer agent runs this → normalized gate JSON.
- `scripts/verify.sh` — verifier agent runs this → `{pass, failures}` JSON.
- `scripts/adapter.py` — normalizes Codex output, enforces the infra guard, maps to/from
  v1's `APPROVED/REJECTED` contract. Pure stdlib; unit-tested in `scripts/test_adapter.py`.

## Run surface

- `/camus-plan <request>` — OPTIONAL pre-step. Reframes a raw/vague/large request into a
  quality-gated camus-feat task list: ground (explore the repo read-only) → clarify (ask on a
  genuine ambiguity) → architect → decompose to camus standards → adversarially critique →
  emit. Writes `~/.camus/plans/<id>.json` (the exact camus-feat args) + a readable `.md`; never
  writes code. Args: `{request, targetPath?, policy?, model?, modelTier?, answers?}`. Same ask
  posture as the feat (`policy`; resume with `answers:{<id>:"…"}`). Use it to get smaller,
  clearer tasks BEFORE running — better plans converge in fewer review rounds.
- `/camus-loop <task>` — one task. Args: a string, or `{task, targetPath, model, modelTier,
  skipPlan, policy, humanAnswer, branchPrefix, idSalt, identitySalt, roundCap, land}`. `idSalt`
  means feat ownership (feat heartbeat + parent-tree containment). `identitySalt` is the mutually
  exclusive standalone-custody seam used by Studio: deterministic branch/worktree + heartbeat,
  idempotent replay of that exact worktree, and no feat-only containment precondition. `roundCap` (1..10, default 3)
  raises/lowers the review↔fix budget for a known-large task (run feedback 2026-06-10: a big task
  that converges P1→P2 can run out of rounds at the default cap). `land: true` = land mode (run-5
  fix): commit the task's EXISTING, already-proven worktree → verify → done, skipping
  plan/implement/review entirely. STANDALONE-loop land is the manual override (the human invoking
  it takes the reviewer's place). Under a feat, land is state-authorized instead: explicit
  `land: ["<taskId>", …]` executes an ACCEPT on a `needs_decision` halt, and a task persisted as
  `ready_to_merge` (died between commit and merge) AUTO-lands on resume with no land list at all.
- `/camus-feat` — an ordered task list as one feature: preflight → feat branch → env +
  baseline verify → per-task loop (merge on `done`) → env re-check + integration verify →
  report at `~/.camus/reports/<featId>.json`. Forwards `policy`/`model`/`modelTier`/`skipPlan`/`roundCap`/`answers`.
- `camus status [featId]` — one-shot dashboard for a run, from ANY terminal, read-only and
  token-free: feat header, per-task board (rounds/tokens/model), the last 10 run-log steps,
  recent Codex review rounds (audit-file timeline), and any pending steer note.
- `camus watch [featId]` — the LIVE interactive version: the same dashboard auto-refreshing
  on the alternate screen, with one-key steering through the same audited steer.py path
  (`p` pause · `g` guidance · `c` clear · `q` quit). Degrades to a one-shot status print
  when there is no TTY. Backbone = camus's own stable state; `transcripts.py` adds a
  best-effort **live-agents** section read from the workflow's on-disk transcripts (per-agent
  model/tokens/tool calls), so the deep per-loop detail works from ANY terminal — and degrades
  to the backbone alone when Claude Code's internal transcript format shifts.
- `camus steer` — redirect a RUNNING feat at its next task boundary: `camus steer "<guidance>"`
  (steers the next task, threaded in exactly like a `needs_human` answer), `--task <id> "<g>"`
  (a specific task), `--pause` (graceful resumable halt), `--show` / `--clear`. A note is
  consumed ONCE. Live mid-task injection is deliberately unsupported — the engine is a
  deterministic, resumable script; the boundary is the safe redirect point.

## Outer-agent operator loop

When another agent operates Camus for a human, keep that layer thin. Camus owns task execution,
review rounds, custody, and receipts; the outer agent chooses the surface, supplies the complete
contract, watches host-owned evidence, and hands the result back.

1. **Choose the smallest useful surface.** Use Studio when the human benefits from visible seat
   selection, live phase/status controls, stop/resume, or receipt inspection. Use `/camus-loop`
   directly for one already-bounded task and `/camus-feat` for an ordered package. Use
   `/camus-plan` only when the request genuinely needs decomposition. Studio must accept the full
   acceptance contract and supported controls; never replace them with a narrower UI preset.
2. **Set outcomes, then allow bounded freedom.** Bind the source/spec, exact scope, exclusions,
   deterministic verify command, and handoff condition. Leave implementation choices open where
   that contract permits them. Pick the smallest credible `roundCap` and model/effort pairing for
   the stakes; do not spend review rounds to optimize style.
3. **Let a healthy run solve the task.** Observe `camus watch`/`camus status` or Studio's phase,
   process, worktree, and receipt signals. Do not inspect live reviewer-handle artifacts, add a
   third polling loop, re-judge every clean verdict, or implement the task outside Camus while the
   run is viable.
4. **Interrupt only for material invalidation.** Stop and repair Camus when custody is wrong, the
   task/contract drifts, a round cap is ignored, a process is orphaned, verification is bypassed,
   or a receipt/provenance claim is false. Record cosmetic UI friction, minor copy, token/latency
   waste, and non-blocking ergonomics for the retrospective instead of restarting the run.
5. **Close from evidence.** Require a terminal state, the intended clean worktree/commit, head-bound
   deterministic verification, and an honest valid receipt. Resume with the same persisted identity
   after an infra repair; do not create a parallel worktree or silently finish the code by hand.
6. **Feed back without self-modifying.** Run `camus retro` after meaningful dogfood sessions and
   combine its read-only history with the operator's bugs/UX/efficiency notes. Prioritize recurring
   or result-invalidating problems. Retro recommends; it never edits Camus or run configuration.

## Shipped hardening (all live, all tested)

- **Target guard** (`_guard.sh`): every gate script binds to the caller's repo, `camus/*`
  branches, and `camus-wt-*` worktrees — fail-closed, 3 Codex review rounds, probe-verified.
- **Auto mode, zero-click**: `npx camus-cli auto-setup` (in-repo: `install.sh --auto-setup`)
  installs a narrow scoped profile (egress trust for the Codex review + allow rules for the
  5 gate scripts only). Proven live: full feat runs with zero permission prompts.
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
- **Out-of-tree worktrees + cleanup**: task worktrees live under `~/.camus/worktrees/<repo>-<id>/`
  (never inside or beside the user's project — game-engine asset importers scan the tree, and
  sibling folders read as per-task trash). `camus-feat` removes each worktree once its branch
  is merged (branches kept for audit); failed/paused tasks keep theirs for inspection.
- **Watch & steer**: the feat persists a run-log event ring (last 20 steps, carried across
  resumes) + per-task telemetry into its state file; `status.py` renders it together with the
  per-round Codex audit mtimes. `steer.py` writes a once-consumed note the feat checks at every
  task boundary (pause / guidance / per-task answers); `paused_by_user` is terminal for the
  auto-resumer — only a human resumes a human pause.
- **Review input completeness**: `codex_review.sh` intent-to-adds (`git add -N`) the worktree
  before reviewing, so NEW files appear in the diff Codex reads (run feedback 2026-06-10: a
  task built mostly of new files was near-invisible to plain `git diff`). It also forces
  `</dev/null` on the codex call (an open stdin made codex block and return empty verdicts).
- **Dynamic review reasoning effort** (run feedback 2026-06-11): review is the gate, so codex's
  effort scales with stakes instead of a blunt constant (a user's ambient `xhigh` burns 10k+
  thinking tokens with no streaming → one feat cost ~700k tokens). The orchestrator picks per
  round: `medium` for the cheap first pass (most reviews are simple → ~3× faster), `high` when
  the change is hard (complex tier, or a prior round didn't clear), `xhigh` when CRITICAL (a P0
  surfaced) — mirroring the model-escalation signals, and visible in the run log. Only camus's
  own review effort moves; interactive codex is untouched. Workflow runs pin this explicitly in
  their run-start JSON (`reviewerEffort: "xhigh"`); their reviewer child is isolated from ambient
  `CAMUS_CODEX_ARGS`. Native/direct gate calls may still use that environment variable.

## Cost model (audited 2026-06-11)

Two vendors, two meters — never conflated:
- **Claude side** (classify/plan/implement/fix/runners — i.e. almost everything): runs on your
  Claude Code subscription. Light agents are already Haiku; think-work is Sonnet/Opus by tier.
  `camus watch`/`status` shows an **API-rate VALUE estimate** for the live run (input + output +
  cache, public rate card, dated) — an estimate of value consumed, never an invoice.
- **Codex side** (the review ONLY — nothing else leaves for OpenAI): under ChatGPT auth it draws
  your ChatGPT plan credits (same pool as the desktop app — the CLI is not a premium lane); under
  `OPENAI_API_KEY` it bills OpenAI API tokens instead. Camus never converts this to dollars.
  The levers that matter are already default: dynamic reasoning effort (medium→high→xhigh by
  stakes), `roundCap`, stuck-finding early-stop, and smaller diffs via `/camus-plan`. To pin a
  cheaper/faster reviewer model in a workflow, pass `reviewerModel` plus `reviewerEffort` in its
  run-start JSON (or `reviewerCodexArgs` for an advanced Codex CLI/provider override). These
  fields are snapshotted and explicitly exported; mutable runner environment is not identity.
  Native/direct calls may use `CAMUS_CODEX_ARGS="-c model=<model> -c
  model_reasoning_effort=medium"`. Fast-mode credit multipliers
  (2–2.5×) have not applied on camus's `codex exec` review path as validated (codex-cli 0.137.0
  exposed no exec fast lane) — OpenAI docs suggest Fast mode may persist to the CLI generally,
  so re-check on codex upgrades rather than treating this as a blanket CLI rule.

## Retry idiom (after fixing a gate/env failure)

Re-invoke the feat **fresh with the same args**: the featId is a deterministic hash of the
feat title + task list, so the new run lands on the same persisted state — done tasks skip,
the failed task re-runs against its intact worktree, through the now-fixed gate. Do **NOT**
resume the workflow journal (`resumeFromRunId`) past a fix: a completed-but-failed agent call
is still "completed" to the journal, so the cached failure replays without re-running anything
(observed live 2026-06-10: a journal resume after the stdin fix returned the cached
`infra_error` with the review audit untouched and 0 task tokens).

Target-B (VPS interactive) tooling remains **gated on G3** (subscription-auth-on-server ToS).
