// Distribution smoke: the npm tarball must contain the shared Studio code-seat
// runtime, but never local/operator state. This intentionally does not install
// dependencies or call a provider.

import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMP = await mkdtemp(join(tmpdir(), 'camus-code-runtime-test-'));

async function command(file, args, options = {}) {
  return execFile(file, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

try {
  await command(process.execPath, ['build-code-runtime.mjs'], { cwd: PACKAGE_ROOT });

  const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', TEMP], { cwd: PACKAGE_ROOT });
  const details = JSON.parse(packed.stdout);
  assert.equal(details.length, 1, 'npm pack must emit one tarball');
  const tarball = join(TEMP, details[0].filename);
  const unpacked = join(TEMP, 'unpacked');
  await mkdir(unpacked);
  await command('tar', ['-xzf', tarball, '-C', unpacked]);
  const installed = join(unpacked, 'package');

  const entries = (await command('tar', ['-tzf', tarball])).stdout.trim().split('\n').filter(Boolean);
  assert(entries.includes('package/runtime/apps/loop-studio/code-build.mjs'), 'tarball includes the shared build entry');
  assert(entries.includes('package/runtime/apps/loop-studio/lib/code-seats.mjs'), 'tarball includes the shared code-seat engine');
  assert(entries.includes('package/runtime/apps/loop-studio/lib/adapters/registry.mjs'), 'tarball includes the shared adapter registry');
  assert(entries.includes('package/runtime/apps/loop-studio/checks/models.json'), 'tarball includes the public model catalog');
  for (const entry of entries) {
    assert(!/(?:^|\/)\.env(?:\.|\/|$)/i.test(entry), `private env file leaked into tarball: ${entry}`);
    assert(!/(?:^|\/)(?:runs|receipts|fixtures)(?:\/|$)/i.test(entry), `runtime artifact leaked into tarball: ${entry}`);
    assert(!/\.test\.(?:mjs|js|json)$/i.test(entry), `test source leaked into tarball: ${entry}`);
    assert(!/(?:^|\/)(?:\.camus|\.claude|\.codex)(?:\/|$)/i.test(entry), `private config leaked into tarball: ${entry}`);
  }

  // Every stateful resolver gets a synthetic location. HOME is also isolated,
  // so an accidental fallback cannot read the operator's account/config state.
  const modelFile = join(TEMP, 'models.json');
  await cp(join(PACKAGE_ROOT, 'runtime', 'apps', 'loop-studio', 'checks', 'models.json'), modelFile);
  const env = {
    ...process.env,
    HOME: join(TEMP, 'home'),
    STUDIO_MODELS_FILE: modelFile,
    STUDIO_GRANDFATHER_DIR: join(TEMP, 'grandfather'),
    STUDIO_CODEX_CACHE_FILE: join(TEMP, 'codex-cache.json'),
  };
  const bin = join(installed, 'bin', 'camus.js');
  assert.equal(existsSync(resolve(installed, '../../apps/loop-studio/code-build.mjs')), false, 'extracted package has no source-checkout fallback');

  const help = await command(process.execPath, [bin, 'build', '--help'], { cwd: installed, env });
  assert.match(help.stdout, /independent maker\/reviewer coding \(experimental\)/);
  const listed = await command(process.execPath, [bin, 'models', '--json'], { cwd: installed, env });
  const catalog = JSON.parse(listed.stdout);
  for (const role of ['maker', 'reviewer']) {
    assert(Array.isArray(catalog[role]) && catalog[role].length > 0, `packed ${role} catalog is present`);
    assert(catalog[role].some((seat) => seat.backend === 'claude'), `packed ${role} catalog supports Claude`);
    assert(catalog[role].some((seat) => seat.backend === 'codex'), `packed ${role} catalog supports Codex`);
  }
  assert.equal(catalog.gating, false, 'packed catalog explicitly labels Build as non-gating');
  console.log('test_code_runtime.mjs: packed any-model runtime is isolated and executable');
} finally {
  await rm(TEMP, { recursive: true, force: true });
}
