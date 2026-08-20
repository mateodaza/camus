// Exhaustive hermetic tests for the §9.2/§9.4 capability-qualification floor
// (docs/OPEN-MODEL-SEATS-RFC.md §9.2, §9.4, §6.1). Fully offline: a temp STUDIO
// dir per suite, no network, no probe execution. Every guard has a
// break-on-purpose control — after asserting an invalidation we re-run the
// UNMUTATED path and prove it validates, so a guard that always-voided would
// fail the control and a guard that never-voided would fail the assertion.
//
// No secret-shaped fixture is a literal beyond the obvious fake token, and the
// credential-value non-storage guard reads the raw receipt bytes to prove the
// value never lands on disk.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeFingerprint,
  writeReceipt,
  readReceipt,
  qualifySeat,
  COMPONENT_NAMES,
  PROBE_SUITE_VERSION,
  CAP_STATES,
  SEAT_REQUIREMENTS,
  WORDS_SEATS,
} from './capabilities.mjs';

const dirs = [];
function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-test-'));
  dirs.push(dir);
  // A single base points BOTH the machine salt (grandfather base) and the
  // receipts dir at one fixture; no STUDIO_CAPABILITY_DIR override needed.
  process.env.STUDIO_GRANDFATHER_DIR = dir;
  delete process.env.STUDIO_CAPABILITY_DIR;
  delete process.env.STUDIO_CAPABILITY_TTL_DAYS;
  return { dir, capabilities: join(dir, 'capabilities') };
}

