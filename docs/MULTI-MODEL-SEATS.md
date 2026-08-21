# Multi-model seat selection (Studio words lanes)

Adopted 2026-08-04, the lead item of the post-Myosin-call roadmap. This document
is the contract; the code in `apps/loop-studio/lib/models.mjs` and
`apps/loop-studio/lib/adapters/` implements it, and `verify.test.mjs` /
`api.test.mjs`, `lib/admission.test.mjs`, and `slice-c.e2e.test.mjs` hold the
declaration, admission, API, and real-adapter paths in agreement.

## The shape: seats, not vendors

The loop has two seats. A **maker** drafts and fixes. A **reviewer** tries to
break the draft. Until now the seats were welded to vendors — Claude wrote,
GPT reviewed — and everything downstream (receipts, doctor, the picker)
hardcoded `anthropic:` on one side and `openai:` on the other.

Now a seat is filled by a **backend**, and any backend that implements a seat's
contract may sit in it, including reversed (GPT writes, Claude reviews) and
same-vendor pairings (recorded honestly, never blocked — see Independence).

Three backend kinds exist:

| backend | kind           | provider    | how it runs                       |
| ------- | -------------- | ----------- | --------------------------------- |
| `claude`| `claude_cli`   | `anthropic` | headless `claude -p` (built in)   |
| `codex` | `codex_cli`    | `openai`    | `codex exec` (built in)           |
| *named* | `openai_compat`| declared    | HTTP chat-completions, streaming  |

The two CLI backends are built in because their auth, spawn contract, and
fail-closed normalization are already proven. `openai_compat` entries are
**opt-in only**: one exists exactly when the active decision file declares it.
No backend is ever enabled silently, probed into existence, or inherited
from an account default.

## Public defaults and local decisions

Every seat decision is explicit and carries provenance. Tracked
`checks/models.json` supplies pragmatic public defaults. The Settings panel
writes mutable operator state to `~/.camus/studio/models.json`, leaving the
repository clean; the launch form can still override a pairing for one run.

```json
{
  "maker":    { "backend": "claude", "model": "sonnet", "why": "..." },
  "reviewer": { "backend": "codex", "model": "gpt-5.6-sol", "effort": "low", "why": "..." },
  "backends": {
    "kimi": {
      "kind": "openai_compat",
      "provider": "moonshot",
      "baseUrl": "https://api.moonshot.ai/v1",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "models": ["kimi-k2-0905-preview"],
      "why": "opt-in open-weight backend, added <date> for <reason>"
    }
  },
  "loop": { "roundCap": 3, "why": "..." }
}
```

- A seat without a `backend` field means the legacy pairing (`maker` → claude,
  `reviewer` → codex), so existing files keep working unchanged.
- An `openai_compat` entry must declare `kind`, `provider`, `baseUrl`,
  `apiKeyEnv`, and a non-empty `models` list, or the record refuses to load.
  The key itself lives only in the named environment variable; it is never
  written to config, receipts, or logs. A seat that names a model **outside
  its backend's declared list** refuses to load too — for a configurable
  backend the list is authoritative, so a typo dies at load (doctor,
  `/api/config`), never after a run has started.
- `models` is a declaration, not a probe: the entry's author states what the
  endpoint serves, the same way the codex fallback list is a stated default.
  Doctor checks reachability; it never expands the list.

### Pairing is a per-run decision with a recorded source

Precedence, most explicit wins, and the winner is named in the snapshot's
`source` fields (which ride `run.json`, `report.json`, and the sealed pack's
session log):

1. `run request` — the launch form or a POST body chose the pairing for this run
2. `env:CLAUDE_MODEL` / `env:CODEX_MODEL` / `env:CODEX_EFFORT` — a session
   override, honored only when the seat's backend is the matching CLI backend
3. `~/.camus/studio/models.json` — the standing local decision, when present
4. `checks/models.json defaults` — the tracked fallback for a fresh machine

Account and CLI defaults remain unreachable: every adapter names its model on
every call.

## Seat contracts

### Maker

