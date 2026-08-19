// Full unit test for the pure lineage-derivation engine (lib/identity.mjs).
// Runs against the TRACKED checks/registry.json (default path relative to the
// module) so registry.json is pinned here too. Every refusal is proven able to
// FAIL by mutating the guard input (break-on-purpose).

import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redirectIsolationProven,
  lookupEndpoint,
  executorOrgFamily,
  familyOrg,
  deriveLineageSource,
  originConfidence,
  deriveIndependence,
  expectedReportedSet,
  buildSeatIdentitySealed,
} from './identity.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; if (process.env.VERBOSE) console.log('  ok', name); };

// --- registry.json pinned (reviewed tracked default) ---------------------
// Deep-compare the ENTIRE parsed tracked registry against its exact required
// shape. Every row here grants registry-backed identity, so nothing may be
// silently added, dropped, or narrowed: a changed host, pattern, org, family, or
// executor row fails this before the sampled lookups below can hide it.
ok('registry.json is EXACTLY the required shape (whole-file pin)', () => {
  const trackedPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'checks', 'registry.json');
  const parsed = JSON.parse(readFileSync(trackedPath, 'utf8'));
  assert.deepEqual(parsed, {
    endpoints: [
      { host: 'api.x.ai', modelIdPattern: '^grok', org: 'xai', family: 'grok' },
      { host: 'dashscope.aliyuncs.com', modelIdPattern: '^qwen', org: 'alibaba', family: 'qwen' },
      { host: 'api.moonshot.ai', modelIdPattern: '^kimi', org: 'moonshot', family: 'kimi' },
    ],
    executors: {
      claude_cli: { org: 'anthropic', family: 'claude' },
      codex_cli: { org: 'openai', family: 'gpt' },
    },
    families: {
      gpt: 'openai',
      gpt_oss: 'openai',
      claude: 'anthropic',
      grok: 'xai',
      qwen: 'alibaba',
      kimi: 'moonshot',
    },
  });
});
ok('registry pins executor rows', () => {
  assert.deepEqual(executorOrgFamily('claude_cli'), { org: 'anthropic', family: 'claude' });
  assert.deepEqual(executorOrgFamily('codex_cli'), { org: 'openai', family: 'gpt' });
  assert.equal(executorOrgFamily('http_client'), null);
});
ok('registry pins family table', () => {
  assert.equal(familyOrg('gpt'), 'openai');
  assert.equal(familyOrg('gpt_oss'), 'openai'); // different family, same org
  assert.equal(familyOrg('claude'), 'anthropic');
  assert.equal(familyOrg('kimi'), 'moonshot');
  assert.equal(familyOrg('nonexistent'), null);
});
ok('registry pins endpoint rows (host + pattern)', () => {
  assert.deepEqual(lookupEndpoint('api.x.ai', 'grok-4'), { org: 'xai', family: 'grok' });
  assert.deepEqual(lookupEndpoint('dashscope.aliyuncs.com', 'qwen3-coder'), { org: 'alibaba', family: 'qwen' });
  assert.deepEqual(lookupEndpoint('api.moonshot.ai', 'kimi-k2'), { org: 'moonshot', family: 'kimi' });
  assert.equal(lookupEndpoint('api.x.ai', 'kimi-k2'), null); // host matches, pattern does not
  assert.equal(lookupEndpoint('evil.example', 'grok-4'), null); // pattern matches, host does not
});

// --- config resolved PER CALL via STUDIO_REGISTRY_FILE --------------------
// Proves the registry is read on every call, not cached at import: swap the
// override BETWEEN calls and the result must track the current file. An
// import-time read would keep returning the default and fail here.
ok('registry is resolved per call (STUDIO_REGISTRY_FILE override, changed between calls)', () => {
  const prev = process.env.STUDIO_REGISTRY_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'identity-registry-'));
  const fileA = join(dir, 'a.json');
  const fileB = join(dir, 'b.json');
  writeFileSync(fileA, JSON.stringify({ executors: { claude_cli: { org: 'orgA', family: 'famA' } } }));
  writeFileSync(fileB, JSON.stringify({ executors: { claude_cli: { org: 'orgB', family: 'famB' } } }));
  try {
    // default (tracked) file first
    assert.deepEqual(executorOrgFamily('claude_cli'), { org: 'anthropic', family: 'claude' });
    process.env.STUDIO_REGISTRY_FILE = fileA;
    assert.deepEqual(executorOrgFamily('claude_cli'), { org: 'orgA', family: 'famA' });
    // change the target BETWEEN calls — a cached read would still say orgA
    process.env.STUDIO_REGISTRY_FILE = fileB;
    assert.deepEqual(executorOrgFamily('claude_cli'), { org: 'orgB', family: 'famB' });
  } finally {
    if (prev === undefined) delete process.env.STUDIO_REGISTRY_FILE;
    else process.env.STUDIO_REGISTRY_FILE = prev;
  }
  // back on the default, the tracked row resolves again
  assert.deepEqual(executorOrgFamily('claude_cli'), { org: 'anthropic', family: 'claude' });
});

