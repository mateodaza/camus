#!/usr/bin/env python3
"""Camus v2-lite gate adapter.

Normalizes Codex `--output-schema` review output into the gate contract the loop
consumes, with a HARD infra-vs-findings guard, plus v1 back-compat mapping.

Pure stdlib so it runs anywhere (no pip install). Importable for tests.

Normalized gate contract:
    {
      "ran": bool,            # False => Codex did not produce a usable verdict
      "error": str | None,    # set iff ran is False
      "clean": bool,          # True => no priority<=2 findings (only meaningful if ran)
      "verdict": str,         # "APPROVED" | "REVISE" | "ERROR"
      "blocking": [ {priority,title,code_location,body,confidence_score}, ... ],
      "nonblocking": [ ... ],
      "overall_correctness": str | None
    }
"""
import argparse
import json
import os
import sys

# Findings with priority <= this block the loop. 3 (nit) does not.
BLOCKING_MAX_PRIORITY = 2

# Codex's overall verdict must be exactly one of these. Anything else = schema drift.
VALID_CORRECTNESS = ("patch is correct", "patch is incorrect")


def _infra_error(msg):
    """An infra failure is NEVER 'clean' and NEVER a normal rejection.
    Callers must branch on ran==False (retry/backoff), not feed it to the fix loop."""
    return {
        "ran": False,
        "error": msg,
        "clean": False,
        "verdict": "ERROR",
        "blocking": [],
        "nonblocking": [],
        "overall_correctness": None,
    }


def normalize_codex(raw, exit_code):
    """Map raw Codex output -> normalized gate contract.

    Trust nothing ambiguous: any infra failure OR schema drift OR self-contradiction
    returns ran:false (an error to retry/escalate), NEVER a silent clean approval.
    """
    if exit_code != 0:
        return _infra_error("codex exec exited %d" % exit_code)
    if raw is None or str(raw).strip() == "":
        return _infra_error("empty codex output")
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        return _infra_error("unparseable codex output: %s" % exc)
    if not isinstance(data, dict):
        return _infra_error("codex output is not a JSON object")

    # Schema guard: the overall verdict must be a known enum value.
    correctness = data.get("overall_correctness")
    if correctness not in VALID_CORRECTNESS:
        return _infra_error("missing/invalid overall_correctness: %r" % (correctness,))

    findings = data.get("findings")
    if not isinstance(findings, list):
        return _infra_error("missing findings[] in codex output")

    blocking, nonblocking = [], []
    for f in findings:
        if not isinstance(f, dict):
            return _infra_error("malformed finding (not an object)")
        priority = f.get("priority")
        # Schema guard (P1): a missing/drifted/out-of-range priority must NOT be
        # silently demoted to a nit — that would let a renamed field approve a bad
        # patch. A bad priority means we can't trust the verdict -> infra/schema error.
        # (bool is an int subclass in Python; exclude it explicitly.)
        if isinstance(priority, bool) or not isinstance(priority, int) or not (0 <= priority <= 3):
            return _infra_error("finding has missing/out-of-range priority: %r" % (priority,))
        item = {
            "priority": priority,
            "title": f.get("title", ""),
            "code_location": f.get("code_location", ""),
            "body": f.get("body", ""),
            "confidence_score": f.get("confidence_score"),
        }
        if priority <= BLOCKING_MAX_PRIORITY:
            blocking.append(item)
        else:
            nonblocking.append(item)

    # Consistency guard (P1): Codex declared the patch incorrect but gave nothing
    # actionable. Do not ship and do not call it clean -> treat as untrustworthy.
    if correctness == "patch is incorrect" and not blocking:
        return _infra_error("inconsistent: 'patch is incorrect' with no blocking findings")

    # Blocking findings are authoritative: even if Codex said "correct", any P0/P1/P2
    # forces REVISE (findings win, so we never ship over a flagged issue).
    clean = len(blocking) == 0
    return {
        "ran": True,
        "error": None,
        "clean": clean,
        "verdict": "APPROVED" if clean else "REVISE",
        "blocking": blocking,
        "nonblocking": nonblocking,
        "overall_correctness": correctness,
    }


def to_v1(normalized):
    """Back-compat: normalized gate -> v1 contract.

    v1's field is `verdict` (APPROVED/REJECTED) with `blocking_issues` as OBJECTS
    {reference, current_state, required_change, severity} (see scripts/call_codex.py).
    Infra errors map to verdict ERROR so v1 callers branch instead of mis-reading.
    """
    if not normalized.get("ran", False):
        return {"verdict": "ERROR", "blocking_issues": [], "error": normalized.get("error")}
    return {
        "verdict": "APPROVED" if normalized["clean"] else "REJECTED",
        "blocking_issues": [
            {
                "reference": b.get("code_location", ""),
                "current_state": b.get("body", ""),
                "required_change": b.get("title", ""),
                "severity": b.get("priority"),
            }
            for b in normalized["blocking"]
        ],
    }