```
maker({ prompt, stage, model, cwd, signal, onTick, onSession, toolPolicy })
  → { ok, error, text, costUsd, usage: { input_tokens, cached_input_tokens, output_tokens },
      durationMs, modelActual,            // "provider:model" observed, or null
      hivemindQueried?, hivemindQueries?, hivemindQueryTexts?, hivemindResults? }
```

- `signal` abort must kill the underlying process/request; a killed call
  returns `ok: false`, never partial text as success.
- `onSession` lines are bounded human-readable progress, one per event.
- `toolPolicy` (`research | web_only | hivemind_only | none`) is a **cap**, not
  a promise: a backend without tools runs every policy as `none` and says so in
  its session line. Only the claude backend can run `hivemind_only` (the
  managed connector is Claude-connector auth); a non-claude maker asked to
  retrieve is an infra error, and the server refuses the run earlier.
- `modelActual` is an observation (CLI usage event, API response `model`
  field), prefixed with the backend's declared provider. No observation →
  `null`, and the receipt records the requested identity as actual (the pin
  IS the invocation fact for explicitly-pinned CLI calls) or `unknown` where
  not even the pin is trustworthy. Nothing is ever guessed from latency or
  price.

### Reviewer

```
reviewer({ prompt, model, effort, cwd, signal, onTick, onSession, receiptDir,
           claims, criteria, thresholds })
  → normalized review: { ran, error, verdict, findings, blocking, nonblocking,
      questions, claimAssessments, coverageAssessments, thresholdAssessments,
      usage, durationMs, reviewerModel, reviewerEffort, reviewerIdentity }
```

- Every reviewer backend funnels raw output through the SAME fail-closed
  `normalizeReview` (ported from camus): unparseable, empty, incomplete-ledger,
  or self-inconsistent output is `ran: false` — an infra error, never a clean
  verdict. This is non-negotiable for any future backend.
- `reviewerIdentity` is the provider-qualified actual (`openai:gpt-5.6-sol`,
  `anthropic:claude-sonnet-4-6`, `moonshot:kimi-k2…`). It rides the review
  event into evidence and the sealed pack's `pairing.auditor.actual`.
- `effort` is a **requested** knob and only where the backend honors one
  (codex `model_reasoning_effort` today). Backends without the knob record
  `reviewerEffort: null` — never a fabricated tier. Applied effort is never
  observed anywhere; receipts say "requested".

### Kill paths, streaming, timeouts

Every backend implements all three or it does not ship:

- **hard timeout** per stage/effort (existing CLI values; `openai_compat`
  reuses the reviewer table and the maker stage table),
- **idle watchdog** — no output for N minutes kills the call
  (`REVIEW_IDLE_MS` for every reviewer backend, codex and claude alike;
  `OPENAI_COMPAT_IDLE_MS` for the HTTP backend — conservative defaults),
- **abort** — the run's `AbortController` reaches the child process
  (`SIGKILL`) or the fetch (request abort) directly.

### The hardened codex profile (both seats)

`-s read-only` blocks *writes*; it explicitly does not protect secrets — the
Codex action security doc says so in as many words, and `$CODEX_HOME/auth.json`
holds plaintext access tokens per the auth doc. Studio's words seats are
prompt-in/text-out, so both codex seats remove the *capability* instead of
trusting the sandbox. `hardenedCodexArgs()` is shared by maker and reviewer
(every flag verified against codex-cli 0.144.1):

