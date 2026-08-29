// Private, provider-free persistence for the one-cell Code Harness Eval v1a.
//
// The marker is written before a caller is allowed to start provider work. A
// marker without a receipt always blocks another attempt. Recovery can only seal
// that cell as unknown after an injected process-liveness proof says every owned
// process is dead; it never invokes or retries work itself.

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
import { dirname, join, resolve } from 'node:path';

import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';
import {
  codeEvalCampaignIdentity,
  codeEvalCellIdentity,
  codeEvalExecutionIdentity,
  codeEvalIdPatterns,
  createCodeEvalCell,
  createUnknownCodeEvalReceipt,
  validateCodeEvalCell,
  validateCodeEvalExecution,
  validateCodeEvalReceipt,
} from './code-eval-contract.mjs';

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

function fail(message) {
  throw new Error(`code eval evidence: ${message}`);
}

function exactObject(value, path, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length) fail(`${path} contains unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (missing.length) fail(`${path} is missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  return value;
}

function canonicalIso(value, field) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(parsed.valueOf())
      || parsed.toISOString() !== value) {
    fail(`${field} must be a canonical ISO timestamp`);
  }
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

function fsyncPath(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // The atomic bytes/rename already landed. Some filesystems reject directory
    // fsync; match the existing Studio durability boundary's behavior.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function removeDurably(path) {
  if (!existsSync(path)) return false;
  fileInfo(path, MAX_MARKER_BYTES, 'in-flight marker');
  unlinkSync(path);
  fsyncPath(dirname(path));
  return true;
}

export function codeEvalEvidencePaths(root) {
  if (typeof root !== 'string' || !root.trim()) fail('evidence root must be a non-empty path');
  const dir = resolve(root);
  return Object.freeze({
    dir,
    ledger: join(dir, 'receipts.jsonl'),
    marker: join(dir, 'inflight.json'),
    lock: join(dir, 'evidence.lock'),
  });
}

export function ensureCodeEvalEvidenceDir(paths) {
  exactObject(paths, 'paths', ['dir', 'ledger', 'marker', 'lock']);
  const existed = existsSync(paths.dir);
  if (!existed) mkdirSync(paths.dir, { recursive: true, mode: STUDIO_DIR_MODE });
  const info = lstatSync(paths.dir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('evidence root must be a regular directory');
  if (existed && (info.mode & 0o777) !== STUDIO_DIR_MODE) {
    fail('existing evidence root permissions must already be 0700');
  }
  if (!existed) chmodSync(paths.dir, STUDIO_DIR_MODE);
  if ((lstatSync(paths.dir).mode & 0o777) !== STUDIO_DIR_MODE) fail('evidence root permissions must be 0700');
  if ([paths.ledger, paths.marker, paths.lock].some((path) => dirname(path) !== paths.dir)) {
    fail('ledger, marker, and lock must live directly under the evidence root');
  }
  return paths;
}

function readLock(path) {
  fileInfo(path, MAX_MARKER_BYTES, 'evidence lock');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`evidence lock is malformed and cannot be stolen: ${error.message}`); }
  exactObject(value, 'evidence lock', ['schemaVersion', 'owner', 'nonce', 'acquiredAt']);
  if (value.schemaVersion !== 1 || !/^pid-[1-9][0-9]{0,9}$/.test(value.owner ?? '')
      || !/^[a-f0-9]{32}$/.test(value.nonce ?? '')) fail('evidence lock identity is invalid and cannot be stolen');
  canonicalIso(value.acquiredAt, 'evidence lock.acquiredAt');
  return value;
}

