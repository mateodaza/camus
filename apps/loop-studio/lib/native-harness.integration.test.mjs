import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeQwen, runNativeGrok } from './adapters/native-harness.mjs';

const enabled = process.platform === 'darwin' && process.env.CAMUS_NATIVE_HARNESS_PROBE === '1'
  && process.env.CAMUS_QWEN_CODE_BIN && process.env.CAMUS_GROK_BUILD_BIN;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('pinned Qwen Code and Grok Build complete through the isolated gateway', { skip: !enabled, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'camus-native-harness-e2e-')); t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate'), source = join(root, 'source'), receipts = join(root, 'receipts');
  for (const dir of [candidate, source, receipts, join(candidate, '.git')]) await mkdir(dir, { recursive: true });
  await writeFile(join(candidate, '.git', 'HEAD'), 'synthetic');
  const model = 'camus-native-selected'; const calls = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ model: body.model, maxTokens: body.max_tokens });
    const tools = body.tools ?? []; const prior = (body.messages ?? []).some(message => message.role === 'tool');
    let toolCalls, content = null;
    if (!prior) {
      const tool = tools.find(item => ['run_shell_command', 'run_terminal_command'].includes(item.function?.name));
      assert.ok(tool, 'native harness supplied a shell tool');
      const command = `${quote(process.execPath)} -e ${quote("require('fs').writeFileSync('native-proof.txt','isolated harness wrote this')")}`;
      toolCalls = [{ index: 0, id: 'call_write', type: 'function', function: { name: tool.function.name,
        arguments: JSON.stringify({ command, description: 'Write synthetic candidate proof.', timeout: 4000 }) } }];
    } else {
      const structured = tools.find(item => item.function?.name === 'structured_output');
      if (structured) toolCalls = [{ index: 0, id: 'call_final', type: 'function', function: { name: 'structured_output',
        arguments: JSON.stringify({ done: true, summary: 'Synthetic isolated harness completed.', decision: null }) } }];
      else content = JSON.stringify({ done: true, summary: 'Synthetic isolated harness completed.', decision: null });
    }
    const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 0 } };
    res.setHeader('content-type', 'text/event-stream');
    const base = { id: `fixture-${calls.length}`, object: 'chat.completion.chunk', created: 1, model };
    for (const chunk of [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(toolCalls ? { tool_calls: toolCalls } : { content }) }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }, { ...base, choices: [], usage }]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const backend = { name: 'fixture', kind: 'openai_compat', provider: 'fixture', auth: { kind: 'none' },
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1` };
  for (const [kind, run] of [['qwen', runNativeQwen], ['grok', runNativeGrok]]) {
    const result = await run({ prompt: 'Write the synthetic proof and return the exact final decision.', model, backend, expectedReported: [model],
      worktree: candidate, scratch: join(root, `${kind}-scratch`), receiptsDir: receipts, sourcePath: source, timeoutMs: 30000,
      remainingTokens: 1000 });
    assert.equal(result.ok, true, `${kind}: ${result.error}`); assert.equal(result.definitiveTurnEnd, true);
    assert.equal(JSON.parse(result.text).done, true); assert.equal(result.modelActual, `fixture:${model}`);
    assert.equal(await readFile(join(candidate, 'native-proof.txt'), 'utf8'), 'isolated harness wrote this');
    await rm(join(candidate, 'native-proof.txt'));
  }
  assert.ok(calls.length >= 4); assert.ok(calls.every(call => call.model === model));
  assert.ok(calls.every(call => Number.isSafeInteger(call.maxTokens) && call.maxTokens > 0 && call.maxTokens <= 1000));
});
