# Camus 0.4.8 — independent coding seats and blinded calibration

Both maker **and reviewer** are independently selectable in `camus build` and
Studio **Build → Any-model candidate**. They share one catalog, connection layer,
adapter registry and host-mediated coding engine. Claude, Codex (including Luna),
and configured Grok/Qwen/other compatible models may occupy either role when
available and qualified for that role. Same-model/origin pairings are allowed but
never presented as independent review.

## What changed

- Any-model Build keeps edits in an isolated worktree. Models exchange bounded
  file-action requests with the host; they do not get shell or ambient file tools.
  Private paths, ignored model-created files, stale edits, symlink containment,
  oversized context and inconclusive verification fail closed.
- The CLI npm package carries the same runtime used by Studio. It needs no running
  Studio server or source checkout to execute a configured pair. `camus models`
  now lists both role catalogs; `--reviewers-only` preserves the native shadow list.
- Studio's blinded calibration workspace provides private autosaved drafts,
  explicit immutable label commits, human/proxy ownership, navigation, measured
  timing and read-only disagreements. Concurrent browser/CLI writes share a
  Node-only local-host lock and queue/draft revision checks. No UI action runs
  a judge, grants admission, publishes, or changes routing.
- Native recovery checks checkout custody before advisory calls, deduplicates
  Claude usage without rewriting old receipts, preserves the original repair
  contract, supports an explicitly recorded one-round advisory skip, and marks
  operator-assisted work separately from autonomous evaluation success.
- Hosted Studio includes the calibration module at both `/studio` URL shapes;
  its old fixed-role labels now distinguish Any-model Build from the legacy gate.

## Deliberate boundaries

Any-model coding is **experimental advisory work**, not an admitted gate. Even
passing tests and a clean reviewer result end at a human checkpoint. Nothing is
automatically committed, merged, pushed or published. Omitting `--verify` means
untested; that command runs locally with credential environment values removed,
not in an OS sandbox. Automatic verification currently requires POSIX. There is
no automatic fix/review retry campaign or resume in this new path.

`camus run`, the legacy slash workflows, and Studio **Legacy proof gate** retain
Claude maker/Codex reviewer behavior. The admission registry is still empty; no
new external production reviewer, automatic route, or optimal model pairing is
claimed. Role/transport qualification is not code-gate admission.

The calibration feature was finished with operator/helper-assisted repairs. The
interrupted native dogfood remains recorded as such, not relabeled an autonomous
success. Synthetic proxy test labels are not human calibration.

## Verification

The combined Studio and root/CLI suites pass, including 672 workflow and 37
planning assertions. Focused tests cover reversed/HTTP/same-model choices,
candidate isolation, cancellation, identity and receipt boundaries, real HTTP
launch/report handling, calibration concurrency/crash behavior and frontend
save races. An extracted npm package runs its help and both-role catalog without
a source checkout. Synthetic browser checks cover draft recovery, immutable
proxy commits, safe text rendering and reversed Build selection.

No live-provider coding-combination campaign has been run for this new path.
Those combinations still need bounded real-task testing; passing hermetic tests
does not establish production coding reliability or a model ranking.

## Upgrade and choose both roles

```sh
npm install -g camus-cli@0.4.8
camus build --help
camus models
# For users of the native proof gate as well:
camus install
camus check
```

Node 18.17+ and Git are required. Authenticate the backends you actually select;
hosted-only pairs do not need Claude/Codex CLIs. Configure/qualify external roles
in Studio first. Example, only if these IDs appear as available:

```sh
camus build --repo /path/to/game \
  --task 'Fix the bounded movement regression in the agreed issue.' \
  --contract 'Movement tests pass; existing jump behavior is unchanged.' \
  --maker codex:gpt-5.6-luna --maker-effort low \
  --reviewer claude:sonnet \
  --verify 'dotnet test'
```

CLI exit `2` is a human checkpoint, not unattended CI success. Inspect the
candidate path, verification and advisory receipt before accepting changes.

Studio remains checkout-based: update a clean `main` with `git pull --ff-only`,
restart `node apps/loop-studio/server.mjs` from the repo root, and reload the UI.
Updating npm alone does not update a separately running Studio checkout.

See [Carlos's quickstart](CARLOS-CAMUS-QUICKSTART.md) and the
[independent coding-seat guide](INDEPENDENT-CODE-SEATS.md).
