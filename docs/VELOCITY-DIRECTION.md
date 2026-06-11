# Camus — Velocity Direction (post-run ideas, 2026-06-11)

**Status:** Direction note (not yet built) · **Source:** Mateo, after the LinkedIn feat runs 1–5
**Target:** 0.2.5+ — nothing here goes into 0.2.4, which is feature-complete and staged for publish.

The three ideas, verbatim (es):

> 1. hacer el codex review solo al inicio y al final de todo, pa que haga un one shot, no en todo
>    el loop, this can be a setting
> 2. revisar qué pasa con la respuesta de codex, me mama todo y es lento — y considerar más modelos
>    además de codex, y que el classifier sepa escoger
> 3. ¿Podemos ser optimistas absurdistas en el sentido que siempre moviéndonos adelante, aunque se
>    deje un review fuerte al final que no manejemos nosotros? Priorizar velocidad a calidad de
>    cierta forma — nunca se alcanzará la perfección, pero la sabiduría está en saber detenerse.

Ideas 1 + 3 are one family of features (a **review posture** dial). Idea 2 is a
**reviewer abstraction** (multi-vendor backends + classifier routing). Idea 3 is also the brand:
the tool is named Camus — *one must imagine Sisyphus happy* — and "la sabiduría está en saber
detenerse" is the product thesis said out loud. (It's also website copy. Use it.)

---

## 1. Review posture — `posture: full | oneshot | bookend | forward`

