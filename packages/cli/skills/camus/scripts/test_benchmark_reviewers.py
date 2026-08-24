#!/usr/bin/env python3
"""Hermetic Slice G campaign/statistics acceptance tests."""
import json
import math
import os
import stat
import tempfile

import benchmark_reviewers as B


def test_published_schemas_match_the_runtime_required_fields():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "benchmark-receipt.v1.schema.json"), encoding="utf-8") as fh:
        receipt_schema = json.load(fh)
    with open(os.path.join(root, "benchmark-campaign.v1.schema.json"), encoding="utf-8") as fh:
        campaign_schema = json.load(fh)
    assert set(receipt_schema["required"]) == set(B.RECEIPT_KEYS)
    assert set(campaign_schema["properties"]["thresholds"]["required"]) == set(B.THRESHOLD_KEYS)
    assert campaign_schema["properties"]["thresholds"]["properties"]["qualityRepetitions"]["minimum"] == 10
    assert campaign_schema["properties"]["thresholds"]["properties"]["containmentMinimum"]["minimum"] == 150


def manifest(role="reviewer", transport_pairs=None):
    cases = [
        {"caseId": "defect-%02d" % index, "kind": "defect", "expectedDefects": ["bug-%02d" % index]}
        for index in range(20)
    ] + [
        {"caseId": "clean-%02d" % index, "kind": "clean", "expectedDefects": []}
        for index in range(10)
    ] + [{"caseId": "kill-stream", "kind": "kill_path", "expectedDefects": []}]
    return B.validate_manifest({
        "schemaVersion": 1,
        "campaignId": "campaign-fixture",
        "corpusVersion": "corpus-fixture.v1",
        "promptEnvelopeVersion": "review-prompt.fixture.v1",
        "baseline": {
            "armId": "baseline", "backend": "codex", "model": "gpt-fixture",
            "effort": "medium", "transport": "vendor_managed", "role": "reviewer",
        },
        "candidates": [{
            "armId": "candidate", "backend": "http_openai_compat", "model": "qwen-fixture",
            "effort": "medium", "transport": "loopback", "role": role,
        }],
        "cases": cases,
        "transportPairs": transport_pairs or [],
        "thresholds": {
            "validityLower": 0.98, "recallDelta": 0.10, "fprEpsilon": 0.05,
            "transportDelta": 0.03, "qualityRepetitions": 10,
            "killRepetitions": 3, "containmentMinimum": 150,
            "containmentConclusive": 0.98,
        },
    })


def receipt(campaign, arm_id, case, repeat, detected=True, normalizer=True,
            identity=True, kill=True, mutation=False, breach=False, rerun_of=None):
    defects = list(case["expectedDefects"] if detected else [])
    value = {
        "schemaVersion": 1,
        "campaignId": campaign["campaignId"],
        "corpusVersion": campaign["corpusVersion"],
        "promptEnvelopeVersion": campaign["promptEnvelopeVersion"],
        "armId": arm_id,
        "caseId": case["caseId"],
        "caseKind": case["kind"],
        "repeat": repeat,
        "normalizerRan": normalizer,
        "expectedDefects": list(case["expectedDefects"]),
        "detectedDefects": defects,
        "blockingFindingCount": 0,
        "identityMatch": identity,
        "killPathPassed": kill if case["kind"] == "kill_path" else None,
        "toolUsing": False,
        "toolCallCorrect": None,
        "pseudoToolCallCount": 0,
        "contextSufficient": True if case["kind"] != "kill_path" else None,
        "mutationEntered": mutation and case["kind"] != "kill_path",
        "containmentConclusive": True if mutation and case["kind"] != "kill_path" else None,
        "containmentBreach": breach if mutation and case["kind"] != "kill_path" else None,
        "wallMs": 100 + repeat,
        "latencyClass": "resident",
        "usage": {
            "inputTokens": 10, "cachedInputTokens": None, "outputTokens": 5,
            "totalTokens": 15, "costUsd": None, "costSource": "unavailable",
        },
        "decoding": {"temperature": 0, "seed": None, "pinned": True},
        "rerunOf": rerun_of,
    }
    return B.seal_receipt(value, campaign)


def full_receipts(campaign, candidate_role="reviewer"):
    out = []
    for case in campaign["cases"]:
        floor = campaign["thresholds"]["killRepetitions"] if case["kind"] == "kill_path" \
            else campaign["thresholds"]["qualityRepetitions"]
        for repeat in range(1, floor + 1):
            out.append(receipt(campaign, "baseline", case, repeat))
            out.append(receipt(campaign, "candidate", case, repeat,
                               mutation=candidate_role == "maker"))
    return out


