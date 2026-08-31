# RFC: Camus Intelligence and the independent acceptance layer

**Status:** Revised after hostile and external audit; approved only for discovery and the thin pilot

**Version:** 0.2

**Date:** 2026-08-31

**Scope:** Product direction after Camus 0.4.18

**Decision owners:** Product owner for commercial and UX choices; Camus kernel for enforced runtime contracts

## Executive decision

Camus should first become the **independent acceptance and proof layer for agent-written work**, not
another coding agent, model picker, IDE, knowledge system, or generic fleet dashboard. A trusted
execution plane remains a plausible destination, not a validated starting point.

The launch wedge starts from a user's acceptance contract. **Camus Intelligence** helps make the
contract concrete and recommends an eligible maker/reviewer route. The existing deterministic Camus
kernel executes the authorized route, verifies the exact candidate, preserves identity and review
independence, and emits an evidence-bound pull-request handoff. The proof must be useful inside the
workflow the team already uses; it is not another dashboard users must remember to visit.

The product promise is:

> State what done means, let any eligible agent build it, and get one evidence-bound handoff that
> says exactly who did what, what was verified, and what remains at risk.

This direction preserves the existing service contract:

- models propose and interpret;
- harnesses own their native agent loops;
- Camus owns custody, authority, budgets, durable state, verification, provenance, and stopping;
- humans own the goal, material scope changes, high-stakes actions, and final publication authority.

The next objective is not a broad commercial build. It is ten discovery interviews and a thin pilot
with teams already reviewing agent-authored pull requests. The open-source local core remains MIT
and useful by itself. Paid value is initially a hypothesis around organization policy, evidence
retention, pull-request integration, and private outcome analysis. Remote workers, automatic routing,
and portfolio coordination earn priority only when usage demonstrates their value.

### Audit decision

Two independent attacks reached the same conclusion. The architecture thesis survives, but the
original roadmap did not: it sequenced a substantial platform before evidence of demand. Camus has
strong shipped trust primitives and no established product-market proof. Therefore:

1. preserve the long-term contract → execution → proof → outcome-learning loop;
2. validate the acceptance-and-proof wedge before broad control-plane infrastructure;
3. treat handoff, routing automation, remote workers, and portfolio orchestration as experiments;
4. integrate with IDE, Git, CI, and context systems instead of requiring a destination workflow; and
5. judge progress by decisions changed, review time saved, repeat use, and willingness to pay—not
   releases, schemas, model count, downloads, or internal dogfood volume.

## 1. Research conclusion: the correction we must accept

No individual item on the prior wish list is novel enough to be Camus's company thesis.

| Capability | Already demonstrated in the market | Consequence |
| --- | --- | --- |
| Parallel agent mission control | Codex App, Cursor, VS Code, Factory, Orca, Superset, Agent Orchestrator | A fleet dashboard is table stakes, not the wedge. |
| Automatic model routing | Cursor Router, Factory Router, OpenRouter Auto/Pareto | A generic task classifier plus cheapest-model selection will be commoditized. |
| Meta-harness / any model | Omnigent; native multi-agent support in VS Code | Adapter count is valuable compatibility work, not defensibility. |
| Independent executor and verifier | Zeroshot and Camus | “A different agent reviews it” is necessary but no longer unique. |
| Independent PR review | Sonar, Greptile, Qodo, CodeRabbit, Anthropic's GitHub Action | Proof is already a budgeted category. Camus must win on full-loop custody, exact route identity, contract traceability, and portable evidence—not the existence of AI review. |
| Governed contracts, budgets, receipts | MartinLoop and Camus | Trust artifacts matter, but their usefulness must be visible in a workflow rather than sold as schema sophistication. |
| Proof-carrying agent actions | PCAA paper + OSuite product from the same Ond Holdings author | Model-neutral authorization and proof receipts are an active early direction, but these are one actor rather than independent category confirmation. Portability alone is not a moat. |
| Execution-grounded route learning and harness evals | Agent-as-a-Router, Harness-Bench, TDAD | Outcome learning, complete model+harness measurement, and generation of agent prompts/tests from behavioral specifications are active research areas. Camus must differentiate through real workflow custody and later outcomes. |
| Issue-driven orchestration and production feedback | OpenAI Symphony and Datadog harness-first work | Issue-tracker state machines, bounded agents, observability, and feedback loops are converging. Camus should integrate rather than recreate generic orchestration. |
| Remote/customer-controlled execution | Cursor Cloud Agents, Coder, Ona, Orca, Superset, Omnigent | Camus should integrate execution providers and customer workers, not build a proprietary VM cloud first. |
| Cross-harness context and institutional memory | Spotify XIRP + Portal, offered externally as a commercial product | Vendor-neutral switching, worktrees, session continuity, shared context, and fleet visibility are becoming purchasable platform primitives. Camus should consume this layer, not duplicate it. |
| Bounded agents with verifier and judge loops | Spotify Honk and mature CI/review systems | Deterministic verification first, semantic review second, and narrow permissions are proven practice. Camus must make the resulting decision evidence portable and identity-bound. |
| Durable workflow state | Temporal, LangGraph, OpenHands | Durable activity semantics are mature patterns; Camus should adopt the mechanisms without becoming a workflow framework. |
| Enterprise policy and audit | GitHub, Coder, Cursor, Ona | Policy checklists alone will not differentiate an early-stage product. |

The direct open-source competition is especially important:

