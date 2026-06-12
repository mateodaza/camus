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


# --- stack-matrix audit 2026-06-12: detection honesty ----------------------
# Cardinal rule under test: the gate must NEVER emit a false verdict. Environmental
# failure is inconclusive (missing_tool/no_tests/timeout), never "the code failed",
# and a wrong-harness pass is never a green.

def test_tests_dir_alone_is_not_python_evidence():
    # F1: Rust/C++/engine repos have an idiomatic tests/ dir too — injecting pytest
    # there was a guaranteed false RED on green code.
    repo = _repo({"Cargo.toml": "[package]", "tests/integration.rs": "#[test]\nfn t() {}\n"})
    names = _names(verify.detect_checks(repo, {}))
    assert "py:pytest" not in names
    assert names == ["rust:check", "rust:test"]


def test_bare_tests_dir_without_python_detects_nothing():
    repo = _repo({"tests/smoke.cpp": "int main(){}"})
    assert verify.detect_checks(repo, {}) == []


def test_tests_dir_with_top_level_py_file_is_python():
    repo = _repo({"tests/test_x.py": "def test_a(): pass\n"})
    assert "py:pytest" in _names(verify.detect_checks(repo, {}))


def test_tests_dir_plus_requirements_txt_is_python():
    repo = _repo({"requirements.txt": "pytest\n", "tests/fixtures.json": "{}"})
    assert "py:pytest" in _names(verify.detect_checks(repo, {}))