export function acquireCodeEvalEvidenceLock(paths, {
  owner = `pid-${process.pid}`,
  acquiredAt = new Date().toISOString(),
} = {}) {
  ensureCodeEvalEvidenceDir(paths);
  if (!/^pid-[1-9][0-9]{0,9}$/.test(owner)) fail('lock owner must be pid-<positive integer>');
  canonicalIso(acquiredAt, 'evidence lock.acquiredAt');
  const value = {
    schemaVersion: 1,
    owner,
    nonce: randomBytes(16).toString('hex'),
    acquiredAt,
  };
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
      // Validate only for a useful diagnostic. A malformed or abandoned lock is
      // intentionally not removed: v1a never guesses that another writer died.
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

export async function recoverAbandonedCodeEvalEvidenceLock(paths, { ownerDead } = {}) {
  ensureCodeEvalEvidenceDir(paths);
  if (!existsSync(paths.lock)) return { action: 'no_lock' };
  const abandoned = readLock(paths.lock);
  if (typeof ownerDead !== 'function') fail('explicit lock recovery requires an owner liveness proof');
  let dead = false;
  try { dead = await ownerDead({ ...abandoned }); } catch { dead = false; }
  if (dead !== true) fail('evidence lock owner liveness is uncertain; the lock was not stolen');
  if (!existsSync(paths.lock)) return { action: 'no_lock' };
  const current = readLock(paths.lock);
  if (current.owner !== abandoned.owner || current.nonce !== abandoned.nonce
      || current.acquiredAt !== abandoned.acquiredAt) {
    fail('evidence lock changed during recovery; refusing to remove another writer\'s lock');
  }
  unlinkSync(paths.lock);
  fsyncPath(paths.dir);
  return { action: 'stale_lock_cleared', owner: abandoned.owner };
}

function withEvidenceLock(paths, action) {
  const lease = acquireCodeEvalEvidenceLock(paths);
  try { return action(); }
  finally { lease.release(); }
}

function context({ campaign, execution, cell = null }) {
  validateCodeEvalExecution(execution, campaign);
  const resolvedCell = cell ?? createCodeEvalCell(campaign, execution);
  validateCodeEvalCell(resolvedCell, campaign, execution);
  return {
    campaign,
    execution,
    cell: resolvedCell,
    campaignDigest: codeEvalCampaignIdentity(campaign),
    executionDigest: codeEvalExecutionIdentity(execution, campaign),
    cellId: codeEvalCellIdentity(resolvedCell, campaign, execution),
  };
}

function parseLedgerLine(line, index, ctx) {
  let receipt;
  try { receipt = JSON.parse(line); }
  catch (error) { fail(`ledger line ${index + 1} is malformed JSON: ${error.message}`); }
  try { return validateCodeEvalReceipt(receipt, ctx.campaign, ctx.execution, ctx.cell); }
  catch (error) { fail(`ledger line ${index + 1} is invalid or mixed-generation: ${error.message}`); }
}

export function loadCodeEvalReceipts(paths, input) {
  ensureCodeEvalEvidenceDir(paths);
  const ctx = context(input);
  if (!existsSync(paths.ledger)) return [];
  fileInfo(paths.ledger, MAX_LEDGER_BYTES, 'ledger');
  const text = readFileSync(paths.ledger, 'utf8');
  if (!text) return [];
  if (!text.endsWith('\n')) fail('ledger has a partial final line');
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => !line)) fail('ledger contains an empty record');
  const receipts = lines.map((line, index) => parseLedgerLine(line, index, ctx));
  const receiptIds = new Set();
  const cellIds = new Set();
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.receiptId)) fail(`duplicate receipt ${receipt.receiptId}`);
    if (cellIds.has(receipt.cellId)) fail(`duplicate cell ${receipt.cellId}`);
    receiptIds.add(receipt.receiptId);
    cellIds.add(receipt.cellId);
  }
  if (receipts.length > 1) fail('v1a ledger may contain at most one native-smoke receipt');
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

function appendCodeEvalReceiptUnlocked(paths, receipt, input) {
  ensureCodeEvalEvidenceDir(paths);
  const ctx = context(input);
  validateCodeEvalReceipt(receipt, ctx.campaign, ctx.execution, ctx.cell);
  const existing = loadCodeEvalReceipts(paths, ctx);
  if (existing.some((row) => row.receiptId === receipt.receiptId)) fail(`duplicate receipt ${receipt.receiptId}`);
  if (existing.some((row) => row.cellId === receipt.cellId)) fail(`duplicate cell ${receipt.cellId}`);
  if (existing.length) fail('v1a ledger already contains its one allowed receipt');
  appendLineDurably(paths.ledger, `${JSON.stringify(receipt)}\n`);
  // Re-read from disk before returning so a partial/corrupt append cannot be
  // treated as terminal evidence by a caller clearing the marker.
  const persisted = loadCodeEvalReceipts(paths, ctx);
  if (persisted.length !== 1 || persisted[0].receiptId !== receipt.receiptId) {
    fail('persisted receipt did not validate after append');
  }
  return persisted[0];
}

