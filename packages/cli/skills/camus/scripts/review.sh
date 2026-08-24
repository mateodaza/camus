#!/usr/bin/env bash
# Reviewer-backend DISPATCHER — the loop's single entry point for probabilistic review
# (2026-06-11, docs/VELOCITY-DIRECTION.md §2, the 0.2.6 "pure refactor, no behavior change"
# step). codex_review.sh is now the CODEX BACKEND behind this thin interface; any CLI that can
# take the same review-prompt + diff and emit sev.schema.json findings qualifies as a backend
# (adapter.py already normalizes/infra-guards — that layer is backend-agnostic by design).
#
# ── CROSS-VENDOR INVARIANT (the moat, not a knob) ─────────────────────────────────────────────
# The reviewer must NOT share the implementer's vendor. Claude never reviews camus's
# Claude-implemented code; Codex / Gemini / others can. "No agent grades its own work" survives
# multi-backend because THIS dispatcher enforces it: an unknown backend FAILS CLOSED (ran:false
# infra error) rather than falling back to anything — a silent fallback could hand review to the
# implementer's own vendor, and the gate would be grading its own homework. New backends join
# ONLY after the benchmark gate (wall-clock, false-positive rate, true-bug catch rate on seeded
# bugs, schema-valid rate over N runs, cost — VELOCITY-DIRECTION §2): a router nobody measured
# is complexity without a payoff.
#
# Usage: identical to codex_review.sh — every form passes through VERBATIM, including the
#        watchdog's re-attach forms (the handle a pending verdict carries is backend-owned;
#        the dispatcher must not reinterpret it):
#   review.sh <worktree> [task-context] [round] [effort] [scope]
#   review.sh await <watch_dir>
#   review.sh abort <watch_dir>
# Config: `reviewer: codex` is the default; CAMUS_REVIEWER env overrides. Selection, benchmark
# admission, and the cross-vendor training-origin check live in reviewer_dispatch.py so shell
# globbing, prefixes, casing, or environment text can never widen the accepted set.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$here/reviewer_dispatch.py" "$@"
