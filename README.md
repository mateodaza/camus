# Camus

**Makes it work. Knows when to stop.**

No agent grades its own work. Camus runs a coding task from plan to verified commit
without you watching: Claude writes the code, Codex (a competing model) reviews
every change, and your repo's own type-check and tests have the final word. Nothing in
the loop, Claude included, can approve itself. The pairing is the point.

Two judges can disagree, so Camus is also built for the run that does not go cleanly:
review loops are bounded, a stalled review becomes a decision on your desk instead of
burned rounds, and a crash at any point resumes without redoing proven work.
*A craftsman knows how to work; an artist knows when to stop.*

It runs as two Claude Code workflows plus a skill: `/camus-loop` takes one task,
`/camus-feat` takes an ordered task list and ships it as one feature branch with a
report. Formerly Nightcrawler v2; v1 remains archived at [mateodaza/nightcrawler](https://github.com/mateodaza/nightcrawler).
Full design: [`CAMUS-SPEC.md`](https://github.com/mateodaza/camus/blob/main/CAMUS-SPEC.md).

```
plan → implement → [ Codex review ↔ fix ]* → commit gate → dep prep → verify
       loops while P0/P1/P2 findings remain, round cap 3
```

## Requirements

- **Claude Code** v2.1.154+ with dynamic workflows, on a subscription plan.
  Camus runs interactively, so usage counts against your plan limits rather than
  metered API credit.
- **Codex CLI** installed and authenticated (ChatGPT plan or API key). This is the
  reviewer. Without it, nothing gets approved.
- **node ≥ 18**, **python3**, **git**. The gate scripts are pure stdlib.
- A repo you trust. The verifier runs that repo's own build and test commands.

## Why you can trust a green run

**The reviewer is a competing model.** Codex reviews; a thin runner relays its JSON
verbatim. Claude never re-judges the verdict. Each round starts a fresh Codex session
so old findings get re-raised instead of politely dropped. Every round is also written
to `~/.camus/reviews/`. If that file is missing, the review binary never ran.

**Tests are the last word.** A clean review does not ship code that fails
`type-check` or `test`. The verifier auto-detects the stack (node, python, rust, go,
foundry, make) or uses `CAMUS_VERIFY_CMD`. If it finds no verifier at all, that is a
loud failure, not a pass.

**A broken environment never reads as broken code.** Codex failing to run is
`ran:false`: retried, never fed to the fix loop, never counted as clean. Missing
`node_modules` is `verify_inconclusive`, not `verify_failed`. This distinction is the
#1 defense against runaway loops, and it is enforced in the adapter, not in a prompt.

**Work provably lands.** After review passes, a commit gate stages and commits the
worktree. Nothing staged means `no_changes`; the task is reported as a no-op, never
silently marked done. Every `done` carries its `commit_sha`.

## Why it stops well

Review↔fix churn is the failure mode of autonomous coding, so stopping is engineered,
not hoped for.

**Loops are bounded and self-aware.** Rounds are capped (`roundCap`, default 3). A
finding that survives its own fix stops the loop early — that is a stale flag or a real
disagreement, and both deserve a human, not more rounds. Each finding's confidence is
tracked across rounds, so the halt tells you whether the reviewer was losing conviction
(lean accept) or holding firm (lean refine). Advisory context, never an auto-pass.

**A stalled review is a decision, not a failure.** When review will not converge but
your type-check and tests are green, the task halts as `needs_decision`: the
deterministic gate says shippable, the probabilistic one is stuck, and that call is
yours. Accepting is one flag — `land: ["<taskId>"]` — and the proven worktree commits,
verifies, and merges with nothing re-implemented. Refining is a normal re-run with your
answer threaded in.

**Kill it anywhere; resume finishes only what is left.** State persists at every
boundary. Finished tasks skip. Work that died between commit and merge lands itself on
resume (`ready_to_merge`), and a merge that already happened is detected by its own
commit in feat history. Merge verdicts require complete, consistent evidence — missing
or contradictory evidence halts the run loud; it is never read as an outcome.

**Costs are stated honestly.** `camus watch` prices the Claude side of a live run at
the published API rate card, labeled as an estimate, never an invoice. The Codex review
settles in your ChatGPT plan credits, and Camus does not fabricate a dollar figure for it.

## Autonomy controls

- **Plan it first (optional).** `/camus-plan "<request>"` reframes a vague or large
  request into a quality-gated, ordered task list before any code is written: it grounds
  in your repo, asks when genuinely ambiguous, designs the change, decomposes it to camus
  standards (right-sized, baseline-green between tasks, explicit acceptance criteria), then
  has an adversarial reviewer score the plan. It writes a plan file you review and edit,
  then run with `camus-feat`. Better plans converge in fewer review rounds.
- **Zero-click runs.** `camus auto-setup` installs a narrow permission profile: one
  egress trust line for the review diff, plus allow rules for the five gate scripts.
  Not `bypassPermissions`, no broad shell access. The runner agents' routine git
  plumbing is approved by Claude Code's auto-mode classifier; the profile and the
  classifier together are what make runs prompt-free.
- **It asks when it should.** `policy: autonomous | ask_on_ambiguity (default) |
  ask_on_major`. A genuinely ambiguous task halts with a question (`needs_human`);
  resuming with your answer re-runs just that task.
- **Decisions are reported.** Every judgment call the implementer makes (say,
  widening a parameter type) lands in the report with the reason and the rejected
  alternative. You review decisions, not just diffs.
- **Models are routed, then escalated.** A cheap classify pass sends trivial tasks to
  Sonnet and the rest to Opus. If review findings persist past round 2, or any P0
  appears, the fix model escalates automatically. Override with `model:` or `modelTier:`.
- **Interrupted runs resume.** `camus resume` lists interrupted feats with their
  exact original arguments. Finished tasks skip; the unfinished one re-runs.
- **Gate scripts are fenced in.** Every script checks it is operating on the calling
  repo, a `camus/*` branch, and a `camus-wt-*` worktree. Anything else is rejected.
- **Your project folder stays clean.** Task worktrees live under
  `~/.camus/worktrees/<repo>-<id>/`, never inside or beside your project. Once a task's
  branch is merged into the feat branch its worktree is removed (the branch is kept
  for audit); failed or paused tasks keep theirs for inspection.
- **You can watch it — and grab the wheel.** `camus watch` is a live terminal
  dashboard: per-task board, the last 10 steps, review rounds, and tokens,
  auto-refreshing, with one-key steering — `p` pauses at the next task boundary
  (resumable), `g` steers the next task, `c` clears a pending note. `camus status`
  is the one-shot version; `camus steer "<guidance>"` scripts the same notes.
  Notes are consumed once, at the run's safe redirect points.

## Layout

This is a monorepo:

```
packages/cli/             # the npm package "camus"
  bin/camus.js            # CLI; dispatches to install.sh, adds no logic of its own
  install.sh              # install / check / auto-setup / env-check
  merge_settings.py       # permission-profile merger (preserves your settings)
  workflows/              # camus-loop + camus-feat (the engine)
  skills/camus/           # SKILL.md, review prompt, schema, gate scripts (unit-tested)
apps/web/                 # the marketing site (Next.js, static export)
brand/                    # logo SVGs + BRAND.md
docs/                     # design notes and generation recipes
CAMUS-SPEC.md             # the full design
```

## Install

```bash
npm i -g camus-cli
camus install        # copy skill + workflows into ~/.claude (a frozen copy, not a symlink)
camus check          # exit 0 = installed matches package. Run before every auto run.
camus env-check .    # will this repo's toolchain actually run? (node version, deps)
camus auto-setup     # optional: the zero-click permission profile
```

From a checkout: `npm i -g ./packages/cli` from the repo root, or run `./install.sh`
directly inside `packages/cli/`. The CLI and the shell script are the same entrypoints.

### Upgrading

The gate in `~/.claude` is a **frozen copy** — updating the npm package alone changes
nothing about what your runs execute. Upgrading is two steps, and `camus check` walks
you through both:

```bash
npm i -g camus-cli@latest
camus check          # now reports DRIFT (your frozen gate is the old version)
camus install        # re-freeze the new gate into ~/.claude
camus auto-setup     # only if check flagged the auto profile — re-runs migrate it in place
```

`camus check` is the upgrade detector by design: run it before any auto/feat run and a
stale gate can never run silently. (0.2.0 upgraders: re-run `camus auto-setup` once — the
trusted-context line changed for the new worktree home, and apply migrates the old line out.)

## Run

From your repo:

```bash
camus check
export CAMUS_REPO_ROOT="$(pwd -P)"
export CAMUS_VERIFY_CMD="pnpm type-check && pnpm test"   # include tests, not only types
claude --permission-mode auto
```

Then `/camus-feat` with your task list, or `/camus-loop <one task>`. The feature
report lands in `~/.camus/reports/<featId>.json`. The branch is left for you to merge.

## Tests

Pure stdlib, no network, no dependencies. 163 assertions across 9 suites:

```bash
npm test    # or run the suites individually under skills/camus/scripts/
```

Codex has reviewed Camus's own adapter, guard, and workflows, and caught
real bugs each time.

## Boundary

Camus is for code you already trust. The verifier executes the repo's own build and
test commands; on an untrusted repo that is remote code execution. Never run it as
root. Camus may improve itself only through tasks that pass its own gates. It never
touches its runner, skill, verifier, schemas, or permissions during a run.
