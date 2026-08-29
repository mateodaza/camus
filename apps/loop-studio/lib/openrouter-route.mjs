// Closed OpenRouter upstream-routing contract. OpenRouter's public API names
// providers with copyable slugs (including endpoint variants such as
// `deepinfra/fp4`). A configured route is therefore an exact operator decision,
// never a best-effort preference or a list that Camus is allowed to widen.

const PROVIDER_SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,63})(?:\/[a-z0-9](?:[a-z0-9._-]{0,63}))*$/;
const ROUTE_KEYS = new Set(['upstreamProvider', 'allowFallbacks']);

export function normalizeOpenRouterRoute(entry, label = `backends.${entry?.name ?? 'unknown'}`) {
  const route = entry?.route;
  if (entry?.provider !== 'openrouter') {
    if (route !== undefined) throw new Error(`${label}.route is valid only when provider is "openrouter"`);
    return null;
  }
  if (!route || typeof route !== 'object' || Array.isArray(route)
      || (Object.getPrototypeOf(route) !== Object.prototype && Object.getPrototypeOf(route) !== null)) {
    throw new Error(`${label}.route must pin one exact OpenRouter upstream provider`);
  }
  const unknown = Object.keys(route).filter((key) => !ROUTE_KEYS.has(key));
  if (unknown.length) throw new Error(`${label}.route has unsupported field(s): ${unknown.join(', ')}`);
  if (typeof route.upstreamProvider !== 'string' || route.upstreamProvider.length > 128
      || !PROVIDER_SLUG.test(route.upstreamProvider)) {
    throw new Error(`${label}.route.upstreamProvider must be one exact lowercase OpenRouter provider slug`);
  }
  if (route.allowFallbacks !== false) {
    throw new Error(`${label}.route.allowFallbacks must be explicitly false`);
  }
  return { upstreamProvider: route.upstreamProvider, allowFallbacks: false };
}

export function openRouterRequestControls(entry) {
  const route = normalizeOpenRouterRoute(entry, `backend "${entry?.name ?? 'unknown'}"`);
  if (!route) return { headers: {}, body: {} };
  const slug = route.upstreamProvider;
  return {
    headers: { 'X-OpenRouter-Metadata': 'enabled' },
    body: { provider: { only: [slug], order: [slug], allow_fallbacks: false } },
  };
}

export function openRouterRouteIdentity(entry, label = `backend "${entry?.name ?? 'unknown'}"`) {
  const route = normalizeOpenRouterRoute(entry, label);
  return route ? `${route.upstreamProvider};fallbacks=false` : 'absent';
}

const comparableProvider = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Router metadata deliberately reports a provider display NAME while routing
// preferences accept a provider SLUG. Compare the base slug (before any exact
// endpoint suffix) to that display name after punctuation/case normalization.
// The exact suffix remains enforced by OpenRouter's documented only/order
// contract; the metadata schema does not expose the selected endpoint slug.
export function verifyOpenRouterMetadata(entry, metadata) {
  const route = normalizeOpenRouterRoute(entry, `backend "${entry?.name ?? 'unknown'}"`);
  if (!route) return null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('OpenRouter response omitted required routing metadata; cache replay and unverified routing are refused.');
  }
  if (metadata.attempt !== 1) {
    throw new Error('OpenRouter response contradicted the single-attempt pinned route.');
  }
  if (metadata.strategy !== 'direct') {
    throw new Error('OpenRouter response did not use the required direct routing strategy.');
  }
  const selected = Array.isArray(metadata.endpoints?.available)
    ? metadata.endpoints.available.filter((endpoint) => endpoint?.selected === true)
    : [];
  if (selected.length !== 1 || typeof selected[0].provider !== 'string' || !selected[0].provider) {
    throw new Error('OpenRouter response did not identify exactly one selected upstream provider.');
  }
  const expectedBase = route.upstreamProvider.split('/')[0];
  if (comparableProvider(selected[0].provider) !== comparableProvider(expectedBase)) {
    throw new Error('OpenRouter selected upstream provider did not match the pinned route.');
  }
  return {
    attempt: metadata.attempt,
    strategy: metadata.strategy,
    selectedProvider: selected[0].provider,
    requested: typeof metadata.requested === 'string' ? metadata.requested : null,
  };
}
