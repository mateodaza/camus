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
# Executor-owned protocol version. It is deliberately available before any replay/adopt
# branch so a persisted watch can never make an older executor claim a newer contract (or
# vice versa) by echoing the value stored in meta.json.
review_contract="rc1"

# Interpret a review_watch envelope into the gate contract. Args: envelope, watch_dir,
# target_dir, round, exit-context. Emits gate JSON (or pending JSON) on stdout.
emit_outcome() {
  local envelope="$1" watch_dir="$2" target_dir="$3" round="$4"
  local state
  state="$(printf '%s' "$envelope" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except Exception: print("")' 2>/dev/null)"
  local audit_file="$review_dir/$(basename "$target_dir")-r${round}.json"
  # The reviewer identity is AUTHORITATIVE from the persisted meta.json, NOT the
  # current env — so an await/resume without CAMUS_CODEX_MODEL still seals the
  # exact model the round pinned, and a changed env can never rewrite it here.
  # The EFFORT the round actually ran at rides the same authority (Studio smoke
  # 2026-07-13: the snapshot's requested effort diverged from the gate's actual;
  # the audit must seal the actual so a pairing can name both honestly).
  local reviewer_model reviewer_effort
  reviewer_model="$(python3 -c 'import json,sys
try: v = json.load(open(sys.argv[1])).get("reviewer_model")
except Exception: v = None
print(v if isinstance(v, str) and v else "")' "$watch_dir/meta.json" 2>/dev/null)"
  reviewer_effort="$(python3 -c 'import json,sys
try: v = json.load(open(sys.argv[1])).get("effort")
except Exception: v = None
print(v if isinstance(v, str) and v else "")' "$watch_dir/meta.json" 2>/dev/null)"
  # The round-sealed contract/scope/qualification/provenance ride the SAME meta.json authority
  # as model/effort. Contract version is also compiled into this executor, but a reattach must
  # first prove the stored version equals that constant; overwriting an rc0 watch with rc1 here
  # would launder a partial-upgrade skew before the caller could detect it.
  local meta_contract
  meta_contract="$(python3 -c 'import json,sys
try:
    m = json.load(open(sys.argv[1]))
    assert isinstance(m, dict)
except Exception:
    m = {}
print(json.dumps({k: m.get(k) for k in
    ("contract","scope","qualification","origin","operator","transport","connection")}))' \
    "$watch_dir/meta.json" 2>/dev/null || echo '{}')"
  case "$state" in
    done)
      local exit_code raw
      exit_code="$(printf '%s' "$envelope" | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("exit",1)))' 2>/dev/null || echo 1)"
      raw="$(cat "$watch_dir/last.txt" 2>/dev/null)"
      local stored_contract
      stored_contract="$(printf '%s' "$meta_contract" | python3 -c 'import json,sys
try: v = json.load(sys.stdin).get("contract")
except Exception: v = None
print(v if isinstance(v, str) and v else "")' 2>/dev/null)"
      if [[ "$stored_contract" != "$review_contract" ]]; then
        python3 -c 'import json,sys
stored = sys.argv[1] or "missing"
current = sys.argv[2]
print(json.dumps({
    "ran": False,
    "infra_error": "review-contract-drift",
    "error": "review contract drift: stored %s, executor %s; refusing to relabel the completed review" % (stored, current),
    "clean": False,
    "blocking": [],
    "nonblocking": [],
}))' "$stored_contract" "$review_contract"
        return 0
      fi
      mkdir -p "$review_dir" 2>/dev/null && \
        printf '%s' "$raw" | python3 "$here/_review_audit.py" "$audit_file" "$target_dir" "$round" "$exit_code" "$reviewer_model" "$reviewer_effort" "$meta_contract" 2>/dev/null || true
      # Gate JSON + the honest codex-side usage from turn.completed (estimate source, never a bill)
      # + the BINDING: what this invocation ACTUALLY ran (round, effort, model, backend, canonical
      # worktree, gate nonce). The audit file already recorded it, but the audit file is not what
      # the loop reads — stdout is. Without it, camus-loop could only compare the reviewer's output
      # against ITSELF, so a self-consistent receipt for the wrong round/effort passed (field report
      # 2026-08-04). asGate now compares these actuals against values it knows independently.
      printf '%s' "$raw" | python3 "$here/adapter.py" from-codex --exit "$exit_code" \
        | python3 -c 'import json,os,sys
g = json.load(sys.stdin)
try: u = json.loads(sys.argv[1]).get("usage")
except Exception: u = None
if isinstance(u, dict): g["usage"] = u
def _int(v):
    try: return int(str(v).strip())
    except (TypeError, ValueError): return None
requested = {}
try:
    parsed = json.loads(os.environ.get("CAMUS_REVIEW_BINDING") or "{}")
    if isinstance(parsed, dict) and not parsed.get("error"): requested = parsed
except ValueError: pass
try: mc = json.loads(sys.argv[6] or "{}")
except Exception: mc = {}
if not isinstance(mc, dict): mc = {}
g["binding"] = {
    "round": _int(sys.argv[2]),
    "effort": (sys.argv[3] or None),
    "model": (sys.argv[4] or None),
    "backend": (os.environ.get("CAMUS_REVIEW_BACKEND") or None),
    "worktree": os.path.realpath(sys.argv[5]) if sys.argv[5] else None,
    "nonce": (requested.get("nonce") or os.environ.get("CAMUS_GATE_NONCE") or None),
    "round_requested": requested.get("round"),
    "effort_requested": requested.get("effort"),
    # REVIEW-CONTRACT (rc1) actuals, from the sealed meta.json — asGate compares each
    # against the workflow-computed expectation and refuses any drift.
    "contract": mc.get("contract"),
    "scope": mc.get("scope"),
    "qualification": mc.get("qualification"),
    "origin": mc.get("origin"),
    "operator": mc.get("operator"),
    "transport": mc.get("transport"),
    "connection": mc.get("connection"),
}
print(json.dumps(g))' "$envelope" "$round" "$reviewer_effort" "$reviewer_model" "$target_dir" "$meta_contract"
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
        printf '' | python3 "$here/_review_audit.py" "$audit_file" "$target_dir" "$round" 124 "$reviewer_model" "$reviewer_effort" "$meta_contract" 2>/dev/null || true
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
  # BINDING SURVIVES THE REATTACH BOUNDARY. A separate await process has no CAMUS_REVIEW_BINDING
  # and may have no CAMUS_GATE_NONCE, so the emitted binding lost its nonce and the mixed
  # bound/unbound guard refused a review that had completed correctly (live run
  # 20260806-110809-2r9j). meta.json is this script's own start-time record — the same file the
  # adoption gate authenticates against — so the identity is RECONSTRUCTED from it, never invented.
  # An env nonce, when present, still wins: a mismatch must remain visible to asGate.
  # The FULL binding, not just the nonce. `_review_audit.py` builds the per-round JSON that
  # STUDIO watches, and it reads binding EXCLUSIVELY from CAMUS_REVIEW_BINDING — so exporting
  # only the nonce fixed the wrapper's stdout while still publishing an UNBOUND
  # ~/.camus/reviews/<wt>-r<n>.json. Reconstruct the whole envelope from meta.json (this
  # script's own authenticated start-time record) so the artifact Studio consumes is bound too.
  # An explicit env nonce is NEVER overwritten: a mismatch must stay visible to asGate and be
  # refused, which is the whole point of the binding check.
  _await_binding="$(python3 - "$meta" "${CAMUS_GATE_NONCE:-}" <<'PYB'
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    m = {}
env_nonce = sys.argv[2] if len(sys.argv) > 2 else ""
rnd = m.get("round")
try:
    rnd = int(str(rnd).strip())
