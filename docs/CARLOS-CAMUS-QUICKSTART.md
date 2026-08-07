# Camus quickstart for CodenameWukong

Camus 0.3.1 uses Claude Code as the maker and Codex CLI as the independent reviewer.
The direct workflow currently runs inside Claude Code; another agent may supervise it,
but should not implement alongside Camus.

## 1. Install once

Requirements: Node 18+, Claude Code signed in, Codex CLI signed in, and .NET 10.

```bash
npm install -g camus-cli@0.3.1
codex login
camus install
camus check
camus canary
```

Optional for unattended runs:

```bash
camus auto-setup
```

## 2. Prepare CodenameWukong

Start from a clean branch with a committed baseline:

```bash
cd /path/to/CodenameWukong
git status
camus env-check .
export CAMUS_REPO_ROOT="$(pwd -P)"
```

For this repository, pin the deterministic test floor:

```bash
export CAMUS_VERIFY_CMD='dotnet test tests/ActionRpgFramework.Core.Tests/ActionRpgFramework.Core.Tests.csproj -m:1 /nodeReuse:false && dotnet test tests/ActionRpgFramework.MonoGame.Tests/ActionRpgFramework.MonoGame.Tests.csproj -m:1 /nodeReuse:false && dotnet test tests/ActionRpgFramework.Platform.Tests/ActionRpgFramework.Platform.Tests.csproj -m:1 /nodeReuse:false'
```

Then launch Claude Code:

```bash
claude --permission-mode auto
```

## 3. Choose the smallest workflow

For one bounded task:

```text
/camus-loop {
  "task": "Implement <feature>. Acceptance contract: <required behavior, tests, exclusions, and handoff condition>.",
  "posture": "full",
  "roundCap": 2,
  "policy": "ask_on_ambiguity"
}
```

For a multi-part feature, plan first:

```text
/camus-plan {
  "request": "Design and implement <feature> from <spec>. Preserve existing behavior. Explicitly exclude <out-of-scope work>.",
  "policy": "ask_on_ambiguity"
}
```

Review the generated plan, then run the `/camus-feat` command Camus produces.

Use:

- `full` for gameplay systems, architecture, persistence, or risky behavior.
- `oneshot` for narrow, well-specified changes. Its final repair is verified but not
  re-reviewed, so it reports `done_with_findings`.
- `roundCap: 2` by default; increase it only when the feature genuinely warrants it.

## 4. What the supervising agent should do

Give the agent this instruction:

> Operate Camus; do not implement the feature outside it. Supply the complete acceptance
> contract, then let the run work. Monitor with `camus watch` or `camus status`. Interrupt
> only for a custody breach, false receipt, orphaned process, scope drift, ignored round
> cap, or bypassed verification. Treat ordinary UX friction or latency as retrospective
> feedback. On `needs_human`, ask me the exact question. Close only from the terminal
> report, clean worktree, commit SHA, and head-bound verification.

Useful commands from another terminal:

```bash
camus watch
camus status
camus resume
camus retro
```

## 5. Read terminal states honestly

- `done`: clean review and deterministic verification passed.
- `done_with_findings`: a bounded final repair passed tests but was not re-reviewed;
  inspect its findings and claimed resolutions.
- `needs_human` / `needs_decision`: Camus needs an owner decision, not more autonomous
  churn.
- `infra_error`: repair the environment and resume with the same run; do not finish the
  implementation manually.
- `verify_failed`: the candidate is not shippable.

Camus never pushes or opens a PR. Carlos or his agent reviews the resulting commit and
handles GitHub.

## Current Enemies PR

The current Enemies PR does not need another Camus run—it is already the WP1–WP10
output. Health, damage, invulnerability, knockback, defeat, drops, and quest credit
should be the next separately specified feature.
