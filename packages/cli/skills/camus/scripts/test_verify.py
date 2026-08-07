"""Contract tests for the stack-agnostic verifier (verify.py).

Pure stdlib:
    python3 test_verify.py        # stdlib runner (bottom)
    python3 -m pytest -q          # also works

Tests detection across stacks, the CAMUS_VERIFY_CMD override, the fail-loud
no-verifier case, result assembly with an injected runner (no real
pnpm/cargo/forge needed), the run-6 HEAD-integrity invariant with an
injected porcelain snapshot, and the certified-HEAD identity (injected head
seam: head naming, head_moved, degrade-open) — plus real-git lanes that skip
when git is absent.
"""
import os
import shutil
import subprocess
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


# --- .NET (WP6 dogfood 2026-08-05: a real C# repo verified as "no checks") ---

def test_dotnet_slnx_detected():
    """A .slnx solution at the root is a .NET repo. Before this, verification had
    NOTHING to run on a committed C# candidate."""
    repo = _repo({"ActionRpgFramework.slnx": "<Solution/>"})
    assert _names(verify.detect_checks(repo, {})) == ["dotnet:build"]


def test_dotnet_sln_and_csproj_detected():
    assert "dotnet:build" in _names(verify.detect_checks(_repo({"App.sln": ""}), {}))
    assert "dotnet:build" in _names(verify.detect_checks(_repo({"App.csproj": "<Project/>"}), {}))


def test_dotnet_project_in_subdirectory_detected():
    """The real WP6 layout: solution at the root, projects one level down."""
    repo = _repo({"ActionRpgFramework.slnx": "<Solution/>",
                  "ActionRpgFramework.Core/ActionRpgFramework.Core.csproj": "<Project/>"})
    assert "dotnet:build" in _names(verify.detect_checks(repo, {}))


def test_dotnet_test_project_adds_dotnet_test():
    """A test project earns `dotnet test`; the WP6 candidate has exactly this shape."""
    repo = _repo({"ActionRpgFramework.slnx": "<Solution/>",
                  "tests/ActionRpgFramework.Core.Tests/ActionRpgFramework.Core.Tests.csproj": "<Project/>"})
    names = _names(verify.detect_checks(repo, {}))
    assert names == ["dotnet:build", "dotnet:test"], names


def test_dotnet_library_only_gets_no_test_check():
    """No test project → no `dotnet test`, so a library repo cannot verify red for
    having no tests."""
    repo = _repo({"App.slnx": "<Solution/>", "src/App/App.csproj": "<Project/>"})
    assert _names(verify.detect_checks(repo, {})) == ["dotnet:build"]


def test_dotnet_single_root_solution_is_named_explicitly():
    """One root solution → name it, so `dotnet build` is never ambiguous."""
    repo = _repo({"ActionRpgFramework.slnx": "<Solution/>",
                  "tests/App.Tests/App.Tests.csproj": "<Project/>"})
    checks = verify.detect_checks(repo, {})
    assert checks[0]["cmd"] == ["dotnet", "build", "--nologo", "ActionRpgFramework.slnx"], checks[0]["cmd"]
    assert checks[1]["cmd"][-1] == "ActionRpgFramework.slnx"


def test_dotnet_multi_solution_stays_targetless():
    """Two root solutions: we cannot pick for the operator, so stay targetless and
    let the MSB1011 ambiguity classify as INCONCLUSIVE (never a code-red)."""
    repo = _repo({"A.sln": "", "B.sln": "", "src/App/App.csproj": "<Project/>"})
    assert verify.detect_checks(repo, {})[0]["cmd"] == ["dotnet", "build", "--nologo"]


def test_dotnet_ambiguous_target_is_inconclusive_not_red():
    """MSB1011 says the harness did not say WHAT to build — an environment
    statement. A multi-solution repo must never read as broken code."""
    chk = {"name": "dotnet:build", "cmd": ["dotnet", "build", "--nologo"]}
    tail = ("MSB1011: Specify which project or solution file to use because this "
            "folder contains more than one project or solution file.")
    assert verify._classify_failure(chk, 1, tail) == "missing_tool"


