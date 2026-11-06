#!/usr/bin/env node
// Tests for the pure planner in scripts/epic-hygiene-lib.mjs.
// The lib takes `bd export` rows and returns a plan, so every case here is
// expressed as fixture rows in bd's real export shape, the parent edge lives on
// the CHILD row as { issue_id, depends_on_id, type: 'parent-child' }.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ACTION_KINDS,
  backfillDeferDate,
  deferDateFrom,
  filterActionKinds,
  isDatelessDeferral,
  isDeferred,
  isToggleCleanupBead,
  describeNonEpicParent,
  isEvictionBucket,
  isExpiredDeferral,
  nearestOpenAncestor,
  planEpicEviction,
  planFullSweep,
  resolveChildren,
  resolveText,
  resolveParents,
  spreadOffsetDays,
  subtreeHasLiveWork,
  sweepActions,
} from './epic-hygiene-lib.mjs';

const NOW = new Date('2026-08-22T12:00:00Z');

const issue = (id, over = {}) => ({
  id,
  title: `title ${id}`,
  status: 'open',
  issue_type: 'task',
  defer_until: null,
  dependencies: [],
  ...over,
});

const childOf = (id, parent, over = {}) =>
  issue(id, {
    ...over,
    dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }],
  });

// ── --only <kinds>: the nightly cron applies surface-expired alone ──

test('filterActionKinds keeps only the named kinds and refuses an unknown one', () => {
  // A closed epic holding a dateless deferred child (Rule 1 + 2a), plus an expired
  // deferral (Rule 2b): the full sweep plans several kinds, the cron wants one.
  const rows = [
    issue('bd-epic', { status: 'closed', issue_type: 'epic' }),
    childOf('bd-kid', 'bd-epic', { status: 'deferred' }),
    issue('bd-late', { status: 'deferred', defer_until: '2026-08-01T00:00:00Z' }),
  ];
  const all = sweepActions(planFullSweep(rows, NOW, { defaultMonths: 2 }));
  assert.ok(all.some((a) => a.kind === 'surface-expired'), 'fixture plans a surface');
  assert.ok(all.some((a) => a.kind !== 'surface-expired'), 'fixture plans something else too');

  const only = filterActionKinds(all, ['surface-expired']);
  assert.deepEqual(only, [{ kind: 'surface-expired', id: 'bd-late', deferUntil: '2026-08-01' }]);
  assert.deepEqual(filterActionKinds(all, []), []);
  assert.throws(() => filterActionKinds(all, ['surface-expired', 'undefer']), /unknown action kind\(s\): undefer/);
  for (const k of new Set(all.map((a) => a.kind))) assert.ok(ACTION_KINDS.includes(k), `${k} is a listed kind`);
});

test('resolveParents reads the edge off the child row', () => {
  const rows = [issue('E'), childOf('E.1', 'E'), childOf('E.2', 'E')];
  const parents = resolveParents(rows);
  assert.equal(parents.get('E.1'), 'E');
  assert.equal(parents.get('E.2'), 'E');
  assert.equal(parents.get('E'), undefined);
  assert.deepEqual(
    (resolveChildren(rows).get('E') ?? []).map((r) => r.id),
    ['E.1', 'E.2'],
  );
});

test('resolveChildren ignores edges whose parent is not in the row set', () => {
  const rows = [childOf('X.1', 'MISSING')];
  assert.equal(resolveChildren(rows).size, 0);
});

test('resolveParents ignores non-hierarchy dependency types', () => {
  const rows = [
    issue('A'),
    issue('B', { dependencies: [{ issue_id: 'B', depends_on_id: 'A', type: 'blocks' }] }),
  ];
  assert.equal(resolveParents(rows).size, 0);
});

test('isDeferred covers hard status and soft future-dated open', () => {
  assert.equal(isDeferred(issue('a', { status: 'deferred' }), NOW), true);
  assert.equal(isDeferred(issue('b', { defer_until: '2027-01-01T00:00:00Z' }), NOW), true);
  // A past date on an OPEN bead is not parked, it is plain backlog again.
  assert.equal(isDeferred(issue('c', { defer_until: '2026-01-01T00:00:00Z' }), NOW), false);
  assert.equal(isDeferred(issue('d'), NOW), false);
  // Closed always wins, even carrying a future date.
  assert.equal(isDeferred(issue('e', { status: 'closed', defer_until: '2027-01-01T00:00:00Z' }), NOW), false);
});

test('an in_progress bead is live work whatever its leftover defer_until says', () => {
  // Un-deferring by editing status leaves the date behind, so this state is common
  // in the wild: a child sat in it with a claim on it.
  assert.equal(isDeferred(issue('a', { status: 'in_progress', defer_until: '2027-01-01T00:00:00Z' }), NOW), false);
  assert.equal(isDeferred(issue('b', { status: 'in_progress', defer_until: '2026-01-01T00:00:00Z' }), NOW), false);
  assert.equal(isDeferred(issue('c', { status: 'in_progress' }), NOW), false);
});

