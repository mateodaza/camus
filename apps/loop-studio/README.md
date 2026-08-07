# Camus Loop Studio

A local web UI that runs the Camus loop on words instead of code — research and analysis on any topic — so non-technical people can watch it work:

**plan → draft (Claude) → adversarial review (Codex, a different vendor) → fix → deterministic verify → done — or a plain-English question routed to the human.**

The loop's contract is ported from [camus](https://github.com/mateodaza/camus) v2-lite: bounded review rounds, repeat findings halt instead of re-litigating, infrastructure failures are never a pass, and every green leaves receipts.

## Direction

The studio is the loop's visual front door. What it does today:

- **Words, any topic** — research memos, teardowns, freeform analysis.
- **Marketing, the tuned vertical** — the compliance wordlist ships regulated-claims defaults and grounding rides Myosin's Hivemind (staging today), because that is where the studio has real internal knowledge to stand on (and the two products co-market).
- **Code** — the Build lane points the camus gate at a git repo on this machine: isolated worktree, cross-model review, the repo's own tests as the verdict, needs_human pauses answered from the same question card. In beta, newer than the words lanes.

The trust-protocol integration now ships in Studio: every new run starts with an explicit acceptance contract; seals raw execution × verification × audit × publication dimensions; records requested/resolved/actual executor and auditor identities plus actual reviewer effort; and mints separate artifact and receipt hashes in a downloadable evidence pack. Research packs include two structured ledgers. Citation markers become claim candidates labeled `supported`, `unsupported`, or `unchecked`; a live URL alone never becomes support. The acceptance contract is deterministically split into stable criteria labeled `met`, `unmet`, or `unclear`, so comparison arms are judged against identical requirements. If deterministic repair changes the final revision, Studio runs a fresh closure audit before that revision can inherit standing. Evidence-pack v2 preserves the identity split: criteria and claim meaning bind the artifact, while their auditor decisions bind the receipt. The one-word standing remains derived presentation and never enters the permanent pack.

**Compare & Learn now has two evidence-preserving modes.** **Re-audit** freezes a new auditor configuration over an unchanged artifact: no maker, no retrieval, the same `artifact_id`, and a new `receipt_id`. **Compare executors** freezes one goal, acceptance contract, task/depth controls, round cap, current model catalog, shared reviewer, and content-addressed knowledge snapshot before starting two or three concurrent arms. Every arm reads the same local snapshot, cannot retrieve live knowledge or publish, and keeps its own evidence pack. The parent `experiment.v2` receipt retains every success, quality-floor failure, infrastructure failure, and human stop; it records actual identities and available usage without treating requested effort as proven. Fallback is `none`. Recovery reconstructs sealed children and marks interrupted arms failed instead of silently rerunning them. Rehearsal exercises the full UX but cannot clear the independent quality floor. This execution slice deliberately names no winner; blinded cross-arm judgment is next. Direction: [docs/COMPARE-AND-LEARN-DIRECTION.md](../../docs/COMPARE-AND-LEARN-DIRECTION.md).

## Quickstart

Requirements: Node ≥ 18.17, plus — for the live engine — the `claude` (Claude Code) and `codex` CLIs installed and authenticated.

```bash
node server.mjs --doctor   # check claude / codex / hivemind wiring
node server.mjs            # live engine → http://localhost:1913
npm run rehearse           # mock engine: full scripted loop, no model calls, ~2 min
npm test                   # deterministic-verifier self-test
```

## For people who don't live in a terminal

The setup is guided from inside the page. One command starts the studio (`node server.mjs`, or `npx camus-loop-studio` once published) — that first command is still a terminal step until a packaged launcher ships; everything after it happens in the browser:

- The **setup** panel runs the same checks as `--doctor`, row by row, and every missing piece comes with the exact command to paste — install Claude Code, install Codex, sign in once each. "Check again" re-verifies without restarting anything.
- The **settings** panel edits the run decisions (maker model, reviewer model, effort, review rounds) and writes them back to [checks/models.json](checks/models.json) with a stamped why — the decision record stays the source of truth, no file editing required.
- **Show the session** (in a running view) opens the raw feed underneath the loop: the maker's live searches, the reviewer's reasoning, token counts — the "what is it actually doing right now" view.

## Models are decisions

Every model is named explicitly on every call (`claude --model`, `codex -m`, or the configured endpoint) — **account and CLI defaults are never reachable.** [checks/models.json](checks/models.json) is the decision record, with the why and the date on every entry. Change a decision there, in Settings, or per run from the launch form; `--doctor` and the UI status pill always show what's pinned.

### Any model in either seat

