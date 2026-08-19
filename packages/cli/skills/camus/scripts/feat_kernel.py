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

  feat_kernel.py accept FEAT_ID TASK_ID --result-file PATH [--commit SHA]
      Validate the workflow receipt, independent reviewer receipt, task checkout, and a fresh
      deterministic HEAD-bound verify; checkpoint honest provenance as ready_to_merge.

  feat_kernel.py land FEAT_ID TASK_ID
      Merge only an accepted task through merge.sh, validate its merge receipt + Git ancestry,
      and restore the accepted done/done_with_findings status without laundering provenance.

  feat_kernel.py open FEAT_ID TASK_ID
      Materialize the deterministic task worktree for a direct hybrid run.

  feat_kernel.py review FEAT_ID TASK_ID
      Run the bound independent reviewer directly, without a model relay.

  feat_kernel.py seal FEAT_ID TASK_ID [--fixed-unreviewed]
      Commit and verify the reviewed candidate, preserving clean or fixed-unreviewed standing.

State is still the existing ~/.camus/feats/<id>.json contract. Kernel-owned metadata lives under
state.kernel, so old readers ignore it and old runs remain migratable. A per-feat flock serializes
mutations; writes are fsync + replace. No model writes or reformats either state or canonical args.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import adapter
import env_check
import resume_scan


SCHEMA_VERSION = 1
FEAT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
COMPLETE_TASK_STATUSES = ("done", "done_with_findings", "noop")
RECOVERABLE_MERGE_STATUSES = ("ready_to_merge", "merge_failed")
VERIFY_UNSAFE = ("$", "`", '"', "\\", "\n", "\r")
HEX_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REVIEWED_STATUSES = ("done", "done_with_findings", "verify_inconclusive")
SEAT_VALUE_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
DIRECT_REVIEW_AWAITS = 20


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


