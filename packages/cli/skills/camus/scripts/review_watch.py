#!/usr/bin/env python3
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
        if not _alive(pid):
            return
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return
        deadline = time.time() + grace
        while time.time() < deadline and _alive(pid):
            time.sleep(0.1)


def cmd_start(args):
    handle = args.handle
    os.makedirs(handle, exist_ok=True)
    p = _paths(handle)
    # Wrapper writes the real command's exit code where a non-child awaiter can read it.
    script = "%s; echo $? > %s" % (shlex.join(args.cmd), shlex.quote(p["exit"]))
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
    deadline = time.time() + max(1, args.chunk)
    while True:
        # COMPLETION FILE FIRST (audit P2 2026-06-11): a written exit code IS done, no matter
        # what signal-0 says about the recorded pid — liveness only decides among the
        # still-unfinished states below.
        code = _exit_code_read(args.handle)
        if code is not None:
            return _emit({"state": "done", "exit": code,
                          "usage": _usage(args.handle), "last": rec.get("last")})
        if not _alive(pid):
            return _emit({"state": "done", "exit": _exit_code(args.handle),
                          "usage": _usage(args.handle), "last": rec.get("last")})
        age = _event_age(args.handle, started_at)
        if age > args.idle:
            _kill_group(pid)
            return _emit({"state": "idle_killed", "idle_s": int(age)})
        if time.time() >= deadline:
            return _emit({"state": "pending", "pid": pid, "last_event_age": int(age)})
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
                      "usage": _usage(args.handle), "last": rec.get("last")})
    if rec and isinstance(rec.get("pid"), int) and _alive(rec["pid"]):
        _kill_group(rec["pid"])
    return _emit({"state": "aborted"})


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
