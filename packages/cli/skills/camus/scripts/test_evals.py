#!/usr/bin/env python3
"""Hermetic tests for the local eval ledger and sequential A/B assignment."""

import json
import os
import tempfile

import evals as E


def _episode(number, arm, quality=True, wall=1000):
    return E.make_episode(
        trace_id="f:a%d" % number, feat_id="f", task_id="t%d" % number,
        task_hash="sha256:%064d" % number, task_class="feature",
        pairing={"makerModel": arm, "reviewerModel": "judge"},
        outcome={
            "verificationPass": quality,
            "independentReview": "clean" if quality else "findings",
            "humanIntervention": False,
        },
        economics={"wallMs": wall, "outputTokens": wall // 10},
        artifact={"commit": "%040d" % number},
        experiment={"id": "exp", "armId": arm}, recorded_at=number,
    )


def test_ledger_is_append_only_and_idempotent():
    with tempfile.TemporaryDirectory() as root:
        ledger = E.Ledger(os.path.join(root, "episodes.jsonl"))
        record = _episode(1, "a")
        assert ledger.append(record) is True
        assert ledger.append(record) is False
        assert ledger.records() == [record]
        assert os.stat(ledger.path).st_mode & 0o777 == 0o600
        assert os.stat(os.path.dirname(ledger.path)).st_mode & 0o777 == 0o700


def test_ledger_refuses_corruption_instead_of_silently_dropping_a_trial():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "episodes.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{broken\n")
        try:
            E.Ledger(path).records()
            assert False, "corrupt trial disappeared"
        except E.EvalError as exc:
            assert ":1" in str(exc)


def test_balanced_assignment_does_not_peek_at_future_outcomes():
    plan = {
        "id": "exp", "taskClass": "feature", "minimumTrials": 3, "qualityFloor": 0.8,
        "arms": [{"id": "a"}, {"id": "b"}],
    }
    records = [_episode(1, "a"), _episode(2, "a")]
    arm, evidence = E.select_arm(plan, records, "task-x")
    assert arm["id"] == "b"
    assert "balanced exploration" in evidence["reason"]


def test_quality_floor_precedes_velocity_after_minimum_trials():
    plan = {
        "id": "exp", "taskClass": "feature", "minimumTrials": 2, "qualityFloor": 0.5,
        "arms": [{"id": "fast-bad"}, {"id": "slow-good"}],
    }
    records = [
        _episode(1, "fast-bad", quality=False, wall=1),
        _episode(2, "fast-bad", quality=False, wall=1),
        _episode(3, "slow-good", quality=True, wall=1000),
        _episode(4, "slow-good", quality=True, wall=1200),
    ]
    arm, evidence = E.select_arm(plan, records, "task-y")
    assert arm["id"] == "slow-good", evidence
    assert "quality floor met" in evidence["reason"]


def test_selection_is_segmented_by_declared_task_class():
    plan = {
        "id": "exp", "taskClass": "feature", "minimumTrials": 1, "qualityFloor": 0.8,
        "arms": [{"id": "a"}, {"id": "b"}],
    }
    rows = [
        {**_episode(1, "a", quality=True, wall=100), "taskClass": "feature"},
        {**_episode(2, "b", quality=True, wall=200), "taskClass": "feature"},
        {**_episode(3, "a", quality=False, wall=1), "taskClass": "research"},
    ]
    arm, evidence = E.select_arm(plan, rows, "next")
    assert arm["id"] == "a", evidence
    assert evidence["stats"]["a"]["trials"] == 1


def test_summary_never_calls_operational_scores_human_calibration():
    report = E.summarize([_episode(1, "a")])
    assert report["standing"] == "exploratory_only"
    assert "not human calibration" in report["note"]


def test_experiment_config_rejects_unknown_fields_and_accepts_pairings():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "experiment.json")
        value = {
            "id": "pair-v1", "taskClass": "feature", "minimumTrials": 2,
            "arms": [
                {"id": "opus-sol", "makerModel": "claude-opus-4-8", "makerEffort": "high",
                 "reviewerBackend": "codex", "reviewerModel": "gpt-5.6-sol", "reviewerEffort": "high"},
                {"id": "sonnet-sol", "makerModel": "claude-sonnet-4-7", "makerEffort": "medium",
                 "reviewerBackend": "codex", "reviewerModel": "gpt-5.6-sol", "reviewerEffort": "high"},
            ],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        plan = E.load_experiment(path)
        assert [arm["id"] for arm in plan["arms"]] == ["opus-sol", "sonnet-sol"]
        assert plan["mode"] == "explore"
        assert plan["configHash"].startswith("sha256:")
        value["arms"][0]["secret"] = "must-not-pass"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        try:
            E.load_experiment(path)
            assert False, "unknown experiment field accepted"
        except E.EvalError:
            pass


def test_route_mode_is_explicit_and_requires_a_larger_sample_floor():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "experiment.json")
        value = {
            "id": "route-v1", "taskClass": "feature", "mode": "route", "minimumTrials": 3,
            "arms": [
                {"id": "a", "makerModel": "opus", "reviewerBackend": "codex",
                 "reviewerModel": "sol", "reviewerEffort": "high"},
                {"id": "b", "makerModel": "sonnet", "reviewerBackend": "codex",
                 "reviewerModel": "sol", "reviewerEffort": "high"},
            ],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        try:
            E.load_experiment(path)
            assert False, "small-sample automatic routing accepted"
        except E.EvalError as exc:
            assert "minimumTrials" in str(exc)
        value["minimumTrials"] = 5
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)
        assert E.load_experiment(path)["mode"] == "route"


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
