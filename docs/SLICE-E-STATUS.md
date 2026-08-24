# Open Model Seats — Slice E status

**Status:** implemented and hermetically verified; provider-backed validation pending

**Date:** 2026-08-24

Slice E makes the open-model foundation configurable from Studio without turning a declaration
into trust or an innocent setup check into provider spend.

## Implemented product surface

- Settings offers declaration starters for xAI, Kimi international and China, DashScope, Ollama,
  LM Studio, llama.cpp, vLLM, generic OpenAI-compatible HTTPS, and a private model server reached
  through Camus's managed SSH forward.
- **Configure & save** opens the exact JSON that will be written to local operator state. Both
  `connection.why` and `backend.why` are required, every template placeholder must be replaced,
  and editing an existing name requires a separate replacement checkbox.
- The server accepts exactly one connection plus one backend, binds the reference itself, runs the
  production connection/backend/identity validators, and atomically writes mode-0600 local state.
  Credential values are forbidden; only an environment-variable name or explicit keyless mode is
  allowed. Legacy entries are preserved instead of normalized into the file accidentally.
- Saving only makes the declared tuple visible. It remains disabled until **Qualify** demonstrates
  the exact maker or reviewer tuple and launch rechecks the accepted `qual1:` receipt.
- Qualification streams redacted progress for discovery, streaming, model identity, structured
  output, context envelope, and receipt creation. Raw malformed output remains only in the bounded
  local diagnostics directory; the browser receives its path, not its contents.
- Every paid qualification POST carries exact human authorization through the responsible control
  plane and leaves a separate 0600 action receipt. Setup and `--doctor` are network-free by
  default; `--doctor --deep` and the plainly labelled deep-check button are explicit spend paths.
- Origin/operator/transport badges and the declared-versus-registry standing remain server-owned.
  OpenAI Responses is shown as planned and cannot be selected.

## Evidence present

- Connection unit tests prove placeholder, reason, collision, replacement, dual-write, legacy,
  credential, transport, and no-admission behavior.
- The real API test proves authorization, exact input shape, non-reflection of a planted credential,
  local persistence, server-derived transport, and disabled admission.
- A hermetic loopback inference fixture exercises the fetch-streamed API end to end and writes both
  the `qual1:` receipt and the human-bound control receipt. It contacts no provider.
- Capability tests exercise the production streaming adapter and progress events across successful,
  malformed, substituted, context-short, keyless, credentialed, drift, expiry, and SSH cases.

## Evidence deliberately absent

- No xAI, Moonshot, DashScope, or other hosted credential has been used by this slice.
- No real Ollama, LM Studio, llama.cpp, vLLM, or private SSH-hosted model has been qualified.
- No additional CLI reviewer is admitted. Those decisions belong to the Slice G live campaign.

Slice E is ready for the combined release audit. Provider-backed model tests begin only when the
operator deliberately selects a tuple and approves the campaign/spend.
