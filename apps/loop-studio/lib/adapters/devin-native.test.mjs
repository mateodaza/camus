import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runNativeDevin } from './devin-native.mjs';
import { devinIsolatedEnvironment } from '../devin-native-preflight.mjs';

async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-adapter-test-')));
  const candidate = join(root, 'candidate'), auth = join(root, 'auth'), receipts = join(root, 'receipts');
  await mkdir(candidate, { mode: 0o700 }); await mkdir(auth, { mode: 0o700 }); await mkdir(receipts, { mode: 0o700 });
  await writeFile(join(candidate, 'calc.mjs'), 'export const add=(a,b)=>a-b;');
  let brokerDefinition, sourceMirror, releaseCalled = false, prompts = 0;
  const env = devinIsolatedEnvironment(auth);
  const context = { root: auth, env, harness: await realpath(process.execPath), config: join(auth, 'config.json'),
    digest: 'offline-fixture', configureMcp: async value => { brokerDefinition = value; },
    release: async ({ writerStopped }) => { assert(writerStopped); releaseCalled = true; } };
  const defaults = { model: 'swe-2-high', backend: { name: 'devin', kind: 'devin_cli' }, prompt: 'Fix addition and return the agreed JSON.',
    worktree: candidate, receiptsDir: receipts, sourceFiles: ['calc.mjs'],
    observedBudget: { version: 'devin-observed/v1', maxPrompts: 1, maxObservedTools: 20, maxWallMs: 10000, billingUncertaintyAccepted: true } };
  let rpcId = 0;
  const mcp = async (method, params) => {
    const response = await fetch(brokerDefinition.url, { method: 'POST', headers: { authorization: brokerDefinition.headers[0].value },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    return response.json();
  };
  const dependencies = prompt => ({ prepareContext: async () => context,
    rpcFactory(callbacks) {
      const update = value => callbacks.onNotification('session/update', { sessionId: 'fixture-s1', update: value });
      return { fail() {}, async close() {}, async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'devin-browser' }] };
        if (method === 'session/new') { sourceMirror = params.cwd; return { sessionId: 'fixture-s1',
          configOptions: [{ category: 'model', currentValue: 'swe-2-high' }], modes: { currentModeId: 'autonomous' } }; }
        if (method === 'session/prompt') {
          prompts++;
          assert((await readdir(receipts)).some(name => name.startsWith('devin-dispatch-')));
          await mcp('initialize', { protocolVersion: '2025-03-26' }); await mcp('tools/list', {});
          return prompt({ update, callbacks, mcp, sourceMirror });
        }
        throw new Error('Unexpected RPC.');
      } };
    } });
  try { await fn({ defaults, dependencies, candidate, receipts, state: () => ({ prompts, releaseCalled, sourceMirror }) }); }
  finally {
    if (sourceMirror) await rm(sourceMirror, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test('composed adapter checks MCP writes, completes, adopts into isolated candidate and preserves unknown usage',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const actions = [];
    ctx.defaults.onNativeProgress = value => { actions.push(value.actions); };
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, mcp }) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect the source.' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'read', status: 'pending', kind: 'read' });
      const read = await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      const file = JSON.parse(read.result.content[0].text);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Now I will fix it.' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'write', status: 'pending', kind: 'edit' });
      const written = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs',
        content: 'export const add=(a,b)=>a+b;', expectedSha256: file.sha256 } });
      assert.equal(written.result.isError, false);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Fixed.","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(result.definitiveTurnEnd, true);
    assert.equal(result.usage, null); assert.equal(result.usageIncomplete, true); assert.equal(result.modelActual, null);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a+b;');
    assert.equal(ctx.state().prompts, 1); assert.equal(ctx.state().releaseCalled, true);
    assert.equal(actions.at(-1), 4, 'native events and host executions conservatively share the action allowance');
    assert((await readdir(ctx.receipts)).some(name => name.startsWith('devin-result-')));
  }));

test('invalid final decision preserves staging without adopting or replaying',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, sourceMirror }) => {
      await writeFile(join(sourceMirror, 'calc.mjs'), 'untrusted draft');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Done","decision":{"action":"publish","reason":"go"}}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal(result.candidateQuiescent, false);
    assert.equal(result.diagnostic.stage, 'decision_authority');
    const terminalName = (await readdir(ctx.receipts)).find(name => name.startsWith('devin-terminal-'));
    const terminal = JSON.parse(await readFile(join(ctx.receipts, terminalName), 'utf8'));
    assert.equal(terminal.execution, 'completed');
    assert.equal(terminal.candidateAdopted, false);
    assert.match(terminal.text, /publish/);
    assert.ok(!JSON.stringify(result.diagnostic).includes('publish'), 'public diagnostic exposes only fixed labels');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    assert.equal(await readFile(join(ctx.state().sourceMirror, 'calc.mjs'), 'utf8'), 'untrusted draft');
    assert.equal(ctx.state().prompts, 1); assert.equal(ctx.state().releaseCalled, true);
  }));

