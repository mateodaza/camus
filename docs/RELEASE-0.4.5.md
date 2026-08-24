# Camus 0.4.5 controlled open-model operations

Camus 0.4.5 makes the 0.4.4 open-model foundation operable and auditable without pretending that
an untested model is trusted. It ships Studio's connection workflow, a shared responsible control
plane, and the provider-free half of the Slice G benchmark. Production CLI review remains
Claude-made work reviewed by Codex until a later live campaign earns and a human approves another
pairing.

## What changes

- Loop Studio can create or explicitly replace validated local connection/backend declarations
  from starters for xAI, Kimi, DashScope, Ollama, LM Studio, llama.cpp, vLLM, generic HTTPS, and a
  private server reached through Camus-managed SSH. Saving is network-free and grants no trust.
- Qualification is a separate, plainly labelled provider-backed action. It streams redacted
  progress and binds its result to the exact seat, backend, model, connection, credential revision,
  adapter contract, and observed model identity.
- Ordinary Studio setup and `--doctor` stay network-free. Deep provider checks require the explicit
  `--deep` or UI action, and publication remains off by default with exact operator consent.
- Studio and CLI share a versioned responsible-control register covering input screening, exact
  action authorization, output screening, stakes routing, and reconstructable evidence. Missing,
  malformed, or version-skewed high-stakes evidence fails closed.
- Managed-SSH receipts bind the immutable connection fingerprint. Shared borrowers freshly prove
  process identity and application liveness, receive complete control evidence, and cannot inherit
  facts from a same-named edited connection.
- The offline Slice G ledger freezes campaigns before results, keeps every attempt append-only, and
  derives conservative quality, containment, and transport-equivalence intervals. Per-cell
  flakiness, cold/resident latency, reported usage/cost, and decoding profiles stay visible instead
  of being averaged away. It cannot call a provider or edit production routing; even an eligible
  row still requires human admission.

## Safety boundary

This release does **not** qualify real xAI, Moonshot, DashScope, Ollama, LM Studio, llama.cpp,
vLLM, or private SSH-hosted infrastructure, and it does not admit Grok, Kimi, Qwen, or a generic
HTTP reviewer. `qwen_code`, `grok_cli`, and `http_openai_compat` continue to fail closed as
`reviewer_benchmark_disabled`. OpenAI Responses transport is still planned rather than selectable.

The next dogfood is intentionally the live Slice G campaign: run the current Codex baseline and
each approved candidate on the same versioned corpus, segment outcomes by task class, and compare
quality before velocity or cost. The campaign may recommend; only an explicit human decision may
change admission.

## Release evidence

- The complete Loop Studio suite passes, including the hermetic qualification API, control-plane
  register, configuration privacy, managed-SSH lease/reuse/teardown, and Slice C end-to-end cases.
- The complete CLI/root suite passes, including cross-language control receipts, reviewer cause
  normalization, and the offline benchmark's append-only and conservative-statistics cases.
- The qualification fixture is loopback-only and provider-free. No paid model call is concealed in
  this release gate.
- Package dry-run and repository whitespace checks are clean.

## What comes next

Run the provider-backed A/B campaign with deliberately chosen Grok, Kimi, Qwen, and/or
open-weight endpoints. Preserve the Codex baseline, use the same task-class corpus and transport
pairs, record timing and spend, and admit only combinations that clear the quality and containment
floor. Those results become routing evidence for a later release, not a retroactive claim about
0.4.5.
