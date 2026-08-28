# Independent coding seats — experimental in 0.4.8

`camus build` and Studio's **Build → Any-model candidate** use the same model
catalog, connection definitions, adapters, and host-mediated coding engine.
Choose maker and reviewer independently: Claude, Codex (including Luna when
offered by your account), or a configured OpenAI-compatible model such as Grok,
Qwen, or Kimi. HTTPS, loopback, and existing managed SSH connections are reused.
Model availability is machine/account-specific; Camus does not invent IDs or
silently substitute a different provider.

Install `camus-cli@0.4.8` or newer. The npm package includes the shared runtime;
a running Studio server or checkout is not needed to execute the CLI command.
Studio itself still runs from a Camus checkout: update that checkout and restart
`apps/loop-studio/server.mjs` to use the matching UI and server. For source testing,
replace `camus` below with `node packages/cli/bin/camus.js`.

## Choose and run

Configure connections in Studio Settings and qualify each exact model/role first.
These are transport/text-output qualifications, **not admission to gate code**.
API credentials stay in their declared environment variables. Claude and Codex
use their isolated CLI/account routes; unrelated provider environment overrides
are not inherited. List the available choices:

```sh
camus models
camus build --models --json
```

Example reversed pairing, only if these IDs are listed on your machine:

```sh
camus build --repo /path/to/game \
  --task 'Fix the movement regression described in the issue.' \
  --contract 'Movement tests pass and existing jump behavior is unchanged.' \
  --maker codex:gpt-5.6-luna --maker-effort low \
  --reviewer claude:sonnet \
  --verify 'dotnet test'
```

For longer briefs use `--task-file` and `--contract-file`. Specify both seats or
neither (to use saved Studio choices). A backend name is the name in your local
configuration, not necessarily a provider's brand. Same-model/same-organization
pairings are allowed, but never presented as independent review. Hosting the
same Qwen model on two providers does not make it two independent origins.

## Execution and limits

The source repository must have a clean committed baseline. Camus creates a
separate `codex/code-seats-*` branch/worktree. Models have no shell or ambient
filesystem tools: they exchange bounded JSON requests with the host to list,
read, create, update, or delete source files. Existing-file edits require the
host's exact previous content hash. Absolute/traversing paths, symlinks, internal
Camus/agent directories and known credential files are refused. Credential-shaped
content is screened, but this is **not a guarantee that arbitrary repositories
contain no secrets**; choose repositories appropriate to send to your providers.

Adapter scratch, transcripts and receipt files remain outside the project. The
run refuses a `STUDIO_RUNS_DIR` inside the target repository (including through a
symlink). When building Camus itself from Studio, point that setting to a private
directory outside the checkout. Model-created ignored files are refused too;
they cannot disappear from the reviewed candidate fingerprint.
The host retains bounded action history, refuses oversized context without silently
dropping coverage, and rechecks the candidate fingerprint after verification and
review. The loop stops on protocol errors, provider errors, cancellation, or its
step/time limits. There is no autonomous fix/review retry campaign or automatic
resume in this experimental path; the candidate is preserved for inspection.
Infrastructure failures and interrupted runs clear the terminal diff/fingerprint
rather than present an older snapshot as current; inspect the retained worktree.

`--verify` is an explicit local execution authorization. Environment credentials
are removed and a private HOME is used, but this is **not an OS sandbox**: tests
execute candidate code with your local user permissions. Use trusted projects.
Verification currently requires POSIX process-group cleanup; Windows users must
inspect and verify the preserved candidate manually. Omitting the command means
**not tested**, not green. The existing native gate retains stack detection.

## What the result means

Even a clean review and passing tests end at a human checkpoint. Nothing is
committed, merged, pushed or published automatically. CLI exit code `2` means
the candidate needs a human decision, and `1` is an unresolved/failed run; neither
is unattended CI success. Inspect the candidate path and JSON receipt before
accepting changes yourself.

Reports carry requested and observed identities, identity-evidence quality,
per-turn usage where available, elapsed time, candidate fingerprint, review,
and verification result. Missing usage is unknown, not free. These reports do
not create a native gate evidence pack or contribute a successful autonomous
trial to admission/routing. Studio's admitted-gate audit dimension remains
`not_run`; the experimental advisory review is retained separately.

`camus run`, `/camus-feat` and **Legacy proof gate** are unchanged: their maker
remains Claude Code and the normal gate remains Codex. Use `camus build` for
independent coding-seat choices. External gate admission still requires its
separate Slice G campaign and genuine human calibration.

## Validation boundary

Hermetic tests cover reversed/HTTP/same-origin choices, adapter scratch isolation,
stale edits, private paths, context limits, cancellation, candidate binding,
HTTP launch/report behavior and an extracted npm package. A provider-backed
campaign across these coding combinations has **not** been run; no optimal-pairing
or production-gate claim follows from these tests.
