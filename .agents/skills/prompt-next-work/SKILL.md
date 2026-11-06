---
name: prompt-next-work
description: Claim the next batch of beads, then emit the next session's opening prompt, recommending a batch when none is named. Use when the user runs /promptNextWork or asks to hand the next piece of work to a fresh session.
---

# Skill: prompt-next-work

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its serialization constraints, its hatch and window names, its pipeline details) and overrides
the generic defaults here. This file reads correctly without one.

Claim a set of beads for the NEXT session, then write that session's opening prompt.

Invoked as `/promptNextWork [description of what to claim]`. The description is OPTIONAL: with
nothing named, the skill SELECTS a batch (§1a) and offers the caller a choice before claiming
anything. All agents may use it; agents without automatic workspace-skill discovery read this
file and follow it manually.

## Why this exists

A handoff written before the claim is a race. The window between "I described the next batch"
and "the next session actually claimed it" is exactly when another session's `bd ready` picks
the same bead up, a real collision (two sessions, 20 minutes, one bead, one wasted
PR). Claiming FIRST closes that window: by the time the prompt exists, the work is already
spoken for in Dolt and visible to every other agent.

The order is the whole point. **Claim, verify the claim landed, and only then write the
prompt.** If the claim fails, there is no prompt to write.

## The trap this skill must always encode

**The next session CANNOT re-claim these beads, and must not try.**

A claim writes the resolved actor into `issues.assignee`, and this repo gives every
session its own id, `<base>-bot-<session8>` (in Claude Code `<base>-bot-<name>-<session8>`), from `scripts/agent-actor-id.mjs`. A new session
has a new `CLAUDE_CODE_SESSION_ID`, so it has a different actor id, so
`scripts/claim.sh` (its age check, `scripts/claim-age.mjs`) sees a stranger holding a fresh
`in_progress` claim and refuses. Measured 2026-08-29:

```
this session actor : alice-bot-9abefc82
slugifyActorBase('alice-bot-9abefc82') -> alice-bot-9abefc82
slugifyActorBase('Alice Bot')          -> alice-bot
tolerance matches? false
```

The check's bare-base "cutover tolerance" deliberately does NOT collapse the session suffix, so
it does not save a second session belonging to the same human. The block lasts
`AGENT_TOOLING_CLAIM_COLLISION_HOURS` (default 4) and **the block is correct**, do not reach for
`AGENT_TOOLING_ALLOW_CLAIM_STEAL=1` to route around your own handoff.

Consequences the generated prompt MUST state:

- Do NOT run `scripts/claim.sh` or `bd update --claim` on the in-scope beads.
- Create the worktree directly instead: `bash scripts/worktree-new.sh <slug> <branch>`.
  That is the half of `claim.sh` the next session actually needs, and it still publishes the
  branch immediately (the claim must be visible in git at once) and installs deps in the background.
- To make attribution honest, re-point the assignee, **not** with `--claim`:
  `bd update <id> -a "$(node scripts/agent-actor-id.mjs)"`. The age check runs only inside
  `claim.sh`, so a plain `-a` is allowed and is the clean way to take ownership.

## Procedure

### 1. Resolve the request to a concrete bead set

`node scripts/bd-dolt-sync.mjs pull` first, `bd ready` reflects your last pull, not DoltHub.

**Two entry paths, and the second is not the exception it looks like.**

- **The caller named ids, or described what they want**, resolve it here, in this step.
- **The caller named nothing** (a bare `/promptNextWork`, or one carrying only process notes
  like "keep it small"), go to **§1a** and SELECT a batch, then come back to step 2.

Do not treat a bare invocation as an error or a licence to guess. It is the single most likely
way this skill gets typed: the operator who does not already know what should come next is
exactly the operator who wants a handoff written.

Turn the user's description into an explicit list of ids. Prefer a **coherent unit**: beads that
one session can carry end to end, in dependency order, without another session needing to touch
the same files. Where the repo requires serialization (work on a single shared catalog file is the
standing example: three parallel branches collided in it, and merging them concurrently would
have turned a drift guardrail red post-merge), a batch is a chain for ONE session, not
a fan-out.

