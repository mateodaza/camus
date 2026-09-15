import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, chmod, symlink, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyDevinExecDenial } from './devin-native-context.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeProcess } from './native-process.mjs';
import { assertDevinModelSelection, validateDevinSession, inspectDevinUsage, createDevinProtocolObserver, classifyDevinToolFailure,
  DEVIN_NATIVE_MODEL } from './devin-native-protocol.mjs';
import { publicDevinDiagnostic, parseDevinDecisionText } from './devin-native-protocol.mjs';

test('reconciliation diagnostics expose only fixed host labels, never error text or paths', () => {
  for (const label of ['unsupported_tool', 'missing_target', 'overlapping_operations', 'target_changed',
    'approved_write_mismatch', 'inventory_mismatch', 'state_verification_failed', 'receipt_persistence_failed',
    'settlement_timeout', 'exec_policy_unavailable', 'exec_policy_metadata', 'exec_policy_changed',
    'exec_artifact_unavailable', 'exec_artifact_changed', 'exec_denial_absent']) {
    assert.equal(publicDevinDiagnostic({ stage: 'native_turn', reconciliationFailure: label }).reconciliationFailure, label);
  }
  const output = publicDevinDiagnostic({ stage: 'native_turn', reconciliationFailure: '/private/path secret-token', error: 'private error' });
  assert.equal(output.reconciliationFailure, undefined);
  assert.doesNotMatch(JSON.stringify(output), /private|secret-token/);
});
import { devinBudgetSnapshot, nativeBudgetPrompt } from './native-budget.mjs';

for (const fault of ['none', 'config', 'artifact', 'mode', 'symlink', 'hardlink', 'no_deny'])
  test(`host exec-denial evidence binds the configuration and binary: ${fault}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'camus-exec-policy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = join(root, 'config.json'), harness = join(root, 'harness');
    const configBytes = JSON.stringify({ permissions: { deny: fault === 'no_deny' ? [] : ['exec'], allow: [], ask: [] } });
    await writeFile(config, configBytes, { mode: 0o600 });
    await writeFile(harness, 'hermetic binary fixture');
    const artifactDigest = createHash('sha256').update('hermetic binary fixture').digest('hex');
    if (fault === 'config') await writeFile(config, configBytes.replace('exec', 'read'));
    if (fault === 'artifact') await writeFile(harness, 'different binary');
    if (fault === 'mode') await chmod(config, 0o644);
    if (fault === 'symlink') {
      const target = join(root, 'other'); await writeFile(target, configBytes, { mode: 0o600 });
      await rm(config); await symlink(target, config);
    }
    if (fault === 'hardlink') await link(config, join(root, 'alias'));
    const check = () => verifyDevinExecDenial({ config, configBytes, harness, artifactDigest });
    if (fault === 'none') {
      const proof = await check(); assert.equal(proof.policy, 'native-exec-denied/v1');
      assert.equal(proof.artifactDigest, artifactDigest); assert.match(proof.configHash, /^[a-f0-9]{64}$/);
    } else await assert.rejects(check, /execution/);
  });

test('native decision formatting accepts only whole JSON, one JSON fence or bounded plain-text preamble', () => {
  const value = { done: true, summary: 'Corrected.', decision: null }, json = JSON.stringify(value);
  for (const [text, normalization] of [[json, []], [`\n${json}\n`, []],
    [`\`\`\`json\n${json}\n\`\`\``, ['single_json_fence_removed']],
    [`All steps complete; the file was corrected to a+b.\n\n${json}`, ['leading_plaintext_removed']],
    [`Complete.\r\n\r\n${JSON.stringify(value, null, 2)}`, ['leading_plaintext_removed']]]) {
    const parsed = parseDevinDecisionText(text);
    assert.deepEqual(parsed.value, value); assert.deepEqual(parsed.normalizations, normalization);
  }
  for (const text of ['', 'null', '[]', `${json}\n${json}`, `${json}\nTrailing prose`,
    `Example: ${json}`, `Example\n${json}`, `{}\n\n${json}`, `text { braces }\n\n${json}`,
    `\`\`\`text\nexample\n\`\`\`\n\n${json}`, `Complete\n\n\`\`\`json\n${json}\n\`\`\``,
    `${'x'.repeat(2001)}\n\n${json}`, 'x'.repeat(65537), `Complete\n\n{"done":true`,
    `Complete\n\n${json}\n\n{"done":false}`]) assert.throws(() => parseDevinDecisionText(text), text.slice(0, 60));
  assert.deepEqual(parseDevinDecisionText('{"summary":"no defaults"}').value, { summary: 'no defaults' });
});

