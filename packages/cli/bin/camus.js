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

function codeBuild(args) {
  const source = path.resolve(ROOT, '../../apps/loop-studio/code-build.mjs');
  const bundled = path.join(ROOT, 'runtime/apps/loop-studio/code-build.mjs');
  const entry = fs.existsSync(source) ? source : bundled;
  if (!fs.existsSync(entry)) {
    console.error('camus build: this package is missing its shared model runtime. Reinstall the release; no model was called.');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  if (r.error) console.error('camus build: ' + r.error.message);
  process.exit(r.status === null ? 1 : r.status);
}

const HELP = `camus ${pkg.version} · a coding loop that proves every change

usage: npx camus-cli <command>

  build [...]  any-model coding candidate: choose BOTH --maker backend:model and
               --reviewer backend:model, including reversed/same-provider pairs.
               Shared Studio catalog and connections; isolated worktree, advisory
               review, human acceptance required. No automatic merge/publication.
               build --help · build --models · --task "..." --contract "..."
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
                       kernel seats <featId> ...  pin next-task seats without rerunning baseline
                       kernel accept <featId> <taskId> --result-file <path>
                                                  validate result/reviewer/Git/verify evidence
                       kernel land <featId> <taskId>
                                                  merge an accepted task without a model turn
                       kernel integrate <featId>  env/receipt recheck + final HEAD-bound verify
                       kernel open <featId> <taskId>
                                                  create/reattach the direct task worktree
                       kernel maker-usage <featId> <taskId> --result-file <path>
                                                  bind direct maker metrics without mixing units
                       kernel review <featId> <taskId>
                                                  run one bound reviewer with no model relay
                       kernel seal <featId> <taskId> [--fixed-unreviewed]
                                                  deterministic commit + HEAD-bound verify
  start <spec.json>  initialize a native feature run without spending a model turn
  run <featId>       drive it with durable Claude background makers + direct independent review
                       --experiment <json> assigns model pairings and records quality/cost/latency
                       --shadow-reviewer-backend <profile> --shadow-reviewer-model <id>
                                                  evaluates Grok/Qwen/open-weight on the same diff;
                                                  Codex still performs the final gate
                       --direct-output-reserve <n> reserves direct-output runway before maker/fix
                                                  (0 disables the reserve; not a hard cap)
                       --human-action <action> resumes a durable native controller handoff
  eval [--json]      per-arm coverage/A/B report segmented by experiment id, configHash, task class
                       --config <json> supplies a generation's qualityFloor/minimumTrials so a
                       leader may be named (repeatable); --experiment <id> filters to one experiment;
                       --task-class <name> filters observed rows AND config context to one scenario
  benchmark [...]    Slice G append-only reviewer campaign (only explicit bounded run calls providers):
                       plan --candidate-backend <profile> --candidate-model <id> ...
                                                  freezes corpus/baseline/candidate at zero spend
                       status --campaign <json> --state <json> --ledger <jsonl>
                                                  reports resumable quality + kill-path coverage
                       run --max-cells <n> ...      bounded live provider cells, sealed one by one
                       kill --max-cells <n> ...     spend-free watchdog/normalizer/identity controls
                       recover --action seal-infra ...
                                                  closes an interrupted cell before further spend
                       append --campaign <json> --ledger <jsonl> --receipt <json>
                       summarize --campaign <json> --ledger <jsonl> [--out <json>] [--json]
                       admission-proposal ...      validates evidence + real-human calibration;
                                                  checked-in reviewed registry change still required
                       admission-activate --admission-id <admit1:...>
                                                  network-free local activation after that reviewed entry ships
  models [--json]    list the shared Studio maker AND reviewer catalog and availability;
                       --reviewers-only preserves the legacy external-review profile list
  trial-review [...] run one explicitly non-gating external-model review of a Camus worktree:
                       --backend <profile> --model <id> --worktree <path> --task "<contract>"
                       emits trial1 evidence; Codex remains the final gate
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
  camus start feature.json                           # model-free initialization
  camus run <featId>                                 # durable maker + direct review
  # compatibility/rollback: /camus-feat or /camus-loop from an interactive Claude session

upgrading (the gate is a FROZEN copy — updating npm alone is not enough):
  npm i -g camus-cli@latest   # or use npx camus-cli@latest below
  npx camus-cli check         # reports DRIFT (old gate) + auto-profile status
  npx camus-cli install       # re-freeze the new gate into ~/.claude
  npx camus-cli auto-setup    # re-run if check said the auto profile is outdated
`;

switch (cmd) {
  case 'build':
    codeBuild(rest);
    break;
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
  case 'start':
    py('drive.py', ['start', ...rest]);
    break;
  case 'run':
    py('drive.py', ['run', ...rest]);
    break;
  case 'eval':
  case 'evals':
    py('evals.py', rest);
    break;
  case 'benchmark':
    py(['admission-proposal', 'admission-activate'].includes(rest[0]) ? 'reviewer_admission.py'
      : ['plan', 'status', 'run', 'kill', 'recover'].includes(rest[0]) ? 'benchmark_live.py' : 'benchmark_reviewers.py',
    rest[0] === 'admission-proposal' ? ['proposal', ...rest.slice(1)]
      : rest[0] === 'admission-activate' ? ['activate', ...rest.slice(1)] : rest);
    break;
  case 'models':
    if (rest.includes('--reviewers-only')) py('model_trials.py', ['list', ...rest.filter((arg) => arg !== '--reviewers-only')]);
    else codeBuild(['--models', ...rest]);
    break;
  case 'trial-review':
    py('model_trials.py', ['review', ...rest]);
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
