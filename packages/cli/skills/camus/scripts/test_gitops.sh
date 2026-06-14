#!/usr/bin/env bash
# Tests for the gate-owned git MUTATION scripts (live smoke run-5, 2026-06-12): wt.sh
# (worktree create/attach) and merge.sh (the feat merge contract, computed not reported).
# Builds real repos with baseline commits; isolates git config via GIT_CONFIG_GLOBAL (the
# scripts run bare `git` internally and merge.sh mints real commits — they must see the test
# identity, never the developer's hooks/signing). Covers: the guard fences (camus-only names,
# CAMUS_REPO_ROOT anchor), verbatim-stderr errors (run-5: a discarded error text became a
# fictional diagnosis), hostile hooks + forced signing (the in-script -c flags must win), the
# already-up-to-date prior-merge probe, the conflict-abort invariant (no MERGE_HEAD residue),
# and the merge RECEIPT (run-6: the runner abandoned the script's conflict verdict and relayed
# success — the receipt is the script's own testimony, cross-checked by the workflow).
# Run:  bash test_gitops.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"
  else fail=$((fail+1)); echo "FAIL $1  (expected [$2], got [$3])"; fi
}

# isolated git config for EVERYTHING in this run (scripts included via inheritance)
export GIT_CONFIG_GLOBAL="$ROOT/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.email t@t
git config --file "$GIT_CONFIG_GLOBAL" user.name t
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
unset CAMUS_REPO_ROOT   # default cases use the $PWD anchor; the env-anchor cases set it explicitly

# JSON field reader: booleans → true/false, null → null, else the value text.
jget() { # $1 = json, $2 = field
  printf '%s' "$1" | python3 -c '
import json, sys
v = json.load(sys.stdin).get(sys.argv[1])
if isinstance(v, bool): print("true" if v else "false")
elif v is None: print("null")
else: print(v)' "$2"
}
# the whole stdout must parse as ONE JSON object (the gate contract)
jone() { printf '%s' "$1" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 && echo yes || echo no; }
# substring / prefix probes (a bare `case` cannot live inside $(...) — its pattern's ")" would
# close the command substitution)
has()    { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }
starts() { case "$1" in "$2"*)  echo yes ;; *) echo no ;; esac; }
# receipt-vs-stdout cross-check: the receipt file's PARSED verdict fields must equal the
# captured stdout's, field by field — the workflow's defection detector relies on exactly this.
rmatch() { # $1 = stdout json, $2 = receipt path → yes/no
  printf '%s' "$1" | python3 -c '
import json, sys
out = json.load(sys.stdin)
try:
    with open(sys.argv[1]) as fh:
        rec = json.load(fh)
except Exception:
    print("no"); raise SystemExit
fields = ("merged", "committed", "alreadyUpToDate", "priorMergeCommit",
          "before", "after", "conflict", "error")
print("yes" if all(rec.get(f) == out.get(f) for f in fields) else "no")' "$2"
}

# hostile hooks: every hook a checkout or merge commit would run, all failing
HOOKS="$ROOT/hooks"; mkdir -p "$HOOKS"
for h in post-checkout pre-merge-commit prepare-commit-msg commit-msg pre-commit; do
  printf '#!/bin/sh\nexit 1\n' > "$HOOKS/$h"; chmod +x "$HOOKS/$h"
done

# ════ wt.sh ═══════════════════════════════════════════════════════════════════════════════════
R="$ROOT/repo"; mkdir -p "$R"
( cd "$R" && git init -q && echo base > base.txt && git add -A && git -c commit.gpgsign=false commit -qm base )
WTS="$ROOT/wts"   # deliberately NOT pre-created — wt.sh must mkdir -p the dest's parent
run_wt() { ( cd "$R" && bash "$here/wt.sh" "$@" ); }

