# RESEARCH — Fable 5, the Advisor tool, Managed Agents & nested subagents

**Date:** 2026-06-09 · **Scope:** verify the June-2026 Anthropic release and decide what (if anything) Camus v2-lite should adopt.
**Method:** every factual claim below is sourced from a primary Anthropic page (anthropic.com / docs.claude.com / code.claude.com), fetched directly, not from the requester's paraphrase. Where a claim could **not** be verified against a primary source, it is flagged explicitly.

---

## TL;DR (decision-oriented)

1. **Fable 5 is real**, GA on June 9 2026, **$10/M in · $50/M out**. It **is usable from interactive Claude Code** (`/model fable`) and inside dynamic workflows — but **only free on subscription plans through June 22**; from **June 23** it requires usage credits (metered) until capacity allows it back into subscriptions. So for the cost-sensitive loop, Fable is a *temporary* free window, not a durable free substrate.
2. **The "advisor tool" is real, first-party, and shipped** (Claude Code v2.1.98+). It is a **server-side tool available to BOTH subscription and API-billed accounts** — i.e. it works under the interactive/subscription substrate, which is exactly the billing surface Camus lives on. This is the single most relevant finding.
3. **Managed Agents is real but it is an API/Claude-Platform hosted service** — it bills through the Claude Platform (metered), and the advisor/decoupling patterns it documents are the value, not the runtime. **Do not migrate the feat-runner onto it.**
4. **Nested subagents depth=5 is NOT confirmed in official docs.** The current published Claude Code docs still state plainly and repeatedly that *"Subagents cannot spawn other subagents."* The depth=5 claim traces only to a third-party blog (Digg) summarizing a Boris Cherny post and to community repos — **treat as unconfirmed / possibly experimental or unreleased.** Design as if flat (depth-1) subagents are the contract.
5. **Recommendation:** Adopt the **first-party advisor tool as an additive checkpoint *alongside* Codex, not instead of it.** Keep the hand-rolled interactive feat-runner (it is the cost moat). Borrow Managed-Agents *patterns* (brain/hands/session decoupling) only opportunistically. Do **not** build anything on nested subagents until it appears in docs.

---

## 1. Fable 5 / Mythos 5 — real, pricing, and where it runs

