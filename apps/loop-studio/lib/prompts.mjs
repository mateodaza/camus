// Prompt contracts for the loop. The shapes mirror camus v2-lite: a maker that
// must leave citable evidence, an adversarial reviewer that must answer in
// strict JSON, and a fixer that is forbidden from arguing with the verifier.

import { LANES } from './verify.mjs';
import { CLAUDE_HIVEMIND_TOOL } from './adapters/hivemind.mjs';

const LANE_BRIEFS = {
  research_memo: `Structure the deliverable EXACTLY with these markdown sections:
## Summary            — 3-5 sentences, the answer up front
## Key Findings       — numbered findings; each finding that carries a number MUST cite [n]
## Implications       — what this means for the goal owner
## Sources            — numbered list: [n] Title — URL (one per line)`,
  competitor_teardown: `Structure the deliverable EXACTLY with these markdown sections:
## Overview           — who they are, stage, traction signals
## Positioning        — the story they tell, who it lands with
## Channels           — where they show up and what appears to work; numbers MUST cite [n]
## What We Take       — 3-5 concrete moves for us, ranked
## Sources            — numbered list: [n] Title — URL (one per line)`,
  freeform: `Structure the deliverable with clear markdown sections that fit the goal. If you make quantitative claims, cite them [n] against a final "## Sources" section with real URLs.`,
};

export function depthBrief(depth) {
  return depth === 'standard'
    ? 'Target 1,200–1,800 words with 6–10 distinct sources.'
    : 'Target 700–1,100 words with 4–6 distinct sources. Depth "quick": favor precision over coverage.';
}

const contractBlock = (acceptanceContract) => `ACCEPTANCE CONTRACT — the result is only acceptable if this is true:\n${acceptanceContract || 'No explicit contract was supplied (legacy run); do not infer one.'}\nThis contract outranks generic length, source-count, and query-count suggestions below. Never add material merely to hit those defaults.`;

export function groundingPrompt({ goal, acceptanceContract }) {
  return `Freeze the internal knowledge this research run may use. First use ToolSearch with "select:${CLAUDE_HIVEMIND_TOOL}" to load the exact managed Hivemind tool, then use only that knowledge_search tool. Run 2-4 focused queries that can answer the goal, test its assumptions, and expose tradeoffs. If the goal names a document, author, brand, or exact phrase, search that exact wording before broadening. If a query returns nothing, reformulate it rather than treating an empty result as evidence. Do not draft the deliverable and do not use web search.

GOAL:
${goal}

${contractBlock(acceptanceContract)}

After the tool calls, reply with one sentence saying the snapshot is ready. Camus will assign stable [Hn] markers to the captured results before drafting.`;
}

export function groundingRetryPrompt(args) {
  return `REQUIRED TOOL RETRY — the previous retrieval attempt returned text without calling knowledge_search. This attempt succeeds only if an actual tool call is observed.

You MUST first call ToolSearch with "select:${CLAUDE_HIVEMIND_TOOL}", then call the loaded knowledge_search tool at least once. Do not explain the instructions, report that you are waiting, or reply with prose before the knowledge_search call. A text-only answer is a failed retry.

${groundingPrompt(args)}`;
}

