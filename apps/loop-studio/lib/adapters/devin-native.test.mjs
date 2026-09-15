import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runNativeDevin } from './devin-native.mjs';
import { devinIsolatedEnvironment, devinIsolatedConfig } from '../devin-native-preflight.mjs';
import { verifyDevinExecDenial } from '../devin-native-context.mjs';
import { execFileSync } from 'node:child_process';
import { runCodeSeats } from '../code-seats.mjs';
import { DEVIN_CODE_BACKEND } from '../devin-code-seat.mjs';
import { DevinToolFeedback } from '../devin-native-workspace.mjs';
import { DEVIN_NATIVE_DIGEST } from '../devin-native-protocol.mjs';

test('Build survives recurring exec/read/edit failures across turns, repairs verification, and reaches independent review',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 20000 }, () => fixture(async ctx => {
    const git = (...args) => execFileSync('git', ['-C', ctx.candidate, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', 'calc.mjs');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    ctx.context.digest = DEVIN_NATIVE_DIGEST; // offline transport's pinned-seat fixture, not a live identity claim
    let turns = 0, verifies = 0, reviews = 0;
    const deps = ctx.dependencies(async ({ update, sourceMirror, mcp }) => {
      turns++;
      const path = join(sourceMirror, 'calc.mjs');
      const read = async () => JSON.parse((await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } })).result.content[0].text);
      // Three routine failures in each slice, including one that overlaps a
      // still-running earlier operation. No mock adapter success bypasses them.
      update({ sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec', status: 'failed', rawOutput: 'permission denied' });
      await read();
      update({ sessionUpdate: 'tool_call', toolCallId: 'read-miss', kind: 'read', _meta: { 'cognition.ai/inferenceToolName': 'read' }, rawInput: { file_path: join(sourceMirror, 'missing.txt') } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-miss', status: 'failed', rawOutput: 'unclassified' });
      await read();
      update({ sessionUpdate: 'tool_call', toolCallId: 'earlier-read', kind: 'read', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit-miss', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' }, rawInput: { file_path: path } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-miss', status: 'failed', rawOutput: 'unclassified' });
      const waiting = read();
      setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'earlier-read', status: 'completed' }), 20);
      const file = await waiting;
      if (turns > 1) assert.match(file.content, /prior accepted milestone/);
      const content = `// prior accepted milestone ${turns}\nexport const add=(a,b)=>${turns === 3 ? 'Number(a)+Number(b)' : 'a-b'};`;
      const written = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs', content, expectedSha256: file.sha256 } });
      assert.equal(written.result.isError, false);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ done: turns > 1, summary: 'milestone',
        decision: turns === 1 ? { action: 'continue', reason: 'remaining work' } : null }) } });
      return { stopReason: 'end_turn' };
    });
    const verify = async ({ worktree }) => {
      verifies++;
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';import {add} from './calc.mjs';assert.equal(add('2',3),5);`], { cwd: worktree, stdio: 'ignore' });
        return { ran: true, pass: true, exitCode: 0 };
      } catch { return { ran: true, pass: false, exitCode: 1, stderr: 'Addition contract failed' }; }
    };
    verify.command = 'offline numeric acceptance test'; verify.repeatable = true;
    const result = await runCodeSeats({ repoPath: ctx.candidate, receiptsDir: ctx.receipts, task: 'Fix numeric addition.',
      seats: { maker: { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' }, reviewer: { backend: 'claude', model: 'fixture-review' } },
      backendSnapshot: { maker: DEVIN_CODE_BACKEND, reviewer: { kind: 'claude_cli', transport: 'vendor_managed', provider: 'anthropic' } },
      adapters: { nativeMaker: options => runNativeDevin(options, deps), maker: () => { throw Error('No fallback'); },
        reviewer: async () => { reviews++; assert.equal(verifies, 2); return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; } },
      verify, limits: { maxCalls: 4, maxSteps: 3, maxActions: 100, maxTokens: 1000000, maxRecoveries: 0, maxRetries: 0, maxRepairs: 1 } });
    assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
    assert.equal(turns, 3); assert.equal(reviews, 1); assert.equal(verifies, 2);
    assert.equal(result.usage.calls, 4); assert.equal(result.usage.recoveries, 0); assert.equal(result.usage.repairs, 1);
    const proofs = (await readdir(ctx.receipts)).filter(name => name.startsWith('devin-no-effect-'));
    assert.equal(proofs.length, 9, 'every failed operation has durable no-effect evidence');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;', 'original repository is untouched');
  }));

for (const legacy of [false, true]) test(`real config evidence survives session migration without a paid failure (legacy=${legacy})`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const config = { ...devinIsolatedConfig(), permissions: { allow: [], ask: [], deny: ['exec'] } };
    if (legacy) delete config.version;
    const configBytes = JSON.stringify(config);
    await writeFile(ctx.context.config, configBytes, { mode: 0o600 });
    ctx.context.digest = createHash('sha256').update(await readFile(ctx.context.harness)).digest('hex');
    ctx.context.verifyExecDenial = () => verifyDevinExecDenial({ config: ctx.context.config, configBytes,
      harness: ctx.context.harness, artifactDigest: ctx.context.digest });
    const deps = ctx.dependencies(async ({ update, mcp }) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 'denied', kind: 'execute', _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'denied', status: 'failed' });
      await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    const factory = deps.rpcFactory;
    deps.rpcFactory = callbacks => {
      const rpc = factory(callbacks);
      return { ...rpc, async request(method, params) {
        if (method === 'session/new' && legacy) await writeFile(ctx.context.config, JSON.stringify({ ...config, version: 1 }));
        return rpc.request(method, params);
      } };
    };
    const result = await runNativeDevin(ctx.defaults, deps);
    if (legacy) {
      assert.equal(result.noModelCalled, true); assert.equal(ctx.state().prompts, 0);
      assert.equal(result.diagnostic.reconciliationFailure, 'exec_policy_changed');
    } else {
      assert.equal(result.ok, true, result.error); assert.equal(ctx.state().prompts, 1);
      const terminal = (await readdir(ctx.receipts)).find(name => name.startsWith('devin-terminal-'));
      assert.equal(JSON.parse(await readFile(join(ctx.receipts, terminal), 'utf8')).diagnostic.toolFailures[0].recovery, 'verified_no_effect');
    }
  }));

