#!/usr/bin/env bash
# Reviewer agent runs this. Emits NORMALIZED gate JSON on stdout.
# Cross-vendor: Codex (a different vendor) reviews Claude's change.
#
# Usage:  codex_review.sh <worktree> [task-context] [round]
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
raw="$(codex exec -s read-only --output-schema "$schema" "$prompt" 2>/tmp/camus_codex_err.log)"
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