**"A chain" means waiting, NOT stacking.** Spell this out in the handoff you write, every time,
the word alone is ambiguous and the ambiguity has already cost real work. Each PR in a chain
branches from current `origin/main` and merges before the next one is opened. **Never base one PR
on another's branch.** When a base branch merges it is deleted, and GitHub responds by *closing*
every PR that targeted it rather than retargeting them, unrecoverably, since it then refuses both
`gh pr edit --base` and `gh pr reopen`. Once that cost three PR numbers for one bead,
and a `do-not-merge` label did not help: it keeps auto-merge off the child, not the
parent's merge deleting the base underneath it.

If a PR genuinely must not merge before another, do not open it ready until the other has merged,
then branch it from the updated `origin/main`. There is no `Depends-on:` line; nothing reads one. That is how you serialize without stacking.

**A blocker chain is usually ONE PR, not a serialized run.** A `blocks` edge only says "do this
first". Unless a step needs time in between, every bead up to the chain's first break goes in one
branch and one PR (`.agents/skills/bead-chains/SKILL.md`). Breaks include a human
step, an open ask, a stage or prod check, or an expand/contract migration. Waiting-not-stacking
applies only across a break. The handoff says which shape it is: one PR, or which step starts
the next PR.

Show the resolved list and say what it excludes and why. If the description is genuinely
ambiguous between materially different sets, ask before claiming, a wrong claim is worse than
a slow one.

### 1a. Selection mode: when the caller named nothing

The output of this step is a chosen bead set, which then re-enters step 2 unchanged. **Claim
nothing until the caller picks** (or until the non-interactive rule below fires).

#### The filter that matters: is this bead executable by an agent at all?

Ranking `bd ready` by priority and taking the top is the obvious implementation and it is
wrong. Measured on one real repository: of the first ~20 rows of `bd ready -n 60`, the
MAJORITY were work no agent can finish, payment-dashboard configuration, an identity-provider
migration, mail send-as aliases, social-account brand presence, product-owner
sign-offs, legal/IP review. Those carry P0 and P1, so they sort to the very top, and a naive
recommender proposes them every single time.

Classify each ready bead before ranking anything:

- **Not agent-executable**, its acceptance criteria complete in an external console (a payment
  provider, an identity or mail provider, GitHub org settings, DNS, a social account), or require a human identity,
  judgement or signature: sign-offs, a person's-name prefix in the title, `ask-*` labels, legal review,
  recruitment and outreach, anything whose AC is "decide X". Excluded, but SAY SO.
- **Agent-executable**, a concrete change to code, tests, docs or config in this repo, whose
  acceptance criteria can be verified by running something here.
- **Ambiguous**, reads executable but hinges on a product call nobody has made. Treat as
  excluded and name the decision it is waiting on; do not quietly assume the answer.

**Two labels do this classification for you, and they are cheaper and more reliable than
reading every bead.** `human-required` means the bead is not agent-executable at all, filter
it out at the query, `bd ready -n 60 --exclude-label human-required`, rather than classifying
it by hand row by row. An `ask-*` label is a strong exclusion signal for a different reason:
that bead is parked on a NAMED human awaiting a decision.

Neither label replaces the judgement above, an unlabelled bead can still be external-console
work, which is what the four categories are for. But a labelled one needs no judgement, and the
`--exclude-label` form means it never reaches your ranking at all. See the repository's rulebook
section on the beads issue tracker for the label's contract.

#### Then, before proposing anything

- **Run the concurrent-actor sweep**, unclaimed does NOT mean nobody is working. Follow
  `.agents/skills/beads-bulk/SKILL.md` §2; it is not restated here.
- **Audit each candidate against `origin/main`.** A bead can be open yet already done. Filing a
  handoff for finished work wastes a whole session.
- **Read the bead, not just its title.** Concrete acceptance criteria are what make a bead
  handoff-able; a one-line title with no AC is a research task in disguise.

#### Rank what survives

Priority is the tie-breaker, not the sort key. Prefer, in order:

1. A **coherent batch** one session can carry end to end over a lone higher-priority orphan,
   the handoff's value is a session's worth of work, not a single bead.
2. Beads that **unblock other beads** (`bd show` dependents) over leaf work of equal priority.
3. Beads with **concrete, verifiable AC** over vague ones.
4. Then priority, then age.

**Blocker chains are first-class candidates.** Run `node scripts/bead-chains.mjs` alongside
`bd ready`. It ranks roots whose completion unblocks a run of other beads, and prints for each
one which beads can land in one PR and why the rest cannot. Judge its top chains by
`.agents/skills/bead-chains/SKILL.md` §2: time gaps, work already on main, size, and whose
work it is. Offer the best surviving chain as one of the candidate batches. It usually beats an
unrelated pair of ready beads, because one PR clears several beads and opens the next ones.

