"""Contract tests for the Camus v2-lite gate adapter.

Runs with NO third-party deps:
    python3 test_adapter.py        # stdlib runner (see bottom)
    python3 -m pytest -q           # also works if pytest is installed

Covers severity gating, the infra-vs-findings guard, schema-drift / consistency
guards (the two P1 holes the cross-vendor review caught), v1 back-compat, and the
deterministic verify result.
"""
import json
import adapter


def _codex(findings, correctness="patch is correct"):
    return json.dumps({
        "overall_correctness": correctness,
        "overall_confidence_score": 0.9,
        "findings": findings,
    })


def _finding(priority, title="x"):
    return {"priority": priority, "title": title, "body": "b",
            "code_location": "f.ts:1", "confidence_score": 0.8}


# --- severity gating -------------------------------------------------------

def test_clean_patch_no_findings():
    n = adapter.normalize_codex(_codex([]), 0)
    assert n["ran"] is True
    assert n["clean"] is True
    assert n["verdict"] == "APPROVED"
    assert n["blocking"] == [] and n["nonblocking"] == []


def test_p0_blocks():
    n = adapter.normalize_codex(_codex([_finding(0)], "patch is incorrect"), 0)
    assert n["clean"] is False
    assert n["verdict"] == "REVISE"
    assert len(n["blocking"]) == 1


def test_p2_blocks_boundary():
    n = adapter.normalize_codex(_codex([_finding(2)], "patch is incorrect"), 0)
    assert n["clean"] is False
    assert len(n["blocking"]) == 1


def test_p3_nit_does_not_block():
    n = adapter.normalize_codex(_codex([_finding(3)]), 0)
    assert n["clean"] is True
    assert n["verdict"] == "APPROVED"
    assert n["blocking"] == [] and len(n["nonblocking"]) == 1


def test_mixed_p1_and_p3():
    n = adapter.normalize_codex(
        _codex([_finding(1, "real"), _finding(3, "nit")], "patch is incorrect"), 0)
    assert n["clean"] is False
    assert [b["title"] for b in n["blocking"]] == ["real"]
    assert [b["title"] for b in n["nonblocking"]] == ["nit"]


# --- infra-vs-findings guard (the #1 runaway cause) ------------------------

def test_infra_guard_nonzero_exit():
    n = adapter.normalize_codex(_codex([]), 1)
    assert n["ran"] is False
    assert n["clean"] is False           # must NOT be read as a pass
    assert n["verdict"] == "ERROR"
    assert n["error"]


def test_infra_guard_empty_output():
    n = adapter.normalize_codex("", 0)
    assert n["ran"] is False and n["clean"] is False


def test_infra_guard_malformed_json():
    n = adapter.normalize_codex("{not json", 0)
    assert n["ran"] is False and n["clean"] is False
    assert "unparseable" in n["error"]


def test_infra_guard_missing_findings_key():
    n = adapter.normalize_codex(
        json.dumps({"overall_correctness": "patch is correct"}), 0)
    assert n["ran"] is False and n["clean"] is False


def test_infra_error_is_neither_clean_nor_normal_rejection():
    n = adapter.normalize_codex("", 0)
    # A rejection has ran:True + clean:False; an infra error has ran:False.
    # These must be distinguishable so the loop retries instead of "fixing" nothing.
    assert n["ran"] is False
    assert n["verdict"] == "ERROR"


# --- P1 schema-drift guard: a bad/renamed priority must NOT silently approve

def test_drifted_priority_key_is_schema_error():
    # finding uses `severity` instead of `priority` -> priority missing
    bad = {"severity": 2, "title": "x", "body": "b",
           "code_location": "f.ts:1", "confidence_score": 0.8}
    n = adapter.normalize_codex(_codex([bad], "patch is incorrect"), 0)
    assert n["ran"] is False and n["clean"] is False
    assert "priority" in n["error"]


def test_out_of_range_priority_is_schema_error():
    n = adapter.normalize_codex(_codex([_finding(5)], "patch is incorrect"), 0)
    assert n["ran"] is False and n["clean"] is False


def test_bool_priority_is_schema_error():
    # bool is an int subclass in Python; True must not pass as priority 1
    n = adapter.normalize_codex(_codex([_finding(True)], "patch is incorrect"), 0)
    assert n["ran"] is False and n["clean"] is False


def test_missing_correctness_is_schema_error():
    raw = json.dumps({"overall_confidence_score": 0.9, "findings": []})
    n = adapter.normalize_codex(raw, 0)
    assert n["ran"] is False and n["clean"] is False


# --- P1 consistency guard: "incorrect" with no findings must not ship ------

def test_incorrect_with_empty_findings_is_error():
    n = adapter.normalize_codex(_codex([], "patch is incorrect"), 0)
    assert n["ran"] is False
    assert n["clean"] is False
    assert "inconsistent" in n["error"]


