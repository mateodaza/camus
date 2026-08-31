import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createGrokAcpTools,
  installHeadlessGuard,
  installGrokSubscriptionAuth,
  preflightGrokSubscriptionTools,
  runNativeGrokSubscription,
  runGrokSubscriptionTurn,
} from './grok-subscription.mjs';

function runCommand(command, args, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `guard exited ${code}`)));
    child.stdin.end(JSON.stringify(event));
  });
}
const runGuard = (script, event) => runCommand(process.execPath, [script], event);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'camus-grok-subscription-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'candidate');
  const scratch = join(root, 'private');
  const receiptsDir = join(root, 'receipts');
  const harness = join(root, 'grok');
  await mkdir(worktree); await mkdir(receiptsDir);
  await writeFile(harness, '#!/bin/sh\n', { mode: 0o700 });
  await chmod(harness, 0o700);
  return { root, worktree, scratch, receiptsDir, harness };
}

function rpcFactoryFor({ authMethods = [{ id: 'cached_token' }], reportedModel = 'grok-4.6' } = {}) {
  const captures = [], requests = [];
  const factory = options => {
    captures.push(options);
    return {
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'initialize') return { protocolVersion: 1, agentInfo: { version: '1.0.13' }, authMethods };
        if (method === 'authenticate') return {};
        if (method === 'session/new') return { sessionId: 'subscription-session' };
        if (method === 'session/prompt') {
          options.onNotification('session/update', { sessionId: 'subscription-session', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: '{"done":true,"summary":"ready","decision":null}' },
          } });
          const receiptModel = reportedModel === 'grok-4.6' ? 'grok-4.6-build' : reportedModel;
          options.onNotification('_x.ai/session/update', { sessionId: 'subscription-session', update: {
            sessionUpdate: 'turn_completed', usage: { inputTokens: 20, cachedReadTokens: 3, outputTokens: 8, totalTokens: 28,
              modelCalls: 1, modelUsage: { [receiptModel]: { modelCalls: 1 } } },
          } });
          return { stopReason: 'end_turn' };
        }
        throw new Error(`unexpected request ${method}`);
      },
      async close() {},
    };
  };
  factory.captures = captures;
  factory.requests = requests;
  return factory;
}

test('subscription turn proves OAuth, exact model and subscription billing without an API gateway', async t => {
  const f = await fixture(t); const rpcFactory = rpcFactoryFor();
  const result = await runGrokSubscriptionTurn({ prompt: 'bounded task', model: 'grok-4.6', effort: 'medium',
    worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir, maxModelCalls: 2, maxToolCalls: 0,
    rpcFactory, resolveHarness: async () => f.harness, assertArtifact: async () => 'a'.repeat(64), installAuth: async () => {} });
  assert.equal(result.ok, true); assert.equal(result.billingAuthority, 'grok_subscription');
  assert.equal(result.authMethod, 'cached_token'); assert.equal(result.modelActual, 'xai:grok-4.6');
  assert.equal(result.modelReported, 'grok-4.6-build');
  assert.deepEqual(result.usage, { input_tokens: 20, cached_input_tokens: 3, output_tokens: 8, total_tokens: 28 });
  const spawn = rpcFactory.captures[0];
  assert.equal(spawn.protocol, 'jsonrpc2');
  assert.equal(spawn.args.includes('--model'), true); assert.equal(spawn.args.includes('grok-4.6'), true);
  assert.equal(spawn.args.includes('--no-auto-update'), true); assert.equal(spawn.args.includes('--no-memory'), true);
  assert.equal(spawn.args.some(value => /api\.x\.ai|XAI_API_KEY/.test(value)), false);
  assert.equal(Object.hasOwn(spawn.env, 'XAI_API_KEY'), false);
  assert.equal(spawn.env.GROK_DISABLE_API_KEY_AUTH, '1');
  const opened = rpcFactory.requests.find(item => item.method === 'session/new')?.params;
  assert.deepEqual(opened?._meta, { yoloMode: true });
  assert.equal(opened?.maxTurns, 2);
  assert.match(await readFile(join(f.scratch, 'grok-home', 'config.toml'), 'utf8'), /permission_mode = "always-approve"/);
});

