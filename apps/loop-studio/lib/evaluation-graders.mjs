// Cheap, declarative graders for tracked model-evaluation cases. These run on
// the first maker artifact before an LLM reviewer is purchased. They are not a
// semantic quality score: a green result only means the mechanically checkable
// part of the case contract is satisfied.

const CHECK_TYPES = new Set([
  'word_count',
  'regex_count',
  'required_headings',
  'required_phrases',
  'forbidden_phrases',
]);

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value.map((entry, index) => nonempty(entry, `${field}[${index}]`));
}

function optionalBound(value, field) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export function validateEvaluationChecks(checks, field = 'deterministicChecks') {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error(`${field} must be a non-empty array`);
  const ids = new Set();
  for (const [index, check] of checks.entries()) {
    const at = `${field}[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error(`${at} must be an object`);
    const id = nonempty(check.id, `${at}.id`);
    if (ids.has(id)) throw new Error(`${field} ids must be unique`);
    ids.add(id);
    nonempty(check.label, `${at}.label`);
    if (!CHECK_TYPES.has(check.type)) throw new Error(`${at}.type is unsupported`);

    if (check.type === 'word_count') {
      const min = optionalBound(check.min, `${at}.min`);
      const max = optionalBound(check.max, `${at}.max`);
      if (min === null && max === null) throw new Error(`${at} needs min or max`);
      if (min !== null && max !== null && min > max) throw new Error(`${at}.min cannot exceed max`);
    } else if (check.type === 'regex_count') {
      const pattern = nonempty(check.pattern, `${at}.pattern`);
      if (pattern.length > 500) throw new Error(`${at}.pattern is too long`);
      if (check.flags !== undefined && (typeof check.flags !== 'string' || /[^imsu]/.test(check.flags))) {
        throw new Error(`${at}.flags may contain only i, m, s, or u`);
      }
      const min = optionalBound(check.min, `${at}.min`);
      const max = optionalBound(check.max, `${at}.max`);
      if (min === null && max === null) throw new Error(`${at} needs min or max`);
      if (min !== null && max !== null && min > max) throw new Error(`${at}.min cannot exceed max`);
      try { new RegExp(pattern, check.flags ?? ''); }
      catch (error) { throw new Error(`${at}.pattern is invalid: ${error.message}`); }
    } else if (check.type === 'required_headings') {
      stringList(check.headings, `${at}.headings`);
    } else if (check.type === 'required_phrases' || check.type === 'forbidden_phrases') {
      stringList(check.phrases, `${at}.phrases`);
      if (check.caseSensitive !== undefined && typeof check.caseSensitive !== 'boolean') {
        throw new Error(`${at}.caseSensitive must be boolean`);
      }
    }
  }
  return checks;
}

const words = (text) => String(text ?? '').trim().match(/\S+/g)?.length ?? 0;
const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function regexMatches(text, pattern, flags = '') {
  const safeFlags = [...new Set(`${flags}g`)].join('');
  return [...String(text ?? '').matchAll(new RegExp(pattern, safeFlags))].length;
}

function boundedResult(check, count) {
  const min = check.min ?? null;
  const max = check.max ?? null;
  const pass = (min === null || count >= min) && (max === null || count <= max);
  const expected = [min === null ? null : `at least ${min}`, max === null ? null : `at most ${max}`].filter(Boolean).join(' and ');
  return { pass, detail: `observed ${count}; expected ${expected}` };
}

function grade(text, check) {
  if (check.type === 'word_count') return boundedResult(check, words(text));
  if (check.type === 'regex_count') return boundedResult(check, regexMatches(text, check.pattern, check.flags));
  if (check.type === 'required_headings') {
    const observed = new Set(String(text ?? '').split(/\r?\n/)
      .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
      .filter(Boolean)
      .map(normalize));
    const missing = check.headings.filter((heading) => !observed.has(normalize(heading)));
    return { pass: missing.length === 0, detail: missing.length ? `missing headings: ${missing.join(', ')}` : `found ${check.headings.length} required headings` };
  }
  const caseSensitive = check.caseSensitive === true;
  const haystack = caseSensitive ? String(text ?? '') : String(text ?? '').toLowerCase();
  const phrases = check.phrases.map((phrase) => caseSensitive ? phrase : phrase.toLowerCase());
  if (check.type === 'required_phrases') {
    const missing = phrases.filter((phrase) => !haystack.includes(phrase));
    return { pass: missing.length === 0, detail: missing.length ? `missing phrases: ${missing.join(', ')}` : `found ${phrases.length} required phrases` };
  }
  const present = phrases.filter((phrase) => haystack.includes(phrase));
  return { pass: present.length === 0, detail: present.length ? `forbidden phrases present: ${present.join(', ')}` : `none of ${phrases.length} forbidden phrases found` };
}

export function runEvaluationChecks(text, checks) {
  validateEvaluationChecks(checks);
  const results = checks.map((check) => {
    const result = grade(text, check);
    return { id: check.id, label: check.label, status: result.pass ? 'pass' : 'fail', detail: result.detail };
  });
  return { pass: results.every((result) => result.status === 'pass'), checks: results };
}
