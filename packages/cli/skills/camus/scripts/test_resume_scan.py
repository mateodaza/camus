"""Contract tests for resume_scan.py (auto-resume scanner).

    python3 test_resume_scan.py      # stdlib runner (bottom)
    python3 -m pytest -q

Covers: only a STALE running feat with canonical resumeArgs is resumable; a FRESH running feat is
not (still live); every terminal status is excluded; old-format / malformed-task states are
rejected whole; the emitted entry reproduces the full original args + featId.
"""
import json
import os
import sys
import tempfile

import resume_scan as R

FRESH = 10        # seconds idle — younger than the stale threshold (still live)
STALE = 9999      # seconds idle — older than the threshold (interrupted)
THRESH = 1800


def running_state(tasks=None, **arg_extra):
    t = tasks if tasks is not None else ["task a", "task b"]
    args = {"argsVersion": 1, "feat": "My Feat", "tasks": t, "policy": "ask_on_ambiguity"}
    args.update(arg_extra)
    return {"status": "running", "featId": "my-feat-abc123", "resumeArgs": args,
            "tasks": [{"spec": s} for s in t if isinstance(s, str)]}


# --- the SAFE rule -----------------------------------------------------------

def test_stale_running_is_resumable():
    e = R.resumable_entry(running_state(), STALE, THRESH)
    assert e is not None and e["feat"] == "My Feat" and e["tasks"] == ["task a", "task b"]


def test_fresh_running_is_NOT_resumable():
    # a live run keeps touching its file → must not be restarted (would collide on branch/worktree)
    assert R.resumable_entry(running_state(), FRESH, THRESH) is None


def test_unknown_age_is_NOT_resumable():
    assert R.resumable_entry(running_state(), None, THRESH) is None


def test_every_terminal_status_excluded():
    for st in R.TERMINAL_STATUSES:
        s = running_state()
        s["status"] = st
        assert R.resumable_entry(s, STALE, THRESH) is None, st


# --- P1: canonical resumeArgs required + reproduced ---------------------------

def test_missing_resumeArgs_skipped():
    s = running_state()
    del s["resumeArgs"]
    assert R.resumable_entry(s, STALE, THRESH) is None


def test_wrong_argsVersion_skipped():
    s = running_state()
    s["resumeArgs"]["argsVersion"] = 2
    assert R.resumable_entry(s, STALE, THRESH) is None


def test_entry_reproduces_full_args():
    s = running_state(model="fable", modelTier="complex", skipPlan=True,
                      policy="ask_on_major", answers={"t-1": "do X"})
    s["resumeArgs"]["targetPath"] = "."
    e = R.resumable_entry(s, STALE, THRESH)
    assert e["policy"] == "ask_on_major"
    assert e["model"] == "fable" and e["modelTier"] == "complex"
    assert e["skipPlan"] is True and e["targetPath"] == "."
    assert e["answers"] == {"t-1": "do X"}
    assert e["featId"] == "my-feat-abc123"   # included for the scheduler, ignored by the runner


# --- P2b: malformed task list rejects the WHOLE state ------------------------

def test_blank_or_nonstring_task_rejects_whole_state():
    for bad in ([], ["ok", ""], ["ok", None], ["ok", 3], ["ok", "  "]):
        s = running_state()
        s["resumeArgs"]["tasks"] = bad
        assert R.resumable_entry(s, STALE, THRESH) is None, bad


def test_missing_feat_title_skipped():
    s = running_state()
    del s["resumeArgs"]["feat"]
    assert R.resumable_entry(s, STALE, THRESH) is None


# --- file reading / scan integration ----------------------------------------

def _write(d, name, obj, age=None, now=None):
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(obj if isinstance(obj, str) else json.dumps(obj))
    if age is not None:
        t = (now if now is not None else 0) - age
        os.utime(p, (t, t))
    return p


def test_read_feat_handles_bad_files():
    d = tempfile.mkdtemp(prefix="camus_rs_")
    assert R._read_feat(os.path.join(d, "nope.json")) is None       # missing
    assert R._read_feat(_write(d, "empty.json", "")) is None          # empty
    assert R._read_feat(_write(d, "bad.json", "{not json")) is None   # malformed
    assert R._read_feat(_write(d, "arr.json", "[1,2]")) is None       # not a dict


def test_scan_returns_only_stale_running():
    now = 1_000_000
    d = tempfile.mkdtemp(prefix="camus_rs_")
    _write(d, "stale-running.json", running_state(), age=STALE, now=now)
    _write(d, "fresh-running.json", running_state(), age=FRESH, now=now)
    done = running_state(); done["status"] = "done"
    _write(d, "done.json", done, age=STALE, now=now)
    _write(d, "junk.json", "{not json", age=STALE, now=now)
    res = R.scan(d, now=now, stale_sec=THRESH)
    assert len(res) == 1 and res[0]["feat"] == "My Feat"


def test_scan_missing_dir_returns_empty():
    assert R.scan("/no/such/dir", now=1, stale_sec=THRESH) == []


def test_env_threshold_default():
    os.environ.pop("CAMUS_RESUME_STALE_SEC", None)
    assert R.stale_seconds() == 1800
    os.environ["CAMUS_RESUME_STALE_SEC"] = "60"
    try:
        assert R.stale_seconds() == 60
    finally:
        os.environ.pop("CAMUS_RESUME_STALE_SEC", None)


# --- stdlib runner ----------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
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
