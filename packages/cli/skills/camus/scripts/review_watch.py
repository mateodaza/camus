#!/usr/bin/env python3
# CAMUS_CONTROL: cli.review.watchdog_custody
"""Detached runner + event-idle watchdog for the Codex review (watchdog reviewer, 2026-06-11).

Why: `codex exec` has NO deadline flag, and a single Bash tool call caps out at ~10 minutes —
an xhigh review can legitimately outlive BOTH (docs/HARNESS-DIRECTION.md, friction batch §3).
So codex runs DETACHED, and the caller re-attaches in bounded `await` chunks: total review time
is unbounded while every individual agent call stays small. Liveness is judged on the EVENT
STREAM, not wall clock — codex is launched with `--json`, so a review that keeps emitting
events is alive no matter how long it thinks, and one that goes silent past the idle window is
dead and gets killed (codex's own stream-idle timeout + retries sit at ~5 min; our default 360s
of TOTAL silence means those retries already failed). Probed live 2026-06-11 on codex 0.137.0:
`--json` + `--output-schema` + `-o` compose — events on stdout, the schema-conformant verdict
in the `-o` file, `turn.completed` carrying real token usage.

Subcommands (each prints ONE JSON envelope on stdout; codex_review.sh interprets it):
  start --handle DIR --last PATH -- CMD...
        Spawn CMD detached (stdout→DIR/events.jsonl, stderr→DIR/err.log, stdin /dev/null,
        own session). Envelope: {"state":"started","pid":N}
  await --handle DIR [--chunk S] [--idle S]
        Poll until the process EXITS → {"state":"done","exit":N,"usage":{...}|null,"last":PATH};
        the event stream goes idle past --idle → kill the process group →
        {"state":"idle_killed","idle_s":N}; or --chunk elapses with a live, talking process →
        {"state":"pending","pid":N,"last_event_age":N}. Call await again to re-attach.
  abort --handle DIR
        Kill outright (the caller's watch budget ran out) → {"state":"aborted"}

The exit code travels via a wrapper (`CMD; echo $? > exit_code`): a later `await` is NOT the
spawner's child, so waitpid() is unavailable — the file is the only honest channel. Kills go to
the process GROUP (start_new_session) so codex's own children die with it; a kill is only ever
attempted while the recorded pid still answers signal 0, which bounds the pid-reuse window to
the life of one review round.
"""
import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time


def _paths(handle):
    return {
        "handle": os.path.join(handle, "handle.json"),
        "events": os.path.join(handle, "events.jsonl"),
        "err": os.path.join(handle, "err.log"),
        "exit": os.path.join(handle, "exit_code"),
    }


def _emit(obj):
    print(json.dumps(obj))
    return 0


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _proc_start_epoch(pid):
    """Epoch seconds when `pid` started, or None when it cannot be read."""
    try:
        out = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not out:
        return None
    for fmt in ("%a %b %d %H:%M:%S %Y", "%a %d %b %H:%M:%S %Y"):
        try:
            return time.mktime(time.strptime(out, fmt))
        except ValueError:
            continue
    return None


def _is_ours(pid, started_at, skew=15):
    """Is the LIVE pid still the process this handle recorded?

    `_alive` only proves SOMETHING answers to that number. After our reviewer
    exits the OS is free to hand the same pid to an unrelated process, and
    waiting on — or signalling — that stranger is exactly the recycled-pid
    hazard. handle.json records when we started the process, so a live pid whose
    real start time does not sit within `skew` seconds of that is NOT ours.
    Unreadable start time is treated as NOT ours: refusing to act on an
    unverifiable pid is the safe direction (the caller reports instead).
    """
    if not isinstance(pid, int) or pid <= 0 or not _alive(pid):
        return False
    if not isinstance(started_at, (int, float)) or started_at <= 0:
        return False
    actual = _proc_start_epoch(pid)
    if actual is None:
        time.sleep(0.2)               # one retry: a transient ps failure is not identity evidence
        actual = _proc_start_epoch(pid)
    if actual is None:
        return False
    return abs(actual - float(started_at)) <= skew


