// Rehearsal engine. Same interface as the live claude/codex adapters, fully
// scripted so the whole loop — findings, a human question, a verify failure,
// the green — plays out in ~2 minutes with zero network models and zero cost.
// The deterministic verifier still runs for real against these drafts.

const SPEED = Number(process.env.MOCK_SPEED || 1);
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms * SPEED);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

// The rehearsal is scripted, but its FINAL deliverable must be honestly
// defensible: a demo that ends on a laundered green — claims cited to pages that
// do not establish them — would show Camus blessing the exact thing it exists to
// catch. So the final memo cites ONLY definitional facts each page genuinely
// states (verified by hand against the live articles 2026-07-14: Customer
// retention = "the ability of a company to retain its customers"; Network effect
// = value "depends on the number of users"; Word-of-mouth marketing =
// "communication between consumers ... independent of direct commercial
// influence"; Digital marketing = "uses digital technologies ... to promote
// products"; Customer acquisition cost = "the cost of persuading a customer to
// purchase"). The strategic recommendation is LABELLED an inference from those
// facts, not passed off as sourced. The only unaccountable claims are in REV1,
// which the reviewer catches.
const SOURCES_OK = `## Sources
1. Digital marketing — Wikipedia — https://en.wikipedia.org/wiki/Digital_marketing
2. Customer retention — Wikipedia — https://en.wikipedia.org/wiki/Customer_retention
3. Network effect — Wikipedia — https://en.wikipedia.org/wiki/Network_effect
4. Word-of-mouth marketing — Wikipedia — https://en.wikipedia.org/wiki/Word-of-mouth_marketing`;

// REV1: the plausible-but-unaccountable first draft the reviewer is meant to
// catch (an uncited statistic, a promissory phrase, and a one-sided argument).
const REV1 = `## Summary
Community-led growth beats paid acquisition for consumer subscription apps, full stop. An owned community produces guaranteed returns on every launch, so the smart move is to stop spending on ads.

## Key Findings
1. Apps with active community programs retain 61% more of their monthly actives than paid-first comparables.
2. Paid spend resets to zero the moment a campaign ends, while a community keeps compounding.

## Implications
Put the budget into community programs and treat paid as a distraction.

${SOURCES_OK}`;

// REV2: the three findings fixed. Each claim is now a definition its cited page
// states verbatim, the strategic read is labelled an inference, and paid gets
// its steelman — but the recommendation still does not name a launch strategy.
const REV2 = `## Summary
Community-led growth and paid acquisition solve different problems for a consumer subscription app; this memo weighs which should lead. The findings are general marketing definitions; the recommendation is an inference from them, to be tested against the client's own data.

## Key Findings
1. Digital marketing uses digital technologies and platforms to promote products and services [1].
2. Customer retention is a business's ability to keep its existing customers, so high retention means they keep returning rather than leaving [2].
3. A product with network effects gives each user more value as more people use it [3].
4. Word-of-mouth marketing is communication between consumers, independent of direct commercial influence [4].

## Implications
Inference (not a sourced fact): a community compounds retention and word-of-mouth and benefits from network effects, while paid buys reach a community cannot. Lead with community and use paid as an amplifier — but test this against the client's own numbers before it drives budget.

${SOURCES_OK}`;

// REV3: recommendation anchored to the human's answer (self-serve launch) and a
// fifth finding added — but its source link is dead, which the reviewer cannot
// see and the deterministic gate will.
const REV3 = `## Summary
For a consumer subscription app launching self-serve first, this memo recommends leading with community-led growth and using paid acquisition as an amplifier. The findings are general marketing definitions; the recommendation is an inference from them, to be tested against the client's own data before committing budget.

## Key Findings
1. Digital marketing uses digital technologies and platforms to promote products and services [1].
2. Customer retention is a business's ability to keep its existing customers, so high retention means they keep returning rather than leaving [2].
3. A product with network effects gives each user more value as more people use it [3].
4. Word-of-mouth marketing is communication between consumers, independent of direct commercial influence [4].
5. Customer acquisition cost is what it costs to persuade someone to buy, and it is a core metric related to customer lifetime value [5].

## Implications
Inference (not a sourced fact): a community compounds retention and word-of-mouth and benefits from network effects, which tends to lower acquisition cost, while paid buys the reach a community cannot. Lead with community, use paid as an amplifier, and treat the sequence as a hypothesis to test against the client's own retention and acquisition-cost data.

${SOURCES_OK}
5. Customer acquisition cost — reference — https://github.com/Myosin-xyz/does-not-exist-archive`;

