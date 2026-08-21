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


def _accept_fixture(result_status="verify_inconclusive"):
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, args, state = _fixture(
        base, tasks=["accept this exact contract"], statuses=["running"],
        extra_args={"targetPath": repo},
    )
    node = state["tasks"][0]
    _git(repo, "branch", state["featBranch"])
    wt = tempfile.mkdtemp(prefix="camus_kernel_wt_parent_")
    os.rmdir(wt)
    _git(repo, "worktree", "add", "-qb", node["branch"], wt, state["featBranch"])
    with open(os.path.join(wt, "task.txt"), "w", encoding="utf-8") as fh:
        fh.write("accepted\n")
    _git(wt, "add", "task.txt")
    _git(wt, "commit", "-qm", "candidate")
    commit = _git(wt, "rev-parse", "HEAD")
    run_id = node["taskId"].rsplit("-", 1)[-1]
    trace_id = feat_id + ":a1"
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": trace_id,
        "attempt": 1,
        "phase": "task_running",
        "activeTaskId": node["taskId"],
        "repoHead": _git(repo, "rev-parse", state["featBranch"]),
        "budgets": {"wallSeconds": 1000, "tokens": 5000, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 0, "retries": 0},
        "taskUsageStartTokens": 0,
        "taskUsageStartRetries": 0,
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    findings = [{
        "priority": 1,
        "title": "bounded finding",
        "body": "a real contract defect",
        "code_location": "task.txt:1",
        "confidence_score": 0.99,
    }]
    result = {
        "status": result_status,
        "task": args["tasks"][0],
        "worktree": wt,
        "branch": node["branch"],
        "rounds": 1,
        "findings": [{**findings[0], "claimedResolution": "fixed once"}],
        "resolution": "fixed_unreviewed",
        "reviewedAfterFix": False,
        "reviewerBackend": "codex",
        "reviewerModel": "gpt-5.6-sol",
        "reviewerEffort": "high",
        "reviewerRound": 1,
        "reviewerModelStatus": "recorded",
        "commit_sha": commit,
    }
    output_path = os.path.join(base, "workflow.output.json")
    _write(output_path, {
        "summary": "fixture",
        "result": result,
        "workflowProgress": [{"type": "workflow_agent", "attempt": 1}],
        "totalTokens": 1234,
        "totalToolCalls": 3,
    })
    receipt_path = os.path.join(base, "reviews", os.path.basename(wt) + "-r1.json")
    _write(receipt_path, {
        "ran": True,
        "codex_exit": 0,
        "worktree": wt,
        "worktree_canonical": wt,
        "codex_parsed": {
            "overall_correctness": "patch is incorrect",
            "findings": findings,
        },
        "binding": {
            "bound": True,
            "gate_nonce": "%s:%s" % (trace_id, run_id),
            "round_actual": 1,
            "effort_actual": "high",
            "reviewer_model": "gpt-5.6-sol",
            "reviewer_backend": "codex",
        },
    })
    return {
        "base": base, "repo": repo, "feat_id": feat_id, "args": args, "state": state,
        "node": node, "worktree": wt, "commit": commit, "result_path": output_path,
        "receipt_path": receipt_path,
    }