test('native pacing reserves headroom and reports time/low budgets without inventing SWE spend limits', () => {
  const base = { maximumActions: 64, maximumMs: 300000, usedActions: 47, elapsedMs: 10000 };
  assert.equal(devinBudgetSnapshot(base).wrapUp, false);
  const warning = devinBudgetSnapshot({ ...base, usedActions: 48 });
  assert.equal(warning.wrapUp, true); assert.equal(warning.remainingActions, 16);
  assert.equal(warning.internalModelCalls, null); assert.equal(warning.inferenceTokens, null);
  assert.equal(devinBudgetSnapshot({ ...base, elapsedMs: 225000 }).wrapUp, true);
  assert.equal(devinBudgetSnapshot({ ...base, elapsedMs: 400000 }).remainingMs, 0);
  assert.equal(devinBudgetSnapshot({ ...base, usedActions: 65 }).remainingActions, 0);
  assert.equal(devinBudgetSnapshot({ ...base, maximumActions: 1, usedActions: 0 }).wrapUp, true);
  const prompt = nativeBudgetPrompt({ actions: 22, timeoutMs: 5000, modelCalls: 2, remainingTokens: 4000, observedOnly: false });
  assert.match(prompt, /22;.*16 accounted/); assert.match(prompt, /5000 ms/); assert.match(prompt, /Model-call slice target: 2/);
  assert.match(prompt, /not a billing guarantee/);
});

test('public diagnostics allow only fixed labels and bounded counters, never arbitrary provider values', () => {
  const secret = 'synthetic-private-provider-text';
  const safe = publicDevinDiagnostic({ stage: 'native_turn', reason: secret, protocolStage: secret,
    stopReason: secret, observedTools: Infinity, hostRequests: -1, terminalReceived: true, cleanupConfirmed: true,
    text: secret, toolFailures: Array.from({ length: 40 }, () => ({ nativeTool: secret, categories: ['path_unavailable', secret] })) });
  assert.doesNotMatch(JSON.stringify(safe), /synthetic-private/);
  assert.equal(safe.reason, null); assert.equal(safe.observedTools, null); assert.equal(safe.hostRequests, null);
  assert.equal(safe.toolFailures.length, 16); assert.equal(publicDevinDiagnostic({ stage: secret }), null);
  assert.equal(publicDevinDiagnostic({ stage: 'native_turn', boundaryRefusal: { code: secret, tool: 'run_command' } }).boundaryRefusal, null);
  assert.deepEqual(publicDevinDiagnostic({ stage: 'native_turn', boundaryRefusal: {
    code: 'duplicate_request', tool: secret, arguments: secret,
  } }).boundaryRefusal, { code: 'duplicate_request', tool: null });
  const valid = publicDevinDiagnostic({ stage: 'native_turn', boundaryRefusal: { code: 'call_limit', tool: 'run_command' } });
  assert.deepEqual(publicDevinDiagnostic(valid), valid, 'CLI/Studio re-projection retains safe boundary evidence');
});
import { devinIsolatedEnvironment, devinIsolatedConfig, validateDevinLogin,
  renderDevinPreflightProfile, inspectDevinAcp } from './devin-native-preflight.mjs';

const modelOption = { category: 'model', id: 'model', currentValue: DEVIN_NATIVE_MODEL };
const opened = () => ({ sessionId: 'session-one', configOptions: [{ ...modelOption }], modes: { currentModeId: 'autonomous' } });
const event = update => ({ sessionId: 'session-one', update });