Respect the same serialization constraints step 1 names: where the repo requires one session
(a single shared catalog file is the standing example), a batch is a chain, never a fan-out, and a
chain means each PR branches from `origin/main` and waits for the previous to MERGE, never that
one PR is based on another's branch. Say that explicitly in the handoff: wait for the merge, then
branch from `main`.

#### Offer the choice

Present **2-4 materially different** candidate batches with `AskUserQuestion`, the
recommendation FIRST and labelled `(Recommended)`. Materially different means different areas or
different shapes of work, not three slices of the same epic. For each: the bead ids, one line
on what it actually needs, and why it is a good next batch. Alongside the question, state in one
line what you excluded and why ("6 higher-priority beads are human-only: Stripe Dashboard,
Workspace migration, …"), so the caller can override you with full information.

If NOTHING survives the filter, say that plainly and stop. Do not lower the bar to have
something to offer, "there is no agent-executable ready work; the top of the queue is N
human-only beads" is a genuinely useful answer, and the honest one.

#### When asking is impossible

If the caller passed `--auto`, or the run is non-interactive, take the top recommendation
instead of stalling, and make it **loud** in both places it matters: in your reply, and in the
prompt file's "Context you need that is not in the repo" section. The next session must know the
batch was auto-selected rather than requested, because that changes how much it should trust the
framing it inherited.

Record the selection rationale in the prompt file either way: which batch, why it beat the
alternatives, and what was excluded. A future reader cannot reconstruct it from the tracker.

### 2. Verify every bead is claimable

For each id, `bd show <id> --json` and check:

- `status` is not `closed`.
- `assignee` is empty, or the claim is genuinely stale. The text view is not good enough here:
  its `Owner:` line is the bead's CREATOR, not the claim holder, and its `Started:` is a DATE
  ONLY, which cannot tell a 17-minute-old claim from a 17-hour-old one.
- A `deferred` bead needs an explicit reason to undefer. Say so rather than doing it silently.
- An `open` bead carrying a stale assignee must have that assignee cleared before claiming, or
  `--claim` refuses it: `bd update <id> --status open -a ""`.

### 3. Claim, using the clobber-safe sequence

```bash
bash scripts/claim.sh <id> --claim-only   # per bead: verified pull, age check, claim, push
node scripts/bd-dolt-sync.mjs pull
bd show <ids> --json    # VERIFY assignee actually landed on every one
```

Push in a small batch and verify the field, never trust the `✓ Updated issue` line, which
prints on a write a concurrent session is about to overwrite, and never let a pull run with
unpushed mutations (an aborted merge discards them silently, with no trace in `dolt log`).

Add a `bd note` on each claimed bead saying it was claimed for a handoff, naming the actor id
and the prompt path, so a human auditing the tracker can see why it is held by a session that
is no longer running.

**If any claim fails, stop.** Report which ones landed, release them (`bd update <id> --status
open -a ""`), and do not write a prompt.

### 4. Write the prompt

Default output is a FILE, at `.handoffs/<yyyymmdd-hhmmss>-<slug>.md` in the primary checkout
(`.handoffs/` is gitignored). A file rather than a code block because the path survives `/clear`
and a long prompt survives copy-paste intact.

Not the session scratchpad. The next session *can* read an absolute scratchpad path if you hand
it one, the problem is not readability. It is that a scratchpad is scoped and named for the
session that created it, so the location is neither predictable nor discoverable by anyone who
was not handed the path, and it is scratch: subject to cleanup, with no reason to outlive the
session. A handoff has to outlive precisely that session. `.handoffs/` is a stable, repo-scoped
place a human or a later agent can find on their own.

Note the file's ABSOLUTE path as you write it, step 6 hands it over verbatim as
`Use <absolute path> as your prompt`, and a repo-relative path only works if the next session
happens to start in the primary checkout.

Emit a fenced code block INSTEAD only when the user asks for one (`--codeblock`, "give me the
text", "paste it here"). When they ask for both, write the file and echo it, and the hand-off
statement still points at the FILE, because the line is shorter to paste and survives a
scrollback the code block does not.

Use the template below. Every section is required; drop one only when it is genuinely empty,
and say so rather than omitting it silently.

### 5. Land the plane: the gate on saying "start a new session"

**Never tell the user to start a new session while something in THIS one would be lost by
clearing it.** A handoff prompt only carries what you wrote into it; everything else in this
session's context evaporates. Anything half-finished and unrecorded is gone, and the next
session cannot even know to look for it.

So before the hand-off statement, run this check and report what it found. Every item must be
LANDED, finished, or written down somewhere durable (a bead, a PR, a file) that the next
session or a human can find without this conversation.

```bash
# 1. Nothing uncommitted or unpushed, in the primary checkout or any worktree you created
git -C <primary> status --short
git worktree list                      # then `git -C <wt> status --short` and check for unpushed commits

# 1b. Every worktree whose PR you opened this session is LANDED, from the primary checkout:
#     waits for the merge and for the `beads-synced` tag to pass it, pulls Dolt, names any
#     Fixes: bead still open (exit 1, worktree kept), otherwise removes the worktree, deletes
#     the local branch and prunes. `--no-wait` only reports (exit 3 while pending).
bash scripts/land.sh <worktree path>            # per worktree, from <primary>

# 2. No PR you opened this session left unwatched.
#    CAVEAT: --author @me is the GitHub ACCOUNT, not this session. Concurrent sessions
#    (and the whole /beadsBulk fleet) share it, so this over-reports: measured 5 open
#    PRs where only 1 was this session's. Cross-reference against the beads YOU claimed;
#    a PR whose Fixes: line names someone else's bead is not yours to land.
gh pr list --repo <owner>/<repo> --author @me --state open

# 3. The issue DB is genuinely synced: not merely "bd said Pull complete"
node scripts/bd-dolt-sync.mjs status

# 4. The ONLY beads this session holds in_progress are the handoff batch
bd list -a "$(node scripts/agent-actor-id.mjs)" --status in_progress --flat
```

That last query is the sharpest of the four: anything it lists which is NOT in the batch you
just claimed is either work you left unfinished or a claim you forgot to release, and both are
invisible to everyone else.

Also land, because no command will surface them:

- **An in-flight PR**, its merge still needs watching, and its beads still need verifying with
  `bd show <id> --json` afterwards. The close-beads Dolt push has failed silently before, leaving a
  bead `in_progress` after a clean merge. **`bash scripts/land.sh <worktree path>` from the
  primary checkout is the whole of that watch:** it waits for the merge, waits until the
  `beads-synced` tag contains it (the close-beads workflow closes beads on every push), pulls
  Dolt, exits 1 naming any `Fixes:` bead not closed, and otherwise removes the worktree. Run it
  if the wait is acceptable; if not, transfer it (below).
  Put in the prompt the PR number, the worktree path, where it stands
  (`node scripts/pr-queue-state.mjs <pr>`: `queued`, `ejected <reason> <rearmed|unarmed>`,
  `held review|conflict`, `open` or `merged`; never `autoMergeRequest`, which reads null once queued; plus
  `gh pr view <pr> --json mergeStateStatus,reviewDecision`; `gh pr merge --auto <pr>` arms it), and what the next session owes: a merge of `main` if it shows
  CONFLICTING, a fix if the review is CHANGES_REQUESTED or `gate` is red, and then
  `bash scripts/land.sh <worktree path>` from the primary (or `--pr <n>` once the worktree is
  gone), which does the `bd show` verification itself. Re-attribute the claims with `bd update -a`,
  never `--claim` against a live holder. Nothing merges by hand and no PR is special (see the repository's
  CI and deploy rules); only a review a maintainer must dismiss in the GitHub UI needs a person.
- **Any red you saw and did not act on**, a failing test, a lint warning, a flake that passed
  on retry. Fix it or file a bug bead; "pre-existing" is not landed. A failure
  you saw is a failure you own.
- **Decisions the user made in conversation** that are not yet written to a bead, a PR body or a
  doc. This is the most commonly lost item: a product call made in chat and never recorded
  exists only in the context you are about to discard.
- **Deliverables sitting in the session scratchpad** that should live somewhere durable.

If anything is unlanded, the DEFAULT is: **say so, do not give the hand-off line, and land it
first.** Report what is outstanding and what you are doing about it. A premature "start a new
session" is worse than a slow one, it destroys work rather than merely deferring it.

#### Handing the controls over instead, when the user would rather not wait

Waiting on a CI run is not a good reason to hold a session hostage, and the operators may
reasonably want to move now. The outstanding work can be **transferred** to the new session
rather than finished in this one, but only under one condition, and it is the condition that
makes the whole thing safe:

> **Every outstanding item must be written INTO the prompt file before you offer this.** The
> risk of a premature handoff is not that work is unfinished; it is that unfinished work exists
> only in a context about to be discarded. Once it is in the prompt, that risk is gone.

Add an `## Unlanded business you are inheriting` section to the prompt (see the template) and
give each item: what it is, where it lives (PR number, branch, worktree path, bead id), the
exact command to resolve it, and how to verify it actually resolved. "Watch PR #123" is not
enough; "from the primary checkout run `bash scripts/land.sh /abs/path/<repo>-<slug>` and confirm it
exits 0 with `landed: PR #123, beads <bead-id> closed`, because it waits for the batch close and
reads the bead back itself; exit 1 names the bead that did not close" is.

Then, when you reach step 6, put a short note **immediately before** the hand-off line saying
the new session will pick these up, and naming them. Do not bury it and do not omit it, the
user is choosing to carry something, and they should see exactly what.

Two items still cannot be transferred, because the new session has no way to recover them:

- **Uncommitted work in a worktree that nobody has been told about.** Commit and push it, or
  name the worktree path in the prompt. Never leave it implicit.
- **A decision the user made in conversation that is not yet recorded anywhere.** Write it to
  the bead or the prompt first. This is the single most commonly lost item, and clearing the
  session is exactly when it disappears.

Offer this option proactively whenever the check finds something outstanding and the only thing
standing between you and a clean handoff is waiting.

### 6. The hand-off statement: LAST, unmissable, unhedged

This is the step that makes the handoff worth doing at all. Pasting the prompt into the CURRENT
session just continues the context you were trying to shed.

**Ordering is fixed: the request to start a new session is the LAST thing in your reply.**
Nothing follows it, no caveats, no next-steps, no summary, no offer. When a code block was
requested, the code block comes FIRST and the statement comes after it, so the statement is
still what the user reads last.

The statement must:

- Lead with a heading, not a sentence buried in a paragraph.
- Say explicitly that this is **intentional** and is **the action to take now**. A user who has
  just watched you test or build something will otherwise reasonably wonder whether the `/clear`
  was a byproduct rather than a real instruction, that exact confusion happened on this skill's
  first run.
- **Give a paste-ready LINE, not a bare path.** The line is exactly:

  ```
  Use <absolute path to the .handoffs file> as your prompt
  ```

  On its own line, in its own single-line fenced block so the terminal offers a clean copy, with
  an ABSOLUTE path and nothing else on the line. A bare path pasted into a fresh session is an
  ambiguous message, the new session has to guess whether it is being asked to read it, open it,
  or act on it. This line is an instruction it can execute directly, which makes the whole
  handoff a copy → paste → run loop with no editing in between.
- State the two steps in order: `/clear` (or `/new`) FIRST, then paste that line.

The only case with no such line is a code-block-ONLY run (`--codeblock` with no file written),
there the thing to paste is the block itself, so say that instead. Any run that produced a file
gets the line, including a both-file-and-block run.

**Do not hedge it.** No "if you'd rather", no "when you're ready", no offering to continue in
the current session as an equally good alternative. You already made that judgement when you
claimed the batch for a handoff; re-opening it at the final step invites the user to undo it by
default. If continuing here were genuinely better, you should not have claimed the batch.

The one thing that DOES override this: step 5. If the plane is not landed and the outstanding
work has NOT been written into the prompt, there is no hand-off statement at all, not a hedged
one. If it HAS been written in, give the hand-off normally, preceded by the short note naming
what the new session is picking up.

#### Ring the bell: the hand-off is a human action, so it fires a notification

A plain reply ends silently. The operator who said "I'll step away and continue from the
handoff" (the usual reason this skill runs) learns the prompt is ready only by coming back to
look, and the batch sits claimed until they do. A multiple-choice question, by contrast, fires
the harness's "Claude needs you" notification (desktop toast or push, depending on the
operator's settings). So the hand-off is delivered THROUGH one, not instead of one
(requested by the operators):

- **Claude Code:** immediately before the final reply, call `AskUserQuestion` with ONE
  question. Its text is the hand-off itself, "Handoff ready. `/clear` first, then paste:
  `Use <absolute path> as your prompt`", and its options are exactly two:
  **"Starting the new session now (Recommended)"** and **"Release the claims, plan changed"**.
  The second option exists because a claimed batch nobody opens is a real cost (see Notes): on
  that answer, release every bead in the batch (`bd update <id> --status open -a ""`, push,
  verify) and say so, and there is no hand-off line. On the first answer, or when the question
  is dismissed, end the reply with the hand-off statement below as usual, the question is the
  bell, the statement is still the last thing the user reads, and the paste line appears in
  both.
- **Any other harness** (no `AskUserQuestion`): `notify-send "Handoff ready"
  "/clear, then: Use <absolute path> as your prompt"` when `notify-send` is on PATH, else a
  terminal bell (`printf '\a'`). Say which one fired. Neither blocks.

The question is NOT the step-5 gate re-opened: if the plane is not landed and not transferred,
there is no question either, because there is nothing to ring about yet.

So the tail of the reply is always one of exactly two shapes (the first one preceded by the
`AskUserQuestion` bell above):

```
[optional code block, if one was requested]

[optional one-paragraph note: "the new session will also pick up X and Y", only when
 unlanded business was transferred into the prompt]

## <heading: start a new session now>
<intentional, unhedged, /clear first then paste>

    Use <absolute path> as your prompt
```

or, when something is unlanded and untransferred:

```
<what is outstanding, what you are doing about it, and that you will say when it is ready>
```

Nothing else follows either shape.

## Prompt template

```markdown
# <short title of the batch>

## Beads in scope: ALREADY CLAIMED, DO NOT RE-CLAIM

<one line per bead: id, title, and one sentence on what it actually needs>

These are claimed in Dolt under actor `<actor-id>` by the session that wrote this prompt.

**Do NOT run `scripts/claim.sh` or `bd update --claim` on them.** A new session has a different
actor id, so `scripts/claim.sh` will refuse you for
`AGENT_TOOLING_CLAIM_COLLISION_HOURS` (default 4), and that refusal is correct, not a bug to route around.
Never set `AGENT_TOOLING_ALLOW_CLAIM_STEAL=1` here.

Instead:
- Worktree: `bash scripts/worktree-new.sh <slug> <branch>` (publishes the branch, installs deps
  in the background; `bash scripts/worktree-new.sh --await <slug>` before any gate).
- Optional, to make attribution honest: `bd update <id> -a "$(node scripts/agent-actor-id.mjs)"`,
a plain `-a`, never `--claim`.

## Context you need that is not in the repo

<what the previous session learned that a fresh read of the code would not tell you: decisions
and who made them, measured facts, approaches already rejected and why, traps hit. Be specific.
This is the section that justifies the handoff existing at all.>

<When the batch came from SELECTION MODE (§1a) rather than from the caller, say so HERE, in
as many words: which batch was chosen, why it beat the alternatives, and what was excluded
as not agent-executable. A session that believes a human picked its work will defend that
framing harder than it should.>

## Structural rules you must follow

<the conventions that will fail CI if broken, guardrail tests, required file pairings,
serialization constraints, canonical skills to read before writing code>

## Hard constraints

<feature toggles that stay off, things that must not be deployed, epic-hygiene rules, anything
the user has explicitly ruled out>

## Unlanded business you are inheriting

<OMIT this section entirely when the previous session landed everything. Include it only when
work was deliberately transferred rather than finished, and then it is the FIRST thing the new
session should deal with, before starting the batch.

One entry per item, each with all four of: what it is; where it lives (PR number, branch,
worktree absolute path, bead id); the exact command to resolve it; and how to VERIFY it actually
resolved. A pointer without a verification step is how a "landed" item silently is not.
For an in-flight PR the command is `bash scripts/land.sh <worktree absolute path>` from the
primary checkout and the verification is its exit 0 `landed:` line.>

## Definition of done

<the gates to run, the PR shape expected, what closes each bead>

## First moves

<the literal first two or three commands, so the session starts without re-deriving them.
The very first command is ALWAYS the start marker (see "One session per handoff" below), with
this prompt's absolute path filled in. When there is an "Unlanded business" section, the next
move starts its watchers in the background (see "Watchers start first" below), before any
worktree or gate.>
```

### One session per handoff

The same prompt file can be pasted into two sessions: a second terminal, a resumed tab, a
paste that went to the wrong window. Both then run the whole batch. On the first run of
"Watchers start first" this cost a duplicated pull, a second set of worktree attempts, four
`bd update` writes on beads the other session was holding, and a second round of writes to put
the assignees back. Each of those `bd` writes queues on the single Dolt lock this machine
shares, so a duplicate session slows every other session, not just itself.

So the generated **First moves** block opens with an atomic start marker beside the prompt
file, before `git pull` and before any `bd` call:

```bash
( set -C; echo "$(node scripts/agent-actor-id.mjs) $(date -u +%FT%TZ)" > "<abs prompt path>.started" ) 2>/dev/null \
  && echo "handoff is yours" \
  || echo "ALREADY STARTED by $(cat "<abs prompt path>.started"), stop and tell the user"
```

`set -C` (noclobber) makes the redirect an exclusive create, so when two sessions race exactly
one wins. The check is local and never touches Dolt.

- **On `ALREADY STARTED`, stop.** Make no `bd` write, create no worktree and start no watcher.
  Tell the user which actor holds the handoff and when it started, and let them decide.
- **`.handoffs/` is gitignored and local**, so the marker only covers sessions on the same
  machine. That is the case that happens, because the prompt is a local file.
- **Delete the marker yourself only if you stop before doing anything**, for example when the
  user says to release the claims. A marker left by a session that did some of the work is the
  record that it did.

### Watchers start first

A `land.sh` watch is 15 to 90 minutes of waiting with nothing to decide, which makes it the ideal
thing to start at the beginning and read at the end. A prompt that only says "run these in the
background" leaves the session to get round to it after it has set up worktrees, so the wait
starts late. When the prompt has an "Unlanded business" section, its **First moves** block
therefore opens with the watcher launch, written out literally, one log per PR in the new
session's scratchpad:

```bash
# Inherited watchers, started first and read last. Skip a path a previous watcher still holds.
for wt in /abs/<repo>-<slug-a> /abs/<repo>-<slug-b>; do
  pgrep -f "land.sh $wt" >/dev/null && { echo "already watched: $wt"; continue; }
  bash scripts/land.sh "$wt" --timeout 300 > "<scratchpad>/land-$(basename "$wt").log" 2>&1 &
done
```

The new session runs that as one background command and goes straight on to the batch; the
harness wakes it when the watch ends, by which point it is usually done.

- **Check `pgrep` before starting a watcher.** `land.sh` has no lock, and a `/clear` does not
  kill the previous session's background jobs, so the writer's own `land.sh` is often still
  running on the same path. Two runs race on `worktree-rm.sh` and the loser exits non-zero on
  a PR that landed fine. When one is already running, wait on its pid instead
  (`while kill -0 <pid>; do sleep 60; done`) and read its log, which is in the writer's
  scratchpad: put that log path in the prompt.
- **The new session owns the result, even if it did not start the watch.** A watcher the
  cleared session started reports to a context nobody reads, so its exit is lost unless the
  new session reads it back and does the `bd show` check.
- **Pass `--timeout 300`.** `land.sh`'s 90-minute default is too short for a watch nobody is
  waiting on. Once the merge queue was more than 20 PRs deep, and all four watchers in
  one handoff hit exit 4 while their PRs were still `QUEUED` with
  every check green. A longer cap costs nothing, because the watcher makes one request per 5-minute tick. The
  cap no longer runs while the PR is queued, but it still covers a slow CI wait.
- **Name what each exit means** in the prompt: 0 with `landed:` is done; 1 names a bead that did
  not close; 4 is the timeout, which never fires while the PR is queued (land.sh restarts its cap
  then) but can after an ejection, while CI is still pending, or on a slow close; 5 is
  ejected and unarmed; 6 is held by a blocking review or a conflict, a fix or a merge of `main`
  the next session owes. On 4,
  check the queue before acting: re-arming auto-merge on a PR that is already queued does nothing,
  and pushing to it drops it out of the queue.

## Notes

- The skill claims; it does not implement. Do not start the work in the current session after
  running it, that defeats the point and leaves two sessions on one batch.
- If the user runs this and then never opens the new session, the beads sit claimed. That is a
  real cost: mention it, and release them if the plan changes.
- **Selection mode does not lower the claiming bar.** A batch you chose yourself still goes
  through steps 2-3 unchanged, and a failed claim still stops the whole thing. Choosing the
  work does not entitle you to it, another session may have taken it between your survey and
  your claim, which is precisely why the sweep is re-run rather than trusted once.
- Keep the generated prompt self-contained. The next session cannot see this conversation, so
  "as we discussed above" is worthless to it.
