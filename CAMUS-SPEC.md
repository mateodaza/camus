# Camus v2 — Design Spec

**Status:** Draft for review · **Date:** 2026-06-08 · **Author:** Mateo (+ research pass)
**Supersedes:** v1 bash orchestrator (HEAD `b366cf7`), now retired to portfolio/OSS reference.

---

## TL;DR

v2 is **not a rebuilt orchestrator**. It's a *port of v1's proven judgment layer onto first-party primitives* that did not exist when v1 was designed. The loop, the dispatch, the context isolation, the parallelism — all commodity now, shipped natively in Claude Code as **dynamic workflows**. The only things still worth owning are the parts that were ever really yours: your rules, your reviewer rubric, your verification standard, and your budget discipline.

v2 ships in **two tiers — do not conflate them** (this was v1's scope-creep risk):

- **v2-lite** — a personal slash command (`/camus <task>`): a saved dynamic workflow + skill that runs discovery→plan→implement→review→verify on **one task**, with a cross-vendor (Codex) reviewer gating on P0/P1/P2 and a deterministic verifier. **~1 day.**
- **v2-overnight** — adds back v1's executor contracts: task-queue selection, dependency handling, clean-worktree/baseline checks, post-commit verification, lock/crash recovery, reports, escalation. **Materially larger.** Promote only the v1 contracts that still earn their place.

**Build v2-lite first.** If it beats plain `/goal` + skill on one real task, then — and only then — add the v2-overnight contracts that still matter.

Cost is **bounded by plan limits, credits, and caps — not structurally impossible to overspend** (see §5). On the subscription run-targets the Claude side is throttle-not-bill; on the metered target it draws real credit, and Codex can bill on its own side.

---

## 1. Why this is a port, not a rebuild

Three things changed between 2026-05-14 (v1 shelved) and now:

1. **The pricing cliff (June 15, 2026).** Headless `claude -p` / Agent SDK usage moves off the subscription onto a separate metered credit pool ($20 Pro / $100 Max 5x / $200 Max 20x, full API rates, no rollover, per-user, opt-in). *Interactive* Claude Code (terminal/IDE/desktop) is explicitly unaffected and keeps drawing from subscription limits. v1's entire design — headless, unattended, SDK-driven — is the single worst-hit profile. ([source](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))

2. **The loop got commoditized.** Codex `/goal` (Apr 30, 2026) ships "loop until self-evaluated complete" as a primitive. The orchestrator+subagent fleet is now standard across every major harness. The autonomous loop — the core of Nightcrawler v1 — is no longer a differentiator.

3. **Anthropic shipped your architecture.** Dynamic workflows (Thariq Shihipar, Jun 2, 2026) let Claude *write its own harness* as a JS script: loop-until-done, adversarial verification, per-agent model routing, worktree isolation, token budgets, save-as-skill. They name v1's exact failure modes (agentic laziness, self-preferential bias, goal drift) and explicitly call *"static workflows using the Claude Agent SDK or `claude -p`"* the superseded approach. ([docs](https://code.claude.com/docs/en/workflows) · [thread](https://x.com/trq212/status/2061907337154367865))

**What the research vindicated about v1** (keep these convictions): deterministic verifiers beat LLM-judge selection (the "verification gap" widens with sampling); bounded loops (3–7 turns) beat unbounded exploration on cost *and* reliability; cross-vendor audit reduces self-preference bias. v1's closed-loop bet was correct — the field caught up and proved it.

---

## 2. Architecture

Three layers + an independent reviewer. The split mirrors the Claude Code primitive boundaries exactly.

```
┌─────────────────────────────────────────────────────────────┐
│  SKILL  (the standard — yours, portable, durable)            │
│  • discovery/plan/impl/review/verify rules                   │
│  • Codex reviewer rubric + severity definitions (P0/P1/P2)   │
│  • project conventions (per-repo), audit-persona             │
│  • bundles the workflow template (JS) per Thariq's pattern   │
└─────────────────────────────────────────────────────────────┘
                          │ invoked as /camus <task>
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  DYNAMIC WORKFLOW  (the engine — first-party, not yours)     │
│  JS script that holds the loop / branching / state:          │
│   plan → implement → [review → fix]* → verify                │
│  • spawns Claude subagents (≤16 concurrent, ≤1000/run cap)   │
│  • routes models per stage (Haiku bulk, Sonnet plan, Opus    │
│    only where a classifier says warranted)                   │
│  • holds the P0/P1/P2 gate + round cap + soft token target   │
└─────────────────────────────────────────────────────────────┘
                          │ spawns a thin reviewer subagent
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  CODEX REVIEWER  (the independent standard-keeper)           │
│  reviewer subagent runs:  codex exec --output-schema sev.json│
│  → returns priority-tagged JSON (priority 0–3 + verdict)     │
│  • cross-vendor → sidesteps self-preference bias             │
│  • billed on OpenAI side (separate bucket, see §5)           │
└─────────────────────────────────────────────────────────────┘
                          │ verification gate (deterministic)
                          ▼
      verifier agent runs: pnpm type-check + pnpm test → JSON (free, bash)
```

**Why the split is correct:** A skill is *standing instructions* loaded once into context — it cannot own a durable loop or exit condition (it isn't re-read on later turns and can be dropped after compaction). The loop, the iteration counter, and the exit gate **must** live in the engine (the workflow script). So: skill = the playbook; workflow = the engine; Codex = the judge; tests = the ground truth. ([skills docs](https://code.claude.com/docs/en/skills))

---

## 3. The single-task loop

One task through the closed loop, mapped to dynamic-workflow patterns:

| Stage | Pattern (Thariq) | Model | Exit / gate |
|---|---|---|---|
| Discovery | classify-and-act | Sonnet (or classifier routes) | context gathered |
| Plan | draft-from-angles (optional) | Sonnet | plan approved |
| Implement | fan-out per change in worktrees | Haiku (bulk) | changes produced |
| Review | adversarial verification | **Codex** (`codex exec`) | findings returned |
| Gate | — | script logic | `priority<=2` set is empty |
| Fix | targeted retry | Haiku/Sonnet | re-review |
| Verify | deterministic | bash | `type-check + test` pass |

**Loop rule:** `while (findings with priority<=2 exist) AND (rounds < CAP): spawn fix agent → spawn fresh Codex reviewer`. On `rounds == CAP`, stop and surface remaining P2s to the human. Never loop on a P3/nit.

**Execution model (important — the workflow JS cannot touch shell or files):** per the docs, *agents* read/write/run commands; the *script* only coordinates and holds state in variables. So every gate is: a reviewer/verifier **agent** runs the command (`codex exec`, `jq`, `pnpm`) and returns **strict JSON**; the workflow JS evaluates that JSON and decides the next branch. The JS never runs `jq` or `pnpm` itself.

**Bounding is non-negotiable** (research: performance peaks at 3–7 turns then degrades from context pollution). Hard `CAP` on review/fix rounds; a per-task **soft token target / context budget** (model-respected, not runtime-enforced); the runtime's built-in 16-concurrent / 1000-total agent caps as the outer (enforced) backstop.

---

## 4. Cost model

Per-task estimates. **Auditable only with the assumptions below** — these are illustrative, not measured; replace with real `/workflows` token counts before trusting them.

**Formula:** `cost = Σ_agents [ in·(1−cached)·P_in + in·cached·P_in·0.10 + out·P_out ]`, cached input billed at 10% of base.
**Prices (per M tok, in/out, June-2026 aggregator-sourced, verify):** Opus 5/25 · Sonnet 3/15 · Haiku 1/5 · Codex(GPT-5) 1.25/10.
**Mesh agent assumptions:** planner Sonnet 45k/4k @30% cached · implementer Haiku 220k/18k @75% · Codex reviewer 45k/3k @0% · 2nd reviewer Sonnet 45k/3k @50% · fix Haiku 95k/8k @60% · Codex re-review 40k/2k @0%.

| Scenario | $/task | Nights/mo on $100 / $200 |
|---|---|---|
| **Bounded multi-model mesh** (Haiku impl + Codex review, 1 round) | **$0.68** | — |
| Premium (all-Opus, 5-verifier panel, 2 fix rounds) | $6.65 | — |
| Runaway mesh, 8 loops, no cap | $1.68 | — |

The **per-task** figure is the unit that matters for v2-lite. Throughput (e.g. 8 tasks/night → $5.43 mesh, ~18–37 nights on the credit) is a **v2-overnight** concern and only meaningful once that tier exists.

**Key insight:** loop *count* is cheap (caching keeps repeated context near-free — 8 uncapped loops = $1.68). The thing that kills you is **width × Opus**: fan-out panels of 5 verifiers on the top model is a 10× swing from the same idea run lean. Live in the $0.68 row: Haiku/Sonnet for bulk, Opus only when a classifier flags it, no standing verifier panels on routine tasks.

> Note: these dollar figures only apply on the **metered** run-target (§6, option C). On the subscription-backed targets (A/B) the Claude side is throttle-not-bill — see §5.

---

## 5. Cost-survival design (bounded spend, not impossible spend)

Spend is bounded by limits/credits/caps — not structurally impossible. Three layers, in order of how hard the guarantee is:

1. **Subscription path = throttle-not-bill (hard, but only on targets A/B).** If the loop runs in *interactive* Claude Code (terminal TUI or desktop, including dynamic workflows + the subagents they spawn), it draws from your Max subscription, unaffected by June 15. Worst case is exhausting Max rate limits and pausing until reset — not a bill. **Exception:** the metered pool triggers via `claude -p` / SDK / GitHub Actions (run-target C), where you *can* drain the monthly Agent SDK credit and then usage credits if enabled. ([source](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))

2. **Enforced runtime caps + your own gates (this is the real guarantee).** The documented, runtime-*enforced* limits are **≤16 concurrent and ≤1,000 total agents per run** ("Prevents runaway loops"). Everything else is your discipline: a hard **review/fix round CAP**, a **max diff/context size**, **model routing** (Haiku bulk, Opus only when flagged), and live `/workflows` token monitoring with manual stop. ⚠️ The `"use 10k tokens"` budget from Thariq's thread is a **prompt-level soft cap the model is asked to respect, not a documented runtime kill-switch** — do not rely on it as the guarantee. ([workflows docs](https://code.claude.com/docs/en/workflows))

3. **Codex is a separate, independent bucket.** The reviewer runs on OpenAI billing — either your ChatGPT plan (rate-limited, ~one local message per review, no marginal $; for GPT-5.3-Codex ~600–3,000 local messages per 5-hour window) or an API key (~$0.05–0.10/review). No OpenAI equivalent of the June 15 split exists. So review pressure hits OpenAI's limits while implementation hits Anthropic's — **neither provider carries the whole loop.** ([Codex pricing](https://developers.openai.com/codex/pricing) · [Codex w/ ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan))

---

## 6. Run targets

The metering boundary is **interactive vs `claude -p`/SDK** — *not* GUI-vs-headless, *not* local-vs-remote. All three options below are viable; choose per session.

### A. Mac, session open + `caffeinate`
- **How:** run the workflow in the open desktop app / terminal; `caffeinate` so the Mac doesn't sleep.
- **Billing:** subscription (throttle-not-bill).
- **Pros:** simplest. **Cons:** tied to your machine being on; quitting Claude Code mid-run restarts the workflow fresh (resume only works within the same session).

### B. VPS, interactive `claude` TUI in `tmux` over SSH
- **How:** run the interactive `claude` TUI inside a tmux session on the VPS (89.167.81.3), authenticated with your Claude subscription login. No GUI required — the TUI runs headless-over-SSH and is still "interactive Claude Code in the terminal."
- **Billing:** subscription (throttle-not-bill), always-on, no Mac to babysit.
- **Pros:** the "leave it running" sweet spot — server uptime, interactive billing. **Cons / VERIFY:** confirm subscription auth is permitted on a server under ToS, and that a long unattended interactive session is within acceptable use. (The tmux/TUI mechanics are solid; the auth-on-server policy is the open item.)

### C. VPS, `claude -p` / Agent SDK headless
- **How:** scripted, cron-able, fully unattended.
- **Billing:** **metered** ($100/$200 credit at API rates, then stops or falls to API).
- **Pros:** true automation, no session to keep alive. **Cons:** real dollars (the §4 table applies); this is the explicitly-deprecated static-workflow pattern. Use only if you exceed interactive rate limits or need pure unattended scheduling.

**Constant across all three:** sandbox the agent in a container/worktree even when self-hosting — the one non-negotiable for unattended execution. Codex billing (§5.3) is independent of the run-target.

---

## 7. Carry over from v1 / drop from v1

**Carry over (the durable judgment layer):**
- Cross-vendor Codex audit + the audit-persona doc (now a skill section / reviewer rubric).
- Verification gate (`type-check + test`) as the deterministic ground truth.
- Bounded loop with a hard round cap (v1's max-turns instinct; research-vindicated).
- Budget discipline (now a soft token target + enforced agent caps instead of a bash `--codex-cap`).
- Severity gating — formalized as P0/P1/P2 (Codex emits priority 0–3 natively).
- Retry-on-plan-LOCK lesson (NC-433): retry before skipping.

**Drop (now commodity or dead):**
- The ~2,500-line bash orchestrator / dispatch / main loop.
- `PROMPT_COUNT` and the free-Sonnet-on-Max assumption.
- Headless `claude -p` as the default execution mode (becomes opt-in, target C only).
- Picker/planner/implementer/reviewer as separate bash-shelled stages — replaced by workflow subagents.
- Ghost-commit guard / queue mutation machinery — re-expressed (if still needed) as workflow script logic, not bash.

---

## 8. Reviewer gate — design details

- **Schema:** `codex exec "review the diff" --output-schema sev.json`. The schema's `findings[]` carry `priority` (0–3), `confidence_score`, `title`, `body`, `code_location`, plus a top-level `overall_correctness` enum. ([OpenAI cookbook](https://cookbook.openai.com/examples/codex/build_code_review_with_codex_sdk))
- **Gate predicate (evaluated by the workflow JS, not by shell):** the reviewer *agent* runs `codex exec` + `jq` and returns strict JSON like `{ "clean": false, "blocking": [{priority, title, code_location}, ...] }`; the workflow JS reads `clean` (≡ no `priority<=2`) and branches. Likewise the verifier agent runs `pnpm type-check && pnpm test` and returns `{ "pass": bool, "failures": [...] }`.
- **Keep the reviewer subagent thin** — its only job is to run `codex exec` and return the JSON. Do not let Claude re-judge Codex's verdict, or you lose the cross-vendor independence that's the whole point.
- **Migration, not reuse.** v1's Codex contract is `APPROVED`/`REJECTED` + `blocking_issues` (`scripts/call_codex.py`). The priority-0–3 schema is a *new* contract — write **adapter tests** mapping old→new before trusting it. Local `codex` is installed and supports `--output-schema`; local `claude` is **not on PATH** → Claude CLI setup is its own build milestone (see §11).
- **Infra-vs-findings guard (the #1 runaway cause):** a Codex rate-limit / auth blip / crash must be branched as "reviewer failed to run" — *never* read as "not clean." Retry the reviewer with backoff; do not feed a transient error back into the fix loop.
- **Reviewer independence:** spawn a *fresh* Codex session per round (not `resume`) so it re-raises issues it might otherwise decline to repeat.
- **Severity inflation guard:** hard round CAP; run the final audit exactly once; defer leftover P2s to the human rather than looping until the reviewer "feels" clean.

---

## 9. File layout (as shipped — see `camus/README.md` for the authoritative tree)

```
~/.claude/                         # installed via camus/install.sh (copy, not symlink)
  skills/
    camus/
      SKILL.md            # playbook: severity model, hard rules, run surface
      sev.schema.json     # Codex output schema (priority 0–3 + verdict)
      review-prompt.md    # cross-vendor audit persona + completeness check
      scripts/            # 5 gate scripts + _guard.sh + adapter + preflight tools
  workflows/
    camus-loop.workflow.js   # single task: the closed loop
    camus-feat.workflow.js   # M1 feat runner (calls camus-loop per task)
~/.camus/                          # run state: feats/, reports/, reviews/ (audit trail)
```
- Invoke as `/camus-loop <task>` or `/camus-feat` with a task list via `args`.
- Express portable conventions in `AGENTS.md` / `SKILL.md` so they survive a harness swap.

---

## 10. Open questions — verify before building

1. **Dynamic workflows version/surface.** Research preview; needs Claude Code **v2.1.154+**. Confirm your desktop app on Mac actually exposes workflows, or plan to drive them from the Claude Code CLI alongside the app.
2. **Interactive metering boundary (load-bearing).** Confirmed in docs that interactive Claude Code (incl. workflow-spawned subagents) rides the subscription. Re-confirm this still holds after June 15 once live — it's the hinge the whole cost-survival case rests on.
3. **Subscription auth on a VPS (target B).** Verify running the interactive TUI authenticated with a Claude subscription on a server is permitted under ToS and works in practice in tmux.
4. **Codex auth choice.** Decide ChatGPT-plan login (rate-limited, no marginal $) vs API key (per-token, ~cents, but loses cloud features) for the reviewer.
5. **Prices drift.** All §4 dollar figures are aggregator-sourced; confirm current model names + per-token rates at runtime before hard-coding.

---

## 11. Build milestones

**Hard gates (do these before any workflow engineering — if one fails, the plan changes):**

- **G1 — Workflows available on your setup.** Confirm the Mac desktop app (or CLI) exposes dynamic workflows at v2.1.154+. If not, target C only.
- **G2 — Interactive-subscription boundary holds post-June-15.** Re-confirm interactive runs (incl. workflow subagents) stay on the subscription. This is the load-bearing assumption for targets A/B.
- **G3 — Target B auth (highest operational risk).** Verify a Claude *subscription* login driving the interactive TUI on the VPS is permitted under ToS and works in tmux. **Do not build target-B tooling until G3 passes.**
- **G4 — Claude CLI on PATH.** Local `claude` is not currently on PATH; install + auth it. (`codex` is already installed.)

**v2-lite (the ~1-day product — build first):**

1. **Write the skill** — phases, rules, reviewer rubric, P0/P1/P2 definitions, audit persona. The durable IP; spend the time here.
2. **Adapter tests for Codex** — map v1's `APPROVED/REJECTED + blocking_issues` to the new priority-0–3 schema; test on a known-buggy diff.
3. **Draft the workflow** — `ultracode`-generate the plan→impl→[review→fix]*→verify script on one real task (e.g. camello sales-agent denest); inspect the JS; add the round CAP, max diff/context size, model routing, the JSON-returning reviewer/verifier agents, and the infra-vs-findings guard.
4. **Run on one task**, watch `/workflows` token usage, tune routing toward the $0.68 row.
5. **Save as `/camus`**, pick a run-target per §6.
6. **Decision gate:** does v2-lite beat plain `/goal` + skill on one real task? If no, stop — the skill alone is the product.

**v2-overnight (only if v2-lite earns it):**

7. Add back, one at a time and only if it still matters: queue selection, dependency handling, clean-worktree/baseline checks, post-commit verification, lock/crash recovery, reports, escalation. Each is a v1 contract (`RULES.md`, `SPEC.md`, `config/budget.yaml`) — port the *contract*, not the bash.

---

## 12. Trusted-run safety posture (auto mode is the shell, not the brakes)

Auto mode (classifier-gated, the safe alternative to `bypassPermissions`) is the right
execution mode for unattended runs — it removes approval friction. It does **not** replace
the loop's gates. Keep both.

**Mode by phase:**
- Building / inspecting the generated workflow → `default` or `acceptEdits`. Keep clicking.
- Trusted unattended run → `auto` mode **plus the installed narrow profile**. The source of
  truth is `install.sh --auto-setup` (which runs `merge_settings.py`): one egress-trust line
  for the Codex review diff plus allow rules for exactly the **5 gate scripts**
  (`codex_review.sh`, `verify.sh`, `prep.sh`, `commit.sh`, `env_check.py`) in literal-`$HOME`
  and expanded forms — no broad `Bash(*)` rules, `$defaults` preserved. Do not hand-author
  this profile from the spec. Never use `bypassPermissions` on a real repo (no injection
  protection).

**The wrapper-trust rule (non-obvious):** allowing `Bash(...codex_review.sh)` trusts that
*script wholesale* — the classifier sees the shell tool call, not the subprocess intents
inside it. Therefore the runner must be **frozen / known-good before a run**:
- Gate scripts live at `~/.claude/skills/` (installed, option 2) — *outside* the worktree —
  so implement/fix agents cannot edit the reviewer/verifier that judges them mid-run.
- Before a trusted run, verify the installed scripts match the reviewed versions
  (`install.sh --check` diffs the whole installed skill + both workflows against source).
  "Frozen" must be checkable, not assumed.

**Hard boundaries (state in conversation and/or as deny rules):** no push, no deploy, no
package install unless explicitly needed, no editing the Camus runner scripts during
a run, clean worktree required at start. (Conversation boundaries are re-read each check and
can be lost to context compaction — for a hard guarantee use a deny rule.)

**Caps still bind, independent of auto mode:** stop at ROUND_CAP, verifier failure, reviewer
infra failure after the retry limit, or dirty/unknown runtime files. Auto mode's own fallback
(pause after 3-in-a-row or 20 total classifier blocks; abort under `-p`) is a backstop, not
the brake.

**Config nuance:** `defaultMode: "auto"` is ignored from project/local settings — set it in
`~/.claude/settings.json` (user) only. When customizing auto-mode trusted-infra rules,
preserve the built-in defaults (see the auto-mode-config docs for the exact token before
editing — do not hand-author from memory).

---

## 13. Security posture (independent audit, 2026-06-08)

**Rating for the intended threat model (solo dev, own repo): moderate–good.** The structural
defenses are real: the gate code lives *outside* the worktree (code under review can't tamper
with its own verifier), the infra-vs-findings adapter fails closed, the verdict is cross-vendor,
deterministic verify is the non-negotiable final gate, and shell-outs use argv lists (no
`shell=True`) with quoted paths — no gratuitous injection bug.

**Fixed in this pass:** F3 — the workflow now rejects an implement-agent worktree path that
doesn't end with the script-computed canonical name (closes a path-controlled-exec primitive);
F9 — `verify.py` bounds each check with a timeout (`CAMUS_VERIFY_TIMEOUT`, default 600s).

**Inherent, accepted risks for trusted-code use (not bugs — consequences of autonomy):**
- **The verifier runs the repo's own build/test commands** (`npm test`, `cargo test` build
  scripts, etc.) → arbitrary code execution *by design*, outside any sandbox, with the user's
  full env. Acceptable for your own code; the autonomous loop widens the window because an
  in-repo prompt injection could make an agent *write* a malicious script that then auto-runs.
- **Prompt injection** from repo contents can steer the implement/fix agents. It **cannot**
  forge the verdict (cross-vendor review + deterministic verify both stand in the way), but it
  can steer agent *actions*.
- **The thin-runner boundary is an LLM**, not code: the review/verify verdict relies on a Haiku
  agent faithfully relaying a subprocess's stdout. `asGate`/`asVerify` fail closed on garbage,
  but a *hallucinated* `{"pass":true}` would be believed. Weakest structural link; mitigated by
  cheap-model + narrow prompt + shape checks, not eliminated.
- **Data egress:** the diff (and any secrets staged in it) goes to OpenAI each review round.

**"Isolated worktree" means source-tree isolation, NOT execution sandboxing.** Don't over-trust
the word. Recommended follow-ups: pre-review secret hygiene + egress note (F5), `mktemp` the
Codex stderr log (F6).

**Hard boundary:** this is a **trusted-code tool**. Do not run it on untrusted repos, and do not
run it as root on the VPS. Untrusted code needs a real execution sandbox (container/VM, no host
FS beyond the worktree, no network, non-root, resource caps, clean env with no host secrets) —
no small patch substitutes for that.

---

*The honest framing: you're not rebuilding Camus and you're not shelving it. You're keeping the judgment — the standard that keeps it honest — and renting the engine. The part that's yours survives the labs' weekly releases; the part they commoditized, you stop maintaining.*
