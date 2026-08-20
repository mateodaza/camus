// Unit tests for the §7 fail-closed grandfather sidecar (RFC acceptance tests
// 5 [grandfather shapes] + 14). Every refusal has a break-on-purpose companion:
// after asserting the refusal, we mutate the guarded state so the guard PASSES
// and prove the entry then loads — so a guard that always-refused would fail the
// companion, and a guard that never-refused would fail the refusal assertion.
//
// No secret-shaped fixture is ever a literal: salts and markers are computed with
// node:crypto here exactly as the module does, never pasted in.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initGrandfather, consult, confirmLegacy } from './grandfather.mjs';

// ---- fixtures (assembled, never literal) -----------------------------------

const SEP = String.fromCharCode(0x1f);
const NULL_WHY = String.fromCharCode(0x00) + 'null';

const OLLAMA = { backendName: 'ollama', url: 'http://192.168.1.9:11434/v1' };
const LMSTUDIO = { backendName: 'lmstudio', url: 'http://10.0.0.4:1234/v1' };
const PASTED = { backendName: 'pasted', url: 'http://172.16.0.5:8000/v1' };

const dirs = [];
function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'gf-test-'));
  dirs.push(dir);
  process.env.STUDIO_GRANDFATHER_DIR = dir;
  return {
    dir,
    json: join(dir, 'grandfather.json'),
    marker: join(dir, 'grandfather.initialized'),
    salt: join(dir, '.machine-salt'),
  };
}

function readSalt(p) {
  return Buffer.from(readFileSync(p.salt, 'utf8').trim(), 'hex');
}
function markerFor(salt, r) {
  const why = r.why === null || r.why === undefined ? NULL_WHY : r.why;
  const fields = [r.backendName, r.url, r.source, why, r.recordedAt];
  const msg = fields.map((f) => `${Buffer.byteLength(f, 'utf8')}${SEP}${f}`).join(SEP);
  return createHmac('sha256', salt).update(msg, 'utf8').digest('hex');
}
function readJson(p) {
  return JSON.parse(readFileSync(p.json, 'utf8'));
}
function writeJson(p, data) {
  writeFileSync(p.json, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
function mode(path) {
  return statSync(path).mode & 0o777;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- 1. records-then-marker atomic init, once ------------------------------

test('init writes records then marker, 0600, and is a no-op on re-run', () => {
  const p = freshEnv();
  const res = initGrandfather({ legacyEntries: [OLLAMA] });
  assert.equal(res.action, 'inventory');

  assert.ok(existsSync(p.json) && existsSync(p.marker), 'both artifacts present');
  assert.equal(mode(p.json), 0o600);
  assert.equal(mode(p.marker), 0o600);

  const data = readJson(p);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].source, 'snapshot');
  assert.equal(data.records[0].why, null);
  // marker over the record verifies with the on-disk salt
  const salt = readSalt(p);
  assert.equal(markerFor(salt, data.records[0]), data.records[0].marker);
  // marker metadata matches the records file (also true after crash recovery)
  const mk = JSON.parse(readFileSync(p.marker, 'utf8'));
  assert.equal(mk.initializedAt, data.initializedAt);
  assert.equal(mk.releaseVersion, data.releaseVersion);
  assert.equal(mode(p.salt), 0o600);

  // idempotent: a second init NEVER re-snapshots, even with new entries
  const before = readFileSync(p.json, 'utf8');
  const res2 = initGrandfather({ legacyEntries: [OLLAMA, LMSTUDIO] });
  assert.equal(res2.action, 'noop');
  assert.equal(readFileSync(p.json, 'utf8'), before, 'no re-snapshot on re-init');
  assert.equal(readJson(p).records.length, 1);

  // the snapshotted entry loads
  const loaded = consult(OLLAMA);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.record.backendName, 'ollama');
});

// ---- 2. marker-present + corrupt json -> refuse, no re-snapshot -------------
// deleted / truncated / wrong-version / HMAC-broken, each with a break-on-purpose
// companion (repair the guarded state -> it loads).

