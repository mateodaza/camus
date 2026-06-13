#!/usr/bin/env bash
# Reviewer agent runs this. Emits NORMALIZED gate JSON on stdout.
# Cross-vendor: Codex (a different vendor) reviews Claude's change.
# Since 0.2.6 this is the CODEX BACKEND behind the thin reviewer dispatcher (review.sh,
# VELOCITY-DIRECTION §2): callers go through review.sh, which for the default backend execs
# this script verbatim — every contract below is unchanged by the dispatcher.
#
# Usage:  codex_review.sh <worktree> [task-context] [round] [effort] [scope]   # start + first await
#         codex_review.sh await <watch_dir>                                    # re-attach to a pending review
#         codex_review.sh abort <watch_dir>                                    # kill it (watch budget exhausted)
#   effort = the per-call reasoning effort (medium|high|xhigh) the orchestrator picks; default medium.
#   scope  = full|light (default full): light judges the diff primarily — see the scope block below.
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

# Echo the thread_id carried in a review_watch envelope (codex-resume-recovery 2026-06-12), or
# nothing when absent/unreadable. review_watch only ever writes handle.json, so it CARRIES the
# id in its envelopes; this script owns meta.json and is the one that persists it.
_envelope_thread_id() {
  printf '%s' "$1" | python3 -c 'import json,sys
try: tid = json.load(sys.stdin).get("thread_id")
except Exception: tid = None
print(tid if isinstance(tid, str) and tid else "")' 2>/dev/null
}

