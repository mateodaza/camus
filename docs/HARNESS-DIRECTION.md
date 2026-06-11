# Camus — Harness Direction (run-agent feedback, 2026-06-11)

**Status:** Direction note · **Source:** the agent that drove the 8-run LinkedIn feat, after the
review-loop batch was fixed. Its through-line: *"the loop got smart, but the harness around it is
still hard to watch, hard to trust, hard to steer, and hard to stop."*
**Target:** 0.2.5+ — sibling to `VELOCITY-DIRECTION.md` (that doc is the loop's review cadence;
this one is the orchestration around it: observability, state, cost, human handoff).

## Triage against 0.2.4 (what the feedback already got)

| Item | Status at 0.2.4 |
|---|---|
| Liveness heartbeat | **Best-effort shipped, honestly labeled.** `camus watch/status` reads the agent transcripts of the REPO'S most-recent workflow run (transcripts append per message, which boundary-written state can't) and renders `last activity Xs ago` + a loud may-have-died warning past 10 min on a "running" feat. Deliberately NOT called a heartbeat: the signal is repo-level, not feat-bound — concurrent camus runs in one repo, or inspecting an older feat, can make it describe a different run, and an unreadable transcript format degrades it entirely. The first-class fix is the state heartbeat/pid below (0.2.5 item 1). |
| Phase checkpoint on resume | **Largely shipped** as `ready_to_merge` + land mode + the retry idiom: "diff is already verified, just commit" is now expressible (`land`), proven work auto-lands, done tasks skip. Remaining: resuming INTO the middle of an unproven loop (re-enter review↔fix against an existing worktree) — the parked salvage variant. |
| Verify-clean work trapped in a worktree | **Half shipped.** needs_decision + land mean it can always be LANDED on decision, and worktrees are out-of-tree/per-task (a new run collides loud rather than disturbing silently). Remaining (small, valuable): auto-COMMIT the worktree on a verify-clean `review_unresolved` halt — park the work as a labeled `review-flagged/verify-green` commit on the task branch so it survives anything. Composes with land's empty-stage path as already built. |
| Reviewer oscillation | **Adjacent shipped.** Stuck-detection catches a finding REPEATED across consecutive rounds; confidence trend catches conviction moving on the same finding. NOT caught: a finding (or verdict) that flips — appears r1, vanishes r2, returns r3, or REJECT→accept swings. `priorKeys` only holds the last round. |
| Cost visibility | **Half shipped.** Per-task tokens persist in state across resumes; watch prices the LIVE run at the rate card (estimate, never invoice). Missing: cross-run rollup per feat + a budget ceiling that halts-and-asks. |
| mark-done / reconcile | **Adjacent shipped.** Land mode covers the internal cases (uncommitted proven worktree; died mid-merge). The external case — a human committed/merged by hand and needs to TELL camus — still means hand-editing feat JSON. |
| Scope bleed | **Not built.** Task N pulling in task N+1's files needed manual steering twice. |
| Structured acceptance criteria | **Not built**, but `VELOCITY-DIRECTION.md`'s plan-review contract already names `unverifiable_acceptance` as a finding kind — this item is its enforcement half. |

## 0.2.5 build list (proposed order)

1. **State-file heartbeat + pid** (top observability gap, trivially small). The feat stamps
   `{heartbeatAt, pid?}` on every persist AND the per-task `running` persist gains a cheap
   mid-loop touch (the loop already persists at phase boundaries via the feat — stamp there).
   `status.py` then has liveness with NO transcript dependency; the transcript signal stays as
   the fine-grained layer. `running` must mean running.
2. **Park verify-clean halts as commits** (small engine change, kills the "trapped work" class).
   On `review_unresolved` + `verifyClean:true`: run the commit step before halting, message
   `chore(camus): park <taskId> (review-flagged, verify-green)`. Land's empty-stage path already
   knows how to finish from there.
3. **`camus reconcile` / `mark-done <taskId> --commit <sha>`** (CLI, no engine change): validates
   the sha exists on the feat branch (the F14c evidence check, as a command), sets the task done
   with a `reconciled_by_human` decision entry, optionally removes the worktree. No more JSON
   surgery.
4. **Feat cost rollup + ceiling.** Status: sum persisted per-task tokens + live estimate into a
   feat total. Engine: `budgetTokens` arg — past the cap, halt-and-ask (`needs_human`, "spent ~N
   of M budget; continue / stop here?"). Honest framing per the cost contract (estimate, never
   invoice).
5. **Oscillation detector** (small loop change): keep `allSeenKeys` across rounds; a finding
   returning after disappearing — or a verdict flip on the same code_location — marks the halt
   `oscillating: true` and the note says "the reviewer can't make up its mind here" → human
   decides. Composes with stuck + confidence trend (three instability signals, one decision
   surface).
