#!/usr/bin/env python3
"""Resumable provider-backed half of the Slice G reviewer campaign.

The tracked corpus is materialized into a fresh synthetic git worktree for each
attempt.  Baseline and candidate cells use the real Camus reviewer executors and
normalizers.  Every attempted provider call becomes an immutable ``bench1:``
receipt before the next cell begins.  This module does not admit a reviewer.
"""
import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import adapter
import benchmark_reviewers
import http_openai_compat_review as http_review
import model_trials
import review_request
import review_watch


CORPUS_VERSION = 1
CASE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
FINDING_CLASSES = {
    "logic_inversion", "missing_error_path", "resource_leak", "injection",
    "off_by_one", "dead_guard", "spec_deviation", "async_control",
    "data_loss", "unsafe_default",
}
KILL_MODES = {"none", "abort", "malformed_output", "identity_substitution", "transport_interrupt"}
INFLIGHT_KEYS = (
    "schemaVersion", "campaignId", "corpusVersion", "armId", "caseId", "repeat", "startedAt",
)
STATE_KEYS = benchmark_reviewers.EXECUTION_STATE_KEYS
DEFAULT_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "benchmark-corpus.v1.json")


class LiveBenchmarkError(ValueError):
    pass


def _text(value, label, limit=2000):
    if not isinstance(value, str) or not value.strip():
        raise LiveBenchmarkError("%s must be a non-empty string" % label)
    if len(value) > limit:
        raise LiveBenchmarkError("%s exceeds %d characters" % (label, limit))
    return value


def _exact(value, keys, label):
    if not isinstance(value, dict):
        raise LiveBenchmarkError("%s must be an object" % label)
    missing = sorted(set(keys) - set(value))
    extra = sorted(set(value) - set(keys))
    if missing or extra:
        raise LiveBenchmarkError("%s fields differ (missing=%s extra=%s)" % (label, missing, extra))


def validate_corpus(value):
    _exact(value, ("schemaVersion", "name", "promptEnvelopeVersion", "cases"), "corpus")
    if value["schemaVersion"] != CORPUS_VERSION:
        raise LiveBenchmarkError("corpus.schemaVersion must be 1")
    _text(value["name"], "corpus.name", 128)
    _text(value["promptEnvelopeVersion"], "corpus.promptEnvelopeVersion", 128)
    cases = value["cases"]
    if not isinstance(cases, list) or not 25 <= len(cases) <= 40:
        raise LiveBenchmarkError("public admission corpus must contain 25-40 cases")
    ids = set()
    represented = set()
    for index, case in enumerate(cases):
        label = "corpus.cases[%d]" % index
        _exact(case, (
            "caseId", "kind", "taskClass", "task", "baseFiles", "patchFiles",
            "expectedFindings", "killMode",
        ), label)
        case_id = _text(case["caseId"], label + ".caseId", 64)
        if not CASE_ID.fullmatch(case_id) or case_id in ids:
            raise LiveBenchmarkError("%s.caseId is invalid or duplicated" % label)
        ids.add(case_id)
        kind = case["kind"]
        if kind not in ("defect", "clean", "kill_path"):
            raise LiveBenchmarkError("%s.kind is invalid" % label)
        represented.add(kind)
        if case["taskClass"] not in ("simple", "balanced", "difficult", "control"):
            raise LiveBenchmarkError("%s.taskClass is invalid" % label)
        _text(case["task"], label + ".task")
        for field in ("baseFiles", "patchFiles"):
            files = case[field]
            if not isinstance(files, dict) or not 1 <= len(files) <= 8:
                raise LiveBenchmarkError("%s.%s must contain 1-8 files" % (label, field))
            for path, content in files.items():
                if not isinstance(path, str) or not SAFE_PATH.fullmatch(path) \
                        or path.startswith("/") or ".." in path.split("/"):
                    raise LiveBenchmarkError("%s.%s contains an unsafe path" % (label, field))
                if not isinstance(content, str) or len(content) > 20000:
                    raise LiveBenchmarkError("%s.%s content is invalid" % (label, field))
        if set(case["baseFiles"]) != set(case["patchFiles"]):
            raise LiveBenchmarkError("%s baseFiles and patchFiles must name the same paths" % label)
        findings = case["expectedFindings"]
        if not isinstance(findings, list) or len(findings) > 8:
            raise LiveBenchmarkError("%s.expectedFindings is invalid" % label)
        finding_ids = set()
        for finding in findings:
            _exact(finding, ("defectId", "class", "file", "startLine", "endLine", "matchAny"),
                   label + ".expectedFindings[]")
            defect_id = _text(finding["defectId"], "defectId", 128)
            if defect_id in finding_ids or finding["class"] not in FINDING_CLASSES:
                raise LiveBenchmarkError("%s has a duplicate id or invalid defect class" % label)
            finding_ids.add(defect_id)
            if finding["file"] not in case["patchFiles"]:
                raise LiveBenchmarkError("%s expected finding names an unknown file" % label)
            start, end = finding["startLine"], finding["endLine"]
            if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) \
                    or not isinstance(end, int) or start < 1 or end < start:
                raise LiveBenchmarkError("%s expected finding line range is invalid" % label)
            alternatives = finding["matchAny"]
            if not isinstance(alternatives, list) or not alternatives or len(alternatives) > 8:
                raise LiveBenchmarkError("%s expected finding alternatives are invalid" % label)
            for tokens in alternatives:
                if not isinstance(tokens, list) or not tokens or len(tokens) > 6 \
                        or any(not isinstance(token, str) or not 2 <= len(token) <= 80 for token in tokens):
                    raise LiveBenchmarkError("%s expected finding tokens are invalid" % label)
        kill_mode = case["killMode"]
        if kill_mode not in KILL_MODES:
            raise LiveBenchmarkError("%s.killMode is invalid" % label)
        if (kind == "defect") != bool(findings):
            raise LiveBenchmarkError("%s findings disagree with case kind" % label)
        if (kind == "kill_path") != (kill_mode != "none"):
            raise LiveBenchmarkError("%s killMode disagrees with case kind" % label)
    if represented != {"defect", "clean", "kill_path"}:
        raise LiveBenchmarkError("corpus must include defect, clean, and kill_path cases")
    return value


