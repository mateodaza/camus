# Camus 0.3 — Roadmap

> **Emphasis rerouted 2026-07-12 — see [DIRECTION-0.3-TRUST-LAYER.md](DIRECTION-0.3-TRUST-LAYER.md).**
> The headline of 0.3 is executor/auditor independence with sealed, portable evidence —
> Camus surrenders choreography, keeps custody. Every trust item below survives;
> bookend/forward become audit-timing policies rather than the lead, and automatic
> routing waits for calibration data. The revised implementation order lives there.
>
> **Next direction adopted 2026-07-14 — see
> [COMPARE-AND-LEARN-DIRECTION.md](COMPARE-AND-LEARN-DIRECTION.md).** Native
> orchestrators become executor arms inside a local, evidence-bound comparison
> harness. Human authority and independent closure remain non-negotiable.

Consolidated from VELOCITY-DIRECTION.md, HARNESS-DIRECTION.md, and the 0.2.5 smoke/audit
arc (2026-06-12). Items are ordered by decided-ness, not by build order.

## Release split (decided 2026-06-12)

Version by the promise: **patch when the promise gets keeper, minor when the promise
changes.** The 0.2.x promise — claude+codex only, `full|oneshot`, a fixed report status
vocabulary — is edited by items 1 and 2 below, so they are the 0.3.0. Everything additive
ships earlier as **0.2.6** and flows automatically to `^0.2` users (npm refuses 0.3.0 on
a `^0.2` range — correct: identity changes deserve a deliberate upgrade).

- **0.2.6 (additive, soak-friendly):** the SOURCE-BOUND REFERENCES plan standard (already
  on main), `camus retro` (item 5), runtime canary (item 3), codex-resume recovery (item 4).
- **0.3.0 (the promise changes):** postures bookend/forward + final-review statuses +
  plan-review contract & launch-time materialization (item 1), opt-in multi-model backends
  behind the benchmark gate (item 2), re-review salvage (item 6 — depends on bookend).

## The design law every item must satisfy

The trust-boundary doctrine (run-6, decided 2026-06-12). Camus is a distributed
transaction manager wrapped around probabilistic agents; bugs live at the trust
boundaries, so every new phase/handoff must satisfy all five:

1. Every phase has **allowed mutations** (gate-owned mutations live inside allowlisted scripts).
2. Every handoff needs **evidence** (script-written receipts; agent relays are
   transcriptions to cross-check, never sources of truth).
3. Every crash window needs **resume semantics**.
4. Every "green" proves **exactly what state it certified** (head-bound verdicts,
   clean-tree snapshots, receipts checked against the repo).
5. Every helper agent is **untrusted around state-changing commands** — prompts state
   enforced facts, they don't plead.

A 0.3 feature that can't answer all five isn't designed yet.

## Friends-ready dogfood checkpoint (achieved 2026-08-07)

This checkpoint began as a private readiness test for Mateo and a small group of friends.
The CodenameWukong Enemies feature completed WP1–WP10, including a final bounded run that
did not require mid-run harness surgery, and its all-in-one branch reached a reviewable PR.
That evidence satisfied the checkpoint. On 2026-08-07 the release decision changed from
private dogfood to a public 0.x alpha: publish the proven build, let friends use it on real
work, and continue improving it from concrete runs rather than invented features.

The north star is **a useful solution when one can be produced safely**. Deterministic
custody, bounded review, and receipts exist to prevent false claims, leaked processes, and
lost work; they must not become ceremony that keeps capable models from completing the
task. Give the loop bounded freedom over implementation details when the acceptance
contract permits it. Stop a dogfood run immediately for a custody breach, false receipt,
ignored round cap, orphaned process, or other result-invalidating defect. Record smaller
UI/UX and efficiency issues for the retrospective instead of repeatedly interrupting the
solution path.

Before calling the local build friends-ready:

1. **Complete the real proof.** WP8, WP9, and WP10 finish with head-bound deterministic
   verification, honest review provenance, and no manual implementation outside Camus.
