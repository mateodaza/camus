# Camus

**Makes it work. Knows when to stop.**

New in 0.4.11: `camus code-eval fixture --case` adds a deterministic balanced
job-event/scheduler repair beside the original simple parser case. Candidate
integrity is now mechanical: only the selected fixture's declared solution paths
may change, and a test, ignored, extra, deleted, or symlinked-file mutation is
refused before verification. The runner remains a one-cell native smoke—not a
raw/native comparison, winner, or routing system. See [independent coding seats](docs/INDEPENDENT-CODE-SEATS.md#bounded-native-smoke-evidence-experimental).
Current evidence-backed model/harness guidance, including the first live Qwen
raw-versus-native result and the sealed Grok findings, lives in the
[recommended model and harness setup](docs/RECOMMENDED-MODEL-SETUP.md).

The 0.4.10 release introduced the tightly bounded, append-only Qwen Code or Grok
Build smoke. Fixture inspection, planning, status, and crash sealing are
spend-free; each live cell needs fresh literal consent and has no routing or
admission authority.

The 0.4.9 [Productive Loop](docs/PRODUCTIVE-LOOP-PLAN.md) added bounded repair,
private checkpoints, shared CLI/Studio continuation, and explicit native maker
harnesses. `codex_native`, `qwen_native`, and `grok_native` remain maker-only,
experimental executors; the latter two keep real provider keys outside the worker
behind a one-model gateway and qualified macOS sandbox. Maker model/backend,
harness, and reviewer remain independent choices. Every Any-model candidate is
non-gating and requires human acceptance.

The native proof gate runs a coding task from plan to verified commit:
Claude writes the code, Codex (a competing model) reviews
every change, and your repo's own type-check and tests have the final word. Nothing in
the loop, Claude included, can approve itself. The pairing is the point.

Two judges can disagree, so Camus is also built for the run that does not go cleanly:
review loops are bounded, a stalled review becomes a decision on your desk instead of
burned rounds, and a crash at any point resumes without redoing proven work.
*A craftsman knows how to work; an artist knows when to stop.*

The preferred runtime is now a native local driver: `camus start` creates canonical
feature state without a model turn, and `camus run` gives each task to a durable maker,
calls the independent reviewer directly, and lets code own Git, recovery, verification,
and landing. The original Claude Code workflows remain available as compatibility
surfaces: `/camus-plan` turns a raw request into a quality-gated task list,
`/camus-loop` takes one task, and `/camus-feat` ships an ordered task list.

**New here? Start with the [five-minute quickstart](QUICKSTART.md)** for code, Loop
Studio, or agent-supervised operation.

```
plan → implement → [ Codex review ↔ fix ]* → commit gate → dep prep → verify
       full posture: loops while P0/P1/P2 findings remain, round cap 3
       oneshot posture: one review, one repair, no re-review — verify still decides
```

## Try it

The native proof gate needs [Claude Code](https://code.claude.com) and the
[Codex CLI](https://github.com/openai/codex) (`codex login`). Experimental
`camus build` needs only the backends you choose, Node 18.17+, and Git.

```bash
npm i -g camus-cli@0.4.11
camus install        # frozen copy of the gate into ~/.claude — what you ran is what runs
camus check          # exit 0 = installed matches the package
```

```json
{
  "feat": "Harden input boundaries",
  "tasks": ["Validate the boundary and add regression coverage."],
  "targetPath": "/absolute/path/to/your-repo"
}
```

```bash
camus start feature.json   # model-free initialization; prints the featId
camus run <featId>         # durable Claude maker + direct Codex review
camus eval                 # local quality, speed, and usage evidence
```

The run ends in a report, never a shrug: `done` is earned by a clean review plus your
own tests; anything less arrives as a named halt with the remedy in the note
(`camus status` shows the board). Budget guidance, postures, and every env lever:
[`packages/cli/README.md`](packages/cli/README.md).

### Public alpha: 0.4.11

Choose both coding roles independently in the CLI or Studio: Luna → Claude,
Claude → Qwen, Grok → Qwen, or any other available, role-qualified pairing.
`camus build --maker <backend>:<model> --reviewer <backend>:<model>` and Studio
**Build → Any-model candidate** share their catalog, adapters and candidate engine.
Same-model pairings are allowed but never called independent. These candidates
always require human acceptance; the legacy native gate is unchanged.

Productive runs can now repair deterministic verification failures and bounded
review findings, resume the same private candidate across CLI and Studio, preserve
questions/answers and accounting, and stop repeated discovery instead of buying
more identical turns. Native Codex, Qwen Code and Grok Build are explicit maker
executors. Qwen/Grok use digest-pinned vendor artifacts, an outer macOS arm64
Seatbelt worker, and a host-owned exact-model credential gateway. Raw API/file-
action execution remains available and is still the default.

Studio's new blinded calibration workspace replaces repeated terminal labeling
with private autosaved drafts, explicit immutable labels, separate human/proxy
authority, safe navigation and measured timing. It does not run judges or grant
admission. Native recovery also preserves operator-assisted provenance, deduplicates
Claude usage and allows an explicitly recorded one-round advisory skip.

Code Harness Eval v1a freezes one native smoke cell, exact model/provider
identity, harness artifact, verifier, reviewer and spend bounds before execution.
It now offers one simple and one balanced case, with edits mechanically confined
to each fixture's declared solution paths before the verifier may run.
Live Qwen/Grok failures remain in the evidence denominator, uncertain turns never
replay automatically, and the command has no admission, routing, Git-landing or
publication authority. The first simple-task evidence provisionally favors raw
Qwen actions; Grok Build produced the exact fix under its harness but exhausted
the frozen turn budget before a definitive terminal. Neither result is a general
model ranking.

No new reviewer admission, automatic route, matched harness comparison, or
optimal pairing is claimed. See the
[0.4.11 release notes](docs/RELEASE-0.4.11.md).

### Existing admission infrastructure

Camus 0.4.7 ships the experimental infrastructure needed to decide whether an external reviewer
has earned production trust—without granting that trust. A public 25-case corpus, resumable
spend-bounded live campaigns, content-addressed attempt receipts, conservative statistical
eligibility, expiring human-owned admission records, and opt-in task-class routing now form one
fail-closed path. The checked-in admission registry is empty, so Grok and every other external
reviewer remain explicit shadow experiments; Codex is still the only production reviewer gate.

Loop Studio can qualify declared Grok, Kimi, Qwen, local, or other OpenAI-compatible seats over
loopback, direct HTTPS, or a Camus-owned SSH forward. The accepted capability receipt, observed
identity, transport, connection, and lineage stay bound through the run and sealed evidence pack;
missing, stale, substituted, or tampered evidence fails closed. Managed SSH is forward-only, owns
its lease and teardown, redacts diagnostics, and never falls back to a direct connection.

The CLI has a versioned reviewer contract and an exact-match dispatcher. It recognizes Codex,
Qwen Code, Grok CLI, and a hermetic OpenAI-compatible HTTP candidate, but **Codex remains the only
reviewer admitted for production routing**. Every additional backend returns
`reviewer_benchmark_disabled` until Slice G's provider-backed evals meet the declared quality and
transport thresholds. Shadow experiments are explore-only and deliberately name no external-model
winner; Codex agreement is evidence, not human calibration. Responses transport remains later work.
See the [0.4.7 release notes](docs/RELEASE-0.4.7.md).

Studio now includes a local connection editor, a shared responsible control plane, and the offline
half of the Slice G admission harness. Connection templates cover xAI,
Kimi, DashScope, Ollama, LM Studio, llama.cpp, vLLM, generic HTTPS, and private servers over SSH;
saving a declaration is spend-free and grants no trust. Exact qualification is a separate,
human-authorized provider action with live redacted progress. Input screening, exact action
authorization, and output screening leave versioned receipts without changing the immutable
evidence-pack schemas. Benchmark attempts are append-only and compared with conservative
intervals; even a statistically passing candidate still requires human admission. None silently
promotes today's candidates: the first Grok campaign has sealed all 24 spend-free kill controls
and two post-fix normalized quality cells, but 414 provider-backed quality cells remain pending;
the admission registry is empty, and routing holds on incomplete human calibration. The dormant compatibility-
workflow activation lane now also requires the dispatcher-issued exact `admit1:` authority in the
accepted reviewer binding. See the
[Slice E status](docs/SLICE-E-STATUS.md) and [Slice G status](docs/SLICE-G-STATUS.md).

## Makes it work

- **A competing model reviews every change.** Codex judges, a thin runner relays its
  JSON verbatim, and every round leaves a verdict file plus a full event-stream audit
  dir under `~/.camus/reviews/`.
- **Your own tests are the last word.** The verifier auto-detects the stack or runs
  `CAMUS_VERIFY_CMD`; finding no verifier at all is a loud failure, never a pass.
- **A broken environment never reads as broken code.** A reviewer crash is retried as
  infra; a missing toolchain is `inconclusive`, never `failed`.
- **Work provably lands.** A commit gate seals each task, merges demand consistent git
  evidence, and a postflight self-audit proves every task branch is in feat history
  before the feat may report done.
- **The gate catches its own drops.** A containment guard halts agents that leak edits
  into your main tree, a "no-op" with unmerged commits is rescued into an auto-land,
  and a crash between commit and merge restores the true verdict on resume.
- **The gate doesn't trust its own runners either.** Every merge report is cross-checked
  against the receipt `merge.sh` wrote as it computed the verdict, and a gating verify
  goes red if any tracked file changed around it — so a runner that hand-resolves a
  refused conflict, or "fixes" the code under verification, buys a halt, not a green.
- **Gate-owned git runs hookless and unsigned**, so repo hooks and forced signing
  cannot abort unattended commits — and Camus never pushes, by construction.
- **Real tasks become local eval evidence.** Assignment and reporting stay segmented by exact
  experiment generation and task class. Deterministic verification plus independent clean review
  is the quality floor; only then may latency or token pressure influence routing.
- **External reviewers can be tested without weakening the gate.** `camus run
  --shadow-reviewer-backend <profile> --shadow-reviewer-model <id>` gives the same diff to a
  configured Grok/Qwen/open-weight reviewer, records its comparison, and still requires Codex plus
  repository verification before landing.

## Knows when to stop

- **Review rounds are bounded** (cap 3 by default), and a finding that survives its own
  fix halts the loop early — that disagreement deserves a human, not more rounds.
- **Review postures price the speed trade honestly.** `full` (default) or `oneshot` —
  one review, one unreviewed repair, verify decides; the result reads
  `done_with_findings` with the findings carried verbatim, never "review clean".
- **A stalled review becomes a decision on your desk** (`needs_decision`); accepting is
  one flag and the proven worktree lands itself, nothing re-implemented.
- **A final bounded repair never impersonates a clean review.** It finishes as
  `done_with_findings` / `fixed_unreviewed`, preserving the findings and the maker's
  claimed resolutions for the human handoff.
- **Budgets halt as questions.** `budgetTokens` caps a feat at task boundaries against
  totals that survive resumes — an estimate, never an invoice.
- **Preflight refuses bad ground with the remedy attached**: no repo, zero commits,
  detached HEAD, or a dirty tree — each refusal prints the commands that clear it.
- **It pauses when it should.** `policy: autonomous | ask_on_ambiguity | ask_on_major`;
  a genuine ambiguity halts with a question, and every pause hint names its exact
  resume shape.
- **Kill it anywhere; resume finishes only what is left.** Finished tasks skip, and
  proven work lands mechanically. Studio can also resume an eligible parked candidate
  with verification only—no repeated planning, implementation, or review phases.
- **You can watch it.** `camus watch` is a live board with a heartbeat ("last
  heartbeat Xs ago", a loud warning when a "running" feat goes quiet) and honest token
  totals. Landed a task by hand? `camus reconcile` records it, with git evidence
  required. _(Live steering — `camus steer` / `watch`'s `p`·`g`·`c` keys — is
  experimental and opt-in.)_
- **It studies its own history — and checks its own pulse.** `camus retro` reads your
  run reports back (read-only, never a model call) and recommends only what ≥3 data
  points support, evidence cited inline. `camus canary` proves the local toolchain
  end-to-end on a throwaway repo before a real run pays for the discovery: a known-red
  must fail by name, a known-green must come back bound to its exact commit.
- **A killed review is resumed before it is re-paid.** Codex announces its thread id in
  the event stream; recovery resumes that thread — and only ever a thread the evidence
  says was abandoned — falling closed to a fresh review on any doubt.

## Layout

This is a monorepo:

```
packages/cli/             # the npm package "camus-cli"
  bin/camus.js            # CLI; thin dispatcher over install.sh + the gate scripts
  install.sh              # install / check / auto-setup / env-check
  merge_settings.py       # permission-profile merger (preserves your settings)
  workflows/              # compatibility: camus-loop + camus-feat + camus-plan
  skills/camus/           # native driver, evals, kernel, review prompt, gate scripts
apps/loop-studio/         # local visual operator: words lanes + Build recovery
apps/web/                 # the marketing site (Next.js, static export)
brand/                    # logo SVGs + BRAND.md
docs/                     # design notes and generation recipes
CAMUS-SPEC.md             # the full design
```

## Start here

```bash
npm i -g camus-cli@0.4.11
camus install        # freeze the gate into ~/.claude (a copy, not a symlink)
camus check          # exit 0 = installed matches package. Run before every auto run.
```

The full manual ships with the package:
[`packages/cli/README.md`](packages/cli/README.md) — requirements (local git only;
GitHub is never involved), supported stacks, review postures, environment levers,
upgrade notes, and the per-run recipe.

## Boundary

Camus is for code you already trust. The verifier executes the repo's own build and
test commands; on an untrusted repo that is remote code execution. Never run it as
root. Camus may improve itself only through tasks that pass its own gates. It never
touches its runner, skill, verifier, schemas, or permissions during a run.

---

Full design: [`CAMUS-SPEC.md`](CAMUS-SPEC.md). Formerly Nightcrawler v2; v1 remains
archived at [mateodaza/nightcrawler](https://github.com/mateodaza/nightcrawler).
