# camus-trust

The trust-layer protocol artifacts (see [DIRECTION-0.3-TRUST-LAYER.md](../../docs/DIRECTION-0.3-TRUST-LAYER.md)). Zero dependencies; the schemas are the published spec, the lib enforces it, the tests hold the two in agreement.

- `schemas/*.v1.schema.json` — versioned: status dimensions, economics, human decisions, pairing manifest, evidence pack, benchmark record.
- `lib/status.mjs` — the orthogonal status model and `deriveHeadline()`, a pure function tested over every combination. Raw dimensions persist forever; headlines are disposable presentation a newer Camus recomputes without touching historical evidence.
- `lib/canonical.mjs` — canonicalization rules and `computeArtifactId()`: `artifact_id = sha256(canonical bundle minus derived fields)`. Any change of meaning changes the id and expires prior audits.
- `lib/redact.mjs` — secret and path scrubbing for corpus ingestion.
- `lib/validate.mjs` — runtime validators, including two protocol refusals: a `cross_vendor` claim with one provider on both roles, and a headline persisted inside the dimensions object.
- `ingest-reviews.mjs` — redact-by-default corpus ingestion from `~/.camus/reviews` into `benchmark/records/` (gitignored — real records stay local), with a `PENDING-ADJUDICATION.md` worksheet. The tool never guesses truth: every finding starts `unresolved` until a human adjudicates it.

```bash
npm test        # exhaustive derivation + canonicalization + validators + ingester fixture
npm run ingest  # curate the local review corpus (redacting); adjudication is the human's half
```

## Published schemas

[SCHEMAS.md](./SCHEMAS.md) is the register of the published wire contract: every schema file, which envelope binds which interior block versions (envelopes 1/2/3, pairing 1/2, statuses 1/2), the immutability rule with its one audit-replay production exception, and the accepted cross-version tuples.

Deliberately absent, per the direction: provider adapters, model-picker UI, reverse pairing. Those wait until these artifacts exist so implementation details never define the protocol by accident.
