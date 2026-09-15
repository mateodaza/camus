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
      if(['native_prior_candidate_restored','native_prior_candidate_recovery_reserved'].includes(window) && event.type===window) kill();
      if(window==='auto_response_saved' && event.type==='call_response_saved' && event.id==='maker-2') kill();
      if(window==='auto_restored' && event.type==='native_prior_candidate_restored') kill();
      if(window==='auto_reserved' && event.type==='native_prior_candidate_recovery_reserved') kill();
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
  // Crash on either side of the new prior-candidate recovery reservation. The
  // refused mirror must never become input, and no recovery or call is doubled.
  const nativeChild = join(root, 'native-worker.mjs');
  await writeFile(nativeChild, `import {runCodeSeats} from ${JSON.stringify(pathToFileURL(join(here, 'code-seats.mjs')).href)};
    import {DEVIN_CODE_BACKEND} from ${JSON.stringify(pathToFileURL(join(here, 'devin-code-seat.mjs')).href)};
    import {DEVIN_NATIVE_DIGEST} from ${JSON.stringify(pathToFileURL(join(here, 'devin-native-protocol.mjs')).href)};
    import {readFile,writeFile,appendFile} from 'node:fs/promises'; import {join} from 'node:path';
    const root=process.argv[2];
    const result=await runCodeSeats({repoPath:join(root,'repo'),receiptsDir:join(root,'run'),task:'Finish the accepted draft safely',resume:process.argv[3]==='resume',
      seats:{maker:{backend:'devin',model:'swe-2-high',codeExecutor:'devin_native',observedBudgetConsent:'devin-observed/v1'},reviewer:{backend:'claude',model:'fixture'}},
      backendSnapshot:{maker:DEVIN_CODE_BACKEND,reviewer:{kind:'claude_cli',transport:'vendor_managed',provider:'anthropic'}},
      limits:{maxCalls:4,maxRecoveries:1,maxTokens:1000000},
      adapters:{maker:()=>{throw Error('No fallback')},nativeMaker:async args=>{
        const calls=await readFile(join(root,'calls'),'utf8').catch(()=> '');const turn=calls.split('maker').length;
        await appendFile(join(root,'calls'),'maker\\n');
        if(args.nativeSession!==null)throw Error('No session replay');
        await args.onNativeSession({executor:'devin_native',sessionId:'s'+turn,replayable:false,artifactDigest:DEVIN_NATIVE_DIGEST});
        if(turn===2)return {ok:false,uncertain:true,noModelCalled:false,usage:null,candidateQuiescent:false,failureCode:'devin_native_incomplete',
          ...(process.env.CAMUS_AUTO_RECOVERY==='true'?{recoveryDisposition:'discard_mirror_v1'}:{}),
          stagedDraft:{path:join(root,'refused-mirror'),adopted:false,replayAllowed:false},
          diagnostic:{stage:'native_turn',reason:process.env.CAMUS_STOP_REASON||'tool_failed',terminalReceived:false,cleanupConfirmed:true,protocolStage:'prompt',stopReason:null,rpcFailure:null,boundaryRefusal:null,
            toolFailures:[{nativeTool:'edit',categories:['unclassified']}]}};
        if(turn===3 && await readFile(join(args.worktree,'answer.txt'),'utf8')!=='accepted')throw Error('Accepted draft lost');
        await writeFile(join(args.worktree,'answer.txt'),turn===1?'accepted':'finished');
        return {ok:true,definitiveTurnEnd:true,candidateQuiescent:true,usage:null,text:JSON.stringify({actions:[],done:turn===3,summary:'Progress',decision:turn===1?{action:'continue',reason:'Finish remaining work'}:null})};
      },reviewer:async()=>({ran:true,verdict:'APPROVED',findings:[],usage:{total_tokens:5}})}});
    process.stdout.write(JSON.stringify(result));`);
  for (const reason of ['tool_failed', 'observed_tool_limit', 'deadline'])
  for (const window of ['native_prior_candidate_restored', 'native_prior_candidate_recovery_reserved', 'auto_response_saved', 'auto_restored', 'auto_reserved']) {
    const dir = join(root, reason + '-' + window), repo = join(dir, 'repo');
    await mkdir(repo, { recursive: true }); await mkdir(join(dir, 'run'));
    await writeFile(join(repo, 'README.md'), 'base\n');
    const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    await writeFile(join(dir, 'refused-mirror'), 'never adopt');
    const nativeRun = async (resume, crash = '') => {
      const proc = spawn(process.execPath, ['--experimental-loader', loader, nativeChild, dir, resume ? 'resume' : 'new'],
        { env: { ...process.env, CAMUS_CRASH_WINDOW: crash, CAMUS_AUTO_RECOVERY: String(window.startsWith('auto_')), CAMUS_STOP_REASON: reason }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = ''; proc.stdout.on('data', b => { output += b; }); proc.stderr.on('data', b => { errors += b; });
      const [code, signal] = await once(proc, 'exit');
      if (crash) { assert.equal(signal, 'SIGKILL', errors); return; }
      assert.equal(code, 0, errors); return JSON.parse(output);
    };
    if (window.startsWith('auto_')) await nativeRun(false, window);
    else {
      const seeded = await nativeRun(false); assert.equal(seeded.resumable, true); assert.equal(seeded.usage.calls, 2);
      await nativeRun(true, window);
    }
    assert.equal((await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').length, 2, 'crash precedes any fresh maker dispatch');
    const resumed = await nativeRun(true);
    assert.equal(resumed.completion, 'candidate_ready_for_acceptance', resumed.error);
    assert.equal(resumed.usage.recoveries, 1); assert.equal(resumed.usage.calls, 4); assert.equal(resumed.usage.retries, 0);
    assert.equal(await readFile(join(resumed.candidate.worktree, 'answer.txt'), 'utf8'), 'finished');
    assert.equal(await readFile(join(dir, 'refused-mirror'), 'utf8'), 'never adopt');
    console.log('ok - SIGKILL/restart SWE ' + reason + ' at ' + window);
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
