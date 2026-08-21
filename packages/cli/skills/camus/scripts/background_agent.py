#!/usr/bin/env python3
"""Claude Code background-session adapter for Camus.

Background sessions are the interactive/subscription-backed Claude Code surface.  They keep a
durable transcript, survive terminal detachment, and expose a small host-readable status API via
``claude agents --json``.  Camus uses that surface as a *hand*: the deterministic kernel still owns
the task worktree, receipts, review, verification, and land.

This module deliberately does not read or print environment variables.  Commands are always argv
lists (never a shell string), and receipts retain only model/session/timing/usage metadata plus a
hash of the transcript -- never its potentially sensitive prose.
"""

import errno
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime


TERMINAL_STATES = {"done", "failed", "stopped"}
SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHORT_ID_RE = re.compile(r"^[0-9a-f]{8}$")
LAUNCH_RE = re.compile(r"backgrounded\s*[·-]\s*([0-9a-f]{8})(?:\s*[·-]\s*([^\r\n]+))?", re.I)
SAFE_ENV_NAMES = (
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "COLORTERM", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "VIRTUAL_ENV",
    "UV_PROJECT_ENVIRONMENT", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME",
)
# Claude may append these session bookkeeping rows after a completed turn. They carry no model
# output or execution evidence, so they are safe to ignore when locating the terminal marker.
POST_TURN_METADATA_TYPES = frozenset({
    "last-prompt", "custom-title", "agent-name", "mode", "permission-mode", "atis-latch",
})


class BackgroundAgentError(Exception):
    pass


