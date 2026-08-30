// Codex reviewer adapter. The spawn contract is ported from camus
// (skills/camus/scripts/codex_review.sh): `codex exec --json -s read-only
// --output-schema <schema> -o <last_file> "<prompt>"`, stdin ignored, verdict
// captured from the -o file, and — the part that matters — fail-closed
// normalization: unparseable, empty, or self-inconsistent output is an infra
// error, never a clean verdict.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModels } from '../models.mjs';
import { runCodeOwnedProcess } from '../code-owned-process.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'checks', 'review.schema.json');

const IDLE_KILL_MS = Number(process.env.REVIEW_IDLE_MS || 300_000);
const TOTAL_TIMEOUT_MS = { low: 420_000, medium: 600_000, high: 900_000, xhigh: 1_200_000 };
const ASSESSMENT_ARRAYS = ['claim_assessments', 'coverage_assessments', 'threshold_assessments'];

// Independent code review has no prose-lane ledgers. Constrain that fact in
// code, not only in prose: otherwise a reviewer can invent C1/C2 identifiers
// from the acceptance text and turn an otherwise valid verdict into infra.
// Generic words reviews keep the tracked schema and exact-ledger validator.
export function emptyAssessmentReviewSchema(schema) {
  const scoped = structuredClone(schema);
  for (const key of ASSESSMENT_ARRAYS) {
    if (scoped?.properties?.[key]?.type !== 'array') throw new Error(`review schema is missing array property ${key}`);
    scoped.properties[key].maxItems = 0;
  }
  return scoped;
}