def _direct_fixture(findings=None):
    findings = findings or []
    base = tempfile.mkdtemp(prefix="camus_kernel_direct_")
    repo = _repo()
    feat_id, args, state = _fixture(
        base, tasks=["implement the direct task contract"], statuses=["pending"],
        extra_args={"targetPath": repo},
    )
    node = state["tasks"][0]
    _git(repo, "branch", state["featBranch"])
    _git(repo, "checkout", "-q", state["featBranch"])
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "activeTaskId": node["taskId"],
        "repoHead": _git(repo, "rev-parse", "HEAD"),
        "budgets": {"wallSeconds": 1000, "tokens": 5000, "retries": 2},
        "seats": {
            "makerModel": "claude-opus-4-8", "reviewerBackend": "codex",
            "reviewerModel": "gpt-5.6-sol", "reviewerEffort": "high",
        },
        "usage": {"startedAt": 100, "tokens": 0, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    K.dispatch_task(feat_id, repo=repo, base=base, now=101)
    opened = K.open_task(feat_id, node["taskId"], repo=repo, base=base, now=102)
    worktree = opened["worktree"]
    with open(os.path.join(worktree, "direct.txt"), "w", encoding="utf-8") as fh:
        fh.write("candidate\n")
    receipt_path = os.path.join(base, "reviews", os.path.basename(worktree) + "-r1.json")
    _write(receipt_path, {
        "ran": True,
        "codex_exit": 0,
        "worktree": worktree,
        "worktree_canonical": worktree,
        "codex_parsed": {
            "overall_correctness": "patch is incorrect" if findings else "patch is correct",
            "findings": findings,
        },
        "binding": {
            "bound": True,
            "gate_nonce": "%s:%s" % (feat_id + ":a1", node["taskId"].rsplit("-", 1)[-1]),
            "round_actual": 1,
            "effort_actual": "high",
            "reviewer_model": "gpt-5.6-sol",
            "reviewer_backend": "codex",
        },
    })
    verdict = {
        "ran": True,
        "clean": not findings,
        "blocking": findings,
        "nonblocking": [],
    }
    return {
        "base": base, "repo": repo, "feat_id": feat_id, "args": args,
        "state": state, "node": node, "worktree": worktree, "verdict": verdict,
        "receipt_path": receipt_path,
    }


def _integration_fixture(statuses=None, advance_head=False):
    base = tempfile.mkdtemp(prefix="camus_kernel_integrate_")
    repo = _repo()
    statuses = statuses or ["done", "done_with_findings"]
    feat_id, args, state = _fixture(
        base, statuses=statuses, extra_args={"targetPath": repo},
    )
    _git(repo, "branch", state["featBranch"])
    _git(repo, "checkout", "-q", state["featBranch"])
    proven_head = _git(repo, "rev-parse", "HEAD")
    for node, status in zip(state["tasks"], statuses):
        node["provenStatus"] = "done_with_findings" if status == "done_with_findings" else "done"
        node["reconciledSha"] = proven_head
    state["status"] = "running"
    state["stage"] = "kernel_landed"
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "activeTaskId": None,
        "repoHead": proven_head,
        "budgets": {"wallSeconds": 1000, "tokens": 5000, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 100, "retries": 0},
    }
    if advance_head:
        with open(os.path.join(repo, "integration-fix.txt"), "w", encoding="utf-8") as fh:
            fh.write("bounded integration repair\n")
        _git(repo, "add", "integration-fix.txt")
        _git(repo, "commit", "-qm", "integration repair")
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    return {
        "base": base, "repo": repo, "feat_id": feat_id, "state": state,
        "proven_head": proven_head, "head": _git(repo, "rev-parse", "HEAD"),
    }


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
    assert payload["loopArgs"]["traceId"] == feat_id + ":a0"
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
                          retry_budget=2, maker_model="claude-opus-4-8",
                          reviewer_backend="codex", reviewer_model="gpt-5.6-sol",
                          reviewer_effort="high", base=base, now=100)
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
    assert persisted["kernel"]["seats"] == {
        "makerModel": "claude-opus-4-8", "reviewerBackend": "codex",
        "reviewerModel": "gpt-5.6-sol", "reviewerEffort": "high",
    }
    loop_args = K.task_payload(K._validated_run(feat_id, base))["loopArgs"]
    assert loop_args["envFacts"] == "- fixture fact"
    assert loop_args["model"] == "claude-opus-4-8"
    assert loop_args["reviewerModel"] == "gpt-5.6-sol"
    assert loop_args["reviewerEffort"] == "high"