def test_pytest_exit_5_no_tests_collected_is_inconclusive():
    # F1: pytest exit 5 = "no tests collected" — nothing ran, so nothing failed.
    checks = [{"name": "py:pytest", "cmd": ["python3", "-m", "pytest", "-q"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (5, "no tests ran in 0.01s"), "/tmp")
    assert result["pass"] is False
    assert result["inconclusive"] is True
    assert result["failures"][0]["kind"] == "no_tests"


def test_exit_5_from_non_pytest_stays_red():
    # exit 5 only means "no tests" for pytest — anything else keeps its red.
    checks = [{"name": "make:test", "cmd": ["make", "test"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (5, "boom"), "/tmp")
    assert result["failures"][0]["kind"] == "failed"
    assert result["inconclusive"] is False


def test_no_tests_plus_real_failure_is_still_red():
    # inconclusive kinds must never mask a check that ran and FAILED
    checks = [{"name": "py:pytest", "cmd": ["python3", "-m", "pytest", "-q"]},
              {"name": "node:test", "cmd": ["pnpm", "test"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (5, "no tests ran") if cmd[0] == "python3" else (1, "1 failed"),
        "/tmp")
    assert result["pass"] is False and result["inconclusive"] is False


def test_no_module_named_is_environment_not_code():
    # F2a: bare python3 in a poetry/uv/pipenv/conda repo says "No module named pytest"
    # with exit 1 — an environment statement, never a code verdict.
    checks = [{"name": "py:pytest", "cmd": ["python3", "-m", "pytest", "-q"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (1, "/usr/bin/python3: No module named pytest"), "/tmp")
    assert result["failures"][0]["kind"] == "missing_tool"
    assert result["pass"] is False and result["inconclusive"] is True


def test_uv_lock_runs_pytest_via_uv():
    # F2b: uv self-syncs .venv in a cold worktree — bare python3 there is the SYSTEM
    # interpreter (false RED, or a narrow false GREEN off stale global site-packages).
    repo = _repo({"pyproject.toml": '[project]\nname = "x"\n', "uv.lock": ""})
    cmds = {c["name"]: c["cmd"] for c in verify.detect_checks(repo, {})}
    assert cmds["py:pytest"] == ["uv", "run", "pytest", "-q"]


def test_uv_lock_runs_mypy_via_uv_only_when_configured():
    repo = _repo({"pyproject.toml": "[tool.mypy]\nstrict = true\n", "uv.lock": ""})
    cmds = {c["name"]: c["cmd"] for c in verify.detect_checks(repo, {})}
    assert cmds["py:mypy"] == ["uv", "run", "mypy", "."]
    repo2 = _repo({"pyproject.toml": "[project]\n", "uv.lock": ""})
    assert "py:mypy" not in _names(verify.detect_checks(repo2, {}))


def test_pipfile_alone_is_python_evidence():
    # F2d: pipenv repos (Pipfile, no pyproject/setup.py) were invisible to detection.
    repo = _repo({"Pipfile": '[packages]\nrequests = "*"\n'})
    assert "py:pytest" in _names(verify.detect_checks(repo, {}))


def test_bun_test_script_runs_via_bun_run_not_builtin():
    # F3: `bun test` is Bun's BUILT-IN runner — a vitest suite would never execute yet
    # read green (wrong-harness pass). `bun run test` executes the package's script.
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}', "bun.lockb": ""})
    cmds = {c["name"]: c["cmd"] for c in verify.detect_checks(repo, {})}
    assert cmds["node:test"] == ["bun", "run", "test"]


def test_bun_tsc_lane_uses_bunx():
    # F3: `bun exec` is not a package-binary runner; bunx is.
    repo = _repo({"package.json": '{"name":"x"}', "tsconfig.json": "{}", "bun.lock": ""})
    cmds = {c["name"]: c["cmd"] for c in verify.detect_checks(repo, {})}
    assert cmds["node:tsc"] == ["bunx", "tsc", "--noEmit"]


def test_npm_init_placeholder_test_script_is_skipped():
    # F4: the stock `npm init` placeholder fails BY DESIGN (`exit 1`) — gating on it
    # verdicts every change red forever. Treated as "no test script".
    repo = _repo({"package.json":
                  '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}'})
    assert "node:test" not in _names(verify.detect_checks(repo, {}))


def test_timeout_is_inconclusive_and_names_the_lever():
    # F5: a timeout is a budget statement, not a code verdict — and the report must
    # show WHAT timed out plus the CAMUS_VERIFY_TIMEOUT lever for compiled stacks.
    checks = [{"name": "rust:test", "cmd": ["cargo", "test"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (124, "Compiling syn v2.0.0"), "/tmp")
    f = result["failures"][0]
    assert f["kind"] == "timeout"
    assert result["pass"] is False and result["inconclusive"] is True
    assert "Compiling syn v2.0.0" in f["log_tail"]          # WHAT timed out, verbatim
    assert "CAMUS_VERIFY_TIMEOUT" in f["log_tail"]          # the lever


def test_makefile_substring_targets_do_not_count():
    # F6: `e2e-test:` and a comment mentioning "test:" matched the old substring check;
    # `make test` then died with "No rule to make target" — a false RED.
    repo = _repo({"Makefile": "# how to test: run e2e\ne2e-test:\n\techo e2e\n"})
    assert verify.detect_checks(repo, {}) == []


def test_gnumakefile_test_target_detected():
    # F6: GNUmakefile is a first-class name make honors — it was invisible before.
    repo = _repo({"GNUmakefile": "test:\n\techo hi\n"})
    assert _names(verify.detect_checks(repo, {})) == ["make:test"]


def test_npx_no_install_missing_tsc_is_missing_tool():
    # F7: `npx --no-install tsc` exits 1 (not 127) when typescript isn't installed.
    checks = [{"name": "node:tsc", "cmd": ["npx", "--no-install", "tsc", "--noEmit"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (1, "npm ERR! could not determine executable to run"), "/tmp")
    assert result["failures"][0]["kind"] == "missing_tool"
    assert result["inconclusive"] is True


def test_pm_exec_not_found_is_missing_tool():
    checks = [{"name": "node:tsc", "cmd": ["pnpm", "exec", "tsc", "--noEmit"]}]
    result = verify.build_result(
        checks,
        lambda cmd, cwd: (1, 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsc" not found'),
        "/tmp")
    assert result["failures"][0]["kind"] == "missing_tool"


def test_real_tsc_type_error_stays_red():
    checks = [{"name": "node:tsc", "cmd": ["npx", "--no-install", "tsc", "--noEmit"]}]
    result = verify.build_result(
        checks,
        lambda cmd, cwd: (1, "src/a.ts(3,5): error TS2322: Type 'string' is not assignable."),
        "/tmp")
    assert result["failures"][0]["kind"] == "failed"
    assert result["inconclusive"] is False


def test_not_found_in_plain_test_output_stays_red():
    # the F7 "not found" shape is scoped to exec-runner argv (npx/bunx/exec) — a real
    # test failure that merely PRINTS "not found" keeps its red.
    checks = [{"name": "node:test", "cmd": ["pnpm", "test"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (1, "Error: fixture file not found: golden.json"), "/tmp")
    assert result["failures"][0]["kind"] == "failed"
    assert result["inconclusive"] is False


def test_solution_tsconfig_skips_hollow_tsc_lane():
    # F7: {"files": [], "references": [...]} type-checks NOTHING — `tsc --noEmit` on it
    # exits 0 having verified zero files, a hollow green.
    repo = _repo({"package.json": '{"name":"x"}', "package-lock.json": "{}",
                  "tsconfig.json": '{"files": [], "references": [{"path": "./pkg"}]}'})
    assert verify.detect_checks(repo, {}) == []


def test_tsconfig_with_include_keeps_the_tsc_lane():
    repo = _repo({"package.json": '{"name":"x"}', "package-lock.json": "{}",
                  "tsconfig.json": '{"include": ["src"], "references": [{"path": "./pkg"}]}'})
    assert _names(verify.detect_checks(repo, {})) == ["node:tsc"]


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
