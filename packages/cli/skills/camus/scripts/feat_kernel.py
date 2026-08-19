#!/usr/bin/env python3
"""Deterministic feature control plane for Camus's hybrid orchestrator.

The model decides *what* work to do. This kernel owns the facts models should never have to
reconstruct: canonical resume arguments, task identity, Git/receipt evidence, phase transitions,
trace continuity, and execution budgets.

Commands:

  feat_kernel.py next FEAT_ID [--repo PATH]
      Read-only. Emit one compact typed action. Full task contracts stay in the sealed args
      sidecar and are represented by a validated reference + hash.

  feat_kernel.py task FEAT_ID [TASK_ID] [--repo PATH]
      Read-only. Materialize the selected task's camus-loop args only when the orchestrator is
      ready to dispatch it. This is the sole large-payload boundary.

  feat_kernel.py dispatch FEAT_ID [TASK_ID] [--repo PATH]
      Atomically move the selected task to running and emit its loop args. Replays for the same
      trace/task are idempotent; another task or exhausted budget refuses.

  feat_kernel.py prepare FEAT_ID [--repo PATH] [budgets...]
      Mutating, idempotent phase boundary. Refuse a dirty tree; check out the recorded feat branch;
      recover any crash-after-merge receipts; run env + deterministic baseline verification; write
      an atomic checkpoint; emit the same compact action as `next`.

  feat_kernel.py usage FEAT_ID [--tokens N] [--retries N] [--phase NAME]
      Atomically checkpoint monotonic usage without changing a task verdict.

State is still the existing ~/.camus/feats/<id>.json contract. Kernel-owned metadata lives under
state.kernel, so old readers ignore it and old runs remain migratable. A per-feat flock serializes
mutations; writes are fsync + replace. No model writes or reformats either state or canonical args.
"""
import argparse
import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import env_check
import resume_scan


SCHEMA_VERSION = 1
FEAT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
COMPLETE_TASK_STATUSES = ("done", "done_with_findings", "noop")
RECOVERABLE_MERGE_STATUSES = ("ready_to_merge", "merge_failed")
VERIFY_UNSAFE = ("$", "`", '"', "\\", "\n", "\r")


class Refusal(Exception):
    """A fail-closed contract or evidence refusal, suitable for a typed stop."""


def camus_home():
    return os.environ.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus")


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except FileNotFoundError:
        raise Refusal("missing JSON artifact: %s" % path)
    except (OSError, ValueError) as exc:
        raise Refusal("unreadable JSON artifact %s: %s" % (path, exc))
    if not isinstance(value, dict):
        raise Refusal("JSON artifact is not an object: %s" % path)
    return value


def _atomic_write(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".kernel-", suffix=".tmp")
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


