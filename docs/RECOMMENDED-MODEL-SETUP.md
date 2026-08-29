# Recommended model and harness setup

**Status:** Evidence-based operator guidance, not automatic-routing policy  
**Last updated:** 2026-08-29  
**Applies to:** Camus Any-model Build in CLI and Loop Studio  

This document records what Camus should recommend **today**, why, and what is
still unknown. It must not silently become a model admission or routing rule.
Recommendations move only when comparable, sealed evidence justifies the
change.

## The service contract stays constant

Models, providers, harnesses, and reviewers are separate choices:

```text
task -> maker model + provider -> maker executor -> host verifier
     -> independent advisory reviewer -> human acceptance when required
```

- `file_actions` is the compact, host-mediated default.
- Native harnesses are opt-in maker executors, not stronger trust levels.
- Camus freezes the exact model, provider/route, harness artifact, candidate,
  verifier, reviewer, credential revision, and budget before spend.
- OpenRouter experiments pin one upstream provider and disable fallbacks.
- Provider credentials remain in the host process; native workers receive only
  a short-lived one-model gateway capability.
- Deterministic verification is the mechanical floor. An LLM review is advisory
  unless separately admitted, and no Any-model candidate lands automatically.
- An uncertain paid cell is preserved and never silently replayed.

## Current recommendations

These are deliberately conservative. “Incumbent” means the pair is a sensible
manual starting point; it does **not** mean Camus has proven it is the winner.

| Task class | Maker starting point | Executor | Reviewer | Current standing |
| --- | --- | --- | --- | --- |
| Simple, bounded code change | Qwen3.8 Max through OpenRouter, exact Alibaba route | `file_actions` | GPT-5.6 Luna, medium | **Provisional recommendation.** One matched live fixture was exact, verified, and approved with materially less time and usage than Qwen Code. |
| Balanced work | Operator-selected qualified maker; begin with Qwen3.8 Max raw or the existing Claude incumbent | `file_actions` | Independent Luna/Sol seat appropriate to stakes | **No winner.** Collect matched raw/native and cross-model evidence before routing. |
| Difficult or repository-wide work | Existing Claude Opus 4.8 maker + GPT-5.6 Sol high reviewer is the conservative incumbent | Existing qualified path | Sol high | **Incumbent only.** No controlled current-vendor campaign proves optimality. |
| Qwen Code native | Qwen3.8 Max | `qwen_native` | Luna medium | **Exploratory.** Do not prefer for simple tasks. Test next on balanced/difficult work where harness context may amortize its overhead. |
| Grok Build native | Grok 4.6 through direct xAI | `grok_native` | Luna medium | **Pending first live smoke.** Not recommended or routed yet. |

Kimi and Gemini remain second-round candidates by operator decision. Grok and
Qwen are current priorities; that priority does not waive qualification,
containment, or evidence requirements.

## Live evidence behind the recommendation

### Qwen3.8 Max, raw Camus actions

- Run: `20260829-133151-1njw`
- Maker: `qwen/qwen3.8-max`, OpenRouter with exact Alibaba upstream and no
  fallbacks.
- Reviewer: GPT-5.6 Luna, medium.
- Result: exact canonical one-line fix; host verifier passed; independent review
  approved with no findings.
- Maker work: 5 responses, 6 actions, 7,445 measured Qwen tokens, about 83.8
  seconds of maker time.
- Rough generation cost at the then-listed undiscounted OpenRouter rates:
  approximately $0.025. Actual billing was not available in the receipt.
- Human acceptance remained required; Camus did not land the candidate.

### Qwen3.8 Max, native Qwen Code 0.22.3

- Campaign: `qwen38max-openrouter-native-smoke-20260829-v1`
- Receipt:
  `codebench1:240b82c476649bc0f7290152bd749eb17bbecce646d164694c4ca44383f856d3`
- Same model, provider route, fixture, acceptance contract, verifier, and Luna
  reviewer selection as the raw trial.
- Formal standing: **failed**. Qwen Code never produced a definitive terminal,
  so Camus correctly skipped verification/review and refused replay.
- What the preserved transcript showed:
  1. response 1 read the three relevant files;
  2. response 2 made the exact canonical fix;
  3. response 3 attempted the invalid command `node --test test/`;
  4. the candidate retained the exact reference hash, and a later provider-free
     audit ran the correct verifier successfully; this does not upgrade the
     sealed failed receipt.
- Usage: 3 maker responses, 5 actions, 33,475 measured tokens, about 238.5
  seconds. Luna was never called.
- Rough undiscounted generation cost: approximately $0.07 before any cache
  adjustment; actual billing remains unknown.

For this simple case, native Qwen Code was roughly 2.8x slower and used 4.5x the
tokens. That is enough to prefer raw Camus actions for **this task class**, not
enough to reject Qwen Code for larger work.

### Missing and failed trials remain visible

- Qwen3.8 Flash raw Build received an exact-upstream Alibaba HTTP 429 on its
  first maker response. It is missing evidence, not a quality loss.
- The native Qwen receipt remains failed even though its preserved candidate was
  correct. Manual inspection cannot rewrite formal custody evidence.
- No provider-backed Grok Build code-eval receipt exists yet.
- A provider-free 2026-08-29 plan correctly refused the August Grok maker
  qualification as stale under the current adapter/identity contract. Fresh
  maker qualification is required before a Grok campaign can freeze; no xAI
  call or campaign reservation occurred during that check.
