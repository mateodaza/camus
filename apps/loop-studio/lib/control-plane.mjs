// Studio adapter for the shared Responsible Control Plane kernel. The immutable
// evidence-pack schemas remain untouched; this receipt lives beside the pack in
// report.json and in explicit `control` / `control_route` run events.
// CAMUS_CONTROL: studio.run.acceptance_contract
// CAMUS_CONTROL: studio.run.seat_admission
// CAMUS_CONTROL: studio.run.dispatch_authorization
// CAMUS_CONTROL: studio.run.output_standing
// CAMUS_CONTROL: studio.publish.lane_eligibility
// CAMUS_CONTROL: studio.publish.explicit_consent
// CAMUS_CONTROL: studio.publish.output_eligibility
// CAMUS_CONTROL: studio.qualification.receipt_integrity

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINTS,
  CONTROL_REGISTER,
  actionFingerprint,
  canonicalString,
  controlsFor,
  createControlRecorder,
} from '../../../packages/cli/skills/camus/control-plane.mjs';
import { studioAtomicWrite, STUDIO_FILE_MODE } from './grandfather.mjs';

export class ControlPlaneError extends Error {
  constructor(message, route) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = route?.cause ?? 'policy_refused';
    this.route = route ?? null;
  }
}

const safeId = (value) => String(value ?? 'none').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 300);

function launchAction({ id, lane, depth, ground, targetPath, targetToplevel, verifyCmd, recovery, models }) {
  // Only the digest is stored, but it covers the complete frozen dispatch
  // decision: effort, round cap, aliases, qualification, recovery provenance,
  // verifier, and target. Adding a field upstream changes the action instead of
  // silently falling outside its authorization boundary.
  const dispatchMaterial = canonicalString({
    id,
    lane,
    depth: depth ?? null,
    ground: ground === true,
    targetPath: targetPath ?? null,
    targetToplevel: targetToplevel ?? null,
    verifyCmd: verifyCmd ?? null,
    recovery: recovery ?? null,
    models: models ?? null,
  });
  const dispatchHash = createHash('sha256').update(dispatchMaterial, 'utf8').digest('hex');
  return {
    schema_version: 1,
    action_class: 'studio.run.launch',
    target: {
      class: recovery ? 'verification_recovery' : lane === 'build' ? 'repository_run' : 'words_run',
      id: `${safeId(id)}:launch1:${dispatchHash}`,
    },
    impact: lane === 'build' ? 'high' : 'medium',
    reversibility: lane === 'build' ? 'bounded_rollback' : 'reversible',
    external_side_effect: recovery ? 'local_mutation' : lane === 'build' ? 'local_mutation' : 'provider_request',
    data_sensitivity: 'internal',
    destination_trust: lane === 'build' || recovery ? 'local' : 'known',
    operator_policy: 'allow',
  };
}

function publicationAction(id) {
  return {
    schema_version: 1,
    action_class: 'studio.publish.artifact',
    target: { class: 'hivemind_artifact', id: safeId(id) },
    impact: 'high',
    reversibility: 'irreversible',
    external_side_effect: 'publication',
    data_sensitivity: 'internal',
    destination_trust: 'declared',
    operator_policy: 'ask',
  };
}

function sshAction(id, connection, connectionFingerprint) {
  return {
    schema_version: 1,
    action_class: 'studio.ssh.forward',
    target: { class: 'ssh_connection', id: safeId(`${id}:${connection}:${connectionFingerprint}`) },
    impact: 'high',
    reversibility: 'bounded_rollback',
    external_side_effect: 'remote_access',
    data_sensitivity: 'internal',
    destination_trust: 'known',
    operator_policy: 'ask',
  };
}

function qualificationAction({ seat, backend, model, connection }) {
  const tuple = JSON.stringify([seat, backend, model, connection ?? null]);
  const tupleHash = createHash('sha256').update(tuple, 'utf8').digest('hex');
  return {
    schema_version: 1,
    action_class: 'studio.qualification.execute',
    target: { class: 'model_seat_tuple', id: `${safeId(`${seat}:${backend}:${connection ?? 'none'}`)}:tuple1:${tupleHash}` },
    impact: 'medium',
    reversibility: 'reversible',
    external_side_effect: 'provider_request',
    data_sensitivity: 'internal',
    destination_trust: 'declared',
    operator_policy: 'ask',
  };
}

