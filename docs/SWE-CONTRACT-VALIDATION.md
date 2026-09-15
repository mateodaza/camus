# SWE native contract validation

Status: **survivable-edit and bounded-formatting corrections are included in
0.4.27. The fresh live recovery canary passed verification and Luna review**.
This is a compatibility and regression gate, not a promise of bug-free native
execution or a successful Company Brain run.

## Denied native exec and continuity hardening (0.4.29)

The Company Brain continuation on 0.4.28 performed one checked mirror write,
then stopped when SWE selected the forbidden native `exec` tool. The authenticated
checkpoint at revision 149 records `tool_failed`, no terminal completion, and
**confirmed cleanup**. `nativeInFlight:true` retains unresolved-turn state; it
does not prove that a writer remains alive. That draft remains unadopted.

The correction separates two kinds of recovery:

- **In-turn correction:** a failed native exec can remain a failed, recoverable
  operation only under the exact host-written `exec` deny configuration and
  reviewed binary. Both are rechecked locally. The host's native SBPL profile
  denies child-process creation and permits initial execution only of the pinned
  harness. The host serializes reconciliation, checks all approved staged bytes
  and inventory, then fsyncs a no-effect receipt binding the tool/session,
  configuration, binary and profile hashes. Provider error text is not proof.
  The model is directed to the existing checked MCP `run_command`, not granted
  native command permission. A claimed successful native exec is an invariant
  violation and refuses; no shell/network/write authority is broadened.
- **Prior-candidate continuation:** the historical cleanly stopped denied-exec
  run can explicitly continue only from its previous accepted snapshot, under
  the recognized policy and pinned artifact. This does **not** retroactively
  prove the failed turn harmless, accept its result, or import its mirror. Normal
  source/custody/fingerprint/ownership checks and recovery budgets still apply.

An adjacent storage race was also fixed: failure to persist the no-effect receipt
now cancels execution while still holding the host queue. A queued operation
cannot slip through before the observer sees that evidence failure.

Resume also permits an explicitly tighter cumulative `--max-calls` ceiling, no
lower than calls already consumed. Counters are never reset and reviewer calls
consume the same ceiling. Three calls consumed plus seven newly authorized calls
means `--max-calls 10`, not 7 or 24. This prevents a polling supervisor from having
to race the next dispatch to enforce a smaller human allowance. Other execution
policies remain unchanged; larger allowances still require explicit authority.

Offline coverage includes two full maker slices combining corrected edit misses,
blocked native exec, invalid command arguments, permitted commands, omitted
summaries, frozen verification and independent review. Controls cover changed or
missing deny policy, binary/config tampering, unsafe config permissions/links,
unapproved writes, extra files, overlapping tools, unexpected successful exec,
cleanup failure, receipt collision and ordinary nonzero command exit codes.
Real macOS sandbox tests prove child creation is denied even for the otherwise
allowed harness executable. SIGKILL/restart checks cover both recovery-restored
and recovery-reserved checkpoints, with no replay or double-counted recovery.

Read-only inspection of the real candidate confirmed revision 149, three consumed
calls, one consumed recovery, unchanged accepted fingerprint/branch/HEAD, isolated
Git custody and no ignored output. The run remains untouched. **No new live model
test or Company Brain completion is claimed.** The pinned Devin 3000.10.21 artifact
is still required; auto-upgrading the operator's default CLI does not change it.

Validation: the broader targeted run passed 150 tests with zero skips; additional
SIGKILL tests passed at both prior-candidate recovery checkpoints. Full root/CLI
and Studio suites passed. After adding the tighter resume-call ceiling, all 82
native/loop/inspection regressions passed, including a stop before an unauthorized
reviewer call and later review-only continuation without maker replay. No test
used provider inference. Package parity and `git diff --check` are release gates.

### Company Brain continuation with 0.4.29

Keep run `code-1789435781661-50eb06c8`, the existing task/contract/verifier and
SWE-2 High / Opus 4.8 high pair. The user's eight-call allowance has one consumed
call and seven left. If that authorization remains in force, inspect again and
use the tightened cumulative ceiling below. This does not extend the token,
action, repair, recovery or time budgets. It is unsupported by 0.4.28.

