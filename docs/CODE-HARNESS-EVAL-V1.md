# Technical Specification: Code Harness Evaluation v1

**Document status:** North-star contract; only the v1a native-smoke cut below is approved for implementation  
**Provider campaign status:** Pending an explicit operator-owned call and budget authorization  
**Version:** 1.0  
**Date:** 2026-08-29  
**Scope:** Camus CLI and Loop Studio shared Build runtime  

## Implementation decision: v1a before the platform

The full contract below remains the target for controlled raw/native A/B work,
but it is intentionally **not** the prerequisite to the first two native smokes.
Camus must prove the live Qwen Code and Grok Build paths before investing in a
general experiment platform.

The approved v1a cut contains only:

- one exact `native_smoke` cell per invocation;
- a provider-free `fixture` inspection that selects a tracked case and emits the
  exact fixture bindings needed to author that cell;
- a frozen model, connection/qualification, harness artifact and version,
  reviewer, verifier, fixture, and budget binding;
- provider-free `plan` and `status`;
- `run --allow-provider-calls --max-cells 1` with no wider live default;
- a durable pre-call marker, terminal receipt, and spend-free `recover
  --action seal-infra` that never replays an uncertain cell;
- two synthetic base-red/reference-green fixtures using the production Build
  engine: `simple-bounded-parser-fix` and the provider-free
  `balanced-job-event-scheduler`, plus fake-provider Qwen/Grok integration tests;
- a mechanical candidate-integrity floor that permits edits only to the source
  paths declared by the selected fixture's reference files;
- redacted exact-identity evidence and a single allowed standing:
  `execution_observed`, `failed`, or `unknown`.

Raw arms, isolation pairs, counterbalancing, matched raw/native execution,
multi-case scheduling, aggregate metrics, `summarize`, task-class coverage,
calibration, recommendations, and routing are v1b+ work. The second fixture
allows one balanced native-smoke observation; it does not implement a comparison
or satisfy balanced-class coverage. V1a cannot write model settings, admission,
routing, Git refs, publication state, or a winner claim.

## Executive summary

Camus 0.4.9 can run the same qualified OpenAI-compatible maker through either
Camus's raw `file_actions` protocol or a native coding harness (`qwen_native` or
`grok_native`). It cannot yet compare those paths as a controlled experiment.
The existing eval systems measure legacy Claude feature runs, prose-generation
pairings, or reviewer admission; none bind the complete coding harness treatment.

This specification adds a separate, provider-neutral **Code Harness Eval v1**.
It freezes a coding campaign before spend, schedules counterbalanced raw/native
cells, executes only an explicitly bounded number of cells, preserves every
attempt in an append-only ledger, and reports quality, latency, usage, and
intervention evidence without admitting a reviewer or changing routing.

The first implementation is entirely spend-free: schemas, validation,
scheduling, crash recovery, synthetic fixtures, fake-provider integration tests,
and reporting. Real Qwen and Grok campaigns require a later explicit operator
decision that names the maximum cells and provider-call budget.

## 1. Problem and context

### 1.1 Current product state

The shared Build engine already provides:

- independent maker and reviewer selection;
- a default host-mediated `file_actions` maker;
- opt-in `qwen_native` and `grok_native` makers;
- exact model, endpoint, qualification, credential-revision, verifier, candidate,
  budget, and executor bindings within one run;
- a private candidate, deterministic verification, independent advisory review,
  bounded repair, durable continuation, and final human acceptance;
- native harness artifact/version pins and a host-owned exact-model credential
  gateway.

The existing evaluation systems answer different questions:

- the legacy CLI eval ledger compares Claude background-maker configurations;
- Studio's routing campaign compares tool-free prose maker/reviewer pairings;
- Slice G compares reviewer candidates against a seeded code-review corpus and
  controls production reviewer admission.

None can answer the next product question honestly:

> For one exact model, provider route, reviewer, task, verifier, and budget, does
> the native coding harness produce more useful accepted work than Camus's raw
> file-action path, and at what latency and token cost?

### 1.2 Failure if this is not separated

Adding a `harness` label to an existing report is insufficient. It would permit
unequal endpoints, budgets, semantic task envelopes, reviewers, fixtures, or
harness versions to be pooled as if only the harness changed. It would also risk treating a small,
uncalibrated median difference as an automatic-routing winner.

Code Harness Eval is therefore a distinct evidence domain. Its receipts may
inform a future routing design, but v1 has no authority to mutate routing,
admission, saved pairings, or defaults.

## 2. Goals

### G1. Isolate the harness treatment

Compare raw and native execution only when model, provider route, reviewer,
fixture, contract, verifier, and budgets are equal. The only intended treatment
difference is the maker executor and its necessarily associated harness identity.

### G2. Freeze before spend

Content-address the complete campaign and private execution snapshot before the
first provider call. A changed campaign or execution tuple creates a different
generation and cannot reuse prior evidence.

### G3. Make every attempt durable

Record successful, failed, timed-out, interrupted, inconclusive, and
human-assisted cells. No failure may disappear from a denominator, and no crash
may silently buy the same cell again.

### G4. Optimize quality and velocity in that order

Deterministic correctness and candidate integrity are hard floors. Latency,
tokens, calls, and cost are compared only among mechanically valid outcomes.
Independent model review is reported by exact screen and standing; an
uncalibrated judge does not become truth because it returned a confident verdict.

### G5. Bound spend and operator attention

Planning, status, summaries, fixture checks, and synthetic-provider tests make no
paid call. A live command must contain explicit provider-call consent and a
positive `--max-cells` bound. Unknown usage remains unknown, not zero.

### G6. Preserve Camus's service contract

The evaluator reuses the shared Build engine. It does not create a weaker coding
path, land code, publish artifacts, weaken human acceptance, or let the evaluated
model change the evaluator.

## 3. Non-goals

Code Harness Eval v1 does **not**:

- admit Qwen, Grok, or another external model as a production reviewer;
- enable automatic Build routing;
- alter Studio or CLI saved maker/reviewer choices;
- name a universal best model or harness;
- compare different models as though it were a harness-isolation experiment;
- compare different provider endpoints, qualification generations, reviewers,
  verifiers, semantic task envelopes, or budgets within an isolation pair;
