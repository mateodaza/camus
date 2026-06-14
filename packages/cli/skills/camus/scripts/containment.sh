#!/usr/bin/env bash
# Containment receipt: is the MAIN repo tree dirty mid-task? (the worktree-containment guard).
#   containment.sh <repo>
#
# WHY A SCRIPT (live field soak 2026-06-13, finding 8 — the containment FALSE-POSITIVE+NEGATIVE):
# the loop used to ask a thin agent to run `git status --porcelain` and echo stdout, verdict =
# "non-empty reply ⇒ breach". An agent reply that was a preamble / "(no output)" / an error /
# a budget-exhaustion stub became a FALSE confirmed "containment breach" that halted the feat;
# and an EMPTY reply on an agent FAILURE (cd silently failed, command never ran, budget-killed
# before output) read identically to "tree is clean" — so a REAL leak could sail into the merge
# unseen. Both directions are closed by reading git's answer MECHANICALLY here and emitting a
# {ran} receipt the workflow parses (merge.sh / verify.py git_porcelain discipline); the thin
# runner only echoes this JSON.
#
# Emits EXACTLY ONE JSON object on stdout, always exits 0:
#   {"ran": true,  "dirty": <bool>, "paths": "<verbatim porcelain incl. untracked; \"\" when clean>"}
#   {"ran": false, "error": "<reason>"}     # cd/git failed — the answer was NOT obtained
# The {ran:false} case is the cardinal fix: "could not obtain the answer" must read as
# INCONCLUSIVE/infra, NEVER as a breach and NEVER as clean.
#
# --untracked-files=normal INCLUDES untracked files (live re-soak 2026-06-14): an UNTRACKED leak in
# the parent tree breaks the merge. The old --untracked-files=no rationale ("only TRACKED-file mutation
# can ever merge") was FALSE — `git merge` ABORTS when an incoming tracked file would overwrite an
# untracked parent file (exactly how a classifier-leaked test file hard-failed integration). `normal`
# RESPECTS .gitignore, so gitignored build caches/coverage/snapshots still don't show; the remaining
# false-positive source (un-ignored artifacts the parent-tree baseline-verify writes) is handled by the
# CALLER, which DELTAS this porcelain against a baseline captured before the task — only NEW dirt fires.
# This script reports the full truth; the caller decides what is a leak. --ignore-submodules=all per the
# existing containment discipline (a merged submodule-pointer bump leaves a permanent ` M sub` otherwise).
set -uo pipefail

repo="${1:?usage: containment.sh <repo>}"

emit_err() { # $1 = reason — the answer was NOT obtained (inconclusive, never a verdict)
  printf '%s' "$1" | python3 -c 'import json,sys
print(json.dumps({"ran": False, "error": sys.stdin.buffer.read().decode("utf-8","replace")[:300]}))'
  exit 0
}

# Target guard (defense in depth, fail closed): containment is only ever called feat-scoped, where
# the main tree is on camus/feat-* (repo_or_worktree accepts exactly that, or a camus-wt-* worktree).
# A guard refusal is an UNOBTAINED answer (ran:false), never a breach.
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_guard.sh"
guard_err="$(camus_guard repo_or_worktree "$repo" 2>&1)" || emit_err "${guard_err:-guard refused}"

# git stderr → tmpfile so it can't pollute the porcelain on stdout; a non-zero exit is an
# unobtained answer (ran:false), never a confident clean/dirty verdict.
tmp="$(mktemp "${TMPDIR:-/tmp}/camus-containment-err.XXXXXX")" || emit_err "mktemp failed"
trap 'rm -f "$tmp"' EXIT
status_out="$(git -C "$repo" status --porcelain --untracked-files=normal --ignore-submodules=all 2>"$tmp")"
rc=$?
if [ "$rc" -ne 0 ]; then
  emit_err "git status failed (exit $rc): $(cat "$tmp")"
fi

# The ONLY path that produces a verdict: git ran and answered. dirty ⇔ non-empty tracked porcelain.
printf '%s' "$status_out" | python3 -c 'import json,sys
p = sys.stdin.buffer.read().decode("utf-8","replace")
print(json.dumps({"ran": True, "dirty": bool(p.strip()), "paths": p}))'
