import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodeSeats, codeModelChoices, memoizeNativeHarnessReadiness } from './code-seat-launch.mjs';
import { createCodeVerifier, verificationEnvironment } from './code-seat-verify.mjs';
import { parseCodeBuildArgs, parseCodeSeat } from '../code-build.mjs';
import { resolveSeatAdapters, nativeMakerFor } from './adapters/registry.mjs';
import { runNativeCodex } from './adapters/codex-native.mjs';
import { runNativeQwen } from './adapters/qwen-native.mjs';
import { runNativeGrok } from './adapters/grok-native.mjs';

const entry = (backend, model, extra = {}) => ({ backend, model, provider: backend,
  effort: backend === 'codex', executor: `${backend}_cli`, transport: 'vendor_managed',
  trainingOrg: backend, modelFamily: backend, lineage: { source: 'registry' },
  admission: { qualified: true, fingerprint: `builtin1:${'a'.repeat(64)}` }, ...extra });
const claude = entry('claude', 'sonnet');
const codex = entry('codex', 'gpt-5.6-luna');
const grok = entry('grok', 'grok-4.6');
const external = entry('qwen', 'qwen-coder', { provider: 'hosted', transport: 'direct_https',
  executor: 'http_client',
  trainingOrg: 'alibaba', lineage: { source: 'operator_declared' },
  admission: { qualified: true, fingerprint: `qual1:${'b'.repeat(64)}` },
  expectedReported: { 'qwen-coder': ['qwen-coder-pinned'] } });
const catalog = { maker: [claude, codex, grok, external], reviewer: [claude, codex, grok, external] };
const pick = (value) => ({ backend: value.backend, model: value.model });
const definitions = {
  claude: { name: 'claude', kind: 'claude_cli', seats: ['maker', 'reviewer'] },
  codex: { name: 'codex', kind: 'codex_cli', transport: 'vendor_managed', seats: ['maker', 'reviewer'] },
  grok: { name: 'grok', kind: 'grok_cli', transport: 'vendor_managed', seats: ['maker', 'reviewer'] },
  qwen: { name: 'qwen', kind: 'openai_compat', seats: ['maker', 'reviewer'], baseUrl: 'https://fixture.invalid/v1' },
};
const readyHarness = async (executor, runtime) => {
  const unsupported = runtime.platform !== 'darwin' || runtime.arch !== 'arm64'
    || executor === 'qwen_native' && runtime.nodeMajor < 22;
  return { executor, label: executor === 'qwen_native' ? 'Qwen Code' : 'Grok Build',
    requiredVersion: executor === 'qwen_native' ? '0.22.3' : '1.0.13',
    status: unsupported ? 'unsupported' : 'ready', ready: !unsupported,
    detail: unsupported ? 'unsupported fixture runtime' : 'reviewed fixture artifact ready',
    remedy: unsupported ? 'fixture remedy' : null };
};
let probes = 0;
let resolutions = 0;
const deps = {
  catalog: () => catalog, models: () => ({ maker: pick(claude), reviewer: { ...pick(codex), effort: 'low' }, loop: { roundCap: 2 } }),
  backends: () => definitions,
  qualify: async ({ entry: actual }) => { probes++; assert.equal(actual.baseUrl, 'https://fixture.invalid/v1'); return { qualified: true, fingerprint: external.admission.fingerprint }; },
  resolve: (models, backends) => { resolutions++; return { models, backends }; },
};
const reversed = await prepareCodeSeats({ pairing: { maker: { ...pick(codex), effort: 'low' }, reviewer: pick(claude) } }, deps);
assert.equal(reversed.models.maker.backend, 'codex');
assert.equal(reversed.models.reviewer.backend, 'claude');
assert.equal(reversed.models.maker.effort, 'low');
assert.equal(reversed.models.reviewer.effort, 'medium', 'Build pins a deterministic Claude effort instead of inheriting account settings');
assert.equal(probes, 0);
assert.equal(reversed.pairingView.gating, false);
const same = await prepareCodeSeats({ pairing: { maker: pick(external), reviewer: pick(external) } }, {
  ...deps, qualify: async ({ entry: actual }) => {
    definitions.qwen.baseUrl = 'https://changed.invalid';
    assert.equal(actual.baseUrl, 'https://fixture.invalid/v1');
    return { qualified: true, fingerprint: external.admission.fingerprint };
  },
});
assert.equal(same.pairingView.standing, 'same_vendor_advisory');
assert.deepEqual(same.models.maker.expectedReported, external.expectedReported);
assert.equal(same.frozenBackends.reviewer.baseUrl, 'https://fixture.invalid/v1');
assert.equal(same.models.reviewer.qualification.seatType, 'words_reviewer');
await assert.rejects(prepareCodeSeats({ pairing: { maker: { backend: 'codex', model: 'invented' }, reviewer: pick(claude) } }, deps), /unavailable/);
const claudeEffort = await prepareCodeSeats({ pairing: { maker: pick(claude), reviewer: { ...pick(claude), effort: 'high' } } }, deps);
assert.equal(claudeEffort.models.reviewer.effort, 'high');
const legacyClaude = await prepareCodeSeats({ pairing: { maker: pick(claude), reviewer: pick(claude) }, preserveAbsentEffort: true }, deps);
assert.equal(legacyClaude.models.maker.effort, undefined, 'a legacy checkpoint keeps its absent maker effort binding');
assert.equal(legacyClaude.models.reviewer.effort, undefined, 'a legacy checkpoint keeps its absent reviewer effort binding');
assert.equal(resolutions, 4, 'only accepted pairings resolve adapters; refusals do not');
const claudeAlt = entry('claude', 'opus');
const effortDeps = { ...deps, catalog: () => ({ maker: [claude, claudeAlt, codex], reviewer: [claude, claudeAlt, codex] }),
  models: () => ({ maker: { ...pick(claude), effort: 'high' }, reviewer: { ...pick(codex), effort: 'low' }, loop: { roundCap: 2 } }) };
