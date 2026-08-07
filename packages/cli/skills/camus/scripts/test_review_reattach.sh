#!/usr/bin/env bash
# REATTACH SEAM (production run 20260806-063400-vzqs). Round 1 completed with three
# findings; the outer Workflow then went async and re-dispatched the reviewer agent, which
# re-ran the SAME start command. Instead of consuming the finished round, the gate
# overwrote handle.json/meta.json and paid for a SECOND Codex review (pid 45073 → 71857),
# which Studio's Stop later had to kill.
#
# This drives the REAL review.sh through the REAL request-file/env/argv channels with a
# spy `codex` that COUNTS its invocations, so the assertions are about the actual seam:
#   1. a start runs exactly one reviewer, at the PINNED effort, with a bound nonce
#   2. re-running the same start (the reattach) REPLAYS — zero new processes, evidence intact
#   3. an invocation that cannot prove the watch is its own REFUSES — it neither consumes
#      the verdict nor overwrites the finished round
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1  (expected [$2], got [$3])"; fi; }
gitq() { git -c user.email=t@t -c user.name=t "$@"; }

R="$ROOT/repo"; mkdir -p "$R"; cd "$R"
gitq init -q; echo old > f.txt; gitq add -A; gitq commit -qm init
gitq worktree add -q -b camus/feat/x/task "$ROOT/camus-wt-task" >/dev/null 2>&1
WT="$ROOT/camus-wt-task"
echo new > "$WT/f.txt"
export CAMUS_REVIEW_DIR="$ROOT/reviews"; mkdir -p "$CAMUS_REVIEW_DIR"

# Spy codex: counts invocations and records the reasoning effort it was actually given.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
echo "invocation" >> "$ROOT/codex_calls"
for a in "\$@"; do case "\$a" in model_reasoning_effort=*) echo "\${a#model_reasoning_effort=}" >> "$ROOT/codex_efforts" ;; esac; done
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
[ -n "\$out" ] && printf '%s' '{"findings":[{"priority":1,"title":"real finding","code_location":"f.txt:1","body":"b","confidence_score":0.9}],"overall_correctness":"patch is incorrect","overall_explanation":"spy","overall_confidence_score":0.9}' > "\$out"
echo '{"type":"thread.started","thread_id":"th_spy"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
EOF
chmod +x "$ROOT/bin/codex"
export PATH="$ROOT/bin:$PATH"
: > "$ROOT/codex_calls"; : > "$ROOT/codex_efforts"
calls() { wc -l < "$ROOT/codex_calls" | tr -d ' '; }

