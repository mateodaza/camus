# Security policy

Camus controls model processes, repository worktrees, provider credentials,
budgets, and evidence about AI-made work. Please report security defects
privately so users have time to update before details become public.

## Supported versions

The latest published `camus-cli` release receives security fixes. Older public
alpha versions are supported on a best-effort basis; upgrade before reporting a
problem that is already fixed in the latest release.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/mateodaza/camus/security/advisories/new).
Include the affected version, smallest safe reproduction, impact, and any known
workaround. Share only the minimum sensitive material needed to investigate.

Do **not** open a public issue for suspected credential exposure, authorization
or containment bypass, path traversal, evidence or receipt forgery, unapproved
network/file/publication actions, or replayed provider spend. Do not paste API
keys, credentials, private source, raw receipts, full environment/process dumps,
or sensitive local paths anywhere in the repository.

If a live credential may have been exposed, revoke or rotate it first. Never send
the credential value as evidence.

The maintainer will coordinate validation, remediation, release, and disclosure
through the private advisory. Non-sensitive reproducible defects can use the
[public bug form](https://github.com/mateodaza/camus/issues/new?template=bug.yml).

## Trust boundary

Camus keeps orchestration, budgets, run state, and receipts in the
operator-controlled local service. Configurable API credentials are held there
and sent only to the selected provider endpoint for authentication; they are never
sent to `camus.sh` or exposed to native workers. Camus is not a providerless
sandbox: a selected model provider receives the context the operator explicitly
sends. Native model harnesses are constrained through Camus-owned gateways where
supported, but configurable provider/model/route seats and native harness
artifacts earn their respective qualification or readiness independently.
