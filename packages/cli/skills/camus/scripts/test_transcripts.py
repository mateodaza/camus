#!/usr/bin/env python3
"""Tests for transcripts.py (the watch's best-effort enrichment layer). Pure stdlib — runs
standalone (`python3 test_transcripts.py`) or under pytest. Builds synthetic agent-*.jsonl files
in the exact Claude Code layout and asserts the parse/locate/summarize behavior + graceful degrade."""
import json
import os
import tempfile

import transcripts as T


def _write_jsonl(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for o in lines:
            fh.write(json.dumps(o) + "\n")


def _agent_lines(prompt, model, out_each, tools, ts0="2026-06-11T00:00:0"):
    """A minimal but realistic agent transcript: one user prompt + N assistant turns."""
    lines = [{"type": "user", "timestamp": ts0 + "0Z", "message": {"role": "user", "content": prompt}}]
    for i, (out, tool) in enumerate(zip(out_each, tools), 1):
        content = [{"type": "tool_use", "name": tool, "input": {"command": "x"}}] if tool else [{"type": "text", "text": "ok"}]
        lines.append({"type": "assistant", "timestamp": "%s%dZ" % (ts0, i),
                      "message": {"model": model, "usage": {"output_tokens": out}, "content": content}})
    return lines


def test_project_slug():
    assert T.project_slug("/Users/x/Documents/myosin/social-media-scraper") == \
        "-Users-x-Documents-myosin-social-media-scraper"


def test_infer_label_from_prompt():
    assert T.infer_label("You are a THIN reviewer. Your ONLY job…") == "review"
    assert T.infer_label("Implement ONE Camus task in an ISOLATED git worktree") == "implement"
    assert T.infer_label("You are planning ONE Camus task.") == "plan"
    assert T.infer_label("Classify the complexity of this ONE coding task") == "classify"
    assert T.infer_label("Fix the BLOCKING review findings below") == "fix"
    assert T.infer_label("something unrecognized") == "agent"


def test_short_model():
    assert T._short_model("claude-haiku-4-5-20251001") == "Haiku"
    assert T._short_model("claude-opus-4-8") == "Opus"
    assert T._short_model("claude-sonnet-4-6") == "Sonnet"
    assert T._short_model(None) is None


def test_parse_agent_aggregates_tokens_and_tools():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "agent-abc123.jsonl")
        _write_jsonl(p, _agent_lines("You are a THIN reviewer.", "claude-haiku-4-5",
                                     out_each=[100, 50, 25], tools=["Bash", "Bash", None]))
        a = T.parse_agent(p)
        assert a["agentId"] == "abc123"
        assert a["label"] == "review"
        assert a["model"] == "Haiku"
        assert a["outputTokens"] == 175          # 100+50+25
        assert a["toolCount"] == 2               # two tool_use blocks
        assert a["lastTool"] == "Bash"
        assert a["prompt"].startswith("You are a THIN reviewer")
        assert a["lastTs"].endswith("Z")


def test_parse_agent_handles_content_as_block_list_prompt():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "agent-xyz.jsonl")
        _write_jsonl(p, [
            {"type": "user", "timestamp": "2026-06-11T00:00:00Z",
             "message": {"role": "user", "content": [{"type": "text", "text": "Implement ONE Camus task"}]}},
            {"type": "assistant", "timestamp": "2026-06-11T00:00:01Z",
             "message": {"model": "claude-opus-4-8", "usage": {"output_tokens": 9}, "content": [{"type": "text", "text": "done"}]}},
        ])
        a = T.parse_agent(p)
        assert a["label"] == "implement" and a["model"] == "Opus" and a["outputTokens"] == 9


def test_parse_agent_skips_malformed_lines():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "agent-m.jsonl")
        with open(p, "w") as fh:
            fh.write('{"type":"user","message":{"content":"Classify the complexity"}}\n')
            fh.write("not json at all\n")
            fh.write('{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"output_tokens":4},"content":[]}}\n')
        a = T.parse_agent(p)
        assert a is not None and a["label"] == "classify" and a["outputTokens"] == 4


def test_find_run_dir_picks_most_recent_wf():
    with tempfile.TemporaryDirectory() as projects:
        repo = "/tmp/myrepo"
        slug = T.project_slug(repo)
        old = os.path.join(projects, slug, "sess1", "subagents", "workflows", "wf_old")
        new = os.path.join(projects, slug, "sess2", "subagents", "workflows", "wf_new")
        os.makedirs(old)
        os.makedirs(new)
        os.utime(new, (9e9, 9e9))   # force wf_new to be newest
        got = T.find_run_dir(repo, projects_dir=projects)
        assert got == new


def test_find_run_dir_none_when_no_project():
    with tempfile.TemporaryDirectory() as projects:
        assert T.find_run_dir("/tmp/nope", projects_dir=projects) is None


def test_find_run_dir_ranks_by_agent_activity_not_dir_mtime():
    # Audit 2026-06-11: appending to agent-*.jsonl bumps the FILE mtime, not the dir's. A run with a
    # FRESH transcript in an OLDER dir must win over a newer-dir-but-idle run.
    with tempfile.TemporaryDirectory() as projects:
        repo = "/tmp/myrepo"
        slug = T.project_slug(repo)
        active = os.path.join(projects, slug, "s1", "subagents", "workflows", "wf_active")
        idle = os.path.join(projects, slug, "s2", "subagents", "workflows", "wf_idle")
        os.makedirs(active)
        os.makedirs(idle)
        os.utime(idle, (8e9, 8e9))                                  # wf_idle DIR is newer…
        jf = os.path.join(active, "agent-x.jsonl")
        open(jf, "w").close()
        os.utime(jf, (9e9, 9e9))                                    # …but wf_active has a NEWER transcript
        assert T.find_run_dir(repo, projects_dir=projects) == active