// A complete, producible loopback words-reviewer descriptor (auth.kind:env).
function baseInput() {
  return {
    seatType: 'words_reviewer',
    backendName: 'ollama',
    backendKind: 'openai_compat',
    connection: 'loopback 127.0.0.1:11434',
    protocol: 'chat_completions',
    requestedModelId: 'qwen2.5:7b',
    auth: { kind: 'env', envVarName: 'OLLAMA_KEY', value: 'sk-fake-secret-value-123' },
    serverAnchors: 'digest=abc123;quant=Q4_K_M;ctx=32768',
    normalizerVersion: 'norm-3',
    promptEnvelopeVersion: 'words_reviewer-env-1',
    decodingKnobs: 'temp=0;top_p=1',
    executorVersion: 'none',
    adapterContractVersion: 'oai-compat-2',
    gateScope: 'n/a',
  };
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- 1. fingerprint stability + versioned prefix ---------------------------

test('fingerprint is stable across calls and carries the qual1: version prefix', () => {
  freshEnv();
  const a = computeFingerprint(baseInput());
  const b = computeFingerprint(baseInput());
  assert.equal(a.fingerprint, b.fingerprint, 'same input → same fingerprint');
  assert.match(a.fingerprint, /^qual1:[0-9a-f]{64}$/);
  assert.equal(a.components.length, 16, 'exactly 16 ordered components');
  assert.deepEqual(a.components.map((c) => c.name), COMPONENT_NAMES, 'components are the 16 §9.2 names, in order');
});

// ---- 2. each of the 16 components flips the hash and names itself -----------
// The 5 lookup-key components (seat/backend name+kind/model/connection) route to
// a different receipt file (tested separately); ALL 16 must still flip the hash
// and be nameable at the fingerprint layer, which is what this asserts directly.

test('each of the 16 components independently flips the fingerprint and names itself', () => {
  freshEnv();
  const base = computeFingerprint(baseInput());
  const byName = new Map(base.components.map((c) => [c.name, c.value]));

  // input mutation for each nameable-via-input component (15 of 16).
  const mutate = {
    probeSuiteVersion: (i) => (i.probeSuiteVersion = 'probes-99'),
    seatType: (i) => (i.seatType = 'words_maker'),
    backend: (i) => (i.backendKind = 'legacy_http'),
    connection: (i) => (i.connection = 'loopback 127.0.0.1:9999'),
    protocol: (i) => (i.protocol = 'responses'),
    requestedModelId: (i) => (i.requestedModelId = 'llama3.1:70b'),
    authMode: (i) => (i.auth.envVarName = 'OTHER_KEY'),
    serverAnchors: (i) => (i.serverAnchors = 'digest=DIFFERENT;quant=Q8_0;ctx=8192'),
    normalizerVersion: (i) => (i.normalizerVersion = 'norm-4'),
    promptEnvelopeVersion: (i) => (i.promptEnvelopeVersion = 'words_reviewer-env-2'),
    decodingKnobs: (i) => (i.decodingKnobs = 'temp=0.7;top_p=0.9'),
    executorVersion: (i) => (i.executorVersion = 'qwen-1.2.3'),
    adapterContractVersion: (i) => (i.adapterContractVersion = 'oai-compat-3'),
    credentialRevision: (i) => (i.auth.value = 'sk-fake-DIFFERENT-value-456'),
    gateScope: (i) => (i.gateScope = 'full'),
  };

  for (const name of COMPONENT_NAMES) {
    if (name === 'fingerprintFormatVersion') continue; // constant; covered below
    const input = clone(baseInput());
    mutate[name](input);
    const flipped = computeFingerprint(input);
    assert.notEqual(flipped.fingerprint, base.fingerprint, `${name} must flip the hash`);
    const changed = firstDiff(base.components, flipped.components);
    assert.equal(changed, name, `voided receipt must name "${name}"`);
    // break-on-purpose control: the UNMUTATED input still matches the baseline.
    assert.equal(computeFingerprint(baseInput()).fingerprint, base.fingerprint);
  }

  // Component 1 (format version) is a hardcoded constant, so it is flipped at the
  // stored layer: a receipt whose fingerprint no longer matches the recomputed
  // one — with components that look intact — voids and names the whole fingerprint.
  writeReceipt(baseInput(), { capabilities: demoCaps() });
  const path = onlyReceiptFile();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.fingerprint = 'qual0:' + '0'.repeat(64); // simulate an encoding-version change
  writeFileSync(path, JSON.stringify(data));
  const voided = readReceipt(baseInput());
  assert.equal(voided.ok, false);
  assert.equal(voided.state, 'voided');
  assert.equal(voided.component, 'fingerprint', 'a header/whole-hash mismatch names the fingerprint');

  // mark byName used (documents the 16 covered names)
  assert.equal(byName.get('fingerprintFormatVersion'), 'qual1');
});

// firstDiff mirrors the module's component-naming: first ordered name whose value differs.
function firstDiff(a, b) {
  const m = new Map(a.map((c) => [c.name, c.value]));
  for (const { name, value } of b) if (m.get(name) !== value) return name;
  return 'fingerprint';
}

function demoCaps() {
  return {
    structuredOutput: CAP_STATES.DEMONSTRATED,
    toolCalling: CAP_STATES.NOT_APPLICABLE,
    streaming: CAP_STATES.DEMONSTRATED,
    contextWindow: { status: CAP_STATES.DEMONSTRATED, configured: 32768, source: 'endpoint', demonstratedAt: 24000 },
  };
}

// The probe RESULTS §9.2 mandates for the demonstrated rows: the structured-output
// normalizer verdict and the context demonstratedAt size (tool digest stays null —
// toolCalling is n/a for words seats). A demonstrated row without its evidence must
// not seat a model, so a qualified-path write pairs demoCaps() with demoProbe().
function demoProbe() {
  return { contextDemonstratedAt: 24000, normalizerVerdict: 'schema-ok', toolTranscriptDigest: null };
}

// A complete, producible direct_https words-reviewer descriptor: component 5 is the
// FULL base URL (kind + identity), the hosted endpoint has no local server anchors.
function directHttpsInput() {
  return {
    seatType: 'words_reviewer',
    backendName: 'together',
    backendKind: 'openai_compat',
    connection: 'direct_https https://api.together.xyz/v1',
    protocol: 'chat_completions',
    requestedModelId: 'meta-llama/Llama-3.3-70B-Instruct',
    auth: { kind: 'env', envVarName: 'TOGETHER_API_KEY', value: 'sk-fake-together-000' },
    serverAnchors: 'absent', // hosted endpoint: no local digest/quant/ctx anchors
    normalizerVersion: 'norm-3',
    promptEnvelopeVersion: 'words_reviewer-env-1',
    decodingKnobs: 'temp=0;top_p=1',
    executorVersion: 'none',
    adapterContractVersion: 'oai-compat-2',
    gateScope: 'n/a',
  };
}

function onlyReceiptFile() {
  const dir = join(process.env.STUDIO_GRANDFATHER_DIR, 'capabilities');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'exactly one receipt on disk');
  return join(dir, files[0]);
}

