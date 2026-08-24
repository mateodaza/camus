# Camus Review Contract

**Contract version: `rc1`**

This is the versioned agreement between the review REQUESTER (the `camus-loop` /
`camus-feat` workflows) and the review EXECUTOR (`review.sh` → an admitted backend).
`codex_review.sh` remains the only production-admitted executor. The
`http_openai_compat` implementation is a benchmark candidate and cannot be selected through
the dispatcher until Slice G admission changes its checked-in gate.
It names the fields that must travel, unchanged, through every artifact a review
produces — so a receipt can be checked against the request that asked for it, not
merely trusted because it parsed.

The load-bearing enforcement is `asGate` in the workflow: it compares the emitted
binding, field by field, against expectations THE WORKFLOW ITSELF computed (inlined
into the command, never round-tripped through the thin runner). Everything here is
the shape of that comparison. The consistency checks inside `codex_review.sh` are
defense-in-depth, not the guarantee.

## The version field is load-bearing

`contract` is owned by `codex_review.sh` as its compiled-in constant (`rc1`), never
echoed from the request. A fresh run seals that value into `meta.json`. Before replay,
adoption, or await can emit a finished verdict, the executor proves the stored value
equals its current constant; missing or drifted values are infrastructure refusals and
the audit is not rewritten. `asGate` then refuses when the emitted value does not equal
the version the workflow expects. A script/workflow disagreement is version skew — an
install that copied one half — and must be loud. Bump this version (and the
`REVIEW_CONTRACT` constants on both sides) whenever the carried fields change.

## Carried fields

Every field below is written into the review REQUEST file, sealed into the round's
`meta.json`, recorded in the per-round AUDIT record, and emitted in the BINDING on
`codex_review.sh` stdout. Reattach (`await`), live-review ADOPTION, and REPLAY of a
finished round all rebuild the binding from `meta.json`; the executor validates the
stored contract version before emitting, so these boundaries preserve rather than
relabel the sealed values.

| Field | Source of truth | Values |
|---|---|---|
| `contract` | executor constant (`rc1`) | the contract version |
| `scope` | normalized argv (executor) | `full` \| `light` |
| `qualification` | derived/bound by executor | transitional admitted lane: `builtin1` \| `qual1`; configurable candidates: exact `qual1:<sha256>` |
| `origin` | requester, echoed | e.g. `camus-loop` |
| `operator` | requester, echoed | e.g. `claude-code` |
| `transport` | executor constant | e.g. `cli-detached`, `loopback`, `direct_https`, `ssh_tunnel` |
| `connection` | derived by executor | `vendor_managed` \| `configured` |

`origin` and `operator` describe the CALLER and cannot be known independently by the
executor, so it echoes them; `asGate` still compares them against the workflow's own
constants, so a command the runner mangled is caught. `transport` and `contract` are
executor constants. `scope`, `connection`, and `qualification` are computed by the
executor from what it ACTUALLY ran — which is what lets `asGate` catch a review that
drifted from the one requested.

The workflow runtime has no process-environment authority. Identity-affecting Codex
settings therefore enter a workflow through its run-start arguments (`reviewerModel`,
`reviewerCodexArgs`, and `reviewerLightModel`) and are explicitly exported into the
review child, including empty values that clear runner ambient state. Native/direct
callers may derive the same expectation from their finalized child environment.

On resume, every stored field in this table belongs to the original thread. The
executor compares all seven against the current invocation before launching
`codex exec resume`; missing or drifted fields are refused. A resumed thread is never
relabelled with a newer contract, broader scope, or different trust tier.

## Scope

`full` audits the surrounding repository; `light` judges the diff primarily (same
severity bar, narrower field of view). `asGate` compares scope by EXACT equality in
both directions. In particular a `light` review can never satisfy a `full` request
("light-behind-full" is a downgrade of coverage, refused), and a `full` review does
not silently satisfy a `light` request either — the requested and actual scope must
be identical.

## Qualification

`qualification` is the reviewer's trust tier, derived by the executor:

- **`builtin1`** — the reviewer is the EXACT built-in Codex backend (`codex`) over a
  `vendor_managed` connection: no pinned model or routing override, user config excluded
  with `--ignore-user-config` (authentication still comes from `CODEX_HOME`), repository
  config excluded by a per-call untrusted-project override, `OPENAI_BASE_URL` stripped,
  and no system or managed configuration evidence. This includes ordinary system config,
  `managed_config.toml`, `requirements.toml`, and macOS MDM Codex preferences; managed
  layers can override CLI values, so their presence conservatively makes the run `qual1`.
  An explicit `model_catalog_json` is identity-affecting and does the same. This is the
  only tier that qualifies as the hardened built-in gate.
- **`qual1`** — anything configurable: an alternate backend, a pinned reviewer model,
  or any non-`vendor_managed` connection. A capable review, but not the built-in one.

The admitted Codex lane retains the rc1 tier labels above until its receipt migration lands.
A configurable backend candidate must already bind the exact accepted qualification receipt
fingerprint (`qual1:<64 lowercase hex>`); a bare `qual1` request is insufficient and refuses.
For the generic HTTP candidate, that fingerprint also locates an expiring local authority record
whose HMAC covers the reviewer backend, model, training organization, transport, and connection.
The reviewer organization comes from that record—not from the request or process environment—so
caller text cannot forge a cross-vendor pairing.
Admission cannot be flipped merely by changing the dispatcher registry: the workflow must first
carry that exact accepted fingerprint as its independently expected qualification.

`asGate` compares qualification by EXACT equality and refuses drift in BOTH
directions: a request expecting `builtin1` is not satisfied by a `qual1` review (the
built-in gate was quietly reconfigured), and a request expecting `qual1` is not
satisfied by a `builtin1` review (a receipt claiming the built-in tier the run did
not actually request). Neither direction passes.

Workflow runtimes cannot inspect host configuration. On a managed host, the executor therefore
emits `qual1`; an unpinned workflow that expected `builtin1` fails closed on the mismatch. Pin a
reviewer model in the run-start arguments when that managed review is intentional, which makes
the requester independently expect `qual1` too.

## Terminal provenance

The run's reported provenance (backend, model, effort, scope, qualification, origin,
operator, transport, connection) is derived ONLY from a binding that `asGate`
ACCEPTED. A rejected or unbindable review contributes no provenance — an infra
failure is never a source of truth about who reviewed what.
