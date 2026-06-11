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
# Config: `reviewer: codex` is the default; CAMUS_REVIEWER env overrides (exact match — `codex`,
#         lowercase); a per-run arg arrives later with classifier routing (VELOCITY §2).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
backend="${CAMUS_REVIEWER:-codex}"

case "$backend" in
  codex)
    # exec, not a subshell: the backend IS the review process — same stdout, same exit, same
    # signal behavior the orchestrator already relies on. Zero behavior change vs calling
    # codex_review.sh directly, which is what makes this a pure refactor.
    exec bash "$here/codex_review.sh" "$@"
    ;;
  *)
    # Fail closed: an unknown backend is an INFRA outcome (ran:false), never a verdict and never
    # a fallback. Exit 0 so the caller parses gate JSON instead of seeing a crash — the same
    # discipline as every other infra failure in this gate (adapter.py: branch on ran==false,
    # retry/escalate, never feed it to the fix loop as a rejection).
    python3 - "$backend" <<'PY'
import json, sys
print(json.dumps({
    "ran": False,
    "error": ("unknown reviewer backend '%s' — only 'codex' is built in "
              "(cross-vendor invariant: the reviewer must not share the implementer's "
              "vendor; new backends join only after the benchmark gate, "
              "VELOCITY-DIRECTION §2)" % sys.argv[1]),
    "clean": False,
    "blocking": [],
    "nonblocking": [],
}))
PY
    exit 0
    ;;
esac
