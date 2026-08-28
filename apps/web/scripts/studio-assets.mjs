// /studio and /studio/ must load the same entry points. Keep new scripts in the
// rule automatically so adding a feature cannot silently break its hosted UI.
export function rewriteStudioAssets(html) {
  return html.replace(/\b(href|src)="\.\/([^"\n]+)"/g, '$1="/studio/$2"');
}

export function isStudioPublicAsset(path) {
  return !/\.test\.(?:mjs|js)$/.test(path);
}