# v1 blocking-issue severity -> 0-3 priority. Default P1 when unknown.
_V1_SEVERITY = {"critical": 0, "p0": 0, "high": 1, "p1": 1,
                "medium": 2, "p2": 2, "low": 3, "p3": 3, "nit": 3}


def _v1_severity_to_priority(sev):
    if isinstance(sev, bool):
        return 1
    if isinstance(sev, int) and 0 <= sev <= 3:
        return sev
    if isinstance(sev, str):
        return _V1_SEVERITY.get(sev.strip().lower(), 1)
    return 1


def _v1_issue_to_finding(issue):
    if isinstance(issue, dict):
        title = (issue.get("required_change") or issue.get("reference")
                 or issue.get("current_state") or "v1 blocking issue")
        return {
            "priority": _v1_severity_to_priority(issue.get("severity")),
            "title": title,
            "code_location": issue.get("reference", ""),
            "body": issue.get("current_state", ""),
            "confidence_score": None,
        }
    return {"priority": 1, "title": str(issue), "code_location": "",
            "body": "", "confidence_score": None}


def from_v1(v1):
    """Migration helper: lift a v1 result into the normalized contract.

    Reads `verdict` (with `status` accepted as a fallback). Mirrors v1's coercion:
    REJECTED with empty blocking_issues is a vague rejection -> treated as APPROVED.
    Any non-decisive verdict (UNCLEAR/UNCERTAIN/unknown) is untrustworthy -> error,
    so it can never silently ship.
    """
    verdict = str(v1.get("verdict") or v1.get("status") or "").upper()
    if verdict == "ERROR":
        return _infra_error(v1.get("error") or "v1 error")
    issues = v1.get("blocking_issues") or []

    if verdict == "APPROVED" or (verdict == "REJECTED" and not issues):
        clean, blocking = True, []
    elif verdict == "REJECTED":
        clean, blocking = False, [_v1_issue_to_finding(it) for it in issues]
    else:
        return _infra_error("v1 verdict not trustable: %r" % (verdict,))

    return {
        "ran": True,
        "error": None,
        "clean": clean,
        "verdict": "APPROVED" if clean else "REVISE",
        "blocking": blocking,
        "nonblocking": [],
        "overall_correctness": None,
    }


def verify_result(typecheck_exit, test_exit, tc_text="", test_text="", tail_lines=20):
    """Deterministic verification gate result from type-check + test exit codes."""
    failures = []
    if typecheck_exit != 0:
        failures.append({"stage": "type-check", "exit": typecheck_exit,
                         "log_tail": _tail(tc_text, tail_lines)})
    if test_exit != 0:
        failures.append({"stage": "test", "exit": test_exit,
                         "log_tail": _tail(test_text, tail_lines)})
    return {"pass": len(failures) == 0, "failures": failures}


def _tail(text, n):
    if not text:
        return ""
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def _read_file(path):
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    return ""


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camus v2-lite gate adapter")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_codex = sub.add_parser("from-codex", help="normalize codex stdout -> gate JSON")
    p_codex.add_argument("--exit", dest="exit_code", type=int, default=0)

    sub.add_parser("to-v1", help="normalized gate JSON (stdin) -> v1 contract")
    sub.add_parser("from-v1", help="v1 contract (stdin) -> normalized gate JSON")

    p_verify = sub.add_parser("verify", help="emit verification gate JSON")
    p_verify.add_argument("--typecheck-exit", type=int, required=True)
    p_verify.add_argument("--test-exit", type=int, required=True)
    p_verify.add_argument("--tc-log", default="")
    p_verify.add_argument("--test-log", default="")

    args = parser.parse_args(argv)

    if args.cmd == "from-codex":
        print(json.dumps(normalize_codex(sys.stdin.read(), args.exit_code)))
    elif args.cmd == "to-v1":
        print(json.dumps(to_v1(json.loads(sys.stdin.read()))))
    elif args.cmd == "from-v1":
        print(json.dumps(from_v1(json.loads(sys.stdin.read()))))
    elif args.cmd == "verify":
        tc = _read_file(args.tc_log)
        tt = _read_file(args.test_log)
        print(json.dumps(verify_result(args.typecheck_exit, args.test_exit, tc, tt)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
