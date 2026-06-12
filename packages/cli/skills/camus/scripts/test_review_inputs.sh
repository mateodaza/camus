#!/usr/bin/env bash
# Contract tests for what codex_review.sh actually FEEDS the reviewer (run feedback
# 2026-06-10: untracked new files were invisible to `git diff`, and an open stdin made
# codex block and return empty verdicts). A fake `codex` on PATH records, from inside
# the worktree at invocation time: the diff it would see, its argv, and its stdin size.
# 2026-06-11 (VELOCITY-DIRECTION §2): also covers the additive levers (light model, service
# tier, review scope; 2026-06-12: MCP pruning) and the review.sh backend dispatcher (verbatim
# pass-through for codex, fail-closed gate JSON for unknown backends).
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

# fake codex: records the diff AS THE REVIEWER WOULD SEE IT (cwd = worktree), argv, stdin size.
# WATCHDOG CONTRACT (2026-06-11): real codex now runs detached with --json, so the verdict
# travels via `-o <file>` (stdout is the event stream) — the spy honors -o and emits one
# turn.completed event so usage extraction is exercised end-to-end.
SPY="$ROOT/spy"; mkdir -p "$SPY" "$ROOT/bin"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$SPY/args"
git diff --name-only > "$SPY/seen_diff" 2>/dev/null
wc -c < /dev/stdin | tr -d ' ' > "$SPY/stdin_bytes"
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
[ -n "\$out" ] && printf '{"findings": [], "overall_correctness": "patch is correct"}' > "\$out"
printf '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n'
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

# ── Additive levers (2026-06-11, VELOCITY-DIRECTION §2): light model, tier, scope ────────────
# light-model ladder: applies ONLY at medium effort (the cheap first pass); escalated rounds
# always run the full configured model — escalation buys depth, the ladder must not undercut it.
export CAMUS_CODEX_LIGHT_MODEL=fake-mini
run_review >/dev/null || { echo "FAIL light-model review errored/hung"; exit 1; }
check "light model used at default (medium) effort" \
  "yes" "$(grep -qx 'fake-mini' "$SPY/args" && echo yes || echo no)"
run_review_effort "xhigh" >/dev/null || { echo "FAIL light-model xhigh review errored/hung"; exit 1; }
check "light model NOT used on escalated rounds (xhigh)" \
  "no" "$(grep -qx 'fake-mini' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_LIGHT_MODEL

# service-tier pin: additive -c flag, present only while CAMUS_CODEX_TIER is set
export CAMUS_CODEX_TIER=standard
run_review >/dev/null || { echo "FAIL tier review errored/hung"; exit 1; }
check "service tier pinned when CAMUS_CODEX_TIER is set" \
  "yes" "$(grep -qx 'service_tier=standard' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_TIER
run_review >/dev/null || { echo "FAIL post-tier review errored/hung"; exit 1; }
check "no service-tier flag when CAMUS_CODEX_TIER is unset" \
  "no" "$(grep -q 'service_tier=' "$SPY/args" && echo yes || echo no)"

# MCP pruning (CAMUS_CODEX_DISABLE_MCP, 2026-06-12 smoke findings): per-server enabled=false
# flags appended NEXT TO the effort default (additive — never inside CAMUS_CODEX_ARGS), with
# ids sanitized to [A-Za-z0-9_-]+ before they reach argv.
export CAMUS_CODEX_DISABLE_MCP="figma,notion"
run_review >/dev/null || { echo "FAIL mcp-prune review errored/hung"; exit 1; }
check "MCP pruning: figma disable flag reaches codex" \
  "yes" "$(grep -qx 'mcp_servers.figma.enabled=false' "$SPY/args" && echo yes || echo no)"
check "MCP pruning: notion disable flag reaches codex" \
  "yes" "$(grep -qx 'mcp_servers.notion.enabled=false' "$SPY/args" && echo yes || echo no)"
check "MCP pruning composes with the effort default (medium still present)" \
  "yes" "$(grep -qx 'model_reasoning_effort=medium' "$SPY/args" && echo yes || echo no)"