def test_blocking_findings_win_over_correct_overall():
    # Codex said "correct" but emitted a P0 -> findings win, do not ship.
    n = adapter.normalize_codex(_codex([_finding(0)], "patch is correct"), 0)
    assert n["ran"] is True
    assert n["clean"] is False
    assert n["verdict"] == "REVISE"


# --- v1 back-compat (real v1 contract: `verdict` + object blocking_issues) -

def test_to_v1_uses_verdict_field_not_status():
    n = adapter.normalize_codex(_codex([]), 0)
    v1 = adapter.to_v1(n)
    assert v1["verdict"] == "APPROVED"      # field is `verdict`, matching scripts/call_codex.py
    assert "status" not in v1
    assert v1["blocking_issues"] == []


def test_to_v1_rejected_emits_object_issues():
    n = adapter.normalize_codex(
        _codex([_finding(0, "boom"), _finding(2, "edge")], "patch is incorrect"), 0)
    v1 = adapter.to_v1(n)
    assert v1["verdict"] == "REJECTED"
    # v1 blocking_issues are objects, not bare strings
    assert [i["required_change"] for i in v1["blocking_issues"]] == ["boom", "edge"]
    assert all("severity" in i for i in v1["blocking_issues"])


def test_to_v1_error_branch():
    n = adapter.normalize_codex("", 0)
    v1 = adapter.to_v1(n)
    assert v1["verdict"] == "ERROR"
    assert v1["error"]


def test_from_v1_reads_verdict_field_regression():
    # The P1 the dogfood caught: a real v1 approval keyed on `verdict` must
    # normalize to clean/APPROVED, NOT a contentless REVISE.
    n = adapter.from_v1({"verdict": "APPROVED", "blocking_issues": []})
    assert n["ran"] is True and n["clean"] is True and n["verdict"] == "APPROVED"


def test_from_v1_roundtrip_rejected_strings():
    v1 = {"verdict": "REJECTED", "blocking_issues": ["a", "b"]}
    n = adapter.from_v1(v1)
    assert n["ran"] is True and n["clean"] is False
    assert len(n["blocking"]) == 2
    assert [i["required_change"] for i in adapter.to_v1(n)["blocking_issues"]] == ["a", "b"]


def test_from_v1_object_shaped_issue_maps_severity():
    v1 = {"verdict": "REJECTED", "blocking_issues": [
        {"reference": "f.ts:10", "current_state": "no guard",
         "required_change": "add null check", "severity": "high"}]}
    n = adapter.from_v1(v1)
    assert n["clean"] is False
    b = n["blocking"][0]
    assert b["priority"] == 1 and b["title"] == "add null check" and b["code_location"] == "f.ts:10"


def test_from_v1_empty_reject_coerced_to_approved():
    # v1 coercion rule: REJECTED with no concrete blocking_issues -> APPROVED
    n = adapter.from_v1({"verdict": "REJECTED", "blocking_issues": []})
    assert n["clean"] is True and n["verdict"] == "APPROVED"


def test_from_v1_unclear_is_untrustworthy_error():
    n = adapter.from_v1({"verdict": "UNCLEAR"})
    assert n["ran"] is False and n["clean"] is False


def test_from_v1_status_fallback_still_works():
    # Tolerate a caller that passes the older `status` key.
    n = adapter.from_v1({"status": "APPROVED", "blocking_issues": []})
    assert n["clean"] is True


# --- deterministic verify gate ---------------------------------------------

def test_verify_pass():
    r = adapter.verify_result(0, 0)
    assert r["pass"] is True and r["failures"] == []


def test_verify_typecheck_fail_only():
    r = adapter.verify_result(2, 0, tc_text="TS2304: cannot find name 'foo'")
    assert r["pass"] is False
    assert len(r["failures"]) == 1
    assert r["failures"][0]["stage"] == "type-check"
    assert "TS2304" in r["failures"][0]["log_tail"]


def test_verify_both_fail():
    r = adapter.verify_result(1, 1, tc_text="tc", test_text="t")
    assert r["pass"] is False
    assert {f["stage"] for f in r["failures"]} == {"type-check", "test"}


# --- stdlib runner (no pytest required) ------------------------------------

# --- the reviewer reviews a working-tree delta, not the pipeline ------------
# Live run 20260806-164809-hiju, round 2 demanded a commit, a HEAD move and a verification run. All
# three were P<=2, so they blocked, and a final bounded fix ran against code nothing was wrong with.
# They must be recorded and must not gate — while a GENUINE off-scope commit still blocks.

def _pf(priority, title, body):
    return {"priority": priority, "title": title, "body": body,
            "code_location": "EnemyBody.cs:42", "confidence_score": 0.9}


