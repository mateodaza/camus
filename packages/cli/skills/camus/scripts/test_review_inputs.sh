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
# A repository-local Codex layer may pin a different reviewer. The executor must suppress it
# mechanically; the fake codex below deliberately only records the boundary argv.
mkdir -p "$WT/.codex"
printf 'model = "repo-pinned-model"\nmodel_provider = "repo-pinned-provider"\n' > "$WT/.codex/config.toml"
PROJECT_TRUST_OVERRIDE="projects.\"$(cd "$WT" && pwd -P)\".trust_level=\"untrusted\""

# fake codex: records the diff AS THE REVIEWER WOULD SEE IT (cwd = worktree), argv, stdin size.
# WATCHDOG CONTRACT (2026-06-11): real codex now runs detached with --json, so the verdict
# travels via `-o <file>` (stdout is the event stream) — the spy honors -o and emits one
# turn.completed event so usage extraction is exercised end-to-end.
SPY="$ROOT/spy"; mkdir -p "$SPY" "$ROOT/bin"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
# Resume vs fresh branch (codex-resume-recovery 2026-06-12): \`codex exec resume <id> ...\` records
# to a DISTINCT spy file (so a test can prove resume was chosen) and emits thread.started so the
# watchdog re-captures the id. SPY_RESUME_FAIL forces the failure modes the script must fall
# closed on: exit=nonzero, or a done run that writes NO -o verdict (adapter → ran:false).
if [ "\$1" = "exec" ] && [ "\$2" = "resume" ]; then
  printf '%s\n' "\$@" > "$SPY/args_resume"
  printf '%s' "\${OPENAI_BASE_URL-unset}" > "$SPY/openai_base_url_resume"
  printf '%s\n' "\$3" > "$SPY/resume_id"
  printf '{"type":"thread.started","thread_id":"%s"}\n' "\$3"
  case "\${SPY_RESUME_FAIL:-}" in
    exit) printf '{"type":"turn.completed","usage":{"output_tokens":1}}\n'; exit 7 ;;
    noverdict) printf '{"type":"turn.completed","usage":{"output_tokens":1}}\n'; exit 0 ;;
  esac
  out=""; prev=""
  for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
  [ -n "\$out" ] && printf '{"findings": [], "overall_correctness": "patch is correct"}' > "\$out"
  printf '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}\n'
  exit 0
fi
printf '%s\n' "\$@" > "$SPY/args"
printf '%s' "\${OPENAI_BASE_URL-unset}" > "$SPY/openai_base_url"
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
# CLEAN, UNPINNED BASELINE. Several checks below (and the builtin1/vendor_managed baseline in
# particular) assert the tier the built-in codex backend earns with NO pinned model of any kind.
# A real Camus verification env already exports CAMUS_CODEX_MODEL (and may fold a model/backend/
# connection into CAMUS_CODEX_ARGS or an alternate CAMUS_REVIEW_BACKEND), which codex_review.sh
# CORRECTLY derives as qual1/configured — so the inherited pins must be unset here, not assumed
# absent. The cases that WANT a pin export their own var and unset it afterward.
unset CAMUS_CODEX_MODEL CAMUS_CODEX_ARGS CAMUS_CODEX_LIGHT_MODEL CAMUS_CODEX_TIER CAMUS_CODEX_DISABLE_MCP CAMUS_REVIEW_BACKEND CAMUS_CODEX_MANAGED_CONFIG_EVIDENCE

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
check "every fresh review mechanically ignores ambient user config" \
  "yes" "$(grep -qx -- '--ignore-user-config' "$SPY/args" && echo yes || echo no)"
check "every fresh review mechanically suppresses repository-local Codex config" \
  "yes" "$(grep -Fqx -- "$PROJECT_TRUST_OVERRIDE" "$SPY/args" && echo yes || echo no)"
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
check "the escalated effort is sealed in the round audit (actual, not requested)" \
  "high" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_effort",""))' "$ROOT/reviews/camus-wt-task-r2.json" 2>/dev/null)"

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
# QUALIFICATION TRUTH (finding: a lever-pinned model must NOT be certified builtin1). The
# light model pins a real model with no CAMUS_CODEX_MODEL — the binding must read qual1 /
# configured, derived from the ACTUAL args, not the falsely-builtin1 vendor_managed tier.
check "light-model pin downgrades qualification to qual1 (not builtin1)" \
  "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "light-model pin marks the connection configured (not vendor_managed)" \
  "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
run_review_effort "xhigh" >/dev/null || { echo "FAIL light-model xhigh review errored/hung"; exit 1; }
check "light model NOT used on escalated rounds (xhigh)" \
  "no" "$(grep -qx 'fake-mini' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_LIGHT_MODEL

# The same qualification truth for a -m folded into CAMUS_CODEX_ARGS (no CAMUS_CODEX_MODEL):
# codex runs a pinned model, so the tier is qual1/configured, never the built-in gate.
export CAMUS_CODEX_ARGS="-c model_reasoning_effort=medium -m fake-ambient"
run_review >/dev/null || { echo "FAIL ambient -m review errored/hung"; exit 1; }
check "ambient -m in CAMUS_CODEX_ARGS reaches codex" \
  "yes" "$(grep -qx 'fake-ambient' "$SPY/args" && echo yes || echo no)"
check "ambient -m downgrades qualification to qual1 (not builtin1)" \
  "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "ambient -m marks the connection configured (not vendor_managed)" \
  "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset CAMUS_CODEX_ARGS
# The same qualification truth for a model pinned via codex's GENERIC config override
# (`-c model=<v>`) rather than -m — the detector must catch the lone `model=` token too, or a
# `CAMUS_CODEX_ARGS='-c model="o3"'` pin is falsely certified as the built-in gate.
export CAMUS_CODEX_ARGS='-c model="o3"'
run_review >/dev/null || { echo "FAIL -c model= review errored/hung"; exit 1; }
check "-c model= config override downgrades qualification to qual1 (not builtin1)" \
  "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "-c model= config override marks the connection configured (not vendor_managed)" \
  "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset CAMUS_CODEX_ARGS