# hostile/garbage ids are silently skipped — the value reaches a command line (single-quoted
# here so the literal $(evil) is what the script sees, not this test shell's expansion)
export CAMUS_CODEX_DISABLE_MCP='figma, $(evil) ,bad name,notion'
run_review >/dev/null || { echo "FAIL mcp-sanitize review errored/hung"; exit 1; }
check "sanitization: clean ids still survive (figma)" \
  "yes" "$(grep -qx 'mcp_servers.figma.enabled=false' "$SPY/args" && echo yes || echo no)"
check "sanitization: clean ids still survive (notion)" \
  "yes" "$(grep -qx 'mcp_servers.notion.enabled=false' "$SPY/args" && echo yes || echo no)"
check "sanitization: \$(evil) never reaches argv" \
  "no" "$(grep -q 'evil' "$SPY/args" && echo yes || echo no)"
check "sanitization: token with a space never reaches argv" \
  "no" "$(grep -q 'bad' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_DISABLE_MCP
run_review >/dev/null || { echo "FAIL post-mcp review errored/hung"; exit 1; }
check "no enabled=false flags when CAMUS_CODEX_DISABLE_MCP is unset" \
  "no" "$(grep -q 'enabled=false' "$SPY/args" && echo yes || echo no)"

# review scope (positional arg 5): light appends the narrowed-field instruction to the prompt
# (the prompt rides in argv, so the spy's args file is exactly what the reviewer would read)
run_review_scope() { # $1 = effort (arg 4), $2 = scope (arg 5)
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" "$2" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", "3", sys.argv[4], sys.argv[5]],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
sys.stdout.write(r.stdout)
PY
}
run_review_scope "medium" "light" >/dev/null || { echo "FAIL scope review errored/hung"; exit 1; }
check "scope=light reaches the prompt (Review scope: LIGHT)" \
  "yes" "$(grep -q 'Review scope: LIGHT' "$SPY/args" && echo yes || echo no)"
check "scope recorded in watch meta.json (audit trail)" \
  "light" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("scope",""))' "$ROOT/reviews/camus-wt-task-r3.watch/meta.json" 2>/dev/null)"
run_review >/dev/null || { echo "FAIL default-scope review errored/hung"; exit 1; }
check "default scope stays FULL (no light section in the prompt)" \
  "no" "$(grep -q 'Review scope: LIGHT' "$SPY/args" && echo yes || echo no)"

# ── Reviewer-backend dispatcher (review.sh): codex passes through VERBATIM; an unknown backend
# fails CLOSED (ran:false gate JSON naming it, exit 0) — never a fallback, never a crash.
run_dispatch() { # same happy-path invocation as run_review, but through the dispatcher
  python3 - "$R" "$here/review.sh" "$WT" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", "1"],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
sys.stdout.write(r.stdout)
PY
}
direct="$(run_review)" || { echo "FAIL direct review errored/hung"; exit 1; }
dispatched="$(run_dispatch)" || { echo "FAIL dispatched review errored/hung"; exit 1; }
check "dispatcher (no env) emits the identical normalized verdict" "$direct" "$dispatched"
out="$(CAMUS_REVIEWER=gemini bash "$here/review.sh" "$WT" "the task" "1")"; rc=$?
check "unknown backend exits 0 (gate JSON, not a crash)" "0" "$rc"
check "unknown backend fails closed (ran:false, names it, empty findings)" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys
g = json.load(sys.stdin)
ok = (g["ran"] is False and g["clean"] is False and g["blocking"] == [] and g["nonblocking"] == []
      and "gemini" in g["error"] and "codex" in g["error"])
print("yes" if ok else "no")')"

# commit.sh interplay: intent-to-add must not break staging or empty-detection
out="$(bash "$here/commit.sh" "$WT" "camus: test")"
check "commit gate still commits after intent-to-add" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["committed"] else "no")')"
check "new file actually committed" \
  "yes" "$(git -C "$WT" ls-tree -r --name-only HEAD | grep -qx 'newfile.ts' && echo yes || echo no)"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
