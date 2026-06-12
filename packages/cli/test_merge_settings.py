"""Contract tests for merge_settings.py (Camus auto-profile merger).

    python3 test_merge_settings.py      # stdlib runner (bottom)
    python3 -m pytest -q                # also works

Covers: fresh creation carries $defaults + both env lines; narrow gate-script allow rules added;
NO defaultMode written; broad shell/PM rules never emitted; existing keys preserved; existing env
appended without disturbing the user's $defaults choice; idempotency; malformed-input refusal;
the review.sh dispatcher rule + the legacy five-script profile upgrade path; and the CLI
--apply/--check round-trip against a temp settings file.
"""
import copy
import json
import os
import subprocess
import sys
import tempfile

import merge_settings as M


# --- pure merge logic ------------------------------------------------------

def test_fresh_creates_env_with_defaults_then_both_lines():
    out = M.apply({})
    assert out["autoMode"]["environment"] == [M.DEFAULTS, M.TRUST_LINE, M.CONTEXT_LINE]


def test_fresh_adds_gate_script_allow_rules():
    out = M.apply({})
    allow = out["permissions"]["allow"]
    for rule in M.allow_rules():
        assert rule in allow


def test_does_not_set_default_mode():
    # auto mode is entered per-run; the installer must never flip a global mode
    out = M.apply({})
    assert "defaultMode" not in out.get("permissions", {})
    assert "defaultMode" not in out


def test_allow_rules_are_narrow_gate_scripts_only():
    rules = M.allow_rules()
    assert rules, "expected allow rules"
    for r in rules:
        assert ".claude/skills/camus/scripts" in r
        assert any(name in r for _, name in M._GATE_SCRIPTS)
    joined = " ".join(rules)
    for broad in ("git:*", "pnpm:*", "npm:*", "Bash(git ", "Bash(pnpm ", "Write(", "Edit("):
        assert broad not in joined


def test_allow_rules_match_workflow_command_shape():
    # the workflows emit:  <runner> "$HOME/.claude/skills/camus/scripts"/<script> <args>
    # so a literal-$HOME, dir-quoted rule MUST be present for each gate script (P2 fix).
    rules = M.allow_rules()
    for runner, name in M._GATE_SCRIPTS:
        literal = 'Bash(%s "$HOME/.claude/skills/camus/scripts"/%s *)' % (runner, name)
        assert literal in rules, "missing literal-$HOME rule for " + name


def test_review_dispatcher_rule_present():
    # The loop's REVIEW_CMD is the backend dispatcher review.sh — every review form
    # (start / watchdog await / abort) shares this command prefix. If it falls out of
    # _GATE_SCRIPTS, every review round re-prompts under auto mode and unattended runs break.
    assert ("bash", "review.sh") in M._GATE_SCRIPTS
    assert 'Bash(bash "$HOME/.claude/skills/camus/scripts"/review.sh *)' in M.allow_rules()


def test_legacy_five_script_profile_reads_partial_and_upgrades():
    # An install made before review.sh joined the allowlist has rules for the original five
    # scripts only. has_profile() must read it as INCOMPLETE — that is what makes
    # `install.sh --check` report the profile as MISSING/partial so an upgrader re-runs
    # auto-setup — and --apply must append exactly the missing review.sh pair, no dupes.
    # NB: the filter needs the '/' — 'review.sh' is a substring of 'codex_review.sh'.
    legacy_allow = [r for r in M.allow_rules() if '/review.sh' not in r]
    assert len(legacy_allow) == len(M.allow_rules()) - 2
    settings = {"autoMode": {"environment": [M.DEFAULTS] + list(M.ENV_LINES)},
                "permissions": {"allow": list(legacy_allow)}}
    assert M.has_profile(settings) is False
    out = M.apply(copy.deepcopy(settings))
    assert M.has_profile(out) is True
    for rule in M.allow_rules():
        assert out["permissions"]["allow"].count(rule) == 1


def test_gitops_mutation_script_rules_present():
    # Gate-owned git MUTATIONS live in allowlisted scripts (live smoke run-5, 2026-06-12): the
    # auto-mode classifier denies agent-typed `git -c core.hooksPath=/dev/null ...` as a
    # guardrail bypass. wt.sh (worktree create/attach) and merge.sh (the feat merge runner)
    # carry those flags in-script — if either falls out of _GATE_SCRIPTS, implement/land/merge
    # re-prompt (or hard-deny) under auto mode and unattended runs break.
    for name in ("wt.sh", "merge.sh"):
        assert ("bash", name) in M._GATE_SCRIPTS
        assert 'Bash(bash "$HOME/.claude/skills/camus/scripts"/%s *)' % name in M.allow_rules()


def test_pre_gitops_profile_reads_partial_and_upgrades():
    # An install made before wt.sh/merge.sh joined the allowlist (0.2.5) has no rules for them.
    # has_profile() must read it as INCOMPLETE — so `install.sh --check` reports MISSING/partial
    # and an upgrader re-runs auto-setup — and --apply must append exactly the four missing
    # rules (literal + expanded form for each script), no dupes. Same upgrade path review.sh
    # took earlier today.
    legacy_allow = [r for r in M.allow_rules()
                    if "/wt.sh" not in r and "/merge.sh" not in r]
    assert len(legacy_allow) == len(M.allow_rules()) - 4
    settings = {"autoMode": {"environment": [M.DEFAULTS] + list(M.ENV_LINES)},
                "permissions": {"allow": list(legacy_allow)}}
    assert M.has_profile(settings) is False
    out = M.apply(copy.deepcopy(settings))
    assert M.has_profile(out) is True
    for rule in M.allow_rules():
        assert out["permissions"]["allow"].count(rule) == 1