test('an in_progress child with a future date blocks the close instead of being evicted', () => {
  // The real 2026-09-13 shape: every other child parked, one claimed bead carrying
  // a stale date. The sweep planned to file it under a "deferred follow-ups" epic
  // and close the live parent.
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.3', 'E', { status: 'in_progress', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const plan = planEpicEviction('E', rows, NOW);
  assert.deepEqual(plan.blockedBy.map((r) => r.id), ['E.3']);
  assert.deepEqual(plan.actions, [], 'no eviction, and above all no close-epic');

  // And the same through the tracker-wide sweep, which is what the cron runs.
  const sweepIds = sweepActions(planFullSweep(rows, NOW, { defaultMonths: 2 })).map((a) => a.id);
  assert.ok(!sweepIds.includes('E'), 'the live epic must not be closed');
  assert.ok(!sweepIds.includes('E.3'), 'the claimed bead must not be touched');
});

test('an in_progress GRANDCHILD keeps its parked parent from being evicted', () => {
  // subtreeHasLiveWork reaches the claim through a parked intermediate epic, the
  // grandchild-recursion shape, now with the status/date interaction underneath it.
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { issue_type: 'epic', status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2.1', 'E.2', { status: 'in_progress', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  assert.equal(subtreeHasLiveWork('E', resolveChildren(rows), NOW), true);
  assert.deepEqual(planEpicEviction('E', rows, NOW).actions, []);
});

test('expired and dateless deferrals are recognised only for hard-deferred beads', () => {
  assert.equal(isExpiredDeferral(issue('a', { status: 'deferred', defer_until: '2026-07-22T00:00:00Z' }), NOW), true);
  assert.equal(isExpiredDeferral(issue('b', { status: 'deferred', defer_until: '2027-07-22T00:00:00Z' }), NOW), false);
  assert.equal(isExpiredDeferral(issue('c', { status: 'deferred' }), NOW), false);
  // An OPEN bead with a passed date is not a stuck deferral, bd ready shows it.
  assert.equal(isExpiredDeferral(issue('d', { defer_until: '2026-07-22T00:00:00Z' }), NOW), false);

  assert.equal(isDatelessDeferral(issue('e', { status: 'deferred' })), true);
  assert.equal(isDatelessDeferral(issue('f', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' })), false);
  assert.equal(isDatelessDeferral(issue('g')), false);
});

// bd 1.3 reopens a dated defer once the date passes, so a toggle-cleanup bead is deferred with NO
// date on purpose: it waits on sign-off. The sweep must not backfill one.
test('a dateless toggle-cleanup bead is the sanctioned icebox: never dateless-flagged, never backfilled', () => {
  const cleanup = issue('C', { status: 'deferred', title: 'Cleanup: remove token-vision feature toggle' });
  assert.equal(isToggleCleanupBead(cleanup), true);
  assert.equal(isToggleCleanupBead(issue('n', { title: 'Cleanup: tidy the toggle admin page' })), false);
  assert.equal(isToggleCleanupBead(issue('m', { title: 'Remove token-vision feature toggle' })), false);
  assert.equal(isDatelessDeferral(cleanup), false);

  const rows = [
    cleanup,
    issue('LONE', { status: 'deferred' }),
    issue('E', { issue_type: 'epic', status: 'closed' }),
    childOf('E.1', 'E', { status: 'deferred', title: 'Cleanup: remove map-lighting feature toggle' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.dateless.map((d) => d.id), ['LONE']);
  const setDefers = sweepActions(sweep).filter((a) => a.kind === 'set-defer').map((a) => a.id);
  assert.ok(!setDefers.includes('C'), 'the tracker-wide sweep leaves it dateless');
  assert.ok(!setDefers.includes('E.1'), 'an eviction moves it without dating it');
});

test('deferDateFrom adds months and rolls the year over', () => {
  assert.equal(deferDateFrom(new Date('2026-08-22T12:00:00Z'), 2), '2026-10-22');
  assert.equal(deferDateFrom(new Date('2026-11-30T00:00:00Z'), 2), '2027-01-30');
  assert.equal(deferDateFrom(new Date('2026-08-22T23:59:59Z'), 0), '2026-08-22');
});

test('nearestOpenAncestor skips closed ancestors and returns null at top level', () => {
  const rows = [
    issue('TOP', { status: 'open' }),
    childOf('MID', 'TOP', { status: 'closed' }),
    childOf('LEAF', 'MID', { status: 'closed' }),
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents = resolveParents(rows);
  assert.equal(nearestOpenAncestor('LEAF', byId, parents), 'TOP');

  const allClosed = [issue('T', { status: 'closed' }), childOf('C', 'T', { status: 'closed' })];
  assert.equal(
    nearestOpenAncestor('C', new Map(allClosed.map((r) => [r.id, r])), resolveParents(allClosed)),
    null,
  );
});

test('nearestOpenAncestor survives a cyclic parent edge instead of hanging', () => {
  const rows = [
    issue('A', { status: 'closed', dependencies: [{ issue_id: 'A', depends_on_id: 'B', type: 'parent-child' }] }),
    issue('B', { status: 'closed', dependencies: [{ issue_id: 'B', depends_on_id: 'A', type: 'parent-child' }] }),
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(nearestOpenAncestor('A', byId, resolveParents(rows)), null);
});

test('an epic with live non-deferred children is reported blocked and plans nothing', () => {
  const rows = [
    issue('E', { issue_type: 'epic' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'open' }),
    childOf('E.3', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const plan = planEpicEviction('E', rows, NOW);
  assert.deepEqual(plan.blockedBy.map((r) => r.id), ['E.2']);
  assert.deepEqual(plan.actions, []);
});

test('an epic whose children are all closed plans nothing', () => {
  const rows = [issue('E', { issue_type: 'epic' }), childOf('E.1', 'E', { status: 'closed' })];
  assert.deepEqual(planEpicEviction('E', rows, NOW).actions, []);
});

test('a single deferred child moves out standalone — no ceremonial one-bead epic', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-02-21T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  assert.equal(actions.filter((a) => a.kind === 'create-epic').length, 0);

  const reparent = actions.find((a) => a.kind === 'reparent');
  assert.equal(reparent.id, 'E.2');
  assert.equal(reparent.newParent, null, 'top level — E has no open ancestor');

  // Cross-linked both directions, then closed.
  assert.ok(actions.some((a) => a.kind === 'note' && a.id === 'E.2' && a.text.includes('E')));
  assert.ok(actions.some((a) => a.kind === 'note' && a.id === 'E' && a.text.includes('E.2')));
  const close = actions.at(-1);
  assert.equal(close.kind, 'close-epic');
  assert.equal(close.id, 'E');
  assert.match(close.reason, /E\.2/);
});

test('two or more deferred children get a new deferred epic, NOT parented under the closing epic', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2026-12-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);

  const create = actions.find((a) => a.kind === 'create-epic');
  assert.equal(create.title, 'The Epic — deferred follow-ups');
  // Parenting the new epic under E would leave E with a non-closed child, which is
  // the very thing Rule 1 forbids. Top level here, since E has no open ancestor.
  assert.equal(create.parent, null);
  assert.equal(create.status, 'deferred');
  assert.equal(create.deferUntil, '2026-12-01', 'inherits the EARLIEST child date');
  assert.match(create.description, /E\.1, E\.2/);

  const reparents = actions.filter((a) => a.kind === 'reparent');
  assert.deepEqual(reparents.map((a) => a.id), ['E.1', 'E.2']);
  assert.ok(reparents.every((a) => a.newParent === create.key));
  assert.ok(actions.some((a) => a.kind === 'close-epic' && a.id === 'E'));
});

test('a new epic is never born already-expired, whatever its children carry', () => {
  // Observed for real: an epic inherited a child's date that had passed days
  // earlier and was expired the moment it existed, so the very
  // next sweep flipped it straight back open. The invariant is simply that a
  // created epic never carries a date already in the past, reached here by the
  // born-open rule, with the clamp in inheritedDeferDate as defence in depth.
  const cases = [
    ['2026-08-18T00:00:00Z', '2027-03-01T00:00:00Z'], // one expired, one future
    ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'], // both long expired
    ['2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z'], // both future
  ];
  for (const [d1, d2] of cases) {
    const rows = [
      issue('E', { issue_type: 'epic', title: 'The Epic' }),
      childOf('E.1', 'E', { status: 'deferred', defer_until: d1 }),
      childOf('E.2', 'E', { status: 'deferred', defer_until: d2 }),
    ];
    const create = planEpicEviction('E', rows, NOW).actions.find((a) => a.kind === 'create-epic');
    assert.ok(
      create.deferUntil === null || create.deferUntil > deferDateFrom(NOW, 0),
      `${d1}/${d2} -> ${create.deferUntil} is already in the past`,
    );
    // And a dated epic is deferred, an undated one is open, never a dateless freeze.
    assert.equal(create.status, create.deferUntil === null ? 'open' : 'deferred');
  }
});

test('a new epic is born OPEN when one of its children is waking from an expired date', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2026-07-01T00:00:00Z' }), // expired -> wakes
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const create = planEpicEviction('E', rows, NOW).actions.find((a) => a.kind === 'create-epic');
  assert.equal(create.status, 'open', 'an epic holding live work must not be deferred');
  assert.equal(create.deferUntil, null);
});

test('a new epic is deferred when every child stays parked', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const create = planEpicEviction('E', rows, NOW).actions.find((a) => a.kind === 'create-epic');
  assert.equal(create.status, 'deferred');
  assert.equal(create.deferUntil, '2027-01-01');
});

test('resolveText swaps placeholders literally, including at a sentence end', () => {
  const resolved = new Map([['NEW_EPIC:bd-aaa11', 'bd-bbb22']]);
  // The note text ends "-> NEW_EPIC:bd-aaa11.", a greedy /NEW_EPIC:([\w.-]+)/
  // swallows that final period and the lookup misses, which is how a real
  // sweep shipped "-> NEW_EPIC:bd-aaa11" into an epic's notes.
  assert.equal(resolveText('moved -> NEW_EPIC:bd-aaa11.', resolved), 'moved -> bd-bbb22.');
  assert.equal(resolveText('see NEW_EPIC:bd-aaa11 for more', resolved), 'see bd-bbb22 for more');
  // Several placeholders, and unknown keys left untouched rather than mangled.
  const many = new Map([['NEW_EPIC:A', 'bd-1'], ['NEW_EPIC:B', 'bd-2']]);
  assert.equal(resolveText('NEW_EPIC:A and NEW_EPIC:B.', many), 'bd-1 and bd-2.');
  assert.equal(resolveText('-> NEW_EPIC:UNKNOWN.', resolved), '-> NEW_EPIC:UNKNOWN.');
  assert.equal(resolveText('no placeholder here', resolved), 'no placeholder here');
});

test('the origin close reason resolves to the real epic id, not the placeholder', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  const resolved = new Map([['NEW_EPIC:E', 'bd-real']]);
  const close = actions.find((a) => a.kind === 'close-epic');
  const note = actions.find((a) => a.kind === 'note' && a.id === 'E');
  for (const text of [close.reason, note.text]) {
    const out = resolveText(text, resolved);
    assert.ok(out.includes('bd-real'), out);
    assert.ok(!out.includes('NEW_EPIC'), `placeholder survived: ${out}`);
  }
});

test('a multi-child eviction links the new epic back to its origin', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  const relate = actions.find((a) => a.kind === 'relate');
  assert.ok(relate, 'a prose-only link back is what shipped in the 2026-08-23 sweep');
  assert.equal(relate.id, 'NEW_EPIC:E');
  assert.equal(relate.to, 'E');
  // The edge must be planned only once the new epic exists.
  assert.ok(actions.indexOf(relate) > actions.findIndex((a) => a.kind === 'create-epic'));
});

test('a singleton eviction needs no relate edge — the child id already names the origin', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  assert.equal(planEpicEviction('E', rows, NOW).actions.filter((a) => a.kind === 'relate').length, 0);
});

test('--split-standalone moves every child out individually and creates no epic', () => {
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW, { splitStandalone: true });
  assert.equal(actions.filter((a) => a.kind === 'create-epic').length, 0);
  assert.equal(actions.filter((a) => a.kind === 'relate').length, 0);
  const reparents = actions.filter((a) => a.kind === 'reparent');
  assert.deepEqual(reparents.map((a) => a.id), ['E.1', 'E.2']);
  assert.ok(reparents.every((a) => a.newParent === null), 'each goes to the ancestor, not a new epic');
  // The origin's close reason must name both destinations, not a placeholder.
  const close = actions.find((a) => a.kind === 'close-epic');
  assert.match(close.reason, /E\.1, E\.2/);
  assert.ok(!close.reason.includes('NEW_EPIC'));
});

test('no planned action leaks a NEW_EPIC placeholder into text the CLI cannot resolve', () => {
  // The origin's note and close reason DO carry the placeholder by design, the
  // CLI swaps it once bd mints the id. What must never happen is a placeholder
  // surviving in a bead that is not the origin, where nothing would resolve it.
  const rows = [
    issue('E', { issue_type: 'epic', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  const create = actions.find((a) => a.kind === 'create-epic');
  assert.ok(!create.description.includes('NEW_EPIC'), 'the new epic describes itself');
  for (const a of actions.filter((x) => x.kind === 'note' && x.id !== 'E')) {
    assert.ok(!a.text.includes('NEW_EPIC'), `${a.id} note carries an unresolvable placeholder`);
  }
});

test('eviction targets the nearest OPEN ancestor when one exists', () => {
  const rows = [
    issue('TOP', { issue_type: 'epic', status: 'open' }),
    childOf('E', 'TOP', { issue_type: 'epic', status: 'open', title: 'Sub' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const { actions, target } = planEpicEviction('E', rows, NOW);
  assert.equal(target, 'TOP');
  assert.equal(actions.find((a) => a.kind === 'reparent').newParent, 'TOP');
});

test('a dateless deferred child gets a backfilled date as part of the eviction', () => {
  const rows = [
    issue('E', { issue_type: 'epic' }),
    childOf('E.1', 'E', { status: 'deferred', priority: 1 }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW, { defaultMonths: 2 });
  const setDefer = actions.find((a) => a.kind === 'set-defer');
  assert.equal(setDefer.id, 'E.1');
  assert.equal(setDefer.deferUntil, backfillDeferDate({ id: 'E.1', priority: 1 }, NOW, 2));
});

test('spreadOffsetDays is deterministic, in range, and id-sensitive', () => {
  assert.equal(spreadOffsetDays('bd-abc'), spreadOffsetDays('bd-abc'));
  for (const id of ['a', 'bd-aaaa1.35', 'bd-aaaa2', '', 'zzzz']) {
    const n = spreadOffsetDays(id);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 60, `${id} -> ${n}`);
  }
  // Different ids must not all collapse onto one day, that is the whole point.
  const spread = new Set(Array.from({ length: 200 }, (_, i) => spreadOffsetDays(`bd-x${i}`)));
  assert.ok(spread.size > 30, `expected a wide spread, got ${spread.size} distinct offsets`);
});

test('backfillDeferDate bands by priority — higher priority returns sooner', () => {
  const at = (p) => backfillDeferDate({ id: 'SAME', priority: p }, NOW, 2);
  // Same id, so the spread offset is identical and only the band moves the date.
  assert.ok(at(0) === at(1), 'P0 and P1 share a band');
  assert.ok(at(1) < at(2), 'P1 sooner than P2');
  assert.ok(at(2) < at(3), 'P2 sooner than P3');
  assert.ok(at(3) < at(4), 'P3 sooner than P4');
  // A missing priority must not throw or land at the front of the queue.
  assert.equal(backfillDeferDate({ id: 'SAME' }, NOW, 2), at(3));
});

test('backfilled dates never land in the past and clear the base runway', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `bd-s${i}`, priority: i % 5 }));
  const base = deferDateFrom(NOW, 2);
  for (const r of rows) {
    const d = backfillDeferDate(r, NOW, 2);
    assert.ok(d >= base, `${r.id} -> ${d} landed before the ${base} base runway`);
  }
});

test('a whole-tracker backfill does not pile every bead onto one date', () => {
  const rows = Array.from({ length: 180 }, (_, i) =>
    issue(`bd-b${i}`, { status: 'deferred', priority: i % 5 }));
  const sweep = planFullSweep(rows, NOW);
  assert.equal(sweep.dateless.length, 180);
  const distinct = new Set(sweep.dateless.map((d) => d.deferUntil));
  // Flat backfill would be 1. Anything in the low hundreds means the sweep
  // trickles instead of dumping 180 beads into `bd ready` on a single day.
  assert.ok(distinct.size > 100, `expected >100 distinct dates, got ${distinct.size}`);
  const busiest = Math.max(...[...distinct].map((d) => sweep.dateless.filter((x) => x.deferUntil === d).length));
  assert.ok(busiest <= 5, `busiest day holds ${busiest} beads`);
});

test('an already-closed parent is not re-closed, but its children still evict', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'closed' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  assert.equal(actions.filter((a) => a.kind === 'close-epic').length, 0);
  assert.ok(actions.some((a) => a.kind === 'reparent' && a.id === 'E.1'));
});

test('planFullSweep finds closed parents holding deferred children', () => {
  const rows = [
    issue('OPEN_E', { issue_type: 'epic', status: 'open' }),
    childOf('OPEN_E.1', 'OPEN_E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    issue('CLOSED_E', { issue_type: 'epic', status: 'closed' }),
    childOf('CLOSED_E.1', 'CLOSED_E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  // Rule 1 is specifically about CLOSED parents; the open one is Rule 1b's business.
  assert.deepEqual(sweep.evictions.map((e) => e.epicId), ['CLOSED_E']);
  assert.deepEqual(sweep.staleOpen.map((e) => e.epicId), ['OPEN_E']);
});

// ── Rule 1b: OPEN epics with no live work left ────────────────────
// The whole failure mode is a silent false-clean, so both halves are pinned: the
// case that must be nominated, and the shape that must stay silent.

test('planFullSweep nominates an OPEN epic whose only non-closed children are deferred', () => {
  // A real shape: four closed children and one deferred. `audit` used to
  // report the tracker clean while `epic <id>` planned every action correctly.
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'closed' }),
    childOf('E.3', 'E', { status: 'closed' }),
    childOf('E.4', 'E', { status: 'closed' }),
    childOf('E.5', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.staleOpen.map((e) => e.epicId), ['E']);

  // Same plan the per-epic planner already produced by hand: the sole deferred child
  // moves out standalone, and the epic closes.
  const actions = sweepActions(sweep);
  assert.ok(actions.some((a) => a.kind === 'reparent' && a.id === 'E.5' && a.newParent === null));
  assert.ok(actions.some((a) => a.kind === 'close-epic' && a.id === 'E'));
});

test('a DEFERRED parent holding only deferred children is NOT nominated', () => {
  // The eight real subtrees a hygiene run checked and correctly left
  // alone. A `!== 'closed'` status test would nominate every one of them, and the
  // next sweep would "fix" eight things that were never broken.
  const parked = [
    'bd-aaaa1', 'bd-aaaa2.11', 'bd-aaaa3.65', 'bd-aaaa4',
    'bd-aaaa5', 'bd-aaaa6', 'bd-aaaa7.13', 'bd-aaaa7.21',
  ];
  const rows = parked.flatMap((id) => [
    issue(id, { issue_type: 'epic', status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf(`${id}.1`, id, { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ]);
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.staleOpen, []);
  assert.deepEqual(sweep.evictions, []);
  assert.deepEqual(sweepActions(sweep), []);
});

test('an OPEN epic with any live non-deferred child is left alone', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'open' }),
  ];
  assert.deepEqual(planFullSweep(rows, NOW).staleOpen, []);
});

test('an IN_PROGRESS epic is not nominated — somebody is working it right now', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'in_progress' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(planFullSweep(rows, NOW).staleOpen, []);
});

test('an OPEN epic whose children are ALL closed plans nothing', () => {
  // Nothing to evict, so nothing to do here. Closing an epic that never held a
  // deferred child is a different judgement than this rule makes.
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.1', 'E', { status: 'closed' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.staleOpen, []);
  assert.deepEqual(sweepActions(sweep), []);
});

test('a Rule 1b eviction claims its own dateless child, so no date is planned twice', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'deferred' }), // dateless AND being evicted
    issue('LONE', { status: 'deferred' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.dateless.map((d) => d.id), ['LONE']);
  const setDefers = sweepActions(sweep).filter((a) => a.kind === 'set-defer');
  assert.deepEqual(setDefers.map((a) => a.id).sort(), ['E.2', 'LONE']);
});

