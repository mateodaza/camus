# Recommended model and harness setup

**Status:** Evidence-based operator guidance, not automatic-routing policy  
**Last updated:** 2026-08-30
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
- Code-eval candidate integrity permits edits only to source paths declared by
  the selected fixture's reference files; unexpected tracked or untracked paths
  cannot receive a mechanically green standing.
- An uncertain paid cell is preserved and never silently replayed.

## Current recommendations

These are deliberately conservative. “Incumbent” means the pair is a sensible
manual starting point; it does **not** mean Camus has proven it is the winner.

| Task class | Maker starting point | Executor | Reviewer | Current standing |
| --- | --- | --- | --- | --- |
| Simple, bounded code change | Qwen3.8 Max through OpenRouter, exact Alibaba route | `file_actions` | GPT-5.6 Luna, medium | **Provisional recommendation.** One matched live fixture was exact, verified, and approved with materially less time and usage than Qwen Code. |
| Balanced work | Operator-selected qualified maker; begin with Qwen3.8 Max raw or the existing Claude incumbent | `file_actions` | Independent Luna/Sol seat appropriate to stakes | **No winner.** Collect matched raw/native and cross-model evidence before routing. |
| Difficult or repository-wide work | Decompose first; otherwise choose an exact qualified model whose reviewed native harness fits the repository | Native executor where available | Sol high or another independent high-stakes seat | **No preferred model.** Two cross-file `file_actions` dogfoods spent their allowance in discovery and produced no diff; do not treat a larger call cap as the fix. |
| Qwen Code native | Qwen3.8 Max | `qwen_native` | Luna medium | **Exploratory.** Do not prefer for simple tasks. Test next on balanced/difficult work where harness context may amortize its overhead. |
| Grok Build native | Grok 4.6 through direct xAI | `grok_native` | Luna medium | **Exploratory; not routed.** The latest bounded cell made the exact fix, but exhausted its frozen turn cap before a definitive terminal or review. This is useful harness evidence, not a formal pass or model ranking. |

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
- Grok campaign `grok46-native-smoke-20260829-v2` produced receipt
  `codebench1:ba6c32e732ace7c20ac59fa1bdae6640c130cd3e7e5547e7f172a0f1640287cf`
  with formal standing **failed**. The candidate remained unchanged and Luna
  was not called, so this is integration evidence rather than a quality loss.
- The Grok cell made one real xAI request. Grok's isolated session reported
  4,571 total tokens and 88,060,000 USD ticks ($0.008806). A second harness
  request was refused locally by Camus and did not reach xAI. The sealed Camus
  receipt conservatively records two maker responses, zero observed tokens,
  and a 32,768-token unknown-usage reservation; private forensic evidence does
  not rewrite that receipt.
- The cell exposed two deterministic defects: Camus rejected xAI reasoning
  usage because `total_tokens` separately includes `reasoning_tokens`, then
  treated documented Grok Build stream events/intermediate text as an invalid
  final protocol. Commit `afd5061` fixes both and keeps malformed totals,
  unknown stream types, prohibited tools, model substitution, and fallbacks
  fail-closed. A new campaign generation and fresh spend authorization are
  required before another live cell.
- Replacement campaign `grok46-native-smoke-20260829-v3` executed the frozen
  cell `cell1:a938fb6148f8d1326b474d07606bb92d1e9b7868fd12e73a379c196d998fb25f`
  and sealed receipt
  `codebench1:4407858998eccc0902f2cba89931a5557a31b1b9c47743fb846a79d56180f59c`
  with formal standing **failed**. It stayed within the authorized three Grok
  calls, 10,679 measured tokens, two actions, and about 7.2 active seconds;
  Luna was not called and the candidate remained unchanged.
- The pinned Grok session records two main agent turns: two bounded repository
  listing commands, the second successful. A third direct-xAI response generated
  the session title, after which the next main inference was refused locally by
  the frozen three-call cap. Grok Build's
  [session documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)
  and [title implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/summary.rs)
  confirm that its first title is a separate model call. This is harness overhead,
  not hidden provider fallback or a substitute model, and must remain visible in
  call and billing evidence.
- Native isolation v3 now disables the supported optional `title_refresh`,
  `turn_summary`, and `session_recap` model side-calls in both the private config
  and higher-precedence environment. Grok Build 1.0.5 does not expose a supported
  switch for the initial title call, so Camus does not patch session files or
  pretend the call did not happen. A campaign must budget that fixed title call
  separately and leave a work turn after the final tool result for a definitive
  terminal; tool-producing turns alone do not close the harness session.
- Campaign `grok46-native-smoke-20260829-v4` sealed receipt
  `codebench1:4a39e33fe932212d12c638a63a37e0ef330d0a968f3db7598a97343935346dd5`
  with formal standing **failed** after exactly four direct-xAI Grok calls,
  16,152 accounted tokens, three actions, and about 13.4 active seconds. Luna
  was not called; there was no retry, repair, fallback, substitution, or Git
  landing.
- The preserved v4 transcript has three main Grok turns plus the initial-title
  call. Turn one attempted broad discovery and hit the intentionally blocked
  `.git` boundary; turn two read the exact fixture files; turn three made the
  canonical one-line inclusive-bound fix. The cap then stopped the harness before
  a final terminal turn. A provider-free audit ran the frozen verifier successfully,
  but cannot upgrade the failed receipt or authorize candidate adoption.
