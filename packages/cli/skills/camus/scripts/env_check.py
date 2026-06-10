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


def check_env(repo, which=None, node_version=None, env=None):
    """Return a list of issue strings (empty = ready).
    `which`, `node_version`, `env` are injectable for tests."""
    which = which or shutil.which
    env = env if env is not None else os.environ

    issues = []

    # Resolve the checks ONCE and detect the context verify will run in: a CAMUS_VERIFY_CMD override
    # runs via `bash -lc` (login shell), auto-detected checks run as direct subprocesses. Every
    # probe below must match that context so env_check can't disagree with verify about node. (#3)
    checks = verify.detect_checks(repo, env)
    uses_login_shell = any(
        isinstance(c.get("cmd"), list) and c["cmd"][:2] == ["bash", "-lc"] for c in checks
    )

    # node version (only if the repo declares one) — probed in verify's execution context
    req = required_node(repo)
    if req is not None:
        actual = node_version() if node_version else _detect_node_version(uses_login_shell, cwd=repo)
        rmaj, amaj = _major(req), _major(actual)
        if actual is None:
            issues.append("node not found on PATH (repo expects node %s)" % req)
        elif rmaj and amaj and rmaj != amaj:
            ctx = " — as resolved by the login shell CAMUS_VERIFY_CMD runs in" if uses_login_shell else ""
            issues.append("node major mismatch: repo wants %s, found %s%s "
                          "(fix nvm/fnm/.bash_profile before running)" % (req, actual, ctx))

    # node deps installed
    if os.path.exists(os.path.join(repo, "package.json")):
        has_lock = any(os.path.exists(os.path.join(repo, f)) for f in
                       ("pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb"))
        if has_lock and not os.path.isdir(os.path.join(repo, "node_modules")):
            issues.append("node_modules missing — run the project's install "
                          "(e.g. `pnpm install`) before verify can run")

    # verifier toolchain resolvable (reuse the checks resolved above)
    for chk in checks:
        binary = chk["cmd"][0]
        if binary == "bash":            # CAMUS_VERIFY_CMD override runs via `bash -lc`; bash always present
            continue
        if which(binary) is None:
            issues.append("`%s` not on PATH (needed for verify step '%s')" % (binary, chk["name"]))

    return issues


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    repo = argv[0] if argv else os.getcwd()
    issues = check_env(repo)
    if not issues:
        print("ok: environment ready (node version, deps, and verifier toolchain present).")
        return 0
    print("NOT READY — fix these before running the loop (otherwise verify is inconclusive):")
    for i in issues:
        print("  - " + i)
    return 1


if __name__ == "__main__":
    sys.exit(main())
