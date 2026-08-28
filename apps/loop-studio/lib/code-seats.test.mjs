import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCodeSeats } from './code-seats.mjs';

const run = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

async function fixture(files = { 'src/app.js': 'export const answer = 1;\n' }) {
  const repo = await mkdtemp(join(tmpdir(), 'code-seats-repo-'));
  for (const [path, text] of Object.entries(files)) {
    const target = join(repo, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  run(repo, ['init', '-q']);
  run(repo, ['config', 'user.email', 'test@example.invalid']);
  run(repo, ['config', 'user.name', 'Code Seats Test']);
  run(repo, ['add', '.']);
  run(repo, ['commit', '-qm', 'initial']);
  return repo;
}
function seats({ maker = 'claude-test', reviewer = 'codex-test', makerProvider = 'anthropic', reviewerProvider = 'openai' } = {}) {
  const trainingOrg = (provider) => ({ anthropic: 'anthropic', openai: 'openai', alibaba: 'alibaba' })[provider] ?? provider;
  return {
    seats: {
      maker: { backend: makerProvider === 'anthropic' ? 'claude' : 'http', model: maker, trainingOrg: trainingOrg(makerProvider), lineage: { source: 'test_registry' }, expectedReported: ['maker-pin'] },
      reviewer: { backend: reviewerProvider === 'openai' ? 'codex' : 'http2', model: reviewer, trainingOrg: trainingOrg(reviewerProvider), lineage: { source: 'test_registry' }, expectedReported: ['reviewer-pin'] },
    },
    adapters: {
      makerBackend: { name: 'maker', kind: makerProvider === 'anthropic' ? 'claude_cli' : 'openai_compat', provider: makerProvider, connectionFingerprint: 'conn_maker_12345678' },
      reviewerBackend: { name: 'reviewer', kind: reviewerProvider === 'openai' ? 'codex_cli' : 'openai_compat', provider: reviewerProvider, connectionFingerprint: 'conn_reviewer_12345678' },
    },
  };
}
function cleanReview() {
  return { ran: true, verdict: 'APPROVED', findings: [], questions: [], claimAssessments: [], coverageAssessments: [], thresholdAssessments: [], reviewerIdentity: 'openai:reviewer', usage: { input_tokens: 3 } };
}
async function remove(repo, result) {
  if (result?.candidate?.worktree) {
    try { run(repo, ['worktree', 'remove', '--force', result.candidate.worktree]); } catch { /* retained for failed runs only */ }
  }
  await rm(repo, { recursive: true, force: true });
}

async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test('reversed Claude maker / Codex reviewer changes only an isolated candidate and stays advisory', async () => {
  const repo = await fixture();
  let n = 0;
  let sourceHash = null;
  const { seats: requested, adapters } = seats();
  let adapterScratch = null;
  adapters.maker = async ({ prompt, cwd, expectedReported }) => {
    adapterScratch = cwd;
    assert.deepEqual(expectedReported, ['maker-pin']);
    // Mimics runCodexMaker's final-message artifact. It must stay in private
    // adapter scratch rather than contaminating the candidate diff.
    await writeFile(join(cwd, '.codex-maker-make.md'), 'adapter internal artifact');
    n += 1;
    if (n === 1) return { ok: true, text: '{"actions":[{"type":"list"}],"done":false}', modelActual: 'anthropic:claude-test', usage: { input_tokens: 1 } };
    if (n === 2) return { ok: true, text: '{"actions":[{"type":"read","path":"src/app.js"}],"done":false}' };
    if (n === 3) {
      const history = JSON.parse(prompt.match(/Complete host action history \(do not assume omitted state\):\n(\[.*\])$/s)[1]);
      assert.equal(history[0].actions[0].type, 'list', 'later model turn retains the original list observation');
      sourceHash = history[1].actions[0].sha256;
      return { ok: true, text: JSON.stringify({ actions: [{ type: 'write', path: 'src/app.js', expected_sha256: sourceHash, content: 'export const answer = 2;\n' }], done: false }) };
    }
    return { ok: true, text: '{"actions":[],"done":true,"summary":"implemented"}' };
  };
  adapters.reviewer = async ({ prompt, cwd, expectedReported }) => {
    assert.equal(cwd, adapterScratch, 'reviewer shares private adapter scratch, never candidate cwd');
    assert.deepEqual(expectedReported, ['reviewer-pin']);
    assert.match(prompt, /export const answer = 2/);
    assert.match(prompt, /--- src\/app.js ---/);
    return cleanReview();
  };
  const events = [];
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'change answer', seats: requested, adapters, onEvent: (e) => events.push(e) });
    assert.equal(result.status, 'needs_decision');
    assert.equal(result.advisory, true);
    assert.equal(result.independence.independent, true);
    assert.equal(result.candidate.branch.startsWith('codex/code-seats-'), true);
    assert.equal(await readFile(join(repo, 'src/app.js'), 'utf8'), 'export const answer = 1;\n');
    assert.equal(await readFile(join(result.candidate.worktree, 'src/app.js'), 'utf8'), 'export const answer = 2;\n');
    assert.notEqual(adapterScratch, result.candidate.worktree);
    await assert.rejects(readFile(join(result.candidate.worktree, '.codex-maker-make.md'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(adapterScratch, '.codex-maker-make.md'), 'utf8'), 'adapter internal artifact');
    assert.equal(result.candidate.fingerprint.length, 64);
    assert.equal(result.seats.maker.observed.turns[0].usage.input_tokens, 1);
    assert.equal(events.some((e) => e.stage === 'review' && e.actor === 'reviewer'), true);
  } finally { await remove(repo, result); }
});

