#!/usr/bin/env node
// CALLER-SCOPED TOOL BOUNDARY FOR THE STUDIO GATE IGNITER.
//
// Run as a PreToolUse hook in the igniter's own session (via `claude --settings`, so it never
// touches the operator's global settings). It denies the improvisation surface to the OUTER agent
// and leaves the camus-loop planner and implementer alone.
//
// Why not `--disallowedTools`: that flag is process-wide and IS inherited by the workflow's own
// agents. Production run 20260806-191749-6wxl reached the real Camus planner, which reported "Bash
// is disabled; no Read/Grep/Glob or filesystem MCP tool is exposed" — the outer boundary starved
// the workflow it exists to protect. (An earlier synthetic probe seemed to show the opposite; its
// canary string was present in the prompt, so the inner agent could echo it without running
// anything. A probe whose secret lives only on disk shows the inheritance plainly.)
//
// The discriminator is structural, from the hook payload itself: a tool call made by a SUBAGENT
// carries `agent_id` and `agent_type`; a call from the main-loop (outer) agent carries neither.
// That is what "caller-scoped" means here — the same tool name is allowed or denied by WHO asked.
//
// FAIL CLOSED, in both senses. Unreadable stdin, malformed JSON, an unexpected shape: deny. And the
// outer policy is an ALLOWLIST of two tools, so a tool nobody enumerated — a newly connected MCP
// server, a tool added by a future release — is refused rather than waved through. The exit status
// stays 0 in every case: the decision travels in the JSON, and a crashing hook is a hook the harness
// may ignore.
import { readFileSync, appendFileSync } from 'node:fs';

// THE OUTER POLICY IS AN ALLOWLIST, and it has to be. A denylist answers "is this one of the tools
// I thought of?" — so every tool nobody thought of is permitted. Measured: outer calls to
// `mcp__slack__send_message`, `mcp__firecrawl__scrape`, `AskUserQuestion` and `TodoWrite` all came
// back allowed under the denylist, and the first of those sends a message to the outside world
// before stream custody has a chance to react. Namespaced MCP tools make this permanent rather than
// an oversight: any server the operator connects later adds names this file cannot enumerate.
//
// So the question is inverted. The outer igniter's whole job is: launch camus-loop, rehydrate it if
// a resume unloaded the deferred tools, resume that same run. Exactly two tools do that, and each is
// separately validated downstream — Workflow by custody's identity-and-exact-args check, ToolSearch
// by custody's bounded-rehydration shape. Everything else, known or unknown, is refused here.
export const OUTER_ALLOWED = new Set(['Workflow', 'ToolSearch']);

// True when a tool is off-limits to the OUTER agent. Unknown tools land here by construction.
export function deniedForOuter(tool) {
  return !OUTER_ALLOWED.has(tool);
}

// A subagent — the planner, the implementer, the thin runners — is identified by the payload
// carrying an agent identity. The outer agent's calls have no such field.
export function isSubagentCall(payload) {
  return typeof payload?.agent_id === 'string' && payload.agent_id.length > 0;
}

export function decide(payload) {
  if (!payload || typeof payload !== 'object') {
    return { deny: true, reason: 'igniter tool guard: unreadable hook payload, refusing the call' };
  }
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!tool) {
    return { deny: true, reason: 'igniter tool guard: hook payload named no tool, refusing the call' };
  }
  // Subagents keep their normal local tools: the planner has to read the repository and the
  // implementer has to write it. Their conduct is governed by the workflow, not by this boundary.
  if (isSubagentCall(payload)) return { deny: false };
  if (!deniedForOuter(tool)) return { deny: false };
  return {
    deny: true,
    reason: `igniter tool guard: the Studio gate igniter may not use ${tool}. It may only start the `
      + 'camus-loop workflow (Workflow) and rehydrate it (ToolSearch), and nothing else — inspecting '
      + 'or repairing the repository, or reaching any external service, is the workflow\'s job or '
      + 'nobody\'s. This is an allowlist: a tool that is not one of those two is refused whether or '
      + 'not anyone anticipated it.',
  };
}

export function hookResponse(decision) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.deny ? 'deny' : 'allow',
      ...(decision.deny ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}

// An audit line per decision, when Studio asks for one. This is what makes "the outer agent could
// not act, and the inner agents could" a MEASURED claim rather than an assumption: both surfaces
// leave their own record, in one file, from the single place that decides.
function audit(payload, decision) {
  const path = process.env.CAMUS_IGNITER_GUARD_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({
      tool: payload?.tool_name ?? null,
      caller: isSubagentCall(payload) ? 'subagent' : 'outer',
      agentType: payload?.agent_type ?? null,
      decision: decision.deny ? 'deny' : 'allow',
    })}\n`);
  } catch { /* the boundary must not fail because a log could not be written */ }
}

// Only act as the hook when executed directly; importing this module (the tests do) must be inert.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { payload = null; }
  const decision = decide(payload);
  audit(payload, decision);
  process.stdout.write(`${JSON.stringify(hookResponse(decision))}\n`);
  process.exit(0);
}
