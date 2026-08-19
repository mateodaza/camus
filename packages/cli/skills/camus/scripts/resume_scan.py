#!/usr/bin/env python3
"""Auto-resume scanner for the Camus feat runner.

Scans the persisted feat-state directory and REPORTS which feats are safe to auto-resume — a feat
that was mid-flight (status == "running") when its run was interrupted (machine restart, watchdog
kill, scheduled-task timeout) AND has been idle long enough that it isn't still genuinely running.
It does NOT execute anything: it only emits the EXACT args a scheduler/watchdog would feed back into
the `camus-feat` workflow to pick the run back up.

  resume_scan.py [FEATS_DIR]     # default ~/.camus/feats ; prints a JSON array on stdout

WIRING TO A SCHEDULE (the scanner only REPORTS — the schedule does the re-invoke):
  1. On a timer (cron / a scheduled task every N minutes) run:  resume_scan.py
  2. For each object in the printed JSON array, re-invoke the feat workflow with it VERBATIM:
         workflow('camus-feat', <object>)
     The object IS the original canonical args (feat, tasks, policy, targetPath, model, modelTier,
     skipPlan, answers) — passing the full set is REQUIRED so the resumed run keeps the exact
     original behavior. `featId` is included for your logging/dedup and is ignored by the runner.
     The feat runner is idempotent on resume (preflight reads the same state, carries forward
     done/noop tasks, re-cuts the feat branch).
  3. NEVER auto-resume a feat NOT in this list.

SAFE-to-auto-resume rule (ALL must hold):
  - status == "running" (was actively in-flight), AND
  - the state file has been idle >= CAMUS_RESUME_STALE_SEC (default 1800s) — a still-LIVE run touches
    its state file as it advances, so a fresh mtime means "don't restart it" (avoids launching a
    second copy that would collide on the same branch/worktree), AND
  - canonical args (argsVersion 1) are either present inline (legacy/fallback) or in the state's
    exact sibling `resumeArgsRef`; referenced bytes must match `resumeArgsHash`, schema, and featId.
  (A lease/heartbeat would be more robust than mtime; left as a future hardening.)

Terminal / NOT auto-resumable (a deliberate stop — a human decides next):
  done, done_with_noops, halted, needs_human (resume needs an answers map, not a blind re-invoke),
  paused_by_user (a `camus steer --pause` — the human resumes when ready),
  dirty_tree, base_red, env_not_ready, infra_error, feat_integration_failed.
"""
import json
import os
import re
import sys
import time

# The ONLY status that is safe to auto-resume: a run that was actively in-flight when interrupted.
RESUMABLE_STATUS = "running"
SUPPORTED_ARGS_VERSION = 1

# Deliberate terminal states — documented here so the exclusion set is explicit and testable.
TERMINAL_STATUSES = (
    "done",
    "done_with_noops",
    "halted",
    "needs_human",
    "paused_by_user",
    "dirty_tree",
    "base_red",
    "env_not_ready",
    "infra_error",
    "feat_integration_failed",
)


def stale_seconds():
    try:
        v = int(os.environ.get("CAMUS_RESUME_STALE_SEC", "1800"))
        return v if v >= 0 else 1800
    except (ValueError, TypeError):
        return 1800


