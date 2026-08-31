# Camus

**A local control plane for bounded AI-made code.**

**New in 0.4.16:** `camus build --inspect RUN_ID [--json]` is
provider-free and read-only. It authenticates the shared CLI/Studio checkpoint,
reports bounded state and evidence standing without the candidate diff or raw
model/verifier output, and gives one conservative next action. It never retries
uncertain work, extends a budget, accepts or lands a candidate, or mutates the
run. File-action builds also park after seven consecutive discovery-only steps
without a candidate mutation; use a narrower contract or a native harness for
genuinely broad repository discovery. Structured maker output, bounded safe reads,
hash-bound replacement, and owned-process cleanup harden the same loop.

**New in 0.4.15:** npm releases are tag/main/version-bound and publish through
trusted GitHub OIDC with SLSA provenance. The packaged CLI never executes a
mutable `~/.claude` script override, and verifier-private homes are removed on
every terminal path. See the [supply-chain audit](https://github.com/mateodaza/camus/blob/main/docs/SUPPLY-CHAIN-AUDIT.md).

**New in 0.4.12:** `camus code-eval` retains v1a native smokes and adds one
bounded v1b same-model raw/native pair. Each invocation may run only the
counterbalanced next cell with fresh consent; summaries are case-only and cannot
name a winner or mutate routing, admission, Git, or publication state. See the
[coding-seat guide](https://github.com/mateodaza/camus/blob/main/docs/INDEPENDENT-CODE-SEATS.md#bounded-harness-evidence-experimental).

**New in 0.4.11:** `camus code-eval fixture --case` adds a deterministic
balanced repair case, and candidate integrity now refuses any edit outside the
fixture's declared solution files before verification. The evaluator still runs
only one native smoke cell and has no comparison, ranking, routing, admission,
Git-landing, or publication authority. See the [coding-seat guide](https://github.com/mateodaza/camus/blob/main/docs/INDEPENDENT-CODE-SEATS.md#bounded-harness-evidence-experimental).

**New in 0.4.9:** the [Productive Loop](https://github.com/mateodaza/camus/blob/main/docs/PRODUCTIVE-LOOP-PLAN.md)
adds bounded repair, shared CLI/Studio recovery, CLI connection setup, and explicit
native Codex/Qwen Code/Grok Build maker executors. Run `camus build --help` for
`--setup`, `--qualify`, `--status`, `--stop`, `--resume`, bound answers and budgets.

**New in 0.4.8:** `camus build` uses the same separately selectable maker and
reviewer selection as Studio's Flexible Build. Run `camus build --help` and
`camus models` to see the command and this machine's catalog. Reversed, same-model,
and qualified OpenAI-compatible combinations produce an isolated candidate with
advisory review and a human checkpoint; they cannot automatically commit, merge,
publish, or gain gate admission. `camus run` retains the native gate below.
See the [coding-seat guide](https://github.com/mateodaza/camus/blob/main/docs/INDEPENDENT-CODE-SEATS.md).

No agent grades its own work. On the admitted proof-gate path, Camus can carry a
task toward a verified commit: Claude writes the code, Codex (a competing model)
reviews each candidate, and your repo's own type-check and tests have the final
word. When that path cannot continue safely, it stops with a named human decision
instead of inventing success. Nothing in the loop, Claude included, can approve
itself. The pairing is the point.

For native proof-gated work, `camus start` creates a feature from
JSON without a model turn, and `camus run` gives one kernel-owned worktree to a durable
Claude Code background session, invokes the independent reviewer directly, and lets code
perform every mechanical transition. The three Claude Code workflows remain available for
compatibility: `/camus-plan` turns a raw request into a quality-gated task list,
`/camus-loop` takes one task, and `/camus-feat` ships an ordered task list. Formerly Nightcrawler
v2; v1 remains archived at [mateodaza/nightcrawler](https://github.com/mateodaza/nightcrawler).
Full design: [`CAMUS-SPEC.md`](https://github.com/mateodaza/camus/blob/main/CAMUS-SPEC.md).

> **0.4.11:** bounded native-smoke evidence now includes simple and balanced
> fixtures plus a mechanical candidate-edit boundary. It preserves failed and
> uncertain paid cells and cannot promote a model or land work. See the
> [0.4.11 release notes](https://github.com/mateodaza/camus/blob/main/docs/RELEASE-0.4.11.md).
>
> **0.4.12:** one closed v1b campaign can now run the exact same model through
> raw file actions and its native harness, one fresh-consent cell at a time.
> Counterbalanced scheduling, crash-safe receipts, exact route/custody evidence,
> and conservative case-only summaries cannot promote or route a model. See the
> [0.4.12 release notes](https://github.com/mateodaza/camus/blob/main/docs/RELEASE-0.4.12.md).
>
> **0.4.15:** npm publication now uses short-lived workflow OIDC and emits SLSA
> provenance. Two concrete Socket findings were remediated without disguising
> Camus's intentional process and network surfaces. See the
> [0.4.15 release notes](https://github.com/mateodaza/camus/blob/main/docs/RELEASE-0.4.15.md).
>
> **0.4.16:** Flexible Build adds provider-free authenticated inspection and a
> more reliable bounded file-action protocol without changing model admission or
> routing. See the
> [0.4.16 release notes](https://github.com/mateodaza/camus/blob/main/docs/RELEASE-0.4.16.md).
>
> **Existing native infrastructure (introduced in 0.4.7):** The Hybrid Kernel can evaluate a Studio-configured Grok, Qwen,
> or other OpenAI-compatible reviewer on the exact code candidate before Codex performs the final
> gate. External verdict, identity, latency, available usage, and agreement become local A/B
> evidence under a signed `trial1:` identity; they cannot authorize a commit. Claude background
> sessions persist independently of the launching terminal and use Claude subscription quota;
> the driver adopts them after interruption. An append-only local eval ledger supports sequential
> A/B assignment of model pairings. Arms must clear deterministic verification plus independent
> clean review before latency or token pressure can influence routing. This release adds the
> versioned reviewer contract and exact-match dispatcher needed to evaluate more reviewer types.
> This release adds the formal, resumable Slice G campaign, human-owned exact admission registry,
> and evidence-gated opt-in task-class router on top of that shadow route. The registry ships empty
> and no route is active;
> the legacy workflows remain available for compatibility.
> [Read the release evidence.](https://github.com/mateodaza/camus/blob/main/docs/RELEASE-0.4.7.md)

> **Reviewer boundary in 0.4.7:** production routing remains exactly Claude → Codex.
> `qwen_code`, `grok_cli`, and `http_openai_compat` are recognized candidates but fail closed as
> `reviewer_benchmark_disabled` until Slice G evidence earns admission. The HTTP candidate is
> available to the benchmark harness with schema-constrained streaming, bounded custody,
> qualification/lineage binding, credential-rotation detection, and typed tunnel failure. An
> implemented candidate is not a supported reviewer yet.
> See [`docs/SLICE-F-STATUS.md`](https://github.com/mateodaza/camus/blob/main/docs/SLICE-F-STATUS.md).

> **External-model trials in 0.4.7:** `camus models` lists local reviewer profiles without exposing
> endpoints or secret values. `camus run --shadow-reviewer-backend <profile>
> --shadow-reviewer-model <id>` runs the selected model before Codex on each candidate. Trial
> infrastructure failure is visible and has no provider fallback; Codex closure and deterministic
> verification remain mandatory. Experiment arms may pin the three `shadowReviewer*` fields, but
> those experiments are `explore`-only and never promote a reviewer.

> **Responsible control plane in 0.4.7:** every governed review records separate input,
> action-authorization, and output-screen evidence against a checked-in versioned register.
> Missing or version-skewed evidence fails closed; provider refusal, Camus policy refusal,
> reviewer rejection, infrastructure failure, and human escalation stay distinct. Control
> receipts are mutable completion records beside the immutable evidence pack and reject
> credential-shaped diagnostics. The Slice G offline harness can append content-addressed
> attempts and derive conservative admission statistics, but it cannot call providers or enable
> a backend. See `skills/camus/BENCHMARK.md`.

```
plan → implement → [ Codex review ↔ fix ]* → commit gate → dep prep → verify
       full posture: loops while P0/P1/P2 findings remain, round cap 3
       oneshot posture: one review, one repair, no re-review — verify still decides
```

## Native proof-gate requirements

Experimental `camus build` instead requires Node 18.17+, Git and the selected
backends' authentication. It does not require Claude, Codex or Python when neither
selected seat uses those CLIs. Configure and qualify external roles in Studio or
use the CLI setup path for the same underlying controls without a server.
The requirements below apply to `camus run` and the compatibility workflows.

- **Claude Code** v2.1.154+ with dynamic workflows, on a subscription plan.
  Independent Build seats that select Claude require a current CLI with
  `--effort` support (verified with v2.1.251+); an older CLI is refused before
  model-call accounting and should be updated.
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

**A killed review is resumed before it is re-paid.** Every Codex thread announces its session id
in the event stream, so when a round's prior attempt was idle-killed or abandoned, the next
attempt runs `codex exec resume <thread_id>` to finish that same thread for one short turn
instead of paying for a whole fresh review. It falls closed to a fresh review whenever resume
can't produce a verdict — no recorded thread id, a non-zero exit, or an empty result — so the
worst case is exactly today's behavior, never a new failure mode.

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
- A **merge receipt** cross-checks every merge report against the verdict `merge.sh`
  wrote to disk as it computed it. A runner that hand-resolves a conflict the script
  refused — and relays success — produces a divergence the feat halts on, with the
  receipt's pre-merge SHA as the reset target. Ancestry checks can't catch a hand-merge;
  the script's own testimony can.
- A **verify integrity snapshot** makes a gating verify certify the *committed* state:
  any tracked-file change present before or appearing during verification turns the
  verdict red with the files named. An agent that "fixes" the code under verification
  can no longer buy a green — tampering became worthless, not just detectable.

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
the choice on the record. Only `full` and `oneshot` are recognized; unsupported
postures are rejected loudly, never silently downgraded.

## Autonomy controls

- **The host owns orchestration.** `camus start spec.json` initializes canonical feature state
  without asking a model to write JSON or run Git. `camus run <featId>` polls durable Claude
  background sessions, calls the direct independent reviewer, verifies, seals, and lands through
  the kernel. A small controller model is called only at a real semantic fork: fix and re-review,
  fix once with explicit `fixed_unreviewed` provenance, retry a failed verifier, or stop for a
  human. It never executes Git or rewrites state.
- **Every task becomes an eval episode.** `~/.camus/evals/episodes.jsonl` records content-free
  task/model identities, outcome, transcript hashes, end-to-end wall time, and available usage.
  `camus eval` summarizes it. The ledger does not store prompts, diffs, or credentials, and its
  operational score is not represented as human calibration.
- **A/B testing learns by task class.** `camus run --experiment experiment.json` balances real
  tasks across at least two pinned model-pairing arms until every arm reaches `minimumTrials`.
  Only arms above `qualityFloor` become eligible for lowest-latency/token selection. Failed and
  interrupted work remains evidence; a cheap failure never wins. Studio continues to own
  parallel same-input comparisons, while CLI uses sequential assignment to avoid paying twice for
  every real feature.
- **Shadow reviewers accumulate admission evidence safely.** A Grok/Qwen/open-weight profile can
  inspect the same diff immediately before Codex. The ledger records its usable-trial coverage,
  verdict agreement, latency, and available token use per arm. Because Codex—not a human-labelled
  calibration set—supplies the comparison, `camus eval` calls this evidence only, suppresses a
  shadow leader, and refuses route mode.
- **Eval reporting fails closed by generation.** `camus eval` groups evidence by the exact
  `(experiment id, configHash, taskClass)` tuple. Without the matching config it reports observed
  coverage but no leader. Configured arms with no trials remain visible at `n=0`, and records from
  changed configs or task classes are never pooled into a complete-looking result.
- **Native orchestration overhead is visible per arm.** Each arm reports `medianModelWallMs` (median
  measured background maker/controller time) alongside `medianWallMs`, and
  `medianOrchestrationOverheadMs` — the median of each episode's
  `max(0, wallMs - modelWallMs)`, the observed orchestration gap around that background model work.
  The gap includes independent-review time as well as deterministic host control; it is not a claim
  that every millisecond was kernel CPU time. Overhead is computed only for episodes that carry both
  raw timings and, when native coverage is declared, complete background-session timing. An episode
  missing either side or declaring incomplete measurement contributes to neither median (no imputed
  zero), and impossible raw evidence
  (`modelWallMs > wallMs`) floors at zero rather than reporting negative overhead. Both medians are
  `null` when no episode supplies the required pair. The text report shows them as `model=` and
  `overhead=`. These are reported evidence only: arm ranking stays quality-first, then `medianWallMs`,
  then `medianOutputTokens` — overhead never reorders arms.

- **Plan it first (optional).** `/camus-plan "<request>"` reframes a vague or large
  request into a quality-gated, ordered task list before any code is written: it grounds
  in your repo, asks when genuinely ambiguous, designs the change, decomposes it to camus
  standards (right-sized, baseline-green between tasks, explicit acceptance criteria), then
  has an adversarial reviewer score the plan. It writes a plan file you review and edit,
  then run with `camus-feat`. Better plans converge in fewer review rounds.
- **Zero-click runs.** `camus auto-setup` installs a narrow permission profile: one
  egress trust line for the review diff, plus allow rules for the six gate scripts.
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
- **Native direct-output admission is conservative.** `camus run` reserves
  `max(10,000, 25% of budgetTokens)` direct-output tokens before each maker/fix; pass
  `--direct-output-reserve 0` to disable that admission reserve. Claude background sessions do
  not expose a per-turn output cap, so an in-flight turn can still overshoot; the post-receipt
  ceiling stops every later model call and records the exact overage.
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
- **You can watch it.** `camus watch` is a live terminal dashboard: per-task board,
  the last 10 steps, review rounds, and tokens, auto-refreshing. `camus status` is the
  one-shot version. _(Live steering — `watch`'s `p`/`g`/`c` keys and
  `camus steer "<guidance>"`, which scripts the same notes — is EXPERIMENTAL and
  opt-in: a feat consumes steer notes only when run with steering enabled.)_
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

## Operate for the solution

Camus is custody around capable agents, not a reason to micromanage them. Give the maker
freedom over implementation details inside the acceptance contract, then let the host-owned
signals—processes, worktree state, receipts, and deterministic verification—decide whether
the run remains trustworthy.

- Use the direct skill for terminal-native work; use Studio when visual supervision,
  human questions, comparison, or verification-only recovery materially helps.
- Preserve the complete contract. Studio may progressively disclose fields, but it must
  not narrow what the gate can express.
- Interrupt immediately for a false receipt, custody breach, orphaned process, ignored
  round cap, or work outside the declared scope.
- Do not interrupt merely because a model chose a different sound implementation, a phase
  is taking an honest amount of time, or a non-blocking UX improvement became visible.
- Prefer the bounded result. `done_with_findings` means the final repair passed deterministic
  verification but was not re-reviewed; inspect the preserved findings and claimed
  resolutions instead of sending it through an unbounded loop.
- After the run, use `camus retro` to collect recurring friction. Recommendations remain
  read-only; the next real feature—not an invented benchmark feature—proves the improvement.
- Use `camus benchmark append|summarize` only for a predeclared Slice G campaign. All attempts,
  including disclosed reruns and invalid provider output, remain in the denominator; a passing
  report says only `eligible_for_human_admission` and never edits production routing.

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
npm i -g camus-cli@0.4.16
camus install        # copy skill + workflows into ~/.claude (a frozen copy, not a symlink)
camus check          # exit 0 = installed matches package. Run before every auto run.
camus env-check .    # will this repo's toolchain actually run? (node version, deps)
camus auto-setup     # optional: the zero-click permission profile
```

Create a native run from a small JSON file:

```json
{
  "feat": "Add bounded export support",
  "tasks": [
    "Implement the export contract and focused unit tests.",
    "Add integration coverage and update operator documentation."
  ],
  "targetPath": "/absolute/path/to/repo",
  "model": "claude-opus-4-8",
  "roundCap": 3
}
```

```bash
camus start feature.json       # returns the deterministic featId
camus run <featId>             # Opus 4.8 maker, Sol reviewer by default
camus eval                     # local quality / speed / usage evidence
```

List configured external reviewer profiles and run one safely behind Codex:

```bash
camus models --reviewers-only
camus run <featId> \
  --shadow-reviewer-backend xai \
  --shadow-reviewer-model grok-4.6 \
  --shadow-reviewer-effort medium
```

At a native controller handoff, an operator can skip the next advisory review while
authorizing a bounded repair and fresh Codex review. For a handoff after round 2:

```bash
camus run <featId> --human-action fix_recheck --round-cap 3 \
  --skip-shadow-review "Finish the correctness repair before more advisory comparisons"
```

The reason is saved atomically with the bound operator decision and survives resume.
Only that next round is skipped; existing shadow receipts and the frozen pairing are
preserved. A skip is recorded as non-comparable, not as a review or a clean result.
Codex and deterministic verification remain mandatory. This is not a way to interrupt
an active/pending shadow request or skip an authoritative external reviewer.

New Claude receipts count cumulative usage once per message ID, including multipart
transcripts. Replaying an older sealed receipt preserves its original accounting;
parser improvements do not silently migrate history. These counts are usage telemetry,
not a provider invoice.

When an operator records an `operator.repair` trace event for manual or helper-agent
edits, that task's episodes are marked operator-assisted, not autonomous successes.
Declared helpers remain separate from the maker identity observed in sealed receipts;
unmeasured helper usage makes timing coverage incomplete. Such episodes cannot satisfy
the autonomous routing quality floor. This intervention flag is not a human calibration
label and grants no admission standing.

The profile comes from `~/.camus/studio/models.json`; only the credential environment-variable
name lives there. Direct HTTPS, literal loopback, and fixed managed-SSH connections are supported.
The resulting `trial1:` receipt is non-gating by construction. The released 0.4.7 dispatcher
requires one exact, unexpired checked-in human admission for `http_openai_compat` and ships with an
empty registry, so every external reviewer remains benchmark-disabled outside explicit trials.

After an external reviewer earns that admission, compatibility-workflow callers must pass its
exact non-secret route snapshot: `reviewerBackend: "http_openai_compat"`, `reviewerModel`,
`reviewerProfileBackend`, `reviewerTrainingOrg`, `reviewerTransport`, `reviewerConnection`, and the
exact `reviewerQualification` fingerprint. `camus-feat` persists and forwards all seven fields.
The dispatcher independently adds the matching `admit1:` authority; a verdict without it fails
closed. Base URLs, SSH details, and credential values remain in the private host profile/env and
must never be copied into workflow args.

The preferred native driver uses the same authority. After the reviewed registry entry ships,
activate its current private credential revision without making a provider call, then pass only
the entry's exact public route values:

```bash
camus benchmark admission-activate --admission-id admit1:REPLACE_WITH_64_HEX

camus run <featId> \
  --reviewer-backend http_openai_compat \
  --reviewer-profile-backend xai \
  --reviewer-model grok-4.6 \
  --reviewer-effort medium \
  --reviewer-training-org xai \
  --reviewer-transport direct_https \
  --reviewer-connection xai-primary \
  --reviewer-qualification qual1:REPLACE_WITH_64_HEX
```

The model, effort, organization, transport, connection, and qualification values must come from
the checked-in admission; they are not free-form overrides. The native kernel resolves the
endpoint, credential variable, and optional SSH tunnel from the matching private Studio profile,
then requires the executor's receipt to return the same `admit1:` authority before sealing.

An A/B config names a task domain and complete pairings; requested model and effort values are
recorded, never silently substituted:

```json
{
  "id": "coding-feature-v1",
  "taskClass": "bounded_feature",
  "mode": "route",
  "minimumTrials": 10,
  "qualityFloor": 0.8,
  "arms": [
    {
      "id": "opus-sol",
      "makerModel": "claude-opus-4-8",
      "makerEffort": "high",
      "reviewerBackend": "codex",
      "reviewerModel": "gpt-5.6-sol",
      "reviewerEffort": "high"
    },
    {
      "id": "sonnet-sol",
      "makerModel": "sonnet",
      "makerEffort": "medium",
      "reviewerBackend": "codex",
      "reviewerModel": "gpt-5.6-sol",
      "reviewerEffort": "high"
    }
  ]
}
```

Use `camus run <featId> --experiment experiment.json`. Shadow experiments must use `explore` and
never name a routing leader; they report comparison coverage, agreement, latency, and usage for the
formal admission campaign. For ordinary admitted pairings, the safer default mode is `explore`, which
keeps assignments balanced after the minimum instead of changing routing. `route` is explicit and
requires at least ten trials per arm, every routing trial green, and exact requested and observed
maker/reviewer identities before latency or token pressure may choose an arm. Studio additionally binds
the exact requested and observed identities, current qualification fingerprints, source-run ids,
and human-calibration digest into each `route1:` decision. Route mode keeps the admitted Codex
reviewer gate unless an external reviewer has an exact checked-in Slice G admission; with the
shipped empty registry, external reviewers remain shadow evidence. Even then, promotion is local evidence for that
declared task class, never a universal model leaderboard.

Read the evidence with the same frozen config:

```bash
camus eval --config experiment.json
camus eval --config experiment.json --json
camus eval --experiment coding-feature-v1 --config experiment.json
camus eval --task-class bounded_feature --config experiment.json
```

For `camus run`, `--experiment` names a config file; for `camus eval`, it filters by experiment
ID. `--task-class <name>` filters the report to one exact scenario: both observed episodes and any
supplied `--config` context are restricted to that task class, so an unrelated config can never
seed a zero-trial segment. It fails closed on an empty name. In JSON, each `segments[]` entry is
one exact generation and task class. Interpret it as follows:

- `exploratory_only`: observed trials exist, but the matching configured floor and trial minimum
  were not supplied; `leader` is null.
- `coverage_incomplete`: the config matches, but at least one configured arm is below
  `minimumTrials`; zero-trial arms are included and `routingEligible` is false.
- `no_arm_clears_quality_floor`: coverage is complete, but quality blocks promotion.
- `routing_evidence_not_eligible`: coverage exists, but at least one otherwise eligible arm has a
  failed quality-floor trial or missing/drifted observed identity; no route is named.
- `exploratory_leader`: the configured quality-first leader is visible for learning, while
  `routingConfigured` and `routingEligible` remain false.
- `routing_leader`: route mode, complete coverage, and the quality floor all hold;
  `routingEligible` is true for this generation and task class only.

Top-level `segmented_only` means standing exists only inside `segments[]`; `mixed_generations` is
an additional warning, never an aggregate winner. `episodes` counts ledger rows in scope, while
`experimentEpisodes` counts rows carrying experiment evidence. Inspect the individual segments;
Camus will not combine their trials or standing.

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
use `npx camus-cli@latest` or install globally (`npm i -g camus-cli@latest`).

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

`camus retro` reads that history back, read-only — never a model call, never a write.
It prints a one-liner per feat (status, posture, task count, tokens), aggregates
(status/posture mix, review-rounds, per-task token p50/p90), and a few evidence-gated
observations: each needs at least three supporting data points and cites them inline,
otherwise it prints `insufficient data (N runs)` rather than guess from a thin pile. Add
`--json` to emit just the aggregate for a script. The report schema has shifted across
versions, so every field is optional — older reports without posture or token counts still
read cleanly.

## Tests

Pure stdlib, no network, no dependencies. The deterministic suite covers the CLI,
gate scripts, workflow handoffs, review custody, resume paths, and receipt integrity:

```bash
npm test    # or run the suites individually under skills/camus/scripts/
```

Codex has reviewed Camus's own adapter, guard, and workflows, and caught
real bugs each time.

## Self-test (`camus canary`)

`npm test` proves the gate's *units*. `camus canary` proves the *toolchain*: it
spins up a throwaway git repo under `$TMPDIR` and runs the real gate against it,
end to end, so you can answer "is my local gate actually working?" without a real
project.

```bash
camus canary             # free + local: RED → GREEN
camus canary --review    # also exercises the codex reviewer (one small codex call)
```

Three known-answer stages, short-circuiting on the first break:

- **RED** — a repo whose `npm test` fails by design must verify `pass:false` with a
  *named* failed check. If the verifier can't tell broken from working, nothing it
  says downstream is trustworthy.
- **GREEN** — fix the assertion, commit, and the same verify must read `pass:true`
  **and name the exact HEAD it certified** (`result.head == git rev-parse HEAD`) —
  the head-binding contract the orchestrator relies on to catch an
  edit→commit→rerun cover-up.
- **review** (only with `--review`, **off by default**) — stage a one-line diff and
  run the Codex reviewer, requiring a normalized verdict that carries the gate's
  contract keys. This is the one stage that costs a (small) codex call.

Exit 0 only when every stage holds; otherwise it prints the first broken stage with
its evidence. The throwaway repo is always torn down, including on failure.

## Boundary

Camus is for code you already trust. The verifier executes the repo's own build and
test commands; on an untrusted repo that is remote code execution. Never run it as
root. Camus may improve itself only through tasks that pass its own gates. It never
touches its runner, skill, verifier, schemas, or permissions during a run.
