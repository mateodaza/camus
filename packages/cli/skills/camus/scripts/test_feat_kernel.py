"""Contract tests for the deterministic hybrid feature kernel."""
import json
import os
import subprocess
import sys
import tempfile
from unittest import mock

import feat_kernel as K
import resume_scan


def _write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _fixture(base, tasks=None, statuses=None, extra_args=None):
    tasks = tasks or ["first full task contract", "second full task contract"]
    statuses = statuses or ["done", "pending"]
    args = {
        "argsVersion": 1,
        "feat": "Hybrid Kernel Fixture",
        "tasks": tasks,
        "policy": "autonomous",
        "posture": "oneshot",
        **(extra_args or {}),
    }
    feat_id = resume_scan._feat_id(args)
    nodes = []
    for spec, status in zip(tasks, statuses):
        task_id = K._task_id(feat_id, spec)
        nodes.append({
            "taskId": task_id,
            "dependsOn": [],
            "status": status,
            "branch": "camus/feat/%s/%s" % (feat_id, task_id),
            "loopStatus": None,
            "brief": spec[:80],
        })
    ref = feat_id + ".args.json"
    state = {
        "featId": feat_id,
        "feat": args["feat"],
        "featBranch": "camus/feat-%s" % feat_id,
        "base": "main",
        "status": "needs_human",
        "stage": "fixture",
        "resumeArgsRef": ref,
        "resumeArgsHash": resume_scan._args_hash(args),
        "tasks": nodes,
        "events": [],
        "eventSeq": 0,
    }
    feats = os.path.join(base, "feats")
    _write(os.path.join(feats, ref), args)
    _write(os.path.join(feats, feat_id + ".json"), state)
    return feat_id, args, state


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo] + list(args), check=True,
                          capture_output=True, text=True).stdout.strip()


def _repo():
    repo = tempfile.mkdtemp(prefix="camus_kernel_repo_")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "kernel@example.test")
    _git(repo, "config", "user.name", "Kernel Test")
    with open(os.path.join(repo, "seed.txt"), "w", encoding="utf-8") as fh:
        fh.write("seed\n")
    _git(repo, "add", "seed.txt")
    _git(repo, "commit", "-qm", "seed")
    _git(repo, "branch", "-M", "main")
    return repo


def test_next_is_compact_and_contract_is_materialized_only_on_demand():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    hidden = "FULL_CONTRACT_ONLY_AFTER_SELECTION"
    second = "second task " + ("scope detail " * 30) + hidden
    feat_id, args, state = _fixture(base, tasks=["first task", second], statuses=["done", "pending"])
    run = K._validated_run(feat_id, base)
    envelope = K._envelope(run, repo="/repo", now=10)
    assert envelope["action"] == "run_task"
    assert envelope["task"]["id"] == state["tasks"][1]["taskId"]
    assert envelope["task"]["contractRef"].endswith("#tasks/1")
    assert hidden not in json.dumps(envelope)
    payload = K.task_payload(run, repo="/repo")
    assert payload["loopArgs"]["task"] == args["tasks"][1]
    assert payload["loopArgs"]["idSalt"] == feat_id
    assert payload["loopArgs"]["branchPrefix"] == "camus/feat/%s/" % feat_id


def test_refuses_hash_mismatch_and_task_identity_mismatch():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    feat_id, args, state = _fixture(base)
    sidecar = os.path.join(base, "feats", feat_id + ".args.json")
    _write(sidecar, {**args, "posture": "full"})
    try:
        K._validated_run(feat_id, base)
        assert False, "hash mismatch accepted"
    except K.Refusal as exc:
        assert "hash-incoherent" in str(exc)
    _write(sidecar, args)
    state["tasks"][1]["taskId"] = "wrong-id"
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    try:
        K._validated_run(feat_id, base)
        assert False, "task mismatch accepted"
    except K.Refusal as exc:
        assert "task identity mismatch" in str(exc)


