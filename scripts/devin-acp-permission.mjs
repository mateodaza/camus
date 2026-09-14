// Development smoke-test guard, NOT a production Devin adapter or admission.
// ACP locations are optional. Authority comes from checked native arguments;
// any supplied locations/diffs must agree. Never infer permission from a title.
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = reason => ({ allowed: false, reason });

// ACP ToolCall/ToolCallUpdate status is optional. Missing/null update fields
// retain the prior value; an initially omitted status is pending, not a refusal.
// Still require the already-observed tool ID, and never reopen a terminal tool.
export function mergeDevinPermissionTool(prior, update) {
  if (!object(prior) || !object(update) || typeof prior.toolCallId !== 'string' || !prior.toolCallId
      || prior.toolCallId !== update.toolCallId) return null;
  const active = status => ['pending', 'in_progress'].includes(status);
  const before = prior.status ?? 'pending', after = update.status ?? before;
  if (!active(before) || !active(after)) return null;
  return { ...prior, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)), status: after };
}

export async function assessDevinFilePermission({ cwd, target, tool, maxInputBytes = 16384 }) {
  try {
    if (!isAbsolute(cwd) || !isAbsolute(target) || resolve(cwd) !== cwd || resolve(target) !== target
      || !target.startsWith(cwd + sep) || await realpath(cwd) !== cwd
      || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 65536)
      return refuse('Invalid fixed workspace policy');
    if (!object(tool) || tool.kind !== 'edit' || typeof tool.toolCallId !== 'string' || !tool.toolCallId)
      return refuse('Not an identified native file operation');
    const name = tool._meta?.['cognition.ai/inferenceToolName'], input = tool.rawInput;
    if (!['edit', 'write'].includes(name) || !object(input)) return refuse('Missing native input evidence');
    if (Buffer.byteLength(JSON.stringify(input)) > maxInputBytes) return refuse('Input envelope exceeded');
    const keys = name === 'write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all'];
    if (Object.keys(input).some(key => !keys.includes(key))) return refuse('Unexpected native arguments');
    if (typeof input.file_path !== 'string' || !isAbsolute(input.file_path) || resolve(input.file_path) !== target)
      return refuse('Outside the fixed writable file');
    if (name === 'write' ? typeof input.content !== 'string'
      : typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string'
        || input.replace_all !== undefined && typeof input.replace_all !== 'boolean')
      return refuse('Invalid native write/edit arguments');
    const samePath = path => typeof path === 'string' && resolve(cwd, path) === target;
    if (tool.locations !== undefined && (!Array.isArray(tool.locations) || tool.locations.some(item => !samePath(item?.path))))
      return refuse('Conflicting file locations');
    if (tool.content !== undefined && (!Array.isArray(tool.content)
      || tool.content.some(item => !object(item) || item.type === 'diff' && !samePath(item.path))))
      return refuse('Conflicting diff locations');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target) !== target)
      return refuse('Target is not the fixed unlinked regular file');
    return { allowed: true, reason: 'One-time native edit to the exact approved file' };
  } catch {
    return refuse('File permission check failed closed');
  }
}

export function selectDevinOneTimePermission({ expectedSessionId, params, assessment, seen }) {
  const id = params?.toolCall?.toolCallId;
  const valid = typeof expectedSessionId === 'string' && expectedSessionId.length > 0
    && params?.sessionId === expectedSessionId && typeof id === 'string' && id.length > 0
    && seen instanceof Set && !seen.has(id);
  if (valid) seen.add(id);
  const option = valid && assessment?.allowed === true && Array.isArray(params.options)
    ? params.options.find(item => item?.kind === 'allow_once' && typeof item.optionId === 'string' && item.optionId.length > 0)
    : null;
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