- provide a provider-enforced dollar cap when a provider exposes no such control;
- run an unattended full matrix;
- use private customer repositories as its initial corpus;
- install harnesses or dependencies automatically;
- treat tool activity, process exit zero, or a model's self-report as useful
  completion;
- replace Slice G reviewer admission or Studio judge calibration;
- make native reviewer harnesses selectable;
- solve statistical promotion or task-class routing in v1.

## 4. Product principles and invariants

1. **One explicit cell at a time.** The operator chooses a bounded batch; the
   runner never expands it.
2. **All evidence is generation-bound.** Campaign, private execution state,
   fixture, arm, and repeat are content-addressed.
3. **A failure is data.** Infrastructure failures and human interventions remain
   visible and count against autonomous completion.
4. **Quality before economics.** A cheap red result cannot outrank a green result.
5. **Screen-specific judgment.** Review evidence is named by the exact reviewer
   screen. Cross-screen comparison requires later human calibration.
6. **No silent treatment drift.** Model, executor, harness, endpoint, reviewer,
   verifier, or budget drift refuses before a provider call.
7. **No automatic repeat after uncertainty.** An unknown paid outcome consumes its
   cell until explicitly sealed as infrastructure failure.
8. **No authority side effects.** The evaluator cannot write reviewer admissions,
   routes, model defaults, or operator selections.

## 5. Terminology

| Term | Definition |
| --- | --- |
| Campaign | A public/non-secret, immutable experimental design. |
| Execution snapshot | Private, machine-local binding of the campaign to exact qualified connections, credential revisions, harness artifacts, and installed Camus runtime. |
| Generation | The pair of exact campaign and execution-snapshot digests. |
| Case | One versioned coding task, acceptance contract, synthetic fixture, and deterministic verifier. |
| Arm | One complete maker-executor plus reviewer configuration. |
| Isolation pair | Exactly two arms intended to differ only by raw versus native maker executor. |
| Cell | One `(generation, case, arm, repeat)` assignment. |
| Attempt | The one allowed execution of a cell. |
| Receipt | Immutable, content-addressed result of an attempted cell. |
| In-flight marker | Durable pre-call record proving a cell may already have incurred provider spend. |
| Raw arm | Maker executor `file_actions`. |
| Native arm | Maker executor `qwen_native` or `grok_native`. |
| Mechanical floor | Deterministic and custody conditions that do not depend on an LLM judge. |
| Screen floor | Mechanical floor plus a clean result from one exact independent reviewer screen. |

## 6. Architecture

```text
tracked campaign + tracked synthetic fixtures
                    |
                    v
        spend-free plan/validator
                    |
                    +--> private execution snapshot
                    |      (qualification, credential revision,
                    |       harness/runtime/policy digests)
                    v
          deterministic scheduler
                    |
          explicit run --max-cells N
                    |
                    v
      existing shared Camus Build engine
       maker -> verifier -> reviewer -> human handoff
                    |
                    v
    private report + append-only codebench ledger
                    |
                    v
           read-only segmented summary
        (no admission or routing mutation)
```

### 6.1 Components

The spend-free implementation should introduce narrowly scoped components rather
than fork the Build engine:

- campaign and receipt validators;
- fixture materializer and readiness validator;
- private execution-snapshot builder;
- deterministic counterbalanced scheduler;
- in-flight marker and recovery logic;
- a thin runner that invokes the shared code-seat preparation and productive
  code loop;
- append-only ledger writer;
- read-only summary generator;
- CLI dispatcher for `plan`, `status`, `run`, `recover`, and `summarize`.

The runner must not implement a second maker/reviewer protocol or a second
candidate custody system.

## 7. Versioned campaign contract

### 7.1 Campaign envelope

The logical campaign contract is `code-harness-campaign/v1`:

```json
{
  "schemaVersion": 1,
  "treatmentProtocol": "code-harness-eval-v1",
  "campaignId": "qwen-raw-vs-native-simple-v1",
  "campaignMode": "isolation_pair",
  "standing": "exploratory_only",
  "purpose": "Isolate file_actions versus qwen_native for one exact Qwen seat.",
  "cases": [],
  "isolationPairs": [],
  "executionSmokes": [],
  "controls": {},
  "claimPolicy": {}
}
```

Validation requirements:

- `schemaVersion` is exactly `1`.
- `treatmentProtocol` is exactly `code-harness-eval-v1`.
- `campaignMode` is exactly `execution_smoke` or `isolation_pair`.
- `standing` is exactly `exploratory_only`; standing is derived, never declared
  upward by configuration.
- An `isolation_pair` campaign has one or more isolation pairs and no execution
  smoke. An `execution_smoke` campaign has exactly one native smoke treatment and
  no isolation pair.
- IDs use a bounded safe-name grammar and are unique.
- Unknown fields refuse. Schema evolution requires a new version.
- Canonical JSON produces `campaign1:<sha256>` over the complete normalized
  campaign.

### 7.2 Case contract

Each case binds:

```json
{
  "caseId": "simple-bounded-parser-fix",
  "caseVersion": 1,
  "taskClass": "simple",
  "fixtureId": "fixture1:<sha256>",
  "fixtureTreeDigest": "sha256:<hex>",
  "baseCommitDigest": "sha256:<hex>",
  "task": "...",
  "taskSha256": "sha256:<hex>",
  "acceptanceContract": "...",
  "acceptanceContractSha256": "sha256:<hex>",
  "verifier": {
    "kind": "host_command",
    "command": "npm test -- --runInBand",
    "commandSha256": "sha256:<hex>",
    "timeoutMs": 120000,
    "repeatable": true,
    "expectedBase": "red",
    "expectedReference": "green"
  }
}
```

Case rules:

- `taskClass` is `simple`, `balanced`, or `difficult`.
- Initial fixtures are public, synthetic, deterministic, and safe to send to the
  configured providers.
- A fixture contains no real credential, proprietary project content, network
  dependency, time dependency, or mutable external service.
