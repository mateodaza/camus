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


def test_render_liveness_from_transcript_activity():
    # Run feedback 2026-06-11: the state file can't distinguish working from dead (it writes at
    # boundaries) — transcript lastTs can. Fresh activity → an age line; stale activity on a
    # RUNNING feat → a loud may-have-died warning.
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "f.json"), _feat_state("f"))
        now = 1_800_000_000
        iso = lambda ago: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - ago))
        synth = S.synthesize(base)
        synth["state"]["status"] = "running"
        synth["live"] = [{"label": "implement", "model": "Opus", "outputTokens": 1, "toolCount": 0, "lastTs": iso(8)}]
        out = "\n".join(S.render(synth, now=now))
        assert "last activity" in out and "may have died" not in out
        synth["live"] = [{"label": "implement", "model": "Opus", "outputTokens": 1, "toolCount": 0, "lastTs": iso(1500)}]
        out = "\n".join(S.render(synth, now=now))
        assert "may have died" in out and "camus resume" in out
        # …but a finished feat with old transcripts is NOT flagged (nothing is supposed to run).
        synth["state"]["status"] = "done"
        out = "\n".join(S.render(synth, now=now))
        assert "may have died" not in out


def test_render_cost_estimate_is_honest():
    # Cost line renders as an ESTIMATE (audit 2026-06-11): rate-card value, never an invoice,
    # and the codex side is explicitly NOT dollarized (it settles in ChatGPT plan credits).
    with tempfile.TemporaryDirectory() as base:
        _write(os.path.join(base, "feats", "f.json"), _feat_state("f"))
        synth = S.synthesize(base)
        synth["live"] = [{"label": "review", "model": "Haiku", "outputTokens": 5, "toolCount": 1}]
        synth["cost"] = {"usd": 1.23, "byModel": {"Haiku": 1.23}, "ratesAsOf": "2026-05-26"}
        out = "\n".join(S.render(synth))
        assert "$1.23" in out and "estimate, not an invoice" in out
        assert "ChatGPT plan credits" in out
        assert "2026-05-26" in out   # rate-card date rendered → stale pricing is visible, not silent
        # …and no cost data → no fabricated dollars.
        synth["cost"] = None
        assert "$" not in "\n".join(S.render(synth))


def test_render_heartbeat_age_uses_newest_of_state_and_hb_mtime():
    # Item 1, display half (2026-06-11): 0.2.5 engines `touch` <featId>.hb at every phase
    # boundary; the heartbeat is the NEWEST of (state json mtime, .hb mtime) — whichever
    # artifact moved last proves the run is alive. Fixed epoch + os.utime → no sleeps, no flake.
    with tempfile.TemporaryDirectory() as base:
        now = 1_800_000_000
        sp = os.path.join(base, "feats", "f.json")
        _write(sp, _feat_state("f"))
        hb = os.path.join(base, "feats", "f.hb")
        _write_raw(hb, "")                            # touch-equivalent: contents irrelevant
        os.utime(sp, (now - 300, now - 300))          # state persisted 5m ago…
        os.utime(hb, (now - 7, now - 7))              # …but a phase boundary touched 7s ago
        synth = S.synthesize(base, now=now)
        synth["live"] = []                            # keep this machine's real transcripts out
        out = "\n".join(S.render(synth, now=now))
        assert "last heartbeat 7s ago" in out
        assert "state updated" not in out             # the hb phrasing REPLACES the legacy line
        os.utime(sp, (now - 3, now - 3))              # newest wins in BOTH directions
        synth = S.synthesize(base, now=now)
        synth["live"] = []
        assert "last heartbeat 3s ago" in "\n".join(S.render(synth, now=now))


