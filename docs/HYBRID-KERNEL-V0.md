# Technical Specification: Hybrid Kernel v0

**Status:** Implementation / dogfood  
**Target release:** Camus 0.4.0  
**Date:** 2026-08-19

## Summary

Camus 0.3 asks models to execute deterministic orchestration: load and retransmit feature
contracts, interpret checkpoints, run Git preflight, relay verifier output, merge branches, and
rewrite state. In the open-model-seats dogfood, merely resuming a saved feature consumed 12,254
Haiku output tokens before useful work began and repeatedly damaged otherwise-proven task state.

Hybrid Kernel v0 moves the control plane into local code. A model orchestrator selects and adapts
work from a compact typed envelope; the kernel owns state, identity, Git facts, verification,
receipts, recovery, trace continuity, and budgets. The existing `camus-loop` remains the maker /
independent-reviewer adapter until it can be migrated behind the same protocol.

## Goals and success measures

- Reach a selected task from a saved feature in seconds, without loading all feature contracts
  through a model.
- Never let a model write, summarize, or reinterpret canonical feature state.
- Resume safely after interruption at every kernel phase boundary.
- Retain Opus-maker / Sol-reviewer independence, binding, provenance, and deterministic verify.
- Carry at most one selected task contract across a model boundary.
- Reduce feature-orchestration wall time and output tokens by at least 50% in the Task 2 canary.
- Propagate one trace ID across kernel selection, maker, reviewer, and task receipts.

## Non-goals

- Parallel task execution or a DAG scheduler.
- Provider/open-weight/Grok implementation work.
- Studio UI changes.
- A general workflow language.
- Replacing `camus-loop` in v0.
- Push, publication, deployment, or automatic mainline merge.

## Architecture

```text
Human goal / RFC
       │
       ▼
Model orchestrator ── typed decision / one task ──▶ camus-loop adapter
       ▲                                             │ maker + reviewer
       │ compact next-action envelope                │ receipts + Git proof
       │                                             ▼
Deterministic kernel ◀──────────────────────── local evidence
       │
       ├─ canonical args + state
       ├─ feature/task identity
       ├─ Git checkout and containment
       ├─ environment + HEAD-bound verification
       ├─ merge-receipt recovery
       ├─ trace / budgets / usage
       └─ atomic checkpoints + typed stop reasons
```

The model is authoritative for semantic choices: decomposition, next useful task, review depth,
conflict handling, and synthesis. The kernel is authoritative for operational facts and whether a
transition is evidenced.

## Command contract

`camus kernel next <featId>` is read-only and emits one compact envelope:

```json
{
  "schemaVersion": 1,
  "traceId": "feature-id:a1",
  "attempt": 1,
  "action": "run_task",
  "reason": "next eligible task in the ordered feature",
  "feature": {
    "id": "feature-id",
    "branch": "camus/feat-feature-id",
    "completed": 1,
    "total": 12
  },
  "task": {
    "id": "task-id",
    "index": 1,
    "brief": "bounded summary",
    "contractRef": "feature-id.args.json#tasks/1",
    "contractHash": "fnv1a32:...",
    "branch": "camus/feat/feature-id/task-id"
  },
  "budgets": { "wallSeconds": 14400, "tokens": 120000, "retries": 2 },
  "usage": { "startedAt": 0, "tokens": 0, "retries": 0 }
}
```

`action` is exactly one of:

- `run_task`: one eligible task may be materialized and dispatched.
- `integrate`: all task nodes are terminal; feature-level verification is next.
- `stop`: evidence, dependency, state, or budget blocks progress. `reason` is mandatory.

`camus kernel task <featId> [taskId]` materializes only the selected task as `loopArgs`. It refuses
a requested task that differs from the kernel selection. Sibling context is compact briefs, not
their contracts.

`camus kernel dispatch <featId> [taskId]` is the model-call boundary. Under the feature lock it
rechecks budgets and selection, atomically moves that task to `running`, binds the trace to it, and
emits its loop arguments. Repeating the same dispatch is idempotent; another task or trace refuses.
This removes the crash window between a read-only selection and an unrecorded model launch.

