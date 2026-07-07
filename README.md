# Camus Loop Studio

A local web UI that runs the Camus loop on marketing deliverables instead of code, so non-technical people can watch it work:

**plan → draft (Claude) → adversarial review (Codex, a different vendor) → fix → deterministic verify → done — or a plain-English question routed to the human.**

The loop's contract is ported from [camus](https://github.com/kilterset/camus) v2-lite: bounded review rounds, repeat findings halt instead of re-litigating, infrastructure failures are never a pass, and every green leaves receipts.

## Quickstart

Requirements: Node ≥ 18.17, plus — for the live engine — the `claude` (Claude Code) and `codex` CLIs installed and authenticated.

```bash
node server.mjs --doctor   # check claude / codex / hivemind wiring
node server.mjs            # live engine → http://localhost:1913
npm run rehearse           # mock engine: full scripted loop, no model calls, ~2 min
npm test                   # deterministic-verifier self-test
```

Useful env:

| Var | Effect |
|---|---|
| `ENGINE=mock` | Rehearsal engine (what `npm run rehearse` sets) |
| `MOCK_SPEED=2` | Slow the rehearsal beats down (e.g. while narrating) |
| `MOCK_OFFLINE=1` | Skip network link-checks (venue with no wifi) |
| `ROUND_CAP=3` | Review round budget (1–6) |
| `CODEX_EFFORT=medium` | Reviewer reasoning effort (`low`\|`medium`\|`high`) |
| `CAMUS_CODEX_TIER`, `CAMUS_CODEX_DISABLE_MCP` | Passed through to `codex exec` exactly as camus does |
| `CLAUDE_MODEL` | Override the maker model |
| `PORT=1913` | Camus was born in 1913 |

## What the deterministic gate checks

The verify stage is mechanical — no model, no mercy ([lib/verify.mjs](lib/verify.mjs)):

1. **Structure** — the deliverable type's required sections exist.
2. **Links resolve** — every URL in the doc returns < 400. Confirmed-dead (404/410/5xx/DNS/timeout) fails; bot-blocked (401/403/429) warns, because the check can't verify those either way — open them yourself.
3. **Quantitative claims cite sources** — any sentence carrying %, $, multiples, or big counts must carry a `[n]` citation or inline link (bare years alone don't count as claims, but they don't exempt a sentence either).
4. **Web3 compliance phrases** — configurable wordlist ([checks/compliance.json](checks/compliance.json)): promissory claims fail, hype phrasing warns.
5. **Citation integrity** — every `[n]` and `[Hn]` marker used in the body maps to an entry under `## Sources`.

## How the loop stops (ported from camus)

- Reviewer verdicts come back as **schema-enforced JSON** (`codex exec --output-schema`); unparseable, empty, or self-contradictory output is an infra error and **never** a clean verdict.
- A blocking finding **re-raised with the same title** (round ≥ 2), or one that vanishes and returns, halts the loop: the human chooses accept-with-findings / one more round / stop.
- Reviewer questions that only the goal owner can answer pause the run as **needs_human** — the question card in the UI.
- Verify failures buy one fix pass; after that, the human decides. Shipping a red is possible but is recorded as `verify_failed`, never repainted green.

## Receipts

Every run writes `runs/<id>/`: `events.jsonl` (the full event stream — the UI can replay finished runs from it), `rev-N.md` per revision, per-round codex verdicts, and `report.json`. Every human choice — content decisions, retries, stuck-finding accepts, verify overrides — is recorded in both the event stream and the report's `answers` array, with its kind. Nothing about a run lives only in the browser.

## Hivemind

[lib/adapters/hivemind.mjs](lib/adapters/hivemind.mjs) is the seam. Today it speaks REST when configured, otherwise it's an honest stub (UI shows "not connected"; runs proceed ungrounded):

```bash
export HIVEMIND_API_URL="https://<hivemind-host>"
export HIVEMIND_API_KEY="..."
# optional: HIVEMIND_SEARCH_PATH, HIVEMIND_ARTIFACT_PATH
```

- **In**: `searchKnowledge(goal)` retrieves knowledge chunks that get injected into the draft prompt as `[H1]`-citable grounding.
- **Out**: `publishArtifact()` writes the verified deliverable back as a Hivemind artifact.

**When the Hivemind MCP server is live**: replace the bodies of those two functions with MCP calls — the engine only knows the interface, nothing else changes.

## Demo-day runbook

1. `node server.mjs --doctor` on the venue wifi.
2. Start the **live** run on stage at minute zero (quick depth), talk over it.
3. Keep a `npm run rehearse` (`MOCK_SPEED=2`) window ready as the fallback — same UI, scripted beats: 3 findings → fix → a question for the room → fix → clean review → dead-link red gate → fix → green.
4. Finished runs replay from the launch screen (Recent runs), so yesterday's green is always one click away.
