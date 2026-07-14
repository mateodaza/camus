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

const SOURCES_OK = `## Sources
1. State of Crypto Report — a16z crypto — https://a16zcrypto.com
2. Electric Capital Developer Report — https://www.electriccapital.com
3. Network effect — Wikipedia — https://en.wikipedia.org/wiki/Network_effect
4. Cryptocurrency adoption — Wikipedia — https://en.wikipedia.org/wiki/Cryptocurrency`;

const REV1 = `## Summary
Community-led growth beats paid acquisition for consumer web3 apps at the current stage of the market. Paid channels remain constrained by platform policy, so the compounding asset is an owned community that produces guaranteed returns on every launch.

## Key Findings
1. Crypto ad policy on major platforms still restricts most token-related creative, which pushes CAC up sharply for paid-first teams.
2. Apps with active community programs retain 61% more of their monthly actives than paid-first comparables.
3. Airdrop-driven spikes decay fast; community-originated cohorts decay slower [2].

## Implications
Lead with community programs and treat paid as amplification, so budget follows proof instead of hope.

${SOURCES_OK}`;

const REV2 = `## Summary
Community-led growth beats paid acquisition for consumer web3 apps at the current stage of the market. Paid channels remain constrained by platform policy, so the compounding asset is an owned community that lowers acquisition cost over time.

## Key Findings
1. Crypto ad policy on major platforms still restricts most token-related creative, which pushes acquisition costs up for paid-first teams [1].
2. Developer and user activity keeps consolidating around a few ecosystems, which concentrates where community programs pay off [2].
3. Airdrop-driven spikes decay fast; community-originated cohorts decay slower because joining cost is social, not financial [3].
4. Paid still wins for one job: reaching audiences that never enter crypto-native spaces [4].

## Implications
Lead with community programs and treat paid as amplification, so budget follows proof instead of hope.

${SOURCES_OK}`;

const REV3 = `## Summary
For a consumer web3 app aimed at Base-first distribution, community-led growth is the primary engine and paid acquisition is the amplifier. Platform ad policy keeps most token-related creative constrained, so the compounding asset is an owned community.

## Key Findings
1. Crypto ad policy on major platforms still restricts most token-related creative, which pushes acquisition costs up for paid-first teams [1].
2. Developer and user activity keeps consolidating around a few ecosystems, which concentrates where community programs pay off [2].
3. Airdrop-driven spikes decay fast; community-originated cohorts decay slower because joining cost is social, not financial [3].
4. Paid still wins for one job: reaching audiences that never enter crypto-native spaces [4].
5. Case detail on onchain summer distribution mechanics is documented in the ecosystem archive [5].

## Implications
Sequence the quarter as community first, paid second: prove a retention baseline with owned channels, then buy reach against the segments the community cannot touch.

${SOURCES_OK}
5. Onchain distribution archive — https://github.com/Myosin-xyz/does-not-exist-archive`;

const REV4 = REV3.replace(
  '5. Onchain distribution archive — https://github.com/Myosin-xyz/does-not-exist-archive',
  '5. Onchain ecosystem overview — Wikipedia — https://en.wikipedia.org/wiki/Ethereum',
).replace(
  'documented in the ecosystem archive [5]',
  'documented in the ecosystem overview [5]',
);

const PLAN = `- Frame the decision: community-led vs paid-first for a consumer web3 app, current cycle
- Pull platform ad-policy state and what it does to acquisition cost
- Compare cohort decay: airdrop/paid spikes vs community-originated users
- Name where paid genuinely wins, so this reads like judgment, not cheerleading
- Source types: ecosystem reports, policy pages, one case archive
- Biggest risk: retention numbers that do not trace to a real report`;

const REVIEWS = [
  {
    ran: true, error: null, verdict: 'REVISE',
    findings: [
      { severity: 'high', title: 'Retention figure has no source', detail: 'Finding 2 claims “retain 61% more of their monthly actives” with no citation. I cannot locate this number in any current report — it reads like a remembered statistic.', suggestion: 'Replace with a claim you can trace to a live source, or delete the number and keep the direction.' },
      { severity: 'high', title: 'Promissory phrasing: guaranteed returns', detail: 'The summary says an owned community “produces guaranteed returns on every launch”. That is a promissory financial claim in a crypto context.', suggestion: 'Describe the mechanic (lower acquisition cost, higher retention) without promising outcomes.' },
      { severity: 'medium', title: 'No steelman for paid', detail: 'The memo never states where paid acquisition wins, so it reads like advocacy rather than analysis.', suggestion: 'Add one finding on the job paid does better than community.' },
    ],
    blocking: 3, questions: [],
  },
  {
    ran: true, error: null, verdict: 'REVISE',
    findings: [
      { severity: 'medium', title: 'Recommendation is unanchored', detail: 'The implications section recommends sequencing but never says for which distribution strategy — the answer differs for Base-first vs multichain.', suggestion: 'Anchor the recommendation to the client’s actual Q3 distribution goal.' },
    ],
    blocking: 1,
    questions: ['This memo can argue for either Base-first or multichain distribution — which fits the client’s Q3 goal?'],
  },
  { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: 0, questions: [] },
];

export function createMockAdapters() {
  let claudeCalls = 0;
  let reviewCalls = 0;

  return {
    name: 'mock',
    async claude({ stage, signal, onTick, onSession }) {
      onTick?.(stage === 'plan' ? 'planning…' : 'drafting — researching sources…');
      if (stage !== 'plan') {
        onSession?.('WebSearch: crypto ad policy restrictions 2026');
        await sleep(2500, signal);
        onSession?.('WebFetch: https://a16zcrypto.com');
        await sleep(2000, signal);
        onSession?.('WebSearch: airdrop cohort retention decay');
        await sleep(1500, signal);
      } else {
        await sleep(2500, signal);
      }
      if (stage === 'plan') return { ok: true, error: null, text: PLAN, costUsd: 0 }; // rehearsal spends nothing
      claudeCalls += 1;
      const revs = [REV1, REV2, REV3, REV4];
      return { ok: true, error: null, text: revs[Math.min(claudeCalls - 1, revs.length - 1)], costUsd: 0 }; // rehearsal spends nothing
    },
    async codex({ signal, onTick, onSession, model, effort }) {
      onTick?.('reviewer reading and drafting findings…');
      onSession?.('turn started');
      await sleep(3000, signal);
      onSession?.('reasoning: checking the retention claim against the cited sources');
      onTick?.('reviewer checking evidence…');
      await sleep(3000, signal);
      onSession?.('reasoning: scanning for promissory phrasing and unsupported multiples');
      await sleep(1000, signal);
      onSession?.('verdict drafted (412 chars)');
      const r = REVIEWS[Math.min(reviewCalls, REVIEWS.length - 1)];
      reviewCalls += 1;
      const findings = r.findings;
      return {
        ...r,
        reviewerModel: model ?? 'scripted',
        reviewerEffort: effort ?? 'scripted',
        findings,
        blocking: findings.filter((f) => f.severity !== 'low'),
        nonblocking: findings.filter((f) => f.severity === 'low'),
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
    log('gate preflight clean — worktree created, baseline verified');
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
    sess('resuming with humanAnswer — gate continues from its receipts');
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
