#!/usr/bin/env python3
"""Live status dashboard for a Camus feat run — the human's "what is going on?" surface.

Read-only: synthesizes everything from artifacts the run already writes, so it works from any
terminal while the run is in flight (no Claude session, no tokens, no gate involvement):
  - ~/.camus/feats/<featId>.json    state: tasks, statuses, telemetry, the run-log event ring
  - ~/.camus/reviews/<wt>-r<n>.json per-round Codex audit files (mtimes = a real timeline)
  - ~/.camus/steer/<featId>.json    a pending human steering note, if any (see steer.py)

  status.py [featId] [--json] [--dir BASE]   # BASE defaults to ~/.camus

Without a featId, shows the most recently updated feat state (running runs touch their state
file as they advance, so "most recent" is the live one). --json emits the raw synthesis for
scripting. Exit 0 always when a state exists; exit 1 when there is nothing to show.
"""
import argparse
import json
import os
import sys
import time

GLYPH = {
    "done": "✓",
    "running": "▸",
    "pending": "·",
    "noop": "–",
    "failed": "✗",
    "merge_failed": "✗",
    "needs_human": "?",
}

EVENTS_SHOWN = 10       # "last 10 steps"
REVIEWS_SHOWN = 5


def default_base():
    return os.path.join(os.path.expanduser("~"), ".camus")


def _read_json(path):
    """Return (obj, problem): (dict, None) | (None, "missing") | (None, "corrupt").
    Corrupt ≠ missing on purpose — a mid-write race or a damaged state file must never
    masquerade as "no run exists" (same infra-vs-findings discipline as the engine)."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None, "missing"
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None, "corrupt"
    return (obj, None) if isinstance(obj, dict) else (None, "corrupt")


def find_state(base, feat_id=None):
    """Return (state, path, corrupt_paths). Explicit featId: its state or None (path tells
    where it looked). No featId: the most recently written PARSEABLE state — a corrupt
    newest file (mid-write race) falls back to the next-newest instead of hiding the run."""
    feats_dir = os.path.join(base, "feats")
    if feat_id:
        path = os.path.join(feats_dir, feat_id + ".json")
        obj, problem = _read_json(path)
        return obj, path, ([path] if problem == "corrupt" else [])
    try:
        names = [n for n in os.listdir(feats_dir) if n.endswith(".json")]
    except OSError:
        return None, None, []
    by_mtime = []
    for name in names:
        path = os.path.join(feats_dir, name)
        try:
            by_mtime.append((os.path.getmtime(path), path))
        except OSError:
            continue
    corrupt = []
    for _, path in sorted(by_mtime, reverse=True):
        obj, problem = _read_json(path)
        if obj is not None:
            return obj, path, corrupt
        if problem == "corrupt":
            corrupt.append(path)
    return None, None, corrupt


def review_activity(base, task_ids, now=None):
    """Most recent per-round Codex audit files for this feat's tasks (mtime-sorted, newest last)."""
    now = time.time() if now is None else now
    reviews_dir = os.path.join(base, "reviews")
    out = []
    try:
        names = os.listdir(reviews_dir)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        stem = name[:-5]                      # camus-wt-<taskId>-r<round>
        for tid in task_ids:
            prefix = "camus-wt-%s-r" % tid
            if stem.startswith(prefix):
                rnd = stem[len(prefix):]
                try:
                    mtime = os.path.getmtime(os.path.join(reviews_dir, name))
                except OSError:
                    continue
                out.append({"taskId": tid, "round": rnd, "mtime": mtime, "age": max(0, now - mtime)})
                break
    out.sort(key=lambda e: e["mtime"])
    return out[-REVIEWS_SHOWN:]


def steer_note(base, feat_id):
    return _read_json(os.path.join(base, "steer", "%s.json" % feat_id))[0]