except (TypeError, ValueError):
    rnd = None
if rnd is None:
    print("")
    raise SystemExit(0)
eff = m.get("effort") if isinstance(m.get("effort"), str) else None
# An env nonce WINS so a mismatching one stays visible; meta.json only fills an absent one.
nonce = env_nonce or (m.get("gate_nonce") if isinstance(m.get("gate_nonce"), str) else None)
def _s(k):
    v = m.get(k)
    return v if isinstance(v, str) and v else None
print(json.dumps({
    "round": rnd,
    "effort": eff,
    "effort_specified": bool(eff),
    "nonce": nonce or None,
    # Provenance: this envelope was rebuilt on reattach, not read from a live request file.
    "round_sources": {"meta.json (await reattach)": str(rnd)},
    "effort_sources": ({"meta.json (await reattach)": eff} if eff else {}),
    # REVIEW-CONTRACT (rc1) fields carried across the reattach boundary from the sealed
    # meta.json, so the audit CAMUS_REVIEW_BINDING stays bound (not just the nonce).
    "scope": _s("scope"),
    "contract": _s("contract"),
    "qualification": _s("qualification"),
    "origin": _s("origin"),
    "operator": _s("operator"),
    "transport": _s("transport"),
    "connection": _s("connection"),
}))
PYB
)"
  if [[ -n "$_await_binding" ]]; then
    export CAMUS_REVIEW_BINDING="$_await_binding"
    # asGate compares the nonce from this envelope; keep the env copy consistent with it.
    if [[ -z "${CAMUS_GATE_NONCE:-}" ]]; then
      _meta_nonce="$(python3 -c 'import json,sys
try: v = json.load(open(sys.argv[1])).get("gate_nonce")
except Exception: v = None
print(v if isinstance(v, str) and v else "")' "$meta" 2>/dev/null)"
      [[ -n "$_meta_nonce" ]] && export CAMUS_GATE_NONCE="$_meta_nonce"
    fi
    # The reviewer backend is codex for every watch this script owns; restore it so the audit
    # record names it instead of leaving reviewer_backend null on a reattach.
    [[ -z "${CAMUS_REVIEW_BACKEND:-}" ]] && export CAMUS_REVIEW_BACKEND="codex"
  fi
  # Persist the codex thread_id into the round's meta.json ONLY for a terminal abandoned shape
  # (idle_killed / aborted) — that handle is what lets the NEXT round's fresh-review path RESUME this
  # killed thread instead of paying again (codex-resume-recovery 2026-06-12). A `pending` envelope
  # carries a thread_id too (review_watch.py), but its LOCAL process is still running and the loop
  # will re-`await` it — persisting that id would let a later fresh invocation resume a live thread,
  # the exact aborted/abandoned-only trigger violation the will_resume gate exists to prevent. Only
  # idle_killed/aborted leave a thread genuinely abandoned with no completion evidence, so gate the
  # persist on that state. No-op for any other state, an empty id, or an unwritable meta.json.
  _env_state="$(printf '%s' "$envelope" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except Exception: print("")' 2>/dev/null)"
  if [[ "$_env_state" == "idle_killed" || "$_env_state" == "aborted" ]]; then
    _persist_thread_id "$meta" "$(_envelope_thread_id "$envelope")"
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
# ROUND IS NOT DEFAULTED. It used to be `${3:-0}`, and that default was a
# false-pass generator: a thin runner relaying this command dropped the trailing
# `<round> <effort>` args, the script silently reviewed as r0/medium, and the
# orchestrator accepted that r0 receipt as the round it had requested (field
# report 2026-08-04, a WP6 game run: requested r2/high, got r0/medium, loop
# advanced to r3). Round and effort now resolve from the MECHANICAL channels
# below and a missing or conflicting value is an infra refusal, never a verdict.
round_argv="${3:-}"
if ! cd "$target_dir" 2>/dev/null; then
  # Can't enter the target -> infra failure, never a verdict (adapter emits ran:false).
  printf '' | python3 "$here/adapter.py" from-codex --exit 1
  exit 0
fi
# Codex loads trusted project `.codex/config.toml` layers above user configuration. A reviewer
# run must not inherit a repository's model/provider pin and then claim builtin1. Mark this exact
# canonical worktree untrusted for the child only; keep the override in an array so paths with
# spaces remain one argv value. JSON string quoting is TOML-compatible for this dotted key.
target_canonical="$(pwd -P)"
target_toml_key="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$target_canonical" 2>/dev/null)"
if [[ -z "$target_canonical" || -z "$target_toml_key" ]]; then
  printf '' | python3 "$here/adapter.py" from-codex --exit 1
  exit 0
fi
project_trust_args=(-c "projects.${target_toml_key}.trust_level=\"untrusted\"")

# NEW files must be reviewable (run feedback 2026-06-10: 6 of 9 deliverables were untracked,
# and plain `git diff` omits untracked files — most of the change was INVISIBLE to the
# reviewer). Intent-to-add records the paths so they appear in the diff as full new-file
# content; it does NOT stage content (commit.sh owns staging, and its `git add -A` +
# empty-diff check are unaffected). Respects .gitignore. Best-effort, never fatal.
ita_fail=""
git add -N . 2>/dev/null || ita_fail="git add -N failed, so new files may be invisible to both the review and its fingerprint"


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

# INPUT FINGERPRINT (audit 2026-08-06, tightened 2026-08-06b). meta.json recorded WHO reviewed
# and at what effort, but nothing about WHAT — so a stopped gate could change the worktree,
# restart with the same custody identity, and have a completed verdict for the OLD content
# replayed as current. Taken HERE, after the prompt is fully assembled, so the digest binds
# every input that changes the question: HEAD, the binary diff (intent-to-add already ran, so
# new files are included exactly as the reviewer sees them), and the final prompt bytes —
# which carry the task context and the normalized scope.
#
# VERSIONED (fp1:) so a future encoding change is a visible mismatch rather than a silent
# false match. FAIL CLOSED: if HEAD, the diff, or the hash cannot be produced we do not know
# what would be reviewed, so we neither replay nor start. "unavailable" is never stored or
# compared — a sentinel that compares equal to itself is exactly the false match this exists
# to prevent.
fp_fail="$ita_fail"
_fp_head="$(git rev-parse HEAD 2>/dev/null)" || _fp_head=""
[ -n "$_fp_head" ] || fp_fail="cannot resolve HEAD in the worktree"
_fp_diff_file="$(mktemp 2>/dev/null)" || fp_fail="${fp_fail:-cannot create a temp file for the diff}"
if [ -z "$fp_fail" ]; then
  if ! git -c diff.noprefix=false diff --binary --no-renames HEAD -- . > "$_fp_diff_file" 2>/dev/null; then
    fp_fail="git diff failed, so the reviewed content cannot be identified"
  fi
