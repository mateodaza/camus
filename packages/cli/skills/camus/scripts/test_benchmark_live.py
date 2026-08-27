#!/usr/bin/env python3
"""Hermetic tests for the resumable provider-backed Slice G runner."""
import json
import os
import subprocess
import tempfile
from unittest import mock

import benchmark_live as L
import benchmark_reviewers as B


def _models(path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({
            "connections": {"fixture": {"kind": "loopback", "port": 19192, "basePath": "/v1"}},
            "backends": {
                "qwen_fixture": {
                    "kind": "openai_compat", "provider": "fixture", "connection": "fixture",
                    "trainingOrg": "alibaba", "modelFamily": "qwen",
                    "inferenceOperator": "self_hosted", "auth": {"kind": "none"},
                    "models": ["qwen-fixture"], "seats": ["reviewer"],
                },
            },
        }, handle)
    os.chmod(path, 0o600)


def test_tracked_corpus_is_publishable_and_content_bound():
    corpus = L.load_corpus()
    assert len(corpus["cases"]) == 25
    assert {case["kind"] for case in corpus["cases"]} == {"defect", "clean", "kill_path"}
    assert L.corpus_version(corpus).startswith("corpus1:")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "benchmark-corpus.v1.schema.json"), encoding="utf-8") as handle:
        schema = json.load(handle)
    assert set(schema["required"]) == {"schemaVersion", "name", "promptEnvelopeVersion", "cases"}
    assert schema["properties"]["cases"]["minItems"] == 25


def test_corpus_refuses_path_escape_and_truth_drift():
    corpus = json.loads(json.dumps(L.load_corpus()))
    corpus["cases"][0]["patchFiles"] = {"../escape.py": "bad"}
    try:
        L.validate_corpus(corpus)
        raise AssertionError("path escape entered the public corpus")
    except L.LiveBenchmarkError as exc:
        assert "unsafe path" in str(exc) or "same paths" in str(exc)
    corpus = json.loads(json.dumps(L.load_corpus()))
    corpus["cases"][0]["expectedFindings"] = []
    try:
        L.validate_corpus(corpus)
        raise AssertionError("defect case lost its ground truth")
    except L.LiveBenchmarkError as exc:
        assert "case kind" in str(exc)


def test_finding_match_requires_file_line_and_semantic_tokens():
    case = next(case for case in L.load_corpus()["cases"] if case["caseId"] == "shell-injection-export")
    correct = [{
        "priority": 0, "title": "Shell injection from report name",
        "body": "The user-controlled name reaches shell=True.",
        "code_location": "exporter.py:4-5", "confidence_score": 0.99,
    }]
    assert L.detected_defects(case, correct) == ["shell-injection-export"]
    wrong_file = [dict(correct[0], code_location="other.py:4")]
    vague = [dict(correct[0], title="Looks risky", body="Please revisit this line")]
    assert L.detected_defects(case, wrong_file) == []
    assert L.detected_defects(case, vague) == []


def test_plan_freezes_real_profile_and_schedule_is_resumable_counterbalanced():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        env = {"CAMUS_MODELS_FILE": models}
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-fixture", env=env,
        )
        assert manifest["corpusVersion"] == L.corpus_version(corpus)
        assert manifest["candidates"][0]["transport"] == "loopback"
        assert state["candidateProfileBackend"] == "qwen_fixture"
        rows = L.schedule(manifest, [])
        assert len(rows) == 21 * 10 * 2
        first = rows[0]
        case = next(item for item in manifest["cases"] if item["caseId"] == first[1])
        receipt = B.seal_receipt({
            "schemaVersion": B.RECEIPT_SCHEMA_VERSION, "campaignId": manifest["campaignId"],
            "corpusVersion": manifest["corpusVersion"],
            "campaignDigest": B.campaign_digest(manifest),
            "executionDigest": B.execution_digest(state, manifest),
            "promptEnvelopeVersion": manifest["promptEnvelopeVersion"],
            "armId": first[0], "caseId": first[1], "caseKind": case["kind"], "repeat": first[2],
            "normalizerRan": False, "expectedDefects": case["expectedDefects"], "detectedDefects": [],
            "blockingFindingCount": 0, "identityMatch": False, "killPathPassed": None,
            "killControl": None,
            "toolUsing": False, "toolCallCorrect": None, "pseudoToolCallCount": 0,
            "contextSufficient": None, "mutationEntered": False,
            "containmentConclusive": None, "containmentBreach": None, "wallMs": 1,
            "latencyClass": "resident", "usage": None,
            "decoding": {"temperature": None, "seed": None, "pinned": False}, "rerunOf": None,
        }, manifest)
        remaining = L.schedule(manifest, [receipt])
        assert first not in remaining and len(remaining) == len(rows) - 1
        kill = L.schedule(manifest, [], include_kill=True)
        assert len(kill) == len(rows) + 4 * 3 * 2


