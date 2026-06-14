"""Tests for steer_read.py (steer-note sentinel READ + separate CONSUME).

Read/consume SPLIT (live re-soak 2026-06-14, finding A): the plain read is NON-DESTRUCTIVE so a
transient thin-runner relay flake can be retried safely — a re-read finds the SAME un-consumed
note, no loss. The workflow deletes (--consume) only after it has a confirmed, parsed note in hand.

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


def _run(home, feat_id, *extra):
    return subprocess.run(
        [sys.executable, os.path.join(HERE, "steer_read.py"), feat_id, *extra],
        capture_output=True, text=True,
        env={**os.environ, "CAMUS_HOME": home},
    ).stdout


def _seed(home, feat_id, body):
    os.makedirs(os.path.join(home, "steer"), exist_ok=True)
    path = os.path.join(home, "steer", feat_id + ".json")
    with open(path, "w") as fh:
        fh.write(body)
    return path


def test_no_note_reads_null():
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "f1"))
    assert out == {"read": True, "note": None}, out


def test_read_is_nondestructive():
    # The FIX: a read must NOT consume — repeated reads return the same note, so a relay flake
    # (re-run of the read) re-reads the same note rather than losing it.
    home = tempfile.mkdtemp(prefix="camus_sr_")
    path = _seed(home, "f1", '{"pause":true}')
    first = json.loads(_run(home, "f1"))
    assert first == {"read": True, "note": '{"pause":true}'}, first
    assert os.path.exists(path), "read must NOT delete the note (retry safety)"
    second = json.loads(_run(home, "f1"))
    assert second == {"read": True, "note": '{"pause":true}'}, "re-read sees the same un-consumed note"


def test_consume_deletes_note():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    path = _seed(home, "f1", '{"pause":true}')
    out = json.loads(_run(home, "f1", "--consume"))
    assert out == {"consumed": True}, out
    assert not os.path.exists(path), "--consume must delete the note"
    assert json.loads(_run(home, "f1")) == {"read": True, "note": None}, "after consume the read sees no note"


def test_consume_is_idempotent():
    # Consuming a missing note succeeds (idempotent) — a retried consume must not error.
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "f1", "--consume"))
    assert out == {"consumed": True}, out


def test_camus_home_is_the_home_not_its_parent():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    _seed(home, "f2", '{"guidance":"x"}')
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
