"""Contract tests for env_check.py (environment preflight doctor).

    python3 test_env_check.py      # stdlib runner (bottom)
    python3 -m pytest -q

`which` and `node_version` are injected so no real node/pnpm/cargo is needed.
"""
import os
import sys
import tempfile

import env_check as E


def _repo(files):
    d = tempfile.mkdtemp(prefix="camus_env_")
    for rel, contents in files.items():
        p = os.path.join(d, rel)
        if os.path.dirname(rel):
            os.makedirs(os.path.dirname(p), exist_ok=True)
        if rel.endswith("/"):
            os.makedirs(p, exist_ok=True)
        else:
            with open(p, "w") as fh:
                fh.write(contents)
    return d


ALL_PRESENT = lambda b: "/usr/bin/" + b          # which: everything resolves
NONE_PRESENT = lambda b: None


# --- required node detection ----------------------------------------------

def test_required_node_from_node_version_file():
    assert E.required_node(_repo({".node-version": "22\n"})) == "22"


def test_required_node_from_engines():
    assert E.required_node(_repo({"package.json": '{"engines":{"node":">=20"}}'})) == ">=20"


def test_required_node_none_when_unspecified():
    assert E.required_node(_repo({"package.json": "{}"})) is None


# --- node version mismatch -------------------------------------------------

def test_node_major_mismatch_flagged():
    repo = _repo({".node-version": "22"})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v18.4.0")
    assert any("node major mismatch" in i for i in issues)


def test_node_match_ok():
    repo = _repo({".node-version": "22"})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v22.5.0")
    assert not any("node" in i for i in issues)


# --- deps ------------------------------------------------------------------

def test_deps_missing_flagged():
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": ""})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v22.0.0")
    assert any("node_modules missing" in i for i in issues)


def test_deps_present_ok():
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "",
                  "node_modules/": ""})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v22.0.0")
    assert not any("node_modules" in i for i in issues)


# --- toolchain on PATH -----------------------------------------------------

def test_missing_toolchain_flagged():
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "",
                  "node_modules/": ""})
    issues = E.check_env(repo, which=NONE_PRESENT, node_version=lambda: "v22.0.0")
    assert any("pnpm" in i and "not on PATH" in i for i in issues)


def test_ready_when_all_good():
    repo = _repo({"package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "",
                  "node_modules/": "", ".node-version": "22"})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v22.9.0")
    assert issues == []


def test_override_skips_toolchain_bash():
    # CAMUS_VERIFY_CMD override runs via `bash -lc`; bash is not flagged even if which() is empty
    repo = _repo({"README.md": "x"})
    issues = E.check_env(repo, which=NONE_PRESENT, node_version=lambda: None,
                         env={"CAMUS_VERIFY_CMD": "make ci"})
    assert not any("bash" in i for i in issues)


# --- #3: node probed in verify's execution context ------------------------

def _record_probe_context(repo, env):
    """Run check_env with the real node probe swapped for a recorder; return login_shell flag."""
    seen = {}

    def rec(login_shell=False, cwd=None):
        seen["ls"] = login_shell
        seen["cwd"] = cwd
        return "v22.0.0"

    orig = E._detect_node_version
    E._detect_node_version = rec
    try:
        E.check_env(repo, which=ALL_PRESENT, env=env)   # node_version=None -> uses _detect_node_version
    finally:
        E._detect_node_version = orig
    return seen


def test_node_probed_in_login_shell_when_override():
    # CAMUS_VERIFY_CMD -> verify runs `bash -lc` -> env_check must probe node via the login shell too
    repo = _repo({".node-version": "22", "README.md": "x"})
    assert _record_probe_context(repo, {"CAMUS_VERIFY_CMD": "pnpm -w type-check"})["ls"] is True


def test_node_probed_directly_when_autodetect():
    # auto-detected checks run as direct subprocesses -> probe node directly, no login shell
    repo = _repo({".node-version": "22", "package.json": '{"scripts":{"test":"vitest"}}',
                  "pnpm-lock.yaml": "", "node_modules/": ""})
    assert _record_probe_context(repo, {})["ls"] is False


def test_node_probe_runs_in_repo_cwd():
    # #3 P2: probe must run with cwd=repo so .nvmrc/fnm/asdf/direnv pick the node verify will
    repo = _repo({".node-version": "22", "README.md": "x"})
    assert _record_probe_context(repo, {})["cwd"] == repo


def test_login_shell_mismatch_message_names_the_cause():
    repo = _repo({".node-version": "22", "README.md": "x"})
    issues = E.check_env(repo, which=ALL_PRESENT, node_version=lambda: "v12.0.0",
                         env={"CAMUS_VERIFY_CMD": "pnpm -w type-check"})
    assert any("node major mismatch" in i for i in issues)


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
