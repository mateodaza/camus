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


def test_controller_decision_keys_deduplicate_replay_but_allow_corrected_evidence():
    task_id = "task-a"
    human = D._decision_event_key(task_id, "decision", 1, {"action": "human"})
    fixed = D._decision_event_key(task_id, "decision", 1, {"action": "fix_recheck"})
    assert human == D._decision_event_key(task_id, "decision", 1, {"action": "human"})
    assert human != fixed
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        assert log.append("controller.decision", trace_id="t", task_id=task_id,
                          key=human, data={"action": "human"}) is True
        assert log.append("controller.decision", trace_id="t", task_id=task_id,
                          key=human, data={"action": "human"}) is False
        assert log.append("controller.decision", trace_id="t", task_id=task_id,
                          key=fixed, data={"action": "fix_recheck"}) is True
        assert [row["data"]["action"] for row in log.records()] == ["human", "fix_recheck"]


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


def test_direct_output_budget_stop_is_recorded_once_before_review_or_next_model():
    with tempfile.TemporaryDirectory() as root:
        task_id = "task-a"
        node = {
            "taskId": task_id, "brief": "bounded task", "status": "running",
            "branch": "camus/feat/f/task-a", "worktree": os.path.join(root, "worktree"),
        }
        run = {
            "state": {"featId": "feat-a", "feat": "F", "kernel": {
                "phase": "task_open", "traceId": "trace:a1", "activeTaskId": task_id,
            }, "status": "running", "tasks": [node]},
            "args": {"feat": "F", "tasks": ["bounded task"], "targetPath": root},
            "nodes": [node], "specs": ["bounded task"], "statePath": os.path.join(root, "state.json"),
        }
        options = SimpleNamespace(
            base=root, repo=None, experiment=None, ledger=os.path.join(root, "episodes.jsonl"),
            maker_model="claude-opus-4-8", maker_effort="high", reviewer_backend="codex",
            reviewer_model="gpt-5.6-sol", reviewer_effort="high", controller_model="sonnet",
            wall_seconds=None, token_budget=None, retry_budget=None, verify_timeout=10,
            controller_timeout=10, agent_timeout=10, round_cap=2, max_tasks=None,
            claude_binary="claude",
        )
        receipt = {
            "state": "done", "modelActual": "claude-opus-4-8", "modelsObserved": ["claude-opus-4-8"],
            "usage": {"outputTokens": 53357}, "transcriptSha256": "sha256:" + "1" * 64,
        }

        def fake_run_agent(_client, log, **kwargs):
            log.append("agent.completed", trace_id="trace:a1", task_id=task_id,
                       key="%s:maker:1" % task_id, data={
                           **receipt, "durationMs": 1,
                           "usage": {"outputTokens": 53357},
                       })
            return receipt

        budget_reason = "direct output-token budget exhausted (53357/50000)"
        post_budget = mock.Mock(side_effect=[None, budget_reason, budget_reason])
        recorded = mock.Mock(return_value={"action": "maker_usage_recorded"})
        with mock.patch.object(D.kernel, "_validated_run", return_value=run), \
                mock.patch.object(D.kernel, "_resolve_repo", return_value=root), \
                mock.patch.object(D.kernel, "_selected_index", return_value=(0, None)), \
                mock.patch.object(D.kernel, "task_payload", return_value={
                    "loopArgs": {"task": "bounded task"}, "repo": root,
                }), \
                mock.patch.object(D.kernel, "open_task", return_value={
                    "loopArgs": {"task": "bounded task"}, "repo": root,
                    "worktree": node["worktree"], "branch": node["branch"],
                }), \
                mock.patch.object(D, "run_agent", side_effect=fake_run_agent) as maker, \
                mock.patch.object(D, "_record_background_usage", recorded), \
                mock.patch.object(D, "_post_agent_budget_stop", post_budget), \
                mock.patch.object(D.kernel, "review_task") as review, \
                mock.patch.object(D, "controller_decision") as controller:
            first = D._drive_feature("feat-a", options)
            second = D._drive_feature("feat-a", options)

        assert first["action"] == "stop" and budget_reason in first["reason"]
        assert second["action"] == "stop" and budget_reason in second["reason"]
        assert maker.call_count == 1, "replay must not launch a second maker"
        assert recorded.call_args.args[-1]["usage"]["outputTokens"] == 53357
        review.assert_not_called()
        controller.assert_not_called()
        episodes = D.evals.Ledger(options.ledger).records()
        assert len(episodes) == 1
        assert episodes[0]["outcome"]["verificationPass"] is False
        assert episodes[0]["economics"]["outputTokens"] == 53357
        assert run["state"]["status"] == "needs_human"
        assert run["state"]["stage"] == "kernel_stop"
        assert run["state"]["kernel"]["phase"] == "stopped"
        assert node["status"] == "needs_human"


