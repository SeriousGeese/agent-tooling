// scripts/ask-repos.mjs: the asks of the OTHER checkouts listed in the per-machine file, read by
// ask.mjs list directly and by the SessionStart banner from a cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPeople } from './ask-lib.mjs';
import { main as askMain } from './ask.mjs';
import { BD_MAX_BUFFER } from './lib/bd-cli.mjs';
import {
  BD_TIMEOUT_MS,
  CACHE_NAME,
  LOCK_NAME,
  REFRESH_AFTER_MS,
  bdListIn,
  formatOtherRepos,
  machineConfigPath,
  needsRefresh,
  normalise,
  parseMachineConfig,
  readCache,
  readMachineCheckouts,
  readOtherRepos,
  refreshCache,
} from './ask-repos.mjs';
import { removeTempDir } from './test-support/cleanup.mjs';

const NOW = new Date('2026-08-22T12:00:00Z');
const PEOPLE = buildPeople(['alice', 'bob']);
const ALICE = PEOPLE[0];

const ask = (id, title, extra = {}) => ({
  id,
  title,
  status: 'open',
  labels: ['ask-alice'],
  metadata: { ask_alice_by: 'bob', ask_alice_at: '2026-08-19T12:00:00Z' },
  ...extra,
});

test('the machine file: an object of repo to path, or an array; a missing file is no checkouts and no error', () => {
  assert.deepEqual(parseMachineConfig(JSON.stringify({ checkouts: { 'repo-a': '/w/repo-a', 'repo-b': '/w/b' } })), {
    checkouts: [{ repo: 'repo-a', path: '/w/repo-a' }, { repo: 'repo-b', path: '/w/b' }],
    error: null,
  });
  assert.deepEqual(parseMachineConfig(JSON.stringify({ checkouts: ['/w/repo-a/', { repo: 'other', path: '/w/x' }, { path: '' }] })).checkouts, [
    { repo: 'repo-a', path: '/w/repo-a/' },
    { repo: 'other', path: '/w/x' },
  ]);
  assert.deepEqual(parseMachineConfig(JSON.stringify({ unrelated: 1 })), { checkouts: [], error: null }, 'other keys are ignored');
  assert.match(parseMachineConfig('{nope').error, /not valid JSON/);
  assert.match(parseMachineConfig(JSON.stringify({ checkouts: 'x' })).error, /"checkouts" must be/);

  assert.equal(machineConfigPath({}, '/home/u'), path.join('/home/u', '.seriousgeese', 'agent-tooling.json'));
  assert.equal(machineConfigPath({ AGENT_TOOLING_MACHINE_CONFIG: '/etc/m.json' }, '/home/u'), '/etc/m.json');
  const missing = readMachineCheckouts({ env: {}, home: path.join(os.tmpdir(), 'no-such-home-ask-repos') });
  assert.deepEqual([missing.checkouts, missing.error], [[], null]);
  const unreadable = readMachineCheckouts({ env: {}, home: '/h', readFile: () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } });
  assert.match(unreadable.error, /cannot read .*EACCES/);
});

/** readOtherRepos' edges for a machine with two other repos, this one, a twin path and a missing one. */
function machine() {
  const common = { '/w/repo-a': '/w/repo-a/.git', '/w/repo-b': '/w/repo-b/.git', '/w/self': '/w/self/.git', '/w/self-wt': '/w/self/.git', '/w/broken': '/w/broken/.git' };
  const asked = [];
  return {
    asked,
    checkouts: [
      { repo: 'self', path: '/w/self-wt' },
      { repo: 'repo-a', path: '/w/repo-a' },
      { repo: 'gone', path: '/w/gone' },
      { repo: 'repo-b', path: '/w/repo-b' },
      { repo: 'broken', path: '/w/broken' },
    ],
    edges: {
      exists: (p) => p !== '/w/gone',
      commonDirOf: (p) => common[p] ?? null,
      bdList: (checkout, label) => {
        asked.push([checkout, label]);
        if (checkout === '/w/broken') throw Object.assign(new Error('bd failed'), { stderr: 'Error: no beads database found\nmore' });
        if (checkout === '/w/repo-a') return JSON.stringify([ask('ra-1', 'Pick a colour'), ask('ra-2', 'Done already', { status: 'closed' })]);
        return JSON.stringify({ issues: [ask('rb-7', 'Name the release')] });
      },
    },
  };
}

