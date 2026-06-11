#!/usr/bin/env python3
"""Tests for reconcile.py (human marks a task done, with commit evidence). Pure stdlib —
runs standalone (`python3 test_reconcile.py`) or under pytest; no third-party deps.

Fixture: a REAL tmpdir git repo (base commit → feat branch commit → an off-branch commit),
because the whole point of reconcile is that git — not the human, not a mock — supplies the
evidence verdict. CAMUS_HOME (reconcile's test seam) points at a sibling tmpdir home."""
import json
import os
import subprocess
import tempfile
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from io import StringIO

import reconcile as RC

TASK = "add-the-widget-ab12cd"
FEAT = "my-feat-xy99zz"
PRIOR = {"what": "earlier decision", "why": "context from the run", "alternative": ""}


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


def _task(task_id, status="ready_to_merge", decisions=(PRIOR,)):
    """Synthetic task in the real state shape. decisions=None omits the key entirely
    (hand-edited states in the wild sometimes lack it — reconcile must initialize)."""
    t = {"taskId": task_id, "spec": "do the thing", "status": status,
         "branch": "camus/feat/%s/%s" % (FEAT, task_id),
         "loopStatus": "halted_review_unresolved"}
    if decisions is not None:
        t["decisions"] = list(decisions)
    return t


def _feat_state(base, feat_id, feat_branch, tasks, status="running"):
    path = os.path.join(base, "feats", "%s.json" % feat_id)
    _write(path, {"featId": feat_id, "feat": "Test feat", "featBranch": feat_branch,
                  "status": status, "tasks": tasks})
    return path


def _world(root, tasks=None, status="running"):
    """Git repo + camus home. Returns the bits the tests poke at:
    feat_sha IS on the feat branch (good evidence); off_sha EXISTS but is not (bad)."""
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
    _commit(repo, "feat.txt", "the landed work")
    feat_sha = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-q", default_branch)
    _commit(repo, "off.txt", "exists, but never merged into the feat branch")
    off_sha = _git(repo, "rev-parse", "HEAD")
    base = os.path.join(root, "home")
    state_path = _feat_state(base, FEAT, feat_branch, tasks if tasks is not None else [_task(TASK)],
                             status=status)
    return {"repo": repo, "base": base, "feat_branch": feat_branch,
            "feat_sha": feat_sha, "off_sha": off_sha, "state_path": state_path}


@contextmanager
def _home(base):
    """Sandbox CAMUS_HOME for one call (reconcile reads it at call time, not import time)."""
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
        rc = RC.main(argv)
    return rc, out.getvalue(), err.getvalue()