2. **One project completes without harness surgery.** A fresh end-to-end feature can plan,
   implement, review, perform its bounded repair, verify, stop/resume, and hand off a parked
   candidate without changing Camus mid-run.
3. **Add an operator layer to the existing Camus skill, not another orchestrator.** An agent
   operating Camus should be told how to choose Studio versus direct skill use, select a
   posture/model pairing, watch host-owned signals, intervene only on material defects,
   preserve/resume the worktree, and feed observations into `camus retro`. Reuse the earlier
   task-skill direction and current scripts; do not create a second scheduler or receipt
   system.
4. **Make feedback cheap and cumulative.** Bugs, UI/UX friction, token/latency waste, and
   successful interventions collected during a run become read-only retro input and a short
   prioritized report. Retro recommends; it never mutates configuration or code.
5. **Studio exposes the contract rather than narrowing it.** Progressive disclosure and
   templates are welcome, but the operator must be able to supply the full acceptance
   contract and run controls supported by Camus. The UI must not silently reduce the engine's
   expressive contract.

After the current round-cap and thin-runner fixes, WP9 and WP10 are validation rounds. Add
no new architecture during them unless a material trust or completion defect proves it is
required. A successful bounded run is evidence to stop building the harness and finish the
product using it.

**Outcome:** achieved. The operator layer lives in the existing skill, Studio exposes the
full acceptance contract, and run feedback remains evidence for `camus retro` rather than
a second orchestrator. Future dogfood should happen on real product features. A material
custody or false-receipt defect may still stop a run; ordinary UX and efficiency findings
belong in the retrospective and must not prevent a useful solution.

## 1. Postures: `bookend` + `forward` (decided)

The other half of the posture dial (VELOCITY §1). `bookend` reviews first-and-last only;
`forward` reviews forward-only with no re-review of fixes. Requires the **final-review
outcome statuses** + the **plan-review contract** so neither posture can impersonate the
full gate — same honest-report discipline as oneshot's `done_with_findings` /
`fixed_unreviewed` / `claimedResolution` family. Selection stays
classifier-recommends-human-confirms; autonomous-on-record routing only behind the
benchmark gate (below).

The plan-review contract gains a **stale-reference rule** (field incident, 2026-06-12,
hive-mind/scraper): a plan task that references behavior in a repo the runner cannot
open must carry either literal bytes materialized AT LAUNCH ("paste at run time" — the
plan-layer head-binding) or an executable contract to port (an ACCEPT/REJECT test
table), never an English walkthrough of code. Prose paraphrases are unverified relays:
they detach from their source at write time, the source moves, and both repos stay
green while the system splits. The reviewer flags any cross-repo prose-of-code as a
blocking finding.

The mechanical half: **launch-time materialization**. A plan task may declare external
references (`{path, repo, mode: literal|test-table}`); the feat resolves them at
PREFLIGHT — reading the live bytes the moment the run starts and injecting them into
the task text — so "paste at launch" stops depending on a human remembering. In-repo
freshness needs no new phase (each task already re-plans and implements against the
live worktree); this exists solely for content the worktree cannot open by design.

## 2. Opt-in multi-model review backends (decided)

Backends other than codex, opt-in, never silently routed. The seam already exists:
`review.sh` is the backend dispatcher (`CAMUS_REVIEWER`), failing closed on the
cross-vendor invariant (the reviewer must not share a vendor with the implementer). Each
new backend must pass the **benchmark gate** before it's selectable: a fixed finding-set
benchmark comparing verdict quality against the codex baseline, so backend choice is a
measured trade, not vibes.

## 3. Runtime canary (decided)

A tiny known-answer task the gate can run against the live toolchain (model + reviewer +
verify) to detect silent regressions in the harness/CLIs before they eat a real feat.
Plugs into preflight as an opt-in; failure is `env_not_ready`-class, never code-red.

## 4. Codex-resume recovery (decided)

When the detached reviewer dies mid-review (watchdog abort, network), recover via codex's
session-resume instead of paying a full re-review. Watchdog (`review_watch.py`) already
exit-code-files every run; recovery rides that evidence.

