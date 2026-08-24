#!/usr/bin/env bash
# LIVE-PATH binding tests (field report 2026-08-04, a WP6 game run).
#
# These deliberately do NOT test helpers in isolation. Each case runs the REAL
# `review.sh` through the REAL request-file/env/argv channels with a spy `codex`,
# then feeds the resulting stdout to the REAL `asGate()` extracted from the
# production workflow, with the expectations the workflow itself would compute.
# A case passes only when the whole chain refuses — the same chain that let a
# requested r2/high become an accepted r0/medium receipt.
set -uo pipefail
export CAMUS_MAKER_TRAINING_ORG=anthropic
here="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW="$here/../../../workflows/camus-loop.workflow.js"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1  (expected [$2], got [$3])"; fi; }
gitq() { git -c user.email=t@t -c user.name=t "$@"; }

# A guard-valid repo + coherent camus worktree.
R="$ROOT/repo"; mkdir -p "$R"; cd "$R"
gitq init -q; echo old > f.txt; gitq add -A; gitq commit -qm init
gitq worktree add -q -b camus/feat/x/task "$ROOT/camus-wt-task" >/dev/null 2>&1
WT="$ROOT/camus-wt-task"
echo new > "$WT/f.txt"
export CAMUS_REVIEW_DIR="$ROOT/reviews"
mkdir -p "$CAMUS_REVIEW_DIR"

# Spy codex: always returns a CLEAN verdict. That is the point — the review
# "succeeds", so anything that refuses below refuses on BINDING alone.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/codex" <<'EOF'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf '%s' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"spy","overall_confidence_score":0.9}' > "$out"
echo '{"type":"thread.started","thread_id":"th_spy"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
EOF
chmod +x "$ROOT/bin/codex"
export PATH="$ROOT/bin:$PATH"

NONCE="salt:abc123"
MODEL="gpt-5.6-sol"

# asGate, lifted from the PRODUCTION workflow (not reimplemented here), fed the
# expectations the workflow computes for round 2 at high effort.
gate_verdict() { # stdin: reviewer stdout; args: expectedRound expectedEffort
  node --input-type=module -e '
import fs from "node:fs";
const src = fs.readFileSync(process.argv[1], "utf8");
const start = src.indexOf("function extractJsonObject");
const end = src.indexOf("function asVerify");
const fns = src.slice(start, end);
const mod = new Function("return (() => { " + fns + " return { asGate }; })()")();
let raw = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const g = mod.asGate(raw, {
    round: Number(process.argv[2]), effort: process.argv[3],
    reviewerModel: process.argv[4], backend: "codex",
    worktreeName: process.argv[5], nonce: process.argv[6],
  });
  console.log(g.ran ? "accepted" : "refused");
});
' "$WORKFLOW" "$1" "$2" "$MODEL" "$(basename "$WT")" "$NONCE"
}

# The production command shape: request file + env + argv all carry the numbers.
review_as_workflow_would() { # <req_round> <req_effort> <argv_round> <argv_effort> [nonce] [ran_model]
  local rr="$1" re="$2" ar="$3" ae="$4" nonce="${5:-$NONCE}" ran_model="${6:-$MODEL}"
  python3 "$here/review_request.py" write --worktree "$WT" --round "$rr" --effort "$re" \
    --nonce "$nonce" --model "$MODEL" --backend codex >/dev/null
  CAMUS_GATE_NONCE="$nonce" CAMUS_REVIEW_ROUND="$rr" CAMUS_REVIEW_EFFORT="$re" CAMUS_CODEX_MODEL="$ran_model" \
    bash "$here/review.sh" "$WT" "task ctx" $ar $ae 2>/dev/null
}

# ── POSITIVE CONTROL — the honest path must be ACCEPTED, or every refusal below
# proves nothing.
out="$(review_as_workflow_would 2 high 2 high)"
check "the requested review (r2/high, faithfully executed) is accepted" \
  "accepted" "$(printf '%s' "$out" | gate_verdict 2 high)"
check "and its stdout publishes the actuals the loop compares against" \
  "2|high|gpt-5.6-sol|codex|salt:abc123" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys
b = (json.loads(sys.stdin.read().strip().splitlines()[-1]) or {}).get("binding") or {}
print("|".join(str(b.get(k)) for k in ("round","effort","model","backend","nonce")))')"
# …and the REVIEW-CONTRACT (rc1) fields the real script derives/echoes. A pinned model
# (CAMUS_CODEX_MODEL=gpt-5.6-sol here) is a CONFIGURED connection → qual1, not the
# built-in tier — proving qualification/connection are DERIVED from what actually ran.
check "the live stdout publishes the contract-carried fields (derived + echoed)" \
  "rc1|full|qual1|configured|cli-detached" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys
