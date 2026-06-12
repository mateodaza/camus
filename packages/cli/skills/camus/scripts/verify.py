#!/usr/bin/env python3
"""Stack-agnostic verifier for the Camus loop.

Detects a repo's build/test commands from its manifests/lockfiles (ZERO config),
runs them, and emits the gate contract {pass, inconclusive, tampered, failures,
checks}. The loop adapts to ANY stack without per-project config — the explicit v1
pain point we are not carrying forward.

Cardinal rule (re-affirmed by the 2026-06-12 stack-matrix audit): NEVER a false
verdict. An environmental failure (missing toolchain, unsynced venv, timeout, zero
tests collected) is `inconclusive` — never "the code failed" — and a check that ran
the WRONG harness is never allowed to read green.

HEAD-integrity invariant (live smoke run-6, 2026-06-12): a gating verify certifies
the COMMITTED state, so the tracked tree must be clean against HEAD before AND after
the checks. Dirt is a RED `tampered` verdict — never inconclusive (see build_result).
The verdict also NAMES the HEAD it certified ("head" in the result; design review
2026-06-12): a porcelain check is blind to an edit→COMMIT→rerun cover-up, so the
orchestrator compares the certified head against the sha the commit gate / merge
receipt sealed — and a HEAD that MOVES mid-verify is itself a RED `head_moved`.

Resolution order:
  1. CAMUS_VERIFY_CMD env var  -> run exactly that (explicit escape hatch).
  2. Auto-detect ecosystems present (node / python / rust / go / foundry / make)
     and run each one's typecheck + test. Multiple may apply (e.g. node + foundry).
  3. Nothing detected -> pass:false, reason 'no_verifier_detected'. Absence of a
     verifier is NEVER a pass (mirrors the adapter's infra-vs-findings guard).

Pure stdlib. `detect_checks` and `build_result` are unit-tested in test_verify.py
through injected seams (runner / porcelain / head); only `run_cmd`, `git_porcelain`
and `git_head` touch subprocess.
"""
import glob
import json
import os
import re
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


# Python manifests = REAL Python evidence. Pipfile joined the list in the
# 2026-06-12 stack-matrix audit (F2d): pipenv repos were invisible to detection.
_PY_MANIFESTS = ("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile")


def _tests_dir_is_python(repo):
    """tests/ counts as Python evidence only alongside a Python manifest or at
    least one top-level *.py inside it (stack-matrix audit 2026-06-12, F1):
    Rust/C++/engine repos have an idiomatic tests/ dir too, and injecting pytest
    there was a guaranteed false RED on green code."""
    if not os.path.isdir(os.path.join(repo, "tests")):
        return False
    if _exists(repo, *_PY_MANIFESTS):
        return True
    return bool(glob.glob(os.path.join(repo, "tests", "*.py")))


def _make_has_test_target(repo):
    """A make `test` target, ANCHORED to the start of a line (stack-matrix audit
    2026-06-12, F6): the old substring check matched `e2e-test:`, `pytest:` and
    comments, after which `make test` died with "No rule to make target" — a false
    RED. GNUmakefile is a first-class name make itself honors, so it joins the
    Makefile/makefile lookup."""
    for name in ("Makefile", "makefile", "GNUmakefile"):
        path = os.path.join(repo, name)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                if re.search(r"^[ \t]*test[ \t]*:", fh.read(), re.M):
                    return True
        except Exception:
            continue
    return False


