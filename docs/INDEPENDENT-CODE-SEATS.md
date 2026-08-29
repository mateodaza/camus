# Independent coding seats

Model selection shipped in **0.4.8**. Productive repair/recovery and the opt-in
native maker controls below ship in **0.4.9**.

`camus build` and Studio's **Build → Any-model candidate** use the same model
catalog, connection definitions, adapters, and host-mediated coding engine.
Choose maker and reviewer independently: Claude, Codex (including Luna when
offered by your account), or a configured OpenAI-compatible model such as Grok,
Qwen, or Kimi. HTTPS, loopback, and existing managed SSH connections are reused.
Model availability is machine/account-specific; Camus does not invent IDs or
silently substitute a different provider.

Install `camus-cli@0.4.9` or newer. The npm package includes the shared runtime;
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
separate `codex/code-seats-*` branch/worktree. By default, models have no shell or ambient
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

### Opt-in native makers (released experimentally in 0.4.9)

The maker executor is independent from the maker model/backend:

- `file_actions` remains the default host-mediated protocol.
- `codex_native` uses the built-in vendor-managed Codex backend and its existing
  ChatGPT CLI login.
- `qwen_native` uses Qwen Code 0.22.3 with any exact, qualified
  OpenAI-compatible maker backend.
- `grok_native` uses Grok Build 1.0.5 with any exact, qualified
  OpenAI-compatible maker backend.

This makes model + harness combinations explicit: for example, Qwen Code with a
qualified Qwen endpoint, Grok Build with xAI, or either harness with a compatible
self-hosted/SSH endpoint. The reviewer is still selected independently. All three
native adapters are **maker-only** and experimental; no native reviewer is implied.
No model or executor is silently substituted, and existing raw API choices remain.
Camus still owns the frozen task, isolated candidate, budgets, deterministic
verification, advisory review and final human handoff.

Codex example, using models actually listed on your machine:

```sh
node packages/cli/bin/camus.js build --repo /path/to/project \
  --task 'Fix the regression described in the issue.' \
  --contract 'The required tests pass without changing the acceptance criteria.' \
  --maker codex:gpt-5.6-luna --maker-effort medium \
  --maker-executor codex_native --max-tokens 1000000 \
  --reviewer claude:sonnet --verify 'npm test' --verify-repeatable
```

Studio exposes the same choice under **Any-model executor, recovery and budget**.
A positive token budget is mandatory for every native executor. Codex uses the
existing ChatGPT login in its normal account store: no credential copy, custom API
provider, proxy override or API-key fallback. This uses the account's quota/credit
billing; it is not free or a dollar-cap guarantee.

Qwen Code/Grok Build require macOS arm64 and the exact reviewed artifacts. Qwen
also requires Node 22+:

```sh
npm install -g @qwen-code/qwen-code@0.22.3
# Install the official Grok Build 1.0.5 macOS arm64 artifact per xAI's CLI docs.

camus build --repo /path/to/project \
  --task 'Fix the bounded regression.' \
  --contract 'The named tests pass without weakening their assertions.' \
  --maker dashscope_qwen:qwen3.8-27b --maker-executor qwen_native \
  --reviewer codex:gpt-5.6-luna --max-tokens 1000000 --verify 'npm test'
```

The normal executable names are `qwen` and `grok`. A nonstandard private install
can be selected with `CAMUS_QWEN_CODE_BIN=/absolute/path` or
`CAMUS_GROK_BUILD_BIN=/absolute/path`; the resolved path and exact artifact digest
are frozen into the native session. Changed artifacts refuse before any model call.

For Qwen/Grok, a host-owned one-run gateway keeps the real provider credential
outside the harness. The worker receives only a random, short-lived gateway
capability. The gateway accepts Chat Completions for the one selected model,
refuses Responses/helper substitution and other paths, rebuilds upstream headers,
buffers and validates every reported model identity before forwarding output, and
accounts each provider call. Managed SSH backends reuse Camus's tunnel lease and
never fall back to a direct route. Provider output cannot echo the real key into
the harness. This does not make provider calls free or impose a dollar cap.

