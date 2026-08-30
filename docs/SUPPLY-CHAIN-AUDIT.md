# npm supply-chain audit

## Scope

This audit records the public Socket findings for `camus-cli@0.4.11`, reviewed on
2026-08-30 against the repository and the exact npm payload. Socket reported Supply Chain
Security 83, Vulnerability 100, Quality 100, Maintenance 96, License 100, zero dependencies,
two AI anomaly instances, and one URL-strings alert.

## AI anomaly: `bin/camus.js`

Socket correctly identified a high-impact dispatcher: Camus intentionally launches Bash, Python,
and Node entrypoints. It also identified that the npm CLI preferred separately installed scripts
under `~/.claude` when present. That mutable precedence was unnecessary.

The CLI now executes only scripts carried by its exact npm package. The installed `~/.claude` copy
remains the explicit execution surface for Claude workflows, protected by `camus check`; it cannot
silently override an npm CLI command. The packed-runtime test plants a hostile ambient `status.py`
and proves it is never executed.

The remaining subprocess behavior is intended product functionality. Each entrypoint owns its
argument validation and Camus continues to bound custody, process ownership, environment exposure,
timeouts, and terminal evidence rather than concealing the execution surface.

## AI anomaly: `code-seat-verify.mjs`

Socket correctly identified the verifier as an execution sink. The command is an operator-supplied,
frozen acceptance command—not model-selected input. It runs in the isolated candidate worktree with
a credential-free environment allowlist, private home, bounded time and output, and registered
process-group cleanup. The receipt states explicitly that this is not an operating-system sandbox.

Socket also identified that the temporary verifier home was not removed. It is now deleted in a
`finally` boundary after successful, failed, aborted, or timed-out verification. Tests pin cleanup on
both success and timeout.

## URL strings

The reported set contains intentional official provider endpoints, loopback prefixes, documentation
links, the opt-in Hivemind endpoint, filenames, and non-URL schema fields such as `campaign.case`.
These strings are part of Camus's explicit connection catalog and operator guidance. They contain no
credentials and do not grant network authority: connection selection, qualification, exact-route
binding, provider consent, and publication opt-in remain separate controls.

Do not remove or obfuscate these strings for a score. Review each future finding against the exact
tarball. Resolve only a version-scoped false positive or tolerable-risk finding with a comment naming
the file, intended behavior, containment boundary, and test evidence.

## Publication hardening

The tag-triggered release workflow now separates unprivileged verification from the npm publication
job, pins GitHub actions, Node, and pnpm, requires the tag/package/main commit to agree, publishes
through npm trusted-publisher OIDC with provenance, and treats matching npm/GitHub artifacts as
idempotently complete. No long-lived npm token belongs in GitHub.