export function makePrompt({ goal, acceptanceContract, lane, depth, grounding, answers }) {
  const groundingBlock = grounding === 'claude'
    ? `\n\nGROUNDING — Myosin's specialist marketing knowledge is available through its managed Hivemind connector. First use ToolSearch with "select:${CLAUDE_HIVEMIND_TOOL}" to load the exact tool. Before drafting, normally run 2-4 focused knowledge_search queries on the goal's key angles; use fewer when the acceptance contract explicitly narrows the query or source scope. Where a returned chunk shapes a claim, cite it [H1], [H2], … and list each under a "### Hivemind" subsection inside ## Sources as "[Hn] Title — Author". If the tool errors or returns nothing relevant, draft without it — never fabricate an [Hn] citation.`
    : grounding?.length
      ? `\n\nGROUNDING — internal knowledge retrieved from Hivemind (Myosin's specialist network). Prefer these over general knowledge where they apply, and cite them as [H1], [H2], … in a "### Hivemind" subsection under Sources ("[Hn] Title — Author"):\n${grounding
          .map((g, i) => `[H${i + 1}] ${g.title}\n${g.text}`)
          .join('\n\n')}`
      : '';
  const answersBlock = answers?.length
    ? `\n\nHUMAN DECISIONS — the goal owner answered these mid-run; they are binding:\n${answers
        .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
        .join('\n')}`
    : '';

  return `You are a senior researcher and strategist drafting a deliverable the goal owner will defend tomorrow.

GOAL:
${goal}

${contractBlock(acceptanceContract)}

${LANE_BRIEFS[lane] ?? LANE_BRIEFS.freeform}

${depthBrief(depth)}

HARD RULES — a deterministic gate checks these mechanically and WILL bounce the draft:
1. Every quantitative claim (%, $, multiples, big counts) must carry a [n] citation in the same sentence, resolving to a real URL under ## Sources.
   Exception — a PROPOSED decision threshold is your own policy, not an observed statistic, so it has no source to cite. ONLY when the acceptance contract asks for a measurable decision rule AND no retrieved source establishes the number, put it in a "## Decision Rule" (or "## Success Criteria") section as a bullet carrying this EXACT marker: "- Proposed threshold (decision policy, not observed performance): proceed if <metric> exceeds <value>." Any figure you present as observed performance still needs its [n] citation — the marker never covers a factual claim.
2. Only cite URLs you have actually loaded and that support the claim. Never invent or "remember" a URL.
3. No promissory financial phrasing (guaranteed returns, risk-free, price multiples like "100x", buy calls). Describe mechanics, not price outcomes.
4. Write like a person: plain sentences, no filler, no hype.${groundingBlock}${answersBlock}

Respond with ONLY the markdown deliverable. No preamble, no commentary.`;
}

export function planPrompt({ goal, acceptanceContract, lane, depth }) {
  return `You are planning a research deliverable before writing it. Goal:
${goal}

${contractBlock(acceptanceContract)}

Deliverable type: ${LANES[lane]?.label ?? 'Freeform'}. ${depthBrief(depth)}

Do NOT ask questions. Planning does not pause the run, so a question here appears only as planner text and cannot be answered. If an input is missing, name it as a risk; Camus raises human questions later through explicit checkpoints.

Reply with 4-6 terse bullet points: the angles you will investigate, the 2-3 source types you will lean on, and the single biggest risk of getting this wrong. Plain text bullets, nothing else.`;
}