# create: happy path
out="$(run_wt create camus/feat/g/alpha "$WTS/deep/camus-wt-alpha")"
check "create: stdout is exactly one JSON object" yes "$(jone "$out")"
check "create: ok true" true "$(jget "$out" ok)"
check "create: path = physical dest" "$(cd "$WTS/deep/camus-wt-alpha" && pwd -P)" "$(jget "$out" path)"
check "create: branch exists" yes "$(git -C "$R" show-ref --verify -q refs/heads/camus/feat/g/alpha && echo yes || echo no)"
check "create: worktree registered" yes "$(git -C "$R" worktree list --porcelain | grep -q 'camus-wt-alpha' && echo yes || echo no)"
check "create: new branch starts at current HEAD" "$(git -C "$R" rev-parse HEAD)" "$(git -C "$WTS/deep/camus-wt-alpha" rev-parse HEAD)"

# guard refusal: non-camus branch (and nothing was created)
out="$(run_wt create feature/raw "$WTS/camus-wt-raw")"
check "create: non-camus branch refused" false "$(jget "$out" ok)"
check "create: branch refusal names the guard" yes "$(starts "$(jget "$out" error)" "guard refused:")"
check "create: refused branch NOT created" no "$(git -C "$R" show-ref --verify -q refs/heads/feature/raw && echo yes || echo no)"

# guard refusal: non-camus-wt dest basename
out="$(run_wt create camus/feat/g/bravo "$WTS/plain-dir")"
check "create: non-camus-wt dest refused" false "$(jget "$out" ok)"
check "create: dest refusal names the guard" yes "$(starts "$(jget "$out" error)" "guard refused:")"
check "create: refused dest's branch NOT created" no "$(git -C "$R" show-ref --verify -q refs/heads/camus/feat/g/bravo && echo yes || echo no)"

# create collision: branch already exists → git's own "already exists" text IN the error
out="$(run_wt create camus/feat/g/alpha "$WTS/camus-wt-alpha2")"
check "create: collision → ok false" false "$(jget "$out" ok)"
check "create: collision error carries git's 'already exists' text" yes "$(has "$(jget "$out" error)" "already exists")"

# attach: happy path — the branch's commit (not a fresh base) is what gets checked out
( cd "$WTS/deep/camus-wt-alpha" && echo work > work.txt && git add -A && git -c commit.gpgsign=false commit -qm work )
git -C "$R" worktree remove --force "$WTS/deep/camus-wt-alpha"
out="$(run_wt attach camus/feat/g/alpha "$WTS/again/camus-wt-alpha")"
check "attach: ok true" true "$(jget "$out" ok)"
check "attach: path = physical dest" "$(cd "$WTS/again/camus-wt-alpha" && pwd -P)" "$(jget "$out" path)"
check "attach: the branch's commit is checked out (work.txt present)" yes "$([ -f "$WTS/again/camus-wt-alpha/work.txt" ] && echo yes || echo no)"

# attach: missing branch → verbatim git error (names the ref), never a made-up diagnosis
out="$(run_wt attach camus/feat/g/ghost "$WTS/camus-wt-ghost")"
check "attach: missing branch → ok false" false "$(jget "$out" ok)"
check "attach: error is git's verbatim text (names the missing ref)" yes "$(has "$(jget "$out" error)" ghost)"

# hostile hooks: a failing post-checkout must not break create/attach (the hookless -c wins)
git -C "$R" config core.hooksPath "$HOOKS"
check "control: WITHOUT the hookless -c the hostile post-checkout fails a worktree add" no \
  "$( (cd "$R" && git worktree add -b camus/feat/g/control "$WTS/camus-wt-control" >/dev/null 2>&1) && echo yes || echo no)"
out="$(run_wt create camus/feat/g/hooked "$WTS/camus-wt-hooked")"
check "create: survives failing post-checkout hook" true "$(jget "$out" ok)"
git -C "$R" worktree remove --force "$WTS/again/camus-wt-alpha"
out="$(run_wt attach camus/feat/g/alpha "$WTS/third/camus-wt-alpha")"
check "attach: survives failing post-checkout hook" true "$(jget "$out" ok)"
git -C "$R" config --unset core.hooksPath