- Spend-free readiness proves the unmodified base has the declared targeted red
  behavior and a checked-in reference patch produces green. The reference patch
  is not made available to the maker or reviewer prompt.
- The verifier command is argv-safe, bounded, credential-scrubbed, and executed
  only against the synthetic fixture candidate.
- The fixture, task, contract, verifier, and reference result are content-bound.
- Candidate-integrity checking is mechanical: every changed tracked or untracked
  path must be listed in the selected fixture's `referenceFiles`. This limits the
  edit surface; it does not assert that the candidate equals the reference
  implementation.
- Cases are globally unique within a campaign.
- A campaign intended to support a task-class observation eventually contains at
  least three materially distinct cases for that class. A smoke may use one case
  but cannot claim class coverage.

### 7.3 Isolation-pair, smoke, and arm contract

An isolation pair contains exactly two arms:

```json
{
  "pairId": "qwen-a95b-raw-native",
  "makerSeat": {
    "profileBackend": "dashscope_qwen",
    "provider": "alibaba",
    "model": "qwen3.8-2.4t-a95b",
    "effort": null,
    "trainingOrg": "alibaba",
    "transport": "direct_https",
    "connection": "dashscope-primary",
    "route": null
  },
  "reviewerSeat": {
    "backend": "codex",
    "model": "gpt-5.6-sol",
    "effort": "high",
    "trainingOrg": "openai"
  },
  "arms": [
    { "armId": "raw", "makerExecutor": "file_actions" },
    { "armId": "native", "makerExecutor": "qwen_native" }
  ]
}
```

An execution-smoke campaign instead carries exactly one `executionSmokes` row
with the same complete maker/reviewer seat fields and one arm whose executor is
`qwen_native` or `grok_native`. It exists only to prove a bounded live execution
and receipt path before buying a comparison. Its result cannot be paired, ranked,
or used as task-class coverage.

Isolation rules:

- The two arms have exactly the same maker backend, provider, model, effort,
  training organization, transport, connection, reviewer, case assignment,
  verifier, semantic task envelope, and run budgets. Adapter-specific prompt and
  protocol wrappers are part of the measured executor/harness treatment and are
  bound by its policy digest; they are not claimed to be literal prompt equality.
- The raw arm executor is exactly `file_actions`.
- The native arm executor is exactly one of `qwen_native` or `grok_native`.
- `qwen_native` pairs only with the reviewed Qwen Code artifact contract;
  `grok_native` pairs only with the reviewed Grok Build artifact contract.
- Raw and native use the same provider endpoint and exact selected model. A
  gateway alias must resolve only to that same selected model.
- Different models, providers, endpoints, qualifications, reviewer screens, or
  budgets require separate non-isolation campaigns. Their results may be shown
  side by side but never labeled a harness-only comparison.
- Model substitution, helper-model traffic, Responses fallback, direct-transport
  fallback, or a different harness artifact invalidates the attempted cell.
- The reviewer must be training-organization independent from the maker for
  `screenFloorPassed` to be possible. Same-origin review is reported as advisory
  and cannot satisfy that field.

### 7.4 Campaign controls

The controls object binds at least:

```json
{
  "repeatsPerArmCase": 1,
  "maximumCells": 6,
  "maximumProviderCallsPerCell": 34,
  "maximumMakerCallsPerCell": 32,
  "maximumReviewerCallsPerCell": 2,
  "maximumSteps": 12,
  "maximumActions": 32,
  "maximumRepairs": 2,
  "maximumRetries": 1,
  "maximumTokensReserved": 1000000,
  "semanticPromptEnvelopeVersion": "code-harness-eval-v1",
  "wallTimeoutMs": 1200000,
  "callTimeoutMs": 600000,
  "idleTimeoutMs": 0,
  "publish": false,
  "commit": false,
  "merge": false,
  "push": false,
  "automaticRouting": false
}
```

Control rules:

- Every numeric bound is finite, integral where appropriate, positive when it
  authorizes spend, and below a checked implementation ceiling.
- Native arms require a positive token reservation budget.
- Unknown usage consumes the existing conservative reservation and is reported as
  incomplete.
- `maximumCells` covers the frozen campaign; the live command may choose a lower
  bound but never a higher one.
- A campaign records an optional operator cost estimate separately from provider-
  receipted cost. Estimates are never reported as billed cost or a hard cap.
- All authority-side-effect booleans above are exactly false.

### 7.5 Claim policy

The campaign freezes allowed language:

```json
{
  "smokeClaim": "execution_observed",
  "pairedClaim": "paired_observation",
  "winnerClaim": "forbidden",
  "routingClaim": "forbidden",
  "admissionClaim": "forbidden"
}
```

Changing claim policy creates a new campaign generation. V1 validation refuses a
configured winner, routing, or admission claim.

## 8. Private execution snapshot

`plan` resolves the public campaign against the current machine without calling a
provider. It writes `code-harness-execution/v1` below the private Camus operator
directory with mode `0600`.

The snapshot binds, per pair and arm:

- installed Camus package version and runtime tree digest;
- maker/reviewer backend-definition digests;
- exact maker and reviewer qualification fingerprints and seat types;
- opaque credential revisions, never credential values;
- transport and connection IDs plus a redacted connection-definition digest;
- expected reported model and registry/lineage facts;
- maker executor;
- for `file_actions`, the Camus protocol and policy digest;
- for native execution, harness name, exact semantic version, executable artifact
  digest, native parser version, outer-sandbox policy digest, credential-gateway
  policy digest, and platform/architecture/runtime prerequisites;
- verifier executable/command digest and fixture readiness receipts;
- campaign digest and creation time.

The snapshot produces `execution1:<sha256>` over canonical non-secret evidence.
Absolute binary paths, endpoint URLs, SSH hosts, usernames, local repository paths,
credentials, raw environment values, and provider responses are excluded from
ledger receipts. A private diagnostic file may retain bounded redacted local paths
when necessary for the operator.

Any qualification expiry, credential revision, backend-definition change,
connection change, harness artifact change, Camus policy/runtime change, or
verifier drift refuses `run` before a provider call. The operator must create a new
execution snapshot; evidence stays segmented by generation.

