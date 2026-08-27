#!/usr/bin/env python3
"""Benchmark-candidate OpenAI-compatible HTTP reviewer.

This module is the candidate and admitted executor behind ``reviewer_dispatch.py``. Before Slice G
admission it runs only through the explicit signed trial route; production dispatch additionally
requires an exact checked-in ``admit1:`` record and seals that id into its binding. Its public forms
match every reviewer backend:

  http_openai_compat_review.py WORKTREE TASK ROUND EFFORT light
  http_openai_compat_review.py await WATCH_DIR
  http_openai_compat_review.py abort WATCH_DIR

Only chat-completions SSE is implemented in Slice F.  The model receives the immutable review
prompt plus the worktree diff; it gets no repository or tools.  Detached process custody,
reattachment, idle detection, and process-group cancellation are delegated to review_watch.py.
"""
import argparse
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
import queue
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import adapter
import review_request
import review_qualification
import review_trial
import review_watch


REVIEW_CONTRACT = "rc1"
BACKEND = "http_openai_compat"
VALID_EFFORT = ("low", "medium", "high", "xhigh")
VALID_TRANSPORT = ("loopback", "direct_https", "ssh_tunnel")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SECRET_SHAPE_RE = re.compile(
    r"(?:Bearer\s+)[A-Za-z0-9._~+/=-]{4,}|\b(?:sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,}",
    re.I,
)
MAX_DIFF_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MESSAGE_QUEUE_DEPTH = 64
WORKFLOW_AWAIT_CAP = 6
INTERNAL_DNS_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A configured endpoint is an authorization boundary, not a redirect starting point."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TunnelDied(ValueError):
    """The managed SSH route lost its bound process identity before/during review."""


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to one checked address while authenticating the configured DNS hostname."""

    def __init__(self, host, port, pinned_address, **kwargs):
        self._pinned_address = pinned_address
        super().__init__(host, port=port, **kwargs)

    def connect(self):
        # Passing a numeric address prevents create_connection from performing a second DNS
        # lookup after the policy check. TLS still receives self.host for SNI and certificate
        # hostname verification, so pinning does not weaken server authentication.
        raw = socket.create_connection(
            (self._pinned_address, self.port), self.timeout, self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def _infra(code, message, **extra):
    value = {
        "ran": False,
        "error": message,
        "error_code": code,
        "clean": False,
        "blocking": [],
        "nonblocking": [],
    }
    value.update(extra)
    return value


def _emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    return 0


def response_identity_error(requested_model, response_models):
    """Return the production refusal for absent/substituted response model identity."""
    if not response_models:
        return (
            "model_identity_unproven",
            "HTTP reviewer response did not identify the model that produced the verdict",
        )
    unexpected = [value for value in response_models if value != requested_model]
    if unexpected:
        return (
            "model_identity_mismatch",
            "HTTP reviewer reported model %r instead of requested %r" % (
                unexpected[0], requested_model,
            ),
        )
    return None


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ValueError("could not read %s (%s)" % (path, exc.__class__.__name__))
    if not isinstance(value, dict):
        raise ValueError("%s is not a JSON object" % path)
    return value


def _atomic_write(path, content, mode=0o600):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".http-review-", suffix=".tmp")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _atomic_json(path, value):
    _atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _with_start_lock(path, action, wait_s=40):
    """Serialize one round's inspect/archive/spawn transition across caller processes."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + wait_s
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("another HTTP review start still owns the round claim")
                time.sleep(0.05)
        return action()
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _git(repo, *args, binary=False):
    result = subprocess.run(
        ["git", "-C", repo] + list(args), capture_output=True,
        text=not binary, timeout=60,
    )
    if result.returncode != 0:
        error = result.stderr if binary else (result.stdout + result.stderr)
        if isinstance(error, bytes):
            error = error.decode("utf-8", "replace")
        raise ValueError("git %s failed: %s" % (" ".join(args), str(error)[-300:]))
    return result.stdout


