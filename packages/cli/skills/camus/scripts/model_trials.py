#!/usr/bin/env python3
"""List and run non-gating reviewer trials from Studio's local model profiles.

The profile file contains endpoint and credential *names*, never credential values.
Every trial is labelled ``experimental_shadow`` and writes to a separate receipt
directory.  It can inform evaluation; it can never authorize a task seal.
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse

import adapter
import http_openai_compat_review
import review_request
import review_trial
import review_watch


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
ORG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
EFFORTS = ("low", "medium", "high", "xhigh")
HARDENING = (
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=no",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "Tunnel=no",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
)


class TrialError(Exception):
    pass


def models_path(env=None):
    env = os.environ if env is None else env
    return env.get("CAMUS_MODELS_FILE") or env.get("STUDIO_MODELS_FILE") or os.path.join(
        os.path.expanduser("~"), ".camus", "studio", "models.json",
    )


def _private_json(path, limit=1024 * 1024):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise TrialError("local Studio model profiles are missing; configure providers in Studio first")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise TrialError("local Studio model profiles are not a regular file")
        if info.st_mode & 0o077:
            raise TrialError("local Studio model profiles must be private (chmod 600)")
        content = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(content) > limit:
        raise TrialError("local Studio model profiles exceed the bounded size")
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise TrialError("local Studio model profiles are unreadable")
    if not isinstance(value, dict):
        raise TrialError("local Studio model profiles must be a JSON object")
    return value


def _required(value, label, pattern=None):
    if not isinstance(value, str) or not value:
        raise TrialError("%s must be a non-empty string" % label)
    if pattern is not None and not pattern.fullmatch(value):
        raise TrialError("%s has an invalid shape" % label)
    return value


def _base_path(value):
    value = "/v1" if value is None else value
    if not isinstance(value, str) or not value.startswith("/") or re.search(r"[?#\s]", value):
        raise TrialError("ssh_tunnel.basePath must be an absolute URL path")
    return value.rstrip("/") or "/"


def _normalize_connection(name, raw):
    if not isinstance(raw, dict):
        raise TrialError("connections.%s must be an object" % name)
    kind = raw.get("kind")
    if kind == "direct_https":
        value = _required(raw.get("baseUrl"), "connections.%s.baseUrl" % name).rstrip("/")
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password \
                or parsed.query or parsed.fragment:
            raise TrialError("direct_https connection %s must be a credential-free HTTPS URL" % name)
        return {"name": name, "kind": kind, "base_url": value}
    if kind == "loopback":
        if raw.get("baseUrl"):
            value = str(raw["baseUrl"]).rstrip("/")
        else:
            port = raw.get("port")
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                raise TrialError("loopback connection %s needs an integer port" % name)
            value = "http://127.0.0.1:%d%s" % (port, _base_path(raw.get("basePath")))
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1"):
            raise TrialError("loopback connection %s must use a literal local HTTP address" % name)
        return {"name": name, "kind": kind, "base_url": value}
    if kind == "ssh_tunnel":
        alias = _required(raw.get("sshHostAlias"), "connections.%s.sshHostAlias" % name, NAME_RE)
        remote = str(raw.get("remoteAddress") or "").lower()
        port = raw.get("remotePort")
        if remote not in ("localhost", "127.0.0.1", "::1"):
            raise TrialError("ssh_tunnel %s may forward only to remote loopback" % name)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise TrialError("ssh_tunnel %s needs a valid remotePort" % name)
        return {
            "name": name, "kind": kind, "ssh_alias": alias,
            "remote_address": remote, "remote_port": port,
            "base_path": _base_path(raw.get("basePath")),
        }
    raise TrialError("connection %s uses unsupported transport %r" % (name, kind))


def load_profiles(env=None):
    env = os.environ if env is None else env
    value = _private_json(models_path(env))
    raw_connections = value.get("connections") if isinstance(value.get("connections"), dict) else {}
    connections = {
        _required(name, "connection name", NAME_RE): _normalize_connection(name, raw)
        for name, raw in raw_connections.items()
    }
    profiles = {}
    for name, raw in (value.get("backends") or {}).items():
        _required(name, "backend name", NAME_RE)
        if not isinstance(raw, dict) or raw.get("kind") != "openai_compat":
            continue
        connection_name = _required(raw.get("connection"), "backends.%s.connection" % name, NAME_RE)
        if connection_name not in connections:
            raise TrialError("backend %s names unknown connection %s" % (name, connection_name))
        models = raw.get("models")
        if not isinstance(models, list) or not models:
            raise TrialError("backend %s must declare at least one model" % name)
        models = [_required(model, "backends.%s.models" % name, MODEL_RE) for model in models]
        if len(set(models)) != len(models):
            raise TrialError("backend %s declares a duplicate model" % name)
        seats = raw.get("seats")
        if not isinstance(seats, list) or "reviewer" not in seats:
            continue
        training_org = _required(raw.get("trainingOrg"), "backends.%s.trainingOrg" % name, ORG_RE)
        auth = raw.get("auth")
        if not isinstance(auth, dict) or auth.get("kind") not in ("none", "env"):
            raise TrialError("backend %s auth must be kind none|env" % name)
        key_env = None
        if auth["kind"] == "env":
            key_env = _required(auth.get("envVar"), "backends.%s.auth.envVar" % name, ENV_RE)
        provider = _required(raw.get("provider") or name, "backends.%s.provider" % name, NAME_RE)
        model_family = _required(
            raw.get("modelFamily") or "unknown", "backends.%s.modelFamily" % name, NAME_RE,
        )
        operator = _required(
            raw.get("inferenceOperator") or provider,
            "backends.%s.inferenceOperator" % name, NAME_RE,
        )
        profiles[name] = {
            "name": name,
            "provider": provider,
            "training_org": training_org,
            "model_family": model_family,
            "operator": operator,
            "models": models,
            "auth": auth["kind"],
            "key_env": key_env,
            "connection": connections[connection_name],
        }
    return profiles


def resolve_profile(backend, model, env=None):
    profiles = load_profiles(env)
    profile = profiles.get(backend)
    if profile is None:
        raise TrialError("unknown reviewer profile %r; run `camus models`" % backend)
    if model not in profile["models"]:
        raise TrialError("model %r is not declared by reviewer profile %r" % (model, backend))
    if profile["auth"] == "env" and not (env or os.environ).get(profile["key_env"]):
        raise TrialError(
            "credential environment variable %s is not set (the key belongs in the shell, never models.json)"
            % profile["key_env"]
        )
    return profile


def list_profiles(env=None):
    env = os.environ if env is None else env
    rows = []
    for profile in load_profiles(env).values():
        credential = "not_required" if profile["auth"] == "none" \
            else "set" if env.get(profile["key_env"]) else "missing"
        for model in profile["models"]:
            rows.append({
                "backend": profile["name"], "model": model,
                "provider": profile["provider"], "trainingOrg": profile["training_org"],
                "transport": profile["connection"]["kind"],
                "connection": profile["connection"]["name"],
                "credential": credential,
                "standing": "experimental_shadow",
                "finalGate": "codex",
            })
    return rows


def _allocate_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _ssh_args(connection, local_port, config=False):
    remote = "[%s]" % connection["remote_address"] if connection["remote_address"] == "::1" \
        else connection["remote_address"]
    forward = "127.0.0.1:%d:%s:%d" % (local_port, remote, connection["remote_port"])
    args = list(HARDENING) + ["-L", forward]
    if config:
        args.append("-G")
    args += ["--", connection["ssh_alias"]]
    return args


def _screen_ssh_config(raw, local_port, connection):
    lines = [line.strip() for line in str(raw or "").splitlines() if line.strip()]
    if not lines:
        raise TrialError("ssh -G returned no effective configuration")
    values = {}
    local = []
    for line in lines:
        key, _, value = line.partition(" ")
        key = key.lower()
        values[key] = value.strip()
        if key == "localforward":
            local.append(value.lower())
        if key in ("remoteforward", "dynamicforward"):
            raise TrialError("SSH profile enables %s; trial tunnels are local-forward-only" % key)
    if not values.get("hostname"):
        raise TrialError("ssh -G did not resolve a hostname")
    def endpoint(token):
        value = token.replace("[", "").replace("]", "")
        split = value.rfind(":")
        if split <= 0:
            return None
        try:
            port = int(value[split + 1:])
        except ValueError:
            return None
        return value[:split].lower(), port

    exact_forward = False
    if len(local) == 1:
        tokens = local[0].split()
        if len(tokens) == 2:
            bind = endpoint(tokens[0])
            destination = endpoint(tokens[1])
            exact_forward = (
                bind == ("127.0.0.1", local_port)
                and destination == (
                    connection["remote_address"].lower(), connection["remote_port"],
                )
            )
    if not exact_forward:
        raise TrialError("SSH profile contains an unexpected LocalForward")
    refused_yes = ("permitlocalcommand", "forwardagent", "forwardx11", "clearallforwardings")
    if any(values.get(key, "").lower() == "yes" for key in refused_yes):
        raise TrialError("SSH profile enables a refused execution or forwarding directive")
    if values.get("controlmaster", "no").lower() not in ("no", "false", "off", "none"):
        raise TrialError("SSH profile enables ControlMaster; use a dedicated non-multiplexed alias")
    if values.get("tunnel", "no").lower() not in ("no", "false", "off", "none"):
        raise TrialError("SSH profile enables a tun device")


@contextlib.contextmanager
def _endpoint(profile):
    connection = profile["connection"]
    if connection["kind"] != "ssh_tunnel":
        yield {"base_url": connection["base_url"], "tunnel_pid": None, "tunnel_started": None}
        return
    local_port = _allocate_port()
    try:
        checked = subprocess.run(
            ["ssh"] + _ssh_args(connection, local_port, config=True),
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise TrialError("OpenSSH configuration preflight could not run")
    if checked.returncode != 0:
        raise TrialError("OpenSSH configuration preflight refused the named alias")
    _screen_ssh_config(checked.stdout, local_port, connection)
    directory = os.path.join(os.path.expanduser("~"), ".camus", "trial-tunnels")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    fd, diagnostics = tempfile.mkstemp(dir=directory, prefix="ssh-", suffix=".log")
    os.fchmod(fd, 0o600)
    log = os.fdopen(fd, "wb", buffering=0)
    started = int(time.time())
    try:
        proc = subprocess.Popen(
            ["ssh"] + _ssh_args(connection, local_port),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
            start_new_session=True,
        )
    except OSError:
        log.close()
        raise TrialError("OpenSSH tunnel could not start")
    try:
        deadline = time.monotonic() + 10
        ready = False
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", local_port), timeout=0.25):
                    ready = True
                    break
            except OSError:
                time.sleep(0.1)
        if not ready or not review_watch._is_ours(proc.pid, started):
            raise TrialError("managed SSH tunnel did not establish a bound local forward")
        yield {
            "base_url": "http://127.0.0.1:%d%s" % (local_port, connection["base_path"]),
            "tunnel_pid": proc.pid, "tunnel_started": started,
        }
    finally:
        if review_watch._group_is_ours(proc.pid, started):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            if review_watch._group_is_ours(proc.pid, started):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
        log.close()
        # Raw SSH output is useful only for local operator debugging and may name hosts.
        # Keep it private, but remove empty successful logs to minimize retained data.
        try:
            if os.path.getsize(diagnostics) == 0:
                os.unlink(diagnostics)
        except OSError:
            pass


def admitted_runtime(profile):
    """Return the same managed endpoint custody used by trials, for an admitted gate run."""
    return _endpoint(profile)


def _atomic_request(review_dir, worktree, record):
    os.makedirs(review_dir, mode=0o700, exist_ok=True)
    os.chmod(review_dir, 0o700)
    path = os.path.join(review_dir, os.path.basename(worktree) + "-request.json")
    fd, temporary = tempfile.mkstemp(dir=review_dir, prefix=".request-", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return path


def _json_command(args, cwd, env, timeout):
    try:
        result = subprocess.run(
            args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise TrialError("shadow reviewer process failed (%s)" % exc.__class__.__name__)
    try:
        value = json.loads((result.stdout or "").strip())
    except ValueError:
        raise TrialError("shadow reviewer returned an unreadable envelope")
    if not isinstance(value, dict):
        raise TrialError("shadow reviewer returned a non-object envelope")
    return value


def _private_receipt(path, limit=4 * 1024 * 1024):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise TrialError("shadow review completed without an accessible durable receipt")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise TrialError("shadow review durable receipt is not a private regular file")
        content = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(content) > limit:
        raise TrialError("shadow review durable receipt exceeds its bounded size")
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise TrialError("shadow review completed without a readable durable receipt")
    if not isinstance(value, dict):
        raise TrialError("shadow review durable receipt must be a JSON object")
    return value, content


def _safe_segment(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))[:80]


def _review_directory(home, backend, model, worktree):
    canonical = os.path.realpath(worktree)
    identity = hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return os.path.join(
        home, "trial-reviews", _safe_segment(backend), _safe_segment(model),
        "%s-%s" % (_safe_segment(os.path.basename(canonical)), identity),
    )


def run_review(backend, model, worktree, task, round_no=1, effort="medium",
               repo=None, nonce=None, env=None):
    """Run one exact-profile shadow review and return normalized, non-gating evidence."""
    env = dict(os.environ if env is None else env)
    if effort not in EFFORTS:
        raise TrialError("shadow review effort must be one of %s" % "|".join(EFFORTS))
    if isinstance(round_no, bool) or not isinstance(round_no, int) or round_no < 1:
        raise TrialError("shadow review round must be a positive integer")
    profile = resolve_profile(backend, model, env)
    worktree = os.path.realpath(worktree)
    repo = os.path.realpath(repo or env.get("CAMUS_REPO_ROOT") or worktree)
    nonce = nonce or "trial:%s:%s:%d" % (backend, model, round_no)
    review_dir = _review_directory(
        env.get("CAMUS_HOME") or os.path.join(os.path.expanduser("~"), ".camus"),
        backend, model, worktree,
    )
    with _endpoint(profile) as endpoint:
        record = review_trial.issue(
            "http_openai_compat", backend, model, profile["training_org"],
            profile["connection"]["kind"], profile["connection"]["name"],
            endpoint["base_url"], profile["auth"], profile["key_env"], env=env,
        )
        qualification = record["trial"]
        request, error = review_request.build_request(
            worktree, round_no, effort=effort, nonce=nonce, model=model,
            backend="http_openai_compat", scope="light", qualification=qualification,
            origin="camus_model_trial", operator=profile["operator"],
            transport=profile["connection"]["kind"],
            connection=profile["connection"]["name"], contract="rc1",
        )
        if error:
            raise TrialError("could not bind shadow review request: %s" % error)
        _atomic_request(review_dir, worktree, request)
        child_env = dict(env)
        child_env.update({
            "CAMUS_REPO_ROOT": repo,
            "CAMUS_REVIEW_DIR": review_dir,
            "CAMUS_REVIEW_BACKEND": "http_openai_compat",
            "CAMUS_REVIEW_ROUND": str(round_no),
            "CAMUS_REVIEW_EFFORT": effort,
            "CAMUS_REVIEW_SCOPE": "light",
            "CAMUS_REVIEW_QUALIFICATION": qualification,
            "CAMUS_GATE_NONCE": nonce,
            "CAMUS_REVIEW_ORIGIN": "camus_model_trial",
            "CAMUS_REVIEW_OPERATOR": profile["operator"],
            "CAMUS_REVIEWER_TRAINING_ORG": profile["training_org"],
            "CAMUS_MAKER_TRAINING_ORG": "anthropic",
            "CAMUS_HTTP_REVIEW_TRIAL": "1",
            "CAMUS_HTTP_REVIEW_PROFILE_BACKEND": backend,
            "CAMUS_HTTP_REVIEW_MODEL": model,
            "CAMUS_HTTP_REVIEW_BASE_URL": endpoint["base_url"],
            "CAMUS_HTTP_REVIEW_AUTH": profile["auth"],
            "CAMUS_HTTP_REVIEW_API_KEY_ENV": profile["key_env"] or "",
            "CAMUS_HTTP_REVIEW_TRANSPORT": profile["connection"]["kind"],
            "CAMUS_HTTP_REVIEW_CONNECTION": profile["connection"]["name"],
            "CAMUS_HTTP_REVIEW_TUNNEL_PID": str(endpoint["tunnel_pid"] or ""),
            "CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT": str(endpoint["tunnel_started"] or ""),
        })
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "http_openai_compat_review.py")
        value = _json_command(
            [sys.executable, script, worktree, task or "", str(round_no), effort, "light"],
            repo, child_env, 60,
        )
        awaits = 0
        while value.get("pending") is True and awaits < 12:
            handle = value.get("handle")
            if not isinstance(handle, str) or not os.path.isabs(handle):
                raise TrialError("shadow reviewer returned an invalid pending handle")
            value = _json_command(
                [sys.executable, script, "await", handle], repo, child_env, 650,
            )
            awaits += 1
        if value.get("pending") is True:
            raise TrialError("shadow reviewer remained pending after bounded reattachment")
        if value.get("ran") is not True:
            return {
                "ran": False, "standing": "experimental_shadow",
                "backend": backend, "model": model, "effort": effort,
                "trainingOrg": profile["training_org"],
                "transport": profile["connection"]["kind"],
                "connection": profile["connection"]["name"],
                "errorCode": value.get("error_code") or "shadow_review_unavailable",
                "error": str(value.get("error") or "shadow review produced no usable verdict")[:500],
            }
        receipt_path = os.path.join(review_dir, "%s-r%d.json" % (os.path.basename(worktree), round_no))
        receipt, receipt_bytes = _private_receipt(receipt_path)
        binding = receipt.get("binding") if isinstance(receipt, dict) else None
        expected = {
            "reviewer_backend": "http_openai_compat", "reviewer_model": model,
            "effort_actual": effort, "round_actual": round_no,
            "qualification": qualification, "standing": "experimental_shadow",
            "connection": profile["connection"]["name"],
            "transport": profile["connection"]["kind"],
        }
        if not isinstance(binding, dict) or binding.get("bound") is not True \
                or any(binding.get(key) != item for key, item in expected.items()):
            raise TrialError("shadow review receipt binding does not match the requested trial")
        input_fingerprint = receipt.get("input_fingerprint")
        if not isinstance(input_fingerprint, str) \
                or not re.fullmatch(r"fp1:[0-9a-f]{64}", input_fingerprint) \
                or binding.get("input_fingerprint") != input_fingerprint:
            raise TrialError("shadow review receipt lacks its exact input fingerprint binding")
        normalized = adapter.normalize_codex(
            json.dumps(receipt.get("codex_parsed"), ensure_ascii=False),
            receipt.get("codex_exit"),
        )
        if normalized.get("ran") is not True:
            raise TrialError("shadow review receipt verdict is not schema-valid")
        return {
            "ran": True, "standing": "experimental_shadow",
            "backend": backend, "executorBackend": "http_openai_compat",
            "model": model, "effort": effort,
            "trainingOrg": profile["training_org"],
            "transport": profile["connection"]["kind"],
            "connection": profile["connection"]["name"],
            "qualification": qualification,
            "inputFingerprint": input_fingerprint,
            "clean": normalized.get("clean") is True,
            "blocking": normalized.get("blocking") or [],
            "nonblocking": normalized.get("nonblocking") or [],
            "receiptPath": os.path.realpath(receipt_path),
            "receiptSha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "usage": value.get("usage") if isinstance(value.get("usage"), dict) else None,
            "finalGate": "codex",
        }


def _parser():
    parser = argparse.ArgumentParser(description="Camus external-model shadow reviewer")
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list", help="list Studio-configured reviewer profiles")
    listing.add_argument("--json", action="store_true")
    review = sub.add_parser("review", help="run one non-gating shadow review")
    review.add_argument("--backend", required=True)
    review.add_argument("--model", required=True)
    review.add_argument("--worktree", default=os.getcwd())
    review.add_argument("--repo", default=None)
    review.add_argument("--task", default="")
    review.add_argument("--round", type=int, default=1)
    review.add_argument("--effort", choices=EFFORTS, default="medium")
    review.add_argument("--nonce", default=None, help=argparse.SUPPRESS)
    return parser


def main(argv=None):
    options = _parser().parse_args(argv)
    try:
        if options.command == "list":
            rows = list_profiles()
            if options.json:
                print(json.dumps({"models": rows}, ensure_ascii=False, indent=2))
            elif not rows:
                print("No configurable reviewer profiles. Add one in Studio Settings.")
            else:
                for row in rows:
                    print("%s:%s · %s · credential %s · shadow → Codex gate" % (
                        row["backend"], row["model"], row["transport"], row["credential"],
                    ))
            return 0
        value = run_review(
            options.backend, options.model, options.worktree, options.task,
            round_no=options.round, effort=options.effort,
            repo=options.repo, nonce=options.nonce,
        )
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get("ran") is True else 2
    except TrialError as exc:
        print(json.dumps({
            "ran": False, "standing": "experimental_shadow", "error": str(exc),
        }, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
