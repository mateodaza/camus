#!/usr/bin/env python3
"""Tests for land.py (human authorizes the auto-land lane for a stranded task). Pure stdlib —
runs standalone (`python3 test_land.py`) or under pytest; no third-party deps.

Fixture: a REAL tmpdir git repo (base commit → feat branch commit → a TASK branch holding ONE
commit the feat branch does not have, plus an EMPTY branch parked at the feat tip), because
the whole point of land is that git — not the human, not a mock — proves the branch still
holds unmerged work. CAMUS_HOME (the reconcile/land test seam) points at a sibling tmpdir
home. Discovery edge cases shared with reconcile (corrupt siblings, mtime ordering) are
covered in test_reconcile.py — land imports that machinery rather than reimplementing it."""
import json
import os
import subprocess
import tempfile
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from io import StringIO

import land as LD

TASK = "ship-the-widget-ab12cd"
FEAT = "my-feat-xy99zz"
PRIOR = {"what": "earlier decision", "why": "context from the run", "alternative": ""}
TASK_BRANCH = "camus/feat/%s/%s" % (FEAT, TASK)
EMPTY_BRANCH = "camus/feat/%s/empty-residue" % FEAT


def _git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args),
                       check=True, capture_output=True, text=True)
    return r.stdout.strip()


def _commit(repo, name, content):
    with open(os.path.join(repo, name), "w", encoding="utf-8") as fh:
        fh.write(content + "\n")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", "add " + name)


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)


def _task(task_id, status="noop", branch=TASK_BRANCH, decisions=(PRIOR,), **extra):
    """Synthetic task in the real state shape; default status is the production case (a
    laundered noop with real commits stranded on its branch). decisions=None omits the key
    entirely (hand-edited states in the wild sometimes lack it — land must initialize)."""
    t = {"taskId": task_id, "spec": "do the thing", "status": status,
         "branch": branch, "loopStatus": "halted_review_unresolved"}
    if decisions is not None:
        t["decisions"] = list(decisions)
    t.update(extra)
    return t


def _feat_state(base, feat_id, feat_branch, tasks, status="self_audit_failed"):
    path = os.path.join(base, "feats", "%s.json" % feat_id)
    _write(path, {"featId": feat_id, "feat": "Test feat", "featBranch": feat_branch,
                  "status": status, "tasks": tasks})
    return path


def _world(root, tasks=None, feat_status="self_audit_failed"):
    """Git repo + camus home. TASK_BRANCH holds ONE commit the feat branch lacks (real
    stranded work — good evidence); EMPTY_BRANCH points AT the feat tip (zero residue — the
    `git branch -D` case). The default feat status is the production halt land exists for."""
    repo = os.path.join(root, "repo")
    os.makedirs(repo)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@test")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")
    _commit(repo, "base.txt", "base")
    default_branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    feat_branch = "camus/feat-%s" % FEAT
    _git(repo, "checkout", "-q", "-b", feat_branch)
    _commit(repo, "feat.txt", "merged feat work")
    _git(repo, "branch", EMPTY_BRANCH)                       # at the feat tip: zero residue
    _git(repo, "checkout", "-q", "-b", TASK_BRANCH)
    _commit(repo, "stranded.txt", "proven work that never merged")
    _git(repo, "checkout", "-q", default_branch)
    base = os.path.join(root, "home")
    state_path = _feat_state(base, FEAT, feat_branch,
                             tasks if tasks is not None else [_task(TASK)],
                             status=feat_status)
    return {"repo": repo, "base": base, "feat_branch": feat_branch,
            "state_path": state_path}


@contextmanager
def _home(base):
    """Sandbox CAMUS_HOME for one call (land reads it at call time, not import time)."""
    old = os.environ.get("CAMUS_HOME")
    os.environ["CAMUS_HOME"] = base
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("CAMUS_HOME", None)
        else:
            os.environ["CAMUS_HOME"] = old


def _run(w, argv):
    """Invoke main() inside the sandboxed home; return (rc, stdout, stderr)."""
    out, err = StringIO(), StringIO()
    with _home(w["base"]), redirect_stdout(out), redirect_stderr(err):
        rc = LD.main(argv)
    return rc, out.getvalue(), err.getvalue()


