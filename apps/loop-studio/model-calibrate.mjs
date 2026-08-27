#!/usr/bin/env node

// Operator workflow for judge calibration. Artifact selection and persistence
// are deterministic; human labels are a separate explicit command; judge runs
// are resumable, one registered judge at a time, and cannot start before all
// human labels exist.

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadModelEvalCampaign, modelEvalCampaignHash } from './lib/model-eval-campaign.mjs';
import { loadEvaluationReports } from './lib/model-eval-summary.mjs';
import { judgeCalibrationPaths, loadJudgeCalibration } from './lib/judge-calibration.mjs';
import {
  calibrationQueueSummary,
  labelCalibrationArtifact,
  loadCalibrationQueue,
  persistCalibrationQueue,
  prepareCalibrationQueue,
  recordCalibrationJudgeFailure,
  recordCalibrationJudgeRun,
  resolveCalibrationArtifact,
} from './lib/model-eval-calibration.mjs';
import { reviewPrompt } from './lib/prompts.mjs';
import { extractThresholdLines } from './lib/verify.mjs';
import { runCodexReview } from './lib/adapters/codex.mjs';
import { runClaudeReview } from './lib/adapters/claude.mjs';

const campaign = loadModelEvalCampaign();
const configHash = modelEvalCampaignHash(campaign);
const __dirname = dirname(fileURLToPath(import.meta.url));

