---
name: bead-workflow
description: Claim, implement, verify, push, and open PRs for Beads issues. Use when the user asks to work a bead, run bead ready, pick ready beads, claim one or more bead IDs, fix multiple beads in one branch, or perform a Beads-driven implementation workflow similar to Claude's /bead command.
---

# Bead Workflow

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its verification command, pipeline, toggle policy, docs to update) and overrides the generic
defaults here. This file reads correctly without one.

Take one or more beads from selection to a merged PR. Keep every requested bead on one branch
unless the user asks to split them. The repository's rulebook (`AGENTS.md` or its equivalent) and
any pipeline doc it links describe what happens after the push (CI, required checks, the merge
queue, deploys). This skill is the order you do things in.

## Operating policy (the invocation can override)

- **Front-load every blocker; assume the user stepped away.** Before editing code, put every real
  product or scope decision the bead leaves open into one multiple-choice question (in Claude Code,
  `AskUserQuestion`), then proceed. Never defer a blocking question to later in the run, and never
  re-ask what the bead answers.
- **Make reasonable calls, then log them for undo.** Print them at the end under
  **"Judgment calls (review/undo)"**: what was decided, where (file / PR), how to revert.
- **Read the request.** Empty or `ready`: select work yourself (step 1). Bead ids: collect them in
  order; text after them is process notes, not a replacement for the bead. Several compatible ids
  go in one branch and PR: fewer PRs is the goal. A conflict between requested beads, a bead
  already implemented, blocked or unsafe to combine: stop and explain before coding.
- **An epic the user asks you to do** authorizes every implementation child and clearing deferrals
  on them, never unrelated work or enabling a feature toggle (follow the repository's epic
  execution policy if it has one). One child or tightly compatible slice per branch and PR, each
  branched from current `origin/main`, in dependency order. Stacked PRs are unsupported: a slice
  that needs an unmerged sibling waits for it to merge. New feature toggles stay in their
  default-off state and every PR names them. Close children, then the parent.
- **Delegate sparingly.** Do not spawn subagents to run deterministic commands, and compress
  noisy output with whatever your environment offers rather than asking another agent to
  summarize it. Selection, claims, bead mutations, implementation, verification judgment, commit,
  PR body and the final response stay with you.

## Steps

1. **Select (only for `ready`).** `bd dolt pull`, then `bd ready -n 100 --exclude-label
   human-required`. Prefer tractable P0/P1 bugs, then well-scoped quick wins over multi-day epics.
   `ready N` picks up to N beads that fit one branch; plain `ready` picks one. State the pick and
   why in one line and continue. Nothing suitable: list the top three with a line each and stop.
2. **Preflight each bead.** `bd show <id>`, then audit the files, routes, tests or merged PRs it
   names against current `origin/main` (`node scripts/fetch-main.mjs`). Already done: add an audit
   note with the evidence, close or retarget it, pick another. Taken: a fresh `assignee` /
   `started_at` in `bd show <id> --json`, an open PR or a remote branch naming it, or a live agent
   in `ListAgents` means pick something else.
3. **Claim.** `bash scripts/claim.sh <id> feat/<branch>` (new worktree) or
   `bash scripts/claim.sh <id> --claim-only` (already in one). It pulls Dolt, claims under your
   per-session id, refuses another actor's claim under 4h old and publishes the claim; a hook
   refuses a bare `bd update --claim`. A refusal means someone else has it: do not overwrite them.
   A takeover needs positive evidence of abandonment, `AGENT_TOOLING_ALLOW_CLAIM_STEAL=1` and a
   `bd note`.
4. **Enter the worktree.** In Claude Code, `EnterWorktree` on the new path before editing, and only
   then dispatch subagents. A harness-assigned `.claude/worktrees/*` branch is fixed (the
   branch-switch guard refuses `git checkout -b` and `git switch` in a linked worktree): keep its
   name, or make a new worktree with `claim.sh`. Then `bash scripts/worktree-new.sh --await <path>`
   before any gate.
5. **Implement.** Stay inside the bead, and fold mid-work findings into it instead of filing new
   beads: related work, small isolated work and bugs in your own code, tests or review are
   `bd note`d here and fixed in this branch. A new bead is only for a tier change, a human
   decision, an unlanded blocker or unrelated work. A pipeline red you see is yours: a failure you
   saw is a failure you own. Follow the repository's terminology and conventions; update the docs
   a behaviour change touches; a schema change follows the repository's migration checklist.
6. **Verify.** `git add` new files (many guardrails see tracked files only), then run the
   repository's verification command through the capture helper, in the background:
   `bash scripts/gate.sh --name verify-local <the repository's verify command>`, and read the
   verdict from `tail -n 20 .tmp-gates/verify-local.log`. Fix failures, pre-existing ones
   included. Never run several full test suites at once on one box. A regression test is proven
   by showing it fails against the unfixed code, never by a passing run alone. Whenever you run
   less than the full set, name in the PR body exactly which gates ran and which are left to CI.
7. **Commit and push.** Stage code only, never `.beads/issues.jsonl`. Confirm the commit with
   `git log -1`, then push.
8. **Open the PR, ready unless someone will read the diff first.** Write the body with the Write
   tool from the repository's PR template (a `## Summary` and a `## Verification` section where
   it has them) and pass `gh pr create --body-file <path>`, never a heredoc. Name every bead it
   completes on one `Fixes: <bead-id>[, <bead-id>]` line; a bead it only advances is "Part of
   <bead-id>" in prose.
9. **Arm auto-merge with your own token.** `env -u GITHUB_TOKEN gh pr merge --auto <pr>`, no merge
   method. After `gh pr ready` on a draft use `env -u GITHUB_TOKEN node scripts/pr-queue-state.mjs
   <pr> --rearm` instead. Armed with `GITHUB_TOKEN`, a merge fires no push workflows, so a deploy
   would not run and beads would not close.
10. **Answer the gate and the review.** A red required check is yours: the failing job's name says
    which group went red. A review that blocks does so on a real defect: fix it here with a
    regression test and push. A queued PR's branch is locked: `node scripts/pr-queue-state.mjs
    <pr> --dequeue`, push, `--rearm`. A finding you think is wrong goes to a human with the
    evidence. `DIRTY` means `git fetch origin main && git merge origin/main`, then a plain push,
    never a rebase. Poll with `node scripts/pr-queue-state.mjs <pr>` every 5 minutes or more,
    never a tight loop.
11. **Land and report.** `bash scripts/land.sh <worktree path> --queued-ok` exits 0 once the PR is
    queued (move on; same-file work waits for the merge) and, run again after the merge, checks
    every `Fixes:` bead closed and removes the worktree. Exit 5 (ejected) and 6 (held) are yours.
    Close by hand only an id the close-beads run lists as unknown, held or without a `Fixes:`
    line, after that run finishes. The final response links the beads and the PR, lists the
    judgment calls, and files any tooling friction you worked around with
    `node scripts/oddity.mjs new` (or `recur <N>` for an archived entry).

## Example requests

- `$bead-workflow ready`
- `$bead-workflow ready 3`
- `$bead-workflow <bead-id>`
- `$bead-workflow <bead-id> <bead-id> fix these together in one branch`
- `Use the bead workflow to pick two ready quick wins and fix them in one PR.`
