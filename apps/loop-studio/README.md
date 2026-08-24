# Camus Loop Studio

A local web UI for operating Camus across written work and code, with the complete
acceptance contract visible and every human handoff attached to the run:

**plan → draft (Claude) → adversarial review (Codex, a different vendor) → fix → deterministic verify → done — or a plain-English question routed to the human.**

The loop's contract is ported from [camus](https://github.com/mateodaza/camus) v2-lite: bounded review rounds, repeat findings halt instead of re-litigating, infrastructure failures are never a pass, and every green leaves receipts.

## Direction

The studio is the loop's visual front door. What it does today:

- **Words, any topic** — research memos, teardowns, freeform analysis.
- **Marketing, the tuned vertical** — the compliance wordlist ships regulated-claims defaults and grounding rides Myosin's Hivemind (staging today), because that is where the studio has real internal knowledge to stand on (and the two products co-market).
- **Code** — the Build lane points the Camus gate at a git repo on this machine: isolated worktree, cross-model review, the repo's own tests as the verdict, and `needs_human` pauses answered from the same question card. An eligible parked candidate resumes through verification only—no repeated Plan, Implement, or Review—and an unsafe or contradictory candidate fails closed. This lane is public-alpha software, proven through the WP1–WP10 CodenameWukong Enemies feature.

The trust-protocol integration now ships in Studio: every new run starts with an explicit acceptance contract; seals raw execution × verification × audit × publication dimensions; records requested/resolved/actual executor and auditor identities plus actual reviewer effort; and mints separate artifact and receipt hashes in a downloadable evidence pack. Research packs include two structured ledgers. Citation markers become claim candidates labeled `supported`, `unsupported`, or `unchecked`; a live URL alone never becomes support. The acceptance contract is deterministically split into stable criteria labeled `met`, `unmet`, or `unclear`, so comparison arms are judged against identical requirements. If deterministic repair changes the final revision, Studio runs a fresh closure audit before that revision can inherit standing. Evidence-pack v2 preserves the identity split: criteria and claim meaning bind the artifact, while their auditor decisions bind the receipt. The one-word standing remains derived presentation and never enters the permanent pack.

The 0.4.5 release adds a separate responsible-control receipt for launch, publication, managed
SSH, and paid seat qualification. Each action is screened at input, exact authorization, and output; high-stakes approval is
bound to the action fingerprint and cannot authorize a changed target. Publication is still an
explicit opt-in and is checked again immediately before the external call. These completion
records sit beside the immutable evidence pack, so control evidence can accumulate without
silently changing a published receipt schema.

**Compare & Learn now has two evidence-preserving modes.** **Re-audit** freezes a new auditor configuration over an unchanged artifact: no maker, no retrieval, the same `artifact_id`, and a new `receipt_id`. **Compare executors** freezes one goal, acceptance contract, task/depth controls, round cap, current model catalog, shared reviewer, and content-addressed knowledge snapshot before starting two or three concurrent arms. Every arm reads the same local snapshot, cannot retrieve live knowledge or publish, and keeps its own evidence pack. The parent `experiment.v2` receipt retains every success, quality-floor failure, infrastructure failure, and human stop; it records actual identities and available usage without treating requested effort as proven. Fallback is `none`. Recovery reconstructs sealed children and marks interrupted arms failed instead of silently rerunning them. Rehearsal exercises the full UX but cannot clear the independent quality floor. This execution slice deliberately names no winner; blinded cross-arm judgment is next. Direction: [docs/COMPARE-AND-LEARN-DIRECTION.md](../../docs/COMPARE-AND-LEARN-DIRECTION.md).

## Quickstart

Requirements: Node ≥ 18.17. Built-in seats use the authenticated `claude`
(Claude Code) and `codex` CLIs; configurable seats use the endpoint and env-var
credential declared in local operator state.

```bash
node server.mjs --doctor          # network-free wiring check
node server.mjs --doctor --deep   # explicit provider-backed checks; may spend tokens
node server.mjs            # live engine → http://localhost:1913
npm run rehearse           # mock engine: full scripted loop, no model calls, ~2 min
npm test                   # deterministic-verifier self-test
```

## For people who don't live in a terminal

The setup is guided from inside the page. One command starts the studio (`node server.mjs`, or `npx camus-loop-studio` once published) — that first command is still a terminal step until a packaged launcher ships; everything after it happens in the browser:

