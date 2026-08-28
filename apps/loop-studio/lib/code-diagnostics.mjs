// Candidate output is untrusted input. Keep a small redacted diagnostic, never
// a raw transcript or executable instruction. Completeness is explicit.
export function redactCodeText(value, { secrets = [], roots = [] } = {}) {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:sk|rk|pk|fc|ghp|gho|github_pat)[-_][A-Za-z0-9._~+/=-]{6,}/g, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*["']?\s*[:=]\s*)[^\s,}\n]+/gi, '$1[redacted]');
  for (const root of roots) if (root) text = text.split(root).join('<workspace>');
  return text.replace(/(?:\/Users\/|\/home\/)[^\s:()"']+/g, '<private-path>');
}

export function diagnosticSecrets(env = process.env) {
  return Object.entries(env).filter(([name]) => /key|token|password|secret|credential|authorization/i.test(name)).map(([, value]) => value);
}

export function verificationDiagnostics(output, { exitCode, incomplete = false, secrets = [], roots = [] } = {}) {
  const redacted = redactCodeText(output, { secrets, roots });
  const lines = redacted.split(/\r?\n/).filter((line) => line.trim());
  const relevant = lines.filter((line) => /error|fail|assert|expected|actual|not ok|exception|\.\w+:\d+/i.test(line));
  const selected = (relevant.length ? relevant : lines).slice(0, 30);
  const location = redacted.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/m);
  return { version: 1, untrusted: true, classification: [126, 127].includes(exitCode) ? 'environment' : 'check_failure',
    location: location && !location[1].startsWith('/') && !location[1].split('/').includes('..') ? { path: location[1].slice(0, 256), line: Number(location[2]) } : null,
    check: selected.find((line) => /^(?:not ok|FAIL|Error:|AssertionError)/i.test(line.trim()))?.slice(0, 200) ?? null,
    message: selected.join('\n').slice(0, 6000),
    complete: !incomplete && selected.length === lines.length && selected.join('\n').length <= 6000,
    outputRetained: false };
}