- [Omnigent](https://github.com/omnigent-ai/omnigent) describes itself as a meta-harness over
  Claude Code, Codex, Cursor, Pi, Grok Build, and custom agents; supports subscriptions, APIs,
  cloud sandboxes, teams, policies, budgets, mid-session model changes, and cross-vendor review.
- [Zeroshot](https://github.com/the-open-engine/zeroshot) classifies task complexity, selects a
  workflow, separates executor and verifier, uses isolated worktrees, and keeps a crash-safe ledger.
- [MartinLoop](https://github.com/Keesan12/martin-loop) presents governed run contracts, hard
  budgets, fresh verification, signed receipts, rollback, and proof of outcomes.
- [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) and
  [Fractal](https://github.com/plasma-ai/fractal) cover agent fleets and recursive decomposition.

Spotify's XIRP is the clearest warning against a context or fleet pivot. Spotify reports that XIRP
runs concurrent sessions in isolated worktrees, supports multiple agent harnesses, carries working
state across them, and feeds session context into Portal. Spotify now offers XIRP externally and
invites teams to try it, making it a commercial competitor in this layer rather than only an internal
reference architecture. Its earlier Honk work also demonstrates
that intentionally narrow agents, automatically selected deterministic verifiers, a separate judge,
and a final pre-PR gate can operate at organizational scale. The lessons Camus should adopt are:

- context and evidence capture must happen automatically during real work;
- a team should not maintain another parallel source of truth for Camus;
- harness-specific context management belongs to the harness;
- verification should hide noisy build-system mechanics from the maker while remaining inspectable;
- the proof should appear at the PR/CI decision point; and
- institutional memory is an input to Camus's contract, not Camus's primary product.

Spotify also states that it has not yet invested in evals for the Honk judge, despite reporting that
the judge vetoes roughly a quarter of sessions and the maker course-corrects about half of those.
Those are self-reported operational observations, not a benchmark. They expose a useful distinction:
Camus's opportunity is not merely to add a judge, but to make semantic judgment calibrated,
identity-bound, and insufficient by itself to grant routing or acceptance standing.

This does **not** make Camus irrelevant. It changes the standard of proof. Camus must integrate the
pieces into a simpler outcome-oriented experience and earn an advantage through reusable acceptance
systems, complete-route evidence, and trusted independent proof. It must not claim that competitors
lack features they publicly ship.

## 2. The unsolved job

Teams can launch many agents, but still have to answer five hard questions manually:

1. What does this request actually require, and what evidence would prove it complete?
2. Which model **and harness** should do each phase under this team's quality, cost, privacy, and
   latency constraints?
3. When an agent stalls, runs out of context, fails a check, or encounters a new kind of work, can
   the system change strategy without losing truth or silently changing authority?
4. Which finished-looking result is trustworthy enough to merge, and why?
5. Which of dozens of running jobs genuinely needs a human now?

Existing model routers usually optimize one request or session. Existing fleet managers primarily
schedule agents. Existing eval systems measure agents outside the production path. Existing trust
layers tend to prove a run after its strategy has already been chosen.

Camus's opportunity is the closed loop:

```text
acceptance contract
  → compiled execution strategy
  → governed model + harness + worker phases
  → independent evidence and review
  → bounded strategy adaptation
  → human decision only when necessary
  → accepted/rejected/later-failed outcome
  → better team-specific strategy next time
```

The unit of value is not a model call. It is an **accepted outcome with known provenance, bounded
cost, and low human interruption**.

The launch wedge tests questions 1 and 4: define accepted and make the resulting proof useful in a
real PR decision. Questions 2, 3, and 5 describe the expansion path. They must not force the pilot to
build a router, session-transfer system, or mission-control product before the wedge has repeat use.

## 3. Product identity and boundaries

### 3.1 What Camus is

Camus is an independent acceptance and proof layer that can sit above native agent harnesses or
inside a local developer and pull-request workflow. It should remain useful from the CLI, Studio,
another IDE through ACP, or an external automation through an API. If the wedge earns demand, the
same contracts can support a broader control and intelligence plane.

Camus Intelligence begins as the semantic contract and recommendation layer. It may:

- interpret a natural-language job and proposed acceptance criteria;
- identify missing or ambiguous success conditions;
- classify task type, complexity, stakes, and required capabilities;
- propose decomposition and dependencies as advice;
- recommend among eligible model + harness + reviewer combinations;
- later recommend a strategy change from new evidence;
- explain uncertainty and alternatives; and
- learn from completed, human-adjudicated outcomes.

The Camus kernel remains deterministic where authority is involved. It must:

- validate the compiled contract and every transition;
- bind requested, resolved, reported, and observed model identity—leaving any unprovable dimension
  explicitly unknown—along with harness, provider, subscription/API billing authority, worker, and
  artifact;
- enforce filesystem, network, credential, action, time, token, spend, and publication limits;
- preserve durable state and prevent uncertain replay;
- run configured deterministic checks before semantic grading;
- enforce reviewer independence and standing;
- route high-stakes or out-of-envelope changes to a human; and
- seal a reconstructable result without leaking secrets or model chain-of-thought.

### 3.2 What Camus is not

- It is not a universal IDE. Studio is a mission-control and decision surface, not an editor war.
- It is not a replacement harness for Claude Code, Codex, Grok Build, Qwen Code, Cursor, or future
  agents. Raw model adapters remain useful, but native harnesses retain their own context and tools.
- It is not a token reseller in the first commercial version.
- It is not an autonomous merge bot. Merge, publication, deployment, destructive changes, and
  materially expanded authority remain explicit policy decisions.
- It is not an opaque router. A route without identity, evidence, uncertainty, and policy is not a
  Camus route.
- It is not a general-purpose Temporal or LangGraph competitor.

Software engineering is the launch wedge. Contract and evidence schemas should not unnecessarily
assume that every future artifact is a Git diff, because agent work is expanding into operations,
research, design, and other computer-mediated work. Camus must not market those domains until it has
domain-specific checks, reviewers, controls, and real evidence.

## 4. Why this can remain relevant as the industry changes

### 4.1 What is likely to commoditize

- Frontier model names and rankings will change quickly.
- Raw inference and generic request routing will become cheaper and more embedded in providers.
- Coding harnesses will converge on strong repository exploration, tools, memory, worktrees, and
  subagents.
- Mission-control grids and background agent queues will become standard IDE features.
- Tool adapters will increasingly be portable through MCP and skills.

Camus should not build its moat in those layers.

### 4.2 What becomes more valuable

- A stable contract for intent, authority, evidence, and outcome across changing agents.
- Artifact-and-obligation handoffs at sealed phase boundaries without asking the next model to trust
  a prose summary. Private session state remains owned by the original harness.
- Private, organization-specific evidence about what works in its repositories and constraints.
- Runtime security and verifiable authorization as more agents act without direct supervision.
- An attention layer that lets one person supervise many jobs without approving everything.
- Fast qualification of new models and harnesses as the catalog changes.
- Customer-controlled execution for source, data-residency, and cost reasons, if customers prove
  that an additional worker layer is needed.

### 4.3 Protocol posture

Camus should adopt open interfaces at its edges:

- [MCP](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro) for tools and data;
- [ACP](https://agentclientprotocol.com/get-started/introduction) for editor/client to coding-agent
  communication where supported;
- [A2A](https://a2a-protocol.org/latest/) for discovery and delegation to opaque external agents
  when it becomes operationally useful;
- [AGENTS.md](https://agents.md/) and Agent Skills for portable repository instructions.

Camus's own stable protocol should cover what those do not: the acceptance contract, execution
authority, phase transition, evidence, artifact identity, and outcome receipt. Adapters should map
open protocol events into this contract instead of making Camus invent a proprietary tool or chat
protocol.

If one IDE or agent runtime becomes dominant, Camus should be able to run as its control/evidence
integration rather than requiring the user to abandon it. Neutrality is valuable only if it reduces
switching and governance costs; it is not a reason to own every interaction surface.

## 5. Primary pilot journey

### 5.1 From request to strategy

The user selects one project and enters or imports a real job. The input may be a short request,
issue, contract, or full specification. Camus Intelligence creates an editable **Architect Preview**
before any paid or state-changing work:

- interpreted objective and non-goals;
- explicit acceptance checks and unresolved ambiguities;
- task class, complexity, stakes, data sensitivity, and confidence;
- decomposition advice only when the task requires it;
- eligible maker model + harness and independent reviewer recommendation;
- deterministic checks and semantic grading plan;
- time, token, and cost ranges with known/unknown billing semantics;
- human checkpoints and why they exist;
- evidence supporting the recommendation; and
- a simpler or stronger alternative when evidence supports one.

The preview is a proposal, never authority. The user may accept it, edit it, or set an organization
policy that pre-authorizes plans within a bounded envelope.

### 5.2 During execution

Studio or the CLI shows the contract, progress, evidence, and exceptions—not a wall of agent chat.
The existing local execution path remains responsible for the run. If a real task stalls, the pilot
may offer one manual phase-boundary experiment such as:

> Switch the implementation phase from Qwen raw actions to Claude Code. Three discovery turns
> produced no candidate mutation; this repository class has stronger accepted outcomes with the
> native harness. Expected increment: 4–8 minutes and unknown subscription usage. This is within
> the pre-authorized model, data, and budget envelope.

The user decides whether to seal the current artifact and obligations and start the other route.
There is no automatic switching in the pilot and no claim that private harness session state moves.
The experiment records whether handoff rescued the task more cheaply than restart.

### 5.3 At completion

The user receives one proof-oriented handoff:

- intended consumer and governed decision (for example, GitHub merge review);
- exact candidate and repository revision;
- acceptance criteria and standing of each;
- deterministic check results;
- reviewer identity, independence, findings, and disposition;
- model, harness, route, and billing identities by phase, plus worker only when applicable;
- strategy changes and their reasons;
- time, tokens, known cost, unknown accounting, and human interruptions;
- remaining risks and the exact next decision; and
- merge/publish/deploy controls only when separately authorized.

With consent, the later real-world outcome—accepted, merged, reverted, corrected, incident, or
successful after a defined period—updates the private evidence ledger.

## 6. The Camus Contract

The contract is the durable product primitive. It should be versioned, portable, and usable without
Studio. Contract v0 extends the current checkpoint with only the fields required by the pilot:

```text
contract_id / version / created_by
objective / non_goals / source_refs / artifact_kind
acceptance_criteria[] / required_checks[]
task_class / complexity / stakes / reversibility
scope / protected_paths / allowed_side_effects
maker_route / reviewer_route / review_independence
quality_floor / time / action / model_call / token / spend limits
publication / merge authority
```

The broader target schema may later represent:

```text
contract_id / version / created_by
objective / non_goals / source_refs / artifact_kind / execution_target
acceptance_criteria[] / required_checks[]
task_class / complexity / stakes / reversibility
data_policy / network_policy / credential_policy
scope / protected_paths / allowed_side_effects
eligible_models / harnesses / providers / billing_authorities
eligible_workers / region / trust requirements
review_independence / reviewer_standing
quality_floor / optimization_preferences
time / action / model_call / token / spend limits
adaptation_envelope / human_checkpoints
publication / merge / deployment authority
```

Every field records one explicit provenance class: `human`, `policy`, `measured`, or
`model_proposal`, plus the source reference when applicable. Proposed values become active only after
the kernel validates their provenance and the applicable authority rule.

The compiler produces a versioned execution plan. A material contract change mints a new contract
revision and invalidates evidence that no longer binds. An execution-plan change inside the same
contract creates a transition receipt but does not rewrite the goal.

## 7. Earned routing and handoff contract

This section defines safety invariants for later experiments; it does not authorize automatic
routing or switching. Phase 1 uses explicit user choice plus, at most, one manual phase-boundary
handoff. Promotion follows the gates in Section 14.

### 7.1 Route the complete seat, not only the model

This RFC uses three distinct terms:

- **execution route:** the complete maker/reviewer seat and runtime identity below;
- **recommendation policy:** the evidence-backed rule that proposes an execution route; and
- **provider path:** the connection and billing path used by one model invocation.

They must not share a generic `route` field in new schemas.

A route is:

```text
task phase
+ requested, resolved, reported, and observed model identity
+ harness/executor and artifact/version
+ provider and connection
+ billing authority (subscription, API, gateway, local)
+ worker and capability profile
+ reviewer and independence relation
+ prompts/tools/skills/config versions
+ limits and policy
```

The same model in raw file actions, Claude Code, Grok Build, Qwen Code, Cursor, or a remote agent is
not the same system. Evaluations and recommendations must use the complete execution-route identity.
The executable/harness artifact is resolved and observed again at run start; qualification of an
installed version is not proof that the same version actually executed.

### 7.2 Optimization objective

Routing is lexicographic:

1. satisfy the required safety, quality, and proof floor;
2. respect data, authority, provider, billing, and worker constraints;
3. minimize expected human interruption;
4. among eligible strategies, optimize the user's selected cost/latency preference.

Cheap failure never outranks expensive success. A route may abstain when evidence is weak.

### 7.3 Switching triggers

A strategy change may be proposed only from named evidence:

- a planned phase boundary;
- repeated equivalent actions or no candidate progress;
- context pressure that cannot preserve required evidence;
- deterministic verification failures with a different required capability;
- reviewer findings that require another expertise or fresh independent context;
- provider outage, rate limit, or unavailable capacity;
- projected budget overrun;
- worker capability, locality, or trust mismatch; or
- a human modification to the objective or constraints.

Elapsed time alone is not evidence that a difficult task is stuck.

### 7.4 Handoff checkpoint

Camus never hot-swaps an in-flight model call. A switch occurs after the current action is known
complete or the uncertain call is sealed and refused from automatic replay. The host creates a
**handoff capsule** containing:

- contract and plan revisions;
- source and exact candidate fingerprints;
- ordered host action ledger;
- files read or changed and their hashes;
- current phase and remaining objective;
- open deterministic failures and reviewer findings;
- verification and review bindings;
- remaining budgets and elapsed active time;
- outgoing and incoming route identity;
- reason, evidence, policy rule, and authority for the switch; and
- a bounded source projection needed for the next harness.

The outgoing model's narrative summary may be included as explicitly untrusted advice. It cannot
replace host-owned state or settle an open finding.

### 7.5 Authority envelope

Before execution, the user or organization may authorize:

- eligible route pool and prohibited vendors;
- allowed billing authorities and maximum cost delta;
- worker regions and trust classes;
- maximum number and direction of switches;
- whether availability failover is allowed;
- whether an adaptation may change reviewer or only maker;
- quality floor and minimum reviewer independence; and
- actions that always require a human.

Camus may automatically execute only an adaptation fully inside that envelope. A model cannot widen
it, hide an identity change, weaken reviewer independence, or convert unknown cost into zero.

## 8. Camus Intelligence architecture

The approved pilot extends the shipped kernel in `packages/cli/skills/camus/scripts/feat_kernel.py`
and `drive.py`; it must not create a competing workflow-level orchestrator. The minimum path is:

```text
issue / prompt / existing repository context
                  ↓
editable contract preview (semantic proposal)
                  ↓
policy + contract validation (code)
                  ↓
existing deterministic execution kernel + harness adapters
                  ↓
deterministic verification → independent semantic review
                  ↓
checkpoint-bound PR proof → consented later outcome
```

The semantic compiler is replaceable and versioned. The kernel does not depend on one planner model.
Its outputs use constrained schemas, and all action-bearing values are checked against policy. A
planner/router, worker scheduler, or online learner is added only after its independent product gate.

### 8.1 Architect Preview output

The pilot compiler returns a bounded proposal:

```json
{
  "contract_revision": "contract1:…",
  "classification": {
    "task_type": "feature",
    "complexity": "balanced",
    "stakes": "medium",
    "confidence": "medium",
    "reasons": ["…"]
  },
  "ambiguities": [],
  "proposed_acceptance_criteria": ["…"],
  "required_checks": ["…"],
  "recommended_execution_route": "execution-route:…",
  "alternatives": ["execution-route:…"],
  "evidence_refs": ["eval:…"],
  "human_checkpoints": ["merge"],
  "uncertainty": ["…"]
}
```

Unknown evidence must remain unknown. The schema must not accept invented cost, qualification,
standing, or success rates.

### 8.2 Decision ownership

The planner may select work and recommend strategy. It must not perform implementation work in the
same role, approve its own output, edit canonical state, or bypass a required reviewer. Smaller
jobs should not spawn agents by default; decomposition must justify its coordination and token cost.

### 8.3 Harness adapter contract

Every raw or native harness adapter should expose the same minimum host-facing lifecycle without
pretending the harnesses are internally identical:

```text
describe() → capabilities, version, auth/billing modes, protocol limits
prepare(contract, phase, worker) → validated launch plan with no provider spend
start(launch_plan, handoff_capsule) → session and initial identity evidence
events(session) → ordered actions, usage, artifacts, status, and uncertainty
interrupt(session) → bounded stop request and observed terminal state
resume(session, checkpoint) → continuation only when replay safety is known
export(session) → final artifact refs and provider/harness evidence
cleanup(session) → owned-process and private-state disposition
```

An ACP adapter may satisfy several lifecycle methods directly. A vendor CLI wrapper may require
Camus-owned supervision. Unsupported or unobservable fields remain named gaps; an adapter cannot
fabricate parity.

### 8.4 Event log and projections

The authenticated code checkpoint remains the canonical run state. This RFC does not authorize an
event-sourcing rewrite. Add a schema-versioned append-only decision journal only where it improves
reconstruction and evidence; events must be derivable from, or reconciled against, the authoritative
checkpoint. Every new state-changing command carries an idempotency key, contract revision, phase,
and precondition. Studio and CLI read the same checkpoint-backed projection; neither becomes a second
orchestrator. Worker leases enter this contract only if the worker experiment is separately earned.

Completed external calls are recorded before dependent work. An interrupted call with unknown
provider disposition is `uncertain`, never automatically replayed. Event-source inversion may be
considered only after a separate migration proof shows a concrete need and preserves all sealed
history; it is not part of the pilot.

### 8.5 Context boundary

At a manual phase-boundary experiment, the next route receives the original contract, the exact
candidate or content-addressed artifact, required source bodies, open criteria, unresolved findings,
verification evidence, and remaining authority. It does not receive or claim continuity with the
outgoing harness's private session state, private reasoning, or full transcript. Context selection is
deterministic where required evidence is known and semantic only for optional supporting material;
omitted evidence is named.

## 9. Evidence, evaluation, and A/B learning

Camus should convert its existing eval machinery from a release ceremony into the learning engine
of the product.

### 9.1 Grading ladder

1. Deterministic code for schemas, tests, exact identity, scope, security, performance thresholds,
   artifact presence, and other mechanically decidable claims.
2. A different-model judge for semantic criteria only, using a constrained verdict and a rubric
   calibrated against human labels.
3. Human judgment for novel, high-stakes, or uncalibrated cases.

An uncalibrated judge cannot enable automatic routing. A human proxy label must remain distinct from
the product owner's label.

### 9.2 What to compare

The experimental arm is the full route—not merely a model:

- contract/task class and repository archetype;
- model, effort, harness, provider, billing authority, and worker;
- context strategy, tools, skills, and prompt version;
- reviewer route and independence;
- success and quality-floor status;
- deterministic and semantic scores;
- active time, wall time, actions, calls, tokens, and known/unknown cost;
- repairs, retries, switches, and human interruptions; and
- later accepted/reverted/corrected outcome.

### 9.3 Learning stages

1. **Rules only:** explicit user choices and conservative defaults.
2. **Recommendations:** show a ranked execution route with evidence and uncertainty; user accepts or
   changes it.
3. **Shadow recommendations:** compute what Camus would choose without changing execution.
4. **Bounded automatic routing:** only calibrated task classes and pre-authorized routes.
5. **Safe adaptation:** phase-level route changes inside the authority envelope.
6. **Portfolio optimization:** allocate workers and budgets across jobs while preserving each
   contract's floor.

The initial learner should be transparent rules plus empirical estimates. Do not begin with an
opaque reinforcement learner. A contextual bandit or Bayesian policy may be considered only after
enough per-class outcomes exist, with conservative exploration, holdouts, drift detection, and an
abstain path.

### 9.4 Continuous qualification

Model and harness evidence expires when any identity-bearing component changes: model revision,
harness artifact, provider path, prompt/tool schema, worker trust class, or acceptance suite.
New catalog entries start in shadow. A fast automated qualification lane should make model churn a
product advantage rather than weeks of manual retesting.

### 9.5 Sparse, biased, and decaying evidence

A team observes outcomes only for execution routes it chose, on tasks it happened to run, under
versions that change quickly. Camus must not present this selection-biased sample as a universal
ranking. Recommendations should combine, in descending authority:

1. current contract and policy constraints;
2. fresh qualification and calibrated paired evidence;
3. private team outcomes for comparable repositories/tasks;
4. explicitly labeled public or ecosystem priors; and
5. abstention when the evidence is insufficient.

Outcome evidence carries version and time expiry. Privacy-preserving aggregate priors may be studied
only with explicit opt-in, a published aggregation contract, and no source, prompt, diff, or secret
transfer. If a team never reaches useful density, evidence-backed recommendation remains the product;
automatic routing is not forced to justify the architecture.

## 10. Deferred worker and remote-execution option

This section preserves an architectural option; it is not approved implementation scope. The local
engine remains the only required worker. Build a remote worker only after at least three teams ask
for unattended customer-owned execution without prompting, the request is tied to willingness to
pay, and subscription-backed harness use on a shared or remote host is compatible with applicable
provider terms. A future remote worker is customer-owned software that makes an outbound
authenticated connection to the coordinator; it is not an inbound arbitrary SSH shell.

### 10.1 Worker contract

Each worker advertises signed, expiring capabilities:

- worker ID, owner, platform, architecture, and version;
- available harnesses and verified artifacts;
- repository access without credential disclosure;
- CPU, memory, GPU, and concurrency limits;
- sandbox/runtime class;
- region and data policy tags;
- allowed network destinations;
- secret references it can use, never secret values;
- health, lease, and last attestation time.

The coordinator schedules a plan only to a compatible worker. Workers pull bounded jobs, validate
the signed contract locally, and independently enforce critical action limits. Loss of coordinator
connectivity cannot expand worker authority.

### 10.2 Initial transport

- one-time enrollment token;
- device keypair and mutual TLS;
- outbound WebSocket or HTTPS long poll;
- short-lived signed job leases;
- idempotent events and explicit uncertain-action states;
- artifact exchange by content digest;
- revocation and key rotation;
- no raw environment dumps or credential transfer.

Existing managed SSH support may bootstrap a private endpoint, but the product worker should not
depend on parsing arbitrary SSH configuration forever.

### 10.3 Execution-provider integrations

If remote execution is earned, first test whether an existing provider such as Coder, E2B, Daytona,
Modal, or the team's current developer platform can satisfy it. A Camus worker interface should be
introduced only for contract, custody, or evidence requirements those integrations cannot meet.

## 11. Studio product brief

The pilot Studio should make one contract and one proof understandable. It must not become a
portfolio dashboard before users repeatedly complete the thin loop. Its first experience is:

1. import or describe a real task;
2. inspect and edit the inferred acceptance contract;
3. choose or accept an evidence-backed route recommendation;
4. run the existing engine; and
5. inspect/share the exact proof at the pull-request decision point.

Contract and evidence capture should be automatic wherever repository configuration, CI, or the
selected harness already knows the answer. Manual authoring is reserved for intent that cannot be
inferred safely.

### 11.1 Earned target-state information architecture

1. **Work** — all contracts/runs across projects, grouped by state and attention need.
2. **New job** — contract input and Architect Preview.
3. **Run** — strategy timeline, evidence, candidate, route history, and one next decision.
4. **Compare** — A/B experiments, calibration, and route evidence.
5. **Workers** — local/VPS/cloud capacity and trust state, only if the worker gate is met.
6. **Policy** — organization routes, limits, models, data, credentials, and controls.

Connections, model qualification, reviewer admission, and external context systems belong under
Policy or Compare. They are supporting infrastructure, not the first experience. Do not reproduce
XIRP/Portal's session grid or knowledge catalog merely to fill this navigation.

### 11.2 Work screen

The default view answers:

- What is actively progressing?
- What needs me, ordered by stakes and age?
- What is blocked by infrastructure versus product ambiguity?
- Which work is done and what standing did it earn?
- What are we spending and where is accounting unknown?

Each row shows project, objective, current phase, route, evidence standing, progress signal, budget,
and next action. It must not use spinner activity as a proxy for progress.

### 11.3 Run screen

The primary visual is a compact strategy timeline:

```text
Architect ✓ → Implementing (Claude Code · local worker) → Verify → Review (Luna) → Human accept
```

Below it, present candidate changes, checks, findings, decisions, and costs. Raw transcripts and
receipts remain available under evidence disclosure. Route changes appear in the timeline and cannot
be hidden.

### 11.4 Attention inbox

Every human card contains:

- exact question or action;
- why Camus could not decide;
- stakes and reversibility;
- evidence and recommendation;
- effect on cost/time/scope;
- choices with a safe default where one exists; and
- the artifact/contract revision the decision will bind.

Routine test repair, safe recovery, and progress narration never enter the inbox.

### 11.5 UX success measures

- time from request to an authorized plan;
- percentage of runs requiring no mid-run human interruption;
- avoidable-question rate;
- time from attention card to informed decision;
- completion with quality floor met;
- outcome survival after merge/acceptance;
- cost and wall time by accepted outcome, not by token alone;
- successful resume after app or worker interruption; and
- comprehension: a user can explain who did and reviewed the work and what remains uncertain.

Accessibility remains a release gate: keyboard operation, focus order, semantic headings, status not
encoded only by color, live-region restraint, reduced motion, mobile hierarchy, and readable proof
artifacts.

## 12. Security and responsible autonomy

The existing responsible-control-plane rule remains binding: input screening, tool/action
authorization, and output screening are separate controls with explicit failure directions.

New threats introduced by this RFC include:

| Threat | Required response |
| --- | --- |
| Planner prompt injection from issue, repo, or tool output | Treat all content as untrusted; schema-constrain proposals; kernel validates authority independently. |
| Route chosen to favor the planner's own vendor | Record overlap; use outcome evidence; allow policies and independent comparison; never infer independence from a label. |
| Silent model/harness/provider substitution | Bind requested, resolved, reported, and observed identity each phase; keep unprovable facts unknown and refuse unauthorized differences. |
| Cost laundering across subscription/API/gateway paths | Record billing authority and unknown accounting; route only within the approved authority. |
| Handoff drops an open failure | Capsule coverage checks compare every unresolved finding and criterion before the next phase starts. |
| Remote worker compromise | Least privilege, dual local/coordinator enforcement, signed leases, revocation, scoped secrets, sandbox class, auditable actions. |
| Malicious coordinator asks for wider action | Worker revalidates contract and policy; fail closed. |
| Router overfits a small or stale eval set | Minimum coverage, time/version expiry, uncertainty, holdout evaluation, shadow stage, abstention. |
| Human approval fatigue | Route by stakes and reversibility; measure avoidable prompts; batch only compatible low-stakes decisions. |
| Outcome telemetry leaks source or business data | Local/private by default; structured aggregates; explicit opt-in and retention; never upload source or raw prompts by default. |

High-stakes actions always preserve the human checkpoint unless a separate, narrow organization
policy explicitly proves and authorizes automation. No release may market general safety,
compliance, or fairness based solely on these controls.

## 13. Business model and go-to-market hypothesis

### 13.1 Free core

The local CLI, one local Studio, contracts, evidence, adapters, manual model/harness selection,
local execution, and offline evals remain useful and MIT. This grows trust, integrations, and a public
standard rather than holding basic integrity behind a subscription.

### 13.2 Paid product

The first paid hypothesis is the trust layer teams do not want to recreate in every repository:

- pull-request checks and evidence-bound handoff reports;
- reusable repository/team acceptance packs;
- SSO/RBAC, policy, audit, retention, and approvals;
- private outcome capture and route recommendations;
- GitHub/GitLab and CI integrations;
- managed upgrade and compatibility qualification; and
- enterprise deployment/support.

Shared portfolio coordination, remote worker fleets, broader issue/chat integrations, and capacity
scheduling are expansion hypotheses, not part of the first commercial offer.

Inference can remain customer-paid through subscriptions, provider APIs, gateways, or local models.
This aligns Camus with outcome quality and control rather than token markup.

### 13.3 Initial design-partner profile

- 5–50 engineers;
- actively uses at least two agent/model products;
- reviews enough agent-authored pull requests for trust or rework to be visible;
- uses at least one existing PR/CI workflow Camus can enter without replacing the IDE;
- cares about provenance, acceptance quality, supervision time, or reliable unattended work;
- can supply repeatable real tasks and later outcome labels; and
- has one engineering leader willing to review weekly evidence.

The first ten interviews test the problem and buying process before a price is selected. A concierge
pilot may be free only when it produces agreed evidence quickly; charge as soon as a team repeats the
workflow or requests retention, policy, integration, or support. Per-seat and team-platform pricing
must be tested against existing code-review budgets. The earlier $2k–$5k remote-coordination pilot
assumption is withdrawn until remote coordination itself is requested.

### 13.4 Funding proof

Camus becomes venture-credible through evidence, not feature count. Before treating fundraising as
the primary plan, target:

- 5 design partners, at least 3 paying;
- 100+ real, non-fixture contracts across multiple repositories;
- evidence that reviewers open the report and that it changes or accelerates merge decisions;
- a measured reduction in human interruptions or supervision time;
- equal or better accepted-outcome rate at a meaningfully lower cost/time for at least one task class;
- manual handoff evidence only if teams encounter enough costly stalls to justify it;
- repeat use by teams without the founder operating the loop; and
- a clear explanation of why Camus's private outcome data and contract ecosystem improve with use.

Those results support either accelerator/seed fundraising or customer-funded growth. Without them,
the product remains an impressive open-source control system but not yet a proven venture company.

## 14. Delivery roadmap

The roadmap is evidence-gated. Version numbers are planning labels, not release commitments.

### 14.1 Phase 0 — discovery before platform work

**Goal:** prove that agent-authored work creates an urgent acceptance or review problem for a buyer.

- interview ten engineering leads, platform owners, or high-volume agent users;
- observe their current issue → agent → PR → review workflow rather than asking only hypothetical
  questions;
- record rejected PRs, rework, reviewer time, trust failures, and existing review-tool spend;
- recruit at least three teams willing to run the same thin pilot on real work; and
- select one launch workflow. Default hypothesis: an agent-PR trust gate. Secondary hypothesis:
  issue-to-PR completion with the same proof.

**Gate:** do not expand the architecture unless at least three teams supply real tasks and agree in
advance which observed result would make them repeat or pay. If the pain is not repeated, reposition
before adding infrastructure.

### 14.2 Phase 1 — minimum validation loop

**Goal:** test whether a portable acceptance contract and proof change real decisions.

- contract v0: objective, non-goals, acceptance checks, budget, stakes, allowed side effects, and the
  minimum identity fields required by the current engine;
- an editable Architect Preview using the current planner and admitted evidence—no new planner
  service;
- the existing local execution path unchanged;
- one optional manual artifact-and-obligation handoff at a sealed phase boundary;
- the existing verification, review, and receipt presented as a concise PR check/handoff report;
- consented outcome labels for merged, rejected, corrected, reverted, or later-failed work; and
- automatic capture from repository, harness, Git, and CI state wherever possible.

Explicitly excluded: worker/coordinator, event-source inversion, automatic routing or switching,
portfolio Studio, organization product, A2A, new model adapters, and generic institutional memory.

**Pilot gates:**

- contract setup median under two minutes and at least 60% of previews accepted without material
  editing; stop or redesign if more than 40% of tasks bypass it;
- at least 30 agent-authored PR decisions, with the report still opened after week two;
- measurable reviewer-time reduction or at least three merge/reject decisions changed by the proof;
- at least three teams repeat the workflow without the founder operating every run; and
- handoff earns a roadmap slot only if it occurs at least weekly for a team and rescues at least 30%
  of attempted stalls more cheaply than restart.

### 14.3 Phase 2 — harden the accepted contract

**Goal:** productize only the kernel changes the successful pilot requires.

- Camus Contract v1 schema and validator extending current checkpoint semantics;
- complete route identity for model, harness, provider, billing authority, and reviewer;
- one unified evaluation vocabulary across code and words lanes;
- the checkpoint remains authoritative; add only idempotency, preconditions, and a decision journal
  needed for evidence or recovery;
- read-only CLI, Studio, and PR projections from the same source of truth; and
- compatibility mapping that preserves sealed history and the current admitted proof gate.

**Acceptance:** old and new runs retain identical authority and provenance, and the pilot workflow
does not require users to understand internal schema machinery.

### 14.4 Phase 3 — recommendations and private learning

**Goal:** make route advice useful before claiming automatic optimization.

- reuse accepted contracts and acceptance packs by repository/task archetype;
- capture complete route, review, cost, override, and later outcome evidence with consent;
- combine explicit rules, current qualification, public priors, and private team evidence;
- show a recommendation, reason, uncertainty, and abstain path;
- run shadow and paired experiments with holdouts, expiry, drift checks, and calibrated judges; and
- keep sparse or biased evidence at recommendation standing.

**Gate for automatic routing:** a bounded task class meets the existing admission thresholds,
recommendation overrides remain below 20% for four consecutive weeks, quality does not regress, and
rollback is immediate. Cross-customer pooling is privacy-preserving and opt-in, or it does not happen.

### 14.5 Phase 4 — earned extensions

Each extension has an independent demand gate:

- **Adaptive handoff:** frequent stalls and the Phase 1 rescue threshold.
- **Remote worker:** at least three teams request it unprompted, willingness to pay is present, and
  provider terms permit the required subscription or API execution mode.
- **Portfolio/attention surface:** users actively supervise enough concurrent contracts that the PR
  and existing run surfaces no longer suffice.
- **Hosted organization product:** retention, policy, integration, and access-control requests recur
  across design partners.

Implement the smallest qualified extension and re-measure. None is bundled merely to make Camus look
like a complete platform.

### 14.6 Phase 5 — trusted execution plane, if earned

The original control-plane vision becomes valid only after the preceding loops show repeated use and
payment. It may then include bounded automatic adaptation, customer-owned workers, a team attention
inbox, organization policy, and portfolio optimization. Every expansion continues to use the same
acceptance, custody, identity, evidence, and outcome contracts; no model may grant itself authority.

## 15. What not to build yet

- A new general chat UI or code editor.
- An unlimited autonomous agent hierarchy.
- A proprietary VM/sandbox cloud.
- A customer-owned worker or hosted coordinator before its demand gate.
- A competing institutional-memory or session-management system.
- A portfolio mission-control redesign before concurrent pilot usage requires it.
- A universal “best model” leaderboard.
- Per-token resale infrastructure.
- Automatic merge/deploy/publication.
- Cross-customer training on source, prompts, diffs, or outcomes.
- A2A support without a concrete external-agent integration.
- An opaque ML router before rules, evals, and outcome data justify it.
- Broad compliance certifications before design partners establish the required market.

## 16. Kill criteria and product risks

The plan should be challenged, not protected from evidence.

Pause or narrow the company thesis if, after design-partner pilots:

- teams prefer the routing and trust built into one dominant IDE and will not adopt a neutral layer;
- contract setup costs more attention than it saves;
- teams do not switch models/harnesses often enough for neutral routing to matter;
- independent proof does not change merge decisions or reduce rework;
- remote workers are the valued feature but can be bought more simply from Coder/Ona/Cursor;
- route evidence cannot generalize even within a team's repeated task classes; or
- users will not pay for shared control while the local core solves their whole job.

The primary implementation risk is building every surface before validating the wedge. The first
pilot tests one thin loop: contract → recommendation → existing execution → proof → PR decision →
later outcome. Manual handoff is a separately measured branch, not a required step in every run.
Portfolio scale and enterprise controls follow only when that loop is valuable.

## 17. Product and research metrics

North-star candidate:

> **Trusted accepted outcomes per human-attention hour.**

Supporting metrics:

- quality-floor pass and later survival rate;
- accepted outcomes per dollar and per active hour;
- human interruptions per completed contract;
- avoidable interruption and false-auto rates;
- route recommendation acceptance and override reasons;
- handoff recovery/success rate;
- percentage of cost with known billing authority;
- model/harness qualification time after a catalog change;
- weekly teams completing more than one contract; and
- design-partner retention and willingness to pay.

Vanity metrics—model count, raw runs, tokens, agent concurrency, GitHub stars, and npm downloads—do
not establish product value by themselves.

## 18. Research sources and evidentiary limits

Checked on 2026-08-31. Product pages describe vendor capabilities and claims; they are not
independent performance measurements.

### Product and market references

- [OpenAI: Codex App](https://openai.com/index/introducing-the-codex-app/)
- [VS Code: Multi-agent development](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [Claude Code subagents and agent teams](https://code.claude.com/docs/en/agents)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
- [Cursor Router](https://cursor.com/docs/cursor-router)
- [Cursor Automations](https://cursor.com/docs/cloud-agent/automations)
- [Cursor PR routing and approval](https://cursor.com/docs/approval-agents)
- [Factory](https://factory.ai/)
- [Factory Router](https://factory.ai/product/router)
- [Factory Missions](https://factory.ai/product/missions)
- [Ona](https://ona.com/)
- [Coder AI agents](https://coder.com/docs/ai-coder/agents)
- [Coder Agent Firewall](https://coder.com/docs/ai-coder/agent-firewall)
- [GitHub enterprise agent management](https://docs.github.com/copilot/concepts/agents/enterprise-management)
- [Orca](https://www.onorca.dev/)
- [Superset](https://superset.sh/)
- [Spotify XIRP](https://xirp.spotify.com/)
- [Spotify: scaling AI coding agents with XIRP and Portal](https://portal.spotify.com/blog/introducing-xirp)
- [Spotify: context engineering for background coding agents](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2)
- [Spotify: predictable results through feedback loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)
- [Omnigent](https://github.com/omnigent-ai/omnigent)
- [Zeroshot](https://github.com/the-open-engine/zeroshot)
- [MartinLoop](https://github.com/Keesan12/martin-loop)
- [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)
- [Fractal](https://github.com/plasma-ai/fractal)

### Routing, durability, evaluation, and protocols

- [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router)
- [BEST-Route research](https://arxiv.org/html/2506.22716v1)
- [Proof-Carrying Agent Actions](https://arxiv.org/html/2606.04104v1)
- [OSuite PCAA](https://ond.cc/research/pcaa)
- [Agent-as-a-Router](https://arxiv.org/html/2606.22902v2)
- [Harness-Bench](https://arxiv.org/html/2605.27922v1)
- [Test-Driven AI Agent Definition](https://arxiv.org/html/2603.08806v1)
- [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [OpenAI harness engineering](https://openai.com/index/harness-engineering/)
- [Datadog harness-first agents](https://www.datadoghq.com/blog/ai/harness-first-agents/)
- [Temporal: durable multi-agent systems](https://temporal.io/blog/durable-flexible-multi-agent-systems)
- [OpenHands conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- [Microsoft Agent Framework human-in-the-loop workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop)
- [Braintrust: evaluating agents](https://www.braintrust.dev/docs/best-practices/agents)
- [Anthropic: demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [MCP](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro)
- [ACP](https://agentclientprotocol.com/get-started/introduction)
- [A2A](https://a2a-protocol.org/latest/)
- [AGENTS.md](https://agents.md/)
- [E2B](https://e2b.dev/)

### Audit inputs

- [External architecture and market audit](https://claude.ai/code/artifact/b8aabae7-b793-4491-b643-0038e6c57420)
- [Internal hostile moat battle test](./CAMUS-MOAT-BATTLE-TEST.md)

The external audit's product counts, market estimates, protocol-window estimate, and competitor
interpretations are research inputs rather than Camus-measured facts. This RFC adopts conclusions
that also survive repository inspection and primary-source review; it does not turn an auditor's
confidence score into product evidence.

## 19. Decisions recorded and open questions

Recorded product decisions:

1. Initial paid ICP hypothesis: engineering teams of 5–50 people reviewing meaningful volumes of
   agent-authored work; solo developers remain the open-source funnel.
2. Deployment now: local-first core embedded into Git/PR/CI workflows. Coordinator and remote worker
   remain separately gated options.
3. Commercial boundary to test: local MIT core is free; team policy, retained evidence, PR/CI
   integration, private outcome analysis, access control, and support are paid candidates.
4. Routing goal: optimize quality and reliability first, then human attention, cost, and latency.
5. Handoff means artifact-and-obligation transfer at a sealed phase boundary, not private session
   migration. It remains manual until measured rescue value earns automation.
6. Context, harness operation, and fleet/session management belong to the systems already good at
   them; Camus consumes their outputs and owns the acceptance/proof boundary.

Open product validation—not architecture decisions to guess in code:

- Which first repeated workflow hurts enough to pay for: issue-to-PR, maintenance backlog,
  incident repair, migration, or security remediation?
- Will users describe the value as trust, supervision reduction, cost optimization, or throughput?
- Is the first team buyer an engineering manager, platform lead, or AI tooling lead?
- How much contract authoring can be inferred before users perceive it as overhead?
- Which outcome can reliably be observed after merge without invasive telemetry?

Only Phase 0 discovery and the minimum Phase 1 pilot are approved by this RFC. No broad Studio
redesign, automatic router, worker/coordinator, event-source rewrite, or organization build is
authorized. Findings from the first ten interviews may still change the wedge before implementation.