- Native tools work in a separate **clone**, not a linked worktree with writable
  source Git metadata. The verified permission profile allows candidate/scratch
  writes and required runtime reads, but denies source/receipt access, protected
  source paths and all Git metadata. Codex denies network entirely. Qwen/Grok's
  outer macOS Seatbelt profile permits only the one-run model gateway port;
  arbitrary localhost and external network remain denied.
  Git history is blocked because it can expose protected files. Host Git operations
  still compute the candidate normally. Native-generated ignored files are refused,
  not omitted from the reviewed diff. Dependencies are not installed automatically;
  choose a ready, trusted project and use the authorized host verifier for tests
  needing services or permissions the native sandbox lacks.
- For Codex, ambient MCP servers are discovered without creating a thread, explicitly disabled,
  and the effective configuration is checked before generation. Hooks, plugins,
  subagents, web tools and inherited shell credentials are disabled. Merged policy
  widening or an unsupported installed protocol/sandbox refuses before generation.
  Compatibility was probed offline on macOS with Codex **0.149.0**. Linux is eligible
  only if the same runtime checks pass; it has not been exercised here. Windows is
  not supported by this prototype.
- Qwen runs with safe mode and private HOME/config/cache paths. Grok disables
  plans, subagents, memory imports, web tools, LSP tools, vendor project imports
  and auto-update, using a private frozen model table. Camus's outer sandbox—not
  the weaker nested vendor sandbox—owns containment. Both protocols are parsed
  by their exact JSONL terminal/session/model rules; a zero process exit alone is
  never success. Provider credentials are not inherited by tool processes.
- Structured app-server usage events are checkpointed while a turn runs. Cached
  input stays separate; resumed thread totals are reduced by the saved baseline.
  Native response/tool events count against the shared call/action limits. Limits
  are checked at event boundaries, not provider-enforced hard caps. Incomplete
  accounting retains an unknown-usage reservation. Reported model identity is the
  returned **thread configuration**, not independent provider attestation.
- A saved completed turn can continue on the same thread/candidate, including
  CLI↔Studio continuation. Cancellation interrupts the bound turn and cleans the
  owned executor/observed descendants, including separate tool process groups.
  This is not a VM or a guarantee against malicious code deliberately escaping
  process tracking; only run trusted projects. An uncertain crashed native turn
  **cannot auto-adopt its writes or use `--retry-uncertain` to replay them**. It is
  preserved for inspection with verification/review claims cleared. No seamless
  mid-turn crash recovery or exactly-once provider billing is promised.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[permissions](https://learn.chatgpt.com/docs/permissions).
Offline tests cover protocol, policy refusals, cleanup, repair, accounting and
cross-surface continuation. The [first integrated provider-backed dogfood](DOGFOOD-NATIVE-MAKER-1.md)
stopped at its token budget with a partial candidate; it never reached in-loop
verification or review, and its independent post-stop acceptance check failed.
It is **not** evidence of a speed/quality win or readiness to release. No budget
extension or automatic repeat followed.

From the repository root, `npm --prefix apps/loop-studio run test:native` runs
the hermetic native suite (also included in Studio's normal tests). The separate
installed-CLI compatibility probe is deliberately opt-in and creates no model turn:

```sh
CAMUS_NATIVE_OFFLINE_PROBE=1 node --test apps/loop-studio/lib/code-native.integration.test.mjs
CAMUS_NATIVE_HARNESS_PROBE=1 \
  CAMUS_QWEN_CODE_BIN=/absolute/qwen/cli-entry.js \
  CAMUS_GROK_BUILD_BIN=/absolute/grok \
  node --test apps/loop-studio/lib/native-harness.integration.test.mjs
```

The pinned Qwen/Grok integration uses a synthetic local provider: no real key or
paid call. It proves both vendor CLIs can edit a candidate, return a definitive
terminal and use only the selected model through the production gateway/supervisor.
It is boundary evidence, not a model-quality or speed benchmark. Provider-backed
combination dogfood remains required before making any performance claim.

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

CLI flags and Studio's **Any-model executor, recovery and budget** control the same limits:
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
file-action call with no durable response is uncertain: `--retry-uncertain` (or the matching
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
