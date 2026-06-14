"""Tests for feat_scan.py (fork-detection inventory).

CAMUS_HOME IS the camus home itself (default ~/.camus) — the convention reconcile.py/land.py use.
The verification audit (2026-06-13) caught the original nesting .camus UNDER CAMUS_HOME, which
silently disabled fork detection under a custom home.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _run(home):
    return subprocess.run(
        [sys.executable, os.path.join(HERE, "feat_scan.py")],
        capture_output=True, text=True,
        env={**os.environ, "CAMUS_HOME": home},
    ).stdout


def test_lists_feats_under_custom_camus_home():
    home = tempfile.mkdtemp(prefix="camus_fs_")
    os.makedirs(os.path.join(home, "feats"))
    with open(os.path.join(home, "feats", "my-feat-aaa.json"), "w") as fh:
        json.dump({"feat": "My Feat", "status": "running"}, fh)
    feats = json.loads(_run(home))["feats"]
    assert any(f["featId"] == "my-feat-aaa" and f["title"] == "My Feat"
               and f["status"] == "running" for f in feats), feats


def test_camus_home_is_the_home_not_its_parent():
    # the bug: .camus nested UNDER CAMUS_HOME. State at $HOME/feats must be found; $HOME/.camus/feats must NOT.
    home = tempfile.mkdtemp(prefix="camus_fs_")
    os.makedirs(os.path.join(home, "feats"))
    with open(os.path.join(home, "feats", "real-bbb.json"), "w") as fh:
        json.dump({"feat": "Real", "status": "running"}, fh)
    os.makedirs(os.path.join(home, ".camus", "feats"))
    with open(os.path.join(home, ".camus", "feats", "ghost-ccc.json"), "w") as fh:
        json.dump({"feat": "Ghost", "status": "running"}, fh)
    ids = [f["featId"] for f in json.loads(_run(home))["feats"]]
    assert "real-bbb" in ids and "ghost-ccc" not in ids, ids


def test_no_feats_dir_empty_list():
    assert json.loads(_run(tempfile.mkdtemp(prefix="camus_fs_")))["feats"] == []


def test_corrupt_state_file_degrades_to_null_fields():
    home = tempfile.mkdtemp(prefix="camus_fs_")
    os.makedirs(os.path.join(home, "feats"))
    with open(os.path.join(home, "feats", "broken-ddd.json"), "w") as fh:
        fh.write("{not json")
    f = [x for x in json.loads(_run(home))["feats"] if x["featId"] == "broken-ddd"][0]
    assert f["title"] is None and f["status"] is None, f


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