def _read_feat(path):
    """Return the parsed feat-state object, or None if the file is missing/empty/malformed."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _base36(n):
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    while n:
        n, rem = divmod(n, 36)
        out = chars[rem] + out
    return out


def _fnv1a_js(text):
    """Mirror the workflow's JS FNV-1a over UTF-16 code units."""
    encoded = text.encode("utf-16-le", "surrogatepass")
    h = 0x811C9DC5
    for i in range(0, len(encoded), 2):
        h ^= encoded[i] | (encoded[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return _base36(h)


def _args_hash(args):
    """Mirror JS fnv1a(JSON.stringify(args))."""
    canonical = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
    return "fnv1a32:" + _fnv1a_js(canonical)


def _feat_id(args):
    feat = args.get("feat") if isinstance(args, dict) else None
    tasks = args.get("tasks") if isinstance(args, dict) else None
    if not isinstance(feat, str) or not feat.strip() or not isinstance(tasks, list):
        return None
    if not tasks or not all(isinstance(t, str) and t.strip() for t in tasks):
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", feat.lower()).strip("-")[:24] or "task"
    digest = _fnv1a_js(feat + "\n---\n" + "\n".join(tasks))[:6]
    return "%s-%s" % (slug, digest)


def _canonical_args(obj, feats_dir=None):
    """Read inline legacy args or a validated exact sibling sidecar. Fail closed on any mismatch."""
    inline = obj.get("resumeArgs")
    if isinstance(inline, dict):
        return inline
    feat_id = obj.get("featId")
    ref = obj.get("resumeArgsRef")
    expected_hash = obj.get("resumeArgsHash")
    expected_ref = "%s.args.json" % feat_id if feat_id else None
    if not feats_dir or not feat_id or ref != expected_ref or not isinstance(expected_hash, str):
        return None
    # Exact basename equality above excludes absolute paths, traversal, and cross-feat references.
    args = _read_feat(os.path.join(feats_dir, ref))
    if not isinstance(args, dict) or _args_hash(args) != expected_hash:
        return None
    return args


def resumable_entry(obj, age_sec, stale_sec, feats_dir=None):
    """Map a feat-state object to the EXACT resume args, or None if it's not safe to auto-resume.
    `age_sec` = seconds since the state file was last written (None if unknown)."""
    if not isinstance(obj, dict):
        return None
    if obj.get("status") != RESUMABLE_STATUS:
        return None
    # P2a: only treat a 'running' state as INTERRUPTED once it has gone idle — a live run keeps
    # touching its state file, so a fresh file means it's probably still running; don't restart it.
    if age_sec is None or age_sec < stale_sec:
        return None
    feat_id = obj.get("featId")
    args = _canonical_args(obj, feats_dir)
    # P1: require canonical full args. Inline is the legacy/failure fallback; compact states point
    # to an immutable sibling sidecar. Missing or incoherent bytes are skipped, never guessed.
    if not feat_id or not isinstance(args, dict) or args.get("argsVersion") != SUPPORTED_ARGS_VERSION:
        return None
    feat = args.get("feat")
    tasks = args.get("tasks")
    if not feat or not isinstance(tasks, list) or not tasks:
        return None
    # P2b: reject the WHOLE state if ANY task is malformed. A filtered/truncated task list would
    # recompute a DIFFERENT featId in the runner and resume a DIFFERENT feat. All-or-nothing.
    if not all(isinstance(t, str) and t.strip() for t in tasks):
        return None
    # The scheduler's featId is ignored by the workflow; verify identity here so a stale or
    # mis-associated sidecar cannot silently launch a different feat under the old state's label.
    if _feat_id(args) != feat_id:
        return None
    entry = dict(args)          # emit the canonical args verbatim (the thing you pass to the workflow)
    entry["featId"] = feat_id   # for the scheduler's logging/dedup; ignored by the runner
    return entry


def scan(feats_dir, now=None, stale_sec=None):
    """Return the list of resume-arg objects for every SAFE-to-resume feat under feats_dir.
    Files that are missing/empty/malformed/terminal/too-fresh/old-format are silently skipped —
    the scanner never raises and never reports anything that isn't safe to auto-resume."""
    now = time.time() if now is None else now
    stale_sec = stale_seconds() if stale_sec is None else stale_sec
    out = []
    try:
        names = sorted(os.listdir(feats_dir))
    except OSError:
        return out                  # no feats dir yet → nothing to resume
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(feats_dir, name)
        obj = _read_feat(path)
        if obj is None:
            continue
        try:
            age = now - os.path.getmtime(path)
        except OSError:
            age = None
        entry = resumable_entry(obj, age, stale_sec, feats_dir)
        if entry is not None:
            out.append(entry)
    return out


def default_feats_dir():
    return os.path.join(os.path.expanduser("~"), ".camus", "feats")


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    feats_dir = argv[0] if argv else default_feats_dir()
    print(json.dumps(scan(feats_dir), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
