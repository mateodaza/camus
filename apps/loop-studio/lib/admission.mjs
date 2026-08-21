// Server-owned Slice C admission and presentation. The declaration catalog says
// what an operator configured; this layer says which exact tuples may be chosen
// now. The browser receives the result but grants nothing itself.

import { listBackends, seatCatalog } from './models.mjs';
import { qualificationForSeat } from './identity.mjs';
import { storedSeatQualification } from './capability-probes.mjs';
import { providerTemplates, plannedProtocols } from './provider-templates.mjs';

const SEAT_TYPE = Object.freeze({ maker: 'words_maker', reviewer: 'words_reviewer' });

const transportLabel = (value) => ({
  vendor_managed: 'managed',
  loopback: 'local',
  direct_https: 'https',
  ssh_tunnel: 'ssh',
  legacy_http: 'legacy http',
}[value] ?? String(value || 'unknown').replace(/_/g, ' '));

const operatorLabel = (value) => value === 'self_hosted'
  ? 'self-hosted'
  : String(value || 'unknown').replace(/^gateway:/, 'gateway:');

function originLabel(entry) {
  const family = entry.modelFamily || 'unknown origin';
  const source = entry.lineage?.source;
  if (source === 'operator_declared') return `${family} · declared`;
  if (source === 'registry') return `${family} · registry`;
  return `${family} · unknown`;
}

export function seatBadges(entry, { discoveryStatus = null } = {}) {
  const badges = [
    { kind: 'origin', label: originLabel(entry) },
    { kind: 'operator', label: operatorLabel(entry.inferenceOperator) },
    { kind: 'transport', label: transportLabel(entry.transport) },
  ];
  if (discoveryStatus && discoveryStatus !== 'not_recorded') {
    badges.push({ kind: 'discovery', label: String(discoveryStatus).replace(/_/g, ' ') });
  }
  return badges;
}

function statusFor(result) {
  if (result.qualified) return 'demonstrated';
  if (result.reason === 'requirements_unmet') return 'failed';
  return 'unprobed';
}

function reasonFor(result, seatType, entry) {
  const label = `${entry.backend}:${entry.model}`;
  if (result.qualified) return `${label} is qualified for exactly ${seatType}`;
  if (result.reason === 'missing') return `${label} has not been probed for ${seatType}`;
  if (result.reason === 'requirements_unmet') return `${label} failed required rows: ${(result.missing ?? []).join(', ') || 'unknown'}`;
  if (result.reason === 'expired') return `${label}'s ${seatType} receipt expired`;
  if (result.reason === 'voided') return `${label}'s receipt no longer matches ${result.component || 'the live tuple'}`;
  if (result.reason === 'missing_credential') return `${label} needs the declared credential environment variable before qualification`;
  if (result.reason === 'unsupported_transport') return `${label} uses a transport outside Slice C`;
  if (result.reason === 'unparseable') return `${label}'s qualification receipt is unreadable`;
  return `${label} is not qualified for ${seatType}: ${result.reason || 'unknown reason'}`;
}

