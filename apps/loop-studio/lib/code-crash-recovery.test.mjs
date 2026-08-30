import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { codeOwnedProcessCleanupStatus } from './code-owned-process-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-hard-crash-test-')));
const moduleUrl = pathToFileURL(join(here, 'code-run-state.mjs')).href;
try {
  const loader = join(root, 'crash-loader.mjs'), child = join(root, 'worker.mjs');
  const injected = `import * as real from ${JSON.stringify(moduleUrl + '?actual')};
    export * from ${JSON.stringify(moduleUrl + '?actual')};
    const kill = () => process.kill(process.pid, 'SIGKILL');
    export function saveCodeCheckpoint(dir,state) {
      if(process.env.CAMUS_CRASH_WINDOW==='response_before_save' && state.pendingCall?.response) kill();
      if(process.env.CAMUS_CRASH_WINDOW==='write_before_save' && state.phase==='apply' && state.actionIndex===1 && !state.pendingAction) kill();
      return real.saveCodeCheckpoint(dir,state);
    }
    export async function appendCodeEvent(dir,event) {
      await real.appendCodeEvent(dir,event);
      const window=process.env.CAMUS_CRASH_WINDOW;
      if(window==='call_started' && event.type==='call_started') kill();
      if(window==='response_saved' && event.type==='call_response_saved') kill();
      if(window==='write_started' && event.type==='action_started') kill();
      if(window==='write_saved' && event.type==='action_completed') kill();
    }`;
  await writeFile(loader, `export async function load(url,ctx,next){if(url===${JSON.stringify(moduleUrl)})return {format:'module',shortCircuit:true,source:${JSON.stringify(injected)}};return next(url,ctx);}`);
  await writeFile(child, `import {runCodeSeats} from ${JSON.stringify(pathToFileURL(join(here, 'code-seats.mjs')).href)};
    import {appendFile} from 'node:fs/promises'; import {join} from 'node:path';
    const root=process.argv[2]; const resume=process.argv[3]==='resume'; const kind=process.argv[4];
    const result=await runCodeSeats({repoPath:join(root,'repo'),receiptsDir:join(root,'run'),task:'Add the exact answer safely',
      seats:{maker:{backend:'fixture',model:'maker'},reviewer:{backend:'fixture',model:'reviewer'}}, resume,retryUncertain:resume,
      adapters:{ maker:async({prompt})=>{
        await appendFile(join(root,'calls'),'maker\\n');
        const match=prompt.match(/Complete host action history[^\\n]*\\n(\\[.*\\])$/s); const history=match?JSON.parse(match[1]):[];
        const add={type:'create',path:'answer.txt',content:'correct',expected_sha256:null};
        const backslash={type:'create',path:'nested\\\\answer.txt',content:'correct',expected_sha256:null};
        const sourceHash=${JSON.stringify(createHash('sha256').update('base\n').digest('hex'))};
        let action=kind==='delete'?{type:'delete',path:'README.md',expected_sha256:sourceHash}:kind==='replace'?{type:'replace',path:'README.md',old:'base',content:'changed',expected_sha256:sourceHash}:kind==='read'?{type:'read',path:'README.md'}:kind==='list'?{type:'list'}:kind==='backslash'?backslash:add;
        if(history.length) action=['read','list'].includes(kind)&&!history.some(step=>step.actions?.some(a=>a.type==='create'))?add:null;
        return {ok:true,text:JSON.stringify({actions:action?[action]:[],done:!action})};},
        reviewer:async()=>{await appendFile(join(root,'calls'),'reviewer\\n');return {ran:true,verdict:'APPROVED',findings:[]};} }});
    process.stdout.write(JSON.stringify(result));`);
  const run = async (dir, window, kind = 'write') => {
    const proc = spawn(process.execPath, ['--experimental-loader', loader, child, dir, window ? 'new' : 'resume', kind], {
      env: { ...process.env, STUDIO_GRANDFATHER_DIR: join(root, 'salt'), CAMUS_CRASH_WINDOW: window ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = ''; proc.stdout.on('data', x => { out += x; }); proc.stderr.on('data', x => { error += x; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    const [code, signal] = await once(proc, 'exit'); clearTimeout(timer);
    return { code, signal, out, error };
  };
  const cases = [
    ...['call_started', 'response_before_save', 'response_saved', 'write_started', 'write_before_save', 'write_saved'].map(window => ['create', window]),
    ...['read', 'list', 'replace', 'delete'].flatMap(kind => ['write_started', 'write_before_save', 'write_saved'].map(window => [kind, window])),
    ['backslash', 'write_before_save'],
  ];
  for (const [kind, window] of cases) {
    const dir = join(root, `${kind}-${window}`), repo = join(dir, 'repo'); await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]); await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    const killed = await run(dir, window, kind); assert.equal(killed.signal, 'SIGKILL', `${kind}/${window}: ${killed.error}`);
    const restarted = await run(dir, null, kind); assert.equal(restarted.code, 0, restarted.error);
    const result = JSON.parse(restarted.out);
    assert.equal(result.completion, 'candidate_ready_for_acceptance', `${window}: ${result.error}`);
    if (['create', 'replace', 'delete', 'backslash'].includes(kind)) assert.equal(result.usage.actions, 1, `${kind}/${window}: a known mutation must not be applied or counted twice`);
    else assert.equal(result.usage.actions, window === 'write_saved' ? 2 : 3, 'only non-durable read/list attempts may be repeated; known completion is reused');
    if (kind === 'delete') await assert.rejects(readFile(join(result.candidate.worktree, 'README.md')), /ENOENT/);
    else if (kind === 'replace') assert.equal(await readFile(join(result.candidate.worktree, 'README.md'), 'utf8'), 'changed\n');
    else if (kind === 'backslash') assert.equal(await readFile(join(result.candidate.worktree, 'nested', 'answer.txt'), 'utf8'), 'correct');
    else assert.equal(await readFile(join(result.candidate.worktree, 'answer.txt'), 'utf8'), 'correct');
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
    assert.equal(calls.length, ['read', 'list'].includes(kind) || window === 'response_before_save' ? 4 : 3, `${window}: known responses are reused`);
    if (['call_started', 'response_before_save'].includes(window)) assert.ok(result.attempts.some(x => x.possibleDuplicateBilling));
    else assert.equal(result.usage.retries, 0);
    console.log(`ok - SIGKILL/restart ${kind} at ${window}`);
  }
  // Hard death of the owner must not strand a test process with no deadline.
  const check = join(root, 'long-check.cjs'), pidFile = join(root, 'verifier.pid');
  await writeFile(check, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `import {createCodeVerifier} from ${JSON.stringify(pathToFileURL(join(here, 'code-seat-verify.mjs')).href)}; await createCodeVerifier(${JSON.stringify(`${process.execPath} ${check}`)}, {receiptsDir:${JSON.stringify(root)}})({worktree:${JSON.stringify(root)}});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  owner.stdout.resume(); owner.stderr.resume();
  let pid;
  for (let i = 0; i < 150; i++) { try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
  assert.ok(pid > 0); const closed = once(owner, 'exit'); owner.kill('SIGKILL'); await closed;
  let alive = true;
  for (let i = 0; i < 150; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(r => setTimeout(r, 10)); }
  if (alive) try { process.kill(pid, 'SIGKILL'); } catch { /* fixture cleanup */ }
  assert.equal(alive, false, 'verifier command survives neither parent SIGKILL nor its own deadline');
  let cleanup;
  for (let i = 0; i < 300; i++) {
    try { cleanup = codeOwnedProcessCleanupStatus(root); } catch { cleanup = null; }
    if (cleanup?.complete) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(cleanup?.complete, true, 'verifier supervisor records terminal cleanup before fixture removal');
  console.log('ok - verifier process group is cleaned after host SIGKILL');
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); }
