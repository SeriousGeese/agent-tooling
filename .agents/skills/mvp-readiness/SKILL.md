---
name: mvp-readiness
description: "Recurring TPM / product-owner grooming pass over the Beads backlog, decide what's ready to hand to an AI session, what's blocked on a human decision, and what can be closed. Use when asked to 'put on your TPM hat', review what's left before a launch milestone, get beads 'ready for AI pickup', or groom the ready/deferred backlog. Read-only planning: no code, no PRs, no fixes."
---

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics and
overrides the generic defaults here. This file reads correctly without one.

# MVP Readiness (TPM grooming pass)

A repeatable product-owner grooming ritual. The product owner runs this roughly weekly and used
to hand-type it every time ("put on your TPM hat… what's ready for the milestone… get them ready
for AI pickup… ask me one at a time"). This skill IS that ritual, follow it, don't reinvent it.

**This is planning, not implementation.** Do not write code, open PRs, claim beads for
yourself, or enable feature toggles. The only mutations allowed are bead grooming (notes,
priority, defer/undefer, close-with-evidence, readiness edits) via the clobber-safe sequence.

## 0. Fresh state first (non-negotiable)

Stale bead state has misled the product owner more than once ("those 4 you listed as still blocking are
all closed"). Before reporting anything:

1. `bd dolt pull`, sync from DoltHub.
2. Audit recent `origin/main` merges and open/merged PRs; reconcile any bead whose work
   already landed (close-with-evidence).
3. Verify every bead you're about to call "blocking" or "open" individually with
   `bd show <id>` against the freshly-pulled DB. Never report from a session-start snapshot.

## 1. Scan the backlog

- `bd ready -n 100` (stale-open work is easier to spot at higher N), plus deferred and
  in-progress. Do not assume `bd ready` is the whole backlog, also `bd list` / `bd search`
  by theme.
- **Split the ready list on the `human-required` label rather than reading every bead to
  work out which is which**, that split is most of what this pass reports:
  `bd ready -n 100 --exclude-label human-required` is the AI-pickup candidate pool, and
  `bd ready -n 100 --label human-required` is work waiting on a person. Unlike the other
  skills this one must never DROP the second list, surfacing it is the job. Treat the label
  as a floor, not a census: an unlabelled bead can still turn out to need a human to DO the
  work (a real rig, an external console, a human identity, a signature), and one you find that
  way should be tagged `bd tag <id> human-required` so the next pass gets it for free. A bead
  that is only **blocked on a decision** (step 2's second class) is NOT `human-required`: an
  agent can finish it once the decision lands, and the label would hide it from the agent queue
  with nothing to remove it. Route it with `ask-<person>` instead (the asks mechanism, see the
  `ask-review` skill).
- Respect concurrency: other sessions and humans may hold claims. Do not touch a bead
  claimed by someone actively working it; note it and move on.

## 2. Classify every open/ready bead into one of

- **Ready for AI pickup**, clear acceptance criteria, no open product decision, unblocked.
  These are the "hand to a fresh session and say go" candidates.
- **Blocked on a human decision**, needs a product call from the product owner before it can be scoped
  (direction, scope, trade-off, priority).
- **Needs grooming**, real work but underspecified; note exactly what's missing.
- **Done-but-open**, work already merged; close with the evidence found in step 0.
- **Deferred-correctly**, leave as is unless the epic prompt authorizes undeferring.
- **An `idea-inbox` bead, if the repository keeps one (see `scripts/idea-inbox.mjs`), is never
  classified or closed here.** Report its open-idea count under "waiting on a person"; the
  people it belongs to triage it through their asks.

## 3. Prompt the human-decision beads: one at a time, with a recommendation

For each "blocked on a human decision" bead, ask the product owner **one question at a time** using the
interactive question UI (in Claude Code, `AskUserQuestion`), and **pre-fill your recommended
answer as the first option**, they have asked for exactly this ("prompt me those questions, I
want to see your recommendation"). Let them skip any they can't answer right now. As answers come in:

- Update the bead with the decision + rationale, adjust priority, and undefer if it's now
  actionable.
- If an answer reveals the bead should split, note the split (don't create the children
  unless asked).

## 4. Reconcile in-progress honesty

Flag any `in_progress` bead that isn't actually being worked right now (parked on a decision,
an external console step, or already merged). Recommend moving it back to `open` (keep
assignee) with a note, or `defer` if it has a natural later start, matching the repo's
"keep in_progress honest" rule. Don't silently reassign others' claims; surface them.

## 5. Report

Return three tight lists plus a headline:

- **Headline:** one line on overall readiness for the target milestone (beta, launch, etc.).
- **Ready for AI pickup:** bead IDs + one-line scope each, the pass-to-a-session list.
- **Blocked on a human decision:** bead IDs + the exact question each waits on (after step 3,
  note which were answered).
- **Closeable / groomed / newly-unblocked:** what changed this pass, with evidence.

## 6. Beads sync discipline

Every mutation batch uses the clobber-safe sequence: `bd dolt pull` → mutate → `bd dolt pull`
→ `bd dolt push`. Search for duplicates before creating any new bead.

## Make it recurring (optional)

This pass pairs naturally with a self-perpetuating recurring bead, see the `recurring-task`
skill. If the product owner wants it on a cadence, create/maintain a recurring bead that re-defers itself
(e.g. weekly) and points at this skill, rather than relying on them to re-type the ask.
