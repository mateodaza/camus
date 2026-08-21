#!/usr/bin/env python3
"""Native Camus 0.4.1 driver: models do semantic work; code owns orchestration.

The driver intentionally reuses ``feat_kernel`` instead of reimplementing custody.  Claude Code
background sessions edit kernel-owned task worktrees using proven claude.ai account auth. Codex reviews the
candidate directly.  A small controller model is called only when a semantic fork exists (fix and
re-review, fix once with explicit findings provenance, or stop for a human).  Git, status polling,
receipts, verification, merge, and experiment assignment stay deterministic.
"""

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
import tempfile
import time

import background_agent
import evals
import feat_kernel as kernel
import resume_scan


DRIVER_SCHEMA = 1
DIRECT_OUTPUT_RESERVE_MIN = 10_000
DIRECT_OUTPUT_RESERVE_FRACTION = 0.25
ALLOWED_SPEC_FIELDS = {
    "feat", "tasks", "targetPath", "policy", "model", "modelTier", "roundCap",
    "budgetTokens", "verifyCmd", "posture", "answers", "taskClass",
}
CONTROLLER_ACTIONS = {"fix_recheck", "fix_verify", "retry_verify", "human", "stop"}


class DriverError(Exception):
    pass


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _read_object(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError) as exc:
        raise DriverError("could not read JSON %s: %s" % (path, exc))
    if not isinstance(value, dict):
        raise DriverError("JSON input must be an object")
    return value


