#!/usr/bin/env python3
"""Tests for the durable nonce-bound status record (field report 2026-08-04)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import status_record  # noqa: E402


def run(args, env):
    out = subprocess.run([sys.executable, os.path.join(HERE, "status_record.py")] + args,
                         capture_output=True, text=True, env=env)
    return json.loads(out.stdout or "{}")


class StatusRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = dict(os.environ, CAMUS_FEATS_DIR=self.tmp)

    def test_write_then_read_round_trips(self):
        w = run(["write", "--salt", "s1", "--nonce", "n-1", "--phase", "Implement",
                 "--worktree", "/wt/camus-wt-x", "--branch", "camus/x", "--round", "2",
                 "--effort", "high", "--model", "gpt-5.6-sol", "--backend", "codex"], self.env)
        self.assertTrue(w["ok"], w)
        r = run(["read", "--salt", "s1"], self.env)
        rec = r["record"]
        self.assertEqual(rec["nonce"], "n-1")
        self.assertEqual(rec["phase"], "Implement")
        self.assertEqual(rec["round"], 2)
        self.assertEqual(rec["effort"], "high")
        self.assertEqual(rec["model"], "gpt-5.6-sol")
        self.assertEqual(rec["worktree"], "/wt/camus-wt-x")

    def test_read_of_absent_identity_is_not_ok_and_never_invents(self):
        r = run(["read", "--salt", "nope"], self.env)
        self.assertFalse(r["ok"])
        self.assertIsNone(r["record"])

    def test_phase_update_merges_and_keeps_worktree(self):
        run(["write", "--salt", "s2", "--nonce", "n", "--worktree", "/wt/a", "--phase", "Plan"], self.env)
        run(["write", "--salt", "s2", "--phase", "Review", "--round", "1"], self.env)
        rec = run(["read", "--salt", "s2"], self.env)["record"]
        self.assertEqual(rec["phase"], "Review")
        self.assertEqual(rec["worktree"], "/wt/a", "a phase update must not erase the worktree")
        self.assertEqual(rec["round"], 1)

    def test_nonce_is_write_once(self):
        run(["write", "--salt", "s3", "--nonce", "first"], self.env)
        again = run(["write", "--salt", "s3", "--nonce", "second"], self.env)
        self.assertFalse(again["ok"], "rebinding an identity to another nonce is refused")
        self.assertIn("refusing to rebind", again["error"])
        rec = run(["read", "--salt", "s3"], self.env)["record"]
        self.assertEqual(rec["nonce"], "first", "the original binding survives a refused rebind")
        # The SAME nonce is idempotent, so retries and resumes are fine.
        same = run(["write", "--salt", "s3", "--nonce", "first", "--phase", "Verify"], self.env)
        self.assertTrue(same["ok"])

    def test_progress_bumps_only_the_timestamp(self):
        run(["write", "--salt", "s4", "--nonce", "n", "--phase", "Implement"], self.env)
        before = run(["read", "--salt", "s4"], self.env)["record"]
        rec, _ = status_record.apply_write(before, {"progress_note": "still writing files"},
                                          now=before["last_progress_at"] + 42)
        self.assertEqual(rec["last_progress_at"], before["last_progress_at"] + 42)
        self.assertEqual(rec["phase"], "Implement", "progress does not change the phase")

    def test_unknown_field_is_refused_rather_than_stored(self):
        rec, err = status_record.apply_write({}, {"sneaky": "value"})
        self.assertIsNone(rec)
        self.assertIn("unknown status field", err)

    def test_writes_are_atomic_so_a_reader_never_sees_a_torn_record(self):
        # A directory listing must never contain a half-written status file after a
        # completed write; the temp file is replaced, not appended in place.
        run(["write", "--salt", "s5", "--nonce", "n", "--phase", "Plan"], self.env)
        leftovers = [f for f in os.listdir(self.tmp) if f.startswith(".status-")]
        self.assertEqual(leftovers, [], "no temp files survive a successful write")
        with open(os.path.join(self.tmp, "s5.status.json"), encoding="utf-8") as fh:
            json.load(fh)  # parses = not torn

    def test_bad_arguments_never_raise_into_the_gate(self):
        out = run(["write"], self.env)  # missing --salt
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    result = unittest.main(verbosity=0, exit=False).result
    print("status_record tests done" if result.wasSuccessful() else "status_record tests FAILED")
    sys.exit(0 if result.wasSuccessful() else 1)