test('marker-present corrupt grandfather.json refuses every legacy_http entry, no re-snapshot', () => {
  for (const kind of ['deleted', 'truncated', 'wrong-version', 'hmac-broken']) {
    const p = freshEnv();
    initGrandfather({ legacyEntries: [OLLAMA, LMSTUDIO] });
    const good = readFileSync(p.json, 'utf8'); // valid snapshot, for the repair step
    let expectedState;

    if (kind === 'deleted') {
      rmSync(p.json);
      expectedState = 'missing';
    } else if (kind === 'truncated') {
      writeFileSync(p.json, '{ "schemaVersion": 1, "records"', { mode: 0o600 });
      expectedState = 'unparseable';
    } else if (kind === 'wrong-version') {
      const d = JSON.parse(good);
      d.schemaVersion = 2;
      writeJson(p, d);
      expectedState = 'wrong-version';
    } else {
      const d = JSON.parse(good);
      d.records[0].marker = d.records[0].marker.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
      writeJson(p, d);
      expectedState = 'HMAC-broken';
    }

    const corrupt = existsSync(p.json) ? readFileSync(p.json, 'utf8') : null;

    // EVERY legacy_http entry refuses, and the state is named
    for (const e of [OLLAMA, LMSTUDIO]) {
      const r = consult(e);
      assert.equal(r.ok, false, `${kind}: ${e.backendName} refuses`);
      assert.equal(r.state, expectedState, `${kind}: state named`);
      assert.match(r.message, new RegExp(expectedState), `${kind}: message names state`);
    }
    // marker untouched; NO re-snapshot fired (file unchanged / still absent)
    assert.equal(existsSync(p.marker), true, `${kind}: marker still present`);
    if (corrupt === null) {
      assert.equal(existsSync(p.json), false, `${kind}: records not regenerated`);
    } else {
      assert.equal(readFileSync(p.json, 'utf8'), corrupt, `${kind}: records not regenerated`);
    }

    // break-on-purpose companion: repair the guarded state -> it loads again,
    // proving the refusal was gated on the corruption, not always-on.
    writeFileSync(p.json, good, { mode: 0o600 });
    const repaired = consult(OLLAMA);
    assert.equal(repaired.ok, true, `${kind}: loads after repair`);
  }
});

// ---- 3. crash recovery: finish the marker only, never re-inventory ----------

test('crash recovery finishes the marker only; crash-window entry stays refused', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  const snapshot = readFileSync(p.json, 'utf8');

  // simulate a crash between records-write and marker-write
  rmSync(p.marker);
  assert.equal(existsSync(p.marker), false);

  // PASTED is a legacy-shaped entry added to config DURING the crash window.
  // A caller entering after the crash consults it: recovery finishes the marker
  // (validating the existing records ONLY), then PASTED refuses as unrecorded.
  const refused = consult(PASTED);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unrecorded');
  assert.match(refused.message, /loopback/);
  assert.match(refused.message, /ssh_tunnel/);
  assert.match(refused.message, /HTTPS/);
  assert.match(refused.message, /confirmLegacy/);

  // marker finished, records validated, inventory NOT re-run (still just OLLAMA)
  assert.equal(existsSync(p.marker), true, 'marker finished');
  assert.equal(readFileSync(p.json, 'utf8'), snapshot, 'records untouched by recovery');
  assert.equal(readJson(p).records.length, 1);
  assert.equal(consult(OLLAMA).ok, true, 'existing record still validates');

  // init-path recovery also refuses to re-inventory even when handed new entries
  const p2 = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  rmSync(p2.marker);
  const rec = initGrandfather({ legacyEntries: [OLLAMA, LMSTUDIO, PASTED] });
  assert.equal(rec.action, 'recovered');
  assert.equal(readJson(p2).records.length, 1, 'recovery never sweeps in new entries');
  assert.equal(existsSync(p2.marker), true);
  assert.equal(
    JSON.parse(readFileSync(p2.marker, 'utf8')).initializedAt,
    readJson(p2).initializedAt,
    'recovery preserves the original initialization timestamp'
  );
  assert.equal(consult(PASTED).ok, false, 'crash-window entry still refused after recovery');

  // break-on-purpose companion: the ONLY escape is an explicit confirmation.
  confirmLegacy(PASTED.backendName, PASTED.url, 'trusted LAN box, slice-D tunnel pending');
  assert.equal(consult(PASTED).ok, true, 'loads after explicit confirmation');
});

// ---- 4. record copied from another machine (different salt) fails HMAC ------

