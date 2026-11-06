---
name: window-review
description: Review everything merged to main in a timeframe (since a day, last N days, since a SHA/tag) as ONE cumulative diff, security / reuse / shared-UI / hygiene / scripts-CI dimensions with verified findings, churn analysis, and a pinned-version sweep that re-tests whether each "don't bump" rationale is still true. Outputs an epic of prioritized beads; lands safe fixes only when asked.
---

# Window Review: cumulative-diff review of a timeframe

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its per-dimension checklists, its pin sources, its deploy-state URL, its model and quota policy)
and overrides the generic defaults here. This file reads correctly without one.

Review a window of merged work as **one diff between two SHAs, never commit-by-commit**. The
point is token economy AND signal: 200+ PRs read one at a time costs a fortune and buries the
cross-PR patterns (duplicated helpers, drifting conventions) that only the merged endpoint shows.
Distilled from a review of 227 PRs (804 files, +122k lines), which this file exists to make
repeatable.

The lead session orchestrates and synthesizes; dimension reviews fan out to subagents. The lead
owns all `bd` mutations, all landing decisions, and the final report.

## 0. Model & agent policy

- **Lead: a Fable-class (top-tier) model.** The lead does the judgment work, partitioning,
  verifying subagent claims, writing beads, deciding what lands, and a weaker lead quietly
  degrades every downstream step. If invoked on a lesser model, say so and offer to continue
  anyway rather than silently proceeding.
- **Subagents, by dimension nature:**
  - `opus`, security review, dependency-feasibility evaluation, any dimension needing exploit
    reasoning or API-compatibility judgment. An opus dep-evaluator caught that a prescribed fix
    would have broken a feature's semantics; a scan-grade model would have applied it.
  - `sonnet`, pattern-scan dimensions (hygiene, terminology, allowlist checks, reuse
    fingerprinting) where the checklist is concrete and verification is mechanical.
  - **No subagent at all** for deterministic commands, churn analysis is inline `git log`
    arithmetic, version lookups are `npm view`. Keep to the repository's quota discipline.
- Every dimension prompt MUST require: verify each finding against the **current file** (not just
  the diff hunk) before reporting, cull anything unconfirmed, report as
  `file:line · severity · one-line issue · one-line fix`. Unverified findings are the failure
  mode of this whole pattern.
- Subagents chunk their reading: `git diff --stat` per subtree first, then per-directory diffs.
  Never hand an agent the whole 100k-line diff.

## 1. Parse the timeframe → boundary SHA

Accepted forms: `since Saturday`, `since 2026-08-29`, `last 4 days`, `since <sha>`,
`since <tag>` (e.g. the last release tag, useful for "what will the next release ship").

```bash
git pull origin main && bd dolt pull      # sync FIRST; a stale main reviews the wrong window
# day/date forms: first main commit at/after the boundary:
git log origin/main --since="<date> 00:00" --format="%H %ad %s" --reverse | head -3
# tag form: BOUNDARY=$(git rev-list -n1 <tag>)
```

Range is `BOUNDARY^..origin/main` (the `^` includes the boundary commit itself). Echo the
resolved range, its commit count, and both endpoint subjects back to the user before spending
tokens, an off-by-one-day boundary reviews the wrong 50 PRs.

## 2. Size, partition, exclude generated noise

```bash
git diff --numstat BOUNDARY^..origin/main | awk -F'\t' '{ ...bucket by top-2 path segments... }'
```

Explicitly set aside (skim-check only, never deep-read): migration snapshot files,
lockfiles, LFS binaries/baselines, generated code. State what you excluded, silent
truncation reads as "covered everything".

Then fan out one subagent per dimension, scoped to its slice of the tree.

## 3. The dimensions (per-agent checklists)