test('subscription turn refuses API-key-only auth and model substitution before accepting a turn', async t => {
  const f = await fixture(t);
  const common = { prompt: 'bounded task', model: 'grok-4.6', worktree: f.worktree, scratch: f.scratch,
    receiptsDir: f.receiptsDir, maxModelCalls: 1, maxToolCalls: 0,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'b'.repeat(64), installAuth: async () => {} };
  const apiOnly = await runGrokSubscriptionTurn({ ...common, rpcFactory: rpcFactoryFor({ authMethods: [{ id: 'xai.api_key' }] }) });
  assert.equal(apiOnly.ok, false); assert.equal(apiOnly.noModelCalled, true); assert.match(apiOnly.error, /API-key fallback remains refused/);
  const substituted = await runGrokSubscriptionTurn({ ...common, rpcFactory: rpcFactoryFor({ reportedModel: 'grok-other' }) });
  assert.equal(substituted.ok, false); assert.match(substituted.error, /model identity receipt/);
});

test('native subscription maker uses headless hard turn bounds and terminal usage evidence', async t => {
  const f = await fixture(t); let invocation;
  const result = await runNativeGrokSubscription({ prompt: 'bounded native task', model: 'grok-4.6', effort: 'medium',
    worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir, maxModelCalls: 2, maxToolCalls: 1,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'c'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    processRunner: async options => {
      invocation = options;
      const sessionId = options.args[options.args.indexOf('--session-id') + 1];
      options.onFrame({ type: 'tool_call', toolName: 'read_file' });
      options.onFrame({ type: 'text', data: '{"done":true,"summary":"ready","decision":null}' });
      options.onFrame({ type: 'usage' });
      await writeFile(join(options.env.GROK_HOME, 'camus-action-count'), '1', { mode: 0o600 });
      options.onFrame({ type: 'end', stopReason: 'end_turn', sessionId,
        usage: { input_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
          output_tokens: 8, total_tokens: 33 },
        modelUsage: { 'grok-4.6-build': { inputTokens: 20, cacheReadInputTokens: 3, outputTokens: 8, modelCalls: 1 } } });
      return { code: 0 };
    } });
  assert.equal(result.ok, true); assert.equal(result.modelReported, 'grok-4.6-build');
  assert.deepEqual(result.usage, { input_tokens: 20, cached_input_tokens: 3, output_tokens: 8, total_tokens: 33 });
  assert.equal(invocation.args.includes('--max-turns'), true);
  assert.equal(invocation.args[invocation.args.indexOf('--max-turns') + 1], '2');
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], 'Read,Edit,Grep');
  assert.match(invocation.args[invocation.args.indexOf('--disallowed-tools') + 1], /Bash/);
  assert.equal(Object.hasOwn(invocation.env, 'XAI_API_KEY'), false);
  assert.match(await readFile(join(f.scratch, 'grok-home', 'config.toml'), 'utf8'), /hooks\.PreToolUse/);
  assert.match(invocation.args.at(-1), /at most 2 model responses and 1 tool actions/);
  await assert.rejects(() => readFile(join(f.scratch, 'grok-home', 'auth.json')), { code: 'ENOENT' });
});

test('native subscription repair resumes only with tighter remaining bounds', async t => {
  const f = await fixture(t); const invocations = [];
  const common = { model: 'grok-4.6', effort: 'medium', worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'e'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    processRunner: async options => {
      invocations.push(options);
      const sessionFlag = options.args.includes('--resume') ? '--resume' : '--session-id';
      const sessionId = options.args[options.args.indexOf(sessionFlag) + 1];
      options.onFrame({ type: 'text', data: '{"done":true,"summary":"ready","decision":null}' });
      options.onFrame({ type: 'usage' });
      options.onFrame({ type: 'end', stopReason: 'end_turn', sessionId,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        modelUsage: { 'grok-4.6-build': { inputTokens: 10, outputTokens: 5, modelCalls: 1 } } });
      return { code: 0 };
    } };
  const initial = await runNativeGrokSubscription({ ...common, prompt: 'make', maxModelCalls: 3, maxToolCalls: 2 });
  assert.equal(initial.ok, true);
  const repair = await runNativeGrokSubscription({ ...common, prompt: 'repair', nativeSession: initial.nativeSession,
    maxModelCalls: 2, maxToolCalls: 1 });
  assert.equal(repair.ok, true);
  assert.equal(invocations[1].args.includes('--resume'), true);
  assert.equal(invocations[1].args[invocations[1].args.indexOf('--max-turns') + 1], '2');
  assert.equal(await readFile(join(f.scratch, 'grok-home', 'camus-action-limit'), 'utf8'), '1');
  const widened = await runNativeGrokSubscription({ ...common, prompt: 'widen', nativeSession: repair.nativeSession,
    maxModelCalls: 3, maxToolCalls: 1 });
  assert.equal(widened.ok, false); assert.equal(widened.noModelCalled, true);
  assert.match(widened.error, /session policy changed/); assert.equal(invocations.length, 2);
});