Since the multi-model-seats slice ([docs/MULTI-MODEL-SEATS.md](../../docs/MULTI-MODEL-SEATS.md)) the two seats — **maker** (drafts and fixes) and **reviewer** (tries to break it) — are filled independently from a backend-qualified catalog: the built-in `claude` and `codex` CLI backends in either seat (including reversed: GPT writes, Claude reviews), plus opt-in `openai_compat` entries for open-weight endpoints. Declare one under `backends`:

```json
"backends": {
  "kimi": {
    "kind": "openai_compat",
    "provider": "moonshot",
    "baseUrl": "https://api.moonshot.ai/v1",
    "apiKeyEnv": "MOONSHOT_API_KEY",
    "models": ["kimi-k2-0905-preview"],
    "why": "added <date> for <reason>"
  }
}
```

No backend exists until someone writes one down; the key lives only in the named env var. A same-vendor pairing is allowed and recorded honestly: the review seals as **advisory** and the standing reads **same-vendor reviewed**, never independent. Boundaries of the slice: Build keeps the gate's own pairing, Compare & Learn and audit replay keep their frozen claude/codex catalogs, grounded managed-connector runs need a claude-backend maker, and `openai_compat` backends have no tools (no web, no MCP) — a contract demanding live-loaded sources will honestly fail review under such a maker.