// --- registry lookups reject inherited prototype names --------------------
ok('registry lookups ignore prototype properties', () => {
  assert.equal(executorOrgFamily('constructor'), null);
  assert.equal(executorOrgFamily('toString'), null);
  assert.equal(familyOrg('constructor'), null);
  assert.equal(familyOrg('toString'), null);
  assert.equal(familyOrg('hasOwnProperty'), null);
});

// --- redirectIsolationProven: the only flag (pre Task 9 flip) -------------
ok('redirectIsolationProven table is codex-only today', () => {
  assert.equal(redirectIsolationProven('codex_cli'), true);
  assert.equal(redirectIsolationProven('claude_cli'), false);
  assert.equal(redirectIsolationProven('http_client'), false);
  assert.equal(redirectIsolationProven(undefined), false);
});

// --- deriveLineageSource: table-driven happy paths ------------------------
const LADDER = [
  ['registry via direct_https endpoint row',
    { connectionKind: 'direct_https', endpointHost: 'api.x.ai', modelId: 'grok-4' }, 'registry'],
  ['registry via direct_https agreeing declaration',
    { connectionKind: 'direct_https', endpointHost: 'api.moonshot.ai', modelId: 'kimi-k2',
      declared: { org: 'moonshot', family: 'kimi' } }, 'registry'],
  ['operator_declared over loopback',
    { connectionKind: 'loopback', declared: { org: 'alibaba', family: 'qwen' } }, 'operator_declared'],
  ['unknown: free-text custom backend, no declarations, no connection [AT1]',
    { connectionKind: 'loopback' }, 'unknown'],
  ['codex_cli vendor_managed built-in -> registry',
    { transport: 'vendor_managed', executorKind: 'codex_cli' }, 'registry'],
  ['claude_cli vendor_managed built-in, declared -> operator_declared (PRE-flip)',
    { transport: 'vendor_managed', executorKind: 'claude_cli', declared: { org: 'anthropic', family: 'claude' } },
    'operator_declared'],
  ['claude_cli vendor_managed built-in, undeclared -> unknown (PRE-flip)',
    { transport: 'vendor_managed', executorKind: 'claude_cli' }, 'unknown'],
  ['Kimi-via-claude_cli: camusInjectedRedirect routes through endpoint branch',
    { executorKind: 'claude_cli', transport: 'vendor_managed', camusInjectedRedirect: true,
      endpointHost: 'api.moonshot.ai', modelId: 'kimi-k2-0711-preview',
      declared: { org: 'moonshot', family: 'kimi' } }, 'registry'],
];
for (const [name, input, want] of LADDER) {
  ok(`deriveLineageSource: ${name}`, () => assert.equal(deriveLineageSource(input), want));
}

// --- registry is ONLY for direct_https / injected redirect [AT11] ---------
// The SAME registry-agreeing declaration over a non-direct_https connection must
// NOT reach 'registry' — it settles at operator_declared.
ok('registry-only-for-direct_https [AT11]', () => {
  const declared = { org: 'xai', family: 'grok' };
  for (const connectionKind of ['loopback', 'ssh_tunnel', 'legacy_http']) {
    assert.equal(
      deriveLineageSource({ connectionKind, endpointHost: 'api.x.ai', modelId: 'grok-4', declared }),
      'operator_declared',
      `expected operator_declared over ${connectionKind}`,
    );
  }
  // Control: the same declaration over direct_https DOES reach registry.
  assert.equal(
    deriveLineageSource({ connectionKind: 'direct_https', endpointHost: 'api.x.ai', modelId: 'grok-4', declared }),
    'registry',
  );
});

