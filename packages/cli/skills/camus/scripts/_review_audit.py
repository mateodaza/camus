#!/usr/bin/env python3
"""Write a per-round Codex review AUDIT record — proof the cross-vendor review actually ran.

Called best-effort by codex_review.sh (never raises into the review path):
  _review_audit.py <audit_path> <worktree> <round> <codex_exit>   # raw Codex stdout on STDIN

The record captures Codex's raw response + metadata. A human (or a post-run check) can confirm every
review round produced a file with a real Codex response — and the ABSENCE of a file for a round means
codex_review.sh never ran for it (the thin reviewer fabricated output, or an infra failure occurred).
"""
import json
import sys
import time


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return x


def build_record(wt, rnd, status, raw):
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except (ValueError, TypeError):
        parsed = None
    return {
        "ran_at": int(time.time()),
        "worktree": wt,
        "round": _int(rnd),
        "codex_exit": _int(status),
        # `ran` is the proof signal: a non-empty Codex response that parsed as JSON.
        "ran": bool(raw.strip()) and parsed is not None,
        "codex_raw": raw,
        "codex_parsed": parsed,
    }


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 4:
        return 2
    audit_path, wt, rnd, status = argv[0], argv[1], argv[2], argv[3]
    raw = sys.stdin.read()
    rec = build_record(wt, rnd, status, raw)
    with open(audit_path, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
