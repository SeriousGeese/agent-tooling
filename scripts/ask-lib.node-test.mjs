#!/usr/bin/env node
// Unit tests for the "asks" routing logic. Run: node scripts/run-node-tests.mjs ...
//
// scripts/ask-lib.mjs is deliberately pure, so everything below runs without a bd binary, a
// database, or a filesystem fixture (apart from the one test that proves the people come
// from agent-tooling.json). We pin the decisions that are easy to regress silently:
// identity resolution, the hand-tagged no-metadata path, and the "any open state" filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  NO_REASON,
  askLabel,
  askMetaKeys,
  buildPeople,
  formatAge,
  formatBanner,
  formatDetail,
  parseAsks,
  peopleFromConfig,
  personByKey,
  personKeys,
  resolvePerson,
  summarize,
} from './ask-lib.mjs';
import { parseArgs } from './ask.mjs';

const NOW = new Date('2026-08-22T12:00:00Z');

// Two invented people, one with aliases, so no real person's identity is baked into a test.
const PEOPLE = buildPeople(['alice', 'bob'], {
  alice: { actorBases: ['alice-smith', 'asmith'], emails: ['alice@example.com'] },
  bob: { display: 'Bobby', emails: ['bob@example.com', 'b.ob@example.com'] },
});
const alice = personByKey('alice', PEOPLE);

function row(overrides = {}) {
  return {
    id: 'bd-a1b2',
    title: 'Fix the token drag jitter',
    description: 'Dragging a token drops frames.',
    status: 'open',
    priority: 2,
    labels: ['ask-alice'],
    created_at: '2026-08-19T12:00:00Z',
    metadata: { ask_alice_by: 'bob', ask_alice_at: '2026-08-19T12:00:00Z', ask_alice_reason: 'Need your call.' },
    ...overrides,
  };
}

// ── registry and keys ─────────────────────────────────────────────────────────

test('label and metadata keys are person-prefixed so two asks can coexist', () => {
  assert.equal(askLabel('bob'), 'ask-bob');
  assert.deepEqual(askMetaKeys('bob'), {
    by: 'ask_bob_by', at: 'ask_bob_at', reason: 'ask_bob_reason',
  });
  // The whole point of prefixing: two people's keys never collide.
  const a = askMetaKeys('alice');
  const b = askMetaKeys('bob');
  assert.equal(new Set([...Object.values(a), ...Object.values(b)]).size, 6);
});

test('person keys are unique and lookup is case-insensitive', () => {
  assert.deepEqual(personKeys(PEOPLE), ['alice', 'bob']);
  assert.equal(personByKey('BOB', PEOPLE)?.key, 'bob');
  assert.equal(personByKey('  alice  ', PEOPLE)?.key, 'alice');
  assert.equal(personByKey('nobody', PEOPLE), undefined);
  assert.equal(personByKey('', PEOPLE), undefined);
});

test('buildPeople lower-cases, drops blanks and duplicates, and derives a display name', () => {
  const built = buildPeople(['Carol', 'carol', '', '  ', 'dan']);
  assert.deepEqual(built.map((p) => p.key), ['carol', 'dan']);
  assert.equal(built[0].display, 'Carol');
  assert.deepEqual(buildPeople(undefined), []);
  assert.deepEqual(buildPeople(null), []);
  assert.equal(PEOPLE[1].display, 'Bobby', 'an alias display name wins');
});

test('no actor base is claimed by two people, since an ask must route to exactly one inbox', () => {
  const seen = new Set();
  for (const person of PEOPLE) {
    for (const base of person.actorBases) {
      assert.ok(!seen.has(base), `actor base "${base}" is claimed by more than one person`);
      seen.add(base);
    }
  }
  // buildPeople enforces it: a base named by two handles stays with the first.
  const clash = buildPeople(['one', 'two'], { two: { actorBases: ['one-bot', 'two-alt'] } });
  assert.ok(!clash[1].actorBases.includes('one-bot'));
  assert.ok(clash[1].actorBases.includes('two-alt'));
});

