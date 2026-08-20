// The pure lineage-derivation engine (docs/OPEN-MODEL-SEATS-RFC.md §6.1, §6.2,
// §9.1, §10 rules 1-4/7, §10.8.1). Nothing in the running app imports this yet —
// it is purely additive, following the lib/*.mjs "pure module + full unit test"
// shape. `lineage.source` is DERIVED here, never configured: config carries only
// the operator's org/family DECLARATIONS and the tier is computed about them.
//
// Config (the tracked registry) is resolved PER CALL, never at import, so a
// reviewed edit to checks/registry.json takes effect without a restart and tests
// can point STUDIO_REGISTRY_FILE at a fixture. Zero new deps.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The operator↔org/family registry is a PUBLIC TRACKED DEFAULT, reviewed like
// any other tracked file and pinned by the identity unit test. There is no
// mutable operator copy: a registry row is a claim Camus ships and stands behind.
const defaultRegistryPath = () => join(__dirname, '..', 'checks', 'registry.json');
const registryPath = () => process.env.STUDIO_REGISTRY_FILE || defaultRegistryPath();

function readRegistry() {
  return JSON.parse(readFileSync(registryPath(), 'utf8'));
}

// The ONLY isolation flag, a static per-executor constant (§9.1). Both built-in
// executors are now proven isolated. codex_cli's hardened spawn uses a scrubbed
// allowlist environment + --ignore-user-config. claude_cli (Task 9) spawns BOTH
// the maker and reviewer seats with claudeDirectEnv() — a fresh default-deny
// environment that copies only a closed credential pass-set and always asserts
// host-owned routing/memory — plus an unconditional empty --setting-sources, so
// an inherited ANTHROPIC_BASE_URL (or any redirect var) can no longer re-point
// it. That flip is justified by the green lib/adapters/claude.test.mjs isolation
// acceptance test; never edit this table without such a proof.
const REDIRECT_ISOLATION = Object.freeze({ codex_cli: true, claude_cli: true });
export function redirectIsolationProven(executorKind) {
  return REDIRECT_ISOLATION[executorKind] === true;
}

// host exact-match AND modelId matches the row's modelIdPattern regex.
export function lookupEndpoint(host, modelId) {
  const { endpoints } = readRegistry();
  for (const row of endpoints ?? []) {
    if (row.host === host && new RegExp(row.modelIdPattern).test(String(modelId ?? ''))) {
      return { org: row.org, family: row.family };
    }
  }
  return null;
}

export function executorOrgFamily(executorKind) {
  const { executors } = readRegistry();
  // Own-property only: an inherited name like 'constructor' must miss, never
  // resolve to a prototype member.
  const row = executors && Object.hasOwn(executors, executorKind) ? executors[executorKind] : undefined;
  return row ? { org: row.org, family: row.family } : null;
}

export function familyOrg(family) {
  const { families } = readRegistry();
  // Own-property only: 'toString'/'constructor' must return null, not a
  // native prototype value.
  return families && Object.hasOwn(families, family) ? families[family] : null;
}

// The §9.1 ladder, evaluated in exact order. `declared` carries only operator
// declarations ({ org, family, derivedFrom? }); a `declared.source` is a config
// attempt to grant the derived tier and is refused outright.
export function deriveLineageSource({
  executorKind,
  transport,
  connectionKind,
  endpointHost,
  modelId,
  declared,
  camusInjectedRedirect,
} = {}) {
  // (a) source is derived, never configured. PRESENCE of the key is forbidden —
  //     even `{ source: null }` — because the tier must never be configurable.
  if (declared && Object.hasOwn(declared, 'source')) {
    throw new Error('lineage.source is derived, never configured; remove it');
  }

  // (b) endpoint branch: a direct_https connection, OR Camus's own base-URL
  //     injection (Kimi-via-claude_cli), which routes here regardless of the
  //     vendor_managed flag. A registry row that CONTRADICTS a declaration
  //     refuses — neither wins silently.
  if (connectionKind === 'direct_https' || camusInjectedRedirect === true) {
    const row = lookupEndpoint(endpointHost, modelId);
    if (row) {
      const orgConflict = declared && declared.org && declared.org !== row.org;
      const familyConflict = declared && declared.family && declared.family !== row.family;
      if (orgConflict || familyConflict) {
        throw new Error(
          `declared ${declared.org}/${declared.family} contradicts registry ${row.org}/${row.family} for ${endpointHost}`,
        );
      }
      return 'registry';
    }
  }

  // (c) built-in default backend: a connection-less built-in (claude/codex)
  //     reaches this via its executor kind. Requires the registry to know the
  //     executor AND its redirect isolation to be mechanically proven — so
  //     codex_cli derives 'registry' now, claude_cli only after Task 9's flip.
  //     A Camus-injected redirect is NOT connection-less, so it never lands here.
  if (transport === 'vendor_managed' && camusInjectedRedirect !== true) {
    const ex = executorOrgFamily(executorKind);
    if (ex && redirectIsolationProven(executorKind) === true) return 'registry';
  }

  // (d) the operator's own declaration (all loopback/ssh_tunnel/legacy_http/
  //     gateway cases, AND any vendor_managed built-in whose isolation is not
  //     yet proven — e.g. claude_cli before the flip).
  if (declared && declared.org && declared.family) return 'operator_declared';

  // (e) nothing declared — a pre-existing free-text-provider custom backend with
  //     no declarations and no connection lands here.
  return 'unknown';
}

