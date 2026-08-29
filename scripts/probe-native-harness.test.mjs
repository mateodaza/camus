import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessProbe, artifactDigest, runProbe, PINS } from './probe-native-harness.mjs';

function fixture(kind = 'qwen') {
  return { kind, artifactDigest: PINS[kind].sha256 ?? PINS[kind].treeSha256,
    code: 0, timedOut: false, completed: true,
    boundary: { credentialVisible: false, gitReadable: false, privateStateReadable: false, networkAllowed: false },
    requests: [{ model: 'camus-probe-model' }],
    frames: [kind === 'qwen' ? { type: 'result', is_error: false, subtype: 'success', structured_result: { done: true } }
      : { type: 'end', stopReason: 'end_turn' }],
  };
}

test('even a passing narrow probe never grants native harness admission', () => {
  for (const kind of ['qwen', 'grok']) {
    const result = assessProbe(fixture(kind));
    assert.equal(result.status, 'probe_passed_not_admitted');
    assert.equal(result.admitted, false);
  }
});

test('normal exit and successful terminal do not hide any failed boundary', () => {
  for (const field of Object.keys(fixture().boundary)) {
    const report = fixture(); report.boundary[field] = true;
    assert.deepEqual(assessProbe(report).blockers, [field]);
    assert.equal(assessProbe(report).status, 'blockers_found');
  }
});

test('missing or nonboolean probe results are inconclusive, never success', () => {
  for (const value of [undefined, null, 'false', 0]) {
    const report = fixture(); report.boundary.credentialVisible = value;
    assert.equal(assessProbe(report).status, 'inconclusive');
  }
  assert.equal(assessProbe({}).status, 'inconclusive');
  assert.equal(assessProbe(null).status, 'inconclusive');
});

test('Grok zero-exit cancelled terminal does not count as completed work', () => {
  const report = fixture('grok'); report.frames[0].stopReason = 'cancelled';
  assert.ok(assessProbe(report).missing.includes('successful_terminal'));
});

test('out-of-selection helper request blocks even when the main model completed', () => {
  const report = fixture('grok'); report.requests.unshift({ path: '/v1/responses', model: 'grok-4.6' });
  assert.deepEqual(assessProbe(report).blockers, ['unselected_model_request']);
});

test('missing, duplicate, malformed and failed terminal streams refuse a pass', () => {
  for (const frames of [[], [null], [fixture().frames[0], fixture().frames[0]], [{ invalidJson: true }],
    [{ ...fixture().frames[0], is_error: true }]]) {
    const report = fixture(); report.frames = frames;
    assert.equal(assessProbe(report).status, 'inconclusive');
  }
});

test('time limits, process errors and wrong artifact pins refuse a pass', () => {
  for (const fields of [{ timedOut: true }, { code: 1 }, { artifactDigest: 'different' }, { completed: false }]) {
    assert.equal(assessProbe({ ...fixture(), ...fields }).status, 'inconclusive');
  }
});

test('an unpinned executable is rejected before it can execute', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-harness-pin-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'grok');
  await writeFile(entry, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.notEqual(await artifactDigest(entry, 'grok'), PINS.grok.sha256);
  await assert.rejects(runProbe('grok', entry), /artifact differs|requires macOS/);
});
