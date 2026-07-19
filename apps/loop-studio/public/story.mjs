// The run story: what happened, in the language a marketer speaks, DERIVED from
// the sealed receipt at render time and never stored. Same discipline as
// banner.mjs — one file owns the rules, pinned verbatim in verify.test.mjs.
//
// Two hard rules, because this card is the most persuasive surface in the app:
//   1. Every sentence must be entailed by evidence in the receipt. A beat with
//      no evidence is reported as unknown, never narrated into existence.
//   2. Missing dimensions FAIL CLOSED. A receipt that cannot corroborate its own
//      story says so, exactly as the done banner does.

const PROVIDER_NAMES = { anthropic: 'Claude', openai: 'GPT', google: 'Gemini', simulation: 'A scripted stand-in' };

const providerName = (identity) => {
  const provider = String(identity ?? '').split(':')[0];
  return PROVIDER_NAMES[provider] ?? (provider && provider !== 'unknown' ? provider : null);
};

const countWord = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const plural = (n, word) => `${countWord(n)} ${word}${n === 1 ? '' : 's'}`;
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Finding identity, matching the loop's own stuck-detection: the SAME finding
// re-raised across rounds is one issue, not several. Counting instances would
// inflate "how much did the reviewer catch" — the exact overstatement this card
// exists to avoid.
const findingKey = (f) => String(f?.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const distinctBlocking = (rounds) => new Set(
  rounds.flatMap((r) => (r.findings ?? []).filter((f) => f.severity !== 'low')).map(findingKey).filter(Boolean),
);
const repeatedBlocking = (rounds) => {
  const counts = new Map();
  for (const round of rounds) {
    for (const finding of round.findings ?? []) {
      if (finding.severity === 'low') continue;
      const key = findingKey(finding);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()].some((count) => count > 1);
};

export const STORY_BEATS = ['Brief', 'Evidence frozen', 'Draft', 'Independent challenge', 'Human decision', 'Verification', 'Sealed receipt'];

// The one standing vocabulary. Every surface that shows a standing reads it from
// here, so the run bar, Recents and the story card can never word the same
// receipt three different ways. An unrecognised standing has NO label on
// purpose: callers must fail closed rather than print a raw token as if it were
// a verdict.
const STANDING_LABELS = {
  verified: 'Verified',
  verified_with_findings: 'Verified with findings',
  same_vendor_reviewed: 'Reviewed by the same vendor',
  published: 'Verified and published',
  unverified: 'Not verified',
  needs_decision: 'Needs a decision',
  rehearsal: 'Rehearsal',
};
export const standingLabel = (headline) => STANDING_LABELS[headline] ?? null;
// The raw rehearsal fact outranks a missing or stale decorated headline. This
// keeps legacy mock replays honest even when their old terminal event predates
// dimensions/headline decoration.
export const effectiveStanding = (headline, simulated = false) => simulated ? 'rehearsal' : headline;

const STANDING_TONES = {
  verified: 'trusted',
  verified_with_findings: 'trusted',
  published: 'trusted',
  same_vendor_reviewed: 'advisory',
  unverified: 'danger',
  needs_decision: 'danger',
  rehearsal: 'rehearsal',
};
const OPERATIONAL_STATUSES = new Set(['running', 'needs_human', 'disconnected', 'incomplete']);

// Text and semantic tone travel together. Otherwise a receipt-derived
// "Not verified" can accidentally inherit the success styling of the loop's
// underlying `done` claim, which is worse than showing two labels.
export function standingPill(status, headline) {
  const label = standingLabel(headline);
  if (label) return { label, className: `standing ${STANDING_TONES[headline]}`, derived: true, claim: false };

  const token = String(status ?? 'unknown');
  const operational = OPERATIONAL_STATUSES.has(token);
  return {
    label: token.replace(/_/g, ' '),
    className: `status ${token}${operational ? '' : ' claim'}`,
    derived: false,
    claim: !operational,
  };
}

// A standing the receipt corroborates, versus the flat status the loop claimed.
// They are different facts and may disagree — that disagreement is the whole
// reason the trust layer exists, so it is surfaced rather than smoothed over.
const GATE_CLAIM_SUCCESS = new Map([
  ['done', true],
  ['done_with_findings', true],
  ['verify_failed', false],
  ['stopped', false],
  ['failed', false],
]);
const STANDING_SUCCESS = new Map([
  ['verified', true],
  ['verified_with_findings', true],
  ['published', true],
  ['same_vendor_reviewed', false],
  ['unverified', false],
  ['needs_decision', false],
]);

const DIMENSION_PROSE = {
  execution: {
    completed: 'The run reached its own end.',
    interrupted: 'The run was interrupted before it finished.',
    running: 'The run had not finished.',
  },
  verification: {
    passed: 'The deterministic checks passed.',
    passed_with_caveats: 'The deterministic checks passed, with caveats recorded.',
    failed: 'The deterministic checks did not pass.',
    not_run: 'The deterministic checks never ran.',
    infra_failed: 'The deterministic checks broke before they could decide.',
  },
  audit: {
    independent_clean: 'A reviewer from a different vendor found nothing blocking.',
    independent_findings: 'A reviewer from a different vendor found issues, recorded here.',
    advisory_clean: 'The review shared the maker’s vendor, so it is advisory only.',
    advisory_findings: 'The review shared the maker’s vendor, so its findings are advisory only.',
    not_run: 'No independent review ran.',
    infra_failed: 'The review broke before it could reach a verdict.',
  },
  publication: {
    not_published: 'Nothing was published.',
    published: 'The artifact was published.',
  },
};

// Layer-2 answer to "why this standing?": the dimensions it was derived from,
// the loop's own claim beside it, and an explicit warning when they conflict.
export function standingExplanation(report, headline) {
  const dims = report?.evidencePack?.statuses ?? report?.statuses ?? null;
  const gateClaim = report?.status ?? null;
  if (!dims || dims.schemaVersion !== 1) {
    return {
      gateClaim,
      standing: standingLabel(headline),
      disagrees: false,
      lines: ['This receipt carries no status dimensions this version recognises, so the standing above cannot be derived from evidence. Read the raw trail.'],
    };
  }
  const lines = ['execution', 'verification', 'audit', 'publication']
    .map((dim) => DIMENSION_PROSE[dim]?.[dims[dim]] ?? `The ${dim} dimension reads “${String(dims[dim] ?? 'unknown').replace(/_/g, ' ')}”, which this view does not recognise.`);
  // Rehearsal is orthogonal, not a contradiction: the scripted loop may finish
  // successfully while still earning no trust standing. For real terminal
  // runs, catch disagreement in BOTH directions (including a red gate claim
  // paired with an implausibly green receipt-derived standing).
  const gateSuccess = GATE_CLAIM_SUCCESS.get(gateClaim);
  const standingSuccess = STANDING_SUCCESS.get(headline);
  const successDisagrees = gateSuccess != null && standingSuccess != null && gateSuccess !== standingSuccess;
  // `done_with_findings` also makes a narrower factual claim. A clean receipt
  // cannot silently erase it just because both labels sit on the success side
  // of the coarse trust boundary. `done` makes no corresponding clean claim,
  // so it remains compatible with a receipt that records caveats.
  const receiptCarriesFindings = dims.verification === 'passed_with_caveats'
    || dims.audit === 'independent_findings'
    || dims.audit === 'advisory_findings';
  const findingsDisagree = gateClaim === 'done_with_findings'
    && standingSuccess === true
    && !receiptCarriesFindings;
  const disagrees = successDisagrees || findingsDisagree;
  return { gateClaim, standing: standingLabel(headline), disagrees, lines };
}

// state: done (it happened) | skipped (legitimately did not apply) | failed
// (it happened and did not pass) | unknown (the receipt cannot say)
function beatStates(report, pack) {
  const evidence = report?.evidence ?? {};
  const dims = pack?.statuses ?? report?.statuses ?? null;
  const grounding = evidence.grounding ?? null;
  const rounds = evidence.rounds ?? [];
  const decisions = evidence.humanDecisions ?? [];
  const replay = report?.lane === 'audit_replay' && !!report?.sourceRunId;

  const groundState = replay
    ? 'skipped'
    : report?.ground === false && !grounding?.queried
    ? 'skipped'
      : grounding?.queried && grounding?.frozen === true && (grounding?.results ?? []).length
        ? 'done'
        : grounding ? 'unknown' : 'unknown';

  const auditDim = dims?.audit ?? null;
  const challengeState = auditDim === 'infra_failed'
    ? 'failed'
    : auditDim === 'independent_clean' || auditDim === 'independent_findings'
      ? (rounds.length ? 'done' : 'unknown')
      : auditDim === 'advisory_clean' || auditDim === 'advisory_findings' || auditDim === 'not_run'
        ? 'skipped'
        : 'unknown';

  const verificationState = replay ? 'skipped'
    : !dims ? 'unknown'
    : dims.verification === 'passed' || dims.verification === 'passed_with_caveats' ? 'done'
      : dims.verification === 'not_run' ? 'skipped' : 'failed';

  return {
    Brief: report?.goal ? 'done' : 'unknown',
    'Evidence frozen': groundState,
    Draft: replay ? 'skipped' : (evidence.revisions ?? []).length ? 'done' : 'unknown',
    'Independent challenge': challengeState,
    'Human decision': decisions.length ? 'done' : 'skipped',
    Verification: verificationState,
    'Sealed receipt': pack?.receipt_id ? 'done' : 'unknown',
  };
}

// `headline` is passed IN, never read from the report: the standing is derived
// presentation decorated at serve time and deliberately not sealed, so a story
// card that dug one out of the receipt would be reading a field that must not
// exist. No headline → the card degrades rather than inventing a standing.
export function runStory(report, headline) {
  const pack = report?.evidencePack ?? null;
  const dims = pack?.statuses ?? report?.statuses ?? null;
  const states = beatStates(report, pack);
  const timeline = STORY_BEATS.map((beat) => ({ beat, state: states[beat] ?? 'unknown' }));
  const replay = report?.lane === 'audit_replay' && !!report?.sourceRunId;
  const rehearsal = report?.simulated === true || report?.engine === 'mock' || headline === 'rehearsal';

  // Fail closed: without dimensions the receipt cannot corroborate any claim
  // about what was checked, so the card refuses to tell a reassuring story.
  if (!dims || dims.schemaVersion !== 1) {
    return {
      degraded: true,
      headline: 'This receipt cannot tell its own story',
      sentences: [dims
        ? 'It carries a status schema this version of Studio does not recognise, so nothing here can confirm what was verified or reviewed. Read the raw trail instead of trusting a summary.'
        : 'It carries no status dimensions, so nothing here can confirm what was verified or reviewed. Read the raw trail instead of trusting a summary.'],
      timeline,
    };
  }

  const evidence = report?.evidence ?? {};
  const rounds = evidence.rounds ?? [];
  const decisions = evidence.humanDecisions ?? [];
  const sentences = [];

  if (rehearsal) {
    sentences.push('This was a scripted rehearsal, so no real model audit ran and it cannot earn verified standing.');
  }

  // Evidence frozen — only claim a snapshot when results were actually captured.
  const captured = (evidence.grounding?.results ?? []).length;
  if (replay) {
    sentences.push('The artifact and its original evidence were already sealed; this replay ran no retrieval or drafting.');
  } else if (states['Evidence frozen'] === 'done' && captured) {
    const source = evidence.grounding?.mode === 'hivemind_claude' ? 'Hivemind' : 'evidence';
    sentences.push(`${plural(captured, `${source} item`)} were captured and frozen before drafting, so later steps judged the same snapshot.`);
  } else if (states['Evidence frozen'] === 'skipped') {
    sentences.push('This run did not retrieve a private knowledge snapshot.');
  }

  // Draft + independent challenge.
  const executor = providerName(pack?.pairing?.executor?.actual);
  const auditor = providerName(pack?.pairing?.auditor?.actual);
  if (!replay && states.Draft === 'done' && executor) sentences.push(`${executor} drafted the deliverable.`);
  const blocking = distinctBlocking(rounds);
  if (rounds.length && auditor) {
    const independent = String(dims.audit ?? '').startsWith('independent');
    const advisory = String(dims.audit ?? '').startsWith('advisory');
    if (independent) {
      const repeated = repeatedBlocking(rounds) ? ', re-raising what was not fixed' : '';
      sentences.push(blocking.size
        ? `${auditor}, from a different vendor, raised ${plural(blocking.size, 'distinct blocking finding')} across ${plural(rounds.length, 'round')}${repeated}.`
        : `${auditor}, from a different vendor, reviewed it across ${plural(rounds.length, 'round')} and raised no blocking findings.`);
    } else if (advisory) {
      sentences.push(blocking.size
        ? `${auditor} raised ${plural(blocking.size, 'distinct blocking finding')} across ${plural(rounds.length, 'round')}.`
        : `${auditor} reviewed it across ${plural(rounds.length, 'round')} and raised no blocking findings.`);
      sentences.push('That review shared the maker’s vendor, so it is advisory and never earns independent standing.');
    }
  }
  if (dims.audit === 'infra_failed') {
    sentences.push('The audit step failed, so it produced no reliable standing.');
  }

  // Human decisions — quote the shape of the choice, not a paraphrase of it.
  const oneMore = decisions.filter((d) => /one more round/i.test(d.answer ?? '')).length;
  const accepted = decisions.filter((d) => /^accept/i.test(d.answer ?? '')).length;
  const stopped = decisions.filter((d) => /^stop/i.test(d.answer ?? '')).length;
  if (oneMore) sentences.push(`The goal owner authorised ${plural(oneMore, 'further round')} rather than settling.`);
  if (accepted) sentences.push('The goal owner accepted findings on the record, so that decision travels with the artifact.');
  if (stopped) sentences.push('The goal owner stopped the run rather than accept the result.');
  const otherDecisions = decisions.length - oneMore - accepted - stopped;
  if (otherDecisions > 0) sentences.push(`The goal owner made ${plural(otherDecisions, 'other binding decision')}.`);

  // Verification and publication.
  if (replay && (dims.verification === 'passed' || dims.verification === 'passed_with_caveats')) {
    sentences.push(dims.verification === 'passed_with_caveats'
      ? 'The source artifact carried deterministic checks that passed with caveats; this replay did not rerun them.'
      : 'The source artifact carried deterministic checks that passed; this replay did not rerun them.');
  } else if (states.Verification === 'done') {
    sentences.push(dims.verification === 'passed_with_caveats'
      ? 'The deterministic checks passed, with caveats recorded.'
      : 'The deterministic checks passed.');
  } else if (states.Verification === 'failed') {
    sentences.push('The deterministic checks did not pass, so nothing here is verified.');
  } else if (states.Verification === 'skipped') {
    sentences.push('The deterministic checks never ran, so verification is not claimed.');
  }
  if (dims.publication === 'not_published') sentences.push('Nothing was published.');
  if (dims.publication === 'published') sentences.push('The artifact was published.');

  const label = standingLabel(headline);

  const lines = label ? sentences : [...sentences, 'This run reports a standing this view does not recognise, so the summary above is not a claim about it. Read the raw trail.'];
  return {
    degraded: !label,
    headline: label ?? 'Standing not recognised',
    sentences: lines.map(sentence),
    timeline,
  };
}
