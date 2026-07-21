# Shane / Myosin Learns demo brief

Last updated: 2026-07-19

This is the durable source for the short presentation and recorded Myosin Learns demo. It captures Shane Farrell's questions, the use cases he wants to see, and the factual boundaries the presentation must preserve.

## Presentation rule

**Show rather than tell. Use concrete before/after evidence wherever possible.**

**The proof rests on sealed receipts. Starting a live run is planned; finishing one is optional.** A finished run replays from disk with no models involved, so nothing load-bearing depends on latency, a provider outage, or a fresh run reaching a different verdict. The live run exists to show that a person can operate this — choose the roles, write a brief and a trust contract, press Run — not to supply the evidence. Camus is something users operate, not a gallery of prepared runs; the receipts are what make it accountable.

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

## Running order on the day

Use **two browser tabs** so the live run and the hero replay cannot disturb each other: tab A for the live run, tab B parked on `9fuc`. Never drive both from one tab.

1. **Slides** carry the thesis. The UI supplies proof; it should never be the thing the audience has to decode.
2. **Start one live run in tab A** so Shane watches a normal user choose the roles, write a brief and a trust contract, and press Run. Then leave it running.
3. **Switch to tab B** and walk `9fuc`: frozen evidence, the draft, GPT's objections, the human decision, the standing, the receipt and its derivation.
4. **Show the matched low/high comparison card** with the takeaway verbatim.
5. **Return to tab A** and take whichever outcome it landed on.

### Demo shape (agreed 2026-07-21)

**One short live run plus two prepared receipts.** The proof must never depend on
providers finishing during the call.

### The live task — messy notes to a safe announcement

Familiar to every marketer, fast to judge, and full of obvious traps for the
auditor. Freeform lane, Sonnet executor, GPT-5.6-sol reviewer at **low requested
effort**, **two-round cap**, roughly five minutes budgeted. **A human checkpoint
is a successful outcome, not a stall.**

**Goal**

> Turn the notes below into a 140–180 word LinkedIn announcement for a Myosin Learns session. Write for marketers who use AI but do not work in AI engineering.

**Notes supplied to the run**

> - Mateo will demonstrate Camus.
> - Camus puts one model's work through an independent model's review.
> - A person decides when the evidence is enough.
> - Attendees will see a live run and its sealed record.
> - Draft idea: "Camus reduces review time by 40%." No evidence supports this.
> - Draft idea: "Camus guarantees accurate AI work." This is not true.

**Trust contract**

> Use only the supplied facts. Explain the loop in one plain sentence. Do not include the 40% claim, guarantees, invented outcomes, or capabilities not stated above. Include one clear invitation, but do not invent a registration link, time, or venue. If an essential publishing decision is missing, ask me rather than guessing.

The room can check five things without any product knowledge: whether it rejected
the two planted claims, whether it invented event details, whether it explained
looping plainly, whether it respected the length, and whether it paused instead of
guessing. **The two planted claims are the point** — they are the traps, and
refusing them is the demonstration.

### The Hivemind task — what did we actually decide?

Prepare one short, recognisable Myosin thread in advance. **Choose a thread where
Shane or someone in the room already knows the answer; their recognition is the
strongest verification available.**

**Goal**

> Using only the frozen Hivemind evidence, tell us what the team decided, why it decided it, and what remains unresolved. Finish with a client-ready update of no more than 120 words.

**Trust contract**

> Every factual claim must trace to the frozen snapshot. Separate decisions from proposals. Name one unresolved question. Do not infer agreement from an unanswered suggestion. If the evidence conflicts, show the conflict rather than resolving it yourself.

This is the clearest demonstration of why Hivemind matters: the model supplies
capability, Hivemind supplies Myosin's context and provenance.

### Prepared proof, in a second tab

1. `9fuc` — the full accountability story.
2. The low/high comparison card — same artifact, different requested effort.
3. The brand-voice refusal, **only if asked** about that use case.

### Choreography

1. Start the announcement run.
2. While it works, open `9fuc`.
3. Show the reviewer's concrete objection.
4. Show the human decision.
5. Show the receipt overruling an unsupported completion claim.
6. Show the comparison card.
7. Return to the live run.

### The live outcomes, decided in advance

Say which one you are in, then continue. Do not troubleshoot on the call.

- **Finished** — open its receipt. A second, unrehearsed artifact with the same custody as the prepared ones.
- **Needs a human** — demonstrate the checkpoint. This usefully shows the bounded human decision: the loop paused rather than guessing, and what it wants is a call only the goal owner can make.
- **Still running** — "It continues locally and will seal its receipt when complete." Return to `9fuc` and move on.
- **Failed** — "The attempt failed; Camus preserves the failure trace." Return to `9fuc` and do not troubleshoot live. A failed run does not continue, and its trace is evidence of the failure rather than a complete replayable receipt like the prepared ones.

**For the recorded session, run one exact task rehearsed twice.** The five lines on the closing slide are pilot candidates, not a promise to execute five unrehearsed jobs live; the slide says so.