function die(message) {
  console.error(`model-calibrate: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { prepare: false, status: false, show: false, label: false, runJudge: false, all: false, json: false, help: false, runs: join(__dirname, 'runs') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prepare') out.prepare = true;
    else if (arg === '--status') out.status = true;
    else if (arg === '--show') out.show = true;
    else if (arg === '--label') out.label = true;
    else if (arg === '--run-judge') out.runJudge = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (['--runs', '--artifact', '--verdict', '--finding-presence', '--human', '--proxy', '--delegated-by', '--judge', '--generation'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) die(`${arg} requires a value`);
      out[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else die(`unknown argument ${arg}`);
  }
  return out;
}

function printStatus(queue, asJson, paths) {
  const workflow = calibrationQueueSummary(queue, campaign);
  const calibration = loadJudgeCalibration(campaign, paths.value).summary;
  const value = { generation: paths.generation, workflow, calibration, paths: { queue: paths.queue, labels: paths.value, artifacts: paths.artifactsDir } };
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`Calibration ${campaign.id} · labels ${workflow.labels}/${workflow.artifacts} (${workflow.humanLabels} human, ${workflow.proxyLabels} expert AI proxy) · judge runs ${workflow.judgeRuns}`);
    console.table(workflow.judges);
    console.log(`Cross-screen ranking: ${calibration.crossScreenRanking}; shared artifacts: ${calibration.sharedArtifacts}/${calibration.minimumHumanLabeledArtifacts}`);
    console.log(`Proxy comparison: ${calibration.proxyCrossScreenComparison}; shared proxy artifacts: ${calibration.proxySharedArtifacts}/${calibration.minimumHumanLabeledArtifacts}`);
    console.log(`Blinded artifacts: ${paths.artifactsDir}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const paths = judgeCalibrationPaths(
  args.generation ?? process.env.STUDIO_JUDGE_CALIBRATION_GENERATION ?? campaign.id,
);
const commands = [args.prepare, args.status, args.show, args.label, args.runJudge].filter(Boolean).length;
if (args.help || commands === 0) {
  console.log('Usage:');
  console.log('  node model-calibrate.mjs --prepare [--runs ./runs] [--generation <name>]');
  console.log('  node model-calibrate.mjs --status [--json] [--generation <name>]');
  console.log('  node model-calibrate.mjs --show --artifact <ordinal|id>');
  console.log('  node model-calibrate.mjs --label --artifact <ordinal|id> --verdict APPROVED|REVISE --finding-presence clean|findings --human <person>');
  console.log('  node model-calibrate.mjs --label --artifact <ordinal|id> --verdict APPROVED|REVISE --finding-presence clean|findings --proxy <agent> --delegated-by <person>');
  console.log('  node model-calibrate.mjs --run-judge --judge <gpt-sol|opus-4-8|gpt-luna> (--artifact <ordinal|id> | --all)');
  console.log('Human labels are blinded, immutable after judge execution starts, and required for every artifact before any judge spend.');
  process.exit(0);
}
if (commands !== 1) die('choose exactly one command');

if (args.prepare) {
  const { reports, unreadableReports } = loadEvaluationReports(args.runs);
  if (unreadableReports) die(`${unreadableReports} report(s) are unreadable; repair them before selecting calibration evidence`);
  const result = prepareCalibrationQueue(campaign, configHash, reports, { paths });
  if (!args.json) console.log(`${result.created ? 'Prepared' : 'Reused'} ${result.queue.artifacts.length} blinded artifacts at ${paths.artifactsDir}`);
  printStatus(result.queue, args.json, paths);
  process.exit(0);
}

const queue = loadCalibrationQueue(campaign, configHash, paths);

if (args.status) {
  printStatus(queue, args.json, paths);
  process.exit(0);
}

if (args.show) {
  if (!args.artifact) die('--show requires --artifact');
  const artifact = resolveCalibrationArtifact(queue, args.artifact);
  const file = join(paths.artifactsDir, artifact.artifactFile);
  if (args.json) console.log(JSON.stringify({ ordinal: artifact.ordinal, id: artifact.id, file, humanLabel: artifact.humanLabel }, null, 2));
  else console.log(readFileSync(file, 'utf8'));
  process.exit(0);
}

if (args.label) {
  if (!args.artifact || !args.verdict || !args.findingPresence || (Boolean(args.human) === Boolean(args.proxy)) || (args.proxy && !args.delegatedBy)) {
    die('--label requires artifact, verdict, finding presence, and exactly one of --human or --proxy; proxy labels also require --delegated-by');
  }
  labelCalibrationArtifact(queue, args.artifact, {
    verdict: args.verdict,
    findingPresence: args.findingPresence,
    human: args.human,
    proxy: args.proxy,
    delegatedBy: args.delegatedBy,
  });
  persistCalibrationQueue(queue, campaign, configHash, paths);
  const artifact = resolveCalibrationArtifact(queue, args.artifact);
  console.log(`Recorded immutable ${artifact.humanLabel.authority} label for artifact ${artifact.ordinal}: ${artifact.humanLabel.verdict}/${artifact.humanLabel.findingPresence} by ${artifact.humanLabel.labeledBy}`);
  printStatus(queue, args.json, paths);
  process.exit(0);
}

if (!args.judge || (!args.artifact && !args.all) || (args.artifact && args.all)) {
  die('--run-judge requires --judge and exactly one of --artifact or --all');
}
if (queue.artifacts.some((artifact) => !artifact.humanLabel)) die('every artifact needs a human label before any judge runs');
const judge = campaign.calibration.judges.find((entry) => entry.id === args.judge);
if (!judge) die(`choose --judge ${campaign.calibration.judges.map((entry) => entry.id).join('|')}`);
if (!['codex', 'claude'].includes(judge.backend)) die(`judge backend ${judge.backend} is not supported by the local calibration runner`);

const already = new Set(queue.judgeRuns.filter((run) => run.judgeId === judge.id).map((run) => run.artifactId));
const requested = args.all ? queue.artifacts : [resolveCalibrationArtifact(queue, args.artifact)];
const targets = requested.filter((artifact) => !already.has(artifact.id));
if (!targets.length) {
  console.log(`Judge ${judge.id} already has every requested artifact; no model call was made.`);
  printStatus(queue, args.json, paths);
  process.exit(0);
}

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const scratch = mkdtempSync(join(tmpdir(), 'camus-calibration-'));
let fatalError = null;
try {
  execFileSync('git', ['init', '-q'], { cwd: scratch, stdio: 'ignore' });
  mkdirSync(paths.receiptsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.receiptsDir, 0o700);
  for (const artifact of targets) {
    if (abort.signal.aborted) {
      fatalError = 'calibration judge run stopped by operator';
      break;
    }
    const sourceRunId = `cal-${judge.id}-${artifact.id.slice(7, 15)}-${Date.now()}`;
    const receiptDir = join(paths.receiptsDir, sourceRunId);
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    chmodSync(receiptDir, 0o700);
    console.error(`model-calibrate: ${judge.id} judging artifact ${artifact.ordinal}/${queue.artifacts.length} · fallback none`);
    let lastTick = 0;
    const adapter = judge.backend === 'codex' ? runCodexReview : runClaudeReview;
    const result = await adapter({
      model: judge.model,
      effort: judge.effort ?? null,
      prompt: reviewPrompt({
        goal: artifact.goal,
        acceptanceContract: artifact.acceptanceContract,
        lane: artifact.lane,
        draft: artifact.deliverable,
        round: 'judge calibration',
        priorFindings: [],
        answers: [],
        groundingEvidence: artifact.groundingEvidence,
        claims: artifact.claims,
        criteria: artifact.criteria,
        thresholds: extractThresholdLines(artifact.deliverable),
        auditOnly: true,
      }),
      claims: artifact.claims,
      criteria: artifact.criteria,
      thresholds: extractThresholdLines(artifact.deliverable),
      auditOnly: true,
      cwd: scratch,
      signal: abort.signal,
      receiptDir,
      onTick: (line) => {
        const now = Date.now();
        if (now - lastTick >= 10_000) { lastTick = now; console.error(`model-calibrate: ${line}`); }
      },
      onSession: () => {},
    });
    try { chmodSync(join(receiptDir, 'last.json'), 0o600); } catch { /* infra result below owns the diagnosis */ }
    if (!result.ran) {
      recordCalibrationJudgeFailure(queue, artifact.id, judge.id, result.error || 'judge failed', { sourceRunId });
      persistCalibrationQueue(queue, campaign, configHash, paths);
      fatalError = `${judge.id} failed on artifact ${artifact.ordinal}: ${result.error || 'unknown infra failure'}; stopped before buying another call`;
      break;
    }
    recordCalibrationJudgeRun(queue, campaign, artifact.id, judge.id, result, { sourceRunId });
    persistCalibrationQueue(queue, campaign, configHash, paths);
    console.error(`model-calibrate: recorded ${result.verdict}/${result.findings?.length ? 'findings' : 'clean'} · actual ${result.reviewerIdentity}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (fatalError) die(fatalError);
printStatus(queue, args.json, paths);