function receiptCount() {
  const dir = join(process.env.STUDIO_GRANDFATHER_DIR, 'capabilities');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

// ---- 3. durability: 0600 receipt / 0700 dir --------------------------------

test('receipts are written 0600 in a 0700 dir, atomically', () => {
  const p = freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps() });
  assert.ok(existsSync(p.capabilities));
  assert.equal(statSync(p.capabilities).mode & 0o777, 0o700);
  const file = onlyReceiptFile();
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

// ---- 4. TTL expiry voids WITHOUT a hash break ------------------------------

test('expiry voids by date only; the fingerprint itself still matches', () => {
  freshEnv();
  const probedAt = '2026-01-01T00:00:00.000Z';
  const write = writeReceipt(baseInput(), { capabilities: demoCaps(), probedAt });
  assert.equal(write.ttlDays, 30);
  const day = 86400000;
  const t0 = new Date(probedAt).getTime();

  // within TTL → valid (control): fingerprint matches AND date is fresh
  const fresh = readReceipt(baseInput(), { now: t0 + day });
  assert.equal(fresh.ok, true, 'fresh receipt reads ok');

  // past TTL → expired, and NOT a hash break (state is 'expired', not 'voided')
  const stale = readReceipt(baseInput(), { now: t0 + 31 * day });
  assert.equal(stale.ok, false);
  assert.equal(stale.state, 'expired', 'expiry is a date comparison, not a hash break');

  // prove it is truly date-only: the recomputed fingerprint DID match on-disk.
  const onDisk = JSON.parse(readFileSync(onlyReceiptFile(), 'utf8'));
  assert.equal(computeFingerprint(baseInput()).fingerprint, onDisk.fingerprint);
});

test('STUDIO_CAPABILITY_TTL_DAYS overrides the horizon', () => {
  freshEnv();
  process.env.STUDIO_CAPABILITY_TTL_DAYS = '2';
  const probedAt = '2026-01-01T00:00:00.000Z';
  const w = writeReceipt(baseInput(), { capabilities: demoCaps(), probedAt });
  assert.equal(w.ttlDays, 2);
  const t0 = new Date(probedAt).getTime();
  assert.equal(readReceipt(baseInput(), { now: t0 + 86400000 }).ok, true);
  assert.equal(readReceipt(baseInput(), { now: t0 + 3 * 86400000 }).state, 'expired');
});

// ---- 5. tuple-keyed lookup: distinct tuples coexist; non-key drift VOIDS ------
// The receipt is keyed by the §9.2 identity TUPLE (seat, backend, model,
// connection, gate scope), so distinct models on the same seat are distinct
// durable slots — qualifying model B never overwrites model A's still-valid
// receipt (RFC §9.2:1441-1444). A KEY-axis change is a different qualification
// question → its own (absent) slot → `missing`. A change to any of the other 11
// components on the SAME tuple reaches the fingerprint recompute and VOIDS the
// receipt naming the component (§9.2:1397-1400).

test('a second model on the same seat gets its own slot and does NOT overwrite the first', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  const modelB = { ...baseInput(), requestedModelId: 'other-model:1b' };
  writeReceipt(modelB, { capabilities: demoCaps(), probeResults: demoProbe() });
  // both tuples are live at once — model A's receipt survived model B's write
  assert.equal(readReceipt(baseInput()).ok, true, 'model A receipt is preserved');
  assert.equal(readReceipt(modelB).ok, true, 'model B receipt is its own slot');
  assert.equal(receiptCount(), 2, 'two distinct receipts on disk, one per tuple');
});

test('an unprobed model / connection / backend on the same seat reads missing, not a stale match', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps() });
  // KEY-axis changes are different qualification questions → their own absent slots
  assert.equal(readReceipt({ ...baseInput(), requestedModelId: 'never-probed:9b' }).state, 'missing');
  assert.equal(readReceipt({ ...baseInput(), connection: 'loopback 127.0.0.1:9999' }).state, 'missing');
  assert.equal(readReceipt({ ...baseInput(), backendKind: 'legacy_http' }).state, 'missing');
  assert.equal(readReceipt(baseInput()).ok, true); // control: the probed tuple still reads
});

