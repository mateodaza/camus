// Camus Responsible Control Plane v1.
//
// Models may recommend an escalation. They never authorize an action, weaken a
// hard rule, or turn missing evidence into a pass. This module is deliberately
// zero-dependency so Studio and the packaged CLI can consume one contract.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CONTROL_PLANE_VERSION = 'control-plane.v1';
export const CHECKPOINTS = Object.freeze(['input_screen', 'action_authorization', 'output_screen']);
export const CONTROL_OUTCOMES = Object.freeze(['passed', 'refused', 'inconclusive', 'not_applicable']);
export const ROUTE_DECISIONS = Object.freeze(['auto', 'human_required', 'refuse', 'inconclusive']);
export const FAILURE_CAUSES = Object.freeze([
  'provider_refused',
  'policy_refused',
  'review_rejected',
  'control_inconclusive',
  'needs_human',
  'infrastructure_failed',
]);

const IMPACT = Object.freeze(['low', 'medium', 'high']);
const REVERSIBILITY = Object.freeze(['reversible', 'bounded_rollback', 'irreversible']);
const SIDE_EFFECT = Object.freeze([
  'none', 'local_mutation', 'provider_request', 'publication', 'remote_access',
  'destructive_mutation', 'credential_boundary_change', 'remote_command',
]);
const DATA_SENSITIVITY = Object.freeze(['public', 'internal', 'sensitive', 'restricted']);
const DESTINATION_TRUST = Object.freeze(['local', 'known', 'declared', 'unknown']);
const OPERATOR_POLICY = Object.freeze(['allow', 'ask', 'refuse']);
const HUMAN_REQUIRED_EFFECTS = new Set([
  'publication', 'remote_access', 'destructive_mutation',
  'credential_boundary_change', 'remote_command',
]);
const SENSITIVE_KEY = /(?:secret|password|authorization|api[_-]?key|credential[_-]?value|token|prompt|raw[_-]?(?:input|output)|environment[_-]?dump)/i;
const CREDENTIAL_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+/=-]{4,}|\b(?:sk|rk|pk|api|key)[-_][A-Za-z0-9._~+/=-]{6,})/i;

const rawRegister = JSON.parse(readFileSync(new URL('./control-register.v1.json', import.meta.url), 'utf8'));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  const extras = Object.keys(value).filter((key) => !expected.includes(key));
  if (extras.length) throw new TypeError(`${label} has unknown fields: ${extras.join(', ')}`);
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalString(value) {
  return JSON.stringify(canonicalValue(value));
}

export function validateControlRegister(register = rawRegister) {
  if (!isObject(register) || register.schema_version !== 1
    || register.register_version !== 'control-register.v1' || !Array.isArray(register.controls)) {
    throw new TypeError('control register must be the control-register.v1 object');
  }
  const ids = new Set();
  const byAction = new Map();
  const required = [
    'control_id', 'control_version', 'checkpoint', 'risk_addressed', 'owner',
    'enforcement_point', 'applies_to', 'failure_direction', 'evidence_artifact',
    'risk_level', 'allow_not_applicable', 'last_validated_by', 'revalidation_trigger',
  ];
  for (const [index, control] of register.controls.entries()) {
    if (!isObject(control)) throw new TypeError(`controls[${index}] must be an object`);
    exactKeys(control, required, `controls[${index}]`);
    for (const field of ['control_id', 'control_version', 'risk_addressed', 'owner', 'enforcement_point', 'evidence_artifact', 'revalidation_trigger']) {
      nonempty(control[field], `controls[${index}].${field}`);
    }
    if (ids.has(control.control_id)) throw new TypeError(`duplicate control_id ${control.control_id}`);
    ids.add(control.control_id);
    if (!CHECKPOINTS.includes(control.checkpoint)) throw new TypeError(`${control.control_id} has an invalid checkpoint`);
    if (!ROUTE_DECISIONS.includes(control.failure_direction) || control.failure_direction === 'auto') {
      throw new TypeError(`${control.control_id} has an invalid failure_direction`);
    }
    if (!['low', 'medium', 'high', 'critical'].includes(control.risk_level)) throw new TypeError(`${control.control_id} has an invalid risk_level`);
    if (typeof control.allow_not_applicable !== 'boolean') throw new TypeError(`${control.control_id}.allow_not_applicable must be boolean`);
    if (!Array.isArray(control.applies_to) || !control.applies_to.length) throw new TypeError(`${control.control_id}.applies_to must be non-empty`);
    if (!Array.isArray(control.last_validated_by) || !control.last_validated_by.length) throw new TypeError(`${control.control_id} has no evidence test`);
    for (const action of control.applies_to) {
      nonempty(action, `${control.control_id}.applies_to[]`);
      if (!byAction.has(action)) byAction.set(action, new Set());
      byAction.get(action).add(control.checkpoint);
    }
  }
  for (const [action, checkpoints] of byAction) {
    const missing = CHECKPOINTS.filter((checkpoint) => !checkpoints.has(checkpoint));
    if (missing.length) throw new TypeError(`${action} is missing checkpoints: ${missing.join(', ')}`);
  }
  return Object.freeze({ ...register, controls: Object.freeze(register.controls.map((item) => Object.freeze({ ...item }))) });
}