# Persist a thread_id into the round's meta.json so the NEXT attempt of this round can resume the
# idle-killed/aborted codex thread instead of re-paying a fresh review. Merge-in-place (keeps
# target_dir/round/effort/scope); a no-op when the id is empty or meta.json is unwritable.
_persist_thread_id() { # $1 = meta.json path, $2 = thread_id
  [[ -n "$2" && -f "$1" ]] || return 0
  python3 -c 'import json,sys
p, tid = sys.argv[1], sys.argv[2]
try:
    m = json.load(open(p))
    assert isinstance(m, dict)
except Exception:
    sys.exit(0)
m["thread_id"] = tid
json.dump(m, open(p, "w"), indent=2)' "$1" "$2" 2>/dev/null || true
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
  # Persist the codex thread_id the envelope carries (present on abort/idle_killed) into the
  # round's meta.json — that handle is what lets the NEXT round's fresh-review path RESUME this
  # killed thread instead of paying again (codex-resume-recovery 2026-06-12). No-op otherwise.
  _persist_thread_id "$meta" "$(_envelope_thread_id "$envelope")"
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

# REVIEW SCOPE (arg 5 — 2026-06-11, VELOCITY-DIRECTION §2 lever (a); pairs with the `oneshot`
# posture): `light` tells the reviewer to judge the DIFF primarily instead of auditing the
# surrounding repository — agentic exploration beyond the diff is the known latency driver
# after reasoning effort. Light narrows the FIELD OF VIEW, never the severity bar; a P0 in the
# diff is still a P0. review-prompt.md stays untouched as the canonical FULL-scope prompt —
# light is an appended instruction, so default behavior is byte-identical to before this knob
# existed. Any value other than `light` (including typos) degrades to full, the conservative
# direction — and the normalized value is what meta.json records, so the audit trail shows the
# scope that actually RAN, not what was typed.
scope="${5:-full}"
[[ "$scope" == "light" ]] || scope="full"
if [[ "$scope" == "light" ]]; then
  prompt="$prompt

## Review scope: LIGHT
Judge the DIFF primarily. Read surrounding code only where the diff's correctness genuinely
depends on it — do not audit the wider file or repository. Same severity bar (P0–P3), applied
to a deliberately narrower field of view."
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
# ~700k tokens). PRECEDENCE: an explicit CAMUS_CODEX_ARGS (user) wins over the per-call arg-4
# effort, else medium; the levers below are ADDITIVE and compose with either source. The
# override only affects CAMUS's review effort (it can
# lower OR raise it, e.g. force xhigh) — the user's interactive codex config is untouched.
#   export CAMUS_CODEX_ARGS="-c model_reasoning_effort=xhigh"    # force a constant effort
# (word-splitting is intentional: the var carries whole extra CLI args.)
effort="${4:-medium}"
codex_review_args="${CAMUS_CODEX_ARGS:--c model_reasoning_effort=$effort}"

# ── Additive speed levers (2026-06-11, VELOCITY-DIRECTION §2) — both default-OFF: with the env
# vars unset, the codex invocation is byte-identical to before they existed. They are appended
# AFTER the args above, and codex resolves repeated flags last-wins (`-c key=value` and `-m`
# alike) — so do NOT combine CAMUS_CODEX_LIGHT_MODEL with a `-m` pinned inside CAMUS_CODEX_ARGS
# (on medium rounds the appended light model would silently win; pick ONE place to pin a model).
#
# LIGHT-MODEL LADDER (experiment 2 — VALIDATED LIVE 2026-06-11: `-m <light model>` works on this
# ChatGPT-plan auth; a trivial schema'd reply returned in ~7.8s). Review is the gate, so the
# ladder must never undercut escalation: the light model applies ONLY when the resolved effort
# is `medium` (the cheap first pass). Escalated rounds (high/xhigh) exist to buy DEPTH — they
# always run the user's full configured model. Recommended value: OpenAI's mini-tier codex model
# (today that is gpt-5.4-mini — officially recommended for review-style work, ">2x faster, ~30%
# of limits"). Intentionally NOT hardcoded: model names drift (house rule above) — the user pins
# the value, camus pins the policy.
if [[ -n "${CAMUS_CODEX_LIGHT_MODEL:-}" && "$effort" == "medium" ]]; then
  codex_review_args="$codex_review_args -m $CAMUS_CODEX_LIGHT_MODEL"
fi
# SERVICE-TIER PIN (experiment 3 mechanism — the billing DECISION stays the user's): since
# codex 0.124, eligible ChatGPT plans default to the FAST service tier (2.5x credit burn on
# GPT-5.5). This pin makes the review lane's tier deliberate — e.g. CAMUS_CODEX_TIER=standard
# keeps camus's bounded gate reviews off the premium meter — without touching the user's
# interactive codex config, the same isolation promise the effort override makes above.
if [[ -n "${CAMUS_CODEX_TIER:-}" ]]; then
  codex_review_args="$codex_review_args -c service_tier=$CAMUS_CODEX_TIER"
fi
# MCP PRUNING (2026-06-12, live smoke findings — probed on codex 0.137.0): every `codex exec`
# initializes EVERY MCP server in the user's config.toml before the review starts — npx spawns,
# remote auth handshakes (a failing remote burns its whole retry window) — measured at ~35% of
# trivial-call wall time with all servers off, with ~zero token difference. A bounded review
# needs the repo, not the user's toolbelt. CAMUS_CODEX_DISABLE_MCP="figma,notion" appends
# `-c mcp_servers.<id>.enabled=false` per id, scoping the pruning to CAMUS's review lane only —
# the user's config.toml and their interactive codex are untouched (the same isolation promise
# the levers above make). Default-OFF: unset env → byte-identical invocation (the
# CAMUS_CODEX_LIGHT_MODEL / CAMUS_CODEX_TIER discipline).
#   - Per-server on PURPOSE: blanking the whole table with `-c 'mcp_servers={}'` does NOT work
#     (codex config tables MERGE, so the empty override is silently ignored — verified on
#     0.137.0). Do not "simplify" this loop to it.
#   - NOT folded into CAMUS_CODEX_ARGS on purpose: that var REPLACES the dynamic-effort default,
#     so parking the pruning there would kill effort escalation. This lever is additive and
#     composes with either effort source.
#   - Ids reach a command line, so only [A-Za-z0-9_-]+ tokens are accepted — the loop's
#     handle-validation charset discipline, minus `.` (a dot would shift the TOML key path).
#     Whitespace around commas is trimmed; anything else (empty tokens included) is silently
#     skipped.
#   - "all" (2026-06-12): a codex REVIEW needs the repo and a shell, never the user's toolbelt —
#     so the common case deserves one word. The ids come from the config itself (the [mcp_servers.X]
#     headers, same charset filter applied), since blanking the table is the thing that doesn't work.
_mcp_list="${CAMUS_CODEX_DISABLE_MCP:-}"
if [[ "$_mcp_list" == "all" ]]; then
  _codex_cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  _mcp_list="$([ -f "$_codex_cfg" ] && sed -n 's/^[[:space:]]*\[mcp_servers\.\([A-Za-z0-9_-]*\)\].*/\1/p' "$_codex_cfg" | tr '\n' ',' || true)"
fi
if [[ -n "$_mcp_list" ]]; then
  _mcp_rest="${_mcp_list},"                        # trailing comma: every token ends with one
  while [[ -n "$_mcp_rest" ]]; do
    _mcp_id="${_mcp_rest%%,*}"; _mcp_rest="${_mcp_rest#*,}"
    _mcp_id="${_mcp_id#"${_mcp_id%%[![:space:]]*}"}"   # trim leading whitespace
    _mcp_id="${_mcp_id%"${_mcp_id##*[![:space:]]}"}"   # trim trailing whitespace
    [[ "$_mcp_id" =~ ^[A-Za-z0-9_-]+$ ]] || continue
    codex_review_args="$codex_review_args -c mcp_servers.${_mcp_id}.enabled=false"
  done
fi

# Fresh watch dir per round (a retry of the same round starts clean — stale events would
# poison idle detection and usage extraction).
watch_dir="$review_dir/$(basename "$target_dir")-r${round}.watch"

# RESUME PROBE (codex-resume-recovery 2026-06-12): a prior attempt of THIS round that was
# idle-killed/aborted owns a live codex thread — `codex exec resume <thread_id>` can finish it
# for the price of one short turn instead of re-paying a whole fresh review. The thread_id lives
# in the round's meta.json (persisted by the await/abort form) or, failing that, in the prior
# attempt's events.jsonl — both readable ONLY before the fresh path's `rm -rf` below, so capture
# it now. Empty when there's no prior aborted thread → fresh review, today's path byte-identical.
prior_thread_id=""
if [[ -f "$watch_dir/meta.json" ]]; then
  prior_thread_id="$(python3 -c 'import json,sys
try: tid = json.load(open(sys.argv[1])).get("thread_id")
except Exception: tid = None
print(tid if isinstance(tid, str) and tid else "")' "$watch_dir/meta.json" 2>/dev/null)"
fi
if [[ -z "$prior_thread_id" && -f "$watch_dir/events.jsonl" ]]; then
  prior_thread_id="$(python3 -c 'import json,sys
tid = ""
try:
    for line in open(sys.argv[1], encoding="utf-8"):
        try: e = json.loads(line)
        except ValueError: continue
        if isinstance(e, dict) and e.get("type") == "thread.started":
            t = e.get("thread_id")
            if isinstance(t, str) and t: tid = t; break
except OSError: pass
print(tid)' "$watch_dir/events.jsonl" 2>/dev/null)"
fi
# A resume must not clobber the aborted attempt's events.jsonl (the thread_id source + audit):
# preserve it under a1/ instead of deleting the round dir. No prior thread → the original
# rm-and-recreate, so the fresh path is unchanged.
if [[ -n "$prior_thread_id" ]]; then
  mkdir -p "$watch_dir/a1" 2>/dev/null || true
  for _f in events.jsonl err.log exit_code handle.json last.txt; do
    [[ -e "$watch_dir/$_f" ]] && mv -f "$watch_dir/$_f" "$watch_dir/a1/" 2>/dev/null || true
  done
else
  rm -rf "$watch_dir" 2>/dev/null || true
fi
mkdir -p "$watch_dir" 2>/dev/null || {
  printf '' | python3 "$here/adapter.py" from-codex --exit 1; exit 0; }
last_file="$watch_dir/last.txt"
# meta.json lets the await/abort forms recover audit identity without re-passing arguments
# (and doubles as the handle-authenticity check above). Scope is recorded for the AUDIT TRAIL
# only — the prompt already shipped at start, so an await re-attach never needs it, but the
# trail must show what scope a round actually ran at.
python3 -c 'import json,sys
m = {"target_dir": sys.argv[2], "round": sys.argv[3], "effort": sys.argv[4], "scope": sys.argv[5]}
if len(sys.argv) > 6 and sys.argv[6]:
    m["thread_id"] = sys.argv[6]
json.dump(m, open(sys.argv[1], "w"), indent=2)' \
  "$watch_dir/meta.json" "$target_dir" "$round" "$effort" "$scope" "$prior_thread_id"

# Chunk by effort: medium reviews are short (and the orchestrator instructs a 360s tool timeout
# for them — the chunk must FIT under it); high/xhigh get the full window under 600s.
case "$effort" in medium) chunk=300 ;; *) chunk=480 ;; esac

