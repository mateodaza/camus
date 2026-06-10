#!/usr/bin/env bash
# Shared TARGET GUARD for Camus gate scripts.
#
# The auto-mode allow-list trusts the script PATH, but the target DIRECTORY is still
# attacker-influenceable (a prompt-injected command could pass ANY path). Without this guard a
# "trusted script, hostile path" call — e.g. `codex_review.sh /some/other/repo` (ships that repo's
# diff to OpenAI) or `commit.sh /some/other/repo` (stages/commits unrelated work) — would be allowed.
#
# Defense, fail CLOSED:
#  - Trust anchor = $CAMUS_REPO_ROOT (exported ONCE at the auto-mode session launch; immutable across
#    `cd` and across separate tool calls), falling back to $PWD for manual/dev runs. Anchoring on the
#    env var closes the "cd into another repo first, then call the script" rebind — and a `cd`- or
#    env-var-prefixed command won't match the narrow allow rule anyway, so it can't reach here
#    auto-approved. For UNATTENDED auto runs, CAMUS_REPO_ROOT MUST be set (the install recipe sets it).
#  - Target must be in the SAME git repo as the anchor (absolute --git-common-dir equality).
#  - Target must be on an `camus/*` branch, and its name must be COHERENT with that branch
#    (a task worktree is `camus-wt-<branch's last path segment>`), so a hand-crafted same-repo
#    `camus-wt-anything` on `camus/anything` does not pass as a Camus worktree.
#
# Source this, then call BEFORE any cd/work:
#   camus_guard <mode> <target>
#     mode = worktree         (write/egress gates: codex_review.sh, prep.sh, commit.sh)
#            repo_or_worktree  (verify.sh — repo root on a camus/feat-* branch OR a camus-wt-* worktree)
# Returns 0 = ok, 1 = reject (one-line reason on stderr). The CALLER emits its own infra JSON on
# reject — never proceed past a non-zero return.

_camus_common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }

camus_guard() {
  local mode="$1" target="$2"
  local anchor caller_common pwd_common target_abs target_common branch base suffix
  anchor="${CAMUS_REPO_ROOT:-$PWD}"
  caller_common="$(_camus_common_dir "$anchor")" || true
  if [ -z "$caller_common" ]; then
    echo "camus_guard: trust anchor ($anchor) is not inside a git repo" >&2; return 1
  fi
  # Defense in depth (does NOT rely on the permission matcher): when an explicit CAMUS_REPO_ROOT is set
  # (auto runs), the ACTUAL $PWD must also be inside that same repo. An inline
  # `CAMUS_REPO_ROOT=/other <script> /other/...` override then still fails, because the real cwd points
  # at the true repo — both the env anchor AND the cwd must agree on the repo. Manual runs (no
  # CAMUS_REPO_ROOT) skip this: $PWD already IS the anchor. ($PWD = repo root or any of its worktrees,
  # which share the same git common-dir, so legitimate gate-script calls pass.)
  if [ -n "${CAMUS_REPO_ROOT:-}" ]; then
    pwd_common="$(_camus_common_dir "$PWD")" || true
    if [ "$pwd_common" != "$caller_common" ]; then
      echo "camus_guard: \$PWD ($PWD) is not in the trusted repo CAMUS_REPO_ROOT=$CAMUS_REPO_ROOT" >&2; return 1
    fi
  fi
  target_abs="$(cd "$target" 2>/dev/null && pwd -P)" || {
    echo "camus_guard: target is not a directory ($target)" >&2; return 1; }
  target_common="$(_camus_common_dir "$target_abs")" || true
  if [ -z "$target_common" ]; then
    echo "camus_guard: target is not inside a git repo ($target_abs)" >&2; return 1
  fi
  if [ "$caller_common" != "$target_common" ]; then
    echo "camus_guard: target repo ($target_common) != trusted repo ($caller_common)" >&2; return 1
  fi
  branch="$(git -C "$target_abs" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  base="$(basename "$target_abs")"
  suffix="${branch##*/}"   # last path segment of the branch
  case "$branch" in
    camus/*) ;;
    *) echo "camus_guard: target branch ($branch) is not a camus/* branch" >&2; return 1 ;;
  esac
  case "$mode" in
    worktree)
      # write/egress gate: must be a Camus task worktree, name coherent with its branch.
      if [ "$base" != "camus-wt-$suffix" ]; then
        echo "camus_guard: worktree '$base' not coherent with branch '$branch' (expected camus-wt-$suffix)" >&2
        return 1
      fi
      ;;
    repo_or_worktree)
      case "$base" in
        camus-wt-*)
          if [ "$base" != "camus-wt-$suffix" ]; then
            echo "camus_guard: worktree '$base' not coherent with branch '$branch' (expected camus-wt-$suffix)" >&2
            return 1
          fi
          ;;
        *)
          # repo root (feat baseline / integration verify): must be ON the feat branch camus/feat-<id>.
          case "$branch" in
            camus/feat-*) ;;
            *) echo "camus_guard: repo-root target not on a camus/feat-* branch ($branch)" >&2; return 1 ;;
          esac
          ;;
      esac
      ;;
    *)
      echo "camus_guard: unknown mode '$mode'" >&2; return 1
      ;;
  esac
  return 0
}