test('planFullSweep does not double-plan a defer date already set by an eviction', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'closed' }),
    childOf('E.1', 'E', { status: 'deferred' }), // dateless AND being evicted
    issue('LONE', { status: 'deferred' }), // dateless, no parent
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.dateless.map((d) => d.id), ['LONE']);
  const setDefers = sweepActions(sweep).filter((a) => a.kind === 'set-defer');
  assert.deepEqual(setDefers.map((a) => a.id).sort(), ['E.1', 'LONE']);
});

test('planFullSweep reports expired deferrals oldest-first', () => {
  const rows = [
    issue('A', { status: 'deferred', defer_until: '2026-07-22T00:00:00Z' }),
    issue('B', { status: 'deferred', defer_until: '2026-06-06T00:00:00Z' }),
    issue('C', { status: 'deferred', defer_until: '2027-06-06T00:00:00Z' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.expired.map((x) => x.id), ['B', 'A']);
  assert.deepEqual(
    sweepActions(sweep).filter((a) => a.kind === 'surface-expired').map((a) => a.id),
    ['B', 'A'],
  );
});

// ── defect 1: recurse into grandchildren before nominating ─────────
// A direct child that is parked by its OWN status/date can still hide LIVE work
// further down. The scan must not nominate an epic whose subtree holds a live bead.

test('subtreeHasLiveWork sees live work anywhere below and ignores fully-parked subtrees', () => {
  const rows = [
    issue('R'),
    childOf('R.1', 'R', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('R.1.1', 'R.1', { status: 'in_progress' }),
    issue('P'),
    childOf('P.1', 'P', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('P.1.1', 'P.1', { status: 'closed' }),
  ];
  const cm = resolveChildren(rows);
  assert.equal(subtreeHasLiveWork('R', cm, NOW), true, 'in_progress grandchild is live');
  assert.equal(subtreeHasLiveWork('R.1', cm, NOW), true);
  assert.equal(subtreeHasLiveWork('P', cm, NOW), false, 'every descendant parked or closed');
  assert.equal(subtreeHasLiveWork('R.1.1', cm, NOW), false, 'a leaf has no descendants');
});

test('Rule 1b does not nominate an epic whose parked child hides live grandchildren', () => {
  // The real shape: the parent is open,
  // its only non-closed child is parked (open + future date) AND is itself an epic,
  // and that child holds an in_progress grandchild with a live claim.
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.31', 'E', { issue_type: 'epic', status: 'open', defer_until: '2026-12-01T00:00:00Z' }),
    childOf('E.31.1', 'E.31', { status: 'in_progress' }),
  ];
  // The parked child blocks the close instead of being evicted, evicting it would
  // file live work under a "deferred follow-ups" epic and mark it deferred.
  const plan = planEpicEviction('E', rows, NOW);
  assert.deepEqual(plan.blockedBy.map((r) => r.id), ['E.31']);
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(plan.actions, []);
  // And the whole-tracker scan agrees: no nomination over a subtree with live work.
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.staleOpen, []);
  assert.deepEqual(sweepActions(sweep), []);
});

test('a soft-deferred (open + future date) child with no live descendants still evicts', () => {
  // Acceptance point 3: the future-dated OPEN child must STAY classified as parked
  // when its own subtree is empty, a regression here would re-hide that epic.
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open', title: 'The Epic' }),
    childOf('E.1', 'E', { status: 'closed' }),
    childOf('E.2', 'E', { status: 'open', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const { deferred, actions } = planEpicEviction('E', rows, NOW);
  assert.deepEqual(deferred.map((c) => c.id), ['E.2']);
  assert.ok(actions.some((a) => a.kind === 'reparent' && a.id === 'E.2'));
  assert.ok(actions.some((a) => a.kind === 'close-epic' && a.id === 'E'));
});

// ── defect 2: never re-bucket an eviction bucket ───────────────────

test('isEvictionBucket matches only the minted "— deferred follow-ups" suffix', () => {
  assert.equal(isEvictionBucket({ title: 'Domain refactor — deferred follow-ups' }), true);
  assert.equal(isEvictionBucket({ title: 'Domain refactor — deferred follow-ups ' }), true);
  assert.equal(isEvictionBucket({ title: 'A normal epic' }), false);
  assert.equal(isEvictionBucket({ title: 'deferred follow-ups for later' }), false);
  assert.equal(isEvictionBucket(undefined), false);
  assert.equal(isEvictionBucket({}), false);
});

test('an epic that is already an eviction bucket is deferred in place, not re-bucketed', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open', title: 'Domain refactor — deferred follow-ups' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  const { actions } = planEpicEviction('E', rows, NOW);
  // Deferred in place: exactly one defer-epic action, nothing else.
  assert.deepEqual(actions.map((a) => a.kind), ['defer-epic']);
  assert.equal(actions[0].id, 'E');
  assert.equal(actions[0].deferUntil, '2027-01-01', 'inherits the EARLIEST child date');
  // The churn the old close+re-bucket path emitted must all be absent...
  assert.equal(actions.filter((a) => a.kind === 'create-epic').length, 0);
  assert.equal(actions.filter((a) => a.kind === 'close-epic').length, 0);
  assert.equal(actions.filter((a) => a.kind === 'reparent').length, 0);
  // ...and no plan can EVER emit the doubled suffix.
  assert.ok(!actions.some((a) => (a.title ?? '').includes('deferred follow-ups — deferred follow-ups')));
  // The whole-tracker scan produces the same single action.
  assert.deepEqual(sweepActions(planFullSweep(rows, NOW)).map((a) => a.kind), ['defer-epic']);
});

test('a bucket with a child waking from an expired date is left open (Rule 2 surfaces the child)', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'open', title: 'X — deferred follow-ups' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2026-07-01T00:00:00Z' }), // expired -> wakes
    childOf('E.2', 'E', { status: 'deferred', defer_until: '2027-03-01T00:00:00Z' }),
  ];
  // No defer-epic (it holds waking work), and never a re-bucket.
  assert.deepEqual(planEpicEviction('E', rows, NOW).actions, []);
  // The expired child is still surfaced by Rule 2.
  assert.deepEqual(planFullSweep(rows, NOW).expired.map((x) => x.id), ['E.1']);
});

test('an already-deferred bucket plans nothing — never a second bucket', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'deferred', defer_until: '2027-01-01T00:00:00Z', title: 'X — deferred follow-ups' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(planEpicEviction('E', rows, NOW).actions, []);
  assert.deepEqual(planFullSweep(rows, NOW).staleOpen, []);
});