def test_ready_boundary_reconfigures_seats_without_rerunning_baseline():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo},
    )
    _git(repo, "branch", state["featBranch"])
    _git(repo, "checkout", "-q", state["featBranch"])
    state["kernel"] = {
        "schemaVersion": 1, "traceId": feat_id + ":a1", "attempt": 1,
        "phase": "ready", "activeTaskId": state["tasks"][0]["taskId"],
        "repoHead": _git(repo, "rev-parse", "HEAD"),
        "budgets": {"wallSeconds": 1000, "tokens": 100, "retries": 2},
        "seats": {"makerModel": "sonnet", "reviewerBackend": "codex",
                  "reviewerModel": "gpt-5.6-sol", "reviewerEffort": "medium"},
        "usage": {"startedAt": 100, "tokens": 0, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    with mock.patch.object(K, "_run_verify") as verify:
        changed = K.configure_seats(
            feat_id, "claude-opus-4-8", "codex", "gpt-5.6-sol", "high",
            repo=repo, base=base, now=101,
        )
    assert verify.called is False
    assert changed["seatsChanged"] is True
    assert changed["seats"]["makerModel"] == "claude-opus-4-8"
    persisted = K._validated_run(feat_id, base)["state"]
    assert persisted["kernel"]["phase"] == "ready"
    assert persisted["kernel"]["repoHead"] == state["kernel"]["repoHead"]


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


def test_dispatch_atomically_marks_running_and_replays_without_duplicate_event():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "activeTaskId": state["tasks"][0]["taskId"],
        "repoHead": _git(repo, "rev-parse", "HEAD"),
        "budgets": {"wallSeconds": 1000, "tokens": 100, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 0, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    _git(repo, "branch", state["featBranch"])
    _git(repo, "checkout", "-q", state["featBranch"])
    first = K.dispatch_task(feat_id, repo=repo, base=base, now=101)
    second = K.dispatch_task(feat_id, repo=repo, base=base, now=102)
    assert first["dispatched"] is True and first["replayed"] is False
    assert second["dispatched"] is True and second["replayed"] is True
    persisted = K._validated_run(feat_id, base)["state"]
    assert persisted["tasks"][0]["status"] == "running"
    assert persisted["kernel"]["phase"] == "task_running"
    assert [event["msg"] for event in persisted["events"]].count(
        "Kernel %s:a1 dispatched %s" % (feat_id, state["tasks"][0]["taskId"])
    ) == 1


def test_dispatch_refuses_after_budget_exhaustion():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "activeTaskId": state["tasks"][0]["taskId"],
        "repoHead": _git(repo, "rev-parse", "HEAD"),
        "budgets": {"wallSeconds": None, "tokens": 10, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 10, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    try:
        K.dispatch_task(feat_id, repo=repo, base=base, now=101)
        assert False, "dispatch crossed an exhausted budget"
    except K.Refusal as exc:
        assert "token budget exhausted" in str(exc)
    assert K._validated_run(feat_id, base)["nodes"][0]["status"] == "pending"


def test_dispatch_refuses_if_checkout_moved_after_prepare():
    base = tempfile.mkdtemp(prefix="camus_kernel_")
    repo = _repo()
    feat_id, _args, state = _fixture(
        base, tasks=["run me"], statuses=["pending"], extra_args={"targetPath": repo}
    )
    _git(repo, "branch", state["featBranch"])
    state["kernel"] = {
        "schemaVersion": 1,
        "traceId": feat_id + ":a1",
        "attempt": 1,
        "phase": "ready",
        "activeTaskId": state["tasks"][0]["taskId"],
        "repoHead": _git(repo, "rev-parse", "HEAD"),
        "budgets": {"wallSeconds": 1000, "tokens": 100, "retries": 2},
        "usage": {"startedAt": 100, "tokens": 0, "retries": 0},
    }
    _write(os.path.join(base, "feats", feat_id + ".json"), state)
    try:
        K.dispatch_task(feat_id, repo=repo, base=base, now=101)
        assert False, "dispatch accepted the base branch after feature prepare"
    except K.Refusal as exc:
        assert "checkout moved" in str(exc)
    assert K._validated_run(feat_id, base)["nodes"][0]["status"] == "pending"


def test_accept_ingests_runtime_metric_and_preserves_review_provenance_then_lands():
    world = _accept_fixture()
    green = {
        "pass": True, "tampered": False, "failures": [],
        "head": world["commit"], "checks": [{"name": "fixture"}],
    }
    with mock.patch.object(K, "_run_verify", return_value=green):
        accepted = K.accept_task(
            world["feat_id"], world["node"]["taskId"], world["result_path"],
            repo=world["repo"], base=world["base"], now=200,
        )
    assert accepted["action"] == "land_task"
    assert accepted["provenStatus"] == "done_with_findings"
    assert accepted["usage"]["tokens"] == 1234
    assert accepted["tokenMetric"] == "claude_workflow_totalTokens"
    assert accepted["reviewer"] == {
        "backend": "codex", "model": "gpt-5.6-sol", "effort": "high", "round": 1,
        "traceBinding": "exact",
    }
    pending = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert pending["status"] == "ready_to_merge"
    assert pending["provenStatus"] == "done_with_findings"
    assert pending["kernelEvidence"]["verification"]["head"] == world["commit"]

    # A crash/replay at the accept boundary revalidates evidence but does not duplicate audit rows.
    with mock.patch.object(K, "_run_verify", return_value=green):
        replayed = K.accept_task(
            world["feat_id"], world["node"]["taskId"], world["result_path"],
            repo=world["repo"], base=world["base"], now=999,
        )
    assert replayed["action"] == "land_task"
    replay_state = K._validated_run(world["feat_id"], world["base"])["state"]
    marker = "kernel accepted done_with_findings at %s" % world["commit"]
    assert [d.get("what") for d in replay_state["tasks"][0]["decisions"]].count(marker) == 1
    assert sum(" accepted " in e.get("msg", "") for e in replay_state["events"]) == 1
    assert replay_state["tasks"][0]["kernelEvidence"]["acceptedAt"] == 200

    landed = K.land_task(
        world["feat_id"], world["node"]["taskId"],
        repo=world["repo"], base=world["base"], now=201,
    )
    assert landed["landed"]["status"] == "done_with_findings"
    assert landed["action"] == "integrate"
    final = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert final["status"] == "done_with_findings"
    assert final["loopStatus"] == "kernel_landed"
    assert _git(world["repo"], "merge-base", "--is-ancestor", world["commit"], world["state"]["featBranch"]) == ""


def test_accept_refuses_result_finding_drift_without_mutating_state():
    world = _accept_fixture()
    result = json.load(open(world["result_path"], encoding="utf-8"))
    result["result"]["findings"][0]["body"] = "laundered reviewer wording"
    _write(world["result_path"], result)
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    before = open(state_path, encoding="utf-8").read()
    with mock.patch.object(K, "_run_verify") as verify:
        try:
            K.accept_task(
                world["feat_id"], world["node"]["taskId"], world["result_path"],
                repo=world["repo"], base=world["base"], now=200,
            )
            assert False, "drifted findings accepted"
        except K.Refusal as exc:
            assert "findings" in str(exc)
    assert not verify.called
    assert open(state_path, encoding="utf-8").read() == before


def test_accept_treats_p3_only_review_as_nonblocking_not_fixed_unreviewed():
    world = _accept_fixture(result_status="done")
    output = json.load(open(world["result_path"], encoding="utf-8"))
    output["result"]["findings"] = []
    output["result"].pop("resolution")
    output["result"].pop("reviewedAfterFix")
    _write(world["result_path"], output)
    review = json.load(open(world["receipt_path"], encoding="utf-8"))
    review["codex_parsed"]["overall_correctness"] = "patch is correct"
    review["codex_parsed"]["findings"] = [{
        "priority": 3, "title": "nit", "body": "nonblocking",
        "code_location": "task.txt:1", "confidence_score": 0.8,
    }]
    _write(world["receipt_path"], review)
    green = {"pass": True, "tampered": False, "head": world["commit"], "failures": []}
    with mock.patch.object(K, "_run_verify", return_value=green):
        accepted = K.accept_task(
            world["feat_id"], world["node"]["taskId"], world["result_path"],
            repo=world["repo"], base=world["base"], now=200,
        )
    assert accepted["provenStatus"] == "done"
    assert K._validated_run(world["feat_id"], world["base"])["nodes"][0]["status"] == "ready_to_merge"


def test_accept_refuses_malformed_reviewer_finding_instead_of_dropping_it():
    world = _accept_fixture(result_status="done")
    output = json.load(open(world["result_path"], encoding="utf-8"))
    output["result"]["findings"] = []
    output["result"].pop("resolution")
    output["result"].pop("reviewedAfterFix")
    _write(world["result_path"], output)
    review = json.load(open(world["receipt_path"], encoding="utf-8"))
    review["codex_parsed"]["findings"] = [{
        "priority": "P1", "title": "schema drift", "body": "must not disappear",
        "code_location": "task.txt:1", "confidence_score": 0.9,
    }]
    _write(world["receipt_path"], review)
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    before = open(state_path, encoding="utf-8").read()
    with mock.patch.object(K, "_run_verify") as verify:
        try:
            K.accept_task(
                world["feat_id"], world["node"]["taskId"], world["result_path"],
                repo=world["repo"], base=world["base"], now=200,
            )
            assert False, "malformed reviewer finding was silently dropped"
        except K.Refusal as exc:
            assert "schema-valid" in str(exc)
    assert not verify.called
    assert open(state_path, encoding="utf-8").read() == before


def test_land_recovers_when_merge_completed_before_state_checkpoint():
    world = _accept_fixture()
    green = {
        "pass": True, "tampered": False, "failures": [],
        "head": world["commit"], "checks": [{"name": "fixture"}],
    }
    with mock.patch.object(K, "_run_verify", return_value=green):
        K.accept_task(
            world["feat_id"], world["node"]["taskId"], world["result_path"],
            repo=world["repo"], base=world["base"], now=200,
        )
    accepted_run = K._validated_run(world["feat_id"], world["base"])
    first_receipt = K._run_merge(accepted_run, world["repo"], accepted_run["nodes"][0])
    assert first_receipt["committed"] is True

    # Simulate a crash before the state checkpoint: land replays the merge, receives
    # alreadyUpToDate, and must compare the durable priorMergeCommit rather than current HEAD.
    landed = K.land_task(
        world["feat_id"], world["node"]["taskId"],
        repo=world["repo"], base=world["base"], now=201,
    )
    assert landed["landed"]["status"] == "done_with_findings"
    assert landed["landed"]["mergeCommit"] == first_receipt["after"]


def test_accept_refuses_headless_green_without_mutating_state():
    world = _accept_fixture()
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    before = open(state_path, encoding="utf-8").read()
    with mock.patch.object(K, "_run_verify", return_value={
        "pass": True, "tampered": False, "head": None, "failures": [],
    }):
        try:
            K.accept_task(
                world["feat_id"], world["node"]["taskId"], world["result_path"],
                repo=world["repo"], base=world["base"], now=200,
            )
            assert False, "headless green accepted"
        except K.Refusal as exc:
            assert "not bound" in str(exc)
    assert open(state_path, encoding="utf-8").read() == before


def test_direct_lane_opens_reviews_seals_and_lands_without_model_relays():
    world = _direct_fixture()
    with mock.patch.object(K, "_run_direct_review", return_value=world["verdict"]):
        reviewed = K.review_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=103,
        )
    assert reviewed["action"] == "seal" and reviewed["clean"] is True

    def green(_run, worktree, _timeout):
        return {
            "pass": True, "tampered": False, "failures": [],
            "head": _git(worktree, "rev-parse", "HEAD"),
        }

    with mock.patch.object(K, "_run_verify", side_effect=green):
        sealed = K.seal_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=104,
        )
    assert sealed["provenStatus"] == "done"
    landed = K.land_task(
        world["feat_id"], world["node"]["taskId"],
        repo=world["repo"], base=world["base"], now=105,
    )
    assert landed["landed"]["status"] == "done"
    assert _git(world["repo"], "merge-base", "--is-ancestor", sealed["commit"], world["state"]["featBranch"]) == ""


def test_direct_review_normalizes_a_maker_commit_without_losing_the_candidate():
    world = _direct_fixture()
    _git(world["worktree"], "add", "direct.txt")
    _git(world["worktree"], "commit", "-qm", "maker ignored the no-commit contract")
    committed = _git(world["worktree"], "rev-parse", "HEAD")
    base_commit = K._validated_run(world["feat_id"], world["base"])["nodes"][0]["directBaseCommit"]
    assert committed != base_commit
    assert _git(world["worktree"], "status", "--porcelain", "--untracked-files=all") == ""

    def review(_run, _repo, _node, worktree, *_args, **_kwargs):
        assert _git(worktree, "rev-parse", "HEAD") == base_commit
        assert "direct.txt" in _git(worktree, "status", "--porcelain", "--untracked-files=all")
        assert "candidate" in _git(worktree, "diff", "--", "direct.txt")
        return world["verdict"]

    with mock.patch.object(K, "_run_direct_review", side_effect=review):
        reviewed = K.review_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=103,
        )
    assert reviewed["clean"] is True
    node = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert node["makerCommitRecovery"] == {
        "fromHead": committed, "baseCommit": base_commit, "recoveredAt": 103,
        "mode": "mixed_reset_files_preserved",
    }


def test_direct_maker_usage_keeps_units_separate_and_is_idempotent():
    world = _direct_fixture()
    result_path = os.path.join(world["base"], "claude-result.json")
    _write(result_path, {
        "is_error": False,
        "duration_ms": 2000,
        "duration_api_ms": 1800,
        "num_turns": 3,
        "total_cost_usd": 1.25,
        "terminal_reason": "completed",
        "permission_denials": [],
        "usage": {
            "input_tokens": 7,
            "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 500,
            "output_tokens": 40,
        },
        "modelUsage": {
            "claude-opus-4-8": {
                "inputTokens": 7,
                "cacheCreationInputTokens": 100,
                "cacheReadInputTokens": 500,
                "outputTokens": 40,
                "costUSD": 1.25,
                "canonicalModel": "claude-opus-4-8",
                "provider": "firstParty",
            },
        },
        "result": "content is deliberately not persisted in state",
    })
    recorded = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], result_path,
        repo=world["repo"], base=world["base"], now=103,
    )
    assert recorded["idempotent"] is False
    assert recorded["totals"] == {
        "inputTokens": 7, "cacheCreationInputTokens": 100,
        "cacheReadInputTokens": 500, "outputTokens": 40,
        "costUsd": 1.25, "durationMs": 2000, "turns": 3, "calls": 1,
    }
    assert recorded["budgetUsage"]["tokens"] == 0, "unlike direct metrics never enter legacy token usage"
    assert recorded["budgetUsage"]["directOutputTokens"] == 40, "direct output has its own budget metric"
    node = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    receipt = node["directMakerUsage"]["receipts"][0]
    assert receipt["modelRequested"] == "claude-opus-4-8"
    assert receipt["candidateFingerprint"].startswith("candidate1:")
    assert "result" not in receipt and "session_id" not in receipt, "maker content/session data is not persisted"

    replay = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], result_path,
        repo=world["repo"], base=world["base"], now=104,
    )
    assert replay["idempotent"] is True
    assert replay["totals"] == recorded["totals"]
    assert replay["budgetUsage"] == recorded["budgetUsage"]
    node = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert len(node["directMakerUsage"]["receipts"]) == 1

    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    state = json.load(open(state_path, encoding="utf-8"))
    state["kernel"]["budgets"]["tokens"] = 40
    _write(state_path, state)
    stopped = K._envelope(K._validated_run(world["feat_id"], world["base"]), repo=world["repo"], now=105)
    assert stopped["action"] == "stop"
    assert stopped["reason"] == "direct output-token budget exhausted (40/40)"