// REV4: the dead fifth source swapped for the live page whose definition finding
// 5 states. Nothing else changes — the claims were already definitional — so the
// final green certifies a deliverable that cites only what its pages establish.
const REV4 = REV3.replace(
  '5. Customer acquisition cost — reference — https://github.com/Myosin-xyz/does-not-exist-archive',
  '5. Customer acquisition cost — Wikipedia — https://en.wikipedia.org/wiki/Customer_acquisition_cost',
);

const PLAN = `- Frame the decision: community-led vs paid-first for a consumer subscription app
- Cite only definitions each source genuinely states: paid reach, retention, network effects, word-of-mouth, acquisition cost
- Keep the strategic recommendation as a labelled inference, never a sourced fact
- Anchor the recommendation to the client's actual launch strategy
- Flag every specific as needing the client's own data before it drives budget`;

const REVIEWS = [
  {
    ran: true, error: null, verdict: 'REVISE',
    findings: [
      { severity: 'high', title: 'Retention figure has no source', detail: 'Finding 1 claims “retain 61% more of their monthly actives” with no citation. I cannot locate this number in any current report; it reads like a remembered statistic.', suggestion: 'Replace with a claim you can trace to a live source, or delete the number and keep the direction.' },
      { severity: 'high', title: 'Promissory phrasing: guaranteed returns', detail: 'The summary says an owned community “produces guaranteed returns on every launch”. That is a promissory claim no marketing team can stand behind.', suggestion: 'Describe the mechanic (lower acquisition cost, higher retention) without promising outcomes.' },
      { severity: 'medium', title: 'No steelman for paid', detail: 'The memo calls paid “a distraction” and never says where it wins, so it reads like advocacy rather than analysis.', suggestion: 'Add one finding on the job paid does better than community.' },
    ],
    blocking: 3, questions: [],
  },
  {
    ran: true, error: null, verdict: 'REVISE',
    findings: [
      { severity: 'medium', title: 'Recommendation is unanchored', detail: 'The implications section recommends sequencing but never says for which launch strategy; the answer differs for a self-serve launch vs a partnerships-led one.', suggestion: 'Anchor the recommendation to the client’s actual Q3 launch plan.' },
    ],
    blocking: 1,
    questions: ['This memo can argue for either a self-serve launch or a partnerships-led launch. Which fits the client’s Q3 goal?'],
  },
  { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: 0, questions: [] },
];

export function createMockAdapters() {
  let claudeCalls = 0;
  let reviewCalls = 0;

  return {
    name: 'mock',
    async claude({ stage, signal, onTick, onSession }) {
      onTick?.(stage === 'plan' ? 'planning…' : 'drafting: researching sources…');
      if (stage !== 'plan') {
        onSession?.('WebSearch: consumer app ad policy tightening 2026');
        await sleep(2500, signal);
        onSession?.('WebFetch: https://en.wikipedia.org/wiki/Digital_marketing');
        await sleep(2000, signal);
        onSession?.('WebSearch: referral cohort retention decay');
        await sleep(1500, signal);
      } else {
        await sleep(2500, signal);
      }
      if (stage === 'plan') return { ok: true, error: null, text: PLAN, costUsd: 0 }; // rehearsal spends nothing
      claudeCalls += 1;
      const revs = [REV1, REV2, REV3, REV4];
      return { ok: true, error: null, text: revs[Math.min(claudeCalls - 1, revs.length - 1)], costUsd: 0 }; // rehearsal spends nothing
    },
    async codex({ signal, onTick, onSession, model, effort, claims = [], criteria = [], thresholds = [], auditOnly = false }) {
      onTick?.('reviewer reading and drafting findings…');
      onSession?.('turn started');
      await sleep(3000, signal);
      onSession?.('reasoning: checking each claim against the page it cites');
      onTick?.('reviewer checking evidence…');
      await sleep(3000, signal);
      onSession?.('reasoning: scanning for promissory phrasing and unsupported multiples');
      await sleep(1000, signal);
      onSession?.('verdict drafted (412 chars)');
      const r = auditOnly
        ? { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: 0, questions: [] }
        : REVIEWS[Math.min(reviewCalls, REVIEWS.length - 1)];
      reviewCalls += 1;
      const findings = r.findings;
      return {
        ...r,
        reviewerModel: model ?? 'scripted',
        reviewerEffort: effort ?? 'scripted',
        durationMs: 7000,
        usage: null,
        findings,
        blocking: findings.filter((f) => f.severity !== 'low'),
        nonblocking: findings.filter((f) => f.severity === 'low'),
        // Scripted assessments make the rehearsal arc legible, but the sealed
        // pack forces every rehearsal decision back to unchecked. Simulation
        // never impersonates independent semantic judgment.
        claimAssessments: claims.map((c) => ({ marker: c.marker, decision: 'supported', evidence: 'scripted rehearsal assessment' })),
        coverageAssessments: criteria.map((c) => ({ criterion_id: c.id, decision: 'met', evidence: 'scripted rehearsal assessment' })),
        thresholdAssessments: thresholds.map((t) => ({ id: t.id, decision: 'policy', evidence: 'scripted rehearsal assessment' })),
      };
    },
  };
}