def transport_campaign_and_receipts():
    campaign = manifest()
    campaign["candidates"].append({
        "armId": "candidate_ssh", "backend": "http_openai_compat", "model": "qwen-fixture",
        "effort": "medium", "transport": "ssh_tunnel", "role": "reviewer",
    })
    campaign["transportPairs"] = [{"leftArmId": "candidate", "rightArmId": "candidate_ssh"}]
    campaign = B.validate_manifest(campaign)
    attempts = full_receipts(campaign)
    for case in campaign["cases"]:
        floor = campaign["thresholds"]["killRepetitions"] if case["kind"] == "kill_path" \
            else campaign["thresholds"]["qualityRepetitions"]
        for repeat in range(1, floor + 1):
            attempts.append(receipt(campaign, "candidate_ssh", case, repeat))
    return campaign, attempts


def test_well_powered_perfect_reviewer_is_only_eligible_for_human_admission():
    campaign = manifest()
    report = B.summarize(campaign, full_receipts(campaign))
    row = report["candidates"][0]
    assert row["recommendation"] == "eligible_for_human_admission"
    assert row["registryChanged"] is False
    assert all(row["conditions"].values())
    assert report["arms"]["candidate"]["validity"]["interval95"]["lower"] >= 0.98
    assert report["statisticalMethod"] == B.METHOD


def test_underpowered_campaign_fails_in_the_conservative_direction():
    campaign = manifest()
    attempts = []
    for case in campaign["cases"]:
        attempts.append(receipt(campaign, "baseline", case, 1))
        attempts.append(receipt(campaign, "candidate", case, 1))
    row = B.summarize(campaign, attempts)["candidates"][0]
    assert row["recommendation"] == "not_admitted"
    assert row["conditions"]["coverage"] is False
    assert row["conditions"]["structuredOutputValidity"] is False


def test_summary_preserves_per_cell_flakiness_latency_usage_and_decoding():
    campaign = manifest()
    attempts = full_receipts(campaign)
    original = next(item for item in attempts
                    if item["armId"] == "candidate" and item["caseId"] == "defect-00"
                    and item["repeat"] == 1)
    case = next(case for case in campaign["cases"] if case["caseId"] == "defect-00")
    changed = receipt(campaign, "candidate", case, 1, detected=False)
    attempts = [changed if item["receiptId"] == original["receiptId"] else item for item in attempts]
    report = B.summarize(campaign, attempts)
    arm = report["arms"]["candidate"]
    cell = next(item for item in arm["cells"] if item["caseId"] == "defect-00")
    assert cell["attempts"] == 10
    assert cell["flakiness"] == {
        "attempts": 10, "uniqueOutcomes": 2, "disagreements": 1, "fraction": 0.1,
    }
    assert cell["latency"]["resident"]["count"] == 10
    assert cell["usage"]["tokens"]["inputTokens"] == {"reported": 10, "total": 100}
    assert cell["usage"]["providerCost"] == {
        "reported": 0, "totalUsd": None, "estimated": False,
    }
    assert cell["decodingProfiles"] == [{
        "decoding": {"pinned": True, "seed": None, "temperature": 0}, "attempts": 10,
    }]


def test_paired_recall_degradation_is_not_hidden_by_valid_json():
    campaign = manifest()
    attempts = full_receipts(campaign)
    changed = []
    for item in attempts:
        if item["armId"] == "candidate" and item["caseKind"] == "defect" and item["repeat"] <= 5:
            case = next(case for case in campaign["cases"] if case["caseId"] == item["caseId"])
            changed.append(receipt(campaign, "candidate", case, item["repeat"], detected=False))
        else:
            changed.append(item)
    row = B.summarize(campaign, changed)["candidates"][0]
    assert row["conditions"]["structuredOutputValidity"] is True
    assert row["conditions"]["recallNonInferior"] is False
    assert row["paired"]["recallDifference"]["upper"] < 0


def test_zero_fpr_baseline_is_decidable_without_a_ratio_rule():
    campaign = manifest()
    row = B.summarize(campaign, full_receipts(campaign))["candidates"][0]
    interval = row["paired"]["falsePositiveDifference"]
    assert interval["candidateWins"] == 0 and interval["candidateLosses"] == 0
    assert interval["upper"] <= campaign["thresholds"]["fprEpsilon"]
    assert row["conditions"]["falsePositiveMargin"] is True


def test_maker_containment_uses_fixed_denominator_and_one_breach_disqualifies():
    campaign = manifest(role="maker")
    attempts = full_receipts(campaign, candidate_role="maker")
    row = B.summarize(campaign, attempts)["candidates"][0]
    assert row["containment"]["mutationRuns"] == 300
    assert row["containment"]["ruleOfThreeUpper95"] == 3 / 300
    assert row["conditions"]["containment"] is True
    target = next(item for item in attempts if item["armId"] == "candidate" and item["mutationEntered"])
    case = next(case for case in campaign["cases"] if case["caseId"] == target["caseId"])
    breached = receipt(campaign, "candidate", case, target["repeat"], mutation=True, breach=True)
    attempts = [breached if item["receiptId"] == target["receiptId"] else item for item in attempts]
    failed = B.summarize(campaign, attempts)["candidates"][0]
    assert failed["containment"]["breaches"] == 1
    assert failed["conditions"]["containment"] is False


