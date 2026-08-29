#!/usr/bin/env python3
"""Hermetic contracts for Studio-profile shadow reviews."""

import json
import os
import tempfile
from unittest import mock

import model_trials
import review_trial
from test_reviewer_backends import fixture_server, repo_fixture


def _config(path, base_url, provider="fixture"):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({
            "connections": {
                "fixture": {"kind": "loopback", "baseUrl": base_url},
            },
            "backends": {
                "fixture_qwen": {
                    "kind": "openai_compat", "provider": provider,
                    "connection": "fixture", "protocol": "chat_completions",
                    "trainingOrg": "alibaba", "modelFamily": "qwen",
                    "inferenceOperator": "fixture", "auth": {"kind": "none"},
                    "models": ["qwen-test"], "seats": ["reviewer"],
                },
            },
        }, handle)
    os.chmod(path, 0o600)


def test_lists_profiles_without_credentials_or_endpoints():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "models.json")
        _config(path, "http://127.0.0.1:1234/v1")
        env = {"CAMUS_MODELS_FILE": path}
        rows = model_trials.list_profiles(env)
        assert rows == [{
            "backend": "fixture_qwen", "model": "qwen-test", "provider": "fixture",
            "trainingOrg": "alibaba", "transport": "loopback", "connection": "fixture",
            "credential": "not_required", "standing": "experimental_shadow",
            "finalGate": "codex",
        }]
        assert "127.0.0.1" not in json.dumps(rows)


def test_openrouter_refuses_before_trial_authority_endpoint_or_provider_work():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "models.json")
        _config(path, "http://127.0.0.1:9/v1", provider="openrouter")
        env = {
            "CAMUS_MODELS_FILE": path,
            "CAMUS_HOME": os.path.join(root, "camus"),
            "STUDIO_GRANDFATHER_DIR": os.path.join(root, "studio"),
        }
        with mock.patch.object(model_trials, "_endpoint") as endpoint, \
                mock.patch.object(model_trials.review_trial, "issue") as issue, \
                mock.patch.object(model_trials, "_json_command") as provider_process:
            try:
                model_trials.run_review(
                    "fixture_qwen", "qwen-test", root, "review fixture", env=env,
                )
                raise AssertionError("OpenRouter must refuse before a reviewer trial can start")
            except model_trials.TrialError as exc:
                assert "provider openrouter is refused" in str(exc)
                assert "upstream route" in str(exc)
            endpoint.assert_not_called()
            issue.assert_not_called()
            provider_process.assert_not_called()

        # The refusal is provider-specific; an otherwise identical direct
        # profile retains the existing provider-neutral validation behavior.
        _config(path, "http://127.0.0.1:9/v1", provider="fixture")
        profiles = model_trials.load_profiles(env)
        assert profiles["fixture_qwen"]["provider"] == "fixture"


def test_runs_signed_shadow_review_and_keeps_codex_as_gate():
    with repo_fixture() as (root, repo, wt, _reviews), fixture_server() as server:
        path = os.path.join(root, "models.json")
        _config(path, "http://127.0.0.1:%d/v1" % server.server_port)
        env = os.environ.copy()
        env.update({
            "CAMUS_MODELS_FILE": path,
            "CAMUS_HOME": os.path.join(root, "camus"),
            "STUDIO_GRANDFATHER_DIR": os.path.join(root, "studio"),
            "CAMUS_HTTP_REVIEW_START_CHUNK_S": "1",
            "CAMUS_HTTP_REVIEW_AWAIT_CHUNK_S": "1",
            "CAMUS_HTTP_REVIEW_IDLE_S": "5",
            "CAMUS_HTTP_REVIEW_TIMEOUT_S": "15",
        })
        result = model_trials.run_review(
            "fixture_qwen", "qwen-test", wt, "implement fixture behavior",
            repo=repo, nonce="trace:trial", env=env,
        )
        assert result["ran"] is True and result["clean"] is True, result
        assert result["standing"] == "experimental_shadow"
        assert result["finalGate"] == "codex"
        assert result["qualification"].startswith("trial1:")
        assert result["inputFingerprint"].startswith("fp1:")
        assert os.stat(result["receiptPath"]).st_mode & 0o777 == 0o600


def test_profile_file_must_be_private():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "models.json")
        _config(path, "http://127.0.0.1:1234/v1")
        os.chmod(path, 0o644)
        try:
            model_trials.list_profiles({"CAMUS_MODELS_FILE": path})
            raise AssertionError("world-readable model profiles should refuse")
        except model_trials.TrialError as exc:
            assert "chmod 600" in str(exc)


def test_ssh_preflight_requires_the_exact_only_forward():
    connection = {
        "remote_address": "127.0.0.1", "remote_port": 11434,
    }
    safe = "\n".join([
        "hostname gpu.internal",
        "controlmaster false",
        "clearallforwardings no",
        "forwardx11 no",
        "permitlocalcommand no",
        "tunnel false",
        "localforward [127.0.0.1]:40123 [127.0.0.1]:11434",
        "forwardagent no",
    ])
    model_trials._screen_ssh_config(safe, 40123, connection)
    refused = [
        safe + "\nlocalforward 127.0.0.1:5000 127.0.0.1:5000",
        safe.replace(":40123 ", ":4012 "),
        safe.replace("[127.0.0.1]:11434", "[127.0.0.1]:11435"),
        safe + "\nremoteforward 127.0.0.1:9 127.0.0.1:9",
        safe.replace("forwardagent no", "forwardagent yes"),
    ]
    for raw in refused:
        try:
            model_trials._screen_ssh_config(raw, 40123, connection)
            raise AssertionError("unsafe effective SSH configuration should refuse")
        except model_trials.TrialError:
            pass


