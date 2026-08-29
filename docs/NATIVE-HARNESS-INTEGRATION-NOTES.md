# Native harnesses — verified interfaces and implementation order

Checked: 2026-08-28. Decision: **Qwen Code first, Grok Build next**.
Status: stock executable isolation **blocked**, then resolved with a Camus-owned
outer worker and credential gateway on macOS arm64. Both maker adapters are now
implemented and selectable in the shared CLI/Studio source; 0.4.9 is not published
until its release checks finish. The pinned CLIs were exercised against a
synthetic local provider. No real credentials, paid generation or global CLI
installation were used. See the [qualification report](NATIVE-HARNESS-QUALIFICATION-1.md).

## Decision in context

Carlos's core suggestion is valid: keep raw model adapters, and add native
coding harnesses alongside them. Both requested products have official
automation interfaces. Grok Build is not being confused with an unofficial
Grok CLI. This does not establish that either harness will outperform Camus's
raw path on our tasks. [Grok CLI reference](https://docs.x.ai/build/cli/reference),
[Qwen headless documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/).

Qwen goes first because its source and wire types are inspectable and version-
pinnable, and its headless path offers explicit structured completion and run
bounds. This is an implementation-risk judgment, not a model ranking. Grok
remains the second priority, not an indefinite backlog item. Its documented
macOS network limitation needs a separate containment solution before parity
can be claimed. [Qwen v0.22.3](https://github.com/QwenLM/qwen-code/releases/tag/v0.22.3),
[Grok sandbox limitations](https://docs.x.ai/build/features/sandbox).

## Verified comparison

| Boundary | Qwen Code | Grok Build |
| --- | --- | --- |
| Automation | `-p`, JSON or `stream-json`; SDK and ACP also exist | `-p`, JSON or `streaming-json`; `grok agent stdio` is official ACP |
| Frozen identity | Explicit model, project-scoped session ID/resume; emitted model/session metadata | Explicit model, session ID/resume, working directory; ACP authentication methods documented |
| First transport choice | Single-shot headless JSONL, preserving the native harness prompt/context and using `--json-schema` | Decide headless vs ACP after executable-level receipt/cancellation tests; do not invent a streaming event schema |
| Budget caveat | Headless wall/tool limits are not currently enforced by the ACP daemon path; subagent inner work is not covered by the top-level tool counter | `--max-turns` is documented; aggregate token accounting and interruption receipts still need executable-level verification |
| Default safety | Default macOS sandbox permits network; containers mount user Qwen state by default | Sandbox is off by default; `strict` child-network blocking is documented as Linux-only |
| Key concern | Provider key passed in the environment survives the ordinary shell sanitizer | Child credential inheritance is not established by the docs; `strict` does not block in-process API/web traffic |

Sources for the table: [Qwen headless modes and budget scope](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/),
[Qwen SDK](https://qwenlm.github.io/qwen-code-docs/en/developers/sdk-typescript/),
[Qwen sandbox](https://qwenlm.github.io/qwen-code-docs/en/users/features/sandbox/),
[Grok headless/ACP](https://docs.x.ai/build/cli/headless-scripting),
[Grok flags](https://docs.x.ai/build/cli/reference),
[Grok sandbox](https://docs.x.ai/build/features/sandbox).

## Concrete findings, not assumed protection

### Qwen: provider credentials need isolation before a native maker launch

Pinned source: v0.22.3, commit
`09825973e7d3c3fd07e17909c396aa62f48ce51f`, published August 28.
The shell launcher calls `sanitizeChildEnv(process.env)`. That function removes
three Qwen-internal capability/token names, deliberately not third-party
credentials. `OPENAI_API_KEY` is retained. The container launcher also forwards
that variable. A normal provider-key environment plus `--sandbox` is therefore
not evidence that model-directed shell commands cannot access the provider key.
[Sanitizer source](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/core/src/utils/sanitize-child-env.ts),
[shell launcher](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/core/src/services/shellExecutionService.ts),
[sandbox launcher](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/cli/src/serve/sandbox.ts).

An offline probe executed the reviewed sanitizer function from that exact source
with synthetic values: provider credential retained, internal credentials
removed. **No real credential was supplied.** This confirms the function's
behavior, not an installed-CLI exploit or end-to-end sandbox result. It is not a
claim that our existing raw API adapter leaked a key.

Follow-up executable evidence: Qwen Code 0.22.3's actual shell tool read a
synthetic `OPENAI_API_KEY` under its stock `permissive-open` sandbox. Grok Build
1.0.5's shell also read a synthetic `XAI_API_KEY` under `strict`. Both reached the
local network canary and read synthetic Git/private-temp files. These are scoped
negative tests, not an exhaustive audit of either product or evidence of a real
credential incident. The reproducible fixture is
[`scripts/probe-native-harness.mjs`](../scripts/probe-native-harness.mjs).

Qwen supports a private `QWEN_HOME`, but project settings remain a separate
input. Merely moving the user home does not disable project environment files,
rules, hooks or other config. Initial integration must control those surfaces
explicitly. [Storage implementation](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/core/src/config/storage.ts),
[environment loader](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/cli/src/config/environment.ts).

### Grok: a strict profile alone does not meet the current macOS boundary

The official sandbox page states that child-network restriction is a no-op on
macOS, and that in-process API/web traffic is outside that child setting. Custom
deny paths are available; Linux read-deny additionally requires bubblewrap.
Grok also discovers project MCP/permission/plugin settings and enables several
Cursor/Claude compatibility scanners by default. These are configuration
surfaces to isolate, not reasons to discard the harness.
[Sandbox](https://docs.x.ai/build/features/sandbox),
[settings reference](https://docs.x.ai/build/settings/reference).

A Linux/container proof is the likely next route for Grok, but is not yet a
verified solution. Do not silently fall back to unrestricted macOS execution,
use a model's promise as a sandbox, or treat ACP as proof that all tools are
mediated by Camus. Permission checks and OS containment serve different roles.
[Grok permissions](https://docs.x.ai/build/features/permissions).

The current binary adds two contract findings beyond the earlier documentation:
`streaming-json` emits native ACP update frames, and a cancelled tool can end
with `stopReason: cancelled` while the process exits zero. A frozen custom model
also attempted an extra `grok-4.6` Responses request for `session_title`; the fake
provider refused it. Neither exit code nor the main session's model setting is
sufficient evidence of successful, single-model execution. This must be enforced
and accounted for, not hidden by a parser. See the qualification report for pins,
observed terminals, and limits of the experiment.

## Bounded first implementation

Start with **Qwen native-maker qualification**, not a public picker entry or a
large universal-agent abstraction:

1. Pin the CLI/package version and capture its actual output contract with a
   local synthetic provider. No real keys or provider generation. Verify model,
   session, structured completion, malformed/duplicate events, nonzero exit,
   cancellation and descendant cleanup. A zero exit is not accepted work.
2. Prove that tools cannot read provider credentials, private Camus receipts,
   source checkout or Git metadata; cannot write outside the candidate; and
   cannot use unauthorized network access. Use canaries and real tool processes,
   including malicious inherited/project config. Resolve credential delivery
   outside the model-controlled tool environment before any live call. If stock
   Qwen cannot meet this boundary through a supported interface, record that
   blocker rather than quietly forking it or weakening the contract.
3. Add a narrow Qwen native maker to the **existing shared engine**, with explicit
   harness selection, version/policy binding and no raw-adapter fallback. Keep
   model/provider/endpoint identity separate from harness identity. Reuse the
   candidate, verification, advisory review and final acceptance flow.
4. Expose the same eligible harness/model choices in CLI and Studio only after
   those checks pass. Existing reviewer model selection stays independent;
   native reviewer harnesses are not implicitly added by a maker adapter.
5. Then authorize one bounded live useful task. Preserve failed attempts; do not
   extend budgets or repeat a failed run merely because another round is possible.

Initial Qwen transport: headless `stream-json`, explicit model/session, bounded
turns/tool calls/wall time and structured output. No daemon, ACP migration, goals,
subagents, ambient MCP/plugins/hooks, auto-updater or automatic task routing in
this slice. Host budgets remain authoritative across calls/resumes; counters
must not reset with the harness process. Qwen's native context management and
coding tools remain the point of the integration. [Headless contract](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/),
[result/usage types](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/packages/cli/src/nonInteractive/types.ts).

The main Camus touchpoints are executor validation, adapter resolution, the
native branch of `code-loop.mjs`, shared launch choices, and the existing CLI/
Studio controls and tests. Generalize the existing Codex-specific executor check
only as needed for this second adapter; retain its current fail-closed behavior.
Raw transport qualification is not proof of native tool isolation, and neither
is admission to gate code. Unknown usage remains unknown/reserved, not zero.

Qwen v0.22.3 requires Node 22; this is an optional harness prerequisite, not a
reason to raise Camus's own runtime floor. Neither `qwen` nor `grok` was on this
machine's PATH during the original research. The follow-up downloaded private
copies only: the npm artifact exposes `cli-entry.js`, not the source tree's
`dist/index.js`. Docker's server responded (29.7.2), but no container/image was
started or downloaded for these checks.
[Pinned Qwen package](https://github.com/QwenLM/qwen-code/blob/09825973e7d3c3fd07e17909c396aa62f48ce51f/package.json).

## Accounts and evaluation

Keep the operator's existing hosted-provider path. Qwen supports a standard
Alibaba API key; a new Coding Plan subscription is not required by this design.
Grok documents API-key authentication for headless/ACP. Exact model entitlement,
endpoint and credential binding still need checking at launch; do not copy a key
into a repository or silently switch billing routes. [Qwen authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/),
[Grok authentication example](https://docs.x.ai/build/cli/headless-scripting#acp).

For later A/B tests, freeze **model + harness/version + provider/endpoint +
effort + task + acceptance checks + budget**. Measure useful completion, independent
acceptance, latency, cached/uncached usage and billed cost when available. Do not
rank models from tool activity or compare unequal harness/budget conditions as
though only the model changed. Simple/balanced/difficult task classes come after
one verified completion, not as another large exploratory matrix now.

The [failed native Codex attempt](DOGFOOD-NATIVE-MAKER-1.md) remains failed. Its
partial inspector was not landed; the sparse-usage defect and missing independent
acceptance coverage remain work, not a passed feature. No more Codex-only
expansion is prerequisite to investigating the two priority harnesses.

## Implemented boundary after executable qualification

The thin-wrapper route remains refused. The implemented shared worker uses an
outer macOS Seatbelt profile and a host-owned, run-scoped model gateway: real
provider credentials remain outside the worker; endpoint, model, helper paths,
identity and accounting remain host-enforced. A container is not being presented
as a substitute for credential separation.

Synthetic canaries proved source/receipt/Git/protected-file reads, arbitrary
writes and non-gateway network fail while candidate writes and the exact gateway
succeed. The production descendant-owning supervisor then completed one synthetic
candidate edit through each digest-pinned harness and observed only the selected
model. Both adapters reuse the existing candidate/verification/review/acceptance
engine, and the raw transports remain available. Useful provider-backed work and
comparative evals remain required before any quality, cost or routing claim.