def test_summarize_run_sorted_by_activity():
    with tempfile.TemporaryDirectory() as run:
        _write_jsonl(os.path.join(run, "agent-a.jsonl"),
                     [{"type": "user", "timestamp": "2026-06-11T00:00:01Z", "message": {"content": "Classify the complexity"}}])
        _write_jsonl(os.path.join(run, "agent-b.jsonl"),
                     [{"type": "user", "timestamp": "2026-06-11T00:00:09Z", "message": {"content": "You are a THIN reviewer."}}])
        agents = T.summarize_run(run)
        assert [a["label"] for a in agents] == ["classify", "review"]   # oldest-activity first


def test_live_agents_degrades_to_empty():
    # The whole point: enrichment must never raise. A bogus repo → [].
    assert T.live_agents("/nonexistent/repo/path") == []


def test_parse_agent_collects_full_usage():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "agent-u.jsonl")
        _write_jsonl(p, [
            {"type": "user", "message": {"content": "Classify the complexity"}},
            {"type": "assistant", "message": {"model": "claude-haiku-4-5", "content": [],
             "usage": {"input_tokens": 3, "output_tokens": 10, "cache_read_input_tokens": 100,
                       "cache_creation_input_tokens": 999,  # ignored when the 5m/1h split is present
                       "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 50}}}},
            {"type": "assistant", "message": {"model": "claude-haiku-4-5", "content": [],
             "usage": {"input_tokens": 7, "output_tokens": 5, "cache_creation_input_tokens": 40}}},  # no split → 5m
        ])
        a = T.parse_agent(p)
        assert a["inputTokens"] == 10 and a["outputTokens"] == 15
        assert a["cacheReadTokens"] == 100 and a["cacheWrite5mTokens"] == 240 and a["cacheWrite1hTokens"] == 50


def test_estimate_cost_usd_rate_card_math():
    # Haiku $1 in / $5 out per MTok; cache read 0.1×, 5m write 1.25×, 1h write 2× the input rate.
    a = {"model": "Haiku", "inputTokens": 1_000_000, "outputTokens": 200_000,
         "cacheReadTokens": 1_000_000, "cacheWrite5mTokens": 400_000, "cacheWrite1hTokens": 100_000}
    est = T.estimate_cost_usd([a])
    assert abs(est["usd"] - 2.80) < 0.005, est   # 1 + 1 + 0.10 + 0.50 + 0.20
    assert est["byModel"] == {"Haiku": 2.80}
    assert est["ratesAsOf"] == T.RATES_AS_OF


def test_estimate_cost_usd_degrades():
    assert T.estimate_cost_usd([]) is None
    assert T.estimate_cost_usd(None) is None
    assert T.estimate_cost_usd([{"model": "gpt-5.5", "inputTokens": 9e9}]) is None   # unknown model → unpriced
    assert T.estimate_cost_usd([{"model": "Opus"}]) is None                          # zero tokens → None


def test_estimate_prices_only_claude_models_in_mixed_list():
    # Final-audit focus (2026-06-11): a codex/OpenAI entry must contribute $0 — only Claude models
    # are dollarizable from the rate card; plan credits are never converted.
    mixed = [{"model": "Haiku", "outputTokens": 1_000_000},
             {"model": "gpt-5.5", "outputTokens": 9_000_000, "inputTokens": 9_000_000}]
    est = T.estimate_cost_usd(mixed)
    assert est["usd"] == 5.00 and list(est["byModel"]) == ["Haiku"]


def test_parse_agent_degrades_on_shifted_usage_field_types():
    # Final-audit focus (2026-06-11): the transcript format is internal — if usage fields shift
    # type (strings, nulls, lists), counts degrade to 0 for the bad fields; never a crash.
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "agent-w.jsonl")
        _write_jsonl(p, [
            {"type": "user", "message": {"content": "Classify the complexity"}},
            {"type": "assistant", "message": {"model": "claude-haiku-4-5", "content": [],
             "usage": {"input_tokens": "not-a-number", "output_tokens": None,
                       "cache_read_input_tokens": [1, 2], "cache_creation": "weird"}}},
            {"type": "assistant", "message": {"model": "claude-haiku-4-5", "content": [], "usage": "gone"}},
            {"type": "assistant", "message": {"model": "claude-haiku-4-5", "content": [],
             "usage": {"output_tokens": 7}}},
        ])
        a = T.parse_agent(p)
        assert a["outputTokens"] == 7 and a["inputTokens"] == 0 and a["cacheReadTokens"] == 0
        # …and 7 tokens rounds to $0.00, which the dashboard suppresses (no fabricated cost line).
        assert (T.estimate_cost_usd([a]) or {}).get("usd", 0.0) == 0.0


# --- stdlib runner (no pytest required) ------------------------------------

if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok   " + fn.__name__)
        except AssertionError as exc:
            failed += 1
            print("FAIL " + fn.__name__ + ": " + str(exc))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("ERR  " + fn.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
