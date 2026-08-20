// The loop, ported from camus v2-lite and pointed at deliverables instead of
// patches: plan → draft → (adversarial review ↔ fix)* → deterministic verify →
// done | needs_human. Stop rules are camus's: bounded rounds, repeat findings
// halt instead of re-litigating, oscillating findings halt, infra failures are
// never a pass, and every pause routes a plain-English question to the human.

import { planPrompt, groundingPrompt, groundingRetryPrompt, makePrompt, reviewPrompt, fixPrompt } from './prompts.mjs';
import { runVerify, extractThresholdLines, bindThresholdAssessments } from './verify.mjs';
import { getModels } from './models.mjs';
import { deriveIndependence, qualificationForSeat, resolveSeatIdentityFacts } from './identity.mjs';
import { extractClaimCandidates } from './claims.mjs';
import { extractContractCriteria } from './contract.mjs';
import { knowledgeSnapshotMatches, sealKnowledgeSnapshot } from './comparison.mjs';

// Run decisions (models, effort, round cap) resolve per run via getModels().

// Finding identity for repeat detection (camus findingKey, minus file paths —
// content findings have stable titles instead of code locations).
function findingKey(f) {
  const t = (f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t || null;
}

export const boundedGroundingResults = (results, limit = 32) => (results ?? []).slice(-limit);

// Claude occasionally acknowledges a fix before the requested full markdown,
// separated by a horizontal rule. That acknowledgement is not the artifact.
// Strip it only when the prefix has no markdown heading and the suffix begins
// with one; legitimate frontmatter and documents that use later rules survive.
export function normalizeDeliverable(text) {
  const value = String(text ?? '').trim();
  const lines = value.split('\n');
  const rule = lines.findIndex((line) => line.trim() === '---');
  if (rule <= 0) return value;
  const before = lines.slice(0, rule).join('\n').trim();
  const after = lines.slice(rule + 1).join('\n').trim();
  if (!/^#{1,6}\s/m.test(before) && /^#{1,6}\s/.test(after)) return after;
  return value;
}

export async function runLoop(run, ctx) {
  const { emit, waitForAnswer, adapters, hivemind, signal } = ctx;
  // The run's model decisions are the SNAPSHOT taken at creation — resolve
  // everything from it, never a live getModels(), so a settings edit mid-run
  // cannot make the actual maker/reviewer/effort/roundCap disagree with the
  // sealed receipt. model/effort are passed explicitly into each adapter below.
  const snapshot = run.models ?? getModels();
  const ROUND_CAP = snapshot.loop.roundCap;
  // Acceptance coverage must be comparable across rounds and future arms.
  // Extract once from the immutable run-start contract; the auditor judges
  // these criteria but never gets to rewrite their boundaries.
  const criteria = extractContractCriteria(run.acceptanceContract);
  const makerModel = snapshot.maker?.model;
  const reviewerModel = snapshot.reviewer?.model;
  const reviewerEffort = snapshot.reviewer?.effort;
  // A snapshot without providers is a legacy pairing — claude wrote, codex
  // reviewed — so those defaults ARE what the snapshot meant, not a guess.
  const makerProvider = snapshot.maker?.provider || 'anthropic';
  const reviewerProvider = snapshot.reviewer?.provider || 'openai';
  const answers = [];
  let costUsd = 0;
  let doneWithFindings = false;
  const makerUsage = [];
  const makerActualModels = [];
  let makerActualEvidence = null;
  let makerReportedModel = null;

  const stage = (name, status, extra = {}) => emit('stage', { name, status, ...extra });
  const log = (line) => emit('log', { line });
  const sess = (actor) => (line) => emit('session', { actor, line });
  const recordMakerCall = (stageName, result, { executor = true } = {}) => {
    if (!result || result.ok === false) return;
    const actual = result.modelActual ?? (makerModel ? `${makerProvider}:${makerModel}` : null);
    // Retrieval can legitimately use provider helpers (for example ToolSearch
    // on Haiku before Sonnet). Keep that observed identity in stage usage and
    // the knowledge snapshot, but never promote it into the artifact executor.
    if (executor && actual && !makerActualModels.includes(actual)) makerActualModels.push(actual);
    if (executor) {
      makerActualEvidence = result.modelActualEvidence ?? null;
      makerReportedModel = result.modelReported ?? null;
    }
    makerUsage.push({
      stage: stageName,
      usage: result.usage ?? { input_tokens: null, cached_input_tokens: null, output_tokens: null },
      duration_ms: Number.isInteger(result.durationMs) ? result.durationMs : null,
      model_actual: actual,
      actual_evidence: result.modelActualEvidence ?? null,
    });
    emit('maker_observation', makerUsage.at(-1));
  };

  // The pairing facts each review round records. Independence is derived from
  // the two seats' TRAINING LINEAGE — (trainingOrg, modelFamily, lineage,
  // origin_confidence) via identity.deriveIndependence — never from the provider
  // prefix of an observed identity string: two models can share a training org
  // while wearing different provider labels (§10 rules 1-4/7). The same
  // fail-toward-lower rule holds — any unknown org/family/lineage on either side
  // seals same_vendor, which derives advisory, never up to independent. The round
  // ALSO records the accepted qualification the reviewer seat ran under and the
  // scope it ran at (words-lane audits have no gate binding, so review_scope is
  // null and the built-in reviewer's gate_scope is null too — the §10.8.4
  // cross-check then compares two null channels, never a forged full-scope claim).
  const makerFacts = resolveSeatIdentityFacts(snapshot.maker, { backend: 'claude', provider: makerProvider });
  const reviewerFacts = resolveSeatIdentityFacts(snapshot.reviewer, { backend: 'codex', provider: reviewerProvider });
  const makerQualification = qualificationForSeat({
    backend: makerFacts.backend,
    transport: makerFacts.transport,
    accepted: snapshot.maker?.qualification ?? null,
  });
  const reviewerQualification = qualificationForSeat({
    backend: reviewerFacts.backend,
    transport: reviewerFacts.transport,
    accepted: snapshot.reviewer?.qualification ?? null,
  });
  const pairingQualified = makerQualification !== null && reviewerQualification !== null;
  const actualEvidenceClasses = new Set(['observed_api_response', 'observed_cli_event', 'asserted_pin', 'mapped_by_operator_docs']);
  const observationReady = (facts, evidenceClass) => (
    ((facts.backend === 'claude' || facts.backend === 'codex') && facts.transport === 'vendor_managed')
    || actualEvidenceClasses.has(evidenceClass)
  );
  const reviewPairingFacts = (review) => {
    const reviewerIdentity = review.reviewerIdentity ?? (reviewerModel ? `${reviewerProvider}:${reviewerModel}` : null);
    const pairingEvidenceReady = observationReady(makerFacts, makerActualEvidence)
      && observationReady(reviewerFacts, review.reviewerActualEvidence ?? null);
    return {
      reviewerBackend: snapshot.reviewer?.backend ?? null,
      reviewerIdentity,
      reviewerActualEvidence: review.reviewerActualEvidence ?? null,
      reviewerReportedModel: review.reviewerReportedModel ?? null,
      // A pair whose admission evidence is not yet available cannot earn the
      // new v3 standing. Keep existing configurable seats runnable, but fail
      // their review standing down to advisory until slice C supplies qual1.
      independence: pairingQualified && pairingEvidenceReady
        ? deriveIndependence({ maker: makerFacts, reviewer: reviewerFacts })
        : 'same_vendor',
      review_scope: null,
      qualification: reviewerQualification,
    };
  };

  // Every human interaction goes through here so it lands in the receipts and
  // the report — content decisions and process overrides alike. Stop pressed
  // while a question is pending resolves it, but an aborted run records no
  // answer: a fabricated "decision" in the receipts is worse than none.
  async function ask(question) {
    const reply = await waitForAnswer(question);
    if (signal.aborted) throw new Error('stopped_by_human');
    answers.push({ kind: question.kind, question: question.text, answer: reply });
    emit('answer', { kind: question.kind, question: question.text, answer: reply });
    return reply;
  }
  // Only content decisions are binding context for the maker; process choices
  // (retry/accept/override) must not leak into prompts as if they were briefs.
  const contentAnswers = () => answers.filter((a) => a.kind === 'decision');

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
      const choice = await ask({
        kind: 'infra',
        text: `The ${label} step failed twice at the infrastructure level. The loop never treats a broken step as a pass. Retry it, or stop the run?`,
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
      adapters.maker({ model: makerModel, stage: 'plan', prompt: planPrompt(run), cwd: ctx.scratchDir, signal, onTick: log, onSession: sess('maker'), toolPolicy: run.toolPolicy ?? 'research' }),
    );
    recordMakerCall('plan', plan);
    costUsd += plan.costUsd || 0;
    emit('plan', { text: plan.text });
    stage('plan', 'done');

    // ---- Grounding (Hivemind) ---------------------------------------------
    let grounding = null;
    let hmMode = null;
    let hivemindQueries = 0;
    const hivemindQueryTexts = [];
    const hivemindResults = [];
    const useFrozenKnowledge = (snapshot, { activate = true } = {}) => {
      if (!knowledgeSnapshotMatches(snapshot)) throw new Error('frozen knowledge no longer matches its snapshot identity');
      run.frozenKnowledge = snapshot;
      if (activate) stage('ground', 'active', { frozen: true });
      hmMode = snapshot.mode;
      grounding = (snapshot.items ?? []).map((item) => ({
        title: [item.title, item.author].filter(Boolean).join(' — ') || item.title,
        text: item.excerpt,
        ref: item.ref ?? null,
        score: item.score ?? null,
      }));
      for (const item of snapshot.items ?? []) hivemindResults.push({ ...item, retrievedAt: snapshot.captured_at });
      for (const query of hivemindResults.map((item) => item.query).filter(Boolean)) {
        if (!hivemindQueryTexts.includes(query)) hivemindQueryTexts.push(query);
      }
      if (hivemindQueries === 0) hivemindQueries = hivemindQueryTexts.length;
      if (hivemindResults.length) emit('grounding_evidence', { source: 'frozen_snapshot', snapshotId: snapshot.snapshot_id, results: hivemindResults });
      stage('ground', 'done', {
        connected: hivemindResults.length > 0,
        queried: hivemindQueries > 0,
        queries: hivemindQueries,
        itemCount: hivemindResults.length,
        frozen: true,
        snapshotId: snapshot.snapshot_id,
        mode: hmMode,
      });
      log(`Knowledge frozen before drafting: ${snapshot.snapshot_id.slice(0, 19)}… (${hivemindResults.length} item${hivemindResults.length === 1 ? '' : 's'}). Live retrieval is disabled for the rest of this run.`);
    };

    if (run.frozenKnowledge) {
      useFrozenKnowledge(run.frozenKnowledge);
    } else if (run.ground && hivemind.hivemindStatus().mode === 'claude') {
      // Managed-connector retrieval runs INSIDE the maker adapter with
      // Claude-connector auth, so this path exists only for a claude-backend
      // maker. The server refuses such runs at POST; this is the fail-closed
      // backstop for anything that reaches the engine another way.
      if ((snapshot.maker?.backend ?? 'claude') !== 'claude') {
        throw new Error('grounded managed-connector runs need the claude backend in the maker seat; run ungrounded or change the pairing');
      }
      stage('ground', 'active');
      const retrieve = (prompt) => withRetries('grounding', () =>
        adapters.maker({
          model: makerModel,
          stage: 'ground',
          prompt,
          cwd: ctx.scratchDir,
          signal,
          onTick: log,
          onSession: sess('retriever'),
          toolPolicy: 'hivemind_only',
        }),
      );
      let retrieval = await retrieve(groundingPrompt(run));
      recordMakerCall('ground', retrieval, { executor: false });
      costUsd += retrieval.costUsd || 0;
      if (!(retrieval.hivemindResults ?? []).length && !(retrieval.hivemindQueries > 0)) {
        log('The retriever returned without calling knowledge_search. Retrying the required tool call once before asking you.');
        retrieval = await retrieve(groundingRetryPrompt(run));
        recordMakerCall('ground_retry', retrieval, { executor: false });
        costUsd += retrieval.costUsd || 0;
      }
      emit('cost', { costUsd });
      hivemindQueries = retrieval.hivemindQueries || 0;
      for (const query of retrieval.hivemindQueryTexts ?? []) if (!hivemindQueryTexts.includes(query)) hivemindQueryTexts.push(query);
      if (!(retrieval.hivemindResults ?? []).length) {
        const choice = await ask({
          kind: 'grounding',
          text: retrieval.hivemindQueries > 0
            ? `Hivemind was queried, but no usable source excerpts were captured. Continuing would make this an ungrounded run. Continue without Hivemind, or stop?`
            : `The Hivemind retriever returned without calling knowledge_search, so no source excerpts were captured. Continuing would make this an ungrounded run. Continue without Hivemind, or stop?`,
          options: ['Continue ungrounded', 'Stop the run'],
        });
        if (choice !== 'Continue ungrounded') throw new Error('stopped_by_human');
        log('The human chose to continue without Hivemind evidence; the empty frozen snapshot keeps that downgrade visible and prevents a later silent re-query.');
      }
      const frozen = sealKnowledgeSnapshot({
        query: run.goal,
        mode: 'hivemind_claude',
        items: retrieval.hivemindResults ?? [],
        retriever: {
          requested: makerModel ? `anthropic:${makerModel}` : null,
          resolved: makerModel ? `anthropic:${makerModel}` : null,
          actual: retrieval.modelActual ?? (makerModel ? `anthropic:${makerModel}` : null),
        },
      });
      await ctx.persistKnowledgeSnapshot?.(frozen);
      useFrozenKnowledge(frozen, { activate: false });
    } else if (run.ground) {
      stage('ground', 'active');
      grounding = await hivemind.searchKnowledge(run.goal, 4, log);
      // Record the configured mode too: a degraded mcp/rest grounding is not
      // the same receipt as "nothing was configured".
      hmMode = hivemind.hivemindStatus().mode;
      if (grounding !== 'claude') stage('ground', 'done', { connected: !!grounding, mode: hmMode });
    }
    const absorbHivemindEvidence = (result, { emitStage = true } = {}) => {
      if (grounding !== 'claude') return;
      hivemindQueries += result.hivemindQueries || 0;
      for (const query of result.hivemindQueryTexts ?? []) {
        if (!hivemindQueryTexts.includes(query)) hivemindQueryTexts.push(query);
      }
      const added = [];
      for (const item of result.hivemindResults ?? []) {
        const key = `${item.ref ?? ''}|${item.title}|${item.excerpt}`;
        if (hivemindResults.some((prior) => `${prior.ref ?? ''}|${prior.title}|${prior.excerpt}` === key)) continue;
        hivemindResults.push(item);
        added.push(item);
      }
      if (added.length) emit('grounding_evidence', { source: 'adapter_tool_result', results: added });
      if (emitStage && result.hivemindQueries) {
        stage('ground', 'done', { connected: true, queried: true, queries: hivemindQueries, via: 'claude', mode: hmMode });
      }
    };
    const groundingEvidence = () => run.frozenKnowledge ? {
      mode: hmMode,
      queried: hivemindQueries > 0,
      queryCount: hivemindQueries,
      queries: [...hivemindQueryTexts],
      results: boundedGroundingResults(hivemindResults),
      snapshotId: run.frozenKnowledge.snapshot_id,
      frozen: true,
    } : !run.ground ? null : {
      mode: hmMode,
      queried: grounding === 'claude' ? hivemindQueries > 0 : !!grounding,
      queryCount: grounding === 'claude' ? hivemindQueries : (grounding ? 1 : 0),
      queries: grounding === 'claude' ? [...hivemindQueryTexts] : (grounding ? [run.goal] : []),
      // Keep the newest evidence so replacement sources fetched during a fix
      // are visible to the next auditor. Keeping the first N made every fix-
      // round citation look invented once the initial window filled.
      results: grounding === 'claude'
        ? boundedGroundingResults(hivemindResults)
        : Array.isArray(grounding)
          ? grounding.map((item) => ({
              query: run.goal,
              title: item.title,
              author: null,
              ref: item.ref ?? null,
              score: item.score ?? null,
              excerpt: item.text,
            }))
          : [],
    };

    // ---- Draft -------------------------------------------------------------
    stage('make', 'active');
    let draft = null;
    let rev = 0;
    const makeRes = await withRetries('draft', () =>
      adapters.maker({
        model: makerModel,
        stage: 'make',
        prompt: makePrompt({ ...run, grounding, answers: contentAnswers() }),
        cwd: ctx.scratchDir,
        signal,
        onTick: log,
        onSession: sess('maker'),
        toolPolicy: run.toolPolicy ?? (run.frozenKnowledge ? 'web_only' : 'research'),
      }),
    );
    recordMakerCall('make', makeRes);
    if (grounding === 'claude') {
      absorbHivemindEvidence(makeRes, { emitStage: false });
      stage('ground', 'done', {
        connected: makeRes.hivemindQueried === true,
        queried: makeRes.hivemindQueried === true,
        queries: hivemindQueries,
        via: 'claude',
        mode: hmMode,
      });
      log(makeRes.hivemindQueried
        ? `Hivemind queried by the maker (${hivemindQueries} tool call${hivemindQueries === 1 ? '' : 's'}).`
        : 'Hivemind was configured but the maker made no connector query, so this draft is not Hivemind-grounded.');
    }
    costUsd += makeRes.costUsd || 0;
    draft = normalizeDeliverable(makeRes.text);
    rev = 1;
    emit('revision', { rev, markdown: draft });
    emit('cost', { costUsd });
    stage('make', 'done');

    // ---- Review ↔ fix ------------------------------------------------------
    const allSeenKeys = new Set();
    let priorKeys = new Set();
    const priorFindings = [];
    let lastReview = null;
    // The audit binds to a concrete deliverable revision. A deterministic
    // verify-fix may change the artifact AFTER the ordinary review loop; that
    // newer revision must earn a fresh closure audit before it can inherit
    // independent standing.
    let auditedRev = null;

    for (let round = 1; round <= ROUND_CAP; round++) {
      stage('review', 'active', { round });
      emit('round', { round, cap: ROUND_CAP });
      const claims = extractClaimCandidates(draft, { groundingResults: groundingEvidence()?.results ?? [] });
      const thresholds = extractThresholdLines(draft);
      lastReview = await withRetries(`review round ${round}`, () =>
        adapters.reviewer({
          model: reviewerModel,
          prompt: reviewPrompt({ goal: run.goal, acceptanceContract: run.acceptanceContract, lane: run.lane, draft, round, priorFindings, answers: contentAnswers(), groundingEvidence: groundingEvidence(), claims, criteria, thresholds }),
          claims,
          criteria,
          thresholds,
          cwd: ctx.scratchDir,
          effort: reviewerEffort,
          signal,
          onTick: log,
          onSession: sess('reviewer'),
          receiptDir: `${ctx.receiptsDir}/review-r${round}`,
        }),
      );
      emit('review', {
        round,
        scope: 'round',
        rev,
        verdict: lastReview.verdict,
        findings: lastReview.findings,
        questions: lastReview.questions,
        reviewerModel: lastReview.reviewerModel ?? reviewerModel ?? null,
        reviewerEffort: lastReview.reviewerEffort ?? reviewerEffort ?? null,
        ...reviewPairingFacts(lastReview),
        claimAssessments: lastReview.claimAssessments ?? [],
        coverageAssessments: lastReview.coverageAssessments ?? [],
        thresholdAssessments: bindThresholdAssessments(thresholds, lastReview.thresholdAssessments),
      });
      auditedRev = rev;
      for (const f of lastReview.findings) emit('finding', { round, ...f });
      stage('review', 'done', { round, verdict: lastReview.verdict });

      // Reviewer routed a decision to the human: pause before touching the draft.
      for (const q of lastReview.questions) {
        await ask({ kind: 'decision', text: q });
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
      const lastRound = round === ROUND_CAP;
      if (stuck) {
        const stuckTitles = lastReview.blocking.filter((f) => stuck.includes(findingKey(f))).map((f) => f.title);
        // On the final round there is no more round to grant — offering one
        // and then overruling it in a second prompt would discard the choice.
        const choice = await ask({
          kind: 'stuck',
          text: `The reviewer keeps raising the same finding${stuckTitles.length > 1 ? 's' : ''}: “${stuckTitles.join('”, “')}”. Camus's rule: never re-litigate. ${lastRound ? `This is the final round (${ROUND_CAP}). Accept` : 'Accept'} the deliverable with this finding on the record${lastRound ? '' : ', push one more round,'} or stop?`,
          options: lastRound
            ? ['Accept result (with findings on record)', 'Stop the run']
            : ['Accept result (with findings on record)', 'One more round', 'Stop the run'],
        });
        if (choice.startsWith('Accept')) {
          doneWithFindings = true;
          log('Human accepted the stuck finding; recorded, moving to verify.');
          break;
        }
        if (choice.startsWith('Stop')) throw new Error('stopped_by_human');
        log('Human granted one more round on the stuck finding.');
      }

      keysNow.forEach((k) => allSeenKeys.add(k));
      priorKeys = new Set(keysNow);
      priorFindings.push(...lastReview.blocking.map((f) => ({ severity: f.severity, title: f.title })));

      if (lastRound) {
        // Only reachable when the finding wasn't stuck (stuck's final-round
        // options both exit above) — the plain cap card.
        const choice = await ask({
          kind: 'stuck',
          text: `Round cap (${ROUND_CAP}) reached with ${lastReview.blocking.length} open finding(s). Accept with findings on record, or stop?`,
          options: ['Accept result (with findings on record)', 'Stop the run'],
        });
        if (!choice.startsWith('Accept')) throw new Error('stopped_by_human');
        doneWithFindings = true;
        break;
      }

      stage('fix', 'active', { round });
      const fixRes = await withRetries('fix', () =>
        adapters.maker({
          model: makerModel,
          stage: 'fix',
          prompt: fixPrompt({ goal: run.goal, acceptanceContract: run.acceptanceContract, lane: run.lane, draft, findings: lastReview.blocking, answers: contentAnswers(), viaClaude: grounding === 'claude' }),
          cwd: ctx.scratchDir,
          signal,
          onTick: log,
          onSession: sess('maker'),
          toolPolicy: run.toolPolicy ?? (run.frozenKnowledge ? 'web_only' : 'research'),
        }),
      );
      recordMakerCall('fix', fixRes);
      absorbHivemindEvidence(fixRes);
      costUsd += fixRes.costUsd || 0;
      draft = normalizeDeliverable(fixRes.text);
      rev += 1;
      emit('revision', { rev, markdown: draft });
      emit('cost', { costUsd });
      stage('fix', 'done', { round });
    }

    // ---- Deterministic verify ----------------------------------------------
    let verifyFixBudget = 1;
    let closureFixBudget = 1;
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      stage('verify', 'active');
      const result = await runVerify(draft, run.lane, {
        onCheck: (c) => emit('verify_check', c),
        skipNetwork: process.env.MOCK_OFFLINE === '1',
        groundingResults: groundingEvidence()?.results ?? [],
      });
      emit('verify_result', { pass: result.pass, warnings: result.warnings, skipped: result.skipped, checks: result.checks });
      stage('verify', 'done', { pass: result.pass });

      if (result.pass) {
        if (result.warnings || result.skipped) {
          doneWithFindings = true;
          log(`Verify green with caveats: ${result.warnings} warning(s), ${result.skipped} skipped check(s); recorded, not hidden.`);
        }
        // Verification may have repaired the artifact after the last audit.
        // Never let an older clean verdict travel to a newer deliverable hash.
        if (auditedRev !== rev) {
          log(`The deterministic repair changed rev ${auditedRev ?? 'unreviewed'} to rev ${rev}. Running a fresh closure audit on the exact final artifact.`);
          stage('review', 'active', { scope: 'closure', rev });
          const closureClaims = extractClaimCandidates(draft, { groundingResults: groundingEvidence()?.results ?? [] });
          const closureThresholds = extractThresholdLines(draft);
          lastReview = await withRetries('closure audit', () =>
            adapters.reviewer({
              model: reviewerModel,
              prompt: reviewPrompt({ goal: run.goal, acceptanceContract: run.acceptanceContract, lane: run.lane, draft, round: 'closure', priorFindings, answers: contentAnswers(), groundingEvidence: groundingEvidence(), claims: closureClaims, criteria, thresholds: closureThresholds, closure: true }),
              claims: closureClaims,
              criteria,
              thresholds: closureThresholds,
              cwd: ctx.scratchDir,
              effort: reviewerEffort,
              signal,
              onTick: log,
              onSession: sess('reviewer'),
              receiptDir: `${ctx.receiptsDir}/review-closure-rev-${rev}`,
            }),
          );
          emit('review', {
            round: 'closure',
            scope: 'closure',
            rev,
            verdict: lastReview.verdict,
            findings: lastReview.findings,
            questions: lastReview.questions,
            reviewerModel: lastReview.reviewerModel ?? reviewerModel ?? null,
            reviewerEffort: lastReview.reviewerEffort ?? reviewerEffort ?? null,
            ...reviewPairingFacts(lastReview),
            claimAssessments: lastReview.claimAssessments ?? [],
            coverageAssessments: lastReview.coverageAssessments ?? [],
            thresholdAssessments: bindThresholdAssessments(closureThresholds, lastReview.thresholdAssessments),
          });
          for (const f of lastReview.findings) emit('finding', { round: 'closure', scope: 'closure', rev, ...f });
          stage('review', 'done', { scope: 'closure', rev, verdict: lastReview.verdict });
          auditedRev = rev;

          for (const q of lastReview.questions) await ask({ kind: 'decision', text: q });
          if (lastReview.verdict === 'APPROVED') {
            if (lastReview.nonblocking?.length) doneWithFindings = true;
            log(`Closure audit on rev ${rev}: clean.`);
            break;
          }

          if (closureFixBudget > 0) {
            closureFixBudget -= 1;
            stage('fix', 'active', { closure: true });
            const fixRes = await withRetries('closure-fix', () =>
              adapters.maker({
                model: makerModel,
                stage: 'fix',
                prompt: fixPrompt({ goal: run.goal, acceptanceContract: run.acceptanceContract, lane: run.lane, draft, findings: lastReview.blocking, answers: contentAnswers(), viaClaude: grounding === 'claude' }),
                cwd: ctx.scratchDir,
                signal,
                onTick: log,
                onSession: sess('maker'),
                toolPolicy: run.toolPolicy ?? (run.frozenKnowledge ? 'web_only' : 'research'),
              }),
            );
            recordMakerCall('closure_fix', fixRes);
            absorbHivemindEvidence(fixRes);
            costUsd += fixRes.costUsd || 0;
            draft = normalizeDeliverable(fixRes.text);
            rev += 1;
            emit('revision', { rev, markdown: draft });
            emit('cost', { costUsd });
            stage('fix', 'done', { closure: true });
            continue; // deterministic checks and closure audit both rerun
          }

          const choice = await ask({
            kind: 'stuck',
            text: `The closure audit still finds ${lastReview.blocking.length} blocking issue(s) on the exact verified artifact. Accept it with those findings on the record, or stop?`,
            options: ['Accept result (with findings on record)', 'Stop the run'],
          });
          if (choice.startsWith('Accept')) {
            doneWithFindings = true;
            break;
          }
          throw new Error('stopped_by_human');
        }
        break;
      }

      const failures = result.checks.filter((c) => c.status === 'fail');
      log(`Verify failed: ${failures.map((f) => f.label).join('; ')}`);
      if (verifyFixBudget > 0) {
        verifyFixBudget -= 1;
        stage('fix', 'active', { verify: true });
        const fixRes = await withRetries('verify-fix', () =>
          adapters.maker({
            model: makerModel,
            stage: 'fix',
            prompt: fixPrompt({ goal: run.goal, acceptanceContract: run.acceptanceContract, lane: run.lane, draft, findings: [], verifyFailures: failures, answers: contentAnswers(), viaClaude: grounding === 'claude' }),
            cwd: ctx.scratchDir,
            signal,
            onTick: log,
            onSession: sess('maker'),
            toolPolicy: run.toolPolicy ?? (run.frozenKnowledge ? 'web_only' : 'research'),
          }),
        );
        recordMakerCall('verify_fix', fixRes);
        absorbHivemindEvidence(fixRes);
        costUsd += fixRes.costUsd || 0;
        draft = normalizeDeliverable(fixRes.text);
        rev += 1;
        emit('revision', { rev, markdown: draft });
        emit('cost', { costUsd });
        stage('fix', 'done', { verify: true });
        continue;
      }

      const choice = await ask({
        kind: 'verify',
        text: `The deterministic gate still fails after a fix pass (${failures.map((f) => f.label).join('; ')}). This gate cannot be argued with. Grant one more fix pass, ship anyway recorded as FAILED, or stop?`,
        options: ['One more fix pass', 'Ship anyway (recorded as verify_failed)', 'Stop the run'],
      });
      if (choice.startsWith('One more')) { verifyFixBudget = 1; continue; }
      if (choice.startsWith('Ship anyway')) {
        emit('status', { status: 'verify_failed', rev, costUsd });
        return { status: 'verify_failed', draft, rev, costUsd, answers, makerUsage, makerActualModels, makerActualEvidence, makerReportedModel };
      }
      throw new Error('stopped_by_human');
    }

    // ---- Publish -----------------------------------------------------------
    // Stop pressed during verify must never end in an external side effect.
    if (signal.aborted) throw new Error('aborted');
    const artifact = run.publish !== true
      ? (log('Publication was not explicitly enabled. The deliverable stayed local.'), null)
      : await hivemind.publishArtifact(
          { title: run.goal.slice(0, 80), markdown: draft, runId: run.id },
          log,
        );

    const status = doneWithFindings ? 'done_with_findings' : 'done';
    emit('status', { status, rev, costUsd, artifactPublished: !!artifact, artifactUrl: artifact?.url ?? null });
    return { status, draft, rev, costUsd, answers, makerUsage, makerActualModels, makerActualEvidence, makerReportedModel };
  } catch (err) {
    if (err.message === 'aborted' || err.message === 'stopped_by_human' || signal.aborted) {
      emit('status', { status: 'stopped', costUsd });
      return { status: 'stopped', costUsd, answers, makerUsage, makerActualModels, makerActualEvidence, makerReportedModel };
    }
    emit('error', { message: String(err.stack || err) });
    emit('status', { status: 'failed', costUsd });
    return { status: 'failed', error: String(err), costUsd, answers, makerUsage, makerActualModels, makerActualEvidence, makerReportedModel };
  }
}