async function reviewSchemaPath(dir, emptyAssessmentLedgers) {
  if (!emptyAssessmentLedgers) return SCHEMA_PATH;
  const schema = emptyAssessmentReviewSchema(JSON.parse(await readFile(SCHEMA_PATH, 'utf8')));
  const path = join(dir, 'review-empty-ledgers.schema.json');
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function infraError(error) {
  return { ran: false, error, verdict: 'ERROR', findings: [], questions: [], claimAssessments: [], coverageAssessments: [], thresholdAssessments: [] };
}

// Mirrors camus's normalize_codex guards, adapted to the content schema.
export function normalizeReview(raw, exitCode, expectedClaims = [], expectedCriteria = [], expectedThresholds = []) {
  if (exitCode !== 0) return infraError(`codex exec exited ${exitCode}`);
  if (!raw || !raw.trim()) return infraError('empty codex output');
  let data;
  try {
    data = JSON.parse(raw.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, ''));
  } catch {
    return infraError(`unparseable codex output: ${raw.slice(0, 160)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return infraError('codex output is not a JSON object');
  }
  if (!['revise', 'clean'].includes(data.verdict)) {
    return infraError(`missing/invalid verdict: ${JSON.stringify(data.verdict)}`);
  }
  if (!Array.isArray(data.findings)) return infraError('findings is not an array');
  for (const f of data.findings) {
    if (!['high', 'medium', 'low'].includes(f?.severity) || !f?.title) {
      return infraError('finding has missing/invalid severity or title');
    }
  }
  if (!Array.isArray(data.questions_for_human)) return infraError('questions_for_human is not an array');
  if (!Array.isArray(data.claim_assessments)) return infraError('claim_assessments is not an array');
  const expectedMarkers = expectedClaims.map((c) => c.marker);
  const seen = new Set();
  for (const a of data.claim_assessments) {
    if (!a || typeof a.marker !== 'string' || !['supported', 'unsupported', 'unchecked'].includes(a.decision) || typeof a.evidence !== 'string' || !a.evidence.trim()) {
      return infraError('claim assessment needs marker, supported|unsupported|unchecked decision, and evidence/reason');
    }
    if (seen.has(a.marker)) return infraError(`duplicate claim assessment for ${a.marker}`);
    seen.add(a.marker);
  }
  const missing = expectedMarkers.filter((m) => !seen.has(m));
  const extra = [...seen].filter((m) => !expectedMarkers.includes(m));
  if (missing.length || extra.length) {
    return infraError(`claim assessment coverage mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  if (!Array.isArray(data.coverage_assessments)) return infraError('coverage_assessments is not an array');
  const expectedCriterionIds = expectedCriteria.map((c) => c.id);
  const seenCriteria = new Set();
  for (const a of data.coverage_assessments) {
    if (!a || typeof a.criterion_id !== 'string' || !['met', 'unmet', 'unclear'].includes(a.decision) || typeof a.evidence !== 'string' || !a.evidence.trim()) {
      return infraError('coverage assessment needs criterion_id, met|unmet|unclear decision, and evidence/reason');
    }
    if (seenCriteria.has(a.criterion_id)) return infraError(`duplicate coverage assessment for ${a.criterion_id}`);
    seenCriteria.add(a.criterion_id);
  }
  const missingCriteria = expectedCriterionIds.filter((id) => !seenCriteria.has(id));
  const extraCriteria = [...seenCriteria].filter((id) => !expectedCriterionIds.includes(id));
  if (missingCriteria.length || extraCriteria.length) {
    return infraError(`coverage assessment mismatch (missing: ${missingCriteria.join(', ') || 'none'}; extra: ${extraCriteria.join(', ') || 'none'})`);
  }
  if (!Array.isArray(data.threshold_assessments)) return infraError('threshold_assessments is not an array');
  const expectedThresholdIds = expectedThresholds.map((t) => t.id);
  const seenThresholds = new Set();
  for (const a of data.threshold_assessments) {
    if (!a || typeof a.id !== 'string' || !['policy', 'observed'].includes(a.decision) || typeof a.evidence !== 'string' || !a.evidence.trim()) {
      return infraError('threshold assessment needs id, policy|observed decision, and evidence/reason');
    }
    if (seenThresholds.has(a.id)) return infraError(`duplicate threshold assessment for ${a.id}`);
    seenThresholds.add(a.id);
  }
  const missingThresholds = expectedThresholdIds.filter((id) => !seenThresholds.has(id));
  const extraThresholds = [...seenThresholds].filter((id) => !expectedThresholdIds.includes(id));
  if (missingThresholds.length || extraThresholds.length) {
    return infraError(`threshold assessment mismatch (missing: ${missingThresholds.join(', ') || 'none'}; extra: ${extraThresholds.join(', ') || 'none'})`);
  }
  const blocking = data.findings.filter((f) => f.severity !== 'low');
  // Consistency guards: a verdict may not contradict its own findings.
  if (data.verdict === 'revise' && blocking.length === 0 && !(data.questions_for_human?.length)) {
    return infraError("inconsistent: 'revise' with no blocking findings and no questions");
  }
  if (data.verdict === 'clean' && blocking.length > 0) {
    return infraError("inconsistent: 'clean' with blocking findings");
  }
  const unsupported = data.claim_assessments.filter((a) => a.decision === 'unsupported');
  const unchecked = data.claim_assessments.filter((a) => a.decision === 'unchecked');
  const unmet = data.coverage_assessments.filter((a) => a.decision === 'unmet');
  const unclear = data.coverage_assessments.filter((a) => a.decision === 'unclear');
  if (unsupported.length && data.verdict === 'clean') {
    return infraError("inconsistent: 'clean' with unsupported claim assessments");
  }
  if (unsupported.length && blocking.length === 0) {
    return infraError("inconsistent: unsupported claims need a blocking finding");
  }
  if (unchecked.length && data.verdict === 'clean' && !data.findings.some((f) => f.severity === 'low')) {
    return infraError("inconsistent: unchecked claims on a clean verdict need a low-severity caveat");
  }
  if (unmet.length && data.verdict === 'clean') {
    return infraError("inconsistent: 'clean' with unmet acceptance criteria");
  }
  if (unmet.length && blocking.length === 0) {
    return infraError('inconsistent: unmet acceptance criteria need a blocking finding');
  }
  if (unclear.length && data.verdict === 'clean' && !data.findings.some((f) => f.severity === 'low')) {
    return infraError('inconsistent: unclear acceptance criteria on a clean verdict need a low-severity caveat');
  }
  // An `observed` threshold is a statistic wearing the proposed-policy marker to
  // dodge the citation gate — laundering. It can never ride a clean verdict, and
  // it must carry a blocking finding just like an unsupported claim.
  const observedThresholds = data.threshold_assessments.filter((a) => a.decision === 'observed');
  if (observedThresholds.length && data.verdict === 'clean') {
    return infraError("inconsistent: 'clean' with a proposed threshold assessed as observed performance");
  }
  if (observedThresholds.length && blocking.length === 0) {
    return infraError('inconsistent: a threshold carrying observed performance needs a blocking finding');
  }
  return {
    ran: true,
    error: null,
    verdict: data.verdict === 'clean' ? 'APPROVED' : 'REVISE',
    findings: data.findings,
    blocking,
    nonblocking: data.findings.filter((f) => f.severity === 'low'),
    questions: (data.questions_for_human ?? []).filter((q) => typeof q === 'string' && q.trim()),
    claimAssessments: data.claim_assessments,
    coverageAssessments: data.coverage_assessments,
    thresholdAssessments: data.threshold_assessments,
  };
}

export async function runCodexReview({ prompt, cwd, effort, signal, onTick, onSession, receiptDir, ownedProcessDir = null, model, claims = [], criteria = [], thresholds = [], emptyAssessmentLedgers = false }) {
  effort ||= getModels().reviewer.effort;
  model ||= getModels().reviewer.model;
  // codex resolves -o against ITS cwd, not ours — the path must be absolute.
  const dir = resolve(receiptDir);
  await mkdir(dir, { recursive: true });
  const lastFile = join(dir, 'last.json');
  const outputSchema = await reviewSchemaPath(dir, emptyAssessmentLedgers);

  // Model and effort are always named explicitly — the account default is
  // never reachable (it isn't a decision anyone made). The seat runs hardened:
  // the review judges the prompt-supplied draft and needs no execution at all.
  const args = ['exec', '--json', '-s', 'read-only', ...hardenedCodexArgs(), '-m', model, '-c', `model_reasoning_effort=${effort}`];
  if (process.env.CAMUS_CODEX_TIER) args.push('-c', `service_tier=${process.env.CAMUS_CODEX_TIER}`);
  for (const id of (process.env.CAMUS_CODEX_DISABLE_MCP || '').split(',').filter(Boolean)) {
    args.push('-c', `mcp_servers.${id.trim()}.enabled=false`);
  }
  args.push('--output-schema', outputSchema, '-o', lastFile, prompt);
  const childEnv = scrubbedEnv(process.env, (key, why) => onSession?.(`env ${key}: ${why}`));
  onSession?.('hardened seat: shell/exec, web search, browser, apps and plugins disabled by flag; no user config or MCP; ephemeral session; environment scrubbed; any unexpected tool event fails the call.');

  let stderrTail = '';
  let usage = null;
  let unexpectedTool = null;
  const startedAt = Date.now();
  const exitCode = await new Promise((done_) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(hardT); clearTimeout(idleT); done_(code); } };
    const local = new AbortController();
    let stoppedCode = null;
    const stop = code => { if (stoppedCode === null) stoppedCode = code; local.abort(new Error('adapter process stopped')); };
    const hardT = setTimeout(() => stop(-2), TOTAL_TIMEOUT_MS[effort] ?? 600_000);
    let idleT = setTimeout(() => stop(-3), IDLE_KILL_MS);
    const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => stop(-3), IDLE_KILL_MS); };

    let lastTick = 0;
    let lineBuf = '';
    const onData = (buf) => {
      if (done) return; // ignore buffers racing with abort/timeout completion
      poke();
      lineBuf += buf;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const sess = sessionLineFromCodexEvent(line);
        if (sess) onSession?.(sess);
        // A tool event this seat never granted means the verdict may rest on
        // material no receipt sealed. Kill the call and fail closed.
        const rogue = unexpectedToolEvent(line);
        if (rogue && !unexpectedTool) {
          unexpectedTool = rogue;
          onSession?.(`REFUSED: unexpected ${rogue.itemType} tool event${rogue.detail ? ` (${rogue.detail})` : ''}`);
          stop(-5);
          return;
        }
        usage = usageFromCodexEvent(line) ?? usage;
      }
      const now = Date.now();
      if (now - lastTick > 5000) {
        lastTick = now;
        const line = String(buf).split('\n').find((l) => l.trim());
        onTick?.(summarizeEvent(line));
      }
    };
    signal?.addEventListener('abort', () => stop(-4), { once: true });
    runCodeOwnedProcess({ runDir: ownedProcessDir, kind: 'codex_reviewer', command: 'codex', args,
      cwd: resolve(cwd), env: childEnv, timeoutMs: TOTAL_TIMEOUT_MS[effort] ?? 600_000,
      signal: local.signal, onStdout: onData,
      onStderr: b => { if (!done) { poke(); stderrTail = (stderrTail + b).slice(-400); } } })
      .then(result => finish(stoppedCode ?? result.code ?? -1))
      .catch(e => { stderrTail = `spawn error: ${e.code || e.message}`; finish(stoppedCode ?? -1); });
  });

  const failed = (message) => ({ ...infraError(message), usage, durationMs: Date.now() - startedAt });
  if (exitCode === -1) return failed(`failed to spawn codex (${stderrTail || 'unknown'}) — check the codex CLI is installed and on PATH`);
  if (exitCode === -2) return failed('codex review hit the hard timeout');
  if (exitCode === -3) return failed(`codex went silent for ${Math.round(IDLE_KILL_MS / 60000)} min — killed (idle watchdog)`);
  if (exitCode === -4) return failed('review aborted by user');
  if (exitCode === -5) return failed(`the reviewer seat used an unexpected ${unexpectedTool.itemType} tool${unexpectedTool.detail ? ` (${unexpectedTool.detail})` : ''}; a verdict resting on material no receipt sealed is refused as infra`);

  // "codex wrote nothing" and "the verdict file can't be read" are different
  // diagnoses — both fail closed, but only one sends you debugging codex.
  let raw = '';
  let readError = null;
  try {
    raw = await readFile(lastFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') readError = err;
  }
  const norm = readError
    ? infraError(`verdict file exists but could not be read (${readError.code || readError.message})`)
    : normalizeReview(raw, exitCode, claims, criteria, thresholds);
  norm.usage = usage;
  norm.durationMs = Date.now() - startedAt;
  if (!norm.ran && stderrTail) norm.error += ` | codex stderr: ${stderrTail.trim().split('\n').pop()}`;
  // These are actual invocation facts, not requested defaults: the adapter
  // appended both explicitly to argv and a ran:true verdict proves that exact
  // invocation completed. They ride the review event into the sealed pack.
  if (norm.ran) {
    norm.reviewerModel = model;
    norm.reviewerEffort = effort;
    // codex's --json stream does not restate the model; the argv pin plus a
    // ran:true verdict is the invocation fact, provider-qualified for receipts.
    norm.reviewerIdentity = `openai:${model}`;
  }
  return norm;
}

