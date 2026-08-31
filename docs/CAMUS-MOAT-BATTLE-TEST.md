# Camus moat battle test

**Status:** Adversarial product assessment; no implementation authority

**Date:** 2026-08-31

**Verdict:** SURVIVES CONDITIONALLY

**Confidence:** 63%

## 1. Bottom line

**Post-audit reconciliation (2026-08-31):** an independent external audit and a primary-source review
of Spotify XIRP/Honk converged with this battle test. The external audit was more optimistic about
the architecture's white space and more severe about the absence of demand evidence. Spotify offers
XIRP externally as a commercial product, confirming that vendor-neutral harness switching,
worktrees, session continuity, institutional memory, and fleet visibility are becoming purchasable
platform primitives; Spotify's Honk work confirms bounded agents,
deterministic verifiers, semantic judging, and pre-PR gates at organizational scale. Neither source
invalidates Camus's acceptance/custody/proof opportunity. Together they invalidate an
infrastructure-first roadmap. The binding product decision is now RFC v0.2 in
`CAMUS-INTELLIGENCE-PLATFORM-RFC.md`.

The proposed product is worth a bounded validation effort, but its first moat formulation does not
survive scrutiny.

Portable contracts, receipts, adaptive model routing, model+harness evaluation, fleet supervision,
remote execution, independent validation, and production feedback are all active product or research
directions. Combining them can produce a valuable product, but combination alone is not durable
defensibility.

The narrower thesis that survives is:

> Camus is the independent acceptance and proof layer for teams using coding agents. It turns a
> change request into an enforceable acceptance system, binds the exact candidate and complete agent
> identity to independent evidence, and learns from accepted and post-deployment outcomes which
> execution route to recommend for comparable work.

This is not yet a moat. It is a plausible wedge from which four moats could be earned:

1. repository-specific verification assets that compound;
2. high-integrity counterfactual outcome data across complete agent routes;
3. an open contract/receipt ecosystem with Camus as the trusted implementation;
4. an independent trust brand whose incentives are not tied to one model or harness.

If Camus only becomes a model router, mission-control UI, adapter collection, or receipt generator,
it will be absorbed by larger products or cloned by open source.

## 2. What broke under attack

### 2.1 Portable proof is not a moat

