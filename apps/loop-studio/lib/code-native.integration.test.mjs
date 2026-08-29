// Opt-in offline compatibility probe: actual installed Codex, no auth and no
// turn/start/model call. Default suite remains hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexRpc } from './codex-rpc.mjs';
import { nativePolicy, nativeArgs, nativeEnvironment, preflightNative, isolateNativeConfig, assertNativeThread } from './code-native-policy.mjs';

test('installed Codex clears ambient browser trust, refuses MCP, then verifies a clean sandbox without a model call', {
  skip: process.env.CAMUS_NATIVE_OFFLINE_PROBE !== '1', timeout: 25000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-native-probe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'candidate'), source = join(root, 'source'), state = join(root, 'state'), auth = join(root, 'codex');
  for (const dir of [cwd, source, state, auth]) await mkdir(dir);
  execFileSync('git', ['init', '-q', cwd]);
  await writeFile(join(auth, 'config.toml'), '[mcp_servers.must_not_start]\ncommand = "false"\n[features]\nplugins = true\nhooks = true\n[shell_environment_policy.set]\nNODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "ambient-browser-trust-must-not-survive"\n');
  const policy = await nativePolicy({ worktree: cwd, scratch: join(root, 'scratch') });
  const rpc = new CodexRpc({ args: nativeArgs(policy), cwd, env: { ...nativeEnvironment(), CODEX_HOME: auth }, timeoutMs: 20000 });
  t.after(() => rpc.close());
  await assert.rejects(preflightNative(rpc, policy, { sourcePath: source, receiptsDir: state }), /not isolated \(mcp\)/);
  await rpc.close();
  const discovery = new CodexRpc({ args: nativeArgs(policy), cwd, env: { ...nativeEnvironment(), CODEX_HOME: auth }, timeoutMs: 20000 });
  const isolated = await isolateNativeConfig(discovery, policy); await discovery.close();
  const clean = new CodexRpc({ args: nativeArgs(isolated), cwd, env: { ...nativeEnvironment(), CODEX_HOME: auth }, timeoutMs: 20000, onDiagnostic: line => t.diagnostic(line) });
  t.after(() => clean.close());
  await preflightNative(clean, isolated, { sourcePath: source, receiptsDir: state });
  const effective = await clean.request('config/read', { includeLayers: false, cwd });
  assert.equal(effective.config.shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S, '');
  const thread = await clean.request('thread/start', { model: 'gpt-5.6-luna', modelProvider: 'openai', cwd,
    approvalPolicy: 'never', config: isolated.config });
  // Exercise the production validator, not a weaker lookalike assertion set.
  assertNativeThread(thread, { policy: isolated, model: 'gpt-5.6-luna' });
  assert.equal(thread.model, 'gpt-5.6-luna');
  assert.equal(thread.activePermissionProfile.id, 'camus_native');
  assert.equal(thread.sandbox.networkAccess, false);
  assert.deepEqual(thread.instructionSources, []);
  // App-server's tool processes may use their own process group. Closing the
  // transport must terminate those too, not merely the app-server PID.
  const pidFile = join(isolated.temp, 'owned-tool.pid');
  const command = clean.request('command/exec', { command: [isolated.node, '-e',
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`], cwd,
    permissionProfile: 'camus_native', timeoutMs: 15000, outputBytesCap: 1024 }).catch(() => {});
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'sandboxed tool actually started');
  await clean.close(); await command;
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
    catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
  }
  if (alive) try { process.kill(pid, 'SIGKILL'); } catch { /* owned test process */ }
  assert.equal(alive, false, 'transport closure must terminate sandboxed tool descendants');
});