const inherited = await prepareCodeSeats({ pairing: { maker: pick(claude), reviewer: pick(codex) }, live: false }, effortDeps);
assert.equal(inherited.models.maker.effort, 'high', 'the exact same role/backend/model may inherit its standing effort');
assert.equal(inherited.models.reviewer.effort, 'low');
const differentModel = await prepareCodeSeats({ pairing: { maker: pick(claudeAlt), reviewer: { ...pick(codex), effort: 'xhigh' } }, live: false }, effortDeps);
assert.equal(differentModel.models.maker.effort, 'medium', 'a different model never inherits another model\'s standing effort');
assert.equal(differentModel.models.reviewer.effort, 'xhigh', 'an explicit request wins over standing effort');
const roleSwapped = await prepareCodeSeats({ pairing: { maker: pick(codex), reviewer: pick(claude) }, live: false }, effortDeps);
assert.equal(roleSwapped.models.maker.effort, 'medium', 'a role-swapped seat never inherits the other role\'s effort');
assert.equal(roleSwapped.models.reviewer.effort, 'medium', 'a role-swapped seat defaults deterministically');
const choices = await codeModelChoices(catalog, { platform: 'darwin', arch: 'arm64', nodeMajor: 22, readiness: readyHarness });
assert.equal(choices.maker.length, choices.reviewer.length);
assert.doesNotMatch(JSON.stringify(choices), /baseUrl|apiKey|changed.invalid/);
assert.equal(choices.maker.find(seat => seat.backend === 'claude').effort, true, 'Build exposes the Claude CLI effort capability without changing the words-seat catalog');
assert.deepEqual(parseCodeSeat('host:qwen:large'), { backend: 'host', model: 'qwen:large' });
assert.throws(() => parseCodeSeat('only-model'), /backend:model/);
assert.throws(() => parseCodeBuildArgs(['--maker', 'codex:x', '--maker', 'claude:y']), /Duplicate/);
assert.throws(() => parseCodeBuildArgs(['--task', 'x', '--task-file', 'x.txt']), /Choose/);
assert.throws(() => parseCodeBuildArgs(['--publish']), /Unknown/);
assert.deepEqual(choices.maker.find(seat => seat.backend === 'codex').codeExecutors, ['file_actions', 'codex_native']);
assert.deepEqual(choices.maker.find(seat => seat.backend === 'qwen').codeExecutors, ['file_actions', 'qwen_native', 'grok_native']);
assert.deepEqual(choices.maker.find(seat => seat.backend === 'grok').codeExecutors, ['grok_native']);
assert.deepEqual(choices.reviewer.find(seat => seat.backend === 'grok').codeExecutors, ['file_actions']);
assert.equal(choices.maker.find(seat => seat.backend === 'qwen').modelQualification.qualified, true);
assert.equal(choices.nativeHarnesses.qwen_native.status, 'ready');
assert.equal(choices.minimumNativeTokenBudget, 32768);
let readinessCalls = 0; let releaseReadiness;
const readinessGate = new Promise(resolve => { releaseReadiness = resolve; });
const sharedReadiness = memoizeNativeHarnessReadiness(async executor => {
  readinessCalls++; await readinessGate;
  return readyHarness(executor, { platform: 'darwin', arch: 'arm64', nodeMajor: 22 });
});
const concurrentChoices = [codeModelChoices(catalog, { readiness: sharedReadiness }), codeModelChoices(catalog, { readiness: sharedReadiness })];
while (readinessCalls < 2) await new Promise(resolve => setImmediate(resolve));
releaseReadiness(); await Promise.all(concurrentChoices);
assert.equal(readinessCalls, 2, 'concurrent catalogs share one readiness probe per native harness');
assert.deepEqual((await codeModelChoices(catalog, { platform: 'darwin', arch: 'arm64', nodeMajor: 20, readiness: readyHarness })).maker.find(seat => seat.backend === 'qwen').codeExecutors, ['file_actions', 'grok_native']);
assert.deepEqual((await codeModelChoices(catalog, { platform: 'linux', arch: 'arm64', nodeMajor: 22, readiness: readyHarness })).maker.find(seat => seat.backend === 'qwen').codeExecutors, ['file_actions']);
assert.equal(choices.reviewer.some(seat => seat.codeExecutors.some(executor => executor.endsWith('_native'))), false);
const studioHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const staticExecutorOptions = studioHtml.match(/<select id="code-maker-executor"[\s\S]*?<\/select>/)?.[0] ?? '';
assert.match(staticExecutorOptions, /value="file_actions"/);
assert.doesNotMatch(staticExecutorOptions, /value="(?:codex|qwen|grok)_native"/, 'Studio starts fail-closed and adds only ready executors from config');
const native = await prepareCodeSeats({ pairing: { maker: { ...pick(codex), codeExecutor: 'codex_native' }, reviewer: pick(claude) }, live: false }, deps);
assert.equal(native.models.maker.codeExecutor, 'codex_native');
assert.equal(resolveSeatAdapters(native.models, native.frozenBackends).nativeMaker, runNativeCodex, 'shared registry used by Studio AND CLI resolves native');
assert.equal(resolveSeatAdapters(reversed.models, reversed.frozenBackends).nativeMaker, undefined, 'default remains file actions');
assert.equal(nativeMakerFor('qwen_native'), runNativeQwen); assert.equal(nativeMakerFor('grok_native'), runNativeGrok);
const qwenNative = await prepareCodeSeats({ pairing: { maker: { ...pick(external), codeExecutor: 'qwen_native' }, reviewer: pick(claude) }, live: false }, deps);
assert.equal(qwenNative.models.maker.codeExecutor, 'qwen_native');
const grokSubscription = await prepareCodeSeats({ pairing: { maker: pick(grok), reviewer: pick(claude) }, live: false }, deps);
assert.equal(grokSubscription.models.maker.codeExecutor, 'grok_native', 'the built-in Grok seat cannot silently fall back to Camus file actions');
assert.equal(resolveSeatAdapters(grokSubscription.models, grokSubscription.frozenBackends).nativeMaker, runNativeGrok);
await assert.rejects(prepareCodeSeats({ pairing: { maker: { ...pick(grok), codeExecutor: 'file_actions' }, reviewer: pick(claude) }, live: false }, deps), /subscription authentication/);
await assert.rejects(prepareCodeSeats({ pairing: { maker: { ...pick(codex), codeExecutor: 'qwen_native' }, reviewer: pick(claude) }, live: false }, deps), /OpenAI-compatible/);
await assert.rejects(prepareCodeSeats({ pairing: { maker: { ...pick(claude), codeExecutor: 'codex_native' }, reviewer: pick(codex) }, live: false }, deps), /built-in/);
await assert.rejects(prepareCodeSeats({ pairing: { maker: pick(codex), reviewer: { ...pick(claude), codeExecutor: 'codex_native' } }, live: false }, deps), /maker/);
const nativeArgs = ['--maker', 'codex:fixture', '--reviewer', 'claude:fixture', '--maker-executor', 'codex_native'];
assert.throws(() => parseCodeBuildArgs(nativeArgs), /at least 32768/);
assert.throws(() => parseCodeBuildArgs([...nativeArgs, '--max-tokens', '32767']), /at least 32768/);
assert.equal(parseCodeBuildArgs([...nativeArgs, '--max-tokens', '32768'])['maker-executor'], 'codex_native');
assert.equal(parseCodeBuildArgs([...nativeArgs, '--max-tokens', '100000'])['maker-executor'], 'codex_native');
const qwenArgs = ['--maker', 'qwen:fixture', '--reviewer', 'claude:fixture', '--maker-executor', 'qwen_native'];
assert.throws(() => parseCodeBuildArgs(qwenArgs), /at least 32768/);
assert.equal(parseCodeBuildArgs([...qwenArgs, '--max-tokens', '100000'])['maker-executor'], 'qwen_native');
assert.throws(() => parseCodeBuildArgs(['--resume', 'fixture', '--maker-executor', 'file_actions']), /frozen/);
assert.throws(() => parseCodeBuildArgs(['--models', '--maker-executor', 'file_actions']), /new build/);
assert.throws(() => parseCodeBuildArgs(['--maker-executor', 'unknown']), /file_actions, codex_native, qwen_native, grok_native/);