fi
input_fp=""
if [ -z "$fp_fail" ]; then
  input_fp="$( { printf 'fp1\nhead:%s\nprompt-bytes:%s\n' "$_fp_head" "${#prompt}"
                printf '%s' "$prompt"
                printf '\ndiff:\n'
                cat "$_fp_diff_file"; } | shasum -a 256 2>/dev/null | cut -d' ' -f1 )"
  # EXACT shape or nothing: a truncated or malformed hasher output must refuse rather than be
  # stored as a fingerprint that can never legitimately match.
  input_fp="fp1:$input_fp"
  case "$input_fp" in
    fp1:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) fp_fail="the hasher produced no usable digest (${#input_fp} chars)" ; input_fp="" ;;
  esac
fi
rm -f "$_fp_diff_file" 2>/dev/null || true
if [ -n "$fp_fail" ]; then
  printf '{"ran": false, "infra_error": "fingerprint-unavailable", "log_tail": "cannot fingerprint the review input (%s), so this invocation can neither prove a completed verdict describes the current content nor safely start a new review. Nothing was replayed and nothing was started."}\n' "$fp_fail"
  exit 0
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
effort_argv="${4:-}"

# ── BINDING: cross-check three channels, refuse on ANY disagreement ────────────
# The workflow composes the round/effort into THREE places for the same review:
#   1. request file  $review_dir/<wt>-request.json  — written just before invoking.
#   2. env  CAMUS_REVIEW_ROUND / CAMUS_REVIEW_EFFORT / CAMUS_GATE_NONCE.
#   3. argv.
# NONE of these is relay-independent: the SAME thin agent executes both the
# request-file writer and this review command, so it can alter or drop any of
# them. What the three channels buy is a CONSISTENCY CHECK — a partial mangling
# (some channels changed, others not) becomes a loud refusal here instead of a
# silent mislabel, and nothing supplying a round at all is refused too (the old
# default-to-0 hole). Every refusal is `ran:false` + exit 0, so the caller
# retries rather than treating it as a verdict. This is DEFENSE IN DEPTH, not the
# load-bearing guarantee: that is asGate in the workflow, which compares the
# reviewer's ACTUAL binding against expectations the workflow itself computed and
# fails closed on any mismatch, independent of what this script accepted.
request_file="$review_dir/$(basename "$target_dir")-request.json"
binding="$(python3 - "$request_file" "$target_dir" "$round_argv" "$effort_argv" "$scope" <<'PY'
import json, os, sys
request_path, target_dir, round_argv, effort_argv, scope_argv = sys.argv[1:6]
VALID_EFFORT = ("low", "medium", "high", "xhigh")
VALID_SCOPE = ("full", "light")

req = {}
if os.path.exists(request_path):
    try:
        with open(request_path, encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            req = loaded
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": "review request file is unreadable (%s); refusing rather than "
                                   "guessing the round" % exc.__class__.__name__}))
        raise SystemExit(0)

# A request file belongs to ONE worktree. A stale file from another worktree must
# never bind this review.
req_wt = req.get("worktree")
if req_wt and os.path.realpath(str(req_wt)) != os.path.realpath(target_dir):
    print(json.dumps({"error": "review request file names worktree %r but this invocation targets %r; "
                               "refusing a cross-worktree binding" % (req_wt, target_dir)}))
    raise SystemExit(0)

def as_round(value):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n >= 1 else None

sources = {}
if req.get("round") is not None:
    sources["request file"] = as_round(req.get("round"))
if os.environ.get("CAMUS_REVIEW_ROUND"):
    sources["env CAMUS_REVIEW_ROUND"] = as_round(os.environ["CAMUS_REVIEW_ROUND"])
if round_argv.strip():
    sources["argv"] = as_round(round_argv)

bad = [name for name, value in sources.items() if value is None]
if bad:
    print(json.dumps({"error": "review round from %s is not a positive integer; rounds start at 1 "
                               "and are never defaulted" % ", ".join(sorted(bad))}))
    raise SystemExit(0)
if not sources:
    print(json.dumps({"error": "no review round was supplied by the request file, the environment, or "
                               "argv. This invocation is unbound: it used to default to r0 and be "
                               "accepted as whichever round the orchestrator wanted. Refusing."}))
    raise SystemExit(0)
distinct = sorted(set(sources.values()))
if len(distinct) > 1:
    print(json.dumps({"error": "review round disagrees across channels (%s); the requested invocation "
                               "and the actual one must match" %
                               "; ".join("%s=%s" % (k, sources[k]) for k in sorted(sources))}))
    raise SystemExit(0)
round_value = distinct[0]

# Effort: same rule, but a genuinely unspecified effort keeps the documented
# medium default — an unstated effort cannot silently promote a round the way an
# unstated ROUND silently mislabels a receipt. A CONFLICT still refuses.
effort_sources = {}
if req.get("effort"):
    effort_sources["request file"] = str(req["effort"]).strip()
if os.environ.get("CAMUS_REVIEW_EFFORT"):
    effort_sources["env CAMUS_REVIEW_EFFORT"] = os.environ["CAMUS_REVIEW_EFFORT"].strip()
if effort_argv.strip():
    effort_sources["argv"] = effort_argv.strip()
invalid = {k: v for k, v in effort_sources.items() if v not in VALID_EFFORT}
if invalid:
    print(json.dumps({"error": "review effort %s is not one of %s" %
                               ("; ".join("%s=%r" % kv for kv in sorted(invalid.items())), "|".join(VALID_EFFORT))}))
    raise SystemExit(0)
distinct_effort = sorted(set(effort_sources.values()))
if len(distinct_effort) > 1:
    print(json.dumps({"error": "review effort disagrees across channels (%s)" %
                               "; ".join("%s=%s" % (k, effort_sources[k]) for k in sorted(effort_sources))}))
    raise SystemExit(0)
effort_value = distinct_effort[0] if distinct_effort else "medium"

# SCOPE consistency (REVIEW-CONTRACT.md). scope drives the reviewer field of view
# via argv (arg 5, already normalized to full|light by the caller). The request file
# carries the requester intended scope; a DISAGREEMENT between them is a partial
# mangle — refuse rather than review at a scope nobody asked for. A request that omits
# scope (legacy/direct call) does not constrain, and the argv value stands.
scope_value = scope_argv.strip() if scope_argv.strip() in VALID_SCOPE else "full"
req_scope = req.get("scope")
if req_scope and str(req_scope).strip() != scope_value:
    print(json.dumps({"error": "review scope disagrees across channels (request file=%r, argv=%r); "
                               "the requested invocation and the actual one must match" %
                               (req_scope, scope_value)}))
    raise SystemExit(0)

