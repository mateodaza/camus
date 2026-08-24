#!/usr/bin/env python3
"""Responsible Control Plane v1 deterministic and cross-language pins."""
import os
import tempfile

import control_plane as cp


def action(action_class="cli.review.execute", **overrides):
    value = {
        "schema_version": 1,
        "action_class": action_class,
        "target": {"class": "candidate_diff", "id": "run-123"},
        "impact": "medium",
        "reversibility": "reversible",
        "external_side_effect": "provider_request",
        "data_sensitivity": "internal",
        "destination_trust": "known",
        "operator_policy": "allow",
    }
    value.update(overrides)
    return value


def passing(action_value, checkpoints=cp.CHECKPOINTS):
    return [
        cp.control_event(control["control_id"], action_value, "passed", "fixture_passed", now=index + 1)
        for index, control in enumerate(cp.controls_for(action_value["action_class"], checkpoints))
    ]


assert cp.validate_register(cp.CONTROL_REGISTER)["register_version"] == "control-register.v1"
review = action()
first_two = ("input_screen", "action_authorization")
evidence = passing(review, first_two)
assert cp.evaluate_action(review, evidence, checkpoints=first_two, now=10)["decision"] == "auto"

missing = cp.evaluate_action(review, [], model_recommendation="auto", checkpoints=first_two, now=11)
assert missing["decision"] == "refuse"
assert missing["cause"] == "policy_refused"

malformed = [dict(item) for item in evidence]
malformed[0]["control_version"] = "future"
assert cp.evaluate_action(review, malformed, checkpoints=first_two, now=12)["decision"] == "refuse"
forged = [dict(item) for item in evidence]
forged[0].pop("reason_code")
assert cp.evaluate_action(review, forged, checkpoints=first_two, now=12)["decision"] == "refuse"

escalated = cp.evaluate_action(review, evidence, model_recommendation="human_required", checkpoints=first_two, now=13)
assert escalated["decision"] == "human_required"
assert escalated["source"] == "model_escalation"

publication = action(
    "studio.publish.artifact",
    target={"class": "hivemind_artifact", "id": "run-123"},
    impact="high",
    reversibility="irreversible",
    external_side_effect="publication",
    destination_trust="declared",
    operator_policy="ask",
)
publication_evidence = passing(publication)
assert cp.evaluate_action(publication, publication_evidence, now=20)["decision"] == "human_required"
partial_approval = {"decision": "approve", "action_fingerprint": cp.action_fingerprint(publication)}
assert cp.evaluate_action(publication, publication_evidence, authorization=partial_approval, now=20)["rule_ids"] == ["human_authorization_malformed"]
approval = cp.human_decision(publication, "approve", "Publish this exact completed run", now=21)
approved = cp.evaluate_action(publication, publication_evidence, authorization=approval, now=22)
assert approved["decision"] == "auto"
assert approved["source"] == "human"

changed = dict(publication, target={"class": "hivemind_artifact", "id": "run-OTHER"})
changed_evidence = passing(changed)
rebound = cp.evaluate_action(changed, changed_evidence, authorization=approval, now=23)
assert rebound["decision"] == "refuse"
assert rebound["rule_ids"] == ["human_binding_mismatch"]

try:
    cp.control_event(
        "cli.review.backend_admission", review, "passed", "bad_evidence",
        details={"authorization": "Bearer definitely-secret"},
    )
    raise AssertionError("credential-shaped control evidence must refuse")
except ValueError as exc:
    assert "not allowed in control evidence" in str(exc)

try:
    cp.control_event(
        "cli.review.backend_admission", review, "passed", "nonfinite",
        details={"score": float("nan")},
    )
    raise AssertionError("non-finite control evidence must refuse")
except ValueError as exc:
    assert "must be finite" in str(exc)

assert cp.action_fingerprint({
    "schema_version": 1,
    "action_class": "studio.run.launch",
    "target": {"class": "run", "id": "run-123"},
    "impact": "medium",
    "reversibility": "reversible",
    "external_side_effect": "provider_request",
    "data_sensitivity": "internal",
    "destination_trust": "known",
    "operator_policy": "allow",
}) == "action1:f83ccd27a4e25bc122272fb6d6cee016cf4ad6b37a38d71ddd6f3c777071d2c6"

with tempfile.TemporaryDirectory() as temp:
    path = os.path.join(temp, "receipt.json")
    route = cp.evaluate_action(review, evidence, checkpoints=first_two, now=30)
    receipt = cp.update_receipt(path, review, events=evidence, routes=[route])
    assert os.stat(path).st_mode & 0o777 == 0o600
    again = cp.update_receipt(path, review, events=evidence, routes=[route])
    assert len(again["events"]) == len(receipt["events"]), "replay must not duplicate evidence"

with tempfile.TemporaryDirectory() as temp:
    worktree = os.path.join(temp, "camus-wt-controlled")
    reviews = os.path.join(temp, "reviews")
    os.makedirs(worktree)
    env = {"CAMUS_REVIEW_DIR": reviews}
    exact = cp.review_action("codex", cp.review_target_id(worktree, 2, "codex"))
    preflight = passing(exact, first_two)
    preflight_route = cp.evaluate_action(exact, preflight, checkpoints=first_two, now=40)
    cp.update_receipt(cp.receipt_path(worktree, 2, env), exact,
                      events=preflight, routes=[preflight_route])
    binding = {
        "bound": True, "contract": "rc1", "scope": "full",
        "qualification": "builtin1:fixture", "origin": "camus-loop",
        "operator": "claude-code", "transport": "cli-detached",
        "connection": "vendor_managed", "reviewer_backend": "codex",
        "reviewer_model": "gpt-fixture",
    }
    complete = cp.finalize_review_receipt(
        worktree, 2, "codex", True, False, binding,
        input_fingerprint="fp1:" + ("a" * 64), env=env, now=41,
    )
    assert complete["decision"] == "auto"
    assert complete["cause"] == "review_rejected"
    assert len(complete["receipt"]["events"]) == 6

    # A valid schema is not enough: changed/missing candidate binding refuses.
    other = os.path.join(temp, "camus-wt-incomplete")
    os.makedirs(other)
    other_action = cp.review_action("codex", cp.review_target_id(other, 1, "codex"))
    other_evidence = passing(other_action, first_two)
    cp.update_receipt(cp.receipt_path(other, 1, env), other_action,
                      events=other_evidence,
                      routes=[cp.evaluate_action(other_action, other_evidence,
                                                 checkpoints=first_two, now=42)])
    refused = cp.finalize_review_receipt(
        other, 1, "codex", True, True, dict(binding, bound=False),
        input_fingerprint=None, env=env, now=43,
    )
    assert refused["decision"] == "refuse"
    assert refused["cause"] == "policy_refused"

print("test_control_plane.py: %d registered controls and routing matrix passed" % len(cp.CONTROL_REGISTER["controls"]))
