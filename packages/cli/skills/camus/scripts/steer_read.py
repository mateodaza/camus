#!/usr/bin/env python3
"""Read (or consume) a Camus steer note MECHANICALLY with a sentinel (field soak 2026-06-13, item 7;
read/consume SPLIT added in the live re-soak round, 2026-06-14).

  steer_read.py <featId>             ->  {"read": true, "note": "<raw file text>" | null}
                                         {"read": false, "error": "<reason>"}     # could not read
  steer_read.py <featId> --consume   ->  {"consumed": true}                       # delete the note
                                         {"consumed": false, "error": "<reason>"}

WHY READ-ONLY-BY-DEFAULT (live re-soak 2026-06-14, finding A): the plain read must NOT delete, so a
transient thin-runner relay flake can be RETRIED safely — a re-read finds the SAME un-consumed note,
no loss. The workflow deletes (--consume) only AFTER it has a confirmed, parsed note in hand. The
old atomic read+delete meant a flake after the delete would lose a real note; splitting closes that.

WHY THE SENTINEL: the old `cat ... || echo {}` echoed by a thin agent made an agent hiccup look like
a PRESENT, unparseable human note (and the paired rm consumed a real one). {"read":true,...} lets the
workflow tell "the note state WAS obtained" (note null when absent) from "the agent could not obtain
it" (no sentinel → retry, then inconclusive). featId is basenamed to keep the path inside ~/.camus/steer/.

CAMUS_HOME IS the camus home itself (default ~/.camus) — same convention as reconcile.py/land.py.
"""
import json
import os
import sys

camus_home = os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")
feat_id = os.path.basename(sys.argv[1]) if len(sys.argv) > 1 else ""
consume = "--consume" in sys.argv[2:]
path = os.path.join(camus_home, "steer", feat_id + ".json")

if consume:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass  # already gone — consuming is idempotent
    except Exception as exc:
        print(json.dumps({"consumed": False, "error": str(exc)[:200]}))
        sys.exit(0)
    print(json.dumps({"consumed": True}))
    sys.exit(0)

# READ-ONLY: never delete here, so a retried read re-reads the same note (no loss on a relay flake).
note = None
try:
    with open(path, "r", encoding="utf-8") as fh:
        note = fh.read()
except FileNotFoundError:
    note = None  # clean no-note
except Exception as exc:
    print(json.dumps({"read": False, "error": str(exc)[:200]}))
    sys.exit(0)

print(json.dumps({"read": True, "note": note}))
