#!/usr/bin/env bash
# Install (or verify) the Camus v2-lite skill + workflow into ~/.claude.
#
# COPY, not symlink, on purpose: the gate must be FROZEN between deliberate installs
# (spec §12) — never live-edited from the repo while a run is driving.
#
#   ./install.sh            install skill + workflow, then print the freeze-check shasums
#   ./install.sh --check     report drift between repo source and installed copies
#                            (exit 0 = in sync, exit 1 = drifted / not installed)
#
# Run --check before any auto-mode / feat run so you never run a stale gate.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"           # .../camus
SKILL_SRC="$here/skills/camus"
WF_DIR_SRC="$here/workflows"
SKILL_DST="$HOME/.claude/skills/camus"
WF_DIR_DST="$HOME/.claude/workflows"

# Ignore Python/pytest caches — they're build artifacts, not part of the gate.
EXCL=(--exclude=__pycache__ --exclude=.pytest_cache --exclude='pytest-cache-files-*' --exclude='*.pyc')

check() {
  local drift=0
  if diff -rq "${EXCL[@]}" "$SKILL_SRC" "$SKILL_DST" >/dev/null 2>&1; then
    echo "ok:    skill in sync"
  else
    echo "DRIFT: skill differs from source (or not installed)"; drift=1
  fi
  # Cover EVERY workflow in the source dir. (Root cause of the 2026-06-09 drift: only the loop
  # workflow was hardcoded here, so camus-feat.workflow.js was never installed OR checked —
  # --check falsely reported "in sync" while the feat orchestration had drifted. Auto-discover so a
  # newly added workflow can never be silently missed again.)
  for src in "$WF_DIR_SRC"/*.workflow.js; do
    local wf; wf="$(basename "$src")"
    if diff -q "$src" "$WF_DIR_DST/$wf" >/dev/null 2>&1; then
      echo "ok:    workflow $wf in sync"
    else
      echo "DRIFT: workflow $wf differs from source (or not installed)"; drift=1
    fi
  done
  return $drift
}

if [[ "${1:-}" == "--env-check" ]]; then
  # Preflight: is the target repo runnable (node version / deps / verifier toolchain)?
  # Run before a feat/auto run so verify never false-fails on a setup issue. Defaults to $PWD.
  exec python3 "$here/skills/camus/scripts/env_check.py" "${2:-$PWD}"
fi

if [[ "${1:-}" == "--auto-setup" ]]; then
  # OPT-IN: install the NARROW Camus auto profile into ~/.claude/settings.json —
  # egress trust + local-only env context + allow rules for ONLY the gate scripts. Preserves
  # every existing setting, backs up first, idempotent. Does NOT set a global permission mode
  # and does NOT grant broad shell/package-manager access. (See merge_settings.py.)
  python3 "$here/merge_settings.py" --apply
  echo
  echo "── Unattended run recipe ─────────────────────────────────────────────────────"
  echo "Auto mode is entered PER RUN (no global setting was changed). To run a feat hands-off:"
  echo
  echo "  cd <your repo root>             # your own, trusted repo"
  echo "  git status                      # must be CLEAN (Preflight halts on a dirty tree)"
  echo "  bash \"$here/install.sh\" --check  # gate must be in sync"
  echo "  export CAMUS_REPO_ROOT=\"\$(pwd -P)\"  # REQUIRED: cd-immutable trust anchor for the target guard"
  echo "  export CAMUS_VERIFY_CMD='<type-check && test>'   # include TESTS, not just type-check"
  echo "  claude --permission-mode auto   # then invoke the camus-feat workflow"
  echo "  (optional) inside the session run  /advisor  (pick Opus) — gives the cheap think-model a"
  echo "  stronger second opinion at plan/stuck points. Session-wide + automatic; soft helper, NEVER"
  echo "  a gate (Codex review + verify stay authoritative). Counts against your subscription limits."
  echo
  echo "Safety: never as root; auto mode auto-approves local edits + declared dep installs, but"
  echo "the classifier still blocks destructive / out-of-repo actions and honors 'don't push'."
  echo "Human merge & publish stay yours — the feat branch is left unmerged."
  exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
  rc=0
  check || rc=1
  # auto-mode trust is opt-in; report its status but don't fail the drift check on it
  python3 "$here/merge_settings.py" --check || true
  if [[ $rc -eq 0 ]]; then
    echo "installed == source (frozen, in sync)"
  else
    echo "-> run ./install.sh to re-sync BEFORE your next run"
    exit 1
  fi
  exit 0
fi

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/workflows"
rm -rf "$SKILL_DST"
cp -r "$SKILL_SRC" "$SKILL_DST"
# prune copied caches so the installed gate is clean
find "$SKILL_DST" -type d \( -name __pycache__ -o -name '.pytest_cache' -o -name 'pytest-cache-files-*' \) -prune -exec rm -rf {} + 2>/dev/null || true
for src in "$WF_DIR_SRC"/*.workflow.js; do
  cp "$src" "$WF_DIR_DST/$(basename "$src")"
done

echo "installed skill     -> $SKILL_DST"
echo "installed workflows -> $WF_DIR_DST/ ($(cd "$WF_DIR_SRC" && ls *.workflow.js | tr '\n' ' '))"
echo
echo "freeze-check (shasum of installed gate scripts):"
shasum "$SKILL_DST"/scripts/*.py "$SKILL_DST"/scripts/*.sh
