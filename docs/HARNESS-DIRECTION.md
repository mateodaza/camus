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
