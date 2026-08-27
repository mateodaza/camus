#!/usr/bin/env python3
"""Human admission registry and exact dispatcher boundary tests."""
import json
import os
import tempfile

import reviewer_admission as A
import reviewer_dispatch
import review_qualification
import test_benchmark_reviewers as BR


APPROVED = "2026-08-26T12:00:00.000Z"
EXPIRES = "2026-09-25T12:00:00.000Z"
NOW = 1787749200  # 2026-08-26T13:00:00Z


def entry():
    value = {
        "executorBackend": "http_openai_compat",
        "profileBackend": "fixture_qwen", "model": "qwen-fixture", "effort": "medium",
        "trainingOrg": "alibaba", "transport": "loopback", "connection": "fixture",
        "campaignId": "slice-g-fixture", "corpusVersion": "corpus1:" + "1" * 64,
        "promptEnvelopeVersion": "rc1-light", "summarySha256": "sha256:" + "2" * 64,
        "humanCalibrationCampaignId": "studio-routing-v6",
        "humanCalibrationId": "human1:" + "3" * 64, "approvedBy": "human:Mateo",
        "approvedAt": APPROVED, "expiresAt": EXPIRES, "scope": "cli_code_reviewer_gate",
    }
    value["qualificationFingerprint"] = A.qualification_fingerprint(value)
    value["admissionId"] = A.admission_id(value)
    return A.validate_entry(value)


def calibration(authority="human", agreement=True):
    artifacts = []
    runs = []
    for index in range(12):
        artifact_id = "sha256:" + ("%064x" % (index + 1))
        verdict = "APPROVED" if index % 2 == 0 else "REVISE"
        presence = "clean" if verdict == "APPROVED" else "findings"
        artifacts.append({
            "id": artifact_id,
            "caseId": "simple-case-%d" % (index + 1),
            "sourceRunId": "candidate-run-%d" % (index + 1),
            "humanLabel": {
                "authority": authority, "labeledBy": ("human:Mateo" if authority == "human" else "expert_ai_proxy:codex"),
                "verdict": verdict, "findingPresence": presence,
                "labeledAt": "2026-08-%02dT12:00:00.000Z" % (index + 1),
            },
        })
        for judge in ("sol", "opus"):
            runs.append({
                "artifactId": artifact_id, "judgeId": judge,
                "sourceRunId": "%s-run-%d" % (judge, index + 1),
                "actualIdentity": "actual:" + judge,
                "verdict": verdict if agreement else "APPROVED",
                "findingPresence": presence if agreement else "clean",
            })
    return {
        "schemaVersion": 1, "campaignId": "studio-routing-v6",
        "standing": "uncalibrated",
        "artifacts": artifacts, "judgeRuns": runs,
    }


def test_checked_in_registry_is_empty_and_schema_fields_match_runtime():
    registry = A.load_registry()
    assert registry == {"schemaVersion": 1, "admissions": []}
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "reviewer-admissions.v1.schema.json"), encoding="utf-8") as handle:
        schema = json.load(handle)
    required = schema["properties"]["admissions"]["items"]["required"]
    assert set(required) == set(A.ENTRY_KEYS)


def test_human_calibration_requires_people_two_judges_and_joint_agreement():
    assert A.human_calibration_id(calibration()).startswith("human1:")
    try:
        A.human_calibration_id(calibration(authority="expert_ai_proxy"))
        raise AssertionError("AI proxy was accepted as human calibration")
    except A.AdmissionError as exc:
        assert "non-human" in str(exc)
    try:
        A.human_calibration_id(calibration(agreement=False))
        raise AssertionError("uncalibrated judges were accepted")
    except A.AdmissionError as exc:
        assert "two distinct identity-stable judges" in str(exc)
    same_identity = calibration()
    for run in same_identity["judgeRuns"]:
        run["actualIdentity"] = "actual:same-model"
    try:
        A.human_calibration_id(same_identity)
        raise AssertionError("two judge labels over one actual model identity were accepted")
    except A.AdmissionError as exc:
        assert "two distinct identity-stable judges" in str(exc)
    duplicate = calibration()
    duplicate["judgeRuns"].append(dict(duplicate["judgeRuns"][0]))
    try:
        A.human_calibration_id(duplicate)
        raise AssertionError("duplicate artifact/judge calibration decision was accepted")
    except A.AdmissionError as exc:
        assert "duplicate" in str(exc)


