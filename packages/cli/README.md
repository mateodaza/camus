# Camus

**A coding loop that proves every change.**

No agent grades its own work. Camus runs a coding task from plan to verified commit
without you watching: Claude writes the code, Codex (a competing model) reviews
every change, and your repo's own type-check and tests have the final word. Nothing in
the loop, Claude included, can approve itself. The pairing is the point.

It runs as three Claude Code workflows plus a skill: `/camus-plan` turns a raw
request into a quality-gated task list, `/camus-loop` takes one task, and `/camus-feat`
ships an ordered task list as one feature branch with a report. Formerly Nightcrawler
v2; v1 remains archived at [mateodaza/nightcrawler](https://github.com/mateodaza/nightcrawler).
Full design: [`CAMUS-SPEC.md`](https://github.com/mateodaza/camus/blob/main/CAMUS-SPEC.md).

```
plan → implement → [ Codex review ↔ fix ]* → commit gate → dep prep → verify
       full posture: loops while P0/P1/P2 findings remain, round cap 3
       oneshot posture: one review, one repair, no re-review — verify still decides
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
  `git init && git add -A && git commit --allow-empty -m baseline`. It is not ceremony — the diff
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

### Supported stacks

The verifier auto-detects these with zero config. Anything else halts as an honest
`inconclusive` (never a fake red or green) — one `CAMUS_VERIFY_CMD` line makes it
first-class:

| Stack | Zero-config verify | Recipe when not |
| --- | --- | --- |
| Node (pnpm / yarn / npm) | yes — `test`/typecheck scripts, or `tsc --noEmit` | — |
| Bun | yes — via `bun run test` (the package's script, not Bun's built-in runner) | — |
| Python, flat layout | yes — pytest (+ mypy/pyright if configured); `uv.lock` repos run through `uv run` | env-managed (poetry/pipenv/conda): `CAMUS_VERIFY_CMD="uv run pytest -q"` or `"poetry install --sync -q && poetry run pytest -q"` |
| Rust / Go / Foundry | yes — check/build + test | raise `CAMUS_VERIFY_TIMEOUT` (seconds) for cold compiled builds |
| Make | yes — when a literal `test:` target exists (Makefile/GNUmakefile) | `CAMUS_VERIFY_CMD="make ci"` |
| JVM (Gradle / Maven) | no — inconclusive | `./gradlew test` / `mvn -q test` |
| Ruby | no — inconclusive | `bundle install --quiet && bundle exec rspec` |
| PHP | no — inconclusive | `composer install -q && vendor/bin/phpunit` |
| Elixir | no — inconclusive | `mix deps.get && mix test` |
| Swift | no — inconclusive | `swift test` |
| CMake | no — inconclusive | `cmake -B build -S . && cmake --build build && ctest --test-dir build` |
| Deno | no — inconclusive | `deno test` |
| .NET | no — inconclusive | `dotnet test` |
| Docker-only | no — inconclusive | `docker compose run --rm app <test cmd>` — the daemon must be up |
| Godot / Unity | no — verify via headless runners | e.g. `godot --headless -s addons/gut/gut_cmdln.gd`; out-of-tree worktrees avoid editor rescans (a design win) |
| Bare scripts | no | `CAMUS_VERIFY_CMD="./scripts/test.sh"` |

## Why you can trust a green run

**The reviewer is a competing model.** Codex reviews; a thin runner relays its JSON
verbatim. Claude never re-judges the verdict. Each round starts a fresh Codex session
so old findings get re-raised instead of politely dropped. Every round is also written
to `~/.camus/reviews/`. If that file is missing, the review binary never ran.

**Review depth is judged by liveness, not a stopwatch.** Codex runs detached behind an
event-stream watchdog: a review counts as alive while it emits events, and silence past
`CAMUS_REVIEW_IDLE_S` (default 360s) gets it killed and retried as infra. Long honest
reviews re-attach in bounded chunks, so no tool timeout caps review depth anymore. Each
round also logs Codex's own token usage and keeps a full event-stream audit dir
alongside the verdict file.

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

**It refuses bad ground, and names the remedy.** Preflight halts on a directory that
is not a repo yet (the ten-second local-only entry fee above, `--allow-empty` included),
on a repo with zero commits, on a detached HEAD, and on a dirty tree — with a hint when
the "dirt" is just a stale submodule pointer. Every refusal prints the exact commands
that clear it.

**Gate-owned git runs hookless and unsigned.** Repo hooks and forced signing can abort
unattended commits and merges — and a post-commit push hook could have exfiltrated
branches. Camus never pushes, and now no target-repo config can make it. Failed staging
is an infra error, never a fake no-op. An embedded repo is refused rather than committed
as a broken gitlink, and submodule pointer noise cannot wedge a run.

### The gate catches its own drops

A task can fail in ways that look like success, so the feat runner audits itself before
it believes itself:

- A **containment guard** halts any task whose agents leaked edits into your main repo
  tree, naming the files and the phase. Nothing is auto-discarded — the dirt could be yours.
- A **postflight self-audit** proves every completed task's branch is actually in feat
  history before the feat may report done. Missing ancestry evidence halts loud instead
  of becoming a green feat.
- A **"no-op" with unmerged commits** on its branch is recognized as a prior run's proven
  work and rescued into an auto-land, never dropped.
- A **branch collision** is disambiguated before advice is given: empty residue gets a
  one-line cleanup, real prior work gets landed by the resume.
- A **crash between commit and merge** restores the task's true verdict on resume, so
  proven work lands mechanically instead of being re-implemented.

## Review postures

`posture: full (default) | oneshot` on `camus-feat` and `camus-loop` sets the cadence
of the probabilistic review — never the gate's presence. Deterministic verify is
unskippable in every posture.

`full` is the loop above: review ↔ fix rounds until clean or the cap (`roundCap`,
default 3). A finding that survives its own fix halts the loop early — that is a stale
flag or a real disagreement, and both deserve a human, not more rounds.

`oneshot` trades review depth for speed on work you are confident about: one review,
automatically narrowed to a diff-primary "light" scope (same severity bar, narrower
field of view), then blocking findings get one fix pass with no re-review, and verify
decides. The trade is priced honestly: a fixed-but-unreviewed task reports
`done_with_findings`, carrying the findings verbatim plus the fix agent's per-finding
`claimedResolution` — claims, never verdicts, because nobody re-checked the fix.
"Review clean" stays reserved for an actual clean verdict, and a feat holding any such
task ends `done_with_findings` itself: ◈ on the board, never plain done.

Selection is one contract: an explicit `posture` is used verbatim and never re-asked.
Absent one, a classifier recommends from the task briefs — asking policies confirm a
speed posture once (`needs_human`), while `autonomous` applies `full|oneshot` and puts
the choice on the record. `bookend` and `forward` land in 0.3; until then they are
rejected loudly, never silently downgraded.

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
- **A stalled review is a decision, not a failure.** When review will not converge but
  your type-check and tests are green, the task halts as `needs_decision`: the
  deterministic gate says shippable, the probabilistic one is stuck, and that call is
  yours. Accepting is one flag — `land: ["<taskId>"]` — and the proven worktree commits,
  verifies, and merges with nothing re-implemented.
- **Decisions are reported.** Every judgment call the implementer makes (say,
  widening a parameter type) lands in the report with the reason and the rejected
  alternative. You review decisions, not just diffs.
- **Models are routed, then escalated.** A cheap classify pass sends trivial tasks to
  Sonnet and the rest to Opus. If review findings persist past round 2, or any P0
  appears, the fix model escalates automatically. Override with `model:` or `modelTier:`.
- **Spending has a ceiling.** `budgetTokens` on `camus-feat` is checked at every task
  boundary, and once more after the final task before integration, against per-task
  totals that persist across resumes. Past the cap the run halts as a question —
  continue with a higher budget, or stop here — never a silent overrun.
- **Costs are stated honestly.** `camus watch` prices the Claude side of a live run at
  the published API rate card, labeled as an estimate, never an invoice. The Codex
  review settles in your ChatGPT plan credits, and Camus does not fabricate a dollar
  figure for it.
- **Interrupted runs resume.** `camus resume` lists interrupted feats with their
  exact original arguments. Finished tasks skip; the unfinished one re-runs.
- **Hand-landed work is recorded, with git as the witness.** `camus reconcile <taskId>
  --commit <sha>` marks a task you finished yourself — refused unless that commit
  actually exists on the feat branch. Reconciling the last open task sets the feat
  `integration_pending`, so a re-run still finishes with the integration verify;
  reconcile never fakes a done.
- **Stranded proven work has a command, not a JSON edit.** When a halt names a task
  whose branch holds reviewed, unmerged commits (a self-audit catch, a blocked merge),
  `camus land <taskId>` authorizes the auto-land lane — refused unless the branch
  really holds unmerged work, recorded on the audit trail with your reason. The next
  re-run merges it mechanically; deterministic verify still gates.
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
- **"Running" must mean running.** Every phase touches a heartbeat file under
  `~/.camus/feats/`, so `status` and `watch` show `last heartbeat Xs ago` and warn
  loudly when a "running" feat has been quiet for over 10 minutes. The board also names
  the active posture in its header, counts the findings each ◈ task deferred to you,
  and keeps a token rollup that survives resumes. Pause hints are shaped to their
  stage — a posture pause says resume with `posture:"…"`, a budget pause names
  `budgetTokens`.
- **Review speed: prune codex's MCP servers.** Every review spawns a fresh
  `codex exec`, which initializes every MCP server in `~/.codex/config.toml` —
  including ones that fail auth or spawn through `npx`. On a measured setup,
  disabling unused servers cut trivial-call wall time ~35% and silenced startup
  errors (the token cost of MCP tool definitions is small — the win is latency
  and noise). Set `CAMUS_CODEX_DISABLE_MCP="<id>,<id>"`, or `all`, to disable them
  for the review lane only: a review needs the repo, not your toolbelt, and your
  interactive codex config stays untouched. It works per server because blanking
  the whole table does not — codex config tables merge. Details in the levers
  table below.

## Environment levers

One reference for every knob. Each defaults off or safe, so with none set the gate
runs exactly as documented above. The codex levers touch only Camus's review
invocation; your interactive codex config is never modified.

| Variable | What it does | Default |
| --- | --- | --- |
| `CAMUS_VERIFY_CMD` | the verify command when auto-detection misses your stack — include tests, not only types | auto-detected |
| `CAMUS_VERIFY_TIMEOUT` | seconds before a verify run is killed; raise for cold compiled builds | `600` |
| `CAMUS_PREP_TIMEOUT` | seconds for dependency prep in a fresh worktree | `600` |
| `CAMUS_CODEX_ARGS` | extra codex CLI args; replaces the dynamic-effort default — the levers below exist so you rarely need this | dynamic effort |
| `CAMUS_CODEX_TIER` | pin the review lane's service tier (e.g. `standard` — eligible plans default to fast at 2.5x credits) | unset |
| `CAMUS_CODEX_LIGHT_MODEL` | a cheaper model for medium-effort rounds only; escalated rounds always run your full model | unset |
| `CAMUS_CODEX_DISABLE_MCP` | comma-separated server ids, or `all` — disable MCP servers for the review lane only | unset |
| `CAMUS_REVIEW_IDLE_S` | event-silence seconds before the watchdog kills a hung review (retried as infra) | `360` |
| `CAMUS_REVIEW_DIR` | where review verdicts and event-stream audit dirs land | `~/.camus/reviews` |

## Layout

```
camus/
  bin/camus.js            # CLI; thin dispatcher over install.sh + the gate scripts
  install.sh              # install / check / auto-setup / env-check
  merge_settings.py       # permission-profile merger (preserves your settings)
  workflows/
    camus-loop.workflow.js   # one task
    camus-feat.workflow.js   # ordered task list as one feature
    camus-plan.workflow.js   # raw request → quality-gated task list (optional pre-step)
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

Then `/camus-feat` with your task list (add `posture:"oneshot"` for one-review speed
on work you trust), or `/camus-loop <one task>`. The feature report lands in
`~/.camus/reports/<featId>.json`. The branch is left for you to merge.

## Tests

Pure stdlib, no network, no dependencies. 656 assertions across 19 suites:

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
