import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CODE_EVAL_FIXTURE_PROTOCOL, DEFAULT_CODE_EVAL_FIXTURE, codeEvalFixtureReadiness,
  loadCodeEvalFixture, validateCodeEvalFixtureManifest } from './code-eval-fixture.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
async function mutableFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'camus-code-eval-fixture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'fixture'); await cp(DEFAULT_CODE_EVAL_FIXTURE, copy, { recursive: true }); return copy;
}
async function rewriteManifest(root, mutate) {
  const path = join(root, 'fixture.json'), value = JSON.parse(await readFile(path, 'utf8')); mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('tracked v1a fixture is content-bound, base-red/reference-green and spend-free', async () => {
  const fixture = await loadCodeEvalFixture();
  assert.equal(fixture.manifest.fixtureProtocol, CODE_EVAL_FIXTURE_PROTOCOL);
  assert.equal(fixture.manifest.safeForExternalModels, true);
  assert.deepEqual(fixture.baseFiles.map(file => file.path), ['package.json', 'src/bounded-parser.mjs', 'test/bounded-parser.test.mjs']);
  assert.deepEqual(fixture.referenceFiles.map(file => file.path), ['src/bounded-parser.mjs']);
  const readiness = await codeEvalFixtureReadiness();
  assert.equal(readiness.ready, true); assert.equal(readiness.base, 'red'); assert.equal(readiness.reference, 'green');
  assert.equal(readiness.providerCallsMade, 0); assert.match(readiness.fixtureId, /^fixture1:[a-f0-9]{64}$/);
  assert.equal(readiness.fixtureId, 'fixture1:b9c45077a39e7a30e929af24d9e5ab2cd4732a68bb6245f8b542bc37715f1de6');
  assert.match(readiness.verifierDigest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(readiness), /camus-code-eval-fixture-|bounded-parser\.mjs|AssertionError|operator/);
});

test('fixture validator refuses unsafe argv, unknown fields and content drift', async t => {
  const fixture = await loadCodeEvalFixture();
  assert.throws(() => validateCodeEvalFixtureManifest({ ...fixture.manifest, surprise: true }), /unsupported or missing fields/);
  assert.throws(() => validateCodeEvalFixtureManifest({ ...fixture.manifest, verifier: { ...fixture.manifest.verifier, argv: ['-e', 'fetch("https://invalid")'] } }), /bounded, network-denied/);
  const root = await mutableFixture(t);
  await rewriteManifest(root, value => { value.baseFiles.find(file => file.path === 'src/bounded-parser.mjs').content = 'export const changed = true;\n'; });
  await assert.rejects(loadCodeEvalFixture(root), /content digest mismatch/);
});

test('reviewed fixture cannot be rehashed into network or credential content', async t => {
  const root = await mutableFixture(t), network = 'export async function changed(){ return fetch("https://example.invalid"); }\n';
  await rewriteManifest(root, value => { const file = value.baseFiles.find(item => item.path === 'src/bounded-parser.mjs'); file.content = network; file.sha256 = sha256(network); });
  await assert.rejects(loadCodeEvalFixture(root), /network-using/);

  const credentialRoot = await mutableFixture(t), credential = 'api_key = "fixture-secret"\n';
  await rewriteManifest(credentialRoot, value => { const file = value.baseFiles.find(item => item.path === 'src/bounded-parser.mjs'); file.content = credential; file.sha256 = sha256(credential); });
  await assert.rejects(loadCodeEvalFixture(credentialRoot), /credential-shaped/);
});

test('undeclared files and symbolic links refuse before verification', async t => {
  const extraRoot = await mutableFixture(t); await writeFile(join(extraRoot, 'extra.mjs'), 'export {};\n');
  await assert.rejects(loadCodeEvalFixture(extraRoot), /only its regular content-bound fixture\.json/);
  const linkRoot = await mutableFixture(t), fixturePath = join(linkRoot, 'fixture.json'); await rm(fixturePath);
  await symlink(join(DEFAULT_CODE_EVAL_FIXTURE, 'fixture.json'), fixturePath);
  await assert.rejects(loadCodeEvalFixture(linkRoot), /only its regular content-bound fixture\.json/);
});

test('readiness distinguishes a repaired base and a broken reference without exposing output', async t => {
  const repaired = await mutableFixture(t);
  await rewriteManifest(repaired, value => { const base = value.baseFiles.find(file => file.path === 'src/bounded-parser.mjs');
    const reference = value.referenceFiles[0]; base.content = reference.content; base.sha256 = reference.sha256; });
  await assert.rejects(codeEvalFixtureReadiness(repaired), /targeted red behavior/);

  const broken = await mutableFixture(t);
  await rewriteManifest(broken, value => { const base = value.baseFiles.find(file => file.path === 'src/bounded-parser.mjs');
    value.referenceFiles[0].content = base.content; value.referenceFiles[0].sha256 = base.sha256; });
  await assert.rejects(codeEvalFixtureReadiness(broken), /declared green behavior/);
});