print(json.dumps({
    "round": round_value,
    "effort": effort_value,
    "effort_specified": bool(distinct_effort),
    "nonce": str(req.get("gate_nonce") or os.environ.get("CAMUS_GATE_NONCE") or ""),
    "round_sources": ",".join(sorted(sources)),
    "effort_sources": ",".join(sorted(effort_sources)) or "default",
    "scope": scope_value,
    # Contract-carried provenance ECHOED from the caller (request file, then env). These
    # describe the caller/delivery, so the executor cannot know them independently; asGate
    # compares them against the workflow own constants. connection/qualification are
    # DERIVED later from what actually ran, not echoed here.
    "origin": (req.get("origin") or os.environ.get("CAMUS_REVIEW_ORIGIN") or None),
    "operator": (req.get("operator") or os.environ.get("CAMUS_REVIEW_OPERATOR") or None),
}))
PY
)"
binding_error="$(printf '%s' "$binding" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("error") or "")
except Exception: print("review binding could not be resolved")' 2>/dev/null)"
if [[ -n "$binding_error" ]]; then
  # ran:false — an unbound or mismatched review is INFRA, never a verdict. The
  # orchestrator retries the round; it must not advance the review loop.
  python3 - "$binding_error" <<'PY'
import json, sys
print(json.dumps({"ran": False, "error": "review binding refused: %s" % sys.argv[1],
                  "clean": False, "blocking": [], "nonblocking": []}))
PY
  exit 0
fi
read -r round effort effort_specified gate_nonce round_sources effort_sources <<<"$(printf '%s' "$binding" | python3 -c 'import json,sys
b = json.load(sys.stdin)
print(b["round"], b["effort"], str(b["effort_specified"]).lower(),
      b["nonce"] or "-", b["round_sources"], b["effort_sources"])')"
# The resolved binding rides into the audit record so the RECEIPT itself proves
# which invocation produced it — a consumer can compare requested against actual
# instead of trusting a filename. Read from the environment by _review_audit.py,
# so no positional-argument contract has to grow.
export CAMUS_REVIEW_BINDING="$binding"
export CAMUS_REVIEW_BACKEND="${CAMUS_REVIEWER:-codex}"

# ── REVIEW-CONTRACT (rc1) fields — carried through meta.json, the audit, the emitted
# binding, adoption, replay and await. `contract` and `transport` are executor
# CONSTANTS (a version skew or wrong delivery path is a loud mismatch, not a silent
# field). scope was resolved above (argv, cross-checked against the request). origin
# and operator describe the caller and are echoed (binding, then env, else `cli`).
# connection/qualification are DERIVED below, after the effective reviewer model is
# known — they must reflect what ACTUALLY ran, not what was requested.
review_transport="cli-detached"
review_scope="$scope"
review_origin="$(printf '%s' "$binding" | python3 -c 'import json,os,sys
try: v = json.load(sys.stdin).get("origin")
except Exception: v = None
print(v if isinstance(v, str) and v else (os.environ.get("CAMUS_REVIEW_ORIGIN") or "cli"))' 2>/dev/null || echo cli)"
review_operator="$(printf '%s' "$binding" | python3 -c 'import json,os,sys
try: v = json.load(sys.stdin).get("operator")
except Exception: v = None
print(v if isinstance(v, str) and v else (os.environ.get("CAMUS_REVIEW_OPERATOR") or "cli"))' 2>/dev/null || echo cli)"

# ── Resume determination + reviewer identity, BOTH resolved before the model args ──
# Two questions must be answered before codex_review_args is assembled, because the
# model codex ACTUALLY runs with is decided here: (1) is this invocation resuming a
# prior abandoned thread, and (2) under which reviewer? A genuine resume runs — and
# seals — the model the earlier rounds pinned, so codex's -m and the audit can't
# disagree. watch_dir is derived here for the same reason (the fresh-vs-preserve file
# handling below still owns the round dir's lifecycle).
watch_dir="$review_dir/$(basename "$target_dir")-r${round}.watch"

# ── ADOPT A LIVE REVIEW INSTEAD OF RESTARTING IT ──────────────────────────────
# The outer Workflow can go asynchronous, and Studio then reattaches by resuming
# the igniter session. That re-dispatches the workflow's PENDING review agent —
# which re-runs this script with the SAME arguments. Before this block that
# started a SECOND codex for a review already running: live run
# 20260805-072933-jezu started r1 twice and r2 twice, and the round-2 event
# stream reset from 30 events back to 7. A long review could therefore never
# finish, because every reattach restarted its clock.
#
# So: if this round's watch is ALIVE (handle pid answering, no exit_code yet) and
# its recorded identity matches what is being asked for now, adopt it — await the
# existing process instead of spawning. The events, the PID and the thread are
# left exactly as they are; nothing is truncated and no second charge is paid.
# A mismatch (different effort/model/nonce) is NOT adopted: that is a genuinely
# different review, and the normal fresh/resume path below owns it.
if [[ -f "$watch_dir/handle.json" ]]; then
  adopt_reason="$(python3 - "$watch_dir" "$round" "$effort" "${CAMUS_CODEX_MODEL:-}" "${CAMUS_GATE_NONCE:-}" "${input_fp:-}" "$scope" <<'PY'
import json, os, subprocess, sys, time
watch, want_round, want_effort, want_model, want_nonce = sys.argv[1:6]
want_fp = sys.argv[6] if len(sys.argv) > 6 else ""
want_scope = sys.argv[7] if len(sys.argv) > 7 else ""
def jload(p):
    try:
        with open(p, encoding="utf-8") as fh:
            v = json.load(fh)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}
handle, meta = jload(os.path.join(watch, "handle.json")), jload(os.path.join(watch, "meta.json"))
pid = handle.get("pid")
if not isinstance(pid, int):
    print("no-pid"); raise SystemExit(0)
finished = os.path.exists(os.path.join(watch, "exit_code"))
try:
    os.kill(pid, 0)
    alive = True
except Exception:
    alive = False
