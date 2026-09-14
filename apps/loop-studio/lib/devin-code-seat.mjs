// Coding-only experimental capability. This is NOT words-seat qualification,
// reviewer admission, measured billing, or a default model recommendation.
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEVIN_NATIVE_MODEL, DEVIN_NATIVE_EXECUTOR, DEVIN_NATIVE_VERSION } from './devin-native-protocol.mjs';

export const DEVIN_OBSERVED_CONSENT = 'devin-observed/v1';
export const DEVIN_CODE_BACKEND = Object.freeze({ name: 'devin', kind: 'devin_cli', provider: 'cognition',
  transport: 'vendor_managed', seats: Object.freeze(['maker']), codeOnly: true });
export const DEVIN_CODE_ENTRY = Object.freeze({ backend: 'devin', model: DEVIN_NATIVE_MODEL, provider: 'cognition',
  executor: 'devin_cli', transport: 'vendor_managed', protocol: 'acp', trainingOrg: 'unknown', modelFamily: 'unknown',
  inferenceOperator: 'cognition', originConfidence: 'operator_declared', billingAuthority: 'devin_account', effort: false });

export function validateDevinCodeSeat(seat, backend, role) {
  if (role !== 'maker' || seat?.backend !== 'devin' || seat.model !== DEVIN_NATIVE_MODEL
      || seat.codeExecutor !== DEVIN_NATIVE_EXECUTOR || seat.observedBudgetConsent !== DEVIN_OBSERVED_CONSENT
      || seat.effort != null || backend?.name !== 'devin' || backend.kind !== 'devin_cli'
      || backend.transport !== 'vendor_managed' || backend.codeOnly !== true) {
    throw new Error('SWE requires devin:swe-2-high with devin_native, maker-only, and explicit devin-observed/v1 budget consent. Internal inference/token spend is unknown; no fallback was made.');
  }
}

export const devinBudgetSemantics = () => ({ version: DEVIN_OBSERVED_CONSENT,
  calls: 'Camus dispatches; not internal Devin inferences', tokens: 'planning reservations; not a hard inference or billing cap',
  internalModelCalls: null, totalInferenceTokens: null, enforced: ['time', 'observed_tools', 'host_tool_allowance'],
  billingUncertaintyAccepted: true });

// Cheap display hint only. The adapter validates the pinned bytes, login,
// effective model/mode and sandbox again before every prompt. Never qualify
// a seat merely because its executable and login file exist.
export async function devinCodeReadiness(runtime = {}) {
  const base = { executor: DEVIN_NATIVE_EXECUTOR, label: 'Devin / SWE', version: DEVIN_NATIVE_VERSION };
  if ((runtime.platform ?? process.platform) !== 'darwin' || (runtime.arch ?? process.arch) !== 'arm64')
    return { ...base, ready: false, status: 'unsupported_platform', detail: 'Currently macOS arm64 only.', remedy: 'Use another maker on this worker.' };
  try {
    await access(process.env.CAMUS_DEVIN_BIN ?? join(homedir(), '.local/bin/devin'), constants.X_OK);
    await access(join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'devin/credentials.toml'), constants.R_OK);
    return { ...base, ready: true, status: 'installed_unverified', detail: 'Local executable and login found. Pinned artifact and authentication are checked before launch; no model was called.' };
  } catch {
    return { ...base, ready: false, status: 'setup_required', detail: 'Devin executable or saved login is missing.', remedy: `Install the supported Devin ${DEVIN_NATIVE_VERSION} CLI and sign in with devin.` };
  }
}