[Proof-Carrying Agent Actions](https://arxiv.org/html/2606.04104v1) proposes a model-agnostic,
runtime-neutral action certificate with authorization, approval semantics, receipts, replay, and
proof closure. Its associated [OSuite product](https://ond.cc/research/pcaa) explicitly positions
this as a deployer-side governance kernel for heterogeneous runtimes. The paper and product share
the same Ond Holdings author, so they are one early competitive voice, not independent confirmation
of a mature category.

This is extremely close to the portable authority/provenance part of the Camus thesis. Camus may
still implement a better code-specific acceptance protocol, but it cannot claim portable proof as a
unique category.

### 2.2 Execution-grounded routing memory is not a moat

[Agent-as-a-Router](https://arxiv.org/html/2606.22902v2) formalizes a context-action-feedback loop
that routes coding tasks, verifies execution, and stores historical outcomes for future choices. Its
reported benchmark contains roughly 10,000 tasks and eight model backends. The research explicitly
proposes extending the method to tools, skills, subagents, memory, and effort.

This attacks the Trust Graph directly. Accumulating verified routing outcomes is a sound direction,
but the concept is already public, and larger vendors possess far more usage data.

### 2.3 Complete model+harness measurement is not a moat

[Harness-Bench](https://arxiv.org/html/2605.27922v1) evaluates full model+harness configurations
under shared tasks and reports substantial configuration-level variation. It explicitly argues that
capability should be attributed to the execution system, not the base model alone.

Camus was right to treat Grok Build, Qwen Code, raw adapters, and native harnesses as different
systems. That insight is now an emerging baseline rather than exclusive intellectual property.

### 2.4 Contract compilation is not a moat

[Test-Driven AI Agent Definition](https://arxiv.org/html/2603.08806v1) compiles behavioral agent
specifications into prompts plus visible and hidden executable tests, iteratively refines an agent, and uses
semantic mutation testing to detect weak evaluation suites. [Datadog's harness-first work](https://www.datadoghq.com/blog/ai/harness-first-agents/)
describes contracts before code, deterministic simulation, formal checks, and production telemetry
as a compounding verification system.

Camus can productize acceptance compilation for ordinary teams, but “turn a specification into
checks” is not by itself a defensible invention.

### 2.5 Human-attention orchestration is not a moat

[OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/) moves work
from interactive sessions into an issue-tracker control plane, runs agents continuously, manages
workspaces/retries/CI, and explicitly identifies human attention as the bottleneck. Cursor, Factory,
Codex App, VS Code, and open-source orchestrators are moving in the same direction.

The Camus attention inbox is important UX, but it will become expected product behavior.

## 3. Attacker simulation

| Attacker | How it defeats the initial thesis | What Camus can still defend | Standing |
| --- | --- | --- | --- |
| Cursor | Adds acceptance templates, production outcomes, and independent reviewers to an installed IDE with far more usage data | Cross-harness neutrality, customer accounts/workers, external proof | Severe threat |
| Factory | Extends its router and Missions with evidence receipts and post-merge feedback | Independent acceptance outside Factory's own execution system | Severe threat |
| GitHub/Microsoft | Uses the repository, PR, CI, identity, and deployment control points it already owns | Cross-provider/harness evaluation and customer-controlled local execution | Severe threat |
| Spotify XIRP/Portal | Sells cross-harness sessions, worktrees, local/remote continuity, and institutional context through an established developer-platform channel | Independent acceptance contracts, exact-route custody, calibrated review, and portable PR proof | Severe threat to the context/fleet thesis; adjacent to the surviving wedge |
| OpenAI Symphony/Codex | Makes objective-level unattended work and feedback loops native to Codex | Vendor-neutral verification and complete route comparison | High threat |
| Omnigent | Adds acceptance schemas, deterministic gates, and outcome storage to an existing meta-harness | Deeper acceptance semantics, qualification, and proof integrity | High threat |
| OSuite/PCAA | Owns portable action governance, approval binding, and proof export | Software-artifact acceptance, independent reviewer standing, routing outcomes | High threat |
| ACRouter/Harness-Bench | Commoditizes learned routing and model+harness evaluation | Real repository, reviewer, worker, billing, human-attention, and production outcome dimensions | Medium/high threat |
| Internal platform team | Assembles CI, agent CLIs, policies, and a dashboard with existing tools | A much faster path to a maintained, cross-vendor system | High threat until product is radically simple |

No static feature prevents these attacks. Camus must earn distribution, evidence quality, ecosystem
adoption, and workflow embedding.

## 4. Buyer attack

A skeptical engineering leader can reasonably say:

1. “My agent IDE already plans, runs, reviews, and resumes work.”
2. “CI is my acceptance contract.”
3. “I do not want a second control plane.”
4. “The strongest model is cheaper than operating another routing system.”
5. “My repositories are too different for your global routing data.”
6. “I cannot send source, prompts, or outcomes to a new vendor.”
7. “Writing a formal contract adds more work than reviewing the pull request.”
8. “If the system asks me to calibrate judges, the automation has failed.”

Camus has no right to dismiss any of these. The first product must answer them experientially:

- install beside the existing IDE rather than replace it;
- infer a useful draft contract from the issue and repository, then ask only material questions;
- consume existing CI and tests instead of demanding a parallel rules system;
- show a saved failure, reduced supervision, or cheaper accepted outcome;
- keep private evidence and credentials on customer workers;
- automate calibration sampling and expose uncertainty; and
- deliver one compact acceptance result rather than another dashboard to supervise.

## 5. Investor attack

### 5.1 Why the company may not work

- Incumbents own distribution, execution, and much larger outcome datasets.
- A neutral layer risks becoming a thin integration product with permanent adapter maintenance.
- Per-team data may be too sparse and non-stationary to improve routing.
- Private local-first operation limits the cross-customer data flywheel.
- Open schemas improve trust but lower technical copy resistance.
- Teams may prefer one bundled vendor over configuring a portfolio of models and harnesses.
- Verification is valuable but can become repository infrastructure rather than recurring software
  spend.
- Remote worker operation adds support and security cost before product-market fit.

### 5.2 Why the company may work

- Model and harness fragmentation is real, and complete configurations have meaningfully different
  outcomes.
- A vendor selling its own agent is not an incentive-neutral judge of that agent.
- Agent throughput is increasing faster than human review capacity.
- Existing CI does not by itself preserve goal interpretation, reviewer independence, route identity,
  uncertain work, or human decisions.
- Customer-owned subscriptions, APIs, open models, and infrastructure create a neutral coordination
  opportunity that vertically integrated vendors will not serve equally.
- Current products expose many controls but still leave teams to design acceptance, route choice,
  evidence interpretation, and adaptation policy themselves.
- Camus already possesses relevant kernel primitives rather than starting from a pitch deck.

The venture outcome is possible but not established. The next evidence must be customer behavior,
not more architecture.

## 6. Technical attack

### 6.1 “Arbitrary cross-harness handoff” overclaims what is possible

Camus cannot generally migrate the private context, memory, caches, hidden state, or internal task
graph of a proprietary harness. It can safely transfer only what it owns or can prove:

- contract and plan revision;
- repository/candidate state;
- source and artifact hashes;
- host-observed actions;
- open criteria, checks, and findings;
- selected source material;
- budgets and authority; and
- reported/observed identity and usage.

Therefore the honest product is **artifact-and-obligation handoff at a known phase boundary**, not
live session migration. This remains useful, but the RFC and marketing must use the narrower claim.

### 6.2 Semantic contracts remain probabilistic

The kernel can enforce scope, action, identity, budget, and mechanical checks. It cannot prove that
an underspecified objective was interpreted correctly or that code contains no subtle defect.
Independent model review is measured evidence, not a hard guarantee. A contract compiler may also
compile the wrong intent with great precision.

The product needs hidden checks, mutation testing, human calibration samples, and an explicit
unknown/inconclusive standing. It must never market receipts as correctness proofs.

### 6.3 The data is biased

Ordinary production routing observes only the chosen route. It does not know how rejected routes
would have performed. Human overrides, task selection, model availability, changing prices, and
repository drift add confounding.

A defensible learning system requires controlled paired trials or other counterfactual evidence,
holdouts, recency/version expiry, propensity/selection records, and abstention. Without those, the
Trust Graph is a sophisticated log rather than reliable intelligence.

### 6.4 The data is sparse and decays

A 20-person team may not generate enough repeated, comparable tasks to distinguish route quality.
Every model, harness, prompt, tool, policy, or repository change can invalidate prior evidence.

Camus must combine:

- public or open-source route priors;
- cheap deterministic qualification;
- carefully chosen paired experiments;
- task/repository archetypes;
- private team outcomes; and
- conservative transfer with visible uncertainty.

Even then, route intelligence may remain a recommendation rather than an autonomous policy for many
task classes.

## 7. The position that survives

“Trusted execution plane for heterogeneous AI work” is directionally correct but too broad and too
easy to confuse with generic agent control planes.

The sharper launch position is:

> **Camus is the independent acceptance and proof layer for agent-written work.** Use the agents and
> accounts you already have. Camus turns the requested change into a testable contract, binds the
> exact candidate and agent identity to independent evidence, and returns one honest decision about
> what is ready and what still needs you.

The adaptive intelligence remains part of the product, but it is earned in stages:

1. make the contract and proof useful at the PR decision point;
2. observe later outcomes and reuse repository acceptance systems;
3. compare complete execution routes on the same contract;
4. recommend routes with uncertainty and abstention;
5. test manual handoff only when real stalls make it valuable; and
6. automate only calibrated, pre-authorized decisions.

This positioning can live inside Cursor, Codex, Claude Code, GitHub, CI, or another future system.
Studio is the best native experience, not a required replacement for the user's environment.

## 8. The moat Camus should attempt to earn

### 8.1 Compounding repository acceptance systems

The durable customer asset is not a generic prompt or receipt. It is a living map of what “good”
means for that codebase:

- requirements and architectural invariants;
- generated and human-approved checks;
- hidden and mutation-tested evaluation cases;
- production/staging observations;
- recurring failure signatures;
- reviewer findings that predicted later problems; and
- exceptions and human decisions.

These assets make every future agent more useful. Camus should help create, validate, version, and
reuse them while keeping them customer-owned and portable. Switching away remains possible, but a
competitor must equal the accumulated operational understanding and workflow.

### 8.2 High-integrity cross-harness counterfactual data

The valuable shared dataset is not “Claude used 40K tokens.” It is:

```text
same acceptance contract
+ same starting artifact and environment
+ complete model/harness/provider/worker/reviewer identity
+ paired or randomized route assignment
+ deterministic and calibrated semantic results
+ human attention and economics
+ later merge/revert/correction/incident outcome
```

Incumbents have more data but mostly inside their own execution surface. Camus can earn uniquely
neutral comparisons across subscriptions, APIs, open models, native harnesses, and customer workers.
This advantage exists only if users consent to useful aggregates and the experiment design is sound.

### 8.3 Open ecosystem and verification packs

The Camus Contract and receipt formats should be open. Domain/repository verification packs,
harness adapters, policy packs, and outcome connectors can create an ecosystem similar in shape—not
current scale—to Terraform providers, OPA policies, or CI actions.

The managed product wins by being the easiest, most reliable place to operate the open system. The
standard itself is not a moat until third parties adopt it.

### 8.4 Independent trust reputation

Camus should remain economically neutral among model and harness vendors. It should publish honest
qualification methods, refuse unearned rankings, disclose unknown billing/identity, and make its
local proof verifier open.

Over time, “Camus-evidenced” could become meaningful to a team or auditor. This is a brand and
institutional moat, not a cryptographic consequence of signing a receipt.

## 9. What must not be called a moat

- Number of models or adapters.
- Mission-control UI.
- SSH or remote workers.
- Generic routing.
- A/B test screens.
- Cryptographic signatures alone.
- Independent reviewer prompts.
- Checkpoint/resume mechanics.
- Human approval flows.
- Open protocols by themselves.
- Local-first deployment by itself.

All remain necessary product capabilities. None supplies durable defense alone.

## 10. Minimum battle experiment

**Superseded thresholds:** this section records the preliminary battle-test proposal. The binding
gates are RFC v0.2 Phase 1: contract setup median under two minutes, handoff optional and separately
gated by frequency/rescue value, and PR-decision usage measured before broader scale targets.

Before remote fleet infrastructure or automatic routing, run a 4–8 week design-partner experiment.

### Product slice

1. Import a real issue and current repository/CI context.
2. Produce a short proposed acceptance contract that the user can approve in under five minutes.
3. Recommend or accept one complete maker/reviewer route.
4. Execute through an existing native harness.
5. At one phase boundary, manually hand the exact candidate and open obligations to another harness.
6. Run deterministic checks and independent review.
7. Deliver one acceptance handoff.
8. Record merge, correction, revert, reopened issue, and a bounded later survival observation.

### Baselines

- the team's normal single-agent workflow;
- always use the team's strongest/default model;
- the same Camus flow without changing harness;
- Camus recommendation shown in shadow before it receives execution authority.

### Proposed validation thresholds

These are hypotheses to test, not public claims:

- at least 5 teams complete real tasks;
- at least 100 non-fixture contracts are observed in aggregate;
- at least 3 teams repeat the workflow after the assisted pilot;
- approved contract preparation has a median below 5 minutes;
- human supervision time falls at least 25% against the team's baseline;
- accepted-outcome rate does not materially regress;
- at least 20 real handoffs occur, with no lost open criterion or finding;
- at least 25% of recommendations differ from the expensive/default route for an evidence-backed
  reason;
- at least 2 teams say they would pay for continued use before remote/team administration is built.

### Kill or pivot conditions

- contract preparation takes as long as ordinary review;
- teams consistently ignore recommendations and only want execution concurrency;
- handoffs add failure without rescuing meaningful work;
- CI plus the native agent already provides the acceptance confidence users need;
- teams will not provide even private/local outcome feedback;
- task heterogeneity prevents recommendations better than a simple default;
- no team repeats without founder supervision; or
- the only requested value is remote workers or a prettier dashboard.

## 11. Required amendments to the platform RFC

**Status:** applied in `CAMUS-INTELLIGENCE-PLATFORM-RFC.md` v0.2. This list remains as the audit trail.

Before implementation, amend the RFC to:

1. Replace claims of arbitrary trusted transitions with artifact-and-obligation handoffs at sealed
   boundaries.
2. Stop treating the Trust Graph as a presumptive moat; describe the counterfactual, bias, sparsity,
   and expiry requirements.
3. Add PCAA/OSuite, Symphony, Agent-as-a-Router, Harness-Bench, TDAD, and Datadog's harness-first
   work to the competitive map.
4. Reframe the first product as an independent acceptance layer for multi-agent software teams.
5. Move the customer-owned remote worker behind the first design-partner validation unless a paying
   partner requires it.
6. Make acceptance-system reuse and outcome closure first-class in Milestones 0 and 1.
7. Add the baseline comparisons and kill criteria from this document.
8. Define ecosystem adoption and counterfactual evidence as earned moat milestones, not launch
   features.

## 12. Final judgment

The idea survives because the underlying problem is getting larger: agents generate work faster
than teams can confidently accept it, while models and harnesses remain fragmented. Camus already
has relevant trust, identity, recovery, qualification, and evaluation primitives.

It survives only conditionally because the market is converging on nearly every mechanism in the
proposal. The opportunity is execution and positioning, not possession of a secret architecture.

Proceed with discovery and the minimum acceptance/proof experiment needed to test the wedge.
Do not yet build the complete remote/team platform, claim a data moat, or describe Camus as the
universal control plane. If the experiment demonstrates lower human supervision with equal or
better surviving outcomes, the company thesis becomes materially stronger. If it does not, stop or
pivot before infrastructure scope expands.

## 13. Sources and limits

Checked on 2026-08-31. Research papers and vendor pages are evidence of active direction and stated
capability, not independent proof of production performance.

- [Proof-Carrying Agent Actions](https://arxiv.org/html/2606.04104v1)
- [OSuite PCAA](https://ond.cc/research/pcaa)
- [Agent-as-a-Router](https://arxiv.org/html/2606.22902v2)
- [Harness-Bench](https://arxiv.org/html/2605.27922v1)
- [Test-Driven AI Agent Definition](https://arxiv.org/html/2603.08806v1)
- [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [OpenAI harness engineering](https://openai.com/index/harness-engineering/)
- [Datadog harness-first agents](https://www.datadoghq.com/blog/ai/harness-first-agents/)
- [Salesforce Agent Coding maturity curve](https://engineering.salesforce.com/the-agent-coding-maturity-curve-9-stages-from-code-generation-to-trusted-automation/) — retained as an unverified research lead; no conclusion in this document depends on it.
- [M12: enforceable behavior in LLM agents](https://m12.vc/news/from-promises-to-contracts-enforceable-behavior-in-llm-agents/) — retained as an unverified research lead; no conclusion in this document depends on it.
