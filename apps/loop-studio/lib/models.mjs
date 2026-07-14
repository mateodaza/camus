// Resolved run decisions. Precedence: env override > checks/models.json.
// There is deliberately NO fallback to account/CLI defaults — a model that
// isn't named here is a model nobody decided on. Resolved per call (not at
// import) so the studio's settings panel can change a decision between runs
// without a restart.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// STUDIO_MODELS_FILE points the decision record at a throwaway file so tests
// (and any embedding) never mutate the product's real checks/models.json — the
// same isolation promise STUDIO_RUNS_DIR makes for receipts.
const FILE_PATH = process.env.STUDIO_MODELS_FILE || join(__dirname, '..', 'checks', 'models.json');

function required(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`models.json is missing ${name} — every model must be an explicit decision`);
  }
  return value;
}

export function getModels() {
  const file = JSON.parse(readFileSync(FILE_PATH, 'utf8'));
  const rawCap = Number(process.env.ROUND_CAP ?? file.loop?.roundCap);
  return {
    maker: {
      model: process.env.CLAUDE_MODEL || required(file.maker?.model, 'maker.model'),
      source: process.env.CLAUDE_MODEL ? 'env:CLAUDE_MODEL' : 'checks/models.json',
    },
    reviewer: {
      model: process.env.CODEX_MODEL || required(file.reviewer?.model, 'reviewer.model'),
      effort: process.env.CODEX_EFFORT || file.reviewer?.effort || 'medium',
      // Model and effort are two decisions and can come from different places
      // (CODEX_MODEL env but effort from the file, or vice versa), so each names
      // its own provenance — a single conflated `source` would misattribute one.
      modelSource: process.env.CODEX_MODEL ? 'env:CODEX_MODEL' : 'checks/models.json',
      effortSource: process.env.CODEX_EFFORT ? 'env:CODEX_EFFORT' : 'checks/models.json',
    },
    loop: {
      // NaN-proof: a typo'd cap must never skip the review loop.
      roundCap: Number.isFinite(rawCap) ? Math.min(6, Math.max(1, rawCap)) : 3,
      source: process.env.ROUND_CAP !== undefined ? 'env:ROUND_CAP' : 'checks/models.json',
    },
  };
}

// The settings panel writes THROUGH this — the file stays the decision
// record, and each change stamps its why.
export function updateModels({ maker, reviewer, effort, roundCap }) {
  const file = JSON.parse(readFileSync(FILE_PATH, 'utf8'));
  const stamp = `set from the studio settings panel, ${new Date().toISOString().slice(0, 10)}`;
  if (maker && maker !== file.maker.model) {
    file.maker = { model: maker, why: stamp };
  }
  if ((reviewer && reviewer !== file.reviewer.model) || (effort && effort !== file.reviewer.effort)) {
    file.reviewer = {
      model: reviewer || file.reviewer.model,
      effort: effort || file.reviewer.effort,
      why: stamp,
    };
  }
  if (roundCap && roundCap !== file.loop?.roundCap) {
    file.loop = { roundCap, why: stamp };
  }
  writeFileSync(FILE_PATH, JSON.stringify(file, null, 2) + '\n');
  return getModels();
}

export function modelsSummary() {
  const m = getModels();
  return `maker ${m.maker.model} · reviewer ${m.reviewer.model} (${m.reviewer.effort}) · rounds ${m.loop.roundCap}`;
}

// Codex marks internal models `visibility: 'hide'` in its cache (e.g.
// codex-auto-review, the reviewer codex runs for itself). Offer ONLY what codex
// itself lists — a picker must never surface a model the normal codex UI
// withholds, or a run decision could be made that codex never intended to be
// selectable. Pure so the filter is directly testable.
export function reviewerSlugsFromCache(cache) {
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .map((m) => m.slug);
}

// The pickable model lists for the settings panel. Makers are the Claude CLI's
// stable aliases; reviewers come from codex's own cache when it exists (the
// machine's real, listable options) and a small curated fallback otherwise —
// deliberately conservative, since with no cache we cannot confirm what the
// installed CLI will accept. `reviewerSource` tells a caller whether the list is
// CLI-verified or a best-effort default, and the server validates writes against
// these lists so a value that is not offerable can never be saved.
export function modelCatalog() {
  const m = getModels();
  // Maker has no model cache to check claude against, so a configured maker is a
  // real decision, never a hidden one — surface it if it is not a known alias.
  const makerAliases = ['haiku', 'sonnet', 'opus'];
  const maker = makerAliases.includes(m.maker.model) ? [...makerAliases] : [m.maker.model, ...makerAliases];

  let reviewer = ['gpt-5.4', 'gpt-5.4-mini'];
  let reviewerSource = 'fallback';
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const slugs = reviewerSlugsFromCache(cache);
    if (slugs.length) { reviewer = slugs; reviewerSource = 'codex_cache'; }
  } catch { /* cache absent or unreadable: the conservative fallback stands */ }

  // A current reviewer that codex's cache does NOT list — a hidden model like
  // codex-auto-review set via CODEX_MODEL, or one dropped from the cache — must
  // NEVER become selectable just by being the current decision (that was the
  // hole: the current value was unshifted back into the picker unconditionally).
  // Report it as current-but-unavailable instead. With no cache we cannot judge
  // availability, so the fallback still allows the current decision through.
  const reviewerCurrentAvailable = reviewer.includes(m.reviewer.model) || reviewerSource === 'fallback';
  if (reviewerSource === 'fallback' && !reviewer.includes(m.reviewer.model)) {
    reviewer = [m.reviewer.model, ...reviewer];
  }
  return { maker, reviewer, reviewerSource, reviewerCurrent: m.reviewer.model, reviewerCurrentAvailable };
}
