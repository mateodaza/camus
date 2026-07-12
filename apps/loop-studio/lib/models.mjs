// Resolved run decisions. Precedence: env override > checks/models.json.
// There is deliberately NO fallback to account/CLI defaults — a model that
// isn't named here is a model nobody decided on. Resolved per call (not at
// import) so the studio's settings panel can change a decision between runs
// without a restart.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_PATH = join(__dirname, '..', 'checks', 'models.json');

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
      source: process.env.CODEX_MODEL ? 'env:CODEX_MODEL' : 'checks/models.json',
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