# A live pid is not yet OURS: after our reviewer exits the OS may reuse the
# number for an unrelated process, and adopting that stranger would wait on —
# and eventually signal — something we never started. handle.json records our
# spawn time; a live pid whose real start does not match it is a STALE handle,
# and the fresh path below owns the round (it archives the stale files and
# never signals the stranger). Unreadable start time counts as unproven.
def proc_start_epoch(p):
    try:
        out = subprocess.run(["ps", "-p", str(p), "-o", "lstart="],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    for fmt in ("%a %b %d %H:%M:%S %Y", "%a %d %b %H:%M:%S %Y"):
        try:
            return time.mktime(time.strptime(out, fmt))
        except ValueError:
            continue
    return None
if alive:
    started_at = handle.get("started_at")
    actual = proc_start_epoch(pid)
    if actual is None:
        time.sleep(0.2)
        actual = proc_start_epoch(pid)
    ours = (isinstance(started_at, (int, float)) and started_at > 0
            and actual is not None and abs(actual - float(started_at)) <= 15)
    if not ours:
        alive = False               # a stranger wearing our pid is not a live review
        if not finished:
            print("stale-handle"); raise SystemExit(0)
# THE INPUT MUST MATCH, not just the identity. meta.json records the fingerprint of the
# exact content that was reviewed; a watch for DIFFERENT content answers a different
# question. A LIVE reviewer working on stale content is fail-closed (adopting it would
# return a verdict about code that no longer exists; starting a second would compete with
# it), and a COMPLETED verdict for stale content is never consumed.
meta_fp = meta.get("input_fingerprint")
fp_current = bool(want_fp) and bool(meta_fp) and str(meta_fp) == str(want_fp)
if alive and not fp_current:
    print("live-stale-input"); raise SystemExit(0)
if not alive and not finished:
    print("dead"); raise SystemExit(0)   # died without a verdict → normal fresh/resume path
# A COMPLETED WATCH IS TERMINAL AND IMMUTABLE, whatever else is true. Its verdict is
# evidence: a fresh start must never delete or overwrite it, and must never spawn a
# second reviewer for a question already answered. Before this, an unproven identity
# fell through to the normal fresh path, which rewrote handle.json/meta.json over a
# finished round and paid for a duplicate Codex review — with Stop later killing the
# duplicate (production run 20260806-063400-vzqs, r1 already had three findings).
# Identity still decides what may be CONSUMED: proven → replay it below; unproven →
# refuse loudly rather than either overwriting the evidence or handing over a verdict
# this invocation cannot prove is its own.
_finished_with_verdict = False
if finished:
    try:
        _finished_with_verdict = os.path.getsize(os.path.join(watch, "last.txt")) > 0
    except OSError:
        _finished_with_verdict = False
# Identity must match, or this is a different review that merely shares a round dir.
def same(field, want):
    got = meta.get(field)
    return (not want) or (not got) or str(got) == str(want)
if str(meta.get("round", want_round)) != str(want_round): print("round-mismatch"); raise SystemExit(0)
if not same("effort", want_effort): print("effort-mismatch"); raise SystemExit(0)
if not same("reviewer_model", want_model): print("model-mismatch"); raise SystemExit(0)
# A different SCOPE (full vs light) is a different review, not one to adopt (REVIEW-CONTRACT.md).
if not same("scope", want_scope): print("scope-mismatch"); raise SystemExit(0)
# The gate nonce is REQUIRED, not merely compared. Adoption skips a fresh review,
# so it must rest on POSITIVE run identity: if either side lacks a nonce we cannot
# prove this watch belongs to the invocation now asking, and the normal
# fresh/resume path owns it. (Studio always sets CAMUS_GATE_NONCE; a direct CLI
# call without one simply never adopts, which is the safe direction.)
meta_nonce = meta.get("gate_nonce")
if not want_nonce or not meta_nonce or str(meta_nonce) != str(want_nonce):
    # Unproven identity NEVER consumes a verdict — but when one exists it also never
    # gets overwritten. Say so, so the caller fails closed instead of restarting.
    foreign = bool(want_nonce) and bool(meta_nonce) and str(meta_nonce) != str(want_nonce)
    print("completed-foreign" if (foreign and _finished_with_verdict) else "nonce-unproven"); raise SystemExit(0)
# A finished round is REPLAYED, never re-run: the re-dispatched agent asked for
# the verdict for this round and it already exists, so paying for a second review would
# be duplicate spend for an answered question.
if finished:
    try:
        has_verdict = os.path.getsize(os.path.join(watch, "last.txt")) > 0
    except OSError:
        has_verdict = False
    if has_verdict and not fp_current:
        # Stale (or, for a legacy watch, unknowable) input: the verdict describes other
        # content. Preserve the attempt and review the CURRENT content exactly once.
        print("stale-input"); raise SystemExit(0)
    print("replay" if has_verdict else "no-verdict"); raise SystemExit(0)
print("adopt")
PY
)"
  if [[ "$adopt_reason" == "replay" ]]; then
    # Re-emit the verdict this round already produced. No codex runs.
    replay_exit="$(cat "$watch_dir/exit_code" 2>/dev/null || echo 0)"
    emit_outcome "{\"state\":\"done\",\"exit\":${replay_exit:-0}}" "$watch_dir" "$target_dir" "$round"
    exit 0
  fi
  # A FINISHED ROUND WE CANNOT PROVE OURS IS A REFUSAL, not a restart. Falling through
  # here would rewrite handle.json/meta.json over a completed watch and pay for a second
  # reviewer; the verdict stays on disk for a human (or a correctly-identified retry).
  # LIVE reviewer on stale content: neither adopt (its verdict would describe code that no
  # longer exists) nor start a competitor. Fail closed and let a human decide.
  if [[ "$adopt_reason" == "live-stale-input" ]]; then
    printf '{"ran": false, "infra_error": "live-stale-input", "handle": "%s", "log_tail": "a reviewer is RUNNING on this round for different worktree content than is present now. Its verdict would not describe the current code, and starting a second reviewer would compete with it. Abort it (review.sh abort %s) or restore the content it is reviewing."}\n' \
      "$watch_dir" "$watch_dir"
    exit 0
  fi
  # COMPLETED verdict for content that has since changed (or a legacy watch with no
  # fingerprint, where sameness is unknowable): never consumed. The attempt is PRESERVED
  # under aN/ and exactly one fresh review runs for the current content.
  if [[ "$adopt_reason" == "stale-input" ]]; then
    # Flag only. The fresh-start path below owns the aN/ move (the resume path's proven
    # mechanism); doing it here was undone by that path's rm -rf of the watch dir.
    preserve_attempt=1
    printf 'camus: worktree content changed since this round was reviewed; preserving the prior attempt and reviewing the current content\n' >&2
  fi
  if [[ "$adopt_reason" == "completed-foreign" ]]; then
    printf '{"ran": false, "infra_error": "%s", "handle": "%s", "log_tail": "this round already has a COMPLETED review on disk, and this invocation cannot prove the watch belongs to it (%s). Refusing to overwrite a finished round or start a second reviewer. The verdict is preserved at %s/last.txt; re-run with the same gate nonce, round, effort and reviewer model to consume it."}\n' \
      "$adopt_reason" "$watch_dir" "$adopt_reason" "$watch_dir"
    exit 0
  fi
  if [[ "$adopt_reason" == "adopt" ]]; then
    # Await the LIVE process on the same bounded chunk the await form uses. This
    # returns its finished verdict, or a pending handle for the next await — never
    # a new process, and never a reset event stream.
    case "$effort" in medium) adopt_chunk=300 ;; *) adopt_chunk=480 ;; esac
    adopt_env="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$adopt_chunk" --idle "$idle_s" 2>/dev/null)"
    emit_outcome "$adopt_env" "$watch_dir" "$target_dir" "$round"
    exit 0
  fi
