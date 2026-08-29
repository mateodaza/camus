import { access, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { runNativeProcess } from './native-process.mjs';

export const QWEN_NATIVE_EXECUTOR = 'qwen_native';
export const GROK_NATIVE_EXECUTOR = 'grok_native';
export const HARNESS_NATIVE_EXECUTORS = Object.freeze([QWEN_NATIVE_EXECUTOR, GROK_NATIVE_EXECUTOR]);
export const HARNESS_POLICY_VERSION = 'native-harness-isolation/v1';
const versions = { [QWEN_NATIVE_EXECUTOR]: /^0\.22\.3(?:\s|$)/, [GROK_NATIVE_EXECUTOR]: /(?:^|\s)1\.0\.5(?:\s|$)/ };
const artifactPins = { [QWEN_NATIVE_EXECUTOR]: '51e46da04cbf833fedf0426ba8903a98f1ac269c0298a23df00b4c40a377300d',
  [GROK_NATIVE_EXECUTOR]: '3dfa7f04fbb5427a8fbead286591543aaecb478b3a0ab222c4329eca1a3b2f86' };
const defaults = { [QWEN_NATIVE_EXECUTOR]: 'qwen', [GROK_NATIVE_EXECUTOR]: 'grok' };
const overrides = { [QWEN_NATIVE_EXECUTOR]: 'CAMUS_QWEN_CODE_BIN', [GROK_NATIVE_EXECUTOR]: 'CAMUS_GROK_BUILD_BIN' };
const quote = value => JSON.stringify(String(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent + sep);

export function isHarnessNativeExecutor(value) { return HARNESS_NATIVE_EXECUTORS.includes(value); }

export async function resolveNativeHarness(executor, { env = process.env } = {}) {
  if (!isHarnessNativeExecutor(executor)) throw new Error('Unknown native harness executor.');
  const requested = env[overrides[executor]] || defaults[executor];
  const candidates = requested.includes('/') || isAbsolute(requested) ? [resolve(requested)]
    : String(env.PATH ?? '').split(':').filter(Boolean).map(path => join(path, requested));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* continue */ }
  }
  throw new Error(`${executor === QWEN_NATIVE_EXECUTOR ? 'Qwen Code' : 'Grok Build'} is not installed; no model was called.`);
}

export async function assertNativeHarnessArtifact(executor, harness) {
  if (process.arch !== 'arm64') throw new Error('The reviewed native harness artifacts currently require macOS arm64; no model was called.');
  if (executor === QWEN_NATIVE_EXECUTOR && Number(process.versions.node.split('.')[0]) < 22) throw new Error('Qwen Code 0.22.3 requires Node 22 or newer; no model was called.');
  let digest;
  if (executor === GROK_NATIVE_EXECUTOR) digest = createHash('sha256').update(await readFile(harness)).digest('hex');
  else {
    const root = dirname(harness), files = [];
    async function walk(relative = '') {
      for (const name of (await readdir(join(root, relative))).sort()) {
        if (name === 'node_modules') continue;
        const path = join(relative, name), info = await lstat(join(root, path));
        if (info.isSymbolicLink()) throw new Error('Qwen Code artifact contains an unexpected link; no model was called.');
        if (info.isDirectory()) await walk(path);
        else if (info.isFile()) files.push([path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]);
        else throw new Error('Qwen Code artifact contains an unexpected entry; no model was called.');
      }
    }
    await walk(); digest = hash(files);
  }
  if (digest !== artifactPins[executor]) throw new Error(`${executor === QWEN_NATIVE_EXECUTOR ? 'Qwen Code' : 'Grok Build'} artifact differs from the reviewed pin; no model was called.`);
  return digest;
}