# CAMUS_REPO_ROOT anchor: cwd in a DIFFERENT repo than the trust anchor → refused
O="$ROOT/other"; mkdir -p "$O"
( cd "$O" && git init -q && echo x > f && git add -A && git -c commit.gpgsign=false commit -qm o )
out="$( cd "$O" && CAMUS_REPO_ROOT="$R" bash "$here/wt.sh" create camus/feat/g/evil "$WTS/camus-wt-evil" )"
check "create: CAMUS_REPO_ROOT anchor mismatch refused" false "$(jget "$out" ok)"
check "create: anchor refusal names the guard" yes "$(starts "$(jget "$out" error)" "guard refused:")"
out="$( cd "$R" && CAMUS_REPO_ROOT="$R" bash "$here/wt.sh" create camus/feat/g/anchored "$WTS/camus-wt-anchored" )"
check "create: CAMUS_REPO_ROOT + matching cwd accepted" true "$(jget "$out" ok)"

# ════ merge.sh ════════════════════════════════════════════════════════════════════════════════
# Receipts (run-6): every verdict is also written to $CAMUS_MERGE_DIR/<taskId>.json. Pointed at
# a test dir so the suite never touches the real ~/.camus/merges — and since the default would
# be $HOME, every receipt assertion below doubles as proof the CAMUS_MERGE_DIR override is honored.
RDIR="$ROOT/merges"; export CAMUS_MERGE_DIR="$RDIR"
M="$ROOT/mrepo"; mkdir -p "$M"
( cd "$M" && git init -q && printf 'line1\nline2\n' > f.txt && git add -A && git -c commit.gpgsign=false commit -qm base \
  && git checkout -qb camus/feat-m \
  && git checkout -qb camus/feat/m/t1 && echo t1 > t1.txt && git add -A && git -c commit.gpgsign=false commit -qm t1work )
# HEAD is left on the TASK branch on purpose — merge.sh owns the checkout step
run_merge() { ( cd "$M" && bash "$here/merge.sh" "$@" ); }
MSG1="camus(feat): merge t1"

# real merge
out="$(run_merge camus/feat-m camus/feat/m/t1 "$MSG1")"
check "merge: stdout is exactly one JSON object" yes "$(jone "$out")"
check "merge: merged" true "$(jget "$out" merged)"
check "merge: committed" true "$(jget "$out" committed)"
check "merge: not alreadyUpToDate" false "$(jget "$out" alreadyUpToDate)"
check "merge: no conflict" false "$(jget "$out" conflict)"
check "merge: error null" null "$(jget "$out" error)"
check "merge: priorMergeCommit null" null "$(jget "$out" priorMergeCommit)"
check "merge: before != after" yes "$([ "$(jget "$out" before)" != "$(jget "$out" after)" ] && echo yes || echo no)"
check "merge: after == the real feat tip" "$(git -C "$M" rev-parse camus/feat-m)" "$(jget "$out" after)"
check "merge: the merge commit carries the message" "$MSG1" "$(git -C "$M" log -1 --format=%s camus/feat-m)"
first_merge_sha="$(git -C "$M" rev-parse camus/feat-m)"
# the receipt: written BEFORE the verdict was printed, taskId = last token of the message
check "receipt: written on success (taskId t1 from the message's last token)" yes \
  "$([ -f "$RDIR/t1.json" ] && echo yes || echo no)"
check "receipt: success fields match stdout exactly" yes "$(rmatch "$out" "$RDIR/t1.json")"
check "receipt: carries the full message for sanity-matching" "$MSG1" "$(jget "$(cat "$RDIR/t1.json")" msg)"
check "receipt: no receiptError on stdout when the write succeeded" null "$(jget "$out" receiptError)"

