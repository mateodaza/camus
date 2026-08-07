// Seat resolution: a run's model snapshot names a backend per seat, and this
// module hands the engine the two functions that honor it. The seat contracts
// live in docs/MULTI-MODEL-SEATS.md; every function returned here implements
// them (fail-closed reviewer normalization, explicit models, kill paths).
//
// Legacy snapshots (no backend field) mean the historical pairing —
// claude-writes / codex-reviews — so old run.json files and comparison-arm
// snapshots resolve exactly as they always ran.

import { listBackends } from '../models.mjs';
import { runClaude, runClaudeReview } from './claude.mjs';
import { runCodexReview, runCodexMaker } from './codex.mjs';
import { openAiCompatMaker, openAiCompatReviewer } from './openai-compat.mjs';

function makerFor(backend) {
  if (backend.kind === 'claude_cli') return runClaude;
  if (backend.kind === 'codex_cli') return runCodexMaker;
  return openAiCompatMaker(backend);
}

function reviewerFor(backend) {
  if (backend.kind === 'claude_cli') return runClaudeReview;
  if (backend.kind === 'codex_cli') return runCodexReview;
  return openAiCompatReviewer(backend);
}

// models → { maker, reviewer } seat functions plus the resolved backend metadata
// (name/kind/provider) the server records. Throws on a backend nobody declared —
// a run must never silently fall back to a different backend than its snapshot.
export function resolveSeatAdapters(models) {
  const backends = listBackends();
  const makerName = models?.maker?.backend || 'claude';
  const reviewerName = models?.reviewer?.backend || 'codex';
  const makerBackend = backends[makerName];
  const reviewerBackend = backends[reviewerName];
  if (!makerBackend) throw new Error(`this run's snapshot names maker backend "${makerName}", which is not declared on this machine`);
  if (!reviewerBackend) throw new Error(`this run's snapshot names reviewer backend "${reviewerName}", which is not declared on this machine`);
  if (!makerBackend.seats.includes('maker')) throw new Error(`backend "${makerName}" does not offer the maker seat`);
  if (!reviewerBackend.seats.includes('reviewer')) throw new Error(`backend "${reviewerName}" does not offer the reviewer seat`);
  return {
    maker: makerFor(makerBackend),
    reviewer: reviewerFor(reviewerBackend),
    makerBackend: { name: makerBackend.name, kind: makerBackend.kind, provider: makerBackend.provider },
    reviewerBackend: { name: reviewerBackend.name, kind: reviewerBackend.kind, provider: reviewerBackend.provider },
  };
}
