// Spend-free, public synthetic fixture validation for Code Harness Eval v1a.
// No provider/configuration module is imported here. The only child process is
// the content-bound Node verifier, invoked directly (never through a shell).
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_EVAL_FIXTURE_PROTOCOL = 'code-eval-fixture/v1a';
export const CODE_EVAL_FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/code-eval-v1', import.meta.url));
export const DEFAULT_CODE_EVAL_FIXTURE = join(CODE_EVAL_FIXTURE_ROOT, 'simple-bounded-parser-fix');
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_CLASSES = new Set(['simple', 'balanced', 'difficult']);
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TREE_BYTES = 128 * 1024;
const PRIVATE_PART = /^(?:\.git|\.camus|\.claude|\.codex|\.ssh|\.aws|\.azure|credentials?|secrets?|passwords?)$/i;
const SECRET_CONTENT = /(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:^|\n)\s*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:])/i;
const NETWORK_CODE = /(?:\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bnode:(?:http|https|http2|net|tls|dgram|dns)\b|https?:\/\/)/i;
const UNSAFE_RUNTIME_CODE = /(?:\b(?:eval|Function)\s*\(|\bimport\s*\(|\brequire\s*\(|\bprocess\.|\bnode:(?!assert\/strict(?:['"]|\b)|test(?:['"]|\b))[a-z0-9_/.-]+)/i;
const MANIFEST_FIELDS = ['schemaVersion', 'fixtureProtocol', 'caseId', 'caseVersion', 'taskClass', 'safeForExternalModels', 'task', 'acceptanceContract', 'baseFiles', 'referenceFiles', 'verifier'];
const VERIFIER_FIELDS = ['runtime', 'argv', 'timeoutMs', 'outputLimitBytes', 'networkPolicy', 'expectedBase', 'expectedReference', 'targetedBaseFailure'];
const canonicalValue = value => Array.isArray(value) ? value.map(canonicalValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])) : value;
const canonical = value => JSON.stringify(canonicalValue(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unsupported or missing fields.`);
}

function nonempty(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`${label} must be bounded non-empty text.`);
  return value;
}

function safePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\0') || value.includes('\\') || isAbsolute(value)) throw new Error(`${label} must be a safe relative path.`);
  const parts = value.split('/');
  if (parts.some(part => !SAFE_PART.test(part) || part === '.' || part === '..' || PRIVATE_PART.test(part))) throw new Error(`${label} must be a safe relative path.`);
  return parts.join('/');
}

function validateFileRows(rows, label) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 16) throw new Error(`${label} must contain 1-16 files.`);
  const seen = new Set();
  return rows.map((row, index) => {
    exactFields(row, ['path', 'sha256', 'content'], `${label}[${index}]`);
    const path = safePath(row.path, `${label}[${index}].path`);
    if (seen.has(path) || !SHA256.test(row.sha256) || typeof row.content !== 'string'
        || Buffer.byteLength(row.content) > MAX_FILE_BYTES || sha256(row.content) !== row.sha256) {
      throw new Error(`${label} contains a duplicate path, invalid content, or content digest mismatch.`);
    }
    if (SECRET_CONTENT.test(row.content) || NETWORK_CODE.test(row.content) || UNSAFE_RUNTIME_CODE.test(row.content)) throw new Error(`${label} contains non-public, credential-shaped, network-using, or unsafe runtime content.`);
    if (path.endsWith('.mjs')) for (const match of row.content.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (!['node:assert/strict', 'node:test'].includes(match[1]) && !match[1].startsWith('./') && !match[1].startsWith('../')) {
        throw new Error(`${label} contains an undeclared runtime dependency.`);
      }
    }
    seen.add(path);
    return { path, sha256: row.sha256, content: row.content };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export function validateCodeEvalFixtureManifest(value) {
  exactFields(value, MANIFEST_FIELDS, 'fixture manifest');
  if (value.schemaVersion !== 1 || value.fixtureProtocol !== CODE_EVAL_FIXTURE_PROTOCOL || value.caseVersion !== 1) throw new Error('Fixture protocol/version is unsupported.');
  if (!SAFE_ID.test(value.caseId ?? '') || !TASK_CLASSES.has(value.taskClass) || value.safeForExternalModels !== true) throw new Error('Fixture identity or external-safety declaration is invalid.');
  nonempty(value.task, 'task', 4000); nonempty(value.acceptanceContract, 'acceptanceContract', 4000);
  if (SECRET_CONTENT.test(value.task) || SECRET_CONTENT.test(value.acceptanceContract) || NETWORK_CODE.test(value.task) || NETWORK_CODE.test(value.acceptanceContract)) throw new Error('Fixture task and contract must be public and network-independent.');
  const baseFiles = Object.freeze(validateFileRows(value.baseFiles, 'baseFiles').map(Object.freeze));
  const referenceFiles = Object.freeze(validateFileRows(value.referenceFiles, 'referenceFiles').map(Object.freeze));
  if ([...baseFiles, ...referenceFiles].reduce((total, file) => total + Buffer.byteLength(file.content), 0) > MAX_TREE_BYTES) throw new Error('Fixture content exceeds the tree size limit.');
  const basePaths = new Set(baseFiles.map(item => item.path));
  if (referenceFiles.some(item => !basePaths.has(item.path))) throw new Error('Reference files may only replace declared base files.');
  exactFields(value.verifier, VERIFIER_FIELDS, 'verifier');
  const verifier = value.verifier;
  if (verifier.runtime !== 'node' || verifier.networkPolicy !== 'deny' || verifier.expectedBase !== 'red' || verifier.expectedReference !== 'green'
      || !Number.isSafeInteger(verifier.timeoutMs) || verifier.timeoutMs < 100 || verifier.timeoutMs > 30_000
      || !Number.isSafeInteger(verifier.outputLimitBytes) || verifier.outputLimitBytes < 1024 || verifier.outputLimitBytes > 128 * 1024
      || !Array.isArray(verifier.argv) || verifier.argv.length !== 2 || verifier.argv[0] !== '--test'
      || safePath(verifier.argv[1], 'verifier test path') !== verifier.argv[1] || !basePaths.has(verifier.argv[1])
      || typeof verifier.targetedBaseFailure !== 'string' || verifier.targetedBaseFailure.length < 8 || verifier.targetedBaseFailure.length > 120) {
    throw new Error('Verifier must be a bounded, network-denied direct Node test argv.');
  }
  return Object.freeze({ ...value, baseFiles, referenceFiles, verifier: Object.freeze({ ...verifier, argv: Object.freeze([...verifier.argv]) }) });
}

function treeDigest(files) {
  return `sha256:${sha256(canonical(files.map(({ path, sha256: digest }) => ({ path, sha256: digest }))))}`;
}

export async function loadCodeEvalFixture(root = DEFAULT_CODE_EVAL_FIXTURE) {
  const requestedRoot = resolve(root), requestedInfo = await lstat(requestedRoot);
  if (requestedInfo.isSymbolicLink()) throw new Error('Fixture root must be a real directory.');
  const canonicalRoot = await realpath(requestedRoot);
  const info = await lstat(canonicalRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Fixture root must be a real directory.');
  const entries = await readdir(canonicalRoot);
  if (entries.length !== 1 || entries[0] !== 'fixture.json' || !(await lstat(join(canonicalRoot, 'fixture.json'))).isFile()) throw new Error('Fixture directory may contain only its regular content-bound fixture.json.');
  const raw = await readFile(join(canonicalRoot, 'fixture.json'), 'utf8');
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Fixture manifest exceeds the size limit.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Fixture manifest is not valid JSON.'); }
  const manifest = validateCodeEvalFixtureManifest(parsed);
  const baseFiles = Object.freeze(manifest.baseFiles.map(Object.freeze));
  const referenceFiles = Object.freeze(manifest.referenceFiles.map(Object.freeze));
  const baseTreeDigest = treeDigest(baseFiles), referencePatchDigest = treeDigest(referenceFiles);
  const final = new Map(baseFiles.map(file => [file.path, file])); for (const file of referenceFiles) final.set(file.path, file);
  const referenceTreeDigest = treeDigest([...final.values()].sort((a, b) => a.path.localeCompare(b.path)));
  const taskSha256 = `sha256:${sha256(manifest.task)}`, acceptanceContractSha256 = `sha256:${sha256(manifest.acceptanceContract)}`;
  const verifierDigest = `sha256:${sha256(canonical(manifest.verifier))}`;
  const fixtureId = `fixture1:${sha256(canonical({ protocol: CODE_EVAL_FIXTURE_PROTOCOL, caseId: manifest.caseId, caseVersion: manifest.caseVersion,
    taskClass: manifest.taskClass, taskSha256, acceptanceContractSha256, baseTreeDigest, referencePatchDigest, referenceTreeDigest, verifierDigest }))}`;
  return Object.freeze({ manifest, baseFiles, referenceFiles, fixtureId, baseTreeDigest, referencePatchDigest, referenceTreeDigest,
    taskSha256, acceptanceContractSha256, verifierDigest });
}

export function codeEvalFixturePath(caseId, fixtureRoot = CODE_EVAL_FIXTURE_ROOT) {
  if (typeof caseId !== 'string' || !SAFE_ID.test(caseId)) throw new Error('Fixture case id is invalid.');
  return join(resolve(fixtureRoot), caseId);
}

export async function loadCodeEvalFixtureForCase(caseId, fixtureRoot = CODE_EVAL_FIXTURE_ROOT) {
  const fixture = await loadCodeEvalFixture(codeEvalFixturePath(caseId, fixtureRoot));
  if (fixture.manifest.caseId !== caseId) throw new Error('Fixture directory and manifest case id differ.');
  return fixture;
}

export async function materializeCodeEvalFixture(fixture, destination, { reference = false } = {}) {
  if (!fixture?.manifest || !Array.isArray(fixture.baseFiles) || !Array.isArray(fixture.referenceFiles)) throw new Error('Load the fixture before materializing it.');
  const target = resolve(destination); await mkdir(target, { recursive: false, mode: 0o700 });
  const canonicalTarget = await realpath(target);
  if ((await readdir(canonicalTarget)).length) throw new Error('Fixture destination must be a new empty directory.');
  const files = new Map(fixture.baseFiles.map(file => [file.path, file]));
  if (reference) for (const file of fixture.referenceFiles) files.set(file.path, file);
  for (const file of files.values()) {
    const path = join(canonicalTarget, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { flag: 'wx', mode: 0o600 });
  }
  return canonicalTarget;
}

async function runVerifier(fixture, cwd) {
  const { argv, timeoutMs, outputLimitBytes } = fixture.manifest.verifier;
  const sandboxed = process.platform === 'darwin' && process.arch === 'arm64';
  const profile = '(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)';
  const command = sandboxed ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = sandboxed ? ['-p', profile, process.execPath, ...argv] : [...argv];
  const privateHome = join(cwd, '.verifier-home'); await mkdir(privateHome, { mode: 0o700 });
  const env = { HOME: privateHome, TMPDIR: privateHome, TEMP: privateHome, TMP: privateHome, CI: '1', NO_COLOR: '1', TERM: 'dumb', LANG: 'C', LC_ALL: 'C' };
  return new Promise((resolvePromise, reject) => {
    let output = Buffer.alloc(0), outputBytes = 0, killed = null, spawnError = false;
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = reason => {
      if (killed) return; killed = reason;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const consume = chunk => { outputBytes += chunk.length; if (output.length < outputLimitBytes) output = Buffer.concat([output, chunk.subarray(0, outputLimitBytes - output.length)]); if (outputBytes > outputLimitBytes) kill('output_limit'); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { spawnError = true; });
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); if (spawnError) reject(new Error('Fixture verifier could not start.'));
      else resolvePromise({ code: Number.isInteger(code) ? code : null, output: output.toString('utf8'), outputBytes, killed,
        networkIsolation: sandboxed ? 'os_denied' : 'reviewed_fixture_no_network_code' }); });
  });
}

export async function codeEvalFixtureReadiness(root = DEFAULT_CODE_EVAL_FIXTURE) {
  const fixture = await loadCodeEvalFixture(root);
  const holder = await mkdtemp(join(tmpdir(), 'camus-code-eval-fixture-'));
  try {
    const base = await materializeCodeEvalFixture(fixture, join(holder, 'base'));
    const baseResult = await runVerifier(fixture, base);
    if (baseResult.killed || baseResult.code === 0 || !baseResult.output.includes(fixture.manifest.verifier.targetedBaseFailure)) throw new Error('Fixture base did not prove its targeted red behavior.');
    const reference = await materializeCodeEvalFixture(fixture, join(holder, 'reference'), { reference: true });
    const referenceResult = await runVerifier(fixture, reference);
    if (referenceResult.killed || referenceResult.code !== 0) throw new Error('Fixture reference did not prove its declared green behavior.');
    return Object.freeze({ schemaVersion: 1, fixtureProtocol: CODE_EVAL_FIXTURE_PROTOCOL, fixtureId: fixture.fixtureId,
      caseId: fixture.manifest.caseId, taskClass: fixture.manifest.taskClass, baseTreeDigest: fixture.baseTreeDigest,
      referencePatchDigest: fixture.referencePatchDigest, referenceTreeDigest: fixture.referenceTreeDigest,
      taskSha256: fixture.taskSha256, acceptanceContractSha256: fixture.acceptanceContractSha256,
      verifierDigest: fixture.verifierDigest, base: 'red', reference: 'green',
      verifierNetworkIsolation: referenceResult.networkIsolation, providerCallsMade: 0, ready: true });
  } finally { await rm(holder, { recursive: true, force: true }); }
}