- Native prompts now include the bounded host-observed tracked-file inventory and
  explicitly avoid blocked hidden-root/broad-discovery calls. This removes a
  Camus-created source of wasted native turns without relaxing `.git` isolation or
  tuning away a legitimate model decision.
- One sample never grants model admission or automatic routing.

### Productive `file_actions` context evidence

- [Dogfood 1](DOGFOOD-PRODUCTIVE-LOOP-1.md) used Luna medium on the cross-file
  offline-inspection feature. It consumed 14 maker calls and 32 list/read actions,
  produced no mutation, and exposed a context-rollover defect.
- [Dogfood 2](DOGFOOD-PRODUCTIVE-LOOP-2.md) used Claude Opus 4.8 medium after
  rollover and focused-edit fixes. Eight successful responses still used only
  discovery; eight of 19 reads repeated exact unchanged bodies. The ninth call
  reached its five-minute ceiling with no durable response. Camus failed closed,
  but the candidate remained empty and the reviewer never ran.
- These runs do not rank Luna against Opus. They establish that broad cross-file
  implementation is currently a poor fit for whole-file `file_actions` retrieval.
  The loop now warns after four mutation-free discovery steps and parks after
  seven. For genuinely broad work, decompose or use a reviewed native harness;
  do not extend a stalled raw-action run by default.

## Camus defects found and fixed by this dogfood

| Commit | Finding | Resolution |
| --- | --- | --- |
| `443f291` | OpenRouter provider choice could not be treated as reproducible without route evidence. | Exact upstream and fallback prohibition are now request-bound and receipt-observed. |
| `0c51c74` | A streaming OpenRouter failure could surface too weakly. | Stream failures now remain explicit provider evidence. |
| `2df3793` | Code reviewer prompts could invent prose-eval coverage ledgers. | Code review schemas require all unrelated assessment ledgers to be empty. |
| `806d10d` | The code-eval contract rejected valid slash-qualified model IDs. | Campaign, execution, and observed identity accept bounded provider-qualified IDs such as `qwen/qwen3.8-max`. |
| `b8f13e7` | Qwen Code retried a locally refused fourth request despite a zero-retry campaign. | Native isolation v2 writes a private, drift-refusing Qwen system policy with `maxRetries: 0`; the real pinned binary made exactly one request against a synthetic 429 provider. |
| `afd5061` | xAI reasoning usage was rejected as incomplete, and Grok Build's documented event/text boundaries were parsed as one strict final frame. | The gateway accepts only the two documented reasoning-total shapes; Grok's pinned stream vocabulary, bounded reasoning/errors, intermediate response boundaries, and chunked final decision are now validated explicitly. |
| Native isolation v3 | Grok Build's automatic title consumed one of three frozen maker calls, and the resulting local abort surfaced only as a generic cancellation. | Camus disables every supported optional summary/title side-call, refuses config drift, and retains the exact local stop reason. The unavoidable first-title call remains counted and must receive an explicit budget. |
| Native path inventory | Grok spent a bounded turn discovering files through a broad command that touched intentionally blocked `.git` metadata. | The host supplies its bounded tracked-path inventory and warns native makers that blocked broad discovery still consumes turn/action budget; the sandbox remains unchanged. |
| Native pre-action ceiling | Grok Build emitted its tool event only after action N+1 had already changed the disposable candidate, so a host-side event abort was too late to be a hard action limit. | The one-run gateway now counts buffered operative tool calls and withholds an over-limit provider response before the harness can execute it. The exact pinned Grok Build probe proves action 1 succeeds and action 2 leaves no file. |
| Productive loop 2 | A maker could keep collecting novel source through the whole step budget even when it never proposed a mutation. | The host now binds a named progress policy into fresh checkpoints, warns at four consecutive mutation-free discovery steps and parks at seven; exact unchanged-discovery stagnation remains independently bounded, while older v2 prompt hashes remain resumable. |

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

1. **Do not rerun the simple Grok smoke.** v2–v4 are sealed and together answer
   the integration, accounting, and simple-task behavior questions. The v4
   candidate was correct but lacked a definitive terminal; manual verification
   does not rewrite that outcome.
2. **Do not blindly repeat Qwen simple.** Its result already answers the simple
   task question and exposed the retry-policy defect.
3. **Use the provider-free balanced fixture now available.** Inspect
   `balanced-job-event-scheduler` with
   `camus code-eval fixture --case balanced-job-event-scheduler --json`. One
   executed cell is one balanced-case observation, not balanced-class evidence.
4. **Use the bounded matched raw/native evaluator before claiming a comparison.**
   The provider-free v1b implementation now freezes one exact case and
   counterbalances its raw/native arms, but no new live v1b pair has run. After
   release, start with Qwen3.8 Max, then Grok 4.6, using the same model, route,
   reviewer, verifier, fixture, and budget. Keep failures and human interventions
   in the denominator; the strongest result is still case-only, not a winner.
5. **Add difficult-task evidence only after the balanced treatment is sound.**
   Expand repetitions before comparing cross-model combinations.
6. **Route automatically only after enough evidence exists.** Routing must be
   opt-in, task-class-specific, uncertainty-aware, and reversible; incomplete
   calibration falls back to the explicit operator selection.

## Release gate for the current branch

The branch should not release immediately. First:

- preserve all bounded Grok Build failures and the provider-free evidence that
  explains them; another paid simple smoke is not a release prerequisite;
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