# Ambient config and base-URL redirects are excluded from the hardened builtin1 process while
# CODEX_HOME remains available for authentication. Prove both controls at the child boundary.
AMBIENT_CODEX_HOME="$ROOT/ambient-codex"; mkdir -p "$AMBIENT_CODEX_HOME"
printf 'model_provider = "ollama"\nopenai_base_url = "http://127.0.0.1:11434/v1"\n' > "$AMBIENT_CODEX_HOME/config.toml"
export CODEX_HOME="$AMBIENT_CODEX_HOME"
export OPENAI_BASE_URL='http://127.0.0.1:11434/v1'
run_review >/dev/null || { echo "FAIL isolated ambient-config review errored/hung"; exit 1; }
check "ambient provider config is excluded by --ignore-user-config" \
  "yes" "$(grep -qx -- '--ignore-user-config' "$SPY/args" && echo yes || echo no)"
check "OPENAI_BASE_URL is stripped from the reviewer child" \
  "unset" "$(cat "$SPY/openai_base_url")"
check "isolated unpinned built-in remains builtin1" \
  "builtin1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset OPENAI_BASE_URL CODEX_HOME
# Managed/admin configuration outranks ordinary CLI/user layers, so any evidence of that layer
# conservatively downgrades an otherwise unpinned built-in review. The evidence path is additive:
# it cannot hide the real fixed-path/MDM checks and exists so this boundary stays hermetic.
MANAGED_EVIDENCE="$ROOT/managed_config.toml"
printf 'model = "admin-pinned-model"\n' > "$MANAGED_EVIDENCE"
export CAMUS_CODEX_MANAGED_CONFIG_EVIDENCE="$MANAGED_EVIDENCE"
run_review >/dev/null || { echo "FAIL managed-config review errored/hung"; exit 1; }
check "managed configuration evidence downgrades qualification to qual1" \
  "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "managed configuration evidence marks the connection configured" \
  "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset CAMUS_CODEX_MANAGED_CONFIG_EVIDENCE
# Compact/attached spellings are semantically identical and must not bypass the tier detector.
for compact_pin in '-mo3' '--config=model="o3"' '-c model_catalog_json="/tmp/camus-models.json"' '--config=model_catalog_json="/tmp/camus-models.json"'; do
  export CAMUS_CODEX_ARGS="$compact_pin"
  run_review >/dev/null || { echo "FAIL compact model override review errored/hung: $compact_pin"; exit 1; }
  check "compact model override ($compact_pin) downgrades qualification" \
    "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
  check "compact model override ($compact_pin) marks connection configured" \
    "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
done
unset CAMUS_CODEX_ARGS
# And for a NON-VENDOR connection selector (--oss/--local-provider) — not a model pin, but it
# takes the reviewer off the built-in vendor backend, so it is configured/qual1, never builtin1.
export CAMUS_CODEX_ARGS='--oss --local-provider ollama'
run_review >/dev/null || { echo "FAIL --oss review errored/hung"; exit 1; }
check "non-vendor connection (--oss) downgrades qualification to qual1 (not builtin1)" \
  "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "non-vendor connection (--oss) marks the connection configured (not vendor_managed)" \
  "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset CAMUS_CODEX_ARGS
# Generic config can redirect through provider selection, provider definitions, or a base URL.
# Every spelling is configurable/qual1 even when no explicit model flag appears.
for route_override in \
  '--config=model_provider=ollama' \
  '--profile local-review' \
  '-plocal-review' \
  '-c model_providers.camus_local.base_url="http://127.0.0.1:11434/v1"' \
  '-copenai_base_url="http://127.0.0.1:11434/v1"'
do
  export CAMUS_CODEX_ARGS="$route_override"
  run_review >/dev/null || { echo "FAIL route override review errored/hung: $route_override"; exit 1; }
  check "route override ($route_override) downgrades qualification" \
    "qual1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
  check "route override ($route_override) marks connection configured" \
    "configured" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
done
unset CAMUS_CODEX_ARGS
# Baseline: the built-in codex backend with NO pinned model of any kind IS builtin1/vendor_managed.
run_review >/dev/null || { echo "FAIL builtin baseline review errored/hung"; exit 1; }
check "unpinned built-in codex backend certifies builtin1" \
  "builtin1" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("qualification"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "unpinned built-in codex backend certifies vendor_managed" \
  "vendor_managed" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binding",{}).get("connection"))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"

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
# "all" (2026-06-12): ids come from the config's [mcp_servers.X] headers — nested tables like
# [mcp_servers.X.env] must NOT produce a token, and the charset filter still applies.
export CODEX_HOME="$ROOT/codexhome"; mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<'TOML'
model = "gpt-x"
[mcp_servers.figma]
url = "https://example.com"
[mcp_servers.perplexity]
command = "npx"
[mcp_servers.perplexity.env]
KEY = "v"
TOML
export CAMUS_CODEX_DISABLE_MCP=all
run_review >/dev/null || { echo "FAIL mcp-all review errored/hung"; exit 1; }
check "all: every configured server disabled" \
  "yes" "$(grep -qx 'mcp_servers.figma.enabled=false' "$SPY/args" && grep -qx 'mcp_servers.perplexity.enabled=false' "$SPY/args" && echo yes || echo no)"
check "all: nested tables never produce a token" \
  "no" "$(grep -q 'mcp_servers.env' "$SPY/args" && echo yes || echo no)"
unset CAMUS_CODEX_DISABLE_MCP CODEX_HOME
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

# ── Codex-resume recovery (codex-resume-recovery 2026-06-12): a round whose PRIOR attempt was
# idle-killed/aborted owns a live codex thread — the next attempt RESUMES it (codex exec resume
# <thread_id>) instead of paying for a fresh review. Fail closed to a fresh review when resume
# exits nonzero or yields no verdict — never a new failure mode.
run_review_round() { # $1 = round number
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", sys.argv[4]],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
sys.stdout.write(r.stdout)
PY
}
# Stage a round dir as if a prior attempt was aborted WITH a thread_id (meta.json carries it,
# the away/abort form's persistence) — the trigger the script probes for before the fresh path.
stage_aborted_round() { # $1 = round, $2 = thread_id
  local d="$ROOT/reviews/camus-wt-task-r$1.watch"
  mkdir -p "$d"
  python3 -c 'import json,sys; json.dump({"target_dir": sys.argv[2], "round": sys.argv[3],
    "effort": "medium", "scope": "full", "thread_id": sys.argv[4],
    "contract": "rc1", "qualification": "builtin1", "origin": "cli", "operator": "cli",
    "transport": "cli-detached", "connection": "vendor_managed"}, open(sys.argv[1],"w"))' \
    "$d/meta.json" "$WT" "$1" "$2"
  printf '{"type":"thread.started","thread_id":"%s"}\n' "$2" > "$d/events.jsonl"
}