def corpus_version(corpus):
    validated = validate_corpus(corpus)
    digest = hashlib.sha256(benchmark_reviewers.canonical(validated).encode("utf-8")).hexdigest()
    return "corpus1:" + digest


def load_corpus(path=DEFAULT_CORPUS):
    try:
        with open(path, encoding="utf-8") as handle:
            return validate_corpus(json.load(handle))
    except (OSError, ValueError) as exc:
        raise LiveBenchmarkError("could not read benchmark corpus (%s)" % exc.__class__.__name__)


def validate_state(value, manifest):
    """Bind the private execution profile back to the frozen public campaign."""
    try:
        return benchmark_reviewers.validate_execution_state(value, manifest)
    except benchmark_reviewers.BenchmarkError as exc:
        raise LiveBenchmarkError(str(exc)) from exc


def receipt_bindings(manifest, state):
    """Bind every current receipt to the frozen campaign and exact execution tuple."""
    return {
        "campaignDigest": benchmark_reviewers.campaign_digest(manifest),
        "executionDigest": benchmark_reviewers.execution_digest(state, manifest),
    }


def campaign_for(corpus, candidate_backend, candidate_model, candidate_effort,
                 baseline_model, baseline_effort="medium", campaign_id=None, env=None):
    profiles = model_trials.load_profiles(env)
    profile = profiles.get(candidate_backend)
    if profile is None:
        raise LiveBenchmarkError("unknown reviewer profile %r; configure it in Studio first" % candidate_backend)
    if candidate_model not in profile["models"]:
        raise LiveBenchmarkError("model %r is not declared by reviewer profile %r" % (
            candidate_model, candidate_backend,
        ))
    cases = [{
        "caseId": case["caseId"], "kind": case["kind"],
        "expectedDefects": [finding["defectId"] for finding in case["expectedFindings"]],
    } for case in corpus["cases"]]
    stamp = time.strftime("%Y%m%d", time.gmtime())
    manifest = {
        "schemaVersion": 1,
        "campaignId": campaign_id or "slice-g-%s-%s-%s" % (
            stamp, candidate_backend, hashlib.sha256(candidate_model.encode("utf-8")).hexdigest()[:10],
        ),
        "corpusVersion": corpus_version(corpus),
        "promptEnvelopeVersion": corpus["promptEnvelopeVersion"],
        "baseline": {
            "armId": "codex-baseline", "backend": "codex", "model": baseline_model,
            "effort": baseline_effort, "transport": "cli_detached_configured", "role": "reviewer",
        },
        "candidates": [{
            "armId": "candidate", "backend": "http_openai_compat", "model": candidate_model,
            "effort": candidate_effort, "transport": profile["connection"]["kind"], "role": "reviewer",
        }],
        "cases": cases,
        "transportPairs": [],
        "thresholds": {
            "validityLower": 0.98, "recallDelta": 0.10, "fprEpsilon": 0.05,
            "transportDelta": 0.03, "qualityRepetitions": 10,
            "killRepetitions": 3, "containmentMinimum": 150,
            "containmentConclusive": 0.98,
        },
    }
    return benchmark_reviewers.validate_manifest(manifest), {
        "schemaVersion": 1,
        "campaignId": manifest["campaignId"],
        "corpusVersion": manifest["corpusVersion"],
        "candidateProfileBackend": candidate_backend,
        "candidateModel": candidate_model,
        "candidateTrainingOrg": profile["training_org"],
        "candidateConnection": profile["connection"]["name"],
        "candidateTransport": profile["connection"]["kind"],
    }


