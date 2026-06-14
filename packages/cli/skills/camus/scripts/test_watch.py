#!/usr/bin/env python3
"""Tests for watch.py's pure parts (frame composition + key dispatch). The termios IO
loop stays untested by design — it is a thin shell over these. Pure stdlib; runs
standalone (`python3 test_watch.py`) or under pytest."""
import json
import os
import tempfile

import watch as W


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _feat(base, feat_id="my-feat-abc123", status="running"):
    _write(os.path.join(base, "feats", "%s.json" % feat_id),
           {"featId": feat_id, "feat": "My feat", "status": status,
            "tasks": [{"taskId": "t-1", "spec": "a", "status": "running", "branch": "b"}],
            "events": [{"seq": 1, "msg": "Baseline green."}]})


def _note(base, feat_id):
    p = os.path.join(base, "steer", "%s.json" % feat_id)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def test_frame_renders_dashboard_plus_footer():
    with tempfile.TemporaryDirectory() as base:
        _feat(base)
        lines = W.frame(base, None)
        text = "\n".join(lines)
        assert "My feat" in text and "Baseline green." in text
        assert W.FOOTER in text
        assert "»" not in text                       # no feedback line when empty


def test_frame_feedback_line_appended():
    with tempfile.TemporaryDirectory() as base:
        _feat(base)
        assert W.frame(base, None, feedback="done")[-1] == "» done"


def test_frame_no_state_and_corrupt_state_messages():
    with tempfile.TemporaryDirectory() as base:
        assert "has a run started?" in "\n".join(W.frame(base, None))
        os.makedirs(os.path.join(base, "feats"))
        with open(os.path.join(base, "feats", "f.json"), "w") as fh:
            fh.write('{"truncated')
        assert "not valid JSON" in "\n".join(W.frame(base, None))


def test_dispatch_pause_writes_note_for_running_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("p", base, None)
        assert "pause note written" in fb
        assert _note(base, "f1")["pause"] is True


def test_dispatch_pause_refused_when_not_running():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        fb = W.dispatch("p", base, None)
        assert fb.startswith("pause refused:")
        assert _note(base, "f1") is None


def test_dispatch_guidance_uses_injected_prompt():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("g", base, None, prompt=lambda _: "  use adapter B  ")
        assert "guidance note written" in fb
        assert _note(base, "f1")["guidance"] == "use adapter B"


def test_dispatch_guidance_empty_writes_nothing():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        fb = W.dispatch("g", base, None, prompt=lambda _: "   ")
        assert "nothing written" in fb
        assert _note(base, "f1") is None


def test_dispatch_clear_removes_note_even_on_finished_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1", status="done")
        _write(os.path.join(base, "steer", "f1.json"), {"pause": True})
        fb = W.dispatch("c", base, "f1")
        assert fb == "cleared steer note"
        assert _note(base, "f1") is None
        assert W.dispatch("c", base, "f1") == "no pending steer note"


def test_dispatch_clear_removes_a_stranded_claim_too():
    # Claim-awareness (re-soak 2026-06-14, P2): the `c` key must remove a `.consuming` claim too,
    # else watch would say "cleared" while a re-run resurrects the note.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        claim = os.path.join(base, "steer", "f1.json.consuming")
        os.makedirs(os.path.dirname(claim), exist_ok=True)
        with open(claim, "w") as fh:
            fh.write('{"guidance":"stranded"}')
        fb = W.dispatch("c", base, "f1")
        assert "stranded claim" in fb, fb
        assert not os.path.exists(claim), "the claim must be removed"


def test_dispatch_write_refused_while_a_claim_exists():
    # A `g`/`p` write must refuse over a stranded claim rather than leave the next run halted on both.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        claim = os.path.join(base, "steer", "f1.json.consuming")
        os.makedirs(os.path.dirname(claim), exist_ok=True)
        with open(claim, "w") as fh:
            fh.write('{"guidance":"stranded"}')
        assert "refused" in W.dispatch("p", base, "f1")
        assert "refused" in W.dispatch("g", base, "f1", prompt=lambda _: "new")
        assert _note(base, "f1") is None, "no new live note written while a claim is unresolved"


