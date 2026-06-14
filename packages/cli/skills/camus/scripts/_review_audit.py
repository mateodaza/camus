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


# A usable verdict, mirrored from adapter.VALID_CORRECTNESS / codex_review.sh _last_has_verdict —
# kept inline so this best-effort audit writer takes no import on the adapter (audit 2026-06-13,
# item 12: the audit `ran` must match the GATE's "usable verdict", not merely "parsed as JSON").
_VALID_CORRECTNESS = ("patch is correct", "patch is incorrect")


def build_record(wt, rnd, status, raw):
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except (ValueError, TypeError):
        parsed = None
    # `ran` is the proof signal — and it must mean the SAME thing the gate means by "a review ran":
    # a real verdict, not just any JSON. Parseable JSON that lacks a valid overall_correctness is
    # exactly what the adapter rejects as schema-drift infra (it did NOT review), so it must read
    # ran:false here too — otherwise the forensic file claims a review "ran" for output the gate
    # threw away (audit 2026-06-13, item 12).
    ran = (
        isinstance(parsed, dict)
        and parsed.get("overall_correctness") in _VALID_CORRECTNESS
    )
    return {
        "ran_at": int(time.time()),
        "worktree": wt,
        "round": _int(rnd),
        "codex_exit": _int(status),
        "ran": ran,
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
