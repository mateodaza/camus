# RFC: Open-weight and Grok model seats — identity, connections, and self-hosted inference

**Status:** v6.1 — **approved architecture contract** after five audit rounds plus two
folded-in P2 clarifications (every finding mapped in the change logs at the end).
**Implementation status (2026-08-24):** slice A, the B migration core, slice C, and slice D are
implemented. Slice D's managed-SSH security, lifecycle, admission, privacy, and qualification
matrix is accepted. Slice F's exact dispatcher and direct HTTP reviewer candidate are feature
accepted for 0.4.4, but remain production-disabled and benchmark-unadmitted; slice E and slices
G–I remain unimplemented. The frozen design below remains the
contract; implementation claims are recorded in this status line and the closing ledger, not
silently rewritten into the original proposal text.
**Date:** 2026-08-18 (v2 through v6.1 same day); implementation status updated 2026-08-24.
**Builds on:** `docs/MULTI-MODEL-SEATS.md` (adopted 2026-08-04) — the seat/backend contract this
RFC extends. Nothing in that document is weakened here; every requirement below is additive or a
tightening.

**Contents:** 1 Summary · 2 Terminology · 3 Current state · 4 Product-reference audit ·
5 Provider/runtime landscape · 6 Identity architecture · 7 Connection architecture ·
8 SSH inference tunnel · 9 Discovery & qualification · 10 Independence semantics ·
11 Studio design · 12 CLI reviewer · 13 CLI maker contract · 14 Remote execution (future ADR) ·
15 Security & privacy · 16 Compatibility benchmark · 17 Test plan · 18 Phased plan ·
19 First slice, files, tests, open questions · Appendix A Sources · Change logs (all audit
rounds → revisions).

## 1. Summary

Camus's words lanes already run any of three backend kinds in either seat: the two built-in CLI
backends (`claude_cli`, `codex_cli`) and opt-in `openai_compat` HTTP entries. That slice
deliberately conflated four different facts into two fields: a backend's `provider` string
currently stands in for *who trained the model*, *who serves it*, *how we reach it*, and *what
protocol it speaks*. That conflation was fine while the only compat entry anyone declared was
"Moonshot serving Kimi over HTTPS" — one string covered all four facts because they genuinely
coincided.

The next wave of seats breaks the coincidence:

- **Qwen** trained by Alibaba, served by DashScope over HTTPS — or served by Ollama on a GPU box
  in a closet, reached through an SSH tunnel.
- **Grok** trained and served by xAI (proprietary — see Terminology), possibly executed through
  xAI's own agent tooling rather than a bare HTTP call.
- **Kimi K2** trained by Moonshot, either served by Moonshot's API, executed through Claude Code
  pointed at Moonshot's Anthropic-compatible endpoint, or self-hosted from the open checkpoint.
- **gpt-oss** trained by OpenAI, served by vLLM on hardware OpenAI has never heard of.

Every one of those distinctions changes what a receipt may honestly claim. "Qwen reviewed this"
means something different when DashScope served it versus when an unattested local ggml file
served it, and the independence standing of a Kimi review executed *through Claude Code* is not
the same fact as a Kimi review over bare HTTP. So this RFC does three things:

1. **Splits seat identity into orthogonal facts** — executor, training organization, model
   family, lineage evidence, inference operator, protocol, transport, connection, the
   requested/resolved/reported/actual model ladder, credential reference, demonstrated
   capabilities (§6).
2. **Introduces connections as first-class, security-bounded objects** — loopback, direct HTTPS,
   and a managed OpenSSH local-forward tunnel that is an inference transport and nothing else
   (§7–§8).
3. **Specifies the qualification path** by which a new backend earns a seat: discovery informs,
   the operator allowlists, and a demonstrated-capability probe decides (§9), with a seeded-defect
   benchmark before any new *maker* executor ships (§16).

### Goals

- GPT/Codex maker with a Qwen or Grok reviewer; Kimi maker with a Grok reviewer; Qwen maker with
  a Kimi reviewer — all with honest per-round independence facts.
- A local Ollama / LM Studio model in either words seat.
- A remote open-weight reviewer on a private GPU server, reached only through a managed SSH
  local forward, with the tunnel's lifecycle owned by Studio/CLI and its failure modes fail-closed.
- Receipts that distinguish origin, serving operator, and transport, and that never promote
  operator-declared origin into verified origin.

### Non-goals (this RFC)

- **Remote execution** — running the *maker's tools* on a remote machine, syncing repositories,
  or treating an SSH host as the agent workspace. Deferred to a separate ADR (§14) with its own
  custody design. An `ssh_tunnel` connection here moves HTTPS-shaped inference bytes and nothing
  else.