// --- refusal: declared.source present, with break-on-purpose --------------
ok('refuses a configured lineage.source', () => {
  const withSource = { connectionKind: 'loopback', declared: { org: 'xai', family: 'grok', source: 'registry' } };
  assert.throws(() => deriveLineageSource(withSource), /derived, never configured/);
  // break-on-purpose: remove the offending field and the guard does NOT fire.
  const mutated = { ...withSource, declared: { org: 'xai', family: 'grok' } };
  assert.doesNotThrow(() => deriveLineageSource(mutated));
  // PRESENCE of the key is what's forbidden — `{ source: null }` still refuses.
  const nullSource = { connectionKind: 'loopback', declared: { org: 'xai', family: 'grok', source: null } };
  assert.throws(() => deriveLineageSource(nullSource), /derived, never configured/);
});

// --- refusal: declaration contradicts registry, naming BOTH ---------------
ok('refuses a declaration contradicting the registry (names both)', () => {
  const contradicting = {
    connectionKind: 'direct_https', endpointHost: 'api.x.ai', modelId: 'grok-4',
    declared: { org: 'openai', family: 'gpt' },
  };
  assert.throws(() => deriveLineageSource(contradicting), (err) => {
    assert.match(err.message, /declared openai\/gpt/);   // the declaration
    assert.match(err.message, /registry xai\/grok/);     // the registry row
    assert.match(err.message, /api\.x\.ai/);             // the host
    return true;
  });
  // break-on-purpose: an AGREEING declaration does not throw — it derives registry.
  const agreeing = { ...contradicting, declared: { org: 'xai', family: 'grok' } };
  assert.equal(deriveLineageSource(agreeing), 'registry');
});

// A contradiction on EITHER axis alone must refuse. These pin `orgConflict ||
// familyConflict`: swapping the OR for an AND, or dropping either predicate,
// would let one of these single-axis contradictions derive 'registry' silently.
ok('refuses an org-ONLY contradiction (family agrees)', () => {
  const orgOnly = {
    connectionKind: 'direct_https', endpointHost: 'api.x.ai', modelId: 'grok-4',
    declared: { org: 'openai', family: 'grok' }, // family matches xai/grok, org does not
  };
  assert.throws(() => deriveLineageSource(orgOnly), (err) => {
    assert.match(err.message, /declared openai\/grok/);
    assert.match(err.message, /registry xai\/grok/);
    return true;
  });
});
ok('refuses a family-ONLY contradiction (org agrees)', () => {
  const familyOnly = {
    connectionKind: 'direct_https', endpointHost: 'api.x.ai', modelId: 'grok-4',
    declared: { org: 'xai', family: 'gpt' }, // org matches xai/grok, family does not
  };
  assert.throws(() => deriveLineageSource(familyOnly), (err) => {
    assert.match(err.message, /declared xai\/gpt/);
    assert.match(err.message, /registry xai\/grok/);
    return true;
  });
});

// --- originConfidence ladder ----------------------------------------------
ok('originConfidence maps source -> confidence', () => {
  assert.equal(originConfidence('registry'), 'verified_operator');
  assert.equal(originConfidence('operator_declared'), 'operator_declared');
  assert.equal(originConfidence('unknown'), 'unknown');
  assert.equal(originConfidence(undefined), 'unknown');
});

