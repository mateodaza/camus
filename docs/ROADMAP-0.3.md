# Camus 0.3 — Roadmap

Consolidated from VELOCITY-DIRECTION.md, HARNESS-DIRECTION.md, and the 0.2.5 smoke/audit
arc (2026-06-12). 0.2.x stays claude+codex only; everything here is 0.3 scope. Items are
ordered by decided-ness, not by build order.

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

## 1. Postures: `bookend` + `forward` (decided)

The other half of the posture dial (VELOCITY §1). `bookend` reviews first-and-last only;
`forward` reviews forward-only with no re-review of fixes. Requires the **final-review
outcome statuses** + the **plan-review contract** so neither posture can impersonate the
full gate — same honest-report discipline as oneshot's `done_with_findings` /
`fixed_unreviewed` / `claimedResolution` family. Selection stays
classifier-recommends-human-confirms; autonomous-on-record routing only behind the
benchmark gate (below).

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

## Non-goals for 0.3

- No anonymous/best-effort backend routing — opt-in + benchmark-gated only.
- No posture that skips deterministic verify. Verify is unskippable in every posture, forever.
- No agent-applied config changes from retro — recommendations are output, not mutations.
