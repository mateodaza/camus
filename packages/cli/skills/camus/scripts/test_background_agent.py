#!/usr/bin/env python3
"""Hermetic contract tests for the Claude background-session adapter."""

import json
import os
import tempfile
from types import SimpleNamespace
from unittest import mock

import background_agent as B


def _write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def test_transcript_receipt_binds_hash_identity_usage_and_last_text():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "session.jsonl")
        _write_jsonl(path, [
            {"type": "assistant", "message": {
                "model": "claude-opus-4-8",
                "usage": {"input_tokens": 2, "cache_creation_input_tokens": 3,
                          "cache_read_input_tokens": 4, "output_tokens": 5},
                "content": [{"type": "tool_use", "name": "Read"}]},
            },
            {"type": "assistant", "message": {
                "model": "claude-opus-4-8",
                "usage": {"input_tokens": 7, "output_tokens": 11},
                "content": [{"type": "text", "text": "done"}]},
            },
        ])
        receipt = B.transcript_receipt(path, "claude-opus-4-8", "high")
        assert receipt["transcriptSha256"].startswith("sha256:")
        assert receipt["modelActual"] == "claude-opus-4-8"
        assert receipt["modelRequested"] == "claude-opus-4-8"
        assert receipt["usage"] == {
            "inputTokens": 9, "cacheCreationInputTokens": 3,
            "cacheReadInputTokens": 4, "outputTokens": 16,
        }
        assert receipt["toolCalls"] == 1
        assert receipt["lastAssistantText"] == "done"


def test_transcript_path_is_exact_and_rejects_non_uuid():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/a repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [])
        assert B.transcript_path(cwd, sid, projects_dir=projects) == path
        assert B.transcript_path(cwd, "../../secret", projects_dir=projects) is None


def test_extract_json_object_handles_fences_and_braces_in_strings():
    value = B.extract_json_object('result:\n```json\n{"action":"retry","why":"a } b"}\n```')
    assert value == {"action": "retry", "why": "a } b"}
    assert B.extract_json_object("no object") is None


def test_direct_env_drops_api_routes_credentials_and_proxies():
    env = B.direct_env({
        "PATH": "/bin", "HOME": "/tmp/home", "VIRTUAL_ENV": "/tmp/venv",
        "ANTHROPIC_API_KEY": "planted", "ANTHROPIC_BASE_URL": "http://redirect",
        "CLAUDE_CODE_USE_BEDROCK": "1", "HTTPS_PROXY": "http://proxy",
    })
    assert env["PATH"] == "/bin"
    assert env["VIRTUAL_ENV"] == "/tmp/venv"
    assert "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" not in env
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "HTTPS_PROXY"):
        assert name not in env


def test_launch_proves_claude_account_auth_and_isolates_settings_and_env():
    calls = []

    def fake_run(argv, cwd, timeout=30, env=None):
        calls.append({"argv": argv, "cwd": cwd, "env": env})
        if argv[1:4] == ["auth", "status", "--json"]:
            return SimpleNamespace(returncode=0, stdout='{"loggedIn":true,"authMethod":"claude.ai"}', stderr="")
        if "--bg" in argv:
            return SimpleNamespace(returncode=0, stdout="Backgrounded · abcdef12", stderr="")
        return SimpleNamespace(returncode=0, stdout=json.dumps([{
            "id": "abcdef12", "sessionId": "12345678-1234-1234-1234-123456789abc",
            "name": "camus-test", "state": "working", "startedAt": 1,
        }]), stderr="")

    planted = {"PATH": "/bin", "HOME": "/tmp/home", "ANTHROPIC_API_KEY": "planted"}
    with mock.patch.object(B.os, "environ", planted), mock.patch.object(B, "_run", side_effect=fake_run):
        receipt = B.BackgroundAgentClient(clock=lambda: 1, sleeper=lambda _n: None).launch(
            "task", "/tmp", "camus-test", "claude-opus-4-8", effort="high",
        )
    launch = next(item for item in calls if "--bg" in item["argv"])
    index = launch["argv"].index("--setting-sources")
    assert launch["argv"][index + 1] == ""
    assert "--strict-mcp-config" in launch["argv"]
    settings = launch["argv"].index("--settings")
    assert json.loads(launch["argv"][settings + 1]) == {"outputStyle": "Concise"}
    assert launch["argv"][-2:] == ["--", "task"]
    assert "ANTHROPIC_API_KEY" not in launch["env"]
    assert receipt["billingMode"] == "claude_ai_account_quota"


class FakeClient(B.BackgroundAgentClient):
    def __init__(self, states, transcript, clock_values):
        self.states = iter(states)
        self.transcript = transcript
        self.clock_values = iter(clock_values)
        super().__init__(projects_dir=os.path.dirname(os.path.dirname(transcript)),
                         clock=lambda: next(self.clock_values), sleeper=lambda _n: None)

    def find(self, cwd, short_id=None, session_id=None, name=None):
        try:
            state = next(self.states)
        except StopIteration:
            state = "done"
        return {"id": short_id, "sessionId": session_id, "name": name, "state": state}


def test_wait_returns_durable_receipt_and_never_invents_billing():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [{"type": "assistant", "message": {
            "model": "claude-sonnet-4-7", "usage": {"output_tokens": 3},
            "content": [{"type": "text", "text": "ok"}]}}])
        client = FakeClient(["working", "done"], path, [1.0, 2.0, 3.0])
        receipt = client.wait({
            "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
            "billingMode": "claude_ai_account_quota", "surface": "claude_background_session",
        }, timeout_seconds=10, poll_seconds=0.1)
        assert receipt["state"] == "done"
        assert receipt["durationMs"] == 2000
        assert receipt["billingMode"] == "claude_ai_account_quota"
        assert receipt["modelActual"] == "claude-sonnet-4-7"
        assert receipt["usage"]["outputTokens"] == 3


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
