#!/usr/bin/env bash
# Cut a release tag from the CLI package version: tags HEAD as v<packages/cli version> and pushes
# the tag — .github/workflows/release.yml then creates the GitHub Release with generated notes.
# Usage: pnpm release:tag   (or: bash scripts/release-tag.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

v="v$(node -p "require('./packages/cli/package.json').version")"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree not clean — commit first (a tag must point at a commit that ships)" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$v" >/dev/null; then
  echo "✗ $v already exists — bump packages/cli version first" >&2
  exit 1
fi

git tag -a "$v" -m "camus-cli $v"
git push origin "$v"
echo "✓ tagged + pushed $v — the release workflow is generating the GitHub Release"
