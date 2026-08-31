# Native harness qualification 1 — stock boundary blocked; Camus isolation follow-up passed

> **Current 0.4.18 runtime contract:** Camus accepts the reviewed
> Grok Build **1.0.13** macOS-arm64 binary (`grok 1.0.13 (5e9a58528b76)`,
> SHA-256 `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`).
> The 1.0.5 observations below remain historical evidence and 1.0.5 is no longer
> accepted by current runtime policy.

Date: 2026-08-28. Branch: `codex/productive-loop`. The observations below are the
negative stock-harness baseline. A later same-day Camus-owned isolation follow-up
is recorded at the end and released experimentally in 0.4.9.

## What actually ran

Private, pinned vendor executables on macOS arm64 / Node 22.20.0, driven by a
local OpenAI-compatible fake provider. Every child received a freshly constructed
environment and private home. The provider supplied a fixed shell command that
checked synthetic canaries and wrote booleans to a temporary candidate. No
operator credential or configuration was imported, no paid model was called,
and no global installation or Docker image pull occurred.

The fixture explicitly approves its **fixed, synthetic** tool call to test the
stock sandbox. These approval flags are not a production recommendation. It does
not give a live model permission to operate on the user's checkout.

| Observation | Qwen Code 0.22.3 | Grok Build 1.0.5 |
| --- | --- | --- |
| Stock sandbox selected | `permissive-open` | `strict` |
| Synthetic provider key visible to shell | Yes | Yes |
| Synthetic `.git/HEAD` readable | Yes | Yes |
| Synthetic private-temp canary outside candidate readable | Yes | Yes |
| Loopback network canary reachable | Yes | Yes |
| Final process exit | 0 | 0 |
| Successful-looking terminal | `result/success`, structured result | `end`, `stopReason: end_turn` |
| Native qualification assessment | **Blockers found** | **Blockers found** |
| Recorded fixture duration | 1,260 ms | 501 ms |

This proves the tested stock configurations do not satisfy Camus's boundary.
It does **not** claim arbitrary real private files were read, that every profile
is insecure, or that the existing raw API adapters leaked credentials. The private
canary lives in the fixture's temporary tree; network testing used localhost,
not external exfiltration. Complete isolation, all native tools and adversarial
process cleanup remain unqualified.

## Additional Grok findings

1. With an explicit custom model and `models.allowed_models` restricted to that
   model, Grok attempted a separate `/v1/responses` request using `grok-4.6` and a
   `session_title` tool. The fake provider rejected it. Main-model selection does
   not alone freeze all inference; helper requests need explicit enforcement and
   accounting. This test did not spend money on that request.
2. With the tested `dontAsk`/allow configuration, the shell was cancelled and Grok
   emitted `end` with `stopReason: cancelled`, yet exited **0**. A later fixture
   with its fixed command explicitly approved executed the canary successfully.
   Parse the terminal reason; never convert a zero exit into task success.
3. The binary's `streaming-json` is native ACP update frames (`usage`, `tool_call`,
   `tool_call_update`, `text`, `end`). Its help also offers
   `streaming-messages-json`. Neither should be treated as Qwen's JSONL schema.
4. Shell-only selection uses `--tools Bash`; `--tools bash` did not expose the
   shell. The emitted shell tool name is `run_terminal_command`. MCP search/use
   tool schemas remained advertised in this fixture, so tool-list restrictions
   and discovery require explicit qualification too.

Qwen's successful fixture emitted `system/init`, assistant/tool frames and a
`result` with `structured_result`. Both successful main conversations reported
48 **synthetic fixture tokens**, not billed usage. These are protocol checks,
not model-quality, cost or latency benchmarks.

## Pins and reproduction