def test_metrics_expose_unfinished_launched_session_without_inventing_usage():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        node = {"taskId": "task-a", "directMakerUsage": {"totals": {"outputTokens": 53357}}}
        run = {"state": {"kernel": {"traceId": "trace:a1"}}}
        log.append("agent.launched", trace_id="trace:a1", task_id="task-a",
                   key="task-a:maker:1", data={"sessionId": "maker"})
        log.append("agent.completed", trace_id="trace:a1", task_id="task-a",
                   key="task-a:maker:1", data={
                       "durationMs": 10, "usage": {"outputTokens": 53357},
                       "transcriptSha256": "sha256:" + "1" * 64,
                   })
        log.append("agent.launched", trace_id="trace:a1", task_id="task-a",
                   key="task-a:fix:2", data={"sessionId": "stopped-fix"})
        metrics, _transcripts = D._task_metrics(run, node, log)
        assert metrics["attemptedCalls"] == 2
        assert metrics["measuredCalls"] == 1
        assert metrics["attemptedSessions"] == 2
        assert metrics["measuredSessions"] == 1
        assert metrics["incompleteSessions"] == 1
        assert metrics["measurementCoverage"] == "incomplete_background_models_missing_terminal_receipts"
        assert metrics["outputTokens"] == 53357


def test_prelaunch_direct_output_reserve_is_typed_and_exposed():
    run = {"args": {}, "state": {"tasks": [{"directMakerUsage": {
        "receipts": [{"usage": {"outputTokens": 69793}}],
    }}], "kernel": {
        "budgets": {"tokens": 80000}, "usage": {"tokens": 0, "retries": 0},
    }}}
    with mock.patch.object(D.kernel, "_validated_run", return_value=run):
        evidence = D._direct_output_budget_evidence("feat-a", "/tmp")
        stop = D._pre_agent_budget_stop("feat-a", "/tmp")
    assert evidence["remainingDirectOutputTokens"] == 10207
    assert evidence["reserveTokens"] == 20000
    assert evidence["reserveAvailable"] is False
    assert "direct output reserve exhausted" in stop


def test_recovered_terminal_timing_overrides_adoption_wall_and_stale_transport_state():
    old = {"durationMs": 1054805, "state": "stale", "terminalReason": "supervisor disappeared",
           "modelRequested": "claude-opus-4-8",
           "effortRequested": "medium", "cwd": "/tmp/repo", "sessionId": "sid"}
    enriched = {
        "transcriptPath": "/tmp/t.jsonl", "transcriptSha256": "sha256:" + "1" * 64,
        "terminalTurnMarker": True, "terminalTurnDurationMs": 373737,
        "terminalTurnAt": "2026-08-21T12:29:04.536Z", "usage": {"outputTokens": 7},
    }
    with mock.patch.object(D.background_agent, "transcript_path", return_value="/tmp/t.jsonl"), \
            mock.patch.object(D.background_agent, "transcript_receipt", return_value=enriched):
        recovered = D._recover_completed(old)
    assert recovered["durationMs"] == 373737
    assert recovered["sessionWallMs"] == 1054805
    assert recovered["terminalTurnAt"] == "2026-08-21T12:29:04.536Z"
    assert recovered["state"] == "done"
    assert recovered["terminalReason"] == "terminal transcript marker"
    replay = D._recover_completed({**old, "durationMs": 373737, "sessionWallMs": 1054805})
    assert replay["durationMs"] == 373737 and replay["sessionWallMs"] == 1054805


def test_recovery_accepts_metadata_suffix_and_preserves_sealed_hash():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "session.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {
                "model": "claude-opus-4-8", "usage": {"output_tokens": 7},
                "content": [{"type": "text", "text": "done"}]}}) + "\n")
            fh.write(json.dumps({"type": "system", "subtype": "turn_duration",
                                 "durationMs": 373737,
                                 "timestamp": "2026-08-21T12:29:04.536Z"}) + "\n")
        sealed = D.background_agent.transcript_receipt(path)["transcriptSha256"]
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "atis-latch"}) + "\n")
        old = {"cwd": root, "sessionId": "12345678-1234-1234-1234-123456789abc",
               "durationMs": 1054805, "transcriptSha256": sealed}
        with mock.patch.object(D.background_agent, "transcript_path", return_value=path):
            recovered = D._recover_completed(old)
        assert recovered["transcriptSha256"] == sealed
        assert recovered["durationMs"] == 373737