def test_exact_unexpired_admission_enables_only_its_tuple():
    admitted = entry()
    registry = {"schemaVersion": 1, "admissions": [admitted]}
    matched = A.match(registry, "fixture_qwen", "qwen-fixture", "medium", "alibaba",
                      "loopback", "fixture", admitted["qualificationFingerprint"], now=NOW)
    assert matched["admissionId"] == admitted["admissionId"]
    assert A.match(registry, "fixture_qwen", "other", "medium", "alibaba",
                   "loopback", "fixture", admitted["qualificationFingerprint"], now=NOW) is None
    assert A.match(registry, "fixture_qwen", "qwen-fixture", "medium", "alibaba",
                   "loopback", "fixture", admitted["qualificationFingerprint"], now=2000000000) is None
    assert A.match(registry, "fixture_qwen", "qwen-fixture", "medium", "alibaba",
                   "loopback", "fixture", "qual1:" + "f" * 64, now=NOW) is None


def test_dispatcher_uses_checked_in_evidence_and_never_promotes_a_trial():
    admitted = entry()
    registry = {"schemaVersion": 1, "admissions": [admitted]}
    env = {
        "CAMUS_MAKER_TRAINING_ORG": "anthropic",
        "CAMUS_REVIEWER_TRAINING_ORG": "alibaba",
        "CAMUS_HTTP_REVIEW_PROFILE_BACKEND": "fixture_qwen",
        "CAMUS_CODEX_MODEL": "qwen-fixture", "CAMUS_REVIEW_EFFORT": "medium",
        "CAMUS_HTTP_REVIEW_TRANSPORT": "loopback", "CAMUS_HTTP_REVIEW_CONNECTION": "fixture",
        "CAMUS_REVIEW_QUALIFICATION": admitted["qualificationFingerprint"],
    }
    decision, error = reviewer_dispatch.decide("http_openai_compat", env, admissions=registry, now=NOW)
    assert error is None and decision["admission_id"] == admitted["admissionId"]
    assert decision["training_org"] == "alibaba"
    assert decision["qualification"] == admitted["qualificationFingerprint"]
    refused, error = reviewer_dispatch.decide(
        "http_openai_compat", dict(env, CAMUS_HTTP_REVIEW_TRIAL="1"), admissions=registry, now=NOW,
    )
    assert refused is None and error["error_code"] == "reviewer_benchmark_disabled"
    refused, error = reviewer_dispatch.decide(
        "http_openai_compat", dict(env, CAMUS_CODEX_MODEL="qwen-substitute"), admissions=registry, now=NOW,
    )
    assert refused is None and error["error_code"] == "reviewer_benchmark_disabled"
    refused, error = reviewer_dispatch.decide(
        "http_openai_compat", dict(env, CAMUS_MAKER_TRAINING_ORG="alibaba"), admissions=registry, now=NOW,
    )
    assert refused is None and error["error_code"] == "reviewer_same_origin"


def test_content_tamper_and_long_admission_refuse():
    original = entry()
    changed = dict(original, model="other")
    try:
        A.validate_entry(changed)
        raise AssertionError("admission content changed under its old id")
    except A.AdmissionError as exc:
        assert "admissionId" in str(exc)
    too_long = dict(original, expiresAt="2027-08-26T12:00:00.000Z")
    too_long["qualificationFingerprint"] = A.qualification_fingerprint(too_long)
    too_long["admissionId"] = A.admission_id(too_long)
    try:
        A.validate_entry(too_long)
        raise AssertionError("year-long admission bypassed the revalidation window")
    except A.AdmissionError as exc:
        assert "90 days" in str(exc)


