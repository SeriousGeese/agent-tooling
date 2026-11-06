#!/usr/bin/env node
// Unit tests for the idea inbox's pure decisions. Run: npm run test:scripts
//
// The bd-touching side (create, note, ask) is a thin shell over the hygiene bd helper and ask.mjs; what is
// pinned here is the part that regresses silently: which bead is THE inbox, which asks need
// re-raising after a triage, and the note format.
import test from 'node:test';
import assert from 'node:assert/strict';

import { INBOX_LABEL, addIdea, formatIdeaNote, missingAsks, parseArgs, pickInbox } from './idea-inbox.mjs';

/** Fake bd + sync: `lists` is consumed one per list() call; every write is recorded in `calls`. */
function fakeDeps({ pulls = [true, true], pushes = [true, true], lists = [[]], createId = 'bd-mine' } = {}) {
  const calls = [];
  const take = (queue, fallback) => (queue.length ? queue.shift() : fallback);
  return {
    calls,
    deps: {
      actor: () => 'bot',
      people: () => ['ann', 'bob'],
      pull: () => take(pulls, true),
      push: () => { calls.push(['push']); return take(pushes, true); },
      list: () => take(lists, []),
      create: () => { calls.push(['create']); return createId; },
      note: (id) => calls.push(['note', id]),
      close: (id, reason) => calls.push(['close', id, reason]),
      ask: (id, person) => calls.push(['ask', id, person]),
      log: () => {},
      error: () => {},
    },
  };
}

const FULL_ASKS = [INBOX_LABEL, 'human-required', 'ask-ann', 'ask-bob'];

test('addIdea writes nothing and fails when the pull cannot be verified', () => {
  const { calls, deps } = fakeDeps({ pulls: [false] });
  assert.equal(addIdea('an idea', '', deps), 1);
  assert.deepEqual(calls, []);
});

test('addIdea appends to the existing inbox without creating one', () => {
  const { calls, deps } = fakeDeps({ lists: [[{ id: 'bd-inbox', status: 'open', labels: FULL_ASKS }]] });
  assert.equal(addIdea('an idea', '', deps), 0);
  assert.deepEqual(calls, [['note', 'bd-inbox'], ['push']]);
});

test('addIdea reports a failed push as a failure', () => {
  const { deps } = fakeDeps({ pushes: [false], lists: [[{ id: 'bd-inbox', status: 'open', labels: FULL_ASKS }]] });
  assert.equal(addIdea('an idea', '', deps), 1);
});

test('a concurrent create loses to the older inbox: the idea moves there and the duplicate closes', () => {
  const older = { id: 'bd-theirs', status: 'open', created_at: '2026-10-25T10:00:00Z', labels: FULL_ASKS };
  const mine = { id: 'bd-mine', status: 'open', created_at: '2026-10-25T10:00:01Z', labels: FULL_ASKS };
  const { calls, deps } = fakeDeps({ lists: [[], [mine, older]] });
  assert.equal(addIdea('an idea', '', deps), 0);
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['create'], ['note', 'bd-mine'], ['push'],
    ['note', 'bd-theirs'], ['close', 'bd-mine'], ['push'],
  ]);
});

test('a create that wins the race keeps its inbox and raises both asks', () => {
  const mine = { id: 'bd-mine', status: 'open', created_at: '2026-10-25T10:00:00Z', labels: [INBOX_LABEL] };
  const { calls, deps } = fakeDeps({ lists: [[], [mine]] });
  assert.equal(addIdea('an idea', '', deps), 0);
  assert.equal(calls.filter((c) => c[0] === 'close').length, 0);
  assert.deepEqual(calls.filter((c) => c[0] === 'ask').map((c) => c[2]).sort(), ['ann', 'bob']);
});

test('a failed re-check after creating is reported, never silently green', () => {
  const { deps } = fakeDeps({ pulls: [true, false], lists: [[]] });
  assert.equal(addIdea('an idea', '', deps), 1);
});

test('pickInbox ignores closed inboxes and returns the oldest open one', () => {
  const rows = [
    { id: 'bd-new', status: 'open', created_at: '2026-10-25T10:00:00Z' },
    { id: 'bd-closed', status: 'closed', created_at: '2026-10-01T10:00:00Z' },
    { id: 'bd-old', status: 'open', created_at: '2026-10-20T10:00:00Z' },
  ];
  assert.equal(pickInbox(rows).id, 'bd-old');
});

test('pickInbox treats a deferred inbox as open, so ideas never go to a second one', () => {
  assert.equal(pickInbox([{ id: 'bd-d', status: 'deferred', created_at: 'x' }]).id, 'bd-d');
});

test('pickInbox returns null when every inbox is closed or none exists', () => {
  assert.equal(pickInbox([{ id: 'bd-c', status: 'closed' }]), null);
  assert.equal(pickInbox([]), null);
  assert.equal(pickInbox(undefined), null);
});

test('missingAsks names each person whose ask label was cleared', () => {
  const row = { labels: [INBOX_LABEL, 'human-required', 'ask-ann'] };
  assert.deepEqual(missingAsks(row, ['ann', 'bob']), ['bob']);
  assert.deepEqual(missingAsks({ labels: ['ask-ann', 'ask-bob'] }, ['ann', 'bob']), []);
});

test('formatIdeaNote is one line with date, actor and optional source', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  assert.equal(
    formatIdeaNote('  Add a\nminimap  ', { actor: 'bot', source: 'bd-xyz', now }),
    '[idea 2026-10-25 by bot] Add a minimap (source: bd-xyz)',
  );
  assert.equal(formatIdeaNote('x', { actor: 'bot', now }), '[idea 2026-10-25 by bot] x');
  assert.throws(() => formatIdeaNote('   ', { actor: 'bot', now }));
});

test('parseArgs reads the idea and --source', () => {
  assert.deepEqual(parseArgs(['add', 'idea text', '--source', 'bd-1']), {
    command: 'add',
    positional: ['idea text'],
    source: 'bd-1',
    json: false,
  });
});
