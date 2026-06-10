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

# ── Presentation (color only on a TTY; plain text when piped/logged) ──────────
# `|| true` per capability: under set -e a TTY with TERM=dumb (e.g. Emacs shell) or a TERM
# missing a capability would otherwise abort the whole installer with no output at all.
if [ -t 1 ]; then
  BOLD="$(tput bold 2>/dev/null || true)" DIM="$(tput dim 2>/dev/null || true)"
  GRN="$(tput setaf 2 2>/dev/null || true)" RED="$(tput setaf 1 2>/dev/null || true)"
  CYN="$(tput setaf 6 2>/dev/null || true)" RST="$(tput sgr0 2>/dev/null || true)"
else
  BOLD="" DIM="" GRN="" RED="" CYN="" RST=""
fi
say()  { printf '%s\n' "$1"; }
ok()   { printf '%s\n' "  ${GRN}✓${RST} $1"; }
bad()  { printf '%s\n' "  ${RED}✗${RST} $1"; }
step() { printf '%s\n' "${CYN}→${RST} $1"; }

# Ignore Python/pytest caches — they're build artifacts, not part of the gate.
EXCL=(--exclude=__pycache__ --exclude=.pytest_cache --exclude='pytest-cache-files-*' --exclude='*.pyc')

check() {
  local drift=0
  if diff -rq "${EXCL[@]}" "$SKILL_SRC" "$SKILL_DST" >/dev/null 2>&1; then
    ok "skill in sync"
  else
    bad "DRIFT: skill differs from source (or not installed)"; drift=1
  fi
  # Cover EVERY workflow in the source dir. (Root cause of the 2026-06-09 drift: only the loop
  # workflow was hardcoded here, so camus-feat.workflow.js was never installed OR checked —
  # --check falsely reported "in sync" while the feat orchestration had drifted. Auto-discover so a
  # newly added workflow can never be silently missed again.)
  for src in "$WF_DIR_SRC"/*.workflow.js; do
    local wf; wf="$(basename "$src")"
    if diff -q "$src" "$WF_DIR_DST/$wf" >/dev/null 2>&1; then
      ok "workflow $wf in sync"
    else
      bad "DRIFT: workflow $wf differs from source (or not installed)"; drift=1
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
  say "${BOLD}── Unattended run recipe ─────────────────────────────────────────────────────${RST}"
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
  say "${BOLD}Camus gate check${RST} ${DIM}(installed copies vs this repo's source)${RST}"
  rc=0
  check || rc=1
  # auto-mode trust is opt-in; report its status but don't fail the drift check on it
  python3 "$here/merge_settings.py" --check || true
  if [[ $rc -eq 0 ]]; then
    say "${GRN}${BOLD}installed == source${RST} ${DIM}(frozen, in sync — safe to run)${RST}"
  else
    say "${RED}${BOLD}gate is STALE${RST} — run ${BOLD}./install.sh${RST} to re-sync BEFORE your next run"
    exit 1
  fi
  exit 0
fi

say "${BOLD}Camus installer${RST} ${DIM}— freezing the gate into ~/.claude${RST}"
say ""

step "Installing the skill (a frozen COPY, not a symlink — runs never read live repo code)"
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/workflows"
rm -rf "$SKILL_DST"
cp -r "$SKILL_SRC" "$SKILL_DST"
# prune copied caches so the installed gate is clean
find "$SKILL_DST" -type d \( -name __pycache__ -o -name '.pytest_cache' -o -name 'pytest-cache-files-*' \) -prune -exec rm -rf {} + 2>/dev/null || true
skill_files="$(find "$SKILL_DST" -type f | wc -l | tr -d ' ')"
ok "skill ${BOLD}camus${RST} → $SKILL_DST ${DIM}($skill_files files: playbook, review rubric, gate scripts)${RST}"

step "Installing the workflows (the engine: camus-loop drives one task, camus-feat an ordered list)"
wf_names=""
for src in "$WF_DIR_SRC"/*.workflow.js; do
  cp "$src" "$WF_DIR_DST/$(basename "$src")"
  wf_names="$wf_names$(basename "$src" .workflow.js) "
done
ok "workflows ${BOLD}${wf_names% }${RST} → $WF_DIR_DST/"

step "Freezing the gate (spec §12 — shasums prove the installed gate matches this install)"
fingerprint="$(shasum "$SKILL_DST"/scripts/*.py "$SKILL_DST"/scripts/*.sh | shasum | cut -c1-12)"
ok "gate fingerprint ${BOLD}$fingerprint${RST} ${DIM}(combined sha over every gate script)${RST}"
say "${DIM}$(shasum "$SKILL_DST"/scripts/*.py "$SKILL_DST"/scripts/*.sh | sed 's/^/    /')${RST}"

say ""
say "${BOLD}Next steps${RST}"
say "  ${CYN}bash install.sh --check${RST}        verify installed == source before any run (stale gate = bad run)"
say "  ${CYN}bash install.sh --auto-setup${RST}   one-time, optional: narrow auto-mode profile for unattended runs"
say "  ${CYN}/camus-loop \"<task>\"${RST}           one task — run from YOUR target repo's root"
say "  ${CYN}/camus-feat${RST}                    an ordered task list as one feature, merged on a feat branch"
say "  ${CYN}npx camus-cli status${RST}           watch a running feat (tasks, last steps, review rounds)"
say "  ${CYN}npx camus-cli steer \"<guidance>\"${RST}  redirect it at the next task boundary (--pause to halt)"
say ""
say "${DIM}Worktrees are kept out of your project, under ~/.camus/worktrees/<repo>-<id>/ — feat runs"
say "remove each task's worktree once its branch is merged; standalone /camus-loop worktrees are"
say "left for you to inspect/merge. Reports land at ~/.camus/reports/<featId>.json.${RST}"
