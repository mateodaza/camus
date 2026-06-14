"""Tests for steer_read.py (steer-note sentinel read + consume).

CAMUS_HOME IS the camus home itself (default ~/.camus) — same convention as reconcile.py/land.py;
the verification audit (2026-06-13) caught the original nesting .camus UNDER it, which silently
missed pending steer notes under a custom home.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _run(home, feat_id):
    return subprocess.run(
        [sys.executable, os.path.join(HERE, "steer_read.py"), feat_id],
        capture_output=True, text=True,
        env={**os.environ, "CAMUS_HOME": home},
    ).stdout


def test_no_note_reads_null():
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "f1"))
    assert out == {"read": True, "note": None}, out


def test_present_note_read_then_consumed():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    os.makedirs(os.path.join(home, "steer"))
    path = os.path.join(home, "steer", "f1.json")
    with open(path, "w") as fh:
        fh.write('{"pause":true}')
    first = json.loads(_run(home, "f1"))
    assert first["read"] is True and first["note"] == '{"pause":true}', first
    assert not os.path.exists(path), "a successfully-read note must be consumed"
    assert json.loads(_run(home, "f1")) == {"read": True, "note": None}, "second read sees no note"


def test_camus_home_is_the_home_not_its_parent():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    os.makedirs(os.path.join(home, "steer"))
    with open(os.path.join(home, "steer", "f2.json"), "w") as fh:
        fh.write('{"guidance":"x"}')
    assert json.loads(_run(home, "f2"))["note"] == '{"guidance":"x"}'  # $HOME/steer, not $HOME/.camus/steer


def test_featid_basename_neutralizes_traversal():
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "../../etc/passwd"))
    assert out["read"] is True and out["note"] is None, out


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
