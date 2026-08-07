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
# npm users reach the same code via `npx camus-cli install` / `npx camus-cli check`
# (bin/camus.js is a thin dispatcher over this script) — user-facing guidance leads
# with the npx form, since npm installs have no ./install.sh in front of them.
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

# Ignore Python/pytest caches AND the gate's own test files — dev artifacts of this repo, not
# part of the frozen runtime gate. (2026-06-11: new test_*.py files in the repo false-drifted
# --check into exit 1 + "STALE" against a perfectly in-sync install; the gate manifest is the
# runtime scripts only, so tests are excluded from BOTH the check and the installed copy.)
EXCL=(--exclude=__pycache__ --exclude=.pytest_cache --exclude='pytest-cache-files-*' --exclude='*.pyc'
      --exclude=.benchmarks --exclude=.npmignore
      --exclude='test_*.py' --exclude='test_*.sh' --exclude='conftest.py'
      # VERSION is the install-time stamp (written by the freeze step below) — it exists ONLY in
      # the installed copy, so without this exclude every --check would false-drift on it (same
      # reasoning as the runtime-manifest excludes above). --check only READS it, to name the
      # drift DIRECTION in the failure message. (2026-06-11)
      --exclude=VERSION)

# NAME THE SOURCE THE GREEN IS ABOUT. `npx camus-cli check` compares the install against the
# PUBLISHED package, while `install.sh --check` from a clone compares against that clone. Both
# print "in sync", so a green read as "matches the fixes we just built" when it actually meant
# "matches what is published" — a whole WP8 run then executed on a gate that predated twenty
# rounds of unshipped work, with no nonce binding, no watch adoption, and no status record
# (production run 20260806-063400-vzqs). A freshness check whose green is ambiguous is the
# same false-green class this gate exists to eliminate, so it now says WHAT it compared.
source_identity() {
  local rev=''
  if command -v git >/dev/null 2>&1 && git -C "$here" rev-parse --git-dir >/dev/null 2>&1; then
    rev="$(git -C "$here" rev-parse --short HEAD 2>/dev/null || true)"
    local dirty=''
    git -C "$here" diff --quiet 2>/dev/null || dirty=' +uncommitted'
    printf 'git checkout %s at %s%s' "$(cd "$here" && pwd -P)" "${rev:-unknown}" "$dirty"
  else
    printf 'published package %s' "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$here/package.json" 2>/dev/null || echo 'unknown version')"
  fi
}

