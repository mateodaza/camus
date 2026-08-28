# Independent coding seats

Model selection shipped in **0.4.8**. The productive repair/recovery controls below
are **unreleased development work**; use the matching source checkout until a new
release is published. Installing 0.4.8 does not add these controls.

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

Configure connections in Studio Settings or with the new CLI setup path, then
qualify each exact model/role first.
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
  --verify 'dotnet test' --verify-repeatable
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

Adapter scratch, transcripts and receipt files remain outside the project. Both
surfaces now default to `~/.camus/studio/runs/<id>`; `STUDIO_RUNS_DIR` overrides that
shared root. The
run refuses a `STUDIO_RUNS_DIR` inside the target repository (including through a
symlink). When building Camus itself from Studio, point that setting to a private
directory outside the checkout. Model-created ignored files are refused too;
they cannot disappear from the reviewed candidate fingerprint.
The host retains an authenticated checkpoint and bounded action journal. Test
failures supply redacted, source-located, explicitly untrusted diagnostics; reviewer
findings return to the same maker. The maker can repair, give an evidence-bound
rebuttal/recheck reason, ask one bound question, or stop. Changed code loses its old
verification/review binding and needs fresh closure. No extra controller model runs.
Context rollover retains the original contract, open feedback, current file hashes
and distinct current source bodies where they fit, plus recent observations and
explicitly non-authoritative maker intent. Omitted bodies are named, not represented
as covered; latest requested reads are never clipped. Safe files, including run-created
files, remain readable. Three unchanged discovery steps produce a warning in the
next maker turn; six stop the run with its work preserved. This is a bounded
no-new-evidence safeguard, not a claim that duration or token output proves progress.
Oversized required evidence is refused, never represented as covered.
Infrastructure failures and interrupted runs clear the terminal diff/fingerprint
rather than present an older snapshot as current; inspect the retained worktree.

`--verify` is an explicit local execution authorization. Environment credentials
are removed and a private HOME is used, but this is **not an OS sandbox**: tests
execute candidate code with your local user permissions. Use trusted projects.
Verification currently requires POSIX process-group cleanup; Windows users must
inspect and verify the preserved candidate manually. Omitting the command means
**not tested**, not green. The existing native gate retains stack detection.

`--verify-repeatable` explicitly authorizes repeated execution after fixes or an
interruption. Without it, an additional check needs `--retry-verification` on resume.
The verifier has its own bounded supervisor and cleans its command group on normal
exit, cancellation, timeout, or loss of the host process. This does not contain code
that deliberately escapes its process group or filesystem permissions.

## Setup without a Studio server

Prepare a JSON file with `connectionName`, `connection`, `backendName`, and `backend`
using the [shared connection/backend schema](MULTI-MODEL-SEATS.md). Include the
operator's `why` declarations. Credentials must be env-var **names**, never key values.

```sh
camus build --setup /private/path/connection-backend.json
camus build --models --json
camus build --qualify mybackend:exact-model-id --role maker --allow-provider-calls
camus build --qualify mybackend:exact-model-id --role reviewer --allow-provider-calls
```

Setup/list/status are offline. Each qualification command explicitly authorizes one
model/role campaign and may spend provider tokens; there is no implicit qualify-all.
Use `--replace` only to intentionally replace an existing named declaration. Neither
setup nor transport qualification grants code-gate admission.

## Budgets, stop, answer, resume

CLI flags and Studio's **Any-model recovery and budget** control the same limits:
32 total model calls, 12 maker steps, 32 file actions, 2 repairs, 1 recovery retry,
20 minutes active time and 10 minutes per model call by default. Inactivity timeout
and token budgeting default off. Set them explicitly when warranted:

```sh
camus build --status RUN_ID --json
camus build --stop RUN_ID
camus build --resume RUN_ID --max-calls 40 --max-steps 20
camus build --resume RUN_ID --answer 'The required format is plain text.' --question QUESTION_ID
```

Additional launch flags: `--max-actions`, `--max-repairs`, `--max-retries`,
`--max-tokens`, `--timeout-ms`, `--call-timeout-ms`, and `--idle-timeout-ms`.
Resume permits explicit extensions of total budgets, never a reset or a changed
pair, contract, endpoint, credential revision, or verifier. Changing those bindings
requires a new authorized run. Inactivity and per-call limits are frozen at launch.
Token limits reserve 32,768 tokens before each call; reported usage replaces that
reservation, otherwise it remains conservative accounting. A response can exceed
the reservation. This is **not a provider-enforced token or dollar cap**.

Both clients use the same run ID and exclusive local-host ownership. Reopening a
page only attaches; an explicit stop does not restart itself. Known completed
responses and writes are recovered without repeating them. An in-flight provider
call with no durable response is uncertain: `--retry-uncertain` (or the matching
Studio consent) authorizes one bounded retry, with possible duplicate billing.
No exactly-once billing or provider-session reattachment is promised.

The receipt separates observed tokens, unmeasured calls, model/verification/active
time, parked time and unknown wall time after a hard crash. Private run directories
are local-machine state, not a distributed/shared-drive scheduler.

Old 0.4.8 runs have no authenticated checkpoint and remain inspection-only. Files
are not moved or deleted. To view an old Studio `apps/loop-studio/runs` or CLI
`~/.camus/studio/code-runs` directory, explicitly set `STUDIO_RUNS_DIR` to that
existing directory. Do not point new internal state into the project being built.

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

Hermetic tests cover reversed/HTTP/same-origin choices, repair/review cycles,
diagnostic privacy, forced-kill boundaries for every action kind and verifier cleanup,
uncertain retries, current-candidate binding, context rollover, budgets, concurrent
ownership, bound answers, server restart, both directions of CLI/Studio continuation,
and actual execution/resume from an extracted npm package. Synthetic browser testing
also exercises launch, budget stop, reattachment and same-candidate continuation.
A [first live Luna maker attempt](DOGFOOD-PRODUCTIVE-LOOP-1.md) stopped before
verification/review after repeated discovery, with no feature diff. The resulting
context fix has offline coverage but has not yet passed a fresh live run. A campaign
across these coding combinations has **not** been run; no optimal-pairing or
production-gate claim follows from these tests or that unsuccessful attempt.
