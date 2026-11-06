---
name: bead-chains
description: Find blocker chains in the tracker (one bead unblocks the next) that can land as ONE PR, offer the best three or four, then claim the pick. Use when the user runs /beadChains or asks which beads can be done together in one PR.
---

# Skill: bead-chains

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics and
overrides the generic defaults here. This file reads correctly without one.

Find blocker chains in the tracker, offer the best three or four, and land the chosen chain as
**one PR**. Invoked as `/beadChains [notes]`; `/promptNextWork` also offers a chain as a batch
(its §1a).

## Why this exists

A chain is a root bead with no open blocker whose completion unblocks one or more beads, which
unblock others. Worked one bead per PR, a four-bead chain costs four PRs, four reviews, four
queue passes and three waits for a merge before the next branch can start. A `blocks` edge says
only "do this first", not "merge this first". With a merge queue in front of `main`, one larger PR
is cheaper than a serialized run of small ones. So a chain is one PR unless something in it
genuinely needs time between steps.

This is what "one child (or one tightly compatible slice) per branch and PR" means for a chain:
the slice is everything up to the first break.

## 1. Find the chains

```bash
node scripts/bd-dolt-sync.mjs pull
node scripts/bead-chains.mjs                      # ranked, top 10
node scripts/bead-chains.mjs --all --limit 30     # include chains a break cuts to one bead
node scripts/bead-chains.mjs --json               # for a script
```

A bead labelled `repo:<other>` counts as an `other-repo` break. This repository's label is `--repo-label`
(a bare name is fine), else `AGENT_TOOLING_REPO_LABEL`, else `repo:<origin basename>`, else the lower-cased
bead prefix; if none can be derived, every `repo:*` label is a break and a note says so.

**To check the script's output by hand,** `bd list --format dot`
prints the dependency edges (the only output that carries the edge type; read only `blocks`
edges, never parent-child or `related`, and ignore edges to or from an epic). Take each open bead
with no open blocker as a root, walk the beads it unblocks level by level, and cut the walk at
the first bead that has a reason from the table below. Everything up to the cut is the PR set.
Rank roots by how many beads land in their PR set, and keep the top three or four.

For each chain the script gives the beads that can land in **one PR**, indented by dependency
level, and every other bead in the chain with the reason it is not in that PR:

| Reason | Meaning |
|---|---|
| `human` | labelled `human-required`: a person does it |
| `ask:<who>` | parked on a named human's decision; answering the ask can unblock the chain |
| `deferred` | needs an explicit reason to undefer |
| `claimed:<actor>` | another actor holds it; pass `--actor "$(node scripts/agent-actor-id.mjs)"` to count your own claims as free |
| `other-repo` | the work lives in another repository, so it cannot share the PR |
| `waits:<id>` | blocked by an open bead outside this chain |
| `after:<id>` | comes after a bead that is itself not in the PR |

Edges come from `bd list --format dot`, the only bd output that carries the dependency type, so
parent-child and `related` links are never read as order. Edges to or from an epic are ignored.

## 2. Judge each candidate: what the script cannot see

The script knows the tracker. Before offering a chain, check what it does not know:

- **Time gaps.** Any one of these splits the chain at that step, and the part after the gap becomes a
  later PR branched from `origin/main` after the first merges (waiting, never stacking):
  - a step that must be verified on a staging or production deploy before the next is built (a
    release-train item, a watch window, a soak);
  - an expand/contract migration whose contract half must wait for the expand to deploy;
  - a step that enables a feature toggle, which needs sign-off of its own;
  - a step whose acceptance criteria name an elapsed time ("after a week of data").
- **Already done.** `git fetch origin` and look for each bead's work on `origin/main`. A chain
  whose root already landed has a different root.
- **Size.** A chain the script puts in one PR can still be too big to review. Above roughly six
  beads, or when the levels touch unrelated areas, split it at a natural seam and say where.
- **Whose work it is.** Some chains belong to a person even when nothing labels them. Leave out
  areas the caller has said are someone else's. `--exclude-label <label>` drops chains whose
  root carries that label.
- **Read the beads.** Concrete acceptance criteria make a chain workable. A chain of one-line
  titles is a research task.

## 3. Offer the choice

Present **three or four** chains with `AskUserQuestion`, the recommendation first and labelled
`(Recommended)`. For each one: the root, the beads in the PR drawn as a small tree, where it
breaks and why, and one line on what it needs. Alongside the question, say in one line what you
left out and why: claimed by a live peer, gated on a human, deferred, or too large. If no chain
has two beads that can land together, say so and stop.

An `ask:<who>` chain is worth offering when that human is the caller, because answering the ask
unblocks the whole chain. Name the questions.

## 4. Claim and land

Once the caller picks:

- **Working it in this session:** claim every bead in the PR set, not just the root
  (`bash scripts/claim.sh <root> feat/<slug>` for the worktree, then
  `bash scripts/claim.sh <id> --claim-only` for the rest), then
  follow `bead-workflow`.
- **Handing it to a fresh session:** run `/promptNextWork` with the chain's ids. It claims them
  and writes the prompt. Copy this section's PR shape into the prompt's "Definition of done".

**The PR shape:**

- One branch from `origin/main`, one PR.
- One commit per bead, in dependency order, each naming its bead. The reviewer can then read
  the PR one step at a time, and a revert can take back a single step.
- `Fixes:` names every bead in the PR set and nothing past a break.
- The body has a short section per bead saying what that step did and how it was verified.
- Run the gates once, at the end, over the whole chain.
- A bead past a break is not mentioned as fixed. When its break clears (the ask is answered, the
  deploy is verified), it starts a new PR from the updated `origin/main`.

If a step turns out bigger than its bead said, stop the PR at the last finished step. Ship that
step, and leave the rest of the chain claimed and noted for the next PR. Do not let one
overgrown step hold every step in front of it.
