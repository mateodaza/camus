#!/usr/bin/env python3
"""Best-effort ENRICHMENT layer for `camus watch`: locate a LIVE Camus workflow run from Claude
Code's on-disk agent transcripts and summarize its agents (model, tokens, current tool, prompt).

Camus's own state (~/.camus/feats, reviews) is the STABLE backbone of the watch; this reads the
workflow runtime's per-agent transcripts at
  ~/.claude/projects/<project-slug>/<session>/subagents/workflows/wf_<id>/agent-*.jsonl
That format is INTERNAL and version-coupled (Claude Code may change it), so EVERY function here
degrades to None/[] rather than raising — the watch must keep working from the backbone alone when
the format shifts. Pure stdlib; no third-party deps.
"""
import json
import os

CLAUDE_PROJECTS = os.path.join(os.path.expanduser("~"), ".claude", "projects")

# Claude API rate card, $ per MILLION tokens (input, output) — claude-api skill, cached 2026-05-26.
# Used ONLY for an honest "what would this cost at API rates" estimate of the CLAUDE side of a run.
# It is a VALUE ESTIMATE, not an invoice: subscription (Max/Pro) usage doesn't bill per token, and
# the codex review settles in OpenAI ChatGPT-plan credits — we never fabricate dollars for those.
RATES_AS_OF = "2026-05-26"
RATES = {  # short model name → (input $/MTok, output $/MTok)
    "Haiku": (1.00, 5.00),
    "Sonnet": (3.00, 15.00),
    "Opus": (5.00, 25.00),
    "Fable": (10.00, 50.00),
}
CACHE_READ_X = 0.1        # cache reads ≈ 0.1× input rate
CACHE_WRITE_5M_X = 1.25   # 5-minute-TTL cache writes ≈ 1.25× input rate
CACHE_WRITE_1H_X = 2.0    # 1-hour-TTL cache writes ≈ 2× input rate

# Map an agent's opening prompt → its camus phase label (the transcripts don't carry our label, but
# the prompt's first sentence is a reliable tell). First match wins; order matters.
_LABELS = [
    ("THIN reviewer", "review"),
    ("Implement ONE", "implement"),
    ("planning ONE", "plan"),
    ("Classify the complexity", "classify"),
    ("Fix the BLOCKING", "fix"),
    ("THIN commit runner", "commit"),
    ("THIN prep runner", "prep"),
    ("Camus verification", "verify"),
    ("THIN verifier", "verify"),
    ("THIN preflight", "preflight"),
    ("THIN env doctor", "env"),
    ("Persist Camus", "state"),
    ("feat REPORT", "report"),
    ("git merge runner", "merge"),
    ("working tree ON the feat branch", "feat-branch"),
    ("steer-check runner", "steer"),
    ("worktree", "cleanup"),
]


def project_slug(repo_path):
    """Claude Code's project-dir name for a repo path: the absolute path with every '/' → '-'."""
    return os.path.realpath(repo_path).replace(os.sep, "-")


def _run_activity(run_dir):
    """Most recent ACTIVITY in a run dir = max(dir mtime, newest agent-*.jsonl mtime). Appending to
    a transcript bumps the FILE mtime, NOT the dir's (audit 2026-06-11), so ranking by dir mtime
    alone can pick a newer-but-idle run over the actually-active one. -1.0 if unreadable."""
    best = -1.0
    try:
        best = os.path.getmtime(run_dir)
    except OSError:
        pass
    try:
        for n in os.listdir(run_dir):
            if n.startswith("agent-") and n.endswith(".jsonl"):
                try:
                    best = max(best, os.path.getmtime(os.path.join(run_dir, n)))
                except OSError:
                    pass
    except OSError:
        pass
    return best


def find_run_dir(repo_path, projects_dir=CLAUDE_PROJECTS):
    """The most-recently-ACTIVE `wf_*` workflow-run dir for repo_path, or None if none found.
    Activity = newest agent transcript write, not directory mtime (see _run_activity)."""
    base = os.path.join(projects_dir, project_slug(repo_path))
    best, best_activity = None, -1.0
    try:
        sessions = os.listdir(base)
    except OSError:
        return None
    for session in sessions:
        wfbase = os.path.join(base, session, "subagents", "workflows")
        try:
            wfs = os.listdir(wfbase)
        except OSError:
            continue
        for wf in wfs:
            if not wf.startswith("wf_"):
                continue
            d = os.path.join(wfbase, wf)
            act = _run_activity(d)
            if act > best_activity:
                best, best_activity = d, act
    return best


def _msg_text(message):
    """Pull text out of a message.content that may be a plain string or a list of blocks."""
    c = message.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                return b["text"]
        if c and isinstance(c[0], dict):
            return c[0].get("text", "") or ""
    return ""