test('headless guard accepts Grok target_file and charges refused attempts to the action cap', async t => {
  const f = await fixture(t); const home = join(f.root, 'guard home'); await mkdir(home);
  const guard = await installHeadlessGuard(home, { cwd: f.worktree }, 2);
  assert.deepEqual(await runCommand('/bin/sh', ['-c', guard.command],
    { toolName: 'read_file', toolInput: { target_file: 'package.json' } }), { decision: 'allow' });
  const refused = await runGuard(guard.script, { toolName: 'unsupported', toolInput: { target_file: 'package.json' } });
  assert.equal(refused.decision, 'deny'); assert.match(refused.reason, /unsupported Grok tool/);
  const exhausted = await runGuard(guard.script, { toolName: 'read_file', toolInput: { target_file: 'package.json' } });
  assert.equal(exhausted.decision, 'deny'); assert.match(exhausted.reason, /action limit reached/);
  assert.equal(await readFile(guard.counter, 'utf8'), '3');
});

test('native subscription removes its isolated OAuth copy after a failed process', async t => {
  const f = await fixture(t);
  const result = await runNativeGrokSubscription({ prompt: 'bounded native task', model: 'grok-4.6',
    worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir, maxModelCalls: 1, maxToolCalls: 0,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'd'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    processRunner: async () => ({ code: 1 }) });
  assert.equal(result.ok, false);
  await assert.rejects(() => readFile(join(f.scratch, 'grok-home', 'auth.json')), { code: 'ENOENT' });
});

test('OAuth evidence must be a private regular file and never accepts an empty record', async t => {
  const f = await fixture(t); const source = join(f.root, 'auth.json'); const home = join(f.root, 'home');
  await writeFile(source, '{}\n', { mode: 0o600 });
  await assert.rejects(() => installGrokSubscriptionAuth(home, { source }), /OAuth login is unavailable/);
  await writeFile(source, '{"issuer":{"key":"opaque"}}\n', { mode: 0o644 });
  await chmod(source, 0o644);
  await assert.rejects(() => installGrokSubscriptionAuth(home, { source }), /private regular file/);
});

test('ACP tools refuse traversal, private paths and action-cap overruns', async t => {
  const f = await fixture(t); await mkdir(f.scratch); await writeFile(join(f.worktree, 'safe.txt'), 'safe');
  const tools = createGrokAcpTools({ sessionId: () => 's', worktree: f.worktree, scratch: f.scratch,
    receiptsDir: f.receiptsDir, maxToolCalls: 2, profile: '(version 1)\n(deny default)' });
  await assert.rejects(() => tools.handle('fs/read_text_file', { sessionId: 's', path: '../escape' }), /escapes/);
  await assert.rejects(() => tools.handle('fs/read_text_file', { sessionId: 's', path: '.env' }), /private path/);
  await assert.rejects(() => tools.handle('fs/read_text_file', { sessionId: 's', path: 'safe.txt' }), /budget exhausted/);
  assert.equal(tools.actions, 2, 'refused requests still consume bounded agent actions');
});

test('host-tool preflight consumes bounded streamed evidence and cleans both probes', async t => {
  const f = await fixture(t); await mkdir(f.scratch);
  const sourcePath = join(f.root, 'source'); await mkdir(sourcePath);
  let invocation;
  await preflightGrokSubscriptionTools({
    policy: { cwd: f.worktree, toolHome: f.scratch, toolProfile: '(version 1)\n(deny default)' },
    sourcePath, receiptsDir: f.receiptsDir,
    commandRunner: async options => {
      invocation = options;
      options.onStdout(Buffer.from('camus-grok-subscription-tools-v1\n'));
      options.onStderr(Buffer.from('ignored diagnostic'));
      return { code: 0 };
    },
  });
  assert.equal(invocation.command, '/usr/bin/sandbox-exec');
  assert.equal(invocation.args.includes('-p'), true);
  assert.deepEqual(await readdir(f.receiptsDir), []);
  assert.deepEqual(await readdir(f.worktree), []);
});

test('host-tool preflight fails closed when streamed evidence is absent', async t => {
  const f = await fixture(t); await mkdir(f.scratch);
  const sourcePath = join(f.root, 'source'); await mkdir(sourcePath);
  await assert.rejects(() => preflightGrokSubscriptionTools({
    policy: { cwd: f.worktree, toolHome: f.scratch, toolProfile: '(version 1)\n(deny default)' },
    sourcePath, receiptsDir: f.receiptsDir,
    commandRunner: async () => ({ code: 0 }),
  }), /host-tool isolation preflight failed/);
});