**Verified facts** ([anthropic.com/news/claude-fable-5-mythos-5](https://www.anthropic.com/news/claude-fable-5-mythos-5)):

- Launched **Jun 9 2026**. Fable 5 is a "Mythos-class" model (a tier **above Opus**), made safe for general use; Mythos 5 is the same weights with cyber safeguards lifted, restricted to Project Glasswing partners.
- **Pricing: $10 per million input tokens, $50 per million output tokens** (same for both). Fable 5 keeps the 90% prompt-cache input discount. For comparison: this is the **most expensive** model Anthropic offers GA — roughly 2× Opus on output.
- Fable 5 runs safety classifiers; flagged requests (cyber/bio/distillation) **auto-fall-back to Opus 4.8**. ~95% of sessions see no fallback. In Claude Code this fallback is automatic and surfaced in the transcript ([code.claude.com/docs/en/model-config](https://code.claude.com/docs/en/model-config) → "Automatic model fallback").

**Subscription vs API availability** (the cost crux), from the same news post's *Availability* section + the model-config doc:

- **API + consumption-based Enterprise: fully available, metered, today.**
- **Subscription (Pro/Max/Team/seat Enterprise): free Jun 9 → Jun 22 only.** On **Jun 23** Anthropic removes Fable from those plans; using it after that **requires usage credits** (= metered spend on top of subscription). They intend to restore it as a standard subscription model "as quickly as we can" but give no date.
- **Inside interactive Claude Code / dynamic workflows:** YES — Fable is selectable with `/model fable` or the `best` alias, requires Claude Code **v2.1.170+**, and is *not* the default on any plan ([model-config](https://code.claude.com/docs/en/model-config) → "Work with Fable 5"). On the API, Fable always runs with the 1M context window. Not available under zero-data-retention.

**Implication for Camus:** Fable is interactive-usable, but for a cost-anchored loop it is **not** a free substrate after Jun 22. The right posture is: keep Opus as the top tier of the router; treat Fable as an *optional, manually-triggered* escalation for genuinely long-horizon tasks during the free window, and re-evaluate after Jun 23 when the metering boundary bites. It is **not** a default-model candidate.

---

## 2. The advisor strategy — exact mechanism, and it works on subscription

This is the headline finding. The advisor is a **shipped, documented, first-party feature**, not a pattern.

**Primary source:** [code.claude.com/docs/en/advisor](https://code.claude.com/docs/en/advisor) ("Escalate hard decisions with the advisor tool"), plus the underlying server tool at [platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) and the strategy writeup at [claude.com/blog/the-advisor-strategy](https://claude.com/blog/the-advisor-strategy).

**Mechanism (verified):**

- A **weaker main model pairs with a stronger "advisor" model.** The main model **decides when to call** the advisor — typically *before committing to an approach, when an error keeps recurring, and before declaring a task done.* Timing is model-driven, not rule-based.
- The advisor **receives the full conversation** (every tool call + result), and **returns guidance the main model applies before continuing.** The main model generally follows it but will surface conflicts when its own evidence contradicts the advice rather than obeying blindly.
- It runs **server-side as an Anthropic server tool.**

**Billing — the decisive part (verified, quoted):**
> "The advisor runs server-side on Anthropic's infrastructure as a server tool, **available to both subscription and API-billed accounts.**"
> "On subscription plans, advisor usage counts toward your plan's usage limits." (vs API billing, where advisor tokens are charged at the advisor model's input/output rates.)

So **the advisor works under interactive Claude Code on a subscription** — it counts against your plan's usage limits (throttle-not-bill), it does **not** force you onto metered API credit. This is precisely Camus's billing surface.

**How a worker invokes it:**

- Config three ways: `/advisor <model>` (mid-session, saved as default), `advisorModel` in settings file, or `--advisor <model>` flag at launch. Setting `advisorModel: "opus"` in settings is the workflow-friendly path.
- The **main model auto-calls it** at decision points. You can also nudge it in the prompt: `consult the advisor before you continue`. **There is no setting to force or cap calls** — only prompt-level steering.
- **Accepted pairings** (advisor must be ≥ main model's tier): Sonnet main → Opus/Fable/Sonnet advisor; Opus main → Opus(≥version)/Fable advisor; Haiku main → can *call* but can't *be* an advisor; Fable main → Fable only. The **API enforces the pairing**, not the CLI.
- **Requirements/limits:** Claude Code **v2.1.98+**, **Anthropic API path only** (NOT Bedrock/Vertex/Foundry). Experimental — "behavior, pricing, and availability may change." Disable with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`.

**Cost shape:** each advisor call reprocesses the full transcript at the advisor model's rate (advisor read is **not** cached). Because it fires at decision points, not every turn, "Sonnet main + Opus advisor" typically costs less than running Opus throughout.

**How it compares to existing levers** (from the advisor doc's own table): advisor = stronger model *at decision points, Claude-triggered*; `opusplan` = stronger model *during plan mode only*; subagent-with-model = stronger model *for the whole delegated subtask*; `/model` = stronger model *for all subsequent turns*.

---

## 3. Claude Managed Agents — what it is, and how it bills

**Primary source:** [anthropic.com/engineering/managed-agents](https://www.anthropic.com/engineering/managed-agents) ("Scaling Managed Agents: Decoupling the brain from the hands", published Apr 8 2026) + docs at [platform.claude.com/docs/en/managed-agents/overview](https://platform.claude.com/docs/en/managed-agents/overview).

**What it is:** a **hosted "meta-harness" on the Claude Platform** for long-horizon agent work. It virtualizes an agent into three swappable interfaces:
- **session** — an append-only durable event log that lives *outside* Claude's context window; queried via `getEvents()` positional slices. (Their answer to compaction's irreversibility problem.)
- **harness** ("brain") — the loop calling Claude; now stateless/"cattle", reboot via `wake(sessionId)` + replay the session log.
- **sandbox** ("hands") — execution env, called as a tool `execute(name,input)→string`; container failure becomes a recoverable tool-call error.
Plus: credential vault outside the sandbox (tokens never reachable from Claude's generated code), per-tool permissions, full audit log in the Claude Console, p50 TTFT down ~60% from decoupling, and **auto-spill of >100K-token tool outputs to a sandbox file** with a truncated preview.

**Billing (the crux):** Managed Agents is a **Claude Platform / API product** — "a hosted service in the Claude Platform," with audit logs "in the Claude Console," set up via the platform docs. The page never positions it as a subscription/interactive feature; it is a **metered platform service.** Treat it as **API-billed.** (The page does not publish a price line; the unconfirmed point is only the exact rate, not the billing surface.)

**Implication:** Managed Agents solves *Anthropic's* problem of shipping a durable harness as a product. It is the **wrong runtime for Camus's cost model** — moving the loop onto it means metered spend, which is the thing the project explicitly avoids. Its *ideas* (session-log-as-external-context, brain/hands decoupling, output-spill) are worth borrowing into the hand-rolled feat-runner; its *runtime* is not.

---

## 4. Nested subagents depth=5 — UNCONFIRMED

**What I could verify:** the **official Claude Code subagents doc** ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)) — fetched in full — states the opposite of the depth=5 claim, in three separate places:
> "This prevents infinite nesting (**subagents cannot spawn other subagents**)…"
> "**Subagents cannot spawn other subagents**, so `Agent(agent_type)` has no effect in subagent definitions."
> "**Subagents cannot spawn other subagents.** If your workflow requires nested delegation, use Skills or chain subagents from the main conversation."
> "A fork cannot spawn further forks."

**What I could NOT verify:** the "nested subagents, depth=5, landed Jun 9 2026" claim appears **only** in a third-party Digg article summarizing a Boris Cherny post and in community repos (e.g. `gruckion/nested-subagent`, a `ruvnet/ruflo` issue). **No anthropic.com / code.claude.com page confirms it.** It is plausibly real-but-experimental (the published docs lag, and forks/agent-teams gate behind env vars like `CLAUDE_CODE_FORK_SUBAGENT` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), but **I will not assert it as fact.**

**Constraint for a feat→loop→reviewer/implementer (~3 deep) nesting:** under the *documented* contract, you **cannot** nest subagents at all — the main session spawns subagents, and those are leaf nodes. The documented ways to get multi-level structure are: (a) **chain** subagents from the main conversation, (b) **Skills** (run in main context), (c) **agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, each teammate independent context), or (d) **forks** (inherit full context, but a fork can't fork). Camus's current shape — a **workflow** (`camus-feat` → `camus-loop`) that calls **phase agents** (classify/plan/implement/review-runner/verify-runner) — is workflow-orchestrated, not subagent-nested, so **it is unaffected by the subagent depth limit either way.** If depth=5 does ship, it would let a phase agent (e.g. implementer) spawn its own helper without returning to the orchestrator — a nice-to-have, not a blocker. **Do not design on it yet.**

---

## 5. Analysis for Camus

### Current architecture (ground truth, from `camus/workflows/camus-loop.workflow.js`)

`Classify → Plan → Implement → (Codex-review ↔ Fix)* → Verify`, with:
- **Tier router** (cheap Haiku classify pass): `{ trivial: 'sonnet', standard: 'opus', complex: 'opus' }` picks the **think model**.
- **Runners** (review-runner, verify-runner) are **Haiku** — they only exec a script and echo JSON; *judgment lives in Codex (review) and `verify.sh` exit code.*
- **Codex (gpt-5.x)** is the **strict external reviewer**, normalized to a gate contract (`findings[]` P0–P3 + verdict) via `adapter.py`. `ROUND_CAP=3` review↔fix rounds.

So Camus **already implements the advisor *strategy*** — cheap implementer, stronger judgment at the gate — but its "stronger judge" is **cross-vendor Codex**, invoked **deterministically at a fixed phase** (always, after implement), not model-triggered mid-task.

### (a) Advisor vs Codex-reviewer + planned reviewer-persistence escalation

These are **complementary, not competing**, because they sit at different points and answer different questions:

| Axis | Codex reviewer (have) | First-party advisor (new) |
|---|---|---|
| Vendor | Cross-vendor (gpt-5.x) — independent failure modes, true second opinion | Same-vendor (Opus/Fable) |
| Trigger | **Deterministic**: every loop, post-implement | **Model-triggered**: mid-task, at decision points |
| Question | "Is this diff correct/safe? P0–P3 verdict." (grades the *result*) | "Is my *plan/approach* right before I commit / before I declare done?" (steers the *process*) |
| Billing | OpenAI API (metered, separate budget) | **Subscription usage limits** (throttle-not-bill) — stays on the interactive substrate |
| Determinism | Hard gate, machine-parseable, freezable | Soft guidance, model may override |

**Recommendation: add the advisor as an *additive pre-gate checkpoint alongside* Codex, not instead of it.** Concretely:

- Keep **Codex as the authoritative result-gate** — it is the cross-vendor independence that makes the loop honest, and it's a hard, freezable contract. The advisor is **same-vendor** and **non-deterministic** (model decides timing, can override guidance), so it cannot replace a strict gate. Replacing Codex with a same-vendor advisor would *lose* the project's core safety property.
- **Add an advisor for the implementer's *planning* phase**, where Codex doesn't operate: set `advisorModel: "opus"` (or `fable` during the free window) when the **think model is Sonnet** (the trivial tier). This is the documented sweet spot ("Sonnet main + Opus advisor… escalates planning, ambiguous failures, and completion checks to Opus") and it stays on subscription billing. It directly strengthens the *plan* step — historically a thrash point (cf. F6 planner-thrash, NC-397) — **without** adding metered spend.
- This also gives a **cheaper path to the "reviewer-persistence model escalation"** idea: instead of (or before) bumping the whole think model to Opus on a hard task, let a Sonnet implementer **consult an Opus advisor at the stuck point.** The advisor fires only at decision points, so it's cheaper than escalating every turn — and the tier router can stay as-is, with the advisor as a finer-grained, intra-tier escalation lever. Note the gap: **there's no API to *force/cap* advisor calls**, only prompt steering — so it's a "lean on it" lever, not a deterministic one. The deterministic escalation (router bumping Sonnet→Opus) should remain the backstop.
- **One caveat to log:** the advisor is **Anthropic-API-path only** (not Bedrock/Vertex/Foundry) and **experimental**. If the interactive Claude Code session is on the standard Anthropic path (it is), this is fine; if the substrate ever routes through a gateway, verify advisor passthrough.

### (b) Build-vs-adopt: does Managed Agents obsolete the feat-runner?

**No. Keep the hand-rolled interactive feat-runner; borrow patterns, not the runtime.**

- The **entire cost thesis of Camus is the interactive/subscription substrate** (throttle-not-bill before the Jun-15 metering boundary). **Managed Agents is a metered Claude Platform service.** Migrating the feat-runner onto it would convert the loop's spend from "subscription usage limits" to "API credit" — i.e. it would *cause* the exact failure mode ("don't die by costs") the project is built to avoid. That alone settles it.
- The feat-runner's value is **the standard that keeps it honest** (Codex gate, verify exit-code, freeze-checked install, infra-vs-findings guard) — none of that is what Managed Agents provides; MA provides *durable session/sandbox plumbing*, which Camus already approximates with git worktrees + a `job_runs`-style ledger + the v2-lite skill contract.
- **What to borrow from Managed Agents (patterns only):**
  - *Session-log-as-external-context* (`getEvents()` slicing): Camus already leans on durable artifacts/journals; the MA framing ("context is an object you slice, not a window you compact") is a good north star for the v2-lite journal design — keep raw events recoverable rather than compacting irreversibly.
  - *Output-spill of >100K-token tool results to a file with a truncated preview*: cheap, high-value to replicate in the loop's runners so a huge test log never blows the context window.
  - *Brain/hands decoupling + credential-vault-outside-sandbox*: aligns with the existing auto-mode egress-classifier posture; reinforces "tokens/secrets never reachable from generated code."

**Bottom line:** the **substrate stays hand-rolled and interactive** (cost moat); the **advisor tool is the one first-party feature worth wiring in now** because it's the rare new capability that runs *on subscription billing* and maps cleanly onto Camus's "cheap implementer + strong judgment" thesis — as an **additive planning/stuck-point checkpoint** that complements, and never replaces, the cross-vendor Codex gate. Fable is a manual-escalation option during the free window only. Nested subagents are not yet a thing to build on.

---

## Sources

- Fable 5 / Mythos 5 announcement + pricing + subscription rollout: https://www.anthropic.com/news/claude-fable-5-mythos-5
- Claude Code model configuration (Fable in CC, automatic fallback, aliases, defaults): https://code.claude.com/docs/en/model-config
- Advisor tool (mechanism, billing, pairings, requirements, comparison table): https://code.claude.com/docs/en/advisor
- Advisor server tool (API-level usage/billing): https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Advisor strategy writeup: https://claude.com/blog/the-advisor-strategy
- Managed Agents engineering post (decoupling brain/hands, session log, billing surface): https://www.anthropic.com/engineering/managed-agents
- Managed Agents docs: https://platform.claude.com/docs/en/managed-agents/overview
- Subagents doc (confirms "subagents cannot spawn other subagents"; forks; agent teams): https://code.claude.com/docs/en/sub-agents
- Nested-subagents depth=5 claim — UNCONFIRMED by any Anthropic page; only third-party: https://digg.com/ai/megudrsi and community repo https://github.com/gruckion/nested-subagent
