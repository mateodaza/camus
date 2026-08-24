#!/usr/bin/env python3
"""Exact-match reviewer dispatcher with a fail-closed admission/origin gate.

CAMUS_CONTROL: cli.review.backend_admission
CAMUS_CONTROL: cli.review.origin_separation
CAMUS_CONTROL: cli.review.executable_authorization

The shell entrypoint delegates here so backend selection is one argv-safe decision instead of
shell pattern matching.  Candidate names are intentionally visible before they are usable: a
backend becomes executable only by changing its checked-in ``admitted`` bit after the benchmark
contract is satisfied.  Environment variables can narrow/refuse a decision; they can never admit
a backend or replace its executable.
"""
import json
import os
import re
import sys

import control_plane


ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")

# training_org is the independence axis from OPEN-MODEL-SEATS-RFC.md, not the inference
# operator. Fixed CLI identities use this checked-in registry. The generic HTTP executor derives
# its organization only from the HMAC-covered accepted qualification record; ambient text is at
# most a conflicting assertion and never provenance authority.
BACKENDS = {
    "codex": {
        "training_org": "openai",
        "admitted": True,
        "executable": "codex_review.sh",
        "runner": "bash",
    },
    "qwen_code": {
        "training_org": "alibaba",
        "admitted": False,
        "executable": None,
        "runner": None,
    },
    "grok_cli": {
        "training_org": "xai",
        "admitted": False,
        "executable": None,
        "runner": None,
    },
    "http_openai_compat": {
        "training_org": None,
        "origin_authority": "qualification_record",
        "admitted": False,
        "executable": "http_openai_compat_review.py",
        "runner": "python",
    },
}


def _cause_for(code):
    if code in ("provider_refused", "provider_http_error", "provider_network_error"):
        return "provider_refused"
    if code in (
        "reviewer_backend_unknown", "reviewer_benchmark_disabled", "reviewer_origin_conflict",
        "reviewer_same_origin", "reviewer_executable_missing",
    ):
        return "policy_refused"
    if code in ("maker_origin_invalid", "reviewer_origin_unproven", "review_control_inconclusive"):
        return "control_inconclusive"
    return "infrastructure_failed"


def _infra(code, message, backend=None, reviewer_org=None, maker_org=None, **extra):
    value = {
        "ran": False,
        "error": message,
        "error_code": code,
        "cause": _cause_for(code),
        "clean": False,
        "blocking": [],
        "nonblocking": [],
        "backend": backend,
        "reviewer_training_org": reviewer_org,
        "maker_training_org": maker_org,
    }
    value.update(extra)
    return value


def _write_control_preflight(decision, argv, env):
    """Authorize and persist the exact initial review dispatch when argv binds it."""
    if len(argv) < 3 or argv[0] in ("await", "abort"):
        return None
    worktree = os.path.realpath(argv[0])
    try:
        round_value = int(str(argv[2]))
    except (TypeError, ValueError):
        raise ValueError("review round is not available for control-plane binding")
    action = control_plane.review_action(
        decision["backend"],
        control_plane.review_target_id(worktree, round_value, decision["backend"]),
    )
    events = [
        control_plane.control_event(
            "cli.review.backend_admission", action, "passed", "checked_in_backend_admitted",
            details={"backend": decision["backend"]},
        ),
        control_plane.control_event(
            "cli.review.origin_separation", action, "passed", "maker_and_reviewer_origins_separated",
            details={"backend": decision["backend"], "reviewer_org": decision.get("training_org")},
        ),
        control_plane.control_event(
            "cli.review.executable_authorization", action, "passed", "checked_in_exact_executable_selected",
            details={"backend": decision["backend"], "runner": decision["runner"]},
        ),
        control_plane.control_event(
            "cli.review.watchdog_custody", action, "passed", "backend_watchdog_contract_selected",
            details={"backend": decision["backend"]},
        ),
    ]
    route = control_plane.evaluate_action(
        action, events,
        checkpoints=("input_screen", "action_authorization"),
    )
    if route["decision"] != "auto":
        raise ValueError("review dispatch control route is %s (%s)" % (
            route["decision"], ", ".join(route["rule_ids"]),
        ))
    path = control_plane.receipt_path(worktree, round_value, env)
    control_plane.update_receipt(path, action, events=events, routes=[route])
    return {"path": path, "action": action, "route": route}