export const CONTROL_REGISTER = validateControlRegister(rawRegister);
const CONTROL_BY_ID = new Map(CONTROL_REGISTER.controls.map((control) => [control.control_id, control]));

export function controlsFor(actionClass, checkpoints = CHECKPOINTS) {
  const wanted = new Set(checkpoints);
  return CONTROL_REGISTER.controls.filter((control) => control.applies_to.includes(actionClass) && wanted.has(control.checkpoint));
}

export function validateAction(action) {
  if (!isObject(action)) throw new TypeError('control action must be an object');
  const fields = [
    'schema_version', 'action_class', 'target', 'impact', 'reversibility',
    'external_side_effect', 'data_sensitivity', 'destination_trust', 'operator_policy',
  ];
  exactKeys(action, fields, 'control action');
  if (action.schema_version !== 1) throw new TypeError('control action schema_version must be 1');
  nonempty(action.action_class, 'control action.action_class');
  if (!isObject(action.target)) throw new TypeError('control action.target must be an object');
  exactKeys(action.target, ['class', 'id'], 'control action.target');
  nonempty(action.target.class, 'control action.target.class');
  nonempty(action.target.id, 'control action.target.id');
  if (!IMPACT.includes(action.impact)) throw new TypeError('control action.impact is invalid');
  if (!REVERSIBILITY.includes(action.reversibility)) throw new TypeError('control action.reversibility is invalid');
  if (!SIDE_EFFECT.includes(action.external_side_effect)) throw new TypeError('control action.external_side_effect is invalid');
  if (!DATA_SENSITIVITY.includes(action.data_sensitivity)) throw new TypeError('control action.data_sensitivity is invalid');
  if (!DESTINATION_TRUST.includes(action.destination_trust)) throw new TypeError('control action.destination_trust is invalid');
  if (!OPERATOR_POLICY.includes(action.operator_policy)) throw new TypeError('control action.operator_policy is invalid');
  if (!controlsFor(action.action_class).length) throw new TypeError(`unregistered action_class ${action.action_class}`);
  return action;
}

export function actionFingerprint(action) {
  validateAction(action);
  return `action1:${createHash('sha256').update(canonicalString(action), 'utf8').digest('hex')}`;
}

function safeDetails(value, path = 'details', depth = 0) {
  if (depth > 4) throw new TypeError(`${path} is too deeply nested`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 500) throw new TypeError(`${path} exceeds 500 characters`);
    if (CREDENTIAL_VALUE.test(value)) throw new TypeError(`${path} looks credential-shaped`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new TypeError(`${path} has too many items`);
    return value.map((item, index) => safeDetails(item, `${path}[${index}]`, depth + 1));
  }
  if (!isObject(value)) throw new TypeError(`${path} contains an unsupported value`);
  const keys = Object.keys(value);
  if (keys.length > 32) throw new TypeError(`${path} has too many fields`);
  const out = {};
  for (const key of keys) {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`${path}.${key} is not allowed in control evidence`);
    out[key] = safeDetails(value[key], `${path}.${key}`, depth + 1);
  }
  return out;
}

export function controlEvent({ controlId, action, outcome, reasonCode, cause = null, details = {}, now = Date.now() }) {
  const control = CONTROL_BY_ID.get(controlId);
  if (!control) throw new TypeError(`unknown control_id ${controlId}`);
  validateAction(action);
  if (!control.applies_to.includes(action.action_class)) throw new TypeError(`${controlId} does not apply to ${action.action_class}`);
  if (!CONTROL_OUTCOMES.includes(outcome)) throw new TypeError(`${controlId} has invalid outcome ${outcome}`);
  if (outcome === 'not_applicable' && !control.allow_not_applicable) throw new TypeError(`${controlId} may not be not_applicable`);
  nonempty(reasonCode, `${controlId}.reason_code`);
  if (cause !== null && !FAILURE_CAUSES.includes(cause)) throw new TypeError(`${controlId} has invalid cause ${cause}`);
  if (outcome !== 'passed' && outcome !== 'not_applicable' && cause === null) throw new TypeError(`${controlId} ${outcome} requires a cause`);
  if (!Number.isInteger(now) || now < 0) throw new TypeError('control event time must be a non-negative integer');
  return {
    schema_version: 1,
    control_id: control.control_id,
    control_version: control.control_version,
    checkpoint: control.checkpoint,
    action_class: action.action_class,
    action_fingerprint: actionFingerprint(action),
    outcome,
    reason_code: reasonCode,
    cause,
    details: safeDetails(details),
    at: now,
  };
}

