#!/usr/bin/env python3
"""Read a Camus steer note MECHANICALLY with a sentinel (field soak 2026-06-13, item 7).

  steer_read.py <featId>   ->   {"read": true, "note": "<raw file text>" | null}
                                {"read": false, "error": "<reason>"}   # could not read

WHY: the old check was `cat ~/.camus/steer/<id>.json || echo {}` echoed by a thin agent, with the
no-note ground truth being the reply being exactly "{}". An agent hiccup (preamble / budget stub /
wrapper text) then looked like a PRESENT but unparseable human note — so the run halted claiming
the human left a bad countermand, and the paired `rm` had already consumed a real one. The sentinel
({"read":true,...}) lets the workflow tell "the note state WAS obtained" (read:true; note null when
absent) from "the agent could not obtain it" (no sentinel → inconclusive, nothing consumed).

A present note is consumed (a note applies ONCE) only AFTER it is successfully read into the emitted
JSON — so a missing file is a clean no-note, and a read that throws consumes nothing. featId is
basenamed to keep the path inside ~/.camus/steer/.
"""
import json
import os
import sys

home = os.environ.get("CAMUS_HOME") or os.path.expanduser("~")
feat_id = os.path.basename(sys.argv[1]) if len(sys.argv) > 1 else ""
path = os.path.join(home, ".camus", "steer", feat_id + ".json")

note = None
try:
    with open(path, "r", encoding="utf-8") as fh:
        note = fh.read()
except FileNotFoundError:
    note = None  # clean no-note
except Exception as exc:
    print(json.dumps({"read": False, "error": str(exc)[:200]}))
    sys.exit(0)

# Consume ONLY a note that was actually read (applies once); never consume on a missing/errored read.
if note is not None:
    try:
        os.remove(path)
    except Exception:
        pass  # best-effort; the workflow's re-queue handles a surviving file

print(json.dumps({"read": True, "note": note}))