**Security** (`opus`; the app, server, library, auth and component trees):
new/changed routes, server actions and pages missing authz (gates live where the request is
handled, never in a shared layout; a server action is a public HTTP endpoint, client-side checks
don't count); path-traversal validation BEFORE any path join, per segment; dynamic URLs through
the repository's URL-safety helper; stored markdown through the server-side write policy; raw SQL
interpolation, command injection, `dangerouslySetInnerHTML`, unsanitized socket payloads;
secrets in the diff; **new mutating endpoints without the rate-limit/dedup their siblings have**
(the one real finding of the first run was exactly this shape); IDOR vs the cluster's ownership
idiom; optional-file reads swallowing more than ENOENT. The repository's own invariant names live
in `LOCAL.md`.

**Reuse & shared UI** (`sonnet`, escalate to `opus` if the kit-design questions dominate; the
component, app, hook and library trees): near-duplicate logic added twice in the window, or
duplicating an existing library helper; hand-rolled primitives the shared kit already provides
(modals/overlays, `title=` tooltips, tier colors, raw markdown renderers); repeated JSX/logic that
should become a shared-kit primitive or shared hook, name the pattern, the files, and a rough
API; local components that are secretly generic (stat tiles, clocks, badges), count the copies;
whether an in-flight migration's own rules were violated by new code (e.g. Tooltip triggers that
aren't focusable). Ask: is the kit being adopted or fought?

**Hygiene** (`sonnet`; migrations, tests, docs, the rest): new migrations ordered the way the
migrator requires (a migrator that is a timestamp watermark permanently skips a backwards entry),
no committed migration SQL edited, NOT NULL additions carry defaults; no `.only`/`fit`, no
sampling in sweep-style tests; guardrail allowlists moved shrink-only; banned terminology and
retired hostnames; TODO/console.log/commented-out code; new `as any`/`@ts-ignore`; summarize doc
drift (the rulebook and friends) in bullets, not diffs.

**Scripts & CI** (`opus`; scripts, workflows, deploy files, package manifest, lint rules):
workflow inputs interpolated into `run:` bodies instead of `env:` (attacker-influenced strings,
PR titles, branch names, doubly so); piped gates that mask exit codes; jobs whose `if:` can
publish a `skipped` check (blocks auto-merge repo-wide); literal `${{ }}` in workflow prose;
bare `lfs: true`; new scripts without the paired node-test their siblings have; deploy-helper
changes without their test updates; dependency changes worth flagging.

## 4. Churn analysis: the endpoint-diff blindness check (inline, cheap)

The endpoint diff cannot see intra-window rework, a bug introduced Monday and reverted Tuesday
reads as one clean change. Measure it:

```bash
# rewrite factor: sum of per-commit adds vs surviving adds (~10% = healthy; interpret, don't panic)
git log --format=%H RANGE | while read s; do git show --numstat --format= $s; done | awk '{a+=$1} END {print a}'
git log --oneline -i --grep="revert" RANGE          # true reverts (subject-prefix ones)
git log --format=%s RANGE | grep -oE '<bead-prefix>-[a-z0-9.]+' | sort | uniq -c | sort -rn | awk '$1>=3'  # fix-chains
git log --name-only --format= RANGE | sort | uniq -c | sort -rn | head -15                       # hotspots
```

Interpret fix-chains against the beads: N PRs on one bead is often a *planned* surface-by-surface
migration, not thrash. Say which.

## 5. Pinned-version sweep: and re-test every pin's RATIONALE

Discovery, a pin hides in more places than `package.json`:

| Source | What to look for |
|---|---|
| `package.json` deps | exact versions (no `^`/`~`), but check `git log -G` before assuming intent: the first run found an "exact pin" that was just create-next-app's default style, never a decision |
| `package.json` `overrides` + its `// overrides` comment block | every entry has a written rationale, is it still true? |
| `.github/dependabot.yml` | `ignore:` entries |
| The `dependabot-handler` skill's known-issues list (its `LOCAL.md`) | the **Known Issues (DO NOT MERGE)** list, this file *teaches every future agent to auto-reject*, so a stale entry there is the most expensive kind of stale |
| The rulebook / agent docs / `bd memories` | "don't bump", "pinned", "held back" prose |
| types-vs-runtime pairs | e.g. `@types/X` majors behind runtime `X`, check whether the types are a repo pin or just DefinitelyTyped lag (`npm view @types/X version`) |

For each pin: current vs latest (`npm view <pkg> dist-tags`), the recorded WHY, and, the step
that pays for the whole sweep, **is the why still true?** The first run found a browser-tooling
pin's "offline CI" rationale had been false for weeks (every workflow ran the install step at CI
time); the pin survived only because its rationale sat in a skill file nobody re-audited.

