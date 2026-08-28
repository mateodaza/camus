import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readFile, lstat } from 'node:fs/promises';
import { codeRunStatus } from './code-run-state.mjs';

export const codeRunsRoot = () => resolve(process.env.STUDIO_RUNS_DIR || join(homedir(), '.camus', 'studio', 'runs'));
export function codeRunDirectory(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new Error('Run ID must contain only letters, numbers, underscores and hyphens.');
  return join(codeRunsRoot(), id);
}
export async function readCodeRunMetadata(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Run directory must be a private directory, not a symlink.');
  const path = join(dir, 'run.json');
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024) throw new Error('Invalid run metadata.');
  const meta = JSON.parse(await readFile(path, 'utf8'));
  if (meta.codeMode !== 'independent' || !isAbsolute(meta.targetPath ?? '') || !meta.models?.maker || !meta.models?.reviewer) throw new Error('Not an independent coding run.');
  return meta;
}
export async function codeContinuation(dir) {
  try {
    const state = await codeRunStatus(dir);
    return { mode: 'code_checkpoint', canResume: state.resumable, ...state,
      presentation: { title: state.owned ? 'Worker active' : state.resumable ? 'Continue the same candidate' : 'Inspect the preserved candidate',
        detail: state.owned ? 'Attach to this run; no second worker is started.' : state.reason ?? 'Recovery uses saved responses and file hashes; it does not restart planning.' } };
  } catch (error) {
    return { mode: 'code_checkpoint', canResume: false, legacy: error.code === 'ENOENT',
      presentation: { title: 'Inspection only', detail: error.code === 'ENOENT' ? 'This historical run has no authenticated checkpoint. Start a fresh run to use recovery.' : 'The saved checkpoint could not be authenticated. No recovery is authorized.' } };
  }
}
