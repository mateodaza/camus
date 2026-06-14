#!/usr/bin/env python3
"""Read (or consume) a Camus steer note MECHANICALLY with a sentinel (field soak 2026-06-13, item 7;
read/consume SPLIT 2026-06-14 finding A; SHA-GATED consume + crash-safe CLAIM 2026-06-14 findings P2).

  steer_read.py <featId>                        ->  {"read": true, "note": "<text>"|null, "sha": "<hex>"|null}
                                                    {"read": false, "error": "<reason>"}   # could not read / stranded claim
  steer_read.py <featId> --consume --expect-sha <hex>
                                                ->  {"consumed": true}                      # deleted exactly that note
                                                    {"consumed": false, "reason": "changed", "sha": "<current>"}
                                                    {"consumed": false, "reason": "absent"}
                                                    {"consumed": false, "error": "<reason>"}

WHY READ-ONLY-BY-DEFAULT (finding A): the plain read must NOT delete, so a transient thin-runner
relay flake can be RETRIED safely — a re-read finds the SAME un-consumed note, no loss.

WHY THE CONSUME IS SHA-GATED (finding P2): the read and the consume are two separate steps; a human
can run `camus steer` (or `--clear`) in between. A blind delete would apply the OLD note (already
read) and silently delete the NEW one. So consume deletes ONLY when the file's current bytes still
hash to `--expect-sha`. If the bytes changed, the newer note is PRESERVED (reason:"changed"); if the
note vanished (a `--clear`), reason:"absent" — both tell the workflow to RE-READ the current state and
NEVER apply the bytes it read earlier.

WHY A CRASH-SAFE CLAIM (finding P2, sibling): consume claims the file via os.rename to a fixed
`.consuming` path, then verifies + deletes. If the process dies AFTER the rename, the note is stranded
in `.consuming` and a naive read of the original path would report note:null (silent loss). So:
  - READ resolves a stranded claim first: if `.consuming` exists and the live note is ABSENT, it
    RECOVERS the stranded note (rename back); if BOTH exist (a crash plus a newer human note), it
    refuses to guess and HALTS loudly (read:false) for the human to resolve.
  - CONSUME refuses to overwrite an existing `.consuming` (a stale claim) — it would erase a stranded
    note — and reports an error so the workflow re-reads (which then recovers or halts loudly).

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
    tmp = path + ".consuming"   # fixed per-feat claim file (a crash here is recovered below)

    if consume:
        if not expect:
            print(json.dumps({"consumed": False, "error": "--consume requires --expect-sha <hex>"}))
            return
        if os.path.exists(tmp):
            # A stale claim from a crashed prior consume. Do NOT overwrite it (that would erase the
            # stranded note). Bail; the workflow re-reads, and READ recovers or halts loudly.
            print(json.dumps({"consumed": False, "error": "stale steer claim present (a prior consume crashed) — re-read to recover"}))
            return
        try:
            # Atomic CLAIM: move the file aside. A concurrent writer's new note now lands at the
            # original path, which we never touch — so we can never delete a note we didn't read.
            os.rename(path, tmp)
        except FileNotFoundError:
            print(json.dumps({"consumed": False, "reason": "absent"}))  # gone before we touched it (a --clear)
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

    # READ-ONLY. First resolve any stranded claim from a crashed consume (crash-safety, finding P2):
    if os.path.exists(tmp):
        if not os.path.exists(path):
            try:
                os.replace(tmp, path)   # self-heal: restore the only stranded note, then read it
            except Exception as exc:
                print(json.dumps({"read": False, "error": "could not recover stranded steer claim: " + str(exc)[:160]}))
                return
        else:
            # Both a stranded claim AND a current note — a crash plus a newer human note. Don't guess
            # which to honor; halt loudly so the human resolves it (inspect %s / `camus steer --clear`).
            print(json.dumps({"read": False, "error": "a previous consume crashed leaving a stranded steer claim (" + tmp + ") alongside a current note — resolve it before continuing"}))
            return

    # Never delete here, so a retried read re-reads the same note (no loss on a relay flake).
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
