// Deterministic-verifier self-test: seeds a document with one of every sin and
// asserts each check catches it, then asserts a clean document passes.
// Network-free (skipNetwork) so it runs anywhere, fast.

// DETERMINISM: this suite asserts loop behaviour at a KNOWN round cap, but
// the active model decision is mutable — Studio's settings endpoint writes local
// operator state, so changing the cap mid-session once silently broke the suite
// (a real WP8 run set roundCap 3 → 2 and "review ran exactly ROUND_CAP times" failed
// with nothing wrong in the code). Seed a throwaway record from the committed shape,
// then pin the cap this scenario exercises instead of inheriting a product choice.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync as _rfs, rmSync as _rmfs, writeFileSync as _wfs } from 'node:fs';
import { tmpdir as _tmpdir } from 'node:os';
import { join as _join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _fup } from 'node:url';
if (!process.env.STUDIO_MODELS_FILE) {
  const _here = _dirname(_fup(import.meta.url));
  let _source;
  try {
    _source = execFileSync('git', ['show', 'HEAD:apps/loop-studio/checks/models.json'], { cwd: _join(_here, '..', '..'), encoding: 'utf8' });
  } catch {
    _source = _rfs(_join(_here, 'checks', 'models.json'), 'utf8');
  }
  const _fixture = JSON.parse(_source);
  _fixture.loop = { roundCap: 3, why: 'fixed verify.test.mjs fixture' };
  const _pin = _join(mkdtempSync(_join(_tmpdir(), 'cls-models-')), 'models.json');
  _wfs(_pin, JSON.stringify(_fixture, null, 2) + '\n');
  process.env.STUDIO_MODELS_FILE = _pin;
}

import assert from 'node:assert/strict';
import { runVerify, findUnsourcedStats, findComplianceHits, extractUrls, extractThresholdLines } from './lib/verify.mjs';
import { buildGateTerminalStage, documentActionsForLane, enginePillText, gateReportJson, replayRecoveryKind, terminalFailureBanner, independentBuildBanner, independentBuildPill, downloadableReceipt } from './public/run-ui-policy.mjs';

// The internal routing campaign is executable configuration, not an informal
// checklist. Its validator pins the cost/safety controls and refuses a smoke
// arm assigned to a reviewer screen from the maker's own provider.
{
  const { loadModelEvalCampaign, validateModelEvalCampaign } = await import('./lib/model-eval-campaign.mjs');
  const campaign = loadModelEvalCampaign();
  assert.equal(campaign.treatmentProtocol, 'visible-deterministic-gate-v1', 'campaign identity binds the grader-visible prompt treatment');
  assert.equal(campaign.controls.iterationPolicy, 'single_pass');
  assert.equal(campaign.controls.optimizationOrder[0], 'quality_floor_pass_rate');
  assert.ok(campaign.candidates.some((candidate) => candidate.id === 'gpt-luna' && candidate.model === 'gpt-5.6-luna'), 'Luna is an explicit simple/balanced candidate');
  assert.equal(campaign.profiles.every((profile) => profile.cases.length >= 3), true, 'each tier has multiple representative cases');
  assert.equal(campaign.profiles.find((profile) => profile.id === 'simple').planPolicy, 'direct_make', 'simple evaluation avoids a separate planning purchase');
  assert.equal(campaign.profiles.filter((profile) => profile.id !== 'simple').every((profile) => profile.planPolicy === 'plan_then_make'), true, 'judgment-heavy tiers retain planning');
  assert.ok(campaign.calibration.judges.some((judge) => judge.id === 'gpt-luna'), 'Luna is retained as a cost-sensitive judge candidate');
  assert.equal(campaign.candidates.find((candidate) => candidate.id === 'qwen-27b').evidenceEligibility, 'exploratory_only', 'declared Qwen provenance cannot silently become routing evidence');
  const invalid = structuredClone(campaign);
  invalid.initialSmokeOrder[0].screen = 'sol-screen';
  assert.throws(() => validateModelEvalCampaign(invalid), /non-independent screen/, 'an OpenAI maker cannot be screened by Sol');
  const repeatedPrompt = structuredClone(campaign);
  repeatedPrompt.profiles[0].cases = repeatedPrompt.profiles[0].cases.slice(0, 2);
  assert.throws(() => validateModelEvalCampaign(repeatedPrompt), /at least 3 representative cases/, 'a tier cannot call repeated copies of one prompt a representative suite');
  const underpoweredRoute = structuredClone(campaign);
  underpoweredRoute.controls.minimumRoutingTrialsPerArm = 9;
  assert.throws(() => validateModelEvalCampaign(underpoweredRoute), /at least 10/, 'automatic routing cannot weaken the ten-trial floor');
}

// Evaluation summaries are read-only evidence views. They accept only the
// active generation and exact judge screen, and quality remains a hard gate
// before calibration, latency, or token economics can affect standing.
{
  const { loadModelEvalCampaign, modelEvalCampaignHash } = await import('./lib/model-eval-campaign.mjs');
  const { summarizeEvaluationReports } = await import('./lib/model-eval-summary.mjs');
  const campaign = loadModelEvalCampaign();
  const configHash = modelEvalCampaignHash(campaign);
  const simple = campaign.profiles.find((profile) => profile.id === 'simple');
  const luna = campaign.candidates.find((candidate) => candidate.id === 'gpt-luna');
  const opusScreen = campaign.independence.judgeScreens.find((screen) => screen.id === 'opus-screen');
  const reportFor = ({ id, candidate = luna, screen = opusScreen, caseId, answers = [], green = true, ...overrides }) => ({
    id,
    simulated: false,
    evaluationCampaignId: campaign.id,
    evaluationConfigHash: configHash,
    evaluationProfile: simple.id,
    evaluationCaseId: caseId,
    models: {
      maker: { backend: candidate.backend, model: candidate.model },
      reviewer: { ...screen.reviewer },
    },
    status: 'done',
    statuses: { audit: 'independent_clean' },
    startedAt: 100,
    endedAt: 1100,
    answers,
    makerUsage: [{ usage: { input_tokens: 10, output_tokens: 2 } }],
    makerActualModels: [`${candidate.provider}:${candidate.model}`],
    evidencePack: { green },
    evidence: {
      verify: [{ source: 'evaluation_case_precheck', pass: true }],
      rounds: [{ verdict: 'APPROVED', reviewerIdentity: 'anthropic:claude-opus-4-8', findings: [], usage: { input_tokens: 20, output_tokens: 3 }, duration_ms: 40 }],
    },
    ...overrides,
  });
  const cleanReports = simple.cases.map((evaluationCase, index) => reportFor({
    id: `clean-${index + 1}`,
    caseId: evaluationCase.id,
    startedAt: index * 1000,
    endedAt: index * 1000 + (index + 1) * 100,
  }));
  const calibrationSummary = {
    judges: campaign.calibration.judges.map((judge) => ({ id: judge.id, standing: 'uncalibrated' })),
    crossScreenRanking: 'refused_uncalibrated',
  };
  const clean = summarizeEvaluationReports(campaign, configHash, cleanReports, calibrationSummary, {
    qualityFloor: (pack) => pack?.green === true,
  });
  assert.equal(clean.groups.length, 1);
  assert.equal(clean.groups[0].trials, 3);
  assert.deepEqual(clean.groups[0].distinctCases, simple.cases.map((evaluationCase) => evaluationCase.id).sort());
  assert.equal(clean.groups[0].qualityFloorPasses, 3);
  assert.equal(clean.groups[0].approvedTrials, 3);
  assert.equal(clean.groups[0].materialFindingTrials, 0);
  assert.equal(clean.groups[0].medianWallDurationMs, 200);
  assert.equal(clean.groups[0].medianMakerDurationMs, null);
  assert.equal(clean.groups[0].medianReviewerDurationMs, 40);
  assert.equal(clean.groups[0].medianTotalObservedTokens, 35);
  assert.equal(clean.groups[0].recommendationStanding, 'uncalibrated_judge', 'a complete clean screen cannot outrun judge calibration');

  const substituted = summarizeEvaluationReports(
    campaign, configHash,
    cleanReports.map((report) => ({ ...report, makerActualModels: ['openai:substituted-model'] })),
    { judges: campaign.calibration.judges.map((judge) => ({ id: judge.id, standing: 'calibrated' })) },
    { qualityFloor: (pack) => pack?.green === true },
  );
  assert.equal(substituted.groups[0].identityStable, false);
  assert.equal(substituted.groups[0].recommendationStanding, 'identity_unstable', 'stable substitution is still an identity failure');

  const withHumanAnswer = summarizeEvaluationReports(campaign, configHash, [
    ...cleanReports,
    reportFor({ id: 'human-assisted', caseId: simple.cases[0].id, answers: [{ kind: 'decision', answer: 'accept' }] }),
  ], calibrationSummary, { qualityFloor: (pack) => pack?.green === true });
  assert.equal(withHumanAnswer.groups[0].trialsWithHumanIntervention, 1);
  assert.equal(withHumanAnswer.groups[0].recommendationStanding, 'quality_floor_not_met', 'human-assisted trials cannot clear the automated quality floor');

  const wrongEffort = reportFor({
    id: 'wrong-screen-effort',
    caseId: simple.cases[0].id,
    models: {
      maker: { backend: luna.backend, model: luna.model },
      reviewer: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
    },
  });
  const stale = reportFor({ id: 'stale', caseId: simple.cases[0].id, evaluationConfigHash: `sha256:${'0'.repeat(64)}` });
  const ignored = summarizeEvaluationReports(campaign, configHash, [...cleanReports, wrongEffort, stale, { ...cleanReports[0], id: 'rehearsal', simulated: true }], calibrationSummary, {
    qualityFloor: (pack) => pack?.green === true,
  });
  assert.equal(ignored.groups[0].trials, 3, 'stale, simulated, and mismatched-screen reports are never pooled');
  assert.equal(ignored.ignoredReports, 3);
}

// Campaign graders are intentionally small and declarative. They catch exact
// shape failures before a model judge is purchased but make no semantic claim.
{
  const { runEvaluationChecks } = await import('./lib/evaluation-graders.mjs');
  const checks = [
    { id: 'title', label: 'one title', type: 'regex_count', pattern: '^#\\s+', flags: 'm', min: 1, max: 1 },
    { id: 'sections', label: 'required sections', type: 'required_headings', headings: ['Decision', 'Evidence'] },
    { id: 'short', label: 'bounded length', type: 'word_count', max: 30 },
    { id: 'offline', label: 'no links', type: 'forbidden_phrases', phrases: ['https://'] },
  ];
  const green = runEvaluationChecks('# Title\n\n## Decision\nUse A.\n\n## Evidence\nReceipt.', checks);
  assert.equal(green.pass, true);
  const red = runEvaluationChecks('# Title\n\n## Decision\nSee https://example.com.', checks);
  assert.equal(red.pass, false);
  assert.deepEqual(red.checks.filter((check) => check.status === 'fail').map((check) => check.id), ['sections', 'offline']);

  const { loadModelEvalCampaign } = await import('./lib/model-eval-campaign.mjs');
  const campaign = loadModelEvalCampaign();
  const incident = campaign.profiles.find((profile) => profile.id === 'simple').cases
    .find((evaluationCase) => evaluationCase.id === 'simple-incident-handoff');
  const ownerWithPhase = `# Incident Handoff

| Owner | Action | Evidence | Pass condition |
|---|---|---|---|
| SRE — Detect | Check dashboard. | Dashboard. | Error confirmed. |
| Security — Contain | Disable key. | Confirmation. | Key disabled. |
| Release — Recover | Restore after threshold. | Dashboard. | Check passes. |

ESCALATE unresolved ownership or a failed recovery check to the incident commander.`;
  assert.equal(runEvaluationChecks(ownerWithPhase, incident.deterministicChecks).pass, true, 'an owner cell may retain its supplied phase without becoming a false shape failure');

  const balanced = campaign.profiles.find((profile) => profile.id === 'balanced').cases
    .find((evaluationCase) => evaluationCase.id === 'balanced-model-selection');
  const { makePrompt, planPrompt } = await import('./lib/prompts.mjs');
  const promptArgs = {
    goal: balanced.goal,
    acceptanceContract: balanced.acceptanceContract,
    lane: 'freeform',
    depth: 'quick',
    evaluationChecks: balanced.deterministicChecks,
    toolPolicy: 'none',
  };
  for (const prompt of [makePrompt(promptArgs), planPrompt(promptArgs)]) {
    assert.match(prompt, /EXACT DETERMINISTIC GATE/, 'planner and maker see the mechanical contract they are graded against');
    assert.match(prompt, /at least 250 and at most 900 words/, 'the exact word bound outranks the generic depth target');
    assert.match(prompt, /"Task Classes"/, 'required headings are visible before generation');
  }
  assert.doesNotMatch(makePrompt({ ...promptArgs, evaluationChecks: null }), /EXACT DETERMINISTIC GATE/, 'ordinary runs do not receive evaluation-only instructions');
}

// Judge standing is derived from human labels, never declared by the file.
// Active screen judges share a set; optional candidates calibrate independently.
{
  const { loadModelEvalCampaign } = await import('./lib/model-eval-campaign.mjs');
  const { summarizeJudgeCalibration } = await import('./lib/judge-calibration.mjs');
  const campaign = loadModelEvalCampaign();
  const artifacts = Array.from({ length: 12 }, (_, index) => ({
    id: `sha256:${String(index + 1).padStart(64, '0')}`,
    caseId: 'simple-publication-checklist',
    sourceRunId: `maker-run-${index + 1}`,
    humanLabel: {
      verdict: index % 2 ? 'APPROVED' : 'REVISE',
      findingPresence: index % 2 ? 'clean' : 'findings',
      labeledBy: 'human:test-fixture',
      labeledAt: '2026-08-26T12:00:00.000Z',
    },
  }));
  const screenSeats = new Set(campaign.independence.judgeScreens.map((screen) => `${screen.reviewer.backend}:${screen.reviewer.model}`));
  const judgeRuns = campaign.calibration.judges
    .filter((judge) => screenSeats.has(`${judge.backend}:${judge.model}`))
    .flatMap((judge) => artifacts.map((artifact) => ({
      artifactId: artifact.id,
      judgeId: judge.id,
      sourceRunId: `${judge.id}-${artifact.sourceRunId}`,
      actualIdentity: judge.id === 'opus-4-8'
        ? 'anthropic:multiple[claude-haiku-4-5-20251001+claude-opus-4-8]'
        : `openai:${judge.model}`,
      verdict: artifact.humanLabel.verdict,
      findingPresence: artifact.humanLabel.findingPresence,
    })));
  const summary = summarizeJudgeCalibration(campaign, {
    schemaVersion: 1,
    campaignId: campaign.id,
    standing: 'uncalibrated',
    artifacts,
    judgeRuns,
  });
  assert.equal(summary.crossScreenRanking, 'eligible');
  assert.equal(summary.judges.find((judge) => judge.id === 'gpt-luna').standing, 'uncalibrated', 'an optional judge does not force extra spend before active screens can compare');
  assert.equal(summary.judges.filter((judge) => judge.id !== 'gpt-luna').every((judge) => judge.standing === 'calibrated'), true);
  const mixedJudgeRuns = structuredClone(judgeRuns);
  mixedJudgeRuns.find((run) => run.judgeId === 'opus-4-8').actualIdentity = 'anthropic:claude-opus-4-8';
  assert.equal(summarizeJudgeCalibration(campaign, {
    schemaVersion: 1, campaignId: campaign.id, standing: 'uncalibrated', artifacts, judgeRuns: mixedJudgeRuns,
  }).crossScreenRanking, 'refused_uncalibrated', 'a route that changes its observed actual identity cannot calibrate');
  const sameActualJudgeRuns = judgeRuns.map((run) => ({ ...run, actualIdentity: 'shared:same-actual-model' }));
  assert.equal(summarizeJudgeCalibration(campaign, {
    schemaVersion: 1, campaignId: campaign.id, standing: 'uncalibrated', artifacts, judgeRuns: sameActualJudgeRuns,
  }).crossScreenRanking, 'refused_uncalibrated', 'two screen labels over the same actual model identity cannot unlock routing');
  assert.throws(() => summarizeJudgeCalibration(campaign, {
    schemaVersion: 1, campaignId: campaign.id, standing: 'calibrated', artifacts: [], judgeRuns: [],
  }), /standing is derived/, 'the file cannot award itself calibrated standing');
  const untraceable = structuredClone(artifacts);
  untraceable[0].id = 'artifact-1';
  assert.throws(() => summarizeJudgeCalibration(campaign, {
    schemaVersion: 1, campaignId: campaign.id, standing: 'uncalibrated', artifacts: untraceable, judgeRuns: [],
  }), /sha256 content id/, 'human labels must bind a content-addressed artifact');
}

// Workspace launch actions are user-facing controls too: the declared port
// must be the port the command actually binds, or the action opens the wrong
// server while claiming success on another endpoint.
{
  const here = _dirname(_fup(import.meta.url));
  const launch = JSON.parse(_rfs(_join(here, '..', '..', '.claude', 'launch.json'), 'utf8'));
  const verifyLaunch = launch.configurations.find((entry) => entry.name === 'loop-studio-verify');
  assert.ok(verifyLaunch, 'the isolated Studio verification launcher is present');
  assert.match(
    verifyLaunch.runtimeArgs.at(-1),
    new RegExp(`(?:^|\\s)PORT=${verifyLaunch.port}(?:\\s|$)`),
    'the Studio verification launcher binds the same port it advertises',
  );
  const launchHtml = _rfs(_join(here, 'public', 'index.html'), 'utf8');
  const launchJs = _rfs(_join(here, 'public', 'app.js'), 'utf8');
  assert.match(launchHtml, /id="publish-artifact"/, 'the launch form exposes external publication as a named control');
  assert.doesNotMatch(launchHtml.match(/<input[^>]+id="publish-artifact"[^>]*>/)?.[0] ?? '', /\bchecked\b/, 'publication opt-in is unchecked in the shipped UI');
  assert.match(launchJs, /publish:\s*state\.lane !== 'build' && \$\('publish-artifact'\)\.checked/, 'the UI sends exactly the explicit checkbox decision');
}

// A fresh machine reads the tracked cheap defaults, but the first Settings
// save creates operator state under ~/.camus and leaves the repository file
// untouched. Run this in a child so HOME and module state are genuinely fresh.
{
  const here = _dirname(_fup(import.meta.url));
  const modelHome = mkdtempSync(_join(_tmpdir(), 'cls-model-home-'));
  const moduleUrl = new URL('./lib/models.mjs', import.meta.url).href;
  const child = `
    import { getModels, updateModels } from ${JSON.stringify(moduleUrl)};
    const before = getModels();
    const after = updateModels({ maker: { backend: 'claude', model: 'opus' }, reviewer: { backend: 'codex', model: 'gpt-5.4', }, effort: 'high', roundCap: 3 });
    console.log(JSON.stringify({ before, after }));
  `;
  const env = { ...process.env, HOME: modelHome };
  delete env.STUDIO_MODELS_FILE;
  delete env.CLAUDE_MODEL;
  delete env.CODEX_MODEL;
  delete env.CODEX_EFFORT;
  delete env.ROUND_CAP;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { env, encoding: 'utf8' }));
    assert.equal(result.before.maker.model, 'sonnet', 'fresh Studio starts from the pragmatic tracked maker default');
    assert.equal(result.before.reviewer.model, 'gpt-5.4-mini', 'fresh Studio starts from the pragmatic tracked reviewer default');
    assert.equal(result.before.reviewer.effort, 'low', 'fresh Studio does not silently choose expensive review effort');
    assert.equal(result.before.loop.roundCap, 2, 'fresh Studio starts with the bounded two-round default');
    assert.equal(result.before.maker.source, 'checks/models.json defaults', 'the fresh decision names the tracked fallback honestly');
    assert.equal(result.after.maker.source, 'local operator state', 'a Settings save switches provenance to local operator state');
    const local = JSON.parse(_rfs(_join(modelHome, '.camus', 'studio', 'models.json'), 'utf8'));
    assert.equal(local.maker.model, 'opus', 'the operator choice was written under ~/.camus');
    const tracked = JSON.parse(_rfs(_join(here, 'checks', 'models.json'), 'utf8'));
    assert.equal(tracked.maker.model, 'sonnet', 'the Settings write did not mutate tracked defaults');
  } finally {
    _rmfs(modelHome, { recursive: true, force: true });
  }
}

const BAD = `## Summary
Community programs produce guaranteed returns for every launch. Apps with active communities retain 61% more of their monthly actives.

## Key Findings
1. Token ads are restricted on major platforms, so CAC is up 3x this cycle.

## Sources
1. Some report — https://example.com/report
`;

const GOOD = `## Summary
Community-led growth compounds where paid cannot. Retention differs by cohort origin [1].

## Key Findings
1. Platform ad policy restricts most token creative, raising acquisition costs [1].
2. Community-originated cohorts decay slower than airdrop cohorts [2].

## Sources
1. State of Crypto — https://a16zcrypto.com
2. Developer Report — https://www.developerreport.com
`;

// --- unit: Build launch/recovery UI policy ---------------------------------
{
  const models = { maker: 'opus', reviewer: 'gpt-5.6-sol', effort: 'low' };
  assert.equal(
    enginePillText({ engine: 'live', lane: 'build', models }),
    'engine: live · build gate: opus + gpt-5.6-sol (effort low · pinned every round)',
    'Build displays the saved effort it pins for every round; Studio forwards the run-start snapshot via args.reviewerEffort',
  );
  assert.equal(
    enginePillText({ engine: 'live', lane: 'freeform', models }),
    'engine: live · opus + gpt-5.6-sol (low)',
    'words lanes still display their requested reviewer effort',
  );
  assert.equal(replayRecoveryKind({ lane: 'build', empty: false }), 'resume_build', 'an interrupted Build replay offers the server-backed resume action');
  assert.equal(replayRecoveryKind({ lane: 'comparison', empty: false }), 'recover_comparison', 'comparison recovery remains available');
  assert.equal(replayRecoveryKind({ lane: 'build', empty: true }), null, 'an empty receipt cannot claim a resumable gate identity');
  assert.deepEqual(documentActionsForLane('build'), { copyMarkdown: false, downloadMarkdown: false }, 'Build hides markdown actions that have no document revision');
  assert.deepEqual(documentActionsForLane('freeform'), { copyMarkdown: true, downloadMarkdown: true }, 'words-lane document actions remain available');
  assert.equal(buildGateTerminalStage('done'), 'done', 'a successful Build closes the gate stage green');
  assert.equal(buildGateTerminalStage('failed'), 'fail', 'a failed Build closes the gate stage red');
  assert.equal(buildGateTerminalStage('stopped'), 'idle', 'a stopped Build does not leave the gate stage active or paint it failed');
  assert.equal(buildGateTerminalStage('no_changes'), 'idle', 'a proven no-op is neutral, not a failed gate');
  assert.match(terminalFailureBanner('verify_failed', 'build'), /BUILD NOT ACCEPTED/, 'a red Build run never claims a human override shipped it');
  assert.match(terminalFailureBanner('verify_failed', 'build'), /Nothing was merged, published, or released/, 'the red Build banner states the actual local-only boundary');
  assert.ok(!/shipped by human override/i.test(terminalFailureBanner('verify_failed', 'build')), 'the browser never invents an override');
  assert.match(terminalFailureBanner('verify_failed', 'research_memo'), /not published/i, 'a red words run does not claim publication');
  const budget = independentBuildBanner({ question: { kind: 'budget' } }, 'needs_decision');
  assert.match(budget, /BUDGET REACHED/); assert.doesNotMatch(budget, /verification could not|Give it a verification command/);
  assert.match(independentBuildBanner({ phase: 'complete' }, 'needs_decision'), /HUMAN ACCEPTANCE/);
  const candidatePill = independentBuildPill({ phase: 'complete', status: 'needs_decision' });
  assert.equal(candidatePill.label, 'Awaiting acceptance'); assert.equal(candidatePill.derived, false);
  assert.match(candidatePill.title, /not an admitted-gate verdict/);
  assert.equal(independentBuildPill({ status: 'running', interrupted: true }).label, 'stopped');
  assert.equal(independentBuildPill({ status: 'needs_decision', owned: true }).label, 'running');
  const advisory = { codeMode: 'independent', evidencePack: null, candidate: { fingerprint: 'fixture' } };
  assert.equal(downloadableReceipt(advisory), advisory, 'the usable advisory receipt is downloadable without inventing an admitted pack');
  const longGateReport = { note: 'x'.repeat(5000), blocking: [{ title: 'tail sentinel' }] };
  const renderedGateReport = gateReportJson(longGateReport);
  assert.ok(renderedGateReport.length > 5000, 'the run view keeps the complete gate report instead of clipping at 4,000 characters');
  assert.match(renderedGateReport, /tail sentinel/, 'the final report fields remain visible');
}

// --- static UI: Settings scope labels must not misstate Build effort --------
// Live Studio dogfood (2026-08-04): the reviewer-effort Settings label read
// "(words lanes)", implying Build ignored it — but Studio pins the run-start
// effort snapshot (args.reviewerEffort) and Build reviews at that effort EVERY
// round. A scope label that names one lane must not understate the other. This
// reads the shipped index.html so the label cannot silently drift back.
{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
  assert.ok(
    html.includes('reviewer effort (supported seats; legacy gate pins this every round)'),
    'effort applies to supported seats and remains pinned every round in the legacy gate',
  );
  assert.equal(
    html.includes('reviewer effort (words lanes)'), false,
    'the bare "(words lanes)" scope — which implied Build ignores effort — must not return',
  );
  assert.ok(
    html.includes('maker (words + Any-model Build; legacy gate uses Claude)') && html.includes('reviewer (words + Any-model Build; legacy gate uses Codex)'),
    'both roles apply to Any-model Build; only the legacy gate has fixed provider roles',
  );
  assert.ok(!html.includes('Build pins Claude') && !html.includes('Build pins Codex'), 'Build must not appear to have fixed roles across both execution modes');
}

// --- unit: Build gate phase strip (pure policy) -----------------------------
// WP6 dogfood (2026-08-05): the phase strip omitted the durably-stamped Plan
// phase, so an active "plan" fell to the unknown-phase fallback and rendered
// AFTER the last step. The strip is now a pure, single-source policy audited
// against the workflow's status stamps; this test pins the ORDER, the
// active-in-position marking, and the unknown-phase fallback so it cannot drift.
{
  const { GATE_PHASES, gatePhaseStrip } = await import('./public/gate-phase-policy.mjs');
  const SEP = '  ·  ';
  assert.deepEqual(
    GATE_PHASES.map(([, label]) => label),
    ['Igniting', 'Classify', 'Plan', 'Implement', 'Review', 'Fix', 'Verify'],
    'the strip lists exactly the phases Studio observes, in stamp order — Fix added 2026-08-06 '
    + 'after live run 20260806-164809-hiju rendered it as a raw lowercase key past Verify',
  );
  const order = GATE_PHASES.map(([key]) => key);
  assert.equal(order.indexOf('plan'), order.indexOf('classify') + 1, 'Plan sits immediately after Classify, not at the end');
  assert.ok(!order.includes('land'), 'no Land step — a Studio Build parks its candidate and never merges');
  assert.ok(!order.includes('worktree') && !order.includes('commit'), 'no Worktree/Commit steps — neither is a distinct durably-observed phase');
  assert.equal(order.indexOf('fix'), order.indexOf('review') + 1, 'Fix sits immediately after Review, where the fix agent runs');
  assert.equal(order.indexOf('verify'), order.indexOf('fix') + 1, 'and Verify still comes last');
  assert.equal(
    gatePhaseStrip('plan'),
    `Igniting${SEP}Classify${SEP}▸ Plan${SEP}Implement${SEP}Review${SEP}Fix${SEP}Verify`,
    'an active Plan is marked in its real position, not appended after the last step (the exact drift)',
  );
  assert.equal(
    gatePhaseStrip('commit'),
    `Igniting${SEP}Classify${SEP}Plan${SEP}Implement${SEP}Review${SEP}Fix${SEP}Verify${SEP}▸ Commit`,
    'a phase the gate reports that is not in the list is appended (and LABELLED), never silently dropped',
  );
  assert.equal(
    gatePhaseStrip(null),
    `Igniting${SEP}Classify${SEP}Plan${SEP}Implement${SEP}Review${SEP}Fix${SEP}Verify`,
    'no active phase renders a clean strip with no stray marker',
  );
}

// --- unit: unsourced stats -------------------------------------------------
{
  const offenders = findUnsourcedStats(BAD);
  assert.ok(offenders.some((s) => s.includes('61%')), 'catches uncited percentage');
  assert.ok(offenders.some((s) => s.includes('3x')), 'catches uncited multiple');
  assert.equal(findUnsourcedStats(GOOD).length, 0, 'cited stats pass');

  // Audit regression: a leading bare year must not exempt the stat behind it.
  assert.equal(findUnsourcedStats('In 2024, retention rose 61% across cohorts.').length, 1, 'year-first sentence still flagged');
  assert.equal(findUnsourcedStats('The program launched in 2024.').length, 0, 'bare year alone is not a claim');
  assert.equal(findUnsourcedStats('In 2024, retention rose 61% across cohorts [1].').length, 0, 'cited year-first stat passes');
}

// --- unit: proposed-threshold exemption (section AND marker, both required) --
// A proposed decision policy has no source to cite, so an acceptance contract
// that asks for a measurable decision rule can state one WITHOUT tripping the
// laundering gate — but only under two conjoined conditions, so the exemption
// never widens into "any number inside a heading is fine."
{
  const MARKER = '- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.';

  // [1] Unsourced factual statistic OUTSIDE any decision-rule section fails.
  assert.equal(
    findUnsourcedStats('## Summary\nRetention improved 61% after the change.\n').length, 1,
    'a bare statistic outside the section still fails',
  );

  // [2] Unsourced factual statistic INSIDE the section but WITHOUT the marker fails.
  const inSectionNoMarker = findUnsourcedStats('## Decision Rule\nRetention improved 61% in the pilot cohort.\n');
  assert.equal(inSectionNoMarker.length, 1, 'the section is not a blanket exemption');
  assert.ok(inSectionNoMarker[0].includes('61%'), 'the unmarked in-section stat is the offender');

  // [3] Marked threshold OUTSIDE a decision-rule section fails (marker alone is not enough).
  const markedOutside = findUnsourcedStats(`## Summary\n${MARKER}\n`);
  assert.equal(markedOutside.length, 1, 'the marker outside the section does not exempt');
  assert.ok(markedOutside[0].includes('40%'), 'the misplaced threshold is the offender');

  // [4] Marked threshold INSIDE the section passes.
  assert.equal(findUnsourcedStats(`## Decision Rule\n${MARKER}\n`).length, 0, 'section + marker exempts the threshold');
  assert.equal(findUnsourcedStats(`### Success Criteria\n${MARKER}\n`).length, 0, 'Success Criteria is an equivalent section at any heading level');

  // [4b] The block is BOUNDED, not terminal: a mid-document Decision Rule must
  // NOT exempt statistics in the sections that follow it (the reason we do not
  // copy the terminal Sources split).
  const bounded = findUnsourcedStats(
    `## Decision Rule\n${MARKER}\n\n## Implications\nRetention improved 61% in the observed cohort.\n`,
  );
  assert.equal(bounded.length, 1, 'a later section is still checked after the block closes');
  assert.ok(bounded[0].includes('61%') && !bounded[0].includes('40%'), 'the threshold is exempt, the later factual stat is not');

  // [5] Existing cited statistics and the terminal Sources behavior are unchanged.
  assert.equal(findUnsourcedStats(GOOD).length, 0, 'cited stats still pass');
  assert.equal(
    findUnsourcedStats('## Summary\nClean prose [1].\n\n## Sources\n1. A report showing 61% retention — https://example.com\n').length, 0,
    'stats inside the terminal Sources list are still not flagged',
  );

  // [6] Every stat shape (%, currency, multiplier, large number) behaves the
  // same way through the exemption: exempt when marked-in-section, flagged when not.
  const mixed = 'ship when CAC falls below $50, LTV to CAC exceeds 3x, and signups pass 10000';
  const mixedMarker = `- Proposed threshold (decision policy, not observed performance): ${mixed}.`;
  assert.equal(findUnsourcedStats(`## Success Criteria\n${mixedMarker}\n`).length, 0, 'currency, multiplier, and large-number thresholds all exempt when marked in-section');
  assert.equal(findUnsourcedStats(`## Success Criteria\nObserved ${mixed}.\n`).length, 1, 'the same shapes still fail when stated as observed facts without the marker');
  assert.equal(findUnsourcedStats(`## Notes\n${mixedMarker}\n`).length, 1, 'and still fail when marked but outside the section');
}

// --- unit: a nested qualifying sub-heading must not shrink the outer block ----
// Under `## Decision Rule` (H2), a nested `### Success Criteria` (H3) is still
// inside the H2 region, so a later H3 does NOT close the outer block. The old
// single-level tracker mis-closed here and false-flagged the second threshold.
{
  const nested = `## Decision Rule
### Success Criteria
- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.
### Rollback
- Proposed threshold (decision policy, not observed performance): revert if CAC exceeds $50.
`;
  assert.equal(findUnsourcedStats(nested).length, 0, 'both thresholds stay exempt inside the outer H2 block');
  // And the outer boundary still closes at an H2, not before it.
  const closesAtH2 = `${nested}## Implications\nObserved retention was 61%.\n`;
  const offenders = findUnsourcedStats(closesAtH2);
  assert.equal(offenders.length, 1, 'the section after the H2 boundary is checked again');
  assert.ok(offenders[0].includes('61%'), 'the later observed stat is the only offender');
}

// --- unit: the marker is EXACT — lookalikes are NOT exempt -------------------
// Each variant sits inside a real Decision Rule block, so ONLY the marker's
// exactness stops the exemption. Every one must still be flagged.
{
  const inRule = (line) => findUnsourcedStats(`## Decision Rule\n${line}\n`);
  assert.equal(inRule('- Proposed threshold (decision policy, not observed performance): retention exceeds 40%.').length, 0, 'the exact canonical marker is exempt');
  assert.equal(inRule('We note a Proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'embedded mid-line marker is not exempt');
  assert.equal(inRule('- proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'lowercase marker is not exempt');
  assert.equal(inRule('- Proposed threshold (decision policy not observed performance): retention 40%.').length, 1, 'comma-less marker is not exempt');
  assert.equal(inRule('Proposed threshold (decision policy, not observed performance): retention 40%.').length, 1, 'bullet-less marker is not exempt');

  // Markdown emphasis around the marker renders identically, so it stays exempt
  // (the live smoke's closure repair bolded it). Emphasis never relaxes the
  // exact-match discipline, and it cannot substitute for the hyphen bullet.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):** retention exceeds 40%.').length, 0, 'a fully bolded marker is exempt');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)**: retention exceeds 40%.').length, 0, 'bold closing before the colon is exempt');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance):_ retention exceeds 40%.').length, 0, 'an italicized marker is exempt');
  assert.equal(inRule('- **proposed threshold (decision policy, not observed performance):** 40%.').length, 1, 'bold does not excuse lowercase');
  assert.equal(inRule('- **Proposed threshold (decision policy not observed performance):** 40%.').length, 1, 'bold does not excuse a missing comma');
  assert.equal(inRule('**- Proposed threshold (decision policy, not observed performance):** 40%.').length, 1, 'emphasis cannot stand in for the hyphen bullet');

  // Only a BALANCED wrapper around the whole marker is emphasis. Stray * or _
  // inside the words is corruption, not formatting, and must stay red — the gate
  // reads the raw line, never a globally stripped copy.
  assert.equal(inRule('- Pro*posed threshold (decision policy, not observed performance): 40%.').length, 1, 'a stray asterisk inside the phrase is not exempt');
  assert.equal(inRule('- Pro_po_sed threshold (decision policy, not observed performance): 40%.').length, 1, 'stray underscores inside the phrase are not exempt');
  assert.equal(inRule('- **Proposed threshold** (decision policy, not observed performance): 40%.').length, 1, 'emphasis closing mid-phrase does not wrap the marker');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):* 40%.').length, 1, 'an unbalanced wrapper (** opened, * closed) is not exempt');

  // The closing delimiter must hug the marker. A space between the colon and the
  // close (`): **`) is not a valid CommonMark closing run — it renders as literal
  // asterisks, not bold — so it must stay red. Whitespace before the colon is
  // still fine (the close hugs `)`), consistent with the plain marker.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance): ** retention 40%.').length, 1, 'a space between the colon and the closing ** is not valid emphasis');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance): _ retention 40%.').length, 1, 'the same spaced-closing hole is closed for single-char emphasis too');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)** : retention 40%.').length, 0, 'but a close that hugs the phrase with space only before the colon still renders as bold');

  // The after-colon close also needs a boundary AFTER it: `:**retention` is a run
  // preceded by punctuation and followed by an alphanumeric — not right-flanking,
  // so it renders literally and must stay red. A space or line end makes it valid.
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance):**retention 40%.').length, 1, 'no gap after the colon-inside close is not valid emphasis');
  assert.equal(inRule('- _Proposed threshold (decision policy, not observed performance):_retention 40%.').length, 1, 'the no-gap hole is closed for single-char emphasis too');
  // A line with no numeric token yields no offender either way, so probe the $
  // branch through the ledger: the entry appears only if the marker matched.
  assert.equal(extractThresholdLines('## Decision Rule\n- **Proposed threshold (decision policy, not observed performance):**\n').length, 1, 'the colon-inside close is valid at end of line (enters the ledger)');
  assert.equal(inRule('- **Proposed threshold (decision policy, not observed performance)**:retention 40%.').length, 0, 'the before-colon close stays valid — a colon follows its closing run');
}

// --- unit: live-smoke reproduction — the closure repair bolded the marker -----
// Run 20260714-185050-d95g failed verify because rev5-6 wrapped the exact marker
// in bold. It renders identically, so the gate must exempt it AND the ledger must
// still bind it — to the RAW (bolded) line, matching the artifact byte-for-byte.
{
  const liveLine = '- **Proposed threshold (decision policy, not observed performance):** expand only if cost-per-qualified-opportunity (CPQO) falls at or below $1,200 and the pilot produces at least 8 qualified opportunities — both conditions must hold simultaneously.';
  const doc = `## Decision Rule\n\n${liveLine}\n\nThese are owner-approved policy constraints, not claims about the market.\n`;
  assert.equal(findUnsourcedStats(doc).length, 0, 'the bolded marker passes deterministic verification, as it did not in the live smoke');
  const [entry] = extractThresholdLines(doc);
  assert.ok(entry, 'the bolded marker still enters the threshold ledger for the auditor');
  assert.equal(entry.line, liveLine, 'the ledger binds the exact RAW line, emphasis intact');
  assert.deepEqual(entry.stats, ['$1,200'], 'the exempted threshold figure is captured through the emphasis');
}

// --- unit: the threshold ledger is exactly what the gate exempted -----------
{
  const doc = `## Summary
Observed retention was 61%.

## Decision Rule
- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.
### Rollback
- Proposed threshold (decision policy, not observed performance): revert if CAC exceeds $50 and signups fall below 10000.

## Sources
1. A report — https://example.com
`;
  const ledger = extractThresholdLines(doc);
  assert.equal(ledger.length, 2, 'one ledger entry per exempted marker line');
  assert.deepEqual(ledger.map((t) => t.id), ['T1', 'T2'], 'entries are stably numbered');
  // section names the exemption-granting block root, not a nested sub-heading:
  // both lines are exempt because they live under the same `## Decision Rule`.
  assert.equal(ledger[0].section, 'Decision Rule', 'the entry records the block that granted the exemption');
  assert.equal(ledger[1].section, 'Decision Rule', 'a nested `### Rollback` does not reassign the block root');
  assert.ok(ledger[0].stats.includes('40%'), 'the exempted numbers are handed to the auditor');
  assert.deepEqual(ledger[1].stats, ['$50', '10000'], 'currency and large-number thresholds are captured (years excluded)');
  // An observed stat outside any marker never enters the ledger — it is an offender instead.
  assert.equal(findUnsourcedStats(doc).some((s) => s.includes('61%')), true, 'the unmarked observed stat is still a gate offender, not a ledger entry');

  // The auditor must actually SEE the exempted lines it is required to judge.
  const { reviewPrompt: rp } = await import('./lib/prompts.mjs');
  const withLedger = rp({ goal: 'g', acceptanceContract: 'State thresholds honestly.', lane: 'research_memo', draft: doc, round: 1, priorFindings: [], answers: [], thresholds: ledger });
  assert.match(withLedger, /PROPOSED-THRESHOLD LEDGER TO ASSESS/, 'the reviewer is handed the threshold ledger');
  assert.match(withLedger, /T1 \[under "Decision Rule"\]/, 'each exempted line is enumerated for assessment');
  assert.match(withLedger, /"threshold_assessments"/, 'the required output shape includes threshold_assessments');
  const noLedger = rp({ goal: 'g', acceptanceContract: 'c', lane: 'research_memo', draft: 'no thresholds here', round: 1, priorFindings: [], answers: [], thresholds: [] });
  assert.match(noLedger, /PROPOSED-THRESHOLD LEDGER TO ASSESS: none\. Return an empty threshold_assessments array\./, 'an empty ledger still instructs an empty array, never silence');

  // Collision guard: two long marker lines that share a 177-char prefix AND the
  // same numeric tokens but diverge in meaning afterward must NOT hash alike. A
  // clipped preview would collapse them; the full stored line keeps them distinct.
  const { thresholdLineHash } = await import('./lib/verify.mjs');
  const shared = `- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40% after ${'x'.repeat(150)}`;
  const [entryShip] = extractThresholdLines(`## Decision Rule\n${shared} and we ship the launch.\n`);
  const [entryHalt] = extractThresholdLines(`## Decision Rule\n${shared} and we halt the launch.\n`);
  assert.ok(entryShip.line.length > 180, 'the ledger stores the full line, not a 180-char preview');
  assert.notEqual(entryShip.line, entryHalt.line, 'lines sharing a 177-char prefix are stored distinctly (opposite decisions)');
  assert.deepEqual(entryShip.stats, entryHalt.stats, 'their numeric tokens are identical — stats alone cannot disambiguate');
  assert.notEqual(thresholdLineHash(entryShip), thresholdLineHash(entryHalt), 'the binding hash distinguishes them by full text, not a shared prefix');
}

// --- integration: the marker line reaches the auditor through the whole loop --
// The P1 was a wiring gap. This drives runLoop end to end with a draft that
// carries a marker line and a codex adapter that delegates to the REAL
// normalizeReview: the engine must extract the ledger, hand it to the adapter,
// and the adapter's fail-closed coverage must be satisfied for the run to green.
{
  const { runLoop } = await import('./lib/engine.mjs');
  const { normalizeReview } = await import('./lib/adapters/codex.mjs');
  const DRAFT = '## Decision Rule\n\n- Proposed threshold (decision policy, not observed performance): proceed if retention exceeds 40%.\n';
  const previousOffline = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1';

  // A codex adapter that assesses every extracted threshold as honest policy →
  // the run greens only because extraction and coverage actually connect.
  const events = [];
  let sawThresholds = null;
  const run = {
    id: 'threshold-wire', goal: 'g', acceptanceContract: 'State any decision rule honestly.',
    lane: 'freeform', depth: 'quick', ground: false,
    models: { maker: { model: 'm' }, reviewer: { model: 'r', effort: 'low' }, loop: { roundCap: 1 } },
  };
  let claudeCall = 0;
  const result = await runLoop(run, {
    emit: (type, data) => events.push({ type, ...data }),
    waitForAnswer: async () => 'Stop the run',
    adapters: {
      maker: async () => (++claudeCall === 1 ? { ok: true, text: '- plan', costUsd: 0 } : { ok: true, text: DRAFT, costUsd: 0 }),
      reviewer: async ({ claims, criteria, thresholds }) => {
        sawThresholds = thresholds;
        return normalizeReview(JSON.stringify({
          verdict: 'clean', findings: [], questions_for_human: [],
          claim_assessments: claims.map((c) => ({ marker: c.marker, decision: 'supported', evidence: 'ok' })),
          coverage_assessments: criteria.map((c) => ({ criterion_id: c.id, decision: 'met', evidence: 'ok' })),
          threshold_assessments: thresholds.map((t) => ({ id: t.id, decision: 'policy', evidence: 'a forward-looking rule, not a measurement' })),
        }), 0, claims, criteria, thresholds);
      },
    },
    hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ connected: false, mode: 'stub' }), publishArtifact: async () => null },
    signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
  });
  assert.ok(result.status === 'done' || result.status === 'done_with_findings', 'the loop completes with the threshold assessed');
  assert.equal(sawThresholds?.length, 1, 'the engine extracted the marker line and passed it to the auditor');
  assert.equal(sawThresholds[0].id, 'T1', 'the ledger id survives the hop into the adapter');
  const review = events.find((e) => e.type === 'review');
  assert.equal(review.thresholdAssessments[0].decision, 'policy', 'the sealed review event records the threshold verdict');
  assert.equal(review.thresholdAssessments[0].id, 'T1', 'the decision is bound to the ledger id');
  assert.match(review.thresholdAssessments[0].line, /Proposed threshold/, 'the engine binds the decision to the exempted line, not just an ordinal');
  assert.deepEqual(review.thresholdAssessments[0].stats, ['40%'], 'the bound entry carries the exempted numbers');

  if (previousOffline === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = previousOffline;
}

// --- production seal path: derivation + pack must not drop threshold decisions
// The earlier receipt-parity test hand-built evidence.rounds. This drives the
// REAL deriveEvidence (event → round) and buildEvidencePack (round → receipt),
// the exact path the server runs, so a dropped mapping cannot hide behind a
// hand-assembled fixture.
{
  const { deriveEvidence } = await import('./lib/evidence.mjs');
  const { bindThresholdAssessments } = await import('./lib/verify.mjs');
  const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');

  // bindThresholdAssessments unit: the auditor's id/decision joins the ledger line.
  const ledger = [{ id: 'T1', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }];
  const bound = bindThresholdAssessments(ledger, [{ id: 'T1', decision: 'policy', evidence: 'a rule' }]);
  assert.deepEqual(bound, [{ id: 'T1', decision: 'policy', evidence: 'a rule', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }], 'a decision is bound back to the exact ledger line');
  assert.equal(bindThresholdAssessments([], [{ id: 'T9', decision: 'observed', evidence: 'x' }])[0].line, null, 'a decision with no ledger entry keeps null fields, never a fabricated line');

  const boundEvent = bindThresholdAssessments(ledger, [{ id: 'T1', decision: 'policy', evidence: 'a forward-looking rule' }]);
  const events = [
    { type: 'review', round: 1, scope: 'round', rev: 1, verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', findings: [], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The memo states its rule as explicit policy.' }], thresholdAssessments: boundEvent },
    { type: 'revision', rev: 1, markdown: '## Decision Rule\n\n- Proposed threshold (…): 40%.\n' },
    { type: 'verify_result', pass: true, checks: [{ id: 'stats', status: 'pass', detail: 'ok' }] },
  ];
  const derived = deriveEvidence(events);
  // The exact P1 regression: the derived round must carry the decision AND its binding.
  assert.equal(derived.rounds[0].thresholdAssessments.length, 1, 'deriveEvidence carries threshold assessments off the review event');
  assert.deepEqual(derived.rounds[0].thresholdAssessments[0], { id: 'T1', decision: 'policy', evidence: 'a forward-looking rule', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }, 'the full binding survives derivation');

  const pack = buildEvidencePack({
    goal: 'Choose a launch motion.',
    acceptanceContract: 'State any decision rule as explicit policy.',
    lane: 'freeform',
    deliverable: '## Decision Rule\n\n- Proposed threshold (…): 40%.\n',
    evidence: derived,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    models: { maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' } },
    simulated: false,
    createdAt: 7,
  });
  const line = pack.session_log.find((l) => l.startsWith('threshold assessment '));
  assert.ok(line, 'a real (non-simulated) run seals the threshold decision through the production path');
  assert.match(line, /threshold assessment T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}/, 'the sealed entry binds the line and the rationale');
}

// --- unit: compliance -------------------------------------------------------
{
  const hits = findComplianceHits(BAD);
  assert.ok(hits.some((h) => h.label === 'Guaranteed returns claim' && h.severity === 'fail'), 'catches guaranteed returns');
  assert.equal(findComplianceHits(GOOD).filter((h) => h.severity === 'fail').length, 0, 'clean copy passes compliance');
}

// --- unit: url extraction ----------------------------------------------------
{
  const urls = extractUrls(GOOD);
  assert.ok(urls.includes('https://a16zcrypto.com'), 'extracts bare source URLs');
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
}

// --- gate: structure + citations, network skipped ----------------------------
{
  const bad = await runVerify(BAD, 'research_memo', { skipNetwork: true });
  assert.equal(bad.pass, false, 'bad doc fails the gate');
  const byId = Object.fromEntries(bad.checks.map((c) => [c.id, c]));
  assert.equal(byId.stats.status, 'fail', 'stats check fails');
  assert.equal(byId.compliance.status, 'fail', 'compliance check fails');

  const missingSources = await runVerify(GOOD.replace(/## Sources[\s\S]*$/, ''), 'research_memo', { skipNetwork: true });
  const ms = Object.fromEntries(missingSources.checks.map((c) => [c.id, c]));
  assert.equal(ms.structure.status, 'fail', 'missing Sources section fails structure');
  assert.equal(ms.citations.status, 'fail', 'dangling [n] markers fail');

  const good = await runVerify(GOOD, 'research_memo', { skipNetwork: true });
  assert.equal(good.pass, true, `clean doc passes the gate (got: ${JSON.stringify(good.checks.filter((c) => c.status === 'fail'))})`);
}

// --- gate: [Hn] markers must map to Hivemind entries under Sources ----------
{
  const withDanglingH = GOOD.replace('slower than airdrop cohorts [2]', 'slower than airdrop cohorts [2][H1]');
  const bad = await runVerify(withDanglingH, 'research_memo', { skipNetwork: true });
  const cit = bad.checks.find((c) => c.id === 'citations');
  assert.equal(cit.status, 'fail', 'dangling [H1] fails');
  assert.ok(cit.detail.includes('[H1]'), 'dangling detail names the H marker');

  const withDefinedH = withDanglingH + '\n### Hivemind\n[H1] Community GTM playbook — Myosin network\n';
  const unbound = await runVerify(withDefinedH, 'research_memo', { skipNetwork: true });
  assert.equal(unbound.checks.find((c) => c.id === 'citations').status, 'fail', 'a prose-only [H1] is not receipt-bound evidence');
  const ok = await runVerify(withDefinedH, 'research_memo', { skipNetwork: true, groundingResults: [{ title: 'Community GTM playbook' }] });
  assert.equal(ok.checks.find((c) => c.id === 'citations').status, 'pass', 'defined [H1] resolves to the captured connector result');

  // A Sources entry must not vouch for itself: marker only in Sources, none in body.
  const srcOnly = GOOD + '\n[H2] Stray entry — nobody cites this\n';
  const cit2 = (await runVerify(srcOnly, 'research_memo', { skipNetwork: true })).checks.find((c) => c.id === 'citations');
  assert.equal(cit2.status, 'pass', 'unused Sources entries are not dangling markers');
}

// --- gate: internal evidence need not invent a public URL ------------------
{
  const internal = `## Summary
The captured playbook requires verification [H1].

## Key Findings
1. The captured playbook requires verification [H1].

## Sources
### Hivemind
[H1] Compliance playbook — Spencer Frank\n`;
  const withoutReceipt = await runVerify(internal, 'research_memo', { skipNetwork: true });
  assert.equal(withoutReceipt.checks.find((c) => c.id === 'links').status, 'fail', 'an internal-looking citation cannot self-certify');
  const withReceipt = await runVerify(internal, 'research_memo', { skipNetwork: true, groundingResults: [{ title: 'Compliance playbook', author: 'Spencer Frank', ref: null }] });
  assert.equal(withReceipt.checks.find((c) => c.id === 'links').status, 'pass', 'captured Hivemind evidence may honestly have no public URL');
  assert.match(withReceipt.checks.find((c) => c.id === 'links').detail, /captured in this receipt/, 'the green explains its evidence boundary');
  assert.equal(withReceipt.pass, true, 'receipt-bound internal evidence can pass the deterministic gate');
}

// --- audit regression: a citation must bind to a checked URL -----------------
{
  const doc = `## Summary
Retention improved 61% [1]. Unrelated reading: https://example.com

## Key Findings
1. See above [1].

## Sources
1. Internal memo, Q3 planning meeting
`;
  const res = await runVerify(doc, 'freeform', { skipNetwork: true });
  const cit = res.checks.find((c) => c.id === 'citations');
  assert.equal(cit.status, 'fail', 'a source entry without a URL fails — an unrelated link cannot vouch for [1]');
  assert.ok(cit.detail.includes('no URL'), 'the reason names the missing URL');
  assert.equal(res.pass, false, 'the gate is red');
}

// --- gate: link classification against a local HTTP fixture ------------------
// No external network: an in-process server plays the four personalities the
// checker must distinguish — healthy, bot-blocked, dead, and HEAD-hostile.
{
  const { createServer } = await import('node:http');
  const fixture = createServer((req, res) => {
    if (req.url === '/ok') return res.writeHead(200).end('fine');
    if (req.url === '/blocked') return res.writeHead(403).end('bots go away');
    if (req.url === '/dead') return res.writeHead(404).end('gone');
    if (req.url === '/head405') {
      if (req.method === 'HEAD') return res.writeHead(405).end();
      return res.writeHead(200).end('GET works');
    }
    res.writeHead(500).end();
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const doc = (paths) => `Notes.\n\n${paths.map((p) => `- ${base}${p}`).join('\n')}\n`;
  const linksCheck = async (paths) =>
    (await runVerify(doc(paths), 'freeform', {})).checks.find((c) => c.id === 'links');

  const healthy = await linksCheck(['/ok', '/head405']);
  assert.equal(healthy.status, 'pass', 'HEAD 405 falls back to GET and passes');

  const blocked = await linksCheck(['/ok', '/blocked']);
  assert.equal(blocked.status, 'warn', '403 warns instead of failing');
  assert.ok(blocked.detail.includes('403'), 'warn detail names the status');

  const dead = await linksCheck(['/ok', '/dead']);
  assert.equal(dead.status, 'fail', '404 fails the gate');
  assert.ok(dead.detail.includes('404'), 'fail detail names the status');

  const deadBeatsBlocked = await linksCheck(['/blocked', '/dead']);
  assert.equal(deadBeatsBlocked.status, 'fail', 'a dead link outranks a blocked one');

  fixture.close();
}

// --- hivemind MCP adapter against a local fixture ----------------------------
// The fixture mirrors the hive-mind /api/mcp contract: stateless streamable
// HTTP, x-api-key auth, every response SSE-framed, knowledge_search results
// JSON-stringified into content[0].text.
{
  const { createServer } = await import('node:http');
  const CHUNKS = [
    { chunk_id: 'c-1', title: 'Onchain GTM Stack', author: 'Tridog', content: 'Build community first, then raise capital.', score: 0.8, relevance: '80%' },
    { chunk_id: 'c-2', title: 'Founder-led Marketing', author: 'Greg', content: 'In crypto, narrative is market share.', score: 0.5, relevance: '50%' },
  ];
  const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
  const fixture = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/mcp') return res.writeHead(405).end();
    if (req.headers['x-api-key'] !== 'hm_k_test') return res.writeHead(401).end('{"error":"unauthorized"}');
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.method === 'notifications/initialized') return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (msg.method === 'initialize') {
      return res.end(sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'hivemind', version: '0.1.0' } } }));
    }
    if (msg.method === 'tools/call' && msg.params.name === 'knowledge_search') {
      const payload = { success: true, data: { chunks: CHUNKS, total_results: 2, query: msg.params.arguments.query } };
      return res.end(sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }));
    }
    res.end(sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fixture.address().port}`;

  process.env.HIVEMIND_MCP_URL = origin; // bare origin — adapter must append /api/mcp
  process.env.HIVEMIND_API_KEY = 'hm_k_test';
  const { searchKnowledge, hivemindStatus } = await import('./lib/adapters/hivemind.mjs');

  assert.deepEqual(hivemindStatus(), { connected: true, mode: 'mcp', base: `${origin}/api/mcp` }, 'status reports mcp mode');
  const logs = [];
  const items = await searchKnowledge('community vs paid', 4, (l) => logs.push(l));
  assert.equal(items.length, 2, 'maps both chunks');
  assert.equal(items[0].title, 'Onchain GTM Stack — Tridog', 'title carries author');
  assert.equal(items[0].ref, 'c-1', 'ref is chunk_id');
  assert.equal(items[0].score, 0.8, 'score preserved');
  assert.ok(logs[0].includes('via mcp'), 'log names the transport');

  // Wrong key → adapter degrades to ungrounded, never throws into the loop.
  process.env.HIVEMIND_API_KEY = 'hm_k_wrong';
  const denied = await searchKnowledge('anything', 4, () => {});
  assert.equal(denied, null, '401 degrades to ungrounded');

  delete process.env.HIVEMIND_MCP_URL;
  delete process.env.HIVEMIND_API_KEY;
  fixture.close();
}

// --- hivemind via-claude mode: no key, grounding delegated to the maker ------
{
  process.env.HIVEMIND_VIA_CLAUDE = '1';
  const { searchKnowledge, hivemindStatus, viaClaude } = await import('./lib/adapters/hivemind.mjs');
  const { claudeToolSurface, usageFromClaudeResult } = await import('./lib/adapters/claude.mjs');
  const { makePrompt, fixPrompt, planPrompt, reviewPrompt } = await import('./lib/prompts.mjs');

  const st = hivemindStatus();
  assert.equal(st.mode, 'claude', 'mode is claude');
  assert.ok(st.base.endsWith('/api/mcp'), 'base points at an /api/mcp endpoint');
  assert.deepEqual(viaClaude(), {
    enabled: true,
    url: st.base,
    serverName: 'claude_ai_Hivemind_Staging',
    toolName: 'mcp__claude_ai_Hivemind_Staging__knowledge_search',
  }, 'viaClaude exposes the managed connector wiring');
  const surface = claudeToolSurface({ stage: 'make', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging' });
  assert.match(surface.tools, /ToolSearch/, 'managed deferred tools can be loaded');
  assert.match(surface.tools, /mcp__claude_ai_Hivemind_Staging__knowledge_search/, 'only the selected managed Hivemind tool EXISTS in the restrictive surface');
  assert.equal(surface.allowed, surface.tools, 'every available maker tool is pre-approved for headless use');
  assert.deepEqual(claudeToolSurface({ stage: 'plan', hivemindEnabled: false }), { tools: '', allowed: '' }, 'planning remains tool-free');
  assert.deepEqual(claudeToolSurface({ stage: 'make', hivemindEnabled: false, toolPolicy: 'none' }), { tools: '', allowed: '' }, 'a frozen comparison arm has no live web or MCP retrieval surface');
  const hmOnly = claudeToolSurface({ stage: 'ground', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging', toolPolicy: 'hivemind_only' });
  assert.ok(!hmOnly.tools.includes('WebSearch') && hmOnly.tools.includes('knowledge_search'), 'the snapshot retriever can see Hivemind without opening general web tools');
  const webOnly = claudeToolSurface({ stage: 'make', hivemindEnabled: true, serverName: 'claude_ai_Hivemind_Staging', toolPolicy: 'web_only' });
  assert.equal(webOnly.tools, 'WebSearch,WebFetch', 'a snapshot-bound maker keeps web research but cannot re-query Hivemind');
  assert.deepEqual(usageFromClaudeResult({ modelUsage: { 'claude-sonnet-4-6': { inputTokens: 120, cacheReadInputTokens: 40, outputTokens: 30 } } }, 'sonnet'), {
    usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 },
    modelActual: 'anthropic:claude-sonnet-4-6',
    modelActualEvidence: 'observed_cli_event',
  }, 'Claude result usage and actual model identity survive without inferring effort');
  assert.equal(usageFromClaudeResult({}, 'sonnet').modelActualEvidence, 'asserted_pin', 'a requested-model fallback is labeled as a pin, not an observed CLI identity');
  assert.equal(usageFromClaudeResult({ usage: { input_tokens: 999, output_tokens: 999 }, modelUsage: { 'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 30 } } }, 'sonnet').usage.input_tokens, 120, 'aggregate and per-model usage are not double-counted');

  const marker = await searchKnowledge('anything', 4, () => {});
  assert.equal(marker, 'claude', 'retrieval is delegated, not performed');

  const mk = makePrompt({ goal: 'g', lane: 'research_memo', depth: 'quick', grounding: 'claude', answers: [] });
  assert.ok(mk.includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'make prompt loads the exact managed MCP tool');
  assert.ok(mk.includes('never fabricate'), 'make prompt forbids fabricated [Hn]');
  assert.ok(mk.includes('contract outranks generic length, source-count, and query-count'), 'the explicit trust contract wins over generic depth defaults');
  assert.ok(mk.includes('use fewer when the acceptance contract explicitly narrows'), 'managed grounding does not override a narrow query contract');
  const fx = fixPrompt({ goal: 'g', lane: 'research_memo', draft: 'd', findings: [], answers: [], viaClaude: true });
  assert.ok(fx.includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'fix prompt can reload the managed tool');

  const toollessMake = makePrompt({ goal: 'Produce the answer now', acceptanceContract: 'A complete answer exists', lane: 'freeform', depth: 'quick', grounding: null, answers: [], toolPolicy: 'none' });
  assert.match(toollessMake, /TOOLLESS RUN/);
  assert.match(toollessMake, /Never say you will gather, research, browse, verify, or return later/);
  assert.doesNotMatch(toollessMake, /with 4–6 distinct sources/, 'a toolless quick seat is not assigned an impossible source quota');
  const toollessPlan = planPrompt({ goal: 'Produce the answer now', acceptanceContract: 'A complete answer exists', lane: 'freeform', depth: 'quick', toolPolicy: 'none' });
  assert.match(toollessPlan, /No retrieval tools are available/);
  assert.match(toollessPlan, /do not promise future research/);

  const contract = 'Every material claim must trace to a live source.';
  for (const [name, prompt] of [
    ['plan', planPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', depth: 'quick' })],
    ['make', makePrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', depth: 'quick', grounding: null, answers: [] })],
    ['review', reviewPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', draft: 'd', round: 1, priorFindings: [], answers: [] })],
    ['fix', fixPrompt({ goal: 'g', acceptanceContract: contract, lane: 'research_memo', draft: 'd', findings: [], answers: [], viaClaude: false })],
  ]) assert.ok(prompt.includes(contract), `${name} is constrained by the binding acceptance contract`);

  const { groundingPrompt, groundingRetryPrompt } = await import('./lib/prompts.mjs');
  assert.ok(groundingPrompt({ goal: 'g', acceptanceContract: contract }).includes('select:mcp__claude_ai_Hivemind_Staging__knowledge_search'), 'the frozen retriever loads the deferred managed tool before searching');
  const retryPrompt = groundingRetryPrompt({ goal: 'g', acceptanceContract: contract });
  assert.match(retryPrompt, /previous retrieval attempt returned text without calling knowledge_search/, 'the bounded retry names the observed failure');
  assert.match(retryPrompt, /A text-only answer is a failed retry/, 'the bounded retry cannot be satisfied by another acknowledgement');

  delete process.env.HIVEMIND_VIA_CLAUDE;
}

// --- via-Claude grounding freezes first; the artifact gets stable [Hn]s ----
{
  const { runLoop, boundedGroundingResults, normalizeDeliverable } = await import('./lib/engine.mjs');
  assert.deepEqual(boundedGroundingResults(Array.from({ length: 40 }, (_, id) => ({ id }))).map((r) => r.id), Array.from({ length: 32 }, (_, i) => i + 8), 'the auditor sees the newest fix-round sources when the evidence window fills');
  assert.equal(normalizeDeliverable('Fixed the citation.\n\n---\n\n## Summary\n\nClean.'), '## Summary\n\nClean.', 'change-note preambles never enter the artifact');
  assert.equal(normalizeDeliverable('## Summary\n\nKeep me.\n\n---\n\n## Sources'), '## Summary\n\nKeep me.\n\n---\n\n## Sources', 'a real document that uses a horizontal rule is preserved');
  assert.equal(normalizeDeliverable('---\ntitle: Memo\n---\n## Summary'), '---\ntitle: Memo\n---\n## Summary', 'frontmatter is preserved');
  const previousOffline = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1';
  for (const [mode, expected] of [['never', false], ['first', true], ['retry', true]]) {
    const events = [];
    const reviewerPrompts = [];
    const claudeCalls = [];
    const groundingQuestions = [];
    let persistedSnapshot = null;
    let groundAttempts = 0;
    const run = {
      id: `ground-${mode}`, goal: 'g', acceptanceContract: 'State evidence honestly.',
      lane: 'freeform', depth: 'quick', ground: true,
      models: { maker: { model: 'maker' }, reviewer: { model: 'reviewer', effort: 'low' }, loop: { roundCap: 1 } },
    };
    const result = await runLoop(run, {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async (question) => {
        groundingQuestions.push(question);
        return question.kind === 'grounding' ? 'Continue ungrounded' : 'Stop the run';
      },
      adapters: {
        maker: async ({ stage, prompt, toolPolicy }) => {
          claudeCalls.push({ stage, prompt, toolPolicy });
          if (stage === 'plan') return { ok: true, text: '- plan', costUsd: 0 };
          if (stage === 'ground') {
            groundAttempts += 1;
            const queried = mode === 'first' || (mode === 'retry' && groundAttempts === 2);
            return {
            ok: true, text: 'Snapshot ready.', costUsd: 0,
            modelActual: 'anthropic:multiple[retrieval-helper+maker]',
            hivemindQueried: queried, hivemindQueries: queried ? 2 : 0,
            hivemindQueryTexts: queried ? ['cohort evidence', 'launch gaps'] : [],
            hivemindResults: queried ? [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] : [],
            };
          }
          return { ok: true, text: '## Notes\n\nA plain note.\n', costUsd: 0, modelActual: 'anthropic:maker' };
        },
        reviewer: async ({ prompt }) => { reviewerPrompts.push(prompt); return { ran: true, verdict: 'APPROVED', findings: [], blocking: [], nonblocking: [], questions: [] }; },
      },
      hivemind: {
        searchKnowledge: async () => 'claude',
        hivemindStatus: () => ({ connected: true, mode: 'claude' }),
        publishArtifact: async () => null,
      },
      signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
      persistKnowledgeSnapshot: async (snapshot) => { persistedSnapshot = snapshot; },
    });
    const groundDone = events.findLast((event) => event.type === 'stage' && event.name === 'ground' && event.status === 'done');
    assert.ok(result.status === 'done' || result.status === 'done_with_findings', 'the grounding probe completes the full loop');
    assert.equal(groundDone?.queried, expected, `grounding records actual connector use (${mode})`);
    assert.equal(groundDone?.connected, expected, 'configured-but-unused never wears a connected/grounded badge');
    assert.equal(groundDone?.itemCount, expected ? 1 : 0, 'the frozen stage reports the captured item count used by the UI');
    assert.equal(groundingQuestions.filter((question) => question.kind === 'grounding').length, expected ? 0 : 1, 'a successful bounded retry avoids the human; two misses require an explicit downgrade');
    assert.equal(groundAttempts, mode === 'first' ? 1 : 2, 'missing required tool use gets exactly one bounded retry');
    if (!expected) assert.match(groundingQuestions.find((question) => question.kind === 'grounding')?.text ?? '', /without calling knowledge_search/, 'the checkpoint distinguishes no tool call from a queried empty result');
    if (mode === 'retry') assert.match(claudeCalls.filter((call) => call.stage === 'ground')[1]?.prompt ?? '', /A text-only answer is a failed retry/, 'the second call receives the strict tool-use retry prompt');
    assert.ok(persistedSnapshot?.snapshot_id, 'the single-run knowledge snapshot is sealed before drafting');
    assert.equal(claudeCalls.find((call) => call.stage === 'ground')?.toolPolicy, 'hivemind_only', 'retrieval can use Hivemind but not the web');
    assert.equal(claudeCalls.find((call) => call.stage === 'make')?.toolPolicy, 'web_only', 'drafting cannot re-query the frozen internal corpus');
    assert.deepEqual(result.makerActualModels, ['anthropic:maker'], 'retriever helpers stay in stage usage and never become the artifact executor actual');
    assert.ok(reviewerPrompts[0].includes(`Hivemind queried: ${expected ? 'yes' : 'no'}`), 'auditor receives adapter evidence, not maker self-attestation');
    if (expected) {
      assert.ok(claudeCalls.find((call) => call.stage === 'make')?.prompt.includes('[H1] Cohort playbook — A. Expert'), 'Camus, not the maker, assigns the stable artifact marker');
      assert.ok(reviewerPrompts[0].includes('"cohort evidence"'), 'auditor receives the observed query trail');
      assert.ok(reviewerPrompts[0].includes('Programs should sell progress, not content.'), 'auditor receives the bounded tool-result excerpt');
    }
  }
  if (previousOffline === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = previousOffline;
}

// --- normalizeReview: no path from broken reviewer output to a verdict -------
{
  const { normalizeReview, usageFromCodexEvent } = await import('./lib/adapters/codex.mjs');
  const infra = (raw, code, why) => assert.equal(normalizeReview(raw, code).ran, false, why);
  const rawReview = (overrides = {}) => JSON.stringify({
    verdict: 'clean', findings: [], questions_for_human: [], claim_assessments: [], coverage_assessments: [], threshold_assessments: [], ...overrides,
  });

  infra('', 0, 'empty output is infra');
  infra('not json', 0, 'unparseable is infra');
  infra('[]', 0, 'non-object is infra');
  infra('{"verdict":"approve","findings":[],"questions_for_human":[]}', 0, 'unknown verdict is infra');
  infra(JSON.stringify({ verdict: 'clean', findings: [{ severity: 'high', title: 'x', detail: 'd', suggestion: 's' }], questions_for_human: [] }), 0,
    'clean-with-blocking is infra, never APPROVED');
  infra(JSON.stringify({ verdict: 'revise', findings: [], questions_for_human: [] }), 0,
    'revise with nothing actionable is infra');
  infra(JSON.stringify({ verdict: 'revise', findings: [{ severity: 'critical', title: 'x', detail: 'd', suggestion: 's' }], questions_for_human: [] }), 0,
    'unknown severity is infra');
  infra(rawReview(), 1, 'nonzero exit is infra even with valid JSON');
  infra(rawReview({ questions_for_human: 'not-an-array' }), 0, 'malformed questions fail closed instead of throwing');
  assert.deepEqual(
    usageFromCodexEvent(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } })),
    { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 },
    'Codex completion usage is captured as an observation',
  );
  assert.equal(usageFromCodexEvent('{"type":"turn.started"}'), null, 'non-completion events invent no usage');

  const clean = normalizeReview(rawReview({ findings: [{ severity: 'low', title: 'nit', detail: 'd', suggestion: 's' }], questions_for_human: ['', '  ', 'real?'] }), 0);
  assert.equal(clean.ran, true);
  assert.equal(clean.verdict, 'APPROVED', 'clean + low only approves');
  assert.equal(clean.nonblocking.length, 1, 'low is nonblocking');
  assert.deepEqual(clean.questions, ['real?'], 'blank questions filtered');

  const fenced = normalizeReview('```json\n{"verdict":"revise","findings":[{"severity":"medium","title":"t","detail":"d","suggestion":"s"}],"questions_for_human":[],"claim_assessments":[],"coverage_assessments":[],"threshold_assessments":[]}\n```', 0);
  assert.equal(fenced.ran, true, 'fenced JSON still parses');
  assert.equal(fenced.blocking.length, 1);

  const claims = [{ marker: '[1]', claim: 'Retention improved.', url: 'https://example.com/report' }];
  const assessed = normalizeReview(rawReview({
    claim_assessments: [{ marker: '[1]', decision: 'supported', evidence: 'The report states retention improved.' }],
  }), 0, claims);
  assert.equal(assessed.ran, true, 'exact claim coverage is accepted');
  assert.equal(assessed.claimAssessments[0].decision, 'supported');
  assert.equal(normalizeReview(rawReview(), 0, claims).ran, false, 'missing claim assessment coverage fails closed');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[2]', decision: 'supported', evidence: 'wrong source' }] }), 0, claims).ran, false, 'extra/wrong markers fail closed');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[1]', decision: 'unsupported', evidence: 'The source says the opposite.' }] }), 0, claims).ran, false, 'unsupported claim cannot wear a clean verdict');
  assert.equal(normalizeReview(rawReview({ claim_assessments: [{ marker: '[1]', decision: 'unchecked', evidence: 'The source could not be loaded.' }] }), 0, claims).ran, false, 'unchecked claim on clean needs a visible caveat');
  const unchecked = normalizeReview(rawReview({
    findings: [{ severity: 'low', title: 'Source could not be checked', detail: 'The cited page was unavailable.', suggestion: 'Recheck before publication.' }],
    claim_assessments: [{ marker: '[1]', decision: 'unchecked', evidence: 'The source could not be loaded.' }],
  }), 0, claims);
  assert.equal(unchecked.ran, true, 'unchecked is allowed only when its caveat survives the verdict');

  const criteria = [{ id: 'C1', text: 'Every claim is supported.' }];
  const covered = normalizeReview(rawReview({
    coverage_assessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'Every claim in the deliverable has a supporting assessment.' }],
  }), 0, [], criteria);
  assert.equal(covered.ran, true, 'exact acceptance-criterion coverage is accepted');
  assert.equal(normalizeReview(rawReview(), 0, [], criteria).ran, false, 'missing criterion coverage fails closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C2', decision: 'met', evidence: 'wrong criterion' }] }), 0, [], criteria).ran, false, 'wrong criterion ids fail closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'first' }, { criterion_id: 'C1', decision: 'met', evidence: 'second' }] }), 0, [], criteria).ran, false, 'duplicate criterion assessments fail closed');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The deliverable omits the required comparison.' }] }), 0, [], criteria).ran, false, 'unmet criterion cannot wear a clean verdict');
  const unmetCoverage = normalizeReview(rawReview({
    verdict: 'revise',
    findings: [{ severity: 'medium', title: 'Contract criterion unmet', detail: 'The required comparison is absent.', suggestion: 'Add it.' }],
    coverage_assessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The deliverable omits the required comparison.' }],
  }), 0, [], criteria);
  assert.equal(unmetCoverage.ran, true, 'unmet coverage is valid only as a blocking revise verdict');
  assert.equal(normalizeReview(rawReview({ coverage_assessments: [{ criterion_id: 'C1', decision: 'unclear', evidence: 'The deliverable does not provide enough evidence.' }] }), 0, [], criteria).ran, false, 'unclear criterion on clean needs a visible caveat');
  const unclearCoverage = normalizeReview(rawReview({
    findings: [{ severity: 'low', title: 'Coverage remains unclear', detail: 'The output lacks outcome evidence.', suggestion: 'Confirm before publication.' }],
    coverage_assessments: [{ criterion_id: 'C1', decision: 'unclear', evidence: 'The deliverable does not provide enough evidence.' }],
  }), 0, [], criteria);
  assert.equal(unclearCoverage.ran, true, 'unclear criterion survives only with its caveat');

  // Proposed-threshold ledger: the auditor MUST assess every exempted line, and
  // a line assessed `observed` (a statistic wearing the marker) can never pass.
  const thresholds = [{ id: 'T1', section: 'Decision Rule', line: '- Proposed threshold (…): proceed if retention exceeds 40%.', stats: ['40%'] }];
  const policyClean = normalizeReview(rawReview({
    threshold_assessments: [{ id: 'T1', decision: 'policy', evidence: 'A forward-looking rule the owner is setting, not a measurement.' }],
  }), 0, [], [], thresholds);
  assert.equal(policyClean.ran, true, 'a genuine proposed policy passes');
  assert.equal(policyClean.thresholdAssessments[0].decision, 'policy', 'the assessment is carried through');
  assert.equal(normalizeReview(rawReview(), 0, [], [], thresholds).ran, false, 'missing threshold assessment coverage fails closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T2', decision: 'policy', evidence: 'wrong id' }] }), 0, [], [], thresholds).ran, false, 'extra/wrong threshold ids fail closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: '61% is a measured baseline, not a policy.' }] }), 0, [], [], thresholds).ran, false, 'an observed threshold cannot wear a clean verdict');
  const laundered = normalizeReview(rawReview({
    verdict: 'revise',
    findings: [{ severity: 'high', title: 'Statistic disguised as policy', detail: 'The marker line states a measured 61%, not a proposed rule.', suggestion: 'Cite it or move it to findings.' }],
    threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: 'The number is presented as achieved performance.' }],
  }), 0, [], [], thresholds);
  assert.equal(laundered.ran, true, 'an observed threshold is valid only as a blocking revise verdict');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'observed', evidence: 'measured' }, { id: 'T1', decision: 'policy', evidence: 'dup' }] }), 0, [], [], thresholds).ran, false, 'duplicate threshold assessments fail closed');
  assert.equal(normalizeReview(rawReview({ threshold_assessments: [{ id: 'T1', decision: 'maybe', evidence: 'x' }] }), 0, [], [], thresholds).ran, false, 'an unknown threshold decision fails closed');
}

// --- claim ledger: citations become sealed candidates, not automatic proof --
{
  const { extractClaimCandidates, buildClaimLedger } = await import('./lib/claims.mjs');
  const { reviewPrompt } = await import('./lib/prompts.mjs');
  const doc = `## Recommendation

Retention improved after onboarding changed [1]. The same report also records lower churn [1].
Members value practical progress over content volume [H1].

## Sources
1. Cohort report — https://example.com/cohorts
[H1] Member interviews — Research team
`;
  const groundingResults = [{ excerpt: 'Members repeatedly asked for practical milestones.', retrievedAt: 123 }];
  const candidates = extractClaimCandidates(doc, { groundingResults });
  assert.equal(candidates.length, 2, 'reused markers produce one unambiguous ledger item');
  assert.match(candidates[0].claim, /Retention improved.*lower churn/, 'all claims bound to one marker stay together');
  assert.equal(candidates[0].url, 'https://example.com/cohorts', 'the public source URL is bound to the claim');
  assert.equal(candidates[0].evidence_hash, null, 'a live URL is not silently promoted into captured support');
  assert.match(candidates[1].evidence_hash, /^sha256:[0-9a-f]{64}$/, 'captured Hivemind evidence is content-bound');
  assert.equal(candidates[1].retrieved_at, 123, 'captured evidence keeps its retrieval time');
  assert.equal(candidates.every((c) => c.decision === 'unchecked'), true, 'citation extraction never decides entailment');
  const prompt = reviewPrompt({
    goal: 'Choose a strategy.', acceptanceContract: 'Every claim is supported.', lane: 'research_memo',
    draft: doc, round: 1, priorFindings: [], answers: [],
    groundingEvidence: { queried: true, queryCount: 1, queries: ['member value'], results: groundingResults },
    claims: candidates,
  });
  assert.match(prompt, /\[H1\].*source=receipt-bound Hivemind result \[R1\]/, 'the auditor gets an explicit H-marker to captured-result mapping');

  const ledger = buildClaimLedger(doc, {
    groundingResults,
    assessments: [
      { marker: '[1]', decision: 'unsupported', evidence: 'The report discusses activation, not retention.' },
      { marker: '[H1]', decision: 'supported', evidence: 'The captured excerpt directly states the preference.' },
    ],
  });
  assert.deepEqual(ledger.map((c) => c.decision), ['unsupported', 'supported'], 'only explicit auditor assessments populate decisions');
}

// --- engine harness: stop rules, containment, and answer integrity -----------
{
  const { runLoop } = await import('./lib/engine.mjs');

  // Drafts verify offline: freeform lane, no URLs (warn, not fail).
  const CLEAN_DRAFT = 'Notes.\n\nCommunity first, paid second.\n';
  const BAD_DRAFT = 'Notes.\n\nRetention rose 61% across cohorts.\n'; // uncited stat → deterministic fail

  function harness({ claudeQueue, codexQueue, answerQueue, abortOnAsk = false, publish, iterationPolicy = 'iterative', evaluationProfile = null, evaluationCaseId = null, evaluationChecks = null, evaluationPlanPolicy = null }) {
    const events = [];
    const prompts = { claude: [], codex: [] };
    const published = [];
    const abort = new AbortController();
    const review = (verdict, findings = [], questions = []) => ({
      ran: true, error: null,
      verdict, findings,
      blocking: findings.filter((f) => f.severity !== 'low'),
      nonblocking: findings.filter((f) => f.severity === 'low'),
      questions,
      claimAssessments: [],
      coverageAssessments: [],
      thresholdAssessments: [],
    });
    const ctx = {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async (q) => {
        events.push({ type: '_asked', kind: q.kind, options: q.options ?? null });
        if (abortOnAsk) abort.abort();
        const next = answerQueue.shift();
        if (next === undefined) throw new Error(`no scripted answer for: ${q.text}`);
        return next;
      },
      adapters: {
        maker: async ({ prompt }) => {
          prompts.claude.push(prompt);
          const next = claudeQueue.shift();
          if (next === undefined) throw new Error('claude called more times than scripted');
          if (next && typeof next === 'object') return next;
          return { ok: true, error: null, text: next, costUsd: 0 };
        },
        reviewer: async ({ prompt }) => {
          prompts.codex.push(prompt);
          const next = codexQueue.shift();
          if (next === undefined) throw new Error('codex called more times than scripted');
          return next;
        },
      },
      hivemind: {
        searchKnowledge: async () => null,
        publishArtifact: async (a) => { published.push(a); return { published: true, url: null }; },
        hivemindStatus: () => ({ connected: false, mode: 'stub', base: null }),
      },
      signal: abort.signal,
      scratchDir: '.',
      receiptsDir: 'runs/_engine-test',
    };
    const run = { id: 'engine-test', goal: 'test goal', lane: 'freeform', depth: 'quick', ground: false, iterationPolicy, evaluationProfile, evaluationCaseId, evaluationChecks, evaluationPlanPolicy };
    if (publish !== undefined) run.publish = publish;
    return { run: () => runLoop(run, ctx), events, prompts, published, review, abort };
  }

  // A registered mechanical miss terminates before review. This is the cheap
  // first rung of the grading ladder, not a model-authored quality verdict.
  {
    const h = harness({
      claudeQueue: [CLEAN_DRAFT],
      codexQueue: [],
      answerQueue: [],
      iterationPolicy: 'single_pass',
      evaluationProfile: 'simple',
      evaluationCaseId: 'simple-shape-probe',
      evaluationPlanPolicy: 'direct_make',
      evaluationChecks: [{ id: 'must-name-owner', label: 'owner present', type: 'required_phrases', phrases: ['Owner:'] }],
    });
    const result = await h.run();
    assert.equal(result.status, 'verify_failed');
    assert.equal(h.prompts.codex.length, 0, 'a deterministic red buys no reviewer call');
    const precheck = h.events.find((event) => event.type === 'verify_result' && event.source === 'evaluation_case_precheck');
    assert.equal(precheck.pass, false);
    assert.equal(precheck.evaluationCaseId, 'simple-shape-probe');
    assert.equal(h.events.some((event) => event.type === 'stage' && event.name === 'plan' && event.status === 'skipped'), true, 'the sealed direct policy is visible in the trace');
  }

  const f = (severity, title) => ({ severity, title, detail: 'd', suggestion: 's' });
  const review = harness({ claudeQueue: [], codexQueue: [], answerQueue: [] }).review;

  // A purchased plan must reach the draft prompt. Previously it was emitted
  // and billed, then discarded before the maker wrote anything.
  {
    const h = harness({
      claudeQueue: ['- Lead with the owner mapping', CLEAN_DRAFT],
      codexQueue: [review('APPROVED')],
      answerQueue: [],
    });
    await h.run();
    assert.match(h.prompts.claude[1], /SEALED PLAN FROM THIS RUN/);
    assert.match(h.prompts.claude[1], /Lead with the owner mapping/);
  }

  // Evaluation measures the frozen first pass. A revise verdict is retained,
  // then deterministic verification runs on the untouched artifact: no repair,
  // content answer, or extra review may make one arm more expensive than a peer.
  {
    const h = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT],
      codexQueue: [review('REVISE', [f('high', 'First-pass gap')], ['Clarify the audience?'])],
      answerQueue: [],
      iterationPolicy: 'single_pass',
      evaluationProfile: 'balanced',
    });
    const result = await h.run();
    assert.equal(result.status, 'done_with_findings', 'a verified first pass retains the independent findings');
    assert.equal(h.prompts.claude.length, 2, 'single-pass evaluation buys plan + make only');
    assert.equal(h.prompts.codex.length, 1, 'single-pass evaluation buys one review only');
    assert.equal(h.events.some((event) => event.type === '_asked'), false, 'reviewer content questions remain evidence, not changed input');
  }

  // Even a clean reviewer cannot trigger a deterministic repair in evaluation
  // mode: a red first artifact is an observed failure, not an invitation to
  // mutate the treatment after measurement.
  {
    const h = harness({
      claudeQueue: ['- plan', BAD_DRAFT],
      codexQueue: [review('APPROVED')],
      answerQueue: [],
      iterationPolicy: 'single_pass',
      evaluationProfile: 'simple',
    });
    const result = await h.run();
    assert.equal(result.status, 'verify_failed', 'deterministic red is terminal first-pass evidence');
    assert.equal(h.prompts.claude.length, 2, 'no verify-fix call is purchased');
    assert.equal(h.prompts.codex.length, 1, 'no closure review is purchased');
    assert.equal(h.events.some((event) => event.type === '_asked'), false, 'evaluation failure needs no human override');
  }

  // A deterministic provider refusal must not silently purchase an identical
  // second call. The operator can explicitly override, but stopping costs only
  // the single failed call.
  {
    const h = harness({
      claudeQueue: [{ ok: false, error: 'completion limit exhausted', errorCode: 'completion_limit', retryable: false }],
      codexQueue: [],
      answerQueue: ['Stop the run'],
    });
    const result = await h.run();
    assert.equal(result.status, 'stopped', 'the operator can stop after one deterministic provider failure');
    assert.equal(h.prompts.claude.length, 1, 'a non-retryable result never triggers an automatic duplicate call');
    const question = h.events.find((event) => event.type === '_asked' && event.kind === 'infra');
    assert.deepEqual(question.options, ['Retry anyway', 'Stop the run'], 'retry requires an explicit override');
  }

  // --- Case A: verify containment (approve r1, bad draft, ship-anyway) ---
  {
    const h4 = harness({
      claudeQueue: ['- plan', BAD_DRAFT, BAD_DRAFT], // plan, make, ONE verify-fix (still bad)
      codexQueue: [review('APPROVED')],
      answerQueue: ['Ship anyway (recorded as verify_failed)'],
    });
    const res = await h4.run();
    assert.equal(res.status, 'verify_failed', 'ship-anyway records verify_failed');
    assert.equal(h4.published.length, 0, 'a red is never published');
    const verifyAsk = h4.events.find((e) => e.type === '_asked' && e.kind === 'verify');
    assert.ok(verifyAsk, 'verify override question asked');
    assert.equal(h4.prompts.claude.length, 3, 'exactly one verify-fix pass before the human (budget=1)');
    assert.ok(res.answers.some((a) => a.kind === 'verify' && a.answer.startsWith('Ship anyway')), 'override recorded with kind');
    assert.ok(!h4.events.some((e) => e.type === 'status' && (e.status === 'done' || e.status === 'done_with_findings')), 'no green status ever emitted');
  }

  // --- Case B: verify fail → fix succeeds → done, publish exactly once ---
  {
    const h5 = harness({
      claudeQueue: ['- plan', BAD_DRAFT, CLEAN_DRAFT],
      codexQueue: [review('APPROVED'), review('APPROVED')],
      answerQueue: [],
      publish: true,
    });
    const res = await h5.run();
    // Freeform drafts with no URLs verify green WITH caveats (links warn,
    // structure/citations skip) — and caveats are never hidden as plain done.
    assert.equal(res.status, 'done_with_findings', 'fixable red ends green-with-caveats');
    assert.equal(h5.published.length, 1, 'published exactly once');
    assert.equal(h5.prompts.codex.length, 2, 'a verify-fix triggers a fresh closure audit on the changed artifact');
    const closure = h5.events.find((e) => e.type === 'review' && e.scope === 'closure');
    assert.equal(closure.rev, 2, 'the closure audit binds to the repaired revision');
  }

  // --- Case C: done_with_findings lanes ---
  {
    // C1: APPROVED with a low finding → done_with_findings
    const observedApproval = {
      ...review('APPROVED', [f('low', 'nit')]),
      usage: { input_tokens: 90, cached_input_tokens: 10, output_tokens: 20 },
      durationMs: 4321,
    };
    const h6 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT],
      codexQueue: [observedApproval],
      answerQueue: [],
    });
    assert.equal((await h6.run()).status, 'done_with_findings', 'approved-with-lows is not a plain done');
    assert.equal(h6.published.length, 0, 'publication defaults OFF when no explicit opt-in was recorded');
    const observedReviewEvent = h6.events.find((e) => e.type === 'review');
    assert.deepEqual(observedReviewEvent.usage, observedApproval.usage, 'review usage survives into the sealed event');
    assert.equal(observedReviewEvent.duration_ms, 4321, 'review wall-clock survives into the sealed event');
    const { deriveEvidence: deriveObservedEvidence } = await import('./lib/evidence.mjs');
    const observedRound = deriveObservedEvidence(h6.events).rounds[0];
    assert.deepEqual(observedRound.usage, observedApproval.usage, 'review usage survives event-to-report derivation');
    assert.equal(observedRound.duration_ms, 4321, 'review wall-clock survives event-to-report derivation');

    // C2: stuck (same title twice) → accept → done_with_findings
    const h7 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'Retention figure has no source.')]),
        review('REVISE', [f('high', 'retention figure has NO source')]), // case/punct differ — same key
      ],
      answerQueue: ['Accept result (with findings on record)'],
    });
    const res7 = await h7.run();
    assert.equal(res7.status, 'done_with_findings', 'stuck-accept is done_with_findings');
    const stuckAsk = h7.events.find((e) => e.type === '_asked' && e.kind === 'stuck');
    assert.ok(stuckAsk, 'stuck card fired on normalized-title repeat');

    // C3: fresh titles every round → round cap card at ROUND_CAP, accept
    const h8 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'A')]),
        review('REVISE', [f('high', 'B')]),
        review('REVISE', [f('high', 'C')]),
      ],
      answerQueue: ['Accept result (with findings on record)'],
    });
    const res8 = await h8.run();
    assert.equal(res8.status, 'done_with_findings', 'cap-accept is done_with_findings');
    assert.equal(h8.prompts.codex.length, 3, 'review ran exactly ROUND_CAP times');
    const capAsk = h8.events.filter((e) => e.type === '_asked' && e.kind === 'stuck');
    assert.equal(capAsk.length, 1, 'exactly one human prompt on the final round (no double-fire)');
    assert.equal(capAsk[0].options.length, 2, 'final-round card offers no "one more round"');

    // C4: accepting a red artifact at the round cap is a STOP decision. Camus
    // records deterministic failure but must not silently purchase a verify-fix
    // after the human already chose to stop iterating.
    const h8red = harness({
      claudeQueue: ['- plan', BAD_DRAFT, BAD_DRAFT, BAD_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'A')]),
        review('REVISE', [f('high', 'B')]),
        review('REVISE', [f('high', 'C')]),
      ],
      answerQueue: ['Accept result (with findings on record)'],
    });
    const res8red = await h8red.run();
    assert.equal(res8red.status, 'verify_failed', 'accepted findings never hide a deterministic red');
    assert.equal(h8red.prompts.claude.length, 4, 'no verify-fix call occurs after the stop decision');
    assert.equal(h8red.events.filter((e) => e.type === '_asked').length, 1, 'the accepted stop decision is not immediately re-asked');
    assert.ok(h8red.events.some((e) => e.type === 'status' && e.status === 'verify_failed'), 'the red standing is emitted explicitly');
  }

  // --- Case D: oscillation A → B → A halts ---
  {
    const h9 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'A')]),
        review('REVISE', [f('high', 'B')]),
        review('REVISE', [f('high', 'A')]), // returns after vanishing
      ],
      answerQueue: ['Stop the run'],
    });
    const res9 = await h9.run();
    assert.equal(res9.status, 'stopped', 'human stopped at the oscillation card');
    assert.ok(h9.events.some((e) => e.type === '_asked' && e.kind === 'stuck'), 'oscillating finding halts');
  }

  // --- Case E: answer threading + process/content separation ---
  {
    const h10 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT, CLEAN_DRAFT],
      codexQueue: [
        review('REVISE', [f('high', 'Unanchored')], ['Base-first or multichain?']),
        review('APPROVED'),
      ],
      answerQueue: ['Base-first.'],
    });
    const res10 = await h10.run();
    assert.equal(res10.status, 'done_with_findings'); // freeform caveats, as above
    const fixPromptText = h10.prompts.claude[2]; // plan, make, fix
    assert.ok(fixPromptText.includes('Base-first.'), 'decision lands in the fix prompt');
    assert.ok(h10.prompts.codex[1].includes('Base-first.'), 'decision lands in the next review prompt');
    assert.ok(h10.prompts.codex[1].includes('do NOT re-raise'), 'reviewer told decisions are settled');
    assert.deepEqual(res10.answers.map((a) => a.kind), ['decision'], 'only the decision recorded');
  }

  // --- Case F: Stop during a pending question → stopped, nothing recorded, nothing published ---
  {
    const h11 = harness({
      claudeQueue: ['- plan', CLEAN_DRAFT],
      codexQueue: [review('APPROVED', [], ['Which audience?'])], // clean verdict + lingering question
      answerQueue: ['Stop the run'], // what the /stop handler resolves with
      abortOnAsk: true, // abort() fires before the answer resolves, like the real handler
    });
    const res11 = await h11.run();
    assert.equal(res11.status, 'stopped', 'stop during a question stops the run');
    assert.equal(h11.published.length, 0, 'nothing published after stop');
    assert.equal(res11.answers.length, 0, 'no fabricated decision in the receipts');
  }
}

// --- session-line parsers + runtime config resolution -------------------------
{
  const { sessionLineFromEvent, parseHivemindToolResult } = await import('./lib/adapters/claude.mjs');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'crypto ad policy' } }] } }),
    'WebSearch: crypto ad policy', 'claude tool_use becomes a session line');
  assert.equal(
    sessionLineFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude_ai_Hivemind_Staging__knowledge_search', input: { query: 'gtm' } }] } }),
    'knowledge_search: gtm', 'managed MCP prefix (including underscores) stripped');
  assert.equal(sessionLineFromEvent({ type: 'result', result: 'x' }), null, 'result events are not session lines');
  const hmResult = parseHivemindToolResult([{
    type: 'text',
    text: JSON.stringify({ success: true, data: { query: 'cohort evidence', chunks: [{ title: 'Cohort playbook', author: 'A. Expert', content: 'Programs should sell progress, not content.', chunk_id: 'chunk-1', score: 0.8 }] } }),
  }]);
  assert.deepEqual(hmResult, [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }], 'structured Hivemind tool results become bounded audit evidence');
  assert.deepEqual(parseHivemindToolResult([{ type: 'text', text: 'not-json' }]), [], 'malformed tool output never becomes invented evidence');

  const { sessionLineFromCodexEvent } = await import('./lib/adapters/codex.mjs');
  assert.equal(
    sessionLineFromCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', summary: 'checking the claim' } })),
    'reasoning: checking the claim', 'codex reasoning surfaces');
  assert.ok(
    sessionLineFromCodexEvent(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })).includes('10 in / 2 out'),
    'token usage surfaces');
  assert.equal(sessionLineFromCodexEvent('not json'), null, 'garbage lines are silent');

  const { getModels } = await import('./lib/models.mjs');
  const m = getModels();
  assert.ok(m.maker.model && m.reviewer.model, 'models resolve from the decision record');
  assert.ok(m.loop.roundCap >= 1 && m.loop.roundCap <= 6, 'round cap resolves in range');
  process.env.ROUND_CAP = 'three';
  assert.equal(getModels().loop.roundCap, 3, 'NaN cap falls back to 3, never skips review');
  delete process.env.ROUND_CAP;

  // reviewer model and effort are independent decisions: their provenance must
  // not be conflated (an env model with a file effort, or the reverse).
  const base = getModels().reviewer;
  assert.equal(base.modelSource, 'STUDIO_MODELS_FILE', 'the isolated decision file names its provenance');
  assert.equal(base.effortSource, 'STUDIO_MODELS_FILE', 'the isolated effort names the same decision source');
  process.env.CODEX_MODEL = 'probe-reviewer';
  let split = getModels().reviewer;
  assert.equal(split.modelSource, 'env:CODEX_MODEL', 'an env model names the env as the model source');
  assert.equal(split.effortSource, 'STUDIO_MODELS_FILE', 'effort still traces to the isolated file when only the model is overridden');
  delete process.env.CODEX_MODEL;
  process.env.CODEX_EFFORT = 'high';
  split = getModels().reviewer;
  assert.equal(split.modelSource, 'STUDIO_MODELS_FILE', 'model still traces to the isolated file when only the effort is overridden');
  assert.equal(split.effortSource, 'env:CODEX_EFFORT', 'an env effort names the env as the effort source');
  delete process.env.CODEX_EFFORT;
}

// --- build lane: spend-free refusals + fail-closed report parsing ------------
{
  const {
    validateBuildTarget,
    parseGateReport,
    gateArgsForRun,
    gateIgniterCliArgs,
    gateIgniterResumeCliArgs,
    gateSupportsStudio,
    claudeAuthFailureNote,
    claudeSessionIdFromEvent,
    gateReviewRoundInRange,
    reviewEventFromGateReceipt,
    verifyEventFromGateReport,
  } = await import('./lib/code-lane.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');

  assert.equal((await validateBuildTarget('')).ok, false, 'empty path refused');
  assert.equal((await validateBuildTarget('~/no/such/dir-9x7q')).ok, false, 'missing dir refused');
  assert.ok((await validateBuildTarget('/tmp/evil"; rm -rf /')).error.includes('shell-unsafe'), 'shell-unsafe path refused');

  const plain = mkdtempSync(join(tmpdir(), 'cls-plain-'));
  assert.ok((await validateBuildTarget(plain)).error.includes('not a git repository'), 'non-git dir refused');

  const repo = mkdtempSync(join(tmpdir(), 'cls-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const good = await validateBuildTarget(repo);
  assert.equal(good.ok, true, 'clean git repo accepted');
  assert.ok(good.toplevel, 'toplevel resolved for the concurrency guard');

  execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
  assert.ok((await validateBuildTarget(repo)).error.includes('detached'), 'detached HEAD refused');
  rmSync(plain, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });

  // Report parsing: a run whose status we cannot read is NEVER done.
  assert.equal(parseGateReport('{"status":"done","commit":"a1f9c2e"}').status, 'done', 'clean JSON report parses');
  assert.equal(parseGateReport('The loop finished: status "done_with_findings", branch camus-wt-x.').status, 'done_with_findings', 'prose-wrapped status parses');
  assert.equal(parseGateReport('I made it work and everything looks great!').status, 'infra_error', 'no readable status is infra, never done');
  assert.equal(parseGateReport('').status, 'infra_error', 'empty output is infra');
  const q = parseGateReport('Paused. {"status":"needs_human","question":"Two callers expect different shapes. Which contract should win?"}');
  assert.equal(q.status, 'needs_human');
  assert.ok(q.question.includes('Which contract'), 'question extracted for the card');
  // done_with_findings must not be shadowed by its 'done' suffix
  assert.equal(parseGateReport('status: done_with_findings').status, 'done_with_findings', 'longest status wins');
  // Live-fire regression (2026-07-12): camus wraps statuses in backticks —
  // the studio misread a real green as infra_error until this passed.
  assert.equal(
    parseGateReport('**The Camus loop closed green: `done` — review clean in 1 round, deterministic verify passed.** The gated change sits on branch `camus/greet-x`.').status,
    'done', 'backtick-wrapped status parses (the real gate output shape)');
  assert.equal(parseGateReport('halted: [needs_human]').status, 'needs_human', 'bracket-wrapped status parses');
  // Live-fire P0 regression (2026-07-13 authenticated smoke): the gate returned
  // a REAL structured no_changes whose note contains the standalone word "done"
  // ("never a false done"). no_changes was missing from the recognized list, the
  // parseable report was discarded, and the prose fallback matched "done" —
  // Studio fabricated "DONE — reviewed and verified" with no verifier run.
  const liveNoop = parseGateReport('The loop halted. {"status":"no_changes","task":"t","worktree":"/w","branch":"camus/x","rounds":1,"note":"Review passed but the implement step produced no committable change (empty diff). no_changes, never a false done — nothing to merge."}');
  assert.equal(liveNoop.status, 'no_changes', 'the live smoke report parses to no_changes, never a prose-matched done');
  // Exhaustiveness has a second net: a structured status Studio does NOT know
  // must fail closed as infra — token parsing never overrides a parseable report.
  const unknownStructured = parseGateReport('{"status":"some_future_status","note":"work is done and everything verified"}');
  assert.equal(unknownStructured.status, 'infra_error', 'an unrecognized structured status is infra, never re-guessed from prose');
  assert.match(unknownStructured.note, /some_future_status/, 'the refusal names the unrecognized status');

  const boundArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1' }, 3);
  assert.equal(boundArgs.identitySalt, 'studio-run-1', 'Studio binds standalone custody with identitySalt');
  assert.equal('idSalt' in boundArgs, false, 'Studio never impersonates camus-feat ownership');
  assert.equal('model' in boundArgs, false, 'no maker snapshot → no model pin (nothing invented)');
  const pinnedArgs = gateArgsForRun({ goal: 't', targetPath: '/tmp/repo', idSalt: 'studio-run-1', models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.4' } } }, 3);
  assert.equal(pinnedArgs.model, 'opus', 'the maker is pinned THROUGH the /camus-loop contract from the run-start snapshot, not the outer igniter');
  const contractedArgs = gateArgsForRun({ goal: 't', acceptanceContract: 'Tests pass and the requested API remains compatible.', targetPath: '/tmp/repo', idSalt: 'studio-run-1' }, 3);
  assert.match(contractedArgs.task, /Acceptance contract \(binding\):/, 'the code gate receives the contract as part of its binding task');
  assert.match(contractedArgs.task, /requested API remains compatible/, 'the gate judges the exact user contract');
  const igniterArgs = gateIgniterCliArgs('/camus-loop {}');
  assert.equal(igniterArgs.includes('--tools'), false, 'process-wide tools stay inherited so camus-loop child agents retain Bash/Read/Edit');
  assert.deepEqual(igniterArgs.slice(igniterArgs.indexOf('--allowedTools'), igniterArgs.indexOf('--allowedTools') + 2), ['--allowedTools', 'Workflow'], 'only the outer Workflow call is pre-approved');
  assert.ok(igniterArgs.includes('--append-system-prompt'), 'outer igniter receives the custody contract as system policy');
  const liveSessionId = '1925308a-a75d-4c9c-86b0-72250c44e94b';
  assert.equal(claudeSessionIdFromEvent({ type: 'system', subtype: 'init', session_id: liveSessionId }), liveSessionId, 'the streamed Claude session identity is captured for a same-conversation async wait');
  assert.equal(claudeSessionIdFromEvent({ type: 'result', session_id: liveSessionId }), null, 'only the authenticated init event can name the resumable Claude session');
  assert.equal(claudeSessionIdFromEvent({ type: 'system', subtype: 'init', session_id: '../bad' }), null, 'an invalid session id never reaches argv');
  const resumeIgniterArgs = gateIgniterResumeCliArgs(liveSessionId);
  assert.deepEqual(resumeIgniterArgs.slice(resumeIgniterArgs.indexOf('--resume'), resumeIgniterArgs.indexOf('--resume') + 2), ['--resume', liveSessionId], 'an async gate wait resumes the exact outer Claude conversation');
  assert.deepEqual(resumeIgniterArgs.slice(resumeIgniterArgs.indexOf('--allowedTools'), resumeIgniterArgs.indexOf('--allowedTools') + 2), ['--allowedTools', 'Workflow'], 'the resumed conversation retains the Workflow-only custody surface');
  assert.ok(!resumeIgniterArgs[resumeIgniterArgs.indexOf('-p') + 1].includes('/camus-loop'), 'the await turn cannot accidentally start a fresh slash-command workflow');
  assert.match(resumeIgniterArgs[resumeIgniterArgs.indexOf('-p') + 1], /prior Workflow handle/, 'the await turn tells Claude to resume the prior async handle');
  assert.equal(gateSupportsStudio({ workflow: 'const STANDALONE_ID_SALT = x', worktreeGate: 'create|ensure|attach|resolve' }), true, 'new installed gate advertises both custody capabilities');
  assert.equal(gateSupportsStudio({ workflow: 'const ID_SALT = x', worktreeGate: 'create|attach|resolve' }), false, 'older installed gate is refused instead of silently ignoring identitySalt');
  assert.equal(gateReviewRoundInRange(1, 3), true, 'the first gate review round is eligible for the Studio timeline');
  assert.equal(gateReviewRoundInRange(3, 3), true, 'the frozen final gate round is eligible');
  assert.equal(gateReviewRoundInRange(0, 3), false, 'a direct reviewer invocation that defaulted to r0 cannot contaminate a gate run');
  assert.equal(gateReviewRoundInRange(4, 3), false, 'a receipt beyond the frozen round cap cannot contaminate a gate run');

  // Live-fire regression (2026-07-13): Claude's local auth status said logged
  // in while inference returned 401. Custody correctly refused the absent
  // Workflow call, but its generic message hid the only useful repair.
  const retry401 = claudeAuthFailureNote({ type: 'system', subtype: 'api_retry', error_status: 401, error: 'authentication_failed' });
  assert.match(retry401, /claude auth login/, 'a streamed 401 becomes an actionable reauthentication instruction');
  assert.equal(
    claudeAuthFailureNote({ type: 'result', api_error_status: 401, result: 'Invalid authentication credentials' }),
    retry401,
    'the terminal 401 produces the same stable user-facing diagnosis',
  );
  assert.equal(claudeAuthFailureNote({ type: 'system', subtype: 'api_retry', error_status: 429, error: 'rate_limited' }), null, 'non-auth failures still go through normal custody/error handling');
  assert.equal(claudeAuthFailureNote({ type: 'result', result: 'done' }), null, 'a normal result is never mislabeled as auth failure');

  // Live-fire regression (2026-07-13): gate reviews are envelopes. Reading
  // only root fields made a clean audit look like an unspecified revision and
  // let report.json claim completeness without carrying the verdict.
  const nestedReview = reviewEventFromGateReceipt({
    codex_parsed: {
      overall_correctness: 'patch is correct',
      overall_confidence_score: 0.99,
      overall_explanation: 'The patch and tests are correct.',
      findings: [],
    },
  }, 1);
  assert.equal(nestedReview.verdict, 'APPROVED', 'nested clean verdict normalizes for the UI and evidence');
  assert.equal(nestedReview.confidence, 0.99, 'review confidence survives normalization');
  assert.equal(nestedReview.source, 'camus_gate_review', 'review provenance is explicit');
  assert.equal(nestedReview.reviewerModel, null, 'no ran:true pin → reviewer model stays null (nothing invented)');
  const pinnedReview = reviewEventFromGateReceipt({ ran: true, reviewer_model: 'gpt-5.4', reviewer_effort: 'medium', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(pinnedReview.reviewerModel, 'gpt-5.4', 'a review that ran carries the reviewer model it was pinned to');
  // Live smoke P1 (2026-07-13): the snapshot requested one effort, the gate ran
  // another. The evidence seals the ACTUAL effort the audit recorded — never the
  // snapshot's requested value, never a default.
  assert.equal(pinnedReview.reviewerEffort, 'medium', 'a review that ran carries the effort it actually ran at');
  const boundQualification = { fingerprint: `builtin1:${'a'.repeat(64)}`, gate_scope: 'full', contract_version: 'review-contract-1' };
  const boundReview = reviewEventFromGateReceipt({
    ran: true,
    reviewer_model: 'gpt-5.4',
    reviewer_effort: 'high',
    binding: {
      review_scope: 'full',
      contract_version: 'review-contract-1',
      qualification: boundQualification,
    },
    codex_parsed: { overall_correctness: 'patch is correct', findings: [] },
  }, 1);
  assert.equal(boundReview.review_scope, 'full', 'the gate binding scope survives receipt normalization');
  assert.equal(boundReview.review_contract_version, 'review-contract-1', 'the independently bound review-contract version survives');
  assert.deepEqual(boundReview.qualification, boundQualification, 'the accepted qualification survives without being reconstructed');
  const { deriveEvidence: deriveBoundEvidence } = await import('./lib/evidence.mjs');
  const derivedBoundRound = deriveBoundEvidence([{ type: 'review', ...boundReview }]).rounds[0];
  assert.equal(derivedBoundRound.review_scope, 'full', 'the production event-to-evidence builder keeps the independent scope channel');
  assert.equal(derivedBoundRound.review_contract_version, 'review-contract-1', 'the production builder keeps the contract binding too');
  assert.deepEqual(derivedBoundRound.qualification, boundQualification, 'the production builder does not wash the accepted qualification to null');
  const unranPin = reviewEventFromGateReceipt({ ran: false, reviewer_model: 'gpt-5.4', reviewer_effort: 'medium', codex_parsed: { overall_correctness: 'patch is correct', findings: [] } }, 1);
  assert.equal(unranPin.reviewerModel, null, 'a review that did not run never claims a reviewer identity');
  assert.equal(unranPin.reviewerEffort, null, 'a review that did not run never claims an effort either');
  assert.equal(nestedReview.reviewerEffort, null, 'no ran:true envelope → effort stays null (nothing invented)');

  const nestedFinding = reviewEventFromGateReceipt({ codex_parsed: JSON.stringify({
    overall_correctness: 'patch is incorrect',
    findings: [{ priority: 1, title: 'Unsafe fallback', body: 'The fallback bypasses custody.', code_location: 'lib/x.mjs:9', confidence_score: 0.91 }],
  }) }, 2);
  assert.equal(nestedFinding.verdict, 'REVISE', 'stringified nested verdict also normalizes');
  assert.equal(nestedFinding.findings[0].severity, 'high', 'gate priority maps to Studio severity');
  assert.equal(nestedFinding.findings[0].detail, 'The fallback bypasses custody.', 'Codex body becomes receipt detail');

  const derivedVerify = verifyEventFromGateReport({ status: 'done', commit_sha: 'c92d002521e09bab', note: 'verify passed' });
  assert.equal(derivedVerify.pass, true, 'done carries the gate contract that deterministic verify passed');
  assert.equal(derivedVerify.source, 'gate_report_status', 'derived verification names its source');
  assert.equal(derivedVerify.warnings, null, 'unknown check counts stay unknown rather than becoming zero');
  assert.equal(verifyEventFromGateReport({ status: 'infra_error' }), null, 'infra does not fabricate a verification result');
  assert.equal(verifyEventFromGateReport({ status: 'no_changes' }), null, 'a genuine no-op never fabricates a verification result (nothing ran)');
}

// --- build lane: the outer igniter cannot fork or mutate custody ------------
{
  const { createGateCustodyGuard } = await import('./lib/gate-custody.mjs');
  const { gateProcessClose } = await import('./lib/code-lane.mjs');
  const expected = { task: 't', targetPath: '/tmp/repo', policy: 'ask_on_ambiguity', roundCap: 3, identitySalt: 'studio-run-1' };
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

  // THE WP6 REATTACH PATH, end to end (dogfood 20260805-062823-zoi8): one fresh
  // workflow → the resumed session finds Workflow unloaded → ONE bounded
  // rehydration lookup → resume of the SAME run with byte-equivalent args. This
  // is the sequence that died mid-implement; it must be accepted whole.
  const good = createGateCustodyGuard(expected);
  assert.equal(good.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ identitySalt: 'studio-run-1', roundCap: 3, policy: 'ask_on_ambiguity', targetPath: '/tmp/repo', task: 't' }) })), null, 'one fresh workflow with equivalent JSON args is accepted');
  assert.equal(good.inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1 })), null, 'the resumed session may rehydrate the deferred Workflow tool exactly as GATE_AWAIT_PROMPT pins it');
  assert.equal(good.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify(expected) })), null, 'and then resumes the SAME run with the same args');
  assert.equal(good.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify(expected) })), null, 'further await chunks on that same run stay bound');
  assert.equal(good.finish(), null, 'one bound workflow produces a valid custody trail');
  const goodSnap = good.snapshot();
  assert.equal(goodSnap.freshCalls, 1, 'exactly ONE original workflow');
  assert.equal(goodSnap.toolSearchCalls, 1, 'exactly ONE controlled rehydration lookup');
  assert.equal(goodSnap.workflowRunId, 'wf_abc', 'the bound run identity never changed');

  // The default max_results (5) and a semantic phrasing that still names Workflow
  // are tolerated, so a minor wording difference cannot kill a live run.
  assert.equal(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 5 })), null, 'the ToolSearch schema default result cap is accepted');
  assert.equal(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'resume the prior Workflow handle', max_results: 3 })), null, 'Workflow discovery tolerates CLI query phrasing while staying bounded');
  assert.equal(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 10 })), null, 'the common 10-result cap is inside the permitted range, not a custody breach');

  // ONE lookup PER IGNITER PROCESS, not one per gate. An async workflow is awaited
  // across up to six `claude --resume` turns and EACH is a new process that may
  // again need to rehydrate Workflow. A global cap would kill the second
  // legitimate reattach — so the budget resets per turn while the same-run and
  // exact-args constraints stay global.
  const twice = createGateCustodyGuard(expected);
  twice.beginTurn();
  twice.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  assert.equal(twice.inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1 })), null, 'the first rehydration is allowed');
  assert.match(twice.inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1 })), /2 ToolSearch calls in one turn; rehydrating Workflow is permitted 1 time per igniter process/, 'a SECOND lookup WITHIN ONE TURN is refused — one rehydration, not a search loop');

  // MULTI-TURN REATTACH: two separate resume processes, each rehydrating once,
  // each resuming the SAME run. This is the six-turn await path; a per-gate cap
  // would have killed turn 2 for making "ToolSearch call number two".
  const multi = createGateCustodyGuard(expected);
  multi.beginTurn(); // turn 1: the original igniter process
  assert.equal(multi.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) })), null, 'turn 1 starts the one fresh workflow');
  multi.beginTurn(); // turn 2: a NEW claude --resume process, tools unloaded again
  assert.equal(multi.inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1 })), null, 'reattach turn 2 may rehydrate Workflow');
  assert.equal(multi.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify(expected) })), null, 'and resumes the same run');
  multi.beginTurn(); // turn 3: another new process, unloaded again
  assert.equal(multi.inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1 })), null, 'reattach turn 3 may ALSO rehydrate — the budget is per process, not per gate');
  assert.equal(multi.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify(expected) })), null, 'and resumes the same run again');
  assert.equal(multi.finish(), null, 'a multi-turn reattach is a valid custody trail');
  const multiSnap = multi.snapshot();
  assert.equal(multiSnap.freshCalls, 1, 'still exactly ONE original workflow across every turn');
  assert.equal(multiSnap.toolSearchCalls, 2, 'two rehydrations happened, one per reattach process');
  assert.equal(multiSnap.workflowRunId, 'wf_abc', 'and the bound run identity never changed');

  // A new turn must NOT relax the global constraints it exists to preserve.
  const turnAbuse = createGateCustodyGuard(expected);
  turnAbuse.beginTurn();
  turnAbuse.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  turnAbuse.beginTurn();
  assert.match(turnAbuse.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) })), /second fresh/, 'a new turn cannot buy a second fresh workflow');
  const argAbuse = createGateCustodyGuard(expected);
  argAbuse.beginTurn();
  argAbuse.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  argAbuse.beginTurn();
  assert.match(argAbuse.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_abc.js', resumeFromRunId: 'wf_abc', args: JSON.stringify({ ...expected, task: 'different' }) })), /args changed/, 'a new turn cannot change the args either');

  const dropped = createGateCustodyGuard(expected);
  assert.match(dropped.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ ...expected, identitySalt: undefined }) })), /args changed/, 'dropping identitySalt is refused before a second worktree can be trusted');

  const forked = createGateCustodyGuard(expected);
  forked.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  assert.match(forked.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) })), /second fresh/, 'a second fresh workflow is a custody breach even with identical args');

  const historical = createGateCustodyGuard(expected);
  historical.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  historical.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_old.js', resumeFromRunId: 'wf_old', args: JSON.stringify(expected) }));
  assert.match(historical.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify({ task: 't', targetPath: '/tmp/repo', policy: 'ask_on_ambiguity', roundCap: 3 }) })), /args changed/, 'the exact live-smoke failure — a fresh unsalted retry after resume — is stopped');

  const switched = createGateCustodyGuard(expected);
  switched.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  switched.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_a.js', resumeFromRunId: 'wf_a', args: JSON.stringify(expected) }));
  assert.match(switched.inspect(tool('Workflow', { scriptPath: '/tmp/camus-loop-wf_b.js', resumeFromRunId: 'wf_b', args: JSON.stringify(expected) })), /switched run identity/, 'resume cannot jump to another workflow run');

  const escaped = createGateCustodyGuard(expected);
  assert.match(escaped.inspect(tool('Bash', { command: 'git status' })), /non-Workflow/, 'the igniter cannot inspect or repair the repo itself');
  // Every refusal NAMES ITS REASON. The WP6 receipt said only "ToolSearch outside
  // bounded Workflow discovery", so the run could not be diagnosed from evidence.
  // Diagnostics carry schema-level facts only — key names, a length, a number —
  // never the raw query text or any tool payload, which can hold task content.
  assert.match(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'available tools' })), /did not name Workflow/, 'discovery that does not name Workflow is refused, and says so');
  assert.match(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'select:Bash', max_results: 5 })), /did not name Workflow/, 'discovery of a non-Workflow tool is refused');
  assert.match(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 50 })), /max_results 50; permitted range is 1-10/, 'an out-of-range result cap is refused BY NAME, not with a generic message');
  assert.match(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: '', max_results: 1 })), /had no query/, 'an empty query is refused by name');
  assert.match(createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: `select:Workflow ${'x'.repeat(140)}`, max_results: 1 })), /query was \d+ chars \(max 120\)/, 'an oversized query is refused by name, reporting only its length');
  const extra = createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: 'select:Workflow', max_results: 1, cwd: '/etc/secrets' }));
  assert.match(extra, /unexpected field\(s\) cwd/, 'an unexpected field is refused and NAMED');
  assert.equal(extra.includes('/etc/secrets'), false, 'the refusal records the field NAME, never its value');
  const longQuery = createGateCustodyGuard(expected).inspect(tool('ToolSearch', { query: `workflow ${'secret-token-abc '.repeat(9)}`, max_results: 1 }));
  assert.equal(longQuery.includes('secret-token-abc'), false, 'a refused query is never echoed into the receipt');
  assert.match(createGateCustodyGuard(expected).finish(), /without one fresh/, 'prose without a workflow never becomes a gate result');

  // RECOVERY (fix 5): a refusal SIGKILLs the igniter, which ends the inner
  // Workflow — but the implemented files survive on disk. The WP6 receipt said
  // only "gate custody refused", so three written files read as total loss and
  // the UI offered a Resume that would repeat the defect.
  {
    const { custodyRefusalReport } = await import('./lib/code-lane.mjs');
    const full = custodyRefusalReport({
      custodyError: 'gate custody refused: igniter ToolSearch query did not name Workflow',
      workflowRunId: 'wf_abc',
      worktree: '/home/u/.camus/worktrees/repo/camus-wt-task-1xorex',
      branch: 'camus/task',
      phase: 'implement',
    });
    assert.equal(full.status, 'infra_error', 'a custody refusal is still infrastructure, never a verdict');
    assert.match(full.note, /did not name Workflow/, 'the specific reason survives into the receipt');
    assert.match(full.note, /camus-wt-task-1xorex/, 'the note names the surviving worktree, so the work does not read as lost');
    assert.match(full.note, /branch camus\/task/, 'and the branch it is on');
    assert.match(full.note, /wf_abc/, 'and the bound run identity that was killed');
    assert.match(full.note, /nothing there was reverted/, 'it states plainly that the candidate survives');
    assert.match(full.note, /most likely repeat this refusal/, 'and warns that generic Resume repeats a custody defect');
    const bare = custodyRefusalReport({ custodyError: 'gate custody refused: x', repeatable: false });
    assert.match(bare.note, /nothing to resume in place/, 'with no bound run it says so instead of inventing one');
    assert.match(bare.note, /Resume is safe to retry/, 'a non-contract refusal does not scare the operator off retrying');
  }

  const authBeforeWorkflow = gateProcessClose({
    code: 0,
    authFailureNote: 'reauthenticate',
    custody: createGateCustodyGuard(expected),
  });
  assert.deepEqual(authBeforeWorkflow, { exitCode: -6, custodyError: null }, 'pre-workflow auth failure keeps its actionable diagnosis instead of becoming a custody symptom');

  const ordinaryNoWorkflow = gateProcessClose({ code: 0, authFailureNote: null, custody: createGateCustodyGuard(expected) });
  assert.equal(ordinaryNoWorkflow.exitCode, -5, 'ordinary prose/no-tool output remains a fail-closed custody error');
  assert.match(ordinaryNoWorkflow.custodyError, /without one fresh/, 'ordinary no-tool output still names the custody breach');

  const authenticatedWorkflow = createGateCustodyGuard(expected);
  authenticatedWorkflow.inspect(tool('Workflow', { name: 'camus-loop', args: JSON.stringify(expected) }));
  assert.deepEqual(
    gateProcessClose({ code: 0, authFailureNote: 'stale retry event', custody: authenticatedWorkflow }),
    { exitCode: 0, custodyError: null },
    'a workflow that actually started is not relabeled by an earlier retry event',
  );

  const authPlusViolation = createGateCustodyGuard(expected);
  authPlusViolation.inspect(tool('Bash', { command: 'git status' }));
  assert.equal(
    gateProcessClose({ code: 0, authFailureNote: 'reauthenticate', custody: authPlusViolation }).exitCode,
    -5,
    'a concrete custody violation outranks an authentication symptom',
  );
}

// --- gate: live link check (only when network is available) ------------------
if (process.env.TEST_NETWORK === '1') {
  const dead = GOOD + '\n3. Archive — https://github.com/Myosin-xyz/does-not-exist-archive\n';
  const res = await runVerify(dead.replace('[2]', '[2][3]').replace(/2\. Developer/, '2. Developer'), 'research_memo', {});
  const links = res.checks.find((c) => c.id === 'links');
  assert.equal(links.status, 'fail', 'dead link fails the gate');
}

// --- rehearsal honesty: no spend and no fabricated gate evidence ------------
{
  const previousMockSpeed = process.env.MOCK_SPEED;
  process.env.MOCK_SPEED = '0';
  const { createMockAdapters, runMockCodeLoop } = await import('./lib/adapters/mock.mjs');
  const adapters = createMockAdapters();
  const noop = () => {};
  const plan = await adapters.claude({ stage: 'plan', onTick: noop, onSession: noop });
  const draft = await adapters.claude({ stage: 'make', onTick: noop, onSession: noop });
  assert.equal(plan.costUsd, 0, 'rehearsal planning reports zero model spend');
  assert.equal(draft.costUsd, 0, 'rehearsal drafting reports zero model spend');

  const events = [];
  const result = await runMockCodeLoop(
    { goal: 'exercise the scripted build rehearsal', targetPath: '/tmp/real-looking-repository' },
    {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async () => 'Return an empty embedding set.',
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.report.simulated, true, 'gate report is explicitly simulated');
  assert.equal(result.report.branch, null, 'rehearsal invents no branch identifier');
  assert.equal(result.report.commit, null, 'rehearsal invents no commit identifier');
  assert.equal(result.report.report, null, 'rehearsal invents no gate receipt path');
  assert.ok(result.report.note.includes('local simulation trace'), 'report distinguishes the local trace from gate evidence');
  assert.equal(result.costUsd, 0, 'sealed rehearsal report records zero model spend');
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'done' && e.costUsd === 0), 'terminal rehearsal status keeps spend at zero');
  if (previousMockSpeed === undefined) delete process.env.MOCK_SPEED;
  else process.env.MOCK_SPEED = previousMockSpeed;
}

// --- evidence trail + honest receipt completeness ---------------------------
// The receipt must CARRY what was contested (findings, rounds, revisions,
// human decisions) and tell the truth about its own gaps.
{
  const { deriveEvidence, receiptCompleteness } = await import('./lib/evidence.mjs');

  const wordsEvents = [
    { type: 'plan', text: 'the plan' },
    { type: 'session', actor: 'maker', line: 'knowledge_search: cohort evidence' },
    { type: 'grounding_evidence', source: 'adapter_tool_result', results: [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] },
    { type: 'stage', name: 'ground', status: 'done', connected: true, queried: true, queries: 1, mode: 'claude' },
    { type: 'round', round: 1, cap: 3 },
    { type: 'finding', severity: 'high', title: 'no source', detail: 'd', suggestion: 's' },
    { type: 'revision', rev: 1, markdown: '# draft one' },
    { type: 'review', round: 1, rev: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'no source', detail: 'd', suggestion: 's' }] },
    { type: 'answer', kind: 'decision', question: 'q?', answer: 'a' },
    { type: 'revision', rev: 2, markdown: '# draft two, longer' },
    { type: 'review', round: 2, rev: 2, verdict: 'APPROVED', findings: [] },
    { type: 'verify_result', pass: true, warnings: 1, skipped: 0 },
  ];
  const wev = deriveEvidence(wordsEvents);
  assert.equal(wev.plan, 'the plan');
  assert.equal(wev.grounding.results[0].ref, 'chunk-1', 'bounded Hivemind result evidence survives in the receipt');
  assert.equal(wev.rounds.length, 2, 'both review rounds captured in the receipt');
  assert.equal(wev.rounds[0].findings[0].title, 'no source', 'findings ride their round — not dropped from the receipt');
  assert.equal(wev.findings.length, 1, 'flat findings list captured');
  assert.deepEqual(wev.revisions.map((r) => r.rev), [1, 2], 'the whole revision trail is on the receipt');
  assert.equal(wev.verify[0].pass, true, 'deterministic verify result captured');
  assert.equal(wev.humanDecisions[0].answer, 'a', 'the human decision is on the receipt');
  assert.equal(receiptCompleteness({ lane: 'research_memo', evidence: wev, writeFailed: false, status: 'done_with_findings' }).degraded, false, 'a full words receipt is not degraded');

  // Developer-role P0: a build ignition that produced no round and no gate
  // report must NOT claim a trustworthy receipt.
  const empty = deriveEvidence([{ type: 'log', line: 'Igniting the camus gate' }, { type: 'status', status: 'stopped' }]);
  assert.equal(empty.gateReport, null);
  assert.equal(empty.rounds.length, 0);
  const emptyC = receiptCompleteness({ lane: 'build', evidence: empty, writeFailed: false });
  assert.equal(emptyC.degraded, true, 'a gate ignition with no round and no report is degraded, not clean');
  assert.match(emptyC.note, /nothing here to verify/);
  const emptyWordsC = receiptCompleteness({ lane: 'research_memo', evidence: empty, writeFailed: false });
  assert.equal(emptyWordsC.degraded, true, 'a words run with no independent review round is also degraded');

  // A successful build receipt needs the structured independent verdict,
  // verification result, and bound commit — terminal prose alone is not proof.
  const incompleteDone = deriveEvidence([
    { type: 'round', round: 1, cap: 3 },
    { type: 'gate_report', report: { status: 'done', branch: 'x', commit_sha: 'c92d002521e09bab' } },
  ]);
  const incompleteDoneC = receiptCompleteness({ lane: 'build', evidence: incompleteDone, writeFailed: false });
  assert.equal(incompleteDoneC.degraded, true, 'done without the structured audit and verify evidence is degraded');
  assert.match(incompleteDoneC.note, /independent review verdict/);
  assert.match(incompleteDoneC.note, /green verification bound/);

  const good = deriveEvidence([
    { type: 'round', round: 1, cap: 3 },
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', confidence: 0.99, source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, warnings: null, skipped: null, source: 'gate_report_status', derived: true, commitSha: 'c92d002521e09bab' },
    { type: 'gate_report', report: { status: 'done', branch: 'x', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(good.rounds[0].rawVerdict, 'patch is correct', 'raw auditor semantics survive evidence derivation');
  assert.equal(good.verify[0].warnings, null, 'unknown verification counts survive as null');
  assert.equal(receiptCompleteness({ lane: 'build', evidence: good, writeFailed: false }).degraded, false, 'a fully bound build receipt is complete');

  // Completeness must agree with the sealed dimensions (audit found these): a
  // receipt cannot read complete while the dimensions say the audit broke or
  // verification never applied.
  const atu = deriveEvidence([
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', source: 'camus_gate_review', findings: [] },
    { type: 'review', round: 2, verdict: 'UNKNOWN', rawVerdict: null, source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, source: 'gate_report_status', commitSha: 'c92d002521e09bab' },
    { type: 'gate_report', report: { status: 'done', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(receiptCompleteness({ lane: 'build', evidence: atu, writeFailed: false }).degraded, true, 'APPROVED then UNKNOWN is a broken audit — the receipt is not complete');

  const wrongSha = deriveEvidence([
    { type: 'review', round: 1, verdict: 'APPROVED', rawVerdict: 'patch is correct', source: 'camus_gate_review', findings: [] },
    { type: 'verify_result', pass: true, source: 'gate_report_status', commitSha: 'deadbeef00000000' },
    { type: 'gate_report', report: { status: 'done', commit_sha: 'c92d002521e09bab' } },
  ]);
  assert.equal(receiptCompleteness({ lane: 'build', evidence: wrongSha, writeFailed: false }).degraded, true, 'a green bound to the wrong SHA never applied — the receipt is not complete');

  assert.equal(receiptCompleteness({ lane: 'research_memo', evidence: wev, writeFailed: true }).degraded, true, 'a receipt write failure always degrades');
}

// --- item #1: orthogonal status dimensions, derived from concrete evidence ---
// Dimensions come from evidence, never the flat status; the headline is derived
// (deriveHeadline), never sealed. Each guardrail contradiction is pinned here.
{
  const { deriveStatusDimensions, deriveHeadline } = await import('./lib/status-dims.mjs');
  const head = (d) => deriveHeadline({ execution: d.execution, verification: d.verification, audit: d.audit, publication: d.publication });
  const buildEv = (over) => ({ gateReport: { status: 'done', commit_sha: 'c92d002abc123' }, verify: [{ pass: true, commitSha: 'c92d002abc123', source: 'gate_report_status' }], rounds: [{ verdict: 'APPROVED', source: 'camus_gate_review' }], revisions: [], ...over });

  // The smoke's true state: green + independent-clean + bound SHA, branch NOT merged.
  const smoke = deriveStatusDimensions({ lane: 'build', status: 'done', published: false, evidence: buildEv() });
  assert.equal(smoke.publication, 'not_published', 'a committed-but-unmerged branch is NOT published');
  assert.equal(head(smoke), 'verified', 'green + independent-clean + bound SHA reads verified (but not published)');

  // done WITHOUT review evidence — audit is not_run, never inferred from `done`.
  const noReview = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [] }) });
  assert.equal(noReview.audit, 'not_run', 'done without a readable review is not an audit');
  assert.equal(head(noReview), 'unverified', 'a done build with no audit is unverified, not verified');

  // green verification on the WRONG commit verifies nothing here.
  const wrongCommit = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ verify: [{ pass: true, commitSha: 'deadbeef012', source: 'gate_report_status' }] }) });
  assert.equal(wrongCommit.verification, 'not_run', 'a green on the wrong commit is not verification of this work');
  assert.equal(head(wrongCommit), 'unverified');

  // an UNKNOWN (unreadable) review verdict is not an audit.
  const unreadable = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'UNKNOWN', source: 'camus_gate_review' }] }) });
  assert.equal(unreadable.audit, 'infra_failed', 'a review round that ran but produced an unreadable verdict is a broken audit, not an absent one');
  assert.equal(head(unreadable), 'unverified');

  // deterministic red under a clean review → a human settles it.
  const disagree = deriveStatusDimensions({ lane: 'build', status: 'verify_failed', evidence: buildEv({ gateReport: { status: 'verify_failed', commit_sha: 'c92d002abc123' }, verify: [{ pass: false, commitSha: 'c92d002abc123', source: 'gate_report_status' }] }) });
  assert.equal(head(disagree), 'needs_decision', 'tests red but reviewer clean → needs_decision');

  // published-but-unverified is a loud needs_decision, never a quiet pass.
  const pubUnverified = deriveStatusDimensions({ lane: 'build', status: 'done', published: true, evidence: buildEv({ verify: [], rounds: [] }) });
  assert.equal(head(pubUnverified), 'needs_decision', 'published-but-unverified never flattens to a pass');

  // words lane: no commit SHA — the deliverable itself is the artifact.
  const words = deriveStatusDimensions({ lane: 'research_memo', status: 'done', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }] } });
  assert.equal(words.verification, 'passed', 'words verification binds to the deliverable, not a SHA');
  assert.equal(head(words), 'verified');

  const wordsWithCaveat = deriveStatusDimensions({ lane: 'research_memo', status: 'done_with_findings', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1, findings: [{ severity: 'low', title: 'Source unavailable' }], claimAssessments: [{ marker: '[1]', decision: 'unchecked' }] }], revisions: [{ rev: 1 }] } });
  assert.equal(wordsWithCaveat.audit, 'independent_findings', 'APPROVED with a low/unchecked caveat is not flattened into a clean audit');
  assert.equal(head(wordsWithCaveat), 'verified_with_findings', 'caveats stay visible in the derived standing');

  const unclearContract = deriveStatusDimensions({ lane: 'research_memo', status: 'done_with_findings', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1, findings: [{ severity: 'low', title: 'Contract evidence unclear' }], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'unclear' }] }], revisions: [{ rev: 1 }] } });
  assert.equal(unclearContract.audit, 'independent_findings', 'unclear acceptance coverage is a visible audit caveat');
  assert.equal(head(unclearContract), 'verified_with_findings', 'unclear coverage never derives plain verified');

  const staleWordsAudit = deriveStatusDimensions({ lane: 'research_memo', status: 'done', evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }, { rev: 2 }] } });
  assert.equal(staleWordsAudit.audit, 'not_run', 'an audit of rev 1 never travels to a verify-fix that produced rev 2');
  assert.equal(head(staleWordsAudit), 'unverified', 'a final words artifact with only a stale audit cannot derive verified');

  // A REHEARSAL of the same shape can never impersonate that standing
  // (2026-07-14 P1: a mock receipt sealed audit:independent_clean → verified).
  // Scripted rounds stay in the receipt as events, execution and the words
  // lane's REAL deterministic verify stay recorded — but audit seals not_run.
  const rehearsal = deriveStatusDimensions({ lane: 'research_memo', status: 'done', simulated: true, evidence: { gateReport: null, verify: [{ pass: true }], rounds: [{ verdict: 'APPROVED', rev: 1 }], revisions: [{ rev: 1 }] } });
  assert.equal(rehearsal.audit, 'not_run', 'scripted APPROVED rounds seal audit not_run under simulation');
  assert.equal(rehearsal.verification, 'passed', 'the rehearsal deterministic verify is real and stays recorded');
  assert.equal(rehearsal.execution, 'completed', 'the rehearsal lifecycle stays honest');
  assert.notEqual(head(rehearsal), 'verified', 'a rehearsal never derives verified standing');

  // a genuine no-op ran to its conclusion: completed lifecycle, nothing
  // verified, nothing shipped — never a dead process, never a quiet green.
  const noop = deriveStatusDimensions({ lane: 'build', status: 'no_changes', evidence: buildEv({ verify: [], gateReport: { status: 'no_changes' } }) });
  assert.equal(noop.execution, 'completed', 'no_changes is a completed run, not a failed one');
  assert.equal(noop.verification, 'not_run', 'no_changes never claims a verification that did not run');

  // an interrupted run is unverified, whatever else is present.
  const stopped = deriveStatusDimensions({ lane: 'build', status: 'stopped', evidence: { gateReport: null, verify: [], rounds: [], revisions: [] } });
  assert.equal(stopped.execution, 'interrupted');
  assert.equal(head(stopped), 'unverified');

  // P1: only the LATEST applicable verdict counts, and only APPROVED|REVISE — a
  // bogus verdict is not a findings audit, and an unreadable latest round never
  // falls back to an older clean one.
  const banana = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'BANANA', source: 'camus_gate_review' }] }) });
  assert.equal(banana.audit, 'infra_failed', 'a bogus verdict is a broken audit, not independent_findings');
  assert.equal(head(banana), 'unverified', 'a malformed latest verdict cannot verify');
  const approvedThenUnknown = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ rounds: [{ verdict: 'APPROVED', source: 'camus_gate_review' }, { verdict: 'UNKNOWN', source: 'camus_gate_review' }] }) });
  assert.notEqual(approvedThenUnknown.audit, 'independent_clean', 'an unreadable latest round must not resurrect an older clean verdict');
  assert.equal(head(approvedThenUnknown), 'unverified', 'APPROVED then UNKNOWN is not verified');

  // P1: SHA binding is validated before a RED result is interpreted.
  const redWrongCommit = deriveStatusDimensions({ lane: 'build', status: 'verify_failed', evidence: buildEv({ gateReport: { status: 'verify_failed', commit_sha: 'c92d002abc123' }, verify: [{ pass: false, commitSha: 'deadbeef012', source: 'gate_report_status' }] }) });
  assert.equal(redWrongCommit.verification, 'not_run', 'a red on the wrong commit is not attributed to this artifact');
  assert.equal(head(redWrongCommit), 'unverified', 'a wrong-SHA red does not force needs_decision on this work');

  // P2: an inconclusive verification broke — infra_failed, not not_run.
  const inconclusive = deriveStatusDimensions({ lane: 'build', status: 'done', evidence: buildEv({ gateReport: { status: 'verify_inconclusive', commit_sha: 'c92d002abc123' }, verify: [{ pass: null, commitSha: 'c92d002abc123', source: 'gate_report_status' }] }) });
  assert.equal(inconclusive.verification, 'infra_failed', 'verify_inconclusive is a broken step, distinct from not_run');
  assert.equal(head(inconclusive), 'unverified');
}

// --- P1: the research lane executes the run-start SNAPSHOT, not live getModels
// The snapshot models are values NOT in checks/models.json, so if the adapters
// receive them the engine is honoring run.models — not re-resolving mid-run.
{
  const { runLoop } = await import('./lib/engine.mjs');
  const prev = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1'; // verify skips the network in this test
  const calls = [];
  const adapters = {
    maker: async ({ model }) => { calls.push({ role: 'maker', model }); return { ok: true, error: null, text: '## Notes\n\nA plain note with no claims.\n', costUsd: 0 }; },
    reviewer: async ({ model, effort }) => { calls.push({ role: 'reviewer', model, effort }); return { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: [], nonblocking: [], questions: [] }; },
  };
  const run = { goal: 'g', lane: 'freeform', ground: false, models: { maker: { model: 'SNAPSHOT-MAKER' }, reviewer: { model: 'SNAPSHOT-REVIEWER', effort: 'high' }, loop: { roundCap: 1 } } };
  const ctx = {
    emit: () => {}, waitForAnswer: async () => 'ok', adapters,
    hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ mode: 'stub' }) },
    signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
  };
  await runLoop(run, ctx);
  if (prev === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = prev;
  const maker = calls.find((c) => c.role === 'maker');
  const reviewer = calls.find((c) => c.role === 'reviewer');
  assert.equal(maker?.model, 'SNAPSHOT-MAKER', 'the maker adapter runs the snapshot model, not a live getModels()');
  assert.equal(reviewer?.model, 'SNAPSHOT-REVIEWER', 'the reviewer adapter runs the snapshot model');
  assert.equal(reviewer?.effort, 'high', 'the reviewer effort comes from the snapshot, not a live read');
}

// --- auth preflight: the tri-state probe parser never invents a green --------
// The launch chips consume the doctor's judgement; this parser IS that
// judgement, so its honesty is load-bearing: unknown stays unknown, and an
// explicit "Not logged in" (even printed with exit 0) must never match the
// "logged in" substring into a false green — the chip would reassure a user
// straight into a 401.
{
  const { parseAuthProbe, hivemindListingHasEndpoint, managedConnectorIsConnected, runDoctor } = await import('./lib/doctor.mjs');
  assert.equal(parseAuthProbe(null), null, 'probe could not run → unknown, never guessed');
  assert.equal(parseAuthProbe('Logged in as mateo@example.com'), true, 'claude prose sign-in parses');
  assert.equal(parseAuthProbe('{"loggedIn": true, "method": "oauth"}'), true, 'claude JSON sign-in parses');
  assert.equal(parseAuthProbe('Logged in using ChatGPT'), true, 'codex prose sign-in parses');
  assert.equal(parseAuthProbe('Not logged in'), false, 'an explicit negation is FALSE, never a substring false-green');
  assert.equal(parseAuthProbe('not logged in (run codex login)'), false, 'negation wins whatever the casing/suffix');
  assert.equal(parseAuthProbe('Logged out'), false, 'logged-out phrasing is false');
  assert.equal(parseAuthProbe('{"loggedIn": false}'), false, 'JSON signed-out parses false');
  // Only EXPLICIT claims decide: anything else stays unknown — an implicit
  // false would be as invented as an implicit green (2026-07-14 review).
  assert.equal(parseAuthProbe('some unrelated banner text'), null, 'output with no explicit claim stays unknown');
  assert.equal(parseAuthProbe(''), null, 'empty output claims nothing');
  const stagingUrl = 'https://staging-hivemind.myosin.xyz/api/mcp';
  assert.equal(
    hivemindListingHasEndpoint(`claude.ai Hivemind Staging: ${stagingUrl} - Connected`, stagingUrl),
    true,
    'managed Hivemind Staging is recognized by exact endpoint, not a required local alias',
  );
  assert.equal(hivemindListingHasEndpoint('hivemind: https://wrong.example/api/mcp - Connected', stagingUrl), false, 'a matching display name at the wrong endpoint is refused');
  assert.equal(managedConnectorIsConnected('claude.ai Hivemind Staging:\n  Status: ✔ Connected'), true, 'targeted managed connector probe recognizes connected');
  assert.equal(managedConnectorIsConnected('claude.ai Hivemind Staging:\n  Status: ✘ Needs authentication'), false, 'targeted managed connector probe refuses signed-out');

  // Live P1 (2026-07-14): BOTH installed CLIs deliver their signed-out answer
  // with EXIT CODE 1 (claude: {"loggedIn": false,…}; codex: "Not logged in").
  // The probe used to discard nonzero-exit output, collapsing the real
  // signed-out state into "unknown" with ok:true and no fix — the red
  // preflight could never fire. Fake CLIs on PATH reproduce the exact shapes.
  {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const bin = mkdtempSync(join(tmpdir(), 'cls-fakebin-'));
    const fake = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    fake('claude', `case "$1" in --version) echo "1.0.0-fake"; exit 0 ;; auth) echo '{"loggedIn": false, "method": null}'; exit 1 ;; *) exit 1 ;; esac`);
    fake('codex', `case "$1" in --version) echo "0.0.0-fake"; exit 0 ;; login) echo "Not logged in"; exit 1 ;; *) exit 1 ;; esac`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const report = await runDoctor({});
      const claude = report.checks.find((c) => c.id === 'claude');
      const codex = report.checks.find((c) => c.id === 'codex');
      assert.equal(claude.auth, false, 'claude {"loggedIn": false} on exit 1 is a REAL signed-out, not unknown');
      assert.equal(claude.ok, false, 'a signed-out claude fails its check');
      assert.match(claude.fix ?? '', /sign-in|sign in/i, 'the fix names the sign-in flow');
      assert.equal(codex.auth, false, 'codex "Not logged in" on exit 1 is a REAL signed-out, not unknown');
      assert.equal(codex.ok, false, 'a signed-out codex fails its check');
      assert.equal(report.ok, false, 'a signed-out CLI fails the doctor report');
    } finally {
      process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    }
  }
}

// --- Studio evidence pack: explicit contract, identity split, honest spend --
{
  const { buildEvidencePack, shortEvidenceId } = await import('./lib/evidence-pack.mjs');
  const { buildAuditReplayPack, createAuditReplayExperiment, finalizeAuditReplayExperiment, knowledgeSnapshotId } = await import('./lib/audit-replay.mjs');
  const { seal } = await import('../../packages/trust/lib/canonical.mjs');
  const { validateEvidencePack, validateExperimentRecord } = await import('../../packages/trust/lib/validate.mjs');
  const base = {
    goal: 'Decide whether community or paid should lead the quarter.',
    acceptanceContract: 'Every material claim traces to a live URL and the recommendation states its tradeoffs.',
    lane: 'research_memo',
    deliverable: '# Memo\n\nUse community first.\n',
    evidence: {
      rounds: [{
        rev: 1,
        verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'high', findings: [],
        claimAssessments: [],
        coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The memo traces its material claim and states its recommendation.' }],
      }],
      revisions: [{ rev: 1, chars: 29 }],
      verify: [{ pass: true, checks: [{ id: 'links', status: 'pass', detail: '4 URLs checked' }] }],
      humanDecisions: [{ kind: 'decision', question: 'Which market?', answer: 'Base', at: 42 }],
      grounding: { mode: 'claude', connected: true, queried: true, queryCount: 1, queries: ['cohort evidence'], results: [{ query: 'cohort evidence', title: 'Cohort playbook', author: 'A. Expert', ref: 'chunk-1', score: 0.8, excerpt: 'Programs should sell progress, not content.' }] },
      gateReport: null,
    },
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    models: { maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'high' } },
    createdAt: 100,
  };
  const pack = buildEvidencePack(base);
  assert.equal(validateEvidencePack(pack).ok, true, 'Studio output validates as the published evidence-pack schema');
  // The single semantically-destructive flip: the producer emits envelope 3 with
  // its bound pairing v2 + status v2 interiors, asserted DIRECTLY on the returned
  // object (never via a text grep, which cannot tell a producer emission from a
  // frozen golden constant).
  assert.equal(pack.schemaVersion, 3, 'structured acceptance coverage ships as evidence-pack v3, never as an in-place v2 mutation');
  assert.equal(pack.pairing.schemaVersion, 2, 'envelope 3 carries a pairing-manifest v2 interior');
  assert.equal(pack.statuses.schemaVersion, 2, 'envelope 3 carries a status v2 interior');
  assert.equal(pack.acceptance_contract, base.acceptanceContract, 'contract is explicit, never aliased from goal');
  assert.deepEqual(pack.artifact.contract_coverage.map((c) => [c.id, c.decision]), [['C1', 'met']], 'the final-revision coverage decision seals into the pack');
  // The seats are seatIdentitySealed records now: requested/resolved name the
  // seat DECISION (backend-prefixed for a built-in), actual the OBSERVED provider.
  assert.equal(pack.pairing.executor.requested, 'claude:sonnet', 'the built-in maker decision names its backend');
  assert.equal(pack.pairing.executor.actual, 'anthropic:sonnet', 'pinned maker is recorded, provider-qualified');
  assert.equal(pack.pairing.executor.training_org, 'anthropic', 'the sealed maker carries its registry training org');
  assert.equal(pack.pairing.executor.model_family, 'claude', 'the sealed maker carries its model family');
  assert.equal(pack.pairing.executor.lineage.source, 'registry', 'the built-in maker lineage is registry-attested');
  assert.equal(pack.pairing.executor.origin_confidence, 'verified_operator', 'a registry lineage earns verified_operator');
  assert.ok(pack.pairing.executor.qualification.fingerprint.startsWith('builtin1:'), 'the vendor-managed built-in maker seals a builtin1 qualification');
  assert.equal(pack.pairing.auditor.requested, 'codex:gpt-5.4', 'the built-in auditor decision names its backend');
  assert.equal(pack.pairing.auditor.actual, 'openai:gpt-5.4', 'auditor actual comes from the ran review');
  assert.equal(pack.pairing.auditor.training_org, 'openai', 'the sealed auditor carries its registry training org');
  assert.ok(pack.pairing.auditor.qualification.fingerprint.startsWith('builtin1:'), 'the vendor-managed built-in auditor seals a builtin1 qualification');
  assert.equal(pack.pairing.review_scope, null, 'a words-lane audit runs under no gate-scoped review');
  assert.equal(pack.pairing.independence, 'cross_vendor', 'different training organizations earn cross-vendor standing');
  assert.equal(pack.economics.find((e) => e.role === 'auditor').effort, 'high', 'actual reviewer effort survives');
  assert.equal(pack.economics.every((e) => e.billing_mode === 'unknown' && e.estimated_cost_usd === null), true, 'billing and dollars stay unknown/null');
  assert.deepEqual(pack.verification.checks, [{ id: 'links', status: 'pass', detail: '4 URLs checked' }], 'deterministic checks survive');
  assert.equal(pack.human_decisions[0].at, 42, 'decision time survives into the ledger');
  assert.ok(pack.session_log.includes('hivemind query: cohort evidence'), 'grounding tool evidence is custody-bound in the sealed pack');
  assert.ok(pack.session_log.some((line) => line.includes('hivemind result: Cohort playbook — A. Expert') && line.includes('excerpt_hash=sha256:')), 'result metadata and content hash are custody-bound');
  assert.ok(pack.session_log.some((line) => line.startsWith('coverage assessment C1: met; evidence_hash=sha256:')), 'coverage rationale is custody-bound by hash');
  assert.equal(shortEvidenceId(pack.artifact_id).length, 12, 'the UI uses a short display ID while the pack keeps the full hash');
  assert.ok(!('headline' in pack), 'derived standing never persists in the pack');

  const changedContract = buildEvidencePack({ ...base, acceptanceContract: 'A materially different acceptance contract.' });
  assert.notEqual(changedContract.artifact_id, pack.artifact_id, 'changing the contract expires the artifact audit');
  const changedJudgment = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'independent_findings' } });
  assert.equal(changedJudgment.artifact_id, pack.artifact_id, 'changing judgment does not pretend the artifact changed');
  assert.notEqual(changedJudgment.receipt_id, pack.receipt_id, 'changing judgment mints a new receipt');
  const changedGrounding = buildEvidencePack({ ...base, evidence: { ...base.evidence, grounding: { ...base.evidence.grounding, queries: ['different query'] } } });
  assert.equal(changedGrounding.artifact_id, pack.artifact_id, 'runtime query evidence is receipt identity, not artifact identity');
  assert.notEqual(changedGrounding.receipt_id, pack.receipt_id, 'changing the grounding trail mints a new receipt');

  const coverageMet = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'independent_findings' } });
  const coverageUnmet = buildEvidencePack({
    ...base,
    statuses: { ...base.statuses, audit: 'independent_findings' },
    evidence: {
      ...base.evidence,
      rounds: [{
        ...base.evidence.rounds[0],
        coverageAssessments: [{ criterion_id: 'C1', decision: 'unmet', evidence: 'The memo omits the required tradeoff analysis.' }],
      }],
    },
  });
  assert.equal(coverageUnmet.artifact_id, coverageMet.artifact_id, 'coverage judgment changes do not pretend the artifact changed');
  assert.notEqual(coverageUnmet.receipt_id, coverageMet.receipt_id, 'coverage judgment changes mint a new receipt');

  const citedBase = {
    ...base,
    deliverable: `# Recommendation

Retention improved after onboarding changed [1].
Members asked for practical milestones [H1].

## Sources
1. Cohort report — https://example.com/cohorts
[H1] Member interviews — Research team
`,
    evidence: {
      ...base.evidence,
      revisions: [{ rev: 1, chars: 220 }],
      rounds: [{
        rev: 1,
        verdict: 'REVISE',
        reviewerModel: 'gpt-5.4',
        reviewerEffort: 'high',
        findings: [{ severity: 'low', title: 'A separate caveat remains.' }],
        claimAssessments: [
          { marker: '[1]', decision: 'supported', evidence: 'The report explicitly attributes the retention change to onboarding.' },
          { marker: '[H1]', decision: 'supported', evidence: 'The captured interview excerpt asks for practical milestones.' },
        ],
      }],
      grounding: {
        ...base.evidence.grounding,
        results: [{ ...base.evidence.grounding.results[0], retrievedAt: 88, excerpt: 'Members asked for practical milestones.' }],
      },
    },
    statuses: { ...base.statuses, audit: 'independent_findings' },
  };
  const cited = buildEvidencePack(citedBase);
  assert.equal(validateEvidencePack(cited).ok, true, 'a claim-bearing Studio pack validates');
  assert.deepEqual(cited.artifact.claims.map((c) => [c.marker, c.decision]), [['[1]', 'supported'], ['[H1]', 'supported']], 'the final-revision auditor decisions seal into the ledger');
  assert.equal(cited.artifact.claims[0].url, 'https://example.com/cohorts', 'public claims bind their exact source URL');
  assert.equal(cited.artifact.claims[0].evidence_hash, null, 'URL reachability alone is not captured support');
  assert.match(cited.artifact.claims[1].evidence_hash, /^sha256:[0-9a-f]{64}$/, 'Hivemind claims bind captured excerpt content');
  assert.equal(cited.artifact.claims[1].retrieved_at, 88, 'Hivemind claims bind evidence freshness');
  assert.equal(cited.session_log.filter((line) => line.startsWith('claim assessment ')).length, 2, 'assessment rationales are custody-bound by hash in the receipt');

  const changedAssessment = buildEvidencePack({
    ...citedBase,
    evidence: {
      ...citedBase.evidence,
      rounds: [{
        ...citedBase.evidence.rounds[0],
        claimAssessments: [
          { marker: '[1]', decision: 'unsupported', evidence: 'The report discusses activation, not retention.' },
          citedBase.evidence.rounds[0].claimAssessments[1],
        ],
      }],
    },
  });
  assert.equal(changedAssessment.artifact_id, cited.artifact_id, 'changing the auditor judgment does not pretend the artifact changed');
  assert.notEqual(changedAssessment.receipt_id, cited.receipt_id, 'changing the claim judgment mints a new receipt');

  // Threshold decisions seal into the receipt exactly like claim/coverage ones:
  // a laundering catch (policy → observed) is a judgment change, so it mints a
  // new receipt without pretending the immutable artifact changed. The bound
  // assessment carries the line it judged so the receipt records WHAT T1 refers to.
  const boundThreshold = (decision) => [{ id: 'T1', decision, evidence: `${decision} rationale`, section: 'Decision Rule', line: '- Proposed threshold (…): proceed if retention exceeds 40%.', stats: ['40%'] }];
  const thresholdBase = {
    ...citedBase,
    evidence: { ...citedBase.evidence, rounds: [{ ...citedBase.evidence.rounds[0], thresholdAssessments: boundThreshold('policy') }] },
  };
  const withThreshold = buildEvidencePack(thresholdBase);
  const thresholdLine = withThreshold.session_log.find((line) => line.startsWith('threshold assessment '));
  assert.ok(thresholdLine, 'threshold decisions seal into the receipt');
  assert.match(thresholdLine, /threshold assessment T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}/, 'the entry binds the exempted line AND the rationale by hash');
  const laundered = buildEvidencePack({
    ...thresholdBase,
    evidence: { ...thresholdBase.evidence, rounds: [{ ...thresholdBase.evidence.rounds[0], thresholdAssessments: boundThreshold('observed') }] },
  });
  assert.equal(laundered.artifact_id, withThreshold.artifact_id, 'a threshold verdict change does not pretend the artifact changed');
  assert.notEqual(laundered.receipt_id, withThreshold.receipt_id, 'changing the threshold judgment mints a new receipt');
  // Same decision, different exempted line → different receipt: the binding is real.
  const otherLine = buildEvidencePack({
    ...thresholdBase,
    evidence: { ...thresholdBase.evidence, rounds: [{ ...thresholdBase.evidence.rounds[0], thresholdAssessments: [{ ...boundThreshold('policy')[0], line: '- Proposed threshold (…): proceed if CAC falls below $50.', stats: ['$50'] }] }] },
  });
  assert.notEqual(otherLine.receipt_id, withThreshold.receipt_id, 'binding a policy verdict to a different line mints a different receipt');

  const citedRehearsal = buildEvidencePack({ ...citedBase, simulated: true, statuses: { ...citedBase.statuses, audit: 'not_run' } });
  assert.equal(citedRehearsal.artifact.claims.every((c) => c.decision === 'unchecked'), true, 'scripted rehearsal assessments never become evidence');
  assert.equal(citedRehearsal.artifact.contract_coverage.every((c) => c.decision === 'unclear'), true, 'scripted rehearsal coverage never becomes evidence');

  const rehearsal = buildEvidencePack({ ...base, simulated: true, statuses: { ...base.statuses, audit: 'not_run' } });
  assert.equal(rehearsal.pairing.executor.actual, 'simulation:scripted-maker');
  assert.equal(rehearsal.pairing.auditor.actual, 'simulation:scripted-auditor');
  assert.equal(rehearsal.pairing.independence, 'none', 'scripted rehearsal never claims independence');
  assert.equal(rehearsal.artifact.contract_coverage.every((c) => c.decision === 'unclear'), true, 'rehearsal contract coverage stays explicitly unclear');

  const buildPack = buildEvidencePack({
    ...base,
    lane: 'build',
    targetPath: '/tmp/demo-repo',
    deliverable: null,
    evidence: {
      rounds: [{ verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', findings: [] }],
      verify: [{ pass: true, commitSha: 'c92d002abc123', source: 'gate_report_status' }],
      humanDecisions: [],
      gateReport: { status: 'done', commit_sha: 'c92d002abc123', initialModel: 'sonnet', finalFixModel: 'opus' },
    },
  });
  assert.equal(validateEvidencePack(buildPack).ok, true, 'developer-role output validates as the same protocol pack');
  assert.equal(buildPack.schemaVersion, 2, 'a build gate without Slice-F scope/contract binding stays on frozen envelope 2');
  assert.equal(buildPack.pairing.schemaVersion, 1);
  assert.equal(buildPack.statuses.schemaVersion, 1);
  assert.ok(buildPack.session_log.some((line) => line.startsWith('compatibility envelope v2:')), 'the sealed receipt discloses why it did not grade itself up');
  assert.deepEqual(buildPack.artifact, { kind: 'code', repo: '/tmp/demo-repo', head: 'c92d002abc123', diff_hash: null, changed_files: null, deliverable_hash: null, claims: null, contract_coverage: null }, 'the build artifact is bound to the gate-branch head without inventing structured coverage the gate does not emit yet');
  assert.equal(buildPack.pairing.executor.requested, 'anthropic:sonnet', 'the frozen v1 pairing preserves its provider-prefixed identity semantics');
  assert.equal(buildPack.pairing.executor.actual, 'anthropic:opus', 'the gate-reported final model records escalation honestly');
  assert.equal(buildPack.pairing.auditor.actual, 'openai:gpt-5.4', 'the code auditor actual is sealed');
  assert.match(buildPack.verification.checks[0].detail, /c92d002abc123/, 'build verification stays bound to the audited commit');
  assert.ok(buildPack.session_log.includes('executor initial model: anthropic:sonnet') && buildPack.session_log.includes('executor final model: anthropic:opus'), 'initial and final executor identities remain visible');

  const catalog = { reviewer: ['gpt-5.4', 'gpt-5.6-sol'], reviewerSource: 'codex_cache' };
  const experiment = createAuditReplayExperiment({
    sourceRunId: 'source-run',
    sourcePack: pack,
    sourceEvidence: base.evidence,
    sourceDeliverable: base.deliverable,
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    catalog,
    createdAt: 200,
  });
  assert.equal(validateExperimentRecord(experiment).ok, true, 'audit replay freezes a valid experiment manifest before execution');
  assert.throws(() => createAuditReplayExperiment({
    sourceRunId: 'source-run',
    sourcePack: pack,
    sourceEvidence: base.evidence,
    sourceDeliverable: '# Tampered memo\n',
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    catalog,
    createdAt: 200,
  }), /does not match the sealed artifact/, 'a changed report deliverable cannot ride the source artifact identity into a replay');
  assert.match(knowledgeSnapshotId(base.evidence), /^sha256:[0-9a-f]{64}$/, 'private grounding is represented by a local snapshot hash, not copied into the manifest');
  assert.deepEqual(experiment.manifest.reviewer, { requested: 'openai:gpt-5.6-sol', resolved: 'openai:gpt-5.6-sol' }, 'requested and resolved reviewer are frozen once with no fallback');

  const replayReview = {
    ran: true,
    verdict: 'APPROVED',
    findings: [],
    questions: [],
    reviewerModel: 'gpt-5.6-sol',
    reviewerEffort: 'xhigh',
    claimAssessments: [],
    coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'The exact memo satisfies the criterion.' }],
    thresholdAssessments: [{ id: 'T1', decision: 'policy', evidence: 'A forward-looking rule, not a measurement.', section: 'Decision Rule', line: '- Proposed threshold (…): 40%.', stats: ['40%'] }],
    usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 120 },
    durationMs: 4200,
  };
  const replayPack = buildAuditReplayPack({
    sourcePack: pack,
    review: replayReview,
    reviewerModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    experimentId: experiment.experiment_id,
    createdAt: 201,
  });
  assert.equal(validateEvidencePack(replayPack).ok, true, 'audit-only replay seals as a normal evidence pack');
  assert.equal(replayPack.artifact_id, pack.artifact_id, 'audit-only replay preserves the exact source artifact identity');
  assert.notEqual(replayPack.receipt_id, pack.receipt_id, 'a new auditor/configuration mints a new receipt');
  assert.equal(replayPack.pairing.auditor.actual, 'openai:gpt-5.6-sol', 'the actual pinned replay reviewer survives');
  assert.equal(replayPack.economics.find((item) => item.role === 'auditor').effort, null, 'requested effort is not promoted into an actual when the runtime does not report one');
  assert.ok(replayPack.session_log.includes(`audit replay experiment: ${experiment.experiment_id}`), 'the receipt binds the frozen experiment manifest');
  assert.ok(replayPack.session_log.some((line) => /^audit replay threshold T1: policy; line_hash=sha256:[0-9a-f]{64}; evidence_hash=sha256:[0-9a-f]{64}$/.test(line)), 'the replay receipt seals the threshold decision bound to its line');

  const legacySource = seal({
    schemaVersion: 2,
    goal: pack.goal,
    acceptance_contract: pack.acceptance_contract,
    artifact: structuredClone(pack.artifact),
    verification: structuredClone(pack.verification),
    session_log: ['legacy envelope-2 source'],
    pairing: {
      schemaVersion: 1,
      executor: { requested: 'anthropic:sonnet', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
      auditor: { requested: 'openai:gpt-5.4', resolved: 'openai:gpt-5.4', actual: 'openai:gpt-5.4' },
      independence: 'cross_vendor',
    },
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    human_decisions: [],
    economics: structuredClone(pack.economics),
    created_at: 99,
  });
  assert.equal(validateEvidencePack(legacySource).ok, true, 'the explicit legacy source fixture is a valid frozen envelope 2');
  const legacyExperiment = createAuditReplayExperiment({
    sourceRunId: 'legacy-source-run', sourcePack: legacySource, sourceEvidence: base.evidence,
    sourceDeliverable: base.deliverable, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh', catalog, createdAt: 204,
  });
  const legacyReplay = buildAuditReplayPack({
    sourcePack: legacySource, review: replayReview, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh',
    experimentId: legacyExperiment.experiment_id, createdAt: 205,
  });
  assert.equal(legacyReplay.schemaVersion, 2, 'an envelope-2 source still seals an envelope-2 replay');
  assert.equal(legacyReplay.pairing.schemaVersion, 1);
  assert.equal(legacyReplay.statuses.schemaVersion, 1);
  assert.equal(legacyReplay.artifact_id, legacySource.artifact_id);

  const finalExperiment = finalizeAuditReplayExperiment(experiment, { pack: replayPack, review: replayReview });
  assert.equal(validateExperimentRecord(finalExperiment).ok, true, 'the completed arm validates');
  assert.equal(finalExperiment.outcome.artifact_id, pack.artifact_id, 'experiment outcome keeps the source artifact');
  assert.equal(finalExperiment.outcome.receipt_id, replayPack.receipt_id, 'experiment outcome points at the new receipt');
  assert.deepEqual(finalExperiment.outcome.judge_overlap, { arm_provider: 'anthropic', judge_provider: 'openai', same_vendor: false, same_family: false }, 'judge-to-arm vendor/family overlap is explicit');
  assert.equal(finalExperiment.manifest.effort.requested, 'xhigh', 'requested effort is frozen in the manifest');
  assert.equal(finalExperiment.outcome.effort_actual, null, 'actual effort stays unknown when Codex reports usage but not applied reasoning budget');
  assert.deepEqual(finalExperiment.outcome.usage, { input_tokens: 900, cached_input_tokens: 300, output_tokens: 120, duration_ms: 4200 }, 'actual usage observations survive');

  const replayRehearsal = buildAuditReplayPack({ ...({ sourcePack: pack, review: replayReview, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh', experimentId: experiment.experiment_id, createdAt: 202 }), simulated: true });
  assert.equal(replayRehearsal.artifact_id, pack.artifact_id, 'rehearsal re-audit still preserves the artifact');
  assert.equal(replayRehearsal.statuses.audit, 'not_run', 'scripted replay never earns audit standing');
  assert.equal(replayRehearsal.artifact.contract_coverage.every((criterion) => criterion.decision === 'unclear'), true, 'scripted replay coverage stays unclear');
  assert.equal(replayRehearsal.session_log.some((line) => line.startsWith('audit replay threshold ')), false, 'scripted replay never seals a threshold decision as evidence');

  const failedReview = { ran: false, error: 'model disappeared', verdict: 'ERROR', findings: [], questions: [], claimAssessments: [], coverageAssessments: [], durationMs: 50, usage: null };
  const failedPack = buildAuditReplayPack({ sourcePack: pack, review: failedReview, reviewerModel: 'gpt-5.6-sol', effort: 'xhigh', experimentId: experiment.experiment_id, createdAt: 203 });
  const failedExperiment = finalizeAuditReplayExperiment(experiment, { pack: failedPack, review: failedReview });
  assert.equal(validateExperimentRecord(failedExperiment).ok, true, 'a vanished reviewer remains a valid failed arm instead of disappearing');
  assert.equal(failedExperiment.outcome.status, 'infra_failed');
  assert.equal(failedPack.statuses.audit, 'infra_failed', 'a failed audit is sealed as infra, never not_run or clean');

  const {
    createParallelExperiment,
    finalizeParallelExperiment,
    knowledgeSnapshotMatches,
    markParallelArmRunning,
    outcomeFromArmReport,
    sealKnowledgeSnapshot,
  } = await import('./lib/comparison.mjs');
  const snapshot = sealKnowledgeSnapshot({
    query: base.goal,
    mode: 'hivemind_claude',
    items: [{ query: base.goal, title: 'Frozen evidence', author: 'Researcher', ref: 'k-1', score: 0.8, excerpt: 'Concrete milestones outperform broad promises.' }],
    retriever: { requested: 'anthropic:sonnet', resolved: 'anthropic:sonnet', actual: 'anthropic:sonnet' },
    capturedAt: 300,
  });
  assert.equal(knowledgeSnapshotMatches(snapshot), true, 'the local knowledge payload is content-addressed');
  assert.equal(knowledgeSnapshotMatches({ ...snapshot, items: [{ ...snapshot.items[0], excerpt: 'tampered' }] }), false, 'a changed knowledge payload expires the snapshot');
  const parallel = createParallelExperiment({
    goal: base.goal,
    acceptanceContract: base.acceptanceContract,
    lane: 'research_memo',
    depth: 'quick',
    roundCap: 3,
    snapshot,
    makerModels: ['sonnet', 'opus'],
    reviewerModel: 'gpt-5.4',
    reviewerEffort: 'high',
    catalog: { maker: ['haiku', 'sonnet', 'opus'], reviewer: ['gpt-5.4'], reviewerSource: 'codex_cache' },
    createdAt: 300,
  });
  assert.equal(validateExperimentRecord(parallel).ok, true, 'parallel manifest validates before either executor runs');
  const runningParallel = markParallelArmRunning(parallel, 'arm-1', 'run-arm-1');
  assert.equal(runningParallel.outcome.arms[0].status, 'running', 'arm lifecycle is visible before completion');
  const goodOutcome = outcomeFromArmReport({
    experiment: runningParallel,
    armId: 'arm-1',
    runId: 'run-arm-1',
    report: {
      status: 'done',
      simulated: false,
      evidencePack: pack,
      makerActualModels: ['anthropic:sonnet'],
      makerUsage: [{ stage: 'make', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80 }, duration_ms: 2000 }],
    },
  });
  assert.equal(goodOutcome.status, 'completed', 'an independently clean, deterministic-green arm passes the quality floor');
  assert.deepEqual(goodOutcome.usage, { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80, duration_ms: 2000 }, 'executor usage is the common observed cost signal');
  const advisoryPack = buildEvidencePack({ ...base, statuses: { ...base.statuses, audit: 'advisory_clean' } });
  const advisoryOutcome = outcomeFromArmReport({
    experiment: runningParallel,
    armId: 'arm-1',
    runId: 'run-advisory',
    report: { status: 'done', simulated: false, evidencePack: advisoryPack, makerActualModels: ['anthropic:sonnet'], makerUsage: [] },
  });
  assert.equal(advisoryOutcome.status, 'quality_floor_failed', 'same-vendor advisory review is retained but never clears the comparison quality floor');
  const failedOutcome = outcomeFromArmReport({ experiment: runningParallel, armId: 'arm-2', runId: 'run-arm-2', report: { status: 'failed', error: 'model unavailable', evidencePack: null } });
  assert.equal(failedOutcome.status, 'infra_failed', 'a failed executor remains a first-class arm');
  const finalParallel = finalizeParallelExperiment(runningParallel, [goodOutcome, failedOutcome]);
  assert.equal(validateExperimentRecord(finalParallel).ok, true, JSON.stringify(validateExperimentRecord(finalParallel)));
  assert.deepEqual(finalParallel.outcome.arms.map((arm) => arm.status), ['completed', 'infra_failed'], 'finalization never drops the failed arm');
}

// --- banner policy: every real done* answers to the headline, fail-closed ----
// The pure mapping the UI renders from (public/banner.mjs). Two receipts bit
// us here: a legacy done with NO dimensions bypassed the old guard and kept
// "reviewed and verified" (P1 — several real runs/ receipts have that shape),
// and done + verified_with_findings hid its caveats behind the flat copy (P2).
{
  const { comparisonBanner, doneBanner } = await import('./public/banner.mjs');
  const verifiedLabel = 'DONE. Reviewed and verified.';

  // Missing evidence fails CLOSED — the legacy-receipt shape, both flat statuses.
  const legacy = doneBanner('done', undefined, undefined);
  assert.equal(legacy.cls, 'meh', 'legacy done (no dimensions) is never a green banner');
  assert.match(legacy.label, /gate claim/, 'legacy done renders as a claim, not a verdict');
  assert.match(legacy.label, /no status dimensions/, 'the reason names the missing evidence');
  assert.ok(!/reviewed and verified/i.test(legacy.label), 'legacy done never reads reviewed-and-verified');
  assert.match(doneBanner('done_with_findings', undefined, undefined).label, /^DONE WITH FINDINGS \(gate claim\)/, 'the downgrade names the exact claimed status');

  // A headline is presentation, never evidence: a recognized headline WITHOUT
  // the dimensions it claims to derive from (tampered/torn replay — no honest
  // server emits it) must not unlock any standing (2026-07-14 review, P2).
  for (const h of ['verified', 'verified_with_findings', 'same_vendor_reviewed', 'published']) {
    const tampered = doneBanner('done', h, undefined);
    assert.equal(tampered.cls, 'meh', `headline ${h} without dimensions never greens`);
    assert.match(tampered.label, /gate claim/, `headline ${h} without dimensions renders as a claim`);
  }

  // Each recognized standing owns its copy.
  assert.deepEqual(doneBanner('done', 'verified', { verification: 'passed', audit: 'independent_clean' }), { cls: 'good', label: verifiedLabel }, 'verified reads reviewed-and-verified');
  const vwf = doneBanner('done', 'verified_with_findings', { verification: 'passed', audit: 'independent_findings' });
  assert.equal(vwf.cls, 'good', 'verified_with_findings is still a green standing');
  assert.match(vwf.label, /findings or caveats/, 'the caveats ride the banner itself');
  assert.notEqual(vwf.label, verifiedLabel, 'done + verified_with_findings never hides its caveats behind the plain verified copy');
  const advisory = doneBanner('done', 'same_vendor_reviewed', { verification: 'passed', audit: 'advisory_clean' });
  assert.equal(advisory.cls, 'meh');
  assert.match(advisory.label, /Same-vendor reviewed/, 'advisory standing is named');
  assert.ok(!/reviewed and verified/i.test(advisory.label), 'advisory never claims verified standing');
  assert.match(doneBanner('done', 'published', { verification: 'passed', audit: 'independent_clean' }).label, /published/, 'published standing is named');

  // Anything else — unverified, needs_decision, a headline this UI does not
  // know — is an uncorroborated claim naming the dimensions when present.
  const unv = doneBanner('done', 'unverified', { verification: 'not_run', audit: 'independent_clean' });
  assert.equal(unv.cls, 'meh');
  assert.match(unv.label, /verification not run/, 'the downgrade names the verification dimension');
  assert.match(unv.label, /audit independent clean/, 'the downgrade names the audit dimension');
  assert.match(doneBanner('done', 'BANANA', { verification: 'passed', audit: 'independent_clean' }).label, /gate claim/, 'an unknown headline is a claim, never trusted');

  assert.match(comparisonBanner('done', true).label, /REHEARSAL COMPLETE/, 'a completed comparison rehearsal says complete');
  assert.match(comparisonBanner('failed', true).label, /REHEARSAL FAILED/, 'a recovered infra failure never wears rehearsal-complete copy');
  assert.match(comparisonBanner('failed', true).label, /no models or retrieval were rerun/, 'recovery copy names the no-rerun guarantee');
  assert.equal(comparisonBanner('failed', false).cls, 'bad', 'a live failed comparison is visibly red');
}

// --- model catalog: the picker only offers what codex itself lists -----------
// codex marks internal models `visibility: 'hide'` (e.g. codex-auto-review).
// Surfacing one would let a run decision be made that the normal codex UI
// withholds, so the catalog filters to listable slugs only.
{
  const { reviewerSlugsFromCache } = await import('./lib/models.mjs');
  const cache = { models: [
    { slug: 'gpt-5.4', visibility: 'list' },
    { slug: 'gpt-5.4-mini', visibility: 'list' },
    { slug: 'gpt-5.4-mini', visibility: 'list' },
    { slug: 'codex-auto-review', visibility: 'hide' },
    { slug: 'no-visibility-field' },
    { visibility: 'list' },
  ] };
  const slugs = reviewerSlugsFromCache(cache);
  assert.deepEqual(slugs, ['gpt-5.4', 'gpt-5.4-mini'], 'only unique listable slugs are offered');
  assert.ok(!slugs.includes('codex-auto-review'), 'a hidden internal model is never offered in the picker');
  assert.deepEqual(reviewerSlugsFromCache(null), [], 'no cache → no slugs');
  assert.deepEqual(reviewerSlugsFromCache({ models: 'nope' }), [], 'a malformed cache → no slugs');

  // The hole the review found: a hidden model set as the CURRENT reviewer (via
  // CODEX_MODEL) was unshifted back into the picker. It must stay unavailable.
  // Pinned to a cache FIXTURE: the machine's real cache is live-rewritten by
  // every codex app-server (ChatGPT app, IDE extensions) and the hidden flag
  // on codex-auto-review flaps between writes, so an assertion against the
  // real file races those writers.
  const { modelCatalog } = await import('./lib/models.mjs');
  const { writeFileSync: writeCache, mkdtempSync: mkCacheTmp, rmSync: rmCacheTmp } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const cacheTmp = mkCacheTmp(joinPath(osTmp(), 'cls-cache-'));
  const cacheFile = joinPath(cacheTmp, 'models_cache.json');
  writeCache(cacheFile, JSON.stringify({ models: [
    { slug: 'gpt-5.4', visibility: 'list' },
    { slug: 'gpt-5.4-mini', visibility: 'list' },
    { slug: 'codex-auto-review', visibility: 'hide' },
  ] }));
  const prevEnv = process.env.CODEX_MODEL;
  const prevCache = process.env.STUDIO_CODEX_CACHE_FILE;
  process.env.CODEX_MODEL = 'codex-auto-review';
  process.env.STUDIO_CODEX_CACHE_FILE = cacheFile;
  const cat = modelCatalog();
  assert.equal(cat.reviewerSource, 'codex_cache', 'the pinned fixture cache is in force');
  assert.ok(!cat.reviewer.includes('codex-auto-review'), 'a hidden model set as the current reviewer is NOT made selectable');
  assert.equal(cat.reviewerCurrentAvailable, false, 'the hidden current reviewer is reported unavailable');
  if (prevEnv === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = prevEnv;
  if (prevCache === undefined) delete process.env.STUDIO_CODEX_CACHE_FILE; else process.env.STUDIO_CODEX_CACHE_FILE = prevCache;
  rmCacheTmp(cacheTmp, { recursive: true, force: true });
}

// --- the rehearsal's final deliverable must not launder sources --------------
// A demo that ends on a laundered green would show Camus blessing the exact thing
// it exists to catch. These are the DETERMINISTIC guarantees (no uncited stat, no
// compliance failure, every citation resolves, required structure). The gate
// CANNOT judge claim-to-source entailment — that was verified by hand against the
// live pages (see mock.mjs), and is guarded here two ways: the memo must LABEL
// its strategic recommendation as an inference rather than pass it off as
// sourced, and its Sources must be exactly the hand-verified set, so any source
// change re-triggers manual entailment review.
{
  process.env.MOCK_SPEED = '0'; // no real sleeps in the test
  const { createMockAdapters } = await import('./lib/adapters/mock.mjs');
  const a = createMockAdapters();
  const ac = new AbortController();
  const call = (stage) => a.claude({ stage, signal: ac.signal, onTick() {}, onSession() {} });
  await call('make'); // REV1
  await call('fix');  // REV2
  await call('fix');  // REV3
  const finalRev = (await call('fix')).text; // REV4 — the approved, verified deliverable
  assert.equal(findUnsourcedStats(finalRev).length, 0, 'final deliverable: no uncited statistic');
  assert.equal(findComplianceHits(finalRev).filter((h) => h.severity === 'fail').length, 0, 'final deliverable: no compliance failure');
  const gate = await runVerify(finalRev, 'research_memo', { skipNetwork: true });
  assert.equal(gate.checks.find((c) => c.id === 'citations').status, 'pass', 'final deliverable: every citation resolves to a source');
  assert.equal(gate.checks.find((c) => c.id === 'stats').status, 'pass', 'final deliverable: passes stats-must-cite');
  assert.equal(gate.checks.find((c) => c.id === 'structure').status, 'pass', 'final deliverable: required sections present');
  // The strategic recommendation is LABELLED an inference, not passed off as sourced.
  assert.match(finalRev, /inference \(not a sourced fact\)/i, 'final deliverable labels its strategic recommendation an inference');
  assert.match(finalRev, /hypothesis to test|test against the client|test this against/i, 'final deliverable calls for validation against client data');
  // Sources are EXACTLY the hand-verified set — a change here must re-trigger entailment review.
  for (const url of [
    'wikipedia.org/wiki/Digital_marketing',
    'wikipedia.org/wiki/Customer_retention',
    'wikipedia.org/wiki/Network_effect',
    'wikipedia.org/wiki/Word-of-mouth_marketing',
    'wikipedia.org/wiki/Customer_acquisition_cost',
  ]) assert.ok(finalRev.includes(url), `final deliverable cites the verified source ${url}`);
  assert.ok(!finalRev.includes('does-not-exist-archive'), 'final deliverable carries no dead placeholder source');
  // The FIRST draft is where the plantable problems live — the loop catches them.
  const rev1 = (await createMockAdapters().claude({ stage: 'make', signal: ac.signal, onTick() {}, onSession() {} })).text;
  assert.ok(findUnsourcedStats(rev1).length > 0 || findComplianceHits(rev1).some((h) => h.severity === 'fail'), 'the rehearsal FIRST draft plants a real problem for the reviewer to catch');
}

// --- compliance wordlist describes itself honestly (no crypto vertical) ------
{
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('./checks/compliance.json', import.meta.url), 'utf8'));
  assert.ok(!/web3|crypto|token|airdrop|presale|onchain/i.test(cfg.description), 'the compliance wordlist describes itself generally, not as a crypto vertical');
  assert.ok(cfg.patterns.some((p) => p.label === 'Guaranteed returns claim' && p.severity === 'fail'), 'the general promissory-returns rule survives the generalization');
}

// --- contract-coverage ledger: deterministic criteria, auditor decides --------
// The next Compare & Learn primitive. Extraction must be a pure function of the
// contract (the same contract → the same criteria across arms, or coverage is not
// comparable); the auditor supplies met|unmet|unclear, defaulting to unclear.
{
  const { extractContractCriteria, applyCoverageAssessments, buildCoverageLedger } = await import('./lib/contract.mjs');
  const { reviewPrompt } = await import('./lib/prompts.mjs');

  const prose = 'Every material claim traces to a live source; the recommendation states assumptions and tradeoffs; no invented Hivemind evidence.';
  const c = extractContractCriteria(prose);
  assert.equal(c.length, 3, 'semicolon/sentence clauses split into criteria');
  assert.deepEqual(c.map((x) => x.id), ['C1', 'C2', 'C3'], 'ids are stable and ordered');
  assert.match(c[0].text, /traces to a live source/, 'the first clause is captured');
  assert.ok(!/[;.]$/.test(c[0].text), 'trailing punctuation is trimmed');
  // Comparability: identical contract text yields byte-identical criteria.
  assert.deepEqual(extractContractCriteria(prose), extractContractCriteria(prose), 'same contract → same criteria');
  const coveragePrompt = reviewPrompt({ goal: 'g', acceptanceContract: prose, lane: 'research_memo', draft: 'd', round: 1, priorFindings: [], answers: [], criteria: c });
  for (const criterion of c) assert.ok(coveragePrompt.includes(`- ${criterion.id} ${criterion.text}`), `review prompt carries the exact ${criterion.id} criterion`);
  assert.match(coveragePrompt, /"coverage_assessments"/, 'review output contract requires structured coverage assessments');

  const bullets = extractContractCriteria('- claims cite live sources\n- assumptions are stated\n- no fabricated evidence');
  assert.equal(bullets.length, 3, 'a bulleted contract splits per item');
  assert.deepEqual(bullets.map((x) => x.id), ['C1', 'C2', 'C3']);

  assert.deepEqual(extractContractCriteria(''), [], 'empty contract → no criteria');
  assert.deepEqual(extractContractCriteria('   '), [], 'whitespace-only contract → no criteria');
  assert.deepEqual(extractContractCriteria('Everything must be perfect.'), [{ id: 'C1', text: 'Everything must be perfect' }], 'a one-clause contract is one criterion');

  // Auditor decisions apply by id; absent/invalid default to unclear, never met.
  const ledger = buildCoverageLedger('A live source backs every claim; assumptions are stated.', {
    assessments: [{ criterion_id: 'C1', decision: 'met' }, { criterion_id: 'C2', decision: 'bogus' }],
  });
  assert.equal(ledger.find((x) => x.id === 'C1').decision, 'met', 'a valid met decision applies');
  assert.equal(ledger.find((x) => x.id === 'C2').decision, 'unclear', 'an invalid decision defaults to unclear');
  assert.ok(applyCoverageAssessments(c, []).every((x) => x.decision === 'unclear'), 'no assessments → every criterion unclear (never silently satisfied)');
  assert.equal(buildCoverageLedger('One rule: cite everything.', { assessments: [{ criterion_id: 'C1', decision: 'unmet' }] }).find((x) => x.id === 'C1').decision, 'unmet', 'a genuine miss is recorded as unmet');
}

// --- doctor: skills are reported, including symlinked installs ---------------
// Marketplace/plugin installs SYMLINK skills into ~/.claude/skills, and
// Dirent.isDirectory() is false for a symlink — that silently hid 23 of 26 real
// skills on the first pass. Report-only: the loop cannot invoke these yet.
{
  const { listSkills } = await import('./lib/doctor.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'skills-home-'));
  const store = mkdtempSync(join(tmpdir(), 'skills-store-'));
  const cwd = mkdtempSync(join(tmpdir(), 'skills-proj-'));
  mkdirSync(join(cwd, '.git'));
  const skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const write = (dir, name, front) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\nbody\n`);
  };
  write(skillsDir, 'plain', 'name: plain\ndescription: An inline description.');
  write(skillsDir, 'blocky', 'name: blocky\ndescription: |\n  A block scalar description.');
  write(store, 'linked', 'name: linked\ndescription: Installed via symlink.');
  symlinkSync(join(store, 'linked'), join(skillsDir, 'linked'));
  mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true }); // no SKILL.md

  const found = listSkills({ home, cwd });
  assert.deepEqual(found.map((s) => s.name), ['blocky', 'linked', 'plain'], 'symlinked skills are reported alongside real directories, sorted');
  assert.equal(found.find((s) => s.name === 'linked').description, 'Installed via symlink.', 'a symlinked skill resolves its metadata');
  assert.equal(found.find((s) => s.name === 'blocky').description, 'A block scalar description.', 'a YAML block scalar description is read, not captured as "|"');
  assert.ok(!found.some((s) => s.name === 'not-a-skill'), 'a directory without SKILL.md is not a skill');

  // Project skills shadow user skills of the same name, matching Claude Code.
  const projSkills = join(cwd, '.claude', 'skills');
  mkdirSync(projSkills, { recursive: true });
  write(projSkills, 'plain', 'name: plain\ndescription: Project override.');
  const shadowed = listSkills({ home, cwd });
  assert.equal(shadowed.filter((s) => s.name === 'plain').length, 1, 'a shadowed skill is not listed twice');
  assert.equal(shadowed.find((s) => s.name === 'plain').scope, 'project', 'the project copy wins');

  const nested = join(cwd, 'apps', 'studio');
  mkdirSync(nested, { recursive: true });
  assert.equal(listSkills({ home, cwd: nested }).find((s) => s.name === 'plain')?.scope, 'project', 'a server started below the git root still sees project skills');

  assert.deepEqual(listSkills({ home: mkdtempSync(join(tmpdir(), 'skills-empty-')), cwd: mkdtempSync(join(tmpdir(), 'skills-empty2-')) }), [], 'a machine with no skills reports none, never an error');

  for (const dir of [home, store, cwd]) rmSync(dir, { recursive: true, force: true });
}

// --- run story: derived from the receipt, fails closed, never inflates -------
// The story card is the most persuasive surface in the app, so its rules are
// pinned here the same way the done banner's are.
{
  const { runStory, STORY_BEATS } = await import('./public/story.mjs');

  const base = {
    goal: 'Decide the quarter.',
    ground: true,
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published' },
    evidencePack: {
      receipt_id: 'sha256:' + 'a'.repeat(64),
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published' },
      pairing: { executor: { actual: 'anthropic:claude-sonnet-4-6' }, auditor: { actual: 'openai:gpt-5.6-sol' } },
    },
    evidence: {
      grounding: { mode: 'hivemind_claude', queried: true, frozen: true, results: [{}, {}, {}] },
      revisions: [{ rev: 1 }, { rev: 2 }],
      // The SAME finding re-raised across rounds is one issue, not three.
      rounds: [
        { round: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'Citations are misbound' }, { severity: 'medium', title: 'Recommendation outruns evidence' }] },
        { round: 2, verdict: 'REVISE', findings: [{ severity: 'high', title: 'Citations Are Misbound!' }] },
        { round: 3, verdict: 'APPROVED', findings: [{ severity: 'low', title: 'A nit' }] },
      ],
      verify: [{ pass: true }],
      humanDecisions: [{ kind: 'stuck', answer: 'One more round' }, { kind: 'stuck', answer: 'Accept result (with findings on record)' }],
    },
  };

  const told = runStory(base, 'verified_with_findings');
  const prose = told.sentences.join(' ');
  assert.equal(told.degraded, false, 'a corroborated receipt tells its story');
  assert.equal(told.headline, 'Verified with findings');
  assert.match(prose, /three Hivemind items were captured and frozen before drafting/i, 'the frozen evidence count comes from captured results');
  const oneCaptured = runStory({
    ...base,
    evidence: {
      ...base.evidence,
      grounding: { ...base.evidence.grounding, results: [{}] },
    },
  }, 'verified_with_findings');
  assert.match(oneCaptured.sentences.join(' '), /one Hivemind item was captured and frozen before drafting/i, 'a single frozen item uses singular grammar');
  assert.match(prose, /two distinct blocking findings/i, 'repeats of one finding are counted once, never inflated to three');
  assert.match(prose, /re-raising what was not fixed/i, 'a genuinely repeated title may be described as re-raised');
  assert.match(prose, /from a different vendor/, 'independent audit standing is stated');
  assert.match(prose, /authorised one further round/i, 'the human decision is reported from the recorded answer');
  assert.match(prose, /accepted findings on the record/i, 'acceptance is reported without inventing that every remaining finding was accepted');
  assert.match(prose, /Nothing was published\./, 'publication standing is stated');
  assert.ok(told.sentences.every((s) => /^[A-Z]/.test(s)), 'every sentence is capitalised, including ones that open with a number word');
  assert.deepEqual(told.timeline.map((b) => b.beat), STORY_BEATS, 'all seven beats are present in order');
  assert.ok(told.timeline.every((b) => b.state === 'done'), 'a complete run lights every beat');

  // Fail closed: no dimensions means the receipt cannot corroborate any claim.
  const noDims = runStory({ goal: 'g', evidence: {} }, 'verified');
  assert.equal(noDims.degraded, true, 'a receipt without dimensions cannot tell its story');
  assert.match(noDims.sentences[0], /no status dimensions/i, 'it names why, instead of going quiet');
  assert.deepEqual(noDims.timeline.map((b) => b.beat), STORY_BEATS, 'the timeline still renders, as unknowns');

  // An unrecognised standing must not be narrated as if it were understood.
  const strange = runStory(base, 'gold_star');
  assert.equal(strange.degraded, true, 'an unknown standing degrades');
  assert.match(strange.sentences.at(-1), /does not recognise/i, 'and says so');

  // Same-vendor review may never read as independent.
  const advisory = {
    ...base,
    statuses: { ...base.statuses, audit: 'advisory_findings' },
    evidencePack: { ...base.evidencePack, statuses: { ...base.statuses, audit: 'advisory_findings' }, pairing: { executor: { actual: 'anthropic:claude-sonnet-4-6' }, auditor: { actual: 'anthropic:claude-opus-4-6' } } },
  };
  const advisoryProse = runStory(advisory, 'same_vendor_reviewed').sentences.join(' ');
  assert.ok(!/from a different vendor/.test(advisoryProse), 'a same-vendor audit never claims independence');
  assert.match(advisoryProse, /shared the maker’s vendor/, 'it names the limitation explicitly');
  assert.equal(runStory(advisory, 'same_vendor_reviewed').timeline.find((b) => b.beat === 'Independent challenge').state, 'skipped', 'same-vendor review never lights the independent-challenge beat');

  // Multiple rounds alone do not prove that a finding was re-raised.
  const freshEachRound = {
    ...base,
    evidence: {
      ...base.evidence,
      rounds: [
        { round: 1, verdict: 'REVISE', findings: [{ severity: 'high', title: 'First issue' }] },
        { round: 2, verdict: 'REVISE', findings: [{ severity: 'medium', title: 'Different issue' }] },
      ],
    },
  };
  assert.ok(!/re-raising/.test(runStory(freshEachRound, 'verified_with_findings').sentences.join(' ')), 'different findings across rounds are not called repeats');

  // Audit-only replay must narrate the replay, not inherited maker work and
  // deterministic checks as if they ran again.
  const replay = {
    ...base,
    lane: 'audit_replay',
    sourceRunId: 'source-run',
    ground: false,
    evidence: {
      grounding: null,
      revisions: [{ rev: 2 }], // copied sealed artifact, not a replay draft
      rounds: [{ round: 'audit replay', verdict: 'APPROVED', findings: [] }],
      verify: [],
      humanDecisions: [],
    },
    evidencePack: {
      ...base.evidencePack,
      statuses: { ...base.statuses, audit: 'independent_clean' },
    },
  };
  const replayStory = runStory(replay, 'verified_with_findings');
  const replayProse = replayStory.sentences.join(' ');
  assert.match(replayProse, /replay ran no retrieval or drafting/i, 'replay names the work it deliberately did not repeat');
  assert.ok(!/Claude drafted/.test(replayProse), 'copied revisions never masquerade as replay maker work');
  assert.match(replayProse, /source artifact carried deterministic checks that passed with caveats; this replay did not rerun them/i, 'inherited verification is attributed to the source artifact');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Evidence frozen').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Draft').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Verification').state, 'skipped');
  assert.equal(replayStory.timeline.find((b) => b.beat === 'Independent challenge').state, 'done');

  // A failed verification is never softened into a pass.
  const failed = runStory({ ...base, statuses: { ...base.statuses, verification: 'failed' }, evidencePack: { ...base.evidencePack, statuses: { ...base.statuses, verification: 'failed' } } }, 'unverified');
  assert.match(failed.sentences.join(' '), /did not pass, so nothing here is verified/, 'a red verification is stated plainly');
  assert.equal(failed.timeline.find((b) => b.beat === 'Verification').state, 'failed', 'the beat shows failed, not done');

  // An ungrounded run says so rather than implying private evidence.
  const ungrounded = runStory({ ...base, ground: false, evidence: { ...base.evidence, grounding: null } }, 'verified_with_findings');
  assert.match(ungrounded.sentences.join(' '), /did not retrieve a private knowledge snapshot/, 'an ungrounded run is explicit without inventing open-web use');
  assert.equal(ungrounded.timeline.find((b) => b.beat === 'Evidence frozen').state, 'skipped', 'the beat is skipped, not falsely done');

  // Rehearsal is a first-class non-trust standing, never an unknown headline
  // and never an independent audit just because scripted rounds exist.
  const rehearsal = {
    ...base,
    engine: 'mock',
    simulated: true,
    statuses: { ...base.statuses, audit: 'not_run' },
    evidencePack: {
      ...base.evidencePack,
      statuses: { ...base.statuses, audit: 'not_run' },
      pairing: { executor: { actual: 'simulation:scripted-maker' }, auditor: { actual: 'simulation:scripted-reviewer' } },
    },
  };
  const rehearsalStory = runStory(rehearsal, 'rehearsal');
  assert.equal(rehearsalStory.degraded, false, 'rehearsal is recognised without promoting it');
  assert.equal(rehearsalStory.headline, 'Rehearsal');
  assert.match(rehearsalStory.sentences.join(' '), /no real model audit ran and it cannot earn verified standing/i);
  assert.equal(rehearsalStory.timeline.find((b) => b.beat === 'Independent challenge').state, 'skipped');
}

// --- one standing vocabulary, and the derivation behind it ------------------
// The run bar, Recents and the story card all read standings from story.mjs, so
// a receipt can never be worded three ways. An unrecognised standing has no
// label on purpose — callers must fail closed instead of printing a raw token.
{
  const { effectiveStanding, standingLabel, standingPill, standingExplanation } = await import('./public/story.mjs');

  assert.equal(standingLabel('verified_with_findings'), 'Verified with findings');
  assert.equal(standingLabel('same_vendor_reviewed'), 'Reviewed by the same vendor');
  assert.equal(standingLabel('gold_star'), null, 'an unrecognised standing has no label, so callers fail closed');
  assert.equal(standingLabel(undefined), null, 'a missing standing has no label');
  assert.equal(effectiveStanding(undefined, true), 'rehearsal', 'a legacy mock event cannot lose its rehearsal standing merely because it predates headline decoration');
  assert.equal(effectiveStanding('verified', true), 'rehearsal', 'the sealed simulation fact outranks any trust-like presentation headline');
  assert.equal(effectiveStanding('verified', false), 'verified', 'real runs keep the receipt-derived standing');
  assert.deepEqual(standingPill('done_with_findings', 'unverified'), {
    label: 'Not verified', className: 'standing danger', derived: true, claim: false,
  }, 'the receipt-backed label also owns its danger styling; it cannot inherit the gate claim’s success colour');
  assert.deepEqual(standingPill('running', undefined), {
    label: 'running', className: 'status running', derived: false, claim: false,
  }, 'a live operational state is honest without a terminal standing and is never mislabeled as an uncorroborated claim');
  assert.deepEqual(standingPill('done', undefined), {
    label: 'done', className: 'status done claim', derived: false, claim: true,
  }, 'a terminal gate claim without receipt standing stays visible but explicitly claim-styled');
  assert.equal(standingPill('done', 'rehearsal').className, 'standing rehearsal', 'a rehearsal has its own non-trust tone');

  const dims = (over = {}) => ({ schemaVersion: 1, execution: 'completed', verification: 'passed_with_caveats', audit: 'independent_findings', publication: 'not_published', ...over });

  const agreed = standingExplanation({ status: 'done_with_findings', statuses: dims() }, 'verified_with_findings');
  assert.equal(agreed.disagrees, false, 'a corroborated gate claim does not read as a conflict');
  assert.equal(agreed.standing, 'Verified with findings');
  assert.equal(agreed.gateClaim, 'done_with_findings', 'the loop’s own claim stays visible beside the standing');
  assert.equal(agreed.lines.length, 4, 'all four dimensions are explained');
  assert.match(agreed.lines.join(' '), /different vendor/, 'independent audit is named as such');

  // The case the trust layer exists for: the loop claims success, the receipt does not.
  const conflict = standingExplanation({ status: 'done', statuses: dims({ verification: 'failed', audit: 'not_run' }) }, 'unverified');
  assert.equal(conflict.disagrees, true, 'a success claim over a receipt that does not support it IS a conflict');
  assert.match(conflict.lines.join(' '), /did not pass/, 'the failing dimension is stated plainly');
  assert.match(conflict.lines.join(' '), /No independent review ran/, 'the missing audit is stated plainly');

  // Advisory standing is not a success, so a done claim over it still conflicts.
  assert.equal(standingExplanation({ status: 'done', statuses: dims({ audit: 'advisory_clean' }) }, 'same_vendor_reviewed').disagrees, true,
    'same-vendor review never satisfies a done claim');

  // A non-success claim over a non-success standing is agreement, not conflict.
  assert.equal(standingExplanation({ status: 'verify_failed', statuses: dims({ verification: 'failed' }) }, 'unverified').disagrees, false,
    'an honest red claim matching an unverified standing is not a conflict');

  assert.equal(standingExplanation({ status: 'verify_failed', statuses: dims() }, 'verified_with_findings').disagrees, true,
    'disagreement is detected in the other direction too: a red gate claim cannot silently wear a green standing');

  assert.equal(standingExplanation({
    status: 'done_with_findings',
    statuses: dims({ verification: 'passed', audit: 'independent_clean' }),
  }, 'verified').disagrees, true,
  'a clean derived standing cannot silently erase the gate’s narrower claim that findings remained');

  assert.equal(standingExplanation({ status: 'done', statuses: dims() }, 'verified_with_findings').disagrees, false,
    'plain done does not claim a caveat-free receipt, so recorded findings remain compatible');

  assert.equal(standingExplanation({ status: 'done', simulated: true, statuses: dims({ audit: 'not_run' }) }, 'rehearsal').disagrees, false,
    'a successfully completed rehearsal is not a contradiction; completion and non-evidence are orthogonal');

  // Unknown schema fails closed rather than explaining a standing it cannot derive.
  const legacy = standingExplanation({ status: 'done', statuses: { schemaVersion: 99, execution: 'completed' } }, 'verified');
  assert.equal(legacy.lines.length, 1, 'an unrecognised schema explains nothing');
  assert.match(legacy.lines[0], /cannot be derived from evidence/, 'and says why');

  // An unrecognised dimension VALUE is named, never silently dropped.
  const odd = standingExplanation({ status: 'done', statuses: dims({ audit: 'banana' }) }, 'verified');
  assert.match(odd.lines.join(' '), /does not recognise/, 'an unknown dimension value is surfaced');
  assert.equal(odd.lines.length, 4, 'and still occupies its slot');
}

// --- Recents grouping: the artifact hash is the ONLY grouping authority ------
{
  const { groupRuns, armFacts, comparisonNote, shortHash } = await import('./public/grouping.mjs');
  const A = 'sha256:' + 'a'.repeat(64);
  const B = 'sha256:' + 'b'.repeat(64);
  const replay = (id, artifactId, over = {}) => ({ id, lane: 'audit_replay', artifactId, status: 'done', headline: 'verified', startedAt: 100, goal: 'g', ...over });

  // Two replays of ONE artifact become a single comparison; a lone one does not.
  const grouped = groupRuns([replay('r1', A, { effortRequested: 'high', startedAt: 200 }), replay('r2', A, { effortRequested: 'low', startedAt: 100 }), replay('solo', B)]);
  assert.deepEqual(grouped.map((e) => e.kind), ['audit_comparison', 'run'], 'a pair groups; a single replay stays an ordinary row');
  assert.deepEqual(grouped[0].arms.map((a) => a.effortRequested), ['low', 'high'], 'arms read weakest to strongest requested effort, not by finish time');
  assert.equal(grouped[0].artifactId, A);
  assert.equal(grouped[0].arms.length, 2);

  // Similar goals, adjacent timestamps and matching models must NEVER group.
  const lookalikes = groupRuns([
    replay('x', A, { goal: 'same goal', startedAt: 500 }),
    replay('y', B, { goal: 'same goal', startedAt: 500 }),
  ]);
  assert.deepEqual(lookalikes.map((e) => e.kind), ['run', 'run'], 'identical goals and timestamps over DIFFERENT artifacts never group');

  // Non-replays and malformed hashes are never folded in.
  assert.deepEqual(groupRuns([
    replay('a', A), replay('b', A),
    { id: 'normal', lane: 'research_memo', artifactId: A, status: 'done', startedAt: 1 },
  ]).map((e) => e.kind), ['audit_comparison', 'run'], 'a normal run sharing the artifact is not an audit arm');
  assert.deepEqual(groupRuns([replay('m1', 'not-a-hash'), replay('m2', 'not-a-hash')]).map((e) => e.kind), ['run', 'run'], 'a malformed artifact id never becomes a grouping key');
  assert.deepEqual(groupRuns([replay('n1', null), replay('n2', null)]).map((e) => e.kind), ['run', 'run'], 'a missing artifact id never groups');

  // Failed and incomplete arms are RETAINED — a comparison is a record, not a highlight reel.
  const withFailure = groupRuns([replay('ok', A, { effortRequested: 'low' }), replay('bad', A, { effortRequested: 'high', status: 'failed', headline: 'unverified' })]);
  assert.equal(withFailure[0].arms.length, 2, 'a failed arm stays in the comparison');
  assert.ok(withFailure[0].arms.some((a) => a.status === 'failed'), 'and keeps its real status');

  // Unreported facts read as unreported — never zero, never inferred.
  const sparse = armFacts({ effortRequested: 'high' });
  assert.equal(sparse.effortActual, 'not reported', 'unapplied-effort is never invented from the request');
  assert.equal(sparse.outputTokens, null, 'missing tokens are null, not 0');
  assert.equal(sparse.durationSeconds, null, 'missing duration is null, not 0');
  assert.equal(sparse.findings, null, 'missing finding count is null, not 0');
  assert.equal(sparse.receipt, null, 'a missing receipt hash is null');
  const full = armFacts({ effortRequested: 'low', effortActual: 'low', auditorActual: 'openai:gpt-5.6-sol', outputTokens: 777, durationMs: 26040, findingCount: 0, receiptId: A });
  assert.equal(full.durationSeconds, 26, 'duration renders in seconds');
  assert.equal(full.findings, 0, 'a real zero findings is preserved, distinct from unrecorded');
  assert.equal(full.receipt, 'a'.repeat(12), 'the receipt hash is shortened for display');
  assert.equal(full.auditorActual, 'openai:gpt-5.6-sol');
  assert.equal(armFacts({ outputTokens: -1, durationMs: 1.5, findingCount: -2 }).outputTokens, null, 'invalid usage never renders as receipt fact');
  assert.equal(shortHash('nope'), null, 'a malformed hash has no short form');

  const matchedNote = comparisonNote([
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'low' },
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'high' },
  ]);
  assert.match(matchedNote, /assigned the same sealed artifact/, 'failed or incomplete attempts are never narrated as if they completed an audit');
  assert.match(matchedNote, /recorded auditor matches.*requested effort differs/i, 'an effort comparison is described only when the recorded auditor also matches');
  assert.doesNotMatch(matchedNote, /cost/i, 'tokens and time are usage, never silently promoted into economic cost');
  assert.match(comparisonNote([
    { auditorActual: 'openai:gpt-5.6-sol', effortRequested: 'low' },
    { auditorActual: 'openai:gpt-5.4', effortRequested: 'high' },
  ]), /not an effort-only comparison/i, 'same artifact with different auditors is grouped but named as confounded');
  assert.match(comparisonNote([{ effortRequested: 'low' }, { effortRequested: 'high' }]), /not proven to be an effort-only comparison/i, 'missing auditor identity fails closed');
}

// A source-free freeform deliverable warns rather than fails, and says why in
// terms of what freeform actually promises. The wrong explanation told an
// announcement that "a researched deliverable must cite live sources", and the
// tempting wrong fix is to promote the warn to a pass so the demo looks tidier.
// Both halves are asserted: the status AND the sentence.
{
  const NO_LINKS = `## Summary
Myosin Learns is a live session. A person decides when the evidence is enough.
`;

  const freeform = await runVerify(NO_LINKS, 'freeform', { skipNetwork: true });
  const ffLinks = freeform.checks.find((c) => c.id === 'links');
  assert.equal(ffLinks.status, 'warn', 'freeform with no URLs warns, and is never promoted to pass');
  assert.match(ffLinks.detail, /external source checking did not apply/i,
    'the freeform warning explains itself as a freeform run, not as a researched deliverable');
  assert.doesNotMatch(ffLinks.detail, /researched deliverable must cite/i,
    'freeform is not told the research lane\'s rule');

  const memo = await runVerify(NO_LINKS, 'research_memo', { skipNetwork: true });
  const memoLinks = memo.checks.find((c) => c.id === 'links');
  assert.equal(memoLinks.status, 'fail', 'a research memo with no sources still fails');
  assert.match(memoLinks.detail, /researched deliverable must cite/i,
    'the research lane keeps its own explanation');
}

// ============================================================================
// Multi-model seats (docs/MULTI-MODEL-SEATS.md)
// ============================================================================

// --- models v2: the backend-aware decision record -----------------------------
{
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getModels, seatCatalog, seatOffered, listBackends, groundingNeedsClaudeMaker, modelCatalog } = await import('./lib/models.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'cls-models-'));
  const file = join(tmp, 'models.json');
  const prevFile = process.env.STUDIO_MODELS_FILE;
  const prevClaudeModel = process.env.CLAUDE_MODEL;
  const prevCodexModel = process.env.CODEX_MODEL;
  const prevCodexEffort = process.env.CODEX_EFFORT;
  delete process.env.CLAUDE_MODEL;
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_EFFORT;
  process.env.STUDIO_MODELS_FILE = file;
  const writeModels = (obj) => writeFileSync(file, JSON.stringify(obj, null, 2));
  const KIMI = { kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'CLS_TEST_KIMI_KEY', models: ['kimi-k2'], why: 'test entry' };
  try {
    // A legacy file (no backend fields) still means claude-writes / codex-reviews.
    writeModels({ maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' }, loop: { roundCap: 3 } });
    let m = getModels();
    assert.equal(m.maker.backend, 'claude', 'legacy maker resolves to the claude backend');
    assert.equal(m.maker.provider, 'anthropic', 'legacy maker carries its historical provider');
    assert.equal(m.reviewer.backend, 'codex', 'legacy reviewer resolves to the codex backend');
    assert.equal(m.reviewer.provider, 'openai');
    assert.equal(m.reviewer.effort, 'low', 'codex honors the effort request');

    // A v2 file with an opt-in compat backend in the maker seat.
    writeModels({
      maker: { backend: 'kimi', model: 'kimi-k2' },
      reviewer: { backend: 'claude', model: 'sonnet', effort: 'high' },
      backends: { kimi: KIMI },
      loop: { roundCap: 2 },
    });
    m = getModels();
    assert.equal(m.maker.provider, 'moonshot', 'compat maker carries its DECLARED provider');
    assert.equal(m.reviewer.provider, 'anthropic', 'claude reviewer carries anthropic');
    assert.equal(m.reviewer.effort, null, 'a backend without the effort knob records null, never a fabricated tier');
    assert.equal(m.reviewer.effortSource, 'not honored by this backend');

    // Env overrides are CLI-shaped: they must NOT redirect a non-matching backend.
    process.env.CLAUDE_MODEL = 'opus';
    process.env.CODEX_MODEL = 'gpt-5.5';
    m = getModels();
    assert.equal(m.maker.model, 'kimi-k2', 'CLAUDE_MODEL is ignored when the maker seat is not the claude backend');
    assert.equal(m.reviewer.model, 'sonnet', 'CODEX_MODEL is ignored when the reviewer seat is not the codex backend');
    writeModels({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' }, loop: { roundCap: 3 } });
    m = getModels();
    assert.equal(m.maker.model, 'opus', 'CLAUDE_MODEL applies to a claude-backend maker');
    assert.equal(m.maker.source, 'env:CLAUDE_MODEL', 'the override names its provenance');
    assert.equal(m.reviewer.model, 'gpt-5.5', 'CODEX_MODEL applies to a codex-backend reviewer');
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;

    // The seat catalog offers every declared backend in its declared seats.
    writeModels({
      maker: { backend: 'claude', model: 'sonnet' },
      reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' },
      backends: { kimi: { ...KIMI, seats: ['maker'] } },
      loop: { roundCap: 3 },
    });
    const seats = seatCatalog();
    assert.ok(seatOffered(seats.maker, 'kimi', 'kimi-k2'), 'a declared compat backend is offered in its declared seat');
    assert.ok(!seatOffered(seats.reviewer, 'kimi', 'kimi-k2'), 'a seat the entry does not declare is never offered');
    assert.ok(seatOffered(seats.maker, 'claude', 'sonnet') && seatOffered(seats.reviewer, 'claude', 'sonnet'), 'claude offers both seats');
    assert.ok(seats.reviewer.some((e) => e.backend === 'codex' && e.effort === true), 'codex entries say they honor effort');
    assert.ok(seats.maker.filter((e) => e.backend === 'kimi').every((e) => e.effort === false), 'compat entries say they take no effort request');
    assert.ok(!seatOffered(seats.maker, 'kimi', 'undeclared-model'), 'only DECLARED compat models are offered — the list is a statement, never a probe');

    // Claude has aliases but no live catalog. The exact pinned standing model
    // is still a real operator decision and must be selectable for a one-run
    // override; otherwise the launch form shows a current choice the server
    // itself refuses. No unrelated exact ids are inferred.
    writeModels({ maker: { backend: 'claude', model: 'claude-opus-4-8' }, reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' }, loop: { roundCap: 3 } });
    const pinnedSeats = seatCatalog();
    assert.ok(seatOffered(pinnedSeats.maker, 'claude', 'claude-opus-4-8'), 'the exact pinned Claude maker remains explicitly selectable');
    assert.ok(seatOffered(pinnedSeats.reviewer, 'claude', 'claude-opus-4-8'), 'the same exact built-in Claude decision is selectable in the reverse seat');
    assert.ok(seatOffered(pinnedSeats.maker, 'claude', 'opus'), 'stable Claude aliases remain selectable beside the exact pin');
    assert.ok(!seatOffered(pinnedSeats.maker, 'claude', 'claude-unconfigured-exact'), 'no unrelated exact Claude id is invented');

    // Restore the custom-backend fixture for the malformed-entry assertions.
    writeModels({
      maker: { backend: 'claude', model: 'sonnet' },
      reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' },
      backends: { kimi: { ...KIMI, seats: ['maker'] } },
      loop: { roundCap: 3 },
    });
    // The legacy catalog (Compare & Learn / audit replay) stays claude+codex only.
    const legacy = modelCatalog();
    assert.ok(!legacy.maker.includes('kimi-k2'), 'the frozen-schema catalog never absorbs compat backends');

    // Malformed entries refuse to load — a half-declared backend is not a decision.
    const refuses = (backends, why) => {
      writeModels({ maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' }, backends, loop: { roundCap: 3 } });
      assert.throws(() => listBackends(), why);
    };
    refuses({ kimi: { ...KIMI, provider: undefined } }, 'missing provider refuses');
    refuses({ kimi: { ...KIMI, baseUrl: 'ftp://nope' } }, 'non-http baseUrl refuses');
    refuses({ kimi: { ...KIMI, models: [] } }, 'empty model list refuses');
    refuses({ kimi: { ...KIMI, kind: 'grpc' } }, 'unknown kind refuses');
    refuses({ claude: KIMI }, 'a built-in name collision refuses');
    refuses({ kimi: { ...KIMI, seats: ['maker', 'oracle'] } }, 'an unknown seat name refuses');

    // The grounding guard is a pure judgement shared by server and engine.
    assert.equal(groundingNeedsClaudeMaker({ ground: true, hivemindMode: 'claude', makerBackend: 'kimi' }), true, 'grounded managed-connector run with a non-claude maker is refused');
    assert.equal(groundingNeedsClaudeMaker({ ground: true, hivemindMode: 'claude', makerBackend: 'claude' }), false, 'claude maker grounds fine');
    assert.equal(groundingNeedsClaudeMaker({ ground: false, hivemindMode: 'claude', makerBackend: 'kimi' }), false, 'ungrounded runs are unaffected');
    assert.equal(groundingNeedsClaudeMaker({ ground: true, hivemindMode: 'mcp', makerBackend: 'kimi' }), false, 'studio-side retrieval modes work with any maker');
  } finally {
    if (prevFile === undefined) delete process.env.STUDIO_MODELS_FILE; else process.env.STUDIO_MODELS_FILE = prevFile;
    if (prevClaudeModel === undefined) delete process.env.CLAUDE_MODEL; else process.env.CLAUDE_MODEL = prevClaudeModel;
    if (prevCodexModel === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = prevCodexModel;
    if (prevCodexEffort === undefined) delete process.env.CODEX_EFFORT; else process.env.CODEX_EFFORT = prevCodexEffort;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- registry: seats resolve to exactly the snapshot's backends ---------------
{
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveSeatAdapters } = await import('./lib/adapters/registry.mjs');
  const { deepQualifyModel } = await import('./lib/capability-probes.mjs');
  const { listBackends } = await import('./lib/models.mjs');
  const { runClaude, runClaudeReview } = await import('./lib/adapters/claude.mjs');
  const { runCodexReview, runCodexMaker } = await import('./lib/adapters/codex.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'cls-registry-'));
  const file = join(tmp, 'models.json');
  const prevFile = process.env.STUDIO_MODELS_FILE;
  const prevGrandfather = process.env.STUDIO_GRANDFATHER_DIR;
  const prevCapability = process.env.STUDIO_CAPABILITY_DIR;
  process.env.STUDIO_MODELS_FILE = file;
  process.env.STUDIO_GRANDFATHER_DIR = tmp;
  delete process.env.STUDIO_CAPABILITY_DIR;
  writeFileSync(file, JSON.stringify({
    maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' },
    connections: { local_kimi: { kind: 'loopback', port: 9, basePath: '/v1' } },
    backends: { kimi: {
      kind: 'openai_compat', provider: 'moonshot', connection: 'local_kimi', protocol: 'chat_completions',
      trainingOrg: 'moonshot', modelFamily: 'kimi', derivedFrom: null, inferenceOperator: 'self_hosted',
      auth: { kind: 'none' }, models: ['kimi-k2'], seats: ['maker'],
    } },
    loop: { roundCap: 3 },
  }));
  try {
    const legacy = resolveSeatAdapters({ maker: { model: 'sonnet' }, reviewer: { model: 'gpt-5.4', effort: 'low' } });
    assert.equal(legacy.maker, runClaude, 'a legacy snapshot resolves the historical claude maker');
    assert.equal(legacy.reviewer, runCodexReview, 'a legacy snapshot resolves the historical codex reviewer');
    assert.equal(legacy.makerBackend.provider, 'anthropic');

    const reversed = resolveSeatAdapters({ maker: { backend: 'codex', model: 'gpt-5.4' }, reviewer: { backend: 'claude', model: 'sonnet' } });
    assert.equal(reversed.maker, runCodexMaker, 'GPT can take the maker seat');
    assert.equal(reversed.reviewer, runClaudeReview, 'Claude can take the reviewer seat');

    assert.throws(
      () => resolveSeatAdapters({ maker: { backend: 'kimi', model: 'kimi-k2' }, reviewer: { backend: 'claude', model: 'sonnet' } }),
      /exact accepted qual1 qualification/,
      'adapter resolution is a final bypass guard: config declaration alone grants no custom maker',
    );
    assert.throws(
      () => resolveSeatAdapters({ maker: { backend: 'kimi', model: 'kimi-k2', qualification: { fingerprint: `qual1:${'a'.repeat(64)}`, seatType: 'words_reviewer' } }, reviewer: { backend: 'claude', model: 'sonnet' } }),
      /exact accepted qual1 qualification/,
      'a reviewer receipt cannot be relabeled as maker admission',
    );
    assert.throws(
      () => resolveSeatAdapters({ maker: { backend: 'kimi', model: 'kimi-k2', qualification: { fingerprint: `qual1:${'a'.repeat(64)}`, seatType: 'words_maker' } }, reviewer: { backend: 'claude', model: 'sonnet' } }),
      /does not match the valid stored receipt/,
      'a syntactically plausible fingerprint cannot bypass exact receipt validation',
    );
    const qualified = await deepQualifyModel({
      entry: listBackends().kimi, model: 'kimi-k2', seatType: 'words_maker', contextProbeTokens: 64,
      fetchImpl: async () => { throw new Error('no discovery route'); },
      streamImpl: async ({ prompt }) => {
        const head = /MARKER-HEAD:\s*(\S+)/.exec(prompt)?.[1];
        const tail = /MARKER-TAIL:\s*(\S+)/.exec(prompt)?.[1];
        return {
          text: head && tail ? `${head} ${tail}` : 'live',
          responseModel: 'kimi-k2', reportedModels: ['kimi-k2'], deltaCount: 1,
          usage: { prompt_tokens: 100000, completion_tokens: 8 },
        };
      },
    });
    assert.equal(qualified.qualified, true, qualified.reason);
    const compat = resolveSeatAdapters({ maker: { backend: 'kimi', model: 'kimi-k2', qualification: { fingerprint: qualified.receipt.fingerprint, seatType: 'words_maker' } }, reviewer: { backend: 'claude', model: 'sonnet' } });
    assert.equal(typeof compat.maker, 'function', 'a declared compat backend fills the maker seat');
    assert.equal(compat.makerBackend.provider, 'moonshot');

    assert.throws(() => resolveSeatAdapters({ maker: { backend: 'ghost', model: 'x' }, reviewer: { backend: 'codex', model: 'gpt-5.4' } }), /not declared/, 'an undeclared backend refuses — never a silent fallback');
  } finally {
    if (prevFile === undefined) delete process.env.STUDIO_MODELS_FILE; else process.env.STUDIO_MODELS_FILE = prevFile;
    if (prevGrandfather === undefined) delete process.env.STUDIO_GRANDFATHER_DIR; else process.env.STUDIO_GRANDFATHER_DIR = prevGrandfather;
    if (prevCapability === undefined) delete process.env.STUDIO_CAPABILITY_DIR; else process.env.STUDIO_CAPABILITY_DIR = prevCapability;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- openai_compat adapter against a local chat-completions fixture -----------
// No external network. The fixture streams SSE chunks like a real endpoint;
// the adapter must capture text, usage, and the served model identity, and
// every kill path must fail closed.
{
  const { createServer } = await import('node:http');
  const { openAiCompatMaker, openAiCompatReviewer } = await import('./lib/adapters/openai-compat.mjs');

  let mode = 'ok';
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    if (req.headers.authorization !== 'Bearer test-key-123') return res.writeHead(401).end('{"error":"bad key"}');
    if (mode === 'http500') return res.writeHead(500).end('upstream exploded');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'stall') {
      res.write(sse({ model: 'kimi-served', choices: [{ delta: { content: 'partial' } }] }));
      return; // never finishes — the idle watchdog must kill it
    }
    if (mode === 'empty') {
      res.write(sse({ model: 'kimi-served', choices: [{ delta: {} }] }));
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const text = mode === 'review' ? JSON.stringify({
      verdict: 'clean', findings: [], questions_for_human: [],
      claim_assessments: [], coverage_assessments: [], threshold_assessments: [],
    }) : mode === 'garbage-review' ? 'I refuse JSON; echoed Authorization: Bearer test-key-123'
      : `Drafted for ${parsed.model}: the deliverable body.`;
    const served = mode === 'substitute' ? 'ghost-model-nobody-declared' : 'kimi-served';
    // Split the fake credential itself across SSE frames on the malformed path:
    // per-delta scrubbing would miss it, while post-assembly scrubbing must not.
    const half = mode === 'garbage-review'
      ? text.indexOf('test-key-123') + 'test-k'.length
      : Math.ceil(text.length / 2);
    res.write(sse({ model: served, choices: [{ delta: { content: text.slice(0, half) } }] }));
    res.write(sse({ model: served, choices: [{ delta: { content: text.slice(half) } }] }));
    res.write(sse({ usage: { prompt_tokens: 120, completion_tokens: 45 }, choices: [] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  // The fixture serves under the id "kimi-served" while the seat requests
  // "kimi-k2"; that is a DECLARED mapping endpoint (expectedReported), so §6.2
  // reconciliation maps it instead of refusing. An UNDECLARED served id is
  // refused below — output from a substituted model is never consumed.
  const entry = { name: 'kimi', kind: 'openai_compat', provider: 'moonshot', baseUrl: `http://127.0.0.1:${fixture.address().port}`, apiKeyEnv: 'CLS_TEST_KIMI_KEY', models: ['kimi-k2'], expectedReported: ['kimi-served'] };
  const prevKey = process.env.CLS_TEST_KIMI_KEY;
  const prevIdle = process.env.OPENAI_COMPAT_IDLE_MS;
  const compatReceiptRoot = mkdtempSync(_join(_tmpdir(), 'cls-compat-receipt-'));
  process.env.CLS_TEST_KIMI_KEY = 'test-key-123';
  try {
    const maker = openAiCompatMaker(entry);
    const sessions = [];
    const ok = await maker({ prompt: 'draft it', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal, onSession: (l) => sessions.push(l) });
    assert.equal(ok.ok, true, `compat maker succeeds against the fixture (${ok.error})`);
    assert.match(ok.text, /^Drafted for kimi-k2/, 'the streamed deltas assemble into the deliverable');
    // §5.2/§9.1: a reported alias is recorded in `reported` but does NOT become
    // actual — the operator-documented mapped (requested) id is the actual.
    assert.equal(ok.modelActual, 'moonshot:kimi-k2', 'actual identity = declared provider + the operator-mapped (requested) model, not the served alias');
    // §9.1 identity evidence the engine seals: a declared alias mapping is
    // mapped_by_operator_docs, carrying the raw reported id.
    assert.equal(ok.modelReported, 'kimi-served', 'the raw reported alias rides the result in `reported`');
    assert.equal(ok.modelActualEvidence, 'mapped_by_operator_docs', 'a declared alias seals as mapped_by_operator_docs');
    assert.deepEqual(ok.usage, { input_tokens: 120, cached_input_tokens: null, output_tokens: 45 }, 'usage is the endpoint observation, cached stays null when unreported');
    assert.equal(ok.costUsd, 0, 'no dollars are ever invented');
    assert.ok(sessions.some((l) => l.includes('tool surface: none')), 'the toolless surface is stated in the session trail');

    const hm = await maker({ prompt: 'x', stage: 'ground', model: 'kimi-k2', signal: new AbortController().signal, toolPolicy: 'hivemind_only' });
    assert.equal(hm.ok, false, 'hivemind_only retrieval on a toolless backend is an infra error');
    assert.match(hm.error, /claude backend/, 'the error names the fix');

    mode = 'empty';
    const empty = await maker({ prompt: 'x', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal });
    assert.equal(empty.ok, false, 'an empty completion fails, never a hollow success');

    mode = 'http500';
    const boom = await maker({ prompt: 'x', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal });
    assert.equal(boom.ok, false, 'HTTP failure fails closed');
    assert.match(boom.error, /500/, 'the status survives into the error');

    delete process.env.CLS_TEST_KIMI_KEY;
    mode = 'ok';
    const nokey = await maker({ prompt: 'x', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal });
    assert.equal(nokey.ok, false, 'a missing key is an infra error');
    assert.match(nokey.error, /CLS_TEST_KIMI_KEY/, 'the error names the env var, never the key');
    process.env.CLS_TEST_KIMI_KEY = 'test-key-123';

    // Abort kill path: a stalling stream dies the moment the run aborts.
    mode = 'stall';
    process.env.OPENAI_COMPAT_IDLE_MS = '60000';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const aborted = await maker({ prompt: 'x', stage: 'make', model: 'kimi-k2', signal: ac.signal });
    assert.equal(aborted.ok, false, 'an aborted call is never a success');
    assert.match(aborted.error, /aborted by user/);

    // Idle watchdog kill path: silence beyond the window is an infra error.
    process.env.OPENAI_COMPAT_IDLE_MS = '80';
    const idle = await maker({ prompt: 'x', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal });
    assert.equal(idle.ok, false, 'a silent stream is killed');
    assert.match(idle.error, /idle watchdog/);
    delete process.env.OPENAI_COMPAT_IDLE_MS;

    // Reviewer seat: strict JSON normalizes through the SAME fail-closed gate.
    mode = 'review';
    const reviewer = openAiCompatReviewer(entry);
    const verdict = await reviewer({ prompt: 'judge it', model: 'kimi-k2', signal: new AbortController().signal, claims: [], criteria: [], thresholds: [] });
    assert.equal(verdict.ran, true, `compat reviewer normalizes a clean verdict (${verdict.error})`);
    assert.equal(verdict.verdict, 'APPROVED');
    assert.equal(verdict.reviewerIdentity, 'moonshot:kimi-k2', 'the auditor identity is the operator-mapped (requested) model, not the served alias (§5.2)');
    assert.equal(verdict.reviewerEffort, null, 'no effort knob → no fabricated tier');
    assert.equal(verdict.reviewerReportedModel, 'kimi-served', 'the raw reported reviewer model rides the verdict');
    assert.equal(verdict.reviewerActualEvidence, 'mapped_by_operator_docs', 'the reviewer alias seals as mapped_by_operator_docs');

    mode = 'garbage-review';
    const garbageReceipt = _join(compatReceiptRoot, 'garbage');
    const garbage = await reviewer({ prompt: 'judge it', model: 'kimi-k2', signal: new AbortController().signal, receiptDir: garbageReceipt, claims: [], criteria: [], thresholds: [] });
    assert.equal(garbage.ran, false, 'prose instead of the schema is an INFRA error, never a clean verdict');
    assert.ok(!garbage.error.includes('test-key-123'), 'the malformed-verdict diagnostic never exposes the provider credential');
    const capturedGarbage = _rfs(_join(garbageReceipt, 'last.json'), 'utf8');
    assert.ok(!capturedGarbage.includes('test-key-123'), 'the raw-verdict receipt never persists an echoed provider credential');
    assert.match(capturedGarbage, /redacted/, 'the receipt makes the scrub visible instead of silently dropping the diagnostic');

    // §6.2 fail-closed: an UNDECLARED served model kills the call before its
    // output is consumed — neither a maker draft nor a reviewer verdict.
    mode = 'substitute';
    const subMaker = await maker({ prompt: 'draft it', stage: 'make', model: 'kimi-k2', signal: new AbortController().signal });
    assert.equal(subMaker.ok, false, 'a substituted maker model is refused, never drafted');
    assert.match(subMaker.error, /ghost-model-nobody-declared|substituted model/, 'the refusal names the substitution');
    const subReviewer = await reviewer({ prompt: 'judge it', model: 'kimi-k2', signal: new AbortController().signal, claims: [], criteria: [], thresholds: [] });
    assert.equal(subReviewer.ran, false, 'a substituted reviewer model is an infra refusal, never a verdict');
  } finally {
    if (prevKey === undefined) delete process.env.CLS_TEST_KIMI_KEY; else process.env.CLS_TEST_KIMI_KEY = prevKey;
    if (prevIdle === undefined) delete process.env.OPENAI_COMPAT_IDLE_MS; else process.env.OPENAI_COMPAT_IDLE_MS = prevIdle;
    _rmfs(compatReceiptRoot, { recursive: true, force: true });
    fixture.closeAllConnections?.();
    fixture.close();
  }
}

// --- same-vendor pairing: advisory standing, never independent ----------------
{
  const { deriveStatusDimensions, deriveHeadline } = await import('./lib/status-dims.mjs');
  const { receiptCompleteness } = await import('./lib/evidence.mjs');
  const roundsWith = (independence, verdict = 'APPROVED', extra = {}) => ({
    gateReport: null,
    verify: [{ pass: true }],
    rounds: [{ verdict, rev: 1, independence, reviewerIdentity: 'anthropic:claude-sonnet-4-6', findings: [], claimAssessments: [], coverageAssessments: [], ...extra }],
    revisions: [{ rev: 1 }],
  });

  const advisory = deriveStatusDimensions({ lane: 'freeform', status: 'done', evidence: roundsWith('same_vendor') });
  assert.equal(advisory.audit, 'advisory_clean', 'a same-vendor round seals an ADVISORY audit');
  assert.equal(deriveHeadline({ ...advisory, schemaVersion: undefined }), 'same_vendor_reviewed', 'the headline says same-vendor reviewed, never verified');

  const advisoryFindings = deriveStatusDimensions({ lane: 'freeform', status: 'done_with_findings', evidence: roundsWith('same_vendor', 'REVISE') });
  assert.equal(advisoryFindings.audit, 'advisory_findings', 'same-vendor REVISE seals advisory findings');

  const advisoryCaveat = deriveStatusDimensions({ lane: 'freeform', status: 'done_with_findings', evidence: roundsWith('same_vendor', 'APPROVED', { findings: [{ severity: 'low', title: 'caveat' }] }) });
  assert.equal(advisoryCaveat.audit, 'advisory_findings', 'a caveated same-vendor approval stays advisory findings');

  const cross = deriveStatusDimensions({ lane: 'freeform', status: 'done', evidence: roundsWith('cross_vendor') });
  assert.equal(cross.audit, 'independent_clean', 'a cross-vendor round keeps independent standing');

  const declared = deriveStatusDimensions({ lane: 'freeform', status: 'done', evidence: roundsWith('cross_vendor_declared') });
  assert.equal(declared.schemaVersion, 2, 'new Studio status dimensions are version 2');
  assert.equal(declared.audit, 'declared_clean', 'operator-declared cross-organization lineage gets its own standing');
  assert.equal(deriveHeadline({ ...declared, schemaVersion: undefined }), 'declared_cross_vendor_reviewed');
  const declaredFindings = deriveStatusDimensions({ lane: 'freeform', status: 'done_with_findings', evidence: roundsWith('cross_vendor_declared', 'REVISE') });
  assert.equal(declaredFindings.audit, 'declared_findings');

  // Live control for the legacy path: a round with NO independence fact (every
  // receipt sealed before seats existed) derives independent, as it always did.
  const legacy = deriveStatusDimensions({ lane: 'freeform', status: 'done', evidence: roundsWith(null) });
  assert.equal(legacy.audit, 'independent_clean', 'pre-seats rounds keep their cross-vendor-by-construction standing');

  // An advisory audit is a COMPLETE receipt: the downgrade lives in the
  // standing, not in receipt degradation.
  const complete = receiptCompleteness({ lane: 'freeform', status: 'done', writeFailed: false, evidence: roundsWith('same_vendor') });
  assert.equal(complete.degraded, false, 'a same-vendor run with a green verify is a complete receipt');
  const broken = receiptCompleteness({ lane: 'freeform', status: 'done', writeFailed: false, evidence: { ...roundsWith('same_vendor'), rounds: [{ verdict: 'UNKNOWN', rev: 1, independence: 'same_vendor' }] } });
  assert.equal(broken.degraded, true, 'a broken audit still degrades — advisory acceptance never swallows infra failure');
}

// --- evidence pack: provider-aware pairing identities --------------------------
{
  const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');
  const { validateEvidencePack } = await import('../../packages/trust/lib/validate.mjs');
  const kimiQualification = { fingerprint: `qual1:${'a'.repeat(64)}`, gate_scope: null, contract_version: null };
  const kimiSeat = {
    backend: 'kimi', provider: 'moonshot', model: 'kimi-k2', source: 'run request',
    executor: 'http_client', transport: 'direct_https', connection: 'moonshot-hosted', protocol: 'chat_completions',
    trainingOrg: 'moonshot', modelFamily: 'kimi', inferenceOperator: 'moonshot',
    lineage: { source: 'registry', derivedFrom: null }, originConfidence: 'verified_operator',
    qualification: kimiQualification,
  };
  const base = {
    goal: 'Reversed-seat receipt.',
    acceptanceContract: 'Every material claim is traceable.',
    lane: 'freeform',
    deliverable: '# Note\n\nNo claims.\n',
    evidence: {
      rounds: [{ rev: 1, verdict: 'APPROVED', reviewerModel: 'sonnet', reviewerEffort: null, reviewerIdentity: 'anthropic:claude-sonnet-4-6', reviewerActualEvidence: 'observed_cli_event', reviewerReportedModel: 'claude-sonnet-4-6', independence: 'cross_vendor', findings: [], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'traceable' }] }],
      revisions: [{ rev: 1, chars: 20 }],
      verify: [{ pass: true, checks: [{ id: 'links', status: 'pass', detail: 'ok' }] }],
      humanDecisions: [],
      grounding: null,
      gateReport: null,
    },
    statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
    models: {
      maker: kimiSeat,
      reviewer: { backend: 'claude', provider: 'anthropic', model: 'sonnet', effort: null, modelSource: 'run request', effortSource: 'not honored by this backend' },
    },
    makerActualModels: ['moonshot:kimi-served'],
    makerActualEvidence: 'observed_api_response',
    makerReportedModel: 'kimi-served',
    simulated: false,
    createdAt: 50,
  };
  const pack = buildEvidencePack(base);
  assert.equal(validateEvidencePack(pack).ok, true, 'a reversed-seat pack validates against the trust schema');
  assert.equal(pack.pairing.executor.requested, 'moonshot:kimi-k2', 'requested executor carries the snapshot provider');
  assert.equal(pack.pairing.executor.actual, 'moonshot:kimi-served', 'actual executor is the recorded observation');
  assert.equal(pack.pairing.executor.reported, 'kimi-served', 'the raw endpoint model report is sealed separately from the provider-qualified actual');
  assert.equal(pack.pairing.auditor.actual, 'anthropic:claude-sonnet-4-6', 'actual auditor comes from the round identity, not a hardcoded vendor');
  assert.equal(pack.pairing.auditor.reported, 'claude-sonnet-4-6');
  assert.equal(pack.pairing.independence, 'cross_vendor', 'moonshot vs anthropic earns cross-vendor standing');
  assert.deepEqual(pack.pairing.executor.qualification, kimiQualification, 'the configurable seat carries its accepted qual1 unchanged');
  assert.equal(pack.pairing.executor.actual_evidence, 'observed_api_response');
  assert.equal(pack.pairing.auditor.actual_evidence, 'observed_cli_event');
  assert.ok(pack.session_log.some((l) => l === 'executor seat: backend=kimi; decision source=run request'), 'the pairing source is custody-bound in the receipt');
  assert.ok(pack.session_log.some((l) => l === 'auditor seat: backend=claude; decision source=run request'), 'both seat decisions record their provenance');
  assert.equal(pack.economics.find((e) => e.role === 'auditor').effort, null, 'no fabricated effort tier for a backend without the knob');

  const assertedOnly = buildEvidencePack({
    ...base,
    makerActualEvidence: null,
    makerReportedModel: null,
    evidence: {
      ...base.evidence,
      rounds: [{ ...base.evidence.rounds[0], reviewerActualEvidence: null, reviewerReportedModel: null }],
    },
  });
  assert.equal(assertedOnly.schemaVersion, 2, 'configurable seats without stored observation metadata remain on the frozen compatibility envelope');
  assert.equal(assertedOnly.pairing.schemaVersion, 1);
  assert.equal(assertedOnly.statuses.schemaVersion, 1);
  assert.equal(assertedOnly.pairing.executor.requested, 'moonshot:kimi-k2', 'the compatibility seat preserves the provider-qualified v1 identity');
  assert.equal('qualification' in assertedOnly.pairing.executor, false, 'a v2 fallback never half-seals a qualification it could not support end to end');
  assert.ok(assertedOnly.session_log.some((line) => line.startsWith('compatibility envelope v2:')), 'the downgrade reason is custody-bound');

  const grokQualification = { fingerprint: `qual1:${'b'.repeat(64)}`, gate_scope: null, contract_version: null };
  const gatewayPack = buildEvidencePack({
    ...base,
    statuses: { ...base.statuses, audit: 'declared_clean' },
    models: {
      maker: {
        ...kimiSeat,
        transport: 'direct_https',
        inferenceOperator: 'gateway:marshall',
        lineage: { source: 'operator_declared', derivedFrom: null },
        originConfidence: 'operator_declared',
      },
      reviewer: {
        backend: 'grok', provider: 'xai', model: 'grok-4', effort: null, modelSource: 'run request', effortSource: 'not honored by this backend',
        executor: 'http_client', transport: 'direct_https', connection: 'xai-hosted',
        trainingOrg: 'xai', modelFamily: 'grok', inferenceOperator: 'gateway:marshall',
        lineage: { source: 'operator_declared', derivedFrom: null }, originConfidence: 'operator_declared',
        qualification: grokQualification,
      },
    },
    evidence: {
      ...base.evidence,
      rounds: [{
        ...base.evidence.rounds[0],
        reviewerModel: 'grok-4', reviewerIdentity: 'xai:grok-4', reviewerReportedModel: 'grok-4',
        reviewerActualEvidence: 'observed_api_response', independence: 'cross_vendor_declared',
        qualification: grokQualification,
      }],
    },
  });
  assert.equal(gatewayPack.pairing.independence, 'cross_vendor_declared');
  assert.equal(gatewayPack.pairing.shared_gateway, 'marshall', 'the exact shared gateway name is sealed from both inference operators');
  assert.equal(gatewayPack.statuses.audit, 'declared_clean');

  // Same-vendor pairing: advisory statuses map to same_vendor_advisory and validate.
  const sameVendor = buildEvidencePack({
    ...base,
    statuses: { ...base.statuses, audit: 'advisory_clean' },
    models: {
      maker: { backend: 'claude', provider: 'anthropic', model: 'sonnet', source: 'checks/models.json' },
      reviewer: { backend: 'claude', provider: 'anthropic', model: 'haiku', effort: null, modelSource: 'run request', effortSource: 'not honored by this backend' },
    },
    makerActualModels: ['anthropic:claude-sonnet-4-6'],
    evidence: { ...base.evidence, rounds: [{ ...base.evidence.rounds[0], reviewerModel: 'haiku', reviewerIdentity: 'anthropic:claude-haiku-4-5', independence: 'same_vendor' }] },
  });
  assert.equal(validateEvidencePack(sameVendor).ok, true, 'a same-vendor pack validates');
  assert.equal(sameVendor.pairing.independence, 'same_vendor_advisory', 'same-vendor pairing records advisory independence, never blocked, never promoted');

  // The seal-time guard: independent standing over same recorded providers refuses.
  assert.throws(() => buildEvidencePack({
    ...base,
    models: sameVendor === null ? null : {
      maker: { backend: 'claude', provider: 'anthropic', model: 'sonnet', source: 'checks/models.json' },
      reviewer: { backend: 'claude', provider: 'anthropic', model: 'haiku', effort: null, modelSource: 'run request', effortSource: 'not honored by this backend' },
    },
    makerActualModels: ['anthropic:claude-sonnet-4-6'],
    evidence: { ...base.evidence, rounds: [{ ...base.evidence.rounds[0], reviewerModel: 'haiku', reviewerIdentity: 'anthropic:claude-haiku-4-5', independence: 'same_vendor' }] },
    // statuses claim independent while both actuals are anthropic — refuse to seal
  }), /independent audit standing conflicts/, 'an independent claim over same-vendor actuals refuses to seal');
}

// --- engine: pairing facts ride every review event -----------------------------
{
  const { runLoop } = await import('./lib/engine.mjs');
  const prev = process.env.MOCK_OFFLINE;
  process.env.MOCK_OFFLINE = '1';
  const review = { ran: true, error: null, verdict: 'APPROVED', findings: [], blocking: [], nonblocking: [], questions: [], claimAssessments: [], coverageAssessments: [], reviewerModel: 'sonnet', reviewerEffort: null, reviewerIdentity: 'anthropic:claude-sonnet-4-6' };
  const kimiQualification = { fingerprint: `qual1:${'c'.repeat(64)}`, gate_scope: null, contract_version: null };
  const kimiSeat = {
    backend: 'kimi', provider: 'moonshot', model: 'kimi-k2', source: 'run request',
    executor: 'http_client', transport: 'direct_https', connection: 'moonshot-hosted',
    trainingOrg: 'moonshot', modelFamily: 'kimi', inferenceOperator: 'moonshot',
    lineage: { source: 'registry', derivedFrom: null }, originConfidence: 'verified_operator',
    qualification: kimiQualification,
  };
  const runOnce = async (makerActual, makerSeat = kimiSeat, observed = true) => {
    const events = [];
    await runLoop({
      goal: 'g', lane: 'freeform', ground: false,
      models: {
        maker: makerSeat,
        reviewer: { backend: 'claude', provider: 'anthropic', model: 'sonnet', effort: null, modelSource: 'run request', effortSource: 'not honored by this backend' },
        loop: { roundCap: 1 },
      },
    }, {
      emit: (type, data) => events.push({ type, ...data }),
      waitForAnswer: async () => 'ok',
      adapters: {
        maker: async () => ({
          ok: true, error: null, text: '## Notes\n\nA plain note.\n', costUsd: 0, modelActual: makerActual,
          ...(observed ? { modelActualEvidence: 'observed_api_response', modelReported: makerActual.split(':').slice(1).join(':') } : {}),
        }),
        reviewer: async () => review,
      },
      hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ mode: 'stub' }), publishArtifact: async () => null },
      signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
    });
    return events.find((e) => e.type === 'review');
  };
  const crossEvent = await runOnce('moonshot:kimi-served');
  assert.equal(crossEvent.reviewerIdentity, 'anthropic:claude-sonnet-4-6', 'the review event carries the auditor identity');
  assert.equal(crossEvent.independence, 'cross_vendor', 'moonshot maker vs anthropic reviewer records cross-vendor');
  assert.equal(crossEvent.reviewerBackend, 'claude', 'the reviewer backend is recorded');
  const sameEvent = await runOnce('anthropic:claude-sonnet-4-6');
  assert.equal(sameEvent.independence, 'cross_vendor', 'observed provider prefixes do not override the configured training-lineage fact');
  const hostedClaudeSeat = {
    backend: 'bedrock-claude', provider: 'aws', model: 'claude-sonnet', source: 'run request',
    executor: 'http_client', transport: 'direct_https', connection: 'bedrock-hosted',
    trainingOrg: 'anthropic', modelFamily: 'claude', inferenceOperator: 'aws',
    lineage: { source: 'operator_declared', derivedFrom: null }, originConfidence: 'operator_declared',
    qualification: { fingerprint: `qual1:${'d'.repeat(64)}`, gate_scope: null, contract_version: null },
  };
  const sameOrgEvent = await runOnce('aws:claude-sonnet', hostedClaudeSeat);
  assert.equal(sameOrgEvent.independence, 'same_vendor', 'different provider labels stay advisory when the two seats share Anthropic training lineage');
  const unobservedEvent = await runOnce('moonshot:kimi-served', kimiSeat, false);
  assert.equal(unobservedEvent.independence, 'same_vendor', 'a qualified custom seat without observation metadata remains advisory instead of presenting stronger standing than its fallback receipt');
  const unqualifiedSeat = { ...kimiSeat };
  delete unqualifiedSeat.qualification;
  const unqualifiedEvent = await runOnce('moonshot:kimi-served', unqualifiedSeat);
  assert.ok(unqualifiedEvent, 'an unqualified configurable seat reaches review instead of failing before Plan/model spend');
  assert.equal(unqualifiedEvent.independence, 'same_vendor', 'without accepted qualification the round fails toward advisory standing');
  assert.match(unqualifiedEvent.qualification?.fingerprint ?? '', /^builtin1:/, 'the round carries only the reviewer built-in qualification; it never invents maker qual1 from configuration facts');

  // Grounded managed-connector run with a non-claude maker: the engine backstop
  // fails the run rather than silently retrieving through the wrong seat.
  const events = [];
  const result = await runLoop({
    goal: 'g', lane: 'freeform', ground: true,
    models: {
      maker: kimiSeat,
      reviewer: { backend: 'claude', provider: 'anthropic', model: 'sonnet', effort: null },
      loop: { roundCap: 1 },
    },
  }, {
    emit: (type, data) => events.push({ type, ...data }),
    waitForAnswer: async () => 'ok',
    adapters: { maker: async () => ({ ok: true, text: 'x', costUsd: 0 }), reviewer: async () => review },
    hivemind: { searchKnowledge: async () => null, hivemindStatus: () => ({ mode: 'claude' }), publishArtifact: async () => null },
    signal: new AbortController().signal, scratchDir: '/tmp', receiptsDir: '/tmp',
  });
  assert.equal(result.status, 'failed', 'the engine backstop refuses to ground through a non-claude maker');
  assert.match(events.find((e) => e.type === 'error')?.message ?? '', /claude backend in the maker seat/, 'the failure names the rule');
  if (prev === undefined) delete process.env.MOCK_OFFLINE; else process.env.MOCK_OFFLINE = prev;
}

// --- audit fixes 2026-08-04 ----------------------------------------------------
// 1) the Build lane takes a gate-specific snapshot; 3) the codex maker's env
// is scrubbed; 4) configurable-backend membership is validated at load;
// 5) the claude reviewer has a real output-driven idle watchdog.
{
  const { writeFileSync, mkdtempSync, rmSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getModels, gateModels } = await import('./lib/models.mjs');
  const { scrubbedEnv } = await import('./lib/adapters/codex.mjs');
  const { runClaudeReview } = await import('./lib/adapters/claude.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'cls-audit-'));
  const file = join(tmp, 'models.json');
  const prevFile = process.env.STUDIO_MODELS_FILE;
  process.env.STUDIO_MODELS_FILE = file;
  const KIMI = { kind: 'openai_compat', provider: 'moonshot', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'CLS_TEST_KIMI_KEY', models: ['kimi-k2'] };
  const writeModels = (obj) => writeFileSync(file, JSON.stringify(obj));
  try {
    // gateModels: the fixed gate either gets a compatible snapshot or a refusal.
    writeModels({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' }, loop: { roundCap: 3 } });
    const compatible = gateModels();
    assert.equal(compatible.ok, true, 'claude/codex standing decisions are gate-compatible');
    assert.equal(compatible.models.maker.model, 'sonnet', 'the gate snapshot is the standing decision');
    writeModels({ maker: { backend: 'kimi', model: 'kimi-k2' }, reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' }, backends: { kimi: KIMI }, loop: { roundCap: 3 } });
    const refused = gateModels();
    assert.equal(refused.ok, false, 'a non-gate maker seat refuses a build snapshot');
    assert.match(refused.error, /claude-maker\/codex-reviewer gate/, 'the refusal names the fixed pairing');
    assert.match(refused.error, /kimi:kimi-k2/, 'and the offending decision');
    writeModels({ maker: { backend: 'claude', model: 'sonnet' }, reviewer: { backend: 'claude', model: 'haiku' }, loop: { roundCap: 3 } });
    assert.equal(gateModels().ok, false, 'a non-codex reviewer seat refuses too');

    // Membership: a hand-edited model outside a configurable backend's declared
    // list dies at LOAD, where doctor and /api/config surface it.
    writeModels({ maker: { backend: 'kimi', model: 'kimi-typo' }, reviewer: { backend: 'codex', model: 'gpt-5.4', effort: 'low' }, backends: { kimi: KIMI }, loop: { roundCap: 3 } });
    assert.throws(() => getModels(), /declared models list/, 'an undeclared compat model refuses to load');
    writeModels({ maker: { backend: 'kimi', model: 'kimi-k2' }, reviewer: { backend: 'kimi', model: 'nope' }, backends: { kimi: KIMI }, loop: { roundCap: 3 } });
    assert.throws(() => getModels(), /reviewer\.model "nope"/, 'the reviewer seat is validated too, and the error names the seat');
    writeModels({ maker: { backend: 'claude', model: 'my-custom-alias' }, reviewer: { backend: 'codex', model: 'gpt-x-unlisted', effort: 'low' }, loop: { roundCap: 3 } });
    assert.equal(getModels().maker.model, 'my-custom-alias', 'CLI backends stay advisory: claude accepts unlisted ids by design, and the codex cache races its writers');
  } finally {
    if (prevFile === undefined) delete process.env.STUDIO_MODELS_FILE; else process.env.STUDIO_MODELS_FILE = prevFile;
  }

  // The codex maker's environment scrub: credentials never reach the maker;
  // process basics, locale, and proxy transport do.
  const scrubbed = scrubbedEnv({
    PATH: '/usr/bin', HOME: '/Users/x', LC_ALL: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:1',
    HIVEMIND_API_KEY: 'hm_k_secret', MOONSHOT_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', STUDIO_MODELS_FILE: '/tmp/x',
  });
  // Proxy values round-trip through URL parsing (see the credential-stripping
  // test below), so the host survives in normalized form.
  assert.deepEqual(scrubbed, { PATH: '/usr/bin', HOME: '/Users/x', HTTPS_PROXY: 'http://proxy:1/', LC_ALL: 'en_US.UTF-8' }, 'the allowlist keeps transport and basics and drops every credential');

  // The claude reviewer's idle watchdog, forced to fire: a stub `claude` on
  // PATH that never writes a byte must be killed by output-silence, not by
  // the 8-minute hard cap — and the result is an infra error, never a verdict.
  const stubDir = mkdtempSync(join(tmpdir(), 'cls-stub-'));
  writeFileSync(join(stubDir, 'claude'), '#!/bin/sh\nsleep 30\n');
  chmodSync(join(stubDir, 'claude'), 0o755);
  const prevPath = process.env.PATH;
  const prevIdle = process.env.REVIEW_IDLE_MS;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  process.env.REVIEW_IDLE_MS = '150';
  try {
    const started = Date.now();
    const hung = await runClaudeReview({ prompt: 'judge', model: 'sonnet', cwd: stubDir, signal: new AbortController().signal, claims: [], criteria: [], thresholds: [] });
    assert.equal(hung.ran, false, 'a silent claude review is an infra error');
    assert.match(hung.error, /idle watchdog/, 'the kill path names itself');
    assert.ok(Date.now() - started < 5_000, 'the idle timer fired, not the hard timeout');
  } finally {
    process.env.PATH = prevPath;
    if (prevIdle === undefined) delete process.env.REVIEW_IDLE_MS; else process.env.REVIEW_IDLE_MS = prevIdle;
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- audit round 2: BOTH codex seats run hardened --------------------------
// The threat: `-s read-only` blocks writes but permits file reads, and user
// config keeps shell/MCP alive, so the agent could read $CODEX_HOME/auth.json
// (plaintext access tokens). The fix removes the capability itself. These
// assertions read the ACTUAL argv and environment of the spawned process via a
// stub `codex` on PATH, so a flag dropped from either seat fails here.
{
  const { writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { hardenedCodexArgs, scrubbedEnv, runCodexReview, runCodexMaker, unexpectedToolEvent, sessionLineFromCodexEvent } = await import('./lib/adapters/codex.mjs');

  // The flag set, verified by hand against codex-cli 0.144.1 (`codex exec --help`).
  const flags = hardenedCodexArgs();
  const joined = flags.join(' ');
  for (const required of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'shell_environment_policy.inherit=none']) {
    assert.ok(joined.includes(required), `the hardened arg set carries ${required}`);
  }
  assert.ok(joined.includes('--disable shell_tool'), 'the shell tool is disabled — the capability that could read auth.json');
  assert.ok(joined.includes('--disable unified_exec'), 'the unified exec tool is disabled too; disabling one and leaving the other open would be a paper guard');
  // Web search defaults to "cached" and stays ON unless explicitly disabled;
  // omitting --search does nothing (audit round 3: a live probe searched and
  // answered while the session line claimed otherwise).
  assert.ok(joined.includes('web_search="disabled"'), 'web search is explicitly disabled, not merely left unrequested');
  for (const family of ['apps', 'browser_use', 'in_app_browser', 'computer_use', 'image_generation', 'multi_agent', 'plugins', 'hooks']) {
    assert.ok(joined.includes(`--disable ${family}`), `the unused default capability family ${family} is disabled`);
  }

  // Proxy credentials are stripped while transport survives; an unparseable
  // value is dropped rather than passed through unexamined.
  const stripped = [];
  const env = scrubbedEnv({
    PATH: '/usr/bin', HOME: '/Users/x', CODEX_HOME: '/Users/x/.codex',
    HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:8080', HTTP_PROXY: 'http://plain.corp:3128',
    ALL_PROXY: 'not a url', NO_PROXY: 'localhost',
    HIVEMIND_API_KEY: 'hm_k_secret', ANTHROPIC_API_KEY: 'sk-ant-secret',
  }, (key, why) => stripped.push(`${key}:${why}`));
  assert.ok(!JSON.stringify(env).includes('s3cret'), 'proxy userinfo never reaches the subprocess');
  assert.match(env.HTTPS_PROXY, /^http:\/\/proxy\.corp:8080/, 'the proxy host and port survive, so transport still works');
  assert.equal(env.HTTP_PROXY, 'http://plain.corp:3128/', 'a credential-free proxy passes through');
  assert.equal('ALL_PROXY' in env, false, 'an unparseable proxy value is dropped, never forwarded blind');
  assert.equal(env.HIVEMIND_API_KEY, undefined, 'service credentials are absent');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'other providers\' credentials are absent too');
  assert.equal(env.HOME, '/Users/x', 'HOME stays: codex resolves its own auth through it, and the model has no tool to read it with');
  assert.deepEqual(stripped.sort(), ['ALL_PROXY:unparseable', 'HTTPS_PROXY:credentials removed'], 'every strip is reported so the session trail can say it happened');

  // The REAL spawn of each seat, observed through a stub `codex` that records
  // its argv and environment. This is the live control: it fails if either
  // seat stops passing the flags or stops scrubbing.
  const stubDir = mkdtempSync(join(tmpdir(), 'cls-codexstub-'));
  const argvFile = join(stubDir, 'argv.txt');
  const envFile = join(stubDir, 'env.txt');
  const verdict = JSON.stringify({ verdict: 'clean', findings: [], questions_for_human: [], claim_assessments: [], coverage_assessments: [], threshold_assessments: [] });
  writeFileSync(join(stubDir, 'codex'), `#!/bin/sh
printf '%s\\n' "$@" > ${argvFile}
env > ${envFile}
# honor -o/-c the way codex does: the file after -o gets the payload
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then printf '%s' '${verdict.replace(/'/g, "'\\''")}' > "$a"; fi
  prev="$a"
done
exit 0
`);
  chmodSync(join(stubDir, 'codex'), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  process.env.CLS_STUB_SECRET = 'must-not-appear';
  try {
    const sessions = [];
    const review = await runCodexReview({
      prompt: 'judge', cwd: stubDir, effort: 'low', model: 'gpt-5.4',
      signal: new AbortController().signal, onTick: () => {}, onSession: (l) => sessions.push(l),
      receiptDir: join(stubDir, 'receipt'), claims: [], criteria: [], thresholds: [],
    });
    assert.equal(review.ran, true, `the stub review normalizes (${review.error ?? ''})`);
    const reviewArgv = readFileSync(argvFile, 'utf8');
    for (const required of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'shell_tool', 'unified_exec', 'shell_environment_policy.inherit=none']) {
      assert.ok(reviewArgv.includes(required), `the REVIEWER seat's real argv carries ${required}`);
    }
    const reviewEnv = readFileSync(envFile, 'utf8');
    assert.ok(!reviewEnv.includes('must-not-appear'), 'the reviewer subprocess environment is scrubbed');
    assert.ok(sessions.some((l) => l.startsWith('hardened seat:')), 'the reviewer states its hardening in the session trail');

    rmSync(argvFile, { force: true });
    const makerSessions = [];
    const maker = await runCodexMaker({
      prompt: 'draft', stage: 'make', model: 'gpt-5.4', cwd: stubDir,
      signal: new AbortController().signal, onTick: () => {}, onSession: (l) => makerSessions.push(l),
    });
    // The stub writes only to the -o file, which the maker reads as its
    // deliverable; the JSON verdict body is irrelevant here, the argv is not.
    assert.equal(maker.ok, true, `the stub maker returns its -o payload (${maker.error ?? ''})`);
    const makerArgv = readFileSync(argvFile, 'utf8');
    for (const required of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'shell_tool', 'unified_exec', 'shell_environment_policy.inherit=none']) {
      assert.ok(makerArgv.includes(required), `the MAKER seat's real argv carries ${required}`);
    }
    assert.ok(!readFileSync(envFile, 'utf8').includes('must-not-appear'), 'the maker subprocess environment is scrubbed');
    assert.ok(makerSessions.some((l) => l.startsWith('hardened seat:')), 'the maker states its hardening too');
    assert.ok(!makerSessions.some((l) => l.includes('tool surface: none')), 'the maker no longer claims a blanket toolless surface it cannot enforce');
    assert.ok(existsSync(join(stubDir, 'receipt', 'last.json')), 'the raw verdict is still captured beside the run');
  } finally {
    process.env.PATH = prevPath;
    delete process.env.CLS_STUB_SECRET;
    rmSync(stubDir, { recursive: true, force: true });
  }

  // --- unexpected tool events: visible in the trail AND fail closed ----------
  // These use the VERBATIM event JSON codex 0.144.1 emitted during the live
  // probe that exposed the gap — a web_search item whose query is empty, so
  // the old `text ? … : null` session mapper dropped it entirely.
  const WEB_SEARCH_STARTED = '{"type":"item.started","item":{"id":"exec-0690","type":"web_search","query":"","action":{"type":"other"}}}';
  const WEB_SEARCH_DONE = '{"type":"item.completed","item":{"id":"exec-0690","type":"web_search","query":"","action":{"type":"other"}}}';

  assert.ok(sessionLineFromCodexEvent(WEB_SEARCH_DONE), 'a textless tool event is no longer dropped from the session trail');
  assert.match(sessionLineFromCodexEvent(WEB_SEARCH_DONE), /web_search/, 'and the trail names the tool');
  const withQuery = sessionLineFromCodexEvent('{"type":"item.completed","item":{"type":"web_search","query":"tokyo time"}}');
  assert.match(withQuery, /tokyo time/, 'when the event carries a query, the receipt records WHAT was consulted');

  // The sealed-vs-local BOUNDARY, pinned so the vocabulary cannot drift: a
  // session line (hardened-seat notice, REFUSED notice) is local and
  // replayable via events.jsonl, and is NOT part of the evidence pack's
  // session_log — so it is not covered by receipt_id. If a future change puts
  // streamed session lines into the pack, that is a deliberate schema decision
  // (it moves receipt_id) and this assertion must be updated on purpose.
  {
    const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');
    const sealedPack = buildEvidencePack({
      goal: 'Boundary probe.',
      acceptanceContract: 'Every material claim is traceable.',
      lane: 'freeform',
      deliverable: '# Note\n\nNo claims.\n',
      evidence: {
        rounds: [{ rev: 1, verdict: 'APPROVED', reviewerModel: 'gpt-5.4', reviewerEffort: 'low', reviewerIdentity: 'openai:gpt-5.4', independence: 'cross_vendor', findings: [], claimAssessments: [], coverageAssessments: [{ criterion_id: 'C1', decision: 'met', evidence: 'traceable' }] }],
        revisions: [{ rev: 1, chars: 20 }],
        verify: [{ pass: true, checks: [{ id: 'links', status: 'pass', detail: 'ok' }] }],
        humanDecisions: [], grounding: null, gateReport: null,
      },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'independent_clean', publication: 'not_published' },
      models: {
        maker: { backend: 'claude', provider: 'anthropic', model: 'sonnet', source: 'checks/models.json' },
        reviewer: { backend: 'codex', provider: 'openai', model: 'gpt-5.4', effort: 'low', modelSource: 'checks/models.json', effortSource: 'checks/models.json' },
      },
      makerActualModels: ['anthropic:claude-sonnet-4-6'],
      simulated: false,
      createdAt: 60,
    });
    const sealedLog = sealedPack.session_log;
    assert.ok(sealedLog.some((l) => l.startsWith('executor seat:')), 'the sealed session_log carries seat/pairing provenance');
    assert.ok(sealedLog.some((l) => l.startsWith('coverage assessment ')), 'and the auditor decisions');
    assert.equal(sealedLog.some((l) => l.includes('hardened seat')), false, 'a streamed session line is NOT in the sealed pack — "local session trail", never "sealed into the evidence pack"');
    assert.equal(sealedLog.some((l) => l.includes('REFUSED')), false, 'a refusal notice is likewise local and replayable, not receipt_id-covered');
  }

  const rogue = unexpectedToolEvent(WEB_SEARCH_STARTED);
  assert.equal(rogue?.itemType, 'web_search', 'the classifier flags a tool a text-only seat never granted');
  assert.equal(unexpectedToolEvent('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'), null, 'reasoning is expected and never flagged');
  assert.equal(unexpectedToolEvent('{"type":"item.completed","item":{"type":"agent_message","text":"verdict"}}'), null, 'the final message is expected');
  assert.equal(unexpectedToolEvent('{"type":"turn.completed","usage":{}}'), null, 'bookkeeping events are not tool use');
  assert.equal(unexpectedToolEvent('not json'), null, 'a torn line is not a false alarm');
  // The forward-looking half: a capability this version has no flag for still
  // fails closed, which is what makes the guard survive a future codex default.
  const future = unexpectedToolEvent('{"type":"item.started","item":{"type":"some_future_tool","name":"whatever"}}');
  assert.equal(future?.itemType, 'some_future_tool', 'an UNKNOWN future tool family is flagged too — the guard is not an allowlist of today\'s flags');
  assert.equal(future.detail, 'whatever', 'and its target is captured');

  // Adapter level: a stub codex that emits a web_search event must make BOTH
  // seats fail closed with the tool named. Deterministic mirror of the live
  // control (which re-enabled search on a real gpt-5.6-sol run and refused).
  const rogueDir = mkdtempSync(join(tmpdir(), 'cls-rogue-'));
  const rogueVerdict = JSON.stringify({ verdict: 'clean', findings: [], questions_for_human: [], claim_assessments: [], coverage_assessments: [], threshold_assessments: [] });
  writeFileSync(join(rogueDir, 'codex'), `#!/bin/sh
printf '%s\\n' '${WEB_SEARCH_STARTED}'
printf '%s\\n' '${WEB_SEARCH_DONE}'
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then printf '%s' '${rogueVerdict.replace(/'/g, "'\\''")}' > "$a"; fi
  prev="$a"
done
sleep 0.4
exit 0
`);
  chmodSync(join(rogueDir, 'codex'), 0o755);
  const prevPath2 = process.env.PATH;
  process.env.PATH = `${rogueDir}:${process.env.PATH}`;
  try {
    const revSessions = [];
    const rogueReview = await runCodexReview({
      prompt: 'judge', cwd: rogueDir, effort: 'low', model: 'gpt-5.4',
      signal: new AbortController().signal, onTick: () => {}, onSession: (l) => revSessions.push(l),
      receiptDir: join(rogueDir, 'receipt'), claims: [], criteria: [], thresholds: [],
    });
    assert.equal(rogueReview.ran, false, 'the REVIEWER fails closed on an unexpected tool event, even though its verdict file was schema-valid');
    assert.match(rogueReview.error, /unexpected web_search tool/, 'the infra error names the tool');
    assert.ok(revSessions.some((l) => l.startsWith('REFUSED:')), 'the refusal is recorded in the reviewer trail');

    const makeSessions = [];
    const rogueMaker = await runCodexMaker({
      prompt: 'draft', stage: 'make', model: 'gpt-5.4', cwd: rogueDir,
      signal: new AbortController().signal, onTick: () => {}, onSession: (l) => makeSessions.push(l),
    });
    assert.equal(rogueMaker.ok, false, 'the MAKER fails closed too, even though its -o payload was present');
    assert.match(rogueMaker.error, /unexpected web_search tool/, 'the maker error names the tool');
    assert.ok(makeSessions.some((l) => l.startsWith('REFUSED:')), 'the refusal is recorded in the maker trail');
  } finally {
    process.env.PATH = prevPath2;
    rmSync(rogueDir, { recursive: true, force: true });
  }
}

// --- field report 2026-08-04 (WP6 game run): gate custody, stop, liveness ------
{
  const { acceptGateReceipt, gatePhaseFromSession, newestActivity, newestFileMtime, ownedReviewWatches, pidAlive, abortOwnedReviewers } = await import('./lib/code-lane.mjs');
  const { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn, execFileSync } = await import('node:child_process');

  // ── RECEIPT CUSTODY ─────────────────────────────────────────────────────────
  // THE field failure: the gate requested round 2, the thin runner dropped the
  // round argument, the reviewer defaulted to r0, and the loop accepted that
  // receipt as round 2. Range alone allowed it; sequence + binding do not.
  const bound = (over) => ({ gate_nonce: 'n1', round_requested: over, round_actual: over, effort_requested: 'high', effort_actual: 'high', bound: true });
  assert.equal(acceptGateReceipt({ round: 1, expectedRound: 1, roundCap: 3, binding: bound(1) }).accept, true, 'the expected round with a matching binding is consumed');
  const outOfSequence = acceptGateReceipt({ round: 3, expectedRound: 2, roundCap: 3, binding: bound(3) });
  assert.equal(outOfSequence.accept, false, 'a receipt for a LATER round is refused while an earlier one is expected');
  assert.match(outOfSequence.reason, /expects round 2/, 'the refusal names the round the run is waiting for');
  assert.equal(acceptGateReceipt({ round: 1, expectedRound: 2, roundCap: 3, binding: bound(1) }).accept, false, 'a repeat of an already-consumed round is refused');
  assert.equal(acceptGateReceipt({ round: 0, expectedRound: 1, roundCap: 3 }).accept, false, 'the r0 receipt the old default produced is out of range');
  assert.equal(acceptGateReceipt({ round: 4, expectedRound: 4, roundCap: 3 }).accept, false, 'a round past the cap is refused even when expected');
  // A receipt whose OWN binding says it was not bound must never be consumed.
  const unboundClaim = acceptGateReceipt({ round: 2, expectedRound: 2, roundCap: 3, binding: { gate_nonce: 'n1', round_requested: 2, round_actual: 0, effort_requested: 'high', effort_actual: 'medium', bound: false } });
  assert.equal(unboundClaim.accept, false, 'the exact field failure: requested r2/high, ran r0/medium — refused');
  assert.match(unboundClaim.reason, /not bound/, 'the refusal quotes the reviewer\'s own binding');
  assert.equal(acceptGateReceipt({ round: 2, expectedRound: 2, roundCap: 3, binding: { ...bound(2), round_requested: 1 } }).accept, false, 'a receipt filed under a round its binding never requested is refused');
  assert.equal(acceptGateReceipt({ round: 2, expectedRound: 2, roundCap: 3, binding: bound(2), nonce: 'n1' }).accept, true, 'a matching gate nonce passes');
  assert.equal(acceptGateReceipt({ round: 2, expectedRound: 2, roundCap: 3, binding: { ...bound(2), gate_nonce: 'other' }, nonce: 'n1' }).accept, false, 'a receipt from another gate run is refused');
  assert.equal(acceptGateReceipt({ round: 2, expectedRound: 2, roundCap: 3, binding: bound(2), worktreeCanonical: '/a/wt', runWorktree: '/b/wt' }).accept, false, 'a receipt from another worktree is refused');
  // A gate installed before binding existed stays resumable, but says so.
  const legacy = acceptGateReceipt({ round: 1, expectedRound: 1, roundCap: 3, binding: null });
  assert.equal(legacy.accept, true, 'a pre-binding gate receipt is still consumable');
  assert.equal(legacy.unbound, true, 'but it is reported unbound rather than treated as verified provenance');

  // ── PHASE SURFACING ─────────────────────────────────────────────────────────
  // Studio showed "Igniting…" for ten minutes while the gate classified,
  // planned, made a worktree, wrote three files and started reviewing.
  assert.equal(gatePhaseFromSession('Bash: bash ~/.claude/skills/camus/scripts/wt.sh create camus-wt-x /p'), 'worktree');
  assert.equal(gatePhaseFromSession('Bash: bash ~/.claude/skills/camus/scripts/review.sh /p/camus-wt-x "task" 2 high'), 'review');
  assert.equal(gatePhaseFromSession('Bash: python3 ~/.claude/skills/camus/scripts/verify.py'), 'verify');
  assert.equal(gatePhaseFromSession('Edit: src/enemy.cs'), 'implement', 'a file edit is the Implement phase');
  assert.equal(gatePhaseFromSession('Bash: bash prep.sh'), 'classify');
  assert.equal(gatePhaseFromSession('Read: notes.md'), null, 'an unrecognized line leaves the phase alone');
  assert.equal(gatePhaseFromSession('Bash: python3 status.py'), null, 'bookkeeping is not a phase');

  // ── LIVENESS ────────────────────────────────────────────────────────────────
  // The regression: a phase-entry heartbeat goes stale during a long Implement
  // or review while real work continues, and the 8-minute watchdog kills it.
  const now = Date.now();
  const stale = now - 9 * 60_000;
  const killWindow = 8 * 60_000;
  const staleOnly = newestActivity({ stdout: stale, heartbeat: stale });
  assert.ok(now - staleOnly.at > killWindow, 'with only a stale heartbeat the watchdog still fires (the guard can fail)');
  const growingReview = newestActivity({ stdout: stale, heartbeat: stale, review_events: now - 10_000 });
  assert.ok(now - growingReview.at < killWindow, 'a growing review event stream keeps a long review alive');
  assert.equal(growingReview.source, 'review_events', 'and the surviving signal is named, so the UI can show why');
  const writingFiles = newestActivity({ stdout: stale, heartbeat: stale, worktree_files: now - 30_000 });
  assert.ok(now - writingFiles.at < killWindow, 'files changing in the worktree keep a long Implement alive — the exact signal that was ignored');
  assert.equal(newestActivity({}).source, 'none', 'no signals is honestly "none", never a fabricated fresh timestamp');

  // newestFileMtime observes real writes and stays bounded.
  const wt = mkdtempSync(join(tmpdir(), 'cls-wt-'));
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'enemy.cs'), 'class Enemy {}');
  const seen = await newestFileMtime(wt);
  assert.ok(seen > 0, 'a written file is observed');
  mkdirSync(join(wt, '.git'), { recursive: true });
  const gitOnly = join(wt, '.git', 'index');
  writeFileSync(gitOnly, 'x');
  const future = new Date(Date.now() + 60_000);
  utimesSync(gitOnly, future, future);
  assert.ok(await newestFileMtime(wt) < future.getTime(), '.git churn is not counted as gate activity');

  // ── STOP OWNS THE DETACHED REVIEWER ─────────────────────────────────────────
  // Studio reported Stopped while the review wrapper survived under PID 1.
  const reviewsDir = join(homedirForTest(), '.camus', 'reviews');
  function homedirForTest() { return process.env.HOME || tmpdir(); }
  assert.equal(pidAlive(process.pid), true, 'the current process reads as alive');
  assert.equal(pidAlive(2_147_483_600), false, 'an absent pid reads as dead');
  assert.equal(pidAlive(null), false, 'a missing pid is never "alive"');
  // A real detached child, registered exactly as the gate registers one, must be
  // ended by Stop — and its death proven, not assumed.
  const prefix = `cls-stoptest-${process.pid}`;
  const watchDir = join(reviewsDir, `${prefix}-r1.watch`);
  mkdirSync(watchDir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  victim.unref();
  try {
    // A REAL started_at: the handle must describe the process that is actually
    // running, which is what lets Stop confirm identity before signalling.
    writeFileSync(join(watchDir, 'handle.json'), JSON.stringify({ pid: victim.pid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: watchDir }));
    const owned = await ownedReviewWatches(prefix);
    assert.equal(owned.length, 1, 'the run finds the watch directory it owns');
    assert.equal(owned[0].pid, victim.pid, 'and reads its detached pid from handle.json');
    assert.equal(pidAlive(victim.pid), true, 'the detached reviewer is running before Stop');
    // No gate script in this fixture path, so the abort form is unavailable —
    // cleanup must still end the process rather than report a clean stop.
    const cleanup = await abortOwnedReviewers(prefix, { scriptPath: join(watchDir, 'no-such-review.sh') });
    assert.equal(cleanup.attempted.length, 1, 'Stop attempted the reviewer it owned');
    assert.equal(cleanup.clean, true, `Stop proved the detached reviewer is gone (${JSON.stringify(cleanup.orphans)})`);
    assert.equal(pidAlive(victim.pid), false, 'the process really is dead — not assumed dead');
    const none = await abortOwnedReviewers(prefix, { scriptPath: join(watchDir, 'no-such-review.sh') });
    assert.equal(none.clean, true, 'a second stop with nothing alive is clean, not a false orphan report');
    assert.equal(none.attempted.length, 0, 'and it does not invent work to do');
    assert.deepEqual(await abortOwnedReviewers(null), { attempted: [], orphans: [], clean: true }, 'a run that never started a reviewer stops clean');

    // ── RECYCLED PID — Stop must not kill a stranger. A handle whose recorded
    // start time does not match the live process is NOT our reviewer (the pid was
    // reused after ours exited), so it is reported, never signalled.
    const strangerDir = join(reviewsDir, `${prefix}-r9.watch`);
    mkdirSync(strangerDir, { recursive: true });
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    stranger.unref();
    // A REAL, EXECUTABLE abort script that records every invocation. The safety
    // property is not just "the stranger survives" — it is "the abort form was
    // never even invoked", because `review.sh abort` terminates the handle's pid
    // and so is itself the recycled-pid hazard. The marker file proves it.
    const abortLog = join(strangerDir, 'abort-invoked.log');
    const abortScript = join(strangerDir, 'review.sh');
    writeFileSync(abortScript, `#!/bin/sh\necho "$@" >> ${JSON.stringify(abortLog)}\nexit 0\n`);
    execFileSync('chmod', ['+x', abortScript]);
    try {
      writeFileSync(join(strangerDir, 'handle.json'), JSON.stringify({ pid: stranger.pid, started_at: 1, cmd: ['codex'], cwd: strangerDir }));
      const recycled = await abortOwnedReviewers(prefix, { scriptPath: abortScript });
      assert.equal(existsSync(abortLog), false, 'the abort form was NOT invoked for an unverified pid — no signal path is opened until identity is proven');
      assert.equal(pidAlive(stranger.pid), true, 'an unidentifiable pid is NOT killed on the strength of a stale handle');
      assert.equal(recycled.clean, false, 'and the run reports it rather than claiming a clean stop');
      assert.equal(recycled.attempted[0].aborted, false, 'the record shows no abort was attempted');
      assert.match(recycled.orphans[0].note, /neither the abort form nor any signal was sent/, 'the report says the abort form was withheld, not merely that a kill failed');
    } finally {
      try { process.kill(stranger.pid, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(strangerDir, { recursive: true, force: true });
    }

    // ── PROCESS GROUP, not leader pid (live run 20260805-072933-jezu). Studio
    // said "ended 1/1 detached reviewer" while a codex GROUP was still alive:
    // review_watch starts each reviewer with start_new_session, so codex's
    // children outlive a dead leader. Survival is judged on the whole group.
    {
      const { processGroupAlive } = await import('./lib/code-lane.mjs');
      // A group whose leader is gone but whose children remain is ALIVE.
      assert.equal(processGroupAlive(4242, { ps: () => ' 4243\n 4244\n' }), true, 'surviving group members keep the group alive even when the leader is gone');
      assert.equal(processGroupAlive(4242, { ps: () => '' }), false, 'an empty group listing means the group is really gone');
      assert.equal(processGroupAlive(2_147_483_600, { ps: () => null }), false, 'when ps is unusable, a known-absent leader remains gone');
      assert.equal(processGroupAlive(process.pid, { ps: () => null }), true, 'when ps is unusable, a live leader remains conservatively alive');
      assert.equal(processGroupAlive(process.pid, { ps: () => ` ${process.pid}\n` }), true, 'a live group is reported alive');
      assert.equal(processGroupAlive(0), false, 'a nonsense pgid is not a live group');
    }

    // ── REAL PROCESSES: leader exits, child survives in the same PGID ─────────
    // The exact WP6 shape: review_watch starts the reviewer with its own session
    // (pid == pgid), codex spawns children into that group, and the leader can
    // exit first. Discovery used to gate on pidAlive(leader) and SKIPPED such a
    // group entirely — a false clean over a live codex child. No mocks here: a
    // real detached `sh` leader backgrounds a real `sleep` into its group and
    // exits; cleanup must find the group, terminate it, and only then say clean.
    {
      const orphanDir = join(reviewsDir, `${prefix}-r5.watch`);
      mkdirSync(orphanDir, { recursive: true });
      const oAbort = join(orphanDir, 'review.sh');
      writeFileSync(oAbort, '#!/bin/sh\nexit 0\n'); // abort form is a no-op: the GROUP kill must do the work
      execFileSync('chmod', ['+x', oAbort]);
      // NOT unref'd: the await below needs the child handle to keep the event
      // loop alive until 'exit' fires (an unref'd handle lets node exit 13 with
      // the top-level await unfinished). The leader exits in milliseconds.
      const leader = spawn('sh', ['-c', 'sleep 120 & exit 0'], { detached: true, stdio: 'ignore' });
      const pgid = leader.pid;
      try {
        await new Promise((resolve) => leader.on('exit', resolve));
        const groupPids = () => {
          try {
            return execFileSync('ps', ['-g', String(pgid), '-o', 'pid='], { encoding: 'utf8' })
              .split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
          } catch { return []; }
        };
        assert.equal(pidAlive(pgid), false, 'PRECONDITION: the leader is dead');
        assert.ok(groupPids().length >= 1, 'PRECONDITION: a child survives in the leader\'s group');
        writeFileSync(join(orphanDir, 'handle.json'), JSON.stringify({ pid: pgid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: orphanDir }));
        const swept = await abortOwnedReviewers(prefix, { scriptPath: oAbort });
        assert.ok(swept.attempted.some((a) => a.dir === orphanDir), 'the leaderless group is DISCOVERED, not skipped as dead');
        assert.equal(groupPids().length, 0, 'the surviving group member is actually terminated');
        assert.equal(swept.clean, true, 'and only a genuinely empty group seals a clean stop');
      } finally {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
        rmSync(orphanDir, { recursive: true, force: true });
      }
    }

    // AT THE CALL SITE, not just in the helper: a reviewer whose LEADER exited
    // while its group survives must be reported as an orphan, so Stop cannot seal
    // a clean `stopped` over a live codex group (the exact false "ended 1/1" claim).
    {
      const survivorDir = join(reviewsDir, `${prefix}-r6.watch`);
      mkdirSync(survivorDir, { recursive: true });
      const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      leader.unref();
      const sAbort = join(survivorDir, 'review.sh');
      writeFileSync(sAbort, '#!/bin/sh\nexit 0\n');
      execFileSync('chmod', ['+x', sAbort]);
      try {
        writeFileSync(join(survivorDir, 'handle.json'), JSON.stringify({ pid: leader.pid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: survivorDir }));
        const groupSurvives = await abortOwnedReviewers(prefix, { scriptPath: sAbort, groupAlive: () => true });
        assert.equal(groupSurvives.clean, false, 'a surviving process GROUP means the stop is not clean, even after the leader is signalled');
        // Target THIS dir, not a global count: the injected always-alive groupAlive
        // legitimately sweeps any other fixture dirs under the prefix too.
        assert.ok(groupSurvives.orphans.some((o) => o.dir === survivorDir), 'and the survivor is reported as an orphan');
        const leaderOnly = await abortOwnedReviewers(prefix, { scriptPath: sAbort, groupAlive: () => false });
        assert.equal(leaderOnly.clean, true, 'a genuinely empty group is a clean stop (the control: this assertion can pass)');
      } finally {
        try { process.kill(leader.pid, 'SIGKILL'); } catch { /* already gone */ }
        rmSync(survivorDir, { recursive: true, force: true });
      }
    }

    // POSITIVE CONTROL — a VERIFIED reviewer must actually invoke the abort form,
    // or the assertion above would pass on a script that never fires.
    const verifiedDir = join(reviewsDir, `${prefix}-r7.watch`);
    mkdirSync(verifiedDir, { recursive: true });
    const verifiedVictim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    verifiedVictim.unref();
    const vAbortLog = join(verifiedDir, 'abort-invoked.log');
    const vAbortScript = join(verifiedDir, 'review.sh');
    writeFileSync(vAbortScript, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$CAMUS_REVIEWER" "$CAMUS_MAKER_TRAINING_ORG" "$*" >> ${JSON.stringify(vAbortLog)}\nexit 0\n`);
    execFileSync('chmod', ['+x', vAbortScript]);
    try {
      writeFileSync(join(verifiedDir, 'handle.json'), JSON.stringify({ pid: verifiedVictim.pid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: verifiedDir }));
      const cleaned = await abortOwnedReviewers(prefix, {
        scriptPath: vAbortScript,
        reviewerBackend: 'codex',
        makerTrainingOrg: 'anthropic',
      });
      assert.equal(existsSync(vAbortLog), true, 'a VERIFIED reviewer DOES invoke the abort form (so the negative control above is meaningful)');
      assert.match(readFileSync(vAbortLog, 'utf8'), /^codex\|anthropic\|abort /, 'the abort form receives the run snapshot\'s backend and maker-origin evidence');
      assert.equal(cleaned.clean, true, 'and the verified reviewer is proven gone');
      assert.equal(pidAlive(verifiedVictim.pid), false);
    } finally {
      try { process.kill(verifiedVictim.pid, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(verifiedDir, { recursive: true, force: true });
    }

    // ── COMPLETED reviewer — a watch dir with an exit_code is finished; its pid
    // may since belong to anything, so it is never a termination target.
    const doneDir = join(reviewsDir, `${prefix}-r8.watch`);
    mkdirSync(doneDir, { recursive: true });
    writeFileSync(join(doneDir, 'handle.json'), JSON.stringify({ pid: process.pid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: doneDir }));
    writeFileSync(join(doneDir, 'exit_code'), '0\n');
    try {
      const completedOnly = await abortOwnedReviewers(prefix, { scriptPath: join(doneDir, 'no-such-review.sh') });
      assert.equal(completedOnly.attempted.length, 0, 'a completed watch dir is not a termination target (this test process would have been the victim)');
      assert.equal(completedOnly.clean, true, 'and stopping with only completed reviewers is clean');
      const listed = await ownedReviewWatches(prefix);
      assert.equal(listed.find((w) => w.round === 8)?.completed, true, 'the completed reviewer is still LISTED, just not killable');
    } finally {
      rmSync(doneDir, { recursive: true, force: true });
    }
  } finally {
    try { process.kill(victim.pid, 'SIGKILL'); } catch { /* already reaped */ }
    rmSync(watchDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
}

// --- audit round 2 (2026-08-04): the PRE-RECEIPT path -------------------------
// The previous round's helpers were right but only reachable after a completed
// receipt: ownedPrefix, worktree and nonce all came from the first rN.json. So
// Stop during Implement or an active r1 found nothing, liveness could not see a
// live Implement, and progress stayed "Igniting". The durable status record is
// what closes that window; these tests drive it, not the helpers in isolation.
{
  const { readGateStatus, prefixFromWorktree, pidMatchesHandle, newestActivity, acceptGateReceipt, ownedReviewWatches, abortOwnedReviewers } = await import('./lib/code-lane.mjs');
  const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn, execFileSync } = await import('node:child_process');

  const feats = mkdtempSync(join(tmpdir(), 'cls-feats-'));
  const salt = 'studio-pre-receipt';
  const wtPath = join(feats, 'wt', 'camus-wt-task-abc123');
  mkdirSync(wtPath, { recursive: true });
  const statusScript = join(process.cwd(), '..', '..', 'packages', 'cli', 'skills', 'camus', 'scripts', 'status_record.py');

  // Write the record the way the GATE does — through the production script, not
  // a hand-built fixture, so the shape the reader consumes is the shape the
  // writer emits.
  const writeStatus = (args) => execFileSync('python3', [statusScript, 'write', '--salt', salt, ...args], {
    env: { ...process.env, CAMUS_FEATS_DIR: feats }, encoding: 'utf8',
  });

  writeStatus(['--nonce', 'studio-pre-receipt:abc123', '--phase', 'Implement', '--worktree', wtPath, '--branch', 'camus/task-abc123', '--round', '1', '--effort', 'high']);
  const status = await readGateStatus(salt, { feats });
  assert.ok(status, 'the durable status is readable BEFORE any receipt exists');
  assert.equal(status.phase, 'Implement', 'so progress can say Implement instead of Igniting');
  assert.equal(status.worktree, wtPath, 'and the worktree is known before any receipt');
  assert.equal(status.nonce, 'studio-pre-receipt:abc123', 'and the nonce, which acceptance needs');
  assert.equal(prefixFromWorktree(status.worktree), 'camus-wt-task-abc123', 'the owned review prefix derives from it, so Stop can find reviewers pre-receipt');
  assert.equal(await readGateStatus('no-such-salt', { feats }), null, 'an absent record reads null, never a fabricated phase');
  assert.equal(prefixFromWorktree(null), null, 'and no worktree yields no prefix rather than a wrong one');

  // The MAPPING THE WATCHER USES (not a re-derivation): what the run adopts from
  // a durable status record. If the watcher stops consuming this, these fail.
  const { gateStateFromStatus } = await import('./lib/code-lane.mjs');
  const adopted = gateStateFromStatus(status);
  assert.equal(adopted.prefix, 'camus-wt-task-abc123', 'the watcher adopts the owned prefix pre-receipt');
  assert.equal(adopted.worktree, wtPath, 'and the worktree, so file activity can be scanned during Implement');
  assert.equal(adopted.nonce, 'studio-pre-receipt:abc123', 'and the nonce, so receipts can be bound to this run');
  assert.equal(adopted.phase, 'implement', 'and the phase, so progress is not "Igniting"');
  assert.equal(adopted.branch, 'camus/task-abc123');
  assert.ok(adopted.progressAt > 0, 'and a durable progress timestamp for liveness');
  assert.equal(gateStateFromStatus(null), null, 'no record yields no state, never invented values');
  assert.equal(gateStateFromStatus({ phase: '' }).phase, null, 'an empty phase is absent, not a phase named ""');

  // LIVENESS during a long Implement: the gate's durable progress advances while
  // the phase-entry heartbeat is long stale. This is the exact kill the field
  // report hit at eight minutes.
  const now = Date.now();
  const stale = now - 9 * 60_000;
  const killWindow = 8 * 60_000;
  writeStatus(['--phase', 'Implement', '--progress-note', 'wrote Enemy.cs']);
  const fresh = await readGateStatus(salt, { feats });
  const live = newestActivity({ stdout: stale, heartbeat: stale, gate_status: fresh.last_progress_at * 1000 });
  assert.ok(now - live.at < killWindow, 'a gate reporting progress mid-Implement is NOT judged idle');
  assert.equal(live.source, 'gate_status', 'and the surviving signal names the gate itself');

  // ACCEPTANCE against Studio's snapshot, which is the gap the auditor found:
  // requested r2/high, reviewer ran r2/medium, receipt internally consistent.
  const selfConsistent = {
    gate_nonce: 'studio-pre-receipt:abc123', round_requested: 2, round_actual: 2,
    effort_requested: 'medium', effort_actual: 'medium', reviewer_model: 'gpt-5.6-sol', bound: true,
  };
  const wrongEffort = acceptGateReceipt({
    round: 2, expectedRound: 2, roundCap: 3, binding: selfConsistent,
    nonce: 'studio-pre-receipt:abc123', expectedEffort: 'high', expectedReviewerModel: 'gpt-5.6-sol',
  });
  assert.equal(wrongEffort.accept, false, 'a self-consistent receipt that ran the WRONG effort is refused against the snapshot');
  assert.match(wrongEffort.reason, /requested "high"/, 'and the refusal quotes the run-start decision');
  const wrongModel = acceptGateReceipt({
    round: 2, expectedRound: 2, roundCap: 3,
    binding: { ...selfConsistent, effort_requested: 'high', effort_actual: 'high', reviewer_model: 'gpt-4o-mini' },
    nonce: 'studio-pre-receipt:abc123', expectedEffort: 'high', expectedReviewerModel: 'gpt-5.6-sol',
  });
  assert.equal(wrongModel.accept, false, 'a receipt from a different reviewer model is refused against the snapshot');
  const right = acceptGateReceipt({
    round: 2, expectedRound: 2, roundCap: 3,
    binding: { ...selfConsistent, effort_requested: 'high', effort_actual: 'high' },
    nonce: 'studio-pre-receipt:abc123', expectedEffort: 'high', expectedReviewerModel: 'gpt-5.6-sol',
  });
  assert.equal(right.accept, true, 'the faithful receipt is still accepted (the guard does not overfire)');
  // Once bound receipts are known, an unbound one may not authorize a round.
  const unboundAfterBound = acceptGateReceipt({ round: 3, expectedRound: 3, roundCap: 3, binding: null, requireBinding: true });
  assert.equal(unboundAfterBound.accept, false, 'a legacy unbound receipt cannot authorize a round on a binding gate');
  assert.equal(acceptGateReceipt({ round: 3, expectedRound: 3, roundCap: 3, binding: null }).accept, true, 'while a genuinely legacy gate stays readable');
  // A binding missing the fields Studio must check fails closed.
  assert.equal(acceptGateReceipt({
    round: 2, expectedRound: 2, roundCap: 3,
    binding: { round_requested: 2, round_actual: 2, effort_requested: 'high', effort_actual: 'high', bound: true },
    nonce: 'n', expectedReviewerModel: 'gpt-5.6-sol',
  }).accept, false, 'a binding with no reviewer model or nonce cannot be checked, so it is refused');

  // STOP DURING AN ACTIVE r1 — no r1 json exists yet. The reviewer is
  // discoverable only through the status-derived prefix.
  const reviewsDir = join(process.env.HOME || tmpdir(), '.camus', 'reviews');
  const prefix = `cls-prereceipt-${process.pid}`;
  const watchDir = join(reviewsDir, `${prefix}-r1.watch`);
  mkdirSync(watchDir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  victim.unref();
  try {
    writeFileSync(join(watchDir, 'handle.json'), JSON.stringify({ pid: victim.pid, started_at: Math.floor(Date.now() / 1000), cmd: ['codex'], cwd: watchDir }));
    writeFileSync(join(watchDir, 'events.jsonl'), '{"type":"thread.started"}\n');
    const owned = await ownedReviewWatches(prefix);
    assert.equal(owned.length, 1, 'an ACTIVE r1 reviewer is discoverable with no r1 receipt on disk');
    assert.equal(owned[0].completed, false, 'and it is not mistaken for a finished one');
    assert.equal(await pidMatchesHandle(victim.pid, Math.floor(Date.now() / 1000)), true, 'its identity is confirmable');
    // Its growing event stream is liveness for a first review that has produced
    // no receipt yet.
    const r1Live = newestActivity({ stdout: stale, heartbeat: stale, review_events: owned[0].eventsMtime });
    assert.ok(now - r1Live.at < killWindow, 'an active first review is kept alive by its own event stream');
    const cleanup = await abortOwnedReviewers(prefix, { scriptPath: join(watchDir, 'no-such-review.sh') });
    assert.equal(cleanup.clean, true, `Stop during an active r1 ends the reviewer (${JSON.stringify(cleanup.orphans)})`);
    assert.equal(pidAliveLocal(victim.pid), false, 'and proves it is gone');
  } finally {
    try { process.kill(victim.pid, 'SIGKILL'); } catch { /* reaped */ }
    rmSync(watchDir, { recursive: true, force: true });
    rmSync(feats, { recursive: true, force: true });
  }
  function pidAliveLocal(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
}

// --- pragmatic decision flow: Refine RE-ENTERS terminal handling ---------------
// The field failure a correction round later would find: Refine re-invoked the
// gate but never re-classified the NEW report, so a run reported the stale
// needs_human_offline outcome. resolveGateTerminal now loops, so a Refine that
// returns another review_unresolved re-enters the decision, and a Refine that
// converges to done returns done.
{
  const { resolveGateTerminal } = await import('./lib/code-lane.mjs');
  const harness = (reports, answersToGive) => {
    const events = [];
    const asked = [];
    let ignites = 0;
    let ai = 0;
    const igniteGate = async () => { ignites += 1; return reports[ignites]; }; // reports[0] is the first, already in hand
    const ask = async (q) => { asked.push(q); return answersToGive[ai++]; };
    return {
      run: () => resolveGateTerminal(reports[0], {
        emit: (t, d) => events.push({ t, ...d }),
        log: () => {}, stage: () => {}, ask, igniteGate, answers: [],
      }),
      events, asked, ignites: () => ignites,
    };
  };
  const greenUnresolved = (n) => ({ status: 'review_unresolved', verifyClean: true, parkedSha: `sha${n}`, branch: 'camus/x', blocking: [{ priority: 1, title: `open${n}` }] });
  const doneReport = { status: 'done', parkedSha: 'shaFinal' };

  // Refine → the gate converges to done → the run returns DONE, never the stale
  // needs_human_offline / done_with_findings from the first report.
  {
    const h = harness([greenUnresolved(1), doneReport], ['Refine: run more review/fix rounds on the open findings']);
    const res = await h.run();
    assert.equal(res.status, 'done', 'a Refine that converges returns done, not the stale unresolved outcome');
    assert.equal(h.ignites(), 1, 'the gate was re-invoked exactly once for the single Refine');
    assert.ok(h.events.some((e) => e.t === 'status' && e.status === 'done'), 'the terminal status event is done');
  }

  // Refine → the gate returns ANOTHER review_unresolved → the decision RE-OPENS
  // (not a stale return); accepting the second time yields done_with_findings.
  {
    const h = harness([greenUnresolved(1), greenUnresolved(2)], [
      'Refine: run more review/fix rounds on the open findings',
      'Accept the reviewed risk and keep the candidate parked for final human merge',
    ]);
    const res = await h.run();
    assert.equal(res.status, 'done_with_findings', 'a repeated unresolved re-opens the decision rather than returning stale');
    assert.equal(h.asked.length, 2, 'the human was asked again after the Refine returned another unresolved report');
    assert.equal(res.parkedSha, 'sha2', 'and the candidate is the SECOND (refined) parked commit, not the first');
    assert.equal(res.accepted, true);
    assert.equal(res.landed, false, 'Studio never claims a land: accept keeps the candidate parked for the human merge');
  }

  // Accept vs Leave are visibly different decisions that both preserve the park.
  {
    const accept = await harness([greenUnresolved(1)], ['Accept the reviewed risk and keep the candidate parked for final human merge']).run();
    const leave = await harness([greenUnresolved(1)], ['Leave it parked and stop here']).run();
    assert.equal(accept.status, 'done_with_findings');
    assert.equal(leave.status, 'done_with_findings');
    assert.equal(accept.accepted, true, 'Accept records the risk decision');
    assert.equal(leave.accepted, false, 'Leave does not');
    assert.equal(accept.parkedSha, 'sha1');
    assert.equal(leave.parkedSha, 'sha1', 'both preserve the same parked candidate');
    assert.equal(accept.landed, false);
    assert.equal(leave.landed, false, 'neither claims a merge');
  }

  // The refine budget is bounded: after refineCap refines the option is withdrawn.
  {
    const asked = [];
    let asks = 0;
    let ignites = 0;
    // Always try to Refine; the flow withdraws the option past the cap, so the
    // final ask cannot return a Refine and the loop must terminate.
    const ask = async (q) => {
      asked.push(q);
      asks += 1;
      const refine = q.options.find((o) => o.startsWith('Refine'));
      return refine ?? 'Leave it parked and stop here';
    };
    const res = await resolveGateTerminal(greenUnresolved(0), {
      emit: () => {}, log: () => {}, stage: () => {}, ask,
      igniteGate: async () => { ignites += 1; return greenUnresolved(ignites); },
      answers: [], refineCap: 2,
    });
    assert.equal(ignites, 2, 'refineCap=2 allows exactly two re-invocations');
    assert.ok(!asked.at(-1).options.some((o) => o.startsWith('Refine')), 'past the cap, Refine is no longer offered');
    assert.equal(res.status, 'done_with_findings', 'and the run resolves rather than looping forever');
  }

  // ── INTEGRATION: a retry green must reach the SEALED RECEIPT, commit-bound ──
  // The reproduced defect (field report 2026-08-05): the retry event carried no
  // commitSha and derivation preferred the ORIGINAL inconclusive event, so the UI
  // could say green while the receipt sealed
  //   {execution: completed, verification: infra_failed, audit: independent_clean}.
  // This drives the REAL deriveEvidence → deriveStatusDimensions → buildEvidencePack
  // chain, not the pure resolver, because that is where the defect lived.
  {
    const { deriveEvidence } = await import('./lib/evidence.mjs');
    const { deriveStatusDimensions, deriveHeadline } = await import('./lib/status-dims.mjs');
    const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const gateReport = { status: 'verify_inconclusive', commit_sha: HEAD, branch: 'camus/wp6', parkedSha: HEAD };
    // The exact event order a recovery produces: the gate's inconclusive verdict,
    // then Studio's host-side re-verify of the same commit.
    const events = [
      { type: 'review', round: 1, scope: 'round', rev: 1, verdict: 'APPROVED', source: 'camus_gate_review', reviewerModel: 'gpt-5.6-sol', reviewerEffort: 'high', findings: [], claimAssessments: [], coverageAssessments: [] },
      { type: 'gate_report', report: gateReport },
      { type: 'verify_result', pass: null, warnings: null, skipped: null, source: 'gate_report_status', derived: true, commitSha: HEAD },
      { type: 'verify_result', pass: true, warnings: 0, skipped: 0, checks: [], source: 'studio_reverify', commitSha: HEAD },
    ];
    const evidence = deriveEvidence(events);
    const dims = deriveStatusDimensions({ lane: 'build', status: 'done', evidence, published: false });
    assert.equal(dims.verification, 'passed', `the sealed dimensions honour the retry green (got ${dims.verification})`);
    assert.notEqual(dims.verification, 'infra_failed', 'the reproduced infra_failed receipt must not come back');
    const { schemaVersion, ...forHeadline } = dims;
    assert.equal(deriveHeadline(forHeadline), 'verified', 'a clean review plus a bound retry green derives VERIFIED');

    // And the pack seals it against the candidate HEAD.
    const pack = buildEvidencePack({
      goal: 'WP6 enemy combat', acceptanceContract: 'Deterministic checks pass on the parked candidate.',
      lane: 'build', targetPath: '/repo', evidence, statuses: dims,
      models: { maker: { backend: 'claude', provider: 'anthropic', model: 'opus' },
                reviewer: { backend: 'codex', provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
      simulated: false, verifyCommand: 'dotnet test tests/App.Tests/App.Tests.csproj -f net10.0', createdAt: 500,
    });
    assert.equal(pack.artifact.head, HEAD, 'the sealed artifact binds the candidate HEAD');
    assert.equal(pack.statuses.verification, 'passed', 'and the pack seals verification as passed');
    // A receipt that says "verified" must say WHAT was run to earn that. The pack
    // hardcoded command:null, so an override-driven green named nothing.
    assert.equal(pack.verification.command, 'dotnet test tests/App.Tests/App.Tests.csproj -f net10.0',
      'the explicit verify command is sealed into the pack');
    // …and it is receipt-COVERED: changing the command changes the receipt id.
    const otherCmd = buildEvidencePack({
      goal: 'WP6 enemy combat', acceptanceContract: 'Deterministic checks pass on the parked candidate.',
      lane: 'build', targetPath: '/repo', evidence, statuses: dims,
      models: { maker: { backend: 'claude', provider: 'anthropic', model: 'opus' },
                reviewer: { backend: 'codex', provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
      simulated: false, verifyCommand: 'dotnet test --filter Category!=Everything', createdAt: 500,
    });
    assert.notEqual(otherCmd.receipt_id, pack.receipt_id, 'the sealed command is covered by receipt_id, not decoration');
    // Absent means absent: auto-detection, never a guessed command.
    const autoDetected = buildEvidencePack({
      goal: 'WP6 enemy combat', acceptanceContract: 'Deterministic checks pass on the parked candidate.',
      lane: 'build', targetPath: '/repo', evidence, statuses: dims,
      models: { maker: { backend: 'claude', provider: 'anthropic', model: 'opus' },
                reviewer: { backend: 'codex', provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
      simulated: false, createdAt: 500,
    });
    assert.equal(autoDetected.verification.command, null, 'no explicit command seals null, never an invented one');

    // AN UNBOUND retry green must NOT be honoured — that is the whole guard.
    const unbound = deriveEvidence([...events.slice(0, 3),
      { type: 'verify_result', pass: true, source: 'studio_reverify' }]);
    assert.notEqual(deriveStatusDimensions({ lane: 'build', status: 'done', evidence: unbound }).verification, 'passed',
      'a retry green with no commitSha is refused, so "latest" can never mean "unbound"');
    // A retry bound to the WRONG commit is refused too.
    const wrongSha = deriveEvidence([...events.slice(0, 3),
      { type: 'verify_result', pass: true, source: 'studio_reverify', commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }]);
    assert.notEqual(deriveStatusDimensions({ lane: 'build', status: 'done', evidence: wrongSha }).verification, 'passed',
      'a retry green bound to another commit certifies nothing here');
    // A retry that comes back RED is a real red, not a resurrected inconclusive.
    const red = deriveEvidence([...events.slice(0, 3),
      { type: 'verify_result', pass: false, source: 'studio_reverify', commitSha: HEAD }]);
    assert.equal(deriveStatusDimensions({ lane: 'build', status: 'verify_failed', evidence: red }).verification, 'failed',
      'a bound retry red is honoured as failed');
  }
  {
    // The resolver half: review-clean → done, unresolved review → done_with_findings,
    // and the emitted retry event is commit-bound. The fixture head EQUALS the
    // parked sha because that is what really happens: verify.py reports the head
    // of the parked worktree it just checked.
    const PARKED = 'feedfacefeedfacefeedfacefeedfacefeedface';
    const seen = [];
    const deps = { emit: (t, d) => seen.push({ t, ...d }), log: () => {}, stage: () => {}, igniteGate: async () => ({ status: 'done' }), answers: [],
      ask: async (q) => q.options.find((o) => o.startsWith('Retry')),
      verifyCandidate: async () => ({ ran: true, pass: true, raw: { head: PARKED } }) };
    const clean = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: PARKED, branch: 'camus/x' }, deps);
    assert.equal(clean.status, 'done', 'a review-clean candidate that verifies on retry is DONE, not done_with_findings');
    assert.equal(clean.verifiedSha, PARKED, 'the resolved sha is recorded');
    const emitted = seen.filter((e) => e.t === 'verify_result' && e.source === 'studio_reverify').at(-1);
    assert.equal(emitted.commitSha, PARKED, 'the retry event is COMMIT-BOUND to the verified head');
    assert.equal(emitted.source, 'studio_reverify');
    const unresolved = await resolveGateTerminal({ status: 'review_unresolved', verifyClean: null, parkedSha: PARKED, blocking: [{ priority: 1, title: 'open' }] }, deps);
    assert.equal(unresolved.status, 'done_with_findings', 'an unresolved review keeps the findings qualifier even when verification passes');
    // ── THE SHA MUST COME FROM THE VERIFIER ────────────────────────────────────
    // This previously substituted the parked sha when the verifier reported no
    // head, which asserts "the parked commit was checked" on no evidence at all.
    // Both shapes below must refuse: no verdict emitted, nothing resolved.
    const retryOnce = (verifyCandidate, sink) => {
      let asked = 0;
      return resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha-parked' }, {
        ...deps,
        emit: (t, d) => sink.push({ t, ...d }),
        verifyCandidate,
        // Retry first, then leave it parked — a faithful human, not a spin.
        ask: async (q) => (asked++ === 0 ? q.options.find((o) => o.startsWith('Retry')) : q.options.find((o) => o.startsWith('Leave'))),
      });
    };
    for (const [label, raw] of [
      ['no head reported', {}],
      ['a head for a DIFFERENT commit', { head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
    ]) {
      const sink = [];
      const out = await retryOnce(async () => ({ ran: true, pass: true, raw }), sink);
      const emitted = sink.filter((e) => e.t === 'verify_result' && e.source === 'studio_reverify');
      assert.equal(emitted.length, 0, `${label}: no verify_result is emitted — an unbindable result is not evidence`);
      assert.ok(!['done', 'done_with_findings', 'verify_failed'].includes(out.status),
        `${label}: nothing is resolved (got ${out.status})`);
      assert.equal(out.status, 'needs_decision', `${label}: the candidate stays parked for a human`);
      assert.equal(out.parkedSha, 'sha-parked', `${label}: the parked candidate is preserved`);
      assert.ok(!('verifiedSha' in out), `${label}: no verified sha is claimed`);
    }
    // A verifier that never produces a bindable verdict must not spin forever:
    // an auto-answering caller lands on the safe default instead of hanging.
    {
      const sink = [];
      const out = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha-parked' }, {
        ...deps, emit: (t, d) => sink.push({ t, ...d }),
        verifyCandidate: async () => ({ ran: true, pass: true, raw: {} }),   // always unbindable
      });                                                                    // deps.ask always retries
      assert.equal(out.status, 'needs_decision', 'unbounded retrying is bounded, and the safe default is parked');
      // Scoped to the RETRY source on purpose: the gate's own derived inconclusive
      // event is in this list legitimately, and a bare `type` filter would pass
      // for the wrong reason.
      assert.equal(sink.filter((e) => e.t === 'verify_result' && e.source === 'studio_reverify').length, 0,
        'and still no fabricated verdict from any of the attempts');
    }
  }

  // ── THE VERIFIER BODY ACTUALLY RUNS ────────────────────────────────────────
  // makeCandidateVerifier called `extractJsonObject`, which does not exist in this
  // codebase. Every test to date injected a fake verifyCandidate, so its body had
  // never executed: the first real retry would have thrown ReferenceError and taken
  // the server down. Found by driving the recovery for real (2026-08-05). These
  // assertions run the body — subprocess, env, stdout, parse, mapping.
  {
    const { makeCandidateVerifier, extractVerifyResult, groupIsGone } = await import('./lib/code-lane.mjs');
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');

    // The parser: the real result NESTS objects, and the guard can print first.
    const real = 'camus_guard: some note\n{"pass": true, "inconclusive": false, "failures": [], "checks": [{"name": "t", "cmd": ["x"], "exit": 0}], "head": "abc123"}\n';
    assert.equal(extractVerifyResult(real).head, 'abc123', 'a nested result object is extracted past leading noise');
    assert.equal(extractVerifyResult('{"inconclusive": true}'), null, 'an object with no boolean pass is not a result');
    assert.equal(extractVerifyResult('no json here'), null, 'prose yields nothing rather than a guess');
    assert.equal(extractVerifyResult(''), null, 'empty output yields nothing');

    const dir = mkdtempSync(pjoin(tmpdir(), 'cls-verifier-'));
    const stub = pjoin(dir, 'verify-stub.sh');
    const write = (bodyLines) => { writeFileSync(stub, `#!/usr/bin/env bash\n${bodyLines}\n`); chmodSync(stub, 0o755); };

    // A green that names its head, and CAMUS_VERIFY_CMD really reaches the script.
    write('printf \'{"pass": true, "inconclusive": false, "failures": [], "checks": [], "head": "%s"}\\n\' "${CAMUS_VERIFY_CMD:-none}"');
    const green = await makeCandidateVerifier({ worktree: dir, verifyCmd: 'pnpm test', scriptPath: stub })();
    assert.equal(green.ran, true, 'the verifier body runs a real subprocess');
    assert.equal(green.pass, true, 'and reports a green');
    assert.equal(green.raw.head, 'pnpm test', 'CAMUS_VERIFY_CMD is passed through to the script');

    // inconclusive maps to the WITHHELD verdict, not to red.
    write('printf \'{"pass": false, "inconclusive": true, "failures": [{"stage":"verify","kind":"missing_tool"}], "checks": []}\\n\'');
    const amber = await makeCandidateVerifier({ worktree: dir, scriptPath: stub })();
    assert.equal(amber.ran, true);
    assert.equal(amber.pass, null, 'inconclusive maps to pass:null, never false');

    write('printf \'{"pass": false, "inconclusive": false, "failures": [{"stage":"test"}], "checks": []}\\n\'');
    assert.equal((await makeCandidateVerifier({ worktree: dir, scriptPath: stub })()).pass, false, 'a real red stays red');

    // ── STOP TERMINATES THE VERIFIER'S PROCESS GROUP ───────────────────────────
    // A `dotnet test` sweep runs for minutes. The verifier used to be started with
    // execFile and no signal, so Stop marked the run and then WAITED for the command
    // — up to fifteen minutes, with tests still churning in the operator's worktree.
    // This uses a real long-lived group with a child that outlives its parent shell,
    // which is what a build tool actually looks like.
    {
      write([
        // A grandchild that would survive a signal sent only to the parent.
        'sleep 600 &',
        'child=$!',
        'echo "child=$child" > "$1/child.pid"',
        'sleep 600',
      ].join('\n'));
      const probeDir = mkdtempSync(pjoin(tmpdir(), 'cls-verifygrp-'));
      const ac = new AbortController();
      const verify = makeCandidateVerifier({ worktree: probeDir, scriptPath: stub, signal: ac.signal, termGraceMs: 400 });
      const running = verify();
      // Wait until the tree really exists, so the test cannot pass by racing ahead.
      const { readFileSync: rf, existsSync: ex } = await import('node:fs');
      let childPid = null;
      for (let i = 0; i < 60 && !childPid; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (ex(pjoin(probeDir, 'child.pid'))) childPid = Number(String(rf(pjoin(probeDir, 'child.pid'), 'utf8')).split('=')[1]);
      }
      assert.ok(childPid && childPid > 0, 'the probe verifier really started a child process');
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      assert.equal(alive(childPid), true, 'and that child is alive before the stop');

      const t0 = Date.now();
      ac.abort();
      const res = await running;
      const elapsed = Date.now() - t0;

      assert.equal(res.ran, false, 'a stopped verification produces no verdict');
      assert.equal(res.stopped, true, 'and is reported as stopped');
      assert.equal(res.groupTerminated, true, `the owned process GROUP was terminated (${res.error})`);
      assert.ok(elapsed < 15_000, `stop returns promptly rather than waiting out the command (took ${elapsed}ms)`);
      // The point of group signalling: the SURVIVING CHILD is gone too.
      for (let i = 0; i < 30 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(childPid), false, 'the long-lived grandchild was killed, not orphaned into the worktree');
      assert.equal(groupIsGone(res.pgid), true, 'and nothing is left in the group');
    }
    // A TERM-RESISTANT group must still die. A build tool that traps SIGTERM (or
    // ignores it while a child compiles) must not be able to outlive a Stop: TERM is
    // ignored, so the escalation to KILL is what ends it — and KILL cannot be trapped.
    {
      write([
        'trap "" TERM',                      // deliberately ignore the polite signal
        'sleep 600 &',
        'child=$!',
        'echo "child=$child" > "$1/child.pid"',
        'wait $child',
      ].join('\n'));
      const probeDir = mkdtempSync(pjoin(tmpdir(), 'cls-termresist-'));
      const ac = new AbortController();
      const running = makeCandidateVerifier({ worktree: probeDir, scriptPath: stub, signal: ac.signal, termGraceMs: 300, killGraceMs: 3000 })();
      const { readFileSync: rf, existsSync: ex } = await import('node:fs');
      let childPid = null;
      for (let i = 0; i < 60 && !childPid; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (ex(pjoin(probeDir, 'child.pid'))) childPid = Number(String(rf(pjoin(probeDir, 'child.pid'), 'utf8')).split('=')[1]);
      }
      assert.ok(childPid > 0, 'the TERM-resistant probe started a child');
      ac.abort();
      const res = await running;
      assert.equal(res.stopped, true, 'the stop is reported');
      assert.equal(res.groupTerminated, true, `a group that IGNORES TERM is still killed (${res.error})`);
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (let i = 0; i < 30 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(childPid), false, 'and its child is gone too');
    }
    // A PERMANENTLY-ALIVE group must never be reported as terminated. Injected,
    // because a process that truly survives SIGKILL cannot be produced on purpose —
    // and the point is what Studio SAYS when its signals do not take.
    {
      const probeDir = mkdtempSync(pjoin(tmpdir(), 'cls-neverdies-'));
      write('sleep 0.2');
      const ac = new AbortController();
      const running = makeCandidateVerifier({
        worktree: probeDir, scriptPath: stub, signal: ac.signal,
        termGraceMs: 100, killGraceMs: 200,
        groupGone: () => false,                     // nothing we send ever takes
      })();
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      const res = await running;
      assert.equal(res.ran, false, 'no verdict from a stop');
      assert.equal(res.stopped, true, 'it is reported as stopped');
      assert.equal(res.groupTerminated, false, 'and NOT as terminated, because it was not');
      assert.match(res.error, /still has a live member/, 'the error names the surviving group');
      assert.ok(String(res.pgid).length > 0, 'and carries the pgid to chase');
    }
    // An abort that arrives BEFORE the spawn never starts a process at all.
    {
      const ac = new AbortController();
      ac.abort();
      const res = await makeCandidateVerifier({ worktree: dir, scriptPath: stub, signal: ac.signal })();
      assert.equal(res.ran, false, 'an already-stopped run does not start the verifier');
      assert.equal(res.stopped, true, 'and says it was stopped');
    }

    // Unreadable output and a missing script are REFUSALS, not verdicts.
    write('echo "the toolchain exploded"; exit 3');
    const junk = await makeCandidateVerifier({ worktree: dir, scriptPath: stub })();
    assert.equal(junk.ran, false, 'unparseable output does not become a verdict');
    assert.match(junk.error, /no readable/, 'and says so');
    const missing = await makeCandidateVerifier({ worktree: dir, scriptPath: pjoin(dir, 'nope.sh') })();
    assert.equal(missing.ran, false, 'a missing verify script is a refusal');
    assert.equal((await makeCandidateVerifier({ worktree: null, scriptPath: stub })()).ran, false, 'and so is having no worktree');
  }

  // ── VERIFICATION-ONLY RECOVERY: ZERO MODEL TURNS ───────────────────────────
  // Resume used to re-enter the gate on a parked candidate, and the gate enters
  // Plan/Implement unconditionally: run 20260805-104802-rv4d resumed to
  // `Verify → Plan → Implement` on a candidate that was already committed and
  // already reviewed (field report 2026-08-05). Recovery is now its own lane.
  {
    const { recoveryTarget, runVerificationRecovery } = await import('./lib/code-lane.mjs');
    const PARKED = 'e3487e891d409fc218591602c6c8565b16af9094';
    const WT = '/wt/camus-wt-implement-only-wp6';
    const sealed = {
      id: '20260805-104802-rv4d', lane: 'build', status: 'needs_decision',
      gateReport: { status: 'verify_inconclusive', commit_sha: PARKED, parkedSha: PARKED, branch: 'camus/wp6', worktree: WT },
      evidencePack: { receipt_id: 'sha256:sourcereceipt' },
    };

    // ── THE REAL RECEIPT SHAPE ─────────────────────────────────────────────────
    // The selector previously read a top-level `gateReport` that ONLY its own test
    // fixture had. Production seals the gate report at `report` (and a copy at
    // `evidence.gateReport`), so against the actual WP6 receipt it answered "the gate
    // ended unknown" and the run fell through to the gate. This fixture is a
    // sanitized copy of runs/20260805-104802-rv4d/report.json: values redacted,
    // NOTHING added — it has no top-level gateReport and no sealed sha, exactly like
    // production.
    {
      const { readFileSync } = await import('node:fs');
      const legacy = JSON.parse(readFileSync(new URL('./fixtures/wp6-needs-decision.report.json', import.meta.url), 'utf8'));
      assert.ok(!('gateReport' in legacy), 'the fixture really is production-shaped: no top-level gateReport');
      assert.equal(legacy.report.status, 'verify_inconclusive', 'its gate report lives under `report`');
      assert.equal(legacy.status, 'needs_decision', 'over an outer needs_decision');
      const lt = recoveryTarget(legacy);
      assert.equal(lt.eligible, true, `the REAL receipt shape is recoverable (got: ${lt.reason})`);
      assert.ok(!/unknown/.test(String(lt.reason)), 'and never reports the gate status as unknown');
      assert.equal(lt.sealedSha, null, 'production sealed no candidate sha');
      assert.equal(lt.needsAdoption, true, 'so the target must be adopted, not assumed');
      assert.equal(lt.branch, legacy.report.branch, 'the branch comes from the receipt');
      assert.equal(lt.worktree, legacy.report.worktree, 'and so does the worktree');
      // The copy under evidence works too, for receipts sealed without `report`.
      const evOnly = { ...legacy, report: undefined };
      assert.equal(recoveryTarget(evOnly).eligible, true, 'evidence.gateReport is read as well');

      // ── A PARKED CANDIDATE IS FLAGGED THE MOMENT THE STATUSES MATCH ──────────
      // `parkedCandidate` used to be attached only by the deeper checks, so a receipt
      // whose worktree is gone came back as a plain ineligible and the caller fell
      // straight through into the gate — the one thing this repair exists to prevent.
      const noWt = JSON.parse(JSON.stringify(legacy));
      delete noWt.report.worktree;
      if (noWt.evidence?.gateReport) delete noWt.evidence.gateReport.worktree;
      const gone = recoveryTarget(noWt);                 // and no durable fallback
      assert.equal(gone.eligible, false, 'with no worktree anywhere it cannot be targeted');
      assert.equal(gone.parkedCandidate, true, 'but it is STILL a parked candidate, so resume must refuse rather than re-plan');
      assert.match(gone.reason, /worktree/, 'and the refusal names the missing worktree');
      // The fallback still works when one is available.
      assert.equal(recoveryTarget(noWt, { worktreeFallback: '/live/camus-wt-x' }).eligible, true,
        'the durable status record can supply the worktree');
      // Everything BEFORE the status match is a genuine non-candidate: those must not
      // be flagged, or an ordinary failed run could never resume through the gate.
      for (const [label, patch] of [
        ['a words lane', { lane: 'freeform' }],
        ['a finished run', { status: 'done' }],
        ['a red gate', { report: { ...legacy.report, status: 'verify_failed' }, evidence: { ...legacy.evidence, gateReport: { ...legacy.evidence.gateReport, status: 'verify_failed' } } }],
      ]) {
        const r = recoveryTarget({ ...legacy, ...patch });
        assert.equal(r.eligible, false, `${label} is not recoverable`);
        assert.ok(!r.parkedCandidate, `${label} is NOT flagged as a parked candidate, so the gate stays available to it`);
      }
    }

    // ELIGIBILITY. Only this exact shape recovers in place; everything else must
    // fall through to the normal gate rather than silently verifying nothing.
    const t = recoveryTarget(sealed);
    assert.equal(t.eligible, true, 'needs_decision over verify_inconclusive with a parked commit is recoverable');
    assert.equal(t.sealedSha, PARKED, 'the target names the sha the GATE sealed');
    assert.equal(t.needsAdoption, false, 'and needs no adoption');
    assert.equal(t.worktree, WT, 'and the parked worktree');
    assert.equal(t.sourceRunId, '20260805-104802-rv4d', 'and the source run it recovers');
    // An UNVALIDATED source pack is not claimed: a bare {receipt_id} stub cannot be
    // verified to describe its own contents, so the link is withheld and the reason
    // recorded (audit 2026-08-05 — the redacted fixture was exactly this shape).
    assert.equal(t.sourceReceiptId, null, 'an unvalidated source pack is NOT linked');
    assert.match(t.sourceReceiptStatus, /^unusable: /, 'and the receipt says why it was not linked');
    assert.equal(t.sourceAudit, null, 'with no audit claimed from it either');
    for (const [label, patch] of [
      ['a words lane', { lane: 'freeform' }],
      ['a finished run', { status: 'done' }],
      ['a red gate', { gateReport: { ...sealed.gateReport, status: 'verify_failed' } }],
      ['no worktree left', { gateReport: { status: 'verify_inconclusive', parkedSha: PARKED } }],
    ]) {
      const r = recoveryTarget({ ...sealed, ...patch });
      assert.equal(r.eligible, false, `${label} is NOT recovered in place`);
      assert.ok(r.reason && r.reason.length > 10, `${label} says why in plain words`);
    }
    // The durable status record supplies the worktree when the report predates it.
    assert.equal(recoveryTarget({ ...sealed, gateReport: { status: 'verify_inconclusive', parkedSha: PARKED } }, { worktreeFallback: WT }).worktree, WT,
      'a missing report worktree falls back to the live status record');

    // ── LEGACY ADOPTION IS SAFE OR IT REFUSES ──────────────────────────────────
    // With no sealed sha, the only honest target is the recorded worktree's current
    // HEAD — and only when that worktree really is the one recorded, on the branch
    // recorded, and clean. Anything else is a refusal, never a guess, and the result
    // is labelled so no reader mistakes it for something the source sealed.
    {
      const { resolveRecoveryTarget } = await import('./lib/code-lane.mjs');
      const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const legacy = { id: 'src', lane: 'build', status: 'needs_decision', report: { status: 'verify_inconclusive', worktree: WT, branch: 'camus/wp6' } };
      // A git probe whose answers are the thing under test.
      const probe = (over = {}) => ({
        realpath: (p) => over.realpath !== undefined ? over.realpath : p,
        run: async (args) => {
          const key = args.join(' ');
          const answers = {
            'rev-parse --is-inside-work-tree': { ok: true, out: 'true' },
            'rev-parse --show-toplevel': { ok: true, out: WT },
            'rev-parse HEAD': { ok: true, out: HEAD },
            'rev-parse --abbrev-ref HEAD': { ok: true, out: 'camus/wp6' },
            'status --porcelain': { ok: true, out: '' },
            ...over.answers,
          };
          return answers[key] ?? { ok: false, out: '' };
        },
      });
      const happy = await resolveRecoveryTarget(legacy, { git: probe() });
      assert.equal(happy.eligible, true, `a clean recorded worktree adopts its HEAD (got: ${happy.reason})`);
      assert.equal(happy.parkedSha, HEAD, 'the adopted sha is the worktree HEAD');
      assert.equal(happy.shaProvenance, 'adopted_clean_worktree_head', 'and it is LABELLED as adopted, not sealed');
      assert.notEqual(happy.shaProvenance, 'sealed_by_source', 'never claiming the source sealed it');

      for (const [label, over, expect] of [
        ['the worktree is gone', { realpath: null }, /no longer exists/],
        ['it is not a work tree', { answers: { 'rev-parse --is-inside-work-tree': { ok: true, out: 'false' } } }, /not a git work tree/],
        ['it is a SUBDIRECTORY of one', { answers: { 'rev-parse --show-toplevel': { ok: true, out: '/somewhere/else' } } }, /not the root/],
        ['HEAD does not resolve', { answers: { 'rev-parse HEAD': { ok: false, out: '' } } }, /no resolvable HEAD/],
        ['it moved to another branch', { answers: { 'rev-parse --abbrev-ref HEAD': { ok: true, out: 'main' } } }, /different branch/],
        ['it has uncommitted changes', { answers: { 'status --porcelain': { ok: true, out: ' M src/a.cs' } } }, /uncommitted changes/],
        ['cleanliness is unknown', { answers: { 'status --porcelain': { ok: false, out: '' } } }, /cleanliness is unknown/],
      ]) {
        const r = await resolveRecoveryTarget(legacy, { git: probe(over) });
        assert.equal(r.eligible, false, `${label}: adoption is REFUSED`);
        assert.match(r.reason, expect, `${label}: the refusal names the obstacle`);
        // And the refusal must be marked so the caller cannot fall through to the gate.
        assert.equal(r.parkedCandidate, true, `${label}: still flagged as a parked candidate, so resume must refuse rather than re-plan`);
      }
      // A SEALED sha is never adopted, and a worktree that moved off it is refused.
      const sealedSrc = { ...legacy, report: { ...legacy.report, parkedSha: HEAD } };
      const kept = await resolveRecoveryTarget(sealedSrc, { git: probe() });
      assert.equal(kept.shaProvenance, 'sealed_by_source', 'a sealed sha keeps sealed provenance');
      const moved = await resolveRecoveryTarget(sealedSrc, { git: probe({ answers: { 'rev-parse HEAD': { ok: true, out: 'b'.repeat(40) } } }) });
      assert.equal(moved.eligible, false, 'a worktree that moved off the sealed sha is refused');
      assert.match(moved.reason, /different candidate/, 'and says it is a different candidate');
    }

    // ZERO TURNS. Any adapter or igniter touch is a failure of the whole design,
    // so they are wired to throw rather than count.
    const forbidden = (what) => () => { throw new Error(`FORBIDDEN: the recovery called ${what}`); };
    const run = {
      id: 'recovery-run', lane: 'build', idSalt: 'studio-20260805-104802-rv4d',
      verifyCmd: 'dotnet test tests/Core.Tests/Core.Tests.csproj -f net10.0',
      // What the SERVER passes: the resolved target, whose parkedSha and provenance
      // came out of resolveRecoveryTarget's git checks.
      recovery: { ...t, parkedSha: PARKED, shaProvenance: 'sealed_by_source', canonicalWorktree: WT },
      models: { maker: { model: 'opus' }, reviewer: { model: 'gpt-5.6-sol' } },
    };
    const drive = async (verifyResult) => {
      const events = [];
      const out = await runVerificationRecovery(run, {
        emit: (t2, d) => events.push({ t: t2, ...d }),
        signal: { aborted: false },
        // Present and poisoned: if the executor ever reaches for them, it throws.
        adapters: { maker: forbidden('the maker seat'), reviewer: forbidden('the reviewer seat') },
        igniteGate: forbidden('the gate igniter'),
        waitForAnswer: forbidden('a human question'),
        verifyCandidate: async () => verifyResult,
      });
      return { out, events };
    };

    // 1. A bound green resolves done and emits a commit-bound verdict.
    {
      const { out, events } = await drive({ ran: true, pass: true, raw: { head: PARKED } });
      assert.equal(out.status, 'done', 'a bound green on the parked candidate is done');
      assert.equal(out.verifiedSha, PARKED, 'and names the sha it certified');
      const v = events.filter((e) => e.t === 'verify_result');
      assert.equal(v.length, 1, 'exactly one verification verdict is emitted');
      assert.equal(v[0].commitSha, PARKED, 'bound to the sha the ORIGINAL run sealed');
      assert.equal(v[0].source, 'studio_reverify', 'and marked as the host re-verify');
      // The PHASES are Verify-only: no plan, no implement, no gate, no review.
      const stages = events.filter((e) => e.t === 'stage').map((e) => e.name);
      assert.deepEqual([...new Set(stages)], ['verify'], `the only phase is verify (saw ${stages.join(', ')})`);
      // And the receipt REFERENCES the source rather than replacing it.
      assert.equal(out.recoveryOf.sourceRunId, '20260805-104802-rv4d', 'the receipt names the source run');
      assert.equal(out.recoveryOf.sourceReceiptId, null, 'and withholds an unvalidated source receipt');
      assert.match(out.recoveryOf.sourceReceiptStatus, /^unusable: /, 'recording why it is unlinked');
      assert.equal(out.recoveryOf.parkedSha, PARKED, 'and the candidate sha');
      assert.equal(out.recoveryOf.verifyCmd, run.verifyCmd, 'and the command that produced the result');
      assert.equal(out.landed, false, 'nothing was landed — recovery never merges');
    }
    // 2. A bound red is a real red.
    {
      const { out } = await drive({ ran: true, pass: false, raw: { head: PARKED, failures: [{ stage: 'test' }] } });
      assert.equal(out.status, 'verify_failed', 'a bound red is reported as a red');
    }
    // 3. Missing / mismatched HEAD on a VERDICT stays inconclusive and emits nothing.
    for (const [label, raw] of [['no head', {}], ['a different commit', { head: 'deadbeef'.repeat(5) }]]) {
      const { out, events } = await drive({ ran: true, pass: true, raw });
      assert.equal(out.status, 'needs_decision', `${label}: stays parked for a human`);
      assert.equal(events.filter((e) => e.t === 'verify_result').length, 0, `${label}: no verdict is emitted`);
      assert.ok(!('verifiedSha' in out), `${label}: nothing is claimed as verified`);
      assert.ok(out.recoveryNote && out.recoveryNote.length > 10, `${label}: the receipt says why`);
    }
    // 3b. AN INCONCLUSIVE RESULT IS CLASSIFIED BEFORE HEAD IS DEMANDED. A guard refusal
    // has no verdict and no HEAD — there was nothing to take a HEAD of — so reporting
    // "no HEAD" would replace the real diagnosis and send the operator after the wrong
    // problem. The verifier's own failures survive into the receipt.
    {
      const guardRefusal = {
        ran: true, pass: null,
        raw: { inconclusive: true, checks: [], failures: [{ stage: 'guard', kind: 'refused', log_tail: 'target rejected by camus_guard (not the caller repo or a camus worktree)' }] },
      };
      const { out, events } = await drive(guardRefusal);
      assert.equal(out.status, 'needs_decision', 'a guard refusal leaves the candidate parked');
      assert.match(out.recoveryNote, /guard\/refused/, 'and the note carries the verifier\'s own stage/kind');
      assert.ok(!/no HEAD/i.test(out.recoveryNote), 'it does NOT blame a missing HEAD');
      assert.deepEqual(out.failures, guardRefusal.raw.failures, 'the verifier failures are preserved verbatim, diagnosis intact');
      assert.equal(events.filter((e) => e.t === 'verify_result').length, 0, 'and no verdict is emitted');
      // A missing toolchain is the same shape, with its own kind.
      const noTool = await drive({ ran: true, pass: null, raw: { inconclusive: true, failures: [{ stage: 'verify', reason: 'no_verifier_detected', kind: 'missing_tool' }] } });
      assert.match(noTool.out.recoveryNote, /missing_tool|no_verifier_detected/, 'a missing toolchain keeps its own diagnosis');
      assert.ok(!/no HEAD/i.test(noTool.out.recoveryNote), 'and is not reported as a HEAD problem either');
      // HEAD binding is still MANDATORY for a real verdict — proved above in 3.
    }
    // 4. A verifier that cannot run at all: honest, and still zero turns.
    {
      const { out, events } = await drive({ ran: false, error: 'dotnet workload missing' });
      assert.equal(out.status, 'needs_decision', 'an unrunnable verifier leaves it parked');
      assert.match(out.recoveryNote, /workload missing/, 'and preserves the reason verbatim');
      assert.equal(events.filter((e) => e.t === 'verify_result').length, 0, 'with no invented verdict');
    }
    // 5. STOP DURING RECOVERY MUST NOT REJECT. The server consumes the runner with
    // a bare .then(), so a throw here is an unhandled rejection that kills the whole
    // process — which is exactly what happened when a Stop landed inside the verify
    // await while driving this for real (2026-08-05).
    {
      const events = [];
      const signal = { aborted: false };
      const out = await runVerificationRecovery(run, {
        emit: (t2, d) => events.push({ t: t2, ...d }),
        signal,
        adapters: { maker: forbidden('the maker seat'), reviewer: forbidden('the reviewer seat') },
        igniteGate: forbidden('the gate igniter'),
        // The stop lands WHILE the verifier is running, the real race.
        verifyCandidate: async () => { signal.aborted = true; return { ran: true, pass: true, raw: { head: PARKED } }; },
      });
      assert.equal(out.status, 'stopped', 'a stop mid-verify resolves as stopped rather than throwing');
      assert.equal(events.filter((e) => e.t === 'verify_result').length, 0, 'and no verdict is recorded for a stopped recovery');
      assert.equal(events.filter((e) => e.t === 'status').at(-1).status, 'stopped', 'the terminal event says stopped');
      assert.match(out.recoveryNote, /group terminated/, 'and the clean stop states that the group was terminated');
    }
    // 6. A STOP OVER A SURVIVING GROUP IS NOT CLEAN. `stopped` asserts nothing of ours
    // is still running in the operator's worktree, so a verifier reporting
    // groupTerminated:false must seal an infra failure naming the pgid — the same
    // false-clean the reviewer lane was already fixed for.
    {
      const events = [];
      const out = await runVerificationRecovery(run, {
        emit: (t2, d) => events.push({ t: t2, ...d }),
        signal: { aborted: true },
        adapters: { maker: forbidden('the maker seat'), reviewer: forbidden('the reviewer seat') },
        igniteGate: forbidden('the gate igniter'),
        verifyCandidate: async () => ({ ran: false, stopped: true, groupTerminated: false, pgid: 424242, error: 'verification was stopped but process group 424242 still has a live member' }),
      });
      assert.equal(out.status, 'failed', `a surviving verifier group seals FAILED, never stopped (got ${out.status})`);
      assert.notEqual(out.status, 'stopped', 'never a clean stop over an orphan');
      assert.equal(out.orphanedPgid, 424242, 'and the receipt carries the pgid to chase');
      assert.match(out.recoveryNote, /survived TERM and KILL/, 'and says the signals did not take');
      assert.match(out.recoveryNote, /424242/, 'naming the group');
      assert.equal(events.filter((e) => e.t === 'status').at(-1).status, 'failed', 'the terminal event says failed');
      assert.equal(events.filter((e) => e.t === 'verify_result').length, 0, 'with no verdict invented');
    }
  }

  // ── RECOVERY LINEAGE IS SEALED, AND A ZERO-MODEL RUN NAMES NO VENDOR ───────
  // The lineage lived only as a top-level report field, so editing the displayed
  // source receipt would not have changed receipt_id — a provenance claim outside the
  // hash meant to cover it. And the model-free run sealed `anthropic:not-recorded` /
  // `unknown:not-recorded`, inventing vendors for a run that made no model calls.
  {
    const { buildEvidencePack, NO_MODEL_IDENTITY } = await import('./lib/evidence-pack.mjs');
    const SHA = 'e3487e891d409fc218591602c6c8565b16af9094';
    const base = {
      goal: 'recover a parked candidate', acceptanceContract: 'Deterministic checks pass on the parked candidate.',
      lane: 'build', targetPath: '/repo',
      evidence: { gateReport: { commit_sha: SHA }, verify: [{ pass: true, commitSha: SHA, source: 'studio_reverify' }], rounds: [], revisions: [] },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'not_run', publication: 'not_published' },
      models: { maker: null, reviewer: null, loop: { roundCap: 0 }, recovery: true },
      simulated: false, verifyCommand: 'dotnet test Core.Tests -f net10.0', createdAt: 1,
      recoveryOf: { sourceRunId: '20260805-104802-rv4d', sourceReceiptId: 'sha256:5819ccaaaa', parkedSha: SHA, shaProvenance: 'adopted_clean_worktree_head' },
    };
    const pack = buildEvidencePack(base);
    const log = pack.session_log.join('\n');
    assert.match(log, /recovery of run: 20260805-104802-rv4d/, 'the source run is SEALED into the pack');
    assert.match(log, /recovery source receipt: sha256:5819ccaaaa/, 'so is the source receipt');
    assert.match(log, new RegExp(`recovery candidate: ${SHA}`), 'so is the candidate sha');
    assert.match(log, /recovery sha provenance: adopted_clean_worktree_head/, 'and how that sha was established');

    // THE BREAK-TEST THE AUDIT ASKED FOR: lineage must be receipt-COVERED.
    const otherReceipt = buildEvidencePack({ ...base, recoveryOf: { ...base.recoveryOf, sourceReceiptId: 'sha256:DIFFERENT' } });
    assert.notEqual(otherReceipt.receipt_id, pack.receipt_id, 'changing the source RECEIPT changes receipt_id');
    const otherRun = buildEvidencePack({ ...base, recoveryOf: { ...base.recoveryOf, sourceRunId: 'some-other-run' } });
    assert.notEqual(otherRun.receipt_id, pack.receipt_id, 'changing the source RUN changes receipt_id');
    const otherProv = buildEvidencePack({ ...base, recoveryOf: { ...base.recoveryOf, shaProvenance: 'sealed_by_source' } });
    assert.notEqual(otherProv.receipt_id, pack.receipt_id, 'changing the SHA PROVENANCE changes receipt_id');
    const noLineage = buildEvidencePack({ ...base, recoveryOf: null });
    assert.notEqual(noLineage.receipt_id, pack.receipt_id, 'and removing the lineage entirely changes it too');
    assert.ok(!noLineage.session_log.some((l) => l.startsWith('recovery ')), 'a non-recovery pack carries no recovery lines');

    // ZERO-MODEL IDENTITY names no vendor.
    assert.equal(pack.pairing.executor.actual, NO_MODEL_IDENTITY, 'the executor identity is the explicit no-model token');
    assert.equal(pack.pairing.auditor.actual, NO_MODEL_IDENTITY, 'and so is the auditor identity');
    for (const field of ['requested', 'resolved', 'actual']) {
      for (const role of ['executor', 'auditor']) {
        const v = String(pack.pairing[role][field]);
        assert.ok(!/anthropic|openai|moonshot/i.test(v), `${role}.${field} implies no vendor (got ${v})`);
        assert.ok(!/not-recorded/.test(v), `${role}.${field} does not read as a lost observation (got ${v})`);
      }
    }
    assert.match(log, /no model seats/, 'and the session log says plainly that no seats ran');
    assert.equal(pack.pairing.independence, 'none', 'no independence is claimed');
    for (const e of pack.economics) {
      assert.ok(!/anthropic|openai/i.test(String(e.provider ?? '') + String(e.model ?? '')), 'economics name no vendor either');
      assert.equal(e.usage, null, 'and record no usage');
    }
    // A REAL run is untouched by any of this.
    const real = buildEvidencePack({
      ...base, recoveryOf: null,
      models: { maker: { backend: 'claude', provider: 'anthropic', model: 'opus' }, reviewer: { backend: 'codex', provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
      evidence: { ...base.evidence, gateReport: { commit_sha: SHA, model: 'opus' }, rounds: [{ verdict: 'APPROVED', reviewerModel: 'gpt-5.6-sol', reviewerIdentity: 'openai:gpt-5.6-sol', source: 'camus_gate_review' }] },
      statuses: { ...base.statuses, audit: 'independent_clean' },
    });
    assert.equal(real.pairing.executor.actual, 'anthropic:opus', 'a real run still records its real maker');
    assert.equal(real.pairing.auditor.actual, 'openai:gpt-5.6-sol', 'and its real auditor');
  }

  // ── AN INTERRUPTED VERIFICATION DECISION IS STILL A PARKED CANDIDATE ───────
  // Studio restarted while the gate awaited the verification question, so NO terminal
  // report.json was written. Every sealed-report check found nothing, the replay was
  // labelled `incomplete`, and the only offered action re-entered the gate and reran
  // the model phases — with the review already clean at round 2 (production run
  // 20260805-181917-f4b1). The event trail alone is enough to rebuild the parked state.
  {
    const { reconstructInterruptedParked, recoveryTarget } = await import('./lib/code-lane.mjs');
    const { replayRecoveryKind } = await import('./public/run-ui-policy.mjs');
    const SHA = '921a55885f36fc711c90a0671da87533c3bea93e';
    const WT = '/wt/camus-wt-implement-only-wp7-enemybody-perception--zapxw';
    const gate = { status: 'verify_inconclusive', commit_sha: SHA, parkedSha: SHA, branch: 'camus/implement-only-wp7-enemybody-perception--zapxw', worktree: WT, rounds: 2 };
    // The EXACT trail shape the production run left: review rounds, the gate's
    // inconclusive report, then an unanswered verification question. No terminal status.
    const trail = [
      { type: 'review', round: 1, verdict: 'CHANGES', source: 'camus_gate_review' },
      { type: 'review', round: 2, verdict: 'APPROVED', source: 'camus_gate_review' },
      { type: 'verify_result', pass: null, source: 'gate_report_status', derived: true, commitSha: SHA },
      { type: 'gate_report', report: gate },
      { type: 'question', id: 'q-1', kind: 'verify', text: '…', options: ['Retry verification with the configured command', 'Record that I ran the checks myself and they passed', 'Leave the candidate parked and stop here'] },
    ];
    const meta = { id: '20260805-181917-f4b1', lane: 'build', idSalt: 'studio-20260805-181917-f4b1', verifyCmd: 'dotnet test x.csproj', targetPath: '/repo' };

    // The old path: a run.json with no gate report is not a parked candidate at all.
    assert.ok(!recoveryTarget(meta).parkedCandidate, 'the sealed-report path finds nothing here — the gap that fell through to the gate');

    const rebuilt = reconstructInterruptedParked(trail, meta);
    assert.ok(rebuilt, 'the interrupted run IS reconstructed from its event trail');
    assert.equal(rebuilt.status, 'needs_decision', 'as the parked state it was in');
    assert.equal(rebuilt.report.status, 'verify_inconclusive', 'carrying the gate report VERBATIM');
    assert.equal(rebuilt.report.parkedSha, SHA, 'with the parked candidate sha');
    assert.equal(rebuilt.pendingQuestionId, 'q-1', 'and the question that was never answered');
    assert.equal(rebuilt.evidencePack, null, 'and NO evidence pack, because none was sealed');
    assert.equal(rebuilt.interruptedRecovery, true, 'flagged as an interrupted recovery');
    assert.equal(rebuilt.idSalt, meta.idSalt, 'the gate identity is preserved');
    assert.equal(rebuilt.verifyCmd, meta.verifyCmd, 'and so is the operator command the run was launched with');

    // It flows into the SAME safety checks, and claims no review it cannot show.
    const t = recoveryTarget(rebuilt);
    assert.equal(t.eligible, true, 'the reconstructed state is recovery-eligible');
    assert.equal(t.parkedCandidate, true, 'and flagged so a later refusal cannot fall through to the gate');
    assert.equal(t.sourceReceiptId, null, 'no source receipt is claimed');
    assert.match(t.sourceReceiptStatus, /sealed no evidence pack/, 'and the receipt says exactly why');
    assert.equal(t.sourceAudit, null, 'so no review linkage is implied either');

    // REFUSALS — none of these may be reconstructed into a parked candidate.
    const without = (pred) => trail.filter((e) => !pred(e));
    assert.equal(reconstructInterruptedParked(without((e) => e.type === 'question'), meta), null,
      'no pending question → not an interrupted DECISION');
    assert.equal(reconstructInterruptedParked(without((e) => e.type === 'gate_report'), meta), null,
      'no gate report → nothing says a candidate was parked');
    assert.equal(reconstructInterruptedParked([...trail, { type: 'answer', kind: 'verify', question: '…', answer: 'Leave the candidate parked and stop here' }], meta), null,
      'an ANSWERED question means the decision flow moved on');
    assert.equal(reconstructInterruptedParked([...trail, { type: 'question_answered', id: 'q-1' }], meta), null,
      'and so does an answered-acknowledgement');
    for (const terminal of ['done', 'done_with_findings', 'verify_failed', 'failed', 'stopped', 'needs_decision', 'no_changes']) {
      assert.equal(reconstructInterruptedParked([...trail, { type: 'status', status: terminal }], meta), null,
        `a run that reached ${terminal} is not interrupted`);
    }
    assert.equal(reconstructInterruptedParked(trail.map((e) => (e.type === 'gate_report' ? { ...e, report: { ...gate, status: 'verify_failed' } } : e)), meta), null,
      'a RED gate is never reconstructed as a parked candidate');
    assert.equal(reconstructInterruptedParked(trail, { ...meta, lane: 'freeform' }), null, 'and the words lanes park nothing');
    assert.equal(reconstructInterruptedParked(null, meta), null, 'a missing trail reconstructs nothing');
    assert.equal(reconstructInterruptedParked([], meta), null, 'and neither does an empty one');

    // The replay classification routes to the verification-only lane, not a gate resume.
    assert.equal(replayRecoveryKind({ lane: 'build', empty: false, parked: true }), 'recover_parked_candidate',
      'a parked interruption is offered the verification-only lane');
    assert.equal(replayRecoveryKind({ lane: 'build', empty: false, parked: false }), 'resume_build',
      'an ordinary unfinished build still resumes the gate');
    assert.equal(replayRecoveryKind({ lane: 'build', empty: true, parked: true }), null, 'an empty trail offers nothing');
    assert.equal(replayRecoveryKind({ lane: 'freeform', empty: false, parked: true }), null, 'and the words lanes are unaffected');
  }

  // A gate report's `failures` ride the same evidence field as verification CHECKS, and
  // mapping them blindly produced {id:"undefined", status:undefined} — the validator then
  // REFUSED the whole pack, so the report being described degraded its own receipt.
  {
    const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');
    const { validateEvidencePack } = await import('../../packages/trust/lib/validate.mjs');
    const SHA = 'c'.repeat(40);
    const packOf = (checks) => buildEvidencePack({
      goal: 'g', acceptanceContract: 'a'.repeat(40), lane: 'build', targetPath: '/r',
      evidence: { gateReport: { commit_sha: SHA }, verify: [{ pass: true, commitSha: SHA, source: 'studio_reverify', checks }], rounds: [], revisions: [] },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'not_run', publication: 'not_published' },
      models: { maker: null, reviewer: null, loop: { roundCap: 0 }, recovery: true },
      simulated: false, createdAt: 1,
    });
    // Gate FAILURES in the checks slot: not checks, so they must not be sealed as such.
    const withFailures = packOf([{ stage: 'prep', kind: 'guard_refused', log_tail: 'target rejected by camus_guard' }]);
    assert.equal(validateEvidencePack(withFailures).ok, true, 'a gate failure in the checks slot still yields a VALID pack');
    assert.equal(withFailures.verification.checks.length, 1, 'falling back to the head-bound summary');
    assert.equal(withFailures.verification.checks[0].id, 'studio_reverify', 'named by its source');
    assert.equal(withFailures.verification.checks[0].status, 'pass', 'with a schema-legal status');
    // Real checks are still sealed verbatim.
    const real = packOf([{ id: 'dotnet:test', status: 'pass', detail: null }, { id: 'dotnet:build', status: 'warn' }]);
    assert.equal(validateEvidencePack(real).ok, true, 'real checks validate');
    assert.deepEqual(real.verification.checks.map((c) => c.id), ['dotnet:test', 'dotnet:build'], 'and are preserved');
    // A mixed list keeps only what is actually a check.
    const mixed = packOf([{ id: 'dotnet:test', status: 'pass' }, { stage: 'integrity', kind: 'tracked_mutation' }]);
    assert.equal(validateEvidencePack(mixed).ok, true, 'a mixed list validates');
    assert.deepEqual(mixed.verification.checks.map((c) => c.id), ['dotnet:test'], 'keeping only the real check');
  }

  // The interrupted banner's PROVENANCE. "already committed and reviewed" overstated it:
  // nothing sealed, so the review verdict exists only in the local event trail and no
  // receipt covers it. Asserted on the shipped source because the string is the claim.
  {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
    const banner = (app.match(/INTERRUPTED WHILE AWAITING[^']*/) || [''])[0];
    assert.ok(banner.length > 80, 'the interrupted banner copy is present');
    assert.match(banner, /NO evidence pack and NO receipt were written/, 'it says nothing was sealed');
    assert.match(banner, /local event trail/, 'and that the review verdict lives only in the local trail');
    assert.match(banner, /not sealed and not receipt-covered/, 'stating the boundary explicitly');
    assert.match(banner, /no reviewed standing can be claimed/, 'and that no reviewed standing follows from it');
    assert.ok(!/already reviewed/.test(banner), 'and never simply claims the candidate is "already reviewed"');
    assert.ok(!/already committed and reviewed/.test(app), 'the old overstatement is gone from the file entirely');
    assert.match(app, /item\.remedy \|\| item\.detail/, 'unsupported native readiness renders its bounded explanation, never a null remedy');
    // The client must not re-derive the recovery kind; the server is authoritative.
    assert.ok(!/state\.replayParked/.test(app), 'the browser holds no second classifier for parked runs');
    assert.match(app, /parked: ev\.parked === true/, 'it consumes the classification the server sends');

    // ── REPLAY-NESS IS PER-STREAM, NOT PER-PAGE ────────────────────────────
    // Live run 20260806-145411-hy1w: an old receipt was opened from disk (replay_start →
    // state.replaying = true), Resume started a REAL run, and every decision button on the new
    // run's question rendered inert with "asked by a Studio session that has since ended" — the
    // live loop sat at needs_human waiting on an answer the UI had already disabled. The stream
    // opener must clear the flag; only a replay_start from the NEW stream may set it again.
    const attachBody = (app.match(/function attach\(id, goal\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.ok(attachBody.length > 200, 'the stream opener is present in the shipped file');
    assert.match(attachBody, /state\.replaying = false/, 'opening a stream clears replay-ness');
    assert.match(attachBody, /state\.replayPendingQuestion = null/, 'and clears the pending replayed question');
    // Ordering is load-bearing: cleared BEFORE the EventSource can deliver a single event.
    assert.ok(attachBody.indexOf('state.replaying = false') < attachBody.indexOf('new EventSource'),
      'the reset happens before the stream can deliver an event');
    // And nothing else in the file may turn it on — replay_start is the only source of truth.
    const setsTrue = [...app.matchAll(/state\.replaying\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(setsTrue.slice().sort(), ['false', 'true'], 'replay-ness is set in exactly two places: the reset and the replay marker');
    const replayCase = (app.match(/case 'replay_start':[\s\S]*?break;/) || [''])[0];
    assert.match(replayCase, /state\.replaying = true/, 'the one place that sets it is the disk-replay marker');

    // ── GATE PROGRESS IS PER-STREAM TOO ────────────────────────────────────
    // It is merged across events, so a new run's first frames rendered the PREVIOUS run's phase
    // until the gate stamped its own (live run 20260806-164809-hiju).
    assert.match(attachBody, /gateProgressState = \{\}/, 'opening a stream clears the gate-progress state');
    assert.ok(attachBody.indexOf('gateProgressState = {}') < attachBody.indexOf('new EventSource'),
      'cleared before the stream can deliver a frame');

    // ── THE THREE PHASE/ROUND LABELS COME FROM THE PURE POLICY ─────────────
    const { gatePhaseStrip, gateRoundFact, phaseLabel, GATE_PHASES } = await import('./public/gate-phase-policy.mjs');
    // At the cap there is no next round; "round 2/2 · expecting r3" pointed the reader at a review
    // that would never be requested (live run 20260806-164809-hiju).
    assert.equal(gateRoundFact({ round: 2, roundCap: 2, expectedRound: 3 }), 'round 2/2 · round cap reached');
    assert.equal(gateRoundFact({ round: 3, roundCap: 2, expectedRound: 4 }), 'round 3/2 · round cap reached',
      'past the cap reads the same way, never a prediction');
    assert.equal(gateRoundFact({ round: 1, roundCap: 3, expectedRound: 2 }), 'round 1/3 · expecting r2',
      'mid-loop still names the round it is waiting for');
    assert.equal(gateRoundFact({ round: 1, roundCap: null, expectedRound: 2 }), 'round 1/? · expecting r2',
      'an unknown cap is unknown, not assumed reached');
    assert.equal(gateRoundFact({ round: 2, roundCap: 2 }), null, 'no expectation, no fact');
    assert.ok(!/expecting r\$\{/.test(app), 'the browser no longer builds that string itself');

    // Fix is a phase the gate reports; it rendered as a raw lowercase "fix" after Verify.
    assert.deepEqual(GATE_PHASES.map(([k]) => k), ['igniting', 'classify', 'plan', 'implement', 'review', 'fix', 'verify'],
      'Fix sits between Review and Verify, where it runs');
    assert.match(gatePhaseStrip('fix'), /Review {2}· {2}▸ Fix {2}· {2}Verify/, 'an active Fix is marked in place');
    assert.ok(!/▸ fix/.test(gatePhaseStrip('fix')), 'and never as the raw lowercase key');
    // Any future unstamped phase stays visible AND spelled like a label.
    assert.match(gatePhaseStrip('prep'), /▸ Prep$/, 'an unknown phase is labelled, not printed raw');
    assert.equal(phaseLabel('land'), 'Land');
    assert.equal(phaseLabel(''), '', 'nothing in, nothing out');
    assert.equal(gatePhaseStrip(null), gatePhaseStrip(undefined), 'no active phase marks nothing');
  }

  // ── A REFUSAL MAY NOT CLAIM PRESERVATION IT DID NOT MEASURE ────────────────
  // The refusal report said "its state is preserved" while HEAD had in fact moved to a fresh
  // commit (live run 20260806-110809-2r9j). Preservation is now a measured comparison.
  {
    const { worktreeSnapshot, snapshotsAgree } = await import('./lib/code-lane.mjs');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');
    const wt = mkdtempSync(pj(tmpdir(), 'cls-snap-'));
    const g = (...a) => { try { return execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
    if (g('init', '-q') !== null) {
      g('config', 'user.email', 't@e.com'); g('config', 'user.name', 't');
      writeFileSync(pj(wt, 'a.txt'), 'one\n');
      g('add', '-A'); g('commit', '-qm', 'one');
      const before = worktreeSnapshot(wt);
      assert.equal(before.head?.length, 40, 'the snapshot measures a real HEAD');
      assert.equal(before.dirty, false, 'and cleanliness');
      assert.equal(snapshotsAgree(before, worktreeSnapshot(wt)), true, 'an untouched worktree AGREES with itself');
      // A COMMIT between refusal and shutdown must break agreement — the exact WP9 shape.
      writeFileSync(pj(wt, 'a.txt'), 'two\n');
      g('add', '-A'); g('commit', '-qm', 'two');
      const after = worktreeSnapshot(wt);
      assert.notEqual(after.head, before.head, 'the commit moved HEAD');
      assert.equal(snapshotsAgree(before, after), false, 'so preservation can NOT be claimed');
      // An uncommitted edit alone also breaks it.
      writeFileSync(pj(wt, 'a.txt'), 'three\n');
      assert.equal(snapshotsAgree(after, worktreeSnapshot(wt)), false, 'a dirty tree is not preserved state either');
    }
    // UNKNOWN is never agreement: a snapshot that could not be measured must not read as proof.
    assert.equal(snapshotsAgree({ worktree: '/w', branch: null, head: 'a', dirty: false }, { worktree: '/w', branch: null, head: 'a', dirty: false }), false,
      'a null field means unknown, and unknown never proves preservation');
    assert.equal(snapshotsAgree(null, { worktree: '/w', branch: 'b', head: 'a', dirty: false }), false, 'a missing before-snapshot proves nothing');
    const none = worktreeSnapshot(null);
    assert.equal(none.head, null, 'no worktree yields an all-null snapshot');
    assert.equal(snapshotsAgree(none, none), false, 'which can never agree with itself');
  }

  // ── THE UI READS THE SEAL, NEVER THE MUTABLE TWIN ──────────────────────────
  // `report.recoveryOf` can be edited without changing receipt_id, and the UI rendered
  // it as authoritative — so a forged source run displayed under a valid receipt
  // (audit 2026-08-05, proven by setting it to `forged-source`). The pack's
  // session_log is receipt-covered, so that is what the UI must read.
  {
    const { sealedRecoveryLineage, lineageTrust } = await import('./public/run-ui-policy.mjs');
    const { buildEvidencePack } = await import('./lib/evidence-pack.mjs');
    const SHA = 'e3487e891d409fc218591602c6c8565b16af9094';
    const recoveryOf = { sourceRunId: 'real-source', sourceReceiptId: 'sha256:realreceipt', sourceReceiptStatus: 'validated', sourceAudit: 'independent_clean', parkedSha: SHA, shaProvenance: 'adopted_clean_worktree_head' };
    const pack = buildEvidencePack({
      goal: 'g', acceptanceContract: 'a'.repeat(40), lane: 'build', targetPath: '/r',
      evidence: { gateReport: { commit_sha: SHA }, verify: [{ pass: true, commitSha: SHA, source: 'studio_reverify' }], rounds: [], revisions: [] },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'passed', audit: 'not_run', publication: 'not_published' },
      models: { maker: null, reviewer: null, loop: { roundCap: 0 }, recovery: true },
      simulated: false, verifyCommand: 'true', createdAt: 1, recoveryOf,
    });

    const sealed = sealedRecoveryLineage(pack);
    assert.equal(sealed.sourceRunId, 'real-source', 'the lineage is parsed out of the SEALED session log');
    assert.equal(sealed.sourceReceiptId, 'sha256:realreceipt', 'including the source receipt');
    assert.equal(sealed.sourceAudit, 'independent_clean', 'and the source audit the linked wording depends on');
    assert.equal(sealed.parkedSha, SHA, 'and the candidate');
    assert.equal(sealed.shaProvenance, 'adopted_clean_worktree_head', 'and its provenance');

    const honest = lineageTrust(pack, recoveryOf);
    assert.equal(honest.trusted, true, 'an untouched pair is trusted');
    assert.deepEqual(honest.mismatched, [], 'with nothing mismatched');

    // THE FORGERY the audit performed: edit the twin, keep receipt_id.
    const forged = { ...recoveryOf, sourceRunId: 'forged-source' };
    const caught = lineageTrust(pack, forged);
    assert.equal(caught.trusted, false, 'a forged source run is CAUGHT');
    assert.deepEqual(caught.mismatched, ['sourceRunId'], 'and named precisely');
    assert.match(caught.reason, /disagree with the sealed receipt/, 'with a reason the UI can show');
    assert.equal(caught.sealed.sourceRunId, 'real-source', 'and the SEALED value is still what is available to render');
    assert.notEqual(caught.sealed.sourceRunId, 'forged-source', 'the forgery is never the value returned');
    // Every lineage field is compared, not just the run id.
    for (const [key, val] of [['sourceReceiptId', 'sha256:forged'], ['parkedSha', 'b'.repeat(40)], ['shaProvenance', 'sealed_by_source'], ['sourceAudit', 'independent_findings']]) {
      const t = lineageTrust(pack, { ...recoveryOf, [key]: val });
      assert.deepEqual(t.mismatched, [key], `a forged ${key} is caught`);
    }
    // A non-recovery receipt yields no lineage at all, so no recovery copy unlocks.
    const plain = buildEvidencePack({
      goal: 'g', acceptanceContract: 'a'.repeat(40), lane: 'build', targetPath: '/r',
      evidence: { gateReport: { commit_sha: SHA }, verify: [], rounds: [], revisions: [] },
      statuses: { schemaVersion: 1, execution: 'completed', verification: 'not_run', audit: 'not_run', publication: 'not_published' },
      models: { maker: { provider: 'anthropic', model: 'opus' }, reviewer: { provider: 'openai', model: 'gpt-5.6-sol' } },
      simulated: false, createdAt: 1,
    });
    assert.equal(sealedRecoveryLineage(plain), null, 'a non-recovery pack has no sealed lineage');
    assert.equal(lineageTrust(plain, recoveryOf).trusted, false, 'so a recoveryOf field on it is NOT trusted');
    assert.equal(lineageTrust(null, recoveryOf).trusted, false, 'and a missing pack unlocks nothing');
  }

  // The wiring, not just the policy: breaking app.js to read the mutable twin was NOT
  // caught by the pure tests above (found while break-testing, 2026-08-05). The twin is
  // now absent from client state entirely, which is asserted here so it cannot creep
  // back — the live browser proof covers the rendering itself.
  {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
    assert.ok(!/state\.recoveryDetail/.test(app), 'the unsealed lineage twin is not held in client state at all');
    assert.match(app, /recoveryPill\(dimensions, state\.sealedLineage\)/, 'the pill reads the SEALED lineage');
    assert.match(app, /doneBanner\([^)]*state\.sealedLineage/, 'and so does the terminal banner');
    assert.match(app, /lineageTrust\(report\.evidencePack, report\.recoveryOf\)/, 'and the twin is used only to detect disagreement');
  }

  // ── THE SANITIZED FIXTURE IS A VALID RECEIPT ───────────────────────────────
  // Redaction changed the content the pack was sealed over, so the shipped fixture's
  // ids no longer described it: `artifact_id does not match the sealed artifact
  // contents`. A fixture that is itself an invalid receipt cannot stand in for a real
  // one, and the recovery path was accepting its receipt_id anyway.
  {
    const { validateEvidencePack } = await import('../../packages/trust/lib/validate.mjs');
    const { readFileSync } = await import('node:fs');
    const f = JSON.parse(readFileSync(new URL('./fixtures/wp6-needs-decision.report.json', import.meta.url), 'utf8'));
    const v = validateEvidencePack(f.evidencePack);
    assert.equal(v.ok, true, `the sanitized fixture's pack VALIDATES after resealing (${v.error ?? ''})`);
    // And the recovery path links it, because it validates.
    const { recoveryTarget } = await import('./lib/code-lane.mjs');
    const t = recoveryTarget(f);
    assert.equal(t.sourceReceiptId, f.evidencePack.receipt_id, 'a validated source pack IS linked');
    assert.equal(t.sourceReceiptStatus, 'validated', 'and recorded as validated');
    // Tamper with it and the link is withheld, with the reason.
    const tampered = JSON.parse(JSON.stringify(f));
    tampered.evidencePack.goal = 'a different goal than the one that was sealed';
    const tt = recoveryTarget(tampered);
    assert.equal(tt.sourceReceiptId, null, 'a tampered source pack is NOT linked');
    assert.match(tt.sourceReceiptStatus, /^unusable: /, 'and the refusal names the validation failure');
    assert.equal(tt.eligible, true, 'the recovery itself still proceeds — it just claims no source review');
  }

  // ── THE RECOVERY PILL SAYS WHAT HAPPENED, WITHOUT CLAIMING AN AUDIT ────────
  {
    const { recoveryPill, standingPill } = await import('./public/story.mjs');
    const dims = { verification: 'passed', audit: 'not_run' };
    const SHA = 'e3487e891d409fc218591602c6c8565b16af9094';

    // A VALIDATED source receipt that records an audit is the only thing that earns
    // "source review linked" — that wording is a claim about ANOTHER receipt.
    const linkedLineage = { sourceRunId: '20260805-104802-rv4d', sourceReceiptId: 'sha256:5819cc', sourceAudit: 'independent_clean', parkedSha: SHA };
    const linked = recoveryPill(dims, linkedLineage);
    assert.equal(linked.label, 'Verification passed · source review linked', 'a validated source audit earns the linked wording');
    assert.match(linked.title, /NO review/, 'and still states this receipt performed no review');
    assert.match(linked.title, /links but does not absorb/, 'and that it is a link, not inheritance');

    // A LEGACY source with no sealed receipt has no review to link. This said
    // "source review linked" anyway (audit 2026-08-05).
    const bare = recoveryPill(dims, { sourceRunId: 'legacy-run', sourceReceiptId: null, sourceAudit: null, parkedSha: SHA, sourceReceiptStatus: 'unusable: the source run sealed no evidence pack' });
    assert.equal(bare.label, 'Verification passed', 'with nothing to link, the pill says only what this run proved');
    assert.ok(!/source review linked/.test(bare.label), 'and never claims a linked review');
    assert.match(bare.title, /NO source review is available/, 'the explanation says so explicitly');
    assert.match(bare.title, /nothing here has been independently reviewed/i, 'in plain words');
    assert.match(bare.title, /sealed no evidence pack/, 'carrying the reason it is unusable');
    // A receipt id WITHOUT a recorded audit does not earn it either.
    const noAudit = recoveryPill(dims, { sourceRunId: 'r', sourceReceiptId: 'sha256:abc', sourceAudit: 'not_run', parkedSha: SHA });
    assert.equal(noAudit.label, 'Verification passed', 'a source receipt with audit not_run links no review');
    // Nor does an audit with no validated receipt behind it.
    const noReceipt = recoveryPill(dims, { sourceRunId: 'r', sourceReceiptId: null, sourceAudit: 'independent_clean', parkedSha: SHA });
    assert.equal(noReceipt.label, 'Verification passed', 'an audit value with no validated receipt links nothing');

    for (const p2 of [linked, bare, noAudit, noReceipt]) {
      assert.ok(!/Not verified/i.test(p2.label), 'never "Not verified" over a sealed passing verification');
      assert.ok(!/already reviewed/i.test(p2.label + p2.title), 'and never an unconditional "already reviewed"');
      assert.equal(p2.className, 'standing advisory', 'styled advisory, never trusted');
    }
    // NARROW: no lineage, or no passing verification, and the derived standing stands.
    assert.equal(recoveryPill(dims, null), null, 'a non-recovery run keeps the derived standing');
    assert.equal(recoveryPill({ verification: 'infra_failed', audit: 'not_run' }, linkedLineage), null, 'an unverified recovery gets no upgrade');
    assert.equal(recoveryPill({ verification: 'failed', audit: 'not_run' }, linkedLineage), null, 'and neither does a failed one');
    assert.equal(standingPill('done', 'unverified').label, 'Not verified', 'the underlying standing vocabulary is unchanged');
  }

  // ── A BOUND GREEN IS NOT SUMMARIZED AS "NOT VERIFIED" ──────────────────────
  // A verification-only recovery is {verification: passed, audit: not_run} by
  // construction. The default branch summarized that as "DONE (gate claim)… audit
  // not run", which reads as the opposite of what happened. It must say what this
  // receipt proves and where the review evidence lives — without claiming to have
  // inherited it.
  {
    const { doneBanner } = await import('./public/banner.mjs');
    const dims = { verification: 'passed', audit: 'not_run', execution: 'completed', publication: 'not_published' };
    const recoveryOf = { sourceRunId: '20260805-104802-rv4d', sourceReceiptId: 'sha256:abcdef123456789', parkedSha: 'e3487e891d409fc218591602c6c8565b16af9094' };
    const b = doneBanner('done', 'unverified', dims, recoveryOf);
    assert.equal(b.cls, 'good', 'a commit-bound green is not styled as a problem');
    assert.match(b.label, /VERIFIED HERE/, 'it says verification passed here');
    assert.match(b.label, /e3487e891d40/, 'and names the candidate it is bound to');
    assert.match(b.label, /20260805-104802-rv4d/, 'and points at the source run for the review evidence');
    assert.ok(!/Not verified|not verified/.test(b.label), 'and never calls a bound green "not verified"');
    // It must NOT claim the audit carried over.
    assert.ok(!/reviewed and verified/i.test(b.label), 'it never claims independent verified standing');
    assert.match(b.label, /No review ran in this recovery/, 'it states plainly that no review ran here');
    // WITHOUT a recovery link, the honest uncorroborated copy still applies — this
    // wording is for a linked recovery only, never a general upgrade.
    const plain = doneBanner('done', 'unverified', dims, null);
    assert.match(plain.label, /does not corroborate/, 'a non-recovery run keeps the uncorroborated copy');
    assert.equal(plain.cls, 'meh', 'and its cautious styling');
    // And a recovery whose verification did NOT pass gets no upgrade either.
    const notPassed = doneBanner('done', 'unverified', { ...dims, verification: 'infra_failed' }, recoveryOf);
    assert.match(notPassed.label, /does not corroborate/, 'an unverified recovery is not dressed up');
  }

  // ── BUILD RECOVERY IS OFFERED ON THE STATE WP6 ACTUALLY REACHES ────────────
  // An inconclusive verification resolves to needs_decision, but the terminal
  // renderer's recovery list was an inline literal of stopped/failed/verify_failed
  // — so the operator landed on the exact screen the recovery control exists for
  // and found no control (field report 2026-08-05). The rule is pure now.
  {
    const { offersBuildRecovery, terminalBannerClass, terminalFailureBanner } = await import('./public/run-ui-policy.mjs');
    assert.equal(offersBuildRecovery('needs_decision', 'build'), true,
      'needs_decision — the state an inconclusive WP6 run ends in — OFFERS recovery');
    for (const s of ['stopped', 'failed', 'verify_failed']) {
      assert.equal(offersBuildRecovery(s, 'build'), true, `${s} still offers recovery`);
    }
    // Controls: a finished run has nothing to recover, and words lanes never do.
    for (const s of ['done', 'done_with_findings', 'no_changes', 'running']) {
      assert.equal(offersBuildRecovery(s, 'build'), false, `${s} offers no recovery`);
    }
    assert.equal(offersBuildRecovery('needs_decision', 'freeform'), false, 'the words lanes have no gate to resume');
    assert.equal(offersBuildRecovery('needs_decision', 'comparison'), false, 'a comparison is not a build gate');

    // And needs_decision is not a FAILURE: a parked, intact candidate rendered red
    // repeats the inconclusive-as-red misreading on the very state being surfaced.
    // The control drives TWO different actions and the copy must say which. It used to
    // read "Resume the gate … finished work skips and only unproven work re-runs",
    // which described neither: recovery reruns nothing, and the gate reruns everything.
    const { recoveryAction } = await import('./public/run-ui-policy.mjs');
    const rec = recoveryAction('needs_decision');
    assert.equal(rec.mode, 'verify_only', 'a parked candidate takes the verification-only lane');
    assert.equal(rec.button, 'Verify the parked candidate', 'and the button says exactly that');
    assert.match(rec.note, /Runs verification only/, 'the note says verification only');
    assert.match(rec.note, /no models, planning, implementation, or review rerun/, 'and names what does NOT rerun');
    assert.ok(!/finished work skips/.test(rec.note), 'the stale "finished work skips" promise is gone');
    assert.ok(!/Resume the gate/.test(rec.button), 'and it is not called resuming the gate');
    for (const s of ['stopped', 'failed', 'verify_failed', 'incomplete']) {
      const g = recoveryAction(s);
      assert.equal(g.mode, 'gate', `${s} re-enters the gate`);
      assert.equal(g.button, 'Resume the gate', `${s} keeps the gate wording`);
      assert.match(g.note, /reruns its phases/, `${s} says the gate reruns phases`);
      assert.ok(!/finished work skips/.test(g.note), `${s} makes no skip promise either`);
    }

    assert.equal(terminalBannerClass('needs_decision', {}), 'meh', 'needs_decision is not red');
    assert.equal(terminalBannerClass('verify_failed', {}), 'bad', 'a real red still reads red');
    assert.equal(terminalBannerClass('done', { good: true }), 'good', 'and a green still reads green');
    const nd = terminalFailureBanner('needs_decision', 'build');
    assert.match(nd, /NEEDS A DECISION/, 'the banner names the state instead of leaking the raw enum');
    assert.match(nd, /parked/, 'and says the candidate is parked');
    assert.match(nd, /verification command/, 'and points at the lever that unblocks it');
    assert.doesNotMatch(nd, /^needs_decision$/, 'never the bare status string');
  }

  // ── TRI-STATE VERIFY RENDERING + ACTIONABLE INCONCLUSIVE (WP6 2026-08-05) ──
  {
    const { verifySummary } = await import('./public/run-ui-policy.mjs');
    // pass:null is a WITHHELD verdict. `!ev.pass` rendered it as "RED. Sending
    // back for a fix.", so a good candidate looked broken.
    const amber = verifySummary({ pass: null, warnings: 0, skipped: 3 });
    assert.equal(amber.cls, 'inconclusive', 'pass:null renders amber, never the red class');
    assert.match(amber.label, /INCONCLUSIVE/, 'the label says inconclusive');
    assert.match(amber.label, /could not run/, 'and that verification could not run');
    assert.match(amber.label, /stays parked/, 'and that the candidate remains parked');
    assert.doesNotMatch(amber.label, /RED|Sending back/, 'an inconclusive run is never described as red');
    assert.equal(verifySummary({ pass: undefined }).cls, 'inconclusive', 'a missing pass is inconclusive too, not red');
    // The two controls: real green and real red keep their meaning.
    assert.equal(verifySummary({ pass: true }).cls, 'pass');
    assert.match(verifySummary({ pass: true, skipped: 2 }).label, /GREEN, with caveats/);
    const red = verifySummary({ pass: false });
    assert.equal(red.cls, 'fail');
    assert.match(red.label, /RED/, 'a real red is still red');
  }
  {
    // An inconclusive terminal must OFFER something. Before this it returned
    // needs_decision immediately and the screen had no controls at all.
    const asked = [];
    const events = [];
    const base = { emit: (t, d) => events.push({ t, ...d }), log: () => {}, stage: () => {}, igniteGate: async () => ({ status: 'done' }), answers: [] };

    // 1. Retry that PASSES → done_with_findings, marked as verified on retry.
    // `raw.head` is the parked sha because verify.py names the head it checked;
    // a verdict that names no head is refused (proved in the block above).
    const pass = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha1', branch: 'camus/x' }, {
      ...base,
      ask: async (q) => { asked.push(q); return q.options.find((o) => o.startsWith('Retry')); },
      verifyCandidate: async () => ({ ran: true, pass: true, raw: { head: 'sha1' } }),
    });
    // Review-clean + a bound retry green is simply DONE; the findings qualifier is
    // reserved for an unresolved review (proved in the integration block above).
    assert.equal(pass.status, 'done', 'a retry that passes on a review-clean candidate yields DONE');
    assert.equal(pass.verifiedOnRetry, true);
    assert.ok(asked[0].options.some((o) => o.startsWith('Retry')), 'the retry option is offered');
    assert.ok(asked[0].options.some((o) => o.startsWith('Record')), 'human-attested evidence is offered');
    assert.ok(asked[0].options.some((o) => o.startsWith('Leave')), 'leaving it parked is offered');

    // 2. Retry that comes back RED → a real red, not a fabricated green.
    const red = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha1' }, {
      ...base,
      ask: async (q) => q.options.find((o) => o.startsWith('Retry')),
      verifyCandidate: async () => ({ ran: true, pass: false, raw: { head: 'sha1', failures: [{ stage: 'test' }] } }),
    });
    assert.equal(red.status, 'verify_failed', 'a retry that fails reports the real red');

    // 3. Retry that STILL cannot run → re-offers, and the fallback is honest.
    let tries = 0;
    const stuckEvents = [];
    const stuck = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha1' }, {
      ...base,
      emit: (t, d) => stuckEvents.push({ t, ...d }),
      ask: async (q) => (++tries === 1 ? q.options.find((o) => o.startsWith('Retry')) : 'Leave the candidate parked and stop here'),
      verifyCandidate: async () => ({ ran: false, error: 'dotnet workload missing' }),
    });
    assert.equal(stuck.status, 'needs_decision', 'a still-unrunnable check leaves an honest needs_decision');
    assert.equal(tries, 2, 'and it re-asked instead of inventing a verdict');
    // The guard that matters: when verification never RAN, nothing green is emitted.
    // (A review-clean candidate whose bound retry genuinely passes does emit `done`
    // — that is the audited contract, proved in the integration block above.)
    assert.ok(!stuckEvents.some((e) => e.t === 'status' && ['done', 'done_with_findings'].includes(e.status)),
      'a check that could not run never produces a green of any kind');
    assert.ok(!stuckEvents.some((e) => e.t === 'verify_result' && e.pass === true),
      'and no passing verify_result is invented');

    // 4. Human attestation is recorded as ATTESTATION, never as a machine green.
    const attested = await resolveGateTerminal({ status: 'verify_inconclusive', parkedSha: 'sha1' }, {
      ...base,
      ask: async (q) => q.options.find((o) => o.startsWith('Record')),
      verifyCandidate: async () => ({ ran: false, error: 'x' }),
    });
    assert.equal(attested.humanAttestedVerification, true, 'the human claim is recorded');
    assert.equal(attested.deterministicVerification, 'inconclusive', 'and deterministic verification stays honestly inconclusive');
    assert.equal(attested.landed, false, 'nothing was merged');

    // 5. With no verifier available, retry is not offered — but the other two are.
    const noRetry = await resolveGateTerminal({ status: 'verify_inconclusive' }, {
      ...base,
      ask: async (q) => {
        assert.ok(!q.options.some((o) => o.startsWith('Retry')), 'no verifier → no retry option');
        return 'Leave the candidate parked and stop here';
      },
    });
    assert.equal(noRetry.status, 'needs_decision');
  }

  // A verify-RED unresolved is the one honest halt; verify-inconclusive is a decision.
  {
    const red = await harness([{ status: 'review_unresolved', verifyClean: false, blocking: [] }], []).run();
    assert.equal(red.status, 'verify_failed', 'verify-red + unresolved is genuinely not done');
    const incon = await harness([{ status: 'review_unresolved', verifyClean: null, blocking: [] }], []).run();
    assert.equal(incon.status, 'needs_decision', 'verify could not run → a decision, never a failure');
  }

  // (1) The gate can ask a HUMAN QUESTION after a Refine. review_unresolved →
  // Refine → the gate returns needs_human → the loop ASKS and re-invokes (never
  // classifies the question as failed) → the answered run converges to done.
  {
    const REFINE = 'Refine: run more review/fix rounds on the open findings';
    const h = harness(
      [greenUnresolved(1), { status: 'needs_human', question: 'Which API should the guard use?' }, doneReport],
      [REFINE, 'Use the v2 API.'],
    );
    const res = await h.run();
    assert.equal(res.status, 'done', 'a post-Refine gate question is answered and re-invoked, not failed');
    assert.equal(h.ignites(), 2, 'the gate was re-invoked for the Refine and again after the human answer');
    assert.ok(h.asked.some((q) => q.text.includes('Which API')), 'the gate\'s question was surfaced to the human');
    assert.ok(!h.events.some((e) => e.t === 'status' && e.status === 'failed'), 'a gate question never becomes a failed status');
  }

  // (2) A DIRECT verify_inconclusive gate result is a decision, never a red.
  {
    const incon = await harness([{ status: 'verify_inconclusive' }], []).run();
    assert.equal(incon.status, 'needs_decision', 'a direct verify_inconclusive maps to needs_decision');
    const inconEvents = harness([{ status: 'verify_inconclusive' }], []);
    await inconEvents.run();
    assert.ok(inconEvents.events.some((e) => e.t === 'status' && e.status === 'needs_decision'), 'and emits needs_decision, not verify_failed');
    // Ground-truth RED is still preserved as a real failure.
    const red = await harness([{ status: 'verify_failed' }], []).run();
    assert.equal(red.status, 'verify_failed', 'an actual deterministic RED stays verify_failed');
    // And needs_decision derives to interrupted, never failed.
    const { deriveStatusDimensions } = await import('./lib/status-dims.mjs');
    assert.equal(deriveStatusDimensions({ lane: 'build', status: 'needs_decision', evidence: { gateReport: null, verify: [], rounds: [], revisions: [] } }).execution, 'interrupted', 'needs_decision is interrupted, not failed');
  }

  // (3) refineCap is ENFORCED on the answer, not merely hidden: an out-of-options
  // "Refine" after the cap must NOT invoke the gate — it re-asks with no model
  // turn. refineCap:0 + arbitrary "Refine" answers → zero gate invocations.
  {
    const REFINE = 'Refine: run more review/fix rounds on the open findings';
    let ignites = 0;
    let asks = 0;
    const res = await resolveGateTerminal(greenUnresolved(1), {
      emit: () => {}, log: () => {}, stage: () => {},
      // Answer "Refine" a few times (never offered at cap 0), then finally a
      // valid option so the run can terminate.
      ask: async () => { asks += 1; return asks <= 3 ? REFINE : 'Leave it parked and stop here'; },
      igniteGate: async () => { ignites += 1; return greenUnresolved(ignites); },
      answers: [], refineCap: 0,
    });
    assert.equal(ignites, 0, 'refineCap:0 with arbitrary Refine answers invokes the gate ZERO times');
    assert.ok(asks >= 4, 'each out-of-options Refine re-asked instead of spending a gate round');
    assert.equal(res.status, 'done_with_findings', 'and a valid option still resolves the candidate');
    assert.equal(res.landed, false);
  }

  // The DEFAULT refine allowance is 1 (pragmatic token use): the caller gets one
  // refine unless it passes a larger refineCap.
  {
    const REFINE = 'Refine: run more review/fix rounds on the open findings';
    let ignites = 0;
    const res = await resolveGateTerminal(greenUnresolved(0), {
      emit: () => {}, log: () => {}, stage: () => {},
      ask: async (q) => q.options.find((o) => o.startsWith('Refine')) ?? 'Leave it parked and stop here',
      igniteGate: async () => { ignites += 1; return greenUnresolved(ignites); },
      answers: [], // refineCap omitted → default
    });
    assert.equal(ignites, 1, 'the default refine allowance is exactly one gate round');
    assert.equal(res.status, 'done_with_findings');
  }
}

console.log('verify.test: all assertions passed');
