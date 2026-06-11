#!/usr/bin/env python3
"""Leave a steering note for a RUNNING Camus feat — consumed at the next task boundary.

The feat workflow checks ~/.camus/steer/<featId>.json before starting each task, applies it,
and deletes it (a note steers ONCE). This is the deliberate middle ground between "watch
helplessly" and live mid-task injection (which would break the deterministic, resumable
engine): you redirect BETWEEN tasks, where the run is at a clean, merged point.

  steer.py "guidance text"            # redirect the NEXT task (threads in as a human decision)
  steer.py --task TASKID "text"       # answer/steer one specific task (now or later in the run)
  steer.py --pause                    # halt the feat at the next task boundary (resumable)
  steer.py --show                     # print the pending note, if any
  steer.py --clear                    # remove the pending note
  steer.py ... --feat FEATID          # target a specific feat (default: the single running one)
  steer.py ... --dir BASE             # camus home (default ~/.camus; for tests)

Safety: this only WRITES a json note under ~/.camus/steer/. The running feat applies guidance
through the same audited channel as a needs_human answer (plan + implement context); pause is
a graceful, resumable halt. If no feat is running, the note would never be consumed — refused.
Delivery is best-effort: the run consumes the note at its next task boundary and logs what it
applied (watch `camus status`); steered answers apply to the CURRENT run only and do not
survive a pause/resume. Steers issued while a note is still pending MERGE into it instead of
clobbering it (answers compose per-task with newest-per-key winning, guidance updates only when
re-given, pause is sticky) — a multi-task steer is just repeated `--task` calls.
"""
import argparse
import json
import os
import sys
import time

# A note left for a non-running feat would sit forever and fire on some FUTURE run of the same
# feat — surprising. Only running feats (state touched recently or not, status == running) accept.
STEERABLE_STATUS = "running"


def default_base():
    return os.path.join(os.path.expanduser("~"), ".camus")


def _read_json(path):
    """Return (obj, problem): (dict, None) | (None, "missing") | (None, "corrupt").
    Corrupt ≠ missing — a mid-write race on a live state file must never read as
    "no feat exists" (same infra-vs-findings discipline as the engine)."""
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


def running_feats(base):
    """Return ([(featId, mtime)] newest first for status == running, corrupt_count)."""
    feats_dir = os.path.join(base, "feats")
    out, corrupt = [], 0
    try:
        names = [n for n in os.listdir(feats_dir) if n.endswith(".json")]
    except OSError:
        return out, corrupt
    for name in names:
        path = os.path.join(feats_dir, name)
        obj, problem = _read_json(path)
        if problem == "corrupt":
            corrupt += 1
            continue
        if not obj or obj.get("status") != STEERABLE_STATUS or not obj.get("featId"):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        out.append((obj["featId"], mtime))
    out.sort(key=lambda e: -e[1])
    return out, corrupt


def resolve_feat(base, feat_id, require_running=True):
    """Return (featId, error). Explicit --feat must exist — and, for WRITES, be RUNNING too
    (review P2 2026-06-10: featIds are deterministic, so a note left on a done/halted feat
    would silently fire on a FUTURE run of the same feat). --show/--clear pass
    require_running=False so a stale note is always inspectable/retractable — via an explicit
    --feat; without --feat, resolution still requires exactly ONE running feat."""
    if feat_id:
        obj, problem = _read_json(os.path.join(base, "feats", feat_id + ".json"))
        if problem == "corrupt":
            return None, ("feat state %s.json exists but is not valid JSON (mid-write race, or "
                          "corrupt) — retry in a moment" % feat_id)
        if obj is None:
            return None, "no feat state %s.json under %s" % (feat_id, os.path.join(base, "feats"))
        if require_running and obj.get("status") != STEERABLE_STATUS:
            return None, ("feat %s is '%s', not running — a note would never be consumed now and "
                          "would fire on a FUTURE run of the same feat. Refusing."
                          % (feat_id, obj.get("status", "?")))
        return feat_id, None
    running, corrupt = running_feats(base)
    if not running:
        suffix = (" (%d state file(s) were unreadable — mid-write race? retry)" % corrupt) if corrupt else ""
        return None, "no RUNNING feat found — nothing would consume the note (see `camus status`)%s" % suffix
    if len(running) > 1:
        return None, ("multiple running feats: %s — pick one with --feat"
                      % ", ".join(fid for fid, _ in running))
    return running[0][0], None


def steer_path(base, feat_id):
    return os.path.join(base, "steer", "%s.json" % feat_id)