test('two other repos are read and tagged; this repo (by common dir), a missing checkout and a broken tracker are not fatal', () => {
  const m = machine();
  const repos = readOtherRepos({ personKey: 'alice', checkouts: m.checkouts, selfCommonDir: '/w/self/.git', now: NOW, ...m.edges });
  assert.deepEqual(m.asked.map(([c]) => c), ['/w/repo-a', '/w/repo-b', '/w/broken'], 'this repo, even through a worktree path, is never read');
  assert.deepEqual(m.asked.map(([, l]) => l), ['ask-alice', 'ask-alice', 'ask-alice']);
  assert.deepEqual(repos.map((r) => [r.repo, r.asks.map((a) => a.id), r.error]), [
    ['repo-a', ['ra-1'], null],
    ['gone', [], 'checkout /w/gone not found'],
    ['repo-b', ['rb-7'], null],
    ['broken', [], 'its tracker could not be read (Error: no beads database found)'],
  ]);
  assert.deepEqual([repos[0].asks[0].repo, repos[0].asks[0].path], ['repo-a', '/w/repo-a']);

  const lines = formatOtherRepos(repos, ALICE, { ageMs: 5 * 60_000 });
  assert.equal(lines[0], '[asks] 2 beads are waiting on YOU (alice) in other checkouts:');
  assert.match(lines[1], /^\[asks\] {3}ra-1 {2}Pick a colour {2}\[repo-a: \/w\/repo-a\] {2}\(asked by bob, 3d ago\)$/);
  assert.match(lines[2], /rb-7 {2}Name the release {2}\[repo-b: \/w\/repo-b\]/);
  assert.equal(lines[3], '[asks] gone: checkout /w/gone not found; skipped.');
  assert.match(lines[4], /^\[asks\] broken: its tracker could not be read/);
  assert.equal(lines.at(-1), '[asks] (other checkouts read 5m ago; run /asks from that checkout to act on one)');
  assert.deepEqual(formatOtherRepos([{ repo: 'x', path: '/x', asks: [], error: null }], ALICE), [], 'nothing to say: no lines');
});

test('bdListIn reads through the shared bd caller with its own timeout; a failure names its cause, not the command', () => {
  let seen;
  const out = bdListIn('/w/repo-a', 'ask-alice', { exec: (cmd, args, opts) => { seen = { cmd, args, opts }; return '[]'; } });
  assert.equal(out, '[]');
  assert.equal(seen.cmd, 'bd');
  assert.deepEqual(seen.args, ['-C', '/w/repo-a', 'list', '--label', 'ask-alice', '--all', '--json', '-n', '0']);
  assert.equal(seen.opts.timeout, BD_TIMEOUT_MS);
  assert.equal(BD_TIMEOUT_MS, 30_000);
  assert.equal(seen.opts.maxBuffer, BD_MAX_BUFFER);
  assert.equal(seen.opts.windowsHide, true);

  const errorFor = (thrown) => readOtherRepos({
    personKey: 'alice',
    checkouts: [{ repo: 'repo-a', path: '/w/repo-a' }],
    selfCommonDir: '/w/self/.git',
    now: NOW,
    exists: () => true,
    commonDirOf: () => '/w/repo-a/.git',
    bdList: (checkout, label) => bdListIn(checkout, label, { exec: () => { throw thrown; } }),
  })[0].error;
  assert.equal(
    errorFor(Object.assign(new Error('spawnSync bd ETIMEDOUT'), { code: 'ETIMEDOUT' })),
    'its tracker could not be read (spawnSync bd ETIMEDOUT)',
  );
  assert.equal(
    errorFor(Object.assign(new Error('Command failed: bd -C /w/repo-a list'), { stderr: 'Error: no beads database found\nmore' })),
    'its tracker could not be read (Error: no beads database found)',
  );
});