function controlActionsDir() {
  return process.env.STUDIO_CONTROL_DIR || join(homedir(), '.camus', 'studio', 'control-actions');
}

function persistStandaloneReceipt(receipt, route) {
  const recordedAt = Date.now();
  const suffix = randomBytes(5).toString('hex');
  const path = join(controlActionsDir(), `qualification-${recordedAt}-${suffix}.json`);
  studioAtomicWrite(path, `${JSON.stringify({ ...receipt, terminal_route: route, recorded_at: recordedAt }, null, 2)}\n`, STUDIO_FILE_MODE);
  return path;
}

// A qualification is a bounded but paid provider action. The authorized POST is
// the human decision; the decision is fingerprint-bound to one exact tuple, and
// the terminal normalized result gets a separate local 0600 control receipt.
export function createQualificationControl({ seat, backend, model, connection, transport, consentReason } = {}) {
  const recorder = createControlRecorder();
  const action = qualificationAction({ seat, backend, model, connection });
  const details = {
    seat: safeId(seat), backend: safeId(backend), connection: safeId(connection ?? 'none'),
    transport: safeId(transport ?? 'unknown'), model_hash: action.target.id.slice(-64),
  };
  recorder.record({
    controlId: 'studio.qualification.exact_tuple', action, outcome: 'passed',
    reasonCode: 'declared_qualifiable_tuple', details,
  });
  recorder.record({
    controlId: 'studio.qualification.explicit_consent', action, outcome: 'passed',
    reasonCode: 'explicit_qualification_post', details,
  });
  const authorization = recorder.authorize(
    action, 'approve', consentReason || 'Operator explicitly selected Qualify for this exact declared seat tuple.',
  );
  const preflight = recorder.evaluate({
    action, authorization, checkpoints: ['input_screen', 'action_authorization'],
  });
  if (preflight.decision !== 'auto') {
    throw new ControlPlaneError(`Qualification ${preflight.decision}: ${preflight.rule_ids.join(', ')}`, preflight);
  }
  const finish = ({ result = null, error = null } = {}) => {
    const normalized = result && typeof result.qualified === 'boolean' && typeof result.reason === 'string';
    recorder.record({
      controlId: 'studio.qualification.receipt_integrity', action,
      outcome: normalized ? 'passed' : 'inconclusive',
      reasonCode: normalized ? 'normalized_qualification_result_recorded' : 'qualification_result_unavailable',
      cause: normalized ? null : error?.cause || 'infrastructure_failed',
      details: normalized
        ? { qualified: result.qualified, reason: result.reason, receipt_written: Boolean(result.receipt) }
        : { qualified: false, reason: String(error?.code || 'qualification_error').slice(0, 120), receipt_written: false },
    });
    const route = recorder.evaluate({ action, authorization });
    const receipt = recorder.receipt();
    const path = persistStandaloneReceipt(receipt, route);
    return { receipt, route, path };
  };
  return Object.freeze({ actionFingerprint: actionFingerprint(action), preflight, finish });
}

function usableStatuses(statuses) {
  return statuses && [1, 2].includes(statuses.schemaVersion)
    && typeof statuses.execution === 'string'
    && typeof statuses.verification === 'string'
    && typeof statuses.audit === 'string'
    && typeof statuses.publication === 'string';
}

const QUAL1_RE = /^qual1:[0-9a-f]{64}$/;
function admittedSnapshotSeat(seat, seatKey) {
  if (!seat || typeof seat.backend !== 'string' || !seat.backend
    || typeof seat.model !== 'string' || !seat.model) return false;
  if (['claude', 'codex'].includes(seat.backend)) {
    return seat.transport === 'vendor_managed';
  }
  return seat.qualification?.seatType === (seatKey === 'maker' ? 'words_maker' : 'words_reviewer')
    && QUAL1_RE.test(seat.qualification?.fingerprint ?? '');
}

