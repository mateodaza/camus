// Host-owned context projection, never a model summary or completion authority.
// Keep distinct current sources across rollover instead of only the last action.
const DISCOVERY_WARNING_STEPS = 3;
export const DISCOVERY_STALL_STEPS = 6;
const MUTATION_WARNING_STEPS = 4;
export const MUTATION_STALL_STEPS = 7;
export const MAKER_PROGRESS_POLICY = 'bounded_discovery_v1';

export function discoveryProgress(history) {
  const seen = new Set();
  let noNewSteps = 0;
  let noMutationSteps = 0;
  let duplicateReads = 0;
  for (const step of history) {
    if (!step.actions?.length) continue;
    let novel = false, discoveryOnly = true;
    for (const action of step.actions) {
      if (!['read', 'list'].includes(action.type)) { discoveryOnly = false; continue; }
      const key = action.type === 'read' ? `read:${action.path}:${action.sha256}`
        : JSON.stringify(['list', action.files, action.total]);
      if (!seen.has(key)) novel = true;
      else if (action.type === 'read') duplicateReads++;
      seen.add(key);
    }
    noNewSteps = discoveryOnly && !novel ? noNewSteps + 1 : 0;
    noMutationSteps = discoveryOnly ? noMutationSteps + 1 : 0;
  }
  return { noNewSteps, noMutationSteps, duplicateReads };
}

export function codeMakerContext(record, { protocolPrompt, sha256 }) {
  const progress = discoveryProgress(record.history);
  let warning = null;
  if (record.makerProgressPolicy === MAKER_PROGRESS_POLICY) {
    const warnings = [];
    if (progress.noNewSteps >= DISCOVERY_WARNING_STEPS) warnings.push(`${progress.noNewSteps} discovery steps without new evidence; do not repeat completed discovery`);
    if (progress.noMutationSteps >= MUTATION_WARNING_STEPS) warnings.push(`${progress.noMutationSteps} consecutive discovery-only steps without a mutation; use retained sources to implement now, identify one specifically missing fact, or stop`);
    warning = warnings.length ? { hostObservation: `${warnings.join('. ')}.` } : null;
  } else if (progress.noNewSteps >= DISCOVERY_WARNING_STEPS) {
    // Checkpoint-v2 runs created before the progress policy was introduced must
    // render byte-for-byte compatible prompts so a paid saved response remains usable.
    warning = {
      hostObservation: `${progress.noNewSteps} discovery steps without new evidence. Use the retained sources to implement, request specifically missing evidence, or stop with a reason. Do not repeat completed discovery.`,
    };
  }
  const render = (history) => protocolPrompt({ task: record.task, history, limits: record.limits,
    feedback: record.feedback, questionAnswer: record.answer });
  const history = warning ? [...record.history, warning] : record.history;
  const full = render(history);
  const fits = (prompt) => Buffer.byteLength(prompt) <= record.limits.maxContextBytes;
  if (fits(full)) return { prompt: full, context: { compacted: false, bytes: Buffer.byteLength(full), ...progress } };

  const last = record.history.at(-1);
  const required = new Set((last?.actions ?? []).filter(a => a.type === 'read').map(a => a.path));
  const recency = new Map();
  const lists = [];
  for (const [index, step] of record.history.entries()) for (const action of step.actions ?? []) {
    if (action.path) recency.set(action.path, index);
    if (action.type === 'list') lists.push(action);
  }
  const sources = record.reads.map(([path, content]) => ({ type: 'read', path, sha256: sha256(content), content }))
    .sort((a, b) => (recency.get(b.path) ?? -1) - (recency.get(a.path) ?? -1));
  const selected = sources.filter(source => required.has(source.path));
  const capsule = {
    capsule: true, currentCandidate: record.candidate.fingerprint,
    files: sources.map(({ path, sha256 }) => ({ path, sha256 })), created: record.created,
    listing: { performed: lists.length > 0, total: lists.at(-1)?.total ?? null, nextOffset: lists.at(-1)?.nextOffset ?? null },
    makerIntent: { untrusted: true, text: record.actionSummary ?? null },
    note: 'Current source bodies follow once each. Listing has already occurred when marked performed; do not restart discovery. Omitted bodies are named, not covered. Re-read only missing evidence. Intent is advisory; the original contract and findings remain binding.',
  };
  const recent = record.history.slice(-2).map(step => ({ ...step, actions: step.actions?.map(action => {
    const { content, files, ...rest } = action;
    return files ? { ...rest, listedCount: files.length } : rest;
  }) }));
  const compact = () => render([{
    ...capsule, omittedSourceBodies: sources.filter(source => !selected.includes(source)).map(source => source.path),
  }, { currentSources: selected }, ...recent, ...(warning ? [warning] : [])]);
  let prompt = compact();
  if (!fits(prompt)) throw new Error('Complete required maker context exceeds limit; host did not truncate it');
  // Most-recently used optional sources fill the remaining space. Never clip a
  // source body, contract, open finding, or the latest explicitly requested read.
  for (const source of sources) {
    if (required.has(source.path)) continue;
    selected.push(source);
    const candidate = compact();
    if (fits(candidate)) prompt = candidate;
    else selected.pop();
  }
  return { prompt, context: { compacted: true, bytes: Buffer.byteLength(prompt),
    sourceFilesIncluded: selected.length, sourceFilesOmitted: sources.length - selected.length, ...progress } };
}
