#!/usr/bin/env bash
# Reviewer agent runs this. Emits NORMALIZED gate JSON on stdout.
# Cross-vendor: Codex (a different vendor) reviews Claude's change.
#
# Usage:  codex_review.sh <worktree> [task-context] [round] [effort]   # start + first await
#         codex_review.sh await <watch_dir>                            # re-attach to a pending review
#         codex_review.sh abort <watch_dir>                            # kill it (watch budget exhausted)
#   effort = the per-call reasoning effort (medium|high|xhigh) the orchestrator picks; default medium.
#
# WATCHDOG (2026-06-11, docs/HARNESS-DIRECTION.md friction batch §3 — probed live on codex 0.137.0):
# codex runs DETACHED with `--json` (events stream → events.jsonl) and `-o` (the schema-conformant
# verdict → last.txt). This script returns within a bounded chunk: either the finished verdict
# (the common case — most reviews finish inside one chunk), or {"pending":true,"handle":...} for
# the orchestrator to re-attach to with `await`. Liveness is the EVENT STREAM, not wall clock —
# review_watch.py kills the process group after --idle seconds of total event silence (codex's own
# stream-idle retry window is ~5 min; silence past ours means those retries already failed). Total
# review time is therefore unbounded while every individual agent call stays small — the Bash
# tool's ~10-minute ceiling stops being a cap on review depth.
#
# Notes:
# - Model is intentionally NOT hardcoded (names drift). Pin it via codex config
#   or pass `-m <model>` here once you've chosen one.
# - The infra-vs-findings guard lives in adapter.py: a nonzero exit or empty
#   output becomes ran:false, NOT a rejection. Do not "fix" that here.
# - AUDIT: each terminal outcome persists Codex's raw response to ~/.camus/reviews/<wt>-r<round>.json
#   (proof the review actually ran; a MISSING file for a round means the script never ran). The
#   <wt>-r<round>.watch/ directory keeps the full event stream + stderr as the deeper audit.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
skill_dir="$(cd "$here/.." && pwd)"
schema="$skill_dir/sev.schema.json"
prompt_file="$skill_dir/review-prompt.md"
review_dir="${CAMUS_REVIEW_DIR:-$HOME/.camus/reviews}"
idle_s="${CAMUS_REVIEW_IDLE_S:-360}"

# Interpret a review_watch envelope into the gate contract. Args: envelope, watch_dir,
# target_dir, round, exit-context. Emits gate JSON (or pending JSON) on stdout.
emit_outcome() {
  local envelope="$1" watch_dir="$2" target_dir="$3" round="$4"
  local state
  state="$(printf '%s' "$envelope" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except Exception: print("")' 2>/dev/null)"
  local audit_file="$review_dir/$(basename "$target_dir")-r${round}.json"
  case "$state" in
    done)
      local exit_code raw
      exit_code="$(printf '%s' "$envelope" | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("exit",1)))' 2>/dev/null || echo 1)"
      raw="$(cat "$watch_dir/last.txt" 2>/dev/null)"
      mkdir -p "$review_dir" 2>/dev/null && \
        printf '%s' "$raw" | python3 "$here/_review_audit.py" "$audit_file" "$target_dir" "$round" "$exit_code" 2>/dev/null || true
      # Gate JSON + the honest codex-side usage from turn.completed (estimate source, never a bill).
      printf '%s' "$raw" | python3 "$here/adapter.py" from-codex --exit "$exit_code" \
        | python3 -c 'import json,sys
g = json.load(sys.stdin)
try: u = json.loads(sys.argv[1]).get("usage")
except Exception: u = None
if isinstance(u, dict): g["usage"] = u
print(json.dumps(g))' "$envelope"
      ;;
    pending)
      printf '%s' "$envelope" | python3 -c 'import json,sys
e = json.load(sys.stdin)
print(json.dumps({"pending": True, "handle": sys.argv[1],
                  "last_event_age": e.get("last_event_age"), "pid": e.get("pid")}))' "$watch_dir"
      ;;
    idle_killed|aborted|error|*)
      # Killed / never started / unreadable envelope → INFRA, never a verdict (adapter discipline).
      mkdir -p "$review_dir" 2>/dev/null && \
        printf '' | python3 "$here/_review_audit.py" "$audit_file" "$target_dir" "$round" 124 2>/dev/null || true
      printf '%s' "$envelope" | python3 -c 'import json,sys