// Scripted build-lane run: the gate's beats without the gate, so the code
// lane rehearses on any machine. Mirrors runCodeLoop's event shapes.
export async function runMockCodeLoop(run, ctx) {
  const { emit, waitForAnswer, signal } = ctx;
  const answers = [];
  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });
  const sess = (line) => emit('session', { actor: 'gate', line });
  try {
    stage('gate', 'active');
    sess(`invocation: /camus-loop {"task":"${run.goal.slice(0, 60)}…","targetPath":"${run.targetPath}"}`);
    await sleep(2000, signal);
    sess('Bash: git -C . status --porcelain');
    sess('Bash: bash ~/.claude/skills/camus/scripts/wt.sh create camus-wt-mock ~/.camus/worktrees/…');
    log('gate preflight clean: worktree created, baseline verified');
    await sleep(3000, signal);
    sess('Edit: src/embedding.ts — guard empty input before the provider call');
    sess('Bash: pnpm test  (baseline + new spec)');
    await sleep(2500, signal);
    emit('round', { round: 1, cap: 3 });
    stage('review', 'done', { round: 1 });
    log('gate review round 1: revise (2 blocking)');
    sess('reviewer: missing empty-array guard on the batch path');
    await sleep(2000, signal);
    const q = 'Two callers expect different shapes from the guard. Which contract should win — throw on empty, or return an empty embedding set?';
    const answer = await waitForAnswer({ kind: 'decision', text: q });
    if (signal.aborted) throw new Error('stopped_by_human');
    answers.push({ kind: 'decision', question: q, answer });
    emit('answer', { kind: 'decision', question: q, answer });
    stage('gate', 'active');
    sess('resuming with humanAnswer; gate continues from its receipts');
    await sleep(2500, signal);
    emit('round', { round: 2, cap: 3 });
    stage('review', 'done', { round: 2 });
    log('gate review round 2: clean');
    sess('Bash: pnpm test  — 163 passed · head-bound (simulated)');
    await sleep(1500, signal);
    // Rehearsal creates no gate branch, commit, or gate receipt. Studio still
    // writes its local simulation trace (run.json, events.jsonl, report.json)
    // so the scripted session can be replayed honestly.
    const report = {
      status: 'done',
      simulated: true,
      branch: null,
      commit: null,
      report: null,
      note: 'No gate evidence was created; Studio saved only a local simulation trace.',
    };
    stage('gate', 'done', { pass: true });
    stage('ship', 'done');
    emit('gate_report', { report });
    emit('status', { status: 'done', rev: 0, costUsd: 0 });
    return { status: 'done', simulated: true, costUsd: 0, report, answers };
  } catch (err) {
    if (err.message === 'aborted' || err.message === 'stopped_by_human' || signal.aborted) {
      emit('status', { status: 'stopped', costUsd: 0 });
      return { status: 'stopped', simulated: true, costUsd: 0, answers };
    }
    emit('error', { message: String(err) });
    emit('status', { status: 'failed', costUsd: 0 });
    return { status: 'failed', simulated: true, costUsd: 0, answers };
  }
}