export function appendCodeEvalReceipt(paths, receipt, input) {
  return withEvidenceLock(paths, () => appendCodeEvalReceiptUnlocked(paths, receipt, input));
}

export function createCodeEvalInflightMarker({
  campaign,
  execution,
  cell = createCodeEvalCell(campaign, execution),
  buildRunId,
  supervisorIdentity,
  maximumProviderCallsReserved,
  startedAt = new Date().toISOString(),
}) {
  const ctx = context({ campaign, execution, cell });
  safeValue(buildRunId, 'marker.buildRunId');
  if (!/^pid-[1-9][0-9]{0,9}$/.test(supervisorIdentity ?? '')) {
    fail('marker.supervisorIdentity must be pid-<positive integer>');
  }
  if (!Number.isSafeInteger(maximumProviderCallsReserved) || maximumProviderCallsReserved < 1
      || maximumProviderCallsReserved > campaign.controls.maximumProviderCallsPerCell) {
    fail('marker.maximumProviderCallsReserved exceeds the frozen positive call bound');
  }
  canonicalIso(startedAt, 'marker.startedAt');
  return {
    schemaVersion: 1,
    campaignDigest: ctx.campaignDigest,
    executionDigest: ctx.executionDigest,
    cellId: ctx.cellId,
    buildRunId,
    supervisorIdentity,
    maximumProviderCallsReserved,
    startedAt,
  };
}

export function validateCodeEvalInflightMarker(marker, input) {
  const ctx = context(input);
  exactObject(marker, 'marker', [
    'schemaVersion', 'campaignDigest', 'executionDigest', 'cellId', 'buildRunId',
    'supervisorIdentity', 'maximumProviderCallsReserved', 'startedAt',
  ]);
  if (marker.schemaVersion !== 1) fail('marker.schemaVersion must be 1');
  if (!codeEvalIdPatterns.campaign.test(marker.campaignDigest ?? '')) fail('marker.campaignDigest is invalid');
  if (!codeEvalIdPatterns.execution.test(marker.executionDigest ?? '')) fail('marker.executionDigest is invalid');
  if (!codeEvalIdPatterns.cell.test(marker.cellId ?? '')) fail('marker.cellId is invalid');
  if (marker.campaignDigest !== ctx.campaignDigest || marker.executionDigest !== ctx.executionDigest
      || marker.cellId !== ctx.cellId) fail('marker is from a different campaign, execution, or cell');
  safeValue(marker.buildRunId, 'marker.buildRunId');
  if (!/^pid-[1-9][0-9]{0,9}$/.test(marker.supervisorIdentity ?? '')) {
    fail('marker.supervisorIdentity must be pid-<positive integer>');
  }
  if (!Number.isSafeInteger(marker.maximumProviderCallsReserved)
      || marker.maximumProviderCallsReserved < 1
      || marker.maximumProviderCallsReserved > ctx.campaign.controls.maximumProviderCallsPerCell) {
    fail('marker.maximumProviderCallsReserved exceeds the frozen positive call bound');
  }
  canonicalIso(marker.startedAt, 'marker.startedAt');
  return marker;
}

export function loadCodeEvalInflightMarker(paths, input) {
  ensureCodeEvalEvidenceDir(paths);
  if (!existsSync(paths.marker)) return null;
  fileInfo(paths.marker, MAX_MARKER_BYTES, 'in-flight marker');
  let marker;
  try { marker = JSON.parse(readFileSync(paths.marker, 'utf8')); }
  catch (error) { fail(`in-flight marker is malformed: ${error.message}`); }
  return validateCodeEvalInflightMarker(marker, input);
}

export function reserveCodeEvalCell(paths, marker, input) {
  return withEvidenceLock(paths, () => {
    ensureCodeEvalEvidenceDir(paths);
    const ctx = context(input);
    validateCodeEvalInflightMarker(marker, ctx);
    const receipts = loadCodeEvalReceipts(paths, ctx);
    if (receipts.some((receipt) => receipt.cellId === ctx.cellId)) {
      fail('the one native-smoke cell already has a terminal receipt and can never replay');
    }
    if (existsSync(paths.marker)) {
      loadCodeEvalInflightMarker(paths, ctx); // validate before reporting the block
      fail('an unresolved in-flight marker already exists; the cell can never replay');
    }
    studioAtomicWrite(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, STUDIO_FILE_MODE);
    return loadCodeEvalInflightMarker(paths, ctx);
  });
}

