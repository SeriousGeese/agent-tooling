---
name: ask-review
description: "Walk the beads that are waiting on this person for a decision, the 'asks' inbox. Prints each ask's title, reason, status and a summary, then prompts for a decision per bead: work it now, answer and clear it, defer it, bounce it back to whoever asked, or skip. Use when the user runs /asks, says 'what's waiting on me', 'what did my teammate ask me to look at', 'check my asks/inbox', or when a session-start [asks] banner reports beads waiting."
---

# Ask Review: work the inbox of beads waiting on you

If a `LOCAL.md` exists beside this file, read it too: it holds advice that applies to this
repository only.

An **ask** is a request for a *specific human* to look at a bead and decide something.
Collaborators work async; without this, "can you make the call on this one" lives in a chat
message and is lost by morning.

The mechanism, in full (implemented in `scripts/ask-lib.mjs`, which is the source of truth,
so read it if anything here looks stale):

| Piece | Value |
|---|---|
| People | the `people` handles in `agent-tooling.json` |
| Label | `ask-<person>`, for example `ask-alice` |
| Metadata | `ask_<person>_by`, `ask_<person>_at`, `ask_<person>_reason` |
| Notes | an appended `[ask→alice by bob YYYY-MM-DD] ...` audit line |

Person-prefixed keys mean two people can each have an open ask on the same bead without
clobbering each other.

**`assignee` is NOT used for asks and must never be.** That field belongs to the claim
machinery: `scripts/claim.sh` writes it and `scripts/claim-age.mjs` reads it to detect
collisions. An ask leaves it alone, which is precisely why an ask can sit on a bead somebody
else is actively working.

**The reason is optional.** Sometimes you just want the other person to pick the bead up and
it needs no context. A bead raised with a bare `bd tag <id> ask-<person>` and no metadata is
completely valid: it renders as *"(no reason given, just pick it up)"*. Never treat a missing
reason as an error or nag about it.

## Invocation

```
/asks                 walk everything waiting on me
/asks <bead-id>       just this one
/asks --for <person>  read someone else's inbox (read-only; does not act as them)
```

## Step 1: Read the inbox

```bash
node scripts/ask.mjs list          # add --for <person> to read someone else's
```

That is **one** `bd list --label ask-<person> --all --json -n 0` call (about 0.7s). It
returns closed rows too and drops them in code, which is what makes the inbox mean *any open
state* (`open`, `in_progress`, `blocked`, `deferred`, `pinned`, `hooked`) with no status list
to drift out of sync.

**Deferred beads are the whole point.** `bd ready` hides them, so a bead parked awaiting a
product call is otherwise invisible. Never filter them out here.

If the inbox is empty, say so in one line and stop. Do not go looking for other work unless
asked.

Before deciding anything, sync (`node scripts/bd-dolt-sync.mjs pull`, or `bd dolt pull` where
that helper is not installed) so you are not reasoning about a stale ask. The session-start
banner deliberately skips the pull to keep startup fast, so it can be one sync behind.

## Step 2: Present each ask, one at a time

For each ask, print the block `formatDetail()` produces: id and title, status, priority and
defer date, who asked and how long ago, the reason (or the no-reason line), and a one-line
summary of the bead. Oldest ask first; that ordering is already applied by `parseAsks()`.

Then read enough of the bead to actually be useful: `bd show <id>`, plus the code or PR it
names. **You are helping them decide, not just relaying a title.** If you have a
recommendation, give it in a sentence or two before prompting.

## Step 3: Prompt for the decision

One question per bead (use your harness's multiple-choice prompt where it has one), so each
decision is acted on before moving to the next. Offer:

1. **Work it now**: hand off to your bead workflow skill (claim, worktree, implement, PR).
   Clear the ask as part of that handoff: the bead is no longer waiting on a decision once it
   is being worked.
2. **Answer and clear**: record the decision on the bead, then drop the ask:
   ```bash
   bd note <id> "<the decision, and the reasoning behind it>"
   node scripts/ask.mjs clear <id> <person> "<one-line resolution>"
   ```
   Write the *reasoning*, not just the verdict: the value of an async decision is that the
   next person does not have to re-derive it.
3. **Defer with a note**: not ready to decide, or it depends on something else:
   ```bash
   bd update <id> --defer "<when>" --append-notes "<what it waits on>"
   ```
   **Keep the ask label.** It is still waiting on them; deferring only moves it out of
   `bd ready`, and the inbox surfaces deferred beads on purpose.
4. **Bounce it back**: needs something from the asker first:
   ```bash
   node scripts/ask.mjs clear <id> <person> "Bounced back: <what you need>"
   node scripts/ask.mjs <id> <asker> "<what you need from them>"
   ```
5. **Skip**: leave it entirely untouched, still in the inbox next session.

## Step 4: Close out

After the last bead, print a one-line tally (worked / answered / deferred / bounced /
skipped) and re-sync so the other person sees the outcome immediately:

```bash
node scripts/bd-dolt-sync.mjs push
```

**Check the exit status. It is the only proof the answers reached the remote.**

Use the helper, never a bare `bd dolt pull && bd dolt push`. On a diverged branch
`bd dolt pull` can exit 0 having merged nothing (it prints "Pull complete" and leaves the
branch diverged), after which every push is rejected indefinitely. The helper asks the dolt
CLI for ground truth, retries a rejected push with backoff, and commits pending working-set
writes first.

`scripts/ask.mjs` already runs that verified sequence on every write and **fails loudly** if a
push does not land, so this step is belt-and-braces after any bare `bd` calls you made in
step 3.

If a push fails, the answers are **not lost**: bd committed them locally. They simply have not
published, so the person waiting still sees the bead as unanswered. Retry until the push
succeeds; a non-fast-forward rejection just means another session pushed first, which is
routine with concurrent sessions.

## Raising an ask (the other direction)

```bash
node scripts/ask.mjs <bead-id> <person> "why you need them"
node scripts/ask.mjs <bead-id> <person>            # no reason, just pick it up
```

Refuses closed beads, and refuses to silently overwrite an ask that person already has on the
bead (pass `--replace` when you mean to).

Reach for an ask when a bead genuinely needs *that specific human*: a product call, a design
preference, domain knowledge only they have, or sign-off. Do not use it as a general to-do
queue; anything an agent can just do should be claimed and done, not asked about.
