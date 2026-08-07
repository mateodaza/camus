# Camus quickstart for CodenameWukong

Camus 0.3.2 supports configurable maker and reviewer seats in Loop Studio for written
and research work, including reversed Claude/Codex pairings and declared OpenAI-compatible
backends. The direct code workflow—and Studio's Build lane—currently keep the trusted gate's
Claude Code maker plus Codex CLI reviewer pairing. Another agent may supervise that code
workflow, but should not implement alongside Camus.

## 1. Install once

Requirements: Node 18+, Claude Code signed in, Codex CLI signed in, and .NET 10.

```bash
npm install -g camus-cli@0.3.2
codex login
camus install
camus check
camus canary
```

Optional for unattended runs:

```bash
camus auto-setup
```

### Configurable seats in Loop Studio

Loop Studio lets you choose the maker and reviewer independently for written and research
work. It supports Claude and Codex in either seat, plus explicitly declared
OpenAI-compatible backends. The receipt records the providers and models that actually ran;
a same-vendor pairing remains usable but is labeled advisory rather than independent.

```bash
git clone https://github.com/mateodaza/camus.git
cd camus/apps/loop-studio
node server.mjs --doctor
node server.mjs
```

Open <http://localhost:1913> and use **Settings** to select both seats, their models,
reviewer effort, and the round cap. A fresh checkout uses pragmatic public defaults
(Sonnet maker, `gpt-5.4-mini` reviewer at low effort, two rounds); Settings saves Carlos's
standing choices under `~/.camus/studio/models.json` and does not rewrite the tracked
defaults. Studio's **Build** lane still uses the direct trusted code gate—Claude Code makes
the change and Codex CLI reviews it—although their models and reviewer effort are
configurable. Reversing the provider roles applies to Studio's written and research lanes,
not to Build in 0.3.2.

For written and research lanes, completed artifacts stay local unless **Publish the
completed artifact to Hivemind** is checked before launch. Accepting review findings does
not grant publication consent, and Build never uses this artifact-publication path.

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

## 4. Run it as an agent-guided loop

Carlos can give the feature to a supervising agent and ask that agent to operate Camus
from beginning to handoff. This is more than passively watching a terminal: the agent
chooses the smallest Camus surface, turns the request into a complete contract, selects
the posture and review budget, monitors the run, routes genuine questions to Carlos, and
returns the finished candidate plus feedback about Camus itself.

The operating sequence is:

1. **Ground in the source of truth.** Read the live repository, pinned spec or issue, and
   current baseline. Define required behavior, deterministic tests, exclusions, and the
   handoff condition.
2. **Choose the route.** Use `/camus-loop` for one bounded task, `/camus-plan` followed by
   `/camus-feat` for a real multi-package feature, or Studio when visible controls,
   configurable seats, stop/resume, and receipt inspection are useful.
3. **Start Camus, then stay outside the implementation.** Camus owns planning,
   implementation, review rounds, fixes, worktrees, verification, and receipts. The outer
   agent must not quietly implement missing work beside it.
4. **Monitor the evidence Camus owns.** Watch phases, processes, worktree state,
   verification, receipts, `camus watch`, or Studio. Route a `needs_human` question to
   Carlos verbatim and resume with his answer.
5. **Protect the solution path.** Stop immediately for a custody breach, false receipt,
   orphaned process, scope drift, ignored round cap, or bypassed verification. Record UI/UX
   friction, latency, token waste, and non-blocking ideas for the end instead of repeatedly
   interrupting a healthy run. Keep diagnostics targeted: never dump the broad environment
   or process table, and redact credential-shaped values before recording output.
6. **Hand back two outputs.** First, the game result: terminal state, commit, test evidence,
   review standing, and any deferred findings. Second, a short Camus report: material bugs,
   UX friction, and pragmatic improvements observed during the run.

Give the agent this instruction:

> You are the Camus operator for this feature, not a parallel implementer. Ground in the
> live spec and repository, supply the complete acceptance contract, choose the smallest
> useful Camus workflow, and let the run solve the task. Monitor with `camus watch`,
> `camus status`, or Studio. Interrupt only for a custody breach, false receipt, orphaned
> process, scope drift, ignored round cap, or bypassed verification. Route genuine human
> questions to me verbatim. Record ordinary UX friction, latency, token waste, and ideas
> without derailing a healthy run. At handoff, report both the game result—terminal state,
> commit, tests, review standing, and deferred findings—and a short prioritized Camus
> bugs/UX/efficiency review. Never implement alongside Camus or claim more than its receipt.

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

In 0.3.2, terminals reached after an accepted review receipt report that receipt's reviewer
backend, model (or explicit `not_recorded`), effort, and round. Preserve those fields at
handoff; never substitute the maker model when a reviewer model was not recorded.

Camus never pushes or opens a PR. Carlos or his agent reviews the resulting commit and
handles GitHub.

## Current CodenameWukong state

[CodenameWukong PR #2](https://github.com/CarlosQ96/CodenameWukong/pull/2) merged on
August 7, 2026 (merge commit `7842a6b`). It carries the complete WP1–WP10 Enemies output
and does not need another Camus run.

Wait for Carlos's next real feature/spec; do not invent game work to exercise Camus. When
the spec arrives, fetch Carlos's current `main`, confirm a clean committed baseline, and
start a new persisted run from that state. Do not reuse the old WP worktrees blindly.
Health, damage, invulnerability, knockback, defeat, drops, and quest credit remain examples
of deliberately excluded follow-up scope—not an assumed next feature without Carlos's spec.