// Both codex seats run HARDENED (audit P1, 2026-08-04, round 2): Studio's
// words seats are prompt-in/text-out, so the agent gets NO execution
// capability at all — with the shell and unified-exec tools disabled it has
// no way to read $CODEX_HOME/auth.json (plaintext access tokens per OpenAI's
// own auth doc) or anything else, which `-s read-only` alone never prevented
// ("don't rely on read-only to protect secrets" — Codex action security doc).
// User config (and with it every user MCP server and hook) does not load,
// execpolicy rules do not load, no session files persist, and any shell that
// a future flag flip re-enabled would inherit an empty environment. Every
// flag verified against codex-cli 0.144.1 and live-fire break-tested: a
// hardened agent asked to read a planted sentinel outside the workspace
// answered CANNOT-READ while an unhardened control read it.
export function hardenedCodexArgs() {
  return [
    '--ignore-user-config', // no config.toml: no user MCP servers/hooks, no config-held credentials; auth still resolves
    '--ignore-rules', // no user/project execpolicy rules
    '--ephemeral', // no session files persisted
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '-c', 'shell_environment_policy.inherit=none',
    // Web search defaults to "cached" and is ON unless explicitly disabled —
    // omitting --search does NOT turn it off (audit P1, 2026-08-04 round 3:
    // a live gpt-5.6-sol probe under the previous arg set emitted web_search
    // events and answered from them, while the session line claimed "no web
    // search"). A words seat judges or drafts the text it was handed; an
    // uncustodied source fetched mid-review would be evidence nobody sealed.
    '-c', 'web_search="disabled"',
    // The remaining default-on capability families a text-only seat never
    // needs. Each verified to parse on codex-cli 0.144.1; disabling a family
    // that is already inert costs nothing and removes a future default flip
    // from the threat model.
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'browser_use_full_cdp_access',
    '--disable', 'in_app_browser',
    '--disable', 'computer_use',
    '--disable', 'image_generation',
    '--disable', 'multi_agent',
    '--disable', 'plugins',
    '--disable', 'hooks',
  ];
}

