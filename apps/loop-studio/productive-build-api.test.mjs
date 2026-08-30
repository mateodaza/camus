// Actual CLI + server + durable engine. Only the provider adapter boundary is
// replaced. No production test flag, no account credentials, no paid requests.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile), studio = dirname(fileURLToPath(import.meta.url));
const dir = await realpath(await mkdtemp(join(tmpdir(), 'camus-productive-api-')));
let server, worker;
try {
  const repo = join(dir, 'repo'); await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]); await writeFile(join(repo, 'README.md'), 'Fixture repository.\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const config = join(dir, 'models.json'), cache = join(dir, 'cache.json'), callsPath = join(dir, 'calls.jsonl');
  await writeFile(config, JSON.stringify({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'low' }, loop: { roundCap: 2 } }));
  await writeFile(cache, JSON.stringify({ models: [{ slug: 'gpt-5.6-luna', visibility: 'list' }] }));
  const target = pathToFileURL(join(studio, 'lib/adapters/registry.mjs')).href, loader = join(dir, 'providers.mjs');
  const source = `import { appendFile, writeFile } from 'node:fs/promises';
    export function resolveSeatAdapters(models, backends) { return {
      makerBackend: backends.maker, reviewerBackend: backends.reviewer,
      ...(models.maker.codeExecutor==='codex_native'?{nativeMaker:async({worktree,onNativeSession})=>{
        await appendFile(${JSON.stringify(callsPath)},JSON.stringify({role:'nativeMaker',model:models.maker.model})+'\\n');
        onNativeSession({version:'fixture',threadId:'fixture-session'});
        await writeFile(worktree+'/answer.txt','correct');
        return {ok:true,definitiveTurnEnd:true,usage:{total_tokens:10},text:JSON.stringify({actions:[],done:true,summary:'Ready.'})};
      }}:{}),
      maker: async ({prompt, signal, effort}) => {
        await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({role:'maker',model:models.maker.model,effort})+'\\n');
        if(prompt.includes('WAIT_FOR_STOP')) { await new Promise(r=>signal.aborted?r():signal.addEventListener('abort',r,{once:true})); return {ok:false,error:'interrupted'}; }
        const history=prompt.match(/Complete host action history[^\\n]*\\n(\\[.*\\])$/s);
        if(prompt.includes('ASK_FORMAT') && prompt.includes('Bound human answer: null')) return {ok:true,text:JSON.stringify({actions:[],done:false,decision:{action:'human',reason:'Choose the output format.'}})};
        return {ok:true,usage:{total_tokens:10},text:JSON.stringify(history?{actions:[],done:true}:{actions:[{type:'create',path:'answer.txt',expected_sha256:null,content:'correct'}],done:false})};
      }, reviewer: async({effort})=> {await appendFile(${JSON.stringify(callsPath)},JSON.stringify({role:'reviewer',model:models.reviewer.model,effort})+'\\n');return {ran:true,verdict:'APPROVED',findings:[],usage:{total_tokens:10}};}
    }; }`;
  await writeFile(loader, `export async function load(url,ctx,next){if(url===${JSON.stringify(target)})return {format:'module',shortCircuit:true,source:${JSON.stringify(source)}};return next(url,ctx);}`);
  const env = { ...process.env, HOME: join(dir, 'home'), ENGINE: 'live', OPEN: '0', PORT: '0', STUDIO_RUNS_DIR: join(dir, 'runs'), STUDIO_MODELS_FILE: config,
    STUDIO_CODEX_CACHE_FILE: cache, STUDIO_GRANDFATHER_DIR: join(dir, 'grandfather'), STUDIO_CAPABILITIES_DIR: join(dir, 'capabilities') };
  for (const name of Object.keys(env)) if (/api.?key|token|secret|password|credential|^CLAUDE_MODEL$|^CODEX_MODEL$|^CODEX_EFFORT$|^ROUND_CAP$/i.test(name)) delete env[name];
  let base, token;
  const start = async () => {
    server = spawn(process.execPath, ['--experimental-loader', loader, 'server.mjs'], { cwd: studio, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; server.stderr.on('data', x => { diagnostics = (diagnostics + x).slice(-3000); });
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server timeout')), 15_000);
      server.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics)); });
      server.stdout.on('data', x => { const port = String(x).match(/http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); } });
    });
    token = (await (await fetch(`${base}/api/status`)).json()).token;
  };
  const stopServer = async () => { const closed = once(server, 'exit'); server.kill('SIGTERM'); await closed; server = null; };
  const post = (path, body = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: JSON.stringify(body) });
  const state = async (id) => (await (await fetch(`${base}/api/runs/${id}/state`)).json());
  const waitStopped = async (id, wantedCalls) => {
    for (let i = 0; i < 150; i++) { const s = await state(id); if (!s.owned && s.usage?.calls >= wantedCalls && s.status !== 'running') { await new Promise(r => setTimeout(r, 75)); return s; } await new Promise(r => setTimeout(r, 30)); }
    throw new Error(`Run ${id} did not stop`);
  };
  const cli = async (args) => {
    try { return { code: 0, ...await exec(process.execPath, ['--experimental-loader', loader, 'code-build.mjs', ...args], { cwd: studio, env, timeout: 20000, maxBuffer: 2_000_000 }) }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const task = 'Implement the exact answer in this test project';
  const contract = 'Add answer.txt with correct and leave the source checkout untouched.';
  await start();
  const createdResponse = await post('runs', { goal: task, acceptanceContract: contract, lane: 'build', codeMode: 'independent', targetPath: repo, codeLimits: { maxCalls: 1 }, pairing: { maker: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'high' }, reviewer: { backend: 'claude', model: 'sonnet', effort: 'xhigh' } } });
  const created = await createdResponse.json(); assert.equal(createdResponse.status, 201, JSON.stringify(created));
  const parked = await waitStopped(created.id, 1); assert.equal(parked.question.kind, 'budget');
  const offline = JSON.parse((await cli(['--status', created.id, '--json'])).stdout); assert.equal(offline.usage.calls, 1);
  const sharedRunDir = join(env.STUDIO_RUNS_DIR, created.id);
  const beforeInspection = {
    metadata: await readFile(join(sharedRunDir, 'run.json')),
    checkpoint: await readFile(join(sharedRunDir, 'code-checkpoint.json')),
    calls: await readFile(callsPath, 'utf8'),
  };
  const parkedInspection = JSON.parse((await cli(['--inspect', created.id, '--json'])).stdout);
  assert.equal(parkedInspection.runId, created.id);
  assert.equal(parkedInspection.nextSafeAction.action, 'investigate_or_start_fresh');
  assert.equal(Object.hasOwn(parkedInspection.candidate, 'diff'), false);
  assert.deepEqual(await readFile(join(sharedRunDir, 'run.json')), beforeInspection.metadata);
  assert.deepEqual(await readFile(join(sharedRunDir, 'code-checkpoint.json')), beforeInspection.checkpoint);
  assert.equal(await readFile(callsPath, 'utf8'), beforeInspection.calls, 'Studio-created run inspection invokes no provider');
  const candidate = parked.candidate.worktree;
  await stopServer();
  const resumedCli = await cli(['--resume', created.id, '--max-calls', '5', '--json']);
  assert.equal(resumedCli.code, 2, resumedCli.stderr);
  const completed = JSON.parse(resumedCli.stdout);
  assert.equal(completed.completion, 'candidate_ready_for_acceptance', completed.error);
  assert.equal(completed.candidate.worktree, candidate); assert.equal(completed.usage.calls, 3);
  assert.equal(completed.models.maker.effort, 'high'); assert.equal(completed.models.reviewer.effort, 'xhigh');
  const completedInspection = JSON.parse((await cli(['--inspect', created.id, '--json'])).stdout);
  assert.equal(completedInspection.nextSafeAction.action, 'inspect_candidate_for_acceptance');
  assert.equal(completedInspection.review.status, 'approved');
  await start();
  const httpReport = await (await fetch(`${base}/api/runs/${created.id}/report`)).json();
  assert.equal(httpReport.models.maker.effort, 'high'); assert.equal(httpReport.models.reviewer.effort, 'xhigh');
  const replay = await (await fetch(`${base}/api/runs/${created.id}/events`)).text();
  assert.match(replay, /code_checkpoint/); assert.match(replay, /"canResume":false/); assert.doesNotMatch(replay, /"status":"running"/);
  const freshCli = await cli(['--task', task, '--contract', contract, '--repo', repo, '--max-calls', '1', '--json']);
  assert.equal(freshCli.code, 2, freshCli.stderr);
  const second = JSON.parse(freshCli.stdout); assert.equal(second.usage.calls, 1);
  const illegal = await post(`runs/${second.id}/resume`, { verifyCmd: 'true' }); assert.equal(illegal.status, 409);
  const resumedStudio = await post(`runs/${second.id}/resume`, { codeLimits: { maxCalls: 5 } });
  assert.equal(resumedStudio.status, 201, await resumedStudio.clone().text()); assert.equal((await resumedStudio.json()).id, second.id);
  const final = await waitStopped(second.id, 3); assert.equal(final.phase, 'complete'); assert.equal(final.candidate.worktree, second.candidate.worktree);
  const questionRun = await cli(['--task', `${task} ASK_FORMAT`, '--contract', contract, '--repo', repo, '--json']);
  const q = JSON.parse(questionRun.stdout); assert.equal(q.question.kind, 'judgment');
  const questionInspection = JSON.parse((await cli(['--inspect', q.id, '--json'])).stdout);
  assert.equal(questionInspection.nextSafeAction.action, 'answer_question');
  assert.equal(questionInspection.question.id, q.question.id);
  const unchanged = JSON.parse((await cli(['--resume', q.id, '--json'])).stdout);
  assert.match(unchanged.receiptPath, /report-\d+\.json$/, 'an unchanged resume reports its new immutable receipt, not stale report.json');
  const answered = await post(`runs/${q.id}/answer`, { questionId: q.question.id, answer: 'Plain text is required.' });
  assert.equal(answered.status, 201, await answered.clone().text()); assert.equal((await waitStopped(q.id, 4)).phase, 'complete');
  worker = spawn(process.execPath, ['--experimental-loader', loader, 'code-build.mjs', '--task', `${task} WAIT_FOR_STOP`, '--contract', contract, '--repo', repo, '--json'], { cwd: studio, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; worker.stdout.on('data', x => { output += x; }); worker.stderr.resume();
  let runningId;
  for (let i = 0; i < 150; i++) {
    const listing = (await (await fetch(`${base}/api/runs`)).json()).runs;
    runningId = listing.find(x => x.goal?.includes('WAIT_FOR_STOP'))?.id;
    if (runningId && (await state(runningId)).owned) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(runningId); assert.equal((await state(runningId)).owned, true);
  const activeInspection = JSON.parse((await cli(['--inspect', runningId, '--json'])).stdout);
  assert.equal(activeInspection.owned, true); assert.equal(activeInspection.nextSafeAction.action, 'attach_or_status');
  assert.equal((await state(runningId)).owned, true, 'concurrent inspection never disturbs the worker lease');
  const exited = once(worker, 'exit'); assert.equal((await post(`runs/${runningId}/stop`)).status, 200); await exited; worker = null;
  assert.equal(JSON.parse(output).status, 'stopped'); assert.equal((await state(runningId)).owned, false);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 11, 'reattachment/restart/status do not buy model calls');
  assert.deepEqual(calls.slice(0, 3).map(({ role, effort }) => ({ role, effort })), [
    { role: 'maker', effort: 'high' }, { role: 'maker', effort: 'high' }, { role: 'reviewer', effort: 'xhigh' },
  ], 'Studio start and CLI resume keep the same explicitly frozen effort snapshot');
  const nativePair = { maker: { backend: 'codex', model: 'gpt-5.6-luna', codeExecutor: 'codex_native' }, reviewer: { backend: 'claude', model: 'sonnet' } };
  const nativeBody = { goal: task, acceptanceContract: contract, lane: 'build', codeMode: 'independent', targetPath: repo, pairing: nativePair };
  assert.equal((await post('runs', nativeBody)).status, 400, 'native needs its first-call reservation before metadata/execution');
  assert.equal((await post('runs', { ...nativeBody, codeLimits: { maxTokens: 32767 } })).status, 400, 'an unusably small native budget refuses before metadata/execution');
  assert.equal((await post('runs', { ...nativeBody, codeLimits: { maxTokens: 100000 }, pairing: { ...nativePair, maker: { ...nativePair.maker, backend: 'claude', model: 'sonnet' } } })).status, 400);
  assert.equal((await post('runs', { ...nativeBody, lane: 'freeform', codeMode: undefined })).status, 400, 'words lanes must not silently discard native selection');
  const nativeResponse = await post('runs', { ...nativeBody, codeLimits: { maxTokens: 100000, maxCalls: 1 } });
  assert.equal(nativeResponse.status, 201, await nativeResponse.clone().text());
  const nativeCreated = await nativeResponse.json();
  const nativeParked = await waitStopped(nativeCreated.id, 1); assert.equal(nativeParked.question.kind, 'budget');
  const nativeDone = JSON.parse((await cli(['--resume', nativeCreated.id, '--max-calls', '5', '--json'])).stdout);
  assert.equal(nativeDone.completion, 'candidate_ready_for_acceptance', nativeDone.error);
  assert.equal(nativeDone.models.maker.codeExecutor, 'codex_native');
  assert.equal(nativeDone.candidate.worktree, nativeParked.candidate.worktree);
  const nativeCli = JSON.parse((await cli(['--task', task, '--contract', contract, '--repo', repo, '--maker', 'codex:gpt-5.6-luna', '--reviewer', 'claude:sonnet', '--maker-executor', 'codex_native', '--max-tokens', '100000', '--json'])).stdout);
  assert.equal(nativeCli.completion, 'candidate_ready_for_acceptance', nativeCli.error);
  const finalCalls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(finalCalls.filter(c => c.role === 'nativeMaker').length, 2, 'selected native executor used once per candidate, not replayed during resume');
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  console.log('Productive CLI/Studio: same-ID cross-surface continuation, inspect, restart, bound answers, ownership, stop, exact selected pair and offline status passed.');
  if (process.env.CAMUS_TEST_BROWSER === '1') {
    console.log(`Browser fixture: ${base} | repo: ${repo} | pid: ${process.pid}`);
    await once(process, 'SIGTERM');
  }
} finally {
  for (const child of [worker, server]) if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
  await rm(dir, { recursive: true, force: true });
}
