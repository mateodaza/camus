// One owned, private native login context. Never imports project configuration
// or ambient inference credentials. No model call is made by this module.
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devinIsolatedConfig, devinIsolatedEnvironment, validateDevinLogin } from './devin-native-preflight.mjs';
import { DEVIN_NATIVE_DIGEST, DEVIN_NATIVE_MODEL, DEVIN_NATIVE_VERSION } from './devin-native-protocol.mjs';

// Pure local evidence check, factored for hermetic tamper controls. Production
// always supplies DEVIN_NATIVE_DIGEST, never a user-selected trust anchor.
export async function verifyDevinExecDenial({ config, configBytes, harness, artifactDigest }) {
  const stat = await lstat(config);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || (stat.mode & 0o077) || stat.size !== Buffer.byteLength(configBytes)
      || await readFile(config, 'utf8') !== configBytes
      || createHash('sha256').update(await readFile(harness)).digest('hex') !== artifactDigest)
    throw new Error('Devin execution policy changed.');
  const policy = JSON.parse(configBytes);
  if (!Array.isArray(policy.permissions?.deny) || !policy.permissions.deny.includes('exec'))
    throw new Error('Devin execution denial absent.');
  return Object.freeze({ policy: 'native-exec-denied/v1', artifactDigest,
    configHash: createHash('sha256').update(configBytes).digest('hex') });
}

export async function prepareDevinContext({ binary, credentialSource, signal } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Devin native currently requires macOS arm64.');
  if (signal?.aborted) throw new Error('Devin preparation cancelled.');
  const harness = await realpath(binary ?? process.env.CAMUS_DEVIN_BIN ?? join(homedir(), '.local/bin/devin'));
  await access(harness, constants.X_OK);
  if (createHash('sha256').update(await readFile(harness)).digest('hex') !== DEVIN_NATIVE_DIGEST)
    throw new Error('Devin executable does not match the reviewed artifact.');
  const source = credentialSource ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'devin/credentials.toml');
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
      || info.size > 262144 || (info.mode & 0o022) || await realpath(source) !== resolve(source))
    throw new Error('Devin stored login has unsafe ownership, links or permissions.');
  const bytes = await readFile(source);
  let root;
  try {
    validateDevinLogin(bytes);
    root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-session-')));
    const env = devinIsolatedEnvironment(root);
    for (const path of [env.HOME, env.TMPDIR, env.XDG_CACHE_HOME,
      join(env.XDG_CONFIG_HOME, 'devin'), join(env.XDG_DATA_HOME, 'devin')])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(env.XDG_DATA_HOME, 'devin/credentials.toml'), bytes, { flag: 'wx', mode: 0o600 });
    const config = join(env.XDG_CONFIG_HOME, 'devin/config.json');
    const configBytes = JSON.stringify({ ...devinIsolatedConfig(),
      permissions: { allow: ['mcp__camus__read_file', 'mcp__camus__search', 'mcp__camus__write_file', 'mcp__camus__run_command'],
        ask: [], deny: ['exec'] } });
    await writeFile(config, configBytes, { flag: 'wx', mode: 0o600 });
    let configured = false, released = false;
    return {
      root, env, harness, config, model: DEVIN_NATIVE_MODEL, version: DEVIN_NATIVE_VERSION,
      digest: DEVIN_NATIVE_DIGEST, sourceLoginPrivate: (info.mode & 0o077) === 0,
      async verifyExecDenial() {
        if (released || signal?.aborted) throw new Error('Devin execution policy unavailable.');
        // The diagnostic text is not proof. Rebind the exact host-created deny
        // configuration and reviewed binary before treating exec as blocked.
        return verifyDevinExecDenial({ config, configBytes, harness, artifactDigest: DEVIN_NATIVE_DIGEST });
      },
      async configureMcp(definition) {
        if (configured || released) throw new Error('Devin context already configured or released.');
        const url = new URL(definition.url);
        if (definition.name !== 'camus' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
            || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
            || !url.port || definition.headers?.length !== 1
            || definition.headers[0].name !== 'Authorization'
            || !/^Bearer [0-9a-f]{64}$/.test(definition.headers[0].value)) throw new Error('Invalid owned Devin MCP broker.');
        await writeFile(join(env.XDG_CONFIG_HOME, 'devin/mcp_config.json'), JSON.stringify({ mcpServers: {
          camus: { url: definition.url, transport: 'http', headers: { Authorization: definition.headers[0].value } },
        } }), { flag: 'wx', mode: 0o600 });
        configured = true;
      },
      async release({ writerStopped = false } = {}) {
        if (!writerStopped) throw new Error('Devin context writer cleanup is unproven; scratch retained.');
        if (!released) { await rm(root, { recursive: true }); released = true; }
      },
    };
  } catch (error) { if (root) await rm(root, { recursive: true }); throw error; }
  finally { bytes.fill(0); }
}
