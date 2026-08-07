#!/usr/bin/env bash
# THE RUNTIME CONTRACT FOR prep.sh / verify.sh: a PLAIN trusted-script command, no `cd` prefix.
#
# Two live defects shaped this file.
#  - WP7 (20260805-181917-f4b1): the scripts anchored `_guard.sh` at $PWD, a fresh thin-runner
#    process need not start inside the target repo, and a valid same-repo camus-wt-* worktree was
#    refused with `target rejected by camus_guard` after the review had already gone clean.
#  - WP9 (20260806-145411-hy1w): the first fix prefixed both calls with REPO_CD. Inside a LINKED
#    worktree `git rev-parse --show-toplevel` is that worktree, so a run targeting the WP8 worktree
#    emitted `cd <wp8> && verify.sh <wp9>`. Auto mode denied the cross-worktree compound command,
#    the runner answered in prose, and the loop reported a missing toolchain in a worktree it had
#    never measured.
#
# So the command the orchestrator emits is now a bare `bash verify.sh <wt>` and the SCRIPT anchors
# itself off the process-level CAMUS_REPO_ROOT (`camus_anchor`). What must hold:
#   1. the production-shaped linked-worktree call runs, from every cwd a real runner may inherit —
#      including a SIBLING worktree, the WP9 shape — and returns real verification JSON
#   2. the same-repository / branch / worktree guard is NOT weakened: a foreign repo is refused,
#      a cwd in a different repo than the anchor is refused, a bogus anchor is refused
#   3. with no anchor at all the old $PWD fallback still refuses — camus_guard is untouched
# The guard is never modified by this test; only the caller's cwd and environment change.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pass=0; fail=0
ok() { if [ "$2" = "1" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1 ${3:-}"; fail=$((fail+1)); fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
outside="$tmp/outside-any-repo"; mkdir -p "$outside"

git_q() { git -C "$1" "${@:2}" >/dev/null 2>&1; }

# The trusted repo, with TWO coherent camus-wt-* linked worktrees of it — the WP8/WP9 pair.
target="$tmp/target-repo"; mkdir -p "$target"
git_q "$target" init -q || { echo "  skip (git unavailable)"; exit 0; }
git_q "$target" config user.email t@example.com
git_q "$target" config user.name t
printf 'x\n' > "$target/a.txt"
git_q "$target" add -A
git_q "$target" commit -qm init
wt="$tmp/camus-wt-wp9-probe"
git_q "$target" worktree add -q -b "camus/wp9-probe" "$wt" || { echo "  skip (git worktree unavailable)"; exit 0; }
sibling="$tmp/camus-wt-wp8-probe"
git_q "$target" worktree add -q -b "camus/wp8-probe" "$sibling"

# A foreign repo, and a coherently-named worktree that belongs to IT rather than to the trusted
# target — the cross-repo case the guard exists for.
foreign="$tmp/foreign-repo"; mkdir -p "$foreign"
git_q "$foreign" init -q
git_q "$foreign" config user.email t@example.com
git_q "$foreign" config user.name t
printf 'y\n' > "$foreign/b.txt"
git_q "$foreign" add -A
git_q "$foreign" commit -qm init
fwt="$tmp/camus-wt-foreign-probe"
git_q "$foreign" worktree add -q -b "camus/foreign-probe" "$fwt"

jqf() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$2', ''))" <<< "$1" 2>/dev/null; }

# THE PRODUCTION SHAPE, verbatim: one trusted script, its target as the only argument, no `cd`,
# with the trust anchor arriving through the PROCESS environment the way a real auto-mode session
# exports it. `run <cwd> <anchor> <script> <target>` — nothing else is added.
run() {
  local cwd="$1" anchor="$2" script="$3" tgt="$4"
  ( cd "$cwd" || exit 1
    if [ -n "$anchor" ]; then export CAMUS_REPO_ROOT="$anchor"; else unset CAMUS_REPO_ROOT; fi
    export CAMUS_VERIFY_CMD=true
    bash "$here/$script" "$tgt" 2>/dev/null )
}

echo "test_prep_verify_cwd:"

# ── 1. THE PRODUCTION-SHAPED CALL RUNS, FROM EVERY CWD A RUNNER MAY INHERIT ─────────
# The WP9 shape first: cwd is a SIBLING linked worktree, the target is a different one.
out="$(run "$sibling" "$target" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "plain verify from a SIBLING worktree returns a real verdict (the WP9 shape)" "$r" "$out"
head_seen="$(jqf "$out" head)"
[ "${#head_seen}" = "40" ] && r=1 || r=0
ok "…real verification JSON, naming the HEAD it certified" "$r" "$out"
[ "$head_seen" = "$(git -C "$wt" rev-parse HEAD)" ] && r=1 || r=0
ok "…and it is the TARGET worktree's HEAD, not the sibling's" "$r" "$out"

# The WP7 shape: a fresh runner process that started outside any repository.
out="$(run "$outside" "$target" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "plain verify from outside any repo returns a real verdict (the WP7 shape)" "$r" "$out"

out="$(run "$target" "$target" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "plain verify from the main checkout returns a real verdict" "$r" "$out"

out="$(run "$outside" "$target" prep.sh "$wt")"
[ "$(jqf "$out" prepped)" = "True" ] && r=1 || r=0
ok "plain prep reaches the worktree from outside any repo" "$r" "$out"

out="$(run "$sibling" "$target" prep.sh "$wt")"
[ "$(jqf "$out" prepped)" = "True" ] && r=1 || r=0
ok "plain prep reaches the worktree from a sibling worktree" "$r" "$out"

# ── 2. THE GUARD IS NOT WEAKENED ────────────────────────────────────────────────────
out="$(run "$outside" "$target" verify.sh "$fwt")"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "a FOREIGN repository target is still refused by verify" "$r" "$out"
[ "$(jqf "$out" inconclusive)" = "True" ] && r=1 || r=0
ok "…as inconclusive, never a code failure" "$r" "$out"
out="$(run "$outside" "$target" prep.sh "$fwt")"
[ "$(jqf "$out" prepped)" = "False" ] && r=1 || r=0
ok "a FOREIGN repository target is still refused by prep" "$r" "$out"
[ "$(jqf "$out" reason)" = "guard_refused" ] && r=1 || r=0
ok "…naming the guard, not a dependency problem" "$r" "$out"

# The anchor's own cross-check survives self-anchoring: a cwd inside a DIFFERENT repo than
# CAMUS_REPO_ROOT is the `CAMUS_REPO_ROOT=/other <script> /other/…` override shape, and is refused
# BEFORE any cd happens. (camus_anchor only anchors a cwd that is in the anchor's repo, or in none.)
out="$(run "$foreign" "$target" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "a cwd in a DIFFERENT repo than the anchor is still refused" "$r" "$out"
# Where the boundary actually is, stated so nobody re-derives a stronger claim from the case above:
# with cwd, anchor AND target all inside one repo, the caller genuinely IS that repo and the guard
# accepts it — as it always has, and as a manual run must. What stops an inline
# `CAMUS_REPO_ROOT=/other verify.sh /other/…` in an auto session is the permission matcher (an
# env-prefixed command matches no allow rule), plus the cwd check asserted directly above. Pinned
# as ACCEPTED so a future "harden the anchor" change has to notice it is changing manual runs too.
out="$(run "$foreign" "$foreign" verify.sh "$fwt")"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "a self-consistent repo (cwd = anchor = target's repo) is accepted, as manual runs require" "$r" "$out"

out="$(run "$outside" "$outside" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "an anchor that is not a git repo at all is refused" "$r" "$out"

# ── 2b. THE VERIFIER OVERRIDE IS A FLAG, NOT AN ENV-ASSIGNMENT PREFIX ───────────────
# `CAMUS_VERIFY_CMD=... verify.sh <wt>` matches no allow rule, and a real Haiku runner in auto mode
# refused it outright — it read an assignment in front of a trusted script as command injection
# (isolated auto-mode preflight, 2026-08-06). As a flag the line stays a plain trusted-script call.
out="$( cd "$outside" && CAMUS_REPO_ROOT="$target" bash "$here/verify.sh" "$wt" --verify-cmd 'true' 2>/dev/null )"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "--verify-cmd runs the named verifier and returns a verdict" "$r" "$out"
[ "$(python3 -c "import json,sys;d=json.load(sys.stdin);print(d['checks'][0]['name'])" <<< "$out" 2>/dev/null)" = "custom" ] && r=1 || r=0
ok "…and it is the CUSTOM verifier, not an auto-detected one" "$r" "$out"
out="$( cd "$outside" && CAMUS_REPO_ROOT="$target" bash "$here/verify.sh" "$wt" --verify-cmd '' 2>/dev/null )"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "an EMPTY --verify-cmd is refused, never verified-as-nothing" "$r" "$out"
out="$( cd "$outside" && CAMUS_REPO_ROOT="$target" bash "$here/verify.sh" "$wt" --nonsense v 2>/dev/null )"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "an unrecognised argument is refused rather than guessed" "$r" "$out"
# The inherited env still works for manual and CI runs (the flag wins when both are given).
out="$( cd "$outside" && CAMUS_REPO_ROOT="$target" CAMUS_VERIFY_CMD=true bash "$here/verify.sh" "$wt" 2>/dev/null )"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "an inherited CAMUS_VERIFY_CMD is still honoured for manual runs" "$r" "$out"

# ── 3. THE $PWD FALLBACK IS UNCHANGED ───────────────────────────────────────────────
# No CAMUS_REPO_ROOT: camus_anchor does nothing and camus_guard's original $PWD anchor decides.
out="$(run "$outside" "" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "False" ] && r=1 || r=0
ok "with NO anchor exported, an outside cwd is still refused (guard untouched)" "$r" "$out"
out="$(run "$target" "" verify.sh "$wt")"
[ "$(jqf "$out" pass)" = "True" ] && r=1 || r=0
ok "with NO anchor exported, a manual run from the repo still works" "$r" "$out"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
