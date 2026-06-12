#!/usr/bin/env python3
"""`camus retro` — deterministic, read-only analytics over your Camus run history.

Every finished feat leaves a report at $CAMUS_HOME/reports/<featId>.json (the same home seam
land.py reads). retro reads that pile and prints what actually happened across runs — per-feat
one-liners, aggregate stats, and a small set of evidence-gated observations — WITHOUT calling a
model or writing a byte. It is read-only BY CONSTRUCTION: no open(...,'w'), no subprocess, no
network. The "zero writes" test asserts the reports dir is byte-for-byte untouched after a run.

  retro.py            per-feat lines + aggregates + evidence-gated recommendations
      [--json]        emit ONLY the aggregate block as JSON (no prose, no recommendations)

SCHEMA TOLERANCE is the whole job. The report shape evolved across versions, so EVERY field is
optional and read via .get() with a default: top-level `posture` and `totalOutputTokens` are
absent on older reports; per-task `tokens`, `rounds`, `tier`, `model` are all sparse (a 0.2.4
report has no posture; a legacy halt has no top-level tokens and a task with no `tokens`). A
half-written or non-dict report is skipped silently — one corrupt file must never abort the
whole analysis. Token/round values are coerced defensively; anything non-numeric is ignored.

RECOMMENDATIONS are the load-bearing contract. Each candidate observation is backed by a COUNTED
evidence set; it is emitted ONLY when that set has >= MIN_EVIDENCE (3) data points, and it cites
the count + the driving numbers inline. Below the threshold it prints "insufficient data (N
runs)" for that observation instead of extrapolating. With a real home of only a handful of
reports most fall to the insufficient-data branch — that honest restraint is the point. The
catalogue is deliberately small and purely descriptive (posture mix, high review-rounds, token
p90/p50 spread): read-only signals a human reads, never an action that could mislead.
"""
import argparse
import glob
import json
import os
import sys

MIN_EVIDENCE = 3            # a recommendation needs at least this many supporting data points


def reports_dir():
    """$CAMUS_HOME/reports, resolved at CALL time (not import) so tests sandbox via os.environ
    — the identical home seam as reconcile.camus_home()/land. Copied (~4 lines) rather than
    imported: reconcile drags in subprocess/git machinery retro never touches."""
    home = os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")
    return os.path.join(home, "reports")


