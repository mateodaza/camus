"""Contract tests for _review_audit.py (Codex review audit record).

    python3 test_review_audit.py      # stdlib runner
    python3 -m pytest -q
"""
import io
import json
import os
import sys
import tempfile

import _review_audit as A


def test_real_codex_response_marks_ran_true():
    rec = A.build_record("/x/camus-wt-foo", "1", "0", '{"findings":[],"overall_correctness":"patch is correct"}')
    assert rec["ran"] is True
    assert rec["round"] == 1 and rec["codex_exit"] == 0
    assert rec["codex_parsed"]["overall_correctness"] == "patch is correct"


def test_empty_response_marks_ran_false():
    rec = A.build_record("/x/camus-wt-foo", "2", "127", "")
    assert rec["ran"] is False and rec["codex_parsed"] is None
    assert rec["codex_exit"] == 127


def test_nonjson_response_marks_ran_false():
    rec = A.build_record("/x/camus-wt-foo", "1", "0", "command not found: codex")
    assert rec["ran"] is False and rec["codex_parsed"] is None


def test_parseable_json_without_verdict_marks_ran_false():
    # audit 2026-06-13, item 12: parseable JSON that LACKS a valid overall_correctness is exactly
    # what the adapter rejects as schema-drift infra (the review did NOT happen) — the audit `ran`
    # must agree, or the forensic file claims a review "ran" for output the gate threw away.
    rec = A.build_record("/x/camus-wt-foo", "1", "0", '{"some":"json","but":"no verdict"}')
    assert rec["ran"] is False, "parseable-but-no-overall_correctness must be ran:false"
    assert rec["codex_parsed"] == {"some": "json", "but": "no verdict"}  # still captured for forensics


def test_incorrect_verdict_marks_ran_true():
    rec = A.build_record("/x/camus-wt-foo", "1", "0",
                         '{"overall_correctness":"patch is incorrect","findings":[{"priority":1}]}')
    assert rec["ran"] is True  # a real REJECT verdict is a review that ran


def test_ran_matches_adapter_full_contract():
    # verification audit 2026-06-13: ran must mirror the adapter's FULL usable-verdict contract,
    # not merely a valid overall_correctness. Each shape below is one the adapter rejects as infra.
    missing_findings = A.build_record("/x/camus-wt-foo", "1", "0",
                                      '{"overall_correctness":"patch is correct"}')
    assert missing_findings["ran"] is False, "missing findings[] must be ran:false"
    bad_priority = A.build_record("/x/camus-wt-foo", "1", "0",
                                  '{"overall_correctness":"patch is correct","findings":[{"priority":9}]}')
    assert bad_priority["ran"] is False, "out-of-range priority must be ran:false"
    incorrect_no_blocking = A.build_record("/x/camus-wt-foo", "1", "0",
                                           '{"overall_correctness":"patch is incorrect","findings":[]}')
    assert incorrect_no_blocking["ran"] is False, "'incorrect' with no blocking must be ran:false"
    nonzero_exit = A.build_record("/x/camus-wt-foo", "1", "7",
                                  '{"overall_correctness":"patch is correct","findings":[]}')
    assert nonzero_exit["ran"] is False, "a non-zero codex exit must be ran:false"


def test_nonnumeric_round_exit_preserved_as_string():
    rec = A.build_record("/x/wt", "r1", "sig", "{}")
    assert rec["round"] == "r1" and rec["codex_exit"] == "sig"


def test_includes_raw_and_timestamp():
    rec = A.build_record("/x/wt", "0", "0", "{}")
    assert rec["codex_raw"] == "{}" and isinstance(rec["ran_at"], int)


def test_reviewer_model_recorded_only_when_pinned():
    # The identity slice records the pinned reviewer model; with no pin it stays
    # null (a caller reads it only when ran is True — unknown never becomes claimed).
    rec = A.build_record("/x/wt", "1", "0",
                         '{"findings":[],"overall_correctness":"patch is correct"}', "gpt-5.4")
    assert rec["reviewer_model"] == "gpt-5.4" and rec["ran"] is True
    assert A.build_record("/x/wt", "1", "0", "{}")["reviewer_model"] is None


def test_main_writes_complete_json_and_leaves_no_temp_file():
    # The write must be atomic: readers see a complete file (never a truncated
    # mid-write), and no .tmp file is left behind after os.replace().
    d = tempfile.mkdtemp()
    audit = os.path.join(d, "camus-wt-foo-r1.json")
    old_stdin = sys.stdin
    sys.stdin = io.StringIO('{"overall_correctness":"patch is correct","findings":[]}')
    try:
        rc = A.main([audit, "/x/wt", "1", "0"])
    finally:
        sys.stdin = old_stdin
    assert rc == 0
    with open(audit, encoding="utf-8") as fh:
        rec = json.load(fh)  # complete + parseable, or this raises
    assert rec["round"] == 1 and rec["ran"] is True
    leftovers = [n for n in os.listdir(d) if n != os.path.basename(audit)]
    assert leftovers == [], "atomic write left temp files behind: %r" % leftovers


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
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
