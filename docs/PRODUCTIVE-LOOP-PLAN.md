# Productive Loop — service contract and next implementation plan

Date: 2026-08-28. Baseline: 0.4.8, commit `745f51d`.
Status: A–C and the isolated native-maker boundary are included in 0.4.9. The first live
dogfood on frozen commit `e8df8dd` failed productively: safe budget stop, but no
feature code. It exposed a context-rollover/discovery loop missed by synthetic
coverage. See [the attempt and bounded follow-up](DOGFOOD-PRODUCTIVE-LOOP-1.md).
No model admission or release-readiness claim follows from this attempt.

Native-maker follow-up (2026-08-28, released experimentally in 0.4.9): a bounded `codex_native` maker
executor is now integrated behind both entry points, with raw file actions still
the default. Codex owns its tool/context session; Camus retains the frozen task,
candidate, verification, advisory review and acceptance boundary. The initial
native/file-action pilot did not produce an accepted candidate; it justified an
integration experiment, not a performance claim. The subsequent authorized
integrated run is recorded separately below. See [the opt-in contract and limits](INDEPENDENT-CODE-SEATS.md#opt-in-native-makers-released-experimentally-in-049).

Additional offline coverage: native protocol/configuration/auth refusals, live
usage deltas and budget interrupts, real Codex sandbox and descendant cleanup
without generation, host SIGKILL, repair/review binding, ignored-file refusal,
packaged runtime and Studio→CLI native-candidate continuation. A completed native
turn can resume; uncertain mid-turn writes refuse automatic adoption/replay.
The [single frozen provider-backed native attempt](DOGFOOD-NATIVE-MAKER-1.md)
stopped after 177.925 seconds at the original accounting budget. It produced a
partial candidate but never reached verification/review; the independent
post-stop acceptance check failed. Two zero-generation preflight defects were
fixed and regression-tested. No extension, acceptance or automatic repeat follows.
Useful provider-backed end-to-end completion remains an unmet evidence gate for
quality admission and routing, not for the experimental infrastructure release.

Next-adapter priority (operator decision, 2026-08-28): **Grok Build and Qwen Code**,
not additional Codex feature expansion. Keep the existing raw API adapters;
evaluate model + harness combinations, not model names alone. Native execution
does not change the verification, advisory review or human acceptance boundary.

Interface research completed: [Qwen Code first, Grok Build next](NATIVE-HARNESS-INTEGRATION-NOTES.md).
Both have official automation interfaces. The pinned source/binary probes found
that provider credentials survive ordinary shell isolation and Grok's stock path
can request an unselected helper model. Those boundaries were treated as release
blockers rather than hidden behind a generic CLI wrapper.

Executable qualification follow-up: [the pinned Qwen/Grok probes](NATIVE-HARNESS-QUALIFICATION-1.md)
confirm both stock launch paths expose synthetic provider credentials to shell
tools and fail the tested filesystem/network boundaries. Grok also attempted an
unselected session-title model, and a cancelled run returned exit zero. The
development fixture is repeatable; its classifier is covered by eight cheap
root-suite tests.

Shared-boundary follow-up (same date): a host-owned, one-model gateway now keeps
the real provider key outside an outer macOS Seatbelt worker. Candidate/scratch
are the only private writable roots; source, receipts, protected tracked files,
Git metadata, arbitrary localhost and external network are denied. Requests are
path/model/capability bound, upstream headers are rebuilt, response identity is
validated before forwarding, usage is accounted, and gateway shutdown aborts
in-flight upstream work. Qwen Code 0.22.3 and Grok Build 1.0.5 artifacts are
digest-pinned and have separate exact JSONL terminal/session parsers. Both shared
CLI/Studio picker paths are implemented without changing raw API adapters. The
production supervisor completed the same synthetic candidate edit through each
pinned vendor CLI in about two seconds total; no credential or paid call was used.
This closes boundary/protocol enablement for an experimental release, not model
quality, latency or best-combination admission. Provider-backed combination
dogfood is the next evidence step.

Implementation evidence (2026-08-28):

- `lib/productive-code-loop.test.mjs`: real local test failure → redacted feedback
  → repair → passing recheck → fresh review; review repair, bound questions,
  context rollover, token accounting, timeouts, concurrency and drift refusal.
- `lib/code-crash-recovery.test.mjs`: actual SIGKILL/restart windows around
  provider persistence and every file-action kind, plus verifier cleanup after host death.
  Recovery invalidates pre-edit verification/review evidence before any further
  model call, including when the recovered run immediately reaches its budget.
- `productive-build-api.test.mjs`: real CLI/HTTP/engine continuation in both
  directions with the same ID/worktree, server restart, answer and stop. Only
  provider adapters are scripted. `packages/cli/test_code_runtime.mjs` also
  executes/resumes the extracted npm artifact and tests offline setup.
- Browser: reversed Luna/Claude fixture, one-call budget stop, reload/reattach,
  explicit extension, same-candidate completion at three calls. This found and
  fixed native-gate-only setup assumptions and misleading advisory handoff/history copy.
- Full Studio and CLI/root regressions, including the unchanged native 672
  workflow and 37 planning assertions, plus the landing build. No paid dogfood
  work is represented by these synthetic tests.

The developer guide is [Independent coding seats](INDEPENDENT-CODE-SEATS.md).
0.4.9 releases the experimental infrastructure. Carlos's actual supported
environment and the exact live pair/task/spend allowance remain decisions for the
next provider-backed handoff.

This is the active next-work plan. It operationalizes
[Compare & Learn](COMPARE-AND-LEARN-DIRECTION.md), not a new architecture or a
replacement for the [responsible control plane](RESPONSIBLE-CONTROL-PLANE.md).
Freeze feature expansion while completing this journey. Do not call the code
frozen, the models admitted, or the next dogfood successful because this plan exists.

## 1. The service contract

Camus carries an authorized task toward a useful, evidenced result, preserves work
through interruptions, and asks a human only for a decision the run cannot safely
make under its existing authority. A safe halt is an honest outcome, not a completed task.

- The user owns the goal, acceptance criteria, model choices, data boundaries,
  spending limits, and authority for consequential actions.
- Models own implementation reasoning and semantic recommendations. Their
  capability and price vary; Camus must not quietly substitute a model or claim
  that a stronger model makes a broken execution protocol reliable.
- Camus owns custody, authorized actions, verification, review provenance,
  recoverability, useful feedback, and honest progress/usage reporting. Duplicate
  calls, discarded work, needless reviews, and avoidable interruptions are Camus
  costs, not something to attribute entirely to model choice.
- Optimize for a result meeting the quality floor, with justified effort. Complex
  work may legitimately take longer. Elapsed time, tokens, and extra rounds are
  observations, not proof of failure or progress by themselves.
- Let models choose useful next work within the contract. Let code enforce
  authority, budgets, artifact bindings, and mechanically decidable checks.
  Do not add a model call to every transition or force every run through N rounds.
- Preserve human authority without requiring human supervision of ordinary
  implementation, test failures, concrete review fixes, and recoverable transport errors.

The target journey is:

```text
configure once → freeze task / pair / authority / budget → implement
  → test and review → evidence-backed repair or continuation when useful
  → fresh closure on the final candidate → one acceptance handoff
```

Human acceptance of an experimental candidate remains necessary. This plan does
not admit an external code gate, authorize auto-merge/publication, or let a
controller weaken security rules. The native gate retains its existing authority.

## 2. What 0.4.8 does not yet finish

Source inspection, not inferred feature parity:

| Shipped boundary | Consequence | Next-work location |
| --- | --- | --- |
| `runCodeSeats` stops at failed verification or a `REVISE` verdict | A selectable maker/reviewer pair is not yet a self-correcting loop | [code-seats.mjs](../apps/loop-studio/lib/code-seats.mjs) |
| `createCodeVerifier` counts and discards stdout/stderr | Adding a repair turn alone would not give it actionable test diagnostics | [code-seat-verify.mjs](../apps/loop-studio/lib/code-seat-verify.mjs) |
| Maker history is in memory; each turn resends it; reads exclude run-created files | Restart and longer-task continuation need an actual state/context contract | [code-seats.mjs](../apps/loop-studio/lib/code-seats.mjs) |
| The engine has fixed step/action/time defaults; launch surfaces do not expose an equivalent policy | Task complexity cannot be handled simply by increasing every cap | [code-build.mjs](../apps/loop-studio/code-build.mjs), [independent-code-lane.mjs](../apps/loop-studio/lib/independent-code-lane.mjs) |
| Studio refuses independent Build resume; external CLI setup/qualification directs users to Studio | Execution is shared, but the complete user journey is not yet shared | [server.mjs](../apps/loop-studio/server.mjs), [code-seat-launch.mjs](../apps/loop-studio/lib/code-seat-launch.mjs) |
| Coding-combination coverage is hermetic, not a live task campaign | Availability and text qualification cannot be advertised as proven coding reliability | [0.4.8 boundaries](RELEASE-0.4.8.md) |

The native driver already has bounded semantic closure decisions, durable
handoffs, budget accounting, and recovery. Reuse its contracts and regression
fixtures; do not replace it or build a second always-running supervisor.

## 3. Research: borrow mechanisms, not another platform

Primary sources checked on 2026-08-28. These are documented mechanisms and product
claims, not independently measured comparisons with Camus.

| Reference | Relevant mechanism | Decision for Camus |
| --- | --- | --- |
| [Aider: linting and testing](https://aider.chat/docs/usage/lint-test.html) | Test/lint failures can feed automated correction | Supply safe, concrete diagnostic evidence to a bounded repair turn |
| [OpenHands: persistence](https://docs.openhands.dev/sdk/guides/convo-persistence), [pause/resume](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume) | Conversation identity, execution state, events, and usage survive sessions | Persist enough host state to continue the same candidate; keep Camus state outside the project and do not copy its credential-persistence policy |
| [OpenHands: stuck detection](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) | Repeated action/observation and error patterns identify unproductive work | Use repetition as an observed signal, then bounded recovery or a justified stop; do not treat mere duration as stuck |
| [LangGraph: checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | Completed steps survive partial failure; durability modes make crash tradeoffs explicit | Persist authority-relevant results before dependent work and avoid replaying known-completed actions |
| [Anthropic: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Incremental tasks, durable progress, and end-to-end testing address context/session failures | Keep a source-bound progress capsule and validate the actual user journey, not just unit tests |
| [Marshall](https://marshall.agention.ai/) | Presents mixed model roles, interrupt/steer, and a headless engine behind its terminal | Make model choice and continuation ordinary product capabilities; do not copy per-tool model authorization or add an agent team by default |

Inference: the missing pieces are feedback, state continuity, and completion
policy in the existing engine. No Redis/IRIS memory service, LangGraph/Temporal
migration, new scheduler, or subagent platform is justified by these findings.

## 4. Human-interruption policy

Reuse the control plane's hard rules; a model recommendation cannot downgrade them.
All retries remain within the initial authorization and global budget.

| Situation | Expected handling |
| --- | --- |
| Concrete test failure or actionable review finding within scope | Supply evidence; let the maker repair or rebut; recheck the changed candidate without asking for routine permission |
| Known transient failure with a replay-safe operation | Bounded backoff/recovery; retain the failed attempt and continue without a human prompt |
| Healthy long-running work within authorized limits | Continue and expose phase/progress; do not interrupt merely because the task is difficult |
| Repeated equivalent failures with no new evidence | One bounded semantic recovery decision if useful; otherwise preserve work and explain why another attempt is not justified |
| Materially ambiguous goal, irreducible review disagreement, or a required scope change | Ask one concrete question with the evidence and a recommended option |
| New authority, credential/host-trust change, insufficient budget, or a high-stakes action | Stop before the action; request the missing decision once |
| Custody, identity, or evidence integrity cannot be established | Fail closed; perform safe diagnostics only; never spend more maker/reviewer turns to conceal the breach |
| Final experimental candidate is ready | One acceptance handoff with tests, review standing, remaining risks, and the exact candidate |

Separate progress notifications, retriable infrastructure status, terminal failure,
and an actionable human question. A controller/parser failure is infrastructure,
not automatically a semantic dilemma. Repeated prompts for the same outstanding
decision are not progress. Bind human answers to the exact question and candidate.

## 5. Implementation order

Implement directly with focused deterministic tests first. Do not use an expensive
dogfood session to develop its own missing recovery mechanism. The final live
dogfood starts only after work packages A–C meet their acceptance checks.

### A. Close one productive repair cycle

The first checkpoint must demonstrate useful correction in a hermetic end-to-end
test, not just another storage abstraction. It is not separately release-ready
until B and C prove continuation and the user surfaces.

1. Add a bounded diagnostic envelope to verification: failure classification,
   test/check identifier, safe relative source location where available, redacted
   message, completeness indicator, and the command/candidate binding. Parse
   structured results when available; never blindly forward terminal logs.
   Candidate-controlled diagnostic text remains untrusted data, not instructions.
   Redaction is defense in depth, not a universal no-secrets guarantee.
2. Distinguish actual failing checks from timeout, unavailable toolchain,
   cancellation, and inconclusive output. Environment failure must not trigger
   speculative edits to the product. Keep the verifier command frozen; a model
   cannot weaken required checks to manufacture a pass or turn diagnostics into
   shell authority. Scope-authorized test additions/updates remain allowed and reviewed.
3. Add repair/continue/recheck handling to the shared engine, not separate CLI/UI
   loops. Test failures and concrete reviewer findings return to the maker with
   the original contract intact. A rebuttal needs evidence; disagreement alone
   cannot erase a finding or satisfy acceptance. Permit safe re-reading of files
   created by this run, so a repair can inspect its own earlier implementation.
4. Reuse the native closure vocabulary where applicable (`fix_recheck`,
   `retry_verify`, `human`, `stop`). A constrained model decision is warranted at
   a semantic fork, not at every file read, poll, or successful check. Its declared
   identity and usage count toward the run budget; no unrequested third model.
5. A retry must name a new reason/evidence or a classified transient condition.
   Track equivalent failure signatures and candidate changes. Code churn or
   token output alone does not reset the no-progress counter. Any bounded recovery
   decision consumes the same global limits; nested retries cannot reset them.
6. After an edit, invalidate the old verification/review binding. A final clean
   advisory candidate needs passing required checks and a review of that exact
   revision. Preserve native `fix_verify`/fixed-unreviewed semantics; do not
   introduce a new shortcut that labels an unreviewed fix clean. Every attempt
   retains its identity, usage, and terminal reason. The host validates each
   proposed action against authority before execution.

Primary files: `code-seats.mjs`, `code-seat-verify.mjs`, adapters only for typed
failure information, and tests paralleling `drive.py` closure invariants. Preserve
native workflow behavior; no full port or replacement of `feat_kernel.py`.

### B. Make continuation, budgets, and context durable

1. Extend the private run directory with versioned checkpoints and an append-only
   action/attempt journal. Bind run, source/worktree, candidate, contract, model
   tuples, connection/credential revisions, policy, budgets, and prior results.
   Persist checkpoints atomically; use one host-owned writer/lease across CLI and Studio.
2. Journal host writes before applying them. Recovery compares pre/post hashes:
   recognize an already-applied action, apply an unapplied authorized action, or
   refuse unexplained drift. Never execute a model-generated action twice blindly.
3. Persist completed provider responses before applying their actions. An in-flight
   request without a durable response is `uncertain`, not free and not completed.
   Reattach where the executor supports it. Otherwise regeneration needs the
   frozen retry policy and a conservative reservation for possible duplicate spend;
   do not promise exactly-once provider billing. An interrupted verifier can be
   rerun only under its declared repeatability policy; an arbitrary shell command
   is not automatically idempotent because it was named a test.
4. Reconstruct a bounded context capsule from host state: unchanged goal/contract,
   current file hashes, remaining work, open findings, and last useful observations.
   Preserve evidence references; never turn a model summary into authoritative
   completion. Add bounded file discovery and preserve access to referenced safe
   evidence. Keep old audit evidence immutable and avoid stale pre-edit context.
5. Distinguish phase timeout, inactivity detection, and total authorized work.
   Expose per-run limits through both surfaces. Complexity may inform a proposed
   budget, never authorize its expansion. Show human-wait time separately from
   active/model/verification time. Do not silently raise hard limits on resume.
6. Reconnection and recovery resume the same known checkpoint, not planning from
   scratch. Explicit user cancellation requires an explicit resume; an authorized
   transient recovery can continue automatically. A restarted UI attaches rather
   than buying another maker/reviewer turn.

Primary files: `code-seats.mjs`, existing private atomic-write helpers, adapter
session hooks, and small local journal/context modules if separation makes testing
easier. Do not change the sealed trust schemas or include journals in the project.

### C. Make CLI and Studio one usable product journey

1. Expose the same task, two model selections, budget, verifier, progress, stop,
   answer, and resume policy from thin launch surfaces. Use one run ID and the
   shared journal; two clients must not create two workers. Keep native recovery
   IDs separate, and never route a new candidate into the legacy gate implicitly.
2. Add a thin CLI setup/qualification path using the existing connection and probe
   layer. GUI setup remains optional; hosted-only CLI use must not require a
   Studio checkout/server or unrelated vendor CLIs. Qualification that calls a
   provider requires explicit consent; configuration/list/status are spend-free.
3. Resolve credentials privately at execution time. Record references/revisions,
   not values. Resume checks frozen identities and bindings; changed models,
   endpoints, contracts, or credentials require the appropriate new authorization
   or run, not silent reinterpretation of old receipts.
4. UI reconnect, server restart, and CLI reattachment recover the actual status.
   Display last activity and current ownership without implying a stopped worker
   is running. Only actionable blockers open the human-decision UI.
5. Preserve 0.4.8 history: old independent runs lack the new journal and remain
   inspect-only. No synthetic backfilled checkpoint or native success claim.
6. Cold-start test the packed npm artifact and Studio on the supported environment.
   Determine Carlos's actual OS/toolchain before promising that journey: automatic
   independent verification is currently POSIX-only. Windows support or an agreed
   supported environment is a real scope decision, not a documentation footnote.

Primary files: `code-build.mjs`, `independent-code-lane.mjs`, `server.mjs`,
`public/app.js`, `public/run-ui-policy.mjs`, shared connection/probe helpers,
`packages/cli/bin/camus.js`, runtime packaging tests, and the Carlos quickstart.
Update help and the handoff from executed examples, not aspirational command names.

### D. Restart meaningful dogfood, then decide whether to freeze

First pass all deterministic acceptance checks below. Then freeze the tested
Camus revision for the run. Use a new run ID; do not resume or relabel the assisted
calibration feature as an autonomous success.

The first live dogfood should finish one small, real Camus backlog item. Suggested
contract: an offline inspector for the new coding-run journal that explains the
current state, candidate, and next safe action, with no provider calls or writes.
Leave that feature for the dogfood rather than implementing it beforehand. Pin
its exact CLI/API shape and tests once A–C stabilize; this is not a shipped command.

Before launch record available exact model IDs, authorization, a per-task
time/token/call budget, verification command, and expected human checkpoints.
Include a currently available Luna configuration and a hosted Qwen or Grok pairing
in the bounded validation set; do not invent IDs or silently substitute models.
No model ranking is implied. The supervising agent waits for host-owned terminal
signals; it does not poll through paid model turns or manually implement the task.

If that run completes without harness surgery, run the small exploratory A/B
pilot: three matched tasks (simple/balanced/difficult), a direct-agent reference,
and two Camus configurations. Nine runs is a maximum initial matrix, not an
automatic spend commitment. Freeze the concrete tasks, fixtures, reference model,
execution policy, and aggregate budget before launch. Check the first completed
block before proceeding; stop expansion when the evidence says the path is broken.

Use the same task/base/acceptance checks for each comparison; record tool/context
differences. A direct-agent comparison with a different maker cannot isolate
Camus overhead. Record the result as a combined treatment instead. This pilot is
exploratory, not formal calibration, a universal winner, or routing admission.

Measure separately: accepted contract outcome; test/review results; avoidable
human interruptions; operator rescue; active and paused wall time; model and
verification time; context/retry/controller overhead; reported usage and billing
coverage. Missing spend is unknown. Keep failures, halts, and assisted attempts
in the record. Judge quality before comparing cost or speed; use code graders
first and actual human acceptance for subjective checks, not proxy-human labels.

## 6. Deterministic acceptance checklist

- [x] Test failure → useful redacted evidence → repair → passing recheck → current
  review, with no routine human question and no changed acceptance contract.
- [x] Reviewer finding → repair or evidence-bound rebuttal → justified closure;
  a material unresolved ambiguity produces one durable human question.
- [x] A slow, progressing run stays active inside its budget; repeated equivalent
  failures stop or recover within the same budget. No dummy controller calls.
- [x] Kill/restart before and after provider response persistence and each host
  action: no duplicated known-completed action, lost candidate, or reset allowance.
- [x] Uncertain provider response, transient outage, invalid protocol, cancellation,
  and missing toolchain remain distinct; none becomes a clean verdict.
- [x] Two concurrent resumes cannot both work. Candidate/config/identity drift
  refuses before another provider call or repository mutation.
- [x] Budget exhaustion preserves work and requests only the missing authority;
  explicit cancellation cannot auto-restart. Owned child processes are cleaned up.
- [x] Context rollover preserves the contract/open findings and uses current file
  hashes, including new files. Oversized/unavailable evidence cannot read as covered.
- [x] Adversarial diagnostic output cannot leak known secrets, issue tool commands,
  authorize broader access, or silently truncate coverage into a passing result.
- [x] Fresh npm and Studio flows can select both roles, inspect progress, and
  continue a supported run with the same semantics. No hidden local configuration.
- [x] Experimental results cannot enter admitted-gate evidence or change admission,
  routing, commit/merge/publication authority. Existing native regression suite stays green.
- [x] The complete CLI/Studio suites, package extraction, actual browser journey,
  and landing build pass before live dogfood starts.

Extend existing `lib/code-seats.test.mjs`, `independent-build-api.test.mjs`,
`packages/cli/test_code_runtime.mjs`, privacy/identity/qualification tests, and
native controller fixtures. Add focused verifier/journal/recovery tests where
missing. Wire new tests into normal suites; a test file alone is not coverage.

## 7. Scope, decisions, and freeze gate

Defer new providers, remote execution, automatic task routing, the large admission
campaign, broader subagent orchestration, new memory infrastructure, and a general
policy platform. Keep their existing safeguards; deferral is not permission to
lower admission/calibration thresholds. Keep the native executor path available;
do not claim the generic file-action adapter has identical capabilities.

Open decisions needed only at their boundary: Carlos's OS/toolchain; exact live
pairs and available quota; task-specific/aggregate dogfood budget; any expansion
needed after a measured failure. Do not ask a human to decide internal function
names, ordinary repair steps, or retries already covered by the launch policy.

Work in the A → B → C → D order. End each package with executable acceptance
evidence, not another architecture review. Re-estimate after A proves an actual
repair cycle; durable recovery in B remains the largest uncertainty. No completion percentage
or guaranteed multi-day finish is justified before those tests pass.

Freeze a supported alpha only when both entry points complete real work without
live rescue, recovery preserves known-completed work, all required checks bind to
the final candidate, and interruptions match the declared policy. A long complex
run may pass; a fast false-green or frequent manual rescue may not. If a defect
requires harness surgery during dogfood, preserve the attempt as assisted/failed,
fix it with a regression, and buy a fresh proof only when the evidence justifies it.

Carlos's handoff then includes the exact tested installation path, supported
environment, tested pairings, known limitations, and one working example. Release
and outreach follow that evidence; publishing alone is not the readiness gate.
