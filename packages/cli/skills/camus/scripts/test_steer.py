#!/usr/bin/env python3
"""Tests for steer.py (the human steering note). Pure stdlib — runs standalone
(`python3 test_steer.py`) or under pytest; no fixtures, no third-party deps."""
import json
import os
import tempfile
from contextlib import redirect_stderr, redirect_stdout
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


# --- merge, don't clobber (fixlet 2026-06-11) -------------------------------
# A second steer before the note is consumed must COMPOSE with the pending one:
# answers map-merge (newest-per-key wins), guidance updates only when re-given,
# pause is sticky-true. Clobbering silently dropped the first --task answer.

def test_second_task_steer_merges_answers():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["keep the old API", "--task", "task-a", "--dir", base]) == 0
        buf = StringIO()
        with redirect_stdout(buf):
            assert ST.main(["drop the cache", "--task", "task-b", "--dir", base]) == 0
        assert _note(base, "f1")["answers"] == {"task-a": "keep the old API",
                                                "task-b": "drop the cache"}
        assert "merged with the pending note (2 answer(s) total)" in buf.getvalue()


def test_same_task_answer_newest_wins():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["first thought", "--task", "task-a", "--dir", base]) == 0
        with redirect_stdout(StringIO()):
            assert ST.main(["actually, do this", "--task", "task-a", "--dir", base]) == 0
        assert _note(base, "f1")["answers"] == {"task-a": "actually, do this"}


def test_pause_sticky_across_follow_up_steers():
    # Once the human asked for a halt, a later answer/guidance steer must NOT un-pause —
    # un-pausing is an explicit --clear + re-steer, never a side effect.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["--pause", "--dir", base]) == 0
        with redirect_stdout(StringIO()):
            assert ST.main(["answer while paused", "--task", "task-a", "--dir", base]) == 0
        note = _note(base, "f1")
        assert note["pause"] is True
        assert note["answers"] == {"task-a": "answer while paused"}


def test_guidance_updates_only_when_regiven():
    # A --task follow-up carries no guidance — the queued guidance must survive it;
    # a guidance follow-up DOES carry one — newest wins.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert ST.main(["use adapter B", "--dir", base]) == 0
        with redirect_stdout(StringIO()):
            assert ST.main(["keep the old API", "--task", "task-a", "--dir", base]) == 0
        note = _note(base, "f1")
        assert note["guidance"] == "use adapter B"
        assert note["answers"] == {"task-a": "keep the old API"}
        with redirect_stdout(StringIO()):
            assert ST.main(["use adapter C", "--dir", base]) == 0
        assert _note(base, "f1")["guidance"] == "use adapter C"


def test_unparseable_pending_note_replaced_with_loud_warning():
    # Can't merge into garbage; replacing silently would hide that an earlier steer was lost.
    # The warning must name the file so the human can see what was discarded.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        note_path = os.path.join(base, "steer", "f1.json")
        _write_raw(note_path, '{"answers": {"task-a": "trunc')
        err = StringIO()
        with redirect_stdout(StringIO()), redirect_stderr(err):
            assert ST.main(["fresh guidance", "--dir", base]) == 0
        note = _note(base, "f1")
        assert note["guidance"] == "fresh guidance"
        assert "answers" not in note            # garbage was discarded, not resurrected
        assert "WARNING" in err.getvalue() and note_path in err.getvalue()


def test_integration_pending_feat_refuses_steer():
    # Audit P2 follow-up (2026-06-11): a fully-reconciled feat (all tasks done by hand, integration
    # verify still owed) has NO task boundary left to consume a note — steer must refuse it the
    # same way it refuses done/halted feats.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="integration_pending")
        err = StringIO()
        with redirect_stderr(err):
            assert ST.main(["go faster", "--feat", "f1", "--dir", base]) == 1
        assert "not running" in err.getvalue()
        assert _note(base, "f1") is None


# --- write_note_merged: the one write path for non-CLI callers (audit P1 2026-06-11) -------

def test_write_note_merged_composes_with_pending():
    # watch's keypresses go through here — same merge rules as the CLI, so an interactive
    # pause no longer clobbers queued answers (the audit's exact sequence).
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        ST.write_note(base, "f1", {"answers": {"task-a": "keep it"}})
        _, warn = ST.write_note_merged(base, "f1", {"pause": True})
        assert warn is None
        note = _note(base, "f1")
        assert note["pause"] is True and note["answers"] == {"task-a": "keep it"}


def test_write_note_merged_replaces_corrupt_with_warning():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        note_path = ST.steer_path(base, "f1")
        _write_raw(note_path, "not json")
        _, warn = ST.write_note_merged(base, "f1", {"guidance": "go"})
        assert warn is not None and "re-issued" in warn
        assert _note(base, "f1")["guidance"] == "go"


# --- claim-awareness (re-soak 2026-06-14, finding P2): steer_read.py treats a `<feat>.json.consuming`
#     claim file (a crashed consume) as PENDING state, so the human CLI must agree. ---------------

def _claim_path(base, feat_id):
    return os.path.join(base, "steer", "%s.json.consuming" % feat_id)


def _write_raw(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def test_clear_removes_a_stranded_claim_too():
    # The bug: --clear only removed <feat>.json, so a stranded claim survived and a re-run resurrected
    # the "cleared" note. --clear must remove BOTH.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _write_raw(_claim_path(base, "f1"), '{"guidance":"stranded"}')
        out = StringIO()
        with redirect_stdout(out):
            assert ST.main(["--clear", "--dir", base]) == 0
        assert not os.path.exists(_claim_path(base, "f1")), "the stranded claim must be cleared"
        assert "stranded claim" in out.getvalue()


def test_clear_reports_nothing_when_truly_empty():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        out = StringIO()
        with redirect_stdout(out):
            assert ST.main(["--clear", "--dir", base]) == 0
        assert "no pending steer note" in out.getvalue()


def test_show_surfaces_a_stranded_claim():
    # --show must not lie: a stranded claim is pending state, so it has to appear (even with no live note).
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _write_raw(_claim_path(base, "f1"), '{"guidance":"stranded"}')
        out = StringIO()
        with redirect_stdout(out):
            assert ST.main(["--show", "--dir", base]) == 0
        text = out.getvalue()
        assert "stranded steer claim" in text and "no pending steer note" not in text


def test_write_refuses_while_a_claim_exists():
    # A new steer while a claim is stranded must NOT report success and leave the run halted on both.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _write_raw(_claim_path(base, "f1"), '{"guidance":"stranded"}')
        err = StringIO()
        with redirect_stdout(StringIO()), redirect_stderr(err):
            assert ST.main(["new guidance", "--dir", base]) == 1
        assert "stranded steer claim" in err.getvalue()
        assert _note(base, "f1") is None, "no new live note is written while a claim is unresolved"


def test_write_note_primitive_refuses_at_the_side_effect():
    # P2 round 6: the guard lives INSIDE the write primitive, so it catches a claim regardless of any
    # caller-side check. write_note raises ClaimPresentError; write_note_merged returns (None, msg).
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _write_raw(_claim_path(base, "f1"), '{"guidance":"stranded"}')
        raised = False
        try:
            ST.write_note(base, "f1", {"guidance": "x"})
        except ST.ClaimPresentError:
            raised = True
        assert raised, "the write primitive must refuse over a stranded claim"
        assert _note(base, "f1") is None
        path, msg = ST.write_note_merged(base, "f1", {"guidance": "x"})
        assert path is None and "stranded steer claim" in msg, (path, msg)


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
