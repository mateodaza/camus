# Smoke test guide

Ordered so each step proves a specific piece. Steps 1–5 cost nothing and need ~5 minutes; step 6 is the live fire.

## 1. Self-test — the deterministic verifier (5s, offline)

```bash
cd ~/Documents/Own/camus-loop-studio
npm test
```

One green line = every gate behavior asserted: seeded-bad doc fails (uncited 61%, uncited 3x, "guaranteed returns"), clean doc passes, missing `## Sources` fails structure, dangling `[n]` and `[Hn]` markers fail citations, `In 2024, retention rose 61%.` is flagged (year-first bypass regression), and the link classifier is exercised against an **in-process HTTP fixture**: 200 → pass, 403 → warn, 404 → fail, HEAD-405 → GET fallback, dead-outranks-blocked.

## 2. Doctor — the wiring (5s)

```bash
node server.mjs --doctor
```

Expect: node ≥18, `claude` and `codex` versions, `hivemind not connected — stub adapter`, `engine live`. Exit 1 with a hint if a CLI is missing.

## 3. Rehearsal loop — the full arc, scripted (~3 min, no model calls)

```bash
npm run rehearse        # MOCK_SPEED=2 npm run rehearse to slow it for narrating
```

Open http://localhost:1913. Pills should read `engine: rehearsal (mock)` and `hivemind: not connected`.

Type any goal (a sentence or more), keep **Research memo** + **Quick**, hit **Run the loop**. What you're watching, beat by beat:

| Beat | What you see | What it proves |
|---|---|---|
| Plan | dashed plan card, stage dot goes green | claude adapter interface + stage rail |
| Draft | `rev 1` appears right pane | revision tracking, markdown renderer, `[n]` cite chips |
| Review r1 | ✗ verdict, 3 finding cards — 2 HIGH ("Retention figure has no source", "Promissory phrasing: guaranteed returns") + 1 MEDIUM | adversarial review contract, severity chips |
| Fix | `rev 2` — the 61% claim and "guaranteed returns" are gone | findings actually drive revisions |
| Review r2 | 1 finding + the **dark "THE LOOP IS ASKING YOU" card** | needs_human routing; header pill flips to `needs human`, `/api/runs` reports it too |
| You answer | type e.g. `Base-first — client committed to Base for Q3` | answer threads into the next fix — look for it in rev 3's Summary |
| Review r3 | ✓ clean | round loop exit |
| Verify #1 | checks tick in; **links RED** — a real HTTP check catches the seeded dead GitHub URL (404) | the deterministic gate runs for real, even in rehearsal |
| Fix + Verify #2 | `rev 4`, all five checks green, **DETERMINISTIC GATE: GREEN** | verify-fail → fix → re-verify loop |
| Banner | `DONE — reviewed, verified, shipped. rev 4 · receipts in runs/<id>/` | terminal status, SSE closes (no replay loop) |

Also try: click through rev tabs 1→4 to watch the draft evolve; **Copy** / **Download**.

No wifi at the venue: `MOCK_OFFLINE=1 npm run rehearse` (link checks skip instead of failing).

## 4. Receipts — nothing lives only in the browser (1 min)

```bash
ls runs/<run-id>/                     # events.jsonl, rev-1..4.md, report.json
grep -c '' runs/<run-id>/events.jsonl # the full ordered event stream
grep 'question_answered\|"type":"answer"' runs/<run-id>/events.jsonl
python3 -m json.tool runs/<run-id>/report.json | head -30
```

`report.json` carries `status`, the final deliverable, and `answers[]` — every human choice with its `kind` (`decision` / `infra` / `stuck` / `verify`). A "Ship anyway" override would sit there labeled, never repainted green.

## 5. Replay — yesterday's green (30s)

Ctrl-C the server, start it again, reload the page. **Recent runs** lists the finished run (read back from `report.json`); click it and the whole run replays from `events.jsonl` — findings, your answered question card, the RED→GREEN verify, the banner. This is the demo fallback if you don't want to run anything live on stage.

## 6. Live fire — the real loop (10–20 min; bills your claude auth + codex plan credits)

```bash
CODEX_EFFORT=low node server.mjs     # cheap first fire; drop the env for medium
```

Pill reads `engine: live · claude + codex`. Give it a real goal on **Quick**. Differences from rehearsal you should expect:

- Draft takes minutes (claude researches with WebSearch/WebFetch — tool surface is allowlisted to those two, it cannot touch files).
- Findings are real codex output, schema-enforced (`--output-schema`); malformed reviewer output becomes a visible infra card, never a silent pass.
- Verify runs against the real cited URLs: confirmed-dead fails; bot-blocked corporate sites (403) **warn** with "open it yourself" — by design, the check refuses to claim what it can't verify.
- The header shows real claude spend; codex burns plan credits.

Keep the finished green in `runs/` — it's your on-stage replay. Kill switch: **Stop** button, any pending question resolves as stopped.

## Known texture (not bugs)

- First rehearsal question card: answer with the textarea, not Enter (multiline is allowed).
- `runs/` is gitignored; delete run folders freely.
- Compliance wordlist: [checks/compliance.json](checks/compliance.json) — add client-specific phrases before the talk if you want a tailored flag moment.