// --- deriveIndependence: §10 rules 1-4/7, fail-toward-lower ----------------
const side = (trainingOrg, modelFamily, source, derivedFrom = null) => ({
  trainingOrg, modelFamily,
  lineage: { source, derivedFrom },
  originConfidence: originConfidence(source),
});
const INDEP = [
  ['same org, different operator -> same_vendor',
    { maker: side('alibaba', 'qwen', 'registry'), reviewer: side('alibaba', 'qwen', 'registry') }, 'same_vendor'],
  ['gpt + gpt_oss: same org, different family -> same_vendor',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('openai', 'gpt_oss', 'operator_declared') }, 'same_vendor'],
  ['fully-registry cross-org -> cross_vendor [AT6]',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('xai', 'grok', 'registry') }, 'cross_vendor'],
  ['cross-org, weaker side operator_declared -> cross_vendor_declared',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('alibaba', 'qwen', 'operator_declared') }, 'cross_vendor_declared'],
  ['unknown org on one side -> same_vendor',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('unknown', 'grok', 'registry') }, 'same_vendor'],
  ['unknown lineage.source on one side -> same_vendor',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('xai', 'grok', 'unknown') }, 'same_vendor'],
  ['declared derivation onto the other family -> same_vendor',
    { maker: side('openai', 'gpt', 'registry'), reviewer: side('alibaba', 'gpt_oss', 'operator_declared', 'gpt') }, 'same_vendor'],
];
for (const [name, input, want] of INDEP) {
  ok(`deriveIndependence: ${name}`, () => assert.equal(deriveIndependence(input), want));
}
ok('deriveIndependence: a missing side fails closed', () => {
  assert.equal(deriveIndependence({ maker: side('openai', 'gpt', 'registry') }), 'same_vendor');
});
// Confidence is derived from lineage.source, not a trusted field: a cross-org
// pair with one side's originConfidence OMITTED must not promote to
// cross_vendor_declared just because the other side is operator_declared.
ok('deriveIndependence: absent originConfidence fails toward the lower tier', () => {
  const maker = { trainingOrg: 'openai', modelFamily: 'gpt', lineage: { source: 'registry' } }; // no originConfidence
  const reviewer = { trainingOrg: 'alibaba', modelFamily: 'qwen', lineage: { source: 'operator_declared' }, originConfidence: 'operator_declared' };
  // maker's omitted field makes its effective confidence unknown; an unknown side
  // fails the pair closed to same_vendor and is never promoted by the other side.
  assert.equal(deriveIndependence({ maker, reviewer }), 'same_vendor');
  // and a bogus originConfidence field cannot forge a full cross_vendor upgrade
  const forged = { trainingOrg: 'openai', modelFamily: 'gpt', lineage: { source: 'operator_declared' }, originConfidence: 'verified_operator' };
  assert.equal(
    deriveIndependence({ maker: forged, reviewer: side('xai', 'grok', 'registry') }),
    'cross_vendor_declared',
  );
});

// --- expectedReportedSet + actual_evidence construction [AT7] --------------
ok('expectedReportedSet: bare seat is exactly the resolved model', () => {
  const set = expectedReportedSet({ resolvedModel: 'grok-4' });
  assert.deepEqual([...set], ['grok-4']);
});
ok('expectedReportedSet: mapped endpoint adds declared aliases', () => {
  const set = expectedReportedSet({
    resolvedModel: 'kimi-k2-0711-preview',
    aliases: ['claude-3-5-sonnet', 'claude-3-opus'],
  });
  assert.equal(set.size, 3);
  assert.ok(set.has('kimi-k2-0711-preview'));
  assert.ok(set.has('claude-3-5-sonnet'));
  assert.ok(set.has('claude-3-opus'));
});
ok('buildSeatIdentitySealed: pure assembly, carries actual_evidence, no lineage recompute', () => {
  const seat = {
    requested: 'moonshot:kimi-k2', resolved: 'moonshot:kimi-k2', actual: 'moonshot:kimi-k2',
    reported: 'claude-3-5-sonnet', actualEvidence: 'mapped_by_operator_docs',
    executorKind: 'claude_cli', trainingOrg: 'moonshot', modelFamily: 'kimi',
    lineage: { source: 'registry', derivedFrom: null },
    inferenceOperator: 'moonshot', transport: 'direct_https', connection: 'kimi-via-claude',
    originConfidence: 'verified_operator',
    qualification: { fingerprint: 'builtin1:deadbeef', gate_scope: null, contract_version: null },
  };
  const sealed = buildSeatIdentitySealed(seat);
  assert.equal(sealed.actual_evidence, 'mapped_by_operator_docs');
  assert.equal(sealed.executor_kind, 'claude_cli');
  assert.equal(sealed.training_org, 'moonshot');
  assert.equal(sealed.model_family, 'kimi');
  assert.deepEqual(sealed.lineage, { source: 'registry', derived_from: null }); // passed through verbatim
  assert.equal(sealed.origin_confidence, 'verified_operator');
  assert.deepEqual(sealed.qualification, seat.qualification);
  // null-normalization for optional rungs
  const sparse = buildSeatIdentitySealed({ requested: 'a:b' });
  assert.equal(sparse.reported, null);
  assert.equal(sparse.connection, null);
  assert.equal(sparse.lineage.derived_from, null);
});
// actual_evidence enum membership over the full ladder.
ok('buildSeatIdentitySealed: every actual_evidence class survives assembly', () => {
  for (const ev of ['observed_api_response', 'observed_cli_event', 'asserted_pin', 'mapped_by_operator_docs', 'none']) {
    assert.equal(buildSeatIdentitySealed({ actualEvidence: ev }).actual_evidence, ev);
  }
});

console.log(`identity.test.mjs: ${passed} checks passed`);
