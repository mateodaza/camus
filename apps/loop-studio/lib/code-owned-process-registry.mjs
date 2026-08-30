// Crash-safe, private ownership evidence for subprocesses started by the shared
// Build engine. The manifest is initialized before engine entry; every target
// gets a durable intent before its trusted supervisor is spawned.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { studioAtomicWrite, STUDIO_DIR_MODE, STUDIO_FILE_MODE } from './grandfather.mjs';

const PROTOCOL = 'code-owned-processes/v1';
const MANIFEST = 'manifest.json';
const SAFE_KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_ID = /^[a-f0-9]{32}$/;
const MAX_FILE_BYTES = 64 * 1024;

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(`owned process registry: ${message}`); };

function canonicalIso(value, label) {
  const date = new Date(value);
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
}

function regular(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || (info.mode & 0o777) !== STUDIO_FILE_MODE) {
    fail(`${label} must be a bounded private 0600 regular file`);
  }
}

function readJson(path, label) {
  regular(path, label);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail(`${label} is malformed`); }
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.join('\0') !== expected.join('\0')) fail(`${label} has missing or unknown fields`);
}

export function codeOwnedProcessRegistryPaths(runDir) {
  const requested = resolve(runDir);
  // The Build engine canonicalizes its private receipt directory. Do the same
  // here so a platform alias such as macOS /var -> /private/var cannot make the
  // same directory appear to have two different durable run bindings.
  const run = existsSync(requested) ? realpathSync(requested) : requested;
  const dir = join(run, 'owned-processes');
  return Object.freeze({ run, dir, manifest: join(dir, MANIFEST) });
}

function runBinding(paths) { return hash(`${paths.run}\0${PROTOCOL}`); }

function ensureDir(paths) {
  const existed = existsSync(paths.dir);
  if (!existed) mkdirSync(paths.dir, { recursive: true, mode: STUDIO_DIR_MODE });
  const info = lstatSync(paths.dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== STUDIO_DIR_MODE) {
    fail('directory must be a private 0700 non-symlink directory');
  }
  if (!existed) chmodSync(paths.dir, STUDIO_DIR_MODE);
}

function validateManifest(value, paths) {
  exact(value, ['schemaVersion', 'protocol', 'runBinding', 'intentIds'], 'manifest');
  if (value.schemaVersion !== 1 || value.protocol !== PROTOCOL || value.runBinding !== runBinding(paths)
      || !Array.isArray(value.intentIds) || new Set(value.intentIds).size !== value.intentIds.length
      || value.intentIds.some(id => !SAFE_ID.test(id))) fail('manifest does not bind the exact run and intent roster');
  return value;
}

function readManifest(paths) {
  if (!existsSync(paths.manifest)) fail('manifest is missing');
  return validateManifest(readJson(paths.manifest, 'manifest'), paths);
}

export function initializeCodeOwnedProcessRegistry(runDir) {
  const paths = codeOwnedProcessRegistryPaths(runDir);
  ensureDir(paths);
  const expected = { schemaVersion: 1, protocol: PROTOCOL, runBinding: runBinding(paths), intentIds: [] };
  if (!existsSync(paths.manifest)) studioAtomicWrite(paths.manifest, `${JSON.stringify(expected, null, 2)}\n`, STUDIO_FILE_MODE);
  readManifest(paths);
  return paths;
}

function validateEndpoint(value, label) {
  if (value === null) return;
  exact(value, ['pid', 'birth'], label);
  if (!Number.isSafeInteger(value.pid) || value.pid < 2 || typeof value.birth !== 'string' || !value.birth.trim() || value.birth.length > 128) {
    fail(`${label} has invalid process identity`);
  }
}

