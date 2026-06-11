#!/usr/bin/env bash
# Reviewer agent runs this. Emits NORMALIZED gate JSON on stdout.
# Cross-vendor: Codex (a different vendor) reviews Claude's change.
#
# Usage:  codex_review.sh <worktree> [task-context] [round] [effort]
#   effort = the per-call reasoning effort (medium|high|xhigh) the orchestrator picks; default medium.
#
# Notes:
# - Model is intentionally NOT hardcoded (names drift). Pin it via codex config
#   or pass `-m <model>` here once you've chosen one.
# - The infra-vs-findings guard lives in adapter.py: a nonzero exit or empty
#   output becomes ran:false, NOT a rejection. Do not "fix" that here.
# - AUDIT: each run persists Codex's raw response to ~/.camus/reviews/<wt>-r<round>.json
#   (proof the review actually ran; a MISSING file for a round means the script never ran).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
skill_dir="$(cd "$here/.." && pwd)"
schema="$skill_dir/sev.schema.json"
prompt_file="$skill_dir/review-prompt.md"

# First positional arg = the directory to review (the worktree); remaining = extra context.
# No leading `cd` needed at the call site, so the whole invocation is one allowlistable command.
target_dir="${1:-$PWD}"
# Target guard (auto-mode hardening): refuse a hostile path before sending ANY diff to OpenAI.
source "$here/_guard.sh"
if ! camus_guard worktree "$target_dir"; then
  printf '' | python3 "$here/adapter.py" from-codex --exit 1   # ran:false (fail closed), never a verdict
  exit 0
fi
task_ctx="${2:-}"          # the task this change must accomplish (single quoted arg from the loop)
round="${3:-0}"            # review round, for the per-round audit filename
if ! cd "$target_dir" 2>/dev/null; then
  # Can't enter the target -> infra failure, never a verdict (adapter emits ran:false).
  printf '' | python3 "$here/adapter.py" from-codex --exit 1
  exit 0
fi

# NEW files must be reviewable (run feedback 2026-06-10: 6 of 9 deliverables were untracked,
# and plain `git diff` omits untracked files — most of the change was INVISIBLE to the
# reviewer). Intent-to-add records the paths so they appear in the diff as full new-file
# content; it does NOT stage content (commit.sh owns staging, and its `git add -A` +
# empty-diff check are unaffected). Respects .gitignore. Best-effort, never fatal.
git add -N . 2>/dev/null || true

prompt="$(cat "$prompt_file")"
if [ -n "$task_ctx" ]; then
  extra="$task_ctx"
  prompt="$prompt

## Task this change must accomplish
The diff is meant to accomplish the following task. Verify it actually FULFILLS it — a clean,
correct-looking diff that does NOT accomplish the stated task is an incomplete implementation (P1):
$extra"
fi

# Fresh session each call (no resume) for reviewer independence.
# stdin MUST be /dev/null: with an open non-TTY stdin codex prints "Reading additional
# input from stdin..." and blocks on it, returning an empty verdict (ran:false infra_error).
# The MODEL is inherited from the user's codex config (names drift too fast to hardcode).
# REASONING EFFORT is DYNAMIC (run feedback 2026-06-11): review is the gate, so effort should
# scale with stakes rather than be a blunt constant. The orchestrator (camus-loop) passes a
# per-call effort as arg 4 — medium for the cheap first pass, escalated to high/xhigh when the
# change proves hard or critical. Default medium when unset (a bounded review doesn't need a
# user's ambient xhigh, which burns 10k+ thinking tokens with no streaming — one feat cost
# ~700k tokens). PRECEDENCE: an explicit CAMUS_CODEX_ARGS (user) wins over everything, else the
# per-call arg-4 effort, else medium. The override only affects CAMUS's review effort (it can
# lower OR raise it, e.g. force xhigh) — the user's interactive codex config is untouched.
#   export CAMUS_CODEX_ARGS="-c model_reasoning_effort=xhigh"    # force a constant effort
# (word-splitting is intentional: the var carries whole extra CLI args.)
effort="${4:-medium}"
codex_review_args="${CAMUS_CODEX_ARGS:--c model_reasoning_effort=$effort}"
# shellcheck disable=SC2086
raw="$(codex exec -s read-only ${codex_review_args} --output-schema "$schema" "$prompt" </dev/null 2>/tmp/camus_codex_err.log)"
status=$?

# AUDIT ARTIFACT: persist Codex's raw response + metadata per review round so each review is provable
# and inspectable (a MISSING audit file for a round ⇒ this script never ran = fabrication/infra).
# Best-effort — NEVER fail the review on an audit-write error.
review_dir="${CAMUS_REVIEW_DIR:-$HOME/.camus/reviews}"
if mkdir -p "$review_dir" 2>/dev/null; then
  audit_file="$review_dir/$(basename "$target_dir")-r${round}.json"
  printf '%s' "$raw" | python3 "$here/_review_audit.py" "$audit_file" "$target_dir" "$round" "$status" 2>/dev/null || true
fi

printf '%s' "$raw" | python3 "$here/adapter.py" from-codex --exit "$status"