```bash
export CAMUS_DEVIN_BIN="$HOME/.local/share/devin/cli/_versions/3000.10.21/bin/devin"
camus build --inspect code-1789435781661-50eb06c8 --json
camus build --resume code-1789435781661-50eb06c8 --max-calls 10 --json
```

Do not import either refused mirror or use `--retry-uncertain`. Do not commit,
merge or publish the candidate without separate authority. Normal maker slices,
verification and review may proceed without repeated human prompts inside the
authorized limits. Seven calls do not guarantee task completion; report actual
remaining work at an enforced stop rather than silently extending the allowance.

## Summary and prior-candidate recovery correction (0.4.28)

Company Brain run `code-1789435781661-50eb06c8` completed and adopted its
first maker slice into the isolated candidate. The second slice reached
`end_turn` with confirmed cleanup, but its final JSON omitted `summary`.
`done:false` and the explicit `continue` decision were present. The adapter
refused at `decision_schema` before staged adoption. This was not a completed
Company Brain task: verification and independent review had not run.

The correction treats an **absent** summary as empty descriptive metadata and
records `missing_summary_defaulted_empty` in the accepted native result receipt.
Supplied null, non-string or oversized summaries remain invalid. No default is
provided for `done`, the `decision` field, action or reason. Unknown fields and
invalid authority still refuse. Native completion, cleanup and checked adoption
are unchanged; no model retry is needed to fill descriptive metadata.

A narrow explicit-resume path also supports already-refused SWE schema turns
under the recognized checkpoint policies. It requires an authenticated checkpoint,
an earlier `verified_turn` candidate, a completed/cleaned-up native turn refused
at `decision_schema` before adoption, and a preserved, unadopted staging record.
The worker obtains ownership and revalidates the contract/pair/credential binding,
source baseline, candidate Git custody, exact fingerprint and absence of ignored
output before continuing. It retains the refused call in authenticated history,
does not read or adopt its mirror, clears the old session and starts a new bounded
session from the **previous accepted candidate**. This is not acceptance of that
candidate: verification and independent review are still required.

One recovery is reserved; consumed calls, actions, time and token reservations
remain charged. Exhausted allowances park for an explicit extension. Replay flags
or simultaneous authority amendments are refused. Missing cleanup, native tool
failures, interrupted adoption, candidate drift and unsupported policies do not
qualify. CLI and Studio use the same eligibility and execution path.

Read-only inspection of the real run confirmed revision 94, no owner, matching
candidate fingerprint/branch/HEAD, isolated Git custody and zero ignored files.
The run and its failed mirror have **not** been modified or resumed. Offline
regressions cover missing-summary continuation through two maker slices and
verification/review, unsafe schema controls, prior-candidate resume, candidate
drift, replay refusal and exhausted recovery/call budgets. No new live model
evaluation is claimed for this correction.

Validation: full root/CLI `npm test`, full Studio `npm test`, and packaged-runtime
parity passed. The broader focused run passed 139 tests with one existing skip;
the final native suite passed all 32 tests, including additional source-baseline
drift and ignored-output refusal controls. `git diff --check` passed. These are
offline regression results, not a fresh provider-backed success claim.

## Why this gate exists

Success through one tool channel is not evidence that another channel works.
The reported failures successively exercised command validation, the per-turn
action cap, and ACP file creation. Earlier successful edits did not establish
that ACP creation was usable. Another large paid task must not be our first
test of that capability.

The first contract canary (`c848744e-055c-4f34-9648-7cf16ccd4e6d`)
failed after 12.666 seconds: one prompt, eight accounted actions, two successful
ACP reads, zero successful writes and no review. The native `edit` reported
`permission_denied`; source and candidate were unchanged. This invalidated the
assumption that the pinned harness would always delegate writes through ACP.
It remains a failed attempt, not evidence for the revised policy below.

## Supported contract

CLI and Studio share `adapters/devin-native.mjs`; the packaged-runtime test
checks byte-for-byte parity, including the new filesystem handlers.