def test_direct_maker_usage_refuses_unbound_model_without_state_mutation():
    world = _direct_fixture()
    result_path = os.path.join(world["base"], "wrong-model.json")
    _write(result_path, {
        "is_error": False, "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1,
        "total_cost_usd": 0, "permission_denials": [],
        "usage": {"output_tokens": 1},
        "modelUsage": {"claude-sonnet-4-6": {"outputTokens": 1, "costUSD": 0}},
    })
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    before = open(state_path, encoding="utf-8").read()
    try:
        K.record_maker_usage(
            world["feat_id"], world["node"]["taskId"], result_path,
            repo=world["repo"], base=world["base"], now=103,
        )
        assert False, "usage from an unbound maker model was accepted"
    except K.Refusal as exc:
        assert "pinned model" in str(exc)
    assert open(state_path, encoding="utf-8").read() == before


def test_direct_maker_usage_refuses_zero_output_from_the_pinned_model():
    world = _direct_fixture()
    result_path = os.path.join(world["base"], "zero-pinned-output.json")
    _write(result_path, {
        "is_error": False, "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1,
        "total_cost_usd": 0, "permission_denials": [],
        "usage": {"output_tokens": 50},
        "modelUsage": {
            "claude-opus-4-8": {"outputTokens": 0, "costUSD": 0},
            "claude-sonnet-4-6": {"outputTokens": 50, "costUSD": 0},
        },
    })
    try:
        K.record_maker_usage(
            world["feat_id"], world["node"]["taskId"], result_path,
            repo=world["repo"], base=world["base"], now=103,
        )
        assert False, "mere presence of the pinned model was accepted as use"
    except K.Refusal as exc:
        assert "nonzero output" in str(exc)


