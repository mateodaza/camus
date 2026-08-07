// Fail-closed custody guard for Studio's outer Claude "igniter" process.
// One process may start camus-loop exactly once and may only resume that same
// async workflow with byte-equivalent JSON args. A fresh retry, altered args,
// or an unrelated tool call is a custody breach: the process is killed before
// Studio can mistake a second branch/worktree for continuation of the first.

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function sameJson(a, b) {
  try { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  catch { return false; }
}

function parsedArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The rehydration lookup a resumed session is allowed to make, stated once so the
// guard and GATE_AWAIT_PROMPT cannot drift apart: ONE ToolSearch naming Workflow,
// no other fields, a small result cap. `select:Workflow` is the canonical form the
// prompt pins; a semantic query that still names workflow is tolerated so a minor
// wording difference does not kill a live run.
export const REHYDRATION_QUERY = 'select:Workflow';
const MAX_RESULTS_CEILING = 10; // ToolSearch's own default is 5; 10 is the common alternative
const MAX_QUERY_CHARS = 120;
const REHYDRATION_LOOKUPS = 1;

// Tools whose attempted use CANNOT have changed anything: no write, no exec, no network. An
// igniter reaching for one of these is improvising, and that is a breach — but it is a breach the
// host can contain without destroying work, because there is nothing to undo. The harness deny list
// (IGNITER_DENIED_TOOLS) already refuses them before execution, so by the time custody sees the
// tool_use the attempt has been rejected, not performed.
//
// EVERYTHING ELSE STAYS TERMINAL. Bash, Edit, Write and friends are absent from this set on
// purpose: an attempt to mutate or execute ends the run, because "it was denied this time" is not a
// property the host should bet a repository on.
const CONTAINABLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'WebFetch', 'WebSearch']);
// How many contained improvisations one gate may survive. Two is enough for an igniter that gets
// confused at a phase boundary and then does the right thing; a loop of them is its own failure.
const MAX_CONTAINED = 2;