def _location(value):
    if not isinstance(value, str):
        return None, None, None
    path, separator, lines = value.rpartition(":")
    if not separator:
        return None, None, None
    match = re.fullmatch(r"(\d+)(?:-(\d+))?", lines.strip())
    if not match:
        return None, None, None
    start = int(match.group(1))
    return path.lstrip("./"), start, int(match.group(2) or start)


def detected_defects(case, blocking):
    detected = []
    for expected in case["expectedFindings"]:
        for finding in blocking or []:
            path, start, end = _location(finding.get("code_location"))
            if path != expected["file"] or start is None \
                    or end < expected["startLine"] - 2 or start > expected["endLine"] + 2:
                continue
            text = "%s\n%s" % (finding.get("title") or "", finding.get("body") or "")
            folded = text.casefold()
            if any(all(token.casefold() in folded for token in alternative)
                   for alternative in expected["matchAny"]):
                detected.append(expected["defectId"])
                break
    return detected


def schedule(manifest, receipts, arms=("codex-baseline", "candidate"), include_kill=False):
    existing = {(item["armId"], item["caseId"], item["repeat"]) for item in receipts}
    rows = []
    for case in manifest["cases"]:
        if case["kind"] == "kill_path" and not include_kill:
            continue
        floor = manifest["thresholds"]["killRepetitions" if case["kind"] == "kill_path" else "qualityRepetitions"]
        for repeat in range(1, floor + 1):
            ordered = list(arms)
            parity = hashlib.sha256((case["caseId"] + ":" + str(repeat)).encode("utf-8")).digest()[0] & 1
            if parity:
                ordered.reverse()
            for arm in ordered:
                key = (arm, case["caseId"], repeat)
                if key not in existing:
                    rows.append(key)
    return rows


def _write_files(root, values):
    for relative, content in values.items():
        path = os.path.join(root, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)