Both **codex** seats run a hardened subprocess: shell/exec, web search (which defaults to *on*), browser, apps, and plugins disabled by flag; no user config, rules, or MCP; ephemeral session; a scrubbed environment; and a fail-closed watch that refuses the call if any unexpected tool event appears. See [docs/MULTI-MODEL-SEATS.md](../../docs/MULTI-MODEL-SEATS.md#the-hardened-codex-profile-both-seats) for the flag table and the live controls behind each claim.

Useful env:

| Var | Effect |
|---|---|
| `ENGINE=mock` | Rehearsal engine (what `npm run rehearse` sets) |
| `MOCK_SPEED=2` | Slow the rehearsal beats down (e.g. while narrating) |
| `MOCK_OFFLINE=1` | Skip network link-checks (venue with no wifi) |
| `ROUND_CAP=3` | Review round budget (1–6) |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `CODEX_EFFORT` | Override the models.json decisions for one session (honored only when the seat runs the matching CLI backend) |
| `OPENAI_COMPAT_IDLE_MS` | Idle watchdog for `openai_compat` streams (default 120000) |
| `CAMUS_CODEX_TIER`, `CAMUS_CODEX_DISABLE_MCP` | Passed through to `codex exec` exactly as camus does |
| `HIVEMIND_VIA_CLAUDE=1` | Use the connected Hivemind Staging entry in Claude (preferred; no Studio key) |
| `HIVEMIND_MCP_URL`, `HIVEMIND_API_KEY` | Ground drafts via Studio-side Hivemind MCP (see below) |
| `PORT=1913` | Camus was born in 1913 |

## What the deterministic gate checks

The verify stage is mechanical — no model, no mercy ([lib/verify.mjs](lib/verify.mjs)):

1. **Structure** — the deliverable type's required sections exist.
2. **Links resolve** — every URL in the doc returns < 400. Any other ≥ 400 status fails as dead; no answer at all (DNS failure, timeout) fails as unreachable — honestly labeled "could not verify", never "confirmed dead"; bot-blocked (401/403/429) warns, because the check can't verify those either way — open them yourself.
3. **Quantitative claims cite sources** — any sentence carrying %, $, multiples, or big counts must carry a `[n]` citation or inline link (bare years alone don't count as claims, but they don't exempt a sentence either).
4. **Compliance phrases** — configurable wordlist ([checks/compliance.json](checks/compliance.json)): promissory claims fail, hype phrasing warns.
5. **Citation integrity** — every `[n]` and `[Hn]` marker used in the body maps to an entry under `## Sources`.

## How the loop stops (ported from camus)

- Reviewer verdicts come back as **schema-enforced JSON** (`codex exec --output-schema`); unparseable, empty, or self-contradictory output is an infra error and **never** a clean verdict.
- A blocking finding **re-raised with the same title** (round ≥ 2), or one that vanishes and returns, halts the loop: the human chooses accept-with-findings / one more round / stop.
- Reviewer questions that only the goal owner can answer pause the run as **needs_human** — the question card in the UI.
- Verify failures buy one fix pass; after that, the human decides. When that repair changes the deliverable, deterministic verification and an independent closure audit both rerun on the new revision. Shipping a red is possible but is recorded as `verify_failed`, never repainted green.

## Receipts

Every run writes `runs/<id>/`: `events.jsonl` (the full event stream — the UI can replay finished runs from it), `rev-N.md` per revision, per-round codex verdicts (live engine), and `report.json`. Every human choice — content decisions, retries, stuck-finding accepts, verify overrides — is recorded in both the event stream and the report, with its kind and time. `report.json.evidencePack` is the schema-validated trust artifact: explicit acceptance contract, artifact/receipt IDs, pairing actuals, deterministic checks, claim and contract-coverage decisions bound to the final reviewed revision, human decisions, raw dimensions, and honest economics (`unknown`/`null` unless the runtime proves more). Audit replays additionally seal `report.json.experiment` against `experiment.v1.schema.json`; parallel parents use `experiment.v2.schema.json` plus a local-only `knowledge.json`, while each child remains an ordinary evidence-pack receipt. Experiment identity hashes the frozen manifest, not its observed outcome. Public citations bind the exact URL but remain unsupported until the auditor records source-content evidence; Hivemind citations additionally bind the captured excerpt hash and retrieval time. Rehearsal claims always seal as `unchecked` and coverage as `unclear`, whatever the scripted reviewer says. The run view shows short IDs and both decision summaries; **Evidence pack** or **Experiment** downloads the full hashes. Nothing about a run lives only in the browser.

## Hivemind

[lib/adapters/hivemind.mjs](lib/adapters/hivemind.mjs) is the seam. Grounding modes, in resolution order:

**1. Via Claude (preferred — no API key).** The maker *is* Claude Code, so the Hivemind MCP rides Claude's own connector auth. The studio retrieves nothing itself; the model runs `knowledge_search` mid-draft, cites what it used as `[Hn]`, and the verifier enforces that every marker maps to a `[Hn]` entry under Sources.

```bash
# one-time, interactive (the OAuth consent is yours to give):
# open /mcp in Claude and connect "Hivemind Staging"
export HIVEMIND_VIA_CLAUDE=1        # optional: HIVEMIND_MCP_URL to point at prod when it ships
```

In managed-connector mode Studio excludes user, local, and project settings, then gives the maker a restrictive surface containing WebSearch, WebFetch, ToolSearch, and the exact Hivemind `knowledge_search` tool. Claude.ai connectors authenticate through Anthropic's managed proxy, so re-adding the raw URL under a local alias would not inherit the signed-in session. Other connected services are never exposed to the model. Deep `--doctor` targets only the managed Hivemind entry and never health-checks or prints unrelated local MCP configuration. The launch view says the connector is *available*; the Ground stage earns `claude ✓` only after Studio observes a real Hivemind tool call (`claude ✕` means configured but unused). The observed calls, query trail, and the newest 32 bounded result excerpts are passed to the independent auditor as adapter evidence, so replacement sources fetched during a fix remain visible. The sealed pack custody-binds every observed result's metadata plus an excerpt hash, proving exactly what evidence the review saw without bloating the manifest; retrieval still does not make a claim correct by default.

**2. Studio-side MCP (`HIVEMIND_MCP_URL` + `HIVEMIND_API_KEY`).** The studio calls `/api/mcp` itself through a zero-dependency client ([lib/mcp-client.mjs](lib/mcp-client.mjs)) with an admin-issued `hm_k_…` key — for headless or hosted setups with no Claude connector.

**3. REST fallback (`HIVEMIND_API_URL`), then honest stub** — the UI shows "not connected"; runs proceed ungrounded, never silently.

`publishArtifact()`: the hive-mind MCP **deliberately defers artifact tools** for now, so publish uses REST when configured and otherwise logs that the deliverable stayed local. When the artifact tool ships over MCP, it's one function body.

## Hosted UI (web app, local execution)

The UI is static and lives at **https://camus.sh/studio/** (the landing's build syncs `public/` there — see `apps/web/package.json`) while runs, CLIs, and auth stay on each user's machine:

1. Run the studio locally: `node server.mjs`. The server answers CORS preflights (including `Access-Control-Allow-Private-Network`) for exactly one origin — `https://camus.sh` and `https://www.camus.sh` by default, `STUDIO_ALLOWED_ORIGIN` to point elsewhere (comma-separated for several — previews, staging).
2. Visit `https://camus.sh/studio/` — served from a public origin, the page defaults to `http://localhost:1913` (`?api=` overrides and persists) and drives the local server; the browser's local-network permission prompt is the user's grant.

The hosted web app never receives your credentials — it is glass. The local server holds your Claude, Codex, and Hivemind logins and calls those providers directly: the credentials go straight to Claude, Codex, or Hivemind over their own authenticated connections and never pass through camus.sh.

## Demo-day runbook

1. `HIVEMIND_VIA_CLAUDE=1 node server.mjs --doctor` on the venue wifi.
2. Start the **live** run on stage at minute zero (quick depth), talk over it.
3. Keep a `npm run rehearse` (`MOCK_SPEED=2`) window ready as the fallback — same UI, scripted beats: 3 findings → fix → a question for the room → fix → clean review → dead-link red gate → fix → green.
4. Fill both the goal and **“What must be true for you to trust the result?”**; narrate the latter as the contract the second model judges.
5. End on the sealed evidence card, then download the full pack. Finished runs replay from Recent runs, so yesterday's green is always one click away.
