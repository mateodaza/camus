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
