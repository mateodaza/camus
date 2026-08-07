#!/usr/bin/env python3
"""The gate's DURABLE, NONCE-BOUND status record — one file per run identity.

    status_record.py write --salt <id> [--nonce N] [--phase P] [--worktree W]
                           [--branch B] [--round R] [--effort E] [--model M]
                           [--backend B] [--progress-note TEXT] [--usage JSON]
    status_record.py read  --salt <id>
    status_record.py progress --salt <id> [--note TEXT]     # touch last_progress_at only

Written to ``$CAMUS_FEATS_DIR/<salt>.status.json`` (default ``~/.camus/feats``),
beside the ``.hb`` heartbeat the loop already touches.

WHY THIS EXISTS (field report 2026-08-04, a WP6 game run). Three separate
failures shared one root cause — nothing durable said what the gate was doing or
what it had asked for:

  * Studio's only view of the run was the *completed* review receipts, so for ten
    minutes it showed "Igniting…" while the gate had classified, planned, made a
    worktree, written three files and started reviewing.
  * The idle watchdog could only see a phase-entry ``touch``, so a long Implement
    with real file writes looked idle and was killed.
  * Nothing outside the reviewer's own output knew which round/effort/model had
    been REQUESTED, so a receipt that was internally self-consistent could not be
    checked against an independent expectation.

So this record is the gate's statement of intent and progress. The workflow
COMPOSES each write (the values are inlined by the orchestrator), but the write
is EXECUTED through a thin agent — chained onto a phase command, or run as a
cheap status agent — so it is BEST-EFFORT telemetry, not a tamper-proof channel.
Studio reads it for liveness, progress, phase, and the owned worktree/prefix.

The load-bearing custody check does NOT rest on this record: a review receipt is
authorized by asGate comparing the reviewer's ACTUAL binding against expectations
the workflow computes, and by Studio comparing against its own run-start
snapshot. This record makes the run OBSERVABLE early; it is not what makes a
verdict trustworthy.

Contract notes:
  * Writes are ATOMIC (temp file + ``os.replace``), so a reader ever sees a
    complete old record or a complete new one, never a torn one.
  * ``write`` MERGES: a phase update does not erase the worktree, and the nonce
    is write-once — a second attempt to set a DIFFERENT nonce is refused, so one
    identity cannot be quietly re-pointed at another run mid-flight.
  * Every write bumps ``last_progress_at``; ``progress`` bumps only that, which
    is what a long-running phase calls to prove it is still working.
  * Best-effort by design: failures print JSON with ``ok:false`` and exit 0, so a
    status write can never break the gate it is describing.
"""
import argparse
import json
import os
import sys
import tempfile
import time

SCHEMA_VERSION = 1


def feats_dir():
    return os.environ.get("CAMUS_FEATS_DIR") or os.path.join(os.path.expanduser("~"), ".camus", "feats")


def record_path(salt):
    return os.path.join(feats_dir(), "%s.status.json" % salt)


def read_record(salt):
    try:
        with open(record_path(salt), encoding="utf-8") as fh:
            loaded = json.load(fh)
        return loaded if isinstance(loaded, dict) else None
    except (OSError, ValueError):
        return None


def _atomic_write(path, record):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".status-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# Fields a `write` may set. Anything else is refused rather than silently stored,
# so a typo cannot invent a field a consumer will never read.
WRITABLE = (
    "nonce", "phase", "worktree", "branch", "round", "effort", "model", "backend",
    "progress_note", "usage", "task_slug", "round_cap", "posture",
)


def apply_write(existing, updates, now=None):
    """Merge `updates` into `existing`. Returns (record, error)."""
    now = int(time.time()) if now is None else now
    record = dict(existing or {})
    record.setdefault("schema_version", SCHEMA_VERSION)
    record.setdefault("created_at", now)

    incoming_nonce = updates.get("nonce")
    if incoming_nonce:
        current = record.get("nonce")
        if current and current != incoming_nonce:
            # Write-once: one run identity may not be re-pointed at another run's
            # nonce while it is live. A consumer's expectations hang off this.
            return None, ("status record for this identity is already bound to nonce %r; refusing to rebind it to %r"
                          % (current, incoming_nonce))
        record["nonce"] = incoming_nonce

    for key, value in updates.items():
        if key == "nonce" or value is None:
            continue
        if key not in WRITABLE:
            return None, "unknown status field %r" % key
        record[key] = value

    record["last_progress_at"] = now
    record["updated_at"] = now
    return record, None


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("mode", choices=("write", "read", "progress"))
    parser.add_argument("--salt", required=True)
    for field in ("nonce", "phase", "worktree", "branch", "effort", "model", "backend", "task_slug", "posture"):
        parser.add_argument("--%s" % field.replace("_", "-"), dest=field, default=None)
    parser.add_argument("--round", dest="round", default=None)
    parser.add_argument("--round-cap", dest="round_cap", default=None)
    parser.add_argument("--progress-note", dest="progress_note", default=None)
    parser.add_argument("--note", dest="note", default=None)
    parser.add_argument("--usage", dest="usage", default=None)
    try:
        opts = parser.parse_args(argv)
    except SystemExit:
        print(json.dumps({"ok": False, "error": "bad status_record arguments"}))
        return 0

    if opts.mode == "read":
        record = read_record(opts.salt)
        print(json.dumps({"ok": record is not None, "record": record}))
        return 0

    updates = {}
    if opts.mode == "progress":
        if opts.note:
            updates["progress_note"] = opts.note
    else:
        for field in WRITABLE:
            value = getattr(opts, field, None)
            if value is None:
                continue
            if field == "round" or field == "round_cap":
                try:
                    updates[field] = int(str(value).strip())
                except ValueError:
                    print(json.dumps({"ok": False, "error": "%s must be an integer" % field}))
                    return 0
            elif field == "usage":
                try:
                    updates[field] = json.loads(value)
                except ValueError:
                    print(json.dumps({"ok": False, "error": "usage must be JSON"}))
                    return 0
            else:
                updates[field] = value

    record, error = apply_write(read_record(opts.salt), updates)
    if error:
        print(json.dumps({"ok": False, "error": error}))
        return 0
    try:
        _atomic_write(record_path(opts.salt), record)
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "could not write status record: %s" % exc}))
        return 0
    print(json.dumps({"ok": True, "record": record}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
