"""Contract tests for prep.py (worktree dependency prep).

    python3 test_prep.py        # stdlib runner
    python3 -m pytest -q

Detection + command selection + no-op/failure paths, with an injected runner (no real install).
"""
import os
import sys
import tempfile

import prep


def _repo(files):
    d = tempfile.mkdtemp(prefix="camus_prep_")
    for rel, contents in files.items():
        p = os.path.join(d, rel)
        if rel.endswith("/"):
            os.makedirs(p, exist_ok=True)
        else:
            if os.path.dirname(rel):
                os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as fh:
                fh.write(contents)
    return d


# --- detection -------------------------------------------------------------

def test_needs_install_node_missing_modules():
    assert prep.needs_node_install(_repo({"package.json": "{}", "pnpm-lock.yaml": ""})) is True


def test_no_install_when_modules_present():
    assert prep.needs_node_install(
        _repo({"package.json": "{}", "pnpm-lock.yaml": "", "node_modules/": ""})) is False


def test_no_install_non_node():
    assert prep.needs_node_install(_repo({"Cargo.toml": "[package]"})) is False


def test_no_install_without_lockfile():
    assert prep.needs_node_install(_repo({"package.json": "{}"})) is False


def test_install_cmd_by_pm():
    assert prep.install_cmd(_repo({"package.json": "{}", "pnpm-lock.yaml": ""}))[0] == "pnpm"
    assert prep.install_cmd(_repo({"package.json": "{}", "yarn.lock": ""}))[0] == "yarn"
    assert prep.install_cmd(_repo({"package.json": "{}", "package-lock.json": "{}"})) == ["npm", "ci"]


def test_pnpm_cmd_is_frozen_and_offline():
    cmd = prep.install_cmd(_repo({"package.json": "{}", "pnpm-lock.yaml": ""}))
    assert "--frozen-lockfile" in cmd and "--prefer-offline" in cmd


# --- prep orchestration (injected runner) ----------------------------------

def test_prep_noop_non_node():
    out = prep.prep(_repo({"Cargo.toml": "[package]"}), runner=lambda c, cwd: (0, ""))
    assert out["prepped"] is True and out["ran"] is None


def test_prep_noop_deps_present():
    repo = _repo({"package.json": "{}", "pnpm-lock.yaml": "", "node_modules/": ""})
    out = prep.prep(repo, runner=lambda c, cwd: (1, "should not be called"))
    assert out["prepped"] is True and out["ran"] is None


def test_prep_runs_install_success():
    repo = _repo({"package.json": "{}", "pnpm-lock.yaml": ""})
    out = prep.prep(repo, runner=lambda c, cwd: (0, "done"))
    assert out["prepped"] is True and out["ran"][0] == "pnpm"


def test_prep_install_failure_surfaces():
    repo = _repo({"package.json": "{}", "pnpm-lock.yaml": ""})
    out = prep.prep(repo, runner=lambda c, cwd: (1, "ERR_PNPM lockfile mismatch"))
    assert out["prepped"] is False and out["exit"] == 1
    assert "ERR_PNPM" in out["log_tail"]


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
