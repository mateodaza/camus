#!/usr/bin/env bash
# Contract tests for what codex_review.sh actually FEEDS the reviewer (run feedback
# 2026-06-10: untracked new files were invisible to `git diff`, and an open stdin made
# codex block and return empty verdicts). A fake `codex` on PATH records, from inside
# the worktree at invocation time: the diff it would see, its argv, and its stdin size.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"
  else fail=$((fail+1)); echo "FAIL $1  (expected [$2], got [$3])"; fi
}
gitq() { git -c user.email=t@t -c user.name=t "$@"; }

# repo + coherent camus worktree (same shape the guard tests use)
R="$ROOT/repo"; mkdir -p "$R"; cd "$R"
gitq init -q
echo "old" > tracked.txt
echo "ignored-content" > .gitignore_target
printf "ignoredfile.txt\n" > .gitignore
gitq add -A && gitq commit -qm init
gitq worktree add -q -b camus/feat/x/task "$ROOT/camus-wt-task" >/dev/null 2>&1
WT="$ROOT/camus-wt-task"

# the change under review: one tracked modification, one NEW untracked file, one ignored file
echo "new content" > "$WT/tracked.txt"
echo "brand new module" > "$WT/newfile.ts"
echo "junk" > "$WT/ignoredfile.txt"

# fake codex: records the diff AS THE REVIEWER WOULD SEE IT (cwd = worktree), argv, stdin size
SPY="$ROOT/spy"; mkdir -p "$SPY" "$ROOT/bin"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$SPY/args"
git diff --name-only > "$SPY/seen_diff" 2>/dev/null
wc -c < /dev/stdin | tr -d ' ' > "$SPY/stdin_bytes"
printf '{"findings": [], "overall_correctness": "patch is correct"}'
EOF
chmod +x "$ROOT/bin/codex"

run_review() { # [extra env...] — runs with a 30s hang guard (a blocked stdin would hang forever)
  python3 - "$R" "$here/codex_review.sh" "$WT" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", "1"],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
sys.stdout.write(r.stdout)
PY
}

export PATH="$ROOT/bin:$PATH"
export CAMUS_REVIEW_DIR="$ROOT/reviews"

out="$(run_review)" || { echo "FAIL review script errored/hung"; exit 1; }

check "verdict normalized (ran:true clean:true)" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; g=json.load(sys.stdin); print("yes" if g["ran"] and g["clean"] else "no")')"
check "NEW untracked file visible in the reviewed diff" \
  "yes" "$(grep -qx 'newfile.ts' "$SPY/seen_diff" && echo yes || echo no)"
check "tracked modification visible in the reviewed diff" \
  "yes" "$(grep -qx 'tracked.txt' "$SPY/seen_diff" && echo yes || echo no)"
check "gitignored file NOT dragged into the diff" \
  "no" "$(grep -qx 'ignoredfile.txt' "$SPY/seen_diff" && echo yes || echo no)"
check "stdin is closed (/dev/null, 0 bytes — codex must never block on it)" \
  "0" "$(cat "$SPY/stdin_bytes")"
check "schema flag passed" \
  "yes" "$(grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"
check "defaults to MEDIUM reasoning when no effort arg + no CAMUS_CODEX_ARGS" \
  "yes" "$(grep -qx 'model_reasoning_effort=medium' "$SPY/args" && echo yes || echo no)"
check "audit file written for the round" \
  "yes" "$([ -f "$ROOT/reviews/camus-wt-task-r1.json" ] && echo yes || echo no)"

# per-call effort (arg 4) — the orchestrator's dynamic effort reaches codex
run_review_effort() { # $1 = effort arg
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", "2", sys.argv[4]],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
sys.stdout.write(r.stdout)
PY
}
run_review_effort "xhigh" >/dev/null || { echo "FAIL effort-arg review errored/hung"; exit 1; }
check "arg-4 effort reaches codex (xhigh)" \
  "yes" "$(grep -qx 'model_reasoning_effort=xhigh' "$SPY/args" && echo yes || echo no)"
run_review_effort "high" >/dev/null || true
check "arg-4 effort reaches codex (high)" \
  "yes" "$(grep -qx 'model_reasoning_effort=high' "$SPY/args" && echo yes || echo no)"

# precedence: an explicit CAMUS_CODEX_ARGS OVERRIDES the per-call arg-4 effort
export CAMUS_CODEX_ARGS="-c model_reasoning_effort=xhigh"
run_review_effort "medium" >/dev/null || { echo "FAIL override review errored/hung"; exit 1; }
check "CAMUS_CODEX_ARGS overrides the arg-4 effort (xhigh wins)" \
  "yes" "$(grep -qx 'model_reasoning_effort=xhigh' "$SPY/args" && echo yes || echo no)"
check "override wins: the arg-4 medium is NOT also added" \
  "no" "$(grep -qx 'model_reasoning_effort=medium' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_ARGS

# commit.sh interplay: intent-to-add must not break staging or empty-detection
out="$(bash "$here/commit.sh" "$WT" "camus: test")"
check "commit gate still commits after intent-to-add" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["committed"] else "no")')"
check "new file actually committed" \
  "yes" "$(git -C "$WT" ls-tree -r --name-only HEAD | grep -qx 'newfile.ts' && echo yes || echo no)"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