test('the cache: a refresh writes it whole under a lock; needsRefresh reads its age, its person and the lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-repos-cache-'));
  t.after(() => removeTempDir(dir, 'ask-repos.node-test'));
  const now = Date.now();
  assert.equal(needsRefresh({ cacheMtime: null, lockMtime: null, personKey: 'alice', now }), true, 'no cache yet');
  assert.equal(needsRefresh({ cacheMtime: now - 60_000, lockMtime: null, cachedPerson: 'alice', personKey: 'alice', now }), false, 'fresh');
  assert.equal(needsRefresh({ cacheMtime: now - REFRESH_AFTER_MS, lockMtime: null, cachedPerson: 'alice', personKey: 'alice', now }), true, 'old');
  assert.equal(needsRefresh({ cacheMtime: now - 60_000, lockMtime: null, cachedPerson: 'bob', personKey: 'alice', now }), true, "someone else's");
  assert.equal(needsRefresh({ cacheMtime: null, lockMtime: now - 1000, personKey: 'alice', now }), false, 'a refresh is running');

  const m = machine();
  let seenSelf = null;
  // The fixture's edges know this repo as /w/self/.git; what the refresh passes is checked separately.
  const read = (opts) => { seenSelf = opts.selfCommonDir; return readOtherRepos({ ...opts, selfCommonDir: '/w/self/.git', now: NOW, ...m.edges }); };
  assert.equal(refreshCache({ commonDir: dir, personKey: 'alice', read, machine: () => ({ checkouts: m.checkouts, error: null }) }), true);
  assert.equal(seenSelf, normalise(dir), 'the refresh skips its own repository by common dir');
  assert.ok(!fs.existsSync(path.join(dir, LOCK_NAME)), 'the lock is released');
  assert.deepEqual(fs.readdirSync(dir), [CACHE_NAME], 'no temp file left behind');
  const cached = readCache(dir);
  assert.equal(cached.person, 'alice');
  assert.deepEqual(cached.repos.map((r) => r.repo), ['repo-a', 'gone', 'repo-b', 'broken']);

  // A live lock: another refresh is running, so this one does nothing.
  fs.writeFileSync(path.join(dir, LOCK_NAME), '');
  let ran = false;
  assert.equal(refreshCache({ commonDir: dir, personKey: 'alice', read: () => { ran = true; return []; }, machine: () => ({ checkouts: [], error: null }) }), false);
  assert.equal(ran, false);
  assert.equal(readCache(path.join(dir, 'nope')), null);
});

test('ask.mjs list shows the other checkouts after this one, each with its repo and path; JSON carries them', () => {
  const m = machine();
  const out = { log: [], warn: [], error: [] };
  const deps = {
    bd: (args) => (args[0] === 'list' && args[1] === '--label' ? JSON.stringify([ask('self-1', 'Here', { labels: ['ask-alice'] })]) : ''),
    sync: () => ({ ok: true }),
    gitEmail: () => '',
    actor: () => ({ base: 'alice' }),
    env: {},
    people: PEOPLE,
    now: () => NOW,
    machine: () => ({ checkouts: m.checkouts, error: null }),
    otherRepos: (personKey, checkouts, now) => readOtherRepos({ personKey, checkouts, selfCommonDir: '/w/self/.git', now, ...m.edges }),
    log: (l) => out.log.push(l),
    warn: (l) => out.warn.push(l),
    error: (l) => out.error.push(l),
  };
  assert.equal(askMain(['list'], deps), 0);
  const text = out.log.join('\n');
  assert.match(text, /^1 bead is waiting on Alice:/);
  assert.match(text, /\[repo-a\] 1 bead is waiting on Alice in \/w\/repo-a \(act on them from there\):\n\nra-1 {2}Pick a colour/);
  assert.match(text, /\[repo-b\] 1 bead is waiting on Alice in \/w\/repo-b/);
  assert.ok(text.indexOf('self-1') < text.indexOf('ra-1'), 'this repository first');
  assert.deepEqual(out.warn, ['[ask] gone: checkout /w/gone not found; skipped.', '[ask] broken: its tracker could not be read (Error: no beads database found); skipped.']);

  out.log.length = 0;
  assert.equal(askMain(['list', '--json'], deps), 0);
  const json = JSON.parse(out.log.join(''));
  assert.deepEqual(json.asks.map((a) => a.id), ['self-1']);
  assert.deepEqual(json.others.map((r) => [r.repo, r.asks.map((a) => a.id)]), [['repo-a', ['ra-1']], ['gone', []], ['repo-b', ['rb-7']], ['broken', []]]);

  // No machine file: the list (and its JSON) is exactly what it was.
  out.log.length = 0;
  assert.equal(askMain(['list', '--json'], { ...deps, machine: () => ({ checkouts: [], error: null }) }), 0);
  assert.deepEqual(Object.keys(JSON.parse(out.log.join(''))), ['person', 'count', 'asks']);
});
