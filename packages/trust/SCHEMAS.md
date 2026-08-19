# Published schemas register

The JSON Schema files under `schemas/` are the published wire contract. This
register names every file, records which envelope binds which interior block
versions, states the immutability rule once, and pins the cross-version tuples a
reader accepts. The prose here is a pointer; the schema files and
`lib/validate.mjs` are the enforced spec, and the test suite asserts the two
agree so neither can drift alone.

## The envelope and its interior blocks

An evidence pack is an envelope carrying two versioned interior blocks — a
pairing manifest and a status-dimensions object. The envelope version is the
single key: one pack version number says everything about its shape, and the
interior versions are consistency assertions, not independent degrees of
freedom.

- **Envelope 1** → pairing 1 + statuses 1. The shipped legacy shape.
- **Envelope 2** → pairing 1 + statuses 1. Adds deterministic acceptance-contract
  coverage to the artifact; pairing and status blocks stay at version 1.
- **Envelope 3** → pairing 2 + statuses 2. Same top-level pack fields as
  envelope 2; the interior blocks bump to carry the structured origin facts and
  the extended audit dimension.

## Files

Every published schema, with its pointer:

- `schemas/evidence-pack.v1.schema.json` — envelope 1.
- `schemas/evidence-pack.v2.schema.json` — envelope 2.
- `schemas/evidence-pack.v3.schema.json` — envelope 3 (pairing 2 + statuses 2).
  The `pairing` and `statuses` properties are bound with a JSON Schema `$ref` to
  the `$id` of `pairing-manifest.v2.schema.json` and `status.v2.schema.json`, so
  the envelope determines each interior block exactly rather than accepting an
  arbitrary object. A reader resolving those refs loads the two published v2
  files by their `$id`; the interior versions are enforced by the envelope, not
  merely asserted in prose.
- `schemas/pairing-manifest.v1.schema.json` — pairing 1: the executor/auditor
  string forms and the `cross_vendor | same_vendor_advisory | none` independence
  enum.
- `schemas/pairing-manifest.v2.schema.json` — pairing 2: each seat sealed with
  its structured origin facts (training org, model family, lineage, transport,
  origin confidence, and an always-present qualification), plus the
  `cross_vendor_declared` independence value, `shared_gateway`, and
  `review_scope`.
- `schemas/status.v1.schema.json` — statuses 1: the six-value audit enum.
- `schemas/status.v2.schema.json` — statuses 2: adds the
  `declared_clean`/`declared_findings` audit pair (configured cross-vendor
  standing whose origin is declared, not attested).
- `schemas/economics.v1.schema.json` — per-role cost record.
- `schemas/human-decision.v1.schema.json` — a recorded human decision or
  adjudication.
- `schemas/benchmark-record.v1.schema.json` — a curated review-corpus record.
- `schemas/experiment.v1.schema.json` — audit-only replay experiment.
- `schemas/experiment.v2.schema.json` — parallel-execution experiment.

## Immutability rule

A published schema version is a frozen contract. Its field set, enums, and
canonical serialization never change after it ships; any change — however
additive it feels — is a new version number. Readers accept every published
version forever; producers emit only the newest, with exactly **one sanctioned
production exception**: an audit-only replay seals its replay pack in its
*source's* envelope version — a replay is a re-audit of a sealed artifact, and
sealing it in the source's shape keeps the pair comparable and never back-fills
fields the source run never recorded. There is no other dual-production mode:
new runs seal the newest versions, old receipts stay what they are.

## Accepted tuples

`validate.mjs` accepts exactly three `envelope/pairing/statuses` version tuples;
every other tuple refuses, including mixed, missing, and future versions (fail
closed, never fail forward):

| tuple (envelope/pairing/statuses) | verdict |
| --- | --- |
| 1/1/1 | accept — the shipped v1 acceptance rules, frozen; no v2-only field, no `declared_*` value |
| 2/1/1 | accept (legacy), iff pairing carries no v2-only field and audit carries no `declared_*` value |
| 3/2/2 | accept, iff every v2 field is present with enum membership and every cross-check passes |

An envelope-1/2 pack carrying any v2-only pairing field refuses (half-upgraded);
an envelope-3 pack missing any v2 field refuses. The version tuple determines the
shape, and nothing outside these three tuples loads.
