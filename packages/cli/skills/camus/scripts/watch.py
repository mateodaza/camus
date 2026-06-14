#!/usr/bin/env python3
"""Live terminal dashboard for a Camus feat run — `camus watch [featId]`.

The interactive sibling of status.py: same synthesis (state file + review audits + steer
note), redrawn every --interval seconds on the terminal's alternate screen, with one-key
steering that goes through the SAME audited write path as `camus steer` (steer.py — all
of its rules apply: writes need a RUNNING feat). Steering is EXPERIMENTAL and opt-in
(descoped from 0.2.7): a note is consumed at a task boundary ONLY if the feat was started
with steering enabled; a default run will not consume it. The race-free redesign lands in 0.3.

  q  quit                       p  pause at the next task boundary (if steering enabled)
  g  steer the next task        c  clear the pending note
  r  clear feedback / redraw

Read-only except for the explicit p/g/c actions; token-free; works from any terminal.
Needs a real TTY — when stdin/stdout is piped (or termios is unavailable, e.g. Windows),
it degrades to a one-shot `camus status` print so output is never garbled.
"""
import argparse
import os
import select
import sys
import time

import status as S
import steer as ST

FOOTER = "[q] quit · [p] pause at next task · [g] steer next task · [c] clear note · [r] refresh"


def frame(base, feat_id, feedback="", now=None):
    """One full screen as a list of lines: the status dashboard + key hints + feedback."""
    synth = S.synthesize(base, feat_id, now=now)
    if synth is None:
        body = ["no feat state found under %s (has a run started?)" % os.path.join(base, "feats")]
    elif "state" not in synth:
        body = ["feat state file exists but is not valid JSON (mid-write race?) — retrying…"]
    else:
        body = S.render(synth, now=now)
        # Hygiene (2026-06-11, HARNESS-DIRECTION): a user ran watch from $HOME and the live-agents
        # section silently vanished — the transcript lookup is keyed on the CWD's repo, so the
        # wrong directory reads as "no agents at all". Say so, dimly, instead of staying silent.
        # ANSI dim is safe here: frame() only feeds the TTY loop (piped invocations fall back to
        # the one-shot status print in main() before frame is ever called).
        if not synth.get("live"):
            body += ["", "\x1b[2mlive agents: none visible from this directory — "
                         "run watch from the target repo's root\x1b[0m"]
    lines = list(body) + ["", FOOTER]
    if feedback:
        lines.append("» " + feedback)
    return lines


def dispatch(key, base, feat_id, prompt=input):
    """Map a steering keypress to its action; returns the feedback line ('' = no-op key).
    Pure logic over steer.py's audited helpers — the IO loop stays thin and untested."""
    # A stranded `.consuming` claim (a crashed consume) is anomalous PENDING state — every steer
    # consumer must agree (re-soak 2026-06-14, finding P2). Writes refuse over it; clear removes it too.
    if key == "p":
        fid, err = ST.resolve_feat(base, feat_id)
        if err:
            return "pause refused: " + err
        if ST.claim_present(base, fid):
            return "pause refused: a stranded steer claim is present — clear it (c) or re-run the feat to recover it"
        # MERGED write (audit P1 2026-06-11): raw write_note here clobbered a pending note, so
        # an interactive pause erased queued answers/guidance the CLI had carefully composed.
        path, warn = ST.write_note_merged(base, fid, {"pause": True})
        if path is None:   # authoritative backstop: a claim raced the write (P2 round 6)
            return "pause refused: " + warn
        return ("pause note written — halts at the next task boundary ONLY if this feat runs with "
                "steering enabled (experimental/opt-in)" + ("; WARNING: " + warn if warn else ""))
    if key == "g":
        fid, err = ST.resolve_feat(base, feat_id)
        if err:
            return "steer refused: " + err
        if ST.claim_present(base, fid):
            return "steer refused: a stranded steer claim is present — clear it (c) or re-run the feat to recover it"
        text = prompt("guidance for the next task: ").strip()
        if not text:
            return "empty guidance — nothing written"
        # A claim can appear DURING the prompt above — the early check can't catch that, so the write
        # primitive is the authoritative guard (P2 round 6): write_note_merged returns (None, msg) then.
        path, warn = ST.write_note_merged(base, fid, {"guidance": text})
        if path is None:
            return "steer refused: " + warn
        return ("guidance note written — applies at the next task boundary ONLY if this feat runs with "
                "steering enabled (experimental/opt-in)" + ("; WARNING: " + warn if warn else ""))
    if key == "c":
        fid, err = ST.resolve_feat(base, feat_id, require_running=False)
        if err:
            return "clear refused: " + err
        removed, cerr = ST.clear_notes(base, fid)
        if cerr:
            return "could NOT clear — " + cerr
        return ("cleared steer " + " + ".join(removed)) if removed else "no pending steer note"
    return ""


def watch(base, feat_id, interval):
    """The IO loop: alternate screen, cbreak keys, redraw on a select() timeout."""
    import termios
    import tty
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    out = sys.stdout
    out.write("\x1b[?1049h\x1b[?25l")          # alternate screen, hide cursor
    feedback = ""
    try:
        tty.setcbreak(fd)
        while True:
            out.write("\x1b[2J\x1b[H" + "\n".join(frame(base, feat_id, feedback)) + "\n")
            out.flush()
            ready, _, _ = select.select([fd], [], [], interval)
            if not ready:
                continue                        # timeout → redraw with fresh state
            key = os.read(fd, 1).decode(errors="ignore")
            if key == "q":
                return 0
            if key == "r":
                feedback = ""
            elif key == "g":
                # cooked mode + visible cursor for the one-line guidance prompt
                termios.tcsetattr(fd, termios.TCSADRAIN, saved)
                out.write("\x1b[?25h\n")
                out.flush()
                try:
                    feedback = dispatch("g", base, feat_id)
                except (EOFError, KeyboardInterrupt):
                    feedback = "steer cancelled"
                finally:
                    tty.setcbreak(fd)
                    out.write("\x1b[?25l")
            elif key in ("p", "c"):
                feedback = dispatch(key, base, feat_id)
    except KeyboardInterrupt:
        return 0
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        out.write("\x1b[?25h\x1b[?1049l")
        out.flush()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Camus live feat dashboard (interactive)")
    ap.add_argument("featId", nargs="?", default=None)
    ap.add_argument("--interval", type=float, default=2.0, help="redraw seconds (default 2)")
    ap.add_argument("--dir", default=S.default_base(), help="camus home (default ~/.camus)")
    args = ap.parse_args(argv)

    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    if interactive:
        try:
            import termios  # noqa: F401 — unavailable on Windows
        except ImportError:
            interactive = False
    if not interactive:
        print("camus watch needs an interactive terminal — printing one-shot status instead.",
              file=sys.stderr)
        return S.main(([args.featId] if args.featId else []) + ["--dir", args.dir])

    return watch(args.dir, args.featId, max(0.5, args.interval)) or 0


if __name__ == "__main__":
    sys.exit(main())