# already-up-to-date re-merge → priorMergeCommit found via the fixed-string grep
out="$(run_merge camus/feat-m camus/feat/m/t1 "$MSG1")"
check "re-merge: merged" true "$(jget "$out" merged)"
check "re-merge: committed false" false "$(jget "$out" committed)"
check "re-merge: alreadyUpToDate" true "$(jget "$out" alreadyUpToDate)"
check "re-merge: before == after" yes "$([ "$(jget "$out" before)" = "$(jget "$out" after)" ] && echo yes || echo no)"
check "re-merge: priorMergeCommit = the first merge's sha" "$first_merge_sha" "$(jget "$out" priorMergeCommit)"
check "re-merge: receipt overwritten — testimony tracks the LATEST run" yes "$(rmatch "$out" "$RDIR/t1.json")"

# CONFLICT: two branches touch the same line; the abort must leave NO merge in progress
( cd "$M" && git checkout -q camus/feat-m \
  && git checkout -qb camus/feat/m/t2 && printf 'line1-t2\nline2\n' > f.txt && git add -A && git -c commit.gpgsign=false commit -qm t2work \
  && git checkout -q camus/feat-m && printf 'line1-feat\nline2\n' > f.txt && git add -A && git -c commit.gpgsign=false commit -qm featwork )
out="$(run_merge camus/feat-m camus/feat/m/t2 "camus(feat): merge t2")"
check "conflict: merged false" false "$(jget "$out" merged)"
check "conflict: conflict true" true "$(jget "$out" conflict)"
check "conflict: error carries git's CONFLICT text" yes "$(has "$(jget "$out" error)" CONFLICT)"
check "conflict: before = feat tip, after null" yes \
  "$([ "$(jget "$out" before)" = "$(git -C "$M" rev-parse camus/feat-m)" ] && [ "$(jget "$out" after)" = null ] && echo yes || echo no)"
check "conflict: ABORTED — no MERGE_HEAD residue" no "$([ -f "$(git -C "$M" rev-parse --git-dir)/MERGE_HEAD" ] && echo yes || echo no)"
check "conflict: ABORTED — working tree clean" "" "$(git -C "$M" status --porcelain)"
# the run-6 defection point: the runner relayed "success" over THIS verdict — the receipt is
# the conflict's surviving testimony, so a hand-merge relay can no longer pass the cross-check
check "conflict: receipt written too" yes "$([ -f "$RDIR/t2.json" ] && echo yes || echo no)"
check "conflict: receipt fields match stdout exactly" yes "$(rmatch "$out" "$RDIR/t2.json")"
check "conflict: receipt records conflict true" true "$(jget "$(cat "$RDIR/t2.json")" conflict)"

# hostile hooks: failing post-checkout (rc-poisons the checkout) + failing pre-merge-commit /
# prepare-commit-msg (abort the merge commit) — the in-script hookless -c must beat them all
( cd "$M" && git checkout -qb camus/feat/m/t3 && echo t3 > t3.txt && git add -A && git -c commit.gpgsign=false commit -qm t3work \
  && git checkout -q camus/feat/m/t1 )   # park HEAD off feat so merge.sh's checkout really runs
git -C "$M" config core.hooksPath "$HOOKS"
out="$(run_merge camus/feat-m camus/feat/m/t3 "camus(feat): merge t3")"
git -C "$M" config --unset core.hooksPath
check "hostile hooks: merge still succeeds" true "$(jget "$out" merged)"
check "hostile hooks: a real merge commit landed" true "$(jget "$out" committed)"

# forced bogus signing: repo config demands signing with a nonexistent key — gpgsign=false wins
( cd "$M" && git checkout -qb camus/feat/m/t4 && echo t4 > t4.txt && git add -A && git -c commit.gpgsign=false commit -qm t4work )
git -C "$M" config commit.gpgsign true
git -C "$M" config user.signingkey /nonexistent-key
git -C "$M" config gpg.format ssh
out="$(run_merge camus/feat-m camus/feat/m/t4 "camus(feat): merge t4")"
git -C "$M" config --unset commit.gpgsign
git -C "$M" config --unset user.signingkey
git -C "$M" config --unset gpg.format
check "forced signing: merge still succeeds" true "$(jget "$out" merged)"
check "forced signing: a real merge commit landed" true "$(jget "$out" committed)"

