# Camus 0.4.9 — productive recovery and isolated native makers

Any-model Build can now repair bounded failures, resume the same private candidate
across CLI and Studio, and explicitly choose the maker's execution harness. Raw
file actions remain the default. Native Codex, Qwen Code and Grok Build are
maker-only experimental options; reviewer selection remains independent and every
candidate still stops for human acceptance.

## What changed

- Verification and advisory-review findings can feed a bounded maker repair.
  Checkpoints retain the exact task, candidate, pair, executor, endpoint,
  credential revision, verifier, budgets, questions/answers and accounting.
  CLI and Studio can inspect, stop and continue the same run ID without silently
  changing those bindings. Repeated discovery without new evidence stops rather
  than spending more identical turns.
- `codex_native` lets the built-in Codex maker own a tool/context session while
  Camus keeps candidate custody, budgets, host verification, advisory review and
  final acceptance. It uses the existing ChatGPT CLI login; there is no API-key
  fallback. Completed turns can resume; uncertain writes are preserved but never
  automatically adopted or replayed.
- `qwen_native` and `grok_native` separate harness from model/backend. They use
  exact reviewed Qwen Code 0.22.3 and Grok Build 1.0.5 artifacts with any qualified
  OpenAI-compatible maker endpoint, including managed SSH connections. The raw
  HTTP adapters remain available and unchanged.
- Qwen/Grok credentials stay in the host. A one-run capability gateway enforces
  exact Chat Completions path, selected model and aliases; rebuilds upstream
  headers; buffers and validates response identity before forwarding; accounts
  calls/usage; refuses unselected helper/Responses traffic; and aborts in-flight
  upstream work on shutdown.
- An outer macOS Seatbelt worker permits candidate/private-scratch writes and one
  gateway port only. Synthetic preflight canaries require source, receipts,
  protected tracked files, Git metadata, process environments, arbitrary writes,
  other loopback ports and external network to remain inaccessible. Harnesses get
  private config/cache/session homes, no provider key, and exact JSONL terminal,
  session and model validation. A zero process exit alone is never success.
- `camus build --models`, `--maker-executor`, Studio's maker picker, run metadata
  and advisory handoff all carry the selected executor. Unsupported runtimes do
  not advertise Qwen/Grok native choices; no fallback changes the model or path.

## Deliberate boundaries

Qwen/Grok native execution is qualified only on macOS arm64. Qwen Code 0.22.3
also requires Node 22+; Camus's default file-action/runtime floor remains Node
18.17. Install the official pinned harness separately or provide its absolute path
through `CAMUS_QWEN_CODE_BIN` / `CAMUS_GROK_BUILD_BIN`. Changed artifacts refuse
before a model call.

This release does not admit an external production reviewer, activate automatic
task routing, rank a model/harness combination, or claim live-provider coding
quality/cost/latency. The pinned Qwen/Grok E2E uses a synthetic local provider and
no real credential or paid call. The earlier provider-backed Native Codex dogfood
stopped at its budget with an unaccepted partial candidate and remains recorded as
a failed experiment, not release evidence.

`--verify` executes trusted candidate code locally with credential environment
values removed; it is not the native worker sandbox. Nothing in Any-model Build
commits, merges, pushes or publishes automatically.

## Verification

- The default native suite covers gateway authentication/identity/accounting and
  shutdown, Seatbelt canaries, native process ownership, protocol refusals,
  recovery, repairs and candidate adoption rules.
- An opt-in production-supervisor test drives both digest-pinned vendor CLIs
  through the same synthetic model/tool completion and observes only the selected
  model.
- The extracted npm package contains the shared runtime—not tests, receipts or
  operator config—and exercises help, catalog, setup, qualification refusal,
  candidate execution and continuation without a source-checkout fallback.
- Root CLI/workflow and complete Studio regression suites are release gates.

## Upgrade

```sh
npm install -g camus-cli@0.4.9
camus build --help
camus build --models
```

For the legacy proof gate, also run `camus install && camus check`. Studio remains
checkout-based: fast-forward a clean checkout, restart its local server and reload
the page. See [Independent coding seats](INDEPENDENT-CODE-SEATS.md) for native
prerequisites, commands, limits and acceptance boundaries.
