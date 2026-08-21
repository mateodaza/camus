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
    assert report["standing"] == "segmented_only"
    assert report["experimentEpisodes"] == 1
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


def _seg_episode(number, arm, config_hash, task_class="feature", quality=True, wall=1000):
    return E.make_episode(
        trace_id="f:a%d" % number, feat_id="f", task_id="t%d" % number,
        task_hash="sha256:%064d" % number, task_class=task_class,
        pairing={"makerModel": arm, "reviewerModel": "judge"},
        outcome={
            "verificationPass": quality,
            "independentReview": "clean" if quality else "findings",
            "humanIntervention": False,
        },
        economics={"wallMs": wall, "outputTokens": wall // 10},
        artifact={"commit": "%040d" % number},
        experiment={"id": "exp", "armId": arm, "configHash": config_hash}, recorded_at=number,
    )


# --- Regression: prior Sol P1 — a leader/routing winner must never be named unless the exact
# configured qualityFloor and minimumTrials for that generation are available. ---

def test_report_withholds_leader_without_configured_floor_and_minimum():
    rows = [
        _seg_episode(1, "fast", "sha256:aaa", quality=True, wall=10),
        _seg_episode(2, "fast", "sha256:aaa", quality=True, wall=10),
        _seg_episode(3, "slow", "sha256:aaa", quality=True, wall=9000),
        _seg_episode(4, "slow", "sha256:aaa", quality=True, wall=9000),
    ]
    report = E.summarize(rows)  # no plans → qualityFloor/minimumTrials unavailable
    segment = report["segments"][0]
    assert segment["leader"] is None, segment
    assert segment["standing"] == "exploratory_only", segment
    assert segment["minimumTrials"] is None and segment["qualityFloor"] is None
    assert report["standing"] == "segmented_only"


def test_report_ignores_a_plan_from_a_different_generation():
    rows = [_seg_episode(index, arm, "sha256:live")
            for index, arm in [(1, "a"), (2, "a"), (3, "b"), (4, "b")]]
    stale = {
        "id": "exp", "configHash": "sha256:stale", "minimumTrials": 2,
        "qualityFloor": 0.5, "mode": "route", "arms": [{"id": "a"}, {"id": "b"}],
    }
    report = E.summarize(rows, plans=[stale])
    segment = report["segments"][0]
    assert segment["configHash"] == "sha256:live"
    assert segment["leader"] is None, "a mismatched-generation plan must not unlock routing"
    assert segment["standing"] == "exploratory_only"


def test_report_names_routing_winner_only_with_matching_config_and_full_coverage():
    rows = [
        _seg_episode(1, "fast", "sha256:cfg", quality=True, wall=10),
        _seg_episode(2, "fast", "sha256:cfg", quality=True, wall=10),
        _seg_episode(3, "slow", "sha256:cfg", quality=True, wall=9000),
        _seg_episode(4, "slow", "sha256:cfg", quality=True, wall=9000),
    ]
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 2, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "fast"}, {"id": "slow"}],
    }
    report = E.summarize(rows, plans=[plan])
    segment = report["segments"][0]
    assert segment["leader"] == "fast", segment  # quality-first, then lowest latency
    assert segment["standing"] == "routing_leader"
    assert segment["routingConfigured"] is True
    assert segment["routingEligible"] is True
    # One trial short of coverage: the winner disappears until minimumTrials is met.
    thin = E.summarize(rows[:3], plans=[plan])["segments"][0]
    assert thin["leader"] is None
    assert thin["standing"] == "coverage_incomplete"
    assert thin["routingConfigured"] is True
    assert thin["routingEligible"] is False


def test_configured_experiment_with_no_trials_reports_zero_coverage():
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 2, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "a"}, {"id": "b"}],
    }
    report = E.summarize([], plans=[plan])
    segment = report["segments"][0]
    assert report["episodes"] == 0
    assert report["experimentEpisodes"] == 0
    assert set(segment["arms"]) == {"a", "b"}
    assert all(item["trials"] == 0 for item in segment["arms"].values())
    assert segment["coverageComplete"] is False
    assert segment["routingConfigured"] is True
    assert segment["routingEligible"] is False
    assert segment["leader"] is None
    assert segment["standing"] == "coverage_incomplete"


# --- Regression: prior Sol P2 — per-arm stats and standing must be segmented by the exact
# configHash and taskClass, never aggregated across mixed generations. ---