## 5. `camus retro` (new, 2026-06-12)

The gate teaching its operator. `~/.camus` already accumulates the best per-run telemetry
anywhere (postures, rounds, token ledgers, halt reasons, deferred findings). `camus retro`
reads the last N reports and suggests configuration, never applies it: posture defaults
("your trivial-tier tasks never produced review findings — consider oneshot"), budget
sizing, round-cap tuning, env levers. Spark: the r/ClaudeCode Fable-5 thread — people
mine session history by hand and *apply* unverified; retro mines receipts and recommends.
Read-only by construction (doctrine point 1: its allowed mutation set is empty).

## 6. Re-review salvage variant (carried from 0.2.4 notes)

`land:true` ships the commit→verify lane for already-proven work. The unbuilt sibling:
salvage that *wants one more review* before landing (accept-with-fresh-eyes instead of
accept-as-is). Cheap once bookend exists — it's a bookend's closing review applied to a
parked branch.

## 7. Steer redesign: atomic claim → per-run private inbox (decided 2026-06-14)

Human steering (`camus steer`) was DESCOPED from 0.2.7 to opt-in/experimental (default OFF)
after six audit rounds: its read-then-act-over-a-shared-file design guarantees residual race
windows. The fixes shrank windows to single syscalls and made every failure fail-safe, but the
architecture is the problem. Root cause: 0.2.7's read/consume SPLIT (introduced for retry-safety
against a relay flake) opened a TOCTOU class — newer-note-deleted, clear-applies-stale,
crash-stranded claim, torn write, caller-checks-not-side-effect.

The 0.3 redesign retires the class by construction:
- A single `os.rename` atomically CLAIMS and removes the note into a per-run PRIVATE inbox
  (`~/.camus/steer/<featId>/inbox/<runid>/…`) the human CLI never touches. Retry-safe (the
  rename is idempotent — re-run re-reads the inbox), race-free (a human write after the claim
  lands at the original path for the next boundary), crash-safe (a stranded inbox entry is
  recovered by runid). No sha-gate, no shared `.consuming` claim file, no check-then-act.
- This is what Fix A should have been: when you must make an atomic op retryable, claim-to-a-
  private-location beats split-read-from-act. Default ON once it lands.
- The hardened 0.2.x steer code stays in-tree (dormant behind `args.steer`) until replaced.

## 8. Toolless classifier agent (decided 2026-06-14)

The per-task complexity classifier (camus-loop Phase 0) is spawned as a normal workflow subagent —
full Write/Edit/Bash. Asked only to return a tier, it once "helpfully" *implemented* the task in the
MAIN checkout (Write→Edit→Write + ran tests), leaking an untracked file that aborted the integration
merge (live re-soak 2026-06-14, the publish blocker). Root: an under-constrained classifier — full
tools + parent cwd for what should be a cheap, toolless label. This is the SAME bug as the classifier's
token over-provisioning (it can burn a task's worth of work).

0.2.7 ships the pragmatic fix: `agentType: 'Explore'` (removes Write/Edit/NotebookEdit — the leak
vector) + a tightened classify-only prompt, with the untracked-delta containment net as the backstop.
Residual: `Explore` keeps Bash and carries exploration semantics (a classifier shouldn't explore).

0.3: replace it with a **custom TOOLLESS classifier agent** — a registered agent type with NO tools at
all, so it can only read the task text and return `{tier, reason}` via StructuredOutput. Airtight (can't
write OR explore) and cheap (no wandering) — closes the leak vector and the cost flag together. Needs an
`agents/` dir in the skill + install.sh deploy + `--check` manifest entry. Same toolless treatment for
the feat-level posture classifier (the 5-agent / ~160k-token pause flagged in the re-soak).

## Non-goals for 0.3

- No anonymous/best-effort backend routing — opt-in + benchmark-gated only.
- No posture that skips deterministic verify. Verify is unskippable in every posture, forever.
- No agent-applied config changes from retro — recommendations are output, not mutations.
