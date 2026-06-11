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
git add -A
if git diff --cached --quiet; then
  printf '{"committed": false, "reason": "empty"}\n'
else
  # --no-verify: repo hooks target HUMAN commits and break unattended ones — commitlint rejects
  # non-conventional types, lint-staged mutates the tree mid-commit, staged-only doc-sync hooks
  # demand unrelated files (run feedback 2026-06-11: husky commit-msg failed every camus commit
  # in hive-mind). The gate's own review ran BEFORE this and verify.sh re-runs the repo's
  # deterministic checks right AFTER — hooks add no safety here, only nondeterminism.
  if git commit -q --no-verify -m "$msg"; then
    printf '{"committed": true, "sha": "%s"}\n' "$(git rev-parse --short HEAD)"
  else
    printf '{"committed": false, "reason": "commit_failed"}\n'
  fi
fi