export function reviewPrompt({ goal, acceptanceContract, lane, draft, round, priorFindings, answers, groundingEvidence, claims = [], criteria = [], thresholds = [], closure = false, auditOnly = false }) {
  const prior = priorFindings?.length
    ? `\n\nFINDINGS YOU RAISED IN EARLIER ROUNDS (check whether they are actually resolved; re-raise with the SAME title if not):\n${priorFindings
        .map((f) => `- [${f.severity}] ${f.title}`)
        .join('\n')}`
    : '';
  const decided = answers?.length
    ? `\n\nDECISIONS THE GOAL OWNER ALREADY MADE (settled — judge the draft against them; do NOT re-raise them as questions):\n${answers
        .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
        .join('\n')}`
    : '';
  const resultEvidence = (groundingEvidence?.results ?? []).length
    ? `\n- observed result excerpts (adapter-captured, bounded):\n${groundingEvidence.results.map((r, i) => `  [R${i + 1}] query=${JSON.stringify(r.query)}; source=${JSON.stringify([r.title, r.author].filter(Boolean).join(' — '))}; ref=${JSON.stringify(r.ref ?? null)}; score=${r.score ?? 'unknown'}\n  excerpt: ${JSON.stringify(String(r.excerpt ?? '').slice(0, 1000))}`).join('\n')}`
    : '\n- observed result excerpts: none';
  const runtimeGrounding = groundingEvidence
    ? `\n\nRUNTIME GROUNDING EVIDENCE (emitted from actual adapter tool_use/tool_result events, not from the maker's prose):\n- mode: ${groundingEvidence.mode ?? 'unknown'}\n- Hivemind queried: ${groundingEvidence.queried ? 'yes' : 'no'}\n- observed Hivemind tool calls: ${groundingEvidence.queryCount ?? 0}\n- observed queries: ${(groundingEvidence.queries ?? []).length ? groundingEvidence.queries.map((q) => JSON.stringify(q)).join('; ') : 'none'}${resultEvidence}\nTool calls prove retrieval occurred. Result excerpts let you audit whether cited claims match retrieved material; they do not make the material true or relevant by default.`
    : '';
  const claimLedger = claims.length
    ? `\n\nCLAIM LEDGER TO ASSESS (one decision per marker, covering every claim grouped under it):\n${claims.map((c) => {
        const internal = c.marker.match(/^\[H(\d+)\]$/i);
        const source = c.url ? c.url : `receipt-bound Hivemind result [R${internal?.[1] ?? '?'}]`;
        return `- ${c.marker} ${c.claim}; source=${source}`;
      }).join('\n')}\nFor each marker return supported ONLY if you inspected source content that entails the grouped claim and can name the supporting passage. Return unsupported for a mismatch or overstatement. Return unchecked when the source content was unavailable. A live URL alone is never support. If any item is unsupported, raise a high/medium finding and verdict revise. If a clean verdict contains unchecked items, add a low finding so the caveat survives.`
    : '\n\nCLAIM LEDGER TO ASSESS: no cited claims. Return an empty claim_assessments array.';
  const coverageLedger = criteria.length
    ? `\n\nACCEPTANCE COVERAGE TO ASSESS (deterministically extracted; assess every criterion exactly once):\n${criteria.map((c) => `- ${c.id} ${c.text}`).join('\n')}\nReturn met only when the exact deliverable provides concrete evidence that the criterion is satisfied. Return unmet when it does not; raise a high/medium finding and verdict revise. Return unclear when the evidence is insufficient; a clean verdict must keep that uncertainty as a low finding. Do not rewrite, merge, or invent criteria.`
    : '\n\nACCEPTANCE COVERAGE TO ASSESS: no criteria. Return an empty coverage_assessments array.';
  const thresholdLedger = thresholds.length
    ? `\n\nPROPOSED-THRESHOLD LEDGER TO ASSESS (deterministically extracted; assess every one exactly once). Each line below was EXEMPTED from the citation gate because it is marked as proposed decision policy — a number the goal owner is CHOOSING, not one they measured:\n${thresholds.map((t) => `- ${t.id} [under "${t.section ?? 'unknown section'}"] ${t.line}${t.stats.length ? `  (numbers: ${t.stats.join(', ')})` : ''}`).join('\n')}\nReturn policy ONLY if the line genuinely sets a forward-looking decision rule. Return observed if ANY number on it is presented as real, achieved, or measured performance — that is a factual statistic wearing the marker to dodge citation, i.e. laundering. An observed threshold must raise a high/medium finding that names it and verdict revise; it can never ride a clean verdict. Do not rewrite or merge these lines.`
    : '\n\nPROPOSED-THRESHOLD LEDGER TO ASSESS: none. Return an empty threshold_assessments array.';

  const auditFrame = auditOnly
    ? 'This is an audit-only replay over an unchanged sealed artifact. Judge the entire exact deliverable fresh; do not propose a rewrite as if you were its maker.'
    : closure
      ? 'This is the closure audit: a deterministic repair changed the artifact after its prior review, so judge this entire exact deliverable fresh.'
      : `Round ${round}.`;

  return `You are an adversarial reviewer from a different firm, paid to find what is wrong with this deliverable before the client does. You gain nothing from being nice. ${auditFrame}

THE GOAL THE DELIVERABLE MUST SERVE:
${goal}

${contractBlock(acceptanceContract)}

THE DRAFT (${LANES[lane]?.label ?? 'Freeform'}):
---
${draft}
---

Attack it on: (a) claims that are unsupported, overstated, or likely hallucinated; (b) sources that do not plausibly say what is claimed; (c) missing angles a competent analyst would be embarrassed to have missed; (d) internal contradictions; (e) voice — hype, filler, or AI-sounding patterns; (f) anything a regulator or platform would flag.

Do NOT nitpick style trivia. Raise only findings that change whether the client should trust or act on this.

If a finding hinges on a decision only the goal owner can make (audience, scope, positioning, risk appetite), do NOT guess — put it in "questions_for_human". Never ask about a decision listed as already made.${runtimeGrounding}${claimLedger}${coverageLedger}${thresholdLedger}${prior}${decided}

Respond with STRICT JSON only (no markdown fences, no commentary):
{
  "verdict": "revise" | "clean",
  "findings": [
    { "severity": "high" | "medium" | "low", "title": "<short stable title>", "detail": "<what is wrong, with the exact quote>", "suggestion": "<the concrete fix>" }
  ],
  "questions_for_human": [ "<plain-English question, only if truly undecidable>" ],
  "claim_assessments": [
    { "marker": "[1]", "decision": "supported" | "unsupported" | "unchecked", "evidence": "<supporting/contradicting passage, or why it could not be checked>" }
  ],
  "coverage_assessments": [
    { "criterion_id": "C1", "decision": "met" | "unmet" | "unclear", "evidence": "<concrete proof from the deliverable, or why coverage remains unclear>" }
  ],
  "threshold_assessments": [
    { "id": "T1", "decision": "policy" | "observed", "evidence": "<why it is a genuine proposed policy, or which number it presents as observed performance>" }
  ]
}
"clean" requires zero high or medium findings. All three assessment arrays must cover their supplied ledgers exactly.`;
}

