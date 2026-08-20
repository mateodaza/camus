import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anonymousConnectionName,
  classifyConnectionUrl,
  getModels,
  listBackends,
  parseConnections,
  updateModels,
  validateLegacyCompatEntry,
} from './lib/models.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const trackedPath = join(here, 'checks', 'models.json');
const trackedBefore = readFileSync(trackedPath);
const temp = mkdtempSync(join(tmpdir(), 'camus-connections-'));
const modelsPath = join(temp, 'models.json');
const previous = {
  STUDIO_MODELS_FILE: process.env.STUDIO_MODELS_FILE,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  CODEX_MODEL: process.env.CODEX_MODEL,
  CODEX_EFFORT: process.env.CODEX_EFFORT,
};
process.env.STUDIO_MODELS_FILE = modelsPath;
delete process.env.CLAUDE_MODEL;
delete process.env.CODEX_MODEL;
delete process.env.CODEX_EFFORT;

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  if (process.env.VERBOSE) console.log('  ok', name);
};
const decision = (extra = {}) => ({
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  ...extra,
});
const write = (value) => writeFileSync(modelsPath, `${JSON.stringify(value, null, 2)}\n`);
const validXai = () => ({
  connections: { xai: { kind: 'direct_https', baseUrl: 'https://api.x.ai/v1' } },
  backends: {
    grok: {
      kind: 'openai_compat', provider: 'xai', connection: 'xai', protocol: 'chat_completions',
      trainingOrg: 'xai', modelFamily: 'grok', inferenceOperator: 'xai',
      derivedFrom: null,
      auth: { kind: 'env', envVar: 'CAMUS_TEST_XAI_KEY' }, models: ['grok-4.6'], seats: ['maker', 'reviewer'],
    },
  },
});

