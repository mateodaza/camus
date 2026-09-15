// ACP delegation and native permissions share the checked workspace. Native
// permission grants bind expected bytes; they are not completion receipts.
import { assessDevinFilePermission, mergeDevinPermissionTool, selectDevinOneTimePermission } from './devin-native-permission.mjs';
import { DevinToolFeedback } from './devin-native-workspace.mjs';

export const DEVIN_CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: true, writeTextFile: true }), terminal: false });

const validate = (params, keys) => {
  if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => ![...keys, '_meta'].includes(key))) throw new Error('Invalid ACP file parameters.');
};

export function createDevinFileHandlers({ workspace, cwd, sessionId, calls, permissions, onWriteApproved = async () => {} }) {
  const checkSession = params => { if (params?.sessionId !== sessionId()) throw new Error('ACP filesystem session mismatch.'); };
  return {
    async 'fs/read_text_file'(params) {
      checkSession(params);
      validate(params, ['sessionId', 'path', 'line', 'limit']);
      for (const key of ['line', 'limit']) if (params[key] !== undefined
          && (!Number.isSafeInteger(params[key]) || params[key] < 1 || params[key] > 1048576))
        throw new Error('Invalid ACP read range.');
      const path = workspace.hostPath(params.path);
      const { content } = await workspace.readText(path);
      if (params.line === undefined && params.limit === undefined) return { content };
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const start = (params.line ?? 1) - 1;
      return { content: lines.slice(start, params.limit === undefined ? undefined : start + params.limit).join('') };
    },
    async 'fs/write_text_file'(params) {
      checkSession(params);
      validate(params, ['sessionId', 'path', 'content']);
      await workspace.writeDelegated({ path: workspace.hostPath(params.path), content: params.content });
      return {};
    },
    async 'session/request_permission'(params) {
      checkSession(params);
      validate(params, ['sessionId', 'toolCall', 'options']);
      if (workspace.nativeWriteEvidence().writes.some(item => !item.noEffectVerified && calls.has(item.toolCallId)
          && calls.get(item.toolCallId).status !== 'completed')) throw new DevinToolFeedback('native_write_pending');
      const tool = mergeDevinPermissionTool(calls.get(params.toolCall?.toolCallId), params.toolCall);
      const path = workspace.hostPath(tool?.rawInput?.file_path);
      const delegatedState = await workspace.writeState(path);
      const assessment = await assessDevinFilePermission({ cwd, target: delegatedState.target, tool,
        maxInputBytes: 65536, delegatedState });
      const result = selectDevinOneTimePermission({ expectedSessionId: sessionId(), params, assessment, seen: permissions });
      if (result.outcome.outcome !== 'selected') throw new Error('Native edit permission refused.');
      const receipt = await workspace.authorizeNativeWrite(tool, delegatedState);
      if (receipt) await onWriteApproved(receipt);
      // Permission itself creates no file. In native mode its expected output
      // is durably recorded before acknowledgement; adoption verifies the bytes.
      workspace.rememberWriteBase(path, delegatedState.sha256);
      return result;
    },
  };
}
