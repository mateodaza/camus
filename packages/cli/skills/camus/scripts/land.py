#!/usr/bin/env python3
"""Flip a STRANDED Camus task to ready_to_merge — authorize the auto-land lane, with git
evidence, not trust.

The CLI half of the gate's own remedy (2026-06-12): when a feat halts self_audit_failed (or a
merge refusal / laundered noop strands proven work on its branch), the prescribed fix is "flip
the task to ready_to_merge and re-run — the auto-land lane merges it". Until now applying that
remedy meant raw JSON surgery on ~/.camus/feats/<id>.json — done in production on 2026-06-12
(the camello smoke). This makes it a command, the sibling of reconcile.py (HARNESS-DIRECTION
item 3): reconcile covers work a human committed BY HAND outside the loop; land covers work
the LOOP proved but never finished merging.

  land.py <taskId>                          # authorize the auto-land lane for the task
      [--feat FEATID]                       # disambiguate when the taskId is in several feats
      [--repo PATH]                         # target repo (default: cwd)
      [--proven done|done_with_findings]    # restore the loop's real verdict after the land
      [--reason "<text>"]                   # audit-trail why (decision entry)

ELIGIBILITY: only the stranded-work statuses — merge_failed, noop, failed — may be landed.
done/done_with_findings/ready_to_merge already won (nothing to land); anything else (running,
pending, needs_human, ...) belongs to the run — steer it or wait for the boundary.

EVIDENCE CHECK (reconcile's discipline, pointed the other way): the task branch (mergedBranch
|| branch) must EXIST (`rev-parse --verify`) AND hold commits NOT in the feat branch
(`rev-list --count <featBranch>..<branch>` strictly > 0). A human's word alone never flips
state — git has to show real unmerged work, exactly as the resume's PROVEN_READY lane and the
postflight self-audit demand. Zero residue means there is nothing for the auto-land lane to
merge: that branch is `git branch -D` territory, not a land. A refusal leaves state untouched.

State discovery is reconcile's, imported (watch.py precedent for sibling imports): $CAMUS_HOME
(default ~/.camus)/feats/<featId>.json — --feat direct, else a newest-first scan; corrupt
siblings skipped; multiple matches refused (deterministic taskIds collide across re-runs).

The mutation touches ONLY the task: status → ready_to_merge, provenStatus when --proven says
so (absent the flag it is left alone — the engine's crash-carry stash may already hold the
loop's real verdict, and clobbering it would launder done_with_findings into plain done), and
an audit-trail decision naming the evidence. The FEAT status is deliberately left untouched.
"""
import argparse
import json
import os
import re
import sys

import reconcile as RC   # same home seam, same state discovery, same git shim — by construction

LANDABLE = ("merge_failed", "noop", "failed")               # the stranded-work statuses
TERMINAL_GOOD = ("done", "done_with_findings", "ready_to_merge")


def eligibility_check(task, task_id):
    """Return None when the task is stranded work land can rescue, else the refusal.
    Two distinct refusals on purpose: a terminal-good status has NOTHING to land (re-running
    the feat is the whole move), while a live/paused status still BELONGS to the run — landing
    under it would race the engine's own writes to the same state file."""
    status = task.get("status", "?")
    if status in LANDABLE:
        return None
    if status in TERMINAL_GOOD:
        hint = " (already authorized — just re-run the feat)" if status == "ready_to_merge" else ""
        return "task %s is already %s — nothing to land%s" % (task_id, status, hint)
    return ("task %s is %s — the run owns this task — steer or wait (land only rescues the "
            "stranded statuses: %s)" % (task_id, status, ", ".join(LANDABLE)))


def evidence_check(repo, branch, feat_branch):
    """Return (count, None) when git shows REAL unmerged work on the branch, else (None,
    refusal). Both legs matter (reconcile's pattern): rev-parse alone proves existence but not
    residue; rev-list alone gives a confusing git error on a missing branch instead of a clean
    verdict. And the count must be STRICTLY > 0 — an empty-residue branch has nothing for the
    auto-land lane to merge, so flipping it would strand the resume in a no-op merge."""
    # Guard the ref shape BEFORE it reaches git (poisoned ~/.camus state is a named threat): a leading-dash
    # value would be parsed as an OPTION by rev-parse (info-disclosure), and `--` is NOT a fix here — for
    # rev-parse `--` means "the rest are PATHS", which would make the ref unresolvable. Reject flag-shaped /
    # non-ref values instead; a real camus branch is refs/heads/camus/… (audit 2026-06-29).
    if not isinstance(branch, str) or not re.match(r"^[0-9A-Za-z._@/-]+$", branch) or branch.startswith("-"):
        return None, ("branch %r is not a valid ref name — refusing to land without a clean ref" % branch)
    code, _out = RC._git(repo, "rev-parse", "--verify", "-q", branch)
    if code != 0:
        return None, ("branch %s does not exist in %s — branch holds no unmerged work — "
                      "nothing to land" % (branch, repo))
    code, out = RC._git(repo, "rev-list", "--count", "%s..%s" % (feat_branch, branch), "--")
    if code != 0:
        return None, ("could not count unmerged commits (%s..%s: %s) — refusing to land "
                      "without evidence" % (feat_branch, branch, out or "git error"))
    try:
        count = int(out)
    except ValueError:
        return None, ("rev-list returned %r, not a count — refusing to land without evidence"
                      % out)
    if count <= 0:
        return None, ("branch %s holds no unmerged work — nothing to land (an empty-residue "
                      "branch is `git branch -D` territory, not a land)" % branch)
    return count, None


