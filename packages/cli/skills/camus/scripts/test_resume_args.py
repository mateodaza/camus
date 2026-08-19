"""Contract tests for the small resumeFeatId canonical-args transport."""
import json
import io
import os
import sys
import tempfile
from contextlib import redirect_stdout

import resume_args as R
import resume_scan


def _write(path, value):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False)


def _args():
    return {"argsVersion": 1, "feat": "Large Feat", "tasks": ["task a", "task b"],
            "policy": "autonomous", "posture": "full"}


def test_loads_legacy_inline_args():
    d = tempfile.mkdtemp(prefix="camus_ra_")
    args = _args()
    feat_id = resume_scan._feat_id(args)
    _write(os.path.join(d, feat_id + ".json"),
           {"featId": feat_id, "status": "halted", "resumeArgs": args})
    assert R.load_args(d, feat_id) == args


def test_loads_validated_compact_sidecar():
    d = tempfile.mkdtemp(prefix="camus_ra_")
    args = _args()
    feat_id = resume_scan._feat_id(args)
    ref = feat_id + ".args.json"
    _write(os.path.join(d, ref), args)
    _write(os.path.join(d, feat_id + ".json"), {"featId": feat_id, "status": "running",
           "resumeArgsRef": ref, "resumeArgsHash": resume_scan._args_hash(args)})
    assert R.load_args(d, feat_id) == args


def test_refuses_bad_id_missing_state_and_identity_mismatch():
    d = tempfile.mkdtemp(prefix="camus_ra_")
    assert R.load_args(d, "../escape") is None
    assert R.load_args(d, "missing-abc123") is None
    args = _args()
    feat_id = resume_scan._feat_id(args)
    _write(os.path.join(d, feat_id + ".json"),
           {"featId": feat_id, "resumeArgs": {**args, "feat": "Different"}})
    assert R.load_args(d, feat_id) is None


def test_refuses_missing_or_hash_mismatched_sidecar():
    d = tempfile.mkdtemp(prefix="camus_ra_")
    args = _args()
    feat_id = resume_scan._feat_id(args)
    ref = feat_id + ".args.json"
    state = {"featId": feat_id, "resumeArgsRef": ref,
             "resumeArgsHash": resume_scan._args_hash(args)}
    _write(os.path.join(d, feat_id + ".json"), state)
    assert R.load_args(d, feat_id) is None
    _write(os.path.join(d, ref), {**args, "posture": "oneshot"})
    assert R.load_args(d, feat_id) is None


def test_main_emits_one_compact_json_object():
    d = tempfile.mkdtemp(prefix="camus_ra_")
    args = _args()
    feat_id = resume_scan._feat_id(args)
    _write(os.path.join(d, feat_id + ".json"), {"featId": feat_id, "resumeArgs": args})
    out = io.StringIO()
    with redirect_stdout(out):
        assert R.main([feat_id, d]) == 0
    raw = out.getvalue()
    assert raw.count("\n") == 1 and json.loads(raw) == args


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok   " + fn.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL " + fn.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