for (const fault of ['none', 'changed', 'extra', 'outside', 'protected', 'missing_input']) test(`failed native read reconciles only checked no-effect evidence: ${fault}`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, sourceMirror, mcp }) => {
      const path = fault === 'outside' ? join(ctx.candidate, 'calc.mjs') : join(sourceMirror, fault === 'protected' ? '.env' : 'missing.txt');
      update({ sessionUpdate: 'tool_call', toolCallId: 'read-miss', kind: 'read', _meta: { 'cognition.ai/inferenceToolName': 'read' },
        ...(fault === 'missing_input' ? {} : { rawInput: { file_path: path } }) });
      if (fault === 'changed') await writeFile(join(sourceMirror, 'calc.mjs'), 'unapproved');
      if (fault === 'extra') await writeFile(join(sourceMirror, 'extra'), 'unapproved');
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-miss', status: 'failed', rawOutput: 'private read error' });
      await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } }).catch(() => {});
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, fault === 'none', result.error);
    assert.doesNotMatch(JSON.stringify(result.diagnostic ?? {}), /private read error|missing\.txt/);
    const proofs = (await readdir(ctx.receipts)).filter(name => name.startsWith('devin-no-effect-'));
    assert.equal(proofs.length, fault === 'none' ? 1 : 0);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));

test('failed edit waits for an earlier native read to settle and then admits the corrected write',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, sourceMirror, mcp }) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 'earlier-read', kind: 'read', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'miss', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' }, rawInput: { file_path: join(sourceMirror, 'calc.mjs') } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'miss', status: 'failed' });
      let finished = false;
      const waiting = mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } }).then(value => { finished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(finished, false);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'earlier-read', status: 'completed' });
      const file = JSON.parse((await waiting).result.content[0].text);
      const written = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs', content: 'fixed', expectedSha256: file.sha256 } });
      assert.equal(written.result.isError, false);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Fixed","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'fixed');
  }));

test('denied exec lets a previously granted ACP write finish through the settlement barrier',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, callbacks, sourceMirror, sessionId, mcp }) => {
      const path = join(sourceMirror, 'calc.mjs');
      update({ sessionUpdate: 'tool_call', toolCallId: 'prior-write', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: path, content: 'fixed' } });
      await callbacks.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 'prior-write' }, options: [{ kind: 'allow_once', optionId: 'once' }] });
      update({ sessionUpdate: 'tool_call', toolCallId: 'denied', kind: 'execute', _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'denied', status: 'failed' });
      await callbacks.onRequest('fs/write_text_file', { sessionId, path, content: 'fixed' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'prior-write', status: 'completed' });
      await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Fixed","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'fixed');
  }));

for (const cancel of [false, true]) test(`settlement drains an existing host command without admitting later work (cancel=${cancel})`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const control = new AbortController(); ctx.defaults.signal = control.signal;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const deps = ctx.dependencies(async ({ update, mcp, callbacks, sourceMirror, sessionId }) => {
      const first = mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      await started;
      update({ sessionUpdate: 'tool_call', toolCallId: 'denied', kind: 'execute', _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'denied', status: 'failed' });
      let finished = false;
      const later = callbacks.onRequest('fs/read_text_file', { sessionId, path: join(sourceMirror, 'calc.mjs') }).then(value => { finished = true; return value; }).catch(() => null);
      try {
        await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(finished, false);
        if (cancel) control.abort();
      } finally { release(); }
      await first.catch(() => {}); await later;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => { entered(); await waiting; return { code: 0, stdout: '' }; };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, !cancel, result.error);
    const receipts = (await readdir(ctx.receipts)).filter(name => name.startsWith('devin-no-effect-'));
    assert.equal(receipts.length, cancel ? 0 : 1);
  }));