def apply_land(task, count, branch, reason, proven):
    """The minimal mutation the resume's PROVEN_READY lane reads, plus the audit-trail
    decision a hand-edit always forgot. Returns human summary lines."""
    was = task.get("status", "?")
    task["status"] = "ready_to_merge"
    lines = ["  status %s → ready_to_merge · evidence: %d unmerged commit(s) on %s"
             % (was, count, branch)]
    if proven:
        task["provenStatus"] = proven
        lines.append("  provenStatus → %s (after the auto-land, the engine restores the "
                     "loop's real verdict)" % proven)
    # Without --proven, provenStatus is NOT touched: a proven merge_failed task usually still
    # carries the crash-window stash the original run persisted, and that stash — not a fresh
    # human guess — is the truth the post-land status restore reads.
    if not isinstance(task.get("decisions"), list):
        task["decisions"] = []
    task["decisions"].append({
        "what": "human authorized land: %s → ready_to_merge (%d unmerged commit(s) on %s)"
                % (was, count, branch),
        "why": reason or "human verified the stranded work and authorized the auto-land lane",
        "alternative": "",
    })
    lines.append("  decision appended (audit trail): %s" % task["decisions"][-1]["what"])
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Authorize the auto-land lane for a stranded Camus task (git must show "
                    "unmerged commits on its branch)")
    ap.add_argument("taskId", help="the stranded task to land (see `camus status`)")
    ap.add_argument("--feat", default=None, metavar="FEATID",
                    help="featId, when the taskId appears in several feats")
    ap.add_argument("--repo", default=None, metavar="PATH", help="target repo root (default: cwd)")
    ap.add_argument("--proven", default=None, choices=("done", "done_with_findings"),
                    help="the loop's real verdict, restored after the auto-land merge "
                         "(omit to keep whatever the state already carries)")
    ap.add_argument("--reason", default=None, metavar="TEXT",
                    help="why you authorized this (recorded in the task's decision log)")
    args = ap.parse_args(argv)

    base = RC.camus_home()
    repo = os.path.abspath(args.repo or os.getcwd())

    state, path, err = RC.locate_state(base, args.taskId, args.feat)
    if err:
        print("land: %s" % err, file=sys.stderr)
        return 1
    task = RC._find_task(state, args.taskId)

    err = eligibility_check(task, args.taskId)
    if err:
        print("land: %s" % err, file=sys.stderr)
        return 1

    feat_branch = state.get("featBranch")
    if not isinstance(feat_branch, str) or not feat_branch.strip():
        print("land: feat state %s has no featBranch — cannot run the evidence check" % path,
              file=sys.stderr)
        return 1
    branch = task.get("mergedBranch") or task.get("branch")
    if not isinstance(branch, str) or not branch.strip():
        print("land: task %s has no branch recorded — cannot run the evidence check"
              % args.taskId, file=sys.stderr)
        return 1
    # Evidence BEFORE mutation — a refusal must leave the state file byte-identical.
    count, err = evidence_check(repo, branch, feat_branch)
    if err:
        print("land: %s" % err, file=sys.stderr)
        return 1

    lines = apply_land(task, count, branch, args.reason, args.proven)
    # The FEAT status stays as-is (2026-06-12), even when it is a terminal halt
    # (self_audit_failed, feat_integration_failed, halted, done_with_noops): the resume's
    # carry-forward reads TASK statuses regardless of the feat's halt status, and rewriting
    # the feat to "running" would lie to status/watch (a live heartbeat with nothing alive)
    # exactly the way reconcile's audit (P2, 2026-06-11) forbade. The task flip IS the remedy.
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        # Never report success-shaped output when the write failed — the in-memory mutation
        # is gone the moment we exit, so claiming "authorized" would be a lie.
        print("land: could NOT write %s (%s) — state unchanged on disk" % (path, exc),
              file=sys.stderr)
        return 1

    print("authorized land for %s in feat %s" % (args.taskId, state.get("featId", "?")))
    for line in lines:
        print(line)
    print("  feat status %r left untouched — the resume reads tasks regardless"
          % state.get("status", "?"))
    print("  state: %s" % path)
    print("  finish it: re-run the feat with the SAME args — the auto-land lane merges it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