| Boundary | Local implementation and regression expectation |
| --- | --- |
| Advertised filesystem capabilities | Both ACP read and write have real host handlers; writes support safe missing paths as well as existing files. |
| Native, ACP and MCP writes | Native tools can write inside the disposable mirror. ACP/MCP use the checked host writer. All adopted bytes must match the latest approved native output or successful checked host write. |
| Native permission | Validate the active tool, exact path and one-time option. Compute the exact proposed output for write/edit, including replacement multiplicity and projected byte limits. Persist a hash-bound approval before acknowledging it; create no placeholder. |
| Read semantics | Honor ACP line/limit ranges. Unknown prepared-file reads report a no-effect conflict; never fabricate empty contents. |
| Integrity | Retain protected/denied paths, read-only inputs, source-drift checks, current-hash checks, link/ownership checks, file-count and byte envelopes. |
| Concurrent requests | ACP and MCP share a bounded host queue. A pending approved native operation prevents another native write or host command; matching bytes alone do not prove the native tool has finished. Queued host work is canceled before dispatch. |
| Request identity | SWE reverse RPC IDs remain consumed after completion; duplicate IDs and request floods fail closed. Other executors do not opt into this policy. |
| Recoverable errors | Host-proven pre-effect conflicts provide correction guidance. Since 0.4.27, native edit/write failures may continue only after serialized host reconciliation proves unchanged target bytes and validates the staged manifest. Error wording is never proof. Unsafe operations, overlapping activity and uncertain effects still stop. |
| Budget | Native events and host requests, including permission requests, consume the same allowance. Corrections cannot expand it. Internal SWE inference usage remains unknown. |
| Completion | A terminal response with host work still pending is incomplete even if cleanup subsequently succeeds. No adoption or automatic replay follows. |