def test_materialized_case_has_only_the_declared_working_tree_diff():
    case = next(case for case in L.load_corpus()["cases"] if case["caseId"] == "off-by-one-pages")
    with L._materialized(case) as worktree:
        branch = subprocess.run(
            ["git", "branch", "--show-current"], cwd=worktree,
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        assert branch == "camus/benchmark"
        assert os.path.basename(worktree) == "camus-wt-benchmark"
        prior_cwd = os.getcwd()
        try:
            os.chdir(worktree)
            assert L.http_review._guard_worktree(
                worktree, env={"CAMUS_REPO_ROOT": worktree},
            ) == os.path.realpath(worktree)
        finally:
            os.chdir(prior_cwd)
        changed = subprocess.run(
            ["git", "diff", "--name-only"], cwd=worktree,
            check=True, capture_output=True, text=True,
        ).stdout.strip().splitlines()
        assert changed == ["pages.py"]
        with open(os.path.join(worktree, "pages.py"), encoding="utf-8") as handle:
            assert "page_count + 1" in handle.read()


def test_candidate_receipt_compares_observed_model_identity():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-identity", env={"CAMUS_MODELS_FILE": models},
        )
        case = next(item for item in corpus["cases"] if item["kind"] == "defect")
        with mock.patch.object(L.model_trials, "run_review", return_value={
            "ran": True, "model": "substituted-model", "blocking": [], "usage": None,
        }):
            receipt, failure = L.run_cell(
                manifest, state, corpus, "candidate", case["caseId"], 1, env={},
            )
        assert failure is None
        assert receipt["normalizerRan"] is True
        assert receipt["identityMatch"] is False


def test_infrastructure_attempt_returns_only_a_stable_local_failure_code():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-infra-code", env={"CAMUS_MODELS_FILE": models},
        )
        case = next(item for item in corpus["cases"] if item["kind"] == "defect")
        with mock.patch.object(L.model_trials, "run_review", return_value={
            "ran": False,
            "errorCode": "provider_refused",
            "error": "remote text must not be persisted or printed",
        }):
            receipt, failure = L.run_cell(
                manifest, state, corpus, "candidate", case["caseId"], 1,
                env={"CAMUS_MODELS_FILE": models},
            )
        assert failure == "provider_refused"
        assert receipt["normalizerRan"] is False
        assert "error" not in receipt and "errorCode" not in receipt


def test_state_identity_drift_refuses_before_campaign_status_or_spend():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-state-drift", env={"CAMUS_MODELS_FILE": models},
        )
        state["candidateModel"] = "substituted-model"
        campaign_path = os.path.join(temp, "campaign.json")
        state_path = os.path.join(temp, "state.json")
        ledger = os.path.join(temp, "receipts.jsonl")
        L._atomic_json(campaign_path, manifest)
        L._atomic_json(state_path, state)
        with mock.patch.object(L, "run_cell", side_effect=AssertionError("provider call")):
            assert L.main([
                "status", "--campaign", campaign_path, "--state", state_path,
                "--ledger", ledger, "--json",
            ]) == 2


