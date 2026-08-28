# Camus quickstart for CodenameWukong

## 0.4.8: choose both coding models

**Both maker and reviewer are selectable independently** in `camus build` and
Studio **Build → Any-model candidate**. Choose from the same configured, role-qualified
catalog: Codex as maker and Claude as reviewer, qualified Grok/Qwen/other compatible
models in either role, or even the same model in both roles. Same-model/origin feedback
is never presented as independent review.

This new route produces an isolated candidate with experimental advisory review and
explicit human acceptance. It never auto-commits or merges. The legacy `camus run`
and Studio **Legacy proof gate** still use Claude Code maker plus Codex reviewer;
external reviewers there remain shadows unless they earn separate gate admission.
See [Independent coding seats](INDEPENDENT-CODE-SEATS.md) for exact limits.

## 1. Install once

Requirements for Any-model Build: Node 18.17+, Git, and credentials for your chosen
backends. Sign in to Claude Code/Codex only if you select those seats. The native
proof gate also requires both CLIs and Python 3. CodenameWukong verification needs
its .NET 10 toolchain; automatic any-model verification currently requires POSIX.

```bash
npm install -g camus-cli@0.4.8
camus build --help
camus models
```

For the native proof gate, additionally:

```bash
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

Loop Studio lets you choose the maker and reviewer independently for written/research
work and Any-model Build. It supports Claude and Codex in either seat, plus explicitly declared
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
defaults. Choose **Build → Any-model candidate** for independent role selection,
or **Legacy proof gate** for Claude maker/Codex reviewer with native recovery.
Update an existing Studio checkout with `git pull --ff-only` from its clean `main`,
then restart its server: upgrading npm alone does not update that separate checkout.
A declared connection grants no
trust: Carlos must explicitly qualify the exact model, role, endpoint, credential reference,
transport, and reported identity before Studio enables that seat. Tunnel death fails closed and
never falls back to direct traffic.

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

The native driver launches and reattaches its own durable Claude background session; do not start
a parallel implementation session. Only when deliberately using the legacy slash-command route,
launch Claude Code with:

```bash
claude --permission-mode auto
```

## 3. Choose the smallest workflow

### Any-model candidate: select both roles

Use exact IDs offered by `camus models`. For example, if both are available:

```bash
camus build --repo . \
  --task 'Implement the bounded game feature from the agreed issue.' \
  --contract 'The named gameplay tests pass and existing movement behavior is unchanged.' \
  --maker codex:gpt-5.6-luna --maker-effort low \
  --reviewer claude:sonnet \
  --verify "$CAMUS_VERIFY_CMD"
```

Change **either** `--maker` or `--reviewer` to another offered `backend:model`.
For long contracts use `--task-file` and `--contract-file`. Studio exposes the same
choices in its two launch dropdowns. `--verify` executes your trusted command locally;
without it the result is untested. Windows users must omit it and verify manually.
Exit `2` means human acceptance is required, not CI success. Inspect the preserved
worktree and receipt; there is no automatic landing or resume in this experimental path.
Live coding reliability across these provider combinations has not yet been established.

### Native proof gate: durable automatic workflow

For the existing Claude-maker/Codex-reviewer workflow, use model-free initialization
followed by the durable native driver.
Write the real feature contract to `feature.json`:

```json
{
  "feat": "Implement <bounded game feature>",
  "tasks": [
    "Implement <required behavior>. Add <focused tests>. Preserve <named invariant>. Exclude <out-of-scope work>."
  ],
  "targetPath": "/absolute/path/to/CodenameWukong",
  "model": "claude-opus-4-8",
  "roundCap": 2
}
```

Then run:

```bash
camus start feature.json   # prints the deterministic featId without a model turn
camus run <featId>         # durable Opus 4.8 maker + Sol reviewer
camus watch                # optional live board from another terminal
camus eval                 # local quality, speed, and observed-usage evidence
```

### Optional native shadow: test another reviewer behind Codex

Configure the endpoint in Studio Settings first; credentials stay in their named environment
variables. Then verify what this shell can use:

```bash
camus models --reviewers-only
```

Choose any listed profile/model for one run:

```bash
camus run <featId> \
  --shadow-reviewer-backend xai \
  --shadow-reviewer-model grok-4.6 \
  --shadow-reviewer-effort medium
```

The external model reviews every candidate before Codex. Its `trial1:` receipt and comparison are
stored under `~/.camus`; they never enter CodenameWukong. A missing key, malformed response, model
substitution, tunnel death, or provider failure is reported as shadow-unavailable and never becomes
a fallback or green gate. Codex still reviews the unchanged candidate and the repository tests
still decide whether it ships.

To distribute real tasks across all four currently configured models, copy
[`CARLOS-OPEN-MODEL-EXPERIMENT.example.json`](CARLOS-OPEN-MODEL-EXPERIMENT.example.json), update
profile/model ids to match `camus models --reviewers-only`, and run:

```bash
camus run <featId> --experiment /path/to/carlos-open-model-experiment.json
camus eval --config /path/to/carlos-open-model-experiment.json
```

This is deliberately `mode: explore`: the report shows shadow verdict agreement, latency, and token
coverage per exact task class, but names no winning external reviewer. Formal routing still needs
the repeated Slice G corpus/containment campaign and explicit human admission.

For a multi-task feature, list ordered, independently verifiable tasks in the same JSON. The
Claude Code workflows remain compatibility surfaces: `/camus-loop` for one bounded task and
`/camus-plan` followed by `/camus-feat` when an interactive planning conversation is genuinely
useful.

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
2. **Choose the route.** Use `camus build` or Studio Any-model Build when independent role
   selection is required; its handoff is an advisory candidate, not a landed commit. Use
   `camus start` + `camus run` for the native proof gate and durable automatic recovery.
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
- `infra_error`: the run is not clean. Native runs can use their bound recovery path;
  Any-model Build preserves the candidate for inspection but has no automatic resume.
- `verify_failed`: the candidate is not shippable.

Native terminals reached after an accepted review receipt report that receipt's final reviewer
backend, model (or explicit `not_recorded`), effort, and round. Preserve those fields at
handoff; never substitute the maker model when a reviewer model was not recorded.

Camus never pushes or opens a PR. Carlos or his agent reviews the resulting commit and
handles GitHub.

## Prior completed dogfood (August 7, 2026)

[CodenameWukong PR #2](https://github.com/CarlosQ96/CodenameWukong/pull/2) merged on
August 7, 2026 (merge commit `7842a6b`). It carries the complete WP1–WP10 Enemies output
and does not need another Camus run.

Wait for Carlos's next real feature/spec; do not invent game work to exercise Camus. When
the spec arrives, fetch Carlos's current `main`, confirm a clean committed baseline, and
start a new persisted run from that state. Do not reuse the old WP worktrees blindly.
Health, damage, invulnerability, knockback, defeat, drops, and quest credit remain examples
of deliberately excluded follow-up scope—not an assumed next feature without Carlos's spec.