def test_seats_refuse_the_same_maker_and_reviewer_model():
    world = _direct_fixture()
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    state = json.load(open(state_path, encoding="utf-8"))
    state["kernel"]["seats"]["reviewerModel"] = "claude-opus-4-8"
    _write(state_path, state)
    run = K._validated_run(world["feat_id"], world["base"])
    try:
        K._seats(run)
        assert False, "the same maker/reviewer model was accepted"
    except K.Refusal as exc:
        assert "different models" in str(exc)


def test_direct_clean_review_refuses_a_late_untracked_file():
    world = _direct_fixture()
    with mock.patch.object(K, "_run_direct_review", return_value=world["verdict"]):
        K.review_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=103,
        )
    with open(os.path.join(world["worktree"], "late.txt"), "w", encoding="utf-8") as fh:
        fh.write("not reviewed\n")
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    before = open(state_path, encoding="utf-8").read()
    with mock.patch.object(K, "_run_verify") as verify:
        try:
            K.seal_task(
                world["feat_id"], world["node"]["taskId"],
                repo=world["repo"], base=world["base"], now=104,
            )
            assert False, "late untracked content retained clean-review standing"
        except K.Refusal as exc:
            assert "changed after its clean review" in str(exc)
    assert not verify.called
    assert open(state_path, encoding="utf-8").read() == before


