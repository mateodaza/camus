#!/usr/bin/env python3
"""Write the per-round REVIEW REQUEST that codex_review.sh cross-checks against.

    review_request.py write --worktree W --round R [--effort E] [--nonce N]
                            [--model M] [--backend B]

Writes ``$CAMUS_REVIEW_DIR/<basename worktree>-request.json`` atomically
(default review dir ``~/.camus/reviews``).

WHY (field report 2026-08-04, a WP6 game run): the loop asked for review round 2
at high effort by putting `2 high` at the end of a shell command and handing that
command to a thin LLM runner. The runner's Bash call omitted the two arguments,
the reviewer defaulted to round 0 / medium, and the loop accepted the resulting
receipt as round 2. An argument list a model retypes is not a custody channel.

THIS FILE IS NOT AN INDEPENDENT CHANNEL. The SAME thin agent executes both this
writer invocation and the review command that follows it, so the agent can alter
or drop EITHER — a relay that mangles the review args could mangle this write too.
What the request file buys is a CONSISTENCY CHECK: codex_review.sh refuses when
the request file, the argv, and the environment disagree, so a partial mangling
(some channels changed, others not) becomes a loud refusal instead of a silent
mislabel. The LOAD-BEARING guarantee is elsewhere and independent of the relay:
asGate in the workflow compares the reviewer's ACTUAL round/effort/model/nonce
against expectations the workflow itself computed, and any mismatch fails closed
as reviewer infrastructure — never a verdict.

Contract:
  * ONE request per worktree, replaced each round; the reviewer refuses a request
    whose ``worktree`` is not the directory being reviewed.
  * Atomic publish (temp + ``os.replace``): the reviewer never reads a torn file.
  * The caller must write this immediately before invoking the review. A STALE
    file (naming an earlier round) makes the reviewer refuse rather than review
    the wrong round — deliberately fail-closed.
  * Prints JSON and exits 0 even on failure, so a request write can only ever
    cause a refusal downstream, never a crash mid-gate.
"""
import argparse
import json
import os
import sys
import tempfile
import time

VALID_EFFORT = ("low", "medium", "high", "xhigh")


def review_dir():
    return os.environ.get("CAMUS_REVIEW_DIR") or os.path.join(os.path.expanduser("~"), ".camus", "reviews")


def request_path(worktree):
    return os.path.join(review_dir(), "%s-request.json" % os.path.basename(os.path.normpath(worktree)))


def build_request(worktree, round_value, effort=None, nonce=None, model=None, backend=None, now=None):
    """Returns (record, error). Refuses anything the reviewer would have to guess about."""
    if not worktree:
        return None, "a review request needs the worktree it is for"
    try:
        rnd = int(str(round_value).strip())
    except (TypeError, ValueError):
        return None, "review round must be an integer"
    if rnd < 1:
        return None, "review rounds start at 1; %d is not a round" % rnd
    if effort is not None and effort not in VALID_EFFORT:
        return None, "review effort %r is not one of %s" % (effort, "|".join(VALID_EFFORT))
    return {
        "schema_version": 1,
        "requested_at": int(time.time()) if now is None else now,
        # realpath so a symlinked worktree still matches the directory the
        # reviewer resolves; basename identity alone is not enough.
        "worktree": os.path.realpath(worktree),
        "round": rnd,
        "effort": effort,
        "gate_nonce": nonce or None,
        "reviewer_model": model or None,
        "reviewer_backend": backend or None,
    }, None


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("mode", choices=("write",))
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--round", dest="round", required=True)
    parser.add_argument("--effort", default=None)
    parser.add_argument("--nonce", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--backend", default=None)
    try:
        opts = parser.parse_args(argv)
    except SystemExit:
        print(json.dumps({"ok": False, "error": "bad review_request arguments"}))
        return 0

    record, error = build_request(opts.worktree, opts.round, opts.effort, opts.nonce, opts.model, opts.backend)
    if error:
        print(json.dumps({"ok": False, "error": error}))
        return 0
    path = request_path(opts.worktree)
    try:
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".request-", suffix=".tmp")
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
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "could not write the review request: %s" % exc}))
        return 0
    print(json.dumps({"ok": True, "path": path, "request": record}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