// A text-only seat may legitimately produce reasoning, its final message, and
// bookkeeping. ANY other item type means a tool ran — a capability this seat
// does not grant, or a new default in a future codex version. Both seats FAIL
// CLOSED on it rather than trusting an allowlist of flags to stay complete:
// flags are a promise about today's CLI, this is an observation about the run
// that actually happened. Pure, so the classifier is directly testable.
const ALLOWED_ITEM_TYPES = new Set(['reasoning', 'agent_message', 'todo_list', 'plan_update', 'error']);
export function unexpectedToolEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  const msg = ev.msg ?? ev;
  const type = msg.type || '';
  if (!/^item\.(started|completed|updated)$/.test(type)) return null;
  const item = msg.item ?? ev.item ?? {};
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (!itemType || ALLOWED_ITEM_TYPES.has(itemType)) return null;
  // Name the query/target when the event carries one, so the receipt records
  // WHAT was consulted, not merely that something was.
  const detail = [item.query, item.url, item.command, item.name, item.action?.type]
    .find((value) => typeof value === 'string' && value.trim());
  return { itemType, detail: detail ? String(detail).slice(0, 200) : null };
}

// The codex subprocesses get a MINIMAL environment: the server's env carries
// credentials (Hivemind keys, openai_compat backend keys, whatever the shell
// exported) that neither seat has any business reading. The allowlist
// covers process basics, codex's own home/auth discovery, locale/terminal,
// and proxy transport config the user set for exactly these tools. Exported
// so the scrub is directly testable.
// HOME and CODEX_HOME stay because codex resolves its own auth through them
// (`--ignore-user-config` skips config.toml but, by design, "auth still uses
// CODEX_HOME"). That is the precise boundary: the codex PROCESS can still
// authenticate itself, while the MODEL has no shell, exec, or file tool with
// which to read those paths — which is why the tool disabling above, not the
// env list, is what actually protects auth.json.
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'CODEX_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
];
const PROXY_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']);

