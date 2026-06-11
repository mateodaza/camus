#!/usr/bin/env python3
"""Mark a Camus task DONE because a HUMAN landed the work — with commit evidence, not trust.

The external half of land mode (docs/HARNESS-DIRECTION.md item 3, 2026-06-11): `land` covers
work the LOOP proved but never finished landing; reconcile covers work a human committed or
merged BY HAND outside the loop (hook fights, manual rescues, "faster to just do it"). Until
now telling camus about that meant hand-editing the feat state JSON — twice in production on
2026-06-11. This makes it a command.

  reconcile.py <taskId> --commit <sha>   # mark the task done, evidenced by <sha>
      [--feat FEATID]                    # disambiguate when the taskId is in several feats
      [--repo PATH]                      # target repo (default: cwd)
      [--remove-worktree]                # also remove the task's camus-wt-* checkout (fail-soft)

EVIDENCE CHECK (the engine's F14c discipline, as a command): the sha must (a) exist as a
commit in the repo (`git cat-file -e <sha>^{commit}`) and (b) be an ancestor of the feat
branch recorded in state (`git merge-base --is-ancestor`). A human's claim alone never flips
a task to done — git has to agree, exactly as the merge runner's prior-merge-commit evidence
must. A refusal leaves state untouched.

State lives under $CAMUS_HOME (default ~/.camus): feats/<featId>.json, worktrees/. CAMUS_HOME
is a RECONCILE-ONLY seam (so tests can sandbox a whole home incl. worktrees/): watch/status/
steer take --dir instead and do NOT read it. The mutation mirrors what the feat engine itself
records on a landed task — status, loopStatus, and an audit-trail decision entry naming the
evidence — so status/watch render a reconciled task with zero special-casing.
"""
import argparse
import glob
import json
import os
import subprocess
import sys


def camus_home():
    """Resolved at CALL time, not import time, so tests can sandbox via os.environ."""
    return os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")


