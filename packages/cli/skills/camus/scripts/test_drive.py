#!/usr/bin/env python3
"""Hermetic contracts for the native Camus driver."""

import json
import fcntl
import os
import subprocess
import tempfile
from unittest import mock
from types import SimpleNamespace

import drive as D
import feat_kernel as K


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo] + list(args), check=True,
                          capture_output=True, text=True).stdout.strip()


def _repo(root):
    repo = os.path.join(root, "repo")
    os.makedirs(repo)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "driver@example.test")
    _git(repo, "config", "user.name", "Driver Test")
    with open(os.path.join(repo, "seed.txt"), "w", encoding="utf-8") as fh:
        fh.write("seed\n")
    _git(repo, "add", "seed.txt")
    _git(repo, "commit", "-qm", "seed")
    _git(repo, "branch", "-M", "main")
    return repo


def test_start_is_model_free_canonical_and_idempotent():
    with tempfile.TemporaryDirectory() as root:
        repo = _repo(root)
        home = os.path.join(root, "camus")
        spec = os.path.join(root, "spec.json")
        with open(spec, "w", encoding="utf-8") as fh:
            json.dump({
                "feat": "Native Driver Fixture",
                "tasks": ["implement the exact bounded behavior", "add focused tests"],
                "targetPath": repo,
                "model": "claude-opus-4-8",
            }, fh)
        first = D.start_feature(spec, base=home)
        second = D.start_feature(spec, base=home)
        assert first["action"] == "feature_created"
        assert second["action"] == "feature_exists"
        assert _git(repo, "branch", "--show-current") == "main"
        assert _git(repo, "rev-parse", first["branch"]) == _git(repo, "rev-parse", "main")
        run = K._validated_run(first["featId"], home)
        assert run["args"]["model"] == "claude-opus-4-8"
        assert [node["status"] for node in run["nodes"]] == ["pending", "pending"]
        assert "resumeArgs" not in run["state"]


def test_event_log_is_append_only_and_deduplicates_phase_keys():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        assert log.append("agent.completed", trace_id="t", task_id="x", key="x:maker:1",
                          data={"sessionId": "s"}) is True
        assert log.append("agent.completed", trace_id="t", task_id="x", key="x:maker:1",
                          data={"sessionId": "different"}) is False
        assert len(log.records()) == 1
        assert log.latest("agent.completed", "x:maker:1")["data"]["sessionId"] == "s"
        assert os.stat(log.path).st_mode & 0o777 == 0o600
        assert os.stat(os.path.dirname(log.path)).st_mode & 0o777 == 0o700


class FakeClient:
    def __init__(self):
        self.launched = 0

    def find(self, _cwd, **_kwargs):
        return None

    def launch(self, _prompt, cwd, name, model, effort="medium", tools=None):
        self.launched += 1
        return {
            "shortId": "12345678", "sessionId": "12345678-1234-1234-1234-123456789abc",
            "name": name, "cwd": cwd, "state": "working", "startedAt": 1,
            "modelRequested": model, "effortRequested": effort,
            "billingMode": "claude_ai_account_quota", "surface": "claude_background_session",
        }

    def wait(self, session, timeout_seconds=1):
        return {**session, "state": "done", "endedAt": 2, "durationMs": 1,
                "transcriptSha256": "sha256:" + "1" * 64,
                "modelActual": "claude-opus-4-8", "modelsObserved": ["claude-opus-4-8"],
                "usage": {"inputTokens": 2, "cacheCreationInputTokens": 0,
                          "cacheReadInputTokens": 0, "outputTokens": 3},
                "toolCalls": 1, "lastAssistantText": "done"}


def test_run_agent_records_content_free_receipt_and_reuses_completion():
    with tempfile.TemporaryDirectory() as root:
        client = FakeClient()
        log = D.EventLog("feat-a", base=root)
        first = D.run_agent(
            client, log, trace_id="trace", feat_id="feat-a", task_id="task-a",
            role="maker", attempt=1, cwd=root, prompt="sensitive task text",
            model="claude-opus-4-8", effort="high", timeout=10,
        )
        assert first["state"] == "done"
        assert client.launched == 1
        rows = log.records()
        assert "sensitive task text" not in json.dumps(rows)
        assert rows[-1]["data"]["transcriptSha256"].startswith("sha256:")
        with mock.patch.object(D, "_recover_completed", return_value=rows[-1]["data"]):
            second = D.run_agent(
                client, log, trace_id="trace", feat_id="feat-a", task_id="task-a",
                role="maker", attempt=1, cwd=root, prompt="different",
                model="claude-opus-4-8", effort="high", timeout=10,
            )
        assert client.launched == 1
        assert second["sessionId"] == first["sessionId"]


def test_invalid_controller_output_fails_to_human():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        with mock.patch.object(D, "run_agent", return_value={
            "state": "done", "lastAssistantText": '{"action":"invented"}',
        }):
            decision = D.controller_decision(
                object(), log, trace_id="t", feat_id="feat-a", task_id="task-a",
                attempt=1, cwd=root, review={"blocking": []}, model="sonnet",
                timeout=10, max_rounds=3,
            )
        assert decision["action"] == "human"


def test_feature_driver_lease_refuses_duplicate_host():
    with tempfile.TemporaryDirectory() as root:
        directory = os.path.join(root, "sessions")
        os.makedirs(directory)
        path = os.path.join(directory, "feat-a.driver.lock")
        with open(path, "a+", encoding="utf-8") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                D.drive_feature("feat-a", SimpleNamespace(base=root))
                assert False, "duplicate feature driver acquired the lease"
            except D.DriverError as exc:
                assert "already owns" in str(exc)


def test_incomplete_attempt_is_retained_in_eval_denominator():
    with tempfile.TemporaryDirectory() as root:
        repo = _repo(root)
        home = os.path.join(root, "camus")
        spec = os.path.join(root, "spec.json")
        with open(spec, "w", encoding="utf-8") as fh:
            json.dump({
                "feat": "Failure Evidence Fixture", "tasks": ["attempt the bounded task"],
                "targetPath": repo, "taskClass": "bounded_feature",
            }, fh)
        started = D.start_feature(spec, base=home)
        run = K._validated_run(started["featId"], home)
        node = run["nodes"][0]
        log = D.EventLog(started["featId"], base=home)
        log.append("task.started", trace_id="trace", task_id=node["taskId"], key=node["taskId"])
        ledger = D.evals.Ledger(os.path.join(root, "episodes.jsonl"))
        D._record_incomplete_episode(
            ledger, log, run, node,
            {"makerModel": "opus", "reviewerModel": "sol"},
            {"id": "ab", "armId": "opus-sol", "taskClass": "bounded_feature"},
            {"action": "stop", "reason": "maker failed"},
        )
        record = ledger.records()[0]
        assert record["taskClass"] == "bounded_feature"
        assert record["outcome"]["terminalAction"] == "stop"
        assert D.evals.arm_stats(ledger.records(), "ab", "opus-sol")["qualityFloorRate"] == 0


if __name__ == "__main__":
    import sys
    tests = [value for key, value in sorted(globals().items())
             if key.startswith("test_") and callable(value)]
    failed = 0
    for test in tests:
        try:
            test()
            print("ok   " + test.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL " + test.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
