#!/usr/bin/env bash
# Camus v2-lite dogfood — cross-vendor review of the v2-lite code itself.
# Runs Codex against the scaffold and prints exactly what's needed to close the
# schema flag: the emitted JSON, plus /tmp/camus_codex_err.log when ran:false.
#
# Usage (from the repo root):
#   bash camus/dogfood.sh
#   bash camus/dogfood.sh "optional extra review focus"
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
review="$here/skills/camus/scripts/codex_review.sh"
out="/tmp/camus_dogfood_out.json"
err="/tmp/camus_codex_err.log"           # codex_review.sh writes Codex stderr here

focus="${*:-Re-review the patched v2-lite adapter, scripts, schema, and SKILL.md for correctness and safety}"

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI not found on PATH. Install + auth Codex, then re-run." >&2
  exit 127
fi
if [ ! -f "$review" ]; then
  echo "ERROR: cannot find $review (run from the repo root)." >&2
  exit 1
fi

# WARNING — KNOWN-BROKEN (audit 2026-06-10, P1, pre-existing): codex_review.sh's first
# positional arg is now the TARGET DIRECTORY (guard-checked: camus/* branch +
# coherent worktree), so passing the focus string here always yields ran:false.
# Needs a rewrite to invoke `codex exec` directly against the scaffold — tracked
# for the next batch. Do not trust this script's output until then.
echo "Running cross-vendor Codex review on the scaffold..."
bash "$review" "$focus" > "$out" 2>/dev/null

echo
echo "===== EMITTED JSON (paste this back) ====="
if command -v jq >/dev/null 2>&1; then jq . < "$out" 2>/dev/null || cat "$out"; else cat "$out"; fi
echo "=========================================="

ran="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("ran"))' "$out" 2>/dev/null || true)"
echo
case "$ran" in
  True|true)
    echo "ran:true  ->  schema contract held."
    echo "If findings[] use the field 'priority' (0-3), the schema flag is CLOSED and"
    echo "v2-lite is ready to sit behind G1/G4."
    ;;
  *)
    echo "ran:false ->  the adapter could not trust Codex's output. Paste BOTH the JSON"
    echo "above and the Codex stderr below so the field-name mismatch can be diagnosed:"
    echo "----- /tmp/camus_codex_err.log -----"
    cat "$err" 2>/dev/null || echo "(empty)"
    echo "---------------------------------"
    ;;
esac
echo
echo "(JSON also saved to $out)"