- The **setup** panel runs the same network-free checks as `--doctor`, row by row, and every missing piece comes with the exact command to paste — install Claude Code, install Codex, sign in once each. "Check again" stays spend-free; provider-backed checks require the separate **Run deep checks (may spend tokens)** action.
- The **settings** panel edits the run decisions (maker model, reviewer model, effort, review rounds) and writes local operator state to `~/.camus/studio/models.json` with a stamped why. The tracked [checks/models.json](checks/models.json) remains a cheap public fallback, so dogfood choices do not dirty the repo or become somebody else's default. Configurable models stay disabled until the operator explicitly qualifies that exact maker or reviewer tuple; the action warns that it can spend provider tokens.
- **Show the session** (in a running view) opens the raw feed underneath the loop: the maker's live searches, the reviewer's reasoning, token counts — the "what is it actually doing right now" view.
- **Publish the completed artifact to Hivemind** is an explicit words-lane opt-in on the launch form. It is off by default; accepting review findings never implies permission to publish.

## Models are decisions

Every model is named explicitly on every call (`claude --model`, `codex -m`, or the configured endpoint) — **account and CLI defaults are never reachable.** [checks/models.json](checks/models.json) supplies tracked public defaults; `~/.camus/studio/models.json` is the mutable standing decision record once Settings has saved a choice. Per-run launch choices and environment overrides remain more explicit and win; `--doctor` and the UI status pill always show what's pinned.

### Any model in either seat

Since the multi-model-seats slice ([docs/MULTI-MODEL-SEATS.md](../../docs/MULTI-MODEL-SEATS.md)) the two seats — **maker** (drafts and fixes) and **reviewer** (tries to break it) — are filled independently: the built-in `claude` and `codex` CLI backends in either seat (including reversed: GPT writes, Claude reviews), plus opt-in `openai_compat` entries for open-weight endpoints. A declaration makes a tuple visible; it does **not** make it selectable. The tuple must separately earn a live capability receipt.

```json
"connections": {
  "moonshot": { "kind": "direct_https", "baseUrl": "https://api.moonshot.ai/v1" }
},
"backends": {
  "kimi": {
    "kind": "openai_compat", "provider": "moonshot",
    "connection": "moonshot", "protocol": "chat_completions",
    "trainingOrg": "moonshot", "modelFamily": "kimi", "derivedFrom": null,
    "inferenceOperator": "moonshot",
    "auth": { "kind": "env", "envVar": "MOONSHOT_API_KEY" },
    "models": ["kimi-k3"], "seats": ["maker", "reviewer"],
    "why": "added <date> for <reason>"
  }
}
```

No backend exists until someone writes one down; the key lives only in the named env var. Settings includes inert declaration starters for xAI, Moonshot, DashScope, Ollama, LM Studio, llama.cpp, vLLM, and a neutral OpenAI-compatible HTTPS server. Copying a starter grants no lineage or qualification. After the declaration loads, **Qualify** runs the production streaming, context-window, reported-model, and reviewer-JSON probes for one exact `(seat, backend, model, connection)` tuple. Missing, failed, expired, wrong-seat, wrong-model, credential-drift, and observed server-drift receipts cannot save or launch. A successful launch freezes the accepted `qual1:` fingerprint into the run snapshot, every round, and envelope 3.

Model discovery is advisory: `listed`, `unlisted`, and `discovery_unavailable` are shown, but a valid qualification is what gates admission. A same-vendor pairing is allowed and recorded honestly: the review seals as **advisory** and the standing reads **same-vendor reviewed**, never independent. A cross-organization pairing backed only by operator declarations seals as **declared**, never as registry-verified. The server supplies the badges and warning copy; the browser does not derive a trust tier.

Boundaries of this release: `chat_completions` over `loopback`, `direct_https`, and a managed `ssh_tunnel` is selectable after exact qualification. OpenAI Responses is visibly planned, not selectable. The SSH path is transport-only: it uses a validated OpenSSH alias, a remote loopback port, and a temporary local forward; it never runs remote commands, copies files, or accepts a browser-supplied argv. Camus owns the lease, liveness checks, and teardown, and tunnel death never falls back to a direct route. The browser connection editor saves one validated connection/backend declaration at a time, requires explicit replacement authority, and grants no qualification or lineage by declaration. The CLI now contains an exact custom-reviewer dispatcher, but every non-Codex reviewer remains benchmark-disabled. Build keeps the admitted gate pairing, Compare & Learn and audit replay keep their frozen claude/codex catalogs, grounded managed-connector runs need a claude-backend maker, and `openai_compat` backends have no tools (no web, no MCP) — a contract demanding live-loaded sources will honestly fail review under such a maker. The hermetic fixture proves the complete local adapter path; real xAI/Moonshot/DashScope credentials and real Ollama/vLLM/LM Studio hardware remain an explicit provider-backed validation gap.