export function validateCodeOwnedProcessIntent(value, paths) {
  exact(value, ['schemaVersion', 'protocol', 'runBinding', 'intentId', 'kind', 'createdAt',
    'state', 'supervisor', 'target', 'cleanup'], 'intent');
  if (value.schemaVersion !== 1 || value.protocol !== PROTOCOL || value.runBinding !== runBinding(paths)
      || !SAFE_ID.test(value.intentId) || !SAFE_KIND.test(value.kind)
      || !['intent', 'supervisor_ready', 'active', 'cleaned'].includes(value.state)) fail('intent identity or state is invalid');
  canonicalIso(value.createdAt, 'intent.createdAt');
  validateEndpoint(value.supervisor, 'intent.supervisor'); validateEndpoint(value.target, 'intent.target');
  if (value.cleanup !== null) {
    exact(value.cleanup, ['complete', 'reason', 'recordedAt'], 'intent.cleanup');
    if (value.cleanup.complete !== true || typeof value.cleanup.reason !== 'string' || !value.cleanup.reason
        || value.cleanup.reason.length > 128) fail('intent cleanup is invalid');
    canonicalIso(value.cleanup.recordedAt, 'intent.cleanup.recordedAt');
  }
  if (value.state === 'intent' && (value.supervisor !== null || value.target !== null || value.cleanup !== null)) fail('fresh intent carries process evidence');
  if (value.state === 'supervisor_ready' && (value.supervisor === null || value.target !== null || value.cleanup !== null)) fail('supervisor-ready intent is inconsistent');
  if (value.state === 'active' && (value.supervisor === null || value.target === null || value.cleanup !== null)) fail('active intent is inconsistent');
  if (value.state === 'cleaned' && (value.cleanup?.complete !== true
      || (value.supervisor === null && !['prelaunch_abandoned', 'supervisor_spawn_failed'].includes(value.cleanup.reason)))) {
    fail('cleaned intent lacks terminal proof');
  }
  return value;
}

function intentPath(paths, id) { return join(paths.dir, `${id}.json`); }

export function createCodeOwnedProcessIntent(runDir, kind, { createdAt = new Date().toISOString(), intentId = randomBytes(16).toString('hex') } = {}) {
  const paths = initializeCodeOwnedProcessRegistry(runDir);
  if (!SAFE_KIND.test(kind) || !SAFE_ID.test(intentId)) fail('intent kind or id is invalid');
  canonicalIso(createdAt, 'intent.createdAt');
  const manifest = readManifest(paths);
  if (manifest.intentIds.includes(intentId) || existsSync(intentPath(paths, intentId))) fail('duplicate intent id');
  const value = { schemaVersion: 1, protocol: PROTOCOL, runBinding: runBinding(paths), intentId, kind,
    createdAt, state: 'intent', supervisor: null, target: null, cleanup: null };
  studioAtomicWrite(intentPath(paths, intentId), `${JSON.stringify(value, null, 2)}\n`, STUDIO_FILE_MODE);
  manifest.intentIds.push(intentId);
  studioAtomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, STUDIO_FILE_MODE);
  return { paths, path: intentPath(paths, intentId), intent: clone(value) };
}

export function readCodeOwnedProcessIntent(path) {
  const dir = dirname(resolve(path)), run = dirname(dir), paths = codeOwnedProcessRegistryPaths(run);
  if (paths.dir !== dir || basename(path) === MANIFEST) fail('intent path is outside an exact registry');
  const manifest = readManifest(paths), value = validateCodeOwnedProcessIntent(readJson(path, 'intent'), paths);
  if (!manifest.intentIds.includes(value.intentId) || intentPath(paths, value.intentId) !== resolve(path)) fail('intent is outside the manifest roster');
  return { paths, value };
}

export function updateCodeOwnedProcessIntent(path, update) {
  const { paths, value } = readCodeOwnedProcessIntent(path);
  const next = update(clone(value));
  validateCodeOwnedProcessIntent(next, paths);
  if (next.intentId !== value.intentId || next.kind !== value.kind || next.createdAt !== value.createdAt) fail('intent immutable identity changed');
  studioAtomicWrite(resolve(path), `${JSON.stringify(next, null, 2)}\n`, STUDIO_FILE_MODE);
  return clone(next);
}

function claimPath(path) { return resolve(path).replace(/\.json$/, '.claim.json'); }

