#!/usr/bin/env python3
"""Read (or consume) a Camus steer note MECHANICALLY with a sentinel (field soak 2026-06-13, item 7;
read/consume SPLIT 2026-06-14 finding A; SHA-GATED consume 2026-06-14 finding P2).

  steer_read.py <featId>                        ->  {"read": true, "note": "<text>"|null, "sha": "<hex>"|null}
                                                    {"read": false, "error": "<reason>"}   # could not read
  steer_read.py <featId> --consume --expect-sha <hex>
                                                ->  {"consumed": true}                      # deleted exactly that note
                                                    {"consumed": false, "reason": "changed", "sha": "<current>"}
                                                    {"consumed": false, "reason": "absent"}
                                                    {"consumed": false, "error": "<reason>"}

WHY READ-ONLY-BY-DEFAULT (finding A): the plain read must NOT delete, so a transient thin-runner
relay flake can be RETRIED safely — a re-read finds the SAME un-consumed note, no loss.

WHY THE CONSUME IS SHA-GATED (finding P2): the read and the consume are two separate steps; a human
can run `camus steer` in between, writing a NEWER note. A blind delete would then apply the OLD note
(already read) and silently delete the NEW one. So consume deletes ONLY when the file's current bytes
still hash to the sha the workflow read (`--expect-sha`). If the bytes changed, the newer note is
PRESERVED and we report reason:"changed" so the workflow re-reads and processes the current note.
The delete is made atomic by an os.rename CLAIM: we move the file aside, then verify the claimed
bytes — a writer landing a new note after the rename creates a fresh file at the original path that
we never touch (so a write racing the compare→unlink window can't lose the new note either).

WHY THE SENTINEL: an agent hiccup must be distinguishable from a present note (the old `cat||echo{}`
conflated them and consumed real notes). featId is basenamed to keep the path inside ~/.camus/steer/.
CAMUS_HOME IS the camus home itself (default ~/.camus) — same convention as reconcile.py/land.py.
"""
import hashlib
import json
import os
import sys


def _sha(data_bytes):
    return hashlib.sha256(data_bytes).hexdigest()


def main(argv):
    camus_home = os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")
    feat_id = os.path.basename(argv[0]) if argv else ""
    rest = argv[1:]
    consume = "--consume" in rest
    expect = None
    for i, a in enumerate(rest):
        if a == "--expect-sha" and i + 1 < len(rest):
            expect = rest[i + 1]
        elif a.startswith("--expect-sha="):
            expect = a.split("=", 1)[1]
    path = os.path.join(camus_home, "steer", feat_id + ".json")

    if consume:
        if not expect:
            print(json.dumps({"consumed": False, "error": "--consume requires --expect-sha <hex>"}))
            return
        tmp = path + ".consuming"
        try:
            # Atomic CLAIM: move the file aside. A concurrent writer's new note now lands at the
            # original path, which we never touch — so we can never delete a note we didn't read.
            os.rename(path, tmp)
        except FileNotFoundError:
            print(json.dumps({"consumed": False, "reason": "absent"}))  # gone before we touched it
            return
        except Exception as exc:
            print(json.dumps({"consumed": False, "error": str(exc)[:200]}))
            return
        try:
            with open(tmp, "rb") as fh:
                got = _sha(fh.read())
        except Exception as exc:
            # Could not verify the claim — restore it so nothing is lost, then report.
            try:
                if not os.path.exists(path):
                    os.replace(tmp, path)
                else:
                    os.remove(tmp)
            except Exception:
                pass
            print(json.dumps({"consumed": False, "error": str(exc)[:200]}))
            return
        if got == expect:
            try:
                os.remove(tmp)
            except Exception:
                pass  # best-effort; the claim already removed it from the live path
            print(json.dumps({"consumed": True}))
            return
        # The note CHANGED since the workflow read it — preserve the newer note, delete nothing.
        try:
            if not os.path.exists(path):
                os.replace(tmp, path)   # nothing newer arrived — put the changed note back
            else:
                os.remove(tmp)          # an even-newer note already sits at path — drop our stale claim
        except Exception:
            pass
        print(json.dumps({"consumed": False, "reason": "changed", "sha": got}))
        return

    # READ-ONLY: never delete here, so a retried read re-reads the same note (no loss on a relay flake).
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        print(json.dumps({"read": True, "note": None, "sha": None}))  # clean no-note
        return
    except Exception as exc:
        print(json.dumps({"read": False, "error": str(exc)[:200]}))
        return
    print(json.dumps({"read": True, "note": data.decode("utf-8", "replace"), "sha": _sha(data)}))


if __name__ == "__main__":
    main(sys.argv[1:])
