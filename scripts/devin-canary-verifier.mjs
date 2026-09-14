// Fixture-only host verifier policy, not a Devin identity/admission policy.
import { dirname, join } from 'node:path';

export function devinCanaryVerifierProfile(policy) {
  const testPath = join(policy.cwd, 'acceptance.test.mjs');
  const deniedRead = `(deny file-read* (subpath ${JSON.stringify(testPath)}))`;
  if (!policy.toolProfile.split('\n').includes(deniedRead)) throw new Error('Missing frozen-test policy.');
  const ancestors = new Set();
  for (const root of [policy.cwd, policy.temp]) {
    for (let path = dirname(root); ; path = dirname(path)) {
      ancestors.add(path);
      if (path === dirname(path)) break;
    }
  }
  // Node's test child resolves each ancestor. Metadata is enough; do not grant
  // directory listing or contents outside the already-authorized fixture.
  return policy.toolProfile.split('\n').filter(line => line !== deniedRead).join('\n')
    + `\n(allow file-read-metadata ${[...ancestors].map(path => `(literal ${JSON.stringify(path)})`).join(' ')})`
    + `\n(deny file-write* (subpath ${JSON.stringify(policy.cwd)}))`;
}
