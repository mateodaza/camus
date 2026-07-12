// Resolved model decisions. Precedence: env override > checks/models.json.
// There is deliberately NO fallback to account/CLI defaults — a model that
// isn't named here is a model nobody decided on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = JSON.parse(readFileSync(join(__dirname, '..', 'checks', 'models.json'), 'utf8'));

function required(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`models.json is missing ${name} — every model must be an explicit decision`);
  }
  return value;
}

export const MODELS = {
  maker: {
    model: process.env.CLAUDE_MODEL || required(FILE.maker?.model, 'maker.model'),
    source: process.env.CLAUDE_MODEL ? 'env:CLAUDE_MODEL' : 'checks/models.json',
  },
  reviewer: {
    model: process.env.CODEX_MODEL || required(FILE.reviewer?.model, 'reviewer.model'),
    effort: process.env.CODEX_EFFORT || FILE.reviewer?.effort || 'medium',
    source: process.env.CODEX_MODEL ? 'env:CODEX_MODEL' : 'checks/models.json',
  },
};

export function modelsSummary() {
  return `maker ${MODELS.maker.model} · reviewer ${MODELS.reviewer.model} (${MODELS.reviewer.effort})`;
}
