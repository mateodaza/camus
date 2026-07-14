// camus-trust self-test: the derivation function is exercised over EVERY
// dimension combination; canonicalization, redaction, validators, and the
// ingester run against fixtures. Zero network, zero deps.

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIMENSIONS, HEADLINES, deriveHeadline, allCombinations, validStatus } from './lib/status.mjs';
import { canonicalize, canonicalString, computeArtifactId, computeReceiptId, artifactMatches, receiptMatches, seal, artifactProjection } from './lib/canonical.mjs';
import { computeExperimentId, experimentMatches, sealExperiment } from './lib/experiment.mjs';
import { scrubSecrets, scrubPaths, redactFinding } from './lib/redact.mjs';
import { validateStatus, validatePairingManifest, validateEvidencePack, validateBenchmarkRecord, validateHumanDecision, validateEconomics, validateExperimentRecord } from './lib/validate.mjs';

// --- status: exhaustive totality + protocol invariants ----------------------
{
  const combos = allCombinations();
  assert.equal(combos.length, 5 * 5 * 6 * 2, 'full combination space');
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

// --- schema/validator agreement: enums in the JSON match DIMENSIONS ----------
{
  const schema = JSON.parse(readFileSync(new URL('./schemas/status.v1.schema.json', import.meta.url)));
  for (const dim of Object.keys(DIMENSIONS)) {
    assert.deepEqual(schema.properties[dim].enum, DIMENSIONS[dim], `schema and code agree on ${dim}`);
  }
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
