// ── THE OUTER IGNITER'S TOOL POLICY IS AN ALLOWLIST ──────────────────────────────────────
// The guard first shipped with a DENYLIST, which answers the wrong question: "is this one of the
// tools I thought of?" Every tool nobody thought of was therefore allowed. Measured outer calls to
// `mcp__slack__send_message`, `mcp__firecrawl__scrape`, `AskUserQuestion` and `TodoWrite` all came
// back `{deny:false}` — and the first of those reaches an external service before stream custody
// can react. Namespaced MCP tools make it structural: any server the operator connects later adds
// names this file cannot enumerate.
//
// Deterministic and pure — no models, no network. The live proof that the two surfaces really behave
// this way against the real camus-loop lives in igniter-scope.live.test.mjs.
import assert from 'node:assert/strict';

const { decide, isSubagentCall, deniedForOuter, OUTER_ALLOWED } = await import('./lib/igniter-tool-guard.mjs');

// The payload shapes are the ones a live PreToolUse hook actually sends: a subagent's call carries
// agent_id/agent_type, the outer main-loop agent's carries neither.
const outer = (tool) => ({ tool_name: tool, session_id: 's-1', cwd: '/x', hook_event_name: 'PreToolUse' });
const inner = (tool) => ({ ...outer(tool), agent_id: 'agent-abc', agent_type: 'general-purpose' });

// ── THE TWO TOOLS THE OUTER AGENT NEEDS, AND ONLY THOSE ───────────────────────────────────
assert.deepEqual([...OUTER_ALLOWED].sort(), ['ToolSearch', 'Workflow'],
  'the outer allowlist is exactly the two tools that start and rehydrate the gate');
assert.equal(decide(outer('Workflow')).deny, false,
  'Workflow is allowed — custody validates its identity and exact args downstream');
assert.equal(decide(outer('ToolSearch')).deny, false,
  'ToolSearch is allowed — custody validates its bounded rehydration shape downstream');

// ── THE REPRODUCTIONS FROM THE AUDIT ──────────────────────────────────────────────────────
// Each of these returned {deny:false} under the denylist.
for (const tool of ['mcp__slack__send_message', 'mcp__firecrawl__scrape', 'AskUserQuestion', 'TodoWrite']) {
  const d = decide(outer(tool));
  assert.equal(d.deny, true, `the outer igniter may not use ${tool}`);
  assert.match(d.reason, new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the refusal names ${tool}, so an operator can see what was stopped`);
  assert.match(d.reason, /allowlist/, 'and says the policy is an allowlist, not an oversight');
}

// ── UNKNOWN AND NAMESPACED TOOLS DENY BY CONSTRUCTION ─────────────────────────────────────
// Arbitrary vendor namespaces, arbitrary verbs, tools that do not exist yet: none of them can be
// enumerated here, and none of them may reach the outer agent.
for (const tool of [
  'mcp__vendor__mutate',
  'mcp__vendor__delete_everything',
  'mcp__slack__post_message', 'mcp__slack__upload_file',
  'mcp__firecrawl__firecrawl_scrape', 'mcp__firecrawl__crawl',
  'mcp__github__create_pull_request',
  'mcp__stripe__create_charge',
  'ATotallyNewToolFromAFutureRelease',
  'ExitPlanMode', 'SlashCommand', 'Skill', 'Task', 'Agent',
  'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'ReadMcpResourceTool', 'ListMcpResourcesTool',
  'SendUserFile', 'Artifact', 'CronCreate', 'ScheduleWakeup', 'Monitor',
  'workflow', 'WORKFLOW', 'Workflow2', 'MyWorkflow', 'toolsearch',   // near-misses are not matches
]) {
  assert.equal(decide(outer(tool)).deny, true, `the outer igniter may not use ${tool}`);
  assert.equal(deniedForOuter(tool), true, `${tool} is off-limits to the outer agent`);
}
// Exact-match only: the allowlist must not be satisfied by a substring or a different case.
assert.equal(deniedForOuter('Workflow'), false);
assert.equal(deniedForOuter('ToolSearch'), false);

// ── SUBAGENTS KEEP THEIR NORMAL TOOLS ─────────────────────────────────────────────────────
// This is the half production lost when the boundary was process-wide: the planner has to read the
// repository and the implementer has to write and execute it.
for (const tool of [
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit',
  'mcp__slack__send_message', 'mcp__vendor__mutate', 'AskUserQuestion', 'TodoWrite',
  'Workflow', 'ToolSearch', 'ATotallyNewToolFromAFutureRelease',
]) {
  assert.equal(decide(inner(tool)).deny, false, `a workflow subagent keeps ${tool}`);
}

// ── FAIL CLOSED ON ANYTHING THE GUARD CANNOT UNDERSTAND ───────────────────────────────────
assert.equal(decide(null).deny, true, 'an unreadable payload is denied');
assert.equal(decide(undefined).deny, true, 'a missing payload is denied');
assert.equal(decide('not an object').deny, true, 'a non-object payload is denied');
assert.equal(decide({}).deny, true, 'a payload naming no tool is denied');
assert.equal(decide({ tool_name: '' }).deny, true, 'an empty tool name is denied');
assert.equal(decide({ tool_name: 42 }).deny, true, 'a non-string tool name is denied');
// Agent identity must be a real string: an empty or non-string agent_id is NOT a subagent, so a
// forged-looking payload cannot buy the subagent exemption.
assert.equal(decide({ tool_name: 'Read', agent_id: '' }).deny, true, 'an empty agent id is not a subagent');
assert.equal(decide({ tool_name: 'Read', agent_id: null }).deny, true, 'a null agent id is not a subagent');
assert.equal(decide({ tool_name: 'Read', agent_id: 123 }).deny, true, 'a numeric agent id is not a subagent');
assert.equal(decide({ tool_name: 'Read', agent_type: 'general-purpose' }).deny, true,
  'agent_type alone does not make a call a subagent call — identity comes from agent_id');
assert.equal(isSubagentCall({ agent_id: 'a' }), true);
assert.equal(isSubagentCall({}), false);
assert.equal(isSubagentCall(null), false);

console.log('igniter-guard.test: all assertions passed');
