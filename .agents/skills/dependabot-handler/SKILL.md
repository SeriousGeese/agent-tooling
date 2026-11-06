---
name: dependabot-handler
description: Automated workflow for handling Dependabot PRs, including local testing, CI verification, beads tracking, and a repository-owned list of known bumps to reject.
---

# Dependabot Handler Skill

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's install and
gate commands and its list of known ecosystem incompatibilities (the bumps that must be
rejected), and overrides the generic defaults here. This file reads correctly without one.

This skill guides the Dependabot Handler Agent in verifying, testing, and merging Dependabot PRs safely, avoiding known ecosystem incompatibilities.

## Core Workflow

1. **Bead Tracking:** Every Dependabot PR must be tracked via a `beads` issue created by the PR Status Agent. Ensure you are updating the correct bead.
2. **Local Verification:**
   - Checkout the PR branch.
   - Install the bumped dependencies with the repository's clean-install command (for a Node project, `npm ci`).
   - Run the repository's local quality gates (lint, type-check, test, build), with output compression when available. Run them bare or through `scripts/gate.sh`, never piped into a filter.
3. **CI Verification:**
   - Check GitHub Actions status via `gh pr checks <pr-number>`.
4. **Resolution:**
   - If tests and CI pass, and there are no known issues, arm the merge: `env -u GITHUB_TOKEN gh pr merge --auto <number> --repo <owner>/<repo>`. A green required check puts it in the merge queue (where the repository has one), which sets the merge method, so pass none. Never add `--admin`: merging past branch protection is human-only (the break-glass guard refuses it).
   - Close the tracking bead with a success reason.
   - If tests or CI fail, or a known issue is encountered, reject the PR: comment on the PR instructing Dependabot to ignore the version, close the PR, and close the tracking bead with the failure reason.

## Quota and delegation

Output compression is the preferred way to reduce quota from noisy install, lint, test, and build output. Inspect the compressed output first; do not spawn subagents merely to run commands or summarize routine logs.

Use a lower-cost/background agent only for bounded side reasoning, such as comparing a broad failure against known ecosystem breakages or reviewing a completed dependency diff. Keep bead state changes, merge/reject decisions, GitHub comments, and final reporting with the Dependabot Handler Agent unless an exact mechanical command sequence is explicitly delegated.

## Known Issues (DO NOT MERGE)

The bumps that must be rejected and ignored are listed in `LOCAL.md`, because each one is a fact
about one repository's dependency graph. With no `LOCAL.md` there are none: treat every bump the
same way and let the gates decide.

**Every entry in that list must name a constraint that is periodically RE-VERIFIED, not folklore.**
A reject rule written there trains every future session to auto-reject with the recorded reason,
so a stale entry is the most expensive kind of stale. A rationale that was never true (an
"offline CI" claim that every workflow contradicted, say) survives for months only because it sits
in a file nobody re-audits. Each entry carries the date it was last re-verified, the exact
blocking artifact, and the concrete trigger for the next recheck (for example "the next minor of
the plugin, not patch releases"). Retire an entry when its constraint stops being true, and keep a
"retired entries" note saying why, so it is not re-added without re-verifying.

**A bump that moves a pinned browser or toolchain build is a special case.** If CI downloads a
large binary inside the job (a browser build, for instance), a revision bump can stall every job
on a runner fleet with a cold cache, even though a patch bump that keeps the same pinned build
does not. Pre-seed the host's cache before merging such a bump, check it with the repository's
own verify command, and do not record the bump as safe on the strength of an install step that is
green whether it skipped or downloaded. The repository's specifics (the cache path, the seeding
command) belong in `LOCAL.md`.