def direct_env(parent=None):
    """Default-deny routing/credential env for a Claude account-authenticated maker."""
    parent = os.environ if parent is None else parent
    out = {name: parent[name] for name in SAFE_ENV_NAMES if name in parent}
    # Do not force a provider override here.  Claude Code's account-authenticated CLI can prove
    # the claude.ai subscription only when its own provider selection remains intact; the explicit
    # override made auth status report `authMethod: none` and blocked valid Max-account launches.
    out["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    return out


def _run(argv, cwd, timeout=30, env=None):
    try:
        return subprocess.run(
            argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False, env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackgroundAgentError("could not run %s: %s" % (argv[0], exc))


def project_slug(path):
    return os.path.realpath(path).replace(os.sep, "-")


def transcript_path(cwd, session_id, projects_dir=None):
    """Return the exact top-level Claude transcript for a session, or None.

    Worktree sessions are indexed under the worktree's real path.  Older Claude versions may have
    indexed a linked-worktree session under the main checkout, so the bounded fallback scans only
    top-level project transcripts -- never subagent/workflow trees.
    """
    if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
        return None
    projects_dir = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    direct = os.path.join(projects_dir, project_slug(cwd), session_id + ".jsonl")
    if os.path.isfile(direct):
        return direct
    try:
        projects = os.listdir(projects_dir)
    except OSError:
        return None
    target = session_id + ".jsonl"
    for project in projects:
        candidate = os.path.join(projects_dir, project, target)
        if os.path.isfile(candidate):
            return candidate
    return None


def _int(value):
    try:
        value = int(value)
        return value if value >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _text_blocks(content):
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        block.get("text") for block in content
        if isinstance(block, dict) and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]


def _terminal_turn_evidence(row):
    """Return validated terminal-turn timing from one exact top-level transcript row."""
    if not isinstance(row, dict) or row.get("type") != "system" \
            or row.get("subtype") != "turn_duration":
        return None
    duration = row.get("durationMs")
    timestamp = row.get("timestamp")
    if isinstance(duration, bool) or not isinstance(duration, int) or duration < 0:
        return None
    if not isinstance(timestamp, str) or not timestamp.strip():
        return None
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return {"durationMs": duration, "timestamp": timestamp}


def transcript_has_metadata_only_suffix(path, sealed_hash):
    """Prove the current transcript is a sealed line prefix plus allowlisted metadata rows."""
    if not path or not os.path.isfile(path) or not isinstance(sealed_hash, str):
        return False
    digest = hashlib.sha256()
    prefix_found = False
    try:
        with open(path, "rb") as fh:
            for raw_line in fh:
                if prefix_found:
                    try:
                        row = json.loads(raw_line)
                    except (TypeError, ValueError):
                        return False
                    if not isinstance(row, dict) or row.get("type") not in POST_TURN_METADATA_TYPES:
                        return False
                    continue
                digest.update(raw_line)
                if "sha256:" + digest.hexdigest() == sealed_hash:
                    prefix_found = True
    except OSError:
        return False
    return prefix_found


def transcript_receipt(path, requested_model=None, requested_effort=None):
    """Extract stable metrics and the last assistant text from a Claude transcript.

    The transcript format is an enrichment boundary, not a custody boundary.  Unknown rows and
    shifted usage fields degrade to missing/zero data; they never invent an identity or a green.
    """
    if not path or not os.path.isfile(path):
        return {
            "transcriptPath": None, "transcriptSha256": None, "modelActual": None,
            "usage": None, "toolCalls": None, "lastAssistantText": None,
            "terminalTurnMarker": False, "terminalTurnDurationMs": None,
            "terminalTurnAt": None,
        }
    digest = hashlib.sha256()
    models = []
    usage = {
        "inputTokens": 0,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
        "outputTokens": 0,
    }
    tool_calls = 0
    last_text = None
    last_semantic_row = None
    parse_error = False
    try:
        with open(path, "rb") as raw:
            for chunk in iter(lambda: raw.read(1024 * 1024), b""):
                digest.update(chunk)
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except (TypeError, ValueError):
                    parse_error = True
                    continue
                if not isinstance(row, dict):
                    parse_error = True
                    continue
                if row.get("type") not in POST_TURN_METADATA_TYPES:
                    last_semantic_row = row
                if row.get("type") != "assistant" or not isinstance(row.get("message"), dict):
                    continue
                message = row["message"]
                model = message.get("model")
                if isinstance(model, str) and model and model not in models:
                    models.append(model)
                raw_usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
                usage["inputTokens"] += _int(raw_usage.get("input_tokens"))
                usage["cacheCreationInputTokens"] += _int(raw_usage.get("cache_creation_input_tokens"))
                usage["cacheReadInputTokens"] += _int(raw_usage.get("cache_read_input_tokens"))
                usage["outputTokens"] += _int(raw_usage.get("output_tokens"))
                content = message.get("content")
                if isinstance(content, list):
                    tool_calls += sum(
                        1 for block in content
                        if isinstance(block, dict) and block.get("type") == "tool_use"
                    )
                texts = _text_blocks(content)
                if texts:
                    last_text = "\n".join(texts)
    except OSError:
        return {
            "transcriptPath": None, "transcriptSha256": None, "modelActual": None,
            "usage": None, "toolCalls": None, "lastAssistantText": None,
            "terminalTurnMarker": False, "terminalTurnDurationMs": None,
            "terminalTurnAt": None,
        }
    terminal = None if parse_error else _terminal_turn_evidence(last_semantic_row)
    return {
        "transcriptPath": path,
        "transcriptSha256": "sha256:" + digest.hexdigest(),
        "modelRequested": requested_model,
        "modelActual": models[-1] if models else None,
        "modelsObserved": models,
        "effortRequested": requested_effort,
        "usage": usage,
        "toolCalls": tool_calls,
        "lastAssistantText": last_text,
        "terminalTurnMarker": terminal is not None,
        "terminalTurnDurationMs": terminal.get("durationMs") if terminal else None,
        "terminalTurnAt": terminal.get("timestamp") if terminal else None,
    }


class BackgroundAgentClient:
    def __init__(self, binary="claude", projects_dir=None, clock=None, sleeper=None):
        self.binary = binary
        self.projects_dir = projects_dir
        self.clock = clock or time.time
        self.sleeper = sleeper or time.sleep

    def list(self, cwd):
        result = _run(
            [self.binary, "agents", "--json", "--all", "--cwd", cwd], cwd,
            timeout=30, env=direct_env(),
        )
        if result.returncode != 0:
            raise BackgroundAgentError("claude agents failed: %s" % (result.stderr or result.stdout)[-500:])
        try:
            value = json.loads(result.stdout or "[]")
        except ValueError as exc:
            raise BackgroundAgentError("claude agents returned non-JSON: %s" % exc)
        if not isinstance(value, list):
            raise BackgroundAgentError("claude agents returned a non-list")
        return [item for item in value if isinstance(item, dict)]

    def find(self, cwd, short_id=None, session_id=None, name=None):
        for item in self.list(cwd):
            if short_id and item.get("id") == short_id:
                return item
            if session_id and item.get("sessionId") == session_id:
                return item
            if name and item.get("name") == name:
                return item
        return None

    def auth_status(self, cwd):
        result = _run(
            [self.binary, "auth", "status", "--json"], cwd, timeout=30, env=direct_env(),
        )
        try:
            value = json.loads(result.stdout or "{}")
        except ValueError:
            value = {}
        # Claude returns non-zero when logged out but still emits a useful typed status. Preserve
        # that fact so launch can explain the account-auth requirement instead of an opaque error.
        if not isinstance(value, dict) or "loggedIn" not in value:
            raise BackgroundAgentError("could not prove Claude authentication mode")
        return value

    def launch(self, prompt, cwd, name, model, effort="medium", permission_mode="auto", tools=None):
        if not isinstance(prompt, str) or not prompt.strip():
            raise BackgroundAgentError("background agent prompt is empty")
        if not isinstance(name, str) or not name or len(name) > 120:
            raise BackgroundAgentError("background agent name is invalid")
        auth = self.auth_status(cwd)
        if auth.get("loggedIn") is not True or auth.get("authMethod") != "claude.ai":
            raise BackgroundAgentError(
                "Claude maker requires claude.ai account auth; refusing a possibly metered API route"
            )
        argv = [
            self.binary, "--bg", "--name", name, "--model", model,
            "--effort", effort, "--permission-mode", permission_mode,
            "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
            "--setting-sources", "",
            "--settings", '{"outputStyle":"Concise"}',
        ]
        if tools is not None:
            if not isinstance(tools, str):
                raise BackgroundAgentError("background agent tools must be a string")
            argv.extend(["--tools", tools])
        # --tools is variadic; `--` prevents a positional prompt from being consumed as another
        # tool name (and safely handles prompts beginning with a dash).
        argv.extend(["--", prompt])
        started = int(self.clock() * 1000)
        result = _run(argv, cwd, timeout=60, env=direct_env())
        raw = (result.stdout or "") + "\n" + (result.stderr or "")
        match = LAUNCH_RE.search(raw)
        if result.returncode != 0 or not match:
            raise BackgroundAgentError("claude --bg did not launch: %s" % raw[-1000:])
        short_id = match.group(1).lower()
        session = None
        # The supervisor may publish the row just after the launcher returns.
        for _ in range(20):
            session = self.find(cwd, short_id=short_id) or self.find(cwd, name=name)
            if session:
                break
            self.sleeper(0.1)
        if not session or not isinstance(session.get("sessionId"), str):
            raise BackgroundAgentError("background session launched but was not discoverable")
        return {
            "shortId": short_id,
            "sessionId": session["sessionId"],
            "name": name,
            "cwd": os.path.realpath(cwd),
            "state": session.get("state") or "working",
            "startedAt": session.get("startedAt") if isinstance(session.get("startedAt"), int) else started,
            "modelRequested": model,
            "effortRequested": effort,
            "billingMode": "claude_ai_account_quota",
            "surface": "claude_background_session",
        }

    def wait(self, session, timeout_seconds=14400, poll_seconds=5, on_state=None,
             stale_after_seconds=30):
        started = self.clock()
        last_state = None
        while True:
            live = self.find(
                session["cwd"], short_id=session.get("shortId"),
                session_id=session.get("sessionId"), name=session.get("name"),
            )
            if not live:
                now = self.clock()
                # Short controller turns can finish and disappear from `claude agents` between
                # two polls. The exact-session transcript is stronger terminal evidence than the
                # supervisor row: accept only a final semantic turn-duration marker, otherwise
                # preserve the existing fail-closed stale result.
                path = transcript_path(
                    session["cwd"], session.get("sessionId"), projects_dir=self.projects_dir,
                )
                marker_receipt = transcript_receipt(
                    path, requested_model=session.get("modelRequested"),
                    requested_effort=session.get("effortRequested"),
                )
                if marker_receipt.get("terminalTurnMarker") is True:
                    ended = int(now * 1000)
                    session_wall_ms = max(0, ended - int(session.get("startedAt") or ended))
                    marker_receipt.update({
                        **session, "state": "done", "endedAt": ended,
                        "sessionWallMs": session_wall_ms,
                        "durationMs": marker_receipt["terminalTurnDurationMs"],
                    })
                    return marker_receipt
                return {
                    **session, "state": "stale", "endedAt": int(now * 1000),
                    "durationMs": int((now - started) * 1000),
                    "terminalReason": "background session disappeared before a terminal state",
                }
            state = live.get("state") or "unknown"
            if state != last_state and on_state:
                on_state(state, live)
            last_state = state
            if state in TERMINAL_STATES or state == "needs_input":
                ended = int(self.clock() * 1000)
                path = transcript_path(
                    session["cwd"], live.get("sessionId") or session.get("sessionId"),
                    projects_dir=self.projects_dir,
                )
                receipt = transcript_receipt(
                    path, requested_model=session.get("modelRequested"),
                    requested_effort=session.get("effortRequested"),
                )
                session_wall_ms = max(0, ended - int(session.get("startedAt") or ended))
                terminal_duration = receipt.get("terminalTurnDurationMs")
                receipt.update({
                    **session,
                    "state": state,
                    "endedAt": ended,
                    "sessionWallMs": session_wall_ms,
                    "durationMs": terminal_duration if terminal_duration is not None else session_wall_ms,
                })
                return receipt
            # Claude can leave a completed turn published as supervisor `status=idle`/`blocked`
            # while the row's state remains non-terminal. Only a terminal `system/turn_duration`
            # row at the end of this exact session transcript proves completion; prose is not
            # evidence. A controller that deliberately chooses `human` is observed as `blocked`.
            if state in ("working", "blocked"):
                path = transcript_path(
                    session["cwd"], live.get("sessionId") or session.get("sessionId"),
                    projects_dir=self.projects_dir,
                )
                marker_receipt = transcript_receipt(
                    path, requested_model=session.get("modelRequested"),
                    requested_effort=session.get("effortRequested"),
                )
                if marker_receipt.get("terminalTurnMarker") is True:
                    ended = int(self.clock() * 1000)
                    session_wall_ms = max(0, ended - int(session.get("startedAt") or ended))
                    marker_receipt.update({
                        **session, "state": "done", "endedAt": ended,
                        "sessionWallMs": session_wall_ms,
                        "durationMs": marker_receipt["terminalTurnDurationMs"],
                    })
                    return marker_receipt
            # A supervisor row can remain `working` after the child was externally terminated.
            # Detect a dead published PID immediately; otherwise cap an unchanging working row so
            # a stale session cannot consume the normal four-hour agent timeout.
            pid = live.get("pid")
            pid_alive = False
            if isinstance(pid, int) and pid > 0:
                try:
                    os.kill(pid, 0)
                    pid_alive = True
                except OSError as exc:
                    if exc.errno == errno.ESRCH:
                        now = self.clock()
                        return {
                            **session, "state": "stale", "endedAt": int(now * 1000),
                            "durationMs": int((now - started) * 1000),
                            "terminalReason": "background session process is no longer alive",
                        }
                    # EPERM (and other probe errors) means the PID exists but is not
                    # signalable from this process; do not misclassify it as stale.
                    pid_alive = True
            elapsed = self.clock() - started
            if elapsed >= timeout_seconds:
                return {
                    **session, "state": "stale", "durationMs": int(elapsed * 1000),
                    "terminalReason": "background session exceeded its stale-session wait bound",
                }
            if (not pid_alive and stale_after_seconds is not None
                    and elapsed >= stale_after_seconds):
                return {
                    **session, "state": "stale", "durationMs": int(elapsed * 1000),
                    "terminalReason": "background session remained non-terminal past stale-session bound",
                }
            self.sleeper(max(0.1, poll_seconds))


def extract_json_object(text):
    """Extract one JSON object from model prose without accepting trailing object fragments."""
    if not isinstance(text, str):
        return None
    start = text.find("{")
    while start >= 0:
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(text[start:index + 1])
                        return value if isinstance(value, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None
