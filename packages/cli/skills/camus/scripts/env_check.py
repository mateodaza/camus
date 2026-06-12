#!/usr/bin/env python3
"""Preflight environment doctor for the Camus loop.

Confirms a repo is actually RUNNABLE before the loop trusts its verifier — so the loop never
reports a code failure when the real problem is "deps not installed" or "wrong node" (the
run-1 false negative: `turbo` not found / node v12 in a fresh worktree).

Run at feat baseline / first call / install:
  env_check.py [REPO]        # exit 0 = ready, 1 = not ready (prints what to fix)

Checks: required-vs-actual node version, node deps installed, and that every verifier toolchain
binary resolves on PATH. Reuses verify.detect_checks so it checks exactly what the verifier runs.
"""
import json
import os
import re
import shutil
import subprocess
import sys

import verify  # same dir; checks the exact commands the verifier will run

# argv[0]s that mean a detected check actually runs node tooling (audit 2026-06-12, F15).
_NODE_TOOLING = ("node", "npm", "npx", "pnpm", "yarn", "bun", "bunx")


def required_node(repo):
    for fn in (".node-version", ".nvmrc"):
        p = os.path.join(repo, fn)
        if os.path.exists(p):
            v = open(p, encoding="utf-8").read().strip()
            if v:
                return v
    pkg = os.path.join(repo, "package.json")
    if os.path.exists(pkg):
        try:
            eng = (json.load(open(pkg, encoding="utf-8")) or {}).get("engines", {})
            if isinstance(eng, dict) and eng.get("node"):
                return str(eng["node"])
        except Exception:
            pass
    return None


def _major(v):
    m = re.search(r"(\d+)", v or "")
    return m.group(1) if m else None


def _node_major_satisfied(req, actual):
    # engines like ">=20.6" are RANGES, not pins — a newer major satisfies them. Comparing
    # majors for equality flagged node 22 against ">=20.6" as a mismatch (false NOT-READY).
    # BUT a COMPOUND range with an upper bound (">=20.6 <21") must RESPECT it — node 22 does NOT
    # satisfy "<21" (audit 2026-06-11: the lower-bound shortcut was admitting it). Pins and ^/~
    # ranges still require the same major.
    rmaj, amaj = _major(req), _major(actual)
    if not rmaj or not amaj:
        return True
    r = (req or "").strip()
    a, lo = int(amaj), int(rmaj)

    # Lower-bound check, STRICT vs inclusive (audit 2026-06-11: ">20" was treated as ">=20", so
    # ">20 <22" wrongly accepted node 20). Returns None when there's no lower-bound comparator.
    def lower_ok():
        if r.startswith(">="):
            return a >= lo
        if r.startswith(">"):
            return a > lo
        return None

    um = re.search(r"<(=?)\s*(\d+)", r)                       # an upper bound, if the range has one
    if um:
        ubound = int(um.group(2))
        up_ok = (a <= ubound) if um.group(1) == "=" else (a < ubound)
        lo_ok = lower_ok()                                    # None ⇒ upper-bound-only (e.g. "<21")
        return (lo_ok and up_ok) if lo_ok is not None else up_ok
    lo_ok = lower_ok()
    if lo_ok is not None:
        return lo_ok
    return rmaj == amaj                                       # pins and ^/~ require the same major


def _detect_node_version(login_shell=False, cwd=None):
    # Probe node the SAME way verify will invoke it. A CAMUS_VERIFY_CMD override runs through
    # `bash -lc`, which sources login files (.bash_profile / .zprofile) and can resolve a
    # DIFFERENT node (nvm/fnm/brew) than a direct subprocess. Probing directly here once reported
    # v22 as "ready" while the login-shell verify actually ran v12 -> false base_red. (#3)
    # cwd=repo so directory-sensitive managers (.nvmrc / fnm / asdf / direnv) select the same node
    # verify will — verify runs every check with cwd=repo, so the probe must match that too. (#3 P2)
    cmd = ["bash", "-lc", "node --version"] if login_shell else ["node", "--version"]
    try:
        v = (subprocess.run(cmd, capture_output=True, text=True, cwd=cwd).stdout or "").strip()
        return v or None
    except Exception:
        return None