def test_arm_stats_and_standing_never_mix_generations():
    rows = [
        _seg_episode(1, "a", "sha256:gen1", quality=True, wall=10),
        _seg_episode(2, "a", "sha256:gen1", quality=True, wall=10),
        _seg_episode(3, "a", "sha256:gen2", quality=False, wall=10),
    ]
    report = E.summarize(rows)
    by_hash = {segment["configHash"]: segment for segment in report["segments"]}
    assert set(by_hash) == {"sha256:gen1", "sha256:gen2"}
    assert by_hash["sha256:gen1"]["arms"]["a"]["trials"] == 2
    assert by_hash["sha256:gen1"]["arms"]["a"]["qualityFloorRate"] == 1.0
    assert by_hash["sha256:gen2"]["arms"]["a"]["trials"] == 1
    assert by_hash["sha256:gen2"]["arms"]["a"]["qualityFloorRate"] == 0.0
    assert report["experiments"]["exp"]["standing"] == "mixed_generations"
    assert report["standing"] == "mixed_generations"


def test_report_segments_by_declared_task_class():
    rows = [
        _seg_episode(1, "a", "sha256:cfg", task_class="feature"),
        _seg_episode(2, "a", "sha256:cfg", task_class="research"),
    ]
    report = E.summarize(rows)
    assert sorted(segment["taskClass"] for segment in report["segments"]) == ["feature", "research"]
    for segment in report["segments"]:
        assert segment["arms"]["a"]["trials"] == 1, "task classes must not be pooled"


def test_unversioned_segment_does_not_pool_across_config_hashes():
    # One unversioned trial and one sha256:new trial for the same arm/task class must not be
    # pooled: the unversioned segment reports exactly its own single trial.
    rows = [
        _seg_episode(1, "a", None),
        _seg_episode(2, "a", "sha256:new"),
    ]
    report = E.summarize(rows)
    by_hash = {segment["configHash"]: segment for segment in report["segments"]}
    assert set(by_hash) == {None, "sha256:new"}
    assert by_hash[None]["arms"]["a"]["trials"] == 1
    assert by_hash["sha256:new"]["arms"]["a"]["trials"] == 1


def test_coverage_requires_every_configured_arm():
    # A configured arm with zero trials must appear in the report and block coverage; an
    # unexpected "rogue" arm can never substitute for the missing configured arm.
    rows = [
        _seg_episode(1, "a", "sha256:cfg", quality=True),
        _seg_episode(2, "a", "sha256:cfg", quality=True),
        _seg_episode(3, "rogue", "sha256:cfg", quality=True),
        _seg_episode(4, "rogue", "sha256:cfg", quality=True),
    ]
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 2, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "a"}, {"id": "b"}],
    }
    segment = E.summarize(rows, plans=[plan])["segments"][0]
    assert segment["arms"]["b"]["trials"] == 0, "zero-trial configured arm must be reported"
    assert segment["coverageComplete"] is False
    assert segment["leader"] is None
    assert segment["standing"] == "coverage_incomplete"


def test_plan_for_a_different_task_class_cannot_authorize_a_leader():
    # A plan declaring taskClass:feature must not supply thresholds to a research segment.
    rows = [
        _seg_episode(1, "a", "sha256:cfg", task_class="research", quality=True, wall=10),
        _seg_episode(2, "a", "sha256:cfg", task_class="research", quality=True, wall=10),
    ]
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 1, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "a"}],
    }
    segments = E.summarize(rows, plans=[plan])["segments"]
    segment = next(item for item in segments if item["taskClass"] == "research")
    assert segment["taskClass"] == "research"
    assert segment["leader"] is None, "a feature plan must not unlock a research leader"
    assert segment["standing"] == "exploratory_only"
    configured = next(item for item in segments if item["taskClass"] == "feature")
    assert configured["standing"] == "coverage_incomplete"
    assert configured["arms"]["a"]["trials"] == 0


def test_zero_valued_metrics_are_not_ranked_as_infinite():
    # Median wall of 0 must beat 1 (0 is a valid, fastest metric — not infinity).
    rows = [
        _seg_episode(1, "zero", "sha256:cfg", quality=True, wall=0),
        _seg_episode(2, "zero", "sha256:cfg", quality=True, wall=0),
        _seg_episode(3, "one", "sha256:cfg", quality=True, wall=1),
        _seg_episode(4, "one", "sha256:cfg", quality=True, wall=1),
    ]
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 2, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "zero"}, {"id": "one"}],
    }
    segment = E.summarize(rows, plans=[plan])["segments"][0]
    assert segment["leader"] == "zero", segment