## 9. Cell contract and scheduler

### 9.1 Cell identity

A cell is canonical data:

```json
{
  "schemaVersion": 1,
  "campaignDigest": "campaign1:<hex>",
  "executionDigest": "execution1:<hex>",
  "pairId": "qwen-a95b-raw-native",
  "taskClass": "simple",
  "caseId": "simple-bounded-parser-fix",
  "armId": "raw",
  "repeat": 1
}
```

Its ID is `cell1:<sha256(canonical cell)>`. A ledger contains at most one receipt
for a cell ID. A failed attempt is not erased or replaced.

### 9.2 Counterbalanced schedule

For every `(pairId, taskClass, caseId, repeat)` block, the two arm positions are
selected by a stable parity bit derived from:

```text
sha256(campaignDigest + NUL + executionDigest + NUL +
       pairId + NUL + caseId + NUL + repeat)
```

Even parity schedules raw then native; odd parity schedules native then raw. The
algorithm and delimiter are versioned by `code-harness-scheduler/v1`.

Properties:

- the same generation always produces the same order;
- every block contains both arms exactly once;
- status and restart never reshuffle pending work;
- already receipted cells are skipped, not repeated;
- filtering to an arm is forbidden for an isolation campaign after the first paid
  cell, because it would permit post-outcome imbalance;
- a bounded smoke campaign with one native arm is allowed only when
  `campaignMode` is `execution_smoke`; it cannot produce a raw/native comparison;
- adding repeats or cases requires a new campaign generation rather than a
  post-outcome edit.

## 10. Receipt contract

Every attempted cell writes `code-harness-receipt/v1` and receives a content ID
`codebench1:<sha256(canonical receipt without receiptId)>`.

Required receipt sections:

```json
{
  "schemaVersion": 1,
  "receiptId": "codebench1:<hex>",
  "cellId": "cell1:<hex>",
  "campaignDigest": "campaign1:<hex>",
  "executionDigest": "execution1:<hex>",
  "assignment": {},
  "observedIdentity": {},
  "outcome": {},
  "quality": {},
  "economics": {},
  "custody": {},
  "artifacts": {},
  "recordedAt": "2026-08-29T00:00:00.000Z"
}
```

### 10.1 Assignment binding

`assignment` repeats the exact pair, case, arm, repeat, requested maker and
reviewer seats, executor, budgets, fixture/tree/task/contract/verifier digests,
harness/policy digests, and qualification fingerprints. It must exactly match the
campaign plus execution snapshot.

### 10.2 Observed identity

`observedIdentity` contains bounded normalized facts:

- requested and observed maker model identities;
- requested and observed reviewer model identities;
- actual executor and harness session identity;
- harness name/version/artifact digest;
- gateway model requests and whether every request matched;
- qualification and connection fingerprints;
- identity stability and substitution/helper-call refusal state.

No raw provider body or secret header enters the receipt.

### 10.3 Outcome

The exact terminal vocabulary is:

- `candidate_ready_for_acceptance`;
- `verification_failed`;
- `review_unresolved`;
- `needs_human`;
- `needs_decision`;
- `budget_exhausted`;
- `infrastructure_failed`;
- `interrupted_unknown`;
- `containment_refused`.

The receipt also records model calls made, whether a candidate diff exists,
whether a final candidate fingerprint is current, repairs, retries, questions,
human answers, and the shared Build terminal status. An exit code never determines
the outcome by itself.

### 10.4 Quality

Quality fields are derived, not model-authored:

- `fixturePreflightPassed`;
- `candidateIntegrityPassed`;
- `containmentPassed`;
- `verificationRan` and `verificationPassed`;
- `verificationBindingMatch`;
- `reviewRan`, constrained verdict, material finding count, and review binding;
- `reviewerIndependent` and exact reviewer screen standing;
- `humanInterventionDuringRun`;
- `mechanicalFloorPassed`;
- `screenFloorPassed`;
- optional later `blindedHumanLabelId`.

`mechanicalFloorPassed` requires current candidate integrity, conclusive
containment, deterministic verification green, no unresolved infrastructure, and
no human answer or external repair during the run.

`screenFloorPassed` additionally requires an independent exact-identity reviewer,
a bound `APPROVED` verdict, no medium/high finding, and complete reviewer evidence.
Until that reviewer screen is human-calibrated for code, the field remains
screen-specific provisional evidence and cannot authorize a winner or route.

A post-run blinded human label is calibration evidence, not run assistance. Any
human answer, manual code edit, acceptance-criterion change, or operator repair
during the cell makes `humanInterventionDuringRun` true and the autonomous floors
false while retaining the attempt.

### 10.5 Economics

Record when observed:

- end-to-end active wall time;
- maker model time;
- verifier time;
- reviewer model time;
- orchestration overhead derived only from complete timing pairs;
- maker/reviewer input, cached input, and output tokens separately;
- native provider-response and tool-action counts;
- raw protocol steps and file actions;
- repairs, retries, and incomplete sessions;
- provider-receipted billed cost and currency;
- measurement-coverage vocabulary and unknown fields.

Missing usage remains `null` with `usageIncomplete: true`. It is never converted to
zero, estimated billed cost, or an apparent efficiency advantage.

### 10.6 Custody and artifact evidence

Record digests for the source fixture, initial candidate, final candidate, diff,
verifier receipt, reviewer receipt, private Build report, and event journal. Record
containment/candidate stability, receipts-degraded state, and process cleanup.
Do not copy source content, diffs, prompts, transcripts, credentials, or raw
diagnostics into the aggregate ledger.

## 11. Append-only ledger

The ledger is private JSONL under `~/.camus/evals/code-harness/<campaignId>/` (or
an explicit test override), with directory mode `0700` and file mode `0600`.

Requirements:

- validate the complete ledger before appending;
- lock around duplicate detection and append;
- write one canonical receipt line, flush, and `fsync` before clearing the
  in-flight marker;
- refuse duplicate receipt IDs, duplicate cell IDs, malformed lines, mixed
  campaign/execution generations, or unknown schema versions;