**Naming note (audit-driven polish):** the max posture was first called `gate` — renamed to
`full`, because *the gate* is the system-level invariant every posture keeps (deterministic verify
+ cross-vendor review somewhere in the flow). Naming one posture "gate" implied the others were
ungated — the exact wrong message. Postures describe **review cadence**, never gate presence.
(`forward` was also considered for a rename; kept — it is the literal "siempre moviéndonos
adelante", and reads as direction, not as the verb.)

| Posture | Start review | Per-task review | Final review | Who handles final findings |
|---|---|---|---|---|
| `full` (default, today) | — | review↔fix rounds up to `roundCap` | — (per-task review was the probabilistic gate) | camus (the loop) |
| `oneshot` | — | ONE review + ONE fix, no re-review | — | camus (one fix pass), then human via report |
| `bookend` (literal "inicio y final") | ONE plan/task-list review before coding | none | ONE strong integration review over the whole feat diff | **the human** — findings land in the report; camus does NOT loop on them |
| `forward` (the absurdist-optimist) | none | none | ONE strong integration review over the whole feat diff | **the human** — findings land in the report; camus does NOT loop on them |

One-line taglines: `full` — maximum review, the loop earns every merge twice. `oneshot` — one
opinion, one repair, verify decides. `bookend` — judge the plan going in and the result coming
out, stay out of the middle. `forward` — verify is the floor, momentum is the strategy, the human
reads the final review.

`bookend` captures the literal shape of idea 1: Codex is used at the beginning to pressure-test the
plan/task list, and at the end to judge the integrated result, but it is not inside the per-task
loop. `forward` is the more radical speed posture from idea 3: trust deterministic verify as the
floor while moving continuously, then hand one strong final review to the human.

### Final-review outcomes (audit P1 — define BEFORE building bookend/forward)

A deferred review must never let a run *feel* passed while risk was deferred. The final
integration review maps severity → status explicitly, reusing existing semantics wherever one fits:

| Final review result | Feat status | Semantics |
|---|---|---|
| no P0/P1/P2 findings | `done` | Clean — same meaning as today. P3s recorded as always. |
| P1/P2 findings | **`done_with_findings`** (new) | Work is merged and deterministically green, but NOT fully reviewed-clean. Findings land verbatim in the report with `resolution: "deferred_to_human"`. Status board renders distinctly (e.g. `◈`) — never plain ✓. |
| any P0 | `needs_decision` | Feat-level decision (see resume semantics below). The feat branch must NOT be treated as shippable until a human decides accept / fix / discard. |
| reviewer failed to run (nonzero exit, empty/malformed output, schema-invalid, timeout) | **`review_infra_failed`** (new) | Infra failure ≠ findings — the same Hard Rule #2 that governs per-task review. Retried with backoff first (existing INFRA_RETRIES discipline); after retries it is NON-TERMINAL: never `done`, never `done_with_findings` (that would convert "we couldn't review" into "reviewed"). In bookend/forward this review is the ONLY probabilistic gate, so an unreviewed feat must read as review debt UNPAID, not paid. |

`review_infra_failed` resume: the feat persists the final review as its own pending step (mirror of
`ready_to_merge` thinking — persist progress before the risky step). Re-running with the same args
skips the done tasks and re-attempts ONLY the final review — fix the codex env/auth and re-run;
the work itself is already merged and deterministically green, so nothing else re-runs.

Invariant: `done_with_findings` is a TERMINAL status for camus (it does not loop on the findings —
that is the posture's contract) but a NON-TERMINAL status for the human: the report says what was
deferred, severity-sorted, with file:line quotes (ground-the-deviation applies to the final review
too).

#### Final-review `needs_decision` — resume semantics (feat-level, NOT task land)

A final-review P0 arrives AFTER tasks merged into the feat branch — task-level machinery (worktree
land, per-task answers) does not apply, and must not be shoehorned. The halt presents three
decisions; resume carries one back (dedicated arg, e.g. `finalDecision: {action, reason}`):

| Decision | What camus does |
|---|---|
| `accept` | Record the P0 + the human's reason in the decisions log; final status `done_with_findings` with `resolution: "accepted_by_human"`. The branch is shippable by human decree — with eyes open, on the record. |
| `fix` | Append a REMEDIATION TASK to the feat, auto-spec'd from the P0 finding(s) (file:line quotes included). It runs through the FULL loop (worktree cut from the feat branch tip, codex review — a P0 fix is exactly what the gate exists for), merges, then the final verify AND final review re-run. The review debt is re-judged, never assumed paid by the fix. |
| `discard` | Terminal `aborted_by_human`. Camus never merges to base, so there is nothing to git-revert — the feat branch simply remains unshipped, kept for forensics; the report records the P0 as the reason. |

This reuses the EXISTING needs_human halt/resume transport (state + answers threading), but the
decision vocabulary and its mechanics are feat-level and explicit — `fix` is the only path that
loops, and it loops as a normal gated task, not as a special case.

### `oneshot` honest-report semantics (audit P2)

`oneshot` emits `done` ONLY when its single review came back clean. When the review found blocking
findings and the one fix pass ran: the report preserves (a) the ORIGINAL findings verbatim, (b) the
fix agent's claimed resolution per finding, (c) the deterministic verify verdict — and the result
is `done_with_findings` with `resolution: "fixed_unreviewed"`, never "review clean". The phrase
"review clean" is reserved for an actual clean reviewer verdict in every posture.

### `bookend` plan-review contract (audit P2)

The start review is NOT the code-diff review pointed at a plan. `codex_review.sh` +
`sev.schema.json` are diff-oriented; the plan review gets its own prompt + schema with plan-native
finding kinds: `oversized_task`, `ambiguity`, `unsafe_ordering`, `unverifiable_acceptance`,
`missing_file_scope`, and a verdict of `plan_ok | plan_revise`. It runs through the same reviewer
backend/adapter mechanism (cross-vendor, infra-guarded) — `/camus-plan`'s existing critique step is
the same-vendor embryo of this; bookend promotes it to a cross-vendor contract.

**Start-review state machine** (same shape as the final-review table — no unnamed states):

| Plan review result | What happens | Status if it ends here |
|---|---|---|
| `plan_ok` | Proceed to tasks. Plan findings of record (if any P3-grade notes) land in the report. | — (run continues) |
| `plan_revise` | The planner revises the plan against the findings and the review re-runs — up to **`planReviseCap` (default 2)**. Plan loops are cheap (no code exists yet) but still capped: wisdom-to-stop applies at the bookend too. | — (loops, bounded) |
| `plan_revise` with the cap exhausted (unresolved plan findings) | `needs_human` — the cheapest possible HITL moment (zero code written). The unresolved findings are presented; the human decides: proceed-with-plan-as-is (recorded as a decision), reshape the request, or abandon. Resume threads the answer like any needs_human answer. | `needs_human` |
| reviewer failed to run (empty/malformed/schema-invalid/timeout) | Retried with backoff (INFRA_RETRIES); then **`plan_review_infra_failed`** — non-terminal, never silently proceeds to coding (in bookend the start review is half the posture's value). Resume re-attempts ONLY the plan review; nothing else has run yet. | `plan_review_infra_failed` |

**Invariants that hold in every posture — these are the moat, not knobs:**

- **Deterministic verify is never skippable.** Every task still passes tsc/lint/tests before merge;
  `forward` trades *probabilistic* review depth for speed, never the deterministic floor. Moving
  fast is allowed because the floor is fixed.
- **The posture is loudly visible** — in the run log, status board, and report header. A speed
  posture must never silently impersonate the full gate; the gate is the product.
- **P0 asymmetry.** If the final `forward` review surfaces a P0, that's not a "human can decide
  later" item — pause as `needs_decision` and resolve through the **feat-level `finalDecision`
  machinery** (accept / fix-as-remediation-task / discard — see Final-review `needs_decision`
  resume semantics). NOT task-level land mode: tasks are already merged by then.
- **No posture may report plain `done` while deferring risk.** Deferred P1/P2 findings always
  surface as `done_with_findings` (see Final-review outcomes) — the speed postures buy time, never
  silence.

Why this is cheap to build: `oneshot` is a small camus-loop change (review once → fix once →
verify; skip re-review). `bookend` promotes `/camus-plan`'s critique step to a cross-vendor
plan-review contract (own schema — see above), then adds one feat-level integration review.
`forward` is the same final review minus the start review. The integration *verify* step already
exists to hang the final review next to, and the report already has a findings section.

"Knowing when to stop" is already half-built — `roundCap`, stuck-finding early-stop, confidence
trend (advisory), verify arbitration, task-level `needs_decision` + land mode. Postures extend the same
philosophy from *stop the loop* to *don't enter the loop*.

## 2. Reviewer abstraction + routing

- `codex_review.sh` becomes the **codex backend** of a thin reviewer interface: any CLI that can
  take the same review-prompt + diff and emit `sev.schema.json` findings qualifies (`adapter.py`
  already normalizes/infra-guards — that layer is backend-agnostic by design).
- **Cross-vendor invariant:** the reviewer must not share the implementer's vendor. Claude never
  reviews camus's Claude-implemented code; Codex / Gemini / others can. "No agent grades its own
  work" survives multi-backend — it's the constraint the router enforces, not a codex-ism.
- **Classifier routing** generalizes what dynamic effort already does: trivial tier → fast/cheap
  reviewer+effort; complex tier or P0-history → strongest reviewer at high/xhigh. Same escalation
  signals, now choosing vendor+model, not just effort.
- **Benchmark gate (audit P2): routing ships only after measurement.** A candidate backend joins
  the router only after a real-diff benchmark against codex on: wall-clock time, false-positive
  rate, true-bug catch rate (seeded known bugs), output parse reliability (schema-valid rate over
  N runs), and cost. No benchmark win → the classifier does not get the choice; a router nobody
  measured is complexity without a payoff.
- Config: `reviewer: codex` default; `CAMUS_REVIEWER` env override; per-run arg later.

**Codex-latency investigation (the "me mama todo y es lento"), current state:** the known causes
are recorded in the speed-levers memory — xhigh ambient reasoning (fixed: dynamic effort
medium→high→xhigh), buffered non-streaming `--output-schema`, agentic exploration beyond the diff,
no exec fast-lane (as validated on codex-cli 0.137.0; re-check on upgrades). Remaining levers, in
order: (a) the **lighter-review knob** — instruct the reviewer to judge the diff primarily and
explore surrounding code sparingly (pairs naturally with `oneshot`); (b) **benchmark a second
backend** (gemini CLI) on a real diff for wall-clock + finding quality before wiring routing;
(c) keep medium as the default effort and let escalation buy depth only when stakes demand it.

## 3. Posture selection — classifier recommends, human confirms

The posture should not be a knob the user must study; the classifier already rates every task's
tier, so it can RECOMMEND a posture for the run — but a recommendation that silently reduces
review depth would be the moat eroding itself. So the selection contract mirrors the existing
HITL policy dial:

1. **Explicit wins, no ask.** `posture` set in args (or the user states it in the request) → used
   verbatim, logged, never re-asked. The user marking a desire IS the consent.
2. **Recommended + asking policy → ONE confirm at start.** Posture absent under
   `ask_on_ambiguity`/`ask_on_major`: the classifier proposes (with the why and the trade made
   explicit, e.g. "all 3 tasks trivial, small diffs → `oneshot`: review touches 6→3, est. ~half
   the review wall-clock; deterministic verify unchanged") and the run pauses ONCE via the
   existing `needs_human` machinery. Resume threads the choice back like any answer.
3. **Recommended + `autonomous` → conservative apply + log.** No ask (autonomous never asks):
   apply the recommendation ONLY if it is `full` or `oneshot`; `bookend`/`forward` are never
   self-selected without a human in the loop. The choice + rationale land in the always-on
   decisions log.

Classifier guardrails (the recommendation logic itself):

- Any task classified `complex` → recommend `full`. Speed postures are for work the classifier
  is confident about; uncertainty buys MORE review, not less.
- All tasks `trivial`/`standard` and the feat is small → may recommend `oneshot`.
- `bookend`/`forward` are recommended only when the USER's request signals speed-priority
  ("quick", "draft", "spike", "move fast") — and still confirmed per rule 2.
- When unsure → `full`. The default posture is the conservative one, always.

## 4. Sequencing (proposed)

1. **0.2.4 ships first, unchanged** — it already carries the decision machinery these ideas lean on.
2. **0.2.5a:** `posture: oneshot` (loop-level; small, well-testable) **including the honest-report
   semantics** (`done_with_findings`, `fixed_unreviewed` — the status work is part of the posture,
   not a follow-up).
3. **0.2.5b:** reviewer backend interface with codex as the only built-in (pure refactor, no
   behavior change) + lighter-review knob + posture recommendation/confirm flow (§3 — it matters
   from the moment two postures exist).
4. **0.3:** `bookend` / `forward` postures — final-review outcome statuses (§1) + plan-review
   contract (§1) land here as their prerequisite — then a second reviewer backend if the gemini
   benchmark earns it (§2 benchmark gate), then classifier routing across backends.