# guard refusals: BOTH positions, checked before any git command (HEAD must never move)
cur="$(git -C "$M" rev-parse --abbrev-ref HEAD)"
out="$(run_merge main camus/feat/m/t1 "$MSG1")"
check "guard: non-camus FEAT branch refused" false "$(jget "$out" merged)"
check "guard: feat refusal names the guard" yes "$(starts "$(jget "$out" error)" "guard refused:")"
check "guard: refusal emits the FULL contract (booleans false, SHAs null)" yes \
  "$(printf '%s' "$out" | python3 -c '
import json, sys
g = json.load(sys.stdin)
ok = (g["merged"] is False and g["committed"] is False and g["alreadyUpToDate"] is False
      and g["conflict"] is False and g["priorMergeCommit"] is None
      and g["before"] is None and g["after"] is None and g["error"].startswith("guard refused"))
print("yes" if ok else "no")')"
check "guard: a refusal leaves a receipt too (every emit is testimony)" yes "$(rmatch "$out" "$RDIR/t1.json")"
out="$(run_merge camus/feat-m main "$MSG1")"
check "guard: non-camus TASK branch refused" false "$(jget "$out" merged)"
check "guard: refusals never moved HEAD" "$cur" "$(git -C "$M" rev-parse --abbrev-ref HEAD)"

# checkout failure (missing feat branch): verbatim git error, all SHAs null
out="$(run_merge camus/feat-missing camus/feat/m/t1 "$MSG1")"
check "checkout failure: merged false" false "$(jget "$out" merged)"
check "checkout failure: error is git's verbatim text (names the branch)" yes \
  "$(has "$(jget "$out" error)" camus/feat-missing)"
check "checkout failure: all SHAs null" yes \
  "$([ "$(jget "$out" before)" = null ] && [ "$(jget "$out" after)" = null ] && echo yes || echo no)"

# ── receipts: dir override, default lane, unwritable-dir degrade (run-6) ──────────────────────
# All merges below are idempotent re-merges of t1 (already up to date), so the verdict is
# deterministic and only the receipt plumbing varies.

# explicit per-call CAMUS_MERGE_DIR override into a dir that does not exist yet (mkdir -p lane)
out="$( cd "$M" && CAMUS_MERGE_DIR="$ROOT/merges-alt/deep" bash "$here/merge.sh" camus/feat-m camus/feat/m/t1 "$MSG1" )"
check "receipt override: lands in the per-call CAMUS_MERGE_DIR (mkdir -p'd)" yes \
  "$([ -f "$ROOT/merges-alt/deep/t1.json" ] && echo yes || echo no)"
check "receipt override: fields match stdout exactly" yes "$(rmatch "$out" "$ROOT/merges-alt/deep/t1.json")"

# default lane: CAMUS_MERGE_DIR empty → $HOME/.camus/merges (HOME pointed at a sandbox;
# git still reads the isolated GIT_CONFIG_GLOBAL, so only the receipt path changes)
out="$( cd "$M" && CAMUS_MERGE_DIR= HOME="$ROOT/fakehome" bash "$here/merge.sh" camus/feat-m camus/feat/m/t1 "$MSG1" )"
check "receipt default: empty CAMUS_MERGE_DIR falls back to \$HOME/.camus/merges" yes \
  "$([ -f "$ROOT/fakehome/.camus/merges/t1.json" ] && echo yes || echo no)"