- never edit or delete an earlier line;
- keep full Build reports and candidate artifacts in the existing private run
  directory, referenced by digest rather than copied into the ledger;
- summaries are always derived from the complete validated ledger.

## 12. Command semantics

The proposed entry point is `camus code-eval`. Naming may change during the
spend-free patch, but the semantics below are normative.

### 12.0 `fixture`

```bash
camus code-eval fixture --case simple-bounded-parser-fix --json
camus code-eval fixture --case balanced-job-event-scheduler --json
```

`fixture` runs the selected tracked base-red/reference-green readiness check and
emits only its public, content-addressed campaign bindings. Omitting `--case`
selects `simple-bounded-parser-fix` for compatibility. It reads no model or
connection configuration and makes zero provider calls.

`balanced-job-event-scheduler` is the second smoke fixture. It supports one
bounded balanced-case observation only. A task-class claim still requires at
least three materially distinct balanced cases, and the current v1a runner still
has no raw arm or matched raw/native comparison.

### 12.1 `plan`

```bash
camus code-eval plan \
  --campaign campaign.json \
  --state ~/.camus/evals/code-harness/qwen-simple/state.json \
  --ledger ~/.camus/evals/code-harness/qwen-simple/receipts.jsonl
```

`plan`:

- makes zero provider calls;
- validates campaign, fixture readiness, local qualifications, harness artifacts,
  runtime support, reviewer independence, verifier, and limits;
- captures the private execution snapshot atomically;
- refuses an existing different state or ledger generation;
- prints total cells, maximum maker/reviewer/provider calls, token reservation,
  per-class/case coverage, exact arms, and `providerCallsMade: 0`;
- prints that dollar cost is unknown unless supported by provider-receipted pricing;
- changes no model settings, routes, admissions, candidates, or repositories.

### 12.2 `status`

```bash
camus code-eval status --campaign campaign.json --state state.json --ledger receipts.jsonl
```

`status`:

- makes zero provider calls;
- validates generation and ledger;
- reports completed, pending, failed, unknown in-flight, and per-arm/per-case cells;
- shows maximum remaining provider calls from frozen bounds, not an estimated bill;
- identifies the exact next counterbalanced cell without reserving it;
- clears a stale marker only when the same cell already has a valid fsynced receipt;
- otherwise reports `paused_inflight_unknown` and refuses to imply completion.

### 12.3 `run --max-cells`

```bash
camus code-eval run --allow-provider-calls --max-cells 1 \
  --campaign campaign.json --state state.json --ledger receipts.jsonl
```

`run`:

- requires the literal `--allow-provider-calls` consent flag;
- requires an explicit positive `--max-cells`; there is no live default;
- refuses a bound above the campaign remaining cells, implementation ceiling, or
  frozen maximum;
- revalidates campaign, execution snapshot, qualifications, credential revisions,
  harness artifacts, policies, fixtures, verifier, and ledger before each cell;
- computes the next deterministic pending cell;
- atomically writes and fsyncs its in-flight marker **before** any provider call;
- materializes a fresh fixture and invokes the existing shared Build engine;
- passes the exact frozen seats, executor, verifier, and limits;
- appends and fsyncs a receipt before clearing the marker;
- stops after the requested number of attempted cells even when a cell fails;
- stops immediately on an unresolved marker, custody/containment failure, generation
  drift, or authority-side-effect attempt;
- never automatically retries an uncertain paid cell;
- never commits, merges, pushes, publishes, admits, or routes.

Consent authorizes only the provider calls within that invocation and its frozen
bounds. It does not authorize a later invocation, a different campaign, or an
unbounded continuation.

### 12.4 `recover`

```bash
camus code-eval recover --action seal-infra \
  --campaign campaign.json --state state.json --ledger receipts.jsonl
```

Recovery is spend-free and supports one action in v1: `seal-infra`.

- If a valid receipt already exists, clear the stale marker idempotently.
- If no receipt exists, first prove the owned maker/reviewer/verifier process groups
  are dead. If liveness is inconclusive, refuse recovery.
- Append one `interrupted_unknown`/`infrastructure_failed` receipt for the marked
  cell with possible billing and usage unknown.
- Clear the marker only after the receipt is fsynced.
- Never run or repeat the cell. More evidence requires another predeclared repeat
  or a new campaign generation.

### 12.5 `summarize`

```bash
camus code-eval summarize --campaign campaign.json --state state.json \
  --ledger receipts.jsonl --json
```

`summarize` is read-only and provider-free. It segments by exact generation,
pair, task class, case, arm, executor, harness version/artifact, reviewer screen,
and qualification. It reports coverage and standing but cannot write any authority
or settings file.

## 13. Summary metrics and standing

### 13.1 Per-arm metrics

For each exact segment, report:

- attempted and completed cells;
- current-case coverage;
- terminal-status counts;
- mechanical-floor and screen-floor counts/rates;
- deterministic verification failures;
- material reviewer-finding cells;
- infrastructure, containment, timeout, budget, and human-intervention cells;
- median and distribution-ready raw samples for wall, maker, verifier, reviewer,
  and orchestration time;
- token/call/action coverage and values;
- provider-receipted cost coverage and values;
- requested and observed identity sets;
- unknown-measurement counts.

Every attempted cell remains in the denominator. Summary code may not drop an
infrastructure or human-assisted result merely because it is inconvenient to
rank.

### 13.2 Paired metrics

Pair raw and native only within the same case and repeat. Report:

- pair coverage;
- discordant mechanical-floor outcomes;
- discordant screen-floor outcomes by exact reviewer screen;
- paired wall/model/token/call differences only where both sides have the
  corresponding measurement;
- missing-measurement counts;
- whether every isolation invariant held.

Unpaired medians remain descriptive and are not presented as a causal harness
effect.

### 13.3 V1 standing vocabulary

The summary derives one of:

- `no_attempts`;
- `smoke_incomplete`;
- `execution_observed`;
- `isolation_invalid`;
- `paired_coverage_incomplete`;
- `mechanical_floor_not_met`;
- `screen_evidence_only`;
- `paired_observation`.