test('a record copied from another machine (different salt) fails HMAC and refuses', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  const originalSalt = readFileSync(p.salt, 'utf8');

  // overwrite the machine salt with a DIFFERENT random salt (as if the records
  // were restored from another machine's backup). No literal — freshly generated.
  const foreignSalt = randomBytes(32).toString('hex');
  assert.notEqual(foreignSalt, originalSalt.trim());
  writeFileSync(p.salt, foreignSalt, { mode: 0o600 });

  const r = consult(OLLAMA);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'HMAC-broken');

  // break-on-purpose companion: restore the true salt -> the record validates,
  // proving the refusal was gated on the HMAC, not always-on.
  writeFileSync(p.salt, originalSalt, { mode: 0o600 });
  assert.equal(consult(OLLAMA).ok, true, 'loads once the true salt is restored');
});

// ---- 5. confirmLegacy appends, then the entry loads ------------------------

test('confirmLegacy is the only post-marker mint path; entry refuses, then loads', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });

  // pre-confirmation: refuses (break-on-purpose baseline)
  assert.equal(consult(LMSTUDIO).ok, false);

  const why = 'internal LM Studio host, approved by ops';
  const res = confirmLegacy(LMSTUDIO.backendName, LMSTUDIO.url, why);
  assert.equal(res.ok, true);
  assert.equal(res.record.source, 'operator_confirmation');
  assert.equal(res.record.why, why);

  const loaded = consult(LMSTUDIO);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.record.source, 'operator_confirmation');
  assert.equal(loaded.record.why, why);
  // append, not replace
  assert.equal(readJson(p).records.length, 2);
});

// ---- 6. editing source or why breaks the marker ----------------------------

test('editing a record source or why breaks its marker (both inside the HMAC)', () => {
  for (const field of ['source', 'why']) {
    const p = freshEnv();
    initGrandfather({ legacyEntries: [OLLAMA] });
    confirmLegacy(LMSTUDIO.backendName, LMSTUDIO.url, 'ops-approved LAN host');
    const good = readFileSync(p.json, 'utf8');

    // tamper with provenance WITHOUT recomputing the marker
    const d = JSON.parse(good);
    const rec = d.records.find((r) => r.backendName === LMSTUDIO.backendName);
    const originalMarker = rec.marker;
    if (field === 'source') rec.source = 'snapshot';
    else rec.why = 'a different reason than was confirmed';
    assert.notEqual(markerFor(readSalt(p), rec), originalMarker, `${field} changes the HMAC input`);
    writeJson(p, d);

    const r = consult(LMSTUDIO);
    assert.equal(r.ok, false, `${field} edit refuses`);
    assert.ok(
      r.state === 'HMAC-broken' || r.state === 'unparseable',
      `${field} edit fails schema or HMAC validation`
    );

    // break-on-purpose companion: restore the untampered record -> it loads.
    writeFileSync(p.json, good, { mode: 0o600 });
    assert.equal(consult(LMSTUDIO).ok, true, `${field}: loads after restore`);
  }
});

// ---- 7. confirmLegacy requires a non-empty operator reason -----------------

test('confirmLegacy requires a non-empty reason (missing/null/empty/whitespace throw)', () => {
  freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });

  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(
      () => confirmLegacy(LMSTUDIO.backendName, LMSTUDIO.url, bad),
      /reason|why/i,
      `reason ${JSON.stringify(bad)} is rejected`
    );
  }
  // no confirmation was minted by any of the rejected calls
  assert.equal(consult(LMSTUDIO).ok, false, 'no record minted without a reason');

  // break-on-purpose companion: a real reason mints and loads
  confirmLegacy(LMSTUDIO.backendName, LMSTUDIO.url, 'ops-approved LAN host');
  assert.equal(consult(LMSTUDIO).ok, true, 'loads once a real reason is given');
});

// ---- 8. confirmLegacy is the promised per-entry recovery from corruption ----

