#!/usr/bin/env python3
"""Install the Camus AUTO PROFILE into ~/.claude/settings.json so a feat run can go
unattended under Claude Code's `auto` permission mode WITHOUT broad autonomy.

The profile is deliberately NARROW (per the 2026-06-09 cross-vendor review):
  1. autoMode.environment += a Codex review-egress trust line (the local `codex` CLI sends the
     working-tree diff to OpenAI — an intended, trusted cross-vendor review, not exfiltration).
  2. autoMode.environment += a local-only context line (Camus operates on local worktrees
     and `camus/feat...` branches, writes run state under ~/.camus, runs its own gate scripts;
     it does NOT push/deploy/migrate/publish — human merge & publish stay the boundary).
  3. permissions.allow += narrow rules for ONLY the installed gate scripts (codex_review.sh,
     verify.sh, prep.sh, commit.sh, env_check.py). NOT broad `Bash(git:*)` / `Bash(pnpm:*)` —
     auto mode already auto-approves local working-dir edits + declared dep installs, and broad
     shell/PM rules are either risky or dropped in auto mode (narrow rules carry over).

Explicitly does NOT set `permissions.defaultMode` — that is a global toggle and too broad for an
installer. The user enters auto mode PER RUN with `claude --permission-mode auto`.

Usage:
  merge_settings.py --apply [--settings PATH]   # add the profile (backs up first), idempotent
  merge_settings.py --check [--settings PATH]   # exit 0 if the full profile is present, 1 if not

Safety:
- Structured JSON merge — every existing setting is preserved; only autoMode.environment and
  permissions.allow are appended to (never overwritten or reordered).
- A freshly-created autoMode.environment array always includes "$defaults" (omitting it would
  discard the built-in classifier protections). An existing array's "$defaults" choice is left
  exactly as the user set it.
- Backs up the file before writing; refuses to touch invalid JSON.
"""
import argparse
import json
import os
import shutil
import sys
import time

DEFAULTS = "$defaults"

TRUST_LINE = (
    "Code review: the local `codex` CLI sends working-tree diffs to OpenAI for an intended, "
    "trusted cross-vendor review (the Camus review gate). OpenAI is a trusted destination "
    "for this diff-review purpose only."
)
CONTEXT_LINE = (
    "Camus is trusted ONLY when invoked by its own installed workflows (camus-loop / "
    "camus-feat), and ONLY for: the CURRENT working repo; git branches named `camus/...` and "
    "worktrees named `camus-wt-*`; running its own gate scripts under "
    "~/.claude/skills/camus/scripts (each enforces a same-repo target guard); and state/report "
    "writes under ~/.camus. It must NOT push, deploy, run database migrations, or publish, and "
    "must NOT operate on any other repository — human merge and publish remain the boundary."
)
ENV_LINES = [TRUST_LINE, CONTEXT_LINE]

# Only the deterministic gate scripts — never a broad command class.
_GATE_SCRIPTS = [
    ("bash", "codex_review.sh"),
    ("bash", "verify.sh"),
    ("bash", "prep.sh"),
    ("bash", "commit.sh"),
    ("python3", "env_check.py"),
]


# MUST mirror the workflows' SKILL_SCRIPTS const exactly. The loop/feat invoke a gate script as:
#     <runner> "$HOME/.claude/skills/camus/scripts"/<script> <args>
# i.e. LITERAL `$HOME`, with quotes around the DIR only and the script name OUTSIDE the quotes.
SCRIPTS_SUFFIX = ".claude/skills/camus/scripts"
LITERAL_DIR = '"$HOME/%s"' % SCRIPTS_SUFFIX


def scripts_dir(home=None):
    home = home if home is not None else os.path.expanduser("~")
    return os.path.join(home, ".claude", "skills", "camus", "scripts")


def _expanded_dir(home=None):
    home = home if home is not None else os.path.expanduser("~")
    return '"%s/%s"' % (home, SCRIPTS_SUFFIX)


