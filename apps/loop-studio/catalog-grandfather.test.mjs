// Task 8: the catalog identity facts (built-in claude/codex, pre-existing custom,
// the one-edit confirmation upgrade) and the grandfather production LOAD wiring
// (inventory-once / crash-recovery / fail-closed consult) that models.mjs now
// drives through identity.mjs + grandfather.mjs.
//
// Two disciplines this file keeps:
//   - Built-in lineage.source and origin_confidence are NEVER literals here. They
//     are recomputed by calling deriveLineageSource/originConfidence with the same
//     inputs the module uses, so when Task 9 flips claude_cli isolation this test
//     tracks the new truth instead of pinning the pre-flip value.
//   - Secret-shaped fixtures are ASSEMBLED (join), never pasted, and every refusal
//     is asserted to exclude the assembled value — an error must never echo a
//     credential.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  anonymousConnectionName,
  classifyConnectionUrl,
  discoverLegacyHttpBackends,
  getModels,
  listBackends,
  seatCatalog,
  seatIdentityFacts,
} from './lib/models.mjs';
import { deriveLineageSource, executorOrgFamily, originConfidence } from './lib/identity.mjs';
import { initGrandfather, confirmLegacy } from './lib/grandfather.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const trackedPath = join(here, 'checks', 'models.json');
const trackedBefore = readFileSync(trackedPath);
const repoRoot = join(here, '..', '..');
const trackedRelative = 'apps/loop-studio/checks/models.json';
const assertTrackedDefaultsClean = () => {
  const unstaged = spawnSync('git', ['diff', '--quiet', '--', trackedRelative], { cwd: repoRoot });
  const staged = spawnSync('git', ['diff', '--cached', '--quiet', '--', trackedRelative], { cwd: repoRoot });
  assert.equal(unstaged.status, 0, `git diff --quiet ${trackedRelative} must stay clean`);
  assert.equal(staged.status, 0, `git diff --cached --quiet ${trackedRelative} must stay clean`);
};
assertTrackedDefaultsClean();

const temps = [];
const freshGrandfatherDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'camus-cg-gf-'));
  temps.push(dir);
  process.env.STUDIO_GRANDFATHER_DIR = dir;
  return {
    dir,
    json: join(dir, 'grandfather.json'),
    marker: join(dir, 'grandfather.initialized'),
    salt: join(dir, '.machine-salt'),
  };
};

const previous = {
  STUDIO_MODELS_FILE: process.env.STUDIO_MODELS_FILE,
  STUDIO_GRANDFATHER_DIR: process.env.STUDIO_GRANDFATHER_DIR,
  STUDIO_REGISTRY_FILE: process.env.STUDIO_REGISTRY_FILE,
  STUDIO_CODEX_CACHE_FILE: process.env.STUDIO_CODEX_CACHE_FILE,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  CODEX_MODEL: process.env.CODEX_MODEL,
  CODEX_EFFORT: process.env.CODEX_EFFORT,
  ROUND_CAP: process.env.ROUND_CAP,
};
// A models fixture on disk so getModels/seatCatalog read our decision, not the
// operator's real state; grandfather is redirected per-subtest into a temp dir.
const modelsTemp = mkdtempSync(join(tmpdir(), 'camus-cg-models-'));
temps.push(modelsTemp);
const modelsPath = join(modelsTemp, 'models.json');
const codexCachePath = join(modelsTemp, 'codex-cache.json');
writeFileSync(codexCachePath, JSON.stringify({ models: [
  { slug: 'gpt-5.4-mini', visibility: 'list' },
  { slug: 'gpt-5.4', visibility: 'list' },
  { slug: 'codex-auto-review', visibility: 'hide' },
] }));
process.env.STUDIO_MODELS_FILE = modelsPath;
process.env.STUDIO_CODEX_CACHE_FILE = codexCachePath;
delete process.env.STUDIO_REGISTRY_FILE; // use the tracked registry
for (const key of ['CLAUDE_MODEL', 'CODEX_MODEL', 'CODEX_EFFORT', 'ROUND_CAP']) delete process.env[key];

