# Blinded calibration workspace

The Studio **calibration** entry is a browser front end to the existing private calibration
authority. It does not create a second queue or scoring system.

1. Start Studio locally and open Calibration. The first request is token-protected and reports the
   active generation without reading artifacts. Choose **Prepare workspace** to select the active
   campaign queue from eligible run artifacts, or reopen it to resume.
2. Review each artifact's goal, acceptance contract, and deliverable. The content is inserted as
   text, not HTML. Deterministic character counts are shown separately from semantic judgment.
3. Select Human or Expert AI proxy explicitly. Human labels require a person; proxy labels require
   a proxy owner and human delegator. Select a verdict and finding presence, then press the explicit
   immutable commit button. Draft autosaves are scratch only and do not label anything.
4. Use numbered navigation or Next unlabeled. Draft conflicts and network failures remain visible;
   a failed save never becomes “Saved”. Queue and draft revisions prevent stale tabs from clobbering
   newer work. Timing and ETA are shown only after measured active-label samples exist.
5. Once the server reports that labels are frozen and disagreements are available, comparison is
   read-only. It cannot relabel artifacts or upgrade standing.

For paid judge execution, use the explicit terminal command after the human phase:

```bash
node model-calibrate.mjs --run-judge --judge <gpt-sol|gpt-luna|opus-4-8> --artifact <ordinal> --generation <active-generation>
```

The workspace never runs this command, calls a provider, publishes, grants admission, or alters
routing. Private queues, artifacts, receipts, and the draft sidecar live below the configured local
Studio operator directory (`STUDIO_GRANDFATHER_DIR`, normally `~/.camus/studio`) with restrictive
permissions. The campaign remains uncalibrated until the authoritative judge workflow completes.