def test_direct_fixed_candidate_preserves_blocking_findings():
    findings = [{
        "priority": 1, "title": "real defect", "body": "fix the candidate",
        "code_location": "direct.txt:1", "confidence_score": 0.98,
    }]
    world = _direct_fixture(findings=findings)
    with mock.patch.object(K, "_run_direct_review", return_value=world["verdict"]):
        reviewed = K.review_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=103,
        )
    assert reviewed["action"] == "fix_then_seal"
    with open(os.path.join(world["worktree"], "direct.txt"), "a", encoding="utf-8") as fh:
        fh.write("fixed\n")

    def green(_run, worktree, _timeout):
        return {
            "pass": True, "tampered": False, "failures": [],
            "head": _git(worktree, "rev-parse", "HEAD"),
        }

    with mock.patch.object(K, "_run_verify", side_effect=green):
        sealed = K.seal_task(
            world["feat_id"], world["node"]["taskId"], fixed_unreviewed=True,
            repo=world["repo"], base=world["base"], now=104,
        )
    assert sealed["provenStatus"] == "done_with_findings"
    node = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert node["deferredFindings"] == findings


def test_direct_seal_retries_verification_without_a_second_commit():
    world = _direct_fixture()
    with mock.patch.object(K, "_run_direct_review", return_value=world["verdict"]):
        K.review_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=103,
        )
    with mock.patch.object(K, "_run_verify", return_value={
        "pass": False, "tampered": False, "failures": [{"name": "fixture"}],
        "head": None,
    }):
        stopped = K.seal_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=104,
        )
    assert stopped["action"] == "stop"
    sealed_commit = stopped["commit"]
    failed = K._validated_run(world["feat_id"], world["base"])["state"]
    assert failed["kernel"]["phase"] == "task_verify_failed"

    green = {
        "pass": True, "tampered": False, "failures": [], "head": sealed_commit,
    }
    with mock.patch.object(K, "_run_verify", return_value=green):
        recovered = K.seal_task(
            world["feat_id"], world["node"]["taskId"],
            repo=world["repo"], base=world["base"], now=105,
        )
    assert recovered["commit"] == sealed_commit
    assert _git(world["worktree"], "rev-list", "--count", "%s..HEAD" % world["state"]["kernel"]["repoHead"]) == "1"


def test_integrate_closes_the_exact_descendant_head_and_replays_idempotently():
    world = _integration_fixture(advance_head=True)
    green = {
        "pass": True, "inconclusive": False, "tampered": False,
        "failures": [], "head": world["head"],
    }
    with (
        mock.patch.object(K, "_receipt_evidence", return_value=world["proven_head"]) as receipts,
        mock.patch.object(K.env_check, "check_env", return_value=[]),
        mock.patch.object(K.env_check, "collect_facts", return_value=["fixture ready"]),
        mock.patch.object(K, "_run_verify", return_value=green) as verify,
    ):
        result = K.integrate_feature(
            world["feat_id"], repo=world["repo"], base=world["base"], now=200,
        )
    assert result["action"] == "feature_complete"
    assert result["status"] == "done_with_findings"
    assert result["head"] == world["head"] and result["mainMerged"] is False
    assert receipts.call_count == 2 and verify.call_count == 1
    state = K._validated_run(world["feat_id"], world["base"])["state"]
    assert state["status"] == "done_with_findings"
    assert state["kernel"]["phase"] == "integrated"
    assert state["kernel"]["integrationHead"] == world["head"]
    assert state["integration"]["head"] == world["head"]
    assert set(state["integrationMergeEvidence"]) == {
        node["taskId"] for node in state["tasks"]
    }
    report_path = os.path.join(world["base"], "reports", world["feat_id"] + ".json")
    report = json.load(open(report_path, encoding="utf-8"))
    assert report["status"] == "done_with_findings"
    assert report["integration"]["head"] == world["head"]
    assert [node["status"] for node in report["tasks"]] == ["done", "done_with_findings"]

    _write(report_path, {"status": "needs_human", "tasks": []})
    with mock.patch.object(K, "_run_verify") as replay_verify:
        replay = K.integrate_feature(
            world["feat_id"], repo=world["repo"], base=world["base"], now=201,
        )
    assert replay["idempotent"] is True
    assert replay["head"] == world["head"]
    assert not replay_verify.called, "same-head replay must not rerun the expensive verifier"
    repaired_report = json.load(open(report_path, encoding="utf-8"))
    assert repaired_report["status"] == "done_with_findings"
    assert len(repaired_report["tasks"]) == 2, "idempotent replay repairs a stale report snapshot"

    with open(os.path.join(world["repo"], "report-repair.txt"), "w", encoding="utf-8") as fh:
        fh.write("integration-only repair\n")
    _git(world["repo"], "add", "report-repair.txt")
    _git(world["repo"], "commit", "-qm", "report repair")
    repaired_head = _git(world["repo"], "rev-parse", "HEAD")
    reintegration_green = {**green, "head": repaired_head}
    with (
        mock.patch.object(K, "_receipt_evidence", return_value=world["proven_head"]),
        mock.patch.object(K.env_check, "check_env", return_value=[]),
        mock.patch.object(K.env_check, "collect_facts", return_value=[]),
        mock.patch.object(K, "_run_verify", return_value=reintegration_green) as reintegration_verify,
    ):
        reintegrated = K.integrate_feature(
            world["feat_id"], repo=world["repo"], base=world["base"], now=202,
        )
    assert reintegrated["idempotent"] is False and reintegrated["head"] == repaired_head
    assert reintegration_verify.call_count == 1
    reintegrated_state = K._validated_run(world["feat_id"], world["base"])["state"]
    assert reintegrated_state["integration"]["head"] == repaired_head
    assert [item["head"] for item in reintegrated_state["integrationHistory"]] == [world["head"]]


