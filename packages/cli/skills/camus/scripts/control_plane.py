#!/usr/bin/env python3
"""Camus Responsible Control Plane v1 (stdlib Python twin).

The JSON register is the shared contract. This module gives the native CLI the
same deterministic routing and exact human/action binding as Studio's JS
consumer. Models may escalate; they never authorize or weaken a hard rule.
"""
import hashlib
import json
import math
import os
import re
import tempfile
import time


CONTROL_PLANE_VERSION = "control-plane.v1"
CHECKPOINTS = ("input_screen", "action_authorization", "output_screen")
CONTROL_OUTCOMES = ("passed", "refused", "inconclusive", "not_applicable")
ROUTE_DECISIONS = ("auto", "human_required", "refuse", "inconclusive")
FAILURE_CAUSES = (
    "provider_refused", "policy_refused", "review_rejected",
    "control_inconclusive", "needs_human", "infrastructure_failed",
)
IMPACT = ("low", "medium", "high")
REVERSIBILITY = ("reversible", "bounded_rollback", "irreversible")
SIDE_EFFECT = (
    "none", "local_mutation", "provider_request", "publication", "remote_access",
    "destructive_mutation", "credential_boundary_change", "remote_command",
)
DATA_SENSITIVITY = ("public", "internal", "sensitive", "restricted")
DESTINATION_TRUST = ("local", "known", "declared", "unknown")
OPERATOR_POLICY = ("allow", "ask", "refuse")
HUMAN_REQUIRED_EFFECTS = frozenset((
    "publication", "remote_access", "destructive_mutation",
    "credential_boundary_change", "remote_command",
))
SENSITIVE_KEY = re.compile(
    r"(?:secret|password|authorization|api[_-]?key|credential[_-]?value|token|prompt|raw[_-]?(?:input|output)|environment[_-]?dump)",
    re.I,
)
CREDENTIAL_VALUE = re.compile(
    r"(?:Bearer\s+[A-Za-z0-9._~+/=-]{4,}|\b(?:sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,})",
    re.I,
)
REGISTER_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "control-register.v1.json")