test('native edit permission and MCP commands use separate credential-free authority',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, callbacks, mcp, sourceMirror }) => {
      const tool = { toolCallId: 'edit', kind: 'edit', rawInput: { file_path: join(sourceMirror, 'calc.mjs'),
        old_string: 'a-b', new_string: 'a+b' }, _meta: { 'cognition.ai/inferenceToolName': 'edit' } };
      update({ sessionUpdate: 'tool_call', ...tool });
      const permission = await callbacks.onRequest('session/request_permission', { sessionId: 'fixture-s1', toolCall: tool,
        options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' }] });
      assert.equal(permission.outcome.optionId, 'once');
      await writeFile(join(sourceMirror, 'calc.mjs'), 'export const add=(a,b)=>a+b;');
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'command', kind: 'execute', status: 'pending' });
      const script = `const f=require('node:fs'),a=require('node:assert/strict'),net=require('node:net');
const denied=e=>['EPERM','EACCES'].includes(e.code);
a.throws(()=>f.writeFileSync('calc.mjs','tamper'),denied);
a.throws(()=>f.readFileSync(${JSON.stringify(join(ctx.candidate, 'calc.mjs'))}),denied);
a.equal(process.env.XAI_API_KEY,undefined);a.equal(process.env.ANTHROPIC_API_KEY,undefined);
f.writeFileSync(process.env.TMPDIR+'/synthetic-cache','allowed');
const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(2));s.on('error',e=>{a(denied(e));console.log('command-isolated');});`;
      const command = await mcp('tools/call', { name: 'run_command', arguments: { command: '/opt/homebrew/bin/node', args: ['-e', script] } });
      assert.equal(command.result.isError, false);
      const output = JSON.parse(command.result.content[0].text); assert.equal(output.exitCode, 0); assert.match(output.stdout, /command-isolated/);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked.","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(ctx.state().prompts, 1);
  }));

test('ordinary token budget, wrong backend and native replay cannot start Devin', async () => {
  let starts = 0; const dependencies = { prepareContext: async () => { starts++; throw new Error('must not run'); } };
  const base = { model: 'swe-2-high', backend: { name: 'devin', kind: 'devin_cli' }, remainingTokens: 100000 };
  await assert.rejects(runNativeDevin(base, dependencies), /observed-only/);
  assert.equal((await runNativeDevin({ ...base, backend: { name: 'xai', kind: 'openai_compat' } }, dependencies)).noModelCalled, true);
  assert.equal((await runNativeDevin({ ...base, nativeSession: {} }, dependencies)).noModelCalled, true);
  assert.equal(starts, 0);
});

test('host MCP calls consume allowance even without ACP tool notifications',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    ctx.defaults.observedBudget.maxObservedTools = 1;
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, mcp }) => {
      const read = await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      const file = JSON.parse(read.result.content[0].text);
      const write = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs', content: 'not authorized', expectedSha256: file.sha256 } });
      assert(write.error || write.result?.isError);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Done.","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));

