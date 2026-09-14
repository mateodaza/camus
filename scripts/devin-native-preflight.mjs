import { runDevinNativePreflight } from '../apps/loop-studio/lib/devin-native-preflight.mjs';

if (process.argv.length !== 2) throw new Error('This preflight accepts no prompt or run arguments.');
const control = new AbortController();
const stop = () => control.abort(new Error('Operator stopped preflight.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  console.log(JSON.stringify(await runDevinNativePreflight({ signal: control.signal }), null, 2));
} catch (error) {
  // Our errors are deliberately opaque; never print child diagnostics or login.
  console.error(JSON.stringify({ ready: false, modelPromptSent: false, error: error.message }));
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
