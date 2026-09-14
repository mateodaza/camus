# SWE through Devin

SWE-2 High is an optional coding maker in Camus CLI and Loop Studio starting in
0.4.22. Choose the reviewer separately. It does not replace your saved defaults,
become a reviewer, or grant an automatic merge or an admitted proof gate.
Flexible Build retains its public-alpha, advisory standing.

## Before you start

- macOS Apple Silicon, with Devin CLI `3000.10.21 (611c1cba)` and an existing
  Devin login. Camus validates the exact reviewed binary before a prompt.
- Use Devin's own installation and login flow. A nonstandard executable can be
  selected with `CAMUS_DEVIN_BIN`; it still must match the reviewed artifact.
- An available independent reviewer, for example GPT-5.6 Luna through a saved
  ChatGPT login. Your orchestrating agent can plan separately using GPT or Claude.
- A clean, trusted Git repository and a trusted verification command.

Camus preserves Devin account authentication. No API key or provider fallback
is substituted. A vendor promotion or subscription does **not** make Camus able
to guarantee zero charges; check the terms and usage in your Devin account.

## CLI

```sh
npm install -g camus-cli@0.4.25
camus models
camus build --repo /path/to/clean-repository \
  --task-file /path/to/task.txt --contract-file /path/to/acceptance.txt \
  --maker devin:swe-2-high --maker-executor devin_native \
  --accept-devin-unmetered \
  --reviewer codex:gpt-5.6-luna --reviewer-effort medium \
  --max-calls 4 --max-steps 3 --max-actions 40 --max-tokens 131072 \
  --timeout-ms 300000 --call-timeout-ms 300000 \
  --max-repairs 0 --max-retries 0 --max-recoveries 0 \
  --verify "npm test"
```

Replace the task, contract, reviewer and verifier with your actual choices.
These example limits are not a recommended budget for every task. A token or
call limit counts Camus's planning reservations and dispatches—not SWE's internal
inferences. `--accept-devin-unmetered` explicitly accepts that uncertainty.

## Studio

Open the local Studio, choose **Build → Flexible Build**, select
**Devin / SWE-2 High**, and choose the reviewer independently. Review the limits
and check the per-run unknown-spend consent. CLI and Studio use the same runtime;
the hosted demo does not execute your local login or repository.

## Supported scope and limits

- Prepared source: at most **512 files, 1 MiB per file, 8 MiB total**. Oversized
  inventories are refused; Camus does not silently omit files to fit. Large
  monorepos need an explicitly prepared scoped checkout. There is no automatic
  package-scoping feature in this release.
- Checked native edits and host-provided read/search/write/create tools.
  Commands run without provider credentials or network and cannot write staging.
  No arbitrary dependency installation or file deletion.
- Time and observed-action limits are enforced. ACP events and host actions can
  conservatively count the same operation twice. Total internal inference calls
  and token spend remain unknown; do not interpret planning allowances as a bill cap.
- Verification and review bind the exact candidate. A missing result or unproven
  cleanup cannot become approval. Uncertain work is preserved, never silently
  replayed. Acceptance remains a separate human decision.

## Evidence, not a model ranking

### 0.4.25 native slice pacing

Native coding prompts now expose their action slice target and dispatch time
limit. For SWE, the slice is at most 64 **accounted actions**, reduced by the run's
remaining allowance. Native events and host operations share that allowance;
64 actions does not mean 64 tool calls. The maker is asked to wrap up by 75% of
the slice (48 of 64 actions), or earlier if time is low.

SWE MCP tool responses include a separate `camus_native_budget` text block with
remaining actions/time and wrap-up guidance, including after correction or busy
feedback. Ordinary tool result JSON is unchanged. Native filesystem/permission
responses are not rewritten; the model still needs to follow the initial pacing
instructions when using native tools directly.

Return a valid `done:false` / `decision.action:"continue"` handoff **before** the
hard stop if work remains. This preserves partial work through the normal checked
completion path; continuation uses the original run limits and recalculates the
next slice allowance. No post-timeout prompt, added provider call, automatic
budget extension or uncertain-session replay is authorized. Guidance cannot
guarantee a model will finish on time. Live pacing validation remains separate.

These shared prompt changes apply to native coding makers in CLI and Studio,
not file-actions, words/marketing workflows, or reviewers. Live response counters
in this release are specific to SWE host tools. See [0.4.25 notes](RELEASE-0.4.25.md).

### Earlier diagnostic and command-boundary fixes

Use 0.4.23 or later for failure diagnostics and bounded host-tool feedback.
`list_files` provides paginated prepared-file discovery. A host response with
`operationCompleted:false` reports a no-write conflict, not a completed edit;
follow its guidance within the existing budget. Unknown native tool failures and
security refusals still stop. Incomplete runs expose sanitized `nativeDiagnostic`
fields in CLI inspection and Studio status, with private terminal evidence stored
locally. Never post raw terminal files publicly.

A later cross-project 0.4.22 run stopped before edits or review and lost its
underlying reason. 0.4.23 fixes the diagnostic loss; the original trigger remains
unknown. A fresh 0.4.23 attempt also stopped before edits or review, with
`tool_boundary_refused` and `lastHostTool: run_command`. That identifies the
boundary, not the exact offending request, and does not establish project success.

### 0.4.24 command-boundary correction

Version 0.4.24 returns `invalid_command` guidance for a
malformed host command **before execution**. `command` must be an absolute
executable path; `args` is a separate string array. Camus never translates a
command line into shell execution automatically.

A distinct overlapping MCP request returns `tool_busy` / `operationCompleted:false`:
nothing executed or queued. Wait for the earlier response and use a fresh request
ID, within the original budget. Both malformed commands and busy attempts consume
action allowance. Duplicate IDs, exhausted budgets, post-dispatch errors and
security failures remain fatal; uncertain effects are never retried automatically.
Direct native filesystem/permission requests during a command still fail closed.

Sanitized diagnostics now include `boundaryRefusal` with a fixed reason code and
known host tool name, separate from the last observed host tool. Offline regression
coverage is not proof that a fresh SWE run on the affected project will succeed.
This correction is not included in 0.4.23. See [0.4.24 release notes](RELEASE-0.4.24.md).

The bounded native SWE → frozen verification → Luna medium smoke passed. A
subsequent ten-file snapshot of a real application's package passed a two-file
change, its existing/new/frozen tests and independent Luna review in 76 seconds,
with six actions and no repairs or retries in the successful run. Two earlier
package attempts exposed a Camus completion-parser bug; that history is not
excluded from the evidence. The original application stayed unchanged.

The checks found and fixed two Camus issues: open reviewer stdin and progress
commentary being parsed as completion JSON. These results prove the exercised
integration, not universal correctness, best-model status, production economics,
or all-project compatibility.

See [recommended model setup](RECOMMENDED-MODEL-SETUP.md) for current task evidence
and [the integration record](SWE-NATIVE-INTEGRATION.md) for protocol and test history.
