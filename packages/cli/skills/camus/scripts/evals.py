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


def arm_stats(records, experiment_id, arm_id, task_class=None, config_hash=None):
    rows = [
        row for row in records
        if isinstance(row.get("experiment"), dict)
        and row["experiment"].get("id") == experiment_id
        and row["experiment"].get("armId") == arm_id
        and (config_hash is None or row["experiment"].get("configHash") == config_hash)
        and (task_class is None or row.get("taskClass") == task_class)
    ]
    passed = sum(1 for row in rows if _floor_pass(row))
    economics = [row.get("economics") for row in rows if isinstance(row.get("economics"), dict)]
    return {
        "trials": len(rows),
        "qualityFloorPasses": passed,
        "qualityFloorRate": passed / len(rows) if rows else None,
        "medianWallMs": _median([item.get("wallMs") for item in economics]),
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
                stats[arm["id"]]["medianWallMs"] or float("inf"),
                stats[arm["id"]]["medianOutputTokens"] is None,
                stats[arm["id"]]["medianOutputTokens"] or float("inf"),
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


def summarize(records, experiment_id=None):
    rows = [row for row in records if row.get("schemaVersion") == SCHEMA_VERSION]
    if experiment_id:
        rows = [row for row in rows if isinstance(row.get("experiment"), dict)
                and row["experiment"].get("id") == experiment_id]
    experiments = {}
    for row in rows:
        experiment = row.get("experiment")
        if not isinstance(experiment, dict) or not experiment.get("id") or not experiment.get("armId"):
            continue
        experiments.setdefault(experiment["id"], set()).add(experiment["armId"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "episodes": len(rows),
        "qualityFloorPasses": sum(1 for row in rows if _floor_pass(row)),
        "experiments": {
            exp: {arm: arm_stats(rows, exp, arm) for arm in sorted(arms)}
            for exp, arms in sorted(experiments.items())
        },
        "standing": (
            "exploratory_only" if experiments
            else "no_experiments"
        ),
        "note": (
            "Operational quality uses deterministic verification plus an independent clean review. "
            "It is not human calibration and does not establish a universal best model."
        ),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camus local eval and A/B ledger")
    parser.add_argument("--ledger", default=None)
    parser.add_argument("--experiment", default=None)
    parser.add_argument("--json", action="store_true")
    options = parser.parse_args(argv)
    report = summarize(Ledger(options.ledger).records(), experiment_id=options.experiment)
    if options.json:
        print(canonical(report))
    else:
        print("Camus evals · %d episode(s) · %d quality-floor pass(es)" % (
            report["episodes"], report["qualityFloorPasses"],
        ))
        for experiment, arms in report["experiments"].items():
            print("\n%s" % experiment)
            for arm, stats in arms.items():
                rate = "—" if stats["qualityFloorRate"] is None else "%.0f%%" % (100 * stats["qualityFloorRate"])
                wall = "—" if stats["medianWallMs"] is None else "%.1fm" % (stats["medianWallMs"] / 60000)
                print("  %-18s n=%d quality=%s median=%s" % (arm, stats["trials"], rate, wall))
        print("\n" + report["note"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
