#!/usr/bin/env node
// Pure planning logic for two deferred-bead rules. No bd calls, no
// filesystem, no process exit, that is what lets scripts/epic-hygiene.node-test.mjs
// cover it without stubbing a bd binary. The bd-touching CLI is scripts/epic-hygiene.mjs.
//
// ── Rule 1: an epic closes CLEAN ──────────────────────────────────────────────
// An epic may not close while it still has non-closed children. Deferred children
// are evicted first:
//   * exactly one  -> it moves out as a standalone bead
//   * two or more  -> a new deferred epic is created and they move onto it
// Both directions are cross-linked (new bead names the origin epic; the origin
// epic's close reason names the new bead).
//
// Rule 1b is the mirror image, and the tracker-wide scan used to miss it entirely:
// an OPEN epic whose only non-closed children are deferred has no
// live work left, so it should close and evict them by the same recipe. See
// planFullSweep for why the status test is `=== 'open'` and not `!== 'closed'`.
//
// Both rules are about EPICS. An OPEN feature, task or bug with a deferred toggle-cleanup
// child has not finished its own work, so it is never planned a close and its deferred children are
// never moved: planEpicEviction returns no actions and `parentNotEpic`, and the audit lists it
// apart, informational only. (A CLOSED non-epic parent still evicts under Rule 1, as before.)
//
// The guidance used to bless the opposite ("if all children are closed or deferred
// ... run bd close"), which is how closed parents ended up holding deferred
// children. That is a readability problem rather than a work-loss one, a closed
// parent does NOT hide a child from `bd list --status deferred`, and parent status
// is irrelevant to `bd ready`.
//
// ── Rule 2: a deferred bead carries a DATE ────────────────────────────────────
// This is the half that actually loses work. Most
// `status: deferred` beads can end up with NO defer date at all, and a hard-deferred bead
// never auto-surfaces when its date passes (expired ones stay
// invisible to `bd ready`). Evicting beads onto a tidy new
// epic relocates that invisible pile without making it visible again, so the two
// rules ship together or the cleanup is cosmetic.
//
// ── Why eviction does NOT reparent onto the closing epic ──────────────────────
// An earlier hygiene skill said to create the new deferred epic with
// `--parent <original-epic-id>` and then close the original. That reproduces the
// exact problem one level down: the original epic now has a non-closed child (the
// new deferred epic), so under Rule 1 it cannot close clean either. Eviction
// therefore targets the nearest ancestor that is NOT closed, and top-level when
// there is none. "Move out of the epic" has to actually move it out.
//
// Provenance survives regardless: `bd update --parent` does NOT change the child's
// ID, so a child keeps an ID that still names its origin epic after the move.
// Do not "fix" that.

/** Dependency edge type bd uses for hierarchy. Edges live on the CHILD row:
 *  { issue_id: <child>, depends_on_id: <parent>, type: 'parent-child' } */
const PARENT_EDGE = 'parent-child';

/** Placeholder the planner emits for an epic bd has not minted yet. */
export const NEW_EPIC_PREFIX = 'NEW_EPIC:';

/**
 * Swap `NEW_EPIC:<origin>` placeholders for the id bd actually minted.
 *
 * The planner is pure, so it cannot know the new epic's id, it emits a
 * placeholder key and the CLI resolves it once `bd create` has run. This applies
 * to free TEXT as well as to id fields: the origin epic's cross-link note and
 * close reason both name where its children went, and shipping the raw
 * placeholder there breaks the one link the close-clean rule depends on. It did
 * exactly that once: an origin epic's note read
 * "-> NEW_EPIC:bd-aaa11" instead of "-> bd-bbb22".
 */
export function resolveText(text, resolved) {
  // Substitute each known key literally rather than matching a pattern. A regex
  // like /NEW_EPIC:([\w.-]+)/ looks right and is not: the ids contain dots, so a
  // greedy class swallows the sentence-ending period and the lookup misses. The
  // notes end in exactly that shape ("-> NEW_EPIC:bd-aaa11."), so every
  // multi-child cross-link would silently keep its placeholder.
  let out = text;
  for (const [key, id] of resolved) out = out.split(key).join(id);
  return out;
}


