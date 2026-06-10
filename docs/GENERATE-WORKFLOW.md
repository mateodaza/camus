# Generating the v2-lite workflow (G1 confirm + build in one step)

Dynamic workflows are written by Claude Code, not hand-authored. This is the
platform-intended flow: install the skill, prompt Claude Code to generate the
workflow from it, inspect the script it writes, then save it as `/camus`.
If Claude Code generates a workflow at all, **G1 is confirmed** (the feature is
enabled on your setup). If it can't, toggle "Dynamic workflows" on in `/config`.

## 0. Prereqs (one time)

```bash
# install the skill + workflow so Claude Code can see them (copies into ~/.claude)
./install.sh
# codex is already installed + authed; confirm:
codex --version
# For unattended/auto runs, allow ONLY the two gate commands — never wildcard the whole
# scripts/ dir (test_*.py and future helpers live there). The dir-arg refactor means each
# gate is one command, so a tight prefix rule covers it (the trailing :* allows the worktree arg).
# Surest way to get the exact syntax Claude Code accepts: on the first run, approve each with
# "Yes, and don't ask again for: <command>" — it records the correct narrow rule for you.
# Then run /permissions and confirm you see just these three, scoped narrowly:
#     Bash(bash .../skills/camus/scripts/codex_review.sh:*)
#     Bash(bash .../skills/camus/scripts/verify.sh:*)
#     Bash(git worktree:*)
```

## 1. Generation prompt (paste into Claude Code, from the repo root)

> ultracode: Build a dynamic workflow that runs the Camus closed loop on a
> single task, following the rules in the `camus` skill. The task comes in
> `args` (a description, optionally a target path).
>
> Phases:
> 1. PLAN — one agent (Sonnet) reads the relevant files and writes a short plan. No code yet.
> 2. IMPLEMENT — one agent on a cheap model (Haiku) makes the change in an isolated git worktree.
> 3. REVIEW LOOP — repeat up to ROUND_CAP = 3:
>    a. Spawn a THIN reviewer agent that runs
>       `bash .claude/skills/camus/scripts/codex_review.sh` and returns ONLY
>       its stdout JSON. The agent must not re-judge or summarize the verdict.
>    b. Parse the JSON. If `ran` is false → INFRA failure, not findings: wait briefly
>       and retry the reviewer (max 2 infra retries). Never treat it as a rejection,
>       never as clean.
>    c. If `ran` true and `clean` true → exit loop, review passed.
>    d. If `ran` true and `clean` false → spawn a fix agent (Haiku) with the `blocking`
>       findings; it fixes them in the same worktree; then loop.
>    On hitting ROUND_CAP with blocking findings still present, stop and report them
>    for human review. Never loop on priority-3 nits.
> 4. VERIFY — one agent runs `bash .claude/skills/camus/scripts/verify.sh` and
>    returns its JSON. The task is DONE only if `pass` is true. A clean review does NOT
>    override a failing verify.
>
> Constraints: route implementation/fix to a cheap model, keep plan/review stronger;
> set a soft token target; rely on the runtime agent caps as the backstop. The workflow
> script only COORDINATES — agents run all shell commands and return JSON; the script
> parses JSON and branches. Show me the script before running.

## 2. Review the generated script before saving

Check the script Claude writes actually does:

- [ ] Gates on the parsed `clean` flag (≡ no `priority<=2`), NOT on free text.
- [ ] `ran:false` → retry the reviewer (infra), and it does NOT count as a fix round
      or as a pass. (This is the #1 runaway cause — verify it explicitly.)
- [ ] ROUND_CAP enforced; stops and reports leftover P0/P1/P2 to the human.
- [ ] Never loops on priority-3 nits.
- [ ] VERIFY is required even when review is clean (deterministic ground truth wins).
- [ ] Cheap model on implement/fix; stronger on plan/review.
- [ ] Implementation happens in an isolated worktree.
- [ ] The script coordinates only — it does not itself call shell/`jq`/`pnpm`.

If all pass, save: `/workflows` → select the run → press `s` → save as `/camus`.

## 3. Then dogfood the loop end-to-end

Run `/camus <a small real task>` and watch it converge:
plan → implement → review → fix → review → clean → verify. Paste the generated
script back for a second review (it can even go through `codex_review.sh` itself).
