#!/usr/bin/env python3
"""Hermetic dispatcher + HTTP reviewer candidate acceptance tests (stdlib only)."""
import contextlib
import hashlib
import io
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import review_request
import review_qualification
import review_trial
import review_watch
import reviewer_dispatch
import http_openai_compat_review as http_review


def qualification_for(model="qwen-test", transport="loopback", connection="fixture"):
    value = "\x1f".join((model, transport, connection)).encode("utf-8")
    return "qual1:" + hashlib.sha256(value).hexdigest()


def admission_for(model="qwen-test", transport="loopback", connection="fixture"):
    qualification = qualification_for(model, transport, connection)
    return "admit1:" + hashlib.sha256(("admission\0" + qualification).encode("utf-8")).hexdigest()


def run(command, cwd=None, env=None, check=True):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
    if check and result.returncode != 0:
        raise AssertionError("command failed %r\nstdout=%s\nstderr=%s" % (command, result.stdout, result.stderr))
    return result


def git(repo, *args):
    return run(["git", "-C", repo] + list(args)).stdout.strip()


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass

    def do_POST(self):
        fixture = self.server.fixture
        fixture["requests"] += 1
        fixture["authorization"] = self.headers.get("authorization")
        size = int(self.headers.get("content-length", "0"))
        fixture["body"] = json.loads(self.rfile.read(size))
        mode = fixture.get("mode", "clean")
        if mode == "redirect":
            self.send_response(307)
            self.send_header("location", "http://127.0.0.1:%d/redirected" % self.server.server_port)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if mode == "refuse":
            secret = fixture.get("secret", "")
            body = ("denied Authorization: Bearer " + secret).encode()
            self.send_response(401)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        if mode == "delayed_clean":
            self.wfile.flush()
            time.sleep(2)
        if mode in ("slow", "tunnel"):
            first = {"model": fixture["reported_model"], "choices": [{"delta": {"content": "{"}}]}
            self.wfile.write(("data: " + json.dumps(first) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(8)
            return
        if mode == "malformed_event":
            self.wfile.write(b"data: []\n\ndata: [DONE]\n\n")
            self.wfile.flush()
            return
        if mode == "oversized":
            line = b'data: {"model":"qwen-test","choices":[]}\n'
            count = http_review.MAX_RESPONSE_BYTES // len(line) + 2
            try:
                for _ in range(count):
                    self.wfile.write(line)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        verdict = {
            "overall_correctness": "patch is correct",
            "overall_confidence_score": 0.98,
            "overall_explanation": "fixture clean",
            "findings": [],
        }
        if mode == "secret":
            verdict["findings"] = [{
                "priority": 3, "title": "fixture nit", "code_location": "x.py:1",
                "body": "provider echoed " + fixture["secret"], "confidence_score": 0.5,
            }]
        raw = json.dumps(verdict)
        cuts = (raw[: len(raw) // 2], raw[len(raw) // 2 :])
        for part in cuts:
            event = {"choices": [{"delta": {"content": part}}]}
            if mode != "missing_model":
                event["model"] = fixture["reported_model"]
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
        usage = {"model": fixture["reported_model"], "choices": [{"delta": {}}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 5}}
        if mode == "missing_model":
            usage.pop("model")
        if mode == "secret":
            usage["usage"]["provider_debug"] = fixture["secret"]
        self.wfile.write(("data: " + json.dumps(usage) + "\n\ndata: [DONE]\n\n").encode())
        self.wfile.flush()
        if mode == "done_keepalive":
            time.sleep(6)


@contextlib.contextmanager
def fixture_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server.fixture = {"mode": "clean", "reported_model": "qwen-test", "requests": 0}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextlib.contextmanager
def repo_fixture():
    root = tempfile.mkdtemp(prefix="camus-http-review-")
    repo = os.path.join(root, "repo")
    wt = os.path.join(root, "camus-wt-http-task")
    reviews = os.path.join(root, "reviews")
    os.makedirs(repo)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Camus Test")
    with open(os.path.join(repo, "file.txt"), "w", encoding="utf-8") as fh:
        fh.write("base\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "base")
    git(repo, "worktree", "add", "-qb", "camus/test/http-task", wt, "HEAD")
    with open(os.path.join(wt, "file.txt"), "a", encoding="utf-8") as fh:
        fh.write("candidate\n")
    try:
        yield root, repo, wt, reviews
    finally:
        shutil.rmtree(root, ignore_errors=True)


def request_for(reviews, wt, rnd, *, model="qwen-test", transport="loopback", connection="fixture"):
    qualification = qualification_for(model, transport, connection)
    record, error = review_request.build_request(
        wt, rnd, effort="medium", nonce="trace:test", model=model,
        backend="http_openai_compat", scope="light", qualification=qualification,
        origin="camus-test", operator="test-runner", transport=transport,
        connection=connection, contract="rc1", now=1,
    )
    assert error is None
    os.makedirs(reviews, exist_ok=True)
    with open(os.path.join(reviews, os.path.basename(wt) + "-request.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh)


def base_env(repo, reviews, server, rnd, *, transport="loopback", connection="fixture"):
    qualification = qualification_for("qwen-test", transport, connection)
    admission_id = admission_for("qwen-test", transport, connection)
    env = os.environ.copy()
    env.update({
        "CAMUS_REPO_ROOT": repo,
        "CAMUS_REVIEW_DIR": reviews,
        "CAMUS_REVIEW_BACKEND": "http_openai_compat",
        "CAMUS_REVIEW_ROUND": str(rnd),
        "CAMUS_REVIEW_EFFORT": "medium",
        "CAMUS_REVIEW_SCOPE": "light",
        "CAMUS_REVIEW_QUALIFICATION": qualification,
        "CAMUS_REVIEW_ADMISSION_ID": admission_id,
        "CAMUS_GATE_NONCE": "trace:test",
        "CAMUS_REVIEW_ORIGIN": "camus-test",
        "CAMUS_REVIEW_OPERATOR": "test-runner",
        "CAMUS_REVIEWER_TRAINING_ORG": "alibaba",
        "CAMUS_MAKER_TRAINING_ORG": "anthropic",
        "CAMUS_HTTP_REVIEW_PROFILE_BACKEND": "fixture_qwen",
        "CAMUS_HTTP_REVIEW_MODEL": "qwen-test",
        "CAMUS_HTTP_REVIEW_BASE_URL": "http://127.0.0.1:%d/v1" % server.server_port,
        "CAMUS_HTTP_REVIEW_AUTH": "none",
        "CAMUS_HTTP_REVIEW_TRANSPORT": transport,
        "CAMUS_HTTP_REVIEW_CONNECTION": connection,
        "CAMUS_HTTP_REVIEW_START_CHUNK_S": "1",
        "CAMUS_HTTP_REVIEW_AWAIT_CHUNK_S": "1",
        "CAMUS_HTTP_REVIEW_IDLE_S": "5",
        "CAMUS_HTTP_REVIEW_TIMEOUT_S": "15",
        "STUDIO_GRANDFATHER_DIR": os.path.join(os.path.dirname(reviews), "studio"),
        # The candidate must ignore ambient proxies rather than silently changing destination.
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
    })
    os.makedirs(env["STUDIO_GRANDFATHER_DIR"], mode=0o700, exist_ok=True)
    salt_path = os.path.join(env["STUDIO_GRANDFATHER_DIR"], ".machine-salt")
    if not os.path.exists(salt_path):
        with open(salt_path, "w", encoding="ascii") as fh:
            fh.write("11" * 32)
        os.chmod(salt_path, 0o600)
    record = review_qualification.build_record(
        qualification, admission_id, "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
        transport, connection, "none", int(time.time()) + 3600, env,
    )
    record_path = review_qualification.record_path(qualification, env)
    os.makedirs(os.path.dirname(record_path), mode=0o700, exist_ok=True)
    with open(record_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh)
    os.chmod(record_path, 0o600)
    return env


def call_http(wt, repo, env, rnd, scope="light"):
    command = [sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
               wt, "fixture task", str(rnd), "medium", scope]
    result = run(command, cwd=repo, env=env)
    value = json.loads(result.stdout)
    for _ in range(20):
        if not value.get("pending"):
            return value
        result = run([sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                      "await", value["handle"]], cwd=repo, env=env)
        value = json.loads(result.stdout)
    raise AssertionError("HTTP reviewer stayed pending")


def test_dispatch():
    assert reviewer_dispatch._infra("review_control_inconclusive", "fixture")["cause"] == "control_inconclusive"
    decision, missing = reviewer_dispatch.decide("codex", {})
    assert decision is None and missing["error_code"] == "maker_origin_invalid"
    decision, error = reviewer_dispatch.decide("codex", {"CAMUS_MAKER_TRAINING_ORG": "anthropic"})
    assert decision["admitted"] is True and error is None
    for backend, org in (("qwen_code", "alibaba"), ("grok_cli", "xai")):
        decision, error = reviewer_dispatch.decide(backend, {"CAMUS_MAKER_TRAINING_ORG": "anthropic"})
        assert decision is None and error["error_code"] == "reviewer_benchmark_disabled"
        assert error["reviewer_training_org"] == org
    _, same = reviewer_dispatch.decide("grok_cli", {"CAMUS_MAKER_TRAINING_ORG": "xai"})
    assert same["error_code"] == "reviewer_same_origin"
    _, conflict = reviewer_dispatch.decide("codex", {
        "CAMUS_MAKER_TRAINING_ORG": "anthropic", "CAMUS_REVIEWER_TRAINING_ORG": "xai",
    })
    assert conflict["error_code"] == "reviewer_origin_conflict"
    _, disabled_http = reviewer_dispatch.decide("http_openai_compat", {
        "CAMUS_MAKER_TRAINING_ORG": "anthropic",
        "CAMUS_REVIEWER_TRAINING_ORG": "xai",
    })
    assert disabled_http["error_code"] == "reviewer_benchmark_disabled"
    assert disabled_http["reviewer_training_org"] is None
    for unknown in ("CODEX", "codex-extra", " codex", "grok_cli.sh"):
        _, error = reviewer_dispatch.decide(unknown, {"CAMUS_MAKER_TRAINING_ORG": "anthropic"})
        assert error["error_code"] == "reviewer_backend_unknown"
    # Even if candidate CLIs are present on PATH, naming one cannot cross the benchmark gate.
    with tempfile.TemporaryDirectory(prefix="camus-fake-review-cli-") as fake:
        marker = os.path.join(fake, "executed")
        for name in ("qwen", "grok"):
            path = os.path.join(fake, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\nprintf ran > %s\n" % marker)
            os.chmod(path, 0o755)
        env = os.environ.copy()
        env.update({
            "PATH": fake + os.pathsep + env.get("PATH", ""),
            "CAMUS_REVIEWER": "qwen_code",
            "CAMUS_MAKER_TRAINING_ORG": "anthropic",
        })
        result = run(["bash", os.path.join(HERE, "review.sh"), "ignored", "task", "1"], env=env)
        assert json.loads(result.stdout)["error_code"] == "reviewer_benchmark_disabled"
        assert not os.path.exists(marker)

    prior_exec = reviewer_dispatch.os.execvpe
    prior_reviewer = os.environ.get("CAMUS_REVIEWER")
    prior_maker = os.environ.get("CAMUS_MAKER_TRAINING_ORG")
    try:
        reviewer_dispatch.os.execvpe = lambda *_args: (_ for _ in ()).throw(FileNotFoundError())
        os.environ["CAMUS_REVIEWER"] = "codex"
        os.environ["CAMUS_MAKER_TRAINING_ORG"] = "anthropic"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            assert reviewer_dispatch.main([]) == 0
        assert json.loads(stdout.getvalue())["error_code"] == "reviewer_exec_failed"
    finally:
        reviewer_dispatch.os.execvpe = prior_exec
        if prior_reviewer is None:
            os.environ.pop("CAMUS_REVIEWER", None)
        else:
            os.environ["CAMUS_REVIEWER"] = prior_reviewer
        if prior_maker is None:
            os.environ.pop("CAMUS_MAKER_TRAINING_ORG", None)
        else:
            os.environ["CAMUS_MAKER_TRAINING_ORG"] = prior_maker


def test_http_clean_replay_and_secret_hygiene():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        clean = call_http(wt, repo, env, 1)
        assert clean["ran"] is True and clean["clean"] is True
        binding = dict(clean["binding"])
        assert binding.pop("standing") == "admitted_gate"
        assert binding.pop("admission_id") == env["CAMUS_REVIEW_ADMISSION_ID"]
        assert re.fullmatch(r"fp1:[0-9a-f]{64}", binding.pop("input_fingerprint"))
        assert binding == {
            "round": 1, "effort": "medium", "model": "qwen-test",
            "backend": "http_openai_compat", "worktree": os.path.realpath(wt),
            "nonce": "trace:test", "round_requested": 1, "effort_requested": "medium",
            "contract": "rc1", "scope": "light",
            "qualification": qualification_for(),
            "origin": "camus-test", "operator": "test-runner",
            "transport": "loopback", "connection": "fixture",
        }
        assert server.fixture["authorization"] is None
        assert server.fixture["body"]["stream"] is True
        assert server.fixture["body"]["response_format"]["type"] == "json_schema"
        audit_path = os.path.join(reviews, os.path.basename(wt) + "-r1.json")
        with open(audit_path, "rb") as fh:
            audit_before = fh.read()
        before = server.fixture["requests"]
        replay = call_http(wt, repo, env, 1)
        assert replay["ran"] is True and server.fixture["requests"] == before
        with open(audit_path, "rb") as fh:
            assert fh.read() == audit_before, "replay rewrote the sealed audit receipt"
        drifted_env = dict(env, CAMUS_HTTP_REVIEW_BASE_URL="http://127.0.0.1:%d/v2" % server.server_port)
        drifted = call_http(wt, repo, drifted_env, 1)
        assert drifted["ran"] is False and drifted["error_code"] == "http_review_replay_drift"
        assert server.fixture["requests"] == before, "runtime drift was replayed or sent to a new endpoint"

        # A planted credential may be used from env, but no artifact or emitted verdict retains it.
        # Deliberately shorter than the generic credential-shape regex: exact-value redaction
        # must protect every non-empty env credential, not only realistic long API keys.
        secret = "Z9Q"
        server.fixture.update({"mode": "secret", "secret": secret})
        request_for(reviews, wt, 2)
        env = base_env(repo, reviews, server, 2)
        env.update({"CAMUS_HTTP_REVIEW_AUTH": "env", "CAMUS_HTTP_REVIEW_API_KEY_ENV": "FIXTURE_REVIEW_KEY",
                    "FIXTURE_REVIEW_KEY": secret})
        salt_path = os.path.join(env["STUDIO_GRANDFATHER_DIR"], ".machine-salt")
        os.unlink(salt_path)
        missing_salt = call_http(wt, repo, env, 2)
        assert missing_salt["ran"] is False and missing_salt["error_code"] == "http_review_configuration"
        assert server.fixture["requests"] == before, "env auth ran without its qualification machine salt"
        with open(salt_path, "w", encoding="ascii") as fh:
            fh.write("11" * 32)
        os.chmod(salt_path, 0o600)
        assert http_review._credential_revision("env", "FIXTURE_REVIEW_KEY", env) == "add3afc20a075a75"
        credential_record = review_qualification.build_record(
            qualification_for(), admission_for(), "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "loopback", "fixture", "add3afc20a075a75", int(time.time()) + 3600, env,
        )
        with open(review_qualification.record_path(qualification_for(), env), "w", encoding="utf-8") as fh:
            json.dump(credential_record, fh)
        os.chmod(review_qualification.record_path(qualification_for(), env), 0o600)
        result = call_http(wt, repo, env, 2)
        assert result["ran"] is True and secret not in json.dumps(result)
        assert server.fixture["authorization"] == "Bearer " + secret
        credential_requests = server.fixture["requests"]
        rotated = call_http(wt, repo, dict(env, FIXTURE_REVIEW_KEY="ROTATED"), 2)
        assert rotated["ran"] is False and rotated["error_code"] == "http_review_configuration"
        assert server.fixture["requests"] == credential_requests, "credential rotation replayed the prior account's verdict"
        for dirpath, _dirs, files in os.walk(reviews):
            for name in files:
                with open(os.path.join(dirpath, name), "rb") as fh:
                    assert secret.encode() not in fh.read(), "%s persisted the planted credential" % name


def test_http_admitted_gate_seals_the_exact_human_admission_id():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        admission_id = env["CAMUS_REVIEW_ADMISSION_ID"]
        result = call_http(wt, repo, env, 1)
        assert result["ran"] is True and result["standing"] == "admitted_gate"
        assert result["admission_id"] == admission_id
        assert result["binding"]["admission_id"] == admission_id
        with open(os.path.join(reviews, os.path.basename(wt) + "-r1.json"), encoding="utf-8") as fh:
            audit = json.load(fh)
        assert audit["admission_id"] == admission_id
        assert audit["binding"]["admission_id"] == admission_id
        before = server.fixture["requests"]
        request_for(reviews, wt, 2)
        forged = base_env(repo, reviews, server, 2)
        forged["CAMUS_REVIEW_ADMISSION_ID"] = "admit1:" + "f" * 64
        refused = call_http(wt, repo, forged, 2)
        assert refused["ran"] is False and refused["error_code"] == "http_review_configuration"
        assert "admission_id" in refused["error"]
        assert server.fixture["requests"] == before
        request_for(reviews, wt, 3)
        missing = base_env(repo, reviews, server, 3)
        missing.pop("CAMUS_REVIEW_ADMISSION_ID")
        refused = call_http(wt, repo, missing, 3)
        assert refused["ran"] is False and refused["error_code"] == "http_review_configuration"
        assert "admission id" in refused["error"]
        assert server.fixture["requests"] == before


def test_http_trial_is_signed_explicit_and_never_dispatch_admitted():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        env = base_env(repo, reviews, server, 1)
        env.update({
            "CAMUS_HTTP_REVIEW_TRIAL": "1",
            "CAMUS_HTTP_REVIEW_PROFILE_BACKEND": "fixture_qwen",
            "CAMUS_REVIEW_ORIGIN": "camus_model_trial",
            "CAMUS_REVIEW_OPERATOR": "fixture",
        })
        env.pop("CAMUS_REVIEW_ADMISSION_ID")
        trial = review_trial.issue(
            "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "loopback", "fixture", env["CAMUS_HTTP_REVIEW_BASE_URL"],
            "none", None, env=env, ttl_seconds=3600,
        )["trial"]
        env["CAMUS_REVIEW_QUALIFICATION"] = trial
        record, error = review_request.build_request(
            wt, 1, effort="medium", nonce="trace:test", model="qwen-test",
            backend="http_openai_compat", scope="light", qualification=trial,
            origin="camus_model_trial", operator="fixture", transport="loopback",
            connection="fixture", contract="rc1", now=1,
        )
        assert error is None
        os.makedirs(reviews, exist_ok=True)
        with open(os.path.join(reviews, os.path.basename(wt) + "-request.json"), "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        result = call_http(wt, repo, env, 1)
        assert result["ran"] is True and result["clean"] is True, result
        assert result["standing"] == "experimental_shadow"
        assert result["binding"]["qualification"] == trial
        assert result["binding"]["standing"] == "experimental_shadow"
        decision, refused = reviewer_dispatch.decide("http_openai_compat", env)
        assert decision is None and refused["error_code"] == "reviewer_benchmark_disabled"

        # The endpoint/profile tuple is part of the HMAC-bound trial identity.
        try:
            review_trial.accepted_training_org(
                trial, "http_openai_compat", "other_profile", "qwen-test",
                "loopback", "fixture", env["CAMUS_HTTP_REVIEW_BASE_URL"],
                "none", None, env,
            )
        except ValueError as exc:
            assert "review trial" in str(exc)
        else:
            raise AssertionError("trial authority survived profile drift")


def test_http_refusals_and_tunnel_death():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        same_env = dict(env, CAMUS_MAKER_TRAINING_ORG="alibaba")
        same = call_http(wt, repo, same_env, 1)
        assert same["ran"] is False and "share training organization" in same["error"]
        assert server.fixture["requests"] == 0
        full = call_http(wt, repo, env, 1, scope="full")
        assert full["ran"] is False and full["error_code"] == "http_review_configuration"
        assert server.fixture["requests"] == 0

        forged_origin = call_http(wt, repo, dict(env, CAMUS_REVIEWER_TRAINING_ORG="xai"), 1)
        assert forged_origin["ran"] is False and forged_origin["error_code"] == "http_review_configuration"
        assert server.fixture["requests"] == 0

        qualification_path = review_qualification.record_path(qualification_for(), env)
        with open(qualification_path, encoding="utf-8") as fh:
            qualification_record = json.load(fh)
        qualification_record["training_org"] = "anthropic"
        with open(qualification_path, "w", encoding="utf-8") as fh:
            json.dump(qualification_record, fh)
        os.chmod(qualification_path, 0o600)
        forged_record = call_http(wt, repo, env, 1)
        assert forged_record["ran"] is False and "HMAC does not verify" in forged_record["error"]
        assert server.fixture["requests"] == 0
        qualification_record = review_qualification.build_record(
            qualification_for(), admission_for(), "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "loopback", "fixture", "none", int(time.time()) + 3600, env,
        )
        with open(qualification_path, "w", encoding="utf-8") as fh:
            json.dump(qualification_record, fh)
        os.chmod(qualification_path, 0o600)

        expired_record = review_qualification.build_record(
            qualification_for(), admission_for(), "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "loopback", "fixture", "none", int(time.time()) - 1, env,
        )
        with open(qualification_path, "w", encoding="utf-8") as fh:
            json.dump(expired_record, fh)
        os.chmod(qualification_path, 0o600)
        expired = call_http(wt, repo, env, 1)
        assert expired["ran"] is False and "has expired" in expired["error"]
        assert server.fixture["requests"] == 0
        qualification_record = review_qualification.build_record(
            qualification_for(), admission_for(), "http_openai_compat", "fixture_qwen", "qwen-test", "alibaba",
            "loopback", "fixture", "none", int(time.time()) + 3600, env,
        )
        with open(qualification_path, "w", encoding="utf-8") as fh:
            json.dump(qualification_record, fh)
        os.chmod(qualification_path, 0o600)

        bare_qualification = dict(env, CAMUS_REVIEW_QUALIFICATION="qual1")
        bare = call_http(wt, repo, bare_qualification, 1)
        assert bare["ran"] is False and bare["error_code"] == "http_review_configuration"
        assert server.fixture["requests"] == 0

        server.fixture["reported_model"] = "substituted-model"
        request_for(reviews, wt, 2)
        env = base_env(repo, reviews, server, 2)
        mismatch = call_http(wt, repo, env, 2)
        assert mismatch["ran"] is False and mismatch["error_code"] == "model_identity_mismatch"

        server.fixture.update({"mode": "missing_model", "reported_model": "qwen-test"})
        request_for(reviews, wt, 3)
        env = base_env(repo, reviews, server, 3)
        missing_model = call_http(wt, repo, env, 3)
        assert missing_model["ran"] is False and missing_model["error_code"] == "model_identity_unproven"

        server.fixture["mode"] = "malformed_event"
        request_for(reviews, wt, 4)
        env = base_env(repo, reviews, server, 4)
        malformed = call_http(wt, repo, env, 4)
        assert malformed["ran"] is False and malformed["error_code"] == "stream_malformed"

        server.fixture.update({"mode": "tunnel", "reported_model": "qwen-test"})
        request_for(reviews, wt, 5, transport="ssh_tunnel", connection="gpu-fixture")
        env = base_env(repo, reviews, server, 5, transport="ssh_tunnel", connection="gpu-fixture")
        tunnel = subprocess.Popen(["sleep", "60"])
        try:
            started_at = review_watch._proc_start_epoch(tunnel.pid)
            assert started_at is not None
            env["CAMUS_HTTP_REVIEW_TUNNEL_PID"] = str(tunnel.pid)
            env["CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT"] = str(started_at)
            command = [sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                       wt, "fixture task", "5", "medium", "light"]
            first = json.loads(run(command, cwd=repo, env=env).stdout)
            assert first.get("pending") is True
            tunnel.terminate()
            tunnel.wait(timeout=5)
            final = json.loads(run([sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                                    "await", first["handle"]], cwd=repo, env=env).stdout)
            for _ in range(10):
                if not final.get("pending"):
                    break
                final = json.loads(run([sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                                        "await", first["handle"]], cwd=repo, env=env).stdout)
            assert final["ran"] is False and final["error_code"] == "tunnel_died", final
            assert server.fixture["requests"] == 4, "three refusal requests + one tunnel request; no fallback"
            artifacts = b""
            for dirpath, _dirs, files in os.walk(reviews):
                for name in files:
                    with open(os.path.join(dirpath, name), "rb") as fh:
                        artifacts += fh.read()
            assert str(server.server_port).encode() not in artifacts, "resolved tunnel port persisted"
        finally:
            if tunnel.poll() is None:
                tunnel.terminate()
                tunnel.wait(timeout=5)

        request_for(reviews, wt, 6, transport="ssh_tunnel", connection="gpu-fixture")
        env = base_env(repo, reviews, server, 6, transport="ssh_tunnel", connection="gpu-fixture")
        dead_tunnel = subprocess.Popen(["sleep", "60"])
        dead_started_at = review_watch._proc_start_epoch(dead_tunnel.pid)
        assert dead_started_at is not None
        dead_tunnel.terminate()
        dead_tunnel.wait(timeout=5)
        env["CAMUS_HTTP_REVIEW_TUNNEL_PID"] = str(dead_tunnel.pid)
        env["CAMUS_HTTP_REVIEW_TUNNEL_STARTED_AT"] = str(dead_started_at)
        dead = call_http(wt, repo, env, 6)
        assert dead["ran"] is False and dead["error_code"] == "tunnel_died", dead
        assert server.fixture["requests"] == 4, "startup tunnel death attempted direct fallback"


def test_http_failed_attempt_is_preserved_and_retryable():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture.update({"mode": "refuse", "secret": "Z9Q"})
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        first = call_http(wt, repo, env, 1)
        assert first["ran"] is False and first["error_code"] == "provider_refused"
        server.fixture.update({"mode": "clean", "reported_model": "qwen-test"})
        second = call_http(wt, repo, env, 1)
        assert second["ran"] is True and second["clean"] is True
        watch = os.path.join(reviews, os.path.basename(wt) + "-r1.watch")
        attempt = os.path.join(watch, "a1")
        assert os.path.isfile(os.path.join(attempt, "failure.json"))
        assert os.path.isfile(os.path.join(attempt, "audit.json"))
        assert server.fixture["requests"] == 2, "retry did not issue exactly one fresh request"


def test_http_concurrent_retry_starts_one_request():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture["mode"] = "refuse"
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        failed = call_http(wt, repo, env, 1)
        assert failed["ran"] is False

        server.fixture.update({"mode": "slow", "reported_model": "qwen-test"})
        command = [sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                   wt, "fixture task", "1", "medium", "light"]
        callers = [subprocess.Popen(command, cwd=repo, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True) for _ in range(2)]
        values = []
        for caller in callers:
            stdout, stderr = caller.communicate(timeout=10)
            assert caller.returncode == 0, stderr
            values.append(json.loads(stdout))
        assert all(value.get("pending") is True for value in values), values
        assert server.fixture["requests"] == 2, "concurrent retry spawned duplicate paid requests"
        assert values[0]["handle"] == values[1]["handle"]
        aborted = json.loads(run([
            sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
            "abort", values[0]["handle"],
        ], cwd=repo, env=env).stdout)
        assert aborted["ran"] is False and aborted["error_code"] == "review_aborted"


def test_http_connect_timeout_does_not_cap_sse_stream():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture["mode"] = "delayed_clean"
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        env.update({"CAMUS_HTTP_REVIEW_CONNECT_S": "1", "CAMUS_HTTP_REVIEW_IDLE_S": "5"})
        clean = call_http(wt, repo, env, 1)
        assert clean["ran"] is True and clean["clean"] is True, clean
        assert server.fixture["requests"] == 1


def test_http_fast_producer_is_bounded():
    assert http_review.MESSAGE_QUEUE_DEPTH == 64
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture["mode"] = "oversized"
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        result = call_http(wt, repo, env, 1)
        assert result["ran"] is False and result["error_code"] == "response_too_large", result


def test_http_done_terminates_persistent_stream():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture["mode"] = "done_keepalive"
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        env["CAMUS_HTTP_REVIEW_IDLE_S"] = "3"
        started = time.monotonic()
        result = call_http(wt, repo, env, 1)
        elapsed = time.monotonic() - started
        assert result["ran"] is True and result["clean"] is True, result
        assert elapsed < 3, "[DONE] was ignored until the persistent stream's idle deadline"


def test_http_default_await_budget_covers_hard_timeout():
    expected = {300: 50, 600: 100, 900: 150, 1200: 200}
    for hard_timeout, chunk in expected.items():
        actual = http_review._default_await_chunk(hard_timeout)
        assert actual == chunk
        # The initial start chunk is extra; six reattachments alone cover the sealed budget.
        assert actual * http_review.WORKFLOW_AWAIT_CAP >= hard_timeout


def test_http_process_group_cancellation():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture.update({"mode": "slow", "reported_model": "qwen-test"})
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        env["CAMUS_HTTP_REVIEW_IDLE_S"] = "20"
        command = [sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                   wt, "fixture task", "1", "medium", "light"]
        first = json.loads(run(command, cwd=repo, env=env).stdout)
        assert first.get("pending") is True
        handle = json.load(open(os.path.join(first["handle"], "handle.json"), encoding="utf-8"))
        aborted = json.loads(run([sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                                  "abort", first["handle"]], cwd=repo, env=env).stdout)
        assert aborted["ran"] is False and aborted["error_code"] == "review_aborted"
        time.sleep(0.1)
        assert not review_watch._group_alive(handle["pid"]), "abort left the reviewer process group alive"


def test_http_unverifiable_handle_never_duplicates_a_live_request():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture.update({"mode": "slow", "reported_model": "qwen-test"})
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        env["CAMUS_HTTP_REVIEW_IDLE_S"] = "20"
        command = [sys.executable, os.path.join(HERE, "http_openai_compat_review.py"),
                   wt, "fixture task", "1", "medium", "light"]
        first = json.loads(run(command, cwd=repo, env=env).stdout)
        assert first.get("pending") is True
        handle_path = os.path.join(first["handle"], "handle.json")
        with open(handle_path, encoding="utf-8") as fh:
            handle = json.load(fh)
        try:
            with open(handle_path, "w", encoding="utf-8") as fh:
                fh.write("not-json")
            refused = json.loads(run(command, cwd=repo, env=env).stdout)
            assert refused["ran"] is False and refused["error_code"] == "review_watchdog_error"
            assert server.fixture["requests"] == 1, "unverifiable custody spawned a duplicate request"
        finally:
            review_watch._kill_group(handle["pid"])


def test_http_redirect_is_not_a_fallback():
    with repo_fixture() as (_root, repo, wt, reviews), fixture_server() as server:
        server.fixture["mode"] = "redirect"
        request_for(reviews, wt, 1)
        env = base_env(repo, reviews, server, 1)
        result = call_http(wt, repo, env, 1)
        assert result["ran"] is False and result["error_code"] == "provider_http_error", result
        assert server.fixture["requests"] == 1, "HTTP redirect caused an undeclared second hop"


def test_direct_https_url_boundary():
    good = "https://api.example.com/v1"
    assert http_review._safe_url(good, "direct_https") == good
    for bad in (
        "https://127.0.0.1/v1", "https://10.0.0.1/v1", "https://metadata.google.internal/v1",
        "https://model.local/v1", "https://singlelabel/v1", "http://api.example.com/v1",
    ):
        try:
            http_review._safe_url(bad, "direct_https")
        except ValueError:
            pass
        else:
            raise AssertionError("direct_https accepted unsafe URL %r" % bad)

    original_getaddrinfo = http_review.socket.getaddrinfo
    original_create_connection = http_review.socket.create_connection
    try:
        public = [
            (http_review.socket.AF_INET, http_review.socket.SOCK_STREAM,
             http_review.socket.IPPROTO_TCP, "", ("93.184.216.34", 443)),
        ]
        http_review.socket.getaddrinfo = lambda *_args, **_kwargs: public
        assert http_review._direct_https_addresses(good) == ("93.184.216.34",)

        mixed = public + [
            (http_review.socket.AF_INET, http_review.socket.SOCK_STREAM,
             http_review.socket.IPPROTO_TCP, "", ("169.254.169.254", 443)),
        ]
        http_review.socket.getaddrinfo = lambda *_args, **_kwargs: mixed
        try:
            http_review._direct_https_addresses(good)
        except ValueError as exc:
            assert "non-public" in str(exc)
        else:
            raise AssertionError("direct_https accepted a mixed public/metadata DNS answer")

        observed = {}

        class FakeSocket:
            def close(self):
                observed["closed"] = True

        class FakeContext:
            verify_mode = http_review.ssl.CERT_REQUIRED
            check_hostname = True

            def wrap_socket(self, sock, server_hostname=None):
                observed["server_hostname"] = server_hostname
                return sock

        def fake_create_connection(address, timeout, source_address):
            observed.update({"address": address, "timeout": timeout,
                             "source_address": source_address})
            return FakeSocket()

        http_review.socket.create_connection = fake_create_connection
        connection = http_review._PinnedHTTPSConnection(
            "api.example.com", 443, pinned_address="93.184.216.34",
            timeout=7, context=FakeContext(),
        )
        connection.connect()
        assert observed["address"] == ("93.184.216.34", 443)
        assert observed["server_hostname"] == "api.example.com"
    finally:
        http_review.socket.getaddrinfo = original_getaddrinfo
        http_review.socket.create_connection = original_create_connection


def main():
    tests = [test_dispatch, test_http_clean_replay_and_secret_hygiene,
             test_http_admitted_gate_seals_the_exact_human_admission_id,
             test_http_trial_is_signed_explicit_and_never_dispatch_admitted,
             test_http_refusals_and_tunnel_death, test_http_failed_attempt_is_preserved_and_retryable,
             test_http_concurrent_retry_starts_one_request,
             test_http_connect_timeout_does_not_cap_sse_stream,
             test_http_fast_producer_is_bounded,
             test_http_done_terminates_persistent_stream,
             test_http_default_await_budget_covers_hard_timeout,
             test_http_process_group_cancellation, test_http_unverifiable_handle_never_duplicates_a_live_request,
             test_http_redirect_is_not_a_fallback, test_direct_https_url_boundary]
    for test in tests:
        test()
        print("ok - " + test.__name__)
    print("test_reviewer_backends.py: %d passed" % len(tests))


if __name__ == "__main__":
    main()
