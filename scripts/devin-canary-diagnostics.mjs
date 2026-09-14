// Fixed-vocabulary diagnostics. Never retain arguments, paths, or error text.
import { resolve, sep } from 'node:path';
const methods = new Set(['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output',
  'terminal/wait_for_exit', 'terminal/release', 'terminal/kill', 'session/request_permission']);
const stages = new Set(['received', 'session', 'permission', 'permission_state', 'permission_scope', 'permission_option',
  'action_budget', 'file_shape', 'file_path',
  'file_stat', 'file_read', 'file_write_policy', 'file_write', 'mirror_write', 'terminal_policy',
  'terminal_start', 'terminal_operation', 'unsupported']);
const codes = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ELOOP', 'ENOSPC']);
const within = (parent, path) => path === parent || path.startsWith(parent + sep);

export function classifyCanaryPath(path, { mirror, candidate }) {
  if (typeof path !== 'string') return 'missing_or_nonstring';
  if (path.includes('\0')) return 'invalid';
  const actual = resolve(mirror, path);
  for (const [name, root] of [['mirror', mirror], ['candidate', candidate]]) {
    if (['calc.mjs', 'acceptance.test.mjs'].some(file => actual === resolve(root, file))) return name + '_fixture';
    if (within(root, actual)) return name + '_other';
  }
  return 'outside';
}

export function createCanaryRequestDiagnostics({ mirror, candidate, maxRequests = 100 }) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100)
    throw new Error('Invalid diagnostic request cap.');
  const records = [];
  return {
    records,
    async run(method, params, handle) {
      if (records.length >= maxRequests) throw new Error('Diagnostic request cap exceeded.');
      const record = { method: methods.has(method) ? method : 'unsupported', stage: 'received', outcome: 'pending',
        ...(method === 'fs/read_text_file' || method === 'fs/write_text_file'
          ? { pathScope: classifyCanaryPath(params?.path, { mirror, candidate }) } : {}) };
      records.push(record);
      const stage = name => {
        if (!stages.has(name)) throw new Error('Unknown diagnostic stage.');
        record.stage = name;
      };
      try {
        const result = await handle(stage);
        record.outcome = 'completed';
        return result;
      } catch (error) {
        record.outcome = 'failed';
        record.errorCode = codes.has(error?.code) ? error.code : 'unclassified';
        throw error;
      }
    },
  };
}
