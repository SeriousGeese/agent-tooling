---
name: recurring-task
description: "Create and maintain a self-perpetuating recurring bead in the `bd` tracker, define what needs to be done (a skill to run, or literal steps), how often, and let each occurrence spawn its own successor when it's claimed or closed. Use when the user asks to set up a recurring/periodic/weekly/monthly/quarterly task, chore, patrol, or audit, or to convert an existing one-off bead into a recurring cadence."
---

# Recurring Task Skill

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its existing recurring beads and their variants) and overrides the generic defaults here. This
file reads correctly without one.

A generic pattern for periodic work in this tracker: one bead per occurrence
(not one eternal bead that never closes). Each occurrence is a normal,
closeable bead, claimable, verifiable, carries its own run's findings/notes,
and its own description contains the exact, mechanical instructions for
spawning the next occurrence. That keeps the cadence self-documenting even
years later, when whoever closes it has never read this skill file.

This is the general form of a pattern that was first established informally (a monthly
test-coverage audit). Prefer this skill for any NEW recurring task; a recurring bead that uses
the older "never close, re-defer in place" variant should be left as-is unless the user asks to
migrate it (see **Migrating an existing recurring bead** below).

## Invocation

```
Use the recurring-task skill to set up <task> every <cadence>.
Use the recurring-task skill.
```

## Step 1: Gather the task definition

If the invocation doesn't already specify these, ask (one `AskUserQuestion`
covering what's missing, don't ask about fields already given):

1. **What needs to be done**, one of:
   - A skill reference: `.agents/skills/<name>/SKILL.md` (preferred whenever
     a skill already exists for the work, keeps the instance bead a thin
     scheduler/ledger).
   - Literal steps, when there's no skill yet, write them directly into
     the instance description. (If the steps are substantial enough to be
     reused on their own, consider writing a dedicated skill first instead.)
2. **Cadence**, normalize to a `bd --defer`-compatible relative offset:
   weekly → `+7d` (or `+1w`), biweekly → `+14d`, monthly → `+1 month`,
   quarterly → `+3 months`. Confirm the exact string with the user if their
   phrasing is ambiguous ("every couple weeks").
3. **Priority** (default P2), **labels** (always include `recurring` plus a
   short task-slug label, e.g. `beads-hygiene`), and an optional **parent
   epic** to file each run's findings/output under.
4. **Spawn trigger**, when should the next occurrence be created: on
   **close** of the current one (default, safest, one-shot, no risk of
   double-spawning), or on **claim** (pre-stages the next occurrence as soon
   as work starts on this one, useful for long-running audits where you want
   the next slot visible without waiting for this run to finish). State the
   choice explicitly in the instance description so it isn't ambiguous later.

## Step 2: Create the first occurrence

```bash
bd dolt pull

FIRST_ID=$(bd create "<Title> - $(date +%Y-%m-%d)" \
  --type task -p <priority> \
  --defer "<first-due-offset-or-date>" \
  --labels "recurring,<task-slug>" \
  --metadata '{"recurring":"true","recurring_interval":"<offset, e.g. +7d>","recurring_task_ref":"<skill path or short slug>","recurring_priority":"<priority>","recurring_labels":"recurring,<task-slug>","recurring_parent":"<parent epic id or empty>","recurring_spawn_on":"close"}' \
  --description "$(cat <<'EOF'
# <Title> (RECURRING)

## What this run does
<Either:> Read `.agents/skills/<name>/SKILL.md` and execute that workflow now, this bead is just the scheduler + ledger.
<Or, if no skill exists yet:> <literal steps>

## Completion protocol (IMPORTANT: read this before closing)
This is a recurring task. Closing this bead must spawn its successor,
do NOT let the cadence silently die here.

1. Read this bead's own metadata: `bd show --json <this-id>`.
2. Create the next occurrence using the exact fields from that metadata:
   ```
   bd create "<Title> - <today>" --type task -p <recurring_priority> \
     --defer "<recurring_interval>" --labels "<recurring_labels>" \
     --parent "<recurring_parent, if set>" \
     --metadata '<copy this bead'"'"'s metadata JSON verbatim>' \
     --description "<copy this bead's description verbatim, replacing the
     date stamp and the 'Follows' line below>"
   ```
   Prepend a one-line pointer to the new instance's description:
   `Follows <this-bead-id>; see its notes/close-reason for the previous run's findings.`
3. Close THIS bead: `bd close <this-id> --reason "Run complete. <one-line
   summary of what the run found/did>. Next occurrence: <new-id>."`
4. `bd dolt pull && bd dolt push` (clobber-safe, pull immediately before
   every push).

To retire this cadence instead of continuing it: close this bead with a
reason that says so explicitly (e.g. "Recurring cadence retired, <why>")
and do NOT create a successor.
EOF
)" \
  --silent)
echo "First occurrence: $FIRST_ID"

bd dolt pull && bd dolt push
```

Report the new bead ID back to the user.

## Step 3: Executing an occurrence when it comes due

Whoever picks this up when it surfaces in `bd ready` (a human, or an agent
doing routine backlog/session-start triage):

1. `bd dolt pull`, then `bd show <id>` to read the "What this run does"
   section.
2. If it points at a skill, invoke that skill now. If it has literal steps,
   follow them.
3. File any findings as their own beads (parented under `recurring_parent`
   if one is set), not crammed into this bead's own description.
4. Follow the "Completion protocol" section verbatim (see Step 2 above),
   spawn the successor, close this one, sync Dolt.

If the spawn trigger is **claim** rather than close (per Step 1.4), spawn
the successor immediately after claiming, before starting the actual work,
same mechanics, just moved earlier.

## Migrating an existing recurring bead

To convert an old "never close, re-defer in place" bead onto this pattern: on its next due run, execute it as normal, then instead
of re-deferring in place, close it with a reason pointing at a freshly
created first-occurrence bead (Step 2 above), and stop before the old
bead's "do NOT close" instruction, note in the close reason that the
cadence moved to the new per-occurrence pattern. Only do this if the user
asks for it; don't migrate an old-pattern bead unprompted.

## Constraints

- One bead per occurrence. Never let a "recurring" bead accumulate an
  unbounded notes history in place, that's the older pattern this skill
  supersedes.
- The instance description is the source of truth for its own successor,
  don't rely on this skill file being re-read every time; the mechanical
  `bd create` command must already be sitting in the bead itself.
- Always clobber-safe sync (`bd dolt pull` immediately before every
  `bd dolt push`).
- Don't invent a GitHub Actions cron or a `CronCreate` session job for
  this, `CronCreate` jobs are session-scoped and auto-expire after 7 days,
  wrong fit for a durable weekly/monthly cadence. The `bd defer` + `bd
  ready` visibility gate is the durable mechanism this tracker offers; a
  human or agent picking up `bd ready` periodically is what actually
  executes it.

## Example requests

- `Use the recurring-task skill to set up the beads-hygiene skill weekly.`
- `Use the recurring-task skill, I want a quarterly dependency-license audit, no existing skill for it yet, here are the steps: ...`