def test_dotnet_missing_workload_is_inconclusive_not_red():
    """A missing MOBILE WORKLOAD means the check could not RUN on this host. It must
    withhold a verdict, never call the candidate broken (the cardinal rule)."""
    chk = {"name": "dotnet:build", "cmd": ["dotnet", "build", "--nologo"]}
    tail = ("error NETSDK1147: To build this project, the following workloads must "
            "be installed: maui-ios")
    assert verify._classify_failure(chk, 1, tail) == "missing_tool"
    assert "missing_tool" in verify.INCONCLUSIVE_KINDS


def test_dotnet_missing_sdk_is_inconclusive():
    chk = {"name": "dotnet:build", "cmd": ["dotnet", "build"]}
    assert verify._classify_failure(chk, 1, "No .NET SDKs were found.") == "missing_tool"


def test_dotnet_real_compile_error_stays_RED():
    """The control: a genuine compile error is still a code verdict. Without this the
    inconclusive rule above could swallow every real .NET failure."""
    chk = {"name": "dotnet:build", "cmd": ["dotnet", "build", "--nologo"]}
    tail = "EnemyBody.cs(42,13): error CS0103: The name 'foo' does not exist"
    assert verify._classify_failure(chk, 1, tail) != "missing_tool"


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


def test_dotnet_test_exit_zero_with_no_tests_is_inconclusive():
    # `dotnet test` can exit 0 after selecting a target that discovers no tests.
    # That is no verdict on the code, not a green gate.
    checks = [{"name": "dotnet:test", "cmd": ["dotnet", "test", "tests/X.csproj"]}]
    result = verify.build_result(
        checks,
        lambda cmd, cwd: (0, "No test is available in tests/X.dll. Make sure that test discoverer & executors are registered."),
        "/tmp")
    assert result["pass"] is False
    assert result["inconclusive"] is True
    assert result["failures"][0]["kind"] == "no_tests"


def test_dotnet_test_exit_zero_with_passed_tests_stays_green():
    checks = [{"name": "dotnet:test", "cmd": ["dotnet", "test", "tests/X.csproj"]}]
    result = verify.build_result(
        checks,
        lambda cmd, cwd: (0, "Passed! - Failed: 0, Passed: 102, Skipped: 0, Total: 102"),
        "/tmp")
    assert result["pass"] is True
    assert result["inconclusive"] is False
    assert result["failures"] == []


def test_dotnet_test_in_explicit_shell_override_detects_no_tests():
    checks = [{
        "name": "custom",
        "cmd": ["bash", "-lc", "dotnet build X.sln && dotnet test X.sln --no-build"],
    }]
    result = verify.build_result(
        checks, lambda cmd, cwd: (0, "No test is available in X.dll."), "/tmp")
    assert result["pass"] is False
    assert result["inconclusive"] is True
    assert result["failures"][0]["kind"] == "no_tests"


