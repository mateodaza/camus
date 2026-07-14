# Shane / Myosin Learns demo brief

Last updated: 2026-07-14

This is the durable source for the short presentation and recorded Myosin Learns demo. It captures Shane Farrell's questions, the use cases he wants to see, and the factual boundaries the presentation must preserve.

## Presentation rule

**Show rather than tell. Use concrete before/after evidence wherever possible.**

The primary proof is Studio's golden live run `20260714-101324-w7tv`: Sonnet produced plausible but unsupported phrases such as “DSP selection is binary” and “third-party verification”; GPT-5.4 rejected them against the captured Hivemind result; one bounded human decision authorized another repair; the final audit was clean; all deterministic checks passed; and Studio sealed a non-degraded evidence pack with separate artifact and receipt identities.

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

The useful demonstration is the same goal and acceptance contract under low versus high reviewer effort, with findings, repairs, latency, and known costs compared honestly.

## Use cases Shane wants explored

### Brand voice and thought leadership — first pilot

1. Retrieve or ingest a representative set of LinkedIn posts.
2. Derive a bounded brand-voice profile with cited examples.
3. Monitor relevant industry news.
4. Draft a timely thought-leadership post in that voice.
5. Have an independent model audit voice fidelity, news grounding, unsupported claims, and imitation risk.
6. Seal the source set, draft, verdict, and human decisions in the receipt.

Use the existing LinkedIn/Hivemind path where it genuinely exposes the necessary evidence. Do not claim arbitrary LinkedIn access or direct thread selection until those capabilities are verified.

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

## Suggested short deck

1. **The problem:** agents create faster than humans can verify.
2. **The Camus claim:** another independent model is better positioned to judge the work than the maker itself.
3. **Show the loop:** executor → independent auditor → deterministic verification → bounded human decision → evidence receipt.
4. **Show the proof:** the golden Hivemind run, its exact overclaims, GPT's findings, the repair, and the verified receipt.
5. **Why Hivemind:** private organizational context plus provenance, bound into the audit rather than pasted into a prompt and forgotten.
6. **How model choice works:** role/task/risk/economics, followed by the low-versus-high effort experiment.
7. **Pilot:** LinkedIn brand voice plus monitored news; outbound relationship research as the next discovery track.
8. **Ask:** review the framing, trial the brand-voice workflow, and schedule the recorded Myosin Learns session.

## Meeting context

- Granola notes: https://notes.granola.ai/t/049ae07f-a8c3-4bf6-b9ad-a4b0ffd22aa8
- Shane's follow-up: “Show rather than tell. More concrete examples the better.”
- Presentation target discussed as July 18–19, 2026. Those dates are Saturday–Sunday; Friday–Saturday is July 17–18.

