#!/usr/bin/env bash
# Tests for _guard.sh camus_guard (auto-mode target guard). Builds temp repos + camus-wt worktrees and
# checks the accept/reject matrix, incl. branch/worktree coherence, unknown-mode rejection, and the
# CAMUS_REPO_ROOT (cd-immutable) anchor. Run:  bash test_guard.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_guard.sh"
unset CAMUS_REPO_ROOT   # default cases use the $PWD-fallback anchor; the env-anchor case sets it explicitly

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected $2 got $3)"; fail=$((fail + 1)); fi; }
gitq() { git -c init.defaultBranch=main -c user.email=a@b.c -c user.name=x "$@"; }
# Run camus_guard from caller dir $1 with the remaining args; echo only the exit code.
run()    { ( cd "$1" && shift && camus_guard "$@" 2>/dev/null; echo $? ); }
# Same but with CAMUS_REPO_ROOT pinned to $2 (the env anchor), caller cwd $1.
envrun() { ( cd "$1"; export CAMUS_REPO_ROOT="$2"; shift 2; camus_guard "$@" 2>/dev/null; echo $? ); }

ROOT="$(mktemp -d)"
R="$ROOT/repo"; mkdir -p "$R"
( cd "$R" && gitq init -q && echo hi > f && gitq add -A && gitq commit -qm init && gitq checkout -q -b camus/feat-x )
# coherent task worktree: branch camus/feat/x/task ↔ dir camus-wt-task
( cd "$R" && gitq worktree add -q -b camus/feat/x/task "$ROOT/camus-wt-task" >/dev/null 2>&1 )
WT="$ROOT/camus-wt-task"
# INCOHERENT worktree: branch camus/feat/x/other ↔ dir camus-wt-mismatch (suffix 'other' != 'mismatch')
( cd "$R" && gitq worktree add -q -b camus/feat/x/other "$ROOT/camus-wt-mismatch" >/dev/null 2>&1 )
BADWT="$ROOT/camus-wt-mismatch"
# a DIFFERENT repo that also looks camus-ish — the same-repo check must still reject it
O="$ROOT/camus-wt-task2"; mkdir -p "$O"
( cd "$O" && gitq init -q && echo hi > f && gitq add -A && gitq commit -qm init && gitq checkout -q -b camus/feat/x/task2 )

# accepts
check "verify accepts repo-root on camus/feat-* branch" 0 "$(run "$R" repo_or_worktree "$R")"
check "verify accepts coherent camus-wt worktree"       0 "$(run "$R" repo_or_worktree "$WT")"
check "worktree-mode accepts coherent camus-wt"         0 "$(run "$R" worktree "$WT")"
check "CAMUS_REPO_ROOT + cwd in repo accepts"           0 "$(envrun "$R" "$R" repo_or_worktree "$WT")"
check "CAMUS_REPO_ROOT + cwd in a worktree accepts"     0 "$(envrun "$WT" "$R" repo_or_worktree "$WT")"
check "CAMUS_REPO_ROOT + cwd NOT in repo rejects"       1 "$(envrun "$ROOT" "$R" repo_or_worktree "$WT")"
check "CAMUS_REPO_ROOT + cwd in DIFFERENT repo rejects" 1 "$(envrun "$O" "$R" repo_or_worktree "$WT")"
# rejects
check "worktree-mode rejects repo root"              1 "$(run "$R" worktree "$R")"
check "rejects INCOHERENT worktree name"             1 "$(run "$R" worktree "$BADWT")"
check "rejects different repo (worktree mode)"       1 "$(run "$R" worktree "$O")"
check "rejects different repo (verify mode)"         1 "$(run "$R" repo_or_worktree "$O")"
check "rejects non-git target"                       1 "$(run "$R" repo_or_worktree "$ROOT")"
check "rejects caller not in a git repo"             1 "$(run "$ROOT" repo_or_worktree "$R")"
check "rejects unknown mode"                         1 "$(run "$R" bogus_mode "$WT")"
# repo-root on a non-feat camus/ branch must reject (verify allows repo root ONLY on camus/feat-*)
( cd "$R" && gitq checkout -q -b camus/notfeat )
check "rejects repo-root on non-feat camus/ branch"     1 "$(run "$R" repo_or_worktree "$R")"
( cd "$R" && gitq checkout -q main )
check "rejects target on non-camus branch"              1 "$(run "$R" repo_or_worktree "$R")"
( cd "$R" && gitq checkout -q camus/feat-x )

rm -rf "$ROOT"
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