def test_pipeline_stage_findings_do_not_block():
    n = adapter.normalize_codex(_codex([
        _pf(1, "Change has not been committed",
            "The working-tree delta has not yet been committed, so HEAD has not advanced."),
        _pf(2, "Verification has not run",
            "The tests have not been run yet, so the change is unverified."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is True, n
    assert n["verdict"] == "APPROVED"
    # Recorded, not hidden — with the reason they stopped blocking.
    assert len(n["nonblocking"]) == 2
    assert all(f["demoted"] == "pipeline_stage_not_a_finding" for f in n["nonblocking"])
    assert n["nonblocking"][0]["title"] == "Change has not been committed"
    assert n["blocking"] == []


def test_defect_mentioning_tests_still_blocks():
    """THE FALSE GREEN. The first demotion searched for a pipeline phrase ANYWHERE, so a real crash
    finding that happened to end with "Tests have not been run yet" was demoted and APPROVED.
    Reproduced verbatim from the audit."""
    n = adapter.normalize_codex(_codex([
        _pf(1, "Null dereference crashes enemy spawning",
            "The new lookup returns null and is dereferenced, crashing when the key is absent. "
            "Tests have not been run yet."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n
    assert n["verdict"] == "REVISE"
    assert len(n["blocking"]) == 1
    assert n["blocking"][0]["title"] == "Null dereference crashes enemy spawning"
    assert "demoted" not in n["blocking"][0]
    assert n["nonblocking"] == []


def test_defect_and_pipeline_in_ONE_sentence_still_blocks():
    """Sentence-splitting alone is not enough: a single clause can carry both."""
    n = adapter.normalize_codex(_codex([
        _pf(1, "Spawn lookup", "The lookup returns null and crashes, and it has not been committed yet."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n
    assert len(n["blocking"]) == 1


def test_pipeline_plus_an_unrecognised_clause_blocks():
    """Fail-closed by default: a clause the pipeline pattern does not recognise keeps the finding."""
    n = adapter.normalize_codex(_codex([
        _pf(2, "Not committed",
            "The delta has not been committed. The retry interval should probably be configurable."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n
    assert len(n["blocking"]) == 1


def test_defect_vocabulary_survives_pipeline_framing():
    """Each of these is a real claim about the code, phrased around commits/tests."""
    for body in (
        "A race between spawn and despawn corrupts the list; none of this is committed yet.",
        "The token is logged in plaintext, but verification has not run yet.",
        "This silently swallows the error. HEAD has not advanced.",
        "Out of bounds access when the array is empty; tests have not been run.",
    ):
        n = adapter.normalize_codex(_codex([_pf(1, "Finding", body)], "patch is incorrect"), 0)
        assert n["clean"] is False, body
        assert len(n["blocking"]) == 1, body


def test_offscope_commit_still_blocks():
    n = adapter.normalize_codex(_codex([
        _pf(1, "Delta includes an unrelated refactor",
            "Beyond the task, this rewrites Inventory.cs, which the task did not ask for; "
            "it is not committed yet either."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n
    assert len(n["blocking"]) == 1
    assert "demoted" not in n["blocking"][0]


def test_secret_in_delta_still_blocks():
    n = adapter.normalize_codex(_codex([
        _pf(0, "Credential in the delta",
            "An API token is present in the uncommitted change; it must not be committed."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n


def test_real_bug_still_blocks():
    n = adapter.normalize_codex(_codex([
        _pf(1, "Null dereference on spawn failure",
            "When Spawn returns null the next line dereferences it before the caller can recover."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False, n
    assert len(n["blocking"]) == 1


def test_mixed_review_blocks_on_the_real_finding():
    n = adapter.normalize_codex(_codex([
        _pf(1, "Null dereference on spawn failure",
            "Spawn can return null and the next line dereferences it."),
        _pf(1, "Not committed yet",
            "The delta has not been committed and HEAD has not advanced."),
    ], "patch is incorrect"), 0)
    assert n["clean"] is False
    assert len(n["blocking"]) == 1
    assert n["blocking"][0]["title"] == "Null dereference on spawn failure"
    assert len(n["nonblocking"]) == 1
    assert n["nonblocking"][0]["demoted"] == "pipeline_stage_not_a_finding"


def test_pipeline_demotion_keeps_the_consistency_guard_honest():
    # "patch is incorrect" with ONLY pipeline noise leaves no blocking finding. That must not be
    # reported as a trustworthy clean review by accident — but it must also not fabricate a fix
    # round. The adapter's own consistency guard is what decides; pin whichever it is.
    n = adapter.normalize_codex(_codex([
        _pf(1, "Not committed", "The delta has not been committed and HEAD has not advanced."),
    ], "patch is incorrect"), 0)
    assert n["ran"] is True
    assert n["clean"] is True and n["verdict"] == "APPROVED", n


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
