# Camus quickstart

Camus adds independent review, deterministic verification, bounded recovery, and an
honest receipt around AI-made work. Choose the smallest surface that fits the job:

- **Code:** use the public CLI's native driver; Claude Code workflows remain compatible.
- **Written or research work:** run Loop Studio locally in the browser.
- **Agent-supervised work:** let another agent operate Camus, but not implement beside it.

Camus is public-alpha software. Use it only on repositories and test commands you trust,
never as root. Camus does not push code or open a pull request for you.

## Path A: code

The direct code gate currently uses Claude Code as the maker and Codex CLI as the
independent reviewer. You can configure the Claude model, Codex model, review effort,
posture, and round cap; the cross-vendor role assignment remains fixed for trusted code
standing.

### 1. Install once

Requirements: Node 18+, Claude Code signed in, Codex CLI signed in, Python 3, and Git.

```bash
npm install -g camus-cli@0.4.5
codex login
camus install
camus check
camus canary
```

`camus canary` is local and model-free. To exercise the reviewer too, run one small
Codex-backed check:

```bash
camus canary --review
```

Optional for unattended runs:

```bash
camus auto-setup
```

### 2. Prepare the target repository

Camus needs a clean Git baseline because diffs, isolated worktrees, commits, and
HEAD-bound tests are its custody mechanism.

```bash
cd /path/to/your-repo
git status
camus check
camus env-check .
export CAMUS_REPO_ROOT="$(pwd -P)"
```

If the repository is new, create a local baseline first:

```bash
git init
git add -A
git commit --allow-empty -m baseline
```

Camus auto-detects common stacks. When the correct verification command is not obvious,
pin the exact floor that must pass:

```bash
# Node
export CAMUS_VERIFY_CMD='npm test'

# Python
export CAMUS_VERIFY_CMD='pytest -q'

# .NET
export CAMUS_VERIFY_CMD='dotnet test MyApp.slnx -m:1 /nodeReuse:false'

# Any trusted repository command
export CAMUS_VERIFY_CMD='./scripts/verify.sh'
```

Include the real tests, not only compilation or linting.

### 3. Create and run a native feature

Write the bounded contract to `feature.json`:

```json
{
  "feat": "Harden input boundaries",
  "tasks": [
    "Validate the boundary, add regression coverage, and preserve existing behavior."
  ],
  "targetPath": "/absolute/path/to/your-repo",
  "posture": "full",
  "roundCap": 2,
  "taskClass": "bounded_feature"
}
```

Then start it without spending a model turn and run the returned feature ID:

```bash
camus start feature.json
camus run <featId>
```

`camus run` launches the durable Claude maker, calls Codex directly for independent review,
and lets the local kernel own verification, commits, recovery, and landing. If the launching
terminal is interrupted, rerun the same command: Camus adopts the exact background session rather
than buying a duplicate turn.

For a feature that genuinely needs decomposition, `/camus-plan` remains an optional compatibility
surface inside Claude Code:

```text
/camus-plan {
  "request": "Design and implement <feature> from <spec or requirements>. Preserve existing behavior. Explicitly identify exclusions and deterministic acceptance tests.",
  "policy": "ask_on_ambiguity"
}
```

Review the emitted plan, then copy its bounded tasks into the native feature spec above or run the
emitted `/camus-feat` compatibility command. Do not add a planning phase to a task that is already
small and fully specified.

### 4. Pick the review posture

- **`full`:** use for gameplay systems, architecture, persistence, security-sensitive
  behavior, broad refactors, and work whose repair needs independent re-review.
- **`oneshot`:** use for narrow, well-specified work. It performs one review and one
  repair, then deterministic verification decides. A repaired result is honestly reported
  as `done_with_findings` / `fixed_unreviewed`, never “review clean.”
- Start with **`roundCap: 2`**. Increase it only when the work genuinely benefits from
  another review round; do not spend rounds optimizing style.

These values work in the native JSON spec and the compatibility workflows.

## Path B: written and research work in Loop Studio

Loop Studio supports independently configurable maker and reviewer seats for written and
research work, including reversed Claude/Codex pairings and declared OpenAI-compatible
backends. Same-vendor review is allowed but labeled advisory rather than independent.

Studio currently runs from a Camus checkout:

```bash
git clone https://github.com/mateodaza/camus.git
cd camus/apps/loop-studio
node server.mjs --doctor
node server.mjs
```

Open <http://localhost:1913>, then:

1. Choose the maker, reviewer, effort, and bounded round cap.
2. State the goal.
3. Fill **“What must be true for you to trust the result?”** with the complete acceptance
   contract—required content, evidence rules, exclusions, and handoff condition.
4. Start the run and intervene only when Studio presents a real question or material fault.
5. Finish on the trust card and evidence pack, not on a model’s prose claim.

Studio’s **Build** lane uses the direct code gate, so it retains the Claude-maker plus
Codex-reviewer role assignment. An eligible parked candidate can resume through
verification only; Plan, Implement, and Review do not rerun.

## Path C: another agent supervises Camus

An outer agent should remain a thin operator. Give it this prompt:

> Operate Camus; do not implement the task outside it. Choose the smallest appropriate
> surface and supply the complete acceptance contract. Let a healthy run solve the task.
> Monitor `camus watch`, `camus status`, or Studio’s host-owned process, worktree, phase,
> and receipt signals. Interrupt only for a custody breach, false receipt, orphaned process,
> scope drift, ignored round cap, or bypassed verification. Treat ordinary UX friction and
> latency as retrospective feedback. On `needs_human`, ask me the exact question. Close only
> from the terminal report, intended commit or artifact, deterministic verification, and an
> honest receipt.

The supervising agent must not:

- implement the feature alongside a viable Camus run;
- inspect or parse live reviewer-handle directories;
- create a second polling or receipt system;
- turn an infrastructure failure into a code verdict;
- silently narrow the human’s acceptance contract;
- push, publish, or merge without separate authorization.

## Watch, resume, and learn

From another terminal:

```bash
camus watch
camus status
camus resume
camus retro
camus eval
```

- `watch` is the live dashboard.
- `status` is a read-only snapshot.
- `resume` lists interrupted feature runs with their original arguments.
- `retro` reads prior reports and recommends improvements without modifying code or config.
- `eval` reports quality, timing, and usage by exact experiment generation and task class. It does
  not promote a pairing until the configured coverage and quality floor are both satisfied.

## Read terminal states honestly

- **`done`:** clean review and deterministic verification passed.
- **`done_with_findings`:** a bounded final repair passed deterministic verification but
  was not re-reviewed. Inspect the preserved findings and claimed resolutions.
- **`needs_human`:** the task contains a decision the owner must make.
- **`needs_decision`:** deterministic verification may be green, but review did not
  converge. Accept or refine deliberately.
- **`infra_error`:** repair the environment or custody problem and resume with the same
  run identity. Do not finish the implementation manually.
- **`verify_failed`:** the candidate is not shippable.

## Handoff

For code, require:

- the intended terminal state;
- a clean isolated worktree and named commit;
- deterministic verification bound to that commit;
- the real review standing and any deferred findings.

Then the human or an authorized agent handles GitHub, release, or deployment. Camus keeps
those external mutations outside the gate.

For a concrete .NET example, see
[`docs/CARLOS-CAMUS-QUICKSTART.md`](docs/CARLOS-CAMUS-QUICKSTART.md). For every option and
environment lever, see [`packages/cli/README.md`](packages/cli/README.md).
