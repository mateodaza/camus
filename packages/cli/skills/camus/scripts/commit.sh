#!/usr/bin/env bash
# Commit gate: stage + commit the worktree's reviewed change so the branch HEAD actually
# CONTAINS the verified work — otherwise the feat-runner's merge ships nothing (run-2 bug).
# Emits {"committed":bool,"sha":...}. No staged changes -> committed:false -> the loop returns
# no_changes (never a false "done"). Runs AFTER Codex review (which reads the uncommitted diff).
set -uo pipefail
dir="${1:?worktree dir required}"
msg="${2:-camus: task}"
# Target guard (auto-mode hardening): only `git add -A && commit` inside a camus-wt-* worktree of the
# caller's own repo — never stage/commit an arbitrary directory. Runs BEFORE any cd (uses caller $PWD).
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_guard.sh"
if ! camus_guard worktree "$dir"; then
  printf '{"committed": false, "reason": "guard_refused"}\n'
  exit 0
fi
# reason distinguishes a benign empty diff from a real failure — only "empty" maps to no_changes;
# bad_worktree / commit_failed are infra errors the loop must NOT swallow as a harmless no-op.
if ! cd "$dir" 2>/dev/null; then
  printf '{"committed": false, "reason": "bad_worktree"}\n'
  exit 0
fi
# Gate-owned git mutations run HOOKLESS and UNSIGNED (git audit 2026-06-12):
#   -c core.hooksPath=/dev/null — --no-verify only skips pre-commit/commit-msg; a failing
#     prepare-commit-msg still ABORTS the commit (rc=1, verified), and post-commit still FIRES
#     (a repo's post-commit push hook would egress camus branches — the never-push invariant
#     must not be violable by target-repo config). Repo hooks target HUMAN commits; the gate's
#     review ran before this and verify re-runs the repo's checks right after.
#   -c commit.gpgsign=false — forced signing with a TTY/agent-bound key kills unattended commits
#     (rc=128 "failed to write commit object", verified); signing machine-generated gate commits
#     with the user's key unattended would be worse than not signing them.
GATE_GIT=(git -c core.hooksPath=/dev/null -c commit.gpgsign=false)
# The add's exit code IS a verdict input (git audit 2026-06-12, P1): a failing LFS clean filter
# or an index.lock race stages NOTHING (all-or-nothing, rc=128, verified) — falling through to
# the empty-index check would report "empty" → a false no_changes → a false NOOP that even the
# branch-ancestry audits can't see (no commit ever exists to count).
if ! "${GATE_GIT[@]}" add -A; then
  printf '{"committed": false, "reason": "add_failed"}\n'
  exit 0
fi
# Embedded repo guard (git audit 2026-06-12, P3): an agent cloning a repo INSIDE the worktree
# would commit a dangling 160000 gitlink with no .gitmodules — every future clone gets a broken
# phantom submodule. Refuse with a named reason; a LEGIT submodule change updates .gitmodules.
if git diff --cached --diff-filter=A --raw | grep -q ' 160000 ' \
   && ! git diff --cached --name-only | grep -qx '.gitmodules'; then
  printf '{"committed": false, "reason": "embedded_repo"}\n'
  exit 0
fi
if git diff --cached --quiet; then
  printf '{"committed": false, "reason": "empty"}\n'
else
  # --no-verify kept for older-git belt; hooksPath above is the real cover (see why there).
  if "${GATE_GIT[@]}" commit -q --no-verify -m "$msg"; then
    printf '{"committed": true, "sha": "%s"}\n' "$(git rev-parse --short HEAD)"
  else
    printf '{"committed": false, "reason": "commit_failed"}\n'
  fi
fi
