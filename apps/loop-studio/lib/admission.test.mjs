import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { admissionCatalog, admittedSeat, pairingPresentation } from './admission.mjs';
import { deepQualifyModel } from './capability-probes.mjs';
import { listBackends } from './models.mjs';
import { providerTemplates, plannedProtocols } from './provider-templates.mjs';

const temp = mkdtempSync(join(tmpdir(), 'camus-admission-'));
const modelsFile = join(temp, 'models.json');
const previous = {
  STUDIO_MODELS_FILE: process.env.STUDIO_MODELS_FILE,
  STUDIO_GRANDFATHER_DIR: process.env.STUDIO_GRANDFATHER_DIR,
  STUDIO_CAPABILITY_DIR: process.env.STUDIO_CAPABILITY_DIR,
};
process.env.STUDIO_MODELS_FILE = modelsFile;
process.env.STUDIO_GRANDFATHER_DIR = temp;
delete process.env.STUDIO_CAPABILITY_DIR;

writeFileSync(modelsFile, `${JSON.stringify({
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  connections: { local_qwen: { kind: 'loopback', port: 19192, basePath: '/v1' } },
  backends: {
    qwen_local: {
      kind: 'openai_compat', provider: 'self_hosted', connection: 'local_qwen', protocol: 'chat_completions',
      trainingOrg: 'alibaba', modelFamily: 'qwen', derivedFrom: null, inferenceOperator: 'self_hosted',
      auth: { kind: 'none' }, models: ['qwen3-coder', 'qwen3-unlisted', 'qwen3-expired'], seats: ['maker', 'reviewer'],
    },
  },
}, null, 2)}\n`);

const REVIEW = JSON.stringify({
  verdict: 'clean', findings: [], questions_for_human: [],
  claim_assessments: [], coverage_assessments: [], threshold_assessments: [],
});

function successfulStream({ model, malformedReviewer = false } = {}) {
  return async ({ prompt }) => {
    const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1];
    const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1];
    const context = head && tail;
    const structured = /review schema/i.test(prompt);
    return {
      text: context ? `${head} ${tail}` : structured ? (malformedReviewer ? 'not json' : REVIEW) : 'live',
      responseModel: model,
      reportedModels: [model],
      usage: { prompt_tokens: 100_000, completion_tokens: 8 },
      deltaCount: 1,
    };
  };
}

const discoveryUnavailable = async () => { throw new Error('fixture has no discovery route'); };
const discoveryUnlisted = async (url) => {
  if (String(url).endsWith('/models')) {
    return { ok: true, json: async () => ({ data: [{ id: 'some-other-model', context_length: 131072 }] }) };
  }
  return { ok: false, status: 404, json: async () => null, text: async () => '' };
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  if (process.env.VERBOSE) console.log('  ok', name);
}