def test_dispatch_guidance_refused_when_claim_appears_DURING_prompt():
    # P2 round 6 (Mateo's exact repro): the early check passes (no claim yet), but a `.consuming` claim
    # appears WHILE the human types guidance. The write primitive must still refuse — the guard is at
    # the side effect, not the pre-prompt check. No live note may be left next to the claim.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        claim = os.path.join(base, "steer", "f1.json.consuming")
        os.makedirs(os.path.dirname(claim), exist_ok=True)

        def prompt_that_strands_a_claim(_):
            with open(claim, "w") as fh:   # a consume claims (and crashes) mid-prompt
                fh.write('{"guidance":"stranded"}')
            return "my new guidance"

        fb = W.dispatch("g", base, "f1", prompt=prompt_that_strands_a_claim)
        assert "refused" in fb, fb
        assert _note(base, "f1") is None, "no live note may be written next to the claim"
        assert os.path.exists(claim), "the stranded claim is left intact for the human to resolve"


def test_dispatch_explicit_feat_id_targets_that_feat():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        _feat(base, "f2")
        fb = W.dispatch("p", base, "f2")
        assert "pause note written" in fb
        assert _note(base, "f2")["pause"] is True and _note(base, "f1") is None


def test_dispatch_unknown_key_is_noop():
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert W.dispatch("x", base, None) == ""
        assert _note(base, "f1") is None


def test_frame_dim_hint_when_no_live_agents_visible():
    # Hygiene fixlet (2026-06-11, HARNESS-DIRECTION): a user ran watch from $HOME and the
    # live-agents section silently vanished — no agents must render a dim pointer, not silence.
    saved = W.S._transcripts
    W.S._transcripts = None                          # deterministic: force the no-agents path
    try:
        with tempfile.TemporaryDirectory() as base:
            _feat(base)
            text = "\n".join(W.frame(base, None))
            assert "live agents: none visible from this directory" in text
            assert "run watch from the target repo's root" in text
    finally:
        W.S._transcripts = saved


def test_frame_no_hint_when_agents_are_visible():
    class _Stub:                                     # injectable transcript layer, agents present
        @staticmethod
        def live_agents(repo):
            return [{"label": "implement", "model": "Opus", "outputTokens": 5, "toolCount": 1}]

        @staticmethod
        def estimate_cost_usd(agents):
            return None
    saved = W.S._transcripts
    W.S._transcripts = _Stub
    try:
        with tempfile.TemporaryDirectory() as base:
            _feat(base)
            text = "\n".join(W.frame(base, None))
            assert "none visible from this directory" not in text
            assert "implement" in text               # the real section rendered instead
    finally:
        W.S._transcripts = saved


def test_frame_heartbeat_warning_flows_through_watch():
    # Item 1 (2026-06-11): the loud may-have-died line must reach the WATCH surface too —
    # frame() reuses status.render, so a stale .hb on a running feat warns here as well.
    saved = W.S._transcripts
    W.S._transcripts = None
    try:
        with tempfile.TemporaryDirectory() as base:
            _feat(base, "f1")                        # status=running
            now = 1_800_000_000
            sp = os.path.join(base, "feats", "f1.json")
            hb = os.path.join(base, "feats", "f1.hb")
            with open(hb, "w", encoding="utf-8") as fh:
                fh.write("")                         # touch-equivalent: mtime is the signal
            os.utime(sp, (now - 1500, now - 1500))
            os.utime(hb, (now - 1500, now - 1500))
            text = "\n".join(W.frame(base, None, now=now))
            assert "no heartbeat for 25m" in text
            assert "safe to resume with the same args" in text
    finally:
        W.S._transcripts = saved


def test_dispatch_pause_then_guidance_compose():
    # Audit P1 2026-06-11: watch keypresses MERGE into the pending note (write_note_merged),
    # never clobber — pause then guidance must yield a note carrying BOTH.
    with tempfile.TemporaryDirectory() as base:
        _feat(base, "f1")
        assert "pause note written" in W.dispatch("p", base, None)
        assert "guidance note written" in W.dispatch("g", base, None, prompt=lambda _: "use B")
        note = _note(base, "f1")
        assert note["pause"] is True and note["guidance"] == "use B"


# --- stdlib runner (no pytest required) ------------------------------------

if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok   " + fn.__name__)
        except AssertionError as exc:
            failed += 1
            print("FAIL " + fn.__name__ + ": " + str(exc))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("ERR  " + fn.__name__ + ": " + repr(exc))
    print("\n%d passed, %d failed" % (len(tests) - failed, failed))
    sys.exit(1 if failed else 0)