def test_transport_equivalence_interval_refuses_underpowered_no_difference():
    small = B.paired_difference([True] * 20, [True] * 20, mode="transport_90")
    large = B.paired_difference([True] * 300, [True] * 300, mode="transport_90")
    assert not (small["lower"] > -0.03 and small["upper"] < 0.03)
    assert large["lower"] > -0.03 and large["upper"] < 0.03


def test_transport_equivalence_is_a_candidate_admission_condition():
    campaign, attempts = transport_campaign_and_receipts()
    passing = B.summarize(campaign, attempts)
    assert all(row["conditions"]["transportEquivalence"] for row in passing["candidates"])
    changed = []
    degraded = 0
    for item in attempts:
        if item["armId"] == "candidate_ssh" and item["caseKind"] == "defect" and degraded < 10:
            case = next(case for case in campaign["cases"] if case["caseId"] == item["caseId"])
            changed.append(receipt(campaign, "candidate_ssh", case, item["repeat"], detected=False))
            degraded += 1
        else:
            changed.append(item)
    report = B.summarize(campaign, changed)
    loopback = next(row for row in report["candidates"] if row["armId"] == "candidate")
    assert loopback["conditions"]["recallNonInferior"] is True
    assert loopback["conditions"]["transportEquivalence"] is False
    assert loopback["recommendation"] == "not_admitted"
    unpaired = manifest()
    unpaired["candidates"][0]["transport"] = "ssh_tunnel"
    unpaired = B.validate_manifest(unpaired)
    unpaired_row = B.summarize(unpaired, full_receipts(unpaired))["candidates"][0]
    assert unpaired_row["conditions"]["transportEquivalence"] is False
    assert unpaired_row["recommendation"] == "not_admitted"


def test_receipt_hash_drift_and_duplicate_run_are_refused():
    campaign = manifest()
    case = campaign["cases"][0]
    item = receipt(campaign, "baseline", case, 1)
    bad = dict(item, wallMs=999)
    try:
        B.validate_receipt(bad, campaign)
        raise AssertionError("changed receipt must not keep its old id")
    except B.BenchmarkError as exc:
        assert "receiptId" in str(exc)
    try:
        B.summarize(campaign, [item, item])
        raise AssertionError("duplicate run must refuse")
    except B.BenchmarkError as exc:
        assert "duplicate" in str(exc)


def test_receipt_has_no_raw_provider_or_credential_bucket():
    campaign = manifest()
    case = campaign["cases"][0]
    item = receipt(campaign, "baseline", case, 1)
    unsafe = dict(item, usage=dict(item["usage"], providerRaw="Bearer secret"))
    unsafe["receiptId"] = B.receipt_id(unsafe)
    try:
        B.validate_receipt(unsafe, campaign)
        raise AssertionError("arbitrary provider diagnostics must not enter the ledger")
    except B.BenchmarkError as exc:
        assert "fields differ" in str(exc)


def test_append_only_ledger_is_idempotent_and_refuses_overwrite():
    campaign = manifest()
    case = campaign["cases"][0]
    first = receipt(campaign, "baseline", case, 1)
    changed = receipt(campaign, "baseline", case, 1, detected=False)
    with tempfile.TemporaryDirectory() as temp:
        path = os.path.join(temp, "receipts.jsonl")
        assert B.append_receipt(path, first, campaign)["appended"] is True
        assert B.append_receipt(path, first, campaign)["appended"] is False
        try:
            B.append_receipt(path, changed, campaign)
            raise AssertionError("same run key may not be overwritten")
        except B.BenchmarkError as exc:
            assert "immutable" in str(exc)
        assert len(B.load_ledger(path, campaign)) == 1
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(path + ".lock").st_mode) == 0o600


def test_rerun_must_point_backward_and_nonfinite_numbers_refuse():
    campaign = manifest()
    case = campaign["cases"][0]
    original = receipt(campaign, "baseline", case, 1)
    rerun = receipt(campaign, "baseline", case, 2, rerun_of=original["receiptId"])
    assert B.summarize(campaign, [original, rerun])["receiptCount"] == 2
    try:
        B.summarize(campaign, [rerun, original])
        raise AssertionError("forward rerun reference must refuse")
    except B.BenchmarkError as exc:
        assert "earlier receipt" in str(exc)
    nonfinite = dict(original, wallMs=1, usage=dict(original["usage"], costUsd=math.nan, costSource="provider_receipt"))
    try:
        B.receipt_id(nonfinite)
        raise AssertionError("NaN must not enter canonical benchmark data")
    except B.BenchmarkError as exc:
        assert "finite canonical JSON" in str(exc)
    boolean_seed = dict(original, decoding=dict(original["decoding"], seed=True))
    boolean_seed["receiptId"] = B.receipt_id(boolean_seed)
    try:
        B.validate_receipt(boolean_seed, campaign)
        raise AssertionError("JSON boolean must not satisfy the integer seed contract")
    except B.BenchmarkError as exc:
        assert "seed" in str(exc)


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
