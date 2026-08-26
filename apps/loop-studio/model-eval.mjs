#!/usr/bin/env node

// One invocation buys exactly one bounded evaluation arm. It reads no provider
// credentials and never launches a matrix implicitly: credentials stay in the
// already-running Studio process, while this client receives only Studio's
// short-lived local session token.

import { findEvaluationCase, loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { qualityFloorPassed } from './lib/comparison.mjs';
import { loadJudgeCalibration } from './lib/judge-calibration.mjs';
import { loadEvaluationReports, summarizeEvaluationReports } from './lib/model-eval-summary.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const campaign = loadModelEvalCampaign();
const campaignHash = modelEvalCampaignHash(campaign);
const __dirname = dirname(fileURLToPath(import.meta.url));

function die(message) {
  console.error(`model-eval: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:1913', runs: join(__dirname, 'runs'), list: false, calibration: false, summary: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') out.list = true;
    else if (arg === '--calibration') out.calibration = true;
    else if (arg === '--summary') out.summary = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (['--profile', '--case', '--candidate', '--base', '--runs'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) die(`${arg} requires a value`);
      out[arg.slice(2)] = value;
      index += 1;
    } else die(`unknown argument ${arg}`);
  }
  return out;
}

function localBase(value) {
  let url;
  try { url = new URL(value); } catch { die('--base must be a valid local Studio URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    die('--base must be an http:// loopback URL; the Studio session token is never sent elsewhere');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function rowUsage(rows) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0 };
  const observed = { input_tokens: false, cached_input_tokens: false, output_tokens: false, duration_ms: false };
  for (const row of rows) {
    const usage = row?.usage ?? {};
    for (const field of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      if (Number.isFinite(usage[field])) { totals[field] += usage[field]; observed[field] = true; }
    }
    if (Number.isFinite(row?.duration_ms)) { totals.duration_ms += row.duration_ms; observed.duration_ms = true; }
  }
  return Object.fromEntries(Object.entries(totals).map(([field, total]) => [field, observed[field] ? total : null]));
}

function summarize(report, { candidate, profile, evaluationCase, screen }) {
  const rounds = report.evidence?.rounds ?? [];
  const makerUsage = rowUsage(report.makerUsage ?? []);
  const reviewerUsage = rowUsage(rounds);
  const usageRows = [makerUsage, reviewerUsage];
  const totalTokens = usageRows.every((usage) => [usage.input_tokens, usage.output_tokens].every(Number.isFinite))
    ? usageRows.reduce((total, usage) => total + usage.input_tokens + usage.output_tokens, 0)
    : null;
  const latestReview = rounds.at(-1) ?? null;
  const deterministicPrecheck = report.evidence?.verify?.find((item) => item.source === 'evaluation_case_precheck')?.pass ?? null;
  const humanInterventions = Array.isArray(report.answers) ? report.answers.length : 0;
  const floorPassed = deterministicPrecheck === true && humanInterventions === 0 && qualityFloorPassed(report.evidencePack);
  const qualityVerdict = !floorPassed
    ? 'fail'
    : report.evidencePack?.statuses?.verification === 'passed_with_caveats' || report.status === 'done_with_findings'
      ? 'pass_with_caveats'
      : 'pass';
  return {
    campaignId: campaign.id,
    evaluationConfigHash: campaignHash,
    standing: campaign.standing,
    evidenceEligibility: candidate.evidenceEligibility,
    runId: report.id,
    profile: profile.id,
    case: evaluationCase.id,
    planPolicy: profile.planPolicy,
    screen: screen.id,
    candidate: candidate.id,
    pairing: {
      makerRequested: `${candidate.backend}:${candidate.model}`,
      makerActual: report.makerActualModels?.at(-1) ?? report.evidencePack?.pairing?.executor?.actual ?? null,
      reviewerRequested: `${screen.reviewer.backend}:${screen.reviewer.model}`,
      reviewerActual: report.evidencePack?.pairing?.auditor?.actual ?? null,
    },
    result: {
      status: report.status,
      qualityFloorPassed: floorPassed,
      qualityVerdict,
      verification: report.statuses?.verification ?? null,
      audit: report.statuses?.audit ?? null,
      reviewVerdict: latestReview?.verdict ?? null,
      deterministicPrecheck,
      humanInterventions,
      findingCount: latestReview?.findings?.length ?? null,
      coverageMet: latestReview?.coverageAssessments?.filter((item) => item.decision === 'met').length ?? null,
      coverageTotal: latestReview?.coverageAssessments?.length ?? null,
    },
    economics: {
      wallDurationMs: Number.isInteger(report.startedAt) && Number.isInteger(report.endedAt) ? report.endedAt - report.startedAt : null,
      maker: makerUsage,
      reviewer: reviewerUsage,
      totalInputAndOutputTokens: totalTokens,
    },
    receipt: {
      artifactId: report.evidencePack?.artifact_id ?? null,
      receiptId: report.evidencePack?.receipt_id ?? null,
      path: `runs/${report.id}/report.json`
    }
  };
}

async function responseJson(response, label) {
  let value = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(`${label}: ${value?.error || `HTTP ${response.status}`}`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node model-eval.mjs --profile <tier> --case <case-id> --candidate <id> [--base http://127.0.0.1:1913] [--json]');
  console.log('       node model-eval.mjs --list [--json]');
  console.log('       node model-eval.mjs --calibration [--json]');
  console.log('       node model-eval.mjs --summary [--profile simple|balanced|difficult] [--runs ./runs] [--json]');
  console.log('One invocation buys one bounded maker/case/judge arm. Failed deterministic case checks stop before model review.');
  process.exit(0);
}
if (args.summary) {
  if (args.profile && !campaign.profiles.some((profile) => profile.id === args.profile)) {
    die(`choose --profile ${campaign.profiles.map((profile) => profile.id).join('|')}`);
  }
  const { reports, unreadableReports } = loadEvaluationReports(args.runs);
  const { summary: calibrationSummary } = loadJudgeCalibration(campaign);
  const summary = summarizeEvaluationReports(campaign, campaignHash, reports, calibrationSummary, { profile: args.profile ?? null });
  summary.unreadableReports = unreadableReports;
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Campaign ${summary.campaignId} · ${summary.campaignStanding} · cross-screen ${summary.crossScreenRanking}`);
    console.table(summary.groups.map((group) => ({
      profile: group.profile,
      candidate: group.candidate,
      screen: group.screen,
      cases: `${group.distinctCases.length}/${group.requiredDistinctCases}`,
      floor: `${group.qualityFloorPasses}/${group.trials}`,
      precheck_red: group.deterministicPrecheckFailures,
      median_wall_ms: group.medianWallDurationMs,
      maker_in: group.medianMakerInputTokens,
      standing: group.recommendationStanding,
    })));
    if (summary.ignoredReports || summary.unreadableReports) {
      console.log(`Ignored ${summary.ignoredReports} stale/simulated/unbound report(s); ${summary.unreadableReports} unreadable report(s).`);
    }
  }
  process.exit(0);
}
if (args.calibration) {
  const { summary } = loadJudgeCalibration(campaign);
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Calibration ${summary.campaignId} · cross-screen ${summary.crossScreenRanking}`);
    console.log(`Human labels ${summary.humanLabeledArtifacts}; shared screen set ${summary.sharedArtifacts}; minimum ${summary.minimumHumanLabeledArtifacts} at ${summary.minimumAgreement}`);
    console.table(summary.judges);
  }
  process.exit(0);
}
if (args.list) {
  const rows = campaign.candidates.map((candidate) => ({
    id: candidate.id,
    seat: `${candidate.backend}:${candidate.model}`,
    eligibility: candidate.evidenceEligibility,
    priority: candidate.priority.join(', '),
  }));
  const profiles = campaign.profiles.map((profile) => ({ id: profile.id, cases: profile.cases.map((evaluationCase) => evaluationCase.id) }));
  if (args.json) console.log(JSON.stringify({ campaign: campaign.id, standing: campaign.standing, calibration: campaign.calibration.status, profiles, candidates: rows }, null, 2));
  else {
    console.log(`Campaign ${campaign.id} (${campaign.standing})`);
    for (const profile of profiles) console.log(`  ${profile.id}: ${profile.cases.join(', ')}`);
    console.table(rows);
  }
  process.exit(0);
}

const profile = campaign.profiles.find((entry) => entry.id === args.profile);
if (!profile) die(`choose --profile ${campaign.profiles.map((entry) => entry.id).join('|')}`);
const treatment = findEvaluationCase(campaign, profile.id, args.case);
if (!treatment) die(`choose --case ${profile.cases.map((entry) => entry.id).join('|')}`);
const evaluationCase = treatment.evaluationCase;
const candidate = campaign.candidates.find((entry) => entry.id === args.candidate);
if (!candidate) die(`choose --candidate ${campaign.candidates.map((entry) => entry.id).join('|')}`);
const screen = campaign.independence.judgeScreens.find((entry) => entry.eligibleMakerProviders.includes(candidate.provider));
if (!screen) die(`no independent judge screen is registered for provider ${candidate.provider}`);
const base = localBase(args.base);

let activeRunId = null;
let token = null;
const stopActive = async () => {
  if (!activeRunId || !token) return;
  const runId = activeRunId;
  activeRunId = null;
  await fetch(`${base}/api/runs/${runId}/stop`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json', 'x-studio-token': token },
    body: '{}',
  }).catch(() => {});
};
process.once('SIGINT', () => { void stopActive().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void stopActive().finally(() => process.exit(143)); });

try {
  const status = await responseJson(await fetch(`${base}/api/status`), 'Studio status');
  token = status.token;
  const origin = base;
  const headers = { origin, 'content-type': 'application/json', 'x-studio-token': token };
  const liveCampaign = await responseJson(await fetch(`${base}/api/evaluation-campaign`, { headers: { origin } }), 'Studio evaluation campaign');
  if (liveCampaign.id !== campaign.id || liveCampaign.configHash !== campaignHash) {
    throw new Error('the running Studio and this evaluator have different campaign generations; restart Studio before spending');
  }
  const started = await responseJson(await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      goal: evaluationCase.goal,
      acceptanceContract: evaluationCase.acceptanceContract,
      lane: 'freeform',
      depth: profile.depth,
      ground: campaign.controls.ground,
      publish: campaign.controls.publish,
      iterationPolicy: campaign.controls.iterationPolicy,
      evaluationProfile: profile.id,
      evaluationCaseId: evaluationCase.id,
      evaluationCampaignId: campaign.id,
      evaluationConfigHash: campaignHash,
      pairing: {
        maker: { backend: candidate.backend, model: candidate.model },
        reviewer: { ...screen.reviewer },
      },
    }),
  }), 'start evaluation');
  activeRunId = started.id;
  console.error(`model-eval: started ${activeRunId} · ${profile.id}/${evaluationCase.id} · ${candidate.id} → ${screen.id} · hard wall ${profile.wallBudgetMinutes}m`);

  const startedAt = Date.now();
  const deadline = startedAt + profile.wallBudgetMinutes * 60_000;
  let nextProgressAt = startedAt + 30_000;
  let report = null;
  while (Date.now() < deadline && !report) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const response = await fetch(`${base}/api/runs/${activeRunId}/report`, { headers: { origin } });
    if (response.ok) report = await response.json();
    else if (response.status !== 404) await responseJson(response, 'read evaluation report');
    if (!report && Date.now() >= nextProgressAt) {
      console.error(`model-eval: ${activeRunId} still running · ${Math.round((Date.now() - startedAt) / 1000)}s`);
      nextProgressAt += 30_000;
    }
  }
  if (!report) {
    await stopActive();
    throw new Error(`the evaluation exceeded its registered ${profile.wallBudgetMinutes}-minute wall budget and was stopped`);
  }
  activeRunId = null;
  if (report.evaluationCampaignId !== campaign.id || report.evaluationConfigHash !== campaignHash
      || report.evaluationProfile !== profile.id || report.evaluationCaseId !== evaluationCase.id) {
    throw new Error('the sealed report does not match the requested campaign generation, profile, and case');
  }
  const summary = summarize(report, { candidate, profile, evaluationCase, screen });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`${summary.result.qualityVerdict.toUpperCase()} ${summary.runId} · ${summary.profile}/${summary.case} · ${summary.candidate} → ${summary.screen}`);
    console.log(`eligibility ${summary.evidenceEligibility} · precheck ${summary.result.deterministicPrecheck} · status ${summary.result.status} · verify ${summary.result.verification} · audit ${summary.result.audit} · review ${summary.result.reviewVerdict} · findings ${summary.result.findingCount}`);
    console.log(`wall ${summary.economics.wallDurationMs ?? 'unknown'}ms · maker out ${summary.economics.maker.output_tokens ?? 'unknown'} · reviewer out ${summary.economics.reviewer.output_tokens ?? 'unknown'} · total I/O tokens ${summary.economics.totalInputAndOutputTokens ?? 'unknown'}`);
    console.log(`receipt ${summary.receipt.path}`);
  }
} catch (error) {
  await stopActive();
  die(error.message || String(error));
}
