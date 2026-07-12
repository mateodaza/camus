// Redact-by-default (DIRECTION-0.3-TRUST-LAYER.md, adjustment 2).
//
// Corpus records come from real reviews of real repositories: they can carry
// secrets, user paths, proprietary identifiers. Ingestion scrubs by default;
// raw diffs require explicit inclusion and are absent from these receipts
// anyway. Scrubbing must be conservative — a false [REDACTED] costs a little
// context, a leaked credential costs trust.

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'api-key'],
  [/rk_(live|test)_[A-Za-z0-9]{16,}/g, 'stripe-key'],
  [/hm_k_[A-Za-z0-9]{8,}/g, 'hivemind-key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'github-token'],
  [/AKIA[0-9A-Z]{16}/g, 'aws-key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack-token'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, 'jwt'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/\b(?:bearer|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9._\/+-]{16,}['"]?/gi, 'credential-assignment'],
];

export function scrubSecrets(text) {
  let out = String(text);
  for (const [re, kind] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${kind}]`);
  return out;
}

// Home-directory paths carry usernames and machine layout.
export function scrubPaths(text) {
  return String(text)
    .replace(/\/Users\/[^\s/'"]+/g, '~')
    .replace(/\/home\/[^\s/'"]+/g, '~');
}

export function scrubText(text) {
  return scrubPaths(scrubSecrets(text));
}

// Applies scrubbing to every string field of a finding; drops raw-diff-like
// fields entirely unless explicitly included.
const RAW_FIELDS = ['diff', 'patch', 'raw_diff', 'hunk'];

export function redactFinding(finding, { includeRaw = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(finding)) {
    if (!includeRaw && RAW_FIELDS.includes(k)) continue;
    out[k] = typeof v === 'string' ? scrubText(v) : v;
  }
  return out;
}