# resume CHOSEN when a prior aborted thread_id is present: the script runs `codex exec resume <id>`
# and the verdict normalizes ran:true (the resumed thread finished the review).
rm -f "$SPY/args_resume" "$SPY/resume_id"
stage_aborted_round 7 "sess-resume-ok"
export OPENAI_BASE_URL='http://127.0.0.1:11434/v1'
out="$(run_review_round 7)" || { echo "FAIL resume review errored/hung"; exit 1; }
unset OPENAI_BASE_URL
check "resume chosen: argv shows 'exec resume <thread_id>'" \
  "yes" "$([ -f "$SPY/args_resume" ] && grep -qx 'resume' "$SPY/args_resume" && grep -qx 'sess-resume-ok' "$SPY/args_resume" && echo yes || echo no)"
check "resume verdict normalizes ran:true (clean)" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; g=json.load(sys.stdin); print("yes" if g["ran"] and g["clean"] else "no")')"
check "resume rides the SAME schema/-o plumbing (--output-schema present)" \
  "yes" "$(grep -qx -- '--output-schema' "$SPY/args_resume" && echo yes || echo no)"
check "resume mechanically ignores ambient user config" \
  "yes" "$(grep -qx -- '--ignore-user-config' "$SPY/args_resume" && echo yes || echo no)"
check "resume mechanically suppresses repository-local Codex config" \
  "yes" "$(grep -Fqx -- "$PROJECT_TRUST_OVERRIDE" "$SPY/args_resume" && echo yes || echo no)"
check "resume strips OPENAI_BASE_URL from the reviewer child" \
  "unset" "$(cat "$SPY/openai_base_url_resume")"
check "resume preserves the aborted attempt's events under a1/ (audit not clobbered)" \
  "yes" "$([ -f "$ROOT/reviews/camus-wt-task-r7.watch/a1/events.jsonl" ] && echo yes || echo no)"

# fallback on resume FAILURE (nonzero exit): the script falls through to a FRESH review for the
# round (a fresh `codex exec` recorded to $SPY/args, ran:true) — no new failure mode.
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 8 "sess-resume-bad"
out="$(SPY_RESUME_FAIL=exit run_review_round 8)" || { echo "FAIL resume-fail review errored/hung"; exit 1; }
check "resume failure (exit≠0): resume WAS attempted" \
  "yes" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "resume failure falls back to a FRESH codex exec for the round" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"
check "fallback verdict still normalizes ran:true (fresh review ran)" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; g=json.load(sys.stdin); print("yes" if g["ran"] else "no")')"

# fallback on resume NO-VERDICT (done but empty -o → adapter ran:false): same fresh fallback.
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 9 "sess-resume-empty"
out="$(SPY_RESUME_FAIL=noverdict run_review_round 9)" || { echo "FAIL resume-noverdict review errored/hung"; exit 1; }
check "resume no-verdict falls back to a fresh codex exec (ran:true)" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["ran"] else "no")' || echo no)"

# NO prior thread → today's fresh path is byte-identical (no resume attempted at all).
rm -f "$SPY/args" "$SPY/args_resume"
out="$(run_review_round 10)" || { echo "FAIL no-prior review errored/hung"; exit 1; }
check "no prior aborted thread: resume NOT attempted (fresh path unchanged)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "no prior aborted thread: a fresh codex exec ran" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

# ── Resume-recovery HARDENING (codex-resume-recovery 2026-06-12): a thread_id is NOT sufficient to
# resume — resume fires ONLY on the aborted/abandoned shape (thread_id + NO exit_code + NO last.txt
# verdict). COMPLETION EVIDENCE blocks resume even when exit_code is missing (constraints 2 + 4),
# and a FAILED resume clears the recorded thread_id so a later recovery never resurrects a dead
# thread (constraint 3). All four resolve fail-closed to a fresh review.

# (2) completed-evidence via a last.txt VERDICT (no exit_code file): a prior attempt that already
# produced a valid verdict is DONE — never resume its thread. Stage thread_id + a valid last.txt
# verdict, NO exit_code → resume MUST NOT be attempted; a fresh codex exec runs instead.
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 11 "sess-has-verdict"
printf '{"findings": [], "overall_correctness": "patch is correct"}' \
  > "$ROOT/reviews/camus-wt-task-r11.watch/last.txt"
out="$(run_review_round 11)" || { echo "FAIL completed-verdict review errored/hung"; exit 1; }
check "completed verdict in last.txt BLOCKS resume (constraint 2: resume NOT attempted)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "completed verdict in last.txt: a FRESH codex exec ran instead" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

# (2b) completed-evidence via the exit_code FILE (thread_id present): the wrapper's exit_code means
# the prior attempt completed → resume MUST NOT be attempted (constraint 4 — only no-exit_code shape
# triggers). Garbage last.txt here proves the exit_code file alone blocks it.
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 12 "sess-has-exitcode"
printf '0\n' > "$ROOT/reviews/camus-wt-task-r12.watch/exit_code"
printf 'not json' > "$ROOT/reviews/camus-wt-task-r12.watch/last.txt"
out="$(run_review_round 12)" || { echo "FAIL completed-exitcode review errored/hung"; exit 1; }
check "exit_code file present BLOCKS resume (constraint 4: resume NOT attempted)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "exit_code file present: a FRESH codex exec ran instead" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

