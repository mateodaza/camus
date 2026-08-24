# Open Model Seats — Slice F status

**Status:** implementation candidate; production disabled; feature acceptance and Slice G
benchmark admission pending

**Date:** 2026-08-23

Slice F adds the machinery needed to evaluate additional CLI reviewer backends without quietly
turning them on. It does not add a supported reviewer to Camus today. The production gate remains
Claude as maker and the admitted built-in Codex backend as reviewer.

## Implemented candidate surface

- `review.sh` delegates to an exact-match dispatcher. It knows `codex`, `qwen_code`, `grok_cli`,
  and `http_openai_compat`; unknown names never fall back.
- Fixed CLI reviewers take training organization from the checked-in dispatcher registry. The
  generic HTTP candidate takes it only from an expiring, HMAC-covered local qualification record
  exact-bound to fingerprint/backend/model/transport/connection. Ambient lineage text can narrow
  or conflict, never grant provenance; missing, tampered, expired, or same-origin evidence refuses.
- Only `codex` is admitted. All three additional names return the typed
  `reviewer_benchmark_disabled` infrastructure outcome.
- `http_openai_compat_review.py` is directly exercisable by the benchmark harness. It supports
  light/diff-only, schema-constrained streaming chat completions over loopback, direct HTTPS, or
  an already-managed SSH local forward.
- The candidate shares Camus's detached process-group watchdog and gate normalizer; seals the rc1
  scope, exact accepted `qual1:<sha256>` qualification fingerprint, identity, transport, and
  connection binding; and distinguishes provider
  refusal, malformed output, timeout/idle, cancellation, model substitution, and tunnel death.
- Authentication is keyless or references one environment variable. Environment-auth replay is
  bound to the existing per-machine salted credential-revision HMAC, so a key/account rotation
  refuses the old result without storing the key. Credential values, resolved
  tunnel URLs/ports, authorization headers, and tunnel process identifiers are excluded from the
  persisted watch metadata and receipts. SSH tunnel death is typed and has no direct fallback.

## Evidence present

The hermetic suite uses fake HTTP and fake CLI executables to prove:

- exact-match, unknown, same-origin, conflicting-origin, and benchmark-disabled refusals;
- a candidate CLI on `PATH` is not executed while disabled;
- start/await/replay through the shared watchdog;
- immutable audit replay, preserved failed attempts, retry without duplicate live requests, and
  refusal on runtime/input drift;
- schema-constrained and size-bounded SSE, required response-model evidence, typed malformed
  events, and shared fail-closed normalization;
- keyless and environment authentication with a planted-secret artifact sweep;
- refusal to replay after environment-credential rotation and refusal of a bare `qual1` tier;
- HMAC-covered qualification-lineage authority, including ambient and on-disk forgery refusals;
- typed tunnel death both before worker start and in flight, with no direct fallback;
- proxy/redirect suppression and direct-HTTPS endpoint-boundary validation;
- process-group cancellation leaves no live reviewer group.

The existing Codex review suite remains the regression oracle for the admitted path.

## Evidence deliberately absent

- No live Qwen Code or Grok CLI run has qualified those executors.
- No provider-backed HTTP campaign has measured catch rate, false-positive rate, schema-valid
  rate, latency, containment conclusiveness, or transport equivalence.
- No backend besides Codex is admitted for automatic routing.
- No release claim should call these candidates supported until feature acceptance is complete
  and Slice G's statistical admission criteria pass.

The next state change is evidence-driven: finish Slice F feature acceptance, then run Slice G. A
green mechanical test suite alone cannot flip a backend's checked-in admission decision.