`paired_observation` requires both arms on every registered case/repeat in the
current task-class campaign, exact identity and isolation invariants, no unreadable
receipts, and complete mechanical evidence. It still names no winner.

The following standings are forbidden in v1 output:

- `winner`;
- `best_model`;
- `best_harness`;
- `routing_eligible`;
- `admission_eligible`;
- `production_ready`.

### 13.4 Quality/economics ordering

Summaries display quality before economics. If either arm misses the mechanical
floor, latency/token differences remain visible as diagnostics but cannot be
described as efficiency. If both clear the mechanical floor, economics may be
reported as paired observations. Screen results remain tied to their reviewer and
calibration standing.

## 14. Crash consistency and recovery

The in-flight marker is `code-harness-inflight/v1` and contains only:

- campaign and execution digests;
- cell ID and complete cell key;
- private Build run ID;
- start timestamp;
- process-supervisor ownership identity;
- maximum provider calls reserved for the cell.

State transitions are:

```text
pending
  -> marker_fsynced
  -> build_running
  -> terminal_normalized
  -> receipt_fsynced
  -> marker_cleared
```

Recovery cases:

| Crash point | Recovery |
| --- | --- |
| Before marker fsync | Cell remains pending; no call was authorized. |
| After marker, before provider call | Seal infrastructure/unknown; do not infer zero calls. |
| During maker/reviewer/verifier | Prove owned groups dead, then seal unknown; do not replay. |
| After terminal, before receipt fsync | Seal from an independently validated durable Build report only if all bindings match; otherwise seal unknown. |
| After receipt fsync, before marker clear | Valid receipt wins; clear marker idempotently. |
| After marker clear | Receipt makes the cell complete. |

The runner must not rely on process exit, a report filename, or a partial JSON
write as proof of completion.

## 15. Security and privacy

### 15.1 Credential boundary

- Provider credentials remain in host-owned connection handling.
- Qwen/Grok native workers receive only the one-run gateway capability.
- Receipts store env-var names only where needed and opaque credential revisions,
  never values.
- Broad environment or process dumps are forbidden.
- Credential-shaped provider output is screened by the existing boundary.

### 15.2 Project boundary

- Initial campaigns use only tracked synthetic fixtures.
- Native workers retain existing Git/source/receipt/process-env/network denials.
- Raw workers retain the host-mediated safe file-action policy.
- Harness output cannot change campaign, state, ledger, verifier, or receipts.
- Evaluator state and full reports stay outside the fixture repository.
- The evaluator never writes Camus-internal prompts, traces, credentials, receipts,
  or calibration state into the candidate.

### 15.3 Network and transport

- Raw and native arms use the same frozen provider route.
- Native network remains limited to the exact host-owned gateway.
- SSH is transport-only; tunnel death refuses without direct fallback.
- Helper models, alternate paths, and endpoint/model substitution refuse.

### 15.4 Output and logging

- Aggregate receipts contain normalized facts and hashes, not provider bodies,
  transcripts, source, diffs, secrets, or arbitrary diagnostics.
- Errors are classed and redacted before persistence.
- Logs are bounded and private.
- A malformed receipt or ledger fails closed and blocks further spend.

### 15.5 Authority separation

The command is denied write access, by design and tests, to:

- the checked-in reviewer admission registry;
- local admission activation records;
- Studio model settings and connection definitions;
- routing evidence/route files;
- calibration labels;
- the operator's project or Camus checkout branches, commits, merges, remotes, and
  publication controls. The shared engine may create its ordinary candidate ref
  only inside the evaluator's disposable synthetic-fixture repository.

## 16. Functional requirements

### FR-1: Campaign validation — P0

The system validates and content-addresses the complete public campaign.

Acceptance:

- unknown fields and schema versions refuse;
- unsafe IDs, duplicate cases/arms, invalid task classes, mutable side-effect
  controls, or weak/unbounded budgets refuse;
- fixture/task/contract/verifier digests recompute exactly;
- configured winner/routing/admission claims refuse.

### FR-2: Exact isolation validation — P0

The system proves raw/native pairs differ only in executor/harness treatment.

Acceptance:

- any maker model, endpoint, qualification, reviewer, verifier, semantic task
  envelope, fixture, or budget difference refuses the pair. Adapter-specific
  protocol wrappers are expected treatment differences and remain bound by the
  raw/native policy digests;
- raw is exactly `file_actions` and native is the exact allowed native executor;
- same-origin reviewer standing cannot satisfy screen floor.

### FR-3: Spend-free planning — P0

Planning captures a complete private execution snapshot without network spend.

Acceptance:

- output explicitly reports zero provider calls;
- qualifications, artifact digests, policies, runtime, and fixture readiness bind;
- the selected case version and task class match its tracked fixture exactly;
- no secret or endpoint detail enters public output.

### FR-4: Deterministic scheduling — P0

The scheduler produces a stable counterbalanced cell order and schedules only
unreceipted cells.

### FR-5: Explicit bounded execution — P0

No live cell runs without explicit consent and a positive maximum-cell bound.

Before a mechanically green standing is possible, every candidate edit must be
limited to the source paths declared by the selected fixture's reference files.
An unexpected tracked or untracked path fails candidate integrity.

### FR-6: Crash-safe append-only evidence — P0

Every attempted cell becomes one immutable receipt before another cell starts.

### FR-7: Shared-engine execution — P0

The runner uses the released Build engine and its existing custody, verification,
review, repair, accounting, and human-handoff contracts.

### FR-8: Honest summary — P0

The report retains all attempts, segments exact generations/treatments, places
quality before economics, and names no v1 winner.

### FR-9: No authority mutation — P0

No evaluator command changes admission, routing, configuration, defaults, source
history, or publication state.

## 17. Non-functional requirements

### Determinism

- Canonical serialization and digest algorithms are versioned.
- The same inputs produce the same campaign, execution, cell, and receipt IDs.
- Scheduling is independent of filesystem enumeration and wall clock.

### Reliability

- Ledger and marker writes are atomic where replaced and fsynced where appended.
- A malformed or unreadable artifact blocks spend.
- Process groups are owned and cleaned through existing supervisors.