fi

# The prior attempt's thread_id + recorded reviewer, if any. meta.json is the ONLY
# resume source (THREAD-ONLY recovery, zero local-process awareness): it carries a
# thread_id solely for the terminal abandoned shape (idle_killed/aborted), persisted
# by the await/abort form. There is deliberately NO events.jsonl fallback — a raw
# thread.started does not distinguish a killed thread from a still-running pending one.
prior_thread_id=""
prior_reviewer_model=""
prior_contract='{}'
if [[ -f "$watch_dir/meta.json" ]]; then
  prior_thread_id="$(python3 -c 'import json,sys
try: tid = json.load(open(sys.argv[1])).get("thread_id")
except Exception: tid = None
print(tid if isinstance(tid, str) and tid else "")' "$watch_dir/meta.json" 2>/dev/null)"
  prior_reviewer_model="$(python3 -c 'import json,sys
try: v = json.load(open(sys.argv[1])).get("reviewer_model")
except Exception: v = None
print(v if isinstance(v, str) and v else "")' "$watch_dir/meta.json" 2>/dev/null)"
  prior_contract="$(python3 -c 'import json,sys
try:
    m = json.load(open(sys.argv[1])); assert isinstance(m, dict)
except Exception:
    m = {}
print(json.dumps({k: m.get(k) for k in
    ("contract","scope","qualification","origin","operator","transport","connection")}))' \
    "$watch_dir/meta.json" 2>/dev/null || echo '{}')"
fi
# FAIL-CLOSED resume gate: a thread_id alone is NOT enough — resume fires ONLY on the
# aborted/abandoned SHAPE (thread_id present AND NO completion evidence). Completion
# evidence is the wrapper's exit_code file OR a valid verdict already in last.txt;
# either one BLOCKS resume → the byte-identical fresh path. These prior-attempt files
# sit directly in $watch_dir right now (before the a1/ move below), so read them here.
_last_has_verdict() { # $1 = last.txt path; truthy exit iff a valid verdict is present
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
ok = isinstance(d, dict) and d.get("overall_correctness") in ("patch is correct", "patch is incorrect")
sys.exit(0 if ok else 1)' "$1" 2>/dev/null
}
will_resume=""
if [[ -n "$prior_thread_id" && ! -e "$watch_dir/exit_code" ]] && ! _last_has_verdict "$watch_dir/last.txt"; then
  will_resume="$prior_thread_id"
fi

# Reviewer identity. The prior round's recorded reviewer is AUTHORITATIVE only when we
# are ACTUALLY resuming it (will_resume set) — "old meta.json exists" is not enough,
# because a prior attempt that COMPLETED leaves meta too but is not resumable. On a
# genuine resume a mismatched CAMUS_CODEX_MODEL is refused (rewriting it would make the
# sealed pairing claim a model that never reviewed the earlier rounds) and an absent one
# inherits the recorded model. When this is NOT a resume (no abandoned thread, or the
# prior attempt completed), the prior meta is about to be discarded by the fresh path
# below, so it must NOT govern: the fresh review honors the caller's current
# CAMUS_CODEX_MODEL (or none), never a stale inherited pin. Validate once, here.
effective_reviewer_model="${CAMUS_CODEX_MODEL:-}"
if [[ -n "$will_resume" && -n "$prior_reviewer_model" ]]; then
  if [[ -n "$effective_reviewer_model" && "$effective_reviewer_model" != "$prior_reviewer_model" ]]; then
    echo "codex_review: resume reviewer-model mismatch — round already recorded '$prior_reviewer_model' but CAMUS_CODEX_MODEL is '$effective_reviewer_model'; refusing rather than rewrite the sealed reviewer identity" >&2
    exit 2
  fi
  effective_reviewer_model="$prior_reviewer_model"
fi
if [[ -n "$effective_reviewer_model" && ! "$effective_reviewer_model" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "codex_review: reviewer model is not a valid identifier: '$effective_reviewer_model'" >&2
  exit 2
fi

# ── Assemble the ACTUAL codex args FIRST (before deriving connection/qualification) ──
# The trust tier is derived from what codex REALLY runs, and a model can be pinned by more
# than CAMUS_CODEX_MODEL: a `-m`/`--model` folded into CAMUS_CODEX_ARGS, or the light-model
# ladder below. So the args (and the model-flag detector) must be finalized here, ahead of
# the derivation — otherwise a pinned override would be falsely certified vendor_managed/builtin1.
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
# STUDIO IDENTITY PIN (identity slice): effective_reviewer_model is the reviewer
# model this run pinned — CAMUS_CODEX_MODEL on a fresh run, or the model the round
# already recorded on resume (resolved above, ahead of these args). It is
# AUTHORITATIVE — appended LAST so it wins over any prior lever, and we REFUSE to run
# when a -m is already present (from CAMUS_CODEX_ARGS or the light-model ladder above)
# rather than let a silent override make a sealed pairing lie about what reviewed.
# Appending to the ACTUAL command here — fresh AND resume — is what keeps codex's -m
# identical to the model the audit seals. Use this dedicated channel (or the pin the
# caller recorded), not a -m folded into CAMUS_CODEX_ARGS/CAMUS_CODEX_LIGHT_MODEL.
# Boundary-aware model-flag detection covers every supported Codex spelling: separate,
# attached, and equals forms of -m/--model, plus generic config overrides written as
# `-c model=…`, `-cmodel=…`, `-c=model=…`, `--config model=…`, or `--config=model=…`.
# A custom `model_catalog_json` changes the startup model catalog and is identity-affecting too.
# `model_reasoning_effort=`/`model_provider=` are different keys and do not match.
_has_model_flag() {
  local a
  for a in $1; do
    case "$a" in
      -m|--model|--model=*|-m?*|model=*|model_catalog_json=*|\
      -cmodel=*|-c=model=*|--config=model=*|\
      -cmodel_catalog_json=*|-c=model_catalog_json=*|--config=model_catalog_json=*) return 0 ;;
    esac
  done
  return 1
}
# Non-vendor routing includes CLI selectors/profiles and every supported generic-config spelling for
# model_provider/oss_provider, model_providers.* definitions, and openai_base_url. These are not
# necessarily model pins, but each disqualifies vendor_managed/builtin1: the reviewer can be
# routed away from the built-in vendor connection.
_selects_nonvendor_connection() {
  local a
  for a in $1; do
    case "$a" in
      --oss|--local-provider|--local-provider=*|-p|--profile|--profile=*|-p?*|model_provider=*|oss_provider=*|model_providers.*|openai_base_url=*|\
      -cmodel_provider=*|-c=model_provider=*|--config=model_provider=*|\
      -coss_provider=*|-c=oss_provider=*|--config=oss_provider=*|\
      -cmodel_providers.*|-c=model_providers.*|--config=model_providers.*|\
      -copenai_base_url=*|-c=openai_base_url=*|--config=openai_base_url=*) return 0 ;;
    esac
  done
  return 1
}
# System and managed configuration can override even CLI values. We cannot erase those layers,
# and no stable model name can stand in for Codex's moving built-in default. Conservatively
# disqualify builtin1 whenever any local admin layer is present: parsing only today's routing keys
# would become a bypass when Codex adds another identity-affecting setting. The additive evidence
# path exists for hermetic tests and custom deployments; it can only downgrade, never bypass a
# real system/MDM check.
_managed_or_system_config_present() {
  local p
  for p in /etc/codex/config.toml /etc/codex/managed_config.toml /etc/codex/requirements.toml \
           "${CAMUS_CODEX_MANAGED_CONFIG_EVIDENCE:-}"; do
    [[ -n "$p" && -f "$p" ]] && return 0
  done
  if [[ -n "${ProgramData:-${PROGRAMDATA:-}}" ]]; then
    p="${ProgramData:-${PROGRAMDATA:-}}/OpenAI/Codex"
    [[ -f "$p/managed_config.toml" || -f "$p/requirements.toml" ]] && return 0
  fi
  if [[ "$(uname -s 2>/dev/null)" == "Darwin" && -x /usr/bin/defaults ]]; then
    /usr/bin/defaults read com.openai.codex config_toml_base64 >/dev/null 2>&1 && return 0
    /usr/bin/defaults read com.openai.codex requirements_toml_base64 >/dev/null 2>&1 && return 0
  fi
  return 1
}
if [[ -n "$effective_reviewer_model" ]]; then
  if _has_model_flag "$codex_review_args"; then
    echo "codex_review: reviewer model ($effective_reviewer_model) conflicts with a -m/--model already in the review args — refusing rather than silently override the recorded reviewer identity" >&2
    exit 2
  fi
  codex_review_args="$codex_review_args -m $effective_reviewer_model"
