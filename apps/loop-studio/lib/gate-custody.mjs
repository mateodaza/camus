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

export function createGateCustodyGuard(expectedArgs) {
  let freshCalls = 0;
  let workflowRunId = null;
  let violation = null;

  const fail = (note) => {
    if (!violation) violation = `gate custody refused: ${note}`;
    return violation;
  };

  return {
    inspect(event) {
      if (violation || event?.type !== 'assistant') return violation;
      for (const item of event.message?.content ?? []) {
        if (item.type !== 'tool_use') continue;
        if (item.name !== 'Workflow') return fail(`igniter attempted non-Workflow tool ${item.name || '(unknown)'}`);

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

    snapshot() {
      return { freshCalls, workflowRunId, violation };
    },
  };
}

