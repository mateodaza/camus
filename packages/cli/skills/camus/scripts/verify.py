#!/usr/bin/env python3
"""Stack-agnostic verifier for the Camus loop.

Detects a repo's build/test commands from its manifests/lockfiles (ZERO config),
runs them, and emits the gate contract {pass, failures, checks}. The loop adapts
to ANY stack without per-project config — the explicit v1 pain point we are not
carrying forward.

Resolution order:
  1. CAMUS_VERIFY_CMD env var  -> run exactly that (explicit escape hatch).
  2. Auto-detect ecosystems present (node / python / rust / go / foundry / make)
     and run each one's typecheck + test. Multiple may apply (e.g. node + foundry).
  3. Nothing detected -> pass:false, reason 'no_verifier_detected'. Absence of a
     verifier is NEVER a pass (mirrors the adapter's infra-vs-findings guard).

Pure stdlib. `detect_checks` and `build_result` are side-effect-free and unit-tested
in test_verify.py; only `run_cmd` touches subprocess.
"""
import json
import os
import subprocess
import sys


def _exists(repo, *names):
    return any(os.path.exists(os.path.join(repo, n)) for n in names)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _node_pm(repo):
    if _exists(repo, "pnpm-lock.yaml"):
        return "pnpm"
    if _exists(repo, "yarn.lock"):
        return "yarn"
    if _exists(repo, "bun.lockb", "bun.lock"):
        return "bun"
    return "npm"


def _file_contains(repo, name, needle):
    path = os.path.join(repo, name)
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return needle in fh.read()
    except Exception:
        return False


def detect_checks(repo, env=None):
    """Return a list of {name, cmd:[argv]} checks for the repo. Side-effect free."""
    env = env or {}
    override = env.get("CAMUS_VERIFY_CMD")
    if override:
        return [{"name": "custom", "cmd": ["bash", "-lc", override]}]

    checks = []

    # --- Node / TypeScript -------------------------------------------------
    if _exists(repo, "package.json"):
        pm = _node_pm(repo)
        scripts = (_read_json(os.path.join(repo, "package.json")) or {}).get("scripts", {})
        if not isinstance(scripts, dict):
            scripts = {}
        if "typecheck" in scripts:
            checks.append({"name": "node:typecheck", "cmd": [pm, "run", "typecheck"]})
        elif "type-check" in scripts:
            checks.append({"name": "node:type-check", "cmd": [pm, "run", "type-check"]})
        elif _exists(repo, "tsconfig.json"):
            exec_pref = ["npx", "--no-install"] if pm == "npm" else [pm, "exec"]
            checks.append({"name": "node:tsc", "cmd": exec_pref + ["tsc", "--noEmit"]})
        if "test" in scripts:
            checks.append({"name": "node:test", "cmd": [pm, "test"]})

    # --- Python ------------------------------------------------------------
    py_marker = (_exists(repo, "pyproject.toml", "setup.py", "setup.cfg",
                         "tox.ini", "pytest.ini")
                 or os.path.isdir(os.path.join(repo, "tests")))
    if py_marker:
        if _exists(repo, "mypy.ini") or _file_contains(repo, "pyproject.toml", "[tool.mypy]"):
            checks.append({"name": "py:mypy", "cmd": ["python3", "-m", "mypy", "."]})
        elif _exists(repo, "pyrightconfig.json"):
            checks.append({"name": "py:pyright", "cmd": ["pyright"]})
        checks.append({"name": "py:pytest", "cmd": ["python3", "-m", "pytest", "-q"]})

    # --- Rust --------------------------------------------------------------
    if _exists(repo, "Cargo.toml"):
        checks.append({"name": "rust:check", "cmd": ["cargo", "check"]})
        checks.append({"name": "rust:test", "cmd": ["cargo", "test"]})

    # --- Go ----------------------------------------------------------------
    if _exists(repo, "go.mod"):
        checks.append({"name": "go:build", "cmd": ["go", "build", "./..."]})
        checks.append({"name": "go:test", "cmd": ["go", "test", "./..."]})

    # --- Foundry / Solidity ------------------------------------------------
    if _exists(repo, "foundry.toml"):
        checks.append({"name": "foundry:build", "cmd": ["forge", "build"]})
        checks.append({"name": "foundry:test", "cmd": ["forge", "test"]})

    # --- Make (fallback only, when no language ecosystem matched) -----------
    if not checks and (_file_contains(repo, "Makefile", "test:")
                       or _file_contains(repo, "makefile", "test:")):
        checks.append({"name": "make:test", "cmd": ["make", "test"]})

    return checks


def _tail(text, n=20):
    if not text:
        return ""
    return "\n".join(text.splitlines()[-n:])


def run_cmd(cmd, cwd):
    """Run one check. Returns (exit_code, combined_output_tail)."""
    timeout = int(os.environ.get("CAMUS_VERIFY_TIMEOUT", "600"))  # audit F9: bound runaway/hung tests
    try:
        proc = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=timeout)
        return proc.returncode, _tail(proc.stdout)
    except subprocess.TimeoutExpired as exc:
        out = exc.output or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return 124, _tail(out + "\n[camus] command timed out after %ds" % timeout)
    except FileNotFoundError as exc:
        # The detected toolchain isn't installed here. That's a real failure
        # of THIS run's environment — report it, never silently pass.
        return 127, "command not found: %s (%s)" % (cmd[0], exc)


def build_result(checks, runner, repo):
    """Assemble the {pass, inconclusive, failures, checks} contract. `runner(cmd, cwd) -> (exit, tail)`.

    Infra-vs-findings guard for verify (mirrors the adapter): a check that could NOT RUN
    (toolchain missing, exit 127) or "no verifier detected" is `inconclusive` — it must NOT
    be reported as a code failure. Only checks that actually ran and failed are real failures.
    """
    if not checks:
        return {
            "pass": False,
            "inconclusive": True,   # nothing to verify != code is broken
            "failures": [{
                "stage": "verify",
                "reason": "no_verifier_detected",
                "kind": "missing_tool",
                "log_tail": "no recognized build/test config found; set CAMUS_VERIFY_CMD "
                            "to specify the command explicitly",
            }],
            "checks": [],
        }
    failures = []
    ran = []
    for chk in checks:
        exit_code, tail = runner(chk["cmd"], repo)
        ran.append({"name": chk["name"], "cmd": chk["cmd"], "exit": exit_code})
        if exit_code != 0:
            # 127 = command not found -> the check couldn't RUN (toolchain/deps missing).
            kind = "missing_tool" if exit_code == 127 else "failed"
            failures.append({"stage": chk["name"], "exit": exit_code,
                             "kind": kind, "log_tail": tail})
    passed = len(failures) == 0
    # inconclusive when there are failures but NONE of them is a real ran-and-failed check.
    inconclusive = (not passed) and all(f["kind"] == "missing_tool" for f in failures)
    return {"pass": passed, "inconclusive": inconclusive, "failures": failures, "checks": ran}


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    repo = argv[0] if argv else os.getcwd()
    checks = detect_checks(repo, os.environ)
    print(json.dumps(build_result(checks, run_cmd, repo)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
