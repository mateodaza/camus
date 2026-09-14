import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessDevinFilePermission, selectDevinOneTimePermission, mergeDevinPermissionTool } from './devin-acp-permission.mjs';
import { CodexRpc } from '../apps/loop-studio/lib/codex-rpc.mjs';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-permission-test-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const target = join(cwd, 'candidate.mjs');
  await writeFile(target, 'export const result = false;\n');
  const tool = { toolCallId: 'write_1', kind: 'edit',
    _meta: { 'cognition.ai/inferenceToolName': 'write' },
    rawInput: { file_path: target, content: 'export const result = true;\n' },
    content: [{ type: 'diff', path: target, oldText: 'old', newText: 'new' }] };
  return { cwd, target, tool };
}

test('native write without optional locations is allowed', async t => {
  assert.equal((await assessDevinFilePermission(await fixture(t))).allowed, true);
});
test('native edit with agreeing locations is allowed', async t => {
  const p = await fixture(t);
  p.tool._meta['cognition.ai/inferenceToolName'] = 'edit';
  p.tool.rawInput = { file_path: p.target, old_string: 'false', new_string: 'true' };
  p.tool.locations = [{ path: p.target }];
  assert.equal((await assessDevinFilePermission(p)).allowed, true);
});
test('outside, missing and conflicting path evidence is refused', async t => {
  const p = await fixture(t);
  for (const patch of [
    { rawInput: { content: 'x' } },
    { rawInput: { file_path: join(p.cwd, 'tests.mjs'), content: 'x' } },
    { locations: [{ path: '/tmp/not-the-approved-file' }] },
    { locations: null },
    { content: [{ type: 'diff', path: '/tmp/not-the-approved-file' }] },
  ]) assert.equal((await assessDevinFilePermission({ ...p, tool: { ...p.tool, ...patch } })).allowed, false);
});
test('native tool kind, arguments and size are validated', async t => {
  const p = await fixture(t);
  for (const patch of [
    { kind: 'execute' }, { _meta: {} }, { toolCallId: '' }, { rawInput: null },
    { rawInput: { file_path: p.target, content: 'x', command: 'arbitrary' } },
    { rawInput: { file_path: p.target, content: 'x'.repeat(17000) } },
  ]) assert.equal((await assessDevinFilePermission({ ...p, tool: { ...p.tool, ...patch } })).allowed, false);
  assert.equal((await assessDevinFilePermission({ ...p, cwd: 'relative' })).allowed, false);
});
test('symlink and hardlink targets are refused', async t => {
  const p = await fixture(t), alias = join(p.cwd, 'alias.mjs');
  await symlink(p.target, alias);
  assert.equal((await assessDevinFilePermission({ ...p, target: alias,
    tool: { ...p.tool, content: [], rawInput: { file_path: alias, content: 'x' } } })).allowed, false);
  await link(p.target, join(p.cwd, 'hardlink.mjs'));
  assert.equal((await assessDevinFilePermission(p)).allowed, false);
});
test('permission is bound to one session, one request and allow_once', () => {
  const params = { sessionId: 'session', toolCall: { toolCallId: 'write_1' },
    options: [{ kind: 'allow_always', optionId: 'broad' }, { kind: 'allow_once', optionId: 'one' }] };
  const input = { expectedSessionId: 'session', params, assessment: { allowed: true }, seen: new Set() };
  assert.deepEqual(selectDevinOneTimePermission(input), { outcome: { outcome: 'selected', optionId: 'one' } });
  assert.deepEqual(selectDevinOneTimePermission(input), { outcome: { outcome: 'cancelled' } });
  for (const patch of [
    { expectedSessionId: 'other' }, { expectedSessionId: '' }, { assessment: { allowed: false } },
    { params: { ...params, options: [{ kind: 'allow_always', optionId: 'broad' }] } },
  ]) assert.deepEqual(selectDevinOneTimePermission({ ...input, seen: new Set(), ...patch }), { outcome: { outcome: 'cancelled' } });
});

test('known native edit with omitted/null ACP status reaches the fixed-file permission check', async t => {
  const p = await fixture(t);
  for (const patch of [{ toolCallId: p.tool.toolCallId }, { toolCallId: p.tool.toolCallId, status: null, kind: null, rawInput: null }]) {
    const tool = mergeDevinPermissionTool(p.tool, patch);
    assert.equal(tool.status, 'pending');
    assert.equal(tool.kind, 'edit'); assert.equal(tool.rawInput, p.tool.rawInput);
    const assessment = await assessDevinFilePermission({ ...p, tool });
    assert.equal(assessment.allowed, true);
    const response = selectDevinOneTimePermission({ expectedSessionId: 'session', seen: new Set(), assessment,
      params: { sessionId: 'session', toolCall: patch, options: [{ kind: 'allow_once', optionId: 'one' }] } });
    assert.equal(response.outcome.outcome, 'selected');
  }
});

test('permission updates cannot reopen terminal tools or borrow another tool identity', async t => {
  const { tool } = await fixture(t);
  for (const status of ['completed', 'failed', 'invalid']) {
    assert.equal(mergeDevinPermissionTool({ ...tool, status }, { toolCallId: tool.toolCallId, status: 'pending' }), null);
    assert.equal(mergeDevinPermissionTool(tool, { toolCallId: tool.toolCallId, status }), null);
  }
  assert.equal(mergeDevinPermissionTool(undefined, tool), null);
  assert.equal(mergeDevinPermissionTool(tool, { toolCallId: 'other' }), null);
  assert.equal(mergeDevinPermissionTool({ ...tool, status: 'in_progress' }, { toolCallId: tool.toolCallId }).status, 'in_progress');
});

test('real RPC transport accepts an omitted-status fixture permission once and refuses replay', { timeout: 10000 }, async t => {
  const p = await fixture(t);
  const source = `const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let requestId,first;
const permission=id=>send({id,method:'session/request_permission',params:{sessionId:'fixture-session',
toolCall:{toolCallId:'write_1',status:null},options:[{kind:'allow_always',optionId:'broad'},{kind:'allow_once',optionId:'one'}]}});
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='fixture') {requestId=m.id; send({method:'session/update',params:{sessionId:'fixture-session',
update:{sessionUpdate:'tool_call',...${JSON.stringify(p.tool)}}}}); permission(101);}
else if(m.id===101) {first=m.result;permission(102);}
else if(m.id===102) send({id:requestId,result:{first,second:m.result}});
});`;
  let prior; const seen = new Set(); let requests = 0;
  const rpc = new CodexRpc({ command: process.execPath, args: ['-e', source], cwd: p.cwd,
    env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, protocol: 'jsonrpc2',
    onNotification(method, params) {
      assert.equal(method, 'session/update'); assert.equal(params.sessionId, 'fixture-session');
      prior = params.update;
    },
    async onRequest(method, params) {
      requests++; assert.equal(method, 'session/request_permission');
      const tool = mergeDevinPermissionTool(prior, params.toolCall);
      const assessment = await assessDevinFilePermission({ ...p, tool });
      return selectDevinOneTimePermission({ expectedSessionId: 'fixture-session', params, assessment, seen });
    },
  });
  try {
    const result = await rpc.request('fixture', {}, 4000);
    assert.deepEqual(result.first, { outcome: { outcome: 'selected', optionId: 'one' } });
    assert.deepEqual(result.second, { outcome: { outcome: 'cancelled' } });
    assert.equal(requests, 2); assert.equal(seen.size, 1);
  } finally { await rpc.close(); }
  assert.notEqual(rpc.child.exitCode, null);
});
