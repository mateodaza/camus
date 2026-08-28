import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rewriteStudioAssets, isStudioPublicAsset } from './studio-assets.mjs';

const html = readFileSync(new URL('../../loop-studio/public/index.html', import.meta.url), 'utf8');
const deployed = rewriteStudioAssets(html);
for (const asset of ['fonts.css', 'style.css', 'app.js', 'calibration.mjs']) {
  assert(deployed.includes(`"/studio/${asset}"`), `hosted entry points include ${asset}`);
  for (const base of ['https://example.invalid/studio', 'https://example.invalid/studio/']) {
    assert.equal(new URL(`/studio/${asset}`, base).pathname, `/studio/${asset}`);
  }
}
assert.doesNotMatch(deployed, /\b(?:href|src)="\.\//);
assert.equal(rewriteStudioAssets(deployed), deployed, 'rewriting is idempotent');
assert.equal(isStudioPublicAsset('public/calibration.mjs'), true);
assert.equal(isStudioPublicAsset('public/calibration.test.mjs'), false);
console.log('Studio hosted assets: both URL shapes load all entries; tests stay private.');
