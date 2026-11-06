// Tests for the SessionStart asks banner hook. The bd call is stubbed, so no bd binary,
// network or real repository is involved; one test runs the hook as a real process to prove
// the contract that matters most: it ALWAYS exits 0 and stays silent when it cannot help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPeople } from '../ask-lib.mjs';
import { buildInboxBanner } from './ask-inbox.mjs';

const HOOK = fileURLToPath(new URL('./ask-inbox.mjs', import.meta.url));
const NOW = new Date('2026-08-22T12:00:00Z');
const PEOPLE = buildPeople(['alice', 'bob'], { bob: { emails: ['bob@example.com'] } });

const row = (extra = {}) => ({
  id: 'bd-a1b2',
  title: 'Pick a debounce',
  status: 'open',
  labels: ['ask-alice'],
  created_at: '2026-08-19T12:00:00Z',
  metadata: { ask_alice_by: 'bob', ask_alice_at: '2026-08-19T12:00:00Z' },
  ...extra,
});

/** deps with a recording bd stub that returns `payload` (a string, or a function of the label). */
function deps({ actorBase = 'alice', gitEmail = '', payload = JSON.stringify([row()]), env = {} } = {}) {
  const labels = [];
  return {
    labels,
    deps: {
      actor: () => ({ base: actorBase }),
      gitEmail: () => gitEmail,
      bdList: (label) => {
        labels.push(label);
        return typeof payload === 'function' ? payload(label) : payload;
      },
      env,
      people: PEOPLE,
      now: NOW,
    },
  };
}

test('prints the banner for the resolved person with ONE bd call on their label', () => {
  const { deps: d, labels } = deps();
  const banner = buildInboxBanner(d);
  assert.deepEqual(labels, ['ask-alice']);
  assert.match(banner, /^\[asks\] 1 bead is waiting on YOU \(alice\):/);
  assert.match(banner, /bd-a1b2 {2}Pick a debounce {2}\(asked by bob, 3d ago\)/);
  assert.match(banner, /Run \/asks to review them\.$/);
});

test('resolves by git email when the actor base is unknown, and by ASK_PERSON over both', () => {
  const byEmail = deps({ actorBase: 'unknown', gitEmail: 'bob@example.com', payload: JSON.stringify([row({ labels: ['ask-bob'] })]) });
  assert.match(buildInboxBanner(byEmail.deps), /waiting on YOU \(bob\)/);
  assert.deepEqual(byEmail.labels, ['ask-bob']);

  const override = deps({ actorBase: 'alice', env: { ASK_PERSON: 'bob' }, payload: JSON.stringify([row({ labels: ['ask-bob'] })]) });
  buildInboxBanner(override.deps);
  assert.deepEqual(override.labels, ['ask-bob']);
});

test('an unrecognised contributor gets nothing and bd is never called', () => {
  const { deps: d, labels } = deps({ actorBase: 'someone-new' });
  assert.equal(buildInboxBanner(d), '');
  assert.deepEqual(labels, []);
});

test('says nothing for an empty inbox, empty output, closed beads, or no people configured', () => {
  assert.equal(buildInboxBanner(deps({ payload: '[]' }).deps), '');
  assert.equal(buildInboxBanner(deps({ payload: '' }).deps), '');
  assert.equal(buildInboxBanner(deps({ payload: JSON.stringify([row({ status: 'closed' })]) }).deps), '');
  const none = deps();
  none.deps.people = [];
  assert.equal(buildInboxBanner(none.deps), '');
});

test('accepts the {issues: [...]} shape bd sometimes returns', () => {
  const { deps: d } = deps({ payload: JSON.stringify({ issues: [row(), row({ id: 'bd-c3d4', status: 'deferred' })] }) });
  const banner = buildInboxBanner(d);
  assert.match(banner, /2 beads are waiting/);
  assert.match(banner, /bd-c3d4.*\[deferred\]/);
});

test('failures throw out of buildInboxBanner (the entry point is what swallows them)', () => {
  assert.throws(() => buildInboxBanner(deps({ payload: '{not json' }).deps));
  const boom = deps();
  boom.deps.bdList = () => { throw new Error('bd missing'); };
  assert.throws(() => buildInboxBanner(boom.deps), /bd missing/);
});

test('as a process: exits 0 and prints nothing when bd is absent and nobody is configured', () => {
  // The config walk starts at this repository's scripts/ and finds no agent-tooling.json, so no
  // people are configured; PATH is emptied so there is no bd or git to call either way.
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: { PATH: '', SystemRoot: process.env.SystemRoot ?? '', BEADS_ACTOR: 'alice-bot-deadbeef', ASK_PERSON: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
