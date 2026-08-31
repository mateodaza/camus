import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CodexRpc } from './codex-rpc.mjs';

async function peer(t, source, onNotification) {
  const cwd = await mkdtemp(join(tmpdir(), 'camus-rpc-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const rpc = new CodexRpc({ command: process.execPath, args: ['-e', source], cwd, env: { PATH: process.env.PATH }, timeoutMs: 5000, onNotification });
  t.after(() => rpc.close()); return rpc;
}

test('RPC preserves split UTF-8 and JSON frames', async t => {
  const rpc = await peer(t, `process.stdin.once('data', data => { const req=JSON.parse(data);const bytes=Buffer.from(JSON.stringify({id:req.id,result:'café'})+'\\n');const split=bytes.indexOf(0xc3)+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),10); });`);
  assert.equal(await rpc.request('fixture'), 'café');
});

test('RPC refuses reverse authority requests, malformed frames and raw provider error bodies', async t => {
  for (const [response, expected] of [
    [JSON.stringify({ id: 1234, method: 'item/commandExecution/requestApproval', params: { secret: 'do-not-log' } }), /unsupported authority/],
    ['null', /Invalid native protocol/],
    [JSON.stringify({ id: 1, error: { message: 'do-not-log' } }), /request failed/],
  ]) {
    const rpc = await peer(t, `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(response + '\n')}));`);
    await assert.rejects(rpc.request('fixture'), error => expected.test(error.message) && !error.message.includes('do-not-log'));
  }
});

test('ACP mode serves only the explicitly installed bounded reverse handler', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'camus-rpc-acp-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const server = `let first=null,buf='';process.stdin.on('data',chunk=>{buf+=chunk;const lines=buf.split('\\n');buf=lines.pop();for(const line of lines){if(!line)continue;const msg=JSON.parse(line);if(!first){first=msg;if(msg.jsonrpc!==\"2.0\")process.exit(9);process.stdout.write(JSON.stringify({jsonrpc:\"2.0\",id:\"tool-1\",method:\"fs/read_text_file\",params:{sessionId:\"s\",path:\"safe.txt\"}})+'\\n');}else if(msg.id===\"tool-1\"){process.stdout.write(JSON.stringify({jsonrpc:\"2.0\",id:first.id,result:msg.result})+'\\n');}}});`;
  const calls = [];
  const rpc = new CodexRpc({ command: process.execPath, args: ['-e', server], cwd, env: { PATH: process.env.PATH }, timeoutMs: 5000,
    protocol: 'jsonrpc2', onRequest: async (method, params) => { calls.push([method, params.path]); return { content: 'bounded' }; } });
  t.after(() => rpc.close());
  assert.deepEqual(await rpc.request('fixture'), { content: 'bounded' });
  assert.deepEqual(calls, [['fs/read_text_file', 'safe.txt']]);
});

test('RPC timeout closes an unresponsive child without retaining stderr', async t => {
  const rpc = await peer(t, `process.stderr.write('do-not-log');setInterval(()=>{},1000);`);
  await assert.rejects(rpc.request('fixture', {}, 50), /timed out/);
  await rpc.close(); assert.ok(rpc.child.exitCode !== null || rpc.child.signalCode !== null);
});

test('host SIGKILL cleans native descendants even in a separate process group', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'camus-native-death-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const server = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdin.once('data',data=>process.stdout.write(JSON.stringify({id:JSON.parse(data).id,result:[process.pid,child.pid]})+'\\n'));setInterval(()=>{},1000);`;
  const source = `import {CodexRpc} from ${JSON.stringify(new URL('./codex-rpc.mjs', import.meta.url).href)};
    const rpc=new CodexRpc({command:process.execPath,args:['-e',${JSON.stringify(server)}],cwd:${JSON.stringify(cwd)},env:{PATH:process.env.PATH},timeoutMs:5000});console.log(JSON.stringify(await rpc.request('fixture')));`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  parent.stderr.resume();
  t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); });
  const pids = JSON.parse(String((await once(parent.stdout, 'data'))[0]));
  const exit = once(parent, 'exit'); parent.kill('SIGKILL'); await exit;
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    if (alive) try { process.kill(pid, 'SIGKILL'); } catch { /* only our test children */ }
    assert.equal(alive, false, 'host death must not strand the native executor or its tools');
  }
});
