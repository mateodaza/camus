#!/usr/bin/env node
// One-cell native harness smoke runner. It reuses the shared Build engine and
// deliberately has no comparison, ranking, routing, admission, or publication authority.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSharedTunnelManager } from './lib/ssh-tunnel.mjs';
import { planCodeEval, recoverCodeEval, runCodeEval, statusCodeEval } from './lib/code-eval-runner.mjs';
import { codeEvalFixturePath, codeEvalFixtureReadiness } from './lib/code-eval-fixture.mjs';
import { redactCodeText, diagnosticSecrets } from './lib/code-diagnostics.mjs';

export const CODE_EVAL_HELP = `camus code-eval — one bounded native-harness execution smoke (experimental)

  camus code-eval plan --campaign campaign.json --state state.json --ledger receipts.jsonl [--json]
  camus code-eval fixture [--case case-id] [--json]
  camus code-eval status --campaign campaign.json --state state.json --ledger receipts.jsonl [--json]
  camus code-eval run --allow-provider-calls --max-cells 1 \
      --campaign campaign.json --state state.json --ledger receipts.jsonl [--json]
  camus code-eval recover --action seal-infra \
      --campaign campaign.json --state state.json --ledger receipts.jsonl [--json]

Fixture, plan, status, and recovery make no provider calls. Fixture prints the
exact tracked base-red/reference-green bindings needed by a campaign. Run requires fresh literal
consent and can attempt exactly one frozen native-smoke cell. An uncertain cell
is never replayed. This command cannot compare models, name a winner, change
routing/admission/settings, commit, merge, push, or publish.
`;

export function parseCodeEvalArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('code-eval arguments must be an array.');
  const command = argv[0];
  if (!command || ['help', '-h', '--help'].includes(command)) return { command: 'help' };
  if (!['fixture', 'plan', 'status', 'run', 'recover'].includes(command)) throw new Error(`Unknown code-eval operation: ${command}`);
  const valued = new Set(['campaign', 'state', 'ledger', 'max-cells', 'action', 'case']);
  const flags = new Set(['allow-provider-calls', 'json']);
  const options = { command };
  for (let index = 1; index < argv.length; index++) {
    const raw = argv[index];
    if (!raw.startsWith('--')) throw new Error(`Unknown code-eval option: ${raw}`);
    const name = raw.slice(2);
    if (!valued.has(name) && !flags.has(name)) throw new Error(`Unknown code-eval option: ${raw}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (flags.has(name)) options[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      options[name] = value;
    }
  }
  if (command === 'fixture') {
    if (Object.keys(options).some(name => !['command', 'json', 'case'].includes(name))) throw new Error('code-eval fixture accepts only --case and --json.');
    return options;
  }
  if (options.case) throw new Error(`code-eval ${command} does not accept --case.`);
  for (const name of ['campaign', 'state', 'ledger']) if (!options[name]) throw new Error(`--${name} is required.`);
  if (command === 'run') {
    if (options['allow-provider-calls'] !== true) throw new Error('code-eval run requires literal --allow-provider-calls consent; no provider was called.');
    if (options['max-cells'] !== '1') throw new Error('v1a code-eval run requires --max-cells 1; no provider was called.');
  } else if (options['allow-provider-calls'] || options['max-cells']) throw new Error(`code-eval ${command} does not accept provider-call authority.`);
  if (command === 'recover') {
    if (options.action !== 'seal-infra') throw new Error('v1a recovery requires --action seal-infra.');
  } else if (options.action) throw new Error(`code-eval ${command} does not accept --action.`);
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseCodeEvalArgs(argv);
  if (options.command === 'help') { console.log(CODE_EVAL_HELP); return 0; }
  if (options.command === 'fixture') {
    const root = options.case ? codeEvalFixturePath(options.case, dependencies.fixtureRoot) : undefined;
    const result = await (dependencies.fixtureReadiness ?? codeEvalFixtureReadiness)(root);
    console.log(JSON.stringify(result, null, 2));
    return result.ready === true && result.providerCallsMade === 0 ? 0 : 1;
  }
  const paths = { campaignPath: resolve(options.campaign), statePath: resolve(options.state), ledgerPath: resolve(options.ledger) };
  const result = options.command === 'plan' ? await planCodeEval(paths, dependencies)
    : options.command === 'status' ? await statusCodeEval(paths, dependencies)
      : options.command === 'run' ? await runCodeEval({ ...paths, consent: true, maxCells: 1 }, dependencies)
        : await recoverCodeEval({ ...paths, action: 'seal-infra' }, dependencies);
  console.log(JSON.stringify(result, null, options.json ? 2 : 2));
  return result.ok === false || result.standing === 'unknown' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`camus code-eval: ${redactCodeText(error.message || error, { secrets: diagnosticSecrets() }).slice(0, 600)}`);
    process.exitCode = 1;
  }).finally(() => getSharedTunnelManager().close());
}
