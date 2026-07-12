// Prompt contracts for the loop. The shapes mirror camus v2-lite: a maker that
// must leave citable evidence, an adversarial reviewer that must answer in
// strict JSON, and a fixer that is forbidden from arguing with the verifier.

import { LANES } from './verify.mjs';

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

export function makePrompt({ goal, lane, depth, grounding, answers }) {
  const groundingBlock = grounding === 'claude'
    ? `\n\nGROUNDING — you have Hivemind MCP tools (mcp__hivemind__knowledge_search; also search/fetch where available): Myosin's specialist marketing knowledge, written by practitioners. Before drafting, run 2-4 focused knowledge_search queries on the goal's key angles. Where a returned chunk shapes a claim, cite it [H1], [H2], … and list each under a "### Hivemind" subsection inside ## Sources as "[Hn] Title — Author". If the tools error or return nothing relevant, draft without them — never fabricate an [Hn] citation.`
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

${LANE_BRIEFS[lane] ?? LANE_BRIEFS.freeform}

${depthBrief(depth)}

HARD RULES — a deterministic gate checks these mechanically and WILL bounce the draft:
1. Every quantitative claim (%, $, multiples, big counts) must carry a [n] citation in the same sentence, resolving to a real URL under ## Sources.
2. Only cite URLs you have actually loaded and that support the claim. Never invent or "remember" a URL.
3. No promissory financial phrasing (guaranteed returns, risk-free, price multiples like "100x", buy calls). Describe mechanics, not price outcomes.
4. Write like a person: plain sentences, no filler, no hype.${groundingBlock}${answersBlock}

Respond with ONLY the markdown deliverable. No preamble, no commentary.`;
}

export function planPrompt({ goal, lane, depth }) {
  return `You are planning a research deliverable before writing it. Goal:
${goal}

Deliverable type: ${LANES[lane]?.label ?? 'Freeform'}. ${depthBrief(depth)}

Reply with 4-6 terse bullet points: the angles you will investigate, the 2-3 source types you will lean on, and the single biggest risk of getting this wrong. Plain text bullets, nothing else.`;
}

export function reviewPrompt({ goal, lane, draft, round, priorFindings, answers }) {
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

  return `You are an adversarial reviewer from a different firm, paid to find what is wrong with this deliverable before the client does. You gain nothing from being nice. Round ${round}.

THE GOAL THE DELIVERABLE MUST SERVE:
${goal}

THE DRAFT (${LANES[lane]?.label ?? 'Freeform'}):
---
${draft}
---

Attack it on: (a) claims that are unsupported, overstated, or likely hallucinated; (b) sources that do not plausibly say what is claimed; (c) missing angles a competent analyst would be embarrassed to have missed; (d) internal contradictions; (e) voice — hype, filler, or AI-sounding patterns; (f) anything a regulator or platform would flag.

Do NOT nitpick style trivia. Raise only findings that change whether the client should trust or act on this.

If a finding hinges on a decision only the goal owner can make (audience, scope, positioning, risk appetite), do NOT guess — put it in "questions_for_human". Never ask about a decision listed as already made.${prior}${decided}

Respond with STRICT JSON only (no markdown fences, no commentary):
{
  "verdict": "revise" | "clean",
  "findings": [
    { "severity": "high" | "medium" | "low", "title": "<short stable title>", "detail": "<what is wrong, with the exact quote>", "suggestion": "<the concrete fix>" }
  ],
  "questions_for_human": [ "<plain-English question, only if truly undecidable>" ]
}
"clean" requires zero high or medium findings.`;
}

export function fixPrompt({ goal, lane, draft, findings, verifyFailures, answers, viaClaude }) {
  const hmBlock = viaClaude
    ? `\nYou still have the Hivemind MCP tools (mcp__hivemind__knowledge_search) — use them if a fix needs a replacement internal source, and keep every [Hn] marker mapped to a "### Hivemind" entry under ## Sources. Never fabricate an [Hn] citation.\n`
    : '';
  const findingsBlock = findings?.length
    ? `REVIEWER FINDINGS TO RESOLVE (all of them):\n${findings
        .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}\n  Fix: ${f.suggestion}`)
        .join('\n')}`
    : '';
  const verifyBlock = verifyFailures?.length
    ? `\nDETERMINISTIC GATE FAILURES — these are mechanical, not opinions; the exact same check reruns after you revise:\n${verifyFailures
        .map((c) => `- ${c.label}: ${c.detail}`)
        .join('\n')}`
    : '';
  const answersBlock = answers?.length
    ? `\nHUMAN DECISIONS (binding):\n${answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n')}`
    : '';

  return `Revise the deliverable below. Keep its structure and everything that survived review; change only what the findings and gate failures require. If a claim cannot be sourced with a real URL, delete or soften the claim — never invent a source.

GOAL:
${goal}

CURRENT DRAFT:
---
${draft}
---
${hmBlock}
${findingsBlock}${verifyBlock}${answersBlock}

Respond with ONLY the full revised markdown deliverable. No preamble, no change-notes.`;
}
