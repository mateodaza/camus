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

It runs as three Claude Code workflows plus a skill: `/camus-plan` turns a raw
request into a quality-gated task list, `/camus-loop` takes one task, and `/camus-feat`
ships an ordered task list as one feature branch with a report. Formerly Nightcrawler
v2; v1 remains archived at [mateodaza/nightcrawler](https://github.com/mateodaza/nightcrawler).
Full design: [`CAMUS-SPEC.md`](https://github.com/mateodaza/camus/blob/main/CAMUS-SPEC.md).

```
plan → implement → [ Codex review ↔ fix ]* → commit gate → dep prep → verify
       full posture: loops while P0/P1/P2 findings remain, round cap 3
       oneshot posture: one review, one repair, no re-review — verify still decides
```

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
- **Gate-owned git runs hookless and unsigned**, so repo hooks and forced signing
  cannot abort unattended commits — and Camus never pushes, by construction.

## Knows when to stop

- **Review rounds are bounded** (cap 3 by default), and a finding that survives its own
  fix halts the loop early — that disagreement deserves a human, not more rounds.
- **Review postures price the speed trade honestly.** `full` (default) or `oneshot` —
  one review, one unreviewed repair, verify decides; the result reads
  `done_with_findings` with the findings carried verbatim, never "review clean".
- **A stalled review becomes a decision on your desk** (`needs_decision`); accepting is
  one flag and the proven worktree lands itself, nothing re-implemented.
- **Budgets halt as questions.** `budgetTokens` caps a feat at task boundaries against
  totals that survive resumes — an estimate, never an invoice.
- **Preflight refuses bad ground with the remedy attached**: no repo, zero commits,
  detached HEAD, or a dirty tree — each refusal prints the commands that clear it.
- **It pauses when it should.** `policy: autonomous | ask_on_ambiguity | ask_on_major`;
  a genuine ambiguity halts with a question, and every pause hint names its exact
  resume shape.
- **Kill it anywhere; resume finishes only what is left.** Finished tasks skip, and
  proven work lands mechanically.
- **You can watch it — and grab the wheel.** `camus watch` is a live board with a
  heartbeat ("last heartbeat Xs ago", a loud warning when a "running" feat goes
  quiet), one-key steering, and honest token totals. Landed a task by hand?
  `camus reconcile` records it, with git evidence required.

## Layout

This is a monorepo:

```
packages/cli/             # the npm package "camus-cli"
  bin/camus.js            # CLI; thin dispatcher over install.sh + the gate scripts
  install.sh              # install / check / auto-setup / env-check
  merge_settings.py       # permission-profile merger (preserves your settings)
  workflows/              # camus-loop + camus-feat + camus-plan (the engine)
  skills/camus/           # SKILL.md, review prompt, schema, gate scripts (unit-tested)
apps/web/                 # the marketing site (Next.js, static export)
brand/                    # logo SVGs + BRAND.md
docs/                     # design notes and generation recipes
CAMUS-SPEC.md             # the full design
```

## Start here

```bash
npm i -g camus-cli
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
