// Private, provider-free persistence for the exact two-cell Code Harness Eval
// v1b isolation pair. One global marker serializes spend across both cells. A
// marker is always resolved from its embedded cell key; recovery never guesses
// from whichever scheduled cell happens to be pending next.

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';

import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';
import {
  codeEvalPairCampaignIdentity,
  codeEvalPairCellIdentity,
  codeEvalPairExecutionIdentity,
  createUnknownCodeEvalPairReceipt,
  validateCodeEvalPairCell,
  validateCodeEvalPairExecution,
  validateCodeEvalPairReceipt,
} from './code-eval-pair-contract.mjs';
import { nextCodeEvalPairCell, scheduleCodeEvalPairCells } from './code-eval-pair-scheduler.mjs';

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const PAIR_GENERATION_PROTOCOL = 'code-harness-pair-evidence/v1b';
const PAIR_MARKER_PROTOCOL = 'code-harness-pair-inflight/v1b';

function fail(message) {
  throw new Error(`code eval pair evidence: ${message}`);
}

function exactObject(value, path, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  const unknown = actual.filter(key => !expected.includes(key));
  const missing = expected.filter(key => !actual.includes(key));
  if (unknown.length) fail(`${path} contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (missing.length) fail(`${path} is missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  return value;
}

function canonicalIso(value, field) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(parsed.valueOf())
      || parsed.toISOString() !== value) fail(`${field} must be a canonical ISO timestamp`);
  return value;
}

function safeValue(value, field) {
  if (typeof value !== 'string' || !SAFE_VALUE.test(value)) fail(`${field} has an invalid format`);
  return value;
}

function fileInfo(path, maximum, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (info.size > maximum) fail(`${label} exceeds its private storage limit`);
  if ((info.mode & 0o777) !== STUDIO_FILE_MODE) fail(`${label} permissions must be 0600`);
  return info;
}

function readOnlyFileInfo(path, maximum, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (info.size > maximum) fail(`${label} exceeds its private storage limit`);
  const mode = info.mode & 0o777;
  if ((mode & 0o400) === 0 || (mode & 0o077) !== 0) {
    fail(`${label} must be owner-readable and private`);
  }
  return info;
}

function fsyncPath(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // The bytes and rename have landed. Some filesystems reject directory fsync.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function removeDurably(path, label) {
  if (!existsSync(path)) return false;
  fileInfo(path, MAX_CONTROL_BYTES, label);
  unlinkSync(path);
  fsyncPath(dirname(path));
  return true;
}

export function codeEvalPairEvidencePaths(root) {
  if (typeof root !== 'string' || !root.trim()) fail('evidence root must be a non-empty path');
  const dir = resolve(root);
  return Object.freeze({
    dir,
    generation: join(dir, 'generation.json'),
    ledger: join(dir, 'receipts.jsonl'),
    marker: join(dir, 'inflight.json'),
    lock: join(dir, 'evidence.lock'),
  });
}

