// Sync the studio UI into the landing's static export. The studio source
// keeps relative asset paths (it also serves standalone at /), so this step
// rewrites the deployed copy to absolute /studio/ paths — hosts disagree
// about trailing slashes (Vercel canonicalizes /studio/ -> /studio), and
// absolute paths are correct under both directions.
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';

rmSync('public/studio', { recursive: true, force: true });
cpSync('../loop-studio/public', 'public/studio', { recursive: true });

const page = 'public/studio/index.html';
const html = readFileSync(page, 'utf8')
  .replace('href="./style.css"', 'href="/studio/style.css"')
  .replace('src="./app.js"', 'src="/studio/app.js"');
if (!html.includes('/studio/style.css')) throw new Error('sync-studio: asset rewrite did not match — check index.html');
writeFileSync(page, html);
console.log('sync-studio: copied and rewrote asset paths to /studio/');
