// Sync the studio UI into the landing's static export. The studio source
// keeps relative asset paths (it also serves standalone at /), so this step
// rewrites the deployed copy to absolute /studio/ paths — hosts disagree
// about trailing slashes (Vercel canonicalizes /studio/ -> /studio), and
// absolute paths are correct under both directions.
import { rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { rewriteStudioAssets, isStudioPublicAsset } from './studio-assets.mjs';

rmSync('public/studio', { recursive: true, force: true });
cpSync('../loop-studio/public', 'public/studio', { recursive: true, filter: isStudioPublicAsset });

const page = 'public/studio/index.html';
const html = rewriteStudioAssets(readFileSync(page, 'utf8'));
if (!html.includes('/studio/style.css') || !html.includes('/studio/fonts.css')) {
  throw new Error('sync-studio: asset rewrite did not match — check index.html');
}
writeFileSync(page, html);

// The deployed studio shares the landing's origin, so it uses the landing
// build's OWN font-face blocks (full subsets, current hashes) instead of
// the vendored latin files — exact font lockstep, zero duplication.
let faceCss = null;
try {
  const cssFiles = readdirSync('out/_next/static/css').filter((f) => f.endsWith('.css'));
  for (const f of cssFiles) {
    const css = readFileSync(`out/_next/static/css/${f}`, 'utf8');
    const faces = css.match(/@font-face\{[^}]+\}/g);
    if (faces?.length) { faceCss = faces.join('\n'); break; }
  }
} catch { /* first build: out/ doesn't exist yet; vendored fonts apply */ }
if (faceCss) {
  writeFileSync('public/studio/fonts.css',
    '/* Extracted from the landing build — same faces, same files, same origin. */\n' + faceCss + '\n');
  console.log('sync-studio: deployed fonts.css uses the landing build faces');
} else {
  console.log('sync-studio: landing CSS not built yet — vendored latin fonts remain');
}
console.log('sync-studio: copied and rewrote asset paths to /studio/');