/** Default runway given to a deferred bead that has no date of its own. */
export const DEFAULT_DEFER_MONTHS = 2;

/**
 * Build childId -> parentId from exported rows.
 * @param {Array<object>} rows `bd export` JSONL rows
 * @returns {Map<string,string>}
 */
export function resolveParents(rows) {
  const parents = new Map();
  for (const row of rows) {
    for (const dep of row.dependencies ?? []) {
      if (dep.type !== PARENT_EDGE) continue;
      // Defensive: trust the edge's own issue_id when present, since a row's
      // dependencies array is the child's, not the parent's.
      const child = dep.issue_id ?? row.id;
      const parent = dep.depends_on_id;
      if (child && parent) parents.set(child, parent);
    }
  }
  return parents;
}

/** Invert resolveParents into parentId -> child rows, preserving input order. */
export function resolveChildren(rows) {
  const parents = resolveParents(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();
  for (const row of rows) {
    const parent = parents.get(row.id);
    if (!parent || !byId.has(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  return children;
}

/**
 * Is this bead parked? Two shapes both suppress `bd ready`:
 *   (a) hard  `status: deferred`            , the repo convention
 *   (b) soft  `status: open` + future date  , the inconsistent minority
 *
 * `in_progress` is neither, whatever the date says. A stale future
 * `defer_until` outlives the deferral routinely, un-deferring by editing status
 * leaves the date field behind, and `bd defer --until` never wrote one in the
 * first place, so the (b) date check alone read an actively-claimed bead as
 * parked. Rule 1b then planned to evict live work into a "deferred follow-ups"
 * bucket and CLOSE its parent epic: a child claimed `in_progress` two days
 * after its deferral was lifted was planned for exactly that, along with its
 * siblings. An active claim asserts someone is
 * working the bead right now, which is the opposite of parked, so the status
 * wins over the leftover date, and it is checked BEFORE it.
 *
 * Same failure the `subtreeHasLiveWork` note below describes for grandchildren,
 * reached one level up through the status/date interaction.
 * @param {object} row
 * @param {Date} now
 */
export function isDeferred(row, now) {
  if (row.status === 'closed') return false;
  if (row.status === 'in_progress') return false;
  if (row.status === 'deferred') return true;
  return Boolean(row.defer_until && new Date(row.defer_until) > now);
}

/** A hard-deferred bead whose date has passed, parked with nothing to wake it. */
export function isExpiredDeferral(row, now) {
  if (row.status !== 'deferred') return false;
  if (!row.defer_until) return false;
  return new Date(row.defer_until) <= now;
}

/**
 * A feature-toggle cleanup bead ("Cleanup: remove <name> feature toggle"). It waits on
 * product sign-off, never on a date.
 */
export function isToggleCleanupBead(row) {
  return /^Cleanup: remove .+ feature toggle\b/i.test(String(row?.title ?? ''));
}

/**
 * The standing epic that holds every toggle-cleanup bead while it waits on sign-off: an epic
 * titled "Feature toggle cleanups …". A repository has at most one that is not closed.
 *
 * Without it, every toggled feature epic finished with one deferred cleanup child left, so
 * it could not close clean, and each eviction then dropped that child at top level or into a
 * one-off bucket: one tracker ended up with 39 cleanup beads scattered across top level and
 * unrelated buckets. With a holder, eviction sends a cleanup child there instead (see
 * planEpicEviction), and the holder is never closed, emptied or dated by this tool.
 */
export function isToggleCleanupHolder(row) {
  return isEpicRow(row) && /^Feature toggle cleanups\b/i.test(String(row?.title ?? ''));
}

/** The toggle-cleanup holder that is not closed, or null. Lowest id wins if there are two. */
export function findToggleCleanupHolder(rows) {
  const holders = rows
    .filter((r) => r.status !== 'closed' && isToggleCleanupHolder(r))
    .sort((a, b) => a.id.localeCompare(b.id));
  return holders[0] ?? null;
}

/**
 * A hard-deferred bead with no date at all, parked forever, so the sweep backfills a date.
 *
 * A toggle-cleanup bead is the sanctioned exception: it is deferred WITHOUT a date on purpose.
 * bd 1.3 reopens a dated defer on any `bd ready` read once the date passes, which put cleanup
 * beads in front of agents as open work; a dateless
 * defer never wakes. Backfilling a date here would undo that. The holder epic that parks
 * them is dateless for the same reason.
 */
export function isDatelessDeferral(row) {
  return row.status === 'deferred' && !row.defer_until && !isToggleCleanupBead(row) && !isToggleCleanupHolder(row);
}

/**
 * Does the subtree BELOW `rootId` (its descendants, not `rootId` itself) hold any
 * live work, a bead that is neither closed nor parked?
 *
 * Rule 1b classifies a direct child as parked from the child's OWN status/date and
 * looks no further down. That is wrong when the child is
 * itself an epic: a child epic can be parked (open + future date) while its
 * grandchild is `in_progress` with a live claim. Evicting
 * on that basis would file live work under a "deferred follow-ups" epic and mark it
 * `status: deferred`, asserting the opposite of the truth. So a child counts as
 * parked only when its whole subtree is parked; anything with a live descendant
 * blocks the close instead.
 *
 * Iterative with a `seen` set so a corrupt cyclic parent edge cannot hang it, the
 * same defence `nearestOpenAncestor` takes.
 */
export function subtreeHasLiveWork(rootId, childrenMap, now) {
  const stack = [...(childrenMap.get(rootId) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.status !== 'closed' && !isDeferred(node, now)) return true;
    for (const grandchild of childrenMap.get(node.id) ?? []) stack.push(grandchild);
  }
  return false;
}

/**
 * Is this epic itself a bucket that a previous eviction created? Its title ends in
 * the suffix planEpicEviction mints ("<title>, deferred follow-ups"). Re-running
 * the eviction on such an epic closes it only to mint a SECOND bucket holding the
 * same beads, pure churn, and it produces a doubled
 * "- deferred follow-ups, deferred follow-ups" title. A
 * bucket whose children are all parked is the settled DEFERRED state (four sibling
 * buckets already sit exactly there), so it is deferred in place instead.
 *
 * The title suffix is the reliable signal because the planner mints exactly that
 * string; a more robust check could also look for the relates-to edge the planner
 * writes back to the origin, but the title alone both detects every bucket this
 * tool made and guarantees no plan can ever double the suffix.
 */
export function isEvictionBucket(epic) {
  return Boolean(epic && /—\s*deferred follow-ups\s*$/.test(epic.title ?? ''));
}

/**
 * Walk up until we find an ancestor that is not closed. Returns null for
 * top-level. Cycle-safe: bd should never produce one, but a corrupt edge must
 * not hang the planner.
 */
export function nearestOpenAncestor(startId, rowsById, parents) {
  const seen = new Set([startId]);
  let cursor = parents.get(startId);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = rowsById.get(cursor);
    if (!row) return null;
    if (row.status !== 'closed') return cursor;
    cursor = parents.get(cursor);
  }
  return null;
}

/** ISO date (yyyy-mm-dd) `months` after `now`. bd accepts this for --defer. */
export function deferDateFrom(now, months = DEFAULT_DEFER_MONTHS) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic 0..(spreadDays-1) offset from a bead id.
 *
 * Backfilling one flat date is a trap: every dateless bead then expires on the
 * SAME day and the next sweep dumps all of them into `bd ready` at once. That
 * would put hundreds of beads on one date against a short ready list. Spreading them keeps the sweep a trickle instead of a flood.
 *
 * FNV-1a over the id, tiny, stable across runs and machines, and no dependency.
 */
export function spreadOffsetDays(id, spreadDays = 60) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % spreadDays;
}

/**
 * Runway for a bead with no date of its own: a priority band, plus a deterministic
 * within-band spread. Higher priority comes back sooner.
 *
 *   P0/P1 -> base months     P2 -> base+2     P3 -> base+4     P4 -> base+6
 *
 * The bands are a "look at this again eventually" horizon, not a product
 * judgement, the point of a date is that the bead becomes sweepable at all.
 */
export function backfillDeferDate(row, now, baseMonths = DEFAULT_DEFER_MONTHS) {
  const priority = Number.isFinite(row.priority) ? row.priority : 3;
  const band = priority <= 1 ? 0 : priority === 2 ? 2 : priority === 3 ? 4 : 6;
  const start = new Date(`${deferDateFrom(now, baseMonths + band)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + spreadOffsetDays(row.id));
  return start.toISOString().slice(0, 10);
}

/**
 * Date for the new deferred epic: the earliest date among the children it will
 * hold, so it wakes when the first of them does.
 *
 * Clamped to today. Inheriting verbatim looks right and is not: a child whose
 * date ALREADY passed would mint an epic that is expired the moment it exists,
 * and the very next sweep flips it straight back to open. Observed for real: an
 * epic inherited a child's date that had passed days earlier.
 * Returns null when no child carries a date, and the caller backfills.
 */
function inheritedDeferDate(rows, now) {
  const dates = rows.map((r) => r.defer_until).filter(Boolean).sort();
  if (!dates.length) return null;
  const earliest = dates[0].slice(0, 10);
  return earliest > deferDateFrom(now, 0) ? earliest : null;
}

/**
 * Is this row an epic? Only an epic is held to "closes clean" (the epic and bead hygiene guidance):
 * a feature, task or bug may legitimately keep a deferred child (a toggle-cleanup bead) under it
 * until its OWN work lands.
 */
export function isEpicRow(row) {
  return row?.issue_type === 'epic';
}

/**
 * What `epic <id>` prints and exits with for a parent that is not an epic (`plan.parentNotEpic`).
 *
 * The exit code follows the contract the hygiene guidance states for `epic <id>`: 1 when real work remains,
 * 0 when it does not. A non-epic parent with live (non-deferred, non-closed) children has real
 * work remaining, so it exits 1 like an epic that cannot close; without live children it exits 0
 * (nothing is planned, nothing is wrong). Only `sweep` is called by automation
 * (scripts/hygiene/tasks/40-surface-expired-deferred.sh), never `epic <id>`, so no caller reads
 * the old exit 0.
 *
 * @param {string} epicId
 * @param {ReturnType<typeof planEpicEviction>} plan a plan that carries `parentNotEpic`
 * @returns {{ text: string, exitCode: 0|1 }}
 */
export function describeNonEpicParent(epicId, plan) {
  const { type, status } = plan.parentNotEpic;
  let text =
    `${epicId} is not an epic (type ${type ?? 'unknown'}, ${status}), so this tool plans nothing for it: ` +
    `its own work decides when it closes, and its deferred children stay under it.\n`;
  if (plan.deferred.length) {
    text += `  deferred child(ren) left in place:\n${plan.deferred.map((c) => `    ${c.id} ${c.title}`).join('\n')}\n`;
  }
  if (plan.blockedBy.length) {
    text += `  live child(ren), so real work remains:\n${plan.blockedBy.map((c) => `    ${c.id} [${c.status}] ${c.title}`).join('\n')}\n`;
  }
  return { text, exitCode: plan.blockedBy.length > 0 ? 1 : 0 };
}

/**
 * Plan the eviction of an epic's deferred children so the epic can close clean.
 *
 * A non-epic parent that is not closed plans no actions and sets `parentNotEpic`.
 *
 * @param {string} epicId
 * @param {Array<object>} rows all exported rows
 * @param {Date} now
 * @param {{ defaultMonths?: number }} [opts]
 * @returns {{
 *   epicId: string,
 *   blockedBy: Array<object>,   // non-closed, non-deferred children, epic CANNOT close
 *   deferred: Array<object>,    // children to evict
 *   target: string|null,        // nearest open ancestor, null = top-level
 *   actions: Array<object>,
 *   parentNotEpic?: { type: string|null, status: string },  // set when the parent is not an epic
 * }}
 */
export function planEpicEviction(epicId, rows, now, opts = {}) {
  const defaultMonths = opts.defaultMonths ?? DEFAULT_DEFER_MONTHS;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents = resolveParents(rows);
  const childrenMap = resolveChildren(rows);
  const children = childrenMap.get(epicId) ?? [];
  const epic = byId.get(epicId);

  const live = children.filter((c) => c.status !== 'closed');
  // A child is parked (evictable) only when its OWN status/date says so AND its
  // whole subtree is parked, a deferred sub-epic with a live descendant blocks the
  // close instead of being evicted. Everything else is live.
  const deferred = live.filter((c) => isDeferred(c, now) && !subtreeHasLiveWork(c.id, childrenMap, now));
  const deferredIds = new Set(deferred.map((c) => c.id));
  const blockedBy = live.filter((c) => !deferredIds.has(c.id));

  const target = nearestOpenAncestor(epicId, byId, parents);
  const actions = [];

  // A parent that is NOT an epic (a feature, task or bug with a deferred toggle-cleanup child, say)
  // is not this tool's to close or to empty. Its own work decides when it closes, and
  // that work has not landed while the bead is still open: a feature with nothing
  // merged was planned as "close epic" when `epic <id>` was pointed at it. So an open, deferred or in-progress
  // non-epic parent plans NOTHING: its deferred children stay where they are, and the result
  // carries `parentNotEpic` so the report can say why. A CLOSED non-epic parent still evicts
  // (Rule 1 and its tail below): that mirrors the closed-epic case and never closes anything.
  if (epic && !isEpicRow(epic) && epic.status !== 'closed') {
    return {
      epicId,
      blockedBy,
      deferred,
      target,
      actions,
      parentNotEpic: { type: epic.issue_type ?? null, status: epic.status },
    };
  }

  // The toggle-cleanup holder parks cleanup beads on purpose and never closes on its own:
  // its children are all deferred by design, which is exactly the shape Rule 1b nominates.
  // Plan nothing for it (a closed one, which a human closed deliberately, evicts as usual).
  if (epic && isToggleCleanupHolder(epic) && epic.status !== 'closed') {
    return { epicId, blockedBy, deferred, target, actions, toggleCleanupHolder: true };
  }

  // Real work remains, nothing to plan, the epic must stay open.
  if (blockedBy.length > 0) return { epicId, blockedBy, deferred, target, actions };
  if (deferred.length === 0) return { epicId, blockedBy, deferred, target, actions };

  const epicTitle = epic?.title ?? epicId;

  // A toggle-cleanup child goes to the holder epic when there is one, with a relates-to edge
  // back to the feature it came from, instead of top level or a one-off bucket. Everything
  // else below runs on the REST of the deferred children.
  const holder = findToggleCleanupHolder(rows);
  const toHolder = holder ? deferred.filter((c) => isToggleCleanupBead(c)) : [];
  const rest = deferred.filter((c) => !toHolder.includes(c));
  for (const child of toHolder) {
    actions.push({ kind: 'reparent', id: child.id, newParent: holder.id, why: `toggle-cleanup child of ${epicId}` });
    actions.push({ kind: 'relate', id: child.id, to: epicId });
    actions.push({
      kind: 'note',
      id: child.id,
      text:
        `Moved out of ${epicId} ("${epicTitle}") when that epic closed, to the toggle-cleanup ` +
        `holder ${holder.id}, where it waits for sign-off. Related to ${epicId}.`,
    });
  }

  // The epic is ITSELF a previous eviction bucket. Its
  // children are already parked under it, closing it to mint a second bucket only
  // doubles the title suffix and churns ids. An OPEN bucket is deferred in place
  // (the settled parked state); a closed/already-deferred one, or one with a child
  // waking from an expired date (Rule 2 surfaces that child), needs nothing.
  if (rest.length && isEvictionBucket(epic)) {
    const wakes = rest.some((c) => isExpiredDeferral(c, now));
    if (epic.status === 'open' && !wakes) {
      actions.push({
        kind: 'defer-epic',
        id: epicId,
        deferUntil: inheritedDeferDate(rest, now) ?? deferDateFrom(now, defaultMonths),
        why: `already an eviction bucket ("${epic.title}") with all children parked — deferring in place rather than minting a second bucket`,
      });
    }
    return { epicId, blockedBy, deferred, target, actions };
  }

  // --split-standalone: the beads share a parent but nothing else, so a shared
  // follow-ups epic would be filing rather than grouping. Each moves out alone.
  const standalone = rest.length === 1 || opts.splitStandalone;
  if (rest.length === 0) {
    // Everything went to the toggle-cleanup holder; nothing else to move.
  } else if (standalone) {
    // A one-bead epic is pure ceremony, so a singleton always moves out alone.
    // No relates-to edge is needed on these: a moved CHILD keeps its hierarchical
    // id, which already names the origin epic structurally.
    for (const child of rest) {
      actions.push({
        kind: 'reparent',
        id: child.id,
        newParent: target,
        why: rest.length === 1 ? `sole deferred child of ${epicId}` : `deferred child of ${epicId} (split standalone)`,
      });
      if (isDatelessDeferral(child)) {
        actions.push({ kind: 'set-defer', id: child.id, deferUntil: backfillDeferDate(child, now, defaultMonths) });
      }
      actions.push({
        kind: 'note',
        id: child.id,
        text:
          `Moved out of ${epicId} ("${epicTitle}") when that epic closed — it was ` +
          `${rest.length === 1 ? 'the only deferred item left' : 'deferred, and split out standalone'}. ` +
          `This bead's ID still names its origin epic.`,
      });
    }
  } else {
    // A child whose date already passed is about to be surfaced back to `open` by
    // the same sweep. An epic holding live work is not deferred, so it is born
    // open, otherwise the sweep leaves a "deferred" epic with active children
    // under it, which is exactly the dishonest state the hygiene guidance forbids.
    const wakes = rest.some((c) => isExpiredDeferral(c, now));
    const deferUntil = wakes ? null : inheritedDeferDate(rest, now) ?? deferDateFrom(now, defaultMonths);
    const newEpicKey = `NEW_EPIC:${epicId}`;
    actions.push({
      kind: 'create-epic',
      key: newEpicKey,
      title: `${epicTitle} — deferred follow-ups`,
      parent: target,
      status: wakes ? 'open' : 'deferred',
      deferUntil,
      description:
        `Deferred follow-ups split out of ${epicId} ("${epicTitle}") so that epic could close clean.\n\n` +
        `These ${rest.length} beads were the only non-closed children left when ${epicId} finished; ` +
        `none of them blocked it. Each child's ID still names the origin epic.\n\n` +
        `Children moved here: ${rest.map((c) => c.id).join(', ')}`,
    });
    for (const child of rest) {
      actions.push({ kind: 'reparent', id: child.id, newParent: newEpicKey, why: `deferred child of ${epicId}` });
      if (isDatelessDeferral(child)) {
        actions.push({ kind: 'set-defer', id: child.id, deferUntil: backfillDeferDate(child, now, defaultMonths) });
      }
    }
    // Link the new epic back to its origin with a bidirectional, NON-blocking
    // relates-to edge. Without it the only link is prose in the description -
    // epics created without it shipped with `deps: []` and had
    // to be related by hand. A parent-child edge would be stronger provenance
    // but would leave the origin holding a non-closed child, which is Rule 1
    // violated one level down; relates-to gives the machine-readable link with
    // none of that (verified non-blocking: `bd ready` unchanged across adding it).
    actions.push({ kind: 'relate', id: newEpicKey, to: epicId });
  }

  // Cross-link back from the origin, and only then close it.
  const movedParts = [];
  if (rest.length) movedParts.push(standalone ? rest.map((c) => c.id).join(', ') : `NEW_EPIC:${epicId}`);
  if (toHolder.length) movedParts.push(`${holder.id} (toggle-cleanup holder)`);
  const movedTo = movedParts.join(' and ');
  actions.push({
    kind: 'note',
    id: epicId,
    text: `Deferred children evicted so this epic could close clean (epic and bead hygiene rule): ${
      deferred.map((c) => c.id).join(', ')
    } -> ${movedTo}.`,
  });
  if (epic && epic.status !== 'closed') {
    actions.push({
      kind: 'close-epic',
      id: epicId,
      reason: `All implementation children complete. Deferred follow-ups moved to ${movedTo}.`,
    });
  }

  return { epicId, blockedBy, deferred, target, actions };
}

