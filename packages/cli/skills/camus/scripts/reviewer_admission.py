#!/usr/bin/env python3
"""Checked-in human reviewer admission registry.

Benchmark code may create a proposal, but only a reviewed repository change can
add it to ``reviewer-admissions.v1.json``. Runtime dispatch accepts one exact,
unexpired tuple; environment variables cannot point at another registry.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import tempfile

import benchmark_reviewers


ENTRY_KEYS = (
    "admissionId", "executorBackend", "profileBackend", "model", "effort",
    "trainingOrg", "transport", "connection", "qualificationFingerprint",
    "campaignId", "corpusVersion",
    "promptEnvelopeVersion", "summarySha256", "humanCalibrationCampaignId",
    "humanCalibrationId",
    "approvedBy", "approvedAt", "expiresAt", "scope",
)
ID_RE = re.compile(r"^admit1:[a-f0-9]{64}$")
QUALIFICATION_RE = re.compile(r"^qual1:[a-f0-9]{64}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
DEFAULT_REGISTRY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "reviewer-admissions.v1.json")


class AdmissionError(ValueError):
    pass


def _iso(value, label):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise AdmissionError("%s must be a canonical UTC timestamp" % label)
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        raise AdmissionError("%s must be a canonical UTC timestamp" % label)
    canonical = parsed.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if canonical != value:
        raise AdmissionError("%s must use millisecond canonical UTC form" % label)
    return parsed.timestamp()


def admission_id(entry):
    material = dict(entry)
    material.pop("admissionId", None)
    return "admit1:" + hashlib.sha256(
        benchmark_reviewers.canonical(material).encode("utf-8")
    ).hexdigest()


def qualification_fingerprint(entry):
    """Content-address the exact human-approved evidence/route before admission id sealing."""
    material = dict(entry)
    material.pop("admissionId", None)
    material.pop("qualificationFingerprint", None)
    return "qual1:" + hashlib.sha256(
        ("camus-code-review-qualification-v1\0" + benchmark_reviewers.canonical(material)).encode("utf-8")
    ).hexdigest()


def validate_entry(value):
    if not isinstance(value, dict) or set(value) != set(ENTRY_KEYS):
        raise AdmissionError("reviewer admission fields differ from the v1 contract")
    if value["admissionId"] != admission_id(value) or not ID_RE.fullmatch(value["admissionId"]):
        raise AdmissionError("reviewer admissionId does not match canonical content")
    if value["qualificationFingerprint"] != qualification_fingerprint(value) \
            or not QUALIFICATION_RE.fullmatch(value["qualificationFingerprint"]):
        raise AdmissionError("reviewer qualificationFingerprint does not match canonical admission evidence")
    if value["executorBackend"] != "http_openai_compat":
        raise AdmissionError("reviewer admission executorBackend is invalid")
    for field in ("profileBackend", "connection"):
        if not isinstance(value[field], str) or not NAME_RE.fullmatch(value[field]):
            raise AdmissionError("reviewer admission %s is invalid" % field)
    if not isinstance(value["model"], str) or not value["model"] or len(value["model"]) > 200:
        raise AdmissionError("reviewer admission model is invalid")
    if value["effort"] not in ("low", "medium", "high", "xhigh"):
        raise AdmissionError("reviewer admission effort is invalid")
    if not isinstance(value["trainingOrg"], str) or not ORG_RE.fullmatch(value["trainingOrg"]):
        raise AdmissionError("reviewer admission trainingOrg is invalid")
    if value["transport"] not in ("loopback", "direct_https", "ssh_tunnel"):
        raise AdmissionError("reviewer admission transport is invalid")
    for field in ("campaignId", "promptEnvelopeVersion"):
        if not isinstance(value[field], str) or not value[field] or len(value[field]) > 200:
            raise AdmissionError("reviewer admission %s is invalid" % field)
    if not re.fullmatch(r"corpus1:[a-f0-9]{64}", value["corpusVersion"] or ""):
        raise AdmissionError("reviewer admission corpusVersion is invalid")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", value["summarySha256"] or ""):
        raise AdmissionError("reviewer admission summarySha256 is invalid")
    if not re.fullmatch(r"human1:[a-f0-9]{64}", value["humanCalibrationId"] or ""):
        raise AdmissionError("reviewer admission humanCalibrationId is invalid")
    if not isinstance(value["humanCalibrationCampaignId"], str) \
            or not NAME_RE.fullmatch(value["humanCalibrationCampaignId"]):
        raise AdmissionError("reviewer admission humanCalibrationCampaignId is invalid")
    if not isinstance(value["approvedBy"], str) or not value["approvedBy"].startswith("human:") \
            or len(value["approvedBy"]) <= len("human:") or len(value["approvedBy"]) > 200:
        raise AdmissionError("reviewer admission approvedBy must identify a human")
    approved = _iso(value["approvedAt"], "approvedAt")
    expires = _iso(value["expiresAt"], "expiresAt")
    if expires <= approved or expires - approved > 90 * 86400:
        raise AdmissionError("reviewer admission must expire within 90 days after approval")
    if value["scope"] != "cli_code_reviewer_gate":
        raise AdmissionError("reviewer admission scope is invalid")
    return value


def validate_registry(value):
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "admissions"} \
            or value["schemaVersion"] != 1 or not isinstance(value["admissions"], list) \
            or len(value["admissions"]) > 64:
        raise AdmissionError("reviewer admission registry is malformed")
    entries = [validate_entry(entry) for entry in value["admissions"]]
    ids = [entry["admissionId"] for entry in entries]
    tuples = [(entry["profileBackend"], entry["model"], entry["effort"],
               entry["transport"], entry["connection"]) for entry in entries]
    if len(set(ids)) != len(ids) or len(set(tuples)) != len(tuples):
        raise AdmissionError("reviewer admission registry contains duplicate ids or exact tuples")
    return value


def load_registry(path=DEFAULT_REGISTRY):
    try:
        with open(path, encoding="utf-8") as handle:
            return validate_registry(json.load(handle))
    except (OSError, ValueError) as exc:
        if isinstance(exc, AdmissionError):
            raise
        raise AdmissionError("could not read checked-in reviewer admission registry")


def match(registry, profile_backend, model, effort, training_org, transport, connection,
          qualification, now=None):
    now = datetime.datetime.now(datetime.timezone.utc).timestamp() if now is None else float(now)
    for entry in validate_registry(registry)["admissions"]:
        if (entry["profileBackend"], entry["model"], entry["effort"], entry["trainingOrg"],
                entry["transport"], entry["connection"], entry["qualificationFingerprint"]) != (
                    profile_backend, model, effort, training_org, transport, connection, qualification):
            continue
        if _iso(entry["approvedAt"], "approvedAt") <= now < _iso(entry["expiresAt"], "expiresAt"):
            return entry
    return None


def human_calibration_id(value):
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise AdmissionError("human calibration must be a schemaVersion 1 object")
    if value.get("standing", "uncalibrated") != "uncalibrated":
        raise AdmissionError("human calibration standing must remain derived and uncalibrated")
    if not isinstance(value.get("campaignId"), str) or not NAME_RE.fullmatch(value["campaignId"]):
        raise AdmissionError("human calibration must name its exact campaign generation")
    artifacts = value.get("artifacts")
    runs = value.get("judgeRuns")
    if not isinstance(artifacts, list) or len(artifacts) < 12 or not isinstance(runs, list):
        raise AdmissionError("human calibration needs at least 12 artifacts and judge runs")
    labels = {}
    artifact_runs = set()
    for artifact in artifacts:
        label = artifact.get("humanLabel") if isinstance(artifact, dict) else None
        artifact_id = artifact.get("id") if isinstance(artifact, dict) else None
        source_run_id = artifact.get("sourceRunId") if isinstance(artifact, dict) else None
        case_id = artifact.get("caseId") if isinstance(artifact, dict) else None
        if not isinstance(artifact_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", artifact_id) \
                or artifact_id in labels \
                or not isinstance(source_run_id, str) or not source_run_id or len(source_run_id) > 200 \
                or source_run_id in artifact_runs \
                or not isinstance(case_id, str) or not case_id or len(case_id) > 200 \
                or not isinstance(label, dict) or label.get("authority") != "human" \
                or not str(label.get("labeledBy") or "").startswith("human:") \
                or label.get("verdict") not in ("APPROVED", "REVISE") \
                or label.get("findingPresence") not in ("clean", "findings"):
            raise AdmissionError("human calibration contains an invalid or non-human artifact label")
        if label["verdict"] == "REVISE" and label["findingPresence"] != "findings":
            raise AdmissionError("human calibration REVISE label must record findings")
        _iso(label.get("labeledAt"), "human calibration labeledAt")
        labels[artifact_id] = label
        artifact_runs.add(source_run_id)
    by_judge = {}
    run_keys = set()
    for run in runs:
        if not isinstance(run, dict) or run.get("artifactId") not in labels \
                or not isinstance(run.get("judgeId"), str) or not NAME_RE.fullmatch(run["judgeId"]) \
                or not isinstance(run.get("sourceRunId"), str) or not run["sourceRunId"] \
                or len(run["sourceRunId"]) > 200 \
                or not isinstance(run.get("actualIdentity"), str) or not run["actualIdentity"] \
                or len(run["actualIdentity"]) > 300 \
                or run.get("verdict") not in ("APPROVED", "REVISE") \
                or run.get("findingPresence") not in ("clean", "findings") \
                or (run.get("verdict") == "REVISE" and run.get("findingPresence") != "findings"):
            raise AdmissionError("human calibration contains an invalid judge run")
        key = (run["artifactId"], run["judgeId"])
        if key in run_keys:
            raise AdmissionError("human calibration contains a duplicate artifact/judge decision")
        run_keys.add(key)
        by_judge.setdefault(run["judgeId"], {})[run["artifactId"]] = run
    calibrated_identities = set()
    for decisions in by_judge.values():
        if any(artifact_id not in decisions for artifact_id in labels):
            continue
        identities = {decisions[artifact_id]["actualIdentity"] for artifact_id in labels}
        matches = sum(
            1 for artifact_id, label in labels.items()
            if decisions[artifact_id].get("verdict") == label["verdict"]
            and decisions[artifact_id].get("findingPresence") == label["findingPresence"]
        )
        if len(identities) == 1 and matches / len(labels) >= 0.8:
            calibrated_identities.update(identities)
    if len(calibrated_identities) < 2:
        raise AdmissionError(
            "human calibration needs two distinct identity-stable judges at >=0.8 joint agreement"
        )
    return "human1:" + hashlib.sha256(
        benchmark_reviewers.canonical(value).encode("utf-8")
    ).hexdigest()


def _load(path, label):
    try:
        with open(path, "rb") as handle:
            content = handle.read()
        return json.loads(content), content
    except (OSError, ValueError):
        raise AdmissionError("could not read %s" % label)


def proposal(campaign, state, summary, calibration, approved_by, approved_at, expires_at, receipts):
    campaign = benchmark_reviewers.validate_manifest(campaign)
    try:
        state = benchmark_reviewers.validate_execution_state(state, campaign)
    except benchmark_reviewers.BenchmarkError as exc:
        raise AdmissionError(str(exc)) from exc
    derived = benchmark_reviewers.summarize(campaign, receipts)
    if benchmark_reviewers.canonical(summary) != benchmark_reviewers.canonical(derived):
        raise AdmissionError("benchmark summary was not derived from the complete supplied ledger")
    if summary.get("campaignId") != campaign["campaignId"] \
            or summary.get("campaignDigest") != benchmark_reviewers.campaign_digest(campaign) \
            or summary.get("executionDigest") != benchmark_reviewers.execution_digest(state, campaign) \
            or summary.get("corpusVersion") != campaign["corpusVersion"] \
            or summary.get("promptEnvelopeVersion") != campaign["promptEnvelopeVersion"] \
            or summary.get("receiptSchemaVersions") != [benchmark_reviewers.RECEIPT_SCHEMA_VERSION]:
        raise AdmissionError("benchmark summary does not match the campaign")
    row = next((item for item in summary.get("candidates", []) if item.get("armId") == "candidate"), None)
    if row is None or row.get("recommendation") != "eligible_for_human_admission" \
            or row.get("registryChanged") is not False or not all(row.get("conditions", {}).values()):
        raise AdmissionError("candidate is not statistically eligible for human admission")
    arm = campaign["candidates"][0]
    summary_hash = "sha256:" + hashlib.sha256(
        benchmark_reviewers.canonical(summary).encode("utf-8")
    ).hexdigest()
    human_id = human_calibration_id(calibration)
    entry = {
        "executorBackend": "http_openai_compat",
        "profileBackend": state["candidateProfileBackend"], "model": arm["model"],
        "effort": arm["effort"], "trainingOrg": state["candidateTrainingOrg"],
        "transport": arm["transport"], "connection": state["candidateConnection"],
        "campaignId": campaign["campaignId"], "corpusVersion": campaign["corpusVersion"],
        "promptEnvelopeVersion": campaign["promptEnvelopeVersion"],
        "summarySha256": summary_hash,
        "humanCalibrationCampaignId": calibration["campaignId"],
        "humanCalibrationId": human_id,
        "approvedBy": "human:" + approved_by, "approvedAt": approved_at,
        "expiresAt": expires_at, "scope": "cli_code_reviewer_gate",
    }
    entry["qualificationFingerprint"] = qualification_fingerprint(entry)
    entry["admissionId"] = admission_id(entry)
    return validate_entry(entry)


def activate_qualification(admission_id_value, env=None, admissions=None, now=None):
    """Materialize one private, credential-bound authority for an already checked-in admission.

    This is network-free and cannot admit anything: the exact ``admit1`` entry must already exist
    in the packaged registry. A later credential rotation changes the opaque revision and makes
    the authority fail closed until this explicit activation is repeated.
    """
    import model_trials
    import review_qualification

    env = dict(os.environ if env is None else env)
    registry = load_registry() if admissions is None else validate_registry(admissions)
    timestamp = datetime.datetime.now(datetime.timezone.utc).timestamp() if now is None else float(now)
    entry = next((item for item in registry["admissions"]
                  if item["admissionId"] == admission_id_value), None)
    if entry is None or not (_iso(entry["approvedAt"], "approvedAt") <= timestamp
                             < _iso(entry["expiresAt"], "expiresAt")):
        raise AdmissionError("no current checked-in reviewer admission matches that id")
    try:
        profile = model_trials.resolve_profile(entry["profileBackend"], entry["model"], env)
    except model_trials.TrialError as exc:
        raise AdmissionError(str(exc)) from exc
    connection = profile["connection"]
    actual = (profile["training_org"], connection["kind"], connection["name"])
    expected = (entry["trainingOrg"], entry["transport"], entry["connection"])
    if actual != expected:
        raise AdmissionError("local reviewer profile differs from the checked-in admission tuple")
    try:
        revision = review_qualification.credential_revision(
            profile["auth"], profile["key_env"], env,
        )
        record = review_qualification.build_record(
            entry["qualificationFingerprint"], entry["admissionId"], entry["executorBackend"],
            entry["profileBackend"], entry["model"], entry["trainingOrg"],
            entry["transport"], entry["connection"], revision,
            int(_iso(entry["expiresAt"], "expiresAt")), env,
        )
        path = review_qualification.record_path(entry["qualificationFingerprint"], env)
        directory = os.path.dirname(path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        fd, temporary = tempfile.mkstemp(dir=directory, prefix=".qualification-", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
    except ValueError as exc:
        raise AdmissionError(str(exc)) from exc
    return {"admissionId": entry["admissionId"],
            "qualificationFingerprint": entry["qualificationFingerprint"], "path": path}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Camus human reviewer admission boundary")
    commands = parser.add_subparsers(dest="command", required=True)
    proposal_cmd = commands.add_parser("proposal")
    proposal_cmd.add_argument("--campaign", required=True)
    proposal_cmd.add_argument("--state", required=True)
    proposal_cmd.add_argument("--ledger", required=True)
    proposal_cmd.add_argument("--summary", required=True)
    proposal_cmd.add_argument("--human-calibration", required=True)
    proposal_cmd.add_argument("--approved-by", required=True)
    proposal_cmd.add_argument("--approved-at", required=True)
    proposal_cmd.add_argument("--expires-at", required=True)
    proposal_cmd.add_argument("--out", default=None)
    activate_cmd = commands.add_parser("activate")
    activate_cmd.add_argument("--admission-id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "activate":
            activated = activate_qualification(args.admission_id)
            print(json.dumps({"activated": True, **activated}, separators=(",", ":")))
            return 0
        campaign, _ = _load(args.campaign, "campaign")
        state, _ = _load(args.state, "campaign state")
        summary, _ = _load(args.summary, "benchmark summary")
        calibration, _calibration_bytes = _load(args.human_calibration, "human calibration")
        receipts = benchmark_reviewers.load_ledger(
            args.ledger, benchmark_reviewers.validate_manifest(campaign),
        )
        entry = proposal(
            campaign, state, summary, calibration, args.approved_by,
            args.approved_at, args.expires_at, receipts,
        )
        output = json.dumps(entry, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.out:
            with open(args.out, "x", encoding="utf-8") as handle:
                handle.write(output)
            os.chmod(args.out, 0o600)
            print("wrote human admission proposal %s; add it to the checked-in registry in a reviewed commit" % entry["admissionId"])
        else:
            print(output, end="")
        return 0
    except (AdmissionError, benchmark_reviewers.BenchmarkError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