export function claimCodeOwnedProcessLaunch(path, owner, supervisor = null) {
  const { value } = readCodeOwnedProcessIntent(path);
  if (!['supervisor', 'recovery'].includes(owner)) fail('launch claim owner is invalid');
  if ((owner === 'supervisor') !== (supervisor !== null)) fail('supervisor launch claims require exact process identity');
  validateEndpoint(supervisor, 'launch claim supervisor');
  let fd;
  try {
    fd = openSync(claimPath(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0), STUDIO_FILE_MODE);
    writeSync(fd, `${JSON.stringify({ schemaVersion: 1, intentId: value.intentId, owner, supervisor })}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  chmodSync(claimPath(path), STUDIO_FILE_MODE);
  return true;
}

function launchClaim(path) {
  if (!existsSync(claimPath(path))) return null;
  const value = readJson(claimPath(path), 'launch claim');
  exact(value, ['schemaVersion', 'intentId', 'owner', 'supervisor'], 'launch claim');
  if (value.schemaVersion !== 1 || !['supervisor', 'recovery'].includes(value.owner)
      || (value.owner === 'supervisor') !== (value.supervisor !== null)) fail('launch claim is invalid');
  validateEndpoint(value.supervisor, 'launch claim supervisor');
  return value;
}

function exactProcessDead(endpoint) {
  if (!endpoint) return false;
  try {
    const current = execFileSync('/bin/ps', ['-p', String(endpoint.pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return !current || current !== endpoint.birth;
  } catch (error) {
    return error.status === 1 || error.code === 'ESRCH';
  }
}

export function reconcileCodeOwnedProcessPrelaunch(runDir) {
  const status = codeOwnedProcessCleanupStatus(runDir);
  if (status.reason === 'registry_invalid' || status.reason === 'registry_missing') return status;
  const paths = codeOwnedProcessRegistryPaths(runDir);
  for (const intent of status.intents.filter(value => value.state === 'intent')) {
    const path = intentPath(paths, intent.intentId);
    let reason = 'prelaunch_abandoned';
    let deadSupervisor = null;
    if (!claimCodeOwnedProcessLaunch(path, 'recovery')) {
      let claim;
      try { claim = launchClaim(path); } catch { return { complete: false, reason: 'registry_invalid', intents: [] }; }
      if (claim?.owner !== 'supervisor' || claim.intentId !== intent.intentId || !exactProcessDead(claim.supervisor)) continue;
      reason = 'prelaunch_supervisor_dead';
      deadSupervisor = claim.supervisor;
    }
    updateCodeOwnedProcessIntent(path, current => {
      if (current.state !== 'intent') return current;
      return { ...current, state: 'cleaned', supervisor: deadSupervisor, cleanup: { complete: true,
        reason, recordedAt: new Date().toISOString() } };
    });
  }
  return codeOwnedProcessCleanupStatus(runDir);
}

export function codeOwnedProcessCleanupStatus(runDir) {
  let paths;
  try { paths = codeOwnedProcessRegistryPaths(runDir); }
  catch { return { complete: false, reason: 'registry_invalid', intents: [] }; }
  try {
    if (!existsSync(paths.dir) || !existsSync(paths.manifest)) return { complete: false, reason: 'registry_missing', intents: [] };
    const info = lstatSync(paths.dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== STUDIO_DIR_MODE) fail('directory is invalid');
    const manifest = readManifest(paths);
    const entries = readdirSync(paths.dir).filter(name => name !== MANIFEST).sort();
    const claims = entries.filter(name => name.endsWith('.claim.json'));
    if (claims.some(name => !manifest.intentIds.includes(name.slice(0, -'.claim.json'.length)))) fail('launch claim is outside the manifest roster');
    for (const name of claims) {
      const value = readJson(join(paths.dir, name), 'launch claim');
      exact(value, ['schemaVersion', 'intentId', 'owner', 'supervisor'], 'launch claim');
      if (value.schemaVersion !== 1 || !manifest.intentIds.includes(value.intentId)
          || !['supervisor', 'recovery'].includes(value.owner)
          || (value.owner === 'supervisor') !== (value.supervisor !== null)
          || name !== `${value.intentId}.claim.json`) fail('launch claim is invalid');
      validateEndpoint(value.supervisor, 'launch claim supervisor');
    }
    const actual = entries.filter(name => !name.endsWith('.claim.json'));
    const expected = manifest.intentIds.map(id => `${id}.json`).sort();
    if (actual.join('\0') !== expected.join('\0')) fail('intent files differ from the manifest roster');
    const intents = manifest.intentIds.map(id => validateCodeOwnedProcessIntent(readJson(intentPath(paths, id), 'intent'), paths));
    const complete = intents.every(intent => intent.state === 'cleaned' && intent.cleanup?.complete === true);
    return { complete, reason: complete ? 'all_intents_cleaned' : 'intent_cleanup_incomplete', intents: clone(intents) };
  } catch {
    return { complete: false, reason: 'registry_invalid', intents: [] };
  }
}

export const codeOwnedProcessRegistryProtocol = PROTOCOL;