await test('HTTP maker/reviewer combination and same-origin reviewers remain non-independent advisory evidence', async () => {
  const repo = await fixture();
  const { seats: requested, adapters } = seats({ maker: 'qwen-coder', reviewer: 'qwen-review', makerProvider: 'alibaba', reviewerProvider: 'alibaba' });
  let n = 0;
  adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"hello\\n"}],"done":false}', modelActual: 'alibaba:qwen-coder' });
  adapters.reviewer = async () => cleanReview();
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'add a file', seats: requested, adapters });
    assert.equal(result.status, 'needs_decision');
    assert.equal(result.independence.independent, false);
    assert.equal(result.independence.reason, 'same_training_origin');
    assert.match(result.candidate.diff, /new.txt/);
  } finally { await remove(repo, result); }
});

for (const [name, action, setup] of [
  ['traversal', { type: 'read', path: '../outside' }, null],
  ['private Camus state', { type: 'read', path: '.camus/token' }, null],
  ['private adapter directory', { type: 'read', path: '.codex/config.toml' }, null],
  ['environment production file', { type: 'write', path: '.env.production', expected_sha256: null, content: 'x' }, null],
  ['tracked npm credentials file', { type: 'read', path: '.npmrc' }, async (repo) => { await writeFile(join(repo, '.npmrc'), 'registry=https://example.invalid\n'); run(repo, ['add', '.npmrc']); run(repo, ['commit', '-qm', 'npmrc']); }],
  ['private key file', { type: 'read', path: 'id_ed25519' }, async (repo) => { await writeFile(join(repo, 'id_ed25519'), 'not a real key\n'); run(repo, ['add', 'id_ed25519']); run(repo, ['commit', '-qm', 'key']); }],
  ['credential path', { type: 'write', path: 'credentials.txt', expected_sha256: null, content: 'x' }, null],
  ['symlink', { type: 'read', path: 'src/link' }, async (repo) => { await symlink('/etc/hosts', join(repo, 'src/link')); run(repo, ['add', 'src/link']); run(repo, ['commit', '-qm', 'link']); }],
]) {
  await test(`${name} access is refused fail-closed`, async () => {
    const repo = await fixture();
    if (setup) await setup(repo);
    const { seats: requested, adapters } = seats();
    adapters.maker = async () => ({ ok: true, text: JSON.stringify({ actions: [action], done: false }) });
    adapters.reviewer = async () => cleanReview();
    try {
      const result = await runCodeSeats({ repoPath: repo, task: 'inspect', seats: requested, adapters });
      assert.equal(result.status, 'infra_error');
      assert.match(result.error, /refused|unsafe|limited/i);
    } finally { await remove(repo); }
  });
}

await test('recognized credential-shaped tracked content is refused without echoing it', async () => {
  const repo = await fixture({ 'src/config.js': 'api_key=super-private-value\n' });
  const pair = seats();
  pair.adapters.maker = async () => ({ ok: true, text: '{"actions":[{"type":"read","path":"src/config.js"}],"done":false}' });
  pair.adapters.reviewer = async () => cleanReview();
  try {
    const result = await runCodeSeats({ repoPath: repo, task: 'inspect', seats: pair.seats, adapters: pair.adapters });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /credential-shaped/);
    assert.doesNotMatch(result.error, /super-private-value/);
  } finally { await remove(repo); }
});