try {
  check('classifies old URLs into the three connection kinds without writing', () => {
    assert.deepEqual(classifyConnectionUrl('http://127.0.0.1:11434/v1'), { kind: 'loopback', baseUrl: 'http://127.0.0.1:11434/v1' });
    assert.deepEqual(classifyConnectionUrl('https://api.x.ai/v1'), { kind: 'direct_https', baseUrl: 'https://api.x.ai/v1' });
    assert.deepEqual(classifyConnectionUrl('http://192.168.4.20:11434/v1'), { kind: 'legacy_http', baseUrl: 'http://192.168.4.20:11434/v1' });
    assert.deepEqual(classifyConnectionUrl('https://model.internal/v1'), { kind: 'legacy_http', baseUrl: 'https://model.internal/v1' });
  });

  check('parses named loopback/direct/legacy connections and anonymous migration', () => {
    const file = {
      connections: {
        local: { kind: 'loopback', port: 11434, basePath: '/v1' },
        hosted: { kind: 'direct_https', baseUrl: 'https://api.x.ai/v1' },
        old_lab: { kind: 'legacy_http', baseUrl: 'http://192.168.4.20:11434/v1' },
      },
      backends: {
        old: { kind: 'openai_compat', provider: 'lab', baseUrl: 'http://192.168.4.21:11434/v1', apiKeyEnv: 'LAB_KEY', models: ['qwen-old'] },
      },
    };
    const connections = parseConnections(file);
    assert.equal(connections.local.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(connections.hosted.kind, 'direct_https');
    assert.equal(connections.old_lab.kind, 'legacy_http');
    const anonymous = connections[anonymousConnectionName('old')];
    assert.equal(anonymous.kind, 'legacy_http');
    assert.equal(anonymous.anonymous, true);
  });

  check('legacy backend loads through an anonymous connection but stays unclassified here', () => {
    const legacy = {
      kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'CAMUS_TEST_MOONSHOT_KEY', models: ['kimi-k2'],
    };
    const parsed = listBackends(decision({ backends: { kimi: legacy } })).kimi;
    assert.equal(parsed.connection, anonymousConnectionName('kimi'));
    assert.equal(parsed.connectionDetails.kind, 'loopback');
    assert.equal(parsed.transport, undefined, 'Task 8 owns the pre-existing-custom transport classification');
    assert.equal(parsed.provider, 'moonshot');
  });

  check('an undeclared connection refuses with the declaration fix', () => {
    const fixture = validXai();
    assert.doesNotThrow(() => listBackends(decision(fixture)), 'valid control loads');
    fixture.backends.grok.connection = 'missing_xai';
    assert.throws(
      () => listBackends(decision(fixture)),
      (error) => /undeclared connection "missing_xai"/.test(error.message) && /top-level connections/.test(error.message),
    );
  });

  check('unsupported SSH and remote-executor kinds refuse distinctly', () => {
    const base = validXai();
    assert.doesNotThrow(() => listBackends(decision(base)), 'supported control loads');
    assert.throws(
      () => parseConnections({ connections: { gpu: { kind: 'ssh_tunnel', remoteAddress: '127.0.0.1' } } }),
      (error) => /ssh_tunnel is not yet supported/.test(error.message) && /see ADR/.test(error.message),
    );
    assert.throws(
      () => parseConnections({ connections: { remote: { kind: 'remote_executor' } } }),
      (error) => /remote_executor is not yet supported/.test(error.message) && /see ADR/.test(error.message),
    );
  });

  check('SSH remoteAddress refuses a pivot before the unsupported-kind refusal', () => {
    assert.throws(
      () => parseConnections({ connections: { gpu: { kind: 'ssh_tunnel', remoteAddress: '10.0.0.8' } } }),
      (error) => /remoteAddress/.test(error.message) && /remote loopback/.test(error.message) && /pivot/.test(error.message),
    );
    assert.throws(
      () => parseConnections({ connections: { gpu: { kind: 'ssh_tunnel', remoteAddress: 'localhost' } } }),
      /not yet supported/,
      'break-on-purpose control reaches the later unsupported-kind guard',
    );
  });

  check('loopback refuses non-loopback hosts', () => {
    assert.doesNotThrow(() => parseConnections({ connections: { local: { kind: 'loopback', baseUrl: 'http://[::1]:11434/v1' } } }));
    assert.throws(
      () => parseConnections({ connections: { local: { kind: 'loopback', baseUrl: 'http://example.com/v1' } } }),
      /loopback refuses non-loopback host/,
    );
  });

  check('direct_https refuses unsafe endpoint classes while a public DNS control loads', () => {
    assert.doesNotThrow(() => parseConnections({ connections: { public_api: { kind: 'direct_https', baseUrl: 'https://api.x.ai/v1' } } }));
    const refused = [
      ['http://api.x.ai/v1', /requires https/],
      ['https://8.8.8.8/v1', /literal-IP/],
      ['https://192.168.1.2/v1', /literal-IP/],
      ['https://169.254.169.254/latest', /literal-IP/],
      ['https://localhost/v1', /private\/internal/],
      ['https://model.internal/v1', /private\/internal/],
      ['https://metadata.google.internal/v1', /private\/internal/],
    ];
    for (const [baseUrl, pattern] of refused) {
      assert.throws(() => parseConnections({ connections: { bad: { kind: 'direct_https', baseUrl } } }), pattern, baseUrl);
    }
    assert.equal(
      parseConnections({ connections: { grandfathered: { kind: 'legacy_http', baseUrl: 'http://192.168.1.2:11434/v1' } } }).grandfathered.kind,
      'legacy_http',
      'the exemption is reachable only by its explicit kind',
    );
  });

  check('new connection backends carry declared identity and connection transport', () => {
    const backend = listBackends(decision(validXai())).grok;
    assert.equal(backend.transport, 'direct_https');
    assert.equal(backend.connection, 'xai');
    assert.equal(backend.trainingOrg, 'xai');
    assert.equal(backend.modelFamily, 'grok');
    assert.equal(backend.lineageSources['grok-4.6'], 'registry');
  });

  check('new backends require known declarations and the supported protocol', () => {
    const fixture = validXai();
    assert.doesNotThrow(() => listBackends(decision(fixture)), 'complete declaration control loads');
    for (const field of ['trainingOrg', 'modelFamily']) {
      const missing = structuredClone(fixture);
      delete missing.backends.grok[field];
      assert.throws(() => listBackends(decision(missing)), new RegExp(field));
      const unknown = structuredClone(fixture);
      unknown.backends.grok[field] = 'unknown';
      assert.throws(() => listBackends(decision(unknown)), /reserved for legacy entries/);
    }
    const wrongProtocol = structuredClone(fixture);
    wrongProtocol.backends.grok.protocol = 'responses';
    assert.throws(() => listBackends(decision(wrongProtocol)), /protocol must be "chat_completions"/);
    const missingLineage = structuredClone(fixture);
    delete missingLineage.backends.grok.derivedFrom;
    assert.throws(() => listBackends(decision(missingLineage)), /missing backends\.grok\.derivedFrom/);
  });

  check('lineage.source in config refuses even when null', () => {
    const fixture = validXai();
    assert.doesNotThrow(() => listBackends(decision(fixture)), 'declarations without source are valid');
    fixture.backends.grok.lineage = { source: null };
    assert.throws(() => listBackends(decision(fixture)), /lineage\.source is derived, never configured/);
  });

  check('a declaration contradicting the registry refuses and names both facts', () => {
    const fixture = validXai();
    assert.doesNotThrow(() => listBackends(decision(fixture)), 'matching declarations derive registry');
    fixture.backends.grok.trainingOrg = 'openai';
    fixture.backends.grok.modelFamily = 'gpt';
    assert.throws(
      () => listBackends(decision(fixture)),
      (error) => /declared openai\/gpt/.test(error.message) && /registry xai\/grok/.test(error.message),
    );
  });

  check('ordinary settings saves preserve pre-existing legacy backend shape', () => {
    const legacy = {
      kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'CAMUS_TEST_MOONSHOT_KEY', models: ['kimi-k2'], why: 'pre-connection entry',
    };
    write(decision({ backends: { kimi: legacy } }));
    updateModels({ roundCap: 3 });
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, 'utf8')).backends.kimi, legacy);
  });

  check('ordinary settings saves do not normalize an unedited connection backend', () => {
    const fixture = validXai();
    write(decision(fixture));
    const before = JSON.parse(readFileSync(modelsPath, 'utf8'));
    updateModels({ roundCap: 3 });
    const after = JSON.parse(readFileSync(modelsPath, 'utf8'));
    assert.deepEqual(after.connections, before.connections, 'connection declarations remain untouched');
    assert.deepEqual(after.backends, before.backends, 'no dual-write fields or defaults are injected without an edit');
    assert.equal(Object.hasOwn(after.backends.grok, 'baseUrl'), false);
    assert.equal(Object.hasOwn(after.backends.grok, 'apiKeyEnv'), false);
  });

  check('updateModels dual-writes the complete real legacy surface for keyed and keyless entries', () => {
    write(decision());
    const runtimeUrl = ['http://127.0.0.1:', '49177/v1'].join('');
    const connections = {
      xai: { kind: 'direct_https', baseUrl: 'https://api.x.ai/v1', resolvedBaseUrl: runtimeUrl, localPort: 49177 },
      local: { kind: 'loopback', port: 11434, basePath: '/v1', resolvedPort: 49177 },
    };
    const xai = validXai().backends.grok;
    const qwen = {
      kind: 'openai_compat', provider: 'local-lab', connection: 'local', protocol: 'chat_completions',
      trainingOrg: 'alibaba', modelFamily: 'qwen', inferenceOperator: 'self_hosted',
      derivedFrom: null,
      auth: { kind: 'none' }, models: ['qwen3-coder'], seats: ['reviewer'],
      resolvedBaseUrl: runtimeUrl, resolvedPort: 49177,
    };
    updateModels({ connections, backends: { grok: xai, qwen } });
    const persisted = JSON.parse(readFileSync(modelsPath, 'utf8'));
    for (const name of ['grok', 'qwen']) {
      const entry = persisted.backends[name];
      assert.doesNotThrow(() => validateLegacyCompatEntry(name, entry), `${name} loads under the real pre-connection validator`);
      assert.equal(entry.kind, 'openai_compat');
      assert.ok(entry.provider && entry.provider !== 'unknown' && !entry.provider.includes(':'));
      assert.ok(entry.baseUrl.startsWith('http'));
      assert.ok(entry.apiKeyEnv);
      assert.ok(entry.models.length);
      assert.ok(entry.seats.length);
    }
    assert.equal(persisted.backends.grok.apiKeyEnv, 'CAMUS_TEST_XAI_KEY');
    assert.deepEqual(persisted.backends.grok.auth, { kind: 'env', envVar: 'CAMUS_TEST_XAI_KEY' });
    assert.equal(persisted.backends.qwen.apiKeyEnv, 'CAMUS_NO_AUTH');
    assert.deepEqual(persisted.backends.qwen.auth, { kind: 'none' });
    assert.equal(persisted.backends.qwen.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.doesNotThrow(() => getModels(), 'the complete written file loads through the production reader');

    const serialized = JSON.stringify(persisted);
    assert.ok(!serialized.includes(runtimeUrl), 'resolved tunnel URL is not persisted');
    assert.ok(!serialized.includes('49177'), 'ephemeral tunnel port is not persisted');
    assert.ok(!serialized.includes('resolvedBaseUrl') && !serialized.includes('resolvedPort') && !serialized.includes('localPort'));
  });

  check('dual-write conflicts name both values instead of silently choosing one', () => {
    write(decision());
    const fixture = validXai();
    fixture.backends.grok.baseUrl = 'https://example.com/wrong';
    assert.throws(
      () => updateModels({ connections: fixture.connections, backends: fixture.backends }),
      (error) => /backends\.grok\.baseUrl/.test(error.message) && /connections\.xai\.baseUrl/.test(error.message) && /conflicts/.test(error.message),
    );
    write(decision());
    const authConflict = validXai();
    authConflict.backends.grok.apiKeyEnv = 'DIFFERENT_ENV_NAME';
    assert.throws(
      () => updateModels({ connections: authConflict.connections, backends: authConflict.backends }),
      (error) => /backends\.grok\.apiKeyEnv/.test(error.message) && /backends\.grok\.auth\.envVar/.test(error.message) && /conflicts/.test(error.message),
    );
  });

  check('literal credential fields refuse without echoing their value', () => {
    write(decision());
    const fixture = validXai();
    const planted = ['sk', 'planted', 'value'].join('-');
    fixture.backends.grok.auth.value = planted;
    assert.throws(
      () => updateModels({ connections: fixture.connections, backends: fixture.backends }),
      (error) => /credential values are forbidden/.test(error.message) && !error.message.includes(planted),
    );

    write(decision());
    const urlCredential = validXai();
    const password = ['pass', 'word', 'fixture'].join('-');
    urlCredential.backends.grok.baseUrl = `https://user:${password}@api.x.ai/v1`;
    assert.throws(
      () => updateModels({ connections: urlCredential.connections, backends: urlCredential.backends }),
      (error) => /must not contain credentials/.test(error.message) && !error.message.includes(password),
    );

    write(decision());
    const envCredential = validXai();
    const token = ['bearer', 'fixture', 'value'].join('-');
    envCredential.backends.grok.apiKeyEnv = token;
    assert.throws(
      () => updateModels({ connections: envCredential.connections, backends: envCredential.backends }),
      (error) => /env-var NAME/.test(error.message) && !error.message.includes(token),
    );
  });

  check('tracked public defaults remain byte-identical', () => {
    assert.deepEqual(readFileSync(trackedPath), trackedBefore);
  });
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log(`connections tests: ${passed} passed`);
