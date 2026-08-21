#!/usr/bin/env python3
"""Live status dashboard for a Camus feat run — the human's "what is going on?" surface.

Read-only: synthesizes everything from artifacts the run already writes, so it works from any
terminal while the run is in flight (no Claude session, no tokens, no gate involvement):
  - ~/.camus/feats/<featId>.json    state: tasks, statuses, telemetry, the run-log event ring
  - ~/.camus/feats/<featId>.hb      0.2.5 heartbeat: `touch`ed at every phase boundary — its
                                    MTIME is the whole signal (contents irrelevant; may not exist)
  - ~/.camus/reviews/<wt>-r<n>.json per-round Codex audit files (mtimes = a real timeline)
  - ~/.camus/steer/<featId>.json    a pending human steering note, if any (see steer.py)

  status.py [featId] [--json] [--dir BASE]   # BASE defaults to ~/.camus

Without a featId, shows the most recently updated feat state (running runs touch their state
file as they advance, so "most recent" is the live one). --json emits the raw synthesis for
scripting. Exit 0 always when a state exists; exit 1 when there is nothing to show.
"""
import argparse
import datetime
import json
import os
import sys
import time

try:
    import transcripts as _transcripts   # best-effort live-agent enrichment (same scripts dir)
except ImportError:
    _transcripts = None

GLYPH = {
    "done": "✓",
    "running": "▸",
    "pending": "·",
    "noop": "–",
    "failed": "✗",
    "merge_failed": "✗",
    "needs_human": "?",
    "needs_decision": "◆",   # review didn't converge but verify is GREEN — a decision, not a failure
    "ready_to_merge": "◇",   # loop finished (review+commit+verify) but the merge hadn't landed yet
    "done_with_findings": "◈",   # merged + verify-green, review debt deferred to the human — never plain ✓
}

EVENTS_SHOWN = 10       # "last 10 steps"
REVIEWS_SHOWN = 5
LIVE_SHOWN = 8          # live agents from the workflow transcripts
# Liveness, two layers (HARNESS-DIRECTION item 1; display half shipped 2026-06-11):
#   1. FIRST-CLASS, feat-bound: 0.2.5 engines `touch` ~/.camus/feats/<featId>.hb at every phase
#      boundary (plan/implement and review/fix/verify/prep/commit), so "running" + a quiet
#      heartbeat is decidable with NO transcript dependency — `running` must mean running.
#      Pre-0.2.5 runs have no .hb and must render exactly as before (no new warnings: their
#      state only writes at task boundaries, which can legitimately be >10 min apart).
#   2. FINE-GRAINED, best-effort (run feedback 2026-06-11): agent transcripts append per message
#      and show what each agent is DOING — but they come from the repo's most-recent wf dir, not
#      a feat-bound wf_id, so concurrent runs in one repo (or inspecting an older feat) can
#      mislead, and an unreadable transcript format degrades them entirely.
LIVENESS_STALE_S = 600  # quiet for 10 min during a "running" feat → probably dead (both layers)


def _parse_ts(s):
    """ISO-8601 timestamp (transcript `lastTs`) → epoch seconds, or None. Never raises."""
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, AttributeError):
        return None


def default_base():
    return os.path.join(os.path.expanduser("~"), ".camus")


def _read_json(path):
    """Return (obj, problem): (dict, None) | (None, "missing") | (None, "corrupt").
    Corrupt ≠ missing on purpose — a mid-write race or a damaged state file must never
    masquerade as "no run exists" (same infra-vs-findings discipline as the engine)."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None, "missing"
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None, "corrupt"
    return (obj, None) if isinstance(obj, dict) else (None, "corrupt")


def find_state(base, feat_id=None):
    """Return (state, path, corrupt_paths). Explicit featId: its state or None (path tells
    where it looked). No featId: the most recently written PARSEABLE state — a corrupt
    newest file (mid-write race) falls back to the next-newest instead of hiding the run."""
    feats_dir = os.path.join(base, "feats")
    if feat_id:
        path = os.path.join(feats_dir, feat_id + ".json")
        obj, problem = _read_json(path)
        return obj, path, ([path] if problem == "corrupt" else [])
    try:
        names = [n for n in os.listdir(feats_dir) if n.endswith(".json")]
    except OSError:
        return None, None, []
    by_mtime = []
    for name in names:
        path = os.path.join(feats_dir, name)
        try:
            by_mtime.append((os.path.getmtime(path), path))
        except OSError:
            continue
    corrupt = []
    for _, path in sorted(by_mtime, reverse=True):
        obj, problem = _read_json(path)
        if obj is not None:
            return obj, path, corrupt
        if problem == "corrupt":
            corrupt.append(path)
    return None, None, corrupt


def review_activity(base, task_ids, now=None):
    """Most recent per-round Codex audit files for this feat's tasks (mtime-sorted, newest last)."""
    now = time.time() if now is None else now
    reviews_dir = os.path.join(base, "reviews")
    out = []
    try:
        names = os.listdir(reviews_dir)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        stem = name[:-5]                      # camus-wt-<taskId>-r<round>
        for tid in task_ids:
            prefix = "camus-wt-%s-r" % tid
            if stem.startswith(prefix):
                rnd = stem[len(prefix):]
                if not rnd.isdigit():
                    continue
                try:
                    mtime = os.path.getmtime(os.path.join(reviews_dir, name))
                except OSError:
                    continue
                out.append({"taskId": tid, "round": rnd, "mtime": mtime, "age": max(0, now - mtime)})
                break
    out.sort(key=lambda e: e["mtime"])
    return out[-REVIEWS_SHOWN:]


