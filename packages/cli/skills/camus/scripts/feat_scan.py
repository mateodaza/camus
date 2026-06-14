#!/usr/bin/env python3
"""List Camus feat run-states for FORK DETECTION (field soak 2026-06-13, finding 8/5).

featId is a content hash of feat-title + ordered tasks, so editing/reordering a task mints a NEW
featId → a NEW feat branch → a silently-forked feature with the original's work orphaned. Before
cutting its branch, camus-feat scans existing run-states for an in-progress feat with the SAME
title but a DIFFERENT id. This emits the raw inventory MECHANICALLY (one JSON object); the
workflow does the title comparison in JS (it owns the canonical slugify). Read-only — no git,
no mutation, no egress; just the user's own ~/.camus state.

Emits exactly one JSON object on stdout:
  {"feats": [{"featId": "<state-file stem>", "title": <feat title|null>, "status": <status|null>}, ...]}
Always exits 0; an unreadable/corrupt state file degrades to title:null/status:null (never crashes
the scan — fork detection is a best-effort convenience guard, fail-OPEN).
"""
import glob
import json
import os

# CAMUS_HOME IS the camus home itself (default ~/.camus) — the same convention as reconcile.py /
# land.py, NOT the parent of .camus (verification audit 2026-06-13: the original nested .camus
# under it, silently disabling fork detection under a custom CAMUS_HOME).
camus_home = os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")
feats_dir = os.path.join(camus_home, "feats")

out = []
for path in sorted(glob.glob(os.path.join(feats_dir, "*.json"))):
    feat_id = os.path.splitext(os.path.basename(path))[0]
    title = None
    status = None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            title = data.get("feat")
            status = data.get("status")
    except Exception:
        pass  # corrupt/unreadable → null fields, never a crash
    out.append({"featId": feat_id, "title": title, "status": status})

print(json.dumps({"feats": out}))
