"""Tests for canary.py (the known-answer self-test of the local gate toolchain).

Pure stdlib — runs standalone (`python3 test_canary.py`) or under pytest; no real codex
ever runs (the --review path is exercised through an injected fake reviewer script via
CAMUS_CANARY_REVIEWER). Requires `node` on PATH for the RED/GREEN verify lanes (the same
toolchain canary itself proves); the node-dependent tests skip cleanly when it is absent,
mirroring test_verify.py's real-git skip discipline.

Covered:
  - RED stage observes the failing verdict (pass:false, NAMED ran-and-failed check).
  - GREEN stage passes and HEAD-binds (result.head == rev-parse HEAD).
  - End-to-end run() without --review returns ok and tears the temp tree down.
  - cleanup-on-FAILURE: a forced early-stage failure still removes the throwaway repo.
  - --review plumbing: a fake reviewer emitting a contract-shaped verdict GATES through
    (clean and blocking cases both parse + pass); a verdict MISSING a contract key fails
    the review stage with that key named as evidence; an infra-failure verdict (all keys
    present but ran:false) fails the review stage instead of passing as a green.
"""
import json
import os
import shutil
import stat
import subprocess
import tempfile

import canary as CN

HAVE_NODE = shutil.which("node") is not None


def _skip(name):
    print("skip %s (node not on PATH)" % name)


# --- fake reviewer scaffolding ---------------------------------------------

def _fake_reviewer(parent, verdict):
    """Write an executable stub that ignores its args and prints `verdict` as JSON —
    stands in for codex_review.sh so no real codex call happens. Returns its path."""
    path = os.path.join(parent, "fake_reviewer.sh")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("#!/usr/bin/env bash\ncat <<'JSON'\n%s\nJSON\n" % json.dumps(verdict))
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IRWXU)
    return path


def _contract_verdict(clean=True):
    """A normalized reviewer verdict carrying every REVIEW_CONTRACT_KEYS key."""
    return {"ran": True, "clean": clean, "verdict": "APPROVED" if clean else "REVISE",
            "blocking": [] if clean else [{"priority": 1, "title": "x"}],
            "nonblocking": []}


# --- stage-level contracts -------------------------------------------------

def test_red_stage_detects_failing_verdict():
    if not HAVE_NODE:
        return _skip("test_red_stage_detects_failing_verdict")
    with tempfile.TemporaryDirectory() as parent:
        repo = CN.build_repo(parent)
        out = CN.stage_red(repo)
        assert out["pass"] is False
        # a NAMED ran-and-failed check, not an inconclusive/empty failure set
        assert out["named_failure"]               # the stage name that failed (node:test)
        assert out["result"]["inconclusive"] is False


def test_green_stage_passes_and_head_binds():
    if not HAVE_NODE:
        return _skip("test_green_stage_passes_and_head_binds")
    with tempfile.TemporaryDirectory() as parent:
        repo = CN.build_repo(parent)
        CN.stage_red(repo)                         # ordered: red precedes green
        out = CN.stage_green(repo)
        assert out["pass"] is True
        head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        assert out["head"] == head                 # head-binding contract
        assert out["result"]["head"] == head       # verify.py named the same HEAD


# --- end-to-end + cleanup --------------------------------------------------

def test_run_without_review_passes_end_to_end():
    if not HAVE_NODE:
        return _skip("test_run_without_review_passes_end_to_end")
    ok, report = CN.run(review=False)
    assert ok is True
    assert report["ok"] is True
    assert [s["stage"] for s in report["stages"]] == ["red", "green"]


