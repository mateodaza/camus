// Distribution smoke: the npm tarball must contain the shared Studio code-seat
// runtime, but never local/operator state. This intentionally does not install
// dependencies or call a provider.

import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMP = await realpath(await mkdtemp(join(tmpdir(), 'camus-code-runtime-test-')));

async function command(file, args, options = {}) {
  return execFile(file, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

try {
  await command(process.execPath, ['build-code-runtime.mjs'], { cwd: PACKAGE_ROOT });

  const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', TEMP], { cwd: PACKAGE_ROOT });
  const details = JSON.parse(packed.stdout);
  assert.equal(details.length, 1, 'npm pack must emit one tarball');
  const tarball = join(TEMP, details[0].filename);
  const unpacked = join(TEMP, 'unpacked');
  await mkdir(unpacked);
  await command('tar', ['-xzf', tarball, '-C', unpacked]);
  const installed = join(unpacked, 'package');

  const entries = (await command('tar', ['-tzf', tarball])).stdout.trim().split('\n').filter(Boolean);
  assert(entries.includes('package/runtime/apps/loop-studio/code-build.mjs'), 'tarball includes the shared build entry');
  assert(entries.includes('package/runtime/apps/loop-studio/code-eval.mjs'), 'tarball includes the bounded code-eval entry');
  assert(entries.includes('package/runtime/apps/loop-studio/lib/code-seats.mjs'), 'tarball includes the shared code-seat engine');
  for (const name of ['code-loop', 'code-context', 'code-run-state', 'code-session', 'code-setup', 'code-diagnostics', 'code-verify-child', 'code-native-policy', 'code-native-child', 'code-owned-process', 'code-owned-process-registry', 'code-owned-process-supervisor', 'native-process', 'native-gateway', 'native-harness-policy', 'codex-rpc', 'adapters/codex-native', 'adapters/native-harness', 'adapters/qwen-native', 'adapters/grok-native']) assert(entries.includes(`package/runtime/apps/loop-studio/lib/${name}.mjs`), `tarball includes ${name}`);
  assert(entries.includes('package/runtime/apps/loop-studio/lib/adapters/registry.mjs'), 'tarball includes the shared adapter registry');
  for (const name of ['code-eval-contract', 'code-eval-fixture', 'code-eval-ledger', 'code-eval-runner']) {
    assert(entries.includes(`package/runtime/apps/loop-studio/lib/${name}.mjs`), `tarball includes ${name}`);
  }
  for (const name of [
    'code-eval-pair-contract', 'code-eval-pair-scheduler', 'code-eval-pair-ledger',
    'code-eval-pair-runner', 'code-eval-pair-summary',
  ]) assert(entries.includes(`package/runtime/apps/loop-studio/lib/${name}.mjs`), `tarball includes ${name}`);
  assert(entries.includes('package/runtime/apps/loop-studio/checks/models.json'), 'tarball includes the public model catalog');
  const publicEvalFixtures = [
    'package/runtime/apps/loop-studio/fixtures/code-eval-v1/simple-bounded-parser-fix/fixture.json',
    'package/runtime/apps/loop-studio/fixtures/code-eval-v1/balanced-job-event-scheduler/fixture.json',
  ];
  for (const fixture of publicEvalFixtures) assert(entries.includes(fixture), `tarball includes public fixture ${fixture}`);
  for (const entry of entries) {
    assert(!/(?:^|\/)\.env(?:\.|\/|$)/i.test(entry), `private env file leaked into tarball: ${entry}`);
    assert(publicEvalFixtures.includes(entry) || !/(?:^|\/)(?:runs|receipts|fixtures)(?:\/|$)/i.test(entry), `runtime artifact leaked into tarball: ${entry}`);
    assert(!/\.test\.(?:mjs|js|json)$/i.test(entry), `test source leaked into tarball: ${entry}`);
    assert(!/(?:^|\/)(?:\.camus|\.claude|\.codex)(?:\/|$)/i.test(entry), `private config leaked into tarball: ${entry}`);
  }

  // Every stateful resolver gets a synthetic location. HOME is also isolated,
  // so an accidental fallback cannot read the operator's account/config state.
  const modelFile = join(TEMP, 'models.json');
  const blockedBins = join(TEMP, 'blocked-vendors'); await mkdir(blockedBins);
  for (const name of ['claude', 'codex']) await writeFile(join(blockedBins, name), '#!/bin/sh\necho "Real vendor execution is forbidden in this test" >&2\nexit 99\n', { mode: 0o700 });
  await cp(join(PACKAGE_ROOT, 'runtime', 'apps', 'loop-studio', 'checks', 'models.json'), modelFile);
  const env = {
    ...process.env,
    HOME: join(TEMP, 'home'),
    PATH: `${blockedBins}:${process.env.PATH}`,
    STUDIO_MODELS_FILE: modelFile,
    STUDIO_GRANDFATHER_DIR: join(TEMP, 'grandfather'),
    STUDIO_CODEX_CACHE_FILE: join(TEMP, 'codex-cache.json'),
    STUDIO_RUNS_DIR: join(TEMP, 'runs'),
    STUDIO_CAPABILITIES_DIR: join(TEMP, 'capabilities'),
    CAMUS_QWEN_CODE_BIN: join(TEMP, 'missing-qwen'),
    CAMUS_GROK_BUILD_BIN: join(TEMP, 'missing-grok'),
  };
  for (const key of Object.keys(env)) if (/api.?key|token|secret|password|credential|^CLAUDE_MODEL$|^CODEX_MODEL$|^CODEX_EFFORT$|^ROUND_CAP$/i.test(key)) delete env[key];
  const bin = join(installed, 'bin', 'camus.js');
  assert.equal(existsSync(resolve(installed, '../../apps/loop-studio/code-build.mjs')), false, 'extracted package has no source-checkout fallback');

  const ambientScripts = join(env.HOME, '.claude', 'skills', 'camus', 'scripts');
  const ambientMarker = join(TEMP, 'ambient-script-ran');
  await mkdir(ambientScripts, { recursive: true });
  await writeFile(join(ambientScripts, 'status.py'), `from pathlib import Path\nPath(${JSON.stringify(ambientMarker)}).write_text('unexpected')\n`);
  await assert.rejects(command(process.execPath, [bin, 'status'], { cwd: installed, env }), error => error.code === 1);
  assert.equal(existsSync(ambientMarker), false, 'packaged CLI never executes a mutable ~/.claude script override');

  const help = await command(process.execPath, [bin, 'build', '--help'], { cwd: installed, env });
  assert.match(help.stdout, /independent maker\/reviewer coding \(experimental\)/);
  assert.match(help.stdout, /--maker-executor file_actions\|codex_native\|qwen_native\|grok_native/);
  const evalHelp = await command(process.execPath, [bin, 'code-eval', '--help'], { cwd: installed, env });
  assert.match(evalHelp.stdout, /bounded native-smoke and raw\/native pair evidence/);
  assert.match(evalHelp.stdout, /--allow-provider-calls --max-cells 1/);
  assert.match(evalHelp.stdout, /summarize/);
  const fixtureReadiness = JSON.parse((await command(process.execPath, [bin, 'code-eval', 'fixture', '--json'], { cwd: installed, env })).stdout);
  assert.equal(fixtureReadiness.ready, true);
  assert.equal(fixtureReadiness.providerCallsMade, 0);
  assert.equal(fixtureReadiness.base, 'red');
  assert.equal(fixtureReadiness.reference, 'green');
  const balancedReadiness = JSON.parse((await command(process.execPath,
    [bin, 'code-eval', 'fixture', '--case', 'balanced-job-event-scheduler', '--json'], { cwd: installed, env })).stdout);
  assert.equal(balancedReadiness.ready, true);
  assert.equal(balancedReadiness.taskClass, 'balanced');
  assert.equal(balancedReadiness.providerCallsMade, 0);
  const runnerUrl = pathToFileURL(join(installed, 'runtime/apps/loop-studio/lib/code-eval-runner.mjs')).href;
  const runtimeIdentity = await import(runnerUrl).then(module => module.codeEvalRuntimeIdentity());
  assert.equal(runtimeIdentity.packageVersion, JSON.parse(await (await import('node:fs/promises')).readFile(join(installed, 'package.json'), 'utf8')).version,
    'execution provenance names the installed Camus CLI version');
  const listed = await command(process.execPath, [bin, 'models', '--json'], { cwd: installed, env });
  const catalog = JSON.parse(listed.stdout);
  for (const role of ['maker', 'reviewer']) {
    assert(Array.isArray(catalog[role]) && catalog[role].length > 0, `packed ${role} catalog is present`);
    assert(catalog[role].some((seat) => seat.backend === 'claude'), `packed ${role} catalog supports Claude`);
    assert(catalog[role].some((seat) => seat.backend === 'codex'), `packed ${role} catalog supports Codex`);
  }
  assert.equal(catalog.gating, false, 'packed catalog explicitly labels Build as non-gating');
  assert(catalog.maker.some(seat => seat.codeExecutors.includes('codex_native')), 'packaged CLI advertises native maker opt-in');
  assert(!catalog.reviewer.some(seat => seat.codeExecutors.includes('codex_native')), 'native reviewer is not advertised');
  assert(!catalog.reviewer.some(seat => seat.codeExecutors.includes('qwen_native') || seat.codeExecutors.includes('grok_native')), 'native harness reviewer is not advertised');
  // Exercise the packaged supervisor, not just its presence in the tarball.
  const rpcUrl = pathToFileURL(join(installed, 'runtime/apps/loop-studio/lib/codex-rpc.mjs')).href;
  const rpcScript = `import {CodexRpc} from ${JSON.stringify(rpcUrl)};
    const peer="process.stdin.once('data',data=>process.stdout.write(JSON.stringify({id:JSON.parse(data).id,result:'native package ok'})+'\\\\n'));";
    const rpc=new CodexRpc({command:process.execPath,args:['-e',peer],cwd:process.cwd(),env:{PATH:process.env.PATH},timeoutMs:5000});
    try{console.log(await rpc.request('fixture'));}finally{await rpc.close();}`;
  const rpcResult = await command(process.execPath, ['--input-type=module', '-e', rpcScript], { cwd: installed, env });
  assert.equal(rpcResult.stdout.trim(), 'native package ok');
  const configPath = join(TEMP, 'connection.json');
  await writeFile(configPath, JSON.stringify({ connectionName: 'fixture', connection: { kind: 'direct_https', baseUrl: 'https://api.example.com/v1', why: 'offline package fixture' },
    backendName: 'fixture', backend: { kind: 'openai_compat', provider: 'fixture', protocol: 'chat_completions', trainingOrg: 'fixture', modelFamily: 'fixture', inferenceOperator: 'fixture', derivedFrom: null,
      auth: { kind: 'env', envVar: 'CAMUS_FIXTURE_API_KEY' }, models: ['fixture-model'], seats: ['maker', 'reviewer'], why: 'offline package fixture' } }));
  const setup = JSON.parse((await command(process.execPath, [bin, 'build', '--setup', configPath, '--json'], { cwd: installed, env })).stdout);
  assert.equal(setup.configured, true); assert.equal(setup.qualified, false);
  const configuredCatalog = JSON.parse((await command(process.execPath, [bin, 'build', '--models', '--json'], { cwd: installed, env })).stdout);
  const fixtureMaker = configuredCatalog.maker.find(seat => seat.backend === 'fixture'); assert.ok(fixtureMaker);
  assert.deepEqual(fixtureMaker.codeExecutors, ['file_actions'], 'missing native harnesses are not advertised as selectable');
  for (const executor of ['qwen_native', 'grok_native']) {
    const readiness = configuredCatalog.nativeHarnesses[executor];
    assert.equal(readiness.ready, false, `${executor} is unavailable without its reviewed artifact`);
    assert(['missing', 'wrong_version', 'wrong_digest', 'unsupported'].includes(readiness.status), `${executor} reports a bounded readiness status`);
    if (readiness.status === 'unsupported') {
      assert.equal(readiness.remedy, null, `${executor} does not prescribe an unusable install on this platform`);
      assert.equal(typeof readiness.detail, 'string', `${executor} explains the unsupported platform`);
    } else {
      assert.match(readiness.remedy, /https:\/\/github\.com\/mateodaza\/camus\/blob\/main\/docs\/NATIVE-HARNESS-QUALIFICATION-1\.md/,
        `${executor} links to the shipped public qualification guide`);
      assert.match(readiness.remedy, /CAMUS_.+_BIN/, `${executor} names its explicit private-path override`);
      assert.doesNotMatch(readiness.remedy, /curl\s*\|\s*(?:sh|bash)|npm install -g/, `${executor} never suggests executing unreviewed dependencies or a remote installer`);
    }
  }
  assert(!JSON.stringify(configuredCatalog).includes(TEMP), 'native harness readiness does not expose resolved operator paths');
  await assert.rejects(command(process.execPath, [bin, 'build', '--qualify', 'fixture:fixture-model', '--role', 'maker'], { cwd: installed, env }), error => /allow-provider-calls/.test(error.stderr));

  // A cold package executes and resumes the real engine, replacing ONLY the
  // provider calls via a test loader. No source checkout or vendor CLI is used.
  const loader = join(TEMP, 'providers.mjs');
  const registry = pathToFileURL(join(installed, 'runtime/apps/loop-studio/lib/adapters/registry.mjs')).href;
  const fake = `export function resolveSeatAdapters(models,backends){return {makerBackend:backends.maker,reviewerBackend:backends.reviewer,
    maker:async({prompt,effort})=>{if(effort!=='high')throw new Error('maker effort was not pinned');return {ok:true,text:JSON.stringify(prompt.includes('Complete host action history')?{actions:[],done:true}:{actions:[{type:'create',path:'answer.txt',content:'correct',expected_sha256:null}],done:false})}},
    reviewer:async({effort})=>{if(effort!=='low')throw new Error('reviewer effort was not pinned');return {ran:true,verdict:'APPROVED',findings:[]}}};}`;
  await writeFile(loader, `export async function load(url,ctx,next){if(url===${JSON.stringify(registry)})return {format:'module',shortCircuit:true,source:${JSON.stringify(fake)}};return next(url,ctx);}`);
  const runEnv = { ...env, NODE_OPTIONS: `--experimental-loader=${loader}` };
  const repo = join(TEMP, 'project'); await mkdir(repo);
  await command('git', ['init', '-q', repo]); await writeFile(join(repo, 'README.md'), 'fixture\n');
  await command('git', ['-C', repo, 'add', '.']); await command('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const execute = async (args) => {
    try { const result = await command(process.execPath, [bin, 'build', ...args, '--json'], { cwd: installed, env: runEnv }); return JSON.parse(result.stdout); }
    catch (error) { assert.equal(error.code, 2, `${error.stdout}\n${error.stderr}`); return JSON.parse(error.stdout); }
  };
  const started = await execute(['--task', 'Add the expected answer file', '--contract', 'Keep the original source checkout unchanged', '--repo', repo,
    '--maker', 'claude:sonnet', '--maker-effort', 'high', '--reviewer', 'claude:sonnet', '--reviewer-effort', 'low', '--max-calls', '1']);
  assert.equal(started.question.kind, 'budget');
  assert.equal((await execute(['--status', started.id])).usage.calls, 1);
  const done = await execute(['--resume', started.id, '--max-calls', '5']);
  assert.equal(done.completion, 'candidate_ready_for_acceptance', done.error);
  assert.equal(done.protocol.fileActionPolicy, 'create_replace_v1');
  assert.equal(done.candidate.worktree, started.candidate.worktree); assert.equal(done.usage.calls, 3);
  console.log('test_code_runtime.mjs: packed any-model runtime is isolated and executable');
} finally {
  await rm(TEMP, { recursive: true, force: true });
}
