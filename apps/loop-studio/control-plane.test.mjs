import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CHECKPOINTS,
  CONTROL_REGISTER,
  actionFingerprint,
  controlEvent,
  controlsFor,
  evaluateAction,
  humanDecision,
  validateControlRegister,
} from '../../packages/cli/skills/camus/control-plane.mjs';
import { createQualificationControl, createStudioControlPlane } from './lib/control-plane.mjs';

const repo = resolve(import.meta.dirname, '../..');

function action(actionClass = 'studio.run.launch', overrides = {}) {
  return {
    schema_version: 1,
    action_class: actionClass,
    target: { class: 'run', id: 'run-123' },
    impact: 'medium',
    reversibility: 'reversible',
    external_side_effect: 'provider_request',
    data_sensitivity: 'internal',
    destination_trust: 'known',
    operator_policy: 'allow',
    ...overrides,
  };
}

function passing(actionValue, checkpoints = CHECKPOINTS) {
  return controlsFor(actionValue.action_class, checkpoints).map((control, index) => controlEvent({
    controlId: control.control_id,
    action: actionValue,
    outcome: control.allow_not_applicable && control.control_id === 'studio.run.seat_admission'
      ? 'not_applicable' : 'passed',
    reasonCode: control.allow_not_applicable && control.control_id === 'studio.run.seat_admission'
      ? 'recovery_has_no_model_seats' : 'fixture_passed',
    now: index + 1,
  }));
}

assert.equal(validateControlRegister(CONTROL_REGISTER).register_version, 'control-register.v1');
for (const control of CONTROL_REGISTER.controls) {
  const enforcementPath = resolve(repo, control.enforcement_point.split('#')[0]);
  assert.equal(existsSync(enforcementPath), true, `${control.control_id} enforcement file exists`);
  assert.match(readFileSync(enforcementPath, 'utf8'), new RegExp(`CAMUS_CONTROL:\\s*${control.control_id.replaceAll('.', '\\.').replaceAll('-', '\\-')}(?:\\s|$)`), `${control.control_id} has an enforcement marker`);
  for (const testPath of control.last_validated_by) {
    assert.equal(existsSync(resolve(repo, testPath)), true, `${control.control_id} evidence test exists: ${testPath}`);
  }
}

const launch = action();
const launchCheckpoints = ['input_screen', 'action_authorization'];
const launchEvidence = passing(launch, launchCheckpoints);
assert.equal(evaluateAction({ action: launch, evidence: launchEvidence, checkpoints: launchCheckpoints, now: 10 }).decision, 'auto');

const missing = evaluateAction({ action: launch, evidence: [], checkpoints: launchCheckpoints, modelRecommendation: 'auto', now: 11 });
assert.equal(missing.decision, 'refuse', 'a model cannot turn missing hard evidence into auto');
assert.equal(missing.cause, 'policy_refused');

const malformed = structuredClone(launchEvidence);
malformed[0].control_version = 'future';
assert.equal(evaluateAction({ action: launch, evidence: malformed, checkpoints: launchCheckpoints, now: 12 }).decision, 'refuse');
const forged = structuredClone(launchEvidence);
delete forged[0].reason_code;
assert.equal(evaluateAction({ action: launch, evidence: forged, checkpoints: launchCheckpoints, now: 12 }).decision, 'refuse', 'hand-crafted partial events are not evidence');

const escalated = evaluateAction({
  action: launch,
  evidence: launchEvidence,
  checkpoints: launchCheckpoints,
  modelRecommendation: 'human_required',
  now: 13,
});
assert.equal(escalated.decision, 'human_required', 'a model may only escalate an otherwise automatic route');
assert.equal(escalated.source, 'model_escalation');