def merge_notes(existing, new):
    """Compose a follow-up steer INTO the pending note instead of clobbering it.

    Fixlet 2026-06-11 ("steer/answers must fail loudly", second half): write_note used to
    overwrite, so a second `--task` call silently dropped the first task's answer — a
    multi-task steer was not expressible from the CLI. Merge rules:
      answers  — map-merge: existing answers preserved, new keys added, same-key newest wins
                 (the human's latest word on a task is the one that should land);
      guidance — newest wins only when THIS invocation provides one; absent guidance in a
                 follow-up must not erase what's already queued;
      pause    — sticky-true: once you've asked the run to halt, a later answer/guidance
                 steer must not silently un-pause it (un-pausing is `--clear` + re-steer).
    Pure dict-in/dict-out (no I/O) so the semantics are testable without a filesystem.
    isinstance guards: a hand-edited note that parses but has a non-map `answers` is
    treated as having none rather than crashing the CLI mid-steer."""
    merged = dict(existing)
    ex_answers, new_answers = existing.get("answers"), new.get("answers")
    if isinstance(ex_answers, dict) or isinstance(new_answers, dict):
        answers = dict(ex_answers) if isinstance(ex_answers, dict) else {}
        answers.update(new_answers if isinstance(new_answers, dict) else {})
        merged["answers"] = answers
    if new.get("guidance") is not None:
        merged["guidance"] = new["guidance"]
    if existing.get("pause") is True or new.get("pause") is True:
        merged["pause"] = True
    return merged


def write_note(base, feat_id, note):
    path = steer_path(base, feat_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    note = dict(note)
    note["writtenAt"] = int(time.time())
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(note, fh, indent=2)
        fh.write("\n")
    return path


def write_note_merged(base, feat_id, note):
    """Compose `note` with any PENDING note and write the result. Returns (path, warning|None).

    Audit P1 2026-06-11: watch's keypress handlers called raw write_note, so an interactive
    pause-then-guidance CLOBBERED the pending note despite the CLI's merge rules. This is the
    one write path callers other than main() should use: parseable pending → merge_notes;
    present-but-CORRUPT pending → replaced, with a warning string the caller must surface
    (silently swallowing a lost steer is the exact failure the fixlet exists to kill)."""
    path = steer_path(base, feat_id)
    existing, problem = _read_json(path)
    warning = None
    if problem == "corrupt":
        warning = ("pending note %s was not valid JSON — replaced; anything it carried must "
                   "be re-issued" % path)
    elif existing is not None:
        note = merge_notes(existing, note)
    return write_note(base, feat_id, note), warning


def main(argv=None):
    ap = argparse.ArgumentParser(description="Steer a running Camus feat at its next task boundary")
    ap.add_argument("guidance", nargs="?", default=None, help="guidance for the NEXT task")
    ap.add_argument("--task", default=None, help="apply the guidance to one specific taskId")
    ap.add_argument("--pause", action="store_true", help="halt (resumable) at the next task boundary")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--clear", action="store_true")
    ap.add_argument("--feat", default=None, help="featId (default: the single running feat)")
    ap.add_argument("--dir", default=default_base(), help="camus home (default ~/.camus)")
    args = ap.parse_args(argv)

    readonly = args.show or args.clear
    feat_id, err = resolve_feat(args.dir, args.feat, require_running=not readonly)
    if err:
        print("steer: %s" % err, file=sys.stderr)
        return 1
    path = steer_path(args.dir, feat_id)

    if args.show:
        note, problem = _read_json(path)
        if problem == "corrupt":
            print("steer note for %s exists but is not valid JSON — `--clear` it" % feat_id)
            return 1
        print(json.dumps(note, indent=2) if note else "no pending steer note for %s" % feat_id)
        return 0
    if args.clear:
        try:
            os.remove(path)
            print("cleared steer note for %s" % feat_id)
        except FileNotFoundError:
            print("no pending steer note for %s" % feat_id)
        except OSError as exc:
            # Never report success-shaped output while the note survives — --clear is the
            # escape hatch for a stuck pause note, so it lying would be uniquely bad.
            print("steer: could NOT remove %s (%s) — the note is still pending" % (path, exc),
                  file=sys.stderr)
            return 1
        return 0

    if args.pause and (args.guidance or args.task):
        print("steer: --pause cannot be combined with guidance (pause first, steer on resume)",
              file=sys.stderr)
        return 1
    if args.pause:
        note = {"pause": True}
    elif args.task and args.guidance:
        note = {"answers": {args.task: args.guidance}}
    elif args.guidance:
        note = {"guidance": args.guidance}
    else:
        ap.print_help()
        return 1

    # A pending note means an earlier steer hasn't been consumed yet — compose, don't clobber
    # (fixlet 2026-06-11: a second `--task` call was silently dropping the first task's answer).
    existing, problem = _read_json(path)
    merged = False
    if problem == "corrupt":
        # Merging into garbage is impossible and silently replacing it would hide that an
        # earlier steer was lost. Replace, but say so LOUDLY and name the file — the engine
        # side halts on malformed notes (handled elsewhere); the CLI side must not be quieter.
        print("steer: WARNING — pending note %s is not valid JSON; discarding it and writing "
              "this note fresh (anything the old note carried must be re-issued)" % path,
              file=sys.stderr)
    elif existing is not None:
        note = merge_notes(existing, note)
        merged = True

    write_note(args.dir, feat_id, note)
    print("steer note for %s written → applied at the next task boundary:" % feat_id)
    print("  %s" % json.dumps(note))
    if merged:
        answers = note.get("answers")
        n = len(answers) if isinstance(answers, dict) else 0
        print("merged with the pending note%s" % (" (%d answer(s) total)" % n if n else ""))
    print("(change your mind: `camus steer --clear` · watch: `camus status`)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