test('shared Build discards a truncated native turn then completes via checked writes without a human restart',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 20000 }, () => fixture(async ctx => {
    const git = (...args) => execFileSync('git', ['-C', ctx.candidate, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', 'calc.mjs');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    ctx.context.digest = DEVIN_NATIVE_DIGEST; // pinned identity in the offline transport fixture
    let turns = 0, reviews = 0, verifies = 0, failedMirror;
    const deps = ctx.dependencies(async ({ callbacks, update, sourceMirror, sessionId, mcp }) => {
      turns++;
      const path = join(sourceMirror, 'calc.mjs');
      if (turns === 2) {
        failedMirror = sourceMirror;
        const tool = { toolCallId: 'truncate', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' },
          rawInput: { file_path: path, old_string: 'a+b', new_string: 'Number(a)+Number(b)' } };
        update({ sessionUpdate: 'tool_call', ...tool });
        await callbacks.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 'truncate' }, options: [{ kind: 'allow_once', optionId: 'truncate' }] });
        await writeFile(path, '');
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'truncate', status: 'failed' });
        await callbacks.onRequest('fs/read_text_file', { sessionId, path }).catch(() => {});
        return { stopReason: 'end_turn' };
      }
      const content = turns === 1 ? 'export const add=(a,b)=>a+b;' : 'export const add=(a,b)=>Number(a)+Number(b);';
      const current = (await callbacks.onRequest('fs/read_text_file', { sessionId, path })).content;
      if (turns === 3) assert.equal(current, 'export const add=(a,b)=>a+b;', 'prior accepted turn retained, failed mirror excluded');
      const reply = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs', content,
        expectedSha256: createHash('sha256').update(current).digest('hex') } });
      assert.equal(reply.error, undefined);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ done: turns === 3, summary: 'progress',
        decision: turns === 1 ? { action: 'continue', reason: 'remaining work' } : null }) } });
      return { stopReason: 'end_turn' };
    });
    const verify = async ({ worktree }) => { verifies++; assert.equal(await readFile(join(worktree, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>Number(a)+Number(b);'); return { ran: true, pass: true, exitCode: 0 }; };
    verify.command = 'offline fixture'; verify.repeatable = true;
    const result = await runCodeSeats({ repoPath: ctx.candidate, receiptsDir: ctx.receipts, task: 'Fix addition and normalize numeric arguments.',
      seats: { maker: { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' }, reviewer: { backend: 'claude', model: 'fixture-review' } },
      backendSnapshot: { maker: DEVIN_CODE_BACKEND, reviewer: { kind: 'claude_cli', transport: 'vendor_managed', provider: 'anthropic' } },
      adapters: { nativeMaker: options => runNativeDevin(options, deps), maker: () => { throw new Error('No fallback'); },
        reviewer: async () => { reviews++; return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; } },
      verify, limits: { maxTokens: 1000000, maxCalls: 4, maxSteps: 2, maxActions: 100, maxRecoveries: 1, maxRetries: 0, maxRepairs: 0 } });
    assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
    assert.equal(turns, 3); assert.equal(reviews, 1); assert.equal(verifies, 1);
    assert.equal(result.usage.calls, 4); assert.equal(result.usage.recoveries, 1); assert.equal(result.usage.retries, 0);
    assert.equal(await readFile(join(failedMirror, 'calc.mjs'), 'utf8'), '');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));

test('truncated native file is refused, diagnosed and discarded rather than acknowledged as no effect',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ callbacks, sourceMirror, update }) => {
      const path = join(sourceMirror, 'calc.mjs');
      const tool = { toolCallId: 'truncate', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' },
        rawInput: { file_path: path, old_string: 'a-b', new_string: 'a+b' } };
      update({ sessionUpdate: 'tool_call', ...tool });
      await callbacks.onRequest('session/request_permission', { sessionId: 'fixture-s1', toolCall: { toolCallId: 'truncate' },
        options: [{ kind: 'allow_once', optionId: 'truncate' }] });
      await writeFile(path, '');
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'truncate', status: 'failed', rawOutput: 'private failure detail' });
      await callbacks.onRequest('fs/read_text_file', { sessionId: 'fixture-s1', path }).catch(() => {});
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false); assert.equal(result.diagnostic.cleanupConfirmed, true);
    assert.equal(result.diagnostic.reconciliationFailure, 'target_changed');
    assert.equal(result.recoveryDisposition, 'discard_mirror_v1');
    assert.equal(await readFile(join(result.stagedDraft.path, 'calc.mjs'), 'utf8'), '');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    assert.equal((await readdir(ctx.receipts)).filter(name => name.startsWith('devin-no-effect-')).length, 0);
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /private failure detail|calc\.mjs/);
  }));

test('ACP wrap-up finishes a granted write, refuses new discovery, then accepts an honest partial decision',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    ctx.defaults.observedBudget.maxObservedTools = 16;
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ callbacks, sourceMirror, sessionId, update }) => {
      const path = join(sourceMirror, 'calc.mjs'), content = 'export const add=(a,b)=>a+b;';
      update({ sessionUpdate: 'tool_call', toolCallId: 'write', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: path, content } });
      await callbacks.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 'write' }, options: [{ kind: 'allow_once', optionId: 'write' }] });
      for (let n = 0; n < 9; n++) await callbacks.onRequest('fs/read_text_file', { sessionId, path });
      // Crossing the soft threshold must not strand an already-granted write.
      await callbacks.onRequest('fs/write_text_file', { sessionId, path, content });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'discovery', kind: 'read', _meta: { 'cognition.ai/inferenceToolName': 'read' }, rawInput: { file_path: path } });
      await assert.rejects(callbacks.onRequest('fs/read_text_file', { sessionId, path }), error => error.code === 'slice_wrap_up' && /remainingActions/.test(error.message));
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'discovery', status: 'failed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":false,"summary":"addition fixed","decision":{"action":"continue","reason":"tests remain"}}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error);
    assert.equal(JSON.parse(result.text).done, false);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a+b;');
    const receipt = JSON.parse(await readFile(join(ctx.receipts, (await readdir(ctx.receipts)).find(n => n.startsWith('devin-no-effect-'))), 'utf8'));
    assert.equal(receipt.operation, 'host_budget_denial'); assert.equal(receipt.operationCompleted, false);
  }));

test('MCP soft limit refuses a new write before effect and preserves room for terminal JSON',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    ctx.defaults.observedBudget.maxObservedTools = 16;
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ mcp, update }) => {
      for (let n = 0; n < 11; n++) await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      const reply = await mcp('tools/call', { name: 'write_file', arguments: { path: 'forbidden-new.mjs', content: 'not written', expectedSha256: null } });
      assert.equal(JSON.parse(reply.result.content[0].text).code, 'slice_wrap_up');
      assert.equal(JSON.parse(reply.result.content[1].text).remainingActions, 4);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":false,"summary":"inspected","decision":{"action":"continue","reason":"implementation remains"}}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error);
    await assert.rejects(readFile(join(ctx.candidate, 'forbidden-new.mjs')), { code: 'ENOENT' });
  }));