// origin_confidence derives from lineage.source (§10 rule 4).
export function originConfidence(source) {
  if (source === 'registry') return 'verified_operator';
  if (source === 'operator_declared') return 'operator_declared';
  return 'unknown';
}

// Confidence lattice, low -> high; anything off-ladder (missing, misspelt) is
// unknown. `weakerConfidence` returns the LOWER of two confidences so a bad or
// absent input can only ever fail toward the lower tier, never promote.
const CONFIDENCE_RANK = { unknown: 0, operator_declared: 1, verified_operator: 2 };
function confidenceRank(c) {
  return Object.hasOwn(CONFIDENCE_RANK, c) ? CONFIDENCE_RANK[c] : 0;
}
function weakerConfidence(a, b) {
  return confidenceRank(a) <= confidenceRank(b) ? normalizeConfidence(a) : normalizeConfidence(b);
}
function normalizeConfidence(c) {
  return Object.hasOwn(CONFIDENCE_RANK, c) ? c : 'unknown';
}

// A declared derivation names another family (an open distillation/fine-tune),
// so family overlap through derivation is recordable, not invisible (§6.1/§10).
function familiesShareLineage(a, b) {
  if (a.modelFamily === b.modelFamily) return true;
  const ad = a.lineage?.derivedFrom;
  const bd = b.lineage?.derivedFrom;
  if (ad && ad === b.modelFamily) return true;
  if (bd && bd === a.modelFamily) return true;
  if (ad && bd && ad === bd) return true;
  return false;
}

// §10 rules 1-4 & 7, fail-toward-lower. Each side =
// { trainingOrg, modelFamily, lineage:{source,derivedFrom}, originConfidence }.
export function deriveIndependence({ maker, reviewer } = {}) {
  const sides = [maker, reviewer];
  // Rule 2: any unknown org / family / lineage.source on either side fails the
  // pair closed to advisory. Unknown never grades up.
  for (const s of sides) {
    if (!s) return 'same_vendor';
    if (!s.trainingOrg || s.trainingOrg === 'unknown') return 'same_vendor';
    if (!s.modelFamily || s.modelFamily === 'unknown') return 'same_vendor';
    const src = s.lineage?.source;
    if (!src || src === 'unknown') return 'same_vendor';
  }
  // Rule 1: the organization axis dominates the family axis — equal trainingOrg
  // is advisory whatever the family split says (gpt + gpt_oss share openai).
  if (maker.trainingOrg === reviewer.trainingOrg) return 'same_vendor';
  // Rule 1: shared family lineage collapses to advisory against that base family.
  if (familiesShareLineage(maker, reviewer)) return 'same_vendor';

  // Cross-organization from here. Each side's effective confidence is the WEAKER
  // of (a) the confidence derived from its lineage.source and (b) any supplied
  // originConfidence field. A missing/unknown/invalid supplied field is treated
  // as unknown, so it can only fail the pair toward the lower tier — an absent or
  // forged originConfidence can never promote a pair above what its source earns.
  const mc = weakerConfidence(originConfidence(maker.lineage?.source), maker.originConfidence);
  const rc = weakerConfidence(originConfidence(reviewer.lineage?.source), reviewer.originConfidence);
  if (mc === 'verified_operator' && rc === 'verified_operator') return 'cross_vendor';
  // Rule 4: at least one side is operator_declared and NEITHER side is unknown ->
  // cross-vendor as configured. An unknown effective confidence on either side
  // fails the pair closed to same_vendor; it must never be upgraded by the other
  // side being operator_declared.
  if (mc !== 'unknown' && rc !== 'unknown' &&
      (mc === 'operator_declared' || rc === 'operator_declared')) {
    return 'cross_vendor_declared';
  }
  return 'same_vendor';
}

// §6.2: normally exactly { resolvedModel }; an operator-documented mapping
// endpoint adds the declared aliases (the injected claude-* names plus the
// mapped id). `reported` outside this set is an unexpected substitution.
export function expectedReportedSet(seat = {}) {
  const set = new Set();
  if (seat.resolvedModel) set.add(seat.resolvedModel);
  if (Array.isArray(seat.aliases)) {
    for (const alias of seat.aliases) if (alias) set.add(alias);
  }
  return set;
}

// §10.8.1: pure assembly of the sealed record from an ALREADY-DERIVED seat. This
// does NOT recompute lineage — deriveLineageSource ran earlier and its result
// arrives on the seat; re-deriving here would let a seal disagree with the load.
export function buildSeatIdentitySealed(seat = {}) {
  return {
    requested: seat.requested,
    resolved: seat.resolved,
    actual: seat.actual,
    reported: seat.reported ?? null,
    actual_evidence: seat.actualEvidence,
    executor_kind: seat.executorKind,
    training_org: seat.trainingOrg,
    model_family: seat.modelFamily,
    lineage: {
      source: seat.lineage?.source,
      derived_from: seat.lineage?.derivedFrom ?? null,
    },
    inference_operator: seat.inferenceOperator,
    transport: seat.transport,
    connection: seat.connection ?? null,
    origin_confidence: seat.originConfidence,
    qualification: seat.qualification,
  };
}
