# SWE native contract validation

Status: **contained-native live canary passed; included in 0.4.26**.
This is a compatibility and regression gate, not a promise of bug-free native
execution or a successful Company Brain run.

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
| Recoverable errors | Only host-proven no-effect conflicts provide correction guidance. Provider-reported failed tools, unsafe operations and uncertain effects still stop the turn. |
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

Local verification for this revision: **53 focused tests passed with no skips**,
including native atomic replacement, nested creation, link/import denial, durable
approvals and native/delegated shared-engine completion. The full root/CLI and
Studio suites, packaged-runtime parity and `git diff --check` also passed. No
fresh provider call was made during this implementation pass.

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