for (const cause of ['provider phase timeout', 'operator cancelled']) test(`parent stop classification: ${cause}`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const control = new AbortController(); ctx.defaults.signal = control.signal;
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async () => {
      control.abort(new Error(cause)); return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false); assert.equal(result.diagnostic.cleanupConfirmed, true);
    assert.equal(result.diagnostic.reason, cause === 'provider phase timeout' ? 'deadline' : 'cancelled');
    assert.equal(result.recoveryDisposition, cause === 'provider phase timeout' ? 'discard_mirror_v1' : undefined);
  }));

test('host-proven missing ACP read permits correction to creation in the same native turn',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ callbacks, sourceMirror, update }) => {
      const params = { sessionId: 'fixture-s1', path: join(sourceMirror, 'new.mjs') };
      await assert.rejects(callbacks.onRequest('fs/read_text_file', params), e => e instanceof DevinToolFeedback && e.code === 'file_not_prepared');
      await callbacks.onRequest('fs/write_text_file', { ...params, content: 'export const ready=true;' });
      assert.equal((await callbacks.onRequest('fs/read_text_file', params)).content, 'export const ready=true;');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Created","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error);
    assert.equal(await readFile(join(ctx.candidate, 'new.mjs'), 'utf8'), 'export const ready=true;');
  }));

for (const channel of ['delegated', 'native']) test(`shared Build completes ${channel} create/read/edit, frozen verification and independent review without changing the source`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, () => fixture(async ctx => {
    const git = (...args) => execFileSync('git', ['-C', ctx.candidate, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', 'calc.mjs');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    let reviews = 0, verifications = 0;
    const deps = ctx.dependencies(async ({ callbacks, update, sourceMirror, mcp }) => {
      for (const [id, name, content] of [['create', 'nested/new.mjs', 'export const ready=true;'],
        ['edit', 'calc.mjs', 'export const add=(a,b)=>a+b;']]) {
        const path = join(sourceMirror, name);
        const tool = { toolCallId: id, kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'write' },
          rawInput: { file_path: path, content } };
        update({ sessionUpdate: 'tool_call', ...tool });
        const permission = await callbacks.onRequest('session/request_permission', { sessionId: 'fixture-s1',
          toolCall: { toolCallId: id }, options: [{ kind: 'allow_once', optionId: id }] });
        assert.equal(permission.outcome.optionId, id);
        const approvals = (await readdir(ctx.receipts)).filter(name => name.startsWith('devin-write-'));
        assert.equal(approvals.length, id === 'create' ? 1 : 2, 'approval is durable before returning permission');
        if (channel === 'delegated') await callbacks.onRequest('fs/write_text_file', { sessionId: 'fixture-s1', path, content });
        else execFileSync('/usr/bin/sandbox-exec', ['-p', callbacks.args[1], callbacks.args[2], '-e',
          `const f=require('node:fs'),p=require('node:path');f.mkdirSync(p.dirname(${JSON.stringify(path)}),{recursive:true});f.writeFileSync(${JSON.stringify(path)},${JSON.stringify(content)});`],
        { cwd: sourceMirror, env: callbacks.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
        assert.equal((await callbacks.onRequest('fs/read_text_file', { sessionId: 'fixture-s1', path })).content, content);
        const pending = await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: ['must wait'] } });
        assert.equal(JSON.parse(pending.result.content[0].text).code, 'native_write_pending', 'bytes alone do not prove the native tool has stopped');
        update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
        if (channel === 'native' && id === 'create') {
          const miss = { toolCallId: 'miss', kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' },
            rawInput: { file_path: join(sourceMirror, 'calc.mjs'), old_string: 'not in file', new_string: 'correction' } };
          update({ sessionUpdate: 'tool_call', ...miss });
          await assert.rejects(callbacks.onRequest('session/request_permission', { sessionId: 'fixture-s1',
            toolCall: { toolCallId: 'miss' }, options: [{ kind: 'allow_once', optionId: 'miss' }] }), e => e.code === 'stale_file');
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'miss', status: 'failed' });
          // The next host operation is queued behind reconciliation, not a new
          // model dispatch or an automatic replay of the failed edit.
          await callbacks.onRequest('fs/read_text_file', { sessionId: 'fixture-s1', path: join(sourceMirror, 'calc.mjs') });
        }
      }
      const decision = '{"done":true,"summary":"Created and edited","decision":null}';
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: channel === 'native'
        ? `All steps complete: corrected the file and verified the created file.\n\n${decision}`
        : `\`\`\`json\n${decision}\n\`\`\`` } });
      return { stopReason: 'end_turn' };
    });
    const verify = async ({ worktree }) => {
      verifications++;
      assert.equal(await readFile(join(worktree, 'nested/new.mjs'), 'utf8'), 'export const ready=true;');
      assert.equal(await readFile(join(worktree, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a+b;');
      return { ran: true, pass: true, exitCode: 0 };
    };
    verify.command = 'frozen offline fixture'; verify.repeatable = false;
    const result = await runCodeSeats({ repoPath: ctx.candidate, receiptsDir: ctx.receipts, task: 'Create nested/new.mjs and fix addition.',
      seats: { maker: { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' },
        reviewer: { backend: 'claude', model: 'fixture-review' } },
      backendSnapshot: { maker: DEVIN_CODE_BACKEND, reviewer: { kind: 'claude_cli', transport: 'vendor_managed', provider: 'anthropic' } },
      adapters: { nativeMaker: options => runNativeDevin(options, deps),
        maker: () => { throw new Error('No fallback'); }, reviewer: async ({ prompt }) => {
          reviews++; assert.match(prompt, /nested\/new.mjs/);
          return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } };
        } }, verify, limits: { maxTokens: 1000000, maxCalls: 3, maxSteps: 1, maxActions: 40, maxRepairs: 0, maxRetries: 0, maxRecoveries: 0 } });
    assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
    const nativeName = (await readdir(ctx.receipts)).find(name => name.startsWith('devin-result-'));
    const evidence = JSON.parse(await readFile(join(ctx.receipts, nativeName), 'utf8')).writeEvidence;
    assert.deepEqual(JSON.parse(await readFile(join(ctx.receipts, nativeName), 'utf8')).decisionNormalizations,
      [channel === 'native' ? 'leading_plaintext_removed' : 'single_json_fence_removed']);
    assert.equal(evidence.verifiedAfterCleanup, true); assert.equal(evidence.writes.length, 2);
    if (channel === 'native') {
      const receipt = JSON.parse(await readFile(join(ctx.receipts, nativeName), 'utf8'));
      assert.equal(receipt.toolFailures[0].recovery, 'verified_no_effect');
      assert.equal((await readdir(ctx.receipts)).filter(name => name.startsWith('devin-no-effect-')).length, 1);
    }
    assert.equal(reviews, 1); assert.equal(verifications, 1); assert.equal(ctx.state().prompts, 1);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    await assert.rejects(readFile(join(ctx.candidate, 'nested/new.mjs')), { code: 'ENOENT' });
  }));

