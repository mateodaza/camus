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
import { storedSeatQualification } from '../capability-probes.mjs';

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

const QUAL1_RE = /^qual1:[0-9a-f]{64}$/;

// Final synchronous bypass guard. The server performs the live receipt check
// and freezes its accepted fingerprint into the run snapshot; adapter resolution
// refuses any configurable seat that did not arrive through that gate. It does
// not try to recreate trust from config or hit the network here.
function requireAcceptedAdmission(seat, backend, seatType) {
  if (backend.kind !== 'openai_compat') return;
  const accepted = seat?.qualification;
  if (!accepted || !QUAL1_RE.test(accepted.fingerprint ?? '') || accepted.seatType !== seatType) {
    throw new Error(
      `backend "${backend.name}" cannot resolve as ${seatType} without the exact accepted qual1 qualification in the run snapshot`,
    );
  }
  const stored = storedSeatQualification({ entry: backend, model: seat?.model, seatType });
  if (!stored.qualified || stored.fingerprint !== accepted.fingerprint) {
    throw new Error(
      `backend "${backend.name}" cannot resolve as ${seatType}: the snapshot qualification does not match the valid stored receipt for ${backend.name}:${seat?.model ?? 'unknown'}`,
    );
  }
}

// models → { maker, reviewer } seat functions plus the resolved backend metadata
// (name/kind/provider) the server records. Throws on a backend nobody declared —
// a run must never silently fall back to a different backend than its snapshot.
//
// `frozenBackends` (optional) is the { maker, reviewer } backend objects the
// launch gate qualified, captured at admission BEFORE any network await. They are
// preferred over a live `listBackends()` reload for exactly the seats they cover:
// a concurrent `/api/config` edit can change a backend's URL, auth, provider, or
// alias mapping under an unchanged name after its qual1 receipt was accepted but
// before this resolves (RFC §9.2). Reloading here would launch the run against
// the new, unqualified endpoint while carrying the old endpoint's fingerprint.
// The frozen object is the exact one qualification validated; only it may serve a
// gated seat. Legacy/recovery/build snapshots pass none and fall back to live.
export function resolveSeatAdapters(models, frozenBackends = null) {
  const backends = listBackends();
  const makerName = models?.maker?.backend || 'claude';
  const reviewerName = models?.reviewer?.backend || 'codex';
  const makerBackend = frozenBackends?.maker || backends[makerName];
  const reviewerBackend = frozenBackends?.reviewer || backends[reviewerName];
  if (!makerBackend) throw new Error(`this run's snapshot names maker backend "${makerName}", which is not declared on this machine`);
  if (!reviewerBackend) throw new Error(`this run's snapshot names reviewer backend "${reviewerName}", which is not declared on this machine`);
  if (!makerBackend.seats.includes('maker')) throw new Error(`backend "${makerName}" does not offer the maker seat`);
  if (!reviewerBackend.seats.includes('reviewer')) throw new Error(`backend "${reviewerName}" does not offer the reviewer seat`);
  requireAcceptedAdmission(models?.maker, makerBackend, 'words_maker');
  requireAcceptedAdmission(models?.reviewer, reviewerBackend, 'words_reviewer');
  return {
    maker: makerFor(makerBackend),
    reviewer: reviewerFor(reviewerBackend),
    makerBackend: { name: makerBackend.name, kind: makerBackend.kind, provider: makerBackend.provider },
    reviewerBackend: { name: reviewerBackend.name, kind: reviewerBackend.kind, provider: reviewerBackend.provider },
  };
}