def _load_register():
    with open(REGISTER_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _nonempty(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("%s must be a non-empty string" % label)
    return value.strip()


def _exact_keys(value, expected, label):
    if not isinstance(value, dict):
        raise ValueError("%s must be an object" % label)
    extras = sorted(set(value) - set(expected))
    if extras:
        raise ValueError("%s has unknown fields: %s" % (label, ", ".join(extras)))


def validate_register(register):
    if not isinstance(register, dict) or register.get("schema_version") != 1 \
            or register.get("register_version") != "control-register.v1" \
            or not isinstance(register.get("controls"), list):
        raise ValueError("control register must be the control-register.v1 object")
    required = (
        "control_id", "control_version", "checkpoint", "risk_addressed", "owner",
        "enforcement_point", "applies_to", "failure_direction", "evidence_artifact",
        "risk_level", "allow_not_applicable", "last_validated_by", "revalidation_trigger",
    )
    ids = set()
    by_action = {}
    for index, control in enumerate(register["controls"]):
        _exact_keys(control, required, "controls[%d]" % index)
        for field in (
            "control_id", "control_version", "risk_addressed", "owner",
            "enforcement_point", "evidence_artifact", "revalidation_trigger",
        ):
            _nonempty(control.get(field), "controls[%d].%s" % (index, field))
        control_id = control["control_id"]
        if control_id in ids:
            raise ValueError("duplicate control_id %s" % control_id)
        ids.add(control_id)
        if control.get("checkpoint") not in CHECKPOINTS:
            raise ValueError("%s has an invalid checkpoint" % control_id)
        if control.get("failure_direction") not in ROUTE_DECISIONS or control.get("failure_direction") == "auto":
            raise ValueError("%s has an invalid failure_direction" % control_id)
        if control.get("risk_level") not in ("low", "medium", "high", "critical"):
            raise ValueError("%s has an invalid risk_level" % control_id)
        if not isinstance(control.get("allow_not_applicable"), bool):
            raise ValueError("%s.allow_not_applicable must be boolean" % control_id)
        if not isinstance(control.get("applies_to"), list) or not control["applies_to"]:
            raise ValueError("%s.applies_to must be non-empty" % control_id)
        if not isinstance(control.get("last_validated_by"), list) or not control["last_validated_by"]:
            raise ValueError("%s has no evidence test" % control_id)
        for action in control["applies_to"]:
            _nonempty(action, "%s.applies_to[]" % control_id)
            by_action.setdefault(action, set()).add(control["checkpoint"])
    for action, checkpoints in by_action.items():
        missing = [item for item in CHECKPOINTS if item not in checkpoints]
        if missing:
            raise ValueError("%s is missing checkpoints: %s" % (action, ", ".join(missing)))
    return register


CONTROL_REGISTER = validate_register(_load_register())
CONTROL_BY_ID = dict((control["control_id"], control) for control in CONTROL_REGISTER["controls"])


def controls_for(action_class, checkpoints=CHECKPOINTS):
    wanted = set(checkpoints)
    return [
        control for control in CONTROL_REGISTER["controls"]
        if action_class in control["applies_to"] and control["checkpoint"] in wanted
    ]


def validate_action(action):
    fields = (
        "schema_version", "action_class", "target", "impact", "reversibility",
        "external_side_effect", "data_sensitivity", "destination_trust", "operator_policy",
    )
    _exact_keys(action, fields, "control action")
    if action.get("schema_version") != 1:
        raise ValueError("control action schema_version must be 1")
    _nonempty(action.get("action_class"), "control action.action_class")
    _exact_keys(action.get("target"), ("class", "id"), "control action.target")
    _nonempty(action["target"].get("class"), "control action.target.class")
    _nonempty(action["target"].get("id"), "control action.target.id")
    if action.get("impact") not in IMPACT:
        raise ValueError("control action.impact is invalid")
    if action.get("reversibility") not in REVERSIBILITY:
        raise ValueError("control action.reversibility is invalid")
    if action.get("external_side_effect") not in SIDE_EFFECT:
        raise ValueError("control action.external_side_effect is invalid")
    if action.get("data_sensitivity") not in DATA_SENSITIVITY:
        raise ValueError("control action.data_sensitivity is invalid")
    if action.get("destination_trust") not in DESTINATION_TRUST:
        raise ValueError("control action.destination_trust is invalid")
    if action.get("operator_policy") not in OPERATOR_POLICY:
        raise ValueError("control action.operator_policy is invalid")
    if not controls_for(action["action_class"]):
        raise ValueError("unregistered action_class %s" % action["action_class"])
    return action


def canonical_string(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def action_fingerprint(action):
    validate_action(action)
    digest = hashlib.sha256(canonical_string(action).encode("utf-8")).hexdigest()
    return "action1:" + digest


def _safe_details(value, path="details", depth=0):
    if depth > 4:
        raise ValueError("%s is too deeply nested" % path)
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("%s must be finite" % path)
        return value
    if isinstance(value, str):
        if len(value) > 500:
            raise ValueError("%s exceeds 500 characters" % path)
        if CREDENTIAL_VALUE.search(value):
            raise ValueError("%s looks credential-shaped" % path)
        return value
    if isinstance(value, list):
        if len(value) > 32:
            raise ValueError("%s has too many items" % path)
        return [_safe_details(item, "%s[%d]" % (path, index), depth + 1) for index, item in enumerate(value)]
    if not isinstance(value, dict):
        raise ValueError("%s contains an unsupported value" % path)
    if len(value) > 32:
        raise ValueError("%s has too many fields" % path)
    out = {}
    for key, item in value.items():
        if SENSITIVE_KEY.search(str(key)):
            raise ValueError("%s.%s is not allowed in control evidence" % (path, key))
        out[key] = _safe_details(item, "%s.%s" % (path, key), depth + 1)
    return out


def control_event(control_id, action, outcome, reason_code, cause=None, details=None, now=None):
    control = CONTROL_BY_ID.get(control_id)
    if control is None:
        raise ValueError("unknown control_id %s" % control_id)
    validate_action(action)
    if action["action_class"] not in control["applies_to"]:
        raise ValueError("%s does not apply to %s" % (control_id, action["action_class"]))
    if outcome not in CONTROL_OUTCOMES:
        raise ValueError("%s has invalid outcome %s" % (control_id, outcome))
    if outcome == "not_applicable" and not control["allow_not_applicable"]:
        raise ValueError("%s may not be not_applicable" % control_id)
    _nonempty(reason_code, "%s.reason_code" % control_id)
    if cause is not None and cause not in FAILURE_CAUSES:
        raise ValueError("%s has invalid cause %s" % (control_id, cause))
    if outcome not in ("passed", "not_applicable") and cause is None:
        raise ValueError("%s %s requires a cause" % (control_id, outcome))
    at = int(time.time() * 1000) if now is None else now
    if isinstance(at, bool) or not isinstance(at, int) or at < 0:
        raise ValueError("control event time must be a non-negative integer")
    return {
        "schema_version": 1,
        "control_id": control["control_id"],
        "control_version": control["control_version"],
        "checkpoint": control["checkpoint"],
        "action_class": action["action_class"],
        "action_fingerprint": action_fingerprint(action),
        "outcome": outcome,
        "reason_code": reason_code,
        "cause": cause,
        "details": _safe_details(details or {}),
        "at": at,
    }


def human_decision(action, decision, reason, now=None):
    validate_action(action)
    if decision not in ("approve", "refuse"):
        raise ValueError("human decision must be approve or refuse")
    _nonempty(reason, "human decision reason")
    _safe_details(reason, "human decision reason")
    at = int(time.time() * 1000) if now is None else now
    if isinstance(at, bool) or not isinstance(at, int) or at < 0:
        raise ValueError("human decision time must be a non-negative integer")
    return {
        "schema_version": 1,
        "action_fingerprint": action_fingerprint(action),
        "decision": decision,
        "reason": reason.strip()[:500],
        "at": at,
    }


EVENT_FIELDS = (
    "schema_version", "control_id", "control_version", "checkpoint", "action_class",
    "action_fingerprint", "outcome", "reason_code", "cause", "details", "at",
)


def _valid_evidence_event(event, control, action, fingerprint):
    try:
        _exact_keys(event, EVENT_FIELDS, "control event")
        if event.get("schema_version") != 1 or event.get("control_id") != control["control_id"] \
                or event.get("control_version") != control["control_version"] \
                or event.get("checkpoint") != control["checkpoint"] \
                or event.get("action_class") != action["action_class"] \
                or event.get("action_fingerprint") != fingerprint \
                or event.get("outcome") not in CONTROL_OUTCOMES \
                or (event.get("outcome") == "not_applicable" and not control["allow_not_applicable"]):
            return False
        _nonempty(event.get("reason_code"), "%s.reason_code" % control["control_id"])
        cause = event.get("cause")
        if cause is not None and cause not in FAILURE_CAUSES:
            return False
        if event.get("outcome") not in ("passed", "not_applicable") and cause is None:
            return False
        at = event.get("at")
        if isinstance(at, bool) or not isinstance(at, int) or at < 0:
            return False
        _safe_details(event.get("details"))
        return True
    except (TypeError, ValueError):
        return False


def _valid_authorization(authorization):
    try:
        _exact_keys(
            authorization,
            ("schema_version", "action_fingerprint", "decision", "reason", "at"),
            "human decision",
        )
        if authorization.get("schema_version") != 1 \
                or authorization.get("decision") not in ("approve", "refuse"):
            return False
        _nonempty(authorization.get("action_fingerprint"), "human decision action_fingerprint")
        _nonempty(authorization.get("reason"), "human decision reason")
        _safe_details(authorization.get("reason"), "human decision reason")
        at = authorization.get("at")
        return not isinstance(at, bool) and isinstance(at, int) and at >= 0
    except (TypeError, ValueError):
        return False


def _route(decision, source, rules, cause, action, checkpoints, controls, now):
    unique = []
    for rule in rules:
        if rule not in unique:
            unique.append(rule)
    return {
        "schema_version": 1,
        "decision": decision,
        "source": source,
        "rule_ids": unique,
        "cause": cause,
        "action_class": action["action_class"],
        "action_fingerprint": action_fingerprint(action),
        "checkpoints": list(checkpoints),
        "checked_controls": [control["control_id"] for control in controls],
        "at": int(time.time() * 1000) if now is None else now,
    }


def _high_stakes(action):
    return action["impact"] == "high" \
        or action["reversibility"] == "irreversible" \
        or action["external_side_effect"] in HUMAN_REQUIRED_EFFECTS \
        or (action["data_sensitivity"] == "restricted" and action["destination_trust"] != "local")


def evaluate_action(action, evidence=None, authorization=None, model_recommendation=None,
                    checkpoints=CHECKPOINTS, now=None):
    validate_action(action)
    evidence = [] if evidence is None else evidence
    if not isinstance(evidence, list):
        raise ValueError("control evidence must be an array")
    if not isinstance(checkpoints, (tuple, list)) or not checkpoints \
            or any(item not in CHECKPOINTS for item in checkpoints):
        raise ValueError("checkpoints must be a non-empty subset of the control checkpoints")
    if model_recommendation is not None and model_recommendation not in ROUTE_DECISIONS:
        raise ValueError("model recommendation is invalid")
    controls = controls_for(action["action_class"], checkpoints)
    fingerprint = action_fingerprint(action)
    if authorization is not None and not _valid_authorization(authorization):
        return _route("refuse", "deterministic", ["human_authorization_malformed"], "policy_refused", action, checkpoints, controls, now)
    latest = {}
    for event in evidence:
        if not isinstance(event, dict) or event.get("control_id") not in CONTROL_BY_ID:
            continue
        if event.get("action_class") != action["action_class"] or event.get("action_fingerprint") != fingerprint:
            continue
        latest[event["control_id"]] = event

    if action["operator_policy"] == "refuse":
        return _route("refuse", "deterministic", ["operator_policy_refuse"], "policy_refused", action, checkpoints, controls, now)
    if isinstance(authorization, dict) and authorization.get("decision") == "refuse":
        if authorization.get("action_fingerprint") != fingerprint:
            return _route("refuse", "deterministic", ["human_binding_mismatch"], "policy_refused", action, checkpoints, controls, now)
        return _route("refuse", "human", ["human_refused"], "policy_refused", action, checkpoints, controls, now)

    for control in controls:
        event = latest.get(control["control_id"])
        malformed = event is not None and not _valid_evidence_event(event, control, action, fingerprint)
        if event is None or malformed:
            decision = control["failure_direction"]
            cause = "needs_human" if decision == "human_required" \
                else "policy_refused" if decision == "refuse" else "control_inconclusive"
            return _route(
                decision, "deterministic",
                ["control_evidence_malformed" if event else "control_evidence_missing", control["control_id"]],
                cause, action, checkpoints, controls, now,
            )
        if event.get("outcome") == "refused":
            return _route("refuse", "deterministic", ["control_refused", control["control_id"]], event.get("cause") or "policy_refused", action, checkpoints, controls, now)
        if event.get("outcome") == "inconclusive":
            decision = control["failure_direction"]
            cause = "needs_human" if decision == "human_required" \
                else "policy_refused" if decision == "refuse" else "control_inconclusive"
            return _route(decision, "deterministic", ["control_inconclusive", control["control_id"]], event.get("cause") or cause, action, checkpoints, controls, now)

    needs_authorization = _high_stakes(action) or action["operator_policy"] == "ask"
    if needs_authorization:
        if isinstance(authorization, dict) and authorization.get("action_fingerprint") != fingerprint:
            return _route("refuse", "deterministic", ["human_binding_mismatch"], "policy_refused", action, checkpoints, controls, now)
        if not isinstance(authorization, dict) or authorization.get("decision") != "approve":
            return _route("human_required", "deterministic", ["stakes_require_human"], "needs_human", action, checkpoints, controls, now)

    if model_recommendation is not None and model_recommendation != "auto":
        cause = "needs_human" if model_recommendation == "human_required" \
            else "policy_refused" if model_recommendation == "refuse" else "control_inconclusive"
        return _route(model_recommendation, "model_escalation", ["model_escalation_only"], cause, action, checkpoints, controls, now)
    source = "human" if isinstance(authorization, dict) and authorization.get("decision") == "approve" else "deterministic"
    rule = "human_authorization_bound" if source == "human" else "low_stakes_controls_passed"
    return _route("auto", source, [rule], None, action, checkpoints, controls, now)


def review_target_id(worktree, round_value, backend):
    material = "\x1f".join((os.path.realpath(worktree), str(int(round_value)), str(backend)))
    return "review1:" + hashlib.sha256(material.encode("utf-8", "surrogatepass")).hexdigest()


def review_action(backend, target_id):
    return {
        "schema_version": 1,
        "action_class": "cli.review.execute",
        "target": {"class": "candidate_diff", "id": str(target_id)},
        "impact": "medium",
        "reversibility": "reversible",
        "external_side_effect": "provider_request",
        "data_sensitivity": "internal",
        "destination_trust": "known" if backend == "codex" else "declared",
        "operator_policy": "allow",
    }


def receipt_path(worktree, round_value, env=None):
    env = os.environ if env is None else env
    directory = env.get("CAMUS_REVIEW_DIR") or os.path.join(os.path.expanduser("~"), ".camus", "reviews")
    basename = os.path.basename(os.path.realpath(worktree))
    return os.path.join(directory, "%s-r%s-controls.json" % (basename, int(round_value)))


def load_receipt(path):
    """Read and validate the mutable control receipt envelope.

    The receipt is deliberately separate from Camus' immutable evidence packs:
    output screening completes it after the provider returns.  Treat a partial,
    wrong-version, or structurally malformed receipt as unusable rather than
    quietly manufacturing the missing preflight evidence.
    """
    with open(path, encoding="utf-8") as fh:
        value = json.load(fh)
    if not isinstance(value, dict) or value.get("schema_version") != 1 \
            or value.get("control_plane_version") != CONTROL_PLANE_VERSION \
            or value.get("register_version") != CONTROL_REGISTER["register_version"]:
        raise ValueError("control receipt has an unsupported schema")
    for field in ("actions", "events", "routes", "human_decisions"):
        if not isinstance(value.get(field), list):
            raise ValueError("control receipt.%s must be an array" % field)
    if len(value["actions"]) != 1:
        raise ValueError("review control receipt must bind exactly one action")
    validate_action(value["actions"][0])
    return value


def _review_binding_complete(binding, input_fingerprint):
    if not isinstance(binding, dict) or binding.get("bound") is not True:
        return False
    required = (
        "contract", "scope", "qualification", "origin", "operator",
        "transport", "connection", "reviewer_backend", "reviewer_model",
    )
    if any(not isinstance(binding.get(key), str) or not binding[key] for key in required):
        return False
    return isinstance(input_fingerprint, str) \
        and re.fullmatch(r"fp1:[0-9a-f]{64}", input_fingerprint) is not None


def finalize_review_receipt(worktree, round_value, backend, ran, clean, binding,
                            input_fingerprint=None, env=None, now=None):
    """Append output-screen evidence and evaluate the complete review action.

    Returns ``None`` when no dispatcher preflight receipt exists.  That keeps
    legacy/direct helper invocations side-effect free; production dispatch and
    reattachment both resolve the already-created receipt by exact round path.
    A present but malformed receipt raises and is never repaired in place.
    """
    env = os.environ if env is None else env
    path = env.get("CAMUS_CONTROL_RECEIPT") or receipt_path(worktree, round_value, env)
    if not os.path.exists(path):
        return None
    current = load_receipt(path)
    action = review_action(backend, review_target_id(worktree, round_value, backend))
    expected_fingerprint = action_fingerprint(action)
    carried_fingerprint = env.get("CAMUS_CONTROL_ACTION_FINGERPRINT")
    if carried_fingerprint and carried_fingerprint != expected_fingerprint:
        raise ValueError("review control action fingerprint drifted")
    if action_fingerprint(current["actions"][0]) != expected_fingerprint:
        raise ValueError("review output belongs to another control action")

    normalized_outcome = "passed" if ran is True else "inconclusive"
    normalized_reason = "review_verdict_normalized" if ran is True else "review_verdict_unusable"
    events = [control_event(
        "cli.review.verdict_normalization", action, normalized_outcome, normalized_reason,
        cause=None if ran is True else "infrastructure_failed",
        details={
            "review_outcome": (
                "approved" if ran is True and clean is True
                else "review_rejected" if ran is True
                else "infrastructure_failed"
            ),
        }, now=now,
    )]
    binding_ok = _review_binding_complete(binding, input_fingerprint)
    events.append(control_event(
        "cli.review.binding", action,
        "passed" if binding_ok else "refused",
        "review_binding_exact" if binding_ok else "review_binding_incomplete",
        cause=None if binding_ok else "policy_refused",
        details={
            "round": int(round_value),
            "backend": backend,
            "input_fingerprint_present": bool(input_fingerprint),
        }, now=now,
    ))
    evidence = list(current["events"]) + events
    route = evaluate_action(action, evidence=evidence, now=now)
    receipt = update_receipt(path, action, events=events, routes=[route])
    result_cause = (
        "review_rejected" if ran is True and clean is not True
        else route.get("cause")
    )
    return {
        "path": path,
        "action_fingerprint": expected_fingerprint,
        "decision": route["decision"],
        "cause": result_cause,
        "rule_ids": route["rule_ids"],
        "receipt": receipt,
    }


def _atomic_json(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".control-", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2, sort_keys=True)
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


def update_receipt(path, action, events=(), routes=(), authorizations=()):
    validate_action(action)
    fingerprint = action_fingerprint(action)
    current = None
    if os.path.exists(path):
        current = load_receipt(path)
        actions = current.get("actions")
        if not isinstance(actions, list) or not actions or action_fingerprint(actions[0]) != fingerprint:
            raise ValueError("existing control receipt belongs to another action")
    else:
        current = {
            "schema_version": 1,
            "control_plane_version": CONTROL_PLANE_VERSION,
            "register_version": CONTROL_REGISTER["register_version"],
            "actions": [action],
            "events": [],
            "routes": [],
            "human_decisions": [],
        }

    def add_unique(bucket, values, identity):
        seen = set(identity(item) for item in bucket)
        for item in values:
            key = identity(item)
            if key not in seen:
                bucket.append(item)
                seen.add(key)

    add_unique(
        current["events"], list(events),
        lambda item: (item.get("control_id"), item.get("action_fingerprint"), item.get("outcome"), item.get("reason_code")),
    )
    add_unique(
        current["routes"], list(routes),
        lambda item: (item.get("decision"), tuple(item.get("checkpoints") or ()), tuple(item.get("checked_controls") or ())),
    )
    add_unique(
        current["human_decisions"], list(authorizations),
        lambda item: (item.get("action_fingerprint"), item.get("decision"), item.get("reason")),
    )
    _atomic_json(path, current)
    return current