def _group_members(pgid):
    """PIDs currently in `pgid` (empty when none / ps unusable)."""
    try:
        out = subprocess.run(["ps", "-g", str(pgid), "-o", "pid="],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in (out or "").split("\n"):
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def _group_alive(pgid):
    """Is ANY member of the process group still running?

    The reviewer is started with start_new_session, so its pid IS the group id and
    codex's own children live in that group. Checking only the leader declared the
    reviewer dead while its children kept running, so a leader that exits first
    left the group alive and unkilled (field report 2026-08-05).
    """
    if not isinstance(pgid, int) or pgid <= 0:
        return False
    if _group_members(pgid):
        return True
    return _alive(pgid)  # ps unusable → the leader is all we can see


def _group_is_ours(pgid, started_at, skew=15):
    """Is this group still the reviewer group this handle recorded?

    While the LEADER is alive, its own start time is the ONLY identity
    authority: a live pid==pgid whose start mismatches the handle is a RECYCLED
    pid, and every member of its group is the stranger's child — member start
    times prove nothing there. Members are consulted only once the leader is
    dead, where POSIX keeps the pid reserved while any member still holds the
    pgid, so survivors can only be remnants of OUR group (the start-time check
    on them is a sanity bound, not the discriminator).
    """
    if not isinstance(started_at, (int, float)) or started_at <= 0:
        return False
    if _alive(pgid):
        return _is_ours(pgid, started_at, skew)
    for pid in _group_members(pgid):
        actual = _proc_start_epoch(pid)
        if actual is not None and actual >= float(started_at) - skew:
            return True
    return False


def _read_handle(handle):
    try:
        with open(_paths(handle)["handle"], encoding="utf-8") as fh:
            obj = json.load(fh)
        return obj if isinstance(obj, dict) else None
    except (OSError, ValueError):
        return None


def _event_age(handle, started_at, now=None):
    """Seconds since the event stream last moved (events.jsonl mtime; falls back to start)."""
    now = now if now is not None else time.time()
    try:
        return max(0.0, now - os.path.getmtime(_paths(handle)["events"]))
    except OSError:
        return max(0.0, now - started_at)


def _usage(handle):
    """Last turn.completed usage from the event stream — the honest codex-side token count."""
    usage = None
    try:
        with open(_paths(handle)["events"], encoding="utf-8") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("type") == "turn.completed" and isinstance(e.get("usage"), dict):
                    usage = e["usage"]
    except OSError:
        pass
    return usage


def _thread_id(handle):
    """The codex session id from the FIRST {"type":"thread.started","thread_id":...} event, or
    None when absent/unreadable. The resume key (codex-resume-recovery 2026-06-12): an
    idle-killed/aborted review owns a live codex thread, and `codex exec resume <thread_id>` can
    finish it instead of re-paying a fresh review. events.jsonl is empty at spawn, so this is read
    LAZILY here, never persisted at cmd_start — mirrors _usage's defensive per-line parse; first
    valid event wins. Carried in the await/abort envelopes so codex_review.sh (which owns
    meta.json; this module only ever writes handle.json) can persist and act on it."""
    try:
        with open(_paths(handle)["events"], encoding="utf-8") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("type") == "thread.started":
                    tid = e.get("thread_id")
                    if isinstance(tid, str) and tid:
                        return tid
    except OSError:
        pass
    return None


def _exit_code_read(handle):
    """The wrapper's exit-code file, or None while it hasn't been written. The FILE is the
    completion channel (audit P2 2026-06-11): pid liveness must never outrank it — a lingering
    wrapper shell, a zombie, or a RECYCLED pid would otherwise turn a finished review into
    pending/idle_killed (and, worse, aim a kill at whatever innocent process now owns the pid)."""
    try:
        with open(_paths(handle)["exit"], encoding="utf-8") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return None


def _exit_code(handle):
    code = _exit_code_read(handle)
    # None = the wrapper never wrote an exit code (killed, or the spawn itself died) — infra,
    # not a verdict; adapter.py turns a nonzero exit + empty output into ran:false downstream.
    return 1 if code is None else code


def _kill_group(pid):
    """SIGTERM the process group, grace, then SIGKILL. Best-effort — the caller re-checks."""
    for sig, grace in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 2.0)):
        # Gate on the GROUP: a leader that already exited must not stop us from
        # killing the children still running in its group.
        if not _group_alive(pid):
            return
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return
        deadline = time.time() + grace
        while time.time() < deadline and _group_alive(pid):
            time.sleep(0.1)