export function ensureCodeEvalPairEvidenceDir(paths) {
  exactObject(paths, 'paths', ['dir', 'generation', 'ledger', 'marker', 'lock']);
  const existed = existsSync(paths.dir);
  if (!existed) mkdirSync(paths.dir, { recursive: true, mode: STUDIO_DIR_MODE });
  const info = lstatSync(paths.dir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('evidence root must be a regular directory');
  if (existed && (info.mode & 0o777) !== STUDIO_DIR_MODE) {
    fail('existing evidence root permissions must already be 0700');
  }
  if (!existed) chmodSync(paths.dir, STUDIO_DIR_MODE);
  if ((lstatSync(paths.dir).mode & 0o777) !== STUDIO_DIR_MODE) fail('evidence root permissions must be 0700');
  if ([paths.generation, paths.ledger, paths.marker, paths.lock].some(path => dirname(path) !== paths.dir)) {
    fail('generation, ledger, marker, and lock must live directly under the evidence root');
  }
  return paths;
}

function inspectCodeEvalPairEvidenceDir(paths) {
  exactObject(paths, 'paths', ['dir', 'generation', 'ledger', 'marker', 'lock']);
  const info = lstatSync(paths.dir);
  const mode = info.mode & 0o777;
  if (!info.isDirectory() || info.isSymbolicLink()) fail('evidence root must be a regular directory');
  if ((mode & 0o500) !== 0o500 || (mode & 0o077) !== 0) {
    fail('evidence root must be owner-readable, owner-searchable, and private');
  }
  if ([paths.generation, paths.ledger, paths.marker, paths.lock].some(path => dirname(path) !== paths.dir)) {
    fail('generation, ledger, marker, and lock must live directly under the evidence root');
  }
  return paths;
}

function readLock(path) {
  fileInfo(path, MAX_CONTROL_BYTES, 'evidence lock');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`evidence lock is malformed and cannot be stolen: ${error.message}`); }
  exactObject(value, 'evidence lock', ['schemaVersion', 'owner', 'nonce', 'acquiredAt']);
  if (value.schemaVersion !== 1 || !/^pid-[1-9][0-9]{0,9}$/.test(value.owner ?? '')
      || !/^[a-f0-9]{32}$/.test(value.nonce ?? '')) fail('evidence lock identity is invalid and cannot be stolen');
  canonicalIso(value.acquiredAt, 'evidence lock.acquiredAt');
  return value;
}