export function codeEvalStatus(paths, input) {
  return withEvidenceLock(paths, () => {
    ensureCodeEvalEvidenceDir(paths);
    const ctx = context(input);
    const receipts = loadCodeEvalReceipts(paths, ctx);
    const marker = loadCodeEvalInflightMarker(paths, ctx);
    const receipt = receipts.find((row) => row.cellId === ctx.cellId) ?? null;

    if (receipt) {
      // The receipt was fsynced before marker removal. If the process crashed in
      // that narrow window, terminal evidence wins and cleanup is idempotent.
      const staleMarkerCleared = marker ? removeDurably(paths.marker) : false;
      return {
        state: 'complete',
        standing: receipt.standing,
        canAttempt: false,
        replayAllowed: false,
        staleMarkerCleared,
        cellId: ctx.cellId,
        receiptId: receipt.receiptId,
      };
    }
    if (marker) {
      return {
        state: 'paused_inflight_unknown',
        standing: 'unknown',
        canAttempt: false,
        replayAllowed: false,
        staleMarkerCleared: false,
        cellId: ctx.cellId,
        receiptId: null,
      };
    }
    return {
      state: 'pending',
      standing: null,
      canAttempt: true,
      replayAllowed: false,
      staleMarkerCleared: false,
      cellId: ctx.cellId,
      receiptId: null,
    };
  });
}

export async function recoverCodeEvalCell(paths, input, {
  processesDead,
  recordedAt = new Date().toISOString(),
} = {}) {
  ensureCodeEvalEvidenceDir(paths);
  const ctx = context(input);
  const receipts = loadCodeEvalReceipts(paths, ctx);
  const marker = loadCodeEvalInflightMarker(paths, ctx);
  const receipt = receipts.find((row) => row.cellId === ctx.cellId) ?? null;
  if (receipt) {
    if (!marker) return { action: 'already_terminal', receipt };
    return withEvidenceLock(paths, () => {
      const currentReceipts = loadCodeEvalReceipts(paths, ctx);
      const currentMarker = loadCodeEvalInflightMarker(paths, ctx);
      const currentReceipt = currentReceipts.find((row) => row.cellId === ctx.cellId) ?? null;
      if (!currentReceipt) fail('terminal receipt changed during recovery; refusing marker cleanup');
      const staleMarkerCleared = currentMarker ? removeDurably(paths.marker) : false;
      return { action: staleMarkerCleared ? 'stale_marker_cleared' : 'already_terminal', receipt: currentReceipt };
    });
  }
  if (!marker) fail('there is no unresolved in-flight marker to recover');
  if (typeof processesDead !== 'function') fail('recovery requires an injected owned-process liveness proof');
  let dead = false;
  try { dead = await processesDead({ ...marker }); } catch { dead = false; }
  if (dead !== true) fail('owned process liveness is uncertain; marker remains and replay stays forbidden');

  return withEvidenceLock(paths, () => {
    // Liveness was checked outside the filesystem lock. Re-read everything after
    // taking it: a real runner may have sealed a receipt while the proof ran.
    const currentReceipts = loadCodeEvalReceipts(paths, ctx);
    const currentMarker = loadCodeEvalInflightMarker(paths, ctx);
    const currentReceipt = currentReceipts.find((row) => row.cellId === ctx.cellId) ?? null;
    if (currentReceipt) {
      if (currentMarker) removeDurably(paths.marker);
      return { action: 'stale_marker_cleared', receipt: currentReceipt };
    }
    if (!currentMarker) fail('in-flight marker changed during recovery; refusing to synthesize evidence');
    if (currentMarker.buildRunId !== marker.buildRunId
        || currentMarker.supervisorIdentity !== marker.supervisorIdentity
        || currentMarker.startedAt !== marker.startedAt) {
      fail('in-flight marker changed during recovery; refusing to synthesize evidence');
    }
    const unknownReceipt = createUnknownCodeEvalReceipt({
      campaign: ctx.campaign,
      execution: ctx.execution,
      cell: ctx.cell,
      recordedAt,
    });
    appendCodeEvalReceiptUnlocked(paths, unknownReceipt, ctx);
    removeDurably(paths.marker);
    return { action: 'sealed_unknown', receipt: unknownReceipt };
  });
}
