#!/usr/bin/env bash
# ADOPTION REGRESSION (live run 20260805-072933-jezu, Workflow wf_421fa834-26d).
#
# When the outer Workflow goes asynchronous, Studio reattaches by resuming the
# igniter session — which re-dispatches the workflow's PENDING review agent, so
# this script runs AGAIN with identical arguments. Before the adoption block that
# started a second codex for a review already running: r1 started twice, r2
# started twice, and the round-2 event stream reset from 30 events back to 7.
#
# This drives the REAL review.sh through two reattachments of one in-flight
# review with a spy codex that runs long enough to still be alive across them.
# Passing requires: ONE reviewer start, an unchanged PID/handle, a monotonically
# GROWING event stream (never truncated), no duplicate spend, and the eventual
# verdict consumed exactly once.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d)"
# The fixtures below live in their OWN process groups (setsid), so `pkill -g 0`
# cannot reach them — kill each fixture group explicitly so an early exit never
# leaks a `sleep`. Single quotes: the pids expand at EXIT time, when they are set.
trap 'pkill -g 0 -f cls-spy-codex 2>/dev/null;
      [ -n "${STRANGER:-}" ] && kill -9 -"$STRANGER" 2>/dev/null;
      [ -n "${OWNED_LEADER:-}" ] && kill -9 -"$OWNED_LEADER" 2>/dev/null;
      rm -rf "$ROOT"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1  (expected [$2], got [$3])"; fi; }
gitq() { git -c user.email=t@t -c user.name=t "$@"; }

R="$ROOT/repo"; mkdir -p "$R"; cd "$R"
gitq init -q; echo old > f.txt; gitq add -A; gitq commit -qm init
gitq worktree add -q -b camus/feat/x/task "$ROOT/camus-wt-task" >/dev/null 2>&1
WT="$ROOT/camus-wt-task"; echo new > "$WT/f.txt"
export CAMUS_REVIEW_DIR="$ROOT/reviews"; mkdir -p "$CAMUS_REVIEW_DIR"
export CAMUS_REVIEW_START_CHUNK_S=2   # fast start: return a pending handle quickly
export CAMUS_REVIEW_IDLE_S=120
NONCE="salt:adopt1"; MODEL="gpt-5.6-sol"

# Spy codex: emits events slowly, stays alive well past the start chunk, and
# records every invocation so a second start is detectable.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
# cls-spy-codex
echo "start" >> "$ROOT/starts.log"
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
echo '{"type":"thread.started","thread_id":"th_spy"}'
for i in 1 2 3 4 5 6 7 8; do
  echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"summary\":\"step \$i\"}}"
  sleep 1
done
[ -n "\$out" ] && printf '%s' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"spy","overall_confidence_score":0.9}' > "\$out"
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
EOF
chmod +x "$ROOT/bin/codex"; export PATH="$ROOT/bin:$PATH"

