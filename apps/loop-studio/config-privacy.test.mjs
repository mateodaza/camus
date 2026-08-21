// Planted-secret sweep: the read-only config surfaces (/api/config and the
// doctor report) name env vars but NEVER return a value, and never dump the
// process environment. Spawns the real server (mock engine, ephemeral port) so
// the assertion is against the exact bytes a browser would receive.
//
// Values are fragment-assembled (never a secret-shaped literal in this file) and
// a break-on-purpose control proves the sweep can actually catch a leak — a green
// that cannot fail is worthless.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopbackTcpTarget } from './lib/doctor.mjs';

const HOST = '127.0.0.1';
const tmp = mkdtempSync(join(tmpdir(), 'cls-privacy-'));

assert.deepEqual(loopbackTcpTarget('http://[::1]:11434/v1'), { host: '::1', port: 11434 }, 'IPv6 literals are unbracketed for net.connect');
assert.deepEqual(loopbackTcpTarget('https://localhost/v1'), { host: 'localhost', port: 443 }, 'portless HTTPS probes port 443');
assert.deepEqual(loopbackTcpTarget('http://localhost/v1'), { host: 'localhost', port: 80 }, 'portless HTTP probes port 80');

// TCP succeeds but the peer closes without speaking HTTP. This deterministically
// exercises the distinct "port open, /models failed" doctor repair path.
const brokenModelsServer = createTcpServer((socket) => socket.destroy());
await new Promise((resolve, reject) => {
  brokenModelsServer.once('error', reject);
  brokenModelsServer.listen(0, HOST, resolve);
});
const brokenModelsPort = brokenModelsServer.address().port;

// The env-var NAMES are meant to appear (that is the whole feature); only the
// VALUES must never surface. Assemble the values from fragments so no
// secret-shaped literal ever lives in the repo.
const KEY_NAME = 'CLS_PRIVACY_SECRET_KEY';
const DECOY_NAME = 'CLS_PRIVACY_DECOY';
const SECRET = ['sk', 'privacytest', 'DEADBEEFdeadbeef0123456789abcdef', 'DONOTLEAK'].join('-');
const DECOY = ['tok', 'privacytest', 'CAFEBABEcafebabe9876543210fedcba', 'ALSONOLEAK'].join('-');

