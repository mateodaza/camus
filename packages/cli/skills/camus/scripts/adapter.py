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
import re
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
    demoted = 0
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
        if priority <= BLOCKING_MAX_PRIORITY and is_pipeline_stage_only(item):
            # Recorded, visible, and explicitly not a gate: the reviewer described the pipeline,
            # not the code. Flagged so the receipt says why it stopped blocking.
            item["demoted"] = "pipeline_stage_not_a_finding"
            demoted += 1
            nonblocking.append(item)
        elif priority <= BLOCKING_MAX_PRIORITY:
            blocking.append(item)
        else:
            nonblocking.append(item)

    # Consistency guard (P1): Codex declared the patch incorrect but gave nothing
    # actionable. Do not ship and do not call it clean -> treat as untrustworthy.
    # A DEMOTED finding is accounted for, not missing: the reviewer did say what it thought was
    # wrong, it was just a description of the pipeline rather than of the code. Firing the guard
    # there would burn the round on an infra retry and hide why, so an "incorrect" verdict whose
    # every blocking finding was pipeline noise reads as clean — with the demotions on the record.
    if correctness == "patch is incorrect" and not blocking and not demoted:
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


# ── THE REVIEWER'S POSITION IN THE PIPELINE ──────────────────────────────────────────────
# Review runs on the WORKING-TREE DELTA, before Camus commits, parks and verifies it. So "this is
# not committed yet", "HEAD has not advanced" and "verification has not run yet" describe the
# pipeline working as designed, not defects in the change. Live run 20260806-164809-hiju round 2
# raised exactly those and, being P<=2, they blocked — costing an unnecessary final bounded fix on
# code nothing was wrong with.
#
# Such a finding is DEMOTED to nonblocking, never dropped: it stays in the receipt, visible, and it
# simply does not gate. Precision matters more than recall here — a false demotion would hide a real
# defect — so a finding is only demoted when it names a pipeline stage AND says nothing that could
# be about a genuine scope problem. "This commit also refactors an unrelated module" keeps blocking.
_PIPELINE_ONLY = re.compile(
    r"(?:"
    r"not (?:yet )?(?:been )?committed"
    r"|no commit (?:has been|was) (?:made|created)"
    r"|needs? to be committed|should be committed|must be committed"
    r"|uncommitted (?:change|work|state|delta)"
    r"|HEAD (?:has )?(?:not|n't) (?:advanced|moved|changed)"
    r"|HEAD (?:is|remains) (?:un|not )changed"
    r"|verification (?:has )?(?:not|n't) (?:been )?(?:run|executed)"
    r"|(?:tests?|verify) (?:has|have)(?: not|n't) (?:been )?run(?: yet)?"
    r"|not (?:yet )?verified"
    r"|no (?:parked )?candidate (?:exists|was created)"
    r")", re.I)
# Anything here means the finding is making a claim ABOUT THE CHANGE'S CONTENT, so it is a real
# review finding even if it also mentions committing. Off-scope commits must keep blocking.
_REAL_SCOPE = re.compile(
    r"(?:"
    r"unrelated|off[- ]scope|out of scope|outside the (?:task|scope)"
    r"|beyond the (?:task|scope)|not part of (?:the|this) task"
    r"|\bsecret|\bcredential|\bpassword|\btoken\b"
    r"|generated file|build artifact|lock ?file|vendored"
    r"|\b[0-9a-f]{7,40}\b"                     # a concrete commit sha
    r")", re.I)


def _sentences(text):
    """Split into substantive clauses. Sentence-level is the unit that matters: a finding is only
    pipeline noise if EVERY clause is pipeline noise."""
    parts = re.split(r"[.;!?\n]+", text)
    return [p.strip() for p in parts if len(p.strip()) >= 3]


# Any of this means the finding makes a claim about the CODE's behaviour, so it is a real review
# finding no matter what else it says about commits or tests. Kept broad on purpose: the cost of a
# false demotion (a defect approved) is far higher than the cost of a finding that keeps blocking.
_DEFECT = re.compile(
    r"(?:"
    r"crash|throw|throws|thrown|exception|panic|segfault|abort"
    r"|null (?:deref|pointer|reference)|deref|nil deref|undefined behaviou?r"
    r"|data ?loss|corrupt|overwrite|clobber|truncat"
    r"|race|deadlock|dead ?lock|livelock|leak|starv"
    r"|security|vulnerab|inject|xss|csrf|traversal|overflow|underflow|privileg"
    r"|incorrect|wrong|invalid|broken|breaks?\b|regress"
    r"|missing (?:guard|check|validation|handling|null|bounds|error)"
    r"|unhandled|unchecked|off[- ]by[- ]one|out of bounds|infinite loop"
    r"|fails? (?:when|if|for|on)|returns? (?:the )?wrong|does not (?:handle|validate|guard|check)"
    r"|silently (?:ignore|swallow|drop)|swallow(?:s|ed)? the (?:error|exception)"
    r")", re.I)


def is_pipeline_stage_only(finding):
    """True only when a finding's ENTIRE substance is "Camus has not committed/verified this yet".

    FAIL-CLOSED, on three independent counts, because a false demotion approves a real defect:
      1. EVERY clause must itself be a pipeline complaint. An unrecognised clause blocks — the
         default is to keep the finding, never to drop it.
      2. No defect language anywhere. A clause can carry both ("returns null and crashes, and it
         has not been committed"), so sentence-splitting alone is not enough.
      3. No genuine-scope language anywhere (off-scope work, secrets, a concrete sha).

    The bug this replaces searched for a pipeline phrase ANYWHERE and demoted on a hit, so
    "Null dereference crashes enemy spawning / ... Tests have not been run yet." was approved.
    """
    title = str(finding.get("title") or "")
    body = str(finding.get("body") or "")
    text = title + ". " + body
    if _REAL_SCOPE.search(text):
        return False
    if _DEFECT.search(text):
        return False
    clauses = _sentences(text)
    if not clauses:
        return False
    return all(_PIPELINE_ONLY.search(c) for c in clauses)


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
