#!/usr/bin/env bash
# Tests for install.sh --check honesty (2026-06-11 fixlets): npx-first STALE wording and the
# VERSION drift-direction stamp — an older CLI checking a newer installed gate must say so
# instead of advising a re-install that would DOWNGRADE the gate.
#
# Self-contained: installs into a THROWAWAY fake $HOME, so the user's real ~/.claude is never
# read or written. Run from packages/cli:  bash test_install_check.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

export HOME="$(mktemp -d)"            # every ~/.claude path below lands here, never in the real home
trap 'rm -rf "$HOME"' EXIT
SKILL_DST="$HOME/.claude/skills/camus"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected $2 got $3)"; fail=$((fail + 1)); fi; }
has()   { case "$2" in *"$3"*) echo "PASS $1"; pass=$((pass + 1));; *) echo "FAIL $1 (output lacks: $3)"; fail=$((fail + 1));; esac; }
lacks() { case "$2" in *"$3"*) echo "FAIL $1 (output contains: $3)"; fail=$((fail + 1));; *) echo "PASS $1"; pass=$((pass + 1));; esac; }
# Run --check capturing combined output (non-TTY, so color codes are empty); sets $out and $rc.
chk()   { out="$(bash "$here/install.sh" --check 2>&1)"; rc=$?; }

# ── 1. fresh install → --check is clean, and the gate carries the package's version stamp ─────
bash "$here/install.sh" >/dev/null 2>&1 || { echo "FAIL fresh install exited non-zero"; exit 1; }
pkg_v="$(python3 -c "import json;print(json.load(open('$here/package.json'))['version'])")"
chk
check "fresh install: --check exits 0"             0        "$rc"
check "install stamps VERSION = package version"   "$pkg_v" "$(cat "$SKILL_DST/VERSION")"

# ── 2. corrupt one installed runtime script → STALE, and the advice leads with npx ────────────
echo "# drift" >> "$SKILL_DST/scripts/adapter.py"
chk
check "corrupted gate: --check exits 1"            1 "$rc"
has   "corrupted gate: says STALE"                 "$out" "gate is STALE"
has   "corrupted gate: leads with npx install"     "$out" "npx camus-cli install"

# ── 3. drifted gate + VERSION above the package → direction-aware message, still exit 1 ───────
# (corruption from case 2 is still in place — the stamp names the direction; drift is drift)
echo "99.0.0" > "$SKILL_DST/VERSION"
chk
check "newer gate: --check exits 1"                1 "$rc"
has   "newer gate: names the direction"            "$out" "gate is NEWER than this CLI"
has   "newer gate: shows both versions"            "$out" "(gate v99.0.0, CLI v$pkg_v)"
has   "newer gate: advises upgrading, not install" "$out" "npx camus-cli@latest"

# ── 4. the VERSION file never trips the drift diff on an otherwise in-sync gate ───────────────
# Re-freeze (clears case 2's corruption, restamps), then plant a bogus stamp: --exclude=VERSION
# means neither its presence nor its content reads as drift — it is only consulted on failure.
bash "$here/install.sh" >/dev/null 2>&1
echo "99.0.0" > "$SKILL_DST/VERSION"
chk
check "in-sync gate + bumped VERSION: exits 0"     0 "$rc"
has   "in-sync gate + bumped VERSION: reads clean" "$out" "installed == source"

# ── 5. gate OLDER than the package (the normal upgrade flow) keeps plain STALE ────────────────
# Equal-or-older must never claim "gate is NEWER" — re-installing is the RIGHT advice here.
echo "0.0.1" > "$SKILL_DST/VERSION"
echo "# drift" >> "$SKILL_DST/scripts/adapter.py"
chk
check "older gate: --check exits 1"                1 "$rc"
has   "older gate: says STALE"                     "$out" "gate is STALE"
lacks "older gate: no false NEWER claim"           "$out" "NEWER"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