Classify and act:

- **Bump-testable** → dedicated worktree (`scripts/worktree-new.sh`, `--await` before any gate),
  apply the bump (update `overrides` consistently, `$`-references track automatically), run the
  full ladder: install (watch peer/override conflicts), all three type-checks, lint, full test
  suite, build. `opus` subagent; it must read the release notes/changelog first and map breaking
  changes onto the repo's actual usage surface (rg the imports) rather than trusting green gates
  alone.
- **Upstream-blocked** → name the exact blocking artifact (e.g. "a vendored lint plugin
  calls a removed API") and the concrete recheck trigger ("next config-next
  minor, not patch releases"). Verify OUR side is ready (custom rules/plugins) so the recheck is
  cheap.
- **Environment-constrained** → evaluate the constraint itself (read the CI workflows, the runner
  docs), not just the package. Produce an unblock plan with real costs (e.g. "every visual
  baseline drifts on a browser-major jump, one baseline-regeneration dispatch + an afternoon of
  diff review").

Landing policy: safe dev-dep bumps may go straight to a PR when the user asked for landing;
**auth/payments/security-critical bumps get `do-not-merge`** (the label, not draft status, draft
is not a hold) plus a written runtime-verification plan, and the user decides timing. Check
`gh api .../dependabot/alerts` while you're here, dependabot may have already fixed what you
were about to file.

## 6. Also check (cheap, high-yield)

- **Deploy state**: the staging deploy's version endpoint (a consumer's overlay may give the URL) vs the
  window's HEAD; note that anything observed on production tests against the last release tag,
  not main.
- **Bead reconciliation**: findings the window already fixed → close the stale-open beads with
  `origin/main` evidence, don't re-file them.
- **Blindness disclosure**, state these limits in the report every time: the endpoint diff hides
  intra-window churn (mitigated by §4); static review says nothing about runtime behavior under
  load (point at the repository's load-testing skills, if it has them, and file a verification bead
  when the window added hot paths); generated/excluded files were skimmed, not read.

## 7. Outputs & follow-through

1. **One epic + child beads** for actionable findings, prioritized (P2 for real defects and
   promotions, P3 for mechanical cleanups; defer nothing that an agent could pick up today).
   Small `bd` batches, push between, verify with `bd show`, per the repository's tracker
   discipline.
2. **The report**, led by verdicts: one line per dimension (clean / findings), then findings in
   priority order, churn interpretation, the pin table with per-pin verdicts, and the blindness
   disclosure. Complete sentences; no codenames the reader didn't watch you invent.
3. **Land only what was asked.** Review is the deliverable; one-line fixes may ride along per the
   "a failure you saw is a failure you own" rule, and bump PRs follow §5's landing policy.
4. Record durable discoveries (a pin rationale verified, a decision made) via `bd remember` or a
   note on the relevant bead, the next window review starts from them.
5. This pairs naturally with `/beadsBulk <epic>` as the execution follow-up.

## Anti-patterns

- Reviewing commits one at a time (the thing this skill exists to replace).
- Reporting a subagent finding you didn't spot-verify, or that the subagent didn't verify against
  the current file.
- Treating a pin's recorded rationale as current fact instead of a claim to re-test.
- "Fixing" a types-behind-runtime gap by moving the wrong side (downgrading the runtime).
- Filing beads for alerts dependabot already fixed, check merged PRs and the alerts API first.
- Launching a subagent to run `npm view` / `git log` / churn arithmetic.
- Silently excluding generated files without saying so.