# --- Native orchestration overhead: overhead per episode is max(0, wallMs - modelWallMs); the
# medians are reported only from complete raw timing pairs and never invent coverage. ---

def _timed_episode(number, arm, config_hash="sha256:cfg", economics=None):
    return E.make_episode(
        trace_id="f:a%d" % number, feat_id="f", task_id="t%d" % number,
        task_hash="sha256:%064d" % number, task_class="feature",
        pairing={"makerModel": arm, "reviewerModel": "judge"},
        outcome={"verificationPass": True, "independentReview": "clean", "humanIntervention": False},
        economics=economics if economics is not None else {"wallMs": 1000, "outputTokens": 100},
        artifact={"commit": "%040d" % number},
        experiment={"id": "exp", "armId": arm, "configHash": config_hash}, recorded_at=number,
    )


def test_orchestration_overhead_from_complete_raw_timing():
    rows = [
        _timed_episode(1, "a", economics={"wallMs": 1000, "modelWallMs": 700, "outputTokens": 10}),
        _timed_episode(2, "a", economics={"wallMs": 1600, "modelWallMs": 1000, "outputTokens": 10}),
    ]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianModelWallMs"] == 850  # median(700, 1000)
    assert stats["medianOrchestrationOverheadMs"] == 450  # median(300, 600)


def test_orchestration_overhead_is_null_when_model_wall_absent():
    # Without modelWallMs there is no pair to subtract: overhead must be null, never imputed
    # from wallMs alone, and modelWallMs itself stays null.
    rows = [
        _timed_episode(1, "a", economics={"wallMs": 1000, "outputTokens": 10}),
        _timed_episode(2, "a", economics={"wallMs": 2000, "outputTokens": 10}),
    ]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianWallMs"] == 1500
    assert stats["medianModelWallMs"] is None
    assert stats["medianOrchestrationOverheadMs"] is None


def test_orchestration_overhead_ignores_episodes_missing_either_side():
    # Only the episode with both wallMs and modelWallMs contributes; the half-timed episode is
    # not counted as zero overhead (that would invent coverage).
    rows = [
        _timed_episode(1, "a", economics={"wallMs": 1000, "modelWallMs": 400, "outputTokens": 10}),
        _timed_episode(2, "a", economics={"modelWallMs": 400, "outputTokens": 10}),
    ]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianOrchestrationOverheadMs"] == 600  # only episode 1, not median(600, 0)
    # medianModelWallMs must share the same complete-pair population: the half-timed episode's
    # modelWallMs=400 is excluded, so only episode 1's 400 counts (not the standalone median).
    assert stats["medianModelWallMs"] == 400


def test_model_wall_median_null_without_complete_pair():
    # Every episode carries modelWallMs but omits wallMs, so no complete pair exists. Both
    # pair-requiring medians are null rather than reporting a standalone modelWallMs median.
    rows = [
        _timed_episode(1, "a", economics={"modelWallMs": 700, "outputTokens": 10}),
        _timed_episode(2, "a", economics={"modelWallMs": 1000, "outputTokens": 10}),
    ]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianModelWallMs"] is None
    assert stats["medianOrchestrationOverheadMs"] is None


def test_explicit_incomplete_native_timing_is_not_treated_as_a_complete_pair():
    # Native recovery can expose numeric timings for the measured subset while stating that a
    # launched session has no terminal receipt. Subtracting that partial duration would mislabel
    # the unmeasured model runtime as orchestration overhead.
    rows = [_timed_episode(1, "a", economics={
        "wallMs": 1000, "modelWallMs": 400, "outputTokens": 10,
        "attemptedSessions": 2, "measuredSessions": 1, "incompleteSessions": 1,
        "measurementCoverage": "incomplete_background_models_missing_terminal_receipts",
    })]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianWallMs"] == 1000
    assert stats["medianModelWallMs"] is None
    assert stats["medianOrchestrationOverheadMs"] is None


def test_complete_native_timing_is_admitted_despite_unavailable_reviewer_tokens():
    rows = [_timed_episode(1, "a", economics={
        "wallMs": 1000, "modelWallMs": 400, "outputTokens": 10,
        "attemptedSessions": 1, "measuredSessions": 1, "incompleteSessions": 0,
        "measurementCoverage": "background_models_plus_end_to_end_wall; reviewer_tokens_unavailable",
    })]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianModelWallMs"] == 400
    assert stats["medianOrchestrationOverheadMs"] == 600