NONCE="salt:vzqs"; MODEL="gpt-5.6-terra"; EFFORT="medium"
jf() { python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); raise SystemExit(0)
v=d.get(sys.argv[2]); print("" if v is None else v)' "$1" "$2" 2>/dev/null; }
jout() { python3 -c 'import json,sys
raw=sys.stdin.read()
i=raw.find("{")
try: d=json.loads(raw[i:]) if i>=0 else {}
except Exception: d={}
v=d.get(sys.argv[1]); print("" if v is None else (json.dumps(v) if not isinstance(v,str) else v))' "$1"; }

# One start, at the PINNED effort, through all three channels the gate cross-checks.
run_start() { # $1 = nonce ('' = none)  $2 = task ctx (default)  $3 = scope (default full)
  local n="$1" task="${2:-a task}" sc="${3:-full}"
  python3 "$here/review_request.py" write --worktree "$WT" --round 1 --effort "$EFFORT" \
    ${n:+--nonce "$n"} --model "$MODEL" --backend codex >/dev/null 2>&1
  env ${n:+CAMUS_GATE_NONCE="$n"} CAMUS_REVIEW_ROUND=1 CAMUS_REVIEW_EFFORT="$EFFORT" \
    CAMUS_CODEX_MODEL="$MODEL" \
    CAMUS_REVIEW_START_CHUNK_S=25 \
    bash "$here/review.sh" "$WT" "$task" 1 "$EFFORT" "$sc" 2>/dev/null
}

echo "test_review_reattach:"

out1="$(run_start "$NONCE")"
WATCH="$CAMUS_REVIEW_DIR/camus-wt-task-r1.watch"
check "the start runs EXACTLY one reviewer" "1" "$(calls)"
check "at the PINNED effort, in the real process args" "$EFFORT" "$(head -1 "$ROOT/codex_efforts" 2>/dev/null)"
check "meta.json records that same effort" "$EFFORT" "$(jf "$WATCH/meta.json" effort)"
check "meta.json carries the gate nonce (binding evidence)" "$NONCE" "$(jf "$WATCH/meta.json" gate_nonce)"
check "the round reports ran:true" "true" "$(printf '%s' "$out1" | jout ran)"
h_pid="$(jf "$WATCH/handle.json" pid)"; h_start="$(jf "$WATCH/handle.json" started_at)"
verdict_sum="$(shasum "$WATCH/last.txt" 2>/dev/null | cut -d' ' -f1)"
check "a completed verdict exists on disk" "1" "$([ -s "$WATCH/last.txt" ] && echo 1 || echo 0)"

# THE REATTACH: the outer Workflow re-dispatches the agent, which re-runs the SAME command.
out2="$(run_start "$NONCE")"
check "reattach spawns NO second reviewer" "1" "$(calls)"
check "reattach does not overwrite handle.json pid" "$h_pid" "$(jf "$WATCH/handle.json" pid)"
check "…nor its start time" "$h_start" "$(jf "$WATCH/handle.json" started_at)"
check "…nor the completed verdict" "$verdict_sum" "$(shasum "$WATCH/last.txt" 2>/dev/null | cut -d' ' -f1)"
check "…nor the sealed nonce" "$NONCE" "$(jf "$WATCH/meta.json" gate_nonce)"
check "…nor the sealed effort" "$EFFORT" "$(jf "$WATCH/meta.json" effort)"
check "the reattach still returns the round's verdict" "1" "$(printf '%s' "$out2" | grep -c '"ran"' )"

# A FOREIGN RUN (a different gate nonce) must not touch this completed round at all: it
# neither consumes the verdict nor overwrites the evidence. This is the WP8 shape — a second
# dispatch landing on a finished r1 watch.
out3="$(run_start "salt:someone-elses-run")"
check "a FOREIGN run spawns NO reviewer over a completed round" "1" "$(calls)"
check "…and refuses instead of running" "false" "$(printf '%s' "$out3" | jout ran)"
check "…naming the completed round it will not touch" "1" "$(printf '%s' "$out3" | grep -c 'already has a COMPLETED review')"
check "…leaving the verdict on disk" "$verdict_sum" "$(shasum "$WATCH/last.txt" 2>/dev/null | cut -d' ' -f1)"
check "…and the handle untouched" "$h_pid" "$(jf "$WATCH/handle.json" pid)"
check "…and the nonce untouched" "$NONCE" "$(jf "$WATCH/meta.json" gate_nonce)"

# ── THE REPLAY IS BOUND TO THE EXACT REVIEWED INPUT ────────────────────────────────
# meta.json recorded WHO reviewed and at what effort, but nothing about WHAT — so a stopped
# gate could change the worktree, restart with the same custody identity, and have the old
# verdict replayed as current (audit 2026-08-06).
fp1="$(jf "$WATCH/meta.json" input_fingerprint)"
fp1_ok=0
[ "${fp1#fp1:}" != "$fp1" ] && [ ${#fp1} -eq 68 ] && fp1_ok=1
check "meta.json fingerprints the reviewed input, VERSIONED" "1" "$fp1_ok"

# 3. A TRACKED file changes: the old verdict must NOT be consumed. One fresh review runs,
#    the prior attempt is preserved, and the fingerprint/result become current.
echo "mutated by the maker" >> "$WT/f.txt"
out4="$(run_start "$NONCE")"
check "a tracked-file change starts exactly ONE fresh review (2 total)" "2" "$(calls)"
check "…the prior attempt is PRESERVED under a1/" "1" "$([ -s "$WATCH/a1/last.txt" ] && echo 1 || echo 0)"
check "…with the verdict it produced, byte-identical" "$verdict_sum" "$(shasum "$WATCH/a1/last.txt" 2>/dev/null | cut -d' ' -f1)"
check "…and the attempt's own meta beside it" "$fp1" "$(jf "$WATCH/a1/meta.json" input_fingerprint)"
fp2="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…the live fingerprint MOVED to the new content" "1" "$([ -n "$fp2" ] && [ "$fp2" != "$fp1" ] && echo 1 || echo 0)"
check "…and the round reports a fresh result" "true" "$(printf '%s' "$out4" | jout ran)"

# 4. An UNTRACKED new file is part of the review (intent-to-add makes it visible), so it must
#    move the fingerprint too — otherwise a whole new file could ride a stale verdict.
verdict2="$(shasum "$WATCH/last.txt" 2>/dev/null | cut -d' ' -f1)"
printf 'brand new deliverable\n' > "$WT/added.txt"
out5="$(run_start "$NONCE")"
check "an UNTRACKED new file also starts one fresh review (3 total)" "3" "$(calls)"
check "…preserving that attempt under a2/" "$verdict2" "$(shasum "$WATCH/a2/last.txt" 2>/dev/null | cut -d' ' -f1)"
fp3="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…and moving the fingerprint again" "1" "$([ -n "$fp3" ] && [ "$fp3" != "$fp2" ] && echo 1 || echo 0)"

# Unchanged again → replay, no fourth reviewer.
out6="$(run_start "$NONCE")"
check "unchanged content still REPLAYS (still 3)" "3" "$(calls)"
check "…and the fingerprint is unchanged" "$fp3" "$(jf "$WATCH/meta.json" input_fingerprint)"

# 5. A LEGACY completed watch with no fingerprint: sameness is unknowable, so it must never
#    be replayed as current.
python3 - "$WATCH/meta.json" <<'PYX'
import json,sys
m=json.load(open(sys.argv[1])); m.pop("input_fingerprint", None)
json.dump(m, open(sys.argv[1],"w"), indent=2)
PYX
out7="$(run_start "$NONCE")"
check "a LEGACY watch with no fingerprint is NOT replayed (4 total)" "4" "$(calls)"
check "…its attempt is preserved too" "1" "$([ -s "$WATCH/a3/last.txt" ] && echo 1 || echo 0)"
fp4="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…and the fresh round records a versioned fingerprint again" "68" "${#fp4}"

# ── THE FINGERPRINT BINDS THE WHOLE QUESTION, NOT JUST THE FILES ───────────────────
# It is taken after the prompt is assembled, so the TASK CONTEXT and the normalized SCOPE are
# inside it. A different question about identical content is a different review.
fpA="$(jf "$WATCH/meta.json" input_fingerprint)"
# Same LENGTH as "a task", different content — so this only passes if the prompt BYTES
# are in the digest, not merely its length.
out8="$(run_start "$NONCE" "b task")"
calls_after_task="$(calls)"
check "a changed TASK starts a fresh review (identical files)" "5" "$calls_after_task"
fpB="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…and moves the fingerprint" "1" "$([ -n "$fpB" ] && [ "$fpB" != "$fpA" ] && echo 1 || echo 0)"
out9="$(run_start "$NONCE" "b task" light)"
check "a changed SCOPE starts a fresh review too" "6" "$(calls)"
fpC="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…and moves the fingerprint again" "1" "$([ -n "$fpC" ] && [ "$fpC" != "$fpB" ] && echo 1 || echo 0)"
out10="$(run_start "$NONCE" "b task" light)"
check "the same task+scope+content REPLAYS (still 6)" "6" "$(calls)"

# A FORCED diff failure must fail closed: no replay, no start, no stored sentinel.
fp_before="$(jf "$WATCH/meta.json" input_fingerprint)"
mkdir -p "$ROOT/badbin"
printf '#!/usr/bin/env bash\nexit 3\n' > "$ROOT/badbin/git"; chmod +x "$ROOT/badbin/git"
out11="$(PATH="$ROOT/badbin:$PATH" run_start "$NONCE" "b task" light)"
check "a broken git fails CLOSED (no reviewer)" "6" "$(calls)"
check "…reporting ran:false" "false" "$(printf '%s' "$out11" | jout ran)"
_r11="$(printf '%s' "$out11" | jout infra_error)$(printf '%s' "$out11" | jout error)"
check "…as an infra refusal, not a verdict" "1" "$([ -n "$_r11" ] && echo 1 || echo 0)"
# NOTE: with git unusable the TARGET GUARD refuses before the fingerprint layer is reached,
# so the message comes from there. What matters is the contract, asserted above and below:
# ran:false, no reviewer started, no sentinel stored, the prior verdict intact.
check "…and reports an error rather than a verdict" "ERROR" "$(printf '%s' "$out11" | jout verdict)"
check "…and stores NO sentinel over the real fingerprint" "$fp_before" "$(jf "$WATCH/meta.json" input_fingerprint)"
check "…leaving the verdict untouched" "1" "$([ -s "$WATCH/last.txt" ] && echo 1 || echo 0)"

# A LEGACY/unavailable value must never compare equal to itself.
python3 - "$WATCH/meta.json" <<'PYX'
import json,sys
m=json.load(open(sys.argv[1])); m["input_fingerprint"]="unavailable"
json.dump(m, open(sys.argv[1],"w"), indent=2)
PYX
out12="$(run_start "$NONCE" "b task" light)"
check "an 'unavailable' fingerprint is NOT treated as a match (7 total)" "7" "$(calls)"
fpZ="$(jf "$WATCH/meta.json" input_fingerprint)"
check "…and the fresh round records a real versioned one" "1" "$([ "${fpZ#fp1:}" != "$fpZ" ] && echo 1 || echo 0)"

# ── FAIL CLOSED ON AN INCOMPLETE OR UNHASHABLE INPUT ───────────────────────────────
# These two fixtures are surgical: the target guard must SUCCEED (so it is not the layer
# refusing) while exactly one fingerprint input fails. That is what proves the fingerprint
# branch itself fires, which a blunt "break git" fixture could not show.
fp_keep="$(jf "$WATCH/meta.json" input_fingerprint)"
calls_keep="$(calls)"

# (a) INTENT-TO-ADD fails: an index.lock makes `git add -N` fail while rev-parse/diff/status
#     all still work, so new files would be invisible to the review AND to its digest.
: > "$R/.git/worktrees/camus-wt-task/index.lock" 2>/dev/null || : > "$WT/.git/index.lock" 2>/dev/null
out13="$(run_start "$NONCE" "b task" light)"
rm -f "$R/.git/worktrees/camus-wt-task/index.lock" "$WT/.git/index.lock" 2>/dev/null || true
check "a failed intent-to-add REFUSES (no reviewer)" "$calls_keep" "$(calls)"
check "…reporting ran:false" "false" "$(printf '%s' "$out13" | jout ran)"
check "…as fingerprint-unavailable" "fingerprint-unavailable" "$(printf '%s' "$out13" | jout infra_error)"
check "…and stores no sentinel" "$fp_keep" "$(jf "$WATCH/meta.json" input_fingerprint)"

# (b) Only `git diff` fails: a pass-through git wrapper that errors ONLY on diff. The guard
#     and rev-parse succeed, so this can only be the fingerprint branch refusing.
mkdir -p "$ROOT/diffbin"
cat > "$ROOT/diffbin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in diff) exit 9 ;; esac; done
exec /usr/bin/git "\$@"
EOF
chmod +x "$ROOT/diffbin/git"
out14="$(PATH="$ROOT/diffbin:$PATH" run_start "$NONCE" "b task" light)"
check "a failed git DIFF refuses in the fingerprint branch" "$calls_keep" "$(calls)"
check "…reporting fingerprint-unavailable" "fingerprint-unavailable" "$(printf '%s' "$out14" | jout infra_error)"
check "…naming the diff as the cause" "1" "$(printf '%s' "$out14" | grep -c 'git diff failed')"
check "…and stores no sentinel" "$fp_keep" "$(jf "$WATCH/meta.json" input_fingerprint)"

# (c) A malformed/truncated hasher output must refuse, never be stored.
mkdir -p "$ROOT/hashbin"
printf '#!/usr/bin/env bash\nprintf "deadbeef  -\\n"\n' > "$ROOT/hashbin/shasum"; chmod +x "$ROOT/hashbin/shasum"
out15="$(PATH="$ROOT/hashbin:$PATH" run_start "$NONCE" "b task" light)"
check "a TRUNCATED digest refuses" "$calls_keep" "$(calls)"
check "…reporting fingerprint-unavailable" "fingerprint-unavailable" "$(printf '%s' "$out15" | jout infra_error)"
check "…and stores no malformed fingerprint" "$fp_keep" "$(jf "$WATCH/meta.json" input_fingerprint)"

# ── BINDING SURVIVES A SEPARATE REATTACH PROCESS ───────────────────────────────────
# The await form runs in its OWN process with no CAMUS_REVIEW_BINDING and possibly no
# CAMUS_GATE_NONCE, so its emitted binding lost the nonce and the mixed bound/unbound guard
# refused a review that had completed correctly (live run 20260806-110809-2r9j). The identity is
# reconstructed from meta.json — the same file the adoption gate authenticates against.
meta_nonce="$(jf "$WATCH/meta.json" gate_nonce)"
awaited="$(env -u CAMUS_GATE_NONCE -u CAMUS_REVIEW_BINDING -u CAMUS_REVIEW_ROUND -u CAMUS_REVIEW_EFFORT \
  bash "$here/review.sh" await "$WATCH" 2>/dev/null)"
b_nonce="$(printf '%s' "$awaited" | python3 -c 'import json,sys
raw=sys.stdin.read(); i=raw.find("{")
try: d=json.loads(raw[i:]) if i>=0 else {}
except Exception: d={}
b=d.get("binding") or {}
print(b.get("nonce") or "")' 2>/dev/null)"
check "a separate await process emits a BINDING block" "1" "$(printf '%s' "$awaited" | grep -c '"binding"')"
check "…carrying the nonce reconstructed from meta.json" "$meta_nonce" "$b_nonce"
check "…and it is a real verdict, not pending" "true" "$(printf '%s' "$awaited" | jout ran)"
check "…having started NO new reviewer" "$calls_keep" "$(calls)"

# THE ARTIFACT STUDIO CONSUMES. _review_audit.py builds ~/.camus/reviews/<wt>-r<n>.json and reads
# binding ONLY from CAMUS_REVIEW_BINDING, so a wrapper-stdout assertion proves nothing about what
# Studio sees: exporting just the nonce still published an UNBOUND audit record (audit 2026-08-06).
AUDIT="$CAMUS_REVIEW_DIR/camus-wt-task-r1.json"
ajf() { python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); raise SystemExit(0)
cur=d
for k in sys.argv[2].split("."):
    if isinstance(cur, dict): cur=cur.get(k)
    else: cur=None
print("" if cur is None else (json.dumps(cur) if not isinstance(cur,(str,int,float)) else cur))' "$AUDIT" "$2" 2>/dev/null; }
check "the AUDIT artifact exists" "1" "$([ -s "$AUDIT" ] && echo 1 || echo 0)"
check "…it carries a binding block" "1" "$([ -n "$(ajf x binding)" ] && echo 1 || echo 0)"
check "…marked bound: true" "True" "$(ajf x binding.bound)"
check "…with the correct gate_nonce" "$meta_nonce" "$(ajf x binding.gate_nonce)"
check "…requested round 1" "1" "$(ajf x binding.round_requested)"
check "…and actual round 1" "1" "$(ajf x round)"
check "…with the binding's own round_actual" "1" "$(ajf x binding.round_actual)"
check "…requested effort matches the pin" "$EFFORT" "$(ajf x binding.effort_requested)"
check "…and the actual effort matches it" "$EFFORT" "$(ajf x reviewer_effort)"
check "…with requested and actual effort agreeing" "$EFFORT" "$(ajf x binding.effort_actual)"
check "…naming the reviewer model" "$MODEL" "$(ajf x binding.reviewer_model)"
check "…and the reviewer backend" "codex" "$(ajf x binding.reviewer_backend)"
check "…still with NO new reviewer started" "$calls_keep" "$(calls)"

# Every reviewer that ever ran here ran at the pinned effort — never the adaptive schedule.
check "no round ever ran at an unpinned effort" "" "$(grep -v "^$EFFORT$" "$ROOT/codex_efforts" 2>/dev/null | head -1)"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
