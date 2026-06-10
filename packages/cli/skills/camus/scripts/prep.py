#!/usr/bin/env python3
"""Worktree dependency prep for the Camus loop.

A fresh git worktree has no `node_modules` (gitignored, so `git worktree add` doesn't copy it),
which means verify (`tsc`/`turbo`) can't even RUN there → 127 → inconclusive. For Node projects
this installs deps in the worktree before verify. Non-Node stacks (rust/go/foundry) are no-ops —
their build/test fetches deps themselves. Deps already present → no-op.

Usage:
  prep.py [DIR]    # exit 0 = prepped (or no-op), 1 = install failed

Reuses verify._node_pm so the package manager matches what the verifier will run.
`detect_needs` / `install_cmd` / `prep` are side-effect-free except for the injected runner,
so they're unit-tested without a real install.
"""
import json
import os
import subprocess
import sys

import verify  # same dir; reuse package-manager detection


_LOCKFILES = ("pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "bun.lock")


def needs_node_install(repo):
    """A Node project with a lockfile but no node_modules needs an install."""
    if not os.path.exists(os.path.join(repo, "package.json")):
        return False
    has_lock = any(os.path.exists(os.path.join(repo, f)) for f in _LOCKFILES)
    return has_lock and not os.path.isdir(os.path.join(repo, "node_modules"))


def install_cmd(repo):
    """Frozen/deterministic install command for the detected package manager."""
    pm = verify._node_pm(repo)
    if pm == "pnpm":
        return ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]
    if pm == "yarn":
        return ["yarn", "install", "--frozen-lockfile"]
    if pm == "bun":
        return ["bun", "install", "--frozen-lockfile"]
    return ["npm", "ci"]  # npm: clean, lockfile-exact install


def prep(repo, runner=None):
    """Ensure the worktree is runnable. `runner(cmd, cwd) -> (exit, tail)` is injectable for tests."""
    runner = runner or _run
    if not needs_node_install(repo):
        return {"prepped": True, "ran": None}  # no-op: non-node, or deps already present
    cmd = install_cmd(repo)
    exit_code, tail = runner(cmd, repo)
    if exit_code != 0:
        return {"prepped": False, "ran": cmd, "exit": exit_code, "log_tail": tail}
    return {"prepped": True, "ran": cmd, "exit": 0}


def _tail(text, n=20):
    return "\n".join((text or "").splitlines()[-n:])


def _run(cmd, cwd):
    timeout = int(os.environ.get("CAMUS_PREP_TIMEOUT", "600"))
    try:
        proc = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=timeout)
        return proc.returncode, _tail(proc.stdout)
    except subprocess.TimeoutExpired as exc:
        out = exc.output or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return 124, _tail(out + "\n[camus] dependency install timed out after %ds" % timeout)
    except FileNotFoundError as exc:
        return 127, "package manager not found: %s (%s)" % (cmd[0], exc)


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    repo = argv[0] if argv else os.getcwd()
    result = prep(repo)
    print(json.dumps(result))
    return 0 if result["prepped"] else 1


if __name__ == "__main__":
    sys.exit(main())
