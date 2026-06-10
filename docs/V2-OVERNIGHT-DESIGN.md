# Camus v2-overnight — Feat-Runner Design

**Status:** Draft for review · **Date:** 2026-06-08 · Depends on: v2-lite (proven 2026-06-08)
**Goal:** hand it a *feature* (a unit of work too big for one task), walk away, check one report at the end.

This is the tier the main spec deferred. v2-lite is the unit loop (one task → one verdict). v2-overnight
orchestrates *many* v2-lite runs into a feature, with the guarantees a multi-task run needs that a single
task doesn't. **Auto mode removes prompts — it does NOT remove these boundaries.**

---

## 1. What changes from v2-lite

v2-lite already gives: per-task plan→implement→Codex-review→fix→verify, bounded, with a hard infra guard,
in an isolated worktree, returning one structured verdict. The feat-runner **reuses that loop unchanged**
per task and adds the layer above it. The new guarantees (Codex's list, expanded):

| Concern | v2-lite | v2-overnight adds |
|---|---|---|
| Scope | one task | a **feat** = a set of tasks |
| State | in-run (script vars) | **persistent feat state** (survives crash/quit/resume) |
| Ordering | n/a | **task DAG** with dependencies |
| Identity | per-task worktree id (FNV of task) | **deterministic task IDs** + one **feat branch** |
| Integration | per-task verify | **final integration verify** on the merged feat branch |
| Output | one verdict | one **feat report** (per-task status + integration result) + **optional** connector publish (PR/notify), off by default |
| Recovery | resume within session | **resume the feat**: re-run only incomplete tasks |

---

## 2. Branch & worktree model

The integrity rule from v2-lite carries up: identity is **owned by the runner, never improvised**.

- One **feat branch** `camus/feat-<featId>` (note the **hyphen**) cut from the base branch at feat start.
  `featId` = **`<feat-slug>-<hash>`** — a slug of the feat title (human-legible) plus a short FNV-1a hash of
  the feat title + ordered task list (deterministic so reruns resume; unique so two feats with the same title
  don't collide). E.g. `add-divide-helper-1pkgi21`. The slug is for humans, the hash is the identity/guarantee
  — so branches and the `feats/<featId>.json` state file read clearly instead of being opaque hashes.
  - ⚠️ **Why task branches use `camus/feat/<featId>/…` (slash) and the feat branch uses `camus/feat-<featId>`
    (hyphen):** git stores refs as files/dirs, so `camus/feat-<featId>` (a ref file) and `camus/feat-<featId>/<task>`
    (which needs `camus/feat-<featId>` to be a *directory*) are a file-vs-directory collision — creating a task
    branch would clobber the feat-branch ref. The smoke hit this for real. Putting tasks under the sibling
    namespace `camus/feat/<featId>/…` (so at `refs/heads/camus/` you have the file `feat-<featId>` and the dir
    `feat/`) avoids the collision and keeps the human-facing feat-branch name literal. (Smoke, 2026-06-09.)
- Each task runs the **v2-lite loop in its own worktree**, branched from the *current feat branch* (so a
  task sees its dependencies' merged work). **Task identity is feat-scoped**, not just a task hash: the branch
  is `camus/feat/<featId>/<taskId>` where `taskId = <slug>-<id>` and `id = hash(featId + taskSpec)` — i.e. exactly
  what the v2-lite loop emits when given `branchPrefix:"camus/feat/<featId>/"` + `idSalt:featId`. The state node
  stores the resolved branch string. v2-lite's same-task collision was fine for one task, but overnight will
  see common names ("add tests", "fix lint") across different feats — scoping by `featId` keeps them from
  colliding. (Codex review, 2026-06-09.)
- On task `done` (Codex clean + verify pass), its branch **merges into the feat branch**. On any non-done
  status, it does **not** merge — it's surfaced and its dependents are blocked.
- Nothing touches the base branch. The human reviews/merges the feat branch at the very end.

Open question: merge-conflict handling between sibling tasks (see §6).

---

## 3. Execution model

1. **Intake → decomposition.** A feat spec becomes an ordered **task DAG**: nodes are v2-lite tasks, edges
   are dependencies. (M1: human-authored task list. Later: a planner agent proposes the DAG, adversarially
   reviewed before it runs — same closed-loop discipline.)
2. **Cut feat branch + environment check (first-class gate).** Cut `camus/feat-<featId>` from base, then confirm
   it's RUNNABLE — `env_check.py`: correct node, deps installed, verifier toolchain on PATH. If not → stop
   `env_not_ready` and report what to fix (e.g. `pnpm install`). **Fresh git worktrees routinely lack
   untracked deps like `node_modules`**, so this gate is explicit and non-optional, not folded into verify.
   (Order matters: cut the branch first, then check it — Codex, 2026-06-09.)
3. **Baseline verify (fail fast on a red base).** Run the verifier on the freshly-cut feat branch **before
   any task runs**. If the base is already red → stop `base_red` and report. (Don't burn the feat to discover
   the base was broken from the start.)
4. **Schedule.** Run tasks whose dependencies are all `done`. Independent tasks may run in parallel, bounded
   by the runtime's 16-concurrent / 1000-total agent caps **and** a feat-level concurrency limit (each task
   is itself several agents, so the real ceiling is lower).
5. **Per task:** invoke the v2-lite loop (unchanged). On `done` → merge into feat branch, mark node done.
   On `review_unresolved` / `verify_failed` / `infra_error` → mark node failed, **block its dependents**,
   keep independent branches going.
6. **Integration verify.** After the DAG drains, **re-run the environment check first** — tasks may have
   added or changed dependencies, so the merged branch can need a fresh install; without this a missing new
   dep mislabels as `feat_integration_failed` when the truth is `env_not_ready`. Then run the verifier on the
   integrated feat branch and compare against the baseline: this isolates cross-task breakage the feat
   *introduced* from pre-existing red or env gaps, and catches what green per-task verifies individually miss.
7. **Report.** Emit one structured feat report: env + baseline result, per-task status, what merged, what's
   blocked and why, the integration-verify result, and the feat branch to review.
8. **Publish (optional, OFF by default).** If connectors are enabled, open a PR for the feat branch and
   update the tracker / notify a channel. Default M1 output is branch + report only; the human reviews and
   merges. The connector path is opt-in, not required to run a feat.

---

## 4. Stop conditions (the brakes that auto mode must not collapse)

- A task that exhausts its v2-lite ROUND_CAP / fails verify / hits infra → **does not merge**, blocks
  dependents. The feat does not "push through" a failed task.
- **Feat-level caps:** max tasks, max review/fix rounds across the feat, and a wall-clock / rate-limit
  ceiling. When hit → stop, report partial progress, never silently continue.
- **Environment gate:** if the feat branch isn't runnable (deps/node/verifier toolchain) — checked before
  baseline **and** again before final integration verify — → stop (`env_not_ready`), report what to fix, run
  nothing. An unrunnable env is never reported as a code failure.
- **Baseline gate:** a freshly-cut feat branch that fails verify *before any task* → stop (`base_red`),
  report, run nothing. Never start work on a red base.
- **Integration verify is non-negotiable:** all-tasks-green does NOT mean feat-done; the merged branch must
  pass the verifier. A clean DAG with a red integration verify (that the baseline passed) →
  `feat_integration_failed`.
- Auto mode's own fallback (pause after repeated classifier blocks) is a backstop, not the brake.
- **No self-mutation mid-feat:** the runner, skill, verifier, schemas, and permission rules are **frozen**
  for the duration of a run; the loop never edits its own brakes while driving. Improvements are proposed as
  tasks for a later maintenance run (see §8).

---

## 5. Persistent feat state & recovery

- Live, authoritative feat state lives in a file **outside any worktree**
  (`~/.camus/feats/<featId>.json`), same tamper-proofing as the gate scripts. Holds the DAG,
  each node's status, the merged set, and the feat branch ref. (Mutable run-state never goes inside the repo
  the agents edit — see §6 #4.)
- The **final report/manifest is a reviewable artifact** at feat end. Default: exported **out-of-tree**
  (e.g. `~/.camus/reports/<featId>.json`). Optionally, *after* the run, it may be committed or
  attached to the feat branch/PR for in-tree review. Either way, **mutable run-state never lives in the
  repo** — only the finished report may be brought in-tree, and only post-run. Tamper-resistance during the
  run, reviewability at the end.
- **Deterministic task IDs** (hash of task spec) make resume safe: a resumed feat reads state, skips `done`
  nodes, re-runs only incomplete ones. No Math.random / Date anywhere (the v2-lite determinism gotcha
  applies to the whole layer).
- A crash mid-task leaves that task's worktree unmerged; resume re-runs that task cleanly (its worktree is
  recreated deterministically or cleaned first).

---

## 6. Open questions (decide before building, not during)

1. **Decomposition authority** — human-authored task list (M1) vs a planner agent that proposes the DAG.
   If agent: the DAG itself should pass an adversarial review before execution (closed loop on the plan).
2. **Sibling merge conflicts** — two independent tasks editing nearby code. Options: serialize on file
   overlap (detect from each task's `files_changed`), or detect conflict at merge and route a resolve task.
3. **Parallelism ceiling** — each task is N agents; need a feat concurrency limit well under the 16-cap.
4. **Where feat state lives — RESOLVED (Codex review, 2026-06-09).** Split mutable state from the reviewable
   artifact: **(a)** live, authoritative feat state goes **per-user, outside any worktree**
   (`~/.camus/feats/<featId>.json`) — tamper-proof, the code under review can't edit the state
   that governs the run; **(b)** the **final report/manifest is exported as a reviewable artifact** at feat
   end (out-of-tree, e.g. `reports/camus/<featId>.json`, or attached alongside the branch). Best of
   both: tamper-resistance during the run, reviewability at the end. Don't put mutable run-state inside the
   repo the agents edit. (This supersedes the earlier "$5 leans per-user / $6 open" wording — $5 and $6 now
   agree.)
5. **Feat output — RESOLVED:** branch + report by default; an **optional** connector-backed publish step
   (open PR / update tracker / notify) behind an **off-by-default flag**. Merge stays human in every case,
   so M1 keeps the least surface by default.

---

## 7. v1 contracts to port (the contracts, not the bash)

This layer is where v1's multi-task machinery earns its place — ported as workflow logic / state, not bash:
queue selection (→ DAG schedule), dependency handling (→ DAG edges), ghost-commit guard (→ "task marked
done but nothing merged" check), journal/events (→ feat state + report), crash recovery (→ resumable state).
Port each **only when the feat-runner actually needs it**, per the v1 lesson (don't over-build ahead of use).

---

## 8. Continuous improvement / retrospective loop

Every feat run ends with a **structured retrospective report** — beyond the pass/fail summary of §3, it
captures the calibration data: per-task outcomes, Codex review findings, verifier failures, blocked
dependents, review/fix retries, infra failures, token & agent usage, suspected **false positives** (findings
that were wrong or noise), and a "what slowed this down" narrative.

From that report the runner **may emit improvement candidates as backlog items — never auto-applied.** Each
candidate must:

- **Target a specific surface:** `SKILL.md`, `review-prompt.md`, `sev.schema.json`, `verify.py`, the
  workflow JS, the allowlist config, or feat-runner logic. "Make it better" is not a candidate.
- **Carry evidence** — a concrete observation, not a vibe: *"this task failed verify twice because the
  detector missed the monorepo's test script", "Codex flagged schema drift on `priority` three times",
  "review false-positived on generated files."* No evidence → no candidate.

**Improvements to Camus itself go through Camus's own gate** — tests + Codex review +
deterministic verify. The system improves itself only through the same closed loop it runs on everything
else. (This whole session *was* that loop, run by hand: Codex caught the schema-strictness 400, the
`verdict`/`status` mismatch, and the `Math.random` resume break — each fixed under test + review. The retro
loop just formalizes it.)

### Hard rule — no self-mutation while driving

> Camus may **learn** from reports, but it may **not mutate its own runner, skill, verifier, schemas,
> or permission rules during a feat run.** It can only **propose improvement tasks for a later, explicit
> maintenance run.**

A system that rewrites its own brakes mid-drive has no brakes. Calibration is a separate, human-initiated
maintenance feat — itself gated like any other.

**Mental model:** reports → calibration tasks → an improved loop → the next feat handled better. Compounding
quality, with the safety property that the loop in force during any run is always a frozen, reviewed one.

---

## 9. Milestones (incremental — prove each before the next)

- **M1 — sequential feat.** Human-authored ordered task list, no parallelism, no auto-decompose. Sequence:
  **preflight** (`install.sh --check` so the gate isn't stale; base working tree clean so the feat doesn't
  branch from dirty local state) → cut feat branch → **environment check** → **baseline verify** (stop
  `env_not_ready` / `base_red` — never start on an unrunnable or red base) → run v2-lite per task → merge
  only `done` tasks → **env re-check + final integration verify** → **report (branch + report is the default,
  connector-free output)**. An **optional** connector publish (open PR / update tracker / notify) sits behind
  an **off-by-default flag** — opt-in, not required for M1. Proves the feat-branch + baseline + integration
  shape with the least new surface by default. **Build this first.**
  - *Build note (Codex, 2026-06-09):* **no DAG machinery in M1.** Execute the human-authored list strictly
    sequentially, but model it internally as a *linear* DAG and keep the **state schema dependency-compatible**
    (each node carries a `dependsOn: []` that's always empty in M1) — so M2 adds edges/parallelism without
    migrating state. Exact M1 scope: featId + feat branch + sequential task list, per-user state file,
    `install.sh --check`, clean-worktree check, env check, baseline verify, call v2-lite per task, merge only
    `done`, env re-check, final verify, report. **Everything else stays out.**
- **M2 — DAG + bounded parallelism.** Dependencies + a few parallel independent tasks under a feat
  concurrency cap.
- **M3 — auto-decompose.** A planner agent proposes the DAG from a feat spec; the DAG is adversarially
  reviewed before running.
- **M4 — resilience.** Persistent state + feat resume + sibling-conflict handling.
- **M5 — calibration loop (§8).** Retro reports emit evidence-backed improvement candidates; a separate,
  human-initiated maintenance feat applies them through the standard gate. Build only once real runs have
  generated real signal — do **not** synthesize calibration data (the v1 "don't tune without traffic" lesson).

Decision gate after M1: does a sequential feat-runner beat just running v2-lite by hand per task? Only build
M2+ if it does — same discipline that gated v2-lite over plain `/goal`.

---

*The feat-runner is v2-lite's loop wrapped in a scheduler and an integration gate. The unit stays honest
(Codex + verify per task); the feat stays honest (integration verify + stop conditions). Auto mode just
means you're not clicking — every gate still fires.*