def _seats(run, overrides=None):
    overrides = overrides or {}
    prior = _kernel(run["state"]).get("seats")
    prior = prior if isinstance(prior, dict) else {}

    def choose(name, fallback=None):
        value = overrides.get(name)
        if value is None:
            value = prior.get(name, fallback)
        if value is None or value == "":
            return None
        if not isinstance(value, str) or not SEAT_VALUE_RE.fullmatch(value):
            raise Refusal("%s seat value is invalid" % name)
        return value

    effort = choose("reviewerEffort")
    if effort is not None and effort not in ("low", "medium", "high", "xhigh"):
        raise Refusal("reviewer effort must be low|medium|high|xhigh")
    return {
        "makerModel": choose("makerModel", run["args"].get("model")),
        "reviewerBackend": choose("reviewerBackend"),
        "reviewerModel": choose("reviewerModel"),
        "reviewerEffort": effort,
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
        "seats": _seats(run),
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


def _sha256_file(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError as exc:
        raise Refusal("could not hash evidence file %s: %s" % (path, exc))


def _json_command(argv, cwd, env=None, timeout=120, label="command"):
    try:
        result = subprocess.run(
            argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not execute %s: %s" % (label, exc))
    raw = (result.stdout or "").strip()
    try:
        value = json.loads(raw)
    except ValueError:
        raise Refusal("%s returned non-JSON output: %s" % (label, (raw or result.stderr)[-500:]))
    if not isinstance(value, dict):
        raise Refusal("%s returned a non-object JSON contract" % label)
    return value


def _candidate_fingerprint(worktree):
    """Bind the exact HEAD + working-tree candidate after review made new files visible."""
    # Normalize new files into intent-to-add entries exactly as review.sh does. Without this,
    # the same bytes have two representations (untracked before review, diff-visible after it),
    # making a stable before/after-review binding impossible.
    _git_ok(worktree, "add", "-N", ".")
    head = _git_ok(worktree, "rev-parse", "HEAD")
    try:
        diff = subprocess.run(
            ["git", "-C", worktree, "diff", "--binary", "--no-renames", "HEAD", "--", "."],
            capture_output=True, timeout=60,
        )
        untracked = subprocess.run(
            ["git", "-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"],
            capture_output=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not fingerprint task candidate: %s" % exc)
    if diff.returncode != 0 or untracked.returncode != 0:
        error = diff.stderr if diff.returncode != 0 else untracked.stderr
        raise Refusal("could not fingerprint task candidate: %s" % error[-500:].decode("utf-8", "replace"))
    digest = hashlib.sha256(head.encode("ascii") + b"\0diff\0" + diff.stdout)
    for raw_path in sorted(path for path in untracked.stdout.split(b"\0") if path):
        path = os.fsdecode(raw_path)
        absolute = os.path.join(worktree, path)
        try:
            if os.path.islink(absolute):
                content = b"symlink\0" + os.fsencode(os.readlink(absolute))
            elif os.path.isfile(absolute):
                with open(absolute, "rb") as fh:
                    content = b"file\0" + fh.read()
            else:
                raise Refusal("untracked candidate path is not a regular file/symlink: %s" % path)
        except OSError as exc:
            raise Refusal("could not fingerprint untracked candidate path %s: %s" % (path, exc))
        digest.update(b"\0untracked\0" + str(len(raw_path)).encode("ascii") + b":" + raw_path)
        digest.update(b"\0" + str(len(content)).encode("ascii") + b":" + content)
    return "candidate1:" + digest.hexdigest()


def _workflow_result(path, run, node):
    """Validate one Claude workflow task-output receipt without trusting its prose summary.

    The top-level `totalTokens` is the runtime's own total-token metric. It is intentionally not
    relabeled as output tokens: transcript output-token sums answer a different cost question.
    """
    receipt = _read_json(path)
    result = receipt.get("result")
    if not isinstance(result, dict):
        raise Refusal("workflow result receipt has no result object")
    if result.get("status") not in REVIEWED_STATUSES:
        raise Refusal("workflow result status %r is not accept-eligible" % result.get("status"))
    if result.get("task") != run["specs"][run["nodes"].index(node)]:
        raise Refusal("workflow result task does not match the canonical selected contract")
    if result.get("branch") != node.get("branch"):
        raise Refusal("workflow result branch does not match the selected task branch")
    tokens = receipt.get("totalTokens")
    if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens <= 0:
        raise Refusal("workflow result has no valid totalTokens metric")
    rounds = result.get("rounds")
    if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
        raise Refusal("workflow result has no valid completed review round")
    progress = receipt.get("workflowProgress")
    progress = progress if isinstance(progress, list) else []
    retries = 0
    for item in progress:
        if not isinstance(item, dict) or item.get("type") != "workflow_agent":
            continue
        attempt = item.get("attempt", 1)
        if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
            raise Refusal("workflow progress has an invalid agent attempt")
        retries += attempt - 1
    return {
        "receipt": receipt,
        "result": result,
        "totalTokens": tokens,
        "runtimeRetries": retries,
        "sha256": _sha256_file(path),
        "path": os.path.realpath(path),
    }


def _validated_worktree(repo, node, worktree, require_clean=False):
    if not isinstance(worktree, str) or not os.path.isabs(worktree):
        raise Refusal("task has no absolute worktree")
    worktree = os.path.realpath(worktree)
    top = os.path.realpath(_git_ok(worktree, "rev-parse", "--show-toplevel"))
    if top != worktree:
        raise Refusal("workflow task checkout is not a Git toplevel")
    repo_common = os.path.realpath(_git_ok(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    task_common = os.path.realpath(_git_ok(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    if task_common != repo_common:
        raise Refusal("workflow task checkout belongs to a different repository")
    if _git_ok(worktree, "branch", "--show-current") != node.get("branch"):
        raise Refusal("task worktree is on the wrong branch")
    head = _git_ok(worktree, "rev-parse", "HEAD")
    if require_clean and _git_ok(worktree, "status", "--porcelain", "--untracked-files=all"):
        raise Refusal("task checkout is dirty; refusing acceptance")
    return worktree, head


def _validated_task_checkout(repo, node, result, final_commit=None):
    worktree, head = _validated_worktree(repo, node, result.get("worktree"), require_clean=True)
    expected = final_commit or head
    if not isinstance(expected, str) or not HEX_SHA_RE.fullmatch(expected):
        raise Refusal("accepted task commit must be a full lowercase Git SHA")
    if head != expected:
        raise Refusal("task checkout HEAD %s does not match accepted commit %s" % (head, expected))
    return worktree, head


def _validate_review_receipt(run, node, worktree, round_no, backend, model, effort,
                             expected_blocking=None, explicit=None, allow_legacy=False):
    if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no < 1:
        raise Refusal("reviewer round is invalid")
    default = os.path.join(
        run["base"], "reviews",
        os.path.basename(os.path.realpath(worktree)) + "-r%d.json" % round_no,
    )
    path = os.path.realpath(explicit or default)
    review = _read_json(path)
    binding = review.get("binding")
    codex_exit = review.get("codex_exit")
    if review.get("ran") is not True or isinstance(codex_exit, bool) or codex_exit != 0 or not isinstance(binding, dict):
        raise Refusal("review receipt does not prove a completed reviewer run")
    if binding.get("bound") is not True:
        raise Refusal("review receipt binding is not accepted")
    expected = {
        "round_actual": round_no,
        "effort_actual": effort,
        "reviewer_model": model,
        "reviewer_backend": backend,
    }
    for key, value in expected.items():
        if binding.get(key) != value:
            raise Refusal("review receipt %s does not match the workflow result" % key)
    receipt_worktree = review.get("worktree_canonical") or review.get("worktree")
    if not isinstance(receipt_worktree, str) or os.path.realpath(receipt_worktree) != os.path.realpath(worktree):
        raise Refusal("review receipt worktree does not match the task worktree")
    if not all(isinstance(value, str) and value for value in (backend, model, effort)):
        raise Refusal("review has no concrete reviewer identity")
    run_id = node.get("taskId", "").rsplit("-", 1)[-1]
    trace_id = _kernel(run["state"]).get("traceId")
    exact_nonce = "%s:%s" % (trace_id, run_id) if isinstance(trace_id, str) else None
    legacy_nonce = "%s:%s" % (run["state"]["featId"], run_id)
    nonce = binding.get("gate_nonce")
    accepted_nonces = [exact_nonce]
    if allow_legacy:
        accepted_nonces.append(legacy_nonce)
    if nonce not in tuple(v for v in accepted_nonces if v):
        raise Refusal("review receipt nonce does not bind to this kernel trace/task")
    if (
        isinstance(binding.get("round_actual"), bool)
        or not isinstance(binding.get("round_actual"), int)
    ):
        raise Refusal("review receipt has no valid actual round")
    parsed = review.get("codex_parsed")
    normalized_review = adapter.normalize_codex(
        json.dumps(parsed, ensure_ascii=False) if isinstance(parsed, dict) else None,
        codex_exit,
    )
    if normalized_review.get("ran") is not True:
        raise Refusal(
            "review receipt verdict is not schema-valid: %s"
            % (normalized_review.get("error") or "unknown reviewer schema error")
        )
    receipt_findings = normalized_review["blocking"]
    if expected_blocking is not None:
        expected_blocking = expected_blocking if isinstance(expected_blocking, list) else []
        keys = ("priority", "title", "body", "code_location", "confidence_score")
        normalized = lambda item: {key: item.get(key) for key in keys} if isinstance(item, dict) else None
        if [normalized(f) for f in expected_blocking] != [normalized(f) for f in receipt_findings]:
            raise Refusal("reported findings do not match the independent review receipt")
    return {
        "path": path,
        "sha256": _sha256_file(path),
        "nonce": nonce,
        "traceBinding": "exact" if exact_nonce and nonce == exact_nonce else "legacy_task_nonce",
        "backend": binding.get("reviewer_backend"),
        "model": binding.get("reviewer_model"),
        "effort": binding.get("effort_actual"),
        "round": binding.get("round_actual"),
        "parsed": parsed,
        "normalized": normalized_review,
    }


def _review_receipt_evidence(run, node, workflow, explicit=None):
    result = workflow["result"]
    round_no = result.get("reviewerRound")
    if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no != result.get("rounds"):
        raise Refusal("workflow reviewer round disagrees with the completed round count")
    if (
        result.get("reviewerModelStatus") != "recorded"
        or not all(isinstance(result.get(key), str) and result.get(key) for key in (
            "reviewerBackend", "reviewerModel", "reviewerEffort",
        ))
    ):
        raise Refusal("workflow result has no concrete recorded reviewer identity")
    return _validate_review_receipt(
        run, node, result.get("worktree"), round_no,
        result.get("reviewerBackend"), result.get("reviewerModel"), result.get("reviewerEffort"),
        expected_blocking=result.get("findings"), explicit=explicit, allow_legacy=True,
    )


def prepare(feat_id, repo=None, wall_seconds=None, token_budget=None, retry_budget=None,
            maker_model=None, reviewer_backend=None, reviewer_model=None, reviewer_effort=None,
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
        seats = _seats(run, {
            "makerModel": maker_model,
            "reviewerBackend": reviewer_backend,
            "reviewerModel": reviewer_model,
            "reviewerEffort": reviewer_effort,
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
            "seats": seats,
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
            "traceId": _kernel(run["state"]).get("traceId") or "%s:a0" % run["state"]["featId"],
            "branchPrefix": "camus/feat/%s/" % run["state"]["featId"],
            "idSalt": run["state"]["featId"],
            "policy": args.get("policy") or "ask_on_ambiguity",
            "siblingTasks": "\n".join(sibling),
        },
    }
    for key in ("model", "modelTier", "roundCap", "verifyCmd", "posture", "targetPath"):
        if key in args:
            payload["loopArgs"][key] = args[key]
    seats = _seats(run)
    if seats.get("makerModel"):
        payload["loopArgs"]["model"] = seats["makerModel"]
    for seat_key, loop_key in (
        ("reviewerBackend", "reviewerBackend"),
        ("reviewerModel", "reviewerModel"),
        ("reviewerEffort", "reviewerEffort"),
    ):
        if seats.get(seat_key):
            payload["loopArgs"][loop_key] = seats[seat_key]
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
        if not replay:
            usage = _usage(run["state"])
            kernel["taskUsageStartTokens"] = usage["tokens"]
            kernel["taskUsageStartRetries"] = usage["retries"]
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


def _direct_task(run, task_id):
    kernel = _kernel(run["state"])
    if kernel.get("activeTaskId") != task_id:
        raise Refusal("kernel trace is bound to a different active task")
    node = next((item for item in run["nodes"] if item.get("taskId") == task_id), None)
    if node is None or node.get("status") != "running":
        raise Refusal("direct task is not running")
    return kernel, node


def _worktree_destination(run, repo, node):
    try:
        result = subprocess.run(
            ["cksum"], input=repo + "\n", capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not derive deterministic worktree home: %s" % exc)
    checksum = (result.stdout or "").split()
    if result.returncode != 0 or not checksum or not checksum[0].isdigit():
        raise Refusal("could not derive deterministic worktree home")
    parent = "%s-%s" % (os.path.basename(repo), checksum[0])
    return os.path.join(run["base"], "worktrees", parent, "camus-wt-" + node["taskId"])


def open_task(feat_id, task_id, repo=None, base=None, now=None):
    """Create or reattach the deterministic direct-hybrid task worktree."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    with _locked(os.path.join(base, "feats"), feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel, node = _direct_task(run, task_id)
        if kernel.get("phase") not in ("task_running", "task_open"):
            raise Refusal("kernel is not at a direct-open phase")
        if _git_ok(repo, "branch", "--show-current") != run["state"].get("featBranch"):
            raise Refusal("feature checkout moved before direct task open")
        if _git_ok(repo, "rev-parse", "HEAD") != kernel.get("repoHead"):
            raise Refusal("feature HEAD moved before direct task open; prepare again")
        if _git_ok(repo, "status", "--porcelain", "--untracked-files=all"):
            raise Refusal("repository is dirty before direct task open")
        dest = _worktree_destination(run, repo, node)
        prior = node.get("worktree")
        if prior and os.path.realpath(prior) != os.path.realpath(dest):
            raise Refusal("task is already bound to a different worktree")
        env = os.environ.copy()
        env["CAMUS_REPO_ROOT"] = repo
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wt.sh")
        result = _json_command(
            ["bash", script, "ensure", node["branch"], dest], repo, env=env,
            label="deterministic worktree open",
        )
        if result.get("ok") is not True or not isinstance(result.get("path"), str):
            raise Refusal("deterministic worktree open refused: %s" % result.get("error"))
        worktree, head = _validated_worktree(repo, node, result["path"])
        if os.path.realpath(worktree) != os.path.realpath(dest):
            raise Refusal("worktree gate returned a path outside the deterministic destination")
        if _git(repo, "merge-base", "--is-ancestor", kernel.get("repoHead", ""), head)[0] != 0:
            raise Refusal("task worktree does not descend from the prepared feature HEAD")
        node["worktree"] = worktree
        node["directBaseCommit"] = kernel.get("repoHead")
        kernel["phase"] = "task_open"
        kernel["taskWorktree"] = worktree
        kernel["updatedAt"] = now
        run["state"]["kernel"] = kernel
        run["state"]["stage"] = "kernel_task_open"
        marker = "Kernel %s opened direct worktree for %s" % (kernel.get("traceId"), task_id)
        if not any(isinstance(event, dict) and event.get("msg") == marker for event in run["state"].get("events", [])):
            _append_event(run["state"], marker)
        _atomic_write(run["statePath"], run["state"])
        payload = task_payload(_validated_run(feat_id, base), task_id, repo=repo)
        payload.update({
            "action": "run_maker", "worktree": worktree, "branch": node["branch"],
            "reviewNonce": "%s:%s" % (kernel.get("traceId"), task_id.rsplit("-", 1)[-1]),
        })
        return payload


def _run_direct_review(run, repo, node, worktree, backend, model, effort, round_no=1):
    scripts = os.path.dirname(os.path.abspath(__file__))
    nonce = "%s:%s" % (_kernel(run["state"])["traceId"], node["taskId"].rsplit("-", 1)[-1])
    env = os.environ.copy()
    env.update({
        "CAMUS_REVIEW_DIR": os.path.join(run["base"], "reviews"),
        "CAMUS_REPO_ROOT": repo,
        "CAMUS_REVIEWER": backend,
        "CAMUS_REVIEW_BACKEND": backend,
        "CAMUS_CODEX_MODEL": model,
        "CAMUS_GATE_NONCE": nonce,
        "CAMUS_REVIEW_ROUND": str(round_no),
        "CAMUS_REVIEW_EFFORT": effort,
    })
    request = _json_command([
        sys.executable, os.path.join(scripts, "review_request.py"), "write",
        "--worktree", worktree, "--round", str(round_no), "--effort", effort,
        "--nonce", nonce, "--model", model, "--backend", backend,
    ], repo, env=env, label="direct review request")
    if request.get("ok") is not True:
        raise Refusal("direct review request refused: %s" % request.get("error"))
    review_script = os.path.join(scripts, "review.sh")
    spec = run["specs"][run["nodes"].index(node)]
    verdict = _json_command(
        ["bash", review_script, worktree, spec, str(round_no), effort, "light"],
        repo, env=env, timeout=180, label="direct independent review",
    )
    awaits = 0
    while verdict.get("pending") is True and awaits < DIRECT_REVIEW_AWAITS:
        handle = verdict.get("handle")
        if not isinstance(handle, str) or not os.path.isabs(handle):
            raise Refusal("direct reviewer returned an invalid pending handle")
        verdict = _json_command(
            ["bash", review_script, "await", handle], repo, env=env, timeout=180,
            label="direct independent review await",
        )
        awaits += 1
    if verdict.get("pending") is True:
        raise Refusal("direct reviewer remained pending after %d bounded awaits" % DIRECT_REVIEW_AWAITS)
    if verdict.get("ran") is not True:
        raise Refusal("direct reviewer produced no usable verdict: %s" % (
            verdict.get("error") or verdict.get("infra_error") or verdict.get("log_tail") or "unknown error"
        ))
    return verdict


def review_task(feat_id, task_id, repo=None, base=None, now=None):
    """Run one direct, trace-bound independent review with no model relay."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel, node = _direct_task(run, task_id)
        if kernel.get("phase") not in ("task_open", "task_reviewing", "task_reviewed", "task_verify_failed"):
            raise Refusal("kernel is not at a direct-review phase")
        worktree, _head = _validated_worktree(repo, node, node.get("worktree"))
        if not _git_ok(worktree, "status", "--porcelain", "--untracked-files=all"):
            raise Refusal("direct maker produced no candidate diff to review")
        seats = _seats(run)
        backend, model, effort = (
            seats.get("reviewerBackend"), seats.get("reviewerModel"), seats.get("reviewerEffort")
        )
        if not all(isinstance(value, str) and value for value in (backend, model, effort)):
            raise Refusal("direct review requires pinned backend, model, and effort")
        candidate_before = _candidate_fingerprint(worktree)
        if kernel.get("phase") == "task_reviewing":
            round_no = kernel.get("directReviewRound")
            if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no < 1:
                raise Refusal("in-flight direct review has no valid round")
        else:
            prior_round = node.get("reviewerRound")
            prior_round = prior_round if isinstance(prior_round, int) and not isinstance(prior_round, bool) else 0
            round_no = prior_round + 1
        kernel["phase"] = "task_reviewing"
        kernel["directReviewRound"] = round_no
        kernel["updatedAt"] = now
        run["state"]["kernel"] = kernel
        run["state"]["stage"] = "kernel_task_reviewing"
        _atomic_write(run["statePath"], run["state"])

    verdict = _run_direct_review(run, repo, node, worktree, backend, model, effort, round_no=round_no)

    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        kernel, node = _direct_task(run, task_id)
        if kernel.get("phase") not in ("task_reviewing", "task_reviewed"):
            raise Refusal("kernel phase changed while the direct reviewer was running")
        worktree, head = _validated_worktree(repo, node, node.get("worktree"))
        review = _validate_review_receipt(
            run, node, worktree, round_no, backend, model, effort,
            expected_blocking=verdict.get("blocking"), allow_legacy=False,
        )
        if verdict.get("clean") is not review["normalized"].get("clean"):
            raise Refusal("reviewer stdout disagrees with its durable receipt")
        candidate_fp = _candidate_fingerprint(worktree)
        if candidate_fp != candidate_before:
            raise Refusal("task candidate changed while the independent reviewer was running")
        node["directReview"] = {
            "head": head,
            "candidateFingerprint": candidate_fp,
            "clean": review["normalized"]["clean"],
            "blocking": review["normalized"]["blocking"],
            "nonblocking": review["normalized"]["nonblocking"],
            "receiptPath": review["path"],
            "receiptSha256": review["sha256"],
            "nonce": review["nonce"],
            "backend": review["backend"],
            "model": review["model"],
            "effort": review["effort"],
            "round": review["round"],
            "reviewedAt": now,
        }
        node["reviewerBackend"] = review["backend"]
        node["reviewerModel"] = review["model"]
        node["reviewerEffort"] = review["effort"]
        node["reviewerRound"] = review["round"]
        kernel["phase"] = "task_reviewed"
        kernel["updatedAt"] = now
        run["state"]["kernel"] = kernel
        run["state"]["stage"] = "kernel_task_reviewed"
        _append_event(run["state"], "Kernel %s recorded direct %s review for %s" % (
            kernel.get("traceId"), "clean" if review["normalized"]["clean"] else "blocking", task_id,
        ))
        _atomic_write(run["statePath"], run["state"])
        return {
            "schemaVersion": SCHEMA_VERSION,
            "traceId": kernel.get("traceId"),
            "action": "seal" if review["normalized"]["clean"] else "fix_then_seal",
            "taskId": task_id,
            "worktree": worktree,
            "reviewer": {key: review[key] for key in ("backend", "model", "effort", "round")},
            "clean": review["normalized"]["clean"],
            "blocking": review["normalized"]["blocking"],
            "nonblocking": review["normalized"]["nonblocking"],
        }


def seal_task(feat_id, task_id, fixed_unreviewed=False, repo=None, verify_timeout=3600,
              base=None, now=None):
    """Deterministically commit and verify a direct-reviewed candidate."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    with _locked(os.path.join(base, "feats"), feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel, node = _direct_task(run, task_id)
        if kernel.get("phase") not in ("task_reviewed", "task_sealing", "task_verify_failed"):
            raise Refusal("kernel is not at the direct seal phase")
        if _git_ok(repo, "branch", "--show-current") != run["state"].get("featBranch"):
            raise Refusal("feature checkout moved before direct seal")
        if _git_ok(repo, "rev-parse", "HEAD") != kernel.get("repoHead"):
            raise Refusal("feature HEAD moved before direct seal")
        if _git_ok(repo, "status", "--porcelain", "--untracked-files=all"):
            raise Refusal("main feature checkout is dirty; possible maker containment breach")
        worktree, live_head = _validated_worktree(repo, node, node.get("worktree"))
        direct = node.get("directReview")
        if not isinstance(direct, dict) or not isinstance(direct.get("head"), str):
            raise Refusal("direct review is missing its task HEAD binding")
        review = _validate_review_receipt(
            run, node, worktree, direct.get("round"), direct.get("backend"),
            direct.get("model"), direct.get("effort"),
            expected_blocking=direct.get("blocking"), explicit=direct.get("receiptPath"),
            allow_legacy=False,
        )
        if review["sha256"] != direct.get("receiptSha256"):
            raise Refusal("direct review receipt changed after the review boundary")
        blocking = review["normalized"]["blocking"]
        seal_intent = node.get("directSeal")
        replaying_seal = kernel.get("phase") in ("task_sealing", "task_verify_failed")
        if replaying_seal:
            if not isinstance(seal_intent, dict):
                raise Refusal("interrupted direct seal has no durable intent")
            proven_status = seal_intent.get("provenStatus")
            current_fp = seal_intent.get("candidateFingerprint")
            if proven_status not in ("done", "done_with_findings") or not isinstance(current_fp, str):
                raise Refusal("interrupted direct seal intent is malformed")
            if fixed_unreviewed != (proven_status == "done_with_findings"):
                raise Refusal("seal replay must preserve its original provenance mode")
            if live_head == direct.get("head"):
                # Crash occurred before commit.sh moved HEAD; the candidate must still be exact.
                if _candidate_fingerprint(worktree) != current_fp:
                    raise Refusal("candidate changed after the interrupted seal checkpoint")
            else:
                parent = _git_ok(worktree, "rev-parse", live_head + "^")
                subject = _git_ok(worktree, "show", "-s", "--format=%s", live_head)
                if parent != direct.get("head") or subject != "chore(camus): %s" % task_id[:52]:
                    raise Refusal("task HEAD moved outside the interrupted deterministic seal")
                if _git_ok(worktree, "status", "--porcelain", "--untracked-files=all"):
                    raise Refusal("sealed task commit has additional unreviewed changes")
        else:
            if live_head != direct.get("head"):
                raise Refusal("direct review is bound to another task HEAD")
            current_fp = _candidate_fingerprint(worktree)
            if fixed_unreviewed:
                if not blocking:
                    raise Refusal("fixed-unreviewed seal requires preserved blocking findings")
                proven_status = "done_with_findings"
            else:
                if blocking or direct.get("clean") is not True:
                    raise Refusal("blocking review requires a fix and --fixed-unreviewed provenance")
                if current_fp != direct.get("candidateFingerprint"):
                    raise Refusal("candidate changed after its clean review")
                proven_status = "done"
            if not _git_ok(worktree, "status", "--porcelain", "--untracked-files=all"):
                raise Refusal("direct candidate has no changes to seal")
            node["directSeal"] = {
                "reviewHead": direct.get("head"),
                "candidateFingerprint": current_fp,
                "provenStatus": proven_status,
                "startedAt": now,
            }
            kernel["phase"] = "task_sealing"
            kernel["updatedAt"] = now
            run["state"]["kernel"] = kernel
            run["state"]["stage"] = "kernel_task_sealing"
            _atomic_write(run["statePath"], run["state"])

        if live_head == direct.get("head"):
            commit = _json_command([
                "bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "commit.sh"),
                worktree, "chore(camus): %s" % task_id[:52],
            ], repo, env=dict(os.environ, CAMUS_REPO_ROOT=repo), label="direct deterministic commit")
            if commit.get("committed") is not True or not isinstance(commit.get("sha"), str) \
                    or not HEX_SHA_RE.fullmatch(commit["sha"]):
                raise Refusal("direct commit did not seal a new full-SHA candidate: %s" % commit.get("reason"))
            head = _git_ok(worktree, "rev-parse", "HEAD")
            if head != commit["sha"]:
                raise Refusal("direct commit output disagrees with task HEAD")
        else:
            head = live_head
        verification = _run_verify(run, worktree, verify_timeout)
        if verification.get("pass") is not True or verification.get("tampered") is True:
            node["directSeal"]["verification"] = verification
            kernel["phase"] = "task_verify_failed"
            kernel["updatedAt"] = now
            run["state"]["kernel"] = kernel
            run["state"]["stage"] = "kernel_task_verify_failed"
            _atomic_write(run["statePath"], run["state"])
            return {
                "schemaVersion": SCHEMA_VERSION,
                "traceId": kernel.get("traceId"),
                "action": "stop",
                "reason": "direct sealed candidate did not pass deterministic verification",
                "taskId": task_id,
                "commit": head,
                "verification": verification,
                "resume": "fix the task worktree and run kernel review again, or rerun seal if the verifier was transient",
            }
        if verification.get("head") != head:
            raise Refusal("direct verification is not bound to the sealed commit")
        node["status"] = "ready_to_merge"
        node["loopStatus"] = "direct_hybrid"
        node["provenStatus"] = proven_status
        node["provenCommit"] = head
        node["rounds"] = review["round"]
        if blocking:
            node["findingsDeferred"] = len(blocking)
            node["deferredFindings"] = blocking
        node["kernelEvidence"] = {
            "mode": "direct_hybrid",
            "reviewReceipt": {
                "path": review["path"], "sha256": review["sha256"], "nonce": review["nonce"],
            },
            "reviewedCandidateFingerprint": direct.get("candidateFingerprint"),
            "sealedCandidateFingerprint": current_fp,
            "acceptedCommit": head,
            "verification": verification,
            "acceptedAt": now,
        }
        decisions = node.get("decisions") if isinstance(node.get("decisions"), list) else []
        node["decisions"] = decisions
        decisions.append({
            "what": "kernel sealed direct candidate as %s at %s" % (proven_status, head),
            "why": "independent review receipt, candidate binding, deterministic commit, and HEAD-bound verification agree",
            "alternative": "refuse or preserve fixed-unreviewed findings when clean review is not proven",
        })
        kernel["phase"] = "accepted"
        kernel["acceptedTaskId"] = task_id
        kernel["acceptedCommit"] = head
        kernel["updatedAt"] = now
        run["state"]["kernel"] = kernel
        run["state"]["stage"] = "kernel_ready_to_merge"
        _append_event(run["state"], "Kernel %s sealed direct %s as %s at %s" % (
            kernel.get("traceId"), task_id, proven_status, head,
        ))
        _atomic_write(run["statePath"], run["state"])
        return {
            "schemaVersion": SCHEMA_VERSION,
            "traceId": kernel.get("traceId"),
            "action": "land_task",
            "taskId": task_id,
            "status": "ready_to_merge",
            "provenStatus": proven_status,
            "commit": head,
            "reviewer": {key: review[key] for key in ("backend", "model", "effort", "round")},
            "verification": verification,
        }


def accept_task(feat_id, task_id, result_file, final_commit=None, review_receipt=None,
                repo=None, verify_timeout=3600, base=None, now=None):
    """Convert a model/workflow claim into ready_to_merge only after local evidence agrees."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel = _kernel(run["state"])
        if kernel.get("phase") not in ("task_running", "task_candidate", "accepted"):
            raise Refusal("kernel is not at an accept-eligible task phase")
        if kernel.get("activeTaskId") != task_id:
            raise Refusal("kernel trace is bound to a different active task")
        node = next((item for item in run["nodes"] if item.get("taskId") == task_id), None)
        if node is None or node.get("status") not in ("running", "ready_to_merge"):
            raise Refusal("selected task is not running/ready_to_merge")

        workflow = _workflow_result(result_file, run, node)
        result = workflow["result"]
        result_commit = result.get("commit_sha") or result.get("parkedSha")
        if not isinstance(result_commit, str) or not HEX_SHA_RE.fullmatch(result_commit):
            raise Refusal("workflow result has no full commit SHA")
        final_commit = final_commit or result_commit
        worktree, head = _validated_task_checkout(repo, node, result, final_commit=final_commit)
        if _git(repo, "cat-file", "-e", result_commit + "^{commit}")[0] != 0:
            raise Refusal("workflow result commit does not exist")
        if _git(repo, "merge-base", "--is-ancestor", result_commit, head)[0] != 0:
            raise Refusal("accepted commit is not a descendant of the workflow's sealed commit")
        feat_branch = run["state"].get("featBranch")
        if _git(repo, "merge-base", "--is-ancestor", feat_branch, head)[0] != 0:
            raise Refusal("accepted task commit does not descend from the feature branch")
        if _git(repo, "merge-base", "--is-ancestor", head, feat_branch)[0] == 0:
            raise Refusal("accepted task commit is already on the feature branch")

        review = _review_receipt_evidence(run, node, workflow, explicit=review_receipt)
        result_status = result.get("status")
        blocking_findings = review["normalized"]["blocking"]
        clean_candidate = result_status == "done" or (
            result_status == "verify_inconclusive" and not blocking_findings
        )
        if clean_candidate:
            if blocking_findings:
                raise Refusal("workflow claims a clean candidate but its reviewer has blocking findings")
            if head != result_commit:
                raise Refusal("post-review commits cannot retain a review-clean done verdict")
            proven_status = "done"
        else:
            if result.get("resolution") != "fixed_unreviewed" or result.get("reviewedAfterFix") is not False:
                raise Refusal("non-clean workflow result lacks fixed_unreviewed provenance")
            if not result.get("findings"):
                raise Refusal("done_with_findings result has no preserved reviewer findings")
            proven_status = "done_with_findings"

        verification = _run_verify(run, worktree, verify_timeout)
        if verification.get("pass") is not True:
            raise Refusal("accepted task verification is not green")
        if verification.get("tampered") is True:
            raise Refusal("accepted task verification reports tampering")
        if verification.get("head") != head:
            raise Refusal("accepted task verification is not bound to the accepted commit")

        state = run["state"]
        usage = _usage(state)
        task_start = kernel.get("taskUsageStartTokens")
        if not isinstance(task_start, int) or task_start < 0:
            # Compatibility for the first canary, whose usage was recorded manually before
            # result ingestion existed. Never decrease an already-recorded total.
            task_start = max(0, usage["tokens"] - workflow["totalTokens"])
        measured_total = task_start + workflow["totalTokens"]
        if usage["tokens"] not in (task_start, measured_total) and usage["tokens"] > measured_total:
            raise Refusal("existing token usage cannot be reconciled with the workflow receipt")
        usage["tokens"] = max(usage["tokens"], measured_total)
        usage["retries"] = max(usage["retries"], int(kernel.get("taskUsageStartRetries") or 0) + workflow["runtimeRetries"])

        node["status"] = "ready_to_merge"
        node["loopStatus"] = result_status
        node["provenStatus"] = proven_status
        node["provenCommit"] = head
        node["tokens"] = workflow["totalTokens"]
        node["tokenMetric"] = "claude_workflow_totalTokens"
        node["rounds"] = result.get("rounds")
        node["reviewerBackend"] = review["backend"]
        node["reviewerModel"] = review["model"]
        node["reviewerEffort"] = review["effort"]
        node["reviewerRound"] = review["round"]
        findings = result.get("findings") if isinstance(result.get("findings"), list) else []
        if findings:
            node["findingsDeferred"] = len(findings)
            node["deferredFindings"] = findings
        decisions = node.get("decisions")
        if not isinstance(decisions, list):
            decisions = []
            node["decisions"] = decisions
        acceptance_marker = "kernel accepted %s at %s" % (proven_status, head)
        if not any(isinstance(item, dict) and item.get("what") == acceptance_marker for item in decisions):
            decisions.append({
                "what": acceptance_marker,
                "why": "workflow receipt, independent reviewer binding, Git custody, and fresh HEAD-bound deterministic verification agree",
                "alternative": "refuse acceptance when any evidence source conflicts or is missing",
            })
        prior_evidence = node.get("kernelEvidence")
        prior_accepted_at = prior_evidence.get("acceptedAt") if isinstance(prior_evidence, dict) else None
        node["kernelEvidence"] = {
            "workflowResult": {"path": workflow["path"], "sha256": workflow["sha256"]},
            "reviewReceipt": {
                "path": review["path"], "sha256": review["sha256"],
                "nonce": review["nonce"], "traceBinding": review["traceBinding"],
            },
            "workflowCommit": result_commit,
            "acceptedCommit": head,
            "verification": verification,
            "acceptedAt": prior_accepted_at if isinstance(prior_accepted_at, int) else now,
        }
        kernel["phase"] = "accepted"
        kernel["usage"] = usage
        kernel["acceptedTaskId"] = task_id
        kernel["acceptedCommit"] = head
        kernel["updatedAt"] = now
        state["kernel"] = kernel
        state["status"] = "running"
        state["stage"] = "kernel_ready_to_merge"
        acceptance_event = "Kernel %s accepted %s as %s at %s" % (
            kernel.get("traceId"), task_id, proven_status, head,
        )
        if not any(isinstance(event, dict) and event.get("msg") == acceptance_event for event in state.get("events", [])):
            _append_event(state, acceptance_event)
        _atomic_write(run["statePath"], state)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "traceId": kernel.get("traceId"),
            "action": "land_task",
            "taskId": task_id,
            "status": "ready_to_merge",
            "provenStatus": proven_status,
            "commit": head,
            "usage": usage,
            "tokenMetric": "claude_workflow_totalTokens",
            "reviewer": {key: review[key] for key in ("backend", "model", "effort", "round", "traceBinding")},
            "verification": verification,
        }


def _run_merge(run, repo, node):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge.sh")
    message = "camus(feat): merge %s" % node["taskId"]
    env = os.environ.copy()
    env["CAMUS_MERGE_DIR"] = os.path.join(run["base"], "merges")
    try:
        result = subprocess.run(
            ["bash", script, run["state"]["featBranch"], node["branch"], message],
            cwd=repo, env=env, capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not execute deterministic merge: %s" % exc)
    raw = (result.stdout or "").strip()
    try:
        receipt = json.loads(raw)
    except ValueError:
        raise Refusal("merge.sh returned non-JSON output: %s" % (raw or result.stderr)[-500:])
    if not isinstance(receipt, dict) or receipt.get("merged") is not True:
        raise Refusal("merge.sh refused: %s" % (receipt.get("error") if isinstance(receipt, dict) else raw))
    return receipt


def land_task(feat_id, task_id, repo=None, base=None, now=None):
    """Land an accepted task; no model is involved in this transition."""
    now = int(time.time()) if now is None else int(now)
    base = base or camus_home()
    feats_dir = os.path.join(base, "feats")
    with _locked(feats_dir, feat_id):
        run = _validated_run(feat_id, base)
        repo = _resolve_repo(run, repo)
        kernel = _kernel(run["state"])
        node = next((item for item in run["nodes"] if item.get("taskId") == task_id), None)
        if node is None or node.get("status") != "ready_to_merge":
            raise Refusal("task is not accepted/ready_to_merge")
        if kernel.get("acceptedTaskId") != task_id or kernel.get("acceptedCommit") != node.get("provenCommit"):
            raise Refusal("kernel acceptance does not bind this task/commit")
        if node.get("provenStatus") not in ("done", "done_with_findings"):
            raise Refusal("accepted task has no restorable proven status")
        if _git_ok(repo, "status", "--porcelain", "--untracked-files=all"):
            raise Refusal("repository is dirty; refusing deterministic land")
        receipt = _run_merge(run, repo, node)
        # merge.sh writes its durable receipt before returning. Re-read and independently
        # validate the exact evidence instead of trusting the subprocess object above.
        evidence = _receipt_evidence(run, repo, node)
        reported_evidence = (
            receipt.get("priorMergeCommit")
            if receipt.get("alreadyUpToDate") is True
            else receipt.get("after")
        )
        if not evidence or evidence != reported_evidence:
            raise Refusal("merge receipt evidence disagrees with merge.sh output")
        node["status"] = node["provenStatus"]
        node["loopStatus"] = "kernel_landed"
        node["reconciledSha"] = evidence
        node["mergedBranch"] = node.get("branch")
        decisions = node.get("decisions") if isinstance(node.get("decisions"), list) else []
        node["decisions"] = decisions
        decisions.append({
            "what": "kernel landed accepted task at merge commit %s" % evidence,
            "why": "merge.sh receipt and Git ancestry bind the accepted task branch to the feature branch",
            "alternative": "leave ready_to_merge when merge proof is missing or contradictory",
        })
        state = run["state"]
        kernel["phase"] = "ready"
        kernel["repoHead"] = _git_ok(repo, "rev-parse", "HEAD")
        kernel["acceptedTaskId"] = None
        kernel["acceptedCommit"] = None
        kernel["updatedAt"] = now
        state["kernel"] = kernel
        state["status"] = "running"
        state["stage"] = "kernel_landed"
        index, _blocked = _selected_index(run)
        kernel["activeTaskId"] = run["nodes"][index]["taskId"] if index is not None else None
        _append_event(state, "Kernel %s landed %s as %s at %s" % (
            kernel.get("traceId"), task_id, node["status"], evidence,
        ))
        _atomic_write(run["statePath"], state)
        out = _envelope(_validated_run(feat_id, base), repo=repo, now=now)
        out["landed"] = {"taskId": task_id, "status": node["status"], "mergeCommit": evidence}
        return out


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
    p.add_argument("--maker-model", default=None)
    p.add_argument("--reviewer-backend", default=None)
    p.add_argument("--reviewer-model", default=None)
    p.add_argument("--reviewer-effort", default=None)
    p.add_argument("--verify-timeout", type=int, default=3600)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("usage")
    p.add_argument("feat_id")
    p.add_argument("--tokens", type=int, default=None)
    p.add_argument("--retries", type=int, default=None)
    p.add_argument("--phase", default=None)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("accept")
    p.add_argument("feat_id")
    p.add_argument("task_id")
    p.add_argument("--result-file", required=True)
    p.add_argument("--commit", default=None)
    p.add_argument("--review-receipt", default=None)
    p.add_argument("--repo", default=None)
    p.add_argument("--verify-timeout", type=int, default=3600)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("land")
    p.add_argument("feat_id")
    p.add_argument("task_id")
    p.add_argument("--repo", default=None)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    for name in ("open", "review"):
        p = sub.add_parser(name)
        p.add_argument("feat_id")
        p.add_argument("task_id")
        p.add_argument("--repo", default=None)
        p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    p = sub.add_parser("seal")
    p.add_argument("feat_id")
    p.add_argument("task_id")
    p.add_argument("--fixed-unreviewed", action="store_true")
    p.add_argument("--repo", default=None)
    p.add_argument("--verify-timeout", type=int, default=3600)
    p.add_argument("--dir", dest="base", default=None, help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    options = _parser().parse_args(argv)
    try:
        if options.command == "prepare":
            value = prepare(
                options.feat_id, repo=options.repo, wall_seconds=options.wall_seconds,
                token_budget=options.token_budget, retry_budget=options.retry_budget,
                maker_model=options.maker_model, reviewer_backend=options.reviewer_backend,
                reviewer_model=options.reviewer_model, reviewer_effort=options.reviewer_effort,
                verify_timeout=options.verify_timeout, base=options.base,
            )
        elif options.command == "usage":
            value = record_usage(
                options.feat_id, tokens=options.tokens, retries=options.retries,
                phase=options.phase, base=options.base,
            )
        elif options.command == "accept":
            value = accept_task(
                options.feat_id, options.task_id, options.result_file,
                final_commit=options.commit, review_receipt=options.review_receipt,
                repo=options.repo, verify_timeout=options.verify_timeout, base=options.base,
            )
        elif options.command == "land":
            value = land_task(
                options.feat_id, options.task_id, repo=options.repo, base=options.base,
            )
        elif options.command == "open":
            value = open_task(
                options.feat_id, options.task_id, repo=options.repo, base=options.base,
            )
        elif options.command == "review":
            value = review_task(
                options.feat_id, options.task_id, repo=options.repo, base=options.base,
            )
        elif options.command == "seal":
            value = seal_task(
                options.feat_id, options.task_id, fixed_unreviewed=options.fixed_unreviewed,
                repo=options.repo, verify_timeout=options.verify_timeout, base=options.base,
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