test('two SWE slices survive edit misses, blocked native exec, invalid commands and missing summaries through verification/review',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, () => fixture(async ctx => {
    const git = (...args) => execFileSync('git', ['-C', ctx.candidate, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', 'calc.mjs');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    let slices = 0, reviews = 0, verifies = 0;
    const deps = ctx.dependencies(async ({ callbacks, update, sourceMirror, sessionId, mcp }) => {
      slices++;
      const path = join(sourceMirror, 'calc.mjs');
      const before = (await callbacks.onRequest('fs/read_text_file', { sessionId, path })).content;
      assert.equal(before, slices === 1 ? 'export const add=(a,b)=>a-b;' : 'export const add=(a,b)=>a+b;');
      const content = slices === 1 ? 'export const add=(a,b)=>a+b;' : 'export const add=(a,b)=>Number(a)+Number(b);';
      for (const id of ['failed', 'corrected']) {
        const tool = { toolCallId: id, kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: path, content } };
        update({ sessionUpdate: 'tool_call', ...tool });
        await callbacks.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: id }, options: [{ kind: 'allow_once', optionId: id }] });
        if (id === 'corrected') await writeFile(path, content);
        update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: id === 'failed' ? 'failed' : 'completed',
          rawOutput: id === 'failed' ? 'sensitive-provider-text' : undefined });
        await callbacks.onRequest('fs/read_text_file', { sessionId, path });
      }
      update({ sessionUpdate: 'tool_call', toolCallId: 'blocked-exec', kind: 'execute',
        _meta: { 'cognition.ai/inferenceToolName': 'exec' }, rawInput: { command: 'must not execute' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'blocked-exec', status: 'failed', rawOutput: 'untrusted-error-text' });
      const invalid = await mcp('tools/call', { name: 'run_command', arguments: { command: 'pnpm test', args: [] } });
      assert.equal(JSON.parse(invalid.result.content[0].text).code, 'invalid_command');
      const command = await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      assert.equal(JSON.parse(command.result.content[0].text).exitCode, 0, 'revoked grants do not block later commands');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ done: slices === 2,
        decision: slices === 1 ? { action: 'continue', reason: 'Finish numeric input support.' } : null }) } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => ({ code: 0, stdout: '' });
    const verify = async ({ worktree }) => {
      verifies++;
      assert.equal(await readFile(join(worktree, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>Number(a)+Number(b);');
      return { ran: true, pass: true, exitCode: 0 };
    };
    verify.command = 'frozen offline recovery fixture'; verify.repeatable = false;
    const result = await runCodeSeats({ repoPath: ctx.candidate, receiptsDir: ctx.receipts, task: 'Fix addition including numeric strings.',
      seats: { maker: { backend: 'devin', model: 'swe-2-high', codeExecutor: 'devin_native', observedBudgetConsent: 'devin-observed/v1' }, reviewer: { backend: 'claude', model: 'fixture-review' } },
      backendSnapshot: { maker: DEVIN_CODE_BACKEND, reviewer: { kind: 'claude_cli', transport: 'vendor_managed', provider: 'anthropic' } },
      adapters: { nativeMaker: options => runNativeDevin(options, deps), maker: () => { throw new Error('No fallback'); },
        reviewer: async () => { reviews++; return { ran: true, verdict: 'APPROVED', findings: [], usage: { total_tokens: 5 } }; } },
      verify, limits: { maxTokens: 1000000, maxCalls: 3, maxSteps: 2, maxActions: 64, maxRepairs: 0, maxRetries: 0, maxRecoveries: 0 } });
    assert.equal(result.completion, 'candidate_ready_for_acceptance', result.error);
    assert.equal(slices, 2); assert.equal(reviews, 1); assert.equal(verifies, 1);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    const results = (await readdir(ctx.receipts)).filter(name => name.startsWith('devin-result-'));
    assert.equal(results.length, 2);
    for (const name of results) {
      const receipt = await readFile(join(ctx.receipts, name), 'utf8');
      assert.doesNotMatch(receipt, /sensitive-provider-text/);
      assert.equal(JSON.parse(receipt).writeEvidence.writes[0].noEffectVerified, true);
      assert.deepEqual(JSON.parse(receipt).decisionNormalizations, ['missing_summary_defaulted_empty']);
      assert.equal(JSON.parse(receipt).toolFailures[0].recovery, 'verified_no_effect');
      assert.equal(JSON.parse(receipt).toolFailures[1].nativeTool, 'exec');
      assert.equal(JSON.parse(receipt).toolFailures[1].recovery, 'verified_no_effect');
    }
  }));