# (3) a FAILED resume CLEARS the thread pointer → a SECOND recovery of the same round goes fresh,
# never resurrecting the known-dead thread. First run forces SPY_RESUME_FAIL=exit on a staged round;
# assert resume WAS tried AND the round's meta.json no longer carries a live thread_id. Then run the
# SAME round again (no re-staging) and assert resume is NOT attempted the second time.
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 13 "sess-dead-after-fail"
out="$(SPY_RESUME_FAIL=exit run_review_round 13)" || { echo "FAIL clear-on-fail review errored/hung"; exit 1; }
check "failed resume: resume WAS attempted the first time" \
  "yes" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "failed resume CLEARS the recorded thread_id (constraint 3: meta.json thread_id empty/absent)" \
  "" "$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("thread_id","") or "")
except Exception: print("")' "$ROOT/reviews/camus-wt-task-r13.watch/meta.json" 2>/dev/null)"
rm -f "$SPY/args" "$SPY/args_resume"
out="$(run_review_round 13)" || { echo "FAIL second-recovery review errored/hung"; exit 1; }
check "second recovery of a dead thread does NOT resume (known-dead never resurrected)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "second recovery goes FRESH (a fresh codex exec ran)" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

# (1) stale-pid / NO-KILL in recovery: recovery operates on codex THREADS only — it reads files and
# spawns a FRESH `codex exec resume`, never reading a prior pid nor killing/awaiting an old handle.
# Stage an aborted round whose meta carries a STALE pid (a handle.json pointing at PID 1, which the
# script must never touch); assert the only codex invocation is the resume SPAWN (argv shows
# `exec resume <thread_id>`) and that PID 1 is still alive afterward (no kill aimed at a stale handle).
rm -f "$SPY/args" "$SPY/args_resume"
stage_aborted_round 14 "sess-stale-pid"
python3 -c 'import json,sys; json.dump({"pid": 1, "started_at": 0, "cmd": ["codex"], "cwd": ".",
  "last": sys.argv[2]}, open(sys.argv[1],"w"))' \
  "$ROOT/reviews/camus-wt-task-r14.watch/handle.json" "$ROOT/reviews/camus-wt-task-r14.watch/last.txt"
out="$(run_review_round 14)" || { echo "FAIL stale-pid review errored/hung"; exit 1; }
check "stale-pid recovery: the resume is a fresh 'codex exec resume <thread_id>' spawn (no re-attach)" \
  "yes" "$([ -f "$SPY/args_resume" ] && grep -qx 'resume' "$SPY/args_resume" && grep -qx 'sess-stale-pid' "$SPY/args_resume" && echo yes || echo no)"
# Liveness of PID 1 the same way review_watch._alive judges it: EPERM (a non-root user signalling
# init) means ALIVE, not gone — a bare `kill -0 1` exits nonzero on that EPERM and would falsely
# read "killed" for every non-root run. (PID 1 is never actually killed; we assert it survived.)
check "stale-pid recovery: no kill aimed at the stale handle (PID 1 still alive)" \
  "yes" "$(python3 -c 'import os,sys
try: os.kill(1, 0)
except ProcessLookupError: sys.exit(1)
except PermissionError: pass
except OSError: sys.exit(1)
print("yes")' 2>/dev/null || echo no)"

# (4) PENDING-process / events.jsonl fallback must NOT resume a STILL-RUNNING review. A healthy
# long-running review that returned `pending` leaves events.jsonl (with thread.started) + a LIVE
# local process behind, and meta.json carries NO thread_id for it (the await form persists the id
# only for idle_killed/aborted). Resume reading that live thread off events.jsonl would `codex exec
# resume` a thread whose original local process is still running — the local-process-uncertainty
# rule. Stage events.jsonl + a handle.json whose pid is THIS test process ($$, provably alive) and
# NO meta.json thread_id → resume MUST NOT be attempted; a fresh codex exec runs instead.
rm -f "$SPY/args" "$SPY/args_resume"
PEND="$ROOT/reviews/camus-wt-task-r15.watch"; mkdir -p "$PEND"
python3 -c 'import json,sys; json.dump({"target_dir": sys.argv[2], "round": "15",
  "effort": "medium", "scope": "full"}, open(sys.argv[1],"w"))' "$PEND/meta.json" "$WT"
printf '{"type":"thread.started","thread_id":"sess-still-running"}\n' > "$PEND/events.jsonl"
python3 -c 'import json,sys; json.dump({"pid": int(sys.argv[3]), "started_at": 0, "cmd": ["codex"],
  "cwd": ".", "last": sys.argv[2]}, open(sys.argv[1],"w"))' "$PEND/handle.json" "$PEND/last.txt" "$$"
out="$(run_review_round 15)" || { echo "FAIL pending-live review errored/hung"; exit 1; }
check "pending live process: events.jsonl thread NOT resumed (resume not attempted)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "pending live process: a FRESH codex exec ran instead" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

# (4b) THREAD-ONLY recovery means meta.json is the ONLY resume source (refine finding, conf
# 0.98: the previous version of this case demanded an events.jsonl fallback gated on whether
# the prior local PROCESS was gone — exactly the local-process awareness the hardening
# removed). A thread known ONLY via events.jsonl, with no meta.json thread_id, is DOUBT — and
# doubt resolves to a FRESH review, never a resume.
rm -f "$SPY/args" "$SPY/args_resume"
GONE="$ROOT/reviews/camus-wt-task-r16.watch"; mkdir -p "$GONE"
python3 -c 'import json,sys; json.dump({"target_dir": sys.argv[2], "round": "16",
  "effort": "medium", "scope": "full"}, open(sys.argv[1],"w"))' "$GONE/meta.json" "$WT"
