// npm includes the SAME modules Studio uses, not a second provider executor.
// Copy only source imports and an explicit public-data allowlist; never operator
// config, .env, runs, receipts, tests, or arbitrary application directories.
import { readFile, writeFile, mkdir, copyFile, lstat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const destination = join(packageRoot, 'runtime');
const marker = join(destination, '.camus-generated-runtime');
try {
  if (await readFile(marker, 'utf8') !== 'camus-code-runtime-v1\n') throw new Error('Refusing to replace an unrecognized runtime directory.');
  await rm(destination, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  try { await lstat(destination); throw new Error('Refusing to replace an unmarked runtime directory.'); }
  catch (check) { if (check.code !== 'ENOENT') throw check; }
}
const pending = [
  'apps/loop-studio/code-build.mjs',
  'apps/loop-studio/code-eval.mjs',
  'apps/loop-studio/fixtures/code-eval-v1/simple-bounded-parser-fix/fixture.json',
  'apps/loop-studio/package.json',
  'apps/loop-studio/checks/models.json',
  'apps/loop-studio/checks/registry.json',
  'apps/loop-studio/checks/review.schema.json',
  'packages/cli/skills/camus/control-register.v1.json',
];
const copied = new Set();
await mkdir(destination, { recursive: true });
await writeFile(marker, 'camus-code-runtime-v1\n');
while (pending.length) {
  const name = pending.shift();
  if (copied.has(name)) continue;
  if (!/^(apps\/loop-studio\/|packages\/trust\/lib\/|packages\/cli\/skills\/camus\/)/.test(name)
      || name.includes('..') || !/\.(mjs|json)$/.test(name) || name.endsWith('.test.mjs')) throw new Error(`Runtime import outside source allowlist: ${name}`);
  const source = join(repoRoot, name);
  if (!(await lstat(source)).isFile()) throw new Error(`Runtime source is not a regular file: ${name}`);
  const target = join(destination, name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  copied.add(name);
  if (!name.endsWith('.mjs')) continue;
  const code = await readFile(source, 'utf8');
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
    pending.push(relative(repoRoot, resolve(dirname(source), match[1])).split('\\').join('/'));
  }
}
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, files: [...copied].sort() }, null, 2)}\n`);
console.log(`Bundled ${copied.size} public source files for camus build.`);
