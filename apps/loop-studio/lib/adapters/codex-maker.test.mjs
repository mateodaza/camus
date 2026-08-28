// Hermetic argv regression for the independent-code Codex maker seat.  The
// temporary `codex` executable is a local stub; no account, network, or model
// invocation is involved.

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexMaker } from './codex.mjs';

const root = await mkdtemp(join(tmpdir(), 'camus-codex-maker-'));
const bin = join(root, 'bin');
const cwd = join(root, 'scratch');
const stub = join(bin, 'codex');
await mkdir(bin, { recursive: true });
await writeFile(stub, `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/argv.txt"
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then out="$2"; shift 2; continue; fi
  shift
done
printf '%s' '{"actions":[],"done":true}' > "$out"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
await chmod(stub, 0o755);
const previousPath = process.env.PATH;
process.env.PATH = `${bin}:${previousPath}`;
try {
  const result = await runCodexMaker({ prompt: 'return protocol JSON', model: 'synthetic-codex', effort: 'high', cwd });
  assert.equal(result.ok, true);
  const argv = (await readFile(join(cwd, 'argv.txt'), 'utf8')).split('\n');
  assert(argv.includes('model_reasoning_effort=high'), 'explicit independent-maker effort is passed to codex argv');
  assert(argv.includes('synthetic-codex'), 'explicit model remains pinned in argv');
  console.log('codex-maker.test.mjs: explicit maker effort reaches the hermetic Codex spawn argv');
} finally {
  process.env.PATH = previousPath;
  await rm(root, { recursive: true, force: true });
}