// ── only an EPIC is planned a close ───────────────────────────────
// A FEATURE with nothing merged and one deferred toggle-cleanup child. Rule 1b
// treated any non-closed parent as an epic, so `epic <id>` planned "close epic".

const featureWithCleanup = (over = {}) => [
  issue('F', { issue_type: 'feature', status: 'open', title: 'The Feature', ...over }),
  childOf('F.1', 'F', { status: 'deferred', title: 'Cleanup: remove the-feature feature toggle' }),
];

test('a feature parent with one deferred cleanup child is never planned a close or an eviction', () => {
  const rows = featureWithCleanup();
  const plan = planEpicEviction('F', rows, NOW);
  assert.deepEqual(plan.actions, [], 'no close-epic, no reparent, no note');
  assert.deepEqual(plan.parentNotEpic, { type: 'feature', status: 'open' });
  assert.deepEqual(plan.deferred.map((c) => c.id), ['F.1'], 'the deferred child is still REPORTED');
  assert.deepEqual(plan.blockedBy, []);
});

test('the same holds for a task or bug, and for an in_progress or deferred parent', () => {
  for (const issueType of ['task', 'bug', 'feature']) {
    for (const status of ['open', 'in_progress', 'deferred']) {
      const plan = planEpicEviction('F', featureWithCleanup({ issue_type: issueType, status }), NOW);
      assert.deepEqual(plan.actions, [], `${issueType}/${status} must plan nothing`);
      assert.deepEqual(plan.parentNotEpic, { type: issueType, status });
    }
  }
});