await test('ignored new files and later ignore-rule mutations are refused before review', async () => {
  const repo = await fixture({ '.gitignore': 'ignored.txt\n', 'src/app.js': 'export {};\n' });
  const pair = seats(); pair.adapters.maker = async () => ({ ok: true, text: '{"actions":[{"type":"write","path":"ignored.txt","expected_sha256":null,"content":"x"}],"done":false}' }); pair.adapters.reviewer = async () => cleanReview();
  try {
    const result = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters });
    assert.equal(result.status, 'infra_error'); assert.match(result.error, /git-ignored/);
  } finally { await remove(repo); }
  const repo2 = await fixture({ '.gitignore': '', 'src/app.js': 'export {};\n' });
  const next = seats(); let turn = 0;
  next.adapters.maker = async () => ({ ok: true, text: turn++ ? JSON.stringify({ actions: [{ type: 'write', path: '.gitignore', expected_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', content: 'new.txt\n' }], done: false }) : JSON.stringify({ actions: [{ type: 'write', path: 'new.txt', expected_sha256: null, content: 'x' }], done: false }) }); next.adapters.reviewer = async () => cleanReview();
  try {
    const result = await runCodeSeats({ repoPath: repo2, task: 'x', seats: next.seats, adapters: next.adapters });
    assert.equal(result.status, 'infra_error'); assert.match(result.error, /became git-ignored/);
  } finally { await remove(repo2); }
});

await test('stale edit, malformed output, empty output, and provider error never become clean', async () => {
  for (const output of [
    '{"actions":[{"type":"write","path":"src/app.js","expected_sha256":"0000000000000000000000000000000000000000000000000000000000000000","content":"bad"}],"done":false}',
    'not json',
    '',
  ]) {
    const repo = await fixture();
    const { seats: requested, adapters } = seats();
    adapters.maker = async () => ({ ok: true, text: output });
    adapters.reviewer = async () => cleanReview();
    try { assert.equal((await runCodeSeats({ repoPath: repo, task: 'x', seats: requested, adapters })).status, 'infra_error'); }
    finally { await remove(repo); }
  }
  const repo = await fixture();
  const { seats: requested, adapters } = seats();
  adapters.maker = async () => ({ ok: false, error: 'synthetic provider outage' });
  adapters.reviewer = async () => cleanReview();
  try { assert.equal((await runCodeSeats({ repoPath: repo, task: 'x', seats: requested, adapters })).status, 'infra_error'); }
  finally { await remove(repo); }
});

await test('abort and step cap stop spending without blind retry', async () => {
  const repo = await fixture();
  const { seats: requested, adapters } = seats();
  let calls = 0;
  adapters.maker = async () => { calls += 1; return { ok: true, text: '{"actions":[{"type":"list"}],"done":false}' }; };
  adapters.reviewer = async () => cleanReview();
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: requested, adapters, limits: { maxSteps: 2 } });
    assert.equal(result.status, 'needs_decision');
    assert.equal(calls, 2);
  } finally { await remove(repo, result); }
  const repo2 = await fixture();
  const controller = new AbortController();
  const pair = seats();
  pair.adapters.maker = async ({ signal }) => { controller.abort(); return { ok: true, text: '{"actions":[],"done":true}' }; };
  pair.adapters.reviewer = async () => cleanReview();
  try {
    const stopped = await runCodeSeats({ repoPath: repo2, task: 'x', seats: pair.seats, adapters: pair.adapters, signal: controller.signal });
    assert.equal(stopped.status, 'stopped');
  } finally { await remove(repo2); }
});

await test('context caps never silently truncate and a verifier cannot alter reviewed evidence', async () => {
  const repo = await fixture({ 'src/large.js': 'x'.repeat(300) });
  const pair = seats();
  pair.adapters.maker = async () => ({ ok: true, text: '{"actions":[{"type":"read","path":"src/large.js"}],"done":false}' });
  pair.adapters.reviewer = async () => cleanReview();
  try {
    const capped = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters, limits: { maxFileBytes: 100 } });
    assert.equal(capped.status, 'infra_error');
    assert.match(capped.error, /did not truncate/);
  } finally { await remove(repo); }
  const repo2 = await fixture();
  const pair2 = seats(); let n = 0;
  pair2.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
  pair2.adapters.reviewer = async () => cleanReview();
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo2, task: 'x', seats: pair2.seats, adapters: pair2.adapters, verify: async ({ worktree }) => { await writeFile(join(worktree, 'new.txt'), 'changed'); return { ran: true, pass: true }; } });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /verifier changed/);
  } finally { await remove(repo2, result); }
});