for (const effect of ['partial', 'applied', 'extra', 'overlap']) test(`failed native edit refuses ${effect} evidence without adoption`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ callbacks, update, sourceMirror, sessionId }) => {
      const path = join(sourceMirror, 'calc.mjs'), content = 'approved';
      update({ sessionUpdate: 'tool_call', toolCallId: 'bad', kind: 'edit',
        _meta: { 'cognition.ai/inferenceToolName': 'write' }, rawInput: { file_path: path, content } });
      await callbacks.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 'bad' }, options: [{ kind: 'allow_once', optionId: 'bad' }] });
      if (effect === 'partial' || effect === 'applied') await writeFile(path, effect === 'partial' ? 'partial' : content);
      if (effect === 'extra') await writeFile(join(sourceMirror, 'unapproved'), 'x');
      if (effect === 'overlap') update({ sessionUpdate: 'tool_call', toolCallId: 'other', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'bad', status: 'failed' });
      const rejected = callbacks.onRequest('fs/write_text_file', { sessionId,
        path: join(sourceMirror, 'queued-must-not-exist'), content: 'must not execute after failed reconciliation' });
      await assert.rejects(rejected);
      await assert.rejects(readFile(join(sourceMirror, 'queued-must-not-exist')), { code: 'ENOENT' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Claim","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
    assert.equal(result.diagnostic.reason, 'tool_failed');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    assert.equal((await readdir(ctx.receipts)).filter(name => name.startsWith('devin-result-')).length, 0);
  }));

test('native OS profile refuses child execution even of the allowed harness itself',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ callbacks, update, sourceMirror }) => {
      const script = `const {spawnSync}=require('node:child_process');
        const code="require('node:fs').writeFileSync("+JSON.stringify(${JSON.stringify(join(sourceMirror, 'calc.mjs'))})+",'unsafe')";
        const r=spawnSync(process.execPath,['-e',code]);
        if(!r.error||!['EPERM','EACCES'].includes(r.error.code))process.exit(41);`;
      execFileSync('/usr/bin/sandbox-exec', ['-p', callbacks.args[1], callbacks.args[2], '-e', script],
        { cwd: sourceMirror, env: callbacks.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      assert.equal(await readFile(join(sourceMirror, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error);
  }));

for (const fault of ['missing_policy', 'changed_policy', 'partial_write', 'extra_file', 'overlap', 'completed_exec', 'cleanup', 'receipt_collision'])
  test(`native exec recovery refuses ${fault}`,
    { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
      let executed = 0;
      const deps = ctx.dependencies(async ({ update, sourceMirror, mcp }) => {
        if (fault === 'missing_policy') ctx.context.verifyExecDenial = undefined;
        if (fault === 'changed_policy') ctx.context.verifyExecDenial = async () => { throw new Error('Changed host policy'); };
        if (fault === 'receipt_collision') {
          const hash = value => createHash('sha256').update(value).digest('hex');
          await writeFile(join(ctx.receipts, `devin-no-effect-${hash('fixture-s1')}-${hash('exec')}.json`), 'do not overwrite');
        }
        if (fault === 'partial_write') await writeFile(join(sourceMirror, 'calc.mjs'), 'unapproved');
        if (fault === 'extra_file') await writeFile(join(sourceMirror, 'surprise.txt'), 'unapproved');
        if (fault === 'overlap') update({ sessionUpdate: 'tool_call', toolCallId: 'live', kind: 'edit', status: 'in_progress' });
        update({ sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec', status: fault === 'completed_exec' ? 'completed' : 'failed', rawOutput: 'permission denied' });
        await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } }).catch(() => {});
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"decision":null}' } });
        return { stopReason: 'end_turn' };
      });
      deps.runProcess = async () => { executed++; return { code: 0, stdout: '' }; };
      if (fault === 'cleanup') {
        const factory = deps.rpcFactory;
        deps.rpcFactory = args => ({ ...factory(args), close: async () => { throw new Error('Writer cleanup unproven'); } });
      }
      const result = await runNativeDevin(ctx.defaults, deps);
      assert.equal(result.ok, false); assert.equal(result.uncertain, true);
      if (fault !== 'cleanup') assert.equal(executed, 0, 'reconciliation failure cancels the next host dispatch');
      assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
      assert.equal((await readdir(ctx.receipts)).filter(name => name.startsWith('devin-result-')).length, 0);
    }));

test('cancellation drains queued ACP writes without creating their files',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const control = new AbortController(); ctx.defaults.signal = control.signal;
    let started; const entered = new Promise(resolve => { started = resolve; });
    const deps = ctx.dependencies(async ({ mcp, callbacks, sourceMirror }) => {
      const command = mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      await entered;
      const write = callbacks.onRequest('fs/write_text_file', { sessionId: 'fixture-s1', path: join(sourceMirror, 'must-not-exist'), content: 'x' });
      const rejected = assert.rejects(write);
      await new Promise(resolve => setImmediate(resolve)); control.abort();
      await Promise.all([command, rejected]); return { stopReason: 'end_turn' };
    });
    deps.runProcess = async ({ signal }) => { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('Cancelled'); };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, false);
    await assert.rejects(readFile(join(ctx.state().sourceMirror, 'must-not-exist')), { code: 'ENOENT' });
  }));

