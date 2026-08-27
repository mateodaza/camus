# Camus 0.4.6 external-model shadow evaluation

Camus 0.4.6 lets real code work evaluate Grok, Qwen, and other OpenAI-compatible
reviewers without grading them into service prematurely. The selected external model reviews the
same exact candidate that Codex subsequently gates. Its verdict, identity, latency, available
usage, and agreement with Codex become local A/B evidence; it cannot authorize a commit.

## What shipped

- `camus models` lists reviewer-capable profiles from Studio's local
  `~/.camus/studio/models.json`. It exposes provider/model, transport, connection name, and whether
  the named credential is present—never endpoint URLs or credential values.
- `camus trial-review` runs one manual non-gating review from an exact profile.
- `camus run` accepts `--shadow-reviewer-backend`, `--shadow-reviewer-model`, and
  `--shadow-reviewer-effort`. The shadow runs before every Codex review of that candidate; Codex
  remains the only final reviewer gate.
- Experiment arms may pin `shadowReviewerBackend`, `shadowReviewerModel`, and
  `shadowReviewerEffort`. Assignment stays segmented by config hash and task class.
- Trial receipts use a distinct `trial1:` namespace. A private, expiring, machine-HMAC record binds
  backend, model, declared training organization, transport, connection, endpoint digest, auth
  mode, credential name, and opaque credential revision. A `trial1:` record is rejected by the
  production dispatcher.
- Direct HTTPS, literal loopback, and fixed managed-SSH profiles share the hardened streaming HTTP
  executor. SSH remains forward-only, remote-loopback-only, strict-host-key, non-multiplexed, and
  no-fallback; the CLI owns and tears down the trial tunnel.
- Eval episodes record shadow availability, verdict agreement, duration, and available token use.
  `camus eval` reports those fields per arm. Shadow experiments are `explore`-only and never name a
  routing winner: agreement with Codex is useful evidence, not human calibration or Slice G
  admission.

## Safety and provenance boundary

The code path that seals work is unchanged: Claude makes the candidate, Codex performs the
accepted independent review, deterministic verification passes, and only then may the kernel
commit and land it. External-model failure is visible but does not silently substitute another
provider; Codex closure still runs. Trial receipts and provider output remain under `~/.camus`, not
inside the target project, and Camus never pushes.

The checked-in `http_openai_compat` production backend remains `admitted: false`. Qwen Code and
Grok CLI still have no production executors. This release exercises hosted or self-hosted
OpenAI-compatible chat-completions endpoints through the generic HTTP adapter.

## Verification

The release suite covers signed trial issue/read/tamper/expiry boundaries, profile loading without
endpoint or secret disclosure, real hermetic SSE execution, model identity, durable replay,
credential rotation, dispatcher refusal, exact-candidate shadow/Codex comparison, experiment
validation, and explore-only reporting.

Before publication:

- The full CLI/root suite passed, including 664 workflow assertions and the native driver,
  reviewer-custody, control-plane, benchmark, and install-freeze suites.
- The complete Loop Studio suite passed, including provider adapters, capability qualification,
  managed SSH, admission, custody, privacy, and Slice C end-to-end coverage.
- The landing site production build and npm package dry run passed; the tarball contains the new
  model runner and trial authority.
- `git diff --check` and the credential-shape scan were clean.

No paid provider call was made from the release shell because its xAI and DashScope credential
variables were intentionally unavailable. Provider-backed CLI trials are the purpose of the Carlos
handoff; the adapter boundary itself is exercised against a real hermetic streaming HTTP server.

## Still pending

- The full provider-backed Slice G campaign: publishable defect/clean corpus, repeated quality
  cells, containment and kill-path cells, transport equivalence, conservative statistics, and
  explicit human admission.
- Human-labelled calibration for judge standing; the current expert-proxy comparison is not formal
  calibration.
- Automatic task router promotion only after those evidence floors hold. 0.4.6 collects evidence;
  it does not turn observed agreement into autonomous trust.
- Responses-protocol transport and intentionally deferred second-round Gemini/Kimi comparisons.

The ready CodenameWukong handoff and four-arm exploration config are
[`CARLOS-CAMUS-QUICKSTART.md`](CARLOS-CAMUS-QUICKSTART.md) and
[`CARLOS-OPEN-MODEL-EXPERIMENT.example.json`](CARLOS-OPEN-MODEL-EXPERIMENT.example.json).