printf '{"type":"thread.started","thread_id":"sess-proc-gone"}\n' > "$GONE/events.jsonl"
out="$(run_review_round 16)" || { echo "FAIL events-only review errored/hung"; exit 1; }
check "events.jsonl-only evidence (no meta thread_id): resume NOT attempted (doubt → fresh)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
check "events.jsonl-only evidence: a FRESH review ran instead" \
  "yes" "$([ -f "$SPY/args" ] && grep -qx -- '--output-schema' "$SPY/args" && echo yes || echo no)"

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
# FULL sha contract (publish audit 2026-06-12, P1): the emitted sha is the expectedHead the
# workflows bind verify to; verify.py names full HEADs, so a --short sha false-fails every
# head-bound verify. The sha must be byte-identical to rev-parse HEAD (40 hex).
check "commit gate emits the FULL HEAD sha (head-binding contract)" \
  "$(git -C "$WT" rev-parse HEAD)" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"

# ── commit gate honesty (git audit 2026-06-12) ────────────────────────────────────────────────
# P1: a failing `git add -A` stages NOTHING (all-or-nothing) — falling through to the empty-index
# check reported "empty" → false no_changes → a false NOOP no ancestry audit can see. The lock
# file is the cheap deterministic way to make add fail (an IDE/background-git race in the wild).
echo "post-lock change" > "$WT/tracked.txt"
WT_GITDIR="$(git -C "$WT" rev-parse --git-dir)"
touch "$WT_GITDIR/index.lock"
out="$(bash "$here/commit.sh" "$WT" "camus: locked")"
rm -f "$WT_GITDIR/index.lock"
check "failed add reports add_failed, never a false empty" \
  "add_failed" "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason","?"))')"

# P3: an agent cloning a repo INSIDE the worktree must not commit a dangling gitlink (a phantom
# submodule with no .gitmodules breaks every future clone). Refused with a named reason.
mkdir -p "$WT/vendor/embedded" && (cd "$WT/vendor/embedded" && git init -q && echo x > f && gitq add -A && gitq -c commit.gpgsign=false commit -qm inner)
out="$(bash "$here/commit.sh" "$WT" "camus: gitlink")"
check "embedded repo refused with a named reason" \
  "embedded_repo" "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason","?"))')"
rm -rf "$WT/vendor"
git -C "$WT" reset -q   # unstage the refused attempt so nothing leaks into later checks

# Hookless + unsigned: a prepare-commit-msg hook that aborts (rc=1) and forced gpg signing with a
# bogus key must BOTH be bypassed — gate commits are machine-generated (--no-verify alone covers
# neither: verified live in the audit).
mkdir -p "$ROOT/hooks" && printf '#!/bin/sh\nexit 1\n' > "$ROOT/hooks/prepare-commit-msg" && chmod +x "$ROOT/hooks/prepare-commit-msg"
git -C "$WT" config core.hooksPath "$ROOT/hooks"
git -C "$WT" config commit.gpgsign true
git -C "$WT" config user.signingkey /nonexistent-key
git -C "$WT" config gpg.format ssh
echo "hooked change" > "$WT/tracked.txt"
out="$(bash "$here/commit.sh" "$WT" "camus: hooked")"
check "commit survives hostile prepare-commit-msg + forced signing" \
  "yes" "$(printf '%s' "$out" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["committed"] else "no")')"
git -C "$WT" config --unset core.hooksPath; git -C "$WT" config --unset commit.gpgsign

# ── Reviewer-identity pin (identity slice) ────────────────────────────────────
# The reviewer model this run pins (CAMUS_CODEX_MODEL on a fresh run, or the model a
# round recorded on resume) is AUTHORITATIVE: validated, appended last so it wins any
# lever, refuses a conflicting -m/--model, and — critically — the SAME model reaches
# both the actual codex command AND the sealed meta/audit, on fresh runs and resumes.
# Each refusal gets its own clean round so the ONLY reason it fires is the one named
# (a recorded reviewer_model left on a reused round would otherwise mask the cause).
review_exit_fresh() { # $1 = round — clean fresh review, echoes the exit code
  rm -rf "$ROOT/reviews/camus-wt-task-r$1.watch" "$ROOT/reviews/camus-wt-task-r$1.json"
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", sys.argv[4]],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
print(r.returncode)
PY
}
# happy path: a fresh pin reaches codex's argv, the round meta, and the audit alike
rm -rf "$ROOT/reviews/camus-wt-task-r1.watch" "$ROOT/reviews/camus-wt-task-r1.json"
export CAMUS_CODEX_MODEL=fake-pinned-reviewer
run_review >/dev/null || { echo "FAIL reviewer-pin review errored/hung"; exit 1; }
check "CAMUS_CODEX_MODEL appended as the reviewer -m" \
  "yes" "$(grep -qx 'fake-pinned-reviewer' "$SPY/args" && echo yes || echo no)"
check "pinned reviewer persisted to the round meta.json" \
  "fake-pinned-reviewer" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_model",""))' "$ROOT/reviews/camus-wt-task-r1.watch/meta.json" 2>/dev/null)"
check "pinned reviewer recorded in the audit (read from meta, not the env)" \
  "fake-pinned-reviewer" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_model",""))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
check "the ACTUAL effort the round ran at is sealed in the audit (from meta, not a snapshot)" \
  "medium" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_effort",""))' "$ROOT/reviews/camus-wt-task-r1.json" 2>/dev/null)"
unset CAMUS_CODEX_MODEL
export CAMUS_CODEX_MODEL='bad model; rm -rf /'
check "invalid CAMUS_CODEX_MODEL is refused (exit 2)" "2" "$(review_exit_fresh 30)"
unset CAMUS_CODEX_MODEL
export CAMUS_CODEX_MODEL=fake-pin
export CAMUS_CODEX_ARGS="-m other-model"
check "conflict: a -m in CAMUS_CODEX_ARGS is refused" "2" "$(review_exit_fresh 31)"
export CAMUS_CODEX_ARGS="--model other-model"
check "conflict: a --model in CAMUS_CODEX_ARGS is refused" "2" "$(review_exit_fresh 32)"
unset CAMUS_CODEX_ARGS
export CAMUS_CODEX_LIGHT_MODEL=fake-mini
check "conflict: the light-model ladder (its own -m) is refused" "2" "$(review_exit_fresh 33)"
unset CAMUS_CODEX_LIGHT_MODEL
unset CAMUS_CODEX_MODEL

