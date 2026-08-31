// Full HTTP selection/report path, with only provider execution replaced by a
// test-only Node loader. No production switch can bypass model execution.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath, rename, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'camus-independent-api-'));
let server;
try {
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'nested'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'README.md'), 'Synthetic source.\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const config = join(dir, 'models.json');
  await writeFile(config, JSON.stringify({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'low' }, loop: { roundCap: 2 } }));
  const cache = join(dir, 'cache.json');
  await writeFile(cache, JSON.stringify({ models: [{ slug: 'gpt-5.6-luna', visibility: 'list' }] }));
  const loader = join(dir, 'provider-loader.mjs');
  const target = pathToFileURL(join(studio, 'lib/code-seats.mjs')).href;
  const fake = `export { prepareCodeReceiptsDir, codeLimits } from ${JSON.stringify(target + '?real')};
  export async function runCodeSeats(args) {
    return {status:'needs_decision', candidate:{worktree:args.repoPath,head:'fixture',fingerprint:'fixture'},
      selected:{maker:args.seats.maker,reviewer:args.seats.reviewer},
      review:{ran:true,verdict:'APPROVED',findings:[]}, verification:null, advisory:true};
  }`;
  await writeFile(loader, `export async function load(url,ctx,next){if(url===${JSON.stringify(target)}) return {format:'module',shortCircuit:true,source:${JSON.stringify(fake)}};return next(url,ctx);}`);
  const env = { ...process.env, ENGINE: 'live', OPEN: '0', PORT: '0', STUDIO_RUNS_DIR: join(dir, 'runs'), STUDIO_MODELS_FILE: config,
    STUDIO_CODEX_CACHE_FILE: cache, STUDIO_GRANDFATHER_DIR: join(dir, 'grandfather'), STUDIO_CAPABILITIES_DIR: join(dir, 'capabilities') };
  for (const name of ['CLAUDE_MODEL', 'CODEX_MODEL', 'CODEX_EFFORT', 'ROUND_CAP']) delete env[name];
  server = spawn(process.execPath, ['--experimental-loader', loader, 'server.mjs'], { cwd: studio, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  server.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-2000); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15_000);
    server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${diagnostics}`)); });
    server.stdout.on('data', (chunk) => { const port = String(chunk).match(/http:\/\/localhost:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); } });
  });
  const token = (await (await fetch(`${base}/api/status`)).json()).token;
  const launch = (body) => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: JSON.stringify({
    goal: 'Implement the synthetic feature safely', acceptanceContract: 'Keep the source untouched and record both selected seats.', lane: 'build', codeMode: 'independent', targetPath: join(repo, 'nested'), ...body,
  }) });
  for (const pairing of [
    { maker: { backend: 'codex', model: 'gpt-5.6-luna' }, reviewer: { backend: 'claude', model: 'sonnet' } },
    { maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'claude', model: 'sonnet' } },
    { maker: { backend: 'grok', model: 'grok-4.6' }, reviewer: { backend: 'claude', model: 'sonnet' } },
  ]) {
    const response = await launch({ pairing, ...(pairing.maker.backend === 'grok' ? { codeLimits: { maxTokens: 32_768 } } : {}) });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    await (await fetch(`${base}/api/runs/${created.id}/events`)).text();
    let report;
    for (const delay of [0, 50, 100, 200, 400]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const receipt = await fetch(`${base}/api/runs/${created.id}/report`);
      report = await receipt.json();
      if (receipt.ok) break;
    }
    assert.equal(report.codeMode, 'independent');
    assert.equal(report.models.maker.backend, pairing.maker.backend);
    assert.equal(report.models.reviewer.backend, pairing.reviewer.backend);
    assert.equal(report.selected.maker.model, pairing.maker.model);
    assert.equal(report.targetPath, await realpath(repo), 'repo subdirectory normalizes to toplevel');
    assert.equal(report.evidencePack, null, 'advisory code never borrows an admitted-gate pack');
    assert.equal(report.statuses.audit, 'not_run', 'native admitted gate did not run');
    assert.equal(report.gating, false);
    assert.equal(report.status, 'needs_decision');
    const resume = await fetch(`${base}/api/runs/${created.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: '{}' });
    assert.equal(resume.status, 409, 'experimental candidate never falls into legacy replay');
  }
  assert.equal((await launch({ pairing: { maker: { backend: 'codex', model: 'not-offered' }, reviewer: { backend: 'claude', model: 'sonnet' } } })).status, 400);
  assert.equal((await launch({ modelRouting: 'automatic' })).status, 400);
  assert.equal((await launch({ publish: true })).status, 400);
  assert.equal((await launch({ codeMode: 'invented' })).status, 400);
  const sourceFiles = await readdir(repo);
  await rename(join(dir, 'runs'), join(dir, 'saved-runs'));
  await symlink(repo, join(dir, 'runs'));
  const contained = await launch({});
  assert.equal(contained.status, 400);
  assert.match((await contained.json()).error, /outside the source/);
  assert.deepEqual(await readdir(repo), sourceFiles, 'containment refuses before writing run metadata');
  console.log('Independent Build HTTP: reversed, same-model, and Grok subscription seats, root normalization, non-gating receipts, and replay refusal passed.');
} finally {
  if (server && server.exitCode === null) { const closed = once(server, 'exit'); server.kill('SIGTERM'); await closed; }
  await rm(dir, { recursive: true, force: true });
}
