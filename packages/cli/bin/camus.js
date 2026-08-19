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
  if (r.error) console.error('camus: ' + r.error.message);   // e.g. bash not found — never exit 1 silently
  process.exit(r.status === null ? 1 : r.status);
}

function py(script, args) {
  // Prefer the INSTALLED copy (the frozen gate); fall back to package source.
  const installed = path.join(os.homedir(), '.claude', 'skills', 'camus', 'scripts', script);
  const src = fs.existsSync(installed)
    ? installed
    : path.join(ROOT, 'skills', 'camus', 'scripts', script);
  const r = spawnSync('python3', [src, ...args], { stdio: 'inherit' });
  if (r.error) console.error('camus: ' + r.error.message);   // e.g. python3 not found — never exit 1 silently
  process.exit(r.status === null ? 1 : r.status);
}

const HELP = `camus ${pkg.version} · a coding loop that proves every change

usage: npx camus-cli <command>

  install      copy skill + workflows into ~/.claude (frozen copy, not symlink)
  check        preflight: installed gate in sync with package? (run before any auto/feat run)
  auto-setup   opt-in: install the narrow scoped auto-mode profile (zero-click runs)
  env-check [repo]   is the repo runnable? node version / deps / verifier toolchain
  status [featId]    one-shot dashboard for a feat run: tasks, last steps, review rounds, steer
  watch [featId]     LIVE dashboard (interactive): auto-refreshing status with one-key
                       steering — [p]ause · [g]uidance · [c]lear note · [q]uit
  steer [...]        redirect a RUNNING feat at its next task boundary:
                       steer "<guidance>"        steer the next task
                       steer --task <id> "<g>"   steer one specific task
                       steer --pause             halt there (resumable) · --show · --clear
  reconcile [...]    landed a task's work BY HAND? tell camus, with evidence (no JSON surgery):
                       reconcile <taskId> --commit <sha>   sha must be ON the feat branch
                       options: --feat <id> · --repo <path> · --remove-worktree
  land [...]         a halt stranded PROVEN work (merge_failed/noop/failed)? authorize the
                     auto-land lane — no more state surgery:
                       land <taskId>             flips it to ready_to_merge; git must show
                                                 unmerged commits on the task branch
                       options: --proven done|done_with_findings · --feat <id> · --repo <path>
                               · --reason "<why>"   — then re-run the feat with the SAME args
  kernel [...]       deterministic hybrid control plane (models choose; code enforces):
                       kernel next <featId>       compact read-only next-action envelope
                       kernel task <featId>       materialize only the selected task contract
                       kernel dispatch <featId>   atomically mark selected task running + emit it
                       kernel prepare <featId>    checkout + env + baseline + receipt recovery
                       kernel usage <featId> ...  checkpoint monotonic tokens/retries/phase
  resume       list interrupted feat runs (canonical resumeArgs, JSON)
  retro        read-only run-history analytics over ~/.camus/reports: per-feat lines,
                 aggregates (status/posture mix, rounds, token p50/p90), evidence-gated
                 recommendations · --json emits just the aggregate
  canary       opt-in known-answer self-test of the local gate: builds a throwaway repo,
                 proves verify's RED verdict + GREEN head-binding hold end-to-end
                 (--review also exercises the codex reviewer — one small codex call)
  version      print version (also -v / --version)

per-run recipe (from your repo):
  npx camus-cli check
  export CAMUS_REPO_ROOT="$(pwd -P)"
  export CAMUS_VERIFY_CMD="<type-check && tests>"   # include TESTS, not just types
  claude --permission-mode auto
  # then: /camus-feat with your task list, or /camus-loop <one task>

upgrading (the gate is a FROZEN copy — updating npm alone is not enough):
  npm i -g camus-cli@latest   # or use npx camus-cli@latest below
  npx camus-cli check         # reports DRIFT (old gate) + auto-profile status
  npx camus-cli install       # re-freeze the new gate into ~/.claude
  npx camus-cli auto-setup    # re-run if check said the auto profile is outdated
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
  case 'status':
    py('status.py', rest);
    break;
  case 'watch':
    py('watch.py', rest);
    break;
  case 'steer':
    py('steer.py', rest);
    break;
  case 'reconcile':
    py('reconcile.py', rest);
    break;
  case 'land':
    py('land.py', rest);
    break;
  case 'kernel':
    py('feat_kernel.py', rest);
    break;
  case 'retro':
    py('retro.py', rest);
    break;
  case 'canary':
    py('canary.py', rest);
    break;
  case 'version':
  case 'v':
  case '-v':   // the `--` strip above turns `--version` into `version`, but leaves `-v` alone
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