@contextlib.contextmanager
def _materialized(case):
    temporary = tempfile.mkdtemp(prefix="camus-slice-g-")
    # Production reviewers deliberately refuse arbitrary repositories.  Give the
    # synthetic fixture the same branch/path coherence as a real Camus task worktree
    # instead of weakening that egress boundary for benchmarks.
    root = os.path.join(temporary, "camus-wt-benchmark")
    try:
        os.makedirs(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True, capture_output=True)
        subprocess.run(
            ["git", "checkout", "-qb", "camus/benchmark"],
            cwd=root, check=True, capture_output=True,
        )
        subprocess.run(["git", "config", "user.name", "Camus Benchmark"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "benchmark@camus.invalid"], cwd=root, check=True)
        _write_files(root, case["baseFiles"])
        subprocess.run(["git", "add", "--", "."], cwd=root, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture base"], cwd=root, check=True)
        _write_files(root, case["patchFiles"])
        yield root
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _json_process(args, cwd, env, timeout=650):
    try:
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        value = json.loads((result.stdout or "").strip())
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise LiveBenchmarkError("review process failed (%s)" % exc.__class__.__name__)
    if not isinstance(value, dict):
        raise LiveBenchmarkError("review process returned a non-object envelope")
    return value


def _run_codex(worktree, task, model, effort, nonce, env):
    scripts = os.path.dirname(os.path.abspath(__file__))
    child = dict(env)
    review_dir = os.path.join(child.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus"),
                              "benchmark-reviews", hashlib.sha256(nonce.encode("utf-8")).hexdigest()[:20])
    child.update({
        "CAMUS_REVIEW_DIR": review_dir, "CAMUS_REPO_ROOT": worktree,
        "CAMUS_REVIEWER": "codex", "CAMUS_REVIEW_BACKEND": "codex",
        "CAMUS_MAKER_TRAINING_ORG": "anthropic", "CAMUS_CODEX_MODEL": model,
        "CAMUS_GATE_NONCE": nonce, "CAMUS_REVIEW_ROUND": "1",
        "CAMUS_REVIEW_EFFORT": effort, "CAMUS_REVIEW_SCOPE": "light",
        "CAMUS_REVIEW_ORIGIN": "camus_benchmark", "CAMUS_REVIEW_OPERATOR": "camus",
    })
    request, error = review_request.build_request(
        worktree, 1, effort=effort, nonce=nonce, model=model, backend="codex", scope="light",
        qualification="qual1", origin="camus_benchmark", operator="camus",
        transport="cli-detached", connection="configured", contract="rc1",
    )
    if error:
        raise LiveBenchmarkError("could not bind Codex baseline request: %s" % error)
    model_trials._atomic_request(review_dir, worktree, request)
    script = os.path.join(scripts, "review.sh")
    value = _json_process(["bash", script, worktree, task, "1", effort, "light"], worktree, child)
    awaits = 0
    while value.get("pending") is True and awaits < 12:
        handle = value.get("handle")
        if not isinstance(handle, str) or not os.path.isabs(handle):
            raise LiveBenchmarkError("Codex baseline returned an invalid pending handle")
        value = _json_process(["bash", script, "await", handle], worktree, child)
        awaits += 1
    if value.get("pending") is True:
        raise LiveBenchmarkError("Codex baseline remained pending after bounded reattachment")
    return value


def run_cell(manifest, state, corpus, arm_id, case_id, repeat, env=None):
    env = dict(os.environ if env is None else env)
    case = next((item for item in corpus["cases"] if item["caseId"] == case_id), None)
    arm = next((item for item in [manifest["baseline"]] + manifest["candidates"] if item["armId"] == arm_id), None)
    if case is None or arm is None or case["kind"] == "kill_path":
        raise LiveBenchmarkError("live quality runner received an unknown or kill-path cell")
    nonce = "bench:%s:%s:%s:%d" % (manifest["campaignId"], arm_id, case_id, repeat)
    started = time.monotonic()
    result = None
    failure = None
    with _materialized(case) as worktree:
        try:
            if arm_id == manifest["baseline"]["armId"]:
                result = _run_codex(worktree, case["task"], arm["model"], arm["effort"], nonce, env)
            else:
                result = model_trials.run_review(
                    state["candidateProfileBackend"], state["candidateModel"], worktree, case["task"],
                    round_no=1, effort=arm["effort"], repo=worktree, nonce=nonce, env=env,
                )
        except (LiveBenchmarkError, model_trials.TrialError) as exc:
            failure = exc.__class__.__name__
    wall = int((time.monotonic() - started) * 1000)
    ran = isinstance(result, dict) and result.get("ran") is True
    if not ran and failure is None:
        # The receipt deliberately carries no provider-controlled error text, but the
        # operator still needs a stable local diagnosis before authorizing another paid
        # cell.  Keep only adapter-owned machine codes with a narrow shape; arbitrary
        # remote messages never enter the ledger or terminal status line.
        candidate = (result.get("errorCode") or result.get("error_code")) \
            if isinstance(result, dict) else None
        failure = candidate if isinstance(candidate, str) \
            and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", candidate) \
            else "review_unavailable"
    blocking = result.get("blocking") if ran and isinstance(result.get("blocking"), list) else []
    usage_raw = result.get("usage") if ran and isinstance(result.get("usage"), dict) else None
    def token(*names):
        for name in names:
            value = usage_raw.get(name) if usage_raw else None
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        return None
    input_tokens = token("input_tokens", "prompt_tokens", "inputTokens")
    output_tokens = token("output_tokens", "completion_tokens", "outputTokens")
    total_tokens = token("total_tokens", "totalTokens")
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    receipt = {
        "schemaVersion": benchmark_reviewers.RECEIPT_SCHEMA_VERSION,
        "campaignId": manifest["campaignId"],
        "corpusVersion": manifest["corpusVersion"],
        **receipt_bindings(manifest, state),
        "promptEnvelopeVersion": manifest["promptEnvelopeVersion"],
        "armId": arm_id, "caseId": case_id, "caseKind": case["kind"], "repeat": repeat,
        "normalizerRan": ran, "expectedDefects": [item["defectId"] for item in case["expectedFindings"]],
        "detectedDefects": detected_defects(case, blocking) if ran else [],
        "blockingFindingCount": len(blocking),
        "identityMatch": bool(ran and (
            result.get("binding", {}).get("model") if arm_id == manifest["baseline"]["armId"]
            else result.get("model")
        ) == arm["model"]),
        "killPathPassed": None, "killControl": None,
        "toolUsing": False, "toolCallCorrect": None,
        "pseudoToolCallCount": 0, "contextSufficient": None,
        "mutationEntered": False, "containmentConclusive": None, "containmentBreach": None,
        "wallMs": wall, "latencyClass": "na",
        "usage": ({
            "inputTokens": input_tokens, "cachedInputTokens": token("cached_input_tokens", "cachedInputTokens"),
            "outputTokens": output_tokens, "totalTokens": total_tokens,
            "costUsd": None, "costSource": "unavailable",
        } if usage_raw is not None else None),
        "decoding": {"temperature": None, "seed": None, "pinned": False},
        "rerunOf": None,
    }
    sealed = benchmark_reviewers.seal_receipt(receipt, manifest)
    return sealed, failure


def infra_receipt(manifest, state, arm_id, case, repeat, wall_ms):
    """Seal an operator-authorized unknown outcome after an interrupted paid cell."""
    if case["kind"] == "kill_path":
        raise LiveBenchmarkError("kill-path recovery is not implemented by the quality runner")
    return benchmark_reviewers.seal_receipt({
        "schemaVersion": benchmark_reviewers.RECEIPT_SCHEMA_VERSION,
        "campaignId": manifest["campaignId"],
        "corpusVersion": manifest["corpusVersion"],
        **receipt_bindings(manifest, state),
        "promptEnvelopeVersion": manifest["promptEnvelopeVersion"],
        "armId": arm_id, "caseId": case["caseId"], "caseKind": case["kind"], "repeat": repeat,
        "normalizerRan": False, "expectedDefects": [item["defectId"] for item in case["expectedFindings"]],
        "detectedDefects": [], "blockingFindingCount": 0, "identityMatch": False,
        "killPathPassed": None, "killControl": None,
        "toolUsing": False, "toolCallCorrect": None,
        "pseudoToolCallCount": 0, "contextSufficient": None,
        "mutationEntered": False, "containmentConclusive": None, "containmentBreach": None,
        "wallMs": max(0, int(wall_ms)), "latencyClass": "na", "usage": None,
        "decoding": {"temperature": None, "seed": None, "pinned": False}, "rerunOf": None,
    }, manifest)


def _watch_json(arguments, cwd=None):
    """Run the shipped watchdog executable and require its single JSON envelope."""
    try:
        result = subprocess.run(
            [sys.executable, os.path.abspath(review_watch.__file__)] + list(arguments),
            cwd=cwd, capture_output=True, text=True, timeout=20,
        )
        value = json.loads((result.stdout or "").strip())
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise LiveBenchmarkError("watchdog control failed (%s)" % exc.__class__.__name__)
    if result.returncode != 0 or not isinstance(value, dict):
        raise LiveBenchmarkError("watchdog control returned an invalid envelope")
    return value


def _kill_abort_probe():
    expected = "aborted_and_process_group_dead"
    with tempfile.TemporaryDirectory(prefix="camus-benchmark-abort-") as temp:
        handle = os.path.join(temp, "watch")
        last = os.path.join(temp, "last.json")
        pid = None
        try:
            started = _watch_json([
                "start", "--handle", handle, "--last", last,
                "--", sys.executable, "-c", "import time; time.sleep(60)",
            ])
            pid = started.get("pid")
            aborted = _watch_json(["abort", "--handle", handle])
            passed = started.get("state") == "started" and isinstance(pid, int) \
                and aborted.get("state") == "aborted" \
                and aborted.get("unverified_pid") is not True \
                and not review_watch._group_alive(pid)
            return "review_watch.start+abort", expected, expected if passed else "abort_control_failed"
        finally:
            record = review_watch._read_handle(handle)
            if isinstance(pid, int) and review_watch._group_alive(pid) \
                    and record and review_watch._group_is_ours(pid, record.get("started_at", 0)):
                review_watch._kill_group(pid)


def _kill_malformed_probe():
    expected = "malformed_output_refused_as_infrastructure"
    result = adapter.normalize_codex("{not-json", 0)
    passed = result.get("ran") is False and result.get("verdict") == "ERROR" \
        and "unparseable" in str(result.get("error") or "") \
        and result.get("clean") is False
    return "adapter.normalize_codex", expected, expected if passed else "malformed_output_was_not_refused"


def _kill_identity_probe(arm):
    expected = "substituted_model_identity_refused"
    if arm["backend"] == "http_openai_compat":
        error = http_review.response_identity_error(arm["model"], ["substituted-model"])
        passed = error is not None and error[0] == "model_identity_mismatch"
        probe = "http_openai_compat_review.response_identity_error"
    else:
        try:
            review_request.consistent_value({
                "request": arm["model"], "executor": "substituted-model",
            }, "reviewer model")
            passed = False
        except ValueError:
            passed = True
        probe = "review_request.consistent_value"
    return probe, expected, expected if passed else "substituted_model_identity_was_accepted"


def _kill_transport_probe():
    expected = "interrupted_transport_refused_without_verdict"
    with tempfile.TemporaryDirectory(prefix="camus-benchmark-transport-") as temp:
        handle = os.path.join(temp, "watch")
        last = os.path.join(temp, "last.json")
        pid = None
        try:
            started = _watch_json([
                "start", "--handle", handle, "--last", last,
                "--", sys.executable, "-c",
                "import json,sys; print(json.dumps({'type':'response.started'}), flush=True); sys.exit(74)",
            ])
            pid = started.get("pid")
            outcome = None
            for _ in range(4):
                outcome = _watch_json(["await", "--handle", handle, "--chunk", "1", "--idle", "5"])
                if outcome.get("state") != "pending":
                    break
            exit_code = outcome.get("exit") if isinstance(outcome, dict) else None
            normalized = adapter.normalize_codex("", exit_code if isinstance(exit_code, int) else 1)
            passed = started.get("state") == "started" and outcome.get("state") == "done" \
                and exit_code == 74 and not os.path.exists(last) \
                and normalized.get("ran") is False and normalized.get("verdict") == "ERROR" \
                and normalized.get("clean") is False
            return (
                "review_watch.start+await+adapter.normalize_codex",
                expected,
                expected if passed else "interrupted_transport_produced_or_stranded_a_verdict",
            )
        finally:
            record = review_watch._read_handle(handle)
            if isinstance(pid, int) and review_watch._group_alive(pid) \
                    and record and review_watch._group_is_ours(pid, record.get("started_at", 0)):
                review_watch._kill_group(pid)


def run_kill_cell(manifest, state, corpus, arm_id, case_id, repeat):
    """Exercise one mechanical refusal path. This function has no provider-call branch."""
    case = next((item for item in corpus["cases"] if item["caseId"] == case_id), None)
    arm = next((item for item in [manifest["baseline"]] + manifest["candidates"]
                if item["armId"] == arm_id), None)
    if case is None or arm is None or case["kind"] != "kill_path" or case["killMode"] == "none":
        raise LiveBenchmarkError("kill runner received an unknown or non-kill cell")
    started = time.monotonic()
    expected = benchmark_reviewers.KILL_CONTROL_EXPECTED[case["killMode"]]
    probe = "kill_probe_unavailable"
    observed = "kill_probe_failed"
    try:
        if case["killMode"] == "abort":
            probe, expected, observed = _kill_abort_probe()
        elif case["killMode"] == "malformed_output":
            probe, expected, observed = _kill_malformed_probe()
        elif case["killMode"] == "identity_substitution":
            probe, expected, observed = _kill_identity_probe(arm)
        elif case["killMode"] == "transport_interrupt":
            probe, expected, observed = _kill_transport_probe()
    except (LiveBenchmarkError, OSError, subprocess.SubprocessError):
        observed = "kill_probe_infrastructure_failure"
    passed = observed == expected
    wall = int((time.monotonic() - started) * 1000)
    return benchmark_reviewers.seal_receipt({
        "schemaVersion": benchmark_reviewers.RECEIPT_SCHEMA_VERSION,
        "campaignId": manifest["campaignId"],
        "corpusVersion": manifest["corpusVersion"],
        **receipt_bindings(manifest, state),
        "promptEnvelopeVersion": manifest["promptEnvelopeVersion"],
        "armId": arm_id, "caseId": case_id, "caseKind": case["kind"], "repeat": repeat,
        "normalizerRan": False, "expectedDefects": [], "detectedDefects": [],
        "blockingFindingCount": 0, "identityMatch": False,
        "killPathPassed": passed,
        "killControl": {
            "mode": case["killMode"], "probe": probe,
            "expected": expected, "observed": observed, "providerCallsMade": 0,
        },
        "toolUsing": False, "toolCallCorrect": None, "pseudoToolCallCount": 0,
        "contextSufficient": None, "mutationEntered": False,
        "containmentConclusive": None, "containmentBreach": None,
        "wallMs": wall, "latencyClass": "na", "usage": None,
        "decoding": {"temperature": None, "seed": None, "pinned": False}, "rerunOf": None,
    }, manifest)


def _atomic_json(path, value, mode=0o600):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".slice-g-", suffix=".tmp")
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _load(path, label):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        raise LiveBenchmarkError("could not read %s (%s)" % (label, exc.__class__.__name__))