export function humanDecision(action, { decision, reason, now = Date.now() } = {}) {
  validateAction(action);
  if (!['approve', 'refuse'].includes(decision)) throw new TypeError('human decision must be approve or refuse');
  nonempty(reason, 'human decision reason');
  safeDetails(reason, 'human decision reason');
  if (!Number.isInteger(now) || now < 0) throw new TypeError('human decision time must be a non-negative integer');
  return {
    schema_version: 1,
    action_fingerprint: actionFingerprint(action),
    decision,
    reason: reason.trim().slice(0, 500),
    at: now,
  };
}

const EVENT_FIELDS = [
  'schema_version', 'control_id', 'control_version', 'checkpoint', 'action_class',
  'action_fingerprint', 'outcome', 'reason_code', 'cause', 'details', 'at',
];

function validEvidenceEvent(event, control, action, fingerprint) {
  try {
    if (!isObject(event)) return false;
    exactKeys(event, EVENT_FIELDS, 'control event');
    if (event.schema_version !== 1 || event.control_id !== control.control_id
      || event.control_version !== control.control_version || event.checkpoint !== control.checkpoint
      || event.action_class !== action.action_class || event.action_fingerprint !== fingerprint
      || !CONTROL_OUTCOMES.includes(event.outcome)
      || (event.outcome === 'not_applicable' && !control.allow_not_applicable)) return false;
    nonempty(event.reason_code, `${control.control_id}.reason_code`);
    if (event.cause !== null && !FAILURE_CAUSES.includes(event.cause)) return false;
    if (!['passed', 'not_applicable'].includes(event.outcome) && event.cause === null) return false;
    if (!Number.isInteger(event.at) || event.at < 0) return false;
    safeDetails(event.details);
    return true;
  } catch {
    return false;
  }
}

function validAuthorization(authorization) {
  try {
    if (!isObject(authorization)) return false;
    exactKeys(authorization, ['schema_version', 'action_fingerprint', 'decision', 'reason', 'at'], 'human decision');
    if (authorization.schema_version !== 1 || !['approve', 'refuse'].includes(authorization.decision)) return false;
    nonempty(authorization.action_fingerprint, 'human decision action_fingerprint');
    nonempty(authorization.reason, 'human decision reason');
    safeDetails(authorization.reason, 'human decision reason');
    return Number.isInteger(authorization.at) && authorization.at >= 0;
  } catch {
    return false;
  }
}

function route(decision, source, ruleIds, cause, action, checkpoints, controls, now) {
  return {
    schema_version: 1,
    decision,
    source,
    rule_ids: [...new Set(ruleIds)],
    cause,
    action_class: action.action_class,
    action_fingerprint: actionFingerprint(action),
    checkpoints: [...checkpoints],
    checked_controls: controls.map((control) => control.control_id),
    at: now,
  };
}

function highStakes(action) {
  return action.impact === 'high'
    || action.reversibility === 'irreversible'
    || HUMAN_REQUIRED_EFFECTS.has(action.external_side_effect)
    || (action.data_sensitivity === 'restricted' && action.destination_trust !== 'local');
}