// A proxy URL may embed credentials (http://user:pass@host). Keep the
// transport, drop the userinfo: an unparseable value is dropped entirely
// rather than passed through unexamined. If a proxy genuinely requires
// authentication the call then fails LOUDLY on the network instead of quietly
// handing a credential to a subprocess — and onStrip lets the caller say so
// in the session trail, so the operator knows exactly why.
export function scrubbedEnv(env = process.env, onStrip = null) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value === undefined) continue;
    if (!PROXY_KEYS.has(key)) { out[key] = value; continue; }
    let url;
    try { url = new URL(value); } catch { onStrip?.(key, 'unparseable'); continue; }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      onStrip?.(key, 'credentials removed');
    }
    out[key] = url.toString();
  }
  for (const key of Object.keys(env)) if (key.startsWith('LC_')) out[key] = env[key];
  return out;
}

// ---- maker seat ---------------------------------------------------------------
// Codex in the maker seat (the reversed pairing: GPT writes, Claude reviews).
// Same spawn contract as the reviewer — read-only sandbox, explicit model,
// -o captures the final agent message as the deliverable. No web search is
// enabled in this slice: the draft comes from the prompt plus any frozen
// grounding items, and the session line says so, so a contract demanding
// live-loaded URLs fails review honestly instead of being quietly faked.
// The session line claims only what the sandbox actually enforces: read-only
// blocks WRITES; codex's own tool surface (shell, user-configured MCP) can
// still run, which is why the environment is scrubbed above.
export async function runCodexMaker({ prompt, stage = 'make', model, effort = 'medium', cwd, signal, onTick, onSession, ownedProcessDir = null }) {
  const fail = (error) => ({ ok: false, error, text: null, costUsd: 0 });
  if (!model) return fail('codex maker needs an explicit model — the account default is not a decision');
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) return fail('codex maker effort must be low, medium, high, or xhigh');
  const dir = resolve(cwd);
  await mkdir(dir, { recursive: true });
  const lastFile = join(dir, `.codex-maker-${stage}.md`);

  // Legacy words calls keep medium; independent code seats can pin the maker's
  // effort explicitly, without falling through to account configuration.
  const args = ['exec', '--json', '-s', 'read-only', ...hardenedCodexArgs(), '-m', model, '-c', `model_reasoning_effort=${effort}`];
  if (process.env.CAMUS_CODEX_TIER) args.push('-c', `service_tier=${process.env.CAMUS_CODEX_TIER}`);
  for (const id of (process.env.CAMUS_CODEX_DISABLE_MCP || '').split(',').filter(Boolean)) {
    args.push('-c', `mcp_servers.${id.trim()}.enabled=false`);
  }
  args.push('-o', lastFile, prompt);
  const childEnv = scrubbedEnv(process.env, (key, why) => onSession?.(`env ${key}: ${why}`));
  onSession?.(`hardened seat: shell/exec, web search, browser, apps and plugins disabled by flag; no user config or MCP; ephemeral session; environment scrubbed; any unexpected tool event fails the call. Effort pinned ${effort}.`);

  const MAKER_TIMEOUTS = { plan: 120_000, ground: 300_000, make: 540_000, fix: 420_000 };
  let stderrTail = '';
  let usage = null;
  let unexpectedTool = null;
  const startedAt = Date.now();
  const exitCode = await new Promise((done_) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(hardT); clearTimeout(idleT); done_(code); } };
    const local = new AbortController();
    let stoppedCode = null;
    const stop = code => { if (stoppedCode === null) stoppedCode = code; local.abort(new Error('adapter process stopped')); };
    const hardT = setTimeout(() => stop(-2), MAKER_TIMEOUTS[stage] ?? 540_000);
    let idleT = setTimeout(() => stop(-3), IDLE_KILL_MS);
    const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => stop(-3), IDLE_KILL_MS); };
    let lineBuf = '';
    const onData = (buf) => {
      if (done) return;
      poke();
      lineBuf += buf;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const sess = sessionLineFromCodexEvent(line);
        if (sess) onSession?.(sess);
        // A tool event this seat never granted means the draft may rest on
        // material no receipt sealed. Kill the call and fail closed.
        const rogue = unexpectedToolEvent(line);
        if (rogue && !unexpectedTool) {
          unexpectedTool = rogue;
          onSession?.(`REFUSED: unexpected ${rogue.itemType} tool event${rogue.detail ? ` (${rogue.detail})` : ''}`);
          stop(-5);
          return;
        }
        usage = usageFromCodexEvent(line) ?? usage;
      }
      onTick?.(stage === 'plan' ? 'planning…' : 'drafting (text only)…');
    };
    signal?.addEventListener('abort', () => stop(-4), { once: true });
    runCodeOwnedProcess({ runDir: ownedProcessDir, kind: 'codex_maker', command: 'codex', args,
      cwd: dir, env: childEnv, timeoutMs: MAKER_TIMEOUTS[stage] ?? 540_000,
      signal: local.signal, onStdout: onData,
      onStderr: b => { if (!done) { poke(); stderrTail = (stderrTail + b).slice(-400); } } })
      .then(result => finish(stoppedCode ?? result.code ?? -1))
      .catch(e => { stderrTail = `spawn error: ${e.code || e.message}`; finish(stoppedCode ?? -1); });
  });

  if (exitCode === -1) return fail(`failed to spawn codex (${stderrTail || 'unknown'}) — check the codex CLI is installed and on PATH`);
  if (exitCode === -2) return fail(`codex ${stage} stage hit the hard timeout`);
  if (exitCode === -3) return fail(`codex went silent for ${Math.round(IDLE_KILL_MS / 60000)} min — killed (idle watchdog)`);
  if (exitCode === -4) return fail('aborted by user');
  if (exitCode === -5) return fail(`the maker seat used an unexpected ${unexpectedTool.itemType} tool${unexpectedTool.detail ? ` (${unexpectedTool.detail})` : ''}; a draft resting on material no receipt sealed is refused as infra`);
  if (exitCode !== 0) return fail(`codex exited ${exitCode}: ${stderrTail.slice(0, 300)}`);

  let text = '';
  try {
    text = String(await readFile(lastFile, 'utf8')).trim();
  } catch (err) {
    return fail(`codex wrote no deliverable file (${err.code || err.message})`);
  }
  if (!text) return fail('codex returned an empty deliverable');
  return {
    ok: true,
    error: null,
    text,
    costUsd: 0, // usage and time only; dollars are never invented
    usage,
    durationMs: Date.now() - startedAt,
    // The argv pin plus exit 0 and a non-empty -o file is the invocation fact.
    modelActual: `openai:${model}`,
    hivemindQueried: false,
    hivemindQueries: 0,
    hivemindQueryTexts: [],
    hivemindResults: [],
  };
}

