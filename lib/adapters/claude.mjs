// Claude maker adapter — headless Claude Code (`claude -p`) as the drafting
// model. Tool surface is an allowlist (WebSearch/WebFetch for research stages,
// nothing for planning); everything else is auto-denied in headless mode, so
// the maker can read the web but cannot touch the machine.

import { spawn } from 'node:child_process';
import { MODELS } from '../models.mjs';

const TIMEOUTS = { plan: 120_000, make: 540_000, fix: 420_000 };

function fail(error) {
  return { ok: false, error, text: null, costUsd: 0 };
}

export async function runClaude({ prompt, stage = 'make', cwd, signal, onTick }) {
  const tools = stage === 'plan' ? '' : 'WebSearch,WebFetch';
  const maxTurns = stage === 'plan' ? '1' : stage === 'fix' ? '12' : '20';

  // The model is always named explicitly — never the CLI's configured default.
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', maxTurns, '--strict-mcp-config', '--model', MODELS.maker.model];
  if (tools) args.push('--allowedTools', tools);

  const { exitCode, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => {
      if (!done) { done = true; clearTimeout(t); clearInterval(tick); resolve({ exitCode: code, stdout: out, stderr: err }); }
    };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(-2); }, TIMEOUTS[stage] ?? 540_000);
    const tick = setInterval(() => onTick?.(stage === 'plan' ? 'planning…' : 'drafting — researching sources…'), 8000);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish(-4); }, { once: true });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));
  });

  if (exitCode === -1) return fail('failed to spawn claude — is the Claude Code CLI installed and on PATH?');
  if (exitCode === -2) return fail(`claude ${stage} stage hit the ${Math.round((TIMEOUTS[stage] ?? 540_000) / 60000)} min timeout`);
  if (exitCode === -4) return fail('aborted by user');
  if (exitCode !== 0) return fail(`claude exited ${exitCode}: ${(stderr || stdout).slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    // Some versions prepend warnings; recover the trailing JSON object.
    const start = stdout.indexOf('{');
    try { data = JSON.parse(stdout.slice(start)); } catch { return fail(`unparseable claude output: ${stdout.slice(0, 200)}`); }
  }
  if (data.is_error) return fail(`claude reported an error: ${String(data.result).slice(0, 300)}`);
  const text = String(data.result ?? '').trim();
  if (!text) return fail('claude returned an empty result');
  return { ok: true, error: null, text, costUsd: Number(data.total_cost_usd) || 0 };
}