fi

# ── DERIVE connection + qualification from what ACTUALLY runs (REVIEW-CONTRACT.md) ──
# Every fresh/resumed Codex child below receives --ignore-user-config, a per-call untrusted-project
# override, and OPENAI_BASE_URL removal; authentication still comes from CODEX_HOME. Therefore
# user/project config or a shell redirect cannot silently re-point a supposedly builtin1 review.
# Explicit CLI profiles/overrides and identity-affecting system config remain supported but are
# classified configured/qual1 above.
# connection is `vendor_managed` only when the built-in codex backend runs with NO pinned
# model AT ALL and over the built-in vendor connection — not merely no CAMUS_CODEX_MODEL, but
# no `-m`/`--model` (including compact/attached config forms) folded in via CAMUS_CODEX_ARGS, no
# light-model ladder, and no non-vendor connection selector (`--oss`/`--local-provider`/
# provider/base-URL config override) either (all checked against the FINAL args above). Any pinned model
# (from any source), alternate connection, or alternate backend is `configured`. qualification is
# `builtin1` ONLY for the exact built-in codex backend over a vendor_managed connection — the
# unmodified built-in gate; everything configurable is `qual1`. Derived here (not echoed from
# the request), AFTER the real args are assembled, so a model pinned by any lever downgrades the
# tier truthfully and asGate catches a review whose actual reviewer drifted from the requested one.
if [[ "${CAMUS_REVIEW_BACKEND:-codex}" == "codex" ]] \
   && ! _has_model_flag "$codex_review_args" \
   && ! _selects_nonvendor_connection "$codex_review_args" \
   && ! _managed_or_system_config_present; then
  review_connection="vendor_managed"
else
  review_connection="configured"
fi
if [[ "${CAMUS_REVIEW_BACKEND:-codex}" == "codex" && "$review_connection" == "vendor_managed" ]]; then
  review_qualification="builtin1"
else
  review_qualification="qual1"
fi
# A resumed thread keeps the prompt and execution context it started with. Relabeling it with
# today's request would let an rc0/light/qual1 attempt masquerade as rc1/full/builtin1. Compare
# every carried field before meta.json is rewritten or `codex exec resume` is launched; missing
# legacy fields are drift too. Refuse rather than resume or silently pay for a fresh review.
if [[ -n "$will_resume" ]]; then
  resume_contract_drift="$(python3 -c 'import json,sys
names = ("contract","scope","qualification","origin","operator","transport","connection")
try: prior = json.loads(sys.argv[1]); assert isinstance(prior, dict)
except Exception: prior = {}
current = dict(zip(names, sys.argv[2:]))
bad = ["%s: prior=%r current=%r" % (k, prior.get(k), current[k])
       for k in names if prior.get(k) != current[k]]
print("; ".join(bad))' "$prior_contract" "$review_contract" "$review_scope" \
    "$review_qualification" "$review_origin" "$review_operator" \
    "$review_transport" "$review_connection" 2>/dev/null || echo 'unreadable prior contract')"
  if [[ -n "$resume_contract_drift" ]]; then
    echo "codex_review: resume contract drift — $resume_contract_drift; refusing rather than relabel the prior thread" >&2
    exit 2
  fi
fi
# Fold the full contract bundle into CAMUS_REVIEW_BINDING so the AUDIT record (which reads
# it from the environment) carries the actuals too, not just round/effort/nonce.
export CAMUS_REVIEW_BINDING="$(printf '%s' "$binding" | python3 -c 'import json,sys
try: b = json.load(sys.stdin)
except Exception: b = {}
b.update({
    "contract": sys.argv[1], "scope": sys.argv[2], "qualification": sys.argv[3],
    "origin": sys.argv[4], "operator": sys.argv[5], "transport": sys.argv[6],
    "connection": sys.argv[7],
})
print(json.dumps(b))' "$review_contract" "$review_scope" "$review_qualification" \
  "$review_origin" "$review_operator" "$review_transport" "$review_connection" 2>/dev/null || printf '%s' "$binding")"

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

# prior_thread_id, will_resume, and the reviewer identity were all resolved ABOVE, before
# the model args — the model codex runs with must be decided by then, and resume-ness now
# gates whether the prior reviewer governs. THREAD-ONLY recovery (that block): meta.json is
# the only resume source and no pid is ever read, so a reused/live unrelated PID can never
# influence whether a thread is resumed, and a prior attempt that left a bare thread.started
# but no persisted meta id (a still-in-flight pending review) is un-resumable → fresh. The
# fail-closed gate there (thread_id present AND no exit_code/last.txt verdict) uses the same
# completion oracle adapter.normalize_codex does. What remains here is the physical dir prep.