def test_cleanup_runs_even_on_failure(monkeypatch=None):
    # Force GREEN to raise AFTER the temp tree exists; the finally: must still nuke it.
    # We capture the mkdtemp path by wrapping tempfile.mkdtemp, then assert it is gone.
    created = {}
    real_mkdtemp = tempfile.mkdtemp

    def _spy(*a, **k):
        path = real_mkdtemp(*a, **k)
        if k.get("prefix") == "camus_canary_" or (a and a == ()):
            created["path"] = path
        return path

    def _boom(repo):
        raise CN.StageError("green", {"forced": "boom"})

    orig_mkdtemp = tempfile.mkdtemp
    orig_green = CN.stage_green
    # Also stub build_repo+stage_red so the test doesn't need node to reach the failure.
    orig_build = CN.build_repo
    orig_red = CN.stage_red
    tempfile.mkdtemp = _spy
    CN.stage_green = _boom
    CN.build_repo = lambda parent: os.path.join(parent, CN.WORKTREE_DIRNAME)
    CN.stage_red = lambda repo: {"pass": False, "named_failure": "node:test", "result": {}}
    try:
        ok, report = CN.run(review=False)
    finally:
        tempfile.mkdtemp = orig_mkdtemp
        CN.stage_green = orig_green
        CN.build_repo = orig_build
        CN.stage_red = orig_red
    assert ok is False
    assert report["failed_stage"] == "green"
    assert "path" in created
    assert not os.path.exists(created["path"])     # finally: tore the throwaway tree down


# --- --review plumbing (fake reviewer, no real codex) ----------------------

def test_review_stage_gates_on_contract_verdict():
    if not HAVE_NODE:
        return _skip("test_review_stage_gates_on_contract_verdict")
    for clean in (True, False):
        with tempfile.TemporaryDirectory() as parent:
            reviewer = _fake_reviewer(parent, _contract_verdict(clean=clean))
            os.environ["CAMUS_CANARY_REVIEWER"] = reviewer
            try:
                repo = CN.build_repo(parent)
                out = CN.stage_review(repo)
            finally:
                os.environ.pop("CAMUS_CANARY_REVIEWER", None)
            assert out["contract_keys_present"] is True
            assert out["ran"] is True


def test_review_stage_fails_when_contract_key_missing():
    if not HAVE_NODE:
        return _skip("test_review_stage_fails_when_contract_key_missing")
    bad = _contract_verdict(clean=True)
    del bad["blocking"]                            # drop a required contract key
    with tempfile.TemporaryDirectory() as parent:
        reviewer = _fake_reviewer(parent, bad)
        os.environ["CAMUS_CANARY_REVIEWER"] = reviewer
        try:
            repo = CN.build_repo(parent)
            raised = None
            try:
                CN.stage_review(repo)
            except CN.StageError as exc:
                raised = exc
        finally:
            os.environ.pop("CAMUS_CANARY_REVIEWER", None)
        assert raised is not None and raised.stage == "review"
        assert "blocking" in raised.evidence.get("missing", [])


def test_review_stage_fails_on_infra_failure_verdict():
    # A reviewer infra failure carries every contract key but ran:false — it must NOT pass
    # the review self-test (regression: ran:false was previously accepted as a green).
    if not HAVE_NODE:
        return _skip("test_review_stage_fails_on_infra_failure_verdict")
    infra = {"ran": False, "clean": False, "verdict": "ERROR",
             "blocking": [], "nonblocking": []}
    with tempfile.TemporaryDirectory() as parent:
        reviewer = _fake_reviewer(parent, infra)
        os.environ["CAMUS_CANARY_REVIEWER"] = reviewer
        try:
            repo = CN.build_repo(parent)
            raised = None
            try:
                CN.stage_review(repo)
            except CN.StageError as exc:
                raised = exc
        finally:
            os.environ.pop("CAMUS_CANARY_REVIEWER", None)
        assert raised is not None and raised.stage == "review"


def test_run_with_review_uses_injected_reviewer():
    if not HAVE_NODE:
        return _skip("test_run_with_review_uses_injected_reviewer")
    with tempfile.TemporaryDirectory() as parent:
        reviewer = _fake_reviewer(parent, _contract_verdict(clean=True))
        os.environ["CAMUS_CANARY_REVIEWER"] = reviewer
        try:
            ok, report = CN.run(review=True)
        finally:
            os.environ.pop("CAMUS_CANARY_REVIEWER", None)
        assert ok is True
        assert [s["stage"] for s in report["stages"]] == ["red", "green", "review"]


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
