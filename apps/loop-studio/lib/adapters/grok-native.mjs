import { runNativeGrok as runApiBackedGrok } from './native-harness.mjs';
import { runNativeGrokSubscription } from './grok-subscription.mjs';

// The backend identity, not the shared executor label, selects billing. The
// built-in Grok seat preserves Grok Build OAuth/subscription inference. A
// qualified openai_compat seat keeps the older explicit API-credit gateway.
export const runNativeGrok = options => options.backend?.kind === 'grok_cli'
  ? runNativeGrokSubscription(options)
  : runApiBackedGrok(options);