def _read_json(path):
    """Return the report dict, or None when missing / unparseable / not a dict. A mid-write
    race or a hand-mangled file is SKIPPED, never fatal — same tolerance as reconcile._read_json
    minus the missing/corrupt distinction retro does not need (a skipped report is a skipped
    report)."""
    try:
        with open(path, encoding="utf-8") as fh:
            obj = json.loads(fh.read())
    except (OSError, ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _num(value):
    """Coerce to a number defensively, else None. Reports are human-and-machine-written; a
    token field that somehow holds "n/a" or a list must not crash a percentile."""
    if isinstance(value, bool):           # bool is an int subclass — never a token count
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def load():
    """Glob reports/*.json and return the list of report dicts that parsed (sorted by path for
    determinism). Non-dict / unparseable files are dropped silently."""
    reports = []
    for path in sorted(glob.glob(os.path.join(reports_dir(), "*.json"))):
        obj = _read_json(path)
        if obj is not None:
            reports.append(obj)
    return reports


def _percentile(values, pct):
    """Linear-interpolation percentile over a list of numbers (pure python, no numpy). Returns
    None for an empty input. pct in [0,100]."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    frac = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * frac


def _fmt_num(value):
    """Render a token/percentile number compactly: whole numbers without a trailing .0."""
    if value is None:
        return "-"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def feat_tokens(report):
    """Best available token figure for a feat: top-level totalOutputTokens, else the sum of
    per-task numeric `tokens`, else None — exactly the precedence the per-feat line shows."""
    top = _num(report.get("totalOutputTokens"))
    if top is not None:
        return top
    per_task = [t for t in (_num(tk.get("tokens"))
                            for tk in report.get("tasks", []) if isinstance(tk, dict))
                if t is not None]
    return sum(per_task) if per_task else None


def aggregate(reports):
    """The machine-readable core (also what --json emits): status mix, posture usage (with an
    explicit "unset" bucket), rounds distribution, per-task token p50/p90, and the run count.
    Percentiles are computed ONLY over tasks that actually carry a numeric tokens field."""
    status_mix, posture_usage, rounds_dist = {}, {}, {}
    task_tokens, all_rounds = [], []
    for report in reports:
        status = report.get("status") or "unknown"
        status_mix[status] = status_mix.get(status, 0) + 1
        posture = report.get("posture") or "unset"
        posture_usage[posture] = posture_usage.get(posture, 0) + 1
        for task in report.get("tasks", []):
            if not isinstance(task, dict):
                continue
            tok = _num(task.get("tokens"))
            if tok is not None:
                task_tokens.append(tok)
            rnd = _num(task.get("rounds"))
            if rnd is not None:
                all_rounds.append(rnd)
                key = str(int(rnd)) if float(rnd).is_integer() else str(rnd)
                rounds_dist[key] = rounds_dist.get(key, 0) + 1
    return {
        "runs": len(reports),
        "statusMix": status_mix,
        "postureUsage": posture_usage,
        "roundsDistribution": rounds_dist,
        "tokenTasks": len(task_tokens),
        "tokenP50": _percentile(task_tokens, 50),
        "tokenP90": _percentile(task_tokens, 90),
        "_task_tokens": task_tokens,     # internal: drives recommendations; stripped from --json
        "_all_rounds": all_rounds,
    }


def recommendations(reports, agg):
    """The evidence-gated catalogue. Each entry yields (label, supporting_count, line): the line
    cites the count + driving numbers when supporting_count >= MIN_EVIDENCE, else it is the
    honest "insufficient data (N runs)". Purely descriptive signals only — nothing here suggests
    an irreversible action, because retro is read-only and must not over-claim from thin data."""
    out = []

    # 1) Posture mix — how often a non-default posture was chosen. Evidence = runs that named a
    #    posture at all (the older reports without the field can't speak to posture choice).
    postured = {p: n for p, n in agg["postureUsage"].items() if p != "unset"}
    postured_runs = sum(postured.values())
    if postured_runs >= MIN_EVIDENCE:
        top = sorted(postured.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        out.append(("posture-mix", postured_runs,
                    "posture-mix: %s used in %d/%d posture-tagged runs (%s)"
                    % (top[0], top[1], postured_runs,
                       ", ".join("%s=%d" % (p, n) for p, n in sorted(postured.items())))))
    else:
        out.append(("posture-mix", postured_runs,
                    "posture-mix: insufficient data (%d runs)" % postured_runs))

    # 2) High review-rounds — tasks that needed >= 2 review rounds. Evidence = tasks that
    #    recorded a `rounds` count at all (sparse on older reports).
    rounds = agg["_all_rounds"]
    high = [r for r in rounds if r >= 2]
    if len(rounds) >= MIN_EVIDENCE:
        out.append(("review-rounds-high", len(rounds),
                    "review-rounds-high: %d/%d rounds-tracked tasks needed >=2 review rounds "
                    "(max %s)" % (len(high), len(rounds), _fmt_num(max(rounds)) if rounds else "-")))
    else:
        out.append(("review-rounds-high", len(rounds),
                    "review-rounds-high: insufficient data (%d runs)" % len(rounds)))

    # 3) Token spread — the p90/p50 ratio over per-task token counts, a rough "how lopsided is
    #    cost across tasks" signal. Evidence = tasks carrying a numeric tokens field.
    toks = agg["_task_tokens"]
    p50, p90 = agg["tokenP50"], agg["tokenP90"]
    if len(toks) >= MIN_EVIDENCE:
        # Evidence is sufficient. A zero median is a valid report value (tokens=0), so the
        # ratio is undefined rather than under-evidenced — report the spread, guarding /0.
        if p50:
            ratio = "%.1fx" % (p90 / p50)
        else:
            ratio = "n/a (p50=0)"
        out.append(("token-spread", len(toks),
                    "token-spread: p90/p50 = %s across %d token-tracked tasks "
                    "(p50=%s, p90=%s)"
                    % (ratio, len(toks), _fmt_num(p50), _fmt_num(p90))))
    else:
        out.append(("token-spread", len(toks),
                    "token-spread: insufficient data (%d runs)" % len(toks)))

    return out


def render(reports):
    """The human report: per-feat one-liners, then the aggregate block, then recommendations."""
    lines = []
    agg = aggregate(reports)

    lines.append("== per-feat (%d report%s) ==" % (len(reports), "" if len(reports) == 1 else "s"))
    if not reports:
        lines.append("  (no reports in %s)" % reports_dir())
    for report in reports:
        feat_id = report.get("featId") or "?"
        status = report.get("status") or "unknown"
        posture = report.get("posture") or "-"
        tasks = [t for t in report.get("tasks", []) if isinstance(t, dict)]
        toks = feat_tokens(report)
        lines.append("  %-40s status=%-18s posture=%-8s tasks=%-2d tokens=%s"
                     % (feat_id, status, posture, len(tasks), _fmt_num(toks)))

    lines.append("")
    lines.append("== aggregate ==")
    lines.append("  status mix:   %s" % (_kv(agg["statusMix"]) or "-"))
    lines.append("  posture:      %s" % (_kv(agg["postureUsage"]) or "-"))
    lines.append("  rounds:       %s" % (_kv(agg["roundsDistribution"]) or "(none recorded)"))
    lines.append("  task tokens:  p50=%s  p90=%s  (over %d task%s with a tokens field)"
                 % (_fmt_num(agg["tokenP50"]), _fmt_num(agg["tokenP90"]),
                    agg["tokenTasks"], "" if agg["tokenTasks"] == 1 else "s"))

    lines.append("")
    lines.append("== recommendations (each needs >=%d supporting data points) ==" % MIN_EVIDENCE)
    for _label, _count, line in recommendations(reports, agg):
        lines.append("  - %s" % line)

    return "\n".join(lines)


def _kv(mapping):
    """Render a {key: count} dict deterministically as 'k=v, k=v' (sorted by key)."""
    return ", ".join("%s=%d" % (k, mapping[k]) for k in sorted(mapping))


def _public_aggregate(agg):
    """The aggregate with internal drivers (leading-underscore keys) stripped — what --json
    emits. Kept separate so the JSON contract is exactly the documented aggregate keys."""
    return {k: v for k, v in agg.items() if not k.startswith("_")}


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Read-only analytics over your Camus run history "
                    "($CAMUS_HOME/reports/*.json). No model calls, no writes.")
    ap.add_argument("--json", action="store_true",
                    help="emit ONLY the aggregate block as JSON (no per-feat prose, no "
                         "recommendation prose)")
    args = ap.parse_args(argv)

    reports = load()

    if args.json:
        print(json.dumps(_public_aggregate(aggregate(reports)), indent=2, sort_keys=True))
        return 0

    print(render(reports))
    return 0


if __name__ == "__main__":
    sys.exit(main())