const dir = await mkdtemp(join(tmpdir(), 'camus-code-verify-test-'));
try {
  assert.equal(createCodeVerifier(null), null);
  const env = verificationEnvironment({ PATH: process.env.PATH, XAI_API_KEY: 'fixture-only', NODE_OPTIONS: '--inspect', HOME: '/operator' }, dir);
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, dir);
  const script = join(dir, 'check.cjs');
  await writeFile(script, 'if (process.env.XAI_API_KEY || process.env.NODE_OPTIONS) process.exit(2);\n');
  const verify = createCodeVerifier(`${process.execPath} ${script}`, { receiptsDir: dir });
  const pass = await verify({ worktree: dir });
  assert.equal(pass.pass, true);
  assert.equal(pass.outputRetained, false);
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('verify-home-')), [], 'successful verification removes its private home');
  const slow = join(dir, 'slow.cjs');
  await writeFile(slow, 'setInterval(() => {}, 1000);\n');
  const timeout = await createCodeVerifier(`${process.execPath} ${slow}`, { receiptsDir: dir, timeoutMs: 100 })({ worktree: dir });
  assert.equal(timeout.pass, null);
  assert.match(timeout.error, /timed out/);
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('verify-home-')), [], 'timed-out verification removes its private home');
  const backgroundPid = join(dir, 'background.pid');
  const background = join(dir, 'background.cjs');
  await writeFile(background, `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');\nconst child=spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); writeFileSync(${JSON.stringify(backgroundPid)}, String(child.pid)); child.unref();\n`);
  const backgroundResult = await createCodeVerifier(`${process.execPath} ${background}`, { receiptsDir: dir })({ worktree: dir });
  assert.equal(backgroundResult.pass, true);
  const pid = Number(await readFile(backgroundPid, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
    catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  assert.equal(alive, false, 'normal verification exit also cleans background descendants');
  const stop = new AbortController(); stop.abort();
  assert.equal((await verify({ worktree: dir, signal: stop.signal })).ran, false);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Independent code-seat selection, CLI contract, and verifier tests passed.');
