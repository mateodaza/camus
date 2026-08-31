# Releasing camus-cli

The release pipeline is: a version bump in git → one command to tag → GitHub Actions verifies the
exact release, publishes it to npm with trusted-publisher OIDC and provenance, then writes the
GitHub Release. The Releases page is the changelog; there is no CHANGELOG.md to maintain.

## The flow

```sh
# 1. Bump the version and finish the work
#    packages/cli/package.json → "version": "X.Y.Z"
pnpm test          # all suites green
pnpm cli:pack      # sanity-check the tarball (files included, size)

# 2. Commit (conventional title; see Commit style below)
git commit -am "release: X.Y.Z — <headline items>"
git push

# 3. Tag — this is the whole release trigger
pnpm release:tag   # tags HEAD as v<packages/cli version>, pushes the tag
                   # refuses a dirty tree or a duplicate tag

# 4. GitHub Actions (.github/workflows/release.yml) fires on the tag push. It verifies the
#    exact main/tag/version binding and full repository, publishes once through npm OIDC,
#    verifies SLSA provenance, then creates the GitHub Release from conventional commits.

# 5. Web deploy is separate: pnpm web:build → deploy apps/web/out
```

## Commit style (it writes your changelog)

Release notes are generated from commit subjects between tags, so **commit incrementally with
conventional prefixes** (`feat:`, `fix:`, `web:`, `docs:`, `release:`, …). Many small commits
between tags → rich, grouped notes for free. One giant release commit → a one-line changelog
(v0.2.4 shipped that way and its notes were curated by hand with `gh release edit`).

## Notes

- Tags `v0.2.1`–`v0.2.3` were backfilled onto their original release commits as history markers;
  automated releases start at `v0.2.4`.
- The workflow needs no secrets beyond the default `GITHUB_TOKEN` (`contents: write`), uses no
  third-party actions, and keeps `run:` blocks free of `${{ }}` interpolation (quoted env vars
  only) — keep it that way when editing.
- The mechanism documents itself: `scripts/release-tag.sh` (the tagger) and
  `.github/workflows/release.yml` (the release writer) both explain their behavior in headers.