const publication = action('studio.publish.artifact', {
  target: { class: 'hivemind_artifact', id: 'run-123' },
  impact: 'high',
  reversibility: 'irreversible',
  external_side_effect: 'publication',
  destination_trust: 'declared',
  operator_policy: 'ask',
});
const publicationEvidence = passing(publication);
assert.equal(evaluateAction({ action: publication, evidence: publicationEvidence, now: 20 }).decision, 'human_required');
const partialApproval = { decision: 'approve', action_fingerprint: actionFingerprint(publication) };
assert.deepEqual(
  evaluateAction({ action: publication, evidence: publicationEvidence, authorization: partialApproval, now: 20 }).rule_ids,
  ['human_authorization_malformed'],
  'a fingerprint plus approve label is not a valid human receipt',
);
const approval = humanDecision(publication, { decision: 'approve', reason: 'Publish this exact completed run', now: 21 });
const approved = evaluateAction({ action: publication, evidence: publicationEvidence, authorization: approval, modelRecommendation: 'auto', now: 22 });
assert.equal(approved.decision, 'auto');
assert.equal(approved.source, 'human');

const changedTarget = { ...publication, target: { class: 'hivemind_artifact', id: 'run-OTHER' } };
const changedEvidence = passing(changedTarget);
const rebound = evaluateAction({ action: changedTarget, evidence: changedEvidence, authorization: approval, now: 23 });
assert.equal(rebound.decision, 'refuse', 'approval for one exact target cannot authorize another');
assert.deepEqual(rebound.rule_ids, ['human_binding_mismatch']);

const controlDir = mkdtempSync(join(tmpdir(), 'camus-controls-'));
process.env.STUDIO_CONTROL_DIR = controlDir;
try {
  const qualification = createQualificationControl({
    seat: 'reviewer', backend: 'qwen_local', model: 'qwen3-coder',
    connection: 'ollama', transport: 'loopback',
  });
  assert.equal(qualification.preflight.decision, 'auto', 'the exact Qualify action carries bound human approval');
  const terminal = qualification.finish({ result: { qualified: false, reason: 'requirements_unmet', receipt: {} } });
  assert.equal(terminal.route.decision, 'auto', 'a valid negative probe result is safe to present but grants no admission');
  assert.equal(terminal.receipt.human_decisions[0].action_fingerprint, qualification.actionFingerprint);
  const punctuationVariant = createQualificationControl({
    seat: 'reviewer', backend: 'qwen_local', model: 'qwen3?coder',
    connection: 'ollama', transport: 'loopback',
  });
  assert.notEqual(
    punctuationVariant.actionFingerprint,
    qualification.actionFingerprint,
    'normalization cannot collapse two distinct model IDs onto one human authorization',
  );
  const files = readdirSync(controlDir);
  assert.equal(files.length, 1, 'the paid action leaves one standalone local receipt');
  assert.equal(statSync(join(controlDir, files[0])).mode & 0o777, 0o600);
} finally {
  delete process.env.STUDIO_CONTROL_DIR;
  rmSync(controlDir, { recursive: true, force: true });
}

const studioPlane = createStudioControlPlane({
  id: 'run-ssh-binding',
  goal: 'Exercise the exact managed SSH evidence binding.',
  acceptanceContract: 'Every SSH fact belongs to the immutable destination used by this run.',
  lane: 'freeform',
  models: {
    maker: { backend: 'claude', model: 'maker', transport: 'vendor_managed' },
    reviewer: { backend: 'codex', model: 'reviewer', transport: 'vendor_managed' },
  },
});
const sshFingerprintA = `ssh1:${'a'.repeat(64)}`;
const sshFingerprintB = `ssh1:${'b'.repeat(64)}`;
assert.equal(studioPlane.recordSshFact({ control_id: 'slice-d.config_validate', connection: 'gpu', outcome: 'passed' }), null, 'name-only SSH facts are not evidence');
for (const [controlId, outcome] of [
  ['slice-d.config_validate', 'passed'],
  ['slice-d.host_key_advisory', 'passed'],
  ['slice-d.directive_screen', 'passed'],
  ['slice-d.forward_only_argv', 'passed'],
  ['slice-d.ownership', 'shared'],
  ['slice-d.application_liveness', 'passed'],
  ['slice-d.output_integrity', 'passed'],
]) {
  const result = studioPlane.recordSshFact({
    control_id: controlId,
    connection: 'gpu',
    connectionFingerprint: sshFingerprintA,
    outcome,
  });
  if (controlId === 'slice-d.output_integrity') assert.equal(result.route.decision, 'auto');
}
studioPlane.recordSshFact({
  control_id: 'slice-d.config_validate',
  connection: 'gpu',
  connectionFingerprint: sshFingerprintB,
  outcome: 'passed',
});
const sshActions = studioPlane.receipt().actions.filter((item) => item.action_class === 'studio.ssh.forward');
assert.equal(sshActions.length, 2, 'same-name SSH destinations remain distinct governed actions');
assert.notEqual(actionFingerprint(sshActions[0]), actionFingerprint(sshActions[1]));

