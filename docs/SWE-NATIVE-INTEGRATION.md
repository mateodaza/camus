# SWE through native Devin: integration contract

Status: **synthetic and real-package checks passed; prepared for 0.4.22 as an optional, bounded coding maker in shared CLI/Studio.** Flexible Build remains advisory and public alpha; no reviewer admission, routing or all-project qualification is granted.
Owner: Camus maintainer. Updated September 15, 2026.

## Current checkpoint

- **0.4.32 routine-failure continuity:** versioned config prevents the observed
  session migration from invalidating exec-denial evidence. Post-session policy
  checks precede inference. Checked read failures and bounded operation settlement
  reduce whole-turn refusals without adopting uncertain writes. Evidence includes
  a real no-prompt session and an offline multi-turn repair/review campaign, not
  a new live completion. See [the evidence](SWE-CONTRACT-VALIDATION.md#routine-tool-failure-continuity-0432).

- **0.4.31 slice closure:** cleaned-up action/time stops use the same bounded
  discard-and-continue lifecycle; exhaustion parks for explicit extension. New
  runs seal a distinct verified baseline. Soft wrap-up reaches ACP and MCP host
  paths, preserving pending granted I/O and final-decision capacity without
  extending hard limits. Validation remains offline. See [the evidence](SWE-CONTRACT-VALIDATION.md#slice-closure-and-resumable-budget-stops-0431).

- **0.4.30 continuous isolated-turn recovery:** eligible cleaned-up tool failures
  discard their entire mirror and can continue from the last accepted candidate,
  repeatedly within the existing recovery and spend limits. Partial writes never
  become no-effect or success claims. Fixed host diagnostics explain failed
  reconciliation without exposing private text. Multi-turn, truncated-file,
  budget, stop and crash/restart regressions passed offline; no new live success
  is claimed. See [the evidence](SWE-CONTRACT-VALIDATION.md#continuous-isolated-turn-recovery-0430).

- **0.4.29 denied-exec continuity:** native command authority stays denied. Host
  policy, artifact and staged-state evidence can allow correction through checked
  MCP commands. Eligible historical refusals can explicitly resume the prior
  accepted candidate without importing the failed mirror. Smaller cumulative
  resume-call ceilings are enforced, including reviewer dispatches. Offline
  multi-slice, sandbox, tamper and crash/restart checks passed; no new live SWE
  success is claimed. See [the evidence](SWE-CONTRACT-VALIDATION.md#denied-native-exec-and-continuity-hardening-0429).

- **0.4.28 summary and prior-candidate recovery:** an absent descriptive summary
  becomes an explicitly recorded empty value, without defaulting execution or
  authority fields. A narrowly eligible schema-refused SWE run may explicitly
  resume from its unchanged last accepted candidate after ownership, binding and
  fingerprint checks. Its refused mirror is never adopted or replayed. Existing
  budgets and independent verification/review remain enforced. Shared CLI/Studio
  behavior, validated offline; no fresh live evaluation is claimed.

- **0.4.27 survivable-edit correction:** native edit/write failures may
  continue only after host verification of no effect, with durable evidence and
  existing budgets. Partial/uncertain effects and concurrent work remain fatal.
  Offline one- and two-slice recovery reaches verification and independent review;
  after a bounded formatting correction, the fresh live recovery canary passed
  frozen verification and Luna medium review in 66.103 seconds (12 actions,
  no retries/repairs). Included in 0.4.27. This is shared CLI/Studio
  SWE behavior, not a change to other models or a claim about the failed large run.
  See [the recovery contract](SWE-CONTRACT-VALIDATION.md#survivable-native-edit-failures-0427).

- **0.4.26 contained-native correction:** the post-0.4.25 host-only canary
  failed on native `edit` with `permission_denied`, before writing or review.
  The adapter now supports bounded native writes inside its disposable mirror,
  with durable exact-output approvals and post-cleanup byte/inventory validation.
  Real sandbox and shared-engine regressions cover native and delegated writes.
  **The fresh contained-native canary passed in 99.237 seconds:** direct native
  edit/create, readback, frozen verification and one Luna medium review; 13
  actions, no retries/repairs and unchanged fixture source. This is bounded
  compatibility evidence, not all-project qualification.
  See the [contract validation gate](SWE-CONTRACT-VALIDATION.md).

- **0.4.23 diagnostic hardening:** a subsequent cross-project 0.4.22 run stopped
  before edits or review after approximately 36 seconds and nine actions. Its
  adapter returned before saving the incomplete outcome. The trigger cannot be
  reconstructed. All outcomes now retain private evidence and sanitized public
  reason/stage/cleanup/tool-failure fields. Prepared-file discovery and host-proven
  no-write feedback are covered offline; unknown native failures still stop.
  No live rerun was made for this maintenance release. Historical uncertain work
  remains inspection-only. See [0.4.23 notes](RELEASE-0.4.23.md).

- **Real-package check 3 passed (September 14):** one SWE maker prompt, frozen
  verification and one Luna medium review completed in 76.142 seconds. SWE used
  six observed actions; 32 tests passed and Luna approved with zero findings.
  Verification and review bind the same candidate. There were no repairs or
  retries within this successful attempt. The original private app is unchanged.
  Scope was an explicit ten-file package snapshot, not the whole monorepo.
  Reviewer usage was 13,286 reported tokens; total planning accounting was 46,054
  tokens including an unknown-SWE reservation, not measured SWE spend.
  Earlier package attempts remain failures, not hidden warmups.
  Full root/CLI and Studio suites, trust tests, web build and production dependency
  audit subsequently passed. Private run evidence remains outside distribution.

- **Real-package check 2 isolated the completion defect:** after 63.719 seconds
  and seven actions, the terminal was complete with cleanup confirmed, but the
  adapter rejected its text at `decision_json`. The observer had concatenated
  progress commentary with the final JSON. The correction retains only the final
  uninterrupted message segment after the last validated tool event, while the
  total byte cap still covers all progress. It does not extract JSON from arbitrary
  prose or reuse a pre-tool decision. Regression tests cover fragmented finals,
  stale pre-tool decisions, cumulative bounds and ambiguous multiple objects.

- **Historical checkpoints below retain their status at the time.** The latest
  successful package check above supersedes earlier release holds, not their
  failure or unknown-usage records.

- **Real-package check 1 (September 14): release blocker, not an approved run.**
  A clean private application monorepo has 730 tracked files, exceeding the
  current 512-file staging limit. An explicitly scoped ten-file package snapshot
  was used instead, bound to its original Git HEAD and archive hash. This was
  host-prepared evaluation scope, not an automatic product package-scoping feature.
  SWE changed exactly the reducer and its tests, retaining all existing tests
  and adding seven cases. The run stopped after 61.294 seconds and six actions,
  before candidate adoption, verification or review. No reviewer was called.
  An inspection-only verifier against the unadopted, preserved draft passed all
  36 existing/new/frozen cases; the frozen ordering regression fails on baseline.
  That later check is not a substitute for the missing native result or review.
  The source checkout is unchanged, no Camello change was committed or merged,
  and no Camus release or deployment was made.
  The adapter's catch discarded the exact completion/adoption refusal reason;
  do not invent a specific parse error. It now retains a bounded private terminal
  evidence file before parsing/adoption and exposes only fixed diagnostic stages.
  Five adapter tests pass, including separation of private response content from
  public diagnostic labels. No completion parsing or acceptance rule was loosened.
  Private evidence: `.firecrawl/swe-native-20260914/camello-check-1/summary.json`;
  inspection verification: `/tmp/camus-camello-preserved-draft.log`.
  Next paid action needs fresh authority; the original one-prompt check is consumed.

- **Reviewer-only continuation 2 passed (September 14):** the separately
  authorized post-fix Luna medium review returned `APPROVED` with zero findings
  in 10.429 seconds (10.690 seconds for the whole continuation). Reported usage
  was 9,781 input + 101 output tokens. Both verification and review bind the
  original candidate fingerprint; the source and candidate are unchanged. No
  additional SWE prompt, verifier run, repair, or within-attempt retry occurred.
  The run is now `phase: complete`, `candidate_ready_for_acceptance`; its
  `needs_decision` status requests optional human acceptance, not another repair.
  All owned process records are cleaned. No candidate was merged or published.
  This closes the bounded shared-engine smoke, not arbitrary-project qualification
  or a SWE model ranking. SWE remains an optional experimental maker, not a new
  default or reviewer. CLI and Studio consume the same corrected runtime.
  Private evidence:
  `.firecrawl/swe-native-20260914/build-smoke-1/review-continuation-2-summary.json`
  and the authenticated `run/code-checkpoint.json`. Prior failed attempts remain
  recorded: four total Camus dispatches, two explicitly authorized uncertain-review
  retries, one maker step, three actions, one verification, zero repairs. Final
  accounting is 108,186 tokens (9,882 observed plus three unknown-call planning
  reservations); SWE internal usage and earlier reviewer usage remain unknown.
  No further paid call is needed to repeat this synthetic smoke.

- **Reviewer stdin correction implemented (September 14):** ordinary supervised
  targets now receive closed stdin, matching direct launches. Trusted verifier
  and native-process supervisors explicitly select `stdinMode: 'lifetime'` to
  preserve their parent-death signal. IPC remains independent of stdin mode.
  The two new supervised EOF regressions failed before the correction and pass
  afterward; ten process tests cover EOF, IPC, lifetime pipes, descendant cleanup,
  and the actual frozen verifier/native wrappers. The packed CLI both contains
  byte-identical corrected modules and executes its own EOF regression successfully.
  The installed Codex CLI now reaches the intentionally missing-schema error in
  368 ms through the supervisor with no credentials and OS-denied networking.
  That offline check confirmed the launch fix, not a live reviewer verdict.
  No new model call, candidate edit, commit, push or publication was performed
  during that correction pass; the later live verdict is recorded above.
  `pnpm test` passed after the correction (full root/CLI suites), and the focused
  process suite passed all ten tests. The broad Studio run passed through the
  capability, qualification and SSH checks, then exposed an unrelated admission
  test that read the live operator model cache while expecting `gpt-5.4-mini`.
  That test now owns an explicit temporary model-cache fixture and restores its
  override afterward; production model discovery is unchanged. All eight
  admission checks and the remaining Slice C end-to-end test then passed in a
  targeted tail rerun. The full Studio command was not rerun from the beginning.
  Logs: `/tmp/camus-stdin-root-tests-20260914.log` and
  `/tmp/camus-stdin-studio-tests-20260914.log`. `git diff --check` is clean.

- **Reviewer stall diagnosed offline (September 14): Camus supervisor stdin bug.**
  `code-owned-process-supervisor.mjs` launches its target with an open stdin pipe
  and never closes it; the direct `runCodeOwnedProcess` branch uses `ignore`.
  Codex accepts piped context alongside a prompt argument and waits for EOF.
  A credential-free Node EOF probe completes in 20 ms directly but times out
  after 2.159 seconds through the supervisor. The installed `codex-cli 0.149.0`,
  with the actual reviewer hardening flags, an empty private login/config home,
  OS-denied networking, and an intentionally missing output schema, reaches the
  expected local schema error in 64 ms directly. The supervised equivalent never
  reaches that error and times out in 2.170 seconds. Both supervised probes have
  confirmed cleanup. No model completion was requested by these diagnostics.
  This establishes a reproducible launch deadlock independent of SWE and provider
  latency; it does not retrospectively turn unknown billing into measured zero.
  Recommended correction: make supervised stdin EOF-only like the direct branch,
  retain optional IPC, and add direct/supervised EOF and IPC regression coverage.
  No runtime fix or additional paid review was performed in that diagnostic pass;
  the subsequent separately approved correction is recorded above.
  Official behavior: https://developers.openai.com/codex/noninteractive

- **Reviewer-only continuation 1 (September 14): no verdict, not a full pass.**
  The separately authorized additional Luna medium call consumed its five-minute
  allowance (300.164 seconds including cleanup). No SWE prompt or verifier was
  replayed, no repair occurred, and both source and candidate remained unchanged.
  The four-case verification still binds the preserved candidate. All owned
  verifier/reviewer process records are cleaned. Total history: one SWE dispatch,
  two Luna dispatches, three actions, one explicit uncertain-review retry,
  one verification, and 98,304 planning-reserved tokens; observed usage is still
  unavailable. The original failed attempt was not overwritten as a success.
  Private continuation evidence is
  `.firecrawl/swe-native-20260914/build-smoke-1/review-continuation-1-summary.json`.
  The one-shot driver durably consumes this authorization and forbids maker or
  verifier replay. **Next: diagnose the reviewer path before another paid
  attempt.** The offline diagnosis above subsequently located the stdin bug.
  That authorization was exhausted. Continuation 2 was separately authorized
  afterward; neither authorization permits substitution or release.

- **Shared-engine live smoke 1 (September 14): partial success, not a full pass.**
  The separately approved one SWE prompt + one Luna medium review was consumed.
  SWE completed its native turn in 63.418 seconds, with two ACP tool events and
  three conservatively accounted native/host actions. It changed only `calc.mjs`.
  Its cleanup receipt is confirmed and staged adoption reached the isolated
  candidate; the original fixture remained unchanged. The frozen host verifier
  passed all four arithmetic cases in 153 ms and is bound to that candidate.
- Luna medium was dispatched once at about 64 seconds, but supplied no verdict
  before the five-minute overall deadline. Its 235.881-second attempt ended
  uncertain; no reviewer usage was reported. The run stopped after 300.122 seconds
  including cleanup. Both owned verifier and reviewer processes are recorded as
  cleaned. This does not establish whether provider latency, network, or CLI
  startup caused the delay; there is no basis to call it a SWE failure or a quota
  failure. A `review.status: not_run` inspection means no accepted review here,
  not that no reviewer request was dispatched.
- The preserved checkpoint is at phase `review`, resumable but not automatically
  replayable under the consumed authorization. There were no retries, repairs,
  user-project commits, merges, pushes, publication, admission or routing changes.
  The 65,536-token figure is two planning reservations, **not measured spend**;
  internal SWE calls/tokens and this review's usage remain unknown.
  Private evidence: `.firecrawl/swe-native-20260914/build-smoke-1/summary.json` and
  its authenticated `run/code-checkpoint.json`. Next safe paid action, only with
  new consent: reviewer-only continuation of that exact candidate, not another
  SWE invocation. That continuation was subsequently authorized and consumed,
  with its unsuccessful result recorded above. Both drivers refuse authorization reuse.

- **Latest integration verification (September 14):** `pnpm test` completed
  successfully, including 60 native/helper tests, 32 shared launch/native/control
  groups, SDK tests and the full CLI/root suites. The packed CLI contains the
  same Devin sources as Studio. An added host-MCP action-cap regression also
  passed (five composed-adapter tests). Forty-seven recovery/inspection/API
  regression groups passed in a separate run.
- **Studio control-plane parity:** the final HTTP test caught and fixed the
  remaining words-admission assumption. The version-2 seat control accepts only
  the explicit experimental coding contract plus the independently admitted
  reviewer; it does not mint `builtin1:` or grant words/model qualification.
- **UI checked in an isolated rehearsal:** SWE appears only in Flexible Build,
  consent starts off, missing consent blocks submission, and changing maker
  clears consent. Mobile and desktop layout were inspected. Impeccable guided
  consent and limit wording; its mechanical scan was degraded to regex because
  optional HTML/CSS parser modules were unavailable, so it did not establish
  computed-contrast coverage. The preview server was stopped afterward.
- **Consumed authorization for shared smoke 1:** one complete shared-engine smoke,
  at most one SWE prompt and one Luna medium review, 20 conservatively accounted
  actions, 65,536 planning-token reservation, five active minutes, no retries or
  repairs, saved Devin/ChatGPT login only and no API-key fallback. Internal SWE
  inference/token spend remains unknown. No commit/merge/push/publication,
  admission or routing change. Earlier canary permissions remain consumed.

- **Adapter composition is now implemented offline:**
  `adapters/devin-native.mjs` joins the pinned private-login context, native
  exact-file permissions, the ACP controller, bounded host MCP tools, and
  staged adoption into the isolated Build candidate. Its current offline
  coverage uses a fake ACP peer and real loopback MCP/sandbox execution;
  live composed execution is now recorded above. Explicit code-only selection is wired.
- **Product decision approved September 14:** SWE may offer an explicitly consented
  observed-only budget mode (time/tools, unknown internal inference/token spend).
  The ordinary Build call/token ceilings must not silently change meaning. The
  user approved this product option separately from the earlier one-test consent.
  This approval does not replenish consumed live evaluation authorizations.
- **Shared implementation after canary 8:** `devin-native-workspace.mjs` and
  `devin-native-turn.mjs` now provide bounded multi-file staging and a fresh ACP
  turn lifecycle. They are packaged byte-identically into the CLI runtime and
  now have a code-maker-only catalog entry and consent-checked dispatch path. Fifty-two focused tests
  plus the packed-runtime smoke passed before shared live smoke 1. Existing
  native-engine and shared seat-launch regressions also passed. The subsequent
  live result and its limits are recorded at the top of this checkpoint.
- **Earlier protocol evidence: canary 8 passed the scoped staging/edit/MCP-verification
  path in 22.632 seconds.** One prompt, five observed tools, one verification,
  normal `end_turn`, complete observed tools, and confirmed cleanup. This is a
  two-file compatibility pass, not a public seat, project-scale qualification,
  billing measurement, or model ranking. See the canary-8 section below.
- `pnpm preflight:devin-native` now opens an empty ACP session with the pinned
  executable, isolated existing login, exact `swe-2-high`, and Autonomous mode.
  No model prompt is sent. The child and private credential copy are cleaned up.
- `pnpm test:devin-native` passes twenty-three groups, including real macOS sandbox
  probe denying candidate/private-file reads, candidate writes, and child
  execution. The full `pnpm test` root/CLI suite passed again after the mirror
  preparation, including SDK regressions. After the approved pool, all thirty-one
  focused native/permission/mirror/diagnostic groups pass. An additional offline
  verifier regression also passes. Full `pnpm test` was rerun after the verifier
  correction and passed, including root native checks, SDK, and CLI suites;
  `git diff --check` is clean. These are offline regressions, not a live SWE pass.
- The Grok-style network policy initially failed Devin's team-settings fetch.
  Controlled empty-session comparisons isolated the needed additions to the two
  named macOS trust services and TCP inbound permission. No broad home access,
  blanket system-service permission, or process-fork grant was added.
- The original vendor-created login file is mode `0644` on this workstation;
  the preflight reports that fact, copies it into `0700` scratch with mode `0600`,
  and does not change or print the original. This is not evidence of a public leak.
  Source-login permission hardening remains part of production setup work.
- The earlier tool-delegation canaries below retain their original outcome and
  consumed authority. Shared catalog/launch/UI enablement subsequently landed
  locally as described above; it is not a released or generally qualified seat.

### First delegated-tool canary — September 14

**Partial compatibility, not a pass.** One SWE-2 High ACP prompt ran for 95.200
seconds under the approved five-minute/twenty-observed-tool envelope, with billing
uncertainty accepted and no retry, repair, reviewer call, or publication.

- Two `fs/read_text_file` requests reached Camus and read the disposable fixture.
- Three model tool starts were observed: read, read, edit. The edit then reported
  failure. No `session/request_permission`, delegated write, or terminal request
  reached the host. The controller cancelled on the failed tool; no retry followed.
- Candidate hash equals the baseline; frozen tests are unchanged. No test command
  ran. Owned process cleanup succeeded, and the isolated login copy was removed.
- Internal inference count and total token usage remain unknown, not zero. This
  checks compatibility, not SWE coding quality, account charges, or admission.
- The minimized receipt does not retain the edit's detailed error payload. It
  cannot establish the exact write failure cause. In particular, an omitted
  permission handler is **not** a demonstrated explanation: no permission request
  was received. Do not loosen isolation or claim a fix on that assumption.

Private evidence: `.firecrawl/swe-native-20260914/canary-1.json` and the unchanged
synthetic candidate. The original driver is archived privately as
`canary-1-driver.mjs`, SHA-256
`557b9b319025cc12cee55eb55ec1bd4a0b99d8f748ecc76a9a696a2b16a5ad2c`.
Each canary uses a distinct durable one-shot marker and refuses replay.

### Write-path investigation and second canary

Offline macOS probes establish that the original profile denied metadata checks
on candidate children. A default-off experimental option now permits candidate
metadata while still denying direct file contents, writes, private outside paths,
and child execution. This is a demonstrated compatibility limitation, **not a
confirmed cause of the first edit failure**. Historical OS logs did not establish
the cause. Failed-tool diagnostics now retain only fixed categories, never raw
vendor messages, paths, arguments, or credential-shaped values.

A second canary was separately authorized on September 14: one prompt, five
minutes, at most twenty observed tools, zero retries/repairs/publication, with
internal inference/token-spend uncertainty accepted. Its driver enables only the
metadata correction and one validated `allow_once` permission for the fixed
synthetic file. Direct native writes remain OS-denied. The driver records its own
hash; the first receipt and driver are preserved.

**Result: refused safely after 19.617 seconds; not a compatibility pass.** Two
delegated reads succeeded, then the native edit failed before any permission,
write, or terminal request reached Camus. The fixed diagnostic category was
`permission_denied`. Metadata permission alone therefore does not resolve the
write path; the exact denied operation remains unproven. Candidate and tests
were unchanged; cleanup succeeded. No retries or additional prompts occurred.
Internal inference count and tokens remain unknown. Private receipt:
`.firecrawl/swe-native-20260914/canary-2.json`; recorded driver SHA-256:
`b9c9f9602830ae90d0bdb17e4a52cd1f42fc11d5d55d0b6631ac7264a96087d3`.

The second authorization has been consumed. Its exact driver is preserved as
`canary-2-driver.mjs`, with the recorded hash verified before subsequent edits.

### Read-only fixture mirror — third canary did not reach editing

Further offline probes show `stat`, normal/native `realpath`, and existence
checks work with metadata permission. Read/write access checks and actual
content reads remain denied. These observations distinguish filesystem
operations; they still do not identify Devin's exact failing operation.
Current vendor documentation describes edit/write work in the CLI process and
does not establish that all preparatory I/O is delegated through ACP.

The third compatibility design gives Devin a separate, read-only-to-Devin copy
of **only** `calc.mjs` and `acceptance.test.mjs`. The actual candidate and credential
root remain separate. Native access to the real candidate and native writes to
both locations remain OS-denied. The host maps exact mirror paths onto the
candidate, permits one bounded delegated write, refreshes that approved copy,
and runs the fixed verification command in the credential-free tool process.

This helper is explicitly limited to synthetic fixtures, not a production
project projection mechanism. Tests reject overlapping/populated roots,
symlinks/hardlinks, oversized inputs, outside paths and private files. A real
macOS subprocess confirms copy reads work while candidate reads, native writes,
outside reads and child execution remain denied. No blanket repository read
permission was added. These controls preserve isolation while testing whether
Devin needs to inspect approved file contents before delegating its write.

The third canary was separately authorized and executed once: one prompt,
five-minute/twenty-observed-tool ceiling, no retries, repairs, or publication,
with internal inference/token-spend uncertainty accepted.

**Result: refused safely after 24.924 seconds.** Two read tool starts were
observed, with one delegated read request and two native read failures carrying
only the fixed `unclassified` diagnostic. No edit, permission, write, or terminal
request occurred. The candidate and tests are unchanged, and cleanup succeeded.
The v3 receipt records requests on arrival, not completion; it cannot distinguish
a host-side read refusal from a native failure after a successful host read.
Do not claim that either cause was established. This run therefore cannot settle
the edit-path hypothesis. The one-shot authorization is consumed.

Private evidence: `.firecrawl/swe-native-20260914/canary-3.json`.
The exact driver and mirror helper are archived as `canary-3-driver.mjs` and
`canary-3-mirror.mjs`, with SHA-256 verified against their receipt:
`13a7fe2747a49b315e8de1c8a8d6cb5359290ef5cf6ff5cc4e3cd50e799ba642`
and `82ee3b719e2b632f4b3fc478f429bd80b8304d866266bed3227e87fe00e5dc53`.

Offline follow-up now records each host request's named validation stage,
pending/completed/failed outcome, fixed path-scope category, and allowlisted OS
error code. It never records actual paths, arguments, error messages, or file
contents. Regression tests distinguish a completed host read from native tool
failure and verify that secret-shaped errors are not persisted. The instrumented
v4 driver used a separate one-shot marker. Its separately authorized diagnostic
run is recorded below. No production catalog, defaults, admission, or routing
were changed.

### Fourth canary — permission boundary reached; optional-status bug fixed offline

One prompt ran for 294.764 seconds under the same five-minute/twenty-tool
envelope. Both delegated reads **completed**. Devin then started an edit and
sent `session/request_permission`; Camus rejected it in the permission stage
before the scope assessment result was recorded. There were no writes or
terminal calls, no retry or repair, and no publication. The candidate and tests
are unchanged; cleanup succeeded. This was an explicit refusal before the
deadline, not a timeout. Run-wide token usage/inference count remain unknown.

Private receipt: `.firecrawl/swe-native-20260914/canary-4.json`. The exact driver
is archived as `canary-4-driver.mjs`; SHA-256 matches its receipt:
`f77a67da3dc20b052f28f9f69ec959cae00e27b578edf3cac9ac52a1f609fc3a`.

Code inspection and regression tests establish a real Camus protocol bug: the
old guard required an explicit active `prior.status`, whereas ACP ToolCall and
ToolCallUpdate permit omitted status. The observer already treated absence as
pending, but the separate permission-state map did not. The new helper preserves
non-null updates and prior status, defaults an initial omission to pending, and
still refuses unknown/rebound tool IDs and completed/failed tools. Fixed-file
argument validation and `allow_once` remain mandatory. Tests cover omitted/null
status reaching that real scope check, terminal-state refusal, and ID binding.
An additional credential-free Node subprocess test exercises the actual
`CodexRpc` reverse-request transport: omitted-status notification followed by a
null-status permission update grants the exact fixture operation once, then
refuses a repeated permission request. This is a synthetic protocol regression,
not a Devin completion or evidence of live write/test compatibility.

The v4 receipt did not retain prior status, so it cannot prove that this specific
run hit the omitted-status case rather than another state guard. The prepared
v5 runner now records fixed status labels and separate state/scope/option stages.
Its purpose is to verify this proven protocol correction, not to assert live
completion prematurely. No fifth model test has run. A bounded pool of up to
three fresh tests was subsequently approved and executed as recorded below.

### Approved pool, canaries 5–7 — closed; two model prompts

Authorization: at most three fresh tests, one prompt/five minutes/twenty observed
tools per test, sixty observed tools total, no retry or repair within a test,
no session replay, no commit/push/publication, and billing uncertainty accepted.
Each run uses a distinct one-shot marker; the runner refuses a later slot until
earlier receipts confirm terminal status and owned-process cleanup. The pool is
closed after three attempts, although the last one sent no model prompt.

- **5: 32.646 seconds, one prompt, three tool starts.** Both reads completed;
  the permission state was pending with request status unspecified. The exact
  `allow_once` request passed scope checks. Native edit then failed with
  `permission_denied`, without a delegated write. The status fix is confirmed
  on this live permission path; allowing permission alone does not supply native
  filesystem write authority. No candidate or test changes.
- **6: 22.487 seconds, one prompt, four tool starts.** A deliberate experimental
  variant permits native writes to only the disposable mirror's `calc.mjs`;
  actual candidate, frozen tests, other files, and process execution remain
  denied. Permission and native edit succeeded, leaving a changed, bounded
  regular staging file and unchanged tests. Native `exec` failed before any
  client-terminal request. This proves scoped native editing, not end-to-end
  verification, adoption, or general shell containment. The real candidate is
  unchanged; the untrusted staged file is preserved separately.
- **7: 2.136 seconds, zero prompts/tools.** The prepared one-tool HTTP MCP broker
  was not passed to `session/new`: the preflight refused because Devin did not
  advertise HTTP MCP support through ACP. No inference or verification occurred.

All three receipts confirm cleanup. Total: two prompts, seven observed tool
starts, 57.269 seconds across attempts; provider inference counts/token usage
remain unknown. Private receipts and exact archived drivers are named
`canary-{5,6,7}.json` / `canary-{5,6,7}-driver.mjs` under the evidence directory.
Do not reuse those slots or present slot 7 as a completed SWE evaluation.

### Native MCP configuration: initialized without inference; next invocation unproven

Devin's documented native user configuration supports HTTP MCP independently of
what its ACP server advertises for client-supplied servers. A separate no-prompt
preflight, `node scripts/devin-mcp-config-preflight.mjs`, installed **only** the
owned loopback broker in fresh private `mcp_config.json`, opened the same pinned
SWE session, and cleaned up. The broker received two requests and successfully
initialized. It did not list or execute tools; no model prompt was sent. Private
minimized evidence is `native-mcp-config-preflight.json` in the evidence directory.
This supports the native configuration route; it does not justify bypassing the
ACP capability check or asserting model-driven tool compatibility.

The experimental broker requires a random bearer capability, exact loopback
Host/path, no browser Origin, bounded input/requests, and a single fixed
argument-free `verify` tool. It consumes its one-call allowance before awaiting
execution, rejects concurrent/replayed calls, returns fixed result text rather
than raw errors, and owns cleanup. Tests exercise these boundaries. Verification
uses Camus's credential-free sandbox; Devin still cannot launch a shell.

### Offline verifier correction after the pool

An independent host check of the preserved canary-6 staging exited 1 with files
unchanged; this did not prove native completion. A fresh zero-model diagnostic
isolated an additional launcher defect: Node's test child could not `lstat` the
temporary directory's ancestors. Both the current Node runtime and Homebrew Node
reproduced that denial before evaluating the test.

The fixture-only verifier now allows metadata on exact ancestor paths, not
directory listings or their contents. It also denies all fixture writes during
verification. A real sandbox regression proves correct addition passes, broken
addition fails, and source/test/new-file writes, outside private reads, and
ancestor listing remain denied. No historic receipt was changed, no native run
was upgraded to success, and no additional model prompt was sent. This is an
offline infrastructure correction, not successful native tool invocation.

### Eighth canary — scoped native edit and verification passed

Separately authorized after the closed pool: one fresh SWE-2 High prompt, five
minutes, twenty observed tools, no retries/repairs/publication, and accepted
internal inference/token-spend uncertainty. The driver accepts only this new
test ID and uses an exclusive durable marker; prior sessions are never replayed.

**Result: scoped staging pass in 22.632 seconds.** The exact pinned CLI selected
`swe-2-high` in Autonomous mode with the isolated existing account login. It
performed two delegated reads, one permission-bound native edit of `calc.mjs`,
MCP tool discovery, and one fixed host verification. Five tool starts were
observed, all completed; the verifier exited 0 and the prompt returned
`end_turn` with completion text. There were no failed-tool diagnostics.

The broker initialized, listed its tool, and executed `verify` exactly once.
This used the private native `mcp_config.json` route; ACP still advertised no
HTTP MCP support and received an empty `mcpServers` list. No unsupported ACP
transport was forced. The test ran with immutable fixture files in the corrected
credential-free host sandbox. The staged hash matched the source tested, frozen
tests and the actual candidate were unchanged, and owned-process cleanup
succeeded before artifact preservation and scratch removal.

`stagingPassed: true` is deliberately distinct from `delegationPassed: false`:
the edit was native within the allowed staging file, not an ACP delegated write.
Run-wide tokens and internal inference calls remain unknown. Eight usage
notifications included four decorated notifications; they are not eight proven
model calls. The selected model is recorded, but actual serving identity is not
independently proven. There was no reviewer, admission, routing change, commit,
push, or publication. The one-prompt authorization is now consumed.

Private receipt: `.firecrawl/swe-native-20260914/canary-8.json`. The archived
driver SHA-256 is
`7696103f16d37a658583359ba81d54c439336b5a5aa961df279087e3e627fc38`;
the receipt also binds the mirror, permission, diagnostics, broker, and verifier
helpers. Thirty-two focused offline regressions passed before the live test.

Next work is the shared adapter, not another repetition of this tiny fixture:
project-scale tool policies, truthful budget/provenance contracts, independent
planner/reviewer selection, shared CLI/Studio launch integration, and parity
tests. Any further live evaluation needs its own bounded authorization.

CLI/Studio must not advertise SWE as ready until write/test containment and the
accounting contract are settled.

### Shared components and remaining integration

The workspace component takes an explicit manifest of existing read-only files,
existing writable files, and declared new files. It validates the entire source
set before copying; bounds file count and bytes; rejects protected paths, path
aliases, links, special files, and unsafe ownership; and grants native reads and
writes only within the prepared staging manifest. It does not crawl or inherit
project configuration. A real macOS sandbox test covers nested file edits,
declared creation, denied source/private reads, frozen files, and denied fork.

Inspection requires a caller-confirmed stopped-writer boundary, rejects source
drift and unexpected staged entries, and returns unadopted byte changes. Inspection
itself does not modify the source candidate. Declared creates use empty placeholders,
so an untouched placeholder is not returned as a creation. The checked MCP write
path now supports creating additional safe relative files (including empty files)
and replacing a file only with its current SHA-256. It preserves the original
candidate until a separate, one-shot `adopt` operation checks every baseline and
applies changes to the isolated candidate. Host adoption does not grant user
acceptance, commit, merge, or publication. Deletions and general dependency
installation remain unsupported; this is not arbitrary-project qualification.

The turn component requires an explicit `devin-observed/v1` contract: one prompt,
wall-time and observed-tool bounds, with billing uncertainty acknowledged. It
rejects an added purported hard token/call cap, model substitution, and native
session replay. A trusted caller must persist its dispatch marker before the
prompt. Cancellation, failed tools, cross-session traffic, incomplete terminals,
and unproven cleanup cannot produce successful execution. The isolated RPC
factory, bounded host permissions/tools, and cleanup remain adapter obligations;
this component alone is not a security sandbox or public launch authority.

Completion and accounting are separate: a complete terminal can be recorded as
completed execution while run tokens, inference calls, and actual serving model
remain unknown. It grants neither admission nor adoption. The existing Build
engine now consumes that contract only for explicit `devin_native` selection;
other executors retain their existing accounting. The unit tests exercise these distinctions
with fake RPC; the previous real canary is evidence for the underlying protocol
path, not a live validation of this new controller.

The composed adapter now has native existing-file edits plus MCP read, literal
search, checked write/create, and command tools. Commands use a separate,
credential-free sandbox with network denied and staging read-only; temporary
output belongs in private scratch. Native `exec` remains denied in the
credential-bearing Devin process. Tests demonstrate the permission exchange,
command isolation, valid-result adoption, and invalid-decision preservation.
Incomplete runs preserve an explicitly unadopted staged draft rather than
claiming it is the main candidate. No automatic replay is offered.

The shared launch path now freezes `observedBudgetConsent: "devin-observed/v1"`.
CLI requires `--accept-devin-unmetered`; Studio has an unchecked, per-run control
visible for SWE only. Maker/reviewer defaults remain unchanged. SWE is absent from
words/reviewer admission and cannot fall back to HTTP or file actions. Installed
readiness is explicitly not pinned-artifact or serving-model qualification.
Every prompt validates the reviewed binary and isolated context again.

Calls count Camus dispatches, not internal SWE inferences. Token reservations
remain planning accounting, not a hard spend cap. Status, inspection and Studio
explain that distinction. Native events plus host executions conservatively
consume the action allowance (an MCP action can count twice). Definitive staged
results continue to ordinary host verification and an independently selected
reviewer. A new outer SWE turn starts a fresh native session with the current
candidate inventory; uncertain native staging is never automatically replayed.

The synthetic live smoke gate is closed: post-fix continuation 2 obtained an
independent approval on the unchanged, verified SWE candidate. The two earlier
timeouts remain in the evidence; they are not relabeled successful or free.
No further maker prompt or review is needed for this synthetic fixture.
The subsequent real-package checks exposed and then verified the correction of
a completion-handling blocker. Distribution is now prepared for 0.4.22. Nothing
is admitted to words/reviewer gating or selected as a default.

## Goal and scope

### Local usage after the final live smoke

SWE remains optional; selecting it does not change saved defaults. An external
orchestrator may plan with GPT or Claude, then select this coding maker and a
different reviewer. Camus does not expose SWE as a planner/reviewer yet.

```sh
node apps/loop-studio/code-build.mjs --task-file /path/to/task.txt \
  --contract-file /path/to/acceptance.txt --repo /path/to/clean-repository \
  --maker devin:swe-2-high --maker-executor devin_native \
  --accept-devin-unmetered --reviewer codex:gpt-5.6-luna --reviewer-effort medium \
  --max-calls 4 --max-steps 3 --max-actions 40 --max-tokens 131072 \
  --timeout-ms 300000 --call-timeout-ms 300000 \
  --max-repairs 0 --max-retries 0 --max-recoveries 0 --verify "npm test"
```

These are example planning allowances, not approval to execute this command or
a hard SWE spend ceiling. Replace the verifier with the project's trusted check.
Studio: Build → Flexible Build → `devin / swe-2-high` → select the reviewer →
review limits and explicitly check the unknown-spend consent. The installed CLI
supports this through `camus build` starting in 0.4.22; the example above uses the
source entry. Requires the pinned Devin CLI and existing login on macOS arm64.
Prepared source is currently bounded to 512 files, 1 MiB per file, 8 MiB total;
oversized/unsafe inventories refuse before inference. No arbitrary dependency
installation or file deletion is supported. This is not all-project qualification.

### Acceptance boundary

Make `devin:swe-2-high` with `devin_native` a first-class native **maker**,
using the operator's supported Devin login and the same runtime for CLI and
Studio, available starting in 0.4.22. Keep
GPT/Claude and other already-supported reviewers independent. Do not add a
reviewer, Fusion, API-key fallback, automatic admission, or routing recommendation
as a side effect. Model, harness, authentication, and billing are distinct fields.
SWE is an optional executor, not a new global default. An external orchestrating
agent may select it for execution while using GPT or another supported model for
planning/review; this work must not couple those independent choices.

This is a bounded native-executor feature. Future general-purpose SDK work
remains separate: make reliable AI
integration reusable in existing applications, with developer/agent customization,
not replace every component of an application's architecture.

## Implementation sequence

1. **Protocol and isolation boundary.** Pin the executable, launch with an
   allowlisted environment and isolated login/configuration, check exact model
   selection, and establish whether ACP client filesystem/terminal delegation
   works. Do not mistake support for ACP serialization for actual tool delegation.
2. **Native maker adapter.** Reuse the owned-process and bounded host-tool
   infrastructure. Refuse unmediated permissions, configuration/model drift,
   ambiguous terminal results, unsafe resumption, and unknown side effects.
   Quiesce all writers before snapshotting a candidate.
3. **Accounting and authority.** Establish a reconstructable inference ledger
   and a supported pre-dispatch call limit, or explicitly design a different
   operator-approved native budget contract. Never advertise a hard token/call
   limit when only a post-completion observation or wall-clock cancellation exists.
4. **Shared product integration.** One backend and executor implementation,
   shared selection/readiness/launch validation, packaged into CLI from Studio
   source. Studio exposes the same supported choices and reasoned refusals.
5. **Qualification and handoff.** Offline tests, one bounded native canary,
   independent review, parity tests, and honest setup documentation. No release
   or recommendation before the respective evidence exists.

## Acceptance gates

- Exact reviewed executable: Devin `3000.10.21 (611c1cba)`, macOS arm64, SHA-256
  `e7a86b3d4c8b198e1cbf0cab974b80d1a811f38251ceed28e28c5507ba3949b2`.
  ACP's generic `affogato / 0.0.0-dev` banner is not the artifact version.
- Exact `swe-2-high` selected in the ACP model configuration; reject ambiguous,
  conflicting, or changed selection. Selection is not proof of the model that
  served every inference; actual-model evidence needs its own validation.
- Existing account login only. Drop API-key, model, fallback, proxy, and imported
  editor environment settings. Isolate configuration and MCP discovery. Keep
  enterprise controls intact; incompatible mandatory policies cause refusal.
- The credential filename's `windsurf_api_key` field is how Devin stores its
  login token. Do not confuse copying that existing login into private scratch
  with inheriting `WINDSURF_API_KEY` or buying API credits. Do not expose credentials
  to model tools, logs, candidate files, or published artifacts.
- Model tools cannot read login/config/source/receipt roots, private candidate
  paths, or arbitrary host data. Filesystem/terminal actions are bounded before
  execution. Cancellation and protocol failures stop the owned process and tools.
- No native session replay until its identity, policy, ownership, accounting,
  and continuation contract are proven. Preserve uncertain work as untrusted.
- Ordinary maker/reviewer paths and Grok/Qwen behavior retain regression coverage.
- CLI and Studio agree on supported roles, executor defaults, auth/billing labels,
  readiness failures, launch refusal, stop, status, and evidence.

## Known gaps to close, not waive

The previous native quality checks used Devin's own filesystem and shell tools,
not delegated Camus host tools. They demonstrate useful small-task implementation,
not production containment. Those earlier exploratory records remain separate
from the composed, contained smoke and package checks summarized above.

The observed final `session/prompt.usage` describes the **last inference**. Usage
notifications included decorated duplicates and no established unique inference
identity. Neither the last value nor a blind sum is a run-wide ledger. Current
help exposes no equivalent to Grok's native `--max-turns` limit. These are launch
contract questions, not reasons to manufacture zero usage or bypass budgets.

The protocol preflight sends `initialize` and `session/new` only; it cannot prove
model-driven tool delegation, actual serving identity, or a usage ledger. A live
canary needs separate explicit bounds and acknowledgement of those uncertainties.
It must use a disposable fixture, not an existing candidate or completed session.

## Regression matrix

Test malformed/duplicate model options, config drift, cross-session events,
unfinished tools, duplicate terminal consumption, last-inference usage, and
decorated usage updates. Test environment override exclusion, wrong executable
digest/version, isolated credentials/config, early cancellation, permission
refusal, tool cleanup failure, and no model call during preflight. Then exercise
the real read/write/test path and adversarial source/secret/network probes before
enabling the seat in either product surface.

Sources checked: [Devin ACP commands](https://docs.devin.ai/cli/reference/commands),
[configuration](https://docs.devin.ai/cli/reference/configuration/config-file),
[permissions](https://docs.devin.ai/cli/reference/permissions), and
[stored-login handling](https://docs.devin.ai/cli/enterprise/devin-auth).
The enterprise billing page is not evidence of this operator's Pro entitlement;
promotion/account usage must remain separately and honestly described.