export function evaluateAction({
  action,
  evidence = [],
  authorization = null,
  modelRecommendation = null,
  checkpoints = CHECKPOINTS,
  now = Date.now(),
} = {}) {
  validateAction(action);
  if (!Array.isArray(evidence)) throw new TypeError('control evidence must be an array');
  if (!Array.isArray(checkpoints) || !checkpoints.length || checkpoints.some((item) => !CHECKPOINTS.includes(item))) {
    throw new TypeError('checkpoints must be a non-empty subset of the control checkpoints');
  }
  if (modelRecommendation !== null && !ROUTE_DECISIONS.includes(modelRecommendation)) throw new TypeError('model recommendation is invalid');
  const controls = controlsFor(action.action_class, checkpoints);
  const fingerprint = actionFingerprint(action);
  if (authorization !== null && authorization !== undefined && !validAuthorization(authorization)) {
    return route('refuse', 'deterministic', ['human_authorization_malformed'], 'policy_refused', action, checkpoints, controls, now);
  }
  const latest = new Map();
  for (const event of evidence) {
    if (!isObject(event) || !CONTROL_BY_ID.has(event.control_id)) continue;
    if (event.action_class !== action.action_class || event.action_fingerprint !== fingerprint) continue;
    latest.set(event.control_id, event);
  }

  if (action.operator_policy === 'refuse') {
    return route('refuse', 'deterministic', ['operator_policy_refuse'], 'policy_refused', action, checkpoints, controls, now);
  }
  if (authorization?.decision === 'refuse') {
    if (authorization.action_fingerprint !== fingerprint) {
      return route('refuse', 'deterministic', ['human_binding_mismatch'], 'policy_refused', action, checkpoints, controls, now);
    }
    return route('refuse', 'human', ['human_refused'], 'policy_refused', action, checkpoints, controls, now);
  }

  for (const control of controls) {
    const event = latest.get(control.control_id);
    const malformed = event && !validEvidenceEvent(event, control, action, fingerprint);
    if (!event || malformed) {
      const decision = control.failure_direction;
      const cause = decision === 'human_required' ? 'needs_human'
        : decision === 'refuse' ? 'policy_refused' : 'control_inconclusive';
      return route(decision, 'deterministic', [event ? 'control_evidence_malformed' : 'control_evidence_missing', control.control_id], cause, action, checkpoints, controls, now);
    }
    if (event.outcome === 'refused') {
      return route('refuse', 'deterministic', ['control_refused', control.control_id], event.cause || 'policy_refused', action, checkpoints, controls, now);
    }
    if (event.outcome === 'inconclusive') {
      const decision = control.failure_direction;
      const cause = decision === 'human_required' ? 'needs_human'
        : decision === 'refuse' ? 'policy_refused' : 'control_inconclusive';
      return route(decision, 'deterministic', ['control_inconclusive', control.control_id], event.cause || cause, action, checkpoints, controls, now);
    }
  }

  const needsAuthorization = highStakes(action) || action.operator_policy === 'ask';
  if (needsAuthorization) {
    if (authorization && authorization.action_fingerprint !== fingerprint) {
      return route('refuse', 'deterministic', ['human_binding_mismatch'], 'policy_refused', action, checkpoints, controls, now);
    }
    if (authorization?.decision !== 'approve') {
      return route('human_required', 'deterministic', ['stakes_require_human'], 'needs_human', action, checkpoints, controls, now);
    }
  }

  // A model may make the outcome more conservative. It can never lower a
  // deterministic refusal/human gate or authorize a high-stakes action.
  if (modelRecommendation && modelRecommendation !== 'auto') {
    const cause = modelRecommendation === 'human_required' ? 'needs_human'
      : modelRecommendation === 'refuse' ? 'policy_refused' : 'control_inconclusive';
    return route(modelRecommendation, 'model_escalation', ['model_escalation_only'], cause, action, checkpoints, controls, now);
  }
  return route('auto', authorization?.decision === 'approve' ? 'human' : 'deterministic', [
    authorization?.decision === 'approve' ? 'human_authorization_bound' : 'low_stakes_controls_passed',
  ], null, action, checkpoints, controls, now);
}

export function createControlRecorder({ now = () => Date.now() } = {}) {
  const actions = new Map();
  const events = [];
  const routes = [];
  const humanDecisions = [];
  const remember = (action) => {
    validateAction(action);
    actions.set(actionFingerprint(action), canonicalValue(action));
    return action;
  };
  return Object.freeze({
    remember,
    record(input) {
      const event = controlEvent({ ...input, action: remember(input.action), now: input.now ?? now() });
      events.push(event);
      return event;
    },
    authorize(action, decision, reason) {
      remember(action);
      const record = humanDecision(action, { decision, reason, now: now() });
      humanDecisions.push(record);
      return record;
    },
    evaluate(input) {
      const action = remember(input.action);
      const result = evaluateAction({ ...input, action, evidence: input.evidence ?? events, now: input.now ?? now() });
      routes.push(result);
      return result;
    },
    events() { return events.map((event) => canonicalValue(event)); },
    receipt() {
      return {
        schema_version: 1,
        control_plane_version: CONTROL_PLANE_VERSION,
        register_version: CONTROL_REGISTER.register_version,
        actions: [...actions.values()].map(canonicalValue),
        events: events.map(canonicalValue),
        routes: routes.map(canonicalValue),
        human_decisions: humanDecisions.map(canonicalValue),
      };
    },
  });
}