def fmt_age(sec):
    if sec is None:
        return "?"
    sec = int(sec)
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm%02ds" % (sec // 60, sec % 60)
    return "%dh%02dm" % (sec // 3600, (sec % 3600) // 60)


def fmt_tokens(tokens):
    return "~%dk tokens" % round(tokens / 1000.0) if isinstance(tokens, (int, float)) else None


def synthesize(base, feat_id=None, now=None):
    """Gather everything into one plain dict (the --json output and the render() input).
    Returns None when nothing exists; a dict WITHOUT "state" (only "corrupt": [paths]) when
    the only candidate state file(s) exist but won't parse — callers must report that
    distinctly, never as "no run"."""
    now = time.time() if now is None else now
    state, path, corrupt = find_state(base, feat_id)
    if not state:
        return {"corrupt": corrupt} if corrupt else None
    try:
        age = max(0, now - os.path.getmtime(path))
    except OSError:
        age = None
    task_ids = [t.get("taskId") for t in state.get("tasks", []) if isinstance(t, dict) and t.get("taskId")]
    return {
        "state": state,
        "statePath": path,
        "stateAge": age,
        "reviews": review_activity(base, task_ids, now=now),
        "steer": steer_note(base, state.get("featId", "")),
        **({"skippedCorrupt": corrupt} if corrupt else {}),
    }


def render(synth, now=None):
    """Human dashboard as a list of lines."""
    now = time.time() if now is None else now
    s = synth["state"]
    lines = []
    status = s.get("status", "?")
    lines.append("Camus feat: %s   [%s]" % (s.get("feat", "?"), status))
    lines.append("  id %s · branch %s · base %s · state updated %s ago"
                 % (s.get("featId", "?"), s.get("featBranch", "?"), s.get("base", "?"),
                    fmt_age(synth.get("stateAge"))))
    lines.append("")

    tasks = [t for t in s.get("tasks", []) if isinstance(t, dict)]
    done = sum(1 for t in tasks if t.get("status") in ("done", "noop"))
    lines.append("Tasks (%d/%d done)" % (done, len(tasks)))
    for i, t in enumerate(tasks, 1):
        st = t.get("status", "?")
        tele = [x for x in (
            ("%s round%s" % (t["rounds"], "" if t.get("rounds") == 1 else "s")) if t.get("rounds") is not None else None,
            fmt_tokens(t.get("tokens")),
            ("model %s" % t["model"]) if t.get("model") else None,
        ) if x]
        lines.append("  %s %d. %-44s %-12s%s"
                     % (GLYPH.get(st, "·"), i, t.get("taskId", "?"), st,
                        (" " + " · ".join(tele)) if tele else ""))
    lines.append("")

    events = [e for e in s.get("events", []) if isinstance(e, dict) and e.get("msg")]
    if events:
        lines.append("Last steps (run log, oldest first)")
        for e in events[-EVENTS_SHOWN:]:
            lines.append("  %4s. %s" % (e.get("seq", "?"), e["msg"]))
        lines.append("")

    if synth["reviews"]:
        lines.append("Recent Codex review rounds (audit files)")
        for r in synth["reviews"]:
            lines.append("  %s ago  %s  round %s" % (fmt_age(r["age"]), r["taskId"], r["round"]))
        lines.append("")

    if status == "needs_human":
        q = s.get("question") or next((t.get("question") for t in tasks if t.get("question")), "")
        if q:
            lines.append("PAUSED — the run needs your decision:")
            lines.append("  %s" % q)
        halted = next((t.get("taskId") for t in tasks if t.get("status") == "needs_human"), "<taskId>")
        lines.append('  resume: re-run the feat with  answers:{"%s":"<your answer>"}' % halted)
        lines.append("")

    if synth["steer"]:
        lines.append("Steer note PENDING (applies at the next task boundary):")
        lines.append("  %s" % json.dumps(synth["steer"]))
    else:
        lines.append('Steer: none pending — `camus steer "<guidance>"` redirects the next task;')
        lines.append("       `camus steer --pause` halts at the next task boundary.")
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description="Camus feat status dashboard (read-only)")
    ap.add_argument("featId", nargs="?", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dir", default=default_base(), help="camus home (default ~/.camus)")
    args = ap.parse_args(argv)

    synth = synthesize(args.dir, args.featId)
    if synth is None:
        print("no feat state found under %s (has a run started?)" % os.path.join(args.dir, "feats"),
              file=sys.stderr)
        return 1
    if "state" not in synth:
        # The state EXISTS but won't parse — likely a mid-write race (persistState is not
        # atomic) or a damaged file. Saying "no run" here could prompt a disastrous re-launch.
        print("feat state file exists but is not valid JSON (mid-write race, or corrupt):",
              file=sys.stderr)
        for p in synth["corrupt"]:
            print("  %s" % p, file=sys.stderr)
        print("retry in a moment; if it persists, the file is damaged.", file=sys.stderr)
        return 2
    if synth.get("skippedCorrupt"):
        for p in synth["skippedCorrupt"]:
            print("warning: skipped unparseable state file (mid-write race?): %s" % p,
                  file=sys.stderr)
    if args.json:
        print(json.dumps(synth, indent=2))
    else:
        print("\n".join(render(synth)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