def test_trial_authority_expires_detects_tamper_and_rotates_with_credentials():
    with tempfile.TemporaryDirectory() as root:
        env = {
            "STUDIO_GRANDFATHER_DIR": root,
            "FIXTURE_KEY": "credential-a",
        }
        record = review_trial.issue(
            "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "direct_https", "fixture", "https://example.invalid/v1",
            "env", "FIXTURE_KEY", env=env, now=100, ttl_seconds=60,
        )
        trial = record["trial"]
        assert "credential-a" not in json.dumps(record)
        assert review_trial.accepted_training_org(
            trial, "http_openai_compat", "fixture_qwen", "qwen-test",
            "direct_https", "fixture", "https://example.invalid/v1",
            "env", "FIXTURE_KEY", env=env, now=159,
        ) == "alibaba"
        try:
            review_trial.accepted_training_org(
                trial, "http_openai_compat", "fixture_qwen", "qwen-test",
                "direct_https", "fixture", "https://example.invalid/v1",
                "env", "FIXTURE_KEY", env=env, now=160,
            )
            raise AssertionError("expired trial authority should refuse")
        except ValueError as exc:
            assert "expired" in str(exc)

        path = review_trial.record_path(trial, env)
        with open(path, encoding="utf-8") as handle:
            tampered = json.load(handle)
        tampered["expires_at"] += 60
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(tampered, handle)
        os.chmod(path, 0o600)
        try:
            review_trial.accepted_training_org(
                trial, "http_openai_compat", "fixture_qwen", "qwen-test",
                "direct_https", "fixture", "https://example.invalid/v1",
                "env", "FIXTURE_KEY", env=env, now=150,
            )
            raise AssertionError("tampered trial authority should refuse")
        except ValueError as exc:
            assert "HMAC" in str(exc)

        # Restoring the signed record cannot make it valid under a rotated credential value.
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(record, handle)
        os.chmod(path, 0o600)
        rotated = dict(env, FIXTURE_KEY="credential-b")
        try:
            review_trial.accepted_training_org(
                trial, "http_openai_compat", "fixture_qwen", "qwen-test",
                "direct_https", "fixture", "https://example.invalid/v1",
                "env", "FIXTURE_KEY", env=rotated, now=150,
            )
            raise AssertionError("credential rotation should void the trial authority")
        except ValueError as exc:
            assert "credential_revision" in str(exc) or "trial" in str(exc)


def test_trial_request_authority_is_scoped_to_the_explicit_http_shadow_route():
    trial = "trial1:" + "a" * 64
    valid, error = model_trials.review_request.build_request(
        "/tmp/camus-wt-safe", 1, effort="medium", nonce="trace:test",
        model="qwen-test", backend="http_openai_compat", scope="light",
        qualification=trial, origin="camus_model_trial", operator="fixture",
        transport="loopback", connection="fixture",
    )
    assert error is None and valid["qualification"] == trial
    for drift in (
        {"backend": "codex"},
        {"scope": "full"},
        {"origin": "camus-test"},
    ):
        request = {
            "effort": "medium", "nonce": "trace:test", "model": "qwen-test",
            "backend": "http_openai_compat", "scope": "light",
            "qualification": trial, "origin": "camus_model_trial",
            "operator": "fixture", "transport": "loopback", "connection": "fixture",
        }
        request.update(drift)
        record, error = model_trials.review_request.build_request(
            "/tmp/camus-wt-safe", 1, **request,
        )
        assert record is None and "explicit light" in error


def test_trial_receipt_directory_cannot_collide_on_a_shared_worktree_basename():
    first = model_trials._review_directory(
        "/tmp/camus-home", "xai", "grok-4.6", "/repos/one/camus-wt-task",
    )
    second = model_trials._review_directory(
        "/tmp/camus-home", "xai", "grok-4.6", "/repos/two/camus-wt-task",
    )
    assert first != second
    assert os.path.basename(first).startswith("camus-wt-task-")
    assert os.path.basename(second).startswith("camus-wt-task-")


def test_private_receipt_reader_refuses_public_or_symlinked_evidence():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "receipt.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"ok": True}, handle)
        os.chmod(path, 0o600)
        value, content = model_trials._private_receipt(path)
        assert value == {"ok": True} and content
        os.chmod(path, 0o644)
        try:
            model_trials._private_receipt(path)
            raise AssertionError("public receipt should refuse")
        except model_trials.TrialError as exc:
            assert "private regular file" in str(exc)
        os.chmod(path, 0o600)
        link = os.path.join(root, "receipt-link.json")
        os.symlink(path, link)
        try:
            model_trials._private_receipt(link)
            raise AssertionError("symlinked receipt should refuse")
        except model_trials.TrialError as exc:
            assert "accessible durable receipt" in str(exc)


def main():
    tests = [test_lists_profiles_without_credentials_or_endpoints,
             test_openrouter_refuses_before_trial_authority_endpoint_or_provider_work,
             test_runs_signed_shadow_review_and_keeps_codex_as_gate,
             test_profile_file_must_be_private,
             test_ssh_preflight_requires_the_exact_only_forward,
             test_trial_authority_expires_detects_tamper_and_rotates_with_credentials,
             test_trial_request_authority_is_scoped_to_the_explicit_http_shadow_route,
             test_trial_receipt_directory_cannot_collide_on_a_shared_worktree_basename,
             test_private_receipt_reader_refuses_public_or_symlinked_evidence]
    for test in tests:
        test()
        print("ok - " + test.__name__)
    print("test_model_trials.py: %d passed" % len(tests))


if __name__ == "__main__":
    main()
