#!/usr/bin/env node
/*
 * Camus CLI — thin dispatcher over the package's install.sh + gate scripts.
 * The bin entry gets the exec bit from npm automatically (no chmod dance),
 * and npm versioning gives the freeze/integrity story for free.
 *
 * Commands map 1:1 to the audited shell entrypoints — this file adds NO logic
 * of its own (the gate must stay reviewable in one place: install.sh).
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'install.sh');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').replace(/^--/, '');
const rest = argv.slice(1);

function sh(args) {
  const r = spawnSync('bash', [INSTALL, ...args], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function py(script, args) {
  // Prefer the INSTALLED copy (the frozen gate); fall back to package source.
  const installed = path.join(os.homedir(), '.claude', 'skills', 'camus', 'scripts', script);
  const src = fs.existsSync(installed)
    ? installed
    : path.join(ROOT, 'skills', 'camus', 'scripts', script);
  const r = spawnSync('python3', [src, ...args], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const HELP = `camus ${pkg.version} — the coding loop that can't grade its own homework

usage: npx camus <command>

  install      copy skill + workflows into ~/.claude (frozen copy, not symlink)
  check        preflight: installed gate in sync with package? (run before any auto/feat run)
  auto-setup   opt-in: install the narrow scoped auto-mode profile (zero-click runs)
  env-check [repo]   is the repo runnable? node version / deps / verifier toolchain
  resume       list interrupted feat runs (canonical resumeArgs, JSON)
  version      print version

per-run recipe (from your repo):
  npx camus check
  export CAMUS_REPO_ROOT="$(pwd -P)"
  export CAMUS_VERIFY_CMD="<type-check && tests>"   # include TESTS, not just types
  claude --permission-mode auto
  # then: /camus-feat with your task list, or /camus-loop <one task>
`;

switch (cmd) {
  case 'install':
    sh([]);
    break;
  case 'check':
    sh(['--check']);
    break;
  case 'auto-setup':
    sh(['--auto-setup']);
    break;
  case 'env-check':
    sh(['--env-check', rest[0] || process.cwd()]);
    break;
  case 'resume':
    py('resume_scan.py', rest);
    break;
  case 'version':
  case 'v':
    console.log(pkg.version);
    break;
  case 'help':
  case 'h':
    console.log(HELP);
    process.exit(0);
    break;
  default:
    if (argv.length) console.error(`camus: unknown command "${argv[0]}"\n`);
    console.log(HELP);
    process.exit(argv.length ? 1 : 0);
}