def test_inflight_marker_blocks_duplicate_spend_and_recovery_seals_unknown_outcome():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-inflight", env={"CAMUS_MODELS_FILE": models},
        )
        campaign_path = os.path.join(temp, "campaign.json")
        state_path = os.path.join(temp, "state.json")
        ledger = os.path.join(temp, "receipts.jsonl")
        L._atomic_json(campaign_path, manifest)
        L._atomic_json(state_path, state)
        arm_id, case_id, repeat = L.schedule(manifest, [])[0]
        marker = L._inflight_path(ledger)
        L._atomic_json(marker, {
            "schemaVersion": 1, "campaignId": manifest["campaignId"],
            "corpusVersion": manifest["corpusVersion"], "armId": arm_id,
            "caseId": case_id, "repeat": repeat, "startedAt": 1,
        })
        with mock.patch.object(L, "run_cell", side_effect=AssertionError("duplicate provider call")):
            assert L.main([
                "run", "--campaign", campaign_path, "--state", state_path,
                "--ledger", ledger, "--max-cells", "1",
            ]) == 2
        assert os.path.exists(marker)
        assert L.main([
            "recover", "--campaign", campaign_path, "--state", state_path,
            "--ledger", ledger, "--action", "seal-infra",
        ]) == 0
        receipts = B.load_ledger(ledger, manifest)
        assert len(receipts) == 1 and receipts[0]["normalizerRan"] is False
        assert not os.path.exists(marker)


def test_receipt_fsync_wins_over_a_stale_inflight_marker():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-post-append", env={"CAMUS_MODELS_FILE": models},
        )
        campaign_path = os.path.join(temp, "campaign.json")
        state_path = os.path.join(temp, "state.json")
        ledger = os.path.join(temp, "receipts.jsonl")
        L._atomic_json(campaign_path, manifest)
        L._atomic_json(state_path, state)
        arm_id, case_id, repeat = L.schedule(manifest, [])[0]
        case = next(item for item in corpus["cases"] if item["caseId"] == case_id)
        receipt = L.infra_receipt(manifest, state, arm_id, case, repeat, 1)
        B.append_receipt(ledger, receipt, manifest)
        marker = L._inflight_path(ledger)
        L._atomic_json(marker, {
            "schemaVersion": 1, "campaignId": manifest["campaignId"],
            "corpusVersion": manifest["corpusVersion"], "armId": arm_id,
            "caseId": case_id, "repeat": repeat, "startedAt": 1,
        })
        assert L.main([
            "status", "--campaign", campaign_path, "--state", state_path,
            "--ledger", ledger, "--json",
        ]) == 0
        assert not os.path.exists(marker)


def test_kill_command_exercises_all_real_controls_without_provider_calls():
    with tempfile.TemporaryDirectory() as temp:
        models = os.path.join(temp, "models.json")
        _models(models)
        corpus = L.load_corpus()
        manifest, state = L.campaign_for(
            corpus, "qwen_fixture", "qwen-fixture", "medium", "gpt-fixture",
            campaign_id="slice-g-kill-controls", env={"CAMUS_MODELS_FILE": models},
        )
        campaign_path = os.path.join(temp, "campaign.json")
        state_path = os.path.join(temp, "state.json")
        ledger = os.path.join(temp, "receipts.jsonl")
        L._atomic_json(campaign_path, manifest)
        L._atomic_json(state_path, state)
        assert L.main([
            "kill", "--campaign", campaign_path, "--state", state_path,
            "--ledger", ledger, "--max-cells", "24",
        ]) == 0
        receipts = B.load_ledger(ledger, manifest)
        assert len(receipts) == 24
        assert all(item["killPathPassed"] is True for item in receipts)
        assert all(item["killControl"]["providerCallsMade"] == 0 for item in receipts)
        assert {item["killControl"]["mode"] for item in receipts} == {
            "abort", "malformed_output", "identity_substitution", "transport_interrupt",
        }
        assert L.schedule(manifest, receipts, include_kill=True) == L.schedule(manifest, receipts)


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items())
             if name.startswith("test_") and callable(value)]
    failed = 0
    for test in tests:
        try:
            test()
            print("ok   " + test.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL %s: %r" % (test.__name__, exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    raise SystemExit(1 if failed else 0)
