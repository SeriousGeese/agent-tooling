// Tests for the SessionStart asks banner hook. The bd call is stubbed, so no bd binary,
// network or real repository is involved; one test runs the hook as a real process to prove
// the contract that matters most: it ALWAYS exits 0 and stays silent when it cannot help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPeople } from '../ask-lib.mjs';
import { buildInboxBanner, buildSessionBanner } from './ask-inbox.mjs';

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

// Other checkouts (scripts/ask-repos.mjs): the banner shows their asks from a cache, never a scan.
const otherRepo = { repo: 'repo-b', path: '/w/repo-b', error: null, asks: [{ id: 'rb-7', title: 'Name the release', status: 'open', by: 'bob', age: '3d ago', repo: 'repo-b', path: '/w/repo-b' }] };
const NOW_MS = NOW.getTime();

/** buildSessionBanner deps over the local stub, with a machine file, a cache and a recorded refresh. */
function session({ checkouts = [{ repo: 'repo-b', path: '/w/repo-b' }], error = null, cached = { person: 'alice', repos: [otherRepo], mtime: NOW_MS - 2 * 60_000 }, lockMtime = null, ...rest } = {}) {
  const base = deps(rest);
  const started = [];
  return {
    ...base,
    started,
    deps: {
      ...base.deps,
      machine: () => ({ checkouts, error }),
      commonDir: () => '/w/self/.git',
      cache: () => cached,
      lockMtime: () => lockMtime,
      start: (dir, person) => started.push([dir, person]),
      nowMs: NOW_MS,
    },
  };
}

test('with no other checkouts configured the banner is exactly what it was', () => {
  const s = session({ checkouts: [] });
  assert.equal(buildSessionBanner(s.deps), buildInboxBanner(deps().deps));
  assert.deepEqual(s.started, []);
});

test('other checkouts come from the cache after this repo, tagged with repo and path; still ONE bd call', () => {
  const s = session();
  const banner = buildSessionBanner(s.deps);
  assert.deepEqual(s.labels, ['ask-alice'], 'the only bd call is this repository\'s');
  assert.deepEqual(s.started, [], 'a fresh cache starts no refresh');
  const lines = banner.split('\n');
  assert.match(lines[0], /^\[asks\] 1 bead is waiting on YOU \(alice\):/);
  assert.ok(lines.indexOf('[asks] Run /asks to review them.') < lines.findIndex((l) => l.includes('other checkouts:')));
  assert.match(banner, /\[asks\] 1 bead is waiting on YOU \(alice\) in other checkouts:\n\[asks\] {3}rb-7 {2}Name the release {2}\[repo-b: \/w\/repo-b\] {2}\(asked by bob, 3d ago\)/);
  assert.match(banner, /other checkouts read 2m ago/);

  // Nothing here, something there: the other checkouts still show.
  const elsewhere = session({ payload: '[]' });
  assert.match(buildSessionBanner(elsewhere.deps), /^\[asks\] 1 bead is waiting on YOU \(alice\) in other checkouts:/);
});

test('a stale, missing or someone-else\'s cache starts ONE detached refresh and shows what it has', () => {
  const stale = session({ cached: { person: 'alice', repos: [otherRepo], mtime: NOW_MS - 60 * 60_000 } });
  assert.match(buildSessionBanner(stale.deps), /rb-7/, 'the old answer still shows');
  assert.deepEqual(stale.started, [['/w/self/.git', 'alice']]);

  const missing = session({ cached: null });
  assert.doesNotMatch(buildSessionBanner(missing.deps), /other checkouts/);
  assert.deepEqual(missing.started, [['/w/self/.git', 'alice']]);

  const bobs = session({ cached: { person: 'bob', repos: [otherRepo], mtime: NOW_MS } });
  assert.doesNotMatch(buildSessionBanner(bobs.deps), /rb-7/, "never another person's asks");
  assert.equal(bobs.started.length, 1);

  const locked = session({ cached: null, lockMtime: NOW_MS - 1000 });
  buildSessionBanner(locked.deps);
  assert.deepEqual(locked.started, [], 'a refresh already running is not started twice');
});

test('a missing checkout is one line; an unreadable machine file is one line; neither is fatal', () => {
  const gone = session({ cached: { person: 'alice', repos: [{ repo: 'gone', path: '/w/gone', asks: [], error: 'checkout /w/gone not found' }], mtime: NOW_MS } });
  assert.match(buildSessionBanner(gone.deps), /\n\[asks\] gone: checkout \/w\/gone not found; skipped\./);
  const bad = session({ checkouts: [], error: '/h/.seriousgeese/agent-tooling.json is not valid JSON (x)' });
  const banner = buildSessionBanner(bad.deps);
  assert.match(banner, /\n\[asks\] \/h\/\.seriousgeese\/agent-tooling\.json is not valid JSON \(x\); asks in other checkouts are not shown\.$/);
  assert.deepEqual(bad.started, []);
});

test('an unrecognised contributor reads no machine file and starts nothing', () => {
  const s = session({ actorBase: 'someone-new' });
  let read = false;
  s.deps.machine = () => { read = true; return { checkouts: [], error: null }; };
  assert.equal(buildSessionBanner(s.deps), '');
  assert.equal(read, false);
});