def check_env(repo, which=None, node_version=None, env=None, run=None):
    """Return a list of issue strings (empty = ready).
    `which`, `node_version`, `env`, `run` are injectable for tests."""
    which = which or shutil.which
    run = run or subprocess.run
    env = env if env is not None else os.environ

    issues = []

    # Resolve the checks ONCE and detect the context verify will run in: a CAMUS_VERIFY_CMD override
    # runs via `bash -lc` (login shell), auto-detected checks run as direct subprocesses. Every
    # probe below must match that context so env_check can't disagree with verify about node. (#3)
    checks = verify.detect_checks(repo, env)
    uses_login_shell = any(
        isinstance(c.get("cmd"), list) and c["cmd"][:2] == ["bash", "-lc"] for c in checks
    )

    # node version (only if the repo declares one) — probed in verify's execution context.
    # Stack-matrix audit 2026-06-12 (F15): a stray .nvmrc in a non-Node repo (docs-tooling
    # leftover in Rust/Python trees) was a false NOT-READY — only enforce when node is
    # actually in play: package.json present, a detected check that runs node tooling, or a
    # CAMUS_VERIFY_CMD override (opaque: it MAY run node — the run-1 v12 bug — so stay strict).
    node_in_play = (
        os.path.exists(os.path.join(repo, "package.json"))
        or uses_login_shell
        or any(c["cmd"][0] in _NODE_TOOLING for c in checks)
    )
    req = required_node(repo) if node_in_play else None
    if req is not None:
        actual = node_version() if node_version else _detect_node_version(uses_login_shell, cwd=repo)
        if actual is None:
            issues.append("node not found on PATH (repo expects node %s)" % req)
        elif not _node_major_satisfied(req, actual):
            ctx = " — as resolved by the login shell CAMUS_VERIFY_CMD runs in" if uses_login_shell else ""
            issues.append("node major mismatch: repo wants %s, found %s%s "
                          "(fix nvm/fnm/.bash_profile before running)" % (req, actual, ctx))

    # node deps installed — bun.lock added 2026-06-12 (stack-matrix audit, F13):
    # bun ≥1.2 writes the text lockfile, leaving bun.lockb behind only on old repos.
    if os.path.exists(os.path.join(repo, "package.json")):
        has_lock = any(os.path.exists(os.path.join(repo, f)) for f in
                       ("pnpm-lock.yaml", "yarn.lock", "package-lock.json",
                        "bun.lockb", "bun.lock"))
        if has_lock and not os.path.isdir(os.path.join(repo, "node_modules")):
            issues.append("node_modules missing — run the project's install "
                          "(e.g. `pnpm install`) before verify can run")

    # env-managed python (stack-matrix audit 2026-06-12, F2c): when detection fell back
    # to bare `python3 -m pytest`, prove the SYSTEM python3 can even import pytest. In
    # poetry/pipenv/conda repos it usually can't (the venv has pytest, python3 doesn't),
    # so verify would burn its run on "No module named pytest". Name the fix up front.
    if any(c["cmd"][:3] == ["python3", "-m", "pytest"] for c in checks):
        try:
            probe_ok = run(["python3", "-c", "import pytest"], capture_output=True,
                           text=True, cwd=repo, timeout=15).returncode == 0
        except Exception:
            probe_ok = True   # python3 itself absent is already flagged by the PATH loop below
        if not probe_ok:
            issues.append(
                "python checks detected but `python3 -c \"import pytest\"` fails — verify "
                "would run the SYSTEM python3, not this repo's managed venv "
                "(poetry/pipenv/conda). Set CAMUS_VERIFY_CMD, e.g. `uv run pytest -q` or "
                "`poetry install --sync -q && poetry run pytest -q`")

    # verifier toolchain resolvable (reuse the checks resolved above)
    for chk in checks:
        binary = chk["cmd"][0]
        if binary == "bash":            # CAMUS_VERIFY_CMD override runs via `bash -lc`; bash always present
            continue
        if which(binary) is None:
            issues.append("`%s` not on PATH (needed for verify step '%s')" % (binary, chk["name"]))

    return issues


def _codex_version(run=None):
    # `codex --version` is the only reliable source (no version file); bounded so a wedged
    # binary can't stall preflight. None = present-but-unprobeable, handled by the caller.
    run = run or subprocess.run
    try:
        out = (run(["codex", "--version"], capture_output=True, text=True, timeout=10).stdout or "").strip()
        m = re.search(r"(\d+\.\d+\.\d+)", out)
        return m.group(1) if m else (out or None)
    except Exception:
        return None


def collect_facts(which=None, env=None, platform=None, codex_version=None):
    """Deterministic environment FACTS for agent prompts — not readiness issues.

    The rule (smoke 2026-06-11): friction that bites once becomes a fact here, instead of agents
    rediscovering it mid-run (the reviewer was SIGTERM'd by the Bash tool's 2-min default, then
    retried with GNU `timeout` — absent on macOS). Facts are ADVISORY context the feat threads
    into plan/implement/fix prompts; readiness gating stays in check_env. Injectable for tests.
    """
    which = which or shutil.which
    env = env if env is not None else os.environ
    plat = platform or sys.platform
    facts = ["platform: %s" % ("darwin (macOS)" if str(plat).startswith("darwin")
                               else ("linux" if str(plat).startswith("linux") else str(plat)))]
    if which("timeout") is None and which("gtimeout") is None:
        facts.append("GNU `timeout` is NOT on PATH — never wrap commands in `timeout`/`gtimeout`; "
                     "use the Bash tool's timeout PARAMETER for deadlines")
    if which("codex") is None:
        facts.append("codex CLI: NOT on PATH (cross-vendor review will fail as infra, never silently pass)")
    else:
        ver = codex_version() if codex_version else _codex_version()
        facts.append("codex CLI: %s" % (ver or "present (version unprobeable)"))
        codex_home = env.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
        facts.append("codex auth: %s" % ("present" if os.path.exists(os.path.join(codex_home, "auth.json"))
                                         else "MISSING (run `codex login` before the review rounds)"))
        tier = None
        try:
            cfg = os.path.join(codex_home, "config.toml")
            if os.path.exists(cfg):
                m = re.search(r'^\s*service_tier\s*=\s*"([^"]+)"', open(cfg, encoding="utf-8").read(), re.M)
                tier = m.group(1) if m else None
        except Exception:
            pass
        facts.append("codex service tier: %s" % (tier or "unset (the ChatGPT-plan default governs)"))
    return facts


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    repo = argv[0] if argv else os.getcwd()
    issues = check_env(repo)
    rc = 0
    if not issues:
        print("ok: environment ready (node version, deps, and verifier toolchain present).")
    else:
        print("NOT READY — fix these before running the loop (otherwise verify is inconclusive):")
        for i in issues:
            print("  - " + i)
        rc = 1
    # Facts print on BOTH outcomes (delimited so camus-feat can lift the block verbatim): a
    # fix-and-resume after NOT READY still has the platform truths in the captured output.
    print("[env-facts]")
    for f in collect_facts():
        print(f)
    print("[/env-facts]")
    return rc


if __name__ == "__main__":
    sys.exit(main())