try {
  const backend = () => listBackends().qwen_local;

  await check('built-ins are admitted while every unprobed custom tuple is disabled', () => {
    const catalog = admissionCatalog();
    assert.ok(admittedSeat(catalog.maker, 'claude', 'sonnet'));
    assert.ok(admittedSeat(catalog.reviewer, 'codex', 'gpt-5.4-mini'));
    const custom = catalog.maker.find((entry) => entry.backend === 'qwen_local' && entry.model === 'qwen3-coder');
    assert.equal(custom.admission.qualified, false);
    assert.equal(custom.admission.status, 'unprobed');
    assert.equal(admittedSeat(catalog.maker, 'qwen_local', 'qwen3-coder'), null);
  });

  await check('one valid maker receipt enables exactly that backend/model/seat tuple', async () => {
    const result = await deepQualifyModel({
      entry: backend(), model: 'qwen3-coder', seatType: 'words_maker',
      streamImpl: successfulStream({ model: 'qwen3-coder' }), fetchImpl: discoveryUnavailable,
      contextProbeTokens: 64,
    });
    assert.equal(result.qualified, true, result.reason);
    const catalog = admissionCatalog();
    const maker = admittedSeat(catalog.maker, 'qwen_local', 'qwen3-coder');
    assert.ok(maker, 'the exact maker tuple is admitted');
    assert.match(maker.admission.fingerprint, /^qual1:[0-9a-f]{64}$/);
    assert.equal(maker.admission.discoveryStatus, 'discovery_unavailable', 'discovery absence is visible but never gates');
    assert.equal(admittedSeat(catalog.reviewer, 'qwen_local', 'qwen3-coder'), null, 'the same receipt cannot cross the seat boundary');
    assert.equal(admittedSeat(catalog.maker, 'qwen_local', 'qwen3-unlisted'), null, 'the same receipt cannot cross the model boundary');
  });

  await check('a failed reviewer receipt is visible as failed and cannot launch', async () => {
    const result = await deepQualifyModel({
      entry: backend(), model: 'qwen3-coder', seatType: 'words_reviewer',
      streamImpl: successfulStream({ model: 'qwen3-coder', malformedReviewer: true }), fetchImpl: discoveryUnavailable,
      contextProbeTokens: 64,
    });
    assert.equal(result.qualified, false);
    const entry = admissionCatalog().reviewer.find((candidate) => candidate.backend === 'qwen_local' && candidate.model === 'qwen3-coder');
    assert.equal(entry.admission.status, 'failed');
    assert.ok(entry.admission.missing.includes('structuredOutput'));
  });

  await check('an expired receipt remains refused and says expired', async () => {
    const old = new Date(Date.now() - 45 * 86400000).toISOString();
    await deepQualifyModel({
      entry: backend(), model: 'qwen3-expired', seatType: 'words_reviewer',
      streamImpl: successfulStream({ model: 'qwen3-expired' }), fetchImpl: discoveryUnavailable,
      contextProbeTokens: 64, probedAt: old,
    });
    const entry = admissionCatalog().reviewer.find((candidate) => candidate.backend === 'qwen_local' && candidate.model === 'qwen3-expired');
    assert.equal(entry.admission.qualified, false);
    assert.equal(entry.admission.state, 'expired');
    assert.match(entry.admission.warning, /expired/);
  });

  await check('an unlisted declared model can still qualify and is labeled honestly', async () => {
    const result = await deepQualifyModel({
      entry: backend(), model: 'qwen3-unlisted', seatType: 'words_maker',
      streamImpl: successfulStream({ model: 'qwen3-unlisted' }), fetchImpl: discoveryUnlisted,
      contextProbeTokens: 64,
    });
    assert.equal(result.qualified, true, result.reason);
    const entry = admittedSeat(admissionCatalog().maker, 'qwen_local', 'qwen3-unlisted');
    assert.ok(entry, 'discovery is advisory, not an admission gate');
    assert.equal(entry.admission.discoveryStatus, 'unlisted');
  });

  await check('pairing copy and badges come from the server policy layer', () => {
    const catalog = admissionCatalog();
    const maker = admittedSeat(catalog.maker, 'qwen_local', 'qwen3-coder');
    const reviewer = admittedSeat(catalog.reviewer, 'claude', 'sonnet');
    const view = pairingPresentation({ maker, reviewer });
    assert.equal(view.launchable, true);
    assert.ok(['cross_vendor', 'cross_vendor_declared'].includes(view.standing));
    assert.match(view.note, /pairing|makes it/i);
    if (view.standing === 'cross_vendor_declared') assert.doesNotMatch(view.note, /\b(independent|verified)\b/i);
    assert.ok(view.makerBadges.some((badge) => badge.kind === 'operator'));
    assert.ok(view.reviewerBadges.some((badge) => badge.kind === 'transport'));
  });

  await check('provider templates are inert declarations with Responses visibly planned', () => {
    const templates = providerTemplates();
    assert.ok(templates.some((entry) => entry.id === 'xai'));
    assert.ok(templates.some((entry) => entry.id === 'ollama'));
    assert.ok(templates.some((entry) => entry.id === 'vllm'));
    const walkKeys = (value, keys = []) => {
      if (!value || typeof value !== 'object') return keys;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walkKeys(child, keys);
      }
      return keys;
    };
    for (const template of templates) {
      const keys = walkKeys(template);
      assert.ok(!keys.includes('source'), `${template.id} cannot write lineage.source`);
      assert.ok(!keys.includes('receipt') && !keys.includes('qualification'), `${template.id} cannot mint admission`);
      assert.ok(!keys.includes('resolvedBaseUrl') && !keys.includes('resolvedPort') && !keys.includes('localPort'), `${template.id} carries no runtime state`);
      assert.ok(!JSON.stringify(template).includes('apiKeyValue'), `${template.id} carries env names only`);
    }
    assert.deepEqual(plannedProtocols.map(({ id, availability, selectable }) => ({ id, availability, selectable })), [
      { id: 'responses', availability: 'planned', selectable: false },
    ]);
  });
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log(`admission.test: ${passed} checks passed`);
