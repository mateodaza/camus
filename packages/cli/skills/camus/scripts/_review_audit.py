#!/usr/bin/env python3
"""Write a per-round Codex review AUDIT record — proof the cross-vendor review actually ran.

Called best-effort by codex_review.sh (never raises into the review path):
  _review_audit.py <audit_path> <worktree> <round> <codex_exit> [reviewer_model] [reviewer_effort] [meta_contract_json]
  # raw Codex stdout on STDIN; model/effort/rc1-fields come from the round's meta.json (the sealed identity)

The record captures Codex's raw response + metadata. A human (or a post-run check) can confirm every
review round produced a file with a real Codex response — and the ABSENCE of a file for a round means
codex_review.sh never ran for it (the thin reviewer fabricated output, or an infra failure occurred).
"""
import json
import os
import sys
import tempfile
import time

# The audit `ran` must mean EXACTLY what the gate means by "a review ran" — so reuse the adapter's
# own normalizer rather than re-deriving the rule (verification audit 2026-06-13: an inline
# overall_correctness check still diverged from the adapter, which ALSO rejects missing findings[],
# malformed priorities, and "patch is incorrect" with no blocking findings). Guarded import keeps
# this best-effort writer from ever raising into the review path.
try:
    import adapter as _adapter
except Exception:  # pragma: no cover - sibling always present in a real gate
    _adapter = None


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return x


def binding_from_env(env=None):
    """The resolved review binding codex_review.sh exported (CAMUS_REVIEW_BINDING).

    Lets the RECEIPT prove which invocation produced it: requested versus actual
    round and effort, the gate nonce, the canonical worktree, and the backend.
    Before this existed, a receipt's only claim to a round was its filename, so a
    review that silently ran as r0 could be accepted as r2 (field report
    2026-08-04). Best-effort by design: a malformed value yields no binding
    rather than raising into the review path, and a consumer treats a MISSING
    binding as unbound — never as agreement.
    """
    env = env if env is not None else os.environ
    raw = env.get("CAMUS_REVIEW_BINDING")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict) or parsed.get("error"):
        return None
    requested_round = parsed.get("round")
    if not isinstance(requested_round, int):
        return None
    return {
        "gate_nonce": parsed.get("nonce") or None,
        "round_requested": requested_round,
        "effort_requested": parsed.get("effort") or None,
        "effort_specified": bool(parsed.get("effort_specified")),
        "round_sources": parsed.get("round_sources") or None,
        "effort_sources": parsed.get("effort_sources") or None,
        "reviewer_backend": env.get("CAMUS_REVIEW_BACKEND") or None,
        # REVIEW-CONTRACT (rc1) carried fields, so the forensic per-round record proves
        # the scope, qualification, and provenance the review actually ran under — not
        # just its round/effort. A missing field is left null (unbound), never guessed.
        "contract": parsed.get("contract") or None,
        "scope": parsed.get("scope") or None,
        "qualification": parsed.get("qualification") or None,
        "origin": parsed.get("origin") or None,
        "operator": parsed.get("operator") or None,
        "transport": parsed.get("transport") or None,
        "connection": parsed.get("connection") or None,
    }


RC1_FIELDS = ("contract", "scope", "qualification", "origin", "operator", "transport", "connection")


def _meta_contract(meta_contract):
    """Parse the rc1 carried fields codex_review.sh reads from the round's sealed meta.json.

    meta.json is the SAME authority emit_outcome uses for the stdout binding, and it is
    written at review START — so it carries these fields on every boundary the audit is
    rewritten (fresh terminal emit, REPLAY of a finished round, live-review ADOPTION, await
    reattach). Sourcing the audit's rc1 fields from it — rather than from CAMUS_REVIEW_BINDING,
    which is only enriched with them AFTER the replay/adopt early-exits — is what keeps a
    replay/adopt from overwriting a previously complete audit with null contract fields.
    """
    if isinstance(meta_contract, dict):
        return meta_contract
    if not isinstance(meta_contract, str) or not meta_contract.strip():
        return {}
    try:
        parsed = json.loads(meta_contract)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def build_record(wt, rnd, status, raw, reviewer_model=None, reviewer_effort=None, env=None,
                 meta_contract=None):
    try:
        parsed = json.loads(raw) if raw.strip() else None
    except (ValueError, TypeError):
        parsed = None
    # `ran` = the gate's "usable verdict" oracle, computed by the SAME adapter the loop branches on,
    # so the forensic file can never claim a review ran for output the gate rejected as infra.
    ran = False
    if _adapter is not None:
        try:
            ran = _adapter.normalize_codex(raw, _int(status)).get("ran") is True
        except Exception:
            ran = False
    binding = binding_from_env(env)
    actual_round = _int(rnd)
    record = {
        "ran_at": int(time.time()),
        "worktree": wt,
        # The canonical worktree path, so a receipt cannot be matched to a run by
        # basename alone (two checkouts can share one).
        "worktree_canonical": os.path.realpath(wt) if isinstance(wt, str) and wt else None,
        "round": actual_round,
        "codex_exit": _int(status),
        "ran": ran,
        # The reviewer model the caller pinned for this round (identity slice). The
        # consumer trusts it only when ran is True — unknown never becomes claimed.
        "reviewer_model": reviewer_model or None,
        # The reasoning effort this round ACTUALLY ran at (from the round's meta,
        # the same authority as the model) — the requested/actual pairing needs
        # the actual side sealed, not inferred from a snapshot.
        "reviewer_effort": reviewer_effort or None,
        "codex_raw": raw,
        "codex_parsed": parsed,
    }
    if binding is not None:
        # rc1 fields from the sealed meta.json WIN over the env-derived binding: on a replay or a
        # live-review adoption the env (CAMUS_REVIEW_BINDING) is not yet enriched with them, but
        # meta.json always carries them — so the per-round audit stays complete across every
        # boundary instead of being overwritten with nulls. A missing/blank meta field falls back
        # to whatever the env binding already had (never downgrades a present value to null).
        meta = _meta_contract(meta_contract)
        for key in RC1_FIELDS:
            value = meta.get(key)
            if isinstance(value, str) and value:
                binding[key] = value
        record["binding"] = dict(
            binding,
            round_actual=actual_round,
            # The effort the round ACTUALLY ran at comes from meta.json (the same
            # authority as the model); requested comes from the binding. A
            # consumer compares them rather than assuming they agree.
            effort_actual=reviewer_effort or None,
            reviewer_model=reviewer_model or None,
            bound=(
                binding["round_requested"] == actual_round
                and (reviewer_effort is None or binding["effort_requested"] == reviewer_effort)
            ),
        )
    return record


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 4:
        return 2
    audit_path, wt, rnd, status = argv[0], argv[1], argv[2], argv[3]
    reviewer_model = argv[4] if len(argv) > 4 else None
    reviewer_effort = argv[5] if len(argv) > 5 else None
    # The rc1 carried fields from the round's sealed meta.json (codex_review.sh passes them as a
    # JSON blob). Optional and best-effort: an absent/blank arg falls back to CAMUS_REVIEW_BINDING.
    meta_contract = argv[6] if len(argv) > 6 else None
    raw = sys.stdin.read()
    rec = build_record(wt, rnd, status, raw, reviewer_model, reviewer_effort,
                       meta_contract=meta_contract)
    # Atomic publish: write a same-directory temp file, fsync, then os.replace()
    # onto the final path — a reader (e.g. the Studio watcher) ever sees the OLD
    # complete file or the NEW complete file, never a truncated mid-write JSON.
    directory = os.path.dirname(os.path.abspath(audit_path))
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".audit-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, audit_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