# ── RESUME a prior aborted thread (codex-resume-recovery 2026-06-12) ──────────────────────────
# When the probe above found a thread_id, try to FINISH the killed codex thread for one short
# turn — `codex exec resume <thread_id> <finish-prompt>` — instead of paying for a whole fresh
# review. The invocation rides the same --json/--output-schema/-o plumbing as a fresh run, MINUS
# the sandbox flag: `codex exec resume` rejects `-s/--sandbox` (it inherits the resumed thread's
# sandbox policy), so passing it makes every resume exit nonzero. codex_review_args carries only
# -c/-m overrides, which resume accepts. The resume runs in the round dir ITSELF (its handle.json/
# events/verdict now own the round dir — the aborted attempt already moved to a1/, so nothing
# collides), which is what lets a STILL-RUNNING resume be re-attached: a pending resume returns the
# round-dir handle, and the orchestrator's `codex_review.sh await <round_dir>` form re-attaches to
# the live resumed thread exactly like a pending fresh review.
# FAIL CLOSED: resume that exits nonzero, yields no verdict (empty -o / adapter ran:false), or
# never reaches a `done` envelope falls through to the fresh-review block below — today's path,
# never a new failure mode. A pending resume (live, talking, didn't finish in one chunk) is NOT a
# failure: return the re-attach handle so the loop finishes it later instead of re-paying.
if [[ -n "$prior_thread_id" ]]; then
  resume_last="$last_file"
  resume_prompt="Resume this review and emit the final verdict JSON per the schema now."
  # shellcheck disable=SC2086
  r_start="$(python3 "$here/review_watch.py" start --handle "$watch_dir" --last "$resume_last" -- \
    codex exec resume "$prior_thread_id" --json ${codex_review_args} --output-schema "$schema" -o "$resume_last" "$resume_prompt" 2>>"$watch_dir/err.log")"
  if printf '%s' "$r_start" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("state")=="started" else 1)' 2>/dev/null; then
    r_env="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$chunk" --idle "$idle_s" 2>/dev/null)"
    # Accept the resume when it finished with a usable verdict (ran:true), OR hand back a pending
    # handle for re-attach. A done exit with empty/no -o normalizes to ran:false → fall through to a
    # fresh review; only an outright failure re-pays.
    r_verdict="$(emit_outcome "$r_env" "$watch_dir" "$target_dir" "$round")"
    if printf '%s' "$r_verdict" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin)
    sys.exit(0 if (v.get("ran") is True or v.get("pending") is True) else 1)
