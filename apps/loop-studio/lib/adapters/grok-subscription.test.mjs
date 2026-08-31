import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGrokAcpTools,
  grokSubscriptionPolicy,
  installGrokSubscriptionAuth,
  preflightGrokSubscriptionTools,
  runNativeGrokSubscription,
  runGrokSubscriptionTurn,
} from './grok-subscription.mjs';

const darwinAcpPolicy = options => grokSubscriptionPolicy({ ...options, platform: 'darwin', architecture: 'arm64' });

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

function rpcFactoryFor({ authMethods = [{ id: 'cached_token' }], reportedModel = 'grok-4.6', terminalUsage = true,
  promptError = null } = {}) {
  const captures = [], requests = [];
  const factory = options => {
    captures.push(options);
    return {
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'initialize') return { protocolVersion: 1, agentInfo: { version: '1.0.13' }, authMethods };
        if (method === 'authenticate') return {};
        if (method === 'session/new' || method === 'session/load') return { sessionId: 'subscription-session' };
        if (method === 'session/prompt') {
          if (promptError) throw new Error(promptError);
          options.onNotification('session/update', { sessionId: 'subscription-session', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: '{"done":true,"summary":"ready","decision":null}' },
          } });
          const receiptModel = reportedModel === 'grok-4.6' ? 'grok-4.6-build' : reportedModel;
          if (terminalUsage) options.onNotification('_x.ai/session/update', { sessionId: 'subscription-session', update: {
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
    rpcFactory, resolveHarness: async () => f.harness, assertArtifact: async () => 'a'.repeat(64), installAuth: async () => {},
    createPolicy: darwinAcpPolicy });
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
    resolveHarness: async () => f.harness, assertArtifact: async () => 'b'.repeat(64), installAuth: async () => {},
    createPolicy: darwinAcpPolicy };
  const apiOnly = await runGrokSubscriptionTurn({ ...common, rpcFactory: rpcFactoryFor({ authMethods: [{ id: 'xai.api_key' }] }) });
  assert.equal(apiOnly.ok, false); assert.equal(apiOnly.noModelCalled, true); assert.match(apiOnly.error, /API-key fallback remains refused/);
  const substituted = await runGrokSubscriptionTurn({ ...common, rpcFactory: rpcFactoryFor({ reportedModel: 'grok-other' }) });
  assert.equal(substituted.ok, false); assert.match(substituted.error, /model identity receipt/);
});

test('native subscription maker uses ACP completion, Camus-hosted tools and terminal usage evidence', async t => {
  const f = await fixture(t); const rpcFactory = rpcFactoryFor(); let preflighted = false;
  const result = await runNativeGrokSubscription({ prompt: 'bounded native task', model: 'grok-4.6', effort: 'medium',
    worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir, maxModelCalls: 2, maxToolCalls: 1,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'c'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    createPolicy: darwinAcpPolicy, rpcFactory, sourcePath: f.root,
    preflightTools: async () => { preflighted = true; } });
  assert.equal(result.ok, true); assert.equal(result.modelReported, 'grok-4.6-build');
  assert.deepEqual(result.usage, { input_tokens: 20, cached_input_tokens: 3, output_tokens: 8, total_tokens: 28 });
  const invocation = rpcFactory.captures[0]; assert.equal(invocation.protocol, 'jsonrpc2');
  assert.equal(invocation.args.includes('--max-turns'), true);
  assert.equal(invocation.args[invocation.args.indexOf('--max-turns') + 1], '2');
  assert.equal(typeof invocation.onRequest, 'function'); assert.equal(preflighted, true);
  const initialize = rpcFactory.requests.find(item => item.method === 'initialize');
  assert.deepEqual(initialize.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  assert.equal(Object.hasOwn(invocation.env, 'XAI_API_KEY'), false);
  await assert.rejects(() => readFile(join(f.scratch, 'grok-home', 'auth.json')), { code: 'ENOENT' });
});

test('native subscription repair resumes only with tighter remaining bounds', async t => {
  const f = await fixture(t); const rpcFactory = rpcFactoryFor();
  const common = { model: 'grok-4.6', effort: 'medium', worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'e'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    createPolicy: darwinAcpPolicy, rpcFactory, sourcePath: f.root, preflightTools: async () => {} };
  const initial = await runNativeGrokSubscription({ ...common, prompt: 'make', maxModelCalls: 3, maxToolCalls: 2 });
  assert.equal(initial.ok, true);
  const repair = await runNativeGrokSubscription({ ...common, prompt: 'repair', nativeSession: initial.nativeSession,
    maxModelCalls: 2, maxToolCalls: 1 });
  assert.equal(repair.ok, true);
  assert.equal(rpcFactory.requests.some(item => item.method === 'session/load'), true);
  assert.equal(rpcFactory.captures[1].args[rpcFactory.captures[1].args.indexOf('--max-turns') + 1], '2');
  const widened = await runNativeGrokSubscription({ ...common, prompt: 'widen', nativeSession: repair.nativeSession,
    maxModelCalls: 3, maxToolCalls: 1 });
  assert.equal(widened.ok, false); assert.equal(widened.noModelCalled, true);
  assert.match(widened.error, /session policy changed/); assert.equal(rpcFactory.captures.length, 2);
});

test('native subscription distinguishes a missing ACP completion from a terminal missing its usage receipt', async t => {
  const f = await fixture(t);
  const common = { prompt: 'bounded native task', model: 'grok-4.6',
    worktree: f.worktree, scratch: f.scratch, receiptsDir: f.receiptsDir, maxModelCalls: 1, maxToolCalls: 0,
    resolveHarness: async () => f.harness, assertArtifact: async () => 'd'.repeat(64),
    installAuth: async home => writeFile(join(home, 'auth.json'), '{"opaque":"login"}\n', { mode: 0o600 }),
    createPolicy: darwinAcpPolicy, sourcePath: f.root, preflightTools: async () => {} };
  const missingReceipt = await runNativeGrokSubscription({ ...common, rpcFactory: rpcFactoryFor({ terminalUsage: false }) });
  assert.equal(missingReceipt.ok, false); assert.equal(missingReceipt.uncertain, false);
  assert.equal(missingReceipt.definitiveTurnEnd, true); assert.equal(missingReceipt.failureCode, 'terminal_receipt_missing');
  const missingCompletion = await runNativeGrokSubscription({ ...common, rpcFactory: rpcFactoryFor({ promptError: 'fixture transport closed' }) });
  assert.equal(missingCompletion.ok, false); assert.equal(missingCompletion.uncertain, true);
  assert.equal(missingCompletion.definitiveTurnEnd, false); assert.equal(missingCompletion.failureCode, 'terminal_missing');
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

test('subscription policies refuse an unreviewed platform before execution', async t => {
  const f = await fixture(t);
  const common = { worktree: f.worktree, scratch: f.scratch, harness: f.harness,
    artifactDigest: 'f'.repeat(64), model: 'grok-4.6', platform: 'linux', architecture: 'x64' };
  await assert.rejects(() => grokSubscriptionPolicy(common), /requires macOS arm64/);
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