6. **Scope-bleed self-healing** (the big one, design needed): at task N start, diff the live feat
   branch against task N's acceptance criteria and hand the implementer "already landed vs
   remaining." A task whose work fully landed becomes a clean no-op instead of a manual steer.
   Depends on (7) for "acceptance criteria" being machine-diffable.
7. **Structured acceptance criteria**: camus-plan emits per-task `checks[]` (grep/file-exists/
   command assertions) alongside prose ACs; verify.sh runs them; the reviewer receives the same
   checklist. "Did the audit list silently expand?" becomes a diff, not a 0.88-confidence opinion.
   This is the enforcement half of the plan-review contract in `VELOCITY-DIRECTION.md`.

Items 1–3 are small and independent; 4–5 are small-medium; 6–7 are the 0.3-grade design work and
should ride with the posture/plan-contract milestone.

## Field fixlets (confirmed live, 2026-06-11 — two production feats + the camello smoke)

What the day verified: the 0.2.4 display surfaces all render correctly (per-agent live table,
`last activity Xs ago`, the honest cost line) once `watch` runs from the repo root — the earlier
blank was cwd-only; commit/verify agents are visible live, so kill windows are observable. Every
halt class resumed (infra_error, review_unresolved at cap, needs_decision with answers, and a
human manual-landing reconciled by hand-editing feat JSON — item 3's demand, twice). The
review-loop fixes that came out of the 8-run feat (env-check range semantics incl. compound
upper bounds, reviewer sees binding human answers, `--no-verify` + `chore(camus):` commits)
shipped inside the 0.2.4 release commit.

Small items the runs surfaced, for 0.2.5 alongside the list above:

- **`camus check` honesty.** (a) Compare the INSTALL MANIFEST, not the whole tree — `__pycache__`,
  `.pytest_cache`, `.benchmarks`, `.npmignore` false-drift the check into exit 1 + "STALE" on an
  in-sync gate (running the test suite re-dirties it every time). (b) Fix the stale wording: check
  output and the camus-feat meta both still say `./install.sh`; npm users need `npx camus-cli
  install` / `camus check`. (c) Direction-aware drift: an older CLI binary checking a newer
  installed gate should say "this CLI is older than the gate," not "gate is STALE."
- **Steer/answers must fail loudly.** An unparseable guidance note was consumed-and-dropped at a
  task boundary, silently re-opening everything it was meant to prevent. Malformed guidance ⇒
  halt with "couldn't parse your guidance, re-issue it." Also: `steer.py` overwrites the pending
  note, so a second `--task` call clobbers the first — merge into the existing answers map so a
  multi-task steer is expressible from the CLI.
- **No fix without a confirmation round.** The loop dispatched a fix agent on its FINAL review
  round; the fix landed with no round left to re-review, so the halt report described an
  already-fixed worktree and forced a whole relaunch. Either stop dispatching fixes the loop
  can't confirm, or grant one extra confirmation-only round.
- **Sibling-task context for review/fix.** Per-task codex review can't see the feat decomposition,
  so it flags sibling tasks' surfaces as "incomplete" and fix agents bleed across task lanes.
  Passing the other task specs as "owned elsewhere — do not flag/touch" context is a cheap
  mitigation ahead of item 6.
- **Hygiene nits:** `-v`/`--version` alias for the CLI; `test_missing_toolchain_flagged` reads the
  session's `CAMUS_VERIFY_CMD` and fails spuriously (inject env); `watch` should print a dim
  "live agents: none visible from this directory" instead of silently omitting the section; docs
  should note npx cache skew (`npx camus-cli` resolved 0.2.0 → 0.2.2 across invocations mid-feat —
  display-only, the frozen gate is unaffected; recommend `npx camus-cli@latest` or a global pin).
  The check-honesty manifest fix also needs the new `test_*.py` source files in the installer
  exclude list (they false-drift `camus check` the same way the cache dirs do).

## Friction batch + cross-vendor research consolidation (2026-06-11, post-smoke)

Context: the camello smoke closed **3/3** — accept → land committed the capped-out task with no
re-review (2ef33e9, then merge), integration verify green; ~54 min, 69 agents, ~1.9M subagent
tokens across both runs. Two research threads ran in parallel (this session + a sibling) and
converged independently on the same design; the codex side below is verified against LIVE docs +
source (the sibling's codex agent was network-blocked, so its "verify before building" items are
now mostly resolved). Operational copies live in auto-memory; this section is the durable spec.

**The friction class and its kill, ordered:**

1. **Call-site timeout (0.2.5, one prompt edit).** `reviewerPrompt`
   (`workflows/camus-loop.workflow.js:429`) must instruct an effort-sized Bash `timeout` param on
   the FIRST call (medium 360000 · high/xhigh 600000) and forbid wrapping in GNU `timeout`
   (absent on darwin). `codex_review.sh` has no internal timeout and `codex exec` has NO deadline
   flag (doc-confirmed) — the review path is the only unhardened leg; verify/prep already bound
   via `subprocess.run(timeout=600)`.
2. **Env-facts preflight (0.2.5, small).** Extend `env_check.py` (already probes login-shell,
   node, lockfiles, toolchain) with deterministic platform facts — darwin, GNU-timeout absence,
   codex version + auth, fast-tier status — emitted as a compact block injected into the
   plan/implement/fix prompts (injection points: `camus-loop.workflow.js` ~319/365/560). Rule:
   friction that bites once becomes a deterministic check. Explicitly NO LLM "predict what could
   go wrong" preflight — speculation costs tokens every run and the r3 friction was 100%
   knowable from env facts, 0% guessable.
3. **Watchdog reviewer — BUILT 2026-06-11** (probed live on codex 0.137.0 first: `--json` +
   `--output-schema` + `-o` compose; `turn.completed` carries usage). Shape as specced, with one
   refinement: instead of `run_in_background`+Monitor, codex runs DETACHED (`review_watch.py`
   start/await/abort — own session, wrapper-file exit codes, group kills) and the loop
   re-attaches in bounded `await` chunks ({pending, handle} → up to AWAIT_CAP=6 thin calls →
   abort). Same effect, fully offline-testable: total review time unbounded by any tool call,
   liveness = event-stream silence (default 360s, `CAMUS_REVIEW_IDLE_S`), honest codex usage in
   the gate JSON + round logs. Handles are validated against the deterministic layout before
   exec (F3 discipline). Follow-up still open: `codex exec resume <id>` to recover a killed
   review without re-paying it. Probe side-finding: this machine's codex config carries
   Notion+Figma MCPs that FAIL AUTH on every exec (startup noise + ~15k input-token baseline
   per call) — user config, not camus; disabling them is a free review speedup.
4. **Belt options (doc-check hook shape before building):** `BASH_DEFAULT/MAX_TIMEOUT_MS` via the
   settings env block `merge_settings.py` already manages; a PreToolUse `updatedInput` hook
   enforcing a floor timeout scoped to `codex_review.sh` commands (current docs say PreToolUse
   can modify inputs and hooks fire inside workflow agents).

**Codex facts that change behavior (installed 0.137.0 · latest 0.139.0):**

- **`codex review` / `codex exec review` EXISTS on 0.137.0** (`--uncommitted | --base <branch> |
  --commit <sha>` + custom prompt); its mandated rubric JSON ≈ camus's existing schema (P0–P3
  findings, overall_correctness, confidence). Adoption gated on ONE empirical test: `--json`
  mode drops review items (undocumented surfacing) — test output capture vs our
  `--output-schema` prompt path before switching.