test('confirmLegacy recovers per-entry from a corrupt records file (marker present)', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });

  // corrupt the records file; marker stays present -> every entry refuses
  writeFileSync(p.json, '{ not valid json', { mode: 0o600 });
  assert.equal(consult(OLLAMA).ok, false, 'refuses while corrupt');

  // the refusal promises confirmLegacy as recovery: re-confirm rebuilds a fresh
  // records file seeded with this explicit confirmation.
  const res = confirmLegacy(OLLAMA.backendName, OLLAMA.url, 'ops re-confirmed after sidecar corruption');
  assert.equal(res.ok, true);
  assert.equal(res.record.source, 'operator_confirmation');

  const loaded = consult(OLLAMA);
  assert.equal(loaded.ok, true, 'loads after per-entry recovery from a corrupt state');
  assert.equal(readJson(p).records.length, 1, 'fresh records seeded with the confirmation');
});

// ---- 9. source/why cannot be shifted across the field separator ------------

test('a record whose why straddles SEP cannot be re-split into source without breaking the marker', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });

  // a legitimate reason that itself contains the field separator
  const why = 'left' + SEP + 'right';
  confirmLegacy(LMSTUDIO.backendName, LMSTUDIO.url, why);
  assert.equal(consult(LMSTUDIO).ok, true, 'the SEP-bearing reason loads as minted');
  const good = readFileSync(p.json, 'utf8');

  // shift the SEP boundary: move "left" out of why and into source, keep the OLD
  // marker. Under a plain join this produced an identical HMAC input; it must not.
  const d = JSON.parse(good);
  const rec = d.records.find((r) => r.backendName === LMSTUDIO.backendName);
  const originalMarker = rec.marker;
  rec.source = 'operator_confirmation' + SEP + 'left';
  rec.why = 'right';
  assert.notEqual(markerFor(readSalt(p), rec), originalMarker, 'shift changes canonical HMAC input');
  writeJson(p, d);
  assert.equal(consult(LMSTUDIO).ok, false, 'the shifted record does not validate');

  // break-on-purpose companion: restore the untampered record -> it loads.
  writeFileSync(p.json, good, { mode: 0o600 });
  assert.equal(consult(LMSTUDIO).ok, true, 'loads after restore');
});

// ---- 10. malformed local trust state and inputs fail closed ----------------

test('malformed salt, records, and API inputs cannot mint or load trust', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });

  writeFileSync(p.salt, 'not-a-32-byte-hex-salt', { mode: 0o600 });
  assert.throws(() => consult(OLLAMA), /machine salt is invalid/i);

  // A fresh fixture proves malformed public inputs fail before any record is minted.
  freshEnv();
  assert.throws(
    () => initGrandfather({ legacyEntries: [{ backendName: '', url: OLLAMA.url }] }),
    /backendName and url/
  );

  const p3 = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  assert.throws(() => confirmLegacy('', OLLAMA.url, 'reason'), /backendName and url/);
  assert.throws(() => consult({ backendName: OLLAMA.backendName, url: '' }), /backendName and url/);

  const malformed = readJson(p3);
  malformed.records[0].why = 'snapshot reasons are forbidden';
  malformed.records[0].marker = markerFor(readSalt(p3), malformed.records[0]);
  writeJson(p3, malformed);
  const refused = consult(OLLAMA);
  assert.equal(refused.ok, false);
  assert.equal(refused.state, 'unparseable');
});

test('a missing persisted salt refuses without silently minting a replacement', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  rmSync(p.salt);

  // Restart initialization is a true no-op and must not create a new key that
  // makes the existing HMACs permanently look tampered.
  assert.equal(initGrandfather({ legacyEntries: [OLLAMA] }).action, 'noop');
  assert.equal(existsSync(p.salt), false, 'no-op initialization does not replace the salt');
  assert.throws(() => consult(OLLAMA), /machine salt is missing/i);
  assert.equal(existsSync(p.salt), false, 'failed consultation does not replace the salt');
});

test('invalid crash-window records retain their exact refusal state', () => {
  const p = freshEnv();
  initGrandfather({ legacyEntries: [OLLAMA] });
  rmSync(p.marker);
  writeFileSync(p.json, '{ truncated', { mode: 0o600 });

  const refused = consult(OLLAMA);
  assert.equal(refused.ok, false);
  assert.equal(refused.state, 'unparseable');
  assert.equal(existsSync(p.marker), false, 'invalid records never finish the marker');
});

// ---- teardown --------------------------------------------------------------

delete process.env.STUDIO_GRANDFATHER_DIR;
for (const d of dirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}
console.log(`\ngrandfather.test.mjs: ${passed} tests passed`);
