#!/usr/bin/env python3
"""`camus canary` — opt-in known-answer self-test of the local toolchain.

Proves the gate's two load-bearing contracts actually hold against a THROWAWAY repo,
so a user (or the release flow) can answer "is my local gate working end-to-end?"
without a real project and without trusting a green it never reproduced:

  RED   — a repo whose `npm test` fails (a one-line node assertion that exits 1) must
          verify pass:false WITH a NAMED ran-and-failed check (not inconclusive). If
          verify.py can't even tell a broken build from a working one, nothing it says
          downstream is trustworthy.
  GREEN — fix the assertion, COMMIT it, and the same verify must read pass:true AND
          name the exact HEAD it certified (result["head"] == `git rev-parse HEAD`).
          This is the head-binding contract the orchestrator leans on to catch an
          edit→commit→rerun cover-up; canary proves it round-trips.
  REVIEW (optional, --review, OFF by default) — stage a 1-line diff and run the codex
          reviewer on the worktree at the cheapest scope/effort, requiring a normalized
          verdict that carries the contract keys (ran/clean/verdict/blocking/
          nonblocking). Costs ONE small codex call; everything before it is free + local.

Stages run RED → GREEN → (review) and SHORT-CIRCUIT on the first break: exit 0 only when
every stage holds, else print the first broken stage with its evidence and exit 1.

Throwaway repo discipline:
  - Built under $TMPDIR via tempfile.mkdtemp, torn down in a try/FINALLY with
    shutil.rmtree(ignore_errors=True) on EVERY path (success, failure, early return,
    exception) — including the --review intent-to-add side effects, which the whole-tree
    nuke erases implicitly.
  - Names satisfy the _guard.sh egress shape (the guard gates codex_review.sh and any
    commit.sh-style egress in `worktree` mode: a `camus/*` branch in a coherent
    `camus-wt-<branch-last-segment>` dir): branch `camus/canary` checked out in a dir
    named `camus-wt-canary` (== camus-wt-<branch-last-segment>, the name the task requires).
  - Local git identity via `-c user.email=… -c user.name=…`; commits are hookless +
    unsigned with commit.sh's exact flags (inline, not a shell-out to commit.sh — the
    guard would reject a $TMPDIR repo that isn't the caller's CAMUS_REPO_ROOT).

Pure stdlib. verify.py is driven by MODULE IMPORT (deterministic, no CAMUS_VERIFY_CMD
coupling — the same way test_verify.py exercises it). The reviewer script path is read
from CAMUS_CANARY_REVIEWER (default: the sibling codex_review.sh) so tests inject a fake
reviewer and no real codex call happens under test.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import verify

BRANCH = "camus/canary"               # camus/* branch (the egress guard's worktree mode)
WORKTREE_DIRNAME = "camus-wt-canary"  # == camus-wt-<branch last segment>: passes _guard.sh
GIT_EMAIL = "canary@camus.test"
GIT_NAME = "camus-canary"

# commit.sh's gate-owned mutation flags, inline (the guard refuses a shell-out to
# commit.sh on a $TMPDIR repo; the contract under test is verify's, not commit.sh's).
GATE_GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"]

PKG_RED = '{\n  "name": "camus-canary",\n  "scripts": {\n    "test": "node -e \\"process.exit(1)\\""\n  }\n}\n'
PKG_GREEN = '{\n  "name": "camus-canary",\n  "scripts": {\n    "test": "node -e \\"process.exit(0)\\""\n  }\n}\n'

# Keys every normalized reviewer verdict must carry (adapter.py's gate contract).
REVIEW_CONTRACT_KEYS = ("ran", "clean", "verdict", "blocking", "nonblocking")


class StageError(Exception):
    """A stage's contract did not hold. Carries the stage name + its evidence dict."""

    def __init__(self, stage, evidence):
        super().__init__("%s stage failed" % stage)
        self.stage = stage
        self.evidence = evidence


