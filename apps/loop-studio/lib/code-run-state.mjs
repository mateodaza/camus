// Local-host ownership and authenticated, atomic checkpoints for advisory runs.
// No provider, project mutation, or admission authority lives in this module.
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { readFile, lstat, realpath, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMachineSalt, studioAtomicWrite } from './grandfather.mjs';

export const CODE_RUN_VERSION = 2;
export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const seal = (payload, create = false) => createHmac('sha256', loadMachineSalt({ create })).update(JSON.stringify(payload)).digest('hex');
export const codeCredentialRevision = (value) => seal({ purpose: 'code-credential-revision', value }, true);
const file = (dir) => join(dir, 'code-checkpoint.json');
const ownershipPort = (canonical) => 20000 + (parseInt(digest(canonical).slice(0, 8), 16) % 30000);

export async function readCodeCheckpoint(dir) {
  const info = await lstat(file(dir));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 24 * 1024 * 1024) throw new Error('Invalid coding checkpoint file.');
  const envelope = JSON.parse(await readFile(file(dir), 'utf8'));
  const { payload, mac } = envelope;
  if (payload?.version !== CODE_RUN_VERSION || !/^[a-f0-9]{64}$/.test(mac ?? '')
      || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(seal(payload), 'hex'))) throw new Error('Coding checkpoint integrity check failed.');
  if (!payload.runId || !payload.source?.repoPath || !payload.candidate?.worktree || !payload.binding
      || !['initialize', 'make', 'apply', 'verify', 'review', 'complete', 'refused'].includes(payload.phase)
      || !payload.limits || !payload.usage || !Array.isArray(payload.history) || !Array.isArray(payload.reads)
      || !Array.isArray(payload.created) || !Array.isArray(payload.attempts) || !payload.result?.seats
      || !payload.seats?.maker || !payload.seats?.reviewer) throw new Error('Incomplete coding checkpoint.');
  return payload;
}

export function saveCodeCheckpoint(dir, state) {
  state.revision = (state.revision ?? 0) + 1;
  state.updatedAt = Date.now();
  const serialized = JSON.stringify({ payload: state, mac: seal(state, true) });
  if (Buffer.byteLength(serialized) > 24 * 1024 * 1024) throw new Error('Coding checkpoint exceeded its private storage budget.');
  studioAtomicWrite(file(dir), serialized, 0o600);
}

export async function acquireCodeRun(dir) {
  const canonical = await realpath(dir);
  const port = ownershipPort(canonical);
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Coding run is busy or its local ownership port is unavailable. No second worker started.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return { generation: randomBytes(12).toString('hex'), release: () => new Promise((resolve) => server.close(resolve)) };
}

async function codeRunOwned(dir) {
  const port = ownershipPort(await realpath(dir));
  // Status must never briefly take the writer's lease and race a real resume.
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(true)); // uncertain ownership fails closed
  });
}

// One authenticated read plus the connect-only ownership observation. Consumers
// that need a richer read-only projection must not race two checkpoint reads or
// take the writer lease merely to inspect a run.
export async function readCodeRunSnapshot(dir) {
  const state = await readCodeCheckpoint(dir);
  return { state, owned: await codeRunOwned(dir) };
}

export async function codeRunStatus(dir) {
  const { state, owned } = await readCodeRunSnapshot(dir);
  return { runId: state.runId, status: state.status, phase: state.phase, owned,
    interrupted: state.status === 'running' && !owned, updatedAt: state.updatedAt,
    revision: state.revision, candidate: { ...state.candidate, diff: undefined }, question: state.question ?? null,
    reason: state.reason ?? null, usage: state.usage, limits: state.limits,
    resumable: !owned && !['complete', 'refused'].includes(state.phase) };
}

export async function requestCodeStop(dir) {
  const state = await readCodeCheckpoint(dir);
  studioAtomicWrite(join(dir, 'code-stop.json'), JSON.stringify({ generation: state.generation }), 0o600);
  return { runId: state.runId, stopRequested: true };
}

export async function codeStopRequested(dir, generation) {
  try { return JSON.parse(await readFile(join(dir, 'code-stop.json'), 'utf8')).generation === generation; }
  catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Cannot read coding stop request.'); }
}

export async function appendCodeEvent(dir, event) {
  await appendFile(join(dir, 'code-events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, { mode: 0o600 });
}
