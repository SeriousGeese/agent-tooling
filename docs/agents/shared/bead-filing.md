Vendored from SeriousGeese/agent-tooling. A repository's own incidents and measurements live in its own docs, which link here.

# When to open a bead, and when not to

Rules live in the consuming repository's agent rulebook, which carries the one-line versions. This
page is the reasoning and the edge cases.

## Why

Sessions open a bead for nearly everything they notice mid-work: a bug in the code they just
wrote, a reviewer's minor finding, a two-line cleanup next door, a "could also..." idea, and the same
pre-existing red, once per session that walks past it. Each one is cheap to file and expensive to
own. Someone has to re-read it, re-derive the context the filer already had, dedupe it, and
eventually close it. Most of them are finished faster than they take to triage.

Pipeline and deploy reds are the opposite problem: every session reports "main is red" and goes
back to its own bead, so nobody owns the red.

## The rule: fold it into the bead in flight

**Do not open a new bead when any of these is true.** Record it on the current bead (`bd note`)
and FIX IT in the current bead's branch, before the bead closes:

1. **It is directly related to the bead in flight**: same feature, same files, same acceptance
   criteria, or something the change needs to be correct or complete.
2. **It is small and isolated**: minutes of work, even if unrelated. Do it as a separate commit
   and call it out in the PR body, so it is never a silent fix inside a PR scoped to something else.
3. **It is a bug in the current bead's own implementation or tests**, including a reviewer finding
   on your own PR, blocking or not. Fix it in the PR.

**A note on the current bead is a promise to fix it in the current bead.** A note on a bead that
then closes is lost: nothing re-surfaces a closed bead's notes, and another session can close the
bead minutes later without reading them. So:

- Never close a bead, or let its PR's `Fixes:` line close it, while it carries an in-scope note
  that is not fixed. Fix it, or, only if an exception below applies, move it to its own bead
  first and say so on both.
- In most cases there is therefore **no follow-up work at all**. "Follow-up bead" is the
  exception, not the default end of a PR.

### When a new bead is still right

Open one (after `bd search`, see "Dedupe") only when folding the work in would:

- **change the PR's review tier**: if the repository tiers a diff by risk, pulling a high-tier
  file into a low-tier PR changes what the PR costs and who must look at it;
- **need a human**: a product decision, a design preference, sign-off. File it, tag it
  `human-required` or raise an ask;
- **be blocked on unlanded work**: another PR or bead must land first (where stacked PRs are
  unsupported, it cannot ride along);
- or when it is **neither related nor small**: a real, unrelated piece of work.

A bug found AFTER the bead's PR merged is a new bead that links back to the original. Do not
reopen a closed bead.

**A bead you do file is not deferred unless someone asked for that, and its priority is your
call unless someone specified one.** Deferring by default hides real work from `bd ready`. Pick the
priority from the impact, and say why in the description when it is P0 or P1. Mandated or automated
beads keep their own defaults (see the next section).

### Beads that keep being filed as before

These are mandated or automated, and the rule above does not touch them. The repository's rulebook
lists its own; typical members:

- the cleanup child of every new feature toggle, deferred at creation;
- release-train verify items;
- tooling-friction beads, deduped against open ones;
- the beads an automated filer opens for a red pipeline or a flaky test;
- beads recorded from a user-tagged "feature idea" message, which carry their own default priority
  and deferral.

### Dedupe

Before any `bd create`, `bd search` one or two key terms. A match that is still open gets a
`bd note` with what you saw, not a sibling. If the work belongs to another open child of the same
epic, note it there. A recurring flake is one bead per spec with occurrences appended, never one
bead per sighting.

### Bulk runs

In any fan-out, **workers do not file beads.** They report candidates in their result; the
orchestrator dedupes across workers, applies the rules above, and files what is left in one pass.
Five workers walking past one red is one bead.

## Speculative ideas go to the idea inbox

A "could also...", "nice to have" or "we might want..." that nobody asked for is **not** a bead. It
is one line on the open idea-inbox bead (`idea-inbox.mjs`, in the `hygiene` set; the asks use
`ask.mjs` from the `asks` set when present):

```bash
node scripts/idea-inbox.mjs add "<the idea, one sentence>" --source "<bead id or context>"
node scripts/idea-inbox.mjs show
```

The helper finds the open bead labelled `idea-inbox` (or opens one), appends the idea as a note,
and makes sure it carries an ask for each person listed under `people` in `agent-tooling.json` (re-raising an ask a
person already cleared, so new ideas after a triage still reach everyone). When they walk their
asks, every idea they want becomes its own bead, and a person closes the inbox. The next `add`
opens a fresh one.

The inbox is labelled `human-required`, so `bd ready --exclude-label human-required` never offers
it to an agent, and it is a childless task, so no nightly hygiene task closes it. **No agent and no
hygiene pass closes the inbox**: the hygiene and readiness passes skip the `idea-inbox` label.
Losing an idea nobody read is exactly what it exists to prevent.

## A failure you saw is a failure you own: pipeline and deploy reds

This rule is about the **shared pipeline**: the default branch's CI red, a verified-tag stuck behind
the default branch, a failing staging or production deploy, a red smoke test, a red end-to-end run
on the default branch, and the merge queue failing on the default branch itself. "Main is red"
followed by going back to your own bead is the failure it exists to stop.

When you see one:

1. **Find its bead.** An automated filer usually already opened a P0:
   `bd search "<workflow or spec name>" --status open,in_progress`, then list by the filer's
   label.
2. **Unclaimed (or no bead yet)?** File it (P0 when it blocks merges or deploys, a lower priority
   only when it does not) and **claim it for this session**. It now comes before your own bead:
   park that one honestly (`bd update <id> --status open -a ""` plus a note saying why) and work
   the red.
3. **Already claimed by another live actor (claimed under the fresh-claim window, 4 hours by
   default)?** Add what you saw with `bd note` (the run URL, the failing step, anything you ruled
   out) and go back to your own work. Never steal it.
4. **Either way, say so out loud** in your handoff. Never report a gate green while narrating a
   failure away.

A red on **your own PR** is not a pipeline red: it is your bead's bug (rule 3). A red you merely
walked past in a local run is fixed when small (rule 2). Otherwise it gets ONE deduped bead with
the exact command, the failing output and what you ruled out. **Do not weaken a guardrail, delete
an assertion or widen an allowlist to turn a red green.** That is the one "fix" that is always
wrong.
