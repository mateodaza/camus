# Camus Loop Studio

A local web UI that runs the Camus loop on words instead of code — research and analysis on any topic — so non-technical people can watch it work:

**plan → draft (Claude) → adversarial review (Codex, a different vendor) → fix → deterministic verify → done — or a plain-English question routed to the human.**

The loop's contract is ported from [camus](https://github.com/mateodaza/camus) v2-lite: bounded review rounds, repeat findings halt instead of re-litigating, infrastructure failures are never a pass, and every green leaves receipts.

## Direction

The studio is the loop's visual front door, and it grows in this order:

1. **Words, any topic** (today) — research memos, teardowns, freeform analysis.
2. **Marketing as the first tuned vertical** — the compliance wordlist ships web3-marketing defaults and grounding rides Myosin's Hivemind, because that is where the studio has real internal knowledge to stand on (and the two products co-market).
3. **Back to code** (later) — one goal in, the studio decides: research/analyze runs this loop; build hands off to the camus code gate, on the same watchable surface.

## Quickstart

Requirements: Node ≥ 18.17, plus — for the live engine — the `claude` (Claude Code) and `codex` CLIs installed and authenticated.

```bash
node server.mjs --doctor   # check claude / codex / hivemind wiring
node server.mjs            # live engine → http://localhost:1913
npm run rehearse           # mock engine: full scripted loop, no model calls, ~2 min
npm test                   # deterministic-verifier self-test
```

## Models are decisions

Every model is named explicitly on every call (`claude --model`, `codex -m`) — **account and CLI defaults are never reachable.** [checks/models.json](checks/models.json) is the decision record (current: maker `sonnet`, reviewer `gpt-5.4` at `low` effort, with the why and the date). Change a model there deliberately; `--doctor` and the UI status pill always show what's pinned.

Useful env:

| Var | Effect |
|---|---|
| `ENGINE=mock` | Rehearsal engine (what `npm run rehearse` sets) |
| `MOCK_SPEED=2` | Slow the rehearsal beats down (e.g. while narrating) |
| `MOCK_OFFLINE=1` | Skip network link-checks (venue with no wifi) |
| `ROUND_CAP=3` | Review round budget (1–6) |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `CODEX_EFFORT` | Override the models.json decisions for one session |
| `CAMUS_CODEX_TIER`, `CAMUS_CODEX_DISABLE_MCP` | Passed through to `codex exec` exactly as camus does |
| `HIVEMIND_MCP_URL`, `HIVEMIND_API_KEY` | Ground drafts via the Hivemind MCP (see below) |
| `PORT=1913` | Camus was born in 1913 |

## What the deterministic gate checks

The verify stage is mechanical — no model, no mercy ([lib/verify.mjs](lib/verify.mjs)):

1. **Structure** — the deliverable type's required sections exist.
2. **Links resolve** — every URL in the doc returns < 400. Any other ≥ 400 status fails as dead; no answer at all (DNS failure, timeout) fails as unreachable — honestly labeled "could not verify", never "confirmed dead"; bot-blocked (401/403/429) warns, because the check can't verify those either way — open them yourself.
3. **Quantitative claims cite sources** — any sentence carrying %, $, multiples, or big counts must carry a `[n]` citation or inline link (bare years alone don't count as claims, but they don't exempt a sentence either).
4. **Web3 compliance phrases** — configurable wordlist ([checks/compliance.json](checks/compliance.json)): promissory claims fail, hype phrasing warns.
5. **Citation integrity** — every `[n]` and `[Hn]` marker used in the body maps to an entry under `## Sources`.

## How the loop stops (ported from camus)

- Reviewer verdicts come back as **schema-enforced JSON** (`codex exec --output-schema`); unparseable, empty, or self-contradictory output is an infra error and **never** a clean verdict.
- A blocking finding **re-raised with the same title** (round ≥ 2), or one that vanishes and returns, halts the loop: the human chooses accept-with-findings / one more round / stop.
- Reviewer questions that only the goal owner can answer pause the run as **needs_human** — the question card in the UI.
- Verify failures buy one fix pass; after that, the human decides. Shipping a red is possible but is recorded as `verify_failed`, never repainted green.

## Receipts

Every run writes `runs/<id>/`: `events.jsonl` (the full event stream — the UI can replay finished runs from it), `rev-N.md` per revision, per-round codex verdicts (live engine), and `report.json`. Every human choice — content decisions, retries, stuck-finding accepts, verify overrides — is recorded in both the event stream and the report's `answers` array, with its kind. Nothing about a run lives only in the browser.

## Hivemind

[lib/adapters/hivemind.mjs](lib/adapters/hivemind.mjs) is the seam. Grounding modes, in resolution order:

**1. Via Claude (preferred — no API key).** The maker *is* Claude Code, so the Hivemind MCP rides Claude's own connector auth. The studio retrieves nothing itself; the model runs `knowledge_search` mid-draft, cites what it used as `[Hn]`, and the verifier enforces that every marker maps to a `[Hn]` entry under Sources.

```bash
# one-time, interactive (the OAuth consent is yours to give):
claude mcp add --transport http hivemind https://staging-hivemind.myosin.xyz/api/mcp
#   then authenticate it via /mcp in an interactive claude session
export HIVEMIND_VIA_CLAUDE=1        # optional: HIVEMIND_MCP_URL to point at prod when it ships
```

The maker keeps `--strict-mcp-config`: its tool surface is exactly WebSearch, WebFetch, and the hivemind tools — nothing else from your MCP config leaks in. `--doctor` checks the `hivemind` server is registered and prints the setup line if not.

**2. Studio-side MCP (`HIVEMIND_MCP_URL` + `HIVEMIND_API_KEY`).** The studio calls `/api/mcp` itself through a zero-dependency client ([lib/mcp-client.mjs](lib/mcp-client.mjs)) with an admin-issued `hm_k_…` key — for headless or hosted setups with no Claude connector.

**3. REST fallback (`HIVEMIND_API_URL`), then honest stub** — the UI shows "not connected"; runs proceed ungrounded, never silently.

`publishArtifact()`: the hive-mind MCP **deliberately defers artifact tools** for now, so publish uses REST when configured and otherwise logs that the deliverable stayed local. When the artifact tool ships over MCP, it's one function body.

## Hosted UI (web app, local execution)

The UI is static and lives at **https://camus.sh/studio/** (the landing's build syncs `public/` there — see `apps/web/package.json`) while runs, CLIs, and auth stay on each user's machine:

1. Run the studio locally: `node server.mjs`. The server answers CORS preflights (including `Access-Control-Allow-Private-Network`) for exactly one origin — `https://camus.sh` by default, `STUDIO_ALLOWED_ORIGIN` to point elsewhere (previews, staging).
2. Visit `https://camus.sh/studio/` — served from a public origin, the page defaults to `http://localhost:1913` (`?api=` overrides and persists) and drives the local server; the browser's local-network permission prompt is the user's grant.

No key, no token, and no model auth ever leaves the laptop — the web app is glass, the machine does the work.

## Demo-day runbook

1. `node server.mjs --doctor` on the venue wifi.
2. Start the **live** run on stage at minute zero (quick depth), talk over it.
3. Keep a `npm run rehearse` (`MOCK_SPEED=2`) window ready as the fallback — same UI, scripted beats: 3 findings → fix → a question for the room → fix → clean review → dead-link red gate → fix → green.
4. Finished runs replay from the launch screen (Recent runs), so yesterday's green is always one click away.