# unwritable receipt dir: best-effort BY DESIGN — the verdict must not change; stdout
# explains the missing receipt via receiptError so the workflow knows why
RO="$ROOT/ro"; mkdir -p "$RO"; chmod a-w "$RO"
out="$( cd "$M" && CAMUS_MERGE_DIR="$RO/sub" bash "$here/merge.sh" camus/feat-m camus/feat/m/t1 "$MSG1" )"
chmod u+w "$RO"
check "unwritable receipt dir: stdout still exactly one JSON object" yes "$(jone "$out")"
check "unwritable receipt dir: verdict unchanged (merged true)" true "$(jget "$out" merged)"
check "unwritable receipt dir: verdict unchanged (alreadyUpToDate true)" true "$(jget "$out" alreadyUpToDate)"
check "unwritable receipt dir: receiptError present and explains" yes \
  "$(has "$(jget "$out" receiptError)" "receipt not written")"
check "unwritable receipt dir: no receipt file appeared" no "$([ -e "$RO/sub" ] && echo yes || echo no)"

# ════ containment.sh ═══════════════════════════════════════════════════════════════════════════
# Field soak 2026-06-13, finding 8: the receipt that replaced the thin-runner-echo containment
# check. {ran,dirty,paths}; --untracked-files=no; and the cardinal fix — a non-obtained answer
# is ran:false (inconclusive), NEVER clean and NEVER a breach.
CR="$ROOT/crepo"; mkdir -p "$CR"
( cd "$CR" && git init -q && echo a > a.txt && git add -A && git -c commit.gpgsign=false commit -qm base && git checkout -q -b camus/feat-c )
# invoked from inside the target repo (same as the merge.sh tests, and as REPO_CD does in production)
out="$( cd "$CR" && bash "$here/containment.sh" "$CR" )"
check "containment clean: ran true"        true  "$(jget "$out" ran)"
check "containment clean: dirty false"     false "$(jget "$out" dirty)"
check "containment clean: paths empty"     ""    "$(jget "$out" paths)"
check "containment clean: one JSON object" yes   "$(jone "$out")"
( cd "$CR" && echo more >> a.txt )
out="$( cd "$CR" && bash "$here/containment.sh" "$CR" )"
check "containment tracked edit: dirty true"           true "$(jget "$out" dirty)"
check "containment tracked edit: paths name the file"  yes  "$(has "$(jget "$out" paths)" "a.txt")"
( cd "$CR" && git checkout -q -- a.txt && echo junk > only-untracked.txt )
out="$( cd "$CR" && bash "$here/containment.sh" "$CR" )"
check "containment untracked-only: dirty false (--untracked-files=no)" false "$(jget "$out" dirty)"
( cd "$CR" && rm -f only-untracked.txt )
NG="$ROOT/notgit"; mkdir -p "$NG"
out="$( cd "$NG" && bash "$here/containment.sh" "$NG" )"
check "containment non-repo: ran false (inconclusive, not clean, not breach)" false "$(jget "$out" ran)"
check "containment non-repo: no dirty verdict (null)"  null "$(jget "$out" dirty)"
check "containment non-repo: one JSON object"          yes  "$(jone "$out")"

# ════ wt.sh resolve ════════════════════════════════════════════════════════════════════════════
# Audit item 6: JSON {found,path} replaces the brittle `cd && pwd` last-line pop(). The dest may
# legitimately not exist (→ found:false → the loop's recreate-from-branch lane).
RWT="$WTS/camus-wt-feat-c"; mkdir -p "$RWT"
out="$(bash "$here/wt.sh" resolve camus/feat-c "$RWT")"
check "wt resolve existing: found true"                 true "$(jget "$out" found)"
check "wt resolve existing: path names the worktree"    yes  "$(has "$(jget "$out" path)" "camus-wt-feat-c")"
out="$(bash "$here/wt.sh" resolve camus/feat-c "$WTS/camus-wt-feat-nope")"
check "wt resolve missing: found false (→ recreate lane)" false "$(jget "$out" found)"
check "wt resolve missing: path null"                     null  "$(jget "$out" path)"
out="$(bash "$here/wt.sh" resolve camus/feat-c "$WTS/not-a-camus-wt")"
check "wt resolve fence: non-camus-wt dest refused (ok false)" false "$(jget "$out" ok)"

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
