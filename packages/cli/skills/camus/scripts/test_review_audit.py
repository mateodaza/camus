"""Contract tests for _review_audit.py (Codex review audit record).

    python3 test_review_audit.py      # stdlib runner
    python3 -m pytest -q
"""
import sys

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


def test_nonnumeric_round_exit_preserved_as_string():
    rec = A.build_record("/x/wt", "r1", "sig", "{}")
    assert rec["round"] == "r1" and rec["codex_exit"] == "sig"


def test_includes_raw_and_timestamp():
    rec = A.build_record("/x/wt", "0", "0", "{}")
    assert rec["codex_raw"] == "{}" and isinstance(rec["ran_at"], int)


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