export function nativeHarnessEnvironment({ executor, policy, gateway }) {
  const nodeBin = dirname(process.execPath);
  const env = {
    PATH: [dirname(policy.harness), nodeBin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: policy.home, TMPDIR: policy.tmp, XDG_CONFIG_HOME: join(policy.home, '.config'),
    XDG_CACHE_HOME: join(policy.home, '.cache'), NPM_CONFIG_CACHE: join(policy.home, '.npm'),
    CI: '1', NO_COLOR: '1', TERM: 'dumb', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', PYTHONDONTWRITEBYTECODE: '1',
    CAMUS_NATIVE_GATEWAY_TOKEN: gateway.capability,
    OPENAI_BASE_URL: gateway.url, OPENAI_API_BASE: gateway.url,
    ...(executor === QWEN_NATIVE_EXECUTOR ? { OPENAI_API_KEY: gateway.capability } : {}),
  };
  return Object.freeze(env);
}

function profileFor({ cwd, scratch, harness, nodeRoot, home, port, deniedPaths = [] }) {
  const allowRead = [cwd, scratch, harness, nodeRoot];
  const parents = new Set(['/']);
  for (const path of allowRead) {
    let current = resolve(path);
    while (current !== '/') { current = dirname(current); parents.add(current); }
  }
  const deniedCandidate = [...new Set(['.git', '.env', '.npmrc', '.netrc', '.camus', '.claude', '.codex', '.qwen', '.grok', '.ssh', '.aws', '.azure', ...deniedPaths])];
  return `(version 1)
(deny default)
(allow file-read*)
(deny file-read* (subpath ${quote(homedir())}) (subpath "/Users/Shared") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read-metadata ${[...parents].map(path => `(literal ${quote(path)})`).join(' ')})
(allow file-read* ${allowRead.map(path => `(subpath ${quote(path)})`).join(' ')})
${deniedCandidate.map(path => `(deny file-read* (subpath ${quote(join(cwd, path))}))`).join('\n')}
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-prefix "kern.proc"))
(allow file-ioctl (regex #"^/dev/tty.*"))
(allow file-write* (subpath ${quote(cwd)}) (subpath ${quote(scratch)}) (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null"))
${deniedCandidate.map(path => `(deny file-write* (subpath ${quote(join(cwd, path))}))`).join('\n')}
(allow network-outbound (remote tcp "localhost:${port}"))`;
}

export async function nativeHarnessPolicy({ executor, worktree, scratch, harness, artifactDigest, gatewayPort, deniedPaths = [], platform = process.platform }) {
  if (platform !== 'darwin' || !isHarnessNativeExecutor(executor)) throw new Error('Qwen Code and Grok Build native isolation currently require qualified macOS Seatbelt support.');
  const cwd = await realpath(worktree); await mkdir(scratch, { recursive: true, mode: 0o700 });
  const temp = await realpath(scratch); const binary = await realpath(harness);
  if (within(cwd, temp) || within(temp, cwd)) throw new Error('Native harness scratch and candidate must be separate.');
  const home = join(temp, 'home'), tmp = join(temp, 'tmp');
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(tmp, { recursive: true, mode: 0o700 });
  const node = await realpath(process.execPath); const nodeRoot = dirname(dirname(node));
  for (const path of deniedPaths) {
    const absolute = resolve(cwd, path);
    if (typeof path !== 'string' || !path || !absolute.startsWith(cwd + sep)) throw new Error('Invalid native harness denied path.');
  }
  // Hash the semantic policy with a port placeholder. A resumed run receives a
  // fresh one-run gateway port without changing its execution contract.
  const semantic = { version: HARNESS_POLICY_VERSION, executor, cwd, temp, binary, artifactDigest, nodeRoot,
    read: ['system', cwd, temp, binary, nodeRoot], write: [cwd, temp], deniedPaths: [...deniedPaths].sort(), network: 'one-run-gateway-only' };
  return { ...semantic, hash: hash(semantic), harness: binary, home, tmp, node,
    profile: profileFor({ cwd, scratch: temp, harness: dirname(binary), nodeRoot, home, port: gatewayPort, deniedPaths }) };
}

export async function assertNativeHarnessVersion({ executor, policy, env, signal }) {
  const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', policy.profile, policy.harness, '--version'],
    cwd: policy.cwd, env, timeoutMs: 10_000, signal, maxBytes: 64 * 1024 });
  const text = String(result.stdout ?? '').trim();
  if (result.code !== 0 || !versions[executor].test(text)) throw new Error(`${executor === QWEN_NATIVE_EXECUTOR ? 'Qwen Code 0.22.3' : 'Grok Build 1.0.5'} is required; no model was called.`);
  return text.slice(0, 160);
}

export async function preflightNativeHarness({ policy, env, gateway, sourcePath, receiptsDir, signal }) {
  const nonce = randomBytes(16).toString('hex');
  const sentinel = join(receiptsDir, `native-harness-private-${nonce}`);
  const escapedWrite = join(receiptsDir, `native-harness-write-${nonce}`);
  await writeFile(sentinel, 'synthetic private canary', { flag: 'wx', mode: 0o600 });
  const canary = createServer(socket => socket.end('network escaped'));
  await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen(0, '127.0.0.1', resolve); });
  const canaryPort = canary.address().port;
  const probe = `const fs=require('fs'),net=require('net'),a=require('assert/strict'),{execFileSync}=require('child_process');
const denied=e=>['EPERM','EACCES'].includes(e.code);a.throws(()=>fs.readFileSync('.git/HEAD'),denied);
for(const path of ${JSON.stringify((policy.deniedPaths ?? []).map(path => join(policy.cwd, path)))})a.throws(()=>fs.readFileSync(path),denied);
a.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),denied);a.throws(()=>fs.readdirSync(${JSON.stringify(sourcePath)}),denied);
a.throws(()=>fs.writeFileSync(${JSON.stringify(escapedWrite)},'no',{flag:'wx'}),denied);
a.throws(()=>execFileSync('/bin/ps',['eww','-ax'],{stdio:['ignore','pipe','ignore']}));
a.throws(()=>execFileSync('/usr/sbin/sysctl',['-n','kern.procargs2',String(process.ppid)],{stdio:['ignore','pipe','ignore']}));
const own='.camus-native-isolation-${nonce}';fs.writeFileSync(own,'ok',{flag:'wx'});fs.unlinkSync(own);
Promise.all([fetch(${JSON.stringify(`${gateway.url}/models`)},{headers:{authorization:'Bearer '+process.env.CAMUS_NATIVE_GATEWAY_TOKEN}}).then(r=>a.equal(r.status,200)),new Promise((ok,bad)=>{const s=net.connect({host:'127.0.0.1',port:${canaryPort}});s.once('connect',()=>bad(Error('network escape')));s.once('error',e=>{try{a(denied(e));ok()}catch(x){bad(x)}})})]).then(()=>console.log('camus-native-harness-isolation-v1')).catch(()=>process.exit(3));`;
  try {
    const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec', args: ['-p', policy.profile, policy.node, '-e', probe],
      cwd: policy.cwd, env, timeoutMs: 10_000, signal, maxBytes: 64 * 1024 });
    if (result.code !== 0 || !result.stdout?.includes('camus-native-harness-isolation-v1')) throw new Error('Native harness isolation preflight failed; no model was called.');
  } finally {
    canary.close(); await unlink(sentinel).catch(() => {}); await unlink(escapedWrite).catch(() => {});
  }
}

export const renderNativeHarnessProfile = profileFor;