def cmd_start(args):
    handle = args.handle
    os.makedirs(handle, exist_ok=True)
    p = _paths(handle)
    # Wrapper writes the real command's exit code where a non-child awaiter can read it.
    # shlex.join is Python 3.8+; this equivalent (its exact implementation) keeps the gate's floor at 3.6
    # so the first review round doesn't AttributeError on older system/CI Python (RHEL8/Debian10/Ubuntu18.04).
    script = "%s; echo $? > %s" % (" ".join(shlex.quote(c) for c in args.cmd), shlex.quote(p["exit"]))
    try:
        with open(p["events"], "wb") as out, open(p["err"], "wb") as err:
            proc = subprocess.Popen(
                ["sh", "-c", script],
                stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                start_new_session=True, cwd=os.getcwd(),
            )
    except OSError as exc:
        return _emit({"state": "error", "error": "spawn failed: %s" % exc})
    rec = {"pid": proc.pid, "started_at": int(time.time()), "cmd": args.cmd,
           "cwd": os.getcwd(), "last": args.last}
    with open(p["handle"], "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)
    return _emit({"state": "started", "pid": proc.pid})


def cmd_await(args):
    rec = _read_handle(args.handle)
    if not rec or not isinstance(rec.get("pid"), int):
        return _emit({"state": "error", "error": "no usable handle.json under %s" % args.handle})
    pid, started_at = rec["pid"], rec.get("started_at", 0)
    # IDENTITY ONCE, at entry: _alive proves something answers to the number, not
    # that it is still OUR reviewer (a recycled pid is a stranger we must neither
    # wait on nor signal). Verified here; the loop then only needs liveness,
    # because a continuously-alive pid cannot change identity mid-loop.
    pid_is_ours = _is_ours(pid, started_at)
    deadline = time.time() + max(1, args.chunk)
    while True:
        # COMPLETION FILE FIRST (audit P2 2026-06-11): a written exit code IS done, no matter
        # what signal-0 says about the recorded pid — liveness only decides among the
        # still-unfinished states below.
        code = _exit_code_read(args.handle)
        if code is not None:
            return _emit({"state": "done", "exit": code,
                          "usage": _usage(args.handle), "last": rec.get("last"),
                          "thread_id": _thread_id(args.handle)})
        if not _alive(pid):
            # Leader gone without completion evidence. A VERIFIED surviving
            # group is OURS to terminate before reporting infra — an await that
            # walks away from live children is how orphans are made (field
            # report 2026-08-05). An unverifiable group is never signalled and
            # says so explicitly.
            if _group_alive(pid):
                if _group_is_ours(pid, started_at):
                    _kill_group(pid)
                    return _emit({"state": "error",
                                  "error": "reviewer leader exited without a verdict; its surviving process group was terminated",
                                  "thread_id": _thread_id(args.handle)})
                return _emit({"state": "error", "unverified_pid": True,
                              "error": "a process group answers to the recorded pgid but cannot be verified as this review; nothing was signalled"})
            return _emit({"state": "done", "exit": _exit_code(args.handle),
                          "usage": _usage(args.handle), "last": rec.get("last"),
                          "thread_id": _thread_id(args.handle)})
        if not pid_is_ours:
            # Alive but not ours: a recycled pid wearing our number. Waiting on
            # it would hang the round on a stranger; signalling it could kill
            # one. Explicit unverified infra, nothing touched.
            return _emit({"state": "error", "unverified_pid": True,
                          "error": "the recorded pid is alive but is not the process this handle started (recycled pid); nothing was signalled"})
        age = _event_age(args.handle, started_at)
        if age > args.idle:
            _kill_group(pid)
            return _emit({"state": "idle_killed", "idle_s": int(age),
                          "thread_id": _thread_id(args.handle)})
        if time.time() >= deadline:
            return _emit({"state": "pending", "pid": pid, "last_event_age": int(age),
                          "thread_id": _thread_id(args.handle)})
        time.sleep(min(1.0, max(0.05, deadline - time.time())))


def cmd_abort(args):
    rec = _read_handle(args.handle)
    # Finished-while-we-decided-to-abort (audit P2 2026-06-11): a written exit code means the
    # work is DONE — return the verdict instead of killing. This is both a free verdict and the
    # pid-reuse safety: never aim a group kill at a pid whose recorded work already completed
    # (the live process answering signal 0 may be an innocent stranger by now).
    code = _exit_code_read(args.handle) if rec else None
    if code is not None:
        return _emit({"state": "done", "exit": code,
                      "usage": _usage(args.handle), "last": rec.get("last"),
                      "thread_id": _thread_id(args.handle)})
    unverified_survivor = False
    if rec and isinstance(rec.get("pid"), int) and _group_alive(rec["pid"]):
        if _group_is_ours(rec["pid"], rec.get("started_at", 0)):
            _kill_group(rec["pid"])
        else:
            # Alive, but not provably the reviewer this handle recorded: a
            # recycled pid/pgid. Killing it could take down a stranger, so it is
            # left alone and REPORTED — the caller must not read this as clean.
            unverified_survivor = True
    # The abort verdict is the one codex_review.sh records as the round's outcome, so it MUST
    # carry the thread_id — that handle is what lets the NEXT round resume this killed thread
    # instead of paying for a fresh review (codex-resume-recovery 2026-06-12).
    out = {"state": "aborted", "thread_id": _thread_id(args.handle)}
    if unverified_survivor:
        out["unverified_pid"] = True
    return _emit(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Detached runner + event-idle watchdog")
    sub = ap.add_subparsers(dest="sub", required=True)
    s = sub.add_parser("start")
    s.add_argument("--handle", required=True)
    s.add_argument("--last", required=True)
    s.add_argument("cmd", nargs="+")
    a = sub.add_parser("await")
    a.add_argument("--handle", required=True)
    a.add_argument("--chunk", type=int, default=300)
    a.add_argument("--idle", type=int, default=360)
    k = sub.add_parser("abort")
    k.add_argument("--handle", required=True)
    args = ap.parse_args(argv)
    return {"start": cmd_start, "await": cmd_await, "abort": cmd_abort}[args.sub](args)


if __name__ == "__main__":
    sys.exit(main())