Do not predict which outcome will occur. The providers and loop are nondeterministic; the four responses above are the prepared paths, not a promise about the next run.

### Observed rehearsal — 2026-07-19 (of the SUPERSEDED task)

⚠️ This rehearsal ran the **earlier** announcement task, before the 2026-07-21 rewrite, and at a three-round cap rather than the two-round cap now specified. Its timings are indicative, not a forecast for the current task. **The current live task has not been rehearsed yet; do it twice before the session.**

Run `20260719-125205-zb99` It reached its first human checkpoint after **2m15s**. The goal owner chose **one more round**, then **stop** when the remaining high finding still described invented mechanics and the draft carried multiple calls to action. It completed three draft revisions and three independent review rounds; verification never ran.

The loop's terminal status is **stopped**. The receipt's derived standing is **not verified**, from `interrupted × not run × independent findings × not published`. Keep those two facts separate: “stopped” is what happened operationally; “not verified” is what the evidence supports.

Total wall time was 34m18s, but 30m15s of that was the two human-response waits. Runtime outside those waits was about **4m03s**. This is one rehearsal, not a latency forecast. Its practical lesson is only that a human checkpoint can arrive quickly enough to demonstrate live, while the prepared receipt remains the proof if it does not.

Do not describe the run's `$0.29` UI counter as cost. Its sealed economics remain `billing unknown` and `cost not estimated`; this demo reports usage and elapsed time, not billing.

## Meeting context

- Granola notes: https://notes.granola.ai/t/049ae07f-a8c3-4bf6-b9ad-a4b0ffd22aa8
- Shane's follow-up: “Show rather than tell. More concrete examples the better.”
- **Meeting: Wednesday 2026-07-22** — the recorded session promised for the week of 07-20. Audience is mostly marketers, not engineers: prefer plain language, and let the receipts carry the rigour.
- The earlier July 17–18 presentation target passed; this brief supersedes it.
- **Shane's skim feedback on the published deck (2026-07-21):** name the looping early, name Hivemind early and emphasize it, and keep slide time short — aim for an even split between slides and live demo. All three now land in the opening beat of the speaker notes; deck-order changes wait for his full review so they don't collide with it.
- Announcement copy suggested for Shane's session post: "Myosin Learns this week will be with Mateo, who's demo'ing a Looping tool that uses Hivemind to keep AI work grounded in Myosin's own knowledge. One model drafts, a second from a different company tries to break the draft, and the loop goes round until a person decides the evidence is enough. Live run, receipts included."
- **Superseded (2026-07-21): the intermediate 8-slide cut.** On Shane's skim feedback the 12-slide deck was compressed to 8: run-evidence slides moved into the live demo, effort economics compressed to one Q&A line, brand voice dropped. His deeper review then restored the four-lanes slide, giving the current nine. Recorded only so the jump from twelve to nine is not mistaken for a single edit.
- **Shane's deeper review of the live 12-slide deck (2026-07-21, 11:09).** He reviewed the published version, not the rework, so his numbering refers to the old deck. Five of his eleven points are comprehension failures ("I don't understand the receipt concept", "Don't understand this", "the text is a little unclear" ×2, "not clear from this slide"), which independently confirms the for-dummies diagnosis. Applied: **Looping** named on the title slide; his problem framing adopted ("Creating is cheap. Verifying is not." plus prompting-versus-looping); "vendor" removed everywhere; his step labels adopted (Describe the job / Set the standard / Choose the models); **a definition of "receipt" added** before the deck leans on the word, which it did five times without ever saying what one is; the **four-lanes slide restored** because his most enthusiastic note asked to see each lane demoed with real output. Resolved by deletion in the rework: his points 6, 8, 9, 11. Deck is now **9 slides**. Declined: "powered by Hivemind" in the title — it contradicts the pillar order and overstates it, because Hivemind grounding is optional on every writing lane.
- **Deck is now 10 slides (2026-07-21).** Shane's "simplify the language for the newbs" plus Mateo's instinct to show what looping is exposed the same gap: "loop" appeared on six slides and was defined on none. The crowded idea slide split in two — **slide 3 "It doesn't stop at the first draft"** (prompting versus looping, the draft/challenge/repair strip, and the stopping rule) and **slide 4 "No agent grades its own work"** (who is in the loop). Two simple slides read faster than one dense one for this audience.
- **Headline hierarchy (2026-07-21, final).** Slide 1 leads with the thesis, **"AI shouldn't grade its own work."** — the README creed in plainer words, since "agent" is jargon for this audience. The mechanism sits underneath as the subtitle: "One model makes it. Another tries to break it. You decide when the evidence is enough." Insight first, mechanism second, human authority last. Slide 4 therefore stopped wearing the creed and now introduces its four cards: eyebrow "Who does what", heading **"The jobs stay separate."** No two headings in the deck share wording, which is asserted at build time.
- **Plain-language rule for this audience.** No "orchestration", no "MCP" on screen (it lives in the notes for anyone technical), and the grounding eyebrow reads "Your own knowledge". "Output tokens" and "requested effort" stay because the audit requires that precision; gloss them aloud instead of rewriting them.
- **Demo plan implied by his point 5:** run **two** lanes properly rather than four shallowly, showing output rather than settings.
- **Rehearsal note:** "the page never scrolls with notes open" holds at 1600×900. At 1280×720 the notes panel scrolls on every slide and several slides scroll internally. Nothing the audience sees is affected, since notes are stripped from the published copy, but rehearse at the size you will present at.
- **Language the receipts do not support.** Never say "cheap", "expensive", or "worth paying" about a run. Receipts record output tokens and elapsed time and carry `billing unknown` / `cost not estimated`. Effort is *requested*, never observed, so say "higher requested effort", not "maximum effort". The current Q&A wording — "In two comparisons, higher requested effort used up to 2.7× the output tokens without changing either verdict" — is the safe form.
- **Hivemind framing (2026-07-21):** present it as an asset Myosin already owns, not as a patch for the model's ignorance. Slide 4 is "Your best strategist is already in the room"; the Q&A question is "What does Hivemind bring?", not "Why Hivemind?". The pitch's own pillars stay first: automation, reliability, accountability. Hivemind plugs in — grounded runs use it, ungrounded runs do not, and any writing lane can be either.
- **Grounding is a per-run switch, not a property of the lane.** Any writing lane can be grounded in Hivemind or run without it — `verify.test.mjs:574` runs `lane: 'freeform', ground: true`, and Studio sends the toggle for every writing lane. Earlier drafts of this brief and the speaker notes said freeform skips retrieval; that was wrong. The correct line is **grounded runs use Hivemind, ungrounded runs do not**. "Powered by Hivemind" is still declined, but because grounding is optional, not because freeform cannot use it.
- **The origin story, as Mateo tells it (use this, not a generic one).** In January 2026 he was running the loop by hand: Claude drafted, he pasted it into GPT and asked what was wrong, carried the objections back, and repeated until it held. The human checkpoint is in the product because he *was* the checkpoint. He automated the carrying via Nightcrawler (progress watched over Telegram through OpenClaw), then deprecated it when headless API usage became too expensive, and rebuilt the same deterministic loop to run locally under the operator's own model logins. Two facts this implies were missing from the deck and are now in it: **custody** (slide 6) and **model durability** — the loop is not tied to any model, so it improves as they do.
- **Custody wording is fixed.** Use the landing's approved form: orchestration and records stay on your machine, drafts go to the providers you already authenticate, Camus does not bundle or proxy subscriptions. Never say "nothing leaves your machine" — the drafts do. The build refuses "never leaves", "fully private" and "we never see".
- **Provenance to state plainly:** Camus was built for code first, where tests give deterministic evidence about specified behaviour, and adapted for words once the loop held up. It is on the lane slide's notes and is a credibility point rather than a caveat.
- **MCP connector work is DIRECTION, not capability.** Richer MCP connectors inside Hivemind are the answer to the brand-voice sourcing gap and are named that way on the deck ("richer connectors into Hivemind are how it gets solved"). Keep it future-tense in every telling. Per the boundaries above, connector capability and permissions must be proven before they are promised, so do not let it drift into "Hivemind now lets it read LinkedIn" during Q&A.