test('only host acknowledgement reconciles a failed tool; provider fields and error prose cannot', () => {
  const observer = createDevinProtocolObserver({ sessionId: 'session-one' });
  observer.observe('session/update', event({ sessionUpdate: 'tool_call', toolCallId: 'miss', status: 'failed',
    noEffectVerified: true, recovery: 'verified_no_effect', rawOutput: 'Nothing changed; safe to continue.' }));
  assert.equal(observer.finish({ stopReason: 'end_turn' }).toolsComplete, false);
  const checked = createDevinProtocolObserver({ sessionId: 'session-one' });
  checked.observe('session/update', event({ sessionUpdate: 'tool_call', toolCallId: 'miss', status: 'failed' }));
  checked.acknowledgeNoEffect('miss');
  checked.observe('session/update', event({ sessionUpdate: 'tool_call_update', toolCallId: 'miss', status: 'failed' }));
  const diagnostic = checked.diagnostics();
  assert.equal(diagnostic[0].recovery, 'verified_no_effect');
  const safe = publicDevinDiagnostic({ stage: 'native_turn', toolFailures: diagnostic });
  assert.equal(safe.toolFailures[0].recovery, 'verified_no_effect');
  assert.deepEqual(publicDevinDiagnostic(safe), safe);
  const result = checked.finish({ stopReason: 'end_turn' });
  assert.equal(result.toolsComplete, true); assert.equal(result.completedTools, 0);
});
const tool = (toolCallId, status = 'pending') => ({ sessionUpdate: 'tool_call', toolCallId, status });
const usage = (decorated = false) => ({ sessionUpdate: 'usage_update', used: 23273, size: 262000,
  _meta: { 'cognition.ai/inputTokens': 22879, 'cognition.ai/outputTokens': 394,
    'cognition.ai/cachedReadTokens': 22552,
    ...(decorated ? { 'cognition.ai/subagent_context': { parentAgentId: 'root' } } : {}) } });
const observer = options => createDevinProtocolObserver({ sessionId: 'session-one', ...options });

test('exact model selection is required but never called actual serving identity', () => {
  assert.equal(assertDevinModelSelection([modelOption]), DEVIN_NATIVE_MODEL);
  const result = validateDevinSession(opened());
  assert.equal(result.modelSelected, DEVIN_NATIVE_MODEL); assert.equal(result.modelActual, null);
  assert.equal(result.actualModelEvidence, 'unobserved'); assert(Object.isFrozen(result));
  for (const options of [undefined, [], [modelOption, modelOption], [{ ...modelOption, currentValue: 'swe-2' }],
    [{ ...modelOption, currentValue: 'fusion-swe' }], [{ ...modelOption, category: 'effort' }]])
    assert.throws(() => assertDevinModelSelection(options));
  assert.throws(() => validateDevinSession({ ...opened(), models: { currentModelId: 'swe-2-medium' } }));
  assert.throws(() => validateDevinSession({ ...opened(), sessionId: '' }));
  assert.throws(() => validateDevinSession({ ...opened(), modes: { currentModeId: 'dangerous' } }));
});

test('usage remains unknown for duplicate, decorated, invalid and last-inference receipts', () => {
  const subject = observer();
  for (const update of [usage(), usage(), usage(true), { ...usage(), _meta: { 'cognition.ai/inputTokens': -1 } }]) {
    const result = inspectDevinUsage(update);
    assert.equal(result.runUsage, null); assert.equal(result.providerCalls, null); assert.equal(result.cumulative, false);
    subject.observe('session/update', event(update));
  }
  const receipt = subject.finish({ stopReason: 'end_turn', usage: { totalTokens: 23273, inputTokens: 22879, outputTokens: 394 } });
  assert.equal(receipt.usageNotifications, 4); assert.equal(receipt.decoratedUsageNotifications, 1);
  assert.equal(receipt.usage, null); assert.equal(receipt.providerCalls, null); assert.equal(receipt.usageIncomplete, true);
  assert.equal(receipt.qualifiedCompletion, false); assert.equal(receipt.modelActual, null);
  assert.equal(inspectDevinUsage(usage()).countersValid, true);
  assert.equal(inspectDevinUsage({ _meta: { 'cognition.ai/inputTokens': Number.MAX_SAFE_INTEGER,
    'cognition.ai/outputTokens': 1 } }).countersValid, false);
});