Both **codex** seats run a hardened subprocess: shell/exec, web search (which defaults to *on*), browser, apps, and plugins disabled by flag; no user config, rules, or MCP; ephemeral session; a scrubbed environment; and a fail-closed watch that refuses the call if any unexpected tool event appears. See [docs/MULTI-MODEL-SEATS.md](../../docs/MULTI-MODEL-SEATS.md#the-hardened-codex-profile-both-seats) for the flag table and the live controls behind each claim.

### The extended `models.json` shape (open-model seats)

Since the open-model-seats work ([docs/OPEN-MODEL-SEATS-RFC.md](../../docs/OPEN-MODEL-SEATS-RFC.md)) a backend reaches its endpoint through a named **connection**. Connection kinds include `loopback` for a backend served on this machine, `direct_https` for a public HTTPS endpoint, `ssh_tunnel` for a managed forward to a remote loopback service, and `legacy_http` for an endpoint outside the safe classes, including plain HTTP and private/internal or literal-IP HTTPS. A `legacy_http` connection loads only when its machine-local grandfather record came from the one-time migration snapshot or an explicit, recorded operator confirmation; Camus never silently grants a new one.

```jsonc
{
  "connections": {
    "local_ollama": { "kind": "loopback", "port": 11434, "basePath": "/v1" },
    "xai": { "kind": "direct_https", "baseUrl": "https://api.x.ai/v1" },
    "gpu_lab": { "kind": "ssh_tunnel", "sshHostAlias": "camus-gpu", "remoteAddress": "127.0.0.1", "remotePort": 11434, "basePath": "/v1" },
    "old_gpu": { "kind": "legacy_http", "baseUrl": "http://192.168.1.40:11434/v1" }
  },
  "backends": {
    "qwen_local": {
      "kind": "openai_compat",
      "provider": "alibaba",
      "connection": "local_ollama",
      "protocol": "chat_completions",
      "trainingOrg": "alibaba",
      "modelFamily": "qwen",
      "derivedFrom": null,
      "inferenceOperator": "self_hosted",
      "auth": { "kind": "none" },
      "models": ["qwen3-coder"],
      "seats": ["maker", "reviewer"]
    }
  }
}
```

A backend declares `trainingOrg`, `modelFamily`, and `derivedFrom`; Studio derives `lineage.source`, so writing that field in the file refuses instead of granting provenance. The built-in `claude` and `codex` backends use `vendor_managed`, while any pre-existing custom backend that only supplied a free-text `provider` stays `unknown` until it is described with a connection and the complete declarations.

When you edit a connection-bearing entry, Studio dual-writes the full backend surface — every field the validator requires — so the entry loads cleanly on older code. For a keyless backend the dual-write includes `CAMUS_NO_AUTH` as the placeholder key-env name, so the entry still names an env var.

Rollback is stated precisely in [§19.4](../../docs/OPEN-MODEL-SEATS-RFC.md): if you run older code against a config written by this version, every dual-written entry keeps **load isolation** — one entry never fails the others, so the rest of your backends keep working. A **keyed** entry additionally keeps **functional parity**: it runs as before. A **keyless** entry loads safely but has no parity claim; at call time, set `CAMUS_NO_AUTH` to any value so the keyless server can ignore the bearer header, or remove the entry.

Useful env:

| Var | Effect |
|---|---|
| `ENGINE=mock` | Rehearsal engine (what `npm run rehearse` sets) |
| `MOCK_SPEED=2` | Slow the rehearsal beats down (e.g. while narrating) |
| `MOCK_OFFLINE=1` | Skip network link-checks (venue with no wifi) |
| `ROUND_CAP=3` | Review round budget (1–6) |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `CODEX_EFFORT` | Override the standing model decisions for one session (honored only when the seat runs the matching CLI backend) |
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

1. `HIVEMIND_VIA_CLAUDE=1 node server.mjs --doctor --deep` on the venue wifi.
2. Start the **live** run on stage at minute zero (quick depth), talk over it.
3. Keep a `npm run rehearse` (`MOCK_SPEED=2`) window ready as the fallback — same UI, scripted beats: 3 findings → fix → a question for the room → fix → clean review → dead-link red gate → fix → green.
4. Fill both the goal and **“What must be true for you to trust the result?”**; narrate the latter as the contract the second model judges.
5. End on the sealed evidence card, then download the full pack. Finished runs replay from Recent runs, so yesterday's green is always one click away.
