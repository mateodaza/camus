#!/usr/bin/env python3
"""Native Camus driver: models do semantic work; code owns orchestration.

The driver intentionally reuses ``feat_kernel`` instead of reimplementing custody.  Claude Code
background sessions edit kernel-owned task worktrees using proven claude.ai account auth. Codex reviews the
candidate directly.  A small controller model is called only when a semantic fork exists (fix and
re-review, fix once with explicit findings provenance, or stop for a human).  Git, status polling,
receipts, verification, merge, and experiment assignment stay deterministic.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
import time

import background_agent
import evals
import feat_kernel as kernel
import model_trials
import resume_scan


DRIVER_SCHEMA = 1
DIRECT_OUTPUT_RESERVE_MIN = 10_000
DIRECT_OUTPUT_RESERVE_FRACTION = 0.25
ALLOWED_SPEC_FIELDS = {
    "feat", "tasks", "targetPath", "policy", "model", "modelTier", "roundCap",
    "budgetTokens", "verifyCmd", "posture", "answers", "taskClass",
}
CONTROLLER_ACTIONS = {"fix_recheck", "fix_verify", "retry_verify", "human", "stop"}
HUMAN_RESUME_ACTIONS = {"fix_recheck", "fix_verify", "retry_verify"}
EXTERNAL_REVIEW_ROUTE_FIELDS = (
    "reviewerProfileBackend", "reviewerTrainingOrg", "reviewerTransport",
    "reviewerConnection", "reviewerQualification",
)


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


def _decision_event_key(task_id, kind, round_no, decision):
    """Deduplicate an observed verdict, while allowing corrected replay evidence to supersede it."""
    action = decision.get("action") if isinstance(decision, dict) else None
    action = action if action in CONTROLLER_ACTIONS else "invalid"
    return "%s:%s:%d:%s" % (task_id, kind, round_no, action)


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
        if not background_agent.transcript_has_metadata_only_suffix(path, stored_hash):
            raise background_agent.BackgroundAgentError(
                "completed background transcript hash drifted; refusing to rebind evidence"
            )
        # The sealed hash covers the semantic turn. Keep it as the custody identity even though
        # the provider appended harmless bookkeeping rows after the turn completed.
        enriched["transcriptSha256"] = stored_hash
    recovered = {**receipt, **enriched}
    # Enrichment is not a migration of already sealed accounting. A newer parser
    # may fix usage aggregation, but replay must not silently rewrite prior receipts
    # or their budget evidence. New completed calls use the corrected parser.
    if isinstance(receipt.get("usage"), dict):
        recovered["usage"] = dict(receipt["usage"])
    terminal_duration = enriched.get("terminalTurnDurationMs")
    if isinstance(terminal_duration, int) and terminal_duration >= 0:
        # A prior driver may have sealed the supervisor disappearance as `stale` before the
        # transcript's terminal row became visible. The exact-session terminal marker upgrades
        # that transport observation to a completed turn on replay; it does not launch a new turn.
        recovered["state"] = "done"
        recovered["terminalReason"] = "terminal transcript marker"
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
            + "\n\nOriginal task contract (still binding; do not broaden scope or weaken its tests):\n"
            + task
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


def _post_agent_budget_stop(feat_id, base, include_retries=True):
    """Re-read kernel-owned usage immediately after a maker receipt, before any next model gate."""
    run = kernel._validated_run(feat_id, base)
    budgets = kernel._budgets(run)
    if not include_retries:
        budgets = {**budgets, "retries": None}
    stop = kernel._budget_stop(budgets, kernel._usage(run["state"]))
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
    node = next((item for item in state.get("tasks", [])
                 if item.get("taskId") == kernel_state.get("activeTaskId")), None)
    if isinstance(node, dict):
        try:
            resume_phase, resume_round = kernel._budget_resume_checkpoint(kernel_state, node)
            kernel_state["resumePhase"] = resume_phase
            if resume_round is not None:
                kernel_state["resumeReviewRound"] = resume_round
        except kernel.Refusal:
            pass
    kernel_state["phase"] = "stopped"
    kernel_state["stopReason"] = str(reason)[:500]
    stop_kind = kernel.direct_output_stop_kind({"stopReason": str(reason)})
    if stop_kind is not None:
        kernel_state["stopKind"] = stop_kind
    else:
        kernel_state.pop("stopKind", None)
    kernel_state["updatedAt"] = int(time.time())
    state["kernel"] = kernel_state
    state["status"] = "needs_human"
    state["stage"] = "kernel_stop"
    state["question"] = str(reason)[:500]
    for node in state.get("tasks", []):
        if node.get("taskId") == kernel_state.get("activeTaskId") and node.get("status") == "running":
            node["status"] = "needs_human"
    kernel._atomic_write(run["statePath"], state)


def _persist_controller_handoff(run, task_id, decision, verify_failure=False):
    """Make a semantic controller handoff durable without destroying its safe checkpoint."""
    state = run["state"]
    kernel_state = kernel._kernel(state)
    node = next((item for item in state.get("tasks", []) if item.get("taskId") == task_id), None)
    if not isinstance(node, dict) or node.get("status") != "running":
        raise DriverError("controller handoff task is not the active running task")
    phase = kernel_state.get("phase")
    expected_phase = "task_verify_failed" if verify_failure else "task_reviewed"
    if phase != expected_phase or kernel_state.get("activeTaskId") != task_id:
        raise DriverError("controller handoff is not bound to the expected kernel checkpoint")
    direct_review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    candidate_fingerprint = direct_review.get("candidateFingerprint")
    review_receipt_sha = direct_review.get("receiptSha256")
    if not isinstance(candidate_fingerprint, str) \
            or re.fullmatch(r"candidate1:[0-9a-f]{64}", candidate_fingerprint) is None \
            or not isinstance(review_receipt_sha, str) \
            or re.fullmatch(r"[0-9a-f]{64}", review_receipt_sha) is None:
        raise DriverError("controller handoff lacks exact candidate/review receipt bindings")
    round_no = direct_review.get("round")
    if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no < 1:
        round_no = node.get("reviewerRound")
    if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no < 1:
        raise DriverError("controller handoff lacks a valid review round")
    reason = str(decision.get("reason") or decision.get("action") or "human decision required")[:500]
    handoff = {
        "schemaVersion": DRIVER_SCHEMA,
        "controllerAction": decision.get("action"),
        "reason": reason,
        "reviewRound": round_no,
        "kernelPhase": phase,
        "candidateFingerprint": candidate_fingerprint,
        "reviewReceiptSha256": review_receipt_sha,
        "allowedActions": sorted(
            ("fix_recheck", "retry_verify") if verify_failure else ("fix_recheck", "fix_verify")
        ),
        "recordedAt": int(time.time()),
    }
    node["nativeControllerHandoff"] = handoff
    node["status"] = "needs_human"
    state["status"] = "needs_human"
    state["stage"] = "native_controller"
    state["question"] = reason
    kernel_state["updatedAt"] = int(time.time())
    state["kernel"] = kernel_state
    kernel._append_event(state, "Native controller handed %s to a human at review round %d" % (
        task_id, round_no,
    ))
    kernel._atomic_write(run["statePath"], state)


def _shadow_skip_reason(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 300 \
            or re.search(r"[\x00-\x1f\x7f]", value):
        raise DriverError("shadow skip requires a non-empty, single-line reason of at most 300 characters")
    return value.strip()


def _resume_controller_handoff(run, action, round_cap, skip_shadow_reason=None):
    """Consume one explicit operator decision, bound to the paused review and candidate."""
    if action not in HUMAN_RESUME_ACTIONS:
        raise DriverError("human action must be fix_recheck|fix_verify|retry_verify")
    if skip_shadow_reason is not None:
        skip_shadow_reason = _shadow_skip_reason(skip_shadow_reason)
        if action != "fix_recheck":
            raise DriverError("skipping a shadow requires fix_recheck; the authoritative review cannot be skipped")
    state = run["state"]
    if state.get("status") != "needs_human" or state.get("stage") != "native_controller":
        raise DriverError("--human-action is valid only for a native controller handoff")
    kernel_state = kernel._kernel(state)
    task_id = kernel_state.get("activeTaskId")
    node = next((item for item in state.get("tasks", []) if item.get("taskId") == task_id), None)
    handoff = node.get("nativeControllerHandoff") if isinstance(node, dict) else None
    if not isinstance(handoff, dict) or node.get("status") != "needs_human":
        raise DriverError("native controller handoff record is missing or malformed")
    if action not in handoff.get("allowedActions", []):
        raise DriverError("human action is not valid for this controller checkpoint")
    if kernel_state.get("phase") != handoff.get("kernelPhase"):
        raise DriverError("native controller checkpoint drifted after the handoff")
    direct_review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    if re.fullmatch(r"candidate1:[0-9a-f]{64}", str(handoff.get("candidateFingerprint") or "")) is None \
            or re.fullmatch(r"[0-9a-f]{64}", str(handoff.get("reviewReceiptSha256") or "")) is None:
        raise DriverError("native controller handoff has malformed candidate/review bindings")
    for key, expected in (
        ("candidateFingerprint", handoff.get("candidateFingerprint")),
        ("receiptSha256", handoff.get("reviewReceiptSha256")),
    ):
        if direct_review.get(key) != expected:
            raise DriverError("native controller review binding drifted after the handoff")
    review_round = handoff.get("reviewRound")
    if action == "fix_recheck" and (not isinstance(round_cap, int) or round_cap <= review_round):
        raise DriverError(
            "fix_recheck after a final-round handoff requires an explicit higher --round-cap"
        )
    authorization = {
        "schemaVersion": DRIVER_SCHEMA,
        "action": action,
        "reviewRound": review_round,
        "kernelPhase": handoff.get("kernelPhase"),
        "candidateFingerprint": handoff.get("candidateFingerprint"),
        "reviewReceiptSha256": handoff.get("reviewReceiptSha256"),
        "authorizedRoundCap": round_cap,
        "authorizedAt": int(time.time()),
    }
    if skip_shadow_reason is not None:
        # Atomic with the bound operator decision: replay must not buy an advisory
        # call merely because the process stopped before writing its event log.
        authorization["shadowSkipReason"] = skip_shadow_reason
    node["nativeControllerAuthorization"] = authorization
    node["status"] = "running"
    state["status"] = "running"
    state["stage"] = "kernel_" + str(kernel_state.get("phase"))
    state.pop("question", None)
    kernel_state["updatedAt"] = int(time.time())
    state["kernel"] = kernel_state
    kernel._append_event(state, "Operator authorized %s for %s at review round %d" % (
        action, task_id, review_round,
    ))
    kernel._atomic_write(run["statePath"], state)
    return authorization


def _pending_controller_authorization(run):
    """Recover a bound operator decision after a driver crash, before replaying its action."""
    state = run["state"]
    if state.get("status") != "running":
        return None
    kernel_state = kernel._kernel(state)
    task_id = kernel_state.get("activeTaskId")
    node = next((item for item in state.get("tasks", []) if item.get("taskId") == task_id), None)
    authorization = node.get("nativeControllerAuthorization") if isinstance(node, dict) else None
    if not isinstance(authorization, dict) or node.get("status") != "running":
        return None
    if authorization.get("action") not in HUMAN_RESUME_ACTIONS:
        raise DriverError("persisted native controller authorization has an invalid action")
    if "shadowSkipReason" in authorization:
        _shadow_skip_reason(authorization["shadowSkipReason"])
        if authorization["action"] != "fix_recheck":
            raise DriverError("persisted shadow skip lacks an independent re-review authorization")
    if authorization.get("kernelPhase") != kernel_state.get("phase"):
        return None
    review_round = authorization.get("reviewRound")
    if isinstance(review_round, bool) or not isinstance(review_round, int) or review_round < 1:
        raise DriverError("persisted native controller authorization has an invalid review round")
    authorized_round_cap = authorization.get("authorizedRoundCap")
    if isinstance(authorized_round_cap, bool) or not isinstance(authorized_round_cap, int) \
            or authorized_round_cap < 1:
        raise DriverError("persisted native controller authorization has an invalid round cap")
    if authorization.get("action") == "fix_recheck" \
            and authorized_round_cap <= review_round:
        raise DriverError("persisted fix_recheck authorization lacks a higher round cap")
    direct_review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    direct_round = direct_review.get("round")
    if isinstance(direct_round, int) and not isinstance(direct_round, bool) \
            and direct_round > review_round:
        # A fresh independent review proves that the authorized action advanced. Its newer binding
        # consumes the authorization; it must not replay against the next semantic checkpoint.
        return None
    if direct_round != review_round \
            or direct_review.get("candidateFingerprint") != authorization.get("candidateFingerprint") \
            or direct_review.get("receiptSha256") != authorization.get("reviewReceiptSha256"):
        raise DriverError("persisted native controller authorization binding drifted before use")
    return authorization


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
        pairing = {
            "makerModel": arm["makerModel"], "makerEffort": arm.get("makerEffort", "high"),
            "reviewerBackend": arm["reviewerBackend"], "reviewerModel": arm["reviewerModel"],
            "reviewerEffort": arm["reviewerEffort"],
            "orchestratorModel": arm.get("orchestratorModel", options.controller_model),
        }
        for key in ("shadowReviewerBackend", "shadowReviewerModel", "shadowReviewerEffort"):
            if arm.get(key):
                pairing[key] = arm[key]
        for key in EXTERNAL_REVIEW_ROUTE_FIELDS:
            if arm.get(key):
                pairing[key] = arm[key]
        _reviewer_route(pairing)
        return pairing, {"id": plan["id"], "configHash": plan["configHash"],
            "armId": arm["id"], "assignment": why["reason"]}
    pairing = {
        "makerModel": options.maker_model or args.get("model") or "claude-opus-4-8",
        "makerEffort": options.maker_effort,
        "reviewerBackend": options.reviewer_backend,
        "reviewerModel": options.reviewer_model,
        "reviewerEffort": options.reviewer_effort,
        "orchestratorModel": options.controller_model,
    }
    shadow_backend = getattr(options, "shadow_reviewer_backend", None)
    shadow_model = getattr(options, "shadow_reviewer_model", None)
    if shadow_backend or shadow_model:
        if not shadow_backend or not shadow_model:
            raise DriverError("shadow reviewer requires both --shadow-reviewer-backend and --shadow-reviewer-model")
        pairing.update({
            "shadowReviewerBackend": shadow_backend,
            "shadowReviewerModel": shadow_model,
            "shadowReviewerEffort": getattr(options, "shadow_reviewer_effort", "medium"),
        })
    for key, option in (
        ("reviewerProfileBackend", "reviewer_profile_backend"),
        ("reviewerTrainingOrg", "reviewer_training_org"),
        ("reviewerTransport", "reviewer_transport"),
        ("reviewerConnection", "reviewer_connection"),
        ("reviewerQualification", "reviewer_qualification"),
    ):
        value = getattr(options, option, None)
        if value:
            pairing[key] = value
    _reviewer_route(pairing)
    return pairing, None


def _reviewer_route(pairing):
    present = [key for key in EXTERNAL_REVIEW_ROUTE_FIELDS if pairing.get(key)]
    if pairing.get("reviewerBackend") != "http_openai_compat":
        if present:
            raise DriverError("external reviewer route fields require --reviewer-backend http_openai_compat")
        return None
    if len(present) != len(EXTERNAL_REVIEW_ROUTE_FIELDS):
        raise DriverError("admitted HTTP reviewer requires its complete exact non-secret route")
    route = {
        "profileBackend": pairing["reviewerProfileBackend"],
        "trainingOrg": pairing["reviewerTrainingOrg"],
        "transport": pairing["reviewerTransport"],
        "connection": pairing["reviewerConnection"],
        "qualification": pairing["reviewerQualification"],
    }
    if route["transport"] not in ("loopback", "direct_https", "ssh_tunnel") \
            or not re.fullmatch(r"qual1:[0-9a-f]{64}", route["qualification"]):
        raise DriverError("admitted HTTP reviewer route is malformed")
    if not all(isinstance(value, str) and value for value in route.values()):
        raise DriverError("admitted HTTP reviewer route contains an empty identity field")
    return route


def _shadow_config(pairing):
    keys = ("shadowReviewerBackend", "shadowReviewerModel", "shadowReviewerEffort")
    values = [pairing.get(key) for key in keys]
    if not any(values):
        return None
    if not all(isinstance(value, str) and value for value in values):
        raise DriverError("durable shadow reviewer pairing is incomplete")
    if pairing.get("reviewerBackend") != "codex":
        raise DriverError("shadow evaluation requires Codex as the final reviewer gate")
    return {"backend": values[0], "model": values[1], "effort": values[2]}


def _shadow_event_key(task_id, shadow, round_no, candidate_fingerprint):
    digest = hashlib.sha256(_canonical({
        "taskId": task_id, "shadow": shadow, "round": round_no,
        "candidateFingerprint": candidate_fingerprint,
    }).encode("utf-8")).hexdigest()
    return "%s:shadow:%s" % (task_id, digest)


def _run_shadow_review(log, run, node, pairing, repo, task, round_no):
    """Run or adopt an advisory external review; Codex closure always follows."""
    shadow = _shadow_config(pairing)
    if shadow is None:
        return None
    worktree, _ = kernel._validated_worktree(repo, node, node.get("worktree"))
    candidate = kernel._candidate_fingerprint(worktree)
    key = _shadow_event_key(node["taskId"], shadow, round_no, candidate)
    prior = log.latest("shadow.reviewed", key)
    if isinstance(prior, dict) and isinstance(prior.get("data"), dict):
        return prior["data"]
    authorization = node.get("nativeControllerAuthorization") or {}
    if "shadowSkipReason" in authorization:
        reason = _shadow_skip_reason(authorization["shadowSkipReason"])
        authorized_round = authorization.get("reviewRound")
        if authorization.get("action") != "fix_recheck" \
                or isinstance(authorized_round, bool) or not isinstance(authorized_round, int):
            raise DriverError("shadow skip lacks a bound repair/re-review authorization")
        if round_no == authorized_round + 1:
            data = {
                "ran": False, "skipped": True, "standing": "experimental_shadow",
                **shadow, "errorCode": "shadow_review_skipped", "reason": reason,
                "finalGate": "codex", "candidateFingerprint": candidate,
                "round": round_no, "durationMs": 0,
            }
            log.append("shadow.skipped", trace_id=kernel._kernel(run["state"])["traceId"],
                       task_id=node["taskId"], key=key, data=data)
            print("  shadow %s:%s → skipped by operator (%s); Codex still gates" % (
                shadow["backend"], shadow["model"], reason,
            ), flush=True)
            return data
    started = time.monotonic()
    try:
        result = model_trials.run_review(
            shadow["backend"], shadow["model"], worktree, task,
            round_no=round_no, effort=shadow["effort"], repo=repo,
            nonce="%s:%s:shadow" % (kernel._kernel(run["state"])["traceId"], node["taskId"]),
        )
    except model_trials.TrialError as exc:
        result = {
            "ran": False, "standing": "experimental_shadow",
            "backend": shadow["backend"], "model": shadow["model"],
            "effort": shadow["effort"], "errorCode": "shadow_review_unavailable",
            "error": str(exc)[:500], "finalGate": "codex",
        }
    data = {
        **result,
        "candidateFingerprint": candidate,
        "round": round_no,
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    log.append(
        "shadow.reviewed", trace_id=kernel._kernel(run["state"])["traceId"],
        task_id=node["taskId"], key=key, data=data,
    )
    if data.get("ran") is True:
        print("  shadow %s:%s → %s (Codex still gates)" % (
            shadow["backend"], shadow["model"],
            "clean" if data.get("clean") is True else "findings",
        ), flush=True)
    else:
        print("  shadow %s:%s → unavailable (%s); Codex still gates" % (
            shadow["backend"], shadow["model"], data.get("errorCode") or "infrastructure",
        ), flush=True)
    return data


def _record_shadow_comparison(log, trace_id, task_id, shadow, codex_review,
                              codex_candidate_fingerprint=None):
    if not isinstance(shadow, dict):
        return None
    same_candidate = (
        isinstance(shadow.get("candidateFingerprint"), str)
        and isinstance(codex_candidate_fingerprint, str)
        and shadow["candidateFingerprint"] == codex_candidate_fingerprint
    )
    comparable = shadow.get("ran") is True and same_candidate
    compared = {
        "standing": "experimental_shadow",
        "shadowRan": shadow.get("ran") is True,
        "shadowSkipped": shadow.get("skipped") is True,
        "shadowSkipReason": shadow.get("reason") if shadow.get("skipped") is True else None,
        "shadowComparable": comparable,
        "sameCandidate": same_candidate,
        "shadowClean": shadow.get("clean") if comparable else None,
        "codexClean": codex_review.get("clean") is True,
        "verdictAgreement": (
            shadow.get("clean") is (codex_review.get("clean") is True)
            if comparable else None
        ),
        "backend": shadow.get("backend"), "model": shadow.get("model"),
        "round": shadow.get("round"),
        "candidateFingerprint": shadow.get("candidateFingerprint"),
        "codexCandidateFingerprint": codex_candidate_fingerprint,
        "receiptSha256": shadow.get("receiptSha256"),
    }
    key = "%s:shadow-comparison:%s:%s" % (
        task_id, shadow.get("round"), shadow.get("candidateFingerprint"),
    )
    log.append("shadow.compared", trace_id=trace_id, task_id=task_id, key=key, data=compared)
    return compared


def _review_with_shadow(log, run, node, pairing, repo, task, round_no, feat_id, base):
    if _shadow_config(pairing) is not None:
        # open_task persists custody after the driver's dispatch snapshot was read.
        # Resolve the current binding before exporting any candidate to a shadow.
        task_id = node["taskId"]
        run = kernel._validated_run(feat_id, base)
        node = next((item for item in run["nodes"] if item["taskId"] == task_id), None)
        if node is None:
            raise DriverError("shadow review task is absent from the current run")
    shadow = _run_shadow_review(log, run, node, pairing, repo, task, round_no)
    review = kernel.review_task(
        feat_id, node["taskId"], repo=repo, base=base,
        reviewer_route=_reviewer_route(pairing),
    )
    closed_run = kernel._validated_run(feat_id, base)
    closed_node = next(item for item in closed_run["nodes"] if item["taskId"] == node["taskId"])
    direct = closed_node.get("directReview") \
        if isinstance(closed_node.get("directReview"), dict) else {}
    _record_shadow_comparison(
        log, kernel._kernel(run["state"])["traceId"], node["taskId"], shadow, review,
        codex_candidate_fingerprint=direct.get("candidateFingerprint"),
    )
    return review


def _task_metrics(run, node, log, ended_at=None):
    direct = node.get("directMakerUsage") if isinstance(node, dict) else None
    stored_receipts = direct.get("receipts") if isinstance(direct, dict) \
        and isinstance(direct.get("receipts"), list) else []
    receipts = kernel._unique_maker_receipts(stored_receipts)
    totals = kernel._maker_usage_totals(receipts) if receipts else {}
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
    end = ended_at if isinstance(ended_at, int) else int(time.time())
    wall_ms = max(0, end - int(started.get("at"))) * 1000 \
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
    shadow_rows = [row.get("data") for row in task_rows if row.get("type") == "shadow.reviewed"
                   and isinstance(row.get("data"), dict)]
    shadow_usage = [row.get("usage") for row in shadow_rows if isinstance(row.get("usage"), dict)]
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
        "shadowCalls": len(shadow_rows),
        "shadowMeasuredCalls": sum(1 for row in shadow_rows if row.get("ran") is True),
        "shadowWallMs": sum(int(row.get("durationMs") or 0) for row in shadow_rows),
        "shadowInputTokens": sum(int(item.get("prompt_tokens") or item.get("input_tokens") or 0)
                                 for item in shadow_usage),
        "shadowOutputTokens": sum(int(item.get("completion_tokens") or item.get("output_tokens") or 0)
                                  for item in shadow_usage),
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
    shadow_row = next((row for row in reversed(log.records())
                       if row.get("type") == "shadow.reviewed"
                       and row.get("taskId") == node.get("taskId")), None)
    shadow = shadow_row.get("data") if isinstance(shadow_row, dict) \
        and isinstance(shadow_row.get("data"), dict) else None
    return {
        **pairing,
        "makerObserved": observed_makers,
        "reviewerObserved": {
            "backend": review.get("backend"), "model": review.get("model"),
            "effort": review.get("effort"), "qualification": review.get("qualification"),
            "transport": review.get("transport"), "connection": review.get("connection"),
            "admissionId": review.get("admissionId"),
        } if review else None,
        "shadowReviewerObserved": {
            "backend": shadow.get("backend"), "model": shadow.get("model"),
            "effort": shadow.get("effort"), "standing": shadow.get("standing"),
            "ran": shadow.get("ran") is True,
        } if shadow else None,
    }


def _record_episode(ledger, log, run, node, pairing, experiment, seal):
    metrics, transcripts = _task_metrics(run, node, log)
    final_review = node.get("directReview") if isinstance(node.get("directReview"), dict) else {}
    verification = seal.get("verification") if isinstance(seal, dict) else {}
    comparison_row = next((row for row in reversed(log.records())
                           if row.get("type") == "shadow.compared"
                           and row.get("taskId") == node.get("taskId")), None)
    comparison = comparison_row.get("data") if isinstance(comparison_row, dict) \
        and isinstance(comparison_row.get("data"), dict) else None
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
            "shadowReview": (
                "clean" if comparison and comparison.get("shadowComparable") is True
                and comparison.get("shadowClean") is True
                else "findings" if comparison and comparison.get("shadowComparable") is True
                else "candidate_changed" if comparison and comparison.get("shadowRan") is True
                else "unavailable" if comparison else "not_configured"
            ),
            "shadowCodexVerdictAgreement": comparison.get("verdictAgreement") if comparison else None,
            "shadowStanding": comparison.get("standing") if comparison else None,
        },
        economics=metrics,
        artifact={"commit": seal.get("commit"), "transcriptHashes": transcripts},
        experiment=experiment,
    )
    ledger.append(episode)


def _record_incomplete_episode(ledger, log, run, node, pairing, experiment, terminal, review=None):
    terminal_event = log.latest("task.incomplete", node.get("taskId"))
    ended_at = terminal_event.get("at") if isinstance(terminal_event, dict) else None
    metrics, transcripts = _task_metrics(run, node, log, ended_at=ended_at)
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
    human_authorization = None
    requested_human_action = getattr(options, "human_action", None)
    requested_shadow_skip = getattr(options, "skip_shadow_review", None)
    if requested_shadow_skip is not None:
        requested_shadow_skip = _shadow_skip_reason(requested_shadow_skip)
        if requested_human_action != "fix_recheck":
            raise DriverError("--skip-shadow-review requires --human-action fix_recheck at a controller handoff")
    while True:
        run = kernel._validated_run(feat_id, base)
        repo = kernel._resolve_repo(run, options.repo)
        current = kernel._kernel(run["state"])
        if current.get("phase") == "stopped" and options.token_budget is not None \
                and kernel.direct_output_stop_kind(current) is not None:
            kernel.resume_budget_stop(feat_id, options.token_budget, base=base)
            run = kernel._validated_run(feat_id, base)
            current = kernel._kernel(run["state"])
        if current.get("phase") == "stopped" and options.retry_budget is not None \
                and str(current.get("stopReason") or "").startswith("retry budget exhausted ("):
            kernel.resume_retry_budget_stop(feat_id, options.retry_budget, base=base)
            run = kernel._validated_run(feat_id, base)
            current = kernel._kernel(run["state"])
        if current.get("phase") == "stopped" and options.wall_seconds is not None \
                and str(current.get("stopReason") or "").startswith("wall-clock budget exhausted ("):
            kernel.resume_wall_budget_stop(feat_id, options.wall_seconds, base=base)
            run = kernel._validated_run(feat_id, base)
            current = kernel._kernel(run["state"])
        if run["state"].get("stage") == "native_controller":
            active = current.get("activeTaskId")
            node = next((item for item in run["nodes"] if item.get("taskId") == active), None)
            handoff = node.get("nativeControllerHandoff") if isinstance(node, dict) else {}
            if requested_human_action is None:
                return {
                    "action": "human", "reason": handoff.get("reason") or "human decision required",
                    "featId": feat_id, "taskId": active,
                    "allowedActions": handoff.get("allowedActions") or [],
                }
            effective_round_cap = options.round_cap or run["args"].get("roundCap") or 3
            if requested_shadow_skip is not None:
                assigned = log.latest("pairing.assigned", active) or {}
                if _shadow_config((assigned.get("data") or {}).get("pairing") or {}) is None:
                    raise DriverError("this task has no frozen Codex-gated shadow pairing to skip")
            human_authorization = _resume_controller_handoff(
                run, requested_human_action, effective_round_cap,
                skip_shadow_reason=requested_shadow_skip,
            )
            log.append(
                "human.decision", trace_id=current.get("traceId") or feat_id, task_id=active,
                key="%s:human:%d:%s" % (
                    active, human_authorization["reviewRound"], human_authorization["action"],
                ), data=human_authorization,
            )
            requested_human_action = None
            requested_shadow_skip = None
            run = kernel._validated_run(feat_id, base)
            current = kernel._kernel(run["state"])
        else:
            pending_authorization = _pending_controller_authorization(run)
            if requested_shadow_skip is not None:
                if pending_authorization is None \
                        or pending_authorization.get("shadowSkipReason") != requested_shadow_skip:
                    raise DriverError("shadow skip disagrees with the persisted controller authorization")
                requested_shadow_skip = None
            if requested_human_action is not None:
                if pending_authorization is None \
                        or pending_authorization.get("action") != requested_human_action:
                    raise DriverError("--human-action is valid only for a native controller handoff")
                requested_human_action = None
            if pending_authorization is not None:
                explicit_round_cap = options.round_cap
                if explicit_round_cap is not None \
                        and explicit_round_cap != pending_authorization.get("authorizedRoundCap"):
                    raise DriverError(
                        "--round-cap conflicts with the persisted human authorization"
                    )
                human_authorization = pending_authorization
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
            shadow_keys = {
                "shadowReviewerBackend", "shadowReviewerModel", "shadowReviewerEffort",
            }
            route_keys = set(EXTERNAL_REVIEW_ROUTE_FIELDS)
            if not isinstance(pairing, dict) or not required.issubset(pairing) \
                    or set(pairing) - required - shadow_keys - route_keys \
                    or not all(isinstance(pairing.get(key), str) and pairing.get(key)
                               for key in required) \
                    or (set(pairing) & shadow_keys and set(pairing) & shadow_keys != shadow_keys) \
                    or not all(isinstance(pairing.get(key), str) and pairing.get(key)
                               for key in set(pairing) & shadow_keys):
                raise DriverError("durable task pairing is malformed")
            _shadow_config(pairing)
            _reviewer_route(pairing)
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

        round_cap = (
            human_authorization.get("authorizedRoundCap")
            if isinstance(human_authorization, dict)
            else options.round_cap or run["args"].get("roundCap") or 3
        )
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
            if human_authorization is not None:
                verify_decision = {
                    "action": human_authorization["action"],
                    "reason": "explicit operator decision at the native controller handoff",
                }
                human_authorization = None
            else:
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
                       key=_decision_event_key(
                           task_id, "verify-decision", max(1, round_no), verify_decision,
                       ),
                       data={**verify_decision, "budgetEvidence": budget_evidence})
            if verify_decision["action"] == "stop":
                return incomplete({
                    "action": "stop", "reason": verify_decision["reason"],
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=_review_from_node(node), terminal=True)
            if verify_decision["action"] == "human":
                value = incomplete({
                    "action": "human", "reason": verify_decision["reason"],
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=_review_from_node(node))
                _persist_controller_handoff(
                    kernel._validated_run(feat_id, base), task_id, verify_decision,
                    verify_failure=True,
                )
                return value
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
            budget_stop = _post_agent_budget_stop(feat_id, base, include_retries=False)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            target_round = current.get("directReviewRound")
            if isinstance(target_round, bool) or not isinstance(target_round, int) or target_round < 1:
                target_round = round_no + 1
            review = _review_with_shadow(
                log, run, node, pairing, repo, run["specs"][selected], target_round,
                feat_id, base,
            )
            round_no = review.get("reviewer", {}).get("round", round_no)
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
            budget_stop = _post_agent_budget_stop(feat_id, base, include_retries=False)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, terminal=True)
            review = _review_with_shadow(
                log, run, node, pairing, repo, run["specs"][selected], round_no + 1,
                feat_id, base,
            )
            round_no = review.get("reviewer", {}).get("round", 1)

        # A failed verifier is a semantic fork: the controller chooses a bounded retry or a fresh
        # fix + independent re-review. It is never an unconditional systematic rerun.
        if seal is None and phase == "task_verify_failed" and review is not None:
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            round_no += 1
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
            usage = kernel._usage(kernel._validated_run(feat_id, base)["state"])
            kernel.record_usage(feat_id, retries=usage["retries"] + 1, base=base)
            budget_stop = _post_agent_budget_stop(feat_id, base, include_retries=False)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            run = kernel._validated_run(feat_id, base)
            node = next(item for item in run["nodes"] if item["taskId"] == task_id)
            review = _review_with_shadow(
                log, run, node, pairing, repo, run["specs"][selected], round_no,
                feat_id, base,
            )
            fixed_unreviewed = False

        while seal is None and review is not None and not review.get("clean"):
            # The reserve protects the next expensive maker/fix turn, not the small controller
            # decision that decides whether such a turn is worthwhile. Let the controller see
            # the honest exhausted evidence and choose stop/human without forcing an unnecessary
            # budget increase. A fix decision is still gated immediately below before launch.
            budget_evidence = _direct_output_budget_evidence(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if human_authorization is not None:
                decision = {
                    "action": human_authorization["action"],
                    "reason": "explicit operator decision at the native controller handoff",
                }
                human_authorization = None
            else:
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
                       key=_decision_event_key(
                           task_id, "decision", max(1, round_no), decision,
                       ), data=decision)
            print("  controller → %s (%s)" % (decision["action"], decision["reason"]), flush=True)
            if decision["action"] == "stop":
                return incomplete({
                    "action": "stop", "reason": decision["reason"],
                    "featId": feat_id, "taskId": task_id, "review": review,
                }, review_evidence=review, terminal=True)
            if decision["action"] == "human":
                value = incomplete({
                    "action": "human", "reason": decision["reason"],
                    "featId": feat_id, "taskId": task_id, "review": review,
                }, review_evidence=review)
                _persist_controller_handoff(
                    kernel._validated_run(feat_id, base), task_id, decision,
                    verify_failure=False,
                )
                return value
            budget_stop = _pre_agent_budget_stop(
                feat_id, base, reserve_tokens=getattr(options, "direct_output_reserve", None),
            )
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            round_no += 1
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
            usage = kernel._usage(kernel._validated_run(feat_id, base)["state"])
            kernel.record_usage(feat_id, retries=usage["retries"] + 1, base=base)
            budget_stop = _post_agent_budget_stop(feat_id, base, include_retries=False)
            if budget_stop:
                return incomplete({
                    "action": "stop", "reason": budget_stop,
                    "featId": feat_id, "taskId": task_id,
                }, review_evidence=review, terminal=True)
            if decision["action"] == "fix_verify":
                fixed_unreviewed = True
                break
            run = kernel._validated_run(feat_id, base)
            node = next(item for item in run["nodes"] if item["taskId"] == task_id)
            review = _review_with_shadow(
                log, run, node, pairing, repo, run["specs"][selected], round_no,
                feat_id, base,
            )

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
    run.add_argument("--reviewer-profile-backend", default=None,
                     help="exact admitted Studio profile id for http_openai_compat")
    run.add_argument("--reviewer-training-org", default=None,
                     help="exact admission-bound reviewer training organization")
    run.add_argument("--reviewer-transport", choices=("loopback", "direct_https", "ssh_tunnel"),
                     default=None)
    run.add_argument("--reviewer-connection", default=None,
                     help="exact admitted Studio connection id")
    run.add_argument("--reviewer-qualification", default=None,
                     help="exact qual1 fingerprint from the checked-in admission")
    run.add_argument("--shadow-reviewer-backend", default=None,
                     help="Studio profile to evaluate before the Codex gate")
    run.add_argument("--shadow-reviewer-model", default=None,
                     help="exact declared model id for the shadow reviewer")
    run.add_argument("--shadow-reviewer-effort", choices=("low", "medium", "high", "xhigh"),
                     default="medium")
    run.add_argument("--skip-shadow-review", metavar="REASON", default=None,
                     help="skip only the next advisory round at --human-action fix_recheck; Codex still gates")
    run.add_argument("--controller-model", default="sonnet")
    run.add_argument("--round-cap", type=int, default=None)
    run.add_argument(
        "--human-action", choices=tuple(sorted(HUMAN_RESUME_ACTIONS)), default=None,
        help="explicitly resume a durable native controller handoff",
    )
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