## Publishing the deck

The presentation is served at **`camus.sh/myosin/`** from a single committed file,
`apps/web/public/myosin/index.html`. That file is a **build output**, not the source.

**The source is `~/Documents/camus-demo-slides-2026-07-19/deck.html`**, outside this
repo, together with its `fonts/` and `brand/` folders. It carries speaker notes; the
published copy does not.

To regenerate after editing the deck:

```
node ~/Documents/camus-demo-slides-2026-07-19/build.mjs
cd apps/web && npm run build
```

`build.mjs` lives beside the deck. It inlines every font and brand SVG as a data
URI, strips every `data-notes` block and the notes UI, removes authoring
comments, swaps the notes toggle for visible previous/next buttons, and adds the
page meta (`noindex`, canonical, Open Graph).

Two properties make it safe to rely on. Every structural edit must match the deck
exactly once and names itself when it does not, so an edit that shifts an anchor
fails the build rather than silently skipping a transform. And nothing is written
until both outputs are built and validated against the presenter-token and
required-element lists, so a late assertion cannot throw over a good published file
that has already been replaced. Writes go to a temp file and rename, so an
interrupted run cannot leave a truncated page at the published path.

It writes
`apps/web/public/myosin/index.html` by default, resolved relative to its own
location; pass `--site <path>` to write elsewhere, or `--fragment <path>` to also
emit a head-and-body-less copy for a host that supplies its own shell.

Two consequences worth remembering:

- Editing `apps/web/public/myosin/index.html` directly is lost on the next
  regeneration. Edit the deck source and rebuild.
- The second command is not optional: `npm run build` is what copies `public/` into
  `out/`, and `out/` is what deploys.

Once the session is recorded and the deck stops changing, collapse this: either move
the deck source into the repo, or declare the published file authoritative and retire
the external folder. Two sources of truth are acceptable while it is still in flight,
not afterwards.