def _guard_worktree(target, env=None):
    """Python twin of _guard.sh's egress boundary, without invoking a shell."""
    env = os.environ if env is None else env
    target = os.path.realpath(target)
    if not os.path.isdir(target):
        raise ValueError("target is not a directory")
    top = os.path.realpath(str(_git(target, "rev-parse", "--show-toplevel")).strip())
    if top != target:
        raise ValueError("target is not a Git toplevel")
    common = os.path.realpath(str(_git(target, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip())
    anchor = os.path.realpath(env.get("CAMUS_REPO_ROOT") or os.getcwd())
    anchor_common = os.path.realpath(str(_git(anchor, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip())
    if common != anchor_common:
        raise ValueError("target is outside the trusted repository")
    if env.get("CAMUS_REPO_ROOT"):
        cwd_common = os.path.realpath(str(_git(os.getcwd(), "rev-parse", "--path-format=absolute", "--git-common-dir")).strip())
        if cwd_common != anchor_common:
            raise ValueError("current directory is outside CAMUS_REPO_ROOT")
    branch = str(_git(target, "branch", "--show-current")).strip()
    suffix = branch.rsplit("/", 1)[-1]
    if not branch.startswith("camus/") or os.path.basename(target) != "camus-wt-" + suffix:
        raise ValueError("target is not the coherent Camus task worktree")
    return target


def _positive_int(value, label, default, minimum=1, maximum=86400):
    if value in (None, ""):
        return default
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        raise ValueError("%s must be an integer" % label)
    if parsed < minimum or parsed > maximum:
        raise ValueError("%s must be between %d and %d" % (label, minimum, maximum))
    return parsed


def _default_await_chunk(hard_timeout_s):
    """Cover the sealed hard timeout across camus-loop's six reattachment opportunities."""
    return max(1, (hard_timeout_s + WORKFLOW_AWAIT_CAP - 1) // WORKFLOW_AWAIT_CAP)


def _safe_url(raw, transport):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("CAMUS_HTTP_REVIEW_BASE_URL is required")
    value = raw.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("review base URL may not contain credentials, query, or fragment")
    if not parsed.hostname or parsed.scheme not in ("http", "https"):
        raise ValueError("review base URL must be absolute HTTP(S)")
    host = parsed.hostname
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if transport in ("loopback", "ssh_tunnel"):
        if address is None or not address.is_loopback:
            raise ValueError("%s review transport requires a literal loopback URL" % transport)
    elif transport == "direct_https":
        if parsed.scheme != "https":
            raise ValueError("direct_https review transport requires HTTPS")
        normalized_host = host.lower().rstrip(".")
        if address is not None:
            raise ValueError("direct_https may not target a literal IP address; use loopback or ssh_tunnel")
        if "." not in normalized_host or normalized_host == "metadata.google.internal" or normalized_host == "instance-data.ec2.internal" or any(
            normalized_host.endswith(suffix) for suffix in INTERNAL_DNS_SUFFIXES
        ):
            raise ValueError("direct_https may not target a localhost/private/internal name")
    return value


def _direct_https_addresses(url):
    """Resolve once, reject the whole answer set if any address is not public, and return pins."""
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname
    port = parsed.port or 443
    try:
        answers = socket.getaddrinfo(
            host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except (OSError, UnicodeError) as exc:
        raise ValueError("direct_https hostname resolution failed (%s)" % exc.__class__.__name__)
    addresses = []
    for family, socktype, _proto, _canonname, sockaddr in answers:
        if family not in (socket.AF_INET, socket.AF_INET6) or socktype != socket.SOCK_STREAM:
            raise ValueError("direct_https hostname resolved to an unsupported address family")
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            raise ValueError("direct_https hostname resolution returned an invalid address")
        if not address.is_global or address.is_multicast or address.is_unspecified:
            raise ValueError("direct_https hostname resolved to a non-public address")
        rendered = str(address)
        if rendered not in addresses:
            addresses.append(rendered)
    if not addresses:
        raise ValueError("direct_https hostname resolution returned no usable addresses")
    return tuple(addresses)


def _open_pinned_https(request, timeout):
    parsed = urllib.parse.urlsplit(request.full_url)
    addresses = _direct_https_addresses(request.full_url)
    connection = _PinnedHTTPSConnection(
        parsed.hostname,
        parsed.port or 443,
        pinned_address=addresses[0],
        timeout=timeout,
        context=ssl.create_default_context(),
    )
    target = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    try:
        connection.request(
            request.get_method(), target, body=request.data,
            headers=dict(request.header_items()),
        )
        return connection.getresponse()
    except BaseException:
        connection.close()
        raise


def _release_stream_read_deadline(response):
    """Let the main worker loop, not the connect timeout, govern SSE idle/hard deadlines."""
    fp = getattr(response, "fp", None)
    raw = getattr(fp, "raw", None)
    sock = getattr(raw, "_sock", None)
    if sock is None or not callable(getattr(sock, "settimeout", None)):
        raise ValueError("HTTP response socket cannot be bound to the stream watchdog")
    sock.settimeout(None)


def _redact(message, secret=None):
    text = str(message or "")
    if isinstance(secret, str) and secret:
        text = text.replace(secret, "<redacted-credential>")
    return SECRET_SHAPE_RE.sub(lambda m: m.group(0).split()[0] + " <redacted>" if m.group(0).lower().startswith("bearer ") else "<redacted-credential>", text)


def _request_path(review_dir, worktree):
    return os.path.join(review_dir, os.path.basename(worktree) + "-request.json")


def _credential_revision(auth, key_env, env):
    return review_qualification.credential_revision(auth, key_env, env)


def _review_prompt(skill_dir, task, scope):
    with open(os.path.join(skill_dir, "review-prompt.md"), encoding="utf-8") as fh:
        prompt = fh.read().rstrip("\n")
    if task:
        prompt += (
            "\n\n## Task this change must accomplish\n"
            "The diff must fulfill this exact task. A correct-looking but incomplete change is a P1:\n"
            + task
        )
    if scope == "light":
        prompt += (
            "\n\n## Review scope: LIGHT\n"
            "Judge the DIFF primarily. Read surrounding code only where the supplied diff's "
            "correctness depends on it. Apply the same P0-P3 severity bar."
        )
    return prompt


def _candidate_input(worktree, prompt):
    # Match codex_review.sh: intent-to-add makes new files part of the diff without staging bytes.
    _git(worktree, "add", "-N", ".")
    head = str(_git(worktree, "rev-parse", "HEAD")).strip()
    diff = _git(worktree, "-c", "diff.noprefix=false", "diff", "--binary", "--no-renames", "HEAD", "--", ".", binary=True)
    if len(diff) > MAX_DIFF_BYTES:
        raise ValueError("review diff exceeds the %d-byte candidate limit" % MAX_DIFF_BYTES)
    prefix = "fp1\nhead:%s\nprompt-bytes:%d\n" % (head, len(prompt))
    digest = hashlib.sha256(prefix.encode("utf-8") + prompt.encode("utf-8") + b"\ndiff:\n" + diff).hexdigest()
    sent = prompt + "\n\n## Patch to review\n<camus_diff>\n" + diff.decode("utf-8", "replace") + "\n</camus_diff>"
    return "fp1:" + digest, sent


def _runtime_fingerprint(config):
    """Bind adoption/replay to runtime choices without persisting URL, port, or credentials."""
    projection = {
        "base_url": config["base_url"],
        "model": config["model"],
        "auth": config["auth"],
        "key_env": config["key_env"],
        "credential_revision": config["credential_revision"],
        "timeout_s": config["timeout_s"],
        "idle_s": config["idle_s"],
        "connect_s": config["connect_s"],
        "transport": config["transport"],
        "connection": config["connection"],
    }
    encoded = json.dumps(projection, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "runtime1:" + hashlib.sha256(encoded).hexdigest()


def _safe_usage(value, depth=0):
    """Keep numeric usage observations while dropping provider-controlled text."""
    if depth > 3:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return value
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", key):
                continue
            normalized = _safe_usage(item, depth + 1)
            if normalized is not None:
                clean[key] = normalized
        return clean
    return None


def _binding_and_config(worktree, task, round_arg, effort_arg, scope_arg, env=None):
    env = os.environ if env is None else env
    scripts = os.path.dirname(os.path.abspath(__file__))
    skill_dir = os.path.dirname(scripts)
    review_dir = os.path.realpath(env.get("CAMUS_REVIEW_DIR") or os.path.join(os.path.expanduser("~"), ".camus", "reviews"))
    request = _read_json(_request_path(review_dir, worktree))
    if os.path.realpath(str(request.get("worktree") or "")) != worktree:
        raise ValueError("review request belongs to another worktree")

    round_text = review_request.consistent_value({
        "request": request.get("round"), "environment": env.get("CAMUS_REVIEW_ROUND"), "argv": round_arg,
    }, "review round")
    try:
        round_no = int(round_text)
    except ValueError:
        raise ValueError("review round must be a positive integer")
    if round_no < 1:
        raise ValueError("review round must be a positive integer")
    effort = review_request.consistent_value({
        "request": request.get("effort"), "environment": env.get("CAMUS_REVIEW_EFFORT"), "argv": effort_arg,
    }, "review effort")
    if effort not in VALID_EFFORT:
        raise ValueError("review effort must be one of %s" % "|".join(VALID_EFFORT))
    scope = review_request.consistent_value({
        "request": request.get("scope"), "environment": env.get("CAMUS_REVIEW_SCOPE"), "argv": scope_arg,
    }, "review scope")
    if scope != "light":
        raise ValueError("http_openai_compat supports only the light/diff-only review scope")

    nonce = review_request.consistent_value({"request": request.get("gate_nonce"), "environment": env.get("CAMUS_GATE_NONCE")}, "gate nonce")
    model = review_request.consistent_value({"request": request.get("reviewer_model"), "environment": env.get("CAMUS_HTTP_REVIEW_MODEL")}, "reviewer model")
    if not TOKEN_RE.fullmatch(model):
        raise ValueError("reviewer model identifier is invalid")
    backend = review_request.consistent_value({"request": request.get("reviewer_backend"), "environment": env.get("CAMUS_REVIEW_BACKEND")}, "reviewer backend")
    if backend != BACKEND:
        raise ValueError("reviewer backend is not http_openai_compat")
    contract = review_request.consistent_value({"request": request.get("contract"), "executor": REVIEW_CONTRACT}, "review contract")
    qualification = review_request.consistent_value({
        "request": request.get("qualification"),
        "environment": env.get("CAMUS_REVIEW_QUALIFICATION"),
    }, "review qualification")
    admitted_qualification = re.fullmatch(r"qual1:[0-9a-f]{64}", qualification)
    trial_qualification = re.fullmatch(r"trial1:[0-9a-f]{64}", qualification)
    if not admitted_qualification and not trial_qualification:
        raise ValueError("configurable HTTP reviewers require an exact qual1: or trial1: fingerprint")
    if trial_qualification and env.get("CAMUS_HTTP_REVIEW_TRIAL") != "1":
        raise ValueError("trial1 review requires the explicit non-gating trial route")
    admission_id = (env.get("CAMUS_REVIEW_ADMISSION_ID") or "").strip() or None
    if admission_id is not None and not re.fullmatch(r"admit1:[0-9a-f]{64}", admission_id):
        raise ValueError("review admission id is invalid")
    if trial_qualification and admission_id is not None:
        raise ValueError("a non-gating trial may not claim production admission")
    if admitted_qualification and admission_id is None:
        raise ValueError("an admitted qualification requires the exact checked-in admission id")
    origin = review_request.consistent_value({"request": request.get("origin"), "environment": env.get("CAMUS_REVIEW_ORIGIN")}, "review origin")
    operator = review_request.consistent_value({"request": request.get("operator"), "environment": env.get("CAMUS_REVIEW_OPERATOR")}, "review operator")
    transport = review_request.consistent_value({"request": request.get("transport"), "environment": env.get("CAMUS_HTTP_REVIEW_TRANSPORT")}, "review transport")
    if transport not in VALID_TRANSPORT:
        raise ValueError("HTTP review transport must be one of %s" % "|".join(VALID_TRANSPORT))
    connection = review_request.consistent_value({"request": request.get("connection"), "environment": env.get("CAMUS_HTTP_REVIEW_CONNECTION")}, "review connection")
    if not NAME_RE.fullmatch(connection):
        raise ValueError("review connection name is invalid")
    base_url = _safe_url(env.get("CAMUS_HTTP_REVIEW_BASE_URL"), transport)
    auth = (env.get("CAMUS_HTTP_REVIEW_AUTH") or "none").strip()
    if auth not in ("none", "env"):
        raise ValueError("CAMUS_HTTP_REVIEW_AUTH must be none|env")
    key_env = (env.get("CAMUS_HTTP_REVIEW_API_KEY_ENV") or "").strip()
    if auth == "env":
        if not ENV_NAME_RE.fullmatch(key_env):
            raise ValueError("CAMUS_HTTP_REVIEW_API_KEY_ENV must name an environment variable")
        if not env.get(key_env):
            raise ValueError("review credential environment variable %s is not set" % key_env)
    elif key_env:
        raise ValueError("keyless review may not name a credential environment variable")
    credential_revision = _credential_revision(auth, key_env or None, env)

    if admitted_qualification:
        profile_backend = (env.get("CAMUS_HTTP_REVIEW_PROFILE_BACKEND") or "").strip()
        training_org = review_qualification.accepted_training_org(
            qualification, admission_id, BACKEND, profile_backend, model, transport, connection,
            auth, key_env or None, env,
        )
        standing = "admitted_gate"
    else:
        profile_backend = (env.get("CAMUS_HTTP_REVIEW_PROFILE_BACKEND") or "").strip()
        training_org = review_trial.accepted_training_org(
            qualification, BACKEND, profile_backend, model, transport, connection,
            base_url, auth, key_env or None, env,
        )
        standing = "experimental_shadow"
    declared_training_org = (env.get("CAMUS_REVIEWER_TRAINING_ORG") or "").strip().lower()
    if declared_training_org and declared_training_org != training_org:
        raise ValueError("ambient reviewer training organization conflicts with the signed review authority")
    maker_org = (env.get("CAMUS_MAKER_TRAINING_ORG") or "").strip().lower()
    if not ORG_RE.fullmatch(maker_org):
        raise ValueError("maker training organization is missing or invalid")
    if maker_org == training_org:
        raise ValueError("maker and HTTP reviewer share training organization %r" % maker_org)

    tunnel_pid = tunnel_started = None
    if transport == "ssh_tunnel":
        tunnel_pid = _positive_int(env.get("CAMUS_HTTP_REVIEW_TUNNEL_PID"), "tunnel pid", None, maximum=2 ** 31 - 1)
        try:
            tunnel_started = float(env.get("CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT") or "")
        except ValueError:
            raise ValueError("ssh_tunnel review requires CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT")
        if tunnel_started <= 0 or not review_watch._is_ours(tunnel_pid, tunnel_started):
            raise TunnelDied("managed SSH inference tunnel died before review start; direct-network fallback is disabled")

    prompt = _review_prompt(skill_dir, task, scope)
    fingerprint, sent_prompt = _candidate_input(worktree, prompt)
    timeout_default = {"low": 300, "medium": 600, "high": 900, "xhigh": 1200}[effort]
    config = {
        "base_url": base_url,
        "model": model,
        "auth": auth,
        "key_env": key_env or None,
        "credential_revision": credential_revision,
        "timeout_s": _positive_int(env.get("CAMUS_HTTP_REVIEW_TIMEOUT_S"), "HTTP review timeout", timeout_default),
        "idle_s": _positive_int(env.get("CAMUS_HTTP_REVIEW_IDLE_S"), "HTTP review idle timeout", 120),
        "connect_s": _positive_int(env.get("CAMUS_HTTP_REVIEW_CONNECT_S"), "HTTP review connect timeout", 10, maximum=300),
        "transport": transport,
        "connection": connection,
        "tunnel_pid": tunnel_pid,
        "tunnel_started": tunnel_started,
    }
    meta = {
        "target_dir": worktree,
        "round": round_no,
        "effort": effort,
        "scope": scope,
        "reviewer_model": model,
        "reviewer_backend": BACKEND,
        "gate_nonce": nonce,
        "input_fingerprint": fingerprint,
        "input_sha256": "sha256:" + hashlib.sha256(sent_prompt.encode("utf-8")).hexdigest(),
        "contract": contract,
        "qualification": qualification,
        "origin": origin,
        "operator": operator,
        "transport": transport,
        "connection": connection,
        "reviewer_training_org": training_org,
        "maker_training_org": maker_org,
        "standing": standing,
        "admission_id": admission_id,
        # Only a one-way digest is durable. It prevents a completed result or live process from
        # being adopted after endpoint/auth-mode/timeout drift without persisting the endpoint,
        # its resolved tunnel port, or any credential value.
        "runtime_fingerprint": _runtime_fingerprint(config),
    }
    return review_dir, meta, config, sent_prompt


def _watch_command(mode, watch_dir, chunk=None, idle=None, cwd=None):
    command = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "review_watch.py"), mode, "--handle", watch_dir]
    if mode == "await":
        command += ["--chunk", str(chunk), "--idle", str(idle)]
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=max(30, (chunk or 0) + 20))
    try:
        value = json.loads((result.stdout or "").strip())
    except ValueError:
        return {"state": "error", "error": "shared review watchdog returned an unreadable envelope"}
    return value if isinstance(value, dict) else {"state": "error", "error": "shared review watchdog returned a non-object envelope"}


def _binding(meta):
    return {
        "round": meta.get("round"),
        "effort": meta.get("effort"),
        "model": meta.get("reviewer_model"),
        "backend": meta.get("reviewer_backend"),
        "worktree": meta.get("target_dir"),
        "nonce": meta.get("gate_nonce"),
        "round_requested": meta.get("round"),
        "effort_requested": meta.get("effort"),
        "contract": meta.get("contract"),
        "scope": meta.get("scope"),
        "qualification": meta.get("qualification"),
        "origin": meta.get("origin"),
        "operator": meta.get("operator"),
        "transport": meta.get("transport"),
        "connection": meta.get("connection"),
        "standing": meta.get("standing"),
        "admission_id": meta.get("admission_id"),
        "input_fingerprint": meta.get("input_fingerprint"),
    }


def _audit_binding(meta):
    return {
        "gate_nonce": meta.get("gate_nonce"),
        "round_requested": meta.get("round"),
        "effort_requested": meta.get("effort"),
        "effort_specified": True,
        "round_sources": {"meta.json": str(meta.get("round"))},
        "effort_sources": {"meta.json": meta.get("effort")},
        "reviewer_backend": meta.get("reviewer_backend"),
        "contract": meta.get("contract"),
        "scope": meta.get("scope"),
        "qualification": meta.get("qualification"),
        "origin": meta.get("origin"),
        "operator": meta.get("operator"),
        "transport": meta.get("transport"),
        "connection": meta.get("connection"),
        "standing": meta.get("standing"),
        "admission_id": meta.get("admission_id"),
        "input_fingerprint": meta.get("input_fingerprint"),
        "round_actual": meta.get("round"),
        "effort_actual": meta.get("effort"),
        "reviewer_model": meta.get("reviewer_model"),
        "bound": True,
    }


def _audit_path(review_dir, meta):
    return os.path.join(review_dir, "%s-r%d.json" % (os.path.basename(meta["target_dir"]), meta["round"]))


def _write_audit(review_dir, meta, exit_code, raw, failure=None):
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except ValueError:
        parsed = None
    normalized = adapter.normalize_codex(raw, exit_code)
    record = {
        "ran_at": int(time.time()),
        "worktree": meta.get("target_dir"),
        "worktree_canonical": os.path.realpath(meta.get("target_dir") or ""),
        "round": meta.get("round"),
        # codex_exit remains for the existing generic receipt reader; backend_exit names reality.
        "codex_exit": exit_code,
        "backend_exit": exit_code,
        "ran": normalized.get("ran") is True,
        "reviewer_model": meta.get("reviewer_model"),
        "reviewer_effort": meta.get("effort"),
        "reviewer_training_org": meta.get("reviewer_training_org"),
        "maker_training_org": meta.get("maker_training_org"),
        "standing": meta.get("standing"),
        "admission_id": meta.get("admission_id"),
        "input_fingerprint": meta.get("input_fingerprint"),
        "codex_raw": raw,
        "codex_parsed": parsed,
        "binding": _audit_binding(meta),
    }
    if isinstance(failure, dict):
        record["infrastructure_failure"] = {
            "code": failure.get("code"), "message": failure.get("message"),
        }
    path = _audit_path(review_dir, meta)
    if os.path.exists(path):
        prior = _read_json(path)
        # Reattach/replay may present a completed round repeatedly. Its receipt is immutable:
        # matching evidence is reused byte-for-byte, while changed output, failure, identity, or
        # binding is corruption and must never be blessed by overwriting the earlier testimony.
        compared = (
            "worktree", "worktree_canonical", "round", "codex_exit", "backend_exit",
            "reviewer_model", "reviewer_effort", "reviewer_training_org",
            "maker_training_org", "standing", "admission_id", "input_fingerprint",
            "codex_raw", "codex_parsed", "binding",
            "infrastructure_failure",
        )
        drift = [key for key in compared if prior.get(key) != record.get(key)]
        if drift:
            raise ValueError("existing HTTP review audit differs in %s" % ", ".join(drift))
        return normalized
    _atomic_json(path, record)
    return normalized


def _archive_failed_attempt(watch_dir, review_dir, meta):
    """Preserve a terminal infrastructure attempt before the same bound round retries."""
    attempt = None
    for number in range(1, 1000):
        candidate = os.path.join(watch_dir, "a%d" % number)
        if not os.path.lexists(candidate):
            os.mkdir(candidate, 0o700)
            attempt = candidate
            break
    if attempt is None:
        raise ValueError("HTTP review has too many preserved attempts")
    for name in (
        "meta.json", "runtime.json", "input.txt", "failure.json", "last.txt",
        "exit_code", "events.jsonl", "err.log", "handle.json",
    ):
        source = os.path.join(watch_dir, name)
        if os.path.lexists(source):
            os.replace(source, os.path.join(attempt, name))
    audit = _audit_path(review_dir, meta)
    if os.path.lexists(audit):
        os.replace(audit, os.path.join(attempt, "audit.json"))
    return attempt


def _completed_review_is_usable(watch_dir, envelope):
    if envelope.get("state") != "done":
        return False
    try:
        if int(envelope.get("exit", 1)) != 0:
            return False
        with open(os.path.join(watch_dir, "last.txt"), encoding="utf-8") as fh:
            raw = fh.read()
    except (OSError, TypeError, ValueError):
        return False
    return adapter.normalize_codex(raw, 0).get("ran") is True


def _valid_handle(watch_dir, review_dir):
    watch = os.path.realpath(watch_dir)
    parent = os.path.realpath(review_dir)
    if os.path.dirname(watch) != parent or not re.fullmatch(r"[A-Za-z0-9._-]+-r[1-9][0-9]*\.watch", os.path.basename(watch)):
        raise ValueError("invalid or unknown HTTP review watch handle")
    meta = _read_json(os.path.join(watch, "meta.json"))
    if meta.get("reviewer_backend") != BACKEND:
        raise ValueError("watch handle belongs to another reviewer backend")
    if meta.get("contract") != REVIEW_CONTRACT:
        raise ValueError("review contract drift: stored %r, executor %r" % (meta.get("contract"), REVIEW_CONTRACT))
    target = os.path.realpath(str(meta.get("target_dir") or ""))
    if os.path.basename(watch) != "%s-r%s.watch" % (os.path.basename(target), meta.get("round")):
        raise ValueError("watch handle metadata does not match its path")
    env_nonce = os.environ.get("CAMUS_GATE_NONCE")
    if env_nonce and env_nonce != meta.get("gate_nonce"):
        raise ValueError("gate nonce drifted across HTTP review reattachment")
    return watch, meta


def _emit_outcome(envelope, watch_dir, review_dir, meta):
    state = envelope.get("state") if isinstance(envelope, dict) else None
    if state == "pending":
        return _emit({
            "pending": True, "handle": watch_dir,
            "last_event_age": envelope.get("last_event_age"), "pid": envelope.get("pid"),
        })
    if state == "done":
        try:
            exit_code = int(envelope.get("exit", 1))
        except (TypeError, ValueError):
            exit_code = 1
        try:
            with open(os.path.join(watch_dir, "last.txt"), encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            raw = ""
        failure = None
        failure_path = os.path.join(watch_dir, "failure.json")
        try:
            failure = _read_json(failure_path)
        except ValueError as exc:
            if os.path.exists(failure_path):
                return _emit(_infra("http_review_failure_record_invalid", str(exc), binding=_binding(meta)))
        try:
            normalized = _write_audit(review_dir, meta, exit_code, raw, failure=failure)
        except (OSError, ValueError) as exc:
            return _emit(_infra("http_review_audit_drift", str(exc), binding=_binding(meta)))
        if exit_code != 0 and isinstance(failure, dict):
            normalized = _infra(failure.get("code") or "http_reviewer_failed", failure.get("message") or "HTTP reviewer failed")
        normalized["binding"] = _binding(meta)
        normalized["reviewer_training_org"] = meta.get("reviewer_training_org")
        normalized["maker_training_org"] = meta.get("maker_training_org")
        normalized["standing"] = meta.get("standing")
        normalized["admission_id"] = meta.get("admission_id")
        normalized["input_fingerprint"] = meta.get("input_fingerprint")
        if isinstance(envelope.get("usage"), dict):
            normalized["usage"] = envelope["usage"]
        return _emit(normalized)
    code = {
        "idle_killed": "review_watchdog_idle",
        "aborted": "review_aborted",
        "error": "review_watchdog_error",
    }.get(state, "review_watchdog_unreadable")
    message = {
        "idle_killed": "HTTP review emitted no events for %ss and was killed" % envelope.get("idle_s", "?"),
        "aborted": "HTTP review aborted",
        "error": "HTTP review watchdog failed: %s" % envelope.get("error", "unknown"),
    }.get(state, "HTTP review watchdog envelope was unreadable")
    try:
        _write_audit(review_dir, meta, 124, "", failure={"code": code, "message": message})
    except (OSError, ValueError) as exc:
        return _emit(_infra("http_review_audit_drift", str(exc), binding=_binding(meta)))
    return _emit(_infra(code, message, binding=_binding(meta)))


def _start_review(args):
    try:
        worktree = _guard_worktree(args.worktree)
        review_dir = os.path.realpath(
            os.environ.get("CAMUS_REVIEW_DIR")
            or os.path.join(os.path.expanduser("~"), ".camus", "reviews")
        )
        os.makedirs(review_dir, mode=0o700, exist_ok=True)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return _emit(_infra("http_review_configuration", str(exc)))
    # Lock the whole candidate, not an unvalidated round value. A valid orchestrator never starts
    # two rounds for one worktree concurrently, and malformed/drifted round channels must not
    # evade serialization while both touch Git's shared index.
    lock_key = hashlib.sha256(
        worktree.encode("utf-8", "surrogatepass")
    ).hexdigest()[:32]
    lock_path = os.path.join(review_dir, ".http-review-%s.start.lock" % lock_key)
    try:
        return _with_start_lock(
            lock_path,
            lambda: _start_review_claimed(args, worktree, review_dir),
        )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return _emit(_infra("http_review_start_failed", _redact(exc)))


def _start_review_claimed(args, worktree, locked_review_dir):
    try:
        review_dir, meta, config, prompt = _binding_and_config(
            worktree, args.task or "", args.round, args.effort, args.scope,
        )
        if review_dir != locked_review_dir:
            raise ValueError("HTTP review directory drifted while acquiring the round claim")
    except TunnelDied as exc:
        return _emit(_infra("tunnel_died", str(exc)))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return _emit(_infra("http_review_configuration", str(exc)))
    watch_dir = os.path.join(review_dir, "%s-r%d.watch" % (os.path.basename(worktree), meta["round"]))
    try:
        if os.path.lexists(watch_dir) and (
            os.path.islink(watch_dir) or os.path.dirname(os.path.realpath(watch_dir)) != review_dir
        ):
            return _emit(_infra("http_review_handle_invalid", "HTTP review watch path is a symlink or escapes the review directory"))
        if os.path.isdir(watch_dir) and os.path.isfile(os.path.join(watch_dir, "meta.json")):
            prior = _read_json(os.path.join(watch_dir, "meta.json"))
            compared = (
                "target_dir", "round", "effort", "scope", "reviewer_model", "reviewer_backend",
                "gate_nonce", "input_fingerprint", "input_sha256", "contract", "qualification", "origin",
                "operator", "transport", "connection", "reviewer_training_org",
                "maker_training_org", "standing", "admission_id", "runtime_fingerprint",
            )
            drift = [key for key in compared if prior.get(key) != meta.get(key)]
            if drift:
                return _emit(_infra(
                    "http_review_replay_drift",
                    "stored HTTP review differs from this invocation in %s; refusing replay or overwrite" % ", ".join(drift),
                ))
            if os.path.isfile(os.path.join(watch_dir, "handle.json")):
                envelope = _watch_command("await", watch_dir, chunk=1, idle=config["idle_s"], cwd=worktree)
                if envelope.get("state") == "pending" or _completed_review_is_usable(watch_dir, envelope):
                    return _emit_outcome(envelope, watch_dir, review_dir, prior)
                if envelope.get("state") == "error" or envelope.get("unverified_pid") is True:
                    # A malformed/unverifiable handle could still belong to a live process. Never
                    # archive its identity and spawn a duplicate merely because custody is unclear.
                    return _emit_outcome(envelope, watch_dir, review_dir, prior)
                # The caller already observed (or is now retrying) a terminal infrastructure
                # attempt. Preserve every byte, then let this invocation start exactly one fresh
                # process for the same request instead of replaying failure forever.
                _archive_failed_attempt(watch_dir, review_dir, prior)
            elif any(os.path.lexists(os.path.join(watch_dir, name)) for name in (
                "runtime.json", "input.txt", "failure.json", "last.txt", "exit_code",
                "events.jsonl", "err.log",
            )) or os.path.lexists(_audit_path(review_dir, prior)):
                # No handle means no process identity can be adopted or signalled. This is the
                # safe retryable shape left by a pre-spawn/start failure; preserve it first.
                _archive_failed_attempt(watch_dir, review_dir, prior)
        else:
            os.makedirs(watch_dir, mode=0o700, exist_ok=True)
        _atomic_json(os.path.join(watch_dir, "meta.json"), meta)
        _atomic_json(os.path.join(watch_dir, "runtime.json"), {
            # No URL, port, auth header, env value, or tunnel PID is persisted.
            "protocol": "chat_completions", "stream": True,
            "auth": config["auth"], "credential_env": config["key_env"],
            "hard_timeout_s": config["timeout_s"], "idle_timeout_s": config["idle_s"],
            "connect_timeout_s": config["connect_s"],
        })
        _atomic_write(os.path.join(watch_dir, "input.txt"), prompt)
        for key in ("failure.json", "last.txt", "exit_code", "events.jsonl", "err.log", "handle.json"):
            try:
                os.unlink(os.path.join(watch_dir, key))
            except OSError:
                pass
        child_env = os.environ.copy()
        child_env.update({
            "CAMUS_HTTP_REVIEW_WATCH": watch_dir,
            "CAMUS_HTTP_REVIEW_BASE_URL": config["base_url"],
            "CAMUS_HTTP_REVIEW_MODEL": config["model"],
            "CAMUS_HTTP_REVIEW_AUTH": config["auth"],
            "CAMUS_HTTP_REVIEW_API_KEY_ENV": config["key_env"] or "",
            "CAMUS_HTTP_REVIEW_TIMEOUT_S": str(config["timeout_s"]),
            "CAMUS_HTTP_REVIEW_IDLE_S": str(config["idle_s"]),
            "CAMUS_HTTP_REVIEW_CONNECT_S": str(config["connect_s"]),
            "CAMUS_HTTP_REVIEW_TRANSPORT": config["transport"],
            "CAMUS_HTTP_REVIEW_CONNECTION": config["connection"],
            "CAMUS_HTTP_REVIEW_TUNNEL_PID": str(config["tunnel_pid"] or ""),
            "CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT": str(config["tunnel_started"] or ""),
        })
        command = [
            sys.executable, os.path.abspath(__file__), "_worker",
            "--watch", watch_dir,
        ]
        watcher = [
            sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "review_watch.py"),
            "start", "--handle", watch_dir, "--last", os.path.join(watch_dir, "last.txt"), "--",
        ] + command
        started = subprocess.run(
            watcher, cwd=worktree, env=child_env, capture_output=True, text=True, timeout=30,
        )
        try:
            started_envelope = json.loads((started.stdout or "").strip())
        except ValueError:
            started_envelope = {"state": "error", "error": "shared review watchdog did not start"}
        if started_envelope.get("state") != "started":
            return _emit_outcome(started_envelope, watch_dir, review_dir, meta)
        chunk = _positive_int(os.environ.get("CAMUS_HTTP_REVIEW_START_CHUNK_S"), "HTTP start chunk", 1, maximum=300)
        envelope = _watch_command("await", watch_dir, chunk=chunk, idle=config["idle_s"], cwd=worktree)
        return _emit_outcome(envelope, watch_dir, review_dir, meta)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return _emit(_infra("http_review_start_failed", _redact(exc)))


def _reattach(mode, watch_dir):
    review_dir = os.path.realpath(os.environ.get("CAMUS_REVIEW_DIR") or os.path.join(os.path.expanduser("~"), ".camus", "reviews"))
    try:
        watch, meta = _valid_handle(watch_dir, review_dir)
        if mode == "abort":
            envelope = _watch_command("abort", watch, cwd=meta.get("target_dir"))
        else:
            runtime = _read_json(os.path.join(watch, "runtime.json"))
            idle = _positive_int(runtime.get("idle_timeout_s"), "sealed HTTP review idle timeout", 120)
            hard = _positive_int(runtime.get("hard_timeout_s"), "sealed HTTP review hard timeout", 600)
            chunk = _positive_int(
                os.environ.get("CAMUS_HTTP_REVIEW_AWAIT_CHUNK_S"),
                "HTTP await chunk", _default_await_chunk(hard), maximum=600,
            )
            envelope = _watch_command("await", watch, chunk=chunk, idle=idle, cwd=meta.get("target_dir"))
        return _emit_outcome(envelope, watch, review_dir, meta)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return _emit(_infra("http_review_handle_invalid", str(exc)))


def _worker_failure(watch, code, message, exit_code):
    _atomic_json(os.path.join(watch, "failure.json"), {"code": code, "message": _redact(message)})
    print(json.dumps({"type": "review.failed", "code": code}), flush=True)
    return exit_code


def _worker(args):
    watch = os.path.realpath(args.watch)
    try:
        meta = _read_json(os.path.join(watch, "meta.json"))
        runtime = _read_json(os.path.join(watch, "runtime.json"))
        with open(os.path.join(watch, "input.txt"), encoding="utf-8") as fh:
            prompt = fh.read()
        if "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest() != meta.get("input_sha256"):
            return _worker_failure(watch, "review_input_drift", "persisted HTTP review input differs from sealed metadata", 70)
        model = os.environ["CAMUS_HTTP_REVIEW_MODEL"]
        base_url = _safe_url(os.environ.get("CAMUS_HTTP_REVIEW_BASE_URL"), meta.get("transport"))
        if model != meta.get("reviewer_model"):
            return _worker_failure(watch, "reviewer_identity_drift", "worker model differs from sealed meta", 70)
        auth = runtime.get("auth")
        key_env = runtime.get("credential_env")
        secret = None
        if auth == "env":
            if not isinstance(key_env, str) or not ENV_NAME_RE.fullmatch(key_env) or not os.environ.get(key_env):
                return _worker_failure(watch, "credential_missing", "review credential environment variable is unavailable", 70)
            secret = os.environ[key_env]
        elif auth != "none":
            return _worker_failure(watch, "auth_invalid", "sealed auth mode is invalid", 70)
        timeout_s = _positive_int(os.environ.get("CAMUS_HTTP_REVIEW_TIMEOUT_S"), "HTTP review timeout", 600)
        idle_s = _positive_int(os.environ.get("CAMUS_HTTP_REVIEW_IDLE_S"), "HTTP review idle timeout", 120)
        connect_s = _positive_int(os.environ.get("CAMUS_HTTP_REVIEW_CONNECT_S"), "HTTP review connect timeout", 10, maximum=300)
        if timeout_s != runtime.get("hard_timeout_s") or idle_s != runtime.get("idle_timeout_s") or connect_s != runtime.get("connect_timeout_s"):
            return _worker_failure(watch, "runtime_binding_drift", "worker timeout settings differ from sealed runtime", 70)
        worker_config = {
            "base_url": base_url, "model": model, "auth": auth, "key_env": key_env,
            "credential_revision": _credential_revision(auth, key_env, os.environ),
            "timeout_s": timeout_s, "idle_s": idle_s, "connect_s": connect_s,
            "transport": meta.get("transport"), "connection": meta.get("connection"),
        }
        if _runtime_fingerprint(worker_config) != meta.get("runtime_fingerprint"):
            return _worker_failure(watch, "runtime_binding_drift", "worker configuration differs from sealed runtime", 70)
        tunnel_pid = tunnel_started = None
        if meta.get("transport") == "ssh_tunnel":
            tunnel_pid = _positive_int(os.environ.get("CAMUS_HTTP_REVIEW_TUNNEL_PID"), "tunnel pid", None, maximum=2 ** 31 - 1)
            tunnel_started = float(os.environ.get("CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT") or "")
            if not review_watch._is_ours(tunnel_pid, tunnel_started):
                return _worker_failure(watch, "tunnel_died", "managed SSH inference tunnel died; direct-network fallback is disabled", 74)
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sev.schema.json"), encoding="utf-8") as fh:
            schema = json.load(fh)
    except (KeyError, OSError, ValueError) as exc:
        return _worker_failure(watch, "worker_configuration", _redact(exc), 70)

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "camus_review", "strict": True, "schema": schema},
        },
    }).encode("utf-8")
    headers = {"content-type": "application/json", "accept": "text/event-stream"}
    if secret is not None:
        headers["authorization"] = "Bearer " + secret
    request = urllib.request.Request(base_url + "/chat/completions", data=body, headers=headers, method="POST")
    # Backpressure is part of the response bound: without it, a fast endpoint can enqueue an
    # unbounded number of individually small lines before the parser reaches its byte check.
    messages = queue.Queue(maxsize=MESSAGE_QUEUE_DEPTH)
    response_holder = []

    def network():
        produced_bytes = 0
        try:
            # Ambient proxy variables would silently change who receives the diff and credential.
            # Redirects could do the same after the first trusted hop. Disable both: this candidate
            # has one declared endpoint and no network fallback.
            if meta.get("transport") == "direct_https":
                response = _open_pinned_https(request, connect_s)
            else:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
                response = opener.open(request, timeout=connect_s)
            response_holder.append(response)
            status = getattr(response, "status", 200)
            if status < 200 or status >= 300:
                detail = response.read(4097)[:4096].decode("utf-8", "replace")
                messages.put(("http_error", status, detail))
                return
            # opener/connect timeouts must not silently replace the independently sealed SSE
            # idle/hard watchdogs. The reader is a daemon and the worker process is the final
            # cancellation boundary, so a blocked read cannot outlive either deadline.
            _release_stream_read_deadline(response)
            messages.put(("response", status, response.headers.get("content-type", "")))
            while True:
                # Bound a single unterminated line before it can allocate beyond the total
                # response budget. The main thread also enforces the cumulative limit.
                line = response.readline(MAX_RESPONSE_BYTES + 1)
                if not line:
                    break
                produced_bytes += len(line)
                if produced_bytes > MAX_RESPONSE_BYTES:
                    messages.put(("response_too_large",))
                    return
                messages.put(("line", line))
            messages.put(("eof",))
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(4096).decode("utf-8", "replace")
            except Exception:
                detail = ""
            messages.put(("http_error", exc.code, detail))
        except BaseException as exc:  # the main thread turns every network shape into typed infra
            messages.put(("network_error", exc.__class__.__name__, str(exc)))

    started = time.monotonic()
    last_event = started
    thread = threading.Thread(target=network, name="camus-http-review", daemon=True)
    thread.start()
    print(json.dumps({"type": "review.started", "backend": BACKEND}), flush=True)
    text_parts = []
    response_bytes = 0
    response_models = []
    usage = None
    saw_response = False
    saw_sse = False
    last_activity_report = started
    try:
        while True:
            now = time.monotonic()
            if now - started > timeout_s:
                return _worker_failure(watch, "review_timeout", "HTTP reviewer hit the hard timeout", 73)
            if now - last_event > idle_s:
                return _worker_failure(watch, "review_idle", "HTTP reviewer stream went idle", 72)
            if tunnel_pid is not None and not review_watch._is_ours(tunnel_pid, tunnel_started):
                return _worker_failure(watch, "tunnel_died", "managed SSH inference tunnel died; direct-network fallback is disabled", 74)
            try:
                item = messages.get(timeout=0.25)
            except queue.Empty:
                continue
            kind = item[0]
            if kind == "response":
                saw_response = True
                last_event = time.monotonic()
                if "text/event-stream" not in str(item[2]).lower():
                    return _worker_failure(watch, "streaming_unproven", "HTTP reviewer did not return an SSE stream", 76)
                print(json.dumps({"type": "response.started", "status": item[1]}), flush=True)
            elif kind == "line":
                last_event = time.monotonic()
                raw_line = item[1]
                response_bytes += len(raw_line)
                if response_bytes > MAX_RESPONSE_BYTES:
                    return _worker_failure(watch, "response_too_large", "HTTP reviewer response exceeded the bounded size limit", 77)
                line = raw_line.decode("utf-8", "replace").strip()
                if last_event - last_activity_report >= min(5.0, max(1.0, idle_s / 4.0)):
                    print(json.dumps({"type": "response.activity", "bytes": response_bytes}), flush=True)
                    last_activity_report = last_event
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                if payload == "[DONE]":
                    # SSE completion is protocol-level evidence; persistent HTTP/1.1 endpoints
                    # are allowed to keep the connection open for reuse after this sentinel.
                    break
                try:
                    event = json.loads(payload)
                except ValueError:
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer emitted malformed SSE JSON", 76)
                if not isinstance(event, dict):
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer emitted a non-object SSE event", 76)
                if isinstance(event.get("error"), dict):
                    return _worker_failure(watch, "provider_refused", _redact(event["error"].get("message"), secret), 71)
                reported = event.get("model")
                if isinstance(reported, str) and reported and reported not in response_models:
                    response_models.append(reported)
                if isinstance(event.get("usage"), dict):
                    usage = _safe_usage(event["usage"])
                choices = event.get("choices")
                if not isinstance(choices, list):
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer SSE choices field is not an array", 76)
                if not choices:
                    continue  # usage-only terminal chunks commonly carry an empty choices list
                choice = choices[0]
                if not isinstance(choice, dict):
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer SSE choice is not an object", 76)
                delta_obj = choice.get("delta")
                if delta_obj is None:
                    continue
                if not isinstance(delta_obj, dict):
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer SSE delta is not an object", 76)
                delta = delta_obj.get("content")
                if delta is not None and not isinstance(delta, str):
                    return _worker_failure(watch, "stream_malformed", "HTTP reviewer SSE content delta is not text", 76)
                if isinstance(delta, str) and delta:
                    saw_sse = True
                    text_parts.append(delta)
                    print(json.dumps({"type": "review.delta", "chars": sum(len(x) for x in text_parts)}), flush=True)
            elif kind == "http_error":
                if tunnel_pid is not None and not review_watch._is_ours(tunnel_pid, tunnel_started):
                    return _worker_failure(
                        watch, "tunnel_died",
                        "managed SSH inference tunnel died; direct-network fallback is disabled", 74,
                    )
                status = item[1]
                code = "provider_refused" if status in (401, 403, 429) else "provider_http_error"
                detail = "remote inference endpoint returned an HTTP error" if meta.get("transport") == "ssh_tunnel" else _redact(item[2], secret)[:200]
                return _worker_failure(watch, code, "HTTP reviewer answered %s: %s" % (status, detail), 71)
            elif kind == "network_error":
                if tunnel_pid is not None and not review_watch._is_ours(tunnel_pid, tunnel_started):
                    return _worker_failure(
                        watch, "tunnel_died",
                        "managed SSH inference tunnel died; direct-network fallback is disabled", 74,
                    )
                detail = (
                    "managed SSH inference request failed; direct-network fallback is disabled"
                    if meta.get("transport") == "ssh_tunnel"
                    else _redact("HTTP reviewer network failure (%s): %s" % (item[1], item[2]), secret)
                )
                return _worker_failure(watch, "provider_network_error", detail, 71)
            elif kind == "response_too_large":
                return _worker_failure(
                    watch, "response_too_large",
                    "HTTP reviewer response exceeded the bounded size limit", 77,
                )
            elif kind == "eof":
                break
        if not saw_response or not saw_sse:
            return _worker_failure(watch, "streaming_unproven", "HTTP reviewer produced no non-empty SSE content delta", 76)
        identity_error = response_identity_error(model, response_models)
        if identity_error is not None:
            return _worker_failure(watch, identity_error[0], identity_error[1], 75)
        raw = _redact("".join(text_parts), secret)
        # Persist provider output only after credential redaction; normalization remains shared.
        _atomic_write(os.path.join(watch, "last.txt"), raw)
        print(json.dumps({"type": "turn.completed", "usage": usage or {}}), flush=True)
        return 0
    finally:
        # ``HTTPResponse.close`` can wait behind a network thread blocked in readline(). On a
        # timeout/tunnel-death path that would strand the worker until the shared watchdog kills
        # it and erase the more precise failure. The reader is daemonized and the process is the
        # cancellation boundary, so only close synchronously once it has already returned.
        if not thread.is_alive():
            for response in response_holder:
                try:
                    response.close()
                except Exception:
                    pass


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] in ("await", "abort"):
        if len(raw) != 2:
            return _emit(_infra("http_review_handle_invalid", "%s requires exactly one watch handle" % raw[0]))
        return _reattach(raw[0], raw[1])
    if raw and raw[0] == "_worker":
        options = argparse.ArgumentParser(add_help=False)
        options.add_argument("_mode")
        options.add_argument("--watch", required=True)
        return _worker(options.parse_args(raw))
    if not raw:
        return _emit(_infra("http_review_arguments", "worktree, task, round, effort, and light scope are required"))
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument("worktree")
    options.add_argument("task", nargs="?", default="")
    options.add_argument("round")
    options.add_argument("effort")
    options.add_argument("scope")
    try:
        parsed = options.parse_args(raw)
    except SystemExit:
        return _emit(_infra("http_review_arguments", "worktree, task, round, effort, and light scope are required"))
    return _start_review(parsed)


if __name__ == "__main__":
    sys.exit(main())
