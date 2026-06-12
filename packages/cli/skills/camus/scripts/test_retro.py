#!/usr/bin/env python3
"""Tests for retro.py (read-only run-history analytics). Pure stdlib — runs standalone
(`python3 test_retro.py`) or under pytest; no third-party deps.

Fixtures are synthetic reports written into <home>/reports/, because the whole job of retro is
tolerating the report schema as it evolved across versions. The cases that matter:
  - a MODERN report (posture, totalOutputTokens, per-task tokens + rounds),
  - a LEGACY-shape report (no posture, no totalOutputTokens, a task with NO `tokens`) — the
    real smoke-camus-rename shape that must parse without a KeyError,
  - a CORRUPT / non-dict file that must be skipped silently, never abort the run.
CAMUS_HOME is the sandbox seam (retro reads it at call time, like land). Two contracts get
their own assertions: evidence gating (a rec below the >=3 threshold prints "insufficient data
(N runs)"; at/above it the rec fires AND cites its count) and zero writes (the reports dir
listing + mtimes are byte-identical before/after a run, incl. --json)."""
import json
import os
import tempfile
import time
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from io import StringIO

import retro as RT


def _write(path, obj_or_text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        if isinstance(obj_or_text, str):
            fh.write(obj_or_text)
        else:
            json.dump(obj_or_text, fh, indent=2)


def _modern(feat_id, posture="full", status="done", total=5000,
            task_tokens=(1000, 4000), rounds=(0, 2)):
    """A current-shape report: top-level posture + totalOutputTokens, per-task tokens + rounds."""
    tasks = []
    for i, tok in enumerate(task_tokens):
        t = {"taskId": "%s-t%d" % (feat_id, i), "spec": "do %d" % i, "status": "done",
             "branch": "b", "loopStatus": "done", "tokens": tok}
        if i < len(rounds):
            t["rounds"] = rounds[i]
        tasks.append(t)
    return {"featId": feat_id, "feat": "F", "featBranch": "fb", "status": status,
            "posture": posture, "totalOutputTokens": total, "tasks": tasks}


def _legacy(feat_id):
    """The smoke-camus-rename shape: NO posture, NO top-level totalOutputTokens, and a task
    WITHOUT a `tokens` field. retro must render this without a KeyError."""
    return {"featId": feat_id, "feat": "F", "featBranch": "fb", "status": "halted",
            "tasks": [
                {"taskId": "%s-t0" % feat_id, "spec": "x", "status": "done",
                 "branch": "b", "loopStatus": "done", "rounds": 1,
                 "tier": "trivial", "model": "sonnet"},     # has rounds, but NO tokens
                {"taskId": "%s-t1" % feat_id, "spec": "y", "status": "halted",
                 "branch": "b", "loopStatus": "halted"}]}   # no tokens, no rounds


def _home_with(root, reports):
    """Write {filename: report-obj-or-raw-text} into <root>/reports and return reports dir."""
    rdir = os.path.join(root, "reports")
    for name, obj in reports.items():
        _write(os.path.join(rdir, name), obj)
    return rdir


@contextmanager
def _home(base):
    """Sandbox CAMUS_HOME for one call (retro reads it at call time, not import time)."""
    old = os.environ.get("CAMUS_HOME")
    os.environ["CAMUS_HOME"] = base
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("CAMUS_HOME", None)
        else:
            os.environ["CAMUS_HOME"] = old


def _run(base, argv):
    """Invoke main() inside the sandboxed home; return (rc, stdout, stderr)."""
    out, err = StringIO(), StringIO()
    with _home(base), redirect_stdout(out), redirect_stderr(err):
        rc = RT.main(argv)
    return rc, out.getvalue(), err.getvalue()


def _listing(rdir):
    """A snapshot of the reports dir: {name: (size, mtime_ns)} for every file. Drives the
    zero-writes assertion — if retro touched anything, this comparison fails."""
    snap = {}
    for name in sorted(os.listdir(rdir)):
        st = os.stat(os.path.join(rdir, name))
        snap[name] = (st.st_size, st.st_mtime_ns)
    return snap


# --- field tolerance -------------------------------------------------------

def test_legacy_report_parses_without_keyerror_and_appears():
    # The legacy shape (no posture, no top-level tokens, a task with no `tokens`) must render
    # in both the per-feat line and the aggregate without raising.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {"legacy.json": _legacy("legacy-feat-aa11bb")})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        assert "legacy-feat-aa11bb" in out
        assert "posture=-" in out            # missing posture renders as "-", not a crash
        assert "status=halted" in out


def test_corrupt_and_nondict_files_are_skipped_silently():
    # A half-written file and a JSON non-dict (a list) must be dropped, leaving only the good
    # report — one bad file never aborts the whole analysis.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {
            "good.json": _modern("good-feat-cc22dd"),
            "corrupt.json": "{ this is not, json",
            "nondict.json": "[1, 2, 3]"})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        assert "good-feat-cc22dd" in out
        assert "per-feat (1 report)" in out   # only the one parseable report counted


def test_empty_home_is_not_an_error():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "reports"))
        rc, out, err = _run(root, [])
        assert rc == 0, err
        assert "no reports" in out


