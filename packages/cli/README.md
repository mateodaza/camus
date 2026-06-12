# Camus

**A coding loop that proves every change.**

No agent grades its own work. Camus runs a coding task from plan to verified commit
without you watching: Claude writes the code, Codex (a competing model) reviews
every change, and your repo's own type-check and tests have the final word. Nothing in
the loop, Claude included, can approve itself. The pairing is the point.

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
- **Git means LOCAL git only — GitHub is never involved.** No remote, no account, no
  push (camus never pushes; merge and publish stay yours). If your project folder
  isn't a repo yet, the entry fee is ten seconds and fully offline:
  `git init && git add -A && git commit -m baseline`. It is not ceremony — the diff
  is what the cross-vendor reviewer judges, the worktree is the isolation, merge-on-
  done is the rollback, and commits are why crashed runs resume instead of leaving
  your files in an unknown state. A mode that "just edits files and reports success"
  would be an agent grading its own homework — the exact thing camus exists to refuse.

### Starting from zero

Camus gates *changes* against a baseline and your own tests, so a brand-new project
needs one bootstrap step before the gate has anything to hold: scaffold it (a plain
Claude Code session or `npm create …` is fine for step zero) until a single verify
command exists — even one trivial test — then `git init && git add -A && git commit`.
From the second change onward, every edit runs through the loop. An empty repo halts
honestly as `env_not_ready` ("nothing to verify ≠ code is broken"), never as a fake
green: a gate with no floor would just be an agent grading its own work again.

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
- **Review speed: prune codex's MCP servers.** Every review spawns a fresh
  `codex exec`, which initializes every MCP server in `~/.codex/config.toml` —
  including ones that fail auth or spawn through `npx`. On a measured setup,
  disabling unused servers cut trivial-call wall time ~35% and silenced startup
  errors (the token cost of MCP tool definitions is small — the win is latency
  and noise). Disable per server, which leaves the rest of your codex setup alone:

  ```toml
  [mcp_servers.<name>]
  enabled = false
  ```

  (`-c mcp_servers.<name>.enabled=false` works per-invocation too; overriding the
  whole table with `mcp_servers={}` does NOT — config tables merge.)

## Layout

```
camus/
  bin/camus.js            # CLI; dispatches to install.sh, adds no logic of its own
  install.sh              # install / check / auto-setup / env-check
  merge_settings.py       # permission-profile merger (preserves your settings)
  workflows/
    camus-loop.workflow.js   # one task
    camus-feat.workflow.js   # ordered task list as one feature
  skills/camus/
    SKILL.md              # severity model, hard rules, run surface
    review-prompt.md      # Codex's audit persona and completeness check
    sev.schema.json       # Codex --output-schema
    scripts/              # gate scripts, guard, adapter; all unit-tested
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

### npx cache skew

`npx camus-cli` can resolve a cached older version of the CLI — we have observed 0.2.0
and 0.2.2 answering alternate invocations mid-feat. This is display-only: the gate in
`~/.claude` is a frozen copy, so what your runs execute is unaffected. For a pinned CLI,
use `npx camus-cli@latest` or install globally (`npm i -g camus-cli`).

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
