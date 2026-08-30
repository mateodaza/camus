# Productive-loop dogfood 2 — bounded context thrash, no implementation

Date: 2026-08-30. Frozen baseline: `b18a4ccb2fb3a33660008179e7d7b0318c1566aa`.
Run: `code-1788130529823-8ff451b5`. Private receipts remain on the operator's
machine; no raw prompt, checkpoint, provider output, credential, or private path
is published here.

## Contract and bounds

The run retried the same offline `camus build --inspect RUN_ID [--json]` feature
contract used in the first productive-loop dogfood. It required one authenticated,
read-only checkpoint projection, deterministic safe next-action guidance, shared
CLI/Studio behavior, package extraction, integrity/privacy failures, and no
provider, worker, Git, run-state, admission, routing, publication, or landing side
effect.

- Maker: `claude:claude-opus-4-8`, medium effort, `file_actions`, authenticated
  Claude subscription route.
- Reviewer selected: `codex:gpt-5.6-luna`, medium effort, authenticated ChatGPT
  route. **The reviewer never ran.**
- Limits: 18 calls, 14 maker steps, 40 actions, two repairs, one retry,
  400,000 accounted tokens, 20 active minutes, and five minutes per call.
- No uncertain replay, extension, automatic repair, commit, merge, push,
  publication, admission, or routing change was authorized.

## Observed outcome

| Measure | Observed |
| --- | --- |
| Successful / uncertain maker calls | 8 / 1 |
| Host actions | 21: 2 lists, 19 reads, 0 mutations |
| Unique source bodies | 11 files, 175,876 bytes |
| Exact duplicate reads | 8 reads, retransmitting 92,221 bytes |
| Observed / accounted tokens | 182,041 / 214,809 |
| Active / model time | 518.5 / 515.6 seconds |
| Candidate diff | empty |
| Verification / reviewer calls | 0 / 0 |
| Terminal | `needs_decision`, uncertain call after the exact five-minute ceiling |

Calls one through six listed 400 tracked paths and collected 11 distinct source
files. Calls seven and eight re-read unchanged files, including one duplicate path
twice in a single response. The 131,072-byte maker context could not retain all
175,876 source bytes: the final compacted prompt was 105,539 bytes and omitted two
bodies. Call nine ran for 300.15 seconds and produced no durable response, so its
intent is unknown and is not inferred.

Safety behavior was correct. Camus terminated the owned process at the frozen
ceiling, conservatively retained one unknown-call reservation, preserved the clean
candidate, refused automatic replay, and did not invoke verification or review.
Productivity failed: the feature was not implemented, so this run is neither a
model-quality result nor evidence that the maker/reviewer pairing works.

## Bounded offline follow-up

The existing unchanged-evidence circuit did not catch a maker that kept gathering
new files before cycling back to old ones. The shared context projection now also
tracks consecutive mutation-free discovery. Four such steps warn the maker to
implement, identify one specifically missing fact, or stop; seven park the run
before another provider call and recommend a narrower contract or native harness.
Exact no-new-evidence behavior remains separately bounded. Tests prove that either
kind of stagnation stops without spending the full call allowance and that an
actual mutation resets only the progress observation, never the real budgets.
The new runway is checkpoint-bound for fresh runs. Existing version-2 runs keep
their prior prompt rendering and stop policy so a durable paid response remains
usable; unknown or stripped policy state refuses before provider authorization.

The requested `--inspect` feature was then implemented directly and is validated
independently; that manual follow-up does **not** retroactively make this dogfood
successful. Ranged/symbol search for `file_actions` remains a possible later
retrieval improvement. Until it is designed and evaluated, broad cross-file tasks
should prefer a reviewed native harness or be decomposed into smaller contracts.
