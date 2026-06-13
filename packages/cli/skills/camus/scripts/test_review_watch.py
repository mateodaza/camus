"""Contract tests for review_watch.py (detached runner + event-idle watchdog).

    python3 test_review_watch.py     # stdlib runner (bottom)
    python3 -m pytest -q

Real (tiny, fast) processes — the watchdog's whole job is process lifecycle, so faking the
process would test nothing. Every command is sh + sleep; no codex, no network.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RW = os.path.join(HERE, "review_watch.py")


def _run(*argv):
    r = subprocess.run([sys.executable, RW, *argv], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout), r.returncode
    except ValueError:
        raise AssertionError("non-JSON envelope: %r (stderr=%r)" % (r.stdout, r.stderr))


def _start(handle, cmd):
    env, rc = _run("start", "--handle", handle, "--last", os.path.join(handle, "last.txt"), "--", *cmd)
    assert rc == 0 and env["state"] == "started" and isinstance(env["pid"], int), env
    return env["pid"]


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_fast_command_completes_with_exit_and_usage():
    # The common case: codex finishes inside the first chunk. The wrapper's exit-code file and
    # the turn.completed usage from the event stream both surface in the done envelope.
    with tempfile.TemporaryDirectory() as h:
        _start(h, ["sh", "-c",
                   'echo \'{"type":"turn.completed","usage":{"output_tokens":7}}\'; exit 0'])
        env, _ = _run("await", "--handle", h, "--chunk", "10", "--idle", "60")
        assert env["state"] == "done", env
        assert env["exit"] == 0
        assert env["usage"] == {"output_tokens": 7}


def test_nonzero_exit_travels_through_the_wrapper():
    # A later `await` is not the spawner's child — waitpid is unavailable, the file is the
    # only honest exit channel. adapter.py downstream turns nonzero+empty into ran:false.
    with tempfile.TemporaryDirectory() as h:
        _start(h, ["sh", "-c", "exit 3"])
        env, _ = _run("await", "--handle", h, "--chunk", "10", "--idle", "60")
        assert env["state"] == "done" and env["exit"] == 3, env


def test_live_talking_process_goes_pending():
    # Chunk elapses while the process is alive AND recently emitted an event → pending, never
    # killed: a slow-but-talking review is healthy, wall clock is not the liveness signal.
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sh", "-c", "echo event; sleep 30"])
        env, _ = _run("await", "--handle", h, "--chunk", "1", "--idle", "60")
        assert env["state"] == "pending", env
        assert _alive(pid)
        _run("abort", "--handle", h)   # cleanup
        assert not _alive(pid)


def test_silent_process_is_idle_killed():
    # No events past --idle → the process GROUP is killed and the envelope says so. (The events
    # file age falls back to started_at when the command never wrote a byte.)
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sleep", "60"])
        env, _ = _run("await", "--handle", h, "--chunk", "30", "--idle", "1")
        assert env["state"] == "idle_killed", env
        assert env["idle_s"] >= 1
        assert not _alive(pid)


def test_abort_kills_outright():
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sleep", "60"])
        assert _alive(pid)
        env, _ = _run("abort", "--handle", h)
        assert env["state"] == "aborted"
        time.sleep(0.2)
        assert not _alive(pid)


def test_exit_file_outranks_a_lingering_pid():
    # Audit P2 2026-06-11: the wrapper's exit-code file IS the completion channel. A lingering
    # shell, a zombie, or a RECYCLED pid must never turn a finished review into pending — write
    # the exit file while the recorded pid is provably alive and await must say done.
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sh", "-c", "echo started; sleep 60"])
        assert _alive(pid)
        with open(os.path.join(h, "exit_code"), "w", encoding="utf-8") as fh:
            fh.write("0\n")
        env, _ = _run("await", "--handle", h, "--chunk", "1", "--idle", "60")
        assert env["state"] == "done" and env["exit"] == 0, env
        os.killpg(pid, 15)   # cleanup the stand-in "lingering" process ourselves


def test_abort_returns_done_instead_of_killing_a_finished_review():
    # Same channel, abort side: never aim a group kill at a pid whose recorded work already
    # completed (pid reuse would make the target an innocent stranger) — and the verdict is
    # free, so return it.
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sh", "-c", "echo started; sleep 60"])
        with open(os.path.join(h, "exit_code"), "w", encoding="utf-8") as fh:
            fh.write("0\n")
        env, _ = _run("abort", "--handle", h)
        assert env["state"] == "done" and env["exit"] == 0, env
        assert _alive(pid)                     # the (possibly innocent) pid was NOT killed
        os.killpg(pid, 15)                     # cleanup


def test_await_without_a_handle_is_an_error_envelope():
    with tempfile.TemporaryDirectory() as h:
        env, _ = _run("await", "--handle", os.path.join(h, "nope"), "--chunk", "1", "--idle", "1")
        assert env["state"] == "error" and "handle" in env["error"], env


# --- thread_id capture (codex-resume-recovery 2026-06-12) -------------------
# codex emits {"type":"thread.started","thread_id":<uuid>} first; review_watch parses it lazily
# from events.jsonl and CARRIES it in its envelopes so codex_review.sh can resume a killed thread
# instead of re-paying a fresh review. The envelope is the only channel (review_watch never writes
# meta.json), so done/idle_killed/abort must all carry the id when the event was emitted.

def test_done_envelope_carries_the_thread_id():
    with tempfile.TemporaryDirectory() as h:
        _start(h, ["sh", "-c",
                   'echo \'{"type":"thread.started","thread_id":"sess-abc-123"}\';'
                   ' echo \'{"type":"turn.completed","usage":{"output_tokens":7}}\'; exit 0'])
        env, _ = _run("await", "--handle", h, "--chunk", "10", "--idle", "60")
        assert env["state"] == "done", env
        assert env["thread_id"] == "sess-abc-123", env


def test_thread_id_is_none_when_no_thread_started_event():
    # A review that never announced a session id → thread_id is None (absent the event), so the
    # resume path has nothing to act on and codex_review.sh stays on the fresh-review path.
    with tempfile.TemporaryDirectory() as h:
        _start(h, ["sh", "-c",
                   'echo \'{"type":"turn.completed","usage":{"output_tokens":7}}\'; exit 0'])
        env, _ = _run("await", "--handle", h, "--chunk", "10", "--idle", "60")
        assert env["state"] == "done", env
        assert env.get("thread_id") is None, env


def test_idle_killed_envelope_carries_the_thread_id():
    # The thread that gets killed is exactly the one worth resuming — idle_killed must carry its id.
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sh", "-c",
                         'echo \'{"type":"thread.started","thread_id":"sess-idle-9"}\'; sleep 60'])
        env, _ = _run("await", "--handle", h, "--chunk", "30", "--idle", "1")
        assert env["state"] == "idle_killed", env
        assert env["thread_id"] == "sess-idle-9", env
        assert not _alive(pid)


def test_abort_carries_the_thread_id():
    # abort is the verdict codex_review.sh records as the round outcome, so it MUST carry the id
    # (that handle is what the NEXT round resumes). Abort AFTER a thread.started event was written.
    with tempfile.TemporaryDirectory() as h:
        pid = _start(h, ["sh", "-c",
                         'echo \'{"type":"thread.started","thread_id":"sess-killme"}\'; sleep 60'])
        # let the event land before we abort (events.jsonl is the only thread_id source)
        for _ in range(50):
            ev = os.path.join(h, "events.jsonl")
            if os.path.exists(ev) and os.path.getsize(ev) > 0:
                break
            time.sleep(0.05)
        env, _ = _run("abort", "--handle", h)
        assert env["state"] == "aborted", env
        assert env["thread_id"] == "sess-killme", env
        time.sleep(0.2)
        assert not _alive(pid)


# --- stdlib runner (no pytest required) ------------------------------------

if __name__ == "__main__":
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