`camus kernel prepare <featId>` is the mutating phase boundary. In order, it:

1. Locks the feature.
2. Validates the exact state/sidecar reference, FNV coherence, schema, feature identity, task count,
   and every task ID.
3. Resolves and verifies the repository.
4. Refuses any dirty tree before checkout.
5. Checks out only the feature branch recorded in state.
6. Recovers crash-after-merge tasks only when the `merge.sh` receipt binds the expected message,
   exact evidence commit, task-branch ancestry, and feature-branch ancestry.
7. Runs the environment doctor.
8. Runs deterministic baseline verification and requires its `head` to equal feature `HEAD`.
9. Creates or reuses a trace attempt, checkpoints budgets, and atomically writes `kernel_ready`.
10. Reloads the persisted bytes and emits their compact next action.

`camus kernel usage <featId>` records monotonic absolute token/retry counters and phase. A decrease
is refused. Reaching any configured ceiling produces `action: stop`; the kernel never silently
extends its own budget.

## Persistent state

Kernel metadata is additive under the existing feature state:

```json
{
  "kernel": {
    "schemaVersion": 1,
    "traceId": "feature-id:a1",
    "attempt": 1,
    "phase": "ready",
    "activeTaskId": "task-id",
    "repoHead": "40-hex-sha",
    "budgets": { "wallSeconds": 14400, "tokens": 120000, "retries": 2 },
    "usage": { "startedAt": 0, "tokens": 0, "retries": 0 },
    "recoveredReceipts": []
  }
}
```

Writes use an exclusive per-feature lock, temporary file, `fsync`, and atomic replace. Canonical
args remain immutable in their sidecar. Existing readers ignore `kernel`; no state rewrite is
required before first use.

## Safety invariants

- Invalid or incoherent local state produces a typed stop, never guessed recovery.
- A clean verifier result without exact HEAD binding is red/inconclusive.
- Receipt existence alone is not proof. Receipt fields and Git ancestry must independently agree.
- Task contracts are addressed by validated feature ID, index, and hash; free-form paths are never
  accepted.
- Task identity is recomputed from canonical args and must match state before any mutation.
- Usage counters are monotonic; budget exhaustion cannot be overridden by the orchestrator.
- Kernel prepare never operates on a dirty tree and never checks out an arbitrary branch.
- The kernel does not push, publish, deploy, merge to main, or perform external side effects.

## Migration and rollback

0.3 feature states are migrated lazily: the first `prepare` validates the existing state and adds
`kernel`. Existing manual `land` and `reconcile` commands remain valid recovery tools.

During v0 dogfood, `camus-feat` stays available as a rollback path, but it must not run concurrently
with the kernel for the same feature. Once the Task 2 canary and a second recovery drill pass, 0.4
will make the kernel path default and clearly deprecate model-driven feature plumbing. We will not
maintain two permanent engines while there are no external users.

## Acceptance tests

- Valid compact sidecar selects the correct task without emitting its full contract.
- Contract materialization returns only the selected task and refuses another ID.
- Hash, schema, feature identity, task count, and task identity mismatches fail closed.
- Dirty repository refuses before checkout or state mutation.
- Repeated prepare on unchanged evidence reuses one trace attempt.
- A verifier green bound to another HEAD refuses.
- Crash-after-merge recovery requires a valid receipt plus exact Git evidence.
- Token, retry, and wall-clock exhaustion each yield a typed stop.
- Usage counters cannot decrease.
- Kill/restart at prepare boundaries resumes without JSON surgery.
- Full CLI, trust, and Studio suites remain green.
- RFC Task 2 completes with at least 50% less feature-orchestration time/output than Task 1 while
  retaining independent review and deterministic verification.

## Release decision

Passing the canary makes this Camus 0.4.0. The version bump, changelog, removal/deprecation of the
old default path, and release commit happen only after the dogfood evidence is reviewed. Push and
publication remain explicit human actions.