assert.throws(() => createStudioControlPlane({
  id: 'run-unqualified-seat',
  goal: 'Refuse a configurable seat without exact admission.',
  acceptanceContract: 'The launch control must reject missing qualification evidence.',
  lane: 'freeform',
  models: {
    maker: { backend: 'custom', model: 'served-model', transport: 'loopback' },
    reviewer: { backend: 'codex', model: 'reviewer', transport: 'vendor_managed' },
  },
}), /Studio launch refuse/, 'the control receipt cannot grade an unqualified configurable seat as admitted');

const qualifiedPlane = createStudioControlPlane({
  id: 'run-qualified-seat',
  goal: 'Bind the exact qualification into the launch action.',
  acceptanceContract: 'The exact seat type and fingerprint must ride the launch decision.',
  lane: 'freeform',
  models: {
    maker: {
      backend: 'custom', model: 'served-model', transport: 'loopback',
      qualification: { seatType: 'words_maker', fingerprint: `qual1:${'c'.repeat(64)}` },
    },
    reviewer: { backend: 'codex', model: 'reviewer', transport: 'vendor_managed' },
  },
});
const changedQualificationPlane = createStudioControlPlane({
  id: 'run-qualified-seat',
  goal: 'Bind the exact qualification into the launch action.',
  acceptanceContract: 'The exact seat type and fingerprint must ride the launch decision.',
  lane: 'freeform',
  models: {
    maker: {
      backend: 'custom', model: 'served-model', transport: 'loopback',
      qualification: { seatType: 'words_maker', fingerprint: `qual1:${'d'.repeat(64)}` },
    },
    reviewer: { backend: 'codex', model: 'reviewer', transport: 'vendor_managed' },
  },
});
assert.notEqual(qualifiedPlane.launchActionFingerprint, changedQualificationPlane.launchActionFingerprint, 'qualification drift changes the governed launch action');

assert.throws(() => controlEvent({
  controlId: 'studio.run.acceptance_contract',
  action: launch,
  outcome: 'passed',
  reasonCode: 'bad_evidence',
  details: { authorization: 'Bearer definitely-secret' },
}), /not allowed in control evidence/);
assert.throws(() => controlEvent({
  controlId: 'studio.run.acceptance_contract', action: launch,
  outcome: 'passed', reasonCode: 'nonfinite', details: { score: Number.NaN },
}), /must be finite/);

const causeControl = 'studio.run.acceptance_contract';
for (const cause of ['provider_refused', 'policy_refused', 'review_rejected', 'control_inconclusive', 'needs_human', 'infrastructure_failed']) {
  const evidence = [controlEvent({ controlId: causeControl, action: launch, outcome: 'refused', reasonCode: cause, cause, now: 30 })];
  const routed = evaluateAction({ action: launch, evidence, checkpoints: ['input_screen'], now: 31 });
  assert.equal(routed.cause, cause, `${cause} remains mechanically distinct`);
}

assert.equal(
  actionFingerprint(launch),
  'action1:f83ccd27a4e25bc122272fb6d6cee016cf4ad6b37a38d71ddd6f3c777071d2c6',
  'JS/Python golden action fingerprint',
);

console.log(`control-plane.test.mjs: ${CONTROL_REGISTER.controls.length} registered controls and routing matrix passed`);