test('tool observations require known identities, bounded counts and terminal status', () => {
  const subject = observer({ maxObservedTools: 2 });
  subject.observe('session/update', event(tool('read', 'completed')));
  subject.observe('session/update', event(tool('write', 'in_progress')));
  const result = subject.finish({ stopReason: 'end_turn' });
  assert.equal(result.observedTools, 2); assert.equal(result.completedTools, 1); assert.equal(result.toolsComplete, false);
  for (const updates of [
    [tool('same'), tool('same')], [tool('one'), tool('two')],
    [{ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' }],
    [tool('one', 'completed'), { sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'in_progress' }],
    [tool('one', 'invented')],
  ]) {
    const checked = observer({ maxObservedTools: 1 });
    assert.throws(() => updates.forEach(update => checked.observe('session/update', event(update))));
    assert.throws(() => checked.finish({ stopReason: 'end_turn' }));
  }
});

test('session/model/mode drift poisons the observation and cannot later finish successfully', () => {
  for (const [method, params] of [
    ['session/update', { sessionId: 'other', update: usage() }],
    ['_cognition.ai/turn_stats', { sessionId: 'other', responseDimensions: {} }],
    ['session/update', event({ sessionUpdate: 'config_option_update', configOptions: [{ ...modelOption, currentValue: 'other' }] })],
    ['session/update', event({ sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' })],
    ['session/update', event(null)],
  ]) {
    const subject = observer();
    assert.throws(() => subject.observe(method, params));
    assert.throws(() => subject.finish({ stopReason: 'end_turn' }));
  }
});

test('completion is one-shot, bounded UTF-8, and does not turn cancellation into success', () => {
  const subject = observer({ maxTextBytes: 4 });
  subject.observe('session/update', event({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'éé' } }));
  const result = subject.finish({ stopReason: 'cancelled' });
  assert.equal(result.text, 'éé'); assert.equal(result.endTurn, false); assert.equal(result.terminalReceived, true);
  assert.throws(() => subject.finish({ stopReason: 'end_turn' }));
  assert.throws(() => subject.observe('session/update', event(usage())));
  const tooLong = observer({ maxTextBytes: 3 });
  assert.throws(() => tooLong.observe('session/update', event({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'éé' } })));
  assert.equal(observer().finish({}).terminalReceived, false);
});

test('complete tools and end_turn are evidence, not an admitted native completion', () => {
  const subject = observer();
  subject.observe('session/update', event(tool('write')));
  subject.observe('session/update', event({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' }));
  subject.observe('session/update', event({ sessionUpdate: 'config_option_update', configOptions: [modelOption] }));
  subject.observe('_cognition.ai/turn_stats', { sessionId: 'session-one', responseDimensions: { fabricatedTokens: 0 } });
  const receipt = subject.finish({ stopReason: 'end_turn' });
  assert.equal(receipt.endTurn, true); assert.equal(receipt.toolsComplete, true);
  assert.equal(receipt.qualifiedCompletion, false); assert.equal(receipt.usage, null);
});

test('only post-tool completion text is a decision; progress keeps its cumulative byte budget', () => {
  const say = (subject, text) => subject.observe('session/update', event({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }));
  const subject = observer();
  say(subject, 'I will read the files.');
  subject.observe('session/update', event(tool('read', 'completed')));
  say(subject, 'Now I will make the changes.');
  subject.observe('session/update', event(tool('write')));
  subject.observe('session/update', event({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' }));
  say(subject, '{"done":true,"summary":');
  say(subject, '"Fixed.","decision":null}');
  const result = subject.finish({ stopReason: 'end_turn' });
  assert.equal(JSON.parse(result.text).done, true);
  assert.equal(result.progressTextBytes, Buffer.byteLength('I will read the files.Now I will make the changes.'));
  assert.equal(result.completionTextPolicy, 'after-last-tool/v1');

  const premature = observer();
  say(premature, '{"done":true,"summary":"Old","decision":null}');
  premature.observe('session/update', event(tool('later-write', 'completed')));
  assert.equal(premature.finish({ stopReason: 'end_turn' }).text, '', 'never reuse pre-tool approval');
  const bounded = observer({ maxTextBytes: 4 });
  say(bounded, '1234'); bounded.observe('session/update', event(tool('read', 'completed')));
  assert.throws(() => say(bounded, '5'), /text limit/);
  const ambiguous = observer();
  say(ambiguous, '{"done":false}{"done":true}');
  assert.throws(() => JSON.parse(ambiguous.finish({ stopReason: 'end_turn' }).text));
});

test('failed-tool diagnostics retain fixed categories, never native text or input secrets', () => {
  const privateValue = 'synthetic-private-value-do-not-persist';
  const result = classifyDevinToolFailure({ _meta: { 'cognition.ai/inferenceToolName': 'edit' },
    rawInput: { file_path: '/Users/private/credentials.toml', content: privateValue },
    content: [{ type: 'content', content: { type: 'text', text: `EPERM: unable to read metadata ${privateValue}` } }] });
  assert.equal(result.nativeTool, 'edit'); assert(result.categories.includes('permission_denied'));
  assert(result.categories.includes('metadata_or_symlink'));
  assert(!JSON.stringify(result).includes(privateValue)); assert(!JSON.stringify(result).includes('/Users'));
  assert.deepEqual(classifyDevinToolFailure({ rawOutput: privateValue }).categories, ['unclassified']);
  assert.deepEqual(classifyDevinToolFailure(null).categories, ['unclassified']);
});

test('failure diagnostics remain available after cancellation without accepting a terminal', () => {
  const subject = observer();
  subject.observe('session/update', event({ ...tool('edit'), kind: 'edit', _meta: { 'cognition.ai/inferenceToolName': 'edit' } }));
  subject.observe('session/update', event({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'failed',
    rawOutput: 'No such file or directory (os error 2)' }));
  assert.equal(subject.diagnostics()[0].nativeTool, 'edit');
  assert.deepEqual(subject.diagnostics()[0].categories, ['path_unavailable']);
  assert(Object.isFrozen(subject.diagnostics()));
  assert.equal(subject.finish({ stopReason: 'cancelled' }).qualifiedCompletion, false);
});

test('isolated environment is an allowlist, with no model/key/fallback/proxy inheritance', () => {
  const inherited = ['WINDSURF_API_KEY', 'DEVIN_API_KEY', 'DEVIN_MODEL', 'DEVIN_REFUSAL_FALLBACK',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const env = devinIsolatedEnvironment('/private/tmp/camus-unit');
  for (const key of inherited) assert(!Object.hasOwn(env, key));
  assert.equal(env.HOME, '/private/tmp/camus-unit/home'); assert.equal(env.DEVIN_SANDBOX, 'true');
  assert(Object.isFrozen(env));
  for (const root of ['/', '', '/tmp/../Users', 'relative']) assert.throws(() => devinIsolatedEnvironment(root));
  const config = devinIsolatedConfig();
  assert.equal(config.version, 1, 'pinned CLI must not migrate unversioned host policy at session/new');
  assert.equal(config.auto_update, false); assert.equal(config.subagents_enabled, false);
  assert.deepEqual(config.read_config_from, { cursor: false, windsurf: false, claude: false });
  assert.deepEqual(config.proxy, { mode: 'off' });
});

const login = () => Buffer.from('windsurf_api_key = "synthetic-test-login"\napi_server_url = "https://server.codeium.com"\ndevin_webapp_host = "app.devin.ai"\ndevin_api_url = "https://api.devin.ai"\n');
test('stored login schema refuses endpoint substitution, duplicate keys, sections and payload drift', () => {
  assert.equal(validateDevinLogin(login()), true);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(262145),
    Buffer.from(login().toString().replace('https://api.devin.ai', 'https://other.invalid')),
    Buffer.from(login().toString() + 'windsurf_api_key = "other"\n'),
    Buffer.from(login().toString() + '[custom]\n'),
    Buffer.from(login().toString().replace('"synthetic-test-login"', '""')),
    Buffer.from(login().toString() + 'fallback = "other"\n')]) assert.throws(() => validateDevinLogin(bytes));
});

test('inference process profile excludes candidate data and execution while isolating login scratch', () => {
  const params = { root: '/private/tmp/camus-preflight', harness: '/Users/operator/.local/bin/devin',
    candidate: '/private/tmp/camus-candidate', operatorHome: '/Users/operator' };
  const profile = renderDevinPreflightProfile(params);
  assert(profile.includes('(deny file-read-data (subpath "/private/tmp/camus-candidate"))'));
  assert(profile.includes('(allow process-exec (literal "/Users/operator/.local/bin/devin"))'));
  assert(!profile.includes('(allow process-fork)')); assert(profile.includes('(deny default)'));
  assert(profile.includes('(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))'));
  assert(!profile.includes('(allow mach-lookup)')); assert(!profile.includes('(allow network*)'));
  assert(!profile.includes('(allow file-write* (subpath "/private/tmp/camus-candidate")'));
  assert.throws(() => renderDevinPreflightProfile({ ...params, candidate: params.root + '/candidate' }));
  assert.throws(() => renderDevinPreflightProfile({ ...params, root: '/' }));
});

test('preflight RPC only initializes and opens an empty session, with host capabilities advertised', async () => {
  const requests = [];
  const rpc = { request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'devin-browser' }] };
    if (method === 'session/new') return opened();
    assert.fail('Unexpected inference/authority request');
  } };
  const result = await inspectDevinAcp(rpc, { candidate: '/private/tmp/candidate' });
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'session/new']);
  assert.deepEqual(requests[0].params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  assert.deepEqual(requests[1].params.mcpServers, []);
  assert.equal(result.promptsSent, 0); assert.equal(result.delegatedToolsProven, false); assert.equal(result.runAccountingProven, false);
});

test('preflight cancels before RPC and does not fall back from unsupported auth', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectDevinAcp({ request: () => assert.fail('Must not dispatch') }, { signal: controller.signal }));
  const requests = [];
  await assert.rejects(inspectDevinAcp({ request: async method => {
    requests.push(method); return { protocolVersion: 1, authMethods: [{ id: 'api-key' }] };
  } }));
  assert.deepEqual(requests, ['initialize']);
});

test('real macOS metadata variant permits stat, not contents/writes/private paths or execution',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-policy-test-')));
    const candidate = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-candidate-test-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'camus-devin-private-test-')));
    try {
      await writeFile(join(candidate, 'fixture.txt'), 'synthetic candidate', { flag: 'wx' });
      await writeFile(join(outside, 'private.txt'), 'synthetic private canary', { flag: 'wx' });
      const harness = await realpath(process.execPath);
      for (const candidateMetadata of [false, true]) {
      const profile = renderDevinPreflightProfile({ root, candidate, harness, candidateMetadata });
      const source = `const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');
const denied=e=>['EPERM','EACCES'].includes(e.code);
${candidateMetadata
  ? `a.equal(fs.lstatSync(${JSON.stringify(join(candidate, 'fixture.txt'))}).isFile(),true);
a.equal(fs.realpathSync.native(${JSON.stringify(join(candidate, 'fixture.txt'))}),${JSON.stringify(join(candidate, 'fixture.txt'))});
a.throws(()=>fs.accessSync(${JSON.stringify(join(candidate, 'fixture.txt'))},fs.constants.R_OK),denied);
a.throws(()=>fs.accessSync(${JSON.stringify(join(candidate, 'fixture.txt'))},fs.constants.W_OK),denied);`
  : `a.throws(()=>fs.lstatSync(${JSON.stringify(join(candidate, 'fixture.txt'))}),denied);`}
a.throws(()=>fs.lstatSync(${JSON.stringify(join(outside, 'private.txt'))}),denied);
a.throws(()=>fs.readFileSync(${JSON.stringify(join(candidate, 'fixture.txt'))}),denied);
a.throws(()=>fs.readFileSync(${JSON.stringify(join(outside, 'private.txt'))}),denied);
a.throws(()=>fs.writeFileSync(${JSON.stringify(join(candidate, 'escape.txt'))},'no'),denied);
a.throws(()=>cp.execFileSync('/bin/sh',['-c','exit 0'],{stdio:'ignore'}));
fs.writeFileSync(${JSON.stringify(join(root, 'owned-'))}+${JSON.stringify(String(candidateMetadata))},'owned',{flag:'wx'});
console.log('camus-devin-isolation-ok');`;
      const result = await runNativeProcess({ command: '/usr/bin/sandbox-exec',
        args: ['-p', profile, harness, '-e', source], cwd: root, env: devinIsolatedEnvironment(root),
        timeoutMs: 5000, maxBytes: 16384 });
      assert.equal(result.code, 0); assert.match(result.stdout, /camus-devin-isolation-ok/);
      }
    } finally {
      await rm(root, { recursive: true }); await rm(candidate, { recursive: true }); await rm(outside, { recursive: true });
    }
  });