def _read_json(path):
    """Return (obj, problem): (dict, None) | (None, "missing") | (None, "corrupt").
    Corrupt ≠ missing — a mid-write race on a live state file must never read as
    "no feat exists" (same infra-vs-findings discipline as the engine)."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None, "missing"
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None, "corrupt"
    return (obj, None) if isinstance(obj, dict) else (None, "corrupt")


def _git(repo, *args):
    """(returncode, combined output) for `git -C <repo> <args>`. Never raises — a missing
    git binary or a hung subprocess is an infra refusal, not a traceback."""
    try:
        r = subprocess.run(["git", "-C", repo] + list(args),
                           capture_output=True, text=True, timeout=60)
    except OSError as exc:
        return 1, str(exc)
    except subprocess.TimeoutExpired:
        return 1, "git timed out after 60s"
    return r.returncode, (r.stdout + r.stderr).strip()


def _find_task(state, task_id):
    for t in state.get("tasks", []):
        if isinstance(t, dict) and t.get("taskId") == task_id:
            return t
    return None


def locate_state(base, task_id, feat_id=None):
    """Return (state, path, error). Explicit --feat wins; otherwise scan feats/*.json
    newest-first for the one whose tasks[] contains taskId. Zero matches → error LISTING what
    was scanned (the likely causes are a typo'd taskId or the wrong CAMUS_HOME). MULTIPLE
    matches → refuse and demand --feat: taskIds are deterministic slugs, so re-running a feat
    reuses them, and silently picking the newest could reconcile the wrong run."""
    feats_dir = os.path.join(base, "feats")
    if feat_id:
        path = os.path.join(feats_dir, feat_id + ".json")
        obj, problem = _read_json(path)
        if problem == "corrupt":
            return None, None, ("feat state %s.json exists but is not valid JSON (mid-write "
                                "race, or corrupt) — retry in a moment" % feat_id)
        if obj is None:
            return None, None, "no feat state %s.json under %s" % (feat_id, feats_dir)
        if _find_task(obj, task_id) is None:
            return None, None, "feat %s has no task %r" % (feat_id, task_id)
        return obj, path, None
    try:
        names = [n for n in os.listdir(feats_dir) if n.endswith(".json")]
    except OSError:
        names = []
    entries = []
    for name in names:
        path = os.path.join(feats_dir, name)
        try:
            entries.append((os.path.getmtime(path), path))
        except OSError:
            continue
    entries.sort(key=lambda e: -e[0])           # newest first
    matches, scanned = [], []
    for _, path in entries:
        obj, _problem = _read_json(path)        # corrupt/vanished → skip; never a candidate
        if obj is None:
            continue
        fid = obj.get("featId") or os.path.basename(path)[:-5]
        scanned.append(fid)
        if _find_task(obj, task_id) is not None:
            matches.append((obj, path, fid))
    if not matches:
        return None, None, ("no feat under %s has a task %r — scanned (newest first): %s"
                            % (feats_dir, task_id, ", ".join(scanned) if scanned else "(none)"))
    if len(matches) > 1:
        return None, None, ("task %r appears in MULTIPLE feats (%s) — pick one with --feat"
                            % (task_id, ", ".join(fid for _, _, fid in matches)))
    return matches[0][0], matches[0][1], None


def evidence_check(repo, sha, feat_branch):
    """Return None when git agrees the sha is real AND on the feat branch, else the refusal.
    Both legs matter: cat-file alone accepts a commit from any branch; merge-base alone gives
    a confusing git error on garbage input instead of a clean 'does not exist'."""
    code, _out = _git(repo, "cat-file", "-e", sha + "^{commit}")
    if code != 0:
        return ("commit %s does not exist in %s — refusing to reconcile without evidence"
                % (sha, repo))
    code, _out = _git(repo, "merge-base", "--is-ancestor", sha, feat_branch)
    if code != 0:
        return ("commit %s is not on feat branch %s — refusing to reconcile without evidence"
                % (sha, feat_branch))
    return None


def apply_reconcile(state, task, sha):
    """The engine-shaped mutation (same fields a landed task carries), plus the audit-trail
    decision entry a hand-edit always forgot. Returns human summary lines."""
    was = task.get("status", "?")
    task["status"] = "done"
    task["loopStatus"] = "reconciled_by_human"
    task["reconciledSha"] = sha
    if not isinstance(task.get("decisions"), list):
        task["decisions"] = []
    task["decisions"].append({
        "what": "reconciled_by_human: marked done at %s" % sha,
        "why": ("a human landed/merged this work outside the loop and provided the commit "
                "as evidence"),
        "alternative": "",
    })
    lines = ["  status %s → done · loopStatus → reconciled_by_human · evidence %s" % (was, sha),
             "  decision appended (audit trail): %s" % task["decisions"][-1]["what"]]
    tasks = [t for t in state.get("tasks", []) if isinstance(t, dict)]
    # done_with_findings counts as COMPLETE (audit P2 follow-up #2, 2026-06-11): it is merged,
    # terminal-for-camus work — a mixed dwf+reconciled feat must reach integration_pending, not
    # stay falsely "running" (unsteerable-yet-steerable, heartbeat-warning-prone).
    if all(t.get("status") in ("done", "noop", "done_with_findings") for t in tasks):
        # NEVER set the feat itself "done" here (audit P1 2026-06-11): in camus-feat, a final
        # "done" MEANS env re-check + integration verify passed on the merged branch — a human
        # commit is task evidence, not integration proof. And leaving the PRIOR status (audit P2
        # follow-up, same day) lies the other way: a stale "running" makes status show a live
        # heartbeat (reconcile just rewrote the state file) and lets steer accept notes no task
        # boundary will ever consume. The explicit non-running state tells every surface the
        # truth — steer refuses it, resume-scan won't auto-resume it, status hints the re-run —
        # and the deliberate human re-run (done tasks skip) earns "done" via integration verify.
        feat_was = state.get("status", "?")
        # done_with_findings is TERMINAL (integration already ran green under its posture) —
        # downgrading it to integration_pending would re-demand proof the feat already has.
        if feat_was not in ("done", "done_with_noops", "done_with_findings"):
            state["status"] = "integration_pending"
            lines.append("  every task is now done/noop — feat status %s → integration_pending: "
                         "integration verify has NOT run on the merged branch" % feat_was)
        else:
            lines.append("  every task is done/noop and the feat already passed integration "
                         "(status %r) — left untouched" % feat_was)
        lines.append("  finish it: re-run the feat with the SAME args — done tasks skip; env "
                     "re-check + integration verify then earn the feat's 'done'")
    return lines


def remove_worktree(base, repo, task_id):
    """Best-effort cleanup of the task's checkout, FAIL-SOFT (mirrors the feat engine's
    removeTaskWorktree): only ever `git worktree remove` — never --force, NEVER rm -rf (the
    worktree may hold the only copy of un-pushed work). A refusal prints git's reason and the
    command still exits 0: the reconcile itself already succeeded."""
    pattern = os.path.join(base, "worktrees", "*", "camus-wt-" + task_id)
    paths = sorted(glob.glob(pattern))
    if not paths:
        print("no worktree matching %s — nothing to remove" % pattern)
        return
    for path in paths:
        code, out = _git(repo, "worktree", "remove", path)
        if code == 0:
            print("removed worktree %s (branch kept for audit)" % path)
        else:
            print("worktree left at %s — git refused: %s" % (path, out or "unknown"))
            print("  (fail-soft by design: never forced, never rm -rf — remove by hand if you are sure)")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Mark a Camus task done with commit evidence (a human landed it outside the loop)")
    ap.add_argument("taskId", help="the task to reconcile (see `camus status`)")
    ap.add_argument("--commit", required=True, metavar="SHA",
                    help="the commit that landed this task's work — must be on the feat branch")
    ap.add_argument("--feat", default=None, metavar="FEATID",
                    help="featId, when the taskId appears in several feats")
    ap.add_argument("--repo", default=None, metavar="PATH", help="target repo root (default: cwd)")
    ap.add_argument("--remove-worktree", action="store_true",
                    help="also remove the task's camus-wt-* checkout (fail-soft, never forced)")
    args = ap.parse_args(argv)

    base = camus_home()
    repo = os.path.abspath(args.repo or os.getcwd())

    state, path, err = locate_state(base, args.taskId, args.feat)
    if err:
        print("reconcile: %s" % err, file=sys.stderr)
        return 1
    task = _find_task(state, args.taskId)

    feat_branch = state.get("featBranch")
    if not isinstance(feat_branch, str) or not feat_branch.strip():
        print("reconcile: feat state %s has no featBranch — cannot run the evidence check"
              % path, file=sys.stderr)
        return 1
    # Evidence BEFORE mutation — a refusal must leave the state file byte-identical.
    err = evidence_check(repo, args.commit, feat_branch)
    if err:
        print("reconcile: %s" % err, file=sys.stderr)
        return 1

    lines = apply_reconcile(state, task, args.commit)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        # Never report success-shaped output when the write failed — the in-memory mutation
        # is gone the moment we exit, so claiming "reconciled" would be a lie.
        print("reconcile: could NOT write %s (%s) — state unchanged on disk" % (path, exc),
              file=sys.stderr)
        return 1

    print("reconciled %s in feat %s" % (args.taskId, state.get("featId", "?")))
    for line in lines:
        print(line)
    print("  state: %s" % path)
    if args.remove_worktree:
        remove_worktree(base, repo, args.taskId)
    return 0


if __name__ == "__main__":
    sys.exit(main())