function qualifyEntry(entry, backend, seatType, now) {
  const builtin = (entry.backend === 'claude' || entry.backend === 'codex')
    && entry.transport === 'vendor_managed';
  if (builtin) {
    const qualification = qualificationForSeat({ backend: entry.backend, transport: entry.transport });
    return {
      ...entry,
      admission: {
        qualified: true,
        status: 'demonstrated',
        state: 'builtin',
        seatType,
        fingerprint: qualification.fingerprint,
        expiresAt: null,
        discoveryStatus: 'not_applicable',
        qualifiable: false,
        reason: 'vendor-managed built-in contract',
        warning: `Built-in ${entry.backend}:${entry.model} is admitted by its versioned vendor-managed contract.`,
      },
      presentation: { badges: seatBadges(entry) },
    };
  }
  const result = storedSeatQualification({ entry: backend, model: entry.model, seatType, now });
  const discoveryStatus = result.receipt?.probeResults?.discoveryStatus ?? 'not_recorded';
  const reason = reasonFor(result, seatType, entry);
  const qualifiable = backend?.kind === 'openai_compat'
    && ['loopback', 'direct_https'].includes(backend.transport);
  return {
    ...entry,
    admission: {
      qualified: result.qualified === true,
      status: statusFor(result),
      state: result.reason,
      seatType,
      fingerprint: result.fingerprint ?? null,
      expiresAt: result.receipt?.expiresAt ?? null,
      discoveryStatus,
      capabilities: result.receipt?.capabilities ?? null,
      missing: result.missing ?? [],
      component: result.component ?? null,
      qualifiable,
      reason,
      warning: result.qualified
        ? `${reason}. Launch rechecks currently observable server anchors and refuses drift.`
        : `Not launchable: ${reason}. Qualify this exact tuple before selecting it.`,
    },
    presentation: { badges: seatBadges(entry, { discoveryStatus }) },
  };
}

export function admissionCatalog({ now = Date.now() } = {}) {
  const declared = seatCatalog();
  const backends = listBackends();
  const entries = (seatKey) => declared[seatKey].map((entry) =>
    qualifyEntry(entry, backends[entry.backend], SEAT_TYPE[seatKey], now));
  return {
    ...declared,
    maker: entries('maker'),
    reviewer: entries('reviewer'),
    templates: providerTemplates(),
    plannedProtocols: plannedProtocols.map((entry) => ({ ...entry })),
  };
}

export function admittedSeat(catalogEntries, backend, model) {
  return (catalogEntries ?? []).find((entry) =>
    entry.backend === backend && entry.model === model && entry.admission?.qualified === true) ?? null;
}

export function pairingPresentation({ maker, reviewer } = {}) {
  if (!maker || !reviewer) {
    return { launchable: false, standing: 'unavailable', note: 'Choose one admitted maker and one admitted auditor.', makerBadges: [], reviewerBadges: [] };
  }
  const blockers = [
    maker.admission?.qualified === false ? `maker ${maker.backend}:${maker.model}` : null,
    reviewer.admission?.qualified === false ? `auditor ${reviewer.backend}:${reviewer.model}` : null,
  ].filter(Boolean);
  if (blockers.length) {
    return {
      launchable: false,
      standing: 'unavailable',
      note: `${blockers.join(' and ')} ${blockers.length === 1 ? 'is' : 'are'} not qualified for this exact seat tuple.`,
      makerBadges: maker.presentation?.badges ?? seatBadges(maker),
      reviewerBadges: reviewer.presentation?.badges ?? seatBadges(reviewer),
    };
  }
  const unknown = [maker, reviewer].some((entry) =>
    entry.trainingOrg === 'unknown' || entry.modelFamily === 'unknown' || entry.lineage?.source === 'unknown');
  let standing;
  let note;
  if (unknown) {
    standing = 'same_vendor_advisory';
    note = 'At least one seat has unknown training lineage. The review is admitted but its standing remains advisory.';
  } else if (maker.trainingOrg === reviewer.trainingOrg) {
    standing = 'same_vendor_advisory';
    note = `Both seats trace to ${maker.trainingOrg}. The review is recorded as same-organization advisory, never independent.`;
  } else if (maker.lineage?.source === 'registry' && reviewer.lineage?.source === 'registry') {
    standing = 'cross_vendor';
    note = `Registry-backed cross-organization pairing: ${maker.trainingOrg} makes it; ${reviewer.trainingOrg} audits it.`;
  } else {
    standing = 'cross_vendor_declared';
    note = `Cross-organization as configured: ${maker.trainingOrg} makes it; ${reviewer.trainingOrg} audits it. The receipt says operator-declared, not registry-backed.`;
  }
  return {
    launchable: true,
    standing,
    note,
    makerBadges: maker.presentation?.badges ?? seatBadges(maker),
    reviewerBadges: reviewer.presentation?.badges ?? seatBadges(reviewer),
  };
}
