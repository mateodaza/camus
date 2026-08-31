# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary paid users are engineering teams of roughly 5–50 people that already use multiple
coding models or agent harnesses and need to coordinate real work across repositories without
supervising every turn. Engineering leads and platform owners need dependable completion,
cost/authority control, and reconstructable evidence; individual developers need the same local
loop without team infrastructure and are the primary open-source adoption path.

## Product Purpose

Camus is the independent acceptance and proof layer for agent-written work. It turns a user's goal
into an explicit acceptance contract, lets an eligible coding agent attempt it, verifies the exact
candidate, preserves independent review and identity, and produces one evidence-bound handoff for a
merge or release decision.

Success first means that a team uses the contract and proof on real agent-authored pull requests,
opens the handoff, and changes or accelerates a decision because of it. The longer-term control plane
may recommend execution strategies, coordinate local or remote work, and ask a human only for a
decision it cannot safely make, but those capabilities must be earned by observed demand.

## Positioning

Camus is not an IDE, terminal multiplexer, model reseller, generic agent launcher, or institutional
knowledge system. Neighboring products increasingly operate many agents, preserve context across
sessions, and switch harnesses. Camus defines what accepted means and proves what happened. Its
deterministic kernel keeps authority, custody, budgets, verification, review provenance, recovery,
and evidence stable even when the selected model or harness changes.

Camus Intelligence begins as an architect and recommendation layer above that kernel. It may infer
acceptance criteria, classify complexity and stakes, and recommend a model/harness/reviewer route
from available evidence. Every recommendation exposes its reason and uncertainty. Automatic route
selection, adaptive handoff, and worker scheduling remain later capabilities until real usage proves
that they save more work than they add.

## Operating Context

- Users work across several trusted Git repositories and may run multiple isolated candidates at
  once through the CLI or Loop Studio.
- Makers and reviewers may be subscription-backed native coding harnesses, configured APIs, or
  self-hosted/open-weight models. Their availability, capability, economics, and quality vary.
- Repository and organizational context may already live in AGENTS.md, Backstage/Portal, XIRP, an
  IDE, or a harness. Camus consumes authorized context and captures acceptance evidence
  automatically; it does not require teams to maintain a second knowledge system.
- Initial work executes on the user's machine. Customer-owned workers/VPS remain a validated future
  option; repositories, credentials, and subscription sessions must remain on their owning worker.
- Studio is initially the surface for contracts, runs, model/eval evidence, interventions, and
  receipts. Portfolio and worker mission control follows only after the thin loop earns repeat use.
- Camus can complement agent IDEs and development environments through its CLI and worker/control
  protocols rather than reproducing their editor, browser, or terminal surfaces.

## Capabilities and Constraints

- Keep the local CLI, local Studio, deterministic kernel, and bring-your-own model/harness path
  free and MIT-licensed.
- Keep the worker and coordinator contracts possible without building them before customer demand.
- Preserve requested, resolved, reported, and observed model identity—with unprovable facts kept
  unknown—plus exact provider, harness, reviewer, worker, billing-authority, and policy identity per
  phase and per handoff.
- Let semantic models propose plans and recommendations; let code enforce authority, budgets,
  leases, bindings, mechanically decidable checks, and failure direction.
- Optimize for an accepted quality floor before latency or price. Automatic routing requires
  repeated task-class-specific evidence and calibrated judgment; sparse evidence produces a
  recommendation or explicit operator choice, not an invented winner.
- Treat cross-harness continuation as artifact-and-obligation handoff at a sealed phase boundary,
  not transfer of an agent's private session state. Automate it only after manual pilots show that it
  rescues work more cheaply than restart.
- Keep Camus state, credentials, checkpoints, and control artifacts outside target repositories.
- Publication, merge/push, destructive mutation, new credential/host trust, and authority expansion
  remain explicitly governed high-stakes actions.
- Test the first paid boundary around team policy, evidence retention, pull-request integration,
  access control, private deployment, and support. Remote coordination and worker fleets are later
  hypotheses. Camus does not initially resell model tokens or customer compute.

## Brand Commitments

- Product name: Camus. Visual product surface: Camus Loop Studio.
- Core line: “Trust the work, not the model that made it.”
- Supporting line: “Makes it work. Knows when to stop.”
- Voice is plain, precise, calm, and evidence-led. Never invent customers, benchmarks, model
  rankings, trust standing, cost savings, or autonomy claims.

## Evidence on Hand

- The public alpha, CLI, Studio, release history, and deterministic suites are present in this
  repository. The README and release notes describe their exact current standing.
- Existing local contracts cover isolated worktrees, durable run checkpoints, budgets, maker and
  reviewer identity, native harnesses, verification, evidence receipts, stakes routing, recovery,
  qualification, and experimental A/B/admission infrastructure.
- Bounded simple-task provider evidence exists for selected Qwen and Grok paths. It is case-scoped
  and does not establish a universal winner or automatic-routing admission.
- No public customer count, revenue, design-partner result, general model ranking, remote-worker
  deployment, or multi-project productivity benchmark exists yet. Current package traffic and
  repository activity do not establish demand. Future product and marketing work must not fabricate
  it.

## Product Principles

1. **Trust is model-independent.** Changing intelligence must not change what verified, reviewed,
   authorized, or recoverable means.
2. **Quality first, then efficiency.** Optimize cost and speed only among strategies that meet the
   task's evidence-backed quality floor.
3. **Intelligence proposes; the kernel governs.** Models may interpret and adapt, but cannot grant
   themselves authority or hide uncertainty.
4. **Human attention is scarce.** Route one evidence-rich decision when stakes or ambiguity require
   it; keep ordinary implementation, repair, recovery, and low-risk coordination autonomous.
5. **Local-first without being local-only.** Customer code and credentials remain under customer
   control while workers and projects can be coordinated across machines.

## Accessibility & Inclusion

Studio must support keyboard-only operation, visible focus, semantic status updates, reduced motion,
responsive layouts, and status communication that does not depend on color alone. Dense professional
views must remain understandable without requiring users to read raw agent transcripts.