ACP explicitly defines create-if-missing writes and optional ranged reads:
[official filesystem contract](https://agentclientprotocol.com/protocol/v1/file-system).
These are capability obligations, not optional conveniences.

### Security boundary of contained native writes

The macOS profile grants write access inside the disposable mirror, **not a
dynamic OS grant limited to the next approved file**. It denies writes to the
source candidate, declared read-only/denied paths, protected names and the mirror
root. It also denies hard links and creation/import of symlinks or special files
inside the mirror. Native arbitrary process execution remains denied. Host
commands retain their separate credential-free, network-denied, read-only policy.
The trusted authenticated Devin process still needs its isolated login/config
root; this does not claim to hide Devin's own credentials from Devin itself.

An exact-output ledger detects unapproved changes to prepared files. The final
inventory check rejects extra files/directories, deletions, links, source drift
and oversized results before adoption. An approval file is marked `approvalOnly`;
only the post-cleanup result records `verifiedAfterCleanup`. A successful native
tool notification alone does not authorize adoption.

Projected file/count/byte envelopes are checked before granting a native write
and actual content is checked again before adoption. These are **not an OS disk
quota** and do not guarantee a malicious or defective native process cannot
temporarily consume extra disk space inside its writable areas. The reviewed
native artifact and OS sandbox remain part of the trust boundary. A broader
untrusted-executable service would need stronger resource isolation.

## Offline release checks

Run from the repository root; none of these commands invokes a model:

```sh
node --test apps/loop-studio/lib/devin-native-workspace.test.mjs apps/loop-studio/lib/devin-native-turn.test.mjs apps/loop-studio/lib/adapters/devin-native.test.mjs apps/loop-studio/lib/codex-rpc.test.mjs
node packages/cli/test_code_runtime.mjs
pnpm test
pnpm --filter camus-loop-studio test
git diff --check
```

The focused tests include actual macOS sandbox execution and a shared Build
engine fixture in both native-direct and ACP-delegated modes:
create/read/edit → frozen verification → independent review.
The provider transport and reviewer in that engine test are mocked. Passing it
does **not** establish live SWE behavior. Platform-skipped sandbox tests do not
count as macOS validation.

Local verification for the **0.4.26 revision**: **53 focused tests passed with no skips**,
including native atomic replacement, nested creation, link/import denial, durable
approvals and native/delegated shared-engine completion. The full root/CLI and
Studio suites, packaged-runtime parity and `git diff --check` also passed. No
fresh provider call was made during this implementation pass.

## Survivable native edit failures (0.4.27)

The first larger 0.4.26 workload performed implementation but ended on a native
`edit` failure with an unclassified diagnostic. Its exact cause is unproven;
the preserved attempt is not retrospectively declared safe, adopted or replayed.
The prior blanket `failed` → abort policy made ordinary editing mistakes fatal.

The correction checks failed native `edit`/`write` calls only. It requires an
identified safe target, no overlapping host/native work at the failure event,
unchanged target bytes (the approved pre-write hash, or the current accepted hash
when no permission was issued), valid hashes for other prepared files, and no
unexpected inventory entries. It runs in the same serialized host queue as ACP
and MCP. An unused native grant is retired; a never-created path is removed from
the prepared-file inventory. A private, session/artifact-bound
`devin-no-effect-*.json` receipt is synced before acknowledging recovery. The
failed tool stays failed, with `recovery: verified_no_effect` in diagnostics; it
does not become a successful edit or a completion receipt.

The model sees its ordinary harness error and may make a new correction within
the existing prompt/action/time allowances. Camus sends no retry prompt, grants
no budget extension and replays no uncertain operation. Final native completion,
writer cleanup, complete inventory/output validation, candidate-bound verification
and independent review remain necessary. The live process is still a trusted,
pinned harness: reconciliation is a checked snapshot, not an OS guarantee that a
defective process cannot attempt a later write. Final post-cleanup checks remain
mandatory. Partial writes and even exact expected output reported as failed are
not promoted to success by this no-effect path.

Offline regression coverage includes stale permission denial → failed native
event → correction → verification/review, and two bounded slices each containing
an approved-but-unapplied failure followed by correction. Controls cover partial
and applied writes, extra files, changed other files, links, overlapping tools,
missing terminal, cleanup failure, deadline, forged provider recovery claims,
redaction and unchanged source. Mock provider/reviewer fixtures do not establish
live recovery behavior. A fresh small canary must actually observe a failed
native edit, host no-effect evidence, correction, verification and review; a
happy-path-only pass cannot satisfy this gate. Do not use the large task to
discover the next compatibility failure.

Validation in this implementation pass: **98 focused tests passed, no skips**
(workspace, protocol, turn, MCP, SWE adapter, shared native-harness reducer and
RPC). The full root/CLI and Studio suites passed. After the final queue-ordering
hardening, the focused suite and packed CLI runtime/parity check were rerun and
passed; `git diff --check` is clean. The refusal controls explicitly attempt a
queued write after failed reconciliation and prove that it never reaches disk.
No live model call, release, or Company Brain retry was made in this pass.

### Subsequent live recovery canary: partial evidence, not a pass

With fresh user approval, canary `4dc32dd3-14a6-4898-ab5d-b21553e26da1`
ran once with `--exercise-edit-recovery`: one SWE prompt, at most one Luna medium
review, 40 actions, 131,072 accounted tokens and five minutes. No automatic
retry/repair, API fallback or publication was permitted; SWE inference spend
remained explicitly unknown.

Result after **45.544 seconds: failed**, one SWE prompt, 13 actions, 32,768
reserved/accounted tokens, zero observed tokens (not zero spend), no review and
no verification. The intentional `edit_2` miss returned `match_not_found`;
Camus persisted `verified_no_effect` against the unchanged `calc.mjs` hash.
SWE continued, corrected `calc.mjs` via `edit_4`, created `nested/label.mjs` via
`write_5`, and read back the new file. Both preserved outputs match their exact
approved hashes. Native `end_turn` and cleanup were confirmed.

The final response contained an explanatory paragraph followed by the JSON
decision. Strict `JSON.parse` rejected the complete response at `decision_json`.
No decision was extracted from prose, no candidate was adopted, and the original
source remained unchanged. Thus the edit-recovery behavior is live evidence,
but **the whole canary is not a pass**. `summary.json` correctly records
`passed:false` and `recoveryPassed:false`: the latter requires a completed,
post-adoption native receipt and must not be confused with the observed no-effect
receipt alone. No additional model call was made.

Private evidence:
`~/.camus/canaries/devin-contract-4dc32dd3-14a6-4898-ab5d-b21553e26da1/`.
Tested dirty working tree based on `c66fc51c48118452cd39b8622e3c0ba4b020baba`,
not that commit alone. Library fingerprint (same 85-file algorithm as below):
`181491154ea177375785068d0118d641dcc4c491b1a94f35bbb0cd390189806d`.
Driver SHA-256:
`9230ebf442f6637f9e45e9b2b71cdb1d5fc3e1c8f056cdc2b4ab24a9195a928a`.

Next gate: address final-response formatting without relaxing decision-schema,
authority or candidate verification checks; validate offline, then obtain fresh
authorization for one full recovery-path canary. Do not repeat the large workload
or declare this attempt successful. The consumed authorization UUID is not reusable.

### Bounded final-response formatting correction (0.4.27)

The SWE decision parser now follows the existing file-actions formatting policy:
accept one whole JSON object, one whole `json` fence, or one complete JSON object
after a blank line and at most 2,000 bytes of plain-text preamble. A preamble
cannot contain braces or code fences. Multiple objects, trailing prose, truncated
JSON and non-object roots remain refused. The whole response remains bounded to
65,536 bytes. No missing fields or decisions are inferred.

Normalization runs only after a successful native terminal and cleanup, on the
uninterrupted text after the last tool event. It never searches tool output or
earlier progress for a decision. Existing schema, authority, output-hash,
inventory, verification and reviewer checks remain unchanged. The private native
result records `decisionNormalizations`; the original terminal text is preserved.
No extra model prompt is needed to remove a harmless presentation wrapper.

The exact captured response from the first recovery canary passes this parser
offline, without adopting or replaying that run. **105 focused tests passed,
zero skips**, including wrapped unauthorized decisions, invalid/ambiguous output,
native recovery plus preamble → verification/review, and delegated writes plus
JSON fence → verification/review. Packed CLI runtime/parity and diff checks pass.

### Fresh full recovery canary passed

With renewed user approval, `3caf45ec-4862-42ef-8761-098f750d8788` ran once under
the same bounds and **passed in 66.103 seconds**:

- One SWE-2 High prompt, one GPT-5.6 Luna medium review; no substitution or API fallback.
- An intentional native edit miss, one durable `verified_no_effect` receipt,
  a corrected native edit, native file creation and checked created-file readback.
- Native `end_turn`, confirmed cleanup and both exact-output hashes verified.
- Frozen verification passed in 151 ms; Luna approved with zero findings in 6.798 s.
- `candidate_ready_for_acceptance`; only `calc.mjs` and `nested/label.mjs` changed
  in the isolated candidate, and the original fixture source stayed unchanged.
- 12 accounted actions, 43,342 accounted tokens (10,574 observed reviewer tokens
  plus the 32,768 SWE reservation); zero retries, repairs or workflow recoveries.
  The in-turn no-effect correction is recorded separately, not disguised as a
  successful first edit. SWE internal spend remains unknown.

The fresh response was already JSON-only (`decisionNormalizations: []`). Thus
live evidence establishes full recovery/verification/review on the patched
runtime; tolerant formatting is independently covered by the prior captured
response and end-to-end offline preamble/fence fixtures. Do not claim the fresh
model exercised normalization when it did not.

Private evidence:
`~/.camus/canaries/devin-contract-3caf45ec-4862-42ef-8761-098f750d8788/`.
Tested dirty working tree based on `c66fc51c48118452cd39b8622e3c0ba4b020baba`.
Library fingerprint (85 files):
`6c7fdb3fb23b2a10d8200168d5dce988cf63deaae53d9e4c9def5e5deae391c1`.
Driver SHA-256:
`9230ebf442f6637f9e45e9b2b71cdb1d5fc3e1c8f056cdc2b4ab24a9195a928a`.

This closes the bounded recovery release gate, not all-project qualification.
Ship the focused maintenance patch, then let the Company Brain agent launch a
fresh isolated run under its existing task/contract/verifier and separately
authorized workload budget. Preserve all prior runs and draft mirrors; no
uncertain replay, direct draft adoption, budget extension or new Camus feature
work is part of this handoff. No release or Company Brain run occurred in the
canary session.

### Other executor boundary check

This runtime change is SWE-only and reaches both CLI and Studio through their
shared adapter. No model admission, billing, routing or default changes apply.

- Qwen native checks its final `result`; individual tool-result errors are not
  an unconditional Camus abort in `adapters/native-harness.mjs`.
- API-backed Grok distinguishes tool updates from top-level execution errors;
  an added reducer regression pins failure → correction → real terminal.
- Grok subscription ACP does not abort on each `tool_call_update: failed`;
  host authorization, cleanup and terminal identity/usage checks remain separate.
- Codex native uses `turn/completed` rather than an individual failed item as its
  terminal boundary. Claude's adapter checks the terminal result's `is_error`,
  not an arbitrary internal edit miss.

These are code-path findings, not new live-model certifications. Host-side
security/protocol refusals in those adapters are intentionally not relaxed.

## Live canary result and repeatable gate

The separately authorized contained-native canary
`25e455dc-d114-43c1-9d6c-bb4e96be8f40` **passed in 99.237 seconds**:

- One SWE-2 High prompt; one GPT-5.6 Luna medium review.
- Direct native edit of `calc.mjs` and direct native creation of
  `nested/label.mjs`; zero ACP write requests and zero MCP write attempts.
- Created-file readback through the checked MCP reader; native cleanup confirmed.
- Both final files match their durably approved output hashes. Frozen verification
  passed and Luna approved with zero findings, bound to the same candidate fingerprint.
- 13 accounted actions, 43,266 accounted tokens, zero retries/repairs/recoveries.
  The 10,498 observed tokens belong to Luna; SWE inference spend remains unknown.
- Only the two intended candidate files changed. The fixture source remained
  unchanged; no product/project commit, merge, push or publication occurred.

The run used Devin `3000.10.21 (611c1cba)` and the dirty working tree based on
`757ab42921ab268b3b8b2a88fda8d67fa50b4e98`, **not that base commit alone**.
Driver SHA-256: `1691a23aa3baa213ae9d8efe7122501ba7f7b1428354e784fd22f4c20d3d92aa`.
Library source fingerprint: `a7a9cafbb64772ca0d347149e496937c416d7ea32bc16aa78ac95fda57fa5676`
(85 sorted non-test `.mjs` paths under `apps/loop-studio/lib`, including the new
`devin-native-files.mjs`; SHA-256 over each relative path, NUL, bytes, NUL).
Private evidence: `~/.camus/canaries/devin-contract-25e455dc-d114-43c1-9d6c-bb4e96be8f40/`.

This closes the bounded native-write compatibility canary, not a large-project
qualification. The earlier failed canary is retained. Any subsequent repetition
of `scripts/devin-contract-canary.mjs` needs fresh approval and a new UUID.

- One SWE-2 High prompt and at most one GPT-5.6 Luna medium review.
- Existing Devin login and verified ChatGPT subscription reviewer login; no API fallback.
- 40 accounted actions, 131,072 accounted tokens, five minutes wall time.
- SWE internal inference/token spend is unknown and requires explicit acceptance;
  accounted tokens are not an internal provider spending cap.
- Zero retries, repairs, recoveries or publication. Only disposable fixture Git
  initialization is performed; no product/project commit, merge or push.
- Require approved native creation and an existing-file edit, plus readback via
  ACP or the checked MCP reader. The existing-file edit must land without an ACP
  write request; any MCP write attempt prevents a pass. This exercises the
  direct post-permission edit that the previous canary could not complete.
- Require post-cleanup write evidence from the production adapter, not permission
  counts alone. Creation may use the native harness's ACP delegation path.
- Require the frozen verifier and independent reviewer to pass, exact expected
  changed paths and an unchanged fixture source. Preserve private evidence on failure.

After approval, use a fresh UUID:

```sh
node scripts/devin-contract-canary.mjs --authorize-id=<fresh-uuid> --accept-unknown-spend
```

The driver consumes the authorization marker before model work; rerunning with
that UUID is refused. Its private summary lives under
`~/.camus/canaries/devin-contract-<uuid>/summary.json`. Authorization, provider
artifacts and canary scripts must not enter the npm package.

## What is sufficient to hand back

Record the exact tested Camus revision, pinned Devin version/artifact, canary
driver hash, result, elapsed time and observed usage. Offline checks plus a
successful changed-channel canary support shipping this bounded compatibility
fix; they do not prove large-repository completion, universal tool support,
reliable continuation, precise spend metering or automatic recovery.

Revalidate affected channels whenever the native artifact, capability declaration,
permission policy, transport, sandbox or completion semantics change. Stop on
any failed gate and preserve the candidate. Do not ask the task agent to spend
again merely because the patch compiles. The next real-project attempt remains
a separately authorized workload, not an automatic retry of a failed run.