test('a non-key component drift on the SAME tuple VOIDS and names the component', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps() });
  // server anchors = the model weights digest: same tuple, drifted fact → void+name
  const digest = readReceipt({ ...baseInput(), serverAnchors: 'digest=CHANGED;quant=Q4_K_M;ctx=32768' });
  assert.equal(digest.state, 'voided');
  assert.equal(digest.component, 'serverAnchors', '"model digest changed: re-qualify" (§9.2)');
  assert.equal(readReceipt(baseInput()).ok, true); // control
});

test('a different SEAT is a different slot (missing, not voided)', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps() }); // words_reviewer
  const maker = readReceipt({ ...baseInput(), seatType: 'words_maker' });
  assert.equal(maker.ok, false);
  assert.equal(maker.state, 'missing', 'the maker seat has no receipt of its own');
  assert.equal(readReceipt(baseInput()).ok, true); // control
});

test('a non-key component change on the SAME seat voids and names the component', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps() });
  const drifted = { ...baseInput(), normalizerVersion: 'norm-4' }; // same seat
  const read = readReceipt(drifted);
  assert.equal(read.ok, false);
  assert.equal(read.state, 'voided');
  assert.equal(read.component, 'normalizerVersion');
  assert.equal(readReceipt(baseInput()).ok, true); // control
});

// ---- 6. credential revision: rotates on name OR value; never stored --------

test('credential revision is a 16-hex HMAC that rotates on env name OR value', () => {
  freshEnv();
  const rev = (mut) => {
    const i = clone(baseInput());
    mut(i);
    return componentValue(computeFingerprint(i), 'credentialRevision');
  };
  const base = rev(() => {});
  assert.match(base, /^[0-9a-f]{16}$/, 'truncated 16 hex');
  assert.notEqual(base, rev((i) => (i.auth.value = 'sk-fake-rotated-999')), 'value rotation voids');
  assert.notEqual(base, rev((i) => (i.auth.envVarName = 'RENAMED_KEY')), 'name rotation voids');
});

test('the credential VALUE never appears in the stored receipt', () => {
  freshEnv();
  const secret = 'sk-fake-do-not-persist-abcdef';
  const input = clone(baseInput());
  input.auth.value = secret;
  writeReceipt(input, { capabilities: demoCaps() });
  const raw = readFileSync(onlyReceiptFile(), 'utf8');
  assert.ok(!raw.includes(secret), 'the credential value is never written to disk');
  const stored = JSON.parse(raw);
  const cr = stored.components.find((c) => c.name === 'credentialRevision');
  assert.match(cr.value, /^[0-9a-f]{16}$/, 'only the HMAC revision is stored');
});

// ---- 7. auth.kind none / keyless loopback ----------------------------------

test('auth.kind none (keyless loopback): authMode and credentialRevision are literal `none`', () => {
  freshEnv();
  const input = clone(baseInput());
  input.auth = { kind: 'none' };
  const fp = computeFingerprint(input);
  assert.equal(componentValue(fp, 'authMode'), 'none');
  assert.equal(componentValue(fp, 'credentialRevision'), 'none');
  // full write/read/qualify round-trips with no credential material at all
  writeReceipt(input, { capabilities: demoCaps(), probeResults: demoProbe() });
  assert.equal(readReceipt(input).ok, true);
  assert.equal(qualifySeat(input).qualified, true);
  // no machine salt is minted merely by a keyless probe
  assert.equal(existsSync(join(process.env.STUDIO_GRANDFATHER_DIR, '.machine-salt')), false);
});

// ---- 8. fail-closed on any unproducible component --------------------------

test('an unproducible component fails closed (throws, no receipt written)', () => {
  const p = freshEnv();
  const input = clone(baseInput());
  delete input.serverAnchors; // absent MUST be the literal `absent`, not missing
  assert.throws(() => computeFingerprint(input), /serverAnchors.*unproducible/i);
  assert.throws(() => writeReceipt(input, { capabilities: demoCaps() }), /unproducible/i);
  assert.equal(existsSync(p.capabilities), false, 'no receipt directory materializes on failure');
  // control: `absent` recorded explicitly is producible
  input.serverAnchors = 'absent';
  assert.equal(computeFingerprint(input).components.find((c) => c.name === 'serverAnchors').value, 'absent');
});

// ---- 9. three-state capability payload incl. contextWindow object ----------

