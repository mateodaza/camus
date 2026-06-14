"""Tests for steer_read.py (steer-note sentinel READ + SHA-GATED CONSUME).

Read/consume SPLIT (re-soak 2026-06-14, finding A): the plain read is NON-DESTRUCTIVE so a transient
thin-runner relay flake can be retried safely — a re-read finds the SAME un-consumed note, no loss.

SHA-GATED consume (re-soak 2026-06-14, finding P2): the read and consume are two steps; a human can
run `camus steer` in between. A blind delete would apply the OLD note and silently delete the NEW one.
So --consume requires --expect-sha and deletes ONLY when the file's current bytes still hash to it.

CAMUS_HOME IS the camus home itself (default ~/.camus) — same convention as reconcile.py/land.py.
"""
import hashlib
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


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _seed(home, feat_id, body):
    os.makedirs(os.path.join(home, "steer"), exist_ok=True)
    path = os.path.join(home, "steer", feat_id + ".json")
    with open(path, "w") as fh:
        fh.write(body)
    return path


def test_no_note_reads_null_with_null_sha():
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "f1"))
    assert out == {"read": True, "note": None, "sha": None}, out


def test_read_is_nondestructive_and_returns_sha():
    # The FIX (A): a read must NOT consume — repeated reads return the same note + sha, so a relay
    # flake (re-run of the read) re-reads the same note rather than losing it.
    home = tempfile.mkdtemp(prefix="camus_sr_")
    body = '{"pause":true}'
    path = _seed(home, "f1", body)
    first = json.loads(_run(home, "f1"))
    assert first == {"read": True, "note": body, "sha": _sha(body)}, first
    assert os.path.exists(path), "read must NOT delete the note (retry safety)"
    second = json.loads(_run(home, "f1"))
    assert second == first, "re-read sees the same un-consumed note + sha"


def test_consume_requires_expect_sha():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    _seed(home, "f1", '{"pause":true}')
    out = json.loads(_run(home, "f1", "--consume"))   # no --expect-sha
    assert out.get("consumed") is False and "error" in out, out


def test_consume_with_matching_sha_deletes():
    home = tempfile.mkdtemp(prefix="camus_sr_")
    body = '{"pause":true}'
    path = _seed(home, "f1", body)
    out = json.loads(_run(home, "f1", "--consume", "--expect-sha", _sha(body)))
    assert out == {"consumed": True}, out
    assert not os.path.exists(path), "a matching-sha consume deletes the note"
    assert json.loads(_run(home, "f1")) == {"read": True, "note": None, "sha": None}


def test_consume_with_stale_sha_preserves_newer_note():
    # The FIX (P2), exactly the race Mateo reproduced: read `old` (sha_old), the file is overwritten
    # with `new`, then consume --expect-sha sha_old. The NEWER note must SURVIVE (not be deleted).
    home = tempfile.mkdtemp(prefix="camus_sr_")
    old, new = '{"guidance":"old"}', '{"guidance":"new"}'
    path = _seed(home, "f1", old)
    sha_old = json.loads(_run(home, "f1"))["sha"]
    with open(path, "w") as fh:   # human re-steers between read and consume
        fh.write(new)
    out = json.loads(_run(home, "f1", "--consume", "--expect-sha", sha_old))
    assert out.get("consumed") is False and out.get("reason") == "changed", out
    assert os.path.exists(path), "the newer note must NOT be deleted"
    with open(path) as fh:
        assert fh.read() == new, "the newer note's bytes survive intact"
    # a re-read now sees the NEW note (so the workflow applies it, not the stale one)
    assert json.loads(_run(home, "f1"))["note"] == new


def test_consume_absent_is_idempotent():
    out = json.loads(_run(tempfile.mkdtemp(prefix="camus_sr_"), "f1", "--consume", "--expect-sha", _sha("x")))
    assert out == {"consumed": False, "reason": "absent"}, out


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
