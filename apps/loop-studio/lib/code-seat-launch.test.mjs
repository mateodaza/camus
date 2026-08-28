import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodeSeats, codeModelChoices } from './code-seat-launch.mjs';
import { createCodeVerifier, verificationEnvironment } from './code-seat-verify.mjs';
import { parseCodeBuildArgs, parseCodeSeat } from '../code-build.mjs';

const entry = (backend, model, extra = {}) => ({ backend, model, provider: backend,
  effort: backend === 'codex', executor: `${backend}_cli`, transport: 'vendor_managed',
  trainingOrg: backend, modelFamily: backend, lineage: { source: 'registry' },
  admission: { qualified: true, fingerprint: `builtin1:${'a'.repeat(64)}` }, ...extra });
const claude = entry('claude', 'sonnet');
const codex = entry('codex', 'gpt-5.6-luna');
const external = entry('qwen', 'qwen-coder', { provider: 'hosted', transport: 'direct_https',
  trainingOrg: 'alibaba', lineage: { source: 'operator_declared' },
  admission: { qualified: true, fingerprint: `qual1:${'b'.repeat(64)}` },
  expectedReported: { 'qwen-coder': ['qwen-coder-pinned'] } });
const catalog = { maker: [claude, codex, external], reviewer: [claude, codex, external] };
const pick = (value) => ({ backend: value.backend, model: value.model });
const definitions = {
  claude: { name: 'claude', kind: 'claude_cli', seats: ['maker', 'reviewer'] },
  codex: { name: 'codex', kind: 'codex_cli', seats: ['maker', 'reviewer'] },
  qwen: { name: 'qwen', kind: 'openai_compat', seats: ['maker', 'reviewer'], baseUrl: 'https://fixture.invalid/v1' },
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
await assert.rejects(prepareCodeSeats({ pairing: { maker: pick(claude), reviewer: { ...pick(claude), effort: 'high' } } }, deps), /does not honor/);
assert.equal(resolutions, 2, 'refusals do not resolve or invoke models');
const choices = codeModelChoices(catalog);
assert.equal(choices.maker.length, choices.reviewer.length);
assert.doesNotMatch(JSON.stringify(choices), /baseUrl|apiKey|changed.invalid/);
assert.deepEqual(parseCodeSeat('host:qwen:large'), { backend: 'host', model: 'qwen:large' });
assert.throws(() => parseCodeSeat('only-model'), /backend:model/);
assert.throws(() => parseCodeBuildArgs(['--maker', 'codex:x', '--maker', 'claude:y']), /Duplicate/);
assert.throws(() => parseCodeBuildArgs(['--task', 'x', '--task-file', 'x.txt']), /Choose/);
assert.throws(() => parseCodeBuildArgs(['--publish']), /Unknown/);

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
  const slow = join(dir, 'slow.cjs');
  await writeFile(slow, 'setInterval(() => {}, 1000);\n');
  const timeout = await createCodeVerifier(`${process.execPath} ${slow}`, { receiptsDir: dir, timeoutMs: 100 })({ worktree: dir });
  assert.equal(timeout.pass, null);
  assert.match(timeout.error, /timed out/);
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