def test_integrate_preserves_noop_status_without_inventing_plain_done():
    world = _integration_fixture(statuses=["done", "noop"])
    green = {
        "pass": True, "inconclusive": False, "tampered": False,
        "failures": [], "head": world["head"],
    }
    with (
        mock.patch.object(K, "_receipt_evidence", return_value=world["proven_head"]),
        mock.patch.object(K.env_check, "check_env", return_value=[]),
        mock.patch.object(K.env_check, "collect_facts", return_value=[]),
        mock.patch.object(K, "_run_verify", return_value=green),
    ):
        result = K.integrate_feature(
            world["feat_id"], repo=world["repo"], base=world["base"], now=200,
        )
    assert result["status"] == "done_with_noops"


def test_integrate_refusals_leave_state_unchanged():
    cases = []

    dirty = _integration_fixture()
    with open(os.path.join(dirty["repo"], "dirty.txt"), "w", encoding="utf-8") as fh:
        fh.write("untracked\n")
    cases.append((dirty, {}, "dirty"))

    missing = _integration_fixture()
    cases.append((missing, {"receipt": None}, "no durable merge receipt"))

    headless = _integration_fixture()
    cases.append((headless, {"verify_head": "0" * 40}, "not bound"))

    incomplete = _integration_fixture(statuses=["done", "pending"])
    cases.append((incomplete, {}, "every task"))

    for world, behavior, expected in cases:
        state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
        before = open(state_path, encoding="utf-8").read()
        green = {
            "pass": True, "inconclusive": False, "tampered": False,
            "failures": [], "head": behavior.get("verify_head", world["head"]),
        }
        receipt = behavior.get("receipt", world["proven_head"])
        with (
            mock.patch.object(K, "_receipt_evidence", return_value=receipt),
            mock.patch.object(K.env_check, "check_env", return_value=[]),
            mock.patch.object(K.env_check, "collect_facts", return_value=[]),
            mock.patch.object(K, "_run_verify", return_value=green),
        ):
            try:
                K.integrate_feature(
                    world["feat_id"], repo=world["repo"], base=world["base"], now=200,
                )
                assert False, "integration refusal case was accepted"
            except K.Refusal as exc:
                assert expected in str(exc), str(exc)
        assert open(state_path, encoding="utf-8").read() == before


def test_integrate_refuses_budget_exhaustion_and_non_descendant_tip():
    budget = _integration_fixture()
    state_path = os.path.join(budget["base"], "feats", budget["feat_id"] + ".json")
    state = json.load(open(state_path, encoding="utf-8"))
    state["kernel"]["budgets"]["tokens"] = 100
    _write(state_path, state)
    try:
        K.integrate_feature(
            budget["feat_id"], repo=budget["repo"], base=budget["base"], now=200,
        )
        assert False, "budget-exhausted integration was accepted"
    except K.Refusal as exc:
        assert "budget exhausted" in str(exc)

    moved = _integration_fixture()
    state_path = os.path.join(moved["base"], "feats", moved["feat_id"] + ".json")
    state = json.load(open(state_path, encoding="utf-8"))
    state["kernel"]["repoHead"] = "0" * 40
    _write(state_path, state)
    try:
        K.integrate_feature(
            moved["feat_id"], repo=moved["repo"], base=moved["base"], now=200,
        )
        assert False, "non-descendant integration tip was accepted"
    except K.Refusal as exc:
        assert "no longer descends" in str(exc)


