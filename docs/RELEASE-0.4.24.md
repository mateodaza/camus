# Camus 0.4.24 — bounded SWE command correction

This targeted reliability release updates the shared CLI/Studio SWE runtime.
It changes no model defaults, billing consent, admission or routing policy.

- Malformed `run_command` arguments receive `invalid_command` guidance before
  execution. The executable must be an absolute path with a separate argument
  array; Camus never silently translates a command line into shell execution.
- A distinct overlapping MCP request receives `tool_busy` with
  `operationCompleted:false`. Nothing is executed or queued. The caller must
  await the earlier response before submitting a new request ID.
- Correction and busy attempts consume existing action allowance. Duplicate
  request IDs, exhausted budgets, security failures and uncertain execution
  still stop. Direct native filesystem/permission requests during commands
  remain fail-closed; native session replay is not enabled.
- Sanitized `boundaryRefusal` diagnostics distinguish invalid dispatch, duplicate
  IDs, budget refusal, tool execution refusal and native-command overlap.
  The first refusal survives subsequent cancellation errors. Arguments and
  arbitrary provider/process text are excluded from these diagnostic fields.

## Evidence and limits

All 57 focused offline tests passed locally, with no skips, alongside full
root/CLI and Studio suites and packaged-runtime parity checks. Tests cover safe
correction, no queued effects, consumed IDs, busy floods, exhausted budgets,
post-dispatch failures, native overlap and diagnostic persistence/redaction.

The reported 0.4.23 cross-project failure exposed `tool_boundary_refused` with
`lastHostTool: run_command`; that alone does not identify the exact offending
request. This release addresses reproduced boundary failure classes, not a
proven successful rerun of that project. Live SWE validation is separate and
is not claimed as passed in this release.

Update before a fresh bounded run. Do not interrupt an ongoing validation to
upgrade, replay an uncertain historical run, or increase limits to bypass a
refusal. Existing SWE platform, pinned-artifact and unknown-spend constraints
remain unchanged. See [SWE setup](SWE-SETUP.md).