def test_preserves_all_other_settings():
    src = {"permissions": {"allow": ["Bash(npm test)"]}, "mcpServers": {"x": 1}}
    out = M.apply(copy.deepcopy(src))
    assert "Bash(npm test)" in out["permissions"]["allow"]   # original kept
    assert out["mcpServers"] == {"x": 1}                      # untouched
    assert M.has_profile(out)


def test_existing_env_appends_and_keeps_user_defaults_choice():
    src = {"autoMode": {"environment": [M.DEFAULTS, "Trusted: github.com/acme"]}}
    out = M.apply(copy.deepcopy(src))
    env = out["autoMode"]["environment"]
    assert env[0] == M.DEFAULTS
    assert "Trusted: github.com/acme" in env
    assert M.TRUST_LINE in env and M.CONTEXT_LINE in env


def test_existing_env_without_defaults_is_left_without_defaults():
    # user deliberately took full ownership (no $defaults) — don't re-add it, just append
    src = {"autoMode": {"environment": ["Only my custom rule"]}}
    out = M.apply(copy.deepcopy(src))
    env = out["autoMode"]["environment"]
    assert M.DEFAULTS not in env
    assert env == ["Only my custom rule", M.TRUST_LINE, M.CONTEXT_LINE]


def test_idempotent():
    once = M.apply({})
    twice = M.apply(copy.deepcopy(once))
    assert twice["autoMode"]["environment"].count(M.TRUST_LINE) == 1
    assert twice["autoMode"]["environment"].count(M.CONTEXT_LINE) == 1
    for rule in M.allow_rules():
        assert twice["permissions"]["allow"].count(rule) == 1


def test_malformed_env_raises():
    try:
        M.apply({"autoMode": {"environment": "not-a-list"}})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_malformed_allow_raises():
    try:
        M.apply({"permissions": {"allow": "not-a-list"}})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_has_profile():
    assert M.has_profile(M.apply({})) is True
    # partial (only the trust line, no context, no allows) is NOT a complete profile
    assert M.has_profile({"autoMode": {"environment": [M.DEFAULTS, M.TRUST_LINE]}}) is False
    assert M.has_profile({}) is False


def test_superseded_line_migrated_in_place():
    # A pre-2026-06-10 install carries the OLD context line — --apply must replace it, not stack.
    old = M.SUPERSEDED_ENV_LINES[0]
    settings = {"autoMode": {"environment": [M.DEFAULTS, M.TRUST_LINE, old, "user custom line"]},
                "permissions": {"allow": list(M.allow_rules())}}
    assert M.has_profile(settings) is False           # old profile reads as missing → upgrade path
    out = M.apply(settings)
    env = out["autoMode"]["environment"]
    assert old not in env                              # superseded line removed
    assert env.count(M.CONTEXT_LINE) == 1              # new line present exactly once
    assert "user custom line" in env                   # user's own lines untouched
    assert M.has_profile(M.apply(copy.deepcopy(out))) is True   # idempotent after upgrade


def test_superseded_list_never_contains_current_lines():
    # Guard against a future edit accidentally self-deleting the live profile.
    for line in M.ENV_LINES:
        assert line not in M.SUPERSEDED_ENV_LINES


# --- CLI round-trip --------------------------------------------------------

def _tmp(contents=None):
    d = tempfile.mkdtemp(prefix="camus_settings_")
    p = os.path.join(d, "settings.json")
    if contents is not None:
        with open(p, "w") as fh:
            fh.write(contents)
    return p


def _run(args):
    return subprocess.run([sys.executable, M.__file__] + args,
                          capture_output=True, text=True)


def test_cli_apply_then_check_roundtrip():
    p = _tmp(json.dumps({"mcpServers": {"x": 1}}))
    r1 = _run(["--apply", "--settings", p])
    assert r1.returncode == 0
    data = json.load(open(p))
    assert data["mcpServers"] == {"x": 1}          # preserved
    assert M.has_profile(data)                      # full profile added
    # backup was made
    bak = [f for f in os.listdir(os.path.dirname(p)) if ".camus-bak." in f]
    assert bak, "expected a backup file"
    # check passes now
    assert _run(["--check", "--settings", p]).returncode == 0
    # second apply is a no-op
    r2 = _run(["--apply", "--settings", p])
    assert "no change" in r2.stdout


def test_cli_check_missing_is_exit_1():
    p = _tmp(json.dumps({}))
    assert _run(["--check", "--settings", p]).returncode == 1


def test_cli_refuses_invalid_json():
    p = _tmp("{not valid json")
    r = _run(["--apply", "--settings", p])
    assert r.returncode == 2 and "refusing" in (r.stderr + r.stdout).lower()
    # file left untouched
    assert open(p).read() == "{not valid json"


# --- stdlib runner ---------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
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