def decide(backend, env=None):
    """Return (decision, error).  Only an admitted decision may be executed."""
    env = os.environ if env is None else env
    spec = BACKENDS.get(backend)
    if spec is None:
        return None, _infra(
            "reviewer_backend_unknown",
            "unknown reviewer backend %r; dispatch is exact-match and has no fallback" % backend,
            backend=backend,
        )

    # The dispatcher cannot infer who made the candidate. Trusted orchestrators must carry
    # that evidence explicitly; inventing a default here could make a same-origin pairing look
    # independent when this module is reused outside today's Claude-maker paths.
    maker_org = (env.get("CAMUS_MAKER_TRAINING_ORG") or "").strip().lower()
    if not ORG_RE.fullmatch(maker_org):
        return None, _infra(
            "maker_origin_invalid",
            "maker training organization is missing or invalid; cross-vendor standing cannot be established",
            backend=backend,
        )

    fixed = spec["training_org"]
    if fixed is None:
        if spec.get("origin_authority") != "qualification_record":
            return None, _infra(
                "reviewer_origin_unproven",
                "reviewer backend %r has no training-organization authority" % backend,
                backend=backend, maker_org=maker_org,
            )
        if spec["admitted"] is not True:
            return None, _infra(
                "reviewer_benchmark_disabled",
                "reviewer backend %r is known but disabled until it passes the Slice G benchmark admission gate"
                % backend,
                backend=backend, maker_org=maker_org,
            )
        return {
            "backend": backend,
            "training_org": None,
            "origin_authority": "qualification_record",
            "executable": spec["executable"],
            "runner": spec["runner"],
            "admitted": True,
        }, None

    declared = (env.get("CAMUS_REVIEWER_TRAINING_ORG") or "").strip().lower()
    if fixed and declared and declared != fixed:
        return None, _infra(
            "reviewer_origin_conflict",
            "reviewer backend %r is registry-bound to %r, not the declared %r"
            % (backend, fixed, declared),
            backend=backend, reviewer_org=fixed, maker_org=maker_org,
        )
    reviewer_org = fixed or declared
    if not reviewer_org or not ORG_RE.fullmatch(reviewer_org):
        return None, _infra(
            "reviewer_origin_unproven",
            "reviewer backend %r has no valid training-organization evidence; cross-vendor standing cannot be established"
            % backend,
            backend=backend, maker_org=maker_org,
        )
    if reviewer_org == maker_org:
        return None, _infra(
            "reviewer_same_origin",
            "reviewer backend %r and the maker share training organization %r; no agent grades its own work"
            % (backend, maker_org),
            backend=backend, reviewer_org=reviewer_org, maker_org=maker_org,
        )
    if spec["admitted"] is not True:
        return None, _infra(
            "reviewer_benchmark_disabled",
            "reviewer backend %r is known but disabled until it passes the Slice G benchmark admission gate"
            % backend,
            backend=backend, reviewer_org=reviewer_org, maker_org=maker_org,
        )
    return {
        "backend": backend,
        "training_org": reviewer_org,
        "executable": spec["executable"],
        "runner": spec["runner"],
        "admitted": True,
    }, None


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    backend = os.environ.get("CAMUS_REVIEWER") or "codex"
    decision, error = decide(backend)
    if error is not None:
        print(json.dumps(error, separators=(",", ":")))
        return 0
    try:
        control = _write_control_preflight(decision, argv, os.environ)
    except (OSError, ValueError) as exc:
        print(json.dumps(_infra(
            "review_control_inconclusive",
            "review control-plane preflight failed (%s)" % exc.__class__.__name__,
            backend=backend, reviewer_org=decision.get("training_org"),
            maker_org=(os.environ.get("CAMUS_MAKER_TRAINING_ORG") or None),
            # Exception text may contain a local path. The normalized boundary
            # needs only the stable class; raw diagnostics never belong in the
            # reviewer result that downstream systems persist.
            control_error_code="control_preflight_%s" % exc.__class__.__name__,
        ), separators=(",", ":")))
        return 0
    here = os.path.dirname(os.path.abspath(__file__))
    executable = os.path.join(here, decision["executable"])
    child_env = os.environ.copy()
    child_env["CAMUS_REVIEW_BACKEND"] = decision["backend"]
    if decision["training_org"] is not None:
        child_env["CAMUS_REVIEWER_TRAINING_ORG"] = decision["training_org"]
    if control is not None:
        child_env["CAMUS_CONTROL_RECEIPT"] = control["path"]
        child_env["CAMUS_CONTROL_ACTION_FINGERPRINT"] = control_plane.action_fingerprint(control["action"])
    # exec preserves the backend's stdout, exit, signal, and watchdog behavior verbatim.
    if decision["runner"] == "bash":
        command = ["bash", executable] + argv
    elif decision["runner"] == "python":
        command = [sys.executable, executable] + argv
    else:  # A checked-in admitted backend without an executable contract is never runnable.
        print(json.dumps(_infra(
            "reviewer_executable_missing",
            "admitted reviewer backend %r has no executable contract" % backend,
            backend=backend, reviewer_org=decision["training_org"],
        ), separators=(",", ":")))
        return 0
    try:
        os.execvpe(command[0], command, child_env)
    except OSError as exc:
        # A stale/partial install is reviewer infrastructure, not a shell traceback and never a
        # review verdict.  Keep stdout machine-readable for the same fail-closed caller path used
        # by every other dispatcher refusal.
        print(json.dumps(_infra(
            "reviewer_exec_failed",
            "could not execute reviewer backend %r (%s)" % (backend, exc.__class__.__name__),
            backend=backend, reviewer_org=decision["training_org"],
        ), separators=(",", ":")))
        return 0
    return 127  # pragma: no cover - os.execvpe does not return


if __name__ == "__main__":
    sys.exit(main())