test('incomplete outcomes persist private evidence and distinct sanitized reasons without adoption',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, async () => {
    for (const [reason, prompt] of [
      ['tool_failed', async ({ update }) => { update({ sessionUpdate: 'tool_call', toolCallId: 'bad', status: 'failed',
        _meta: { 'cognition.ai/inferenceToolName': 'read' }, rawOutput: 'ENOENT synthetic-secret' }); return { stopReason: 'end_turn' }; }],
      ['incomplete_terminal', async () => ({ stopReason: 'cancelled' })],
      ['native_turn_failed', async () => { throw new Error('synthetic-secret'); }],
      ['protocol_refused', async ({ callbacks }) => { callbacks.onNotification('session/update', { sessionId: 'wrong', update: {} }); return { stopReason: 'end_turn' }; }],
      ['tool_boundary_refused', async ({ mcp }) => { await mcp('tools/call', { name: 'read_file', arguments: { path: '.env' } }); return { stopReason: 'end_turn' }; }],
    ]) await fixture(async ctx => {
      const result = await runNativeDevin(ctx.defaults, ctx.dependencies(prompt));
      assert.equal(result.failureCode, 'devin_native_incomplete');
      assert.equal(result.diagnostic.reason, reason); assert.equal(result.diagnostic.cleanupConfirmed, true);
      assert.equal(result.candidateQuiescent, false); assert.equal(result.stagedDraft.replayAllowed, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
      const names = await readdir(ctx.receipts);
      const file = names.find(name => name.startsWith('devin-terminal-'));
      assert(file); assert(!names.some(name => name.startsWith('devin-result-')));
      const evidence = JSON.parse(await readFile(join(ctx.receipts, file), 'utf8'));
      assert.equal(evidence.execution, 'uncertain'); assert.equal(evidence.candidateAdopted, false);
      assert.equal((await stat(join(ctx.receipts, file))).mode & 0o777, 0o600);
      assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
      if (reason === 'tool_failed') assert.deepEqual(result.diagnostic.toolFailures,
        [{ nativeTool: 'read', categories: ['path_unavailable'] }]);
    });
  });

test('host-owned no-write feedback allows bounded correction and lists new files',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, mcp }) => {
      const call = async (name, args) => {
        const response = await mcp('tools/call', { name, arguments: args });
        assert.equal(response.result.isError, false); return JSON.parse(response.result.content[0].text);
      };
      const listed = await call('list_files', { offset: 0 });
      assert.deepEqual(listed.files, [{ path: 'calc.mjs', writable: true }]); assert.equal(listed.nextOffset, null);
      const absent = await call('read_file', { path: 'guessed.mjs' });
      assert.equal(absent.operationCompleted, false); assert.equal(absent.code, 'file_not_prepared');
      const stale = await call('write_file', { path: 'calc.mjs', content: 'wrong', expectedSha256: 'old' });
      assert.equal(stale.operationCompleted, false); assert.equal(stale.code, 'stale_file');
      const read = await call('read_file', { path: 'calc.mjs' }); assert.match(read.content, /a-b/);
      await call('write_file', { path: 'calc.mjs', content: 'export const add=(a,b)=>a+b;', expectedSha256: read.sha256 });
      await call('write_file', { path: 'new.mjs', content: 'new-search-marker', expectedSha256: null });
      assert((await call('list_files', { offset: 0 })).files.some(item => item.path === 'new.mjs'));
      assert((await call('search', { query: 'new-search-marker' })).matches.some(item => item.path === 'new.mjs'));
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Corrected with host feedback.","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(ctx.state().prompts, 1);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a+b;');
  }));

test('terminal storage collisions and unproven cleanup never authorize adoption',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, async () => {
    for (const failure of ['storage', 'cleanup']) await fixture(async ctx => {
      const path = join(ctx.receipts, `devin-terminal-${createHash('sha256').update('fixture-s1').digest('hex')}.json`);
      if (failure === 'storage') await writeFile(path, 'preserve-existing-evidence', { mode: 0o600 });
      const dependencies = ctx.dependencies(async ({ update, sourceMirror }) => {
        await writeFile(join(sourceMirror, 'calc.mjs'), 'untrusted');
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Done.","decision":null}' } });
        return { stopReason: 'end_turn' };
      });
      if (failure === 'cleanup') {
        const original = dependencies.rpcFactory;
        dependencies.rpcFactory = callbacks => ({ ...original(callbacks), close: async () => { throw new Error('unproven'); } });
      }
      const result = await runNativeDevin(ctx.defaults, dependencies);
      assert.equal(result.ok, false); assert.equal(result.uncertain, true);
      assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
      assert(!(await readdir(ctx.receipts)).some(name => name.startsWith('devin-result-')));
      if (failure === 'storage') {
        assert.equal(result.diagnostic.stage, 'terminal_evidence');
        assert.equal(await readFile(path, 'utf8'), 'preserve-existing-evidence');
      } else {
        assert.equal(result.diagnostic.reason, 'cleanup_unproven');
        assert.equal(result.diagnostic.cleanupConfirmed, false); assert.equal(result.stagedDraft, null);
      }
    });
  });

test('pre-prompt refusal records evidence without claiming a paid dispatch',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const dependencies = ctx.dependencies(async () => { throw new Error('must not prompt'); });
    const original = dependencies.rpcFactory;
    dependencies.rpcFactory = callbacks => ({ ...original(callbacks), request: async () => ({ protocolVersion: 0 }) });
    const result = await runNativeDevin(ctx.defaults, dependencies);
    assert.equal(result.noModelCalled, true); assert.equal(result.uncertain, false);
    assert.equal(result.diagnostic.reason, 'preflight_refused'); assert.equal(result.diagnostic.protocolStage, 'initialize');
    const names = await readdir(ctx.receipts);
    assert(names.some(name => name.startsWith('devin-terminal-')));
    assert(!names.some(name => name.startsWith('devin-dispatch-')));
    assert.equal(ctx.state().prompts, 0);
  }));