def test_recovery_refuses_semantic_suffix_after_sealed_turn():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "session.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "system", "subtype": "turn_duration",
                                 "durationMs": 373737,
                                 "timestamp": "2026-08-21T12:29:04.536Z"}) + "\n")
        sealed = D.background_agent.transcript_receipt(path)["transcriptSha256"]
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {"content": []}}) + "\n")
        old = {"cwd": root, "sessionId": "12345678-1234-1234-1234-123456789abc",
               "durationMs": 1054805, "transcriptSha256": sealed}
        with mock.patch.object(D.background_agent, "transcript_path", return_value=path):
            try:
                D._recover_completed(old)
            except D.background_agent.BackgroundAgentError as exc:
                assert "hash drifted" in str(exc)
            else:
                raise AssertionError("semantic suffix must not rebind completed evidence")


def test_metrics_rebuild_uses_validated_terminal_duration_for_old_event():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        node = {"taskId": "task-a", "directMakerUsage": {"totals": {}}}
        run = {"state": {"kernel": {"traceId": "trace:a1"}}}
        log.append("task.started", trace_id="trace:a1", task_id="task-a", key="task-a",
                   data={})
        log.append("agent.completed", trace_id="trace:a1", task_id="task-a",
                   key="task-a:maker:1", data={
                       "cwd": root, "sessionId": "12345678-1234-1234-1234-123456789abc",
                       "durationMs": 1054805, "transcriptSha256": "sha256:" + "1" * 64,
                       "usage": {"outputTokens": 7},
                   })
        with mock.patch.object(D.background_agent, "transcript_path",
                               return_value=os.path.join(root, "transcript.jsonl")), \
                mock.patch.object(D.background_agent, "transcript_receipt", return_value={
                    "transcriptPath": os.path.join(root, "transcript.jsonl"),
                    "transcriptSha256": "sha256:" + "1" * 64,
                    "terminalTurnMarker": True, "terminalTurnDurationMs": 373737,
                }):
            metrics, _transcripts = D._task_metrics(run, node, log)
        assert metrics["modelWallMs"] == 373737


def test_recovered_completed_refuses_transcript_hash_drift():
    old = {
        "cwd": "/tmp/repo", "sessionId": "12345678-1234-1234-1234-123456789abc",
        "durationMs": 1054805, "transcriptSha256": "sha256:" + "1" * 64,
    }
    with mock.patch.object(D.background_agent, "transcript_path", return_value="/tmp/t.jsonl"), \
            mock.patch.object(D.background_agent, "transcript_receipt", return_value={
                "transcriptPath": "/tmp/t.jsonl",
                "transcriptSha256": "sha256:" + "2" * 64,
            }):
        try:
            D._recover_completed(old)
        except D.background_agent.BackgroundAgentError as exc:
            assert "hash drifted" in str(exc)
        else:
            raise AssertionError("completed evidence must not be rebound after transcript drift")


def test_metrics_rebuild_missing_transcript_uses_sealed_event_duration():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        node = {"taskId": "task-a", "directMakerUsage": {"totals": {}}}
        run = {"state": {"kernel": {"traceId": "trace:a1"}}}
        log.append("agent.completed", trace_id="trace:a1", task_id="task-a",
                   key="task-a:maker:1", data={
                       "durationMs": 4242, "usage": {"outputTokens": 7},
                       "transcriptSha256": "sha256:" + "1" * 64,
                   })
        with mock.patch.object(D.background_agent, "transcript_path", return_value=None):
            metrics, _transcripts = D._task_metrics(run, node, log)
        assert metrics["modelWallMs"] == 4242


def test_incomplete_episode_wall_uses_persisted_terminal_boundary_on_rebuild():
    with tempfile.TemporaryDirectory() as root:
        log = D.EventLog("feat-a", base=root)
        node = {"taskId": "task-a", "directMakerUsage": {"totals": {}}}
        run = {
            "state": {"featId": "feat-a", "kernel": {"traceId": "trace:a1"}},
            "nodes": [node], "specs": ["bounded task"], "args": {},
        }
        ledger = D.evals.Ledger(os.path.join(root, "episodes.jsonl"))
        with mock.patch.object(D.time, "time", side_effect=[100.0, 154.0]):
            log.append("task.started", trace_id="trace:a1", task_id="task-a", key="task-a")
            log.append("task.incomplete", trace_id="trace:a1", task_id="task-a",
                       key="task-a", data={"action": "stop"})
        D._record_incomplete_episode(
            ledger, log, run, node,
            {"makerModel": "opus", "reviewerModel": "sol"}, None,
            {"action": "stop", "reason": "budget"},
        )
        assert ledger.records()[0]["economics"]["wallMs"] == 54000