test('capability payload is three-state and preserves the contextWindow object (§6.1)', () => {
  freshEnv();
  const caps = {
    structuredOutput: CAP_STATES.FAILED,
    toolCalling: CAP_STATES.NOT_APPLICABLE,
    streaming: CAP_STATES.UNPROBED,
    contextWindow: { status: CAP_STATES.DEMONSTRATED, configured: 16384, source: 'operator', demonstratedAt: 12000 },
  };
  const w = writeReceipt(baseInput(), {
    capabilities: caps,
    probeResults: { contextDemonstratedAt: 12000, normalizerVerdict: 'ok', toolTranscriptDigest: null },
  });
  assert.equal(w.capabilities.structuredOutput, 'failed');
  assert.equal(w.capabilities.toolCalling, 'not_applicable');
  assert.equal(w.capabilities.streaming, 'unprobed');
  assert.deepEqual(w.capabilities.contextWindow, {
    status: 'demonstrated',
    configured: 16384,
    source: 'operator',
    demonstratedAt: 12000,
  });
  assert.equal(w.probeResults.contextDemonstratedAt, 12000);
  // unspecified rows default to `unprobed`, never upward into a pass
  const bare = writeReceipt({ ...baseInput(), requestedModelId: 'bare:1b' }, {});
  assert.equal(bare.capabilities.structuredOutput, 'unprobed');
  assert.equal(bare.capabilities.contextWindow.status, 'unprobed');
});

// ---- 10. §9.4 per-seat requirement matrix ----------------------------------

test('words_reviewer needs structuredOutput+streaming+contextWindow demonstrated', () => {
  freshEnv();
  // required row unprobed → ineligible, naming the missing probe (control after).
  // The other required rows carry full evidence so ONLY structuredOutput is unmet.
  writeReceipt(baseInput(), {
    capabilities: {
      structuredOutput: CAP_STATES.UNPROBED,
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 24000 },
    },
    probeResults: demoProbe(),
  });
  const bad = qualifySeat(baseInput());
  assert.equal(bad.qualified, false);
  assert.equal(bad.reason, 'requirements_unmet');
  assert.deepEqual(bad.missing, ['structuredOutput']);

  // a required row that FAILED is equally ineligible (not distinguishable upward)
  writeReceipt(baseInput(), {
    capabilities: {
      structuredOutput: CAP_STATES.FAILED,
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 24000 },
    },
    probeResults: demoProbe(),
  });
  assert.deepEqual(qualifySeat(baseInput()).missing, ['structuredOutput']);

  // break-on-purpose control: all required rows demonstrated WITH evidence → qualified
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  const good = qualifySeat(baseInput());
  assert.equal(good.qualified, true);
  assert.equal(good.reason, 'demonstrated');
});

test('words_maker records structuredOutput as not_applicable and it never blocks the seat', () => {
  freshEnv();
  const maker = { ...baseInput(), seatType: 'words_maker' };
  assert.equal(SEAT_REQUIREMENTS.words_maker.structuredOutput, 'n/a');
  // OMIT the n/a row: the §9.4 matrix records it as not_applicable, NOT unprobed
  // (§9.4:1415-1418) — a contract-inapplicable row is never misreported as unchecked.
  const w = writeReceipt(maker, {
    capabilities: {
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 20000 },
    },
  });
  assert.equal(w.capabilities.structuredOutput, CAP_STATES.NOT_APPLICABLE, 'n/a row stored as not_applicable');
  const q = qualifySeat(maker);
  assert.equal(q.qualified, true, 'an n/a row never blocks qualification');

  // but a required row still gates
  writeReceipt(maker, {
    capabilities: {
      streaming: CAP_STATES.UNPROBED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 20000 },
    },
  });
  assert.deepEqual(qualifySeat(maker).missing, ['streaming']);
});

