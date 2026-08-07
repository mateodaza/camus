#!/usr/bin/env bash
# Verifier agent runs this. Emits {"pass":bool,"failures":[...],"checks":[...]} on stdout.
# Stack-agnostic: verify.py auto-detects the repo's build/test commands (node/python/
# rust/go/foundry/make) with ZERO per-project config, or honours CAMUS_VERIFY_CMD.
# Deterministic ground truth — a clean Codex verdict still must pass this.
#
# Verifies the directory given as the first argument (the worktree), or $PWD if omitted.
# Taking the dir as an arg means the call site needs no leading `cd` — one clean command.
#
# A per-run verifier override arrives as `--verify-cmd <command>`, NOT as an environment-assignment
# prefix. `CAMUS_VERIFY_CMD=... verify.sh <wt>` is not a plain trusted-script call: the allow rule
# does not match it, and a thin runner handed it reads the whole thing as an attempt to inject a
# command into a trusted script and refuses (real auto-mode preflight, 2026-08-06 — the runner said
# so in as many words). As a flag it is just an argument to an allowed script, and the value still
# comes from the orchestrator, so nothing about who chooses it changes. An inherited
# CAMUS_VERIFY_CMD is still honoured for manual and CI runs; the flag wins when both are present.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Target guard (auto-mode hardening): only verify the caller's own repo / a camus-wt-* worktree.
source "$here/_guard.sh"
# Self-anchor first (run 20260806-145411-hy1w): the call site passes a plain
# `bash verify.sh <wt>` with no `cd` prefix, so the script establishes the trusted cwd itself.
if ! camus_anchor; then
  printf '{"pass": false, "inconclusive": true, "failures": [{"stage": "guard", "kind": "refused", "log_tail": "could not anchor at the trusted repository root (CAMUS_REPO_ROOT); nothing was verified"}], "checks": []}\n'
  exit 0
fi
if ! camus_guard repo_or_worktree "${1:-$PWD}"; then
  printf '{"pass": false, "inconclusive": true, "failures": [{"stage": "guard", "kind": "refused", "log_tail": "target rejected by camus_guard (not the caller repo or a camus worktree)"}], "checks": []}\n'
  exit 0
fi
# The override, if the call site passed one. Refuse an EMPTY value rather than exporting a blank
# that would make verify.py run nothing and call it a pass.
target="${1:-$PWD}"
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-cmd)
      if [ -z "${2:-}" ]; then
        printf '{"pass": false, "inconclusive": true, "failures": [{"stage": "verify", "kind": "bad_argument", "log_tail": "--verify-cmd was given with no command; refusing rather than verifying nothing"}], "checks": []}\n'
        exit 0
      fi
      export CAMUS_VERIFY_CMD="$2"; shift 2 ;;
    *)
      printf '{"pass": false, "inconclusive": true, "failures": [{"stage": "verify", "kind": "bad_argument", "log_tail": "unrecognised argument to verify.sh; refusing rather than guessing"}], "checks": []}\n'
      exit 0 ;;
  esac
done
exec python3 "$here/verify.py" "$target"
