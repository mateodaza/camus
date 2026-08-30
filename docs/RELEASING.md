# Releasing Camus

The release tag is the single publication trigger. A release is accepted only when the tag,
`packages/cli/package.json`, and `origin/main` identify the same commit.

## One-time npm configuration

Configure the `camus-cli` package's npm **Trusted Publisher** with:

- provider: GitHub Actions
- organization or user: `mateodaza`
- repository: `camus`
- workflow filename: `release.yml`
- environment: none
- allowed action: `npm publish`

Do not add an npm token to GitHub. The release workflow requests a short-lived, workflow-bound
OIDC credential and npm automatically creates the public provenance attestation.

After the first successful OIDC publication, change npm **Publishing access** to **Require two-factor
authentication and disallow bypass 2FA tokens**, then revoke any obsolete automation token. Keep an
interactive owner account for recovery.

## Normal release

1. Bump `packages/cli/package.json` and commit the complete release on `main`.
2. Run the relevant verification locally and push the commit to `origin/main`.
3. Run `pnpm release:tag` from any clean worktree whose `HEAD` equals `origin/main`.
4. Watch the `release` GitHub Actions workflow. It independently verifies the tag binding, runs the
   root/CLI, Studio, and trust-package suites, inspects the npm payload, publishes, and creates the
   GitHub Release.

The workflow is retry-safe. If npm already contains the version, it proceeds only when npm's
`gitHead` exactly matches the tagged commit and the SLSA provenance attestation exists. An existing
GitHub Release is also treated as complete.

## Verify the result

```sh
npm view camus-cli@<version> version gitHead dist.attestations --json
npm exec --yes --package=camus-cli@<version> -- camus --version
gh release view v<version>
```

## Socket findings

Camus legitimately contains subprocess, filesystem, provider-endpoint, and loopback-network code.
Review every Socket instance against the published tarball. Remove accidental behavior, but do not
obfuscate intended behavior to improve a badge. Resolve a false positive only with a narrow scope and
a comment naming the reviewed version, file, behavior, containment, and test evidence.