test('the control: the identical shape under an EPIC still closes it and evicts the child', () => {
  const { actions, parentNotEpic } = planEpicEviction('F', featureWithCleanup({ issue_type: 'epic' }), NOW);
  assert.equal(parentNotEpic, undefined);
  assert.ok(actions.some((a) => a.kind === 'close-epic' && a.id === 'F'));
  assert.ok(actions.some((a) => a.kind === 'reparent' && a.id === 'F.1'));
});

test('a non-epic parent that is already CLOSED still evicts its deferred children, and is never re-closed', () => {
  const { actions, parentNotEpic } = planEpicEviction('F', featureWithCleanup({ status: 'closed' }), NOW);
  assert.equal(parentNotEpic, undefined);
  assert.ok(actions.some((a) => a.kind === 'reparent' && a.id === 'F.1'));
  assert.equal(actions.filter((a) => a.kind === 'close-epic').length, 0);
});

// `epic <id>` exits 1 when real work remains (the hygiene guidance). For a non-epic parent that means live
// (non-deferred, non-closed) children; only deferred ones is exit 0.
test('epic <id> on a non-epic parent with a live child exits 1 and names the child', () => {
  const rows = [
    ...featureWithCleanup(),
    childOf('F.2', 'F', { status: 'in_progress', title: 'The unfinished slice' }),
  ];
  const plan = planEpicEviction('F', rows, NOW);
  const { text, exitCode } = describeNonEpicParent('F', plan);
  assert.equal(exitCode, 1);
  assert.match(text, /F is not an epic \(type feature, open\)/);
  assert.match(text, /F\.2 \[in_progress\] The unfinished slice/);
  assert.match(text, /F\.1 Cleanup: remove the-feature feature toggle/, 'the deferred child is still reported');
});

