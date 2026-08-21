#!/usr/bin/env python3
"""Local, provider-neutral evaluation ledger and sequential A/B assignment.

Camus optimizes lexicographically: clear the quality floor first, then compare latency and token
pressure.  A cheap failure never wins.  The ledger stores hashes/identities/metrics, not prompts,
diffs, or credentials.  It is append-only and may be rebuilt from receipts.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import statistics
import sys
import time


SCHEMA_VERSION = 1

# Sentinel distinguishing "do not filter on configHash" (the default) from an explicit
# request to match a specific configHash value, including the unversioned `None` segment.
_ANY_CONFIG_HASH = object()


class EvalError(Exception):
    pass


def camus_home():
    return os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


@contextlib.contextmanager
def _lock(path):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    with open(path + ".lock", "a+", encoding="utf-8") as fh:
        os.chmod(path + ".lock", 0o600)
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def read_jsonl(path, strict=False):
    out = []
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return out
    with fh:
        for line_no, line in enumerate(fh, 1):
            try:
                value = json.loads(line)
            except (TypeError, ValueError):
                if strict and line.strip():
                    raise EvalError("malformed JSONL at %s:%d" % (path, line_no))
                continue
            if isinstance(value, dict):
                out.append(value)
            elif strict:
                raise EvalError("non-object JSONL record at %s:%d" % (path, line_no))
    return out


class Ledger:
    def __init__(self, path=None):
        self.path = path or os.path.join(camus_home(), "evals", "episodes.jsonl")

    def records(self):
        return read_jsonl(self.path, strict=True)

    def append(self, record):
        if not isinstance(record, dict) or record.get("schemaVersion") != SCHEMA_VERSION:
            raise EvalError("eval record must be a schemaVersion 1 object")
        episode_id = record.get("episodeId")
        if not isinstance(episode_id, str) or not episode_id.startswith("sha256:"):
            raise EvalError("eval record lacks a content-addressed episodeId")
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        with _lock(self.path):
            existing = read_jsonl(self.path, strict=True)
            if any(item.get("episodeId") == episode_id for item in existing):
                return False
            with open(self.path, "a", encoding="utf-8") as fh:
                os.chmod(self.path, 0o600)
                fh.write(canonical(record) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        return True


def make_episode(*, trace_id, feat_id, task_id, task_hash, task_class, pairing, outcome,
                 economics, artifact, experiment=None, surface="cli", recorded_at=None):
    identity = {
        "traceId": trace_id, "featId": feat_id, "taskId": task_id,
        "artifact": artifact, "experiment": experiment,
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "episodeId": sha256(canonical(identity)),
        "recordedAt": int(time.time()) if recorded_at is None else int(recorded_at),
        "surface": surface,
        "traceId": trace_id,
        "featId": feat_id,
        "taskId": task_id,
        "taskHash": task_hash,
        "taskClass": task_class or "unknown",
        "pairing": pairing,
        "experiment": experiment,
        "outcome": outcome,
        "economics": economics,
        "artifact": artifact,
    }


def _nonempty(value, label):
    if not isinstance(value, str) or not value.strip():
        raise EvalError("%s must be a non-empty string" % label)
    return value.strip()


def load_experiment(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError) as exc:
        raise EvalError("could not read experiment config: %s" % exc)
    if not isinstance(value, dict):
        raise EvalError("experiment config must be an object")
    allowed_top = {"id", "taskClass", "minimumTrials", "qualityFloor", "mode", "arms"}
    if set(value) - allowed_top:
        raise EvalError("experiment config has unknown fields: %s" % ", ".join(sorted(set(value) - allowed_top)))
    experiment_id = _nonempty(value.get("id"), "experiment id")
    task_class = _nonempty(value.get("taskClass", "unknown"), "taskClass")
    arms = value.get("arms")
    if not isinstance(arms, list) or len(arms) < 2:
        raise EvalError("experiment needs at least two arms")
    arm_ids = set()
    normalized = []
    allowed = {
        "id", "makerModel", "makerEffort", "reviewerBackend", "reviewerModel",
        "reviewerEffort", "orchestratorModel",
    }
    for index, raw in enumerate(arms):
        if not isinstance(raw, dict) or set(raw) - allowed:
            raise EvalError("experiment arm %d has unknown or malformed fields" % index)
        arm = {key: raw[key] for key in allowed if key in raw}
        arm_id = _nonempty(arm.get("id"), "arm id")
        if arm_id in arm_ids:
            raise EvalError("duplicate experiment arm id %s" % arm_id)
        arm_ids.add(arm_id)
        for key in ("makerModel", "reviewerBackend", "reviewerModel", "reviewerEffort"):
            _nonempty(arm.get(key), "%s.%s" % (arm_id, key))
        arm.setdefault("makerEffort", "high")
        arm.setdefault("orchestratorModel", "sonnet")
        normalized.append(arm)
    minimum = value.get("minimumTrials", 3)
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise EvalError("minimumTrials must be a positive integer")
    quality_floor = value.get("qualityFloor", 0.8)
    if isinstance(quality_floor, bool) or not isinstance(quality_floor, (int, float)) \
            or not 0 <= quality_floor <= 1:
        raise EvalError("qualityFloor must be between 0 and 1")
    mode = value.get("mode", "explore")
    if mode not in ("explore", "route"):
        raise EvalError("mode must be explore|route")
    if mode == "route" and minimum < 5:
        raise EvalError("route mode requires minimumTrials >= 5")
    plan = {
        "schemaVersion": SCHEMA_VERSION,
        "id": experiment_id,
        "taskClass": task_class,
        "minimumTrials": minimum,
        "qualityFloor": float(quality_floor),
        "mode": mode,
        "arms": normalized,
    }
    plan["configHash"] = sha256(canonical(plan))
    return plan


def _floor_pass(record):
    outcome = record.get("outcome") if isinstance(record.get("outcome"), dict) else {}
    return (
        outcome.get("verificationPass") is True
        and outcome.get("independentReview") == "clean"
        and outcome.get("humanIntervention") is not True
    )


def _median(values):
    values = [value for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
    return statistics.median(values) if values else None


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _timing_coverage_complete(item):
    """Reject native partial timing even when its measured subset is numeric."""
    coverage = item.get("measurementCoverage")
    if isinstance(coverage, str):
        return coverage == "background_models_plus_end_to_end_wall; reviewer_tokens_unavailable"
    incomplete = item.get("incompleteSessions")
    return not (_is_number(incomplete) and incomplete > 0)


def _timing_pairs(economics):
    """Episodes carrying both raw timings, as (wallMs, modelWallMs) tuples.

    An episode contributes only when both wallMs and modelWallMs are real numbers; a missing side
    is never imputed. This is the single complete-pair population shared by every timing median
    that requires the pair.
    """
    return [
        (item.get("wallMs"), item.get("modelWallMs"))
        for item in economics
        if _is_number(item.get("wallMs")) and _is_number(item.get("modelWallMs"))
        and _timing_coverage_complete(item)
    ]


def _orchestration_overheads(pairs):
    """Per-episode native orchestration overhead over complete timing pairs.

    Overhead is max(0, wallMs - modelWallMs): the observed end-to-end wall time not spent inside
    the model. Impossible raw evidence (modelWallMs > wallMs) is floored at zero rather than
    reported as negative overhead.
    """
    return [max(0, wall - model) for wall, model in pairs]


def arm_stats(records, experiment_id, arm_id, task_class=None, config_hash=_ANY_CONFIG_HASH):
    rows = [
        row for row in records
        if isinstance(row.get("experiment"), dict)
        and row["experiment"].get("id") == experiment_id
        and row["experiment"].get("armId") == arm_id
        and (config_hash is _ANY_CONFIG_HASH or row["experiment"].get("configHash") == config_hash)
        and (task_class is None or row.get("taskClass") == task_class)
    ]
    passed = sum(1 for row in rows if _floor_pass(row))
    economics = [row.get("economics") for row in rows if isinstance(row.get("economics"), dict)]
    pairs = _timing_pairs(economics)
    return {
        "trials": len(rows),
        "qualityFloorPasses": passed,
        "qualityFloorRate": passed / len(rows) if rows else None,
        "medianWallMs": _median([item.get("wallMs") for item in economics]),
        "medianModelWallMs": _median([model for _wall, model in pairs]),
        "medianOrchestrationOverheadMs": _median(_orchestration_overheads(pairs)),
        "medianOutputTokens": _median([item.get("outputTokens") for item in economics]),
    }


def select_arm(plan, records, assignment_key):
    """Balanced assignment first; evidence-gated exploitation only after every arm is sampled."""
    stats = {
        arm["id"]: arm_stats(
            records, plan["id"], arm["id"], task_class=plan["taskClass"],
            config_hash=plan.get("configHash"),
        )
        for arm in plan["arms"]
    }
    minimum = min(item["trials"] for item in stats.values())
    least_sampled = [arm for arm in plan["arms"] if stats[arm["id"]]["trials"] == minimum]
    if minimum < plan["minimumTrials"]:
        candidates = least_sampled
        reason = "balanced exploration until every arm reaches minimumTrials"
    elif plan.get("mode", "route") != "route":
        candidates = least_sampled
        reason = "explore mode keeps balanced assignment; routing is not authorized"
    else:
        eligible = [
            arm for arm in plan["arms"]
            if (stats[arm["id"]]["qualityFloorRate"] or 0) >= plan["qualityFloor"]
        ]
        if eligible:
            candidates = sorted(eligible, key=lambda arm: (
                stats[arm["id"]]["medianWallMs"] is None,
                stats[arm["id"]]["medianWallMs"] if stats[arm["id"]]["medianWallMs"] is not None else 0.0,
                stats[arm["id"]]["medianOutputTokens"] is None,
                stats[arm["id"]]["medianOutputTokens"] if stats[arm["id"]]["medianOutputTokens"] is not None else 0.0,
                arm["id"],
            ))
            candidates = [candidates[0]]
            reason = "quality floor met; lowest observed median latency/token pressure"
        else:
            candidates = least_sampled
            reason = "no arm clears the quality floor; continue balanced exploration"
    digest = hashlib.sha256((str(assignment_key) + "\n" + plan["id"]).encode("utf-8")).digest()
    selected = candidates[int.from_bytes(digest[:8], "big") % len(candidates)]
    return selected, {"reason": reason, "stats": stats}


def experiment_segments(rows):
    """Group experiment episodes by the exact (id, configHash, taskClass) they were run under.

    Trials from different configurations (configHash) or task classes are never the same
    comparison, so each becomes its own segment; arms are compared only within one.
    """
    segments = {}
    for row in rows:
        experiment = row.get("experiment")
        if not isinstance(experiment, dict) or not experiment.get("id") or not experiment.get("armId"):
            continue
        key = (experiment["id"], experiment.get("configHash"), row.get("taskClass") or "unknown")
        segments.setdefault(key, set()).add(experiment["armId"])
    return segments


def _matching_plan(plans, experiment_id, config_hash, task_class):
    """A plan supplies qualityFloor/minimumTrials only for the exact generation it configures.

    Match is exact on (id, configHash, taskClass): a plan for one task class must never supply
    thresholds to a different task-class segment sharing the same id/hash, or it could authorize a
    leader for a reported task class that has no matching configuration (fail-closed).
    """
    if config_hash is None:
        return None
    for plan in plans or []:
        if (
            plan.get("id") == experiment_id
            and plan.get("configHash") == config_hash
            and plan.get("taskClass") == task_class
        ):
            return plan
    return None


def _rank_eligible(stats, arm_ids, quality_floor):
    """Lexicographic quality-first ranking: floor first, then latency, then token pressure."""
    eligible = [arm for arm in arm_ids if (stats[arm]["qualityFloorRate"] or 0) >= quality_floor]
    eligible.sort(key=lambda arm: (
        stats[arm]["medianWallMs"] is None,
        stats[arm]["medianWallMs"] if stats[arm]["medianWallMs"] is not None else 0.0,
        stats[arm]["medianOutputTokens"] is None,
        stats[arm]["medianOutputTokens"] if stats[arm]["medianOutputTokens"] is not None else 0.0,
        arm,
    ))
    return eligible


def _segment_report(rows, experiment_id, config_hash, task_class, arm_ids, plan):
    # Report every configured plan arm plus any observed arm, so a configured arm with zero trials
    # still appears (and blocks coverage) rather than silently vanishing from the per-arm report.
    plan_arm_ids = [arm["id"] for arm in plan.get("arms", [])] if plan else []
    report_arm_ids = sorted(set(arm_ids) | set(plan_arm_ids))
    stats = {
        arm: arm_stats(rows, experiment_id, arm, task_class=task_class, config_hash=config_hash)
        for arm in report_arm_ids
    }
    segment = {
        "experimentId": experiment_id,
        "configHash": config_hash,
        "taskClass": task_class,
        "arms": stats,
        "trials": sum(item["trials"] for item in stats.values()),
        "experimentMode": None,
        "minimumTrials": None,
        "qualityFloor": None,
        "coverageComplete": None,
        "routingConfigured": False,
        "routingEligible": False,
        "leader": None,
    }
    if plan is None:
        # Without the matching configured qualityFloor and minimumTrials we cannot name a
        # leader or routing winner — only report exploratory coverage.
        segment["standing"] = "exploratory_only"
        return segment
    minimum = plan["minimumTrials"]
    segment["experimentMode"] = plan["mode"]
    segment["minimumTrials"] = minimum
    segment["qualityFloor"] = plan["qualityFloor"]
    segment["routingConfigured"] = plan.get("mode") == "route"
    # Coverage is complete only when every *configured* arm reaches minimumTrials. Observed but
    # unconfigured ("rogue") arms can never substitute for a missing configured arm.
    covered = (
        bool(plan_arm_ids)
        and all(stats[arm]["trials"] >= minimum for arm in plan_arm_ids)
    )
    segment["coverageComplete"] = covered
    if not covered:
        segment["standing"] = "coverage_incomplete"
        return segment
    # A leader may only be named among the configured arms.
    eligible = _rank_eligible(stats, plan_arm_ids, plan["qualityFloor"])
    if not eligible:
        segment["standing"] = "no_arm_clears_quality_floor"
        return segment
    segment["leader"] = eligible[0]
    segment["routingEligible"] = segment["routingConfigured"]
    segment["standing"] = "routing_leader" if segment["routingEligible"] else "exploratory_leader"
    return segment


def summarize(records, experiment_id=None, plans=None, task_class=None):
    rows = [row for row in records if row.get("schemaVersion") == SCHEMA_VERSION]
    if experiment_id:
        rows = [row for row in rows if isinstance(row.get("experiment"), dict)
                and row["experiment"].get("id") == experiment_id]
    # A task-class filter scopes the report to one exact scenario: observed rows AND supplied
    # plan context are both restricted, so an unrelated config can never seed a zero-trial
    # segment for a task class the operator did not ask about.
    if task_class is not None:
        rows = [row for row in rows if (row.get("taskClass") or "unknown") == task_class]
        plans = [plan for plan in (plans or []) if plan.get("taskClass") == task_class]
    segment_arms = experiment_segments(rows)
    # A supplied plan is itself useful coverage context. Show all configured arms at n=0 even
    # before the first episode rather than making a valid experiment disappear from the report.
    for plan in plans or []:
        if experiment_id and plan.get("id") != experiment_id:
            continue
        key = (plan.get("id"), plan.get("configHash"), plan.get("taskClass"))
        segment_arms.setdefault(key, set())
    segments = []
    generations = {}
    for (exp_id, config_hash, task_class) in sorted(
            segment_arms, key=lambda key: (key[0], key[1] or "", key[2])):
        plan = _matching_plan(plans, exp_id, config_hash, task_class)
        segments.append(_segment_report(
            rows, exp_id, config_hash, task_class, segment_arms[(exp_id, config_hash, task_class)], plan,
        ))
        generations.setdefault(exp_id, set()).add(config_hash)
    experiments = {}
    for exp_id, hashes in sorted(generations.items()):
        # Standing is never aggregated across generations: differing configHashes are different
        # experiments that happen to share an id, so the cross-generation standing is suppressed.
        experiments[exp_id] = {
            "generations": len(hashes),
            "standing": "mixed_generations" if len(hashes) > 1 else "single_generation",
        }
    mixed = any(info["standing"] == "mixed_generations" for info in experiments.values())
    experiment_episodes = sum(
        1 for row in rows
        if isinstance(row.get("experiment"), dict)
        and row["experiment"].get("id")
        and row["experiment"].get("armId")
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "episodes": len(rows),
        "experimentEpisodes": experiment_episodes,
        "qualityFloorPasses": sum(1 for row in rows if _floor_pass(row)),
        "segments": segments,
        "experiments": experiments,
        "standing": (
            "no_experiments" if not experiments
            else "mixed_generations" if mixed
            else "segmented_only"
        ),
        "note": (
            "Operational quality uses deterministic verification plus an independent clean review. "
            "It is not human calibration and does not establish a universal best model."
        ),
    }


def _short_hash(config_hash):
    if not isinstance(config_hash, str):
        return "unversioned"
    return config_hash.split(":", 1)[-1][:10] or "unversioned"


def _standing_line(segment):
    if segment["leader"] is not None:
        kind = "routing winner" if segment["routingEligible"] else "quality-first leader"
        return "%s: %s (this generation and task class only)" % (kind, segment["leader"])
    reasons = {
        "exploratory_only": "no leader — configured qualityFloor/minimumTrials unavailable",
        "coverage_incomplete": "no leader — minimumTrials coverage not yet reached",
        "no_arm_clears_quality_floor": "no leader — no arm clears the quality floor",
    }
    return reasons.get(segment["standing"], segment["standing"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camus local eval and A/B ledger")
    parser.add_argument("--ledger", default=None)
    parser.add_argument("--experiment", default=None, help="filter the report to one experiment id")
    parser.add_argument("--task-class", default=None, dest="task_class", metavar="NAME",
                        help="filter the report to one exact task class: both observed episodes and "
                             "supplied --config context are restricted to it (fails closed if empty)")
    parser.add_argument("--config", action="append", default=[], metavar="JSON",
                        help="experiment config supplying qualityFloor/minimumTrials for its generation "
                             "(repeatable); required before any leader can be named")
    parser.add_argument("--json", action="store_true")
    options = parser.parse_args(argv)
    task_class = options.task_class
    if task_class is not None:
        try:
            task_class = _nonempty(task_class, "--task-class")
        except EvalError as exc:
            print("error: %s" % exc, file=sys.stderr)
            return 2
    try:
        plans = [load_experiment(path) for path in options.config]
    except EvalError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    report = summarize(Ledger(options.ledger).records(),
                       experiment_id=options.experiment, plans=plans, task_class=task_class)
    if options.json:
        print(canonical(report))
    else:
        print("Camus evals · %d ledger episode(s) · %d experiment trial(s) · "
              "%d quality-floor pass(es)" % (
                  report["episodes"], report["experimentEpisodes"],
                  report["qualityFloorPasses"],
        ))
        for segment in report["segments"]:
            mixed = report["experiments"].get(segment["experimentId"], {}).get("generations", 1) > 1
            print("\n%s · gen %s · task %s%s" % (
                segment["experimentId"], _short_hash(segment["configHash"]),
                segment["taskClass"], "  [mixed generations — not aggregated]" if mixed else "",
            ))
            minimum = segment["minimumTrials"]
            for arm, stats in segment["arms"].items():
                rate = "—" if stats["qualityFloorRate"] is None else "%.0f%%" % (100 * stats["qualityFloorRate"])
                wall = "—" if stats["medianWallMs"] is None else "%.1fm" % (stats["medianWallMs"] / 60000)
                model_wall = "—" if stats["medianModelWallMs"] is None \
                    else "%.1fm" % (stats["medianModelWallMs"] / 60000)
                overhead = "—" if stats["medianOrchestrationOverheadMs"] is None \
                    else "%.1fm" % (stats["medianOrchestrationOverheadMs"] / 60000)
                coverage = "n=%d" % stats["trials"] if minimum is None \
                    else "n=%d/%d" % (stats["trials"], minimum)
                print("  %-18s %s quality=%s median=%s model=%s overhead=%s" % (
                    arm, coverage, rate, wall, model_wall, overhead))
            print("  → %s" % _standing_line(segment))
        print("\n" + report["note"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