let passed = 0;
const check = (name, fn) => {
  fn();
  assertTrackedDefaultsClean();
  passed += 1;
  if (process.env.VERBOSE) console.log('  ok', name);
};
const writeModels = (value) => writeFileSync(modelsPath, `${JSON.stringify(value, null, 2)}\n`);
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const identityKeys = new Set([
  'executor', 'transport', 'connection', 'protocol', 'trainingOrg', 'modelFamily',
  'inferenceOperator', 'lineage', 'originConfidence',
]);
const withoutIdentity = (entry) => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !identityKeys.has(key)),
);
const legacySurface = (models, catalog) => ({
  getModels: {
    ...models,
    maker: withoutIdentity(models.maker),
    reviewer: withoutIdentity(models.reviewer),
  },
  seatCatalog: {
    ...catalog,
    maker: catalog.maker.map(withoutIdentity),
    reviewer: catalog.reviewer.map(withoutIdentity),
  },
});

// A legacy custom backend: bare loopback baseUrl, no lineage declarations.
const KIMI_URL = 'http://127.0.0.1:9/v1';
const legacyKimi = () => ({
  kind: 'openai_compat', provider: 'moonshot', baseUrl: KIMI_URL,
  apiKeyEnv: 'CAMUS_TEST_MOONSHOT_KEY', models: ['kimi-k2'],
});
const baseDecision = (extra = {}) => ({
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  ...extra,
});

// legacy_http custom backends (private-IP baseUrls classify to legacy_http).
const OLLAMA_URL = 'http://192.168.1.9:11434/v1';
const LAB_URL = 'http://10.0.0.4:1234/v1';
const legacyHttp = (provider, baseUrl, apiKeyEnv, model) => ({
  kind: 'openai_compat', provider, baseUrl, apiKeyEnv, models: [model],
});

