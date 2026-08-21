# Camus

**Makes it work. Knows when to stop.**

No agent grades its own work. Camus runs a coding task from plan to verified commit
without you watching: Claude writes the code, Codex (a competing model) reviews
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

You need [Claude Code](https://code.claude.com) and the [Codex CLI](https://github.com/openai/codex)
(`codex login`) — the cross-vendor pairing is the product, so both halves are required.

```bash
npm i -g camus-cli@0.4.3
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

### Public alpha: 0.4.3

Camus 0.4.1 made that deterministic kernel the executable default. Durable Claude Code sessions
survive the launching terminal, restarts adopt rather than duplicate them, and a model controller
appears only for real semantic closure choices. A local append-only eval ledger can compare complete
maker/reviewer pairings by exact experiment generation and task class, but names no routing winner
until every configured arm clears its declared quality floor. The release dogfood completed two
review-clean, HEAD-bound tasks in 9m13s—an 87% reduction in comparable end-to-end trace time versus
the previous model-orchestrated run. Camus 0.4.2 is a bounded recovery hotfix: it safely adopts a
maker that committed despite its contract, gives high-effort review watchdogs enough host time, and
counts one recovered background turn only once. Camus 0.4.3 makes native budget stops typed and
resumable, lets the low-cost controller decide before reserving another expensive maker turn, and
keeps stale repo-level telemetry from contradicting fresh feature state. See the
[0.4.3 release notes](docs/RELEASE-0.4.3.md).

The current development tree also completes Studio's first user-visible open-model slice:
declared Grok/Kimi/Qwen or local OpenAI-compatible models stay disabled until their exact maker
or reviewer tuple passes live capability probes, then carry the accepted receipt unchanged into
the run and sealed evidence pack. This does not change the released 0.4.3 CLI. Generic CLI/gate
backends, Responses transport, and managed SSH remain explicit later slices rather than being
advertised early.

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
npm i -g camus-cli@0.4.3
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
