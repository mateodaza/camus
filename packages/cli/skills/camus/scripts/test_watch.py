#!/usr/bin/env python3
"""Tests for watch.py's pure parts (frame composition + key dispatch). The termios IO
loop stays untested by design — it is a thin shell over these. Pure stdlib; runs
standalone (`python3 test_watch.py`) or under pytest."""
import json
import os
import tempfile

import watch as W


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _feat(base, feat_id="my-feat-abc123", status="running"):
    _write(os.path.join(base, "feats", "%s.json" % feat_id),
           {"featId": feat_id, "feat": "My feat", "status": status,
            "tasks": [{"taskId": "t-1", "spec": "a", "status": "running", "branch": "b"}],
            "events": [{"seq": 1, "msg": "Baseline green."}]})


def _note(base, feat_id):
    p = os.path.join(base, "steer", "%s.json" % feat_id)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def test_frame_renders_dashboard_plus_footer():
    with tempfile.TemporaryDirectory() as base:
        _feat(base)
        lines = W.frame(base, None)
        text = "\n".join(lines)
        assert "My feat" in text and "Baseline green." in text
        assert W.FOOTER in text
        assert "»" not in text                       # no feedback line when empty


def test_frame_feedback_line_appended():
    with tempfile.TemporaryDirectory() as base:
        _feat(base)
        assert W.frame(base, None, feedback="done")[-1] == "» done"


def test_frame_no_state_and_corrupt_state_messages():
    with tempfile.TemporaryDirectory() as base:
        assert "has a run started?" in "\n".join(W.frame(base, None))
        os.makedirs(os.path.join(base, "feats"))
        with open(os.path.join(base, "feats", "f.json"), "w") as fh:
            fh.write('{"truncated')
        assert "not valid JSON" in "\n".join(W.frame(base, None))


def test_dispatch_pause_writes_note_for_running_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("p", base, None)
        assert "pause note written" in fb
        assert _note(base, "f1")["pause"] is True


def test_dispatch_pause_refused_when_not_running():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        fb = W.dispatch("p", base, None)
        assert fb.startswith("pause refused:")
        assert _note(base, "f1") is None


def test_dispatch_guidance_uses_injected_prompt():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("g", base, None, prompt=lambda _: "  use adapter B  ")
        assert "guidance note written" in fb
        assert _note(base, "f1")["guidance"] == "use adapter B"


def test_dispatch_guidance_empty_writes_nothing():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("g", base, None, prompt=lambda _: "   ")
        assert "nothing written" in fb
        assert _note(base, "f1") is None


def test_dispatch_clear_removes_note_even_on_finished_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        _write(os.path.join(base, "steer", "f1.json"), {"pause": True})
        fb = W.dispatch("c", base, "f1")
        assert fb == "steer note cleared"
        assert _note(base, "f1") is None
        assert W.dispatch("c", base, "f1") == "no pending steer note"


def test_dispatch_explicit_feat_id_targets_that_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _feat(base, "f2")
        fb = W.dispatch("p", base, "f2")
        assert "pause note written" in fb
        assert _note(base, "f2")["pause"] is True and _note(base, "f1") is None


def test_dispatch_unknown_key_is_noop():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert W.dispatch("x", base, None) == ""
        assert _note(base, "f1") is None


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
