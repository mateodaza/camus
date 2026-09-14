import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCodeSeats, codeModelChoices } from './code-seat-launch.mjs';
import { DEVIN_CODE_BACKEND, DEVIN_OBSERVED_CONSENT, devinCodeReadiness } from './devin-code-seat.mjs';
import { resolveSeatAdapters, nativeMakerFor } from './adapters/registry.mjs';
import { runNativeDevin } from './adapters/devin-native.mjs';
import { parseCodeBuildArgs } from '../code-build.mjs';

const reviewer = { backend: 'codex', model: 'gpt-5.6-luna', executor: 'codex_cli', transport: 'vendor_managed',
  effort: true, admission: { qualified: true, fingerprint: `builtin1:${'a'.repeat(64)}` } };
const selected = { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: DEVIN_OBSERVED_CONSENT };
const peer = { backend: reviewer.backend, model: reviewer.model, effort: 'medium' };
const definitions = { codex: { name: 'codex', kind: 'codex_cli', seats: ['maker', 'reviewer'], transport: 'vendor_managed' } };
const deps = { catalog: () => ({ maker: [reviewer], reviewer: [reviewer] }),
  models: () => ({ maker: peer, reviewer: peer, loop: {} }), backends: () => definitions };
const prepare = (maker = selected, extra = {}) => prepareCodeSeats({ live: false, pairing: { maker, reviewer: peer }, ...extra }, deps);

test('SWE is explicit, code-only, non-gating and does not mint words qualification', async () => {
  const ready = await prepare();
  assert.equal(ready.models.maker.observedBudgetConsent, DEVIN_OBSERVED_CONSENT);
  assert.equal(ready.models.maker.qualification, undefined);
  assert.equal(ready.models.reviewer.model, 'gpt-5.6-luna');
  assert.equal(ready.pairingView.gating, false);
  assert.deepEqual(ready.frozenBackends.maker, DEVIN_CODE_BACKEND);
  const adapters = resolveSeatAdapters(ready.models, ready.frozenBackends);
  assert.equal(adapters.nativeMaker, runNativeDevin, 'no generic quiescence override');
  assert.equal(nativeMakerFor('devin_native'), runNativeDevin);
  await assert.rejects(adapters.maker({}), /no text\/API fallback/);
  assert.equal((await prepareCodeSeats({ live: false }, deps)).models.maker.backend, 'codex', 'standing default is unchanged');
});

test('wrong role, model, effort, executor or consent cannot launch SWE', async () => {
  for (const patch of [{ model: 'other' }, { effort: 'high' }, { codeExecutor: undefined }, { codeExecutor: 'file_actions' },
    { observedBudgetConsent: undefined }, { observedBudgetConsent: true }]) await assert.rejects(prepare({ ...selected, ...patch }), /SWE requires/);
  await assert.rejects(prepare(selected, { pairing: { maker: peer, reviewer: selected } }), /cannot execute/);
  await assert.rejects(prepare({ ...peer, observedBudgetConsent: DEVIN_OBSERVED_CONSENT }), /different executor/);
  await assert.rejects(prepareCodeSeats({ live: false, pairing: { maker: selected, reviewer } },
    { ...deps, backends: () => ({ ...definitions, devin: { kind: 'openai_compat' } }) }), /conflicts/);
});

test('catalog distinguishes installed code capability from qualification and unsupported hosts', async () => {
  const catalog = await codeModelChoices(deps.catalog(), { platform: 'darwin', arch: 'arm64',
    readiness: async executor => ({ executor, ready: false }), devinReadiness: async () => ({ ready: true, detail: 'fixture only' }) });
  const swe = catalog.maker.find(seat => seat.backend === 'devin');
  assert.equal(swe.available, true); assert.equal(swe.modelQualification.qualified, false);
  assert.deepEqual(swe.codeExecutors, ['devin_native']);
  assert.equal(catalog.reviewer.some(seat => seat.backend === 'devin'), false);
  assert.equal((await devinCodeReadiness({ platform: 'linux', arch: 'arm64' })).ready, false);
});

test('CLI requires narrow per-selection consent; frozen continuation needs no new selection', () => {
  const args = ['--maker', 'devin:swe-2-high', '--reviewer', 'codex:gpt-5.6-luna', '--maker-executor', 'devin_native', '--max-tokens', '65536'];
  assert.throws(() => parseCodeBuildArgs(args), /accept-devin-unmetered/);
  assert.equal(parseCodeBuildArgs([...args, '--accept-devin-unmetered'])['accept-devin-unmetered'], true);
  assert.throws(() => parseCodeBuildArgs(['--accept-devin-unmetered']), /explicit Devin/);
  assert.throws(() => parseCodeBuildArgs(['--resume', 'run', ...args, '--accept-devin-unmetered']), /exact model-change/);
  assert.deepEqual(parseCodeBuildArgs(['--resume', 'run']), { resume: 'run' });
});