/**
 * Whole-tracker audit: every violation of both rules.
 *
 * @param {Array<object>} rows
 * @param {Date} now
 * @param {{ defaultMonths?: number }} [opts]
 */
export function planFullSweep(rows, now, opts = {}) {
  const defaultMonths = opts.defaultMonths ?? DEFAULT_DEFER_MONTHS;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = resolveChildren(rows);

  // Rule 1, parents that closed while still holding deferred children.
  const evictions = [];
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    if (!parent || parent.status !== 'closed') continue;
    if (!kids.some((k) => isDeferred(k, now))) continue;
    const plan = planEpicEviction(parentId, rows, now, { defaultMonths, splitStandalone: opts.splitStandalone });
    if (plan.actions.length) evictions.push(plan);
  }
  evictions.sort((a, b) => a.epicId.localeCompare(b.epicId));

  // Rule 1b, OPEN parents with no live work left: every child is closed or
  // deferred, and at least one is deferred. Rule 1 above keys on the parent being
  // CLOSED and so misses the mirror image, which is the shape the hygiene guidance actually
  // legislates ("when the last implementation child finishes, the epic closes too
  //, but only once every non-closed child is dealt with"). One epic was exactly
  // this: four closed children and one deferred, and `audit` called the tracker
  // clean while `epic <id>` planned all four correct actions the moment a
  // human pointed it at that id. Only the tracker-wide SCAN was blind.
  //
  // The status test is `=== 'open'`, deliberately narrow, NOT `!== 'closed'`:
  //
  //   * A DEFERRED parent holding only deferred children is a coherent parked
  //     subtree, not a violation. A hygiene run found 8 of those and correctly
  //     left every one alone; a `!== 'closed'` test would nominate all 8 and the
  //     next sweep would "fix" eight things that were never broken.
  //   * `in_progress` means somebody is working it right now, likewise not ours.
  //
  // Everything else falls out of the per-epic planner, which already returns no
  // actions when live non-deferred children remain (`blockedBy`) or when there is
  // nothing deferred to evict. An open epic whose children are ALL closed is
  // therefore not nominated either: there is nothing to evict, and closing an
  // epic that never held a deferred child is a different judgement than this rule
  // makes.
  //
  // Chains converge over two runs rather than one, on purpose: an open epic whose
  // only live child is another open epic is still blocked at plan time, and only
  // becomes nominatable once that child has closed and its children moved up.
  //
  // It does NOT spin forever on its own output, which is the first thing this rule
  // looks like it might do. Evicting into a "- deferred follow-ups" epic produces an
  // epic whose children are all deferred, i.e. the very shape being nominated here -
  // but that epic is born `status: deferred` (planEpicEviction), and a deferred parent
  // is out of scope by the test above. The one case that is born OPEN is when a child
  // is waking from an expired date, and the same sweep surfaces that child to `open`,
  // which makes the new epic hold live work. Either way the next run has nothing to do.
  //
  // Only an EPIC is nominated. An open feature, task or bug with a deferred toggle-cleanup
  // child is the normal shape for work that has not landed yet, and "close it" is a wrong plan for
  // it. Such a parent is listed apart in `nonEpicParents`, informational only: it carries no
  // actions, so `sweep --apply` never touches it.
  const staleOpen = [];
  const nonEpicParents = [];
  for (const [parentId] of children) {
    const parent = byId.get(parentId);
    if (!parent || parent.status !== 'open') continue;
    const plan = planEpicEviction(parentId, rows, now, { defaultMonths, splitStandalone: opts.splitStandalone });
    if (plan.parentNotEpic) {
      if (plan.blockedBy.length === 0 && plan.deferred.length > 0) {
        nonEpicParents.push({
          parentId,
          type: plan.parentNotEpic.type,
          title: parent.title,
          deferred: plan.deferred.map((c) => c.id),
        });
      }
      continue;
    }
    if (plan.actions.length) staleOpen.push(plan);
  }
  staleOpen.sort((a, b) => a.epicId.localeCompare(b.epicId));
  nonEpicParents.sort((a, b) => a.parentId.localeCompare(b.parentId));

  // Rule 2, dateless and expired deferrals, tracker-wide. A bead already handled
  // by an eviction plan above keeps that plan's date, so skip it here.
  const claimed = new Set(
    [...evictions, ...staleOpen].flatMap((e) =>
      e.actions.filter((a) => a.kind === 'set-defer').map((a) => a.id),
    ),
  );

  const dateless = rows
    .filter((r) => isDatelessDeferral(r) && !claimed.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, deferUntil: backfillDeferDate(r, now, defaultMonths) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const expired = rows
    .filter((r) => isExpiredDeferral(r, now))
    .map((r) => ({ id: r.id, title: r.title, deferUntil: r.defer_until.slice(0, 10) }))
    .sort((a, b) => a.deferUntil.localeCompare(b.deferUntil));

  return { evictions, staleOpen, nonEpicParents, dateless, expired };
}