| flag | why |
| --- | --- |
| `--disable shell_tool`, `--disable unified_exec` | no execution, so no file reads: this is what actually protects `auth.json` |
| `-c web_search="disabled"` | **web search defaults to `cached` and stays ON unless explicitly disabled — omitting `--search` does not turn it off.** A words seat judges or drafts the text it was handed; a source fetched mid-review is evidence nobody sealed |
| `--disable apps`, `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `in_app_browser`, `computer_use`, `image_generation`, `multi_agent`, `plugins`, `hooks` | the remaining default-on capability families a text-only seat never needs; disabling an already-inert family costs nothing and removes a future default flip from the threat model |
| `--ignore-user-config` | no `config.toml`, so no user MCP servers, hooks, or config-held credentials (auth still resolves via `CODEX_HOME`) |
| `--ignore-rules` | no user/project execpolicy rules |
| `--ephemeral` | no session files persisted |
| `-c shell_environment_policy.inherit=none` | any future re-enabled shell inherits nothing |

**Flags are a promise about today's CLI, so they are not the last line.** Both
seats also watch their own event stream: any `item.*` event whose type is not
`reasoning`, `agent_message`, or bookkeeping means a tool ran that the seat
never granted — an unknown future default included — and the call is killed
and returned as an **infra error**, never a verdict or a draft. The refusal
names the tool and its target in the session trail.

> **Where the refusal lives — say this precisely.** Session lines, including
> `hardened seat:` and `REFUSED:`, are written to the run's local
> `events.jsonl` and replay from disk, so an operator can re-watch them. They
> are **not** part of the downloadable evidence pack's `session_log`, which
> carries seat/pairing provenance and the claim, coverage, and threshold
> decisions — so refusal lines are **not covered by `receipt_id`**. The
> accurate phrase is "recorded in the local session trail" or "replayable from
> the run's receipt directory". Never "sealed into the evidence pack" or
> "cryptographically sealed": the refusal's own protection is that the call
> returns an infra error, which *is* sealed via the status dimensions.
> (Whether a refusal *should* enter `session_log` is a deliberate schema
> question — it would change `receipt_id` — and is not assumed here.) Relatedly, a *textless*
tool event used to vanish from the trail entirely (a `web_search` item carries
its query in `query`/`action`, not in text), so the session mapper now emits a
line for every item type, naming what was consulted.

Both seats also spawn with a **scrubbed environment** — a minimal allowlist
(process basics, `HOME`/`CODEX_HOME` for auth resolution, locale, proxy
transport) — because the server's environment carries Hivemind and backend
credentials neither seat should hold. Proxy URLs keep their host and lose any
embedded userinfo; an unparseable proxy value is dropped rather than forwarded
blind, and every strip is reported into the session trail so an operator can
see why a proxy stopped authenticating.

The precise boundary, stated honestly: the codex **process** still resolves
its own credentials (it must, to authenticate), while the **model** has no
shell, exec, file, or search tool to reach them or the network with.

Every claim above was verified by live control, not by reading flags — each
control was run in the failing configuration first and observed to fail:

- a hardened seat asked to print a planted sentinel outside its workspace, and
  asked again for `auth.json`, answered `CANNOT-READ`; an unhardened control
  read the sentinel back verbatim;
- a hardened seat asked to search the web answered `CANNOT-SEARCH` with zero
  `web_search` events; with search re-enabled, the same prompt produced a real
  search **and the adapter refused the run**, naming the tool.

Session lines claim only what is enforced — that rule was itself learned the
hard way here: an earlier revision printed "no web search" while cached search
was live. `openai_compat` is genuinely toolless and may say "tool surface:
none"; the claude maker's `--tools` flag genuinely restricts; the codex seats
say "hardened seat", name each disabled family, and state that an unexpected
tool event fails the call. **Claude's adapters are deliberately not given this
env allowlist or capability profile**: they may legitimately need
provider-specific authentication from the environment, and their tool surface
is already restricted by `--tools`. Claude needs its own auth-aware policy —
an open item, not a silent inheritance of this one.

`openai_compat` streams (`stream: true`) so the idle watchdog and session
lines observe real progress; it requests `stream_options.include_usage` and
tolerates endpoints that ignore it (usage fields stay `null`, never invented).

## Identity and independence in receipts

Unchanged law, now provider-aware end to end:

- `pairing.executor` / `pairing.auditor` each carry
  `requested / resolved / actual` as `provider:model` strings. Requested comes
  from the run-start snapshot (with its recorded source), resolved equals
  requested (fallback policy stays `none`), actual comes from observation with
  the fallbacks above. Unverifiable → `unknown:not-recorded`, never a guess.
- Each review round records `reviewerIdentity` and an `independence` fact
  (`cross_vendor | same_vendor`) computed from the recorded executor and
  reviewer providers at the moment of the round. The audit dimension derives
  from it: same-vendor rounds seal `advisory_clean / advisory_findings`, and
  the headline derivation (unchanged, `packages/trust/lib/status.mjs`) reads
  them as `same_vendor_reviewed` — advisory never impersonates independent.
- A same-vendor pairing is allowed everywhere a cross-vendor one is. The
  product's thesis — two differently-trained models are less likely to be
  wrong the same way — is expressed by *recording and surfacing* the overlap,
  not by blocking the choice. The launch form warns before the run; the
  receipt and standing say it after.
- The existing seal-time guard stays: a pack claiming `cross_vendor` while
  both recorded actual providers match (or either is unknown) refuses to seal.

Economics language stays banned: receipts carry output tokens and elapsed
time, `billing unknown`, `cost not estimated`. Effort is requested, never
observed.

## Stated boundaries of this slice

- **Build lane** keeps the camus gate's own pairing (claude maker, codex
  review inside the gate). Seat selection governs the words lanes. A live
  build run takes a **gate-specific snapshot** (`gateModels()`): if the
  standing decisions are not claude-maker/codex-reviewer it is refused with
  the fix named — a words-lane seat selection never leaks into
  `claude --model` or `CAMUS_CODEX_MODEL`.
- **Compare & Learn and audit-only replay** keep their frozen experiment
  schemas (claude-family arms, codex reviewers). Extending those manifests is
  a deliberate schema change, not a side effect of this slice.
- **Grounded runs through the managed Claude connector** need the claude
  backend in the maker seat (the maker is also the retriever there). Other
  grounding modes (`mcp`/`rest`) work with any maker. A retriever seat of its
  own is future work.
- **`openai_compat` backends have no tools**: no web search, no MCP. Drafts
  come from the prompt plus frozen grounding items. A research contract
  demanding live-loaded URLs will honestly fail review under such a maker —
  that is the contract working, not a bug to paper over.
- Next slice (explicitly not started here): retrieval scope vs evidence scope
  in grounding (see SHANE-DEMO-BRIEF.md, the brand-voice refusal's root cause).

## Addendum: open-model seats (slices A–C)

The connection-aware successor to this contract is
[docs/OPEN-MODEL-SEATS-RFC.md](OPEN-MODEL-SEATS-RFC.md). Slices A, the B
migration core, and C landed: identity records, pairing v2, status v2, envelope
3; loopback, direct_https, and grandfathered legacy_http connection kinds; and
capability-gated direct/local Studio seats.

Declaration and admission are deliberately separate. A configured model is
visible with an origin/operator/transport badge, but every picker disables it
until a stored receipt demonstrates the requirements for its exact
`(words_maker|words_reviewer, backend, model, connection)` tuple. Config save,
per-run pairing, launch, and adapter resolution all enforce the same boundary.
At live launch Studio re-observes available server/weight anchors; it freezes
the accepted `qual1:` fingerprint into `run.json`, round and review events, and
the envelope-3 pairing. A receipt for another seat or model is not reusable.
Built-in vendor-managed Claude/Codex seats continue to use their versioned
`builtin1:` contracts.

Settings provides a bounded **Qualify / Re-qualify** action for one tuple at a
time, plus inert copyable templates for xAI, Moonshot, DashScope, Ollama, LM
Studio, llama.cpp, vLLM, and a neutral OpenAI-compatible HTTPS server. Templates
contain env-var names, never values, and cannot write `lineage.source`, receipt
data, or resolved runtime state. Discovery is shown as `listed`, `unlisted`, or
`discovery_unavailable` but never gates a declared model whose qualification is
valid. The pairing explanation and badges are server-authored so the browser
cannot grade provenance upward.

Slice C is intentionally `chat_completions` over `loopback` and `direct_https`
only. Responses remains visible as planned and cannot be selected. Managed SSH,
the full connection editor, CLI/gate reviewer dispatch, benchmarking, and new
maker executors remain slices D–H. A hermetic loopback fixture proves the full
qualify → select → real adapter → envelope-3 path without network access; live
provider credentials and real local-serving hardware remain an explicit test
gap.