def test_impossible_negative_overhead_is_floored_at_zero():
    # modelWallMs > wallMs is impossible raw evidence; overhead floors at 0 rather than going
    # negative and understating a real arm's latency.
    rows = [
        _timed_episode(1, "a", economics={"wallMs": 500, "modelWallMs": 900, "outputTokens": 10}),
        _timed_episode(2, "a", economics={"wallMs": 500, "modelWallMs": 900, "outputTokens": 10}),
    ]
    stats = E.summarize(rows)["segments"][0]["arms"]["a"]
    assert stats["medianOrchestrationOverheadMs"] == 0


def test_overhead_does_not_change_quality_first_ranking():
    # An arm with lower model wall but huge orchestration overhead must not be reranked ahead of
    # a faster-overall arm: ranking stays on medianWallMs, then medianOutputTokens.
    rows = [
        _timed_episode(1, "fast", economics={"wallMs": 100, "modelWallMs": 90, "outputTokens": 10}),
        _timed_episode(2, "fast", economics={"wallMs": 100, "modelWallMs": 90, "outputTokens": 10}),
        _timed_episode(3, "slow", economics={"wallMs": 9000, "modelWallMs": 10, "outputTokens": 10}),
        _timed_episode(4, "slow", economics={"wallMs": 9000, "modelWallMs": 10, "outputTokens": 10}),
    ]
    plan = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 2, "qualityFloor": 0.5,
        "mode": "route", "arms": [{"id": "fast"}, {"id": "slow"}],
    }
    segment = E.summarize(rows, plans=[plan])["segments"][0]
    assert segment["leader"] == "fast", segment
    assert segment["arms"]["slow"]["medianOrchestrationOverheadMs"] == 8990


def test_task_class_filter_restricts_observed_rows_to_that_scenario():
    # Only episodes recorded under the exact task class are counted; other scenarios vanish.
    rows = [
        _seg_episode(1, "a", "sha256:cfg", task_class="feature"),
        _seg_episode(2, "a", "sha256:cfg", task_class="feature"),
        _seg_episode(3, "a", "sha256:cfg", task_class="research"),
    ]
    report = E.summarize(rows, task_class="feature")
    assert report["episodes"] == 2, report
    assert [seg["taskClass"] for seg in report["segments"]] == ["feature"]
    assert report["segments"][0]["arms"]["a"]["trials"] == 2


def test_task_class_filter_drops_plan_context_for_other_scenarios():
    # A plan for an unrelated task class must not seed a zero-trial segment under the filter.
    plan_other = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "research",
        "minimumTrials": 1, "qualityFloor": 0.5, "mode": "route", "arms": [{"id": "a"}],
    }
    plan_match = {
        "id": "exp", "configHash": "sha256:cfg", "taskClass": "feature",
        "minimumTrials": 1, "qualityFloor": 0.5, "mode": "route", "arms": [{"id": "a"}],
    }
    report = E.summarize([], plans=[plan_other, plan_match], task_class="feature")
    task_classes = [seg["taskClass"] for seg in report["segments"]]
    assert task_classes == ["feature"], "unrelated config must not create a zero-trial segment"


def test_task_class_filter_combines_with_experiment_filter():
    rows = [
        _seg_episode(1, "a", "sha256:cfg", task_class="feature"),
        _seg_episode(2, "a", "sha256:cfg", task_class="research"),
        E.make_episode(
            trace_id="f:z", feat_id="f", task_id="tz", task_hash="sha256:%064d" % 9,
            task_class="feature", pairing={"makerModel": "a", "reviewerModel": "judge"},
            outcome={"verificationPass": True, "independentReview": "clean",
                     "humanIntervention": False},
            economics={"wallMs": 1000, "outputTokens": 100},
            artifact={"commit": "%040d" % 9},
            experiment={"id": "other", "armId": "a", "configHash": "sha256:cfg"}, recorded_at=9),
    ]
    report = E.summarize(rows, experiment_id="exp", task_class="feature")
    assert report["experimentEpisodes"] == 1, report
    assert [(s["experimentId"], s["taskClass"]) for s in report["segments"]] == [("exp", "feature")]


def test_task_class_fails_closed_on_empty_value():
    with tempfile.TemporaryDirectory() as root:
        ledger = os.path.join(root, "episodes.jsonl")
        assert E.main(["--ledger", ledger, "--task-class", "   "]) == 2
        assert E.main(["--ledger", ledger, "--task-class", ""]) == 2
        # a real value is accepted (empty ledger → clean run)
        assert E.main(["--ledger", ledger, "--task-class", "feature", "--json"]) == 0


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