- One sample never grants model admission or automatic routing.

## Camus defects found and fixed by this dogfood

| Commit | Finding | Resolution |
| --- | --- | --- |
| `443f291` | OpenRouter provider choice could not be treated as reproducible without route evidence. | Exact upstream and fallback prohibition are now request-bound and receipt-observed. |
| `0c51c74` | A streaming OpenRouter failure could surface too weakly. | Stream failures now remain explicit provider evidence. |
| `2df3793` | Code reviewer prompts could invent prose-eval coverage ledgers. | Code review schemas require all unrelated assessment ledgers to be empty. |
| `806d10d` | The code-eval contract rejected valid slash-qualified model IDs. | Campaign, execution, and observed identity accept bounded provider-qualified IDs such as `qwen/qwen3.8-max`. |
| `b8f13e7` | Qwen Code retried a locally refused fourth request despite a zero-retry campaign. | Native isolation v2 writes a private, drift-refusing Qwen system policy with `maxRetries: 0`; the real pinned binary made exactly one request against a synthetic 429 provider. |

The Qwen native failure itself is not erased by these fixes. A future campaign
uses a new generation and must receive fresh authorization.

## Recommended operator setup

Keep credentials only in the environment that launches Camus/Studio. Never put
their values in the repository, campaign JSON, model settings, shell history, or
diagnostic dumps.

```sh
export OPENROUTER_API_KEY='<operator secret>'
export XAI_API_KEY='<operator secret>'

# Private, digest-reviewed artifacts; examples only.
export CAMUS_QWEN_CODE_BIN='/absolute/path/to/qwen-code-0.22.3/cli-entry.js'
export CAMUS_GROK_BUILD_BIN='/absolute/path/to/grok-build-1.0.5/grok'
```

Use [Native harness qualification](NATIVE-HARNESS-QUALIFICATION-1.md) before
setting either binary path. Camus refuses changed artifacts. Use Studio Settings
or `camus build --setup` to declare connections, then qualify every exact
maker/reviewer tuple. Qualification proves transport and output capabilities;
it does not admit the model as a production reviewer.

For OpenRouter Qwen:

- model IDs remain provider-qualified, for example `qwen/qwen3.8-max`;
- upstream provider is exactly `alibaba`;
- fallbacks remain disabled;
- route metadata must be present and stable for every measured response.

For xAI Grok:

- use the direct `https://api.x.ai/v1` connection currently declared by the
  operator;
- requalify if the credential, model, endpoint, adapter contract, or observed
  server anchors drift;
- keep Grok as a maker experiment until separate reviewer admission exists.

## How to choose raw versus native

Choose the cheapest path that can meet the task contract:

1. Prefer `file_actions` for small, well-localized edits with deterministic
   verification. Its compact prompt and host-owned actions are currently faster
   and cheaper for the measured simple fixture.
2. Consider a native harness when the task materially benefits from repository
   discovery, context management, native coding tools, or longer coherent work.
3. Do not select native merely because the vendor says the model is strongest in
   its harness. Measure useful completion, verification, review, latency, tokens,
   and intervention on matched tasks.
4. Never compensate for an uncertain terminal by automatically replaying it.
5. Do not make automatic-routing changes from a smoke. Require repeated,
   task-class-specific, human-calibrated evidence first.

## Next evidence sequence

1. **Grok Build live smoke before release.** The refreshed campaign is valid
   against the current route-aware contract and native isolation v2, and the
   reviewed Grok Build 1.0.5 artifact is ready. Requalify the stale Grok maker
   tuple under a separately bounded authorization, freeze the provider-free
   plan, then run one simple cell with direct xAI, no fallback, no repair/retry,
   and Luna review only after another fresh spend authorization.
2. **Do not blindly repeat Qwen simple.** Its result already answers the simple
   task question and exposed the retry-policy defect.
3. **Add a balanced fixture in Code Harness Eval v1b.** Use the same model,
   route, reviewer, verifier, and budget across raw/native arms. The task should
   be large enough for harness context management to matter but remain synthetic
   and deterministically gradable.
4. **Run matched raw/native pairs.** Start with Qwen3.8 Max, then Grok 4.6. Keep
   failures and human interventions in the denominator.
5. **Add difficult-task evidence only after the balanced treatment is sound.**
   Expand repetitions before comparing cross-model combinations.
6. **Route automatically only after enough evidence exists.** Routing must be
   opt-in, task-class-specific, uncertainty-aware, and reversible; incomplete
   calibration falls back to the explicit operator selection.

## Release gate for the current branch

The branch should not release immediately. First:

- finish one bounded Grok Build provider-backed smoke and preserve its outcome;
- fix only deterministic Camus defects the smoke exposes—do not tune away a
  legitimate model/harness loss;
- rerun the full Studio and root/CLI suites, `git diff --check`, and the npm
  package extraction/compatibility checks;
- update release notes and package version for the next patch release;
- keep the public wording honest: native evidence infrastructure and observed
  smokes, no optimal-combination or automatic-routing claim.

After those checks, release the infrastructure even if a native smoke fails
honestly. A failed, sealed experiment is useful product evidence; an untested
harness path is not.