await test('explicit verification failure is terminal and clean review never auto-lands', async () => {
  const repo = await fixture();
  const pair = seats(); let n = 0;
  pair.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
  pair.adapters.reviewer = async () => { throw new Error('must not review failing verifier'); };
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters, verify: async () => ({ ran: true, pass: false, error: 'test failed' }) });
    assert.equal(result.status, 'verify_failed');
    assert.equal(result.review, null);
    assert.equal(run(repo, ['status', '--porcelain']), '');
  } finally { await remove(repo, result); }
});

await test('inconclusive verification and verifier abort fail closed without buying review', async () => {
  const makeCandidate = () => {
    const pair = seats(); let n = 0;
    pair.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
    pair.adapters.reviewer = async () => { throw new Error('review must not run after inconclusive verification'); };
    return pair;
  };
  const repo = await fixture();
  const first = makeCandidate(); let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: first.seats, adapters: first.adapters, verify: async () => ({ ran: true, pass: null, error: 'no conclusive result' }) });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /inconclusive/);
  } finally { await remove(repo, result); }
  const repo2 = await fixture();
  const controller = new AbortController();
  const second = makeCandidate();
  try {
    const stopped = await runCodeSeats({ repoPath: repo2, task: 'x', seats: second.seats, adapters: second.adapters, signal: controller.signal, verify: async () => { controller.abort(); return { ran: false, pass: null, error: 'verification aborted' }; } });
    assert.equal(stopped.status, 'stopped');
  } finally { await remove(repo2); }
});

await test('an empty or malformed reviewer verdict is infrastructure evidence, never advisory clean', async () => {
  const repo = await fixture();
  const pair = seats(); let n = 0;
  pair.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
  // Production adapters reach this shape only after normalizeReview rejects an
  // empty/unparseable response. The engine must preserve that refusal.
  pair.adapters.reviewer = async () => ({ ran: false, verdict: 'ERROR', error: 'empty reviewer output', findings: [] });
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /reviewer failed/);
    assert.match(result.candidate.diff, /new.txt/);
  } finally { await remove(repo, result); }
});

await test('a reviewer invalid verdict or abort cannot become a clean advisory result', async () => {
  const makeCandidate = () => {
    const pair = seats(); let n = 0;
    pair.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
    return pair;
  };
  const repo = await fixture();
  const invalid = makeCandidate(); invalid.adapters.reviewer = async () => ({ ran: true, verdict: 'clean', findings: [] });
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: invalid.seats, adapters: invalid.adapters });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /reviewer failed/);
  } finally { await remove(repo, result); }
  const repo2 = await fixture();
  const controller = new AbortController();
  const aborted = makeCandidate(); aborted.adapters.reviewer = async () => { controller.abort(); return cleanReview(); };
  try {
    const stopped = await runCodeSeats({ repoPath: repo2, task: 'x', seats: aborted.seats, adapters: aborted.adapters, signal: controller.signal });
    assert.equal(stopped.status, 'stopped');
  } finally { await remove(repo2); }
});

await test('a candidate changed during review invalidates the otherwise clean verdict', async () => {
  const repo = await fixture();
  const pair = seats(); let n = 0;
  pair.adapters.maker = async () => ({ ok: true, text: n++ ? '{"actions":[],"done":true}' : '{"actions":[{"type":"write","path":"new.txt","expected_sha256":null,"content":"a"}],"done":false}' });
  pair.adapters.reviewer = async () => {
    const block = run(repo, ['worktree', 'list', '--porcelain']).split('\n\n').find((item) => item.includes('branch refs/heads/codex/code-seats-'));
    const candidate = block.match(/^worktree (.+)$/m)[1];
    await writeFile(join(candidate, 'new.txt'), 'external mutation');
    return cleanReview();
  };
  let result;
  try {
    result = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, /changed while reviewer/);
  } finally { await remove(repo, result); }
});

await test('a pre-aborted run creates no candidate worktree', async () => {
  const repo = await fixture();
  const pair = seats(); const controller = new AbortController(); controller.abort();
  pair.adapters.maker = async () => { throw new Error('must not call maker'); };
  pair.adapters.reviewer = async () => cleanReview();
  try {
    const result = await runCodeSeats({ repoPath: repo, task: 'x', seats: pair.seats, adapters: pair.adapters, signal: controller.signal });
    assert.equal(result.status, 'stopped');
    assert.equal(run(repo, ['worktree', 'list']).split('\n').length, 1);
  } finally { await remove(repo); }
});