### Performance

- `plan`, `status`, and `summarize` operate without provider calls.
- Summary is linear in receipt count and bounded by a campaign receipt ceiling.
- No long-lived daemon is required.

### Portability

- Spend-free validation runs wherever Camus's normal test runtime runs.
- Live Qwen/Grok native cells retain the released macOS arm64 and Node/runtime
  restrictions; unsupported systems refuse rather than falling back.

### Observability

- Every cell shares campaign, execution, cell, Build run, and receipt IDs.
- Progress names the exact current cell and remaining bound without exposing
  prompts, source, endpoints, or secrets.

## 18. Acceptance test matrix

All default tests are network-free and provider-free.

### 18.1 Campaign and isolation tests

1. A complete raw/Qwen-native campaign validates and hashes deterministically.
2. Reordered object keys preserve the canonical digest; changed semantic content
   changes it.
3. Missing model, backend, connection, reviewer, executor, fixture, verifier, or
   budget refuses.
4. Unknown fields, unsafe IDs, duplicate IDs, and unsupported schema versions
   refuse.
5. `winner`, routing, admission, commit, merge, push, or publication authority in
   the campaign refuses.
6. Raw/native pairs with different model, provider, endpoint/connection,
   qualification, reviewer, verifier, fixture, task, contract, effort, or budget
   refuse as isolation pairs.
7. `qwen_native`/Grok artifact mismatch and `grok_native`/Qwen artifact mismatch
   refuse.
8. A same-origin reviewer remains advisory and cannot satisfy screen-floor
   eligibility.

### 18.2 Execution-snapshot tests

9. Planning makes zero provider calls and writes `0600` private state.
10. Qualification expiry/rotation, opaque credential revision change, backend or
    connection digest drift, harness version/artifact change, policy change,
    runtime change, verifier drift, or fixture drift refuses before a provider
    call.
11. State and public output contain no credential value, endpoint URL, SSH host,
    username, absolute local path, or raw environment dump.
12. Unsupported platform/runtime does not advertise or run a native arm and does
    not fall back to raw.

### 18.3 Scheduler and spend tests

13. The scheduler is stable across processes and restarts.
14. Every pair block contains raw/native once and order is counterbalanced by the
    versioned parity rule.
15. Completed cells are skipped; missing cells retain their original order.
16. `run` without `--allow-provider-calls`, without `--max-cells`, with zero, or
    above the frozen/implementation bound refuses with zero provider calls.
17. `--max-cells 1` attempts at most one cell even when it fails quickly.
18. Per-cell maker/reviewer/provider call limits remain enforced by the shared
    engine/gateway.

### 18.4 Crash and ledger tests

19. The marker is fsynced before the fake provider observes a request.
20. A marker without a receipt blocks status/run continuation and cannot rebuy the
    cell.
21. Recovery refuses while an owned process group may still be alive.
22. Explicit recovery seals one unknown infrastructure receipt, then clears the
    marker; it never calls a provider.
23. A valid fsynced receipt plus stale marker clears idempotently.
24. Malformed JSONL, wrong generation, duplicate receipt, duplicate cell, changed
    content ID, or unknown receipt version blocks append and further spend.
25. Failed, timed-out, interrupted, human-assisted, and inconclusive receipts
    remain in summary denominators.

### 18.5 Identity, custody, and quality tests

26. Requested/observed model substitution, helper-model traffic, alternate API
    path, harness session/model mismatch, executor fallback, reviewer substitution,
    or qualification mismatch makes the cell non-green.
27. A zero-exit native process without a definitive terminal is infrastructure,
    not completion.
28. Candidate, verification, and review binding drift clears the corresponding
    evidence.
29. A failed deterministic verifier does not produce screen-floor pass.
30. A reviewer result on a different candidate fingerprint is rejected.
31. Human answers or operator repairs remain recorded and prevent autonomous
    floor standing.
32. Unknown tokens/cost remain null/incomplete and never become zero.

### 18.6 Summary and authority tests

33. Summary never pools campaign/execution generations, task classes, cases,
    executors, harness versions/digests, reviewer screens, or qualifications.
34. Paired differences use only exact case/repeat pairs and complete metric pairs.
35. One-case smoke cannot claim task-class coverage.
36. Incomplete pair coverage cannot produce `paired_observation`.
37. V1 output never contains winner, best-model, best-harness, routing-eligible,
    admission-eligible, or production-ready standing.
38. Quality failures remain visible before latency/token comparisons.
39. All evaluator commands leave admissions, activations, calibration, settings,
    connections, routes, the operator's project/Camus Git refs and remotes, and
    publication state byte-for-byte unchanged. Candidate refs are permitted only
    inside the evaluator-owned disposable fixture repository.

### 18.7 Synthetic end-to-end tests

40. A fake provider drives raw `file_actions` and the digest-pinned Qwen harness
    through the same simple fixture and produces two valid, correctly paired
    receipts.
41. The same test covers Grok Build.
42. Synthetic helper-model, credential-echo, network, protected-path, and malformed-
    terminal probes fail closed through the production supervisor/gateway.
43. No default test requires a credential, paid generation, global mutable config,
    or installed live-provider account.

## 19. Staged rollout

### Stage 0 — Readiness patch (approved now; spend-free)

Implement:

- campaign/execution/cell/receipt contracts and validators;
- synthetic fixture format and at least one simple reference fixture;
- counterbalanced scheduler;
- private append-only ledger and in-flight recovery;
- `plan`, `status`, `run`, `recover`, and `summarize` command shells;
- shared-engine runner with injected fake adapters;
- redaction and no-authority-mutation checks;
- all default acceptance tests and synthetic-provider E2E.

The live `run` path must remain impossible without the explicit paid-call gate.
Completion of Stage 0 authorizes no provider campaign.

### Stage 1 — Two native execution smokes (operator authorization required)

After Stage 0 is reviewed and green:

1. Freeze one Qwen native execution-smoke campaign on one simple fixture.
2. Freeze one Grok native execution-smoke campaign on the same class of fixture.
3. For each campaign, the operator explicitly approves the exact provider route,
   maximum one cell, maximum provider calls, token reservation, and acknowledged
   billing uncertainty.
