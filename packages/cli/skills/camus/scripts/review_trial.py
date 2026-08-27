#!/usr/bin/env python3
"""Machine-bound authority for an explicitly non-gating HTTP reviewer trial.

``trial1:`` records exist so a provider-backed shadow review can reuse the hardened
HTTP executor without pretending that Studio capability probes or one successful
review satisfy the Slice G admission campaign.  The record binds the complete
runtime profile, including an opaque credential revision, and expires quickly.
It is never accepted by the production reviewer dispatcher.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import tempfile
import time

import review_qualification


SCHEMA_VERSION = 1
TRIAL_RE = re.compile(r"^trial1:[0-9a-f]{64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
TRANSPORTS = ("loopback", "direct_https", "ssh_tunnel")
SEP = "\x1f"
RECORD_FIELDS = (
    "schema_version", "trial", "backend", "profile_backend", "reviewer_model",
    "training_org", "transport", "connection", "endpoint_sha256", "auth_mode",
    "credential_env", "credential_revision", "expires_at",
)
RECORD_KEYS = frozenset(RECORD_FIELDS + ("hmac",))


def _base_dir(env):
    return env.get("STUDIO_GRANDFATHER_DIR") or os.path.join(
        os.path.expanduser("~"), ".camus", "studio",
    )


def _join(values):
    return SEP.join(
        "%d%s%s" % (len(str(value).encode("utf-8")), SEP, str(value))
        for value in values
    ).encode("utf-8")


def _validate(backend, profile_backend, model, training_org, transport, connection,
              base_url, auth_mode, credential_env):
    if backend != "http_openai_compat":
        raise ValueError("trial record names an unsupported reviewer backend")
    if not isinstance(profile_backend, str) or not NAME_RE.fullmatch(profile_backend):
        raise ValueError("trial profile backend is invalid")
    if not isinstance(model, str) or not TOKEN_RE.fullmatch(model):
        raise ValueError("trial reviewer model is invalid")
    if not isinstance(training_org, str) or not ORG_RE.fullmatch(training_org):
        raise ValueError("trial reviewer training organization is invalid")
    if transport not in TRANSPORTS:
        raise ValueError("trial transport is invalid")
    if not isinstance(connection, str) or not NAME_RE.fullmatch(connection):
        raise ValueError("trial connection is invalid")
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("trial endpoint is invalid")
    if auth_mode not in ("none", "env"):
        raise ValueError("trial auth mode is invalid")
    if auth_mode == "env" and (not credential_env or not ENV_RE.fullmatch(credential_env)):
        raise ValueError("trial credential environment name is invalid")
    if auth_mode == "none" and credential_env:
        raise ValueError("keyless trial may not name a credential environment variable")


def _identity(backend, profile_backend, model, training_org, transport, connection,
              base_url, auth_mode, credential_env, env):
    _validate(
        backend, profile_backend, model, training_org, transport, connection,
        base_url, auth_mode, credential_env,
    )
    revision = review_qualification.credential_revision(
        auth_mode, credential_env or None, env,
    )
    endpoint = hashlib.sha256(base_url.encode("utf-8")).hexdigest()
    values = (
        backend, profile_backend, model, training_org, transport, connection,
        endpoint, auth_mode, credential_env or "none", revision,
    )
    trial = "trial1:" + hashlib.sha256(_join(values)).hexdigest()
    return trial, endpoint, revision


def _record_hmac(record, env):
    return hmac.new(
        review_qualification.machine_salt(env),
        _join(tuple(record[field] for field in RECORD_FIELDS)),
        hashlib.sha256,
    ).hexdigest()


def _ensure_machine_salt(env):
    """A trusted trial issuer may mint the shared salt; readers never do."""
    directory = _base_dir(env)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    path = os.path.join(directory, ".machine-salt")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) \
        | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        review_qualification.machine_salt(env)
        return
    except OSError:
        # Produce the same bounded error as the read authority without exposing a path.
        review_qualification.machine_salt(env)
        return
    try:
        os.write(fd, (secrets.token_hex(32) + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def record_path(trial, env):
    if not isinstance(trial, str) or not TRIAL_RE.fullmatch(trial):
        raise ValueError("review trial must be an exact trial1: fingerprint")
    return os.path.join(
        _base_dir(env), "gate-reviewer-trials", trial.split(":", 1)[1] + ".json",
    )


def _atomic_json(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=".trial-", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def issue(backend, profile_backend, model, training_org, transport, connection,
          base_url, auth_mode, credential_env, env=None, now=None, ttl_seconds=86400):
    """Issue or replace one short-lived, non-gating trial authority record."""
    env = os.environ if env is None else env
    now = int(time.time() if now is None else now)
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) \
            or ttl_seconds < 60 or ttl_seconds > 86400:
        raise ValueError("review trial TTL must be between 60 and 86400 seconds")
    _ensure_machine_salt(env)
    trial, endpoint, revision = _identity(
        backend, profile_backend, model, training_org, transport, connection,
        base_url, auth_mode, credential_env, env,
    )
    record = {
        "schema_version": SCHEMA_VERSION,
        "trial": trial,
        "backend": backend,
        "profile_backend": profile_backend,
        "reviewer_model": model,
        "training_org": training_org,
        "transport": transport,
        "connection": connection,
        "endpoint_sha256": endpoint,
        "auth_mode": auth_mode,
        "credential_env": credential_env or "none",
        "credential_revision": revision,
        "expires_at": now + ttl_seconds,
    }
    record["hmac"] = _record_hmac(record, env)
    _atomic_json(record_path(trial, env), record)
    return record


def _read_private(path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ValueError("review trial record is missing or inaccessible")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("review trial record is not a private regular file")
        content = os.read(fd, 65537)
    finally:
        os.close(fd)
    if len(content) > 65536:
        raise ValueError("review trial record exceeds its bounded size")
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise ValueError("review trial record is unreadable")
    if not isinstance(value, dict) or frozenset(value) != RECORD_KEYS:
        raise ValueError("review trial record has an invalid schema")
    return value


def accepted_training_org(trial, backend, profile_backend, model, transport,
                          connection, base_url, auth_mode, credential_env,
                          env=None, now=None):
    """Validate the live trial tuple and return its HMAC-bound training org."""
    env = os.environ if env is None else env
    record = _read_private(record_path(trial, env))
    if record.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("review trial record has an unsupported schema version")
    expected_trial, endpoint, revision = _identity(
        backend, profile_backend, model, record.get("training_org"), transport,
        connection, base_url, auth_mode, credential_env, env,
    )
    expected = {
        "trial": trial,
        "backend": backend,
        "profile_backend": profile_backend,
        "reviewer_model": model,
        "transport": transport,
        "connection": connection,
        "endpoint_sha256": endpoint,
        "auth_mode": auth_mode,
        "credential_env": credential_env or "none",
        "credential_revision": revision,
    }
    drift = [key for key, value in expected.items() if record.get(key) != value]
    if expected_trial != trial or drift:
        raise ValueError(
            "review trial differs from this invocation in %s" %
            ", ".join(drift or ["trial"])
        )
    supplied = record.get("hmac")
    if not isinstance(supplied, str) or not re.fullmatch(r"[0-9a-f]{64}", supplied) \
            or not hmac.compare_digest(supplied, _record_hmac(record, env)):
        raise ValueError("review trial record HMAC does not verify")
    expiry = record.get("expires_at")
    if isinstance(expiry, bool) or not isinstance(expiry, int) \
            or expiry <= int(time.time() if now is None else now):
        raise ValueError("review trial record has expired; start a fresh shadow review")
    return record["training_org"]
