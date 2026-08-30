# Camus 0.4.14 — provenance-bound npm releases

Camus 0.4.14 hardens the public package boundary. It changes no model admission,
routing, or product claim.

The `v0.4.13` tag failed closed during pre-publication CI because a test fixture inherited a
developer Git identity that a clean runner did not have. No npm package or GitHub Release was
created for that tag. The fixture now owns a repository-local test identity; the tag remains
unchanged as honest evidence of the failed attempt.

## What changed

- A pushed release tag is now the only publication trigger. The workflow refuses
  unless the tag, CLI package version, tagged commit, and `origin/main` agree.
- Verification runs without an npm identity token. Only the separate publication
  job receives GitHub's short-lived OIDC permission; no long-lived npm token is
  stored in GitHub.
- npm publication emits SLSA provenance and the workflow refuses to create the
  GitHub Release until npm reports both the exact `gitHead` and its provenance
  attestation.
- GitHub actions, Node, and pnpm are pinned. Matching npm and GitHub artifacts are
  idempotently accepted on a workflow retry; mismatched existing artifacts fail.
- npm CLI subcommands execute scripts from the exact installed package. A mutable
  `~/.claude` gate copy can no longer override the package dispatcher.
- The verifier removes its private temporary home after success, failure, abort,
  or timeout while retaining its existing credential scrub, resource bounds, and
  owned-process cleanup.
- Socket's two AI-anomaly findings and URL-string alert are recorded in
  `docs/SUPPLY-CHAIN-AUDIT.md`. Intended provider, loopback, process, and
  documentation surfaces remain explicit rather than obfuscated for a score.

## Verification

- Full root/CLI suite, including 672 workflow assertions.
- Full Loop Studio suite and the trust-package suite.
- Packed npm runtime isolation with a hostile ambient `~/.claude/status.py` that
  proves the package does not execute it.
- Verifier-private-home cleanup on both successful and timed-out execution.
- Release YAML and every embedded shell block parse; `git diff --check` clean.
- No provider calls were made.

## Upgrade

```sh
npm install -g camus-cli@0.4.14
camus install
camus check
```
