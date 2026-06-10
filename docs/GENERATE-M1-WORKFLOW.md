# Generating the M1 feat-runner (v2-overnight, milestone 1)

Same flow that built v2-lite: Claude Code generates the workflow from this prompt; you inspect
and save. The per-task engine **reuses the proven v2-lite loop** (`camus-loop`) — M1 only
adds the feat-level wrapper. Scope is exactly what `V2-OVERNIGHT-DESIGN.md` §9 M1 locked —
**no DAG machinery, no parallelism, no bisection.** Build the smallest thing that proves the
feat-branch + baseline + integration shape.

## 0. Prereqs

- v2-lite installed and smoke-green (`bash install.sh && bash install.sh --check`).
- `env_check.py`, `verify.py`, `codex_review.sh`, `adapter.py` present in the installed skill.
- A short, human-authored **ordered task list** for a real feat (2–3 tiny tasks for the first run).
- **Human preflight before launching:** run `bash install.sh --check` yourself (gate in sync). The
  workflow runs from the *target* repo and can't locate the Camus source checkout, so gate-freshness
  stays a human step — don't make the generated workflow guess a path. (Codex P2, 2026-06-09.)

## 1. Generation prompt (paste into Claude Code from the target repo)

> ultracode: Build a dynamic workflow `camus-feat` that runs an ordered list of tasks as
> ONE feature, reusing the existing `camus-loop` per-task logic. `args` = `{ feat: "<title>",
> tasks: ["task 1", "task 2", ...] }` (an ordered list; treat it as a LINEAR DAG — execute strictly
> sequentially, but give each task node a `dependsOn: []` field, always empty in M1, so M2 can add
> edges later without migrating state).
>
> Identity & state (deterministic, no Math.random/Date):
> - `featId` = `<feat-slug>-<hash>`: `slugify(feat-title)` (human-legible) + a 6-char FNV-1a hash of the feat
>   title + ordered task list (deterministic for resume; unique across same-titled feats). E.g.
>   `add-divide-helper-1pkgi21`. Used everywhere — branch, state file, idSalt. Feat branch: `camus/feat-<featId>`
>   (hyphen) cut from the current base branch. (Slugify truncates ~24 chars so names stay clean.)
> - Each task: passing `branchPrefix:"camus/feat/<featId>/"` + `idSalt:featId` to the v2-lite loop yields branch
>   `camus/feat/<featId>/<slug>-<id>` where `id = FNV-1a(featId + taskSpec)`. That suffix `<slug>-<id>` IS the
>   `taskId`; **store the resolved branch string on the task's state node** so identity is unambiguous. The
>   task's worktree is cut from the CURRENT feat branch (so it sees prior merged work).
> - Persistent state file OUTSIDE any worktree: `~/.camus/feats/<featId>.json`
>   { featId, featBranch, base, tasks:[{taskId, spec, dependsOn:[], status, branch}], baseline,
>   integration, status }. Write it after each task so the feat is resumable; on resume, skip `done` tasks.
>
> Sequence (stop at the first gate that fails; never proceed past a red gate):
> 1. PREFLIGHT (workflow) — confirm the base working tree is CLEAN; if dirty → stop `dirty_tree`. (Do NOT
>    try to run `install.sh --check` from here — gate-freshness is a human step done before launch; the
>    workflow can't locate the Camus source.)
> 2. Cut the feat branch.
> 3. ENV CHECK — run `env_check.py` on the feat branch. If not runnable → stop `env_not_ready` and report
>    what to fix (e.g. `pnpm install`). (Fresh worktrees lack `node_modules` — this gate is mandatory.)
> 4. BASELINE VERIFY — run `verify.sh` on the freshly-cut feat branch. If red → stop `base_red`.
> 5. FOR EACH task, in order: run the SAME plan→implement→(codex-review↔fix)→verify loop the
>    `camus-loop` workflow uses (classify→route model, thin Codex reviewer, gated on P0/P1/P2,
>    deterministic verify). **Pass feat-scoped identity into that loop** so its branch is feat-namespaced,
>    not derived from task text alone: `branchPrefix: "camus/feat/<featId>/"` and `idSalt: "<featId>"`
>    (camus-loop now accepts these args; the task branch becomes `camus/feat/<featId>/<slug>-<id>`).
>    Each task's worktree branches off the CURRENT feat branch. On the task's `done` → merge its branch into
>    the feat branch, mark the node `done`, update state. On any non-done (`review_unresolved` /
>    `verify_failed` / `verify_inconclusive` / `infra_error`) → mark the node failed and HALT the feat (report
>    partial); do NOT run later tasks on top of a failed one in M1.
> 6. ENV RE-CHECK — run `env_check.py` again on the merged feat branch (tasks may have added deps), then
>    FINAL INTEGRATION VERIFY (`verify.sh`) on the feat branch. If env not ready → `env_not_ready`; if verify
>    red (and baseline was green) → `feat_integration_failed`.
> 7. REPORT — emit a structured feat report: env+baseline result, per-task status, what merged, what halted
>    and why, integration result, and the feat branch to review. Write it to
>    `~/.camus/reports/<featId>.json` (out-of-tree). Leave the feat branch for the human to merge.
>
> The workflow only COORDINATES — agents run all shell (git, env_check.py, verify.sh, codex_review.sh) and
> return JSON; the script parses and branches. No DAG edges, no parallelism, no bisection/culprit analysis.
> Show me the script before running.

## 2. Review the generated script before saving

- [ ] Strictly sequential; each task node has `dependsOn: []` (linear DAG, schema forward-compatible).
- [ ] `featId` and the task hash `id` are deterministic FNV-1a-derived (NO `Math.random` / `Date` — would
      break resume); `taskId` is `<slug>-<id>` (only `id` is the hash).
- [ ] Task branches are **feat-scoped** via `branchPrefix`/`idSalt` passed to camus-loop (NOT its
      default task-text-only naming) → `camus/feat/<featId>/<slug>-<id>`.
- [ ] State file is under `~/.camus/feats/` (per-user, OUTSIDE the worktree).
- [ ] Workflow preflight halts on a dirty tree (gate-freshness `install.sh --check` is a HUMAN step, not in
      the workflow); cut branch → env check → baseline; **env re-check before final verify**.
- [ ] `base_red` / `env_not_ready` stop *before* any task; first task failure HALTS the feat (no building on red).
- [ ] Merges only `done` tasks into the feat branch; never touches the base branch.
- [ ] Per-task loop reuses the v2-lite gates (Codex review + deterministic verify), not a reimplementation.
- [ ] Report written out-of-tree; feat branch left for human merge.

If all pass: `/workflows` → save as `/camus-feat`.

## 3. First smoke

A 2-task toy feat on a fresh `/tmp` repo (e.g. "add a divide() with a zero guard" + "add a test for it"),
so you watch: preflight → env/baseline → task1 done→merge → task2 done→merge → integration verify → report.
Then a small real feat on Camello. Paste the report back.