test('an n/a row is forced to not_applicable even when the caller supplies a verdict', () => {
  freshEnv();
  const maker = { ...baseInput(), seatType: 'words_maker' };
  // words_maker: structuredOutput + toolCalling are BOTH n/a (§9.4). A caller that
  // hands `demonstrated` for either must not have it persisted — n/a is never probed.
  const w = writeReceipt(maker, {
    capabilities: {
      structuredOutput: CAP_STATES.DEMONSTRATED, // false claim on an n/a row
      toolCalling: CAP_STATES.DEMONSTRATED, // false claim on an n/a row
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 20000 },
    },
  });
  assert.equal(w.capabilities.structuredOutput, CAP_STATES.NOT_APPLICABLE, 'n/a row is never a false demonstrated');
  assert.equal(w.capabilities.toolCalling, CAP_STATES.NOT_APPLICABLE);
  // and the durable bytes on disk carry not_applicable, not the forged claim
  const stored = JSON.parse(readFileSync(onlyReceiptFile(), 'utf8'));
  assert.equal(stored.capabilities.structuredOutput, CAP_STATES.NOT_APPLICABLE);
  assert.equal(stored.capabilities.toolCalling, CAP_STATES.NOT_APPLICABLE);
  // control: the row the contract DOES exercise keeps the caller's verdict
  assert.equal(w.capabilities.streaming, CAP_STATES.DEMONSTRATED);
});

test('a missing / voided receipt is ineligible with the fix named', () => {
  freshEnv();
  const missing = qualifySeat(baseInput());
  assert.equal(missing.qualified, false);
  assert.equal(missing.reason, 'missing');
  assert.match(missing.fix, /probe/i);

  writeReceipt(baseInput(), { capabilities: demoCaps() });
  const drifted = { ...baseInput(), promptEnvelopeVersion: 'words_reviewer-env-9' };
  const voided = qualifySeat(drifted);
  assert.equal(voided.qualified, false);
  assert.equal(voided.reason, 'voided');
  assert.equal(voided.component, 'promptEnvelopeVersion');
  assert.match(voided.fix, /promptEnvelopeVersion/);
});

test('qualifySeat refuses the inert gate_reviewer / agent_maker placeholders', () => {
  freshEnv();
  for (const seatType of ['gate_reviewer', 'agent_maker']) {
    assert.ok(SEAT_REQUIREMENTS[seatType], `${seatType} row exists in the matrix data`);
    assert.ok(!WORDS_SEATS.includes(seatType));
    assert.throws(() => qualifySeat({ ...baseInput(), seatType }), /inert.*placeholder|words seats/i);
  }
});

// ---- 11. a demonstrated row without its probe evidence cannot seat (§9.2) ---
// §9.2:1390-1393 requires the receipt to record each probe's RESULT; a
// `demonstrated` status with a null result is an unsupported claim that must not
// qualify. Each half is paired with a break-on-purpose control that DOES qualify
// once the evidence is supplied.

test('demonstrated contextWindow without a measured demonstratedAt does not seat', () => {
  freshEnv();
  writeReceipt(baseInput(), {
    capabilities: {
      structuredOutput: CAP_STATES.DEMONSTRATED,
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED }, // no measured size
    },
    probeResults: { normalizerVerdict: 'schema-ok' },
  });
  const bad = qualifySeat(baseInput());
  assert.equal(bad.qualified, false, 'a context claim with no measured size cannot seat a model');
  assert.ok(bad.missing.includes('contextWindow'));

  // break-on-purpose control: supplying the measured size qualifies
  writeReceipt(baseInput(), {
    capabilities: {
      structuredOutput: CAP_STATES.DEMONSTRATED,
      streaming: CAP_STATES.DEMONSTRATED,
      contextWindow: { status: CAP_STATES.DEMONSTRATED, demonstratedAt: 24000 },
    },
    probeResults: { normalizerVerdict: 'schema-ok' },
  });
  assert.equal(qualifySeat(baseInput()).qualified, true);
});

test('demonstrated structuredOutput without a normalizer verdict does not seat', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: { normalizerVerdict: null } });
  const bad = qualifySeat(baseInput());
  assert.equal(bad.qualified, false, 'a structured-output claim with no normalizer verdict cannot seat');
  assert.ok(bad.missing.includes('structuredOutput'));

  // break-on-purpose control: supplying the verdict qualifies
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  assert.equal(qualifySeat(baseInput()).qualified, true);
});

// ---- 12. direct_https words seat: full-base-URL identity + path sensitivity --