test('SWE sees the actual budget and a live warning, then returns a valid partial completion without another prompt',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    ctx.defaults.observedBudget.maxObservedTools = 8;
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, mcp, promptText }) => {
      assert.match(promptText, /"maximumActions":8/);
      assert.match(promptText, /"wrapUpAtActions":6/);
      assert.match(promptText, /internal inference spend remains unknown/);
      const markerName = (await readdir(ctx.receipts)).find(name => name.startsWith('devin-dispatch-'));
      const marker = JSON.parse(await readFile(join(ctx.receipts, markerName), 'utf8'));
      assert.equal(marker.dispatchPromptHash, createHash('sha256').update(promptText).digest('hex'));
      for (let i = 0; i < 3; i++) {
        update({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, kind: 'read', status: 'pending' });
        const reply = await mcp('tools/call', i === 0
          ? { name: 'write_file', arguments: { path: 'partial.txt', content: 'bounded draft', expectedSha256: null } }
          : { name: 'read_file', arguments: { path: 'calc.mjs' } });
        assert.equal(reply.result.isError, false);
        const budget = JSON.parse(reply.result.content[1].text);
        assert.equal(budget.usedActions, (i + 1) * 2);
        assert.equal(budget.remainingActions, 8 - (i + 1) * 2);
        assert.equal(budget.wrapUp, i === 2);
        if (i === 2) assert.match(budget.guidance, /Stop tools and return the final JSON now/);
        update({ sessionUpdate: 'tool_call_update', toolCallId: `t${i}`, status: 'completed' });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ done: false,
        summary: 'Saved a bounded draft.', decision: { action: 'continue', reason: 'Finish partial.txt and verify.' } }) } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, true, result.error); assert.equal(ctx.state().prompts, 1);
    assert.equal(JSON.parse(result.text).done, false); assert.equal(JSON.parse(result.text).decision.action, 'continue');
    assert.equal(await readFile(join(ctx.candidate, 'partial.txt'), 'utf8'), 'bounded draft');
  }));

test('completed host commands with nonzero exit codes stay data, not uncertain native failures',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    let commands = 0;
    const deps = ctx.dependencies(async ({ mcp, update }) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
        assert.equal(response.result.isError, false);
        assert.equal(JSON.parse(response.result.content[0].text).exitCode, attempt === 0 ? 1 : 0);
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => ({ code: commands++ === 0 ? 1 : 0, stdout: 'check output' });
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, true, result.error); assert.equal(commands, 2); assert.equal(ctx.state().prompts, 1);
  }));

test('malformed command requests give bounded no-execution guidance and accept a corrected argv request',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    let executed = 0;
    const deps = ctx.dependencies(async ({ mcp, update }) => {
      for (const args of [
        { command: 'pnpm test', args: [] }, { command: 'pnpm', args: ['test'] },
        { command: '/bin/echo', args: 'secret-argument' }, { command: '/bin/echo', args: ['bad\0arg'] },
        { command: '/bin/echo', args: [], extra: true }, { command: '/bin/echo', args: Array(101).fill('x') },
        { command: '/bin/echo', args: ['x'.repeat(16384)] }, {},
      ]) {
        const reply = await mcp('tools/call', { name: 'run_command', arguments: args });
        assert.equal(reply.result.isError, false);
        const feedback = JSON.parse(reply.result.content[0].text);
        assert.equal(feedback.operationCompleted, false); assert.equal(feedback.code, 'invalid_command');
        assert.equal(JSON.parse(reply.result.content[1].text).kind, 'camus_native_budget');
        assert.doesNotMatch(feedback.guidance, /secret-argument|bad\x00arg/);
        assert.equal(executed, 0);
      }
      const reply = await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: ['literal; not a shell'] } });
      assert.equal(JSON.parse(reply.result.content[0].text).exitCode, 0);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async options => {
      executed++; assert.equal(options.command, '/usr/bin/sandbox-exec');
      assert.deepEqual(options.args.slice(2), ['/bin/echo', 'literal; not a shell']);
      assert.match(options.args[1], /deny file-write/); assert.equal(options.signal.aborted, false);
      return { code: 0, stdout: 'ok' };
    };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, true, result.error); assert.equal(executed, 1); assert.equal(ctx.state().prompts, 1);
  }));

test('overlapping MCP requests cannot interrupt or run beside a sandbox command',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    let release, started, executions = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const deps = ctx.dependencies(async ({ mcp, update }) => {
      const first = mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      await entered;
      try {
        const busy = await mcp('tools/call', { name: 'write_file', arguments: { path: 'calc.mjs', content: 'must not execute', expectedSha256: null } });
        assert.equal(JSON.parse(busy.result.content[0].text).code, 'tool_busy');
        assert.equal(JSON.parse(busy.result.content[1].text).usedActions, 2);
        assert.equal(executions, 1);
      } finally { release(); }
      assert.equal((await first).result.isError, false);
      const read = await mcp('tools/call', { name: 'read_file', arguments: { path: 'calc.mjs' } });
      assert.equal(JSON.parse(read.result.content[0].text).content, 'export const add=(a,b)=>a-b;');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => { executions++; started(); await waiting; return { code: 0, stdout: '' }; };
    try {
      const result = await runNativeDevin(ctx.defaults, deps);
      assert.equal(result.ok, true, result.error); assert.equal(executions, 1);
    } finally { release(); }
  }));

test('post-dispatch process errors remain fatal, redacted and unreplayed',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    let executed = 0;
    const deps = ctx.dependencies(async ({ mcp }) => {
      const reply = await mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      assert.equal(reply.result.isError, true);
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => { executed++; throw new Error('private-process-error'); };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, false); assert.equal(executed, 1); assert.equal(result.uncertain, true);
    assert.deepEqual(result.diagnostic.boundaryRefusal, { code: 'host_operation_refused', tool: null });
    assert.doesNotMatch(JSON.stringify(result), /private-process-error/);
    const terminalName = (await readdir(ctx.receipts)).find(name => name.startsWith('devin-terminal-'));
    const terminal = JSON.parse(await readFile(join(ctx.receipts, terminalName), 'utf8'));
    assert.deepEqual(terminal.diagnostic.boundaryRefusal, result.diagnostic.boundaryRefusal);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));

