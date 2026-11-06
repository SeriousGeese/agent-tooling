---
name: beads-hygiene
description: "Periodic issue-tracker hygiene pass for a repository's `bd` tracker. Reconciles epics kept open only by deferred children, normalizes inconsistent deferred-status marking, audits every genuinely open bead against current coding standards/terminology/already-closed work, splits overly-complex beads, backfills missing template sections, checks in-progress claims are honest, audits feature-toggle beadRef/cleanup-bead pairing, and checks dependency-graph sanity. Use when the user asks to 'clean up beads', 'do issue hygiene', 'audit open beads', or similar."
---

# Beads Hygiene Skill

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its standards documents, its terminology table, its feature-toggle registry) and overrides the
generic defaults here. This file reads correctly without one.

An eight-phase pass over the `bd` issue tracker: (1) untangle epics whose
only remaining life is deferred children, (2) normalize inconsistent
deferred marking, (3) audit every truly-open bead against current standards
and already-closed work, (4) split beads that bundle multiple
independently-shippable pieces of work, (5) check in-progress claims are
still honest, (6) backfill missing required template sections, (7) audit
feature-toggle beadRef / cleanup-bead pairing, (8) check dependency-graph
sanity. Read-only analysis happens first in phases that fan out to
subagents; nothing is mutated until findings are collected, so a run can be
interrupted between phases without leaving anything half-done.

This skill only touches `bd` state (titles, descriptions, status, parent
links, notes). It does not write code. If an audit finding implies a real
code change (not just a bead correction), file or update a bead for it and
leave implementation to `bead-workflow` / `/bead`.

## Invocation

```
Use the beads-hygiene skill.
Use the beads-hygiene skill, focus on <area>.
```