export function acquireCodeEvalPairEvidenceLock(paths, {
  owner = `pid-${process.pid}`,
  acquiredAt = new Date().toISOString(),
} = {}) {
  ensureCodeEvalPairEvidenceDir(paths);
  if (!/^pid-[1-9][0-9]{0,9}$/.test(owner)) fail('lock owner must be pid-<positive integer>');
  canonicalIso(acquiredAt, 'evidence lock.acquiredAt');
  const value = { schemaVersion: 1, owner, nonce: randomBytes(16).toString('hex'), acquiredAt };
  let fd;
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(paths.lock, flags, STUDIO_FILE_MODE);
    writeSync(fd, JSON.stringify(value), null, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      fd = undefined;
    }
    if (error.code === 'EEXIST' || existsSync(paths.lock)) {
      readLock(paths.lock);
      fail('evidence is locked by another writer; no stale lock is stolen');
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  chmodSync(paths.lock, STUDIO_FILE_MODE);
  fsyncPath(paths.lock);
  fsyncPath(paths.dir);
  let released = false;
  return {
    value: Object.freeze({ ...value }),
    release() {
      if (released) return false;
      const current = readLock(paths.lock);
      if (current.owner !== value.owner || current.nonce !== value.nonce) {
        fail('evidence lock ownership changed; refusing to remove another writer\'s lock');
      }
      unlinkSync(paths.lock);
      fsyncPath(paths.dir);
      released = true;
      return true;
    },
  };
}

export async function recoverAbandonedCodeEvalPairEvidenceLock(paths, { ownerDead } = {}) {
  ensureCodeEvalPairEvidenceDir(paths);
  if (!existsSync(paths.lock)) return { action: 'no_lock' };
  const abandoned = readLock(paths.lock);
  if (typeof ownerDead !== 'function') fail('explicit lock recovery requires an owner liveness proof');
  let dead = false;
  try { dead = await ownerDead({ ...abandoned }); } catch { dead = false; }
  if (dead !== true) fail('evidence lock owner liveness is uncertain; the lock was not stolen');
  if (!existsSync(paths.lock)) return { action: 'no_lock' };
  const current = readLock(paths.lock);
  if (!isDeepStrictEqual(current, abandoned)) {
    fail('evidence lock changed during recovery; refusing to remove another writer\'s lock');
  }
  unlinkSync(paths.lock);
  fsyncPath(paths.dir);
  return { action: 'stale_lock_cleared', owner: abandoned.owner };
}

function withEvidenceLock(paths, action) {
  const lease = acquireCodeEvalPairEvidenceLock(paths);
  try { return action(); }
  finally { lease.release(); }
}

function generationContext({ campaign, execution }) {
  validateCodeEvalPairExecution(execution, campaign);
  const cells = scheduleCodeEvalPairCells(campaign, execution);
  if (!Array.isArray(cells) || cells.length !== 2) fail('the frozen v1b roster must contain exactly two cells');
  const cellIds = [];
  const cellsById = new Map();
  for (const cell of cells) {
    validateCodeEvalPairCell(cell, campaign, execution);
    const cellId = codeEvalPairCellIdentity(cell, campaign, execution);
    if (cellsById.has(cellId)) fail(`the frozen v1b roster contains duplicate cell ${cellId}`);
    cellsById.set(cellId, cell);
    cellIds.push(cellId);
  }
  return {
    campaign,
    execution,
    cells,
    cellsById,
    cellIds,
    campaignDigest: codeEvalPairCampaignIdentity(campaign),
    executionDigest: codeEvalPairExecutionIdentity(execution, campaign),
  };
}

function expectedGeneration(ctx) {
  return {
    schemaVersion: 1,
    protocol: PAIR_GENERATION_PROTOCOL,
    campaignDigest: ctx.campaignDigest,
    executionDigest: ctx.executionDigest,
    orderedCellIds: [...ctx.cellIds],
  };
}

function readGeneration(paths, ctx, { readOnly = false } = {}) {
  if (!existsSync(paths.generation)) return null;
  (readOnly ? readOnlyFileInfo : fileInfo)(paths.generation, MAX_CONTROL_BYTES, 'pair generation');
  let value;
  try { value = JSON.parse(readFileSync(paths.generation, 'utf8')); }
  catch (error) { fail(`pair generation is malformed: ${error.message}`); }
  exactObject(value, 'pair generation', [
    'schemaVersion', 'protocol', 'campaignDigest', 'executionDigest', 'orderedCellIds',
  ]);
  if (!isDeepStrictEqual(value, expectedGeneration(ctx))) {
    fail('pair generation differs from the frozen campaign, execution, or scheduled roster');
  }
  return value;
}

function ensureGenerationUnlocked(paths, ctx) {
  const existing = readGeneration(paths, ctx);
  if (existing) return existing;
  if (existsSync(paths.ledger) || existsSync(paths.marker)) {
    fail('existing evidence has no v1b pair generation; use a fresh evidence directory');
  }
  const value = expectedGeneration(ctx);
  studioAtomicWrite(paths.generation, `${JSON.stringify(value, null, 2)}\n`, STUDIO_FILE_MODE);
  return readGeneration(paths, ctx);
}

function requireGenerationForArtifacts(paths, ctx, options) {
  const generation = readGeneration(paths, ctx, options);
  if (!generation && (existsSync(paths.ledger) || existsSync(paths.marker))) {
    fail('existing evidence has no v1b pair generation; use a fresh evidence directory');
  }
  return generation;
}

export function initializeCodeEvalPairEvidence(paths, input) {
  const ctx = generationContext(input);
  return withEvidenceLock(paths, () => ensureGenerationUnlocked(paths, ctx));
}

function parseLedgerLine(line, index, ctx) {
  let receipt;
  try { receipt = JSON.parse(line); }
  catch (error) { fail(`ledger line ${index + 1} is malformed JSON: ${error.message}`); }
  const cell = ctx.cellsById.get(receipt?.cellId);
  if (!cell) fail(`ledger line ${index + 1} names a cell outside the frozen two-cell roster`);
  try { return validateCodeEvalPairReceipt(receipt, ctx.campaign, ctx.execution, cell); }
  catch (error) { fail(`ledger line ${index + 1} is invalid or mixed-generation: ${error.message}`); }
}

function loadReceiptsFromDisk(paths, ctx, { readOnly = false } = {}) {
  (readOnly ? inspectCodeEvalPairEvidenceDir : ensureCodeEvalPairEvidenceDir)(paths);
  requireGenerationForArtifacts(paths, ctx, { readOnly });
  if (!existsSync(paths.ledger)) return [];
  (readOnly ? readOnlyFileInfo : fileInfo)(paths.ledger, MAX_LEDGER_BYTES, 'ledger');
  const text = readFileSync(paths.ledger, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_LEDGER_BYTES) fail('ledger exceeds its private storage limit');
  if (!text) return [];
  if (!text.endsWith('\n')) fail('ledger has a partial final line');
  const lines = text.slice(0, -1).split('\n');
  if (lines.some(line => !line)) fail('ledger contains an empty record');
  if (lines.length > ctx.cells.length) fail('ledger exceeds the exact two-cell roster');
  const receipts = lines.map((line, index) => parseLedgerLine(line, index, ctx));
  const receiptIds = new Set();
  const cellIds = new Set();
  for (const [index, receipt] of receipts.entries()) {
    if (receiptIds.has(receipt.receiptId)) fail(`duplicate receipt ${receipt.receiptId}`);
    if (cellIds.has(receipt.cellId)) fail(`duplicate cell ${receipt.cellId}`);
    if (receipt.cellId !== ctx.cellIds[index]) {
      fail(`ledger line ${index + 1} is out of the frozen scheduled order`);
    }
    receiptIds.add(receipt.receiptId);
    cellIds.add(receipt.cellId);
  }
  return receipts;
}

function loadReceiptsUnlocked(paths, ctx) {
  return loadReceiptsFromDisk(paths, ctx);
}

export function loadCodeEvalPairReceipts(paths, input) {
  const ctx = generationContext(input);
  return withEvidenceLock(paths, () => loadReceiptsUnlocked(paths, ctx));
}

// A summary is a read-only projection over immutable generation data and an
// append-only ledger. It must not acquire evidence.lock: doing so would create
// and remove filesystem artifacts merely to report existing evidence. The
// lock checks bracket the snapshot read so a writer cannot expose a row before
// its fsync boundary; a later summary can retry after the writer releases.
export function readCodeEvalPairReceiptsSnapshot(paths, input) {
  const ctx = generationContext(input);
  inspectCodeEvalPairEvidenceDir(paths);
  if (existsSync(paths.lock)) {
    fail('read-only snapshot refused while evidence is locked by a writer');
  }
  let receipts;
  try {
    receipts = loadReceiptsFromDisk(paths, ctx, { readOnly: true });
  } finally {
    if (existsSync(paths.lock)) {
      fail('read-only snapshot refused because evidence became locked during the read');
    }
  }
  return receipts;
}

function appendLineDurably(path, line) {
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, STUDIO_FILE_MODE);
  try {
    chmodSync(path, STUDIO_FILE_MODE);
    writeSync(fd, line, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if ((lstatSync(path).mode & 0o777) !== STUDIO_FILE_MODE) fail('ledger permissions must be 0600');
  fsyncPath(dirname(path));
}

function appendReceiptUnlocked(paths, receipt, ctx, marker) {
  ensureGenerationUnlocked(paths, ctx);
  const cell = ctx.cellsById.get(receipt?.cellId);
  if (!cell) fail('receipt names a cell outside the frozen two-cell roster');
  validateCodeEvalPairReceipt(receipt, ctx.campaign, ctx.execution, cell);
  if (!marker || marker.cellId !== receipt.cellId) {
    fail('receipt does not match the active in-flight reservation');
  }
  const existing = loadReceiptsUnlocked(paths, ctx);
  if (existing.some(row => row.receiptId === receipt.receiptId)) fail(`duplicate receipt ${receipt.receiptId}`);
  if (existing.some(row => row.cellId === receipt.cellId)) fail(`duplicate cell ${receipt.cellId}`);
  if (existing.length >= ctx.cells.length) fail('ledger already contains its exact two allowed receipts');
  appendLineDurably(paths.ledger, `${JSON.stringify(receipt)}\n`);
  const persisted = loadReceiptsUnlocked(paths, ctx);
  const sealed = persisted.find(row => row.receiptId === receipt.receiptId);
  if (!sealed || persisted.length !== existing.length + 1) fail('persisted receipt did not validate after append');
  return sealed;
}

export function createCodeEvalPairInflightMarker({
  campaign,
  execution,
  cell,
  buildRunId,
  supervisorIdentity,
  maximumProviderCallsReserved,
  reservationNonce = randomBytes(16).toString('hex'),
  startedAt = new Date().toISOString(),
}) {
  const ctx = generationContext({ campaign, execution });
  validateCodeEvalPairCell(cell, campaign, execution);
  const cellId = codeEvalPairCellIdentity(cell, campaign, execution);
  if (!ctx.cellsById.has(cellId)) fail('marker cell is outside the frozen two-cell roster');
  safeValue(buildRunId, 'marker.buildRunId');
  if (!/^pid-[1-9][0-9]{0,9}$/.test(supervisorIdentity ?? '')) {
    fail('marker.supervisorIdentity must be pid-<positive integer>');
  }
  if (!Number.isSafeInteger(maximumProviderCallsReserved) || maximumProviderCallsReserved < 1
      || maximumProviderCallsReserved > campaign.controls.maximumProviderCallsPerCell) {
    fail('marker.maximumProviderCallsReserved exceeds the frozen positive call bound');
  }
  if (!/^[a-f0-9]{32}$/.test(reservationNonce ?? '')) fail('marker.reservationNonce must be 128-bit lowercase hex');
  canonicalIso(startedAt, 'marker.startedAt');
  return {
    schemaVersion: 1,
    protocol: PAIR_MARKER_PROTOCOL,
    campaignDigest: ctx.campaignDigest,
    executionDigest: ctx.executionDigest,
    cellId,
    cell: JSON.parse(JSON.stringify(cell)),
    buildRunId,
    supervisorIdentity,
    maximumProviderCallsReserved,
    reservationNonce,
    startedAt,
  };
}

export function validateCodeEvalPairInflightMarker(marker, input) {
  const ctx = generationContext(input);
  exactObject(marker, 'marker', [
    'schemaVersion', 'protocol', 'campaignDigest', 'executionDigest', 'cellId', 'cell',
    'buildRunId', 'supervisorIdentity', 'maximumProviderCallsReserved',
    'reservationNonce', 'startedAt',
  ]);
  if (marker.schemaVersion !== 1 || marker.protocol !== PAIR_MARKER_PROTOCOL) {
    fail('marker protocol is not code-harness-pair-inflight/v1b');
  }
  validateCodeEvalPairCell(marker.cell, ctx.campaign, ctx.execution);
  const cellId = codeEvalPairCellIdentity(marker.cell, ctx.campaign, ctx.execution);
  if (marker.campaignDigest !== ctx.campaignDigest || marker.executionDigest !== ctx.executionDigest
      || marker.cellId !== cellId || !ctx.cellsById.has(cellId)) {
    fail('marker is from a different generation or outside the frozen two-cell roster');
  }
  safeValue(marker.buildRunId, 'marker.buildRunId');
  if (!/^pid-[1-9][0-9]{0,9}$/.test(marker.supervisorIdentity ?? '')) {
    fail('marker.supervisorIdentity must be pid-<positive integer>');
  }
  if (!Number.isSafeInteger(marker.maximumProviderCallsReserved)
      || marker.maximumProviderCallsReserved < 1
      || marker.maximumProviderCallsReserved > ctx.campaign.controls.maximumProviderCallsPerCell) {
    fail('marker.maximumProviderCallsReserved exceeds the frozen positive call bound');
  }
  if (!/^[a-f0-9]{32}$/.test(marker.reservationNonce ?? '')) fail('marker.reservationNonce must be 128-bit lowercase hex');
  canonicalIso(marker.startedAt, 'marker.startedAt');
  return marker;
}

function loadMarkerUnlocked(paths, ctx) {
  ensureCodeEvalPairEvidenceDir(paths);
  requireGenerationForArtifacts(paths, ctx);
  if (!existsSync(paths.marker)) return null;
  fileInfo(paths.marker, MAX_CONTROL_BYTES, 'in-flight marker');
  let marker;
  try { marker = JSON.parse(readFileSync(paths.marker, 'utf8')); }
  catch (error) { fail(`in-flight marker is malformed: ${error.message}`); }
  return validateCodeEvalPairInflightMarker(marker, ctx);
}

export function loadCodeEvalPairInflightMarker(paths, input) {
  const ctx = generationContext(input);
  return withEvidenceLock(paths, () => loadMarkerUnlocked(paths, ctx));
}

export function reserveNextCodeEvalPairCell(paths, {
  campaign,
  execution,
  buildRunId,
  supervisorIdentity,
  maximumProviderCallsReserved,
  reservationNonce,
  startedAt,
}) {
  const ctx = generationContext({ campaign, execution });
  return withEvidenceLock(paths, () => {
    ensureGenerationUnlocked(paths, ctx);
    const receipts = loadReceiptsUnlocked(paths, ctx);
    const active = loadMarkerUnlocked(paths, ctx);
    if (active) fail('an unresolved in-flight marker already exists; no second cell was reserved');
    const cell = nextCodeEvalPairCell(campaign, execution, receipts);
    if (!cell) fail('the exact two-cell roster already has terminal receipts and can never replay');
    const marker = createCodeEvalPairInflightMarker({
      campaign,
      execution,
      cell,
      buildRunId,
      supervisorIdentity,
      maximumProviderCallsReserved,
      ...(reservationNonce === undefined ? {} : { reservationNonce }),
      ...(startedAt === undefined ? {} : { startedAt }),
    });
    studioAtomicWrite(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, STUDIO_FILE_MODE);
    return {
      cell: JSON.parse(JSON.stringify(cell)),
      marker: JSON.parse(JSON.stringify(loadMarkerUnlocked(paths, ctx))),
    };
  });
}

export function appendCodeEvalPairReceipt(paths, receipt, input, { reservationNonce } = {}) {
  const ctx = generationContext(input);
  return withEvidenceLock(paths, () => {
    const marker = loadMarkerUnlocked(paths, ctx);
    if (!marker || marker.reservationNonce !== reservationNonce) {
      fail('receipt completion does not match the active reservation nonce');
    }
    return appendReceiptUnlocked(paths, receipt, ctx, marker);
  });
}

function statusUnlocked(paths, ctx) {
  const receipts = loadReceiptsUnlocked(paths, ctx);
  let marker = loadMarkerUnlocked(paths, ctx);
  let staleMarkerCleared = false;
  if (marker && receipts.some(receipt => receipt.cellId === marker.cellId)) {
    staleMarkerCleared = removeDurably(paths.marker, 'in-flight marker');
    marker = null;
  }
  const nextCell = marker ? null : nextCodeEvalPairCell(ctx.campaign, ctx.execution, receipts);
  return {
    state: marker ? 'paused_inflight_unknown' : nextCell ? 'pending' : 'complete',
    canAttempt: !marker && nextCell !== null,
    replayAllowed: false,
    staleMarkerCleared,
    totalCells: ctx.cells.length,
    completedCells: receipts.length,
    pendingCells: ctx.cells.length - receipts.length,
    receiptIds: receipts.map(receipt => receipt.receiptId),
    nextCell: nextCell ? JSON.parse(JSON.stringify(nextCell)) : null,
    inflightCell: marker ? JSON.parse(JSON.stringify(marker.cell)) : null,
    inflightCellId: marker?.cellId ?? null,
  };
}

export function codeEvalPairStatus(paths, input) {
  const ctx = generationContext(input);
  return withEvidenceLock(paths, () => {
    requireGenerationForArtifacts(paths, ctx);
    return statusUnlocked(paths, ctx);
  });
}

export async function recoverCodeEvalPairCell(paths, input, {
  processesDead,
  recordedAt = new Date().toISOString(),
} = {}) {
  ensureCodeEvalPairEvidenceDir(paths);
  const ctx = generationContext(input);
  const snapshot = withEvidenceLock(paths, () => {
    requireGenerationForArtifacts(paths, ctx);
    const receipts = loadReceiptsUnlocked(paths, ctx);
    const marker = loadMarkerUnlocked(paths, ctx);
    return { receipts, marker };
  });
  if (!snapshot.marker) return { action: 'nothing_to_recover', receipt: null };
  const terminal = snapshot.receipts.find(receipt => receipt.cellId === snapshot.marker.cellId) ?? null;
  if (terminal) {
    return withEvidenceLock(paths, () => {
      const currentReceipts = loadReceiptsUnlocked(paths, ctx);
      const currentMarker = loadMarkerUnlocked(paths, ctx);
      const currentReceipt = currentReceipts.find(receipt => receipt.cellId === snapshot.marker.cellId) ?? null;
      if (!currentReceipt) fail('terminal receipt changed during recovery; refusing marker cleanup');
      if (!currentMarker) return { action: 'already_terminal', receipt: currentReceipt };
      if (!isDeepStrictEqual(currentMarker, snapshot.marker)) {
        fail('in-flight marker changed during recovery; refusing marker cleanup');
      }
      removeDurably(paths.marker, 'in-flight marker');
      return { action: 'stale_marker_cleared', receipt: currentReceipt };
    });
  }
  if (typeof processesDead !== 'function') fail('recovery requires an injected owned-process liveness proof');
  let dead = false;
  try { dead = await processesDead(JSON.parse(JSON.stringify(snapshot.marker))); } catch { dead = false; }
  if (dead !== true) fail('owned process liveness is uncertain; marker remains and replay stays forbidden');

  return withEvidenceLock(paths, () => {
    const currentReceipts = loadReceiptsUnlocked(paths, ctx);
    const currentMarker = loadMarkerUnlocked(paths, ctx);
    const currentReceipt = currentReceipts.find(receipt => receipt.cellId === snapshot.marker.cellId) ?? null;
    if (currentReceipt) {
      if (currentMarker) {
        if (!isDeepStrictEqual(currentMarker, snapshot.marker)) {
          fail('in-flight marker changed during recovery; refusing marker cleanup');
        }
        removeDurably(paths.marker, 'in-flight marker');
        return { action: 'stale_marker_cleared', receipt: currentReceipt };
      }
      return { action: 'already_terminal', receipt: currentReceipt };
    }
    if (!currentMarker || !isDeepStrictEqual(currentMarker, snapshot.marker)) {
      fail('in-flight marker changed during recovery; refusing to synthesize evidence');
    }
    const unknownReceipt = createUnknownCodeEvalPairReceipt({
      campaign: ctx.campaign,
      execution: ctx.execution,
      cell: currentMarker.cell,
      recordedAt,
    });
    appendReceiptUnlocked(paths, unknownReceipt, ctx, currentMarker);
    removeDurably(paths.marker, 'in-flight marker');
    return { action: 'sealed_unknown', receipt: unknownReceipt };
  });
}

export const codeEvalPairEvidenceProtocols = Object.freeze({
  generation: PAIR_GENERATION_PROTOCOL,
  marker: PAIR_MARKER_PROTOCOL,
});