def infer_label(prompt):
    for needle, label in _LABELS:
        if needle in (prompt or ""):
            return label
    return "agent"


def _int(x):
    """Coerce a transcript usage value to int, 0 on anything unexpected — the format is internal
    and version-coupled, so a shifted field type must degrade to an undercount, never a crash."""
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


def _short_model(m):
    if not m:
        return None
    for key, name in (("haiku", "Haiku"), ("sonnet", "Sonnet"), ("opus", "Opus"), ("fable", "Fable")):
        if key in m:
            return name
    return m


def parse_agent(path):
    """Summarize one agent-*.jsonl into a dict, or None if it can't be read at all."""
    model = None
    out_tokens = 0
    in_tokens = 0
    cache_read = 0
    cache_w5m = 0
    cache_w1h = 0
    tool_count = 0
    last_tool = None
    prompt = ""
    last_ts = None
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return None
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except (ValueError, TypeError):
                continue
            if o.get("timestamp"):
                last_ts = o["timestamp"]
            t = o.get("type")
            m = o.get("message") or {}
            if t == "user" and not prompt:
                prompt = _msg_text(m)
            elif t == "assistant":
                if m.get("model"):
                    model = m["model"]
                u = m.get("usage") if isinstance(m.get("usage"), dict) else {}
                out_tokens += _int(u.get("output_tokens"))
                in_tokens += _int(u.get("input_tokens"))
                cache_read += _int(u.get("cache_read_input_tokens"))
                cw = u.get("cache_creation")
                if isinstance(cw, dict):  # 5m/1h split (priced differently) when the runtime gives it
                    cache_w5m += _int(cw.get("ephemeral_5m_input_tokens"))
                    cache_w1h += _int(cw.get("ephemeral_1h_input_tokens"))
                else:
                    cache_w5m += _int(u.get("cache_creation_input_tokens"))
                for b in (m.get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        tool_count += 1
                        last_tool = b.get("name") or last_tool
    return {
        "agentId": os.path.basename(path)[len("agent-"):-len(".jsonl")] if os.path.basename(path).startswith("agent-") else os.path.basename(path),
        "label": infer_label(prompt),
        "model": _short_model(model),
        "outputTokens": out_tokens,
        "inputTokens": in_tokens,
        "cacheReadTokens": cache_read,
        "cacheWrite5mTokens": cache_w5m,
        "cacheWrite1hTokens": cache_w1h,
        "toolCount": tool_count,
        "lastTool": last_tool,
        "prompt": prompt,
        "lastTs": last_ts,
    }


def estimate_cost_usd(agents):
    """Honest Claude-side VALUE estimate for a run's agents at published API rates: input + output
    + cache reads (0.1×) + cache writes (1.25× 5m / 2× 1h). Returns {"usd", "byModel", "ratesAsOf"}
    or None when nothing is priceable (no recognized models / zero tokens). Never raises — and never
    prices the codex review (OpenAI plan credits are NOT dollarizable from here)."""
    try:
        by_model = {}
        for a in agents or []:
            rates = RATES.get((a or {}).get("model"))
            if not rates:
                continue
            in_rate, out_rate = rates
            usd = (
                (a.get("inputTokens", 0) or 0) * in_rate
                + (a.get("outputTokens", 0) or 0) * out_rate
                + (a.get("cacheReadTokens", 0) or 0) * in_rate * CACHE_READ_X
                + (a.get("cacheWrite5mTokens", 0) or 0) * in_rate * CACHE_WRITE_5M_X
                + (a.get("cacheWrite1hTokens", 0) or 0) * in_rate * CACHE_WRITE_1H_X
            ) / 1e6
            if usd > 0:
                by_model[a["model"]] = by_model.get(a["model"], 0.0) + usd
        if not by_model:
            return None
        return {"usd": round(sum(by_model.values()), 2),
                "byModel": {k: round(v, 2) for k, v in by_model.items()},
                "ratesAsOf": RATES_AS_OF}
    except Exception:  # noqa: BLE001 — enrichment must never crash the watch
        return None


def summarize_run(run_dir):
    """Every agent in a run dir, oldest-activity first (newest last). [] if none/unreadable."""
    out = []
    try:
        names = [n for n in os.listdir(run_dir) if n.startswith("agent-") and n.endswith(".jsonl")]
    except OSError:
        return out
    for n in names:
        a = parse_agent(os.path.join(run_dir, n))
        if a:
            out.append(a)
    out.sort(key=lambda a: a.get("lastTs") or "")
    return out


def live_agents(repo_path):
    """One-call convenience for the watch: summarize the most recent run for repo_path. Never raises."""
    try:
        d = find_run_dir(repo_path)
        return summarize_run(d) if d else []
    except Exception:  # noqa: BLE001 — enrichment must never crash the watch
        return []