def _state(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _raw(path):
    with open(path, "rb") as fh:
        return fh.read()


def test_happy_path_marks_done_appends_decision_feat_integration_pending():
    # Audit P1 2026-06-11: reconciling the LAST open task must NOT set the feat "done" — in
    # camus-feat that status MEANS integration verify passed on the merged branch, and reconcile
    # has no integration proof. Audit P2 follow-up (same day): leaving the PRIOR status lies the
    # other way (a stale "running" shows a live heartbeat and stays steerable) — the explicit
    # integration_pending state is non-running, non-steerable, non-auto-resumable.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, out, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 0
        s = _state(w["state_path"])
        t = s["tasks"][0]
        assert t["status"] == "done"
        assert t["loopStatus"] == "reconciled_by_human"
        assert t["reconciledSha"] == w["feat_sha"]
        assert len(t["decisions"]) == 2 and t["decisions"][0] == PRIOR   # appended, not clobbered
        d = t["decisions"][-1]
        assert d["what"] == "reconciled_by_human: marked done at %s" % w["feat_sha"]
        assert "human" in d["why"] and "evidence" in d["why"]
        assert d["alternative"] == ""
        assert s["status"] == "integration_pending"   # non-running truth: nothing is live
        assert "integration verify" in out and "re-run the feat" in out
        assert "reconciled %s" % TASK in out


def test_already_done_feat_is_not_downgraded():
    # A feat that ALREADY passed integration stays "done" — reconciling one of its tasks (an
    # audit-trail touch-up) must not regress it to integration_pending.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root, status="done")
        rc, out, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 0
        assert _state(w["state_path"])["status"] == "done"
        assert "left untouched" in out


def test_feat_status_stays_while_other_tasks_remain():
    with tempfile.TemporaryDirectory() as root:
        # The reconciled task has NO decisions key (a hand-edited state) — must initialize.
        sibling = _task("polish-it-cc22dd", status="pending")
        w = _world(root, tasks=[_task(TASK, decisions=None), sibling])
        rc, _, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 0
        s = _state(w["state_path"])
        assert s["tasks"][0]["status"] == "done"
        assert len(s["tasks"][0]["decisions"]) == 1
        assert s["tasks"][1] == sibling          # untouched
        assert s["status"] == "running"          # a task is still pending — no all-done message
        # the all-done integration pointer must NOT print while tasks remain
        # (it is asserted present in the happy-path test above)


def test_refuses_sha_not_on_feat_branch_state_untouched():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--commit", w["off_sha"], "--repo", w["repo"]])
        assert rc == 1
        assert "refusing to reconcile without evidence" in err
        assert "not on feat branch" in err
        assert _raw(w["state_path"]) == before   # byte-identical: refusal never mutates


def test_refuses_nonexistent_sha_state_untouched():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        before = _raw(w["state_path"])
        rc, _, err = _run(w, [TASK, "--commit", "deadbeef" * 5, "--repo", w["repo"]])
        assert rc == 1
        assert "does not exist" in err and "refusing" in err
        assert _raw(w["state_path"]) == before


def test_unknown_task_id_lists_candidates():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, _, err = _run(w, ["no-such-task-zz00aa", "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 1
        assert FEAT in err                       # the scan names what it DID find


def test_ambiguous_task_across_feats_demands_feat_flag():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        # A second feat (re-run of the same plan → deterministic taskIds collide) with the
        # same branch so the evidence check passes once disambiguated.
        other = "my-feat-rerun-aa11bb"
        other_path = _feat_state(w["base"], other, w["feat_branch"], [_task(TASK)])
        rc, _, err = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 1
        assert "--feat" in err and FEAT in err and other in err
        assert _state(w["state_path"])["tasks"][0]["status"] == "ready_to_merge"   # neither touched
        assert _state(other_path)["tasks"][0]["status"] == "ready_to_merge"
        # --feat resolves it — and only the named feat changes.
        rc, _, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"], "--feat", other])
        assert rc == 0
        assert _state(other_path)["tasks"][0]["status"] == "done"
        assert _state(w["state_path"])["tasks"][0]["status"] == "ready_to_merge"


def test_explicit_feat_without_that_task_refuses():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, _, err = _run(w, ["ghost-task-ff00ff", "--commit", w["feat_sha"],
                              "--repo", w["repo"], "--feat", FEAT])
        assert rc == 1 and "no task" in err


def test_missing_feat_branch_refuses_before_git():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        state = _state(w["state_path"])
        del state["featBranch"]
        _write(w["state_path"], state)
        rc, _, err = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 1 and "featBranch" in err


def test_corrupt_sibling_state_skipped_in_scan():
    # Corrupt ≠ missing (house discipline): a mid-write race on ANOTHER feat's state must not
    # block reconciling this one.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        broken = os.path.join(w["base"], "feats", "broken.json")
        with open(broken, "w", encoding="utf-8") as fh:
            fh.write('{"truncated mid wri')
        rc, _, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"]])
        assert rc == 0
        assert _state(w["state_path"])["tasks"][0]["status"] == "done"


def test_remove_worktree_fail_soft_on_non_worktree_dir():
    # A plain directory at the worktree path (git refuses to remove it): the reconcile itself
    # still succeeds (exit 0), the dir and its contents SURVIVE — never rm -rf.
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        fake = os.path.join(w["base"], "worktrees", "repo-1", "camus-wt-" + TASK)
        os.makedirs(fake)
        precious = os.path.join(fake, "precious.txt")
        with open(precious, "w", encoding="utf-8") as fh:
            fh.write("un-pushed work, maybe")
        rc, out, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"],
                              "--remove-worktree"])
        assert rc == 0
        assert "git refused" in out and fake in out
        assert os.path.isdir(fake) and os.path.exists(precious)
        assert _state(w["state_path"])["tasks"][0]["status"] == "done"


def test_remove_worktree_removes_a_clean_real_worktree():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        wt = os.path.join(w["base"], "worktrees", "repo-1", "camus-wt-" + TASK)
        os.makedirs(os.path.dirname(wt), exist_ok=True)
        _git(w["repo"], "worktree", "add", "-q", wt, w["feat_branch"])
        rc, out, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"],
                              "--remove-worktree"])
        assert rc == 0
        assert "removed worktree" in out
        assert not os.path.exists(wt)


def test_remove_worktree_with_nothing_to_remove_still_exits_zero():
    with tempfile.TemporaryDirectory() as root:
        w = _world(root)
        rc, out, _ = _run(w, [TASK, "--commit", w["feat_sha"], "--repo", w["repo"],
                              "--remove-worktree"])
        assert rc == 0 and "nothing to remove" in out


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
