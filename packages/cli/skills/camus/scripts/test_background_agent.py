#!/usr/bin/env python3
"""Hermetic contract tests for the Claude background-session adapter."""

import json
import errno
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


def test_terminal_marker_survives_allowlisted_metadata_suffix_and_prefix_is_bound():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "session.jsonl")
        _write_jsonl(path, [
            {"type": "assistant", "message": {
                "model": "claude-opus-4-8", "usage": {"output_tokens": 5},
                "content": [{"type": "text", "text": "done"}]}},
            {"type": "system", "subtype": "turn_duration", "durationMs": 373737,
             "timestamp": "2026-08-21T12:29:04.536Z"},
        ])
        sealed = B.transcript_receipt(path)["transcriptSha256"]
        with open(path, "a", encoding="utf-8") as fh:
            for kind in ("last-prompt", "custom-title", "agent-name", "mode",
                         "permission-mode", "atis-latch"):
                fh.write(json.dumps({"type": kind}) + "\n")
        receipt = B.transcript_receipt(path)
        assert receipt["terminalTurnMarker"] is True
        assert receipt["terminalTurnDurationMs"] == 373737
        assert B.transcript_has_metadata_only_suffix(path, sealed) is True


def test_transcript_prefix_verifier_rejects_semantic_suffix():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "session.jsonl")
        _write_jsonl(path, [{"type": "system", "subtype": "turn_duration", "durationMs": 1,
                            "timestamp": "2026-08-21T12:00:00.000Z"}])
        sealed = B.transcript_receipt(path)["transcriptSha256"]
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"content": []}}) + "\n")
        assert B.transcript_has_metadata_only_suffix(path, sealed) is False


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


def test_wait_marks_disappeared_session_stale_instead_of_waiting_four_hours():
    clock_values = iter([1.0, 2.0])
    client = B.BackgroundAgentClient(clock=lambda: next(clock_values), sleeper=lambda _n: None)
    with mock.patch.object(client, "find", return_value=None):
        receipt = client.wait({
            "cwd": "/tmp/repo", "shortId": "12345678",
            "sessionId": "12345678-1234-1234-1234-123456789abc", "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
        }, timeout_seconds=14400)
    assert receipt["state"] == "stale"
    assert "disappeared" in receipt["terminalReason"]


def test_wait_recovers_terminal_transcript_after_supervisor_row_disappears():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [
            {"type": "assistant", "message": {
                "model": "claude-sonnet-5", "usage": {"output_tokens": 52},
                "content": [{"type": "text", "text": '{"action":"fix_recheck"}'}]}},
            {"type": "system", "subtype": "turn_duration", "durationMs": 5086,
             "timestamp": "2026-08-21T13:44:54.493Z"},
        ])
        clock_values = iter([2.0, 3.0])
        client = B.BackgroundAgentClient(
            projects_dir=projects, clock=lambda: next(clock_values), sleeper=lambda _n: None,
        )
        with mock.patch.object(client, "find", return_value=None):
            receipt = client.wait({
                "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
                "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
            }, timeout_seconds=14400)
        assert receipt["state"] == "done"
        assert receipt["durationMs"] == 5086
        assert receipt["sessionWallMs"] == 2000
        assert receipt["lastAssistantText"] == '{"action":"fix_recheck"}'
        assert receipt["terminalTurnMarker"] is True


def test_wait_marks_dead_published_pid_stale():
    clock_values = iter([1.0, 2.0])
    client = B.BackgroundAgentClient(clock=lambda: next(clock_values), sleeper=lambda _n: None)
    with mock.patch.object(client, "find", return_value={
        "id": "12345678", "sessionId": "12345678-1234-1234-1234-123456789abc",
        "name": "n", "state": "working", "pid": 2147483647,
    }):
        receipt = client.wait({
            "cwd": "/tmp/repo", "shortId": "12345678",
            "sessionId": "12345678-1234-1234-1234-123456789abc", "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
        }, timeout_seconds=14400)
    assert receipt["state"] == "stale"
    assert "process" in receipt["terminalReason"]


def test_wait_bounds_working_row_without_pid_with_short_grace():
    current = [0.0]

    def clock():
        current[0] += 0.6
        return current[0]

    client = B.BackgroundAgentClient(clock=clock, sleeper=lambda _n: None)
    with mock.patch.object(client, "find", return_value={
        "id": "12345678", "sessionId": "12345678-1234-1234-1234-123456789abc",
        "name": "n", "state": "working",
    }):
        receipt = client.wait({
            "cwd": "/tmp/repo", "shortId": "12345678",
            "sessionId": "12345678-1234-1234-1234-123456789abc", "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
        }, timeout_seconds=14400, stale_after_seconds=1)
    assert receipt["state"] == "stale"
    assert "stale-session bound" in receipt["terminalReason"]


def test_live_pid_ignores_short_stale_bound_until_normal_timeout_or_terminal():
    clock_values = iter([1.0, 2.0, 3.0])
    states = iter(("working", "done"))
    client = B.BackgroundAgentClient(clock=lambda: next(clock_values), sleeper=lambda _n: None)
    with mock.patch.object(client, "find", side_effect=lambda *_args, **_kwargs: {
        "id": "12345678", "sessionId": "12345678-1234-1234-1234-123456789abc",
        "name": "n", "state": next(states), "pid": os.getpid(),
    }):
        receipt = client.wait({
            "cwd": "/tmp/repo", "shortId": "12345678",
            "sessionId": "12345678-1234-1234-1234-123456789abc", "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
        }, timeout_seconds=10, stale_after_seconds=1)
    assert receipt["state"] == "done"


