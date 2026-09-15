# Camus 0.4.26 — contained SWE native writes

Fixes the native edit/create boundary that prevented the pinned Devin harness
from completing work after permission. CLI and Studio use the same adapter.

## Changes

- Native edit/write tools can modify disposable staging after checked permission.
  Each approval records exact expected content hashes durably before acknowledgement.
  The source checkout stays outside native write authority.
- Adoption checks resulting bytes against approved native/host writes after
  confirmed cleanup. Unexpected paths, links, protected changes, source drift and
  oversized results are refused. Permission and final prose are not completion.
- ACP reads honor line ranges; delegated file creation and edits share the checked
  host writer. Native writes do not have to delegate through ACP to succeed.
- Host requests are serialized with bounded concurrency. Pending native writes
  block further native writes and commands; canceled queued work cannot dispatch.
  Completed SWE reverse-request IDs cannot be reused.
- Terminal replies with unfinished host operations remain incomplete even if
  cleanup later succeeds. Recoverable feedback is restricted to host-proven
  no-effect conflicts; uncertain work is never silently replayed.

## Evidence and limits

53 focused tests passed with no skips on macOS, including actual sandbox direct
and atomic writes, nested creation, protected-path/link denials, and shared Build
verification/review in native and delegated modes. Full root/CLI, Studio and
packaged-runtime checks passed locally.

The fresh live canary passed in **99.237 seconds**: one SWE-2 High prompt,
native edit plus nested creation, checked readback, frozen verification and one
GPT-5.6 Luna medium approval with zero findings. Verification and review bind the
same candidate. It used 13 actions and 43,266 accounted tokens, with no retries,
repairs or recoveries; the original fixture source remained unchanged. SWE's
actual inference usage remains unknown. Earlier failed attempts remain recorded.

The reviewed native binary and OS sandbox remain part of the trust boundary.
Native write access covers the disposable mirror, not an OS permission issued
per file operation. Expected/actual byte checks are not a hard OS disk quota.
This release does not promise large-project completion, new reviewer admission,
automatic routing, changed billing, expanded budgets or uncertain replay.

See [the contract and evidence](SWE-CONTRACT-VALIDATION.md) and
[SWE setup](SWE-SETUP.md). Upgrade to `camus-cli@0.4.26` and restart Studio/workers
before a fresh authorized run. Preserve older failed candidates; upgrading does
not make an uncertain old run resumable or accepted.