// Usage is an observation from Codex's own completion event. Missing fields stay
// null; requested effort is never reverse-engineered into a fictional budget.
export function usageFromCodexEvent(line) {
  try {
    const ev = JSON.parse(line);
    const type = ev.msg?.type || ev.type || '';
    if (type !== 'turn.completed' || !ev.usage || typeof ev.usage !== 'object') return null;
    const value = (key) => Number.isInteger(ev.usage[key]) && ev.usage[key] >= 0 ? ev.usage[key] : null;
    return {
      input_tokens: value('input_tokens'),
      cached_input_tokens: value('cached_input_tokens'),
      output_tokens: value('output_tokens'),
    };
  } catch {
    return null;
  }
}

// One codex --json event in, at most one session line out. Exported for tests.
export function sessionLineFromCodexEvent(line) {
  try {
    const ev = JSON.parse(line);
    const t = ev.msg?.type || ev.type || '';
    if (t === 'turn.started') return 'turn started';
    if (t === 'turn.completed') {
      const u = ev.usage ?? {};
      return `turn done · ${u.input_tokens ?? '?'} in / ${u.output_tokens ?? '?'} out tokens`;
    }
    if (t === 'item.completed') {
      const item = ev.item ?? {};
      const text = String(item.summary ?? item.text ?? '').replace(/\s+/g, ' ').trim();
      if (item.type === 'reasoning') return text ? `reasoning: ${text.slice(0, 110)}` : 'reasoning…';
      if (item.type === 'agent_message') return `verdict drafted (${text.length} chars)`;
      if (text) return `${item.type}: ${text.slice(0, 90)}`;
      // A TEXTLESS item still happened. Dropping it hid web_search calls from
      // the receipt entirely (audit P1, 2026-08-04 round 3): the event carries
      // its query in `query`/`action`, not in text, so the old `text ? … : null`
      // made a tool use invisible. Name the type, and its target when present.
      if (item.type) {
        const detail = [item.query, item.url, item.command, item.name, item.action?.type]
          .find((value) => typeof value === 'string' && value.trim());
        return detail ? `${item.type}: ${String(detail).slice(0, 90)}` : `${item.type} (no detail reported)`;
      }
      return null;
    }
    if (/error/i.test(t)) return `error: ${String(ev.message ?? t).slice(0, 120)}`;
    return null;
  } catch {
    return null;
  }
}

function summarizeEvent(line) {
  if (!line) return 'reviewer working…';
  try {
    const ev = JSON.parse(line);
    const t = ev.msg?.type || ev.type || '';
    if (/error/i.test(t)) return `reviewer event: ${t}`;
    if (/message|item|delta|reasoning/i.test(t)) return 'reviewer reading and drafting findings…';
    if (/tool|command|exec/i.test(t)) return 'reviewer checking evidence…';
    return 'reviewer working…';
  } catch {
    return 'reviewer working…';
  }
}