4. Run Qwen and Grok separately; never let success on one widen the other's bound.

Allowed claim: the exact native treatment either produced a valid execution
receipt or it did not. No raw/native or cross-model ranking is made.

### Stage 2 — Paired raw/native simple campaigns (separate operator budget)

Only if both native smokes produce valid boundary/custody evidence:

1. Freeze Qwen raw versus Qwen Code using the same Qwen model/endpoint/reviewer and
   budgets.
2. Freeze Grok raw versus Grok Build using the same Grok model/endpoint/reviewer and
   budgets.
3. Begin with one counterbalanced raw/native case pair per vendor.
4. If both cells seal valid receipts and the isolation proof remains exact, ask for
   a new explicit budget before completing all three simple cases.
5. Preserve every failure; do not extend a cell or regenerate a favorable campaign.

Allowed claim after complete simple coverage: paired observations for these exact
simple cases, generation, model, provider route, reviewer, budgets, and collection
period. No universal winner or automatic route.

### Stage 3 — Balanced and difficult task classes (later decision)

Proceed only when simple campaigns demonstrate that the evaluator itself is useful
and reliable. Add at least three materially distinct versioned cases per class,
freeze new campaigns, and request separate operator budgets. Do not pool simple,
balanced, and difficult standings.

### Stage 4 — Calibration and uncertainty-aware recommendations (future spec)

A later version may:

- generalize the blinded calibration workspace to code candidates/diffs and their
  contracts;
- calibrate each reviewer screen against shared human-labeled code artifacts;
- introduce predeclared confidence/paired-uncertainty and practical-equivalence
  thresholds;
- return `no_clear_winner` when uncertainty or effect size does not justify a
  recommendation;
- require at least ten trials per arm, every registered case, all quality floors,
  stable identities, current qualification/harness/policy digests, and complete
  calibration before recommendation eligibility;
- bind a recommendation/route receipt to the exact campaign, source receipt IDs,
  case coverage, calibration digest, qualifications, and harness artifacts;
- keep automatic Build routing opt-in with the saved explicit pairing as the
  fail-closed fallback;
- invalidate recommendations on model, provider, endpoint, qualification,
  harness, policy, verifier, case-suite, or calibration drift.

Stage 4 requires a separate reviewed specification and implementation approval.
Nothing in Code Harness Eval v1 activates it.

## 20. Operational paid-call gate

The first provider-backed invocation is blocked until the operator supplies all of:

1. reviewed Stage 0 implementation and green spend-free acceptance tests;
2. exact campaign and execution digests;
3. provider/backend/model/connection and harness identity;
4. exact reviewer screen;
5. explicit maximum cells for that invocation;
6. frozen per-cell maker/reviewer/provider call and token reservation bounds;
7. an acknowledged provider billing estimate or explicit statement that billed
   cost is not available as a hard bound;
8. the literal live-command consent flag.

Consent is per invocation. It expires when the invocation ends and does not carry
to a restart, recovery, another campaign, another provider, or later stage.

## 21. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Harness comparison changes more than the harness | Strict isolation-pair validator over model, route, reviewer, fixture, verifier, semantic task envelope, and budgets; adapter-specific wrappers remain treatment-bound. |
| Provider call is duplicated after crash | Pre-call fsynced marker, no automatic uncertain retry, explicit spend-free recovery. |
| Small samples produce a confident winner | V1 forbids winner/routing standing; future uncertainty design is separate. |
| Uncalibrated reviewer becomes ground truth | Screen-specific provisional evidence; deterministic mechanical floor remains separate. |
| Failures disappear from aggregates | Append-only receipts and fixed attempted-cell denominators. |
| Unknown usage looks cheap | Null/incomplete measurements and conservative reservation; no imputation to zero. |
| Credentials or project data enter evidence | Synthetic fixtures, host credential boundary, normalized bounded receipts, private local artifacts. |
| Evaluator changes the product under test | Shared engine reuse, protected authority/config paths, no source/admission/routing writes. |
| Native artifact or policy drifts mid-campaign | Execution digest revalidation before every cell; drift creates a new generation. |
| Comparison expense grows unexpectedly | Mandatory consent and `--max-cells`; frozen provider-call ceilings; no full-matrix default. |

## 22. Alternatives considered

### Reuse the legacy CLI eval ledger unchanged

Rejected. Its arm contract does not bind maker backend, executor, harness artifact,
provider route, verifier, or Build budgets, and its maker path is Claude-specific.

### Reuse Studio's words campaign unchanged

Rejected. It is intentionally tool-free, single-pass prose generation and has no
coding fixture, verifier, candidate custody, or harness axis.

### Extend Slice G reviewer benchmark

Rejected. Slice G measures reviewer defect detection and controls reviewer
admission. Maker/harness productivity is a different treatment, corpus, terminal,
and authority domain.

### Manually run four Build commands and compare reports

Useful only as informal dogfood. It does not freeze assignment, prevent treatment
drift, preserve crash denominators, counterbalance order, or support reproducible
claims.

### Enable routing after the first paired smoke

Rejected. One paired case cannot establish task-class coverage, judge calibration,
uncertainty, or drift resistance.

## 23. Implementation boundary and completion criteria

This specification is **approved for Stage 0 spend-free implementation only**.
Stage 0 is complete when:

- the versioned contracts and all P0 validators exist;
- the shared Build engine is reused without a protocol fork;
- planning/status/summary/recovery are demonstrably provider-free;
- live execution requires explicit consent and a positive cell bound;
- crash and append-only invariants pass;
- fake-provider raw/Qwen/Grok paths produce correctly bound receipts;
- summaries retain every failure and emit only v1 standing vocabulary;
- authority/config/source state remains unchanged;
- the normal CLI/Studio/root regression suites remain green;
- documentation states that no real model/harness quality claim has been made.

Provider-backed Stage 1 remains pending an explicit operator-owned budget after
that implementation is reviewed. No approval in this document authorizes a real
provider call.
