// Thin CLI entry to the same config/qualification layer used by Studio.
import { listBackends, seatCatalog, saveConnectionBackend } from './models.mjs';
import { deepQualifyModel, expectedReportedFor } from './capability-probes.mjs';
import { isQualifiableTransport } from './admission.mjs';
import { createQualificationControl } from './control-plane.mjs';

export function configureCodeBackend(config, { replace = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some((key) => !['connectionName', 'connection', 'backendName', 'backend'].includes(key))) throw new Error('Setup needs connectionName, connection, backendName and backend only. Use env-var references, never credentials.');
  const saved = saveConnectionBackend({ ...config, replace });
  return { configured: true, backend: config.backendName, connection: config.connectionName, replaced: saved.replaced, qualified: false };
}

export async function qualifyCodeSeat({ backend, model, role, consent = false, onProgress }) {
  if (!consent) throw new Error('Qualification makes paid provider calls. Add --allow-provider-calls for this exact tuple.');
  if (!['maker', 'reviewer'].includes(role)) throw new Error('--role must be maker or reviewer.');
  const seat = (seatCatalog()[role] ?? []).find((s) => s.backend === backend && s.model === model);
  const entry = listBackends()[backend];
  if (!seat || entry?.kind !== 'openai_compat' || !isQualifiableTransport(entry.transport)) throw new Error('Choose a declared, supported hosted/self-hosted chat-completions tuple.');
  const control = createQualificationControl({ seat: role, backend, model, connection: entry.connection, transport: entry.transport, consentReason: 'CLI --allow-provider-calls for this exact tuple' });
  let finished = false;
  try {
    const result = await deepQualifyModel({ entry, model, seatType: role === 'maker' ? 'words_maker' : 'words_reviewer', expectedReported: expectedReportedFor(entry, seat, model), onProgress });
    finished = true; const governed = control.finish({ result });
    return { qualified: result.qualified, reason: result.reason, missing: result.missing ?? [], gating: false, controlRoute: governed.route };
  } catch (error) { if (!finished) control.finish({ error }); throw error; }
}
