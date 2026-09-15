# Camus 0.4.31 — limits park work; they do not erase continuity

This maintenance release fixes SWE slice closure and budget-stop recovery in the
shared CLI/Studio runtime. Flexible Build remains advisory and public alpha.

## Changes

- Host-observed action/time exhaustion joins isolated tool failure in the
  discard-and-continue lifecycle. Proven cleanup, pinned identity, valid custody
  and a matching snapshot remain required. Failed mirrors are never imported,
  replayed, or treated as successful. Completed runs are not reopened.
- Recovery-budget exhaustion parks the task with a typed extension request.
  Repeated resume cannot reset usage or dispatch without enough authority.
- New SWE runs seal a distinct `verified_baseline` before their first dispatch.
  A first-slice limit can recover without pretending a maker turn was accepted.
  Preflight refusals preserve that distinction. Old evidence is not upgraded.
- At 75% of the action/time allowance, new ACP file operations/permissions and
  MCP host work receive a pre-effect wrap-up refusal with the current budget and
  instructions to return the final JSON. Already-granted native writes can finish
  delegated I/O inside the unchanged hard limit. Source file contents and ACP
  success-response shapes are unchanged.
- A budget-denied native tool can continue only after durable no-effect proof,
  including unchanged checked state since that tool began. If the model ignores
  closure guidance, the hard limit still applies; safe parking does not depend
  on a perfect model exit.
- Host count exhaustion is a budget stop, not an authority breach. Operator
  cancellation remains distinct from call/active deadline exhaustion.
- The legacy reviewer fingerprint test uses the working Git on PATH instead of
  requiring Apple's system Git and its separate Xcode license acceptance.

No budget is silently extended. There is no model, billing, admission, routing,
automatic acceptance or publication change. Frozen verification and independent
review are still required.

## Evidence and limits

Offline regressions cover native-only ACP closure, MCP closure, finishing granted
writes, denying new writes before effect, historical limit stops, repeated budget
parking, explicit extension, baseline recovery, cancellation, and independent
review. Fifteen actual SWE SIGKILL/restart windows cover failed response
publication, restoration and recovery reservation for tool/action/time stops.
Full root/CLI and Studio suites plus packaged CLI parity are release gates.

No live SWE evaluation or Company Brain completion is claimed. The earlier
truncation's upstream cause remains unproven. Unknown internal SWE inference and
token spend still requires explicit consent. The reviewed Devin artifact remains
`3000.10.21 (611c1cba)`; no artifact or API fallback is introduced.

## Upgrade and Company Brain

```bash
npm install -g camus-cli@0.4.31
export CAMUS_DEVIN_BIN="$HOME/.local/share/devin/cli/_versions/3000.10.21/bin/devin"
camus --version
camus build --inspect code-1789435781661-50eb06c8 --json
```

Restart idle Studio processes to use the new runtime; never interrupt another
active worker. The last read-only observation was revision 401, unowned, with
eight calls and four recoveries consumed. The recorded candidate fingerprint
starts `935ddd49`; its refused maker-8 mirror must remain excluded.

The saved ceilings are ten cumulative calls and four recoveries. Updating Camus
grants no additional budget. Without a separate extension, this command parks
before a new model dispatch:

```bash
camus build --resume code-1789435781661-50eb06c8 --max-calls 10 --json
```

Request an explicit bounded continuation allowance, then apply only those
approved cumulative limits. Keep the task, contract, verifier and model pair.
Never import refused mirrors, edit checkpoints, use `--retry-uncertain`, or
commit/merge/push/publish the candidate without separate authority.

See [setup](SWE-SETUP.md) and
[contract evidence](SWE-CONTRACT-VALIDATION.md#slice-closure-and-resumable-budget-stops-0431).
