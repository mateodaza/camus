// Compare & Learn experiment identity. The experiment id names the frozen
// manifest, not whether the arm happened to succeed. Outcome changes remain
// first-class data under the same planned experiment instead of manufacturing
// a different experiment after seeing the result.

import { createHash } from 'node:crypto';
import { canonicalString } from './canonical.mjs';

const sha256 = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function pick(obj, { take, ignore = [] }, path) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(`${path}: expected an object`);
  }
  const known = new Set([...take, ...ignore]);
  const extra = Object.keys(obj).filter((key) => !known.has(key));
  if (extra.length) throw new TypeError(`${path}: unknown field(s) ${extra.join(', ')}`);
  return Object.fromEntries(take.filter((key) => key in obj).map((key) => [key, obj[key]]));
}

export function experimentManifestProjection(record) {
  if (record?.schemaVersion === 2) {
    const root = pick(record, {
      take: ['schemaVersion', 'mode', 'created_at', 'goal', 'acceptance_contract', 'knowledge', 'manifest'],
      ignore: ['experiment_id', 'outcome'],
    }, 'experimentManifestProjection(record v2)');
    root.knowledge = pick(root.knowledge, {
      take: ['snapshot_id', 'privacy', 'mode', 'query', 'item_count', 'retriever'],
    }, 'experimentManifestProjection(knowledge)');
    root.knowledge.retriever = pick(root.knowledge.retriever, {
      take: ['requested', 'resolved', 'actual'],
    }, 'experimentManifestProjection(retriever)');
    root.manifest = pick(root.manifest, {
      take: ['task', 'catalog', 'reviewer', 'reviewer_effort', 'round_cap', 'fallback_policy', 'arms'],
    }, 'experimentManifestProjection(manifest v2)');
    root.manifest.task = pick(root.manifest.task, {
      take: ['lane', 'depth'],
    }, 'experimentManifestProjection(task v2)');
    root.manifest.catalog = pick(root.manifest.catalog, {
      take: ['resolved_at', 'maker_source', 'maker_models', 'reviewer_source', 'reviewer_models'],
    }, 'experimentManifestProjection(catalog v2)');
    root.manifest.reviewer = pick(root.manifest.reviewer, {
      take: ['requested', 'resolved'],
    }, 'experimentManifestProjection(reviewer v2)');
    root.manifest.reviewer_effort = pick(root.manifest.reviewer_effort, {
      take: ['requested', 'semantics'],
    }, 'experimentManifestProjection(reviewer effort)');
    root.manifest.arms = root.manifest.arms.map((arm, index) => {
      const projected = pick(arm, {
        take: ['arm_id', 'executor', 'orchestration', 'effort'],
      }, `experimentManifestProjection(arms[${index}])`);
      projected.executor = pick(projected.executor, { take: ['requested', 'resolved'] }, `experimentManifestProjection(arms[${index}].executor)`);
      projected.orchestration = pick(projected.orchestration, { take: ['requested', 'semantics'] }, `experimentManifestProjection(arms[${index}].orchestration)`);
      projected.effort = pick(projected.effort, { take: ['requested', 'semantics'] }, `experimentManifestProjection(arms[${index}].effort)`);
      return projected;
    });
    return { projectionVersion: 2, ...root };
  }
  if (record?.schemaVersion !== 1) throw new TypeError(`experimentManifestProjection: unsupported schemaVersion ${record?.schemaVersion}`);
  const root = pick(record, {
    take: ['schemaVersion', 'mode', 'created_at', 'source', 'manifest'],
    ignore: ['experiment_id', 'outcome'],
  }, 'experimentManifestProjection(record)');
  root.source = pick(root.source, {
    take: ['run_id', 'artifact_id', 'receipt_id'],
  }, 'experimentManifestProjection(source)');
  root.manifest = pick(root.manifest, {
    take: ['arm_id', 'knowledge_snapshot_id', 'knowledge_privacy', 'catalog', 'reviewer', 'effort', 'fallback_policy'],
  }, 'experimentManifestProjection(manifest)');
  root.manifest.catalog = pick(root.manifest.catalog, {
    take: ['resolved_at', 'reviewer_source', 'reviewer_models'],
  }, 'experimentManifestProjection(catalog)');
  root.manifest.reviewer = pick(root.manifest.reviewer, {
    take: ['requested', 'resolved'],
  }, 'experimentManifestProjection(reviewer)');
  root.manifest.effort = pick(root.manifest.effort, {
    take: ['requested', 'semantics'],
  }, 'experimentManifestProjection(effort)');
  return { projectionVersion: 1, ...root };
}

export function computeExperimentId(record) {
  return sha256(canonicalString(experimentManifestProjection(record)));
}

export function sealExperiment(record) {
  return { ...record, experiment_id: computeExperimentId(record) };
}

export function experimentMatches(record, id = record?.experiment_id) {
  return computeExperimentId(record) === id;
}
