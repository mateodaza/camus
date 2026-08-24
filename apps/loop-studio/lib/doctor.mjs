// Structured environment checks — one source of truth for `--doctor`, the
// /api/doctor endpoint, and the setup panel in the UI. Every failing check
// carries the exact fix a person can paste, because the audience for this
// app does not debug PATHs.

import { execFile } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getModels, modelsSummary, seatCatalog, listBackends, listConnections } from './models.mjs';
import { CLAUDE_HIVEMIND_DISPLAY, hivemindStatus } from './adapters/hivemind.mjs';
import { gateInstalled } from './code-lane.mjs';
import { qualifyUsedSeats } from './capability-probes.mjs';
import { createQualificationControl } from './control-plane.mjs';
import { getSharedTunnelManager } from './ssh-tunnel.mjs';

// A skill is a directory holding SKILL.md, whose YAML frontmatter names it.
// Only `name` is required; a directory without readable frontmatter still
// counts under its folder name rather than vanishing from the report.
const skillMeta = (text) => {
  const front = /^---\n([\s\S]*?)\n---/.exec(String(text || ''));
  if (!front) return null;
  const name = /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
  // `description:` may be inline or a YAML block scalar (`|`, `>`), in which
  // case the text starts on the following indented line.
  const desc = /^description:[ \t]*(\|-?|>-?)?[ \t]*(.*)$/m.exec(front[1]);
  let description = null;
  if (desc) {
    description = desc[1]
      ? front[1].slice(desc.index + desc[0].length).split('\n').map((l) => l.trim()).find(Boolean) ?? null
      : desc[2].trim() || null;
  }
  return name ? { name, description } : null;
};

const readSkillDir = (dir, scope) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent directory is not an error — most machines have none
  }
  const out = [];
  for (const entry of entries) {
    // Symlinks count: plugin and marketplace installs symlink skills into
    // ~/.claude/skills, and Dirent.isDirectory() is false for a symlink, which
    // silently hid most of them. readFileSync below follows the link.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let text = null;
    try {
      text = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue; // a directory without SKILL.md is not a skill
    }
    const meta = skillMeta(text);
    out.push({ name: meta?.name || entry.name, description: meta?.description ?? null, scope });
  }
  return out;
};

// Skills visible to Claude Code in this environment. REPORT-ONLY: the maker
// runs with a restricted `--tools` surface that has no Skill tool, and managed
// grounding passes `--setting-sources ''`, so a loop cannot invoke any of these
// today. They are surfaced for orientation only — reporting them as usable
// would advertise capability the loop does not have.
export function listSkills({ home = homedir(), cwd = process.cwd() } = {}) {
  const found = new Map();
  for (const skill of readSkillDir(join(home, '.claude', 'skills'), 'user')) found.set(skill.name, skill);
  // Studio normally starts from apps/loop-studio, while Claude's project
  // settings live at the repository root. Walk only to the nearest git root;
  // checking cwd alone made real project skills disappear from the report.
  const start = resolve(cwd);
  let projectRoot = start;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { projectRoot = dir; break; }
    if (dirname(dir) === dir) break;
  }
  // Project skills shadow user skills of the same name, matching Claude Code.
  for (const skill of readSkillDir(join(projectRoot, '.claude', 'skills'), 'project')) found.set(skill.name, skill);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const probe = (cmd, args, timeout = 20_000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve(err ? null : String(stdout || stderr).trim().split('\n')[0]),
    ),
  );

