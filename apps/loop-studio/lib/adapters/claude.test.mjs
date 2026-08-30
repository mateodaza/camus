// Task 9 isolation acceptance test for the Claude adapter's spawn contract.
// This is the green proof that justifies flipping identity.mjs's
// REDIRECT_ISOLATION.claude_cli to true: BOTH entry points (runClaude maker,
// runClaudeReview reviewer) spawn `claude` with claudeDirectEnv() — a fresh,
// default-deny environment — and an argv that always carries an empty
// --setting-sources. The security contract is documented at
// https://code.claude.com/docs/en/env-vars (routing/auth/model vars),
// https://code.claude.com/docs/en/team (gateway/proxy auth), and
// https://code.claude.com/docs/en/cli-usage (--setting-sources / --strict-mcp-config).
//
// The proof is not a pure-helper assertion: a REAL fake `claude` binary is put
// on PATH, each entry point is spawned through the actual adapter, and the child
// records — for the SAME planted parent environment — which env NAMES it can
// see plus the non-secret auto-memory constant and its argv. It records only
// PRESENCE for credential/redirect names, never their values. Each entry point
// is break-on-purpose-proven by contrasting the isolated adapter spawn against a
// live UNISOLATED control spawn of the same binary that inherits the planted
// parent env: the control proves the redirect names WOULD be visible, the
// adapter proves they were stripped.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runClaude, runClaudeReview, claudeDirectEnv, claudeFailureDiagnostic } from './claude.mjs';
import { seatIdentityFacts } from '../models.mjs';
import { consultClaudeRoute } from '../grandfather.mjs';
import { codeOwnedProcessCleanupStatus } from '../code-owned-process-registry.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; if (process.env.VERBOSE) console.log('  ok', name); };

// Never paste secret-shaped literals: assemble every fake value from fragments.
const frag = (...parts) => parts.join('-');

// The credential pass-set: subscription automation auth is allowed for the
// vendor-managed seat. Direct pay-per-use API auth is intentionally absent so
// it cannot silently override the operator's Claude Code / Max login.
const PASS_CREDS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
];

// The routing/control set that MUST be absent from every isolated spawn. Any one
// of these could silently re-point the seat away from Camus's chosen provider:
// gateway bearer auth, every documented *_BASE_URL, the provider USE_* switches,
// model overrides, alternate config dir, and proxies (the claude seat drops
// proxies entirely — unlike the codex seat — so nothing re-routes its HTTPS).
const ABSENT = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

// Host-owned memory constant: always "1", never inherited. Planted with a BOGUS
// parent value below so a child seeing "1" proves overwrite, not inheritance.
const CONSTANTS = ['CLAUDE_CODE_DISABLE_AUTO_MEMORY'];

const PROBE_NAMES = [...PASS_CREDS, ...ABSENT, ...CONSTANTS];

// A single fake `claude`, reused for every spawn (adapter and control). It writes
// its capture into process.cwd()/capture.json, so a distinct spawn cwd yields a
// distinct capture file with the SAME binary. It emits one stream-json `result`
// line both adapter parsers accept, then exits 0. It records only NAME presence
// (booleans) plus the non-secret memory constant — never a credential value.
const FAKE_SRC = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const NAMES = ${JSON.stringify(PROBE_NAMES)};
const rec = { argv: process.argv.slice(2), present: {}, constants: {} };
for (const n of NAMES) rec.present[n] = Object.prototype.hasOwnProperty.call(process.env, n);
rec.constants.CLAUDE_CODE_DISABLE_AUTO_MEMORY = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
fs.writeFileSync(path.join(process.cwd(), 'capture.json'), JSON.stringify(rec));
const structured = process.argv.includes('--json-schema')
  ? { actions: [], done: true, summary: 'schema ready', decision: null }
  : null;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: structured ? 'intermediate prose must not win' : 'ok', structured_output: structured, total_cost_usd: 0 }) + '\\n');