# A resume must not clobber the aborted attempt's events.jsonl (the thread_id source + audit):
# preserve it under a1/ instead of deleting the round dir. No resume (no prior thread, or completion
# evidence present) → the original rm-and-recreate, so the fresh path is byte-identical.
# PRESERVE, never destroy, a prior attempt's evidence — for a resume, and for a completed
# round whose reviewed content has since changed (audit 2026-08-06). The index is the next
# free one so a second occurrence cannot clobber the first, and meta.json travels with it so
# each attempt keeps the identity AND the input fingerprint it was judged under.
if [[ -n "$will_resume" || -n "${preserve_attempt:-}" ]]; then
  _an=1
  while [[ -e "$watch_dir/a$_an" ]]; do _an=$((_an+1)); done
  mkdir -p "$watch_dir/a$_an" 2>/dev/null || true
  for _f in events.jsonl err.log exit_code handle.json last.txt meta.json; do
    [[ -e "$watch_dir/$_f" ]] && mv -f "$watch_dir/$_f" "$watch_dir/a$_an/" 2>/dev/null || true
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
# NO thread_id is seeded here. meta.json carries a thread_id ONLY once `_persist_thread_id` writes
# one, and that writer fires ONLY on a terminal abandoned envelope (idle_killed/aborted) from the
# await/abort form. Seeding the live thread at start would make an in-flight thread (a pending review
# or a still-running resume) look terminally abandoned to a LATER recovery, which could then resume a
# thread that was never idle-killed or watchdog-aborted (the "only aborted/abandoned evidence" trigger
# violation). So this seed writes audit identity only; the abandoned-shape gate stays the sole source
# of a resumable id.
# Persist the reviewer identity resolved above (env pin, or the model this round
# recorded on a prior attempt). It is the SAME model already appended to
# codex_review_args, so the pending/resumed/await paths all seal exactly the model
# codex ran with. An await/resume without the env preserves it; a mismatched resume
# was already refused above.
python3 -c 'import json,sys
m = {"target_dir": sys.argv[2], "round": sys.argv[3], "effort": sys.argv[4], "scope": sys.argv[5]}
if len(sys.argv) > 6 and sys.argv[6]:
    m["reviewer_model"] = sys.argv[6]  # persist the pinned reviewer so pending/resumed paths carry it
# The gate nonce identifies the RUN this watch belongs to, so a reattach can prove
# a live watch is ours before adopting it rather than starting a second reviewer.
if len(sys.argv) > 7 and sys.argv[7]:
    m["gate_nonce"] = sys.argv[7]
# WHAT was reviewed, not just who by. A replay is only valid for identical input.
if len(sys.argv) > 8 and sys.argv[8]:
    m["input_fingerprint"] = sys.argv[8]
# REVIEW-CONTRACT (rc1) fields sealed here so await/adopt/replay rebuild the emitted
# binding from meta.json with identical values across every boundary.
for _i, _k in ((9, "contract"), (10, "qualification"), (11, "origin"),
               (12, "operator"), (13, "transport"), (14, "connection")):
    if len(sys.argv) > _i and sys.argv[_i]:
        m[_k] = sys.argv[_i]
json.dump(m, open(sys.argv[1], "w"), indent=2)' \
  "$watch_dir/meta.json" "$target_dir" "$round" "$effort" "$scope" "$effective_reviewer_model" "${CAMUS_GATE_NONCE:-}" "${input_fp:-}" \
  "$review_contract" "$review_qualification" "$review_origin" "$review_operator" "$review_transport" "$review_connection"

# FAST START, BOUNDED AWAITS. This first chunk used to be the FULL window (300s
# medium / 480s high), so the thin reviewer agent sat holding an eight-minute
# shell wait — a deterministic sleep parked inside a model turn. That is what made
# reattachment so damaging: the outer Workflow going async re-dispatched an agent
# that was doing nothing but waiting, and the wait restarted (live run
# 20260805-072933-jezu). The start now returns quickly with a pending handle, and
# the AWAIT form (which is cheap and re-attachable) owns the long waiting on its
# own bounded chunks. Total review time is unchanged; the time is simply not held
# inside a model agent. Override with CAMUS_REVIEW_START_CHUNK_S.
chunk="${CAMUS_REVIEW_START_CHUNK_S:-120}"

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
if [[ -n "$will_resume" ]]; then
  resume_last="$last_file"
  resume_prompt="Resume this review and emit the final verdict JSON per the schema now."
  # shellcheck disable=SC2086
  r_start="$(python3 "$here/review_watch.py" start --handle "$watch_dir" --last "$resume_last" -- \
    env -u OPENAI_BASE_URL codex exec resume "$will_resume" --ignore-user-config "${project_trust_args[@]}" --json ${codex_review_args} --output-schema "$schema" -o "$resume_last" "$resume_prompt" 2>>"$watch_dir/err.log")"
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
  # Clear the recorded thread_id NOW (constraint 3, conf 0.88): this thread is dead/abandoned, so
  # drop it from meta.json (keep target_dir/round/effort/scope) the moment we give up on it. A prior
  # persisted id can sit here (the await/abort form that fed this resume wrote one for the abandoned
  # shape); the fresh `start` below seeds NO thread_id, so without this clear a LATER recovery would
  # read the now-dead resumed thread's id and try to resurrect it. Clearing it forces that recovery to
  # find NO thread to resume and go fresh, never resuming a thread that was not freshly idle-killed.
  python3 -c 'import json,sys
try:
    m = json.load(open(sys.argv[1]))
    if not isinstance(m, dict): m = {}
except Exception:
    m = {}
m.pop("thread_id", None)
json.dump(m, open(sys.argv[1], "w"), indent=2)' "$watch_dir/meta.json" 2>/dev/null || true
fi

# shellcheck disable=SC2086
start_env="$(python3 "$here/review_watch.py" start --handle "$watch_dir" --last "$last_file" -- \
  env -u OPENAI_BASE_URL codex exec --ignore-user-config "${project_trust_args[@]}" --json -s read-only ${codex_review_args} --output-schema "$schema" -o "$last_file" "$prompt" 2>>"$watch_dir/err.log")"
if ! printf '%s' "$start_env" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("state")=="started" else 1)' 2>/dev/null; then
  emit_outcome "${start_env:-{\"state\":\"error\",\"error\":\"start produced no envelope\"}}" "$watch_dir" "$target_dir" "$round"
  exit 0
fi

envelope="$(python3 "$here/review_watch.py" await --handle "$watch_dir" --chunk "$chunk" --idle "$idle_s" 2>/dev/null)"
# First-attempt idle-kills are abandoned threads too (refine finding, conf 0.84): persist the
# envelope's thread id under the SAME aborted/abandoned-only gate as the await/abort entrypoint
# (the helper is shared and pinned there), or the next recovery has no meta.json thread_id to
# resume — events.jsonl is deliberately NOT a resume source (thread-only recovery).
_start_state="$(printf '%s' "$envelope" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except Exception: print("")' 2>/dev/null)"
if [[ "$_start_state" == "idle_killed" || "$_start_state" == "aborted" ]]; then
  _persist_thread_id "$watch_dir/meta.json" "$(_envelope_thread_id "$envelope")"
fi
emit_outcome "$envelope" "$watch_dir" "$target_dir" "$round"