export function createGateCustodyGuard(expectedArgs) {
  let freshCalls = 0;
  let workflowRunId = null;
  let violation = null;
  let toolSearchCalls = 0;      // cumulative, for diagnostics
  let turnToolSearchCalls = 0;  // per igniter PROCESS — the budget that is enforced
  const contained = [];         // improvisations refused and survived, for the receipt
  let turnContained = false;    // this PROCESS improvised; the host owns what happens next

  const fail = (note) => {
    if (!violation) violation = `gate custody refused: ${note}`;
    return violation;
  };

  // A breach the host may contain: the offending tool cannot have changed anything, the async
  // workflow is ALREADY bound (so there is a live run worth preserving), and the budget is not
  // spent. Returns true when this call was recorded as contained rather than fatal.
  const containable = (name) => {
    if (!CONTAINABLE_TOOLS.has(name)) return false;
    if (freshCalls !== 1 || !workflowRunId) return false;
    if (contained.length >= MAX_CONTAINED) return false;
    contained.push({ tool: name, afterRunId: workflowRunId });
    turnContained = true;
    return true;
  };

  return {
    inspect(event) {
      if (violation || event?.type !== 'assistant') return violation;
      for (const item of event.message?.content ?? []) {
        if (item.type !== 'tool_use') continue;
        if (item.name === 'ToolSearch') {
          // Resuming a persisted Claude conversation may unload deferred tools.
          // Claude then has to rehydrate Workflow through ToolSearch before it
          // can use the already-bound async handle. Permit only a short,
          // bounded Workflow query; discovery that does not name Workflow is a
          // custody escape just like Bash/Edit would be. ToolSearch itself is
          // read-only, and every subsequently used tool still passes the stricter
          // Workflow-only check below.
          //
          // Refusals name the SPECIFIC constraint that failed. The old message
          // was one generic sentence, so a real WP6 run died and the receipt
          // could not say which rule tripped (20260805-062823-zoi8). Only
          // schema-level facts are recorded — key names, a length, a number —
          // never the raw query text or any tool payload, which can carry task
          // content.
          const input = item.input ?? {};
          const keys = Object.keys(input).sort();
          const max = input.max_results;
          const query = typeof input.query === 'string' ? input.query.trim() : '';
          const extraKeys = keys.filter((key) => !['max_results', 'query'].includes(key));
          toolSearchCalls += 1;
          turnToolSearchCalls += 1;
          // The budget is PER IGNITER PROCESS, not per gate. An async workflow is
          // awaited across several `claude --resume` turns, and each of those is a
          // NEW process that may again start with its deferred tools unloaded — so
          // a global cap would kill the second legitimate reattach. Rehydration is
          // once per process; the same-run identity and exact-args constraints stay
          // global, which is what actually prevents a fork.
          if (turnToolSearchCalls > REHYDRATION_LOOKUPS) {
            return fail(`igniter attempted ${turnToolSearchCalls} ToolSearch calls in one turn; rehydrating Workflow is permitted ${REHYDRATION_LOOKUPS} time per igniter process`);
          }
          if (extraKeys.length) {
            return fail(`igniter ToolSearch carried unexpected field(s) ${extraKeys.join(', ')}; only query and max_results are permitted`);
          }
          if (!query) {
            return fail('igniter ToolSearch had no query; the permitted rehydration is query "select:Workflow"');
          }
          if (query.length > MAX_QUERY_CHARS) {
            return fail(`igniter ToolSearch query was ${query.length} chars (max ${MAX_QUERY_CHARS}); the permitted rehydration is query "select:Workflow"`);
          }
          if (!/\bworkflow\b/i.test(query)) {
            return fail('igniter ToolSearch query did not name Workflow, so it was tool discovery beyond rehydrating the bound run');
          }
          if (max != null && (!Number.isInteger(max) || max < 1 || max > MAX_RESULTS_CEILING)) {
            return fail(`igniter ToolSearch requested max_results ${JSON.stringify(max)}; permitted range is 1-${MAX_RESULTS_CEILING}`);
          }
          continue;
        }
        if (item.name !== 'Workflow') {
          // Improvisation. It never executed — the harness deny list refused it — so the only
          // question left is whether the host can carry on. A read-only attempt on an
          // already-bound workflow is CONTAINED: recorded, refused, and the igniter process is
          // abandoned rather than killed mid-flight, so the bound async workflow survives and the
          // host reattaches to it on its own terms. Anything that could have written or executed
          // stays fatal. (Production run 20260806-164809-hiju: a Read at Verify took the whole
          // gate down along with wf_33300aac-c17, and deterministic verification never ran.)
          if (containable(item.name)) continue;
          return fail(`igniter attempted non-Workflow tool ${item.name || '(unknown)'}`);
        }

        const input = item.input ?? {};
        if (!sameJson(parsedArgs(input.args), expectedArgs)) return fail('workflow args changed or became unreadable');

        if (input.name != null) {
          if (input.name !== 'camus-loop') return fail(`unexpected workflow ${String(input.name)}`);
          if (freshCalls !== 0) return fail('a second fresh camus-loop invocation was attempted');
          freshCalls = 1;
          continue;
        }

        const runId = typeof input.resumeFromRunId === 'string' ? input.resumeFromRunId : '';
        const scriptPath = typeof input.scriptPath === 'string' ? input.scriptPath : '';
        if (freshCalls !== 1 || !runId || !scriptPath.includes(`camus-loop-${runId}`)) {
          return fail('workflow resume was not bound to the original camus-loop run');
        }
        if (workflowRunId && workflowRunId !== runId) return fail('workflow resume switched run identity');
        workflowRunId = runId;
      }
      return violation;
    },

    finish() {
      if (violation) return violation;
      if (freshCalls !== 1) return fail('igniter returned without one fresh camus-loop invocation');
      return null;
    },

    // Called once per igniter PROCESS (each `claude -p` / `claude --resume`).
    // Resets only the rehydration budget: a fresh process may have its deferred
    // tools unloaded again and legitimately needs one lookup. Everything that
    // prevents a fork — freshCalls, workflowRunId, violation — is deliberately
    // NOT reset, so a new turn can never buy a second workflow or new args.
    beginTurn() {
      turnToolSearchCalls = 0;
      turnContained = false;
    },

    // Did THIS igniter process improvise? The host asks after the turn ends: a contained breach
    // means the turn's own result must be discarded (an improvising agent's conclusions are not
    // evidence) while the bound workflow is reattached. Never true for a fatal violation — that
    // path ends the run.
    turnWasContained() {
      return turnContained && !violation;
    },

    snapshot() {
      // workflowRunId is the recovery anchor: when a refusal kills the igniter,
      // Studio still needs the bound run identity to say what survived.
      return { freshCalls, workflowRunId, violation, toolSearchCalls, turnToolSearchCalls, contained: contained.slice() };
    },
  };
}