process.exit(0);
`;

const temps = [];
const freshDir = (label) => { const d = mkdtempSync(join(tmpdir(), `camus-claude-${label}-`)); temps.push(d); return d; };
const readCapture = (dir) => JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
const adjacentSettingSources = (argv) => {
  const indexes = argv.flatMap((arg, i) => arg === '--setting-sources' ? [i] : []);
  return indexes.length === 1 && argv[indexes[0] + 1] === '';
};

// Snapshot EVERY name we touch so the parent process is restored exactly.
const touched = [
  ...PASS_CREDS, ...ABSENT, ...CONSTANTS, 'PATH',
  'STUDIO_GRANDFATHER_DIR', 'STUDIO_REGISTRY_FILE',
];
const snapshot = Object.fromEntries(touched.map((n) => [n, process.env[n]]));

try {
  ok('Claude failure diagnostics prefer the terminal error and redact credentials', () => {
    const planted = frag('sk', 'ant', 'diagnostic', 'planted');
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/private/project', slash_commands: ['many', 'large', 'fields'] }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `Credit balance too low; token=${planted}` }),
    ].join('\n');
    const detail = claudeFailureDiagnostic({ stdout });
    assert.match(detail, /Credit balance too low/);
    assert.doesNotMatch(detail, /private\/project|slash_commands/);
    assert.doesNotMatch(detail, new RegExp(planted));
    assert.match(detail, /redacted/);
  });

  ok('Claude failure diagnostics never dump unrecognized prompt-bearing events', () => {
    const stdout = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'private prompt echo' }] } });
    const detail = claudeFailureDiagnostic({ stdout });
    assert.equal(detail, 'no terminal error detail (last Claude event: assistant)');
    assert.doesNotMatch(detail, /private prompt echo/);
  });

  // Put the single fake `claude` on PATH.
  const binDir = freshDir('bin');
  const binPath = join(binDir, 'claude');
  writeFileSync(binPath, FAKE_SRC, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH || ''}`;

  // Clear any REAL credentials, then plant fragment-built fakes. Real values are
  // never forwarded to the fake binary.
  for (const n of PASS_CREDS) delete process.env[n];
  process.env.CLAUDE_CODE_OAUTH_TOKEN = frag('sk', 'ant', 'oauth', 'planted');
  process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = frag('sk', 'ant', 'refresh', 'planted');
  process.env.CLAUDE_CODE_OAUTH_SCOPES = frag('user', 'inference', 'planted');
  // Plant the full absent routing/control set with fake values.
  ABSENT.forEach((n, i) => { process.env[n] = frag('planted', 'redirect', String(i)); });
  // Plant BOGUS constants in the parent — the child must still see "1".
  for (const n of CONSTANTS) process.env[n] = frag('0', 'parent', 'planted');

  // --- pure sanity on the helper (NOT the sole proof) ----------------------
  // Default-deny by construction: the returned object never carries a redirect
  // name, always carries the host memory constant as literal "1", and forwards
  // only planted subscription credentials verbatim. Values are asserted here
  // only against fakes.
  ok('claudeDirectEnv is default-deny with host-owned constants', () => {
    const env = claudeDirectEnv();
    for (const n of ABSENT) assert.equal(Object.hasOwn(env, n), false, `${n} must not be copied`);
    assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'), false);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    for (const n of PASS_CREDS) assert.equal(env[n], process.env[n], `${n} forwarded verbatim`);
    // An explicit parent object is honored, and a missing pass-set name is simply
    // not copied (presence-gated, never a stray undefined key).
    const scoped = claudeDirectEnv({ PATH: '/x', ANTHROPIC_BASE_URL: 'http://evil' });
    assert.equal(Object.hasOwn(scoped, 'ANTHROPIC_BASE_URL'), false);
    assert.equal(Object.hasOwn(scoped, 'ANTHROPIC_API_KEY'), false);
    assert.equal(scoped.PATH, '/x');
    assert.equal(Object.hasOwn(scoped, 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'), false);
  });

  // Assert one entry point's isolated capture against its unisolated control.
  const assertIsolated = (label, isolated, control) => {
    // Contrast FIRST: the control (inherited env) proves the redirect names are
    // present in the planted parent, so their absence downstream is the adapter's
    // scrub, not a test that forgot to plant them.
    for (const n of ABSENT) {
      assert.equal(control.present[n], true, `[${label} control] ${n} must leak when unisolated`);
    }
    for (const n of PASS_CREDS) assert.equal(control.present[n], true, `[${label} control] ${n} inherited`);

    // The isolated adapter spawn: every redirect/direct-API name gone, every
    // subscription credential pass-set name present, memory disabled, and adjacent empty
    // --setting-sources in argv.
    for (const n of ABSENT) {
      assert.equal(isolated.present[n], false, `[${label}] ${n} must be stripped by claudeDirectEnv`);
    }
    for (const n of PASS_CREDS) {
      assert.equal(isolated.present[n], true, `[${label}] credential ${n} must be forwarded`);
    }
    assert.equal(isolated.constants.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', `[${label}] disable-auto-memory=1`);
    assert.ok(adjacentSettingSources(isolated.argv), `[${label}] argv has adjacent --setting-sources ""`);
    assert.equal(isolated.argv.filter((arg) => arg === '--strict-mcp-config').length, 1,
      `[${label}] preserves exactly one --strict-mcp-config`);
    // The bogus parent constant proves the control did NOT get "1" for free —
    // the adapter's "1" is an overwrite, not an inheritance.
    assert.notEqual(control.constants.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', `[${label} control] memory constant not "1"`);
  };

  // A control spawn of the SAME fake binary, inheriting the planted parent env.
  const controlSpawn = (label) => {
    const cwd = freshDir(`ctl-${label}`);
    const res = spawnSync(binPath, ['-p', `control-${label}`], { cwd, env: process.env, encoding: 'utf8' });
    assert.equal(res.status, 0, `[${label} control] fake exited clean`);
    return readCapture(cwd);
  };

  // --- entry point 1: runClaude (maker seat) -------------------------------
  await (async () => {
    const cwd = freshDir('make');
    const res = await runClaude({ prompt: 'draft it', stage: 'make', cwd, model: 'test-maker-model', toolPolicy: 'none' });
    ok('runClaude spawned the fake and parsed its result', () => {
      assert.equal(res.ok, true, res.error || 'runClaude should succeed against the fake');
    });
    ok('runClaude: isolated env + empty --setting-sources, proven against an unisolated control', () => {
      assertIsolated('runClaude', readCapture(cwd), controlSpawn('make'));
    });
  })();

  await (async () => {
    const cwd = freshDir('structured-make');
    const outputSchema = { type: 'object', required: ['actions', 'done'], properties: {
      actions: { type: 'array' }, done: { type: 'boolean' },
    } };
    const res = await runClaude({ prompt: 'return protocol', stage: 'make', cwd,
      model: 'test-maker-model', toolPolicy: 'none', outputSchema });
    ok('runClaude binds a supplied schema and returns only validated structured output', () => {
      assert.equal(res.ok, true, res.error || 'structured maker should succeed against the fake');
      assert.deepEqual(JSON.parse(res.text), { actions: [], done: true, summary: 'schema ready', decision: null });
      const capture = readCapture(cwd);
      const index = capture.argv.indexOf('--json-schema');
      assert.ok(index >= 0, 'structured maker argv carries --json-schema');
      assert.deepEqual(JSON.parse(capture.argv[index + 1]), outputSchema);
    });
  })();

  // --- entry point 2: runClaudeReview (reviewer seat) ----------------------
  await (async () => {
    const cwd = freshDir('review');
    const res = await runClaudeReview({ prompt: 'judge it', model: 'test-reviewer-model', cwd });
    ok('runClaudeReview spawned the fake (ran through the real reviewer path)', () => {
      // The reviewer normalizes a bare "ok" to a fail-closed verdict; what matters
      // for isolation is that it SPAWNED the fake, which the capture below proves.
      assert.ok(res && typeof res === 'object');
    });
    ok('runClaudeReview: isolated env + empty --setting-sources, proven against an unisolated control', () => {
      assertIsolated('runClaudeReview', readCapture(cwd), controlSpawn('review'));
    });
  })();

  // Shared Build supplies one private process registry. Both direct CLI role
  // paths must return only after their trusted supervisors attest cleanup.
  await (async () => {
    const ownedProcessDir = freshDir('owned-run');
    const makerCwd = freshDir('owned-make');
    const reviewerCwd = freshDir('owned-review');
    await runClaude({ prompt: 'draft it', stage: 'make', cwd: makerCwd,
      model: 'test-maker-model', toolPolicy: 'none', ownedProcessDir });
    await runClaudeReview({ prompt: 'judge it', model: 'test-reviewer-model', cwd: reviewerCwd, ownedProcessDir });
    ok('shared Build Claude maker/reviewer paths durably attest process cleanup', () => {
      const cleanup = codeOwnedProcessCleanupStatus(ownedProcessDir);
      assert.equal(cleanup.complete, true);
      assert.deepEqual(cleanup.intents.map(intent => intent.kind), ['claude_maker', 'claude_reviewer']);
    });
  })();

  // --- recorded operator-confirmation action (the §9.1 interim path) ------
  // Exercise the REAL storage action and the REAL production identity call.
  // The fixture executor is registry-known as Anthropic/Claude but deliberately
  // absent from REDIRECT_ISOLATION, modelling claude_cli before the isolation
  // flip without weakening the production constant. It stays unknown until a
  // human action records a non-empty why, then reaches operator_declared.
  await (async () => {
    const dir = freshDir('route-confirmation');
    const registry = join(dir, 'registry.json');
    writeFileSync(registry, JSON.stringify({
      executors: { claude_cli_unproven: { org: 'anthropic', family: 'claude' } },
    }));
    process.env.STUDIO_GRANDFATHER_DIR = dir;
    process.env.STUDIO_REGISTRY_FILE = registry;

    const backend = {
      name: 'claude', kind: 'claude_cli_unproven', provider: 'anthropic',
      seats: ['maker', 'reviewer'], effort: false,
    };

    // Invoke the actual operator-facing CLI action, not the storage helper.
    // First prove a blank why is refused; getModels() still performs the safe
    // empty first-launch inventory, leaving no confirmation to consult.
    const serverPath = fileURLToPath(new URL('../../server.mjs', import.meta.url));
    const studioDir = fileURLToPath(new URL('../../', import.meta.url));
    const actionEnv = { ...process.env };
    const blank = spawnSync(process.execPath, [serverPath, '--confirm-claude-route', '   '], {
      cwd: studioDir, env: actionEnv, encoding: 'utf8',
    });
    assert.equal(blank.status, 2, 'operator action refuses blank why');
    assert.match(blank.stderr, /non-empty reason/i);

    const before = seatIdentityFacts(backend, 'claude-opus-test');
    assert.equal(before.lineage.source, 'unknown', 'unisolated + unconfirmed must stay unknown');

    const why = 'operator inspected this environment and confirmed direct Anthropic routing';
    const action = spawnSync(process.execPath, [serverPath, '--confirm-claude-route', why], {
      cwd: studioDir, env: actionEnv, encoding: 'utf8',
    });
    assert.equal(action.status, 0, action.stderr || 'operator action should succeed');
    assert.doesNotMatch(action.stdout + action.stderr, new RegExp(why), 'the reason is recorded, not printed');
    const loaded = consultClaudeRoute();
    const after = seatIdentityFacts(backend, 'claude-opus-test');
    ok('recorded Claude-route confirmation upgrades only the unisolated production identity path', () => {
      assert.equal(loaded.ok, true);
      assert.equal(loaded.record.source, 'operator_confirmation');
      assert.equal(loaded.record.why, why, 'the HMAC-validated record retains the operator reason');
      assert.equal(after.lineage.source, 'operator_declared');
      assert.equal(after.originConfidence, 'operator_declared');
    });
  })();
} finally {
  for (const [n, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[n]; else process.env[n] = v;
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}

console.log(`claude.test.mjs: ${passed} checks passed`);
