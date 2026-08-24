# Camus 0.4.4 open-model foundations

Camus 0.4.4 ships the connection, qualification, and reviewer-contract machinery needed to test
open-weight and Grok/Kimi/Qwen combinations without silently declaring them trustworthy. It is a
foundation release: the new Studio paths are qualification-gated, and Codex remains the only CLI
reviewer admitted for production routing.

## What changes

- Loop Studio can qualify declared OpenAI-compatible maker or reviewer seats over loopback,
  direct HTTPS, or a Camus-managed SSH forward. The exact capability receipt, observed model,
  connection, transport, credential revision, and lineage follow the run into its sealed evidence.
- Managed SSH is forward-only and host-owned. Camus validates the OpenSSH boundary, owns lease and
  teardown, bounds and redacts diagnostics, detects tunnel death, and never falls back to a direct
  connection.
- The CLI has a versioned reviewer contract and an exact-match dispatcher for `codex`,
  `qwen_code`, `grok_cli`, and `http_openai_compat`. Unknown names never fall back.
- The OpenAI-compatible HTTP reviewer candidate supports schema-constrained streaming, bounded
  input and output, async start/await/replay custody, timeout and cancellation, endpoint and model
  substitution checks, HMAC-bound qualification/lineage authority, credential-rotation detection,
  and typed tunnel failure.
- Native recovery also preserves verifier isolation and resumes sealed retry-budget handoffs
  without relaunching already completed model work.

## Safety boundary

This release does **not** enable a new CLI reviewer. `qwen_code`, `grok_cli`, and
`http_openai_compat` fail closed as `reviewer_benchmark_disabled` until the Slice G provider-backed
campaign meets its predeclared quality, schema-validity, latency, containment, and transport
criteria. A hermetic implementation is not evidence of provider quality.

OpenAI Responses transport and Studio's browser connection editor are not included. Real
xAI/Moonshot/DashScope credentials and real Ollama, vLLM, LM Studio, or llama.cpp hardware remain
an explicit validation gap.

## Release evidence

- Slice F's final task completed nine bounded adversarial review rounds and ended clean.
- Task and feature integration proofs were bound to their exact accepted heads with no findings or
  custody tampering.
- The complete CLI/root suite passes, including 664 workflow assertions and the generic reviewer,
  review-contract, recovery, and provenance matrices.
- The complete Loop Studio suite passes, including qualification, admission, privacy, loopback,
  managed-SSH lifecycle, and end-to-end Slice C coverage.
- Package dry-run and repository whitespace checks are clean.

## What comes next

The next feature is the [Responsible Control Plane](RESPONSIBLE-CONTROL-PLANE.md): explicit input
screening, action authorization, output screening, stakes-based human routing, and versioned
control/evidence ownership. After that, Slice G runs provider-backed evals and A/B evidence by task
class. Only a candidate that clears the quality floor may compete on time, tokens, and cost or earn
automatic routing.