def _state(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _raw(path):
    with open(path, "rb") as fh:
        return fh.read()


def test_happy_flip_from_noop():
    # The production lane (camello smoke 2026-06-12): a laundered noop whose branch holds real
    # commits. land flips ONLY the task; provenStatus stays ABSENT without --proven (the
    # engine's crash-carry stash owns that truth); the decision names old status + evidence.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, out, _ = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 0
        s = _state(w["state_path"])
        t = s["tasks"][0]
        assert t["status"] == "ready_to_merge"
        assert "provenStatus" not in t
        assert len(t["decisions"]) == 2 and t["decisions"][0] == PRIOR   # appended, not clobbered
        d = t["decisions"][-1]
        assert d["what"] == ("human authorized land: noop → ready_to_merge "
                             "(1 unmerged commit(s) on %s)" % TASK_BRANCH)
        assert d["why"] == "human verified the stranded work and authorized the auto-land lane"
        assert d["alternative"] == ""
        assert s["status"] == "self_audit_failed"   # feat status NEVER touched — resume reads tasks
        assert "authorized land for %s" % TASK in out
        assert out.rstrip().endswith(
            "re-run the feat with the SAME args — the auto-land lane merges it.")


def test_proven_flag_sets_proven_status_and_reason_lands_in_why():
    # A failed task whose state lost the verdict: --proven restores what the post-land status
    # should read; --reason becomes the decision's why (the audit trail names the human call).
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, status="failed", decisions=None)])
        rc, _, _ = _run(w, [TASK, "--repo", w["repo"], "--proven", "done_with_findings",
                            "--reason", "run-3 reviewed and verified this branch"])
        assert rc == 0
        t = _state(w["state_path"])["tasks"][0]
        assert t["status"] == "ready_to_merge"
        assert t["provenStatus"] == "done_with_findings"
        assert len(t["decisions"]) == 1              # decisions key was absent — initialized
        assert t["decisions"][-1]["why"] == "run-3 reviewed and verified this branch"
        assert "failed → ready_to_merge" in t["decisions"][-1]["what"]


def test_without_proven_flag_existing_proven_status_survives():
    # A proven merge_failed task still carries the crash-window stash the original run
    # persisted — landing without --proven must NOT clobber it (clobbering would launder
    # done_with_findings into plain done at the post-land status restore).
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, status="merge_failed",
                                      provenStatus="done_with_findings")])
        rc, _, _ = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 0
        t = _state(w["state_path"])["tasks"][0]
        assert t["status"] == "ready_to_merge"
        assert t["provenStatus"] == "done_with_findings"


def test_refuses_fully_merged_branch_with_branch_d_hint():
    # rev-list count 0: the branch exists but every commit is already in feat history — there
    # is nothing for the auto-land lane to merge, and the refusal says what the branch IS for.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, branch=EMPTY_BRANCH)])
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 1
        assert "holds no unmerged work" in err and "nothing to land" in err
        assert "git branch -D" in err
        assert _raw(w["state_path"]) == before   # byte-identical: refusal never mutates


def test_refuses_branch_missing_from_git():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, branch="camus/feat/%s/never-created" % FEAT)])
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 1
        assert "does not exist" in err and "nothing to land" in err
        assert _raw(w["state_path"]) == before


def test_refuses_status_done():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, status="done")])
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 1
        assert "already done" in err and "nothing to land" in err
        assert _raw(w["state_path"]) == before


def test_refuses_status_running():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, status="running")])
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 1
        assert "the run owns this task" in err and "steer or wait" in err
        assert _raw(w["state_path"]) == before


def test_merged_branch_takes_precedence_over_branch():
    # The same resolution the postflight self-audit uses (mergedBranch || branch): when the
    # state recorded where the work actually lives, the evidence check must look THERE.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, tasks=[_task(TASK, status="merge_failed",
                                      branch=EMPTY_BRANCH, mergedBranch=TASK_BRANCH)])
        rc, _, _ = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 0
        t = _state(w["state_path"])["tasks"][0]
        assert t["status"] == "ready_to_merge"
        assert TASK_BRANCH in t["decisions"][-1]["what"]


def test_unknown_task_id_lists_candidates():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, _, err = _run(w, ["no-such-task-zz00aa", "--repo", w["repo"]])
        assert rc == 1
        assert FEAT in err                       # the scan names what it DID find


def test_ambiguous_task_across_feats_demands_feat_flag():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        # A second feat (re-run of the same plan → deterministic taskIds collide) with the
        # same featBranch so the evidence check passes once disambiguated.
        other = "my-feat-rerun-aa11bb"
        other_path = _feat_state(w["base"], other, w["feat_branch"], [_task(TASK)])
        rc, _, err = _run(w, [TASK, "--repo", w["repo"]])
        assert rc == 1
        assert "--feat" in err and FEAT in err and other in err
        assert _state(w["state_path"])["tasks"][0]["status"] == "noop"   # neither touched
        assert _state(other_path)["tasks"][0]["status"] == "noop"
        # --feat resolves it — and only the named feat changes.
        rc, _, _ = _run(w, [TASK, "--repo", w["repo"], "--feat", other])
        assert rc == 0
        assert _state(other_path)["tasks"][0]["status"] == "ready_to_merge"
        assert _state(w["state_path"])["tasks"][0]["status"] == "noop"


# --- stdlib runner (no pytest required) ------------------------------------

if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok   " + fn.__name__)
        except AssertionError as exc:
            failed += 1
            print("FAIL " + fn.__name__ + ": " + str(exc))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("ERR  " + fn.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
