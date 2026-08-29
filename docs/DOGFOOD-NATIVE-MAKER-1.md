# Integrated native-maker dogfood 1 — incomplete at the budget boundary

Date: 2026-08-28. Source: `e3d0c2b` plus the unreleased native-maker prototype.
Private frozen snapshot: `2e25d7c1fa99e76666b066442b2a73fd5b7dd5e1` (not a public
branch commit). Run: `code-1787957523982-5cba52d1`. Private receipts and the partial
candidate remain outside the source project. No raw transcripts or credentials
are included here.

## Contract and outcome

One fresh run through the real shared `camus build` CLI, with
`--maker-executor codex_native`, not a separate experimental coding controller.
The task was the offline `build --inspect RUN_ID [--json]` inspector from the
earlier dogfood. Task, contract and independent checker were copied byte-for-byte
from the frozen comparison; the runtime and containment changed, so this is not
a controlled A/B repeat.

- Maker: `codex:gpt-5.6-luna`, medium, existing ChatGPT login.
- Selected reviewer: `claude:claude-opus-4-8`; subscription login checked before
  launch. **The reviewer never ran.** This is not evidence about review quality
  or the complete pairing.
- Bounds: 400,000 accounted tokens, 20 active minutes, five minutes per outer
  call, 18 accounted model responses, 40 tool actions, 14 outer maker steps,
  two repairs and one retry. No extension or automatic replay.
- No controller prompt steering or candidate edits during the live run. No
  automatic acceptance, landing, commit, merge, push or release.

| Measure | Observed |
| --- | --- |
| Worker wall / active / model time | 177.925 / 177.743 / 176.977 seconds |
| Accounted model responses / native tool actions | 11 / 10 |
| Input tokens | 367,579, including 317,952 cached input tokens |
| Output tokens | 8,508 |
| Observed total tokens | 376,087 |
| Accounted total | 408,855, including the retained 32,768 unknown-usage reserve |
| Terminal | `needs_decision`, budget question; native turn interrupted |
| Candidate | Seven changed/new files, preserved; no completed-turn feature claim |
| In-loop verification / review | Neither reached |
| Actual dollar cost | Unknown; token counters are not billing evidence |

The account crossed the 400,000 threshold on an incoming usage event; it is a
soft event-boundary stop, not a provider-enforced billing cap. The unfinished
turn retains an uncertainty reserve rather than claiming complete accounting.
Do not count cached input twice or describe the reserve as measured spend.
Worker figures exclude controller reasoning, setup, offline probes, audit and
regression tests. Their combined token cost is not available and is not zero.

## Two pre-generation integration defects fixed

Two separate launches stopped before generation, at 1.626 and 2.417 seconds,
with **zero model calls and zero accounted tokens**. Both records are retained.

1. Codex merged the desktop's browser-client trust variable into the native
   shell environment. Camus now explicitly clears that known allowlist; other
   unexpected variables still refuse. Browser tools remain disabled.
2. The thread validator treated `writableRoots` as an exhaustive list rather
   than additional roots beside the working directory. It now normalizes that
   documented representation and still checks the exact candidate and scratch
   roots, network denial and effective named permission profile. No broader
   write permission was granted.

The installed-CLI offline test now uses the **production thread validator** and
seeds the inherited trust variable. Its earlier weaker assertions missed the
second defect. The final native suite passes 24 hermetic tests, with the opt-in
installed-Codex probe passing separately. Source-package runtime and CLI/Studio
continuation tests also pass. These are offline checks, not coding-success data.

## Independent audit of the partial candidate

After the terminal stop, the frozen host check was run using the credential-
scrubbed verifier, with audit receipts separate from the loop. It **failed**:
the new inspector requires every numeric usage counter, rejecting authenticated
version-2 checkpoints that legitimately contain only some known counters.
The existing checkpoint contract accepts that shape. The feature should project
present known numeric fields rather than silently imposing a stronger schema.

The candidate's own feature test and extracted-package runtime test pass. That
does not override the failed independent check: its new unit fixture supplies
all counters and omits several required negative/read-only/ownership assertions.
No reviewer was purchased afterward, no checkpoint was upgraded to verified, and
the partial feature was not copied into the source worktree.

## Decision

This run demonstrates bounded native execution and preserved work, **not useful
completion**, a cost/quality win, model admission, or release readiness. Compared
with earlier read-only looping, it produced edits; that alone does not meet the
service contract. It does not establish that Luna is incapable or that another
model/harness will succeed.

Do not buy another Codex repeat by habit. The operator's next-adapter priorities
are **Grok Build and Qwen Code**. Verify their supported automation interfaces
and choose a bounded integration order, retaining raw API paths. Reuse the same
authority, cancellation, usage, candidate and acceptance contract. Evaluate
model + harness combinations against useful completion, not tool activity or
passing maker-authored tests alone. Preserve this failure in any future comparison.