- Qwen official npm artifact:
  [`@qwen-code/qwen-code@0.22.3`](https://registry.npmjs.org/@qwen-code/qwen-code/0.22.3).
  Its SHA-512 matches the published integrity:
  `8Ngy/ZEn+idOyN3k52K9TNu/XSkNfS2hyzsikeSDe79kRd2/eMYbWLOZq6LHSGVYXVNpY6ktpfZLthxY5AHWeA==`.
  The unpacked 1,005-file tree is also bound by the fixture's SHA-256 pin.
- Grok official artifact, resolved using the reviewed
  [installer](https://x.ai/cli/install.sh), without executing that installer:
  [`grok-1.0.5-macos-aarch64`](https://x.ai/cli/grok-1.0.5-macos-aarch64).
  Reported version: `grok 1.0.5 (5115b46bc909)`.
  SHA-256: `3dfa7f04fbb5427a8fbead286591543aaecb478b3a0ab222c4329eca1a3b2f86`.

The fixture requires these exact artifacts, macOS arm64 and Node 22+. Extract
Qwen's npm tarball into a private directory without installing optional
dependencies; do not use a source-tree entrypoint. It refuses modified/unpinned
artifacts before execution. Invoke from the repo root, substituting the private
artifact paths:

```sh
node scripts/probe-native-harness.mjs qwen /absolute/qwen-package/cli-entry.js
node scripts/probe-native-harness.mjs grok /absolute/grok-1.0.5-macos-aarch64
node --test scripts/probe-native-harness.test.mjs
```

The first two currently exit **2** (`blockers_found`), even though the vendor
process exits zero. Each prints its private report path, pin and condensed
evidence. It leaves that synthetic report/candidate in its named temporary
directory for inspection. Eight classifier tests pass, including missing evidence,
cancelled/duplicate terminals, changed pins and out-of-selection helper requests.
Passing those unit tests means the negative classification works—not that either
native harness is admitted. Default root tests never launch/download a vendor CLI.

Regression check for this pass: full `npm test` passed, including the 672 workflow
and 37 planning assertions. Studio `test:native` passed 24 tests with its one
opt-in installed-Codex integration probe skipped. `git diff --check` and probe
syntax checks passed. The full Studio suite was not rerun in this pass; production
runtime code was unchanged by the qualification work.

## Decision and next step

Hold both picker entries and release. Keep the raw API paths unchanged. A shared
isolated worker with a host-owned model gateway is the recommended next scope:
provider keys outside the worker, candidate-only file access, constrained egress,
explicit model/helper policy, host budget accounting and owned cancellation.
Docker by itself does not remove inherited keys. This boundary has **not** been
implemented or proven; confirm the expansion before building it.

Once proven, use it for both native maker adapters in the existing shared
CLI/Studio engine. Reviewer model selection stays independent. A useful bounded
end-to-end completion, regression checks and explicit acceptance still precede
release; successful harness JSON is not accepted code.

## Same-day isolation follow-up

The recommended boundary was implemented without changing the raw API adapters:

- a host-owned gateway retains the real provider key, accepts only authenticated
  `/v1/models` and exact-model `/v1/chat/completions`, refuses helper/Responses
  paths, rebuilds upstream headers, validates reported model identity before
  forwarding, accounts usage/calls and aborts upstream work on shutdown;
- an outer macOS Seatbelt worker writes only candidate/private scratch and can
  connect only to that gateway port; source, receipts, protected tracked files,
  `.git`, arbitrary loopback and external network are synthetic-canary tested;
- Qwen Code 0.22.3 and Grok Build 1.0.5 are bound by the reviewed artifact digest,
  private configuration and independent exact JSONL terminal/session parsers;
- the production descendant-owning supervisor drove both pinned vendor CLIs
  through the same synthetic candidate edit in one test, observing only the
  selected model. No operator credential or paid provider call was used.

This changes the enablement decision to **experimental maker adapters may ship**
on qualified macOS arm64 installations. It does not erase the stock negative
result, admit either model for gating, prove provider-backed quality/latency, or
remove human acceptance. Those claims require later combination dogfood/evals.

## Current Grok subscription path

Grok Build now has two explicit Camus billing contracts. They share the harness
name but do not share credentials or billing:

| Selection | Inference authority | Billing authority |
| --- | --- | --- |
| built-in `grok:grok-4.6` + `grok_native` | Grok Build's authenticated ACP session | Grok/SuperGrok subscription allowance |
| configured `xai:grok-4.6` + `grok_native` | Camus one-model gateway → `api.x.ai` | xAI API credits/invoicing |

The built-in path never reads or forwards `XAI_API_KEY` and never falls back to
the API path. It copies only the existing private Grok login record into
run-private scratch, requires the ACP `cached_token` auth method, and
records `billingAuthority: grok_subscription`. Grok owns model inference and
context; Camus owns bounded filesystem and terminal RPCs, candidate custody,
verification, review, and the human handoff.

Install the reviewed 1.0.13 artifact, authenticate it in your normal operator
session, and then use the built-in seat:

```sh
grok --version
grok login

camus build --repo /path/to/project \
  --task 'Fix the bounded regression.' \
  --contract 'The named tests pass without weakening assertions.' \
  --maker grok:grok-4.6 --maker-effort medium \
  --maker-executor grok_native --max-tokens 100000 \
  --reviewer codex:gpt-5.6-luna --reviewer-effort medium \
  --verify 'npm test'
```

`camus build --models` and Studio Setup perform only artifact/version readiness
checks. A real subscription smoke still needs an explicit bounded model-call
authorization. See xAI's [Grok Build overview](https://docs.x.ai/build/overview),
[headless/ACP guide](https://docs.x.ai/build/cli/headless-scripting), and
[separate consumer/API billing FAQ](https://docs.x.ai/console/faq/accounts).
