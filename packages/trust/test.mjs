// camus-trust self-test: the derivation function is exercised over EVERY
// dimension combination; canonicalization, redaction, validators, and the
// ingester run against fixtures. Zero network, zero deps.

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIMENSIONS, HEADLINES, deriveHeadline, allCombinations, validStatus, DECLARED_CROSS_VENDOR_REVIEWED_DISPLAY } from './lib/status.mjs';
import { canonicalize, canonicalString, computeArtifactId, computeReceiptId, artifactMatches, receiptMatches, seal, artifactProjection, receiptProjection } from './lib/canonical.mjs';
import { computeExperimentId, experimentMatches, sealExperiment } from './lib/experiment.mjs';
import { scrubSecrets, scrubPaths, redactFinding } from './lib/redact.mjs';
import { validateStatus, validatePairingManifest, validateEvidencePack, validateBenchmarkRecord, validateHumanDecision, validateEconomics, validateExperimentRecord } from './lib/validate.mjs';

// --- status: exhaustive totality + protocol invariants ----------------------
{
  const combos = allCombinations();
  assert.equal(combos.length, 5 * 5 * 8 * 2, 'full combination space');
  for (const d of combos) {
    const h = deriveHeadline(d);
    assert.ok(HEADLINES.includes(h), `total function: ${JSON.stringify(d)} → ${h}`);

    // Invariant 1: nothing incomplete ever reads as trusted or published.
    if (d.execution !== 'completed') {
      assert.ok(h === 'unverified' || h === 'needs_decision', `incomplete never trusted: ${JSON.stringify(d)} → ${h}`);
    }
    // Invariant 2: same-vendor audits never earn verified*/published.
    if (d.audit === 'advisory_clean' || d.audit === 'advisory_findings') {
      assert.ok(!['verified', 'verified_with_findings', 'published'].includes(h), `advisory never verified: ${JSON.stringify(d)} → ${h}`);
    }
    // Invariant 3: an infra failure is never a pass.
    if (d.verification === 'infra_failed' || d.audit === 'infra_failed') {
      assert.ok(!['verified', 'verified_with_findings', 'published', 'same_vendor_reviewed'].includes(h), `infra never passes: ${JSON.stringify(d)} → ${h}`);
    }
    // Invariant 4: verified* requires BOTH the deterministic green and an
    // independent audit.
    if (h === 'verified' || h === 'verified_with_findings') {
      assert.ok(['passed', 'passed_with_caveats'].includes(d.verification), 'verified needs a deterministic green');
      assert.ok(['independent_clean', 'independent_findings'].includes(d.audit), 'verified needs an independent audit');
    }
    // Invariant 5: published only over a would-be-verified state.
    if (h === 'published') {
      const inner = deriveHeadline({ ...d, publication: 'not_published' });
      assert.ok(inner === 'verified' || inner === 'verified_with_findings', 'published implies verified underneath');
    }
    // Invariant 6: publishing never upgrades a substandard state to anything
    // quieter than needs_decision.
    if (d.publication === 'published') {
      assert.ok(h === 'published' || h === 'needs_decision', `published is loud or clean: ${JSON.stringify(d)} → ${h}`);
    }
  }

  // Canonical spot checks — the table rows the docs will quote.
  const base = { execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' };
  assert.equal(deriveHeadline(base), 'verified');
  assert.equal(deriveHeadline({ ...base, verification: 'passed_with_caveats' }), 'verified_with_findings');
  assert.equal(deriveHeadline({ ...base, audit: 'independent_findings' }), 'verified_with_findings');
  assert.equal(deriveHeadline({ ...base, audit: 'advisory_clean' }), 'same_vendor_reviewed');
  assert.equal(deriveHeadline({ ...base, audit: 'not_run' }), 'unverified');
  assert.equal(deriveHeadline({ ...base, verification: 'not_run' }), 'unverified');
  assert.equal(deriveHeadline({ ...base, verification: 'failed' }), 'needs_decision', 'judges disagree → human');
  assert.equal(deriveHeadline({ ...base, verification: 'failed', audit: 'independent_findings' }), 'unverified', 'red + findings is just red');
  assert.equal(deriveHeadline({ ...base, publication: 'published' }), 'published');
  assert.equal(deriveHeadline({ ...base, verification: 'failed', publication: 'published' }), 'needs_decision', 'published-but-unverified is loud');
  assert.equal(deriveHeadline({ execution: 'interrupted', verification: 'not_run', audit: 'not_run', publication: 'not_published' }), 'unverified');
  assert.throws(() => deriveHeadline({ execution: 'nope' }), TypeError, 'invalid dimensions throw');
  assert.ok(!validStatus({ execution: 'completed' }), 'partial status is invalid');
}

// --- §10.8.3 declared_* headline truth table, exhausted through allCombinations
{
  const DCR = 'declared_cross_vendor_reviewed';
  let declaredCells = 0;
  for (const d of allCombinations()) {
    if (d.audit !== 'declared_clean' && d.audit !== 'declared_findings') continue;
    declaredCells += 1;
    const h = deriveHeadline(d);
    // The published overlay: a published declared_* pack never meets the
    // publication bar (rule P over an inner DCR/unverified) — it is a loud
    // needs_decision, exactly like a published same-vendor advisory.
    if (d.publication === 'published') {
      assert.equal(h, 'needs_decision', `published-DCR overlay → needs_decision: ${JSON.stringify(d)}`);
      continue;
    }
    // Any execution ≠ completed → unverified for every declared cell.
    if (d.execution !== 'completed') {
      assert.equal(h, 'unverified', `incomplete declared_* → unverified: ${JSON.stringify(d)}`);
      continue;
    }
    // execution: completed, publication: not_published — the §10.8.3 rows.
    let expected;
    if (d.verification === 'passed' || d.verification === 'passed_with_caveats') {
      expected = DCR; // passed / passed_with_caveats × declared_clean|declared_findings
    } else if (d.verification === 'failed') {
      expected = d.audit === 'declared_clean' ? 'needs_decision' : 'unverified';
    } else {
      expected = 'unverified'; // not_run, infra_failed
    }
    assert.equal(h, expected, `§10.8.3 declared cell: ${JSON.stringify(d)}`);
  }
  // 2 declared audit values × the rest of the space (5 execution × 5 verification × 2 publication).
  assert.equal(declaredCells, 2 * 5 * 5 * 2, 'the truth table is exhausted over both declared values');
  // Named anchor rows, so a mutated table row is caught by an explicit case too.
  const base = { execution: 'completed', publication: 'not_published' };
  assert.equal(deriveHeadline({ ...base, verification: 'passed', audit: 'declared_clean' }), DCR);
  assert.equal(deriveHeadline({ ...base, verification: 'passed', audit: 'declared_findings' }), DCR);
  assert.equal(deriveHeadline({ ...base, verification: 'passed_with_caveats', audit: 'declared_clean' }), DCR);
  assert.equal(deriveHeadline({ ...base, verification: 'passed_with_caveats', audit: 'declared_findings' }), DCR);
  assert.equal(deriveHeadline({ ...base, verification: 'failed', audit: 'declared_clean' }), 'needs_decision', 'declared_clean joins the clean-review set under red');
  assert.equal(deriveHeadline({ ...base, verification: 'failed', audit: 'declared_findings' }), 'unverified', 'declared red + findings is just red');
  assert.equal(deriveHeadline({ ...base, verification: 'not_run', audit: 'declared_clean' }), 'unverified');
  assert.equal(deriveHeadline({ ...base, verification: 'infra_failed', audit: 'declared_findings' }), 'unverified');
  assert.equal(deriveHeadline({ execution: 'completed', verification: 'passed', audit: 'declared_clean', publication: 'published' }), 'needs_decision', 'published-DCR is loud, not published');
}

// --- wording lock: the declared headline never launders into a stronger word
// (acceptance test 9). Neither the locked display copy nor the token itself may
// contain the bare words 'independent' or 'verified'.
{
  assert.equal(DECLARED_CROSS_VENDOR_REVIEWED_DISPLAY, 'cross-vendor as configured — origin declared, not attested', 'display copy is locked');
  assert.ok(!DECLARED_CROSS_VENDOR_REVIEWED_DISPLAY.includes('independent'), 'display copy never says independent');
  assert.ok(!DECLARED_CROSS_VENDOR_REVIEWED_DISPLAY.includes('verified'), 'display copy never says verified');
  const token = 'declared_cross_vendor_reviewed';
  assert.ok(HEADLINES.includes(token), 'the declared headline token is a real headline');
  assert.ok(!token.includes('independent'), 'the token never says independent');
  assert.ok(!token.includes('verified'), 'the token never says verified');
}

// --- SCHEMAS.md register pins every schema file and exactly the accepted tuples
{
  const schemaFiles = readdirSync(new URL('./schemas/', import.meta.url)).filter((f) => f.endsWith('.schema.json'));
  assert.ok(schemaFiles.length > 0, 'there are published schema files to pin');
  const register = readFileSync(new URL('./SCHEMAS.md', import.meta.url), 'utf8');
  for (const f of schemaFiles) {
    assert.ok(register.includes(f), `SCHEMAS.md names ${f}`);
  }
  const tuples = [...new Set([...register.matchAll(/\b\d\/\d\/\d\b/g)].map((m) => m[0]))].sort();
  assert.deepEqual(tuples, ['1/1/1', '2/1/1', '3/2/2'], 'the register lists exactly the accepted version tuples');
}

// --- schema/validator agreement: enums in the JSON match DIMENSIONS ----------
{
  // DIMENSIONS is the v2 status model now, so the v2 schema is its live mirror.
  const schemaV2 = JSON.parse(readFileSync(new URL('./schemas/status.v2.schema.json', import.meta.url)));
  assert.equal(schemaV2.properties.schemaVersion.const, 2, 'the v2 status schema is version 2');
  for (const dim of Object.keys(DIMENSIONS)) {
    assert.deepEqual(schemaV2.properties[dim].enum, DIMENSIONS[dim], `v2 schema and code agree on ${dim}`);
  }
  // v1 is a FROZEN published contract: its shared dimensions still match, but
  // its audit enum stays the pre-declared six values — declared_* is v2-only.
  const schema = JSON.parse(readFileSync(new URL('./schemas/status.v1.schema.json', import.meta.url)));
  for (const dim of ['execution', 'verification', 'publication']) {
    assert.deepEqual(schema.properties[dim].enum, DIMENSIONS[dim], `v1 schema and code agree on ${dim}`);
  }
  assert.deepEqual(schema.properties.audit.enum, ['not_run', 'independent_clean', 'independent_findings', 'advisory_clean', 'advisory_findings', 'infra_failed'],
    'v1 audit stays frozen at the six pre-declared values');
  const packV2Schema = JSON.parse(readFileSync(new URL('./schemas/evidence-pack.v2.schema.json', import.meta.url)));
  assert.equal(packV2Schema.properties.schemaVersion.const, 2, 'coverage extends the protocol through evidence-pack v2');
  assert.ok(packV2Schema.properties.artifact.required.includes('contract_coverage'), 'v2 schema requires an explicit coverage state');
  const experimentSchema = JSON.parse(readFileSync(new URL('./schemas/experiment.v1.schema.json', import.meta.url)));
  assert.equal(experimentSchema.properties.mode.const, 'audit_only_replay', 'experiment v1 starts with audit-only replay');
  assert.ok(experimentSchema.properties.outcome.required.includes('failure'), 'failed arms are first-class records');
  const experimentV2Schema = JSON.parse(readFileSync(new URL('./schemas/experiment.v2.schema.json', import.meta.url)));
  assert.equal(experimentV2Schema.properties.mode.const, 'parallel_execution', 'parallel execution extends experiments through v2');
  assert.equal(experimentV2Schema.properties.manifest.properties.arms.minItems, 2, 'a parallel experiment requires at least two arms');
}

// --- envelope 3 binds its interior blocks to pairing v2 + status v2 exactly ---
// The RFC §10.8.1 rule: envelope schemaVersion 3 DETERMINES pairing v2 and
// statuses v2. The v3 schema binds each interior with a $ref to the published
// v2 file's $id, so the envelope no longer accepts an arbitrary object there.
// This zero-dep resolver walks the actual published files (never a copy), so a
// drift between the envelope's binding and the v2 contract fails the test.
{
  const schemaDir = new URL('./schemas/', import.meta.url);
  const load = (file) => JSON.parse(readFileSync(new URL(file, schemaDir)));
  const registry = Object.create(null);
  for (const file of ['evidence-pack.v3.schema.json', 'pairing-manifest.v2.schema.json', 'status.v2.schema.json']) {
    const doc = load(file);
    registry[doc.$id] = doc;
  }
  const v3 = registry['https://camus.sh/schemas/evidence-pack/v3'];
  // The binding is a $ref to the published v2 $ids, not a bare `type: object`.
  assert.equal(v3.properties.pairing.$ref, 'https://camus.sh/schemas/pairing-manifest/v2', 'pairing binds pairing-manifest/v2');
  assert.equal(v3.properties.statuses.$ref, 'https://camus.sh/schemas/status/v2', 'statuses binds status/v2');
  assert.ok(!('type' in v3.properties.pairing) && !('type' in v3.properties.statuses), 'the interiors are no longer arbitrary objects');

  // A minimal JSON Schema evaluator over exactly the keywords these files use
  // (type/const/enum/pattern/required/properties/additionalProperties/items/
  // $ref, both #/$defs pointers and cross-file $id references). It resolves the
  // envelope's $ref into the published v2 file, so "does v3 accept this
  // interior?" is answered by the real contract.
  const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const typeOk = (t, v) => ({
    object: v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray(v),
    string: typeof v === 'string',
    integer: Number.isInteger(v),
    number: typeof v === 'number',
    boolean: typeof v === 'boolean',
    null: v === null,
  })[t] ?? false;
  const resolveRef = (ref, root) => {
    if (ref.startsWith('#')) {
      let node = root;
      for (const part of ref.slice(1).split('/').filter(Boolean)) node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      return { schema: node, root };
    }
    const doc = registry[ref];
    if (!doc) throw new Error(`unresolved $ref: ${ref}`);
    return { schema: doc, root: doc };
  };
  const validate = (schema, v, root, path = '') => {
    if (schema.$ref) {
      const r = resolveRef(schema.$ref, root);
      const e = validate(r.schema, v, r.root, path);
      if (e) return e;
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeOk(t, v))) return `${path || '/'}: expected ${types.join('|')}`;
    }
    if ('const' in schema && !jsonEq(v, schema.const)) return `${path}: const mismatch`;
    if (schema.enum && !schema.enum.some((e) => jsonEq(e, v))) return `${path}: not in enum`;
    if (schema.pattern && (typeof v !== 'string' || !new RegExp(schema.pattern).test(v))) return `${path}: pattern`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of schema.required ?? []) if (!(k in v)) return `${path}/${k}: required`;
      const props = schema.properties ?? {};
      for (const [k, val] of Object.entries(v)) {
        if (props[k]) { const e = validate(props[k], val, root, `${path}/${k}`); if (e) return e; }
        else if (schema.additionalProperties === false) return `${path}/${k}: additional property`;
      }
    }
    if (schema.items && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { const e = validate(schema.items, v[i], root, `${path}/${i}`); if (e) return e; }
    }
    return null;
  };
  // The named entry points the tests exercise: the envelope's own property
  // schemas, evaluated with the envelope as the resolution root.
  const acceptsPairing = (v) => validate(v3.properties.pairing, v, v3) === null;
  const acceptsStatus = (v) => validate(v3.properties.statuses, v, v3) === null;

  const seat = (provider, org, family) => ({
    requested: `${provider}:m`,
    resolved: `${provider}:m`,
    actual: `${provider}:m`,
    reported: null,
    actual_evidence: 'observed_api_response',
    executor_kind: 'http_client',
    training_org: org,
    model_family: family,
    lineage: { source: 'registry', derived_from: null },
    inference_operator: provider,
    transport: 'direct_https',
    connection: null,
    origin_confidence: 'verified_operator',
    qualification: { fingerprint: `builtin1:${'a'.repeat(64)}`, gate_scope: 'full', contract_version: null },
  });
  const validPairingV2 = {
    schemaVersion: 2,
    executor: seat('anthropic', 'anthropic', 'claude'),
    auditor: seat('openai', 'openai', 'gpt'),
    independence: 'cross_vendor',
    shared_gateway: null,
    review_scope: 'full',
  };
  const validStatusV2 = { schemaVersion: 2, execution: 'completed', verification: 'passed', audit: 'declared_clean', publication: 'not_published' };
  // Sanity: the fixtures are real v2 instances the shipped v1 validators reject,
  // so acceptance below is the envelope binding to v2, not a v1 coincidence.
  assert.ok(!validatePairingManifest(validPairingV2).ok, 'the v2 pairing fixture is not a v1 pairing');
  assert.ok(!validateStatus(validStatusV2).ok, 'the v2 status fixture is not a v1 status');

  // Accept: a well-formed v2 interior.
  assert.ok(acceptsPairing(validPairingV2), 'envelope 3 accepts a valid pairing v2 interior');
  assert.ok(acceptsStatus(validStatusV2), 'envelope 3 accepts a valid status v2 interior');

  // Reject: empty object — the old `type: object` accepted this; v2 does not.
  assert.ok(!acceptsPairing({}), 'envelope 3 rejects an empty pairing interior');
  assert.ok(!acceptsStatus({}), 'envelope 3 rejects an empty status interior');

  // Reject: a v1 interior (schemaVersion 1 and the v1 field set) — the envelope
  // determines v2 exactly, so a down-version block cannot smuggle in.
  const v1Pairing = {
    schemaVersion: 1,
    executor: { requested: 'anthropic:balanced', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    auditor: { requested: 'openai:balanced', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4' },
    independence: 'cross_vendor',
  };
  const v1Status = { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' };
  assert.ok(!acceptsPairing(v1Pairing), 'envelope 3 rejects a v1 pairing interior');
  assert.ok(!acceptsStatus(v1Status), 'envelope 3 rejects a v1 status interior');

  // Reject: v2-shaped but invalid — wrong enum, missing seat field, bad
  // fingerprint pattern, an unknown extra field, a non-v2 audit value.
  assert.ok(!acceptsPairing({ ...validPairingV2, independence: 'totally_independent' }), 'a bogus independence value is refused');
  const { training_org, ...seatMissingOrg } = validPairingV2.executor;
  assert.ok(!acceptsPairing({ ...validPairingV2, executor: seatMissingOrg }), 'a seat missing a required v2 field is refused');
  assert.ok(!acceptsPairing({
    ...validPairingV2,
    executor: { ...validPairingV2.executor, qualification: { fingerprint: 'qual2:zzz', gate_scope: 'full', contract_version: null } },
  }), 'a qualification fingerprint off the qual1|builtin1 pattern is refused');
  assert.ok(!acceptsPairing({ ...validPairingV2, surprise: true }), 'an unknown pairing field is refused');
  assert.ok(!acceptsStatus({ ...validStatusV2, audit: 'not_a_real_dimension' }), 'a non-v2 audit value is refused');
  assert.ok(!acceptsStatus({ ...validStatusV2, headline: 'verified' }), 'a persisted headline in the status interior is refused');

  // The resolver actually reached the published v2 files, not an inline copy.
  assert.equal(registry['https://camus.sh/schemas/pairing-manifest/v2'].properties.schemaVersion.const, 2, 'pairing v2 file resolved');
  assert.equal(registry['https://camus.sh/schemas/status/v2'].properties.schemaVersion.const, 2, 'status v2 file resolved');
}

// --- canonicalization + artifact identity ------------------------------------
{
  assert.equal(canonicalString({ b: 1, a: 2 }), canonicalString({ a: 2, b: 1 }), 'key order is not meaning');
  assert.notEqual(canonicalString({ a: [1, 2] }), canonicalString({ a: [2, 1] }), 'array order IS meaning');
  assert.equal(canonicalString({ s: 'café' }), canonicalString({ s: 'café' }), 'NFC-equivalent strings hash the same');
  assert.equal(canonicalString({ s: 'a\r\nb' }), canonicalString({ s: 'a\nb' }), 'CRLF normalizes to LF');
  assert.equal(canonicalString({ a: 1, gone: undefined }), canonicalString({ a: 1 }), 'undefined object values are absence');
  assert.throws(() => canonicalString({ a: [1, undefined] }), TypeError, 'array holes are ambiguity, not absence');
  assert.throws(() => canonicalString({ n: Infinity }), TypeError, 'non-finite numbers refused');
  assert.equal(canonicalize(-0), 0, '-0 canonicalizes to 0');

}

// --- experiment identity + failed-arm honesty --------------------------------
{
  const sourceArtifact = 'sha256:' + 'a'.repeat(64);
  const sourceReceipt = 'sha256:' + 'b'.repeat(64);
  const draft = {
    schemaVersion: 1,
    mode: 'audit_only_replay',
    created_at: 10,
    source: { run_id: 'run-1', artifact_id: sourceArtifact, receipt_id: sourceReceipt },
    manifest: {
      arm_id: 'audit-1',
      knowledge_snapshot_id: null,
      knowledge_privacy: 'none',
      catalog: { resolved_at: 10, reviewer_source: 'codex_cache', reviewer_models: ['gpt-5.4', 'gpt-5.6-sol'] },
      reviewer: { requested: 'openai:gpt-5.4', resolved: 'openai:gpt-5.4' },
      effort: { requested: 'high', semantics: 'requested_only' },
      fallback_policy: 'none',
    },
    outcome: {
      status: 'running',
      artifact_id: sourceArtifact,
      receipt_id: null,
      auditor_actual: null,
      effort_actual: null,
      judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
      usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
      failure: null,
      confounded: false,
    },
  };
  const planned = sealExperiment(draft);
  assert.equal(validateExperimentRecord(planned).ok, true, 'running experiment record validates');
  assert.ok(experimentMatches(planned), 'experiment id matches the frozen manifest');

  const completed = {
    ...planned,
    outcome: {
      ...planned.outcome,
      status: 'completed',
      receipt_id: 'sha256:' + 'c'.repeat(64),
      auditor_actual: 'openai:gpt-5.4',
      effort_actual: 'high',
      judge_overlap: { arm_provider: 'anthropic', judge_provider: 'openai', same_vendor: false, same_family: false },
      usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 240, duration_ms: 9000 },
    },
  };
  assert.equal(validateExperimentRecord(completed).ok, true, 'completed arm preserves the planned experiment identity');
  assert.equal(computeExperimentId(completed), planned.experiment_id, 'outcome never rewrites which experiment was planned');

  const differentEffort = { ...planned, manifest: { ...planned.manifest, effort: { requested: 'low', semantics: 'requested_only' } } };
  assert.notEqual(computeExperimentId(differentEffort), planned.experiment_id, 'a different requested effort is a different experiment');
  assert.equal(validateExperimentRecord({ ...completed, outcome: { ...completed.outcome, artifact_id: 'sha256:' + 'd'.repeat(64) } }).ok, false, 'audit-only replay cannot change artifact identity');

  const failed = {
    ...planned,
    outcome: {
      ...planned.outcome,
      status: 'infra_failed',
      failure: { stage: 'audit', code: 'model_unavailable', detail: 'resolved reviewer disappeared' },
    },
  };
  assert.equal(validateExperimentRecord(failed).ok, true, 'failed arms remain valid experiment data');
  assert.equal(validateExperimentRecord({ ...planned, surprise: true }).ok, false, 'unknown experiment fields fail loudly');

  const snapshot = 'sha256:' + 'd'.repeat(64);
  const parallelDraft = {
    schemaVersion: 2,
    mode: 'parallel_execution',
    created_at: 20,
    goal: 'Choose the strongest launch strategy.',
    acceptance_contract: 'Every recommendation names its evidence and tradeoff.',
    knowledge: {
      snapshot_id: snapshot,
      privacy: 'internal',
      mode: 'hivemind_claude',
      query: 'launch strategy evidence',
      item_count: 3,
      retriever: { requested: 'anthropic:sonnet', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    },
    manifest: {
      task: { lane: 'research_memo', depth: 'quick' },
      catalog: {
        resolved_at: 20,
        maker_source: 'studio_catalog',
        maker_models: ['sonnet', 'opus'],
        reviewer_source: 'codex_cache',
        reviewer_models: ['gpt-5.4'],
      },
      reviewer: { requested: 'openai:gpt-5.4', resolved: 'openai:gpt-5.4' },
      reviewer_effort: { requested: 'high', semantics: 'requested_only' },
      round_cap: 3,
      fallback_policy: 'none',
      arms: ['sonnet', 'opus'].map((model, index) => ({
        arm_id: `arm-${index + 1}`,
        executor: { requested: `anthropic:${model}`, resolved: `anthropic:${model}` },
        orchestration: { requested: 'provider_native', semantics: 'opaque' },
        effort: { requested: null, semantics: 'not_configured' },
      })),
    },
    outcome: {
      status: 'running',
      arms: ['arm-1', 'arm-2'].map((arm_id) => ({
        arm_id,
        run_id: null,
        status: 'pending',
        artifact_id: null,
        receipt_id: null,
        executor_actual: null,
        auditor_actual: null,
        quality_floor: 'unknown',
        usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, duration_ms: null },
        judge_overlap: { arm_provider: 'anthropic', judge_provider: null, same_vendor: null, same_family: null },
        failure: null,
        confounded: false,
      })),
    },
  };
  const parallel = sealExperiment(parallelDraft);
  assert.equal(validateExperimentRecord(parallel).ok, true, JSON.stringify(validateExperimentRecord(parallel)));
  assert.ok(experimentMatches(parallel), 'parallel experiment id binds its frozen inputs and arms');
  const terminalParallel = {
    ...parallel,
    outcome: {
      status: 'completed',
      arms: parallel.outcome.arms.map((arm, index) => index === 0
        ? {
            ...arm,
            run_id: 'run-a',
            status: 'completed',
            artifact_id: 'sha256:' + 'e'.repeat(64),
            receipt_id: 'sha256:' + 'f'.repeat(64),
            executor_actual: 'anthropic:sonnet',
            auditor_actual: 'openai:gpt-5.4',
            quality_floor: 'passed',
            judge_overlap: { arm_provider: 'anthropic', judge_provider: 'openai', same_vendor: false, same_family: false },
          }
        : {
            ...arm,
            run_id: 'run-b',
            status: 'infra_failed',
            failure: { stage: 'make', code: 'model_unavailable', detail: 'resolved model disappeared' },
          }),
    },
  };
  assert.equal(validateExperimentRecord(terminalParallel).ok, true, 'parallel outcomes keep successful and failed arms together');
  assert.equal(computeExperimentId(terminalParallel), parallel.experiment_id, 'parallel outcomes never rewrite the planned experiment');
  assert.equal(validateExperimentRecord({ ...terminalParallel, manifest: { ...terminalParallel.manifest, arms: [terminalParallel.manifest.arms[0]] } }).ok, false, 'parallel is never silently collapsed to one surviving arm');
  assert.equal(validateExperimentRecord({ ...terminalParallel, outcome: { ...terminalParallel.outcome, arms: [terminalParallel.outcome.arms[0]] } }).ok, false, 'dropping a failed arm is rejected');
}

// --- the two identities: artifact vs receipt -----------------------------------
{
  const pairing = {
    schemaVersion: 1,
    executor: { requested: 'anthropic:balanced', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    auditor: { requested: 'openai:balanced', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4' },
    independence: 'cross_vendor',
  };
  const basePack = {
    schemaVersion: 1,
    goal: 'memo on community vs paid growth',
    acceptance_contract: 'every stat cited to a live URL; no promissory phrasing',
    artifact: {
      kind: 'research',
      deliverable_hash: 'sha256:' + 'a'.repeat(64),
      claims: [{ claim: 'retention differs by cohort origin', marker: '[1]', url: 'https://example.com/r', evidence_hash: null, retrieved_at: 1, decision: 'supported' }],
    },
    verification: { checks: [{ id: 'links', status: 'pass' }] },
    pairing,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    human_decisions: [{ schemaVersion: 1, kind: 'decision', question: 'audience?', answer: 'web3 marketers', at: 1 }],
    economics: [],
    created_at: 1,
  };
  const sealed = seal(basePack);
  assert.match(sealed.artifact_id, /^sha256:[0-9a-f]{64}$/);
  assert.match(sealed.receipt_id, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(sealed.artifact_id, sealed.receipt_id);
  assert.ok(validateEvidencePack(sealed).ok, 'a sealed research pack with a claim ledger validates');
  assert.ok(!validateEvidencePack({ ...sealed, artifact: { ...sealed.artifact, claims: [{ ...sealed.artifact.claims[0], decision: 'unsupported' }] } }).ok,
    'editing a judgment without resealing is a receipt-id mismatch');
  assert.ok(!validateEvidencePack({ ...sealed, artifact: { ...sealed.artifact, claims: [{ ...sealed.artifact.claims[0], url: 'https://example.com/tampered' }] } }).ok,
    'editing claim meaning without resealing is an artifact-id mismatch');
  const duplicateClaims = [{ ...sealed.artifact.claims[0] }, { ...sealed.artifact.claims[0], claim: 'a second claim' }];
  assert.ok(!validateEvidencePack({ ...sealed, artifact: { ...sealed.artifact, claims: duplicateClaims } }).ok,
    'duplicate claim markers are structurally ambiguous and refused');

  // Judgment changes mint a NEW RECEIPT over the SAME ARTIFACT.
  for (const mutate of [
    (p) => ({ ...p, statuses: { ...p.statuses, audit: 'independent_findings' } }),
    (p) => ({ ...p, human_decisions: [...p.human_decisions, { schemaVersion: 1, kind: 'adjudication', question: 'finding real?', answer: 'confirmed', at: 2 }] }),
    (p) => ({ ...p, economics: [{ schemaVersion: 1, role: 'auditor', requested: 'openai:balanced', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4', billing_mode: 'subscription', estimated_cost_usd: 1 }] }),
    (p) => ({ ...p, pairing: { ...p.pairing, auditor: { ...p.pairing.auditor, actual: 'openai:gpt-5.6-terra' } } }),
    (p) => ({ ...p, artifact: { ...p.artifact, claims: [{ ...p.artifact.claims[0], decision: 'unsupported' }] } }),
  ]) {
    const changed = mutate(basePack);
    assert.equal(computeArtifactId(changed), sealed.artifact_id, 'judgment never pretends the artifact changed');
    const withId = { ...changed, artifact_id: sealed.artifact_id };
    assert.notEqual(computeReceiptId(withId), sealed.receipt_id, 'judgment always mints a new receipt');
  }

  // Meaning changes expire the artifact (and therefore every receipt on it).
  for (const mutate of [
    (p) => ({ ...p, goal: 'a different goal' }),
    (p) => ({ ...p, acceptance_contract: 'weaker contract' }),
    (p) => ({ ...p, artifact: { ...p.artifact, deliverable_hash: 'sha256:' + 'b'.repeat(64) } }),
    (p) => ({ ...p, artifact: { ...p.artifact, claims: [{ ...p.artifact.claims[0], url: 'https://example.com/other' }] } }),
  ]) {
    assert.notEqual(computeArtifactId(mutate(basePack)), sealed.artifact_id, 'meaning change expires the artifact');
  }

  // Unknown fields fail loudly — nothing is silently unhashed.
  assert.throws(() => computeArtifactId({ ...basePack, novel_field: 1 }), /unknown field/, 'unknown top-level field refuses to hash');
  assert.throws(() => computeArtifactId({ ...basePack, artifact: { ...basePack.artifact, surprise: true } }), /unknown field/, 'unknown artifact field refuses to hash');
  assert.throws(() => computeReceiptId(basePack), /artifact_id must be set/, 'a receipt cannot exist before its artifact');
  assert.equal(artifactProjection(basePack).projectionVersion, 1, 'projections are versioned');

  assert.ok(artifactMatches(sealed, sealed.artifact_id));
  assert.ok(receiptMatches(sealed, sealed.receipt_id));
  assert.ok(!artifactMatches({ ...sealed, goal: 'g2' }, sealed.artifact_id), 'expiry check works');

  // v2 adds deterministic contract criteria to artifact meaning while their
  // auditor decisions remain receipt-side judgment. v1 stays byte-semantically
  // on projection version 1; the protocol is extended, never edited in place.
  const v2Base = {
    ...basePack,
    schemaVersion: 2,
    artifact: {
      ...basePack.artifact,
      contract_coverage: [{ id: 'C1', text: 'every stat cited to a live URL', decision: 'met' }],
    },
  };
  const sealedV2 = seal(v2Base);
  assert.equal(artifactProjection(v2Base).projectionVersion, 2, 'v2 uses the coverage-aware artifact projection');
  assert.ok(validateEvidencePack(sealedV2).ok, JSON.stringify(validateEvidencePack(sealedV2)));
  const changedCoverageDecision = {
    ...v2Base,
    statuses: { ...v2Base.statuses, audit: 'independent_findings' },
    artifact: { ...v2Base.artifact, contract_coverage: [{ ...v2Base.artifact.contract_coverage[0], decision: 'unmet' }] },
  };
  const findingsBaseline = { ...v2Base, statuses: { ...v2Base.statuses, audit: 'independent_findings' } };
  assert.equal(computeArtifactId(changedCoverageDecision), computeArtifactId(findingsBaseline), 'coverage judgment stays out of artifact identity');
  const findingsBaselineId = computeArtifactId(findingsBaseline);
  assert.notEqual(
    computeReceiptId({ ...changedCoverageDecision, artifact_id: findingsBaselineId }),
    computeReceiptId({ ...findingsBaseline, artifact_id: findingsBaselineId }),
    'coverage judgment enters receipt identity',
  );
  assert.notEqual(
    computeArtifactId({ ...v2Base, artifact: { ...v2Base.artifact, contract_coverage: [{ ...v2Base.artifact.contract_coverage[0], text: 'a different criterion' }] } }),
    sealedV2.artifact_id,
    'changing the extracted criterion expires the artifact',
  );
  const unclearClean = seal({
    ...v2Base,
    artifact: { ...v2Base.artifact, contract_coverage: [{ ...v2Base.artifact.contract_coverage[0], decision: 'unclear' }] },
  });
  assert.ok(!validateEvidencePack(unclearClean).ok, 'clean standing conflicts with unclear coverage');
  assert.throws(
    () => seal({ ...basePack, artifact: { ...basePack.artifact, contract_coverage: [] } }),
    /unknown field/,
    'v1 refuses the v2 field rather than silently changing its hash contract',
  );
}

// --- §10.8.1/§10.8.5: envelope 3 is a READER; envelopes 1 & 2 stay byte-frozen -
// These IDs were sealed with the shipped canonical library BEFORE v3 reader
// support landed and are pinned as literals on purpose: a regression that shifts
// any v1/v2 canonical byte moves a hash and fails here, instead of silently
// re-deriving a new "golden" value. Never regenerate these in place.
{
  const GOLDEN_V1_ARTIFACT_ID = 'sha256:acd203be0535fc503b3b8f95b9174715a8dbdc773fa69354613c9c22ec8fec66';
  const GOLDEN_V1_RECEIPT_ID = 'sha256:106325fc9e9ecadec99d63191cff0b5fada26efe5b90a90cad9534376bff46a1';
  const GOLDEN_V2_ARTIFACT_ID = 'sha256:913443ec0dcede1d4bc9ff13b10bd64bdceecb0cc443772917f07db045b84255';
  const GOLDEN_V2_RECEIPT_ID = 'sha256:338324d5bbab75eea6ab06ba6616e93d1137d673730939969a39f66580bc2f56';

  // The golden envelope-1 fixture — reconstructed byte-for-byte from the shape
  // the "two identities" suite above seals.
  const goldenPairing = {
    schemaVersion: 1,
    executor: { requested: 'anthropic:balanced', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    auditor: { requested: 'openai:balanced', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4' },
    independence: 'cross_vendor',
  };
  const envelope1 = {
    schemaVersion: 1,
    goal: 'memo on community vs paid growth',
    acceptance_contract: 'every stat cited to a live URL; no promissory phrasing',
    artifact: {
      kind: 'research',
      deliverable_hash: 'sha256:' + 'a'.repeat(64),
      claims: [{ claim: 'retention differs by cohort origin', marker: '[1]', url: 'https://example.com/r', evidence_hash: null, retrieved_at: 1, decision: 'supported' }],
    },
    verification: { checks: [{ id: 'links', status: 'pass' }] },
    pairing: goldenPairing,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    human_decisions: [{ schemaVersion: 1, kind: 'decision', question: 'audience?', answer: 'web3 marketers', at: 1 }],
    economics: [],
    created_at: 1,
  };
  // The golden envelope-2 fixture: same artifact content plus v2's extracted
  // contract coverage.
  const envelope2 = {
    ...envelope1,
    schemaVersion: 2,
    artifact: { ...envelope1.artifact, contract_coverage: [{ id: 'C1', text: 'every stat cited to a live URL', decision: 'met' }] },
  };

  // Frozen literals re-derive exactly — v1 and v2 canonical forms are untouched
  // by v3 reader support.
  const sealed1 = seal(envelope1);
  const sealed2 = seal(envelope2);
  assert.equal(sealed1.artifact_id, GOLDEN_V1_ARTIFACT_ID, 'v1 artifact_id is byte-frozen');
  assert.equal(sealed1.receipt_id, GOLDEN_V1_RECEIPT_ID, 'v1 receipt_id is byte-frozen');
  assert.equal(sealed2.artifact_id, GOLDEN_V2_ARTIFACT_ID, 'v2 artifact_id is byte-frozen');
  assert.equal(sealed2.receipt_id, GOLDEN_V2_RECEIPT_ID, 'v2 receipt_id is byte-frozen');
  // computeArtifactId/computeReceiptId re-derive the same literals directly.
  assert.equal(computeArtifactId(envelope1), GOLDEN_V1_ARTIFACT_ID, 'v1 computeArtifactId re-derives the frozen literal');
  assert.equal(computeReceiptId({ ...envelope1, artifact_id: GOLDEN_V1_ARTIFACT_ID }), GOLDEN_V1_RECEIPT_ID, 'v1 computeReceiptId re-derives the frozen literal');
  assert.equal(computeArtifactId(envelope2), GOLDEN_V2_ARTIFACT_ID, 'v2 computeArtifactId re-derives the frozen literal');
  assert.equal(computeReceiptId({ ...envelope2, artifact_id: GOLDEN_V2_ARTIFACT_ID }), GOLDEN_V2_RECEIPT_ID, 'v2 computeReceiptId re-derives the frozen literal');
  // Both golden fixtures still validate under the shipped validator.
  assert.ok(validateEvidencePack(sealed1).ok, JSON.stringify(validateEvidencePack(sealed1)));
  assert.ok(validateEvidencePack(sealed2).ok, JSON.stringify(validateEvidencePack(sealed2)));

  // Pin the v2 canonical PRINTED field order: the exact serialized bytes, so a
  // key-order or projection-shape drift fails on the string, not only the hash.
  assert.equal(
    canonicalString(artifactProjection(envelope2)),
    '{"acceptance_contract":"every stat cited to a live URL; no promissory phrasing","artifact":{"claims":[{"claim":"retention differs by cohort origin","evidence_hash":null,"marker":"[1]","retrieved_at":1,"url":"https://example.com/r"}],"contract_coverage":[{"id":"C1","text":"every stat cited to a live URL"}],"deliverable_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"research"},"goal":"memo on community vs paid growth","projectionVersion":2,"schemaVersion":2}',
    'v2 artifact projection canonical field order is pinned',
  );
  assert.equal(
    canonicalString(receiptProjection(sealed2)),
    '{"artifact_id":"sha256:913443ec0dcede1d4bc9ff13b10bd64bdceecb0cc443772917f07db045b84255","claim_decisions":[{"decision":"supported","marker":"[1]"}],"coverage_decisions":[{"decision":"met","id":"C1"}],"economics":[],"human_decisions":[{"answer":"web3 marketers","at":1,"kind":"decision","question":"audience?","schemaVersion":1}],"pairing":{"auditor":{"actual":"openai:gpt-5.4","requested":"openai:balanced","resolved":"openai:gpt-5.4"},"executor":{"actual":"anthropic:sonnet","requested":"anthropic:balanced","resolved":"anthropic:sonnet"},"independence":"cross_vendor","schemaVersion":1},"projectionVersion":2,"schemaVersion":2,"statuses":{"audit":"independent_clean","execution":"completed","publication":"not_published","schemaVersion":1,"verification":"passed"},"verification":{"checks":[{"id":"links","status":"pass"}]}}',
    'v2 receipt projection canonical field order is pinned',
  );

  // Envelope 3 is a READER-only version and a GENUINE 3/2/2 pack: the published
  // envelope-3 contract determines pairing-manifest v2 and status v2 interiors
  // (RFC §10.8.1). Its artifact content is BYTE-IDENTICAL to envelope2 — same
  // goal, acceptance_contract, and artifact block — so the artifact_id
  // divergence asserted below is purely the envelope version, never a content
  // edit. The v2 pairing/status only ever live receipt-side.
  const seatV2 = (provider, org, family) => ({
    requested: `${provider}:balanced`,
    resolved: `${provider}:m`,
    actual: `${provider}:m`,
    reported: null,
    actual_evidence: 'observed_api_response',
    executor_kind: 'http_client',
    training_org: org,
    model_family: family,
    lineage: { source: 'registry', derived_from: null },
    inference_operator: provider,
    transport: 'direct_https',
    connection: null,
    origin_confidence: 'verified_operator',
    qualification: { fingerprint: `builtin1:${'a'.repeat(64)}`, gate_scope: 'full', contract_version: null },
  });
  const envelope3 = {
    ...envelope2,
    schemaVersion: 3,
    // pairing-manifest v2: both seats carry the sealed identity fields v1 never
    // had (training_org, model_family, lineage, transport, origin_confidence,
    // qualification, …) plus the v2-only shared_gateway/review_scope.
    pairing: {
      schemaVersion: 2,
      executor: seatV2('anthropic', 'anthropic', 'claude'),
      auditor: seatV2('openai', 'openai', 'gpt'),
      independence: 'cross_vendor',
      shared_gateway: null,
      review_scope: 'full',
    },
    // status v2: the declared_clean audit value is v2-only (v1 stops at the six
    // pre-declared values).
    statuses: { schemaVersion: 2, execution: 'completed', verification: 'passed', audit: 'declared_clean', publication: 'not_published' },
  };

  // Prove the fixture is 3/2/2, not 3/1/1: the envelope is v3 while its interior
  // pairing/status blocks are genuine v2 instances the SHIPPED v1 validators
  // reject — so these are real v2 interiors, not v1 blocks wearing a v2 label.
  assert.equal(envelope3.schemaVersion, 3, 'envelope 3 is version 3');
  assert.equal(envelope3.pairing.schemaVersion, 2, 'envelope 3 carries a pairing-manifest v2 interior');
  assert.equal(envelope3.statuses.schemaVersion, 2, 'envelope 3 carries a status v2 interior');
  assert.ok(!validatePairingManifest(envelope3.pairing).ok, 'the v3 pairing interior is a real v2 (the shipped v1 validator refuses it)');
  assert.ok(!validateStatus(envelope3.statuses).ok, 'the v3 status interior is a real v2 (declared_clean is v2-only)');
  assert.equal(envelope3.statuses.audit, 'declared_clean', 'the v2-only declared_clean audit value is present');
  assert.equal(envelope3.pairing.review_scope, 'full', 'the v2-only review_scope field is present');
  assert.ok('training_org' in envelope3.pairing.executor && 'qualification' in envelope3.pairing.executor, 'the sealed seat identity fields are present');

  // Dual-read: v3 reuses the v2 sub-projections (projectionVersion 2 on both
  // sides, the v2 coverage-aware artifact and coverage_decisions receipt branch).
  const v3ArtifactId = computeArtifactId(envelope3);
  const v3Receipt = receiptProjection({ ...envelope3, artifact_id: v3ArtifactId });
  assert.equal(artifactProjection(envelope3).projectionVersion, 2, 'v3 reads through the v2 artifact projection');
  assert.equal(artifactProjection(envelope3).schemaVersion, 3, 'the envelope version stays in the projection — not normalized away');
  assert.equal(v3Receipt.projectionVersion, 2, 'v3 reads through the v2 receipt projection');
  assert.ok('coverage_decisions' in v3Receipt, 'v3 carries the v2 coverage_decisions receipt behavior');
  // receiptProjection copied the WHOLE v2 pairing/status blocks opaquely — the
  // v2-only nested fields ride into receipt_id by that copy, no per-field change.
  assert.equal(v3Receipt.pairing.schemaVersion, 2, 'the receipt projection carried the v2 pairing interior whole');
  assert.equal(v3Receipt.statuses.schemaVersion, 2, 'the receipt projection carried the v2 status interior whole');
  assert.equal(v3Receipt.pairing.executor.training_org, 'anthropic', 'a v2-only nested seat field is present in the receipt projection');

  // The artifact projection genuinely ignores the whole v2 pairing/status: an
  // envelope3 with the v1 blocks restored has the SAME artifact_id, so the
  // divergence from envelope2 below is the envelope version alone.
  assert.equal(
    computeArtifactId({ ...envelope3, pairing: goldenPairing, statuses: envelope1.statuses }),
    v3ArtifactId,
    'the v2 pairing/status blocks never touch artifact identity',
  );

  // A v2-ONLY nested RECEIPT field changes receipt_id WITHOUT changing
  // artifact_id — the opaque pairing/status copy hashes these fields the moment
  // they arrive, and they are absent from the artifact side entirely.
  const v3ReceiptId = computeReceiptId({ ...envelope3, artifact_id: v3ArtifactId });
  for (const [label, mutate] of [
    ['a nested sealed-seat field (training_org)', (e) => ({ ...e, pairing: { ...e.pairing, executor: { ...e.pairing.executor, training_org: 'unknown' } } })],
    ['a nested qualification fingerprint', (e) => ({ ...e, pairing: { ...e.pairing, executor: { ...e.pairing.executor, qualification: { ...e.pairing.executor.qualification, fingerprint: `builtin1:${'b'.repeat(64)}` } } } })],
    ['the v2-only review_scope', (e) => ({ ...e, pairing: { ...e.pairing, review_scope: 'light' } })],
    ['the v2-only declared audit value', (e) => ({ ...e, statuses: { ...e.statuses, audit: 'declared_findings' } })],
  ]) {
    const mutated = mutate(envelope3);
    assert.equal(computeArtifactId(mutated), v3ArtifactId, `${label}: artifact_id is unchanged — a v2 receipt field is not artifact meaning`);
    assert.notEqual(computeReceiptId({ ...mutated, artifact_id: v3ArtifactId }), v3ReceiptId, `${label}: receipt_id changes — the v2-only nested field is hashed opaquely (RFC §10.8.1)`);
  }

  // v3 is not validatable yet (no producer emits it; validate.mjs still refuses
  // it), so the cross-version divergence is asserted with computeArtifactId
  // DIRECTLY rather than through a sealed-and-validated pack.
  assert.ok(!validateEvidencePack(seal(envelope3)).ok, 'envelope 3 is a reader only — the shipped validator still refuses it');
  assert.notEqual(
    computeArtifactId(envelope2),
    v3ArtifactId,
    'identical artifact content under envelope 2 vs 3 seals DIFFERENT artifact_ids — envelope version is never normalized (RFC §10.8.1)',
  );
  // The frozen v1 guarantee, stated explicitly: teaching the reader v3 did not
  // move the byte-frozen v1 identity by even one hash.
  assert.equal(computeArtifactId(envelope1), GOLDEN_V1_ARTIFACT_ID, 'dual-read support leaves the frozen v1 artifact identity unchanged');
  assert.equal(computeReceiptId({ ...envelope1, artifact_id: GOLDEN_V1_ARTIFACT_ID }), GOLDEN_V1_RECEIPT_ID, 'dual-read support leaves the frozen v1 receipt identity unchanged');
}

// --- redaction ----------------------------------------------------------------
{
  // Secret fixtures are assembled from fragments so no scannable secret literal
  // ever lives in this file — a realistic Stripe key here once tripped GitHub
  // push protection. The runtime strings still match the redaction patterns.
  const skKey = 'sk-' + 'ABCDEFGHIJKLMNOP0123';
  const rkKey = 'rk_' + 'live_' + 'EXAMPLENOTAREALKEY000000';
  assert.ok(scrubSecrets(`key ${skKey} here`).includes('[REDACTED:api-key]'));
  assert.ok(scrubSecrets(`${rkKey} in a finding`).includes('[REDACTED:stripe-key]'));
  assert.ok(scrubSecrets('hm_k_abc12345 in a finding').includes('[REDACTED:hivemind-key]'));
  assert.equal(scrubPaths('/Users/someone/repo/file.ts:12'), '~/repo/file.ts:12');
  const f = redactFinding({ title: 'leak', body: 'token = "abcd1234efgh5678ijkl"', diff: '--- secret hunk' });
  assert.ok(f.body.includes('[REDACTED:credential-assignment]'), 'credential assignment scrubbed');
  assert.ok(!('diff' in f), 'diff-like fields dropped by default');
  const fRaw = redactFinding({ title: 't', diff: 'kept' }, { includeRaw: true });
  assert.equal(fRaw.diff, 'kept', '--include-raw preserves diff fields');
}

// --- validators over good + hostile instances ----------------------------------
{
  assert.ok(validateStatus({ schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' }).ok);
  assert.ok(!validateStatus({ schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published', headline: 'verified' }).ok,
    'a persisted headline inside the dimensions object is rejected — headlines are presentation');

  const pairing = {
    schemaVersion: 1,
    executor: { requested: 'anthropic:balanced', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    auditor: { requested: 'openai:balanced', resolved: 'openai:gpt-5.6-terra', actual: 'openai:gpt-5.6-terra' },
    independence: 'cross_vendor',
  };
  assert.ok(validatePairingManifest(pairing).ok);
  assert.ok(!validatePairingManifest({ ...pairing, auditor: { ...pairing.auditor, actual: 'anthropic:opus' } }).ok,
    'cross_vendor with same actual provider on both roles is a lie the validator refuses');

  assert.ok(validateHumanDecision({ schemaVersion: 1, kind: 'decision', question: 'q', answer: 'a', at: 1 }).ok);
  assert.ok(validateEconomics({ schemaVersion: 1, role: 'auditor', requested: 'openai:balanced', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4', billing_mode: 'subscription', estimated_cost_usd: null }).ok);

  const bundle = {
    schemaVersion: 1,
    goal: 'guard empty input',
    acceptance_contract: 'greet() throws on empty; test proves it',
    artifact: { kind: 'code', head: 'a'.repeat(40) },
    verification: { checks: [{ id: 'tests', status: 'pass' }] },
    pairing,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    human_decisions: [],
    economics: [],
    created_at: 1,
  };
  const pack = seal(bundle);
  assert.ok(validateEvidencePack(pack).ok, JSON.stringify(validateEvidencePack(pack)));
  assert.ok(!validateEvidencePack({ ...pack, acceptance_contract: '' }).ok, 'no acceptance contract, no pack');
  assert.ok(!validateEvidencePack({ ...bundle, artifact_id: pack.artifact_id }).ok, 'a pack without receipt_id is unsealed');
  assert.ok(!validateEvidencePack({ ...pack, novel: 1 }).ok, 'validator rejects unknown top-level fields');

  const record = JSON.parse(readFileSync(new URL('./benchmark/SAMPLE.record.json', import.meta.url)));
  assert.ok(validateBenchmarkRecord(record).ok, 'the committed sample validates');
  assert.ok(!validateBenchmarkRecord({ ...record, is_clean_control: true }).ok,
    'a clean control with confirmed findings is a contradiction');
}

// --- ingester over a fixture reviews dir ---------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'trust-ingest-'));
  const reviews = join(dir, 'reviews');
  const out = join(dir, 'records');
  mkdirSync(reviews, { recursive: true });
  // The real receipt shape: an audit envelope with the verdict stringified.
  writeFileSync(join(reviews, 'camus-wt-fixture-abc123-r1.json'), JSON.stringify({
    ran_at: 1781202175,
    worktree: '/Users/someone/.camus/worktrees/repo-1/camus-wt-fixture-abc123',
    round: 1,
    codex_exit: 0,
    ran: true,
    codex_raw: JSON.stringify({
      overall_correctness: 'patch is incorrect',
      overall_confidence_score: 0.9,
      findings: [
        { priority: 1, title: 'missing guard', body: 'at /Users/someone/repo/x.ts:3 the token sk-abcdefghijklmnop123 leaks', code_location: '/Users/someone/repo/x.ts:3', confidence_score: 0.8 },
      ],
    }),
    codex_parsed: {
      overall_correctness: 'patch is incorrect',
      overall_confidence_score: 0.9,
      findings: [
        { priority: 1, title: 'missing guard', body: 'at /Users/someone/repo/x.ts:3 the token sk-abcdefghijklmnop123 leaks', code_location: '/Users/someone/repo/x.ts:3', confidence_score: 0.8 },
      ],
    },
  }));
  // A bare-verdict shape (no envelope) must also ingest.
  writeFileSync(join(reviews, 'camus-wt-bare-shape-xyz789-r1.json'), JSON.stringify({
    overall_correctness: 'patch is correct',
    overall_confidence_score: 0.8,
    findings: [],
  }));
  // An infra round (ran:false) is skipped, never a record with fake findings.
  writeFileSync(join(reviews, 'camus-wt-infra-fail-qqq111-r1.json'), JSON.stringify({ ran: false, codex_exit: 1, round: 1 }));
  writeFileSync(join(reviews, 'broken-r2.json'), '{not json');
  execFileSync(process.execPath, ['ingest-reviews.mjs', '--reviews-dir', reviews, '--out', out], { cwd: import.meta.dirname });
  const files = readdirSync(out).sort();
  assert.equal(files.length, 2, 'envelope + bare shapes ingested; broken and infra rounds skipped');
  const bare = JSON.parse(readFileSync(join(out, files[0])));
  assert.equal(bare.verdict_clean, true, 'bare clean verdict recorded');
  const rec = JSON.parse(readFileSync(join(out, files[1])));
  assert.equal(rec.findings[0].adjudication, 'unresolved', 'the tool never guesses truth');
  assert.ok(rec.findings[0].body.includes('[REDACTED:api-key]'), 'secrets scrubbed');
  assert.ok(rec.findings[0].body.includes('~/repo/x.ts'), 'user paths scrubbed');
  assert.equal(rec.verdict_clean, false);
  assert.ok(validateBenchmarkRecord(rec).ok);
  rmSync(dir, { recursive: true, force: true });
}

console.log('trust.test: all assertions passed');