- **Profiles ≥0.134 are per-file** (`$CODEX_HOME/<name>.config.toml`); legacy `[profiles.*]`
  tables are REJECTED. Per-effort profile files are an option; user `[profiles.*]` configs break.
- **Fast tier:** the CLI has it (`/fast`, `service_tier = "fast"` + `[features].fast_mode`) and
  eligible ChatGPT plans DEFAULT ON since 0.124. Mateo's `config.toml` has no tier key → the
  ambient default governs. Action: decide deliberately; camus can pin the review lane per-call
  (`CAMUS_CODEX_ARGS` / `-c service_tier=…`) — fast is 2.5× credits on GPT-5.5.
- **Models:** gpt-5.2 / gpt-5.3-codex deprecated for ChatGPT sign-in; **gpt-5.4-mini** (">2×
  faster, ~30% of limits") is officially recommended for review-style work → ladder experiment:
  r1 mini/medium, escalate model+effort where `pickReviewEffort` already escalates effort.
- **Persistent lane (0.2.6+ experiment):** `codex app-server` `review/start` +
  `account/rateLimits/read` (programmatic credit display for `watch`) or the SDKs amortize
  startup across rounds; `auth.json` ChatGPT-plan auth works in-process.

**Ambiguity-pause under-fire (smoke evidence → joins the VELOCITY classifier work):**
`ask_on_ambiguity` was recorded in feat state yet never paused the deliberately vague task; three
review rounds re-litigated a product tradeoff (tail-only truncation vs head+tail) that a human
answers in one line (~$8 of the run's ~$11). Threshold change: classify/plan escalates when the
APPROACH embeds a user-visible product tradeoff, not only when the spec is unparseable. The
round cap then did its job (capped at 3 → needs_decision → accept → land) — the stop machinery
is sound; the pause trigger is the gap.

**Consolidated 0.2.5 insertion order:** call-site timeout + check-honesty excludes (trivial) →
env-facts preflight → watchdog reviewer (subsumes the transcript-heartbeat half of item 1 and
the codex side of item 4) → ambiguity threshold → gated experiments (codex-review adoption
test · mini ladder · tier pin). Camello-side follow-up parked for a future one-task loop run:
`boundSummaryInput` duplicated verbatim in both summarizer files.
