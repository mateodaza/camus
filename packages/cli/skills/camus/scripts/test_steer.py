#!/usr/bin/env python3
"""Tests for steer.py (the human steering note). Pure stdlib — runs standalone
(`python3 test_steer.py`) or under pytest; no fixtures, no third-party deps."""
import json
import os
import tempfile
from contextlib import redirect_stdout
from io import StringIO

import steer as ST


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _feat(base, feat_id="my-feat-abc123", status="running"):
    _write(os.path.join(base, "feats", "%s.json" % feat_id),
           {"featId": feat_id, "feat": "My feat", "status": status, "tasks": []})


def _note(base, feat_id):
    p = os.path.join(base, "steer", "%s.json" % feat_id)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def test_guidance_writes_note_for_single_running_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["use adapter B, not A", "--dir", base]) == 0
        note = _note(base, "f1")
        assert note["guidance"] == "use adapter B, not A"
        assert isinstance(note["writtenAt"], int)


def test_task_targets_specific_task():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["keep the old API", "--task", "polish-it-cc22dd", "--dir", base]) == 0
        assert _note(base, "f1")["answers"] == {"polish-it-cc22dd": "keep the old API"}


def test_pause_writes_pause_note():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["--pause", "--dir", base]) == 0
        assert _note(base, "f1")["pause"] is True


def test_pause_refuses_combined_guidance():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["--pause", "also do this", "--dir", base]) == 1
        assert _note(base, "f1") is None


def test_refuses_when_no_running_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        assert ST.main(["some guidance", "--dir", base]) == 1
        assert _note(base, "f1") is None


def test_explicit_feat_write_requires_running_status():
    # P2 (review 2026-06-10): featIds are deterministic — a note written against a done/halted
    # feat would fire on a FUTURE run of the same feat. Writes must require status == running.
    with tempfile.TemporaryDirectory() as base:
        for st in ("done", "needs_human", "paused_by_user", "halted"):
            fid = "feat-%s" % st
            _feat(base, fid, status=st)
            assert ST.main(["g", "--feat", fid, "--dir", base]) == 1
            assert _note(base, fid) is None
        _feat(base, "feat-live", status="running")
        assert ST.main(["g", "--feat", "feat-live", "--dir", base]) == 0
        assert _note(base, "feat-live")["guidance"] == "g"


def test_show_and_clear_allowed_on_non_running_feat():
    # A stale note on a finished feat must always be inspectable and retractable.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        _write(os.path.join(base, "steer", "f1.json"), {"guidance": "stale"})
        buf = StringIO()
        with redirect_stdout(buf):
            assert ST.main(["--show", "--feat", "f1", "--dir", base]) == 0
        assert "stale" in buf.getvalue()
        with redirect_stdout(StringIO()):
            assert ST.main(["--clear", "--feat", "f1", "--dir", base]) == 0
        assert _note(base, "f1") is None


def test_refuses_when_multiple_running_without_feat_flag():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _feat(base, "f2")
        assert ST.main(["g", "--dir", base]) == 1
        assert ST.main(["g", "--feat", "f2", "--dir", base]) == 0
        assert _note(base, "f2")["guidance"] == "g"


def test_explicit_feat_must_exist():
    with tempfile.TemporaryDirectory() as base:
        assert ST.main(["g", "--feat", "ghost", "--dir", base]) == 1


def test_show_and_clear():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        ST.main(["g", "--dir", base])
        buf = StringIO()
        with redirect_stdout(buf):
            assert ST.main(["--show", "--dir", base]) == 0
        assert "g" in buf.getvalue()
        with redirect_stdout(StringIO()):
            assert ST.main(["--clear", "--dir", base]) == 0
        assert _note(base, "f1") is None


def test_no_args_prints_help_and_fails():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        with redirect_stdout(StringIO()):
            assert ST.main(["--dir", base]) == 1


def _write_raw(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def test_corrupt_state_refused_distinctly_not_as_missing():
    # Corrupt ≠ missing: an explicit --feat on a damaged/mid-write state file must refuse
    # without writing, and a sole-running feat whose state is corrupt must not be steerable.
    with tempfile.TemporaryDirectory() as base:
        _write_raw(os.path.join(base, "feats", "f1.json"), '{"truncated mid wri')
        assert ST.main(["g", "--feat", "f1", "--dir", base]) == 1
        assert _note(base, "f1") is None
        assert ST.main(["g", "--dir", base]) == 1     # scan path: corrupt never counts as running


def test_show_reports_corrupt_note():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _write_raw(os.path.join(base, "steer", "f1.json"), "not json at all")
        with redirect_stdout(StringIO()):
            assert ST.main(["--show", "--dir", base]) == 1


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