def steer_note(base, feat_id):
    return _read_json(os.path.join(base, "steer", "%s.json" % feat_id))[0]


def steer_claim_present(base, feat_id):
    # A `<feat>.json.consuming` claim from a crashed consume is PENDING state a feat re-run recovers
    # (re-soak 2026-06-14, finding P2). status must surface it, not report "none pending" over it.
    return os.path.exists(os.path.join(base, "steer", "%s.json.consuming" % feat_id))


def fmt_age(sec):
    if sec is None:
        return "?"
    sec = int(sec)
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm%02ds" % (sec // 60, sec % 60)
    return "%dh%02dm" % (sec // 3600, (sec % 3600) // 60)


def fmt_tokens(tokens):
    return "~%dk tokens" % round(tokens / 1000.0) if isinstance(tokens, (int, float)) else None


def _direct_output_stop_kind(state, question=""):
    kernel_state = state.get("kernel") if isinstance(state.get("kernel"), dict) else {}
    kind = kernel_state.get("stopKind")
    if kind in ("direct_output_budget", "direct_output_reserve"):
        return kind
    reason = kernel_state.get("stopReason") or question
    if not isinstance(reason, str):
        return None
    if reason.startswith("direct output-token budget exhausted ("):
        return "direct_output_budget"
    if reason.startswith("direct output reserve exhausted ("):
        return "direct_output_reserve"
    return None


def synthesize(base, feat_id=None, now=None, repo=None):
    """Gather everything into one plain dict (the --json output and the render() input).
    Returns None when nothing exists; a dict WITHOUT "state" (only "corrupt": [paths]) when
    the only candidate state file(s) exist but won't parse — callers must report that
    distinctly, never as "no run"."""
    now = time.time() if now is None else now
    state, path, corrupt = find_state(base, feat_id)
    if not state:
        return {"corrupt": corrupt} if corrupt else None
    try:
        state_mtime = os.path.getmtime(path)
        age = max(0, now - state_mtime)
    except OSError:
        state_mtime, age = None, None
    # Heartbeat (item 1, display half 2026-06-11): the loop's runner agents `touch` a .hb sibling
    # of the state file at every phase boundary — its MTIME is the signal, contents irrelevant.
    # The heartbeat age is taken from the NEWEST of (.hb, state json): either artifact moving
    # proves life, and the state json keeps writing at boundaries on its own. Pre-0.2.5 runs have
    # no .hb → heartbeatAge stays None and every consumer degrades to the legacy rendering.
    hb_age = None
    if state_mtime is not None:
        try:
            hb_age = max(0, now - max(state_mtime, os.path.getmtime(os.path.splitext(path)[0] + ".hb")))
        except OSError:
            hb_age = None
    task_ids = [t.get("taskId") for t in state.get("tasks", []) if isinstance(t, dict) and t.get("taskId")]
    # Best-effort live-agent enrichment from the workflow transcripts (the repo is the cwd the
    # user runs `camus watch`/`status` from). NEVER fatal — degrades to [] when unavailable.
    live = []
    cost = None
    if _transcripts is not None:
        try:
            live = _transcripts.live_agents(repo or os.getcwd())
            cost = _transcripts.estimate_cost_usd(live)
        except Exception:  # noqa: BLE001
            live, cost = [], None
    return {
        "state": state,
        "statePath": path,
        "stateAge": age,
        "heartbeatAge": hb_age,
        "reviews": review_activity(base, task_ids, now=now),
        "steer": steer_note(base, state.get("featId", "")),
        "steerClaim": steer_claim_present(base, state.get("featId", "")),
        "live": live,
        "cost": cost,
        **({"skippedCorrupt": corrupt} if corrupt else {}),
    }


def render(synth, now=None):
    """Human dashboard as a list of lines."""
    now = time.time() if now is None else now
    s = synth["state"]
    lines = []
    status = s.get("status", "?")
    lines.append("Camus feat: %s   [%s]" % (s.get("feat", "?"), status))
    # Freshness: with a .hb (0.2.5 engines) "last heartbeat" REPLACES the legacy phrasing — it
    # subsumes it (heartbeatAge is computed from the newest of state json and .hb mtimes), and a
    # second age on the same line would just invite "which one do I trust?". Without a .hb
    # (pre-0.2.5 runs) the line stays byte-identical to what it always said.
    hb_age = synth.get("heartbeatAge")
    # Posture visibility (VELOCITY §1 invariant, display half 2026-06-11): a speed posture must
    # never silently impersonate the full gate, so a non-"full" posture is loud in the header.
    # Absent (pre-posture states) or "full" → byte-identical to the legacy id line.
    posture = s.get("posture")
    lines.append("  id %s · branch %s · base %s · %s%s"
                 % (s.get("featId", "?"), s.get("featBranch", "?"), s.get("base", "?"),
                    ("last heartbeat %s ago" % fmt_age(hb_age)) if hb_age is not None
                    else ("state updated %s ago" % fmt_age(synth.get("stateAge"))),
                    (" · posture %s" % posture)
                    if isinstance(posture, str) and posture not in ("", "full") else ""))
    # "running" must MEAN running (item 1, 2026-06-11): the engine touches .hb at EVERY phase
    # boundary, so >10 min of silence on a running feat is loud — feat-bound, no transcript
    # involved (the transcript "last activity" below stays as the fine-grained layer). Resume
    # safety is real: the gate is idempotent — done tasks skip, proven work auto-lands.
    if status == "running" and hb_age is not None and hb_age > LIVENESS_STALE_S:
        lines.append('  ⚠ no heartbeat for %dm on a "running" feat — the run may have died; '
                     "safe to resume with the same args" % int(hb_age // 60))
    lines.append("")

    tasks = [t for t in s.get("tasks", []) if isinstance(t, dict)]
    # done_with_findings COUNTS as complete — the work is merged and deterministically green
    # (VELOCITY §1) — but never silently: the tally itself says how many carry deferred review
    # debt, so a 3/3 with debt can never be skim-read as a clean 3/3.
    done = sum(1 for t in tasks if t.get("status") in ("done", "noop", "done_with_findings"))
    deferred = sum(1 for t in tasks if t.get("status") == "done_with_findings")
    lines.append("Tasks (%d/%d done%s)"
                 % (done, len(tasks),
                    (" · %d with DEFERRED review findings" % deferred) if deferred else ""))
    for i, t in enumerate(tasks, 1):
        st = t.get("status", "?")
        tele = [x for x in (
            ("%s round%s" % (t["rounds"], "" if t.get("rounds") == 1 else "s")) if t.get("rounds") is not None else None,
            fmt_tokens(t.get("tokens")),
            ("model %s" % t["model"]) if t.get("model") else None,
        ) if x]
        row = ("  %s %d. %-44s %-12s%s"
               % (GLYPH.get(st, "·"), i, t.get("taskId", "?"), st,
                  (" " + " · ".join(tele)) if tele else ""))
        # Oneshot honest-report semantics (VELOCITY §1): the task merged green, but its single
        # review's findings got ONE unreviewed fix pass — when the engine recorded the count,
        # the debt is named on the task's own line. Bool/zero are never a count (house rule).
        fd = t.get("findingsDeferred")
        if st == "done_with_findings" and isinstance(fd, int) and not isinstance(fd, bool) and fd > 0:
            row += " · %d finding(s) deferred to you" % fd
        lines.append(row)
    # Cross-run rollup (HARNESS-DIRECTION item 4, display half, 2026-06-11): per-task `tokens`
    # PERSIST in state across resumes, so their sum is the one feat-level number that survives a
    # restart — unlike the live per-run estimate further down, which only sees the current run's
    # transcripts. Honest-cost house rule: an estimate-adjacent persisted counter, never an
    # invoice (bools are excluded on purpose — a stray `true` is not a token count).
    feat_tokens = sum(t["tokens"] for t in tasks
                      if isinstance(t.get("tokens"), (int, float)) and not isinstance(t.get("tokens"), bool))
    if feat_tokens > 0:
        lines.append("  persisted feat total: ~%dk output tokens across runs (per-task, survives resume)"
                     % round(feat_tokens / 1000.0))
    lines.append("")

    # Live agents (best-effort, from the workflow transcripts): what each agent is actually doing
    # right now — model, output tokens, tool count, last tool. The deep "per loop, even the prompt"
    # detail the built-in /workflows view shows, surfaced here so it works from any terminal.
    live = synth.get("live") or []
    if live:
        # Liveness, BEST-EFFORT: newest transcript write across the agents of the REPO'S latest
        # workflow run — transcripts append per message, so they're finer-grained than any
        # boundary-written file. NOT feat-bound: with concurrent camus runs in one repo, or when
        # inspecting an older feat, this may describe a different run (the .hb heartbeat in the
        # header above is the first-class, feat-bound signal since 0.2.5). Stale + a "running"
        # feat → still say the quiet part loudly.
        acts = [t for t in (_parse_ts(a.get("lastTs")) for a in live) if t]
        act_age = max(0.0, now - max(acts)) if acts else None
        lines.append("Live agents (repo's latest run, best-effort · model · tokens · tools)%s"
                     % ("   · last activity %s ago" % fmt_age(act_age) if act_age is not None else ""))
        for a in live[-LIVE_SHOWN:]:
            tail = ("→ %s" % a["lastTool"]) if a.get("lastTool") else ""
            lines.append("  %-13s %-7s %6s tok · %d tools %s"
                         % (a.get("label", "agent"), a.get("model") or "?",
                            "{:,}".format(a.get("outputTokens", 0)), a.get("toolCount", 0), tail))
        # Honest VALUE line, never an invoice (audit 2026-06-11): Claude side priced at the public
        # rate card; the codex review settles in OpenAI ChatGPT-plan credits — we don't invent a $.
        cost = synth.get("cost")
        if cost and cost.get("usd"):
            per = " · ".join("%s $%.2f" % (k, v) for k, v in sorted(cost.get("byModel", {}).items()))
            lines.append("  ≈ $%.2f Claude-side API value, repo's latest run (%s · rates %s — estimate, not an invoice;"
                         % (cost["usd"], per, cost.get("ratesAsOf", "?")))
            lines.append("    codex review settles in your ChatGPT plan credits)")
        feat_age = hb_age if hb_age is not None else synth.get("stateAge")
        if act_age is not None and act_age > LIVENESS_STALE_S and status == "running" \
                and (feat_age is None or feat_age > LIVENESS_STALE_S):
            lines.append("  ⚠ state says RUNNING but the repo's latest workflow transcript has been quiet for %s — the run may have died."
                         % fmt_age(act_age))
            lines.append("    (best-effort repo-level signal, not feat-bound; `camus resume` lists restartable runs)")
        lines.append("")

    events = [e for e in s.get("events", []) if isinstance(e, dict) and e.get("msg")]
    if events:
        lines.append("Last steps (run log, oldest first)")
        for e in events[-EVENTS_SHOWN:]:
            lines.append("  %4s. %s" % (e.get("seq", "?"), e["msg"]))
        lines.append("")

    if synth["reviews"]:
        lines.append("Recent Codex review rounds (audit files)")
        for r in synth["reviews"]:
            lines.append("  %s ago  %s  round %s" % (fmt_age(r["age"]), r["taskId"], r["round"]))
        lines.append("")

    if status == "needs_human":
        # FEAT-level pauses (live smoke 2026-06-12): posture/budget/steer pauses halt no task, so
        # the engine now persists `state.question` + `state.stage` on every needs_human finalize —
        # and each stage has its OWN resume shape (the per-task answers:{...} hint was actively
        # wrong for them). Stage "task" or absent (older states, real task pauses) stays
        # byte-identical: question scanned off the task nodes, answers:{...} resume hint.
        q = s.get("question") or next((t.get("question") for t in tasks if t.get("question")), "")
        if q:
            lines.append("PAUSED — the run needs your decision:")
            lines.append("  %s" % q)
        stage = s.get("stage")
        if stage == "posture":
            lines.append('  resume: re-run the feat with  posture:"oneshot"  (or "full") '
                         "— explicit posture is used verbatim, never re-asked")
        elif stage == "budget":
            lines.append("  resume: re-run with a HIGHER budgetTokens (or drop it) — done tasks skip")
        elif stage == "steer":
            lines.append("  resume: re-issue your guidance (camus steer ...), then re-run with the SAME args")
        elif stage == "kernel_stop" and _direct_output_stop_kind(s, q) is not None:
            lines.append("  resume: camus run %s --token-budget <higher> (plus the same --experiment, if used)" % (
                s.get("featId") or "<featId>",
            ))
        elif stage == "kernel_stop":
            lines.append("  resume: none automatic — inspect the terminal stop reason before deciding next work")
        elif stage == "native_controller":
            halted_node = next(
                (t for t in tasks if t.get("status") == "needs_human"), {}
            )
            handoff = halted_node.get("nativeControllerHandoff") \
                if isinstance(halted_node.get("nativeControllerHandoff"), dict) else {}
            allowed = handoff.get("allowedActions") \
                if isinstance(handoff.get("allowedActions"), list) else []
            action_hint = "|".join(action for action in allowed if isinstance(action, str)) \
                or "fix_recheck|fix_verify|retry_verify"
            lines.append(
                "  resume: camus run %s --human-action <%s> "
                "(plus a higher --round-cap for a final-round fix_recheck)" % (
                    s.get("featId") or "<featId>", action_hint,
                )
            )
        else:
            halted = next((t.get("taskId") for t in tasks if t.get("status") == "needs_human"), "<taskId>")
            lines.append('  resume: re-run the feat with  answers:{"%s":"<your answer>"}' % halted)
        lines.append("")

    if status == "integration_pending":
        # Reconcile completed the last open task by hand (audit P2 follow-up 2026-06-11): every
        # task is done/noop but the merged branch has NOT passed integration verify — and nothing
        # is running, so no heartbeat warning applies and steer would have nothing to consume.
        lines.append("INTEGRATION PENDING — all tasks done/noop (last one reconciled by hand);")
        lines.append("  integration verify has NOT run. Re-run the feat with the SAME args —")
        lines.append("  done tasks skip; env re-check + integration verify then earn 'done'.")
        lines.append("")

    if status == "done_with_findings":
        # VELOCITY §1 (final-review outcomes + oneshot honest-report semantics): merged work,
        # deterministic verify GREEN — never a failure — but the posture's contract deferred
        # the review findings to the human instead of looping on them, so it must never read
        # as a plain done either. The report carries the findings verbatim; point straight at
        # it (derived from statePath so a --dir override still names the real file).
        state_path = synth.get("statePath") or ""
        report = (os.path.join(os.path.dirname(os.path.dirname(state_path)), "reports",
                               "%s.json" % s.get("featId", "?")) if state_path
                  else os.path.join("~", ".camus", "reports", "%s.json" % s.get("featId", "?")))
        lines.append("REVIEW DEBT DEFERRED — merged + deterministically green, but the review findings were")
        lines.append("  NOT re-reviewed (posture contract). Read them in the report before shipping:")
        lines.append("  %s" % report)
        lines.append("")

    if synth["steer"]:
        lines.append("Steer note PENDING (applies at the next task boundary IF the feat runs with steering enabled):")
        lines.append("  %s" % json.dumps(synth["steer"]))
    elif not synth.get("steerClaim"):
        # Steering is EXPERIMENTAL / opt-in (descoped from 0.2.7) — don't promote it as a default lever.
        lines.append("Steer: none pending — `camus steer` is experimental/opt-in (the feat must be run")
        lines.append("       with steering enabled for notes to be consumed).")
    if synth.get("steerClaim"):
        # A crashed consume left a claim — surface it rather than reporting "none pending" over it.
        lines.append("⚠ Stranded steer claim present (a prior consume crashed) — a feat re-run will")
        lines.append("  recover and apply it, or `camus steer --clear` to remove it.")
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description="Camus feat status dashboard (read-only)")
    ap.add_argument("featId", nargs="?", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dir", default=default_base(), help="camus home (default ~/.camus)")
    args = ap.parse_args(argv)

    synth = synthesize(args.dir, args.featId)
    if synth is None:
        print("no feat state found under %s (has a run started?)" % os.path.join(args.dir, "feats"),
              file=sys.stderr)
        return 1
    if "state" not in synth:
        # The state EXISTS but won't parse — likely a mid-write race (persistState is not
        # atomic) or a damaged file. Saying "no run" here could prompt a disastrous re-launch.
        print("feat state file exists but is not valid JSON (mid-write race, or corrupt):",
              file=sys.stderr)
        for p in synth["corrupt"]:
            print("  %s" % p, file=sys.stderr)
        print("retry in a moment; if it persists, the file is damaged.", file=sys.stderr)
        return 2
    if synth.get("skippedCorrupt"):
        for p in synth["skippedCorrupt"]:
            print("warning: skipped unparseable state file (mid-write race?): %s" % p,
                  file=sys.stderr)
    if args.json:
        print(json.dumps(synth, indent=2))
    else:
        print("\n".join(render(synth)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