// A loadable fixture: one keyed openai_compat backend (real env-var NAME) and one
// keyless backend (the CAMUS_NO_AUTH placeholder), each on a declared connection.
// No legacy_http entry, so nothing is refused at load and /api/config returns 200.
const models = {
  maker: { backend: 'claude', model: 'sonnet' },
  reviewer: { backend: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
  loop: { roundCap: 2 },
  connections: {
    hosted: { kind: 'direct_https', baseUrl: 'https://models.privacy.invalid/v1', resolvedBaseUrl: 'http://127.0.0.1:49177/v1', localPort: 49177 },
    local: { kind: 'loopback', port: brokenModelsPort, basePath: '/v1', resolvedPort: 49178 },
    local_down: { kind: 'loopback', port: 9, basePath: '/v1' },
    legacy_lab: { kind: 'legacy_http', baseUrl: 'http://192.168.88.7:11434/v1' },
  },
  backends: {
    keyed_backend: {
      kind: 'openai_compat', provider: 'acme', connection: 'hosted', protocol: 'chat_completions',
      trainingOrg: 'acme', modelFamily: 'acme-family', derivedFrom: null, inferenceOperator: 'acme',
      auth: { kind: 'env', envVar: KEY_NAME }, models: ['acme-large', 'acme-edge'], seats: ['maker', 'reviewer'],
      resolvedBaseUrl: 'http://127.0.0.1:49177/v1', resolvedPort: 49177,
    },
    keyless_backend: {
      kind: 'openai_compat', provider: 'openlab', connection: 'local', protocol: 'chat_completions',
      trainingOrg: 'openlab', modelFamily: 'openlab-family', derivedFrom: null, inferenceOperator: 'openlab',
      auth: { kind: 'none' }, models: ['open-1'], seats: ['maker', 'reviewer'],
    },
  },
};
const modelsFile = join(tmp, 'models.json');
writeFileSync(modelsFile, JSON.stringify(models, null, 2));
// Pin the codex cache so the reviewer catalog is deterministic and offline.
const codexCacheFile = join(tmp, 'codex-cache.json');
writeFileSync(codexCacheFile, JSON.stringify({ models: [
  { slug: 'gpt-5.4', visibility: 'list' },
  { slug: 'gpt-5.4-mini', visibility: 'list' },
] }));
// The first hosted model is registry-covered and the second is not. Doctor must
// inspect the complete declared model list rather than stopping at the first.
const registryFile = join(tmp, 'registry.json');
writeFileSync(registryFile, JSON.stringify({
  endpoints: [{ host: 'models.privacy.invalid', modelIdPattern: '^acme-large$', org: 'acme', family: 'acme-family' }],
  executors: {
    claude_cli: { org: 'anthropic', family: 'claude' },
    codex_cli: { org: 'openai', family: 'gpt' },
  },
  families: { claude: 'anthropic', gpt: 'openai', 'acme-family': 'acme' },
}));

// The sweep, and its break-on-purpose control: it MUST flag a value when one is
// present, or a passing sweep proves nothing.
const leaks = (haystack, needle) => String(haystack).includes(needle);
const assertNoPlantedValues = (surface, planted) => {
  for (const { name, value } of planted) {
    assert.ok(!leaks(surface, value), `${name} value leaked`);
  }
};
assert.ok(SECRET.length > 24 && DECOY.length > 24, 'planted values are substantial');
assert.throws(
  () => assertNoPlantedValues(`prefix ${SECRET} suffix`, [{ name: KEY_NAME, value: SECRET }]),
  /value leaked/,
  'break-on-purpose control: the same sweep fails when a planted value is present',
);
assert.doesNotThrow(
  () => assertNoPlantedValues(`prefix ${DECOY} suffix`, [{ name: KEY_NAME, value: SECRET }]),
  'control: the sweep does not false-positive on an unrelated value',
);

const server = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    ENGINE: 'mock', OPEN: '0', PORT: '0', STUDIO_ALLOWED_ORIGIN: 'https://camus.sh',
    STUDIO_RUNS_DIR: tmp, STUDIO_MODELS_FILE: modelsFile, STUDIO_CODEX_CACHE_FILE: codexCacheFile,
    STUDIO_REGISTRY_FILE: registryFile,
    // The planted key VALUE lives ONLY in the environment (where a real key would),
    // plus a decoy the config never references — a broad env dump would leak it.
    [KEY_NAME]: SECRET, [DECOY_NAME]: DECOY,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
let base = '';
for await (const chunk of server.stdout) {
  const m = String(chunk).match(/http:\/\/localhost:(\d+)/);
  if (m) { base = `http://${HOST}:${m[1]}`; break; }
}
assert.ok(base, 'server announced a port');

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (err) { results.push(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

try {
  // The deep doctor exercises the per-connection probes and the per-backend key
  // presence check — both read the environment; neither may echo a value.
  const configRes = await fetch(`${base}/api/config`);
  const configText = await configRes.text();
  // Deep qualification is an authorized POST now (a GET only runs the shallow,
  // network-free doctor); no Origin is sent from node, so no token is required.
  const doctorRes = await fetch(`${base}/api/doctor`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deep: true }),
  });
  const doctorText = await doctorRes.text();
  const doctor = JSON.parse(doctorText);

  await check('both read-only surfaces answer 200', async () => {
    assert.equal(configRes.status, 200, '/api/config is readable');
    assert.equal(doctorRes.status, 200, '/api/doctor is readable');
  });

  await check('env-var NAMES appear (that is the feature)', async () => {
    assert.ok(leaks(configText, KEY_NAME), '/api/config names the keyed backend env var');
    assert.ok(leaks(configText, 'CAMUS_NO_AUTH'), '/api/config shows the keyless placeholder name');
    assert.ok(leaks(doctorText, KEY_NAME), 'doctor names the keyed backend env var');
    assert.ok(leaks(doctorText, 'CAMUS_NO_AUTH'), 'doctor names the keyless placeholder name');
  });

  await check('the connection vocabulary is exposed by name, not by secret', async () => {
    const config = JSON.parse(configText);
    assert.equal(config.connections?.hosted?.kind, 'direct_https', 'connections carry endpoint kind');
    assert.equal(config.connections?.local?.kind, 'loopback', 'loopback connection is present');
    assert.equal(config.connections?.local_down?.kind, 'loopback', 'a refused loopback connection is present');
    assert.equal(config.connections?.legacy_lab?.kind, 'legacy_http', 'legacy transport stays loudly identified');
    assert.ok(config.seats?.backends?.some((b) => b.name === 'keyed_backend' && b.apiKeyEnv === KEY_NAME),
      'the seat catalog carries the env-var NAME for the keyed backend');
    assert.ok(config.seats?.backends?.some((b) => b.name === 'keyless_backend' && b.apiKeyEnv === 'CAMUS_NO_AUTH'),
      'and the CAMUS_NO_AUTH placeholder for the keyless backend');
  });

  await check('the key VALUE never surfaces on either read-only path', async () => {
    assertNoPlantedValues(configText, [{ name: KEY_NAME, value: SECRET }]);
    assertNoPlantedValues(doctorText, [{ name: KEY_NAME, value: SECRET }]);
  });

  await check('no broad environment dump (an unreferenced value never leaks)', async () => {
    assertNoPlantedValues(configText, [{ name: DECOY_NAME, value: DECOY }]);
    assertNoPlantedValues(doctorText, [{ name: DECOY_NAME, value: DECOY }]);
  });

  await check('config omits runtime state and raw receipt components', async () => {
    for (const forbidden of ['resolvedBaseUrl', 'resolvedPort', 'localPort', 'credentialRevision', 'components', 'probedAt']) {
      assert.ok(!configText.includes(`"${forbidden}"`), `/api/config omits ${forbidden}`);
    }
    const config = JSON.parse(configText);
    for (const template of config.templates ?? []) {
      const text = JSON.stringify(template);
      assert.ok(!text.includes('lineage.source'));
      assert.ok(!text.includes('credentialRevision'));
      assert.ok(!text.includes('resolvedBaseUrl'));
    }
  });

  await check('the SSE run event exposes only safe pairing presentation', async () => {
    const session = await (await fetch(`${base}/api/status`)).json();
    const started = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': session.token },
      body: JSON.stringify({
        goal: 'privacy sweep run for the server authored pairing presentation',
        acceptanceContract: 'The receipt must preserve the selected maker and reviewer without exposing runtime configuration.',
        lane: 'freeform', publish: false,
      }),
    });
    assert.equal(started.status, 201);
    const { id } = await started.json();
    const events = await fetch(`${base}/api/runs/${id}/events`, { headers: { origin: base } });
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    for (let i = 0; i < 10 && !streamed.includes('"type":"run"'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    assert.match(streamed, /"pairingView"/, 'the server-authored safe presentation is present');
    assertNoPlantedValues(streamed, [{ name: KEY_NAME, value: SECRET }, { name: DECOY_NAME, value: DECOY }]);
    for (const forbidden of ['resolvedBaseUrl', 'resolvedPort', 'localPort', 'credentialRevision', 'components']) {
      assert.ok(!streamed.includes(`"${forbidden}"`), `SSE omits ${forbidden}`);
    }
    await fetch(`${base}/api/runs/${id}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-studio-token': session.token },
    });
  });

  await check('doctor checks connections before backends and pins actionable fixes', async () => {
    const checks = doctor.checks ?? [];
    const connectionIndexes = checks.map((check, index) => check.id.startsWith('connection-') ? index : -1).filter((index) => index >= 0);
    const backendIndexes = checks.map((check, index) => check.id.startsWith('backend-') ? index : -1).filter((index) => index >= 0);
    assert.ok(connectionIndexes.length >= 4 && backendIndexes.length >= 2, 'fixture exercises every loopback failure, every connection kind, and both backends');
    assert.ok(Math.max(...connectionIndexes) < Math.min(...backendIndexes), 'all per-connection checks precede every per-backend check');
    const loopback = checks.find((check) => check.id === 'connection-local');
    assert.match(loopback?.detail ?? '', /port open, \/models did not answer/, 'an open TCP peer that fails HTTP is diagnosed separately');
    assert.match(loopback?.fix ?? '', /make .*\/models answer.*connections\.local/i, '/models failure names the endpoint and correct config object');
    const loopbackDown = checks.find((check) => check.id === 'connection-local_down');
    assert.match(loopbackDown?.detail ?? '', /TCP refused/, 'a refused TCP connection retains its own diagnosis');
    assert.match(loopbackDown?.fix ?? '', /start the local server.*connections\.local_down/i, 'TCP refusal names the declared connection object without assuming a .port field');
    const direct = checks.find((check) => check.id === 'connection-hosted');
    assert.match(direct?.detail ?? '', /DNS\/TLS|endpoint/, 'direct HTTPS diagnosis names the network layer it measured');
    assert.match(direct?.fix ?? '', /models\.privacy\.invalid|connections\.hosted\.baseUrl/, 'direct HTTPS failure names its declared host and config path');
    const legacy = checks.find((check) => check.id === 'connection-legacy_lab');
    assert.match(legacy?.fix ?? '', /\(1\) move the service to loopback.*\(2\) front it with an ssh_tunnel.*\(3\) put it behind a real HTTPS endpoint/i, 'legacy_http prints the locked three upgrade paths');
    const registry = checks.find((check) => check.id === 'registry-keyed_backend');
    assert.match(registry?.detail ?? '', /acme-edge.*operator-declared.*checks\/registry\.json/i, 'registry staleness covers the unmatched declared model even when the first model is registry-backed');
    assert.doesNotMatch(registry?.detail ?? '', /models acme-large(?:,| are)/i, 'the registry-backed first model is not mislabeled stale');
    assert.match(registry?.fix ?? '', /add an endpoint row.*checks\/registry\.json/i, 'registry staleness names the exact tracked-config repair');
  });
} finally {
  server.kill('SIGKILL');
  brokenModelsServer.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log('config-privacy.test.mjs');
for (const line of results) console.log(line);
if (process.exitCode) { console.error('\nconfig-privacy tests failed'); }
else console.log(`\n  ${results.length} checks passed`);