# ── Reviewer identity across RESUME (codex's -m must equal the sealed model) ──────
# Stage a resumable round: thread_id + a recorded reviewer_model, and (crucially) NO
# completion evidence (no exit_code, no last.txt verdict) so the resume path fires.
stage_resume_with_model() { # $1 = round, $2 = thread_id, $3 = reviewer_model
  local d="$ROOT/reviews/camus-wt-task-r$1.watch"
  rm -rf "$d" "$ROOT/reviews/camus-wt-task-r$1.json"; mkdir -p "$d"
  python3 -c 'import json,sys; json.dump({"target_dir": sys.argv[2], "round": sys.argv[3],
    "effort": "medium", "scope": "full", "thread_id": sys.argv[4], "reviewer_model": sys.argv[5],
    "contract": "rc1", "qualification": "qual1", "origin": "cli", "operator": "cli",
    "transport": "cli-detached", "connection": "configured"},
    open(sys.argv[1],"w"))' "$d/meta.json" "$WT" "$1" "$2" "$3"
  printf '{"type":"thread.started","thread_id":"%s"}\n' "$2" > "$d/events.jsonl"
}
resume_exit() { # $1 = round — echoes the exit code (resume refusal paths)
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" <<'PY'
import subprocess, sys
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", sys.argv[4]],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30)
print(r.returncode)
PY
}
# Every field belongs to the original thread. A resume may not overwrite any one of them with the
# current request and thereby relabel old work. Missing legacy fields fail closed too.
resume_drift_round=40
for resume_field in contract scope qualification origin operator transport connection; do
  rm -f "$SPY/args_resume"
  stage_aborted_round "$resume_drift_round" "sess-drift-$resume_field"
  python3 -c 'import json,sys
p, field = sys.argv[1:3]
d = json.load(open(p))
d[field] = {"contract":"rc0", "scope":"light", "qualification":"qual1",
  "origin":"other-loop", "operator":"other-operator", "transport":"http",
  "connection":"configured"}[field]
json.dump(d, open(p,"w"))' \
    "$ROOT/reviews/camus-wt-task-r$resume_drift_round.watch/meta.json" "$resume_field"
  check "resume refuses prior $resume_field drift" "2" "$(resume_exit "$resume_drift_round")"
  check "resume $resume_field drift is refused before codex spawn" \
    "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
  resume_drift_round=$((resume_drift_round + 1))
done
rm -f "$SPY/args_resume"
stage_aborted_round "$resume_drift_round" "sess-drift-missing"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop("contract",None); json.dump(d,open(p,"w"))' \
  "$ROOT/reviews/camus-wt-task-r$resume_drift_round.watch/meta.json"
check "resume refuses a legacy watch missing a carried field" "2" "$(resume_exit "$resume_drift_round")"
check "missing resume field is refused before codex spawn" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
# Reverse qualification direction: the prior pinned thread is truly qual1; claiming builtin1 must
# be refused just as builtin1→qual1 is above.
resume_drift_round=$((resume_drift_round + 1))
rm -f "$SPY/args_resume"
stage_resume_with_model "$resume_drift_round" "sess-drift-qual-reverse" "pinned-reviewer"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["qualification"]="builtin1"; json.dump(d,open(p,"w"))' \
  "$ROOT/reviews/camus-wt-task-r$resume_drift_round.watch/meta.json"
check "resume refuses qualification drift in the qual1→builtin1 direction" \
  "2" "$(resume_exit "$resume_drift_round")"
check "reverse qualification drift is refused before codex spawn" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
# resume WITHOUT the env: codex runs with the RECORDED model (argv), and the audit
# seals that SAME model — the two can no longer disagree (the P1 this closes: the
# authoritative reviewer is now resolved BEFORE the args, so it reaches the command).
rm -f "$SPY/args" "$SPY/args_resume"
stage_resume_with_model 20 "sess-r20" "meta-recorded-reviewer"
run_review_round 20 >/dev/null || { echo "FAIL resume-identity review errored/hung"; exit 1; }
check "resume without the env RESUMES the recorded thread (argv shows exec resume)" \
  "yes" "$([ -f "$SPY/args_resume" ] && grep -qx 'resume' "$SPY/args_resume" && echo yes || echo no)"
check "resume runs codex with the RECORDED reviewer model (argv -m, not an ambient one)" \
  "yes" "$(grep -qx 'meta-recorded-reviewer' "$SPY/args_resume" && echo yes || echo no)"
check "resume seals that SAME reviewer in the audit (argv and audit agree)" \
  "meta-recorded-reviewer" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_model",""))' "$ROOT/reviews/camus-wt-task-r20.json" 2>/dev/null)"
# resume + an AMBIENT model (CAMUS_CODEX_ARGS) must not be allowed to diverge → refuse
rm -f "$SPY/args" "$SPY/args_resume"
stage_resume_with_model 21 "sess-r21" "meta-recorded-reviewer"
export CAMUS_CODEX_ARGS="-m other-model"
check "resume + ambient -m (CAMUS_CODEX_ARGS) is refused (argv would diverge from the sealed model)" \
  "2" "$(resume_exit 21)"
check "resume conflict refused BEFORE any codex spawn (no resume argv written)" \
  "no" "$([ -f "$SPY/args_resume" ] && echo yes || echo no)"
unset CAMUS_CODEX_ARGS
# resume + the medium light-model ladder (its own -m) is the same divergence → refuse
rm -f "$SPY/args" "$SPY/args_resume"
stage_resume_with_model 22 "sess-r22" "meta-recorded-reviewer"
export CAMUS_CODEX_LIGHT_MODEL=fake-mini
check "resume + light-model ladder is refused (the recorded model must win, not the ladder)" \
  "2" "$(resume_exit 22)"