def _atomic(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    fd, tmp = tempfile.mkstemp(prefix=".camus-driver-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _git(repo, *args):
    code, output = kernel._git(repo, *args)
    if code != 0:
        raise DriverError("git %s failed: %s" % (" ".join(args), output or "unknown error"))
    return output


def _brief(value, maximum=160):
    text = re.sub(r"\s+", " ", value).strip()
    return text if len(text) <= maximum else text[:maximum - 1].rstrip() + "…"


class EventLog:
    """Append-only resumable trace. It records identities and metrics, never prompts or diffs."""

    def __init__(self, feat_id, base=None):
        base = base or kernel.camus_home()
        self.path = os.path.join(base, "sessions", feat_id + ".events.jsonl")
        self.lock_path = self.path + ".lock"

    @contextlib.contextmanager
    def _lock(self):
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        with open(self.lock_path, "a+", encoding="utf-8") as fh:
            os.chmod(self.lock_path, 0o600)
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def records(self):
        return evals.read_jsonl(self.path, strict=True)

    def latest(self, event_type, key=None):
        for event in reversed(self.records()):
            if event.get("type") == event_type and (key is None or event.get("key") == key):
                return event
        return None

    def append(self, event_type, *, trace_id, task_id=None, key=None, data=None):
        with self._lock():
            existing = evals.read_jsonl(self.path, strict=True)
            if key and any(row.get("type") == event_type and row.get("key") == key for row in existing):
                return False
            event = {
                "schemaVersion": DRIVER_SCHEMA,
                "seq": max([row.get("seq", 0) for row in existing] or [0]) + 1,
                "at": int(time.time()),
                "type": event_type,
                "traceId": trace_id,
            }
            if task_id:
                event["taskId"] = task_id
            if key:
                event["key"] = key
            if isinstance(data, dict) and data:
                event["data"] = data
            with open(self.path, "a", encoding="utf-8") as fh:
                os.chmod(self.path, 0o600)
                fh.write(_canonical(event) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        return True


def _normalized_spec(value):
    unknown = set(value) - ALLOWED_SPEC_FIELDS
    if unknown:
        raise DriverError("unknown feature spec fields: %s" % ", ".join(sorted(unknown)))
    feat = value.get("feat")
    tasks = value.get("tasks")
    if not isinstance(feat, str) or not feat.strip():
        raise DriverError("feature spec needs a non-empty feat")
    if not isinstance(tasks, list) or not tasks or not all(isinstance(task, str) and task.strip() for task in tasks):
        raise DriverError("feature spec needs a non-empty string task list")
    target = value.get("targetPath") or os.getcwd()
    target = os.path.realpath(os.path.abspath(target))
    repo = os.path.realpath(_git(target, "rev-parse", "--show-toplevel"))
    if _git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise DriverError("repository must be clean before camus start")
    branch = _git(repo, "branch", "--show-current")
    if not branch or branch.startswith("camus/"):
        raise DriverError("camus start requires a named non-Camus base branch")
    args = {"argsVersion": 1, "feat": feat.strip(), "tasks": [task.strip() for task in tasks]}
    for name in ALLOWED_SPEC_FIELDS - {"feat", "tasks"}:
        if name in value:
            args[name] = value[name]
    args["targetPath"] = repo
    args.setdefault("policy", "ask_on_ambiguity")
    args.setdefault("posture", "full")
    if args["policy"] not in ("autonomous", "ask_on_ambiguity", "ask_on_major"):
        raise DriverError("policy must be autonomous|ask_on_ambiguity|ask_on_major")
    if args["posture"] not in ("full", "oneshot"):
        raise DriverError("posture must be full|oneshot")
    if "taskClass" in args and (not isinstance(args["taskClass"], str) or not args["taskClass"].strip()):
        raise DriverError("taskClass must be a non-empty string")
    if "roundCap" in args and (isinstance(args["roundCap"], bool)
                               or not isinstance(args["roundCap"], int) or args["roundCap"] < 1):
        raise DriverError("roundCap must be a positive integer")
    return args, repo, branch


def start_feature(spec_path, base=None):
    """Create canonical feature state without spending a model turn."""
    args, repo, base_branch = _normalized_spec(_read_object(spec_path))
    feat_id = resume_scan._feat_id(args)
    feat_branch = "camus/feat-" + feat_id
    base = base or kernel.camus_home()
    feats = os.path.join(base, "feats")
    state_path = os.path.join(feats, feat_id + ".json")
    args_ref = feat_id + ".args.json"
    args_path = os.path.join(feats, args_ref)
    if os.path.exists(state_path):
        run = kernel._validated_run(feat_id, base)
        if run["args"] != args:
            raise DriverError("existing feature id has different canonical args")
        return {"action": "feature_exists", "featId": feat_id, "branch": feat_branch,
                "state": state_path, "args": args_path}
    head = _git(repo, "rev-parse", "HEAD")
    code, _output = kernel._git(repo, "show-ref", "--verify", "--quiet", "refs/heads/" + feat_branch)
    if code != 0:
        _git(repo, "branch", feat_branch, head)
    elif _git(repo, "rev-parse", feat_branch) != head:
        raise DriverError("feature branch already exists at a different base")
    nodes = []
    for task in args["tasks"]:
        task_id = kernel._task_id(feat_id, task)
        nodes.append({
            "taskId": task_id,
            "brief": _brief(task),
            "dependsOn": [],
            "status": "pending",
            "branch": "camus/feat/%s/%s" % (feat_id, task_id),
            "loopStatus": None,
        })
    state = {
        "featId": feat_id,
        "feat": args["feat"],
        "featBranch": feat_branch,
        "base": base_branch,
        "resumeArgsRef": args_ref,
        "resumeArgsHash": resume_scan._args_hash(args),
        "tasks": nodes,
        "baseline": None,
        "env": None,
        "envRecheck": None,
        "integration": None,
        "status": "running",
        "stage": "native_initialized",
        "events": [{"seq": 1, "msg": "Native driver initialized feature from %s" % head}],
        "eventSeq": 1,
    }
    _atomic(args_path, args)
    _atomic(state_path, state)
    return {"action": "feature_created", "featId": feat_id, "branch": feat_branch,
            "base": base_branch, "head": head, "state": state_path, "args": args_path}


def _session_name(feat_id, task_id, role, attempt):
    return "camus-%s-%s-%s-r%d" % (feat_id[-12:], task_id[-10:], role, attempt)


def _public_receipt(receipt):
    allowed = {
        "shortId", "sessionId", "name", "cwd", "state", "startedAt", "endedAt", "durationMs",
        "modelRequested", "modelActual", "modelsObserved", "effortRequested", "billingMode",
        "surface", "transcriptSha256", "usage", "toolCalls", "terminalReason",
        "terminalTurnMarker", "terminalTurnDurationMs", "terminalTurnAt", "sessionWallMs",
    }
    out = {key: receipt[key] for key in allowed if key in receipt}
    out["source"] = "claude_background_session"
    return out


def _recover_completed(receipt):
    path = background_agent.transcript_path(receipt.get("cwd"), receipt.get("sessionId"))
    enriched = background_agent.transcript_receipt(
        path, requested_model=receipt.get("modelRequested"),
        requested_effort=receipt.get("effortRequested"),
    )
    # A missing transcript is an expected recovery condition (for example, after retention or
    # a host crash).  Preserve the sealed event in full; an empty enrichment must not erase its
    # usage, hash, or event duration.
    if not enriched.get("transcriptPath") or not enriched.get("transcriptSha256"):
        return dict(receipt)
    stored_hash = receipt.get("transcriptSha256")
    if stored_hash is not None and enriched.get("transcriptSha256") != stored_hash:
        raise background_agent.BackgroundAgentError(
            "completed background transcript hash drifted; refusing to rebind evidence"
        )
    recovered = {**receipt, **enriched}
    terminal_duration = enriched.get("terminalTurnDurationMs")
    if isinstance(terminal_duration, int) and terminal_duration >= 0:
        if "sessionWallMs" not in receipt:
            recovered["sessionWallMs"] = receipt.get("durationMs")
        recovered["durationMs"] = terminal_duration
    return recovered


def run_agent(client, log, *, trace_id, feat_id, task_id, role, attempt, cwd, prompt,
              model, effort, timeout, tools=None):
    key = "%s:%s:%d" % (task_id, role, attempt)
    completed = log.latest("agent.completed", key)
    if completed and isinstance(completed.get("data"), dict):
        return _recover_completed(completed["data"])
    name = _session_name(feat_id, task_id, role, attempt)
    pending_input = log.latest("agent.needs_input", key)
    live = client.find(cwd, name=name)
    if live:
        auth = client.auth_status(cwd)
        if auth.get("loggedIn") is not True or auth.get("authMethod") != "claude.ai":
            raise background_agent.BackgroundAgentError(
                "refusing to adopt a background session without current claude.ai account auth"
            )
        session = {
            "shortId": live.get("id"), "sessionId": live.get("sessionId"), "name": name,
            "cwd": os.path.realpath(cwd), "state": live.get("state") or "working",
            "startedAt": live.get("startedAt") or int(time.time() * 1000),
            "modelRequested": model, "effortRequested": effort,
            "billingMode": "claude_ai_account_quota", "surface": "claude_background_session",
        }
        log.append("agent.adopted", trace_id=trace_id, task_id=task_id, key=key,
                   data={"sessionId": session["sessionId"], "name": name})
    else:
        if pending_input:
            raise background_agent.BackgroundAgentError(
                "session awaiting human input is no longer discoverable; inspect claude logs before retrying"
            )
        log.append("agent.intent", trace_id=trace_id, task_id=task_id, key=key,
                   data={"role": role, "model": model, "effort": effort})
        session = client.launch(prompt, cwd, name, model, effort=effort, tools=tools)
        log.append("agent.launched", trace_id=trace_id, task_id=task_id, key=key,
                   data={"sessionId": session["sessionId"], "shortId": session["shortId"], "name": name})
        print("  %s session %s launched (%s/%s)" % (role, session["shortId"], model, effort), flush=True)
    receipt = client.wait(session, timeout_seconds=timeout)
    public = _public_receipt(receipt)
    log.append(
        "agent.needs_input" if receipt.get("state") == "needs_input" else "agent.completed",
        trace_id=trace_id, task_id=task_id, key=key, data=public,
    )
    return receipt


def _maker_prompt(payload, findings=None):
    task = payload["loopArgs"]["task"]
    if findings:
        task = (
            "Fix the independently reviewed candidate in this worktree. Preserve working behavior, "
            "run the repository's relevant deterministic checks, and address these exact blocking "
            "findings:\n" + json.dumps(findings, ensure_ascii=False, indent=2)[:12000]
        )
    return """You are the maker in a Camus run. Work only in the current linked worktree.
Implement the task completely, inspect the existing architecture before editing, and run the
smallest relevant deterministic tests. Do not commit, merge, push, publish, edit another worktree,
or modify Camus run state. Finish with a concise result and tests run.

TASK:
%s
""" % task


def _controller_prompt(review, max_rounds, round_no, verify_failure=False):
    allowed = ["fix_recheck", "human", "stop"]
    if verify_failure:
        allowed.insert(0, "retry_verify")
    else:
        allowed.insert(1, "fix_verify")
    return """You are Camus's bounded closure controller. You cannot edit files and do not execute
commands. Decide the next semantic action from the evidence. Prefer fix_recheck when a fresh maker
can address concrete findings and independent re-review materially improves confidence. Use
fix_verify only for narrow, unambiguous findings where one fix plus deterministic verification is
enough but provenance must remain fixed-unreviewed. Use human for ambiguity/high stakes and stop
for unrecoverable or irrelevant work. Output exactly one JSON object:
{"action":"%s","reason":"one short sentence"}
Allowed actions: %s. Round %d of %d. Evidence: %s
""" % (allowed[0], ",".join(allowed), round_no, max_rounds,
       json.dumps(review, ensure_ascii=False)[:12000])


def controller_decision(client, log, *, trace_id, feat_id, task_id, attempt, cwd, review,
                        model, timeout, max_rounds, verify_failure=False):
    receipt = run_agent(
        client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
        role="verify-controller" if verify_failure else "controller", attempt=attempt, cwd=cwd,
        prompt=_controller_prompt(review, max_rounds, attempt, verify_failure=verify_failure),
        model=model, effort="low", timeout=timeout, tools="",
    )
    if receipt.get("state") != "done":
        return {"action": "human", "reason": "controller did not complete"}
    value = background_agent.extract_json_object(receipt.get("lastAssistantText"))
    if not isinstance(value, dict) or value.get("action") not in CONTROLLER_ACTIONS:
        return {"action": "human", "reason": "controller returned an invalid constrained verdict"}
    if verify_failure and value["action"] == "fix_verify":
        return {"action": "human", "reason": "verification failures require independent re-review"}
    if not verify_failure and value["action"] == "retry_verify":
        return {"action": "human", "reason": "retry_verify is valid only after a verification failure"}
    if value["action"] == "fix_recheck" and attempt >= max_rounds:
        return {"action": "human", "reason": "review round cap reached"}
    return {"action": value["action"], "reason": str(value.get("reason") or "")[:500]}


def _receipt_path(base, feat_id, task_id, role, attempt):
    return os.path.join(base, "sessions", "receipts", "%s-%s-%s-r%d.json" % (
        feat_id, task_id, role, attempt,
    ))


def _record_background_usage(base, repo, feat_id, task_id, role, attempt, receipt):
    path = _receipt_path(base, feat_id, task_id, role, attempt)
    _atomic(path, _public_receipt(receipt))
    return kernel.record_maker_usage(
        feat_id, task_id, path, role=role, source="background", repo=repo, base=base,
    )


def _post_agent_budget_stop(feat_id, base):
    """Re-read kernel-owned usage immediately after a maker receipt, before any next model gate."""
    run = kernel._validated_run(feat_id, base)
    stop = kernel._budget_stop(kernel._budgets(run), kernel._usage(run["state"]))
    return stop


def _direct_output_budget_evidence(feat_id, base, reserve_tokens=None):
    if reserve_tokens is not None and (
            isinstance(reserve_tokens, bool) or not isinstance(reserve_tokens, int)
            or reserve_tokens < 0):
        raise DriverError("direct output reserve must be a non-negative integer")
    run = kernel._validated_run(feat_id, base)
    budgets = kernel._budgets(run)
    usage = kernel._usage(run["state"])
    limit = budgets.get("tokens")
    direct_output = usage.get("directOutputTokens", 0)
    reserve = reserve_tokens
    if reserve is None and limit is not None:
        reserve = max(DIRECT_OUTPUT_RESERVE_MIN, int(limit * DIRECT_OUTPUT_RESERVE_FRACTION))
    remaining = max(0, limit - direct_output) if limit is not None else None
    return {
        "budgetTokens": limit,
        "directOutputTokens": direct_output,
        "remainingDirectOutputTokens": remaining,
        "reserveTokens": reserve,
        "reserveAvailable": remaining is None or reserve is None or remaining > reserve,
    }


def _pre_agent_budget_stop(feat_id, base, reserve_tokens=None):
    """Fail closed before a maker/fix when the remaining direct-output runway is too small."""
    stop = _post_agent_budget_stop(feat_id, base)
    if stop:
        return stop
    evidence = _direct_output_budget_evidence(feat_id, base, reserve_tokens=reserve_tokens)
    remaining = evidence["remainingDirectOutputTokens"]
    reserve = evidence["reserveTokens"]
    if remaining is not None and reserve is not None and remaining <= reserve:
        return "direct output reserve exhausted (%d remaining; %d reserved of %d)" % (
            remaining, reserve, evidence["budgetTokens"],
        )
    return None


def _persist_driver_stop(run, reason):
    """Persist a typed host stop so a killed driver cannot leave a runnable task behind."""
    state = run["state"]
    kernel_state = kernel._kernel(state)
    kernel_state["phase"] = "stopped"
    kernel_state["stopReason"] = str(reason)[:500]
    kernel_state["updatedAt"] = int(time.time())
    state["kernel"] = kernel_state
    state["status"] = "needs_human"
    state["stage"] = "kernel_stop"
    state["question"] = str(reason)[:500]
    for node in state.get("tasks", []):
        if node.get("taskId") == kernel_state.get("activeTaskId") and node.get("status") == "running":
            node["status"] = "needs_human"
    kernel._atomic_write(run["statePath"], state)


def _review_from_node(node):
    direct = node.get("directReview") if isinstance(node.get("directReview"), dict) else None
    if not direct:
        raise DriverError("task_reviewed state lacks direct review evidence")
    return {
        "action": "seal" if direct.get("clean") is True else "fix_then_seal",
        "taskId": node.get("taskId"), "worktree": node.get("worktree"),
        "clean": direct.get("clean") is True,
        "blocking": direct.get("blocking") if isinstance(direct.get("blocking"), list) else [],
        "nonblocking": direct.get("nonblocking") if isinstance(direct.get("nonblocking"), list) else [],
    }


def _accepted_seal(node):
    evidence = node.get("kernelEvidence") if isinstance(node.get("kernelEvidence"), dict) else {}
    return {
        "action": "land_task", "taskId": node.get("taskId"),
        "provenStatus": node.get("provenStatus"), "commit": node.get("provenCommit"),
        "verification": evidence.get("verification"),
    }


def _pairing(args, options, plan, ledger, assignment_key, assigned_arm=None):
    if plan:
        if assigned_arm:
            arm = next((item for item in plan["arms"] if item["id"] == assigned_arm), None)
            if arm is None:
                raise DriverError("recorded experiment arm is absent from the current config")
            why = {"reason": "resumed durable assignment"}
        else:
            arm, why = evals.select_arm(plan, ledger.records(), assignment_key)
        return {
            "makerModel": arm["makerModel"], "makerEffort": arm.get("makerEffort", "high"),
            "reviewerBackend": arm["reviewerBackend"], "reviewerModel": arm["reviewerModel"],
            "reviewerEffort": arm["reviewerEffort"],
            "orchestratorModel": arm.get("orchestratorModel", options.controller_model),
        }, {"id": plan["id"], "configHash": plan["configHash"],
            "armId": arm["id"], "assignment": why["reason"]}
    return {
        "makerModel": options.maker_model or args.get("model") or "claude-opus-4-8",
        "makerEffort": options.maker_effort,
        "reviewerBackend": options.reviewer_backend,
        "reviewerModel": options.reviewer_model,
        "reviewerEffort": options.reviewer_effort,
        "orchestratorModel": options.controller_model,
    }, None


def _task_metrics(run, node, log):
    direct = node.get("directMakerUsage") if isinstance(node, dict) else None
    totals = direct.get("totals") if isinstance(direct, dict) else {}
    receipts = direct.get("receipts") if isinstance(direct, dict) else []
    task_rows = [row for row in log.records() if row.get("taskId") == node.get("taskId")]
    agent_rows = [row for row in task_rows if row.get("type") == "agent.completed"]
    launched_rows = [row for row in task_rows if row.get("type") == "agent.launched"]
    model_output = 0
    model_duration = 0
    for row in agent_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        # Rebuilds can happen after the original driver has stopped.  Re-validate the sealed
        # transcript binding and prefer its exact terminal-turn duration over adoption wall time.
        data = _recover_completed(data)
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        model_output += int(usage.get("outputTokens") or 0)
        model_duration += int(data.get("durationMs") or 0)
    started = log.latest("task.started", node.get("taskId"))
    wall_ms = max(0, int(time.time()) - int(started.get("at"))) * 1000 \
        if isinstance(started, dict) and isinstance(started.get("at"), int) else model_duration
    transcript_hashes = [
        (row.get("data") or {}).get("transcriptSha256") for row in agent_rows
        if isinstance(row.get("data"), dict)
        and isinstance(row["data"].get("transcriptSha256"), str)
    ]
    if not transcript_hashes:
        transcript_hashes = [item.get("transcriptSha256") for item in receipts
                             if isinstance(item, dict)
                             and isinstance(item.get("transcriptSha256"), str)]
    attempted_sessions = len({row.get("key") for row in launched_rows if row.get("key")})
    measured_sessions = len({row.get("key") for row in agent_rows if row.get("key")})
    incomplete_sessions = max(0, attempted_sessions - measured_sessions)
    return {
        "wallMs": wall_ms,
        "modelWallMs": model_duration or int(totals.get("durationMs") or 0),
        "outputTokens": model_output or int(totals.get("outputTokens") or 0),
        "inputTokens": int(totals.get("inputTokens") or 0),
        "calls": len(agent_rows) or int(totals.get("calls") or 0),
        "attemptedCalls": attempted_sessions,
        "measuredCalls": measured_sessions,
        "attemptedSessions": attempted_sessions,
        "measuredSessions": measured_sessions,
        "incompleteSessions": incomplete_sessions,
        "measurementCoverage": (
            "incomplete_background_models_missing_terminal_receipts"
            if incomplete_sessions else
            "background_models_plus_end_to_end_wall; reviewer_tokens_unavailable"
        ),
    }, transcript_hashes


def _pairing_evidence(pairing, node, log):
    direct = node.get("directMakerUsage") if isinstance(node.get("directMakerUsage"), dict) else {}
    observed_makers = []
    for receipt in direct.get("receipts") if isinstance(direct.get("receipts"), list) else []:
        for model in receipt.get("models") if isinstance(receipt, dict) and isinstance(receipt.get("models"), list) else []:
            name = model.get("model") if isinstance(model, dict) else None
            if isinstance(name, str) and name and name not in observed_makers:
                observed_makers.append(name)
    if not observed_makers:
        for row in log.records():
            if row.get("type") != "agent.completed" or row.get("taskId") != node.get("taskId"):
                continue
            if not any(marker in str(row.get("key") or "") for marker in (":maker:", ":fix:")):
                continue
            data = row.get("data") if isinstance(row.get("data"), dict) else {}
            for name in data.get("modelsObserved") if isinstance(data.get("modelsObserved"), list) else []:
                if isinstance(name, str) and name and name not in observed_makers:
                    observed_makers.append(name)
    review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    return {
        **pairing,
        "makerObserved": observed_makers,
        "reviewerObserved": {
            "backend": review.get("backend"), "model": review.get("model"),
            "effort": review.get("effort"),
        } if review else None,
    }


def _record_episode(ledger, log, run, node, pairing, experiment, seal):
    metrics, transcripts = _task_metrics(run, node, log)
    final_review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    verification = seal.get("verification") if isinstance(seal, dict) else {}
    episode = evals.make_episode(
        trace_id=kernel._kernel(run["state"]).get("traceId"),
        feat_id=run["state"]["featId"], task_id=node["taskId"],
        task_hash=kernel._task_hash(run["specs"][run["nodes"].index(node)]),
        task_class=(experiment or {}).get("taskClass") or run["args"].get("taskClass") or "unknown",
        pairing=_pairing_evidence(pairing, node, log),
        outcome={
            "verificationPass": verification.get("pass") is True,
            "independentReview": "clean" if final_review.get("clean") is True else "findings",
            "humanIntervention": False,
            "provenStatus": seal.get("provenStatus"),
        },
        economics=metrics,
        artifact={"commit": seal.get("commit"), "transcriptHashes": transcripts},
        experiment=experiment,
    )
    ledger.append(episode)


def _record_incomplete_episode(ledger, log, run, node, pairing, experiment, terminal, review=None):
    metrics, transcripts = _task_metrics(run, node, log)
    terminal_event = log.latest("task.incomplete", node.get("taskId"))
    sequence = terminal_event.get("seq", 0) if isinstance(terminal_event, dict) else 0
    action = terminal.get("action") or "stop"
    episode = evals.make_episode(
        trace_id=kernel._kernel(run["state"]).get("traceId"),
        feat_id=run["state"]["featId"], task_id=node["taskId"],
        task_hash=kernel._task_hash(run["specs"][run["nodes"].index(node)]),
        task_class=(experiment or {}).get("taskClass") or run["args"].get("taskClass") or "unknown",
        pairing=_pairing_evidence(pairing, node, log),
        outcome={
            "verificationPass": False,
            "independentReview": (
                "clean" if isinstance(review, dict) and review.get("clean") is True
                else "findings" if isinstance(review, dict) else "unavailable"
            ),
            "humanIntervention": action in ("human", "needs_input"),
            "provenStatus": None,
            "terminalAction": action,
            "reason": str(terminal.get("reason") or "")[:500],
        },
        economics=metrics,
        artifact={"commit": None, "transcriptHashes": transcripts,
                  "terminalEventSeq": sequence},
        experiment=experiment,
    )
    ledger.append(episode)


def drive_feature(feat_id, options, client=None, ledger=None):
    """Hold one host lease for the full run so two drivers cannot duplicate a model session."""
    base = options.base or kernel.camus_home()
    directory = os.path.join(base, "sessions")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    lease_path = os.path.join(directory, feat_id + ".driver.lock")
    with open(lease_path, "a+", encoding="utf-8") as lease:
        os.chmod(lease_path, 0o600)
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DriverError("another native driver already owns this feature")
        return _drive_feature(feat_id, options, client=client, ledger=ledger)


def _drive_feature(feat_id, options, client=None, ledger=None):
    base = options.base or kernel.camus_home()
    client = client or background_agent.BackgroundAgentClient(binary=options.claude_binary)
    ledger = ledger or evals.Ledger(options.ledger)
    log = EventLog(feat_id, base=base)
    plan = evals.load_experiment(options.experiment) if options.experiment else None
    experiment_history = [row for row in log.records() if row.get("type") == "experiment.assigned"]
    if experiment_history and plan is None:
        raise DriverError("this feature has a frozen experiment; resume with the same --experiment config")
    if plan:
        for row in experiment_history:
            data = row.get("data") if isinstance(row.get("data"), dict) else {}
            if data.get("id") != plan["id"] or data.get("configHash") != plan["configHash"]:
                raise DriverError("experiment config disagrees with a prior durable assignment")
    completed_this_call = 0
    while True:
        run = kernel._validated_run(feat_id, base)
        repo = kernel._resolve_repo(run, options.repo)
        current = kernel._kernel(run["state"])
        selected, blocked = kernel._selected_index(run)
        if current.get("phase") == "accepted" and isinstance(current.get("activeTaskId"), str):
            selected = next((index for index, item in enumerate(run["nodes"])
                             if item.get("taskId") == current["activeTaskId"]), None)
            blocked = None
        if blocked:
            raise DriverError(blocked)
        if selected is None:
            result = kernel.integrate_feature(
                feat_id, repo=repo, verify_timeout=options.verify_timeout, base=base,
            )
            log.append("feature.completed", trace_id=result.get("traceId") or feat_id,
                       key=feat_id, data={"status": result.get("status"), "head": result.get("head")})
            return result
        node = run["nodes"][selected]
        task_id = node["taskId"]
        assignment_event = log.latest("experiment.assigned", task_id) if plan else None
        assignment_data = (assignment_event.get("data") or {}) \
            if isinstance(assignment_event, dict) else {}
        if assignment_data and assignment_data.get("configHash") != plan.get("configHash"):
            raise DriverError("experiment config changed after this task's durable assignment")
        assigned_arm = assignment_data.get("armId")
        pairing_event = log.latest("pairing.assigned", task_id)
        pairing_data = (pairing_event.get("data") or {}) if isinstance(pairing_event, dict) else {}
        if pairing_data:
            pairing = pairing_data.get("pairing")
            experiment = pairing_data.get("experiment")
            required = {
                "makerModel", "makerEffort", "reviewerBackend", "reviewerModel",
                "reviewerEffort", "orchestratorModel",
            }
            if not isinstance(pairing, dict) or set(pairing) != required \
                    or not all(isinstance(value, str) and value for value in pairing.values()):
                raise DriverError("durable task pairing is malformed")
            if plan and (not isinstance(experiment, dict)
                         or experiment.get("configHash") != plan["configHash"]):
                raise DriverError("durable task pairing disagrees with the experiment config")
        else:
            pairing, experiment = _pairing(
                run["args"], options, plan, ledger, "%s:%s" % (feat_id, task_id),
                assigned_arm=assigned_arm,
            )
        if experiment:
            experiment["taskClass"] = plan["taskClass"]
            log.append("experiment.assigned", trace_id=current.get("traceId") or feat_id,
                       task_id=task_id, key=task_id,
                       data={"id": experiment["id"], "configHash": experiment["configHash"],
                             "armId": experiment["armId"]})
        log.append("pairing.assigned", trace_id=current.get("traceId") or feat_id,
                   task_id=task_id, key=task_id,
                   data={"pairing": pairing, "experiment": experiment})
        phase = current.get("phase")
        desired_seats = {
            "makerModel": pairing["makerModel"],
            "reviewerBackend": pairing["reviewerBackend"],
            "reviewerModel": pairing["reviewerModel"],
            "reviewerEffort": pairing["reviewerEffort"],
        }
        if phase is None:
            prepared = kernel.prepare(
                feat_id, repo=repo, wall_seconds=options.wall_seconds,
                token_budget=options.token_budget, retry_budget=options.retry_budget,
                maker_model=pairing["makerModel"],
                reviewer_backend=pairing["reviewerBackend"],
                reviewer_model=pairing["reviewerModel"],
                reviewer_effort=pairing["reviewerEffort"],
                verify_timeout=options.verify_timeout, base=base,
            )
            current = kernel._kernel(kernel._validated_run(feat_id, base)["state"])
            phase = current.get("phase")
            if prepared.get("action") == "stop":
                return prepared
        elif phase == "ready" and current.get("seats") != desired_seats:
            kernel.configure_seats(
                feat_id, pairing["makerModel"], pairing["reviewerBackend"],
                pairing["reviewerModel"], pairing["reviewerEffort"], repo=repo, base=base,
            )
            current = kernel._kernel(kernel._validated_run(feat_id, base)["state"])
            phase = current.get("phase")
        print("Task %d/%d · %s" % (selected + 1, len(run["nodes"]), node["brief"]), flush=True)
        if experiment:
            print("  experiment %s → %s" % (experiment["id"], experiment["armId"]), flush=True)
        run = kernel._validated_run(feat_id, base)
        current = kernel._kernel(run["state"])
        phase = current.get("phase")
        node = next(item for item in run["nodes"] if item["taskId"] == task_id)
        trace_id = current.get("traceId") or feat_id
        if phase == "stopped":
            return {
                "action": "stop",
                "reason": current.get("stopReason") or "driver stopped; human resume required",
                "featId": feat_id, "taskId": task_id,
            }
        log.append("task.started", trace_id=trace_id, task_id=task_id, key=task_id,
                   data={"pairing": experiment["armId"] if experiment else "explicit"})

        def incomplete(value, review_evidence=None, terminal=False):
            log.append("task.incomplete", trace_id=trace_id, task_id=task_id, key=task_id,
                       data={"action": value.get("action") or "stop"})
            stopped_run = kernel._validated_run(feat_id, base)
            stopped_node = next(item for item in stopped_run["nodes"] if item["taskId"] == task_id)
            _record_incomplete_episode(
                ledger, log, stopped_run, stopped_node, pairing, experiment, value,
                review=review_evidence,
            )
            reason = value.get("reason") or value.get("action") or "stop"
            # Human/input and verifier-failure stops are intentionally resumable. Only callers
            # with deterministic terminal admission evidence may park the persisted run.
            if terminal:
                _persist_driver_stop(stopped_run, reason)
            return value

        round_cap = options.round_cap or run["args"].get("roundCap") or 3
        round_no = node.get("reviewerRound") if isinstance(node.get("reviewerRound"), int) else 0
        payload = ({"loopArgs": {"task": run["specs"][selected]}, "repo": repo}
                   if phase == "accepted" else kernel.task_payload(run, task_id, repo=repo))
        if node.get("worktree"):
            payload.update({"worktree": node["worktree"], "branch": node["branch"]})

        # Resume every kernel checkpoint without replaying semantic work. A completed background
        # session is adopted by name/event receipt; review/seal/land are already idempotent.
        seal = None
        review = None
        fixed_unreviewed = False
        if phase == "accepted":
            seal = _accepted_seal(node)
        elif phase == "task_sealing":
            intent = node.get("directSeal") if isinstance(node.get("directSeal"), dict) else {}
            fixed_unreviewed = intent.get("provenStatus") == "done_with_findings"
            seal = kernel.seal_task(
                feat_id, task_id, fixed_unreviewed=fixed_unreviewed, repo=repo,
                verify_timeout=options.verify_timeout, base=base,
            )
        elif phase == "task_verify_failed":
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            intent = node.get("directSeal") if isinstance(node.get("directSeal"), dict) else {}
            fixed_unreviewed = intent.get("provenStatus") == "done_with_findings"
            budget_evidence = _direct_output_budget_evidence(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            verify_decision = controller_decision(
                client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
                attempt=max(1, round_no), cwd=repo,
                review={"verificationFailed": True, "review": _review_from_node(node),
                        "budgetEvidence": budget_evidence},
                model=pairing["orchestratorModel"], timeout=options.controller_timeout,
                max_rounds=round_cap, verify_failure=True,
            )
            print("  controller → %s (%s)" % (
                verify_decision["action"], verify_decision["reason"],
            ), flush=True)
            log.append("controller.decision", trace_id=trace_id, task_id=task_id,
                       key="%s:verify-decision:%d" % (task_id, max(1, round_no)),
                       data={**verify_decision, "budgetEvidence": budget_evidence})
            if verify_decision["action"] in ("human", "stop"):
                return incomplete({
                    "action": verify_decision["action"], "reason": verify_decision["reason"],
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=_review_from_node(node))
            if verify_decision["action"] == "retry_verify":
                seal = kernel.seal_task(
                    feat_id, task_id, fixed_unreviewed=fixed_unreviewed, repo=repo,
                    verify_timeout=options.verify_timeout, base=base,
                )
            else:
                review = _review_from_node(node)
        elif phase == "task_reviewed":
            review = _review_from_node(node)
        elif phase == "task_reviewing":
            budget_stop = _post_agent_budget_stop(feat_id, base)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            review = kernel.review_task(feat_id, task_id, repo=repo, base=base)
        elif phase == "ready":
            kernel.dispatch_task(feat_id, task_id, repo=repo, base=base)
            payload = kernel.open_task(feat_id, task_id, repo=repo, base=base)
        elif phase == "task_running":
            kernel.dispatch_task(feat_id, task_id, repo=repo, base=base)
            payload = kernel.open_task(feat_id, task_id, repo=repo, base=base)
        elif phase == "task_open":
            payload = kernel.open_task(feat_id, task_id, repo=repo, base=base)
        else:
            raise DriverError("cannot resume unknown kernel phase %s" % phase)

        if seal is None and review is None and phase in ("ready", "task_running", "task_open"):
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            receipt = run_agent(
                client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
                role="maker", attempt=1, cwd=payload["worktree"],
                prompt=_maker_prompt(payload), model=pairing["makerModel"],
                effort=pairing["makerEffort"], timeout=options.agent_timeout,
            )
            if receipt.get("state") == "needs_input":
                return incomplete({
                    "action": "needs_input", "featId": feat_id, "taskId": task_id,
                    "attach": "claude attach %s" % receipt.get("shortId"),
                })
            if receipt.get("state") != "done":
                return incomplete({
                    "action": "stop", "reason": "maker ended %s: %s" % (
                        receipt.get("state"), receipt.get("terminalReason") or "no terminal receipt",
                    ),
                    "featId": feat_id, "taskId": task_id,
                })
            _record_background_usage(base, repo, feat_id, task_id, "maker", 1, receipt)
            budget_stop = _post_agent_budget_stop(feat_id, base)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            review = kernel.review_task(feat_id, task_id, repo=repo, base=base)
            round_no = review.get("reviewer", {}).get("round", 1)

        # A failed verifier is a semantic fork: the controller chooses a bounded retry or a fresh
        # fix + independent re-review. It is never an unconditional systematic rerun.
        if seal is None and phase == "task_verify_failed" and review is not None:
            round_no += 1
            usage = kernel._usage(kernel._validated_run(feat_id, base)["state"])
            kernel.record_usage(feat_id, retries=usage["retries"] + 1, base=base)
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            receipt = run_agent(
                client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
                role="fix", attempt=round_no, cwd=payload["worktree"],
                prompt=_maker_prompt(payload, findings=[{
                    "title": "deterministic verification failed",
                    "body": "Diagnose the repository verifier failure, fix its root cause, and rerun relevant checks.",
                }]), model=pairing["makerModel"], effort=pairing["makerEffort"],
                timeout=options.agent_timeout,
            )
            if receipt.get("state") != "done":
                return incomplete({
                    "action": "stop", "reason": "verification fix ended %s: %s" % (
                        receipt.get("state"), receipt.get("terminalReason") or "no terminal receipt",
                    ),
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review)
            _record_background_usage(base, repo, feat_id, task_id, "fix", round_no, receipt)
            budget_stop = _post_agent_budget_stop(feat_id, base)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            review = kernel.review_task(feat_id, task_id, repo=repo, base=base)
            fixed_unreviewed = False

        while seal is None and review is not None and not review.get("clean"):
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            budget_evidence = _direct_output_budget_evidence(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            decision = controller_decision(
                client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
                attempt=max(1, round_no), cwd=repo, review={
                    "blocking": review.get("blocking"), "nonblocking": review.get("nonblocking"),
                    "budgetEvidence": budget_evidence,
                }, model=pairing["orchestratorModel"], timeout=options.controller_timeout,
                max_rounds=round_cap,
            )
            decision["budgetEvidence"] = budget_evidence
            log.append("controller.decision", trace_id=trace_id, task_id=task_id,
                       key="%s:decision:%d" % (task_id, max(1, round_no)), data=decision)
            print("  controller → %s (%s)" % (decision["action"], decision["reason"]), flush=True)
            if decision["action"] in ("human", "stop"):
                return incomplete({
                    "action": decision["action"], "reason": decision["reason"],
                    "featId": feat_id, "taskId": task_id, "review": review,
                }, review_evidence=review)
            round_no += 1
            usage = kernel._usage(kernel._validated_run(feat_id, base)["state"])
            kernel.record_usage(feat_id, retries=usage["retries"] + 1, base=base)
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            receipt = run_agent(
                client, log, trace_id=trace_id, feat_id=feat_id, task_id=task_id,
                role="fix", attempt=round_no, cwd=payload["worktree"],
                prompt=_maker_prompt(payload, findings=review.get("blocking")),
                model=pairing["makerModel"], effort=pairing["makerEffort"],
                timeout=options.agent_timeout,
            )
            if receipt.get("state") != "done":
                return incomplete({
                    "action": "stop", "reason": "fix maker ended %s: %s" % (
                        receipt.get("state"), receipt.get("terminalReason") or "no terminal receipt",
                    ),
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review)
            _record_background_usage(base, repo, feat_id, task_id, "fix", round_no, receipt)
            budget_stop = _post_agent_budget_stop(feat_id, base)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            if decision["action"] == "fix_verify":
                fixed_unreviewed = True
                break
            review = kernel.review_task(feat_id, task_id, repo=repo, base=base)

        if seal is None:
            seal = kernel.seal_task(
                feat_id, task_id, fixed_unreviewed=fixed_unreviewed, repo=repo,
                verify_timeout=options.verify_timeout, base=base,
            )
        if seal.get("action") == "stop":
            # Persisted task_verify_failed makes the next invocation ask the controller whether a
            # retry is meaningful; do not spend another model turn inside this same failure edge.
            return incomplete({
                **seal, "resume": "rerun camus run; the closure controller decides retry vs fix",
            }, review_evidence=review)
        run = kernel._validated_run(feat_id, base)
        node = next(item for item in run["nodes"] if item["taskId"] == task_id)
        _record_episode(ledger, log, run, node, pairing, experiment, seal)
        landed = kernel.land_task(feat_id, task_id, repo=repo, base=base)
        log.append("task.landed", trace_id=trace_id, task_id=task_id, key=task_id,
                   data={"status": seal.get("provenStatus"), "commit": seal.get("commit")})
        print("  landed %s · %s" % (seal.get("provenStatus"), seal.get("commit", "")[:8]), flush=True)
        completed_this_call += 1
        if options.max_tasks and completed_this_call >= options.max_tasks:
            return {"action": "paused", "reason": "max-tasks reached", "next": landed}


def _nonnegative_int(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    if value < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return value


def _parser():
    parser = argparse.ArgumentParser(description="Camus native background-session driver")
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="initialize a feature from a JSON spec without a model")
    start.add_argument("spec")
    start.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    run = sub.add_parser("run", help="drive an initialized feature through kernel custody")
    run.add_argument("feat_id")
    run.add_argument("--repo", default=None)
    run.add_argument("--maker-model", default=None)
    run.add_argument("--maker-effort", choices=("low", "medium", "high"), default="high")
    run.add_argument("--reviewer-backend", default="codex")
    run.add_argument("--reviewer-model", default="gpt-5.6-sol")
    run.add_argument("--reviewer-effort", choices=("low", "medium", "high", "xhigh"), default="high")
    run.add_argument("--controller-model", default="sonnet")
    run.add_argument("--round-cap", type=int, default=None)
    run.add_argument("--wall-seconds", type=int, default=None)
    run.add_argument("--token-budget", type=int, default=None)
    run.add_argument(
        "--direct-output-reserve", type=_nonnegative_int, default=None,
        help="minimum direct-output runway before a maker/fix (0 disables the reserve; not a hard cap)",
    )
    run.add_argument("--retry-budget", type=int, default=None)
    run.add_argument("--verify-timeout", type=int, default=3600)
    run.add_argument("--agent-timeout", type=int, default=14400)
    run.add_argument("--controller-timeout", type=int, default=900)
    run.add_argument("--max-tasks", type=int, default=None)
    run.add_argument("--experiment", default=None)
    run.add_argument("--ledger", default=None)
    run.add_argument("--claude-binary", default="claude")
    run.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    options = _parser().parse_args(argv)
    try:
        value = start_feature(options.spec, base=options.base) if options.command == "start" \
            else drive_feature(options.feat_id, options)
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    except (DriverError, kernel.Refusal, background_agent.BackgroundAgentError, evals.EvalError) as exc:
        print(json.dumps({"action": "stop", "reason": str(exc)}, ensure_ascii=False, indent=2))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"action": "stop", "reason": "interrupted; rerun adopts durable sessions"}))
        return 130


if __name__ == "__main__":
    sys.exit(main())
