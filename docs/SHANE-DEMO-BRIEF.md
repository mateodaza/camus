# Shane / Myosin Learns demo brief

Last updated: 2026-07-19

This is the durable source for the short presentation and recorded Myosin Learns demo. It captures Shane Farrell's questions, the use cases he wants to see, and the factual boundaries the presentation must preserve.

## Presentation rule

**Show rather than tell. Use concrete before/after evidence wherever possible.**

**Rehearse and present from the sealed receipts, not from live provider calls.** A finished run replays from disk with no models involved, so the demo cannot be derailed by latency, a provider outage, or a fresh run reaching a different verdict. Live running is optional upside, never the plan.

The primary proof is Studio run `20260719-093340-9fuc`: eight Hivemind items were captured and frozen under a single snapshot before drafting; Claude (`anthropic:claude-sonnet-4-6`) drafted the deliverable; GPT-5.6-sol, from a different vendor, raised four distinct blocking findings across three rounds, re-raising what was not fixed — invented executive experience, material claims lacking citation, limitations exceeding the cited excerpt, and a recommendation outrunning the evidence. The goal owner authorised one further round rather than settling, then accepted findings on the record. Deterministic checks passed with caveats. Standing is honestly **verified with findings**, not clean. Artifact `872816c02580`; nothing was published.

That last point is the argument, not a blemish: the run is more persuasive *because* it did not come out spotless. A spotless run would show less about how Camus handles disagreement, bounded human judgment, and recorded caveats.

