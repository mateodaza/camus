"""Contract tests for the stack-agnostic verifier (verify.py).

Pure stdlib:
    python3 test_verify.py        # stdlib runner (bottom)
    python3 -m pytest -q          # also works

Tests detection across stacks, the CAMUS_VERIFY_CMD override, the fail-loud
no-verifier case, and result assembly with an injected runner (no real
pnpm/cargo/forge needed).
"""
import os
import tempfile
import verify


def _repo(files):
    """Create a temp repo dir with the given {relpath: contents}."""
    d = tempfile.mkdtemp(prefix="camus_verify_")
    for rel, contents in files.items():
        path = os.path.join(d, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(rel) else None
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(contents)
    return d


def _names(checks):
    return [c["name"] for c in checks]


# --- detection -------------------------------------------------------------

def test_node_pnpm_scripts():
    repo = _repo({
        "package.json": '{"scripts":{"typecheck":"tsc","test":"vitest"}}',
        "pnpm-lock.yaml": "",
    })
    checks = verify.detect_checks(repo, {})
    assert _names(checks) == ["node:typecheck", "node:test"]
    assert checks[0]["cmd"][0] == "pnpm" and checks[1]["cmd"] == ["pnpm", "test"]


def test_node_npm_tsc_fallback_no_test():
    repo = _repo({
        "package.json": '{"name":"x"}',         # no scripts
        "tsconfig.json": "{}",
        "package-lock.json": "{}",
    })
    checks = verify.detect_checks(repo, {})
    assert _names(checks) == ["node:tsc"]        # tsc fallback, and no test script -> no test check
    assert checks[0]["cmd"][:2] == ["npx", "--no-install"]


def test_python_pytest_detected():
    repo = _repo({"pyproject.toml": "[tool.poetry]\n", "tests/test_x.py": ""})
    assert "py:pytest" in _names(verify.detect_checks(repo, {}))


def test_python_mypy_when_configured():
    repo = _repo({"pyproject.toml": "[tool.mypy]\nstrict=true\n", "tests/t.py": ""})
    names = _names(verify.detect_checks(repo, {}))
    assert "py:mypy" in names and "py:pytest" in names


def test_rust():
    assert _names(verify.detect_checks(_repo({"Cargo.toml": "[package]"}), {})) \
        == ["rust:check", "rust:test"]


def test_foundry():
    assert _names(verify.detect_checks(_repo({"foundry.toml": "[profile.default]"}), {})) \
        == ["foundry:build", "foundry:test"]


def test_multistack_node_and_foundry():
    repo = _repo({
        "package.json": '{"scripts":{"test":"vitest"}}',
        "foundry.toml": "[profile.default]",
    })
    names = _names(verify.detect_checks(repo, {}))
    assert "node:test" in names and "foundry:test" in names


def test_make_fallback_only_when_nothing_else():
    repo = _repo({"Makefile": "test:\n\techo hi\n"})
    assert _names(verify.detect_checks(repo, {})) == ["make:test"]


def test_override_env_wins():
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}'})
    checks = verify.detect_checks(repo, {"CAMUS_VERIFY_CMD": "make ci"})
    assert len(checks) == 1 and checks[0]["name"] == "custom"
    assert checks[0]["cmd"] == ["bash", "-lc", "make ci"]


# --- result assembly -------------------------------------------------------

def test_no_verifier_is_fail_loud_not_pass():
    repo = _repo({"README.md": "nothing to verify"})
    checks = verify.detect_checks(repo, {})
    assert checks == []
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is False
    assert result["inconclusive"] is True          # nothing to verify != code broken
    assert result["failures"][0]["reason"] == "no_verifier_detected"


def test_build_result_all_pass():
    checks = [{"name": "a", "cmd": ["x"]}, {"name": "b", "cmd": ["y"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp")
    assert result["pass"] is True and result["failures"] == []
    assert result["inconclusive"] is False
    assert [c["name"] for c in result["checks"]] == ["a", "b"]


def test_real_fail_is_not_inconclusive():
    checks = [{"name": "node:test", "cmd": ["pnpm", "test"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (1, "AssertionError: boom"), "/tmp")
    assert result["pass"] is False
    assert result["inconclusive"] is False         # exit 1 = ran-and-failed (real)
    assert result["failures"][0]["stage"] == "node:test"
    assert result["failures"][0]["kind"] == "failed"
    assert "boom" in result["failures"][0]["log_tail"]


def test_missing_toolchain_is_inconclusive_not_failed():
    # exit 127 = command not found -> couldn't RUN (the node_modules/wrong-node false negative)
    checks = [{"name": "node:typecheck", "cmd": ["pnpm", "run", "type-check"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (127, "turbo: not found"), "/tmp")
    assert result["pass"] is False
    assert result["inconclusive"] is True
    assert result["failures"][0]["kind"] == "missing_tool"


def test_mixed_real_and_missing_is_not_inconclusive():
    # if even one real failure exists, it's a genuine verify_failed, not inconclusive
    checks = [{"name": "a", "cmd": ["x"]}, {"name": "b", "cmd": ["y"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (127, "") if cmd == ["x"] else (1, "real fail"), "/tmp")
    assert result["pass"] is False and result["inconclusive"] is False


# --- stdlib runner ---------------------------------------------------------

if __name__ == "__main__":
    import sys
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