test('epic <id> on a non-epic parent with only deferred children exits 0', () => {
  const plan = planEpicEviction('F', featureWithCleanup(), NOW);
  const { text, exitCode } = describeNonEpicParent('F', plan);
  assert.equal(exitCode, 0);
  assert.doesNotMatch(text, /live child/);
});

test('the audit does not nominate a feature under Rule 1b, and lists it apart with no actions', () => {
  const rows = [
    ...featureWithCleanup(),
    // A real epic in the same state IS nominated: the rule still works for what it is for.
    issue('E', { issue_type: 'epic', status: 'open' }),
    childOf('E.1', 'E', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  const sweep = planFullSweep(rows, NOW);
  assert.deepEqual(sweep.staleOpen.map((e) => e.epicId), ['E']);
  assert.deepEqual(sweep.nonEpicParents, [
    { parentId: 'F', type: 'feature', title: 'The Feature', deferred: ['F.1'] },
  ]);
  const touched = sweepActions(sweep).map((a) => a.id);
  assert.ok(!touched.includes('F'), 'the feature is not closed');
  assert.ok(!touched.includes('F.1'), 'its cleanup child is not moved');
});

test('a feature with a live child is not even listed as holding deferred children', () => {
  const rows = [...featureWithCleanup(), childOf('F.2', 'F', { status: 'open' })];
  assert.deepEqual(planFullSweep(rows, NOW).nonEpicParents, []);
});

test('a clean tracker plans no actions at all', () => {
  const rows = [
    issue('E', { issue_type: 'epic', status: 'closed' }),
    childOf('E.1', 'E', { status: 'closed' }),
    issue('D', { status: 'deferred', defer_until: '2027-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(sweepActions(planFullSweep(rows, NOW)), []);
});