def _tsconfig_solution_only(repo):
    """True when tsconfig.json is a solution-style config: a `references` array
    with no/empty `files`+`include`. `tsc --noEmit` on one type-checks NOTHING and
    exits 0 — a hollow green (stack-matrix audit 2026-06-12, F7). Unparseable
    (JSONC) configs return False: when unsure, keep the check."""
    cfg = _read_json(os.path.join(repo, "tsconfig.json"))
    if not isinstance(cfg, dict) or not isinstance(cfg.get("references"), list):
        return False
    return not cfg.get("files") and not cfg.get("include")


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
        elif _exists(repo, "tsconfig.json") and not _tsconfig_solution_only(repo):
            if pm == "npm":
                exec_pref = ["npx", "--no-install"]
            elif pm == "bun":
                exec_pref = ["bunx"]    # bun's package-binary runner (audit 2026-06-12, F3)
            else:
                exec_pref = [pm, "exec"]
            checks.append({"name": "node:tsc", "cmd": exec_pref + ["tsc", "--noEmit"]})
        test_script = str(scripts.get("test") or "")
        # The npm-init stock placeholder fails BY DESIGN (`echo "Error: no test
        # specified" && exit 1`) — gating on it verdicts every change red forever.
        # Treat it exactly like "no test script". (stack-matrix audit 2026-06-12, F4)
        if test_script and "Error: no test specified" not in test_script:
            # `bun test` runs Bun's BUILT-IN runner, not the package's test script —
            # a vitest/jest suite would never execute yet read green (wrong-harness
            # pass, stack-matrix audit 2026-06-12, F3). `bun run test` runs the
            # script, the same thing `pnpm/yarn/npm test` do.
            cmd = ["bun", "run", "test"] if pm == "bun" else [pm, "test"]
            checks.append({"name": "node:test", "cmd": cmd})

    # --- Python ------------------------------------------------------------
    # A bare tests/ dir is NOT Python evidence on its own (audit 2026-06-12, F1);
    # Pipfile is (F2d) — pipenv repos were invisible before.
    py_marker = (_exists(repo, "pyproject.toml", "setup.py", "setup.cfg",
                         "tox.ini", "pytest.ini", "Pipfile")
                 or _tests_dir_is_python(repo))
    if py_marker:
        # uv.lock -> run through uv, which self-syncs .venv in a cold worktree (the
        # one env manager that is worktree-proof). Bare python3 in an env-managed
        # repo is the SYSTEM interpreter: false RED ("No module named pytest") or a
        # narrow false GREEN off stale global site-packages. (audit 2026-06-12, F2b)
        use_uv = _exists(repo, "uv.lock")
        if _exists(repo, "mypy.ini") or _file_contains(repo, "pyproject.toml", "[tool.mypy]"):
            checks.append({"name": "py:mypy",
                           "cmd": ["uv", "run", "mypy", "."] if use_uv
                           else ["python3", "-m", "mypy", "."]})
        elif _exists(repo, "pyrightconfig.json"):
            checks.append({"name": "py:pyright", "cmd": ["pyright"]})
        checks.append({"name": "py:pytest",
                       "cmd": ["uv", "run", "pytest", "-q"] if use_uv
                       else ["python3", "-m", "pytest", "-q"]})

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
    if not checks and _make_has_test_target(repo):
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
        return 124, _tail(out + "\n[camus] command timed out after %ds — raise "
                                "CAMUS_VERIFY_TIMEOUT for cold compiled stacks" % timeout)
    except FileNotFoundError as exc:
        # The detected toolchain isn't installed here. That's a real failure
        # of THIS run's environment — report it, never silently pass.
        return 127, "command not found: %s (%s)" % (cmd[0], exc)


def git_porcelain(repo):
    """Tracked-files-only porcelain snapshot of `repo` vs HEAD ("" = clean).

    Tracked files only (`--untracked-files=no`) so test-artifact untracked junk stays
    irrelevant, and submodule noise is excluded (`--ignore-submodules=all`) per the
    existing containment discipline. Returns None when git cannot answer (git missing,
    not a git repo, hung) — the caller degrades OPEN: a non-git verify target (e.g.
    tests invoking verify.py on a bare dir) keeps working exactly as before, and
    integrity is asserted only when the snapshot succeeds.
    """
    cmd = ["git", "status", "--porcelain", "--untracked-files=no",
           "--ignore-submodules=all"]
    try:
        proc = subprocess.run(cmd, cwd=repo, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, timeout=30)
    except Exception:
        return None
    return proc.stdout if proc.returncode == 0 else None


def git_head(repo):
    """Sha of `repo`'s current HEAD, or None whenever git can't answer (non-git
    target, unborn HEAD, git missing, hung) — callers degrade OPEN exactly like the
    git_porcelain seam: HEAD identity is asserted only when the capture succeeds.
    """
    try:
        proc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, timeout=30)
    except Exception:
        return None
    sha = proc.stdout.strip()
    return sha if proc.returncode == 0 and sha else None