def test_idle_working_with_terminal_turn_marker_is_done():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [
            {"type": "assistant", "message": {
                "model": "claude-opus-4-8", "usage": {"output_tokens": 7},
                "content": [{"type": "text", "text": "finished"}]}},
            {"type": "system", "subtype": "turn_duration", "durationMs": 1234,
             "timestamp": "2026-08-21T12:00:00.000Z"},
        ])
        clock_values = iter([1.0, 2.0])
        client = B.BackgroundAgentClient(
            projects_dir=projects, clock=lambda: next(clock_values), sleeper=lambda _n: None,
        )
        with mock.patch.object(client, "find", return_value={
            "id": "12345678", "sessionId": sid, "name": "n",
            "status": "idle", "state": "working",
        }):
            receipt = client.wait({
                "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
                "startedAt": 1000, "modelRequested": "claude-opus-4-8", "effortRequested": "medium",
            }, timeout_seconds=10, stale_after_seconds=1)
        assert receipt["state"] == "done"
        assert receipt["terminalTurnMarker"] is True
        assert receipt["terminalTurnDurationMs"] == 1234
        assert receipt["terminalTurnAt"] is not None
        assert receipt["usage"]["outputTokens"] == 7


def test_idle_working_without_terminal_turn_marker_remains_nonterminal():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [{"type": "assistant", "message": {
            "model": "claude-opus-4-8", "content": [{"type": "text", "text": "partial"}],
        }}])
        current = [0.0]
        client = B.BackgroundAgentClient(
            projects_dir=projects,
            clock=lambda: (current.__setitem__(0, current[0] + 0.6) or current[0]),
            sleeper=lambda _n: None,
        )
        with mock.patch.object(client, "find", return_value={
            "id": "12345678", "sessionId": sid, "name": "n",
            "status": "idle", "state": "working",
        }):
            receipt = client.wait({
                "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
                "startedAt": 1000, "modelRequested": "claude-opus-4-8", "effortRequested": "medium",
            }, timeout_seconds=10, stale_after_seconds=1)
        assert receipt["state"] == "stale"
        assert "stale-session bound" in receipt["terminalReason"]


def test_busy_working_with_valid_terminal_marker_is_done():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [{"type": "system", "subtype": "turn_duration",
                             "durationMs": 196292, "timestamp": "2026-08-21T12:46:45.977Z"}])
        client = B.BackgroundAgentClient(
            projects_dir=projects, clock=lambda: 2.0, sleeper=lambda _n: None,
        )
        with mock.patch.object(client, "find", return_value={
            "id": "12345678", "sessionId": sid, "name": "n",
            "status": "busy", "state": "working",
        }):
            receipt = client.wait({
                "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
                "startedAt": 1000, "modelRequested": "claude-opus-4-8", "effortRequested": "medium",
            }, timeout_seconds=10, stale_after_seconds=1)
        assert receipt["state"] == "done"
        assert receipt["durationMs"] == 196292
        assert receipt["terminalTurnAt"] == "2026-08-21T12:46:45.977Z"


def test_blocked_controller_with_valid_terminal_marker_is_done():
    with tempfile.TemporaryDirectory() as projects:
        cwd = "/tmp/repo"
        sid = "12345678-1234-1234-1234-123456789abc"
        path = os.path.join(projects, B.project_slug(cwd), sid + ".jsonl")
        _write_jsonl(path, [
            {"type": "assistant", "message": {
                "model": "claude-sonnet-5", "usage": {"output_tokens": 7},
                "content": [{"type": "text", "text": '{"action":"human","reason":"cap"}'}],
            }},
            {"type": "system", "subtype": "turn_duration", "durationMs": 3570,
             "timestamp": "2026-08-21T16:25:27.775Z"},
        ])
        client = B.BackgroundAgentClient(
            projects_dir=projects, clock=lambda: 2.0, sleeper=lambda _n: None,
        )
        with mock.patch.object(client, "find", return_value={
            "id": "12345678", "sessionId": sid, "name": "n",
            "status": "idle", "state": "blocked",
        }):
            receipt = client.wait({
                "cwd": cwd, "shortId": "12345678", "sessionId": sid, "name": "n",
                "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
            }, timeout_seconds=10, stale_after_seconds=1)
        assert receipt["state"] == "done"
        assert receipt["terminalTurnMarker"] is True
        assert receipt["lastAssistantText"] == '{"action":"human","reason":"cap"}'


def test_permission_denied_pid_probe_is_alive():
    clock_values = iter([1.0, 2.0, 3.0])
    states = iter(("working", "done"))
    client = B.BackgroundAgentClient(clock=lambda: next(clock_values), sleeper=lambda _n: None)
    with mock.patch.object(client, "find", side_effect=lambda *_args, **_kwargs: {
        "id": "12345678", "sessionId": "12345678-1234-1234-1234-123456789abc",
        "name": "n", "state": next(states), "pid": 4242,
    }), mock.patch.object(B.os, "kill", side_effect=OSError(errno.EPERM, "not allowed")):
        receipt = client.wait({
            "cwd": "/tmp/repo", "shortId": "12345678",
            "sessionId": "12345678-1234-1234-1234-123456789abc", "name": "n",
            "startedAt": 1000, "modelRequested": "sonnet", "effortRequested": "low",
        }, timeout_seconds=10, stale_after_seconds=1)
    assert receipt["state"] == "done"


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