def allow_rules(home=None):
    """Narrow permissions.allow rules for the gate scripts, matching the EXACT command shape the
    workflows emit: `<runner> "$HOME/.../scripts"/<script> <args>`. We don't know for certain whether
    Claude Code matches the command BEFORE or AFTER $HOME-expansion, so emit BOTH the literal-`$HOME`
    form (most likely — it matches the unexpanded string the agent passes to the Bash tool) and the
    expanded-home form. The FIRST AUTO DRY-RUN must confirm which actually matched; copy the exact
    command from any remaining prompt to refine. Extra non-matching entries are harmless (allow only
    widens; deny/ask still take precedence)."""
    rules = []
    for runner, name in _GATE_SCRIPTS:
        rules.append('Bash(%s %s/%s *)' % (runner, LITERAL_DIR, name))
        rules.append('Bash(%s %s/%s *)' % (runner, _expanded_dir(home), name))
    return rules


def default_settings_path():
    return os.path.join(os.path.expanduser("~"), ".claude", "settings.json")


def load(path):
    """Return (settings_dict, existed). Raises ValueError on invalid JSON."""
    if not os.path.exists(path):
        return {}, False
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if not text.strip():
        return {}, False
    data = json.loads(text)  # ValueError propagates -> caller refuses to touch
    if not isinstance(data, dict):
        raise ValueError("settings root is not a JSON object")
    return data, True


def has_profile(settings, home=None):
    env = (settings.get("autoMode") or {}).get("environment")
    if not (isinstance(env, list) and all(line in env for line in ENV_LINES)):
        return False
    allow = (settings.get("permissions") or {}).get("allow")
    if not isinstance(allow, list):
        return False
    return all(rule in allow for rule in allow_rules(home))


def apply(settings, home=None):
    """Add the full profile, preserving everything else. Idempotent."""
    am = settings.setdefault("autoMode", {})
    if not isinstance(am, dict):
        raise ValueError("autoMode is not an object")
    env = am.get("environment")
    if env is None:
        env = [DEFAULTS]                 # fresh array MUST carry $defaults
    elif not isinstance(env, list):
        raise ValueError("autoMode.environment is not an array")
    for line in ENV_LINES:
        if line not in env:
            env.append(line)
    am["environment"] = env

    perms = settings.setdefault("permissions", {})
    if not isinstance(perms, dict):
        raise ValueError("permissions is not an object")
    allow = perms.get("allow")
    if allow is None:
        allow = []
    elif not isinstance(allow, list):
        raise ValueError("permissions.allow is not an array")
    for rule in allow_rules(home):
        if rule not in allow:
            allow.append(rule)
    perms["allow"] = allow
    # Deliberately NOT setting permissions.defaultMode — auto mode is entered per run.
    return settings


def main(argv=None):
    ap = argparse.ArgumentParser(description="Camus auto-profile merger")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--settings", default=default_settings_path())
    args = ap.parse_args(argv)
    path = args.settings

    try:
        settings, existed = load(path)
    except (ValueError, TypeError) as exc:
        print("ERROR: %s is not valid JSON (%s) — refusing to touch it." % (path, exc),
              file=sys.stderr)
        return 2

    if args.check:
        if has_profile(settings):
            print("ok:    Camus auto profile present (egress trust + local context + gate-script allows)")
            return 0
        print("info:  Camus auto profile MISSING/partial "
              "(optional — run `install.sh --auto-setup` for unattended auto runs)")
        return 1

    if args.apply:
        if has_profile(settings):
            print("Camus auto profile already present — no change.")
            return 0
        try:
            apply(settings)
        except ValueError as exc:
            print("ERROR: %s — refusing to modify settings." % exc, file=sys.stderr)
            return 2
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if existed:
            backup = "%s.camus-bak.%d" % (path, int(time.time()))
            shutil.copy2(path, backup)
            print("backed up existing settings -> %s" % backup)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
            fh.write("\n")
        print("installed Camus auto profile -> %s" % path)
        print('  egress trust + local-only context + narrow gate-script allows ("$defaults" preserved).')
        print("  NO global permission mode set — start each run with: claude --permission-mode auto")
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