// Tri-state auth from a spend-free probe's output. null = the probe could not
// run (CLI missing, nonzero exit, timeout) — UNKNOWN, never guessed toward
// green. An explicit negation is checked FIRST: "Not logged in" printed with
// exit 0 must read false, not match the "logged in" substring (a false green
// here would put a reassuring chip in front of a run that will 401). And a
// probe that says logged-in still only proves a STORED session — a stale one
// can 401 at inference; the run stream stays the authoritative signal.
export const parseAuthProbe = (raw) => {
  if (raw == null) return null;
  // Structured claims first (claude can answer JSON), then explicit prose
  // negations, then prose sign-in — with REAL whitespace, so the bare
  // `loggedIn` JSON key can never satisfy the prose match on its own.
  if (/loggedIn"?\s*:\s*true/i.test(raw)) return true;
  if (/loggedIn"?\s*:\s*false/i.test(raw)) return false;
  if (/not\s+logged\s+in|logged\s+out|no\s+credentials/i.test(raw)) return false;
  if (/logged\s+in/i.test(raw)) return true;
  // Output with NO explicit claim either way (an error banner, help text, a
  // partial read) is unknown — an implicit false would be as invented as an
  // implicit green.
  return null;
};

// Managed Claude connectors need not use Studio's local alias. Match the exact
// configured endpoint, never a display name, so "claude.ai Hivemind Staging"
// is recognized without requiring a duplicate connector named `hivemind`.
export const hivemindListingHasEndpoint = (raw, endpoint) => {
  const wanted = String(endpoint || '').trim().replace(/\/$/, '');
  if (!wanted) return false;
  return String(raw || '').split('\n').some((line) => line.trim().replace(/\/$/, '').includes(wanted));
};

export const managedConnectorIsConnected = (raw) => /Status:\s*[^\n]*Connected/i.test(String(raw || ''));

// Pure normalization for the TCP half of a loopback doctor probe. WHATWG URL
// keeps brackets around IPv6 literals in Node, while net.connect needs the bare
// address. Protocol defaults matter for portless baseUrl declarations.
export function loopbackTcpTarget(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

// deep=true adds the slow managed-connector health round-trip.
export async function runDoctor({ deep = false, engine = 'live' } = {}) {
  const checks = [];
  const sshDoctorRows = new Map();
  const add = (id, label, ok, detail, fix = null, extra = {}) => checks.push({ id, label, ok, detail, fix, ...extra });

  // Doctor is also an application boundary. Subscribe before forcing exactly
  // one sweep so a shared singleton created by Studio cannot hide its outcome.
  const doctorTunnelManager = getSharedTunnelManager();
  const sweepEvidence = [];
  const removeSweepSubscription = doctorTunnelManager.subscribe((fact) => sweepEvidence.push(fact));
  await doctorTunnelManager.startup({ force: true });
  removeSweepSubscription();
  const inconclusiveSweep = sweepEvidence.filter((fact) => fact.control === 'lease_sweep' && fact.outcome === 'inconclusive');
  add('ssh-tunnel-sweep', 'Managed SSH lease sweep', inconclusiveSweep.length === 0,
    inconclusiveSweep.length ? 'lease cleanup was inconclusive; inspect the named connection and repair its local lease' : 'completed before doctor checks',
    inconclusiveSweep.length ? 'remove or repair the named connection’s local tunnel lease, then rerun doctor' : null,
    { controlEvidence: sweepEvidence });

  add('node', 'Node.js', true, process.version, null);

  // The seat decisions drive which CLIs a run will actually spawn. A broken
  // decision record leaves them null; the models check below reports the error
  // and every CLI stays required (fail closed toward "needed").
  const hm = hivemindStatus();
  let seatDecisions = null;
  try { seatDecisions = getModels(); } catch { /* reported by the models check */ }
  const claudeUsed = !seatDecisions
    || seatDecisions.maker.backend === 'claude'
    || seatDecisions.reviewer.backend === 'claude'
    || hm.mode === 'claude'; // managed-connector retrieval spawns claude regardless of seats
  const codexUsed = !seatDecisions
    || seatDecisions.maker.backend === 'codex'
    || seatDecisions.reviewer.backend === 'codex';

  const [claudeV, codexV, gitV] = await Promise.all([
    probe('claude', ['--version']),
    probe('codex', ['--version']),
    probe('git', ['--version']),
  ]);

  // Installed is not signed-in: both CLIs expose spend-free auth probes.
  // Their SIGNED-OUT answers arrive with exit code 1 (claude prints
  // {"loggedIn": false, …}, codex prints "Not logged in") — so the output must
  // survive a nonzero exit, or the real signed-out state collapses into
  // "unknown" and the red preflight can never fire (live P1, 2026-07-14). A
  // nonzero exit with NO output (missing binary, timeout, crash) still ends up
  // null through the parser's no-claim rule.
  const fullProbe = (cmd, args, timeout = 20_000) =>
    new Promise((r) => execFile(cmd, args, { timeout }, (_err, so, se) => {
      const out = String(so || se || '').trim();
      r(out || null);
    }));
  const [claudeAuthRaw, codexAuthRaw] = await Promise.all([
    claudeV ? fullProbe('claude', ['auth', 'status']) : Promise.resolve(null),
    codexV ? fullProbe('codex', ['login', 'status']) : Promise.resolve(null),
  ]);
  const claudeAuthed = parseAuthProbe(claudeAuthRaw);
  const codexAuthed = parseAuthProbe(codexAuthRaw);

  // `auth` rides each CLI check structurally (true/false/null) so the launch
  // view's preflight chips consume the doctor's judgement instead of
  // re-parsing detail strings.
  // A CLI backend no current seat decision uses stays visible but optional:
  // its absence must not block the runs the decisions actually describe.
  const unusedNote = ' · not used by the current seat decisions (the Build lane still needs it)';
  add(
    'claude', 'Claude CLI backend', !!claudeV && claudeAuthed !== false,
    (!claudeV ? 'not found on PATH; the claude backend cannot run'
      : claudeAuthed === false ? `${claudeV} installed, but not signed in`
      : `${claudeV}${claudeAuthed ? ' · signed in' : ''}`) + (claudeUsed ? '' : unusedNote),
    !claudeV ? 'npm install -g @anthropic-ai/claude-code   # then run `claude` once and sign in'
      : claudeAuthed === false ? 'claude   # opens the sign-in flow' : null,
    { auth: claudeAuthed, ...(claudeUsed ? {} : { optional: true }) },
  );
  add(
    'codex', 'Codex CLI backend', !!codexV && codexAuthed !== false,
    (!codexV ? 'not found on PATH; the codex backend cannot run'
      : codexAuthed === false ? `${codexV} installed, but not signed in`
      : `${codexV}${codexAuthed ? ' · signed in' : ''}`) + (codexUsed ? '' : unusedNote),
    !codexV ? 'npm install -g @openai/codex   # then run `codex` once and sign in'
      : codexAuthed === false ? 'codex login' : null,
    { auth: codexAuthed, ...(codexUsed ? {} : { optional: true }) },
  );

  // The seat catalog, resolved ONCE and shared by the connection lineage checks
  // below and the catalog check further down. A malformed decision file leaves it
  // null; every consumer degrades to the reported error rather than throwing.
  let seats = null;
  let seatsError = null;
  try { seats = seatCatalog(); } catch (err) { seatsError = err; }

  // ---- Per-connection checks (RFC §11.2, §19.2) --------------------------
  // These run BEFORE the per-backend checks. Connections are enumerated
  // SIDE-EFFECT-FREE (no grandfather consult), so even a not-yet-grandfathered
  // legacy_http entry surfaces its upgrade paths here instead of only exploding
  // the models check. Reachability is DEEP-only and sends NO key: a resolved HTTP
  // response (any status, even 401) proves the endpoint answered; only a
  // DNS/TLS/connection failure reads unreachable. A connection's identity is its
  // endpoint and kind — never a credential value.
  const tcpReachable = (host, port, timeout = 1500) => new Promise((resolveTcp) => {
    const socket = netConnect({ host, port });
    const finish = (ok) => { socket.destroy(); resolveTcp(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
  const endpointAnswers = (baseUrl) =>
    fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
  let connections = {};
  try { connections = listConnections(); } catch { /* malformed file: the models/catalog checks report it */ }
  for (const [name, conn] of Object.entries(connections)) {
    const label = `Connection "${name}"${conn.anonymous ? ' (migrated)' : ''}`;
    if (conn.kind === 'ssh_tunnel') {
      let tunnelState = null;
      const controlEvidence = sweepEvidence.filter((fact) => fact.connection === name);
      if (deep) {
        let unsubscribe = null;
        try {
          const manager = doctorTunnelManager;
          unsubscribe = manager.subscribe((fact) => controlEvidence.push(fact));
          // The single doctor sweep ran above; this subscription captures the
          // shared manager's preflight/spawn/liveness evidence for this row.
          const lease = await manager.acquire(conn);
          tunnelState = { ok: true, lease, steps: [...lease.steps,
            { number: 7, id: 'model_discovery', outcome: 'not_run', detail: 'qualification operation not yet run' },
            { number: 8, id: 'declared_model_visibility', outcome: 'not_run', detail: 'qualification operation not yet run' },
            { number: 9, id: 'protocol_compatibility', outcome: 'not_run', detail: 'qualification operation not yet run' },
            { number: 10, id: 'structured_output', outcome: 'not_run', detail: 'qualification operation not yet run' },
            { number: 11, id: 'tool_calling', outcome: 'not_applicable', detail: 'words seats are toolless' },
            { number: 12, id: 'context_window', outcome: 'not_run', detail: 'qualification operation not yet run' },
          ] };
          await lease.release();
        } catch (error) {
          tunnelState = { ok: false, error };
        } finally {
          unsubscribe?.();
        }
      }
      const ok = tunnelState ? tunnelState.ok : true;
      add(`connection-${name}`, `${label} (ssh_tunnel)`, ok,
        !deep ? `managed SSH connection declared (run --doctor --deep for the twelve-step preflight)`
          : ok ? 'OpenSSH preflight, forward, and model discovery reachable'
            : 'SSH tunnel preflight failed; inspect the named connection with the fixed SSH guidance',
        ok ? null : `run the SSH alias for connection "${name}" interactively to establish host trust/auth, then fix this connection`,
        { optional: true, connection: name, transport: 'ssh_tunnel', steps: tunnelState?.steps ?? [{ number: 1, id: 'config', outcome: ok ? 'declared' : 'failed' }], controlEvidence },
      );
      sshDoctorRows.set(name, checks.at(-1));
    } else if (conn.kind === 'loopback') {
      const url = new URL(conn.baseUrl);
      // URL.hostname retains brackets for IPv6 literals in Node. net.connect
      // needs the bare address, and a missing explicit port follows the URL
      // protocol rather than assuming HTTP for an accepted HTTPS declaration.
      const { host: tcpHost, port: tcpPort } = loopbackTcpTarget(conn.baseUrl);
      const configRef = conn.anonymous && name.startsWith('$legacy:')
        ? `backends.${name.slice('$legacy:'.length)}.baseUrl`
        : `connections.${name}`;
      let tcp = null;
      let reach = null; // null = not probed (deep only)
      if (deep) {
        tcp = await tcpReachable(tcpHost, tcpPort);
        if (tcp) reach = await endpointAnswers(conn.baseUrl);
      }
      add(
        `connection-${name}`, `${label} (loopback)`,
        tcp === false ? false : reach !== false,
        `${conn.baseUrl}${!deep ? ' · declared (run --doctor for a live probe)'
          : tcp === false ? ' · TCP refused'
          : reach === false ? ' · port open, /models did not answer'
          : ' · reachable'}`,
        tcp === false
          ? `start the local server at ${url.origin}, or fix ${configRef}`
          : reach === false
            ? `make ${conn.baseUrl}/models answer, or fix the base path in ${configRef}`
            : null,
        { optional: true, connection: name },
      );
    } else if (conn.kind === 'direct_https') {
      const url = new URL(conn.baseUrl);
      let reach = null;
      if (deep) reach = await endpointAnswers(conn.baseUrl);
      add(
        `connection-${name}`, `${label} (direct_https)`,
        reach !== false,
        `${conn.baseUrl}${!deep ? ' · declared (run --doctor for a live probe)'
          : reach === false ? ' · DNS/TLS or endpoint unreachable' : ' · DNS/TLS ok, endpoint answered'}`,
        reach === false ? `confirm ${url.hostname} resolves and serves HTTPS, or fix connections.${name}.baseUrl` : null,
        { optional: true, connection: name },
      );
    } else if (conn.kind === 'legacy_http') {
      const url = new URL(conn.baseUrl);
      // Plaintext or non-public HTTP. Grandfathered entries still run; a new one
      // is refused. Surface the exact three upgrade paths (the grandfather refusal
      // wording) so the fix is copyable.
      add(
        `connection-${name}`, `${label} (legacy_http)`, false,
        `${conn.baseUrl} · plaintext or non-public HTTP; grandfathered entries still run, new ones are refused`,
        'Upgrade paths: (1) move the service to loopback (127.0.0.1), (2) front it with an ssh_tunnel connection, or (3) put it behind a real HTTPS endpoint. Or confirm it explicitly with confirmLegacy.',
        { optional: true, connection: name },
      );
    }
  }

  // Unconfirmed-lineage and registry-staleness prompts, judged against DECLARED
  // config only — never the network. Both read the lineage source that was
  // derived at load from the config declarations + the tracked registry, one
  // entry for every declared model in every configurable backend.
  const entriesByBackend = new Map();
  for (const entry of [...(seats?.maker ?? []), ...(seats?.reviewer ?? [])]) {
    if (entry.backend === 'claude' || entry.backend === 'codex') continue;
    if (!entriesByBackend.has(entry.backend)) entriesByBackend.set(entry.backend, new Map());
    entriesByBackend.get(entry.backend).set(entry.model, entry);
  }
  for (const [backend, byModel] of entriesByBackend) {
    const entries = [...byModel.values()];
    const unknownModels = entries.filter((entry) => entry.lineage?.source === 'unknown').map((entry) => entry.model);
    if (unknownModels.length) {
      add(
        `lineage-${backend}`, `Lineage for "${backend}"`, false,
        `origin unconfirmed for ${unknownModels.join(', ')} (training org / model family undeclared); its pairings seal advisory, never verified`,
        `declare backends.${backend}.trainingOrg, .modelFamily, and .derivedFrom in models.json to confirm its lineage`,
        { optional: true },
      );
    }
    const staleModels = entries
      .filter((entry) => entry.transport === 'direct_https' && entry.lineage?.source !== 'registry')
      .map((entry) => entry.model);
    if (staleModels.length) {
      const representative = entries.find((entry) => staleModels.includes(entry.model));
      add(
        `registry-${backend}`, `Registry coverage for "${backend}"`, false,
        `${representative.trainingOrg}/${representative.modelFamily} models ${staleModels.join(', ')} are operator-declared; checks/registry.json has no matching endpoint row, so their lineage stays operator_declared, not registry`,
        `add an endpoint row for this host to checks/registry.json to verify the origin, or keep it operator-declared`,
        { optional: true, advisory: true },
      );
    }
  }

  // Opt-in openai_compat backends: each declared entry gets its own check.
  // Required exactly when a seat decision names it; the key itself is only
  // ever read from the environment, never printed.
  try {
    for (const backend of Object.values(listBackends())) {
      if (backend.kind !== 'openai_compat') continue;
      const used = seatDecisions && (seatDecisions.maker.backend === backend.name || seatDecisions.reviewer.backend === backend.name);
      // A normalized keyless backend (auth.kind:none, apiKeyEnv placeholder
      // CAMUS_NO_AUTH) neither requires nor emits a credential — the adapter and
      // the qualification runner send NO bearer, so requiring a dummy key here
      // (which is explicitly forbidden) would mark usable keyless loopback as
      // broken. The credential is a satisfied non-issue for it.
      const keyless = backend.auth?.kind === 'none' || backend.apiKeyEnv === 'CAMUS_NO_AUTH';
      const keyPresent = keyless || !!process.env[backend.apiKeyEnv];
      let reach = null; // null = not probed (deep only), true/false = probed
      if (deep && keyPresent) {
        if (backend.transport === 'ssh_tunnel') {
          try {
            const lease = await getSharedTunnelManager().acquire(backend.connectionDetails);
            reach = await fetch(`${lease.url}/models`, {
              headers: keyless ? {} : { authorization: `Bearer ${process.env[backend.apiKeyEnv]}` },
              signal: AbortSignal.timeout(5000),
            }).then((r) => r.ok, () => false);
            await lease.release();
          } catch { reach = false; }
        } else reach = await fetch(`${backend.baseUrl}/models`, {
          headers: keyless ? {} : { authorization: `Bearer ${process.env[backend.apiKeyEnv]}` },
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.ok, () => false);
      }
      const credNote = keyless ? 'keyless (no credential required)' : keyPresent ? `${backend.apiKeyEnv} set` : `${backend.apiKeyEnv} NOT set`;
      // §9.3: model DISCOVERY (/models) is INFORMATIONAL ONLY — it gates nothing.
      // A disabled, missing, or transiently failing /models endpoint must not fail
      // a used backend, because the real chat-completions qualification probes can
      // still succeed against it. The check's health is credential presence alone;
      // reachability is reported in the detail line as advisory context, never
      // folded into `ok`.
      const reachNote = reach === true ? ' · /models reachable'
        : reach === false ? ' · /models unreachable (informational; chat-completions probes still qualify)' : '';
      add(
        `backend-${backend.name}`, `Backend "${backend.name}" (${backend.provider})`,
        keyPresent,
        `${backend.baseUrl || `ssh://${backend.connection}`} · ${backend.models.length} declared model${backend.models.length === 1 ? '' : 's'} · ${credNote}${reachNote}${used ? '' : ' · not used by the current seat decisions'}`,
        keyPresent ? null : `export ${backend.apiKeyEnv}=…   # the key never enters config or receipts`,
        used ? {} : { optional: true },
      );
    }
  } catch (err) {
    add('backends', 'Configured backends', false, err.message, 'fix the active local model decision file (or the tracked defaults if no local file exists)');
  }

  // Deep §9.2 capability qualification: the SAME operation the server exposes,
  // run only under an explicit --deep/browser deep action for every declared
  // openai_compat tuple. Advisory — a probe failure is reported, never a
  // thrown doctor, and it does not flip the overall preflight verdict.
  // The §9.2 qualification fires REAL, spending streaming model probes and writes
  // durable receipts. Under the mock engine — whose contract is "rehearsal, no
  // model calls" — it is skipped entirely, even when deep is requested; the cheap
  // deep connection/backend reachability probes above still run.
  if (deep && engine !== 'mock') {
    try {
      const qualRows = await qualifyUsedSeats({
        backends: Object.values(listBackends()), seatDecisions, deep: true,
        // `--doctor --deep` and the plainly labelled browser action authorize
        // the declared tuple set. Still bind one human decision + receipt per
        // exact tuple so a later config edit cannot inherit that authority.
        onTupleStart: ({ entry, model, seatKey }) => createQualificationControl({
          seat: seatKey, backend: entry.name, model,
          connection: entry.connection || entry.connectionDetails?.name || null,
          transport: entry.transport,
          consentReason: 'Operator explicitly requested deep checks for the declared tuple set; this decision is bound to this exact tuple.',
        }),
        onTupleFinish: (control, outcome) => control.finish(outcome),
      });
      // A qualification failure for a seat the current decision actually SELECTS
      // is not advisory: the launch gate will categorically reject that run, so
      // --doctor must fail rather than exit green. The row id qualifyUsedSeats
      // mints is `qual-<backend>-<model>-<seatType>`; only the two currently
      // selected (backend, model, seatType) tuples are required — every other
      // declared/alternate candidate stays advisory (unused, cannot block).
      const requiredIds = new Set(
        seatDecisions
          ? [
              `qual-${seatDecisions.maker.backend}-${seatDecisions.maker.model}-words_maker`,
              `qual-${seatDecisions.reviewer.backend}-${seatDecisions.reviewer.model}-words_reviewer`,
            ]
          : [],
      );
      for (const row of qualRows) add(row.id, row.label, row.ok, row.detail, row.fix, { advisory: !requiredIds.has(row.id), qualification: row });
      const sshBackends = Object.values(listBackends()).filter((backend) => backend.transport === 'ssh_tunnel');
      for (const backend of sshBackends) {
        const connectionName = backend.connection || backend.connectionDetails?.name;
        const doctorRow = sshDoctorRows.get(connectionName);
        if (!doctorRow) continue;
        const rows = qualRows.filter((row) => row.backend === backend.name);
        const models = [...new Set(rows.map((row) => row.model).filter(Boolean))];
        const stepsFor = (modelRows, model) => {
          const status = (key) => {
            const values = modelRows.map((row) => row.capabilities?.[key]?.status).filter(Boolean);
            if (!values.length) return 'not_run';
            if (values.every((value) => value === 'demonstrated' || value === 'not_applicable')) return 'passed';
            return 'failed';
          };
          const discovery = modelRows.map((row) => row.discoveryStatus).filter(Boolean);
          return [
            { number: 7, id: 'model_discovery', outcome: discovery.length && discovery.every((value) => value !== 'discovery_unavailable') ? 'passed' : 'not_run', detail: `${model}: ${discovery.join(', ') || 'not run'}` },
            { number: 8, id: 'declared_model_visibility', outcome: modelRows.length ? 'passed' : 'not_run', detail: `${model}: declared qualification tuple` },
            { number: 9, id: 'protocol_compatibility', outcome: status('streaming'), detail: `${model}: streaming capability` },
            { number: 10, id: 'structured_output', outcome: status('structuredOutput'), detail: `${model}: structured-output capability` },
            { number: 11, id: 'tool_calling', outcome: 'not_applicable', detail: `${model}: words seats are toolless` },
            { number: 12, id: 'context_window', outcome: status('contextWindow'), detail: `${model}: measured context window` },
          ];
        };
        const qualificationSteps = {};
        for (const model of models) qualificationSteps[model] = stepsFor(rows.filter((row) => row.model === model), model);
        if (!models.length) qualificationSteps.unprobed = stepsFor([], 'no credential or qualification run');
        doctorRow.qualificationSteps = qualificationSteps;
        const allSteps = Object.values(qualificationSteps).flat();
        doctorRow.steps = [...(doctorRow.steps || []).filter((step) => step.number < 7), ...[7, 8, 9, 10, 11, 12].map((number) => {
          const candidates = allSteps.filter((step) => step.number === number);
          const outcome = candidates.length && candidates.every((step) => step.outcome === 'passed' || step.outcome === 'not_applicable')
            ? (candidates.every((step) => step.outcome === 'not_applicable') ? 'not_applicable' : 'passed')
            : candidates.some((step) => step.outcome === 'failed') ? 'failed' : 'not_run';
          return { number, id: candidates[0]?.id || `qualification_${number}`, outcome, detail: candidates.map((step) => step.detail).join('; ') || 'not run' };
        })];
      }
    } catch (err) {
      add('qualification', 'Seat qualification', false, err.message, null, { advisory: true });
    }
  }

  add(
    'git', 'git', !!gitV,
    gitV ?? 'not found; reviews would run outside a git repo (different conditions than camus)',
    gitV ? null : 'xcode-select --install   # macOS; or install git from git-scm.com',
  );

  const gate = gateInstalled();
  add(
    'gate', 'Camus gate (Build lane)', gate,
    gate ? 'installed in ~/.claude with standalone custody support' : 'missing or too old. Build requires the identity-bound custody gate; the words lanes run without it.',
    gate ? null : 'npm install -g camus-cli && camus install   # or, from this repo: bash packages/cli/install.sh',
    { optional: true },
  );

  try {
    const models = seatDecisions ?? getModels();
    let note = modelsSummary();
    note += `. Sources: maker ${models.maker.source}, reviewer ${models.reviewer.modelSource}.`;
    if (models.reviewer.backend === 'codex') {
      try {
        const { readFileSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const cache = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, 'utf8'));
        const slugs = (cache.models ?? []).map((m) => m.slug).filter(Boolean);
        if (slugs.length && !slugs.includes(models.reviewer.model)) {
          note += ` Reviewer "${models.reviewer.model}" is not in codex's model cache (${slugs.slice(0, 3).join(', ')}…); a run may fail at review.`;
        }
      } catch { /* cache absent — cannot judge, stay quiet */ }
    }
    add('models', 'Model decisions', true, note, null);
  } catch (err) {
    add('models', 'Model decisions', false, err.message, 'open Settings in the studio and pick the models');
  }

  // The seat catalog, as the pickers and the run-request validator see it —
  // the doctor states what may sit in each seat so a decision is checkable
  // before anything runs. Advisory: an empty compat list is a config question,
  // never a gate on the runs the current decisions describe. Reuses the seat
  // catalog resolved once above (`seats`/`seatsError`).
  if (seats) {
    const summarize = (entries) => {
      const byBackend = new Map();
      for (const entry of entries) {
        if (!byBackend.has(entry.backend)) byBackend.set(entry.backend, []);
        byBackend.get(entry.backend).push(entry.model);
      }
      return [...byBackend.entries()].map(([backend, models]) =>
        `${backend}(${models.length <= 3 ? models.join(', ') : `${models.length} models`})`).join(' · ');
    };
    add('catalog', 'Seat catalog', true,
      `maker: ${summarize(seats.maker)}; reviewer: ${summarize(seats.reviewer)} — reviewer list ${seats.reviewerSource === 'codex_cache' ? 'CLI-verified from the codex cache' : 'a conservative fallback'}`,
      null, { advisory: true, seats });
  } else {
    add('catalog', 'Seat catalog', false, seatsError.message, 'fix the active local model decision file (or the tracked defaults if no local file exists)', { advisory: true });
  }
  if (hm.mode === 'claude' && deep) {
    // Probe ONLY the managed connector. `mcp list` health-checks every local
    // entry and their stderr may contain inline credentials; this targeted
    // command neither initializes nor exposes unrelated MCP configuration.
    const full = await fullProbe('claude', ['mcp', 'get', CLAUDE_HIVEMIND_DISPLAY], 30_000);
    const registered = managedConnectorIsConnected(full);
    add(
      'hivemind', 'Hivemind grounding (via Claude)', registered,
      registered ? `connected managed connector recognized · ${CLAUDE_HIVEMIND_DISPLAY}` : `Claude has no connected ${CLAUDE_HIVEMIND_DISPLAY} entry`,
      registered ? null : `open /mcp in Claude and connect Hivemind Staging (${hm.base})`,
      { optional: true },
    );
  } else {
    add(
      'hivemind', 'Hivemind grounding', hm.connected,
      hm.connected ? `${hm.mode}: ${hm.base}` : 'not connected. Myosin’s Hivemind (staging) is optional; runs proceed ungrounded.',
      hm.connected ? null : 'optional: HIVEMIND_VIA_CLAUDE=1 (Claude connector) or HIVEMIND_MCP_URL + HIVEMIND_API_KEY',
      { optional: true },
    );
  }

  const skills = listSkills();
  add(
    'skills', 'Skills in this environment', true,
    skills.length
      ? `${skills.length} found (${skills.slice(0, 3).map((s) => s.name).join(', ')}${skills.length > 3 ? ', …' : ''}). Listed for reference: loops run with a restricted tool surface and cannot invoke them yet.`
      : 'none found. Loops do not use skills yet.',
    null,
    { skills, advisory: true },
  );

  // A check is required unless it says otherwise: hivemind/gate are optional
  // (words lanes run without them), skills and the catalog are informational,
  // and a CLI or backend no current seat decision uses must not gate the runs
  // the decisions actually describe.
  const required = checks.filter((c) => !c.optional && !c.advisory);
  return {
    engine,
    ok: engine === 'mock' || required.every((c) => c.ok),
    checks,
  };
}