def test_activation_requires_checked_in_admission_and_binds_credential_rotation():
    admitted = entry()
    registry = {"schemaVersion": 1, "admissions": [admitted]}
    with tempfile.TemporaryDirectory() as tmp:
        studio = os.path.join(tmp, "studio")
        os.makedirs(studio, mode=0o700)
        salt = os.path.join(studio, ".machine-salt")
        with open(salt, "w", encoding="ascii") as handle:
            handle.write("11" * 32)
        os.chmod(salt, 0o600)
        models = os.path.join(studio, "models.json")
        with open(models, "w", encoding="utf-8") as handle:
            json.dump({
                "connections": {"fixture": {"kind": "loopback", "baseUrl": "http://127.0.0.1:1919/v1"}},
                "backends": {"fixture_qwen": {
                    "kind": "openai_compat", "connection": "fixture", "models": ["qwen-fixture"],
                    "seats": ["reviewer"], "trainingOrg": "alibaba", "provider": "alibaba",
                    "modelFamily": "qwen", "inferenceOperator": "alibaba",
                    "auth": {"kind": "env", "envVar": "TEST_QWEN_KEY"},
                }},
            }, handle)
        os.chmod(models, 0o600)
        env = {
            "STUDIO_GRANDFATHER_DIR": studio, "CAMUS_MODELS_FILE": models,
            "TEST_QWEN_KEY": "first-private-value",
        }
        activated = A.activate_qualification(admitted["admissionId"], env, registry, now=NOW)
        assert activated["qualificationFingerprint"] == admitted["qualificationFingerprint"]
        assert review_qualification.accepted_training_org(
            admitted["qualificationFingerprint"], admitted["admissionId"],
            "http_openai_compat", "fixture_qwen",
            "qwen-fixture", "loopback", "fixture", "env", "TEST_QWEN_KEY", env, now=NOW,
        ) == "alibaba"
        try:
            review_qualification.accepted_training_org(
                admitted["qualificationFingerprint"], "admit1:" + "f" * 64,
                "http_openai_compat", "fixture_qwen", "qwen-fixture", "loopback",
                "fixture", "env", "TEST_QWEN_KEY", env, now=NOW,
            )
            raise AssertionError("a shaped but different admission id inherited local authority")
        except ValueError as exc:
            assert "admission_id" in str(exc)
        try:
            review_qualification.accepted_training_org(
                admitted["qualificationFingerprint"], admitted["admissionId"],
                "http_openai_compat", "fixture_qwen",
                "qwen-fixture", "loopback", "fixture", "env", "TEST_QWEN_KEY",
                dict(env, TEST_QWEN_KEY="rotated-private-value"), now=NOW,
            )
            raise AssertionError("credential rotation inherited an older qualification authority")
        except ValueError as exc:
            assert "credential_revision" in str(exc)
        try:
            A.activate_qualification("admit1:" + "f" * 64, env, registry, now=NOW)
            raise AssertionError("an unregistered admission id created local authority")
        except A.AdmissionError as exc:
            assert "checked-in" in str(exc)


def test_proposal_binds_the_exact_human_calibration_generation():
    campaign = BR.manifest()
    campaign["campaignId"] = "slice-g-fixture"
    campaign["corpusVersion"] = "corpus1:" + "1" * 64
    campaign["promptEnvelopeVersion"] = "rc1-light"
    campaign = A.benchmark_reviewers.validate_manifest(campaign)
    state = {
        "schemaVersion": 1, "campaignId": "slice-g-fixture",
        "corpusVersion": "corpus1:" + "1" * 64,
        "candidateProfileBackend": "fixture_qwen",
        "candidateModel": "qwen-fixture", "candidateTrainingOrg": "alibaba",
        "candidateTransport": "loopback", "candidateConnection": "fixture",
    }
    receipts = BR.full_receipts(campaign)
    expected_execution = A.benchmark_reviewers.execution_digest(state, campaign)
    rebound = []
    for item in receipts:
        value = dict(item, executionDigest=expected_execution)
        value["receiptId"] = A.benchmark_reviewers.receipt_id(value)
        rebound.append(A.benchmark_reviewers.validate_receipt(value, campaign))
    summary = A.benchmark_reviewers.summarize(campaign, rebound)
    human = calibration()
    human["campaignId"] = "human-generation-v6"
    proposed = A.proposal(campaign, state, summary, human, "Mateo", APPROVED, EXPIRES, rebound)
    assert proposed["humanCalibrationCampaignId"] == "human-generation-v6"
    assert proposed["humanCalibrationId"] == A.human_calibration_id(human)
    assert proposed["qualificationFingerprint"] == A.qualification_fingerprint(proposed)

    tampered = dict(summary, receiptCount=summary["receiptCount"] - 1)
    try:
        A.proposal(campaign, state, tampered, human, "Mateo", APPROVED, EXPIRES, rebound)
        raise AssertionError("hand-authored eligible summary bypassed complete-ledger derivation")
    except A.AdmissionError as exc:
        assert "complete supplied ledger" in str(exc)


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
