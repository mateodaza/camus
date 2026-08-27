#!/usr/bin/env python3
"""Local authority for configurable gate-reviewer qualification identity.

The review request and process environment are consistency channels, not provenance authority.
For a configurable reviewer, the accepted ``qual1:`` fingerprint therefore names a separate,
machine-bound record carrying the reviewer training organization.  The record is HMAC-covered by
Studio's existing per-machine salt, exact-bound to the backend/model/transport/connection tuple,
and expires.  A caller may contradict it and force a refusal; caller text can never replace it.
"""
import hashlib
import hmac
import json
import os
import re
import stat
import time


SCHEMA_VERSION = 2
QUALIFICATION_RE = re.compile(r"^qual1:[0-9a-f]{64}$")
ADMISSION_RE = re.compile(r"^admit1:[0-9a-f]{64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
TRANSPORTS = ("loopback", "direct_https", "ssh_tunnel")
SEP = "\x1f"
RECORD_FIELDS = (
    "schema_version", "qualification", "admission_id", "backend", "profile_backend", "reviewer_model",
    "training_org", "transport", "connection", "credential_revision", "expires_at",
)
RECORD_KEYS = frozenset(RECORD_FIELDS + ("hmac",))


def _base_dir(env):
    return env.get("STUDIO_GRANDFATHER_DIR") or os.path.join(
        os.path.expanduser("~"), ".camus", "studio",
    )


def _read_private(path, label, limit):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ValueError("%s is missing or inaccessible" % label)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("%s is not a regular file" % label)
        if info.st_mode & 0o077:
            raise ValueError("%s permissions are not private" % label)
        content = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(content) > limit:
        raise ValueError("%s exceeds its bounded size" % label)
    return content


def machine_salt(env):
    """Read, but never mint, the shared 0600 Studio machine salt."""
    salt_path = os.path.join(_base_dir(env), ".machine-salt")
    try:
        encoded = _read_private(salt_path, "machine salt", 128).decode("ascii").strip()
    except UnicodeError:
        raise ValueError("machine salt is invalid; restore it before review")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", encoded):
        raise ValueError("machine salt is invalid; restore it before review")
    return bytes.fromhex(encoded)


def _join_fields(values):
    return SEP.join(
        "%d%s%s" % (len(value.encode("utf-8")), SEP, value) for value in values
    ).encode("utf-8")


def credential_revision(auth, key_env, env):
    """Studio-compatible opaque account revision; the credential is never returned."""
    if auth == "none":
        return "none"
    if auth != "env" or not key_env or not env.get(key_env):
        raise ValueError("credential revision cannot be established")
    message = _join_fields((key_env, env[key_env]))
    return hmac.new(machine_salt(env), message, hashlib.sha256).hexdigest()[:16]


def _validate_identity(qualification, admission_id, backend, profile_backend, model, training_org,
                       transport, connection, credential):
    if not isinstance(qualification, str) or not QUALIFICATION_RE.fullmatch(qualification):
        raise ValueError("qualification must be an exact qual1: fingerprint")
    if not isinstance(admission_id, str) or not ADMISSION_RE.fullmatch(admission_id):
        raise ValueError("qualification record admission id is invalid")
    if backend != "http_openai_compat":
        raise ValueError("qualification record names an unsupported reviewer backend")
    if not isinstance(profile_backend, str) or not NAME_RE.fullmatch(profile_backend):
        raise ValueError("qualification record profile backend is invalid")
    if not isinstance(model, str) or not TOKEN_RE.fullmatch(model):
        raise ValueError("qualification record reviewer model is invalid")
    if not isinstance(training_org, str) or not ORG_RE.fullmatch(training_org):
        raise ValueError("qualification record training organization is invalid")
    if transport not in TRANSPORTS:
        raise ValueError("qualification record transport is invalid")
    if not isinstance(connection, str) or not NAME_RE.fullmatch(connection):
        raise ValueError("qualification record connection is invalid")
    if not isinstance(credential, str) or not re.fullmatch(r"(?:none|[0-9a-f]{16})", credential):
        raise ValueError("qualification record credential revision is invalid")


def _record_hmac(record, env):
    values = tuple(str(record[field]) for field in RECORD_FIELDS)
    return hmac.new(machine_salt(env), _join_fields(values), hashlib.sha256).hexdigest()


def build_record(qualification, admission_id, backend, profile_backend, model, training_org, transport,
                 connection, credential, expires_at, env):
    """Build a qualification-authority record for trusted qualifier/benchmark code."""
    _validate_identity(
        qualification, admission_id, backend, profile_backend, model, training_org,
        transport, connection, credential,
    )
    if isinstance(expires_at, bool) or not isinstance(expires_at, int) or expires_at <= 0:
        raise ValueError("qualification record expiry is invalid")
    record = {
        "schema_version": SCHEMA_VERSION,
        "qualification": qualification,
        "admission_id": admission_id,
        "backend": backend,
        "profile_backend": profile_backend,
        "reviewer_model": model,
        "training_org": training_org,
        "transport": transport,
        "connection": connection,
        "credential_revision": credential,
        "expires_at": expires_at,
    }
    record["hmac"] = _record_hmac(record, env)
    return record


def record_path(qualification, env):
    if not isinstance(qualification, str) or not QUALIFICATION_RE.fullmatch(qualification):
        raise ValueError("qualification must be an exact qual1: fingerprint")
    return os.path.join(
        _base_dir(env), "gate-reviewer-qualifications",
        qualification.split(":", 1)[1] + ".json",
    )


def accepted_training_org(qualification, admission_id, backend, profile_backend, model, transport,
                          connection, auth, key_env, env, now=None):
    """Return record-bound training org or refuse; never accept an ambient replacement."""
    path = record_path(qualification, env)
    try:
        raw = _read_private(path, "accepted qualification record", 65536).decode("utf-8")
        record = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("accepted qualification record is unreadable")
    if not isinstance(record, dict) or frozenset(record) != RECORD_KEYS:
        raise ValueError("accepted qualification record has an invalid schema")
    if isinstance(record.get("schema_version"), bool) or record.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("accepted qualification record has an unsupported schema version")
    _validate_identity(
        record.get("qualification"), record.get("admission_id"), record.get("backend"),
        record.get("profile_backend"),
        record.get("reviewer_model"), record.get("training_org"),
        record.get("transport"), record.get("connection"), record.get("credential_revision"),
    )
    expected = {
        "qualification": qualification,
        "admission_id": admission_id,
        "backend": backend,
        "profile_backend": profile_backend,
        "reviewer_model": model,
        "transport": transport,
        "connection": connection,
        "credential_revision": credential_revision(auth, key_env, env),
    }
    drift = [key for key, value in expected.items() if record.get(key) != value]
    if drift:
        raise ValueError(
            "accepted qualification record differs from this review in %s" % ", ".join(drift)
        )
    supplied_mac = record.get("hmac")
    if not isinstance(supplied_mac, str) or not re.fullmatch(r"[0-9a-f]{64}", supplied_mac):
        raise ValueError("accepted qualification record HMAC is invalid")
    if not hmac.compare_digest(supplied_mac, _record_hmac(record, env)):
        raise ValueError("accepted qualification record HMAC does not verify")
    expires_at = record.get("expires_at")
    if isinstance(expires_at, bool) or not isinstance(expires_at, int):
        raise ValueError("accepted qualification record expiry is invalid")
    if expires_at <= int(time.time() if now is None else now):
        raise ValueError("accepted qualification record has expired; re-qualify this reviewer")
    return record["training_org"]
