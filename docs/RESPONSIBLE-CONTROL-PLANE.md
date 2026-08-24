# Camus Responsible Control Plane

**Status:** Implemented and deterministically verified for 0.4.5; live model campaign follows

**Version:** 1.2

**Decision date:** 2026-08-23 · implementation evidence: 2026-08-24

**Sequence:** D/F foundation release 0.4.4 → deterministic control/UX/offline gate 0.4.5 →
provider-backed eval campaign → explicit human admission

## Why this feat exists

Camus already binds model identity, separates executor and auditor seats, runs deterministic
verification, records reviewer findings, and seals evidence. Open-model slices D and F add two
materially different boundaries: a network tunnel Camus owns and configurable reviewer
executors the gate may invoke. Those capabilities need one explicit control plane rather than
policy scattered across adapters and presentation code.

The governing rule is:

> Models may propose, interpret, and recommend. Camus owns authorization, stakes routing,
> evidence, and failure direction.

This is a post-RFC cross-cutting feat. It does not revise the frozen v6.1 open-model
architecture contract. Slices D and F remain bounded by that RFC, but must emit the structured
control facts this feat will consume so the integration does not require a later retrofit.

## Goals

1. Make the three independent control points visible for every governed lane:
   input screening, tool/action authorization, and output screening.
2. Route human review by stakes rather than by volume.
3. Give every enforced control a versioned owner and a reconstructable evidence artifact.
4. Keep provider refusal, Camus policy refusal, reviewer rejection, infrastructure failure,
   and human escalation mechanically distinct.
5. Preserve Camus's velocity principle: use deterministic checks first, a calibrated model
   recommendation only where interpretation is required, and a human only where stakes demand
   one.

## Non-goals

- No generic fairness, safety, or compliance badge for a provider or model.
- No claim that technical seat qualification proves retention, residency, contractual, or
  regulatory eligibility.
- No general policy-authoring platform in the first version.
- No human gate on every run.
- No model authority to weaken deterministic authorization or release constraints.
- No replacement of the existing acceptance contract, verifier, reviewer, containment, or
  provenance mechanisms; the control plane composes them.

## 1. Control checkpoints

Every governed lane records three separately versioned outcomes:

| Checkpoint | Question | Examples | Default failure direction |
| --- | --- | --- | --- |
| `input_screen` | May this request enter this lane with these declared inputs? | acceptance contract present, target/scope valid, model seat admitted, data policy satisfied | refuse or request human input |
| `action_authorization` | May this executor perform this exact action against this exact target? | SSH forward only, repository mutation allowlist, publication consent, credential use, destructive operation | fail closed |
| `output_screen` | May this result be accepted, merged, published, or presented with this standing? | schema validation, deterministic verification, independent review, provenance continuity, policy output checks | findings, inconclusive, or refuse; never silently pass |

One checkpoint cannot stand in for another. In particular, an output reviewer cannot repair a
missing tool authorization, and provider training cannot substitute for a Camus input rule.

## 2. Stakes routing

The router consumes structured facts, not a free-form confidence score alone:

- impact if the action is wrong;
- reversibility and availability of a bounded rollback;
- external side effects, including publication and remote access;
- requested data sensitivity and destination;
- deterministic evidence completeness;
- model/reviewer confidence only as an advisory input;
- explicit operator policy and prior human decisions.

It produces one constrained decision:

- `auto`: authorized controls are satisfied and the action is sufficiently low-stakes and
  reversible;
- `human_required`: execution pauses before the high-stakes or insufficiently evidenced action;
- `refuse`: a hard policy or authorization constraint is unsatisfied;
- `inconclusive`: the control could not establish its own result and must not be interpreted as
  a pass.

Hard rules dominate recommendations. Publication, destructive mutation, credential boundary
changes, unknown remote-host trust, and remote command execution cannot be downgraded to
`auto` by a model. The first implementation uses deterministic routing wherever the facts
allow it. A model-based stakes recommendation may be added only behind a constrained schema,
human-labeled calibration set, and a rule that it can escalate but cannot weaken hard controls.

## 3. Control register

The repository will carry a versioned register whose entries include:

```text
control_id
risk_addressed
owner
enforcement_point
applies_to
failure_direction
evidence_artifact
control_version
last_validated_by
revalidation_trigger
```

The register describes controls; tests prove that each control remains operational. A control
with no executable evidence is `unproven`, never silently active. Missing register coverage for
a high-stakes action is itself a fail-closed configuration error.

The owner in v1 is a repository component or explicit operator role, not a named employee. This
keeps the artifact portable while making responsibility concrete.

## 4. Evidence and status contract

Run evidence records, without secrets or unrestricted prompts:

- the action class and exact target class;
- the control IDs and versions evaluated at each checkpoint;
- each constrained outcome and mechanical reason code;
- the stakes-routing decision, source, and rule IDs;
- any human checkpoint, the evidence shown, and the human's recorded decision/reason;
- any unavailable control and the resulting failure direction.

The status vocabulary keeps these causes separate:

- `provider_refused`
- `policy_refused`
- `review_rejected`
- `control_inconclusive`
- `needs_human`
- `infrastructure_failed`

Final names must be reconciled with the existing published status schemas before sealing. No
new status may be smuggled into an immutable schema; a schema/version change follows the trust
package's published compatibility process.

## 5. Slice D and F integration hooks

