#!/usr/bin/env bash
# Cut a release tag from the CLI package version. The tag-triggered workflow verifies the exact
# main commit, publishes to npm through OIDC with provenance, and creates the GitHub Release.
# Usage: pnpm release:tag   (or: bash scripts/release-tag.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

v="v$(node -p "require('./packages/cli/package.json').version")"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree not clean — commit first (a tag must point at a commit that ships)" >&2
  exit 1
fi

git fetch --no-tags origin main
head_sha="$(git rev-parse HEAD)"
main_sha="$(git rev-parse origin/main)"
if [ "$head_sha" != "$main_sha" ]; then
  echo "✗ HEAD ($head_sha) is not origin/main ($main_sha) — push the release commit first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$v" >/dev/null; then
  echo "✗ $v already exists — bump packages/cli version first" >&2
  exit 1
fi

git tag -a "$v" -m "camus-cli $v"
git push origin "$v"
echo "✓ tagged + pushed $v — the release workflow is verifying, publishing with provenance, and creating the GitHub Release"