export function fixPrompt({ goal, acceptanceContract, lane, draft, findings, verifyFailures, answers, viaClaude }) {
  const hmBlock = viaClaude
    ? `\nYou still have the managed Hivemind MCP tool. If a fix needs a replacement internal source, first load it with ToolSearch query "select:${CLAUDE_HIVEMIND_TOOL}", then call it. Keep every [Hn] marker mapped to a "### Hivemind" entry under ## Sources. Never fabricate an [Hn] citation.\n`
    : '';
  const findingsBlock = findings?.length
    ? `REVIEWER FINDINGS TO RESOLVE (all of them):\n${findings
        .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}\n  Fix: ${f.suggestion}`)
        .join('\n')}`
    : '';
  const verifyBlock = verifyFailures?.length
    ? `\nDETERMINISTIC GATE FAILURES — these are mechanical, not opinions; the exact same check reruns after you revise:\n${verifyFailures
        .map((c) => `- ${c.label}: ${c.detail}`)
        .join('\n')}\nIf a flagged number is actually a PROPOSED decision threshold the contract asks for — not observed performance — do not hunt for a source or soften it away. Move it into a "## Decision Rule" (or "## Success Criteria") section as a bullet with the EXACT marker "- Proposed threshold (decision policy, not observed performance): …". That marker clears the stat check only inside that section; a figure describing real, observed performance still needs a [n] citation.`
    : '';
  const answersBlock = answers?.length
    ? `\nHUMAN DECISIONS (binding):\n${answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n')}`
    : '';

  return `Revise the deliverable below. Keep its structure and everything that survived review; change only what the findings and gate failures require. If a claim cannot be sourced with a real URL, delete or soften the claim — never invent a source.

GOAL:
${goal}

${contractBlock(acceptanceContract)}

CURRENT DRAFT:
---
${draft}
---
${hmBlock}
${findingsBlock}${verifyBlock}${answersBlock}

Respond with ONLY the full revised markdown deliverable. No preamble, no change-notes.`;
}