### Slice D — managed SSH

Slice D must emit structured evidence for:

- alias/config preflight and directive screening;
- authoritative OpenSSH host/auth/forward result;
- forward-only argv authorization (no command, copy, agent, X11, dynamic or remote forward);
- connection ownership, lease creation, adoption refusal, and teardown;
- application liveness through the forward;
- redaction outcome and diagnostic bounds;
- tunnel death as a named infrastructure cause with no direct-network fallback.

It must not wait for this feat to enforce its security contract. The later control plane will
register and route from these already-mechanical facts.

### Slice F — generic CLI reviewers

Slice F must emit structured evidence for:

- selected backend/model/transport and accepted qualification;
- input/binding/scope/contract validation;
- executable and argument authorization;
- watchdog/adoption/replay identity;
- provider refusal versus malformed output versus infrastructure failure;
- normalized reviewer verdict and exact gate binding.

Slice F remains disabled for automatic routing until the RFC's benchmark admission criteria are
met. The control plane records that disabled state; it does not grade the backend into service.

## 6. Acceptance criteria

1. Every state-changing or externally visible lane maps to all three checkpoints, with an
   explicit `not_applicable` reason where a checkpoint truly does not apply.
2. A table-driven suite proves each hard rule cannot be downgraded by a model recommendation,
   ambient configuration, browser input, or missing control output.
3. High-stakes actions with missing, malformed, timed-out, or version-mismatched control evidence
   refuse or pause according to their declared failure direction; none becomes `auto`.
4. Low-stakes reversible actions proceed without a human when every required control is proven.
5. Human checkpoints contain the relevant inputs, evidence summary, rule IDs, and escalation
   reason; approval binds to the exact action and cannot authorize a changed target.
6. Receipts allow reconstruction of why the run proceeded, paused, or refused without broad
   environment dumps, credential values, raw SSH diagnostics, or hidden model reasoning.
7. Provider refusal, policy refusal, reviewer rejection, control inconclusive, human escalation,
   and infrastructure failure are independently testable and never collapse into `clean`.
8. Register drift is test-detectable: an enforcement point added without a registered control,
   or a registered high-stakes control with no current evidence test, fails CI.
9. The eval ledger segments routing outcomes by declared task/action class and records human
   disagreement where available; it makes no fairness or compliance claim without a separately
   approved, scenario-specific evaluation contract.
10. Existing deterministic verification, model provenance, containment, publication opt-in, and
    receipt compatibility tests remain green.

## 7. Release gate and execution order

1. Implement and audit Slice D against RFC §8, while emitting the hooks in §5. (Shipped in 0.4.4.)
2. Implement and audit Slice F against RFC §12, while emitting the hooks in §5. (Shipped disabled
   in 0.4.4.)
3. Implement the responsible control plane, Slice E connection UX, and Slice G's provider-free
   evidence gate; release those deterministic surfaces as 0.4.5 without admitting a new model.
4. Run the provider-backed routing/eval campaign after release. Measure quality, wall time, model
   time, orchestration overhead, human-route rate, false-auto cases, and inconclusive rate.
5. Admit additional automatic routing only when the measured slices are compatible, their
   evidence is reconstructable, and no high-stakes path can silently bypass a required control.
   Shipping a disabled candidate or an offline gate grants it no trusted standing.

Slices E and G remain separate product work: E provides the full connection UX; G provides the
benchmark campaign that can enable additional automatic reviewer routing. This feat consumes
their evidence when present but does not absorb their scope.

## 8. Implemented outcome

The implementation is one packaged contract shared by Studio and the CLI:

- `packages/cli/skills/camus/control-register.v1.json` is the versioned register. Its drift
  test resolves every enforcement point and evidence-test path, and every governed action
  class must cover all three checkpoints.
- `control-plane.mjs` and `scripts/control_plane.py` implement the same action fingerprint,
  evidence event, exact human-decision binding, deterministic routing, fail-closed version
  checks, and constrained cause vocabulary. A cross-language golden pins their canonical form.
- Studio records launch, publication, managed-SSH, and paid exact-tuple qualification actions in a
  mutable control receipt. Launch fingerprints bind the complete frozen dispatch decision,
  including the selected models, efforts, round cap, qualification, lane, target, and verification
  inputs. Managed-SSH evidence binds the exact immutable connection fingerprint, and every shared
  borrower must freshly prove process and application liveness before reuse.
  The receipt sits beside (never inside) the immutable evidence pack. Publication remains off by
  default, and its human decision is bound to the exact destination action before the provider call.
  Qualification is also bound to one exact seat/backend/model/connection fingerprint and leaves
  a 0600 standalone receipt; opening Setup and ordinary `--doctor` are network-free by default.
- CLI review dispatch writes input/action evidence before execution. The forensic audit adds
  output normalization and exact round/candidate binding afterward. A valid rejection remains
  `review_rejected`; malformed output is infrastructure; missing binding refuses.
- The shared evidence validator rejects secret-shaped keys/values and broad prompt, token,
  credential, or environment payloads.

The complete Studio and CLI suites pass with these controls enabled. No provider-backed run was
performed by this feature, no additional reviewer was admitted, and no published evidence-pack
schema was mutated. Slice G's offline append-only ledger and conservative statistical gate now
exist separately; the paid/provider-backed campaign remains the next evidence step.
