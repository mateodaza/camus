# Productive-loop dogfood 1 — failed before implementation

Date: 2026-08-28. Frozen baseline: `e8df8dd2380d767f89e0b21f84e7bd3c7be0e97e`.
Run: `code-1787946935729-3befd19c`. Private receipts remain on the operator's machine;
no raw checkpoint, prompt, credential or private filesystem path is published here.

## Contract and bounds

Add an offline `camus build --inspect RUN_ID [--json]` command explaining an
authenticated coding checkpoint and its next safe action without writing state,
contacting providers, or claiming advisory review as gate approval. The task,
acceptance contract and independent host-owned acceptance script were frozen
outside the candidate before launch. Feature implementation was left to Camus.

- Maker: `codex:gpt-5.6-luna`, medium effort; authenticated ChatGPT CLI route.
- Reviewer selected: `claude:claude-opus-4-8`; authenticated Claude account route.
  **The reviewer never ran**, so this attempt is not evidence about that pairing.
- Limits: 18 model calls, 14 maker steps, 40 host actions, two repairs, one recovery
  retry, 20 active minutes, five minutes/call, 400,000 accounting tokens.
- xAI and DashScope credentials were unavailable in the launch environment.
  No credentials were extracted from other processes and no hosted model was substituted.
- No supervisor edits, human answers, budget extensions, automatic landing or publication.

## Observed outcome

| Measure | Observed |
| --- | --- |
| Wall time | 127.499 seconds |
| Active / model time | 127.353 / 121.921 seconds |
| Maker calls / host actions | 14 / 32 |
| Writes / candidate diff | 0 / empty |
| Verification / reviewer calls | 0 / 0 |
| Terminal | `needs_decision`, maker-step budget exhausted |
| Reported input tokens | 311,959, including 125,184 reported cached input tokens |
| Reported output tokens | 1,985 |
| Total accounting tokens | 313,944 |
| Actual dollar cost | Unknown; reported token counts are not a billing receipt |

These timings and tokens cover the Camus worker only, not task preparation,
the supervising conversation, or the offline diagnosis/fix. Their combined token
cost is not available in this receipt and is not claimed to be zero.

Safety/ownership worked: the source checkout stayed clean, the separate candidate
and usage survived, and the limit stopped further spend. Productivity did not:
every action was a listing or read. The inspector feature is **not implemented**.
This is not an accepted result, autonomous success, calibration trial, or model ranking.

## Cause supported by the trace

Before call six, the full prompt reached 133,617 bytes, exceeding the 131,072-byte
context limit. The maker had read 12 distinct files totaling 115,016 source bytes.
The old rollover kept hashes for all those files but source bodies only from the
last step. After a listing it therefore retained none of those source bodies.
Maker summaries were also discarded. Repeated list/read cycles followed and no
discovery-stagnation safeguard stopped them before the step budget did.

This identifies a reproducible Camus context defect. It does **not** establish
that Luna lacks coding capability or that another model would have succeeded.

## Bounded offline follow-up

Added regressions that first failed on the frozen implementation: losing source
bodies after a listing, and buying repeated unchanged discovery through the cap.
The fix deduplicates retained current sources, preserves non-authoritative maker
intent, names omitted bodies, and never clips required context or latest reads.
Three no-new-evidence discovery steps warn the maker within its normal turn;
six stop rather than consume the rest of the allowance. New evidence or mutations
reset that observation, not the run's actual budgets.

Re-projecting this exact trace locally retains all 12 source bodies after rollover,
at 127,903–128,875 bytes for calls six through ten, still below the original limit.
That is an offline context check, **not a successful model rerun**. The original
receipt remains untouched and unsuccessful. No further provider calls were bought.

Offline validation passed: the full Studio suite (including 18 productive-loop
cases and 15 forced-crash action windows plus verifier cleanup), CLI/Studio
continuation integration, extracted npm runtime execution, and `git diff --check`.
Native workflows, trust schemas, provider adapters and admission rules were not changed.

Release remains on hold. A fresh, explicitly bounded run on the corrected revision
must finish useful code, pass the frozen acceptance check, and receive actual
review before the productive-loop readiness claim can be reconsidered.