unset CAMUS_CODEX_LIGHT_MODEL
# resume with a MISMATCHED env model is refused rather than rewrite the sealed identity
rm -f "$SPY/args" "$SPY/args_resume"
stage_resume_with_model 23 "sess-r23" "original-reviewer"
export CAMUS_CODEX_MODEL=different-reviewer
check "resume with a mismatched reviewer model is refused (exit 2)" "2" "$(resume_exit 23)"
unset CAMUS_CODEX_MODEL
# resume with a MATCHING env model proceeds, and codex still runs with exactly that model
rm -f "$SPY/args" "$SPY/args_resume"
stage_resume_with_model 24 "sess-r24" "matching-reviewer"
export CAMUS_CODEX_MODEL=matching-reviewer
run_review_round 24 >/dev/null || { echo "FAIL resume-match review errored/hung"; exit 1; }
check "resume with a MATCHING env runs codex with that model (argv -m present)" \
  "yes" "$(grep -qx 'matching-reviewer' "$SPY/args_resume" && echo yes || echo no)"
unset CAMUS_CODEX_MODEL

# ── "old meta exists" is NOT "is resuming": a COMPLETED prior attempt (has completion
# evidence → will_resume empty) must not force its recorded reviewer onto a fresh
# re-review. The prior reviewer governs ONLY a genuine resume; otherwise the prior meta
# is discarded (rm -rf) and the caller's current CAMUS_CODEX_MODEL wins.
stage_completed_round() { # $1 = round, $2 = recorded reviewer_model (with completion evidence)
  local d="$ROOT/reviews/camus-wt-task-r$1.watch"
  rm -rf "$d" "$ROOT/reviews/camus-wt-task-r$1.json"; mkdir -p "$d"
  python3 -c 'import json,sys; json.dump({"target_dir": sys.argv[2], "round": sys.argv[3],
    "effort": "medium", "scope": "full", "thread_id": sys.argv[4], "reviewer_model": sys.argv[5]},
    open(sys.argv[1],"w"))' "$d/meta.json" "$WT" "$1" "sess-r$1-done" "$2"
  printf '0\n' > "$d/exit_code"   # completion evidence → NOT resumable
  printf '{"type":"thread.started","thread_id":"sess-r%s-done"}\n' "$1" > "$d/events.jsonl"
}
# a DIFFERENT model on the fresh re-review is NOT refused (the prior isn't authoritative)
rm -f "$SPY/args" "$SPY/args_resume"
stage_completed_round 25 "old-completed-reviewer"
export CAMUS_CODEX_MODEL=new-fresh-reviewer
run_review_round 25 >/dev/null || { echo "FAIL completed-not-resume review errored/hung (a fresh re-review must not be refused)"; exit 1; }
check "completed prior (not a resume) is not resumed: a FRESH codex exec ran" \
  "yes" "$([ -f "$SPY/args" ] && [ ! -f "$SPY/args_resume" ] && echo yes || echo no)"
check "completed prior: codex runs the NEW model, not the stale recorded one" \
  "yes" "$(grep -qx 'new-fresh-reviewer' "$SPY/args" && ! grep -qx 'old-completed-reviewer' "$SPY/args" && echo yes || echo no)"
check "completed prior: the audit seals the NEW model (no stale-identity carryover)" \
  "new-fresh-reviewer" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reviewer_model",""))' "$ROOT/reviews/camus-wt-task-r25.json" 2>/dev/null)"
unset CAMUS_CODEX_MODEL
# and with NO env, a completed prior does not INHERIT the stale model either
rm -f "$SPY/args" "$SPY/args_resume"
stage_completed_round 26 "old-completed-reviewer"
run_review_round 26 >/dev/null || { echo "FAIL completed-no-env review errored/hung"; exit 1; }
check "completed prior + no env: the stale recorded model is NOT inherited into the fresh review" \
  "no" "$(grep -qx 'old-completed-reviewer' "$SPY/args" && echo yes || echo no)"

# ── REVIEW BINDING: the invocation that RAN must be the one REQUESTED ──────────────
# Field report 2026-08-04 (a WP6 game run): the workflow requested review round 2 at
# high effort, the thin runner's Bash call dropped the trailing `2 high`, the script
# defaulted to round 0 / medium, and the loop ACCEPTED that r0 receipt as round 2 and
# advanced to r3. Round is no longer defaulted: it resolves from the mechanical
# channels (request file, env) or argv, every disagreement is an infra refusal, and
# the receipt carries requested-vs-actual so a consumer can check the pairing.
bind_err() { # returns the refusal reason (empty when the binding was accepted)
  bash "$here/codex_review.sh" "$@" 2>/dev/null | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: print("unparseable"); raise SystemExit
e = d.get("error") or ""
print("refused" if "review binding refused" in e else "")'
}
REQ="$CAMUS_REVIEW_DIR/$(basename "$WT")-request.json"
rm -f "$REQ"

# The exact field failure: the relayed command lost its round and effort.
check "an unbound review (round dropped from the relay) is refused, never reviewed as r0" \
  "refused" "$(bind_err "$WT" "task ctx")"
# The old default wrote <wt>-r0.json, and THAT file is what got accepted as a
# requested round. No r0 receipt may exist for this worktree at all. (Earlier cases
# in this suite legitimately leave receipts for real rounds, so this counts r0 only.)
check "no r0 receipt is written for an unbound invocation (nothing to mistake for a later round)" \
  "0" "$(ls "$CAMUS_REVIEW_DIR" 2>/dev/null | grep -cE -- "^$(basename "$WT")-r0\.json$")"
# Round 0 was the old silent default; asking for it explicitly is still not a round.
check "round 0 is refused explicitly (rounds start at 1)" \
  "refused" "$(bind_err "$WT" "task ctx" 0 high)"
check "a non-numeric round is refused" "refused" "$(bind_err "$WT" "task ctx" two high)"

