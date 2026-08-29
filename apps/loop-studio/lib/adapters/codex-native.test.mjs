import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePolicy } from '../code-native-policy.mjs';
import { runNativeCodex } from './codex-native.mjs';

const threadId = '01900000-0000-7000-8000-000000000001';
const turnId = '01900000-0000-7000-8000-000000000002';
const total = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, totalTokens: 15 };
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-native-protocol-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'candidate'), scratch = join(root, 'scratch'), receiptsDir = join(root, 'state');
  await mkdir(worktree); await mkdir(receiptsDir);
  const policy = await nativePolicy({ worktree, scratch });
  const effective = {};
  for (const [key, value] of Object.entries(policy.config)) {
    const path = key.split('.'); let target = effective;
    for (const segment of path.slice(0, -1)) target = target[segment] ??= {};
    target[path.at(-1)] = structuredClone(value);
  }
  const calls = [], progress = [], sessions = [], connections = [];
  const options = { worktree, scratch, receiptsDir, sourcePath: join(root, 'source'), model: 'fixture-model', effort: 'medium',
    prompt: 'Implement the frozen task.', environment: {}, onNativeProgress: p => { progress.push(p); return overrides.progress?.(p); },
    onNativeSession: s => sessions.push(structuredClone(s)),
    rpcFactory: ({ onNotification }) => {
      let closed;
      const rpc = { closed: new Promise(resolve => { closed = resolve; }), send() {}, fail() { closed(); }, async close() { closed(); },
        emit(method, params) { try { onNotification(method, { threadId, ...params }); } catch { rpc.fail(); } },
        usage(value = total) { rpc.emit('thread/tokenUsage/updated', { turnId, tokenUsage: { total: value, last: value } }); },
        end(status = 'completed') { rpc.emit('turn/completed', { turn: { id: turnId, status } }); },
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'initialize') return {};
          if (method === 'config/read') return { config: overrides.config ? overrides.config(structuredClone(effective), connections.length) : effective };
          if (method === 'command/exec') return { exitCode: 0, stdout: 'camus-native-sandbox-v1' };
          if (method === 'account/read') return overrides.account ?? { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: threadId }, model: overrides.model ?? options.model,
            modelProvider: 'openai', cwd: worktree, approvalPolicy: 'never', activePermissionProfile: { id: 'camus_native' },
            sandbox: { type: 'workspaceWrite', writableRoots: overrides.roots ?? (overrides.explicitCwd ? [worktree, scratch] : [scratch]), networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, instructionSources: [] };
          if (method === 'turn/start') {
            assert.deepEqual(params.outputSchema.required.slice().sort(), Object.keys(params.outputSchema.properties).sort(), 'strict output schemas require every property');
            assert.ok(params.outputSchema.properties.decision.type.includes('null'));
            rpc.emit('turn/started', { turn: { id: turnId } });
            setImmediate(() => {
              if (overrides.turn) overrides.turn(rpc);
              else {
                rpc.usage(overrides.total ?? total);
                rpc.emit('item/started', { turnId, item: { type: 'commandExecution' } });
                rpc.emit('item/completed', { turnId, item: { type: 'agentMessage', text: JSON.stringify({ done: true, summary: 'Ready.', decision: null }) } });
                rpc.end();
              }
            });
            return { turn: { id: turnId } };
          }
          if (method === 'turn/interrupt') { rpc.end('interrupted'); return {}; }
          throw new Error(`Unexpected protocol method: ${method}`);
        } };
      connections.push(rpc); return rpc;
    } };
  return { run: extra => runNativeCodex({ ...options, ...extra }), calls, progress, sessions, options };
}