@contextlib.contextmanager
def _locked(feats_dir, feat_id):
    os.makedirs(feats_dir, exist_ok=True)
    path = os.path.join(feats_dir, feat_id + ".kernel.lock")
    with open(path, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _git(repo, *args, timeout=60):
    try:
        result = subprocess.run(
            ["git", "-C", repo] + list(args), capture_output=True, text=True, timeout=timeout
        )
    except OSError as exc:
        return 1, str(exc)
    except subprocess.TimeoutExpired:
        return 1, "git timed out after %ss" % timeout
    return result.returncode, (result.stdout + result.stderr).strip()


def _git_ok(repo, *args):
    code, out = _git(repo, *args)
    if code != 0:
        raise Refusal("git %s failed: %s" % (" ".join(args), out or "unknown error"))
    return out


def _task_id(feat_id, task):
    slug = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")[:40] or "task"
    digest = resume_scan._fnv1a_js(feat_id + "::" + task)[:6]
    return "%s-%s" % (slug, digest)


def _task_hash(task):
    return "fnv1a32:" + resume_scan._fnv1a_js(task)


def _validated_run(feat_id, base=None):
    if not isinstance(feat_id, str) or not FEAT_ID_RE.fullmatch(feat_id):
        raise Refusal("invalid feat id")
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    state_path = os.path.join(feats_dir, feat_id + ".json")
    state = _read_json(state_path)
    if state.get("featId") != feat_id:
        raise Refusal("feat state identity mismatch")
    args = resume_scan._canonical_args(state, feats_dir)
    if not isinstance(args, dict):
        raise Refusal("canonical resume args are missing, corrupt, or hash-incoherent")
    if args.get("argsVersion") != resume_scan.SUPPORTED_ARGS_VERSION:
        raise Refusal("unsupported canonical args version")
    if resume_scan._feat_id(args) != feat_id:
        raise Refusal("canonical args derive a different feat id")
    specs = args.get("tasks")
    nodes = state.get("tasks")
    if not isinstance(specs, list) or not specs or not isinstance(nodes, list):
        raise Refusal("feat tasks are missing")
    if len(specs) != len(nodes):
        raise Refusal("state/canonical task count mismatch")
    for index, (spec, node) in enumerate(zip(specs, nodes)):
        if not isinstance(spec, str) or not spec.strip() or not isinstance(node, dict):
            raise Refusal("malformed task at index %d" % index)
        expected = _task_id(feat_id, spec)
        if node.get("taskId") != expected:
            raise Refusal("task identity mismatch at index %d" % index)
    return {
        "base": base,
        "featsDir": feats_dir,
        "statePath": state_path,
        "state": state,
        "args": args,
        "specs": specs,
        "nodes": nodes,
    }


def _resolve_repo(run, explicit=None):
    requested = os.path.abspath(explicit or run["args"].get("targetPath") or os.getcwd())
    top = _git_ok(requested, "rev-parse", "--show-toplevel")
    top = os.path.realpath(top)
    if os.path.realpath(requested) != top:
        # targetPath may legitimately name a scoped subdirectory. Git phases still run at top.
        requested = top
    canonical_target = run["args"].get("targetPath")
    if canonical_target:
        canonical_top = _git_ok(os.path.abspath(canonical_target), "rev-parse", "--show-toplevel")
        if os.path.realpath(canonical_top) != top:
            raise Refusal("--repo and canonical targetPath belong to different repositories")
    return top


def _kernel(state):
    value = state.get("kernel")
    return value if isinstance(value, dict) else {}


def _budgets(run, overrides=None):
    overrides = overrides or {}
    prior = _kernel(run["state"]).get("budgets")
    prior = prior if isinstance(prior, dict) else {}
    from_args = run["args"].get("budgetTokens")

    def choose(name, fallback=None):
        value = overrides.get(name)
        if value is None:
            value = prior.get(name, fallback)
        if value is None:
            return None
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise Refusal("%s budget must be an integer" % name)
        if value <= 0:
            raise Refusal("%s budget must be positive" % name)
        return value

    return {
        "wallSeconds": choose("wallSeconds"),
        "tokens": choose("tokens", from_args),
        "retries": choose("retries"),
    }


def _usage(state):
    value = _kernel(state).get("usage")
    value = value if isinstance(value, dict) else {}
    return {
        "startedAt": value.get("startedAt"),
        "tokens": max(0, int(value.get("tokens") or 0)),
        "retries": max(0, int(value.get("retries") or 0)),
    }


def _budget_stop(budgets, usage, now=None):
    now = int(time.time()) if now is None else int(now)
    if budgets.get("tokens") is not None and usage["tokens"] >= budgets["tokens"]:
        return "token budget exhausted (%d/%d)" % (usage["tokens"], budgets["tokens"])
    if budgets.get("retries") is not None and usage["retries"] >= budgets["retries"]:
        return "retry budget exhausted (%d/%d)" % (usage["retries"], budgets["retries"])
    started = usage.get("startedAt")
    if budgets.get("wallSeconds") is not None and isinstance(started, int):
        elapsed = max(0, now - started)
        if elapsed >= budgets["wallSeconds"]:
            return "wall-clock budget exhausted (%ds/%ds)" % (elapsed, budgets["wallSeconds"])
    return None


def _selected_index(run):
    nodes = run["nodes"]
    by_id = {node.get("taskId"): node for node in nodes}
    for index, node in enumerate(nodes):
        status = node.get("status")
        if status in COMPLETE_TASK_STATUSES:
            continue
        if status in ("pending", "running"):
            deps = node.get("dependsOn") or []
            if not isinstance(deps, list):
                raise Refusal("task %s has malformed dependsOn" % node.get("taskId"))
            blocked = [dep for dep in deps if by_id.get(dep, {}).get("status") not in COMPLETE_TASK_STATUSES]
            if blocked:
                return None, "task %s is blocked by %s" % (node.get("taskId"), ", ".join(blocked))
            return index, None
        return None, "task %s requires a decision (status %s)" % (node.get("taskId"), status)
    return None, None


def _envelope(run, repo=None, now=None):
    state, args, nodes, specs = run["state"], run["args"], run["nodes"], run["specs"]
    kernel = _kernel(state)
    budgets = _budgets(run)
    usage = _usage(state)
    stop = _budget_stop(budgets, usage, now=now)
    index, blocked = _selected_index(run)
    complete = sum(1 for node in nodes if node.get("status") in COMPLETE_TASK_STATUSES)
    trace_id = kernel.get("traceId") or ("%s:a0" % state["featId"])

    if stop or blocked:
        action, reason = "stop", stop or blocked
    elif index is None:
        action, reason = "integrate", "all task nodes are terminal; integration proof is next"
    else:
        action, reason = "run_task", "next eligible task in the ordered feature"

    out = {
        "schemaVersion": SCHEMA_VERSION,
        "traceId": trace_id,
        "attempt": int(kernel.get("attempt") or 0),
        "action": action,
        "reason": reason,
        "feature": {
            "id": state["featId"],
            "title": state.get("feat") or args.get("feat"),
            "branch": state.get("featBranch"),
            "base": state.get("base"),
            "status": state.get("status"),
            "completed": complete,
            "total": len(nodes),
        },
        "budgets": budgets,
        "usage": usage,
    }
    if repo:
        out["repo"] = repo
    if action == "run_task":
        node, spec = nodes[index], specs[index]
        out["task"] = {
            "id": node["taskId"],
            "index": index,
            "brief": node.get("brief") or re.sub(r"\s+", " ", spec).strip()[:160],
            "contractRef": "%s#tasks/%d" % (state.get("resumeArgsRef") or "inline:resumeArgs", index),
            "contractHash": _task_hash(spec),
            "branch": node.get("branch"),
        }
    return out


def _receipt_evidence(run, repo, node):
    task_id = node.get("taskId")
    receipt_path = os.path.join(run["base"], "merges", task_id + ".json")
    if not os.path.exists(receipt_path):
        return None
    receipt = _read_json(receipt_path)
    expected_msg = "camus(feat): merge %s" % task_id
    if receipt.get("msg") != expected_msg or receipt.get("merged") is not True:
        raise Refusal("merge receipt for %s does not bind to the expected successful merge" % task_id)
    if receipt.get("conflict") is not False or receipt.get("error") not in (None, ""):
        raise Refusal("merge receipt for %s reports a conflict/error" % task_id)
    evidence = receipt.get("after")
    if receipt.get("alreadyUpToDate") is True:
        evidence = receipt.get("priorMergeCommit")
    if not isinstance(evidence, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", evidence):
        raise Refusal("merge receipt for %s has no usable commit evidence" % task_id)
    feat_branch = run["state"].get("featBranch")
    task_branch = node.get("branch")
    if not isinstance(feat_branch, str) or not isinstance(task_branch, str):
        raise Refusal("task/feature branch missing while checking merge receipt")
    if _git(repo, "cat-file", "-e", evidence + "^{commit}")[0] != 0:
        raise Refusal("merge receipt evidence for %s does not exist in git" % task_id)
    if _git(repo, "merge-base", "--is-ancestor", evidence, feat_branch)[0] != 0:
        raise Refusal("merge receipt evidence for %s is not on the feature branch" % task_id)
    # Bind the TASK to the exact receipt evidence, not merely to today's feature tip. Checking
    # only taskBranch ⊆ featBranch lets a forged/stale receipt point `after` at any older feature
    # commit once the real task happens to be merged later.
    if _git(repo, "merge-base", "--is-ancestor", task_branch, evidence)[0] != 0:
        raise Refusal("task branch for %s is not contained by the receipt evidence" % task_id)
    subject = _git_ok(repo, "show", "-s", "--format=%s", evidence)
    if subject != expected_msg:
        raise Refusal("merge receipt evidence for %s has the wrong commit subject" % task_id)
    return evidence


def _recover_receipts(run, repo):
    recovered = []
    for node in run["nodes"]:
        if node.get("status") not in RECOVERABLE_MERGE_STATUSES:
            continue
        evidence = _receipt_evidence(run, repo, node)
        if not evidence:
            continue
        proven = node.get("provenStatus")
        node["status"] = "done_with_findings" if proven == "done_with_findings" else "done"
        node["loopStatus"] = "reconciled_from_merge_receipt"
        node["reconciledSha"] = evidence
        decisions = node.get("decisions")
        if not isinstance(decisions, list):
            decisions = []
            node["decisions"] = decisions
        marker = "kernel recovered merge receipt at %s" % evidence
        if not any(isinstance(d, dict) and d.get("what") == marker for d in decisions):
            decisions.append({
                "what": marker,
                "why": "merge.sh receipt and git ancestry independently prove the task landed",
                "alternative": "",
            })
        recovered.append(task_id if (task_id := node.get("taskId")) else "?")
    return recovered


def _append_event(state, message):
    events = state.get("events")
    if not isinstance(events, list):
        events = []
    seq = int(state.get("eventSeq") or 0) + 1
    events.append({"seq": seq, "msg": message})
    state["events"] = events[-20:]
    state["eventSeq"] = seq


def _run_verify(run, repo, timeout):
    verify_cmd = run["args"].get("verifyCmd")
    if verify_cmd and (not isinstance(verify_cmd, str) or any(ch in verify_cmd for ch in VERIFY_UNSAFE)):
        raise Refusal("canonical verifyCmd contains shell-unsafe characters")
    env = os.environ.copy()
    if verify_cmd:
        env["CAMUS_VERIFY_CMD"] = verify_cmd
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify.py")
    try:
        result = subprocess.run(
            [sys.executable, script, repo], cwd=repo, env=env,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise Refusal("baseline verification timed out after %ss" % timeout)
    except OSError as exc:
        raise Refusal("could not execute baseline verifier: %s" % exc)
    raw = (result.stdout or "").strip()
    try:
        value = json.loads(raw)
    except ValueError:
        raise Refusal("baseline verifier returned non-JSON output: %s" % ((raw or result.stderr)[-500:]))
    if not isinstance(value, dict) or not isinstance(value.get("pass"), bool):
        raise Refusal("baseline verifier returned an invalid contract")
    return value


def prepare(feat_id, repo=None, wall_seconds=None, token_budget=None, retry_budget=None,
            verify_timeout=3600, now=None, base=None):
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        dirty = _git_ok(repo, "status", "--porcelain", "--untracked-files=all")
        if dirty:
            raise Refusal("repository is dirty; refusing kernel prepare")
        feat_branch = run["state"].get("featBranch")
        if not isinstance(feat_branch, str) or not feat_branch.startswith("camus/feat-"):
            raise Refusal("state has no valid feature branch")
        if _git(repo, "show-ref", "--verify", "--quiet", "refs/heads/" + feat_branch)[0] != 0:
            raise Refusal("recorded feature branch does not exist")
        code, out = _git(repo, "-c", "core.hooksPath=/dev/null", "checkout", feat_branch)
        if code != 0:
            raise Refusal("could not check out feature branch: %s" % out)

        recovered = _recover_receipts(run, repo)
        issues = env_check.check_env(repo)
        if issues:
            raise Refusal("environment not ready: " + "; ".join(issues))
        verification = _run_verify(run, repo, verify_timeout)
        if verification.get("pass") is not True:
            failures = verification.get("failures")
            raise Refusal("baseline verification is red: %s" % json.dumps(failures, ensure_ascii=False)[:1000])
        verified_head = verification.get("head")
        actual_head = _git_ok(repo, "rev-parse", "HEAD")
        if not isinstance(verified_head, str) or verified_head != actual_head:
            raise Refusal("baseline verification is not bound to the checked-out feature HEAD")

        state = run["state"]
        previous = _kernel(state)
        budgets = _budgets(run, {
            "wallSeconds": wall_seconds,
            "tokens": token_budget,
            "retries": retry_budget,
        })
        usage = _usage(state)
        index, blocked = _selected_index(run)
        active = run["nodes"][index].get("taskId") if index is not None else None
        reusable = (
            previous.get("phase") == "ready"
            and previous.get("activeTaskId") == active
            and previous.get("repoHead") == _git_ok(repo, "rev-parse", "HEAD")
        )
        attempt = int(previous.get("attempt") or 0) if reusable else int(previous.get("attempt") or 0) + 1
        trace_id = previous.get("traceId") if reusable else "%s:a%d" % (feat_id, attempt)
        if not isinstance(usage.get("startedAt"), int):
            usage["startedAt"] = now
        state["kernel"] = {
            "schemaVersion": SCHEMA_VERSION,
            "traceId": trace_id,
            "attempt": attempt,
            "phase": "ready" if not blocked else "stopped",
            "activeTaskId": active,
            "repoHead": actual_head,
            "budgets": budgets,
            "usage": usage,
            "recoveredReceipts": recovered,
        }
        state["status"] = "running" if not blocked else "needs_human"
        state["stage"] = "kernel_ready" if not blocked else "kernel_stop"
        state["env"] = {
            "ready": True,
            "issues": [],
            "facts": env_check.collect_facts(),
            "when": "kernel_prepare",
        }
        state["baseline"] = verification
        _append_event(state, "Kernel %s prepared %s%s" % (
            trace_id, active or "integration",
            "; recovered " + ", ".join(recovered) if recovered else "",
        ))
        _atomic_write(run["statePath"], state)
        # Re-load so the emitted envelope is derived from the exact persisted bytes.
        run = _validated_run(feat_id, base)
        return _envelope(run, repo=repo, now=now)


def task_payload(run, task_id=None, repo=None):
    index, blocked = _selected_index(run)
    if blocked:
        raise Refusal(blocked)
    if index is None:
        raise Refusal("no runnable task; integration is next")
    node = run["nodes"][index]
    if task_id and node.get("taskId") != task_id:
        raise Refusal("requested task is not the kernel-selected next task")
    spec = run["specs"][index]
    args = run["args"]
    sibling = []
    for i, other in enumerate(run["nodes"]):
        if i == index:
            continue
        sibling.append("- %s [%s]: %s" % (
            other.get("taskId"), other.get("status"),
            other.get("brief") or re.sub(r"\s+", " ", run["specs"][i]).strip()[:160],
        ))
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "traceId": _kernel(run["state"]).get("traceId") or "%s:a0" % run["state"]["featId"],
        "taskId": node["taskId"],
        "loopArgs": {
            "task": spec,
            "branchPrefix": "camus/feat/%s/" % run["state"]["featId"],
            "idSalt": run["state"]["featId"],
            "policy": args.get("policy") or "ask_on_ambiguity",
            "siblingTasks": "\n".join(sibling),
        },
    }
    for key in ("model", "modelTier", "roundCap", "verifyCmd", "posture", "targetPath"):
        if key in args:
            payload["loopArgs"][key] = args[key]
    env_state = run["state"].get("env")
    env_facts = env_state.get("facts") if isinstance(env_state, dict) else None
    if isinstance(env_facts, list) and env_facts:
        payload["loopArgs"]["envFacts"] = "\n".join("- " + str(fact) for fact in env_facts)
    answers = args.get("answers")
    if isinstance(answers, dict) and node["taskId"] in answers:
        payload["loopArgs"]["humanAnswer"] = str(answers[node["taskId"]])
    if repo:
        payload["repo"] = repo
    return payload


def dispatch_task(feat_id, task_id=None, repo=None, base=None, now=None):
    """Atomically bind the current trace to one task before its model call begins."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel = _kernel(run["state"])
        if not kernel or kernel.get("phase") not in ("ready", "task_running"):
            raise Refusal("kernel is not prepared at a dispatchable phase")
        envelope = _envelope(run, repo=repo, now=now)
        if envelope.get("action") != "run_task":
            raise Refusal("kernel cannot dispatch: %s" % envelope.get("reason"))
        selected = envelope["task"]["id"]
        if task_id and task_id != selected:
            raise Refusal("requested task is not the kernel-selected next task")
        if kernel.get("activeTaskId") != selected:
            raise Refusal("prepared trace is bound to a different task")
        feat_branch = run["state"].get("featBranch")
        current_branch = _git_ok(repo, "branch", "--show-current")
        if current_branch != feat_branch:
            raise Refusal("checkout moved after prepare; expected feature branch %s" % feat_branch)
        current_head = _git_ok(repo, "rev-parse", "HEAD")
        if current_head != kernel.get("repoHead"):
            raise Refusal("feature HEAD moved after prepare; run kernel prepare again")
        if _git_ok(repo, "status", "--porcelain", "--untracked-files=all"):
            raise Refusal("repository became dirty after prepare; refusing dispatch")
        node = next((item for item in run["nodes"] if item.get("taskId") == selected), None)
        if node is None or node.get("status") not in ("pending", "running"):
            raise Refusal("selected task is not dispatchable")
        replay = node.get("status") == "running" and kernel.get("phase") == "task_running"
        node["status"] = "running"
        kernel["phase"] = "task_running"
        kernel["dispatchedAt"] = kernel.get("dispatchedAt") if replay else now
        kernel["updatedAt"] = now
        run["state"]["kernel"] = kernel
        run["state"]["status"] = "running"
        run["state"]["stage"] = "kernel_task"
        if not replay:
            _append_event(run["state"], "Kernel %s dispatched %s" % (kernel.get("traceId"), selected))
        _atomic_write(run["statePath"], run["state"])
        persisted = _validated_run(feat_id, base)
        payload = task_payload(persisted, selected, repo=repo)
        payload["dispatched"] = True
        payload["replayed"] = replay
        return payload


def record_usage(feat_id, tokens=None, retries=None, phase=None, base=None, now=None):
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        state = run["state"]
        kernel = _kernel(state)
        if not kernel:
            raise Refusal("kernel has not prepared this feature")
        usage = _usage(state)
        if tokens is not None:
            if tokens < usage["tokens"]:
                raise Refusal("token usage is monotonic; refusing a decrease")
            usage["tokens"] = tokens
        if retries is not None:
            if retries < usage["retries"]:
                raise Refusal("retry usage is monotonic; refusing a decrease")
            usage["retries"] = retries
        kernel["usage"] = usage
        if phase:
            kernel["phase"] = phase
        kernel["updatedAt"] = now
        state["kernel"] = kernel
        _atomic_write(run["statePath"], state)
        return _envelope(_validated_run(feat_id, base), now=now)


def _emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _parser():
    parser = argparse.ArgumentParser(description="Camus deterministic hybrid feature kernel")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("next", "task", "dispatch"):
        p = sub.add_parser(name)
        p.add_argument("feat_id")
        if name in ("task", "dispatch"):
            p.add_argument("task_id", nargs="?")
        p.add_argument("--repo", default=None)
        p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("prepare")
    p.add_argument("feat_id")
    p.add_argument("--repo", default=None)
    p.add_argument("--wall-seconds", type=int, default=None)
    p.add_argument("--token-budget", type=int, default=None)
    p.add_argument("--retry-budget", type=int, default=None)
    p.add_argument("--verify-timeout", type=int, default=3600)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("usage")
    p.add_argument("feat_id")
    p.add_argument("--tokens", type=int, default=None)
    p.add_argument("--retries", type=int, default=None)
    p.add_argument("--phase", default=None)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    options = _parser().parse_args(argv)
    try:
        if options.command == "prepare":
            value = prepare(
                options.feat_id, repo=options.repo, wall_seconds=options.wall_seconds,
                token_budget=options.token_budget, retry_budget=options.retry_budget,
                verify_timeout=options.verify_timeout, base=options.base,
            )
        elif options.command == "usage":
            value = record_usage(
                options.feat_id, tokens=options.tokens, retries=options.retries,
                phase=options.phase, base=options.base,
            )
        elif options.command == "dispatch":
            value = dispatch_task(
                options.feat_id, options.task_id, repo=options.repo, base=options.base,
            )
        else:
            run = _validated_run(options.feat_id, options.base)
            repo = _resolve_repo(run, options.repo)
            if options.command == "next":
                value = _envelope(run, repo=repo)
            else:  # task
                value = task_payload(run, options.task_id, repo=repo)
        _emit(value)
        return 0
    except Refusal as exc:
        _emit({"schemaVersion": SCHEMA_VERSION, "action": "stop", "reason": str(exc)})
        return 2
    except OSError as exc:
        _emit({"schemaVersion": SCHEMA_VERSION, "action": "stop", "reason": "kernel I/O failure: %s" % exc})
        return 2


if __name__ == "__main__":
    sys.exit(main())