export function createStudioControlPlane({
  id,
  goal,
  acceptanceContract,
  lane,
  depth = null,
  ground = false,
  targetPath = null,
  targetToplevel = null,
  verifyCmd = null,
  models,
  recovery = null,
  publishRequested = false,
  now = () => Date.now(),
} = {}) {
  const recorder = createControlRecorder({ now });
  let emit = null;
  const pending = [];
  const ssh = new Map();
  const publish = (type, value) => {
    if (emit) emit(type, type === 'control' ? { control: value } : type === 'control_route' ? { route: value } : { decision: value });
    else pending.push([type, value]);
    return value;
  };
  const record = (input) => publish('control', recorder.record(input));
  const evaluate = (input) => publish('control_route', recorder.evaluate(input));
  const authorize = (action, decision, reason) => publish('control_human', recorder.authorize(action, decision, reason));

  const launch = launchAction({ id, lane, depth, ground, targetPath, targetToplevel, verifyCmd, recovery, models });
  // Verification-only recovery does not re-plan or ask a model to interpret the
  // historical goal. Legacy runs may therefore carry a terse (but non-empty)
  // goal; the preserved acceptance contract remains mandatory and the exact
  // parked candidate is separately bound by dispatch authorization.
  const goalOk = typeof goal === 'string' && goal.trim().length >= (recovery ? 1 : 12);
  const contractOk = goalOk
    && typeof acceptanceContract === 'string' && acceptanceContract.trim().length >= 12;
  record({
    controlId: 'studio.run.acceptance_contract', action: launch,
    outcome: contractOk ? 'passed' : 'refused',
    reasonCode: contractOk
      ? recovery ? 'recovery_goal_and_contract_preserved' : 'goal_and_contract_present'
      : 'goal_or_contract_missing',
    cause: contractOk ? null : 'policy_refused',
    details: { lane },
  });
  const noSeats = Boolean(recovery) || lane === 'build';
  const seatsOk = noSeats
    || (admittedSnapshotSeat(models?.maker, 'maker') && admittedSnapshotSeat(models?.reviewer, 'reviewer'));
  record({
    controlId: 'studio.run.seat_admission', action: launch,
    outcome: noSeats ? 'not_applicable' : seatsOk ? 'passed' : 'refused',
    reasonCode: noSeats ? (recovery ? 'recovery_has_no_model_seats' : 'build_gate_owns_model_seats')
      : seatsOk ? 'run_snapshot_has_admitted_exact_seats' : 'run_snapshot_seat_admission_unproven',
    cause: noSeats || seatsOk ? null : 'policy_refused',
    details: { lane, recovery: Boolean(recovery) },
  });
  const targetOk = lane !== 'build' || Boolean(targetPath);
  record({
    controlId: 'studio.run.dispatch_authorization', action: launch,
    outcome: targetOk ? 'passed' : 'refused',
    reasonCode: targetOk ? 'lane_target_and_snapshot_bound' : 'build_target_unbound',
    cause: targetOk ? null : 'policy_refused',
    details: { lane, target_class: launch.target.class },
  });
  const launchAuthorization = lane === 'build'
    ? authorize(launch, 'approve', 'Operator explicitly launched this exact bounded repository run.')
    : null;
  const launchRoute = evaluate({
    action: launch,
    authorization: launchAuthorization,
    checkpoints: ['input_screen', 'action_authorization'],
  });
  if (launchRoute.decision !== 'auto') {
    throw new ControlPlaneError(`Studio launch ${launchRoute.decision}: ${launchRoute.rule_ids.join(', ')}`, launchRoute);
  }

  let publication = null;
  let publicationAuthorization = null;
  if (publishRequested) {
    publication = publicationAction(id);
    record({
      controlId: 'studio.publish.lane_eligibility', action: publication,
      outcome: lane === 'build' ? 'refused' : 'passed',
      reasonCode: lane === 'build' ? 'build_publication_unsupported' : 'words_lane_publication_supported',
      cause: lane === 'build' ? 'policy_refused' : null,
      details: { lane, destination: 'hivemind' },
    });
    record({
      controlId: 'studio.publish.explicit_consent', action: publication,
      outcome: 'passed', reasonCode: 'browser_publish_opt_in_true',
      details: { destination: 'hivemind', run_id: id },
    });
    publicationAuthorization = authorize(publication, 'approve', 'Operator explicitly enabled publication for this exact run and destination.');
    const prePublication = evaluate({
      action: publication,
      authorization: publicationAuthorization,
      checkpoints: ['input_screen', 'action_authorization'],
    });
    if (prePublication.decision !== 'auto') {
      throw new ControlPlaneError(`Publication ${prePublication.decision}: ${prePublication.rule_ids.join(', ')}`, prePublication);
    }
  }

  const api = {
    attach(nextEmit) {
      emit = typeof nextEmit === 'function' ? nextEmit : null;
      if (emit) {
        for (const [type, value] of pending.splice(0)) publish(type, value);
      }
    },
    authorizePublicationOutput({ eligible, reasonCode = null } = {}) {
      if (!publication || !publicationAuthorization) {
        throw new ControlPlaneError('Publication was not explicitly enabled for this run', {
          cause: 'policy_refused', rule_ids: ['publication_not_requested'], decision: 'refuse',
        });
      }
      record({
        controlId: 'studio.publish.output_eligibility', action: publication,
        outcome: eligible ? 'passed' : 'refused',
        reasonCode: reasonCode || (eligible ? 'review_and_verification_floor_passed' : 'output_quality_floor_failed'),
        cause: eligible ? null : 'policy_refused',
        details: { destination: 'hivemind' },
      });
      const result = evaluate({ action: publication, authorization: publicationAuthorization });
      if (result.decision !== 'auto') throw new ControlPlaneError(`Publication ${result.decision}: ${result.rule_ids.join(', ')}`, result);
      return result;
    },
    finishRun({ statuses, status }) {
      const good = usableStatuses(statuses);
      record({
        controlId: 'studio.run.output_standing', action: launch,
        outcome: good ? 'passed' : 'inconclusive',
        reasonCode: good ? 'raw_status_dimensions_derived' : 'raw_status_dimensions_missing',
        cause: good ? null : 'control_inconclusive',
        details: { terminal_status: String(status ?? 'unknown') },
      });
      return evaluate({ action: launch, authorization: launchAuthorization });
    },
    recordSshFact(fact) {
      if (!fact || typeof fact.control_id !== 'string' || !fact.control_id.startsWith('slice-d.')) return null;
      if (!CONTROL_REGISTER.controls.some((control) => control.control_id === fact.control_id)) return null;
      const connection = String(fact.connection ?? 'unknown');
      const connectionFingerprint = String(fact.connectionFingerprint ?? '');
      if (!/^ssh1:[0-9a-f]{64}$/.test(connectionFingerprint)) return null;
      const sshKey = JSON.stringify([connection, connectionFingerprint]);
      let state = ssh.get(sshKey);
      if (!state) {
        const action = sshAction(id, connection, connectionFingerprint);
        const authorization = authorize(action, 'approve', 'Operator configured this exact named SSH connection for managed forwarding.');
        state = { action, authorization };
        ssh.set(sshKey, state);
      }
      const passed = new Set(['passed', 'hit', 'spawned', 'leased', 'shared', 'released', 'active_managed', 'orphan_closed']);
      const refused = fact.outcome === 'refused';
      const infrastructure = fact.outcome === 'infrastructure_failed';
      const outcome = passed.has(fact.outcome) ? 'passed' : refused ? 'refused' : 'inconclusive';
      const cause = outcome === 'passed' ? null : infrastructure ? 'infrastructure_failed'
        : refused ? 'policy_refused' : 'control_inconclusive';
      const details = {};
      for (const key of ['connection', 'connectionFingerprint', 'trustedProxy', 'argvShape', 'refs']) {
        if (fact[key] !== undefined) details[key] = fact[key];
      }
      const event = record({
        controlId: fact.control_id,
        action: state.action,
        outcome,
        reasonCode: String(fact.reason || fact.outcome || 'ssh_control_event').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120),
        cause,
        details,
      });
      if (fact.control_id === 'slice-d.output_integrity') {
        const result = evaluate({ action: state.action, authorization: state.authorization });
        return { event, route: result };
      }
      return event;
    },
    receipt: () => recorder.receipt(),
    launchActionFingerprint: actionFingerprint(launch),
  };
  return Object.freeze(api);
}

export { CHECKPOINTS, controlsFor };