def test_render_without_hb_keeps_legacy_rendering():
    # Pre-0.2.5 runs have no .hb and must render EXACTLY as before: "state updated" phrasing and
    # NO died-warning even when running+stale — their state only writes at task boundaries, which
    # can legitimately be >10 min apart, so staleness alone proves nothing without the .hb contract.
    with tempfile.TemporaryDirectory() as base:
        now = 1_800_000_000
        sp = os.path.join(base, "feats", "f.json")
        _write(sp, _feat_state("f"))                  # status=running
        os.utime(sp, (now - 1500, now - 1500))        # stale by any standard
        synth = S.synthesize(base, now=now)
        synth["live"] = []
        out = "\n".join(S.render(synth, now=now))
        assert "state updated 25m00s ago" in out
        assert "heartbeat" not in out


def test_render_heartbeat_stale_warning_only_when_running():
    # "running" must MEAN running (HARNESS-DIRECTION item 1): a .hb quiet for >10 min on a
    # running feat is loud; the same staleness on a finished feat is just history.
    with tempfile.TemporaryDirectory() as base:
        now = 1_800_000_000
        sp = os.path.join(base, "feats", "f.json")
        _write(sp, _feat_state("f"))                  # status=running
        hb = os.path.join(base, "feats", "f.hb")
        _write_raw(hb, "")
        os.utime(sp, (now - 1500, now - 1500))
        os.utime(hb, (now - 1500, now - 1500))
        synth = S.synthesize(base, now=now)
        synth["live"] = []
        out = "\n".join(S.render(synth, now=now))
        assert 'no heartbeat for 25m on a "running" feat' in out
        assert "safe to resume with the same args" in out
        synth["state"]["status"] = "done"             # same staleness, finished feat → silent
        assert "no heartbeat for" not in "\n".join(S.render(synth, now=now))
        os.utime(hb, (now - 30, now - 30))            # fresh heartbeat on a running feat → quiet too
        synth = S.synthesize(base, now=now)
        synth["live"] = []
        out = "\n".join(S.render(synth, now=now))
        assert "no heartbeat for" not in out and "last heartbeat 30s ago" in out


def test_render_integration_pending_hints_and_never_warns():
    # Audit P2 follow-up (2026-06-11): a fully-reconciled feat is NOT running — the explicit
    # integration_pending status must render the finish-it hint and never trip the may-have-died
    # warning, no matter how stale the heartbeat (nothing is supposed to be beating).
    with tempfile.TemporaryDirectory() as base:
        now = 1_800_000_000
        sp = os.path.join(base, "feats", "f.json")
        st = _feat_state("f", status="integration_pending")
        _write(sp, st)
        hb = os.path.join(base, "feats", "f.hb")
        _write_raw(hb, "")
        os.utime(sp, (now - 9000, now - 9000))
        os.utime(hb, (now - 9000, now - 9000))
        synth = S.synthesize(base, now=now)
        synth["live"] = []
        out = "\n".join(S.render(synth, now=now))
        assert "[integration_pending]" in out
        assert "INTEGRATION PENDING" in out and "Re-run the feat with the SAME args" in out
        assert "no heartbeat for" not in out         # non-running → the liveness contract is silent


def test_render_persisted_feat_token_rollup():
    # Item 4, display half (2026-06-11): per-task tokens PERSIST across resumes, so their sum is
    # the one cross-run feat number — rendered as a persisted counter, never an invoice.
    with tempfile.TemporaryDirectory() as base:
        st = _feat_state("f")
        st["tasks"][1]["tokens"] = 60000              # both tasks counted: 145k + 60k
        _write(os.path.join(base, "feats", "f.json"), st)
        synth = S.synthesize(base, "f")
        synth["live"] = []
        out = "\n".join(S.render(synth))
        assert "persisted feat total: ~205k output tokens across runs (per-task, survives resume)" in out
        # …absent / non-numeric / bool tokens are never summed (no fabricated numbers): when no
        # task carries a real count, the line is omitted entirely.
        st2 = _feat_state("f2")
        del st2["tasks"][0]["tokens"]
        st2["tasks"][1]["tokens"] = "lots"
        st2["tasks"].append({"taskId": "x-ee33ff", "spec": "x", "status": "pending", "tokens": True})
        _write(os.path.join(base, "feats", "f2.json"), st2)
        synth = S.synthesize(base, "f2")
        synth["live"] = []
        assert "persisted feat total" not in "\n".join(S.render(synth))


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