No required arguments. An optional focus area (an epic ID, a keyword, "just
phase 1", etc.) narrows scope, apply it to every phase below.

---

## Step 0: Sync

```bash
git pull origin main
bd dolt pull
```

Always `bd dolt pull` again immediately before any `bd dolt push` later in
this skill (clobber-safe sequence, see the rulebook's session-start section).

### Safety: a real near-miss, guard against it every time

`bd update` and `bd close` fall back to "the last touched issue" when given
no ID, and "last touched" is **not scoped to this session**. In a shared
multi-agent repo, a concurrent agent's `bd show`/`bd update` on some
unrelated bead can become "last touched" between your commands. A capture
like `ID=$(bd create ...)` whose `bd create` fails (e.g. an invalid `--defer`
format) leaves `$ID` empty, and a subsequent `bd update "$ID" --status
deferred` then silently retargets whatever any other agent most recently
touched, anywhere in the tracker. This happened during this skill's own
authoring session: a bad `--defer` value on a `bd create` left the ID
variable empty, and the follow-up `bd update` silently flipped an unrelated
P0 bug's status. It was caught only because the accidental target happened
to already be in that exact state. **Always guard**: `if [ -z "$ID" ]; then
echo "FATAL: create failed" >&2; else bd update "$ID" ...; fi`, never let
an empty capture reach a mutating command.

---

## Phase 1: Epics kept open only by deferred children

**Goal:** an epic should read as "genuinely still open" only when it has real
(non-deferred, non-closed) work left. Deferred filler shouldn't keep an
active epic looking busier than it is, and an epic with nothing but deferred
scraps left shouldn't linger open.

1. List every non-closed epic: `bd list --type epic -n 500`. Note which are
   already `❄ deferred` (status) as a whole, leave those alone entirely if
   ALL their children are also deferred/closed; that's a consistent,
   intentional state (a whole initiative on ice), not a hygiene problem.
2. For every **open** (○) epic, run `bd children <epic-id>` and classify its
   non-closed children into: genuinely open/in-progress vs. deferred.
3. **Do not hand-roll the eviction, run the script.** `scripts/epic-hygiene.mjs`
   implements the repository's epic and bead hygiene rules deterministically, and
   its planning logic is unit-tested:

   ```bash
   node scripts/epic-hygiene.mjs audit         # read-only, whole tracker
   node scripts/epic-hygiene.mjs epic <id>     # plan one epic's close
   node scripts/epic-hygiene.mjs epic <id> --apply
   ```

   It plans, in order: create the new deferred epic (2+ children) or nothing
   (single child), reparent, backfill any missing defer date, append the
   cross-link notes to BOTH sides, then close the origin epic. `epic <id>`
   exits **1** and plans nothing when a non-deferred child is still live,
   that epic is not done and must not close.

4. **What the rules are** (the script encodes these; know them so you can check
   its plan):
   - One deferred child → moves out standalone. Two or more → one new deferred
     epic, `status: deferred` AND dated with the earliest child's date.
   - The move target is the **nearest non-closed ancestor**, or top level.
     **Never the closing epic itself**, this skill previously said `--parent
     <original-epic-id>`, which left the origin holding a non-closed child and
     reproduced the problem one level down. That was wrong; it is fixed.
   - Reparenting does not change a child's ID, so the ID keeps naming its
     origin epic. That is the provenance link, don't try to "restore" it.
   - Cross-link both directions, always. A new epic also gets a bidirectional
     `relates-to` edge to its origin so the link survives outside the
     description prose; a single evicted bead does not need one.
   - `--split-standalone` overrides the 2+ grouping when the deferred beads
     share a parent but nothing else.

5. **Epic with a MIX of real open work and deferred children:** the epic
   correctly stays open, and `epic <id>` will refuse it. Leave it alone, the
   deferred children are not hurting anything while real work continues, and
   splitting them out early just fragments the epic. Evict at close time.

6. Verify with `node scripts/epic-hygiene.mjs audit` afterwards rather than
   eyeballing `bd list --type epic`: the audit walks real `parent-child` edges,
   so it catches nested non-epic-typed parents (a bead can be a de-facto
   mini-epic, with children, without `type: epic`).

---

## Phase 2: Normalize inconsistent deferred marking

This tracker has two different ways an issue ends up hidden from `bd ready`:
(a) `status: deferred` (❄, shown explicitly in listings), and (b) `status:
open` plus a future `--defer <date>` field (functionally equivalent for `bd
ready` purposes, but displays as a plain open ○ issue everywhere else,
including `bd list --status open`). **Both suppress `bd ready` correctly,
verify this before treating it as a bug** (`bd ready -n 300 | grep <id>`
should be empty for both kinds). The inconsistency is real but cosmetic:
issues that are semantically "parked, don't touch" show up in the "open"
count and clutter any open-issue audit (including Phase 3 below).

**Known repo convention (established by the feature-toggle policy's "Cleanup: remove X
toggle" beads and similar): the majority use hard `status: deferred`.** Normalize the minority
to match:

1. `bd list --status open -n 1000` and scan for beads whose `bd show` output
   has a `Deferred: <date>` line but status `OPEN`, these are the
   inconsistent ones. Common offenders: "Cleanup: remove `<x>` feature
   toggle" beads (per the repository's feature-toggle policy they must stay parked until
   product sign-off, being status `open` contradicts that policy's own
   wording), and any bead whose title literally says `[deferred]` while its
   status doesn't.
2. Also check every open child of an already-deferred epic (from Phase 1's
   epic scan), a deferred epic's children should be deferred too, not
   left open underneath it.
3. For each: `bd update <id> --status deferred`. This preserves the
   existing `Deferred: <date>` field, verify with `bd show <id>` after.
   To set a new date use `bd defer <id> --until <date>`; on bd 1.3 that and
   `--defer` both set status `deferred` too, so no second call is needed.
4. Do not touch beads that are open with NO defer date at all, those are
   plain backlog, not parked work. The exception is a "Cleanup: remove `<x>`
   feature toggle" bead with no sign-off recorded: `bd update <id> --status
   deferred` it, and leave it dateless (see step 5 of Phase 7).

### Then sweep the dates: this is the half that actually recovers work

A hard `status: deferred` bead with no date is hidden from `bd ready` forever,
and bd does **not** auto-surface a deferred bead when its date passes. Both are
handled by the same script:

```bash
node scripts/epic-hygiene.mjs audit          # counts dateless + lists expired
node scripts/epic-hygiene.mjs sweep --apply  # backfill missing dates, surface expired
```

5. **Dateless deferrals** get a default **2-month** runway
   (`--defer-months <n>` to override). Two months is a deliberately arbitrary
   "look at this again soon" horizon, not a product judgement, the point is
   that a dated bead is *sweepable* and a dateless one is not.
6. **Expired deferrals** are flipped back to `status: open`, which is simply
   what the date passing was supposed to mean. Read the list in the audit
   output before applying: a bead that should stay parked wants a NEW date
   (`bd update <id> --defer <date>`), not a flip to open.

---

## Phase 3: Standards + reconciliation audit of remaining open beads

After Phases 1–2, `bd list --status open -n 1000` should be a much smaller,
genuinely-live set (top-level epics with real work + their real open
children + standalone open beads). Audit every one of them.

### What "current standards" means here: read these first

- The repository's rulebook (`AGENTS.md` or its equivalent), especially its terminology,
  file-naming and layout conventions, shared-component rules, feature-toggle policy, known
  gotchas and migration rules.
- The canonical deprecated-term table, if the repository keeps one. Don't flag identifiers the
  rulebook itself documents as deliberately grandfathered.

### Per-bead checklist

**Skip the `idea-inbox` bead (if the repository keeps one) entirely**, never close, split, dedupe
or rescope it. It holds speculative ideas that only the people it belongs to triage, and a
person closes it.

For each open bead, `bd show <id>` and check:

1. **Terminology**, deprecated term in title/description per the table
   above, in a way that would need fixing if the bead were filed today.
2. **Stale references**, file paths, function names, routes, or line
   numbers cited as implementation pointers that no longer exist because
   of a rename/move (a file-naming reorg, a domain rename, an identifier purge, etc.). Grep to confirm; if moved, note the current
   location.
3. **Coding-standard violations baked into the plan**, the bead's proposed
   implementation would violate a current rule if built literally: a
   hand-rolled primitive instead of the shared kit's, a hardcoded value the
   repository centralizes, a new file that breaks the naming or layout
   convention, a new barrel/index re-export where those are banned, a toggle
   introduced without a paired deferred cleanup child, etc.
4. **Already resolved / contradicted by closed work**, `bd search
   "<keyword>"` for the bead's core topic, plus `git log --oneline -20
   --grep=<keyword>` on relevant files. If a closed bead or merged PR
   already addressed this: fully resolved → close with a reason naming the
   closing bead/PR; partially resolved → update the description to scope
   down to what's left, and note what's already done; contradicted (closed
   work made a different product decision) → update the bead to match the
   decision and cross-link the deciding bead, don't silently drop it.
5. **Duplicates**, within the open set or against a recently-closed bead
   doing the same thing under a different title.

### Fan-out for scale

With more than ~15 open beads to audit, split into batches of ~10–12 and run
parallel **Agent** tool calls (`subagent_type` default/general-purpose is
fine; this is read-only research, not code editing), one per batch, each
given: the bead ID list, the standards files to read first, the checklist
above, and an explicit instruction to report findings only (bead ID,
category, what's wrong, exact recommended fix) and make **no** `bd update`/
`bd close`/file-edit calls itself. Keep bead mutation with the lead agent so
every change can be reviewed against the actual findings before it lands,
and so `bd dolt push` stays a single controlled operation at the end. Do not
reach for the `Workflow` tool for this, it requires explicit user opt-in
this skill does not have by default.

### Applying findings

Only apply a fix once you've verified the finding yourself (re-run the grep
or `bd search` the subagent cites), subagents report what they *tried* to
verify, not ground truth. Then, per finding:

- Terminology / stale reference / coding-standard drift → `bd update <id>
  --description "..."` (or `--title`) with the corrected text. Keep the
  rest of the description intact; this is a correction, not a rewrite.
- Resolved by closed work → `bd close <id>` with a reason naming the
  closing bead ID and PR number.
- Contradicted → update the bead to reflect the current decision, append a
  note cross-linking the deciding bead, keep it open only if real work
  remains.
- Duplicate → close the newer/less-complete one, reason naming the
  survivor; if both have unique scope, keep both but cross-link with a note
  on each explaining the boundary.

---

## Phase 4: Split beads that are too complex for one PR

**Goal:** a bead should be describable in one sentence and shippable as one
PR (or a tight, compatible slice). A bead whose description actually bundles
2+ independently-shippable concerns should become an epic with small,
single-concern children, matching the target granularity already used
elsewhere in this tracker (for example children titled "C1: Server
resolver…", "C3: Authenticated…route").

1. Audit every genuinely-open (post Phase 1–2) non-epic bead: does the
   description actually describe 2+ separable concerns (different
   files/layers/subsystems, a numbered "Part 1 / Part 2" structure, multiple
   distinct acceptance-criteria clusters, a sequence of steps that could
   each be their own PR, or "and also"/"additionally" joining otherwise-
   unrelated changes)? Don't flag borderline cases, a bug fix touching 3
   files for ONE root cause is NOT complex.
2. Fan out to parallel **Agent** calls for batches of ~10–12 (same pattern
   as Phase 3's fan-out), read-only, report a split proposal or "not
   complex" per bead, no `bd` mutations from the subagent.
3. For each confirmed split: `bd update <id> --type epic --append-notes
   "Hygiene (<date>): split into N children, see children for full scope;
   original description retained above for reference."` (never delete the
   original description, it's the split's own source material). Then `bd
   create` each child with `--parent <id>`, a one-sentence-scoped
   description, and `--acceptance` set immediately (feeds Phase 6, don't
   create beads that will just fail lint a moment later). Wire real
   ordering with `bd dep add <blocked-child> --blocked-by <blocking-child>
   --no-cycle-check`, then `bd dep cycles` once at the end of the phase to
   confirm nothing was wired backwards.
4. Weak signal → don't force a split. If only one part is genuinely
   independent engineering work and the rest are product/ops decisions
   blocking it (not code), leave it as one bead with an `--append-notes`
   clarifying the boundary instead of manufacturing decision-only children.
5. Blocked-upstream → don't force a split either. If the decomposition is
   clear but the whole bead is blocked on a deferred prerequisite, note the
   planned decomposition in `--append-notes` for whenever it's picked up;
   don't spin up premature children that will just sit idle.
6. This phase can produce a lot of new beads at once (a prior run created
   67 from 17 parents). Confirm scope with the user before executing at that
   scale if the candidate count is large, report the candidate list first,
   then execute once confirmed.

---

## Phase 5: In-progress honesty

**Goal:** `in_progress` means someone is actively working the bead *right
now* (the repository's epic and bead hygiene rules). Stale claims hide behind `bd ready`
and make it lie by omission.

1. `bd list --status in_progress -n 100 --long`, then `bd show <id>` on each
   to check its `Started:`/`Updated:` timestamps and assignee.
2. **This is a shared, multi-agent repo, most `in_progress` beads belong to
   a concurrently-running session, not to you.** A bead updated within the
   last day or so is presumptively live work by someone else; do not touch
   it. Only flag a claim as stale when it's been untouched for a genuinely
   long window (the rulebook's guidance: parked work "awaiting a product
   decision, an external console step, or a future QA window" that's been
   sitting, not simply "claimed a while ago").
3. For a genuinely stale claim: `bd update <id> --status open` (keep the
   assignee) with an `--append-notes` explaining what it's actually waiting
   on. Never silently unclaim active work, if in doubt, leave it and note
   the uncertainty in the phase summary instead of guessing.

---

## Phase 6: Missing required template sections

**Goal:** every open **and in_progress** bead should pass `bd lint`, bugs
need Steps to Reproduce + Acceptance Criteria, tasks/features need Acceptance
Criteria, epics need Success Criteria. A bead without these is hard to verify
or close correctly.

1. `bd lint` **AND** `bd lint --status in_progress` (add `--json` to either
   for a structured list). `bd lint` alone defaults to `--status open`, so an
   entire status class goes unlinted, and `in_progress` is the *worst* class
   to skip: an in_progress bead is about to be closed by an active session, so
   a missing Acceptance Criteria is missing exactly when someone is deciding
   whether the work is done (the 2026-08-23 run found 5 such warnings that a
   plain `bd lint` hid; four of those beads were closed within ~15
   minutes). Do **not** widen to `--status all` instead, that pulls in ~3.3k
   closed beads. Check the scale before committing to a full manual pass, most
   findings are usually beads created earlier in the *same* hygiene run
   (Phase 1 splits, Phase 4 splits), which you already have full context on
   and can backfill quickly without re-reading each one.
2. **Acceptance/Success Criteria** has a dedicated structured field: `bd
   update <id> --acceptance "<criteria>"`, this satisfies both the
   task/feature/bug "Acceptance Criteria" heading AND the epic "Success
   Criteria" heading (same field, type-dependent rendering). Write 2–4
   concrete, testable bullets, not boilerplate ("works correctly") but
   specific observable outcomes.
3. **Steps to Reproduce** (bugs only) has NO dedicated field, it must be a
   literal `## Steps to Reproduce` heading inside the description text.
   Fetch the current description (`bd show --json <id>`), append the
   section, and write back via `bd update <id> --body-file <tmpfile>` (a
   temp file, not `--description` inline, for anything with newlines/quotes,
safer than shell-escaping a multi-line string). Never use
   `--description` to append, it *replaces* the whole field.

   **Write-surface rule, this is why linting in_progress is not a one-line
   change:** the two backfills have opposite safety on an
   *actively-claimed* bead. `--acceptance` (Step 2) is a narrow single-column
   write and is **safe** to apply on a bead a peer session is holding.
   A `## Steps to Reproduce` append is **whole-column description replacement**,
the exact shape that once lost four beads' text when a concurrent
   session's write clobbered it. So: backfill `--acceptance` on live claims
   freely; do **NOT** append Steps to Reproduce to an actively-claimed bead,
   **report it and leave it** for the claiming session (or backfill once the
   claim clears). Description-body appends (this step and Step 4) are only for
   beads nobody is actively holding.
4. **Decision-type** beads need `## Rationale` and `## Alternatives
   Considered`, also no dedicated flag, same body-file append technique.
   For a decision bead that poses a question rather than recording an
   already-made choice, frame Rationale as "why this needs to be a formal
   decision" and Alternatives as the open design axes to be decided among.
5. Re-run **both** `bd lint` and `bd lint --status in_progress` after the
   pass before declaring Phase 6 clean, zero warnings across open issues, and
   for in_progress only the Steps-to-Reproduce appends deliberately left on
   actively-claimed beads (Step 3) may remain, each reported rather than
   applied. Sync (`bd dolt pull && bd dolt push`).

---

## Phase 7: Feature-toggle beadRef / cleanup-bead audit

**Goal:** every toggle in the repository's feature-toggle registry (skip this phase if the repository has none;
an overlay may say where it is) has a `beadRef` that resolves to a real bead, and, per
the repository's feature-toggle policy, a paired cleanup bead ("Cleanup: remove `<name>` feature
toggle") somewhere in the tracker, deferred until product sign-off.

1. Extract every `{name, beadRef}` pair from the registry (a small Python regex over the
   file is faster than reading 30+ entries by hand).
2. For each `beadRef`: confirm `bd show <beadRef>` resolves to a real issue
   (a truly dangling beadRef is a real bug, one audit documented exactly
   this after a tracker data-loss event, though a later re-audit found it had
   since self-healed via `bd dolt pull` recovery, don't assume it's still
   broken, but don't assume it's fixed either; re-check).
3. For the cleanup bead: **don't rely on `--parent <beadRef>`**, cleanup
   beads aren't always parented directly under the beadRef ID (some sit
   under the toggle's broader feature epic, some are standalone). Use `bd
   search "<toggle-name>"` and grep the results for "cleanup"/"remove...
   toggle" instead of a strict parent-child check, or you'll get false
   negatives.
4. A missing cleanup bead is only a real gap for a **staged rollout**
   toggle (created OFF, meant to flip ON after sign-off, per policy). A
   toggle that's a deliberate, product-approved **permanent kill-switch**
   (ships ON by default as a documented exception, check the toggle's
   epic's close reason for language like "product-approved deviation from
   default-OFF policy") does NOT need a cleanup bead; it's meant to stay
   forever. Don't manufacture a cleanup bead for those.
5. File a cleanup bead for each real gap: `bd create "Cleanup: remove
   <name> feature toggle" --type task -p 3 --parent <beadRef> --acceptance
   "..."`, then `bd update <id> --status deferred`. **No `--defer` date**:
   bd 1.3 reopens a dated defer on any `bd ready` once the date passes, which
   puts a cleanup bead in front of agents as open work. A dateless defer
   never wakes, and `epic-hygiene.mjs` deliberately does not backfill one for
   a toggle-cleanup bead. **Guard the capture** per the Safety
   note in Step 0, this phase is exactly where that near-miss happened.
6. If a prior audit bead documented a since-resolved
   problem, close it with a reason summarizing the re-audit findings rather
   than leaving it open/deferred as a stale false alarm.

---

## Phase 8: Dependency graph sanity

Cheap, mechanical, run every time:

1. `bd dep cycles`, should report no cycles. If it finds one, inspect with
   `bd dep tree <id>` and remove the wrong-direction edge (`bd dep remove`).
2. Spot-check `bd list --status blocked -n 50`, a bead blocked on a
   dependency that's since closed should have auto-resolved; if any remain
   blocked on an already-closed blocker, that's a bug in the dependency
   edge itself, not real state, investigate with `bd dep list <id>`.

---

## Close-out

1. `bd dolt pull` → apply nothing further → `bd dolt pull` again → `bd dolt
   push` (the clobber-safe sequence, never push without a fresh pull
   immediately before it).
2. `git status` in the shared checkout should stay clean, this skill never
   needs a commit; it only mutates `bd` state, which syncs via Dolt, not
   git. If a finding implies an actual code fix, file/update a bead for it
   instead of editing code inline here.
3. Report a summary to the user: counts per phase (epics closed / split,
   beads normalized to deferred, beads corrected / closed / reconciled,
   beads split into children, stale claims reopened, lint warnings fixed,
   feature-toggle cleanup beads filed, dependency issues resolved), and the
   full list of bead IDs touched so the user can spot-check.

## Related

- `.agents/skills/bead-workflow/SKILL.md`, implement a bead's actual code
  change once hygiene has confirmed it's still valid, current work.
- `.agents/skills/beads-bulk/SKILL.md`, bulk multi-agent implementation of
  a list of independent beads (not hygiene, this is post-audit execution).
- The repository's epic and bead hygiene rules, which this skill operationalizes into a
  repeatable pass.