# Failure kinds that mean "this check could not deliver a verdict on the CODE".
# Any failure set made up solely of these leaves the run inconclusive (pass:false,
# never red) — the cardinal rule is the gate must NEVER emit a false verdict.
# (stack-matrix audit 2026-06-12: no_tests + timeout joined missing_tool)
# The integrity kinds (uncommitted_state / tracked_mutation / head_moved) are
# deliberately NOT here: a tampered tree or a moved HEAD is RED — the committed
# state is unverified and the remedy is a human look, never an auto-retry.
INCONCLUSIVE_KINDS = ("missing_tool", "no_tests", "timeout")


def _classify_failure(chk, exit_code, tail):
    """Kind for one nonzero exit. Misclassification policy: err toward inconclusive
    (a withheld verdict) — never toward a false red, and never toward a pass."""
    tail = tail or ""
    cmd = [str(p) for p in (chk.get("cmd") or [""])]
    if exit_code == 127:
        # command not found -> the check couldn't RUN (toolchain/deps missing).
        return "missing_tool"
    if exit_code == 124:
        # run_cmd's timeout sentinel: a budget statement, not a code verdict — cold
        # compiled builds (cargo/forge) routinely outlive the default 600s.
        # (stack-matrix audit 2026-06-12, F5)
        return "timeout"
    if exit_code == 5 and "pytest" in " ".join(cmd):
        # pytest exit 5 = "no tests collected": nothing ran, so nothing failed. A
        # repo with pytest but zero tests must not verify red. (audit 2026-06-12, F1)
        return "no_tests"
    if "No module named" in tail:
        # exit 1/2 with this tail is an ENVIRONMENT statement (system python3 in a
        # poetry/uv/pipenv/conda repo; deps not synced) — never a code verdict.
        # (stack-matrix audit 2026-06-12, F2a)
        return "missing_tool"
    if (cmd[0] in ("npx", "bunx") or cmd[1:2] == ["exec"]) and any(
            s in tail for s in ("could not determine executable", "not found")):
        # `npx --no-install tsc` exits 1 (not 127) when typescript isn't installed;
        # pnpm/yarn exec print `Command "tsc" not found`. Same env lane as 127.
        # Scoped to exec-runner argv so a real test failure that merely prints
        # "not found" stays red. (stack-matrix audit 2026-06-12, F7)
        return "missing_tool"
    return "failed"


