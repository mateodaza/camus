#!/usr/bin/env python3
"""Tests for status.py (the read-only feat dashboard). Pure stdlib — runs standalone
(`python3 test_status.py`) or under pytest; no fixtures, no third-party deps."""
import json
import os
import tempfile
import time
from contextlib import redirect_stdout
from io import StringIO

import status as S


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _feat_state(feat_id="my-feat-abc123", status="running"):
    return {
        "featId": feat_id,
        "feat": "My feat",
        "featBranch": "camus/feat-%s" % feat_id,
        "base": "main",
        "status": status,
        "events": [
            {"seq": 1, "msg": "Feat branch created."},
            {"seq": 2, "msg": "Baseline green."},
            {"seq": 3, "msg": "Task 1/2: do the thing  →  loop."},
        ],
        "tasks": [
            {"taskId": "do-the-thing-aa11bb", "spec": "do the thing", "status": "done",
             "branch": "camus/feat/x/do-the-thing-aa11bb", "rounds": 2, "tokens": 145000},
            {"taskId": "polish-it-cc22dd", "spec": "polish it", "status": "running",
             "branch": "camus/feat/x/polish-it-cc22dd"},
        ],
    }


def test_synthesize_picks_most_recent_state():
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "old-feat.json"), _feat_state("old-feat"))
        new_path = os.path.join(base, "feats", "new-feat.json")
        _write(new_path, _feat_state("new-feat"))
        os.utime(new_path, (time.time() + 5, time.time() + 5))   # no sleep: force a newer mtime
        synth = S.synthesize(base)
        assert synth["state"]["featId"] == "new-feat"


def test_synthesize_explicit_feat_id():
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "a.json"), _feat_state("a"))
        _write(os.path.join(base, "feats", "b.json"), _feat_state("b"))
        assert S.synthesize(base, "a")["state"]["featId"] == "a"
        assert S.synthesize(base, "missing") is None


def test_synthesize_none_when_no_state():
    with tempfile.TemporaryDirectory() as base:
        assert S.synthesize(base) is None


def test_review_activity_matches_only_this_feats_tasks():
    with tempfile.TemporaryDirectory() as base:
        rdir = os.path.join(base, "reviews")
        _write(os.path.join(rdir, "camus-wt-do-the-thing-aa11bb-r1.json"), {})
        _write(os.path.join(rdir, "camus-wt-do-the-thing-aa11bb-r2.json"), {})
        _write(os.path.join(rdir, "camus-wt-other-feats-task-zz99-r1.json"), {})
        acts = S.review_activity(base, ["do-the-thing-aa11bb", "polish-it-cc22dd"])
        assert len(acts) == 2
        assert {a["round"] for a in acts} == {"1", "2"}
        assert all(a["taskId"] == "do-the-thing-aa11bb" for a in acts)


def test_render_shows_tasks_events_and_steer_hint():
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "f.json"), _feat_state("f"))
        out = "\n".join(S.render(S.synthesize(base)))
        assert "My feat" in out and "[running]" in out
        assert "1/2 done" in out                      # noop/done counting
        assert "✓" in out and "▸" in out              # glyphs for done / running
        assert "2 rounds" in out and "~145k tokens" in out
        assert "Baseline green." in out               # event ring rendered
        assert "camus steer" in out                   # steering hint when none pending


def test_render_needs_human_shows_question_and_resume():
    with tempfile.TemporaryDirectory() as base:
        st = _feat_state("f", status="needs_human")
        st["question"] = "Which adapter should win?"
        st["tasks"][1]["status"] = "needs_human"
        _write(os.path.join(base, "feats", "f.json"), st)
        out = "\n".join(S.render(S.synthesize(base)))
        assert "Which adapter should win?" in out
        assert 'answers:{"polish-it-cc22dd"' in out


def test_render_shows_pending_steer_note():
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "f.json"), _feat_state("f"))
        _write(os.path.join(base, "steer", "f.json"), {"guidance": "prefer adapter B"})
        out = "\n".join(S.render(S.synthesize(base)))
        assert "PENDING" in out and "prefer adapter B" in out


def test_events_capped_to_last_ten_in_render():
    with tempfile.TemporaryDirectory() as base:
        st = _feat_state("f")
        st["events"] = [{"seq": i, "msg": "step %d" % i} for i in range(1, 16)]
        _write(os.path.join(base, "feats", "f.json"), st)
        out = "\n".join(S.render(S.synthesize(base)))
        assert "step 6" in out and "step 15" in out
        assert "step 5" not in out


def test_main_json_roundtrip():
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "f.json"), _feat_state("f"))
        buf = StringIO()
        with redirect_stdout(buf):
            rc = S.main(["--json", "--dir", base])
        assert rc == 0
        parsed = json.loads(buf.getvalue())
        assert parsed["state"]["featId"] == "f"


def test_main_exit_1_when_empty():
    with tempfile.TemporaryDirectory() as base:
        assert S.main(["--dir", base]) == 1


def _write_raw(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def test_corrupt_state_is_not_reported_as_missing():
    # A mid-write race / damaged file must never read as "no run exists" (exit 2, not 1).
    with tempfile.TemporaryDirectory() as base:
        _write_raw(os.path.join(base, "feats", "f.json"), '{"truncated mid wri')
        assert S.main(["f", "--dir", base]) == 2
        assert S.main(["--dir", base]) == 2


def test_corrupt_newest_falls_back_to_older_valid_state():
    # The newest file racing a write must not hide an older valid (live) run.
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "valid.json"), _feat_state("valid"))
        corrupt = os.path.join(base, "feats", "newer-corrupt.json")
        _write_raw(corrupt, '{"truncated mid wri')
        os.utime(corrupt, (time.time() + 5, time.time() + 5))
        synth = S.synthesize(base)
        assert synth["state"]["featId"] == "valid"
        assert synth["skippedCorrupt"] == [corrupt]


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