def test_vanished_controller_replay_returns_sealed_fix_recheck_without_relaunch():
    """End-to-end: a sealed stale controller whose exact transcript ends in a valid turn-duration
    marker replays as a done fix_recheck decision, launches no replacement controller, and records
    after an earlier false human observation via the corrected action-bound decision key."""
    with tempfile.TemporaryDirectory() as root:
        task_id = "task-a"
        round_no = 1
        session_id = "12345678-1234-1234-1234-123456789abc"
        # Real exact controller transcript: a constrained fix_recheck verdict whose semantic turn is
        # sealed by a terminal turn-duration marker.
        transcript = os.path.join(root, "controller.jsonl")
        with open(transcript, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "assistant", "message": {
                "model": "sonnet", "usage": {"output_tokens": 5},
                "content": [{"type": "text",
                             "text": '{"action":"fix_recheck","reason":"fresh maker clears the finding"}'}],
            }}) + "\n")
            fh.write(json.dumps({"type": "system", "subtype": "turn_duration",
                                 "durationMs": 373737,
                                 "timestamp": "2026-08-21T12:29:04.536Z"}) + "\n")
        sealed = D.background_agent.transcript_receipt(transcript)["transcriptSha256"]

        log = D.EventLog("feat-a", base=root)
        # An earlier false human observation was recorded under the human-bound decision key while the
        # supervisor was disappearing mid-turn.
        human_key = D._decision_event_key(task_id, "decision", round_no, {"action": "human"})
        assert log.append("controller.decision", trace_id="t", task_id=task_id, key=human_key,
                          data={"action": "human", "reason": "supervisor vanished mid-turn"}) is True
        # The controller turn completed but was sealed `stale` before the transcript's terminal row
        # became visible. Its public receipt carries the sealed hash and session wall, no verdict text.
        controller_key = "%s:controller:%d" % (task_id, round_no)
        log.append("agent.completed", trace_id="t", task_id=task_id, key=controller_key, data={
            "state": "stale", "terminalReason": "supervisor disappeared",
            "cwd": root, "sessionId": session_id, "durationMs": 1054805,
            "modelRequested": "sonnet", "effortRequested": "low",
            "transcriptSha256": sealed,
        })

        client = FakeClient()
        # Mock only at the Claude transcript boundary; EventLog/run_agent/_recover_completed/
        # controller_decision run for real.
        with mock.patch.object(D.background_agent, "transcript_path", return_value=transcript):
            decision = D.controller_decision(
                client, log, trace_id="t", feat_id="feat-a", task_id=task_id, attempt=round_no,
                cwd=root, review={"blocking": [{"id": "b1"}]}, model="sonnet",
                timeout=10, max_rounds=3,
            )
        # The vanished turn replays as its constrained fix_recheck verdict; no controller is relaunched.
        assert decision["action"] == "fix_recheck"
        assert decision["reason"] == "fresh maker clears the finding"
        assert client.launched == 0

        # The corrected verdict records under an action-bound key distinct from the false human one,
        # superseding it instead of being deduplicated away.
        fixed_key = D._decision_event_key(task_id, "decision", round_no, decision)
        assert fixed_key != human_key
        assert log.append("controller.decision", trace_id="t", task_id=task_id, key=fixed_key,
                          data=decision) is True
        actions = [row["data"]["action"] for row in log.records()
                   if row.get("type") == "controller.decision"]
        assert actions == ["human", "fix_recheck"]


def test_direct_output_reserve_rejects_negative_and_allows_zero_disable():
    run = {"args": {}, "state": {"tasks": [], "kernel": {
        "budgets": {"tokens": 80000}, "usage": {"tokens": 0, "retries": 0},
    }}}
    with mock.patch.object(D.kernel, "_validated_run", return_value=run):
        try:
            D._direct_output_budget_evidence("feat-a", "/tmp", reserve_tokens=-1)
        except D.DriverError as exc:
            assert "non-negative integer" in str(exc)
        else:
            raise AssertionError("negative reserve must be refused")
        evidence = D._direct_output_budget_evidence("feat-a", "/tmp", reserve_tokens=0)
    assert evidence["reserveTokens"] == 0 and evidence["reserveAvailable"] is True


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
        D._record_incomplete_episode(
            ledger, log, run, node,
            {"makerModel": "opus", "reviewerModel": "sol"},
            {"id": "ab", "armId": "opus-sol", "taskClass": "bounded_feature"},
            {"action": "stop", "reason": "maker failed"},
        )
        record = ledger.records()[0]
        assert len(ledger.records()) == 1
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
