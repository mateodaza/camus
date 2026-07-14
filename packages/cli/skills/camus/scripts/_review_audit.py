#!/usr/bin/env python3
"""Write a per-round Codex review AUDIT record — proof the cross-vendor review actually ran.

Called best-effort by codex_review.sh (never raises into the review path):
  _review_audit.py <audit_path> <worktree> <round> <codex_exit> [reviewer_model] [reviewer_effort]
  # raw Codex stdout on STDIN; model/effort come from the round's meta.json (the sealed identity)

The record captures Codex's raw response + metadata. A human (or a post-run check) can confirm every
review round produced a file with a real Codex response — and the ABSENCE of a file for a round means
codex_review.sh never ran for it (the thin reviewer fabricated output, or an infra failure occurred).
"""
import json
import os
import sys
import tempfile
import time

# The audit `ran` must mean EXACTLY what the gate means by "a review ran" — so reuse the adapter's
# own normalizer rather than re-deriving the rule (verification audit 2026-06-13: an inline
# overall_correctness check still diverged from the adapter, which ALSO rejects missing findings[],
# malformed priorities, and "patch is incorrect" with no blocking findings). Guarded import keeps
# this best-effort writer from ever raising into the review path.
try:
    import adapter as _adapter
except Exception:  # pragma: no cover - sibling always present in a real gate
    _adapter = None


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return x


def build_record(wt, rnd, status, raw, reviewer_model=None, reviewer_effort=None):
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except (ValueError, TypeError):
        parsed = None
    # `ran` = the gate's "usable verdict" oracle, computed by the SAME adapter the loop branches on,
    # so the forensic file can never claim a review ran for output the gate rejected as infra.
    ran = False
    if _adapter is not None:
        try:
            ran = _adapter.normalize_codex(raw, _int(status)).get("ran") is True
        except Exception:
            ran = False
    return {
        "ran_at": int(time.time()),
        "worktree": wt,
        "round": _int(rnd),
        "codex_exit": _int(status),
        "ran": ran,
        # The reviewer model the caller pinned for this round (identity slice). The
        # consumer trusts it only when ran is True — unknown never becomes claimed.
        "reviewer_model": reviewer_model or None,
        # The reasoning effort this round ACTUALLY ran at (from the round's meta,
        # the same authority as the model) — the requested/actual pairing needs
        # the actual side sealed, not inferred from a snapshot.
        "reviewer_effort": reviewer_effort or None,
        "codex_raw": raw,
        "codex_parsed": parsed,
    }


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 4:
        return 2
    audit_path, wt, rnd, status = argv[0], argv[1], argv[2], argv[3]
    reviewer_model = argv[4] if len(argv) > 4 else None
    reviewer_effort = argv[5] if len(argv) > 5 else None
    raw = sys.stdin.read()
    rec = build_record(wt, rnd, status, raw, reviewer_model, reviewer_effort)
    # Atomic publish: write a same-directory temp file, fsync, then os.replace()
    # onto the final path — a reader (e.g. the Studio watcher) ever sees the OLD
    # complete file or the NEW complete file, never a truncated mid-write JSON.
    directory = os.path.dirname(os.path.abspath(audit_path))
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".audit-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, audit_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