b = (json.loads(sys.stdin.read().strip().splitlines()[-1]) or {}).get("binding") or {}
print("|".join(str(b.get(k)) for k in ("contract","scope","qualification","connection","transport")))')"

# ── BREAK-TEST 1 — requested r2/high, relay runs r2/MEDIUM.
# This is the case the previous round could not catch: internally self-consistent.
out="$(review_as_workflow_would 2 high 2 medium)"
check "requested r2/high but relay ran r2/medium is REFUSED" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"

# ── BREAK-TEST 2 — requested r2/high, relay runs r3/high.
out="$(review_as_workflow_would 2 high 3 high)"
check "requested r2/high but relay ran r3/high is REFUSED" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"

# ── BREAK-TEST 3 — the relay drops round and effort entirely (the field failure).
# The mechanical channels still bind it, so this must run the RIGHT review and be
# accepted — dropping arguments must not be able to change what was reviewed.
out="$(review_as_workflow_would 2 high "" "")"
check "a relay that drops round/effort still runs the REQUESTED r2/high" \
  "accepted" "$(printf '%s' "$out" | gate_verdict 2 high)"
check "and it lands under r2, never r0" \
  "yes" "$([ -f "$CAMUS_REVIEW_DIR/$(basename "$WT")-r2.json" ] && echo yes || echo no)"
check "no r0 receipt is ever produced" \
  "0" "$(ls "$CAMUS_REVIEW_DIR" | grep -cE -- "^$(basename "$WT")-r0\.json$")"

# ── BREAK-TEST 4 — missing nonce: the review ran, but nothing ties it to this run.
rm -f "$CAMUS_REVIEW_DIR/$(basename "$WT")-request.json"
out="$(CAMUS_REVIEW_ROUND=2 CAMUS_REVIEW_EFFORT=high CAMUS_CODEX_MODEL="$MODEL" \
  bash "$here/review.sh" "$WT" "task ctx" 2 high 2>/dev/null)"
check "a review carrying no gate nonce is REFUSED" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"

# ── BREAK-TEST 5 — wrong model / backend / worktree.
out="$(review_as_workflow_would 2 high 2 high "$NONCE" "gpt-4o-mini")"
check "a review run under a different reviewer MODEL is REFUSED" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"
out="$(review_as_workflow_would 2 high 2 high "other-run:zzz")"
check "a review bound to another run's nonce is REFUSED" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"
# A verdict from a DIFFERENT worktree cannot be accepted for this one.
gitq -C "$R" worktree add -q -b camus/feat/x/other "$ROOT/camus-wt-other" >/dev/null 2>&1
echo new > "$ROOT/camus-wt-other/f.txt"
python3 "$here/review_request.py" write --worktree "$ROOT/camus-wt-other" --round 2 --effort high \
  --nonce "$NONCE" --model "$MODEL" --backend codex >/dev/null
out="$(CAMUS_GATE_NONCE="$NONCE" CAMUS_REVIEW_ROUND=2 CAMUS_REVIEW_EFFORT=high CAMUS_CODEX_MODEL="$MODEL" \
  bash "$here/review.sh" "$ROOT/camus-wt-other" "task ctx" 2 high 2>/dev/null)"
check "a verdict produced in another worktree is REFUSED for this run" \
  "refused" "$(printf '%s' "$out" | gate_verdict 2 high)"

# ── A gate with no binding at all (a pre-fix install) must not authorize a run.
check "reviewer output with no binding block is REFUSED" \
  "refused" "$(printf '%s' '{"ran":true,"clean":true,"blocking":[],"nonblocking":[]}' | gate_verdict 2 high)"

# ── FIXED EFFORT (displayed pairing = executed pairing). The spy codex records
# the reasoning-effort arg it was actually invoked with, so we can prove a run
# pinned low EXECUTES low, and that asGate — with the workflow's own expectation
# of low — accepts it. This is the property behind Studio forwarding
# reviewerEffort: what Studio shows is what codex runs.
cat > "$ROOT/bin/codex" <<'EOF'
#!/usr/bin/env bash
out=""; prev=""; eff="unset"
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in model_reasoning_effort=*) eff="${a#model_reasoning_effort=}";; esac
  prev="$a"
done
echo "$eff" > "${CAMUS_SPY_EFFORT_FILE:-/dev/null}"
[ -n "$out" ] && printf '%s' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"spy","overall_confidence_score":0.9}' > "$out"
echo '{"type":"thread.started","thread_id":"th_spy"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
EOF
chmod +x "$ROOT/bin/codex"
export CAMUS_SPY_EFFORT_FILE="$ROOT/spy-effort"
out="$(review_as_workflow_would 2 low 2 low)"
check "a run pinned low EXECUTES codex at low effort (what Studio shows is what runs)" \
  "low" "$(cat "$ROOT/spy-effort" 2>/dev/null)"