test('native start validates policy and account before generation and emits narrow session/usage receipts', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.ok, true, result.error); assert.equal(result.definitiveTurnEnd, true);
  assert.equal(result.modelActualEvidence, 'native_thread_configuration');
  assert.equal(result.usage.total_tokens, 15); assert.equal(result.usage.cached_input_tokens, 4);
  assert.equal(f.progress.at(-1).actions, 1);
  assert.ok(f.calls.findIndex(c => c.method === 'account/read') < f.calls.findIndex(c => c.method === 'turn/start'));
  assert.deepEqual(Object.keys(f.sessions.at(-1)).sort(), ['policyHash', 'threadId', 'turnId', 'usageTotal', 'version']);
  assert.deepEqual(JSON.parse(result.text), { actions: [], done: true, summary: 'Ready.', decision: null });
});

test('resumed native thread charges only usage since its durable baseline', async t => {
  const f = await fixture(t, { total: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 10, totalTokens: 30 } });
  const first = await f.run(); assert.equal(first.ok, true);
  const resumed = await f.run({ nativeSession: { ...first.nativeSession, usageTotal: total } });
  assert.equal(resumed.ok, true, resumed.error); assert.equal(resumed.usage.total_tokens, 15);
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
  const changed = await f.run({ nativeSession: { ...first.nativeSession, policyHash: 'changed' } });
  assert.equal(changed.noModelCalled, true); assert.match(changed.error, /policy changed/);
});

test('native thread accepts explicit or implicit cwd, but still requires the exact additional scratch root', async t => {
  const explicit = await fixture(t, { explicitCwd: true });
  assert.equal((await explicit.run()).ok, true);
  const missing = await fixture(t, { roots: [] });
  const result = await missing.run();
  assert.equal(result.noModelCalled, true);
  assert.match(result.error, /frozen execution contract/);
  assert.equal(missing.calls.some(call => call.method === 'turn/start'), false);
});

test('API-key auth, model substitution and inherited policy widening refuse before generation', async t => {
  for (const overrides of [
    { account: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } },
    { model: 'substituted-model' },
    { roots: ['/'] },
    { config: c => { c.permissions.camus_native.filesystem['/'] = 'write'; return c; } },
    { config: c => { c.shell_environment_policy.set.FIXTURE_SECRET = 'must-not-leak'; return c; } },
    { config: (c, connection) => { c.mcp_servers = { unexpected: { enabled: connection === 2 } }; return c; } },
  ]) {
    const f = await fixture(t, overrides); const result = await f.run();
    assert.equal(result.ok, false); assert.equal(result.noModelCalled, true);
    assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
  }
});

test('usage-bound interruption cannot become a ready candidate', async t => {
  const f = await fixture(t, { progress: () => 'Budget reached.', turn: rpc => rpc.usage() });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.stopKind, 'budget'); assert.equal(result.definitiveTurnEnd, true);
  assert.equal(result.usageIncomplete, true); assert.equal(result.usage.total_tokens, 15);
  assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').length, 1);
});

test('cancellation interrupts the exact thread/turn, not a replacement session', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { turn: rpc => { rpc.usage(); controller.abort(); } });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.stopKind, 'cancel'); assert.equal(result.definitiveTurnEnd, true);
  assert.deepEqual(f.calls.find(c => c.method === 'turn/interrupt').params, { threadId, turnId });
});

test('unsupported tools and mid-turn model rerouting are refused', async t => {
  for (const method of ['model/rerouted', 'item/started']) {
    const f = await fixture(t, { turn: rpc => { rpc.usage(); rpc.emit(method, { turnId, item: { type: 'mcpToolCall' } }); } });
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.stopKind, 'refused');
  }
});

test('missing, foreign or malformed usage cannot be claimed as completed accounting', async t => {
  for (const turn of [
    rpc => rpc.end(),
    rpc => { rpc.emit('thread/tokenUsage/updated', { threadId: 'different', turnId, tokenUsage: { total } }); rpc.end(); },
    rpc => rpc.usage({ ...total, totalTokens: -1 }),
  ]) {
    const f = await fixture(t, { turn }); const result = await f.run();
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
  }
});
