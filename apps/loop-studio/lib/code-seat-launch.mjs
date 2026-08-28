// Shared CLI/Build launch policy. Text-transport qualification is not coding
// reviewer admission: the independent code loop always stops for acceptance.
import { getModels, listBackends, EFFORTS } from './models.mjs';
import { admissionCatalog, admittedSeat, pairingPresentation } from './admission.mjs';
import { seatQualification } from './capability-probes.mjs';
import { resolveSeatAdapters } from './adapters/registry.mjs';

export function codeSeatSnapshot(entry, effort = null) {
  return {
    backend: entry.backend, provider: entry.provider, model: entry.model,
    executor: entry.executor, transport: entry.transport,
    connection: entry.connection ?? null, protocol: entry.protocol,
    trainingOrg: entry.trainingOrg, modelFamily: entry.modelFamily,
    inferenceOperator: entry.inferenceOperator, originConfidence: entry.originConfidence,
    lineage: { source: entry.lineage?.source ?? 'unknown', derivedFrom: entry.lineage?.derivedFrom ?? null },
    ...(entry.expectedReported !== undefined ? { expectedReported: structuredClone(entry.expectedReported) } : {}),
    ...(effort ? { effort } : {}),
    source: 'independent code seat selection',
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

export async function prepareCodeSeats({ pairing = null, live = true } = {}, dependencies = {}) {
  const catalog = (dependencies.catalog ?? admissionCatalog)();
  const standing = (dependencies.models ?? getModels)();
  // No await occurs until BOTH decisions AND their connection definitions have
  // been captured. A concurrent Settings edit cannot substitute an endpoint.
  const definitions = (dependencies.backends ?? listBackends)();
  const models = { maker: null, reviewer: null, loop: { ...standing.loop } };
  const frozenBackends = {};
  for (const role of ['maker', 'reviewer']) {
    const selected = pairing ? pairing[role] : standing[role];
    if (!selected || typeof selected.backend !== 'string' || typeof selected.model !== 'string') {
      throw new Error(`Choose ${role} as an explicit backend and model.`);
    }
    const entry = admittedSeat(catalog[role], selected.backend, selected.model);
    if (!entry) throw new Error(`${role} ${selected.backend}:${selected.model} is unavailable or not qualified for this seat. Configure and qualify it in Studio; no substitution was made.`);
    const backend = definitions[entry.backend];
    if (!backend || !backend.seats?.includes(role)) throw new Error(`The selected ${role} backend cannot execute this seat.`);
    const requestedEffort = selected.effort;
    if (requestedEffort != null && !EFFORTS.includes(requestedEffort)) throw new Error(`${role} effort must be low, medium, high, or xhigh.`);
    if (requestedEffort != null && !entry.effort) throw new Error(`${role} ${entry.backend} does not honor an effort setting.`);
    models[role] = codeSeatSnapshot(entry, entry.effort ? requestedEffort ?? standing[role]?.effort ?? 'medium' : null);
    frozenBackends[role] = clone(backend);
    if (entry.admission?.fingerprint) models[role].qualification = {
      fingerprint: entry.admission.fingerprint,
      seatType: role === 'maker' ? 'words_maker' : 'words_reviewer',
    };
  }
  for (const role of ['maker', 'reviewer']) {
    const backend = frozenBackends[role];
    if (backend.kind !== 'openai_compat') continue;
    if (live) {
      const seatType = role === 'maker' ? 'words_maker' : 'words_reviewer';
      const qualification = await (dependencies.qualify ?? seatQualification)({ entry: backend, model: models[role].model, seatType });
      if (!qualification.qualified || qualification.fingerprint !== models[role].qualification?.fingerprint) {
        throw new Error(`${role} qualification changed or is unavailable; qualify the exact selected tuple again.`);
      }
    }
  }
  const presentation = pairingPresentation(models);
  return {
    models, frozenBackends,
    pairingView: { ...presentation, gating: false, experimental: true,
      note: `${presentation.note} Code feedback is experimental and non-gating. Human acceptance is required; nothing is committed, merged, or published.` },
    adapters: live ? (dependencies.resolve ?? resolveSeatAdapters)(models, frozenBackends) : null,
  };
}

export function codeModelChoices(catalog = admissionCatalog()) {
  const safe = (entry) => ({
    backend: entry.backend, model: entry.model, provider: entry.provider,
    transport: entry.transport, trainingOrg: entry.trainingOrg,
    available: entry.admission?.qualified === true,
    reason: entry.admission?.reason ?? 'unknown',
    effort: entry.effort === true,
  });
  return { maker: catalog.maker.map(safe), reviewer: catalog.reviewer.map(safe), gating: false };
}