try: e = json.load(sys.stdin)
except Exception: e = {}
state = e.get("state", "unreadable")
msg = {"idle_killed": "codex review went SILENT (no events for %ss) and was killed" % e.get("idle_s", "?"),
       "aborted": "codex review aborted (watch budget exhausted)",
       "error": "codex review could not start: %s" % e.get("error", "?")}.get(state, "watchdog envelope unreadable")
print(json.dumps({"ran": False, "error": msg, "clean": False, "blocking": [], "nonblocking": []}))'
      ;;
  esac
}

# ── Re-attach / abort forms (the orchestrator holds the handle from a pending verdict) ────────
if [[ "${1:-}" == "await" || "${1:-}" == "abort" ]]; then
  mode="$1"; watch_dir="${2:-}"
  # The handle came back through an agent's stdout — trust it only if it is OUR layout: inside
  # the review dir, with the meta this script wrote at start. Anything else is infra, fail closed.
  meta="$watch_dir/meta.json"
  if [[ -z "$watch_dir" || "$watch_dir" != "$review_dir"/*.watch || ! -f "$meta" ]]; then
    printf '{"ran": false, "error": "invalid or unknown watch handle", "clean": false, "blocking": [], "nonblocking": []}\n'
    exit 0
  fi
  target_dir="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["target_dir"])' "$meta" 2>/dev/null)"
  round="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["round"])' "$meta" 2>/dev/null)"
  effort="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("effort","medium"))' "$meta" 2>/dev/null)"
  if [[ "$mode" == "abort" ]]; then
    envelope="$(python3 "$here/review_watch.py" abort --handle "$watch_dir" 2>/dev/null)"
  else
    case "$effort" in medium) chunk=300 ;; *) chunk=480 ;; esac
    envelope="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$chunk" --idle "$idle_s" 2>/dev/null)"
  fi
  emit_outcome "$envelope" "$watch_dir" "${target_dir:-unknown}" "${round:-0}"
  exit 0
fi

# ── Default form: build the review, start codex detached, await the first chunk ───────────────
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
# stdin is /dev/null via review_watch (with an open non-TTY stdin codex prints "Reading
# additional input from stdin..." and blocks on it, returning an empty verdict).
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

# Fresh watch dir per round (a retry of the same round starts clean — stale events would
# poison idle detection and usage extraction).
watch_dir="$review_dir/$(basename "$target_dir")-r${round}.watch"
rm -rf "$watch_dir" 2>/dev/null || true
mkdir -p "$watch_dir" 2>/dev/null || {
  printf '' | python3 "$here/adapter.py" from-codex --exit 1; exit 0; }
last_file="$watch_dir/last.txt"
# meta.json lets the await/abort forms recover audit identity without re-passing arguments
# (and doubles as the handle-authenticity check above).
python3 -c 'import json,sys
json.dump({"target_dir": sys.argv[2], "round": sys.argv[3], "effort": sys.argv[4]},
          open(sys.argv[1], "w"), indent=2)' "$watch_dir/meta.json" "$target_dir" "$round" "$effort"

# Chunk by effort: medium reviews are short (and the orchestrator instructs a 360s tool timeout
# for them — the chunk must FIT under it); high/xhigh get the full window under 600s.
case "$effort" in medium) chunk=300 ;; *) chunk=480 ;; esac

# shellcheck disable=SC2086
start_env="$(python3 "$here/review_watch.py" start --handle "$watch_dir" --last "$last_file" -- \
  codex exec --json -s read-only ${codex_review_args} --output-schema "$schema" -o "$last_file" "$prompt" 2>>"$watch_dir/err.log")"
if ! printf '%s' "$start_env" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("state")=="started" else 1)' 2>/dev/null; then
  emit_outcome "${start_env:-{\"state\":\"error\",\"error\":\"start produced no envelope\"}}" "$watch_dir" "$target_dir" "$round"
  exit 0
fi

envelope="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$chunk" --idle "$idle_s" 2>/dev/null)"
emit_outcome "$envelope" "$watch_dir" "$target_dir" "$round"