def test_non_dotnet_success_text_is_not_misclassified_as_no_tests():
    # Keep the success-output heuristic scoped to the .NET harness.
    checks = [{"name": "custom", "cmd": ["bash", "-lc", "echo ok"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (0, "No test is available in this fixture"), "/tmp")
    assert result["pass"] is True
    assert result["failures"] == []


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


# --- HEAD-integrity invariant (live smoke run-6, 2026-06-12) ----------------
# Run-6's verifier EDITED the code under verification to turn red green; the
# committed branch stayed red while the gate reported green. A gating verify
# certifies the COMMITTED state, so tracked-file dirt before or after the checks
# is a RED tampered verdict — never inconclusive, never auto-retried.

def test_dirty_before_is_red_and_checks_never_run():
    calls = []

    def runner(cmd, cwd):
        calls.append(cmd)
        return (0, "")

    checks = [{"name": "node:test", "cmd": ["pnpm", "test"]}]
    result = verify.build_result(
        checks, runner, "/tmp",
        porcelain=lambda repo: " M src/app.py\nM  lib/core.py\n")
    assert result["pass"] is False
    assert result["inconclusive"] is False     # RED: remedy is a human look, not a retry
    assert result["tampered"] is True
    assert calls == []                         # the checks never ran
    assert result["checks"] == []
    assert len(result["failures"]) == 1
    f = result["failures"][0]
    assert f["stage"] == "integrity" and f["kind"] == "uncommitted_state"
    assert "src/app.py" in f["log_tail"] and "lib/core.py" in f["log_tail"]


def test_mutation_during_checks_is_red_tracked_mutation():
    # clean before, dirty after: the checks DID run (and even passed), but something
    # mutated tracked files mid-verify — a green here would certify tampered state.
    snaps = iter(["", " M src/code.py\n"])
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp",
                                 porcelain=lambda repo: next(snaps))
    assert result["pass"] is False
    assert result["inconclusive"] is False
    assert result["tampered"] is True
    f = result["failures"][0]
    assert f["stage"] == "integrity" and f["kind"] == "tracked_mutation"
    assert "src/code.py" in f["log_tail"]      # the delta lines are named
    assert [c["name"] for c in result["checks"]] == ["a"]   # checks recorded as ran


def test_mutation_plus_inconclusive_checks_is_still_red():
    # missing_tool alone would be inconclusive — tampering must force a real red.
    snaps = iter(["", " M f.py\n"])
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (127, "not found"), "/tmp",
                                 porcelain=lambda repo: next(snaps))
    assert result["pass"] is False
    assert result["inconclusive"] is False
    assert result["tampered"] is True
    assert {f["kind"] for f in result["failures"]} == {"missing_tool", "tracked_mutation"}


def test_clean_before_and_after_is_untampered_green():
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp",
                                 porcelain=lambda repo: "")
    assert result["pass"] is True
    assert result["tampered"] is False
    assert result["failures"] == []
    assert "integrity_note" not in result


def test_integrity_kinds_are_never_inconclusive():
    assert "uncommitted_state" not in verify.INCONCLUSIVE_KINDS
    assert "tracked_mutation" not in verify.INCONCLUSIVE_KINDS


def test_snapshot_unavailable_degrades_open_with_note():
    # porcelain seam answering None = git couldn't answer → integrity NOT asserted,
    # behavior otherwise unchanged, and the result says why no assertion happened.
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp",
                                 porcelain=lambda repo: None)
    assert result["pass"] is True
    assert result["tampered"] is False
    assert all(f.get("stage") != "integrity" for f in result["failures"])
    assert "HEAD-integrity not asserted" in result["integrity_note"]


def test_non_git_target_behaves_as_today():
    # the REAL default snapshot on a bare dir: git answers "not a repo" → None →
    # degrade open (this is the lane every pre-existing /tmp-based test rides).
    repo = _repo({"README.md": "x"})
    assert verify.git_porcelain(repo) is None
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is True
    assert result["tampered"] is False