check "and asGate with the workflow's low expectation accepts it" \
  "accepted" "$(printf '%s' "$out" | gate_verdict 2 low)"
check "the receipt's actual effort is low, not an escalated value" \
  "low" "$(printf '%s' "$out" | python3 -c 'import json,sys
b=(json.loads(sys.stdin.read().strip().splitlines()[-1]) or {}).get("binding") or {}
print(b.get("effort"))')"

# ── REVIEW-CONTRACT (rc1) fields — asGate compares every one independently and
# refuses drift in BOTH directions (skills/camus/REVIEW-CONTRACT.md). These feed the
# REAL asGate a hand-built reviewer verdict (expected + binding both explicit JSON),
# so each axis is exercised on its own without needing a live reviewer per case.
# args: <expected-json> ; stdin: reviewer stdout (a {ran,binding,...} object)
gate_full() {
  node --input-type=module -e '
import fs from "node:fs";
const src = fs.readFileSync(process.argv[1], "utf8");
const fns = src.slice(src.indexOf("function extractJsonObject"), src.indexOf("function asVerify"));
const mod = new Function("return (() => { " + fns + " return { asGate }; })()")();
let raw = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => { const g = mod.asGate(raw, JSON.parse(process.argv[2])); console.log(g.ran ? "accepted" : "refused"); });
' "$WORKFLOW" "$1"
}
# The expectation the full-posture, built-in, vendor-managed workflow computes.
EXP_FULL='{"round":2,"effort":"high","reviewerModel":"","backend":"codex","worktreeName":"'"$(basename "$WT")"'","nonce":"'"$NONCE"'","contract":"rc1","scope":"full","qualification":"builtin1","origin":"camus-loop","operator":"claude-code","transport":"cli-detached","connection":"vendor_managed"}'
# A faithful built-in binding that matches EXP_FULL on every axis.
bind() { # override key=value pairs applied over the faithful binding
  python3 - "$NONCE" "$(basename "$WT")" "$@" <<'PY'
import json, sys
nonce, wt = sys.argv[1], sys.argv[2]
b = {"round":2,"effort":"high","model":None,"backend":"codex","worktree":wt,"nonce":nonce,
     "round_requested":2,"effort_requested":"high","contract":"rc1","scope":"full",
     "qualification":"builtin1","origin":"camus-loop","operator":"claude-code",
     "transport":"cli-detached","connection":"vendor_managed"}
for kv in sys.argv[3:]:
    k, _, v = kv.partition("=")
    b[k] = None if v == "__del__" else v
print(json.dumps({"ran":True,"clean":True,"blocking":[],"nonblocking":[],"binding":b}))
PY
}
check "honest built-in/full review is ACCEPTED" \
  "accepted" "$(bind | gate_full "$EXP_FULL")"
check "contract VERSION skew is REFUSED (install copied one half)" \
  "refused" "$(bind contract=rc0 | gate_full "$EXP_FULL")"
check "a review with NO contract field is REFUSED" \
  "refused" "$(bind contract=__del__ | gate_full "$EXP_FULL")"
check "light-behind-full: a light review cannot satisfy a full request (REFUSED)" \
  "refused" "$(bind scope=light | gate_full "$EXP_FULL")"
check "full does not silently satisfy a light request either (REFUSED)" \
  "refused" "$(bind | gate_full "$(printf '%s' "$EXP_FULL" | python3 -c 'import json,sys;e=json.load(sys.stdin);e["scope"]="light";print(json.dumps(e))')")"
check "qualification drift builtin1→qual1 is REFUSED (built-in gate reconfigured)" \
  "refused" "$(bind qualification=qual1 connection=configured | gate_full "$EXP_FULL")"
check "qualification drift qual1→builtin1 is REFUSED (claims a tier not requested)" \
  "refused" "$(bind | gate_full "$(printf '%s' "$EXP_FULL" | python3 -c 'import json,sys;e=json.load(sys.stdin);e["qualification"]="qual1";e["connection"]="configured";print(json.dumps(e))')")"
check "origin drift is REFUSED" \
  "refused" "$(bind origin=someone-else | gate_full "$EXP_FULL")"
check "operator drift is REFUSED" \
  "refused" "$(bind operator=rogue | gate_full "$EXP_FULL")"
check "transport drift is REFUSED" \
  "refused" "$(bind transport=smuggled | gate_full "$EXP_FULL")"
check "connection drift is REFUSED" \
  "refused" "$(bind connection=configured | gate_full "$EXP_FULL")"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