def test_background_usage_receipt_is_model_bound_and_content_free():
    world = _direct_fixture()
    path = os.path.join(world["base"], "background.json")
    _write(path, {
        "source": "claude_background_session",
        "state": "done",
        "sessionId": "12345678-1234-1234-1234-123456789abc",
        "shortId": "12345678",
        "modelRequested": "claude-opus-4-8",
        "modelActual": "claude-opus-4-8",
        "modelsObserved": ["claude-opus-4-8"],
        "transcriptSha256": "sha256:" + "a" * 64,
        "durationMs": 42,
        "toolCalls": 3,
        "usage": {"inputTokens": 5, "cacheCreationInputTokens": 7,
                  "cacheReadInputTokens": 11, "outputTokens": 13},
        "billingMode": "claude_ai_account_quota",
    })
    recorded = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], path, source="background",
        repo=world["repo"], base=world["base"], now=103,
    )
    assert recorded["receipt"]["source"] == "claude_background_session"
    assert recorded["receipt"]["transcriptSha256"].startswith("sha256:")
    assert recorded["totals"]["outputTokens"] == 13
    assert recorded["budgetUsage"]["directOutputTokens"] == 13
    assert "lastAssistantText" not in recorded["receipt"]


def test_background_usage_deduplicates_the_sealed_session_not_the_recovery_wrapper():
    world = _direct_fixture()
    path = os.path.join(world["base"], "background-recovered.json")
    payload = {
        "source": "claude_background_session", "state": "done",
        "sessionId": "12345678-1234-1234-1234-123456789abc", "shortId": "12345678",
        "modelRequested": "claude-opus-4-8", "modelActual": "claude-opus-4-8",
        "modelsObserved": ["claude-opus-4-8"],
        "transcriptSha256": "sha256:" + "c" * 64,
        "durationMs": 42, "toolCalls": 3,
        "usage": {"inputTokens": 5, "cacheCreationInputTokens": 7,
                  "cacheReadInputTokens": 11, "outputTokens": 13},
        "billingMode": "claude_ai_account_quota",
    }
    _write(path, payload)
    first = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], path, source="background",
        repo=world["repo"], base=world["base"], now=103,
    )
    payload["endedAt"] = 999  # recovered transport metadata changes the file hash, not the turn
    _write(path, payload)
    replay = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], path, source="background",
        repo=world["repo"], base=world["base"], now=104,
    )
    assert replay["idempotent"] is True
    assert replay["receipt"]["receiptSha256"] == first["receipt"]["receiptSha256"]
    assert replay["budgetUsage"]["directOutputTokens"] == 13

    # Repair an already-affected 0.4.1 state on the next idempotent ingestion.
    state_path = os.path.join(world["base"], "feats", world["feat_id"] + ".json")
    state = json.load(open(state_path, encoding="utf-8"))
    direct = state["tasks"][0]["directMakerUsage"]
    duplicate = dict(direct["receipts"][0])
    duplicate.update({"receiptSha256": "f" * 64, "sequence": 2,
                      "head": "e" * 40, "candidateFingerprint": "candidate1:" + "d" * 64})
    direct["receipts"].append(duplicate)
    direct["totals"] = {key: value * 2 if isinstance(value, int) else value
                        for key, value in direct["totals"].items()}
    _write(state_path, state)
    assert K._usage(state)["directOutputTokens"] == 13
    repaired = K.record_maker_usage(
        world["feat_id"], world["node"]["taskId"], path, source="background",
        repo=world["repo"], base=world["base"], now=105,
    )
    assert repaired["idempotent"] is True
    repaired_node = K._validated_run(world["feat_id"], world["base"])["nodes"][0]
    assert len(repaired_node["directMakerUsage"]["receipts"]) == 1
    assert repaired_node["directMakerUsage"]["totals"]["outputTokens"] == 13


def test_direct_review_host_timeout_covers_the_high_effort_watchdog_chunk():
    run = {
        "base": "/tmp/camus", "state": {"kernel": {"traceId": "feat:a1"}},
        "nodes": [{"taskId": "task-abc123"}], "specs": ["bounded task"],
    }
    calls = [
        {"ok": True},
        {"pending": True, "handle": "/tmp/camus/reviews/task-r1.watch"},
        {"ran": True, "clean": True, "blocking": [], "nonblocking": []},
    ]
    with mock.patch.object(K, "_json_command", side_effect=calls) as command:
        verdict = K._run_direct_review(
            run, "/tmp/repo", run["nodes"][0], "/tmp/worktree",
            "codex", "gpt-5.6-sol", "high", round_no=1,
        )
    assert verdict["ran"] is True
    assert command.call_args_list[1].kwargs["timeout"] == K.DIRECT_REVIEW_HOST_TIMEOUT
    assert command.call_args_list[2].kwargs["timeout"] == K.DIRECT_REVIEW_HOST_TIMEOUT
    assert K.DIRECT_REVIEW_HOST_TIMEOUT > 480


def test_background_usage_refuses_observed_model_substitution():
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "background.json")
        _write(path, {
            "source": "claude_background_session", "state": "done",
            "sessionId": "12345678-1234-1234-1234-123456789abc",
            "modelRequested": "claude-opus-4-8", "modelActual": "claude-haiku-4-5",
            "modelsObserved": ["claude-haiku-4-5"],
            "transcriptSha256": "sha256:" + "b" * 64,
            "durationMs": 1, "toolCalls": 0,
            "usage": {"inputTokens": 1, "outputTokens": 2},
            "billingMode": "claude_ai_account_quota",
        })
        try:
            K._background_usage_receipt(path, "claude-opus-4-8")
            assert False, "observed model substitution accepted"
        except K.Refusal as exc:
            assert "pinned model" in str(exc)


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