def _inflight_path(ledger):
    return os.path.abspath(ledger) + ".inflight.json"


def _load_inflight(path, manifest):
    if not os.path.exists(path):
        return None
    value = _load(path, "in-flight benchmark cell")
    _exact(value, INFLIGHT_KEYS, "in-flight benchmark cell")
    if value["schemaVersion"] != 1 or value["campaignId"] != manifest["campaignId"] \
            or value["corpusVersion"] != manifest["corpusVersion"]:
        raise LiveBenchmarkError("in-flight benchmark cell belongs to another campaign")
    arms = {item["armId"] for item in [manifest["baseline"]] + manifest["candidates"]}
    cases = {item["caseId"] for item in manifest["cases"]}
    if value["armId"] not in arms or value["caseId"] not in cases \
            or isinstance(value["repeat"], bool) or not isinstance(value["repeat"], int) \
            or value["repeat"] < 1 or isinstance(value["startedAt"], bool) \
            or not isinstance(value["startedAt"], int) or value["startedAt"] < 1:
        raise LiveBenchmarkError("in-flight benchmark cell is malformed")
    return value


def _clear_inflight(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camus provider-backed Slice G campaign")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="freeze a live campaign before any provider spend")
    plan.add_argument("--candidate-backend", required=True)
    plan.add_argument("--candidate-model", required=True)
    plan.add_argument("--candidate-effort", choices=model_trials.EFFORTS, default="medium")
    plan.add_argument("--baseline-model", required=True)
    plan.add_argument("--baseline-effort", choices=model_trials.EFFORTS, default="medium")
    plan.add_argument("--campaign-id", default=None)
    plan.add_argument("--corpus", default=DEFAULT_CORPUS)
    plan.add_argument("--campaign", required=True)
    plan.add_argument("--state", required=True)
    status = sub.add_parser("status", help="show remaining cells without provider calls")
    status.add_argument("--campaign", required=True)
    status.add_argument("--state", required=True)
    status.add_argument("--ledger", required=True)
    status.add_argument("--corpus", default=DEFAULT_CORPUS)
    status.add_argument("--json", action="store_true")
    run = sub.add_parser("run", help="run a bounded number of resumable quality cells")
    run.add_argument("--campaign", required=True)
    run.add_argument("--state", required=True)
    run.add_argument("--ledger", required=True)
    run.add_argument("--corpus", default=DEFAULT_CORPUS)
    run.add_argument("--arm", choices=("all", "baseline", "candidate"), default="all")
    run.add_argument("--max-cells", type=int, default=1)
    kill = sub.add_parser("kill", help="run spend-free mechanical refusal controls")
    kill.add_argument("--campaign", required=True)
    kill.add_argument("--state", required=True)
    kill.add_argument("--ledger", required=True)
    kill.add_argument("--corpus", default=DEFAULT_CORPUS)
    kill.add_argument("--arm", choices=("all", "baseline", "candidate"), default="all")
    kill.add_argument("--max-cells", type=int, default=1)
    recover = sub.add_parser("recover", help="seal one interrupted paid cell as infrastructure failure")
    recover.add_argument("--campaign", required=True)
    recover.add_argument("--state", required=True)
    recover.add_argument("--ledger", required=True)
    recover.add_argument("--corpus", default=DEFAULT_CORPUS)
    recover.add_argument("--action", choices=("seal-infra",), required=True)
    args = parser.parse_args(argv)
    try:
        corpus = load_corpus(args.corpus)
        if args.command == "plan":
            manifest, state_value = campaign_for(
                corpus, args.candidate_backend, args.candidate_model, args.candidate_effort,
                args.baseline_model, args.baseline_effort, args.campaign_id,
            )
            _atomic_json(args.campaign, manifest)
            _atomic_json(args.state, state_value)
            print(json.dumps({
                "campaignId": manifest["campaignId"], "corpusVersion": manifest["corpusVersion"],
                "qualityCells": sum(1 for case in manifest["cases"] if case["kind"] != "kill_path")
                                * manifest["thresholds"]["qualityRepetitions"] * 2,
                "killCells": sum(1 for case in manifest["cases"] if case["kind"] == "kill_path")
                             * manifest["thresholds"]["killRepetitions"] * 2,
                "providerCallsMade": 0,
            }, separators=(",", ":")))
            return 0
        manifest = benchmark_reviewers.validate_manifest(_load(args.campaign, "campaign"))
        state_value = validate_state(_load(args.state, "campaign state"), manifest)
        if state_value.get("campaignId") != manifest["campaignId"] \
                or state_value.get("corpusVersion") != manifest["corpusVersion"] \
                or corpus_version(corpus) != manifest["corpusVersion"]:
            raise LiveBenchmarkError("campaign, state, and corpus binding disagree")
        receipts = benchmark_reviewers.load_ledger(args.ledger, manifest)
        inflight_path = _inflight_path(args.ledger)
        inflight = _load_inflight(inflight_path, manifest)
        if inflight is not None and any(
            (item["armId"], item["caseId"], item["repeat"])
            == (inflight["armId"], inflight["caseId"], inflight["repeat"])
            for item in receipts
        ):
            # Crash after ledger fsync but before clearing the marker: the
            # receipt is authoritative and recovery is automatic/idempotent.
            _clear_inflight(inflight_path)
            inflight = None
        if args.command == "recover":
            if inflight is None:
                raise LiveBenchmarkError("there is no interrupted benchmark cell to recover")
            case = next(item for item in corpus["cases"] if item["caseId"] == inflight["caseId"])
            receipt = infra_receipt(
                manifest, state_value, inflight["armId"], case, inflight["repeat"],
                max(0, int(time.time()) - inflight["startedAt"]) * 1000,
            )
            benchmark_reviewers.append_receipt(args.ledger, receipt, manifest)
            _clear_inflight(inflight_path)
            print(json.dumps({
                "campaignId": manifest["campaignId"], "recovered": True,
                "receiptId": receipt["receiptId"], "standing": "infrastructure_failure_sealed",
            }, separators=(",", ":")))
            return 0
        arms = (manifest["baseline"]["armId"], "candidate")
        if getattr(args, "arm", "all") == "baseline":
            arms = (manifest["baseline"]["armId"],)
        elif getattr(args, "arm", "all") == "candidate":
            arms = ("candidate",)
        pending = schedule(manifest, receipts, arms=arms)
        all_pending = schedule(manifest, receipts, arms=arms, include_kill=True)
        quality_keys = set(pending)
        kill_rows = [row for row in all_pending if row not in quality_keys]
        kill_pending = len(kill_rows)
        if args.command == "status":
            value = {
                "campaignId": manifest["campaignId"], "receipts": len(receipts),
                "qualityPending": len(pending), "killPending": kill_pending,
                "complete": not pending and kill_pending == 0,
                "admissionStanding": "not_evaluated" if pending or kill_pending else "ready_to_summarize",
                "inflight": ({
                    "armId": inflight["armId"], "caseId": inflight["caseId"],
                    "repeat": inflight["repeat"], "startedAt": inflight["startedAt"],
                } if inflight else None),
            }
            if args.json:
                print(json.dumps(value, separators=(",", ":")))
            else:
                print("%s · %d receipts · %d quality pending · %d kill-path pending" % (
                    value["campaignId"], value["receipts"], value["qualityPending"], value["killPending"],
                ))
                if inflight is not None:
                    print("PAUSED: unresolved paid cell %s/%s repeat %d; recover explicitly before spending again" % (
                        inflight["armId"], inflight["caseId"], inflight["repeat"],
                    ))
            return 0
        if args.max_cells < 1 or args.max_cells > 100:
            raise LiveBenchmarkError("--max-cells must be between 1 and 100")
        if inflight is not None:
            raise LiveBenchmarkError(
                "an interrupted paid cell is unresolved; wait for its bounded executor, then run "
                "`camus benchmark recover --action seal-infra` before any new provider call"
            )
        if args.command == "kill":
            completed = 0
            passed = 0
            for arm_id, case_id, repeat in kill_rows[:args.max_cells]:
                receipt = run_kill_cell(manifest, state_value, corpus, arm_id, case_id, repeat)
                benchmark_reviewers.append_receipt(args.ledger, receipt, manifest)
                completed += 1
                passed += int(receipt["killPathPassed"] is True)
                print("sealed %s %s r%d → %s" % (
                    arm_id, case_id, repeat,
                    "passed" if receipt["killPathPassed"] else "failed",
                ), file=sys.stderr, flush=True)
            print(json.dumps({
                "campaignId": manifest["campaignId"], "cellsRun": completed,
                "killPathsPassed": passed,
                "qualityRemaining": len(pending),
                "killPathRemaining": max(0, kill_pending - completed),
                "providerCallsMade": 0,
            }, separators=(",", ":")))
            return 0 if passed == completed else 3
        completed = 0
        infra = 0
        for arm_id, case_id, repeat in pending[:args.max_cells]:
            started_at = int(time.time())
            _atomic_json(inflight_path, {
                "schemaVersion": 1, "campaignId": manifest["campaignId"],
                "corpusVersion": manifest["corpusVersion"], "armId": arm_id,
                "caseId": case_id, "repeat": repeat, "startedAt": started_at,
            })
            receipt, failure = run_cell(manifest, state_value, corpus, arm_id, case_id, repeat)
            benchmark_reviewers.append_receipt(args.ledger, receipt, manifest)
            _clear_inflight(inflight_path)
            completed += 1
            infra += int(failure is not None or receipt["normalizerRan"] is not True)
            outcome = "normalized" if receipt["normalizerRan"] else "infra:%s" % failure
            print("sealed %s %s r%d → %s" % (
                arm_id, case_id, repeat, outcome,
            ), file=sys.stderr, flush=True)
        print(json.dumps({
            "campaignId": manifest["campaignId"], "cellsRun": completed,
            "infraAttempts": infra, "qualityRemaining": max(0, len(pending) - completed),
            "killPathRemaining": kill_pending,
        }, separators=(",", ":")))
        return 0
    except KeyboardInterrupt:
        if args.command == "run":
            print(
                "interrupted: any started paid cell remains marked in-flight; inspect status and recover explicitly",
                file=sys.stderr,
            )
        else:
            print("interrupted", file=sys.stderr)
        return 130
    except (LiveBenchmarkError, benchmark_reviewers.BenchmarkError, model_trials.TrialError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