except Exception: sys.exit(1)' 2>/dev/null; then
      printf '%s' "$r_verdict"
      exit 0
    fi
  fi
  # Resume could not produce a verdict → fail closed to a fresh review (below). The resume ran in
  # the round dir, so its transient files (exit_code/handle/events/last.txt) MUST be cleared first,
  # or the fresh await would read the failed resume's stale exit_code as an instant "done". Preserve
  # the failed resume's events under a2/ (a1/ holds the original aborted attempt, untouched).
  mkdir -p "$watch_dir/a2" 2>/dev/null || true
  for _f in events.jsonl err.log exit_code handle.json last.txt; do
    [[ -e "$watch_dir/$_f" ]] && mv -f "$watch_dir/$_f" "$watch_dir/a2/" 2>/dev/null || true
  done
fi

# shellcheck disable=SC2086
start_env="$(python3 "$here/review_watch.py" start --handle "$watch_dir" --last "$last_file" -- \
  codex exec --json -s read-only ${codex_review_args} --output-schema "$schema" -o "$last_file" "$prompt" 2>>"$watch_dir/err.log")"
if ! printf '%s' "$start_env" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("state")=="started" else 1)' 2>/dev/null; then
  emit_outcome "${start_env:-{\"state\":\"error\",\"error\":\"start produced no envelope\"}}" "$watch_dir" "$target_dir" "$round"
  exit 0
fi

envelope="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$chunk" --idle "$idle_s" 2>/dev/null)"
emit_outcome "$envelope" "$watch_dir" "$target_dir" "$round"