def build_result(checks, runner, repo, porcelain=None, head=None):
    """Assemble the {pass, inconclusive, tampered, failures, checks} contract.
    `runner(cmd, cwd) -> (exit, tail)`; `porcelain(repo) -> str|None` is the
    HEAD-integrity snapshot seam and `head(repo) -> sha|None` the HEAD-identity
    seam (defaulting to git_porcelain / git_head; tests inject). Whenever the
    after head-capture succeeds, the result carries "head" — the sha this
    verdict certified — for the orchestrator to hold against the sealed sha.

    Infra-vs-findings guard for verify (mirrors the adapter): a check that could NOT
    deliver a code verdict (kind in INCONCLUSIVE_KINDS: toolchain missing, zero tests
    collected, timed out) or "no verifier detected" is `inconclusive` — it must NOT
    be reported as a code failure. Only checks that actually ran and failed are real failures.
    """
    snap = porcelain if porcelain is not None else git_porcelain
    head_fn = head if head is not None else git_head
    before = snap(repo)
    head_before = head_fn(repo)
    integrity_note = None
    if before is None:
        # Snapshot unavailable (git missing / not a git repo): degrade OPEN — a
        # non-git verify target must keep working exactly as before. The note tells
        # the reader the invariant was NOT asserted on this run.
        integrity_note = ("integrity snapshot unavailable (git missing or target is "
                          "not a git repo); HEAD-integrity not asserted")
    elif before.strip():
        # ── HEAD-integrity invariant (live smoke run-6, 2026-06-12) ─────────────
        # A gating verify certifies the COMMITTED state — every legitimate gating
        # verify already runs on a clean tree (the loop verifies post-commit
        # worktrees, the feat verifies post-merge/baseline-clean main trees) — so a
        # green over uncommitted edits certifies NOTHING. Run-6's verifier EDITED
        # the source under verification to turn red green (its cover-up commit was
        # blocked by the permission layer, leaving the fix staged: committed branch
        # red, gate reporting green). With this check the re-run sees the dirt and
        # stays red, so tampering can never produce a green — the incentive dies,
        # not just the symptom. Deliberately RED, not inconclusive: the committed
        # state is unverified and the remedy is a human look, never an auto-retry.
        result = {
            "pass": False,
            "inconclusive": False,
            "tampered": True,
            "failures": [{
                "stage": "integrity",
                "kind": "uncommitted_state",
                "log_tail": before.rstrip("\n")[:400],
            }],
            "checks": [],   # the checks never ran — nothing was verified
        }
        if head_before is not None:
            # Even a refusal NAMES the state it refused (design review 2026-06-12):
            # the orchestrator gets a head to hold against the gate's sealed sha.
            result["head"] = head_before
        return result
    if not checks:
        result = {
            "pass": False,
            "inconclusive": True,   # nothing to verify != code is broken
            "tampered": False,
            "failures": [{
                "stage": "verify",
                "reason": "no_verifier_detected",
                "kind": "missing_tool",
                "log_tail": "no recognized build/test config found; set CAMUS_VERIFY_CMD "
                            "to specify the command explicitly",
            }],
            "checks": [],
        }
        if integrity_note:
            result["integrity_note"] = integrity_note
        return result
    failures = []
    ran = []
    for chk in checks:
        exit_code, tail = runner(chk["cmd"], repo)
        ran.append({"name": chk["name"], "cmd": chk["cmd"], "exit": exit_code})
        if exit_code != 0:
            kind = _classify_failure(chk, exit_code, tail)
            if kind == "timeout" and "CAMUS_VERIFY_TIMEOUT" not in (tail or ""):
                # Preserve WHAT timed out verbatim, then name the lever. (audit F5)
                tail = ((tail + "\n") if tail else "") + \
                    "[camus] timed out — raise CAMUS_VERIFY_TIMEOUT (seconds) for cold compiled stacks"
            failures.append({"stage": chk["name"], "exit": exit_code,
                             "kind": kind, "log_tail": tail})
    tampered = False
    if before is not None:
        after = snap(repo)
        if after is None:
            integrity_note = ("integrity after-snapshot unavailable (git errored "
                              "mid-verify); HEAD-integrity not asserted")
        elif after != before:
            # The checks ran but something mutated tracked files DURING verify — a
            # test with side effects, or an agent editing the code under
            # verification (run-6). `before` was clean (dirty-before returned
            # above), so `after` IS the delta. RED for the same reason as above.
            tampered = True
            failures.append({
                "stage": "integrity",
                "kind": "tracked_mutation",
                "log_tail": after.rstrip("\n")[:400],
            })
    # ── Certified-HEAD identity (design review, 2026-06-12) ─────────────────
    # Porcelain sees EDITS, not COMMITS: edit → COMMIT → rerun leaves a clean
    # tree, a green verdict, and a review-bypassing commit. Run-6's verifier
    # edited the code under verification, and its cover-up COMMIT was blocked
    # only by the permission layer — had it landed, the porcelain snapshots
    # would have read clean. So the verdict NAMES the HEAD it certified ("head"
    # below) for the workflow to compare against the sha the commit gate /
    # merge receipt sealed — the only place a committed cover-up is visible —
    # and a HEAD that moved between the snapshots is tampering in its own
    # right: RED, never inconclusive, remedy is a human look (never a retry).
    head_after = head_fn(repo)
    if head_before is not None and head_after is not None and head_before != head_after:
        tampered = True
        failures.append({
            "stage": "integrity",
            "kind": "head_moved",
            "log_tail": "HEAD moved during verify: %s -> %s" % (head_before, head_after),
        })
    passed = len(failures) == 0
    # inconclusive when there are failures but NONE of them is a real ran-and-failed
    # check; the integrity kinds are NOT in INCONCLUSIVE_KINDS, so tampering forces a
    # real red even when every detected check was itself inconclusive.
    inconclusive = (not passed) and all(f["kind"] in INCONCLUSIVE_KINDS for f in failures)
    result = {"pass": passed, "inconclusive": inconclusive, "tampered": tampered,
              "failures": failures, "checks": ran}
    if head_after is not None:
        result["head"] = head_after
    if integrity_note:
        result["integrity_note"] = integrity_note
    return result


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    repo = argv[0] if argv else os.getcwd()
    checks = detect_checks(repo, os.environ)
    print(json.dumps(build_result(checks, run_cmd, repo)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