- **The Build lane.** The camus gate keeps its fixed claude-maker/codex-reviewer pairing
  (`gateModels()` refusal stays). CLI reviewer backends (§12) extend the *gate's reviewer
  dispatcher*, which is a separate, benchmark-gated track (`review.sh`'s cross-vendor invariant).
- **Compare & Learn / audit-only replay** manifests. Their frozen experiment schemas stay frozen;
  extending them is a later deliberate schema change, exactly as MULTI-MODEL-SEATS.md already
  states.
- Fine-tuning, model hosting, or bundling any inference runtime with Camus.

## 2. Terminology

**Grok is proprietary, not open-weight.** xAI open-sourced the year-old Grok-1 checkpoint in 2024
(and has said older checkpoints may follow), but the Grok models anyone would seat today are
API-only proprietary models. This RFC therefore treats **proprietary Grok support** (a hosted
provider like OpenAI or Moonshot's API) and **open-weight model support** (checkpoints an operator
can run on hardware they control) as separate product capabilities that happen to share the
identity and connection machinery. Marketing, docs, and UI copy must never fold Grok into an
"open models" umbrella; the truthful umbrella is "more seats".

Terms used throughout, chosen to keep four axes from collapsing into each other:

- **model origin** — shorthand throughout this document for the *pair* of facts below. It is
  never one field:
  - **training organization** (`trainingOrg`) — who trained the weights (`anthropic`, `openai`,
    `xai`, `moonshot`, `alibaba`, …). **This is the axis independence is computed from.**
  - **model family** (`modelFamily`) — the lineage line (`claude`, `gpt`, `gpt_oss`, `grok`,
    `kimi`, `qwen`, …). gpt and gpt_oss are *different families of the same organization*, so a
    GPT maker with a gpt-oss reviewer is a same-organization pairing — advisory, never
    cross-vendor (§10).
  - **lineage evidence** — how the two facts above are known, including declared derivation
    (a distillation or fine-tune names its base family).
- **inference operator** — who runs the weights at inference time (`anthropic`, `xai`,
  `dashscope`, `moonshot`, `self_hosted`, `openrouter`-style gateways…). This is the fact
  privacy ("who sees the prompt") is computed from.
- **executor / runtime** — the process shape Camus drives and the interface Camus watches it
  through: a headless CLI agent (`claude_cli`, `codex_cli`, and candidates like Qwen Code or
  Grok's agent tooling) or a direct HTTP client inside Studio (`http_client`). This is the fact
  capability (tools, repo custody) is computed from. A CLI's `--json` event stream is part of
  the executor *interface*; it is not an inference protocol.
- **protocol** — the inference wire dialect spoken to the operator's endpoint:
  `chat_completions`, `responses`, `anthropic_messages`, or `vendor_session` (a CLI executor on
  its vendor's own account plumbing, where Camus does not see the wire).
- **transport / connection** — how inference bytes reach the operator: loopback, direct HTTPS,
  the managed SSH local forward, or `vendor_managed` (a CLI executor's own vendor transport).
  CLI executors may themselves ride a Camus connection (§6, §7): the same env injection that
  redirects Claude Code to Moonshot can point any base-URL-capable executor at a loopback
  server or a tunnel's local port.
- **seat** — maker or reviewer, unchanged from MULTI-MODEL-SEATS.md. A backend fills a seat; a
  backend now *references* a connection instead of owning a bare URL.

**Naming note (product honesty):** a seat filled by "qwen3-coder via DashScope" is a *hosted
proprietary-operator* seat running an open-weight-origin model. The UI badge vocabulary in §11
exists so we never have to say anything vaguer than that.

## 3. Current state (what this RFC extends)

A precise inventory, because every proposal below is bounded by "what already holds".

**Studio seat layer.** `apps/loop-studio/lib/models.mjs` resolves each run's decisions with the
precedence *run request > env override > local operator state (`~/.camus/studio/models.json`) >
tracked `checks/models.json` defaults*, refuses unknown backends and undeclared models at load,
and never falls back to account/CLI defaults. `validateCompatEntry()` is the only configurable
backend kind today: `{ kind: 'openai_compat', provider, baseUrl, apiKeyEnv, models[], seats[] }`,
with the key living only in the named env var. `seatCatalog()` is the single truth the settings
panel, launch form, and run-request validator all consume; `seatOffered()` guards every write
path server-side (`/api/config` POST, `/api/runs` POST pairing) so an unofferable pair can never
become a decision.

**Adapters.** `apps/loop-studio/lib/adapters/registry.mjs` maps a run's snapshot to seat
functions and throws on any backend the snapshot names that this machine has not declared — no
silent substitution. `openai-compat.mjs` implements both seats over streaming chat-completions
with the three mandatory kill paths (hard timeout, `OPENAI_COMPAT_IDLE_MS` idle watchdog, abort →
fetch abort), zero tools, usage as observation-or-null, and reviewer output funneled through the
same fail-closed `normalizeReview` as codex. The codex adapters run the hardened profile
(capability families disabled, `--ignore-user-config`, scrubbed env, event-stream refusal of any
unexpected tool item); the claude adapters restrict via `--tools` and deliberately keep their own
auth-aware environment.

**Identity in receipts.** `evidence-pack.mjs` seals `pairing.executor/auditor` as
`requested/resolved/actual` `provider:model` strings, computes `independence` from the audit
dimension, and refuses to seal a `cross_vendor` claim when either recorded actual provider is
unknown or they match. `engine.mjs` records per-round `reviewerIdentity` and an `independence`
fact that fails closed to `same_vendor` when either provider is missing or unknown. The
`none:no-model-run` token exists so a model-free recovery never invents vendor provenance.

**Doctor.** `doctor.mjs` reports per-backend checks: CLI presence + spend-free auth probes for
claude/codex, and for each `openai_compat` entry the declared baseUrl, model count, key presence,
and (deep mode only, key present) a 5s `GET {baseUrl}/models` reachability probe. Reachability
never expands the declared models list.

**CLI gate.** `packages/cli/skills/camus/scripts/review.sh` is the reviewer dispatcher: `codex`
is the only backend; any other `CAMUS_REVIEWER` value fails closed as `ran:false` citing the
cross-vendor invariant and the benchmark gate. `codex_review.sh` owns the watchdog lifecycle
(start detached / await / abort), the three-channel round+effort binding (request file, env,
argv — any disagreement refuses), the input fingerprint (`fp1:` over HEAD + diff + prompt bytes),
adoption/replay of live or completed watches keyed on the gate nonce, and thread-resume for
abandoned reviews. `adapter.py` normalizes raw verdicts with the hard infra-vs-findings guard.
`camus-loop.workflow.js` computes expectations independently (round, effort, model, backend,
worktree basename, nonce) and `asGate()` refuses any receipt whose binding disagrees;
containment receipts are mechanical (`containment.sh`) and three-outcome (clean / breach /
inconclusive). All of that machinery is backend-agnostic on purpose and is the contract any new
reviewer backend must slot into *unchanged*.

**Trust boundary.** `server.mjs` binds loopback by default, allowlists Host and Origin, requires
a per-session capability token on browser POSTs, and treats receipts as the product: every
persistence failure is loud, and evidence-pack refusal degrades the receipt rather than the
claim. The browser is presentation only — this matters in §8, because it is the existing
precedent for "the local server owns lifecycle; the page never holds credentials".

Two standing facts this RFC must not regress:

- **Economics language stays banned.** Tokens and elapsed time only; `billing unknown`; effort is
  requested, never observed. Self-hosted seats make invented dollars *more* tempting (electricity
  is not a price list) — the ban stands.
- **Session-line honesty.** A seat's session lines claim only what is enforced (the
  "no web search while cached search was live" lesson). Tunnel and connection lines below follow
  the same rule: "forwarded via SSH" is claimable only because the process was spawned with the
  flags that make it true, and "weights verified" is never claimable at all in this slice.

## 4. Product-reference audit

Four products were audited against live docs and source on 2026-08-18 (pinned commits where
cloned). Full per-product findings are summarized here; the design sections cite these findings
where they drive a decision. The recurring theme across all four: **capability and identity are
self-reported everywhere, and every product's own docs admit the failure modes** — which is the
market gap Camus's demonstrated-capability and origin-evidence machinery (§9) exists to fill.

### 4.1 Marshall (`LaurentZuijdwijk/agention-marshall`, marshall.agention.ai)

A terminal coding agent "optimised for open weights and local inference", built on the author's
Agention SDK. Named roles (`coder|planner|reviewer|context|search|summarizer`) resolve through
tiers (`deep|fast`), each tier a full profile `{provider, model, apiKey, host, reasoningEffort}`
— explicitly so a hosted frontier model and a local llama.cpp model can share one session.
Loaded-model discovery is the standout: llama.cpp router `/v1/models` load state and live
`n_ctx`, Ollama `/api/tags` + `/api/ps` residency, and a `contextSource: 'active'|'configured'`
distinction in the picker. "Runtime belts" scale the tool surface down for small models
(`light` strips ~1100 tokens of tool overhead); safety levels 1–3 gate state-changing calls
(3 = LLM judge that can auto-*approve* but never auto-deny past the human; yolo is deliberately
unpersistable). Headless engine is an in-process TypeScript library.

**Adopt:** mechanical caller-identity stamping on every gated action (each turn's tool belt
binds `{role, model, id}` — the same doctrine as Camus's receipt binding); the
`active|configured` context-window vocabulary (§9.2 uses it); fail-closed degradation on
identity-bearing config (an unusable judge config reads back as level 2, never as "no gate");
judging automated gates by **false-approve rate**, not accuracy (their own live-fire data:
a mis-chosen judge model false-approved 40–60% of scope-mismatch cases).
**Reject:** model-judged auto-approval as an authority (a confident-safe verdict skips the
human; Camus treats judge output as advisory evidence at most); trusting registry/provider
capability flags as enforcement inputs.
**Probe before believing:** its READMEs claim a "stdio JSON-RPC transport" — the audited source
contains no RPC code at all; the site claims MIT — the repo carries no license file. Docs
describing intended architecture as shipped is the claimed-guards-must-exist lesson in the
wild, and disqualifies Marshall's headless engine as an integration target today.
**Where Camus is stricter:** Marshall's sandbox is "containment, not a security boundary" (their
words) and identity is per-action but not sealed into replayable receipts; Camus requires
receipt-grade provenance and containment verdicts that are mechanical, three-outcome, and
sealed.

### 4.2 OpenCode (`anomalyco/opencode`, opencode.ai)

Provider system built on the Vercel AI SDK + the models.dev registry ("75+ providers");
custom/self-hosted providers are a config block naming an SDK adapter
(`@ai-sdk/openai-compatible` → chat-completions, `@ai-sdk/openai` → responses), a `baseURL`,
and a hand-declared model map with explicit `limit.context/output`. Per-provider
whitelist/blacklist filters the *picker*; per-agent markdown files pin model+prompt+permissions.
Headless: `opencode serve` exposes an OpenAPI 3.1 spec from the running instance (`/doc`), an
SSE event bus, and everything as API objects — including permission responses.

**Adopt:** declared model limits as diffable config (Camus's declared-models discipline,
extended to context windows); approvals as recordable protocol objects (congruent with Camus
routing every human decision through receipts); spec-served-from-the-binary if Camus ever
exposes runs over HTTP; whitelist∩blacklist as picker vocabulary (§9's
discovered∩declared∩demonstrated is the stricter form).
**Reject:** permissive-by-default permissions (most tools default `allow`; `--auto` approves
everything not denied) — the inverse of Camus's thin-runner doctrine; the unauthenticated
control plane (no auth unless `OPENCODE_SERVER_PASSWORD` is set, yet the port can rewrite
config, inject credentials via `PUT /auth/:id`, and execute shell — compare Studio's
token+origin+host layering, which stays the standard for anything this RFC adds); the silent
default of routing session titles/summaries to their own hosted `gpt-5-nano` unless pinned —
a standing violation of "models are explicit decisions", and their own compliance notes treat
it as an opt-out.
**Probe:** whether blacklisted models are refused by the server or merely hidden by the picker
(their docs only claim the picker); whether basic auth actually covers the SSE bus.
**Where Camus is stricter:** OpenCode records; Camus seals. Nothing in OpenCode binds a review
to a nonce/round/worktree or refuses a mismatched receipt.

### 4.3 Continue (continue.dev)

Model roles (`chat, autocomplete, edit, apply, embed, rerank`) assigned per model block;
agent-mode eligibility is derived from a `tool_use` capability flag. Capability "detection" is a
hand-maintained per-provider regex table over model *names* (`core/llm/toolSupport.ts`),
already carrying a deny-list of exceptions to its own heuristic; the docs contradict themselves
on whether operator config can override detection (reference says overwrite, deep-dive says
additive-only with no way to fail closed), and again on whether prompt-emulated "system message
tools" kick in automatically. Ollama `AUTODETECT` populates the picker from `ollama list`,
verifying nothing.

**Adopt:** the role taxonomy *shape* (roles per model block ≈ seats per backend) and honest
per-page troubleshooting that names real failure cases (DeepSeek R1 advertising tools it can't
call; OpenRouter dropping capabilities in proxy).
**Reject:** name-pattern capability inference presented as detection; additive-only capability
config where deny cannot win; silent fallback that swaps native tool calls for
parsed-from-text emulation — §9.2's probe-or-unprobed rule and the no-silent-downgrade ban are
the direct counter-design.
**Probe:** the capability-override contradiction itself (only source or a live test settles it).
**Where Camus is stricter:** Continue's contradictory normative docs are exactly why Camus pins
seat semantics with tests (`verify.test.mjs` holds MULTI-MODEL-SEATS.md and the code in
agreement); any capability semantics this RFC adds get the same treatment.

### 4.4 OpenHands (docs.openhands.dev, formerly All Hands / OpenDevin)

All LLM traffic through LiteLLM conventions (`openai/<served-model-name>` + base URL); local
servers documented: LM Studio (recommended), Ollama, vLLM, SGLang. Docker sandbox with
hash-pinned runtime images (lock tag over base image + dependency lockfiles, source tag over
their own source). The docs state hard numeric context floors for local agents — Ollama's 4096
default is "way too small — not even the system prompt will fit"; floor ≥22k, recommended 32k+
— and are frank that local tool-use reliability "varies widely". Headless mode, their words:
"always runs in `always-approve` mode … cannot be changed."

**Adopt:** loud numeric context floors, upgraded from documentation to measurement (§9.2
probes the window instead of hoping); namespaced model strings that encode routing (the
`openai/<name>` convention rhymes with Camus's `provider:model`, and §6 extends the idea to
origin/operator/transport); hash-pinned execution environments (the container sibling of
Camus's head-binding — relevant to the remote-executor ADR, §14); the `--json` JSONL event
stream as headless interchange.
**Reject:** unconditional always-approve headless execution sitting next to a local-model story
whose main documented failure mode is unreliable tool calls — Camus's park-first, fail-closed
posture is the deliberate inversion; anecdotal compatibility lists ("community-reported working
models") as guidance — notable because OpenHands holds *cloud* models to a published benchmark
and simply exempts local ones, which is exactly the double standard §16 refuses.
**Probe:** the 22k floor's derivation; the V1 fate of the native-tool-calling toggle (their V1
docs link a dead anchor; only V0 documents `function_calling`).
**Where Camus is stricter:** OpenHands treats the model as trusted-once-configured; Camus
treats every seat as an adversary of the receipt (identity observed, capabilities demonstrated,
verdicts normalized fail-closed).

### 4.5 What the audit changes in this RFC

1. **Nobody probes.** All four products gate capability on self-reported or name-derived flags,
   and all four document the resulting failures. §9.2's demonstrated-capability probes are the
   differentiator and are therefore *required*, not nice-to-have.
2. **Loaded-state discovery is table stakes for local UX** (Marshall does it best). §9.3 adopts
   it as informational chips, never gates.
3. **Fail-open defaults are the industry default.** OpenCode's permissive permissions and
   OpenHands' always-approve headless mode both ship today. Camus's fail-closed posture is a
   real differentiator and must not be traded away for onboarding smoothness in the connect
   flow.
4. **Docs-vs-artifact drift is common enough to audit for** (Marshall's phantom RPC transport,
   Continue's self-contradicting capability pages). Every claim this RFC makes about shipped
   behavior must land with a pinning test, per house rule.

## 5. Provider and runtime landscape (verified 2026-08-18)

Facts below were verified against live official documentation on 2026-08-18 by dedicated research
passes; each block names its primary sources. Items that could not be first-party-verified are
marked and repeated in §19.7 (claims needing a live provider-backed test). Model IDs and prices
drift; nothing below is to be hardcoded — this section informs the *shape* of the design and the
initial tracked registry entries, not constants in code.

### 5.1 xAI (Grok) — proprietary hosted, plus an Apache-2.0 agent CLI

- API: `https://api.x.ai/v1`, bearer auth (`XAI_API_KEY` convention), OpenAI-compatible
  `POST /v1/chat/completions` with OpenAI-shaped SSE, plus a native Responses-style API
  (`/v1/responses`, incl. server-side context compaction). Structured outputs via
  `response_format: json_schema` (strict mode, documented constraint caps); OpenAI-style
  function calling. `GET /v1/models` exists but is undocumented (verified live: 401 without
  auth); the docs point at the console for model names. [https://docs.x.ai/developers/rest-api-reference/inference/chat · https://docs.x.ai/developers/models · https://docs.x.ai/developers/model-capabilities/text/structured-outputs]
- Coding models: `grok-4.6` (500k context, flagship), `grok-4.3` (1M), `grok-build-0.1` (256k,
  "agentic software engineering", aliases the retired `grok-code-fast-1`). All list function
  calling + structured outputs + reasoning as supported.
- **Provenance hazard, documented by xAI itself:** the May 15, 2026 retirement auto-redirects
  retired slugs to *different* models billed at the replacement's rates
  (`grok-code-fast-1` → `grok-build-0.1`). A pinned slug can silently change identity without
  erroring. §9.1's requested-vs-actual surfacing is the mitigation, and it generalizes to every
  hosted provider. [https://docs.x.ai/developers/migration/may-15-retirement]
- An Anthropic-style `POST /v1/messages` responds live but is undocumented — usable only after a
  keyed live test (§19.7), and not load-bearing in this design.
- **Grok Build** (CLI command `grok`): xAI's terminal coding agent, open-source
  (xai-org/grok-build, Apache-2.0, Rust). Headless `grok -p` with
  `--output-format plain|json|streaming-json`, session resume, ACP (`grok agent stdio`),
  permission modes (Ask/Auto/Always-approve, deny-wins rules), OS sandbox profiles
  (Landlock/Seatbelt; `read-only` profile is described as suitable for code review) — **sandbox
  off by default, and child-process network blocking is Linux-only**. Custom providers via
  `~/.grok/config.toml` (`base_url`, `env_key`, `api_backend = chat_completions|responses|messages`),
  so it can drive non-xAI models. xAI ships an official Claude Code bridge plugin whose review
  recipe (`grok -p … --sandbox read-only --output-format plain`) is a ready-made reviewer-seat
  shape. It also auto-reads Claude Code config surfaces (CLAUDE.md, skills, MCPs, hooks) —
  which for Camus's hardening posture is a *risk surface to disable*, not a convenience
  (§13). [https://docs.x.ai/build/overview · https://docs.x.ai/build/cli/headless-scripting · https://docs.x.ai/build/features/sandbox · https://github.com/xai-org/grok-build]
- Open weights: grok-1 (2024, stale) and grok-2 (restrictive community license). **No current
  Grok model is open-weight.** Grok support is a proprietary-provider capability, full stop.

### 5.2 Moonshot (Kimi) — hosted API, Anthropic-compatible endpoint, mostly-open checkpoints

- Platform rebranded: `platform.moonshot.ai` → `platform.kimi.ai` (intl) / `platform.kimi.com`
  (CN); API hosts unchanged: `https://api.moonshot.ai/v1` (intl), `api.moonshot.cn` (CN).
  Bearer auth, `MOONSHOT_API_KEY` convention; `GET /v1/models` documented, items carry
  `context_length` and capability booleans. `response_format` supports `json_object` and
  `json_schema`; tool calling supported. [https://platform.kimi.ai/docs/api/chat · https://platform.kimi.ai/docs/api/list-models.md]
- Models: `kimi-k3` (1M context flagship), `kimi-k2.7-code` (+`-highspeed` hosted tier, 262k),
  `kimi-k2.6`, `kimi-k2.5`. The `kimi-k2` series that MULTI-MODEL-SEATS.md's example names
  (`kimi-k2-0905-preview`) is retired — a reminder that declared model lists are operator
  maintenance, not Camus constants.
- **Claude Code compatibility is first-party:** `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic`
  + `ANTHROPIC_AUTH_TOKEN=<kimi key>`. Critically, **all `claude-*` model requests are served by
  the one configured Kimi model** (the guide pins everything, including the per-tier
  `ANTHROPIC_DEFAULT_*_MODEL` vars and `CLAUDE_CODE_SUBAGENT_MODEL`, to `kimi-k3[1m]`). Design
  consequence in §13: when Camus runs a claude_cli executor against Moonshot, the *env
  injection* is the model pin, the CLI's own usage events may echo claude-* names (recorded as
  `reported`, never promoted — §6.2), and identity is recorded as org/family
  `moonshot`/`kimi`, operator `moonshot`, executor `claude_cli`, with `actual` carrying
  `mapped_by_operator_docs` evidence. The `[1m]` suffix semantics are not first-party-defined
  (§19.7).
  [https://platform.kimi.ai/docs/guide/claude-code-kimi]
- Open weights: K2.x line Modified MIT (K2.7-Code, K2.6, K2.5, K2 on Hugging Face);
  **Kimi-K3 is open-weight under a custom license** (MaaS revenue gate at US$20M, attribution
  at scale) — open-weight but not OSI-permissive, and product copy should not call K3 "open
  source". `kimi-k2.7-code-highspeed` is a hosted serving tier with no checkpoint.
- Moonshot's own CLI: Kimi Code CLI (TypeScript, MIT) superseding kimi-cli; OAuth or API-key
  auth; ACP support. Headless contract not yet verified in depth — benchmark-track candidate
  only.

### 5.3 Alibaba Qwen / DashScope — hosted endpoints in flux, cleanly-open checkpoints, strongest CLI scripting contract

- OpenAI-compatible chat completions with `DASHSCOPE_API_KEY`; the docs now lead with
  **workspace-scoped regional domains** (`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`,
  a US `dashscope-us.aliyuncs.com` endpoint, region variants) while legacy
  `dashscope-intl.aliyuncs.com/compatible-mode/v1` still answers. Separate subscription
  "Coding Plan" endpoints exist with their own key env vars. Design consequence: baseUrl is
  operator config with a *why*, never a Camus constant, and doctor's reachability check is the
  guard against endpoint drift. `GET /models` responds live but is not first-party documented
  (§19.7). Anthropic-compatible `/apps/anthropic` endpoints exist per region/plan, mapping all
  claude-* names to one configured Qwen model — same per-seat-pinning consequence as Moonshot.
  [https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope · https://www.alibabacloud.com/help/en/model-studio/claude-code]
- Hosted coding models: `qwen3-coder-plus`/`-flash` (tiered pricing to 1M input),
  `qwen3-coder-next`, with Alibaba now recommending general `qwen3.6/3.7-plus` lines for
  coding plans. Tool calling documented on compatible-mode with a noted `stream=True`
  incompatibility for `tools` (§19.7 — verify before a streaming reviewer uses tools there;
  words-lane reviewers are toolless so unaffected today).
- Open weights: Qwen3-Coder-480B-A35B, Qwen3-Coder-30B-A3B, Qwen3-Coder-Next — **Apache-2.0**
  on Hugging Face. These are the cleanest self-host candidates in the whole landscape
  (permissive license, sizes from 30B-A3B down, GGUF variants). Hosted `-plus`/`-flash` IDs are
  commercial-only; the open checkpoints are a *different* model list an operator declares for a
  self-hosted backend.
- **Qwen Code CLI** (QwenLM/qwen-code; Gemini-CLI lineage, now multi-protocol): auth via
  ModelStudio keys or any custom OpenAI/Anthropic/Gemini-compatible endpoint incl. local
  vLLM/Ollama (`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`, `~/.qwen/settings.json`
  `modelProviders`). The former Qwen OAuth free tier was discontinued 2026-04-15. Headless:
  `qwen -p` with `--output-format text|json|stream-json`, **`--json-schema` forcing a
  schema-validated terminal payload**, distinct exit codes (53 turn-cap, 55 budget, 130
  SIGINT), five approval modes (`plan` read-only … `yolo`), Seatbelt/Docker sandbox. This is
  the strongest headless scripting contract among surveyed CLIs and the leading candidate for
  a non-codex CLI reviewer backend — pending the benchmark, not presumed. [https://github.com/QwenLM/qwen-code/tree/main/docs/users]

### 5.4 OpenAI Codex CLI — custom providers narrowed to the Responses wire

- **`wire_api = "chat"` is removed** (deprecation announced Dec 2025, removal early Feb 2026;
  the config reference now documents `"responses"` as the only and default value). Every Codex
  custom provider must speak the Responses API. [https://learn.chatgpt.com/docs/config-file/config-reference ·
  https://github.com/openai/codex/discussions/7782]
- Custom providers: `[model_providers.<id>]` with `base_url`, `env_key`, header/query
  injection, retry/stream-idle knobs; reserved built-in ids `openai`, `ollama`, `lmstudio`,
  `amazon-bedrock`; profiles + `-c` dot-notation overrides select per invocation. The built-in
  `ollama` provider has a known localhost assumption (issue #8240, closed not-planned) — a
  named custom provider is the reliable path, which suits Camus anyway (explicit decisions).
- `codex --oss` + `oss_provider = ollama|lmstudio` runs local open-weight models; Ollama's own
  Codex page recommends ≥64k context. `codex exec` loads the same config/profiles, so the
  existing gate plumbing can in principle drive a local model through a custom provider — the
  candidate path for "Codex CLI with local/custom providers" in the benchmark (§16). Feature
  gating behind `requires_openai_auth` is under-documented (§19.7).
- gpt-oss-120b/20b: Apache-2.0, tool-calling and structured-output capable, trained on the
  harmony format — **which serving stacks (Ollama/vLLM/LM Studio) handle internally**, so an
  HTTP client of those servers never sees harmony. Direct-weight integration would; Camus never
  loads weights, so this stays a serving-stack concern.

### 5.5 Local inference servers — the compat surface Camus's `openai_compat` backend meets

| server | default bind | compat | discovery / load state | structured output | tool calling | context caveat |
| --- | --- | --- | --- | --- | --- | --- |
| Ollama | `127.0.0.1:11434`, no auth | `/v1` chat-completions + stateless `/v1/responses` (v0.13.3+) | `/v1/models`; native `/api/tags`, `/api/ps` (loaded), `/api/show` (digest, family, quantization, `llama.context_length`) | `format`: JSON schema | yes, but **no `tool_choice`** (cannot force a call) | small default `num_ctx` regardless of model; VRAM-tiered defaults; docs recommend ≥64k for coding agents; over-limit prompts truncate without an API-visible flag (community-documented; §19.7) |
| LM Studio | `127.0.0.1:1234` | `/v1` incl. `/v1/responses` | native REST (`/api/v0`→`/api/v1`): `state` loaded/not-loaded, `quantization`, `max_context_length`, `loaded_context_length`; JIT loading makes `/v1/models` list *downloaded*, not *loaded* | yes | **two tiers**: native (template) vs "default" prompt-emulated — the silent-downgrade pattern §9.2 bans | context set in-app; `loaded_context_length` is checkable |
| vLLM | `:8000`, `--api-key` optional | full OpenAI incl. `/v1/responses` | `/v1/models` reports `--served-model-name` — an explicit alias decoupled from weights | `structured_outputs` (xgrammar/guidance) | `--enable-auto-tool-choice` + per-family `--tool-call-parser`; auto-mode args only schema-constrained with `strict:true` | `--max-model-len`, else derived |
| llama.cpp | `127.0.0.1:8080`, `--api-key` optional | `/v1` incl. converted `/v1/responses` | `/v1/models` single-element; **`/props` returns literal `model_path`, `n_ctx`** — best ground-truth anchor surveyed | GBNF + JSON schema | `--jinja` template-dependent | `n_ctx` visible in `/props` |
| SGLang | `:30000` (conventional) | OpenAI-compatible | `/v1/models` | JSON/regex/EBNF | yes | — |

Cross-cutting fact that anchors §6's inference bans: **every one of these servers lets the
operator alias the served model name** (vLLM `--served-model-name`; `ollama cp`/`create` —
aliasing a local model as `gpt-3.5-turbo` is *officially suggested* in Ollama's compat docs;
llama.cpp `--alias`; LM Studio catalog strings). `/v1/models` is an assertion by whoever
configured the server. The side channels (`/api/show` digests, `/props` model_path, LM Studio
load state) are better evidence but still server-reported, never attested — which is why
`lineage.source` tops out at `operator_declared` for self-hosted backends.

## 6. Core identity architecture: a seat is a record of orthogonal facts, not two fields

The current `provider` string is doing four jobs. The proposal: a **seat identity record** whose
fields are orthogonal, so every downstream consumer (receipts, doctor, badges, independence,
privacy warnings) reads the fact it actually depends on. No field may be inferred from another —
that rule is the whole point, and it is stated per-field below.

Two structural corrections in this revision, both audit-driven. First, the **executor interface
and the inference protocol are different layers**: `executor` says which process shape Camus
drives and watches (an HTTP client, or a headless CLI observed through its event stream), while
`protocol` says which wire dialect reaches the model operator — and a CLI executor can speak
any of them, through any connection, because base-URL env injection is part of how these CLIs
are driven. `cli_events` therefore no longer appears as a protocol; it was an interface fact
wearing a protocol name. Second, **"origin" is two facts plus their evidence**: training
organization and model family split, so that families sharing one organization (gpt and
gpt-oss, both OpenAI-trained) can never masquerade as cross-vendor.

### 6.1 The record

```
seatIdentity = {
  // executor/runtime — the process shape Camus drives, and the interface Camus
  // watches it through (HTTP client vs headless CLI event stream). A Camus-side
  // fact; it says nothing about where inference happens or which wire it speaks.
  executor: 'claude_cli' | 'codex_cli' | 'http_client' | <future: 'qwen_code_cli' | 'grok_cli' | …>,

  // training organization — who trained the weights. THE independence axis.
  trainingOrg: 'anthropic' | 'openai' | 'xai' | 'moonshot' | 'alibaba'
             | 'unknown' | <registry-extensible>,

  // model family — the lineage line. gpt and gpt_oss are DIFFERENT families of
  // the SAME trainingOrg; kimi and qwen are single-family orgs today.
  modelFamily: 'claude' | 'gpt' | 'gpt_oss' | 'grok' | 'kimi' | 'qwen'
             | 'unknown' | <registry-extensible>,

  // lineage evidence — how trainingOrg/modelFamily are known, plus declared
  // derivation (a distillation or fine-tune names its base family, so family
  // overlap through derivation is recordable, not invisible).
  // `source` is DERIVED MECHANICALLY at load (§9.1) from the connection kind,
  // the resolved endpoint, and the tracked registry — it is never written in
  // config, never chosen in the UI, and a template cannot grant it. Config
  // carries only the operator's DECLARATIONS (trainingOrg/modelFamily/
  // derivedFrom); the evidence tier is computed about them.
  lineage: { source: 'registry' | 'operator_declared' | 'unknown',   // derived, not configured
             derivedFrom: '<family>' | null },

  // inference operator — who runs the weights. The privacy axis.
  inferenceOperator: 'anthropic' | 'openai' | 'xai' | 'moonshot' | 'dashscope'
                   | 'self_hosted' | 'gateway:<name>' | 'unknown',

  // protocol — the inference wire dialect between executor and operator,
  // regardless of which process speaks it. 'vendor_session' = a CLI executor on
  // its vendor's own account/session plumbing, where Camus does not see the wire.
  protocol: 'chat_completions' | 'responses' | 'anthropic_messages' | 'vendor_session',

  // transport — how inference bytes leave this machine. 'vendor_managed' = a
  // CLI executor using its own vendor transport with no Camus connection in the
  // path. 'legacy_http' is minted only by migration of pre-connection config
  // (salted grandfather marker, §7) and is recorded honestly wherever it runs.
  // Every non-vendor value applies to CLI executors and http_client alike.
  transport: 'loopback' | 'direct_https' | 'ssh_tunnel' | 'vendor_managed' | 'legacy_http',

  // connection — reference to a named connection profile (§7), or null exactly
  // when transport is vendor_managed. CLI executors MAY name a connection: the
  // env injection that points claude_cli at Moonshot (ANTHROPIC_BASE_URL), or
  // qwen_code at a local vLLM (OPENAI_BASE_URL), can equally point at a Camus
  // connection — including an ssh_tunnel's 127.0.0.1:<port> at run time.
  connection: '<connection name>' | null,

  // the model identity ladder — semantics in §6.2. `reported` is an observation
  // of the endpoint's self-report; `actual` is the sealed judgment WITH its
  // evidence class. A pin is never laundered into an observation.
  modelRequested: '<id>',
  modelResolved:  '<id>',              // = requested; fallback policy stays 'none'
  modelReported:  '<id>' | null,       // what the endpoint/CLI said it ran, verbatim
  modelActual:    { value: '<id>' | null,
                    evidence: 'observed_api_response' | 'observed_cli_event'
                            | 'asserted_pin' | 'mapped_by_operator_docs' | 'none' },

  // credential reference — the NAME of an env var, or none. Never a value.
  auth: { kind: 'env' , envVar: '<NAME>' } | { kind: 'none' },

  // demonstrated capabilities — earned by probe, never self-declared (§9).
  capabilities: { structuredOutput: 'demonstrated' | 'failed' | 'unprobed',
                  toolCalling:      'demonstrated' | 'failed' | 'unprobed' | 'not_applicable',
                  contextWindow:    { status: 'demonstrated' | 'failed' | 'unprobed',   // the probe verdict,
                                     configured: <int> | null,                          // same three-state as
                                     source: 'operator' | 'endpoint' | null,            // every other capability
                                     demonstratedAt: <int> | null },                    // largest size that passed
                  streaming:        'demonstrated' | 'failed' | 'unprobed' },
}
```

### 6.2 The model identity ladder: requested, resolved, reported, actual

Four rungs with distinct epistemic weight, replacing the old triple's overloaded "actual":

- **requested** — what the decision named (with its recorded source), unchanged.
- **resolved** — what Camus-side resolution produced. Still an *intent*: fallback policy is
  `none`, so resolved equals requested, and this rung exists so that if resolution logic ever
  changes, the change is visible rather than folded into "requested".
- **reported** — what the counterparty *said* it ran: the response `model` field, a CLI usage
  event's model name. This is an observation **of a self-report**: strong evidence about
  configuration, zero evidence about weights (§5.5 aliasing). Recorded verbatim, or null when
  the counterparty said nothing.
- **actual** — the sealed judgment, always paired with its **evidence class**:
  - `observed_api_response` / `observed_cli_event`: actual = the reported value, with the
    observation channel named;
  - `asserted_pin`: no observation existed, and the value is the explicit pin Camus itself
    placed on the invocation (`-m`/`--model`/request body). The pin *is* the invocation fact —
    but it is an assertion, and it is sealed as one. **An env/argv pin is never recorded as an
    observed actual**; today's fallback behavior keeps its value and gains its honest label.
  - `mapped_by_operator_docs`: the counterparty documents a server-side mapping (Moonshot and
    DashScope serve every claude-* name with one configured model, §5.2/§5.3), so the mapped
    identity is asserted from the operator's documentation plus Camus's own injection, and any
    claude-* names the CLI reports are recorded in `reported` but do not become `actual`.
  - `none`: no observation and no trustworthy pin → value null, identity `unknown:not-recorded`
    downstream, exactly as today.

  Standing rule: any derivation that *upgrades* a claim (independence, requested≠actual
  reconciliation) may treat only `observed_*` evidence as observation; `asserted_pin` and
  `mapped_by_operator_docs` cap the claim at what the request itself already established.

**Unexpected substitution fails closed.** On any configurable backend, each seat carries an
*expected-reported set*: normally exactly `{ modelResolved }`; for an operator-documented
mapping endpoint (the Moonshot/DashScope Anthropic routes, §5.2/§5.3) the set the mapping
declaration defines (the injected claude-* aliases plus the mapped model id). When `reported`
is non-null and outside that set, **the call is an infra refusal — maker `ok:false`, reviewer
`ran:false` — before any draft or verdict is consumed**, naming both identifiers and the fix
("the endpoint served `grok-build-0.1` where `grok-code-fast-1` was requested — re-declare the
model or repin"). A hosted provider silently redirecting a retired slug (§5.1) therefore
hard-stops a run instead of decorating it; the reconciliation is a deliberate config edit,
never an absorbed observation. When `reported` is null there is nothing to compare — the seat
proceeds and seals `asserted_pin`, which is the honest ceiling for endpoints that do not
self-report. The CLI gate already enforces the same shape (`asGate` refuses a binding whose
model disagrees with the workflow's expectation); this rule is its Studio-adapter twin.

### 6.3 Worked distinctions (why two fields were not enough)

| seat | executor | org/family | operator | protocol | transport |
| --- | --- | --- | --- | --- | --- |
| Qwen via a lab box | `http_client` | `alibaba`/`qwen` | `self_hosted` | `chat_completions` | `ssh_tunnel` |
| Qwen via DashScope | `http_client` | `alibaba`/`qwen` | `dashscope` | `chat_completions` | `direct_https` |
| Grok via xAI API | `http_client` | `xai`/`grok` | `xai` | `chat_completions` | `direct_https` |
| Grok via Grok Build on its own account | `grok_cli`* | `xai`/`grok` | `xai` | `vendor_session` | `vendor_managed` |
| Kimi via Claude Code | `claude_cli` | `moonshot`/`kimi` | `moonshot` | `anthropic_messages` | `direct_https` |
| Kimi via Moonshot API | `http_client` | `moonshot`/`kimi` | `moonshot` | `chat_completions` | `direct_https` |
| gpt-oss on a GPU server | `http_client` | `openai`/`gpt_oss` | `self_hosted` | `chat_completions` | `ssh_tunnel` |
| local Qwen via Ollama | `http_client` | `alibaba`/`qwen` | `self_hosted` | `chat_completions` | `loopback` |
| Qwen Code CLI at a tunneled vLLM | `qwen_code_cli`* | `alibaba`/`qwen` | `self_hosted` | `chat_completions` | `ssh_tunnel` |

\* only if the benchmark (§16) qualifies it; listed to show the axis, not to promise the seat.

Three rows carry the load. **Kimi-via-Claude-Code**: the executor (`claude_cli`) contributes
*capability* facts (tools, session continuation), the org/family (`moonshot`/`kimi`)
contributes the *independence* fact, and the row is now expressible without special-casing —
the executor speaks `anthropic_messages` over a `direct_https` connection whose operator is
`moonshot`, because Anthropic never sees those prompts; recording `anthropic` anywhere in that
row would be false on both the privacy and independence axes. **gpt-oss on a GPU server**: the
family differs from `gpt` but the organization is `openai`, so a GPT/Codex maker paired with a
gpt-oss reviewer is same-organization — advisory, never cross-vendor (§10 rule 1); the old
single-field `openai_oss` origin would have made this pairing falsely independent, which is
exactly why the field split exists. **Qwen Code at a tunneled vLLM**: a CLI executor riding a
Camus connection — executor interface and transport are fully independent axes, and the
connection's qualification, preflight, and provenance (§7–§9) apply to CLI executors exactly
as they do to `http_client`.

### 6.4 Inference bans (each one closes a real forgery lane)

- **Org/family are never inferred from the endpoint.** A vLLM server started with
  `--served-model-name gpt-5.6-sol` will happily report OpenAI's model name from `/v1/models`
  while serving a 3B parameter model. Endpoint-reported names are evidence of *configuration*,
  not of *weights* — they live in the `reported` rung of the identity ladder (§6.2) and never
  feed lineage, whose tier for any self-hosted endpoint tops out at `operator_declared` (§9.1).
- **Org/family are never inferred from the executor.** Claude Code running against Moonshot is
  not Anthropic-trained. Codex running against Ollama (`--oss` / custom provider) is not
  OpenAI-hosted inference — though the *family* being served may still be OpenAI-trained
  (gpt-oss), which is the registry's fact to state, not the executor's.
- **Org/family are never inferred from the model string.** An Ollama Modelfile can `FROM` any
  local blob and name the result `qwen3-coder`. A model string is a lookup key, not a pedigree.
- **A family difference is never an organization difference.** gpt vs gpt_oss, or any future
  sibling families, share a `trainingOrg` and therefore share its independence consequences.
  Only the registry may state that two families belong to different organizations; a new or
  unknown family defaults its org to `unknown`, which fails independence closed (§10 rule 2).
- **Operator is never inferred from org/family.** Open-weight Kimi served by a gateway is
  `gateway:<name>`, not `moonshot`; the gateway sees the prompts.
- **`modelReported` is recorded verbatim and proves configuration only; `modelActual` carries
  its evidence class** (§6.2). Nothing is guessed from latency, price, tokenizer behavior, or
  answer style, and no pin becomes an observation.

### 6.5 Persistence and migration of the old `provider` field

The sealed-schema change ships with this work as **pairing schemaVersion 2**, fully specified
in §10.8 (the former open questions U1/U2 are resolved there). Existing v1 receipts are never
reinterpreted structurally; what changes is how *configuration* migrates into the new fields,
and the rule is deliberately asymmetric:

- **Built-in backends migrate their declarations authoritatively; their evidence tier is
  earned, not granted.** `claude` → `trainingOrg: anthropic`, `modelFamily: claude`;
  `codex` → `trainingOrg: openai`, `modelFamily: gpt` — the org/family facts ship in the
  registry, because those provider strings were Camus-authored constants with exactly one
  historical meaning. The *tier* comes from §9.1's vendor-managed branch, which requires
  proven redirect isolation per executor: **codex qualifies for `registry` today** (scrubbed
  env + `--ignore-user-config`, both test-pinned); **claude derives `unknown` until either
  its spawn isolation lands or the operator explicitly confirms the active route** (§9.1) —
  the current adapter inherits the parent environment, so an unisolated route could serve
  anything, and `operator_declared` would be a lie of attribution: that tier means *the
  human operator* declared it, and no human did.
- **Configurable legacy entries do not.** An `openai_compat` entry's `provider` was free text
  typed by an operator, and nothing constrains what it meant — "moonshot" might have meant
  trainer, operator, or endpoint brand. A legacy configurable entry therefore loads with
  `trainingOrg: unknown`, `modelFamily: unknown`, `lineage.source: unknown`, and its old
  `provider` string retained as a display label plus the receipts' string prefix (unchanged
  behavior on the wire). Doctor and the settings panel name the gap and offer a one-edit
  confirmation ("declare training org and family for backend kimi"); until the operator
  confirms, §10 rule 2 applies and any pairing involving the entry seals at advisory standing.
  Never migrating a guess into an authoritative origin costs a few operators one config edit
  and prevents a class of silently-forged cross-vendor claims — the correct trade.

For receipt string forms, `requested/resolved` keep `provider:model` prefixes as today (legacy
prefix = the seat's historical string), while v2 pairing carries the structured fields
alongside; `packages/trust/lib/status.mjs` derivations read the structured facts when present
and fall back to v1 semantics for v1 packs (§10.8).

## 7. Connection architecture

Today an `openai_compat` entry owns a bare `baseUrl`. That shape cannot express "reachable only
through a tunnel", cannot be preflighted independently of the model, and invites operators to
paste `http://192.168.1.40:11434` style URLs whose reachability and trust story Camus cannot
reason about. The proposal: **connections become named, typed objects; backends reference them.**

Four kinds, of which the first three are in scope:

- `loopback` — an inference server on this machine (`127.0.0.1`/`::1` only). No credentials
  required; optional bearer auth supported (LM Studio and vLLM can require keys even locally).
- `direct_https` — a hosted provider endpoint (`https://` only, no literal-IP hosts; see SSRF
  rules in §15). This is where DashScope, Moonshot, and xAI live.
- `ssh_tunnel` — a managed OpenSSH **local forward** to a private server's loopback-bound
  inference port. §8 owns its entire lifecycle and security posture. It is an inference
  transport only: no remote command execution, no file sync, no repo copies, no remote
  workspace. Ever. A future need for any of those is `remote_executor`.
- `remote_executor` — reserved name, **not in this RFC's scope** (§14). Declaring one refuses to
  load with a message naming the ADR.

### Configuration shape (proposed; local operator state, never tracked)

```jsonc
// ~/.camus/studio/models.json (extended) — same file, same precedence rules
{
  "connections": {
    "gpu_lab": {
      "kind": "ssh_tunnel",
      "sshHostAlias": "camus-gpu",     // declared in ~/.ssh/config; Camus stores no host details
      "remoteAddress": "127.0.0.1",    // MUST be a remote-loopback literal (127.0.0.1/::1/localhost):
                                       // the tunnel reaches the GPU box's OWN service, never a third
                                       // host through it — anything else turns the box into a pivot
      "remotePort": 11434,
      "basePath": "/v1",
      "why": "lab 4090 box, added 2026-08-18 for qwen reviewer trials"
    },
    "local_ollama": {
      "kind": "loopback",
      "port": 11434,
      "basePath": "/v1"
    },
    "dashscope_intl": {
      "kind": "direct_https",
      "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    }
  },
  "backends": {
    "qwen_lab": {
      "kind": "openai_compat",
      "connection": "gpu_lab",
      "protocol": "chat_completions",
      "trainingOrg": "alibaba",        // declarations; the evidence TIER is derived at load
      "modelFamily": "qwen",           // (§9.1) and can never be written here
      "derivedFrom": null,
      "inferenceOperator": "self_hosted",
      "auth": { "kind": "none" },
      "models": ["qwen3-coder-30b-a3b-instruct-q8"],
      "seats": ["reviewer"],
      "why": "..."
    }
  }
}
```

Rules, in the same fail-closed register as `validateCompatEntry()`:

- A backend names either a `connection` or (back-compat) a bare `baseUrl`. A bare `baseUrl` is
  internally migrated to an anonymous connection at load — so existing files keep working
  unchanged and every code path downstream sees only connections — classified mechanically:
  - host is `127.0.0.1`/`::1`/`localhost` → `loopback`;
  - `https://` with a public DNS hostname → `direct_https`;
  - **anything else — `http://` to a non-loopback host, a literal IP, a private-range or
    internal hostname (the real-world "Ollama on 192.168.x.x" case) → the grandfathered
    `legacy_http` kind.** A `legacy_http` connection behaves exactly as the old code behaved
    (direct fetch to the URL), loads with a doctor warning naming its three upgrade paths
    (move the service to loopback, front it with an `ssh_tunnel` connection, or put it behind
    a real HTTPS endpoint), is exempted *by name* from §15's SSRF refusals (grandfathered,
    warned, recorded), and stamps `transport: legacy_http` into every identity record and
    pairing it touches so no receipt dresses it up as anything sturdier.

    **The grandfather boundary is durable, one-time, and fail-closed as a complete
    contract — reconciled with "config files stay unchanged on disk."** A marker minted in
    memory at every load would be no boundary at all, and a sidecar whose absence recreates
    "first launch" would be no boundary either: deleting one file must never re-open the
    gate. The contract:

    - **Two durable artifacts, so deletion is detectable.** The records file
      `~/.camus/studio/grandfather.json` (0600) and a separate initialization-complete
      marker `~/.camus/studio/grandfather.initialized` (0600, recording the initialization
      timestamp and release version). Initialization order: records first (atomically), then
      the marker — and **crash recovery never re-runs the inventory**: if `grandfather.json`
      exists but the marker is missing, recovery *validates the existing records* (schema,
      HMACs) and writes the marker to finish initialization, without inspecting any config
      entry the records don't already name — an entry added during the crash window is not
      swept in, and a deleted marker cannot reopen bulk grandfathering. The inventory itself
      runs exactly once, when *neither* artifact exists. Once the marker exists,
      initialization never runs again on this machine.
    - **Versioned schema.** `grandfather.json` = `{ schemaVersion: 1, initializedAt,
      releaseVersion, records: [...] }`; an unknown `schemaVersion` refuses (fail closed,
      same rule as every published schema in this RFC). Each record:
      `{ backendName, url, source: 'snapshot' | 'operator_confirmation', why: '<text|null>',
      recordedAt, marker }` where `marker = HMAC-SHA256(machineSalt, backendName ‖ url ‖
      source ‖ why ‖ recordedAt)` — **the confirmation's `why` and `source` are inside the
      HMAC**, so a record cannot be re-purposed or its provenance edited without breaking
      its marker. Snapshot records carry `why: null`; confirmation records carry the
      operator's text.
    - **Atomic writes.** Every mutation writes a temp file in the same directory, fsyncs,
      and renames over the original; a torn write therefore leaves either the old file or
      the new one, never a hybrid.
    - **Fail closed after initialization.** With the marker present: a missing, unparseable,
      wrong-version, or marker-invalid `grandfather.json` means **every `legacy_http` entry
      refuses to load**, with the error naming the state ("grandfather records missing but
      initialization is complete — restore the file or re-confirm each entry explicitly")
      and the per-entry confirmation action as the recovery path. There is no bulk
      re-snapshot, ever: initialization is one-time by the marker, and recovery is
      per-entry, human, recorded.
    - **First launch, precisely.** The inventory runs only when neither the marker nor
      `grandfather.json` exists; it records the legacy-shaped private-HTTP entries present
      at that moment, `source: 'snapshot'`. Records-present-marker-absent is crash recovery
      (finish the marker, above), never a second inventory.

    Lifecycle: a legacy-shaped entry **with** a verifying record loads (doctor-warned as
    before); one **without** — pasted, restored from another machine's backup (different
    salt), or added by a tool — refuses, naming the three upgrade paths and the one
    legitimate escape hatch: the **explicit confirmation action** (doctor/settings: "confirm
    legacy HTTP backend <name>", requiring a `why`) that appends a fresh
    `operator_confirmation` record. Accidental and silent minting is impossible; deliberate
    minting is a recorded human decision, which is the standard everything else in this file
    is held to. Records are removed when their entry upgrades or is deleted; the machine's
    owner can of course forge their own sidecar — the honesty backstop is independent of the
    gate: however a `legacy_http` entry came to exist, receipts stamp its transport as
    `legacy_http`, so the standing never launders. The whole mechanism sunsets one release
    after slice D ships the sanctioned tunnel path, after which such entries refuse at load
    with the same three fixes named and both sidecar artifacts are retired.
- **Dual-write for rollback safety — against the shipped validator's full field list.** The
  currently shipped `validateCompatEntry()` requires, per entry: a backend key matching
  `^[a-z][a-z0-9_-]{0,31}$`; `kind === 'openai_compat'`; `provider` a non-empty plain string
  (not `'unknown'`, no `:`); `baseUrl` matching `^https?://`; `apiKeyEnv` a non-empty string;
  `models` a non-empty list of non-empty strings; `seats` (when present) a non-empty subset of
  `maker`/`reviewer`. One refusing entry breaks `listBackends()` → `getModels()` wholesale, so
  a rollback-loadable entry must satisfy **every one of those fields**, not just `baseUrl`.
  Therefore, whenever the writer persists a backend whose connection is representable as a URL
  (`loopback`, `direct_https`, `legacy_http`), it dual-writes the complete legacy surface:
  `baseUrl` derived from the connection; `provider` kept as the operator's display label (for
  new entries the label is collected at creation and validated against the legacy rules —
  never the string `unknown`, never a colon); `apiKeyEnv` set to the real env-var name when
  `auth.kind === 'env'`, and to the documented placeholder name **`CAMUS_NO_AUTH`** when
  `auth.kind === 'none'`; `models`/`seats` written as today. **The guarantee is two-tier,
  stated precisely.** For every dual-written entry: *load isolation* — rolled-back
  `getModels()` does not throw, so one new-style entry can never take every backend down with
  it (the wholesale-failure mode is the disaster this exists to prevent). For *keyed* entries
  additionally: full functional parity under rollback. For *keyless* entries there is **no
  functional-parity claim**: rolled-back code demands `CAMUS_NO_AUTH` at call time, so the
  backend is load-safe but non-functional until a one-line manual step — set `CAMUS_NO_AUTH`
  to any value (keyless servers ignore the bearer header) or remove the entry — and if the
  variable happens to be pre-set, rolled-back runs work while sending its value as a bearer
  token a keyless server ignores, noted here so nobody mistakes it for authentication.
  Load-time treats any conflict between the dual-written legacy fields and the connection as
  a refusal naming both. `ssh_tunnel`-connected backends have no honest static URL, are new
  capability with no legacy reader, and are the documented rollback exception (§19.4).
- Backends usable by CLI executors carry the same `connection` reference; the executor's env
  injection (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, codex `model_providers.*.base_url`)
  receives the connection's resolved runtime URL at spawn, so CLI and `http_client` seats share
  one connection lifecycle, preflight, and provenance story.
- A backend naming an undeclared connection refuses to load. A connection with no backend is
  legal (declared ahead of use) and doctor reports it as unused.
- **Runtime state never becomes standing configuration.** The ephemeral local port a tunnel
  binds, and the resolved `http://127.0.0.1:<port>/v1` URL, exist only in the run/tunnel state.
  Writing either into `models.json` would freeze a value that is different on every launch and
  would invite the config to be "fixed" by hand into a stale pin.
- `auth.kind: 'env'` carries only the env-var *name*, identical to today's `apiKeyEnv`. SSH
  connections take `auth.kind: 'none'` for the HTTP hop by default, with optional bearer auth
  for servers that require keys even on loopback; SSH's own authentication belongs to
  `~/.ssh/config` and the agent, never to Camus config (§8).
- `trainingOrg`, `modelFamily`, and `lineage` are **required on new-style entries**. A legacy
  configurable entry is **not** origin-migrated: it loads with all three `unknown` (its old
  `provider` string survives as a display label and the receipts' string prefix) until the
  operator explicitly confirms org/family — §6.5's asymmetric rule. Built-ins migrate from the
  registry; typed operator strings never do.
- `remoteAddress` on an `ssh_tunnel` connection must be a loopback literal (`127.0.0.1`, `::1`,
  or `localhost`); any other value refuses to load. Reaching a third host through the GPU box
  is a pivot, not an inference transport, and belongs (if it ever belongs anywhere) to the
  remote-executor ADR's threat model, not this one.

### Doctor and preflight become connection-first

`runDoctor` grows a per-connection check that runs *before* (and independently of) per-backend
checks: loopback → TCP connect + `GET /models`; direct_https → DNS/TLS/`GET /models` (deep mode,
as today); ssh_tunnel → the twelve-step preflight in §8.5. A backend check then composes: its
connection's status, key presence, declared-model visibility in discovery output (§9), and
capability-probe freshness. Every failing check keeps the doctor's contract: the exact fix a
person can paste.

## 8. The managed SSH inference tunnel

The single most security-sensitive piece of this RFC. The design goal, stated once and enforced
everywhere: **an `ssh_tunnel` connection moves inference bytes between Studio/CLI and one remote
loopback port. It executes nothing remotely, copies nothing, forwards nothing else, and dies
with its owner.**

### 8.1 Posture decisions

- **System OpenSSH client, not a bundled SSH library.** The operator's existing trust material
  (`~/.ssh/config`, `known_hosts`, agent, hardware keys, `ProxyJump` bastions, per-host quirks)
  lives in OpenSSH, is audited by decades of use, and receives security updates through the OS.
  A bundled JS SSH implementation would re-own all of that with none of the maturity, and would
  put private-key parsing inside Camus's process. Evidence that would justify revisiting: none
  anticipated; a platform without a usable `ssh(1)` simply does not get this feature.
- **A dedicated `Host` alias is the unit of configuration.** Camus config stores only
  `sshHostAlias`; usernames, hostnames, ports, identities, `ProxyJump`, jump-host details stay in
  `~/.ssh/config` where they already live and where the operator already maintains them. Docs
  recommend a Camus-specific alias (e.g. `Host camus-gpu`) so unrelated directives on broader
  patterns don't apply — but recommendation is not enforcement; enforcement is §8.3.
- **Camus never touches SSH secrets.** No passwords (BatchMode forbids the prompt), no key
  paths in Camus config, no passphrase handling, no `known_hosts` writes. Host trust is
  established by the operator running `ssh camus-gpu` once themselves; Camus only ever
  *verifies* that trust exists and refuses when it does not. `StrictHostKeyChecking=no` never
  appears, in any mode, including tests.
- **Foreground child, not `-f`.** The tunnel is spawned as a direct child process (argv array,
  no shell) so its lifetime is observable and its termination is Camus's to own. `-f` would
  detach it into a process Camus can only hunt by pattern-matching, which is exactly the PID
  hygiene lesson the review watchdog already learned the hard way.

### 8.2 The spawn contract

Spawned with `spawn('ssh', argv)` — an argv array, never a shell string, never operator-supplied
raw command text. The alias is validated against a strict charset (`^[A-Za-z0-9._-]+$`, no
leading `-` so it can never be read as an option) before it is placed as the final argv token.

```
ssh
  -N -T                     // SessionType none: no remote command session exists at all; -T is free belt
  -o BatchMode=yes          // any interactive prompt = failure (exit 255), never a hang
  -o ExitOnForwardFailure=yes
  -o StrictHostKeyChecking=yes
  -o ClearAllForwardings=no // first-value-wins: a config-side ClearAllForwardings=yes cannot silently delete our -L
  -o ForwardAgent=no -o ForwardX11=no
  -o PermitLocalCommand=no
  -o ControlMaster=no -o ControlPath=none
  -o Tunnel=no
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o ConnectTimeout=10
  -L 127.0.0.1:<localPort>:<remoteAddress>:<remotePort>
  --                        // end of options: the alias can never parse as a flag
  <sshHostAlias>
```

(Flag semantics verified against ssh(1)/ssh_config(5) as of OpenSSH 10.5, plus empirical `-G`
runs on 10.3p1, 2026-08-18. `-F` is deliberately left at default — the user's own config *is*
the feature; `-f`, `-i`, `-g`, and `-q` are deliberately absent.)

Rationale per flag, tied to the requirements list:

- `-N -T`: no remote command runs and no TTY is allocated. This is the "transport only"
  promise's mechanical half.
- `BatchMode=yes`: passphrase/password/2FA prompts become immediate failures with a named fix
  ("load your key into the agent / configure noninteractive auth for camus-gpu") instead of a
  silently hung child. Onboarding UX may *tell* the operator to run interactive `ssh` in their
  own terminal; Camus's own spawns are batch, always.
- `ExitOnForwardFailure=yes`: a forward that cannot bind or connect kills the process with a
  nonzero exit instead of leaving a "connected" tunnel that forwards nothing. This is the
  load-bearing forward-failure detector; the TCP probe in §8.4 is the belt.
- `StrictHostKeyChecking=yes`: an unknown or **changed** host key is a hard refusal. Changed-key
  handling is deliberately rude: Camus surfaces OpenSSH's own MITM warning text (host name
  redacted per §8.6) and the fix is manual re-verification by the operator, never an automated
  re-accept.
- `ForwardAgent=no`: the inference host must never be able to sign with the operator's keys. A
  config-declared `ForwardAgent yes` on the alias is overridden — command-line wins over config
  for first-value options.
- `ControlMaster=no -o ControlPath=none`: no multiplexing. Sharing a master socket would let the
  tunnel's lifetime and the forward set be mutated by other ssh invocations outside Camus's
  ownership, and inherit forwards Camus never audited.
- `PermitLocalCommand=no`, `Tunnel=no`: close the remaining config-injectable execution and
  tun-device surfaces (a config `LocalCommand` stays visible in `-G` output but is inert once
  `PermitLocalCommand=no` pins it).
- `ClearAllForwardings=no`: see §8.3 — protects the tunnel's own `-L` from a config-side
  clear; the config-declared-forward hazard is handled by preflight detection, not by this
  flag.
- `ServerAliveInterval/CountMax` (encrypted, in-channel keepalives — chosen over spoofable
  TCPKeepAlive) bound dead-peer detection at ~45s; `ConnectTimeout` bounds setup.
- `-L 127.0.0.1:...`: explicit loopback bind address. Never a wildcard, never reliant on
  `GatewayPorts` defaults. `<localPort>` is chosen by Camus (§8.4), never by config.

### 8.3 The operator's ssh_config is an input, not an authority

`ssh <alias>` activates whatever the operator's config attaches to that alias — including
directives that would break the transport-only promise: `LocalForward`, `RemoteForward`,
`DynamicForward`, `LocalCommand`+`PermitLocalCommand`, `ForwardAgent`, `ForwardX11`,
`ControlMaster`. Two classes, two treatments:

- **First-value options** (`ForwardAgent`, `ForwardX11`, `PermitLocalCommand`, `ControlMaster`,
  `Tunnel`, `StrictHostKeyChecking`, `BatchMode`…): command-line `-o` wins, so §8.2 neutralizes
  them deterministically.
- **Cumulative directives** (`LocalForward`, `RemoteForward`, `DynamicForward`, `IdentityFile`):
  these *accumulate* across command line and config rather than being overridden, so no `-o`
  can selectively neutralize them. And the tempting wholesale answer is a trap that is now
  settled, not speculated: **`ClearAllForwardings=yes` clears the command-line `-L` too.** The
  man page's "primarily useful … to clear port forwardings set in configuration files" invites
  the opposite reading, but in `readconf.c` `clear_forwardings()` runs from
  `fill_default_options()` *after* every option source has been parsed into one struct, and an
  empirical `ssh -G -o ClearAllForwardings=yes -L 127.0.0.1:…` on OpenSSH 10.3p1 emits no
  `localforward` line in either argument order. So Camus never combines the two; instead it
  passes `-o ClearAllForwardings=no` (a first-value option, so a config-side
  `ClearAllForwardings yes` cannot silently delete the tunnel's own forward) and handles
  config-declared forwards by detection:

  **Preflight with `ssh -G <same argv, plus -G>`** — which prints the resolved effective
  configuration (lower-case `key value` lines; parse case-insensitively — sshd's `-G` went
  mixed-case in 10.4) without making an SSH connection. Refuse to start the tunnel when the
  effective config contains any `localforward` entry beyond the one Camus passed, any
  `remoteforward`/`dynamicforward`, `permitlocalcommand yes`, `forwardagent yes`,
  `tunnel` ≠ no, `clearallforwardings yes`, or a `controlmaster` that is not no-shaped. The
  refusal names the directive and the fix ("move it off Host camus-gpu, or give Camus a
  dedicated alias"). Fail closed: unparsable `-G` output, or an `ssh -G` that errors, refuses
  too. This behavior is implementation-verified rather than documented contract, so the test
  suite keeps a cheap per-version regression probe
  (`ssh -G -o ClearAllForwardings=yes -L … | grep -c localforward` must be 0 — §17).

  `ProxyCommand` and `Match exec` are **trusted operator configuration**, not hazards to warn
  about: the operator who declared them owns the local machine and the transport policy, the
  same way they own their keys, agent, and `ProxyJump` bastion chain. Preflight neither refuses
  nor warns on them; it records their presence in the local diagnostics record (§8.6) so a
  debugging session can see the transport shape, and that is all. (`Match exec` runs during
  config evaluation *including under `-G`* — one more reason the preflight is documented as
  "evaluates your ssh config", not as side-effect-free.) `RefuseConnection` (10.1+) simply
  refuses with the operator's own message, passed through the redaction templates. `ProxyJump`
  works transparently under `-L`, with the documented caveat that command-line `-o` hardening
  governs the *destination* connection, not the jump-host sub-connection — jump-host behavior
  comes from the operator's config, recorded in diagnostics likewise. The refusal screen in
  this section is reserved for the directives that would change what *Camus's own connection*
  forwards or executes on the wire it owns: forwards, agent/X11, local command execution,
  multiplexing.

### 8.4 Port selection, liveness, lifecycle

- **Local port**: Camus binds `127.0.0.1:0`, reads the kernel-assigned port, closes the probe
  socket, and hands that port to `-L`. The close-to-spawn race is tolerated because
  `ExitOnForwardFailure=yes` turns a lost race into a loud exit, and the manager retries once
  with a fresh port. Generated ports and the resolved `http://127.0.0.1:<port><basePath>` URL
  are runtime state only (§7) — never written to config, receipts may name the *connection*, not
  the port.
- **Up-ness** is three independent facts, all required: the child is running;
  `ExitOnForwardFailure` has not fired (a failed listener bind kills the process, exit 255 —
  but note the documented boundary: it covers *listener setup only*, and per-connection
  failures to the forwarding destination never kill ssh); and a TCP connect **plus** one application
  request (`GET <basePath>/models` or the configured discovery path) through the forward
  succeeds within the setup timeout — the app-level request is what proves the far end
  answers, which ssh itself never will. OpenSSH prints no machine-readable success signal at
  default log level; stderr is logged for diagnostics, never parsed for control flow.
- **Ownership, leases, and the honest orphan claim.** One tunnel manager in the Studio server
  process (CLI: in the invoking process) owns each child. Reference-counted per connection:
  concurrent runs share one tunnel; the count dropping to zero starts a short linger timer,
  then SIGTERM → bounded wait → SIGKILL (the child is a direct process, not a process group of
  unknown descendants). Studio exit, run abort, and doctor completion release references; an
  `exit`/`SIGINT`/`SIGTERM` handler tears down every tunnel on any orderly shutdown.

  Orderly paths cover most lives; a SIGKILL'd or crashed manager does **not** kill its child —
  a foreground `ssh -N` has no parent-death trigger and keeps forwarding. The design is
  therefore crash-safe by *lease*, not by wishing: at spawn, the manager writes a lease file
  (`~/.camus/studio/tunnels/<connection>/lease.json`, 0600) recording pid, the child's
  observed start time, local port, connection name, and owning-server identity; the lease is
  deleted on orderly teardown. On every Studio/CLI startup and every doctor run, the manager
  sweeps leases: a leased pid that is alive **and** whose process start time matches the lease
  (the `codex_review.sh` adoption discipline — `ps -o lstart` identity proof, never a bare
  pid) is a Camus orphan and is killed and its lease cleared; a pid mismatch means PID reuse —
  the stranger is left alone and the stale lease is cleared. Residual risk, stated plainly:
  **between a manager crash and the next sweep, a healthy orphaned tunnel keeps its loopback
  port open** (ServerAlive keepalives only bound the dead-peer case, not a healthy orphan).
  The window ends at the next launch/doctor; the lease file's timestamps make the exposure
  period reconstructable; and the §8.5 flow surfaces "an orphaned tunnel from a previous
  session was found and closed" rather than silently reaping.
- **Mid-request death fails closed.** The adapter's existing kill-path taxonomy grows one code:
  `tunnel`. A request in flight when the child exits surfaces as
  `ok:false` / `ran:false` infra with the tunnel-death cause; the run never falls back to a
  direct endpoint, a cached IP, or a retry outside the tunnel. There is no "fallback endpoint"
  concept anywhere in this design — `resolved = requested`, fallback policy `none`, exactly as
  the model triple already works.

### 8.5 Preflight ladder (doctor `--deep`, and the Studio "Connect own server" flow)

Ordered so each step's failure names exactly one fix; later steps never run after an earlier
refusal. Steps 1–6 are connection facts, 7–12 are backend/model facts (§9's qualification
probes, run through the tunnel):

1. `ssh -V` runs → OpenSSH present (version recorded for diagnostics).
2. `ssh -G <full argv>` succeeds and yields a non-empty `hostname` → the config *evaluates*.
   Stated honestly: **`-G` cannot prove the alias exists** — an undeclared name still evaluates,
   with the alias itself standing in as the hostname. The check therefore only *flags* the
   `hostname == alias` shape ("no config stanza may have matched this name — if `camus-gpu` is
   an alias, check the spelling; if it is a real hostname, this is fine") and moves on; the
   authoritative existence proof is step 5's handshake, where a typo'd alias fails DNS or host
   trust with that flag already on screen to explain it.
3. The `-G` output passes the §8.3 directive screen → the alias is transport-clean
   (ProxyCommand/Match exec/ProxyJump presence recorded in diagnostics as trusted operator
   transport, per §8.3 — not screened).
4. Host trust, **advisory pre-check**: `ssh-keygen -F` against the key-lookup name the `-G`
   output actually implies — `hostkeyalias` when set, else the resolved `hostname` (`[host]:port`
   form for non-22) — searched across **every file listed in the resolved `userknownhostsfile`
   and `globalknownhostsfile` values** (each via `ssh-keygen -F -f <file>`), since operators
   may point aliases at custom known-host files. A hit predicts the handshake will pass; a miss
   predicts a first-contact refusal, and the fix line (the exact interactive `ssh` command to
   run once) is shown *now*, before any spawn. Advisory only: `-F`'s exit codes are
   undocumented (parse for a non-comment output line), `CheckHostIP` and hashed entries add
   edge cases, and none of this is the decision —
5. — **the handshake is authoritative.** The manager spawns the real §8.2 argv (which carries
   `StrictHostKeyChecking=yes` and `BatchMode=yes`) with the real forward. OpenSSH itself then
   renders the only verdicts that count: unknown host key → refusal (exit 255) mapped to the
   step-4 fix; **changed** host key → refusal surfaced through the MITM template, fix = manual
   re-verification by the operator, never an automated re-accept; interactive-only auth →
   BatchMode failure with the agent/key fix named; forward bind failure → `ExitOnForwardFailure`
   exit. Success means host trust, noninteractive auth, and listener setup all held on the
   *actual* connection — no probe-vs-real drift, because the probe *is* the real spawn kept
   alive for the following steps.
6. Loopback-only and remote service answer, on the live child from step 5: the manager connects
   to `127.0.0.1:<port>` (must succeed) and to the machine's non-loopback addresses on the same
   port (must refuse); then one application request through the forward proves the far service
   answers (ExitOnForwardFailure never covers destination connects, §8.4).
7. `GET /models` (or the executor's discovery equivalent) through the tunnel returns a parseable
   model list.
8. The backend's declared model IDs appear in that list (a miss is a named warning, not silent
   absence — the declared list stays authoritative for what may be *seated*).
9. Protocol compatibility: one minimal `chat_completions` (or configured protocol) request
   round-trips.
10. Structured output: the reviewer-shaped JSON-schema probe passes (§9).
11. Tool calling: probed only if the seat's contract requires tools (words-lane seats today do
    not; a future maker executor does).
12. Context window: the configured window is stated by the operator or reported by the endpoint,
    and a probe near the words-lane prompt size fits. A window nobody stated is `unprobed`, and
    §9 says what `unprobed` may sit in.

The Studio flow runs these as a visible checklist with per-step fixes. The browser POSTs
`{connection: "gpu_lab"}` to the local server and renders progress from SSE; **the browser never
receives SSH configuration, never triggers `ssh` argv construction from page-supplied strings,
and never sees stderr diagnostics pre-redaction** — it sees step statuses and redacted fix
lines. The CLI (`camus-studio --doctor --deep`, and a future `camus connect doctor`) emits the
same ladder with the same semantics, because both call the same module.

### 8.6 Diagnostics: bounded and redacted by default, raw only on explicit opt-in

SSH stderr is diagnostic gold and privacy poison: it can carry usernames, hostnames, IPs, key
paths, and banner text. Rules:

- Session lines and receipts name connections by their Camus name (`gpu_lab`) and step
  outcomes only; never into `events.jsonl`, `report.json`, or the evidence pack.
- **There is no persistent raw stderr by default.** The manager holds stderr in a bounded
  in-memory ring (last 64 KiB), redacts it line-by-line (usernames, hostnames, IPs, key paths,
  and credential-shaped values replaced by typed placeholders; unrecognized lines reduced to
  their matched failure class), and writes only that **redacted, size-capped** record — plus
  structured lease/open/close/exit events — to the local diagnostics file
  (`~/.camus/studio/tunnels/<name>/diagnostics.log`, 0600) when a step fails or the child dies
  unexpectedly. Success paths persist the structured events only, and the ring is dropped.
- Raw capture exists solely behind an explicit opt-in (`STUDIO_TUNNEL_DEBUG=1`), announced
  loudly at startup ("raw SSH diagnostics are being written to <path>; they may contain
  hostnames and usernames"), still 0600, and never referenced from receipts.
- Error text shown in the UI is allowlist-templated (known OpenSSH failure classes mapped to
  fixed strings + the Camus connection name), not pass-through. The existing proxy-userinfo
  scrubbing precedent in the codex adapter (`scrubbedEnv`) is the register to match.

### 8.7 What SSH does not prove

A working, host-verified tunnel proves Camus reached *that machine's* forwarded port. It proves
nothing about which weights the process behind the port loaded. `lineage.source` for anything
reached this way is at best `operator_declared`, the receipts say so, and §10 keeps such seats
out of unqualified "independent cross-vendor" claims. No amount of transport security upgrades
into weight attestation, and no session line may imply otherwise.

## 9. Model discovery and seat qualification

Discovery exists to *inform the operator*, never to enable anything — and, equally, never to
*disable* what has been declared and demonstrated. The standing rule from
MULTI-MODEL-SEATS.md — "`models` is a declaration, not a probe; doctor checks reachability, it
never expands the list" — survives intact. Eligibility for a configurable backend is exactly
two gates, both operator-and-probe-owned:

```
eligible(seat) = declared(models[]) ∩ qualified(demonstrated capabilities for the seat)
```

**Discovery is a separate, recorded status — never a gate.** Endpoint listings are too flaky to
gate on: LM Studio's JIT mode lists *downloaded* rather than loaded models, Ollama lists pulled
rather than resident ones, endpoints may disable listing entirely, and a transient discovery
failure must not strand a qualified seat. Each declared model therefore carries a
`discoveryStatus ∈ { listed | unlisted | discovery_unavailable }`, refreshed at qualification
time and by doctor, surfaced as a chip and a doctor note ("declared but not listed by the
endpoint — the endpoint may hide loadable models, or the declaration may be stale"). If the
model is genuinely gone, the run fails at request time inside the existing fail-closed adapter
paths with the provider's own error — which is the honest failure, attributed to the endpoint,
rather than a Camus-invented preflight refusal built on a listing that proves little either
way.

- **Discovered** (informational): what the endpoint reports (`GET /v1/models`; Ollama's native
  `/api/tags` and `/api/ps` where available; LM Studio's enhanced REST listing with load state;
  an executor's own `models` subcommand). Presented in the Studio picker as *available to
  declare*, visibly separated from *declared*. Continue's `AUTODETECT` and OpenHands'
  presence-only discovery are the counterexamples: both hand production roles to anything a
  list returns, and both products document the resulting failure mode (models that advertise
  tools and can't call them). Camus never auto-declares — a discovered model becomes declarable
  only through an explicit "declare this model" action that edits the operator file with a
  `why`.
- **Declared**: the operator allowlist `models[]`, authoritative exactly as today — a seat
  naming an undeclared model refuses at load.
- **Qualified**: probe results (§9.2), cached as receipts, required before a seat may *run*,
  not merely warn.

### 9.1 Lineage evidence tiers — derived mechanically, never granted

`lineage.source` is **computed at load by one pure function**, from three inputs it can check
itself: the connection's kind, the resolved endpoint identity, and the tracked registry.
Nothing else assigns it — not config (the field is rejected if present in a config file), not
a UI template, not an operator's say-so about the *tier* (their say-so is the org/family
declaration the tier is computed *about*):

```
deriveLineageSource({ executorKind, transport, connectionKind, endpointHost,
                      modelId, declared, camusInjectedRedirect }) =
  // camusInjectedRedirect: Camus's own base-URL injection (routes the seat to
  // the endpoint branch below); redirectIsolationProven(executorKind) is the
  // static per-executor constant defined under the vendor-managed branch.
  registry           when connectionKind is direct_https
                      AND the tracked registry maps endpointHost → (org, family)
                      AND that mapping covers modelId's pattern
                      AND it agrees with `declared` (a declaration contradicting
                          the registry REFUSES at load — neither wins silently)

  registry           when transport is vendor_managed                    // built-in path
                      AND the registry's executor table maps executorKind
                          → (org, family)   (claude_cli → anthropic/claude,
                                             codex_cli → openai/gpt)
                      AND redirectIsolationProven(executorKind) — every
                          redirect surface that could re-point the child is
                          mechanically closed by the spawn itself, and the
                          closure is pinned by an acceptance test (below)

  operator_declared  when `declared` names org+family and no registry row applies
                      (all loopback / ssh_tunnel / legacy_http / gateway cases,
                       AND any built-in whose redirect isolation is not yet proven)
  unknown            when nothing is declared (legacy unconfirmed entries, §6.5)
```

The vendor-managed branch is the mechanical path for the built-in Claude/Codex identities —
the same function, an executor-keyed registry table instead of an endpoint-keyed one. The v4
draft gated it on "the spawner injected no base URL", and that gate was too weak: **not
injecting a redirect is not the same as no redirect reaching the child.** The shipped claude
adapter spawns with no `env` option at all
(`apps/loop-studio/lib/adapters/claude.mjs:104`), so the child inherits the server's entire
environment — an `ANTHROPIC_BASE_URL` sitting in the operator's shell silently re-points
every "vendor-managed" claude call, and a falsely sealed `registry` origin cannot be repaired
by a session-line caveat. So the gate is now **proof of isolation, per executor**:

- `redirectIsolationProven('codex_cli')` — **true today**: the hardened profile spawns with
  the scrubbed allowlist environment (redirect-capable variables are simply not on the
  allowlist) and `--ignore-user-config` removes the config-file redirect surface
  (`model_providers`, `openai_base_url`). Both facts are the spawn's own construction, and
  both are already pinned by the hardened-seat tests.
- `redirectIsolationProven('claude_cli')` — **false today**, and the derivation therefore
  yields **`unknown`** for the unisolated claude built-in. Not `operator_declared`: that tier
  is *defined* as the human operator's declaration (§9.1 table), and no human declared
  anything here — Camus shipped the registry row, and an unisolated route could be serving
  anything, so borrowing the operator's tier would be a lie of attribution on top of an
  unverified channel. Two honest upgrades exist, each mechanical:
  - **operator confirmation** — an explicit doctor/settings action ("confirm claude's active
    route: direct Anthropic, no base-URL override in this environment", requiring a `why`,
    recorded like every §6.5 confirmation) makes it genuinely `operator_declared`: a human
    checked their own environment and said so, which is exactly what the tier means;
  - **isolation** — the spawn-isolation work flips the constant to true and the branch
    derives `registry`. The work: an auth-aware explicit environment allowlist that
    **preserves direct-authentication material and strips routing material by documented
    role** — `ANTHROPIC_API_KEY` and OAuth credentials pass (direct Anthropic
    authentication), `ANTHROPIC_AUTH_TOKEN` is stripped (documented as proxy/gateway
    authentication) along with `ANTHROPIC_BASE_URL` and every other redirect/override
    variable (per Claude Code's authentication-precedence documentation,
    https://code.claude.com/docs/en/iam#authentication-precedence) — plus settings-source
    pinning for the CLI's own redirect-capable configuration surfaces, and the
    **inherited-`ANTHROPIC_BASE_URL` acceptance test**: plant the variable in the parent
    environment, spawn through the real adapter against a fake `claude` binary that dumps
    its environment, and assert the child never sees it. The test is the flip switch — the
    derivation reads a constant that only the green test justifies changing, so "proven" is
    a tested property, never an adjective.

A Camus-configured redirection (Kimi-via-claude_cli) remains Camus's own injection and routes
derivation through the endpoint branch — the Moonshot row of §6.3 — regardless of the
isolation flag. Consequence stated plainly: until isolation lands or the operator confirms,
the claude side is `unknown`, and §10 rule 2 seals every pairing that includes it at
**advisory** standing — not `cross_vendor`, not even `cross_vendor_declared`. That is a
sharper downgrade of the flagship pairing than v5 admitted, which is exactly why the
isolation work is scheduled *inside slice A* (§19.1) and why the confirmation action ships
beside it as the interim path — but the ordering is fail-closed: the honest downgrade ships
with the derivation, and each upgrade ships with its own proof or its own recorded human
decision, never the other way around.

| tier | meaning | example |
| --- | --- | --- |
| `registry` | the tracked registry states the operator↔org/family mapping for this endpoint and model pattern; the operator is commercially accountable for serving what it says | Anthropic API, OpenAI API, xAI API, Moonshot API serving Kimi |
| `operator_declared` | the human configuring Camus declared org/family; no registry row covers the endpoint | "this vLLM serves the Qwen3-Coder checkpoint I downloaded" |
| `unknown` | nobody declared — legacy configurable entries before confirmation (§6.5); seatable, but every pairing involving it seals advisory | a pre-revision `openai_compat` entry whose free-text `provider` was never confirmed |

(`endpoint_reported` is deliberately **not** a lineage tier: an endpoint's self-reported model
name is evidence about *configuration* and lives in the `reported` rung of the identity ladder
(§6.2). Letting it feed lineage would be inferring origin from a model string — banned in
§6.4.)

The `registry` tier is itself a *declaration Camus ships* (a small tracked registry of
endpoint-host → org/family rows with model-id patterns: `api.x.ai` → xai/grok, the DashScope
hosts → alibaba/qwen for `qwen*` ids, `api.moonshot.ai` → moonshot/kimi, plus the family table
that pins `gpt` and `gpt_oss` to `trainingOrg: openai`), reviewed like any other tracked
default. It is not cryptographic either — it is "the counterparty is commercially accountable
for the claim", which is the honest ceiling for hosted APIs.

One hosted-provider hazard discovered in research belongs here: **xAI auto-redirects retired
model slugs to different models and bills at the replacement's rates** (documented for the
May 15, 2026 retirement: `grok-code-fast-1` silently serves `grok-build-0.1`). A pinned slug that
stops erroring and starts answering as a different model is exactly what §6.2's substitution
rule exists for, and the handling is **fail-closed, not decorative**: the adapter records the
response `model` field as `reported`, and a non-null `reported` outside the seat's
expected-reported set kills the call as an infra refusal before any draft or verdict is
consumed — the run does not proceed on a model nobody decided on, and doctor's deep probe
surfaces the same mismatch before a run ever starts. The reconciliation is a config edit
(declare the new id, or pin elsewhere), never an absorbed observation. This applies to every
hosted provider, not just xAI; xAI merely documents the behavior.

### 9.2 Capability probes (demonstrated, never self-declared)

The research on Continue is the cautionary tale written out in full: capability there is a
hand-maintained regex table over model *names*, its docs contradict themselves on whether
operator config can override it, and its known-issues pages admit models that advertise tools
and fail them. OpenHands is honest that local-model tool reliability "varies widely" and then
runs headless in always-approve anyway. Camus's answer is the same one it gave for auth probes
and gate receipts: **capability is a probe result with a stored receipt, or it is `unprobed`.**

Probes, per backend × model, run by doctor `--deep`, the connect flow, and on demand:

- `structured_output` — the reviewer-shaped probe: a fixed miniature review prompt with the real
  normalized-review JSON schema; the response must parse and normalize through the *actual*
  `normalizeReview` path (not a toy schema — the point is the production parser). Pass →
  `demonstrated`; malformed → `failed` with the raw sample kept locally for diagnosis.
- `tool_calling` — only where a seat contract needs it (future maker executors; words seats are
  toolless by design). The probe requires a *correct* call: right function name, schema-valid
  arguments, sane handling of the tool result turn. A model that emits prose-wrapped
  pseudo-calls fails. There is no silent downgrade to prompt-emulated tools — that swap
  (Continue's "system message tools") changes the reliability class of the channel and may only
  ever be an explicit, receipt-named operator choice, and no current seat offers it.
- `context_window` — the operator states a window or the endpoint reports one (`source`
  recorded); a probe near the words-lane prompt envelope must round-trip. Ollama's silent-
  truncation default (a small `num_ctx` regardless of model capability) is the driving case:
  OpenHands' docs put the agent floor at ~22k tokens because below that "not even the system
  prompt will fit". Camus measures instead of documenting: reviewer prompts carry a known size
  distribution, and a window below the lane's envelope fails the probe with the exact server
  fix named (`OLLAMA_CONTEXT_LENGTH`, `--max-model-len`, LM Studio context slider).
- `streaming` — SSE deltas arrive and terminate correctly (`[DONE]` / usage chunk tolerance,
  exactly the tolerances `streamChatCompletion` already implements).

Probe results are cached as small receipts under `~/.camus/studio/capabilities/`. **A receipt
binds to a versioned, complete fingerprint, not a lookup key.** The fingerprint format is
`qual1:` followed by a sha-256 over the canonical serialization of exactly these components,
in this order, with every component also stored raw beside the hash (the `fp1:` discipline
from `codex_review.sh`, applied to qualification):

1. fingerprint format version (`qual1`);
2. probe-suite version (which probes ran, with which pass criteria);
3. **seat type** the receipt qualifies — `words_reviewer | words_maker | gate_reviewer |
   agent_maker` — a receipt earned for one seat type never satisfies another (§9.4's
   requirements differ per seat);
4. backend name and kind;
5. connection identity: kind, plus — loopback: `host:port`; direct_https: the full base URL;
   ssh_tunnel: `alias + remoteAddress:remotePort + basePath` (never the ephemeral local
   port); legacy_http: the grandfathered URL;
6. protocol;
7. requested model id;
8. auth mode: the env-var *name* for `env`, the literal `none` otherwise (never a value);
9. every server-reported identity anchor available for the server class, absent anchors
   recorded as `absent`, never skipped: Ollama `/api/show` digest + quantization +
   `llama.context_length`; llama.cpp `/props` `model_path` + `n_ctx`; LM Studio
   `quantization` + `arch` + `max_context_length` (+ `loaded_context_length` when loaded);
   vLLM served-model metadata; hosted providers' reported build/version where offered;
10. the **normalizer version** (a `normalizeReview`/`adapter.py` contract change invalidates
    structured-output receipts — the probe's meaning is "survives the production parser", so
    a parser change re-opens the question);
11. the prompt-envelope version for the seat type (behind the context probe);
12. the decoding knobs the probes requested (temperature and friends, or `not_honored`);
13. the mediating executor's version when a CLI executor runs the probe (`qwen --version`
    etc.; `none` for `http_client`);
14. **Camus's own adapter/runtime contract version** — the version stamp of the adapter code
    that ran the probe (the openai-compat adapter revision for `http_client` seats, the gate
    wrapper revision for `gate_reviewer` seats). A probe proves the model works *through this
    adapter*; an adapter change re-opens the question exactly as a normalizer change does;
15. an **opaque credential/account revision** — a receipt earned under one account need not
    hold under another (tier, entitlements, model access all ride the account). For
    `auth.kind: env`: `HMAC-SHA256(machineSalt, envVarName ‖ value)` truncated to 16 hex
    chars, with `machineSalt` random per machine, stored 0600 under `~/.camus/studio/` —
    the HMAC means the stored token is not an offline-guessable digest of a possibly
    low-entropy key, and rotation of either the key or the var name voids the receipt while
    the value itself never appears anywhere. For `auth.kind: none`: the literal `none`. For
    CLI executors on vendor accounts: the account/workspace identifier the CLI's spend-free
    auth-status probe prints, where it prints one; else `unknown` — and `unknown` does not
    void (the TTL carries that load), it just means account rotation is invisible to this
    component;
16. for `gate_reviewer` receipts only: the **gate-review contract version and scope** — the
    versioned contract (a `REVIEW-CONTRACT.md` stamping the ensemble of `review-prompt.md`,
    `sev.schema.json`, and the light-scope addendum, §19.2) plus which scope was qualified
    (`full` or `light`) and that scope's tool-requirement set. Full and light are different
    questions (§9.4): a light qualification never satisfies a full-scope seat.

The receipt payload also records each probe's *result*, not just pass/fail: the context
probe's `demonstratedAt` size and three-state `status` (§6.1), the structured-output sample's
normalizer verdict, and the tool-call transcript digest for tool probes — so a later reader
can see what was demonstrated, not only that something was.

The receipt additionally stores the probe date and the TTL horizon (default 30 days,
`STUDIO_CAPABILITY_TTL_DAYS`) — the two time fields ride *outside* the hash so that expiry is
a comparison, not a hash break. Validity at read time is mechanical and complete: recompute
the fingerprint from live values; any component mismatch voids the receipt and the refusal
names *which* component changed ("model digest changed on gpu_lab: re-qualify"); expiry voids
it by date. A seat whose probe receipt is missing, expired, or voided runs the probe at
launch preflight or refuses with the fix named. Capability entries are three-state on
purpose — `demonstrated`, `failed`, `unprobed` — and only `demonstrated` seats a model,
because "failed" and "nobody checked" must never be distinguishable *upward* into
eligibility.

### 9.3 Loaded-versus-resident state (informational)

Where a server distinguishes pulled from loaded (Ollama `/api/ps`; LM Studio's REST reports
loaded state and quantization), Studio shows it as a status chip ("resident / will cold-load"),
and the benchmark (§16) measures cold-load cost. It never gates: residency is a latency fact,
not a capability fact.

### 9.4 Per-seat capability requirements (the exact matrix)

What "qualified for the seat" means, seat type by seat type. `required` = must be
`demonstrated` by a valid receipt; `n/a` = the seat's contract does not exercise the
capability (recorded as `not_applicable`, not probed); a context requirement names which
prompt envelope the window probe must clear.

| capability | `words_reviewer` (openai_compat/http) | `words_maker` (openai_compat/http) | `gate_reviewer` (CLI gate backend, §12) | `agent_maker` (agent executor, §13) |
| --- | --- | --- | --- | --- |
| structuredOutput | **required** — the reviewer-schema probe through the production `normalizeReview` | n/a — the deliverable is markdown, judged by the reviewer seat | **required** — `sev.schema.json`-shaped verdict through `adapter.py` (or the backend's `from-<backend>`) | **required** — the structured final receipt (`IMPL_SCHEMA`-shaped) |
| toolCalling | n/a — toolless by design (MULTI-MODEL-SEATS.md) | n/a — toolless by design; grounded managed-connector runs still require the claude backend (existing rule, unchanged) | **scope-dependent (see note)**: `light` = n/a — the wrapper feeds the diff, the backend judges text; `full` = required — repository exploration runs through the backend's own tool surface | **required** — correct calls, schema-valid arguments, sane result handling; no prompt-emulated fallback |
| streaming / liveness | **required** — SSE deltas feed the idle watchdog | **required** — same | **required as a liveness channel** — an event stream (`--json`-style) or HTTP streaming; a backend with neither cannot ride the watchdog and does not qualify | **required** — event stream sufficient for idle watchdog, session lines, usage observation, and unexpected-tool refusal |
| contextWindow | **required** ≥ words-reviewer envelope (prompt + draft + grounding + ledgers) | **required** ≥ words-maker envelope (prompt + grounding + prior draft on fix) | **required** ≥ gate-review envelope (prompt + diff at the corpus's p95 diff size) | **required** ≥ agent-maker envelope (task + plan + working set) |

**Gate-review scope note.** The gate's review contract exists in two versioned variants —
`full` (the canonical repository-context review, the default posture) and `light`
(diff-primary, the oneshot posture's scope) — and they are *different qualification
questions*: full-scope review requires the backend runtime to explore the repository through
its own tools (`codex exec` reading files; a future `qwen_code`/`grok_cli` doing the same),
so its qualification includes the tool-calling row; light-scope review judges the
diff-plus-prompt the wrapper assembles, so a toolless HTTP backend can qualify for it and
only it. A receipt names the contract version and scope it qualified (§9.2 component 16); a
light receipt never seats a full-scope round, and the contract version bumping (prompt or
schema change) voids exactly the gate-reviewer receipts. The built-in codex gate reviewer is
not exempt from any of this: its admission evidence is the versioned `builtin1:` contract
constant (§10.8.1) covering the same contract version and scope, so "proven built-in" is a
fingerprintable claim that bumps and voids like a probe receipt, not a hole in the matrix.

Rules riding the matrix: a receipt qualifies exactly one `(seat type, backend, model,
connection[, gate scope])` tuple (§9.2 components 3 and 16); `unprobed` on any *required* row
makes the seat ineligible and the picker says which probe is missing; `n/a` rows are never
probed and never block; envelope sizes are versioned constants per lane (§9.2 component 11),
so an envelope change re-opens exactly the context question and nothing else.

## 10. Independence semantics

The product thesis — two differently-trained models are less likely to be wrong the same way —
is computed from **training organization and model family**, and only from them. The rules,
extending the existing `same_vendor`-fails-closed logic in `engine.mjs` and the seal-time
guard in `evidence-pack.mjs`:

1. **Same organization ⇒ advisory, never independent. Same family too.** A Qwen maker reviewed
   by a Qwen reviewer is `same_vendor` even when one runs on DashScope and the other on a lab
   box — different operators do not make differently-trained models. And the organization axis
   dominates the family axis: **a GPT/Codex maker with a gpt-oss reviewer shares
   `trainingOrg: openai` and is advisory**, whatever the family split says — this is the exact
   forgery the old single origin field permitted and the split exists to close. A declared
   derivation (`lineage.derivedFrom` naming another family, e.g. an open distillation) likewise
   collapses the pair to advisory against that base family. Unknown family relationships do
   not upgrade anything.
2. **Unknown ⇒ no cross-vendor claim.** `trainingOrg: unknown`, `modelFamily: unknown`, or
   `lineage.source: unknown` on either seat fails the pair closed to advisory standing,
   exactly as an unknown provider already does. Unknown never grades up — which also means a
   legacy unconfirmed entry (§6.5) is advisory by construction until its operator confirms.
3. **Different organizations through one gateway ⇒ independent training, shared serving —
   disclosed.** A GPT maker and a Qwen reviewer both reached through the same `gateway:<name>`
   operator keep their org-axis standing, and the receipt additionally records
   `shared_gateway: <name>`: one party observed both sides of the conversation, which is a
   privacy and single-point-of-trust fact the reader deserves even though it does not change
   training independence.
4. **Operator-declared open weights get an honest intermediate standing.** Per-seat
   `origin_confidence` derives from `lineage.source`: `registry → verified_operator`,
   `operator_declared → operator_declared`, `unknown → unknown`. A
   cross-organization pairing where the weaker side is `operator_declared` seals independence
   as **`cross_vendor_declared`** — "cross-vendor as configured: origin declared by the
   operator, not attested". Stronger than advisory, weaker than the hosted cross-vendor case,
   and the vocabulary exists precisely so neither gets borrowed. This standing is **sealed
   first-class** — schema, validators, headline, and canonical projection are specified in
   §10.8; the former open questions U1/U2 are resolved there.
5. **Self-hosted identity is not attested by `/models`.** Restating §5.5's finding as law: every
   surveyed server lets the operator alias the served name; digests (`/api/show`), model paths
   (`/props`), and load state are better evidence but still server-reported. No transport —
   SSH included — upgrades evidence tier. Receipts must never contain the word "verified" about
   self-hosted weights.
6. **Executor overlap is disclosed, not conflated.** Kimi-via-claude_cli reviewing a
   claude-maker run is cross-organization (`moonshot` vs `anthropic`) but shares a runtime
   vendor's harness and prompt scaffolding. The pairing records `executor` per seat (already
   partially present as `backend`), and a shared executor across seats adds a session-line
   disclosure. It does not downgrade the audit dimension — training independence is what the
   dimension measures — but the receipt says it, because a reader auditing prompt-injection or
   harness-bias hypotheses needs it.
7. **The seal-time guard grows the new axes.** Today the pack refuses `cross_vendor` when
   recorded actual providers match or are unknown. Under pairing v2 it additionally refuses:
   `cross_vendor` when the seats share a `trainingOrg` or a family lineage, or when either
   seat's `origin_confidence` is not `verified_operator`; `cross_vendor_declared` when the
   organizations are equal, either is unknown, or *neither* side is merely declared (a fully
   registry-backed pair must claim `cross_vendor`, not hide behind the weaker word); and any
   independence value whose recorded `shared_gateway`/operator facts contradict it. The guard
   stays where it is — at seal time, deriving from recorded facts, throwing rather than
   adjusting.

Round-level recording in `engine.mjs` follows: `reviewPairingFacts` computes
`independence ∈ {cross_vendor, cross_vendor_declared, same_vendor}` from per-seat
`(trainingOrg, modelFamily, lineage)` instead of the provider prefix alone, with the same
fail-toward-lower rule on any missing input — and each recorded round carries the
**qualification reference** its seat ran under (the accepted `qual1:` or `builtin1:`
fingerprint, plus scope and contract version for gate rounds), which is what the sealed seat
identity's `qualification` field (§10.8.1) consumes. The round *also* carries the scope it
actually ran at, arriving through the binding channel (`meta.json` → emitted binding → round
event) — that is the independent source `pairing.review_scope` seals, so the §10.8.4
cross-check compares two channels no single writer controls. Qualification travels from
admission to receipt through mechanical channels only: the run snapshot at creation, the
round event at review time, the pairing at seal time.

### 10.8 The published schemas: pairing v2 and status v2 (U1/U2 resolved)

**U1 is resolved: the versioned sealed-schema change ships with slice A**, not after a soak.
The reasoning: `cross_vendor_declared` is worthless as session-line decoration — a standing
that exists to be *cited* must be covered by `receipt_id` and refused by validators when
contradicted, and deferring the bump would ship a release whose central new claim was
un-sealed. **U2 is resolved: first-class raw dimension values, not qualifiers.**

**Immutability rule, stated once for both schemas:** a published schema version is a frozen
contract. Its field set, enums, and canonical serialization never change after it ships; any
change — however additive it feels — is a new version number. Validators accept every
published version forever; producers emit only the newest, with exactly **one sanctioned
exception**: audit-only replay seals its replay pack in its *source's* envelope version
(§10.8.1) — a replay is a re-audit of a sealed artifact, and sealing it in the source's shape
keeps the pair comparable and never back-fills fields the source run never recorded. There is
no other dual-production mode: new runs seal the newest versions, old receipts stay what they
are, readers handle all published versions.

#### 10.8.1 Pairing v2 (published schema) — and the envelope decision

**The evidence-pack envelope bumps to `schemaVersion: 3`, and the envelope version determines
the interior block versions exactly** — while **every published envelope stays readable
forever**. The shipped validator accepts packs 1 *and* 2 today
(`packages/trust/lib/validate.mjs:80`, `[1, 2].includes(p.schemaVersion)`); hash stability
was never the whole story, and v4's matrix wrongly dropped envelope 1 as a reader. Corrected:
envelopes 1 and 2 are the published legacy shapes, frozen exactly as the shipped v1/v2 rules
define them (canonically `1/1/1` and `2/1/1` in the §10.8.4 matrix); envelope 3 ⇒ pairing 2 +
statuses 2. The alternative — holding the envelope at 2 while interior blocks version
independently — was rejected because it makes "a v2 pack" ambiguous about its own contents;
with the envelope as the single key, a pack's one version number says everything about its
shape, and the interior versions become consistency assertions rather than degrees of
freedom.

The published schemas land as **concrete JSON Schema files**, tracked and test-pinned:
`packages/trust/schemas/evidence-pack.v3.schema.json` (the envelope),
`packages/trust/schemas/pairing-manifest.v2.schema.json`, and
`packages/trust/schemas/status.v2.schema.json` — the prose in this section and `SCHEMAS.md`
point at them; the validator tests assert `validate.mjs` and the schema files agree, so
neither can drift alone. (The v1/v2 shapes stay defined by the shipped validator code they
have always lived in; freezing them as retroactive schema files is optional documentation,
not a compatibility requirement.)

**Projection behavior under envelope 3 — the 2→3 `artifact_id` change is accepted, not
papered over.** v5 claimed `artifact_id` stability across envelopes because the artifact
sub-block is unchanged; that claim was wrong as stated: the shipped artifact projection
hashes the envelope `schemaVersion` itself
(`packages/trust/lib/canonical.mjs:90` — `take: ['schemaVersion', 'goal',
'acceptance_contract', 'artifact']`), so an identical deliverable seals different
`artifact_id`s under envelopes 2 and 3. Rather than invent a cross-version normalization
(e.g. a v3 projection that deliberately re-projects the semantic artifact as v2), the
divergence is **accepted**, because no consumer compares artifact identity across envelope
versions: every place artifact_id is load-bearing stays within one version by construction —
audit-replay seals in its *source's* envelope (the §10.8-intro exception exists precisely so
lineage comparisons are intra-version), and comparison arms share their experiment's
envelope. Two tests pin the decision: the golden suites re-derive envelope-1/2 fixtures'
`artifact_id`s unchanged, and a deliberate cross-version case documents that the same
artifact content under envelopes 2 and 3 yields *different* ids — inequality asserted, so
the divergence is a recorded contract, not a surprise. `receipt_id` covers the whole
canonical pack including the new pairing/status fields, so it too diverges from what an
envelope-2 seal would have produced; that is the point of sealing new facts.

Consumer changes riding this: audit-only replay's source-acceptance check
(`apps/loop-studio/server.mjs`, today `evidencePack.schemaVersion !== 2` → refuse) learns to
*read* envelope 3 in slice A, and its **old-source production exception** is explicit:
replaying an envelope-2 source seals an envelope-2 replay pack (the §10.8-intro exception),
replaying an envelope-3 source seals envelope 3; the frozen audit-replay experiment schemas
are untouched either way.

Inside an envelope-3 pack, the pairing block:

```
pairing = {
  schemaVersion: 2,
  executor: <seatIdentitySealed>,     // the maker seat
  auditor:  <seatIdentitySealed>,     // the reviewer seat
  independence: 'cross_vendor' | 'cross_vendor_declared' | 'same_vendor_advisory' | 'none',
  shared_gateway: '<gateway name>' | null,

  // the scope the governing review round ACTUALLY ran at, sourced independently
  // of the qualification block: it arrives through the round's mechanical
  // channel (the emitted binding, which codex_review.sh reconstructs from its
  // own meta.json) and never through the qualification record — two channels,
  // compared at validation. null exactly when no gate-scoped review governs
  // (words-lane audits).
  review_scope: 'full' | 'light' | null,
}

seatIdentitySealed = {
  requested: '<provider:model>',      // string forms unchanged from v1
  resolved:  '<provider:model>',
  actual:    '<provider:model>' | 'unknown:not-recorded' | 'none:no-model-run',
  reported:  '<model id>' | null,
  actual_evidence: 'observed_api_response' | 'observed_cli_event'
                 | 'asserted_pin' | 'mapped_by_operator_docs' | 'none',
  executor_kind: 'claude_cli' | 'codex_cli' | 'http_client' | '<registered executor>',
  training_org: '<registry org>' | 'unknown',
  model_family: '<registry family>' | 'unknown',
  lineage: { source: 'registry' | 'operator_declared' | 'unknown',
             derived_from: '<family>' | null },
  inference_operator: '<operator>' | 'self_hosted' | 'gateway:<name>' | 'unknown',
  transport: 'loopback' | 'direct_https' | 'ssh_tunnel' | 'vendor_managed' | 'legacy_http',
  connection: '<connection name>' | null,
  origin_confidence: 'verified_operator' | 'operator_declared' | 'unknown',

  // the qualification this seat ran under (§9.2/§9.4) — ALWAYS non-null, so a
  // receipt names WHICH admission evidence stood behind the seat, and a
  // light-scope qualification can never silently stand behind a full review.
  // Two fingerprint namespaces, one shape:
  //   qual1:<hex64>    — a probe-earned §9.2 receipt (configurable backends)
  //   builtin1:<hex64> — the versioned built-in contract constant: a hash over
  //                      (built-in backend name, adapter contract version, and —
  //                      for gate seats — review-contract version + scope).
  //                      Eligibility is selected by the EXACT BUILT-IN BACKEND
  //                      plus transport: vendor_managed — never by executor
  //                      kind, because a Codex custom-provider seat is also
  //                      codex_cli and must seal qual1:. The codex gate reviewer
  //                      is admitted by its proven built-in contract, now a
  //                      fingerprintable, version-bumpable value, not an
  //                      exemption.
  qualification: { fingerprint: 'qual1:<hex64>' | 'builtin1:<hex64>',
                   gate_scope: 'full' | 'light' | null,      // gate seats only
                   contract_version: '<version>' | null },    // gate seats only
}
```

All fields are required (nullability only where shown). Canonical projection
(`packages/trust/lib/canonical.mjs`): v2 fields enter the canonical form — and therefore
`receipt_id` — if and only if `pairing.schemaVersion === 2`, in the exact field order printed
above; the v1 projection is byte-frozen, proven by the golden suite (§10.8.5).

#### 10.8.2 Status v2 (published schema)

The sealed dimensions object (produced by `deriveStatusDimensions`, whose
`STATUS_DIMS_VERSION` becomes 2):

```
statuses = {
  schemaVersion: 2,
  execution:    'pending' | 'running' | 'completed' | 'interrupted' | 'failed',       // unchanged
  verification: 'not_run' | 'passed' | 'passed_with_caveats' | 'failed' | 'infra_failed',  // unchanged
  audit:        'not_run' | 'independent_clean' | 'independent_findings'
              | 'advisory_clean' | 'advisory_findings'
              | 'declared_clean' | 'declared_findings'                                 // NEW pair
              | 'infra_failed',
  publication:  'not_published' | 'published',                                          // unchanged
}
```

`declared_clean`/`declared_findings` seal when the governing audit round was
cross-organization with `origin_confidence` capping at `operator_declared` (§10 rule 4);
`auditFromReviews` derives them from the round's recorded independence fact exactly as it
derives `advisory_*` from `same_vendor` today. The existing rehearsal rule is unchanged and
applies: a simulated run's audit seals `not_run`, so `declared_*` can never arise from a mock.

#### 10.8.3 Headline truth table

`HEADLINES` gains one token: `declared_cross_vendor_reviewed`, displayed as **"cross-vendor as
configured — origin declared, not attested"** (both strings locked by test; the token never
renders the bare words "independent" or "verified"). The derivation rules extend the shipped
P/1–7 sequence in `deriveHeadline` with `declared_clean` joining rule 2's clean-review set and
a declared twin of rule 6; the complete resulting table, for `execution: completed` and
`publication: not_published` (legend: **U** unverified · **ND** needs_decision ·
**SVR** same_vendor_reviewed · **DCR** declared_cross_vendor_reviewed · **V** verified ·
**VF** verified_with_findings):

| verification \ audit | not_run | independent_clean | independent_findings | advisory_clean | advisory_findings | declared_clean | declared_findings | infra_failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| not_run | U | U | U | U | U | U | U | U |
| passed | U | **V** | VF | SVR | SVR | **DCR** | **DCR** | U |
| passed_with_caveats | U | VF | VF | SVR | SVR | DCR | DCR | U |
| failed | U | **ND** | U | **ND** | U | **ND** | U | U |
| infra_failed | U | U | U | U | U | U | U | U |

Rows and columns outside this table: any `execution ≠ completed` → `unverified` for every
cell; `publication: published` applies rule P unchanged — the inner headline must be
`verified` or `verified_with_findings` to read `published`, so a published SVR **or DCR**
artifact reads `needs_decision` (configured standing does not meet the publication bar, same
as advisory); the serve-time rehearsal overlay (`headlineOf`'s `simulated` flag) outranks the
table exactly as today. This table is exhaustive over the v2 enums and is pinned by an
`allCombinations()`-driven test.

#### 10.8.4 Cross-version validator matrix

`validate.mjs` accepts exactly three version tuples — **every published envelope stays
readable, including v1, which the shipped validator accepts today and which v4 of this table
wrongly refused** — and everything else refuses, including versions from the future (fail
closed, never fail forward):

| pack.schemaVersion | pairing.schemaVersion | statuses.schemaVersion | verdict |
| --- | --- | --- | --- |
| 1 | 1 | 1 | **accept** — the shipped v1 acceptance rules, unchanged and frozen; no v2-only field, no `declared_*` value |
| 2 | 1 | 1 | **accept** (legacy), iff pairing carries no v2-only field and audit carries no `declared_*` value |
| 3 | 2 | 2 | **accept**, iff every v2 field present with enum membership, and every §10 rule-7 consistency check passes |
| any other tuple | | | refuse — an envelope admits exactly its published interior; mixed, missing, and future versions all fail closed |

Within the accepted rows, the interior shape checks: an envelope-1/2 pack carrying any
v2-only pairing field refuses (half-upgraded); an envelope-3 pack missing any v2 field
refuses. The §10 rule-7 refusals are validator-enforced, not just thrown by the builder — a
hand-assembled pack that contradicts itself refuses at validation exactly like a built one.
Within an accepted envelope-3 pack, the audit↔pairing cross-checks: `declared_*` requires
`independence: cross_vendor_declared`; `independent_*` requires `independence: cross_vendor`
with both seats `verified_operator`; `advisory_*` requires `same_vendor_advisory` or an
unknown-lineage seat; **`qualification` is required non-null on every seat** — and the
`builtin1:` namespace is legal exactly when the seat is one of the built-in backends
(`claude`, `codex`) **and** `transport: vendor_managed`: selection is by backend plus
transport, never by executor kind, because a Codex custom-provider seat is also `codex_cli`
and must seal `qual1:`. A `builtin1:` on any other transport refuses; a `qual1:` on a
vendor_managed built-in refuses;
**when `pairing.review_scope` is non-null, the auditor's `qualification.gate_scope` must
equal it** — the two arrive through different channels (§10.8.1: `review_scope` from the
round's binding, `gate_scope` from the admission record), so a light qualification sealed
behind a full-scope round refuses on a comparison neither channel can forge alone; a
words-lane pack (`review_scope: null`) requires `gate_scope: null`; mismatches refuse.

#### 10.8.5 Tests

The golden v1 `receipt_id` stability suite (existing sealed fixtures re-derive identical
ids); a v2 canonical-ordering test (field order pinned so re-serialization cannot shift the
hash); the full §10.8.4 matrix as an acceptance/refusal table test; the §10.8.3 truth table
driven exhaustively through `allCombinations()` for both status versions; headline wording
locks for `declared_cross_vendor_reviewed` in both renderers (server-derived headline and
Studio display); and a dual-read test proving `status.mjs` derives identical standings for a
v1 pack before and after the change.

## 11. Studio design

Everything here is presentation and validation over the machinery above; no new trust decisions
live in the browser. The server-side rule stays: the picker and the engine read the same
catalog (`seatCatalog()`), and every write path re-validates (`seatOffered`), so the UI cannot
express a state the engine refuses.

### 11.1 Provider and connection templates

"Add backend" grows a template gallery, each template being *pre-filled config, never
pre-granted trust*: xAI (api.x.ai, `XAI_API_KEY`, protocol chat_completions, lineage from the
registry: xai/grok), Moonshot intl/CN, DashScope (workspace-scoped URL with
a fill-in field — the endpoint moved once already, §5.3, so the template shows the doc link
rather than hardcoding regional certainty), local Ollama (loopback:11434), LM Studio
(loopback:1234), llama.cpp (loopback:8080), vLLM (port + optional key), and "Private server
over SSH" (the §8.5 connect flow). Every template lands in the same editor showing the exact
JSON that will be written to local operator state, with `why` required — templates accelerate
typing, not deciding.

### 11.2 Explicit endpoint, transport, and auth

The backend editor separates the §6 axes visibly: protocol picker (chat_completions today;
responses greyed with "planned" until slice C ships it — never offered before implemented),
transport shown as a derived fact of the chosen connection, training org + model family as
explicit operator inputs, and the **lineage tier as a read-only derived chip** (§9.1 — the UI
can never grant `registry`; it shows what the derivation computed and why), with inline copy
explaining the honesty consequences ("declared origin seals as cross-vendor-as-configured,
not verified"; "gpt-oss shares OpenAI's training organization — pairing it against GPT is
advisory"). Credential fields accept an env-var *name*
only; the UI never renders values, and `/api/config` continues to never return them.
Loopback/SSH endpoints get optional bearer auth (some local servers require keys); the SSH
connection editor accepts exactly the four §7 fields plus alias.

### 11.3 Qualification UX

Per backend, a "Qualify" action runs the §8.5/§9.2 ladder and renders the checklist live
(SSE, same pattern as run events). Each capability chip shows
demonstrated/failed/unprobed + probe date; "re-qualify" invalidates and reruns. A seat picker
entry whose backend/model lacks `demonstrated` for the seat's required capabilities renders
disabled with the reason, mirroring the existing current-but-unavailable handling for codex
cache misses in `modelCatalog()`.

### 11.4 Badges

Seat rows and run headers carry three compact badges from the identity record: origin
(`qwen`), operator/route (`self-hosted` / `dashscope` / `xai` / `gateway:openrouter`),
transport (`local` / `https` / `ssh`). Same-origin pairings keep today's advisory warning;
`operator_declared` origins add "declared" to the origin badge. Where load state is known
(§9.3), a residency chip. The launch form's pairing note extends the existing
same-provider warning copy with the §10 vocabulary — the warning text comes from the server
so the wording matches what the receipt will actually seal.

### 11.5 Errors, diagnostics, side-effect discipline

All tunnel/backend errors surface through the §8.6 redaction layer. The connect flow's
diagnostics pane offers "open local diagnostics file" (a path the user opens themselves) rather
than streaming raw stderr to the page. Nothing in the connection/backend lanes publishes,
posts, or touches any external service beyond the declared inference endpoint itself;
`publish` remains the only externalizing flag in the product and stays words-lane-only and
explicit. Config writes keep the existing capability-token + origin + Host discipline; SSE
diagnostics streams carry the same authorization as run event streams.

### 11.6 What the browser never receives

Stated as an invariant because §8 depends on it: SSH aliases resolve server-side; argv
construction happens server-side from validated config only; the browser sends connection
*names*, receives step results and redacted messages. A page-supplied string can never reach
`spawn('ssh', …)` — the only page-writable SSH-adjacent value is `sshHostAlias` inside a config
save, which is charset-validated (§8.2) and used only after being read back from disk config,
through the same validation, on a later connect action.

## 12. CLI reviewer design (the gate's dispatcher)

Separate track from Studio's words seats, governed by `review.sh`'s standing law: **an unknown
backend fails closed, and a new backend joins only after the benchmark gate.** This section
specifies what a qualified backend must implement so that the day the benchmark admits one,
the contract is already written.

### 12.1 The dispatcher grows names, not behavior

`CAMUS_REVIEWER` gains candidate values (`codex` today; `qwen_code`, `grok_cli`,
`http_openai_compat` as benchmark candidates). Dispatch stays exact-match, exec-style, fail-
closed on anything unrecognized — including recognized-but-not-yet-benchmark-admitted names,
which refuse with the same `ran:false` citing the gate (a name existing in the docs must not
imply it is enabled). The cross-vendor invariant check moves from prose to mechanism: the
dispatcher refuses a backend whose declared origin equals the implementer's origin
(claude/anthropic today), using the same origin registry as §9.1, so "Claude never reviews
Claude-implemented camus code" survives multi-backend by construction.

### 12.2 What every backend must preserve (the codex_review.sh contract, itemized)

- **Async lifecycle**: start-detached returning fast with `{pending, handle}`, bounded `await`
  chunks re-attachable by handle, `abort` that kills the process group. The watchdog layout
  (`<wt>-r<round>.watch/` with `handle.json`, `meta.json`, `events.jsonl`, `last.txt`,
  `exit_code`) is the shared harness (`review_watch.py`), not codex-specific; a new backend
  reuses it and supplies only the argv to run.
- **Binding — now carrying the qualification, not just the identity.** The three-channel
  round/effort consistency check (request file, env, argv), nonce required for adoption, and
  input fingerprint (`fp1:` over HEAD+diff+prompt) gating replay and adoption all stay. The
  bound field set grows: the request file, `meta.json`, and the emitted `binding` block carry
  — beside `round`, `effort`, `model`, `backend`, `worktree`, `nonce` — the **review scope**,
  the **gate-review contract version**, and the **accepted `qual1:` or `builtin1:`
  fingerprint** the round runs under. `asGate()` compares all of them against workflow-computed expectations; today
  it compares neither scope nor contract (`packages/cli/workflows/camus-loop.workflow.js:435`
  checks round/effort/model/backend/worktree/nonce only, even though `codex_review.sh`
  already normalizes and records scope in `meta.json`), which means a light-scope review
  could today satisfy a full-scope expectation so long as the other six fields matched. After
  this change the mismatch is mechanical: the workflow computes the expected scope from its
  own posture (`full`, or `light` under oneshot), the expected contract version from the
  installed skill, and the expected fingerprint from the backend's admission record — a
  `qual1:` receipt for configurable backends, and for the built-in codex backend the
  **`builtin1:` contract constant** the workflow derives from the installed skill's contract
  version and the hardened profile (§10.8.1) — so the built-in rides the same comparison as
  every other backend rather than an exemption. **A light qualification is mechanically
  unable to certify a full review**, because the binding comparison and the §10.8.4
  seal-time cross-check (which reads `review_scope` from the round's own channel) refuse it
  independently. Backends do not reimplement any of this; it lives in the shared wrapper
  exactly where it lives now.
- **Normalization**: raw output funnels through `adapter.py`'s `normalize_codex` contract or a
  per-backend `from-<backend>` that emits the identical normalized gate JSON with the same
  infra-vs-findings guard. Malformed, empty, self-inconsistent ⇒ `ran:false`, never a verdict.
- **Identity**: `meta.json` persists the pinned reviewer model at start; awaits/resumes seal the
  recorded identity, never the current env; the new identity fields (origin, operator,
  transport, connection) ride `meta.json` and the emitted binding so the workflow's terminal
  `reviewerReceiptFields()` can carry them into camus-feat state and Studio receipts.
- **Timeouts and cancellation**: effort-sized chunk budgets, event-silence idle kill,
  `AWAIT_CAP` abort — all already backend-agnostic in the workflow.
- **Containment**: unchanged and non-negotiable — review runs against the worktree; the
  post-phase mechanical containment receipt and the verify oath are not review-backend
  concerns and must not become ones.

### 12.3 Backend candidates, with their researched constraints

- **`codex` + custom provider** (Codex CLI pointed at a local/remote server): now requires a
  **Responses-capable** endpoint — `wire_api = "chat"` is removed from Codex. Ollama
  (stateless `/v1/responses`, v0.13.3+), LM Studio, llama.cpp, and vLLM all qualify on paper;
  reliability of third-party Responses implementations under Codex's agentic loop is exactly
  what the benchmark measures. Provider injection must not touch the user's config.toml: a
  benchmark-admitted configuration would ride `-c model_providers.camus_local.*=…` overrides
  (or `--ignore-user-config` plus a Camus-owned profile) so the review lane's provider is
  Camus-pinned per invocation, honoring the existing isolation promises
  (`CAMUS_CODEX_*` levers). The injected `base_url` is a Camus connection's resolved runtime
  URL — loopback or a tunnel's `127.0.0.1:<port>` — so a CLI executor rides the same
  connection lifecycle, preflight, and provenance as an `http_client` seat (§6, §7).
- **`qwen_code`**: the strongest researched headless contract — `qwen -p` with
  `--json-schema` (schema-validated terminal payload; stdout is exactly the JSON or empty),
  distinct exit codes (53 turn-cap / 55 budget / 130 SIGINT), `plan` read-only approval mode,
  and `OPENAI_BASE_URL`-style pointing at any compatible endpoint including a §8 tunnel port.
  The adapter maps `--json-schema` output into `sev.schema.json`-shaped findings and treats
  exit 53/55 as infra.
- **`grok_cli`**: xAI's own review recipe (`grok -p … --sandbox read-only
  --output-format plain|json`) is a working shape, but three hardening items are mandatory
  before benchmark entry: sandbox is **off by default** (must be explicitly `read-only`);
  child-process network blocking is Linux-only (macOS review seats need the capability-removal
  posture, not sandbox trust — same philosophy as the hardened codex profile); and its
  zero-config ingestion of Claude Code skills/MCPs/CLAUDE.md is a prompt-surface Camus must
  disable or isolate for a bounded review (the `--ignore-user-config` analogue needs
  verification, §19.7).
- **`http_openai_compat`**: a direct HTTP reviewer (the Studio adapter's philosophy in shell
  form) for chat-completions or responses endpoints, including tunneled ones. No repo access
  at all — it reviews the diff+prompt the wrapper feeds it, which is the `light`-scope shape.
  Simplest to make deterministic; the benchmark decides whether diff-only review quality is
  acceptable at which effort tiers.

### 12.4 Transport provenance in gate receipts

`_review_audit.py`'s per-round audit record and the binding block gain
`connection`/`transport`/`operator`/`origin` fields sourced from the same mechanical channels
as model identity (request file + env, written by the workflow which is the only party that
knows the run's declared config). The workflow's `asGate` expectations extend accordingly.
Rule 8.4 applies to the CLI too: a review in flight when its tunnel dies is `ran:false` infra
with the tunnel cause named, retried under the existing infra-retry budget, never re-routed.

## 13. CLI maker design: the agent-executor contract

A maker in the Build lane is not a text generator; it is a process that *edits a repository
under custody rules*. The words lanes can seat a toolless HTTP backend as maker because their
artifact is text; the Build lane cannot. Stated as the rule this section exists to enforce:

> **A direct HTTP model endpoint is not a coding maker.** Tool execution is what makes a maker,
> and tool execution is exactly what the openai_compat backend deliberately does not have.

An **agent-executor** is a runtime a maker seat may bind to when (and only when) it satisfies
this contract — written against what `runClaude`/the gate already rely on:

1. **Tool execution with a boundable surface.** The executor runs read/edit/shell tools itself,
   and Camus can restrict that surface mechanically (claude `--tools`; codex `--disable`
   families; qwen-code approval modes; grok sandbox profiles + permission rules). A surface
   that cannot be restricted, or whose restriction cannot be verified from the event stream,
   disqualifies (the hardened-codex lesson: watch the stream, refuse unexpected tool events —
   flags are a promise, the event stream is the check).
2. **Repository/worktree custody.** The executor works only inside the worktree it is handed
   (cwd-pinned), and the gate's mechanical containment receipts remain the arbiter. Executors
   that helpfully walk to the repo root, read user-global config, or auto-ingest instruction
   files (Grok Build reads CLAUDE.md/skills/MCPs zero-config) must have those behaviors
   disabled or the executor is not seatable.
3. **Sandbox and approvals, stated honestly.** Whatever the executor's sandbox claims, the seat
   description records what is *enforced on this platform* (Grok's Linux-only child network
   blocking may not be described as a network boundary on macOS). Approval modes must have a
   non-interactive setting whose semantics are refuse-or-proceed, never prompt-and-hang.
4. **Session continuation.** Resume-by-id (`codex exec resume`, `qwen --resume`, grok `-r`) or
   an explicit statement of non-resumability, so the loop's recovery paths know whether an
   abandoned session is finishable or must be re-paid — the thread-resume machinery in
   `codex_review.sh` is the pattern.
5. **Timeout, cancellation, event streaming.** Kill paths per the seat contract; a structured
   event stream (`--json`/JSONL/ACP) sufficient for liveness (idle watchdog), session lines,
   usage observation, and unexpected-tool refusal. Plain-text-only executors disqualify.
6. **Structured final receipt.** A schema-constrained terminal output channel
   (codex `--output-schema`; qwen `--json-schema`; grok `--output-format json` pending
   verification of schema enforcement) so the implement/fix phases can return
   `IMPL_SCHEMA`-shaped results parsed by the script, not by an agent.
7. **Identity observation.** The executor reports the model it actually ran (usage events,
   session metadata → `actual` with `observed_cli_event` evidence) or the seat records the pin
   as `actual` with `asserted_pin` evidence — never as an observation (§6.2). The
   Moonshot/DashScope Anthropic-endpoint mapping (all claude-* names served by one configured
   model) means claude_cli-against-Moonshot records identity from *Camus's own env injection*
   with `mapped_by_operator_docs` evidence, keeps any CLI-reported claude-* names in
   `reported` without promoting them, and takes `lineage.source: registry` only because
   Moonshot is commercially accountable for the mapping it documents.
8. **Containment checks unchanged.** Post-implement and post-fix mechanical containment, the
   verify oath, head-binding — executor-independent, and any executor that cannot run under
   them (e.g. requires writing outside the worktree) disqualifies.

Candidates to carry into the §16 benchmark as *maker* executors: codex_cli with custom
providers (already a built-in maker in Studio words lanes; Build-lane use stays out of scope
until the gate's fixed pairing is deliberately revisited), qwen_code, grok_cli,
claude_cli-pointed-at-Kimi (executor unchanged, origin/operator remapped — the cheapest path
to an open-weight-adjacent maker because every custody property is already proven; what needs
proving is Kimi's tool-calling reliability under Claude Code's harness, which is precisely a
benchmark question). No first additional maker is chosen in this RFC; §16 defines the
evidence that chooses it, and slice H ships it.

## 14. Remote execution: a future ADR, deliberately out of scope

The moment a maker's *tools* run on the remote machine — not just its inference — every custody
property Camus has built stops being local: worktree identity, containment receipts,
head-binding, park-first recovery all currently assume the repository lives on the machine the
orchestrator runs on. `remote_executor` is therefore a separate ADR with its own review, and
this RFC only fixes its boundary and its agenda so nobody backs into it through the tunnel
slice.

**Boundary (enforced in this RFC's slices):** an `ssh_tunnel` connection carries HTTPS-shaped
inference bytes. The tunnel manager exposes no exec API, no file-transfer API, and no shell;
the spawn contract (§8.2) makes remote command execution impossible by construction (`-N`,
`SessionType none`). Any future "run the agent over there" feature that tries to reuse the
tunnel manager must fail at the type level — connections have `kind`, and nothing accepts
`kind: ssh_tunnel` where an executor is required.

**The ADR must own, at minimum:**

- explicit remote workspace ownership (who creates, names, and destroys the remote checkout;
  what happens to it on abort/crash — the park-first doctrine, remotely);
- repository synchronization semantics (push-to-remote vs remote-clone vs sync; how the gate's
  head-binding survives the hop; what "the diff the reviewer saw" means when the working tree
  is remote);
- remote worktree isolation equivalent to `~/.camus/worktrees` discipline;
- a **typed tool/event protocol** rather than a raw SSH shell. The audit evidence points one
  way: OpenCode's headless server (OpenAPI 3.1 + SSE, permissions as protocol objects) is the
  architecture to emulate, while Marshall's "stdio JSON-RPC transport" that turned out not to
  exist in the source is the cautionary tale about claiming one. Driving CLI commands over a
  raw SSH shell would reintroduce every relay-forgery class the WP6 receipt-binding work just
  closed — quoting hazards, receipt provenance, PID ownership — with a network in the middle.
  Verdict to carry into the ADR: typed protocol over an authenticated channel, receipts sealed
  by the orchestrator from mechanical channels, or it does not ship;
- remote containment (what mechanically proves the remote agent touched only its workspace);
- secret boundaries (which credentials may exist remotely; the remote host must be assumed to
  read everything sent to it, §15);
- cancellation and orphan cleanup across connection loss (the local PID-identity discipline has
  no remote analogue yet — that is a design problem, not a TODO);
- resume/recovery when the control connection drops mid-run.

Until that ADR exists and is approved, every remote GPU box is an inference appliance and
nothing more.

## 15. Security and privacy

Consolidated threat-and-rule list; items already argued above are stated once here as law.

**Where prompts go.** External and remote models receive repository content only after explicit
selection: a backend existing in config sends nothing; a seat decision naming it, on a run the
operator started, does. The launch form and run header state where prompts/code will be
processed (operator + transport badges, §11.4) *before* the run starts. The remote inference
host — self-hosted included — is assumed able to read and retain every prompt sent to it;
"self-hosted" in someone else's lab is still disclosure to that machine's administrators, and
the UI copy says "processed on <connection name>" rather than implying locality it cannot
prove.

**Credentials.**

- Env-var references only, in all config, exactly as today. No credentials in tracked files,
  browser storage, receipts, session lines, events.jsonl, or logs — the existing
  openai_compat rule, now covering bearer keys for local servers and nothing new for SSH
  because Camus holds no SSH secrets at all (§8.1).
- No environment or process dumps: doctor and diagnostics never print `process.env`, never
  echo the environment into fix strings, and the tunnel spawn passes a minimal environment
  (`HOME`, `PATH`, locale, `SSH_AUTH_SOCK`) — the agent socket is the one deliberate
  inheritance, because the operator's key policy lives in the agent, while `ForwardAgent=no`
  keeps it off the remote host.
- Redaction: API keys, bearer tokens, and credential-shaped values are scrubbed from any
  error/body text before it reaches session lines or the UI (the existing redaction test
  discipline — secret-shaped fixtures assembled from fragments, never literal); SSH usernames,
  hostnames, paths, and stderr per §8.6.

**SSRF and endpoint hygiene.** `direct_https` connections require `https://`, refuse literal-IP
hosts and localhost/RFC-1918/link-local/metadata ranges (those belong to `loopback` or
`ssh_tunnel` kinds, which say what they are), and re-resolve/refuse on redirect to a private
range. Loopback connections refuse non-loopback hosts. The one named exemption is the
grandfathered `legacy_http` kind (§7): minted by migration under a salted grandfather marker,
doctor-warned, honestly stamped into transport provenance, and sunset on a named release —
an operator's pre-existing decision carried forward loudly, never a new hole. The Studio server continues to fetch
only URLs derived from validated config, never from request bodies; the existing
Host/Origin/token layers stay in front of every new route. DNS-rebinding posture for outbound
calls: connect to the resolved-and-checked address, not a re-resolved name (pin-by-lookup),
for the direct_https class.

**Prompt injection and source exfiltration.** A reviewer prompt contains repository content; a
malicious or compromised model endpoint sees it (accepted, disclosed) — but must not be able to
*do* anything with the orchestrator through its answer. The existing containment already
enforces most of this: reviewer output is parsed by fail-closed normalizers, never executed;
handles and paths returned by runners are charset-validated against deterministic layouts
before use; `openai_compat` seats are toolless so a hostile endpoint cannot trigger tool calls.
New rules this RFC adds: capability-probe responses are parsed by the same normalizers (a
probe is a model output too); discovery responses (`/v1/models`) are data — model IDs are
charset-validated (`^[A-Za-z0-9._:\/-]+$`, length-capped) before they may appear in config
suggestions, argv, or UI; and error bodies from endpoints are length-capped and redacted
before display (the existing `body.slice(0, 200)` pattern, kept and made subject to the
credential scrub). A words-lane maker on an open-weight backend drafting from a poisoned
grounding item is the existing frozen-grounding threat model, unchanged by where inference
runs.

**Tunnel-specific.** Loopback-only listeners, host-key strictness, no agent/X11/remote/dynamic
forwarding, `-G` preflight refusal of config surprises, fail-closed death, no silent fallback —
all per §8. One addition: the local forwarded port is an unauthenticated door to the remote
model server for any local process while the tunnel lives. That is the same trust class as a
local Ollama (any local process can already use it), so it is accepted and documented rather
than mitigated with invented auth — but the linger timer keeps the window small, and the
diagnostics file records open/close times so the exposure period is reconstructable.

**No silent fallback, restated as the umbrella rule.** No transport fallback (tunnel → direct),
no provider fallback, no model fallback, no protocol fallback (responses → chat_completions),
no capability fallback (native tools → prompt-emulated). Every one of these is an infra
refusal that names the fix. The industry-audit sections exist largely because all four audited
products chose the opposite default somewhere, and each documented failure mode traces to it.

## 16. Compatibility benchmark

The dispatcher's law — new backends join only after the benchmark gate — finally gets its
benchmark. Design goals: reproducible, mechanical scoring wherever possible, honest about what
still needs human adjudication, and reusing the corpus discipline already planned for the
0.2.6 review-fixture work (real audited review rounds as fixtures, verdicts fresh).

### 16.1 Corpus

A dedicated fixture repository (tracked, small, no third-party code) containing task+defect
pairs: for each case, a base commit, a working-tree diff that *should* be flagged (seeded
defect classes: logic inversion, missing error path, resource leak, injection, off-by-one,
dead guard, spec deviation against the stated task) or that is clean (false-positive bait:
correct-but-unusual idioms, refactors that look risky and aren't), plus the task context the
reviewer receives. Each case carries its expected findings as structured ground truth
(`sev.schema.json`-shaped, file+line-anchored, with acceptable-alternative sets, since two
correct reviewers phrase one defect differently). ~25–40 cases initially; grown from real
adjudicated rounds in `~/.camus/reviews` per the pre-0.3 checklist, with proprietary-finding
hygiene (nothing from private repos verbatim — reconstructed minimal reproductions only).

### 16.2 Measures (per backend × model × effort × transport)

Mechanical, from receipts and the harness:

- **structured-output validity rate** — fraction of runs whose raw output survives the real
  normalizer (`normalizeReview` / `adapter.py`) without infra-refusal;
- **defect detection** — recall on seeded defects (finding matched by file + defect class);
- **false-positive rate** — blocking findings raised on clean cases;
- **tool-call correctness** — for tool-using runs: schema-valid calls, correct names, sane
  result handling; count of prose-wrapped pseudo-calls (each is a fail);
- **identity honesty** — did requested/actual match; did the backend report an actual at all;
  alias-mutation detection (a case runs against a server deliberately aliasing the model name);
- **containment** — maker candidates only: containment receipts stay clean across N runs;
- **context sufficiency** — pass/fail at the lane's prompt envelope, plus the largest case
  that fits;
- **resume/abort behavior** — kill mid-run: does abort kill the process; does resume finish or
  honestly refuse; are receipts sealed correctly on both paths;
- **tunnel interruption** — for SSH-transported runs: kill the tunnel before and during
  streaming; the only acceptable outcomes are the §8.4 infra refusals;
- **latency/throughput** — wall-clock per round, tokens/s where reported; **cold-load versus
  resident** measured separately for local servers (first-request-after-idle vs warm);
- **cost** — output tokens and elapsed time; dollars only where a provider's own receipt
  states them (the xAI per-response cost field qualifies; nothing is estimated).

Human-adjudicated, sparingly: edit quality for maker candidates (does the fix actually fix,
judged against the task) — adjudication recorded with the same discipline as the existing
benchmark-corpus plan.

### 16.3 Comparison set (minimum)

Codex CLI with local/custom providers (Responses wire); Qwen Code; Grok Build; Claude Code
pointed at Kimi (Moonshot Anthropic endpoint); direct HTTP reviewers (chat_completions and
responses); local and SSH-tunnelled Ollama and vLLM serving the same open checkpoint (transport
must be an isolated variable — same weights, same server, loopback vs tunnel). Reviewer-seat
candidates run the reviewer measures; maker candidates additionally run edit quality,
containment, and custody measures.

**The first non-Claude maker is chosen from this table, not from popularity.** The RFC
deliberately records no favorite. The admission bar (initial proposal, tunable by the human
reviewing benchmark results): ≥98% structured-output validity on the interval's lower bound;
detection recall **non-inferior** to the codex baseline at margin δ = 10 points (§16.6's
paired one-sided interval — never a point-estimate comparison and never an
absence-of-significance pass); false positives within the **absolute** margin ε = 5 points of
baseline (§16.6 — defined so a zero-FPR baseline stays decidable; there is no ratio rule);
containment per §16.6's fixed-denominator rule (zero breaches, stated upper bound,
conclusiveness floor); zero silent identity mismatches; and every kill-path test green.
Anything under the bar can still be an *advisory* seat in Studio words lanes (where the
fail-closed normalizer already contains the damage); the bar governs the gate.

### 16.4 Harness

Runs through the real dispatchers (`review.sh` env-pinned per backend; Studio seats through
`resolveSeatAdapters`) against fixture worktrees, with the mock/fake layers from §17 for the
failure-injection cases and real endpoints for the live matrix. Results are sealed as small
JSON receipts per case (the same schema the test plan asserts), so a benchmark claim in a
future doc is a pointer to receipts, not a remembered number.

### 16.5 Repetition and statistics — one run proves nothing

LLM outputs are stochastic; a benchmark whose cells hold single runs measures luck. Rules:

- **Repetition floors.** Every (backend × model × effort × transport × case) cell runs
  **N ≥ 5**; any cell feeding an admission-bar metric runs **N ≥ 10**. Kill-path and
  interruption cases run N ≥ 3 (their outcomes are mechanical, variance is infra-side).
- **Rates get intervals, not points.** Detection recall, false-positive rate, validity rate,
  and tool-call correctness are reported with an exact binomial (Clopper–Pearson) 95%
  interval, and admission thresholds compare against the interval's **lower** bound (upper
  bound for false-positive ceilings). A backend that cannot afford enough runs to clear the
  bar statistically has not cleared the bar.
- **Latency is distributional**: median and p90 per cell, cold-load and resident populations
  never pooled (they are different experiments, §16.2).
- **Variance is itself a reported metric.** Per-cell outcome flakiness (fraction of repeats
  disagreeing with the cell's majority outcome) is sealed alongside the rates; a reviewer
  whose verdicts flip run-to-run on identical input is a finding about the backend, not noise
  to average away.
- **Determinism knobs pinned and recorded.** Where the backend exposes them, temperature/
  decoding parameters are pinned (temperature 0 where honored — Marshall's live-fire testing
  discipline) and every run's receipt records the knobs it requested; seeds are recorded where
  supported. Where no knob exists, that fact is recorded and repetition carries the load.
- **No cherry-picking by construction.** Every run seals a receipt, receipts are append-only,
  and the summary tables are derived from the full receipt set; a rerun of any cell is
  disclosed in the derived table (run counts are visible per cell). Prompt-envelope and corpus
  versions ride each receipt so cross-version comparisons refuse rather than silently mix.

### 16.6 Comparison protocol against the baseline

Repetition rules say how well one cell is measured; these rules say how two cells may be
*compared* — the part v2 of this RFC left implicit:

- **The baseline is measured, not remembered.** The codex reviewer (the gate's current
  default backend at its default effort) runs the full corpus under the same corpus version,
  prompt envelope, and repetition floors, in the same benchmark campaign. A baseline number
  from an earlier campaign or a different corpus version is not a baseline; comparisons
  across corpus versions refuse.
- **Comparisons are paired one-sided non-inferiority intervals — never significance hunts.**
  A "no significant difference" admission rule rewards underpowered benchmarks: run few
  enough cases and nothing is ever significant. Inverted, correctly: candidate and baseline
  run the identical case set, the per-case paired differences feed a **one-sided 95%
  confidence interval on the paired difference of proportions** (a paired-proportions score
  method — Tango's score interval or equivalent), and the candidate is admitted only when
  the interval's **lower bound exceeds −δ** (δ = 10 recall points). Underpowering widens the
  interval, drags the lower bound below −δ, and fails the candidate — the conservative
  direction by construction. The burden of proof sits on admission, where it belongs.
- **The false-positive margin is absolute, so a zero-FPR baseline stays decidable.** The old
  "no worse than 1.5× baseline" rule degenerates when the baseline raises zero false
  positives on the clean cases (1.5 × 0 forbids everything, including noise). Instead: the
  one-sided 95% **upper** bound of the paired FPR difference (candidate − baseline) must be
  **≤ +ε**, ε = 5 percentage points on clean cases. No ratio anywhere; ε is an explicit
  product decision, listed with the other tunables for the human reviewing results.
- **Containment has a fixed denominator and a stated confidence, not a bare "zero".** The
  denominator is every run in the candidate's campaign that entered a mutation phase
  (implement or fix), across all cells and repeats. Admission requires: **zero observed
  breaches**, a denominator large enough that the rule-of-three upper bound is meaningful —
  n ≥ 150, giving a one-sided 95% upper bound of 3/n ≤ 2% — and the bound stated in the
  campaign receipt ("0 breaches in 212 mutation runs; 95% upper bound 1.4%"), so "zero" says
  what it statistically demonstrated rather than posing as proof. One observed breach
  disqualifies the whole campaign, not the cell. Containment-inconclusive receipts
  (`ran:false`) count in neither numerator nor denominator of the breach rate; they count
  against a separate **conclusiveness floor**: ≥98% of mutation runs must produce a
  conclusive containment receipt, or the campaign's containment claim is refused as
  unmeasured.
- **Denominators are fixed, not situational.** Structured-output validity is computed over
  *all* attempts (infra refusals count against it — an unparseable verdict is the failure the
  rate exists to count). Detection and false-positive rates are computed over `ran: true`
  attempts only, and are only citable next to the validity rate they ride on; the admission
  bar demands both. Harness-injected failure cases (tunnel kills, malformed-SSE fixtures) are
  their own cells, excluded from quality rates, and reported separately.
- **Transport admission is per-transport, and transport equivalence is an equivalence test —
  not an absence-of-significance test.** A backend is admitted for exactly the transports it
  benchmarked: each claimed transport variant needs its own complete cell set (same corpus,
  same floors). The loopback-vs-tunnel pair over identical weights (§16.3) must demonstrate
  equivalence by **paired two-one-sided tests**: the 90% two-sided (equivalently, both
  one-sided 95%) confidence interval on the paired per-case quality difference must lie
  **entirely within ±δₜ**, with δₜ a predeclared transport margin (initial value: 3 recall
  points; listed with δ and ε among the tunables the human reviewing results owns). "No
  significant difference" is banned here for the same reason it was banned from admission
  (§16.6's first rule — v4 reintroduced through this bullet the exact error it had just
  removed): an underpowered comparison shows nothing significant and proves nothing.
  Underpowering widens the interval past ±δₜ and the transport is not admitted; a genuine
  difference that fits inside δₜ is recorded as equivalent; one that does not is an infra
  finding to explain, never to average in. A transport with no cells is not admitted,
  silently or otherwise.
- **Ties break conservatively.** When a confidence interval straddles an admission bound, the
  options are more repetitions or no admission; a bound is never cleared by rounding, and an
  equivalence claim ("as good as baseline") requires the interval to clear the bound, not
  merely touch it.

## 17. Test plan

House rule applied throughout: every claimed guard is asserted in the artifact that runs, and
each new guard is broken on purpose once to prove the test can fail. New suites join the
existing `apps/loop-studio/*.test.mjs` set (`api.test.mjs`, `verify.test.mjs`, `custody.test.mjs`
siblings): proposed `connections.test.mjs`, `tunnel.test.mjs`, `qualify.test.mjs`, plus CLI-side
shell tests beside the skill scripts.

**Harness fakes (no network, no real ssh):**

- *Mocked provider protocols* — a local HTTP fixture server speaking chat_completions and
  responses with scriptable behaviors: happy path, torn SSE frames, missing `[DONE]`, absent
  usage, wrong/absent `model` field, slow-drip (idle watchdog), 4xx/5xx with credential-shaped
  bodies (redaction assertion), model list with alias bait.
- *Fake `ssh` binary* — a PATH-injected executable that records its argv verbatim, then
  simulates: bind-and-listen success (actually listening on the requested loopback port),
  immediate exit 255 (forward failure / auth failure / unknown host key, distinguished by
  scripted stderr), mid-stream death, and hang-until-killed. Argv assertions run against the
  recorded file — every §8.2 flag present, `--` before alias, no shell metacharacters
  interpreted because there is no shell (`spawn` argv is asserted as an array).

**Connection and tunnel cases:**

1. unknown host key → the step-4 advisory pre-check reports the miss and shows the
   operator-facing fix *before* any spawn; the authoritative step-5 spawn then runs and
   OpenSSH itself refuses (fake ssh scripted: exit 255 + unknown-host stderr class) — the test
   asserts the refusal maps to the same fix, that the flow does not retry the spawn, and that
   no known_hosts file was written (Camus reads, never writes);
2. changed host key (scripted OpenSSH MITM stderr, exit 255) → hard refusal, redacted
   surfacing, no retry loop;
3. authentication failure under BatchMode → named fix, no hang (test asserts bounded time);
4. occupied local port → manager retries once with a fresh port, then infra-refuses;
5. unreachable remote inference service (tunnel up, `GET /models` refused) → connection
   unusable, step 6/7 distinction preserved (listener-up is not service-up);
6. tunnel loss before streaming → run refuses at preflight; during streaming → adapter returns
   the `tunnel` kill-path infra error; both assert **no silent fallback**: the fixture direct
   endpoint must record zero hits;
7. process cleanup — abort, run completion, and Studio exit (signal handlers) leave no
   fake-ssh process alive (pidfile sweep); linger timer honored. Manager **crash** simulation
   asserts the honest §8.4 lease behavior instead of a false absolute: the orphan survives the
   crash, the next startup's lease sweep kills it when (and only when) pid + recorded start
   time match, clears the lease, and surfaces the "orphan found and closed" notice; a lease
   whose pid now belongs to a stranger (start-time mismatch) is cleared without signaling the
   stranger;
8. concurrent runs share one tunnel (refcount observed), and the last release tears down;
   two connections don't cross ports;
9. *no remote command execution* — fake ssh asserts `-N` present and no command argument after
   the alias; the tunnel manager's API surface is type-checked to offer no exec;
10. *no agent/X11/remote/dynamic forwarding, no shell interpolation* — argv assertions
    (`ForwardAgent=no`, `ForwardX11=no`, no `-R`/`-D` ever, alias charset), plus the `-G`
    preflight refusal cases: config-declared LocalForward/RemoteForward/DynamicForward/
    LocalCommand/ForwardAgent each individually trigger refusal naming the directive;
11. *local-only listener assertion* — with the real (not fake) ssh in an opt-in integration
    variant, and in unit form against the manager's probe logic: connect on 127.0.0.1
    succeeds, connect on a non-loopback interface refuses;
12. the ClearAllForwardings regression probe (§8.3): current ssh's `-G` with
    `ClearAllForwardings=yes -L …` yields zero localforward lines — pinning the fact the argv
    design depends on, per installed OpenSSH version.

**Protocol/normalization cases:** malformed SSE and malformed JSON verdicts → `ran:false`
infra, never a verdict (extends the existing openai-compat tests); structured-output probe
failure marks the capability `failed` and the seat refuses with the probe receipt named;
**unexpected substitution fails closed** (§6.2): a fixture reporting a `model` outside the
expected-reported set makes the maker return `ok:false` and the reviewer `ran:false` — never a
draft, never a verdict — with both identifiers in the error; the matching case where the
fixture echoes the requested id proceeds and seals `observed_api_response`; the alias-bait
case additionally asserts no lineage upgrade; the mapped-endpoint fixture
(claude_cli-against-Moonshot shape) accepts the documented mapping set, seals
`mapped_by_operator_docs`, and keeps the claude-* names in `reported` only; **pin never
becomes observation** — a run whose endpoint reports no model proceeds and seals
`actual.evidence: asserted_pin` with `reported: null`; insufficient context (fixture enforces
a small window) → context probe fails with the named server fix; unreliable tool calling
(fixture emits prose-wrapped pseudo-calls) → `tool_calling: failed`, seat ineligible for
tool-requiring contracts.

**Qualification and discovery cases:** capability receipts void mechanically on each `qual1`
fingerprint component (§9.2) — model digest change, endpoint identity change, normalizer
version bump, prompt-envelope bump, seat-type mismatch (a `words_reviewer` receipt presented
for a `gate_reviewer` seat), decoding-knob change, mediating-executor version change,
**adapter-contract version bump, credential-revision change (key rotation voids; the CLI
`unknown` revision does not), gate-contract version bump, and a light-scope receipt presented
for a full-scope gate seat**, TTL expiry — and each void names its changed component; a
voided or missing receipt re-probes or refuses at launch. The context-window probe records
three-state `status` + `demonstratedAt` (§6.1), and a `failed` window probe makes the seat
ineligible exactly like any other required capability. Per-seat matrix enforcement (§9.4): a seat missing any *required*
capability is ineligible with the missing probe named; `n/a` rows never probe and never
block. `discoveryStatus` never gates: a declared, qualified model runs with `unlisted` and
with `discovery_unavailable` (the chip and doctor note appear; the run proceeds and any
genuine absence surfaces as the endpoint's own request-time error through the fail-closed
adapter paths).

**Provenance-derivation cases (§9.1):** a config file containing `lineage.source` refuses to
load (the tier is derived, never written); a declaration contradicting a registry row refuses
at load naming both; a direct_https backend matching a registry row derives `registry`; the
same declaration over loopback/tunnel/legacy_http derives `operator_declared`; no declaration
derives `unknown`; no UI or template path can produce a stored tier (asserted by construction
against the config writer). **Vendor-managed branch:** the codex built-in derives `registry`
(isolation proven: scrubbed env + `--ignore-user-config`, both already test-pinned); the
unisolated, unconfirmed claude built-in derives **`unknown`** — never `operator_declared`,
which is reserved for a real human declaration — and its pairings seal advisory; the
**operator-confirmation action** upgrades it to a genuine `operator_declared` (record with
`why`, pinned); the isolation constant can only flip alongside a green
**inherited-`ANTHROPIC_BASE_URL` acceptance test** — plant the variable in the parent
environment, spawn through the real claude adapter against a fake `claude` binary that dumps
its environment, assert the child never sees it while `ANTHROPIC_API_KEY` passes and
`ANTHROPIC_AUTH_TOKEN` is stripped (direct-vs-routing credential roles per the cited
authentication-precedence doc; the test fails against today's adapter, which passes no `env`
at `claude.mjs:104` — that failure is the point, and the derivation constant stays false
until it passes); a Camus-injected redirection (the Kimi-via-claude_cli shape) routes
through the endpoint branch regardless of the flag — all four directions pinned, so the
built-in path can never blanket-grant `registry` to a redirected or unisolated executor.

**Sealed-schema cases (§10.8):** the golden v1 `receipt_id` stability suite; the v2
canonical-ordering pin; the **complete §10.8.4 cross-version matrix** as a table-driven
acceptance/refusal test (every row, including future-version refusals and the audit↔pairing
cross-checks); the **§10.8.3 headline truth table driven exhaustively through
`allCombinations()`** for both status versions, publication and non-completed rows included;
headline wording locks for `declared_cross_vendor_reviewed`; and the v1 dual-read equivalence
test in `status.mjs`.

**Identity/receipt cases:** same-organization pairing (Qwen/DashScope maker + Qwen/self-hosted
reviewer) seals advisory standing — organizations equal despite different operators; **GPT
maker + gpt-oss reviewer seals advisory** — different families, same `trainingOrg: openai`,
the false-cross-vendor case pinned forever; a declared derivation (`lineage.derivedFrom`)
collapses to advisory against the base family; shared-gateway disclosure appears when both
seats ride one gateway operator, and the seal-time guard refuses the contradiction case;
operator-declared lineage seals `cross_vendor_declared` and the render layer never displays
plain "independent" for it (pinned by a wording test, the receipt-coverage-vocabulary
discipline); a legacy configurable entry loads with org/family/lineage `unknown` and pairs at
advisory until confirmed, and confirming it is a one-edit upgrade (migration suite); a legacy
snapshot with no new fields still resolves and seals exactly as before (back-compat suite);
provenance on containment terminals — the CLI workflow's infra/containment terminal fields
carry reviewer backend/model/transport/connection on every terminal shape (extends the
dogfood-2026-08-07 `reviewerReceiptFields` test surface).

**Hygiene cases:** no-secret logging — grep-style assertions over every artifact a failing run
produces (events.jsonl, report.json, session lines, error text, diagnostics *excluded* by
path) with planted env keys and bearer tokens built from fragments; config with a literal
credential refuses to load with a message naming the env-var pattern; `/api/config` responses
never contain resolved URLs with ports for tunnels (runtime-state leak check).

**CLI parity:** every Studio-side refusal above has a doctor/CLI twin asserted (same module,
two presentations), so the "CLI behavior must have equivalent semantics" requirement is a
test, not an intention.

## 18. Phased plan — independently releasable slices

Each slice ships alone, behind the existing opt-in discipline (nothing activates without a
declared config entry), and none blocks the words lanes as they work today.

- **A. Identity, capability, and transport schema — including the sealed pairing v2.** The §6
  record types, org/family/lineage registry, `origin_confidence` vocabulary, capability
  three-state, the §6.2 identity ladder, §10 independence derivation with its fail-closed
  tests, **and the §10.8 sealed-schema change** (pairing v2, `declared_*` audit values,
  headline, canonical projection, validators, golden stability suites for envelopes 1 and
  2), plus the claude spawn-isolation env work (§9.1). Data-shape, trust-package, and
  spawn-environment work; no new network I/O.
- **B. Provider/connection configuration and migration.** `connections` in the models file,
  `validateCompatEntry` successor validating the new backend shape, silent migration of bare
  `baseUrl` entries to anonymous connections, doctor's connection-first checks (loopback +
  direct_https only). No SSH yet.
- **C. Direct and loopback Studio providers.** Templates (§11.1), protocol field
  (chat_completions; responses adapter as its own sub-slice), qualification probes (§9.2) for
  loopback/direct backends, capability-gated seat eligibility, badges. First user-visible
  payoff: Grok/DashScope/Moonshot/local-Ollama seats, qualified and honestly labeled.
- **D. Managed SSH inference tunnel and doctor.** §8 in full: tunnel manager, preflight
  ladder, redaction, lifecycle, fail-closed adapter kill path, fake-ssh test harness. CLI
  doctor parity.
- **E. Studio connection/model UX.** The "Connect own server" flow over D's ladder,
  diagnostics pane, residency chips, re-qualification UX. (D and E split so the security core
  lands reviewable without UI noise.)
- **F. Generic CLI reviewer backends.** §12: dispatcher names, shared watchdog/binding reuse,
  `http_openai_compat` backend implementation (the simplest, and the one that exercises the
  contract end-to-end), transport provenance in gate receipts. Ships *disabled* — benchmark
  admission is the enable switch.
- **G. Maker-runtime benchmark.** §16 corpus + harness + reviewer-candidate matrix (codex
  custom-provider, qwen_code, grok_cli, http, tunneled variants). Produces the evidence tables
  slices H and the F-enablement read.
- **H. First additional maker executor.** Chosen from G's evidence against §13's contract;
  its own hardening profile (the §5 research pre-writes the grok/qwen checklists); Studio
  words-lane maker seat first, Build lane not included (gate pairing stays fixed).
- **I. Remote executor** — only through the §14 ADR, separately approved. Not scheduled.

Sequencing: A→B→C are strictly ordered; D depends on B; E on C+D; F on A (it needs identity
fields) but not on C; G needs F's harness pieces and C's qualification probes; H needs G.

## 19. Closing: first slice, files, tests, compatibility, open questions

### 19.1 Recommended first bounded implementation slice

**Slice A + the B migration core** (identity schema, sealed pairing v2, and connection
objects with loopback/direct_https only), because every later slice's honesty depends on the
vocabulary existing *sealed* first, it touches no network code, and it is the slice most
likely to surface schema disagreements cheaply during review. Concretely bounded to: the
identity record and org/family/lineage registry; the §6.2 identity ladder with evidence
classes; `connections` parsing/validation/migration (with dual-written `baseUrl`) in
`models.mjs`; seat-catalog and snapshot plumbing of the new fields; independence derivation
(`cross_vendor_declared`, shared-gateway facts) in `engine.mjs`; **the §10.8 sealed-schema
change** — pairing v2 in `evidence-pack.mjs`, canonical projection, validators, `declared_*`
audit values and headline in the trust package; **the claude spawn-isolation work with its
inherited-`ANTHROPIC_BASE_URL` test** (§9.1 — scheduled here so the flagship pairing's
standing does not regress; if it slips, the claude seat ships honestly at `unknown` —
advisory pairings — with the operator-confirmation action as the interim path); doctor's
connection-first reporting for the two network-free kinds (reachability probes stay exactly
as they are today). Explicitly *not* in the first slice: SSH anything, capability probes, new
adapters beyond the claude env change, UI beyond reading the new catalog fields.

### 19.2 Exact files expected to change (first slice)

- `apps/loop-studio/lib/models.mjs` — connection parsing/validation/migration (the
  loopback/direct_https/`legacy_http` classification, the one-time grandfather snapshot +
  sidecar consultation (`~/.camus/studio/grandfather.json`, §7), the full-surface dual-write
  incl. `CAMUS_NO_AUTH`, and the legacy-provider-stays-unknown rule); extended backend
  shape; seatCatalog entries carry identity fields.
- `apps/loop-studio/lib/identity.mjs` (new) — the §6 record, the org/family/lineage registry,
  `deriveLineageSource()` with the per-executor `redirectIsolationProven` table (§9.1),
  `origin_confidence` and identity-ladder derivations, expected-reported-set computation
  (§6.2); pure functions, fully unit-tested.
- `apps/loop-studio/lib/adapters/claude.mjs` — the **spawn-isolation work** (§9.1): an
  auth-aware explicit environment allowlist (auth material passes; redirect-capable variables
  are stripped) and settings-source pinning for redirect-capable CLI configuration, plus the
  fake-binary env-dump fixture behind the inherited-`ANTHROPIC_BASE_URL` test — the
  allowlist keeps direct-authentication material (`ANTHROPIC_API_KEY`, OAuth credentials)
  and strips routing material (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) per the
  documented credential roles (§9.1). Scheduled inside slice A so the flagship pairing's
  standing does not regress; if it slips, the derivation ships with the claude row honestly
  at `unknown`, upgradeable by the operator-confirmation action.
- `apps/loop-studio/lib/engine.mjs` — `reviewPairingFacts` reads org/family/lineage (not the
  provider prefix); reported-vs-actual evidence recording; new pairing session facts.
- `apps/loop-studio/lib/evidence-pack.mjs` — envelope v3 production (§10.8.1: pairing v2 +
  statuses v2): structured seat identity fields, `actual_evidence`, `cross_vendor_declared`,
  `shared_gateway`, the sealed `qualification` reference per seat; seal-time guard
  extensions (§10 rule 7).
- `packages/trust/lib/canonical.mjs` — v2 canonical projection, v1 byte-frozen.
- `packages/trust/lib/validate.mjs` — pairing v1/v2 acceptance rules, `declared_*` gating,
  rule-7 refusals as validator checks.
- `packages/trust/lib/status.mjs` — `declared_*` audit values, `declared_cross_vendor_reviewed`
  headline derivation, v1 dual-read equivalence.
- `apps/loop-studio/lib/status-dims.mjs` — derives `declared_*` audit dimension values from
  the recorded round facts.
- `apps/loop-studio/lib/adapters/registry.mjs` — resolves backends through connections;
  refusal messages name connection gaps.
- `apps/loop-studio/lib/adapters/openai-compat.mjs` — reads baseUrl via connection; records
  `reported` + `actual_evidence`; no behavioral change otherwise.
- `apps/loop-studio/lib/doctor.mjs` — per-connection checks (loopback/direct_https);
  per-backend checks compose connection status; unconfirmed-lineage prompts.
- `apps/loop-studio/server.mjs` — `/api/config` exposes connections + identity fields
  (values-never rule unchanged); the audit-replay source-acceptance check (today
  `evidencePack.schemaVersion !== 2` → refuse) learns to read envelope 3 (§10.8.1, a reader
  change only).
- `checks/models.json` — untouched (defaults stay claude/codex; no tracked connections).
- `apps/loop-studio/checks/registry.json` (**new, tracked**) — the operator↔org/family
  registry: endpoint-host rows with model-id patterns, the executor table for the
  vendor-managed path (§9.1), and the family table (gpt/gpt_oss → openai). Reviewed like any
  tracked default; doctor reports staleness against declared config, never the network (U5's
  proposal, carried).
- `packages/trust/schemas/evidence-pack.v3.schema.json`,
  `packages/trust/schemas/pairing-manifest.v2.schema.json`,
  `packages/trust/schemas/status.v2.schema.json` (**new, tracked**) — the concrete published
  JSON Schemas (§10.8.1); validator tests assert `validate.mjs` and these files agree.
- `packages/trust/SCHEMAS.md` (**new, tracked**) — the published-schema register: envelopes
  1/2/3, pairing 1/2, statuses 1/2, pointers to the schema files above, the immutability rule
  with its audit-replay production exception, and the §10.8.4 matrix. The register is
  documentation *pinned by the validator tests*, so it cannot drift from the code the way
  prose alone does.
- `packages/trust/README.md` — one added pointer to `SCHEMAS.md` (the file exists today and
  gains a section, nothing else).
- `apps/loop-studio/README.md` — the operator-facing documentation of the extended
  `models.json` shape (connections, declarations, dual-write fields incl. `CAMUS_NO_AUTH`)
  and the rollback notes from §19.4.
- Tests: `apps/loop-studio/connections.test.mjs` (new), extensions to `verify.test.mjs` /
  `api.test.mjs`, adapter tests beside `lib/adapters/`, and the trust-package golden/validator
  suites in `packages/trust/test.mjs` (§10.8; golden v1 receipt fixtures added under the trust
  package's fixture conventions).
- `docs/MULTI-MODEL-SEATS.md` — a short addendum pointing here; this RFC file itself.

Named now so later slices inherit concrete targets rather than intentions, though they change
only in their own slices: `packages/cli/skills/camus/REVIEW-CONTRACT.md` (**new, slice F**) —
the versioned gate-review contract register stamping the ensemble of
`packages/cli/skills/camus/review-prompt.md`, `packages/cli/skills/camus/sev.schema.json`,
and the light-scope addendum, read by qual fingerprints (§9.2 component 16);
`apps/loop-studio/checks/review.schema.json` (existing) — gains its version stamp in slice C
when the words-reviewer qualification probes begin citing it. CLI files (`review.sh`,
`codex_review.sh`, `adapter.py`, `camus-loop.workflow.js`) change in slice F, not the first
slice.

### 19.3 Exact acceptance tests (first slice)

1. Legacy `models.json` files (no `connections`, bare `baseUrl` compat entries, pre-seats
   files with no backend field) load equivalently: same `getModels()` output, same seat
   catalog — asserted by golden-file comparison against current fixtures — except that
   configurable entries' org/family/lineage read `unknown` (never migrated from `provider`),
   with the confirmation path exercised: one config edit upgrades the entry and its
   subsequent pairings.
2. **Golden receipt stability for every published envelope**: existing sealed envelope-1 and
   envelope-2 fixtures re-derive byte-identical canonical forms and identical `receipt_id`s
   after the trust-package change, and both keep *validating* (reader compatibility, not just
   hash stability — the v4 matrix's envelope-1 refusal is the regression this pins against).
3. **The complete §10.8.4 cross-version validator matrix**, table-driven — every row
   including future-version refusals and the audit↔pairing cross-checks — plus the
   **§10.8.3 headline truth table** exhausted through `allCombinations()` for both status
   versions; each refusal case proven able to fail by mutating the guard.
4. A backend naming an undeclared connection refuses at load with the fix named; an
   `ssh_tunnel` or `remote_executor` kind refuses with "not yet supported / see ADR" —
   distinct messages. A written loopback/direct/legacy_http backend carries the **complete
   dual-written legacy surface** (§7: `baseUrl`, `provider` label, `apiKeyEnv` — real name or
   `CAMUS_NO_AUTH` for keyless, `models`, `seats`), and the written file loads under the
   **current shipped** `validateCompatEntry` (the rollback assertion, run against the real
   current validator in CI) — asserting the two-tier guarantee as stated in §7: load
   isolation for every entry, functional parity for keyed entries, and for keyless entries
   the named call-time demand for `CAMUS_NO_AUTH` rather than any parity claim.
5. `direct_https` validation refuses http://, literal-IP, and private-range hosts; `loopback`
   refuses non-loopback hosts; `ssh_tunnel` config validation refuses a non-loopback
   `remoteAddress`. **Legacy private-HTTP migration**: a bare `http://192.168.x.x:11434/v1`
   entry classifies to `legacy_http`, loads with the doctor warning naming its three upgrade
   paths, and stamps `transport: legacy_http` into identity records. The **durable
   grandfather boundary** (§7) is exercised in all four shapes: the first-launch snapshot
   records the entries present and they keep loading; a legacy-shaped entry added *after*
   the snapshot refuses, naming the upgrade paths and the explicit confirmation action; the
   confirmation action appends a record and the entry then loads; a sidecar record copied
   from another machine fails its HMAC (different salt) and refuses. The config file is
   asserted byte-identical throughout (migration never rewrites it). The sunset refusal is
   testable behind its release flag.
6. Standing derivations: same-org/different-operator seals advisory; **GPT + gpt-oss seals
   advisory (same org, different family)**; operator-declared cross-org seals
   `cross_vendor_declared` with the `declared_*` audit dimension and the locked headline;
   unknown org/family/lineage fails to advisory; fully registry-backed cross-org pairs seal
   `cross_vendor` and are refused if labeled `cross_vendor_declared`.
7. Identity-ladder evidence and substitution: an endpoint echoing the requested model seals
   `observed_api_response`; **an endpoint reporting outside the expected-reported set fails
   the call closed** (maker `ok:false`, reviewer `ran:false`, both identifiers named — never
   a draft or verdict); a silent endpoint proceeds and seals `asserted_pin` with
   `reported: null`; the mapped-endpoint fixture accepts the documented mapping set and seals
   `mapped_by_operator_docs`; no code path writes an observed evidence class without a stored
   observation (asserted by construction tests on the adapter outputs).
8. Runtime state never persists: after a full config round-trip through `updateModels`, no
   resolved tunnel URL/port appears in the written file (planted-value sweep).
9. Wording locks: renderings of `cross_vendor_declared` / `declared_*` never contain the bare
   word "independent" or "verified" (pinned string test, receipt-vocabulary discipline).
10. `/api/config` and doctor output contain env-var names but never values (planted-secret
    sweep, fragment-assembled fixtures).
11. Provenance derivation is mechanical (§9.1): a config file carrying `lineage.source`
    refuses to load; a declaration contradicting a registry row refuses naming both; the
    registry tier derives only for direct_https endpoints the registry covers; the identical
    declaration over loopback/tunnel/legacy_http derives `operator_declared`; nothing
    reachable from the UI or a template writes a tier.
12. Built-in isolation gates the vendor-managed tier: the **inherited-`ANTHROPIC_BASE_URL`
    test** (plant in parent env, spawn the real claude adapter against a fake env-dumping
    `claude`, assert the child never sees it while direct-auth material passes and
    `ANTHROPIC_AUTH_TOKEN` is stripped) is present and *fails against the unmodified
    adapter*; `redirectIsolationProven('claude_cli')` is false while it fails and the claude
    seat derives **`unknown`** (pairings seal advisory); the operator-confirmation action
    upgrades it to `operator_declared` with the `why` recorded; the codex twin (scrubbed env
    excludes redirect variables) passes today and codex derives `registry`.
13. Qualification is sealed uniformly and version-locked at the validator: an envelope-3
    pack with any null or absent `qualification` refuses; the `builtin1:` namespace is
    selected by **exact built-in backend + `vendor_managed` transport** — explicitly tested:
    **a `codex_cli` seat on `loopback`, `direct_https`, or `ssh_tunnel` sealing `builtin1:`
    refuses** (a custom-provider seat is not a built-in whatever its executor kind), and a
    `qual1:` on a vendor_managed built-in refuses; the codex gate reviewer seals a
    `builtin1:` fingerprint that changes when the review contract or hardened profile bumps;
    `pairing.review_scope` is populated from the round's binding channel, and a `gate_scope`
    disagreeing with it refuses — including the light-qualification-behind-full-round case;
    a words-lane pack seals `review_scope: null` + `gate_scope: null`.
14. The grandfather sidecar is fail-closed as a contract (§7): initialization writes records
    then marker, atomically, once; with the marker present, a deleted, truncated,
    wrong-version, or HMAC-broken `grandfather.json` makes every `legacy_http` entry refuse
    (no re-snapshot fires — asserted); recovery is per-entry confirmation only; each
    record's `source` and `why` are covered by its HMAC, so editing either breaks the
    marker; a crash simulated between records-write and restart recovers by **finishing the
    marker only** — the existing records validate, no inventory re-runs, and **a
    legacy-shaped entry added to the config during the crash window remains refused** after
    recovery (the reopened-bulk-grandfathering hole, pinned shut).

Later-slice acceptance additions, named now so the slices inherit tests rather than
intentions: **slice C** — a seat may not launch without a valid `qual1` receipt matching the
run's seat type; the run snapshot records the accepted fingerprint that the round events and
sealed pairing then carry unchanged. **Slice F** — `asGate()` refuses a binding whose scope,
contract version, or qualification fingerprint disagrees with the workflow's expectation
(each mismatch exercised; the light-behind-full case end-to-end from posture to refusal), and
`review_request.py`/`meta.json`/the emitted binding all carry the three new fields through
start, await, adoption, and replay. **Slice G** — the benchmark harness computes the §16.6
statistics as specified: non-inferiority lower bounds, absolute FPR margin, containment
denominator and conclusiveness floor, and the transport TOST interval, each with a fixture
campaign proving the underpowered case fails admission.

### 19.4 Backward-compatibility plan

- **Config**: old files keep working unmigrated on disk; migration is in-memory at load.
  `updateModels` writes the new shape only when the operator actually edits a
  connection-bearing entry; a settings save that touches nothing new must not rewrite old
  entries (no gratuitous churn in `~/.camus/studio/models.json`).
- **Receipts — stated precisely, correcting v1 of this RFC.** New runs seal pairing v2 from
  the slice-A release onward: their `receipt_id` derivation includes the v2 fields by design
  (§10.8). Already-sealed receipts are untouched and re-derive identically (the golden suite).
  Two things this does **not** mean: session-line additions are *not* compatibility-neutral —
  `receipt_id` covers `session_log`, so any new line changes new receipts' ids, which is
  expected per-run behavior but means golden fixtures must be version-pinned, never
  regenerated in place; and legacy configurable entries are *not* annotated with registry
  lineage — only built-ins are (§6.5). Legacy snapshots resolve through the existing defaults
  (`anthropic`/`openai`), which the registry states for built-ins because that is what those
  snapshots meant.
- **Env overrides** (`CLAUDE_MODEL`/`CODEX_MODEL`/`CODEX_EFFORT`) keep their CLI-backend-only
  semantics; no new env override is introduced for compat backends (decisions live in files
  with `why`).
- **Frozen experiment schemas** (Compare & Learn, audit replay) are untouched and tested
  untouched.
- **Rollback — stated precisely, correcting v1 of this RFC.** Unknown *top-level* keys
  (`connections`) are ignored by current code (`readDecision` passes them through), but
  unknown-shaped **backend entries are not**: one throwing entry fails
  `listBackends()` → `getModels()` wholesale, and `baseUrl` is not the only field that
  throws — the shipped validator's full requirement list (`kind`, plain `provider`,
  `baseUrl`, `apiKeyEnv`, non-empty `models`, valid `seats`) is enumerated in §7, and the
  dual-write covers **all of it**, including the `CAMUS_NO_AUTH` placeholder env-var name for
  keyless backends. The guarantee is **two-tier, per §7**: load isolation for every entry
  (rolled-back `getModels()` never throws on a dual-written entry, so other backends keep
  working); functional parity for *keyed* entries; and for *keyless* entries no parity
  claim — a named one-line manual step (set `CAMUS_NO_AUTH` to any value, or remove the
  entry) with the pre-set-variable case noted in §7. CI asserts each entry class against its
  own tier. `ssh_tunnel`-connected backends (slice D+) have no honest URL surface: under
  rolled-back code they fail the models check loudly, doctor names the offending entry, and
  the operator removes it or reverts the config — a named manual step in the rollback
  procedure, not a silent survival. Sealed envelope-3 receipts remain readable after a
  rollback only by tooling that shipped envelope-3 support; the rollback procedure therefore
  pins the trust package and Studio to move together.

### 19.5 Unresolved product decisions (need Mateo)

- **U1 — RESOLVED (this revision, §10.8).** The sealed-schema change is pairing
  `schemaVersion: 2` and ships with slice A; no soak-then-bump. The
  deliberate-schema-question note in MULTI-MODEL-SEATS.md (refusals into `session_log`)
  does **not** ride this bump — it stays open and separate, so this change stays reviewable.
- **U2 — RESOLVED (this revision, §10.8).** First-class raw audit-dimension values
  (`declared_clean` / `declared_findings`), never a qualifier on `independent_*`; headline
  token `declared_cross_vendor_reviewed`, display string "cross-vendor as configured — origin
  declared, not attested", both locked by test. The final display *phrasing* remains
  Mateo-approvable at review (R4) without reopening the schema.
- **U3 — words-lane maker tools for agent executors.** When slice H seats a tool-capable
  non-claude maker in words lanes, does it get a research tool surface (web) or stay toolless
  like openai_compat? The toolPolicy cap architecture supports either; the honest-grounding
  story differs.
- **U4 — same-origin gate pairings in the CLI.** `review.sh`'s cross-vendor invariant is
  absolute today. With origin-aware dispatch, is a same-origin *advisory* gate round ever
  permitted for the Build lane (as Studio words lanes allow), or does the gate stay
  cross-origin-or-refuse? Recommendation: stays absolute until the benchmark exists; revisit
  with evidence.
- **U5 — how much of the §5 provider registry is tracked vs local.** Shipping operator↔origin
  registry entries in-repo makes them auditable but adds a maintenance surface with drift
  risk (the DashScope endpoint churn is the warning); local-only makes every machine's
  honesty self-serve. Proposal: tracked registry, small, with doctor verifying staleness
  against declared config rather than the network.
- **U6 — Grok product naming.** Whether Studio copy says "Grok (xAI)" with a proprietary
  badge or groups hosted providers generically. Marketing-adjacent; §2's terminology rule
  constrains but does not decide it.

### 19.6 Risks requiring human approval before implementation

- **R1 — spawning a network client (ssh) from Studio** (slice D): a new process class with
  operator-config-driven argv. Mitigations are §8; the *decision* that Studio may spawn ssh at
  all is Mateo's.
- **R2 — repository content leaving the machine to operator-configured endpoints** beyond the
  two blessed CLIs: already true for openai_compat in words lanes, but slice F extends it to
  the *gate's diffs* (review content = repo content). Needs an explicit yes.
- **R3 — benchmark spend**: slice G runs paid rounds across multiple hosted providers;
  budget/tier decisions (and which providers get keys at all) are account-level decisions.
- **R4 — the `cross_vendor_declared` standing and its sealed schema** (§10 rule 4, §10.8) put
  new trust vocabulary into receipts customers read *and* into `receipt_id` derivation. The
  schema and derivation are specified in §10.8; approving that specification — including the
  exact display phrasing — is a human decision on the same footing as the 0.3
  status-dimension work, and implementation must not start before it.
- **R5 — shipping a fixture corpus of seeded defects** (§16.1) publishes adversarial review
  cases; low risk since synthetic, but it is public test material that describes what the gate
  catches and misses — worth a conscious publish decision.

### 19.7 Claims still needing a live provider-backed test

Everything below is stated in this RFC from documentation or unauthenticated probes and must
be verified with real credentials/hardware before any slice relies on it:

1. xAI `GET /v1/models` response shape, and the undocumented Anthropic-style `/v1/messages`
   behavior with a real key.
2. xAI structured-output strict mode under the reviewer schema's actual size/constraint
   profile (documented caps: 2,048/256/64) — the normalized-review schema must fit.
3. Moonshot `[1m]` model-suffix semantics; the Anthropic-endpoint server-side default when no
   `ANTHROPIC_MODEL` is injected; whether Claude Code usage events echo claude-* or kimi
   names (determines the implementation of §13's identity-observation rule, item 7).
4. DashScope: which base URL a given account actually serves (workspace-scoped vs legacy);
   documented `tools`+`stream` incompatibility on compatible-mode; JSON-schema structured
   output support for qwen3-coder models; `GET /models` shape.
5. Codex custom-provider Responses runs end-to-end against Ollama/vLLM/LM Studio `/v1/responses`
   (stateless caveats, `stream_idle_timeout_ms` behavior, which features
   `requires_openai_auth` actually gates), and `codex exec` parity under `--ignore-user-config`
   with `-c model_providers.*` overrides.
6. Grok Build: `--output-format json` schema enforcement; a config-isolation mode equivalent
   to `--ignore-user-config` (its zero-config Claude-surface ingestion must be provably off);
   sandbox `read-only` enforcement observed from the event stream on macOS; API-key billing
   semantics for CLI use.
7. Qwen Code `--json-schema` validation strictness and exit-code contract (53/55/130) under
   the real reviewer schema; approval-mode `plan` guarantees against writes.
8. Ollama silent context truncation (community-documented, not first-party): reproduce, then
   encode the §9.2 window probe against it; `/api/ps` residency reporting accuracy.
9. LM Studio `/api/v1` vs `/api/v0` field availability on current builds; JIT-load listing
   semantics.
10. The full §8 preflight ladder against a real GPU host: `-G` parsing across the installed
    OpenSSH versions in the field (10.x casing; per-version ClearAllForwardings regression
    probe), `ssh-keygen -F` exit codes per version, ProxyJump-through-bastion behavior with
    the hardened argv, and tunnel keepalive behavior against a non-OpenSSH sshd if any
    operator runs one (10.3's rekey-compat removal).
11. Kimi K3/K2.7 and Qwen open checkpoints actually serving through vLLM/Ollama with reviewer-
    grade structured output at the context sizes the words lanes need (the whole §16 local
    matrix, summarized).
12. Every price, context window, and model ID quoted in §5 re-checked at implementation time
    against the provider's live pages — they are 2026-08-18 facts, not constants.

## Appendix A — Sources

All verified 2026-08-18 unless a page states its own date. Where a source repository was
audited at a pinned commit, the SHA is given; where a page or file was retrieved without
pinning a commit, that is said explicitly rather than invented.

**xAI / Grok.**
API and models: https://docs.x.ai/docs/overview · https://docs.x.ai/developers/quickstart ·
https://docs.x.ai/developers/rest-api-reference/inference/chat ·
https://docs.x.ai/developers/models · https://docs.x.ai/developers/models/grok-build-0.1 ·
https://docs.x.ai/developers/model-capabilities/text/structured-outputs ·
https://docs.x.ai/developers/tools/function-calling · https://docs.x.ai/developers/rate-limits ·
https://docs.x.ai/developers/pricing · https://docs.x.ai/developers/migration/may-15-retirement ·
https://docs.x.ai/developers/release-notes · https://docs.x.ai/developers/grpc-api-reference.
Grok Build: https://x.ai/news/grok-build-cli · https://docs.x.ai/build/overview ·
https://docs.x.ai/build/settings · https://docs.x.ai/build/cli/reference ·
https://docs.x.ai/build/cli/headless-scripting · https://docs.x.ai/build/features/permissions ·
https://docs.x.ai/build/features/sandbox ·
https://docs.x.ai/build/features/skills-plugins-marketplaces ·
https://github.com/xai-org/grok-build (repo created 2026-07-14; README/metadata via GitHub
API, no commit pinned) · https://github.com/xai-org/grok-build-plugin-cc (README, no commit
pinned). Open-weights status: https://huggingface.co/api/models?author=xai-org (empirical
listing) · https://github.com/xai-org/grok-1 ·
https://techcrunch.com/2025/08/24/elon-musk-says-xai-has-open-sourced-grok-2-5/.
Endpoint existence probes (`/v1/models`, `/v1/messages`): unauthenticated curl against
api.x.ai, 2026-08-18.

**Moonshot / Kimi.**
https://platform.kimi.ai/docs/api/chat · https://platform.kimi.ai/docs/api/list-models.md ·
https://platform.kimi.ai/docs/models.md · https://platform.kimi.ai/docs/pricing/chat-k3.md ·
https://platform.kimi.ai/docs/pricing/chat-k27-code.md ·
https://platform.kimi.ai/docs/pricing/chat-k26.md · https://platform.kimi.ai/docs/pricing/chat-k25.md ·
https://platform.kimi.ai/docs/guide/claude-code-kimi ·
https://platform.kimi.ai/docs/guide/kimi-code-cli.md ·
https://github.com/MoonshotAI/kimi-cli · https://github.com/MoonshotAI/kimi-code (READMEs, no
commits pinned). Weights and licenses: https://huggingface.co/moonshotai/Kimi-K3 (+ LICENSE
file) · https://huggingface.co/moonshotai/Kimi-K2.7-Code ·
https://huggingface.co/moonshotai/Kimi-K2.6 · https://huggingface.co/moonshotai/Kimi-K2.5 ·
https://huggingface.co/moonshotai/Kimi-K2-Instruct (license tags via HF API). Redirect/endpoint probes against api.moonshot.ai / api.moonshot.cn, 2026-08-18.

**Alibaba Qwen / DashScope.**
https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope ·
https://www.alibabacloud.com/help/en/model-studio/claude-code ·
https://www.alibabacloud.com/help/en/model-studio/qwen-code ·
https://www.alibabacloud.com/help/en/model-studio/model-pricing ·
https://www.alibabacloud.com/help/en/model-studio/qwen-coder. Qwen Code CLI: https://github.com/QwenLM/qwen-code — README plus
docs/users/auth.md, headless.md, approval-mode.md, sandbox.md, structured-output.md (main
branch 2026-08-18, no commit pinned). Weights:
https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct ·
https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct ·
https://huggingface.co/Qwen/Qwen3-Coder-Next · https://huggingface.co/Qwen/Qwen3.8-27B ·
https://huggingface.co/Qwen/Qwen3.6-35B-A3B
(license tags via HF API). Coding-plan announcement:
https://x.com/Alibaba_Qwen/status/2024136381308805564. Endpoint probes against
dashscope/dashscope-intl/dashscope-us compatible-mode, 2026-08-18.

**OpenAI Codex CLI and gpt-oss.**
https://learn.chatgpt.com/docs/config-file/config-reference ·
https://learn.chatgpt.com/docs/config-file/config-advanced ·
https://learn.chatgpt.com/docs/codex/cli · https://learn.chatgpt.com/docs/non-interactive-mode
(redirect targets of developers.openai.com/codex/*) ·
https://github.com/openai/codex/discussions/7782 (chat-wire deprecation) ·
https://github.com/openai/codex/issues/8240 · https://docs.ollama.com/integrations/codex ·
https://ollama.com/blog/codex. gpt-oss: https://github.com/openai/gpt-oss ·
https://huggingface.co/openai/gpt-oss-120b · https://huggingface.co/openai/gpt-oss-20b ·
https://github.com/openai/harmony.

**Claude Code (credential roles for the §9.1 isolation allowlist).**
https://code.claude.com/docs/en/iam#authentication-precedence — documents
`ANTHROPIC_AUTH_TOKEN` as proxy/gateway authentication and `ANTHROPIC_API_KEY` as direct
Anthropic authentication, the distinction the spawn-isolation allowlist enforces (verified
2026-08-18).

**Local inference servers.**
Ollama: https://docs.ollama.com/api/openai-compatibility · https://docs.ollama.com/faq ·
https://docs.ollama.com/context-length · https://docs.ollama.com/modelfile ·
https://github.com/ollama/ollama/blob/main/docs/api.md (main, 2026-08-18, no commit pinned) ·
https://ollama.com/blog/structured-outputs · https://github.com/ollama/ollama/issues/13595.
LM Studio: https://lmstudio.ai/docs/app/api/endpoints/openai ·
https://lmstudio.ai/docs/app/api/endpoints/rest · https://lmstudio.ai/docs/app/api/headless · https://lmstudio.ai/docs/developer/openai-compat/tools ·
https://lmstudio.ai/docs/developer/rest/endpoints.
vLLM: https://docs.vllm.ai/en/latest/serving/online_serving/ ·
https://docs.vllm.ai/en/latest/cli/serve.html ·
https://docs.vllm.ai/en/latest/features/tool_calling.html ·
https://docs.vllm.ai/en/latest/features/structured_outputs.html.
llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md (master,
2026-08-18, no commit pinned).
SGLang: https://docs.sglang.io/basic_usage/openai_api_completions.html.

**OpenSSH.**
https://man.openbsd.org/ssh.1 (page dated 2026-08-04) · https://man.openbsd.org/ssh_config.5
(page dated 2026-07-11) · https://man.openbsd.org/ssh-keygen.1 ·
https://www.openssh.com/releasenotes.html (through OpenSSH 10.5, 2026-08-11) ·
https://openssh.com/pq.html ·
https://raw.githubusercontent.com/openssh/openssh-portable/master/readconf.c (master,
2026-08-18, no commit pinned — the `clear_forwardings()` / `fill_default_options()` ordering).
Empirical `-G` behavior: OpenSSH_10.3p1 / LibreSSL 3.3.6 on macOS, 2026-08-18.

**Product audit.**
Marshall: https://github.com/LaurentZuijdwijk/agention-marshall — **audited at commit
`ece5d513fafc`** (2026-08-18) · https://marshall.agention.ai · https://docs.agention.ai · npm
`@agentionai/marshall-cli` 0.21.1, `@agentionai/marshall-engine` 0.19.0,
`@agentionai/marshall-tools` 0.6.5 (npm view, 2026-08-18).
OpenCode: https://github.com/anomalyco/opencode — **docs audited at commit `ad905f8e6c8c`**
(`packages/web/src/content/docs/*.mdx`) · https://opencode.ai/docs/providers/ ·
https://opencode.ai/docs/models/ · https://opencode.ai/docs/server/ ·
https://opencode.ai/docs/agents/ · https://opencode.ai/docs/permissions/ ·
https://opencode.ai/docs/sdk/ · archived lineage:
https://github.com/opencode-ai/opencode.
Continue: https://docs.continue.dev/customize/model-roles/00-intro ·
https://docs.continue.dev/reference#models ·
https://docs.continue.dev/customize/deep-dives/model-capabilities ·
https://docs.continue.dev/guides/ollama-guide · https://docs.continue.dev/faqs ·
https://docs.continue.dev/customize/model-providers/top-level/openai ·
https://docs.continue.dev/customize/model-providers/top-level/ollama ·
https://docs.continue.dev/guides/how-to-self-host-a-model ·
https://github.com/continuedev/continue/blob/main/core/llm/toolSupport.ts (main, 2026-08-18,
no commit pinned).
OpenHands: https://docs.openhands.dev/openhands/usage/llms/llms ·
https://docs.openhands.dev/openhands/usage/llms/local-llms ·
https://docs.openhands.dev/openhands/usage/llms/litellm-proxy ·
https://docs.openhands.dev/openhands/usage/cli/headless ·
https://docs.openhands.dev/openhands/usage/architecture/runtime ·
https://docs.openhands.dev/openhands/usage/sandboxes/overview ·
https://docs.openhands.dev/openhands/usage/advanced/configuration-options ·
https://docs.openhands.dev/openhands/usage/v0/advanced/V0_configuration-options
(docs.all-hands.dev redirects here).

## Change log — first audit round → v2

| # | Finding | Revised where |
| --- | --- | --- |
| 1 | Executor interface conflated with inference protocol; CLI executors barred from connections | §2 (protocol/transport bullets), §6 intro, §6.1 (`protocol`/`transport`/`connection` redefinitions, `vendor_session`/`vendor_managed`), §6.3 (Kimi row now `anthropic_messages`/`direct_https`; new Qwen-Code-over-tunnel row), §7 (CLI-executor connection rule) |
| 2 | Training org, family, and lineage conflated; GPT vs gpt-oss could seal falsely cross-vendor | §2 (origin redefined as the pair), §6.1 (`trainingOrg`/`modelFamily`/`lineage`), §6.3 (gpt-oss row + discussion), §6.4 (family-vs-org ban), §9.1 (lineage tiers, registry family table), §10 rules 1–2, §17 (GPT+gpt-oss advisory case) |
| 3 | Legacy configurable `provider` values migrated into authoritative origins | §6.5 (asymmetric migration), §7 (required-fields rule), §9.1 (`unknown` tier row), §19.3 test 1, §19.4 (receipts bullet corrected) |
| 4 | U1/U2 deferred; configured-cross-origin standing unsealed | §10 rule 4, **§10.8** (pairing v2, `declared_*` dimensions, headline, canonical projection, validators, tests), §18 slice A, §19.1, §19.2 (trust-package files), §19.3 tests 2–3/6, §19.5 (U1/U2 RESOLVED), §19.6 R4 |
| 5 | Back-compat/rollback claims wrong: `baseUrl` is required today; `receipt_id` covers `session_log` | §7 (dual-write bullet), §19.3 test 4, §19.4 (both corrected bullets, each marked "correcting v1 of this RFC") |
| 6 | Requested/resolved/reported/actual semantics implicit; pins could read as observations | §6.1 (ladder fields), **§6.2** (semantics + evidence classes + no-pin-laundering rule), §6.4 (final bullet), §9.1 (slug-redirect paragraph), §13 item 7, §17 (evidence cases), §19.3 test 7 |
| 7 | SSH preflight defects: `-G` alias claim, handshake authority, HostKeyAlias/known-hosts sources, remoteAddress unconstrained, ProxyCommand posture, orphan overclaim | §7 (`remoteAddress` loopback rule + config comment), §8.3 (ProxyCommand/`Match exec` as trusted operator config), §8.4 (lease design + honest orphan window), §8.5 (steps 2/4/5/6 reworked; handshake authoritative), §17 case 7 |
| 8 | Hard discovery intersection gated eligibility on flaky listings | §9 (eligibility = declared ∩ qualified; `discoveryStatus` as separate non-gating state), §17 (qualification/discovery cases) |
| 9 | Capability receipts under-fingerprinted | §9.2 (component-tuple fingerprint incl. digests, normalizer + prompt-envelope versions, TTL, named-component invalidation), §17 |
| 10 | Persistent raw SSH stderr by default | §8.6 (bounded redacted ring, structured events, raw only behind `STUDIO_TUNNEL_DEBUG=1`) |
| 11 | Missing exact URLs / source commit SHAs | Appendix A (URLs throughout; pinned SHAs `ece5d513fafc` and `ad905f8e6c8c`; unpinned retrievals stated as such) |
| 12 | Benchmark lacked repetition/statistics | §16.3 (bar evaluated on confidence bounds), **§16.5** (repetition floors, binomial intervals, flakiness metric, pinned decoding, no cherry-picking) |

First-slice file list (§19.2) and acceptance tests (§19.3) updated to match findings 3, 4, 5,
and 6.

## Change log — second audit round → this revision (v3)

| # | Finding | Revised where |
| --- | --- | --- |
| 1 | Provenance authority was grantable (config/UI could assert an evidence tier) | §6.1 (`lineage.source` derived, never configured; enum loses `endpoint_reported`), **§9.1** (`deriveLineageSource()` spelled out; tier table corrected; registry-contradiction refusal), §7 (config example carries declarations only), §11.2 (tier as read-only derived chip), §17 (provenance-derivation cases), §19.2 (`identity.mjs` scope), §19.3 test 11 |
| 2 | Pairing-v2/status-v2 not published as immutable schemas | **§10.8** (immutability rule stated once for both), **§10.8.1** (pairing v2 field-by-field with enums), **§10.8.2** (status v2 with `STATUS_DIMS_VERSION: 2` and the extended audit enum) |
| 3 | No complete cross-version validator matrix | **§10.8.4** (full accept/refuse table incl. future-version fail-closed rows and audit↔pairing cross-checks), §17 sealed-schema cases, §19.3 test 3 |
| 4 | No headline truth table | **§10.8.3** (complete verification × audit table over the v2 enums, legend, publication/P-rule and rehearsal-overlay rows, `allCombinations()`-pinned) |
| 5 | Rollback repaired only against `baseUrl`, not the shipped validator's full field list | §7 (dual-write enumerates every `validateCompatEntry` requirement; `CAMUS_NO_AUTH` placeholder for keyless entries), §19.3 test 4, §19.4 (rollback bullet re-corrected) |
| 6 | No migration defined for legacy private-HTTP endpoints | §7 (mechanical classification; grandfathered `legacy_http` kind with upgrade paths and sunset), §6.1 + §10.8.1 (transport enum), §15 (named SSRF exemption), §19.2, §19.3 test 5 |
| 7 | Unexpected model substitution only surfaced, did not fail closed | **§6.2** (expected-reported set; infra refusal before any draft/verdict; mapped-endpoint and silent-endpoint semantics), §9.1 (xAI slug-redirect paragraph rewritten fail-closed), §17 (protocol cases), §19.3 test 7 |
| 8 | No exact per-seat capability matrix | **§9.4** (required/n-a matrix across words_reviewer / words_maker / gate_reviewer / agent_maker with per-lane context envelopes), §17 (matrix enforcement case) |
| 9 | Qualification fingerprint incomplete | **§9.2** (versioned `qual1:` canonical component list 1–13 incl. seat type, auth mode, decoding knobs, mediating-executor version; TTL outside the hash), §17 (component-void cases extended) |
| 10 | SSH unknown-host test contradicted the advisory/authoritative preflight split | §17 case 1 (advisory miss shows the fix pre-spawn; the authoritative spawn is refused by OpenSSH; no retry; no known_hosts write) |
| 11 | Benchmark comparison/statistics unfinished | **§16.6** (measured-not-remembered baseline, paired McNemar comparisons, fixed denominators, per-transport admission, conservative tie-breaking), §16.3 unchanged bounds now composed with it |
| 12 | Abbreviated sources | §5 inline citations and Appendix A: every wildcard/ellipsized reference replaced with a complete clickable URL |

## Change log — third audit round → this revision (v4)

| # | Finding | Revised where |
| --- | --- | --- |
| 1 | Built-in vendor-managed Claude/Codex identities had no mechanical registry path (§6.5 promised `registry`, the derivation couldn't grant it) | **§9.1** (`deriveLineageSource` gains the vendor-managed branch: executor-keyed registry table, gated on the spawner's own no-redirect assertion, with the claude-env caveat named), §6.5 (built-ins bullet cites the path), §17 (both directions of the branch pinned), §19.2 (`checks/registry.json` carries the executor table) |
| 2 | qual1 fingerprint incomplete: no context-window probe status, no adapter/runtime version, no credential/account revision, no gate-review contract/scope | §6.1 (`contextWindow` gains three-state `status` + `demonstratedAt`), **§9.2** (components 14–16: adapter/runtime contract version; HMAC-salted opaque credential revision with the CLI-account `unknown` semantics; gate-review contract version + scope + tool set; probe *results* recorded in the payload), **§9.4** (gate_reviewer toolCalling scope-dependent; full-vs-light scope note; tuple gains gate scope), §17 (new void cases), §19.2 (`REVIEW-CONTRACT.md`, `checks/review.schema.json` version stamp) |
| 3 | McNemar/absence-of-significance admission rewards underpowered benchmarks | **§16.6** (paired one-sided 95% non-inferiority interval, lower bound > −δ, δ = 10 points; underpowering fails by construction), §16.3 (bar restated) |
| 4 | FPR ratio rule degenerate at zero-FPR baseline | **§16.6** (absolute margin: paired-difference upper bound ≤ +ε, ε = 5 points; ratio rule removed), §16.3 |
| 5 | Containment "zero breaches" had no denominator or confidence semantics | **§16.6** (fixed denominator = all mutation-phase runs; n ≥ 150 with rule-of-three upper bound stated in the receipt; one breach disqualifies the campaign; ≥98% conclusiveness floor for inconclusive receipts), §16.3 |
| 6 | Evidence-pack envelope versioning unresolved (envelope 2 with independently versioned interiors was ambiguous) | **§10.8.1** (envelope bumps to 3; envelope version determines interior versions exactly; audit-replay reader change named), **§10.8.4** (matrix re-keyed on the envelope), §19.2 (`evidence-pack.mjs`, `server.mjs` bullets), §19.4 (envelope-3 wording) |
| 7 | Concrete schema/README files unlisted | **§19.2**: `apps/loop-studio/checks/registry.json` (new), `packages/trust/SCHEMAS.md` (new, test-pinned register), `packages/trust/README.md` (pointer), `apps/loop-studio/README.md` (operator docs + rollback notes), `packages/cli/skills/camus/REVIEW-CONTRACT.md` (new, slice F), `apps/loop-studio/checks/review.schema.json` (version stamp, slice C) |
| 8 | CAMUS_NO_AUTH rollback claim overstated | §7 + §19.4 + §19.3 test 4 (guarantee restated two-tier: load isolation for all dual-written entries, functional parity for keyed only; keyless = named manual step; pre-set-variable case disclosed) |
| 9 | legacy_http "never newly declarable" unenforceable as stated | §7 (salted grandfather marker — HMAC over name‖url with the machine salt; validator refuses unverified markers; owner-forgery limit stated; receipts stamp `legacy_http` regardless), §6.1 (comment), §15 (wording), §19.3 test 5 (three marker shapes) |

## Change log — fourth audit round → this revision (v5)

| # | Finding | Revised where |
| --- | --- | --- |
| 1 | The claude built-in could seal `registry` while inheriting `ANTHROPIC_BASE_URL` (the shipped adapter passes no `env` — `apps/loop-studio/lib/adapters/claude.mjs:104`); a session caveat cannot repair a falsely sealed origin | **§9.1** (vendor-managed branch re-gated on `redirectIsolationProven` per executor: codex true today, claude false → capped at `operator_declared` until the spawn-isolation work and inherited-base-URL test land; flagship-standing consequence stated), §6.5, §17 (three-direction test incl. the deliberately-failing inherited-env case), §19.1/§19.2 (isolation work + fixture scheduled in slice A, `claude.mjs` in the file list), §19.3 test 12 |
| 2 | `legacy_http` HMAC marker contradicted in-memory migration — mint-at-load makes pasted entries indistinguishable from historical ones | **§7** (durable one-time boundary: first-launch snapshot to the `~/.camus/studio/grandfather.json` sidecar, config file never rewritten; post-snapshot legacy-shaped entries refuse; explicit recorded confirmation action as the only new-mint path; lifecycle and sunset defined), §19.2 (`models.mjs` bullet), §19.3 test 5 (four shapes + config byte-identity) |
| 3 | The envelope matrix dropped published evidence-pack v1, which the shipped validator reads (`packages/trust/lib/validate.mjs:80`); schema files unnamed | **§10.8.1** (envelopes 1 and 2 preserved as frozen readable shapes; concrete files named: `packages/trust/schemas/evidence-pack.v3.schema.json`, `pairing-manifest.v2.schema.json`, `status.v2.schema.json`; v3 artifact/receipt projection behavior specified — `artifact_id` stable across 2→3, `receipt_id` diverges by design; audit-replay old-source production exception made explicit here and in the §10.8 immutability rule), **§10.8.4** (matrix now accepts exactly 1/1/1, 2/1/1, 3/2/2), §19.2 (schema files, SCHEMAS.md scope), §19.3 test 2 (envelope-1 reader-compatibility pin) |
| 4 | Qualification was not bound to the run — sealed identity and gate binding omitted even `scope` (shipped `asGate()` at `packages/cli/workflows/camus-loop.workflow.js:435` compares six fields, none of them qualification) | **§10.8.1** (`qualification {fingerprint, gate_scope, contract_version}` sealed per seat; null only for vendor_managed built-ins), **§10.8.4** (presence + scope cross-checks), **§12.2** (request file/meta/binding/`asGate()` carry and compare scope, contract version, and `qual1` fingerprint; light mechanically cannot certify full — refused independently at binding and at seal), §10 closing (round events carry the reference through mechanical channels), §19.3 test 13 + later-slice additions (C and F) |
| 5 | Transport equivalence reintroduced the absence-of-significance error | **§16.6** (paired TOST equivalence: both one-sided 95% intervals within a predeclared ±δₜ, initial 3 points; underpowered comparisons fail transport admission), §19.3 later-slice additions (G: underpowered-fixture case) |

## Change log — fifth audit round → this revision (v6)

| # | Finding | Revised where |
| --- | --- | --- |
| P1-1 | Claude could not truthfully downgrade to `operator_declared` — that tier is a *human* declaration, and Camus supplied it; an unisolated route could serve anything | **§9.1** (unisolated claude derives `unknown`; two mechanical upgrades: explicit operator confirmation of the active route → genuine `operator_declared`, isolation + green test → `registry`; allowlist keeps direct-auth `ANTHROPIC_API_KEY`/OAuth and strips routing `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` per https://code.claude.com/docs/en/iam#authentication-precedence; consequence: unconfirmed flagship pairings seal *advisory*, sharper than v5 admitted), §6.5, §17 (four-direction test), §19.1/§19.2 (slip path = `unknown`), §19.3 test 12, Appendix A (IAM source) |
| P1-2 | Claimed stable `artifact_id` underspecified — the shipped projection hashes the envelope `schemaVersion` (`packages/trust/lib/canonical.mjs:90`) | **§10.8.1** (the 2→3 `artifact_id` divergence is *accepted*, with the reasoning: no consumer compares artifact identity across envelope versions because audit-replay seals in its source's envelope and comparison arms share one envelope; pinned by golden-stability tests *and* a deliberate cross-version inequality test) |
| P1-3 | Qualification internally inconsistent: vendor-managed codex gate reviewer allowed `qualification: null` while §9.4/§12.2 demand admission evidence; no independent scope field existed to compare against | **§10.8.1** (`qualification` always non-null; `builtin1:` contract-constant namespace for built-ins beside `qual1:` probe receipts; new `pairing.review_scope` sourced from the round's binding channel, independent of the qualification block), **§10.8.4** (namespace-matches-executor-class check; two-channel `review_scope` ↔ `gate_scope` comparison), §12.2 (workflow computes the codex `builtin1:` expectation from the installed skill — same comparison, no exemption), §9.4 (built-in note), §10 closing (two channels named), §19.3 test 13 |
| P2 | `grandfather.json` could silently recreate "first launch" if deleted or unwritten | **§7** (complete fail-closed contract: versioned schema; separate `grandfather.initialized` marker written after records so deletion is detectable; atomic temp+fsync+rename writes; with the marker present, missing/corrupt/wrong-version state refuses every `legacy_http` entry with per-entry confirmation as the only recovery — no bulk re-snapshot ever; `source` and `why` inside each record's HMAC), §19.3 test 14 |

## Change log — post-approval P2 clarifications → v6.1

| # | Finding | Revised where |
| --- | --- | --- |
| P2-1 | Sidecar crash recovery re-ran the inventory, so a deleted marker or an entry added in the crash window could reopen bulk grandfathering | **§7** (records-present-marker-absent = validate existing records + finish the marker, never a second inventory; the inventory runs only when neither artifact exists), §19.3 test 14 (entry added between records-write and restart remains refused) |
| P2-2 | `builtin1:` selected by executor kind — but a Codex custom-provider seat is also `codex_cli` | **§10.8.1** (eligibility = exact built-in backend + `vendor_managed` transport), **§10.8.4** (selection rule restated; both refusal directions), §12.2 ("accepted `qual1:` or `builtin1:` fingerprint"), §19.3 test 13 (`codex_cli` + loopback/direct_https/ssh_tunnel + `builtin1:` refuses) |

---

*End of RFC (v6.1). Architecture rounds remain closed. Implementation ledger as of
2026-08-24: A complete; B migration core complete; C complete; D complete. F's hermetic,
production-disabled implementation candidate is feature accepted for 0.4.4 and awaits Slice G
benchmark admission; E and G–I have not begun. Slice C has a hermetic end-to-end loopback acceptance test,
D has a hermetic managed-SSH security/lifecycle matrix, and F's fake HTTP/CLI suite proves its
mechanical contract without claiming provider quality. Live provider-backed validation remains
explicitly open under §19.7. The separately approved post-RFC execution plan adds a
[responsible control-plane feat](RESPONSIBLE-CONTROL-PLANE.md) after D and F; it consumes their
structured control evidence without rewriting this frozen contract.*