try {
  // ---- 1. golden identity: old fields identical, built-ins dynamic, legacy unknown
  check('golden catalog identity: old fields intact, built-ins derived, legacy custom unknown', () => {
    freshGrandfatherDir();
    writeModels(baseDecision({ backends: { kimi: legacyKimi() } }));
    const m = getModels();
    const seats = seatCatalog();
    const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'pre-open-model-seats.golden.json'), 'utf8'));
    assert.deepEqual(legacySurface(m, seats), golden, 'the complete pre-Task-8 getModels/seatCatalog surface matches its golden');

    // The golden above owns whole-output compatibility; these checks make the
    // dynamic identity expectations readable at the exact affected seats.
    assert.deepEqual(pick(m.maker, ['backend', 'provider', 'model', 'source']), {
      backend: 'claude', provider: 'anthropic', model: 'sonnet', source: 'STUDIO_MODELS_FILE',
    });
    assert.deepEqual(pick(m.reviewer, ['backend', 'provider', 'model', 'effort', 'modelSource', 'effortSource']), {
      backend: 'codex', provider: 'openai', model: 'gpt-5.4-mini', effort: 'low',
      modelSource: 'STUDIO_MODELS_FILE', effortSource: 'STUDIO_MODELS_FILE',
    });

    // Built-in identity, computed dynamically (never a frozen 'unknown'/'registry').
    const makerSource = deriveLineageSource({ executorKind: 'claude_cli', transport: 'vendor_managed' });
    const claudeOF = executorOrgFamily('claude_cli');
    assert.equal(m.maker.executor, 'claude_cli');
    assert.equal(m.maker.transport, 'vendor_managed');
    assert.equal(m.maker.protocol, 'vendor_session');
    assert.equal(m.maker.connection, null);
    assert.equal(m.maker.inferenceOperator, 'anthropic');
    assert.equal(m.maker.trainingOrg, claudeOF.org);
    assert.equal(m.maker.modelFamily, claudeOF.family);
    assert.equal(m.maker.lineage.source, makerSource);
    assert.equal(m.maker.lineage.derivedFrom, null);
    assert.equal(m.maker.originConfidence, originConfidence(makerSource));

    const reviewerSource = deriveLineageSource({ executorKind: 'codex_cli', transport: 'vendor_managed' });
    const codexOF = executorOrgFamily('codex_cli');
    assert.equal(m.reviewer.executor, 'codex_cli');
    assert.equal(m.reviewer.transport, 'vendor_managed');
    assert.equal(m.reviewer.protocol, 'vendor_session');
    assert.equal(m.reviewer.inferenceOperator, 'openai');
    assert.equal(m.reviewer.trainingOrg, codexOF.org);
    assert.equal(m.reviewer.modelFamily, codexOF.family);
    assert.equal(m.reviewer.lineage.source, reviewerSource);
    assert.equal(m.reviewer.originConfidence, originConfidence(reviewerSource));

    // seatCatalog: built-in old fields intact + same dynamic identity.
    const claudeSeat = seats.maker.find((e) => e.backend === 'claude' && e.model === 'sonnet');
    assert.deepEqual(pick(claudeSeat, ['backend', 'provider', 'model', 'source', 'effort']), {
      backend: 'claude', provider: 'anthropic', model: 'sonnet', source: 'builtin_alias', effort: false,
    });
    assert.equal(claudeSeat.lineage.source, makerSource);
    assert.equal(claudeSeat.originConfidence, originConfidence(makerSource));

    // Pre-existing custom (kimi): every added identity field is unknown, and no
    // origin/operator is mined from its provider or model strings.
    const kimiSeat = seats.maker.find((e) => e.backend === 'kimi');
    assert.deepEqual(pick(kimiSeat, ['backend', 'provider', 'model', 'source']), {
      backend: 'kimi', provider: 'moonshot', model: 'kimi-k2', source: 'STUDIO_MODELS_FILE',
    });
    assert.equal(kimiSeat.executor, 'http_client');
    assert.equal(kimiSeat.transport, 'unknown');
    assert.equal(kimiSeat.protocol, 'chat_completions');
    assert.equal(kimiSeat.trainingOrg, 'unknown');
    assert.equal(kimiSeat.modelFamily, 'unknown');
    assert.equal(kimiSeat.inferenceOperator, 'unknown');
    assert.equal(kimiSeat.lineage.source, 'unknown');
    assert.equal(kimiSeat.lineage.derivedFrom, null);
    assert.equal(kimiSeat.originConfidence, 'unknown');
    // It retains its deterministic anonymous connection reference internally.
    assert.equal(kimiSeat.connection, anonymousConnectionName('kimi'));

    // The selected getModels surface carries the same unknown identity without
    // changing any of its pre-existing decision keys.
    writeModels(baseDecision({ maker: { backend: 'kimi', model: 'kimi-k2' }, backends: { kimi: legacyKimi() } }));
    const selected = getModels().maker;
    assert.deepEqual(pick(selected, ['backend', 'provider', 'model', 'source']), {
      backend: 'kimi', provider: 'moonshot', model: 'kimi-k2', source: 'STUDIO_MODELS_FILE',
    });
    assert.equal(selected.trainingOrg, 'unknown');
    assert.equal(selected.modelFamily, 'unknown');
    assert.equal(selected.lineage.source, 'unknown');
  });

  check('one edit adding declarations upgrades the legacy custom identity', () => {
    freshGrandfatherDir();
    const declared = { org: 'moonshot', family: 'kimi', derivedFrom: null };
    const upgraded = { ...legacyKimi(), trainingOrg: declared.org, modelFamily: declared.family, derivedFrom: declared.derivedFrom, inferenceOperator: 'moonshot' };
    writeModels(baseDecision({ backends: { kimi: upgraded } }));

    const connectionKind = classifyConnectionUrl(KIMI_URL).kind;
    const expectedSource = deriveLineageSource({ connectionKind, endpointHost: '127.0.0.1', modelId: 'kimi-k2', declared });
    const kimiSeat = seatCatalog().maker.find((e) => e.backend === 'kimi');
    assert.equal(kimiSeat.trainingOrg, 'moonshot');
    assert.equal(kimiSeat.modelFamily, 'kimi');
    assert.equal(kimiSeat.inferenceOperator, 'moonshot');
    assert.equal(kimiSeat.transport, connectionKind, 'transport becomes the classified anonymous connection kind');
    assert.equal(kimiSeat.protocol, 'chat_completions');
    assert.equal(kimiSeat.lineage.source, expectedSource);
    assert.equal(kimiSeat.originConfidence, originConfidence(expectedSource));
    assert.notEqual(expectedSource, 'unknown', 'the declaration actually upgraded the source off unknown');

    // Partial declarations refuse rather than half-upgrading.
    const partial = { ...legacyKimi(), trainingOrg: 'moonshot' }; // no modelFamily / derivedFrom
    writeModels(baseDecision({ backends: { kimi: partial } }));
    assert.throws(() => seatCatalog(), /modelFamily/);

    const forgedSource = { ...legacyKimi(), lineage: { source: null } };
    writeModels(baseDecision({ backends: { kimi: forgedSource } }));
    assert.throws(() => seatCatalog(), /lineage\.source is derived, never configured/);
  });

  check('an empty first-load inventory prevents later bulk-grandfathering', () => {
    const p = freshGrandfatherDir();
    assert.doesNotThrow(() => listBackends(baseDecision()), 'a config with no legacy entries initializes an empty boundary');
    const initialized = JSON.parse(readFileSync(p.json, 'utf8'));
    assert.deepEqual(initialized.records, []);
    assert.equal(existsSync(p.marker), true);

    const pasted = baseDecision({
      backends: { ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3') },
    });
    assert.throws(() => listBackends(pasted), /no grandfather/, 'a later legacy entry is not silently snapshotted');
    assert.deepEqual(JSON.parse(readFileSync(p.json, 'utf8')).records, []);
  });

  // ---- 2. first load with neither artifact: snapshot all discovered legacy_http
  check('first load with neither artifact snapshots every discovered legacy_http entry, then loads', () => {
    const p = freshGrandfatherDir();
    const file = baseDecision({
      backends: {
        ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3'),
        lab: legacyHttp('lab', LAB_URL, 'CAMUS_TEST_LAB_KEY', 'qwen-lab'),
      },
    });
    const discovered = discoverLegacyHttpBackends(file);
    assert.deepEqual(discovered, [
      { backendName: 'ollama', url: OLLAMA_URL },
      { backendName: 'lab', url: LAB_URL },
    ]);
    assert.equal(existsSync(p.json), false);
    assert.equal(existsSync(p.marker), false);

    assert.doesNotThrow(() => listBackends(file), 'the production loader snapshots and loads all discovered entries');
    assert.equal(existsSync(p.json), true, 'records were written first');
    assert.equal(existsSync(p.marker), true, 'then the marker');
    const data = JSON.parse(readFileSync(p.json, 'utf8'));
    assert.deepEqual(
      data.records.map((r) => ({ backendName: r.backendName, url: r.url, source: r.source, why: r.why })),
      discovered.map((d) => ({ backendName: d.backendName, url: d.url, source: 'snapshot', why: null })),
    );
    // The catalog stamps the special legacy transport even though origin facts
    // remain unknown for this undeclared pre-existing custom backend.
    writeModels(file);
    const ollamaSeat = seatCatalog().maker.find((entry) => entry.backend === 'ollama');
    assert.equal(ollamaSeat.transport, 'legacy_http');
    assert.equal(ollamaSeat.trainingOrg, 'unknown');
    assert.equal(ollamaSeat.lineage.source, 'unknown');
  });

  // ---- 3. second load is a byte-for-byte records no-op
  check('second load is a byte-for-byte grandfather.json no-op', () => {
    const p = freshGrandfatherDir();
    const file = baseDecision({ backends: { ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3') } });
    listBackends(file);
    const first = readFileSync(p.json);
    const marker = readFileSync(p.marker);
    assert.doesNotThrow(() => listBackends(file), 'a second production load consults from records only');
    assert.deepEqual(readFileSync(p.json), first, 'records untouched');
    assert.deepEqual(readFileSync(p.marker), marker, 'marker untouched');
  });

  // ---- 4. crash recovery: records present, marker absent, new legacy entry refuses
  check('crash recovery finishes the marker from records; a newly added entry refuses and is never appended', () => {
    const p = freshGrandfatherDir();
    const recorded = baseDecision({ backends: { ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3') } });
    listBackends(recorded);
    const recordsAfterInit = readFileSync(p.json);

    // Simulate a crash between records and marker: records survive, marker gone.
    unlinkSync(p.marker);
    // A brand-new legacy-shaped entry pasted after the crash window.
    const withPasted = baseDecision({
      backends: {
        ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3'),
        lab: legacyHttp('lab', LAB_URL, 'CAMUS_TEST_LAB_KEY', 'qwen-lab'),
      },
    });
    assert.throws(
      () => listBackends(withPasted),
      (err) => /legacy_http backend "lab"/.test(err.message) && /no grandfather/.test(err.message) && /confirmLegacy/.test(err.message),
      'the added entry refuses via the fail-closed unrecorded message',
    );
    assert.equal(existsSync(p.marker), true, 'the marker was finished from the existing records only');
    const data = JSON.parse(readFileSync(p.json, 'utf8'));
    assert.equal(data.records.length, 1, 'no second inventory: lab was never recorded');
    assert.equal(data.records[0].backendName, 'ollama');
    assert.deepEqual(readFileSync(p.json), recordsAfterInit, 'records file is byte-identical — the pasted entry was never appended');
  });

  // ---- 5. marker present + broken records: every state refuses, repaired control loads
  check('marker present with missing/truncated/wrong-version/HMAC-broken records refuses every legacy entry', () => {
    const p = freshGrandfatherDir();
    const file = baseDecision({ backends: { ollama: legacyHttp('ollama', OLLAMA_URL, 'CAMUS_TEST_OLLAMA_KEY', 'llama3') } });
    listBackends(file); // valid records + marker + salt through production load
    const validRecords = readFileSync(p.json);

    const breakInto = (writeBroken) => {
      writeBroken();
      assert.throws(
        () => listBackends(file),
        (err) => /initialization is complete/.test(err.message) && /confirmLegacy/.test(err.message),
      );
      // Repaired control: restore the valid records and prove it loads again.
      writeFileSync(p.json, validRecords);
      assert.doesNotThrow(() => listBackends(file), 'the repaired production load succeeds');
    };

    breakInto(() => unlinkSync(p.json)); // missing
    breakInto(() => writeFileSync(p.json, 'not-json{')); // unparseable / truncated
    breakInto(() => {
      const data = JSON.parse(validRecords.toString());
      data.schemaVersion = 2;
      writeFileSync(p.json, JSON.stringify(data, null, 2) + '\n');
    }); // wrong-version
    breakInto(() => {
      const data = JSON.parse(validRecords.toString());
      const m = data.records[0].marker;
      data.records[0].marker = (m[0] === '0' ? '1' : '0') + m.slice(1); // valid 64-hex shape, wrong HMAC
      writeFileSync(p.json, JSON.stringify(data, null, 2) + '\n');
    }); // HMAC-broken
  });

  // ---- 6. explicit confirmation path upgrades an unrecorded entry, then it loads
  check('explicit confirmation upgrades an unrecorded legacy entry so the next load succeeds', () => {
    freshGrandfatherDir();
    initGrandfather({ legacyEntries: [] }); // empty inventory: marker present, no records
    const file = baseDecision({ backends: { pasted: legacyHttp('pasted', LAB_URL, 'CAMUS_TEST_PASTED_KEY', 'qwen-lab') } });
    const [entry] = discoverLegacyHttpBackends(file);
    assert.throws(() => listBackends(file), /no grandfather/, 'an empty inventory cannot bulk-grandfather a pasted entry');

    confirmLegacy(entry.backendName, entry.url, 'operator vouches for this lab box');
    assert.doesNotThrow(() => listBackends(file), 'after explicit confirmation the entry loads');
  });

  // ---- 7. secret-shaped fixtures: refusals never echo credential values
  check('assembled secret-shaped fixtures refuse without echoing their values', () => {
    const p = freshGrandfatherDir();
    const password = ['pass', 'word', 'secret'].join('-');
    const urlCredential = baseDecision({
      backends: { leaky: { kind: 'openai_compat', provider: 'lab', baseUrl: `http://user:${password}@192.168.1.9:11434/v1`, apiKeyEnv: 'CAMUS_TEST_LAB_KEY', models: ['m'] } },
    });
    assert.throws(
      () => listBackends(urlCredential),
      (err) => /must not contain credentials/.test(err.message) && !err.message.includes(password),
    );
    assert.equal(existsSync(p.json), false, 'a malformed backend never earns grandfather records');
    assert.equal(existsSync(p.marker), false, 'nor an initialization marker');

    const authValue = ['sk', 'planted', 'token'].join('-');
    const authCredential = baseDecision({
      connections: { lab: { kind: 'loopback', baseUrl: 'http://127.0.0.1:11434/v1' } },
      backends: {
        labai: {
          kind: 'openai_compat', provider: 'lab', connection: 'lab', protocol: 'chat_completions',
          trainingOrg: 'unknown-org-name', modelFamily: 'lab-family', derivedFrom: null,
          auth: { kind: 'env', envVar: 'CAMUS_TEST_LAB_KEY', value: authValue }, models: ['m'],
        },
      },
    });
    assert.throws(
      () => listBackends(authCredential),
      (err) => /credential values are forbidden/.test(err.message) && !err.message.includes(authValue),
    );

    const envValue = ['bearer', 'planted', 'value'].join('-');
    const envCredential = baseDecision({
      connections: { lab2: { kind: 'loopback', baseUrl: 'http://127.0.0.1:1234/v1' } },
      backends: {
        labenv: {
          kind: 'openai_compat', provider: 'lab', connection: 'lab2', protocol: 'chat_completions',
          trainingOrg: 'lab-org', modelFamily: 'lab-family', derivedFrom: null,
          auth: { kind: 'env', envVar: 'CAMUS_TEST_LAB_KEY' }, apiKeyEnv: envValue, models: ['m'],
        },
      },
    });
    assert.throws(
      () => listBackends(envCredential),
      (err) => /env-var NAME/.test(err.message) && !err.message.includes(envValue),
    );
  });

  // ---- 8. tracked defaults untouched
  check('tracked checks/models.json bytes remain identical', () => {
    assert.deepEqual(readFileSync(trackedPath), trackedBefore);
    assertTrackedDefaultsClean();
  });

  // seatIdentityFacts is the shared derivation both getModels and seatCatalog use.
  check('seatIdentityFacts derives the same built-in truth the catalog exposes', () => {
    const backends = listBackends(baseDecision());
    const facts = seatIdentityFacts(backends.codex, 'gpt-5.4-mini');
    const source = deriveLineageSource({ executorKind: 'codex_cli', transport: 'vendor_managed' });
    assert.equal(facts.lineage.source, source);
    assert.equal(facts.originConfidence, originConfidence(source));
  });
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`catalog-grandfather tests: ${passed} passed`);