WATCH="$CAMUS_REVIEW_DIR/$(basename "$WT")-r2.watch"
events_count() { [ -f "$WATCH/events.jsonl" ] && grep -c "" "$WATCH/events.jsonl" 2>/dev/null || echo 0; }
handle_pid() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("pid",""))
except Exception: print("")' "$WATCH/handle.json" 2>/dev/null; }
run_review() {
  python3 "$here/review_request.py" write --worktree "$WT" --round 2 --effort high \
    --nonce "$NONCE" --model "$MODEL" --backend codex >/dev/null
  CAMUS_GATE_NONCE="$NONCE" CAMUS_REVIEW_ROUND=2 CAMUS_REVIEW_EFFORT=high CAMUS_CODEX_MODEL="$MODEL" \
    bash "$here/review.sh" "$WT" "task ctx" 2 high 2>/dev/null
}
is_pending() { printf '%s' "$1" | python3 -c 'import json,sys
try: print("yes" if json.load(sys.stdin).get("pending") is True else "no")
except Exception: print("no")'; }

# ── TURN 1: the original dispatch starts the review and returns fast.
out1="$(run_review)"
check "the first dispatch returns a pending handle (fast start, no 8-minute hold)" "yes" "$(is_pending "$out1")"
pid1="$(handle_pid)"; ev1="$(events_count)"; starts1="$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"
check "exactly ONE reviewer was started" "1" "$starts1"

# ── TURN 2: outer Workflow went async → the pending review agent is re-dispatched.
out2="$(run_review)"
pid2="$(handle_pid)"; ev2="$(events_count)"; starts2="$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"
check "reattach 1 does NOT start a second reviewer (no duplicate spend)" "1" "$starts2"
check "reattach 1 keeps the SAME pid" "$pid1" "$pid2"
check "reattach 1 never truncates the event stream" "yes" "$([ "$ev2" -ge "$ev1" ] && echo yes || echo no)"

# ── TURN 3: a SECOND outer reattachment of the same in-flight review.
out3="$(run_review)"
pid3="$(handle_pid)"; ev3="$(events_count)"; starts3="$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"
check "reattach 2 still starts no new reviewer" "1" "$starts3"
check "reattach 2 keeps the SAME pid" "$pid1" "$pid3"
check "the event stream grew monotonically across both reattachments" "yes" "$([ "$ev3" -ge "$ev2" ] && echo yes || echo no)"

# ── The verdict is eventually produced and consumed ONCE.
verdict=""
for _ in $(seq 1 30); do
  v="$(run_review)"
  if [ "$(is_pending "$v")" = "no" ]; then verdict="$v"; break; fi
done
check "the review eventually returns a real verdict, not an endless restart" "yes" "$([ -n "$verdict" ] && echo yes || echo no)"
check "…and it ran (a usable gate verdict)" "True" "$(printf '%s' "$verdict" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("ran"))
except Exception: print("unreadable")')"
check "still exactly ONE reviewer start for the whole round" "1" "$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"
check "the round's audit receipt exists exactly once" "1" "$(ls "$CAMUS_REVIEW_DIR" | grep -c -- "-r2\.json$")"

# ── STALE HANDLE → a harmless unrelated live process. The pid in handle.json is
# alive, but it is NOT our reviewer (its real start time does not match the
# handle's started_at). Adoption must not adopt it, await must not wait on it,
# abort must not signal it — and in every case the stranger stays alive.
STRANGER_DIR="$CAMUS_REVIEW_DIR/$(basename "$WT")-r4.watch"
mkdir -p "$STRANGER_DIR"
# A genuine session leader (pid == pgid), exactly like a real detached reviewer,
# so the GROUP paths actually see it. It is launched FROM THIS SHELL and kept as
# our child: a `python3 -c` that exits immediately gets its orphan reaped in this
# sandbox, which silently emptied the fixture and made the checks below vacuous.
# setsid() makes it session+group leader, then exec preserves that pid.
python3 -c 'import os; os.setsid(); os.execvp("sleep", ["sleep", "300"])' &
STRANGER=$!
sleep 0.5
echo > "$ROOT/starts.log"
# started_at an hour ago: whatever lives at $STRANGER now provably is not the
# process this handle recorded.
export WT_PATH="$WT" MODEL_NAME="$MODEL" NONCE_VAL="$NONCE"
python3 - "$STRANGER_DIR" "$STRANGER" <<'PY'
import json, os, sys, time
d, pid = sys.argv[1], int(sys.argv[2])
json.dump({"pid": pid, "started_at": int(time.time()) - 3600, "cmd": ["codex"], "cwd": d},
          open(os.path.join(d, "handle.json"), "w"))
json.dump({"target_dir": os.environ["WT_PATH"], "round": "4", "effort": "high", "scope": "full",
           "reviewer_model": os.environ["MODEL_NAME"], "gate_nonce": os.environ["NONCE_VAL"]},
          open(os.path.join(d, "meta.json"), "w"))
PY
python3 "$here/review_request.py" write --worktree "$WT" --round 4 --effort high \
  --nonce "$NONCE" --model "$MODEL" --backend codex >/dev/null
out_stale="$(CAMUS_GATE_NONCE="$NONCE" CAMUS_REVIEW_ROUND=4 CAMUS_REVIEW_EFFORT=high CAMUS_CODEX_MODEL="$MODEL" \
  bash "$here/review.sh" "$WT" "task ctx" 4 high 2>/dev/null)"
check "a stale handle over an unrelated live process is NOT adopted (a fresh reviewer runs)" \
  "1" "$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"
check "…and the unrelated process is never signalled by the default form" \
  "yes" "$(kill -0 "$STRANGER" 2>/dev/null && echo yes || echo no)"
# The await form on the same stale handle: returns done/infra without waiting on
# or killing the stranger.
mkdir -p "$STRANGER_DIR"  # the fresh path archived it; recreate the stale shape for the direct forms
python3 - "$STRANGER_DIR" "$STRANGER" <<'PY'
import json, os, sys, time
d, pid = sys.argv[1], int(sys.argv[2])
json.dump({"pid": pid, "started_at": int(time.time()) - 3600, "cmd": ["codex"], "cwd": d},
          open(os.path.join(d, "handle.json"), "w"))
PY
await_state="$(bash "$here/review.sh" await "$STRANGER_DIR" 2>/dev/null | python3 -c 'import json,sys
try:
    v=json.load(sys.stdin)
    print("pending" if v.get("pending") else ("infra" if v.get("ran") is False else "other"))
except Exception: print("unreadable")')"
check "the await form does not wait on the stranger (explicit infra, never pending)" \
  "infra" "$await_state"
check "…and the stranger survives the await form" \
  "yes" "$(kill -0 "$STRANGER" 2>/dev/null && echo yes || echo no)"
bash "$here/review.sh" abort "$STRANGER_DIR" >/dev/null 2>&1
check "the abort form refuses to signal an unverified pid (the stranger survives abort)" \
  "yes" "$(kill -0 "$STRANGER" 2>/dev/null && echo yes || echo no)"
kill -9 "$STRANGER" 2>/dev/null
wait "$STRANGER" 2>/dev/null || true   # reap it quietly: bash otherwise prints a "Killed" job notice

# ── LEADERLESS AWAIT: the leader died without a verdict, its child survives in
# the group. An await that just reported "done" would walk away and orphan the
# child; it must instead terminate the owned group and return infra.
ORPHAN_DIR="$CAMUS_REVIEW_DIR/$(basename "$WT")-r5.watch"
mkdir -p "$ORPHAN_DIR"
# The leaderless-group shape, built from real processes: a session leader
# (setsid → pid == pgid) spawns a child into its own group and then EXITS, so the
# pgid survives with only the child in it. Launched from this shell for the same
# reaping reason as the stranger above; `wait` guarantees the leader is gone
# before the assertions run.
python3 -c 'import os, subprocess; os.setsid(); subprocess.Popen(["sleep", "120"])' &
OWNED_LEADER=$!
wait "$OWNED_LEADER" 2>/dev/null || true
group_count() { ps -g "$1" -o pid= 2>/dev/null | grep -c "[0-9]" || true; }
check "PRECONDITION: the leader is dead but a child survives in its group" \
  "yes" "$([ "$(group_count "$OWNED_LEADER")" -ge 1 ] && ! kill -0 "$OWNED_LEADER" 2>/dev/null && echo yes || echo no)"
# A VALID meta.json matters: the await entrypoint authenticates the handle against
# it first, so without one this test would pass on the dispatcher's invalid-handle
# refusal and never reach cmd_await at all — a vacuous green over the very code
# path under test.
python3 - "$ORPHAN_DIR" "$OWNED_LEADER" <<'PY2'
import json, os, sys, time
d, pid = sys.argv[1], int(sys.argv[2])
json.dump({"pid": pid, "started_at": int(time.time()), "cmd": ["codex"], "cwd": d},
          open(os.path.join(d, "handle.json"), "w"))
json.dump({"target_dir": os.environ["WT_PATH"], "round": "5", "effort": "high", "scope": "full",
           "reviewer_model": os.environ["MODEL_NAME"], "gate_nonce": os.environ["NONCE_VAL"]},
          open(os.path.join(d, "meta.json"), "w"))
PY2
orphan_err="$(bash "$here/review.sh" await "$ORPHAN_DIR" 2>/dev/null | python3 -c 'import json,sys
try:
    v=json.load(sys.stdin)
    print(v.get("error","") if v.get("ran") is False else ("PENDING" if v.get("pending") else "NOT-INFRA"))
except Exception: print("unreadable")')"
# Require the SPECIFIC message from cmd_await\x27s verified-group branch, not merely
# any ran:false — that is what proves the call reached the code under test.
check "leaderless await terminated the verified group and said so (reached cmd_await, not the handle guard)" \
  "yes" "$(printf '%s' "$orphan_err" | grep -q 'surviving process group was terminated' && echo yes || echo no)"
check "…and the owned child group is gone, not orphaned" "0" "$(group_count "$OWNED_LEADER")"

# ── A DIFFERENT identity must NOT be adopted: that is a different review.
echo > "$ROOT/starts.log"
rm -rf "$CAMUS_REVIEW_DIR/$(basename "$WT")-r3.watch"
python3 "$here/review_request.py" write --worktree "$WT" --round 3 --effort high \
  --nonce "other-run:zzz" --model "$MODEL" --backend codex >/dev/null
CAMUS_GATE_NONCE="other-run:zzz" CAMUS_REVIEW_ROUND=3 CAMUS_REVIEW_EFFORT=high CAMUS_CODEX_MODEL="$MODEL" \
  bash "$here/review.sh" "$WT" "task ctx" 3 high >/dev/null 2>&1
check "a different round starts its own reviewer (adoption is not a catch-all)" "1" "$(grep -c start "$ROOT/starts.log" 2>/dev/null || echo 0)"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