test('direct_https words seat round-trips and its full base URL is component 5', () => {
  freshEnv();
  const fp = computeFingerprint(directHttpsInput());
  assert.match(fp.fingerprint, /^qual1:[0-9a-f]{64}$/);
  assert.equal(componentValue(fp, 'connection'), 'direct_https https://api.together.xyz/v1');
  // full write → read → qualify for the hosted reviewer seat (env-auth key)
  writeReceipt(directHttpsInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  assert.equal(readReceipt(directHttpsInput()).ok, true);
  assert.equal(qualifySeat(directHttpsInput()).qualified, true);
});

test('direct_https component 5 is path-sensitive at the fingerprint layer and is its own tuple slot', () => {
  freshEnv();
  const base = computeFingerprint(directHttpsInput());
  const otherPath = clone(directHttpsInput());
  otherPath.connection = 'direct_https https://api.together.xyz/v2'; // same host, different path
  const flipped = computeFingerprint(otherPath);
  assert.notEqual(flipped.fingerprint, base.fingerprint, 'a base-URL path change flips the fingerprint');
  assert.equal(firstDiff(base.components, flipped.components), 'connection');

  // end-to-end: connection is a KEY axis (§9.2 tuple), so the /v2 path is a DIFFERENT
  // qualification question — its own absent slot (missing) — while the probed /v1 tuple
  // survives untouched, never silently answered for by a different endpoint's receipt.
  writeReceipt(directHttpsInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  const drifted = qualifySeat(otherPath);
  assert.equal(drifted.qualified, false);
  assert.equal(drifted.reason, 'missing');
  assert.equal(qualifySeat(directHttpsInput()).qualified, true); // control: /v1 still qualifies
});

// ---- 13. on-disk integrity: components must be complete AND hash-matched -----
// A receipt whose raw components are deleted or altered while the fingerprint,
// capabilities, and expiry are retained is corrupt — it must NOT read/qualify on
// the fingerprint alone (finding 1).

test('a receipt with its components deleted (fingerprint retained) does not read or qualify', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  assert.equal(qualifySeat(baseInput()).qualified, true); // control: intact receipt qualifies

  const path = onlyReceiptFile();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  delete data.components; // fingerprint/capabilities/expiry all still present
  writeFileSync(path, JSON.stringify(data));

  const read = readReceipt(baseInput());
  assert.equal(read.ok, false, 'a receipt missing its raw components cannot read');
  assert.equal(qualifySeat(baseInput()).qualified, false, 'and cannot seat a model');
});

test('a receipt whose components were altered (fingerprint retained) voids on the self-hash', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() });
  const path = onlyReceiptFile();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  // flip a stored raw component value but keep the original fingerprint
  data.components.find((c) => c.name === 'serverAnchors').value = 'digest=FORGED;quant=Q4_K_M;ctx=32768';
  writeFileSync(path, JSON.stringify(data));
  const read = readReceipt(baseInput());
  assert.equal(read.ok, false);
  assert.equal(read.state, 'voided', 'stored components no longer hash to the stored fingerprint');
});

// ---- 14. reads never mint a machine salt (finding 3) ------------------------

test('reading an unprobed env-auth seat mints no machine salt', () => {
  freshEnv();
  const saltFile = join(process.env.STUDIO_GRANDFATHER_DIR, '.machine-salt');
  assert.equal(readReceipt(baseInput()).state, 'missing');
  assert.equal(qualifySeat(baseInput()).reason, 'missing');
  assert.equal(existsSync(saltFile), false, 'a missing-receipt read requires no credential HMAC and mints no salt');
});

test('after the salt for an existing env-auth receipt is lost, a read refuses rather than minting a new salt', () => {
  freshEnv();
  writeReceipt(baseInput(), { capabilities: demoCaps(), probeResults: demoProbe() }); // mints the salt
  const saltFile = join(process.env.STUDIO_GRANDFATHER_DIR, '.machine-salt');
  assert.ok(existsSync(saltFile), 'the write minted the salt');
  rmSync(saltFile); // simulate the salt being lost
  const read = readReceipt(baseInput());
  assert.equal(read.ok, false);
  assert.equal(read.state, 'credential_unavailable', 'refuse so the original salt can be restored');
  assert.equal(existsSync(saltFile), false, 'the read did NOT silently mint a replacement salt');
});

// ---- teardown --------------------------------------------------------------

delete process.env.STUDIO_GRANDFATHER_DIR;
delete process.env.STUDIO_CAPABILITY_DIR;
delete process.env.STUDIO_CAPABILITY_TTL_DAYS;
for (const d of dirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}

function componentValue(fp, name) {
  return fp.components.find((c) => c.name === name).value;
}

console.log(`\ncapabilities.test.mjs: ${passed} tests passed`);
