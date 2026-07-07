// The loop, ported from camus v2-lite and pointed at deliverables instead of
// patches: plan → draft → (adversarial review ↔ fix)* → deterministic verify →
// done | needs_human. Stop rules are camus's: bounded rounds, repeat findings
// halt instead of re-litigating, oscillating findings halt, infra failures are
// never a pass, and every pause routes a plain-English question to the human.

import { planPrompt, makePrompt, reviewPrompt, fixPrompt } from './prompts.mjs';
import { runVerify } from './verify.mjs';

const ROUND_CAP = Math.min(6, Math.max(1, Number(process.env.ROUND_CAP || 3)));

// Finding identity for repeat detection (camus findingKey, minus file paths —
// content findings have stable titles instead of code locations).
function findingKey(f) {
  const t = (f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t || null;
}

export async function runLoop(run, ctx) {
  const { emit, waitForAnswer, adapters, hivemind, signal } = ctx;
  const answers = [];
  let costUsd = 0;
  let doneWithFindings = false;

  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });

  // Adapter call with one infra retry, then a human decision. Fail-closed:
  // there is no path from "the model call broke" to "assume it was fine".
  async function withRetries(label, fn) {
    for (;;) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal.aborted) throw new Error('aborted');
        const res = await fn();
        const failed = res.ran === false || res.ok === false;
        if (!failed) return res;
        log(`${label} infra failure (attempt ${attempt}/2): ${res.error}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
      }
      const choice = await waitForAnswer({
        kind: 'infra',
        text: `The ${label} step failed twice at the infrastructure level. The loop never treats a broken step as a pass — retry it, or stop the run?`,
        options: ['Retry', 'Stop the run'],
      });
      if (choice !== 'Retry') throw new Error('stopped_by_human');
      log(`${label}: human chose retry.`);
    }
  }

  try {
    // ---- Plan ------------------------------------------------------------
    stage('plan', 'active');
    const plan = await withRetries('plan', () =>
      adapters.claude({ stage: 'plan', prompt: planPrompt(run), cwd: ctx.scratchDir, signal, onTick: log }),
    );
    costUsd += plan.costUsd || 0;
    emit('plan', { text: plan.text });
    stage('plan', 'done');

    // ---- Grounding (Hivemind) ---------------------------------------------
    let grounding = null;
    if (run.ground) {
      stage('ground', 'active');
      grounding = await hivemind.searchKnowledge(run.goal, 4, log);
      stage('ground', 'done', { connected: !!grounding });
    }

    // ---- Draft -------------------------------------------------------------
    stage('make', 'active');
    let draft = null;
    let rev = 0;
    const makeRes = await withRetries('draft', () =>
      adapters.claude({
        stage: 'make',
        prompt: makePrompt({ ...run, grounding, answers }),
        cwd: ctx.scratchDir,
        signal,
        onTick: log,
      }),
    );
    costUsd += makeRes.costUsd || 0;
    draft = makeRes.text;
    rev = 1;
    emit('revision', { rev, markdown: draft });
    emit('cost', { costUsd });
    stage('make', 'done');

    // ---- Review ↔ fix ------------------------------------------------------
    const allSeenKeys = new Set();
    let priorKeys = new Set();
    const priorFindings = [];
    let lastReview = null;

    for (let round = 1; round <= ROUND_CAP; round++) {
      stage('review', 'active', { round });
      emit('round', { round, cap: ROUND_CAP });
      lastReview = await withRetries(`review round ${round}`, () =>
        adapters.codex({
          prompt: reviewPrompt({ goal: run.goal, lane: run.lane, draft, round, priorFindings }),
          cwd: ctx.scratchDir,
          effort: process.env.CODEX_EFFORT || 'medium',
          signal,
          onTick: log,
          receiptDir: `${ctx.receiptsDir}/review-r${round}`,
        }),
      );
      emit('review', { round, verdict: lastReview.verdict, findings: lastReview.findings, questions: lastReview.questions });
      for (const f of lastReview.findings) emit('finding', { round, ...f });
      stage('review', 'done', { round, verdict: lastReview.verdict });

      // Reviewer routed a decision to the human: pause before touching the draft.
      if (lastReview.questions.length) {
        for (const q of lastReview.questions) {
          const answer = await waitForAnswer({ kind: 'decision', text: q });
          answers.push({ question: q, answer });
          emit('answer', { question: q, answer });
        }
      }

      if (lastReview.verdict === 'APPROVED') {
        log(`Review round ${round}: clean.`);
        if (lastReview.nonblocking?.length) doneWithFindings = true;
        break;
      }

      // Stop rules on blocking findings (camus repeat/oscillation logic).
      const keysNow = lastReview.blocking.map(findingKey).filter(Boolean);
      const repeated = keysNow.filter((k) => priorKeys.has(k));
      const returned = keysNow.filter((k) => allSeenKeys.has(k) && !priorKeys.has(k));
      const stuck = round >= 2 && repeated.length ? repeated : returned.length ? returned : null;
      if (stuck) {
        const stuckTitles = lastReview.blocking.filter((f) => stuck.includes(findingKey(f))).map((f) => f.title);
        const choice = await waitForAnswer({
          kind: 'stuck',
          text: `The reviewer keeps raising the same finding${stuckTitles.length > 1 ? 's' : ''} — “${stuckTitles.join('”, “')}”. Camus's rule: never re-litigate. Accept the deliverable with this finding on the record, push one more round, or stop?`,
          options: ['Accept and ship (with findings on record)', 'One more round', 'Stop the run'],
        });
        if (choice.startsWith('Accept')) {
          doneWithFindings = true;
          log('Human accepted the stuck finding — recorded, moving to verify.');
          break;
        }
        if (choice.startsWith('Stop')) throw new Error('stopped_by_human');
        for (const k of stuck) { priorKeys.delete(k); allSeenKeys.delete(k); }
        log('Human granted one more round on the stuck finding.');
      }

      keysNow.forEach((k) => allSeenKeys.add(k));
      priorKeys = new Set(keysNow);
      priorFindings.push(...lastReview.blocking.map((f) => ({ severity: f.severity, title: f.title })));

      if (round === ROUND_CAP) {
        const choice = await waitForAnswer({
          kind: 'stuck',
          text: `Round cap (${ROUND_CAP}) reached with ${lastReview.blocking.length} open finding(s). Accept with findings on record, or stop?`,
          options: ['Accept and ship (with findings on record)', 'Stop the run'],
        });
        if (!choice.startsWith('Accept')) throw new Error('stopped_by_human');
        doneWithFindings = true;
        break;
      }

      stage('fix', 'active', { round });
      const fixRes = await withRetries('fix', () =>
        adapters.claude({
          stage: 'fix',
          prompt: fixPrompt({ goal: run.goal, lane: run.lane, draft, findings: lastReview.blocking, answers }),
          cwd: ctx.scratchDir,
          signal,
          onTick: log,
        }),
      );
      costUsd += fixRes.costUsd || 0;
      draft = fixRes.text;
      rev += 1;
      emit('revision', { rev, markdown: draft });
      emit('cost', { costUsd });
      stage('fix', 'done', { round });
    }

    // ---- Deterministic verify ----------------------------------------------
    let verifyFixBudget = 1;
    for (;;) {
      stage('verify', 'active');
      const result = await runVerify(draft, run.lane, {
        onCheck: (c) => emit('verify_check', c),
        skipNetwork: process.env.MOCK_OFFLINE === '1',
      });
      emit('verify_result', { pass: result.pass, checks: result.checks });
      stage('verify', 'done', { pass: result.pass });

      if (result.pass) break;

      const failures = result.checks.filter((c) => c.status === 'fail');
      log(`Verify failed: ${failures.map((f) => f.label).join('; ')}`);
      if (verifyFixBudget > 0) {
        verifyFixBudget -= 1;
        stage('fix', 'active', { verify: true });
        const fixRes = await withRetries('verify-fix', () =>
          adapters.claude({
            stage: 'fix',
            prompt: fixPrompt({ goal: run.goal, lane: run.lane, draft, findings: [], verifyFailures: failures, answers }),
            cwd: ctx.scratchDir,
            signal,
            onTick: log,
          }),
        );
        costUsd += fixRes.costUsd || 0;
        draft = fixRes.text;
        rev += 1;
        emit('revision', { rev, markdown: draft });
        emit('cost', { costUsd });
        stage('fix', 'done', { verify: true });
        continue;
      }

      const choice = await waitForAnswer({
        kind: 'verify',
        text: `The deterministic gate still fails after a fix pass (${failures.map((f) => f.label).join('; ')}). This gate cannot be argued with — grant one more fix pass, ship anyway recorded as FAILED, or stop?`,
        options: ['One more fix pass', 'Ship anyway (recorded as verify_failed)', 'Stop the run'],
      });
      if (choice.startsWith('One more')) { verifyFixBudget = 1; continue; }
      if (choice.startsWith('Ship anyway')) {
        emit('status', { status: 'verify_failed', rev, costUsd });
        return { status: 'verify_failed', draft, rev, costUsd, answers };
      }
      throw new Error('stopped_by_human');
    }

    // ---- Publish -----------------------------------------------------------
    const artifact = await hivemind.publishArtifact(
      { title: run.goal.slice(0, 80), markdown: draft, runId: run.id },
      log,
    );

    const status = doneWithFindings ? 'done_with_findings' : 'done';
    emit('status', { status, rev, costUsd, artifactUrl: artifact?.url ?? null });
    return { status, draft, rev, costUsd, answers };
  } catch (err) {
    if (err.message === 'aborted' || err.message === 'stopped_by_human' || signal.aborted) {
      emit('status', { status: 'stopped', costUsd });
      return { status: 'stopped', costUsd, answers };
    }
    emit('error', { message: String(err.stack || err) });
    emit('status', { status: 'failed', costUsd });
    return { status: 'failed', error: String(err), costUsd, answers };
  }
}