# The mechanical channel: a request file the relay cannot drop.
python3 -c 'import json,sys; json.dump({"gate_nonce":"nonce-1","worktree":sys.argv[1],"round":2,"effort":"high"}, open(sys.argv[2],"w"))' "$WT" "$REQ"
check "argv disagreeing with the request file is refused (requested r2, argv r3)" \
  "refused" "$(bind_err "$WT" "task ctx" 3 high)"
check "effort disagreeing with the request file is refused (requested high, argv medium)" \
  "refused" "$(bind_err "$WT" "task ctx" 2 medium)"
# Env is the other mechanical channel; it must agree too.
check "env disagreeing with the request file is refused" \
  "refused" "$(CAMUS_REVIEW_ROUND=5 bind_err "$WT" "task ctx")"
# A request file belonging to a different worktree must never bind this review.
python3 -c 'import json; json.dump({"gate_nonce":"n","worktree":"/somewhere/else","round":2,"effort":"high"}, open(__import__("sys").argv[1],"w"))' "$REQ"
check "a cross-worktree request file is refused" "refused" "$(bind_err "$WT" "task ctx" 2 high)"

# POSITIVE CONTROL — the refusals above must not be a script that simply always
# refuses. With the request file present, the SAME dropped-argv command that failed
# above now binds to r2/high, reviews, and seals a receipt whose binding proves it.
python3 -c 'import json,sys; json.dump({"gate_nonce":"nonce-1","worktree":sys.argv[1],"round":2,"effort":"high"}, open(sys.argv[2],"w"))' "$WT" "$REQ"
check "the request file binds a dropped-argv invocation instead of refusing it" \
  "" "$(bind_err "$WT" "task ctx")"
BOUND_RECEIPT="$CAMUS_REVIEW_DIR/$(basename "$WT")-r2.json"
check "the receipt lands under the REQUESTED round, not r0" \
  "yes" "$([ -f "$BOUND_RECEIPT" ] && echo yes || echo no)"
check "the receipt binds requested/actual round, effort, nonce, worktree and backend" \
  "2|2|high|high|nonce-1|codex|True|True" \
  "$(python3 -c 'import json,os,sys
b = json.load(open(sys.argv[1])).get("binding") or {}
r = json.load(open(sys.argv[1]))
print("|".join(str(x) for x in [
  b.get("round_requested"), b.get("round_actual"), b.get("effort_requested"), b.get("effort_actual"),
  b.get("gate_nonce"), b.get("reviewer_backend"), b.get("bound"),
  os.path.realpath(sys.argv[2]) == r.get("worktree_canonical")]))' "$BOUND_RECEIPT" "$WT")"

# ── REPLAY preserves sealed rc1 fields only after proving the stored contract matches this
# executor. An older/missing contract is an infra refusal and must never be relabelled. ───────────
rm -f "$REQ"   # no stale request file may bind this round (it would refuse the argv round below)
REPLAY_NONCE="replay-nonce-1"
run_review_r() { # $1 round — runs with the replay gate nonce injected into the review's env
  python3 - "$R" "$here/codex_review.sh" "$WT" "$1" "$REPLAY_NONCE" <<'PY'
import os, subprocess, sys
env = dict(os.environ, CAMUS_GATE_NONCE=sys.argv[5])
r = subprocess.run(["bash", sys.argv[2], sys.argv[3], "the task", sys.argv[4], "medium"],
                   cwd=sys.argv[1], capture_output=True, text=True, timeout=30, env=env)
sys.stdout.write(r.stdout)
PY
}
run_review_r 7 >/dev/null 2>&1 || { echo "FAIL replay-fixture review errored/hung"; exit 1; }
REPLAY_AUDIT="$CAMUS_REVIEW_DIR/$(basename "$WT")-r7.json"
check "fresh run seals rc1 fields in the round audit" \
  "rc1|builtin1|vendor_managed" \
  "$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1]))["binding"]; print("|".join(str(b.get(k)) for k in ("contract","qualification","connection")))' "$REPLAY_AUDIT" 2>/dev/null)"
# Corrupt the audit's rc1 fields to null, then replay a SAME-contract finished round: the audit must
# be rewritten WITH the sealed fields, never left null as the pre-fix ordering did.
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["binding"].update({"contract":None,"qualification":None,"connection":None}); json.dump(d,open(p,"w"))' "$REPLAY_AUDIT"
REPLAY_META="$CAMUS_REVIEW_DIR/$(basename "$WT")-r7.watch/meta.json"
replay_out="$(run_review_r 7)" || { echo "FAIL replay review errored/hung"; exit 1; }
check "same-contract replay emits the sealed rc1 contract" \
  "rc1" \
  "$(printf '%s' "$replay_out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["binding"]["contract"])')"
check "same-contract replay RESTORES the rc1 audit fields from meta.json (not null)" \
  "rc1|builtin1|vendor_managed" \
  "$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1]))["binding"]; print("|".join(str(b.get(k)) for k in ("contract","qualification","connection")))' "$REPLAY_AUDIT" 2>/dev/null)"

# Simulate a completed watch written by an older executor. Replay must refuse before adapter
# emission or audit rewrite; otherwise it launders rc0 into a current-looking rc1 receipt.
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["contract"]="rc0"; json.dump(d,open(p,"w"))' "$REPLAY_META"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["binding"]["contract"]="audit-sentinel"; json.dump(d,open(p,"w"))' "$REPLAY_AUDIT"
skew_out="$(run_review_r 7)" || { echo "FAIL skewed replay errored/hung"; exit 1; }
check "cross-contract replay is an infrastructure refusal" \
  "False|review-contract-drift|True" \
  "$(printf '%s' "$skew_out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("|".join(map(str,[d.get("ran"),d.get("infra_error"),"contract drift" in d.get("error","")])))')"
check "cross-contract replay emits no accepted binding" \
  "yes" \
  "$(printf '%s' "$skew_out" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("binding") is None else "no")')"
check "cross-contract replay does not rewrite the prior audit" \
  "audit-sentinel" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["binding"]["contract"])' "$REPLAY_AUDIT" 2>/dev/null)"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