check() {
  local drift=0
  say "  ${DIM}comparing the installed gate against: $(source_identity)${RST}"
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
  echo "  npx camus-cli check             # gate must be in sync (in-repo: bash \"$here/install.sh\" --check)"
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
    say "${GRN}${BOLD}installed == source${RST} ${DIM}(frozen, in sync with $(source_identity))${RST}"
    say "  ${DIM}"In sync" means identical to THAT source. If your fixes live somewhere else,${RST}"
    say "  ${DIM}this green does not cover them — run --check from the checkout you edited.${RST}"
  else
    # Direction-aware drift (2026-06-11): an OLDER CLI checking a NEWER installed gate must not
    # say "re-install" — re-installing from this package would DOWNGRADE the gate. Compare the
    # install-time stamp against this package's version and name the direction. No stamp
    # (installs predating it) or a broken read falls back to plain STALE. python3 does the
    # compare (audit P3 2026-06-11: `sort -V` is not portable — BSD/older-macOS sort lacks it,
    # and the flag error silently fell into the wrong guidance; python3 is already the gate's
    # hard dependency, so it is the one comparator that exists wherever the gate runs).
    pkg_v="$(python3 -c "import json;print(json.load(open('$here/package.json'))['version'])" 2>/dev/null || true)"
    inst_v=""
    if [[ -f "$SKILL_DST/VERSION" ]]; then inst_v="$(head -n1 "$SKILL_DST/VERSION" 2>/dev/null || true)"; fi
    gate_newer="$(python3 -c 'import re,sys
def v(s): return [int(x) for x in re.findall(r"\d+", s)][:4] or [0]
print("yes" if v(sys.argv[1]) > v(sys.argv[2]) else "no")' "$inst_v" "$pkg_v" 2>/dev/null || true)"
    if [[ -n "$inst_v" && -n "$pkg_v" && "$gate_newer" == "yes" ]]; then
      say "${RED}${BOLD}gate is NEWER than this CLI${RST} (gate v$inst_v, CLI v$pkg_v) — upgrade the CLI (${BOLD}npx camus-cli@latest${RST}) instead of re-installing, or you will DOWNGRADE the gate"
    else
      say "${RED}${BOLD}gate is STALE${RST} — run ${BOLD}npx camus-cli install${RST} ${DIM}(in-repo: bash install.sh)${RST} to re-sync BEFORE your next run"
    fi
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
# prune copied caches AND test files so the installed gate is runtime-only (matches EXCL above —
# whatever the check ignores must not ship, or a fresh install vs an old one would diff anyway)
find "$SKILL_DST" -type d \( -name __pycache__ -o -name '.pytest_cache' -o -name 'pytest-cache-files-*' -o -name '.benchmarks' \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$SKILL_DST" -type f \( -name 'test_*.py' -o -name 'test_*.sh' -o -name 'conftest.py' -o -name '*.pyc' -o -name '.npmignore' \) -delete 2>/dev/null || true
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
# Version stamp: one line at $SKILL_DST/VERSION so a later --check can tell WHICH side is old
# (an older CLI vs a newer gate) instead of shouting STALE in both directions. python3, not
# node, on purpose — the gate scripts already hard-require python3; node may be absent. (2026-06-11)
pkg_version="$(python3 -c "import json;print(json.load(open('$here/package.json'))['version'])")"
printf '%s\n' "$pkg_version" > "$SKILL_DST/VERSION"
ok "version stamp ${BOLD}v$pkg_version${RST} → VERSION ${DIM}(drift-direction marker; excluded from the drift diff)${RST}"
# The fingerprint shasums scripts/*.py + scripts/*.sh ONLY, so the skill-root VERSION file
# cannot alter it — the stamp is metadata about the install, not gate behavior.
fingerprint="$(shasum "$SKILL_DST"/scripts/*.py "$SKILL_DST"/scripts/*.sh | shasum | cut -c1-12)"
ok "gate fingerprint ${BOLD}$fingerprint${RST} ${DIM}(combined sha over every gate script)${RST}"
say "${DIM}$(shasum "$SKILL_DST"/scripts/*.py "$SKILL_DST"/scripts/*.sh | sed 's/^/    /')${RST}"

say ""
say "${BOLD}Next steps${RST}"
say "  ${CYN}npx camus-cli check${RST}            verify installed == source before any run (stale gate = bad run)"
say "  ${CYN}npx camus-cli auto-setup${RST}       one-time, optional: narrow auto-mode profile for unattended runs"
say "  ${DIM}(from a repo checkout, bash install.sh --check / --auto-setup are the same entrypoints)${RST}"
say "  ${CYN}/camus-loop \"<task>\"${RST}           one task — run from YOUR target repo's root"
say "  ${CYN}/camus-feat${RST}                    an ordered task list as one feature, merged on a feat branch"
say "  ${CYN}npx camus-cli watch${RST}            LIVE dashboard for a running feat — one-key pause/steer"
say "  ${CYN}npx camus-cli steer \"<guidance>\"${RST}  redirect it at the next task boundary (--pause to halt)"
say ""
say "${DIM}Worktrees are kept out of your project, under ~/.camus/worktrees/<repo>-<id>/ — feat runs"
say "remove each task's worktree once its branch is merged; standalone /camus-loop worktrees are"
say "left for you to inspect/merge. Reports land at ~/.camus/reports/<featId>.json.${RST}"