def _git(repo, *args, gate=False):
    """Run a git command in `repo`; raise on nonzero (these are setup steps, not the
    contract under test). `gate=True` prepends commit.sh's hookless/unsigned flags."""
    base = list(GATE_GIT) if gate else ["git"]
    proc = subprocess.run(base + ["-C", repo] + list(args),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if proc.returncode != 0:
        raise RuntimeError("git %s failed (%d): %s"
                           % (" ".join(args), proc.returncode, proc.stdout.strip()))
    return proc.stdout.strip()


def _write(repo, rel, contents):
    with open(os.path.join(repo, rel), "w", encoding="utf-8") as fh:
        fh.write(contents)


def build_repo(parent):
    """Make the throwaway repo under `parent`: a `camus/canary` branch checked out
    in a `camus-wt-canary` dir with a local identity and a RED package.json committed."""
    repo = os.path.join(parent, WORKTREE_DIRNAME)
    os.makedirs(repo)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", GIT_EMAIL)
    _git(repo, "config", "user.name", GIT_NAME)
    _git(repo, "config", "commit.gpgsign", "false")
    _git(repo, "checkout", "-q", "-b", BRANCH)
    # Commit the RED package.json so the tree is CLEAN against HEAD — verify.py's
    # HEAD-integrity invariant treats a dirty tree as RED tampering, which would mask
    # the real RED-stage signal we are trying to observe.
    _write(repo, "package.json", PKG_RED)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--no-verify", "-m", "canary: red baseline", gate=True)
    return repo


def _verify(repo):
    """Drive verify.py by module import (deterministic): detect + assemble the contract."""
    checks = verify.detect_checks(repo, {})
    return verify.build_result(checks, verify.run_cmd, repo)


def stage_red(repo):
    """REQUIRE the RED repo verifies pass:false with a NAMED ran-and-failed check."""
    result = _verify(repo)
    failures = result.get("failures") or []
    named = [f for f in failures if f.get("kind") == "failed" and f.get("stage")]
    ok = (result.get("pass") is False
          and result.get("inconclusive") is False
          and bool(named))
    if not ok:
        raise StageError("red", {
            "expected": "pass:false with a named ran-and-failed check (kind=failed)",
            "result": result,
        })
    return {"pass": False, "named_failure": named[0]["stage"], "result": result}


def stage_green(repo):
    """Fix the assertion, COMMIT, REQUIRE pass:true AND result.head == rev-parse HEAD."""
    _write(repo, "package.json", PKG_GREEN)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--no-verify", "-m", "canary: green fix", gate=True)
    head = _git(repo, "rev-parse", "HEAD")
    result = _verify(repo)
    ok = (result.get("pass") is True
          and result.get("head") == head)
    if not ok:
        raise StageError("green", {
            "expected": "pass:true AND head-bound to %s" % head,
            "head": head,
            "result": result,
        })
    return {"pass": True, "head": head, "result": result}


def _reviewer_path():
    """The reviewer script: CAMUS_CANARY_REVIEWER override (test seam) else the sibling
    codex_review.sh next to this file."""
    override = os.environ.get("CAMUS_CANARY_REVIEWER")
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex_review.sh")


def stage_review(repo):
    """Stage a 1-line diff and run the reviewer at the cheapest scope/effort; REQUIRE a
    normalized JSON verdict carrying the contract keys. Costs one small codex call (or a
    stub under test). The guard inside codex_review.sh passes because the repo is a
    camus/canary branch in a camus-wt-canary dir — and because $PWD must agree with
    CAMUS_REPO_ROOT when set, we anchor the trust root at the throwaway repo itself."""
    _write(repo, "CANARY.md", "canary review probe\n")
    _git(repo, "add", "-N", "CANARY.md")   # intent-to-add: the 1-line diff is visible
    reviewer = _reviewer_path()
    if not os.path.exists(reviewer):
        raise StageError("review", {"expected": "reviewer script exists",
                                     "reviewer": reviewer})
    env = dict(os.environ)
    # The guard anchors trust on CAMUS_REPO_ROOT and demands $PWD share its repo; point
    # both at the throwaway worktree so the self-test exercises the real egress path.
    env["CAMUS_REPO_ROOT"] = repo
    # Redirect the reviewer's audit/watch artifacts INTO the throwaway tree. Left at its
    # default ($HOME/.camus/reviews) the reviewer writes/overwrites real review history
    # (camus-wt-canary-r0.json / .watch) that survives our temp-parent teardown. Put it in
    # the temp parent (sibling to the worktree, NOT inside it — keeps the reviewed tree
    # clean) so the whole-tree rmtree in run() erases it like everything else.
    env["CAMUS_REVIEW_DIR"] = os.path.join(os.path.dirname(repo), "reviews")
    # cheapest knobs: medium effort (the cheap first pass), light scope (judge the diff).
    proc = subprocess.run([reviewer, repo, "canary self-test diff", "0", "medium", "light"],
                          cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, env=env)
    raw = proc.stdout.strip()
    try:
        verdict = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise StageError("review", {"expected": "reviewer emitted JSON",
                                     "error": str(exc), "raw": raw[:400]})
    missing = [k for k in REVIEW_CONTRACT_KEYS if k not in verdict]
    if missing or not isinstance(verdict, dict):
        raise StageError("review", {
            "expected": "verdict carries the contract keys %s" % (REVIEW_CONTRACT_KEYS,),
            "missing": missing,
            "verdict": verdict,
        })
    # ran is False => Codex did not produce a usable verdict (adapter contract). An infra
    # result like {"ran": false, "verdict": "ERROR", ...} carries every key but means the
    # reviewer never actually ran — the path this self-test exists to validate. Fail closed.
    if verdict.get("ran") is not True:
        raise StageError("review", {
            "expected": "reviewer ran (ran:true); ran:false is an infra failure, not a pass",
            "verdict": verdict,
        })
    return {"contract_keys_present": True, "ran": verdict.get("ran"),
            "verdict": verdict.get("verdict")}


def run(review=False):
    """Run the stages in order, tearing the throwaway repo down on EVERY path. Returns
    (ok, report). report["failed_stage"] names the first break with its evidence."""
    parent = tempfile.mkdtemp(prefix="camus_canary_")
    report = {"stages": []}
    current = "setup"  # the stage in flight; an unexpected raise is attributed HERE
    try:
        repo = build_repo(parent)
        stages = [("red", stage_red), ("green", stage_green)]
        if review:
            stages.append(("review", stage_review))
        for name, fn in stages:
            current = name
            outcome = fn(repo)
            report["stages"].append({"stage": name, "ok": True, "detail": outcome})
        report["ok"] = True
        return True, report
    except StageError as exc:
        report["stages"].append({"stage": exc.stage, "ok": False, "evidence": exc.evidence})
        report["ok"] = False
        report["failed_stage"] = exc.stage
        return False, report
    except Exception as exc:  # an unexpected raise: blame the stage in flight, not "setup"
        # A non-StageError from inside a stage (e.g. a non-executable reviewer raising
        # PermissionError in `review`) is that stage breaking, not a setup failure; only a
        # raise before/within build_repo stays "setup". `current` tracks where we are.
        report["stages"].append({"stage": current, "ok": False,
                                 "evidence": {"error": repr(exc)}})
        report["ok"] = False
        report["failed_stage"] = current
        return False, report
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="camus canary",
        description="Known-answer self-test of the local gate toolchain "
                    "(RED -> GREEN [-> review]).")
    parser.add_argument("--review", action="store_true",
                        help="also exercise the codex reviewer on a 1-line diff "
                             "(OFF by default; costs one small codex call)")
    args = parser.parse_args(argv)

    ok, report = run(review=args.review)
    if ok:
        names = " -> ".join(s["stage"] for s in report["stages"])
        print("camus canary: PASS (%s)" % names)
        print(json.dumps(report))
        return 0
    broken = report.get("failed_stage", "unknown")
    evidence = next((s.get("evidence") for s in report["stages"]
                     if s.get("stage") == broken and not s.get("ok")), {})
    print("camus canary: FAIL at the '%s' stage" % broken, file=sys.stderr)
    print(json.dumps({"failed_stage": broken, "evidence": evidence}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