def test_untracked_only_dirt_is_clean_real_git():
    # --untracked-files=no: test-artifact junk must NOT read as tampering, while a
    # tracked edit must go red WITHOUT running the checks. Real git end-to-end.
    if not shutil.which("git"):
        return   # no git in this env: the degrade-open lane above is the behavior
    repo = _repo({"tracked.txt": "v1"})
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

    def git(*args):
        return subprocess.run(
            ("git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
             "-c", "commit.gpgsign=false") + args,
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    assert git("init", "-q").returncode == 0
    assert git("add", "-A").returncode == 0
    assert git("commit", "-qm", "base").returncode == 0
    with open(os.path.join(repo, "junk.log"), "w", encoding="utf-8") as fh:
        fh.write("test artifact")
    assert verify.git_porcelain(repo) == ""      # untracked-only = clean
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is True and result["tampered"] is False
    # now a tracked edit — the default-seam wiring must refuse to verify it
    with open(os.path.join(repo, "tracked.txt"), "w", encoding="utf-8") as fh:
        fh.write("v2")
    result = verify.build_result(checks, lambda cmd, cwd: (0, "never ran"), repo)
    assert result["pass"] is False and result["tampered"] is True
    assert result["failures"][0]["kind"] == "uncommitted_state"
    assert "tracked.txt" in result["failures"][0]["log_tail"]


# --- certified-HEAD identity (design review, 2026-06-12) --------------------
# Porcelain catches EDITS; edit→COMMIT→rerun leaves a clean tree and a green
# verdict (run-6's cover-up commit was blocked only by the permission layer).
# So verify NAMES the HEAD it certified — "head" in the result, compared
# upstream against the sha the commit gate / merge receipt sealed — and a HEAD
# that moves DURING verify is a RED head_moved in its own right.

def _real_git_repo(files):
    """git-init'd temp repo for the head lanes; (None, None) when git is absent
    (callers skip, mirroring test_untracked_only_dirt_is_clean_real_git)."""
    if not shutil.which("git"):
        return None, None
    repo = _repo(files)
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

    def git(*args):
        return subprocess.run(
            ("git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
             "-c", "commit.gpgsign=false") + args,
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    assert git("init", "-q").returncode == 0
    return repo, git


def test_head_emitted_on_git_target_matches_rev_parse():
    # real git end-to-end: the verdict names the committed sha it certified.
    repo, git = _real_git_repo({"tracked.txt": "v1"})
    if repo is None:
        return   # no git in this env: the degrade-open lanes below are the behavior
    assert git("add", "-A").returncode == 0
    assert git("commit", "-qm", "base").returncode == 0
    sha = git("rev-parse", "HEAD").stdout.strip()
    assert verify.git_head(repo) == sha
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is True and result["tampered"] is False
    assert result["head"] == sha


def test_unborn_head_degrades_open_real_git():
    # `git rev-parse HEAD` can't answer before the first commit → None → HEAD
    # identity not asserted, behavior otherwise unchanged, no head key.
    repo, git = _real_git_repo({"f.txt": "x"})
    if repo is None:
        return
    assert verify.git_head(repo) is None
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is True and result["tampered"] is False
    assert "head" not in result


def test_head_moved_during_verify_is_red_tampered():
    # edit→COMMIT mid-verify: the tree reads clean, but the HEAD under
    # certification changed — RED head_moved, never inconclusive.
    heads = iter(["aaaa111", "bbbb222"])
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp",
                                 porcelain=lambda repo: "",
                                 head=lambda repo: next(heads))
    assert result["pass"] is False
    assert result["inconclusive"] is False
    assert result["tampered"] is True
    assert len(result["failures"]) == 1
    f = result["failures"][0]
    assert f["stage"] == "integrity" and f["kind"] == "head_moved"
    assert "aaaa111" in f["log_tail"] and "bbbb222" in f["log_tail"]
    assert [c["name"] for c in result["checks"]] == ["a"]   # checks recorded as ran
    assert result["head"] == "bbbb222"                      # the after-head is named
    assert "head_moved" not in verify.INCONCLUSIVE_KINDS


def test_head_moved_composes_with_tracked_mutation():
    # both integrity channels can fire on one run (a commit AND leftover dirt).
    snaps = iter(["", " M f.py\n"])
    heads = iter(["aaaa111", "bbbb222"])
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), "/tmp",
                                 porcelain=lambda repo: next(snaps),
                                 head=lambda repo: next(heads))
    assert result["pass"] is False and result["tampered"] is True
    assert result["inconclusive"] is False
    assert {f["kind"] for f in result["failures"]} == {"tracked_mutation", "head_moved"}


def test_non_git_target_emits_no_head_key():
    # the REAL default seam on a bare dir: rev-parse can't answer → no head key,
    # behavior exactly as before.
    repo = _repo({"README.md": "x"})
    assert verify.git_head(repo) is None
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(checks, lambda cmd, cwd: (0, ""), repo)
    assert result["pass"] is True and result["tampered"] is False
    assert "head" not in result


def test_dirty_before_short_circuit_still_emits_head():
    # the refusal names the state it refused: the orchestrator can hold even a
    # tampered verdict against the sha the gate sealed.
    checks = [{"name": "a", "cmd": ["x"]}]
    result = verify.build_result(
        checks, lambda cmd, cwd: (0, "never ran"), "/tmp",
        porcelain=lambda repo: " M src/app.py\n",
        head=lambda repo: "cafe420")
    assert result["pass"] is False and result["tampered"] is True
    assert result["failures"][0]["kind"] == "uncommitted_state"
    assert result["checks"] == []
    assert result["head"] == "cafe420"


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