The earlier golden run `20260714-101324-w7tv` (Sonnet's invented “DSP selection is binary” and “third-party verification”, rejected by GPT-5.4, repaired to a clean audit and 5/5 deterministic checks) is kept as a **fallback replay only**. It predates the grounding-snapshot fix, so prefer `9fuc`.

## Questions the presentation must answer

### Why use Camus instead of keeping everything in one LLM?

A single model can critique itself, but maker and critic share correlated blind spots and incentives. Camus separates execution from judgment, records the actual identities, and adds deterministic verification. The claim is not that cross-model review guarantees truth; it reduces correlated error and makes the result answerable to independent evidence.

### Why use Hivemind?

The LLM supplies general intelligence. Hivemind supplies organizational context and provenance that the general model does not possess. Camus binds the observed query, bounded result evidence, produced artifact, independent verdict, and human decisions into one receipt. Hivemind grounds the work; it does not replace the maker or auditor.

### How do you pick models for executor and reviewer?

Explain the decision by role, task risk, and economics rather than a universal leaderboard:

- Executor: choose for task fit, tool use, context handling, and production quality.
- Reviewer: choose for independence, defect-detection behavior, and sufficient reasoning effort.
- Higher effort or a more expensive model is justified when the acceptance contract or downside of error warrants it.
- Camus records requested, resolved, and actual identities so escalation or fallback remains visible.

The useful demonstration is stronger than same-goal: it is the **same sealed artifact** re-audited at low versus high effort, so the judged bytes are identical rather than merely similar. See the matched comparison below.

### How do I reduce token spend without compromising quality?

Shane's feedback about comparing effort levels and token efficiency makes this a natural question for the demo. It is best answered with an artifact rather than an argument — see beat 6 of the deck. The honest shape of the answer: **default efficient, escalate selectively, record the outcome, and keep the human responsible for consequential decisions.**

Note the precision this demands. Camus records **output tokens and elapsed time**. It does not record billing, and the runtime does not report the reasoning effort actually applied — receipts carry `billing unknown` and `cost not estimated` on purpose. Say "usage and time", never "cost".

## Use cases Shane wants explored

### Brand voice and thought leadership — first pilot

1. Retrieve or ingest a representative set of LinkedIn posts.
2. Derive a bounded brand-voice profile with cited examples.
3. Monitor relevant industry news.
4. Draft a timely thought-leadership post in that voice.
5. Have an independent model audit voice fidelity, news grounding, unsupported claims, and imitation risk.
6. Seal the source set, draft, verdict, and human decisions in the receipt.

Use the existing LinkedIn/Hivemind path where it genuinely exposes the necessary evidence. Do not claim arbitrary LinkedIn access or direct thread selection until those capabilities are verified.

**Status as of 2026-07-19: attempted, not completed. Present it that way — do not imply a working capability.** The full brand-voice workflow was stopped after three draft revisions; narrower evidence-card attempts were also stopped while testing repair shapes. The receipts preserve those drafts rather than hiding them, but none is an accepted, completed brand-voice workflow. The reviewers identified systematically misbound `[Hn]` markers, unsupported claims in sample copy, voice traits inferred beyond the evidence, and an attempted single-source contract that the runtime's additional retrieval did not honour.

Two findings came out of that refusal, and both are worth saying aloud because they are the pilot's real starting conditions:

1. **The contract and the deliverable type must be compatible.** In the attempted shape, the contract treated illustrative persuasive copy as if every sentence were a source-backed factual claim. That created a conflict the loop could not resolve cleanly. The next design should separate evidentiary sections (cited) from clearly-labelled illustrative copy, whose factual claims remain bounded even when its tone is judged separately.
2. **Retrieval scope and evidence scope are different things.** Studio's retriever is told to run several queries while a contract may demand a single captured excerpt; the receipt honestly retains every retrieval call, so the auditor refuses to pretend a single-retrieval contract was obeyed. Separating the two scopes, and freezing both in the manifest with requested-versus-actual, is the next substantive iteration — not a prompt tweak.

Framed honestly this is a strong pilot pitch: the workflow Shane wants is exactly the one where unverified brand voice is most expensive to get wrong, and Camus already refuses to fake it.

### Outbound research — discovery after brand voice

Explore whether exported LinkedIn connection data can identify credible second-degree introduction paths. The presentation must acknowledge the likely friction and risks:

- LinkedIn data may require a manual export.
- Personal data needs an explicit custody, consent, retention, and redaction policy.
- Hivemind or a dedicated MCP connector may reduce workflow friction, but capability and permissions must be proven before promising them.

## Product description and factual boundaries

- Camus is an independent trust layer for agent work: executor, auditor, deterministic checks, human checkpoints, and evidence custody.
- The loop is acceptance-contract anchored and round-bounded. Model output remains nondeterministic; the mechanical verification stage is deterministic.
- Cross-vendor review reduces correlated blind spots; it does not guarantee correctness.
- Orchestration, artifacts, and receipts stay local. Claude, Codex/OpenAI, and Hivemind calls use their online services and the user's existing authenticated subscriptions or credentials.
- Studio currently supports research memo, competitor teardown, freeform, and the developer build path. Do not advertise a model or connector option until Doctor and the live UI prove it.
- Managed Hivemind grounding currently proves knowledge-search tool use and captures result evidence. Do not describe it as arbitrary thread selection unless Hivemind adds and exposes that operation.
- Hivemind artifact publication is not currently available through the managed MCP path; a receipt may honestly be `not_published` while still independently verified.

## The deck — seven beats

Whenever a beat makes a claim about Camus, show the supporting receipt or Studio surface on screen rather than relying on narration alone.

**1. The accountability problem.** Agents now create faster than anyone can check. The bottleneck moved from making to *verifying*, and an organisation cannot act on work nobody can answer for. This is not a quality complaint about models; it is a question of who is accountable for the output.

**2. One model makes it. Another tries to break it.** You decide when the evidence is enough. Camus separates execution from judgment, records the actual identities of both, adds deterministic checks that cannot be sweet-talked, and routes the consequential calls to a human. The claim is not that cross-model review guarantees truth — it reduces correlated blind spots and makes the result answerable to independent evidence.

**3. Frozen evidence, then a draft, then objections.** Run `9fuc`. Eight Hivemind items were captured and frozen before drafting, so every later step judges the same snapshot. Claude drafts. GPT-5.6-sol — a different vendor — raises four distinct blocking findings across three rounds and re-raises what was not fixed: invented executive experience, uncited material claims, limitations exceeding the excerpt, a recommendation outrunning the evidence. Read one finding aloud verbatim; it is more persuasive than any summary.

**4. The human decides, and the standing stays honest.** The goal owner authorised one further round rather than settling, then accepted findings on the record so that decision travels with the artifact. The result is **verified with findings** — not clean. Camus did not round it up. This is the beat where the product's character shows.

**5. The sealed receipt, and “Why this standing?”** Artifact and receipt identities, executor and auditor actuals, effort, claim ledger, contract coverage, and the acceptance contract verbatim. On `9fuc`, open the derivation to show the four dimensions and the loop claim agreeing. Then, if time permits, open replay `20260719-103933-6ovo`: its loop claim says `done_with_findings`, but the receipt derives **not verified**, so the card turns red and states that the receipt is authoritative, not the claim.

**6. What requesting more effort changed in these runs.** The matched audit comparison: the same sealed artifact re-audited at low and high requested effort, same recorded auditor, grouped by artifact hash so the identical bytes are provable. Use this takeaway verbatim:

> With identical artifacts and the same recorded auditor, requested high effort produced 62% more output on the repaired artifact and 2.7× on the flawed artifact, without changing either decision. The runtime did not report actual applied effort, and this is only two comparisons—so it is calibration evidence, not a universal model verdict.

Then the direction it supports: **default efficient, escalate selectively, record the outcome, and keep the human responsible for consequential decisions.** Camus names no winner and claims no significance; it records what each arm found and used.

**7. The pilot ask — Myosin Learns.** Brand voice and monitored news as the first workflow, presented honestly: it was attempted, and the reviewer refused it for good reasons (see the use-case section). That refusal *is* the pitch — this is precisely the workflow where unverified brand voice is most expensive to get wrong. Ask for: a review of the framing, a trial of the brand-voice workflow once retrieval and evidence scope are separated, and the recorded Myosin Learns session. Outbound relationship research stays a later discovery track with its consent and custody questions unresolved.

## Rehearsal

Rehearse from these sealed receipts. They replay from disk with no models involved.

| receipt | beat |
| --- | --- |
| `20260719-093340-9fuc` | 3, 4, 5 — the primary proof |
| `20260719-103659-569z` / `-euuf` | 6 — repaired artifact, low vs high |
| `20260719-103933-6ovo` / `-4q63` | 5 — receipt/claim conflict; 6 — flawed artifact, low vs high |
| `20260719-085212-o09r` | the subject of the flawed pair; keep it, the comparison is meaningless without it |
| `20260714-101324-w7tv` | fallback only |

⚠️ **`runs/` is gitignored, so these exist only on this machine.** A verified portable copy is at `~/Documents/camus-demo-receipts-2026-07-19.tgz` (sha256 `11d9e899cfb779341cef34fe60d32b13e1c856004c46a2ae204ae9573d6aa0dd`, scratch worktrees excluded). Restore by copying a run directory back into `apps/loop-studio/runs/`. Do not commit them: the snapshots contain private Hivemind excerpts.

Studio runs locally on port 1913. Confirm before presenting: Setup shows Claude and Codex signed in and the Hivemind connector connected; Recents shows the two real audit-comparison cards.

## Meeting context

- Granola notes: https://notes.granola.ai/t/049ae07f-a8c3-4bf6-b9ad-a4b0ffd22aa8
- Shane's follow-up: “Show rather than tell. More concrete examples the better.”
- **Meeting: Wednesday 2026-07-22** — the recorded session promised for the week of 07-20. Audience is mostly marketers, not engineers: prefer plain language, and let the receipts carry the rigour.
- The earlier July 17–18 presentation target passed; this brief supersedes it.