/** Flatten a sweep into the ordered action list the CLI applies. */
export function sweepActions(sweep) {
  const actions = [];
  for (const e of sweep.evictions) actions.push(...e.actions);
  // Rule 1b after Rule 1: an eviction from a CLOSED parent can land a child under
  // an open ancestor, and the plans are computed against one snapshot, so running
  // the closed-parent work first keeps the applied order matching the planned one.
  for (const e of sweep.staleOpen ?? []) actions.push(...e.actions);
  for (const d of sweep.dateless) actions.push({ kind: 'set-defer', id: d.id, deferUntil: d.deferUntil });
  for (const x of sweep.expired) actions.push({ kind: 'surface-expired', id: x.id, deferUntil: x.deferUntil });
  return actions;
}

/** Every action kind sweepActions() can emit, the vocabulary `--only` validates against. */
export const ACTION_KINDS = ['create-epic', 'reparent', 'set-defer', 'surface-expired', 'defer-epic', 'relate', 'note', 'close-epic'];

/**
 * Keep only the actions whose kind is in `kinds` (the CLI's `--only a,b`). Meant for the
 * ONE rule that is safe to apply unattended, `surface-expired`: a deferred
 * bead whose date has passed goes back to `open` so `bd ready` shows it, which bd never
 * does on its own. Evictions, backfilled dates and new bucket epics stay behind the
 * weekly `/beads-hygiene` pass, where a human reads the plan. Note that a filtered plan
 * can drop an action another action depended on (a `relate` to a `create-epic`), which
 * is fine for `surface-expired`, it stands alone, and is why the caller validates the
 * kinds rather than accepting any string.
 * @param {object[]} actions
 * @param {string[]} kinds
 */
export function filterActionKinds(actions, kinds) {
  const unknown = kinds.filter((k) => !ACTION_KINDS.includes(k));
  if (unknown.length) throw new Error(`unknown action kind(s): ${unknown.join(', ')} (known: ${ACTION_KINDS.join(', ')})`);
  const want = new Set(kinds);
  return actions.filter((a) => want.has(a.kind));
}