test('the people come from agent-tooling.json, and a missing or broken file means nobody', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ask-lib-cfg-'));
  try {
    writeFileSync(path.join(dir, 'agent-tooling.json'), JSON.stringify({ people: ['erin', 'frank'] }));
    assert.deepEqual(personKeys(peopleFromConfig({ root: dir })), ['erin', 'frank']);
    writeFileSync(path.join(dir, 'agent-tooling.json'), '{not json');
    assert.deepEqual(peopleFromConfig({ root: dir }), [], 'fail-open: a broken config reads as nobody');
    rmSync(path.join(dir, 'agent-tooling.json'));
    assert.deepEqual(peopleFromConfig({ root: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── identity resolution ───────────────────────────────────────────────────────

test('ASK_PERSON overrides everything, including a conflicting actor base', () => {
  const got = resolvePerson({ env: { ASK_PERSON: 'bob' }, actorBase: 'alice', people: PEOPLE });
  assert.equal(got?.key, 'bob');
});

test('ASK_PERSON naming an unknown person resolves to null, not a silent fallback', () => {
  assert.equal(resolvePerson({ env: { ASK_PERSON: 'mallory' }, actorBase: 'alice', people: PEOPLE }), null);
});

test('every registered actor base resolves back to its own person', () => {
  for (const person of PEOPLE) {
    for (const base of person.actorBases) {
      assert.equal(resolvePerson({ env: {}, actorBase: base, people: PEOPLE })?.key, person.key, `base ${base}`);
    }
  }
});

test('agent/bot identities fold into the human who runs them', () => {
  // scripts/agent-actor-id.mjs slugs "Alice Bot" to "alice-bot"; an agent session must land
  // in alice's inbox, not nowhere. A longer base that starts with the handle does too.
  assert.equal(resolvePerson({ env: {}, actorBase: 'alice-bot', people: PEOPLE })?.key, 'alice');
  assert.equal(resolvePerson({ env: {}, actorBase: 'bob-laptop', people: PEOPLE })?.key, 'bob');
  assert.equal(resolvePerson({ env: {}, actorBase: 'bobby', people: PEOPLE }), null, 'a prefix needs the dash');
});

test('git email is the fallback when there is no agent env at all', () => {
  assert.equal(resolvePerson({ env: {}, gitEmail: 'bob@example.com', people: PEOPLE })?.key, 'bob');
  assert.equal(resolvePerson({ env: {}, gitEmail: 'BOB@EXAMPLE.COM', people: PEOPLE })?.key, 'bob');
  assert.equal(resolvePerson({ env: {}, gitEmail: '<alice@example.com>', people: PEOPLE })?.key, 'alice');
});

test('an unrecognised contributor resolves to null so the hook stays silent', () => {
  assert.equal(resolvePerson({ env: {}, actorBase: 'someone-new', gitEmail: 'new@example.com', people: PEOPLE }), null);
  assert.equal(resolvePerson({ people: PEOPLE, env: {} }), null);
  assert.equal(resolvePerson({ env: {}, actorBase: 'alice', people: [] }), null, 'nobody configured, nobody resolves');
});

// ── parseAsks ─────────────────────────────────────────────────────────────────

test('closed beads are dropped; every other status survives', () => {
  // This is what makes `--all` minus closed mean "any open state": no --status enumeration to
  // keep in sync as bd adds statuses.
  const statuses = ['open', 'in_progress', 'blocked', 'deferred', 'pinned', 'hooked'];
  const rows = statuses.map((status, i) => row({ id: `bd-${i}`, status }));
  rows.push(row({ id: 'bd-closed', status: 'closed' }));
  rows.push(row({ id: 'bd-CLOSED-CASE', status: 'CLOSED' }));

  const got = parseAsks(rows, 'alice', { now: NOW });
  assert.equal(got.length, statuses.length);
  assert.ok(!got.some((a) => a.id.toLowerCase().includes('closed')));
});

test('a deferred bead surfaces: the case bd ready hides and the whole feature exists for', () => {
  const got = parseAsks([row({ status: 'deferred', defer_until: '2027-02-21T18:15:42Z' })], 'alice', { now: NOW });
  assert.equal(got.length, 1);
  assert.equal(got[0].status, 'deferred');
  assert.equal(got[0].deferUntil, '2027-02-21T18:15:42Z');
});

test('a hand-tagged bead with NO metadata renders cleanly instead of breaking', () => {
  // `bd tag bd-x ask-alice` is a supported way to raise an ask. The reason is optional, so
  // there may be no metadata object at all.
  const got = parseAsks([row({ metadata: undefined })], 'alice', { now: NOW });
  assert.equal(got.length, 1);
  assert.equal(got[0].reason, '');
  assert.equal(got[0].by, '');
  assert.equal(got[0].at, '2026-08-19T12:00:00Z', 'falls back to created_at for age');
  assert.match(formatDetail(got[0]), /no reason given/);
});

test('metadata bd coerced to a number is read back as a string', () => {
  // `--set-metadata a=1` reads back as JSON number 1.
  const got = parseAsks([row({ metadata: { ask_alice_by: 'bob', ask_alice_reason: 42 } })], 'alice', { now: NOW });
  assert.equal(got[0].reason, '42');
});

test('rows are filtered to the requested person, so one inbox never shows the other', () => {
  const rows = [row({ id: 'bd-mine', labels: ['ask-alice'] }), row({ id: 'bd-theirs', labels: ['ask-bob'] })];
  assert.deepEqual(parseAsks(rows, 'alice', { now: NOW }).map((a) => a.id), ['bd-mine']);
  assert.deepEqual(parseAsks(rows, 'bob', { now: NOW }).map((a) => a.id), ['bd-theirs']);
});

test('a bead asked of both people appears in both inboxes with each own reason', () => {
  const both = row({
    id: 'bd-both',
    labels: ['ask-alice', 'ask-bob'],
    metadata: { ask_alice_reason: 'for alice', ask_bob_reason: 'for bob' },
  });
  assert.equal(parseAsks([both], 'alice', { now: NOW })[0].reason, 'for alice');
  assert.equal(parseAsks([both], 'bob', { now: NOW })[0].reason, 'for bob');
});

test('bd omits labels/metadata entirely when empty, and that must not throw', () => {
  // A bead with no labels comes back with NO `labels` key at all, not `labels: []`. Same for
  // `metadata`.
  const bare = { id: 'bd-bare', title: 'no labels, no metadata', status: 'open' };
  const got = parseAsks([bare], 'alice', { now: NOW });
  assert.equal(got.length, 1);
  assert.equal(got[0].reason, '');
  assert.doesNotThrow(() => formatDetail(got[0]));
});

test('oldest ask sorts first, and an undated ask sorts last rather than vanishing', () => {
  const rows = [
    row({ id: 'bd-new', metadata: { ask_alice_at: '2026-08-21T12:00:00Z' } }),
    row({ id: 'bd-undated', metadata: {}, created_at: '' }),
    row({ id: 'bd-old', metadata: { ask_alice_at: '2026-08-01T12:00:00Z' } }),
  ];
  assert.deepEqual(parseAsks(rows, 'alice', { now: NOW }).map((a) => a.id),
    ['bd-old', 'bd-new', 'bd-undated']);
});

test('junk rows are skipped without throwing', () => {
  assert.deepEqual(parseAsks([null, undefined, 'nope', 7], 'alice', { now: NOW }), []);
  assert.deepEqual(parseAsks(null, 'alice', { now: NOW }), []);
});

// ── formatting ────────────────────────────────────────────────────────────────

test('summarize takes the first real paragraph, skipping headings and fences', () => {
  const description = [
    '## Problem', '', 'Dragging a token drops frames on touch devices.',
    'It only reproduces above 200px/s.', '', '## Notes', 'irrelevant',
  ].join('\n');
  assert.equal(summarize(description),
    'Dragging a token drops frames on touch devices. It only reproduces above 200px/s.');
});

test('summarize ignores fenced code and strips list markers', () => {
  assert.equal(summarize('```\nnpm run build\n```\n\n- first point\n- second point'),
    'first point second point');
  assert.equal(summarize(''), '');
  assert.equal(summarize(undefined), '');
});

test('summarize truncates on a word boundary', () => {
  const long = `${'alpha bravo '.repeat(40)}`;
  const got = summarize(long, { maxChars: 40 });
  assert.ok(got.length <= 41, got);
  assert.match(got, /…$/);
  assert.ok(!/\balph…$/.test(got), 'must not cut mid-word');
});

test('formatAge is compact and never negative-looking', () => {
  assert.equal(formatAge('2026-08-22T09:00:00Z', NOW), 'today');
  assert.equal(formatAge('2026-08-21T09:00:00Z', NOW), '1d ago');
  assert.equal(formatAge('2026-08-19T12:00:00Z', NOW), '3d ago');
  assert.equal(formatAge('2026-06-01T12:00:00Z', NOW), '2mo ago');
  assert.equal(formatAge('2026-09-01T12:00:00Z', NOW), 'just now', 'clock skew must not print "-10d ago"');
  assert.equal(formatAge('not a date', NOW), '');
  assert.equal(formatAge('', NOW), '');
});

test('the banner is empty when there is nothing to say, so the hook stays silent', () => {
  assert.equal(formatBanner([], alice), '');
  assert.equal(formatBanner(parseAsks([], 'alice'), alice), '');
  assert.equal(formatBanner([{ id: 'bd-a', title: 't' }], null), '');
});

test('the banner names the count, the person, and each bead', () => {
  const asks = parseAsks([row()], 'alice', { now: NOW });
  const banner = formatBanner(asks, alice);
  assert.match(banner, /^\[asks\] 1 bead is waiting on YOU \(alice\):/);
  assert.match(banner, /bd-a1b2  Fix the token drag jitter {2}\(asked by bob, 3d ago\)/);
  assert.match(banner, /Run \/asks to review them\.$/);
  // Every line must carry the prefix so it reads as one block at session start.
  for (const line of banner.split('\n')) assert.match(line, /^\[asks\] /);
});

test('the banner names whichever person it is rendered for', () => {
  const asks = parseAsks([row({ labels: ['ask-bob'], metadata: { ask_bob_by: 'alice' } })], 'bob', { now: NOW });
  assert.match(formatBanner(asks, personByKey('bob', PEOPLE)), /waiting on YOU \(bob\)/);
});

test('the banner pluralises and flags deferred beads', () => {
  const asks = parseAsks([row({ id: 'bd-1' }), row({ id: 'bd-2', status: 'deferred' })], 'alice', { now: NOW });
  const banner = formatBanner(asks, alice);
  assert.match(banner, /2 beads are waiting/);
  assert.match(banner, /bd-2.*\[deferred\]/);
});

test('the banner caps its list so a busy day cannot flood session start', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ id: `bd-${i}`, metadata: { ask_alice_at: `2026-08-0${i + 1}T12:00:00Z` } }));
  const banner = formatBanner(parseAsks(rows, 'alice', { now: NOW }), alice, { max: 5 });
  assert.match(banner, /9 beads are waiting/);
  assert.match(banner, /…and 4 more\./);
  assert.equal(banner.split('\n').filter((l) => /bd-/.test(l)).length, 5);
});

test('formatDetail shows the reason, or says plainly that there is none', () => {
  const [withReason] = parseAsks([row()], 'alice', { now: NOW });
  assert.match(formatDetail(withReason), /reason: {2}Need your call\./);
  assert.match(formatDetail(withReason), /status: open {2}\| {2}P2/);

  const [without] = parseAsks([row({ metadata: {} })], 'alice', { now: NOW });
  assert.match(formatDetail(without), new RegExp(NO_REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(formatDetail(null), '');
});

// ── CLI argument parsing ──────────────────────────────────────────────────────

test('the bare form is add: the common case needs no verb', () => {
  const got = parseArgs(['bd-a1b2', 'bob', 'because', 'reasons']);
  assert.equal(got.command, 'add');
  assert.deepEqual(got.positional, ['bd-a1b2', 'bob', 'because', 'reasons']);
});

test('an ask with no reason parses fine, since the reason is optional', () => {
  const got = parseArgs(['bd-a1b2', 'bob']);
  assert.equal(got.command, 'add');
  assert.deepEqual(got.positional, ['bd-a1b2', 'bob']);
});

test('explicit verbs and no args at all', () => {
  assert.equal(parseArgs([]).command, 'list');
  assert.equal(parseArgs(['list']).command, 'list');
  assert.deepEqual(parseArgs(['clear', 'bd-a1b2', 'bob']).positional, ['bd-a1b2', 'bob']);
  assert.deepEqual(parseArgs(['add', 'bd-a1b2', 'bob']).positional, ['bd-a1b2', 'bob']);
});

test('flags parse in both forms and do not leak into positionals', () => {
  assert.equal(parseArgs(['list', '--for', 'bob']).flags.forKey, 'bob');
  assert.equal(parseArgs(['list', '--for=bob']).flags.forKey, 'bob');
  assert.equal(parseArgs(['list', '--json']).flags.json, true);
  assert.equal(parseArgs(['bd-a', 'bob', '--replace']).flags.replace, true);
  assert.deepEqual(parseArgs(['bd-a', 'bob', '--replace']).positional, ['bd-a', 'bob']);
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
});

test('an unknown flag is rejected rather than silently treated as a reason', () => {
  assert.throws(() => parseArgs(['bd-a', 'bob', '--oops']), /Unknown flag/);
});
