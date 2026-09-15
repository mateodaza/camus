# Camus 0.4.28 — retain accepted SWE progress

CLI and Studio share this bounded correction to the optional SWE native maker.

- An omitted `summary` becomes empty descriptive metadata, recorded as
  `missing_summary_defaulted_empty` in the native receipt. Malformed supplied
  summaries and missing/invalid execution or authority fields still refuse.
- Eligible, already-refused SWE schema turns can explicitly resume from the last
  accepted maker-turn candidate. Camus revalidates ownership, the original
  contract/pair/credential binding, source baseline, Git custody, fingerprint and
  ignored output. The refused mirror is neither adopted nor replayed; the old
  call remains in authenticated history and a fresh bounded session continues.
- Existing usage stays charged, and continuation reserves one recovery. Exhausted
  limits park for explicit extension. Verification and independent review remain
  required; no merge, publication, admission or routing authority is added.
- Missing cleanup, uncertain native effects, adoption failures and drift remain
  refused. Other model adapters and saved model/billing defaults are unchanged.

## Evidence

Full root/CLI and Studio suites passed locally, together with packaged-runtime
parity. The broader targeted suite passed 139 tests with one existing skip;
the final native suite passed all 32 tests. Coverage includes two native slices
with omitted summaries through verification/review, schema/authority refusals,
retaining accepted work across resume, drift, ignored files, replay refusal and
budget exhaustion. No new provider-backed evaluation was performed for 0.4.28.

## Upgrade and continue

Install `camus-cli@0.4.28`; restart Studio and long-lived workers. Inspect the
preserved run first. When inspection offers prior-candidate continuation, use
plain `camus build --resume <run-id>` only after authorizing the fresh bounded
dispatch. Do not use `--retry-uncertain` or start over merely to recover progress.
Runs without this evidence remain inspection-only.

Company Brain run `code-1789435781661-50eb06c8` was checked read-only: its last
accepted candidate still matched the recorded fingerprint and isolated Git
identity. It remains paused. Turn 2's refused mirror remains separate, unadopted
evidence; this release does not claim the Company Brain task is complete.

See [SWE setup](SWE-SETUP.md) and [validation evidence](SWE-CONTRACT-VALIDATION.md).