def test_feat_tokens_falls_back_to_per_task_sum():
    # No top-level totalOutputTokens, but per-task tokens present → the per-feat line sums them.
    with tempfile.TemporaryDirectory() as root:
        rep = _modern("sum-feat-ee33ff", task_tokens=(100, 200, 300))
        del rep["totalOutputTokens"]
        _home_with(root, {"sum.json": rep})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        assert "tokens=600" in out            # 100+200+300, summed from the tasks


def test_nonnumeric_token_field_does_not_crash():
    # A token field holding junk must be ignored, not crash a percentile.
    with tempfile.TemporaryDirectory() as root:
        rep = _modern("junk-feat-gg44hh", task_tokens=(500,))
        rep["tasks"][0]["tokens"] = "n/a"     # non-numeric — coerced to None, skipped
        del rep["totalOutputTokens"]
        _home_with(root, {"junk.json": rep})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        assert "tokens=-" in out              # nothing numeric to show


# --- evidence gating -------------------------------------------------------

def test_below_threshold_recs_say_insufficient_data():
    # A single modern report → every rec's evidence set is under 3 → all fall to the honest
    # "insufficient data (N runs)" branch rather than extrapolating.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {"one.json": _modern("solo-feat-ii55jj")})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        recs = out.split("== recommendations")[1]
        assert "posture-mix: insufficient data (1 runs)" in recs
        assert "insufficient data" in recs
        # and NO rec fired with a citation
        assert "used in" not in recs and "p90/p50" not in recs


def test_posture_mix_fires_with_citation_at_threshold():
    # >=3 posture-tagged runs → the posture-mix rec fires AND cites its count + the breakdown.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {
            "a.json": _modern("a-feat-aa00", posture="oneshot"),
            "b.json": _modern("b-feat-bb00", posture="oneshot"),
            "c.json": _modern("c-feat-cc00", posture="full")})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        recs = out.split("== recommendations")[1]
        assert "posture-mix: oneshot used in 2/3 posture-tagged runs" in recs
        assert "full=1" in recs and "oneshot=2" in recs
        assert "insufficient data" not in recs.split("posture-mix")[1].split("\n")[0]


def test_review_rounds_high_fires_with_citation():
    # >=3 rounds-tracked tasks, two of them >=2 rounds → the review-rounds rec cites the ratio.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {
            "a.json": _modern("a-feat-aa01", rounds=(2, 3), task_tokens=(10, 20)),
            "b.json": _modern("b-feat-bb01", rounds=(0,), task_tokens=(30,))})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        recs = out.split("== recommendations")[1]
        # 3 tasks carry rounds (2,3,0); 2 are >=2; max is 3
        assert "review-rounds-high: 2/3 rounds-tracked tasks needed >=2 review rounds" in recs
        assert "max 3" in recs


def test_token_spread_fires_with_citation():
    # >=3 token-tracked tasks → the token-spread rec cites p90/p50 and both percentiles.
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {
            "a.json": _modern("a-feat-aa02", task_tokens=(100, 200), rounds=()),
            "b.json": _modern("b-feat-bb02", task_tokens=(900,), rounds=())})
        rc, out, err = _run(root, [])
        assert rc == 0, err
        recs = out.split("== recommendations")[1]
        assert "token-spread: p90/p50" in recs
        assert "token-tracked tasks" in recs


# --- zero writes -----------------------------------------------------------

def test_run_writes_nothing_to_reports_dir():
    # The read-only contract: the reports dir listing + sizes + mtimes are identical before and
    # after a plain run AND a --json run. retro has no write path, and this proves it.
    with tempfile.TemporaryDirectory() as root:
        rdir = _home_with(root, {
            "a.json": _modern("a-feat-zz01"),
            "legacy.json": _legacy("legacy-zz02"),
            "corrupt.json": "{not json"})
        before = _listing(rdir)
        time.sleep(0.01)                      # ensure any stray write would move an mtime
        rc, _, err = _run(root, [])
        assert rc == 0, err
        rc, _, err = _run(root, ["--json"])
        assert rc == 0, err
        assert _listing(rdir) == before       # byte-identical: nothing created, touched, or rewritten


# --- --json contract -------------------------------------------------------

def test_json_emits_aggregate_only_no_recommendation_prose():
    with tempfile.TemporaryDirectory() as root:
        _home_with(root, {
            "a.json": _modern("a-feat-jj01", status="done", posture="full"),
            "b.json": _legacy("legacy-jj02")})
        rc, out, err = _run(root, ["--json"])
        assert rc == 0, err
        data = json.loads(out)                # must be parseable JSON
        # aggregate keys present
        for key in ("runs", "statusMix", "postureUsage", "roundsDistribution",
                    "tokenP50", "tokenP90", "tokenTasks"):
            assert key in data, key
        assert data["runs"] == 2
        assert data["statusMix"] == {"done": 1, "halted": 1}
        assert data["postureUsage"] == {"full": 1, "unset": 1}   # legacy lacks posture → "unset"
        # internal drivers and all prose are absent
        assert "_task_tokens" not in data and "_all_rounds" not in data
        assert "recommend" not in out.lower() and "insufficient data" not in out
        assert "per-feat" not in out


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