def test_budget_stop_and_usage_are_monotonic():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    feat_id, _args, state = _fixture(base)
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "budgets": {"wallSeconds": 100, "tokens": 10, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 10, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    envelope = K._envelope(K._validated_run(feat_id, base), now=110)
    assert envelope["action"] == "stop"
    assert "token budget exhausted" in envelope["reason"]
    try:
        K.record_usage(feat_id, tokens=9, base=base, now=111)
        assert False, "usage decrease accepted"
    except K.Refusal as exc:
        assert "monotonic" in str(exc)


def test_merge_receipt_recovery_requires_receipt_and_git_ancestry():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(base, tasks=["land me"], statuses=["ready_to_merge"])
    feat_branch = state["featBranch"]
    task_branch = state["tasks"][0]["branch"]
    _git(repo, "branch", feat_branch)
    _git(repo, "checkout", "-qb", task_branch)
    with open(os.path.join(repo, "task.txt"), "w", encoding="utf-8") as fh:
        fh.write("work\n")
    _git(repo, "add", "task.txt")
    _git(repo, "commit", "-qm", "task")
    _git(repo, "checkout", "-q", feat_branch)
    before = _git(repo, "rev-parse", "HEAD")
    message = "camus(feat): merge %s" % state["tasks"][0]["taskId"]
    _git(repo, "merge", "--no-ff", task_branch, "-m", message)
    after = _git(repo, "rev-parse", "HEAD")
    receipt = {
        "merged": True, "committed": True, "alreadyUpToDate": False,
        "priorMergeCommit": None, "before": before, "after": after,
        "conflict": False, "error": None, "msg": message,
    }
    _write(os.path.join(base, "merges", state["tasks"][0]["taskId"] + ".json"), receipt)
    run = K._validated_run(feat_id, base)
    recovered = K._recover_receipts(run, repo)
    assert recovered == [state["tasks"][0]["taskId"]]
    assert run["nodes"][0]["status"] == "done"
    assert run["nodes"][0]["reconciledSha"] == after

    # A receipt that points at a real but unrelated commit is not proof of this feature merge.
    run["nodes"][0]["status"] = "ready_to_merge"
    receipt["after"] = before
    _write(os.path.join(base, "merges", state["tasks"][0]["taskId"] + ".json"), receipt)
    try:
        K._recover_receipts(run, repo)
        assert False, "unrelated receipt evidence accepted"
    except K.Refusal as exc:
        assert "task branch" in str(exc) or "feature branch" in str(exc)


def test_prepare_is_idempotent_and_writes_one_trace_attempt():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    state["featBranch"] = "camus/feat-%s" % feat_id
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    _git(repo, "branch", state["featBranch"])
    green = {"pass": True, "failures": [], "checks": [{"name": "fixture"}],
             "head": _git(repo, "rev-parse", "HEAD")}
    with mock.patch.object(K.env_check, "check_env", return_value=[]), \
         mock.patch.object(K.env_check, "collect_facts", return_value=["fixture fact"]), \
         mock.patch.object(K, "_run_verify", return_value=green):
        first = K.prepare(feat_id, repo=repo, wall_seconds=1000, token_budget=100,
                          retry_budget=2, base=base, now=100)
        second = K.prepare(feat_id, repo=repo, wall_seconds=1000, token_budget=100,
                           retry_budget=2, base=base, now=101)
    assert first["traceId"] == second["traceId"] == feat_id + ":a1"
    assert first["attempt"] == second["attempt"] == 1
    persisted = K._validated_run(feat_id, base)["state"]
    assert persisted["stage"] == "kernel_ready"
    assert persisted["kernel"]["activeTaskId"] == state["tasks"][0]["taskId"]
    assert persisted["kernel"]["budgets"] == {
        "wallSeconds": 1000, "tokens": 100, "retries": 2,
    }
    assert K.task_payload(K._validated_run(feat_id, base))["loopArgs"]["envFacts"] == "- fixture fact"


def test_prepare_refuses_green_verification_bound_to_another_head():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    _git(repo, "branch", state["featBranch"])
    false_green = {"pass": True, "failures": [], "checks": [], "head": "0" * 40}
    with mock.patch.object(K.env_check, "check_env", return_value=[]), \
         mock.patch.object(K, "_run_verify", return_value=false_green):
        try:
            K.prepare(feat_id, repo=repo, base=base, now=100)
            assert False, "verify result for another HEAD accepted"
        except K.Refusal as exc:
            assert "not bound" in str(exc)


def test_prepare_refuses_dirty_repo_before_checkout_or_state_write():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    _git(repo, "branch", state["featBranch"])
    state_path = os.path.join(base, "feats", feat_id + ".json")
    before = open(state_path, encoding="utf-8").read()
    with open(os.path.join(repo, "dirty.txt"), "w", encoding="utf-8") as fh:
        fh.write("dirty\n")
    try:
        K.prepare(feat_id, repo=repo, base=base, now=100)
        assert False, "dirty repo accepted"
    except K.Refusal as exc:
        assert "dirty" in str(exc)
    assert open(state_path, encoding="utf-8").read() == before
    assert _git(repo, "branch", "--show-current") == "main"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok   " + fn.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL " + fn.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
