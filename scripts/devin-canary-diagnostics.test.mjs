import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCanaryPath, createCanaryRequestDiagnostics } from './devin-canary-diagnostics.mjs';
const roots = { mirror: '/fixture/mirror', candidate: '/fixture/candidate' };

test('diagnostics distinguish completed host reads from native tool failure', async () => {
  const log = createCanaryRequestDiagnostics(roots);
  const result = await log.run('fs/read_text_file', { path: 'calc.mjs' }, async stage => {
    stage('file_path'); stage('file_stat'); stage('file_read'); return { content: 'synthetic secret content' };
  });
  assert.equal(result.content, 'synthetic secret content');
  assert.deepEqual(log.records, [{ method: 'fs/read_text_file', stage: 'file_read', outcome: 'completed', pathScope: 'mirror_fixture' }]);
  assert(!JSON.stringify(log.records).includes('secret'));
});

test('host exceptions retain only a stage and allowlisted errno, not secrets or paths', async () => {
  const log = createCanaryRequestDiagnostics(roots);
  const error = Object.assign(new Error('sk-secret at /private/customer/login'), { code: 'EPERM' });
  await assert.rejects(log.run('fs/read_text_file', { path: '/private/customer/sk-secret' }, async stage => {
    stage('file_path'); throw error;
  }), value => value === error);
  assert.deepEqual(log.records, [{ method: 'fs/read_text_file', stage: 'file_path', outcome: 'failed', pathScope: 'outside', errorCode: 'EPERM' }]);
  await assert.rejects(log.run('secret-method', {}, async stage => {
    stage('unsupported'); throw { code: 'sk-private', message: 'sensitive' };
  }));
  assert.equal(log.records[1].method, 'unsupported');
  assert.equal(log.records[1].errorCode, 'unclassified');
  assert(!/sk-|customer|sensitive/.test(JSON.stringify(log.records)));
});

test('path classification covers both roots and caps diagnostics without calling another handler', async () => {
  for (const [path, expected] of [[null, 'missing_or_nonstring'], ['a\0b', 'invalid'],
    ['calc.mjs', 'mirror_fixture'], ['/fixture/candidate/calc.mjs', 'candidate_fixture'],
    ['.env', 'mirror_other'], ['/fixture/candidate/.env', 'candidate_other'],
    ['/fixture/mirror-sibling/calc.mjs', 'outside']]) assert.equal(classifyCanaryPath(path, roots), expected);
  const log = createCanaryRequestDiagnostics({ ...roots, maxRequests: 1 });
  await log.run('terminal/output', {}, async stage => { stage('terminal_operation'); return {}; });
  await assert.rejects(log.run('terminal/output', {}, () => assert.fail('Must not dispatch')));
  assert.equal(log.records.length, 1);
});
