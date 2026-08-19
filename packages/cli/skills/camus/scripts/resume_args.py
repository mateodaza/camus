#!/usr/bin/env python3
"""Load a feat's canonical resume args by validated feat id.

This is the small-argument transport for `/camus-feat {"resumeFeatId":"..."}`. It accepts both
legacy inline resumeArgs and the compact sidecar format, validates sidecar hash/path and recomputes
the workflow feat identity, then prints exactly one JSON object. It never checks run status: manual
resume/land is intentionally allowed for terminal and non-terminal checkpoints alike.
"""
import json
import os
import re
import sys

import resume_scan


FEAT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")


def load_args(feats_dir, feat_id):
    if not isinstance(feat_id, str) or not FEAT_ID_RE.fullmatch(feat_id):
        return None
    state = resume_scan._read_feat(os.path.join(feats_dir, feat_id + ".json"))
    if not isinstance(state, dict) or state.get("featId") != feat_id:
        return None
    args = resume_scan._canonical_args(state, feats_dir)
    if not isinstance(args, dict) or resume_scan._feat_id(args) != feat_id:
        return None
    return args


def default_feats_dir():
    return os.path.join(os.path.expanduser("~"), ".camus", "feats")


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) not in (1, 2):
        print("usage: resume_args.py <featId> [FEATS_DIR]", file=sys.stderr)
        return 2
    feat_id = argv[0]
    feats_dir = argv[1] if len(argv) == 2 else default_feats_dir()
    args = load_args(feats_dir, feat_id)
    if args is None:
        print("refusing: canonical resume args are missing, malformed, or incoherent", file=sys.stderr)
        return 1
    print(json.dumps(args, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