test('native file requests wait for a command, then complete without concurrent effects',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    let started, release, readFinished = false;
    const entered = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const deps = ctx.dependencies(async ({ mcp, callbacks, sourceMirror, update }) => {
      const first = mcp('tools/call', { name: 'run_command', arguments: { command: '/bin/echo', args: [] } });
      await entered;
      const read = callbacks.onRequest('fs/read_text_file', { sessionId: 'fixture-s1', path: join(sourceMirror, 'calc.mjs') }).then(value => { readFinished = true; return value; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(readFinished, false);
      release();
      await first;
      assert.equal((await read).content, 'export const add=(a,b)=>a-b;');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"done":true,"summary":"Checked","decision":null}' } });
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => { started(); await waiting; return { code: 0, stdout: '' }; };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, true, result.error); assert.equal(readFinished, true);
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
  }));

test('command corrections cannot extend an exhausted budget',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    ctx.defaults.observedBudget.maxObservedTools = 1;
    let executed = 0;
    const deps = ctx.dependencies(async ({ mcp }) => {
      const bad = await mcp('tools/call', { name: 'run_command', arguments: { command: 'pnpm test', args: [] } });
      assert.equal(JSON.parse(bad.result.content[0].text).code, 'slice_wrap_up');
      const corrected = await mcp('tools/call', { name: 'run_command', arguments: { command: '/usr/bin/env', args: ['pnpm', 'test'] } });
      assert(corrected.error);
      return { stopReason: 'end_turn' };
    });
    deps.runProcess = async () => { executed++; return { code: 0, stdout: '' }; };
    const result = await runNativeDevin(ctx.defaults, deps);
    assert.equal(result.ok, false); assert.equal(executed, 0);
    assert.equal(result.diagnostic.reason, 'observed_tool_limit');
    assert.equal(result.diagnostic.boundaryRefusal, null);
    assert.equal(result.recoveryDisposition, 'discard_mirror_v1');
  }));

async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-adapter-test-')));
  const candidate = join(root, 'candidate'), auth = join(root, 'auth'), receipts = join(root, 'receipts');
  await mkdir(candidate, { mode: 0o700 }); await mkdir(auth, { mode: 0o700 }); await mkdir(receipts, { mode: 0o700 });
  await writeFile(join(candidate, 'calc.mjs'), 'export const add=(a,b)=>a-b;');
  let brokerDefinition, sourceMirror, releaseCalled = false, prompts = 0;
  const env = devinIsolatedEnvironment(auth);
  const context = { root: auth, env, harness: await realpath(process.execPath), config: join(auth, 'config.json'),
    digest: 'offline-fixture', configureMcp: async value => { brokerDefinition = value; },
    verifyExecDenial: async () => ({ policy: 'native-exec-denied/v1', artifactDigest: context.digest, configHash: 'a'.repeat(64) }),
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
      const sessionId = `fixture-s${prompts + 1}`;
      const update = value => callbacks.onNotification('session/update', { sessionId, update: value });
      return { fail() {}, async close() {}, async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'devin-browser' }] };
        if (method === 'session/new') { sourceMirror = params.cwd; return { sessionId,
          configOptions: [{ category: 'model', currentValue: 'swe-2-high' }], modes: { currentModeId: 'autonomous' } }; }
        if (method === 'session/prompt') {
          prompts++;
          assert((await readdir(receipts)).some(name => name.startsWith('devin-dispatch-')));
          await mcp('initialize', { protocolVersion: '2025-03-26' }); await mcp('tools/list', {});
          return prompt({ update, callbacks, mcp, sourceMirror, sessionId, promptText: params.prompt[0].text });
        }
        throw new Error('Unexpected RPC.');
      } };
    } });
  try { await fn({ defaults, dependencies, candidate, receipts, context, state: () => ({ prompts, releaseCalled, sourceMirror }) }); }
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

for (const value of [
  { done: false, summary: null, decision: { action: 'continue', reason: 'More work' } },
  { done: false, summary: 1, decision: { action: 'continue', reason: 'More work' } },
  { done: false, summary: 'x'.repeat(2001), decision: { action: 'continue', reason: 'More work' } },
  { decision: { action: 'continue', reason: 'More work' } },
  { done: false },
  { done: false, extra: 'unknown', decision: { action: 'continue', reason: 'More work' } },
]) test(`summary normalization does not repair invalid schema ${JSON.stringify(value).slice(0, 90)}`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update }) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(value) } });
      return { stopReason: 'end_turn' };
    }));
    assert.equal(result.ok, false); assert.equal(result.diagnostic.stage, 'decision_schema');
    assert.equal(await readFile(join(ctx.candidate, 'calc.mjs'), 'utf8'), 'export const add=(a,b)=>a-b;');
    assert.equal((await readdir(ctx.receipts)).filter(name => name.startsWith('devin-result-')).length, 0);
  }));

for (const wrapper of ['plain', 'preamble', 'fence']) test(`invalid ${wrapper} final decision preserves staging without adopting or replaying`,
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 10000 }, () => fixture(async ctx => {
    const result = await runNativeDevin(ctx.defaults, ctx.dependencies(async ({ update, sourceMirror }) => {
      await writeFile(join(sourceMirror, 'calc.mjs'), 'untrusted draft');
      const json = '{"done":true,"decision":{"action":"publish","reason":"go"}}';
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: wrapper === 'preamble'
        ? `Complete.\n\n${json}` : wrapper === 'fence' ? `\`\`\`json\n${json}\n\`\`\`` : json } });
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
      await callbacks.onRequest('fs/write_text_file', { sessionId: 'fixture-s1', path: join(sourceMirror, 'calc.mjs'), content: 'export const add=(a,b)=>a+b;' });
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
